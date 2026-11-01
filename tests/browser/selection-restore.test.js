'use strict';

// Checks that the grids come back on the item that was used last (showHosts() / selectLastOpenedHost() and showApps() in
// wasm/platform/index.js). These checks used to test window.Views, which never exists: Views is a const of
// navigation.js, and a top-level const is no property of window, so none of them ran. The host check also looked for
// the inner card element instead of the host container that the view lists.
// - Back from an app list, the host grid selects (and marks) the card of the host that was opened last.
// - Back from the settings, the button of the header keeps the mark, and the card of the host that was opened last is
//   only selected for the next DOWN: the grid used to mark it as well, so two items looked selected.
// - The app grid selects the running app, else the app that was started last on that host.
// - When the app list got shorter (e.g. a hidden app), the selection stays on a tile.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, openApp, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const TV = { tv: 's90c', conn: 'wifi' };

// Three simulated hosts in the grid, without polling
const installHosts = (page) => page.evaluate(() => {
  window.beginBackgroundPollingOfHost = function() {};
  window.endBackgroundPollingOfHost = function() {};
  window.startPollingHosts = function() {};
  const make = (uid, name) => ({
    serverUid: uid, hostname: name, online: true, paired: true, currentGame: 0, address: '10.0.0.' + uid.length,
    externalPort: 47989, httpPort: 47989, httpsPort: 47984, macAddress: '00:11:22:33:44:55', appVersion: '7.1.431.-1', gfeVersion: '',
    serverCodecModeSupport: 0x1F03, toString: () => name, updateExternalAddressIP4() {}, clearBoxArt() {},
    refreshServerInfo: () => Promise.resolve(), pollServer(callback) {
      callback(this);
    },
  });
  [make('A', 'GAMING-PC'), make('BB', 'HTPC'), make('CCC', 'OFFICE')].forEach((host) => {
    hosts[host.serverUid] = host;
    addHostToGrid(host);
  });
});

// The selected and the marked cards of the host grid
const hostSelection = (page) => page.evaluate(() => ({
  selected: Views.Hosts.view.current() ? Views.Hosts.view.current().id : null,
  marked: Array.prototype.map.call(document.querySelectorAll('#host-grid > .hovered'), (card) => card.id),
}));

test('back from an app list, the host grid selects and marks the host that was opened last', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await installHosts(app.page);
    await app.page.evaluate(() => {
      localStorage.setItem('lastOpenedHost', 'CCC');
      showHosts();
    });
    // showHosts() shows the grid right away
    await app.page.waitForFunction(() => $('#host-grid').is(':visible') && !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    await app.page.waitForTimeout(200);
    assert.deepEqual(await hostSelection(app.page), { selected: 'host-container-CCC', marked: ['host-container-CCC'] });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('without a stored host, or with one that is gone, the host selection stays where it was', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await installHosts(app.page);
    const result = await app.page.evaluate(() => {
      const before = Views.Hosts.view.index;
      localStorage.removeItem('lastOpenedHost');
      selectLastOpenedHost();
      const withoutStored = Views.Hosts.view.index;
      localStorage.setItem('lastOpenedHost', 'GONE');
      selectLastOpenedHost();
      return { before, withoutStored, withGone: Views.Hosts.view.index };
    });
    assert.equal(result.withoutStored, result.before);
    assert.equal(result.withGone, result.before);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// Press and release a key of the remote on the focused element, like the TV delivers it
const remoteKey = (page, keyCode, key) => page.evaluate(({ code, name }) => {
  ['keydown', 'keyup'].forEach((type) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  });
}, { code: keyCode, name: key });
const UP = [38, 'ArrowUp'];
const DOWN = [40, 'ArrowDown'];
const RIGHT = [39, 'ArrowRight'];
const OK = [13, 'Enter'];
const RETURN = [10009, 'XF86Back'];

const focusedId = (page) => page.evaluate(() => (document.activeElement ? document.activeElement.id : ''));
const markedIds = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.hovered'), (element) => element.id).filter(Boolean));

// The ways back from the settings to the hosts view, which all press the back button of the header (showHosts())
const WAYS_BACK = {
  'RETURN in the categories': async (page) => {
    await remoteKey(page, ...RETURN);
  },
  'UP to the header and OK on the back button': async (page) => {
    await remoteKey(page, ...UP);
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'goBackBtn', null, { timeout: 3000 });
    await remoteKey(page, ...OK);
  },
  'RETURN in a section, then RETURN in the categories': async (page) => {
    await remoteKey(page, ...OK);
    await page.waitForTimeout(400);
    await remoteKey(page, ...RETURN);
    await page.waitForTimeout(300);
    await remoteKey(page, ...RETURN);
  },
};

for (const [way, goBack] of Object.entries(WAYS_BACK)) {
  test(`back from the settings (${way}), only the settings button is marked, and DOWN goes to the PC opened last`, async () => {
    // A stored PC (mocks/sunshine-host.js) that an earlier session opened, which the grid lists after the Add PC card
    const app = await openApp(harness, { tv: TV, moduleScripts: ['sunshine-host.js'], stored: { hosts: SUNSHINE_HOSTS } });
    const { page } = app;
    try {
      await page.waitForFunction(() => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true, null, { timeout: 10000 });
      await page.evaluate(() => localStorage.setItem('lastOpenedHost', 'HOST1'));
      assert.equal(await page.evaluate(() => Views.Hosts.view.current().id), 'addHostContainer');
      // UP to the header (the first key may only give the menus the focus), RIGHT to the settings button, OK
      for (let i = 0; i < 3 && ['updateAppBtn', 'rescanNetworkBtn', 'settingsBtn', 'supportBtn'].indexOf(await focusedId(page)) < 0; i++) {
        await remoteKey(page, ...UP);
        await page.waitForTimeout(150);
      }
      for (let i = 0; i < 4 && await focusedId(page) !== 'settingsBtn'; i++) {
        await remoteKey(page, ...RIGHT);
      }
      assert.equal(await focusedId(page), 'settingsBtn');
      await remoteKey(page, ...OK);
      await page.waitForFunction(() => document.body.getAttribute('data-view') === 'settings' && $('#settings-list').is(':visible'), null, { timeout: 5000 });
      await page.waitForTimeout(300);

      await goBack(page);
      await page.waitForFunction(() => document.body.getAttribute('data-view') === 'hosts' && $('#host-grid').is(':visible'), null, { timeout: 5000 });
      await page.waitForTimeout(300);
      assert.deepEqual(await markedIds(page), ['settingsBtn']);
      assert.equal(await focusedId(page), 'settingsBtn');
      assert.equal(await page.evaluate(() => Views.Hosts.view.current().id), 'host-container-HOST1', 'the PC opened last is selected');

      await remoteKey(page, ...DOWN);
      assert.deepEqual(await markedIds(page), ['host-container-HOST1']);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });
}

// Open the app list of a simulated host (sorted A-Z: Cyberpunk 2077, Desktop, Forza Horizon 5, Steam Big Picture) whose
// running app is currentGame (0 for none)
async function openAppList(currentGame, prepare) {
  const app = await openApp(harness, { tv: TV });
  await app.page.evaluate(async (settings) => {
    window.__apps = [{ id: 11, title: 'Desktop' }, { id: 12, title: 'Steam Big Picture' }, { id: 13, title: 'Cyberpunk 2077' },
      { id: 14, title: 'Forza Horizon 5' }];
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989,
      currentGame: settings.currentGame, appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppList: () => Promise.resolve(window.__apps.slice()),
      getAppById: (id) => Promise.resolve(window.__apps.find((entry) => entry.id == id) || null),
      getBoxArt: () => Promise.resolve('static/res/placeholder_game.svg'),
      pollServer: (callback) => callback(host),
      toString: () => 'GAMING-PC',
    };
    if (settings.lastOpened) {
      localStorage.setItem('lastOpenedApp_HOST1', String(settings.lastOpened));
    }
    window.__host = host;
    api = host;
    await showApps(host);
  }, { currentGame, lastOpened: prepare && prepare.lastOpened });
  await app.page.waitForFunction(() => $('#game-grid .game-container').length > 0, null, { timeout: 5000 });
  return app;
}

const selectedApp = (page) => page.evaluate(() => {
  const tile = Views.Apps.view.current();
  return tile ? tile.getAttribute('aria-label') : null;
});

test('the app grid selects the running app', async () => {
  const app = await openAppList(14);
  try {
    assert.equal(await selectedApp(app.page), 'Forza Horizon 5');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('without a running app, the app grid selects the app that was started last on that host', async () => {
  const app = await openAppList(0, { lastOpened: 12 });
  try {
    assert.equal(await selectedApp(app.page), 'Steam Big Picture');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('when the app list got shorter, the selection stays on a tile', async () => {
  const app = await openAppList(0);
  try {
    const selected = await app.page.evaluate(async () => {
      Views.Apps.view.index = 3;
      window.__apps = window.__apps.slice(0, 2);
      await showApps(window.__host);
      return { index: Views.Apps.view.index, count: Views.Apps.view.func().length };
    });
    assert.deepEqual(selected, { index: 1, count: 2 });
    assert.ok(await selectedApp(app.page), 'a tile is selected');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
