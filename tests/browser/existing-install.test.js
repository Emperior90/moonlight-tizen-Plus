'use strict';

// The one-time settings snapshot of an existing install (since 1.19.100). Up to settings schema 1, the defaults of the video settings were worked
// out again at every start instead of being stored, so settings the user never changed followed the defaults of
// whatever build was installed. An existing install (one with a stored unique ID but no settings
// schema) therefore stores the defaults of settings schema 1 once for every unset video setting, so that the new
// defaults that 1.19.100 derives from the TV never change it. A fresh install stores the schema with its unique ID and gets the new defaults.
//
// The values of an existing install below are what the previous build showed on these TVs (the "current behaviour"
// pinned before 1.19.100), and must not change.
//
// Settings schema 3 turned the rumble on by default: an existing install of settings schema 2 or older that never
// switched it stores the earlier default (off) once, and the stored values of the removed switches 'Continuous audio
// from the host' (tests/browser/continuous-audio.test.js) and 'Optimize bitrate presets' are dropped, so the snapshot of
// settings schema 1 no longer stores the latter either.
//
// Since 2.2.1 the frame rates end at 120 FPS: a stored 144 FPS of 2.2.0 and earlier becomes 120 FPS, or 60 FPS where the
// menu offers no 120 FPS, once and without a notice, and the bitrate follows it only when it followed the presets.
//
// Settings schema 4 (2.3.0) turned 'Optimize game settings' on by default: an existing install of settings schema 3 or
// older that never switched it stores the earlier default (off) once, and nothing else of the earlier snapshots runs
// again for an install of settings schema 3.

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
      fullRange: false, gameMode: false, autoAdjustBitrate: false,
    },
    shown: {
      resolution: '3840:2160', frameRate: '60', codec: 'HEVC', hdr: true, bitrate: '100', unlockAllFps: true, gameMode: false,
      gameModeDisabled: false, framePacing: true, fullRange: false, autoAdjustBitrate: false,
    },
  },
  // A generic UHD TV over Wi-Fi, whose new defaults differ (80 Mbps, frame rates locked): it keeps the old ones
  uhdWifi: {
    stored: {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: '100', videoCodec: 'HEVC', hdrMode: true, framePacing: true,
      fullRange: false, gameMode: true, autoAdjustBitrate: false,
    },
    shown: {
      resolution: '3840:2160', frameRate: '60', codec: 'HEVC', hdr: true, bitrate: '100', unlockAllFps: true, gameMode: true,
      gameModeDisabled: false, framePacing: true, fullRange: false, autoAdjustBitrate: false,
    },
  },
  // A Full HD TV on Tizen 5.5 over Ethernet: 75 Mbps, and the game mode is never stored, so its switch stays disabled
  fhdEthernet: {
    stored: {
      resolution: '1920:1080', unlockAllFps: true, frameRate: 60, bitrate: '75', videoCodec: 'HEVC', hdrMode: false, framePacing: true,
      fullRange: false, autoAdjustBitrate: false,
    },
    shown: {
      resolution: '1920:1080', frameRate: '60', codec: 'HEVC', hdr: false, bitrate: '75', unlockAllFps: true, gameMode: false,
      gameModeDisabled: true, framePacing: true, fullRange: false, autoAdjustBitrate: false,
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
    fullRange: shown.fullRange, autoAdjustBitrate: shown.autoAdjustBitrate,
  };
}

// Open an existing install without stored video settings, and check that the first start stores the previous defaults
// and shows them, and that the second start loads exactly the same
async function checkSnapshot(tvOptions, legacy) {
  const app = await openExisting(tvOptions);
  try {
    assert.deepEqual(await shownSettings(app.page), legacy.shown, 'first start');
    const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4);
    assert.deepEqual(pick(stored, VIDEO_KEYS), legacy.stored);
    assert.equal(stored.uniqueid, EXISTING_INSTALL.uniqueid);
    // The rumble stays off as before (settings schema 3), and so does 'Optimize game settings' (settings schema 4)
    assert.equal(stored.rumbleFeedback, false);
    assert.equal(await app.page.evaluate(() => document.getElementById('rumbleFeedbackSwitch').checked), false);
    assert.equal(stored.optimizeGames, false);
    assert.equal(await app.page.evaluate(() => document.getElementById('optimizeGamesSwitch').checked), false);
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

test('an existing S90C install keeps the values it showed before, and stores them once', async () => {
  await checkSnapshot({ tv: 's90c', conn: 'wifi' }, LEGACY_VALUES.s90cWifi);
});

test('an existing install on a generic UHD TV keeps 100 Mbps and the unlocked frame rates', async () => {
  await checkSnapshot({ tv: 'uhd', conn: 'wifi' }, LEGACY_VALUES.uhdWifi);
});

test('an existing Full HD install on Tizen 5.5 keeps 75 Mbps, and its game mode switch stays disabled', async () => {
  await checkSnapshot({ tv: 'fhd', conn: 'ethernet' }, LEGACY_VALUES.fhdEthernet);
});

test('a stored 120 FPS stays selected after the unlock default turned off', async () => {
  // The user picked 120 FPS but never touched 'Unlock all frame rates'. Without the snapshot, the 120 FPS entry would
  // disappear on a TV whose new default is off, and streams would silently run at 60 FPS.
  for (const tv of ['uhd', 's90c']) {
    const app = await openExisting({ tv, conn: 'wifi' }, { frameRate: 120 });
    try {
      const shown = await readVideoSettings(app.page);
      assert.equal(shown.unlockAllFps, true, tv);
      assert.equal(shown.frameRate, '120', tv);
      assert.deepEqual(shown.frameRateOptions, ['30', '60', '90', '120'], tv);
      const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4);
      assert.deepEqual([stored.unlockAllFps, stored.frameRate], [true, 120], tv);
    } finally {
      await app.context.close();
    }
  }
});

// 2.2.1 removed the 144 FPS of 2.2.0 and earlier, as upstream 7d8ab56 did, since the video player of Samsung TVs never
// starts a stream at 144 FPS (upstream dd7dfdf). A stored 144 FPS becomes the highest frame rate below it that the menu
// of the TV offers, once, before the settings load (frameRateReplacements() in tv_profile.js), and without a notice.
const FRAME_RATE_REPLACED = 'Replacing the stored frame rate of 144 FPS';

// The notices of the app: every notice goes through snackbarLog() or snackbarLogLong(), which log it
const notices = (app) => app.logs.filter((line) => line.indexOf('[index.js, snackbarLog') >= 0);

// Count the log lines that contain the text
const count = (app, text) => app.logs.filter((line) => line.indexOf(text) >= 0).length;

// The frame rate of the start request of app 8 on a host whose launch request succeeds at once. A start from a Smart Hub
// tile goes through the same startGame(), which takes the video settings from the settings screen.
function startRequestFrameRate(page) {
  return page.evaluate(async () => {
    showApps = () => Promise.resolve();
    Module.stopStream = () => {
      handleMessage('streamTerminated: 0');
      return { type: 'resolve', ret: null };
    };
    window.__startStreamArgs = null;
    startGame({
      paired: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03, refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
      launchApp: () => Promise.resolve('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>'),
    }, 8);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const args = window.__startStreamArgs;
    Module.stopStream();
    // The frame rate is the fifth argument (SyncFunctions.startRequest in messages.js)
    return args ? args[4] : null;
  });
}

test('a stored 144 FPS becomes 120 FPS on the S90C with the preset of 120 FPS, without a notice and only once', async () => {
  // An install of 2.2.0 on the S90C over Wi-Fi at 1080p and 144 FPS, whose bitrate followed the presets (44 Mbps)
  const app = await openExisting({ tv: 's90c', conn: 'wifi' }, {
    settingsSchema: 3, resolution: '1920:1080', frameRate: 144, bitrate: '44', autoAdjustBitrate: true,
  });
  try {
    const expected = ['120', ['30', '60', '90', '120'], true, '38', '38 Mbps', true];
    const shownOf = (shown) => [shown.frameRate, shown.frameRateOptions, shown.unlockAllFps, shown.bitrate, shown.bitrateLabel, shown.autoAdjustBitrate];
    // 25 % above the preset of 30 Mbps at 1080p and 120 FPS
    assert.deepEqual(shownOf(await readVideoSettings(app.page)), expected, 'first start');
    const stored = await waitForStorage(app.page, (values) => values.frameRate !== 144);
    assert.deepEqual(pick(stored, VIDEO_KEYS), { resolution: '1920:1080', frameRate: 120, bitrate: '38', autoAdjustBitrate: true });
    assert.deepEqual(notices(app), [], 'no notice, such as the one about a kept bitrate');
    assert.equal(count(app, 'Keeping the bitrate of'), 0);
    assert.equal(count(app, FRAME_RATE_REPLACED), 1);
    await app.page.waitForTimeout(300);
    const afterFirstStart = await readStorage(app.page);

    // The next start loads 120 FPS as stored and replaces nothing
    await reloadApp(app);
    assert.deepEqual(shownOf(await readVideoSettings(app.page)), expected, 'second start');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await readStorage(app.page), afterFirstStart, 'the second start stores nothing new');
    assert.equal(count(app, FRAME_RATE_REPLACED), 1, 'replaced once');
    assert.deepEqual(notices(app), []);
    // And a stream starts at 120 FPS
    assert.equal(await startRequestFrameRate(app.page), '120');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stored 144 FPS keeps a bitrate picked by hand', async () => {
  const app = await openExisting({ tv: 's90c', conn: 'ethernet' }, {
    settingsSchema: 3, resolution: '3840:2160', frameRate: 144, bitrate: '42.5', autoAdjustBitrate: false,
  });
  try {
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.frameRate, shown.bitrate, shown.bitrateLabel, shown.autoAdjustBitrate], ['120', '42.5', '42.5 Mbps', false]);
    const stored = await waitForStorage(app.page, (values) => values.frameRate !== 144);
    assert.deepEqual(pick(stored, VIDEO_KEYS), { resolution: '3840:2160', frameRate: 120, bitrate: '42.5', autoAdjustBitrate: false });
    assert.deepEqual(notices(app), [], 'no notice about the kept bitrate');
    assert.equal(count(app, 'Keeping the bitrate of'), 0);
    assert.equal(await startRequestFrameRate(app.page), '120');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stored 144 FPS over Ethernet gets the Ethernet preset of 120 FPS, not the one of Wi-Fi', async () => {
  // An install of 2.2.0 on the S90C over Ethernet at 4K and 144 FPS, whose bitrate followed the presets (75 Mbps, the
  // limit of Ethernet). Over Wi-Fi the preset of 4K at 120 FPS would be 100 Mbps, so this pins that the replacement
  // reads the connection of the TV
  const app = await openExisting({ tv: 's90c', conn: 'ethernet' }, {
    settingsSchema: 3, resolution: '3840:2160', frameRate: 144, bitrate: '75', autoAdjustBitrate: true,
  });
  try {
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.frameRate, shown.bitrate, shown.bitrateLabel, shown.autoAdjustBitrate], ['120', '75', '75 Mbps', true]);
    const stored = await waitForStorage(app.page, (values) => values.frameRate !== 144);
    assert.deepEqual(pick(stored, VIDEO_KEYS), { resolution: '3840:2160', frameRate: 120, bitrate: '75', autoAdjustBitrate: true });
    assert.deepEqual(notices(app), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stored 144 FPS becomes 60 FPS where the frame rate menu offers no 120 FPS', async () => {
  const cases = [
    // A 4K TV without a tested profile, whose higher frame rates are locked by default: the 4K preset of 60 FPS
    { tv: 'uhd', stored: { resolution: '3840:2160', bitrate: '80', autoAdjustBitrate: true }, bitrate: '80' },
    // The S90C with 'Unlock all frame rates' switched off: 25 % above the preset of 20 Mbps at 1080p and 60 FPS
    { tv: 's90c', stored: { unlockAllFps: false, resolution: '1920:1080', bitrate: '44', autoAdjustBitrate: true }, bitrate: '25' },
    // A Full HD TV with a bitrate picked by hand
    { tv: 'fhd', stored: { bitrate: '33', autoAdjustBitrate: false }, bitrate: '33' },
  ];
  for (const entry of cases) {
    const app = await openExisting({ tv: entry.tv, conn: 'wifi' }, Object.assign({ settingsSchema: 3, frameRate: 144 }, entry.stored));
    try {
      const shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.frameRate, shown.frameRateOptions, shown.unlockAllFps, shown.bitrate], ['60', ['30', '60'], false, entry.bitrate], entry.tv);
      const stored = await waitForStorage(app.page, (values) => values.frameRate !== 144);
      assert.deepEqual([stored.frameRate, stored.bitrate], [60, entry.bitrate], entry.tv);
      assert.deepEqual(notices(app), [], entry.tv);
      assert.equal(await startRequestFrameRate(app.page), '60', entry.tv);
      assert.deepEqual(app.errors, [], entry.tv);
    } finally {
      await app.context.close();
    }
  }
});

test('a stored 144 FPS without a stored state of the presets: the state decided from 144 FPS is stored, and the last loader keeps it', async () => {
  // The last loader of the settings decides the state of the presets only when none is stored, and would compare the
  // bitrate with the preset of 120 FPS (120 Mbps at 4K), so the replacement stores the decision it made from 144 FPS
  for (const [bitrate, follows, shownBitrate] of [['140', true, '100'], ['100', false, '100']]) {
    const app = await openExisting({ tv: 's90c', conn: 'wifi' }, { settingsSchema: 3, resolution: '3840:2160', frameRate: 144, bitrate });
    try {
      const shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.frameRate, shown.bitrate, shown.autoAdjustBitrate], ['120', shownBitrate, follows], bitrate);
      const stored = await waitForStorage(app.page, (values) => values.frameRate !== 144);
      assert.deepEqual([stored.frameRate, stored.bitrate, stored.autoAdjustBitrate], [120, shownBitrate, follows], bitrate);
      assert.ok(app.logs.some((line) => line.indexOf('Auto adjust bitrate state: ' + follows) >= 0), bitrate);
      assert.equal(count(app, 'Auto adjust bitrate state (first decision)'), 0, bitrate);
      assert.deepEqual(notices(app), [], bitrate);
      assert.deepEqual(app.errors, [], bitrate);
    } finally {
      await app.context.close();
    }
  }
});

test('an install of settings schema 1 with 144 FPS: the snapshot still sees its preset, and the frame rate becomes 120 FPS', async () => {
  // The snapshot decides whether the stored bitrate came from the presets with the 144 FPS presets of 2.2.0 and earlier
  // (140 Mbps at 4K), as before, and then the bitrate follows the presets to 120 FPS (100 Mbps on the S90C over Wi-Fi)
  for (const [bitrate, follows, shownBitrate] of [['140', true, '100'], ['100', false, '100'], ['42', false, '42']]) {
    const app = await openExisting({ tv: 's90c', conn: 'wifi' }, { resolution: '3840:2160', frameRate: 144, bitrate });
    try {
      const shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.frameRate, shown.unlockAllFps, shown.bitrate, shown.autoAdjustBitrate], ['120', true, shownBitrate, follows], bitrate);
      const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4 && values.frameRate !== 144);
      assert.deepEqual([stored.frameRate, stored.unlockAllFps, stored.bitrate, stored.autoAdjustBitrate], [120, true, shownBitrate, follows], bitrate);
      assert.ok(app.logs.some((line) => line.indexOf('Existing install without a settings schema') >= 0 &&
        line.indexOf('"autoAdjustBitrate":' + follows) >= 0), bitrate);
      assert.deepEqual(notices(app), [], bitrate);
      assert.deepEqual(app.errors, [], bitrate);
    } finally {
      await app.context.close();
    }
  }
});

test('an install of settings schema 1 with 144 FPS on a generic 4K TV: the snapshot unlocks the frame rates, so it becomes 120 FPS', async () => {
  // The install never touched 'Unlock all frame rates', whose default for this TV is off now, but the snapshot stores it
  // on as settings schema 1 showed it, and the replacement decides from what the snapshot stores
  const cases = [
    // 140 Mbps is the 4K preset of 144 FPS in 2.2.0, so the bitrate follows the presets to 120 FPS (80 Mbps on this TV)
    { stored: { resolution: '3840:2160', frameRate: 144, bitrate: '140' }, bitrate: '80', follows: true },
    // Only the frame rate stored: the snapshot stores 4K and 100 Mbps, which it doesn't take for a preset
    { stored: { frameRate: 144 }, bitrate: '100', follows: false },
  ];
  for (const entry of cases) {
    const name = JSON.stringify(entry.stored);
    const app = await openExisting({ tv: 'uhd', conn: 'wifi' }, entry.stored);
    try {
      const shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.resolution, shown.frameRate, shown.frameRateOptions, shown.unlockAllFps, shown.bitrate, shown.autoAdjustBitrate],
        ['3840:2160', '120', ['30', '60', '90', '120'], true, entry.bitrate, entry.follows], name);
      const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4 && values.frameRate !== 144);
      assert.deepEqual([stored.frameRate, stored.unlockAllFps, stored.bitrate, stored.autoAdjustBitrate], [120, true, entry.bitrate, entry.follows], name);
      assert.equal(count(app, FRAME_RATE_REPLACED), 1, name);
      assert.deepEqual(notices(app), [], name);
      assert.equal(await startRequestFrameRate(app.page), '120', name);
      assert.deepEqual(app.errors, [], name);
    } finally {
      await app.context.close();
    }
  }
});

test('a partly customized existing install keeps its stored values, and only the unset ones are filled in', async () => {
  const app = await openExisting({ tv: 's90c', conn: 'ethernet' }, { videoCodec: 'H264', bitrate: '42', fullRange: true });
  try {
    const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4);
    assert.deepEqual(pick(stored, VIDEO_KEYS), {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: '42', videoCodec: 'H264',
      // HDR stays off for the stored H.264 codec, as the previous build showed it
      hdrMode: false, framePacing: true, fullRange: true, gameMode: false, autoAdjustBitrate: false,
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
    framePacing: false, fullRange: true, gameMode: true, autoAdjustBitrate: false,
  };
  // The removed switch 'Optimize bitrate presets', which an install of 2.1.0 had stored off
  const app = await openExisting({ tv: 'uhd', conn: 'wifi' }, Object.assign({ optimizeBitrate: false }, stored));
  try {
    const shown = await readVideoSettings(app.page);
    assert.deepEqual(
      [shown.resolution, shown.frameRate, shown.codec, shown.bitrate, shown.bitrateLabel, shown.hdr, shown.unlockAllFps, shown.framePacing,
        shown.fullRange, shown.gameMode, shown.autoAdjustBitrate],
      ['2560:1440', '90', 'AV1', '42.5', '42.5 Mbps', true, true, false, true, true, false]);
    // Nothing is rewritten on load, only the settings schema is added and the removed switch dropped
    await app.page.waitForTimeout(300);
    const values = await readStorage(app.page);
    assert.deepEqual(pick(values, VIDEO_KEYS), stored);
    assert.equal(values.settingsSchema, 4);
    assert.equal(Object.prototype.hasOwnProperty.call(values, 'optimizeBitrate'), false);
    assert.equal(await app.page.evaluate(() => document.getElementById('optimizeBitrateSwitch')), null);
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
      const stored = await waitForStorage(app.page, (values) => 'autoAdjustBitrate' in values && values.settingsSchema === 4);
      assert.equal(stored.autoAdjustBitrate, entry.follows, JSON.stringify(entry));
      assert.equal(await app.page.evaluate(() => autoAdjustBitrate), entry.follows, JSON.stringify(entry));
    } finally {
      await app.context.close();
    }
  }
});

test('settings schema 3 drops the removed switch \'Optimize bitrate presets\', and an install that had it on keeps the bitrate following', async () => {
  const cases = [
    // On, without a stored state of the presets: its optimized presets followed the video settings, now the recommended
    // bitrates do; the stored bitrate stays until the resolution or frame rate changes
    { stored: { optimizeBitrate: true, bitrate: '45' }, follows: true },
    // A stored state is never replaced
    { stored: { optimizeBitrate: true, autoAdjustBitrate: false, bitrate: '45' }, follows: false },
    { stored: { optimizeBitrate: false, autoAdjustBitrate: false, bitrate: '45' }, follows: false },
  ];
  for (const entry of cases) {
    // An install of settings schema 2 (2.1.0) on the S90C over Wi-Fi with 4K at 60 FPS
    const app = await openExisting({ tv: 's90c', conn: 'wifi' }, Object.assign({ settingsSchema: 2, resolution: '3840:2160', frameRate: 60 }, entry.stored));
    try {
      const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4 && !('optimizeBitrate' in values));
      assert.equal(stored.autoAdjustBitrate, entry.follows, JSON.stringify(entry));
      assert.equal(stored.bitrate, '45', JSON.stringify(entry));
      assert.equal(await app.page.evaluate(() => autoAdjustBitrate), entry.follows, JSON.stringify(entry));
      assert.ok(app.logs.some((line) => line.indexOf('Removing the stored value of a setting that no longer exists: optimizeBitrate = ' + entry.stored.optimizeBitrate) >= 0));
      // A change of the frame rate applies the recommended bitrate only while the bitrate follows the presets
      await app.page.evaluate(() => $('.videoFramerateMenu li[data-value="30"]').trigger('click'));
      await app.page.waitForFunction((follows) => $('#bitrateSlider').val() === (follows ? '50' : '45'), entry.follows, { timeout: 3000 });
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('an install that started with this build gets the new defaults and no snapshot', async () => {
  // A fresh install stores its unique ID together with the settings schema (loadHTTPCertsCb)
  const app = await openExisting({ tv: 'uhd', conn: 'wifi' }, { settingsSchema: 4 });
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
      assert.equal(stored.settingsSchema, 4, variant.name);
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
    const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4);
    assert.equal(stored.rumbleFeedback, false);
    assert.equal(await rumble(app.page), false);
    // Nothing else changes
    assert.equal(stored.framePacing, false);
    assert.ok(app.logs.some((line) => line.indexOf('Existing install of settings schema 2, storing the defaults of settings schema 2 that changed: {"rumbleFeedback":false}') >= 0));
    await reloadApp(app);
    assert.equal(await rumble(app.page), false);
    assert.equal(app.logs.filter((line) => line.indexOf('Existing install of settings schema 2, storing the defaults of settings schema 2') >= 0).length, 1, 'once');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
  // Switched on or off by the user: kept
  for (const value of [true, false]) {
    app = await openExisting({ tv: 's90c', conn: 'wifi' }, { settingsSchema: 2, rumbleFeedback: value });
    try {
      const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4);
      assert.equal(stored.rumbleFeedback, value);
      assert.equal(await rumble(app.page), value);
    } finally {
      await app.context.close();
    }
  }
});

test('a fresh install has the rumble and \'Optimize game settings\' on without storing them', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' } });
  try {
    await waitForStorage(app.page, (values) => values.settingsSchema === 4);
    assert.equal(await app.page.evaluate(() => document.getElementById('rumbleFeedbackSwitch').checked), true);
    assert.equal(await app.page.evaluate(() => document.getElementById('optimizeGamesSwitch').checked), true);
    await app.page.waitForTimeout(300);
    const stored = await readStorage(app.page);
    assert.equal('rumbleFeedback' in stored, false);
    assert.equal('optimizeGames' in stored, false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('an install of settings schema 3 keeps \'Optimize game settings\' off that it showed, and a stored value stays as it is', async () => {
  const sops = (page) => page.evaluate(() => document.getElementById('optimizeGamesSwitch').checked);
  // Never switched (2.2.1): the earlier default is stored once, and nothing of the snapshots of earlier schemas runs again,
  // so the rumble that it showed on stays on without being stored
  let app = await openExisting({ tv: 's90c', conn: 'wifi' }, { settingsSchema: 3, framePacing: false });
  try {
    const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4);
    assert.equal(stored.optimizeGames, false);
    assert.equal(await sops(app.page), false);
    assert.equal('rumbleFeedback' in stored, false);
    assert.equal(await app.page.evaluate(() => document.getElementById('rumbleFeedbackSwitch').checked), true);
    // Nothing else changes
    assert.equal(stored.framePacing, false);
    assert.ok(app.logs.some((line) => line.indexOf('Existing install of settings schema 3, storing the defaults of settings schema 3 that changed: {"optimizeGames":false}') >= 0));
    assert.equal(app.logs.filter((line) => line.indexOf('settings schema 2 that changed') >= 0).length, 0);
    await app.page.waitForTimeout(300);
    const afterFirstStart = await readStorage(app.page);
    await reloadApp(app);
    assert.equal(await sops(app.page), false);
    await app.page.waitForTimeout(300);
    assert.deepEqual(await readStorage(app.page), afterFirstStart, 'the second start stores nothing new');
    assert.equal(app.logs.filter((line) => line.indexOf('settings schema 3 that changed') >= 0).length, 1, 'once');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
  // Switched on or off by the user: kept
  for (const value of [true, false]) {
    app = await openExisting({ tv: 's90c', conn: 'wifi' }, { settingsSchema: 3, optimizeGames: value });
    try {
      const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 4);
      assert.equal(stored.optimizeGames, value);
      assert.equal(await sops(app.page), value);
    } finally {
      await app.context.close();
    }
  }
});
