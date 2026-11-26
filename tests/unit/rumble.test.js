'use strict';

// Pins how the UI plays the rumble that the host sends during a stream (handleMessage() in wasm/platform/messages.js,
// message 'controllerRumble: <controller>,<weak>,<strong>', played by Rumble in wasm/platform/gamepad.js), on a
// simulated vibration actuator and a simulated clock. Chromium ends a vibration effect after 5 seconds at most and the
// host doesn't send an unchanged rumble again, so a rumble that stays on is played again every 4 seconds until the host
// sends 0, the stream ends or the gamepad disconnects. A game changes the strength of a rumble up to 60 times per
// second, so the console gets a line when a rumble starts and when it stops, and a warning about a gamepad that can't
// play it once per rumble, not with every message (logFrequentMessages of messages.js brings every line back). A game
// can also start and stop a rumble several times per second (4 to 8 times while riding a horse), so since 2.3.6 only the
// first start and the first stop of a gamepad in a stream get their lines: the ones after them are summed up per
// gamepad at most once a minute and at the end of the stream, while each of them is still played as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const NOTICE = 'Controller 0 (Xbox Wireless Controller) does not support rumble on this TV.';

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
    // The console lines without their '%c' prefix and its style
    lines: () => platform.consoleMessages.map((message) => message.text.replace(/^%c\[[^\]]+\] color: \w+; /, '')),
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
    // Later changes of the rumble try again, but the notice appears only once, and the warning once per rumble: not
    // again until the host stopped it
    rumble.handleMessage('controllerRumble: 0,1,1');
    await flushPromises();
    assert.equal(attempts, 2);
    assert.deepEqual(rumble.notices, [NOTICE]);
    const refusals = () => rumble.warnings().filter((text) => text.indexOf('Gamepad 0 can\'t rumble: Error: NotSupportedError') >= 0).length;
    assert.equal(refusals(), 1);
    rumble.handleMessage('controllerRumble: 0,0,0');
    rumble.handleMessage('controllerRumble: 0,0.5,0.5');
    await flushPromises();
    assert.equal(attempts, 3);
    assert.equal(refusals(), 2);
    assert.deepEqual(rumble.notices, [NOTICE]);

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
  const count = (text) => rumble.warnings().filter((warning) => warning.indexOf(text) >= 0).length;
  // One warning for a rumble, however often the game changes its strength
  rumble.handleMessage('controllerRumble: 0,0.5,0.25');
  for (let i = 0; i < 60; i++) {
    rumble.handleMessage('controllerRumble: 0,' + (0.3 + i / 100) + ',0.25');
  }
  assert.equal(count('Gamepad 0 can\'t rumble: it has no vibration actuator'), 1);
  rumble.handleMessage('controllerRumble: 0,0,0');
  assert.deepEqual(rumble.notices, [NOTICE]);
  assert.equal(rumble.timers.pending(), 0);
  // The next rumble warns again
  rumble.handleMessage('controllerRumble: 0,0.75,0.25');
  assert.equal(count('Gamepad 0 can\'t rumble: it has no vibration actuator'), 2);
  assert.deepEqual(rumble.notices, [NOTICE]);
  // A rumble for an empty slot only logs, once per rumble as well
  rumble.handleMessage('controllerRumble: 2,0.5,0.5');
  rumble.handleMessage('controllerRumble: 2,0.6,0.5');
  assert.equal(rumble.notices.length, 1);
  assert.equal(count('No gamepad 2 to play the rumble on.'), 1);
  rumble.handleMessage('controllerRumble: 2,0,0');
  rumble.handleMessage('controllerRumble: 2,0.5,0.5');
  assert.equal(count('No gamepad 2 to play the rumble on.'), 2);
  // The end of the stream ends the rumbles: the first rumble of the next stream warns again
  rumble.handleMessage('streamTerminated: 0');
  rumble.platform.context.isInGame = true;
  rumble.platform.context.wasmSessionStarted = true;
  rumble.handleMessage('controllerRumble: 2,0.5,0.5');
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  assert.equal(count('No gamepad 2 to play the rumble on.'), 3);
  assert.equal(count('Gamepad 0 can\'t rumble: it has no vibration actuator'), 3);
});

test('a rumble writes a console line when it starts and when it stops, not with each change of its strength', () => {
  const rumble = loadWithGamepad();
  // A game that changes the strength of the rumble 60 times within a second, then stops it
  rumble.handleMessage('controllerRumble: 0,0.5,0.25');
  for (let i = 1; i <= 60; i++) {
    rumble.handleMessage('controllerRumble: 0,' + (0.5 - i / 200) + ',0.25');
  }
  rumble.handleMessage('controllerRumble: 0,0,0');
  // The host repeats the 0
  rumble.handleMessage('controllerRumble: 0,0,0');
  assert.deepEqual(rumble.lines(), [
    'Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.25 (the changes of its strength are not logged until it stops)...',
    'The host stopped the rumble on gamepad 0.',
  ]);
  // Every change still reached the actuator
  assert.equal(playTimes(rumble.effects).length, 61);
  // The next rumble of gamepad 0 is counted for its summary (see the next test), and each gamepad has its own first
  // rumble
  rumble.handleMessage('controllerRumble: 0,1,1');
  rumble.handleMessage('controllerRumble: 1,0,0.5');
  rumble.handleMessage('controllerRumble: 0,0.9,1');
  // (gamepad 1 has no controller, which warns as before)
  const logged = () => rumble.lines().filter((line) => line.indexOf('Warning: ') !== 0);
  assert.deepEqual(logged().slice(2), [
    'Playing rumble on gamepad 1 with weak magnitude 0 and strong magnitude 0.5 (the changes of its strength are not logged until it stops)...',
  ]);
  // The end of the stream writes the summary of gamepad 0, and a rumble that it cut off doesn't count as on in the next
  // stream, whose first rumble has its line again
  rumble.handleMessage('streamTerminated: 0');
  assert.deepEqual(logged().slice(3).filter((line) => line.indexOf('Rumble on gamepad') === 0), [
    'Rumble on gamepad 0: 1 more start and 0 stops in the last 1 s, strongest weak magnitude 1 and strong magnitude 1.',
  ]);
  rumble.platform.context.isInGame = true;
  rumble.platform.context.wasmSessionStarted = true;
  const before = rumble.lines().length;
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  assert.deepEqual(rumble.lines().slice(before), [
    'Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.5 (the changes of its strength are not logged until it stops)...',
  ]);
});

// A game that starts and stops the rumble of gamepad 0 `perSecond` times per second for `seconds` from the current time
// of the clock, each rumble on for a third of its period with the magnitudes that magnitudes(k) gives for rumble k. The
// rumble k starts at k * period. Returns the rumbles as { at, stopAt, weak, strong }.
function rideAHorse(rumble, gamepad, perSecond, seconds, magnitudes) {
  const period = 1000 / perSecond;
  const start = rumble.timers.now();
  const rumbles = [];
  for (let k = 0; k < perSecond * seconds; k++) {
    const [weak, strong] = magnitudes(k);
    rumbles.push({ at: start + Math.round(k * period), stopAt: start + Math.round(k * period + period / 3), weak, strong });
  }
  rumbles.forEach((entry) => {
    rumble.timers.advance(entry.at - rumble.timers.now());
    rumble.handleMessage('controllerRumble: ' + gamepad + ',' + entry.weak + ',' + entry.strong);
    rumble.timers.advance(entry.stopAt - rumble.timers.now());
    rumble.handleMessage('controllerRumble: ' + gamepad + ',0,0');
  });
  return rumbles;
}

test('a rumble that a game starts and stops several times per second is summed up once a minute and at the end of the stream', () => {
  const rumble = loadWithGamepad();
  // Riding a horse: 6 rumbles per second for 150 s, the strongest weak magnitude 0.75 at rumble 200 and the strongest
  // strong magnitude 1 at rumble 700
  const rumbles = rideAHorse(rumble, 0, 6, 150, (k) => [k === 200 ? 0.75 : 0.25, k === 700 ? 1 : 0.5]);
  assert.equal(rumbles.length, 900);
  // The first start and the first stop as before, then one line per minute from the first rumble that was counted
  // (rumble 1, at 167 ms): rumbles 1 to 360 up to 60.167 s, 361 to 720 up to 120.167 s
  const lines = rumble.lines();
  assert.deepEqual(lines, [
    'Playing rumble on gamepad 0 with weak magnitude 0.25 and strong magnitude 0.5 (the changes of its strength are not logged until it stops)...',
    'The host stopped the rumble on gamepad 0.',
    'Rumble on gamepad 0: 360 more starts and 360 stops in the last 60 s, strongest weak magnitude 0.75 and strong magnitude 0.5.',
    'Rumble on gamepad 0: 360 more starts and 360 stops in the last 60 s, strongest weak magnitude 0.25 and strong magnitude 1.',
  ]);
  // The rumbles after 120.167 s are summed up when the stream ends, 9.8 s after the last one
  rumble.timers.advance(10000);
  rumble.handleMessage('streamTerminated: 0');
  assert.deepEqual(rumble.lines().slice(lines.length).filter((line) => line.indexOf('Message data:') !== 0), [
    'Rumble on gamepad 0: 179 more starts and 179 stops in the last 40 s, strongest weak magnitude 0.25 and strong magnitude 0.5.',
  ]);
  // 360 + 360 + 179 counted rumbles and the first one: every one was played at its start with its magnitudes and stopped
  // at its 0, as without the summary
  const played = rumble.effects.filter((effect) => effect.type === 'dual-rumble');
  assert.deepEqual(played.map((effect) => [effect.at, effect.params.weakMagnitude, effect.params.strongMagnitude]),
    rumbles.map((entry) => [entry.at, entry.weak, entry.strong]));
  assert.deepEqual(rumble.effects.filter((effect) => effect.type === 'reset').map((effect) => effect.at),
    rumbles.map((entry) => entry.stopAt));
  // Nothing of the summary is left running after the stream
  assert.equal(rumble.timers.pending(), 0);
});

test('each gamepad has its own summary, a quiet minute writes none, and the debug switch still logs every rumble', () => {
  const rumble = loadWithGamepad();
  // The lines of the rumble, without the warnings about gamepad 1 and the line of the message that ends the stream
  const logged = () => rumble.lines().filter((line) => /^(?:Playing rumble|The host stopped|Rumble on gamepad)/.test(line));
  // Gamepad 1 has no controller: its rumble is logged like that of gamepad 0, and warns once per rumble as before
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.handleMessage('controllerRumble: 1,0.25,0.25');
  rumble.handleMessage('controllerRumble: 0,0,0');
  rumble.handleMessage('controllerRumble: 1,0,0');
  assert.deepEqual(logged(), [
    'Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.5 (the changes of its strength are not logged until it stops)...',
    'Playing rumble on gamepad 1 with weak magnitude 0.25 and strong magnitude 0.25 (the changes of its strength are not logged until it stops)...',
    'The host stopped the rumble on gamepad 0.',
    'The host stopped the rumble on gamepad 1.',
  ]);
  rumble.timers.advance(1000);
  for (let k = 0; k < 3; k++) {
    rumble.handleMessage('controllerRumble: 0,0.5,0.5');
    rumble.handleMessage('controllerRumble: 0,0,0');
  }
  rumble.handleMessage('controllerRumble: 1,0.25,0.75');
  rumble.timers.advance(30000);
  // A change of the strength of a counted rumble counts for the strongest magnitude, not as a start
  rumble.handleMessage('controllerRumble: 1,0.25,1');
  rumble.handleMessage('controllerRumble: 1,0,0');
  assert.deepEqual(logged().slice(4), []);
  rumble.timers.advance(30000);
  assert.deepEqual(logged().slice(4), [
    'Rumble on gamepad 0: 3 more starts and 3 stops in the last 60 s, strongest weak magnitude 0.5 and strong magnitude 0.5.',
    'Rumble on gamepad 1: 1 more start and 1 stop in the last 60 s, strongest weak magnitude 0.25 and strong magnitude 1.',
  ]);
  assert.equal(rumble.warnings().filter((warning) => warning.indexOf('No gamepad 1 to play the rumble on.') >= 0).length, 2);
  // No rumble in the next minute: no line; the next one opens the next summary, which the end of the stream writes
  rumble.timers.advance(120000);
  assert.equal(logged().length, 6);
  rumble.handleMessage('controllerRumble: 0,1,0.5');
  rumble.timers.advance(5000);
  rumble.handleMessage('streamTerminated: 0');
  assert.deepEqual(logged().slice(6), [
    'Rumble on gamepad 0: 1 more start and 0 stops in the last 5 s, strongest weak magnitude 1 and strong magnitude 0.5.',
  ]);
  assert.equal(rumble.timers.pending(), 0);

  // logFrequentMessages, set in the console of a debugger: every start and stop has its line, nothing is summed up
  const debugging = loadWithGamepad();
  debugging.platform.run('logFrequentMessages = true;');
  for (let k = 0; k < 3; k++) {
    debugging.handleMessage('controllerRumble: 0,0.5,0.25');
    debugging.handleMessage('controllerRumble: 0,0,0');
  }
  debugging.timers.advance(60000);
  debugging.handleMessage('streamTerminated: 0');
  const lines = debugging.lines().filter((line) => line.indexOf('Message data:') !== 0);
  assert.deepEqual(lines, [
    'Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.25...',
    'The host stopped the rumble on gamepad 0.',
    'Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.25...',
    'The host stopped the rumble on gamepad 0.',
    'Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.25...',
    'The host stopped the rumble on gamepad 0.',
  ]);
});

test('a counted rumble that is still on when its line is written counts with its strength in the next one, and its changes open none', () => {
  // The first start and the first stop, then a counted start at 0.1 that is still on when its line is written 60 s
  // later, and that grows to full strength right after the line
  const rideOn = (rumble) => {
    rumble.handleMessage('controllerRumble: 0,0.5,0.5');
    rumble.handleMessage('controllerRumble: 0,0,0');
    rumble.timers.advance(1000);
    rumble.handleMessage('controllerRumble: 0,0.1,0.1');
    rumble.timers.advance(60000);
    rumble.handleMessage('controllerRumble: 0,1,1');
  };
  const summaries = (rumble) => rumble.lines().filter((line) => line.indexOf('Rumble on gamepad') === 0);
  const first = 'Rumble on gamepad 0: 1 more start and 0 stops in the last 60 s, strongest weak magnitude 0.1 and strong magnitude 0.1.';

  // It stops 1 s later, and the stream ends 2 s after that: the line of the end shows the strength it had
  const rumble = loadWithGamepad();
  rideOn(rumble);
  rumble.timers.advance(1000);
  rumble.handleMessage('controllerRumble: 0,0,0');
  rumble.timers.advance(2000);
  rumble.handleMessage('streamTerminated: 0');
  assert.deepEqual(summaries(rumble), [
    first,
    'Rumble on gamepad 0: 0 more starts and 1 stop in the last 2 s, strongest weak magnitude 1 and strong magnitude 1.',
  ]);
  assert.ok(rumble.effects.some((effect) => effect.type === 'dual-rumble' && effect.params.weakMagnitude === 1 && effect.params.strongMagnitude === 1));
  assert.equal(rumble.timers.pending(), 0);

  // A change of the strength after the line is neither a start nor a stop, so it opens no summary: the stop 39 s later
  // opens it, and its line comes 60 s after the stop, not 60 s after the change
  const later = loadWithGamepad();
  rideOn(later);
  later.timers.advance(39000);
  later.handleMessage('controllerRumble: 0,0,0');
  later.timers.advance(30000);
  assert.deepEqual(summaries(later), [first]);
  later.timers.advance(30000);
  assert.deepEqual(summaries(later), [
    first,
    'Rumble on gamepad 0: 0 more starts and 1 stop in the last 60 s, strongest weak magnitude 1 and strong magnitude 1.',
  ]);
  later.handleMessage('streamTerminated: 0');
  assert.equal(summaries(later).length, 2);
  assert.equal(later.timers.pending(), 0);

  // A counted rumble that is on when its line is written, without a change after it, counts with the strength it has
  const steady = loadWithGamepad();
  steady.handleMessage('controllerRumble: 0,0.5,0.5');
  steady.handleMessage('controllerRumble: 0,0,0');
  steady.handleMessage('controllerRumble: 0,0.25,0.75');
  steady.timers.advance(60000);
  steady.handleMessage('controllerRumble: 0,0,0');
  steady.timers.advance(1000);
  steady.handleMessage('streamTerminated: 0');
  assert.deepEqual(summaries(steady), [
    'Rumble on gamepad 0: 1 more start and 0 stops in the last 60 s, strongest weak magnitude 0.25 and strong magnitude 0.75.',
    'Rumble on gamepad 0: 0 more starts and 1 stop in the last 1 s, strongest weak magnitude 0.25 and strong magnitude 0.75.',
  ]);
});

test('the rumbles that arrive after the end of a stream are logged once, and the debug switch logs every message again', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('streamTerminated: 0');
  const before = rumble.lines().length;
  for (let i = 0; i < 20; i++) {
    rumble.handleMessage('controllerRumble: 0,0.6,0.6');
  }
  assert.deepEqual(rumble.lines().slice(before), ['Ignoring the rumble for gamepad 0 that arrived after the end of the stream.']);
  // Once more after the end of the next stream
  rumble.platform.context.isInGame = true;
  rumble.platform.context.wasmSessionStarted = true;
  rumble.handleMessage('streamTerminated: 0');
  rumble.handleMessage('controllerRumble: 0,0.6,0.6');
  rumble.handleMessage('controllerRumble: 0,0.6,0.6');
  assert.equal(rumble.lines().filter((line) => line.indexOf('Ignoring the rumble') === 0).length, 2);

  // logFrequentMessages, set in the console of a debugger: the line of every message and of every change
  const debugging = loadWithGamepad();
  debugging.platform.run('logFrequentMessages = true;');
  debugging.handleMessage('controllerRumble: 0,0.5,0.25');
  debugging.handleMessage('controllerRumble: 0,0.75,0.25');
  debugging.handleMessage('controllerRumble: 0,0,0');
  assert.deepEqual(debugging.lines(), [
    'Message data:  controllerRumble: 0,0.5,0.25',
    'Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.25...',
    'Message data:  controllerRumble: 0,0.75,0.25',
    'Playing rumble on gamepad 0 with weak magnitude 0.75 and strong magnitude 0.25...',
    'Message data:  controllerRumble: 0,0,0',
    'The host stopped the rumble on gamepad 0.',
  ]);
  debugging.handleMessage('streamTerminated: 0');
  const late = debugging.lines().length;
  debugging.handleMessage('controllerRumble: 0,0.6,0.6');
  debugging.handleMessage('controllerRumble: 0,0.6,0.6');
  assert.equal(debugging.lines().slice(late).filter((line) => line.indexOf('Ignoring the rumble') === 0).length, 2);
});

test('the guide shows the summary of the rumble as the app writes it', () => {
  const rumble = loadWithGamepad();
  rumble.handleMessage('controllerRumble: 0,1,0.5');
  rumble.handleMessage('controllerRumble: 0,0,0');
  rumble.timers.advance(100);
  for (let k = 0; k < 412; k++) {
    rumble.handleMessage('controllerRumble: 0,' + (k === 7 ? 1 : 0.5) + ',0.5');
    rumble.handleMessage('controllerRumble: 0,0,0');
    rumble.timers.advance(145);
  }
  rumble.timers.advance(60000);
  const summary = rumble.lines().filter((line) => line.indexOf('Rumble on gamepad') === 0);
  assert.deepEqual(summary, ['Rumble on gamepad 0: 412 more starts and 412 stops in the last 60 s, strongest weak magnitude 1 and strong magnitude 0.5.']);
  const guide = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'GUIDE.md'), 'utf8');
  assert.ok(guide.indexOf('*' + summary[0] + '*') > 0, 'the example of the guide');
  assert.ok(guide.indexOf('*Playing rumble on gamepad 0 …*, *The host stopped the rumble on gamepad 0.*') > 0);
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
