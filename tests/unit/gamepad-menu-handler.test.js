'use strict';

// Pins how a gamepad drives the menus: handleGamepadMenuInput() of wasm/platform/index.js maps the
// 'gamepadinputchanged' events of gamepad.js to Navigation operations, with the delays of the buttons and of the stick
// and the auto-repeat of a held D-pad or stick. It runs here with a simulated clock (timers, an animation frame every 16 ms,
// Date.now() and performance.now()), so the moves of a held input can be counted exactly; tests/browser/gamepad-menu.test.js
// checks the mapping in the real page.
// Since 2.3.1 one press counts once: A, B, Select and Start ignore the same button within 150 ms of the press that
// counted, a D-pad button that bounces (released for at most 40 ms) doesn't step again, a stick direction holds until
// the stick is back below 0.3, and a stick that snaps back past its centre doesn't step back. None of it delays the
// first press or changes the repeat of a held input.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

const NAVIGATION_API = ['up', 'down', 'left', 'right', 'accept', 'back', 'press', 'switch', 'push', 'change', 'pop', 'start', 'stop', 'guardAccept'];
const FRAME_MS = 16;

// Simulated clock: timers and animation frames run in time order when the test advances the clock
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const setTimer = (callback, ms, interval) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms || 0), callback, interval });
    return id;
  };
  const clear = (id) => {
    timers.delete(id);
  };
  return {
    now: () => now,
    setTimeout: (callback, ms) => setTimer(callback, ms, 0),
    clearTimeout: clear,
    setInterval: (callback, ms) => setTimer(callback, ms, ms),
    clearInterval: clear,
    requestAnimationFrame: (callback) => setTimer(() => callback(now), FRAME_MS, 0),
    cancelAnimationFrame: clear,
    // Run every timer that is due until the clock moved on by the given time
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let nextKey = null;
        timers.forEach((timer, id) => {
          if (timer.at <= until && (nextKey === null || timer.at < timers.get(nextKey).at)) {
            nextKey = id;
          }
        });
        if (nextKey === null) {
          break;
        }
        const timer = timers.get(nextKey);
        now = timer.at;
        if (timer.interval) {
          timer.at += timer.interval;
        } else {
          timers.delete(nextKey);
        }
        timer.callback();
      }
      now = until;
    },
  };
}

// Load index.js (and optionally gamepad.js, as in wasm/index.html) with a Navigation recorder and the simulated clock,
// and connect handleGamepadMenuInput() to the 'gamepadinputchanged' events like attachListeners() does
function loadMenus(withGamepadJs) {
  const clock = createClock();
  const operations = [];
  const navigation = {};
  NAVIGATION_API.forEach((name) => {
    navigation[name] = () => operations.push(name);
  });
  const slots = [null, null, null, null];
  function CustomEvent(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
  const scripts = (withGamepadJs ? ['wasm/platform/gamepad.js'] : []).concat(INDEX_SCRIPTS);
  const platform = loadPlatformScripts(scripts, {
    globals: { Navigation: navigation, CustomEvent, navigator: { userAgent: 'Node unit test', getGamepads: () => slots } },
  });
  // The scripts look these globals up when they run, so the simulated clock takes over from here
  ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'].forEach((name) => {
    platform.context[name] = clock[name];
  });
  platform.context.__clockNow = clock.now;
  platform.run('Date.now = function() { return __clockNow(); };');
  // The guards against double triggers measure with performance.now(), which a change of the clock of the TV can't move
  platform.context.performance = { now: clock.now };
  // The connection handlers of index.js show snackbars and refresh System information, which need the page (see
  // tests/browser/gamepad-controllers.test.js), so they only record the snackbars here
  const snackbars = [];
  platform.context.t = (key) => key;
  platform.context.snackbarLog = function() {
    snackbars.push(Array.prototype.slice.call(arguments));
  };
  platform.context.snackbarLogLong = platform.context.snackbarLog;
  platform.context.addEventListener('gamepadinputchanged', platform.get('handleGamepadMenuInput'));
  return {
    platform,
    clock,
    operations,
    slots,
    snackbars,
    // Send changes like gamepad.js does after a poll of the given pad
    send(changes, gamepad) {
      platform.context.dispatchEvent({ type: 'gamepadinputchanged', detail: { gamepad: gamepad || 0, changes } });
    },
    count(operation) {
      return operations.filter((name) => name === operation).length;
    },
    errors() {
      return platform.consoleMessages.filter((message) => message.level === 'error');
    },
  };
}

const press = (index) => ({ type: 'button', index, pressed: true });
const release = (index) => ({ type: 'button', index, pressed: false });
const axis = (index, value) => ({ type: 'axis', index, value });

test('the buttons act after 50 ms, close to the remote, and the left stick after 150 ms against double steps', () => {
  const menus = loadMenus();
  assert.equal(menus.platform.get('BUTTON_NAVIGATION_DELAY'), 50);
  assert.equal(menus.platform.get('NAVIGATION_DELAY'), 150);
  // A accepts 50 ms after the press
  menus.send([press(0)]);
  menus.clock.advance(49);
  assert.deepEqual(menus.operations, []);
  menus.clock.advance(1);
  assert.deepEqual(menus.operations, ['accept']);
  menus.send([release(0)]);
  // The left stick moves 150 ms after it crossed the threshold
  menus.send([axis(1, 0.9)]);
  menus.clock.advance(149);
  assert.deepEqual(menus.operations, ['accept']);
  menus.clock.advance(1);
  assert.deepEqual(menus.operations, ['accept', 'down']);
  menus.send([axis(1, 0)]);
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['accept', 'down']);
  assert.deepEqual(menus.errors(), []);
});

test('A accepts, B goes back, Select presses and Start switches, each after the delay of the buttons', () => {
  const menus = loadMenus();
  const delay = menus.platform.get('BUTTON_NAVIGATION_DELAY');
  [0, 1, 8, 9].forEach((button) => {
    menus.send([press(button)]);
    menus.clock.advance(delay - 1);
    menus.send([release(button)]);
    menus.clock.advance(1);
  });
  assert.deepEqual(menus.operations, ['accept', 'back', 'press', 'switch']);
  // The other buttons do nothing in the menus
  [2, 3, 4, 5, 6, 7, 10, 11, 16].forEach((button) => {
    menus.send([press(button)]);
    menus.send([release(button)]);
  });
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['accept', 'back', 'press', 'switch']);
  assert.deepEqual(menus.errors(), []);
});

test('the unused flag isGamepadActive is gone', () => {
  const menus = loadMenus();
  assert.equal(menus.platform.get('typeof isGamepadActive'), 'undefined');
});

// Hold D-pad down for 2 s, calling noise(t) every 50 ms to send other input meanwhile, and count the moves
function holdDpad(noise) {
  const menus = loadMenus();
  menus.send([press(13)]);
  for (let t = 0; t < 2000; t += 50) {
    if (noise) {
      noise(menus, t);
    }
    menus.clock.advance(50);
  }
  menus.send([release(13)]);
  const held = menus.count('down');
  menus.clock.advance(1000);
  assert.equal(menus.count('down'), held, 'no moves after the release');
  assert.deepEqual(menus.errors(), []);
  return { moves: held, operations: menus.operations };
}

test('holding the D-pad for 2 s gives 16 moves, with and without stick jitter', () => {
  // The first move right away, the repeat after 350 ms, then a move on the first frame more than 100 ms after the last
  assert.equal(holdDpad().moves, 16);
  // The resting left stick jitters by a few hundredths
  assert.equal(holdDpad((menus, t) => menus.send([axis(1, (t / 50) % 2 ? 0.01 : 0.02)])).moves, 16);
  // A drifting stick that gamepad.js reports, since it is outside the rest zone, but stays below the move threshold
  assert.equal(holdDpad((menus, t) => menus.send([axis(0, (t / 50) % 2 ? 0.2 : 0.3), axis(1, (t / 50) % 2 ? -0.45 : -0.35)])).moves, 16);
});

test('holding the D-pad keeps repeating when another button or D-pad direction is released', () => {
  const result = holdDpad((menus, t) => {
    if (t === 500) {
      menus.send([press(4)]);
    } else if (t === 600) {
      menus.send([release(4), release(12), release(15)]);
    }
  });
  assert.equal(result.moves, 16);
  assert.ok(result.operations.every((name) => name === 'down'), JSON.stringify(result.operations));
});

test('the whole menu path: a held D-pad gives 16 moves while the sticks jitter, polled by gamepad.js', () => {
  const menus = loadMenus(true);
  const makePad = (pressed, axes) => ({
    index: 0,
    id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
    mapping: 'standard',
    connected: true,
    timestamp: 1,
    buttons: Array.from({ length: 17 }, (unused, i) => ({ pressed: pressed.indexOf(i) >= 0, value: pressed.indexOf(i) >= 0 ? 1 : 0 })),
    axes,
  });
  menus.slots[0] = makePad([], [0, 0, 0, 0]);
  menus.platform.get('Controller').startWatching();
  menus.clock.advance(20);
  const events = [];
  menus.platform.context.addEventListener('gamepadinputchanged', (event) => events.push(event.detail));
  // Worn sticks: the left stick jitters around its resting point, and the right stick drifts outside the rest zone
  // horizontally and jitters within it vertically
  menus.slots[0] = makePad([13], [0.05, -0.08, 0.3, 0.05]);
  for (let step = 0; step < 400; step++) {
    menus.clock.advance(5);
    const jitter = step % 2 ? 0.06 : -0.06;
    menus.slots[0] = makePad([13], [0.05 + jitter, -0.08 - jitter, 0.3 + jitter, 0.05 + jitter]);
  }
  menus.slots[0] = makePad([], [0, 0, 0, 0]);
  menus.clock.advance(1000);
  assert.equal(menus.count('down'), 16);
  assert.deepEqual(menus.operations.filter((name) => name !== 'down'), []);
  assert.ok(events.every((detail) => detail.gamepad === 0));
  // Only the drifting right stick axis sends events, and none of the axes within the rest zone
  const axisChanges = [].concat.apply([], events.map((detail) => detail.changes)).filter((change) => change.type === 'axis');
  assert.ok(axisChanges.every((change) => change.index === 2), JSON.stringify(axisChanges.slice(0, 5)));
  assert.deepEqual(menus.errors(), []);
});

test('the whole menu path: a pad that disconnects while its D-pad is held stops repeating', () => {
  const menus = loadMenus(true);
  const pad = (pressed) => ({
    index: 0,
    id: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
    mapping: 'standard',
    connected: true,
    timestamp: 1,
    buttons: Array.from({ length: 17 }, (unused, i) => ({ pressed: pressed.indexOf(i) >= 0, value: pressed.indexOf(i) >= 0 ? 1 : 0 })),
    axes: [0, 0, 0, 0],
  });
  menus.slots[0] = pad([]);
  menus.platform.get('Controller').startWatching();
  menus.clock.advance(20);
  menus.slots[0] = pad([14]);
  menus.clock.advance(1000);
  const moves = menus.count('left');
  assert.ok(moves > 5, 'repeating while held: ' + moves);
  // The battery runs out: the browser empties the slot and fires gamepaddisconnected
  menus.slots[0] = null;
  menus.platform.context.dispatchEvent({ type: 'gamepaddisconnected', gamepad: Object.assign(pad([14]), { connected: false }) });
  menus.clock.advance(1000);
  assert.equal(menus.count('left'), moves);
  assert.deepEqual(menus.snackbars, [['Controller %1$s (%2$s) has been disconnected.', 0, 'Pro Controller']]);
});

test('a stick held past the threshold repeats, ignores its jitter there, and stops back below the threshold', () => {
  const holdStick = (jitter) => {
    const menus = loadMenus();
    menus.send([axis(1, 0.9)]);
    for (let t = 0; t < 2000; t += 50) {
      if (jitter) {
        menus.send([axis(1, [0.9, 0.97, 0.84, 1][(t / 50) % 4])]);
      }
      menus.clock.advance(50);
    }
    // Back below the release threshold of 0.3 (since 2.3.1; the action threshold of 0.5 before)
    menus.send([axis(1, 0.2)]);
    const held = menus.count('down');
    menus.clock.advance(1000);
    assert.equal(menus.count('down'), held, 'no moves below the threshold');
    assert.deepEqual(menus.operations.filter((name) => name !== 'down'), []);
    return held;
  };
  const moves = holdStick(false);
  // The first move after the navigation delay, then the same repeat as the D-pad
  assert.equal(moves, 16);
  assert.equal(holdStick(true), moves);
});

test('a stick direction holds until the stick is back below 0.3: wobbling around 0.5 steps once and keeps repeating', () => {
  assert.equal(loadMenus().platform.get('ACTION_RELEASE_THRESHOLD'), 0.3);
  const menus = loadMenus();
  // A stick held near the action threshold: it used to step again at every crossing of 0.5 (4 steps in 400 ms here)
  [0.55, 0.45, 0.6, 0.4, 0.55, 0.42, 0.58, 0.45].forEach((value) => {
    menus.send([axis(1, value)]);
    menus.clock.advance(50);
  });
  assert.deepEqual(menus.operations, ['down', 'down'], 'the step after 150 ms and the first repeat after 350 ms');
  // Below 0.3 the direction ends, and the next push past 0.5 is a new step
  menus.send([axis(1, 0.25)]);
  menus.clock.advance(400);
  assert.deepEqual(menus.operations, ['down', 'down']);
  menus.send([axis(1, 0.7)]);
  menus.clock.advance(200);
  menus.send([axis(1, 0)]);
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['down', 'down', 'down']);
  assert.deepEqual(menus.errors(), []);
});

test('a stick that snaps back past its centre when it is let go does not step back', () => {
  assert.equal(loadMenus().platform.get('STICK_REVERSE_GUARD'), 200);
  // Held for 220 ms, let go: the stick swings to -0.6 for 30 ms before it rests ('down, up' before 2.3.1)
  let menus = loadMenus();
  menus.send([axis(1, 0.9)]);
  menus.clock.advance(220);
  menus.send([axis(1, -0.6)]);
  menus.clock.advance(30);
  menus.send([axis(1, 0)]);
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['down']);

  // A flick of 100 ms, shorter than the delay of the stick: its step still counts, and the swing back neither replaces
  // it (only 'up' before 2.3.1) nor adds a step
  menus = loadMenus();
  menus.send([axis(1, 0.9)]);
  menus.clock.advance(100);
  menus.send([axis(1, -0.7)]);
  menus.clock.advance(40);
  menus.send([axis(1, 0)]);
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['down']);

  // The same through the centre, as a poll can catch it: 0.9, 0.1, -0.6, 0
  menus = loadMenus();
  menus.send([axis(0, -0.9)]);
  menus.clock.advance(180);
  menus.send([axis(0, -0.1)]);
  menus.clock.advance(16);
  menus.send([axis(0, 0.6)]);
  menus.clock.advance(32);
  menus.send([axis(0, 0)]);
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['left']);

  // The next flick into the first direction right after the swing back is a step of its own, also a short one
  menus = loadMenus();
  menus.send([axis(1, 0.9)]);
  menus.clock.advance(200);
  menus.send([axis(1, -0.6)]);
  menus.clock.advance(30);
  menus.send([axis(1, 0)]);
  menus.clock.advance(50);
  menus.send([axis(1, 0.9)]);
  menus.clock.advance(100);
  menus.send([axis(1, 0)]);
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['down', 'down']);
  assert.deepEqual(menus.errors(), []);
});

test('a stick that is moved to the other side and held there steps and repeats in the new direction', () => {
  const menus = loadMenus();
  menus.send([axis(0, -0.9)]);
  menus.clock.advance(200);
  // Straight to the other side: the step comes once the stick stayed for the guard time, 200 ms (150 ms before 2.3.1)
  menus.send([axis(0, 0.9)]);
  menus.clock.advance(199);
  assert.deepEqual(menus.operations, ['left']);
  menus.clock.advance(1);
  assert.deepEqual(menus.operations, ['left', 'right']);
  // Its repeat starts 200 ms after the step, like that of any stick move, and goes on every 112 ms (7 frames)
  menus.clock.advance(199);
  assert.deepEqual(menus.operations, ['left', 'right']);
  menus.clock.advance(17 + 112);
  assert.deepEqual(menus.operations, ['left', 'right', 'right', 'right']);
  menus.send([axis(0, 0)]);
  menus.clock.advance(1000);
  assert.equal(menus.count('right'), 3, 'no moves after the release');

  // After more than the guard time at rest, the other direction is a move like any other: its step after 150 ms
  const rested = loadMenus();
  rested.send([axis(0, -0.9)]);
  rested.clock.advance(200);
  rested.send([axis(0, 0)]);
  rested.clock.advance(200);
  rested.send([axis(0, 0.9)]);
  rested.clock.advance(150);
  assert.deepEqual(rested.operations, ['left', 'right']);
  rested.send([axis(0, 0)]);
  assert.deepEqual(menus.errors().concat(rested.errors()), []);
});

test('a press of A, B, Select or Start that is reported twice counts once, without a delay for the press', () => {
  assert.equal(loadMenus().platform.get('BUTTON_REPEAT_GUARD'), 150);
  [0, 1, 8, 9].forEach((button) => {
    const name = { 0: 'accept', 1: 'back', 8: 'press', 9: 'switch' }[button];
    // Reported again 30, 64 and 144 ms after the first report (two operations before 2.3.1, or one that came later)
    [30, 64, 144].forEach((gap) => {
      const menus = loadMenus();
      menus.send([press(button)]);
      menus.clock.advance(20);
      menus.send([release(button)]);
      menus.clock.advance(gap - 20);
      menus.send([press(button)]);
      menus.send([release(button)]);
      menus.clock.advance(50 - Math.min(50, gap));
      assert.deepEqual(menus.operations, [name], 'the operation runs 50 ms after the first report, gap ' + gap + ' ms');
      menus.clock.advance(1000);
      assert.deepEqual(menus.operations, [name], 'one operation, gap ' + gap + ' ms');
    });
    // Two presses 160 ms apart both count, and so does the same button of another gamepad at once
    const menus = loadMenus();
    menus.send([press(button)]);
    menus.send([release(button)]);
    menus.clock.advance(160);
    menus.send([press(button)]);
    menus.send([release(button)]);
    menus.clock.advance(60);
    menus.send([press(button)], 1);
    menus.send([release(button)], 1);
    menus.clock.advance(1000);
    assert.deepEqual(menus.operations, [name, name, name]);
    assert.deepEqual(menus.errors(), []);
  });
});

test('a D-pad button that bounces steps once and keeps its repeat, and two quick presses step twice', () => {
  assert.equal(loadMenus().platform.get('DPAD_BOUNCE_GUARD'), 40);
  // A press that the TV reports released for one or two polls (16 or 32 ms) and pressed again (two steps before 2.3.1)
  [16, 32].forEach((gap) => {
    const menus = loadMenus();
    menus.send([press(13)]);
    assert.deepEqual(menus.operations, ['down'], 'the press steps at once');
    menus.clock.advance(48);
    menus.send([release(13)]);
    menus.clock.advance(gap);
    menus.send([press(13)]);
    menus.clock.advance(100);
    menus.send([release(13)]);
    menus.clock.advance(1000);
    assert.deepEqual(menus.operations, ['down'], 'one step with a bounce of ' + gap + ' ms');
  });

  // Held for 2 s with a bounce after 64 ms: the repeat starts 350 ms after the press all the same, 16 moves as without
  let menus = loadMenus();
  menus.send([press(13)]);
  menus.clock.advance(64);
  menus.send([release(13)]);
  menus.clock.advance(16);
  menus.send([press(13)]);
  menus.clock.advance(1920);
  menus.send([release(13)]);
  menus.clock.advance(1000);
  assert.equal(menus.count('down'), 16);

  // A bounce in the middle of a hold doesn't add a step at once: the repeat goes on 100 ms later
  menus = loadMenus();
  menus.send([press(15)]);
  menus.clock.advance(1000);
  const before = menus.count('right');
  menus.send([release(15)]);
  menus.clock.advance(16);
  menus.send([press(15)]);
  assert.equal(menus.count('right'), before);
  menus.clock.advance(250);
  assert.ok(menus.count('right') >= before + 1 && menus.count('right') <= before + 2, 'repeating again: ' + (menus.count('right') - before));
  menus.send([release(15)]);

  // Two deliberate presses 150 ms apart, each held for 70 ms, both step, and so do two that are only 100 ms apart
  [[150, 70], [100, 50], [112, 64]].forEach(([period, held]) => {
    const taps = loadMenus();
    taps.send([press(13)]);
    taps.clock.advance(held);
    taps.send([release(13)]);
    taps.clock.advance(period - held);
    taps.send([press(13)]);
    assert.deepEqual(taps.operations, ['down', 'down'], 'the second press steps at once, ' + period + ' ms after the first');
    taps.clock.advance(held);
    taps.send([release(13)]);
    taps.clock.advance(1000);
    assert.deepEqual(taps.operations, ['down', 'down']);
  });
  // Another direction is never held back by the guard of the first
  const other = loadMenus();
  other.send([press(13)]);
  other.send([release(13)]);
  other.clock.advance(16);
  other.send([press(12)]);
  other.send([release(12)]);
  other.clock.advance(1000);
  assert.deepEqual(other.operations, ['down', 'up']);
  assert.deepEqual(menus.errors().concat(other.errors()), []);
});

test('a new repeat replaces the old one: its timer is cleared and only one repeat runs', () => {
  const menus = loadMenus();
  menus.send([press(13)]);
  menus.clock.advance(200);
  // D-pad right while down is still held takes over the repeat
  menus.send([press(15)]);
  menus.clock.advance(340);
  assert.deepEqual(menus.operations, ['down', 'right'], 'neither the timer of down nor an early repeat of right');
  // Releasing down, which no longer owns the repeat, doesn't stop it
  menus.send([release(13)]);
  menus.clock.advance(1000);
  menus.send([release(15)]);
  menus.clock.advance(1000);
  // Right moves at 200 ms, repeats from 550 ms and then every 112 ms (7 frames) until the release at 1540 ms
  assert.equal(menus.count('right'), 1 + 9);
  assert.equal(menus.count('down'), 1);
});

test('an action button ends a repeat, since its operation runs on the focused item', () => {
  const menus = loadMenus();
  menus.send([press(13)]);
  menus.clock.advance(500);
  const moves = menus.count('down');
  menus.send([press(0)]);
  menus.clock.advance(1000);
  assert.equal(menus.count('down'), moves);
  assert.deepEqual(menus.operations.slice(-1), ['accept']);
});

test('the same buttons of two pads are told apart', () => {
  const menus = loadMenus();
  menus.send([press(13)], 0);
  menus.clock.advance(100);
  // Pad 1 releases its D-pad down, which pad 0 still holds
  menus.send([release(13)], 1);
  menus.clock.advance(900);
  assert.ok(menus.count('down') > 5, 'pad 0 keeps repeating: ' + menus.count('down'));
});

test('a start or stop of the gamepad polling drops what a stick still does in the menus', () => {
  // A stick that swung to the other side when the Stream Menu closed, or a stream started: its release is never
  // reported, so the step back that waits for it, and the repeat after it, would run on for the rest of the stream
  let menus = loadMenus();
  menus.send([axis(1, 0.9)]);
  menus.clock.advance(220);
  menus.send([axis(1, -0.6)]);
  menus.platform.get('resetGamepadMenuInput')();
  menus.clock.advance(3000);
  assert.deepEqual(menus.operations, ['down']);
  assert.equal(menus.platform.get('repeatAction'), null);

  // The direction that the stick left is forgotten as well: a short flick into the other direction right afterwards is
  // a move like any other, not a stick that snaps back
  menus = loadMenus();
  menus.send([axis(1, 0.9)]);
  menus.clock.advance(220);
  menus.send([axis(1, 0)]);
  menus.platform.get('resetGamepadMenuInput')();
  menus.clock.advance(50);
  menus.send([axis(1, -0.9)]);
  menus.clock.advance(100);
  menus.send([axis(1, 0)]);
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['down', 'up']);

  // A held stick or D-pad stops repeating, and the stick steps again once the menus are back
  menus = loadMenus();
  menus.send([axis(0, 0.9)]);
  menus.clock.advance(600);
  const moves = menus.count('right');
  assert.ok(moves >= 2, 'repeating: ' + moves);
  menus.platform.get('resetGamepadMenuInput')();
  menus.clock.advance(2000);
  assert.equal(menus.count('right'), moves);
  menus.send([axis(0, 0.8)]);
  menus.clock.advance(150);
  assert.equal(menus.count('right'), moves + 1, 'the direction held before the reset is forgotten');
  menus.send([axis(0, 0)]);
  assert.deepEqual(menus.errors(), []);

  // The start of a stream and the Stream Menu, when it opens and closes, reset this way
  const source = (file) => fs.readFileSync(path.join(REPO_ROOT, 'wasm/platform', file), 'utf8');
  const body = (text, name) => text.slice(text.indexOf('function ' + name + '('), text.indexOf('\n}\n', text.indexOf('function ' + name + '(')));
  assert.match(body(source('index.js'), 'showStreamMode'), /resetGamepadMenuInput\(\);/);
  assert.match(body(source('menus.js'), 'openStreamMenu'), /resetGamepadMenuInput\(\);\s+Controller\.startWatching\(\);/);
  assert.match(body(source('menus.js'), 'closeStreamMenu'), /Controller\.stopWatching\(\);\s+resetGamepadMenuInput\(\);/);
});
