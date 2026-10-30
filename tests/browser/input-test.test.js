'use strict';

// Checks the input test of wasm/platform/input_test.js in the real page (Settings > Input Settings > Input test), reached
// with the remote and a gamepad: every key shows with its name, key code and how long it was held, also a held key with
// its repeats, and no key reaches the menus or does its usual action (RED, DOWN); RETURN shows and then leaves the test;
// each simulated controller is drawn live (pressed buttons, the bar of a trigger, the dot of a stick, the readout of its
// buttons and axes); a hold of B for 2 seconds leaves it; the media keys of the TV are listed as registered or left to
// the TV; the controllers are read only while it is open; and it registers no keys.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, openApp } = require('./harness');

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

// Simulated gamepads, installed before the app starts: navigator.getGamepads() returns window.__pads and counts its calls
function simulatedGamepads() {
  window.__pads = [null, null, null, null];
  window.__getGamepadsCalls = 0;
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => {
      window.__getGamepadsCalls++;
      return window.__pads.slice();
    },
  });
  window.__connectPad = (index, id, mapping) => {
    const pad = {
      index, id, mapping: mapping === undefined ? 'standard' : mapping, connected: true, timestamp: 1, vibrationActuator: null,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0],
    };
    window.__pads[index] = pad;
    const event = new Event('gamepadconnected');
    Object.defineProperty(event, 'gamepad', { value: pad });
    window.dispatchEvent(event);
  };
  window.__setButton = (index, button, pressed, value) => {
    window.__pads[index].buttons[button] = { pressed, value: value === undefined ? (pressed ? 1 : 0) : value };
  };
}

// Press or release a key of the remote on the focused element, like the TV delivers it
const remoteKeyEvent = (page, type, keyCode, key, repeat) => page.evaluate(({ eventType, code, name, isRepeat }) => {
  const event = new KeyboardEvent(eventType, { key: name, bubbles: true, cancelable: true, repeat: !!isRepeat });
  Object.defineProperty(event, 'keyCode', { value: code });
  Object.defineProperty(event, 'which', { value: code });
  (document.activeElement || document.body).dispatchEvent(event);
  return event.defaultPrevented;
}, { eventType: type, code: keyCode, name: key, isRepeat: repeat });
const remoteKey = async (page, keyCode, key) => {
  await remoteKeyEvent(page, 'keydown', keyCode, key);
  await remoteKeyEvent(page, 'keyup', keyCode, key);
};
const RETURN = [10009, 'XF86Back'];
const DOWN = [40, 'ArrowDown'];
const ENTER = [13, 'Enter'];
const RED = [403, 'ColorF0Red'];

// Open the input test from the Input Settings with the remote
async function openInputTest(page) {
  await page.evaluate(() => $('#settingsBtn').trigger('click'));
  await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
  await page.evaluate(() => handleSettingsView('inputSettings'));
  await page.waitForTimeout(400);
  for (let i = 0; i < 3; i++) {
    await remoteKey(page, ...DOWN);
  }
  assert.equal(await page.evaluate(() => document.activeElement.id), 'inputTestBtn');
  await remoteKey(page, ...ENTER);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => InputTest.isOpen()), true);
}

const readKeys = (page) => page.evaluate(() => ({
  key: document.getElementById('inputTestKey').textContent,
  info: document.getElementById('inputTestKeyInfo').textContent,
  history: document.getElementById('inputTestHistory').textContent.split('\n').filter(Boolean),
}));

test('every key of the remote shows with its code and hold time, and none reaches the menus, until RETURN leaves', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads] });
  try {
    await app.page.evaluate(() => {
      // The keys of the TV: Moonlight registered Play/Pause and the colour keys (initSamsungKeys() in index.js)
      tizen.tvinputdevice.getSupportedKeys = () => [{ name: 'MediaPlayPause', code: 10252 }, { name: 'ColorF0Red', code: 403 },
        { name: 'MediaStop', code: 413 }, { name: '1', code: 49 }];
    });
    const registered = await app.page.evaluate(() => window.__tvMock.calls.filter((call) => call.name === 'tizen.tvinputdevice.registerKey').length);
    await openInputTest(app.page);
    assert.deepEqual(await readKeys(app.page), { key: 'Press a key of the remote', info: '', history: [] });
    assert.equal(await app.page.evaluate(() => document.getElementById('inputTestTvKeys').textContent),
      'Registered by Moonlight: MediaPlayPause 10252, ColorF0Red 403\nLeft to the TV: MediaStop 413');
    // The key handler of the menus (remoteControllerHandler() on the document) gets no key while the test is open: it would
    // hand them to the view of the test, whose actions count them here
    await app.page.evaluate(() => {
      window.__menuKeys = [];
      ['up', 'down', 'left', 'right', 'accept', 'back', 'press', 'switch'].forEach((action) => {
        const original = Views.InputTestDialog[action];
        Views.InputTestDialog[action] = function() {
          window.__menuKeys.push(action);
          return original.apply(this, arguments);
        };
      });
    });
    // A held DOWN with auto-repeats: shown while held, and it doesn't move the focus of the settings
    const focus = await app.page.evaluate(() => Views.InputSettings.view.index);
    assert.equal(await remoteKeyEvent(app.page, 'keydown', ...DOWN), true, 'the default action of the key is prevented');
    await app.page.waitForTimeout(120);
    await remoteKeyEvent(app.page, 'keydown', ...DOWN, true);
    await remoteKeyEvent(app.page, 'keydown', ...DOWN, true);
    await app.page.waitForTimeout(80);
    const held = await readKeys(app.page);
    assert.equal(held.key, 'ArrowDown');
    assert.match(held.info, /^keyCode 40 · held \d+ ms · 2 repeats · held$/);
    await remoteKeyEvent(app.page, 'keyup', ...DOWN);
    const released = await readKeys(app.page);
    assert.match(released.info, /^keyCode 40 · held (\d+) ms · 2 repeats$/);
    assert.ok(Number(/held (\d+) ms/.exec(released.info)[1]) >= 150, released.info);
    assert.match(released.history[0], /^ArrowDown · 40 · \d+ ms · 2 repeats$/);
    // RED and OK show as well and do nothing else
    await remoteKey(app.page, ...RED);
    await remoteKey(app.page, ...ENTER);
    const after = await readKeys(app.page);
    assert.deepEqual(after.history.map((line) => line.split(' · ').slice(0, 2).join(' · ')), ['Enter · 13', 'ColorF0Red · 403', 'ArrowDown · 40']);
    assert.equal(await app.page.evaluate(() => Views.InputSettings.view.index), focus);
    assert.equal(await app.page.evaluate(() => InputTest.isOpen()), true);
    // RETURN shows first, then leaves the test with the focus back on its button
    await remoteKey(app.page, ...RETURN);
    assert.match((await readKeys(app.page)).history[0], /^XF86Back · 10009 · \d+ ms$/);
    assert.equal(await app.page.evaluate(() => InputTest.isOpen()), true);
    assert.deepEqual(await app.page.evaluate(() => window.__menuKeys), []);
    await app.page.waitForTimeout(800);
    const closed = await app.page.evaluate(() => ({
      open: InputTest.isOpen(),
      dialog: document.getElementById('inputTestDialog').open,
      focus: document.activeElement.id,
      isDialogOpen,
    }));
    assert.deepEqual(closed, { open: false, dialog: false, focus: 'inputTestBtn', isDialogOpen: false });
    // After the test the keys work in the menus again
    await remoteKey(app.page, ...DOWN);
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'selectControllerType');
    // The test registered no keys of its own
    assert.equal(await app.page.evaluate(() => window.__tvMock.calls.filter((call) => call.name === 'tizen.tvinputdevice.registerKey').length), registered);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('each controller is drawn live, a hold of B leaves, and the controllers are read only while the test is open', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads] });
  try {
    await app.page.evaluate((id) => {
      window.__connectPad(0, id);
      window.__connectPad(2, 'Generic USB Joystick (Vendor: 0079 Product: 0006)', '');
    }, XBOX_ID);
    await openInputTest(app.page);
    await app.page.evaluate(() => {
      window.__setButton(0, 0, true);
      window.__setButton(0, 4, true);
      window.__setButton(0, 7, true, 0.5);
      window.__pads[0].axes = [1, -0.5, 0, 0];
      window.__setButton(2, 5, true);
    });
    await app.page.waitForTimeout(150);
    const drawn = await app.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#inputTestPads .pad-card'), (card) => ({
      title: card.querySelector('.pad-title').textContent,
      meta: card.querySelector('.pad-meta').textContent,
      on: Array.prototype.map.call(card.querySelectorAll('.on'), (part) => part.getAttribute('data-b')),
      rightTrigger: card.querySelector('[data-t="7"]').getAttribute('width'),
      leftStick: [card.querySelector('[data-s="0"]').getAttribute('cx'), card.querySelector('[data-s="0"]').getAttribute('cy')],
      buttons: card.querySelector('.pad-buttons').textContent,
      axes: card.querySelector('.pad-axes').textContent,
    })));
    assert.deepEqual(drawn, [
      {
        title: 'Gamepad 0: Xbox Wireless Controller', meta: 'standard layout · 17 buttons, 4 axes', on: ['4', '0'], rightTrigger: '32',
        leftStick: ['98.0', '88.0'], buttons: 'Buttons: A, LB, RT', axes: 'Axes: 1.00  -0.50  0.00  0.00   LT 0.00  RT 0.50',
      },
      {
        // A controller with another layout names its buttons by their index
        title: 'Gamepad 2: Generic USB Joystick', meta: 'non-standard layout · 17 buttons, 4 axes', on: ['5'], rightTrigger: '0',
        leftStick: ['86.0', '94.0'], buttons: 'Buttons: 5', axes: 'Axes: 0.00  0.00  0.00  0.00',
      },
    ]);
    assert.equal(await app.page.evaluate(() => getComputedStyle(document.getElementById('inputTestNoPads')).display), 'none');
    // A controller that goes is removed
    await app.page.evaluate(() => {
      window.__pads[2] = null;
    });
    await app.page.waitForTimeout(150);
    assert.equal(await app.page.evaluate(() => document.querySelectorAll('#inputTestPads .pad-card').length), 1);
    // B for less than 2 seconds stays, and the gamepad input of the menus does nothing meanwhile
    await app.page.evaluate(() => window.__setButton(0, 1, true));
    await app.page.waitForTimeout(1200);
    assert.equal(await app.page.evaluate(() => InputTest.isOpen()), true);
    assert.equal(await app.page.evaluate(() => document.getElementById('inputTestHint').classList.contains('is-leaving')), true);
    await app.page.evaluate(() => window.__setButton(0, 1, false));
    await app.page.waitForTimeout(150);
    await app.page.evaluate(() => window.__setButton(0, 1, true));
    await app.page.waitForTimeout(2300);
    assert.equal(await app.page.evaluate(() => InputTest.isOpen()), false);
    // The poll of the test stopped: its cards no longer change
    await app.page.evaluate(() => window.__setButton(0, 2, true));
    await app.page.waitForTimeout(150);
    assert.equal(await app.page.evaluate(() => document.querySelector('#inputTestPads .pad-card [data-b="2"]').classList.contains('on')), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the input test opens with a gamepad and names a missing controller', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', locale: 'de_DE' }, initScripts: [simulatedGamepads] });
  try {
    await app.page.evaluate(() => $('#settingsBtn').trigger('click'));
    await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await app.page.evaluate(() => {
      handleSettingsView('inputSettings');
      Views.InputSettings.view.index = 3;
    });
    await app.page.waitForTimeout(400);
    await app.page.evaluate(() => handleGamepadMenuInput({ detail: { gamepad: 0, changes: [{ type: 'button', index: 0, pressed: true }] } }));
    await app.page.waitForTimeout(300);
    const shown = await app.page.evaluate(() => ({
      open: InputTest.isOpen(),
      title: document.querySelector('#inputTestDialog .mdl-dialog__title').textContent,
      noPads: getComputedStyle(document.getElementById('inputTestNoPads')).display,
      noPadsText: document.getElementById('inputTestNoPads').textContent,
      tvKeys: document.getElementById('inputTestTvKeys').textContent,
    }));
    assert.deepEqual(shown, {
      open: true, title: 'Eingabetest', noPads: 'block',
      noPadsText: 'Kein Controller gefunden. Drück eine Taste am Controller, um ihn zu wecken.',
      tvKeys: 'Der TV meldet keine Medientasten.',
    });
    // B of the gamepad of the menus doesn't leave: only a hold of B on a controller of the test does
    await app.page.evaluate(() => handleGamepadMenuInput({ detail: { gamepad: 0, changes: [{ type: 'button', index: 0, pressed: false }, { type: 'button', index: 1, pressed: true }] } }));
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.evaluate(() => InputTest.isOpen()), true);
    await remoteKey(app.page, ...RETURN);
    await app.page.waitForTimeout(800);
    assert.equal(await app.page.evaluate(() => InputTest.isOpen()), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
