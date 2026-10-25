'use strict';

// Tests of wasm/platform/tv_profile.js, loaded as a Node module (plan WP1 and WP2):
// - detectTvCapabilities() with the simulated TV, and with Tizen and Samsung APIs that fail or are missing (the checks of
//   the WASM player and the video decoders that it includes are tested in runtime-checks.test.js)
// - recommendedBitrate() and deriveOptimalSettings() over FHD / UHD / 8K panels x HDR yes / no x Tizen 5.5 to 9.0 x
//   Ethernet / Wi-Fi / unknown connection, checked against expectations written out here, not computed by the same rules
// - the golden S90C values of plan section 3, and that no result for a Full HD TV is above 50 Mbps
// - the frozen defaults of settings schema 1 and the one-time snapshot for existing installs
// - that index.html loads the file before index.js and that the build copies it into the widget

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const tvMock = require('../browser/mocks/tv-mock');
const profile = require('../../wasm/platform/tv_profile');

const CONNECTIONS = ['ethernet', 'wifi', 'unknown'];
const TIZEN_VERSIONS = ['5.5', '6.0', '6.5', '7.0', '8.0', '9.0'];
const PANELS = ['fhd', '4k', '8k'];
const RESOLUTIONS = Object.keys(profile.STANDARD_BITRATE_PRESETS);
const FRAME_RATES = [30, 60, 90, 120, 144];

// The simulated product APIs of a TV (see tests/browser/mocks/tv-mock.js), without a screen object
function apisFor(tvOptions) {
  const apis = tvMock.createTizenApis(tvMock.parseConfig('', tvOptions), (callback) => callback());
  return { tizen: apis.tizen, webapis: apis.webapis };
}

// Detect the capabilities of a simulated TV, keeping the warnings that the detection logs
function detect(tvOptions, extra) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = function() {
    warnings.push(Array.prototype.map.call(arguments, String).join(' '));
  };
  try {
    const caps = profile.detectTvCapabilities(Object.assign(apisFor(tvOptions), extra || {}));
    caps.warnings = warnings;
    return caps;
  } finally {
    console.warn = originalWarn;
  }
}

// What detectTvCapabilities() reports for the WASM player and the video decoders in Node, which has neither tizentvwasm
// nor MediaSource: the Ultra Low Latency mode is unknown and the decoder check isn't available
function checksWithoutTvBrowser() {
  const results = {};
  profile.VIDEO_DECODER_PROBES.forEach((probe) => {
    results[probe.mimeType] = 'unknown';
  });
  return {
    wasmPlayer: { ultraLowLatency: 'unknown', source: 'none', apiLevels: null },
    videoDecoders: { reliable: false, reason: 'unavailable', results, answers: {} },
  };
}

// A generic (untested) TV of the matrix: the model strings of the UHD preset, which match no tested profile
function genericTv(panel, hdr, tizen, conn) {
  return { tv: 'uhd', panel, hdr, tizen, conn: conn || 'wifi' };
}

// Expected recommended bitrate in Mbps at 60 FPS of the default resolution, per panel and connection (plan WP2 and
// section 3: a generic UHD TV at 4K60 gets 75 / 80 / 80, a Full HD TV at 1080p60 25 / 25 / 20)
const EXPECTED_DEFAULT_BITRATE = {
  fhd: { ethernet: 25, wifi: 25, unknown: 20 },
  '4k': { ethernet: 75, wifi: 80, unknown: 80 },
  '8k': { ethernet: 75, wifi: 80, unknown: 80 },
};

// Expected game mode per Tizen version: off on 9.0, left unset (off and disabled) on 5.5, on otherwise
const EXPECTED_GAME_MODE = { '5.5': null, '6.0': true, '6.5': true, '7.0': true, '8.0': true, '9.0': false };

describe('detectTvCapabilities()', () => {
  test('reads the simulated S90C', () => {
    const caps = detect({ tv: 's90c', conn: 'wifi' });
    assert.deepEqual(caps.warnings, []);
    delete caps.warnings;
    assert.equal(caps.profile.id, 'S90C');
    caps.profile = caps.profile.id;
    assert.deepEqual(caps, Object.assign({
      platformVer: '9.0', modelName: 'QE55S90CAT', modelSeries: '23_PONTUSM_OLED', modelCode: '23_PONTUSM',
      is4k: true, is8k: false, isHdr: true, maxWidth: 3840, maxHeight: 2160, connection: 'wifi', profile: 'S90C', modelYearHint: 2023,
    }, checksWithoutTvBrowser()));
  });

  test('reads the panel, HDR, Tizen version and connection of the other simulated TVs', () => {
    const summary = (caps) => [caps.platformVer, caps.is4k, caps.is8k, caps.isHdr, caps.maxWidth, caps.maxHeight, caps.connection, caps.profile, caps.modelYearHint];
    assert.deepEqual(summary(detect({ tv: 'uhd', conn: 'ethernet' })), ['6.5', true, false, true, 3840, 2160, 'ethernet', null, 2022]);
    assert.deepEqual(summary(detect({ tv: 'fhd', conn: 'unknown' })), ['5.5', false, false, false, 1920, 1080, 'unknown', null, 2020]);
    assert.deepEqual(summary(detect({ tv: '8k', conn: 'wifi' })), ['6.5', true, true, true, 7680, 4320, 'wifi', null, 2022]);
  });

  test('falls back to a Full HD TV without HDR and unknown model strings when the APIs are missing', () => {
    for (const apis of [{ tizen: null, webapis: null }, { tizen: {}, webapis: {} }, { tizen: { systeminfo: {} }, webapis: { productinfo: {}, avinfo: {} } }]) {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));
      let caps;
      try {
        caps = profile.detectTvCapabilities(apis);
      } finally {
        console.warn = originalWarn;
      }
      assert.deepEqual(caps, Object.assign({
        platformVer: null, modelName: null, modelSeries: null, modelCode: null, is4k: false, is8k: false, isHdr: false,
        maxWidth: 1920, maxHeight: 1080, connection: 'unknown', profile: null, modelYearHint: null,
      }, checksWithoutTvBrowser()), JSON.stringify(apis));
      assert.ok(warnings.length >= 5, 'each failed call is logged: ' + JSON.stringify(warnings));
    }
  });

  test('falls back for every API that throws, and keeps what the other APIs report', () => {
    const apis = apisFor({ tv: 's90c', conn: 'ethernet' });
    apis.webapis.productinfo.getRealModel = () => {
      throw new Error('Simulated missing privilege');
    };
    apis.webapis.avinfo.isHdrTvSupport = () => {
      throw new Error('Simulated avinfo failure');
    };
    apis.tizen.systeminfo.getCapability = () => {
      throw new Error('Simulated systeminfo failure');
    };
    const caps = detect({}, apis);
    assert.deepEqual([caps.platformVer, caps.modelName, caps.modelSeries, caps.is4k, caps.isHdr, caps.connection],
      [null, null, '23_PONTUSM_OLED', true, false, 'ethernet']);
    // The tested profile is still found through the model series
    assert.equal(caps.modelSeries, '23_PONTUSM_OLED');
    assert.equal(caps.warnings.length, 3, JSON.stringify(caps.warnings));
    assert.ok(caps.warnings.every((line) => line.indexOf('[tv_profile.js, safeTvCall]') >= 0));
  });

  test('a model name of null (reported by some firmware) is not an error', () => {
    const apis = apisFor({ tv: 'uhd' });
    apis.webapis.productinfo.getRealModel = () => null;
    const caps = detect({}, apis);
    assert.equal(caps.modelName, null);
    assert.deepEqual(caps.warnings, []);
  });

  test('a firmware without the panel checks counts as a Full HD panel', () => {
    const apis = apisFor({ tv: 'uhd' });
    delete apis.webapis.productinfo.isUdPanelSupported;
    delete apis.webapis.productinfo.is8KPanelSupported;
    const caps = detect({}, apis);
    assert.deepEqual([caps.is4k, caps.is8k, caps.maxWidth], [false, false, 1920]);
    assert.deepEqual(caps.warnings, []);
  });

  test('a screen of 1440p widens the resolution menu of a non-4K TV, but not its defaults', () => {
    const caps = detect({ tv: 'fhd', conn: 'wifi' }, { screen: { width: 2560, height: 1440 } });
    assert.deepEqual([caps.maxWidth, caps.maxHeight], [2560, 1440]);
    const optimal = profile.deriveOptimalSettings(caps, 'wifi');
    assert.deepEqual([optimal.resolution, optimal.bitrate], ['1920:1080', 25]);
  });

  test('the model year hint comes from the model code, and never changes a setting', () => {
    assert.equal(profile.getModelYearHint('23_PONTUSM'), 2023);
    assert.equal(profile.getModelYearHint('20_KANTM2'), 2020);
    assert.equal(profile.getModelYearHint('PONTUSM'), null);
    assert.equal(profile.getModelYearHint(null), null);
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const caps = detect({ tv });
      for (const conn of CONNECTIONS) {
        const withoutHint = Object.assign({}, caps, { modelYearHint: null });
        const otherYear = Object.assign({}, caps, { modelYearHint: 2025 });
        assert.deepEqual(profile.deriveOptimalSettings(caps, conn), profile.deriveOptimalSettings(withoutHint, conn), tv + ' ' + conn);
        assert.deepEqual(profile.deriveOptimalSettings(caps, conn), profile.deriveOptimalSettings(otherYear, conn), tv + ' ' + conn);
      }
    }
  });
});

describe('the tested profiles', () => {
  test('the S90C profile is matched by the model name or the model series, in any size or region', () => {
    for (const [modelName, modelSeries] of [['QE55S90CAT', '23_PONTUSM_OLED'], ['qe65s90caexxu', null], [null, '23_S90C_OLED'], ['QN77S90CAFXZA', 'x']]) {
      const match = profile.findVerifiedProfile(modelName, modelSeries);
      assert.ok(match && match.id === 'S90C', modelName + ' / ' + modelSeries);
    }
    for (const [modelName, modelSeries] of [['QE55S95CAT', '23_PONTUSM_OLED'], ['QE55Q80BAT', '22_PONTUSM_QTV'], [null, null], ['', '']]) {
      assert.equal(profile.findVerifiedProfile(modelName, modelSeries), null, modelName + ' / ' + modelSeries);
    }
  });

  test('the S90C profile holds its tested values and can not be changed at run time', () => {
    const s90c = profile.VERIFIED_PROFILES.find((entry) => entry.id === 'S90C');
    assert.deepEqual([s90c.unlockAllFps, s90c.decoderCapMbps, s90c.refresh120], [true, 100, true]);
    assert.ok(Object.isFrozen(s90c));
    assert.ok(Object.isFrozen(profile.VERIFIED_PROFILES));
  });
});

describe('recommendedBitrate()', () => {
  test('gives the values of plan section 3', () => {
    const s90c = detect({ tv: 's90c' });
    const uhd = detect({ tv: 'uhd' });
    const fhd = detect({ tv: 'fhd' });
    const at = (res, fps, caps) => CONNECTIONS.map((conn) => profile.recommendedBitrate(res, fps, conn, caps));
    assert.deepEqual(at('3840:2160', 60, s90c), [75, 100, 80], 'S90C at 4K60');
    assert.deepEqual(at('3840:2160', 120, s90c), [75, 100, 80], 'S90C at 4K120');
    assert.deepEqual(at('3840:2160', 60, uhd), [75, 80, 80], 'generic UHD TV at 4K60');
    assert.deepEqual(at('1920:1080', 60, fhd), [25, 25, 20], 'Full HD TV at 1080p60');
    assert.deepEqual(at('2560:1440', 60, uhd), [50, 50, 40], 'UHD TV at 1440p60');
  });

  test('follows the formula of plan WP2 for every resolution, frame rate and connection', () => {
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const caps = detect({ tv });
      const cap = tv === 's90c' ? 100 : (tv === 'fhd' ? 50 : 80);
      for (const res of RESOLUTIONS) {
        for (const fps of FRAME_RATES) {
          const preset = profile.STANDARD_BITRATE_PRESETS[res][String(fps)];
          const label = [tv, res, fps].join(' ');
          assert.equal(profile.recommendedBitrate(res, fps, 'ethernet', caps), Math.min(Math.round(preset * 1.25), 75, cap), label + ' ethernet');
          assert.equal(profile.recommendedBitrate(res, fps, 'wifi', caps), Math.min(Math.round(preset * 1.25), cap), label + ' wifi');
          assert.equal(profile.recommendedBitrate(res, fps, 'unknown', caps), Math.min(preset, cap, 80), label + ' unknown');
        }
      }
    }
  });

  test('never goes above 75 Mbps over Ethernet, 80 Mbps for an unknown connection or the decoder cap of the TV', () => {
    for (const caps of [detect({ tv: 's90c' }), detect({ tv: 'uhd' }), detect({ tv: 'fhd' }), detect({ tv: '8k' })]) {
      const decoderCap = profile.getDecoderCapMbps(caps);
      for (const res of RESOLUTIONS) {
        for (const fps of FRAME_RATES) {
          const label = [caps.modelName, res, fps].join(' ');
          assert.ok(profile.recommendedBitrate(res, fps, 'ethernet', caps) <= 75, label);
          assert.ok(profile.recommendedBitrate(res, fps, 'unknown', caps) <= 80, label);
          for (const conn of CONNECTIONS) {
            const bitrate = profile.recommendedBitrate(res, fps, conn, caps);
            assert.ok(bitrate > 0 && bitrate <= decoderCap, label + ' ' + conn + ': ' + bitrate);
          }
        }
      }
    }
  });

  test('no result for a Full HD TV is above 50 Mbps, whatever is selected (plan WP2)', () => {
    let checked = 0;
    for (const hdr of [true, false]) {
      for (const tizen of TIZEN_VERSIONS) {
        const caps = detect(genericTv('fhd', hdr, tizen, 'wifi'));
        for (const res of RESOLUTIONS.concat(['7680:4320', '1000:1000'])) {
          for (const fps of FRAME_RATES.concat([75])) {
            for (const conn of CONNECTIONS.concat(['bogus', undefined])) {
              const bitrate = profile.recommendedBitrate(res, fps, conn, caps);
              assert.ok(bitrate <= 50, [hdr, tizen, res, fps, conn, bitrate].join(' '));
              checked++;
            }
          }
          for (const conn of CONNECTIONS) {
            assert.ok(profile.deriveOptimalSettings(caps, conn).bitrate <= 50);
          }
        }
      }
    }
    assert.ok(checked > 1000);
  });

  test('a frame rate without a preset uses the 60 FPS preset, an unknown resolution 10 Mbps', () => {
    const uhd = detect({ tv: 'uhd' });
    assert.equal(profile.recommendedBitrate('3840:2160', 75, 'wifi', uhd), 80);
    assert.equal(profile.recommendedBitrate('1000:1000', 60, 'wifi', uhd), 13);
    assert.equal(profile.recommendedBitrate('1000:1000', 60, 'unknown', uhd), 10);
  });
});

describe('deriveOptimalSettings() over FHD / UHD / 8K x HDR x Tizen 5.5 to 9.0 x connection (plan WP2)', () => {
  for (const panel of PANELS) {
    for (const hdr of [true, false]) {
      for (const tizen of TIZEN_VERSIONS) {
        test(`${panel} panel, HDR ${hdr ? 'yes' : 'no'}, Tizen ${tizen}`, () => {
          for (const conn of CONNECTIONS) {
            const caps = detect(genericTv(panel, hdr, tizen, conn));
            assert.equal(caps.connection, conn);
            assert.equal(caps.profile, null);
            assert.deepEqual(profile.deriveOptimalSettings(caps, conn), {
              resolution: panel === 'fhd' ? '1920:1080' : '3840:2160',
              frameRate: 60,
              videoCodec: 'HEVC',
              hdrMode: hdr,
              bitrate: EXPECTED_DEFAULT_BITRATE[panel][conn],
              // Plan D7: off for every TV without a tested profile
              unlockAllFps: false,
              gameMode: EXPECTED_GAME_MODE[tizen],
              framePacing: true,
              fullRange: false,
              optimizeBitrate: false,
            }, conn);
          }
        });
      }
    }
  }

  test('without any capabilities, the defaults of a Full HD TV', () => {
    assert.deepEqual(profile.deriveOptimalSettings(null, undefined), {
      resolution: '1920:1080', frameRate: 60, videoCodec: 'HEVC', hdrMode: false, bitrate: 20, unlockAllFps: false, gameMode: true,
      framePacing: true, fullRange: false, optimizeBitrate: false,
    });
  });
});

describe('the golden S90C values (plan section 3)', () => {
  const GOLDEN_BITRATE = { ethernet: 75, wifi: 100, unknown: 80 };

  for (const conn of CONNECTIONS) {
    test(`S90C (QE55S90CAT, 4K, HDR, Tizen 9.0) over ${conn}`, () => {
      const caps = detect({ tv: 's90c', conn });
      assert.deepEqual(profile.deriveOptimalSettings(caps, conn), {
        resolution: '3840:2160',
        frameRate: 60,
        videoCodec: 'HEVC',
        hdrMode: true,
        bitrate: GOLDEN_BITRATE[conn],
        unlockAllFps: true,
        gameMode: false,
        framePacing: true,
        fullRange: false,
        optimizeBitrate: false,
      });
    });
  }

  test('the S90C profile also applies before the update to Tizen 9.0 and with the model found by its series', () => {
    const tizen7 = detect({ tv: 's90c', tizen: '7.0' });
    assert.deepEqual(CONNECTIONS.map((conn) => profile.deriveOptimalSettings(tizen7, conn).bitrate), [75, 100, 80]);
    assert.equal(profile.deriveOptimalSettings(tizen7, 'wifi').gameMode, true);
    const bySeries = detect({ tv: 'uhd', model: 'UNKNOWN', series: '23_S90C_OLED' });
    assert.equal(profile.deriveOptimalSettings(bySeries, 'wifi').unlockAllFps, true);
    assert.equal(profile.deriveOptimalSettings(bySeries, 'wifi').bitrate, 100);
  });
});

describe('the frozen defaults of settings schema 1 (plan WP1)', () => {
  test('ignore the resolution and the TV for the bitrate: 75 / 100 / 80 Mbps, with all frame rates unlocked', () => {
    assert.ok(Object.isFrozen(profile.LEGACY_DEFAULT_BITRATES));
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const caps = detect({ tv });
      assert.deepEqual(CONNECTIONS.map((conn) => profile.legacyDefaults(caps, conn, null).bitrate), [75, 100, 80], tv);
      assert.equal(profile.legacyDefaults(caps, 'bogus', null).bitrate, 80, tv);
      assert.equal(profile.legacyDefaults(caps, 'toString', null).bitrate, 80, tv);
      assert.equal(profile.legacyDefaults(caps, 'wifi', null).unlockAllFps, true, tv);
    }
  });

  test('are the values that the fresh installs of the previous build showed', () => {
    assert.deepEqual(profile.legacyDefaults(detect({ tv: 's90c' }), 'wifi', null), {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: 100, videoCodec: 'HEVC', hdrMode: true, framePacing: true,
      fullRange: false, optimizeBitrate: false, gameMode: false,
    });
    assert.deepEqual(profile.legacyDefaults(detect({ tv: 'uhd' }), 'unknown', null), {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: 80, videoCodec: 'HEVC', hdrMode: true, framePacing: true,
      fullRange: false, optimizeBitrate: false, gameMode: true,
    });
    assert.deepEqual(profile.legacyDefaults(detect({ tv: 'fhd' }), 'ethernet', null), {
      resolution: '1920:1080', unlockAllFps: true, frameRate: 60, bitrate: 75, videoCodec: 'HEVC', hdrMode: false, framePacing: true,
      fullRange: false, optimizeBitrate: false, gameMode: null,
    });
  });

  test('keep HDR off for a stored H.264 codec and the 1440p resolution of a wide screen', () => {
    const s90c = detect({ tv: 's90c' });
    assert.equal(profile.legacyDefaults(s90c, 'wifi', 'H264').hdrMode, false);
    assert.equal(profile.legacyDefaults(s90c, 'wifi', 'AV1').hdrMode, true);
    assert.equal(profile.legacyDefaults(detect({ tv: 'fhd' }, { screen: { width: 2560, height: 1440 } }), 'wifi', null).resolution, '2560:1440');
    assert.equal(profile.legacyOptimalResolution(7680), '3840:2160');
    assert.equal(profile.legacyOptimalResolution(undefined), '1920:1080');
  });
});

describe('followsBitratePresets()', () => {
  test('decides like the previous build whether a stored bitrate came from the presets', () => {
    const cases = [
      // A stored standard preset keeps following the video settings
      [{ bitrate: '80', resolution: '3840:2160', frameRate: 60 }, 'wifi', true],
      // Over Ethernet the 4K preset was limited to 75 Mbps, which counts as the preset too
      [{ bitrate: '75', resolution: '3840:2160', frameRate: 60 }, 'ethernet', true],
      [{ bitrate: '75', resolution: '3840:2160', frameRate: 60 }, 'wifi', false],
      // A bitrate that differs from the preset was picked by hand (or by the button) and is kept
      [{ bitrate: '100', resolution: '3840:2160', frameRate: 60 }, 'wifi', false],
      // The optimized presets always follow the video settings
      [{ bitrate: '33', resolution: '3840:2160', frameRate: 60, optimizeBitrate: true }, 'wifi', true],
      // Without a stored resolution or frame rate the preset is unknown, so the bitrate is kept
      [{ bitrate: '80', frameRate: 60 }, 'wifi', false],
      [{ bitrate: '80', resolution: '3840:2160' }, 'wifi', false],
      [{}, 'wifi', false],
      [null, 'wifi', false],
    ];
    for (const [stored, conn, expected] of cases) {
      assert.equal(profile.followsBitratePresets(stored, conn), expected, JSON.stringify([stored, conn]));
    }
  });
});

describe('legacySettingsSnapshot() (plan WP1)', () => {
  test('stores every unset video setting of an existing S90C install as the previous build showed it', () => {
    assert.deepEqual(profile.legacySettingsSnapshot({ uniqueid: 'x' }, detect({ tv: 's90c' }), 'wifi'), {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: '100', videoCodec: 'HEVC', hdrMode: true, framePacing: true,
      fullRange: false, gameMode: false, optimizeBitrate: false, autoAdjustBitrate: false,
    });
  });

  test('leaves the game mode out on Tizen 5.5, where a stored value would enable its switch (plan K2)', () => {
    const snapshot = profile.legacySettingsSnapshot({}, detect({ tv: 'fhd' }), 'ethernet');
    assert.equal('gameMode' in snapshot, false);
    assert.deepEqual(snapshot, {
      resolution: '1920:1080', unlockAllFps: true, frameRate: 60, bitrate: '75', videoCodec: 'HEVC', hdrMode: false, framePacing: true,
      fullRange: false, optimizeBitrate: false, autoAdjustBitrate: false,
    });
    for (const tizen of ['6.0', '6.5', '7.0', '8.0']) {
      assert.equal(profile.legacySettingsSnapshot({}, detect(genericTv('4k', true, tizen)), 'wifi').gameMode, true, tizen);
    }
  });

  test('never replaces a stored value, including false and 0', () => {
    const stored = {
      resolution: '1280:720', unlockAllFps: false, frameRate: 30, bitrate: '0.5', videoCodec: 'AV1', hdrMode: false, framePacing: false,
      fullRange: true, gameMode: false, optimizeBitrate: false, autoAdjustBitrate: false,
    };
    assert.deepEqual(profile.legacySettingsSnapshot(stored, detect({ tv: 's90c' }), 'wifi'), {});
    assert.deepEqual(profile.legacySettingsSnapshot({ hdrMode: false, frameRate: 0 }, detect({ tv: 's90c' }), 'wifi').hdrMode, undefined);
  });

  test('keeps a stored 120 FPS reachable by storing the unlocked frame rates (the trap of plan K1)', () => {
    const snapshot = profile.legacySettingsSnapshot({ frameRate: 120 }, detect({ tv: 'uhd' }), 'wifi');
    assert.equal(snapshot.unlockAllFps, true);
    assert.equal('frameRate' in snapshot, false);
  });

  test('takes HDR from the stored codec and the preset state from the stored bitrate', () => {
    const s90c = detect({ tv: 's90c' });
    const h264 = profile.legacySettingsSnapshot({ videoCodec: 'H264', bitrate: '42' }, s90c, 'wifi');
    assert.deepEqual([h264.hdrMode, h264.videoCodec, h264.bitrate, h264.autoAdjustBitrate], [false, undefined, undefined, false]);
    const preset = profile.legacySettingsSnapshot({ bitrate: '75', resolution: '3840:2160', frameRate: 60 }, s90c, 'ethernet');
    assert.equal(preset.autoAdjustBitrate, true);
    assert.equal(profile.legacySettingsSnapshot({ autoAdjustBitrate: true }, s90c, 'wifi').autoAdjustBitrate, undefined);
  });

  test('decides the preset state for a stored resolution above the panel like the previous build, after replacing it', () => {
    // The previous build loaded a stored 4K resolution as 1080p on a Full HD TV and stored that before it compared the
    // stored bitrate with the preset, so the 4K preset of 80 Mbps counted as picked by hand
    const fhd = detect({ tv: 'fhd' });
    assert.equal(profile.legacySettingsSnapshot({ resolution: '3840:2160', frameRate: 60, bitrate: '80' }, fhd, 'wifi').autoAdjustBitrate, false);
    assert.equal(profile.legacySettingsSnapshot({ resolution: '3840:2160', frameRate: 60, bitrate: '20' }, fhd, 'wifi').autoAdjustBitrate, true);
    assert.equal(profile.legacySettingsSnapshot({ resolution: '2560:1440', frameRate: 60, bitrate: '40' }, fhd, 'unknown').autoAdjustBitrate, false);
    // A resolution within the menu is used as stored, and the snapshot never stores the replaced resolution itself
    const s90c = detect({ tv: 's90c' });
    assert.equal(profile.legacySettingsSnapshot({ resolution: '3840:2160', frameRate: 60, bitrate: '80' }, s90c, 'wifi').autoAdjustBitrate, true);
    assert.equal('resolution' in profile.legacySettingsSnapshot({ resolution: '3840:2160' }, fhd, 'wifi'), false);
    assert.deepEqual(
      [profile.legacyLoadedResolution('7680:4320', 3840), profile.legacyLoadedResolution('3840:2160', 2560), profile.legacyLoadedResolution('2560:1440', 2560),
        profile.legacyLoadedResolution(null, 1920)],
      ['3840:2160', '1920:1080', '2560:1440', null]);
  });

  test('stores only the video settings of the snapshot list', () => {
    const snapshot = profile.legacySettingsSnapshot({ uniqueid: 'x', cert: {}, settingsSchema: null }, detect({ tv: 'uhd' }), 'wifi');
    assert.deepEqual(Object.keys(snapshot).sort(), profile.LEGACY_SNAPSHOT_KEYS.slice().sort());
    assert.ok(Object.isFrozen(profile.LEGACY_SNAPSHOT_KEYS));
  });

  test('the settings schema is version 2', () => {
    assert.equal(profile.SETTINGS_SCHEMA_VERSION, 2);
    assert.equal(profile.SETTINGS_SCHEMA_KEY, 'settingsSchema');
  });
});

describe('wiring into the widget', () => {
  const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

  test('index.html loads tv_profile.js after the Samsung APIs and before index.js', () => {
    const html = read('wasm/index.html');
    const scripts = [];
    const pattern = /<script\b[^>]*\bsrc="([^"]+)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      scripts.push(match[1]);
    }
    const profileIndex = scripts.indexOf('platform/tv_profile.js');
    assert.ok(profileIndex >= 0, JSON.stringify(scripts));
    assert.ok(profileIndex > scripts.indexOf('$WEBAPIS/webapis/webapis.js'), JSON.stringify(scripts));
    assert.ok(profileIndex < scripts.indexOf('platform/index.js'), JSON.stringify(scripts));
    assert.equal(scripts.filter((src) => src === 'platform/tv_profile.js').length, 1);
  });

  test('the build copies the whole platform folder, and with it tv_profile.js, into the widget', () => {
    assert.ok(/^install\(DIRECTORY wasm\/platform DESTINATION widget\)$/m.test(read('CMakeLists.txt')));
    assert.ok(/^COPY --chown=moonlight wasm\/platform\/ \.\/moonlight-tizen\/wasm\/platform\/$/m.test(read('Dockerfile')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'wasm', 'platform', 'tv_profile.js')));
  });
});
