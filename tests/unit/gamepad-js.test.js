'use strict';

// Pins the menu gamepad polling of wasm/platform/gamepad.js (the Controller object): it polls
// navigator.getGamepads() every 16 ms while the menus are shown and reports changed buttons and axes as a
// 'gamepadinputchanged' event, which index.js maps to Navigation operations (tests/unit/gamepad-menu-handler.test.js).
// Since 1.19.100 it also takes a fresh snapshot of a controller whose layout changed, finds controllers that never
// fired gamepadconnected, reports the press that woke a controller, ignores small stick movements, and describes the
// controllers for the log, the notice about a non-standard layout and System information. Since 2.2.1 a controller that
// reports a timestamp of 0 (Tizen 5.5) counts once its input changed, with the rule of PollGamepads() in
// wasm/gamepad.cpp (tests/fixtures/gamepad-evidence.tsv), which Controller.isRealGamepad() gives the input test and the
// mask of a stream start (utils.js), and a 'gamepadvalidated' event tells the UI. Since 2.3.0 that event comes before the
// input that made the controller count reaches the menus, the polling takes no snapshot of a gamepad that doesn't count
// yet when it takes the slot of a known one, so without a connection event the menus get no press or stick move from a
// slot that doesn't count (the gamepadconnected event that Chromium M69 sends after the read still takes one, and a
// button held then presses once instead of twice), and a stick value that is not a number moves nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, createPlatformContext, loadPlatformScripts, plain } = require('./helpers/platform-loader');

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

// Load gamepad.js with a simulated navigator, a polling timer that the test advances by hand and a clock
// (performance.now()) that stands still unless the test moves it (time.now, in ms)
function loadController() {
  const slots = [null, null, null, null];
  const changes = [];
  const intervals = [];
  const time = { now: 1000 };
  function CustomEvent(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
  const platform = loadPlatformScripts(['wasm/platform/gamepad.js'], {
    globals: {
      navigator: { getGamepads: () => slots },
      CustomEvent,
      performance: { now: () => time.now },
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
  // By how many ms the read of each event came late (lateBy of the event)
  const lateBy = [];
  platform.context.addEventListener('gamepadinputchanged', (event) => {
    events.push({ gamepad: event.detail.gamepad, count: event.detail.changes.length });
    lateBy.push(event.detail.lateBy);
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
    time,
    lateBy,
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

test('sticks: a rest zone of 0.15, changes of at least 0.05, and every crossing of the move and release thresholds of index.js', () => {
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
  // So is crossing the threshold below which a direction of the menus ends (since 2.3.1), in both directions of the stick
  const release = loadPlatformScripts(INDEX_SCRIPTS).get('ACTION_RELEASE_THRESHOLD');
  assert.equal(release, 0.3);
  pads.changes.length = 0;
  [0.6, 0.33, release - 0.01, release + 0.02, release + 0.04, -0.6, -release - 0.02, -release + 0.01].forEach(stick);
  assert.deepEqual(pads.changes.map((change) => change.value), [0.6, 0.33, release - 0.01, release + 0.02, -0.6, -release - 0.02, -release + 0.01]);
  // Back into the rest zone reports 0
  pads.changes.length = 0;
  stick(-0.1);
  assert.deepEqual(pads.changes, [{ type: 'axis', index: 0, value: 0 }]);
});

test('a read of the gamepads that comes late tells the menus by how much, so that a release it saw is not dated too late', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  // Reads on time, 16 ms apart, and one that a busy page delays a little (40 ms, less than three intervals): not late
  const readAfter = (ms, pressedButtons) => {
    pads.time.now += ms;
    pads.slots[0] = makePad(0, 17, 4, pressedButtons);
    pads.poll();
  };
  readAfter(16, [13]);
  readAfter(16, []);
  readAfter(40, [13]);
  assert.deepEqual(pads.lateBy, [0, 0, 0]);
  // The page is busy for 100 ms, in which the D-pad is released: the read after it is 84 ms late, and says so
  readAfter(100, []);
  assert.deepEqual(pads.lateBy.slice(-1), [84]);
  // The read after it is on time again, also one that is just short of three intervals
  readAfter(16, [13]);
  readAfter(47, []);
  readAfter(48, [13]);
  assert.deepEqual(pads.lateBy.slice(-3), [0, 0, 32]);
  // The polling pauses for a stream and starts again: its first read is not late, however long the pause was
  pads.controller.stopWatching();
  pads.time.now += 60000;
  pads.controller.startWatching();
  readAfter(16, []);
  readAfter(16, [13]);
  assert.deepEqual(pads.lateBy.slice(-2), [0, 0]);
  // The end of the input of a gamepad that disconnects is reported outside a read, also after a late one: not late
  readAfter(200, [13, 0]);
  assert.deepEqual(pads.lateBy.slice(-1), [184]);
  pads.disconnect(0);
  assert.deepEqual(pads.changes.slice(-2), [{ type: 'button', index: 0, pressed: false }, { type: 'button', index: 13, pressed: false }]);
  assert.deepEqual(pads.lateBy.slice(-1), [0]);
  assert.deepEqual(pads.errors(), []);
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

// ===== Controllers that report a timestamp of 0 (Tizen 5.5) =====

// Record the 'gamepadvalidated' events of Controller, which tell the UI about a slot that counts by its input change
function recordValidated(pads) {
  const validated = [];
  pads.platform.context.addEventListener('gamepadvalidated', (event) => validated.push(event.detail.gamepad));
  return validated;
}

// A frame of tests/fixtures/gamepad-evidence.tsv as the gamepad of slot 0: timestamp/buttons/axes[/id], or null for -
function fixtureFramePad(frame) {
  if (frame === '-') {
    return null;
  }
  const parts = frame.split('/');
  const value = (text) => (text === 'nan' ? NaN : Number(text));
  const list = (text) => (text === '' ? [] : text.split(','));
  return {
    index: 0,
    id: parts[3] || 'Pad',
    mapping: 'standard',
    connected: true,
    timestamp: value(parts[0]),
    buttons: list(parts[1]).map((text) => {
      const pressed = text.slice(-1) === '*';
      return { pressed, value: value(pressed ? text.slice(0, -1) : text) };
    }),
    axes: list(parts[2]).map(value),
  };
}

test('the slots of tests/fixtures/gamepad-evidence.tsv count as controllers as PollGamepads() of wasm/gamepad.cpp counts them', () => {
  const cases = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'gamepad-evidence.tsv'), 'utf8').split('\n')
    .filter((line) => line && line[0] !== '#')
    .map((line) => line.split('\t'))
    .map((fields) => ({ name: fields[0], expected: fields[1], frames: fields[2].split(' ').filter(Boolean) }));
  assert.ok(cases.length >= 15, 'cases: ' + cases.length);
  cases.forEach((entry) => {
    assert.equal(entry.frames.length, entry.expected.length, entry.name);
    const pads = loadController();
    pads.controller.startWatching();
    let actual = '';
    entry.frames.forEach((frame) => {
      pads.slots[0] = fixtureFramePad(frame);
      pads.poll();
      // An empty slot never counts. It isn't read again here, since getConnectedGamepads() itself forgets the evidence of
      // an empty slot, which would hide whether the poll of the menus did.
      actual += pads.slots[0] && pads.controller.getConnectedGamepads().length === 1 ? '1' : '0';
    });
    assert.equal(actual, entry.expected, entry.name);
    assert.equal(pads.errors().length, 0, entry.name);
  });
});

test('the menus get no press or stick move from a slot of tests/fixtures/gamepad-evidence.tsv that does not count yet', () => {
  const cases = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'gamepad-evidence.tsv'), 'utf8').split('\n')
    .filter((line) => line && line[0] !== '#')
    .map((line) => line.split('\t'))
    .map((fields) => ({ name: fields[0], expected: fields[1], frames: fields[2].split(' ').filter(Boolean) }));
  assert.ok(cases.length >= 15, 'cases: ' + cases.length);
  cases.forEach((entry) => {
    const pads = loadController();
    pads.controller.startWatching();
    entry.frames.forEach((frame, i) => {
      const before = pads.changes.length;
      pads.slots[0] = fixtureFramePad(frame);
      pads.poll();
      // A release, or a stick back at rest, only ends input that the menus took before, which can't move them
      if (entry.expected[i] === '0') {
        const moved = pads.changes.slice(before).filter((change) => change.pressed === true || (change.type === 'axis' && change.value !== 0));
        assert.deepEqual(moved, [], entry.name + ', frame ' + (i + 1));
      }
    });
  });
});

// Record the 'gamepadvalidated' and 'gamepadinputchanged' events of Controller in the order in which the UI gets them
function recordEventOrder(pads) {
  const order = [];
  pads.platform.context.addEventListener('gamepadvalidated', (event) => order.push('validated ' + event.detail.gamepad));
  pads.platform.context.addEventListener('gamepadinputchanged', (event) => event.detail.changes.forEach((change) => {
    order.push(change.type + ' ' + change.index + (change.type === 'button' ? (change.pressed ? '+' : '-') : '=' + change.value));
  }));
  return order;
}

test('the UI hears that a controller with a timestamp of 0 counts before the input that made it count reaches the menus', () => {
  // Without and with a gamepadconnected event: the first D-pad press of such a controller moves the selection at once,
  // so the entry that the controller brings (Mouse emulation in the Stream Menu, Calibrate the sticks in the button
  // mapping) has to show before it
  [false, true].forEach((connected) => {
    const pads = loadController();
    const order = recordEventOrder(pads);
    pads.controller.startWatching();
    const pad = makePad(1, 17, 4, [], null, { timestamp: 0 });
    if (connected) {
      pads.connect(pad);
    } else {
      pads.slots[1] = pad;
    }
    pads.poll(3);
    assert.deepEqual(order, [], 'connected: ' + connected);
    pads.slots[1] = makePad(1, 17, 4, [13], null, { timestamp: 0 });
    pads.poll();
    assert.deepEqual(order, ['validated 1', 'button 13+'], 'connected: ' + connected);
    pads.slots[1] = makePad(1, 17, 4, [], null, { timestamp: 0 });
    pads.poll(3);
    assert.deepEqual(order, ['validated 1', 'button 13+', 'button 13-'], 'connected: ' + connected);
  });
});

test('without a connection event, another gamepad with a timestamp of 0 that takes the slot of a known controller presses nothing until it counts', () => {
  const pads = loadController();
  const order = recordEventOrder(pads);
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  pads.slots[0] = makePad(0, 17, 4, [13]);
  pads.poll();
  // A DualSense that holds A replaces the Xbox controller in the slot before any connection event arrives
  const dualSense = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
  pads.slots[0] = makePad(0, 17, 4, [0], null, { timestamp: 0, id: dualSense });
  pads.poll(3);
  // The held D-pad of the old controller ends, and the A of the new one is no press
  assert.deepEqual(order, ['button 13+', 'button 13-']);
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()), []);
  assert.equal(pads.logs('Gamepad 0 changed its layout or was replaced, dropping its snapshot until it counts as a controller: id="' + dualSense + '"').length, 1);
  assert.equal(pads.logs('taking a new snapshot').length, 0);
  // Its release makes it count, which ends a repeat at most, and its next press moves the menus
  pads.slots[0] = makePad(0, 17, 4, [], null, { timestamp: 0, id: dualSense });
  pads.poll();
  pads.slots[0] = makePad(0, 17, 4, [1], null, { timestamp: 0, id: dualSense });
  pads.poll();
  assert.deepEqual(order, ['button 13+', 'button 13-', 'validated 0', 'button 0-', 'button 1+']);
  assert.equal(pads.errors().length, 0);
});

test('with the connection events of Chromium M69 after the read, a held button of such a gamepad presses once, not twice', () => {
  // Chromium M69 (Tizen 5.5) returns the new id from getGamepads() at once and sends gamepaddisconnected for the old id
  // and gamepadconnected for the new one only after the read. gamepadConnected() takes a snapshot with every button
  // released, as for any gamepad that the browser announces, so the held A presses once; the polling no longer takes a
  // snapshot of its own before it, which pressed it a first time and released it with the disconnect event.
  const pads = loadController();
  const order = recordEventOrder(pads);
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  pads.poll(2);
  const xbox = pads.slots[0];
  const dualSense = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
  pads.slots[0] = makePad(0, 17, 4, [0], null, { timestamp: 0, id: dualSense });
  pads.poll();
  pads.platform.context.dispatchEvent({ type: 'gamepaddisconnected', gamepad: Object.assign({}, xbox, { connected: false }) });
  pads.platform.context.dispatchEvent({ type: 'gamepadconnected', gamepad: pads.slots[0] });
  pads.poll(3);
  pads.slots[0] = makePad(0, 17, 4, [], null, { timestamp: 0, id: dualSense });
  pads.poll(2);
  assert.deepEqual(order, ['button 0+', 'validated 0', 'button 0-']);
  assert.equal(pads.errors().length, 0);
});

test('a stick that is not a number when the controller appears takes its first number as its resting position', () => {
  // Without and with a gamepadconnected event, a controller with a timestamp of 0 whose second stick axis reads NaN at
  // first and rests at 0.6, past the move threshold, once it reads a number
  [false, true].forEach((connected) => {
    const pads = loadController();
    pads.controller.startWatching();
    const pad = makePad(0, 17, 4, [], [0, NaN, 0, 0], { timestamp: 0 });
    if (connected) {
      pads.connect(pad);
    } else {
      pads.slots[0] = pad;
    }
    pads.poll(3);
    pads.slots[0] = makePad(0, 17, 4, [0], [0, 0.6, 0, 0], { timestamp: 0 });
    pads.poll();
    pads.slots[0] = makePad(0, 17, 4, [], [0, 0.6, 0, 0], { timestamp: 0 });
    pads.poll(3);
    assert.deepEqual(pads.changes, [{ type: 'button', index: 0, pressed: true }, { type: 'button', index: 0, pressed: false }], 'connected: ' + connected);
    // A later move from there is reported
    pads.slots[0] = makePad(0, 17, 4, [], [0, -0.8, 0, 0], { timestamp: 0 });
    pads.poll();
    assert.deepEqual(pads.changes.slice(2), [{ type: 'axis', index: 1, value: -0.8 }], 'connected: ' + connected);
  });
});

test('a stick value that is not a number in a read moves nothing, and a held stick keeps its position', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.connect(makePad(0, 17, 4));
  [[0, 0.8, 0, 0], [0, NaN, 0, 0], [0, 0.8, 0, 0], [0, 0, 0, 0]].forEach((axes) => {
    pads.slots[0] = makePad(0, 17, 4, [], axes);
    pads.poll();
  });
  assert.deepEqual(pads.changes, [{ type: 'axis', index: 1, value: 0.8 }, { type: 'axis', index: 1, value: 0 }]);
});

test('a controller with a timestamp of 0 and no gamepadconnected event moves the menus with its first press, and is listed then', () => {
  const pads = loadController();
  const validated = recordValidated(pads);
  pads.controller.startWatching();
  pads.slots[1] = makePad(1, 17, 4, [], null, { timestamp: 0 });
  pads.poll(5);
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()), []);
  assert.deepEqual(validated, []);
  pads.slots[1] = makePad(1, 17, 4, [13], null, { timestamp: 0 });
  pads.poll();
  assert.deepEqual(pads.changes, [{ type: 'button', index: 13, pressed: true }]);
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()).map((info) => info.index), [1]);
  assert.deepEqual(validated, [1], 'the UI is told once');
  assert.equal(pads.logs('Gamepad 1 reports a timestamp of 0 and counts as a controller since its input changed: id="' + XBOX_ID + '"').length, 1);
  assert.equal(pads.logs('Found gamepad 1 without a connection event').length, 1);
  pads.slots[1] = makePad(1, 17, 4, [], null, { timestamp: 0 });
  pads.poll(5);
  assert.deepEqual(pads.changes, [{ type: 'button', index: 13, pressed: true }, { type: 'button', index: 13, pressed: false }]);
  assert.deepEqual(validated, [1]);
  assert.equal(pads.controller.isRealGamepad(pads.slots[1]), true);
});

test('the log line names the timestamp that the slot reports, like PollGamepads() of wasm/gamepad.cpp', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.slots[0] = makePad(0, 17, 4, [], null, { timestamp: -1 });
  pads.poll(3);
  pads.slots[0] = makePad(0, 17, 4, [0], null, { timestamp: -1 });
  pads.poll();
  assert.equal(pads.logs('Gamepad 0 reports a timestamp of -1 and counts as a controller since its input changed: id="' + XBOX_ID + '"').length, 1);
  assert.equal(pads.logs('reports a timestamp of 0').length, 0);
});

test('a stick move of a controller with a timestamp of 0 moves the menus, from the position at which it appeared', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.slots[0] = makePad(0, 17, 4, [], [0.3, 0, 0, 0], { timestamp: 0 });
  pads.poll(3);
  pads.slots[0] = makePad(0, 17, 4, [], [0.3, 0.8, 0, 0], { timestamp: 0 });
  pads.poll();
  assert.deepEqual(pads.changes, [{ type: 'axis', index: 1, value: 0.8 }]);
});

test('a controller with a timestamp of 0 whose button is held since it appeared counts on the release, which is no press', () => {
  const pads = loadController();
  const validated = recordValidated(pads);
  pads.controller.startWatching();
  pads.slots[0] = makePad(0, 17, 4, [13], null, { timestamp: 0 });
  pads.poll(5);
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()), []);
  pads.slots[0] = makePad(0, 17, 4, [], null, { timestamp: 0 });
  pads.poll();
  assert.deepEqual(validated, [0]);
  // The menus get only the release, which ends a repeat at most (handleGamepadMenuInput() in index.js)
  assert.deepEqual(pads.changes, [{ type: 'button', index: 13, pressed: false }]);
  pads.slots[0] = makePad(0, 17, 4, [12], null, { timestamp: 0 });
  pads.poll();
  assert.deepEqual(pads.changes.slice(1), [{ type: 'button', index: 12, pressed: true }]);
});

test('a restart takes held input of a controller with a timestamp of 0 that the menus never saw as its resting state too', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.poll(3);
  pads.controller.stopWatching();
  // A controller turned on during the stream holds the stop combo when it ends, and releases LB first: that release
  // makes it count, while Select, Start and RB are still held
  pads.slots[0] = makePad(0, 17, 4, [4, 5, 8, 9], null, { timestamp: 0 });
  pads.controller.startWatching();
  pads.poll(3);
  pads.slots[0] = makePad(0, 17, 4, [5, 8, 9], null, { timestamp: 0 });
  pads.poll(2);
  assert.equal(pads.controller.isRealGamepad(pads.slots[0]), true);
  pads.slots[0] = makePad(0, 17, 4, [], null, { timestamp: 0 });
  pads.poll(2);
  assert.deepEqual(pads.changes.filter((change) => change.pressed), [], 'Select, Start and RB are not replayed as presses');
  assert.deepEqual(pads.changes.map((change) => change.index).sort((a, b) => a - b), [4, 5, 8, 9]);
});

test('a static placeholder with a held A and an axis at 0.3 is never listed and never moves the menus', () => {
  const pads = loadController();
  const validated = recordValidated(pads);
  pads.controller.startWatching();
  pads.slots[0] = makePad(0, 17, 4, [0], [0.3, 0, 0, 0], { timestamp: 0 });
  for (let i = 0; i < 50; i++) {
    pads.poll();
    assert.deepEqual(plain(pads.controller.getConnectedGamepads()), []);
  }
  assert.deepEqual(pads.changes, []);
  assert.deepEqual(validated, []);
  assert.equal(pads.controller.isRealGamepad(pads.slots[0]), false);
  assert.equal(pads.logs('Found gamepad').length, 0);
});

test('a controller whose timestamp drops from a positive one to 0 stays listed', () => {
  const pads = loadController();
  const validated = recordValidated(pads);
  pads.controller.startWatching();
  pads.connect(makePad(2, 17, 4, [], null, { timestamp: 5 }));
  pads.poll();
  pads.slots[2] = makePad(2, 17, 4, [], null, { timestamp: 0 });
  pads.poll(5);
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()).map((info) => info.index), [2]);
  assert.equal(pads.controller.isRealGamepad(pads.slots[2]), true);
  // It counted by its timestamp, which the UI learned from gamepadconnected
  assert.deepEqual(validated, []);
  // Another controller in its slot needs evidence of its own
  pads.slots[2] = makePad(2, 17, 4, [], null, { timestamp: 0, id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)' });
  pads.poll();
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()), []);
});

test('a slot that another reader validated is told to the UI by the next poll of the menus, once', () => {
  const pads = loadController();
  const validated = recordValidated(pads);
  pads.controller.startWatching();
  pads.slots[3] = makePad(3, 17, 4, [], null, { timestamp: 0 });
  // The input test reads the slots with Controller.isRealGamepad() on its own timer
  assert.equal(pads.controller.isRealGamepad(pads.slots[3], 3), false);
  pads.slots[3] = makePad(3, 17, 4, [1], null, { timestamp: 0 });
  assert.equal(pads.controller.isRealGamepad(pads.slots[3], 3), true);
  assert.deepEqual(validated, [], 'not inside the reader');
  pads.poll(3);
  assert.deepEqual(validated, [3]);
  // An empty slot forgets the evidence
  assert.equal(pads.controller.isRealGamepad(null, 3), false);
  pads.slots[3] = makePad(3, 17, 4, [1], null, { timestamp: 0 });
  assert.equal(pads.controller.isRealGamepad(pads.slots[3], 3), false);
});

test('a slot below 0 never counts, and asking for one leaves the evidence of the slots alone', () => {
  const pads = loadController();
  pads.controller.startWatching();
  pads.slots[0] = makePad(0, 17, 4, [], null, { timestamp: 0 });
  pads.poll(3);
  pads.slots[0] = makePad(0, 17, 4, [0], null, { timestamp: 0 });
  pads.poll();
  assert.equal(pads.controller.isRealGamepad(null), false);
  assert.equal(pads.controller.isRealGamepad(undefined), false);
  // Not even with a positive timestamp: the browser has no such slot
  assert.equal(pads.controller.isRealGamepad(makePad(-1, 17, 4, [], null, { timestamp: 5 })), false);
  assert.equal(pads.controller.isRealGamepad(makePad(0, 17, 4, [], null, { timestamp: 5 }), -1), false);
  assert.equal(pads.controller.isRealGamepad(makePad(0, 17, 4, [], null, { timestamp: 0 })), true, 'slot 0 still counts');
  assert.deepEqual(plain(pads.controller.getConnectedGamepads()).map((info) => info.index), [0]);
  assert.equal(pads.errors().length, 0);
});

test('the mask of a stream start includes a controller with a timestamp of 0 once its input changed', () => {
  const pads = loadController();
  pads.platform.load('wasm/static/js/utils.js');
  const getConnectedGamepadMask = pads.platform.get('getConnectedGamepadMask');
  pads.controller.startWatching();
  pads.slots[0] = makePad(0, 17, 4, [0], [0.3, 0, 0, 0], { timestamp: 0 });
  pads.slots[1] = makePad(1, 17, 4, [], null, { timestamp: 0 });
  pads.poll(3);
  assert.equal(getConnectedGamepadMask(), 0, 'placeholders');
  pads.slots[1] = makePad(1, 17, 4, [0], null, { timestamp: 0 });
  pads.poll();
  assert.equal(getConnectedGamepadMask(), 2);
  // It stays while the same controller is in the slot, and an empty slot forgets it
  pads.slots[1] = makePad(1, 17, 4, [], null, { timestamp: 0 });
  assert.equal(getConnectedGamepadMask(), 2);
  pads.slots[1] = null;
  assert.equal(getConnectedGamepadMask(), 0);
  pads.slots[1] = makePad(1, 17, 4, [], null, { timestamp: 0 });
  assert.equal(getConnectedGamepadMask(), 0);
  // A negative or missing timestamp is no evidence either, as in the stream
  pads.slots[2] = makePad(2, 17, 4, [], null, { timestamp: -1 });
  pads.slots[3] = makePad(3, 17, 4, [], null, { timestamp: undefined });
  pads.poll(3);
  assert.equal(getConnectedGamepadMask(), 0);
});

test('the mask of a stream start counts by the timestamp alone when gamepad.js is not loaded', () => {
  const slots = [null, null, null, null];
  const platform = createPlatformContext({ globals: { navigator: { getGamepads: () => slots } } });
  platform.load('wasm/static/js/utils.js');
  const getConnectedGamepadMask = platform.get('getConnectedGamepadMask');
  slots[0] = makePad(0, 17, 4, [], null, { timestamp: 0 });
  slots[1] = makePad(1, 17, 4, [], null, { timestamp: 5 });
  slots[2] = makePad(2, 17, 4, [], null, { timestamp: NaN });
  assert.equal(getConnectedGamepadMask(), 2);
  // A controller whose timestamp reads 0 later stays, until another one is in its slot
  slots[1] = makePad(1, 17, 4, [], null, { timestamp: 0 });
  assert.equal(getConnectedGamepadMask(), 2);
  slots[1] = makePad(1, 17, 4, [], null, { timestamp: 0, id: 'Other' });
  assert.equal(getConnectedGamepadMask(), 0);
  assert.deepEqual(platform.consoleMessages.filter((message) => message.level === 'error'), []);
});
