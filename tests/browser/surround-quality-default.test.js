'use strict';

// Checks the default of 'Surround audio quality' since 2.3.1 (settings schema 5) across an update, in the real page:
// Efficient instead of the High of 2.3.0 (DEFAULT_SURROUND_QUALITY and needsSurroundQualityNotice() in tv_profile.js,
// migrateSettingsSchema() and showSurroundQualityNotice() in index.js).
// - 2.3.0 stored the quality only once it was chosen. An install that never chose one gets Efficient, with nothing
//   stored for it, and when it streams 5.1 or 7.1 with the media player of the TV it is told once, when the hosts show:
//   what changed and where to change it back. The next start doesn't tell again.
// - A stored quality stays, High as well as Efficient, without a notice. Restore Defaults of 2.3.0 stored High too, which
//   can't be told from a choice, so it stays as well.
// - No notice for a fresh install, for stereo, for the Web Audio backend (it plays stereo) and for a disabled audio
//   output: their sound doesn't change. They get Efficient once they choose 5.1.
// - The notice waits for a later start when another dialog shows (the compatibility warning of the Ultra low latency
//   mode goes first), and it is dropped when the settings no longer stream surround in the default quality by then.
// - Restore Defaults and the optimal settings button set Efficient, and the optimal settings dialog names it.
// - The other steps of the settings schema still run for the installs they are for, and only for those: an install of
//   2.3.0 that never touched 'Optimize game settings' keeps it on.
// - The notice fits the screen in every language, also with 10 % wider text.
// The rules are checked by tests/unit/tv-profile.test.js, the setting itself by surround-quality.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, reloadApp, restartAppOn, startHarness, waitForStorage } = require('./harness');
const { forEachTextWidth } = require('./text-stress');

const TV = { tv: 's90c', conn: 'wifi' };
const NOTICE_TITLE = 'Surround audio quality';
const NOTICE_KEY = 'surroundQualityNotice';
const NOTICE_LOG = 'Showing the notice about the default of the surround audio quality.';
// What every existing install has stored, and the settings schema that 2.3.0 stored with it
const EXISTING_INSTALL = { uniqueid: '0123456789abcdef', cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' } };
const INSTALL_OF_230 = Object.assign({ settingsSchema: 4 }, EXISTING_INSTALL);

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Wait for the notice and return its text
async function waitForNotice(page) {
  await page.waitForFunction((title) => isDialogOpen && document.getElementById('warningDialogTitle').textContent === title,
    NOTICE_TITLE, { timeout: 4000 });
  return page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
}

// Give the start the time that the notice would take (it shows 700 ms after the hosts), and say whether a dialog shows
async function dialogShows(page) {
  await page.waitForTimeout(1700);
  return page.evaluate(() => (isDialogOpen ? document.getElementById('warningDialogTitle').textContent : false));
}

async function closeDialog(page) {
  await page.evaluate(() => $('#closeWarning').trigger('click'));
  await page.waitForFunction(() => !isDialogOpen, null, { timeout: 2000 });
}

async function openSettings(page) {
  await page.evaluate(() => showSettings());
  await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
}

// The surround audio quality as the Audio Settings show it, and whether its row shows
const surroundQuality = (page) => page.evaluate(() => {
  handleSettingsView('audioSettings');
  return { row: $('#surroundQualityOption').is(':visible'), value: $('#selectSurroundQuality').data('value'),
    label: $('#selectSurroundQuality').text().trim() };
});

// Choose an entry of a menu of the settings, as a click on it does
const choose = (page, menu, value) => page.evaluate(({ menuClass, itemValue }) => {
  $('.' + menuClass + ' li').filter(function() {
    return $(this).data('value') === itemValue;
  }).click();
}, { menuClass: menu, itemValue: value });

// Start a stream of app 7 with a host that answers the launch at once, and return the audio configuration and the
// surround audio quality of the start request
const startRequest = (page) => page.evaluate(async () => {
  const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
  const host = {
    paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
    appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03, refreshServerInfo: () => Promise.resolve(),
    getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }), launchApp: () => Promise.resolve(ok),
    toString: () => 'GAMING-PC',
  };
  showApps = () => Promise.resolve();
  window.__startStreamArgs = null;
  startGame(host, 7);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const args = window.__startStreamArgs;
  handleMessage('Connection Established');
  handleMessage('streamTerminated: 0');
  return [args[18], args[32]];
});

test('an install of 2.3.0 that streams 5.1 or 7.1 and never chose a quality gets Efficient and is told once', async () => {
  for (const config of ['51Surround', '71Surround']) {
    const app = await openApp(harness, { tv: TV, stored: Object.assign({ audioConfig: config }, INSTALL_OF_230) });
    try {
      const { page } = app;
      const text = await waitForNotice(page);
      // What changed, with its figures, and where to change it back
      assert.equal(text, 'Surround sound now streams in the quality <b>Efficient</b> unless you choose otherwise: 256 instead of 1536 kbps ' +
        'for 5.1 (450 instead of 2048 kbps for 7.1), which lowers the load on the TV. For 5.1, High takes about twice the decoding ' +
        'time (measured on a PC). For music, High or Stereo (512 kbps) can sound better.<br><br>To get the earlier quality back, set <b>Surround audio quality</b> to <b>High</b> in the Audio Settings, or ' +
        '<b>Surround quality</b> in the Stream Menu during a stream.');
      // It is one warning dialog with a single button, which only informs
      assert.equal(await page.evaluate(() => $('#continueWarning').is(':visible')), false);
      const stored = await waitForStorage(page, (values) => values.settingsSchema === 5 && !(NOTICE_KEY in values));
      // Nothing is stored for the quality, which follows the default, and the steps of the earlier settings schemas don't
      // run again: 'Optimize game settings' stays unset, so on
      assert.equal('surroundQuality' in stored, false);
      assert.equal('optimizeGames' in stored, false);
      assert.equal(stored.audioConfig, config);
      await closeDialog(page);
      await openSettings(page);
      assert.deepEqual(await surroundQuality(page), { row: true, value: 'Efficient', label: 'Efficient' });
      assert.deepEqual(await startRequest(page), [config, 'Efficient']);
      assert.equal(await page.evaluate(() => $('#optimizeGamesSwitch').parent().hasClass('is-checked')), true);

      // The next start doesn't tell again, and still streams Efficient
      await reloadApp(app);
      assert.equal(await dialogShows(page), false, 'shown once');
      assert.equal(app.logs.filter((line) => line.indexOf(NOTICE_LOG) >= 0).length, 1);
      await openSettings(page);
      assert.deepEqual(await startRequest(page), [config, 'Efficient']);
      // High from its menu stays from then on
      await choose(page, 'surroundQualityMenu', 'High');
      await waitForStorage(page, (values) => values.surroundQuality === 'High');
      await reloadApp(app);
      assert.equal(await dialogShows(page), false);
      await openSettings(page);
      assert.deepEqual(await startRequest(page), [config, 'High']);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('a quality that was chosen in 2.3.0 stays, High as well as Efficient, without a notice', async () => {
  // High is also what Restore Defaults of 2.3.0 stored, which can't be told from a choice
  for (const quality of ['High', 'Efficient']) {
    const app = await openApp(harness, { tv: TV, stored: Object.assign({ audioConfig: '51Surround', surroundQuality: quality }, INSTALL_OF_230) });
    try {
      const { page } = app;
      assert.equal(await dialogShows(page), false, quality);
      const stored = await waitForStorage(page, (values) => values.settingsSchema === 5);
      assert.equal(stored.surroundQuality, quality);
      assert.equal(NOTICE_KEY in stored, false);
      await openSettings(page);
      assert.deepEqual(await surroundQuality(page), { row: true, value: quality, label: quality });
      assert.deepEqual(await startRequest(page), ['51Surround', quality]);
      assert.equal(app.logs.some((line) => line.indexOf('storing the notice about it') >= 0), false);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('no notice where the sound doesn\'t change: a fresh install, stereo, Web Audio and no audio output, which get Efficient once 5.1 is chosen', async () => {
  const cases = [
    { name: 'fresh install with 5.1', stored: { audioConfig: '51Surround' } },
    { name: 'fresh install', stored: null },
    { name: 'stereo', stored: Object.assign({ audioConfig: 'Stereo' }, INSTALL_OF_230) },
    { name: 'no stored audio configuration', stored: INSTALL_OF_230 },
    { name: 'Web Audio with 7.1', stored: Object.assign({ audioConfig: '71Surround', audioBackend: 'WebAudio' }, INSTALL_OF_230) },
    { name: 'no audio output with 5.1', stored: Object.assign({ audioConfig: '51Surround', audioBackend: 'Disabled' }, INSTALL_OF_230) },
  ];
  for (const entry of cases) {
    const app = await openApp(harness, entry.stored ? { tv: TV, stored: entry.stored } : { tv: TV });
    try {
      const { page } = app;
      assert.equal(await dialogShows(page), false, entry.name);
      const stored = await waitForStorage(page, (values) => values.settingsSchema === 5);
      assert.equal(NOTICE_KEY in stored || 'surroundQuality' in stored, false, entry.name + ': ' + JSON.stringify(Object.keys(stored)));
      assert.equal(app.logs.some((line) => line.indexOf(NOTICE_LOG) >= 0), false, entry.name);
      // 5.1 with the media player of the TV streams Efficient, the default
      await openSettings(page);
      await choose(page, 'audioBackendMenu', 'EMSS');
      await choose(page, 'audioConfigMenu', '51Surround');
      assert.deepEqual(await surroundQuality(page), { row: true, value: 'Efficient', label: 'Efficient' }, entry.name);
      assert.deepEqual(await startRequest(page), ['51Surround', 'Efficient'], entry.name);
      // Not told at the next start either: the settings schema is the current one by then
      await reloadApp(app);
      assert.equal(await dialogShows(page), false, entry.name + ', next start');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('an install of 2.2 that streams 7.1 is told as well, and keeps the earlier defaults that its settings schema froze', async () => {
  const app = await openApp(harness, { tv: TV, stored: Object.assign({ settingsSchema: 3, audioConfig: '71Surround' }, EXISTING_INSTALL) });
  try {
    const { page } = app;
    assert.ok((await waitForNotice(page)).indexOf('Surround sound now streams in the quality <b>Efficient</b>') === 0);
    const stored = await waitForStorage(page, (values) => values.settingsSchema === 5 && !(NOTICE_KEY in values));
    // Settings schema 4 turned 'Optimize game settings' on for new installs only
    assert.equal(stored.optimizeGames, false);
    assert.equal('surroundQuality' in stored, false);
    await closeDialog(page);
    await openSettings(page);
    assert.deepEqual(await startRequest(page), ['71Surround', 'Efficient']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the notice waits for a later start behind the compatibility warning of the Ultra low latency mode', async () => {
  // A switch stored on on Tizen 8.0, on a TV that now runs Tizen 10.0, and 5.1 without a chosen quality: both wait
  const tizen10 = { tv: 'uhd', conn: 'wifi', tizen: '10.0' };
  const app = await openApp(harness, { tv: tizen10,
    stored: Object.assign({ audioConfig: '51Surround', gameMode: true, gameModePlatformVer: '8.0' }, INSTALL_OF_230) });
  try {
    const { page } = app;
    await page.waitForFunction(() => isDialogOpen, null, { timeout: 4000 });
    assert.equal(await page.evaluate(() => document.getElementById('warningDialogTitle').textContent), 'Compatibility Warning');
    // The notice didn't replace it, and stays stored
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => document.getElementById('warningDialogTitle').textContent), 'Compatibility Warning');
    assert.equal((await waitForStorage(page, (values) => values.settingsSchema === 5))[NOTICE_KEY], true);
    assert.ok(app.logs.some((line) => line.indexOf('Not showing the notice about the default of the surround audio quality over another dialog, so a later start shows it.') >= 0));
    await closeDialog(page);

    // The next start shows it, once
    await restartAppOn(harness, app, tizen10);
    assert.ok((await waitForNotice(page)).indexOf('Surround sound now streams in the quality <b>Efficient</b>') === 0);
    await waitForStorage(page, (values) => !(NOTICE_KEY in values));
    await closeDialog(page);
    await restartAppOn(harness, app, tizen10);
    assert.equal(await dialogShows(page), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a notice that waited is dropped when the settings no longer stream surround in the default quality', async () => {
  const waiting = Object.assign({ settingsSchema: 5, [NOTICE_KEY]: true }, EXISTING_INSTALL);
  const cases = [
    { name: 'still 5.1 without a chosen quality', stored: { audioConfig: '51Surround' }, shows: true },
    { name: 'High was chosen', stored: { audioConfig: '51Surround', surroundQuality: 'High' }, shows: false },
    { name: 'stereo was chosen', stored: { audioConfig: 'Stereo' }, shows: false },
    { name: 'Web Audio was chosen', stored: { audioConfig: '71Surround', audioBackend: 'WebAudio' }, shows: false },
    { name: 'the audio output was disabled', stored: { audioConfig: '71Surround', audioBackend: 'Disabled' }, shows: false },
  ];
  for (const entry of cases) {
    const app = await openApp(harness, { tv: TV, stored: Object.assign({}, waiting, entry.stored) });
    try {
      const { page } = app;
      if (entry.shows) {
        await waitForNotice(page);
        await closeDialog(page);
      } else {
        assert.equal(await dialogShows(page), false, entry.name);
      }
      // Either way the notice is done with
      const stored = await waitForStorage(page, (values) => !(NOTICE_KEY in values));
      assert.equal(stored.settingsSchema, 5, entry.name);
      assert.equal(app.logs.filter((line) => line.indexOf(NOTICE_LOG) >= 0).length, entry.shows ? 1 : 0, entry.name);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('Restore Defaults and the optimal settings button set Efficient, and the optimal settings dialog names it', async () => {
  const app = await openApp(harness, { tv: TV, stored: { audioConfig: '51Surround', surroundQuality: 'High' } });
  try {
    const { page } = app;
    await openSettings(page);
    assert.deepEqual(await surroundQuality(page), { row: true, value: 'High', label: 'High' });
    // The optimal settings dialog lists the quality among what Apply sets, and Cancel leaves it
    await page.evaluate(() => optimalSettingsDialog());
    await page.waitForFunction(() => isDialogOpen);
    assert.ok((await page.evaluate(() => document.getElementById('warningDialogText').innerHTML))
      .indexOf(', optimize game settings on, surround audio quality Efficient<br>') > 0);
    await page.evaluate(() => $('#closeWarning').trigger('click'));
    await page.waitForFunction(() => !isDialogOpen);
    assert.equal((await readStorage(page)).surroundQuality, 'High');
    // Apply sets and stores it
    await page.evaluate(() => optimalSettingsDialog());
    await page.waitForFunction(() => isDialogOpen);
    await page.evaluate(() => $('#continueWarning').trigger('click'));
    await waitForStorage(page, (values) => values.surroundQuality === 'Efficient');
    assert.deepEqual(await surroundQuality(page), { row: true, value: 'Efficient', label: 'Efficient' });
    assert.deepEqual(await startRequest(page), ['51Surround', 'Efficient']);

    // Restore Defaults: Efficient as well, stored, with the stereo that hides its row
    await choose(page, 'surroundQualityMenu', 'High');
    await waitForStorage(page, (values) => values.surroundQuality === 'High');
    await page.evaluate(() => restoreDefaultsSettingsValues());
    const stored = await waitForStorage(page, (values) => values.surroundQuality === 'Efficient' && values.audioConfig === 'Stereo');
    assert.equal(stored.audioBackend, 'EMSS');
    assert.deepEqual(await surroundQuality(page), { row: false, value: 'Efficient', label: 'Efficient' });
    await choose(page, 'audioConfigMenu', '71Surround');
    assert.deepEqual(await startRequest(page), ['71Surround', 'Efficient']);
    // German names the quality in the dialog as its menu does
    await page.evaluate((locale) => i18n.setLanguage(locale), 'de-DE');
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE');
    await page.evaluate(() => optimalSettingsDialog());
    await page.waitForFunction(() => isDialogOpen);
    assert.ok((await page.evaluate(() => document.getElementById('warningDialogText').innerHTML))
      .indexOf(', Spieleinstellungen optimieren an, Surround-Tonqualität Sparsam<br>') > 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the notice fits the screen in every language, also with 10 % wider text, and names the settings as the UI shows them', async () => {
  const LANGUAGES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
  // The names of the setting, its value High, the Audio Settings, the entry of the Stream Menu and the Stream Menu, as the
  // page shows them in each language
  const names = (page) => page.evaluate(() => ['Surround audio quality', 'High', 'Audio Settings', 'Surround quality', 'Stream Menu', 'Efficient']
    .map((key) => t(key)));
  for (const tv of ['s90c', 'fhd']) {
    const app = await openApp(harness, { tv: { tv, conn: 'wifi' }, stored: { audioConfig: '51Surround' } });
    try {
      const { page } = app;
      for (const language of LANGUAGES) {
        await page.evaluate((locale) => i18n.setLanguage(locale), language);
        await page.waitForFunction((locale) => document.documentElement.getAttribute('lang') === locale, language);
        await forEachTextWidth(page, async (stress) => {
          await page.evaluate(() => {
            isSurroundQualityNoticePending = true;
            showSurroundQualityNotice();
          });
          await page.waitForFunction(() => isDialogOpen, null, { timeout: 2000 });
          await page.waitForTimeout(300);
          const dialog = await page.evaluate(() => {
            const element = document.getElementById('warningDialog');
            const box = element.getBoundingClientRect();
            const content = element.querySelector('.mdl-dialog__content');
            const inside = (part) => {
              const rect = part.getBoundingClientRect();
              return rect.top >= box.top && rect.bottom <= box.bottom && rect.top >= 0 && rect.bottom <= window.innerHeight;
            };
            return { title: element.querySelector('.mdl-dialog__title').textContent, text: content.textContent,
              dialogScrolls: element.scrollHeight > element.clientHeight, textScrolls: content.scrollHeight > content.clientHeight,
              titleInside: inside(element.querySelector('.mdl-dialog__title')), buttonsInside: inside(element.querySelector('.mdl-dialog__actions')),
              bold: Array.prototype.map.call(content.querySelectorAll('b'), (b) => b.textContent) };
          });
          const where = tv + ' ' + language + stress + ' ' + JSON.stringify(dialog);
          assert.deepEqual([dialog.dialogScrolls, dialog.textScrolls, dialog.titleInside, dialog.buttonsInside], [false, false, true, true], where);
          const [setting, high, audioSettings, entry, streamMenu, efficient] = await names(page);
          assert.equal(dialog.title, setting, where);
          assert.deepEqual(dialog.bold, [efficient, setting, high, entry], where);
          assert.ok(dialog.text.indexOf(audioSettings) > 0 && dialog.text.indexOf(streamMenu) > 0, where);
          await closeDialog(page);
        });
      }
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});
