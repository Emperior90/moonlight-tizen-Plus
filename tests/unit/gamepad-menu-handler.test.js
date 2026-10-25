'use strict';

// Pins how a gamepad drives the menus: handleGamepadMenuInput() of wasm/platform/index.js maps the
// 'gamepadinputchanged' events of gamepad.js to Navigation operations, with the navigation delay and the auto-repeat of a
// held D-pad or stick (plan WP6). It runs here with a simulated clock (timers, an animation frame every 16 ms and
// Date.now()), so the moves of a held input can be counted exactly; tests/browser/gamepad-menu.test.js checks the
// mapping in the real page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

const NAVIGATION_API = ['up', 'down', 'left', 'right', 'accept', 'back', 'press', 'switch', 'push', 'change', 'pop', 'start', 'stop'];
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

test('A accepts, B goes back, Select presses and Start switches, each after the navigation delay', () => {
  const menus = loadMenus();
  const delay = menus.platform.get('NAVIGATION_DELAY');
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
  assert.deepEqual(menus.snackbars, [['Gamepad %1$s has been disconnected.', 0]]);
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
    menus.send([axis(1, 0.4)]);
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

test('the stick moves in the new direction when it goes straight from one side to the other', () => {
  const menus = loadMenus();
  menus.send([axis(0, -0.9)]);
  menus.clock.advance(200);
  menus.send([axis(0, 0.9)]);
  menus.clock.advance(200);
  menus.send([axis(0, 0)]);
  menus.clock.advance(1000);
  assert.deepEqual(menus.operations, ['left', 'right']);
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
