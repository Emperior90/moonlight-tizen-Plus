'use strict';

// The gamepad settings and the rumble of a stream in the real page (plan WP7): the setting "Controller type sent to the
// PC" (Auto by default, chosen with the remote in the input settings, stored, translated and sent with the start
// request, which the WebAssembly module announces to the host), and the rumble that the host sends during a stream on
// simulated controllers: played, stopped at the end of the stream, and one notice for a controller that can't rumble.
// tests/unit/rumble.test.js checks the replay every 4 seconds on a simulated clock.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness, waitForStorage } = require('./harness');

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const GENERIC_ID = 'Generic USB Joystick (Vendor: 0079 Product: 0006)';

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Simulated gamepads for the page, installed before the app starts: navigator.getGamepads() returns the slots of
// window.__pads, and __connectPad(index, id, withActuator) fills a slot and fires gamepadconnected. The vibration
// actuator records what it is asked to play in window.__rumble.
function simulatedGamepads() {
  window.__pads = [null, null, null, null];
  window.__rumble = [];
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => window.__pads.slice(),
  });
  window.__connectPad = (index, id, withActuator) => {
    const pad = {
      index,
      id,
      mapping: 'standard',
      connected: true,
      timestamp: 1,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
      vibrationActuator: !withActuator ? null : {
        type: 'dual-rumble',
        playEffect: (type, params) => {
          window.__rumble.push({ pad: index, type, duration: params.duration, weak: params.weakMagnitude, strong: params.strongMagnitude });
          return Promise.resolve('complete');
        },
        reset: () => {
          window.__rumble.push({ pad: index, type: 'reset' });
          return Promise.resolve('complete');
        },
      },
    };
    window.__pads[index] = pad;
    const event = new Event('gamepadconnected');
    Object.defineProperty(event, 'gamepad', { value: pad });
    window.dispatchEvent(event);
  };
}

// Record the snackbar messages of the page
function recordSnackbar(page) {
  return page.evaluate(() => {
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    const show = snackbar.showSnackbar.bind(snackbar);
    window.__snackbarMessages = [];
    snackbar.showSnackbar = (data) => {
      window.__snackbarMessages.push(data.message);
      show(data);
    };
  });
}

// The id of the focused element, and waiting until an element has the focus
const focused = (page) => page.evaluate(() => (document.activeElement ? document.activeElement.id : ''));
const waitForFocus = (page, id) => page.waitForFunction((elementId) => document.activeElement && document.activeElement.id === elementId, id, { timeout: 3000 });

// What the controller type field shows
const readControllerType = (page) => page.evaluate(() => ({
  value: String($('#selectControllerType').data('value')),
  text: $('#selectControllerType').text().trim(),
}));

// Start a stream with a simulated host, by launching the game or by resuming it when it is running already, and return
// the arguments of the start request, then end the stream
function startRequestArgs(page, resume) {
  return page.evaluate(async (isResume) => {
    let launch = null;
    const reply = () => new Promise((resolve) => {
      launch = resolve;
    });
    const host = {
      paired: true, serverUid: 'HOST1', address: '10.0.0.2', httpPort: 47989, currentGame: isResume ? 8 : 0, appVersion: '7.1.431.-1', gfeVersion: '',
      serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
      launchApp: reply,
      resumeApp: reply,
    };
    const originalShowApps = showApps;
    showApps = () => Promise.resolve();
    window.__startStreamArgs = null;
    startGame(host, 8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    launch('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const args = window.__startStreamArgs;
    handleMessage('streamTerminated: 0');
    showApps = originalShowApps;
    return args;
  }, !!resume);
}

test('the controller type setting is Auto by default, chosen with the remote, stored and sent with the start request', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  const { page } = app;
  try {
    assert.deepEqual(await readControllerType(page), { value: 'Auto', text: 'Auto' });

    // Settings, DOWN to the input settings, ENTER, then DOWN past the four switches to the new field
    await page.evaluate(() => $('#settingsBtn').trigger('click'));
    await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await page.waitForTimeout(100);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    // The focus goes to the input of the first switch
    await waitForFocus(page, 'rumbleFeedbackSwitch');
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown');
    }
    assert.equal(await focused(page), 'selectControllerType');
    assert.deepEqual(await page.evaluate(() => Views.InputSettings.view.func()),
      ['rumbleFeedbackBtn', 'mouseEmulationBtn', 'flipABfaceButtonsBtn', 'flipXYfaceButtonsBtn', 'selectControllerType']);

    // ENTER opens the menu with Auto, Xbox, PlayStation and Nintendo; DOWN twice and ENTER choose PlayStation
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => isPopupMenuActive('controllerTypeMenu'));
    assert.deepEqual(await page.evaluate(() => $('.controllerTypeMenu li').map(function() {
      return $(this).data('value') + '=' + $(this).text().trim();
    }).get()), ['Auto=Auto', 'Xbox=Xbox', 'PlayStation=PlayStation', 'Nintendo=Nintendo']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitForStorage(page, (values) => values.controllerType === 'PlayStation');
    assert.deepEqual(await readControllerType(page), { value: 'PlayStation', text: 'PlayStation' });
    await waitForFocus(page, 'selectControllerType');
    assert.equal(await page.evaluate(() => isPopupMenuActive('controllerTypeMenu')), false);

    // The next stream announces every controller as a PlayStation controller
    const args = await startRequestArgs(page);
    assert.equal(args.length, 33);
    assert.equal(args[32], 'PlayStation');
    assert.ok(app.logs.some((line) => line.indexOf('Controller type sent to the PC: PlayStation') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stored controller type is loaded, Auto is translated, and an unknown stored value keeps Auto', async () => {
  const stored = await openApp(harness, { tv: { tv: 'uhd', conn: 'ethernet' }, stored: { controllerType: 'Nintendo' } });
  try {
    assert.deepEqual(await readControllerType(stored.page), { value: 'Nintendo', text: 'Nintendo' });
    // Resuming a running game sends it as well
    assert.equal((await startRequestArgs(stored.page, true))[32], 'Nintendo');
    // Restore Defaults goes back to Auto
    await stored.page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
    await stored.page.evaluate(() => $('#continueRestoreDefaults').trigger('click'));
    await waitForStorage(stored.page, (values) => values.controllerType === 'Auto');
    assert.deepEqual(await readControllerType(stored.page), { value: 'Auto', text: 'Auto' });
    // Auto is translated, also after a later translation pass
    await stored.page.evaluate(() => window.i18n.setLanguage('pt-BR'));
    assert.deepEqual(await readControllerType(stored.page), { value: 'Auto', text: 'Automático' });
    assert.equal(await stored.page.evaluate(() => $('.controllerTypeMenu li').first().text().trim()), 'Automático');
    assert.deepEqual(stored.errors, []);
  } finally {
    await stored.context.close();
  }

  const unknown = await openApp(harness, { tv: { tv: 'fhd', conn: 'wifi' }, stored: { controllerType: 'Switch' } });
  try {
    assert.deepEqual(await readControllerType(unknown.page), { value: 'Auto', text: 'Auto' });
    assert.equal((await readStorage(unknown.page)).controllerType, 'Switch', 'the stored value is left as it is');
    assert.deepEqual(unknown.errors, []);
  } finally {
    await unknown.context.close();
  }
});

test('rumble during a stream is played, stopped at the end of the stream, and a controller that cannot rumble gets one notice', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { rumbleFeedback: true }, initScripts: [simulatedGamepads] });
  const { page } = app;
  try {
    await recordSnackbar(page);
    // With the rumble setting on, a controller that connects plays a short test rumble
    await page.evaluate((id) => window.__connectPad(0, id, true), XBOX_ID);
    assert.deepEqual(await page.evaluate(() => window.__rumble.splice(0)), [{ pad: 0, type: 'dual-rumble', duration: 500, weak: 0.5, strong: 0.5 }]);

    // The rumble of the host is played as an effect of 5 seconds, which is replayed until the host stops it
    await page.evaluate(() => handleMessage('controllerRumble: 0,0.25,0.75'));
    assert.deepEqual(await page.evaluate(() => window.__rumble.splice(0)), [{ pad: 0, type: 'dual-rumble', duration: 5000, weak: 0.25, strong: 0.75 }]);
    // The end of the stream stops it
    await page.evaluate(() => handleMessage('streamTerminated: 0'));
    assert.deepEqual(await page.evaluate(() => window.__rumble.splice(0)), [{ pad: 0, type: 'reset' }]);

    // A controller without a vibration actuator: one notice, at the connection, and none for the rumble of a stream
    await page.evaluate((id) => window.__connectPad(1, id, false), GENERIC_ID);
    await page.evaluate(() => handleMessage('controllerRumble: 1,0.5,0.5'));
    await page.evaluate(() => handleMessage('controllerRumble: 1,0,0'));
    const notices = (await page.evaluate(() => window.__snackbarMessages.slice())).filter((message) => message.indexOf('rumble') >= 0);
    assert.deepEqual(notices, ['Gamepad 1 (Generic USB Joystick) does not support rumble on this TV.']);

    // A controller that disconnects during a rumble stops its replay without an error
    await page.evaluate(() => handleMessage('controllerRumble: 0,1,1'));
    await page.evaluate(() => {
      const pad = window.__pads[0];
      window.__pads[0] = null;
      const event = new Event('gamepaddisconnected');
      Object.defineProperty(event, 'gamepad', { value: Object.assign({}, pad, { connected: false }) });
      window.dispatchEvent(event);
    });
    assert.deepEqual(await page.evaluate(() => window.__rumble.splice(0)), [{ pad: 0, type: 'dual-rumble', duration: 5000, weak: 1, strong: 1 }]);
    // The next controller in the slot (after its test rumble) is left alone at the end of the stream
    await page.evaluate((id) => window.__connectPad(0, id, true), XBOX_ID);
    assert.deepEqual(await page.evaluate(() => window.__rumble.splice(0)), [{ pad: 0, type: 'dual-rumble', duration: 500, weak: 0.5, strong: 0.5 }]);
    await page.evaluate(() => handleMessage('streamTerminated: 0'));
    assert.deepEqual(await page.evaluate(() => window.__rumble.splice(0)), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
