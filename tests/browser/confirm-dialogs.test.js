'use strict';

// Checks the dialogs that confirm an action that can't be undone (pushConfirmationView() in wasm/platform/index.js):
// quitting the running app (also before the start of another app), deleting a host or all hosts and Restore Defaults
// open with the focus on No, so that an OK pressed by mistake only closes them. LEFT still reaches Yes.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// The focused element and the button that the view of the dialog selects, once the dialog has focused it
const selection = (page) => page.waitForTimeout(250).then(() => page.evaluate(() => ({
  focused: document.activeElement ? document.activeElement.id : '',
  marked: Array.prototype.filter.call(document.querySelectorAll('dialog[open] .mdl-dialog__actions button'),
    (button) => button.classList.contains('hovered')).map((button) => button.id),
})));

const openDialogs = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('dialog[open]'), (dialog) => dialog.id));

test('Restore Defaults opens on No, and OK there keeps every setting', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { framePacing: false } });
  try {
    await app.page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
    assert.deepEqual(await selection(app.page), { focused: 'cancelRestoreDefaults', marked: ['cancelRestoreDefaults'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await openDialogs(app.page), []);
    assert.equal((await readStorage(app.page)).framePacing, false);
    assert.ok(!app.logs.some((line) => line.indexOf('Settings have been restored to their default values.') >= 0));

    // A second time it opens on No again, also after LEFT selected Yes the time before
    await app.page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
    await selection(app.page);
    await app.page.keyboard.press('ArrowLeft');
    assert.deepEqual(await selection(app.page), { focused: 'continueRestoreDefaults', marked: ['continueRestoreDefaults'] });
    await app.page.evaluate(() => $('#cancelRestoreDefaults').trigger('click'));
    await app.page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
    assert.deepEqual(await selection(app.page), { focused: 'cancelRestoreDefaults', marked: ['cancelRestoreDefaults'] });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('deleting a host or all hosts opens on No, and OK there keeps them', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      window.beginBackgroundPollingOfHost = function() {};
      window.endBackgroundPollingOfHost = function() {};
      addHostToGrid({
        serverUid: 'A', hostname: 'GAMING-PC', online: true, paired: true, currentGame: 0, address: '10.0.0.2', externalPort: 47989,
        httpPort: 47989, httpsPort: 47984, macAddress: '00:11:22:33:44:55', toString: () => 'GAMING-PC', updateExternalAddressIP4() {},
        clearBoxArt() {}, refreshServerInfo: () => Promise.resolve(), pollServer(callback) {
          callback(this);
        },
      });
      deleteHostDialog(hosts.A);
    });
    assert.deepEqual(await selection(app.page), { focused: 'cancelDeleteHost', marked: ['cancelDeleteHost'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await openDialogs(app.page), []);
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), ['A']);

    await app.page.evaluate(() => deleteAllHostsDialog());
    assert.deepEqual(await selection(app.page), { focused: 'cancelDeleteHost', marked: ['cancelDeleteHost'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), ['A']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('quitting the running app opens on No, also when another app is started, and OK there quits nothing', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      window.__quits = 0;
      const host = new NvHTTP('10.0.0.2', '0123456789abcdef', '', '');
      Object.assign(host, { paired: true, hostname: 'GAMING-PC', ppkstr: 'PINNED-CERT', serverUid: 'HOST1', currentGame: 7 });
      host.refreshServerInfo = () => Promise.resolve(true);
      host.getAppById = (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null);
      host.quitApp = () => {
        window.__quits++;
        return Promise.resolve();
      };
      api = host;
      window.__host = host;
      quitAppDialog();
    });
    assert.deepEqual(await selection(app.page), { focused: 'cancelQuitApp', marked: ['cancelQuitApp'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await openDialogs(app.page), []);

    // The start of app 8 while app 7 runs asks to quit app 7 first
    await app.page.evaluate(() => {
      showApps = () => Promise.resolve();
      startGame(window.__host, 8);
    });
    assert.deepEqual(await selection(app.page), { focused: 'cancelQuitApp', marked: ['cancelQuitApp'] });
    assert.match(await app.page.evaluate(() => $('#quitAppDialogText').text()), /Game 7 is already running/);
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.evaluate(() => window.__quits), 0);
    assert.equal(await app.page.evaluate(() => window.__host.currentGame), 7);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
