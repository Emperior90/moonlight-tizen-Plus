'use strict';

// Pins what keeps the box art of the app list off the main thread of the TV while the user navigates it
// (wasm/static/js/utils.js and wasm/platform/menus.js): the box art goes to the images as an object URL of its Blob
// instead of a data URL (and as a data URL once for an image that refuses the object URL), the object URLs are freed
// with their grid, only a cached file of the size of Sunshine's default box art is hashed, the Smart Hub previews are
// made one at a time when the TV is idle (none during a stream, none for an app list that was left, none after a
// preview could not be saved), and the app list is sorted with one collator. tests/browser/app-list-load.test.js runs
// the app grid with them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('crypto');
const { createPlatformContext, loadPlatformScripts, plain } = require('./helpers/platform-loader');

// The SHA-256 of Sunshine's default box.png (utils.js), which the cached box art of an app without art has
const DEFAULT_BOX_ART_HASH = 'd9164ebd069b5f735eb8efc557801778498da37f572ef70e3d35604739e6c613';

// A FileReader of Node Blobs, as far as utils.js needs it
class TestFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(buffer).toString('base64');
      this.onloadend();
    });
  }

  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend();
    });
  }
}

// Settle the pending promise callbacks and the FileReader of Node
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// Load messages.js and utils.js with a file system of cached box art (path -> Blob), object URLs that the test can
// follow, a hash function that answers `hashes` per file size, requestIdleCallback() and setTimeout() that the test
// runs by hand, and a module whose requests the test records
function loadUtils(options) {
  const opts = options || {};
  const files = new Map(Object.entries(opts.files || {}));
  const urls = new Map();
  const calls = { digest: [], revoked: [], deleted: [], requests: [], writes: [] };
  const idle = [];
  const timers = [];
  let urlCount = 0;
  const platform = createPlatformContext({
    globals: {
      Blob,
      FileReader: TestFileReader,
      URL: {
        createObjectURL(blob) {
          const url = 'blob:test/' + (++urlCount);
          urls.set(url, blob);
          return url;
        },
        revokeObjectURL(url) {
          calls.revoked.push(url);
          urls.delete(url);
        },
      },
      atob: (text) => Buffer.from(text, 'base64').toString('binary'),
      crypto: {
        getRandomValues: (array) => webcrypto.getRandomValues(array),
        subtle: {
          digest(algorithm, bytes) {
            calls.digest.push(bytes.length);
            const hex = (opts.hashes || {})[bytes.length] || '00'.repeat(32);
            return Promise.resolve(new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16))).buffer);
          },
        },
      },
      tizen: {
        filesystem: {
          createDirectory() {},
          openFile(path, mode) {
            if (mode === 'r') {
              if (!files.has(path)) {
                throw new Error('NotFoundError: ' + path);
              }
              return { readBlob: () => files.get(path), close() {} };
            }
            if (opts.failWrites) {
              throw new Error('SecurityError: ' + path);
            }
            return { writeData: (data) => calls.writes.push({ path, size: data.length }), close() {} };
          },
          deleteFile(path) {
            calls.deleted.push(path);
            files.delete(path);
          },
        },
      },
      requestIdleCallback: (callback, options) => idle.push({ callback, timeout: options && options.timeout }),
      setTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout() {},
      isInGame: false,
      Module: {
        openUrl(id, url) {
          calls.requests.push(url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*appid=(\d+).*$/, ' $1'));
        },
      },
    },
  });
  platform.load('wasm/platform/messages.js');
  platform.load('wasm/static/js/utils.js');
  const host = platform.run('new NvHTTP("10.0.0.2", "0123456789abcdef", "", "")');
  Object.assign(host, { paired: true, hostname: 'GAMING-PC', ppkstr: 'PPK', _baseUrlHttps: 'https://10.0.0.2:47984' });
  // Run the callbacks that wait for the TV to be idle, as the browser would once it is
  const runIdle = () => idle.splice(0).forEach((entry) => entry.callback());
  return { platform, host, files, urls, calls, idle, timers, runIdle };
}

const boxArtPath = (id) => 'wgt-private/GAMING-PC/boxart-' + id + '.png';

test('cached box art shows through an object URL, and only a file of the size of the default box art is hashed', async () => {
  const utils = loadUtils({
    files: {
      [boxArtPath(1)]: new Blob([new Uint8Array(200 * 1024)]),
      [boxArtPath(2)]: new Blob([new Uint8Array(680)]),
      [boxArtPath(3)]: new Blob([new Uint8Array(680).fill(1)]),
    },
  });
  const art = await utils.host.getBoxArt(1, false);
  assert.match(art, /^blob:test\/\d+$/);
  assert.equal(utils.urls.get(art).type, 'image/png');
  assert.equal(utils.urls.get(art).size, 200 * 1024);
  // A box art of 200 KB is never hashed: Sunshine's default box.png has 680 bytes
  assert.deepEqual(utils.calls.digest, []);
  assert.match(await utils.host.getBoxArt(2, false), /^blob:test\/\d+$/);
  assert.deepEqual(utils.calls.digest, [680]);
  assert.deepEqual(utils.calls.deleted, []);
  assert.deepEqual(utils.calls.requests, []);

  // A cached default box art is deleted and downloaded again, as before
  const again = loadUtils({ files: { [boxArtPath(3)]: new Blob([new Uint8Array(680)]) }, hashes: { 680: DEFAULT_BOX_ART_HASH } });
  again.host.getBoxArt(3, false);
  await settle();
  assert.deepEqual(again.calls.deleted, [boxArtPath(3), 'documents/preview-s90c-3.jpg']);
  assert.deepEqual(again.calls.requests, ['/appasset 3']);
});

test('the object URL of box art is freed with its grid, and gives its Blob or a data URL until then', async () => {
  const utils = loadUtils({ files: { [boxArtPath(1)]: new Blob([new Uint8Array([137, 80, 78, 71])]) } });
  const get = (name) => utils.platform.get(name);
  const art = await utils.host.getBoxArt(1, false);
  assert.equal(get('boxArtBlob')(art), utils.urls.get(art));
  assert.equal(await get('boxArtDataUrl')(art), 'data:image/png;base64,iVBORw==');
  // Other URLs are left alone
  get('releaseBoxArtUrl')('static/res/placeholder_game.svg');
  assert.equal(get('boxArtBlob')('static/res/placeholder_game.svg'), null);
  assert.equal(await get('boxArtDataUrl')('static/res/placeholder_game.svg'), null);
  assert.deepEqual(utils.calls.revoked, []);
  get('releaseBoxArtUrl')(art);
  assert.deepEqual(utils.calls.revoked, [art]);
  assert.equal(get('boxArtBlob')(art), null);
  assert.equal(await get('boxArtDataUrl')(art), null);

  // A browser without object URLs gets a data URL
  const old = loadUtils({ files: { [boxArtPath(1)]: new Blob([new Uint8Array([137, 80, 78, 71])]) } });
  old.platform.context.URL = undefined;
  assert.equal(await old.host.getBoxArt(1, false), 'data:image/png;base64,iVBORw==');
});

test('the Smart Hub previews are made one at a time, each once the TV is idle', async () => {
  const utils = loadUtils({
    files: { [boxArtPath(1)]: new Blob([new Uint8Array(1000)]), [boxArtPath(2)]: new Blob([new Uint8Array(1000)]) },
  });
  const made = [];
  let finishFirst;
  utils.host.generatePreviewImage = (blob, appId) => {
    made.push(appId);
    return appId === 1 ? new Promise((resolve) => {
      finishFirst = resolve;
    }) : Promise.resolve(new Uint8Array([255, 216, 255]));
  };
  utils.platform.context.previewPromises = [];
  // The box art is returned at once, and no preview is made in the task that asked for it
  assert.match(await utils.host.getBoxArt(1, true), /^blob:/);
  assert.match(await utils.host.getBoxArt(2, true), /^blob:/);
  assert.deepEqual(made, []);
  assert.equal(utils.platform.get('previewPromises.length'), 2);
  assert.equal(utils.idle.length, 1);
  assert.equal(utils.idle[0].timeout, 2000);
  // The first idle time makes the first preview; the second waits until the first is done
  utils.runIdle();
  assert.deepEqual(made, [1]);
  await settle();
  assert.equal(utils.idle.length, 0);
  finishFirst(new Uint8Array([255, 216, 255, 224]));
  await settle();
  assert.deepEqual(plain(utils.calls.writes), [{ path: 'documents/preview-s90c-1.jpg', size: 4 }]);
  assert.equal(utils.idle.length, 1);
  utils.runIdle();
  await settle();
  assert.deepEqual(made, [1, 2]);
  assert.deepEqual(plain(utils.calls.writes.map((write) => write.path)), ['documents/preview-s90c-1.jpg', 'documents/preview-s90c-2.jpg']);
  assert.deepEqual(plain(await Promise.all(utils.platform.get('previewPromises'))), [true, true]);
});

test('no preview is made during a stream, for an app list that was left, or after a preview could not be saved', async () => {
  const utils = loadUtils();
  const queue = utils.platform.get('queuePreviewImage');
  const made = [];
  const job = (name) => () => {
    made.push(name);
    return true;
  };
  // During a stream the preview waits, and looks again a few seconds later
  utils.platform.context.isInGame = true;
  const waiting = queue(job('stream'));
  utils.runIdle();
  assert.deepEqual(made, []);
  assert.deepEqual(utils.timers.map((timer) => timer.delay), [3000]);
  utils.platform.context.isInGame = false;
  utils.timers.shift().callback();
  utils.runIdle();
  assert.equal(await waiting, true);
  assert.deepEqual(made, ['stream']);
  // A preview of an app list that was left is skipped
  const left = queue(job('left'), () => true);
  await settle();
  utils.runIdle();
  assert.equal(await left, false);
  assert.deepEqual(made, ['stream']);

  // A TV that refuses the documents directory: after the first failed save, no preview is made until the app restarts
  const refusing = loadUtils({ failWrites: true });
  const failing = refusing.platform.get('queuePreviewImage');
  const first = failing(() => refusing.host.savePreviewImage(1, new Uint8Array([1, 2, 3])));
  const second = failing(() => {
    made.push('after a failed save');
    return true;
  });
  refusing.runIdle();
  assert.equal(await first, false);
  await settle();
  refusing.runIdle();
  assert.equal(await second, false);
  assert.ok(!made.includes('after a failed save'));
  assert.ok(refusing.platform.consoleMessages.some((entry) => /No more Smart Hub Preview box art is made until the app starts again/.test(entry.text)));
});

test('a preview is saved from its bytes, or from a data URL of it', () => {
  const utils = loadUtils();
  assert.equal(utils.host.savePreviewImage(7, new Uint8Array(2048)), true);
  assert.equal(utils.host.savePreviewImage(8, 'data:image/jpeg;base64,/9j/4AA='), true);
  assert.deepEqual(plain(utils.calls.writes), [{ path: 'documents/preview-s90c-7.jpg', size: 2048 }, { path: 'documents/preview-s90c-8.jpg', size: 5 }]);
});

test('the app list is sorted with one collator, not with a new one for each comparison', () => {
  let collators = 0;
  const menus = loadPlatformScripts(['wasm/platform/menus.js']);
  const RealCollator = menus.get('Intl.Collator');
  menus.context.Intl = { Collator: function(locales, options) {
    collators++;
    return new RealCollator(locales, options);
  } };
  menus.run('String.prototype.localeCompare = function() { throw new Error("localeCompare() builds a collator per call"); };');
  const apps = Array.from({ length: 60 }, (unused, index) => ({ id: index, title: (index % 3 ? 'game ' : 'Game ') + (60 - index) }));
  const order = (sortOrder) => plain(menus.get('orderAppList')(apps, sortOrder, [], [])).map((app) => app.title);
  assert.deepEqual(order('az').slice(0, 4), ['game 1', 'game 2', 'Game 3', 'game 4']);
  assert.deepEqual(order('za').slice(0, 3), ['Game 60', 'game 59', 'game 58']);
  assert.equal(collators, 1);
});
