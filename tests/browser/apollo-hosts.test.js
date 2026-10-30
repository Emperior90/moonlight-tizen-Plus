'use strict';

// Checks what the app does with the answers of Apollo and Vibepollo in the real page (startGame(), endLaunchWithAnswer()
// and hostPermissionDialog() in wasm/platform/index.js, the app list of NvHTTP in wasm/static/js/utils.js):
// - their Terminate tile (known by its UUID) starts without the question to quit the running app first, and the 410 'App
//   terminated.' that answers it shows as information instead of 'Error 410: App terminated.'; the running app no longer
//   shows as running afterwards;
// - a 410 that asks to launch again to confirm (Vibepollo) shows the words of the host, not an error;
// - a 403 'Permission denied' to a launch, and the 'Permission Denied' tile (ID 114514) that a TV without the permission
//   to list apps gets, explain what to allow for this TV in the web UI of Apollo; the tile is never launched.
// The host is a real NvHTTP object whose requests the stub of the module records and the test answers with the XML of
// Apollo (src/nvhttp.cpp) and Vibepollo (src/nvhttp.cpp, src/remote_session.cpp). tests/unit/apollo-hosts.test.js
// pins how the answers are read.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const TERMINATE_UUID = 'E16CBE1B-295D-4632-9A76-EC4180C857D3';
const REMOTE_INPUT_UUID = '8CB5C136-DA67-4F99-B4A1-F9CD35005CF4';

// The app list of Apollo while Cyberpunk 2077 runs with its input only mode on: the running app, Remote Input and
// Terminate
const APOLLO_RUNNING_LIST = [
  { id: 13, title: 'Cyberpunk 2077', uuid: '2B7A3B5C-1111-4222-8333-944455556666' },
  { id: 21, title: 'Remote Input', uuid: REMOTE_INPUT_UUID },
  { id: 22, title: 'Terminate', uuid: TERMINATE_UUID },
];

// The XML of an app list of Apollo
function appListXml(apps) {
  return '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' + apps.map((app) =>
    '<App><IsHdrSupported>0</IsHdrSupported><AppTitle>' + app.title + '</AppTitle><UUID>' + (app.uuid || '') + '</UUID><IDX>0</IDX><ID>' +
    app.id + '</ID></App>').join('') + '</root>';
}

// Open the app list of a real NvHTTP host whose app list the test answers; currentGame is what the server info reports,
// also after a refresh, until the test changes window.__currentGame. The HTTP requests of the module are recorded in
// window.__http, the snackbar messages in window.__snackbarMessages.
async function openHostAppList(apps, currentGame, options) {
  const opts = options || {};
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: opts.stored });
  if (opts.stored && opts.stored.languagePreference) {
    await app.page.waitForFunction((lang) => document.documentElement.getAttribute('lang') === lang, opts.stored.languagePreference, { timeout: 5000 });
  }
  await app.page.evaluate((runningApp) => {
    window.__http = [];
    window.__refreshes = 0;
    window.__currentGame = runningApp;
    Module.openUrl = (id, url) => window.__http.push({ id: id, url: url, what: url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') });
    window.__answer = (what, value) => {
      const request = window.__http.find((entry) => entry.what === what && !entry.answered);
      request.answered = true;
      handlePromiseMessage(request.id, 'resolve', value);
    };
    const host = new NvHTTP('10.0.0.2', myUniqueid || '0123456789abcdef');
    Object.assign(host, {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', ppkstr: 'PPK', httpPort: 47989, httpsPort: 47984,
      _baseUrlHttps: 'https://10.0.0.2:47984', appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      currentGame: runningApp,
    });
    host.refreshServerInfo = () => {
      window.__refreshes++;
      host.currentGame = window.__currentGame;
      return Promise.resolve(true);
    };
    host.getBoxArt = () => Promise.resolve('static/res/placeholder_game.svg');
    window.__host = host;
    api = host;
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    window.__snackbarMessages = [];
    snackbar.showSnackbar = (data) => window.__snackbarMessages.push(data.message);
    window.__shown = showApps(host).then(() => {
      Navigation.switch();
      Navigation.change(Views.Apps);
    });
  }, currentGame);
  await app.page.waitForFunction(() => window.__http.some((entry) => entry.what === '/applist'), null, { timeout: 5000 });
  await app.page.evaluate(async (xml) => {
    window.__answer('/applist', xml);
    await window.__shown;
  }, appListXml(apps));
  await waitForGrid(app.page);
  return app;
}

const waitForGrid = (page) => page.waitForFunction(() => $('#game-grid').is(':visible') && !$('#wasmSpinner').is(':visible') &&
  $('#game-grid .game-container').length > 0, null, { timeout: 5000 });

// What the grid shows: each tile as its title and its badges
const grid = (page) => page.evaluate(() => $('#game-grid .game-container').map(function() {
  const badges = $(this).find('.app-badge').map(function() {
    return $(this).text();
  }).get().filter(Boolean);
  return $(this).attr('aria-label') + (badges.length ? ' [' + badges.join(', ') + ']' : '');
}).get());

// OK on a tile of the grid
const pressTile = (page, appId) => page.evaluate((id) => {
  Views.Apps.view.index = Array.prototype.findIndex.call(Views.Apps.view.func(), (tile) => tile.id === 'game-container-' + id);
  Navigation.switch();
  Navigation.accept();
}, appId);

// The launch requests that reached the module, by app ID
const launches = (page) => page.evaluate(() => window.__http.filter((entry) => entry.what === '/launch').map((entry) => /appid=(\d+)/.exec(entry.url)[1]));

// The dialog of the app, if it shows
const dialog = (page) => page.evaluate(() => ({
  shown: $('#warningDialogOverlay').css('display') === 'flex',
  title: $('#warningDialogTitle').text(),
  text: document.getElementById('warningDialogText').innerText,
}));

test('the Terminate tile of Apollo starts without asking to quit the running app, and its 410 is information, not an error', async () => {
  const app = await openHostAppList(APOLLO_RUNNING_LIST, 13);
  const { page } = app;
  try {
    assert.deepEqual(await grid(page), ['Cyberpunk 2077 [Running]', 'Remote Input', 'Terminate']);
    await pressTile(page, 22);
    await page.waitForFunction(() => window.__http.some((entry) => entry.what === '/launch'), null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => $('#quitAppDialogOverlay').css('display')), 'none', 'no question to quit Cyberpunk 2077 first');
    assert.deepEqual(await launches(page), ['22']);
    // Apollo ends the running app and answers 410
    const refreshes = await page.evaluate(() => window.__refreshes);
    await page.evaluate(() => {
      window.__currentGame = 0;
      window.__answer('/launch', '<?xml version="1.0" encoding="utf-8"?><root status_code="410" status_message="App terminated."><resume>0</resume></root>');
    });
    await page.waitForFunction(() => isInGame === false && $('#game-grid').is(':visible'), null, { timeout: 5000 });
    await waitForGrid(page);
    const messages = await page.evaluate(() => window.__snackbarMessages.slice());
    assert.ok(messages.includes('GAMING-PC ended the running app.'), JSON.stringify(messages));
    assert.ok(!messages.some((message) => /^Error/.test(message)), JSON.stringify(messages));
    assert.ok(await page.evaluate(() => window.__refreshes) > refreshes, 'the server info is refreshed');
    assert.deepEqual(await grid(page), ['Cyberpunk 2077', 'Remote Input', 'Terminate']);
    assert.equal((await dialog(page)).shown, false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a 410 of Vibepollo that asks to launch again to confirm shows the words of the host, and the second launch ends the app', async () => {
  const app = await openHostAppList(APOLLO_RUNNING_LIST, 13);
  const { page } = app;
  const confirm = 'This will close the active stream but leave Remote Monitor and Remote Input connected. Launch Terminate again within 60 seconds to confirm this was intentional.';
  try {
    await pressTile(page, 22);
    await page.waitForFunction(() => window.__http.some((entry) => entry.what === '/launch'), null, { timeout: 3000 });
    await page.evaluate((message) => window.__answer('/launch', '<root status_code="410" status_message="' + message + '"/>'), confirm);
    await page.waitForFunction(() => isInGame === false && $('#game-grid').is(':visible'), null, { timeout: 5000 });
    await waitForGrid(page);
    let messages = await page.evaluate(() => window.__snackbarMessages.slice());
    assert.ok(messages.includes(confirm), JSON.stringify(messages));
    assert.ok(!messages.some((message) => /^Error/.test(message)), JSON.stringify(messages));
    // Still running: OK on Terminate again within 60 seconds
    assert.deepEqual(await grid(page), ['Cyberpunk 2077 [Running]', 'Remote Input', 'Terminate']);
    await page.waitForTimeout(2100); // a tile ignores a second click for 2 seconds
    await pressTile(page, 22);
    await page.waitForFunction(() => window.__http.filter((entry) => entry.what === '/launch').length === 2, null, { timeout: 3000 });
    await page.evaluate(() => {
      window.__currentGame = 0;
      window.__answer('/launch', '<root status_code="410" status_message="App terminated."/>');
    });
    await page.waitForFunction(() => window.__snackbarMessages.indexOf('GAMING-PC ended the running app.') >= 0, null, { timeout: 5000 });
    await waitForGrid(page);
    assert.deepEqual(await grid(page), ['Cyberpunk 2077', 'Remote Input', 'Terminate']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a launch that Apollo answers with "Permission denied" explains what to allow, with the words of the host', async () => {
  const app = await openHostAppList([{ id: 11, title: 'Desktop', uuid: 'A1' }, { id: 13, title: 'Cyberpunk 2077', uuid: 'A2' }], 0);
  const { page } = app;
  try {
    await pressTile(page, 13);
    await page.waitForFunction(() => window.__http.some((entry) => entry.what === '/launch'), null, { timeout: 3000 });
    await page.evaluate(() => window.__answer('/launch', '<root status_code="403" status_message="Permission denied"><resume>0</resume></root>'));
    await page.waitForFunction(() => $('#warningDialogOverlay').css('display') === 'flex', null, { timeout: 5000 });
    assert.deepEqual(await dialog(page), {
      shown: true,
      title: 'Permission needed',
      text: 'GAMING-PC doesn\'t allow this TV to start apps. In the web UI of Apollo or Vibepollo, open the paired devices (Device ' +
        'Management or Client Management) and allow "List Apps", "Launch Apps" and the input permissions for this TV. Then open the host ' +
        'again.\n\nThe host says: Permission denied',
    });
    const messages = await page.evaluate(() => window.__snackbarMessages.slice());
    assert.ok(!messages.some((message) => /^Error/.test(message)), JSON.stringify(messages));
    // OK on the remote closes it, back on the grid
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => $('#warningDialogOverlay').css('display') === 'none', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => isDialogOpen), false);
    assert.equal(await page.evaluate(() => Views.Apps.view.current().getAttribute('aria-label')), 'Cyberpunk 2077');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Permission Denied tile is never launched: it explains what to allow, in the language of the app', async () => {
  const app = await openHostAppList([{ id: 114514, title: 'Permission Denied', uuid: '' }], 0, { stored: { languagePreference: 'de-DE' } });
  const { page } = app;
  try {
    await pressTile(page, 114514);
    await page.waitForFunction(() => $('#warningDialogOverlay').css('display') === 'flex', null, { timeout: 5000 });
    const shown = await dialog(page);
    assert.equal(shown.title, 'Berechtigung erforderlich');
    assert.match(shown.text, /^GAMING-PC erlaubt diesem TV nicht, Apps zu starten\. .*„Launch Apps“/);
    assert.match(shown.text, /Öffne den PC danach erneut\.$/);
    assert.ok(shown.text.indexOf('Meldung des PCs') < 0, 'no message of the host');
    await page.waitForTimeout(300);
    assert.deepEqual(await launches(page), []);
    assert.equal(await page.evaluate(() => isInGame), false);
    // A gamepad closes it with A
    await page.evaluate(() => {
      const send = (pressed) => window.dispatchEvent(new CustomEvent('gamepadinputchanged', { detail: { gamepad: 0, changes: [{ type: 'button', index: 0, pressed }] } }));
      send(true);
      send(false);
    });
    await page.waitForFunction(() => $('#warningDialogOverlay').css('display') === 'none', null, { timeout: 3000 });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
