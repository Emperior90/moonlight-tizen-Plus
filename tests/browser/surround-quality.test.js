'use strict';

// Checks the setting 'Surround audio quality' of the Audio Settings (wasm/index.html, index.js, navigation.js) in the
// real page: its row and its place in the navigation show only while the audio configuration is 5.1 or 7.1 and the
// media player of the TV plays it (not with the Web Audio backend, which plays stereo, and not with the audio output
// disabled); its menu stores High or Efficient, which a restart loads (Efficient, the default since 2.3.1, for a value
// the settings don't know and for an install that never stored one); its button follows the language; and every start
// request carries it as its last argument, which the module applies to 5.1 and 7.1 only
// (tests/native/sdp_audio_quality_test.c). What an update from 2.3.0 does with the default, Restore Defaults and the
// optimal settings button are checked by surround-quality-default.test.js, the Web Audio backend by
// web-audio-stereo.test.js, the Stream Menu entry by stream-menu-entries.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, reloadApp, startHarness, waitForStorage } = require('./harness');

const TV = { tv: 's90c', conn: 'wifi' };

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Whether the row shows in the Audio Settings, and the controls that UP and DOWN move through there
const audioSettings = (page) => page.evaluate(() => {
  handleSettingsView('audioSettings');
  return { row: $('#surroundQualityOption').is(':visible'), items: Views.AudioSettings.view.func(),
    value: $('#selectSurroundQuality').data('value'), label: $('#selectSurroundQuality').text().trim() };
});

// Choose an entry of a menu of the settings, as a click on it does
const choose = (page, menu, value) => page.evaluate(({ menuClass, itemValue }) => {
  $('.' + menuClass + ' li').filter(function() {
    return $(this).data('value') === itemValue;
  }).click();
}, { menuClass: menu, itemValue: value });

async function openSettings(page) {
  await page.evaluate(() => showSettings());
  await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
}

// Start a stream of app 7 with a host that answers the launch at once, and return the arguments of the start request
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
  // The stream connects before it ends, which releases its start on the host, so the next start doesn't wait
  // (held-host-start.test.js)
  handleMessage('Connection Established');
  handleMessage('streamTerminated: 0');
  return args;
});

test('the row shows only with 5.1 and 7.1 and the media player of the TV, right below the audio configuration', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await openSettings(app.page);
    // Stereo, the default
    assert.deepEqual(await audioSettings(app.page), { row: false, items: ['selectAudioBackend', 'selectAudio', 'audioSyncBtn', 'playHostAudioBtn'],
      value: 'Efficient', label: 'Efficient' });
    for (const config of ['51Surround', '71Surround']) {
      await choose(app.page, 'audioConfigMenu', config);
      assert.deepEqual(await audioSettings(app.page), { row: true,
        items: ['selectAudioBackend', 'selectAudio', 'selectSurroundQuality', 'audioSyncBtn', 'playHostAudioBtn'],
        value: 'Efficient', label: 'Efficient' }, config);
    }
    // The Web Audio backend plays stereo, so it hides the row with the audio configuration, and so does no audio output
    await choose(app.page, 'audioBackendMenu', 'WebAudio');
    assert.deepEqual(await audioSettings(app.page), { row: false,
      items: ['selectAudioBackend', 'selectAudioJitter', 'audioClockSyncBtn', 'playHostAudioBtn'], value: 'Efficient', label: 'Efficient' });
    await choose(app.page, 'audioBackendMenu', 'Disabled');
    assert.deepEqual(await audioSettings(app.page), { row: false, items: ['selectAudioBackend', 'playHostAudioBtn'],
      value: 'Efficient', label: 'Efficient' });
    await choose(app.page, 'audioBackendMenu', 'EMSS');
    assert.equal((await audioSettings(app.page)).row, true);
    await choose(app.page, 'audioConfigMenu', 'Stereo');
    assert.equal((await audioSettings(app.page)).row, false);
    // A fresh install stores nothing for it
    assert.equal(Object.prototype.hasOwnProperty.call(await readStorage(app.page), 'surroundQuality'), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a chosen quality is stored, loads after a restart, follows the language and goes to the module with every start', async () => {
  const app = await openApp(harness, { tv: TV, stored: { audioConfig: '51Surround' } });
  try {
    await openSettings(app.page);
    assert.equal((await startRequest(app.page)).slice(-1)[0], 'Efficient', 'Efficient for an install that never stored the setting');
    await app.page.evaluate(() => {
      handleSettingsView('audioSettings');
      document.getElementById('selectSurroundQuality').click();
    });
    // OK opens its menu, whose entries UP and DOWN move through
    await app.page.waitForFunction(() => Views.SelectSurroundQualityMenu.isActive(), null, { timeout: 2000 });
    assert.deepEqual(await app.page.evaluate(() => Array.prototype.map.call(Views.SelectSurroundQualityMenu.view.func(),
      (item) => item.getAttribute('data-value'))), ['High', 'Efficient']);
    await choose(app.page, 'surroundQualityMenu', 'High');
    await waitForStorage(app.page, (values) => values.surroundQuality === 'High');
    assert.equal((await audioSettings(app.page)).label, 'High');
    const args = await startRequest(app.page);
    assert.equal(args.length, 33);
    assert.deepEqual([args[18], args[32]], ['51Surround', 'High']);
    assert.ok(app.logs.some((line) => line.indexOf('Surround audio quality: High') >= 0));

    // A restart loads it, and German names it
    await reloadApp(app);
    await app.page.evaluate((locale) => i18n.setLanguage(locale), 'de-DE');
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE');
    await openSettings(app.page);
    assert.deepEqual(await audioSettings(app.page), { row: true,
      items: ['selectAudioBackend', 'selectAudio', 'selectSurroundQuality', 'audioSyncBtn', 'playHostAudioBtn'], value: 'High', label: 'Hoch' });
    assert.equal((await startRequest(app.page)).slice(-1)[0], 'High');
    // Efficient from the menu is stored like High, not left to the default
    await choose(app.page, 'surroundQualityMenu', 'Efficient');
    await waitForStorage(app.page, (values) => values.surroundQuality === 'Efficient');
    await reloadApp(app);
    await app.page.evaluate((locale) => i18n.setLanguage(locale), 'de-DE');
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE');
    await openSettings(app.page);
    assert.deepEqual(await audioSettings(app.page), { row: true,
      items: ['selectAudioBackend', 'selectAudio', 'selectSurroundQuality', 'audioSyncBtn', 'playHostAudioBtn'], value: 'Efficient', label: 'Sparsam' });
    assert.equal((await startRequest(app.page)).slice(-1)[0], 'Efficient');
    // Stereo keeps the setting for later and sends it as it is: the module never applies it to stereo
    await choose(app.page, 'audioConfigMenu', 'Stereo');
    assert.equal((await audioSettings(app.page)).row, false);
    assert.deepEqual((await startRequest(app.page)).slice(-1), ['Efficient']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stored value the settings don\'t know counts as Efficient, the default', async () => {
  const app = await openApp(harness, { tv: TV, stored: { audioConfig: '71Surround', surroundQuality: 'Ultra' } });
  try {
    await openSettings(app.page);
    assert.deepEqual(await audioSettings(app.page), { row: true,
      items: ['selectAudioBackend', 'selectAudio', 'selectSurroundQuality', 'audioSyncBtn', 'playHostAudioBtn'], value: 'Efficient', label: 'Efficient' });
    assert.equal((await startRequest(app.page)).slice(-1)[0], 'Efficient');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
