'use strict';

// Checks a PC that runs an app that the app list of the TV doesn't have (since 2.3.3), against the simulated Sunshine of
// mocks/sunshine-host.js, with the keys of the remote:
// - an app added on the PC after the TV read its list: OK on another app reads the list once more (findHostApp() in
//   wasm/platform/index.js) and asks to quit it by its title, and the quit and the start follow; before, OK threw a
//   TypeError (getAppById() resolved null) and nothing happened. Yes closes the audio output that the Web Audio backend
//   opened with the press (the start after the quit opens its own)
// - an app that the PC itself doesn't list: the questions name the PC (startGame(), quitAppDialog()), also when the
//   list can't be read once more, and "Quit app on the PC" quits it (stopGame()), also when the list can't be read at
//   all; before, the header button did nothing and stopGame() said "No app is currently running." or "Unable to quit
//   the app" without sending /cancel
// - Cancel of the question closes the audio output that the Web Audio backend opened with the press (closeStartAudio())
// - OK on the tile of an app that the PC no longer lists (its list was read again meanwhile, as the 10th poll does)
//   says so and shows the current list, where it threw the same TypeError before
// - RETURN to the PC list while the PC answers a press (the server info of a start, the list read once more): the
//   question to quit and the list built again are dropped (the visit of the app list at the press, appListVisitOf()),
//   also when the same PC is opened again meanwhile; in testing the list came back over the PC list, whose keys then
//   went to the hidden grid, and the question opened over the PC list
// - Yes to a question to quit (OK on another app, "Quit app on the PC"), then RETURN while the PC quits slowly: the
//   quit ends, but neither the app list after it (stopGame() with the visit of the press) nor the start of the other
//   app follows; before 2.3.3 the app list replaced the PC list and the other app started
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
  const app = await openAppList({ audioBackend: 'WebAudio' });
  const { page } = app;
  try {
    // The PC got a new app since the TV read its list, and another device started it. No poll of the PC runs meanwhile,
    // which would read the list as well (its second one does).
    await page.evaluate(() => {
      endBackgroundPollingOfHost(hosts.HOST1);
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

    // Yes (LEFT from No) quits it, and the start of Cyberpunk 2077 follows 3 s later. The Web Audio output that OK
    // opened closes with Yes, while the quit runs, and the start opens its own.
    await markRequests(page);
    await key(page, 'left');
    await key(page, 'ok', 50);
    await page.waitForFunction(() => window.__sunshine.currentGame === 0, null, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => [!!_audContext, isInGame]), [false, false]);
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
    // The illustration of the failed list has the keys, also after the quit from the header (AppsNav)
    assert.equal(state.view, 'Apps');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK on another app while the PC runs an app that its list lacks asks with the name of the PC also when the list can\'t be read once more', async () => {
  const app = await openAppList();
  const { page } = app;
  try {
    // An app that the TV's list lacks runs, and the PC fails the request of its list once more
    await page.evaluate(() => {
      endBackgroundPollingOfHost(hosts.HOST1);
      window.__sunshine.currentGame = 999;
      const openUrl = Module.openUrl;
      Module.openUrl = function(id, url) {
        if (/\/applist\?/.test(url)) {
          window.__sunshine.http.push('/applist');
          setTimeout(() => handlePromiseMessage(id, 'reject', -1), 30);
          return;
        }
        return openUrl.apply(this, arguments);
      };
    });
    await selectItem(page, 'Apps', 'game-container-101', 'left', 'right');
    await markRequests(page);
    await key(page, 'ok');
    await quitQuestionShown(page);
    assert.equal(await quitQuestion(page), 'Another app is running on GAMING-PC. Would you like to quit it and start Cyberpunk 2077?');
    assert.deepEqual(await requestsSinceMark(page), ['/serverinfo', '/applist']);
    // Yes quits it all the same, and the start follows
    await markRequests(page);
    await key(page, 'left');
    await key(page, 'ok');
    await page.waitForFunction(() => window.__sunshine.starts.length === 1 && isInGame === true, null, { timeout: 15000 });
    assert.deepEqual((await requestsSinceMark(page)).filter((request) => request === '/cancel' || request.indexOf('/launch') === 0), ['/cancel', '/launch 101']);
    assert.ok((await takeSnackbars(page)).includes('Successfully quit the app on GAMING-PC'));
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

// What shows: the view that has the keys (menu-driver.js), the screen (data-view), the question to quit and the Web Audio
// output that OK opened
const shownNow = (page) => page.evaluate(() => ({
  view: window.__view,
  dataView: document.body.getAttribute('data-view'),
  question: $('#quitAppDialogOverlay').css('display') === 'flex' || isDialogOpen,
  isOutputOpen: typeof _audContext !== 'undefined' && !!_audContext,
}));

test('OK on the tile of an app that the PC no longer lists, then RETURN while the PC answers: the PC list keeps the keys', async () => {
  const app = await openAppList({ audioBackend: 'WebAudio' });
  const { page } = app;
  try {
    // A read of the list got Elden Ring with a new ID (as in the test above), and the PC answers slowly
    await page.evaluate(async () => {
      window.__sunshine.apps = window.__sunshine.apps.filter((entry) => entry.id !== 105).concat([{ id: 205, title: 'Elden Ring Nightreign' }]);
      await hosts.HOST1.getAppListWithCacheFlush();
    });
    await selectItem(page, 'Apps', 'game-container-105', 'left', 'right');
    await page.evaluate(() => {
      window.__sunshine.delayMs = 1500;
    });
    await key(page, 'ok', 100);
    // The user goes back to the PC list before the PC answered the server info of the start
    await key(page, 'back');
    assert.deepEqual(await shownNow(page), { view: 'Hosts', dataView: 'hosts', question: false, isOutputOpen: true });
    await page.evaluate(() => {
      window.__sunshine.delayMs = 30;
    });
    await page.waitForTimeout(2500);
    // The answers came: the PC list stays with its keys, no list of the PC is built over it (2.3.3 in testing built it
    // and put its view in the place of the PC list, whose keys then went to the hidden grid: RETURN stuck on the PC
    // list, and OK started an app of the hidden grid), and the output closed
    assert.deepEqual(await shownNow(page), { view: 'Hosts', dataView: 'hosts', question: false, isOutputOpen: false });
    assert.equal(await page.evaluate(() => $('#game-grid').is(':visible')), false);
    assert.deepEqual((await takeSnackbars(page)).filter((message) => message.indexOf('no longer available') >= 0), []);
    // OK on the PC opens its current list, and RETURN goes back to the PC list again
    await key(page, 'ok');
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && !!document.getElementById('game-container-205') &&
      !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    await page.waitForTimeout(700);
    await key(page, 'back');
    assert.deepEqual(await shownNow(page), { view: 'Hosts', dataView: 'hosts', question: false, isOutputOpen: false });
    assert.equal(await page.evaluate(() => isInGame), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK on another app, then RETURN while the PC answers: no question over the PC list, nor in the next visit of the list', async () => {
  const app = await openAppList({ currentGame: 102, audioBackend: 'WebAudio' });
  const { page } = app;
  try {
    // OK on another app of a PC that answers slowly, then RETURN to the PC list before the server info came
    await selectItem(page, 'Apps', 'game-container-101', 'left', 'right');
    await page.evaluate(() => {
      window.__sunshine.delayMs = 1500;
    });
    await key(page, 'ok', 100);
    await key(page, 'back');
    assert.deepEqual(await shownNow(page), { view: 'Hosts', dataView: 'hosts', question: false, isOutputOpen: true });
    await page.waitForTimeout(2500);
    // The question to quit Desktop opened over the PC list up to 2.3.3 in testing, whose Yes then put the app list in
    // the place of the PC list
    assert.deepEqual(await shownNow(page), { view: 'Hosts', dataView: 'hosts', question: false, isOutputOpen: false });

    // Again, but OK on the PC opens its list once more before the answers came: the question belongs to the visit of
    // the list that was left, not to this one
    await page.evaluate(() => {
      window.__sunshine.delayMs = 30;
    });
    await key(page, 'ok');
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length > 0 &&
      !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    // A card of a PC takes a second click only 2 s after the first (isClickPrevented in index.js)
    await page.waitForTimeout(2000);
    await selectItem(page, 'Apps', 'game-container-101', 'left', 'right');
    await page.evaluate(() => {
      window.__sunshine.delayMs = 1500;
    });
    await key(page, 'ok', 100);
    await key(page, 'back', 200);
    await key(page, 'ok');
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length > 0 &&
      !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    await page.waitForTimeout(2500);
    assert.deepEqual(await shownNow(page), { view: 'Apps', dataView: 'apps', question: false, isOutputOpen: false });
    assert.deepEqual((await page.evaluate(() => window.__sunshine.http)).filter((request) => request === '/cancel' || /^\/(launch|resume)/.test(request)), []);
    assert.ok(app.logs.some((line) => line.indexOf('Not asking to quit the running app of GAMING-PC') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('"Quit app on the PC", then RETURN while the list is read once more: no question over the PC list, nor in the next visit', async () => {
  const app = await openAppList({ currentGame: 999 });
  const { page } = app;
  try {
    // The TV's list lacks the running app, so the question waits for the list once more, which takes 1.5 s
    await page.evaluate(() => {
      const openUrl = Module.openUrl;
      Module.openUrl = function(id, url) {
        if (/\/applist\?/.test(url)) {
          const args = arguments;
          setTimeout(() => openUrl.apply(this, args), 1500);
          return;
        }
        return openUrl.apply(this, arguments);
      };
    });
    const quitFromHeader = async () => {
      await key(page, 'up');
      await key(page, 'right');
      assert.equal((await menuState(page)).current, 'quitRunningAppBtn');
      await key(page, 'ok', 250);
    };
    await quitFromHeader();
    await key(page, 'back');
    assert.deepEqual(await shownNow(page), { view: 'Hosts', dataView: 'hosts', question: false, isOutputOpen: false });
    await page.waitForTimeout(2500);
    assert.deepEqual(await shownNow(page), { view: 'Hosts', dataView: 'hosts', question: false, isOutputOpen: false });

    // Again, and OK on the PC opens its list once more before the list came
    await key(page, 'ok');
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length > 0 &&
      !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    // A card of a PC takes a second click only 2 s after the first (isClickPrevented in index.js)
    await page.waitForTimeout(2000);
    await quitFromHeader();
    await key(page, 'back', 200);
    await key(page, 'ok');
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length > 0 &&
      !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    await page.waitForTimeout(2500);
    assert.deepEqual(await shownNow(page), { view: 'Apps', dataView: 'apps', question: false, isOutputOpen: false });
    assert.equal(await page.evaluate(() => window.__sunshine.currentGame), 999);
    assert.ok(app.logs.some((line) => line.indexOf('Not asking to quit the running app of GAMING-PC') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// The PC takes 1.5 s per answer from the next request on (a quit whose /cancel Sunshine answers once the game closed)
const answerSlowly = (page) => page.evaluate(() => {
  window.__sunshine.delayMs = 1500;
});

// The PC list with its keys and nothing of the app list over it
const pcListShown = (page) => page.evaluate(() => ({
  view: window.__view,
  dataView: document.body.getAttribute('data-view'),
  hostGrid: $('#host-grid').is(':visible'),
  gameGrid: $('#game-grid').is(':visible'),
  loading: $('#wasmSpinner').is(':visible'),
  isInGame,
}));
const PC_LIST = { view: 'Hosts', dataView: 'hosts', hostGrid: true, gameGrid: false, loading: false, isInGame: false };

test('Yes to the question to quit, then RETURN while the PC quits slowly: the PC list stays, and the other app doesn\'t start', async () => {
  const app = await openAppList({ currentGame: 101 });
  const { page } = app;
  try {
    // OK on Steam Big Picture while Cyberpunk 2077 runs, Yes (LEFT from No), and RETURN at once
    await selectItem(page, 'Apps', 'game-container-103', 'left', 'right');
    await key(page, 'ok');
    await quitQuestionShown(page);
    assert.equal(await quitQuestion(page), 'Cyberpunk 2077 is already running. Would you like to quit it and start Steam Big Picture?');
    await markRequests(page);
    await answerSlowly(page);
    await key(page, 'left');
    await key(page, 'ok', 300);
    await key(page, 'back');
    assert.deepEqual(await pcListShown(page), PC_LIST);
    // The quit goes on and ends (server info, /cancel, server info), but neither the app list comes back over the PC
    // list nor does Steam Big Picture start: before 2.3.3, the app list replaced the PC list some seconds later, and the
    // app started about 13 s after RETURN
    await page.waitForFunction(() => window.__sunshine.currentGame === 0, null, { timeout: 10000 });
    await page.waitForTimeout(6000);
    assert.deepEqual(await pcListShown(page), PC_LIST);
    const requests = await requestsSinceMark(page);
    assert.deepEqual(requests.filter((request) => request === '/cancel' || /^\/(launch|resume)/.test(request)), ['/cancel']);
    assert.equal(await page.evaluate(() => window.__sunshine.starts.length), 0);
    assert.ok((await takeSnackbars(page)).includes('Successfully quit Cyberpunk 2077'));
    assert.ok(app.logs.some((line) => line.indexOf('Not showing the app list of GAMING-PC again after the quit') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('"Quit app on the PC", Yes, then RETURN while the PC quits slowly: the PC list stays', async () => {
  const app = await openAppList({ currentGame: 101 });
  const { page } = app;
  try {
    await key(page, 'up');
    await key(page, 'right');
    assert.equal((await menuState(page)).current, 'quitRunningAppBtn');
    await key(page, 'ok');
    await quitQuestionShown(page);
    await answerSlowly(page);
    await key(page, 'left');
    await key(page, 'ok', 300);
    await key(page, 'back');
    assert.deepEqual(await pcListShown(page), PC_LIST);
    await page.waitForFunction(() => window.__sunshine.currentGame === 0, null, { timeout: 10000 });
    // Time for a list that the quit would build (its request takes 1.5 s)
    await page.waitForTimeout(4000);
    assert.deepEqual(await pcListShown(page), PC_LIST);
    assert.ok((await takeSnackbars(page)).includes('Successfully quit Cyberpunk 2077'));
    assert.ok(app.logs.some((line) => line.indexOf('Not showing the app list of GAMING-PC again after the quit') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
