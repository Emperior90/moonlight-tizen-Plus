'use strict';

// Pins how the UI plays the rumble that the host sends during a stream (handleMessage() in wasm/platform/messages.js,
// message 'controllerRumble: <controller>,<weak>,<strong>'). Chromium ends a vibration effect after 5 seconds at most,
// so a long rumble from the host stops early; plan WP7 replays it, which the todo test below expects.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlatformScripts } = require('./helpers/platform-loader');

// Fake timers for the context, advanced by hand
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

// Load messages.js with one gamepad slot whose vibration actuator records the effects it is asked to play
function loadWithGamepad(hasActuator) {
  const effects = [];
  const timers = createFakeTimers();
  const pad = { index: 0, id: 'Xbox Wireless Controller', connected: true, buttons: [], axes: [] };
  if (hasActuator) {
    pad.vibrationActuator = {
      type: 'dual-rumble',
      playEffect(type, params) {
        effects.push({ at: timers.now(), type, params: Object.assign({}, params) });
        return Promise.resolve('complete');
      },
      reset() {
        effects.push({ at: timers.now(), type: 'reset' });
        return Promise.resolve('complete');
      },
    };
  }
  const platform = loadPlatformScripts(['wasm/platform/messages.js'], {
    globals: {
      navigator: { getGamepads: () => [pad, null, null, null] },
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
    },
  });
  return { platform, effects, timers, handleMessage: platform.get('handleMessage') };
}

test('a rumble message plays a 5 second dual-rumble effect with the given magnitudes', () => {
  const rumble = loadWithGamepad(true);
  rumble.handleMessage('controllerRumble: 0,0.5,0.25');
  assert.deepEqual(rumble.effects, [{
    at: 0,
    type: 'dual-rumble',
    params: { startDelay: 0, duration: 5000, weakMagnitude: 0.5, strongMagnitude: 0.25 },
  }]);
});

test('a gamepad without a vibration actuator only logs a warning', () => {
  const rumble = loadWithGamepad(false);
  rumble.handleMessage('controllerRumble: 0,0.5,0.25');
  assert.ok(rumble.platform.consoleMessages.some((message) => message.level === 'warn' && message.text.indexOf('does not support the rumble feature') >= 0));
});

test('a rumble that the host keeps on for 12 seconds keeps playing', {
  todo: 'Known bug (plan WP7): Chromium caps an effect at 5 s, and the effect is not replayed while the motors stay on',
}, () => {
  const rumble = loadWithGamepad(true);
  rumble.handleMessage('controllerRumble: 0,0.5,0.5');
  rumble.timers.advance(12000);
  const played = rumble.effects.filter((effect) => effect.type === 'dual-rumble');
  assert.ok(played.length >= 3, 'expected the effect to be replayed before each 5 s cap, got ' + played.length + ' effect(s)');
});
