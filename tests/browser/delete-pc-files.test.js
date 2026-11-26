'use strict';

// Checks that Delete PC and Delete All PCs (deleteHostDialog() and deleteAllHostsDialog() in wasm/platform/index.js) also
// delete the files that the TV keeps of the deleted PCs (deleteFilesOfDeletedHosts() in wasm/static/js/utils.js): the
// directory of its box art in the private storage of the app, wgt-private/<the name of getBoxArtDirName()>, and the
// Smart Hub previews in the shared documents directory, preview-s90c-<app ID>.jpg, which the preview service of the app
// serves to every device on the local network on Tizen 5.5 and 6.0 (res/service/service.js). Up to 2.3.4 they stayed
// after the PC was deleted. A preview is named by the app ID only, and two PCs can list the same app ID (e.g. the
// Desktop app of Sunshine), so a preview stays while another PC lists its ID; two PCs of the same name share the
// directory of their box art, which stays while one of them remains. The previews of the regular Moonlight app in the
// same directory (preview-<id>.jpg) and other files are never touched. The file system of the TV is a stand-in in the
// page that records the calls and lists a few files.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, openApp, readStorage, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Two stored PCs: GAMING-PC (HOST1) and OFFICE-PC (HOST2), which both list the app 102
const TWO_HOSTS = Object.assign({}, SUNSHINE_HOSTS, {
  HOST2: Object.assign({}, SUNSHINE_HOSTS.HOST1, {
    serverUid: 'HOST2', hostname: 'OFFICE-PC', address: '10.0.0.3', userEnteredAddress: '10.0.0.3',
    _baseUrlHttps: 'https://10.0.0.3:47984', _baseUrlHttp: 'http://10.0.0.3:47989',
  }),
});
// The stored app lists of the Smart Hub previews of both PCs
const PREVIEWS = {
  HOST1: { hostname: 'GAMING-PC', address: '10.0.0.2', apps: [{ id: 101, title: 'Game' }, { id: 102, title: 'Desktop' }] },
  HOST2: { hostname: 'OFFICE-PC', address: '10.0.0.3', apps: [{ id: 102, title: 'Desktop' }, { id: 103, title: 'Steam Big Picture' }] },
};

// Replace the file system of the TV by a stand-in that records the calls in window.__files and lists the previews of
// both PCs, one of the regular Moonlight app and another file in the documents directory
const installFileSystem = (page) => page.evaluate(() => {
  window.__files = [];
  tizen.filesystem = {
    deleteDirectory(path, recursive, onSuccess) {
      window.__files.push('deleteDirectory ' + path + ' ' + recursive);
      if (onSuccess) {
        onSuccess();
      }
    },
    deleteFile(path) {
      window.__files.push('deleteFile ' + path);
    },
    listDirectory(path, onSuccess) {
      window.__files.push('listDirectory ' + path);
      onSuccess(['preview-s90c-101.jpg', 'preview-s90c-102.jpg', 'preview-s90c-103.jpg', 'preview-555.jpg', 'notes.txt']);
    },
  };
});

const fileCalls = (page) => page.evaluate(() => window.__files.slice());

async function openWithTwoHosts(hostsToStore) {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { hosts: hostsToStore || TWO_HOSTS, previewApps: PREVIEWS } });
  await app.page.waitForFunction(() => isHostsLoaded === true && Object.keys(hosts).length === 2, null, { timeout: 5000 });
  await installFileSystem(app.page);
  return app;
}

test('Delete PC deletes the box art of the PC and the previews that no other PC lists', async () => {
  const app = await openWithTwoHosts();
  try {
    await app.page.evaluate(() => {
      deleteHostDialog(hosts.HOST1);
      $('#continueDeleteHost').trigger('click');
    });
    await app.page.waitForTimeout(100);
    assert.deepEqual(await fileCalls(app.page), [
      'deleteDirectory wgt-private/GAMING-PC true',
      'listDirectory documents',
      // 102 stays, since OFFICE-PC lists it as well
      'deleteFile documents/preview-s90c-101.jpg',
    ]);
    assert.ok(app.logs.some((line) => line.indexOf('Deleted the box art of wgt-private/GAMING-PC.') >= 0));
    assert.ok(app.logs.some((line) => line.indexOf('Deleting 1 Smart Hub previews that no remaining PC lists.') >= 0));
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), ['HOST2']);
    assert.deepEqual(Object.keys((await readStorage(app.page)).hosts), ['HOST2']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.page.evaluate(() => stopPollingHosts());
    await app.context.close();
  }
});

test('Delete All PCs deletes the box art of every PC and every preview of the app, and nothing else', async () => {
  const app = await openWithTwoHosts();
  try {
    await app.page.evaluate(() => {
      deleteAllHostsDialog();
      $('#continueDeleteHost').trigger('click');
    });
    await app.page.waitForTimeout(100);
    assert.deepEqual(await fileCalls(app.page), [
      'deleteDirectory wgt-private/GAMING-PC true',
      'deleteDirectory wgt-private/OFFICE-PC true',
      'listDirectory documents',
      'deleteFile documents/preview-s90c-101.jpg',
      'deleteFile documents/preview-s90c-102.jpg',
      'deleteFile documents/preview-s90c-103.jpg',
    ]);
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Delete PC keeps the box art directory that another PC of the same name uses', async () => {
  const sameName = JSON.parse(JSON.stringify(TWO_HOSTS));
  sameName.HOST2.hostname = 'GAMING-PC';
  const app = await openWithTwoHosts(sameName);
  try {
    await app.page.evaluate(() => {
      deleteHostDialog(hosts.HOST1);
      $('#continueDeleteHost').trigger('click');
    });
    await app.page.waitForTimeout(100);
    assert.deepEqual(await fileCalls(app.page), ['listDirectory documents', 'deleteFile documents/preview-s90c-101.jpg']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.page.evaluate(() => stopPollingHosts());
    await app.context.close();
  }
});

test('a file system that fails is only logged, and the PC is deleted all the same', async () => {
  const app = await openWithTwoHosts();
  try {
    await app.page.evaluate(() => {
      tizen.filesystem.deleteDirectory = (path, recursive, onSuccess, onError) => onError(new Error('NotFoundError'));
      tizen.filesystem.listDirectory = () => {
        throw new Error('SecurityError');
      };
      deleteHostDialog(hosts.HOST1);
      $('#continueDeleteHost').trigger('click');
    });
    await app.page.waitForTimeout(100);
    assert.ok(app.logs.some((line) => line.indexOf('Warning: Failed to delete wgt-private/GAMING-PC: NotFoundError') >= 0));
    assert.ok(app.logs.some((line) => line.indexOf('Warning: Failed to delete the Smart Hub previews: SecurityError') >= 0));
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), ['HOST2']);
    assert.equal(await app.page.evaluate(() => document.getElementById('deleteHostDialog').open), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.page.evaluate(() => stopPollingHosts());
    await app.context.close();
  }
});
