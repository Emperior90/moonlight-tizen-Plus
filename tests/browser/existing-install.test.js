'use strict';

// The one-time settings snapshot of plan WP1. Up to settings schema 1, the defaults of the video settings were worked
// out again at every start instead of being stored, so settings the user never changed followed the defaults of
// whatever build was installed (plan finding K1). An existing install (one with a stored unique ID but no settings
// schema) therefore stores the defaults of settings schema 1 once for every unset video setting, so that the new
// defaults of plan WP2 never change it. A fresh install stores the schema with its unique ID and gets the new defaults.
//
// The values of an existing install below are what the previous build showed on these TVs (the "current behaviour"
// pinned before WP1), and must not change.
//
// Settings schema 3 turned the rumble on by default: an existing install of settings schema 2 or older that never
// switched it stores the earlier default (off) once, and the stored value of the removed switch 'Continuous audio from
// the host' is dropped (tests/browser/continuous-audio.test.js).

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  VIDEO_KEYS, openApp, pick, readStorage, readVideoSettings, reloadApp, startHarness, waitForStorage,
} = require('./harness');

// What an install that already started once has stored, without any video setting
const EXISTING_INSTALL = {
  uniqueid: '0123456789abcdef',
  cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' },
};

// The video settings that the previous build showed (and now stores once) for an install without stored video settings
const LEGACY_VALUES = {
  // The S90C over Wi-Fi: 4K, HDR, 100 Mbps, all frame rates unlocked, game mode off on Tizen 9.0
  s90cWifi: {
    stored: {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: '100', videoCodec: 'HEVC', hdrMode: true, framePacing: true,
      fullRange: false, gameMode: false, optimizeBitrate: false, autoAdjustBitrate: false,
    },
    shown: {
      resolution: '3840:2160', frameRate: '60', codec: 'HEVC', hdr: true, bitrate: '100', unlockAllFps: true, gameMode: false,
      gameModeDisabled: false, framePacing: true, fullRange: false, optimizeBitrate: false, autoAdjustBitrate: false,
    },
  },
  // A generic UHD TV over Wi-Fi, whose new defaults differ (80 Mbps, frame rates locked): it keeps the old ones
  uhdWifi: {
    stored: {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: '100', videoCodec: 'HEVC', hdrMode: true, framePacing: true,
      fullRange: false, gameMode: true, optimizeBitrate: false, autoAdjustBitrate: false,
    },
    shown: {
      resolution: '3840:2160', frameRate: '60', codec: 'HEVC', hdr: true, bitrate: '100', unlockAllFps: true, gameMode: true,
      gameModeDisabled: false, framePacing: true, fullRange: false, optimizeBitrate: false, autoAdjustBitrate: false,
    },
  },
  // A Full HD TV on Tizen 5.5 over Ethernet: 75 Mbps, and the game mode is never stored, so its switch stays disabled
  fhdEthernet: {
    stored: {
      resolution: '1920:1080', unlockAllFps: true, frameRate: 60, bitrate: '75', videoCodec: 'HEVC', hdrMode: false, framePacing: true,
      fullRange: false, optimizeBitrate: false, autoAdjustBitrate: false,
    },
    shown: {
      resolution: '1920:1080', frameRate: '60', codec: 'HEVC', hdr: false, bitrate: '75', unlockAllFps: true, gameMode: false,
      gameModeDisabled: true, framePacing: true, fullRange: false, optimizeBitrate: false, autoAdjustBitrate: false,
    },
  },
};

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Open the app as an existing install with the given stored settings
function openExisting(tvOptions, stored, extraOptions) {
  return openApp(harness, Object.assign({ tv: tvOptions, stored: Object.assign({}, EXISTING_INSTALL, stored || {}) }, extraOptions || {}));
}

// The shown video settings that the snapshot has to preserve
async function shownSettings(page) {
  const shown = await readVideoSettings(page);
  return {
    resolution: shown.resolution, frameRate: shown.frameRate, codec: shown.codec, hdr: shown.hdr, bitrate: shown.bitrate,
    unlockAllFps: shown.unlockAllFps, gameMode: shown.gameMode, gameModeDisabled: shown.gameModeDisabled, framePacing: shown.framePacing,
    fullRange: shown.fullRange, optimizeBitrate: shown.optimizeBitrate, autoAdjustBitrate: shown.autoAdjustBitrate,
  };
}

// Open an existing install without stored video settings, and check that the first start stores the previous defaults
// and shows them, and that the second start loads exactly the same
async function checkSnapshot(tvOptions, legacy) {
  const app = await openExisting(tvOptions);
  try {
    assert.deepEqual(await shownSettings(app.page), legacy.shown, 'first start');
    const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 3);
    assert.deepEqual(pick(stored, VIDEO_KEYS), legacy.stored);
    assert.equal(stored.uniqueid, EXISTING_INSTALL.uniqueid);
    // The rumble stays off as before (settings schema 3)
    assert.equal(stored.rumbleFeedback, false);
    assert.equal(await app.page.evaluate(() => document.getElementById('rumbleFeedbackSwitch').checked), false);
    assert.ok(app.logs.some((line) => line.indexOf('Existing install without a settings schema') >= 0));
    await app.page.waitForTimeout(300);
    const afterFirstStart = await readStorage(app.page);

    await reloadApp(app);
    assert.deepEqual(await shownSettings(app.page), legacy.shown, 'second start');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await readStorage(app.page), afterFirstStart, 'the second start stores nothing new');
    assert.equal(app.logs.filter((line) => line.indexOf('Existing install without a settings schema') >= 0).length, 1, 'the snapshot is taken once');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
}

test('an existing S90C install keeps the values it showed before, and stores them once (plan WP1)', async () => {
  await checkSnapshot({ tv: 's90c', conn: 'wifi' }, LEGACY_VALUES.s90cWifi);
});

test('an existing install on a generic UHD TV keeps 100 Mbps and the unlocked frame rates', async () => {
  await checkSnapshot({ tv: 'uhd', conn: 'wifi' }, LEGACY_VALUES.uhdWifi);
});

test('an existing Full HD install on Tizen 5.5 keeps 75 Mbps, and its game mode switch stays disabled (plan K2)', async () => {
  await checkSnapshot({ tv: 'fhd', conn: 'ethernet' }, LEGACY_VALUES.fhdEthernet);
});

test('a stored 120 FPS stays selected after the unlock default turned off (the trap of plan K1)', async () => {
  // The user picked 120 FPS but never touched 'Unlock all frame rates'. Without the snapshot, the 120 FPS entry would
  // disappear on a TV whose new default is off, and streams would silently run at 60 FPS.
  for (const tv of ['uhd', 's90c']) {
    const app = await openExisting({ tv, conn: 'wifi' }, { frameRate: 120 });
    try {
      const shown = await readVideoSettings(app.page);
      assert.equal(shown.unlockAllFps, true, tv);
      assert.equal(shown.frameRate, '120', tv);
      assert.deepEqual(shown.frameRateOptions, ['30', '60', '90', '120', '144'], tv);
      const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 3);
      assert.deepEqual([stored.unlockAllFps, stored.frameRate], [true, 120], tv);
    } finally {
      await app.context.close();
    }
  }
});

test('a partly customized existing install keeps its stored values, and only the unset ones are filled in', async () => {
  const app = await openExisting({ tv: 's90c', conn: 'ethernet' }, { videoCodec: 'H264', bitrate: '42', fullRange: true });
  try {
    const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 3);
    assert.deepEqual(pick(stored, VIDEO_KEYS), {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: '42', videoCodec: 'H264',
      // HDR stays off for the stored H.264 codec, as the previous build showed it
      hdrMode: false, framePacing: true, fullRange: true, gameMode: false, optimizeBitrate: false, autoAdjustBitrate: false,
    });
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.codec, shown.bitrate, shown.hdr, shown.fullRange], ['H264', '42', false, true]);
  } finally {
    await app.context.close();
  }
});

test('the stored video settings of an existing install are loaded as stored', async () => {
  const stored = {
    resolution: '2560:1440', frameRate: 90, bitrate: '42.5', videoCodec: 'AV1', hdrMode: true, unlockAllFps: true,
    framePacing: false, fullRange: true, gameMode: true, optimizeBitrate: false, autoAdjustBitrate: false,
  };
  const app = await openExisting({ tv: 'uhd', conn: 'wifi' }, stored);
  try {
    const shown = await readVideoSettings(app.page);
    assert.deepEqual(
      [shown.resolution, shown.frameRate, shown.codec, shown.bitrate, shown.bitrateLabel, shown.hdr, shown.unlockAllFps, shown.framePacing,
        shown.fullRange, shown.gameMode, shown.optimizeBitrate, shown.autoAdjustBitrate],
      ['2560:1440', '90', 'AV1', '42.5', '42.5 Mbps', true, true, false, true, true, false, false]);
    // Nothing is rewritten on load, only the settings schema is added
    await app.page.waitForTimeout(300);
    const values = await readStorage(app.page);
    assert.deepEqual(pick(values, VIDEO_KEYS), stored);
    assert.equal(values.settingsSchema, 3);
  } finally {
    await app.context.close();
  }
});

test('an update from a build without the preset state decides once whether the stored bitrate follows the presets', async () => {
  const cases = [
    // A stored standard preset keeps following the video settings
    { conn: 'wifi', stored: { bitrate: '80', resolution: '3840:2160', frameRate: 60 }, follows: true },
    // Over Ethernet the 4K preset was limited to 75 Mbps, which counts as the preset too
    { conn: 'ethernet', stored: { bitrate: '75', resolution: '3840:2160', frameRate: 60 }, follows: true },
    // A bitrate that differs from the preset was picked by hand (or by the optimal settings button) and is kept
    { conn: 'wifi', stored: { bitrate: '100', resolution: '3840:2160', frameRate: 60 }, follows: false },
    // The optimized presets always follow the video settings
    { conn: 'wifi', stored: { bitrate: '33', resolution: '3840:2160', frameRate: 60, optimizeBitrate: true }, follows: true },
    // Without a stored bitrate the previous build kept its recommended bitrate, which the snapshot stores
    { conn: 'ethernet', stored: {}, follows: false },
    // A stored resolution above the panel was loaded as 1080p before the decision, so the 4K preset counted as picked
    // by hand on a Full HD TV
    { tv: 'fhd', conn: 'wifi', stored: { bitrate: '80', resolution: '3840:2160', frameRate: 60 }, follows: false },
  ];
  for (const entry of cases) {
    const app = await openExisting({ tv: entry.tv || 's90c', conn: entry.conn }, entry.stored);
    try {
      const stored = await waitForStorage(app.page, (values) => 'autoAdjustBitrate' in values && values.settingsSchema === 3);
      assert.equal(stored.autoAdjustBitrate, entry.follows, JSON.stringify(entry));
      assert.equal(await app.page.evaluate(() => autoAdjustBitrate), entry.follows, JSON.stringify(entry));
    } finally {
      await app.context.close();
    }
  }
});

test('an install that started with this build gets the new defaults and no snapshot', async () => {
  // A fresh install stores its unique ID together with the settings schema (loadHTTPCertsCb)
  const app = await openExisting({ tv: 'uhd', conn: 'wifi' }, { settingsSchema: 3 });
  try {
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.resolution, shown.bitrate, shown.unlockAllFps, shown.frameRateOptions, shown.autoAdjustBitrate],
      ['3840:2160', '80', false, ['30', '60'], true]);
    await app.page.waitForTimeout(300);
    assert.deepEqual(Object.keys(await readStorage(app.page)).sort(), ['autoAdjustBitrate', 'cert', 'settingsSchema', 'uniqueid']);
    assert.ok(!app.logs.some((line) => line.indexOf('Existing install without a settings schema') >= 0));
  } finally {
    await app.context.close();
  }
});

// Hold back the window load handler of the app (onWindowLoad(), which loads the stored settings) until the stub of the
// WebAssembly module has started and the app created the unique ID of the fresh install, so that the settings are read
// after the unique ID was stored. Runs as an init script in the page.
function holdSettingsUntilUniqueId() {
  let appOnload = null;
  Object.defineProperty(window, 'onload', {
    configurable: true,
    get() {
      return appOnload;
    },
    set(handler) {
      appOnload = handler;
    },
  });
  window.addEventListener('load', function waitForUniqueId(event) {
    if (typeof myUniqueid !== 'undefined' && myUniqueid && appOnload) {
      console.log('Test: loading the settings after the unique ID was created');
      appOnload.call(window, event);
    } else {
      setTimeout(() => waitForUniqueId(event), 10);
    }
  });
}

test('a fresh install is never taken for an existing one, whether the unique ID is created before or after the settings load', async () => {
  const variants = [
    { name: 'module first', options: { initScripts: [holdSettingsUntilUniqueId] } },
    { name: 'module late', options: { mockConfig: { wasmStartMs: 1500 } } },
  ];
  for (const variant of variants) {
    const app = await openApp(harness, Object.assign({ tv: { tv: 'uhd', conn: 'wifi' } }, variant.options));
    try {
      if (variant.name === 'module first') {
        assert.ok(app.logs.some((line) => line.indexOf('Test: loading the settings after the unique ID was created') >= 0), variant.name);
      }
      const shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.bitrate, shown.unlockAllFps, shown.autoAdjustBitrate], ['80', false, true], variant.name);
      await app.page.waitForTimeout(300);
      const stored = await readStorage(app.page);
      assert.deepEqual(Object.keys(stored).sort(), ['autoAdjustBitrate', 'cert', 'settingsSchema', 'uniqueid'], variant.name);
      assert.equal(stored.settingsSchema, 3, variant.name);
      assert.ok(!app.logs.some((line) => line.indexOf('Existing install without a settings schema') >= 0), variant.name);
      assert.deepEqual(app.errors, [], variant.name);
    } finally {
      await app.context.close();
    }
  }
});

test('an install of settings schema 2 keeps the rumble off that it showed, and a stored rumble stays as it is', async () => {
  const rumble = (page) => page.evaluate(() => document.getElementById('rumbleFeedbackSwitch').checked);
  // Never switched: the earlier default is stored once
  let app = await openExisting({ tv: 's90c', conn: 'wifi' }, { settingsSchema: 2, framePacing: false });
  try {
    const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 3);
    assert.equal(stored.rumbleFeedback, false);
    assert.equal(await rumble(app.page), false);
    // Nothing else changes
    assert.equal(stored.framePacing, false);
    assert.ok(app.logs.some((line) => line.indexOf('Existing install of settings schema 2, storing the defaults of settings schema 2 that changed: {"rumbleFeedback":false}') >= 0));
    await reloadApp(app);
    assert.equal(await rumble(app.page), false);
    assert.equal(app.logs.filter((line) => line.indexOf('Existing install of settings schema 2') >= 0).length, 1, 'once');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
  // Switched on or off by the user: kept
  for (const value of [true, false]) {
    app = await openExisting({ tv: 's90c', conn: 'wifi' }, { settingsSchema: 2, rumbleFeedback: value });
    try {
      const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 3);
      assert.equal(stored.rumbleFeedback, value);
      assert.equal(await rumble(app.page), value);
    } finally {
      await app.context.close();
    }
  }
});

test('a fresh install has the rumble on without storing it', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' } });
  try {
    await waitForStorage(app.page, (values) => values.settingsSchema === 3);
    assert.equal(await app.page.evaluate(() => document.getElementById('rumbleFeedbackSwitch').checked), true);
    await app.page.waitForTimeout(300);
    assert.equal('rumbleFeedback' in (await readStorage(app.page)), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
