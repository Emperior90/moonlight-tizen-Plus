'use strict';

// Pins the start and end of a stream in the UI (from the earlier rounds of fixes): RED during the start cancels it and
// a late launch reply starts nothing, RED stops a running stream once, deep links and host selection are ignored while
// streaming, and an abort or crashed thread of the WebAssembly module leaves the stream view and offers a restart.
// The host is simulated in the page; the stub of the WebAssembly module records the start request.

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

// Install a simulated host whose launch reply the test releases by hand, and a RED key press helper
function installFakeHost(page) {
  return page.evaluate(() => {
    window.setupHost = () => {
      window.__calls = { stop: 0, refresh: 0, showApps: 0 };
      window.__origStop = Module.stopStream;
      Module.stopStream = () => {
        window.__calls.stop++;
        return { type: 'resolve', ret: null };
      };
      window.__origShowApps = showApps;
      showApps = () => {
        window.__calls.showApps++;
        return Promise.resolve();
      };
      window.__launch = null;
      window.__host = {
        paired: true, serverUid: 'HOST1', address: '10.0.0.2', httpPort: 47989, currentGame: 0, appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
        refreshServerInfo() {
          window.__calls.refresh++;
          return Promise.resolve();
        },
        getAppById(id) {
          return Promise.resolve({ id: id, title: 'Game ' + id });
        },
        launchApp() {
          return new Promise((resolve, reject) => {
            window.__launch = { resolve, reject };
          });
        },
        resumeApp() {
          return new Promise((resolve, reject) => {
            window.__launch = { resolve, reject };
          });
        },
      };
      window.__ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
    };
    window.teardownHost = () => {
      Module.stopStream = window.__origStop;
      showApps = window.__origShowApps;
    };
    window.red = (repeat) => remoteControllerHandler({ keyCode: tvKey.KEY_RED, repeat: !!repeat, preventDefault() {} });
  });
}

// Open the app on the S90C over Wi-Fi with the simulated host helpers installed
async function openWithFakeHost() {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  await installFakeHost(app.page);
  return app;
}

test('RED during the start cancels it, and the late launch reply starts no stream', async () => {
  const app = await openWithFakeHost();
  try {
    const cancel = await app.page.evaluate(async () => {
      setupHost();
      window.__startStreamArgs = null;
      startGame(window.__host, 7);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const starting = { isInGame, wasmSessionStarted };
      red();
      const afterRed = { isInGame, spinner: $('#loadingSpinner').css('display'), stop: window.__calls.stop, loading: $('#wasmSpinner').css('display') + ':' + $('#wasmSpinnerMessage').text() };
      window.__launch.resolve(window.__ok);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const late = { started: window.__startStreamArgs !== null, isInGame };
      teardownHost();
      return { starting, afterRed, late, showApps: window.__calls.showApps };
    });
    assert.deepEqual(cancel.starting, { isInGame: true, wasmSessionStarted: false }, 'the stream view shows while starting, the start request is not sent yet');
    assert.equal(cancel.afterRed.isInGame, false);
    assert.equal(cancel.afterRed.spinner, 'none');
    assert.equal(cancel.afterRed.stop, 0, 'no session to stop yet');
    assert.ok(cancel.afterRed.loading.indexOf('none') !== 0 && cancel.afterRed.loading.indexOf(':Loading Apps...') > 0, cancel.afterRed.loading);
    assert.deepEqual(cancel.late, { started: false, isInGame: false });
    assert.ok(cancel.showApps >= 1, 'back to the app list');
    assert.ok(app.logs.some((line) => line.indexOf('Cancelling the start of the stream') >= 0));
    assert.ok(app.logs.some((line) => line.indexOf('Ignoring the reply to a cancelled launch request') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a started stream sends the start request, RED stops it once, and a late connection keeps the video hidden', async () => {
  const app = await openWithFakeHost();
  try {
    const run = await app.page.evaluate(async () => {
      setupHost();
      window.__startStreamArgs = null;
      startGame(window.__host, 8);
      await new Promise((resolve) => setTimeout(resolve, 100));
      window.__launch.resolve(window.__ok);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const started = { started: window.__startStreamArgs !== null, wasmSessionStarted, isInGame };
      // A second start while streaming (e.g. a deep link) is ignored
      const refreshBefore = window.__calls.refresh;
      startGame(window.__host, 9);
      const secondIgnored = window.__calls.refresh === refreshBefore;
      red(true);
      const afterRepeat = window.__calls.stop;
      red();
      const afterRed = window.__calls.stop;
      // The module posts streamTerminated synchronously inside stopStream
      handleMessage('streamTerminated: 0');
      const ended = { isInGame, wasmSessionStarted };
      red();
      const afterEnd = window.__calls.stop;
      $('#wasm_module').css('display', 'none');
      handleMessage('Connection Established');
      const lateConnection = $('#wasm_module').css('display');
      await new Promise((resolve) => setTimeout(resolve, 100));
      teardownHost();
      return { started, secondIgnored, afterRepeat, afterRed, ended, afterEnd, lateConnection };
    });
    assert.deepEqual(run.started, { started: true, wasmSessionStarted: true, isInGame: true });
    assert.equal(run.secondIgnored, true, 'a second start while streaming is ignored');
    assert.equal(run.afterRepeat, 0, 'the auto-repeat of RED is ignored');
    assert.equal(run.afterRed, 1, 'RED stops the session once');
    assert.deepEqual(run.ended, { isInGame: false, wasmSessionStarted: false });
    assert.equal(run.afterEnd, 1, 'RED after the end does nothing');
    assert.equal(run.lateConnection, 'none');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// The arguments of the start request, in the order of startGame() and SyncFunctions.startRequest (messages.js)
const START_REQUEST_FIELDS = ['host', 'httpPort', 'width', 'height', 'frameRate', 'bitrateKbps', 'rikey', 'rikeyid', 'appVersion',
  'gfeVersion', 'rtspUrl', 'codecModes', 'framePacing', 'optimizeGames', 'rumbleFeedback', 'mouseEmulation', 'flipABfaceButtons',
  'flipXYfaceButtons', 'audioBackend', 'audioConfig', 'audioSync', 'audioJitter', 'playHostAudio', 'decryptHostAudio', 'videoCodec',
  'hdrMode', 'fullRange', 'gameMode', 'disableWarnings', 'performanceStats', 'refFrameInvalidation', 'hdrMetadata'];

test('S90C: the start request of a fresh install carries the golden video settings', async () => {
  for (const [conn, bitrateKbps] of [['ethernet', '75000'], ['wifi', '100000'], ['unknown', '80000']]) {
    const app = await openApp(harness, { tv: { tv: 's90c', conn } });
    try {
      await installFakeHost(app.page);
      const args = await app.page.evaluate(async () => {
        setupHost();
        window.__startStreamArgs = null;
        startGame(window.__host, 8);
        await new Promise((resolve) => setTimeout(resolve, 100));
        window.__launch.resolve(window.__ok);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const startArgs = window.__startStreamArgs;
        handleMessage('streamTerminated: 0');
        teardownHost();
        return startArgs;
      });
      assert.ok(Array.isArray(args) && args.length === START_REQUEST_FIELDS.length, 'the start request was sent with every argument');
      const request = {};
      START_REQUEST_FIELDS.forEach((field, index) => {
        request[field] = args[index];
      });
      // The random input keys differ on every start
      delete request.rikey;
      delete request.rikeyid;
      assert.deepEqual(request, {
        host: '10.0.0.2', httpPort: 47989, width: '3840', height: '2160', frameRate: '60', bitrateKbps,
        appVersion: '7.1.431.-1', gfeVersion: '', rtspUrl: 'rtsp://10.0.0.2:48010', codecModes: 0x1F03,
        framePacing: 1, optimizeGames: 0, rumbleFeedback: 0, mouseEmulation: 0, flipABfaceButtons: 0, flipXYfaceButtons: 0,
        audioBackend: 'EMSS', audioConfig: 'Stereo', audioSync: 0, audioJitter: 100, playHostAudio: 0, decryptHostAudio: 0,
        videoCodec: 'HEVC', hdrMode: 1, fullRange: 0, gameMode: 0, disableWarnings: 0, performanceStats: 0, refFrameInvalidation: 0,
        hdrMetadata: 0,
      }, conn);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('a failed reply of a cancelled launch does not return to the app list again', async () => {
  const app = await openWithFakeHost();
  try {
    const failed = await app.page.evaluate(async () => {
      setupHost();
      startGame(window.__host, 10);
      await new Promise((resolve) => setTimeout(resolve, 100));
      red();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const shown = window.__calls.showApps;
      window.__launch.reject('timeout');
      await new Promise((resolve) => setTimeout(resolve, 300));
      teardownHost();
      return { shown, after: window.__calls.showApps };
    });
    assert.equal(failed.after, failed.shown);
  } finally {
    await app.context.close();
  }
});

test('deep links and host selection are ignored while streaming', async () => {
  const app = await openWithFakeHost();
  try {
    const deep = await app.page.evaluate(() => {
      const calls = { nav: 0 };
      const originalNavigate = waitForHostAndNavigateToApp;
      waitForHostAndNavigateToApp = () => {
        calls.nav++;
      };
      const originalSupported = _isSmartHubSupported;
      _isSmartHubSupported = true;
      const originalApp = tizen.application.getCurrentApplication;
      const payload = (uid, appId) => ({ getRequestedAppControl: () => ({ appControl: { data: [{ key: 'PAYLOAD', value: [JSON.stringify({ values: JSON.stringify({ serverUid: uid, appId: appId }) })] }] } }) });
      isInGame = true;
      streamLaunchHost = { serverUid: 'HOST1' };
      localStorage.setItem('lastOpenedApp_HOST1', '8');
      tizen.application.getCurrentApplication = () => payload('HOST1', 9);
      handleDeepLink();
      tizen.application.getCurrentApplication = () => payload('HOST1', 8);
      handleDeepLink();
      const opening = isHostOpening;
      hostChosen({ serverUid: 'HOST1' });
      const hostOpeningAfter = isHostOpening;
      isInGame = false;
      streamLaunchHost = null;
      tizen.application.getCurrentApplication = originalApp;
      _isSmartHubSupported = originalSupported;
      waitForHostAndNavigateToApp = originalNavigate;
      return { nav: calls.nav, opening, hostOpeningAfter };
    });
    assert.equal(deep.nav, 0, 'no navigation while streaming');
    assert.equal(app.logs.filter((line) => line.indexOf('Stop the current stream first (RED button).') >= 0).length, 1, 'a hint only for another app');
    assert.equal(deep.opening, false);
    assert.equal(deep.hostOpeningAfter, false, 'the host selection leaves no opening flag set');
  } finally {
    await app.context.close();
  }
});

test('an abort or a crashed thread of the module is reported after the hook returned, other stderr is not', async () => {
  const app = await openWithFakeHost();
  try {
    const hooks = await app.page.evaluate(async () => {
      const got = [];
      const original = window.onNativeModuleFailure;
      window.onNativeModuleFailure = (details) => got.push(details);
      Module.onAbort('OOM');
      Module.printErr('Thread 3: some message');
      Module.printErr('pthread sent an error! moonlight-wasm.worker.js:1: RuntimeError: unreachable');
      const sync = got.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      window.onNativeModuleFailure = original;
      return { sync, got };
    });
    assert.equal(hooks.sync, 0);
    assert.deepEqual(hooks.got.map((details) => details.slice(0, 22)), ['abort(OOM)', 'pthread sent an error!']);
  } finally {
    await app.context.close();
  }
});

test('a module failure leaves the stream view without calling the module, and restarts once the dialog closes', async () => {
  const app = await openWithFakeHost();
  try {
    const failure = await app.page.evaluate(async () => {
      const calls = { stop: 0, restart: 0 };
      const originalStop = Module.stopStream;
      Module.stopStream = () => {
        calls.stop++;
      };
      const originalRestart = restartApplication;
      restartApplication = () => {
        calls.restart++;
      };
      showStreamMode();
      onNativeModuleFailure('abort(OOM)');
      const title = $('#warningDialogTitle').text();
      const state = { isInGame, fullscreen: $('#listener').hasClass('fullscreen'), video: $('#wasm_module').css('display') };
      onNativeModuleFailure('abort(again)');
      $('#closeWarning').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      Module.stopStream = originalStop;
      restartApplication = originalRestart;
      return { title, state, calls };
    });
    assert.deepEqual(failure.state, { isInGame: false, fullscreen: false, video: 'none' });
    assert.equal(failure.calls.stop, 0);
    assert.equal(failure.title, 'Streaming engine error');
    assert.equal(failure.calls.restart, 1);
    assert.equal(app.logs.filter((line) => line.indexOf('The streaming engine failed') >= 0).length, 1, 'handled once');
  } finally {
    await app.context.close();
  }
});

test('a player error during the stream (-201) shows its message, and hiding the app is logged with its duration', async () => {
  const app = await openWithFakeHost();
  try {
    await app.page.evaluate(() => {
      const originalApi = api;
      api = { refreshServerInfo: () => new Promise(() => {}) };
      handleMessage('streamTerminated: -201');
      api = originalApi;
    });
    assert.ok(app.logs.some((line) => line.indexOf('The video player of the TV stopped with an error during the stream') >= 0));
    await app.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await app.page.waitForTimeout(120);
    await app.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.ok(app.logs.some((line) => line.indexOf('The page is now hidden') >= 0));
    assert.ok(app.logs.some((line) => /The page is now visible .* after being hidden for \d+ ms/.test(line)));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
