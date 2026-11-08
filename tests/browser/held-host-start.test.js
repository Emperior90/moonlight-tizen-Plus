'use strict';

// Checks the start of a stream while the host may still hold an earlier start (wasm/platform/index.js:
// rememberHeldHostStart(), waitForHeldHostStart(), retryStreamStart() with STREAM_RESTART_HELD_START; messages.js).
// Sunshine keeps the launch session of one start until its control stream connects or ping_timeout runs out (10 s by
// default). Meanwhile it drops the session of every other /launch or /resume while it answers the request with
// success, and the RTSP handshake of that start then fails, since the host checks and answers it with the key of the
// start it holds ('Failed to verify RTSP message tag' in its log). The TV sees an answer that it can't decrypt
// (ML_ERROR_RTSP_DECRYPT_FAILED, error -300, of the local patch of moonlight-common-c, which
// tests/native/rtsp_decrypt_error_test.c runs; wasm/connectionlistener.cpp shows no dialog with the ports for it,
// tests/native/connection_interrupt_test.cpp). So a start waits, with a countdown on the launch screen, while the host
// may still hold a start of this TV that never connected: one that was cancelled after or while the host accepted it,
// one whose stream ended before it connected, and one whose request failed on the TV. A stream that connected releases
// its start, so the reconnects of the Stream Menu and the retry after no video don't wait. A start that the host still
// dropped (e.g. for another device) starts once more without a word after the hold, and only a second failure shows
// a message, the one about the held start instead of the ports of the handshake.
// The page holds a simulated Sunshine that keeps its launch sessions that way, with one thread for the requests, as the
// HTTPS server of Sunshine and the HTTP thread of the module have, and a stub of the module whose start request runs the
// handshake against it. The times are scaled down: ping_timeout 1000 ms, the hold that the app waits for 1100 ms (11 s
// in the app), the delays before a retry and a reconnect 100 ms.

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

const HELD_START_MESSAGE = 'The PC is still holding an earlier start, e.g. from another device. Wait a few seconds and start again.';
const COUNTDOWN = /^Waiting for the PC to release the previous start \(\d s\)\.\.\.$/;

// Open the app with the simulated Sunshine. window.__events records what the TV and the host did, with the time
// (performance.now()), window.__screens every text of the launch screen while a stream starts.
async function openWithSunshine() {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  await app.page.evaluate(() => {
    HOST_START_HOLD_MS = 1100;
    STREAM_RETRY_DELAY_MS = 100;
    SETTINGS_RESTART_DELAY_MS = 100;
    window.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    window.__events = [];
    const record = (event) => window.__events.push({ at: performance.now(), event });
    // The launch session state of Sunshine (src/rtsp.cpp): one pending session with the key of its request, which a
    // timer drops after ping_timeout and the connect of its control stream clears
    const sunshine = { pending: null, raisedAt: 0, runningApp: 0, queue: Promise.resolve(), failRequests: false, serverInfoMs: 10 };
    window.__sunshine = sunshine;
    const viewPending = () => {
      if (sunshine.pending && performance.now() - sunshine.raisedAt >= sunshine.pending.timeoutMs) {
        sunshine.pending = null;
      }
      return sunshine.pending;
    };
    const raise = (key, timeoutMs) => {
      if (viewPending()) {
        return false;
      }
      sunshine.pending = { key: key, timeoutMs: timeoutMs || 1000 };
      sunshine.raisedAt = performance.now();
      return true;
    };
    // Another device starts a stream on the PC and never connects (its session stays for timeoutMs)
    window.otherDeviceStarts = (timeoutMs) => raise('another device', timeoutMs);
    // One thread runs the requests one after the other
    const thread = (fn) => {
      const result = sunshine.queue.then(fn);
      sunshine.queue = result.catch(() => {});
      return result;
    };
    const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtspenc://10.0.0.2:48010</sessionUrl0></root>';
    const request = (what, ms, rikey, appId) => {
      record('tv: /' + what);
      return thread(async () => {
        await window.wait(ms);
        if (sunshine.failRequests) {
          record('tv: /' + what + ' failed');
          throw -1;
        }
        if (appId) {
          sunshine.runningApp = appId;
        }
        record('host: /' + what + (raise(rikey) ? ' raised its session' : ' dropped its session'));
        return ok;
      });
    };
    const host = {
      paired: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => thread(async () => {
        await window.wait(sunshine.serverInfoMs);
        host.currentGame = sunshine.runningApp;
      }),
      getAppById: (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null),
      launchApp: (appId, mode, sops, rikey) => request('launch', 300, rikey, appId),
      resumeApp: (mode, sops, rikey) => request('resume', 200, rikey),
      toString: () => 'GAMING-PC',
    };
    window.__host = host;
    api = host;
    // The start request runs the RTSP handshake with its key (argument 6) 50 ms later, or when the test lets it
    // (window.__connect = 'hold'), as the module does: an answer with the key of another start ends it with -300 and no
    // dialog, no session at all with the dialog of the handshake and -1, and the key of the held start connects
    window.__connect = 'auto';
    Module.startStream = function() {
      const key = String(arguments[6]);
      record('tv: start request');
      const handshake = () => {
        const session = viewPending();
        if (!session) {
          record('host: no session');
          handleMessage('DialogMsg: RTSP handshake failed (error -1)');
          handleMessage('streamTerminated: -1');
        } else if (session.key !== key) {
          record('host: Failed to verify RTSP message tag');
          handleMessage('streamTerminated: -300');
        } else {
          sunshine.pending = null;
          record('host: connected');
          handleMessage('Connection Established');
        }
      };
      if (window.__connect === 'auto') {
        setTimeout(handshake, 50);
      } else {
        window.__handshake = handshake;
      }
      return { type: 'resolve', ret: null };
    };
    Module.stopStream = () => {
      record('tv: stop');
      window.__handshake = null;
      handleMessage('streamTerminated: 0');
      return { type: 'resolve', ret: null };
    };
    // The app list, which leaves the stream mode as showAppsMode() does
    showApps = () => {
      record('app list');
      isInGame = false;
      return Promise.resolve();
    };
    document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => record('message: ' + data.message);
    warningDialog = (title, text) => record('dialog: ' + title + ': ' + text);
    window.red = () => remoteControllerHandler({ keyCode: tvKey.KEY_RED, repeat: false, preventDefault() {} });
    window.__screens = [];
    new MutationObserver(() => {
      const text = $('#loadingSpinnerMessage').text();
      if (text && window.__screens[window.__screens.length - 1] !== text) {
        window.__screens.push(text);
      }
    }).observe(document.getElementById('loadingSpinnerMessage'), { childList: true, characterData: true, subtree: true });
    // The events as text, and the time of the first one that starts with a text, from a given index on
    window.names = () => window.__events.map((entry) => entry.event);
    window.timeOf = (prefix, from) => {
      const entry = window.__events.slice(from || 0).find((item) => item.event.indexOf(prefix) === 0);
      return entry ? entry.at : -1;
    };
  });
  return app;
}

test('RED while the host handles /launch, then a new start: it waits with a countdown until the host released the cancelled start, and connects', async () => {
  const app = await openWithSunshine();
  try {
    const run = await app.page.evaluate(async () => {
      startGame(window.__host, 7);
      // The host handles /launch (display setup, encoder probe), and the user cancels the start meanwhile
      await window.wait(100);
      red();
      await window.wait(20);
      // ... and starts it again at once: the request waits behind /launch, whose answer the TV ignores
      startGame(window.__host, 7);
      await window.wait(400);
      const waiting = { message: $('#loadingSpinnerMessage').text(), isInGame, wasmSessionStarted };
      await window.wait(1500);
      return {
        names: window.names(), screens: window.__screens.slice(), waiting, connected: isStreamConnected,
        answeredAt: window.timeOf('host: /launch'), resumedAt: window.timeOf('tv: /resume'),
      };
    });
    // The app list of the cancel shows after the refresh of the server info, which waits behind /launch
    assert.deepEqual(run.names, ['tv: /launch', 'host: /launch raised its session', 'app list', 'tv: /resume',
      'host: /resume raised its session', 'tv: start request', 'host: connected']);
    // The resume request goes out once the hold of the cancelled start is over, counted from its answer
    assert.ok(run.resumedAt - run.answeredAt >= 1095, 'resumed after ' + (run.resumedAt - run.answeredAt) + ' ms');
    assert.match(run.waiting.message, COUNTDOWN);
    assert.deepEqual([run.waiting.isInGame, run.waiting.wasmSessionStarted], [true, false]);
    // The launch screen counts down and then shows the start again
    const countdown = run.screens.filter((text) => COUNTDOWN.test(text));
    assert.ok(countdown.length >= 1, run.screens.join(' | '));
    assert.equal(run.screens[run.screens.length - 1], 'Starting Game 7...');
    assert.equal(run.connected, true);
    assert.ok(app.logs.some((line) => line.indexOf('GAMING-PC may hold a start of this TV for') >= 0 &&
      line.indexOf('it accepted a start that was cancelled') >= 0), 'the hold in the log');
    assert.ok(app.logs.some((line) => line.indexOf('Warning: GAMING-PC may still hold an earlier start of this TV, which would make it drop this one, waiting') >= 0), 'the wait in the log');
    assert.ok(app.logs.some((line) => line.indexOf('The hold of the earlier start on GAMING-PC is over, starting.') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RED after the host accepted the start, while the TV reads the codec modes again: the next start waits as well', async () => {
  const app = await openWithSunshine();
  try {
    const run = await app.page.evaluate(async () => {
      startGame(window.__host, 7);
      // The server info that refreshCodecModesBeforeStream() reads after the answer takes 400 ms
      await window.wait(50);
      window.__sunshine.serverInfoMs = 400;
      await window.wait(450);
      const cancelled = { answered: window.timeOf('host: /launch') > 0, wasmSessionStarted };
      red();
      window.__sunshine.serverInfoMs = 10;
      startGame(window.__host, 7);
      await window.wait(1600);
      return {
        cancelled, names: window.names(), screens: window.__screens.slice(), connected: isStreamConnected,
        answeredAt: window.timeOf('host: /launch'), resumedAt: window.timeOf('tv: /resume'),
      };
    });
    assert.deepEqual(run.cancelled, { answered: true, wasmSessionStarted: false });
    assert.deepEqual(run.names, ['tv: /launch', 'host: /launch raised its session', 'app list', 'tv: /resume',
      'host: /resume raised its session', 'tv: start request', 'host: connected']);
    assert.ok(run.resumedAt - run.answeredAt >= 1095, 'resumed after ' + (run.resumedAt - run.answeredAt) + ' ms');
    assert.ok(run.screens.some((text) => COUNTDOWN.test(text)), run.screens.join(' | '));
    assert.equal(run.connected, true);
    assert.ok(app.logs.some((line) => line.indexOf('a start it accepted was cancelled') >= 0));
    assert.ok(app.logs.some((line) => line.indexOf('Not starting the stream of a cancelled launch request.') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RED while the stream connects, after the host accepted its start: the next start waits as well', async () => {
  const app = await openWithSunshine();
  try {
    const run = await app.page.evaluate(async () => {
      window.__connect = 'hold';
      startGame(window.__host, 7);
      // /launch is answered and the start request sent, the connection is still being set up
      await window.wait(500);
      const connecting = { wasmSessionStarted, connected: isStreamConnected };
      red();
      window.__connect = 'auto';
      await window.wait(20);
      startGame(window.__host, 7);
      await window.wait(1900);
      return {
        connecting, names: window.names(), screens: window.__screens.slice(), connected: isStreamConnected,
        answeredAt: window.timeOf('host: /launch'), resumedAt: window.timeOf('tv: /resume'),
      };
    });
    assert.deepEqual(run.connecting, { wasmSessionStarted: true, connected: false });
    assert.deepEqual(run.names, ['tv: /launch', 'host: /launch raised its session', 'tv: start request', 'tv: stop',
      'app list', 'tv: /resume', 'host: /resume raised its session', 'tv: start request', 'host: connected']);
    assert.ok(run.resumedAt - run.answeredAt >= 1095, 'resumed after ' + (run.resumedAt - run.answeredAt) + ' ms');
    assert.ok(run.screens.some((text) => COUNTDOWN.test(text)), run.screens.join(' | '));
    assert.equal(run.connected, true);
    assert.ok(app.logs.some((line) => line.indexOf('the stream of a start it accepted ended before it connected') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stream that connected makes no start wait: the reconnect of the Stream Menu, the retry after no video and a new start go out at once', async () => {
  const app = await openWithSunshine();
  try {
    const run = await app.page.evaluate(async () => {
      startGame(window.__host, 7);
      await window.wait(500);
      const firstConnected = isStreamConnected;
      // The bitrate entry of the Stream Menu reconnects the stream (stop, then resume 100 ms later)
      const reconnectAt = performance.now();
      restartStreamWithSettings({ bitrateMbps: 50 });
      await window.wait(500);
      const reconnected = isStreamConnected;
      // No video arrives at the start of the stream: it starts once more 100 ms later
      const retryAt = performance.now();
      const retryFrom = window.__events.length;
      handleMessage('streamTerminated: -100');
      await window.wait(500);
      const retried = isStreamConnected;
      // The user stops the stream and starts it again at once
      red();
      const restartFrom = window.__events.length;
      const restartAt = performance.now();
      startGame(window.__host, 7);
      await window.wait(400);
      return {
        names: window.names(), screens: window.__screens.slice(), states: [firstConnected, reconnected, retried, isStreamConnected],
        reconnectGap: window.timeOf('tv: /resume') - reconnectAt,
        retryGap: window.timeOf('tv: /resume', retryFrom) - retryAt,
        restartGap: window.timeOf('tv: /resume', restartFrom) - restartAt,
      };
    });
    assert.deepEqual(run.states, [true, true, true, true]);
    assert.deepEqual(run.names, ['tv: /launch', 'host: /launch raised its session', 'tv: start request', 'host: connected',
      'tv: stop', 'tv: /resume', 'host: /resume raised its session', 'tv: start request', 'host: connected',
      'tv: /resume', 'host: /resume raised its session', 'tv: start request', 'host: connected',
      'tv: stop', 'app list', 'tv: /resume', 'host: /resume raised its session', 'tv: start request', 'host: connected']);
    // Each request goes out after its own delay (100 ms) and the refresh of the server info, far before the hold of 1100 ms
    assert.ok(run.reconnectGap < 400, 'reconnect after ' + run.reconnectGap + ' ms');
    assert.ok(run.retryGap < 400, 'retry after ' + run.retryGap + ' ms');
    assert.ok(run.restartGap < 300, 'new start after ' + run.restartGap + ' ms');
    assert.ok(!run.screens.some((text) => COUNTDOWN.test(text)), run.screens.join(' | '));
    assert.ok(!app.logs.some((line) => line.indexOf('may hold a start of this TV') >= 0 || line.indexOf('may still hold an earlier start') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the host holds a start of another device: the stream starts once more without a word after the hold, and connects', async () => {
  const app = await openWithSunshine();
  try {
    const run = await app.page.evaluate(async () => {
      window.otherDeviceStarts(1000);
      startGame(window.__host, 7);
      await window.wait(2300);
      return {
        names: window.names(), screens: window.__screens.slice(), connected: isStreamConnected,
        answeredAt: window.timeOf('host: /launch'), resumedAt: window.timeOf('tv: /resume'),
      };
    });
    assert.deepEqual(run.names, ['tv: /launch', 'host: /launch dropped its session', 'tv: start request',
      'host: Failed to verify RTSP message tag', 'tv: /resume', 'host: /resume raised its session', 'tv: start request',
      'host: connected'], 'no dialog, no message, no app list');
    // The start once more waits for the hold of the dropped start, which covers the start of the other device
    assert.ok(run.resumedAt - run.answeredAt >= 1095, 'resumed after ' + (run.resumedAt - run.answeredAt) + ' ms');
    assert.ok(run.screens.some((text) => COUNTDOWN.test(text)), run.screens.join(' | '));
    assert.equal(run.screens[run.screens.length - 1], 'Starting Game 7...');
    assert.equal(run.connected, true);
    assert.ok(app.logs.some((line) => line.indexOf('Warning: GAMING-PC answered the RTSP handshake with the key of another start, which it still holds, starting the stream once more once it released that start.') >= 0));
    assert.ok(app.logs.some((line) => line.indexOf('[index.js, retryStreamStart]') >= 0 && line.indexOf('Starting app 7 once more.') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a host that still holds the other start after the retry: the message about the held start instead of the ports, the next start waits, and RED cancels it during the wait', async () => {
  const app = await openWithSunshine();
  try {
    const run = await app.page.evaluate(async () => {
      // Another device's start that the host keeps for 5 s (e.g. a larger ping_timeout)
      window.otherDeviceStarts(5000);
      startGame(window.__host, 7);
      await window.wait(2000);
      const failed = { names: window.names(), isInGame };
      // A new start right away waits for the hold of the retry, which also never connected
      const from = window.__events.length;
      startGame(window.__host, 7);
      await window.wait(300);
      const waiting = $('#loadingSpinnerMessage').text();
      red();
      await window.wait(1500);
      return { failed, waiting, later: window.names().slice(from), isInGame };
    });
    assert.deepEqual(run.failed.names, ['tv: /launch', 'host: /launch dropped its session', 'tv: start request',
      'host: Failed to verify RTSP message tag', 'tv: /resume', 'host: /resume dropped its session', 'tv: start request',
      'host: Failed to verify RTSP message tag', 'message: ' + HELD_START_MESSAGE, 'app list']);
    assert.equal(run.failed.isInGame, false);
    assert.match(run.waiting, COUNTDOWN);
    // RED during the countdown cancels the start before its request
    assert.deepEqual(run.later, ['app list']);
    assert.equal(run.isInGame, false);
    assert.ok(app.logs.some((line) => line.indexOf('The start ended during the wait for GAMING-PC.') >= 0));
    assert.ok(!app.logs.some((line) => line.indexOf('error -300') >= 0), 'no message with the error code');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a launch request that fails on the TV makes the next start wait, since it may have reached the host', async () => {
  const app = await openWithSunshine();
  try {
    const run = await app.page.evaluate(async () => {
      window.__sunshine.failRequests = true;
      startGame(window.__host, 7);
      await window.wait(400);
      const failedAt = window.timeOf('tv: /launch failed');
      window.__sunshine.failRequests = false;
      startGame(window.__host, 7);
      await window.wait(1400);
      return { names: window.names(), screens: window.__screens.slice(), connected: isStreamConnected, failedAt, launchedAt: window.timeOf('tv: /launch', 2) };
    });
    assert.deepEqual(run.names, ['tv: /launch', 'tv: /launch failed', 'message: Failed to launch Game 7', 'app list',
      'tv: /launch', 'host: /launch raised its session', 'tv: start request', 'host: connected']);
    assert.ok(run.launchedAt - run.failedAt >= 1095, 'launched after ' + (run.launchedAt - run.failedAt) + ' ms');
    assert.ok(run.screens.some((text) => COUNTDOWN.test(text)), run.screens.join(' | '));
    assert.equal(run.connected, true);
    assert.ok(app.logs.some((line) => line.indexOf('its launch request failed') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the countdown and the message about the held start are translated', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', locale: 'de_DE' } });
  try {
    const texts = await app.page.evaluate(() => ({
      countdown: t('Waiting for the PC to release the previous start (%1$s s)...', 9),
      message: t('The PC is still holding an earlier start, e.g. from another device. Wait a few seconds and start again.'),
    }));
    assert.deepEqual(texts, {
      countdown: 'Warten, bis der PC den vorherigen Start freigibt (9 s) …',
      message: 'Der PC hält noch einen früheren Start, z. B. von einem anderen Gerät. Warte ein paar Sekunden und starte erneut.',
    });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
