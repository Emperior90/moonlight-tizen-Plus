'use strict';

// Helpers for the browser tests that drive the menus the way a user does: with the keys of the remote, and with a
// simulated gamepad whose slots the real polling of gamepad.js reads (every 16 ms), so that a press goes the whole way
// from navigator.getGamepads() to the moved selection. The page of a busy machine can stand still for longer than a
// button is held, so a press on purpose (padButton()) is held until the menus read it, and a timed sequence (timed(),
// doublePadButton()) changes the gamepad at its times whether the page runs or not, as a real controller does.
//   const app = await openMenus(harness, { stored: { hosts: THREE_HOSTS }, moduleScripts: ['sunshine-host.js'] });
//   await key(app.page, 'down');            // a key of the remote
//   await padButton(app.page, PAD.A);       // a button of the gamepad, held for 60 ms
//   await doubleKey(app.page, 'ok');        // a double press, timed in the page (also doublePadButton() and timed())
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

// Runs before the scripts of the app: the simulated gamepads that navigator.getGamepads() returns. Gamepad 0 follows
// its schedule (window.__padSchedule: { at, button, pressed } or { at, axis, value }, in the order of their times `at`
// of performance.now()): a read of the gamepads first takes the steps that are due, so it sees what a real controller
// would report at that moment, also when the page was busy and reads late. window.__padInputs counts the times the
// menus got input of a gamepad (the 'gamepadinputchanged' events of gamepad.js).
function installGamepads() {
  window.__pads = [null, null, null, null];
  window.__padSchedule = [];
  window.__padInputs = 0;
  window.addEventListener('gamepadinputchanged', () => {
    window.__padInputs++;
  });
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => {
      const now = performance.now();
      while (window.__padSchedule.length > 0 && window.__padSchedule[0].at <= now) {
        const step = window.__padSchedule.shift();
        if (step.axis !== undefined) {
          window.__padAxis(step.axis, step.value);
        } else {
          window.__padButton(step.button, step.pressed);
        }
      }
      return window.__pads.slice();
    },
  });
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

// The key codes of the keys of the remote, for key events made in the page
const KEY_CODES = {
  up: [38, 'ArrowUp'], down: [40, 'ArrowDown'], left: [37, 'ArrowLeft'], right: [39, 'ArrowRight'], ok: [13, 'Enter'],
  back: TV_KEYS.back, chup: TV_KEYS.chup, chdown: TV_KEYS.chdown, playpause: TV_KEYS.playpause, red: TV_KEYS.red,
};

// Run steps at their times (`at`, in ms from now) in the page, so that the time between two of them doesn't depend on
// how long a call into the browser takes, e.g. the two presses of a double press. A step is a key of the remote
// ({ at, key: 'ok' }, pressed and released), a button of the simulated gamepad ({ at, button: PAD.A, pressed: true }) or
// a stick axis of it ({ at, axis: 1, value: 0.9 }). The steps of the gamepad go to its schedule, which doesn't wait for
// the page (see installGamepads()): a page that stands still for a moment reads the gamepad as it is by then, and
// never a second press that came later than the sequence says. Then wait for the UI to settle (300 ms unless given).
async function timed(page, steps, settleMs) {
  const list = steps.map((step) => (step.key ? { at: step.at, code: KEY_CODES[step.key][0], keyName: KEY_CODES[step.key][1] } : step));
  await page.evaluate((timedSteps) => new Promise((resolve) => {
    const start = performance.now();
    const end = start + Math.max.apply(null, timedSteps.map((step) => step.at));
    timedSteps.filter((step) => !step.keyName).forEach((step) => window.__padSchedule.push(Object.assign({}, step, { at: start + step.at })));
    const keySteps = timedSteps.filter((step) => step.keyName);
    let index = 0;
    const next = () => {
      const wait = (index === keySteps.length ? end : start + keySteps[index].at) - performance.now();
      if (wait > 0.5) {
        setTimeout(next, wait);
        return;
      }
      if (index === keySteps.length) {
        resolve();
        return;
      }
      const step = keySteps[index];
      ['keydown', 'keyup'].forEach((type) => {
        const event = new KeyboardEvent(type, { key: step.keyName, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { value: step.code });
        Object.defineProperty(event, 'which', { value: step.code });
        (document.activeElement || document.body).dispatchEvent(event);
      });
      index++;
      next();
    };
    next();
  }), list);
  await page.waitForTimeout(settleMs === undefined ? 300 : settleMs);
}

// Two presses of a key of the remote, gapMs apart (120 ms unless given): a double press
function doubleKey(page, name, settleMs, gapMs) {
  return timed(page, [{ at: 0, key: name }, { at: gapMs === undefined ? 120 : gapMs, key: name }], settleMs);
}

// Two presses of a button of the simulated gamepad, each held for 35 ms (two reads of the gamepads), 70 ms from press
// to press: a double press, well within the 150 ms in which the menus take a second press of A, B, Select or Start for
// the same press, also on a busy machine, whose page then reads less of it, not a later second press
function doublePadButton(page, button, settleMs) {
  return timed(page, [{ at: 0, button, pressed: true }, { at: 35, button, pressed: false }, { at: 70, button, pressed: true },
    { at: 105, button, pressed: false }], settleMs === undefined ? 350 : settleMs);
}

// Press several keys of the remote, one after the other
async function keys(page, names, settleMs) {
  for (const name of names) {
    await key(page, name, settleMs);
  }
}

// Press a button of the simulated gamepad on purpose: for holdMs (60 ms unless given), and longer if the menus haven't
// read the press by then (the page of a busy machine; given up after a second, e.g. during a stream, where the menus
// don't read the gamepads). Then wait for the UI to settle.
async function padButton(page, button, settleMs, holdMs) {
  await page.evaluate(({ b, hold }) => new Promise((resolve) => {
    const inputs = window.__padInputs;
    const pressedAt = performance.now();
    window.__padButton(b, true);
    const release = () => {
      const held = performance.now() - pressedAt;
      if (held < hold || (window.__padInputs === inputs && held < 1000)) {
        setTimeout(release, Math.max(4, hold - held));
        return;
      }
      window.__padButton(b, false);
      resolve();
    };
    release();
  }), { b: button, hold: holdMs === undefined ? 60 : holdMs });
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

// To a section of the settings (the data-category of its tile, e.g. 'basicSettings'), with the keys. From the PC list:
// UP to the header (over the menu icon of a PC, if a PC is selected), Settings, OK. From another section: RETURN to the
// list of the sections. Then the tile and OK.
async function openSettingsSection(page, category) {
  let view = (await menuState(page)).view;
  if (view === 'Hosts' || view === 'HostsMenuHighlight' || view === 'HostsNav') {
    for (let step = 0; step < 2 && view !== 'HostsNav'; step++) {
      await key(page, 'up');
      view = (await menuState(page)).view;
    }
    await selectItem(page, 'HostsNav', 'settingsBtn', 'left', 'right');
    await key(page, 'ok', 500);
  } else if (view !== 'Settings') {
    await key(page, 'back', 400);
  }
  if ((await menuState(page)).view !== 'Settings') {
    throw new Error('The list of the settings sections did not open, the keys are in the view ' + (await menuState(page)).view);
  }
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

// The options of the drop-down that is open, in their order: the value, whether it is highlighted and whether it can be
// chosen, and where it is on the screen. An empty list when no drop-down shows.
function dropdownOptions(page) {
  return page.evaluate(() => {
    const container = document.querySelector('.mdl-menu__container.is-visible');
    return !container ? [] : Array.prototype.map.call(container.querySelectorAll('li'), (option) => {
      const box = option.getBoundingClientRect();
      return {
        value: option.getAttribute('data-value'), marked: option.classList.contains('hovered'), disabled: option.hasAttribute('disabled'),
        top: Math.round(box.top), bottom: Math.round(box.bottom),
      };
    });
  });
}

// The value of a row of the settings with a drop-down, as its button holds it (e.g. '3840:2160' of 'selectResolution')
function rowValue(page, rowId) {
  return page.evaluate((id) => document.getElementById(id).getAttribute('data-value'), rowId);
}

module.exports = {
  PAD, THREE_HOSTS, doubleKey, doublePadButton, dropdownOptions, key, keys, menuState, openMenus, openSettingsSection, padButton, rowValue,
  selectItem, takeSnackbars, timed,
};
