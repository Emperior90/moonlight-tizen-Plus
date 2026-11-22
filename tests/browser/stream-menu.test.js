'use strict';

// Checks the Stream Menu in the real page (wasm/platform/menus.js with the keys of remote_controller.js and index.js):
// the remote opens it with Play/Pause over a running stream (and the TV registers the media keys for it), the gamepad
// combo of the WebAssembly module opens it as well ('streamMenuRequested'), the remote and a simulated gamepad move
// through it while no key reaches the stream (a listener on the video element stands in for the keyboard handler of the
// module), RETURN and B close it and resume the stream, and its entries run: the performance statistics, the mouse
// emulation (its entry shows for a controller that reports a timestamp of 0 once its input changed, Tizen 5.5, before
// that input moves the selection), the keys for the PC (every key released again; since 2.3.2 in the panel of
// 'Shortcuts…', whose buttons still run with a click), Disconnect and 'Quit app on the PC'. Since 2.3.3 the first key of
// a PC keyboard in a running stream asks for the pointer lock, as RETURN does, while the keys of the TV, Esc and the
// modifier keys don't, and no default action of such a key runs (Tab moved the focus off the video). It stays inside the safe area of the screen with every entry showing without scrolling and every label on one line in
// every language, also with text 10 % wider than this machine draws it (tests/browser/text-stress.js), and the video
// keeps showing, also with the surround quality entry of a 5.1 stream and the notes of a changed bitrate and quality.
// Since 2.3.3 the menu and its panels (Shortcuts…, Function keys…, the power question and the text panel of Type
// text…) open on the left while the statistics take a right corner, so that they never cover the full statistics,
// whichever their level.
// The bitrate and surround quality entries and 'Type text…' are checked by stream-menu-entries.test.js, the panels of
// 'Shortcuts…', 'Function keys…' and 'Shut down or restart the PC…' by stream-menu-panels.test.js. The controller
// side (the
// combo and the controller input while the menu is open) is pinned by tests/native/stream_menu_combo_test.cpp.
// A stick that snaps back past its centre when it is let go steps once in the menu (it used to step back, e.g. from the
// entry just chosen), and neither a step nor a repeat of the stick runs on after the menu closed (since 2.3.1).

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');
const { forEachTextWidth } = require('./text-stress');
const { FULL_TEXT } = require('./full-stats-text');

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
// delayedNavigation() runs the gamepad buttons of the menus 50 ms later (BUTTON_NAVIGATION_DELAY), and the gamepads are
// polled every 16 ms
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
// element records the keys that would reach the keyboard handler of the stream (window.__videoKeys). The mouse button
// presses on the video, with which the page asks the module for the pointer lock, are counted from before 'Connection
// Established' on (window.__videoMouseDowns), and a RIGHT on the video before it counts its presses in
// window.__mouseDownsBeforeConnected. The settings of options.stored go into the storage before the app starts, e.g.
// the audio configuration 5.1.
async function openStreaming(options) {
  const opts = options || {};
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads], stored: opts.stored });
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
    window.__videoMouseDowns = 0;
    const streamVideo = document.getElementById('wasm_module');
    streamVideo.addEventListener('mousedown', () => window.__videoMouseDowns++, true);
    ['keydown', 'keyup'].forEach((type) => {
      const event = new KeyboardEvent(type, { key: 'ArrowRight', bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { value: 39 });
      streamVideo.dispatchEvent(event);
    });
    window.__mouseDownsBeforeConnected = window.__videoMouseDowns;
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

// Send one key event of the remote or a keyboard to the focused element, e.g. the auto-repeat of a held key
const keyEvent = (page, type, keyCode, key, repeat) => page.evaluate(({ eventType, code, name, isRepeat }) => {
  const event = new KeyboardEvent(eventType, { key: name, repeat: isRepeat, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: code });
  Object.defineProperty(event, 'which', { value: code });
  (document.activeElement || document.body).dispatchEvent(event);
}, { eventType: type, code: keyCode, name: key, isRepeat: !!repeat });

const PLAY_PAUSE = [10252, 'MediaPlayPause'];
const RETURN = [10009, 'XF86Back'];
const DOWN = [40, 'ArrowDown'];
const UP = [38, 'ArrowUp'];
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
      // Since 2.3.2 the keys for the PC are in the panels of 'Shortcuts…' and 'Function keys…' (stream-menu-panels.test.js),
      // and 'Shut down or restart the PC…' is the last entry
      entries: ['streamMenuResume', 'streamMenuStats', 'streamMenuBitrate', 'streamMenuRefresh', 'streamMenuText', 'streamMenuShortcuts',
        'streamMenuFKeys', 'streamMenuDisconnect', 'streamMenuQuit', 'streamMenuPower'],
    });
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true'], 'the module stops the controller input of the PC');
    // The video keeps playing behind the menu
    assert.notEqual(await app.page.evaluate(() => $('#wasm_module').css('display')), 'none');

    // The arrow keys and OK stay in the menu
    await remoteKey(app.page, ...DOWN);
    assert.equal((await menuState(app.page)).focused, 'streamMenuStats');
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    assert.equal((await menuState(app.page)).focused, 'streamMenuFKeys');

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

// The mouse button presses on the video since the last call, with which the page asked the module for the pointer lock
const lockRequests = (page) => page.evaluate(() => {
  const count = window.__videoMouseDowns;
  window.__videoMouseDowns = 0;
  return count;
});

test('the first key of a PC keyboard in a running stream asks for the pointer lock; the keys of the TV, a locked pointer and the Stream Menu don\'t', async () => {
  // The stream sends keys to the PC only while the pointer is locked (wasm/input.cpp), which a mouse button press on the
  // video asks for. Since 2.3.3 the first key of the remote or a keyboard does that once the stream connected, as RETURN
  // does, not only RETURN, which sends Esc first (initSpecialKeys() in index.js)
  const app = await openStreaming();
  try {
    assert.equal(await app.page.evaluate(() => window.__mouseDownsBeforeConnected), 0, 'not before the stream connected');
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'wasm_module');
    // RIGHT, OK and W of a keyboard: each asks while the pointer isn't locked (this page never locks it) and still
    // reaches the keyboard handler of the stream, which sends nothing without the lock
    await remoteKey(app.page, 39, 'ArrowRight');
    assert.equal(await lockRequests(app.page), 1, 'RIGHT');
    await remoteKey(app.page, ...ENTER);
    assert.equal(await lockRequests(app.page), 1, 'OK');
    await remoteKey(app.page, 87, 'w');
    assert.equal(await lockRequests(app.page), 1, 'W');
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.splice(0)),
      ['keydown 39', 'keyup 39', 'keydown 13', 'keyup 13', 'keydown 87', 'keyup 87']);
    // The page sends nothing to the PC for them either (no Esc as for RETURN)
    assert.deepEqual(await moduleCalls(app.page), [], 'the first keys send nothing from the page');
    // The keys that only a TV has never reach the PC, so they don't ask for it: CH+, CH-, Source, Channel list, GREEN,
    // BLUE, and YELLOW, which steps the statistics
    for (const [code, name] of [[427, 'ChannelUp'], [428, 'ChannelDown'], [10072, 'Source'], [10073, 'ChannelList'],
      [404, 'ColorF1Green'], [406, 'ColorF3Blue'], [405, 'ColorF2Yellow']]) {
      await remoteKey(app.page, code, name);
      assert.equal(await lockRequests(app.page), 0, name);
    }
    assert.deepEqual(await moduleCalls(app.page), ['toggleStats'], 'only YELLOW calls the module');
    // RETURN sends Esc to the PC and asks for the lock, as before
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await remoteKey(app.page, ...RETURN);
    assert.equal(await lockRequests(app.page), 1, 'RETURN');
    assert.deepEqual(await moduleCalls(app.page), ['sendKeyboardEvent 32795,3,0', 'sendKeyboardEvent 32795,4,0']);
    // With the pointer locked, no key asks again: a click on the locked pointer would press the left mouse button of
    // the PC without releasing it
    await app.page.evaluate(() => {
      Object.defineProperty(document, 'pointerLockElement', { get: () => document.getElementById('wasm_module'), configurable: true });
    });
    await remoteKey(app.page, 39, 'ArrowRight');
    await remoteKey(app.page, ...RETURN);
    assert.equal(await lockRequests(app.page), 0, 'locked');
    await app.page.evaluate(() => {
      delete document.pointerLockElement;
    });
    // The keys of the Stream Menu stay in it: Play/Pause opens it, DOWN and UP move in it, Play/Pause closes it
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.equal((await menuState(app.page)).open, true);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...UP);
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.equal((await menuState(app.page)).open, false);
    assert.equal(await lockRequests(app.page), 0, 'Stream Menu');
    // The next key after it asks again, since the menu released the pointer
    await remoteKey(app.page, ...DOWN);
    assert.equal(await lockRequests(app.page), 1, 'after the Stream Menu');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the first key keeps no default action, so Tab leaves the focus on the stream, and Esc and the modifier keys leave the lock to the next key', async () => {
  // Keys pressed with the real keyboard of this browser (trusted events). Without the lock the keyboard handler of the
  // module leaves a key to the browser, so the default action of the first key ran: Tab moved the focus off the video,
  // and no key reached the stream until the Stream Menu gave it back. Since 2.3.3 the page prevents it
  const app = await openStreaming();
  const keyDefaults = () => app.page.evaluate(() => window.__keyDefaults.splice(0));
  try {
    await app.page.evaluate(() => {
      window.__keyDefaults = [];
      window.addEventListener('keydown', (e) => window.__keyDefaults.push(e.key + (e.defaultPrevented ? ' prevented' : '')));
    });
    await app.page.keyboard.press('Tab');
    assert.equal(await lockRequests(app.page), 1, 'Tab asks for the lock');
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'wasm_module', 'Tab');
    assert.deepEqual(await keyDefaults(), ['Tab prevented']);
    // Shift + Tab: Tab asks, and the focus stays
    await app.page.keyboard.down('Shift');
    await app.page.keyboard.press('Tab');
    await app.page.keyboard.up('Shift');
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'wasm_module', 'Shift + Tab');
    assert.deepEqual(await keyDefaults(), ['Shift prevented', 'Tab prevented']);
    assert.equal(await lockRequests(app.page), 1, 'Shift + Tab');
    // Esc and the modifier keys don't ask: their keydown is no user gesture, without which the browser refuses the lock
    // (each refusal logged 'Error locking mouse'), so the next key gives the stream the keys
    for (const key of ['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) {
      await app.page.keyboard.press(key);
      assert.equal(await lockRequests(app.page), 0, key);
    }
    assert.deepEqual(await keyDefaults(), ['Escape prevented', 'Shift prevented', 'Control prevented', 'Alt prevented',
      'Meta prevented', 'CapsLock prevented']);
    await app.page.keyboard.press('w');
    assert.equal(await lockRequests(app.page), 1, 'W after them');
    // Ctrl + Alt + Shift + S as the first keys: S asks
    for (const key of ['Control', 'Alt', 'Shift']) {
      await app.page.keyboard.down(key);
      assert.equal(await lockRequests(app.page), 0, key);
    }
    await app.page.keyboard.press('s');
    for (const key of ['Shift', 'Alt', 'Control']) {
      await app.page.keyboard.up(key);
    }
    assert.equal(await lockRequests(app.page), 1, 'S of Ctrl + Alt + Shift');
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'wasm_module');
    // The page sends nothing to the PC for these keys (the keyboard handler of the module sends nothing without the lock)
    assert.deepEqual(await moduleCalls(app.page), []);
    // With the pointer locked no key asks again, and the page prevents the default action as the module does
    await keyDefaults();
    await app.page.evaluate(() => {
      Object.defineProperty(document, 'pointerLockElement', { get: () => document.getElementById('wasm_module'), configurable: true });
    });
    await app.page.keyboard.press('Tab');
    assert.deepEqual(await keyDefaults(), ['Tab prevented']);
    assert.equal(await lockRequests(app.page), 0, 'locked');
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'wasm_module', 'locked');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('UP and DOWN stop at the ends of the Stream Menu, so one UP from Resume never selects the entries that quit the app or shut down the PC', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    await remoteKey(app.page, ...PLAY_PAUSE);
    const entries = (await menuState(app.page)).entries;
    assert.equal(entries[0], 'streamMenuResume');
    assert.deepEqual(entries.slice(-2), ['streamMenuQuit', 'streamMenuPower']);
    // UP on the first entry stays there, with the remote and with the D-pad of a gamepad
    await remoteKey(app.page, ...UP);
    assert.equal((await menuState(app.page)).focused, 'streamMenuResume');
    await app.page.evaluate(() => {
      window.__setButton(0, 12, true);
    });
    await app.page.waitForTimeout(100);
    await app.page.evaluate(() => {
      window.__setButton(0, 12, false);
    });
    await app.page.waitForTimeout(100);
    assert.deepEqual(await app.page.evaluate(() => [document.activeElement.id, Views.StreamMenu.view.current().id]),
      ['streamMenuResume', 'streamMenuResume']);
    // OK there resumes the stream: nothing quits the app on the PC
    await remoteKey(app.page, ...ENTER);
    assert.equal((await menuState(app.page)).open, false);
    assert.deepEqual(await app.page.evaluate(() => window.__hostCalls.filter((call) => call === 'quit')), []);
    assert.ok(!(await moduleCalls(app.page)).includes('stopStream'));

    // DOWN on the last entry stays there as well
    await remoteKey(app.page, ...PLAY_PAUSE);
    for (let i = 0; i < entries.length + 2; i++) {
      await remoteKey(app.page, ...DOWN);
    }
    assert.equal((await menuState(app.page)).focused, 'streamMenuPower');
    await remoteKey(app.page, ...UP);
    assert.equal((await menuState(app.page)).focused, 'streamMenuQuit');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a held key that closed the Stream Menu stays away from the PC until it is released', async () => {
  const app = await openStreaming();
  try {
    // OK held on Resume: the menu closes on the first press, and neither the auto-repeat nor the release reaches the
    // stream, which would press Enter on the PC without releasing it
    await remoteKey(app.page, ...PLAY_PAUSE);
    await keyEvent(app.page, 'keydown', ...ENTER);
    assert.deepEqual(await menuState(app.page).then((state) => [state.open, state.focused]), [false, 'wasm_module']);
    await keyEvent(app.page, 'keydown', ...ENTER, true);
    await keyEvent(app.page, 'keydown', ...ENTER, true);
    await keyEvent(app.page, 'keyup', ...ENTER);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    // The next press of OK goes to the stream again, with its release
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.splice(0)), ['keydown 13', 'keyup 13']);

    // RETURN held to close the menu: its auto-repeat doesn't send Esc to the PC (the Back key handler of the stream)
    await remoteKey(app.page, ...PLAY_PAUSE);
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await keyEvent(app.page, 'keydown', ...RETURN);
    assert.equal((await menuState(app.page)).open, false);
    await keyEvent(app.page, 'keydown', ...RETURN, true);
    await keyEvent(app.page, 'keydown', ...RETURN, true);
    await keyEvent(app.page, 'keyup', ...RETURN);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen false']);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);

    // A key held while the menu closes another way (B of a gamepad, here the Resume entry) stays away until released,
    // while the other keys reach the stream at once
    await remoteKey(app.page, ...PLAY_PAUSE);
    await keyEvent(app.page, 'keydown', ...DOWN);
    await app.page.evaluate(() => closeStreamMenu(true));
    await keyEvent(app.page, 'keydown', ...DOWN, true);
    await remoteKey(app.page, 87, 'w');
    await keyEvent(app.page, 'keyup', ...DOWN);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.splice(0)), ['keydown 87', 'keyup 87']);
    await remoteKey(app.page, ...DOWN);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.splice(0)), ['keydown 40', 'keyup 40']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Stream Menu stays inside the safe area of the screen', async () => {
  // A 5.1 stream with a controller: the most entries the menu can show
  const app = await openStreaming({ gamepad: true, stored: { audioConfig: '51Surround' } });
  try {
    await remoteKey(app.page, ...PLAY_PAUSE);
    const box = await app.page.evaluate(() => {
      const rect = document.getElementById('streamMenu').getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
    });
    // 5 % on each side of the 1920 x 1080 screen of the app
    assert.ok(box.left >= box.width * 0.05 && box.right <= box.width * 0.95, JSON.stringify(box));
    // Every entry and the hint show without scrolling, also with the mouse emulation entry of a controller, the surround
    // quality entry of a 5.1 stream and the notes of a changed bitrate and quality
    const fit = await app.page.evaluate(() => {
      changeStreamMenuBitrate(-1);
      // To High, since the stream runs in the default quality, Efficient
      changeStreamMenuSurround(1);
      const menu = document.getElementById('streamMenu');
      return { entries: getOverlayMenuItems('streamMenu').length, note: $('#streamMenuBitrateNote').text() !== '',
        surroundNote: $('#streamMenuSurroundNote').text() !== '', scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight };
    });
    // 12 since 2.3.2, which put the keys for the PC into panels (14 before)
    assert.equal(fit.entries, 12);
    assert.equal(fit.note, true);
    assert.equal(fit.surroundNote, true);
    assert.ok(fit.scrollHeight <= fit.clientHeight, JSON.stringify(fit));
    assert.ok(box.top >= box.height * 0.05 && box.bottom <= box.height * 0.95, JSON.stringify(box));
    assert.ok(box.right >= box.width * 0.9, 'on the right side of the picture: ' + JSON.stringify(box));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('with the statistics in a right corner the Stream Menu opens on the left, and in no corner does it cover the full statistics', async () => {
  // A 7.1 stream: the full statistics with every line, the largest box they have
  const app = await openStreaming({ stored: { performanceStats: 2, audioConfig: '71Surround' } });
  try {
    await app.page.evaluate((text) => handleMessage('StatMsg: {"rtt":12,"lost":2}\n' + text), FULL_TEXT);
    const rectOf = (selector) => app.page.evaluate((query) => {
      const element = Array.prototype.filter.call(document.querySelectorAll(query), (candidate) => !candidate.hidden)[0];
      const rect = element.getBoundingClientRect();
      return { id: element.id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
    }, selector);
    const intersect = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const panels = await app.page.evaluate(() => Object.keys(STREAM_MENU_PANELS));
    assert.ok(panels.indexOf('streamMenuShortcuts') >= 0, JSON.stringify(panels));
    // Top right and bottom right, then the left corners, and from a right corner back to a left one
    for (const corner of ['top-right', 'bottom-right', 'top-left', 'bottom-left', 'top-right', 'top-left']) {
      await app.page.evaluate((value) => showStatsPosition(value), corner);
      await remoteKey(app.page, ...PLAY_PAUSE);
      assert.equal((await menuState(app.page)).open, true, corner);
      const stats = await rectOf('#performance-stats');
      const menu = await rectOf('#streamMenu');
      const onLeft = corner === 'top-right' || corner === 'bottom-right';
      // The box of the full statistics with every line (892 x 822 px)
      assert.ok(stats.right - stats.left > 800 && stats.bottom - stats.top > 700, corner + ' ' + JSON.stringify(stats));
      assert.ok(!intersect(menu, stats), corner + ': the menu ' + JSON.stringify(menu) + ' covers the statistics ' + JSON.stringify(stats));
      // Inside the safe area of the screen, on the side that the statistics leave free
      assert.ok(menu.left >= menu.width * 0.05 && menu.right <= menu.width * 0.95, corner + ' ' + JSON.stringify(menu));
      assert.ok(menu.top >= menu.height * 0.05 && menu.bottom <= menu.height * 0.95, corner + ' ' + JSON.stringify(menu));
      assert.ok(onLeft ? menu.left <= menu.width * 0.1 : menu.right >= menu.width * 0.9, corner + ' ' + JSON.stringify(menu));
      // Each panel of the menu on the same side
      for (const entry of panels) {
        await app.page.evaluate((id) => openStreamMenuPanel(id), entry);
        const panel = await rectOf('#streamMenuOverlay .stream-menu');
        assert.notEqual(panel.id, 'streamMenu', entry);
        assert.ok(onLeft ? panel.left <= panel.width * 0.1 : panel.right >= panel.width * 0.9, corner + ' ' + entry + ' ' + JSON.stringify(panel));
        assert.ok(!intersect(panel, stats), corner + ' ' + entry + ' ' + JSON.stringify(panel));
        await app.page.evaluate(() => closeStreamMenuPanel());
      }
      // And the text panel of Type text…, which opens by its own code and sits at the top
      await app.page.evaluate(() => openStreamText());
      const textPanel = await rectOf('#streamTextPanel');
      assert.equal(await app.page.evaluate(() => isStreamTextOpen), true, corner);
      assert.ok(onLeft ? textPanel.left <= textPanel.width * 0.1 : textPanel.right >= textPanel.width * 0.9, corner + ' Type text ' + JSON.stringify(textPanel));
      assert.ok(textPanel.left >= textPanel.width * 0.05 && textPanel.right <= textPanel.width * 0.95, corner + ' Type text ' + JSON.stringify(textPanel));
      assert.ok(textPanel.top >= textPanel.height * 0.05 && !intersect(textPanel, stats), corner + ' Type text ' + JSON.stringify(textPanel));
      await app.page.evaluate(() => cancelStreamText());
      // The side follows the corner and not the level: the menu doesn't move when its entry steps the statistics
      await app.page.evaluate(() => handleMessage('StatLevelMsg: 1'));
      assert.deepEqual(await rectOf('#streamMenu'), menu, corner);
      await app.page.evaluate(() => handleMessage('StatLevelMsg: 2'));
      await app.page.evaluate((text) => handleMessage('StatMsg: {"rtt":12,"lost":2}\n' + text), FULL_TEXT);
      await remoteKey(app.page, ...RETURN);
      assert.equal((await menuState(app.page)).open, false, corner);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('in every language the Stream Menu shows every entry without scrolling, and each label and note takes one line, also with 10 % wider text', async () => {
  // A 5.1 stream with a controller, so that the mouse emulation and the surround quality entries show
  const app = await openStreaming({ gamepad: true, stored: { audioConfig: '51Surround' } });
  try {
    await remoteKey(app.page, ...PLAY_PAUSE);
    const languages = await app.page.evaluate(() => i18n.getSupportedLocales());
    assert.ok(languages.length >= 5, JSON.stringify(languages));
    for (const language of languages) {
      await app.page.evaluate((locale) => i18n.setLanguage(locale), language);
      await app.page.waitForFunction((locale) => document.documentElement.getAttribute('lang') === locale, language);
      // Both notes of the bitrate entry: the one of a changed bitrate and the one of OK on an unchanged bitrate, also
      // with the widest bitrates since the entry goes up to 250 Mbps: a stream at 247.5 Mbps (chosen with the slider)
      // and the entry one step below it or at it. The surround quality entry shows the wider of its two values with the
      // note of a change at the same time, so that both notes take their lines.
      await forEachTextWidth(app.page, async (stress) => {
        for (const note of ['changed', 'unchanged', 'widest changed', 'widest unchanged']) {
          const fit = await app.page.evaluate((which) => {
            const stream = streamBitrateMbps;
            if (which === 'changed') {
              changeStreamMenuBitrate(-1);
            } else if (which === 'unchanged') {
              changeStreamMenuBitrate(1);
              applyStreamMenuBitrate();
            } else {
              streamBitrateMbps = 247.5;
              streamMenuBitrateMbps = which === 'widest changed' ? 245 : 247.5;
              if (which === 'widest changed') {
                showStreamMenuBitrate();
              } else {
                applyStreamMenuBitrate();
              }
            }
            // The surround quality entry with the note of a change, at whichever of its values is wider. It goes back to
            // the quality of the stream below, since OK on the bitrate entry would reconnect with a change that waits.
            const surroundStream = streamSurroundQuality;
            const surroundValue = document.getElementById('streamMenuSurroundValue');
            const widths = {};
            ['High', 'Efficient'].forEach((quality) => {
              streamMenuSurroundQuality = quality;
              showStreamMenuSurround();
              widths[quality] = surroundValue.getBoundingClientRect().width;
            });
            streamMenuSurroundQuality = widths.High > widths.Efficient ? 'High' : 'Efficient';
            streamSurroundQuality = streamMenuSurroundQuality === 'High' ? 'Efficient' : 'High';
            showStreamMenuSurround();
            const menu = document.getElementById('streamMenu');
            const oneLine = (element) => element.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(element).lineHeight);
            const labels = Array.prototype.filter.call(menu.querySelectorAll('.overlay-menu-label'), (label) => label.offsetParent !== null);
            const value = document.getElementById('streamMenuBitrateValue');
            const result = {
              value: value.textContent,
              valueOneLine: oneLine(value),
              note: $('#streamMenuBitrateNote').text(),
              noteOneLine: oneLine(document.getElementById('streamMenuBitrateNote')),
              longLabels: labels.filter((label) => !oneLine(label)).map((label) => label.textContent),
              scrolls: menu.scrollHeight > menu.clientHeight,
              insideMenu: value.getBoundingClientRect().right <= menu.getBoundingClientRect().right,
              surroundShown: getOverlayMenuItems('streamMenu').some((item) => item.id === 'streamMenuSurround'),
              surroundNote: $('#streamMenuSurroundNote').text(),
              surroundOneLine: oneLine(surroundValue) && oneLine(document.getElementById('streamMenuSurroundNote')),
              surroundInsideMenu: surroundValue.getBoundingClientRect().right <= menu.getBoundingClientRect().right,
            };
            streamSurroundQuality = surroundStream;
            streamMenuSurroundQuality = surroundStream;
            showStreamMenuSurround();
            // Back to the bitrate of the stream after the widest texts, where 'changed' and 'unchanged' step from
            if (which.indexOf('widest') === 0) {
              streamBitrateMbps = stream;
              streamMenuBitrateMbps = stream;
            }
            result.open = isStreamMenuOpen;
            return result;
          }, note);
          assert.ok(fit.open && fit.note !== '' && fit.noteOneLine && fit.valueOneLine && fit.insideMenu && fit.longLabels.length === 0 && !fit.scrolls,
            language + stress + ' ' + JSON.stringify(fit));
          assert.ok(fit.surroundShown && fit.surroundNote !== '' && fit.surroundOneLine && fit.surroundInsideMenu, language + stress + ' ' + JSON.stringify(fit));
          if (note.indexOf('widest') === 0) {
            assert.equal(fit.value, note === 'widest changed' ? '245 Mbps' : '247.5 Mbps', language + stress);
            assert.ok(note === 'widest unchanged' || fit.note.indexOf('247.5') >= 0, language + stress + ' ' + fit.note);
          }
        }
      });
    }
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
    // The module answers the toggle with the next level at once (Off, Compact, Full, Off)
    assert.equal(await app.page.evaluate(() => $('#streamMenuStatsValue').text()), 'Compact');
    assert.equal((await menuState(app.page)).open, true);
    for (const level of ['Full', 'Off', 'Compact']) {
      // The polling has to see A released before the next press counts
      await app.page.waitForTimeout(50);
      await app.page.evaluate(() => window.__setButton(0, 0, true));
      await app.page.waitForTimeout(AFTER_DELAY_MS);
      await app.page.evaluate(() => window.__setButton(0, 0, false));
      assert.equal(await app.page.evaluate(() => $('#streamMenuStatsValue').text()), level);
    }
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'toggleStats', 'toggleStats', 'toggleStats', 'toggleStats']);
    assert.equal((await menuState(app.page)).open, true);

    // B resumes the stream, and the gamepads of the menus are no longer polled
    await app.page.evaluate(() => window.__setButton(0, 1, true));
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    state = await menuState(app.page);
    assert.equal(state.open, false);
    assert.equal(state.focused, 'wasm_module');
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'toggleStats', 'toggleStats', 'toggleStats', 'toggleStats',
      'setStreamMenuOpen false']);
    const readsAfter = await app.page.evaluate(() => window.__padReads);
    await app.page.waitForTimeout(100);
    assert.equal(await app.page.evaluate(() => window.__padReads), readsAfter);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stick that snaps back steps once in the Stream Menu, and no step or repeat of it runs on once the menu closed', async () => {
  const app = await openStreaming({ gamepad: true });
  const { page } = app;
  // Move the left stick up (-1) or down (1), as the next read of the gamepads sees it, and wait
  const stick = async (value, waitMs) => {
    await page.evaluate((v) => {
      window.__pads[0].axes[1] = v;
      window.__pads[0].timestamp++;
    }, value);
    await page.waitForTimeout(waitMs);
  };
  try {
    await page.evaluate(() => handleMessage('streamMenuRequested'));
    await page.waitForTimeout(AFTER_DELAY_MS);
    assert.equal((await menuState(page)).focused, 'streamMenuResume');
    // Down for 100 ms, then the stick snaps back past its centre for 32 ms before it rests: one step down, none back
    await page.evaluate(() => new Promise((resolve) => {
      const move = (value) => {
        window.__pads[0].axes[1] = value;
        window.__pads[0].timestamp++;
      };
      move(0.9);
      setTimeout(() => move(-0.7), 100);
      setTimeout(() => {
        move(0);
        resolve();
      }, 132);
    }));
    await page.waitForTimeout(600);
    assert.equal((await menuState(page)).focused, 'streamMenuStats');

    // Down again, and the menu closes while the stick swings back up: the step back that waits for the stick to stay
    // is dropped with the menu, and nothing repeats during the stream, where the release of the stick is never seen
    await page.evaluate(() => {
      window.__menuSteps = [];
      ['up', 'down'].forEach((name) => {
        const operation = Navigation[name];
        Navigation[name] = function() {
          window.__menuSteps.push(name);
          return operation.apply(this, arguments);
        };
      });
    });
    await stick(0.9, 250);
    assert.deepEqual(await page.evaluate(() => window.__menuSteps), ['down']);
    // The swing back and the closing 40 ms later, timed in the page
    await page.evaluate(() => new Promise((resolve) => {
      window.__pads[0].axes[1] = -0.7;
      window.__pads[0].timestamp++;
      setTimeout(() => {
        closeStreamMenu(true);
        resolve();
      }, 40);
    }));
    await page.waitForTimeout(1200);
    assert.equal((await menuState(page)).open, false);
    assert.deepEqual(await page.evaluate(() => ({ steps: window.__menuSteps, isRepeating: repeatAction !== null,
      stepsBack: Object.keys(gamepadReverseSteps).length })), { steps: ['down'], isRepeating: false, stepsBack: 0 });
    // The menu opens again with the stick still up: its position is the resting state, so nothing moves
    await page.evaluate(() => handleMessage('streamMenuRequested'));
    await page.waitForTimeout(600);
    assert.equal((await menuState(page)).focused, 'streamMenuResume');
    assert.deepEqual(await page.evaluate(() => window.__menuSteps), ['down']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a controller with a timestamp of 0 (Tizen 5.5) that the menus never saw shows the mouse emulation entry once the combo is released', async () => {
  const app = await openStreaming();
  try {
    // The stream took the controller by its input (wasm/gamepad.cpp), and its Select + Start opened the menu: the menus
    // see it first with the combo held, which is no evidence on its own
    await app.page.evaluate((id) => {
      window.__pads[0] = {
        index: 0, id, mapping: 'standard', connected: true, timestamp: 0, vibrationActuator: null,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0],
      };
      window.__setButton(0, 8, true);
      window.__setButton(0, 9, true);
      handleMessage('streamMenuRequested');
    }, XBOX_ID);
    let state = await menuState(app.page);
    assert.equal(state.open, true);
    assert.equal(state.entries.includes('streamMenuMouse'), false);
    // The release makes it count, which shows the entry, and presses nothing in the menu. System information isn't
    // loaded during a stream (as on gamepadconnected).
    const logsBefore = app.logs.length;
    await app.page.evaluate(() => {
      window.__setButton(0, 8, false);
      window.__setButton(0, 9, false);
    });
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    state = await menuState(app.page);
    assert.deepEqual(state.entries.slice(0, 3), ['streamMenuResume', 'streamMenuStats', 'streamMenuMouse']);
    assert.equal(state.focused, 'streamMenuResume');
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true']);
    const logsAfter = app.logs.slice(logsBefore);
    assert.ok(logsAfter.some((line) => line.indexOf('Gamepad 0 counts as a controller now, listing it.') >= 0));
    assert.deepEqual(logsAfter.filter((line) => line.indexOf('[index.js, loadSystemInfo]') >= 0), []);
    // Its D-pad moves in the menu
    await app.page.evaluate(() => window.__setButton(0, 13, true));
    await app.page.waitForTimeout(50);
    await app.page.evaluate(() => window.__setButton(0, 13, false));
    await app.page.waitForTimeout(50);
    assert.equal((await menuState(app.page)).focused, 'streamMenuStats');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the first D-pad press of a controller with a timestamp of 0 goes to the mouse emulation entry that the controller brings', async () => {
  const app = await openStreaming();
  try {
    // A controller in slot 0 that reports a timestamp of 0 and sent no input since the TV listed it
    await app.page.evaluate((id) => {
      window.__pads[0] = {
        index: 0, id, mapping: 'standard', connected: true, timestamp: 0, vibrationActuator: null,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0],
      };
    }, XBOX_ID);
    await remoteKey(app.page, ...PLAY_PAUSE);
    await remoteKey(app.page, ...DOWN);
    let state = await menuState(app.page);
    assert.equal(state.focused, 'streamMenuStats');
    assert.equal(state.entries.includes('streamMenuMouse'), false);
    // Its D-pad down makes it count, which brings the mouse emulation entry after the statistics, and then moves there
    // instead of skipping it
    await app.page.evaluate(() => window.__setButton(0, 13, true));
    await app.page.waitForTimeout(60);
    await app.page.evaluate(() => window.__setButton(0, 13, false));
    await app.page.waitForTimeout(AFTER_DELAY_MS);
    state = await menuState(app.page);
    assert.deepEqual(state.entries.slice(0, 4), ['streamMenuResume', 'streamMenuStats', 'streamMenuMouse', 'streamMenuBitrate']);
    assert.equal(state.focused, 'streamMenuMouse');
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the mouse emulation entry asks the module and shows its answer, the key entries release every key and resume', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    const mouseNotices = () => app.page.evaluate(() => window.__snackbarMessages.filter((message) => message.indexOf('Mouse emulation') === 0));
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.equal(await app.page.evaluate(() => $('#streamMenuMouseValue').text()), 'Off');
    await app.page.evaluate(() => $('#streamMenuMouse').click());
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'toggleMouseEmulation']);
    await app.page.evaluate(() => handleMessage('mouseEmulationOn'));
    assert.equal(await app.page.evaluate(() => $('#streamMenuMouseValue').text()), 'On');
    assert.equal((await menuState(app.page)).open, true);
    // The entry shows the new state, so no notice covers the game for 5 seconds after the menu closes
    assert.deepEqual(await mouseNotices(), []);
    assert.ok(app.logs.some((line) => line.indexOf('Mouse emulation is activated (shown in the Stream Menu).') >= 0));
    // Without the menu (holding Start) the notice says it
    await app.page.evaluate(() => {
      closeStreamMenu(true);
      handleMessage('mouseEmulationOff');
    });
    assert.deepEqual(await mouseNotices(), ['Mouse emulation is deactivated']);
    await app.page.evaluate(() => handleMessage('mouseEmulationOn'));
    assert.deepEqual(await mouseNotices(), ['Mouse emulation is deactivated', 'Mouse emulation is activated']);
    await remoteKey(app.page, ...PLAY_PAUSE);
    await app.page.evaluate(() => window.__wasmCalls.splice(0));

    // Alt + Tab: Alt down, Tab down, Tab up, Alt up, with the Alt flag only while Alt is held; then back to the stream
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await app.page.evaluate(() => $('#streamMenuKeyAltTab').click());
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen false', 'sendKeyboardEvent 32932,3,4', 'sendKeyboardEvent 32777,3,4',
      'sendKeyboardEvent 32777,4,4', 'sendKeyboardEvent 32932,4,0']);
    assert.deepEqual(await menuState(app.page).then((state) => [state.open, state.focused]), [false, 'wasm_module']);

    // The Windows key, Alt + F4, Esc and Alt + Enter
    const sent = {};
    for (const id of ['streamMenuKeyWin', 'streamMenuKeyAltF4', 'streamMenuKeyEsc', 'streamMenuKeyAltEnter']) {
      await remoteKey(app.page, ...PLAY_PAUSE);
      await app.page.evaluate(() => window.__wasmCalls.splice(0));
      await app.page.evaluate((entry) => $('#' + entry).click(), id);
      sent[id] = (await moduleCalls(app.page)).filter((call) => call.indexOf('sendKeyboardEvent') === 0).map((call) => call.split(' ')[1]);
    }
    assert.deepEqual(sent, {
      streamMenuKeyWin: ['32859,3,8', '32859,4,0'],
      streamMenuKeyAltF4: ['32932,3,4', '32883,3,4', '32883,4,4', '32932,4,0'],
      streamMenuKeyEsc: ['32795,3,0', '32795,4,0'],
      // Alt down, Enter down with the Alt flag, Enter up, Alt up without it
      streamMenuKeyAltEnter: ['32932,3,4', '32781,3,4', '32781,4,4', '32932,4,0'],
    });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('when the mouse emulation entry goes under the selection, the entry before it is selected, not the one after it', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    // The controller turned the mouse emulation on and then dropped out (e.g. an empty battery), so the entry shows
    // only because the mouse emulation is on
    await app.page.evaluate(() => {
      handleMessage('mouseEmulationOn');
      const pad = window.__pads[0];
      window.__pads[0] = null;
      const event = new Event('gamepaddisconnected');
      Object.defineProperty(event, 'gamepad', { value: Object.assign({}, pad, { connected: false }) });
      window.dispatchEvent(event);
    });
    await remoteKey(app.page, ...PLAY_PAUSE);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    assert.equal((await menuState(app.page)).focused, 'streamMenuMouse');
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'toggleMouseEmulation']);

    // The module turns it off, and the entry goes: the selection moves up to the performance statistics, marked and
    // focused, and stays in sync with the entries
    await app.page.evaluate(() => handleMessage('mouseEmulationOff'));
    const selection = () => app.page.evaluate(() => ({
      focused: document.activeElement ? document.activeElement.id : '',
      current: Views.StreamMenu.view.current().id,
      marked: Array.prototype.filter.call(document.querySelectorAll('#streamMenu .overlay-menu-item'),
        (item) => item.classList.contains('hovered')).map((item) => item.id),
    }));
    assert.deepEqual(await selection(), { focused: 'streamMenuStats', current: 'streamMenuStats', marked: ['streamMenuStats'] });
    assert.equal((await menuState(app.page)).entries.includes('streamMenuMouse'), false);

    // The next OK toggles the statistics instead of running the entry after it
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await moduleCalls(app.page), ['toggleStats']);
    assert.equal((await menuState(app.page)).open, true);
    // DOWN goes on to the bitrate entry, the entry after the statistics now, and on to 'Shortcuts…'
    await remoteKey(app.page, ...DOWN);
    assert.deepEqual(await selection(), { focused: 'streamMenuBitrate', current: 'streamMenuBitrate', marked: ['streamMenuBitrate'] });
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    assert.deepEqual(await selection(), { focused: 'streamMenuShortcuts', current: 'streamMenuShortcuts', marked: ['streamMenuShortcuts'] });

    // An entry that stays keeps the selection when the entries change: on 'Shortcuts…', a controller that connects
    // brings the mouse emulation entry back before it
    await app.page.evaluate(() => {
      window.__connectPad(0, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)');
      updateStreamMenu();
    });
    assert.deepEqual(await selection(), { focused: 'streamMenuShortcuts', current: 'streamMenuShortcuts', marked: ['streamMenuShortcuts'] });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Disconnect ends the stream, and Quit app on the PC also quits the app on the host once the stream ended', async () => {
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
