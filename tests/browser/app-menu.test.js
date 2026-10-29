'use strict';

// Checks the menu of an app tile in the real page (wasm/platform/menus.js, Views.Apps and Views.AppMenu in
// navigation.js, showApps() in index.js): the running app has a visible Running badge and the header tells how to open
// the menu; CH+ and Play/Pause of the remote and Select of a gamepad open it for the selected tile; it offers Resume and
// Quit for the running app and Start for the others, which run like OK on the tile and the Quit Running App button;
// Hide app leaves the app out of the grid and the Smart Hub tiles, stored per host and matched by ID or title, 'Show
// hidden apps' shows the hidden apps dimmed, and 'Show app again' brings one back. The host and its apps are simulated.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

// delayedNavigation() runs the gamepad buttons of the menus 150 ms later (NAVIGATION_DELAY)
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

// Open the app list of a simulated host whose app 13 runs (sorted A-Z: Cyberpunk 2077, Desktop, Forza Horizon 5, Steam
// Big Picture). The calls of startGame() and the snackbar messages are recorded.
async function openAppList(options) {
  const opts = options || {};
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  await app.page.evaluate(async (settings) => {
    window.__apps = [{ id: 11, title: 'Desktop' }, { id: 12, title: 'Steam Big Picture' }, { id: 13, title: 'Cyberpunk 2077' },
      { id: 14, title: 'Forza Horizon 5' }];
    window.__starts = [];
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989,
      currentGame: settings.currentGame === undefined ? 13 : settings.currentGame, appVersion: '7.1.431.-1', gfeVersion: '',
      serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppList: () => Promise.resolve(window.__apps.slice()),
      getAppById: (id) => Promise.resolve(window.__apps.find((entry) => entry.id == id) || null),
      getBoxArt: () => Promise.resolve('static/res/placeholder_game.svg'),
      toString: () => 'GAMING-PC',
    };
    (settings.hidden || []).forEach((entry) => localStorage.setItem('hiddenApps_' + entry.host, JSON.stringify(entry.apps)));
    window.__host = host;
    api = host;
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

// What the grid shows: each tile as 'title' plus its badges
const grid = (page) => page.evaluate(() => $('#game-grid .game-container').map(function() {
  const badges = $(this).find('.app-badge').map(function() {
    return $(this).text();
  }).get();
  return $(this).attr('aria-label') + (badges.length ? ' [' + badges.join(', ') + ']' : '') + ($(this).hasClass('app-hidden') ? ' (dimmed)' : '');
}).get());

// What the app menu shows
const appMenu = (page) => page.evaluate(() => ({
  open: $('#appMenuOverlay').css('display') !== 'none',
  title: $('#appMenuTitle').text(),
  subtitle: $('#appMenuSubtitle').text(),
  entries: getOverlayMenuItems('appMenu').map((item) => item.id),
  focused: document.activeElement ? document.activeElement.id : '',
}));

// The selected tile of the grid
const selectedApp = (page) => page.evaluate(() => {
  const tile = Views.Apps.view.current();
  return tile ? tile.getAttribute('aria-label') : null;
});

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

test('the running app has a Running badge, the header names the keys of the app menu, and CH+ opens it', async () => {
  const app = await openAppList();
  try {
    assert.deepEqual(await grid(app.page), ['Cyberpunk 2077 [Running]', 'Desktop', 'Forza Horizon 5', 'Steam Big Picture']);
    assert.deepEqual(await app.page.evaluate(() => ({ shown: $('#appMenuHint').is(':visible'), text: $('#appMenuHint').text().trim() })),
      { shown: true, text: 'App options: CH+ or Play/Pause on the remote, Select on a gamepad' });
    // The running app is selected; CH+ opens its menu with Resume and Quit
    assert.equal(await selectedApp(app.page), 'Cyberpunk 2077');
    await remote(app.page, 'KEY_CHANNEL_UP');
    assert.deepEqual(await appMenu(app.page), {
      open: true, title: 'Cyberpunk 2077', subtitle: 'Running on GAMING-PC', focused: 'appMenuResume',
      entries: ['appMenuResume', 'appMenuQuit', 'appMenuHide', 'appMenuClose'],
    });
    // DOWN moves, RETURN closes and the tile stays selected
    await remote(app.page, 'KEY_DOWN');
    assert.equal((await appMenu(app.page)).focused, 'appMenuQuit');
    await remote(app.page, 'KEY_RETURN');
    assert.equal((await appMenu(app.page)).open, false);
    assert.equal(await selectedApp(app.page), 'Cyberpunk 2077');

    // RIGHT to Desktop: Play/Pause opens its menu with Start, and the hint goes away with the app list
    await remote(app.page, 'KEY_RIGHT');
    await remote(app.page, 'KEY_PLAY_PAUSE');
    assert.deepEqual(await appMenu(app.page), {
      open: true, title: 'Desktop', subtitle: 'GAMING-PC', focused: 'appMenuStart', entries: ['appMenuStart', 'appMenuHide', 'appMenuClose'],
    });
    // Play/Pause again closes it
    await remote(app.page, 'KEY_PLAY_PAUSE');
    assert.equal((await appMenu(app.page)).open, false);
    await app.page.evaluate(() => showHostsMode());
    assert.equal(await app.page.evaluate(() => $('#appMenuHint').is(':visible')), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Start and Resume run like OK on the tile, and Quit app asks to quit the running app', async () => {
  const app = await openAppList();
  try {
    // Resume of the running app
    await remote(app.page, 'KEY_CHANNEL_UP');
    await remote(app.page, 'KEY_ENTER');
    assert.equal((await appMenu(app.page)).open, false);
    // Start of another app, chosen with a gamepad: Select opens the menu, A starts
    await remote(app.page, 'KEY_RIGHT');
    await app.page.waitForTimeout(2100); // the tile ignores a second click for 2 seconds
    await gamepadButton(app.page, 8);
    assert.deepEqual(await appMenu(app.page).then((menu) => [menu.open, menu.title, menu.focused]), [true, 'Desktop', 'appMenuStart']);
    await gamepadButton(app.page, 0);
    assert.deepEqual(await app.page.evaluate(() => window.__starts.slice()), ['HOST1 13', 'HOST1 11']);

    // Quit app shows the confirmation of the Quit Running App button for the running app
    await app.page.waitForTimeout(2100);
    await remote(app.page, 'KEY_LEFT');
    await remote(app.page, 'KEY_CHANNEL_UP');
    await remote(app.page, 'KEY_DOWN');
    await remote(app.page, 'KEY_ENTER');
    await app.page.waitForFunction(() => $('#quitAppDialogOverlay').css('display') === 'flex');
    assert.equal(await app.page.evaluate(() => $('#quitAppDialogText').text()), 'Are you sure you want to quit Cyberpunk 2077? All unsaved data will be lost.');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Hide app leaves the app out for this host, Show hidden apps shows it dimmed, and Show app again brings it back', async () => {
  const app = await openAppList();
  try {
    // Desktop: Select, DOWN to Hide app, A
    await remote(app.page, 'KEY_RIGHT');
    await gamepadButton(app.page, 8);
    await gamepadButton(app.page, 13);
    assert.equal((await appMenu(app.page)).focused, 'appMenuHide');
    await gamepadButton(app.page, 0);
    await app.page.waitForTimeout(100);
    await waitForGrid(app.page);
    assert.deepEqual(await grid(app.page), ['Cyberpunk 2077 [Running]', 'Forza Horizon 5', 'Steam Big Picture']);
    assert.equal(await selectedApp(app.page), 'Forza Horizon 5', 'the tile in its place is selected');
    assert.deepEqual(await app.page.evaluate(() => JSON.parse(localStorage.getItem('hiddenApps_HOST1'))), [{ id: '11', title: 'Desktop' }]);
    assert.deepEqual(await app.page.evaluate(() => loadHiddenApps('HOST2')), [], 'another host keeps its apps');
    assert.ok((await app.page.evaluate(() => window.__snackbarMessages.slice())).includes('Desktop is hidden. Choose "Show hidden apps" in the menu of an app to see it again.'));

    // The menu of another app offers to show the hidden one
    await remote(app.page, 'KEY_CHANNEL_UP');
    let menu = await appMenu(app.page);
    assert.deepEqual(menu.entries, ['appMenuStart', 'appMenuHide', 'appMenuShowHidden', 'appMenuClose']);
    assert.equal(await app.page.evaluate(() => $('#appMenuShowHiddenLabel').text()), 'Show hidden apps (1)');
    await app.page.evaluate(() => $('#appMenuShowHidden').click());
    await app.page.waitForTimeout(100);
    await waitForGrid(app.page);
    assert.deepEqual(await grid(app.page), ['Cyberpunk 2077 [Running]', 'Desktop [Hidden] (dimmed)', 'Forza Horizon 5', 'Steam Big Picture']);
    assert.equal(await selectedApp(app.page), 'Forza Horizon 5');

    // Its own menu shows it again; the grid keeps showing the hidden apps until 'Hide hidden apps'
    await remote(app.page, 'KEY_LEFT');
    await remote(app.page, 'KEY_CHANNEL_UP');
    menu = await appMenu(app.page);
    assert.deepEqual([menu.title, menu.subtitle], ['Desktop', 'Hidden']);
    assert.deepEqual(menu.entries, ['appMenuStart', 'appMenuUnhide', 'appMenuShowHidden', 'appMenuClose']);
    assert.equal(await app.page.evaluate(() => $('#appMenuShowHiddenLabel').text()), 'Hide hidden apps');
    await app.page.evaluate(() => $('#appMenuUnhide').click());
    await app.page.waitForTimeout(100);
    await waitForGrid(app.page);
    assert.deepEqual(await grid(app.page), ['Cyberpunk 2077 [Running]', 'Desktop', 'Forza Horizon 5', 'Steam Big Picture']);
    assert.equal(await app.page.evaluate(() => localStorage.getItem('hiddenApps_HOST1')), null);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a hidden app is matched by its title after its ID changed, the running app shows anyway, and all hidden show all', async () => {
  const byTitle = await openAppList({ hidden: [{ host: 'HOST1', apps: [{ id: '99', title: 'Steam Big Picture' }, { id: '13', title: 'Cyberpunk 2077' }] }] });
  try {
    assert.deepEqual(await grid(byTitle.page), ['Cyberpunk 2077 [Hidden, Running] (dimmed)', 'Desktop', 'Forza Horizon 5']);
    assert.deepEqual(byTitle.errors, []);
  } finally {
    await byTitle.context.close();
  }

  const allHidden = await openAppList({ currentGame: 0, hidden: [{ host: 'HOST1', apps: [{ id: '11', title: 'Desktop' }, { id: '12', title: 'Steam Big Picture' },
    { id: '13', title: 'Cyberpunk 2077' }, { id: '14', title: 'Forza Horizon 5' }] }] });
  try {
    assert.deepEqual(await grid(allHidden.page), ['Cyberpunk 2077 [Hidden] (dimmed)', 'Desktop [Hidden] (dimmed)', 'Forza Horizon 5 [Hidden] (dimmed)',
      'Steam Big Picture [Hidden] (dimmed)']);
    assert.deepEqual(allHidden.errors, []);
  } finally {
    await allHidden.context.close();
  }
});

test('the Smart Hub tiles leave out the hidden apps, and a deleted host forgets them', async () => {
  const app = await openAppList({ hidden: [{ host: 'HOST1', apps: [{ id: '11', title: 'Desktop' }] }] });
  try {
    const previews = await app.page.evaluate(() => {
      const sent = [];
      _isSmartHubSupported = true;
      _previewApps = { HOST1: { hostname: 'GAMING-PC', address: '10.0.0.2', apps: window.__apps.map((entry) => ({ id: entry.id, title: entry.title })) } };
      tizen.messageport = { requestLocalMessagePort: () => ({ addMessagePortListener: () => 1, removeMessagePortListener: () => {} }) };
      tizen.ApplicationControlData = function(key, value) {
        this.key = key;
        this.value = value;
      };
      tizen.ApplicationControl = function(operation, uri, mime, category, data) {
        this.data = data;
      };
      tizen.application.launchAppControl = (control) => sent.push(JSON.parse(control.data[0].value[0]));
      updatePreviewData();
      return sent.map((data) => data.sections.map((section) => section.tiles.map((tile) => tile.title)));
    });
    assert.deepEqual(previews, [[['Steam Big Picture', 'Cyberpunk 2077', 'Forza Horizon 5']]]);

    await app.page.evaluate(() => forgetHiddenApps('HOST1'));
    assert.equal(await app.page.evaluate(() => localStorage.getItem('hiddenApps_HOST1')), null);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
