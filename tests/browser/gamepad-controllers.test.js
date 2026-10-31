'use strict';

// Simulated controllers in the real page (plan WP6): a controller with the standard layout and controllers that report
// a non-standard one (an 8BitDo in D-input mode, a DualShock 4 with the raw layout of its driver). The page logs what a
// controller reports as separate fields, shows a notice once per controller id when its layout is not the standard one,
// lists the connected controllers in System information (with the controller type that the stream announces), and the
// menus work with controllers that woke up with a press, never fired gamepadconnected, or changed their layout.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

const OPERATIONS = ['up', 'down', 'left', 'right', 'accept', 'back', 'press', 'switch'];
// delayedNavigation() runs the accept, back, press and switch operations 50 ms later (BUTTON_NAVIGATION_DELAY)
const AFTER_DELAY_MS = 250;
const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const EIGHTBITDO_ID = '8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)';
const DUALSHOCK_RAW_ID = 'Wireless Controller (Vendor: 054c Product: 09cc)';
const NOTICE = ' has a non-standard button layout, so some buttons may be wrong. Try its XInput or Xbox mode, or another connection.';

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Simulated gamepads for the page, installed before the app starts. navigator.getGamepads() returns the four slots of
// window.__pads; __makePad(index, options) builds a snapshot; __connectPad(pad) fills its slot and fires
// gamepadconnected, like the browser does after the first input of a controller; __disconnectPad(index) empties the slot
// and fires gamepaddisconnected.
function simulatedGamepads() {
  window.__pads = [null, null, null, null];
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => window.__pads.slice(),
  });
  window.__makePad = (index, options) => {
    const opts = options || {};
    const pressed = opts.pressed || [];
    return {
      index,
      id: opts.id,
      mapping: opts.mapping,
      connected: true,
      timestamp: opts.timestamp === undefined ? 1 : opts.timestamp,
      buttons: Array.from({ length: opts.buttons }, (unused, i) => ({ pressed: pressed.indexOf(i) >= 0, value: pressed.indexOf(i) >= 0 ? 1 : 0 })),
      axes: Array.from({ length: opts.axes }, (unused, i) => (opts.axisValues ? opts.axisValues[i] : 0)),
      vibrationActuator: opts.rumble ? { playEffect: () => Promise.resolve(true) } : null,
    };
  };
  const fire = (type, pad) => {
    const event = new Event(type);
    Object.defineProperty(event, 'gamepad', { value: pad });
    window.dispatchEvent(event);
  };
  window.__connectPad = (pad) => {
    window.__pads[pad.index] = pad;
    fire('gamepadconnected', pad);
  };
  window.__disconnectPad = (index) => {
    const pad = window.__pads[index];
    window.__pads[index] = null;
    fire('gamepaddisconnected', Object.assign({}, pad, { connected: false }));
  };
}

const xbox = (index, extra) => Object.assign({ id: XBOX_ID, mapping: 'standard', buttons: 17, axes: 4 }, extra || {});
const eightBitDo = (extra) => Object.assign({ id: EIGHTBITDO_ID, mapping: '', buttons: 16, axes: 6 }, extra || {});
// The raw layout of the Linux driver of a DualShock 4: 13 buttons, and the triggers and the hat switch as axes
const dualShockRaw = (extra) => Object.assign({ id: DUALSHOCK_RAW_ID, mapping: '', buttons: 13, axes: 8, axisValues: [0, 0, -1, 0, 0, -1, 0, 0] }, extra || {});

// Open the app with the simulated gamepads, and record the Navigation operations and the snackbar messages
async function openWithGamepads() {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads] });
  await app.page.evaluate((operations) => {
    window.__navigationOps = [];
    operations.forEach((name) => {
      Navigation[name] = () => window.__navigationOps.push(name);
    });
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    const show = snackbar.showSnackbar.bind(snackbar);
    window.__snackbarMessages = [];
    snackbar.showSnackbar = (data) => {
      window.__snackbarMessages.push(data.message);
      show(data);
    };
  }, OPERATIONS);
  return app;
}

const connect = (page, index, options) => page.evaluate(({ index, options }) => window.__connectPad(window.__makePad(index, options)), { index, options });
const setPad = (page, index, options) => page.evaluate(({ index, options }) => {
  window.__pads[index] = window.__makePad(index, options);
}, { index, options });
const disconnect = (page, index) => page.evaluate((slot) => window.__disconnectPad(slot), index);
const operations = (page) => page.evaluate(() => window.__navigationOps.slice());
const snackbarMessages = (page) => page.evaluate(() => window.__snackbarMessages.slice());

// The lines of System information after the TV lines (innerText turned the line breaks into <br> elements)
function readGamepadLines(page) {
  return page.evaluate(() => document.getElementById('systemInfoBtn').innerHTML.split(/<br\s*\/?>/).filter((line) => /^Gamepad/.test(line)));
}

test('a standard controller is logged with its fields, listed in System information, gets no notice, and its first press counts', async () => {
  const app = await openWithGamepads();
  const { page } = app;
  try {
    assert.deepEqual(await readGamepadLines(page), ['Gamepads: None']);
    // The controller wakes up with a press of A, which is already in the snapshot of its connection event
    await connect(page, 0, xbox(0, { pressed: [0], rumble: true }));
    await page.waitForTimeout(AFTER_DELAY_MS);
    assert.deepEqual(await operations(page), ['accept']);
    assert.ok(app.logs.some((line) => line.indexOf('Gamepad 0 connected: id="' + XBOX_ID + '", mapping="standard", buttons=17, axes=4, rumble=yes, type=Xbox') >= 0),
      JSON.stringify(app.logs.filter((line) => line.indexOf('gamepadconnected') >= 0)));
    assert.deepEqual(await snackbarMessages(page), ['Gamepad 0 has been connected.']);
    assert.deepEqual(await readGamepadLines(page), ['Gamepad 0: Xbox Wireless Controller (standard layout, 17 buttons, 4 axes, rumble: Yes, type: Xbox)']);

    // Releasing A and pressing Select and Start: press and switch
    for (const button of [8, 9]) {
      await setPad(page, 0, xbox(0, { pressed: [button], rumble: true }));
      await page.waitForTimeout(50);
      await setPad(page, 0, xbox(0, { rumble: true }));
      await page.waitForTimeout(AFTER_DELAY_MS);
    }
    assert.deepEqual(await operations(page), ['accept', 'press', 'switch']);

    // Disconnecting logs the fields again and removes it from System information
    await disconnect(page, 0);
    assert.ok(app.logs.some((line) => line.indexOf('Gamepad 0 disconnected: id="' + XBOX_ID + '"') >= 0));
    assert.deepEqual(await readGamepadLines(page), ['Gamepads: None']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('controllers with a non-standard layout get one notice per controller id, also after reconnecting', async () => {
  const app = await openWithGamepads();
  const { page } = app;
  try {
    await connect(page, 0, eightBitDo());
    assert.deepEqual(await snackbarMessages(page), ['Gamepad 0 has been connected.', 'Gamepad 0 (8BitDo SN30 Pro)' + NOTICE]);
    // 8BitDo controllers are announced to the PC as Xbox controllers, the layout of their X-input mode
    assert.ok(app.logs.some((line) => line.indexOf('Gamepad 0 connected: id="' + EIGHTBITDO_ID + '", mapping="", buttons=16, axes=6, rumble=no, type=Xbox') >= 0));
    assert.ok(app.logs.some((line) => line.indexOf('Warning: Gamepad 0 reports a non-standard layout (mapping=""), so its buttons may be mapped wrongly.') >= 0));

    // The same controller again, also in another slot: no second notice
    await disconnect(page, 0);
    await connect(page, 0, eightBitDo());
    await disconnect(page, 0);
    await connect(page, 2, eightBitDo());
    // Another controller with a non-standard layout gets its own notice
    await connect(page, 1, dualShockRaw());
    const messages = await snackbarMessages(page);
    assert.deepEqual(messages.filter((message) => message.indexOf(NOTICE) >= 0), [
      'Gamepad 0 (8BitDo SN30 Pro)' + NOTICE,
      'Gamepad 1 (Wireless Controller)' + NOTICE,
    ]);
    assert.deepEqual(await readGamepadLines(page), [
      'Gamepad 1: Wireless Controller (non-standard layout, 13 buttons, 8 axes, rumble: No, type: PlayStation)',
      'Gamepad 2: 8BitDo SN30 Pro (non-standard layout, 16 buttons, 6 axes, rumble: No, type: Xbox)',
    ]);
    // The triggers of the raw layout rest at -1 on axes 2 and 5, which doesn't move the menus
    await page.waitForTimeout(AFTER_DELAY_MS);
    assert.deepEqual(await operations(page), []);

    // System information and the notice are translated
    await page.evaluate(() => window.i18n.setLanguage('pt-BR'));
    assert.deepEqual(await readGamepadLines(page), [
      'Gamepad 1: Wireless Controller (layout não padrão, 13 botões, 8 eixos, vibração: Não, tipo: PlayStation)',
      'Gamepad 2: 8BitDo SN30 Pro (layout não padrão, 16 botões, 6 eixos, vibração: Não, tipo: Xbox)',
    ]);
    await connect(page, 3, dualShockRaw({ id: 'Generic USB Joystick (Vendor: 0079 Product: 0006)' }));
    assert.equal((await snackbarMessages(page)).slice(-1)[0],
      'O gamepad 3 (Generic USB Joystick) tem um layout de botões não padrão, então alguns botões podem estar errados. Tente o modo XInput ou Xbox dele, ou outra conexão.');
    // A controller of an unknown type
    assert.equal((await readGamepadLines(page)).slice(-1)[0],
      'Gamepad 3: Generic USB Joystick (layout não padrão, 13 botões, 8 eixos, vibração: Não, tipo: Desconhecido)');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('System information names the controller type that the stream announces, also when the setting overrides it', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { controllerType: 'PlayStation' }, initScripts: [simulatedGamepads] });
  const { page } = app;
  try {
    await connect(page, 0, xbox(0));
    await connect(page, 1, dualShockRaw());
    // The setting PlayStation is sent for every controller (gamepad.cpp), so a controller detected as another type
    // names both, like the log of the stream
    assert.deepEqual(await readGamepadLines(page), [
      'Gamepad 0: Xbox Wireless Controller (standard layout, 17 buttons, 4 axes, rumble: No, type: PlayStation (setting, detected: Xbox))',
      'Gamepad 1: Wireless Controller (non-standard layout, 13 buttons, 8 axes, rumble: No, type: PlayStation)',
    ]);
    assert.ok(app.logs.some((line) => line.indexOf('(controller type setting: PlayStation)') >= 0));
    // Back on Auto, the detected type is the one sent
    await page.evaluate(() => saveControllerType.call($('.controllerTypeMenu li[data-value="Auto"]')[0]));
    await page.evaluate(() => loadSystemInfo());
    assert.deepEqual(await readGamepadLines(page), [
      'Gamepad 0: Xbox Wireless Controller (standard layout, 17 buttons, 4 axes, rumble: No, type: Xbox)',
      'Gamepad 1: Wireless Controller (non-standard layout, 13 buttons, 8 axes, rumble: No, type: PlayStation)',
    ]);
    // A controller of an unknown type with the setting Nintendo, translated
    await page.evaluate(() => saveControllerType.call($('.controllerTypeMenu li[data-value="Nintendo"]')[0]));
    await connect(page, 2, dualShockRaw({ id: 'Generic USB Joystick (Vendor: 0079 Product: 0006)' }));
    await page.evaluate(() => window.i18n.setLanguage('pt-BR'));
    assert.equal((await readGamepadLines(page)).slice(-1)[0],
      'Gamepad 2: Generic USB Joystick (layout não padrão, 13 botões, 8 eixos, vibração: Não, tipo: Nintendo (configuração, detectado: Desconhecido))');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a controller that never fired gamepadconnected works in the menus and is listed in System information', async () => {
  const app = await openWithGamepads();
  const { page } = app;
  try {
    // The controller appears in its slot without an event, with its first press already held
    await setPad(page, 1, xbox(1, { pressed: [13] }));
    await page.waitForTimeout(100);
    await setPad(page, 1, xbox(1));
    await page.waitForTimeout(AFTER_DELAY_MS);
    assert.deepEqual(await operations(page), ['down']);
    assert.ok(app.logs.some((line) => line.indexOf('Found gamepad 1 without a connection event: id="' + XBOX_ID + '"') >= 0));
    await page.evaluate(() => loadSystemInfo());
    assert.deepEqual(await readGamepadLines(page), ['Gamepad 1: Xbox Wireless Controller (standard layout, 17 buttons, 4 axes, rumble: No, type: Xbox)']);
    // A Tizen placeholder, which never sent input, is neither listed nor used
    await setPad(page, 0, xbox(0, { timestamp: 0, pressed: [0] }));
    await page.waitForTimeout(AFTER_DELAY_MS);
    await page.evaluate(() => loadSystemInfo());
    assert.equal((await readGamepadLines(page)).length, 1);
    assert.deepEqual(await operations(page), ['down']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a controller whose layout changes keeps working in the menus without errors', async () => {
  const app = await openWithGamepads();
  const { page } = app;
  try {
    await connect(page, 0, xbox(0));
    // The controller switches to another mode and reports one more button
    await setPad(page, 0, xbox(0, { buttons: 18 }));
    await page.waitForTimeout(100);
    await setPad(page, 0, xbox(0, { buttons: 18, pressed: [1] }));
    await page.waitForTimeout(50);
    await setPad(page, 0, xbox(0, { buttons: 18 }));
    await page.waitForTimeout(AFTER_DELAY_MS);
    assert.deepEqual(await operations(page), ['back']);
    assert.equal(app.logs.filter((line) => line.indexOf('Gamepad 0 changed its layout or was replaced') >= 0).length, 1);
    assert.equal(app.logs.filter((line) => line.indexOf('does not match the saved one') >= 0).length, 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
