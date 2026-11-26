'use strict';

// Checks the panels of the Stream Menu of 2.3.2 in the real page (wasm/platform/menus.js, navigation.js, the keys of
// remote_controller.js and index.js, the gamepad polling of gamepad.js): the first level with the keys for the PC in
// 'Shortcuts…' and 'Function keys…' and 'Shut down or restart the PC…' as its last entry, each panel with the remote and
// a gamepad (RETURN and B go back one level, to the entry that opened the panel, Play/Pause closes everything, a double OK
// presses nothing), the exact key events of the shortcuts and the F keys, the power question (Cancel first) and the power
// sequence in the page with its key events and waits, what the keys and the menu do meanwhile, RETURN and RED, the end of
// the stream after the command (the PC list), the end of the stream with a panel open, and the layout of every panel in
// every language, also with text 10 % wider (tests/browser/text-stress.js). The timing of the sequence on a clock of the
// test and how its end is read are pinned by tests/unit/pc-power.test.js; the menu of a PC by pc-power.test.js. Since
// 2.3.5 'Quit app on the PC' asks first in a panel of its own (streamQuitPanel), which goes back, ends with the stream
// and fits like the others; its answers are checked by stream-menu.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeHostScript } = require('./fake-host');
const { openApp, startHarness } = require('./harness');
const { forEachTextWidth } = require('./text-stress');

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
// delayedNavigation() runs the gamepad buttons of the menus 50 ms later (BUTTON_NAVIGATION_DELAY), and the gamepads are
// polled every 16 ms
const AFTER_DELAY_MS = 250;
// A panel ignores OK for 300 ms after it opened (ACCEPT_GUARD_MS of navigation.js)
const GUARD_MS = 350;

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Simulated gamepads, as in stream-menu.test.js
function simulatedGamepads() {
  window.__pads = [null, null, null, null];
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => window.__pads.slice(),
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

// Open the app with a simulated host (fake-host.js, whose launch and resume wait for the test) and a stream of app 8 that
// reached 'Connection Established', like stream-menu.test.js. window.__startStream() starts the next stream the same way. The module calls get their time
// (performance.now()) in `at`, the views that Navigation pushes, pops and changes go to window.__navigation, showApps()
// and showHosts() are counted, and the keys that would reach the keyboard handler of the stream go to window.__videoKeys.
// The snackbar messages go to window.__snackbarMessages; with options.realSnackbar the snackbar shows them as well.
async function openStreaming(options) {
  const opts = options || {};
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [simulatedGamepads, fakeHostScript], stored: opts.stored });
  if (opts.gamepad) {
    await app.page.evaluate((id) => window.__connectPad(0, id), XBOX_ID);
  }
  await app.page.evaluate(async (realSnackbar) => {
    window.__showApps = 0;
    window.__showHosts = 0;
    const host = window.__createFakeHost({ holdLaunch: true });
    api = host;
    showApps = () => {
      window.__showApps++;
      return Promise.resolve();
    };
    const realShowHosts = showHosts;
    showHosts = function() {
      window.__showHosts++;
      return realShowHosts.apply(this, arguments);
    };
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    window.__snackbarMessages = [];
    if (realSnackbar) {
      // The snackbar shows its messages (one at a time, the others wait), and each one counts once
      const show = snackbar.showSnackbar.bind(snackbar);
      const counted = new WeakSet();
      snackbar.showSnackbar = (data) => {
        if (!counted.has(data)) {
          counted.add(data);
          window.__snackbarMessages.push(data.message);
        }
        show(data);
      };
    } else {
      snackbar.showSnackbar = (data) => window.__snackbarMessages.push(data.message);
    }
    // The time of each call of the module
    const push = window.__wasmCalls.push;
    window.__wasmCalls.push = function(call) {
      call.at = performance.now();
      return push.call(this, call);
    };
    window.__navigation = [];
    const name = (view) => Object.keys(Views).find((key) => Views[key] === view);
    ['push', 'pop', 'change'].forEach((op) => {
      const real = Navigation[op];
      Navigation[op] = (view, hostname) => {
        window.__navigation.push(op + (view ? ' ' + name(view) : ''));
        return real(view, hostname);
      };
    });
    window.__videoKeys = [];
    const video = document.getElementById('wasm_module');
    ['keydown', 'keyup'].forEach((type) => {
      video.addEventListener(type, (e) => window.__videoKeys.push(type + ' ' + e.keyCode), true);
    });
    window.__startStream = async () => {
      startGame(host, 8);
      await new Promise((resolve) => setTimeout(resolve, 100));
      window.__launch.resolve(window.__fakeHostStartAnswer);
      await new Promise((resolve) => setTimeout(resolve, 300));
      host.currentGame = 8;
      handleMessage('Connection Established');
      window.__wasmCalls.length = 0;
      window.__navigation.length = 0;
      window.__videoKeys.length = 0;
    };
    await window.__startStream();
  }, !!opts.realSnackbar);
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

// Two presses of a key of the remote, gapMs apart in the page (a double press), so that the time between them doesn't
// depend on how long a call into the browser takes
const doubleRemoteKey = (page, keyCode, key, gapMs) => page.evaluate(({ code, name, gap }) => new Promise((resolve) => {
  const press = () => ['keydown', 'keyup'].forEach((type) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  });
  press();
  setTimeout(() => {
    press();
    resolve();
  }, gap);
}), { code: keyCode, name: key, gap: gapMs === undefined ? 120 : gapMs });

// Hold a key of the remote: its press, `repeats` auto-repeats of it (repeat: true) 50 ms apart, as the TV sends them,
// then its release, each on the element that has the focus by then
const heldRemoteKey = (page, keyCode, key, repeats) => page.evaluate(({ code, name, count }) => new Promise((resolve) => {
  const send = (type, repeat) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, repeat });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  };
  send('keydown', false);
  let sent = 0;
  const next = () => {
    if (sent === count) {
      send('keyup', false);
      resolve();
      return;
    }
    sent++;
    send('keydown', true);
    setTimeout(next, 50);
  };
  setTimeout(next, 50);
}), { code: keyCode, name: key, count: repeats });

const PLAY_PAUSE = [10252, 'MediaPlayPause'];
const RETURN = [10009, 'XF86Back'];
const DOWN = [40, 'ArrowDown'];
const UP = [38, 'ArrowUp'];
const LEFT = [37, 'ArrowLeft'];
const RIGHT = [39, 'ArrowRight'];
const ENTER = [13, 'Enter'];
const RED = [403, 'ColorF0Red'];
const YELLOW = [405, 'ColorF2Yellow'];
const PAD = { A: 0, B: 1, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

// Press a button of the gamepad: A and B act 50 ms later, the D-pad at once
async function padPress(page, button) {
  await page.evaluate((b) => window.__setButton(0, b, true), button);
  await page.waitForTimeout(button === PAD.A || button === PAD.B ? AFTER_DELAY_MS : 50);
  await page.evaluate((b) => window.__setButton(0, b, false), button);
  await page.waitForTimeout(60);
}

// What the page shows of the Stream Menu and its panels
const state = (page) => page.evaluate(() => {
  const panels = ['streamMenu', 'streamShortcutsPanel', 'streamFKeysPanel', 'streamPowerPanel', 'streamQuitPanel', 'streamTextPanel'];
  return {
    open: isStreamMenuOpen,
    shown: panels.filter((id) => !document.getElementById(id).hidden),
    panel: streamMenuPanel,
    focused: document.activeElement ? document.activeElement.id : '',
    marked: Array.prototype.filter.call(document.querySelectorAll('#streamMenuOverlay .overlay-menu-item.hovered'), (item) => true).map((item) => item.id),
  };
});
const entries = (page, id) => page.evaluate((panelId) => getOverlayMenuItems(panelId).map((item) => item.id), id);
// The calls of the module stub, as 'name args', and the key events and texts among them
const moduleCalls = (page) => page.evaluate(() => window.__wasmCalls.map((call) => call.name + (call.args.length ? ' ' + call.args.join(',') : '')));
const sentToPc = (page) => page.evaluate(() => window.__wasmCalls.filter((call) => call.name === 'sendKeyboardEvent' || call.name === 'sendText')
  .map((call) => call.name + ' ' + call.args.join(',')));

// Open the Stream Menu and move down to an entry with the remote
async function openMenuAt(page, id) {
  await remoteKey(page, ...PLAY_PAUSE);
  for (let i = 0; i < 16; i++) {
    if ((await state(page)).focused === id) {
      return;
    }
    await remoteKey(page, ...DOWN);
  }
  throw new Error('The Stream Menu has no entry ' + id);
}

const WIN_R = ['sendKeyboardEvent 32859,3,8', 'sendKeyboardEvent 32850,3,8', 'sendKeyboardEvent 32850,4,8', 'sendKeyboardEvent 32859,4,0'];
const ENTER_KEY = ['sendKeyboardEvent 32781,3,0', 'sendKeyboardEvent 32781,4,0'];
const ESC_KEY = ['sendKeyboardEvent 32795,3,0', 'sendKeyboardEvent 32795,4,0'];
const COUNTDOWN = 'GAMING-PC shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED';

test('the first level groups the keys for the PC into two panels and ends with Shut down or restart the PC, with arrows only on the panels of keys', async () => {
  for (const config of [{ gamepad: false, stored: {}, count: 10 }, { gamepad: true, stored: { audioConfig: '51Surround' }, count: 12 }]) {
    const app = await openStreaming(config);
    try {
      await remoteKey(app.page, ...PLAY_PAUSE);
      const ids = await entries(app.page, 'streamMenu');
      assert.equal(ids.length, config.count, JSON.stringify(ids));
      assert.deepEqual(ids, ['streamMenuResume', 'streamMenuStats'].concat(config.gamepad ? ['streamMenuMouse'] : [], ['streamMenuBitrate'],
        config.gamepad ? ['streamMenuSurround'] : [], ['streamMenuRefresh', 'streamMenuText', 'streamMenuShortcuts', 'streamMenuFKeys',
          'streamMenuDisconnect', 'streamMenuQuit', 'streamMenuPower']));
      const look = await app.page.evaluate(() => {
        const menu = document.getElementById('streamMenu');
        const icon = (id) => document.querySelector('#' + id + ' .overlay-menu-icon use').getAttribute('xlink:href');
        return {
          // The group label sits right before 'Type text…', the separator right before Disconnect
          group: [menu.querySelector('.overlay-menu-group').textContent, menu.querySelector('.overlay-menu-group').nextElementSibling.id],
          separator: menu.querySelector('.overlay-menu-separator').nextElementSibling.id,
          icons: ['streamMenuShortcuts', 'streamMenuFKeys', 'streamMenuQuit', 'streamMenuPower'].map(icon),
          danger: Array.prototype.filter.call(menu.querySelectorAll('.overlay-menu-item.is-danger'), () => true).map((item) => item.id),
          arrows: Array.prototype.map.call(menu.querySelectorAll('.overlay-menu-more'), (arrow) => arrow.parentNode.id),
          keysOnFirstLevel: menu.querySelectorAll('[id^="streamMenuKey"]').length,
          labels: ['streamMenuShortcuts', 'streamMenuFKeys', 'streamMenuPower'].map((id) => document.querySelector('#' + id + ' .overlay-menu-label').textContent),
        };
      });
      assert.deepEqual(look, {
        group: ['Send to the PC', 'streamMenuText'], separator: 'streamMenuDisconnect',
        icons: ['#i-layout', '#i-apps', '#i-quit', '#i-power'], danger: ['streamMenuQuit', 'streamMenuPower'],
        arrows: ['streamMenuShortcuts', 'streamMenuFKeys'], keysOnFirstLevel: 0,
        labels: ['Shortcuts…', 'Function keys…', 'Shut down or restart the PC…'],
      });
      // The panels: the shortcuts in two named groups in the order of their use, the F keys in their order
      assert.deepEqual(await entries(app.page, 'streamShortcutsPanel'), ['streamMenuKeyAltEnter', 'streamMenuKeyEsc', 'streamMenuKeyAltF4',
        'streamMenuKeyWin', 'streamMenuKeyAltTab']);
      assert.deepEqual(await app.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#streamShortcutsPanel .overlay-menu-group'),
        (group) => group.textContent)), ['In the game', 'Windows']);
      assert.deepEqual(await entries(app.page, 'streamFKeysPanel'), Array.from({ length: 12 }, (value, index) => 'streamMenuKeyF' + (index + 1)));
      assert.deepEqual(await entries(app.page, 'streamPowerPanel'), ['streamPowerCancel', 'streamPowerRestart', 'streamPowerShutdown']);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('Shortcuts… with the remote: OK and RIGHT open it on Alt + Enter, UP and DOWN stop at its ends, and OK sends the keys and resumes', async () => {
  const app = await openStreaming();
  try {
    await openMenuAt(app.page, 'streamMenuShortcuts');
    // A double OK opens the panel, and its second press presses nothing (the panel ignores OK for a moment after it
    // opened)
    await doubleRemoteKey(app.page, ...ENTER);
    let now = await state(app.page);
    assert.deepEqual([now.shown, now.panel, now.focused, now.marked], [['streamShortcutsPanel'], 'streamMenuShortcuts', 'streamMenuKeyAltEnter',
      ['streamMenuKeyAltEnter']]);
    assert.equal(await app.page.evaluate(() => $('#streamShortcutsSubtitle').text()), 'Game 8 · GAMING-PC');
    assert.deepEqual(await sentToPc(app.page), []);
    // UP stays on the first entry, DOWN walks the entries and stays on the last one
    await remoteKey(app.page, ...UP);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyAltEnter');
    const walked = [];
    for (let i = 0; i < 6; i++) {
      await remoteKey(app.page, ...DOWN);
      walked.push((await state(app.page)).focused);
    }
    assert.deepEqual(walked, ['streamMenuKeyEsc', 'streamMenuKeyAltF4', 'streamMenuKeyWin', 'streamMenuKeyAltTab', 'streamMenuKeyAltTab', 'streamMenuKeyAltTab']);
    // LEFT and RIGHT do nothing here
    await remoteKey(app.page, ...RIGHT);
    await remoteKey(app.page, ...LEFT);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyAltTab');
    await remoteKey(app.page, ...RETURN);

    // RIGHT opens it as well, and an arrow ends the wait for OK at once
    await remoteKey(app.page, ...RIGHT);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyAltEnter');
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...UP);
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen false', 'sendKeyboardEvent 32932,3,4', 'sendKeyboardEvent 32781,3,4',
      'sendKeyboardEvent 32781,4,4', 'sendKeyboardEvent 32932,4,0']);
    now = await state(app.page);
    assert.deepEqual([now.open, now.shown, now.panel, now.focused], [false, ['streamMenu'], null, 'wasm_module']);
    // No key of the menu reached the stream
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Function keys… with the remote and the D-pad: a block of 4 x 3 keys that doesn\'t wrap, and OK or A sends exactly its key', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    await openMenuAt(app.page, 'streamMenuFKeys');
    await remoteKey(app.page, ...ENTER);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyF1');
    // F1: LEFT and UP stay
    await remoteKey(app.page, ...LEFT);
    await remoteKey(app.page, ...UP);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyF1');
    const path = [];
    for (const key of [RIGHT, RIGHT, RIGHT, RIGHT, DOWN, DOWN, UP, LEFT]) {
      await remoteKey(app.page, ...key);
      path.push((await state(app.page)).focused.replace('streamMenuKey', ''));
    }
    // RIGHT runs on from F4 to F5, DOWN jumps a row and stays in the last one, LEFT runs back from F5 to F4
    assert.deepEqual(path, ['F2', 'F3', 'F4', 'F5', 'F9', 'F9', 'F5', 'F4']);
    // The block on the screen has the rows that UP and DOWN step by: STREAM_FUNCTION_KEY_COLUMNS keys in a row, F5 under F1
    const grid = await app.page.evaluate(() => {
      const box = (n) => document.getElementById('streamMenuKeyF' + n).getBoundingClientRect();
      const lefts = new Set();
      const tops = new Set();
      for (let n = 1; n <= 12; n++) {
        lefts.add(Math.round(box(n).left));
        tops.add(Math.round(box(n).top));
      }
      return {
        columns: STREAM_FUNCTION_KEY_COLUMNS, lefts: lefts.size, tops: tops.size,
        f5UnderF1: Math.round(box(5).left) === Math.round(box(1).left) && box(5).top > box(1).bottom - 1,
        f4BeforeF5: box(4).top < box(5).top && box(4).left > box(5).left,
      };
    });
    assert.deepEqual(grid, { columns: 4, lefts: 4, tops: 3, f5UnderF1: true, f4BeforeF5: true });
    // The same with the D-pad of the gamepad: down to F12, where RIGHT and DOWN stay
    for (const button of [PAD.DOWN, PAD.DOWN, PAD.RIGHT, PAD.RIGHT, PAD.RIGHT, PAD.DOWN]) {
      await padPress(app.page, button);
    }
    assert.deepEqual((await state(app.page)).marked, ['streamMenuKeyF12']);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyF12');
    await padPress(app.page, PAD.LEFT);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyF11');
    // A on F11: the menu closes, then F11 goes down and up without a modifier
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await padPress(app.page, PAD.A);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen false', 'sendKeyboardEvent 32890,3,0', 'sendKeyboardEvent 32890,4,0']);
    assert.equal((await state(app.page)).open, false);

    // OK of the remote on F5, and the panel opens on F1 again (no memory)
    await openMenuAt(app.page, 'streamMenuFKeys');
    await remoteKey(app.page, ...ENTER);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyF1');
    await remoteKey(app.page, ...DOWN);
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen false', 'sendKeyboardEvent 32884,3,0', 'sendKeyboardEvent 32884,4,0']);
    // Every F key sends its own code: F1 to F12 are 0x70 to 0x7B
    const codes = [];
    for (let n = 1; n <= 12; n++) {
      await remoteKey(app.page, ...PLAY_PAUSE);
      await app.page.evaluate(() => window.__wasmCalls.splice(0));
      await app.page.evaluate((id) => $('#' + id).click(), 'streamMenuKeyF' + n);
      codes.push((await sentToPc(app.page)).join(' / '));
    }
    assert.deepEqual(codes, Array.from({ length: 12 }, (value, index) => 'sendKeyboardEvent ' + (0x8070 + index) + ',3,0 / sendKeyboardEvent ' +
      (0x8070 + index) + ',4,0'));
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RETURN and B go back from each panel to the entry that opened it, also when an entry before it came or went, and Play/Pause closes everything', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    for (const [entry, panel, view] of [['streamMenuShortcuts', 'streamShortcutsPanel', 'StreamShortcuts'], ['streamMenuFKeys', 'streamFKeysPanel', 'StreamFKeys'],
      ['streamMenuPower', 'streamPowerPanel', 'StreamPower'], ['streamMenuQuit', 'streamQuitPanel', 'StreamQuit']]) {
      for (const back of ['RETURN', 'B', 'B after the mouse entry went', 'RETURN after the mouse entry came']) {
        if (back.indexOf('came') > 0) {
          // Without a controller the menu opens without the mouse emulation entry, which comes while the panel shows
          await app.page.evaluate(() => {
            const pad = window.__pads[0];
            if (pad) {
              window.__pads[0] = null;
              const event = new Event('gamepaddisconnected');
              Object.defineProperty(event, 'gamepad', { value: Object.assign({}, pad, { connected: false }) });
              window.dispatchEvent(event);
            }
          });
        }
        await openMenuAt(app.page, entry);
        const entriesAtOpen = (await entries(app.page, 'streamMenu')).length;
        await remoteKey(app.page, ...ENTER);
        assert.deepEqual((await state(app.page)).shown, [panel], entry + ' ' + back);
        if (back.indexOf('went') > 0) {
          // The controller drops out and the mouse emulation is off: the entry before it goes
          await app.page.evaluate(() => {
            const pad = window.__pads[0];
            window.__pads[0] = null;
            const event = new Event('gamepaddisconnected');
            Object.defineProperty(event, 'gamepad', { value: Object.assign({}, pad, { connected: false }) });
            window.dispatchEvent(event);
            updateStreamMenu();
          });
        } else if (back.indexOf('came') > 0) {
          await app.page.evaluate((id) => {
            window.__connectPad(0, id);
            updateStreamMenu();
          }, XBOX_ID);
        }
        // The panel keeps the focus meanwhile, while the entries before the one that opened it changed
        assert.equal((await state(app.page)).panel, entry);
        if (back.indexOf('went') > 0 || back.indexOf('came') > 0) {
          assert.equal((await entries(app.page, 'streamMenu')).length, entriesAtOpen + (back.indexOf('came') > 0 ? 1 : -1), entry + ' ' + back);
        }
        if (back.indexOf('B') === 0) {
          // B of the gamepad (connected again for the case where it went)
          if (!(await app.page.evaluate(() => !!window.__pads[0]))) {
            await app.page.evaluate((id) => window.__connectPad(0, id), XBOX_ID);
          }
          await padPress(app.page, PAD.B);
        } else {
          await remoteKey(app.page, ...RETURN);
        }
        const now = await state(app.page);
        const selection = await app.page.evaluate(() => Views.StreamMenu.view.current().id);
        assert.deepEqual([now.open, now.shown, now.panel, now.focused, now.marked, selection],
          [true, ['streamMenu'], null, entry, [entry], entry], entry + ' ' + back);
        // A second RETURN closes the menu
        await remoteKey(app.page, ...RETURN);
        assert.equal((await state(app.page)).open, false, entry + ' ' + back);
      }
      // Play/Pause in the panel closes the panel and the menu: one view more is popped
      await app.page.evaluate(() => {
        window.__navigation.length = 0;
      });
      await openMenuAt(app.page, entry);
      await remoteKey(app.page, ...ENTER);
      await remoteKey(app.page, ...PLAY_PAUSE);
      const now = await state(app.page);
      assert.deepEqual([now.open, now.shown, now.focused], [false, ['streamMenu'], 'wasm_module'], entry);
      assert.deepEqual(await app.page.evaluate(() => window.__navigation.slice()), ['push StreamMenu', 'push ' + view, 'pop', 'pop'], entry);
      // The next Play/Pause opens on Resume
      await remoteKey(app.page, ...PLAY_PAUSE);
      assert.equal((await state(app.page)).focused, 'streamMenuResume');
      await remoteKey(app.page, ...PLAY_PAUSE);
    }
    // Nothing went to the PC, and RIGHT on the power entry, which has no arrow, opens nothing
    await openMenuAt(app.page, 'streamMenuPower');
    await remoteKey(app.page, ...RIGHT);
    assert.deepEqual((await state(app.page)).shown, ['streamMenu']);
    assert.deepEqual(await sentToPc(app.page), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the power question opens on Cancel, ignores an OK right after it opened, stops at its ends, and Cancel, RETURN and B send nothing', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    await openMenuAt(app.page, 'streamMenuPower');
    // A double OK (the second within 300 ms) opens the question and does nothing more
    await doubleRemoteKey(app.page, ...ENTER);
    let now = await state(app.page);
    assert.deepEqual([now.shown, now.focused, now.marked], [['streamPowerPanel'], 'streamPowerCancel', ['streamPowerCancel']]);
    const texts = await app.page.evaluate(() => ({
      title: $('#streamPowerTitle').text(), subtitle: $('#streamPowerSubtitle').text(), text: $('#streamPowerText').text(),
      labels: getOverlayMenuItems('streamPowerPanel').map((item) => [item.textContent.trim(), item.classList.contains('is-danger')]),
    }));
    assert.deepEqual(texts, {
      title: 'Shut down or restart the PC?', subtitle: 'Game 8 · GAMING-PC',
      text: 'Only for a Windows PC that shows its desktop or a game, not the lock screen. Moonlight Plus opens Run (Windows key + R) and types the command. If an app has unsaved work, Windows asks first. Some games block the Windows key: switch to the desktop first (Alt + Tab).',
      labels: [['Cancel', false], ['Restart the PC', true], ['Shut down the PC', true]],
    });
    // UP on Cancel stays
    await remoteKey(app.page, ...UP);
    assert.equal((await state(app.page)).focused, 'streamPowerCancel');
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    assert.equal((await state(app.page)).focused, 'streamPowerShutdown');
    await remoteKey(app.page, ...DOWN);
    assert.equal((await state(app.page)).focused, 'streamPowerShutdown', 'a held DOWN stops on the last choice');
    // RETURN goes back
    await remoteKey(app.page, ...RETURN);
    now = await state(app.page);
    assert.deepEqual([now.shown, now.focused], [['streamMenu'], 'streamMenuPower']);
    // OK on Cancel goes back, after the wait
    await remoteKey(app.page, ...ENTER);
    await app.page.waitForTimeout(GUARD_MS);
    await remoteKey(app.page, ...ENTER);
    now = await state(app.page);
    assert.deepEqual([now.shown, now.focused], [['streamMenu'], 'streamMenuPower']);
    // B goes back
    await remoteKey(app.page, ...ENTER);
    await padPress(app.page, PAD.DOWN);
    await padPress(app.page, PAD.B);
    now = await state(app.page);
    assert.deepEqual([now.shown, now.focused], [['streamMenu'], 'streamMenuPower']);
    await app.page.waitForTimeout(3500);
    assert.deepEqual(await sentToPc(app.page), []);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Shut down the PC: the menu closes, Windows key + R, the command and Enter go out with their waits, and the keys and the menu stay away meanwhile', async () => {
  const app = await openStreaming({ gamepad: true });
  try {
    // The mouse button presses on the video, with which the page asks the module for the pointer lock
    await app.page.evaluate(() => {
      window.__videoMouseDowns = 0;
      document.getElementById('wasm_module').addEventListener('mousedown', () => window.__videoMouseDowns++, true);
    });
    await openMenuAt(app.page, 'streamMenuPower');
    await remoteKey(app.page, ...ENTER);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    const confirmedAt = await app.page.evaluate(() => performance.now());
    await remoteKey(app.page, ...ENTER);
    let now = await state(app.page);
    assert.deepEqual([now.open, now.shown], [false, ['streamMenu']]);
    // The countdown says what happens and how to stop it
    assert.deepEqual(await app.page.evaluate(() => window.__snackbarMessages.slice(-1)), [COUNTDOWN]);
    assert.equal(await app.page.evaluate(() => isPcPowerSequenceRunning()), true);
    // Meanwhile OK, the arrows and the number keys stay away from the PC, Play/Pause and the gamepad combo don't open the
    // menu, and YELLOW still steps the statistics
    await remoteKey(app.page, ...ENTER);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, 49, '1');
    await remoteKey(app.page, ...PLAY_PAUSE);
    await app.page.evaluate(() => handleMessage('streamMenuRequested'));
    await remoteKey(app.page, ...YELLOW);
    assert.equal((await state(app.page)).open, false);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.equal(await app.page.evaluate(() => window.__videoMouseDowns), 0, 'no key asks for the pointer lock meanwhile');
    await app.page.waitForFunction(() => window.__wasmCalls.some((call) => call.name === 'sendKeyboardEvent' && call.args[0] === 32781), null, { timeout: 5000 });
    await app.page.waitForTimeout(100);
    const calls = await app.page.evaluate(() => window.__wasmCalls.map((call) => ({ text: call.name + (call.args.length ? ' ' + call.args.join(',') : ''), at: call.at })));
    // The input of the module stays paused from the menu until Enter: no 'setStreamMenuOpen false' at the confirmation,
    // which pauses it once more for the sequence
    assert.deepEqual(calls.map((call) => call.text), ['setStreamMenuOpen true', 'setStreamMenuOpen true', 'toggleStats', ...WIN_R,
      'sendText shutdown /s /t 0', ...ENTER_KEY, 'setStreamMenuOpen false']);
    const at = (text) => calls.find((call) => call.text === text).at - confirmedAt;
    // 300 ms, 2 s and 0.5 s, give or take the time the page needs
    assert.ok(at(WIN_R[0]) >= 290 && at(WIN_R[0]) < 900, 'Windows key + R at ' + at(WIN_R[0]));
    assert.ok(at('sendText shutdown /s /t 0') - at(WIN_R[3]) >= 1990 && at('sendText shutdown /s /t 0') - at(WIN_R[3]) < 2600, 'text');
    assert.ok(at(ENTER_KEY[0]) - at('sendText shutdown /s /t 0') >= 490 && at(ENTER_KEY[0]) - at('sendText shutdown /s /t 0') < 1100, 'Enter');
    assert.deepEqual(await app.page.evaluate(() => window.__snackbarMessages.slice(-1)), ['Shutdown command sent to the PC']);
    // The command never goes to the log
    assert.ok(!app.logs.some((line) => line.indexOf('shutdown /') >= 0), 'the log has no command');
    assert.ok(app.logs.some((line) => line.indexOf('PC power (shutdown, from the Stream Menu): Enter sent') >= 0));
    // After Enter the stream goes on: the keys reach the PC again, and the menu opens. The menu found the pointer
    // unlocked, so the first key asks for the lock (since 2.3.3), which gives the stream the keys
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'wasm_module');
    assert.equal(await app.page.evaluate(() => window.__videoMouseDowns), 0);
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), ['keydown 13', 'keyup 13']);
    assert.equal(await app.page.evaluate(() => window.__videoMouseDowns), 1, 'the first key after Enter asks for the pointer lock');
    await remoteKey(app.page, ...PLAY_PAUSE);
    now = await state(app.page);
    assert.deepEqual([now.open, now.focused], [true, 'streamMenuResume']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RETURN cancels the command and closes Run with Esc, the stream goes on; RED ends the stream and closes Run before the stop', async () => {
  const app = await openStreaming();
  try {
    // RETURN after Windows key + R
    await openMenuAt(app.page, 'streamMenuPower');
    await remoteKey(app.page, ...ENTER);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...ENTER);
    await app.page.waitForTimeout(900);
    await remoteKey(app.page, ...RETURN);
    await app.page.waitForTimeout(3000);
    assert.deepEqual(await sentToPc(app.page), [...WIN_R, ...ESC_KEY]);
    assert.deepEqual(await app.page.evaluate(() => window.__snackbarMessages.slice(-2)),
      ['GAMING-PC restarts in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED', 'Cancelled']);
    assert.deepEqual(await app.page.evaluate(() => [isInGame, isPcPowerSequenceRunning(), pcPowerCommand, document.activeElement.id]), [true, false, null, 'wasm_module']);
    assert.ok(!(await moduleCalls(app.page)).includes('stopStream'));
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);

    // RED after the command was typed: Esc, then the stop, and nothing more
    await app.page.evaluate(() => window.__wasmCalls.splice(0));
    await openMenuAt(app.page, 'streamMenuPower');
    await remoteKey(app.page, ...ENTER);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...ENTER);
    await app.page.waitForFunction(() => window.__wasmCalls.some((call) => call.name === 'sendText'), null, { timeout: 5000 });
    await remoteKey(app.page, ...RED);
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await app.page.waitForTimeout(1500);
    assert.deepEqual(await moduleCalls(app.page), ['setStreamMenuOpen true', 'setStreamMenuOpen true', ...WIN_R, 'sendText shutdown /s /t 0', ...ESC_KEY,
      'setStreamMenuOpen false', 'stopStream']);
    // An ordinary end: the app list
    assert.equal(await app.page.evaluate(() => window.__showApps), 1);
    assert.equal(await app.page.evaluate(() => window.__showHosts), 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a held RETURN goes back one level only, and the RIGHT that opens Function keys… doesn\'t run on in it while it is held', async () => {
  const app = await openStreaming();
  try {
    for (const entry of ['streamMenuShortcuts', 'streamMenuFKeys', 'streamMenuPower', 'streamMenuQuit', 'streamMenuText']) {
      await openMenuAt(app.page, entry);
      await remoteKey(app.page, ...ENTER);
      assert.notDeepEqual((await state(app.page)).shown, ['streamMenu'], entry);
      // The press goes back to the first level, its auto-repeat no further
      await heldRemoteKey(app.page, ...RETURN, 3);
      const now = await state(app.page);
      assert.deepEqual([now.open, now.shown, now.focused], [true, ['streamMenu'], entry], entry);
      await remoteKey(app.page, ...RETURN);
      assert.equal((await state(app.page)).open, false, entry);
    }
    // RIGHT held on Function keys…: the panel opens on F1 and stays there until a key is pressed anew
    await openMenuAt(app.page, 'streamMenuFKeys');
    await heldRemoteKey(app.page, ...RIGHT, 4);
    assert.deepEqual([(await state(app.page)).shown, (await state(app.page)).focused], [['streamFKeysPanel'], 'streamMenuKeyF1']);
    await remoteKey(app.page, ...RIGHT);
    assert.equal((await state(app.page)).focused, 'streamMenuKeyF2');
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.deepEqual(await sentToPc(app.page), []);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the background and a refused command stop the sequence: Run is closed with Esc, and a stream that goes on gets the focus back', async () => {
  const app = await openStreaming();
  try {
    const hide = (hidden) => app.page.evaluate((isHidden) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (isHidden ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    const confirmShutdown = async () => {
      await openMenuAt(app.page, 'streamMenuPower');
      await remoteKey(app.page, ...ENTER);
      await remoteKey(app.page, ...DOWN);
      await remoteKey(app.page, ...DOWN);
      await remoteKey(app.page, ...ENTER);
      await app.page.waitForFunction(() => pcPowerCommand && pcPowerCommand.runSentAt > 0, null, { timeout: 3000 });
    };

    // Moonlight goes to the background after Windows key + R and is stopped there (endStreamInBackground()): Esc before
    // the stop, so that Run doesn't stay open on the PC with the command. The hidden page pauses the controllers first
    // (setAppHidden(), since 2.3.5), which the keys of the sequence don't depend on.
    await confirmShutdown();
    await hide(true);
    await app.page.evaluate(() => endStreamInBackground('test'));
    let calls = await moduleCalls(app.page);
    assert.deepEqual(calls.slice(calls.indexOf(WIN_R[3]) + 1), ['setAppHidden true', ...ESC_KEY, 'setStreamMenuOpen false', 'stopStream']);
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await app.page.waitForTimeout(300);
    assert.deepEqual(await app.page.evaluate(() => [isInGame, pcPowerCommand, window.__showApps, window.__showHosts]), [false, null, 1, 0]);
    await hide(false);
    await app.page.evaluate(() => {
      window.__snackbarMessages.length = 0;
      window.__showApps = 0;
    });
    await app.page.evaluate(() => window.__startStream());

    // Moonlight goes to the background after Windows key + R and comes back 2 s later, within the 60 s before the
    // background stop: the next step closes Run, and the stream that goes on gets the focus back for the remote
    await confirmShutdown();
    await hide(true);
    await app.page.waitForFunction(() => pcPowerCommand && pcPowerCommand.stopped, null, { timeout: 4000 });
    await hide(false);
    calls = await moduleCalls(app.page);
    assert.deepEqual(calls.slice(calls.indexOf(WIN_R[3]) + 1), ['setAppHidden true', ...ESC_KEY, 'setStreamMenuOpen false', 'setAppHidden false']);
    assert.deepEqual(await app.page.evaluate(() => [isInGame, document.activeElement.id]), [true, 'wasm_module']);
    await remoteKey(app.page, ...DOWN);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), ['keydown 40', 'keyup 40']);
    await app.page.evaluate(() => {
      window.__videoKeys.length = 0;
      window.__wasmCalls.length = 0;
      window.__snackbarMessages.length = 0;
    });

    // The module refuses the command (-5, its queue is full): no Enter, Run is closed 500 ms later, the message says so,
    // and the stream gets the focus back, where the next OK reaches the PC
    await app.page.evaluate(() => {
      window.__sendText = Module.sendText;
      Module.sendText = function(text) {
        window.__wasmCalls.push({ name: 'sendText', args: [text], at: performance.now() });
        return -5;
      };
    });
    await confirmShutdown();
    await app.page.waitForFunction(() => window.__wasmCalls.some((call) => call.name === 'sendKeyboardEvent' && call.args[0] === 32795 && call.args[1] === 4),
      null, { timeout: 5000 });
    await app.page.waitForTimeout(200);
    calls = await moduleCalls(app.page);
    assert.deepEqual(calls.slice(calls.indexOf(WIN_R[3]) + 1), ['sendText shutdown /s /t 0', ...ESC_KEY, 'setStreamMenuOpen false']);
    assert.ok(!calls.includes(ENTER_KEY[0]), 'no Enter');
    assert.deepEqual(await app.page.evaluate(() => window.__snackbarMessages.slice(-1)), ['The command couldn\'t be sent to the PC. Try again.']);
    assert.deepEqual(await app.page.evaluate(() => [isInGame, document.activeElement.id]), [true, 'wasm_module']);
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await app.page.evaluate(() => window.__videoKeys.slice()), ['keydown 13', 'keyup 13']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the snackbar shows the countdown only while it is true: Cancelled and the command sent show in its place at once', async () => {
  const app = await openStreaming({ realSnackbar: true });
  try {
    // What the snackbar shows on the screen
    const shown = () => app.page.evaluate(() => {
      const snackbar = document.getElementById('snackbar');
      return snackbar.classList.contains('mdl-snackbar--active') ? snackbar.querySelector('.mdl-snackbar__text').textContent : '';
    });
    const confirm = async (choice) => {
      await openMenuAt(app.page, 'streamMenuPower');
      await remoteKey(app.page, ...ENTER);
      await remoteKey(app.page, ...DOWN);
      if (choice === 'shutdown') {
        await remoteKey(app.page, ...DOWN);
      }
      await remoteKey(app.page, ...ENTER);
    };
    // A message that showed before (it would keep the countdown waiting for its 5 s): the countdown takes its place
    await app.page.evaluate(() => snackbarLogLong('Text sent to the PC'));
    await confirm('shutdown');
    await app.page.waitForTimeout(400);
    assert.equal(await shown(), COUNTDOWN);
    // RETURN cancels: Cancelled shows within a moment (the fade of the countdown), the countdown never again
    await remoteKey(app.page, ...RETURN);
    await app.page.waitForTimeout(400);
    assert.equal(await shown(), 'Cancelled');
    await app.page.waitForTimeout(4000);
    assert.notEqual(await shown(), COUNTDOWN);
    await app.page.waitForFunction(() => !document.getElementById('snackbar').classList.contains('mdl-snackbar--active'), null, { timeout: 5000 });

    // Enter: the countdown ends, and the command sent shows at once, not 5 s after the countdown began
    await confirm('shutdown');
    await app.page.waitForFunction(() => pcPowerCommand && pcPowerCommand.sentAt > 0, null, { timeout: 5000 });
    const sentAt = await app.page.evaluate(() => pcPowerCommand.sentAt);
    await app.page.waitForFunction(() => document.querySelector('#snackbar .mdl-snackbar__text').textContent === 'Shutdown command sent to the PC' &&
      document.getElementById('snackbar').classList.contains('mdl-snackbar--active'), null, { timeout: 3000 });
    const showsAfter = (await app.page.evaluate(() => performance.now())) - sentAt;
    assert.ok(showsAfter < 1000, 'the message shows ' + Math.round(showsAfter) + ' ms after Enter');
    // The end of the stream: the PC list says so at once
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await app.page.waitForTimeout(400);
    assert.equal(await shown(), 'GAMING-PC is shutting down.');
    assert.deepEqual(await app.page.evaluate(() => window.__snackbarMessages.slice()), ['Text sent to the PC', COUNTDOWN, 'Cancelled', COUNTDOWN,
      'Shutdown command sent to the PC', 'GAMING-PC is shutting down.']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the end of the stream after Enter: the PC list with "is shutting down." when the PC ends it, without a message when the TV does', async () => {
  // [how it ends, seconds after Enter, kind, what shows]
  const cases = [
    ['streamTerminated: 0', 5, 'shutdown', 'hosts', 'GAMING-PC is shutting down.'],
    ['streamTerminated: -1', 60, 'shutdown', 'hosts', 'GAMING-PC is shutting down.'],
    ['streamTerminated: 0', 60, 'shutdown', 'apps', null],
    ['streamTerminated: 0', 5, 'restart', 'hosts', 'GAMING-PC is restarting.'],
    ['RED', 10, 'shutdown', 'hosts', null],
    ['Disconnect', 40, 'shutdown', 'apps', null],
  ];
  const app = await openStreaming();
  try {
    for (const [end, seconds, kind, view, message] of cases) {
      const name = [end, seconds + ' s', kind].join(', ');
      await app.page.evaluate(() => {
        // Short waits for this test; the unit test pins the real ones
        PC_POWER_MENU_DELAY_MS = 10;
        PC_POWER_TYPE_DELAY_MS = 10;
        PC_POWER_ENTER_DELAY_MS = 10;
      });
      await openMenuAt(app.page, 'streamMenuPower');
      await remoteKey(app.page, ...ENTER);
      await remoteKey(app.page, ...DOWN);
      if (kind === 'shutdown') {
        await remoteKey(app.page, ...DOWN);
      }
      await remoteKey(app.page, ...ENTER);
      await app.page.waitForFunction(() => pcPowerCommand && pcPowerCommand.sentAt > 0, null, { timeout: 3000 });
      await app.page.evaluate((s) => {
        pcPowerCommand.sentAt -= s * 1000;
        window.__snackbarMessages.length = 0;
        window.__showApps = 0;
        window.__showHosts = 0;
        window.__hostCalls.length = 0;
      }, seconds);
      if (end === 'RED') {
        await remoteKey(app.page, ...RED);
        await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
      } else if (end === 'Disconnect') {
        await remoteKey(app.page, ...PLAY_PAUSE);
        await app.page.evaluate(() => $('#streamMenuDisconnect').click());
        await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
      } else {
        await app.page.evaluate((msg) => handleMessage(msg), end);
      }
      await app.page.waitForTimeout(400);
      const result = await app.page.evaluate(() => ({
        showHosts: window.__showHosts, showApps: window.__showApps, messages: window.__snackbarMessages.slice(), hostCalls: window.__hostCalls.slice(),
        hostGrid: $('#host-grid').is(':visible'), command: pcPowerCommand, inGame: isInGame,
      }));
      if (view === 'hosts') {
        assert.deepEqual([result.showHosts, result.showApps, result.hostGrid, result.hostCalls], [1, 0, true, []], name);
      } else {
        assert.deepEqual([result.showHosts, result.showApps], [0, 1], name);
      }
      // No error message and no retry
      assert.deepEqual(result.messages, message ? [message] : [], name);
      assert.equal(result.command, null, name);
      assert.equal(result.inGame, false, name);
      await app.page.evaluate(() => window.__startStream());
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a new bitrate after Enter reconnects the stream, since the command is dropped, instead of going to the PC list', async () => {
  const app = await openStreaming();
  try {
    await app.page.evaluate(() => {
      PC_POWER_MENU_DELAY_MS = 10;
      PC_POWER_TYPE_DELAY_MS = 10;
      PC_POWER_ENTER_DELAY_MS = 10;
      SETTINGS_RESTART_DELAY_MS = 100;
    });
    await openMenuAt(app.page, 'streamMenuPower');
    await remoteKey(app.page, ...ENTER);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...DOWN);
    await remoteKey(app.page, ...ENTER);
    await app.page.waitForFunction(() => pcPowerCommand && pcPowerCommand.sentAt > 0, null, { timeout: 3000 });
    // 10 s later: Bitrate, LEFT, OK
    await app.page.evaluate(() => {
      pcPowerCommand.sentAt -= 10000;
    });
    await openMenuAt(app.page, 'streamMenuBitrate');
    await remoteKey(app.page, ...LEFT);
    await remoteKey(app.page, ...ENTER);
    assert.equal(await app.page.evaluate(() => pcPowerCommand), null);
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await app.page.waitForTimeout(400);
    const result = await app.page.evaluate(() => ({ showHosts: window.__showHosts, inGame: isInGame, message: $('#loadingSpinnerMessage').text(),
      starts: window.__hostCalls.filter((call) => call === 'refresh').length }));
    assert.equal(result.showHosts, 0);
    assert.equal(result.inGame, true);
    assert.match(result.message, /^Reconnecting with \d+ Mbps\.\.\.$|^Starting Game 8\.\.\.$/);
    assert.ok(result.starts >= 1, 'startGame() refreshed the server info for the reconnect');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the stream ends with a panel open: the panel and the menu close with their views, nothing is sent, and the next menu opens on Resume', async () => {
  const app = await openStreaming();
  try {
    for (const entry of ['streamMenuShortcuts', 'streamMenuFKeys', 'streamMenuPower', 'streamMenuQuit']) {
      for (const end of ['streamTerminated: -1', 'RED', 'Play/Pause, then RED']) {
        const name = entry + ', ' + end;
        await openMenuAt(app.page, entry);
        await remoteKey(app.page, ...ENTER);
        await app.page.evaluate(() => {
          window.__navigation.length = 0;
        });
        if (end === 'streamTerminated: -1') {
          await app.page.evaluate(() => handleMessage('streamTerminated: -1'));
        } else {
          if (end !== 'RED') {
            await remoteKey(app.page, ...PLAY_PAUSE);
          }
          await remoteKey(app.page, ...RED);
          await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
        }
        await app.page.waitForTimeout(150);
        const now = await state(app.page);
        assert.deepEqual([now.open, now.shown, now.panel], [false, ['streamMenu'], null], name);
        // The panel and the menu pop their views, then the app list takes the keys, as without a panel
        assert.deepEqual(await app.page.evaluate(() => window.__navigation.slice()), ['pop', 'pop', 'change Apps'], name);
        assert.deepEqual(await sentToPc(app.page), [], name);
        await app.page.evaluate(() => window.__startStream());
        await remoteKey(app.page, ...PLAY_PAUSE);
        const next = await state(app.page);
        assert.deepEqual([next.open, next.shown, next.focused], [true, ['streamMenu'], 'streamMenuResume'], name);
        await remoteKey(app.page, ...PLAY_PAUSE);
      }
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the entries that change behind a panel (a controller, YELLOW) leave the focus in the panel, and the first level marks nothing', async () => {
  const app = await openStreaming();
  try {
    await openMenuAt(app.page, 'streamMenuFKeys');
    await remoteKey(app.page, ...ENTER);
    await remoteKey(app.page, ...RIGHT);
    await app.page.evaluate((id) => {
      window.__connectPad(0, id);
      updateStreamMenu();
    }, XBOX_ID);
    await remoteKey(app.page, ...YELLOW);
    const now = await state(app.page);
    assert.deepEqual([now.shown, now.focused, now.marked], [['streamFKeysPanel'], 'streamMenuKeyF2', ['streamMenuKeyF2']]);
    // The mouse emulation entry came, and the statistics show their next level, behind the panel
    assert.deepEqual(await app.page.evaluate(() => [!document.getElementById('streamMenuMouse').hidden, $('#streamMenuStatsValue').text()]), [true, 'Compact']);
    await remoteKey(app.page, ...RETURN);
    const back = await state(app.page);
    assert.deepEqual([back.focused, back.marked], ['streamMenuFKeys', ['streamMenuFKeys']]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('in every language the first level and each panel fit the safe area without scrolling, with every label on one line, also with 10 % wider text', async () => {
  // A 5.1 stream with a controller, so that the first level has its most entries
  const app = await openStreaming({ gamepad: true, stored: { audioConfig: '51Surround' } });
  try {
    const languages = await app.page.evaluate(() => i18n.getSupportedLocales());
    assert.ok(languages.length >= 5, JSON.stringify(languages));
    for (const language of languages) {
      await app.page.evaluate((locale) => i18n.setLanguage(locale), language);
      await app.page.waitForFunction((locale) => document.documentElement.getAttribute('lang') === locale, language);
      await forEachTextWidth(app.page, async (stress) => {
        for (const [entry, panel] of [[null, 'streamMenu'], ['streamMenuShortcuts', 'streamShortcutsPanel'], ['streamMenuFKeys', 'streamFKeysPanel'],
          ['streamMenuPower', 'streamPowerPanel'], ['streamMenuQuit', 'streamQuitPanel']]) {
          const name = language + stress + ' ' + panel;
          await remoteKey(app.page, ...PLAY_PAUSE);
          if (entry) {
            await app.page.evaluate((id) => runStreamMenuAction(id), entry);
          } else {
            // The tallest state: both notes of the bitrate and the surround quality
            await app.page.evaluate(() => {
              changeStreamMenuBitrate(-1);
              changeStreamMenuSurround(streamSurroundQuality === 'High' ? -1 : 1);
            });
          }
          const fit = await app.page.evaluate((id) => {
            const box = document.getElementById(id);
            const rect = box.getBoundingClientRect();
            // The lines of a text: its height without its padding, in lines
            const lines = (element) => {
              const style = getComputedStyle(element);
              return Math.round((element.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) /
                parseFloat(style.lineHeight));
            };
            const labels = Array.prototype.filter.call(box.querySelectorAll('.overlay-menu-label'), (label) => label.offsetParent !== null);
            const title = box.querySelector('.overlay-menu-title');
            return {
              entries: getOverlayMenuItems(id).length,
              inside: rect.top >= window.innerHeight * 0.05 && rect.bottom <= window.innerHeight * 0.95 && rect.left >= window.innerWidth * 0.05 &&
                rect.right <= window.innerWidth * 0.95,
              scrolls: box.scrollHeight > box.clientHeight,
              longLabels: labels.filter((label) => lines(label) > 1 || label.getBoundingClientRect().right > label.parentNode.getBoundingClientRect().right + 0.5 ||
                label.scrollWidth > label.clientWidth + 1).map((label) => label.textContent),
              titleLines: lines(title),
              titleCut: title.scrollWidth > title.clientWidth + 1,
              hintLines: lines(box.querySelector('.overlay-menu-hint')),
              rect: [Math.round(rect.top), Math.round(rect.bottom)],
            };
          }, panel);
          assert.ok(fit.inside && !fit.scrolls, name + ' ' + JSON.stringify(fit));
          assert.deepEqual(fit.longLabels, [], name);
          assert.equal(fit.titleCut, false, name);
          assert.ok(panel === 'streamPowerPanel' ? fit.titleLines <= 2 : fit.titleLines === 1, name + ' ' + JSON.stringify(fit));
          assert.equal(fit.hintLines, 1, name);
          assert.equal(fit.entries, { streamMenu: 12, streamShortcutsPanel: 5, streamFKeysPanel: 12, streamPowerPanel: 3, streamQuitPanel: 2 }[panel], name);
          await app.page.evaluate(() => {
            streamMenuBitrateMbps = streamBitrateMbps;
            showStreamMenuBitrate();
            streamMenuSurroundQuality = streamSurroundQuality;
            showStreamMenuSurround();
            closeStreamMenu(true);
          });
        }
      });
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
