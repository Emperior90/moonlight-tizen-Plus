'use strict';

// Checks that box art downloads never hold up the requests that start, resume or quit an app (wasm/platform/messages.js
// and wasm/static/js/utils.js). Every request runs on the one HTTP thread of the module, one at a time: a box art
// download waits behind every other request that comes in while it waits, at most two box art downloads are on their
// way at once (NvHTTP.getBoxArt()), a download of an app list that was left is dropped before it reaches the network,
// and cancelBoxArtDownloads() drops them all when a stream starts, also the one that runs. The module is a stub that
// records the requests and lets the test answer them. The idea comes from the fork of mmadej20 (moonlight-tizen-modern,
// f4eff8e). The browser test tests/browser/box-art-queue.test.js runs it with the app grid and the start of a stream.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('crypto');
const { createPlatformContext, plain } = require('./helpers/platform-loader');

// A FileReader that turns a Blob into a data URL at once, as far as getBoxArt() needs it
function TestFileReader() {}
TestFileReader.prototype.readAsDataURL = function() {
  this.result = 'data:image/png;base64,iVBORw0KGgo=';
  if (this.onloadend) {
    this.onloadend();
  }
};

// Load messages.js (and utils.js) with a module that records the requests of its HTTP thread
function loadQueue(options) {
  const opts = options || {};
  const native = [];
  const platform = createPlatformContext({
    globals: {
      crypto: webcrypto,
      Blob,
      FileReader: TestFileReader,
      Module: {
        openUrl(id, url) {
          if (opts.failingUrl && url.indexOf(opts.failingUrl) >= 0) {
            throw new Error('module without openUrl');
          }
          native.push({ id, what: describe(url) });
        },
        pair(id) {
          native.push({ id, what: 'pair' });
        },
        cancelRequest() {
          native.push({ what: 'cancelRequest' });
          return { type: 'resolve', ret: null };
        },
      },
    },
  });
  platform.load('wasm/platform/messages.js');
  if (opts.utils) {
    platform.load('wasm/static/js/utils.js');
  }
  const answer = (what, value) => {
    const request = native.find((entry) => entry.what === what && !entry.answered);
    assert.ok(request, 'no request ' + what + ' waits: ' + JSON.stringify(native));
    request.answered = true;
    platform.get('handlePromiseMessage')(request.id, value instanceof Error ? 'reject' : 'resolve', value instanceof Error ? value.message : value);
  };
  return {
    platform,
    native,
    answer,
    send: (method, params) => platform.get('sendMessage')(method, params),
    // The requests that reached the module, in order
    sent: () => native.map((entry) => entry.what),
  };
}

// A short name of a request: the box art of an app, or the path
function describe(url) {
  const appasset = /\/appasset\?.*appid=(\d+)/.exec(url);
  return appasset ? 'boxart ' + appasset[1] : String(url).replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
}

const boxArtUrl = (id) => 'https://10.0.0.2:47984/appasset?uniqueid=0&appid=' + id + '&AssetType=2&AssetIdx=0';
const url = (path) => 'https://10.0.0.2:47984' + path + '?uniqueid=0';

// Settle the pending promise callbacks
const tick = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

// Record how a promise settles
function settled(promise) {
  const result = { state: 'pending' };
  promise.then((value) => Object.assign(result, { state: 'resolved', value }), (error) => Object.assign(result, { state: 'rejected', error }));
  return result;
}

test('one request at a time; a request goes before the box art downloads that wait, after the one that runs', async () => {
  const queue = loadQueue();
  const results = [1, 2, 3].map((id) => settled(queue.send('openUrl', [boxArtUrl(id), 'PPK', true])));
  await tick();
  assert.deepEqual(queue.sent(), ['boxart 1']);
  // The launch and then the refresh of the server info go ahead of the box art that waits, in their order
  const launch = settled(queue.send('openUrl', [url('/launch'), 'PPK', false]));
  const refresh = settled(queue.send('openUrl', [url('/serverinfo'), 'PPK', false, 5000]));
  await tick();
  assert.deepEqual(queue.sent(), ['boxart 1'], 'the box art download that runs finishes first');
  queue.answer('boxart 1', 'PNG 1');
  await tick();
  assert.deepEqual(queue.sent(), ['boxart 1', '/launch']);
  queue.answer('/launch', '<root status_code="200"/>');
  await tick();
  queue.answer('/serverinfo', '<root/>');
  await tick();
  assert.deepEqual(queue.sent(), ['boxart 1', '/launch', '/serverinfo', 'boxart 2']);
  queue.answer('boxart 2', 'PNG 2');
  await tick();
  queue.answer('boxart 3', 'PNG 3');
  await tick();
  assert.deepEqual(results.map((result) => result.value), ['PNG 1', 'PNG 2', 'PNG 3']);
  assert.deepEqual([launch.value, refresh.value], ['<root status_code="200"/>', '<root/>']);
  assert.equal(queue.platform.get('_httpQueue').length, 0);
  assert.equal(queue.platform.get('_httpCurrent'), null);
});

test('a request sent right after a box art download goes first, and the order among the other requests stays', async () => {
  const queue = loadQueue();
  queue.send('openUrl', [boxArtUrl(1), 'PPK', true]);
  queue.send('openUrl', [url('/cancel'), 'PPK', false]);
  queue.send('pair', ['7', '10.0.0.2', 47989, '1234', 'uid']);
  await tick();
  assert.deepEqual(queue.sent(), ['/cancel']);
  queue.answer('/cancel', '<root/>');
  await tick();
  queue.answer('pair', 'PPK');
  await tick();
  assert.deepEqual(queue.sent(), ['/cancel', 'pair', 'boxart 1']);
});

test('dropping the box art downloads rejects the ones that wait, cancels the one that runs and keeps the other requests', async () => {
  const queue = loadQueue();
  const boxArts = [1, 2, 3].map((id) => settled(queue.send('openUrl', [boxArtUrl(id), 'PPK', true])));
  await tick();
  const resume = settled(queue.send('openUrl', [url('/resume'), 'PPK', false]));
  assert.equal(queue.platform.get('dropBoxArtRequests')('DROPPED'), 2);
  await tick();
  assert.deepEqual(boxArts.map((result) => [result.state, result.error]), [['rejected', 'DROPPED'], ['rejected', 'DROPPED'], ['rejected', 'DROPPED']]);
  // The module cancels the box art download that runs, and the resume request is next
  assert.deepEqual(queue.sent(), ['boxart 1', 'cancelRequest', '/resume']);
  // The late answer of the canceled download changes nothing
  queue.answer('boxart 1', 'PNG 1');
  queue.answer('/resume', '<root status_code="200"/>');
  await tick();
  assert.deepEqual([boxArts[0].error, resume.value], ['DROPPED', '<root status_code="200"/>']);
  // Nothing to drop: a request that runs and isn't box art stays
  queue.send('openUrl', [url('/applist'), 'PPK', false]);
  await tick();
  assert.equal(queue.platform.get('dropBoxArtRequests')('DROPPED'), 0);
  assert.deepEqual(queue.sent().slice(3), ['/applist']);
});

test('a request that times out is canceled in the module and the next one starts', async () => {
  const queue = loadQueue();
  const timedOut = settled(queue.send('openUrl', [url('/serverinfo'), 'PPK', false, 30]));
  const next = settled(queue.send('openUrl', [url('/applist'), 'PPK', false]));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await tick();
  assert.deepEqual([timedOut.state, timedOut.error], ['rejected', -1]);
  assert.deepEqual(queue.sent(), ['/serverinfo', 'cancelRequest', '/applist']);
  queue.answer('/applist', '<root/>');
  await tick();
  assert.equal(next.value, '<root/>');
});

test('a pairing request canceled while it waits never starts, and a request that fails to start doesn\'t block the queue', async () => {
  const queue = loadQueue({ failingUrl: '/broken' });
  queue.send('openUrl', [url('/serverinfo'), 'PPK', false]);
  const pairing = settled(queue.send('pair', ['7', '10.0.0.2', 47989, '1234', 'uid']));
  await tick();
  await queue.send('cancelRequest', []);
  queue.answer('/serverinfo', '<root/>');
  await tick();
  assert.deepEqual([pairing.state, pairing.error], ['rejected', -1]);
  assert.deepEqual(queue.sent(), ['/serverinfo', 'cancelRequest']);

  const broken = settled(queue.send('openUrl', [url('/broken'), 'PPK', false]));
  queue.send('openUrl', [url('/applist'), 'PPK', false]);
  await tick();
  assert.equal(broken.state, 'rejected');
  assert.deepEqual(queue.sent().slice(2), ['/applist']);
  assert.ok(queue.platform.consoleMessages.some((entry) => entry.level === 'error' && /Failed to send an HTTP request/.test(entry.text)));
});

// A paired host of utils.js whose box art is not cached yet (the simulated TV has no file system)
function makeHost(queue) {
  const host = queue.platform.run('new NvHTTP("10.0.0.2", "0123456789abcdef", "", "")');
  host.paired = true;
  host.hostname = 'GAMING-PC';
  host.ppkstr = 'PPK';
  host._baseUrlHttps = 'https://10.0.0.2:47984';
  return host;
}

test('at most two box art downloads are on their way at once, in the order of the app list, also after one failed', async () => {
  const queue = loadQueue({ utils: true });
  const host = makeHost(queue);
  const results = [1, 2, 3, 4, 5, 6].map((id) => settled(host.getBoxArt(id, false)));
  await tick();
  // One runs in the module, one waits in the queue of the HTTP thread, the others wait for a place
  const inQueue = () => queue.platform.get('_httpQueue').length + (queue.platform.get('_httpCurrent') ? 1 : 0);
  assert.deepEqual([queue.sent(), inQueue()], [['boxart 1'], 2]);
  queue.answer('boxart 1', new Uint8Array([1]));
  await tick();
  assert.deepEqual([queue.sent(), inQueue()], [['boxart 1', 'boxart 2'], 2]);
  queue.answer('boxart 2', new Error('-1'));
  await tick();
  assert.deepEqual([queue.sent().slice(-1), inQueue()], [['boxart 3'], 2]);
  for (const id of [3, 4, 5, 6]) {
    queue.answer('boxart ' + id, new Uint8Array([id]));
    await tick();
  }
  assert.deepEqual(queue.sent(), ['boxart 1', 'boxart 2', 'boxart 3', 'boxart 4', 'boxart 5', 'boxart 6']);
  assert.deepEqual(results.map((result) => result.state), ['resolved', 'rejected', 'resolved', 'resolved', 'resolved', 'resolved']);
  assert.match(results[0].value, /^data:image\/png;base64,/);
});

test('the box art of an app list that was left is dropped before it reaches the network', async () => {
  const queue = loadQueue({ utils: true });
  const host = makeHost(queue);
  let left = false;
  const results = [1, 2, 3, 4].map((id) => settled(host.getBoxArt(id, false, () => left)));
  await tick();
  left = true;
  queue.answer('boxart 1', new Uint8Array([1]));
  await tick();
  queue.answer('boxart 2', new Uint8Array([2]));
  await tick();
  assert.deepEqual(queue.sent(), ['boxart 1', 'boxart 2'], 'the downloads that were on their way finish');
  assert.deepEqual(results.map((result) => result.state), ['resolved', 'resolved', 'rejected', 'rejected']);
  assert.deepEqual([results[2].error, results[3].error], ['BOX_ART_DOWNLOAD_DROPPED', 'BOX_ART_DOWNLOAD_DROPPED']);
  // A dropped download is no error in the log
  assert.deepEqual(queue.platform.consoleMessages.filter((entry) => /Failed to retrieve/.test(entry.text)), []);
  assert.equal(queue.platform.consoleMessages.filter((entry) => /Dropped the box art download of app ID/.test(entry.text)).length, 2);
});

test('when a stream starts, every box art download is dropped and the launch request is next; later ones download again', async () => {
  const queue = loadQueue({ utils: true });
  const host = makeHost(queue);
  const results = [1, 2, 3, 4, 5].map((id) => settled(host.getBoxArt(id, true)));
  await tick();
  // showStreamMode() in index.js, then the launch request of startGame()
  queue.platform.get('cancelBoxArtDownloads')();
  const launch = settled(host.launchApp(3, '3840x2160x60', 0, 'KEY', 1, 1, 0, 0x030002, 1, 1));
  await tick();
  assert.deepEqual(queue.sent(), ['boxart 1', 'cancelRequest', '/launch']);
  assert.deepEqual(plain(results.map((result) => result.error)), Array(5).fill('BOX_ART_DOWNLOAD_DROPPED'));
  queue.answer('/launch', '<root status_code="200"/>');
  await tick();
  assert.equal(launch.state, 'resolved');

  // The app list after the stream downloads its box art as usual
  const again = settled(host.getBoxArt(9, false));
  await tick();
  queue.answer('boxart 9', new Uint8Array([9]));
  await tick();
  assert.equal(again.state, 'resolved');
  assert.deepEqual(queue.sent().slice(3), ['boxart 9']);
});
