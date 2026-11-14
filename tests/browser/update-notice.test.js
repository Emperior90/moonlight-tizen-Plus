'use strict';

// Checks the notices of the automatic update check (checkForAppUpdatesAtStartup() in wasm/platform/index.js), which
// runs 10 seconds after the start at most once every 24 hours and otherwise uses the version it found last: the notice
// "Version X is now available!" shows only on the first start that sees a newer version, never during a stream (where
// it would cover the game, e.g. after a start from a Smart Hub tile), and a notice that a stream left out shows at a
// later start. The Update button in the header of the hosts shows every time. A failed automatic check is only logged.
// The GitHub request is replaced by one that answers what the test sets.
// The check of the settings (About > Check for updates, checkForAppUpdates() and offerAppUpdate()) answers after the
// user may have moved on: its Update dialog opens neither over a running stream nor over another dialog (a message
// names the version there), the update button of the PC list offers it later, and a second OK on Check for updates
// neither asks GitHub again nor opens the dialog twice. These tests drive the app with the keys of the remote.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, openApp, readStorage, startHarness } = require('./harness');
const { key, menuState, openMenus, openSettingsSection, selectItem, takeSnackbars } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const NOTICE = 'Version %1$s is now available! Check out the latest features & improvements.';

// Replace the GitHub request by one that answers the given version, or fails for null, and record the snackbars
const answerReleases = (page, latestVersion) => page.evaluate((version) => {
  window.__messages = window.__messages || [];
  document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__messages.push(data.message);
  fetchLatestRelease = () => (version ? Promise.resolve({ latestVersion: version, releaseNotes: '' }) : Promise.reject(new Error('offline')));
}, latestVersion);

// Run the check of a start, as a start more than 24 hours after the last check (due) or within them (cached), and
// return the snackbar messages that it showed
const checkAtStart = (page, due) => page.evaluate(async (isDue) => {
  await new Promise((resolve) => storeData('lastUpdateCheck', isDue ? 0 : Date.now(), resolve));
  window.__messages = [];
  checkForAppUpdatesAtStartup();
  await new Promise((resolve) => setTimeout(resolve, 600));
  return window.__messages.slice();
}, due);

const updateButtonShown = (page) => page.evaluate(() => $('#updateAppBtn').length === 1);

test('the notice of a newer version shows once, on the first start that sees it, and again for the next version', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await answerReleases(app.page, '99.0.0');
    const notice = (version) => NOTICE.replace('%1$s', version);
    // The check that finds the new version shows the notice and the button
    assert.deepEqual(await checkAtStart(app.page, true), [notice('99.0.0')]);
    assert.equal(await updateButtonShown(app.page), true);
    let stored = await readStorage(app.page);
    assert.deepEqual([stored.latestUpdateVersion, stored.updateNoticeVersion], ['99.0.0', '99.0.0']);
    // The next starts, from the found version or from a new check that finds it again, show no notice
    assert.deepEqual(await checkAtStart(app.page, false), []);
    assert.deepEqual(await checkAtStart(app.page, true), []);
    assert.equal(await updateButtonShown(app.page), true, 'the button stays the hint');
    // A newer version gets its notice
    await answerReleases(app.page, '99.1.0');
    assert.deepEqual(await checkAtStart(app.page, true), [notice('99.1.0')]);
    assert.deepEqual(await checkAtStart(app.page, false), []);
    stored = await readStorage(app.page);
    assert.equal(stored.updateNoticeVersion, '99.1.0');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('no notice during a stream, and the one it left out shows at a later start', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await answerReleases(app.page, '99.0.0');
    await app.page.evaluate(() => {
      isInGame = true;
    });
    assert.deepEqual(await checkAtStart(app.page, true), []);
    assert.equal((await readStorage(app.page)).updateNoticeVersion, undefined, 'not counted as shown');
    assert.ok(app.logs.some((line) => line.indexOf('Not showing the notice of version 99.0.0 during a stream.') >= 0));
    await app.page.evaluate(() => {
      isInGame = false;
    });
    // The next start uses the version found during the stream
    assert.deepEqual(await checkAtStart(app.page, false), [NOTICE.replace('%1$s', '99.0.0')]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a failed automatic check is only logged, and an up-to-date app shows nothing', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await answerReleases(app.page, null);
    assert.deepEqual(await checkAtStart(app.page, true), []);
    assert.ok(app.logs.some((line) => line.indexOf('Error: Failed to fetch the release data!') >= 0));
    // The version of the app itself is no update
    const version = await app.page.evaluate(() => appInfo.version);
    await answerReleases(app.page, version);
    assert.deepEqual(await checkAtStart(app.page, true), []);
    assert.equal(await updateButtonShown(app.page), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// Replace the GitHub request by one that answers version 99.0.0 once the test calls window.__answerRelease(), which
// answers every request that waits, and counts the requests
const holdReleaseAnswer = (page) => page.evaluate(() => {
  window.__fetches = 0;
  const waiting = [];
  window.__answerRelease = () => waiting.splice(0).forEach((resolve) => resolve({ latestVersion: '99.0.0', releaseNotes: 'notes' }));
  fetchLatestRelease = () => {
    window.__fetches++;
    return new Promise((resolve) => waiting.push(resolve));
  };
});

// An install that checked for updates within the last 24 hours, so that the automatic check, 10 seconds after the
// start, asks nothing while a test runs
const checkedToday = () => ({ lastUpdateCheck: Date.now() });

// Settings > About > Check for updates, OK
async function pressCheckForUpdates(page) {
  await openSettingsSection(page, 'aboutSettings');
  await selectItem(page, 'AboutSettings', 'checkUpdatesBtn', 'up', 'down');
  await key(page, 'ok', 200);
}

// checkForAppUpdates() handles the answer of GitHub 1.5 seconds after it came
const ANSWER_HANDLED_MS = 1900;

test('the answer of Check for updates opens no dialog over a running stream, and the update button offers it afterwards', async () => {
  const app = await openMenus(harness, { moduleScripts: ['sunshine-host.js'], stored: Object.assign({ hosts: SUNSHINE_HOSTS }, checkedToday()) });
  const { page } = app;
  try {
    await page.waitForFunction(() => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true, null, { timeout: 10000 });
    await holdReleaseAnswer(page);
    await pressCheckForUpdates(page);
    // GitHub takes its time: back to the PC list, open the PC and start an app
    await key(page, 'back', 300);
    await key(page, 'back', 400);
    await key(page, 'down', 200);
    await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
    await key(page, 'ok', 0);
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length > 0 &&
      !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    // An OK within 600 ms of the one on the PC counts as the same press
    await page.waitForTimeout(700);
    await key(page, 'ok', 0);
    await page.waitForFunction(() => isInGame === true && window.__sunshine.starts.length === 1 && $('#loadingSpinner').css('display') === 'none', null, { timeout: 5000 });
    await takeSnackbars(page);
    // The answer comes during the stream: no dialog and no message over the game, which keeps its keys
    await page.evaluate(() => window.__answerRelease());
    await page.waitForTimeout(ANSWER_HANDLED_MS);
    let state = await menuState(page);
    assert.deepEqual([state.openDialogs, state.dialogs], [[], []]);
    assert.notEqual(state.view, 'UpdateMoonlightDialog');
    assert.deepEqual(await takeSnackbars(page), []);
    assert.equal(await page.evaluate(() => isInGame), true);
    assert.ok(app.logs.some((line) => line.indexOf('Not showing the update dialog of version 99.0.0 during a stream.') >= 0));
    // RED stops the stream. Back on the PC list, the header has the update button, and OK on it opens the dialog
    await key(page, 'red', 0);
    await page.waitForFunction(() => isInGame === false && document.body.getAttribute('data-view') === 'apps' && !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    await page.waitForTimeout(500);
    await key(page, 'back', 600);
    assert.equal((await menuState(page)).view, 'Hosts');
    assert.equal(await updateButtonShown(page), true);
    await key(page, 'up', 200);
    await key(page, 'up', 200);
    await selectItem(page, 'HostsNav', 'updateAppBtn', 'left', 'right');
    await key(page, 'ok', 200);
    await page.evaluate(() => window.__answerRelease());
    await page.waitForFunction(() => document.getElementById('updateAppDialog').open, null, { timeout: 5000 });
    await page.waitForTimeout(200);
    state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs, state.focused], ['UpdateMoonlightDialog', ['updateAppDialog'], 'closeUpdateApp']);
    assert.ok((await page.evaluate(() => $('#updateAppDialogText').text())).indexOf('Version 99.0.0 is now available!') === 0);
    await key(page, 'ok', 400);
    assert.equal((await menuState(page)).view, 'HostsNav');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the answer of Check for updates over another dialog is a message that names the version, not a second dialog', async () => {
  const app = await openMenus(harness, { stored: checkedToday() });
  const { page } = app;
  try {
    await holdReleaseAnswer(page);
    await pressCheckForUpdates(page);
    // Back to the PC list and into the Add PC dialog, where the answer comes
    await key(page, 'back', 300);
    await key(page, 'back', 400);
    await key(page, 'down', 200);
    await key(page, 'ok', 500);
    assert.equal((await menuState(page)).view, 'AddHostDialog');
    await takeSnackbars(page);
    await page.evaluate(() => window.__answerRelease());
    await page.waitForTimeout(ANSWER_HANDLED_MS);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs], ['AddHostDialog', ['addHostDialog']]);
    assert.deepEqual(await takeSnackbars(page), [NOTICE.replace('%1$s', '99.0.0')]);
    assert.equal(await page.evaluate(() => $('#updateAppBtn').length), 1);
    // The Add PC dialog keeps its keys: RIGHT moves in it, RETURN closes it
    await key(page, 'right', 150);
    assert.equal((await menuState(page)).view, 'AddHostDialog');
    await key(page, 'back', 400);
    state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs], ['Hosts', []]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK twice on Check for updates asks GitHub once and opens one Update dialog, which one OK closes', async () => {
  const app = await openMenus(harness, { stored: checkedToday() });
  const { page } = app;
  try {
    await holdReleaseAnswer(page);
    await openSettingsSection(page, 'aboutSettings');
    await selectItem(page, 'AboutSettings', 'checkUpdatesBtn', 'up', 'down');
    await takeSnackbars(page);
    await key(page, 'ok', 100);
    await key(page, 'ok', 200);
    assert.equal(await page.evaluate(() => window.__fetches), 1);
    assert.deepEqual(await takeSnackbars(page), ['Checking for available Moonlight updates...']);
    await page.evaluate(() => window.__answerRelease());
    await page.waitForFunction(() => document.getElementById('updateAppDialog').open, null, { timeout: 5000 });
    await page.waitForTimeout(300);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs], ['UpdateMoonlightDialog', ['updateAppDialog']]);
    // One OK closes the dialog, and the keys move in the section again: a second view of the dialog used to take the
    // next key
    await key(page, 'ok', 400);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.openDialogs], ['AboutSettings', 'checkUpdatesBtn', []]);
    await key(page, 'up', 200);
    state = await menuState(page);
    assert.equal(state.view, 'AboutSettings');
    assert.notEqual(state.current, 'checkUpdatesBtn');
    await key(page, 'down', 200);
    assert.equal((await menuState(page)).current, 'checkUpdatesBtn');
    // A later OK checks again
    await key(page, 'ok', 200);
    assert.equal(await page.evaluate(() => window.__fetches), 2);
    await page.evaluate(() => window.__answerRelease());
    await page.waitForFunction(() => document.getElementById('updateAppDialog').open, null, { timeout: 5000 });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
