'use strict';

// Checks the Stream Menu in the real page (wasm/platform/menus.js with the keys of remote_controller.js and index.js):
// the remote opens it with Play/Pause over a running stream (and the TV registers the media keys for it), the gamepad
// combo of the WebAssembly module opens it as well ('streamMenuRequested'), the remote and a simulated gamepad move
// through it while no key reaches the stream (a listener on the video element stands in for the keyboard handler of the
// module), RETURN and B close it and resume the stream, and its entries run: the performance statistics, the mouse
// emulation, the keys for the PC (every key released again), Disconnect and 'Disconnect and quit the app on the PC'. It
// stays inside the safe area of the screen, and the video keeps showing. The controller side (the combo and the
// controller input while the menu is open) is pinned by tests/native/stream_menu_combo_test.cpp.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
// delayedNavigation() runs the gamepad buttons of the menus 150 ms later (NAVIGATION_DELAY), and the gamepads are
// polled every 5 ms
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

// Simulated gamepads, installed before the app starts: navigator.getGamepads() returns window.__pads and counts its
// calls in window.__padReads, __connectPad(index) fills a slot and fires gamepadconnected, and __setButton(index,
// button, pressed) changes a button
function simulatedGamepads() {
  window.__pads = [null, null, null, null];
  window.__padReads = 0;
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => {
      window.__padReads++;
      return window.__pads.slice();
    },
  });
  window.__connectPad = (index, id) => {
    const pad = {
      index, id, mapping: 'standard', connected: true, timestamp: 1, vibrationActuator: null,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
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

// Open the app with a simulated host and start a stream of app 8 that reaches 'Connection Established'. The host
// records its calls in window.__hostCalls, showApps() and the snackbar are recorded, and a listener on the video
// element records the keys that would reach the keyboard handler of the stream (window.__videoKeys).
async function openStreaming(options) {
  const opts = options || {};
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads] });
  if (opts.gamepad) {
    await app.page.evaluate((id) => window.__connectPad(0, id), XBOX_ID);
  }
  await app.page.evaluate(async () => {
    window.__hostCalls = [];
    window.__showApps = 0;
    const record = (name) => window.__hostCalls.push(name);
    let launch = null;
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => {
        record('refresh');
        return Promise.resolve();
      },
      getAppById: (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null),
      launchApp: () => new Promise((resolve) => {
        launch = resolve;
      }),
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
      window.__showApps++;
      return Promise.resolve();
    };
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    window.__snackbarMessages = [];
    snackbar.showSnackbar = (data) => window.__snackbarMessages.push(data.message);

    startGame(host, 8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    launch('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The host runs app 8 from now on
    host.currentGame = 8;
    handleMessage('Connection Established');

    window.__videoKeys = [];
    const video = document.getElementById('wasm_module');
    ['keydown', 'keyup'].forEach((type) => {
      video.addEventListener(type, (e) => window.__videoKeys.push(type + ' ' + e.keyCode), true);
    });
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
const DOWN = [40, 'ArrowDown'];
const ENTER = [13, 'Enter'];

// What the page shows of the Stream Menu
const menuState = (page) => page.evaluate(() => ({
  open: isStreamMenuOpen,
  shown: $('#streamMenuOverlay').css('display'),
  focused: document.activeElement ? document.activeElement.id : '',
  entries: getOverlayMenuItems('streamMenu').map((item) => item.id),
  subtitle: $('#streamMenuSubtitle').text(),
}));

// The calls of the module stub since the stream started, as 'name args'
const moduleCalls = (page) => page.evaluate(() => window.__wasmCalls.map((call) => call.name + (call.args.length ? ' ' + call.args.join(',') : '')));

test('Play/Pause opens the Stream Menu over the stream, the remote moves in it, and RETURN resumes', async () => {
  const app = await openStreaming();
  try {
    const registered = await app.page.evaluate(() => window.__tvMock.calls.filter((call) => call.name === 'tizen.tvinputdevice.registerKey').map((call) => call.args[0]));
    assert.deepEqual(registered.slice(-3), ['MediaPlayPause', 'MediaPlay', 'MediaPause']);
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'wasm_module');

    await remoteKey(app.page, ...PLAY_PAUSE);
    let state = await menuState(app.page);
    assert.deepEqual(state, {
      open: true, shown: 'flex', focused: 'streamMenuResume', subtitle: 'Game 8 · GAMING-PC',
      entries: ['streamMenuResume', 'streamMenuStats', 'streamMenuKeyWin', 'streamMenuKeyAltTab', 'streamMenuKeyAltF4',
        'streamMenuKeyEsc', 'streamMenuDisconnect', 'streamMenuQuit'],
    });
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true'], 'the module stops the controller input of the PC');
    // The video keeps playing behind the menu
    assert.notEqual(await app.page.evaluate(() => $('#wasm_module').css('display')), 'none');

    // The arrow keys and OK stay in the menu
    await remoteKey(app.page, ...DOWN);
    assert.equal((await menuState(app.page)).focused, 'streamMenuStats');
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    assert.equal((await menuState(app.page)).focused, 'streamMenuKeyAltTab');

    // RETURN closes it and gives the stream the focus back
    await remoteKey(app.page, ...RETURN);
    state = await menuState(app.page);
    assert.equal(state.open, false);
    assert.equal(state.shown, 'none');
    assert.equal(state.focused, 'wasm_module');
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'setStreamMenuOpen false']);
    // No key of the menu reached the stream, not even the Play/Pause that opened it
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);

    // With the menu closed, the keys go to the stream again, except Play/Pause, which opens the menu once more
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.splice(0)), ['keydown 13', 'keyup 13']);
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.equal((await menuState(app.page)).open, true);
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.equal((await menuState(app.page)).open, false, 'Play/Pause closes it again');
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);

    // OK on Resume closes it, and the release of OK doesn't reach the stream either
    await remoteKey(app.page, ...PLAY_PAUSE);
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await menuState(app.page).then((state) => [state.open, state.focused]), [false, 'wasm_module']);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);

    // A mouse button on the video while the menu is open doesn't reach the stream, which would lock the pointer again
    await remoteKey(app.page, ...PLAY_PAUSE);
    const mouse = await app.page.evaluate(() => {
      const seen = [];
      const video = document.getElementById('wasm_module');
      const record = (e) => seen.push(e.type);
      ['mousedown', 'mouseup'].forEach((type) => video.addEventListener(type, record, true));
      ['mousedown', 'mouseup'].forEach((type) => video.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));
      const whileOpen = seen.splice(0);
      closeStreamMenu(true);
      ['mousedown', 'mouseup'].forEach((type) => video.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));
      return { whileOpen, afterClose: seen.slice() };
    });
    assert.deepEqual(mouse, { whileOpen: [], afterClose: ['mousedown', 'mouseup'] });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Stream Menu stays inside the safe area of the screen', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    await remoteKey(app.page, ...PLAY_PAUSE);
    const box = await app.page.evaluate(() => {
      const rect = document.getElementById('streamMenu').getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
    });
    // 5 % on each side of the 1920 x 1080 screen of the app
    assert.ok(box.left >= box.width * 0.05 && box.right <= box.width * 0.95, JSON.stringify(box));
    assert.ok(box.top >= box.height * 0.05 && box.bottom <= box.height * 0.95, JSON.stringify(box));
    assert.ok(box.right >= box.width * 0.9, 'on the right side of the picture: ' + JSON.stringify(box));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the gamepad combo opens the Stream Menu, the gamepad moves in it without the combo pressing anything, and B resumes', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    // The stream doesn't poll the gamepads of the menus
    const readsBefore = await app.page.evaluate(() => window.__padReads);
    await app.page.waitForTimeout(100);
    assert.equal(await app.page.evaluate(() => window.__padReads), readsBefore);

    // Select + Start are still held when the module asks for the menu
    await app.page.evaluate(() => {
      window.__setButton(0, 8, true);
      window.__setButton(0, 9, true);
      handleMessage('streamMenuRequested');
    });
    let state = await menuState(app.page);
    assert.equal(state.open, true);
    assert.deepEqual(state.entries.slice(0, 3), ['streamMenuResume', 'streamMenuStats', 'streamMenuMouse'], 'with a controller, the mouse emulation entry shows');
    // Releasing them presses nothing in the menu
    await app.page.evaluate(() => {
      window.__setButton(0, 8, false);
      window.__setButton(0, 9, false);
    });
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    assert.ok(await app.page.evaluate(() => window.__padReads) > readsBefore + 5, 'the menu polls the gamepads');
    assert.equal((await menuState(app.page)).focused, 'streamMenuResume');
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true']);

    // D-pad down and A toggle the performance statistics, and the menu stays open with the new state
    await app.page.evaluate(() => window.__setButton(0, 13, true));
    await app.page.waitForTimeout(50);
    await app.page.evaluate(() => window.__setButton(0, 13, false));
    await app.page.waitForTimeout(50);
    assert.equal((await menuState(app.page)).focused, 'streamMenuStats');
    assert.equal(await app.page.evaluate(() => $('#streamMenuStatsValue').text()), 'Off');
    await app.page.evaluate(() => window.__setButton(0, 0, true));
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    await app.page.evaluate(() => window.__setButton(0, 0, false));
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'toggleStats']);
    // The module answers the toggle with the first statistics at once
    await app.page.evaluate(() => handleMessage('StatMsg: Video stream: 3840x2160 60.00 FPS'));
    assert.equal(await app.page.evaluate(() => $('#streamMenuStatsValue').text()), 'On');
    assert.equal((await menuState(app.page)).open, true);

    // B resumes the stream, and the gamepads of the menus are no longer polled
    await app.page.evaluate(() => window.__setButton(0, 1, true));
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    state = await menuState(app.page);
    assert.equal(state.open, false);
    assert.equal(state.focused, 'wasm_module');
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'toggleStats', 'setStreamMenuOpen false']);
    const readsAfter = await app.page.evaluate(() => window.__padReads);
    await app.page.waitForTimeout(100);
    assert.equal(await app.page.evaluate(() => window.__padReads), readsAfter);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the mouse emulation entry asks the module and shows its answer, the key entries release every key and resume', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.equal(await app.page.evaluate(() => $('#streamMenuMouseValue').text()), 'Off');
    await app.page.evaluate(() => $('#streamMenuMouse').click());
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'toggleMouseEmulation']);
    await app.page.evaluate(() => handleMessage('mouseEmulationOn'));
    assert.equal(await app.page.evaluate(() => $('#streamMenuMouseValue').text()), 'On');
    assert.equal((await menuState(app.page)).open, true);

    // Alt + Tab: Alt down, Tab down, Tab up, Alt up, with the Alt flag only while Alt is held; then back to the stream
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await app.page.evaluate(() => $('#streamMenuKeyAltTab').click());
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen false', 'sendKeyboardEvent 32932,3,4', 'sendKeyboardEvent 32777,3,4',
      'sendKeyboardEvent 32777,4,4', 'sendKeyboardEvent 32932,4,0']);
    assert.deepEqual(await menuState(app.page).then((state) => [state.open, state.focused]), [false, 'wasm_module']);

    // The Windows key, Alt + F4 and Esc
    const sent = {};
    for (const id of ['streamMenuKeyWin', 'streamMenuKeyAltF4', 'streamMenuKeyEsc']) {
      await remoteKey(app.page, ...PLAY_PAUSE);
      await app.page.evaluate(() => window.__wasmCalls.splice(0));
      await app.page.evaluate((entry) => $('#' + entry).click(), id);
      sent[id] = (await moduleCalls(app.page)).filter((call) => call.indexOf('sendKeyboardEvent') === 0).map((call) => call.split(' ')[1]);
    }
    assert.deepEqual(sent, {
      streamMenuKeyWin: ['32859,3,8', '32859,4,0'],
      streamMenuKeyAltF4: ['32932,3,4', '32883,3,4', '32883,4,4', '32932,4,0'],
      streamMenuKeyEsc: ['32795,3,0', '32795,4,0'],
    });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Disconnect ends the stream, and Disconnect and quit also quits the app on the host once the stream ended', async () => {
  const app = await openStreaming();
  try {
    await remoteKey(app.page, ...PLAY_PAUSE);
    await app.page.evaluate(() => $('#streamMenuDisconnect').click());
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'setStreamMenuOpen false', 'stopStream']);
    assert.equal((await menuState(app.page)).open, false);
    // The module posts the end of the stream inside stopStream(); a plain disconnect leaves the app running
    await app.page.evaluate(async () => {
      window.__hostCalls.length = 0;
      handleMessage('streamTerminated: 0');
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.deepEqual(await app.page.evaluate(() => window.__hostCalls.slice()), ['refresh']);
    assert.equal(await app.page.evaluate(() => window.__showApps), 1);
  } finally {
    await app.context.close();
  }

  const quitting = await openStreaming();
  try {
    await remoteKey(quitting.page, ...PLAY_PAUSE);
    await quitting.page.evaluate(() => $('#streamMenuQuit').click());
    assert.deepEqual(await moduleCalls(quitting.page), ['setStreamMenuOpen true', 'setStreamMenuOpen false', 'stopStream']);
    const result = await quitting.page.evaluate(async () => {
      window.__hostCalls.length = 0;
      handleMessage('streamTerminated: 0');
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { calls: window.__hostCalls.slice(), showApps: window.__showApps, messages: window.__snackbarMessages.slice(), quitFlag: quitAppAfterStream };
    });
    assert.deepEqual(result.calls, ['refresh', 'quit']);
    assert.deepEqual(result.messages, ['Quitting Game 8...', 'Successfully quit Game 8']);
    assert.equal(result.showApps, 1);
    assert.equal(result.quitFlag, false, 'only this stream quits its app');
    assert.deepEqual(quitting.errors, []);
  } finally {
    await quitting.context.close();
  }
});

test('the Stream Menu opens only over a running stream, and closes when the stream ends', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    // Without a stream, Play/Pause works like CH+ in the menus and opens no Stream Menu
    await remoteKey(app.page, ...PLAY_PAUSE);
    await app.page.evaluate(() => handleMessage('streamMenuRequested'));
    assert.equal((await menuState(app.page)).open, false);
    assert.equal(await app.page.evaluate(() => window.__wasmCalls.some((call) => call.name === 'setStreamMenuOpen')), false);
  } finally {
    await app.context.close();
  }

  const app2 = await openStreaming();
  try {
    // While the stream starts (no connection yet) it doesn't open either
    await app2.page.evaluate(() => {
      isStreamConnected = false;
      handleMessage('streamMenuRequested');
    });
    assert.equal((await menuState(app2.page)).open, false);
    await app2.page.evaluate(() => {
      isStreamConnected = true;
    });

    // YELLOW toggles the statistics with the menu open; a stream that ends with an error closes it and still reports
    await remoteKey(app2.page, ...PLAY_PAUSE);
    await remoteKey(app2.page, 405, 'ColorF2Yellow');
    assert.equal((await menuState(app2.page)).open, true);
    await app2.page.evaluate(() => handleMessage('streamTerminated: -101'));
    const state = await menuState(app2.page);
    assert.equal(state.open, false);
    assert.equal(state.shown, 'none');
    assert.deepEqual(await moduleCalls(app2.page), ['setStreamMenuOpen true', 'toggleStats', 'setStreamMenuOpen false']);
    assert.ok((await app2.page.evaluate(() => window.__snackbarMessages.slice())).some((message) => message.indexOf('Reduce your video bitrate') >= 0));
    // RED during the menu stops the stream like before
    assert.deepEqual(app2.errors, []);
  } finally {
    await app2.context.close();
  }

  const app3 = await openStreaming();
  try {
    await remoteKey(app3.page, ...PLAY_PAUSE);
    await remoteKey(app3.page, 403, 'ColorF0Red');
    assert.deepEqual(await moduleCalls(app3.page), ['setStreamMenuOpen true', 'stopStream']);
    await app3.page.evaluate(() => handleMessage('streamTerminated: 0'));
    assert.equal((await menuState(app3.page)).open, false);
    assert.deepEqual(await app3.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(app3.errors, []);
  } finally {
    await app3.context.close();
  }
});
