'use strict';

// Checks the button mapping of wasm/platform/button_mapping.js in the real page (Settings > Input Settings > Button
// mapping), reached with the remote and a gamepad: LEFT and RIGHT change what a button presses for every controller, the
// change is stored and goes to the stream with its start request; a connected controller gets a mapping of its own,
// which a reset forgets; the calibration of its sticks from what they report at rest and at their edge; and the stored
// switches 'Flip A/B face buttons' and 'Flip X/Y face buttons' of an earlier version as the mapping for every controller.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, openApp, readStorage, reloadApp, waitForStorage } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const XBOX_STREAM_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product';
const IDENTITY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// Simulated gamepads, installed before the app starts
function simulatedGamepads() {
  window.__pads = [null, null, null, null];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__pads.slice() });
  window.__connectPad = (index, id) => {
    const pad = {
      index, id, mapping: 'standard', connected: true, timestamp: 1, vibrationActuator: null,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0],
    };
    window.__pads[index] = pad;
    const event = new Event('gamepadconnected');
    Object.defineProperty(event, 'gamepad', { value: pad });
    window.dispatchEvent(event);
  };
}

// Press and release a key of the remote on the focused element, like the TV delivers it
const remoteKey = (page, keyCode, key) => page.evaluate(({ code, name }) => {
  ['keydown', 'keyup'].forEach((type) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  });
}, { code: keyCode, name: key });
const RETURN = [10009, 'XF86Back'];
const UP = [38, 'ArrowUp'];
const DOWN = [40, 'ArrowDown'];
const LEFT = [37, 'ArrowLeft'];
const RIGHT = [39, 'ArrowRight'];
const ENTER = [13, 'Enter'];

// A button of a gamepad of the menus, pressed and released (handleGamepadMenuInput() of index.js), and the delay of the
// navigation of its action buttons
async function gamepadButton(page, index) {
  await page.evaluate((button) => {
    handleGamepadMenuInput({ detail: { gamepad: 0, changes: [{ type: 'button', index: button, pressed: true }] } });
    handleGamepadMenuInput({ detail: { gamepad: 0, changes: [{ type: 'button', index: button, pressed: false }] } });
  }, index);
  await page.waitForTimeout(250);
}

// Open the button mapping from the Input Settings with the remote
async function openMapping(page) {
  await page.evaluate(() => $('#settingsBtn').trigger('click'));
  await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
  await page.evaluate(() => handleSettingsView('inputSettings'));
  await page.waitForTimeout(400);
  await remoteKey(page, ...DOWN);
  await remoteKey(page, ...DOWN);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'buttonMappingBtn');
  await remoteKey(page, ...ENTER);
  await page.waitForTimeout(150);
}

// What the menu shows: the focused row, the controller, the note and the target of each button
const readMenu = (page) => page.evaluate(() => ({
  focus: document.activeElement.id,
  controller: document.getElementById('buttonMappingController').textContent,
  subtitle: document.getElementById('buttonMappingSubtitle').textContent,
  targets: Array.from({ length: 16 }, (unused, i) => document.getElementById('buttonMappingValue' + i).textContent),
  changed: Array.from({ length: 16 }, (unused, i) => document.getElementById('buttonMappingValue' + i).classList.contains('is-pending')),
  calibrate: !document.getElementById('buttonMappingCalibrate').hidden,
}));

const NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'SELECT', 'START', 'LS', 'RS', 'D-PAD UP', 'D-PAD DOWN', 'D-PAD LEFT', 'D-PAD RIGHT'];

// A host whose launch request succeeds at once, and the start request of app 8 that it leads to
function startRequest(page) {
  return page.evaluate(async () => {
    showApps = () => Promise.resolve();
    Module.stopStream = () => {
      handleMessage('streamTerminated: 0');
      return { type: 'resolve', ret: null };
    };
    window.__startStreamArgs = null;
    startGame({
      paired: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03, refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
      launchApp: () => Promise.resolve('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>'),
    }, 8);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const args = window.__startStreamArgs;
    Module.stopStream();
    return args;
  });
}

test('LEFT and RIGHT change what a button presses for every controller, which is stored and goes to the stream', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads] });
  try {
    await openMapping(app.page);
    let menu = await readMenu(app.page);
    assert.deepEqual(menu, {
      focus: 'buttonMappingSelect', controller: 'All controllers', subtitle: 'Xbox layout: A = bottom button', targets: NAMES,
      changed: Array(16).fill(false), calibrate: false,
    });
    // A presses B, then each button in turn and None, and LEFT goes back
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...RIGHT);
    menu = await readMenu(app.page);
    assert.equal(menu.focus, 'buttonMappingRow0');
    assert.deepEqual([menu.targets[0], menu.changed[0]], ['B', true]);
    let stored = await waitForStorage(app.page, (values) => values.controllerMappings && values.controllerMappings.controllers['*']);
    assert.deepEqual(stored.controllerMappings, { version: 1, controllers: { '*': { name: '', buttons: [1].concat(IDENTITY.slice(1)) } } });
    for (let i = 0; i < 15; i++) {
      await remoteKey(app.page, ...RIGHT);
    }
    assert.equal((await readMenu(app.page)).targets[0], 'None');
    await remoteKey(app.page, ...RIGHT);
    assert.deepEqual((await readMenu(app.page)).targets[0], 'A');
    await remoteKey(app.page, ...LEFT);
    assert.equal((await readMenu(app.page)).targets[0], 'None');
    // OK steps forward too; Y presses X
    for (let i = 0; i < 3; i++) {
      await remoteKey(app.page, ...DOWN);
    }
    assert.equal((await readMenu(app.page)).focus, 'buttonMappingRow3');
    await remoteKey(app.page, ...LEFT);
    menu = await readMenu(app.page);
    assert.deepEqual([menu.targets[0], menu.targets[3]], ['None', 'X']);
    stored = await waitForStorage(app.page, (values) => values.controllerMappings.controllers['*'].buttons[3] === 2);
    assert.deepEqual(stored.controllerMappings.controllers['*'].buttons, [-1, 1, 2, 2].concat(IDENTITY.slice(4)));
    // RETURN closes the menu with the focus back on its button
    await remoteKey(app.page, ...RETURN);
    await app.page.waitForTimeout(150);
    assert.deepEqual(await app.page.evaluate(() => [getComputedStyle(document.getElementById('buttonMappingOverlay')).display,
      document.activeElement.id, isDialogOpen]), ['none', 'buttonMappingBtn', false]);
    // The next stream gets the mapping as the text of wasm/controller_mapping.hpp
    const args = await startRequest(app.page);
    assert.equal(args[16], '-1,1,2,2,4,5,6,7,8,9,10,11,12,13,14,15;;*');
    assert.ok(app.logs.some((line) => line.indexOf('Button mapping: 1 controller lines') >= 0));
    // It is kept after a restart
    await reloadApp(app);
    assert.deepEqual(await app.page.evaluate(() => buttonMappings.controllers['*'].buttons), [-1, 1, 2, 2].concat(IDENTITY.slice(4)));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a connected controller gets a mapping of its own, its sticks a calibration, and a reset forgets both', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads] });
  try {
    await app.page.evaluate((id) => window.__connectPad(0, id), XBOX_ID);
    await app.page.evaluate(() => {
      window.__snackbar = [];
      document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbar.push(data.message);
    });
    await openMapping(app.page);
    await remoteKey(app.page, ...RIGHT);
    let menu = await readMenu(app.page);
    assert.deepEqual([menu.controller, menu.subtitle, menu.calibrate], ['Xbox Wireless Controller', 'Buttons of all controllers', true]);
    // D-pad left presses D-pad right on this controller only
    for (let i = 0; i < 15; i++) {
      await remoteKey(app.page, ...DOWN);
    }
    assert.equal((await readMenu(app.page)).focus, 'buttonMappingRow14');
    await remoteKey(app.page, ...RIGHT);
    menu = await readMenu(app.page);
    assert.deepEqual([menu.subtitle, menu.targets[14]], ['Own buttons', 'D-PAD RIGHT']);
    let stored = await waitForStorage(app.page, (values) => values.controllerMappings && values.controllerMappings.controllers[XBOX_STREAM_ID]);
    assert.deepEqual(stored.controllerMappings.controllers, {
      [XBOX_STREAM_ID]: { name: 'Xbox Wireless Controller', buttons: IDENTITY.slice(0, 14).concat([15, 15]) },
    });
    // UP from the controller row goes round to Close, Reset and Calibrate
    await app.page.evaluate(() => {
      Views.ButtonMappingMenu.view.index = 0;
      Navigation.switch();
    });
    await remoteKey(app.page, ...UP);
    await remoteKey(app.page, ...UP);
    await remoteKey(app.page, ...UP);
    assert.equal((await readMenu(app.page)).focus, 'buttonMappingCalibrate');
    // The sticks rest a little off-centre, then go round their edge, and the sticks move nothing in the menu meanwhile
    await app.page.evaluate(() => {
      window.__pads[0].axes = [0.04, -0.02, 0.0, 0.0];
    });
    await remoteKey(app.page, ...ENTER);
    await app.page.waitForTimeout(200);
    const rest = await app.page.evaluate(() => ({
      title: document.getElementById('buttonCalibrationTitle').textContent,
      text: document.getElementById('buttonCalibrationText').textContent,
      values: document.getElementById('buttonCalibrationValues').textContent,
      focus: document.activeElement.id,
    }));
    assert.deepEqual(rest, {
      title: 'Calibrate the sticks of Xbox Wireless Controller', text: 'Leave both sticks at rest, then press OK. RETURN cancels.',
      values: 'Left stick: X 0.04, Y -0.02\nRight stick: X 0.00, Y 0.00', focus: 'buttonCalibrationContinue',
    });
    await remoteKey(app.page, ...ENTER);
    for (const axes of [[-0.9, 0, -0.95, 0], [0.92, 0, 0.95, 0], [0, -0.88, 0, -0.9], [0, 0.95, 0, 0.9]]) {
      await app.page.evaluate((values) => {
        window.__pads[0].axes = values;
      }, axes);
      await app.page.waitForTimeout(60);
    }
    await remoteKey(app.page, ...DOWN);
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'buttonCalibrationContinue');
    assert.equal(await app.page.evaluate(() => document.getElementById('buttonCalibrationContinueLabel').textContent), 'Save');
    await remoteKey(app.page, ...ENTER);
    await app.page.waitForTimeout(100);
    stored = await waitForStorage(app.page, (values) => values.controllerMappings.controllers[XBOX_STREAM_ID].sticks);
    assert.deepEqual(stored.controllerMappings.controllers[XBOX_STREAM_ID].sticks, [
      { centreX: 0.04, centreY: -0.02, minX: -0.9, maxX: 0.92, minY: -0.88, maxY: 0.95 },
      { centreX: 0, centreY: 0, minX: -0.95, maxX: 0.95, minY: -0.9, maxY: 0.9 },
    ]);
    // Back on the rows, where the stick that is still held doesn't move the focus on
    await app.page.waitForTimeout(300);
    menu = await readMenu(app.page);
    assert.deepEqual([menu.focus, menu.subtitle], ['buttonMappingCalibrate', 'Own buttons · Sticks calibrated']);
    assert.ok(await app.page.evaluate(() => window.__snackbar.indexOf('The sticks are calibrated.') >= 0));
    const args = await startRequest(app.page);
    assert.equal(args[16], IDENTITY.slice(0, 14).concat([15, 15]).join(',') + ';0.04,-0.02,-0.9,0.92,-0.88,0.95,0,0,-0.95,0.95,-0.9,0.9;' + XBOX_STREAM_ID);
    // A reset of the controller forgets its buttons and calibration (the stream above left the navigation of the menus
    // stopped, so the controller is chosen as its row would)
    await app.page.evaluate(() => {
      ButtonMappingMenu.open();
      ButtonMappingMenu.step(document.getElementById('buttonMappingSelect'), 1);
      $('#buttonMappingReset').trigger('click');
    });
    stored = await waitForStorage(app.page, (values) => !values.controllerMappings.controllers[XBOX_STREAM_ID]);
    assert.deepEqual(stored.controllerMappings.controllers, {});
    assert.ok(await app.page.evaluate(() => window.__snackbar.indexOf('The buttons and sticks of Xbox Wireless Controller are reset.') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a calibration needs sticks that moved far enough, and RETURN cancels it', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads] });
  try {
    await app.page.evaluate((id) => window.__connectPad(0, id), XBOX_ID);
    await app.page.evaluate(() => {
      window.__snackbar = [];
      document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbar.push(data.message);
      ButtonMappingMenu.open();
    });
    await app.page.waitForTimeout(100);
    await remoteKey(app.page, ...RIGHT);
    await app.page.evaluate(() => $('#buttonMappingCalibrate').trigger('click'));
    await app.page.waitForTimeout(100);
    await remoteKey(app.page, ...ENTER);
    await app.page.evaluate(() => {
      window.__pads[0].axes = [0.1, 0, 0, 0];
    });
    await app.page.waitForTimeout(100);
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await app.page.evaluate(() => window.__snackbar),
      ['The sticks didn\'t move far enough to calibrate them. Move them around their whole edge.']);
    // Back at the first step, and RETURN goes back to the rows without a calibration
    assert.equal(await app.page.evaluate(() => document.getElementById('buttonCalibrationContinueLabel').textContent), 'Continue');
    await remoteKey(app.page, ...RETURN);
    await app.page.waitForTimeout(100);
    assert.deepEqual(await app.page.evaluate(() => [getComputedStyle(document.getElementById('buttonCalibrationPanel')).display,
      getComputedStyle(document.getElementById('buttonMappingPanel')).display, document.activeElement.id]), ['none', 'block', 'buttonMappingSelect']);
    assert.deepEqual((await readStorage(app.page)).controllerMappings, undefined);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// A list of every reading made the polls quadratic, so the test has a time limit of its own
test('a calibration left open for long keeps the range of the sticks, not every reading, and still saves', { timeout: 120000 }, async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads] });
  try {
    await app.page.evaluate((id) => window.__connectPad(0, id), XBOX_ID);
    // The polls of the calibration (every 20 ms) are run by the test instead of the timer
    await app.page.evaluate(() => {
      window.__snackbar = [];
      document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbar.push(data.message);
      const realSetInterval = window.setInterval;
      window.setInterval = (fn, ms) => {
        if (ms === 20) {
          window.__calibrationPoll = fn;
          return 0;
        }
        return realSetInterval(fn, ms);
      };
      ButtonMappingMenu.open();
    });
    await app.page.waitForTimeout(100);
    await remoteKey(app.page, ...RIGHT);
    await app.page.evaluate(() => $('#buttonMappingCalibrate').trigger('click'));
    await app.page.waitForTimeout(100);
    const run = await app.page.evaluate(() => {
      window.__pads[0].axes = [0.02, -0.02, 0, 0];
      for (let i = 0; i < 100; i++) {
        window.__calibrationPoll();
      }
      $('#buttonCalibrationContinue').trigger('click');
      // About 50 minutes of polls while the sticks go round their edge, which a list of every reading made slower with
      // every poll until Math.min.apply() threw a RangeError
      const started = performance.now();
      const edge = [[-0.9, 0, -0.95, 0], [0.92, 0, 0.95, 0], [0, -0.88, 0, -0.9], [0, 0.95, 0, 0.9]];
      for (let i = 0; i < 150000; i++) {
        window.__pads[0].axes = edge[i % 4];
        window.__calibrationPoll();
      }
      const values = document.getElementById('buttonCalibrationValues').textContent;
      $('#buttonCalibrationContinue').trigger('click');
      return { ms: performance.now() - started, values };
    });
    assert.ok(run.ms < 20000, 'the polls took ' + run.ms + ' ms');
    assert.equal(run.values, 'Left stick: X 0.00 (-0.90 … 0.92), Y 0.95 (-0.88 … 0.95)\nRight stick: X 0.00 (-0.95 … 0.95), Y 0.90 (-0.90 … 0.90)');
    const stored = await waitForStorage(app.page, (values) => values.controllerMappings && values.controllerMappings.controllers[XBOX_STREAM_ID]);
    assert.deepEqual(stored.controllerMappings.controllers[XBOX_STREAM_ID].sticks, [
      { centreX: 0.02, centreY: -0.02, minX: -0.9, maxX: 0.92, minY: -0.88, maxY: 0.95 },
      { centreX: 0, centreY: 0, minX: -0.95, maxX: 0.95, minY: -0.9, maxY: 0.9 },
    ]);
    assert.ok(await app.page.evaluate(() => window.__snackbar.indexOf('The sticks are calibrated.') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the menu works with a gamepad: the D-pad moves and changes, A steps, B closes', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', locale: 'de_DE' }, initScripts: [simulatedGamepads] });
  try {
    await app.page.evaluate(() => $('#settingsBtn').trigger('click'));
    await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await app.page.evaluate(() => {
      handleSettingsView('inputSettings');
      Views.InputSettings.view.index = 2;
    });
    await app.page.waitForTimeout(400);
    await gamepadButton(app.page, 0);
    let menu = await readMenu(app.page);
    assert.deepEqual([menu.focus, menu.controller, menu.subtitle], ['buttonMappingSelect', 'Alle Controller', 'Xbox-Layout: A = untere Taste']);
    // D-pad down to B, D-pad right: B presses X, A on the row: Y
    await gamepadButton(app.page, 13);
    await gamepadButton(app.page, 13);
    await gamepadButton(app.page, 15);
    assert.equal((await readMenu(app.page)).targets[1], 'X');
    await gamepadButton(app.page, 0);
    menu = await readMenu(app.page);
    assert.deepEqual([menu.focus, menu.targets[1]], ['buttonMappingRow1', 'Y']);
    await waitForStorage(app.page, (values) => values.controllerMappings && values.controllerMappings.controllers['*'].buttons[1] === 3);
    await gamepadButton(app.page, 1);
    assert.equal(await app.page.evaluate(() => getComputedStyle(document.getElementById('buttonMappingOverlay')).display), 'none');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the stored face button swaps of an earlier version become the mapping for every controller, once', async () => {
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads],
    stored: { uniqueid: '0123456789abcdef', flipABfaceButtons: true, flipXYfaceButtons: true },
  });
  try {
    const stored = await waitForStorage(app.page, (values) => values.controllerMappings);
    assert.deepEqual(stored.controllerMappings, { version: 1, controllers: { '*': { name: '', buttons: [1, 0, 3, 2].concat(IDENTITY.slice(4)) } } });
    assert.ok(app.logs.some((line) => line.indexOf('Moving the stored face button swaps into the button mapping: A/B true, X/Y true') >= 0));
    // The stream swaps them as before
    const args = await startRequest(app.page);
    assert.equal(args[16], '1,0,3,2,4,5,6,7,8,9,10,11,12,13,14,15;;*');
    // A change of the mapping stays: the swaps are moved only once
    await app.page.evaluate(() => saveButtonMappings(resetControllerMapping(buttonMappings, '*')));
    await waitForStorage(app.page, (values) => Object.keys(values.controllerMappings.controllers).length === 0);
    await reloadApp(app);
    assert.deepEqual(await app.page.evaluate(() => buttonMappings), { version: 1, controllers: {} });
    assert.equal((await startRequest(app.page))[16], '');
    // An install with only one of them off: only the other one is swapped
    const single = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { uniqueid: '0123456789abcdef', flipABfaceButtons: false, flipXYfaceButtons: true } });
    try {
      assert.deepEqual((await waitForStorage(single.page, (values) => values.controllerMappings)).controllerMappings.controllers['*'].buttons,
        [0, 1, 3, 2].concat(IDENTITY.slice(4)));
    } finally {
      await single.context.close();
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
