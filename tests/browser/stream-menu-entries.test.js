'use strict';

// Checks the bitrate entry and 'Type text…' of the Stream Menu in the real page (wasm/platform/menus.js with index.js
// and messages.js), over a simulated stream with the remote and a simulated gamepad:
// - the bitrate entry shows the bitrate of the stream, LEFT and RIGHT change it in steps of 5 Mbps up to the decoder cap
//   of the TV and no further, OK on an unchanged bitrate does nothing but explain, and OK on a new one keeps it as the
//   bitrate setting, ends the stream without quitting the app on the PC and resumes the app with the new bitrate a moment
//   later, with the launch screen and the new bitrate meanwhile; RED cancels the reconnect, an app that no longer runs
//   ends it with a message, and an end of the stream for another reason never reconnects;
// - 'Type text…' opens a field that takes the keys of the keyboard while nothing reaches the stream, Enter and the Done
//   key of the keyboard of the TV send the text once through sendText() of the module and resume the stream, RETURN and
//   the Cancel key send nothing and return to the Stream Menu, a text that can't be sent keeps the field with the reason,
//   the text is never logged or kept, and the end of the stream closes the field.
// The module side of sendText() is pinned by tests/native/text_input_test.cpp, the pure logic by
// tests/unit/stream-menu-entries.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness, waitForStorage } = require('./harness');

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
// delayedNavigation() runs the gamepad buttons of the menus 150 ms later, and the gamepads are polled every 5 ms
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

// Simulated gamepads, installed before the app starts (as in stream-menu.test.js)
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
  window.__setButton = (index, button, pressed) => {
    window.__pads[index].buttons[button] = { pressed, value: pressed ? 1 : 0 };
  };
}

// Open the app on a simulated TV with a simulated host that answers the launch and resume requests at once, and start a
// stream of app 8 that reaches 'Connection Established'. The host records its requests and the start requests of the
// module in window.__events, stopStream() ends the stream like the module ('streamTerminated: 0' at once), and a listener
// on the video element records the keys that would reach the keyboard handler of the stream (window.__videoKeys). The
// reconnect waits 100 ms instead of 1 s.
async function openStreaming(options) {
  const opts = options || {};
  const app = await openApp(harness, {
    tv: Object.assign({ tv: 's90c', conn: 'wifi' }, opts.tv), initScripts: [simulatedGamepads],
    stored: Object.assign({ bitrate: '40', autoAdjustBitrate: false }, opts.stored),
  });
  if (opts.gamepad) {
    await app.page.evaluate((id) => window.__connectPad(0, id), XBOX_ID);
  }
  await app.page.evaluate(async () => {
    BITRATE_RESTART_DELAY_MS = 100;
    window.__events = [];
    const record = (event) => window.__events.push(event);
    const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null),
      launchApp: (appId) => {
        record('launch');
        host.currentGame = appId;
        return Promise.resolve(ok);
      },
      resumeApp: () => {
        record('resume');
        return Promise.resolve(ok);
      },
      quitApp: () => {
        record('quit');
        host.currentGame = 0;
        return Promise.resolve();
      },
      toString: () => 'GAMING-PC',
    };
    window.__host = host;
    api = host;
    showApps = () => {
      record('app list');
      return Promise.resolve();
    };
    const startStream = Module.startStream;
    Module.startStream = function() {
      record('start request ' + arguments[5]);
      return startStream.apply(this, arguments);
    };
    Module.stopStream = function() {
      record('stop');
      window.__wasmCalls.push({ name: 'stopStream', args: [] });
      handleMessage('streamTerminated: 0');
      return { type: 'resolve', ret: null };
    };
    window.__snackbar = [];
    document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbar.push(data.message);
    window.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    startGame(host, 8);
    await window.wait(300);
    handleMessage('Connection Established');
    window.__videoKeys = [];
    const video = document.getElementById('wasm_module');
    ['keydown', 'keyup'].forEach((type) => {
      video.addEventListener(type, (e) => window.__videoKeys.push(type + ' ' + e.keyCode), true);
    });
    window.__events.length = 0;
    window.__wasmCalls.length = 0;
  });
  return app;
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

const PLAY_PAUSE = [10252, 'MediaPlayPause'];
const RETURN = [10009, 'XF86Back'];
const UP = [38, 'ArrowUp'];
const DOWN = [40, 'ArrowDown'];
const LEFT = [37, 'ArrowLeft'];
const RIGHT = [39, 'ArrowRight'];
const ENTER = [13, 'Enter'];
const RED = [403, 'ColorF0Red'];
// The Done and Cancel keys of the keyboard of the TV
const IME_DONE = [65376, 'Done'];
const IME_CANCEL = [65385, 'Cancel'];

// Open the Stream Menu with Play/Pause and move DOWN to an entry
async function openMenuAt(page, entryId) {
  await remoteKey(page, ...PLAY_PAUSE);
  for (let i = 0; i < 12; i++) {
    if (await page.evaluate(() => document.activeElement.id) === entryId) {
      return;
    }
    await remoteKey(page, ...DOWN);
  }
  throw new Error('The Stream Menu has no entry ' + entryId);
}

// What the bitrate entry shows
const bitrateEntry = (page) => page.evaluate(() => ({
  value: $('#streamMenuBitrateValue').text(),
  pending: $('#streamMenuBitrateValue').hasClass('is-pending'),
  note: $('#streamMenuBitrateNote').text(),
  lowerLimit: $('#streamMenuBitrateLower').hasClass('is-limit'),
  higherLimit: $('#streamMenuBitrateHigher').hasClass('is-limit'),
}));

// The calls of the module stub since the stream started, as 'name args'
const moduleCalls = (page) => page.evaluate(() => window.__wasmCalls.map((call) => call.name + (call.args.length ? ' ' + call.args.join(',') : '')));

test('LEFT and RIGHT change the bitrate in steps of 5 Mbps up to the decoder cap, and OK reconnects with it', async () => {
  const app = await openStreaming();
  try {
    await openMenuAt(app.page, 'streamMenuBitrate');
    assert.deepEqual(await bitrateEntry(app.page), { value: '40 Mbps', pending: false, note: '', lowerLimit: false, higherLimit: false });
    // OK on the bitrate of the stream does nothing but explain
    await remoteKey(app.page, ...ENTER);
    assert.equal((await bitrateEntry(app.page)).note, 'Change it with LEFT and RIGHT');
    assert.equal(await app.page.evaluate(() => isStreamMenuOpen), true);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true']);

    await remoteKey(app.page, ...RIGHT);
    assert.deepEqual(await bitrateEntry(app.page), { value: '45 Mbps', pending: true, note: 'OK: reconnect (now 40 Mbps)', lowerLimit: false, higherLimit: false });
    await remoteKey(app.page, ...LEFT);
    await remoteKey(app.page, ...LEFT);
    assert.deepEqual(await bitrateEntry(app.page), { value: '35 Mbps', pending: true, note: 'OK: reconnect (now 40 Mbps)', lowerLimit: false, higherLimit: false });
    // Up to the decoder cap of the S90C profile, 100 Mbps, and no further
    for (let i = 0; i < 20; i++) {
      await remoteKey(app.page, ...RIGHT);
    }
    assert.deepEqual(await bitrateEntry(app.page), { value: '100 Mbps', pending: true, note: 'OK: reconnect (now 40 Mbps)', lowerLimit: false, higherLimit: true });
    for (let i = 0; i < 11; i++) {
      await remoteKey(app.page, ...LEFT);
    }
    assert.equal((await bitrateEntry(app.page)).value, '45 Mbps');
    // LEFT and RIGHT on another entry change nothing
    await remoteKey(app.page, ...UP);
    await remoteKey(app.page, ...RIGHT);
    await remoteKey(app.page, ...DOWN);
    assert.equal((await bitrateEntry(app.page)).value, '45 Mbps');
    assert.deepEqual(app.errors, []);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);

    // OK: the setting keeps 45 Mbps, picked by hand, the stream ends without a quit, and the launch screen shows it
    await remoteKey(app.page, ...ENTER);
    const waiting = await app.page.evaluate(() => ({
      menu: isStreamMenuOpen, isInGame, wasmSessionStarted,
      spinner: $('#loadingSpinner').is(':visible'), video: $('#wasm_module').is(':visible'),
      message: $('#loadingSpinnerMessage').text(), slider: $('#bitrateSlider').val(), label: $('#selectBitrate').text(),
      events: window.__events.slice(),
    }));
    assert.deepEqual(waiting, {
      menu: false, isInGame: true, wasmSessionStarted: false, spinner: true, video: false,
      message: 'Reconnecting with 45 Mbps...', slider: '45', label: '45 Mbps', events: ['stop'],
    });
    await waitForStorage(app.page, (values) => values.bitrate === '45' && values.autoAdjustBitrate === false);
    // A moment later the app is resumed with the new bitrate, without a message, and the launch screen says so meanwhile
    await app.page.waitForTimeout(400);
    const resumed = await app.page.evaluate(() => ({
      events: window.__events.slice(), message: $('#loadingSpinnerMessage').text(), isInGame, wasmSessionStarted,
      bitrate: window.__startStreamArgs[5], snackbar: window.__snackbar.slice(),
    }));
    assert.deepEqual(resumed, {
      events: ['stop', 'resume', 'start request 45000'], message: 'Reconnecting with 45 Mbps...', isInGame: true,
      wasmSessionStarted: true, bitrate: '45000', snackbar: [],
    });
    await app.page.evaluate(() => handleMessage('Connection Established'));
    assert.equal(await app.page.evaluate(() => $('#wasm_module').is(':visible')), true);
    // The Stream Menu starts from the bitrate of the new stream
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.deepEqual(await bitrateEntry(app.page), { value: '45 Mbps', pending: false, note: '', lowerLimit: false, higherLimit: false });
    assert.equal(await app.page.evaluate(() => window.__host.currentGame), 8, 'the app still runs on the PC');
    assert.equal((await readStorage(app.page)).bitrate, '45');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the bitrate entry stops at the decoder cap of other TVs and at 5 Mbps, and a gamepad changes and applies it', async () => {
  // A 4K TV without a tested profile: 80 Mbps; a bitrate of the slider above the cap goes down to it
  const uhd = await openStreaming({ tv: { tv: 'uhd' }, stored: { bitrate: '120' }, gamepad: true });
  try {
    await openMenuAt(uhd.page, 'streamMenuBitrate');
    assert.deepEqual(await bitrateEntry(uhd.page), { value: '120 Mbps', pending: false, note: '', lowerLimit: false, higherLimit: true });
    // D-pad left and right of the gamepad
    await uhd.page.evaluate(() => window.__setButton(0, 14, true));
    await uhd.page.waitForTimeout(50);
    await uhd.page.evaluate(() => window.__setButton(0, 14, false));
    await uhd.page.waitForTimeout(50);
    assert.deepEqual(await bitrateEntry(uhd.page), { value: '80 Mbps', pending: true, note: 'OK: reconnect (now 120 Mbps)', lowerLimit: false, higherLimit: true });
    await uhd.page.evaluate(() => window.__setButton(0, 15, true));
    await uhd.page.waitForTimeout(50);
    await uhd.page.evaluate(() => window.__setButton(0, 15, false));
    await uhd.page.waitForTimeout(50);
    assert.equal((await bitrateEntry(uhd.page)).value, '80 Mbps');
    // A applies it
    await uhd.page.evaluate(() => window.__setButton(0, 0, true));
    await uhd.page.waitForTimeout(AFTER_DELAY_MS);
    await uhd.page.evaluate(() => window.__setButton(0, 0, false));
    await uhd.page.waitForTimeout(300);
    assert.deepEqual(await uhd.page.evaluate(() => window.__events.slice()), ['stop', 'resume', 'start request 80000']);
    assert.deepEqual(uhd.errors, []);
  } finally {
    await uhd.context.close();
  }

  // A Full HD TV: 50 Mbps, and down to 5 Mbps
  const fhd = await openStreaming({ tv: { tv: 'fhd' }, stored: { bitrate: '10' } });
  try {
    await openMenuAt(fhd.page, 'streamMenuBitrate');
    for (let i = 0; i < 4; i++) {
      await remoteKey(fhd.page, ...LEFT);
    }
    assert.deepEqual(await bitrateEntry(fhd.page), { value: '5 Mbps', pending: true, note: 'OK: reconnect (now 10 Mbps)', lowerLimit: true, higherLimit: false });
    for (let i = 0; i < 15; i++) {
      await remoteKey(fhd.page, ...RIGHT);
    }
    assert.deepEqual(await bitrateEntry(fhd.page), { value: '50 Mbps', pending: true, note: 'OK: reconnect (now 10 Mbps)', lowerLimit: false, higherLimit: true });
    // Closing the menu forgets the change
    await remoteKey(fhd.page, ...RETURN);
    await remoteKey(fhd.page, ...PLAY_PAUSE);
    assert.equal((await bitrateEntry(fhd.page)).value, '10 Mbps');
    assert.deepEqual(await fhd.page.evaluate(() => window.__events.slice()), []);
    assert.deepEqual(fhd.errors, []);
  } finally {
    await fhd.context.close();
  }
});

test('RED cancels the reconnect, an app that no longer runs ends it with a message, and another end never reconnects', async () => {
  const app = await openStreaming();
  try {
    await openMenuAt(app.page, 'streamMenuBitrate');
    await remoteKey(app.page, ...RIGHT);
    await remoteKey(app.page, ...ENTER);
    // RED during the wait: back to the app list, and no resume follows
    await remoteKey(app.page, ...RED);
    await app.page.waitForTimeout(400);
    let state = await app.page.evaluate(() => ({ events: window.__events.slice(), isInGame, snackbar: window.__snackbar.slice() }));
    assert.deepEqual(state, { events: ['stop', 'app list'], isInGame: false, snackbar: [] });

    // Another app runs on the host meanwhile, e.g. started on another device, or the game closed or crashed on the PC
    // during the wait, so that nothing runs: the reconnect ends with a message, and never launches the game anew
    for (const currentGame of [9, 0]) {
      await app.page.evaluate(async () => {
        window.__events.length = 0;
        window.__snackbar.length = 0;
        window.__host.currentGame = 0;
        startGame(window.__host, 8);
        await window.wait(300);
        handleMessage('Connection Established');
        window.__events.length = 0;
      });
      await openMenuAt(app.page, 'streamMenuBitrate');
      await remoteKey(app.page, ...RIGHT);
      await app.page.evaluate((game) => {
        window.__host.getAppById = (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null);
        window.__host.currentGame = game;
      }, currentGame);
      await remoteKey(app.page, ...ENTER);
      await app.page.waitForTimeout(400);
      state = await app.page.evaluate(() => ({ events: window.__events.slice(), isInGame, snackbar: window.__snackbar.slice() }));
      assert.deepEqual(state, { events: ['stop', 'app list'], isInGame: false,
        snackbar: ['Unable to resume Game 8 with the new bitrate. Start it again from the app list.'] }, 'running on the host: ' + currentGame);
    }

    // A stream that ends with an error (or RED) after a reconnect was asked for but before it ended never reconnects later
    await app.page.evaluate(async () => {
      window.__host.currentGame = 8;
      window.__snackbar.length = 0;
      startGame(window.__host, 8);
      await window.wait(300);
      handleMessage('Connection Established');
      window.__events.length = 0;
      pendingBitrateRestartMbps = 60;
      handleMessage('streamTerminated: -101');
      await window.wait(300);
    });
    state = await app.page.evaluate(() => ({ events: window.__events.slice(), isInGame, pending: pendingBitrateRestartMbps }));
    assert.deepEqual(state, { events: ['app list'], isInGame: false, pending: 0 });
    // 'Disconnect' ends the stream as before, without a reconnect
    await app.page.evaluate(async () => {
      startGame(window.__host, 8);
      await window.wait(300);
      handleMessage('Connection Established');
      window.__events.length = 0;
    });
    await openMenuAt(app.page, 'streamMenuDisconnect');
    await remoteKey(app.page, ...ENTER);
    await app.page.waitForTimeout(300);
    assert.deepEqual(await app.page.evaluate(() => window.__events.slice()), ['stop', 'app list']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// What the text panel shows
const textPanel = (page) => page.evaluate(() => ({
  menu: isStreamMenuOpen,
  panel: !document.getElementById('streamTextPanel').hidden,
  entries: !document.getElementById('streamMenu').hidden,
  focused: document.activeElement ? document.activeElement.id : '',
  editing: !document.getElementById('streamTextInput').readOnly,
  value: $('#streamTextInput').val(),
  status: $('#streamTextStatus').text(),
}));

const SECRET = 'Pässwörd 1 &é€😀';

test('Type text: the keys go to the field and not to the PC, and Enter sends the text once and resumes', async () => {
  const app = await openStreaming();
  try {
    await openMenuAt(app.page, 'streamMenuText');
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await textPanel(app.page), { menu: true, panel: true, entries: false, focused: 'streamTextInput', editing: true, value: '', status: '' });
    // Typed on a keyboard (trusted key events): the field takes every key, the stream and the module get none
    await app.page.keyboard.type(SECRET);
    await app.page.keyboard.press('Backspace');
    await app.page.keyboard.type('!');
    await app.page.keyboard.press('ArrowLeft');
    await app.page.keyboard.press('ArrowRight');
    await app.page.keyboard.press('ArrowUp');
    await app.page.keyboard.press('Space');
    await app.page.keyboard.press('Backspace');
    const expected = SECRET.slice(0, -2) + '!';
    assert.equal((await textPanel(app.page)).value, expected);
    assert.equal((await textPanel(app.page)).panel, true);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true']);

    // Enter sends it once, closes the menu and gives the stream the focus back; its release doesn't reach the stream
    await app.page.keyboard.press('Enter');
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'sendText ' + expected, 'setStreamMenuOpen false']);
    const state = await textPanel(app.page);
    assert.deepEqual(state, { menu: false, panel: false, entries: true, focused: 'wasm_module', editing: false, value: '', status: '' });
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(await app.page.evaluate(() => window.__snackbar.slice()), ['Text sent to the PC']);
    // The next key goes to the stream again
    await app.page.keyboard.press('KeyW');
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.splice(0)), ['keydown 87', 'keyup 87']);
    // The text was never logged, nor a piece of it
    for (const piece of [expected, 'Pässw', '€😀']) {
      assert.ok(!app.logs.some((line) => line.indexOf(piece) >= 0), 'logged: ' + piece);
    }
    assert.ok(app.logs.some((line) => line.indexOf('Answer to the text for the PC: 0') >= 0));
    // Opened again, the field is empty
    await openMenuAt(app.page, 'streamMenuText');
    await remoteKey(app.page, ...ENTER);
    assert.equal((await textPanel(app.page)).value, '');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Type text: the Done key of the TV keyboard sends, RETURN and its Cancel key send nothing and return to the menu', async () => {
  const app = await openStreaming();
  try {
    // The Done key of the keyboard of the TV
    await openMenuAt(app.page, 'streamMenuText');
    await remoteKey(app.page, ...ENTER);
    await app.page.keyboard.type('search term');
    await remoteKey(app.page, ...IME_DONE);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'sendText search term', 'setStreamMenuOpen false']);
    assert.equal((await textPanel(app.page)).focused, 'wasm_module');

    // RETURN and the Cancel key: nothing is sent, and the Stream Menu shows again on 'Type text…'
    for (const key of [RETURN, IME_CANCEL]) {
      await app.page.evaluate(() => window.__wasmCalls.splice(0));
      await openMenuAt(app.page, 'streamMenuText');
      await remoteKey(app.page, ...ENTER);
      await app.page.keyboard.type('not for the PC');
      await remoteKey(app.page, ...key);
      assert.deepEqual(await textPanel(app.page), { menu: true, panel: false, entries: true, focused: 'streamMenuText', editing: false, value: '', status: '' }, key[1]);
      assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true'], key[1]);
      // RETURN in the Stream Menu resumes as before
      await remoteKey(app.page, ...RETURN);
      assert.equal((await textPanel(app.page)).focused, 'wasm_module');
    }
    // A held OK on 'Type text…': its auto-repeat neither sends the empty field nor reaches the stream
    await openMenuAt(app.page, 'streamMenuText');
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await app.page.evaluate(() => {
      const send = (type, repeat) => {
        const event = new KeyboardEvent(type, { key: 'Enter', repeat: repeat, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { value: 13 });
        (document.activeElement || document.body).dispatchEvent(event);
      };
      send('keydown', false);
      send('keydown', true);
      send('keydown', true);
      send('keyup', false);
    });
    assert.deepEqual(await textPanel(app.page), { menu: true, panel: true, entries: false, focused: 'streamTextInput', editing: true, value: '', status: '' });
    assert.deepEqual(await moduleCalls(app.page), []);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Type text: a text that can\'t be sent keeps the field with the reason', async () => {
  const app = await openStreaming();
  try {
    await openMenuAt(app.page, 'streamMenuText');
    await remoteKey(app.page, ...ENTER);
    // Empty: the field takes the text again
    await app.page.keyboard.press('Enter');
    assert.deepEqual(await textPanel(app.page), { menu: true, panel: true, entries: false, focused: 'streamTextInput', editing: true, value: '', status: 'Type a text first.' });
    // Longer than 1024 bytes of UTF-8 (the field holds up to 1024 characters)
    await app.page.evaluate(() => $('#streamTextInput').val('ü'.repeat(600)));
    await app.page.keyboard.press('Enter');
    assert.equal((await textPanel(app.page)).status, 'The text is too long to send at once. Send it in shorter parts.');
    // A lone surrogate, which the module couldn't tell from a valid character
    await app.page.evaluate(() => $('#streamTextInput').val('a\ud83db'));
    await app.page.keyboard.press('Enter');
    assert.equal((await textPanel(app.page)).status, 'The text has a character that can\'t be sent.');
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true'], 'the module got none of them');
    // The module answers that the input queue is full, or that the stream ended
    for (const [answer, status] of [[-5, 'The text couldn\'t be sent. Try again.'], [-1, 'The text can\'t be sent, since the stream has ended.']]) {
      await app.page.evaluate((result) => {
        Module.sendText = () => result;
        $('#streamTextInput').val('hello');
      }, answer);
      await app.page.keyboard.press('Enter');
      const state = await textPanel(app.page);
      assert.deepEqual([state.menu, state.panel, state.status], [true, true, status], String(answer));
    }
    assert.deepEqual(await app.page.evaluate(() => window.__snackbar.slice()), []);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Type text with a gamepad and the remote outside the field, and the end of the stream closes it', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    await openMenuAt(app.page, 'streamMenuText');
    await remoteKey(app.page, ...ENTER);
    await app.page.keyboard.type('gg');
    // DOWN leaves the field for Send, which OK presses
    await remoteKey(app.page, ...DOWN);
    let state = await textPanel(app.page);
    assert.deepEqual([state.focused, state.editing, state.value], ['streamTextSend', false, 'gg']);
    await remoteKey(app.page, ...DOWN);
    assert.equal((await textPanel(app.page)).focused, 'streamTextCancel');
    await remoteKey(app.page, ...UP);
    await remoteKey(app.page, ...UP);
    state = await textPanel(app.page);
    assert.deepEqual([state.focused, state.editing], ['streamTextInput', false]);
    // OK on the field opens the keyboard again
    await remoteKey(app.page, ...ENTER);
    assert.equal((await textPanel(app.page)).editing, true);
    await app.page.keyboard.type(' wp');

    // The gamepad: D-pad down to Send, A sends
    await app.page.evaluate(() => window.__setButton(0, 13, true));
    await app.page.waitForTimeout(50);
    await app.page.evaluate(() => window.__setButton(0, 13, false));
    await app.page.waitForTimeout(50);
    assert.equal((await textPanel(app.page)).focused, 'streamTextSend');
    await app.page.evaluate(() => window.__setButton(0, 0, true));
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    await app.page.evaluate(() => window.__setButton(0, 0, false));
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'sendText gg wp', 'setStreamMenuOpen false']);
    assert.equal((await textPanel(app.page)).menu, false);

    // B cancels: back to the Stream Menu
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await openMenuAt(app.page, 'streamMenuText');
    await remoteKey(app.page, ...ENTER);
    await remoteKey(app.page, ...DOWN);
    await app.page.evaluate(() => window.__setButton(0, 1, true));
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    await app.page.evaluate(() => window.__setButton(0, 1, false));
    await app.page.waitForTimeout(50);
    state = await textPanel(app.page);
    assert.deepEqual([state.menu, state.panel, state.focused], [true, false, 'streamMenuText']);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true']);

    // Play/Pause while the field takes the text: back to the game, nothing sent
    await remoteKey(app.page, ...ENTER);
    await app.page.keyboard.type('abc');
    await remoteKey(app.page, ...PLAY_PAUSE);
    state = await textPanel(app.page);
    assert.deepEqual([state.menu, state.panel, state.focused, state.value], [false, false, 'wasm_module', '']);

    // The stream ends while the field shows: the menu and the field close, and the text is gone
    await openMenuAt(app.page, 'streamMenuText');
    await remoteKey(app.page, ...ENTER);
    await app.page.keyboard.type('secret');
    await app.page.evaluate(() => handleMessage('streamTerminated: -101'));
    state = await textPanel(app.page);
    assert.deepEqual([state.menu, state.panel, state.editing, state.value], [false, false, false, '']);
    assert.ok(!(await moduleCalls(app.page)).some((call) => call.indexOf('sendText') === 0));
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Type text keeps the field when the entries of the Stream Menu change behind it, and returns to its entry', async () => {
  const app = await openStreaming();
  try {
    // The mouse emulation entry shows only because the mouse emulation is on, with no controller connected
    await app.page.evaluate(() => handleMessage('mouseEmulationOn'));
    await openMenuAt(app.page, 'streamMenuText');
    await remoteKey(app.page, ...ENTER);
    await app.page.keyboard.type('user');
    // The module turns it off while the field takes the text: the entry goes, and the field keeps the focus
    await app.page.evaluate(() => handleMessage('mouseEmulationOff'));
    let state = await textPanel(app.page);
    assert.deepEqual([state.panel, state.focused, state.editing], [true, 'streamTextInput', true]);
    await app.page.keyboard.type('name');
    assert.equal((await textPanel(app.page)).value, 'username');
    // RETURN goes back to 'Type text…', marked, not to the entry after it
    await remoteKey(app.page, ...RETURN);
    state = await textPanel(app.page);
    assert.deepEqual([state.panel, state.focused], [false, 'streamMenuText']);
    assert.deepEqual(await app.page.evaluate(() => [Views.StreamMenu.view.current().id,
      Array.prototype.filter.call(document.querySelectorAll('#streamMenu .overlay-menu-item'), (item) => item.classList.contains('hovered')).map((item) => item.id)]),
    ['streamMenuText', ['streamMenuText']]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
