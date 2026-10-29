'use strict';

// Checks NvHTTP.quitApp() of wasm/static/js/utils.js. A host may answer /cancel with success and keep running an app
// that another client started, so quitApp() refreshes the server info once /cancel completed (before 1.19.101 it
// started the refresh at the same time as /cancel and ignored its result) and fails with QUIT_APP_STILL_RUNNING_ERROR
// while the host still reports a running app. The browser test browser/quit-app.test.js checks what the UI does with
// it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('crypto');
const { createPlatformContext } = require('./helpers/platform-loader');

// Load utils.js with a sendMessage() that records the requests and lets the test answer them
function loadUtils() {
  const requests = [];
  const events = [];
  const platform = createPlatformContext({
    globals: {
      crypto: webcrypto,
      sendMessage(method, params) {
        return new Promise((resolve, reject) => {
          requests.push({ method, url: params[0], resolve, reject });
          events.push('request ' + String(params[0]).replace(/\?.*$/, ''));
        });
      },
    },
  });
  platform.load('wasm/static/js/utils.js');
  return { platform, requests, events };
}

// A paired host that runs app 7, whose server info refresh reports `currentGameAfterRefresh` (or fails)
function makeHost(utils, options) {
  const host = utils.platform.run('new NvHTTP("10.0.0.2", "0123456789abcdef", "", "")');
  host.paired = true;
  host.hostname = 'GAMING-PC';
  host.ppkstr = 'PINNED-CERT';
  host._baseUrlHttps = 'https://10.0.0.2:47984';
  host.currentGame = 7;
  host.refreshServerInfo = function() {
    utils.events.push('refresh');
    if (options.refreshFails) {
      return Promise.reject(-1);
    }
    host.currentGame = options.currentGameAfterRefresh;
    return Promise.resolve(true);
  };
  return host;
}

// Settle the pending promise callbacks
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the error code of an app that still runs', () => {
  assert.equal(loadUtils().platform.get('QUIT_APP_STILL_RUNNING_ERROR'), 599);
});

test('quitApp() refreshes the server info only after /cancel completed and resolves once no app runs', async () => {
  const utils = loadUtils();
  const host = makeHost(utils, { currentGameAfterRefresh: 0 });
  let result = 'pending';
  host.quitApp().then((value) => {
    result = value;
  }, (error) => {
    result = 'rejected ' + error;
  });
  await tick();
  assert.deepEqual(utils.events, ['request https://10.0.0.2:47984/cancel'], 'no refresh before the host answered');
  assert.equal(utils.requests.length, 1);
  assert.match(utils.requests[0].url, /^https:\/\/10\.0\.0\.2:47984\/cancel\?uniqueid=0123456789abcdef&uuid=[0-9a-f-]{36}$/);
  assert.equal(result, 'pending');
  utils.requests[0].resolve('<root status_code="200"><cancel>1</cancel></root>');
  await tick();
  assert.deepEqual(utils.events, ['request https://10.0.0.2:47984/cancel', 'refresh']);
  assert.equal(result, true);
  assert.equal(host.currentGame, 0);
});

test('quitApp() fails with QUIT_APP_STILL_RUNNING_ERROR while the host still runs the app', async () => {
  const utils = loadUtils();
  const host = makeHost(utils, { currentGameAfterRefresh: 7 });
  const quit = host.quitApp();
  await tick();
  utils.requests[0].resolve('<root status_code="200"><cancel>1</cancel></root>');
  await assert.rejects(quit, (error) => error === 599);
  assert.deepEqual(utils.events, ['request https://10.0.0.2:47984/cancel', 'refresh']);
  assert.ok(utils.platform.consoleMessages.some((message) => message.level === 'warn' && message.text.includes('GAMING-PC still runs the app 7')));
});

test('quitApp() fails without a refresh when /cancel fails', async () => {
  const utils = loadUtils();
  const host = makeHost(utils, { currentGameAfterRefresh: 0 });
  const quit = host.quitApp();
  await tick();
  utils.requests[0].reject(-1);
  await assert.rejects(quit, (error) => error === -1);
  assert.deepEqual(utils.events, ['request https://10.0.0.2:47984/cancel']);
});

test('quitApp() fails when the refresh after /cancel fails', async () => {
  const utils = loadUtils();
  const host = makeHost(utils, { refreshFails: true });
  const quit = host.quitApp();
  await tick();
  utils.requests[0].resolve('<root status_code="200"><cancel>1</cancel></root>');
  await assert.rejects(quit, (error) => error === -1);
  assert.deepEqual(utils.events, ['request https://10.0.0.2:47984/cancel', 'refresh']);
});
