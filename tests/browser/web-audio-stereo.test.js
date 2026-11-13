'use strict';

// Checks that the Web Audio backend always streams stereo, in the real page (getStreamAudioConfig() in index.js). That
// backend hands the decoded channels to an output of the browser that stays at two channels, where a 7.1 stream played
// only front left and right and 5.1 was mixed down without headroom, so:
// - with Web Audio, the launch and resume requests ask the host for stereo and the start request carries Stereo to the
//   module, whatever audio configuration is stored (5.1 or 7.1), while the stored configuration stays as it is; with the
//   media player of the TV both carry the stored configuration, and choosing it again restores surround;
// - the Audio Settings show neither the audio configuration nor the surround audio quality with Web Audio, in the rows
//   and in the navigation, and a line below the audio backend says why, in the language of the app;
// - the Stream Menu offers no surround quality entry for a Web Audio stream, since it is stereo.
// The layout of the line in every language is checked by theme-settings.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness, waitForStorage } = require('./harness');

const TV = { tv: 's90c', conn: 'wifi' };
// The surroundAudioInfo of the launch and resume requests (SURROUND_AUDIO_INFO in index.js): the channel mask << 16 |
// the channel count, as MAKE_AUDIO_CONFIGURATION() of moonlight-common-c builds them
const AUDIO_INFO = { Stereo: 0x030002, '51Surround': 0x3F0006, '71Surround': 0x63F0008 };
const NOTE = 'Web Audio always plays stereo, so Audio configuration and Surround audio quality are not available.';

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
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

// Start a stream of app 7 with a host that answers at once, launching it or, with `resume`, resuming it while it runs,
// and return what the host was asked for (the surroundAudioInfo of the request) and the audio backend and audio
// configuration of the start request
const startStream = (page, resume) => page.evaluate(async (running) => {
  const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
  const result = { request: null, audioInfo: null };
  const host = {
    paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989,
    currentGame: running ? 7 : 0, appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
    refreshServerInfo: () => Promise.resolve(), getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
    // launchApp(appId, mode, sops, rikey, rikeyid, hdrMode, localAudio, surroundAudioInfo, ...) and resumeApp() without
    // the app ID (NvHTTP in utils.js)
    launchApp: function() {
      result.request = 'launch';
      result.audioInfo = arguments[7];
      return Promise.resolve(ok);
    },
    resumeApp: function() {
      result.request = 'resume';
      result.audioInfo = arguments[6];
      return Promise.resolve(ok);
    },
    toString: () => 'GAMING-PC',
  };
  showApps = () => Promise.resolve();
  window.__startStreamArgs = null;
  startGame(host, 7);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const args = window.__startStreamArgs;
  result.backend = args && args[17];
  result.audioConfig = args && args[18];
  result.channels = Module.getAudioChannelCount();
  // The stream connects before it ends, which releases its start on the host, so the next start doesn't wait
  // (held-host-start.test.js)
  handleMessage('Connection Established');
  handleMessage('streamTerminated: 0');
  return result;
}, !!resume);

test('with Web Audio the launch, resume and start requests ask for stereo for a stored 5.1 and 7.1, and for surround with the TV media player', async () => {
  for (const config of ['51Surround', '71Surround']) {
    const app = await openApp(harness, { tv: TV, stored: { audioBackend: 'WebAudio', audioConfig: config, surroundQuality: 'High' } });
    try {
      await openSettings(app.page);
      // Web Audio: stereo to the host and to the module, launching and resuming
      assert.deepEqual(await startStream(app.page, false),
        { request: 'launch', audioInfo: AUDIO_INFO.Stereo, backend: 'WebAudio', audioConfig: 'Stereo', channels: 2 }, config);
      assert.deepEqual(await startStream(app.page, true),
        { request: 'resume', audioInfo: AUDIO_INFO.Stereo, backend: 'WebAudio', audioConfig: 'Stereo', channels: 2 }, config);
      // The log of the start names both, and the stored configuration is untouched
      assert.ok(app.logs.some((line) => line.indexOf('Audio configuration: Stereo (the Web Audio backend plays stereo; the setting is ' + config + ')') >= 0));
      assert.equal((await readStorage(app.page)).audioConfig, config);
      assert.equal(await app.page.evaluate(() => $('#selectAudio').data('value')), config);

      // The media player of the TV plays the stored configuration again, launching and resuming
      await choose(app.page, 'audioBackendMenu', 'EMSS');
      await waitForStorage(app.page, (values) => values.audioBackend === 'EMSS');
      assert.deepEqual(await startStream(app.page, false),
        { request: 'launch', audioInfo: AUDIO_INFO[config], backend: 'EMSS', audioConfig: config, channels: config === '51Surround' ? 6 : 8 }, config);
      assert.deepEqual(await startStream(app.page, true),
        { request: 'resume', audioInfo: AUDIO_INFO[config], backend: 'EMSS', audioConfig: config, channels: config === '51Surround' ? 6 : 8 }, config);
      assert.ok(app.logs.some((line) => /Audio configuration: (51|71)Surround\s*\n/.test(line)), 'no remark for the TV media player');

      // And back: Web Audio is stereo again, after a restart as well
      await choose(app.page, 'audioBackendMenu', 'WebAudio');
      await waitForStorage(app.page, (values) => values.audioBackend === 'WebAudio');
      assert.equal((await startStream(app.page, false)).audioConfig, 'Stereo');
      assert.equal((await readStorage(app.page)).audioConfig, config);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('a stored stereo stays stereo with both backends, and no audio output keeps what is stored', async () => {
  const app = await openApp(harness, { tv: TV, stored: { audioBackend: 'WebAudio', audioConfig: 'Stereo' } });
  try {
    await openSettings(app.page);
    assert.deepEqual(await startStream(app.page, false),
      { request: 'launch', audioInfo: AUDIO_INFO.Stereo, backend: 'WebAudio', audioConfig: 'Stereo', channels: 2 });
    assert.equal(app.logs.some((line) => line.indexOf('the Web Audio backend plays stereo; the setting is') >= 0), false);
    await choose(app.page, 'audioBackendMenu', 'EMSS');
    assert.equal((await startStream(app.page, false)).audioConfig, 'Stereo');
    // A disabled audio output discards the stream, which stays as the settings ask for it
    await choose(app.page, 'audioConfigMenu', '51Surround');
    await choose(app.page, 'audioBackendMenu', 'Disabled');
    assert.deepEqual(await startStream(app.page, false),
      { request: 'launch', audioInfo: AUDIO_INFO['51Surround'], backend: 'Disabled', audioConfig: '51Surround', channels: 0 });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// The rows of the Audio Settings that show, the controls that UP and DOWN move through, and the line about Web Audio
const audioSettings = (page) => page.evaluate(() => {
  handleSettingsView('audioSettings');
  const note = document.getElementById('webAudioStereoNote');
  return { audioConfig: $('#audioConfigOption').is(':visible'), surroundQuality: $('#surroundQualityOption').is(':visible'),
    note: $(note).is(':visible') ? note.textContent.trim().replace(/^- /, '') : null, items: Views.AudioSettings.view.func() };
});

test('with Web Audio the settings show no audio configuration and no surround audio quality, and a line says why', async () => {
  const app = await openApp(harness, { tv: TV, stored: { audioConfig: '71Surround' } });
  try {
    await openSettings(app.page);
    // The media player of the TV, the default: both settings, no line
    assert.deepEqual(await audioSettings(app.page), { audioConfig: true, surroundQuality: true, note: null,
      items: ['selectAudioBackend', 'selectAudio', 'selectSurroundQuality', 'audioSyncBtn', 'playHostAudioBtn'] });
    await choose(app.page, 'audioBackendMenu', 'WebAudio');
    assert.deepEqual(await audioSettings(app.page), { audioConfig: false, surroundQuality: false, note: NOTE,
      items: ['selectAudioBackend', 'selectAudioJitter', 'audioClockSyncBtn', 'playHostAudioBtn'] });
    // The line belongs to the row of the audio backend, below its help text
    assert.equal(await app.page.evaluate(() => {
      const note = document.getElementById('webAudioStereoNote');
      const help = note.parentElement.querySelector('.mdl-list__item-text-body');
      return note.parentElement === document.getElementById('selectAudioBackend').closest('.setting-option') && help !== note &&
        note.getBoundingClientRect().top >= help.getBoundingClientRect().bottom;
    }), true);
    // The line doesn't get in the way of the menu of the row: the keys still find its options (by their position in the
    // row, SelectAudioBackendMenu in navigation.js)
    assert.deepEqual(await app.page.evaluate(() => Array.prototype.map.call(Views.SelectAudioBackendMenu.view.func(),
      (item) => item.getAttribute('data-value'))), ['EMSS', 'WebAudio', 'Disabled']);
    // DOWN from the audio backend goes to the jitter buffer, the next setting that applies
    await app.page.evaluate(() => {
      Navigation.pop();
      Navigation.push(Views.AudioSettings);
      Views.AudioSettings.view.index = 0;
      Navigation.switch();
    });
    await app.page.keyboard.press('ArrowDown');
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'selectAudioJitter');

    // No audio output shows neither the settings nor the line, and the media player of the TV has both settings again,
    // with the stored 7.1
    await choose(app.page, 'audioBackendMenu', 'Disabled');
    assert.deepEqual(await audioSettings(app.page), { audioConfig: false, surroundQuality: false, note: null,
      items: ['selectAudioBackend', 'playHostAudioBtn'] });
    await choose(app.page, 'audioBackendMenu', 'EMSS');
    assert.deepEqual(await audioSettings(app.page), { audioConfig: true, surroundQuality: true, note: null,
      items: ['selectAudioBackend', 'selectAudio', 'selectSurroundQuality', 'audioSyncBtn', 'playHostAudioBtn'] });
    assert.equal(await app.page.evaluate(() => $('#selectAudio').data('value')), '71Surround');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('an install with Web Audio stored opens with the line, which follows the language', async () => {
  const app = await openApp(harness, { tv: TV, stored: { audioBackend: 'WebAudio', audioConfig: '51Surround' } });
  try {
    await openSettings(app.page);
    assert.deepEqual(await audioSettings(app.page), { audioConfig: false, surroundQuality: false, note: NOTE,
      items: ['selectAudioBackend', 'selectAudioJitter', 'audioClockSyncBtn', 'playHostAudioBtn'] });
    await app.page.evaluate((locale) => i18n.setLanguage(locale), 'de-DE');
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE');
    assert.equal((await audioSettings(app.page)).note,
      'Web Audio spielt immer Stereo, daher gibt es Audiokonfiguration und Surround-Tonqualität hier nicht.');
    // Restore Defaults goes back to the media player of the TV, without the line
    await app.page.evaluate(() => restoreDefaultsSettingsValues());
    assert.deepEqual(await audioSettings(app.page), { audioConfig: true, surroundQuality: false, note: null,
      items: ['selectAudioBackend', 'selectAudio', 'audioSyncBtn', 'playHostAudioBtn'] });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// A running stream of app 8 that reached 'Connection Established', and whether its Stream Menu offers the surround
// quality entry
const streamMenuSurround = (page) => page.evaluate(async () => {
  const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
  const host = {
    paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
    appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03, refreshServerInfo: () => Promise.resolve(),
    getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }), launchApp: () => Promise.resolve(ok),
    toString: () => 'GAMING-PC',
  };
  api = host;
  showApps = () => Promise.resolve();
  startGame(host, 8);
  await new Promise((resolve) => setTimeout(resolve, 300));
  handleMessage('Connection Established');
  openStreamMenu();
  const result = { open: isStreamMenuOpen, channels: Module.getAudioChannelCount(),
    surround: !document.getElementById('streamMenuSurround').hidden,
    entries: getOverlayMenuItems('streamMenu').map((item) => item.id) };
  closeStreamMenu(true);
  handleMessage('streamTerminated: 0');
  await new Promise((resolve) => setTimeout(resolve, 100));
  return result;
});

test('the Stream Menu offers no surround quality for a Web Audio stream, and offers it with the TV media player', async () => {
  const app = await openApp(harness, { tv: TV, stored: { audioBackend: 'WebAudio', audioConfig: '51Surround' } });
  try {
    await openSettings(app.page);
    const webAudio = await streamMenuSurround(app.page);
    assert.deepEqual([webAudio.open, webAudio.channels, webAudio.surround], [true, 2, false]);
    assert.equal(webAudio.entries.indexOf('streamMenuSurround'), -1);
    assert.ok(webAudio.entries.indexOf('streamMenuBitrate') >= 0);
    await choose(app.page, 'audioBackendMenu', 'EMSS');
    const emss = await streamMenuSurround(app.page);
    assert.deepEqual([emss.open, emss.channels, emss.surround], [true, 6, true]);
    assert.ok(emss.entries.indexOf('streamMenuSurround') >= 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
