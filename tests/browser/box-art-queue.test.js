'use strict';

// Checks in the real page that box art downloads never hold up starting, resuming or quitting an app (sendMessage() in
// wasm/platform/messages.js, NvHTTP.getBoxArt() in wasm/static/js/utils.js, showApps() and showStreamMode() in
// index.js): the app grid of a host with a cold box art cache has at most two downloads on their way, a request to quit
// the running app goes before the box art that waits, and a stream that starts drops every box art download, also the
// one that runs, so that its launch request is next. The host is a real NvHTTP object whose HTTP requests the stub of
// the module records and the test answers. tests/unit/box-art-queue.test.js checks the queue on its own.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Open the app grid of a host with six apps (App 1 to App 6) whose box art is not cached (the simulated TV has no file
// system), with the HTTP requests of the module recorded in window.__http as 'boxart <id>' or their path
async function openColdAppList(currentGame) {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  await app.page.evaluate(async (runningApp) => {
    window.__http = [];
    Module.openUrl = (id, url) => {
      const boxArt = /\/appasset\?.*appid=(\d+)/.exec(url);
      window.__http.push({ id: id, what: boxArt ? 'boxart ' + boxArt[1] : url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') });
    };
    // Answer the oldest request that waits for an answer
    window.__answer = (what, value) => {
      const request = window.__http.find((entry) => entry.what === what && !entry.answered);
      request.answered = true;
      handlePromiseMessage(request.id, 'resolve', value);
    };
    const host = new NvHTTP('10.0.0.2', myUniqueid || '0123456789abcdef');
    Object.assign(host, {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', ppkstr: 'PPK', httpPort: 47989, httpsPort: 47984,
      _baseUrlHttps: 'https://10.0.0.2:47984', appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      currentGame: runningApp,
    });
    host._memCachedApplist = [1, 2, 3, 4, 5, 6].map((id) => ({ id: id, title: 'App ' + id }));
    host.refreshServerInfo = () => Promise.resolve(true);
    window.__host = host;
    api = host;
    await showApps(host);
  }, currentGame || 0);
  return app;
}

// The HTTP requests that reached the module, and the box art downloads on their way (in the module or in the queue)
const httpState = (page) => page.evaluate(() => ({
  sent: window.__http.map((entry) => entry.what),
  boxArtOnTheirWay: _httpQueue.filter((entry) => entry.boxArt).length + (_httpCurrent && _httpCurrent.boxArt ? 1 : 0),
}));
const cancelRequests = (page) => page.evaluate(() => window.__wasmCalls.filter((call) => call.name === 'cancelRequest').length);

test('a stream that starts drops every box art download, also the one that runs, and its launch request is next', async () => {
  const app = await openColdAppList();
  const { page } = app;
  try {
    await page.waitForFunction(() => window.__http.length === 1);
    assert.deepEqual(await httpState(page), { sent: ['boxart 1'], boxArtOnTheirWay: 2 });
    const cancelsBefore = await cancelRequests(page);
    // OK on App 3: the launch request goes out right after the canceled box art download
    await page.evaluate(() => startGame(window.__host, 3));
    await page.waitForFunction(() => window.__http.length === 2, null, { timeout: 3000 });
    assert.deepEqual(await httpState(page), { sent: ['boxart 1', '/launch'], boxArtOnTheirWay: 0 });
    assert.equal(await cancelRequests(page), cancelsBefore + 1);
    // No box art download follows the launch, also after it was answered
    await page.evaluate(() => window.__answer('/launch', '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>'));
    await page.waitForFunction(() => window.__startStreamArgs !== null, null, { timeout: 3000 });
    await page.waitForTimeout(300);
    assert.deepEqual((await httpState(page)).sent, ['boxart 1', '/launch']);
    assert.ok(app.logs.some((line) => line.indexOf('Dropped the box art download of app ID 6.') >= 0));
    assert.ok(!app.logs.some((line) => /Failed to retrieve (original )?box art/.test(line)), 'a dropped download is no error');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('quitting the running app goes before the box art that waits, and the box art loads afterwards, two at a time', async () => {
  const app = await openColdAppList(3);
  const { page } = app;
  try {
    await page.waitForFunction(() => window.__http.length === 1);
    const quit = page.evaluate(() => window.__host.quitApp().then(() => 'quit', (error) => 'failed ' + error));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__answer('boxart 1', new Uint8Array([137, 80, 78, 71])));
    await page.waitForFunction(() => window.__http.length === 2);
    assert.deepEqual((await httpState(page)).sent, ['boxart 1', '/cancel']);
    await page.evaluate(() => {
      window.__host.currentGame = 0;
      window.__answer('/cancel', '<root status_code="200"/>');
    });
    assert.equal(await quit, 'quit');
    // The other box art downloads follow in the order of the grid, never more than two on their way
    for (let id = 2; id <= 6; id++) {
      await page.waitForFunction((what) => window.__http.some((entry) => entry.what === what), 'boxart ' + id, { timeout: 3000 });
      assert.ok((await httpState(page)).boxArtOnTheirWay <= 2);
      await page.evaluate((what) => window.__answer(what, new Uint8Array([137, 80, 78, 71])), 'boxart ' + id);
    }
    assert.deepEqual((await httpState(page)).sent, ['boxart 1', '/cancel', 'boxart 2', 'boxart 3', 'boxart 4', 'boxart 5', 'boxart 6']);
    await page.waitForFunction(() => $('#game-grid .game-container img').toArray().every((img) => /^data:image\/png/.test(img.getAttribute('src') || '')));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the box art that waits for an app grid that was built again is dropped before it reaches the network', async () => {
  const app = await openColdAppList();
  const { page } = app;
  try {
    await page.waitForFunction(() => window.__http.length === 1);
    // The grid is built again (e.g. after an app was hidden) while App 1 downloads and App 2 waits for the module
    await page.evaluate(() => showApps(window.__host));
    await page.waitForFunction(() => $('#game-grid .game-container').length === 6 && !$('#wasmSpinner').is(':visible'));
    const answer = async (what) => {
      await page.waitForFunction((name) => window.__http.some((entry) => entry.what === name && !entry.answered), what, { timeout: 3000 });
      await page.evaluate((name) => window.__answer(name, new Uint8Array([137, 80, 78, 71])), what);
    };
    // The downloads that were on their way finish; App 3 to App 6 of the first grid never go out
    await answer('boxart 1');
    await answer('boxart 2');
    await page.waitForFunction(() => window.__http.length === 3);
    assert.deepEqual((await httpState(page)).sent, ['boxart 1', 'boxart 2', 'boxart 1']);
    for (let id = 1; id <= 6; id++) {
      await answer('boxart ' + id);
    }
    assert.deepEqual((await httpState(page)).sent, ['boxart 1', 'boxart 2', 'boxart 1', 'boxart 2', 'boxart 3', 'boxart 4', 'boxart 5', 'boxart 6']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
