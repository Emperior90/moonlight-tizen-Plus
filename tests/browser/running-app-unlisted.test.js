'use strict';

// Checks a PC that runs an app that the app list of the TV doesn't have (since 2.3.3), against the simulated Sunshine of
// mocks/sunshine-host.js, with the keys of the remote:
// - an app added on the PC after the TV read its list: OK on another app reads the list once more (findHostApp() in
//   wasm/platform/index.js) and asks to quit it by its title, and the quit and the start follow; before, OK threw a
//   TypeError (getAppById() resolved null) and nothing happened
// - an app that the PC itself doesn't list (e.g. one that another device started from its own list of Apollo): the
//   questions name the PC (startGame(), quitAppDialog()), and "Quit app on the PC" quits it (stopGame()), also when the
//   list can't be read at all; before, the header button did nothing and stopGame() said "No app is currently running."
//   or "Unable to quit the app" without sending /cancel
// - Cancel of the question closes the audio output that the Web Audio backend opened with the press (closeStartAudio())
// - OK on the tile of an app that the PC no longer lists (its list was read again meanwhile, as the 10th poll does)
//   says so and shows the current list, where it threw the same TypeError before
// Every test checks that no error and no unhandled rejection reached the page.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, startHarness } = require('./harness');
const { key, menuState, openMenus, selectItem, takeSnackbars } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Open the app with the simulated PC (running currentGame, with the audio backend), and its app list as OK on its card
// does, once a poll found it online
async function openAppList(options) {
  const opts = options || {};
  const stored = { hosts: SUNSHINE_HOSTS };
  if (opts.audioBackend) {
    stored.audioBackend = opts.audioBackend;
  }
  const app = await openMenus(harness, {
    moduleScripts: ['sunshine-host.js'],
    stored,
    initScripts: ['window.__sunshineConfig = { currentGame: ' + (opts.currentGame || 0) + ' };'],
  });
  await app.page.waitForFunction((game) => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true &&
    Number(hosts.HOST1.currentGame) === game, opts.currentGame || 0, { timeout: 10000 });
  await app.page.evaluate(() => $('#host-container-HOST1').click());
  await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length > 0 &&
    !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
  // An OK within 600 ms of the one on the PC counts as the same press (lastHostClickAt), and the box art settles
  await app.page.waitForTimeout(800);
  await takeSnackbars(app.page);
  return app;
}

// The requests to the PC from now on, as '/path' or '/path appid' (state.http of the simulated PC)
const markRequests = (page) => page.evaluate(() => {
  window.__requestsFrom = window.__sunshine.http.length;
});
const requestsSinceMark = (page) => page.evaluate(() => window.__sunshine.http.slice(window.__requestsFrom));

const quitQuestionShown = (page) => page.waitForFunction(() => $('#quitAppDialogOverlay').css('display') === 'flex' &&
  document.activeElement && document.activeElement.id === 'cancelQuitApp', null, { timeout: 5000 });
const quitQuestion = (page) => page.evaluate(() => $('#quitAppDialogText').text());

test('OK on another app while the PC runs an app added after the TV read its list asks to quit it by its title, after reading the list once more', async () => {
  const app = await openAppList();
  const { page } = app;
  try {
    // The PC got a new app since the TV read its list, and another device started it
    await page.evaluate(() => {
      window.__sunshine.apps.push({ id: 999, title: 'New Game' });
      window.__sunshine.currentGame = 999;
    });
    await selectItem(page, 'Apps', 'game-container-101', 'left', 'right');
    await markRequests(page);
    await key(page, 'ok');
    await quitQuestionShown(page);
    assert.equal(await quitQuestion(page), 'New Game is already running. Would you like to quit it and start Cyberpunk 2077?');
    // The server info of the start, then the list once more, since the list of the TV lacked the running app
    assert.deepEqual(await requestsSinceMark(page), ['/serverinfo', '/applist']);

    // Yes (LEFT from No) quits it, and the start of Cyberpunk 2077 follows 3 s later
    await markRequests(page);
    await key(page, 'left');
    await key(page, 'ok');
    await page.waitForFunction(() => window.__sunshine.starts.length === 1 && isInGame === true, null, { timeout: 15000 });
    const requests = await requestsSinceMark(page);
    assert.deepEqual(requests.filter((request) => request === '/cancel' || request.indexOf('/launch') === 0), ['/cancel', '/launch 101']);
    assert.ok((await takeSnackbars(page)).includes('Successfully quit New Game'));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a running app that the PC doesn\'t list is named by the PC, and Quit app on the PC quits it, also when the list can\'t be read', async () => {
  const app = await openAppList({ currentGame: 999 });
  const { page } = app;
  try {
    // The header shows the quit button for the app that runs
    assert.equal(await page.evaluate(() => $('#quitRunningAppBtn').css('display') !== 'none'), true);
    await key(page, 'up');
    await key(page, 'right');
    assert.equal((await menuState(page)).current, 'quitRunningAppBtn');
    await key(page, 'ok');
    await quitQuestionShown(page);
    assert.equal(await quitQuestion(page), 'Are you sure you want to quit the app that is running on GAMING-PC? All unsaved data will be lost.');
    // Yes (LEFT from No) quits it
    await markRequests(page);
    await key(page, 'left');
    await key(page, 'ok');
    await page.waitForFunction(() => window.__sunshine.currentGame === 0 && $('#quitRunningAppBtn').css('display') === 'none', null, { timeout: 5000 });
    await page.waitForTimeout(400);
    assert.deepEqual(await takeSnackbars(page), ['Quitting the app on GAMING-PC...', 'Successfully quit the app on GAMING-PC']);
    assert.deepEqual((await requestsSinceMark(page)).filter((request) => request === '/cancel'), ['/cancel']);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.marked], ['AppsNav', 'goBackBtn', ['goBackBtn']]);

    // The PC runs the app again, and its list can't be read any more (the TV's copy is gone, as after a failed poll):
    // the question still names the PC, and the quit goes out
    await page.evaluate(async () => {
      const openUrl = Module.openUrl;
      Module.openUrl = function(id, url) {
        if (/\/applist\?/.test(url)) {
          window.__sunshine.http.push('/applist');
          setTimeout(() => handlePromiseMessage(id, 'reject', -1), 30);
          return;
        }
        return openUrl.apply(this, arguments);
      };
      window.__sunshine.currentGame = 999;
      hosts.HOST1._memCachedApplist = null;
      await hosts.HOST1.refreshServerInfo();
      updateQuitRunningAppButton(hosts.HOST1);
    });
    await key(page, 'right');
    assert.equal((await menuState(page)).current, 'quitRunningAppBtn');
    await key(page, 'ok');
    await quitQuestionShown(page);
    assert.equal(await quitQuestion(page), 'Are you sure you want to quit the app that is running on GAMING-PC? All unsaved data will be lost.');
    await markRequests(page);
    await key(page, 'left');
    await key(page, 'ok');
    await page.waitForFunction(() => window.__sunshine.currentGame === 0 && $('#quitRunningAppBtn').css('display') === 'none', null, { timeout: 5000 });
    await page.waitForTimeout(400);
    assert.deepEqual(await takeSnackbars(page), ['Quitting the app on GAMING-PC...', 'Successfully quit the app on GAMING-PC']);
    assert.deepEqual((await requestsSinceMark(page)).filter((request) => request === '/cancel'), ['/cancel']);
    // The app list after the quit can't be read either: it says so at the top of the screen
    state = await menuState(page);
    assert.deepEqual(await page.evaluate(() => [$('#game-grid img').attr('src'), $('#game-grid .game-container').length]),
      ['static/res/applist_error.svg', 0]);
    assert.ok(['Apps', 'AppsNav'].includes(state.view), state.view);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK on another app of a PC that runs an app it doesn\'t list asks with the name of the PC, and Cancel closes the Web Audio output', async () => {
  const app = await openAppList({ currentGame: 999, audioBackend: 'WebAudio' });
  const { page } = app;
  try {
    await selectItem(page, 'Apps', 'game-container-101', 'left', 'right');
    await markRequests(page);
    await key(page, 'ok');
    await quitQuestionShown(page);
    assert.equal(await quitQuestion(page), 'Another app is running on GAMING-PC. Would you like to quit it and start Cyberpunk 2077?');
    // The press opened the audio output of the Web Audio backend for the start
    assert.equal(await page.evaluate(() => !!_audContext), true);
    // OK on No
    await key(page, 'ok');
    await page.waitForTimeout(300);
    const state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs, state.current], ['Apps', [], 'game-container-101']);
    assert.equal(await page.evaluate(() => _audContext), null, 'the output is closed again');
    assert.deepEqual((await requestsSinceMark(page)).filter((request) => request === '/cancel' || request.indexOf('/launch') === 0), []);
    assert.equal(await page.evaluate(() => window.__sunshine.currentGame), 999);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK on the tile of an app that the PC no longer lists says so and shows the current list', async () => {
  const app = await openAppList({ audioBackend: 'WebAudio' });
  const { page } = app;
  try {
    // Elden Ring was renamed on the PC (Sunshine gives it a new ID), and a read of the list (the 10th poll) got it
    await page.evaluate(async () => {
      window.__sunshine.apps = window.__sunshine.apps.filter((entry) => entry.id !== 105).concat([{ id: 205, title: 'Elden Ring Nightreign' }]);
      await hosts.HOST1.getAppListWithCacheFlush();
    });
    await selectItem(page, 'Apps', 'game-container-105', 'left', 'right');
    await markRequests(page);
    await key(page, 'ok');
    await page.waitForFunction(() => document.getElementById('game-container-205') && !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    assert.deepEqual(await takeSnackbars(page), ['The selected app is no longer available on this PC. Showing the current app list.']);
    assert.deepEqual((await requestsSinceMark(page)).filter((request) => request.indexOf('/launch') === 0 || request.indexOf('/resume') === 0), []);
    const grid = await page.evaluate(() => ({
      has105: !!document.getElementById('game-container-105'),
      tiles: $('#game-grid .game-container').length,
      isInGame,
      isOutputOpen: !!_audContext,
    }));
    assert.deepEqual(grid, { has105: false, tiles: 5, isInGame: false, isOutputOpen: false });
    const state = await menuState(page);
    assert.equal(state.view, 'Apps');
    assert.equal(state.marked.length, 1, 'one tile is marked: ' + state.marked.join(', '));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
