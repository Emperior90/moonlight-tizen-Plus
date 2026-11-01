'use strict';

// Checks in the real page that the box art of an app list doesn't hold up the navigation in it (showApps() in
// wasm/platform/index.js, NvHTTP.getBoxArt() and the Smart Hub previews in wasm/static/js/utils.js, the hero in
// wasm/platform/launcher.js): the grid shows before any box art is read and the box art then loads one app per task,
// so that a key pressed right away is handled after one of them instead of after all; the box art shows through object
// URLs, which are freed with their grid, and as a data URL where an image refuses the object URL; the Smart Hub previews
// are made only when the TV is idle, one at a time; and the ambient light of the hero reads the colours of the box art
// from its Blob with createImageBitmap(), away from the main thread. Counters and stubs decide, not the time things
// take. tests/unit/box-art-main-thread.test.js checks the parts of utils.js on their own.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

const TV = { tv: 's90c', conn: 'wifi' };

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Open the app list of a real NvHTTP host with `count` apps whose box art is downloaded (nothing is cached), with the
// HTTP requests of the module recorded in window.__http and a file system that keeps what the app writes. Each box art
// is a PNG that is red above and blue below. `before` runs in the page before showApps().
async function openAppList(count, beforeShow) {
  const app = await openApp(harness, { tv: TV });
  await app.page.evaluate(async ({ apps, setup }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 60;
    canvas.height = 80;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 60, 40);
    context.fillStyle = '#0000ff';
    context.fillRect(0, 40, 60, 40);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    window.__png = new Uint8Array(await new Response(png).arrayBuffer());
    window.__http = [];
    window.__writes = [];
    tizen.filesystem = {
      createDirectory() {},
      openFile(path, mode) {
        if (mode === 'r') {
          throw new Error('NotFoundError: ' + path);
        }
        return { writeData: (data) => window.__writes.push({ path: path, head: Array.from(data.slice(0, 2)) }), close() {} };
      },
      deleteFile() {},
      toURI: (path) => 'file:///opt/usr/home/owner/content/' + path,
    };
    Module.openUrl = (id, url) => {
      const boxArt = /\/appasset\?.*appid=(\d+)/.exec(url);
      window.__http.push({ id: id, what: boxArt ? 'boxart ' + boxArt[1] : url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') });
      // Answer every box art download at once with the PNG
      if (boxArt) {
        setTimeout(() => handlePromiseMessage(id, 'resolve', window.__png.slice()), 0);
      }
    };
    const host = new NvHTTP('10.0.0.2', myUniqueid || '0123456789abcdef');
    Object.assign(host, {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', ppkstr: 'PPK', httpPort: 47989, httpsPort: 47984,
      _baseUrlHttps: 'https://10.0.0.2:47984', appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03, currentGame: 0,
    });
    host._memCachedApplist = Array.from({ length: apps }, (unused, index) => ({ id: index + 1, title: 'App ' + String(index + 1).padStart(2, '0') }));
    host.refreshServerInfo = () => Promise.resolve(true);
    window.__host = host;
    api = host;
    if (setup) {
      (0, eval)(setup)();
    }
    await showApps(host);
    Navigation.switch();
    Navigation.change(Views.Apps);
  }, { apps: count, setup: beforeShow ? '(' + beforeShow.toString() + ')' : '' });
  return app;
}

// Wait until every tile shows its box art
const boxArtShown = (page, pattern) => page.waitForFunction((source) => {
  const images = Array.from(document.querySelectorAll('#game-grid .game-container img'));
  return images.length > 0 && images.every((image) => new RegExp(source).test(image.getAttribute('src') || '') && image.classList.contains('fade-in'));
}, pattern.source, { timeout: 10000 });

test('the grid shows before any box art is read, and a key pressed right away waits for one box art, not for all', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    const result = await app.page.evaluate(async () => {
      const reads = [];
      const host = {
        paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
        appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
        refreshServerInfo: () => Promise.resolve(),
        getAppList: () => Promise.resolve(Array.from({ length: 30 }, (unused, index) => ({ id: index + 1, title: 'App ' + String(index + 1).padStart(2, '0') }))),
        // Each box art is read when the app grid asks for it
        getBoxArt: (id) => {
          reads.push(id);
          return Promise.resolve('static/res/placeholder_game.svg');
        },
        pollServer: (callback) => callback(host),
        toString: () => 'GAMING-PC',
      };
      api = host;
      await showApps(host);
      const atGrid = reads.length;
      Navigation.switch();
      Navigation.change(Views.Apps);
      // The user presses RIGHT as soon as the grid shows
      const atKey = await new Promise((resolve) => setTimeout(() => {
        remoteControllerHandler({ keyCode: tvKey.KEY_RIGHT, repeat: false, preventDefault() {} });
        resolve({ reads: reads.length, marked: document.querySelector('#game-grid > .hovered').getAttribute('aria-label') });
      }, 0));
      await new Promise((resolve) => {
        const wait = () => (reads.length === 30 ? resolve() : setTimeout(wait, 10));
        wait();
      });
      return { atGrid: atGrid, atKey: atKey, reads: reads };
    });
    assert.equal(result.atGrid, 0, 'no box art is read in the task that builds the grid');
    assert.deepEqual(result.atKey, { reads: 1, marked: 'App 02' });
    // Every box art is read, one after the other in the order of the grid
    assert.deepEqual(result.reads, Array.from({ length: 30 }, (unused, index) => index + 1));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('box art shows through object URLs, which are freed when the grid is built again', async () => {
  const app = await openAppList(6, () => {
    window.__revoked = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => {
      window.__revoked.push(url);
      revoke.call(URL, url);
    };
  });
  const { page } = app;
  try {
    await boxArtShown(page, /^blob:/);
    const first = await page.evaluate(() => Array.from(document.querySelectorAll('#game-grid .game-container img')).map((image) => image.getAttribute('src')));
    assert.equal(new Set(first).size, 6);
    // The hero shows the box art of the focused tile through its object URL as well
    assert.equal(await page.evaluate(() => document.getElementById('hero-poster').getAttribute('src')), first[0]);
    assert.deepEqual(await page.evaluate(() => window.__revoked), []);
    // The grid is built again (e.g. after an app was hidden): the object URLs of the first grid are freed
    await page.evaluate(() => showApps(window.__host));
    await boxArtShown(page, /^blob:/);
    assert.deepEqual((await page.evaluate(() => window.__revoked)).sort(), first.slice().sort());
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('an image that refuses the object URL of its box art gets a data URL of it instead', async () => {
  // Object URLs that the images can't load, as a TV might
  const app = await openAppList(4, () => {
    const create = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      const url = create.call(URL, blob);
      URL.revokeObjectURL(url);
      return url;
    };
  });
  try {
    await boxArtShown(app.page, /^data:image\/png;base64,/);
    assert.equal(app.logs.filter((line) => /could not show the object URL of its box art, trying a data URL/.test(line)).length, 1);
    assert.deepEqual(await app.page.evaluate(() => document.querySelectorAll('#game-grid .no-art').length), 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Smart Hub previews are made only when the TV is idle, one at a time, after the box art showed', async () => {
  const app = await openAppList(5, () => {
    _isSmartHubSupported = true;
    // The idle callbacks run when the test says
    window.__idle = [];
    window.requestIdleCallback = (callback) => window.__idle.push(callback);
    window.__made = 0;
    // The Smart Hub tiles that the app hands to the service, with the previews written by then
    window.__tiles = [];
    window.updatePreviewData = () => window.__tiles.push({
      previews: window.__writes.filter((write) => /^documents\//.test(write.path)).length,
      apps: _previewApps.HOST1.apps.map((entry) => ({ id: entry.id, imageUri: entry.imageUri || '', txtPath: entry.txtPath || '' })),
    });
    const generate = NvHTTP.prototype.generatePreviewImage;
    NvHTTP.prototype.generatePreviewImage = function() {
      window.__made++;
      return generate.apply(this, arguments);
    };
  });
  const { page } = app;
  try {
    await boxArtShown(page, /^blob:/);
    // Every box art shows, and no preview was made yet: one waits for the TV to be idle, and so do the Smart Hub tiles
    assert.deepEqual(await page.evaluate(() => ({ made: window.__made, idle: window.__idle.length, tiles: window.__tiles.length })),
      { made: 0, idle: 1, tiles: 0 });
    // Each idle time makes one preview (a JPEG), and the next one waits for the next idle time
    for (let made = 1; made <= 5; made++) {
      await page.evaluate(() => window.__idle.shift()());
      await page.waitForFunction((count) => window.__writes.filter((write) => /^documents\//.test(write.path)).length === count, made, { timeout: 5000 });
      assert.equal(await page.evaluate(() => window.__made), made);
      if (made < 5) {
        await page.waitForFunction(() => window.__idle.length === 1, null, { timeout: 5000 });
      }
    }
    const previews = await page.evaluate(() => window.__writes.filter((write) => /^documents\//.test(write.path)));
    assert.deepEqual(previews.map((write) => write.path), [1, 2, 3, 4, 5].map((id) => 'documents/preview-s90c-' + id + '.jpg'));
    previews.forEach((write) => assert.deepEqual(write.head, [0xFF, 0xD8]));
    assert.equal(await page.evaluate(() => window.__idle.length), 0);
    // The tiles go to the Smart Hub service once, after the last preview was written, each with the address of its preview
    await page.waitForFunction(() => window.__tiles.length > 0, null, { timeout: 5000 });
    const tiles = await page.evaluate(() => window.__tiles);
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0].previews, 5);
    tiles[0].apps.forEach((entry) => {
      assert.match(entry.imageUri, new RegExp('^http://[^/]+:\\d+/preview-s90c-' + entry.id + '\\.jpg\\?v=\\d+$'));
      assert.equal(entry.txtPath, '/opt/usr/home/owner/content/documents/preview-s90c-' + entry.id + '.jpg');
    });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the ambient light reads the colours of the box art from its Blob with createImageBitmap(), off the main thread', async () => {
  const app = await openAppList(3, () => {
    window.__bitmaps = [];
    const create = window.createImageBitmap;
    window.createImageBitmap = function(source) {
      window.__bitmaps.push(source instanceof Blob ? 'Blob' : source.tagName || typeof source);
      return create.apply(window, arguments);
    };
  });
  const { page } = app;
  try {
    await boxArtShown(page, /^blob:/);
    await page.evaluate(() => {
      // Only the reads from here on count: the light of the first tile reads its box art once the focus rested on it for
      // 300 ms, which a slow test machine may reach before this step
      window.__bitmaps = [];
      unmark(Views.Apps.view.current());
      Views.Apps.view.index = 1;
      mark(Views.Apps.view.current());
    });
    await page.waitForFunction(() => document.getElementById('hero-ambient').classList.contains('is-painted'), null, { timeout: 5000 });
    const light = await page.evaluate(() => {
      const element = document.getElementById('hero-ambient');
      const colour = (name) => element.style.getPropertyValue(name).split(',').map((value) => parseInt(value, 10));
      return { bitmaps: window.__bitmaps, top: colour('--a1'), bottom: colour('--a3') };
    });
    assert.deepEqual(light.bitmaps, ['Blob']);
    assert.ok(light.top[0] > 200 && light.top[2] < 60, JSON.stringify(light.top));
    assert.ok(light.bottom[2] > 200 && light.bottom[0] < 60, JSON.stringify(light.bottom));
    // The start screen of the app shows the same colours, read once
    await page.evaluate(() => Launcher.prepareStart(window.__host, 2, 'App 02'));
    const start = await page.evaluate(() => document.getElementById('launch-backdrop').style.getPropertyValue('--a1'));
    assert.equal(start, light.top.join(', '));
    assert.deepEqual(await page.evaluate(() => window.__bitmaps), ['Blob']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
