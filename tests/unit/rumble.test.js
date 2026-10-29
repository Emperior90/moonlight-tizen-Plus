'use strict';

// Pins how the UI plays the rumble that the host sends during a stream (handleMessage() in wasm/platform/messages.js,
// message 'controllerRumble: <controller>,<weak>,<strong>', played by Rumble in wasm/platform/gamepad.js), on a
// simulated vibration actuator and a simulated clock. Chromium ends a vibration effect after 5 seconds at most and the
// host doesn't send an unchanged rumble again, so a rumble that stays on is played again every 4 seconds until the host
// sends 0, the stream ends or the gamepad disconnects (plan WP7).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const NOTICE = 'Gamepad 0 (Xbox Wireless Controller) does not support rumble on this TV.';

// Fake timers for the context, advanced by hand. Timers due at the same time run in the order they were created.
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const add = (callback, ms, repeat) => {
    const id = nextId++;
    timers.set(id, { callback, at: now + Math.max(0, ms || 0), ms: Math.max(1, ms || 0), repeat });
    return id;
  };
  return {
    setTimeout: (callback, ms) => add(callback, ms, false),
    setInterval: (callback, ms) => add(callback, ms, true),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    now: () => now,
    pending: () => timers.size,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let due = null;
        timers.forEach((timer, id) => {
          if (timer.at <= until && (!due || timer.at < due.timer.at)) {
            due = { id, timer };
          }
        });
        if (!due) {
          break;
        }
        now = due.timer.at;
        if (due.timer.repeat) {
          due.timer.at += due.timer.ms;
        } else {
          timers.delete(due.id);
        }
        due.timer.callback();
      }
      now = until;
    },
  };
}

// Simulated vibration actuator that records the effects it is asked to play. Options: playEffect (a function that
// replaces the recording one, e.g. one that rejects) and withoutReset (an actuator without reset(), like some engines).
function createActuator(timers, effects, options) {
  const opts = options || {};
  const actuator = {
    type: 'dual-rumble',
    playEffect: opts.playEffect || function(type, params) {
      effects.push({ at: timers.now(), type, params: Object.assign({}, params) });
      return Promise.resolve('complete');
    },
  };
  if (!opts.withoutReset) {
    actuator.reset = function() {
      effects.push({ at: timers.now(), type: 'reset' });
      return Promise.resolve('complete');
    };
  }
  return actuator;
}

// Load gamepad.js and messages.js with one gamepad slot, by default with a vibration actuator, during a running stream
// (isInGame and wasmSessionStarted of index.js, which 'streamTerminated' clears). The snackbar notices, translated with
// the source texts, are recorded, and leaveStreamView() finds the page functions it calls.
function loadWithGamepad(options) {
  const opts = Object.assign({ hasActuator: true }, options);
  const effects = [];
  const notices = [];
  const timers = createFakeTimers();
  const pads = [{ index: 0, id: XBOX_ID, mapping: 'standard', connected: true, timestamp: 1, buttons: [], axes: [] }, null, null, null];
  if (opts.hasActuator) {
    pads[0].vibrationActuator = createActuator(timers, effects, opts);
  }
  const format = (text, values) => text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  // A jQuery stand-in for the page changes of leaveStreamView()
  const jquery = () => ({ css: jquery, removeClass: jquery, addClass: jquery, text: jquery, hide: jquery, show: jquery });
  // menus.js holds the Stream Menu state that the end of a stream resets
  const platform = loadPlatformScripts(['wasm/platform/gamepad.js', 'wasm/platform/messages.js', 'wasm/platform/menus.js'], {
    globals: {
      navigator: { getGamepads: () => pads.slice() },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      // Date.now() follows the fake clock, while `new Date()` keeps working
      Date: class FakeDate extends Date {
        static now() {
          return timers.now();
        }
      },
      t: (text, ...values) => format(text, values),
      snackbarLogLong: (text, ...values) => notices.push(format(text, values)),
      $: jquery,
      setTvScreenSaver: () => {},
      stopAudioScheduler: () => {},
      streamLaunchHost: null,
      api: null,
      streamLaunchId: 0,
      isInGame: true,
      wasmSessionStarted: true,
    },
  });
  return {
    platform,
    pads,
    effects,
    notices,
    timers,
    handleMessage: platform.get('handleMessage'),
    Rumble: platform.get('Rumble'),
    warnings: () => platform.consoleMessages.filter((message) => message.level === 'warn').map((message) => message.text),
  };
}

// Let the promise callbacks of the actuator calls run
function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

// The times of the effects that played the rumble (not the ones at 0 that stop it)
function playTimes(effects) {
  return effects.filter((effect) => effect.type === 'dual-rumble' && (effect.params.weakMagnitude > 0 || effect.params.strongMagnitude > 0))
    .map((effect) => effect.at);
}

// Record the unhandled promise rejections while a test runs
function trackUnhandledRejections() {
  const rejections = [];
  const listener = (reason) => rejections.push(reason);
  process.on('unhandledRejection', listener);
  return { rejections, stop: () => process.removeListener('unhandledRejection', listener) };
}

test('a rumble message plays a 5 second dual-rumble effect with the given magnitudes', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('controllerRumble: 0,0.5,0.25');
  assert.deepEqual(rumble.effects, [{
    at: 0,
    type: 'dual-rumble',
    params: { startDelay: 0, duration: 5000, weakMagnitude: 0.5, strongMagnitude: 0.25 },
  }]);
});

test('a rumble that the host keeps on for 12 seconds is played 3 times without a gap, then reset', () => {
  const rumble = loadWithGamepad();
  // The host turns the motors off after 12 seconds (a timer created first runs first at the same time)
  rumble.timers.setTimeout(() => rumble.handleMessage('controllerRumble: 0,0,0'), 12000);
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.timers.advance(30000);
  assert.deepEqual(playTimes(rumble.effects), [0, 4000, 8000]);
  // Each effect starts before the 5 seconds of the previous one end, and the last one lasts until the host stops it
  rumble.effects.filter((effect) => effect.type === 'dual-rumble').forEach((effect) => assert.equal(effect.params.duration, 5000));
  assert.ok(8000 + 5000 >= 12000);
  assert.deepEqual(rumble.effects.slice(-1), [{ at: 12000, type: 'reset' }]);
  assert.equal(rumble.timers.pending(), 0, 'no replay is left');
});

test('a new strength from the host is played at once and replayed from then on', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.timers.advance(3000);
  rumble.handleMessage('controllerRumble: 0,1,0');
  rumble.timers.advance(5000);
  assert.deepEqual(rumble.effects.map((effect) => [effect.at, effect.params.weakMagnitude, effect.params.strongMagnitude]),
    [[0, 0.5, 0.5], [3000, 1, 0], [7000, 1, 0]]);
});

test('zero for both motors stops the rumble with reset(), or with an effect at 0 on an actuator without reset()', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.timers.advance(1000);
  rumble.handleMessage('controllerRumble: 0,0,0');
  rumble.timers.advance(10000);
  assert.deepEqual(rumble.effects.map((effect) => [effect.at, effect.type]), [[0, 'dual-rumble'], [1000, 'reset']]);

  const withoutReset = loadWithGamepad({ withoutReset: true });
  withoutReset.handleMessage('controllerRumble: 0,0.5,0.5');
  withoutReset.timers.advance(1000);
  withoutReset.handleMessage('controllerRumble: 0,0,0');
  withoutReset.timers.advance(10000);
  assert.deepEqual(withoutReset.effects, [
    { at: 0, type: 'dual-rumble', params: { startDelay: 0, duration: 5000, weakMagnitude: 0.5, strongMagnitude: 0.5 } },
    { at: 1000, type: 'dual-rumble', params: { startDelay: 0, duration: 5000, weakMagnitude: 0, strongMagnitude: 0 } },
  ]);
});

test('the end of the stream resets a rumble that is still on and stops replaying it', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.timers.advance(1000);
  rumble.handleMessage('streamTerminated: 0');
  rumble.timers.advance(10000);
  assert.deepEqual(rumble.effects.map((effect) => [effect.at, effect.type]), [[0, 'dual-rumble'], [1000, 'reset']]);
  assert.equal(rumble.timers.pending(), 0);
  // Without a rumble that is on, the end of the stream doesn't touch the actuator
  rumble.handleMessage('streamTerminated: 0');
  assert.equal(rumble.effects.length, 2);
});

test('a rumble that arrives after the end of the stream is not played, so it cannot go on in the menus', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.timers.advance(1000);
  rumble.handleMessage('streamTerminated: 0');
  // The connection of the stream still delivers the rumble of the host until the WASM module has torn it down, and the
  // host sends no 0 for a stream that is over
  rumble.handleMessage('controllerRumble: 0,0.6,0.6');
  rumble.timers.advance(60000);
  assert.deepEqual(rumble.effects.map((effect) => [effect.at, effect.type]), [[0, 'dual-rumble'], [1000, 'reset']]);
  assert.equal(rumble.timers.pending(), 0, 'no replay is left');
  assert.ok(rumble.platform.consoleMessages.some((message) => message.text.indexOf('Ignoring the rumble for gamepad 0 that arrived after the end of the stream.') >= 0));

  // Nor while the start request of a stream hasn't reached the WASM module, e.g. after a cancelled start
  const starting = loadWithGamepad();
  starting.platform.context.wasmSessionStarted = false;
  starting.handleMessage('controllerRumble: 0,0.5,0.5');
  starting.timers.advance(10000);
  assert.deepEqual(starting.effects, []);
  assert.equal(starting.timers.pending(), 0);
});

test('a rumble that is still on stops when the menus take over again', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.timers.advance(1000);
  // The gamepad polling of the menus resumes, e.g. after the stream view was left without the end of the stream
  rumble.platform.get('Controller').startWatching();
  rumble.timers.advance(10000);
  assert.deepEqual(playTimes(rumble.effects), [0]);
  assert.deepEqual(rumble.effects.filter((effect) => effect.type === 'reset').map((effect) => effect.at), [1000]);
  rumble.platform.get('Controller').stopWatching();
  assert.equal(rumble.timers.pending(), 0, 'no replay is left');
});

test('a gamepad that disconnects stops the replay, so the next gamepad in its slot does not start rumbling', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.timers.advance(1000);
  // What the gamepaddisconnected listener of index.js does
  const pad = rumble.pads[0];
  rumble.pads[0] = null;
  rumble.Rumble.stop(0);
  rumble.pads[0] = pad;
  rumble.timers.advance(10000);
  assert.deepEqual(playTimes(rumble.effects), [0]);
  assert.equal(rumble.timers.pending(), 0);

  // A slot that empties without the event ends the replay as well
  const silent = loadWithGamepad();
  silent.handleMessage('controllerRumble: 0,0.5,0.5');
  silent.pads[0] = null;
  silent.timers.advance(10000);
  assert.deepEqual(playTimes(silent.effects), [0]);
  assert.equal(silent.timers.pending(), 0);
});

test('a controller whose actuator refuses the effect gets one notice and leaves no unhandled rejection', async () => {
  const unhandled = trackUnhandledRejections();
  try {
    let attempts = 0;
    const rumble = loadWithGamepad({
      playEffect: () => {
        attempts++;
        return Promise.reject(new Error('NotSupportedError: the device does not support haptics'));
      },
    });
    rumble.handleMessage('controllerRumble: 0,0.5,0.5');
    await flushPromises();
    // The refused effect is not replayed
    rumble.timers.advance(12000);
    assert.equal(attempts, 1);
    assert.equal(rumble.timers.pending(), 0);
    // Later rumbles try again, but the notice appears only once
    rumble.handleMessage('controllerRumble: 0,1,1');
    await flushPromises();
    assert.equal(attempts, 2);
    assert.deepEqual(rumble.notices, [NOTICE]);
    assert.equal(rumble.warnings().filter((text) => text.indexOf('Gamepad 0 can\'t rumble: Error: NotSupportedError') >= 0).length, 2);

    // An actuator that throws instead of rejecting is caught as well, and stopping its rumble too
    const throwing = loadWithGamepad({
      playEffect: () => {
        throw new Error('InvalidStateError');
      },
    });
    throwing.pads[0].vibrationActuator.reset = () => Promise.reject(new Error('InvalidStateError'));
    throwing.handleMessage('controllerRumble: 0,0.5,0.5');
    throwing.handleMessage('controllerRumble: 0,0,0');
    await flushPromises();
    assert.deepEqual(throwing.notices, [NOTICE]);
    assert.ok(throwing.warnings().some((text) => text.indexOf('Failed to stop the rumble of gamepad 0: Error: InvalidStateError') >= 0));
    await flushPromises();
    assert.deepEqual(unhandled.rejections, []);
  } finally {
    unhandled.stop();
  }
});

test('a gamepad without a vibration actuator gets one notice and a warning in the log', () => {
  const rumble = loadWithGamepad({ hasActuator: false });
  rumble.handleMessage('controllerRumble: 0,0.5,0.25');
  rumble.handleMessage('controllerRumble: 0,0.75,0.25');
  rumble.handleMessage('controllerRumble: 0,0,0');
  assert.deepEqual(rumble.notices, [NOTICE]);
  assert.equal(rumble.warnings().filter((text) => text.indexOf('Gamepad 0 can\'t rumble: it has no vibration actuator') >= 0).length, 2);
  assert.equal(rumble.timers.pending(), 0);
  // A rumble for an empty slot only logs
  rumble.handleMessage('controllerRumble: 2,0.5,0.5');
  assert.equal(rumble.notices.length, 1);
  assert.ok(rumble.warnings().some((text) => text.indexOf('No gamepad 2 to play the rumble on.') >= 0));
});

test('a gamepad that connects with the rumble setting on plays a short test rumble, or gets the notice once', async () => {
  const rumble = loadWithGamepad();
  rumble.Rumble.test(rumble.pads[0]);
  assert.deepEqual(rumble.effects, [
    { at: 0, type: 'dual-rumble', params: { startDelay: 0, duration: 500, weakMagnitude: 0.5, strongMagnitude: 0.5 } },
  ]);
  assert.deepEqual(rumble.notices, []);

  // The notice of a controller without rumble appears once, at the connection or at the first rumble of a stream
  const withoutActuator = loadWithGamepad({ hasActuator: false });
  withoutActuator.Rumble.test(withoutActuator.pads[0]);
  withoutActuator.handleMessage('controllerRumble: 0,0.5,0.5');
  assert.deepEqual(withoutActuator.notices, [NOTICE]);

  const refusing = loadWithGamepad({ playEffect: () => Promise.reject(new Error('NotSupportedError')) });
  refusing.Rumble.test(refusing.pads[0]);
  await flushPromises();
  assert.deepEqual(refusing.notices, [NOTICE]);
});
