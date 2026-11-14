'use strict';

// Checks the end of a launch whose start request the WebAssembly module didn't take (endLaunchAfterFailedStartRequest()
// in wasm/platform/index.js, the handler of both start requests of startGame()). Embind throws for an argument of the
// wrong type or a wrong number of arguments (startStream() of wasm/main.cpp takes 33), which is what a change of only
// one side of the call looks like on the TV; sendMessage() of messages.js turns that into a rejected promise. Nobody
// handled it: the launch screen stayed on 'Starting ...' for good, since no stream started that could end, and only RED
// left it. Now the app returns to the app list with a message that points to the diagnostic log, which holds the error,
// the host is remembered as holding the start that it accepted, and the next start works.
// The same for the start once more that the app makes on its own: the silent retry after a stream without video
// (retryStreamStart()) and the reconnect of the Stream Menu after a change of the settings
// (resumeStreamAfterSettingsChange()), which reach the handler with the launch state set again.
// It also checks, in the real page, that an uncaught error and an unhandled promise rejection reach the diagnostic log
// (DiagnosticLog.captureUncaught() of wasm/platform/diagnostics.js; tests/unit/diagnostics.test.js has the details): the
// browser reports both without a call of console.error, so they left no trace in the log.
// The host is simulated in the page, and the stub of the WebAssembly module is made to throw.

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

const MESSAGE = 'Unable to start the stream. The reason is in the diagnostic log (Settings, About).';
const MESSAGE_DE = 'Der Stream konnte nicht gestartet werden. Der Grund steht im Diagnoseprotokoll (Einstellungen, Info).';

// Open the app with a simulated host that answers the launch and resume requests at once, and record its requests,
// the start requests, showApps() and the snackbar messages in window.__events. window.failStart says how the start
// request of the module fails: 'throw' like Embind does, 'reject' with a rejected result, or not at all. The hold of a
// start that the host accepted lasts 300 ms instead of 11 s. The options are those of openApp().
async function openWithHost(options) {
  const app = await openApp(harness, Object.assign({ tv: { tv: 's90c', conn: 'wifi' } }, options));
  await app.page.evaluate(() => {
    HOST_START_HOLD_MS = 300;
    window.__events = [];
    const record = (event) => window.__events.push(event);
    const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
    const host = {
      paired: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null),
      launchApp: (appId) => {
        record('launch');
        host.currentGame = appId;
        return Promise.resolve(ok);
      },
      resumeApp: () => {
        record('resume');
        return Promise.resolve(ok);
      },
      toString: () => 'GAMING-PC',
    };
    window.__host = host;
    api = host;
    window.failStart = 'throw';
    Module.startStream = function() {
      record('start request with ' + arguments.length + ' arguments');
      if (window.failStart === 'throw') {
        // What Embind throws when an argument has the wrong type
        const error = new Error('Cannot pass "undefined" as a int');
        error.name = 'BindingError';
        throw error;
      }
      if (window.failStart === 'reject') {
        return { type: 'reject', ret: 'the module is busy' };
      }
      return { type: 'resolve', ret: null };
    };
    Module.stopStream = () => {
      record('stop');
      return { type: 'resolve', ret: null };
    };
    showApps = () => {
      record('app list');
      return Promise.resolve();
    };
    document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => record('message: ' + data.message);
    window.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Wait until the app list shows again, for 2 s at most
    window.backInAppList = async () => {
      for (let i = 0; i < 200 && window.__events.indexOf('app list') < 0; i++) {
        await window.wait(10);
      }
    };
    window.screen_ = () => ({
      isInGame, wasmSessionStarted,
      spinner: $('#loadingSpinner').is(':visible'),
      spinnerMessage: $('#loadingSpinnerMessage').text(),
      video: $('#wasm_module').is(':visible'),
      heartbeat: JSON.parse(localStorage.getItem('moonlightStreamHeartbeat') || '{}').state,
    });
    // The lines of the current session of the diagnostic log, without their time
    window.logLines = () => {
      const sessions = DiagnosticLog.getSessions();
      return sessions[sessions.length - 1].lines.map((line) => line.replace(/^\d\d:\d\d:\d\d\.\d{3} (native|app {3}) /, ''));
    };
  });
  return app;
}

const ENDED = { isInGame: false, wasmSessionStarted: false, spinner: false, spinnerMessage: '', video: false, heartbeat: 'idle' };

test('a start request that throws after the launch request returns to the app list with a message', async () => {
  const app = await openWithHost();
  try {
    const run = await app.page.evaluate(async () => {
      startGame(window.__host, 7);
      await window.backInAppList();
      const heldMs = getHeldHostStartMs(window.__host);
      await window.wait(400);
      return { events: window.__events.splice(0), screen: window.screen_(), log: window.logLines(), heldMs };
    });
    // The module got the start request, which threw: the message, then the app list, and nothing after it
    assert.deepEqual(run.events, ['launch', 'start request with 33 arguments', 'message: ' + MESSAGE, 'app list']);
    // Before, the launch screen stayed with 'Starting Game 7...' and both flags set
    assert.deepEqual(run.screen, ENDED);
    // The diagnostic log, which the message points to, has the error of the module at level E
    const errorLine = run.log.filter((line) => line.indexOf('The start request to the WASM module failed') >= 0);
    assert.deepEqual(errorLine, ['E [index.js, startGame] Error: The start request to the WASM module failed, so no stream started. ' +
      'Returned error was: BindingError: Cannot pass "undefined" as a int']);
    // The host accepted the launch, so it may hold this start, which the next start waits for
    assert.ok(run.heldMs > 0 && run.heldMs <= 300, String(run.heldMs));
    assert.ok(app.logs.some((line) => line.indexOf('GAMING-PC may hold a start of this TV') >= 0 && line.indexOf('a start it accepted was cancelled') >= 0));
    // The rejection is handled: the browser reports no unhandled promise rejection
    assert.deepEqual(app.errors, []);

    // The next start works (the app runs on the host since the launch, so it is resumed)
    const next = await app.page.evaluate(async () => {
      window.failStart = '';
      startGame(window.__host, 7);
      await window.wait(700);
      handleMessage('ControlStreamConnected');
      handleMessage('Connection Established');
      return { events: window.__events.splice(0), screen: window.screen_() };
    });
    assert.deepEqual(next.events, ['resume', 'start request with 33 arguments']);
    assert.deepEqual([next.screen.isInGame, next.screen.wasmSessionStarted, next.screen.spinner, next.screen.video, next.screen.heartbeat],
      [true, true, false, true, 'streaming']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a start request that throws after the resume request returns to the app list with a message', async () => {
  const app = await openWithHost({ tv: { tv: 's90c', conn: 'wifi', locale: 'de_DE' } });
  try {
    const run = await app.page.evaluate(async () => {
      // The app already runs on the host, so the start resumes it
      window.__host.currentGame = 7;
      startGame(window.__host, 7);
      await window.backInAppList();
      const heldMs = getHeldHostStartMs(window.__host);
      await window.wait(400);
      return { events: window.__events.splice(0), screen: window.screen_(), log: window.logLines(), heldMs };
    });
    // In the language of the app
    assert.deepEqual(run.events, ['resume', 'start request with 33 arguments', 'message: ' + MESSAGE_DE, 'app list']);
    assert.deepEqual(run.screen, ENDED);
    assert.equal(run.log.filter((line) => /^E \[index\.js, startGame\] Error: The start request to the WASM module failed.*BindingError: Cannot pass "undefined" as a int$/.test(line)).length, 1);
    assert.ok(run.heldMs > 0, String(run.heldMs));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a start request that the module rejects ends the launch the same way, for the launch and the resume request', async () => {
  const app = await openWithHost();
  try {
    const run = await app.page.evaluate(async () => {
      window.failStart = 'reject';
      startGame(window.__host, 7);
      await window.wait(400);
      const launched = { events: window.__events.splice(0), screen: window.screen_(), log: window.logLines() };
      // Once more after the hold of the host: the app runs there now, so this start resumes it
      await window.wait(300);
      startGame(window.__host, 7);
      await window.wait(400);
      return { launched, resumed: { events: window.__events.splice(0), screen: window.screen_(), log: window.logLines() } };
    });
    assert.deepEqual(run.launched.events, ['launch', 'start request with 33 arguments', 'message: ' + MESSAGE, 'app list']);
    assert.deepEqual(run.launched.screen, ENDED);
    assert.deepEqual(run.resumed.events, ['resume', 'start request with 33 arguments', 'message: ' + MESSAGE, 'app list']);
    assert.deepEqual(run.resumed.screen, ENDED);
    // Each start has its session of the log, with its error
    [run.launched.log, run.resumed.log].forEach((log) => {
      assert.equal(log.filter((line) => /^E .*The start request to the WASM module failed.*Returned error was: the module is busy$/.test(line)).length, 1);
    });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a start request that throws during the silent retry or the reconnect of the Stream Menu ends the start the same way', async () => {
  const app = await openWithHost();
  try {
    const run = await app.page.evaluate(async () => {
      STREAM_RETRY_DELAY_MS = 100;
      SETTINGS_RESTART_DELAY_MS = 100;
      const runs = {};
      // A stream starts, and no video arrives: the module ends it with -100, which the app retries once, and that start
      // request throws
      window.failStart = '';
      startGame(window.__host, 7);
      await window.wait(400);
      handleMessage('ControlStreamConnected');
      window.failStart = 'throw';
      handleMessage('streamTerminated: -100');
      await window.backInAppList();
      await window.wait(400);
      runs.retry = { events: window.__events.splice(0), screen: window.screen_() };

      // A stream runs, and the Stream Menu changes the bitrate, which reconnects it with a start request that throws
      window.failStart = '';
      startGame(window.__host, 7);
      await window.wait(700);
      handleMessage('ControlStreamConnected');
      handleMessage('Connection Established');
      window.failStart = 'throw';
      runs.restarting = restartStreamWithSettings({ bitrateMbps: 50 });
      handleMessage('streamTerminated: 0');
      await window.backInAppList();
      await window.wait(400);
      runs.reconnect = { events: window.__events.splice(0), screen: window.screen_() };
      return runs;
    });
    assert.deepEqual(run.retry.events, ['launch', 'start request with 33 arguments', 'resume', 'start request with 33 arguments',
      'message: ' + MESSAGE, 'app list']);
    assert.deepEqual(run.retry.screen, ENDED);
    assert.equal(run.restarting, true);
    assert.deepEqual(run.reconnect.events, ['resume', 'start request with 33 arguments', 'stop', 'resume',
      'start request with 33 arguments', 'message: ' + MESSAGE, 'app list']);
    assert.deepEqual(run.reconnect.screen, ENDED);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the failure of a start request whose launch is over already shows nothing more', async () => {
  const app = await openWithHost();
  try {
    const run = await app.page.evaluate(async () => {
      // The launch ends while the start request runs (as RED does between two steps of a start), then the request throws
      const throwing = Module.startStream;
      Module.startStream = function() {
        cancelStreamLaunch();
        return throwing.apply(this, arguments);
      };
      startGame(window.__host, 7);
      await window.wait(400);
      return { events: window.__events.splice(0), screen: window.screen_(), log: window.logLines() };
    });
    // One return to the app list, from the cancelled launch, and no message
    assert.deepEqual(run.events, ['launch', 'start request with 33 arguments', 'app list']);
    assert.deepEqual(run.screen, ENDED);
    // The error is still in the log
    assert.equal(run.log.filter((line) => line.indexOf('The start request to the WASM module failed') >= 0).length, 1);
    assert.equal(run.log.filter((line) => line.indexOf('The launch of the failed start request is over already.') >= 0).length, 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('an uncaught error and an unhandled promise rejection of the page reach the diagnostic log', async () => {
  const app = await openWithHost();
  try {
    const lines = await app.page.evaluate(async () => {
      console.error('a line of console.error');
      // An error in a timer, and a promise that nobody handles
      setTimeout(() => {
        const host = {};
        host.refreshServerInfo();
      }, 0);
      Promise.reject(new RangeError('nobody handles this'));
      Promise.reject(-1);
      // The same error many times, as in a handler that runs for every frame
      for (let i = 0; i < 300; i++) {
        setTimeout(() => {
          throw new Error('every frame');
        }, 0);
      }
      await window.wait(500);
      return window.logLines();
    });
    const own = lines.filter((line) => /a line of console\.error|^E Uncaught|^E Unhandled|more uncaught errors/.test(line));
    assert.equal(own.length, 6, own.join('\n'));
    const count = (pattern) => own.filter((line) => pattern.test(line)).length;
    assert.equal(own[0], 'E a line of console.error');
    // The message of the browser with the script, line and column (the browser decides in which order they come)
    assert.equal(count(/^E Uncaught TypeError: host\.refreshServerInfo is not a function( \(.*:\d+:\d+\))?$/), 1, own.join('\n'));
    assert.equal(count(/^E Unhandled promise rejection: RangeError: nobody handles this( \(.*:\d+:\d+\))?$/), 1, own.join('\n'));
    assert.equal(count(/^E Unhandled promise rejection: -1$/), 1, own.join('\n'));
    // Once, with the number of the others at the end
    assert.equal(count(/^E Uncaught Error: every frame( \(.*:\d+:\d+\))?$/), 1, own.join('\n'));
    assert.equal(own[5], '… 299 more uncaught errors or unhandled promise rejections are not kept (the same ones again, or more than 20 different ones in this session)');
    // The log only reads them: the browser still reports each one
    assert.equal(app.errors.length, 303, app.errors.slice(0, 5).join(' | '));

    // The dialog of the log (Settings, About) shows them
    const shown = await app.page.evaluate(() => {
      showDiagnosticLog();
      const text = document.getElementById('diagnosticLogText').textContent;
      closeDiagnosticLog();
      return text;
    });
    assert.ok(shown.indexOf('E Uncaught TypeError: host.refreshServerInfo is not a function') > 0);
    assert.ok(shown.indexOf('E Unhandled promise rejection: RangeError: nobody handles this') > 0);
  } finally {
    await app.context.close();
  }
});
