'use strict';

// Pins the menu gamepad polling of wasm/platform/gamepad.js (the Controller object): it polls
// navigator.getGamepads() every 16 ms while the menus are shown and reports changed buttons and axes as a
// 'gamepadinputchanged' event, which index.js maps to Navigation operations (tests/unit/gamepad-menu-handler.test.js).
// Since 1.19.100 it also takes a fresh snapshot of a controller whose layout changed, finds controllers that never
// fired gamepadconnected, reports the press that woke a controller, ignores small stick movements, and describes the
// controllers for the log, the notice about a non-standard layout and System information.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';

// Create a gamepad snapshot like the Gamepad API returns it; `extra` overrides fields such as id, mapping or timestamp
function makePad(index, buttonCount, axisCount, pressedButtons, axes, extra) {
  const pressed = pressedButtons || [];
  return Object.assign({
    index,
    id: XBOX_ID,
    mapping: 'standard',
    connected: true,
    timestamp: 1,
    buttons: Array.from({ length: buttonCount }, (unused, i) => ({ pressed: pressed.indexOf(i) >= 0, value: pressed.indexOf(i) >= 0 ? 1 : 0 })),
    axes: axes ? axes.slice() : Array.from({ length: axisCount }, () => 0),
  }, extra || {});
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
  const events = [];
  platform.context.addEventListener('gamepadinputchanged', (event) => {
    events.push({ gamepad: event.detail.gamepad, count: event.detail.changes.length });
    event.detail.changes.forEach((change) => changes.push(Object.assign({}, change)));
  });
  const controller = platform.get('Controller');
  return {
    platform,
    controller,
    slots,
    changes,
    events,
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
    // Disconnect a pad: the browser empties its slot and fires gamepaddisconnected
    disconnect(index) {
      const pad = slots[index];
      slots[index] = null;
      platform.context.dispatchEvent({ type: 'gamepaddisconnected', gamepad: Object.assign({}, pad, { connected: false }) });
    },
    errors() {
      return platform.consoleMessages.filter((message) => message.level === 'error');
    },
    logs(text) {
      return platform.consoleMessages.filter((message) => message.text.indexOf(text) >= 0);
    },
  };
}

test('starting the polling registers the connection listeners once and polls about once per frame (16 ms)', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.controller.stopWatching();
  pads.controller.startWatching();
  assert.equal(pads.platform.windowListeners.gamepadconnected.length, 1);
  assert.equal(pads.platform.windowListeners.gamepaddisconnected.length, 1);
  assert.equal(pads.intervals.filter((entry) => entry.active).length, 1);
  assert.equal(pads.intervals[0].ms, 16);
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
  pads.connect(makePad(0, 17, 4));
  pads.disconnect(0);
  pads.poll();
  // A slot that still reports the pad as disconnected is not taken for a new pad either
  pads.slots[0] = makePad(0, 17, 4, [0], null, { connected: false });
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

test('a pad whose button or axis count changed keeps working without errors', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  pads.slots[0] = makePad(0, 18, 4);
  pads.poll();
  pads.slots[0] = makePad(0, 18, 4, [1]);
  pads.poll();
  assert.ok(pads.changes.some((change) => change.type === 'button' && change.index === 1 && change.pressed));
  assert.equal(pads.errors().length, 0);
  // The new snapshot is logged once, not on every poll
  pads.poll(10);
  assert.equal(pads.logs('Gamepad 0 changed its layout or was replaced').length, 1);
});

test('a layout change while a button is held reports that press, like a new pad', () => {
  const pads = loadController();
  pads.controller.startWatching();
  // A Tizen placeholder with another layout is replaced in place by the real pad on its first press
  pads.connect(makePad(0, 16, 6, [], null, { id: 'Placeholder' }));
  pads.slots[0] = makePad(0, 17, 4, [0]);
  pads.poll();
  assert.deepEqual(pads.changes, [{ type: 'button', index: 0, pressed: true }]);
  assert.equal(pads.errors().length, 0);
});

test('another pad in the same slot gets a fresh snapshot, after the input of the old one ended', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4, [], [0, 0.9, 0, 0]));
  pads.slots[0] = makePad(0, 17, 4, [13], [0, 0.9, 0, 0]);
  pads.poll();
  pads.changes.length = 0;
  // A pad with the same layout but another id appears in the slot without a disconnect event
  pads.slots[0] = makePad(0, 17, 4, [], [0, 0.9, 0, 0], { id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)' });
  pads.poll(3);
  // The D-pad and the stick of the old pad are released, and the stick of the new pad starts from its own position
  assert.deepEqual(pads.changes, [{ type: 'button', index: 13, pressed: false }, { type: 'axis', index: 1, value: 0 }]);
  assert.equal(pads.logs('Gamepad 0 changed its layout or was replaced').length, 1);
});

test('a pad that disconnects or changes its layout while a button is held reports its release', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  pads.slots[0] = makePad(0, 17, 4, [13], [0, 0.8, 0, 0]);
  pads.poll();
  pads.changes.length = 0;
  pads.disconnect(0);
  assert.deepEqual(pads.changes, [{ type: 'button', index: 13, pressed: false }, { type: 'axis', index: 1, value: 0 }]);
  // The same with a layout change: first the release of the old snapshot, then the press held in the new one
  pads.connect(makePad(0, 17, 4));
  pads.slots[0] = makePad(0, 17, 4, [15]);
  pads.poll();
  pads.changes.length = 0;
  pads.slots[0] = makePad(0, 18, 4, [15]);
  pads.poll();
  assert.deepEqual(pads.changes, [{ type: 'button', index: 15, pressed: false }, { type: 'button', index: 15, pressed: true }]);
  assert.deepEqual(pads.events.slice(-2), [{ gamepad: 0, count: 1 }, { gamepad: 0, count: 1 }]);
});

test('while polling is paused for the stream, a disconnect reports nothing', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4, [8]));
  pads.poll();
  pads.changes.length = 0;
  pads.controller.stopWatching();
  pads.disconnect(0);
  assert.deepEqual(pads.changes, []);
});

test('a pad that never fired gamepadconnected is still reported', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.slots[1] = makePad(1, 17, 4);
  pads.poll();
  pads.slots[1] = makePad(1, 17, 4, [0]);
  pads.poll();
  assert.ok(pads.changes.some((change) => change.type === 'button' && change.index === 0 && change.pressed));
  assert.deepEqual(pads.events, [{ gamepad: 1, count: 1 }], 'the event names the pad');
  assert.equal(pads.logs('Found gamepad 1 without a connection event: id="' + XBOX_ID + '", mapping="standard", buttons=17, axes=4, rumble=no, type=Xbox').length, 1);
});

test('a Tizen placeholder is not taken for a pad until it reports input, and then its first press counts', () => {
  const pads = loadController();
  pads.controller.startWatching();
  // Tizen reports connected placeholder slots whose timestamp stays 0
  pads.slots[0] = makePad(0, 17, 4, [], null, { timestamp: 0 });
  pads.poll(3);
  assert.equal(pads.logs('Found gamepad').length, 0);
  pads.slots[0] = makePad(0, 17, 4, [0], null, { timestamp: 5 });
  pads.poll();
  assert.deepEqual(pads.changes, [{ type: 'button', index: 0, pressed: true }]);
});

test('the press that woke the pad is reported', () => {
  const pads = loadController();
  pads.controller.startWatching();
  // Chromium announces a pad on its first input, so its first snapshot already holds the pressed button
  pads.connect(makePad(0, 17, 4, [0]));
  pads.poll();
  assert.ok(pads.changes.some((change) => change.type === 'button' && change.index === 0 && change.pressed));
});

test('the press that woke the pad is reported once, also when the polling found the pad before the event', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.slots[0] = makePad(0, 17, 4, [0]);
  pads.poll();
  pads.connect(makePad(0, 17, 4, [0]));
  pads.poll(3);
  assert.deepEqual(pads.changes, [{ type: 'button', index: 0, pressed: true }]);
});

test('a resting stick position of the connect snapshot is not reported as a move', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4, [], [0.3, -0.6, 0, 0]));
  pads.poll(3);
  assert.deepEqual(pads.changes, []);
});

test('a restart takes held input of a pad that the menus never saw as its resting state too', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.controller.stopWatching();
  // A pad used only while streaming (no connect event) holds the stop combo when the stream ends
  pads.slots[2] = makePad(2, 17, 4, [4, 5, 8, 9]);
  pads.controller.startWatching();
  pads.poll(3);
  assert.deepEqual(pads.changes, [], 'Select and Start are not replayed as presses');
  pads.slots[2] = makePad(2, 17, 4, []);
  pads.poll();
  assert.equal(pads.changes.filter((change) => change.pressed === false).length, 4);
});

test('sticks: a rest zone of 0.15, changes of at least 0.05, and every crossing of the move threshold of index.js', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  const stick = (x) => {
    pads.slots[0] = makePad(0, 17, 4, [], [x, 0, 0, 0]);
    pads.poll();
  };
  // Jitter of a resting stick within the rest zone is not reported at all
  [0.02, -0.04, 0.14, -0.149, 0.1, 0].forEach(stick);
  assert.deepEqual(pads.changes, []);
  // Leaving the rest zone is reported, smaller changes than 0.05 are not, and a slow drift is reported once it adds up
  [0.2, 0.22, 0.24, 0.26, 0.3].forEach(stick);
  assert.deepEqual(pads.changes.map((change) => change.value), [0.2, 0.26]);
  // Crossing the threshold where the menus start to move is reported even as a small change
  const threshold = loadPlatformScripts(INDEX_SCRIPTS).get('ACTION_THRESHOLD');
  pads.changes.length = 0;
  [threshold - 0.02, threshold + 0.01, threshold + 0.03, threshold - 0.01, -threshold + 0.01, -threshold - 0.01].forEach(stick);
  assert.deepEqual(pads.changes.map((change) => change.value), [threshold - 0.02, threshold + 0.01, threshold - 0.01, -threshold + 0.01, -threshold - 0.01]);
  // Back into the rest zone reports 0
  pads.changes.length = 0;
  stick(-0.1);
  assert.deepEqual(pads.changes, [{ type: 'axis', index: 0, value: 0 }]);
});

test('a jittering resting stick sends no events, a held stick at full deflection none after the first', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  for (let i = 0; i < 200; i++) {
    const jitter = i % 2 ? 0.03 : -0.02;
    pads.slots[0] = makePad(0, 17, 4, [], [jitter, -jitter, jitter, 0.01]);
    pads.poll();
  }
  assert.equal(pads.events.length, 0);
  for (let i = 0; i < 200; i++) {
    pads.slots[0] = makePad(0, 17, 4, [], [0, i % 2 ? 0.99 : 0.97, 0, 0]);
    pads.poll();
  }
  assert.equal(pads.events.length, 1);
});

test('getControllerType() detects the same types as GetControllerType() of wasm/controller_type.hpp', () => {
  const pads = loadController();
  const getControllerType = pads.controller.getControllerType;
  const cases = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'controller-types.tsv'), 'utf8').split('\n')
    .filter((line) => line && line[0] !== '#' && line.indexOf('\t') >= 0)
    .map((line) => ({ type: line.slice(0, line.indexOf('\t')), id: line.slice(line.indexOf('\t') + 1) }));
  assert.ok(cases.length >= 20, 'cases: ' + cases.length);
  cases.forEach((entry) => assert.equal(getControllerType(entry.id), entry.type, entry.id));
  assert.equal(getControllerType(undefined), 'Unknown');
});

test('describeGamepad() and formatGamepadInfo() give the fields for the log', () => {
  const pads = loadController();
  const raw = makePad(1, 16, 6, [], null, {
    id: 'Generic USB Joystick (Vendor: 0079 Product: 0006)',
    mapping: '',
    vibrationActuator: { playEffect: () => Promise.resolve() },
  });
  const info = plain(pads.controller.describeGamepad(raw));
  assert.deepEqual(info, {
    index: 1, id: 'Generic USB Joystick (Vendor: 0079 Product: 0006)', name: 'Generic USB Joystick', mapping: '', buttons: 16, axes: 6,
    rumble: true, type: 'Unknown',
  });
  assert.equal(pads.controller.formatGamepadInfo(info),
    'id="Generic USB Joystick (Vendor: 0079 Product: 0006)", mapping="", buttons=16, axes=6, rumble=yes, type=Unknown');
  // The name drops the vendor and product numbers of both id formats
  const name = (id) => pads.controller.describeGamepad(makePad(0, 17, 4, [], null, { id })).name;
  assert.equal(name(XBOX_ID), 'Xbox Wireless Controller');
  assert.equal(name('054c-0ce6-DualSense Wireless Controller'), 'DualSense Wireless Controller');
  assert.equal(name('Joy-Con L+R (STANDARD GAMEPAD)'), 'Joy-Con L+R (STANDARD GAMEPAD)');
  assert.equal(name(''), '');
  // An actuator without playEffect() can't rumble
  assert.equal(pads.controller.describeGamepad(makePad(0, 17, 4, [], null, { vibrationActuator: {} })).rumble, false);
});

test('getConnectedGamepads() lists the controllers but not the empty slots or the Tizen placeholders', () => {
  const pads = loadController();
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()), []);
  pads.slots[0] = makePad(0, 17, 4, [], null, { timestamp: 0 });
  pads.slots[1] = makePad(1, 17, 4);
  pads.slots[3] = makePad(3, 16, 6, [], null, { id: 'Generic USB Joystick', mapping: '' });
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()).map((info) => [info.index, info.name, info.mapping]), [
    [1, 'Xbox Wireless Controller', 'standard'],
    [3, 'Generic USB Joystick', ''],
  ]);
});
