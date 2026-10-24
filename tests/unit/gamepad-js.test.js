'use strict';

// Pins the menu gamepad polling of wasm/platform/gamepad.js (the Controller object): it polls
// navigator.getGamepads() every 5 ms while the menus are shown and reports changed buttons and axes as a
// 'gamepadinputchanged' event, which index.js maps to Navigation operations. The known bugs of plan finding C8 are
// marked as todo, so they turn into regular tests once WP6 fixes them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlatformScripts } = require('./helpers/platform-loader');

// Create a gamepad snapshot like the Gamepad API returns it
function makePad(index, buttonCount, axisCount, pressedButtons, axes) {
  const pressed = pressedButtons || [];
  return {
    index,
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    mapping: 'standard',
    connected: true,
    timestamp: 1,
    buttons: Array.from({ length: buttonCount }, (unused, i) => ({ pressed: pressed.indexOf(i) >= 0, value: pressed.indexOf(i) >= 0 ? 1 : 0 })),
    axes: axes ? axes.slice() : Array.from({ length: axisCount }, () => 0),
  };
}

// Load gamepad.js with a simulated navigator and a polling timer that the test advances by hand
function loadController() {
  const slots = [null, null, null, null];
  const changes = [];
  const intervals = [];
  function CustomEvent(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
  const platform = loadPlatformScripts(['wasm/platform/gamepad.js'], {
    globals: {
      navigator: { getGamepads: () => slots },
      CustomEvent,
      setInterval: (callback, ms) => {
        intervals.push({ callback, ms, active: true });
        return intervals.length;
      },
      clearInterval: (id) => {
        if (intervals[id - 1]) {
          intervals[id - 1].active = false;
        }
      },
    },
  });
  platform.context.addEventListener('gamepadinputchanged', (event) => {
    event.detail.changes.forEach((change) => changes.push(Object.assign({}, change)));
  });
  const controller = platform.get('Controller');
  return {
    platform,
    controller,
    slots,
    changes,
    intervals,
    // Run one polling round of every active interval
    poll(rounds) {
      for (let round = 0; round < (rounds || 1); round++) {
        intervals.filter((entry) => entry.active).forEach((entry) => entry.callback());
      }
    },
    // Announce a pad like the browser does once it saw input from it
    connect(pad) {
      slots[pad.index] = pad;
      platform.context.dispatchEvent({ type: 'gamepadconnected', gamepad: pad });
    },
    errors() {
      return platform.consoleMessages.filter((message) => message.level === 'error');
    },
  };
}

test('starting the polling registers the connection listeners once and polls every 5 ms', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.controller.stopWatching();
  pads.controller.startWatching();
  assert.equal(pads.platform.windowListeners.gamepadconnected.length, 1);
  assert.equal(pads.platform.windowListeners.gamepaddisconnected.length, 1);
  assert.equal(pads.intervals.filter((entry) => entry.active).length, 1);
  assert.equal(pads.intervals[0].ms, 5);
  pads.controller.startWatching();
  assert.equal(pads.intervals.filter((entry) => entry.active).length, 1, 'a second start keeps one interval');
});

test('a button press and release of a connected pad are reported', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  pads.poll();
  assert.deepEqual(pads.changes, []);
  pads.slots[0] = makePad(0, 17, 4, [13]);
  pads.poll();
  pads.slots[0] = makePad(0, 17, 4, []);
  pads.poll();
  assert.deepEqual(pads.changes, [
    { type: 'button', index: 13, pressed: true },
    { type: 'button', index: 13, pressed: false },
  ]);
});

test('an axis change is reported with its value', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  pads.slots[0] = makePad(0, 17, 4, [], [0, 0.9, 0, 0]);
  pads.poll();
  assert.deepEqual(pads.changes, [{ type: 'axis', index: 1, value: 0.9 }]);
});

test('a disconnected pad is no longer reported', () => {
  const pads = loadController();
  pads.controller.startWatching();
  const pad = makePad(0, 17, 4);
  pads.connect(pad);
  pads.platform.context.dispatchEvent({ type: 'gamepaddisconnected', gamepad: pad });
  pads.slots[0] = makePad(0, 17, 4, [0]);
  pads.poll();
  assert.deepEqual(pads.changes, []);
});

test('stopping the polling ends it, and a restart does not replay input held meanwhile', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  pads.controller.stopWatching();
  pads.slots[0] = makePad(0, 17, 4, [8], [0.9, 0, 0, 0]);
  pads.poll();
  assert.deepEqual(pads.changes, [], 'no polling while stopped');
  pads.controller.startWatching();
  pads.poll(3);
  assert.deepEqual(pads.changes, [], 'the held input is the new snapshot');
  pads.slots[0] = makePad(0, 17, 4, []);
  pads.poll();
  assert.deepEqual(pads.changes, [
    { type: 'button', index: 8, pressed: false },
    { type: 'axis', index: 0, value: 0 },
  ]);
});

test('a pad whose button or axis count changed keeps working without errors', {
  todo: 'Known bug C8 (plan WP6): gamepad.js keeps the old layout and rejects every later snapshot',
}, () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  pads.slots[0] = makePad(0, 18, 4);
  pads.poll();
  pads.slots[0] = makePad(0, 18, 4, [1]);
  pads.poll();
  assert.ok(pads.changes.some((change) => change.type === 'button' && change.index === 1 && change.pressed));
  assert.equal(pads.errors().length, 0);
});

test('a pad that never fired gamepadconnected is still reported', {
  todo: 'Known bug C8 (plan WP6): only pads seen in a gamepadconnected event are tracked',
}, () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.slots[1] = makePad(1, 17, 4);
  pads.poll();
  pads.slots[1] = makePad(1, 17, 4, [0]);
  pads.poll();
  assert.ok(pads.changes.some((change) => change.type === 'button' && change.index === 0 && change.pressed));
});

test('the press that woke the pad is reported', {
  todo: 'Known bug C8 (plan WP6): the button held in the connect snapshot is taken as the resting state',
}, () => {
  const pads = loadController();
  pads.controller.startWatching();
  // Chromium announces a pad on its first input, so its first snapshot already holds the pressed button
  pads.connect(makePad(0, 17, 4, [0]));
  pads.poll();
  assert.ok(pads.changes.some((change) => change.type === 'button' && change.index === 0 && change.pressed));
});
