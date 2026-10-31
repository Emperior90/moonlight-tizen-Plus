'use strict';

// Checks the notices of the automatic update check (checkForAppUpdatesAtStartup() in wasm/platform/index.js), which
// runs 10 seconds after the start at most once every 24 hours and otherwise uses the version it found last: the notice
// "Version X is now available!" shows only on the first start that sees a newer version, never during a stream (where
// it would cover the game, e.g. after a start from a Smart Hub tile), and a notice that a stream left out shows at a
// later start. The Update button in the header of the hosts shows every time. A failed automatic check is only logged.
// The GitHub request is replaced by one that answers what the test sets.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness } = require('./harness');

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
