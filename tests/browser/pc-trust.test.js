'use strict';

// Checks what the app list says when its PC no longer accepts this TV (since 2.3.3): Sunshine forgot the TV while its
// app list showed or during a stream ("Unpair All", or the TV turned off in its list of clients), and answers every
// HTTPS request with its 401 answer, which refreshServerInfoAtAddress() of utils.js rejects with HOST_REFUSED_TV_ERROR.
// - OK on an app (startGame() in wasm/platform/index.js) says so instead of "Failed to connect", and once a check marked
//   the PC not paired, it says so instead of nothing,
// - "Quit app on the PC" (stopGame()) the same, instead of "Unable to quit the app" or nothing,
// - the end of a stream (leaveStreamView() of messages.js) goes to the PC list with that message, where the PC shows
//   Unpaired after its next check, instead of an empty app list,
// - "Shut down or restart the PC" from the PC list (startPcPowerSession()) says so instead of "Failed to connect".
// The PC is the simulated Sunshine of mocks/sunshine-host.js, stored as paired; state.unpair() makes it forget the TV.

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

const REFUSED = 'GAMING-PC no longer accepts this TV: its pairing was removed or turned off on the PC. Select it in the list of PCs to pair it again.';

// Open the app with the simulated PC stored as paired (running currentGame, if any), record the snackbar messages,
// and open its app list as OK on its card does
async function openAppList(currentGame) {
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    moduleScripts: ['sunshine-host.js'],
    stored: { hosts: SUNSHINE_HOSTS },
    initScripts: ['window.__sunshineConfig = { currentGame: ' + (currentGame || 0) + ' };'],
  });
  await app.page.waitForFunction((game) => hosts.HOST1 && hosts.HOST1.online === true && Number(hosts.HOST1.currentGame) === game,
    currentGame || 0, { timeout: 10000 });
  await app.page.evaluate(() => {
    window.__snackbars = [];
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    const show = snackbar.showSnackbar.bind(snackbar);
    snackbar.showSnackbar = (data) => {
      window.__snackbars.push(data.message);
      show(data);
    };
    $('#host-container-HOST1').click();
  });
  await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length > 0 &&
    !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
  await app.page.waitForTimeout(300);
  return app;
}

// OK on the tile of Cyberpunk 2077 (app 101), which ignores an OK right after another one (lastAppTileClickAt)
const startApp = (page) => page.evaluate(() => {
  lastHostClickAt = -Infinity;
  lastAppTileClickAt = -Infinity;
  $('#game-container-101').click();
});

// What the app shows, and the requests since the last call
const take = (page) => page.evaluate(() => ({
  view: document.body.getAttribute('data-view'),
  loading: $('#wasmSpinner').is(':visible') ? $('#wasmSpinnerMessage').text() : '',
  startScreen: $('#loadingSpinner').is(':visible'),
  isInGame,
  snackbars: window.__snackbars.splice(0),
  requests: window.__sunshine.http.splice(0),
  paired: hosts.HOST1.paired,
}));

// The poll of the PC (the background polling doesn't run while the app list shows)
const poll = (page) => page.evaluate(() => new Promise((resolve) => hosts.HOST1.pollServer(() => resolve())));

test('OK on an app of a PC that no longer accepts the TV says so, also once a check marked the PC not paired', async () => {
  const app = await openAppList();
  try {
    await take(app.page);
    await app.page.evaluate(() => window.__sunshine.unpair());
    // The refresh of the start gets the 401 answer: no launch request, the app list stays
    await startApp(app.page);
    await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 5000 });
    await app.page.waitForTimeout(200);
    let state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual(state.requests, ['/serverinfo']);
    assert.deepEqual([state.view, state.startScreen, state.isInGame], ['apps', false, false]);

    // A check marks the PC not paired; OK on an app says the same, without a request
    await poll(app.page);
    assert.equal((await take(app.page)).paired, false);
    await startApp(app.page);
    await app.page.waitForTimeout(400);
    state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual(state.requests, []);
    assert.deepEqual([state.view, state.startScreen, state.isInGame], ['apps', false, false]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('"Quit app on the PC" of a PC that no longer accepts the TV says so, without the quit request', async () => {
  const app = await openAppList(101);
  try {
    await take(app.page);
    await app.page.evaluate(() => window.__sunshine.unpair());
    const quit = async () => {
      await app.page.evaluate(() => $('#quitRunningAppBtn').trigger('click'));
      await app.page.waitForFunction(() => document.getElementById('quitAppDialog').open, null, { timeout: 3000 });
      await app.page.evaluate(() => $('#continueQuitApp').trigger('click'));
      await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 5000 });
      await app.page.waitForTimeout(500);
      return take(app.page);
    };
    // A check marked the PC not paired: the message, without a request
    await poll(app.page);
    assert.equal((await take(app.page)).paired, false);
    let state = await quit();
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual(state.requests, []);

    // Before such a check: the refresh before the quit gets the 401 answer, and the quit request isn't sent
    await app.page.evaluate(() => {
      hosts.HOST1.paired = true;
    });
    state = await quit();
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.equal(state.requests[0], '/serverinfo');
    assert.equal(state.requests.indexOf('/cancel'), -1, JSON.stringify(state.requests));
    assert.equal(await app.page.evaluate(() => window.__sunshine.currentGame), 101);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the end of a stream of a PC that no longer accepts the TV goes to the PC list with that message, where the PC shows Unpaired', async () => {
  const app = await openAppList();
  try {
    await startApp(app.page);
    await app.page.waitForFunction(() => wasmSessionStarted && $('#wasm_module').is(':visible'), null, { timeout: 8000 });
    await take(app.page);
    // Sunshine forgets the TV during the stream, which then ends
    await app.page.evaluate(() => {
      window.__sunshine.unpair();
      handleMessage('streamTerminated: 0');
    });
    await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'hosts' && window.__snackbars.length > 0, null, { timeout: 5000 });
    await app.page.waitForTimeout(300);
    const state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual([state.view, state.loading, state.startScreen, state.isInGame], ['hosts', '', false, false]);
    assert.equal(await app.page.evaluate(() => $('#host-grid').is(':visible') && !$('#game-grid').is(':visible')), true);
    // The check of the PC list marks it not paired
    await app.page.waitForFunction(() => document.getElementById('host-container-HOST1').getAttribute('data-state') === 'locked', null, { timeout: 5000 });
    assert.deepEqual(await app.page.evaluate(() => [hosts.HOST1.online, hosts.HOST1.paired, hosts.HOST1.ppkstr]), [true, false, 'PPK']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('"Shut down the PC" from the PC list of a PC that no longer accepts the TV says so, and streams nothing', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, moduleScripts: ['sunshine-host.js'], stored: { hosts: SUNSHINE_HOSTS } });
  try {
    await app.page.waitForFunction(() => hosts.HOST1 && hosts.HOST1.online === true && hosts.HOST1.paired === true, null, { timeout: 10000 });
    await app.page.evaluate(() => {
      window.__snackbars = [];
      document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbars.push(data.message);
      // Sunshine forgot the TV a moment ago, before a check of the PC list noticed it
      window.__sunshine.unpair();
      startPcPowerSession(hosts.HOST1, 'shutdown');
    });
    await app.page.waitForFunction((text) => window.__snackbars.indexOf(text) >= 0, REFUSED, { timeout: 5000 });
    await app.page.waitForTimeout(300);
    const state = await take(app.page);
    // The app list that the session opens first reads no apps from the PC either, which it says before (the answer of
    // the app list isn't told apart yet, getAppListWithCacheFlush() of utils.js)
    assert.equal(state.snackbars[state.snackbars.length - 1], REFUSED);
    assert.deepEqual(state.snackbars.filter((message) => message.indexOf('Failed to connect') >= 0), []);
    assert.equal(state.requests.filter((request) => /^\/(launch|resume)/.test(request)).length, 0, JSON.stringify(state.requests));
    assert.deepEqual(await app.page.evaluate(() => [window.__sunshine.starts.length, isPcPowerSessionStarting(), isInGame]), [0, false, false]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
