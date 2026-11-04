'use strict';

// Checks the app list of a PC with the remote, against the simulated Sunshine host of mocks/sunshine-host.js, stored as
// the paired PC of an existing install (updateQuitRunningAppButton() and the click handlers of the host cards and the app
// tiles in wasm/platform/index.js):
// - after the button 'Quit app on the PC' of the header quit the app, it hides without keeping its mark or its tooltip,
//   which stayed on the screen before (also on the PC list), and the back button gets the selection; after the next
//   stream only the tile is marked, although the button shows again
// - the app list shows at once after OK on a PC, with the app started last selected, and OK on that tile starts it
//   instead of being ignored for 2 seconds: only an OK within 600 ms of the one on the PC (the same press) and a second
//   start within 2 seconds are ignored

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
const UP = [38, 'ArrowUp'];
const DOWN = [40, 'ArrowDown'];
const LEFT = [37, 'ArrowLeft'];
const RIGHT = [39, 'ArrowRight'];
const OK = [13, 'Enter'];
const RED = [403, 'ColorF0Red'];

// Press and release a key of the remote on the focused element, like the TV delivers it
const remoteKey = (page, key) => page.evaluate(({ code, name }) => {
  ['keydown', 'keyup'].forEach((type) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  });
}, { code: key[0], name: key[1] });

// Open the app with the simulated PC, optionally running an app already, and wait until a poll found it online
async function openWithPc(currentGame) {
  const app = await openApp(harness, {
    tv: TV,
    moduleScripts: ['sunshine-host.js'],
    stored: { hosts: SUNSHINE_HOSTS },
    initScripts: [`window.__sunshineConfig = { currentGame: ${currentGame || 0} };`],
  });
  await app.page.waitForFunction((game) => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true &&
    Number(hosts.HOST1.currentGame) === game, currentGame || 0, { timeout: 10000 });
  return app;
}

// Select the card of the PC in the host grid with RIGHT (the Add PC card comes first)
async function selectPcCard(page) {
  for (let i = 0; i < 3; i++) {
    if (await page.evaluate(() => Views.Hosts.view.current() && Views.Hosts.view.current().id === 'host-container-HOST1')) {
      return;
    }
    await remoteKey(page, RIGHT);
    await page.waitForTimeout(80);
  }
  throw new Error('The card of the PC could not be selected');
}

const appListShown = (page) => page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' &&
  $('#game-grid .game-container').length > 0 && !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });

// The marked elements, the focused one, and the state of the quit button and its tooltip
const screenState = (page) => page.evaluate(() => {
  const tooltip = document.getElementById('quitRunningAppTooltip');
  const style = getComputedStyle(tooltip);
  return {
    marked: Array.prototype.map.call(document.querySelectorAll('.hovered'), (element) => element.id).filter(Boolean),
    focused: document.activeElement ? document.activeElement.id : '',
    quitShown: $('#quitRunningAppBtn').css('display') !== 'none',
    tooltipActive: tooltip.classList.contains('is-active'),
    tooltipVisible: style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0 &&
      tooltip.getBoundingClientRect().width > 0,
  };
});

test('the quit button of the header hides without its mark and tooltip after the quit, and the back button gets the selection', async () => {
  const app = await openWithPc(105);
  const { page } = app;
  try {
    await selectPcCard(page);
    await remoteKey(page, OK);
    await appListShown(page);
    // UP to the header and RIGHT to the quit button, which shows its tooltip
    await remoteKey(page, UP);
    await remoteKey(page, RIGHT);
    let state = await screenState(page);
    assert.deepEqual([state.marked, state.focused, state.quitShown, state.tooltipActive], [['quitRunningAppBtn'], 'quitRunningAppBtn', true, true]);

    // OK opens the question, which opens on No; LEFT and OK quit the app
    await remoteKey(page, OK);
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'cancelQuitApp', null, { timeout: 3000 });
    await remoteKey(page, LEFT);
    await remoteKey(page, OK);
    await page.waitForFunction(() => window.__sunshine.currentGame === 0 && $('#quitRunningAppBtn').css('display') === 'none', null, { timeout: 5000 });
    await page.waitForTimeout(300);
    state = await screenState(page);
    assert.deepEqual(state, { marked: ['goBackBtn'], focused: 'goBackBtn', quitShown: false, tooltipActive: false, tooltipVisible: false });
    // The selection of the header row is the back button as well
    assert.equal(await page.evaluate(() => Views.AppsNav.view.current()), 'goBackBtn');

    // DOWN to the tile, OK starts the app again, and RED ends the stream: only the tile is marked, although the quit
    // button shows again for the app that runs on the PC now
    await remoteKey(page, DOWN);
    const tile = await page.evaluate(() => Views.Apps.view.current().id);
    assert.deepEqual((await screenState(page)).marked, [tile]);
    await remoteKey(page, OK);
    // The start waits behind the requests of the app list that the quit rebuilt, which takes a while on a slow test
    // machine (the module has one HTTP thread)
    await page.waitForFunction(() => isInGame === true && window.__sunshine.starts.length === 1, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    await remoteKey(page, RED);
    await page.waitForFunction(() => isInGame === false && document.body.getAttribute('data-view') === 'apps' &&
      $('#quitRunningAppBtn').css('display') !== 'none', null, { timeout: 15000 });
    await page.waitForTimeout(300);
    state = await screenState(page);
    assert.deepEqual([state.marked, state.quitShown, state.tooltipActive], [[tile], true, false]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK on the app selected after opening a PC starts it at once, but not with the press on the PC or twice within 2 s', async () => {
  const app = await openWithPc(0);
  const { page } = app;
  try {
    // The tile handler calls the global startGame(), which only records the starts here, so that the app list stays
    await page.evaluate(() => {
      localStorage.setItem('lastOpenedApp_HOST1', '104');
      window.__starts = [];
      startGame = (host, appId) => window.__starts.push({ appId: appId, at: performance.now() });
    });
    await selectPcCard(page);
    // OK on the PC, and a click on the tile as soon as it exists: the same press, or a double press, starts nothing
    const early = await page.evaluate(() => new Promise((resolve) => {
      window.__pcOkAt = performance.now();
      ['keydown', 'keyup'].forEach((type) => {
        const event = new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { value: 13 });
        Object.defineProperty(event, 'which', { value: 13 });
        (document.activeElement || document.body).dispatchEvent(event);
      });
      const poll = () => {
        const tile = document.getElementById('game-container-104');
        if (!tile) {
          requestAnimationFrame(poll);
          return;
        }
        const clickedAfter = performance.now() - window.__pcOkAt;
        tile.click();
        resolve({ clickedAfter, starts: window.__starts.length });
      };
      poll();
    }));
    assert.ok(early.clickedAfter < 600, 'the tile was clicked ' + early.clickedAfter + ' ms after the OK on the PC');
    assert.equal(early.starts, 0, 'a click within 600 ms of the OK on the PC is ignored');

    await appListShown(page);
    assert.equal(await page.evaluate(() => Views.Apps.view.current().id), 'game-container-104', 'the app started last is selected');
    // OK on it about 0.7 s after the OK on the PC starts it
    await page.waitForFunction(() => performance.now() - window.__pcOkAt >= 700, null, { timeout: 3000 });
    await remoteKey(page, OK);
    let starts = await page.evaluate(() => window.__starts.map((start) => start.appId));
    assert.deepEqual(starts, [104], 'OK 0.7 s after the OK on the PC starts the app');

    // A second OK within 2 s of that start starts nothing more
    await page.waitForTimeout(300);
    await remoteKey(page, OK);
    starts = await page.evaluate(() => window.__starts.map((start) => start.appId));
    assert.deepEqual(starts, [104], 'a second OK within 2 s starts nothing');

    // 2 s after the start, OK starts it again
    await page.waitForFunction(() => performance.now() - window.__starts[0].at > 2050, null, { timeout: 4000 });
    await remoteKey(page, OK);
    starts = await page.evaluate(() => window.__starts.map((start) => start.appId));
    assert.deepEqual(starts, [104, 104]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK on the selected app 0.7 s after OK on the PC launches it on the PC', async () => {
  const app = await openWithPc(0);
  const { page } = app;
  try {
    await page.evaluate(() => localStorage.setItem('lastOpenedApp_HOST1', '105'));
    await selectPcCard(page);
    await page.evaluate(() => {
      window.__pcOkAt = performance.now();
    });
    await remoteKey(page, OK);
    await appListShown(page);
    await page.waitForFunction(() => performance.now() - window.__pcOkAt >= 700, null, { timeout: 3000 });
    await remoteKey(page, OK);
    await page.waitForFunction(() => isInGame === true && window.__sunshine.starts.length === 1, null, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => window.__sunshine.http.filter((request) => request.indexOf('/launch') === 0)), ['/launch 105']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
