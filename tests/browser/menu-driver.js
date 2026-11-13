'use strict';

// Helpers for the browser tests that drive the menus the way a user does: with the keys of the remote, and with a
// simulated gamepad whose slots the real polling of gamepad.js reads (every 16 ms), so that a press goes the whole way
// from navigator.getGamepads() to the moved selection.
//   const app = await openMenus(harness, { stored: { hosts: THREE_HOSTS }, moduleScripts: ['sunshine-host.js'] });
//   await key(app.page, 'down');            // a key of the remote
//   await padButton(app.page, PAD.A);       // a button of the gamepad, held for 60 ms
//   (await menuState(app.page)).view        // the name of the view that has the keys, e.g. 'BasicSettings'

const { SUNSHINE_HOSTS, openApp } = require('./harness');

// The keys of the remote: the arrows and OK as real key presses of the browser, the keys that only a TV has as key
// events with the key codes of the TV (res/platform.js)
const BROWSER_KEYS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter' };
const TV_KEYS = {
  back: [10009, 'XF86Back'], chup: [427, 'ChannelUp'], chdown: [428, 'ChannelDown'], playpause: [10252, 'MediaPlayPause'],
  red: [403, 'ColorF0Red'],
};

// The buttons of a gamepad with the standard layout
const PAD = { A: 0, B: 1, SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

// The PC of mocks/sunshine-host.js (HOST1, 10.0.0.2, online and paired) with two more that it doesn't answer for, so
// they show as offline: OFFICE-PC (HOST2, paired) and LIVING-ROOM (HOST3, not paired)
const THREE_HOSTS = {
  HOST1: SUNSHINE_HOSTS.HOST1,
  HOST2: Object.assign({}, SUNSHINE_HOSTS.HOST1, {
    address: '10.0.0.3', userEnteredAddress: '10.0.0.3', hostname: 'OFFICE-PC', serverUid: 'HOST2', macAddress: '00:11:22:33:44:66',
    online: false, _baseUrlHttps: 'https://10.0.0.3:47984', _baseUrlHttp: 'http://10.0.0.3:47989',
  }),
  HOST3: Object.assign({}, SUNSHINE_HOSTS.HOST1, {
    address: '10.0.0.4', userEnteredAddress: '10.0.0.4', hostname: 'LIVING-ROOM', serverUid: 'HOST3', macAddress: '00:11:22:33:44:77',
    paired: false, ppkstr: null, online: false, _baseUrlHttps: 'https://10.0.0.4:47984', _baseUrlHttp: 'http://10.0.0.4:47989',
  }),
};

// Runs before the scripts of the app: the simulated gamepads that navigator.getGamepads() returns
function installGamepads() {
  window.__pads = [null, null, null, null];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__pads.slice() });
  window.__connectPad = (index) => {
    const pad = {
      index, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', mapping: 'standard', connected: true,
      timestamp: 1, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0],
    };
    window.__pads[index] = pad;
    const event = new Event('gamepadconnected');
    Object.defineProperty(event, 'gamepad', { value: pad });
    window.dispatchEvent(event);
  };
  window.__padButton = (button, pressed) => {
    window.__pads[0].buttons[button] = { pressed, value: pressed ? 1 : 0 };
    window.__pads[0].timestamp++;
  };
  window.__padAxis = (axis, value) => {
    window.__pads[0].axes[axis] = value;
    window.__pads[0].timestamp++;
  };
}

// Runs once the app started: the name of the view that has the keys (every push, change and pop of Navigation enters
// the view on top), the snackbar messages as they are queued, and the console errors of the app
function watchMenus() {
  window.__view = 'Hosts';
  Object.keys(Views).forEach((name) => {
    const view = Views[name];
    const enter = view.enter;
    view.enter = function() {
      window.__view = name;
      return enter.apply(this, arguments);
    };
  });
  window.__snackbars = [];
  const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
  const show = snackbar.showSnackbar.bind(snackbar);
  // A message that waits behind another one comes through showSnackbar() a second time, when the snackbar takes it from
  // its queue, with the same object: it counts once, as the user sees it once
  const counted = new WeakSet();
  snackbar.showSnackbar = (data) => {
    if (!counted.has(data)) {
      counted.add(data);
      window.__snackbars.push(data.message);
    }
    show(data);
  };
}

// Open the app like openApp() of the harness, with the simulated gamepads (connected with `pad: true`) and the view
// and snackbar records. `app.consoleErrors` collects the console.error lines of the app.
async function openMenus(harness, options) {
  const opts = Object.assign({ tv: { tv: 's90c', conn: 'wifi' } }, options || {});
  opts.initScripts = [installGamepads].concat(opts.initScripts || []);
  const app = await openApp(harness, opts);
  app.consoleErrors = [];
  app.page.on('console', (message) => {
    if (message.type() === 'error' && message.text().indexOf('Failed to load resource') < 0) {
      app.consoleErrors.push(message.text());
    }
  });
  await app.page.evaluate(watchMenus);
  if (opts.pad) {
    await app.page.evaluate(() => window.__connectPad(0));
    await app.page.waitForTimeout(100);
  }
  return app;
}

// Press a key of the remote and wait for the UI to settle (300 ms unless given)
async function key(page, name, settleMs) {
  if (BROWSER_KEYS[name]) {
    await page.keyboard.press(BROWSER_KEYS[name]);
  } else if (TV_KEYS[name]) {
    await page.evaluate(({ code, keyName }) => {
      ['keydown', 'keyup'].forEach((type) => {
        const event = new KeyboardEvent(type, { key: keyName, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { value: code });
        Object.defineProperty(event, 'which', { value: code });
        (document.activeElement || document.body).dispatchEvent(event);
      });
    }, { code: TV_KEYS[name][0], keyName: TV_KEYS[name][1] });
  } else {
    throw new Error('Unknown key of the remote: ' + name);
  }
  await page.waitForTimeout(settleMs === undefined ? 300 : settleMs);
}

// Press several keys of the remote, one after the other
async function keys(page, names, settleMs) {
  for (const name of names) {
    await key(page, name, settleMs);
  }
}

// Press a button of the simulated gamepad for holdMs (60 ms unless given) and wait for the UI to settle
async function padButton(page, button, settleMs, holdMs) {
  await page.evaluate((b) => window.__padButton(b, true), button);
  await page.waitForTimeout(holdMs === undefined ? 60 : holdMs);
  await page.evaluate((b) => window.__padButton(b, false), button);
  await page.waitForTimeout(settleMs === undefined ? 350 : settleMs);
}

// What the menus show: the view that has the keys, the item it selects, the items that look selected (the mark of the
// navigation), the focused element, and the dialogs and drop-downs that are open
function menuState(page) {
  return page.evaluate(() => {
    const isShown = (element) => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const nameOf = (item) => {
      const element = typeof item === 'string' ? document.getElementById(item) : item;
      if (!element) {
        return typeof item === 'string' ? item : '';
      }
      return element.id || (element.getAttribute && element.getAttribute('data-value')) || element.tagName.toLowerCase();
    };
    const view = Views[window.__view];
    return {
      view: window.__view,
      current: nameOf(view.view.current()),
      marked: Array.prototype.filter.call(document.querySelectorAll('.hovered'), isShown).map(nameOf),
      focused: document.activeElement && document.activeElement !== document.body ? nameOf(document.activeElement) : '',
      dialogs: Array.prototype.filter.call(document.querySelectorAll('.dialog-overlay, .overlay-menu-backdrop'), isShown).map((element) => element.id),
      openDialogs: Array.prototype.map.call(document.querySelectorAll('dialog[open]'), (element) => element.id),
      dropdowns: Array.prototype.map.call(document.querySelectorAll('.mdl-menu__container.is-visible'), (container) => container.querySelector('.mdl-menu').className.split(' ')[0]),
    };
  });
}

// Take the snackbar messages that were queued since the last call
function takeSnackbars(page) {
  return page.evaluate(() => window.__snackbars.splice(0));
}

// Move the selection of a list view to the item with the given id (or data-value), with the keys for the previous and
// the next item, e.g. selectItem(page, 'BasicSettings', 'selectFramerate', 'up', 'down')
async function selectItem(page, viewName, itemId, previousKey, nextKey) {
  for (let step = 0; step < 40; step++) {
    const position = await page.evaluate(({ name, id }) => {
      const view = Views[name].view;
      const ids = Array.prototype.map.call(view.func(), (item) => (typeof item === 'string' ? item : (item.id || item.getAttribute('data-value'))));
      return { index: view.index, target: ids.indexOf(id), ids };
    }, { name: viewName, id: itemId });
    if (position.target < 0) {
      throw new Error('The view ' + viewName + ' has no item ' + itemId + ': ' + position.ids.join(', '));
    }
    if (position.index === position.target) {
      return;
    }
    await key(page, position.index < position.target ? nextKey : previousKey, 150);
  }
  throw new Error('Could not select ' + itemId + ' in the view ' + viewName);
}

// From the PC list to a section of the settings (the data-category of its tile, e.g. 'basicSettings'), with the keys:
// UP to the header (over the menu icon of a PC, if a PC is selected), Settings, OK, the tile, OK
async function openSettingsSection(page, category) {
  await key(page, 'up');
  if ((await menuState(page)).view === 'HostsMenuHighlight') {
    await key(page, 'up');
  }
  await selectItem(page, 'HostsNav', 'settingsBtn', 'left', 'right');
  await key(page, 'ok', 500);
  const index = await page.evaluate((name) => Array.prototype.findIndex.call(Views.Settings.view.func(), (tile) => tile.getAttribute('data-category') === name), category);
  for (let step = 0; step < 10; step++) {
    const current = await page.evaluate(() => Views.Settings.view.index);
    if (current === index) {
      break;
    }
    await key(page, current < index ? 'down' : 'up', 150);
  }
  // The section takes the keys 250 ms after OK (navigateSettingsView() in index.js)
  await key(page, 'ok', 600);
}

module.exports = { PAD, THREE_HOSTS, key, keys, menuState, openMenus, openSettingsSection, padButton, selectItem, takeSnackbars };
