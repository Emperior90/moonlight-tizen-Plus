'use strict';

// Checks the silent retry of a stream that ended without video at its start (ML_ERROR_NO_VIDEO_TRAFFIC, error -100,
// retryStreamAfterNoVideo() in wasm/platform/index.js, called by handleMessage() in messages.js): the launch screen
// stays, the app is resumed and the stream started once more without a message, and the message about the ports of the
// host PC shows only when the retry ends without video as well. Only once per launch, never while Moonlight is in the
// background, RED during the wait cancels it, a retry that can't reach the host ends like the stream it retried, and
// a rumble that the host left on stops before the retry.
// The host is simulated in the page; the stub of the WebAssembly module records the start requests.

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

const PORTS_MESSAGE = 'No video received from the PC. Check that the firewall of the host PC and your router don\'t block these ports: ' +
  'UDP 47998, UDP 48000';

// Open the app with a simulated host that answers the launch and resume requests at once, starts app 7 with its
// launch, and records its requests, the start requests, showApps() and the snackbar messages in window.__events.
// The retry waits 100 ms instead of 1.5 s. The options are those of openApp().
async function openWithHost(options) {
  const app = await openApp(harness, Object.assign({ tv: { tv: 's90c', conn: 'wifi' } }, options));
  await app.page.evaluate(() => {
    NO_VIDEO_RETRY_DELAY_MS = 100;
    window.__events = [];
    const record = (event) => window.__events.push(event);
    const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
    window.__refreshFails = false;
    const host = {
      paired: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => (window.__refreshFails ? Promise.reject('offline') : Promise.resolve()),
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
    Module.startStream = () => {
      record('start request');
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
    // Start app 7 and let it reach 'Connection Established'
    window.startStream = async () => {
      startGame(host, 7);
      await window.wait(300);
      handleMessage('Connection Established');
    };
    // The connection ends without video, naming the ports of the video and the audio first, like the module does
    window.noVideo = () => {
      handleMessage('TerminationPortsMsg: UDP 47998, UDP 48000');
      handleMessage('streamTerminated: -100');
    };
    window.screen_ = () => ({
      isInGame, wasmSessionStarted,
      spinner: $('#loadingSpinner').is(':visible'),
      video: $('#wasm_module').is(':visible'),
      message: $('#loadingSpinnerMessage').text(),
    });
  });
  return app;
}

const events = (page) => page.evaluate(() => window.__events.slice());

test('no video at the start starts the stream once more without a message, a second time shows the ports', async () => {
  const app = await openWithHost();
  try {
    const run = await app.page.evaluate(async () => {
      await window.startStream();
      const streaming = window.screen_();
      window.__events.length = 0;
      window.noVideo();
      // The launch screen shows again at once, where RED cancels the start
      const waiting = window.screen_();
      await window.wait(400);
      const retried = { events: window.__events.splice(0), screen: window.screen_() };
      window.noVideo();
      await window.wait(100);
      const ended = { events: window.__events.splice(0), screen: window.screen_() };
      return { streaming, waiting, retried, ended };
    });
    assert.deepEqual([run.streaming.isInGame, run.streaming.spinner, run.streaming.video], [true, false, true]);
    assert.deepEqual(run.waiting, { isInGame: true, wasmSessionStarted: false, spinner: true, video: false, message: 'Starting Game 7...' });
    // The app runs on the host since the first launch, so the retry resumes it
    assert.deepEqual(run.retried.events, ['resume', 'start request']);
    assert.deepEqual([run.retried.screen.isInGame, run.retried.screen.wasmSessionStarted], [true, true]);
    // The retry ends without video as well: back to the app list, with the ports of this termination
    assert.deepEqual(run.ended.events, ['message: ' + PORTS_MESSAGE, 'app list']);
    assert.deepEqual([run.ended.screen.isInGame, run.ended.screen.spinner, run.ended.screen.video], [false, false, false]);
    assert.ok(app.logs.some((line) => line.indexOf('No video arrived from the host at the start of the stream, starting it once more in 100 ms.') >= 0));

    // A new launch gets its own retry
    const again = await app.page.evaluate(async () => {
      await window.startStream();
      window.__events.length = 0;
      window.noVideo();
      await window.wait(400);
      return window.__events.slice();
    });
    assert.deepEqual(again, ['resume', 'start request']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RED while the retry waits cancels it, and no message shows', async () => {
  const app = await openWithHost();
  try {
    const run = await app.page.evaluate(async () => {
      await window.startStream();
      window.__events.length = 0;
      window.noVideo();
      remoteControllerHandler({ keyCode: tvKey.KEY_RED, repeat: false, preventDefault() {} });
      const cancelled = window.screen_();
      await window.wait(400);
      return { cancelled, events: window.__events.slice(), after: window.screen_() };
    });
    assert.deepEqual([run.cancelled.isInGame, run.cancelled.spinner], [false, false]);
    assert.deepEqual(run.events, ['app list'], 'no resume, no start request, no message, no stop of a session that is over');
    assert.equal(run.after.isInGame, false);
    assert.ok(app.logs.some((line) => line.indexOf('Cancelling the start of the stream') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('no retry while Moonlight is in the background, and none once it went there during the wait', async () => {
  const app = await openWithHost();
  try {
    const hiddenRun = await app.page.evaluate(async () => {
      await window.startStream();
      window.__events.length = 0;
      // The stream ends without video right after Moonlight went to the background; the timer of the background stop
      // is still running
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      window.noVideo();
      await window.wait(400);
      const events = window.__events.splice(0);
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return { events, isInGame };
    });
    assert.deepEqual(hiddenRun, { events: ['message: ' + PORTS_MESSAGE, 'app list'], isInGame: false });

    const leftRun = await app.page.evaluate(async () => {
      await window.startStream();
      window.__events.length = 0;
      window.noVideo();
      // Moonlight goes to the background while the retry waits, which cancels the start (endStreamInBackground())
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await window.wait(400);
      const events = window.__events.splice(0);
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return { events, isInGame };
    });
    assert.equal(leftRun.isInGame, false);
    assert.deepEqual(leftRun.events.filter((event) => event === 'resume' || event === 'start request'), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a retry that can\'t reach the host ends like the stream it retried', async () => {
  const app = await openWithHost();
  try {
    const run = await app.page.evaluate(async () => {
      await window.startStream();
      window.__events.length = 0;
      window.__refreshFails = true;
      window.noVideo();
      await window.wait(400);
      return { events: window.__events.slice(), screen: window.screen_() };
    });
    assert.deepEqual(run.events, ['message: ' + PORTS_MESSAGE, 'app list']);
    assert.deepEqual([run.screen.isInGame, run.screen.spinner, run.screen.video], [false, false, false]);
    assert.ok(app.logs.some((line) => line.indexOf('The stream can\'t be started once more: the server info of the host could not be refreshed.') >= 0));

    // Another app runs on the host by now: the retry asks nothing (no dialog to quit it) and ends the same way
    const otherApp = await app.page.evaluate(async () => {
      window.__refreshFails = false;
      await window.startStream();
      window.__events.length = 0;
      window.__host.currentGame = 9;
      window.noVideo();
      await window.wait(400);
      return { events: window.__events.slice(), isInGame, dialog: isDialogOpen };
    });
    assert.deepEqual(otherApp, { events: ['message: ' + PORTS_MESSAGE, 'app list'], isInGame: false, dialog: false });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// A gamepad in slot 0 whose vibration actuator records its calls in window.__events (as in gamepad-streaming.test.js)
function simulatedGamepad() {
  window.__pads = [null, null, null, null];
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => window.__pads.slice(),
  });
  const record = (event) => (window.__events || []).push(event);
  window.__connectPad = () => {
    const pad = {
      index: 0,
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
      mapping: 'standard',
      connected: true,
      timestamp: 1,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
      vibrationActuator: {
        type: 'dual-rumble',
        playEffect: (type, params) => {
          record('rumble ' + params.weakMagnitude + '/' + params.strongMagnitude + ' for ' + params.duration + ' ms');
          return Promise.resolve('complete');
        },
        reset: () => {
          record('rumble reset');
          return Promise.resolve('complete');
        },
      },
    };
    window.__pads[0] = pad;
    const event = new Event('gamepadconnected');
    Object.defineProperty(event, 'gamepad', { value: pad });
    window.dispatchEvent(event);
  };
}

test('a rumble that the host left on stops before the retry, and isn\'t replayed during it', async () => {
  const app = await openWithHost({ stored: { rumbleFeedback: true }, initScripts: [simulatedGamepad] });
  try {
    const run = await app.page.evaluate(async () => {
      window.__connectPad();
      await window.startStream();
      window.__events.length = 0;
      // The game turns the rumble on while no video arrives, then the connection ends without video
      handleMessage('controllerRumble: 0,0.5,0.5');
      window.noVideo();
      await window.wait(400);
      const retried = window.__events.splice(0);
      // The retried stream runs, and the host sends no rumble for its new controller: the rumble of the first stream
      // would have been replayed after 4 s
      handleMessage('Connection Established');
      await window.wait(4200);
      return { retried, during: window.__events.slice() };
    });
    assert.deepEqual(run.retried, ['rumble 0.5/0.5 for 5000 ms', 'rumble reset', 'resume', 'start request']);
    assert.deepEqual(run.during, []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('with Web Audio, the retry starts the audio scheduler after its start request', async () => {
  const app = await openWithHost();
  try {
    const order = await app.page.evaluate(async () => {
      $('#selectAudioBackend').attr('data-value', 'WebAudio').data('value', 'WebAudio');
      startAudioScheduler = () => window.__events.push('audio scheduler');
      await window.startStream();
      const launch = window.__events.splice(0);
      window.noVideo();
      await window.wait(400);
      return { launch, retry: window.__events.slice() };
    });
    // The key press of the launch creates the audio context before anything else
    assert.deepEqual(order.launch, ['audio scheduler', 'launch', 'start request']);
    // The retry has no key press, and the stop of the failed stream closes the scheduler from the queue of the module,
    // which the start request runs through
    assert.deepEqual(order.retry, ['resume', 'start request', 'audio scheduler']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
