'use strict';

// Pins how a gamepad drives the menus in the real page: the 'gamepadinputchanged' handler of attachListeners()
// (wasm/platform/index.js) maps buttons and sticks to Navigation operations, and the Controller of gamepad.js polls
// navigator.getGamepads() only while the menus are shown. The Select and Start buttons are known bugs (plan finding
// C6): the in-app guide promises Select = press and Start = switch, but Select throws and Start does nothing.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

const OPERATIONS = ['up', 'down', 'left', 'right', 'accept', 'back', 'press', 'switch'];
// delayedNavigation() runs the accept, back and stick moves 150 ms later (NAVIGATION_DELAY)
const AFTER_DELAY_MS = 250;

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Replace the Navigation operations with recorders, so the test sees what a gamepad input asks for
function recordNavigation(page) {
  return page.evaluate((operations) => {
    window.__navigationOps = [];
    operations.forEach((name) => {
      Navigation[name] = () => window.__navigationOps.push(name);
    });
  }, OPERATIONS);
}

// Send gamepad changes to the menu handler, like gamepad.js does after a poll, and return the operations that ran
// synchronously during the dispatch (the delayed ones run later from a timer)
function sendChanges(page, changes) {
  return page.evaluate((list) => {
    const before = window.__navigationOps.length;
    window.dispatchEvent(new CustomEvent('gamepadinputchanged', { detail: { changes: list } }));
    return window.__navigationOps.slice(before);
  }, changes);
}

const press = (index) => ({ type: 'button', index, pressed: true });
const release = (index) => ({ type: 'button', index, pressed: false });
const operations = (page) => page.evaluate(() => window.__navigationOps.slice());

// Open the app and send the given changes on their own, returning the operations and page errors they caused
async function runChanges(changeGroups) {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await recordNavigation(app.page);
    for (const changes of changeGroups) {
      await sendChanges(app.page, changes);
    }
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    return { ops: await operations(app.page), errors: app.errors.slice() };
  } finally {
    await app.context.close();
  }
}

test('A accepts and B goes back, after the navigation delay', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await recordNavigation(app.page);
    assert.deepEqual(await sendChanges(app.page, [press(0)]), [], 'nothing before the delay');
    await sendChanges(app.page, [release(0)]);
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    assert.deepEqual(await operations(app.page), ['accept']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
  const back = await runChanges([[press(1)], [release(1)]]);
  assert.deepEqual(back.ops, ['back']);
  assert.deepEqual(back.errors, []);
});

test('the D-pad moves right away', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await recordNavigation(app.page);
    const moves = [];
    for (const button of [12, 13, 14, 15]) {
      moves.push((await sendChanges(app.page, [press(button)])).join());
      await sendChanges(app.page, [release(button)]);
    }
    assert.deepEqual(moves, ['up', 'down', 'left', 'right']);
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    assert.deepEqual(await operations(app.page), ['up', 'down', 'left', 'right'], 'nothing more after the delay');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the left stick moves past half deflection', async () => {
  const down = await runChanges([[{ type: 'axis', index: 1, value: 0.9 }], [{ type: 'axis', index: 1, value: 0 }]]);
  assert.deepEqual(down.ops, ['down']);
  const left = await runChanges([[{ type: 'axis', index: 0, value: -0.9 }], [{ type: 'axis', index: 0, value: 0 }]]);
  assert.deepEqual(left.ops, ['left']);
  const small = await runChanges([[{ type: 'axis', index: 0, value: 0.3 }], [{ type: 'axis', index: 0, value: 0 }]]);
  assert.deepEqual(small.ops, [], 'below the 0.5 threshold');
});

test('a held D-pad repeats after 350 ms and stops on release', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await recordNavigation(app.page);
    // Timed inside the page, so a slow test machine delays the samples together with the timers of the app
    const counts = await app.page.evaluate(() => new Promise((resolve) => {
      const send = (pressed) => window.dispatchEvent(new CustomEvent('gamepadinputchanged', { detail: { changes: [{ type: 'button', index: 13, pressed }] } }));
      const result = {};
      send(true);
      result.atPress = window.__navigationOps.length;
      setTimeout(() => {
        result.before350 = window.__navigationOps.length;
      }, 250);
      setTimeout(() => {
        result.held = window.__navigationOps.length;
        send(false);
        setTimeout(() => {
          result.afterRelease = window.__navigationOps.length;
          result.ops = window.__navigationOps.slice();
          resolve(result);
        }, 400);
      }, 1000);
    }));
    assert.equal(counts.atPress, 1, 'the press moves right away');
    assert.equal(counts.before350, 1, 'no repeat before 350 ms');
    assert.ok(counts.held >= 3, 'expected repeats while held, got ' + counts.held + ' moves');
    assert.equal(counts.afterRelease, counts.held, 'no moves after the release');
    assert.ok(counts.ops.every((op) => op === 'down'), JSON.stringify(counts.ops));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Select (button 8) presses without errors', {
  todo: 'Known bug C6 (plan WP6): Select calls Navigation.move(), which does not exist, and throws',
}, async () => {
  const result = await runChanges([[press(8)], [release(8)]]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.ops, ['press']);
});

test('Start (button 9) switches', {
  todo: 'Known bug C6 (plan WP6): Start is not mapped, although the Navigation Guide promises Start = switch',
}, async () => {
  const result = await runChanges([[press(9)], [release(9)]]);
  assert.deepEqual(result.ops, ['switch']);
});

// Simulated gamepad for the page, installed before the app starts: navigator.getGamepads() returns window.__pad,
// the calls are counted, and every 'gamepadinputchanged' change is collected in window.__changes
function simulatedGamepad() {
  const makeButton = () => ({ pressed: false, value: 0 });
  window.__pad = { index: 0, id: 'Test pad', mapping: 'standard', connected: true, timestamp: 1, buttons: Array.from({ length: 17 }, makeButton), axes: [0, 0, 0, 0] };
  window.__getGamepadsCalls = 0;
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => {
      window.__getGamepadsCalls++;
      return [window.__pad, null, null, null];
    },
  });
  window.__listenerCount = { gamepadconnected: 0, gamepaddisconnected: 0 };
  const addListener = window.addEventListener.bind(window);
  window.addEventListener = function(type) {
    if (type in window.__listenerCount) {
      window.__listenerCount[type]++;
    }
    return addListener.apply(window, arguments);
  };
  window.__changes = [];
  addListener('gamepadinputchanged', (event) => window.__changes.push.apply(window.__changes, event.detail.changes));
}

test('the menu polling reports pad input, pauses while streaming and does not replay input held meanwhile', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepad] });
  const { page } = app;
  try {
    // Announce the pad like the browser does after its first input
    await page.evaluate(() => {
      const event = new Event('gamepadconnected');
      Object.defineProperty(event, 'gamepad', { value: window.__pad });
      window.dispatchEvent(event);
    });
    await page.evaluate(() => {
      window.__changes = [];
      window.__pad.buttons[13] = { pressed: true, value: 1 };
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      window.__pad.buttons[13] = { pressed: false, value: 0 };
    });
    await page.waitForTimeout(100);
    let changes = await page.evaluate(() => window.__changes);
    assert.ok(changes.some((c) => c.index === 13 && c.pressed) && changes.some((c) => c.index === 13 && !c.pressed), JSON.stringify(changes));

    // Stream mode stops the polling of the menus and cancels a held repeat
    await page.evaluate(() => {
      repeatAction = () => {};
      showStreamMode();
    });
    const callsAtPause = await page.evaluate(() => window.__getGamepadsCalls);
    await page.evaluate(() => {
      window.__changes = [];
      window.__pad.buttons[8] = { pressed: true, value: 1 };
      window.__pad.axes[0] = 0.9;
    });
    await page.waitForTimeout(300);
    const paused = await page.evaluate(() => ({ calls: window.__getGamepadsCalls, changes: window.__changes, repeat: repeatAction }));
    assert.equal(paused.calls, callsAtPause, 'no getGamepads() calls from the menus while streaming');
    assert.deepEqual(paused.changes, []);
    assert.equal(paused.repeat, null);

    // Back in the menus the polling resumes, and the input held during the stream is the new resting state
    await page.evaluate(() => showAppsMode());
    await page.waitForTimeout(200);
    const resumed = await page.evaluate(() => ({ calls: window.__getGamepadsCalls, changes: window.__changes }));
    assert.ok(resumed.calls > paused.calls + 10, 'polling resumed');
    assert.deepEqual(resumed.changes, []);
    await page.evaluate(() => {
      window.__pad.buttons[8] = { pressed: false, value: 0 };
      window.__pad.axes[0] = 0;
    });
    await page.waitForTimeout(100);
    changes = await page.evaluate(() => window.__changes);
    assert.ok(changes.some((c) => c.index === 8 && !c.pressed) && changes.some((c) => c.type === 'axis' && c.index === 0 && c.value === 0), JSON.stringify(changes));

    // Several stream cycles never add the connection listeners twice: index.js adds one for its log, gamepad.js one
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        showStreamMode();
        showAppsMode();
        showHostsMode();
      });
    }
    assert.deepEqual(await page.evaluate(() => window.__listenerCount), { gamepadconnected: 2, gamepaddisconnected: 2 });
    // A single 5 ms interval gives at most about 250 calls per second
    const before = await page.evaluate(() => window.__getGamepadsCalls);
    await page.waitForTimeout(1000);
    const perSecond = (await page.evaluate(() => window.__getGamepadsCalls)) - before;
    assert.ok(perSecond > 50 && perSecond <= 260, 'getGamepads() calls per second: ' + perSecond);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
