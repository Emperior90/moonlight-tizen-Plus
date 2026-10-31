'use strict';

// Checks the favorites and the order of the app list in the real page (wasm/platform/menus.js, showApps() and the
// setting 'Sort the list of apps' in index.js, Views.AppMenu and Views.SelectSortAppsListMenu in navigation.js):
// - 'Add to favorites' in the app menu (with the remote or a gamepad) puts the app first in the grid with a star badge
//   and a Favorite chip in the hero, stored per host and matched by title, so the old ID of a favorite never marks, orders
//   or removes another app; 'Remove from favorites' takes it back; the Smart Hub tiles show the favorites first as well;
// - the setting offers A to Z (the default), Z to A, Recently played and As on the PC, reached with the remote and a
//   gamepad, stored, named in the language of the app; each orders the grid, after the favorites; Recently played
//   follows the starts of streams that the host accepted (not a refused or failed launch, nor the Terminate tile of
//   Apollo), and the true of the switch of earlier versions is Z to A.
// The host and its apps are simulated; tests/unit/app-library.test.js pins the order itself.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness, waitForStorage } = require('./harness');

// delayedNavigation() runs the gamepad buttons of the menus 50 ms later (BUTTON_NAVIGATION_DELAY) and a stick move 150 ms
// later (NAVIGATION_DELAY)
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

// Open the app list of a simulated host whose app 13 runs. The host lists Desktop, Steam Big Picture, Cyberpunk 2077 and
// Forza Horizon 5 in this order; A to Z they are Cyberpunk 2077, Desktop, Forza Horizon 5 and Steam Big Picture.
async function openAppList(options) {
  const opts = options || {};
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: opts.stored, locale: opts.locale });
  await app.page.evaluate(async (settings) => {
    Object.keys(settings.storage || {}).forEach((key) => localStorage.setItem(key, JSON.stringify(settings.storage[key])));
    window.__apps = [{ id: 11, title: 'Desktop' }, { id: 12, title: 'Steam Big Picture' }, { id: 13, title: 'Cyberpunk 2077' },
      { id: 14, title: 'Forza Horizon 5' }];
    window.__starts = [];
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989,
      currentGame: 13, appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppList: () => Promise.resolve(window.__apps.slice()),
      getAppById: (id) => Promise.resolve(window.__apps.find((entry) => entry.id == id) || null),
      getBoxArt: () => Promise.resolve('static/res/placeholder_game.svg'),
      pollServer: (callback) => callback(host),
      toString: () => 'GAMING-PC',
    };
    window.__host = host;
    api = host;
    // The Smart Hub tiles that the app sends to its service
    window.__smartHubSent = [];
    _isSmartHubSupported = true;
    tizen.messageport = { requestLocalMessagePort: () => ({ addMessagePortListener: () => 1, removeMessagePortListener: () => {} }) };
    tizen.ApplicationControlData = function(key, value) {
      this.key = key;
      this.value = value;
    };
    tizen.ApplicationControl = function(operation, uri, mime, category, data) {
      this.data = data;
    };
    tizen.application.launchAppControl = (control) => window.__smartHubSent.push(JSON.parse(control.data[0].value[0]));
    window.__realStartGame = startGame;
    startGame = (startHost, appId) => window.__starts.push(startHost.serverUid + ' ' + appId);
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    window.__snackbarMessages = [];
    snackbar.showSnackbar = (data) => window.__snackbarMessages.push(data.message);
    await showApps(host);
    Navigation.switch();
    Navigation.change(Views.Apps);
  }, opts);
  await waitForGrid(app.page);
  return app;
}

// Wait until the app grid shows (also after it was built again)
const waitForGrid = (page) => page.waitForFunction(() => $('#game-grid').is(':visible') && !$('#wasmSpinner').is(':visible') &&
  $('#game-grid .game-container').length > 0, null, { timeout: 5000 });

// Build the grid again, as after a change of a setting, and wait for it
async function rebuildGrid(page) {
  await page.evaluate(async () => {
    await showApps(window.__host);
    Navigation.switch();
    Navigation.change(Views.Apps);
  });
  await waitForGrid(page);
}

// What the grid shows: each tile as its title, with a star for a favorite and its labelled badges
const grid = (page) => page.evaluate(() => $('#game-grid .game-container').map(function() {
  const badges = $(this).find('.app-badge:not(.app-badge-favorite)').map(function() {
    return $(this).text();
  }).get();
  return ($(this).find('.app-badge-favorite').length ? '★ ' : '') + $(this).attr('aria-label') + (badges.length ? ' [' + badges.join(', ') + ']' : '');
}).get());

// The selected tile, and the entries of the app menu
const selectedApp = (page) => page.evaluate(() => {
  const tile = Views.Apps.view.current();
  return tile ? tile.getAttribute('aria-label') : null;
});
const appMenu = (page) => page.evaluate(() => ({
  open: $('#appMenuOverlay').css('display') !== 'none',
  entries: getOverlayMenuItems('appMenu').map((item) => item.id),
  focused: document.activeElement ? document.activeElement.id : '',
}));

// A key of the remote, through the key handler of the page
const remote = (page, keyName) => page.evaluate((name) => remoteControllerHandler({ keyCode: tvKey[name], key: name, repeat: false, preventDefault() {} }), keyName);

// A button of a gamepad, through the gamepad handler of the menus
const gamepadButton = async (page, index) => {
  await page.evaluate((button) => {
    const send = (pressed) => window.dispatchEvent(new CustomEvent('gamepadinputchanged', { detail: { gamepad: 0, changes: [{ type: 'button', index: button, pressed }] } }));
    send(true);
    send(false);
  }, index);
  await page.waitForTimeout(AFTER_DELAY_MS);
};

// The Smart Hub tiles that the app sends to its service now, by section
const smartHubTiles = (page) => page.evaluate(() => {
  window.__smartHubSent = [];
  updatePreviewData();
  return window.__smartHubSent.map((data) => data.sections.map((section) => section.tiles.map((tile) => tile.title)));
});

test('Add to favorites puts the app first with a star and a chip, stored per host; Remove from favorites takes it back', async () => {
  const app = await openAppList();
  const { page } = app;
  try {
    assert.deepEqual(await grid(page), ['Cyberpunk 2077 [Running]', 'Desktop', 'Forza Horizon 5', 'Steam Big Picture']);
    // Forza: RIGHT twice, CH+, DOWN to Add to favorites, OK
    await remote(page, 'KEY_RIGHT');
    await remote(page, 'KEY_RIGHT');
    await remote(page, 'KEY_CHANNEL_UP');
    assert.deepEqual(await appMenu(page), { open: true, focused: 'appMenuStart',
      entries: ['appMenuStart', 'appMenuFavorite', 'appMenuHide', 'appMenuClose'] });
    assert.equal(await page.evaluate(() => $('#appMenuFavorite .overlay-menu-label').text()), 'Add to favorites');
    await remote(page, 'KEY_DOWN');
    await remote(page, 'KEY_ENTER');
    await page.waitForTimeout(100);
    await waitForGrid(page);
    assert.deepEqual(await grid(page), ['★ Forza Horizon 5', 'Cyberpunk 2077 [Running]', 'Desktop', 'Steam Big Picture']);
    assert.equal(await selectedApp(page), 'Forza Horizon 5', 'the tile stays selected in its new place');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('favoriteApps_HOST1'))), [{ id: '14', title: 'Forza Horizon 5' }]);
    assert.deepEqual(await page.evaluate(() => loadFavoriteApps('HOST2')), [], 'another host keeps its own');
    assert.ok((await page.evaluate(() => window.__snackbarMessages.slice())).includes('Forza Horizon 5 is a favorite now.'));
    // The star sits in the top right corner of the tile (in layout pixels, which the scale of the focused tile leaves
    // as they are), the hero names the favorite
    const star = await page.evaluate(() => {
      const tile = document.getElementById('game-container-14');
      const badge = tile.querySelector('.app-badge-favorite');
      return { parent: badge.offsetParent === tile, right: tile.clientWidth - badge.offsetLeft - badge.offsetWidth, top: badge.offsetTop,
        width: badge.offsetWidth };
    });
    assert.deepEqual(star, { parent: true, right: 16, top: 16, width: 38 });
    await page.waitForFunction(() => /Favorite/i.test($('#launcher-hero .hero-chips').text()), null, { timeout: 3000 });

    // Steam with a gamepad: D-pad to it, Select, D-pad down, A; the favorites in the order of the setting
    for (let i = 0; i < 3; i++) {
      await gamepadButton(page, 15);
    }
    assert.equal(await selectedApp(page), 'Steam Big Picture');
    await gamepadButton(page, 8);
    await gamepadButton(page, 13);
    assert.equal((await appMenu(page)).focused, 'appMenuFavorite');
    await gamepadButton(page, 0);
    await page.waitForTimeout(100);
    await waitForGrid(page);
    assert.deepEqual(await grid(page), ['★ Forza Horizon 5', '★ Steam Big Picture', 'Cyberpunk 2077 [Running]', 'Desktop']);
    // The Smart Hub tiles show the favorites first as well
    assert.deepEqual(await smartHubTiles(page), [[['Forza Horizon 5', 'Steam Big Picture', 'Cyberpunk 2077', 'Desktop']]]);

    // The menu of a favorite offers to remove it, which puts it back in its place
    await page.evaluate(() => {
      Views.Apps.view.index = 0;
      Navigation.switch();
    });
    await remote(page, 'KEY_CHANNEL_UP');
    assert.deepEqual((await appMenu(page)).entries, ['appMenuStart', 'appMenuUnfavorite', 'appMenuHide', 'appMenuClose']);
    assert.equal(await page.evaluate(() => $('#appMenuUnfavorite .overlay-menu-label').text()), 'Remove from favorites');
    await remote(page, 'KEY_DOWN');
    await remote(page, 'KEY_ENTER');
    await page.waitForTimeout(100);
    await waitForGrid(page);
    assert.deepEqual(await grid(page), ['★ Steam Big Picture', 'Cyberpunk 2077 [Running]', 'Desktop', 'Forza Horizon 5']);
    assert.equal(await selectedApp(page), 'Forza Horizon 5');
    assert.ok((await page.evaluate(() => window.__snackbarMessages.slice())).includes('Forza Horizon 5 is no longer a favorite.'));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('favoriteApps_HOST1'))), [{ id: '12', title: 'Steam Big Picture' }]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a favorite is matched by its title after its ID changed, and a hidden favorite stays hidden', async () => {
  const app = await openAppList({ storage: {
    favoriteApps_HOST1: [{ id: '99', title: 'Steam Big Picture' }, { id: '11', title: 'Desktop' }],
    hiddenApps_HOST1: [{ id: '11', title: 'Desktop' }],
  } });
  try {
    assert.deepEqual(await grid(app.page), ['★ Steam Big Picture', 'Cyberpunk 2077 [Running]', 'Forza Horizon 5']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a host that numbered its apps anew: the old ID of a favorite never marks, orders or removes another app', async () => {
  // Cyberpunk 2077 was app 12 when it became a favorite; now 12 is Steam Big Picture
  const app = await openAppList({ storage: { favoriteApps_HOST1: [{ id: '12', title: 'Cyberpunk 2077' }] } });
  const { page } = app;
  try {
    assert.deepEqual(await grid(page), ['★ Cyberpunk 2077 [Running]', 'Desktop', 'Forza Horizon 5', 'Steam Big Picture']);
    // The menu of Steam offers to add it, and adding it keeps Cyberpunk
    await page.evaluate(() => {
      Views.Apps.view.index = 3;
      Navigation.switch();
    });
    await remote(page, 'KEY_CHANNEL_UP');
    assert.deepEqual((await appMenu(page)).entries, ['appMenuStart', 'appMenuFavorite', 'appMenuHide', 'appMenuClose']);
    await remote(page, 'KEY_DOWN');
    await remote(page, 'KEY_ENTER');
    await page.waitForTimeout(100);
    await waitForGrid(page);
    assert.deepEqual(await grid(page), ['★ Cyberpunk 2077 [Running]', '★ Steam Big Picture', 'Desktop', 'Forza Horizon 5']);
    // Removing Steam removes only Steam
    await page.evaluate(() => {
      Views.Apps.view.index = 1;
      Navigation.switch();
    });
    await remote(page, 'KEY_CHANNEL_UP');
    assert.deepEqual((await appMenu(page)).entries, ['appMenuStart', 'appMenuUnfavorite', 'appMenuHide', 'appMenuClose']);
    await remote(page, 'KEY_DOWN');
    await remote(page, 'KEY_ENTER');
    await page.waitForTimeout(100);
    await waitForGrid(page);
    assert.deepEqual(await grid(page), ['★ Cyberpunk 2077 [Running]', 'Desktop', 'Forza Horizon 5', 'Steam Big Picture']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('favoriteApps_HOST1'))), [{ id: '12', title: 'Cyberpunk 2077' }]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// What the setting shows
const sortSetting = (page) => page.evaluate(() => ({
  value: $('#selectSortAppsList').attr('data-value'),
  label: $('#selectSortAppsList').text().trim(),
}));

test('the setting offers A to Z, Z to A, Recently played and As on the PC, with the remote and a gamepad, and orders the grid', async () => {
  const app = await openAppList({ storage: { favoriteApps_HOST1: [{ id: '13', title: 'Cyberpunk 2077' }] } });
  const { page } = app;
  try {
    assert.deepEqual(await sortSetting(page), { value: 'az', label: 'A to Z' });
    assert.deepEqual(await page.evaluate(() => $('.sortAppsListMenu li').map((i, li) => li.getAttribute('data-value') + ' ' + li.textContent.trim()).get()),
      ['az A to Z', 'za Z to A', 'recent Recently played', 'host As on the PC']);
    assert.deepEqual(await grid(page), ['★ Cyberpunk 2077 [Running]', 'Desktop', 'Forza Horizon 5', 'Steam Big Picture']);
    // The Running badge of a favorite ends before its star, also with a long label
    const gap = await page.evaluate(() => {
      const tile = document.getElementById('game-container-13');
      const running = tile.querySelector('.app-badge-running');
      running.textContent = 'A label much longer than any translation of Running';
      const star = tile.querySelector('.app-badge-favorite');
      return star.offsetLeft - (running.offsetLeft + running.offsetWidth);
    });
    assert.ok(gap >= 16, 'gap ' + gap);

    // Settings, DOWN to General (the fifth section), OK, DOWN: the setting is the second row, below the language; OK opens
    // its menu, DOWN to Z to A, OK
    await page.evaluate(() => {
      showHostsMode();
      $('#settingsBtn').trigger('click');
    });
    await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await page.waitForTimeout(100);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Views.InterfaceSettings.view.current() === 'selectLanguage', null, { timeout: 3000 });
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => Views.InterfaceSettings.view.current() === 'selectSortAppsList', null, { timeout: 3000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => isPopupMenuActive('sortAppsListMenu'));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitForStorage(page, (values) => values.sortAppsList === 'za');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'selectSortAppsList', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => isPopupMenuActive('sortAppsListMenu')), false);
    assert.deepEqual(await sortSetting(page), { value: 'za', label: 'Z to A' });
    await rebuildGrid(page);
    assert.deepEqual(await grid(page), ['★ Cyberpunk 2077 [Running]', 'Steam Big Picture', 'Forza Horizon 5', 'Desktop']);

    // With a gamepad: A opens the menu, the D-pad goes down twice to As on the PC, A chooses it
    await page.evaluate(() => {
      showHostsMode();
      $('#settingsBtn').trigger('click');
    });
    await page.waitForFunction(() => $('#settings-list').is(':visible'));
    await page.evaluate(() => {
      Navigation.change(Views.InterfaceSettings);
      Views.InterfaceSettings.view.index = 1;
      focusElement('selectSortAppsList');
    });
    await gamepadButton(page, 0);
    await page.waitForFunction(() => isPopupMenuActive('sortAppsListMenu'));
    for (let i = 0; i < 2; i++) {
      await gamepadButton(page, 13);
    }
    await gamepadButton(page, 0);
    await waitForStorage(page, (values) => values.sortAppsList === 'host');
    assert.deepEqual(await sortSetting(page), { value: 'host', label: 'As on the PC' });
    await rebuildGrid(page);
    assert.deepEqual(await grid(page), ['★ Cyberpunk 2077 [Running]', 'Desktop', 'Steam Big Picture', 'Forza Horizon 5']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Recently played follows the starts of streams, kept per host; the switch of earlier versions reads as Z to A', async () => {
  const app = await openAppList({ stored: { sortAppsList: 'recent' } });
  const { page } = app;
  try {
    assert.deepEqual(await sortSetting(page), { value: 'recent', label: 'Recently played' });
    // Nothing played yet: A to Z
    assert.deepEqual(await grid(page), ['Cyberpunk 2077 [Running]', 'Desktop', 'Forza Horizon 5', 'Steam Big Picture']);
    // Streams of Steam and then Forza start and end (the real startGame(), whose launch the host accepts); a launch
    // of Desktop that the host refuses, one that fails, and the Terminate tile of Apollo, even when the host accepted
    // it, start no stream and leave the list as it is
    const recentAfter = await page.evaluate(async () => {
      startGame = window.__realStartGame;
      const host = window.__host;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
      host.currentGame = 0;
      host.launchApp = () => Promise.resolve(ok);
      const streams = [];
      for (const appId of [12, 14]) {
        startGame(host, appId);
        await wait(600);
        streams.push(window.__wasmCalls.filter((call) => call.name === 'startStream').length);
        handleMessage('streamTerminated: 0');
        await wait(800);
      }
      const recent = () => JSON.parse(localStorage.getItem('recentApps_HOST1'));
      const afterStreams = recent();
      host.launchApp = () => Promise.resolve('<root status_code="503" status_message="Service Unavailable"/>');
      startGame(host, 11);
      await wait(800);
      host.launchApp = () => Promise.reject(new Error('timeout'));
      startGame(host, 11);
      await wait(800);
      window.__apps.push({ id: 22, title: 'Terminate', uuid: 'E16CBE1B-295D-4632-9A76-EC4180C857D3' });
      host.launchApp = () => Promise.resolve(ok);
      startGame(host, 22);
      await wait(600);
      handleMessage('streamTerminated: 0');
      await wait(200);
      window.__apps.pop();
      return { streams, afterStreams, afterOthers: recent(), terminateStreamed: window.__wasmCalls.filter((call) => call.name === 'startStream').length };
    });
    assert.deepEqual(recentAfter.streams, [1, 2], 'each stream reached the module');
    assert.equal(recentAfter.terminateStreamed, 3, 'the host accepted the Terminate tile');
    assert.deepEqual(recentAfter.afterStreams, [{ id: '14', title: 'Forza Horizon 5' }, { id: '12', title: 'Steam Big Picture' }]);
    assert.deepEqual(recentAfter.afterOthers, recentAfter.afterStreams);
    await rebuildGrid(page);
    assert.deepEqual(await grid(page), ['Forza Horizon 5', 'Steam Big Picture', 'Cyberpunk 2077', 'Desktop']);
    assert.deepEqual(await page.evaluate(() => loadRecentApps('HOST2')), []);
    // The Smart Hub tiles follow the order as well
    assert.deepEqual(await smartHubTiles(page), [[['Forza Horizon 5', 'Steam Big Picture', 'Cyberpunk 2077', 'Desktop']]]);
    // Choosing As on the PC puts the Smart Hub tiles in the order of the host at once
    await page.evaluate(() => $('.sortAppsListMenu li[data-value="host"]').trigger('click'));
    assert.deepEqual(await smartHubTiles(page), [[['Desktop', 'Steam Big Picture', 'Cyberpunk 2077', 'Forza Horizon 5']]]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }

  // An install whose switch of earlier versions sorted Z to A keeps that order; Restore Defaults is A to Z
  const earlier = await openAppList({ stored: { sortAppsList: true } });
  try {
    assert.deepEqual(await sortSetting(earlier.page), { value: 'za', label: 'Z to A' });
    assert.deepEqual(await grid(earlier.page), ['Steam Big Picture', 'Forza Horizon 5', 'Desktop', 'Cyberpunk 2077 [Running]']);
    await earlier.page.evaluate(() => restoreDefaultsSettingsValues());
    await waitForStorage(earlier.page, (values) => values.sortAppsList === 'az');
    assert.deepEqual(await sortSetting(earlier.page), { value: 'az', label: 'A to Z' });
    assert.deepEqual(earlier.errors, []);
  } finally {
    await earlier.context.close();
  }
});

test('the orders and the entries of the app menu are named in the language of the app', async () => {
  const app = await openAppList({ stored: { languagePreference: 'de-DE', sortAppsList: 'recent' } });
  try {
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE', null, { timeout: 5000 });
    assert.deepEqual(await sortSetting(app.page), { value: 'recent', label: 'Zuletzt gespielt' });
    assert.deepEqual(await app.page.evaluate(() => [$('#appMenuFavorite .overlay-menu-label').text(), $('#appMenuUnfavorite .overlay-menu-label').text()]),
      ['Zu Favoriten hinzufügen', 'Aus Favoriten entfernen']);
    await app.page.evaluate(() => i18n.setLanguage('pt-BR'));
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'pt-BR', null, { timeout: 5000 });
    assert.deepEqual(await sortSetting(app.page), { value: 'recent', label: 'Jogados recentemente' });
    assert.equal((await readStorage(app.page)).sortAppsList, 'recent');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
