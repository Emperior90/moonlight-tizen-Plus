'use strict';

// The optimal streaming settings for each TV (plan WP2) on the settings screen, beyond the matrix of
// video-defaults.test.js: the bitrate of a fresh install follows the resolution and frame rate until the user picks one
// (plan D9), the button and Restore Defaults switch between keeping and following it, the button locks the higher
// frame rates on a TV without a tested profile without a stray notice, HDR follows what the TV reports (D8), an 8K TV,
// a TV whose product APIs fail still starts, and both reset a stored game mode on Tizen 5.5, which doesn't support it.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, readVideoSettings, reloadApp, startHarness, waitForStorage } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Count the log lines that contain the text
const count = (app, text) => app.logs.filter((line) => line.indexOf(text) >= 0).length;

// Pick a menu entry like a click does
function pickResolution(page, value) {
  return page.evaluate((resolution) => saveResolution.call($('.videoResolutionMenu li[data-value="' + resolution + '"]')[0]), value);
}
function pickFrameRate(page, value) {
  return page.evaluate((frameRate) => saveFramerate.call($('.videoFramerateMenu li[data-value="' + frameRate + '"]')[0]), String(value));
}

// Press the optimal streaming settings button and confirm the dialog
async function applyButton(page) {
  await page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
  await page.evaluate(() => $('#continueWarning').trigger('click'));
}

// Open the dialog of the optimal streaming settings button without confirming it
function applyButtonDialog(page) {
  return page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
}

// Read the title and text of the open dialog
function readDialog(page) {
  return page.evaluate(() => ({
    title: document.getElementById('warningDialogTitle').innerHTML,
    text: document.getElementById('warningDialogText').innerHTML,
  }));
}

// Press Restore Defaults and confirm it
async function restoreDefaults(page) {
  await page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
  await page.evaluate(() => $('#continueRestoreDefaults').trigger('click'));
}

test('lowering the resolution after a fresh install lowers the bitrate (plan D9)', async () => {
  const cases = [
    { tv: 'uhd', conn: 'wifi', start: ['3840:2160', '80'], pick: '1920:1080', bitrate: '20' },
    { tv: 'fhd', conn: 'ethernet', start: ['1920:1080', '25'], pick: '1280:720', bitrate: '10' },
    { tv: 's90c', conn: 'wifi', start: ['3840:2160', '100'], pick: '1920:1080', bitrate: '20' },
    { tv: 's90c', conn: 'ethernet', start: ['3840:2160', '75'], pick: '2560:1440', bitrate: '40' },
  ];
  for (const entry of cases) {
    const label = JSON.stringify(entry);
    const app = await openApp(harness, { tv: { tv: entry.tv, conn: entry.conn } });
    try {
      let shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.resolution, shown.bitrate, shown.autoAdjustBitrate], entry.start.concat([true]), label);
      await pickResolution(app.page, entry.pick);
      shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.resolution, shown.bitrate, shown.bitrateLabel], [entry.pick, entry.bitrate, entry.bitrate + ' Mbps'], label);
      const stored = await waitForStorage(app.page, (values) => values.resolution === entry.pick && values.bitrate === entry.bitrate);
      assert.equal(stored.autoAdjustBitrate, true, label);
      assert.equal(count(app, 'Keeping your bitrate of'), 0, label);
      assert.deepEqual(app.errors, [], label);
    } finally {
      await app.context.close();
    }
  }
});

test('lowering the frame rate after a fresh install lowers the bitrate', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' } });
  try {
    await pickFrameRate(app.page, 30);
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.frameRate, shown.bitrate], ['30', '40']);
  } finally {
    await app.context.close();
  }
});

test('after a fresh install, a bitrate picked by hand is kept from then on', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      $('#bitrateSlider')[0].MaterialSlider.change('65');
      $('#bitrateSlider').trigger('input');
    });
    await pickResolution(app.page, '1920:1080');
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.resolution, shown.bitrate, shown.autoAdjustBitrate], ['1920:1080', '65', false]);
    assert.equal(count(app, 'Keeping your bitrate of'), 1);
    const stored = await waitForStorage(app.page, (values) => values.autoAdjustBitrate === false && values.bitrate === '65');
    assert.equal(stored.resolution, '1920:1080');
  } finally {
    await app.context.close();
  }
});

test('the button keeps the recommended bitrate, and Restore Defaults lets it follow the presets again', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await applyButton(app.page);
    let shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.autoAdjustBitrate], ['100', false]);
    await restoreDefaults(app.page);
    shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.autoAdjustBitrate, shown.unlockAllFps, shown.hdr], ['100', true, true, true]);
    await waitForStorage(app.page, (values) => values.autoAdjustBitrate === true);
    await applyButton(app.page);
    shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.autoAdjustBitrate], ['100', false]);
    await waitForStorage(app.page, (values) => values.autoAdjustBitrate === false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Restore Defaults and the button turn a stored game mode off on Tizen 5.5, keep its switch disabled and remove the value', async () => {
  // Restore Defaults left a stored game mode on Tizen 5.5 as it was, so its switch stayed enabled after the restart
  for (const entry of [{ storedGameMode: true, apply: restoreDefaults }, { storedGameMode: false, apply: applyButton }]) {
    const app = await openApp(harness, {
      tv: { tv: 'fhd', conn: 'wifi' },
      stored: { uniqueid: '0123456789abcdef', cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' }, settingsSchema: 2, gameMode: entry.storedGameMode },
    });
    try {
      // An existing install keeps its stored game mode, and the switch stays enabled so that it can be turned off
      let shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.gameMode, shown.gameModeDisabled], [entry.storedGameMode, false], entry.apply.name);
      await entry.apply(app.page);
      shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.gameMode, shown.gameModeDisabled], [false, true], entry.apply.name);
      await waitForStorage(app.page, (values) => !('gameMode' in values) && values.resolution === '1920:1080');
      // The next start shows the switch off and disabled, like on a fresh install
      await reloadApp(app);
      shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.gameMode, shown.gameModeDisabled], [false, true], entry.apply.name);
      assert.equal('gameMode' in (await readStorage(app.page)), false, entry.apply.name);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the button locks the higher frame rates on a TV without a tested profile, without a stray bitrate notice', async () => {
  const app = await openApp(harness, {
    tv: { tv: 'uhd', conn: 'wifi' },
    stored: {
      uniqueid: '0123456789abcdef', cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' }, settingsSchema: 2,
      unlockAllFps: true, frameRate: 120, bitrate: '55', autoAdjustBitrate: false,
    },
  });
  try {
    let shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.frameRate, shown.unlockAllFps, shown.bitrate], ['120', true, '55']);
    await applyButton(app.page);
    shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.frameRate, shown.frameRateOptions, shown.unlockAllFps, shown.bitrate, shown.autoAdjustBitrate],
      ['60', ['30', '60'], false, '80', false]);
    assert.equal(count(app, 'Keeping your bitrate of'), 0);
    const stored = await waitForStorage(app.page, (values) => values.unlockAllFps === false && values.bitrate === '80');
    assert.equal(stored.frameRate, 60);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('HDR is on by default when the TV reports it, whatever the panel (plan D8)', async () => {
  const cases = [
    { tv: { tv: 'uhd', hdr: 0 }, hdr: false },
    { tv: { tv: 'fhd', hdr: 1 }, hdr: true },
    { tv: { tv: 'fhd' }, hdr: false },
  ];
  for (const entry of cases) {
    const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi' }, entry.tv) });
    try {
      assert.equal((await readVideoSettings(app.page)).hdr, entry.hdr, JSON.stringify(entry));
      await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
      const text = await app.page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
      assert.ok(text.indexOf('Video codec: ' + (entry.hdr ? 'HEVC Main10 with HDR' : 'HEVC') + '<br>') >= 0, text);
      await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    } finally {
      await app.context.close();
    }
  }
});

test('an 8K TV gets 4K with HDR at the 80 Mbps cap of TVs without a tested profile', async () => {
  for (const [conn, bitrate] of [['ethernet', '75'], ['wifi', '80'], ['unknown', '80']]) {
    const app = await openApp(harness, { tv: { tv: '8k', conn } });
    try {
      const shown = await readVideoSettings(app.page);
      assert.deepEqual(
        [shown.resolution, shown.frameRate, shown.codec, shown.hdr, shown.bitrate, shown.unlockAllFps, shown.gameMode, shown.autoAdjustBitrate],
        ['3840:2160', '60', 'HEVC', true, bitrate, false, true, true], conn);
      await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
      const text = await app.page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
      assert.ok(text.indexOf('Video bitrate: ' + bitrate + ' Mbps<br>') >= 0, text);
      assert.ok(text.indexOf('Game mode on<br>') >= 0, text);
      await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    } finally {
      await app.context.close();
    }
  }
});

test('a TV whose product APIs fail still starts, with the defaults of a Full HD TV without HDR (plan WP2)', async () => {
  const failApis = [
    'tizen.systeminfo.getCapability',
    'webapis.productinfo.getModel',
    'webapis.productinfo.getRealModel',
    'webapis.productinfo.getModelCode',
    'webapis.productinfo.isUdPanelSupported',
    'webapis.avinfo',
  ].join(',');
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', failApis } });
  try {
    assert.deepEqual(app.errors, []);
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.resolution, shown.hdr, shown.bitrate, shown.unlockAllFps, shown.codec], ['1920:1080', false, '25', false, 'HEVC']);
    const systemInfo = await app.page.evaluate(() => document.getElementById('systemInfoBtn').innerHTML.replace(/<br\s*\/?>/g, '\n'));
    assert.equal(systemInfo, [
      'App Version: Moonlight Plus v1.19.100',
      'Platform Version: Tizen Unknown',
      'TV Model Series: Unknown',
      'TV Model Name: Unknown',
      'TV Model Group: Unknown',
      'Model Year (from the model group): Unknown',
      'Panel: Full HD',
      'HDR Support: No',
      'Network Connection Type: Wi-Fi',
      'Tested Profile: None',
      'Ultra Low Latency mode (Game mode): Unknown',
      'WASM player API levels: Unknown',
      'Video decoders (MediaSource check): H.264: Yes, HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes',
      'Video decoders at level 5.2 (4K above 60 FPS): HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes',
      'Gamepads: None',
    ].join('\n'));
    // The dialog names no model and no tested profile, and lists what the app falls back to
    await applyButtonDialog(app.page);
    const dialog = await readDialog(app.page);
    assert.equal(dialog.title, 'Optimal settings for this TV');
    assert.ok(dialog.text.indexOf('Detected: Full HD panel, no HDR, unknown Tizen version, Wi-Fi<br><br>') === 0, dialog.text);
    await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    for (const label of ['Tizen platform version', 'TV model series', 'TV model name', 'TV model group', '4K panel support', 'HDR support']) {
      assert.equal(count(app, 'Failed to get the ' + label), 1, label);
    }
    // The settings still work: Restore Defaults applies the same defaults
    await restoreDefaults(app.page);
    const stored = await waitForStorage(app.page, (values) => values.resolution === '1920:1080' && values.bitrate === '25');
    assert.deepEqual([stored.hdrMode, stored.unlockAllFps], [false, false]);
    assert.equal((await readStorage(app.page)).settingsSchema, 2);
  } finally {
    await app.context.close();
  }
});
