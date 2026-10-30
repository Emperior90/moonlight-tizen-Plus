'use strict';

// Pins the pure logic of the Stream Menu and the app menu (wasm/platform/menus.js): the keyboard events of a key
// combination for the PC (every key and modifier released again), the hidden apps of a host (matched by ID or title,
// stored per host in localStorage), which apps the app grid shows, and which entries the app menu offers. The browser
// tests (tests/browser/stream-menu.test.js and app-menu.test.js) run the menus in the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const KEY_DOWN = 0x03;
const KEY_UP = 0x04;

function loadMenus() {
  return loadPlatformScripts(['wasm/platform/menus.js']);
}

test('Alt + Tab: Alt goes down first and up last, with the Alt flag only while Alt is held', () => {
  const menus = loadMenus();
  const events = plain(menus.get('buildKeyComboEvents')([0xA4, 0x09]));
  assert.deepEqual(events, [
    { keyCode: 0xA4, action: KEY_DOWN, modifiers: 0x04 },
    { keyCode: 0x09, action: KEY_DOWN, modifiers: 0x04 },
    { keyCode: 0x09, action: KEY_UP, modifiers: 0x04 },
    { keyCode: 0xA4, action: KEY_UP, modifiers: 0 },
  ]);
});

test('every key combination of the Stream Menu releases each key it pressed and ends without a modifier', () => {
  const menus = loadMenus();
  const combos = plain(menus.get('STREAM_MENU_KEYS'));
  assert.deepEqual(Object.keys(combos), ['streamMenuKeyWin', 'streamMenuKeyAltTab', 'streamMenuKeyAltF4', 'streamMenuKeyEsc',
    'streamMenuKeyAltEnter']);
  assert.deepEqual(combos, {
    streamMenuKeyWin: [0x5B],
    streamMenuKeyAltTab: [0xA4, 0x09],
    streamMenuKeyAltF4: [0xA4, 0x73],
    streamMenuKeyEsc: [0x1B],
    // Alt + Enter: fullscreen or window in the game
    streamMenuKeyAltEnter: [0xA4, 0x0D],
  });
  Object.keys(combos).forEach((id) => {
    const events = plain(menus.get('buildKeyComboEvents')(combos[id]));
    const held = new Set();
    events.forEach((event) => {
      if (event.action === KEY_DOWN) {
        assert.ok(!held.has(event.keyCode), id + ': a key goes down twice');
        held.add(event.keyCode);
      } else {
        assert.ok(held.has(event.keyCode), id + ': a key comes up that is not down');
        held.delete(event.keyCode);
      }
    });
    assert.equal(held.size, 0, id + ': a key stays held');
    assert.equal(events[events.length - 1].modifiers, 0, id + ': a modifier stays held');
    assert.equal(events.length, combos[id].length * 2);
  });
  // The Windows key is the meta modifier while it is held
  assert.deepEqual(plain(menus.get('buildKeyComboEvents')([0x5B])), [
    { keyCode: 0x5B, action: KEY_DOWN, modifiers: 0x08 },
    { keyCode: 0x5B, action: KEY_UP, modifiers: 0 },
  ]);
});

test('sendKeyComboToHost() sends the events with the key prefix of the module', () => {
  const calls = [];
  const menus = loadPlatformScripts(['wasm/platform/menus.js'], {
    globals: { Module: { sendKeyboardEvent: (...args) => calls.push(args) } },
  });
  menus.get('sendKeyComboToHost')([0xA4, 0x73]);
  assert.deepEqual(calls, [[0x80A4, KEY_DOWN, 0x04], [0x8073, KEY_DOWN, 0x04], [0x8073, KEY_UP, 0x04], [0x80A4, KEY_UP, 0]]);
});

test('an app is hidden by its ID or by its title, and showing it again removes both', () => {
  const menus = loadMenus();
  const isAppHidden = menus.get('isAppHidden');
  const setAppHidden = menus.get('setAppHidden');
  let hidden = setAppHidden([], { id: 7, title: 'Desktop' }, true);
  assert.deepEqual(plain(hidden), [{ id: '7', title: 'Desktop' }]);
  assert.equal(isAppHidden(hidden, { id: '7', title: 'Desktop' }), true);
  // Sunshine gave the app a new ID: the title still matches
  assert.equal(isAppHidden(hidden, { id: 99, title: 'Desktop' }), true);
  // An app with the old ID and another title (IDs of GameStream stay) matches too
  assert.equal(isAppHidden(hidden, { id: 7, title: 'Renamed' }), true);
  assert.equal(isAppHidden(hidden, { id: 8, title: 'Steam Big Picture' }), false);
  // Hiding twice keeps one entry; showing again removes the entries of the ID and of the title
  hidden = setAppHidden(hidden, { id: 7, title: 'Desktop' }, true);
  assert.equal(hidden.length, 1);
  hidden = setAppHidden(hidden.concat([{ id: '5', title: 'Desktop' }]), { id: 99, title: 'Desktop' }, false);
  assert.deepEqual(plain(hidden), []);
  // An entry without a title never matches every app without a title
  assert.equal(isAppHidden([{ id: '3', title: '' }], { id: 4, title: '' }), false);
});

test('the hidden apps are stored per host and survive a broken entry', () => {
  const menus = loadMenus();
  const save = menus.get('saveHiddenApps');
  const load = menus.get('loadHiddenApps');
  save('HOST1', [{ id: '7', title: 'Desktop' }]);
  assert.deepEqual(plain(load('HOST1')), [{ id: '7', title: 'Desktop' }]);
  assert.deepEqual(plain(load('HOST2')), []);
  assert.equal(menus.context.localStorage.getItem('hiddenApps_HOST1'), '[{"id":"7","title":"Desktop"}]');
  // An empty list removes the key; a damaged value reads as no hidden app
  save('HOST1', []);
  assert.equal(menus.context.localStorage.getItem('hiddenApps_HOST1'), null);
  menus.context.localStorage.setItem('hiddenApps_HOST3', '{not json');
  assert.deepEqual(plain(load('HOST3')), []);
  menus.context.localStorage.setItem('hiddenApps_HOST3', '{"id":1}');
  assert.deepEqual(plain(load('HOST3')), []);
  // A deleted host forgets its hidden apps and its "Show hidden apps"
  save('HOST4', [{ id: '1', title: 'A' }]);
  menus.run('showHiddenAppsHost = "HOST4"');
  menus.get('forgetHiddenApps')('HOST4');
  assert.deepEqual(plain(load('HOST4')), []);
  assert.equal(menus.get('showHiddenAppsHost'), null);
});

test('the app grid leaves out hidden apps, except the running one, after "Show hidden apps" and when all are hidden', () => {
  const menus = loadMenus();
  const select = (apps, hidden, showHidden, currentGame) =>
    plain(menus.get('selectGridApps')(apps, hidden, showHidden, currentGame)).map((entry) => entry.app.id + (entry.hidden ? ' hidden' : ''));
  const apps = [{ id: 1, title: 'Desktop' }, { id: 2, title: 'Steam Big Picture' }, { id: 3, title: 'Game' }];
  const hidden = [{ id: '1', title: 'Desktop' }, { id: '3', title: 'Game' }];
  assert.deepEqual(select(apps, [], false, 0), ['1', '2', '3']);
  assert.deepEqual(select(apps, hidden, false, 0), ['2']);
  assert.deepEqual(select(apps, hidden, true, 0), ['1 hidden', '2', '3 hidden']);
  // The running app shows even when it is hidden, so that it can be resumed and quit
  assert.deepEqual(select(apps, hidden, false, 3), ['2', '3 hidden']);
  // Every app hidden: all of them show, so that an app menu can show them again
  assert.deepEqual(select(apps, hidden.concat([{ id: '2', title: 'x' }]), false, 0), ['1 hidden', '2 hidden', '3 hidden']);
  assert.deepEqual(select([], hidden, false, 0), []);
});

test('the app menu offers Resume and Quit for the running app, Start otherwise, and Show hidden apps when there are any', () => {
  const menus = loadMenus();
  const entries = (state) => plain(menus.get('getAppMenuEntries')(state));
  assert.deepEqual(entries({ running: false, hidden: false, hiddenCount: 0, showHidden: false }),
    ['appMenuStart', 'appMenuFavorite', 'appMenuHide', 'appMenuClose']);
  assert.deepEqual(entries({ running: true, hidden: false, hiddenCount: 0, showHidden: false }),
    ['appMenuResume', 'appMenuQuit', 'appMenuFavorite', 'appMenuHide', 'appMenuClose']);
  assert.deepEqual(entries({ running: false, hidden: false, hiddenCount: 2, showHidden: false }),
    ['appMenuStart', 'appMenuFavorite', 'appMenuHide', 'appMenuShowHidden', 'appMenuClose']);
  assert.deepEqual(entries({ running: true, hidden: true, hiddenCount: 1, showHidden: true }),
    ['appMenuResume', 'appMenuQuit', 'appMenuFavorite', 'appMenuUnhide', 'appMenuShowHidden', 'appMenuClose']);
  // A favorite offers to remove it
  assert.deepEqual(entries({ running: false, favorite: true, hidden: false, hiddenCount: 0, showHidden: false }),
    ['appMenuStart', 'appMenuUnfavorite', 'appMenuHide', 'appMenuClose']);
});
