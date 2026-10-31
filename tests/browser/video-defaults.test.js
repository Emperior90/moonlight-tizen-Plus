'use strict';

// The video settings on three simulated TVs over the three connection types: what a fresh install shows and stores,
// what the 'Optimal settings for this TV' button explains and applies, and what Restore Defaults applies to an install
// with customized settings. All three come from deriveOptimalSettings() in wasm/platform/tv_profile.js (plan WP2), and
// the dialog of the button names the model, what was detected and whether the model was tested (plan WP3).
//
// The S90C rows are the golden values of plan section 3 and must stay as they are. The other TVs get the values derived
// from their capabilities since plan WP2: the bitrate for their panel and connection (D6), 'Unlock all frame rates' off
// (D7) and HDR when the TV reports it (D8). On every TV, a fresh install, Restore Defaults and (since 2.2.0) the button
// let the bitrate follow the resolution and frame rate (D9). The dialog of the button shows the resolution, frame rate,
// bitrate and codec as tiles and lists only the other settings. A fresh install stores the settings
// schema with its unique ID, and an existing install gets a one-time snapshot instead (plan WP1, existing-install.test.js).

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  VIDEO_KEYS, openApp, pick, readOtherSettings, readStorage, readVideoSettings, startHarness, waitForStorage,
} = require('./harness');

const SETTINGS_LINE_UNLOCKED = 'Video frame pacing on, limited color range, unlock all frame rates on';
const SETTINGS_LINE_LOCKED = 'Video frame pacing on, limited color range, unlock all frame rates off';

// Per simulated TV (tests/browser/mocks/tv-mock.js): the resolution, HDR, frame rates, game mode and bitrate per
// connection it gets, and the dialog lines
const TVS = {
  // QE55S90CAT, 4K panel, HDR, Tizen 9.0: the golden values of plan section 3, through its tested profile
  s90c: {
    model: 'QE55S90CAT',
    resolution: '3840:2160',
    resolutionLabel: '3840 x 2160 (4K)',
    hdr: true,
    unlockAllFps: true,
    frameRateOptions: ['30', '60', '90', '120', '144'],
    gameMode: false,
    gameModeDisabled: false,
    storedGameMode: false,
    bitrates: { ethernet: '75', wifi: '100', unknown: '80' },
    settingsLine: SETTINGS_LINE_UNLOCKED,
    gameModeLine: false,
    forceGmHint: true,
    detected: '4K panel, HDR, Tizen 9.0',
    testedModel: true,
    hint120Hz: false,
    // The 100 Mbps over Wi-Fi already reach its tested decoder cap of 100 Mbps
    wifiRaiseLimit: null,
  },
  // Generic UHD TV with HDR on Tizen 6.5: the 80 Mbps cap of 4K TVs without a tested profile, and 60 FPS at most
  uhd: {
    model: 'QE55Q80BAT',
    resolution: '3840:2160',
    resolutionLabel: '3840 x 2160 (4K)',
    hdr: true,
    unlockAllFps: false,
    frameRateOptions: ['30', '60'],
    gameMode: true,
    gameModeDisabled: false,
    storedGameMode: true,
    bitrates: { ethernet: '75', wifi: '80', unknown: '80' },
    settingsLine: SETTINGS_LINE_LOCKED,
    gameModeLine: true,
    forceGmHint: false,
    detected: '4K panel, HDR, Tizen 6.5',
    testedModel: false,
    // The higher frame rates stay locked without a tested profile, and the dialog says how to unlock them (plan D7)
    hint120Hz: true,
    // The 80 Mbps over Wi-Fi already reach the decoder cap of 4K TVs without a tested profile
    wifiRaiseLimit: null,
  },
  // Full HD TV without HDR on Tizen 5.5, where the game mode switch is off and disabled and never stored, and the
  // bitrate stays within the 50 Mbps of Full HD decoders (25 Mbps at 1080p and 60 FPS, 20 Mbps for an unknown connection)
  fhd: {
    model: 'UE43T5300AU',
    resolution: '1920:1080',
    resolutionLabel: '1920 x 1080 (1080p)',
    hdr: false,
    unlockAllFps: false,
    frameRateOptions: ['30', '60'],
    gameMode: false,
    gameModeDisabled: true,
    storedGameMode: undefined,
    bitrates: { ethernet: '25', wifi: '25', unknown: '20' },
    settingsLine: SETTINGS_LINE_LOCKED,
    gameModeLine: false,
    forceGmHint: false,
    detected: 'Full HD panel, no HDR, Tizen 5.5',
    testedModel: false,
    hint120Hz: false,
    // Twice the 20 Mbps preset of 1080p at 60 FPS, within the 50 Mbps of Full HD decoders
    wifiRaiseLimit: 40,
  },
};

// Per connection type: how the dialog names it in its 'Detected:' line, and its advice
const CONNECTIONS = {
  ethernet: { label: 'Ethernet', advice: 'The TV is connected via Ethernet. Samsung TVs usually have a 100 Mbps Ethernet port, so' },
  wifi: { label: 'Wi-Fi', advice: 'The TV is connected via Wi-Fi. Use a 5 GHz network with a strong signal and connect the host PC by cable.' },
  unknown: { label: 'unknown connection', advice: 'The network connection type of the TV could not be detected, so a moderate bitrate will be applied.' },
};

// The hint of the dialog for the owners of a 4K or 8K TV with a 120 Hz panel, when the higher frame rates stay locked
const HINT_120HZ = 'If this TV has a 120 Hz panel, you can turn on \'Unlock all frame rates\' below the frame rate to stream at up to 120 FPS.';

// The bitrate advice of the dialog over Wi-Fi: up to a higher bitrate, or that it is already the highest recommended
const WIFI_RAISE_ADVICE = 'If the performance statistics show no dropped frames, you can raise the bitrate up to %s Mbps.';
const WIFI_AT_LIMIT_ADVICE = 'This is the highest bitrate recommended for the video decoder of this TV, so raise it only if the performance statistics show no dropped frames.';

// Customized settings of an existing install, every one different from what Restore Defaults applies
const CUSTOMIZED_SETTINGS = {
  uniqueid: '0123456789abcdef',
  cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' },
  resolution: '1280:720',
  frameRate: 30,
  bitrate: '33',
  videoCodec: 'H264',
  hdrMode: false,
  unlockAllFps: false,
  framePacing: false,
  fullRange: true,
  optimizeBitrate: true,
  autoAdjustBitrate: true,
  ipAddressFieldMode: false,
  sortAppsList: 'recent',
  optimizeGames: true,
  rumbleFeedback: false,
  mouseEmulation: true,
  controllerMappings: {
    version: 1,
    controllers: {
      '*': { name: '', buttons: [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
      'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product': {
        name: 'Xbox Wireless Controller',
        buttons: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 14],
        sticks: [{ centreX: 0.05, centreY: -0.02, minX: -0.9, maxX: 0.88, minY: -0.92, maxY: 0.95 }, null],
      },
    },
  },
  controllerType: 'PlayStation',
  audioBackend: 'WebAudio',
  audioConfig: '51Surround',
  audioSync: true,
  audioJitter: '50',
  audioClockSync: true,
  playHostAudio: true,
  decryptHostAudio: true,
  refFrameInvalidation: true,
  hdrMetadata: true,
  disableWarnings: true,
  performanceStats: 1,
  statsPosition: 'bottom-right',
};

// The other settings after Restore Defaults, as shown and as stored
const DEFAULT_OTHER_SETTINGS = {
  ipAddressFieldMode: true,
  sortAppsList: 'az',
  optimizeGames: false,
  // On since settings schema 3
  rumbleFeedback: true,
  mouseEmulation: false,
  // The button mapping and the stick calibration belong to the controllers and stay, like the hosts and the language
  controllerMappings: CUSTOMIZED_SETTINGS.controllerMappings,
  controllerType: 'Auto',
  audioBackend: 'EMSS',
  audioConfig: 'Stereo',
  audioSync: false,
  audioJitter: '100',
  audioClockSync: false,
  playHostAudio: false,
  decryptHostAudio: false,
  refFrameInvalidation: false,
  hdrMetadata: false,
  disableWarnings: false,
  performanceStats: 0,
  statsPosition: 'top-left',
};

// The video settings the settings screen shows on a fresh install, after the button and after Restore Defaults. The
// bitrate follows the resolution and frame rate (autoAdjustBitrate) after each of them.
function expectedVideoSettings(tv, connName, followsPresets) {
  return {
    resolution: tv.resolution,
    resolutionLabel: tv.resolutionLabel,
    frameRate: '60',
    frameRateOptions: tv.frameRateOptions,
    codec: 'HEVC',
    bitrate: tv.bitrates[connName],
    bitrateLabel: tv.bitrates[connName] + ' Mbps',
    hdr: tv.hdr,
    unlockAllFps: tv.unlockAllFps,
    framePacing: true,
    fullRange: false,
    gameMode: tv.gameMode,
    gameModeDisabled: tv.gameModeDisabled,
    autoAdjustBitrate: followsPresets,
  };
}

// The video settings the button and Restore Defaults store (the frame rate as a number, the bitrate as text)
function expectedStoredVideoSettings(tv, connName, followsPresets) {
  const stored = {
    resolution: tv.resolution,
    frameRate: 60,
    bitrate: tv.bitrates[connName],
    videoCodec: 'HEVC',
    hdrMode: tv.hdr,
    unlockAllFps: tv.unlockAllFps,
    framePacing: true,
    fullRange: false,
    gameMode: tv.storedGameMode,
    autoAdjustBitrate: followsPresets,
  };
  if (tv.storedGameMode === undefined) {
    delete stored.gameMode;
  }
  return stored;
}

// Whether all expected keys are stored with the expected values
function storedMatches(expected) {
  return (values) => Object.keys(expected).every((key) => JSON.stringify(values[key]) === JSON.stringify(expected[key]));
}

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

for (const tvName of Object.keys(TVS)) {
  const tv = TVS[tvName];
  describe(`${tvName} TV`, { concurrency: 3 }, () => {
    for (const connName of Object.keys(CONNECTIONS)) {
      const conn = CONNECTIONS[connName];

      test(`fresh install over ${connName}: settings shown, and only the schema and the bitrate preset state stored`, async () => {
        const app = await openApp(harness, { tv: { tv: tvName, conn: connName } });
        try {
          assert.deepEqual(await readVideoSettings(app.page), expectedVideoSettings(tv, connName, true));
          const stored = await waitForStorage(app.page, (values) => 'autoAdjustBitrate' in values && 'uniqueid' in values && 'cert' in values && 'settingsSchema' in values);
          // The defaults of a fresh install are worked out at every launch until the user changes them, and a later
          // change of a default is covered by the settings schema (plan WP1)
          await app.page.waitForTimeout(300);
          assert.deepEqual(Object.keys(await readStorage(app.page)).sort(), ['autoAdjustBitrate', 'cert', 'settingsSchema', 'uniqueid']);
          assert.equal(stored.settingsSchema, 3);
          // Plan D9: the bitrate of a fresh install follows the resolution and frame rate until the user picks one
          assert.equal(stored.autoAdjustBitrate, true);
          // The other settings show their defaults without being stored, e.g. the rumble on (settings schema 3)
          const other = await readOtherSettings(app.page);
          assert.deepEqual(Object.assign({}, other, { controllerMappings: null }),
            Object.assign({}, DEFAULT_OTHER_SETTINGS, { controllerMappings: null }));
          assert.deepEqual(other.controllerMappings, { version: 1, controllers: {} });
          assert.deepEqual(app.errors, []);
        } finally {
          await app.context.close();
        }
      });

      test(`optimal settings button over ${connName}: dialog and applied settings`, async () => {
        const app = await openApp(harness, { tv: { tv: tvName, conn: connName } });
        try {
          await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
          const dialog = await app.page.evaluate(() => ({
            title: document.getElementById('warningDialogTitle').innerHTML,
            text: document.getElementById('warningDialogText').innerHTML,
            open: isDialogOpen,
            continueShown: $('#continueWarning').css('display') !== 'none',
            tiles: Array.prototype.map.call(document.querySelectorAll('#warningDialogValues .value-tile'), (tile) =>
              [tile.querySelector('.value-number').textContent, tile.querySelector('.value-unit').textContent]),
          }));
          assert.equal(dialog.title, `Optimal settings for this TV (${tv.model})`);
          assert.equal(dialog.open, true);
          assert.equal(dialog.continueShown, true);
          const text = dialog.text;
          // What the settings are based on comes first, and a tested model says so at its end (plan WP3)
          assert.ok(text.indexOf(`Detected: ${tv.detected}, ${conn.label}${tv.testedModel ? ', tested model' : ''}<br>`) === 0, text);
          assert.ok(text.indexOf('Tested model') < 0, text);
          assert.ok(text.indexOf('The following streaming settings will be applied:<br>') >= 0, text);
          // The tiles show the resolution, frame rate, bitrate and codec, which the text doesn't repeat
          assert.deepEqual(dialog.tiles, [[tv.resolution === '3840:2160' ? '4K' : '1080p', tv.resolution.replace(':', ' x ')], ['60', 'FPS'],
            [tv.bitrates[connName], 'Mbps'], ['HEVC', tv.hdr ? 'HDR' : 'no HDR']]);
          ['Video resolution: ', 'Video codec: ', 'Video bitrate: '].forEach((line) => assert.ok(text.indexOf(line) < 0, line + text));
          assert.ok(text.indexOf(tv.settingsLine + '<br>') >= 0, text);
          assert.equal(text.indexOf('Ultra low latency mode on<br>') >= 0, tv.gameModeLine, text);
          assert.equal(text.indexOf(HINT_120HZ) >= 0, tv.hint120Hz, text);
          assert.ok(text.indexOf(conn.advice) >= 0, text);
          if (connName === 'wifi') {
            const advice = tv.wifiRaiseLimit === null ? WIFI_AT_LIMIT_ADVICE : WIFI_RAISE_ADVICE.replace('%s', tv.wifiRaiseLimit);
            assert.ok(text.indexOf(advice) >= 0, text);
          }
          assert.equal(text.indexOf('so install the ForceGM variant for the lowest latency') >= 0, tv.forceGmHint, text);
          // Plan WP3: no note that the TV is not an S90C, and the text names no model at all
          assert.ok(!/S90C/i.test(text), text);

          await app.page.evaluate(() => $('#continueWarning').trigger('click'));
          // After the button the bitrate follows later changes of the resolution and frame rate (since 2.2.0)
          const expectedStored = expectedStoredVideoSettings(tv, connName, true);
          const stored = await waitForStorage(app.page, storedMatches(expectedStored));
          assert.deepEqual(pick(stored, VIDEO_KEYS), expectedStored);
          assert.deepEqual(await readVideoSettings(app.page), expectedVideoSettings(tv, connName, true));
          assert.equal(await app.page.evaluate(() => isDialogOpen), false);
          assert.ok(app.logs.some((line) => line.indexOf('The optimal streaming settings for this TV have been applied.') >= 0));
          assert.deepEqual(app.errors, []);
        } finally {
          await app.context.close();
        }
      });

      test(`Restore Defaults over ${connName}: customized settings return to the defaults`, async () => {
        const customized = Object.assign({}, CUSTOMIZED_SETTINGS);
        if (tv.storedGameMode !== undefined) {
          customized.gameMode = !tv.storedGameMode;
        }
        const app = await openApp(harness, { tv: { tv: tvName, conn: connName }, stored: customized });
        try {
          // The customized settings are loaded as stored
          const loaded = await readVideoSettings(app.page);
          assert.deepEqual(
            [loaded.resolution, loaded.frameRate, loaded.frameRateOptions, loaded.codec, loaded.bitrate, loaded.hdr, loaded.unlockAllFps,
              loaded.framePacing, loaded.fullRange, loaded.autoAdjustBitrate],
            ['1280:720', '30', ['30', '60'], 'H264', '33', false, false, false, true, true]);
          // The removed switch 'Optimize bitrate presets', stored on, is dropped once
          assert.equal('optimizeBitrate' in (await readStorage(app.page)), false);
          if (tv.storedGameMode !== undefined) {
            assert.equal(loaded.gameMode, !tv.storedGameMode);
          }
          // The stored button mapping is loaded as it is
          assert.deepEqual((await readOtherSettings(app.page)).controllerMappings, CUSTOMIZED_SETTINGS.controllerMappings);

          await app.page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
          await app.page.evaluate(() => $('#continueRestoreDefaults').trigger('click'));
          // Restore Defaults is like a fresh install: the bitrate follows the resolution and frame rate (plan D9)
          const expectedStored = Object.assign(expectedStoredVideoSettings(tv, connName, true), DEFAULT_OTHER_SETTINGS);
          const stored = await waitForStorage(app.page, storedMatches(expectedStored));
          assert.deepEqual(pick(stored, Object.keys(expectedStored)), expectedStored);
          assert.deepEqual(await readVideoSettings(app.page), expectedVideoSettings(tv, connName, true));
          assert.deepEqual(await readOtherSettings(app.page), DEFAULT_OTHER_SETTINGS);
          assert.ok(app.logs.some((line) => line.indexOf('Settings have been restored to their default values.') >= 0));
          assert.deepEqual(app.errors, []);
        } finally {
          await app.context.close();
        }
      });
    }
  });
}
