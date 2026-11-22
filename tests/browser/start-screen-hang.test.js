'use strict';

// Checks that the launch screen of a stream ('Starting <game>...') always ends when the PC doesn't start the game
// (startGame(), readStreamStartAnswer(), limitStreamStartRequest(), endStreamStartWithoutAnswer(),
// endStreamStartWithInvalidAnswer() and cancelStreamLaunch() in wasm/platform/index.js, cancelStreamStartRequests() in
// wasm/platform/messages.js, STREAM_START_REQUEST_TIMEOUT_MS in wasm/static/js/utils.js, and the RETURN key in
// wasm/platform/remote_controller.js). Before 2.3.2 it stayed for good:
// - when the PC held the launch or resume request without an answer: Sunshine, Apollo, Vibepollo and Vibeshine answer it
//   only once the commands that come before the app ran, and wait for a command that waits (e.g. for input or a
//   confirmation on the PC) without a limit, while the TV had no limit either. RED left the launch screen, but then
//   'Loading Apps...' stayed, since the refresh of the server info waited behind the request in the one HTTP thread of
//   the module. Now the start ends after 120 seconds with a message, as Moonlight for PC gives up after 120 seconds, the
//   request is canceled in the module, and RED lets the request go after a short grace.
// - when the answer wasn't XML: $.parseXML() threw in the handler of the answer, which left the launch screen up until
//   RED. Sunshine answers a request that an error interrupted with HTTP 200 and only the XML declaration ('Property tree
//   is empty' in its log). Now such an answer returns to the app list with a message.
// - when the silent retry after no video or the reconnect of the Stream Menu got no answer, or found no app list.
// RETURN did nothing on the launch screen, which the menus don't handle there; it now cancels the start like RED, and
// the launch screen names both keys.
// Everything of the app is real here: NvHTTP, the request queue, startGame(), showApps() and the app grid, against the
// simulated Sunshine of mocks/sunshine-host.js, whose module function Module.openUrl is wrapped so that /launch, /resume
// and /applist answer as each test needs. The times are scaled down: the limit of the launch and resume requests 2 s
// (120 s in the app), the grace of a cancelled request 300 ms (3 s), the hold of a start the PC may still have 600 ms
// (11 s), the delays of the retry and the reconnect 100 ms.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SUNSHINE_HOSTS, openApp, startHarness } = require('./harness');
const { forEachTextWidth } = require('./text-stress');

const REPO_ROOT = path.join(__dirname, '..', '..');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const RED = [403, 'ColorF0Red'];
const RETURN = [10009, 'XF86Back'];
const LIMIT_MS = 2000;
const GRACE_MS = 300;
const HOLD_MS = 600;

const TIMEOUT_MESSAGE = 'GAMING-PC didn\'t answer the start of Cyberpunk 2077 within 2 seconds. A command that Sunshine (or another GameStream host) runs before the app, e.g. to switch the display, may be waiting on the PC. End it or restart Sunshine, then start the app again.';
const INVALID_MESSAGE = 'GAMING-PC answered the start of Cyberpunk 2077 with an invalid reply, e.g. after an error in Sunshine (or another GameStream host). Check the log of Sunshine (or the other host) on the PC, then start the app again.';
const APP_LIST_MESSAGE = 'Unable to retrieve your list of apps at this time. Please refresh the list of apps or try again later!';
// The answer of Sunshine to a launch or resume request that an error interrupted (src/nvhttp.cpp: an empty property
// tree, written with HTTP 200)
const SUNSHINE_EMPTY_ANSWER = '<?xml version="1.0" encoding="utf-8"?>\n';

// Press and release a key of the remote on the focused element, like the TV delivers it (window.pressKey() of openWithPc())
const remoteKey = (page, key, repeat) => page.evaluate(({ code, name, isRepeat }) => window.pressKey(code, name, isRepeat),
  { code: key[0], name: key[1], isRepeat: !!repeat });

// Hold a key of the remote for holdMs, as the TV delivers it: a keydown, after 500 ms its auto-repeat (keydown with
// repeat) every 100 ms, then the keyup. Returns the views (data-view of the body) in the order they showed meanwhile.
const holdKey = (page, key, holdMs) => page.evaluate(async ({ code, name, ms }) => {
  const views = [document.body.getAttribute('data-view')];
  const noteView = () => {
    const view = document.body.getAttribute('data-view');
    if (views[views.length - 1] !== view) {
      views.push(view);
    }
  };
  window.pressKey(code, name, false, 'keydown');
  const until = performance.now() + ms;
  await window.wait(500);
  while (performance.now() < until) {
    noteView();
    window.pressKey(code, name, true, 'keydown');
    noteView();
    await window.wait(100);
  }
  window.pressKey(code, name, false, 'keyup');
  noteView();
  return views;
}, { code: key[0], name: key[1], ms: holdMs });

// Open the app with the simulated PC stored as paired (running currentGame, if any), open its app list as OK on its card
// does, and wrap the HTTP function of the module: window.__plans['/launch'], ['/resume'] and ['/applist'] say how the
// next such request is answered ({ kind: 'never' }, { kind: 'resolve', value }, { kind: 'reject', value }), or null for
// the simulated Sunshine. window.__events records the requests and the start requests, window.__snack the messages,
// window.__unhandled the unhandled promise rejections.
async function openWithPc(options) {
  const opts = options || {};
  const app = await openApp(harness, {
    tv: Object.assign({ tv: 's90c', conn: 'wifi' }, opts.tv || {}),
    moduleScripts: ['sunshine-host.js'],
    stored: { hosts: SUNSHINE_HOSTS },
    initScripts: [`window.__sunshineConfig = { currentGame: ${opts.currentGame || 0} };`],
  });
  await app.page.waitForFunction((game) => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true &&
    Number(hosts.HOST1.currentGame) === game, opts.currentGame || 0, { timeout: 10000 });
  await app.page.evaluate(({ limitMs, graceMs, holdMs }) => {
    STREAM_START_REQUEST_TIMEOUT_MS = limitMs;
    STREAM_START_REQUEST_CANCEL_GRACE_MS = graceMs;
    HOST_START_HOLD_MS = holdMs;
    STREAM_RETRY_DELAY_MS = 100;
    SETTINGS_RESTART_DELAY_MS = 100;
    window.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // A keydown and a keyup of a key of the remote (or only one of them, type), with repeat on the keydown
    window.pressKey = (code, name, repeat, type) => {
      (type ? [type] : ['keydown', 'keyup']).forEach((eventType) => {
        const event = new KeyboardEvent(eventType, { key: name, bubbles: true, cancelable: true, repeat: !!repeat && eventType === 'keydown' });
        Object.defineProperty(event, 'keyCode', { value: code });
        Object.defineProperty(event, 'which', { value: code });
        (document.activeElement || document.body).dispatchEvent(event);
      });
    };
    window.__snack = [];
    window.__unhandled = [];
    window.__events = [];
    window.__plans = {};
    window.__held = [];
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      window.__unhandled.push(String(reason && reason.message ? reason.message : reason));
    });
    document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snack.push(data.message);
    const sunshineOpenUrl = Module.openUrl;
    Module.openUrl = function(id, url) {
      const match = /\/(launch|resume|applist|serverinfo)\?/.exec(url);
      const what = match ? '/' + match[1] : '';
      if (what && what !== '/serverinfo') {
        window.__events.push(what);
      }
      const plan = what ? window.__plans[what] : null;
      if (!plan) {
        return sunshineOpenUrl.apply(this, arguments);
      }
      window.__plans[what] = plan.again ? plan : null;
      if (plan.kind === 'never') {
        window.__held.push({ id, what });
        return undefined;
      }
      setTimeout(() => handlePromiseMessage(id, plan.kind, plan.value), 30);
      return undefined;
    };
    const startStream = Module.startStream;
    Module.startStream = function() {
      window.__events.push('start request');
      return startStream.apply(this, arguments);
    };
    const cancelRequest = Module.cancelRequest;
    Module.cancelRequest = function() {
      window.__events.push('cancelRequest');
      return cancelRequest.apply(this, arguments);
    };
    const stopStream = Module.stopStream;
    Module.stopStream = function() {
      window.__events.push('stopStream');
      return stopStream.apply(this, arguments);
    };
    // Answer the requests that the PC held, late
    window.releaseHeld = (body) => window.__held.splice(0).forEach((entry) => handlePromiseMessage(entry.id, 'resolve', body));
    window.screen_ = () => ({
      view: document.body.getAttribute('data-view'),
      startScreen: $('#loadingSpinner').is(':visible'),
      startMessage: $('#loadingSpinnerMessage').text(),
      loading: $('#wasmSpinner').is(':visible') ? $('#wasmSpinnerMessage').text() : '',
      tiles: $('#game-grid .game-container').length,
      isInGame,
      video: $('#wasm_module').is(':visible'),
      // The launch and resume requests that run or wait in the queue of the HTTP thread of the module
      startRequests: (_httpCurrent && _httpCurrent.streamStart ? 1 : 0) + _httpQueue.filter((entry) => entry.streamStart).length,
    });
    window.take = () => ({ screen: window.screen_(), snack: window.__snack.splice(0), events: window.__events.splice(0),
      unhandled: window.__unhandled.splice(0) });
  }, { limitMs: LIMIT_MS, graceMs: GRACE_MS, holdMs: HOLD_MS });
  // OK on the card of the PC opens its app list
  await app.page.evaluate(() => $('#host-container-HOST1').click());
  await appListShown(app.page);
  await app.page.waitForTimeout(300);
  await app.page.evaluate(() => window.take());
  return app;
}

const appListShown = (page, timeout) => page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' &&
  $('#game-grid .game-container').length > 0 && !$('#wasmSpinner').is(':visible') && !$('#loadingSpinner').is(':visible'),
null, { timeout: timeout || 5000 });

// Start Cyberpunk 2077 (app 101) with OK on its tile, which ignores an OK within 600 ms of the one on the PC card and a
// second start within 2 seconds (lastHostClickAt, lastAppTileClickAt)
const startApp = (page) => page.evaluate(() => {
  lastHostClickAt = -Infinity;
  lastAppTileClickAt = -Infinity;
  $('#game-container-101').click();
});

const take = (page) => page.evaluate(() => window.take());

// Wait until the start sent its launch or resume request (what), so that the launch screen shows
const requestSent = (page, what) => page.waitForFunction((path) => window.__events.indexOf(path) >= 0 && $('#loadingSpinner').is(':visible'),
  what, { timeout: 5000 });

// The next start with a PC that answers: it waits for the hold of the start before (if any), then the stream shows
async function nextStartWorks(page) {
  return page.evaluate(async () => {
    window.__plans = {};
    const messages = [];
    lastHostClickAt = -Infinity;
    lastAppTileClickAt = -Infinity;
    $('#game-container-101').click();
    for (let i = 0; i < 60 && !(wasmSessionStarted && $('#wasm_module').is(':visible')); i++) {
      const message = $('#loadingSpinnerMessage').text();
      if (message && messages.indexOf(message) < 0) {
        messages.push(message);
      }
      await window.wait(50);
    }
    return { streaming: wasmSessionStarted && $('#wasm_module').is(':visible'), messages };
  });
}

// The app list shows with its tiles, without the launch screen, and the stream counts as ended
function assertBackInAppList(screen, message) {
  assert.deepEqual([screen.view, screen.startScreen, screen.loading, screen.isInGame, screen.video], ['apps', false, '', false, false], message);
  assert.ok(screen.tiles > 0, message);
}

test('a launch request that the PC never answers ends after the time limit with a message, and the next start works', async () => {
  const app = await openWithPc();
  try {
    await app.page.evaluate(() => {
      window.__plans['/launch'] = { kind: 'never' };
    });
    await startApp(app.page);
    await requestSent(app.page, '/launch');
    const waiting = await take(app.page);
    // The launch screen while the PC holds the request
    assert.deepEqual([waiting.screen.startScreen, waiting.screen.startMessage, waiting.screen.isInGame], [true, 'Starting Cyberpunk 2077...', true]);
    assert.deepEqual(waiting.events, ['/launch']);
    // Before 2.3.2 it stayed for good; now the start ends once the limit ran out
    await appListShown(app.page, LIMIT_MS + 3000);
    const ended = await take(app.page);
    assertBackInAppList(ended.screen, JSON.stringify(ended));
    assert.deepEqual(ended.snack, [TIMEOUT_MESSAGE]);
    // The module canceled the request, so the refresh of the server info for the app list could go out
    assert.deepEqual(ended.events, ['cancelRequest']);
    assert.equal(ended.screen.startRequests, 0);
    assert.deepEqual(ended.unhandled, []);
    assert.ok(app.logs.some((line) => /GAMING-PC didn't answer the launch request within 2 s/.test(line)));
    // The PC may still start the app, as with a start cancelled with RED, so the next start waits for its hold
    assert.ok(app.logs.some((line) => line.indexOf('GAMING-PC may hold a start of this TV') >= 0 && line.indexOf('its launch request was cancelled') >= 0));
    assert.ok(await app.page.evaluate(() => getHeldHostStartMs(api)) > 0);
    // A late answer changes nothing: the module dropped the request
    await app.page.evaluate(() => window.releaseHeld('<root status_code="200"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>'));
    await app.page.waitForTimeout(300);
    const late = await take(app.page);
    assertBackInAppList(late.screen);
    assert.deepEqual(late.events.filter((event) => event === 'start request'), []);

    const next = await nextStartWorks(app.page);
    assert.equal(next.streaming, true, JSON.stringify(next));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a resume request that the PC never answers ends the same way, in the language of the TV', async () => {
  const app = await openWithPc({ currentGame: 101, tv: { locale: 'de_DE' } });
  try {
    await app.page.evaluate(() => {
      window.__plans['/resume'] = { kind: 'never' };
    });
    await startApp(app.page);
    await requestSent(app.page, '/resume');
    await appListShown(app.page, LIMIT_MS + 3000);
    const ended = await take(app.page);
    assertBackInAppList(ended.screen, JSON.stringify(ended));
    assert.deepEqual(ended.events, ['/resume', 'cancelRequest']);
    assert.deepEqual(ended.snack, ['GAMING-PC hat auf den Start von Cyberpunk 2077 2 Sekunden lang nicht geantwortet. ' +
      'Vielleicht wartet auf dem PC ein Befehl, den Sunshine (oder ein anderer GameStream-Host) vor der App ausführt, z. B. für einen Bildschirmwechsel. ' +
      'Beende ihn oder starte Sunshine neu, dann starte die App erneut.']);
    assert.ok(app.logs.some((line) => line.indexOf('its resume request was cancelled') >= 0));
    assert.deepEqual(ended.unhandled, []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// The limit of the launch and resume requests for a test that is not about it: long enough that only the grace of a
// cancelled start (or nothing) can let go of a request that the PC holds, also for the limit of the request queue
const LONG_LIMIT_MS = 60000;
const setLimit = (page, ms) => page.evaluate((limitMs) => {
  STREAM_START_REQUEST_TIMEOUT_MS = limitMs;
}, ms);

test('RED while the PC holds the launch request returns to the app list after a short grace, not when the PC answers', async () => {
  const app = await openWithPc();
  try {
    // A limit that runs out well after the app list showed: the app list then comes from the grace alone, not from the
    // limit, and the start that RED ended shows no message once the limit has passed
    const limitMs = 4000;
    await setLimit(app.page, limitMs);
    await app.page.evaluate(() => {
      window.__plans['/launch'] = { kind: 'never' };
      window.__startedAt = performance.now();
    });
    await startApp(app.page);
    await requestSent(app.page, '/launch');
    await remoteKey(app.page, RED);
    const afterRed = await take(app.page);
    // The launch screen goes at once, and the app list loads; the request still runs for the grace
    assert.deepEqual([afterRed.screen.startScreen, afterRed.screen.loading, afterRed.screen.isInGame], [false, 'Loading Apps...', false]);
    assert.deepEqual(afterRed.events, ['/launch']);
    // Before 2.3.2 'Loading Apps...' stayed for as long as the PC held the request; now the module cancels it after the
    // grace, and the refresh behind it goes out
    await appListShown(app.page, GRACE_MS + 2500);
    const back = await take(app.page);
    assertBackInAppList(back.screen, JSON.stringify(back));
    assert.deepEqual(back.events, ['cancelRequest']);
    // RED cancels without a message
    assert.deepEqual([back.snack, back.unhandled], [[], []]);
    assert.ok(app.logs.some((line) => line.indexOf('its launch request was cancelled') >= 0));
    // No message once the limit of the request has passed either
    await app.page.evaluate((ms) => window.wait(Math.max(0, window.__startedAt + ms - performance.now())), limitMs + 300);
    assert.deepEqual((await take(app.page)).snack, []);
    const next = await nextStartWorks(app.page);
    assert.equal(next.streaming, true, JSON.stringify(next));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RED during a start that the PC answers within the grace keeps the answer, which tells that the PC took the start', async () => {
  const app = await openWithPc();
  try {
    // A grace with room for the answer, and a hold long enough to read after it
    const graceMs = 1500;
    await setLimit(app.page, LONG_LIMIT_MS);
    await app.page.evaluate((ms) => {
      STREAM_START_REQUEST_CANCEL_GRACE_MS = ms;
      HOST_START_HOLD_MS = 5000;
      window.__plans['/launch'] = { kind: 'never' };
    }, graceMs);
    await startApp(app.page);
    await requestSent(app.page, '/launch');
    // RED, and the answer a moment later, within the grace; then the wait until the grace is over
    const answered = await app.page.evaluate(async ({ code, name, ms }) => {
      window.pressKey(code, name, false);
      const redAt = performance.now();
      await window.wait(300);
      const heldBefore = getHeldHostStartMs(api);
      window.releaseHeld('<root status_code="200"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>');
      await window.wait(0);
      const heldAfter = getHeldHostStartMs(api);
      await window.wait(Math.max(0, redAt + ms * 1.5 - performance.now()));
      return { heldBefore, heldAfter };
    }, { code: RED[0], name: RED[1], ms: graceMs });
    await appListShown(app.page);
    const back = await take(app.page);
    assertBackInAppList(back.screen);
    // Not cancelled, also not once the grace was over, when another request may run: the answer came within the grace
    assert.deepEqual(back.events.filter((event) => event === 'cancelRequest' || event === 'start request'), []);
    assert.ok(app.logs.some((line) => line.indexOf('Ignoring the reply to a cancelled launch request') >= 0));
    // The hold of the start that the PC took counts from the answer: none before it, nearly the whole hold after it
    assert.ok(app.logs.some((line) => line.indexOf('it accepted a start that was cancelled') >= 0));
    assert.equal(answered.heldBefore, 0, JSON.stringify(answered));
    assert.ok(answered.heldAfter > 4500, JSON.stringify(answered));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RETURN on the launch screen cancels the start like RED, before and after the start request, but not the stream', async () => {
  const app = await openWithPc();
  try {
    // Only the grace lets go of the held request (LONG_LIMIT_MS)
    await setLimit(app.page, LONG_LIMIT_MS);
    // Before the start request: the PC holds the launch request
    await app.page.evaluate(() => {
      window.__plans['/launch'] = { kind: 'never' };
    });
    await startApp(app.page);
    await requestSent(app.page, '/launch');
    // The auto-repeat of a held key is ignored
    await remoteKey(app.page, RETURN, true);
    assert.equal((await take(app.page)).screen.startScreen, true);
    await remoteKey(app.page, RETURN);
    const afterReturn = await take(app.page);
    assert.deepEqual([afterReturn.screen.startScreen, afterReturn.screen.loading, afterReturn.screen.isInGame], [false, 'Loading Apps...', false]);
    await appListShown(app.page, GRACE_MS + 3000);
    assert.deepEqual((await take(app.page)).events, ['cancelRequest']);
    assert.ok(app.logs.some((line) => line.indexOf('Cancelling the start of the stream') >= 0));

    // After the start request, while the module sets up the connection: the module stops it
    await app.page.evaluate(async () => {
      await window.wait(HOST_START_HOLD_MS);
      window.__plans = {};
      Module.startStream = function() {
        window.__events.push('start request');
        setTimeout(() => handleMessage('ProgressMsg: Starting RTSP handshake...'), 20);
        return { type: 'resolve', ret: null };
      };
    });
    await startApp(app.page);
    await app.page.waitForFunction(() => wasmSessionStarted && $('#loadingSpinnerMessage').text() === 'Starting the RTSP handshake...', null, { timeout: 5000 });
    // RETURN held for 1.5 s: the app list shows within its first half second, and the auto-repeat of the RETURN that
    // stopped the start doesn't go back from it to the PC list
    const views = await holdKey(app.page, RETURN, 1500);
    await appListShown(app.page);
    const stopped = await take(app.page);
    assert.deepEqual(stopped.events, ['/launch', 'start request', 'stopStream']);
    assertBackInAppList(stopped.screen);
    assert.deepEqual(stopped.snack, []);
    assert.equal(views[views.length - 1], 'apps', JSON.stringify(views));
    assert.equal(views.indexOf('hosts'), -1, JSON.stringify(views));
    // The next press of RETURN goes back as before
    await remoteKey(app.page, RETURN);
    await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'hosts', null, { timeout: 3000 });
    await app.page.evaluate(() => $('#host-container-HOST1').click());
    await appListShown(app.page);
    await take(app.page);

    // During the stream RETURN goes to the PC as Esc, and the stream goes on
    await app.page.evaluate(() => {
      Module.startStream = function() {
        window.__events.push('start request');
        setTimeout(() => {
          handleMessage('ControlStreamConnected');
          handleMessage('Connection Established');
        }, 20);
        return { type: 'resolve', ret: null };
      };
    });
    await startApp(app.page);
    await app.page.waitForFunction(() => isStreamConnected && $('#wasm_module').is(':visible'), null, { timeout: 5000 });
    await app.page.evaluate(() => {
      window.__wasmCalls.length = 0;
    });
    await remoteKey(app.page, RETURN);
    await app.page.waitForTimeout(200);
    const streaming = await take(app.page);
    assert.deepEqual([streaming.screen.isInGame, streaming.screen.video], [true, true]);
    assert.equal(streaming.events.indexOf('stopStream'), -1);
    // Esc went to the PC: its key down and key up (sendEscapeKeyToHost() in index.js)
    const keys = await app.page.evaluate(() => window.__wasmCalls.filter((call) => call.name === 'sendKeyboardEvent').map((call) => call.args.slice(0, 2)));
    assert.deepEqual(keys, [[0x801B, 0x03], [0x801B, 0x04]]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('an answer that no host sends returns to the app list with a message, also Sunshine\'s answer after an error', async () => {
  const app = await openWithPc();
  try {
    const answers = [
      [SUNSHINE_EMPTY_ANSWER, 'only the XML declaration, which Sunshine sends when an error interrupted the request'],
      ['Bad Request', 'no XML (11 characters)'],
      ['{"status_code":200}', 'no XML'],
      ['<root status_code="200"', 'no XML'],
      ['', 'an empty answer'],
      ['<html><body>502 Bad Gateway</body></html>', 'XML without a root element'],
      ['<root status_message="Something"/>', 'a root element without a status code'],
    ];
    for (const [body, problem] of answers) {
      await app.page.evaluate((value) => {
        window.__plans['/launch'] = { kind: 'resolve', value };
      }, body);
      await startApp(app.page);
      await app.page.waitForFunction(() => window.__events.indexOf('/launch') >= 0);
      await appListShown(app.page, 3000);
      const ended = await take(app.page);
      const message = JSON.stringify(body) + ' ' + JSON.stringify(ended);
      assertBackInAppList(ended.screen, message);
      // Before 2.3.2 the launch screen stayed until RED for the first four, with an unhandled 'Invalid XML', and the
      // others showed 'Error : '
      assert.deepEqual(ended.snack, [INVALID_MESSAGE], message);
      assert.deepEqual(ended.unhandled, [], message);
      assert.deepEqual(ended.events.filter((event) => event === 'start request'), [], message);
      assert.ok(app.logs.some((line) => line.indexOf('Error: The answer of GAMING-PC to the launch request is ' + problem) >= 0), message);
      // The PC answered, so it holds no start, and the next start doesn't wait
      assert.equal(await app.page.evaluate(() => getHeldHostStartMs(api)), 0, message);
    }
    // The answer itself stays out of the log, which can hold anything
    assert.equal(app.logs.filter((line) => line.indexOf('502 Bad Gateway') >= 0).length, 0);
    const next = await nextStartWorks(app.page);
    assert.equal(next.streaming, true, JSON.stringify(next));
    assert.deepEqual(next.messages, ['Starting Cyberpunk 2077...']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a resume request answered with Sunshine\'s answer after an error returns to the app list with the message', async () => {
  const app = await openWithPc({ currentGame: 101 });
  try {
    await app.page.evaluate((value) => {
      window.__plans['/resume'] = { kind: 'resolve', value };
    }, SUNSHINE_EMPTY_ANSWER);
    await startApp(app.page);
    await app.page.waitForFunction(() => window.__events.indexOf('/resume') >= 0);
    await appListShown(app.page, 3000);
    const ended = await take(app.page);
    assertBackInAppList(ended.screen, JSON.stringify(ended));
    assert.deepEqual([ended.events, ended.snack, ended.unhandled], [['/resume'], [INVALID_MESSAGE], []]);
    assert.ok(app.logs.some((line) => line.indexOf('Error: The answer of GAMING-PC to the resume request is only the XML declaration') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// Start app 101 and wait until its stream shows
async function startStream(page) {
  await startApp(page);
  await page.waitForFunction(() => isStreamConnected && $('#wasm_module').is(':visible'), null, { timeout: 5000 });
  await take(page);
}

test('the silent retry after no video whose resume request the PC never answers ends after the time limit', async () => {
  const app = await openWithPc();
  try {
    await startStream(app.page);
    // No video arrived: the app starts the stream once more without a word, and the PC holds its resume request
    await app.page.evaluate(() => {
      window.__plans['/resume'] = { kind: 'never' };
      handleMessage('TerminationPortsMsg: UDP 47998, UDP 48000');
      handleMessage('streamTerminated: -100');
    });
    await requestSent(app.page, '/resume');
    const retrying = await take(app.page);
    assert.deepEqual([retrying.screen.startScreen, retrying.screen.startMessage, retrying.events], [true, 'Starting Cyberpunk 2077...', ['/resume']]);
    await appListShown(app.page, LIMIT_MS + 3000);
    const ended = await take(app.page);
    assertBackInAppList(ended.screen, JSON.stringify(ended));
    // The message says what happened, instead of the one about the ports of the stream before
    assert.deepEqual([ended.snack, ended.events, ended.unhandled], [[TIMEOUT_MESSAGE], ['cancelRequest'], []]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the reconnect of the Stream Menu whose resume request the PC never answers ends after the time limit', async () => {
  const app = await openWithPc();
  try {
    await startStream(app.page);
    await app.page.evaluate(() => {
      window.__plans['/resume'] = { kind: 'never' };
      restartStreamWithSettings({ bitrateMbps: 20 });
    });
    await requestSent(app.page, '/resume');
    const reconnecting = await take(app.page);
    assert.deepEqual([reconnecting.screen.startScreen, reconnecting.screen.startMessage], [true, 'Reconnecting with 20 Mbps...']);
    await appListShown(app.page, LIMIT_MS + 3000);
    const ended = await take(app.page);
    assertBackInAppList(ended.screen, JSON.stringify(ended));
    assert.deepEqual([ended.snack, ended.unhandled], [[TIMEOUT_MESSAGE], []]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a start whose app list the PC doesn\'t send says so, and a start once more ends instead of staying', async () => {
  const app = await openWithPc();
  try {
    // A start from the app list, while the cache of the host is empty (e.g. after a failed poll) and /applist fails:
    // before 2.3.2 OK seemed to do nothing, with an unhandled rejection
    await app.page.evaluate(() => {
      api._memCachedApplist = null;
      window.__plans['/applist'] = { kind: 'reject', value: -1 };
    });
    await startApp(app.page);
    await app.page.waitForFunction(() => window.__snack.length > 0, null, { timeout: 5000 });
    await appListShown(app.page);
    const fresh = await take(app.page);
    assertBackInAppList(fresh.screen, JSON.stringify(fresh));
    assert.deepEqual([fresh.snack, fresh.events, fresh.unhandled], [[APP_LIST_MESSAGE], ['/applist'], []]);

    // The retry after no video, which finds no app list: before 2.3.2 its launch screen stayed until RED
    await app.page.evaluate(() => {
      window.__plans = {};
    });
    await startStream(app.page);
    await app.page.evaluate(() => {
      api._memCachedApplist = null;
      window.__plans['/applist'] = { kind: 'reject', value: -1, again: true };
      handleMessage('streamTerminated: -100');
    });
    await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && !$('#loadingSpinner').is(':visible') &&
      !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    await app.page.waitForTimeout(300);
    const retry = await take(app.page);
    assert.deepEqual([retry.screen.view, retry.screen.startScreen, retry.screen.isInGame], ['apps', false, false], JSON.stringify(retry));
    // The message of a retry that fails; the app list, which can't show its apps, says why at the top of the screen,
    // where its illustration has the selection (since 2.3.3; a snackbar of the same text before)
    assert.deepEqual(retry.snack, ['No video received from the PC. Check the host PC\'s firewall and port forwarding rules.']);
    assert.deepEqual(await app.page.evaluate(() => ({
      marked: Array.prototype.map.call(document.querySelectorAll('.hovered'), (element) => element.id || element.tagName),
      text: document.getElementById('hero-text').textContent,
    })), { marked: ['IMG'], text: 'Unable to retrieve your list of apps at this time. Please refresh the list of apps or try again later!' });
    assert.ok(app.logs.some((line) => line.indexOf('The stream can\'t be started once more: the app list of the host could not be read') >= 0));
    // The app list that leaveStreamView() (messages.js) shows after the end fails as well, which it logs (since 2.3.3;
    // an unhandled rejection before)
    assert.deepEqual(retry.unhandled, []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RED while the launch request still waits behind another request drops it unsent, so the next start doesn\'t wait', async () => {
  const app = await openWithPc();
  try {
    await setLimit(app.page, LONG_LIMIT_MS);
    // The hold of an earlier start, so that the start counts down first
    await app.page.evaluate(() => {
      HOST_START_HOLD_MS = 2000;
      rememberHeldHostStart(api, performance.now(), 'an earlier start of the test');
      window.__plans['/applist'] = { kind: 'never' };
    });
    await startApp(app.page);
    await app.page.waitForFunction(() => /\(\d s\)/.test($('#loadingSpinnerMessage').text()), null, { timeout: 5000 });
    // Meanwhile a request that the PC holds takes the one HTTP thread of the module (an app list here, as a poll asks)
    await app.page.evaluate(() => {
      window.__otherRequest = sendMessage('openUrl', [api._baseUrlHttps + '/applist?' + api._buildUidStr(), api.ppkstr, false, 30000])
        .then(() => 'answered', (error) => 'failed ' + error);
    });
    // The countdown is over, and the launch request waits in the queue behind it
    await app.page.waitForFunction(() => _httpQueue.some((entry) => entry.streamStart), null, { timeout: 5000 });
    // A hold long enough that the next start would show it, if the dropped request remembered one
    await app.page.evaluate(() => {
      HOST_START_HOLD_MS = 5000;
    });
    await remoteKey(app.page, RED);
    const afterRed = await take(app.page);
    // Dropped at once, without the grace of a request that runs
    assert.equal(afterRed.screen.startRequests, 0, JSON.stringify(afterRed));
    assert.equal(afterRed.screen.startScreen, false);
    // The PC lets go of the request that held the thread (it fails here), and the app list follows
    await app.page.evaluate(() => window.__held.splice(0).forEach((entry) => handlePromiseMessage(entry.id, 'reject', -1)));
    await appListShown(app.page);
    const back = await take(app.page);
    assertBackInAppList(back.screen, JSON.stringify(back));
    assert.equal(afterRed.events.concat(back.events).indexOf('/launch'), -1, 'the PC never got the launch request');
    assert.deepEqual([back.snack, back.unhandled], [[], []]);
    assert.equal(await app.page.evaluate(() => window.__otherRequest), 'failed -1');
    // The PC never got it, so it holds no start of it, and the next start goes out at once
    assert.ok(!app.logs.some((line) => line.indexOf('its launch request was cancelled') >= 0 || line.indexOf('its launch request failed') >= 0));
    assert.equal(await app.page.evaluate(() => getHeldHostStartMs(api)), 0);
    const next = await nextStartWorks(app.page);
    assert.equal(next.streaming, true, JSON.stringify(next));
    assert.deepEqual(next.messages, ['Starting Cyberpunk 2077...']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the start once more after a held start (-300) whose resume request the PC never answers ends after the time limit', async () => {
  const app = await openWithPc();
  try {
    await app.page.evaluate(() => {
      const startStream = Module.startStream;
      let first = true;
      Module.startStream = function() {
        if (first) {
          // The PC answers the RTSP handshake of the first stream with the key of another start that it still holds
          first = false;
          window.__events.push('start request');
          setTimeout(() => handleMessage('streamTerminated: -300'), 20);
          return { type: 'resolve', ret: null };
        }
        return startStream.apply(this, arguments);
      };
      window.__plans['/resume'] = { kind: 'never' };
    });
    await startApp(app.page);
    // The start once more waits for the hold of the first start, then the PC holds its resume request
    await requestSent(app.page, '/resume');
    const retrying = await take(app.page);
    assert.deepEqual([retrying.screen.startScreen, retrying.screen.isInGame, retrying.events], [true, true, ['/launch', 'start request', '/resume']]);
    await appListShown(app.page, LIMIT_MS + 3000);
    const ended = await take(app.page);
    assertBackInAppList(ended.screen, JSON.stringify(ended));
    assert.deepEqual([ended.snack, ended.events, ended.unhandled], [[TIMEOUT_MESSAGE], ['cancelRequest'], []]);
    assert.ok(app.logs.some((line) => line.indexOf('its resume request was cancelled') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the start after quitting another app whose launch request the PC never answers ends after the time limit', async () => {
  const app = await openWithPc({ currentGame: 102 });
  try {
    await app.page.evaluate(() => {
      window.__plans['/launch'] = { kind: 'never' };
    });
    await startApp(app.page);
    // The PC runs another app: Continue quits it, and the start follows 3 seconds later
    await app.page.waitForFunction(() => document.querySelector('#quitAppDialog').open, null, { timeout: 5000 });
    await app.page.evaluate(() => $('#continueQuitApp').click());
    await app.page.waitForFunction(() => window.__events.indexOf('/launch') >= 0, null, { timeout: 10000 });
    const waiting = await take(app.page);
    assert.deepEqual([waiting.screen.startScreen, waiting.screen.isInGame], [true, true], JSON.stringify(waiting));
    await appListShown(app.page, LIMIT_MS + 3000);
    const ended = await take(app.page);
    assertBackInAppList(ended.screen, JSON.stringify(ended));
    assert.deepEqual([ended.snack, ended.events, ended.unhandled], [[TIMEOUT_MESSAGE], ['cancelRequest'], []]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a start once more that finds the PC no longer paired, or Moonlight in the background, ends its launch screen', async () => {
  const app = await openWithPc();
  try {
    // No video arrived, and the retry finds the PC no longer paired: before 2.3.2 its launch screen stayed until RED
    await startStream(app.page);
    await app.page.evaluate(() => {
      handleMessage('streamTerminated: -100');
      streamLaunchHost.paired = false;
    });
    await app.page.waitForFunction(() => isInGame === false && !$('#loadingSpinner').is(':visible') && !$('#wasmSpinner').is(':visible'),
      null, { timeout: 5000 });
    const unpaired = await take(app.page);
    assert.deepEqual([unpaired.screen.startScreen, unpaired.screen.video, unpaired.unhandled], [false, false, []], JSON.stringify(unpaired));
    assert.deepEqual(unpaired.snack, ['No video received from the PC. Check the host PC\'s firewall and port forwarding rules.']);
    assert.ok(app.logs.some((line) => line.indexOf('The stream can\'t be started once more: the host is not paired') >= 0));

    // Moonlight goes to the background before the retry starts, here without the event of the change, which ends a start
    // by itself (endStreamInBackground())
    await app.page.evaluate(() => {
      api.paired = true;
    });
    await appListShown(app.page);
    await startStream(app.page);
    await app.page.evaluate(() => {
      handleMessage('streamTerminated: -100');
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    });
    await app.page.waitForFunction(() => isInGame === false && !$('#loadingSpinner').is(':visible'), null, { timeout: 5000 });
    await app.page.evaluate(() => {
      delete document.visibilityState;
    });
    await appListShown(app.page);
    const hidden = await take(app.page);
    assertBackInAppList(hidden.screen, JSON.stringify(hidden));
    assert.deepEqual([hidden.snack, hidden.unhandled], [[], []]);
    assert.ok(app.logs.some((line) => line.indexOf('Not starting app 101 while Moonlight is in the background') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the launch screen names RETURN and RED to cancel, inside the screen and apart from the message, in every language', async () => {
  const languages = fs.readdirSync(path.join(REPO_ROOT, 'wasm/static/locales')).filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
  const app = await openWithPc();
  const { page } = app;
  try {
    // The launch screen stays for the whole test (LONG_LIMIT_MS)
    await setLimit(page, LONG_LIMIT_MS);
    await page.evaluate(() => {
      window.__plans['/launch'] = { kind: 'never' };
    });
    await startApp(page);
    await page.waitForFunction(() => $('#loadingSpinner').is(':visible'));
    for (const code of languages) {
      const texts = code === 'en-US' ? null : JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales', code + '.json'), 'utf8'));
      const tr = (key) => (texts ? texts[key] : key);
      await page.evaluate((language) => window.i18n.applyLanguagePreference(language), code);
      await page.waitForFunction((cancel) => $('#launch-hints').text().indexOf(cancel) >= 0, tr('Cancel'), { timeout: 3000 });
      // The longest line under the bar: the countdown of a held start
      await page.evaluate((message) => $('#loadingSpinnerMessage').text(message.replace('%1$s', '11')), tr('Waiting for the PC to release the previous start (%1$s s)...'));
      await forEachTextWidth(page, async (stress) => {
        const box = await page.evaluate(() => {
          const rect = (element) => element.getBoundingClientRect();
          const hint = rect(document.querySelector('#launch-hints .hint'));
          const caps = Array.prototype.map.call(document.querySelectorAll('#launch-hints .keycap'), (cap) => ({ text: cap.textContent, top: rect(cap).top }));
          return {
            text: document.querySelector('#launch-hints .hint').textContent,
            caps,
            hint: { left: hint.left, right: hint.right, top: hint.top, bottom: hint.bottom, height: hint.height },
            message: rect(document.getElementById('loadingSpinnerMessage')).bottom,
            poster: rect(document.getElementById('launch-poster')).bottom,
            width: innerWidth,
            height: innerHeight,
          };
        });
        const message = code + stress + ' ' + JSON.stringify(box);
        assert.deepEqual(box.caps.map((cap) => cap.text), ['RETURN', tr('RED')], message);
        assert.equal(box.text, 'RETURN' + tr('RED') + tr('Cancel'), message);
        // Inside the safe area (96 px from each side), on one line, below the message and the poster
        assert.ok(box.hint.left >= 96 && box.hint.right <= box.width - 96 && box.hint.bottom <= box.height, message);
        assert.ok(box.hint.height <= 44, message);
        assert.ok(box.hint.top >= box.message + 24 && box.hint.top >= box.poster + 24, message);
      });
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
