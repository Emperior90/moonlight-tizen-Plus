'use strict';

// Tests of wasm/platform/tv_profile.js, loaded as a Node module:
// - detectTvCapabilities() with the simulated TV, and with Tizen and Samsung APIs that fail or are missing (the checks of
//   the WASM player and the video decoders that it includes are tested in runtime-checks.test.js)
// - recommendedBitrate() and deriveOptimalSettings() over FHD / UHD / 8K panels x HDR yes / no x Tizen 5.5 to 9.0 x
//   Ethernet / Wi-Fi / unknown connection, checked against expectations written out here, not computed by the same rules
// - the golden S90C values, which must stay as they are, and that no result for a Full HD TV is above 50 Mbps
// - the frozen defaults of settings schema 1 and 2 and the one-time snapshots for existing installs
// - the frame rates of the frame rate menu, which lost 144 FPS in 2.2.1, the replacement of a stored 144 FPS, and the
//   decision on a bitrate stored next to 144 FPS, which stays as it was
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
// The frame rates of the frame rate menu with 'Unlock all frame rates' on; 144 FPS is gone since 2.2.1
const FRAME_RATES = [30, 60, 90, 120];

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
    wasmPlayerReport: { version: null, features: null, supported: null },
    videoDecoders: { reliable: false, reason: 'unavailable', results, answers: {} },
  };
}

// A generic (untested) TV of the matrix: the model strings of the UHD preset, which match no tested profile
function genericTv(panel, hdr, tizen, conn) {
  return { tv: 'uhd', panel, hdr, tizen, conn: conn || 'wifi' };
}

// Expected recommended bitrate in Mbps at 60 FPS of the default resolution, per panel and connection (a
// generic UHD TV at 4K60 gets 75 / 80 / 80, a Full HD TV at 1080p60 25 / 25 / 20)
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
      firmware: { version: 'T-INFOLINK2023-1020', source: 'productinfo' },
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
        firmware: { version: null, source: null },
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

  test('the firmware version comes from the product information, else from the build string of Tizen, else is unknown', () => {
    assert.deepEqual(detect({ tv: 'uhd' }).firmware, { version: 'T-INFOLINK2022-1030', source: 'productinfo' });
    // Surrounding white space is left out
    assert.deepEqual(detect({ tv: 'uhd', firmware: ' T-INFOLINK2022-1031 ' }).firmware, { version: 'T-INFOLINK2022-1031', source: 'productinfo' });
    // getFirmware() fails, is missing or answers nothing usable: the build string of Tizen, logged once as a warning
    const failing = detect({ tv: 'fhd', buildString: 'T-KANTM2-1234.5', failApis: 'webapis.productinfo.getFirmware' });
    assert.deepEqual(failing.firmware, { version: 'T-KANTM2-1234.5', source: 'build' });
    assert.equal(failing.warnings.length, 1, JSON.stringify(failing.warnings));
    assert.match(failing.warnings[0], /Failed to get the TV firmware version/);
    for (const firmware of ['', '   ']) {
      const blank = detect({ tv: 'fhd', firmware, buildString: 'T-KANTM2-1234.5' });
      assert.deepEqual(blank.firmware, { version: 'T-KANTM2-1234.5', source: 'build' }, JSON.stringify(firmware));
      assert.deepEqual(blank.warnings, []);
    }
    const missing = apisFor({ tv: 'fhd', buildString: 'T-KANTM2-1234.5' });
    delete missing.webapis.productinfo.getFirmware;
    assert.deepEqual(detect({}, missing).firmware, { version: 'T-KANTM2-1234.5', source: 'build' });
    // Neither: unknown
    const neither = detect({ tv: 'fhd', failApis: 'webapis.productinfo.getFirmware,tizen.systeminfo.getCapability' });
    assert.deepEqual(neither.firmware, { version: null, source: null });
    assert.deepEqual(profile.detectFirmwareVersion(null, null), { version: null, source: null });
    assert.deepEqual(profile.detectFirmwareVersion({ productinfo: { getFirmware: () => 42 } }, { systeminfo: { getCapability: () => null } }),
      { version: null, source: null });
    // The firmware version is only shown: it never changes a setting
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const caps = detect({ tv });
      const otherFirmware = Object.assign({}, caps, { firmware: { version: null, source: null } });
      for (const conn of CONNECTIONS) {
        assert.deepEqual(profile.deriveOptimalSettings(caps, conn), profile.deriveOptimalSettings(otherFirmware, conn), tv + ' ' + conn);
      }
    }
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
    // The presets stop at 100 Mbps, and the warning starts above the 150 Mbps that it streams over 5 GHz Wi-Fi
    assert.deepEqual([s90c.unlockAllFps, s90c.decoderCapMbps, s90c.warnAboveMbps, s90c.refresh120], [true, 100, 150, true]);
    assert.ok(Object.isFrozen(s90c));
    assert.ok(Object.isFrozen(profile.VERIFIED_PROFILES));
  });
});

describe('getBitrateWarningMbps()', () => {
  test('is 150 Mbps on the S90C and the decoder cap on every other TV', () => {
    for (const [tv, warning, cap] of [['s90c', 150, 100], ['uhd', 80, 80], ['8k', 80, 80], ['fhd', 50, 50]]) {
      const caps = detect({ tv });
      assert.equal(profile.getBitrateWarningMbps(caps), warning, tv);
      assert.equal(profile.getDecoderCapMbps(caps), cap, tv);
    }
    // A profile without a warning threshold of its own warns at its decoder cap, and so does a TV without capabilities
    assert.equal(profile.getBitrateWarningMbps({ profile: { decoderCapMbps: 90 }, is4k: true }), 90);
    assert.equal(profile.getBitrateWarningMbps(null), profile.FHD_DECODER_CAP_MBPS);
  });

  test('changes no bitrate that the presets and the optimal settings give the S90C', () => {
    const s90c = detect({ tv: 's90c' });
    const optimal = (conn) => profile.deriveOptimalSettings(s90c, conn).bitrate;
    assert.deepEqual([optimal('ethernet'), optimal('wifi'), optimal('unknown')], [75, 100, 80]);
    for (const res of RESOLUTIONS) {
      for (const fps of FRAME_RATES) {
        assert.ok(profile.presetBitrate(res, fps, 'wifi', s90c) <= 100, res + '@' + fps);
      }
    }
  });
});

describe('recommendedBitrate()', () => {
  test('gives the golden S90C values', () => {
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

  test('follows the formula of the recommended bitrate for every resolution, frame rate and connection', () => {
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

  test('no result for a Full HD TV is above 50 Mbps, whatever is selected', () => {
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

describe('the bitrate presets', () => {
  test('give the recommended bitrate of every resolution and frame rate, as the bitrate slider holds it', () => {
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const caps = detect({ tv });
      for (const res of RESOLUTIONS) {
        for (const fps of FRAME_RATES) {
          for (const conn of CONNECTIONS) {
            const recommended = profile.recommendedBitrate(res, fps, conn, caps);
            assert.equal(profile.presetBitrate(res, fps, conn, caps), profile.sliderBitrate(recommended), [tv, res, fps, conn].join(' '));
          }
        }
      }
    }
    // Up to the end of the slider at 250 Mbps (150 Mbps before 2.2.0), so that e.g. 200 Mbps stays 200 Mbps
    assert.deepEqual([0.01, 4.492, 4.75, 35.936, 149.9, 200.2, 249.8, 300].map(profile.sliderBitrate), [0.5, 4.5, 5, 36, 150, 200, 250, 250]);
  });

  test('the highest bitrate is 250 Mbps, the end of the slider of index.html, while the presets stay at the decoder caps', () => {
    assert.equal(profile.MAX_BITRATE_MBPS, 250);
    const html = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'index.html'), 'utf8');
    const slider = /<input type="range" id="bitrateSlider"[^>]*>/.exec(html);
    assert.ok(slider, 'the bitrate slider in index.html');
    assert.match(slider[0], /\smin="0\.5"/);
    assert.match(slider[0], /\smax="250"/);
    assert.match(slider[0], /\sstep="0\.5"/);
    assert.match(html, /<span id="bitrateHighestValue">250<\/span>/);
    // The careful defaults don't follow the slider: no preset and no optimal setting goes above the decoder cap
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const caps = detect({ tv });
      for (const res of RESOLUTIONS) {
        for (const fps of FRAME_RATES) {
          for (const conn of CONNECTIONS) {
            assert.ok(profile.presetBitrate(res, fps, conn, caps) <= profile.getDecoderCapMbps(caps), [tv, res, fps, conn].join(' '));
          }
        }
      }
      for (const conn of CONNECTIONS) {
        assert.ok(profile.deriveOptimalSettings(caps, conn).bitrate <= profile.getDecoderCapMbps(caps), tv + ' ' + conn);
      }
    }
  });

  test('at the resolution and frame rate of the optimal settings, the preset is their bitrate', () => {
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const caps = detect({ tv });
      for (const conn of CONNECTIONS) {
        const optimal = profile.deriveOptimalSettings(caps, conn);
        assert.equal(profile.presetBitrate(optimal.resolution, optimal.frameRate, conn, caps), optimal.bitrate, tv + ' ' + conn);
      }
    }
  });

  test('a trip to another resolution and back gives the same bitrate again (the 1440p trip of the review)', () => {
    const s90c = detect({ tv: 's90c' });
    // The standard presets of 2.1.0 gave 40 Mbps at 1440p and then 80 instead of 100 Mbps back at 4K on Wi-Fi
    assert.equal(profile.presetBitrate('3840:2160', '60', 'wifi', s90c), 100);
    assert.equal(profile.presetBitrate('2560:1440', '60', 'wifi', s90c), 50);
    assert.equal(profile.presetBitrate('3840:2160', '60', 'wifi', s90c), 100);
  });

  test('stay within 75 Mbps over Ethernet, 80 Mbps for an unknown connection and the decoder cap of every TV', () => {
    const at = (res, fps, caps) => CONNECTIONS.map((conn) => profile.presetBitrate(res, fps, conn, caps));
    // The S90C at 4K above 60 FPS: its decoder cap of 100 Mbps over Wi-Fi, which the standard presets of 2.1.0 went past
    // (120 Mbps at 120 FPS)
    for (const fps of ['90', '120']) {
      assert.deepEqual(at('3840:2160', fps, detect({ tv: 's90c' })), [75, 100, 80], 'S90C at 4K and ' + fps + ' FPS');
    }
    assert.deepEqual(at('3840:2160', '120', detect({ tv: 'uhd' })), [75, 80, 80], '4K TV at 4K and 120 FPS');
    assert.deepEqual(at('1920:1080', '60', detect({ tv: 'fhd' })), [25, 25, 20], 'Full HD TV at 1080p and 60 FPS');
    assert.deepEqual(at('1920:1080', '30', detect({ tv: 'fhd' })), [13, 13, 10], 'Full HD TV at 1080p and 30 FPS');
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const caps = detect({ tv });
      for (const res of RESOLUTIONS) {
        for (const fps of FRAME_RATES) {
          const [ethernet, wifi, unknown] = at(res, fps, caps);
          const label = [tv, res, fps].join(' ');
          assert.ok(ethernet <= 75 && unknown <= 80, label);
          assert.ok(Math.max(ethernet, wifi, unknown) <= profile.getDecoderCapMbps(caps), label);
          // So no preset sets a bitrate that the bitrate warning warns about
          CONNECTIONS.forEach((conn, index) => assert.equal(profile.bitrateWarningKey([ethernet, wifi, unknown][index], conn, caps), null, label + ' ' + conn));
        }
      }
    }
  });

  test('the switch \'Optimize bitrate presets\' and its formula are gone', () => {
    for (const name of ['presetBitrateLimit', 'presetBitrates', 'getOptimizedPresetBitrate']) {
      assert.equal(profile[name], undefined, name);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(profile.deriveOptimalSettings(detect({ tv: 's90c' }), 'wifi'), 'optimizeBitrate'), false);
  });
});

describe('deriveOptimalSettings() over FHD / UHD / 8K x HDR x Tizen 5.5 to 9.0 x connection', () => {
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
            }, conn);
          }
        });
      }
    }
  }

  test('without any capabilities, the defaults of a Full HD TV', () => {
    assert.deepEqual(profile.deriveOptimalSettings(null, undefined), {
      resolution: '1920:1080', frameRate: 60, videoCodec: 'HEVC', hdrMode: false, bitrate: 20, unlockAllFps: false, gameMode: true,
      framePacing: true, fullRange: false,
    });
  });
});

describe('the golden S90C values', () => {
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

describe('the frozen defaults of settings schema 1', () => {
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

  // Frozen copy of the standard bitrate presets of 2.2.0, with the 144 FPS that 2.2.1 removed, and of
  // followsBitratePresets() of 2.2.0, which read them
  const PRESETS_2_2_0 = {
    '854:480': { 30: 2, 60: 4, 90: 5, 120: 6, 144: 8 },
    '1280:720': { 30: 5, 60: 10, 90: 12, 120: 15, 144: 18 },
    '1920:1080': { 30: 10, 60: 20, 90: 25, 120: 30, 144: 35 },
    '2560:1440': { 30: 20, 60: 40, 90: 50, 120: 60, 144: 70 },
    '3200:1800': { 30: 30, 60: 60, 90: 75, 120: 90, 144: 100 },
    '3840:2160': { 30: 40, 60: 80, 90: 100, 120: 120, 144: 140 },
  };
  function followsBitratePresetsOf220(stored, conn) {
    const values = stored || {};
    let follows = values.optimizeBitrate == true;
    if (!follows && values.bitrate != null && values.resolution != null && values.frameRate != null) {
      const presets = PRESETS_2_2_0[values.resolution];
      let preset = presets ? presets[String(values.frameRate)] : 10;
      if (preset === undefined) {
        preset = null;
      }
      if (preset !== null && preset > 75 && conn === 'ethernet') {
        preset = 75;
      }
      follows = preset !== null && parseFloat(values.bitrate) === preset;
    }
    return follows;
  }

  test('the 144 FPS presets are gone from the presets, and a bitrate stored next to 144 FPS is decided as in 2.2.0', () => {
    // The presets offer the frame rates of the menu only, and the presets of 144 FPS stay as frozen data of the decision
    for (const res of Object.keys(PRESETS_2_2_0)) {
      assert.deepEqual(Object.keys(profile.STANDARD_BITRATE_PRESETS[res]), ['30', '60', '90', '120'], res);
      assert.equal(profile.LEGACY_144_FPS_PRESETS[res], PRESETS_2_2_0[res][144], res);
    }
    assert.deepEqual(Object.keys(profile.LEGACY_144_FPS_PRESETS), Object.keys(PRESETS_2_2_0));
    assert.ok(Object.isFrozen(profile.LEGACY_144_FPS_PRESETS));
    // Every stored resolution, frame rate (also as text) and bitrate near a preset gets the decision of 2.2.0
    const bitrates = [0.5, 8, 18, 35, 44, 70, 75, 80, 100, 120, 140, '140', '140.0', '75'];
    let checked = 0;
    for (const res of Object.keys(PRESETS_2_2_0).concat(['1000:1000'])) {
      for (const frameRate of [30, 60, 90, 120, 144, '144', '120', 75]) {
        for (const conn of CONNECTIONS) {
          for (const bitrate of bitrates.concat(Object.values(PRESETS_2_2_0[res] || {}))) {
            for (const optimizeBitrate of [null, false, true]) {
              const stored = { bitrate: String(bitrate), resolution: res, frameRate, optimizeBitrate };
              assert.equal(profile.followsBitratePresets(stored, conn), followsBitratePresetsOf220(stored, conn), JSON.stringify([stored, conn]));
              checked++;
            }
          }
        }
      }
    }
    assert.ok(checked > 5000);
    // So the snapshot of settings schema 1 decides as before for an install with 144 FPS and its preset of 2.2.0:
    // 140 Mbps at 4K (75 Mbps over Ethernet) and 35 Mbps at 1080p follow the presets, any other bitrate was picked by hand
    const s90c = detect({ tv: 's90c' });
    const snapshot = (stored, conn) => profile.legacySettingsSnapshot(stored, s90c, conn).autoAdjustBitrate;
    assert.equal(snapshot({ resolution: '3840:2160', frameRate: 144, bitrate: '140' }, 'wifi'), true);
    assert.equal(snapshot({ resolution: '3840:2160', frameRate: 144, bitrate: '75' }, 'ethernet'), true);
    assert.equal(snapshot({ resolution: '1920:1080', frameRate: 144, bitrate: '35' }, 'unknown'), true);
    assert.equal(snapshot({ resolution: '3840:2160', frameRate: 144, bitrate: '100' }, 'wifi'), false);
    assert.equal(snapshot({ resolution: '3840:2160', frameRate: 144, bitrate: '120' }, 'wifi'), false, 'the 120 FPS preset at 144 FPS');
    assert.equal(snapshot({ resolution: '1920:1080', frameRate: 144, bitrate: '44' }, 'wifi'), false);
  });
});

describe('legacySettingsSnapshot(): the one-time snapshot of an existing install', () => {
  test('stores every unset video setting of an existing S90C install as the previous build showed it', () => {
    assert.deepEqual(profile.legacySettingsSnapshot({ uniqueid: 'x' }, detect({ tv: 's90c' }), 'wifi'), {
      resolution: '3840:2160', unlockAllFps: true, frameRate: 60, bitrate: '100', videoCodec: 'HEVC', hdrMode: true, framePacing: true,
      fullRange: false, gameMode: false, optimizeBitrate: false, autoAdjustBitrate: false,
    });
  });

  test('leaves the game mode out on Tizen 5.5, where a stored value would enable its switch', () => {
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

  test('keeps a stored 120 FPS reachable by storing the unlocked frame rates', () => {
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

  test('the settings schema is version 3', () => {
    assert.equal(profile.SETTINGS_SCHEMA_VERSION, 3);
    assert.equal(profile.SETTINGS_SCHEMA_KEY, 'settingsSchema');
  });
});

describe('the frozen defaults of settings schema 2 and the snapshot of settings schema 3', () => {
  test('the rumble was off, and the snapshot stores that only when it is unset', () => {
    assert.deepEqual(profile.SCHEMA_2_DEFAULTS, { rumbleFeedback: false });
    assert.ok(Object.isFrozen(profile.SCHEMA_2_DEFAULTS));
    assert.deepEqual(profile.schema2Snapshot({ uniqueid: 'x', settingsSchema: 2 }), { rumbleFeedback: false });
    assert.deepEqual(profile.schema2Snapshot({ rumbleFeedback: null }), { rumbleFeedback: false });
    assert.deepEqual(profile.schema2Snapshot(null), { rumbleFeedback: false });
    // A stored value is never replaced
    assert.deepEqual(profile.schema2Snapshot({ rumbleFeedback: true }), {});
    assert.deepEqual(profile.schema2Snapshot({ rumbleFeedback: false }), {});
  });

  test('the removed switches of the continuous audio and the optimized bitrate presets are dropped', () => {
    assert.deepEqual(profile.SCHEMA_3_REMOVED_KEYS, ['continuousAudio', 'optimizeBitrate']);
    assert.ok(Object.isFrozen(profile.SCHEMA_3_REMOVED_KEYS));
  });

  test('an install that had the optimized bitrate presets on keeps the bitrate following the video settings', () => {
    // Its presets always followed the video settings; without a stored state of the presets, that state is stored
    assert.deepEqual(profile.schema3Replacements({ optimizeBitrate: true }), { autoAdjustBitrate: true });
    assert.deepEqual(profile.schema3Replacements({ optimizeBitrate: true, autoAdjustBitrate: null }), { autoAdjustBitrate: true });
    // A stored state is never replaced, and the switch that was off changes nothing
    assert.deepEqual(profile.schema3Replacements({ optimizeBitrate: true, autoAdjustBitrate: false }), {});
    assert.deepEqual(profile.schema3Replacements({ optimizeBitrate: false }), {});
    assert.deepEqual(profile.schema3Replacements({}), {});
    assert.deepEqual(profile.schema3Replacements(null), {});
  });
});

describe('the frame rates of the frame rate menu', () => {
  test('are 30 and 60 FPS, and 90 and 120 FPS more with the higher frame rates unlocked, without 144 FPS', () => {
    assert.deepEqual(profile.offeredFrameRates(false), [30, 60]);
    assert.deepEqual(profile.offeredFrameRates(true), FRAME_RATES);
    assert.ok(Object.isFrozen(profile.FRAME_RATES) && Object.isFrozen(profile.UNLOCKED_FRAME_RATES));
    // A changed list doesn't change the constants
    profile.offeredFrameRates(false).push(144);
    assert.deepEqual(profile.offeredFrameRates(false), [30, 60]);
    // index.html offers the first two, handleUnlockAllFps() in index.js adds the others
    const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    const menu = /<ul class="videoFramerateMenu[^>]*>([\s\S]*?)<\/ul>/.exec(read('wasm/index.html'));
    assert.ok(menu, 'the frame rate menu in index.html');
    assert.deepEqual(Array.from(menu[1].matchAll(/data-value="(\d+)"/g), (match) => Number(match[1])), [30, 60]);
    const unlock = /function handleUnlockAllFps\(\) \{[\s\S]*?\n\}\n/.exec(read('wasm/platform/index.js'));
    assert.ok(unlock, 'handleUnlockAllFps() in index.js');
    assert.deepEqual(Array.from(new Set(Array.from(unlock[0].matchAll(/data-value="(\d+)"/g), (match) => Number(match[1])))), [60, 90, 120]);
    assert.doesNotMatch(unlock[0], /'144'/);
  });

  test('the optimal settings pick a frame rate that the menu of the TV offers', () => {
    for (const tv of ['s90c', 'uhd', 'fhd', '8k']) {
      const optimal = profile.deriveOptimalSettings(detect({ tv }), 'wifi');
      assert.ok(profile.offeredFrameRates(optimal.unlockAllFps).indexOf(optimal.frameRate) >= 0, tv);
    }
  });
});

describe('frameRateReplacements(): a stored 144 FPS', () => {
  const s90c = detect({ tv: 's90c' });
  const uhd = detect({ tv: 'uhd' });
  const fhd = detect({ tv: 'fhd' });

  test('becomes 120 FPS on the S90C, whose higher frame rates are unlocked, with the 120 FPS preset when the bitrate follows the presets', () => {
    // 1080p at 120 FPS over Wi-Fi: 25 % above the preset of 30 Mbps
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, resolution: '1920:1080', bitrate: '44', autoAdjustBitrate: true }, s90c, 'wifi'),
      { frameRate: 120, bitrate: '38' });
    // Also with the switch stored on, the frame rate stored as text, and over Ethernet at 4K (75 Mbps)
    assert.deepEqual(profile.frameRateReplacements({ frameRate: '144', unlockAllFps: true, resolution: '3840:2160', bitrate: '75', autoAdjustBitrate: true }, s90c, 'ethernet'),
      { frameRate: 120, bitrate: '75' });
    // Without a stored resolution the bitrate follows the default of the TV (4K: 100 Mbps over Wi-Fi)
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, bitrate: '44', autoAdjustBitrate: true }, s90c, 'wifi'),
      { frameRate: 120, bitrate: '100' });
  });

  test('keeps a bitrate picked by hand', () => {
    for (const conn of CONNECTIONS) {
      assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, resolution: '3840:2160', bitrate: '42.5', autoAdjustBitrate: false }, s90c, conn),
        { frameRate: 120 }, conn);
    }
  });

  test('becomes 60 FPS where the frame rate menu offers no 120 FPS', () => {
    // The switch stored off on the S90C, and a generic 4K TV, whose higher frame rates are locked by default
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, unlockAllFps: false, resolution: '1920:1080', bitrate: '44', autoAdjustBitrate: true }, s90c, 'wifi'),
      { frameRate: 60, bitrate: '25' });
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, resolution: '3840:2160', bitrate: '80', autoAdjustBitrate: true }, uhd, 'wifi'),
      { frameRate: 60, bitrate: '80' });
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, bitrate: '33', autoAdjustBitrate: false }, uhd, 'unknown'), { frameRate: 60 });
    // The same 4K TV with the switch stored on offers 120 FPS
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, unlockAllFps: true, resolution: '3840:2160', bitrate: '80', autoAdjustBitrate: true }, uhd, 'wifi'),
      { frameRate: 120, bitrate: '80' });
    // Without any capabilities (e.g. before the detection) the default of the switch is off
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, autoAdjustBitrate: false }, null, 'wifi'), { frameRate: 60 });
  });

  test('gives the preset of the resolution that the settings show, for a stored resolution above the panel', () => {
    // 4K on a Full HD TV is shown as 1080p: 25 % above the 120 FPS preset of 30 Mbps, within the 50 Mbps of the decoder
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, unlockAllFps: true, resolution: '3840:2160', bitrate: '50', autoAdjustBitrate: true }, fhd, 'wifi'),
      { frameRate: 120, bitrate: '38' });
  });

  test('stores the state of the bitrate presets that it decided from the stored 144 FPS, when none is stored', () => {
    // The 4K preset of 144 FPS in 2.2.0 (140 Mbps) follows the presets, 100 Mbps doesn't (LEGACY_144_FPS_PRESETS)
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, resolution: '3840:2160', bitrate: '140' }, s90c, 'wifi'),
      { frameRate: 120, autoAdjustBitrate: true, bitrate: '100' });
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, resolution: '3840:2160', bitrate: '100' }, s90c, 'wifi'),
      { frameRate: 120, autoAdjustBitrate: false });
    // Over Ethernet the 144 FPS preset is limited to 75 Mbps, like the presets are
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, resolution: '3840:2160', bitrate: '75' }, s90c, 'ethernet'),
      { frameRate: 120, autoAdjustBitrate: true, bitrate: '75' });
    // A stored 4K on a Full HD TV is decided at 1080p, where the resolution loader puts it before the last loader reads
    // it: the 1080p preset of 144 FPS in 2.2.0 (35 Mbps) follows the presets, the 4K one (140 Mbps) doesn't
    for (const conn of ['wifi', 'unknown']) {
      assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, unlockAllFps: true, resolution: '3840:2160', bitrate: '35' }, fhd, conn),
        { frameRate: 120, autoAdjustBitrate: true, bitrate: conn === 'wifi' ? '38' : '30' }, conn);
      assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, unlockAllFps: true, resolution: '3840:2160', bitrate: '140' }, fhd, conn),
        { frameRate: 120, autoAdjustBitrate: false }, conn);
    }
    // Without a stored bitrate the bitrate loader shows the recommended bitrate of the new frame rate
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144 }, s90c, 'wifi'), { frameRate: 120, autoAdjustBitrate: true });
    assert.deepEqual(profile.frameRateReplacements({ frameRate: 144, autoAdjustBitrate: true }, s90c, 'wifi'), { frameRate: 120 });
  });

  test('decides from what the snapshot of settings schema 1 stores, as migrateSettingsSchema() passes it', () => {
    // An install of settings schema 1 on a generic 4K TV that picked 144 FPS and never touched 'Unlock all frame rates':
    // the snapshot stores the switch on (the default of settings schema 1), so the menu offers 120 FPS, although the
    // default of the switch for this TV is off now
    const stored = { resolution: '3840:2160', frameRate: 144, bitrate: '140' };
    const snapshot = profile.legacySettingsSnapshot(stored, uhd, 'wifi');
    assert.deepEqual([snapshot.unlockAllFps, snapshot.autoAdjustBitrate], [true, true]);
    assert.equal(profile.deriveOptimalSettings(uhd, 'wifi').unlockAllFps, false);
    assert.deepEqual(profile.frameRateReplacements(Object.assign({}, stored, snapshot), uhd, 'wifi'), { frameRate: 120, bitrate: '80' });
    // Only the frame rate stored: the snapshot decided that the bitrate of 100 Mbps doesn't follow the presets
    const onlyFrameRate = { frameRate: 144 };
    assert.deepEqual(profile.frameRateReplacements(Object.assign({}, onlyFrameRate, profile.legacySettingsSnapshot(onlyFrameRate, uhd, 'wifi')), uhd, 'wifi'),
      { frameRate: 120 });
  });

  test('leaves every other frame rate as it is, also 90 and 120 FPS while the higher frame rates are locked', () => {
    for (const caps of [s90c, uhd, fhd, null]) {
      for (const unlockAllFps of [true, false, null]) {
        for (const frameRate of [30, 60, 90, 120, '120', '60', null, undefined, '', 'x', 0]) {
          const stored = { frameRate, unlockAllFps, resolution: '3840:2160', bitrate: '42', autoAdjustBitrate: true };
          assert.deepEqual(profile.frameRateReplacements(stored, caps, 'wifi'), {}, JSON.stringify(stored));
        }
      }
    }
    assert.deepEqual(profile.frameRateReplacements({}, s90c, 'wifi'), {});
    assert.deepEqual(profile.frameRateReplacements(null, s90c, 'wifi'), {});
  });

  test('replaces once: the replaced settings need no replacement', () => {
    for (const caps of [s90c, uhd, fhd]) {
      for (const stored of [{ frameRate: 144, resolution: '1920:1080', bitrate: '44' }, { frameRate: 144, unlockAllFps: true, autoAdjustBitrate: true, bitrate: '1' }]) {
        const replaced = Object.assign({}, stored, profile.frameRateReplacements(stored, caps, 'wifi'));
        assert.ok(profile.offeredFrameRates(replaced.unlockAllFps == null ? profile.deriveOptimalSettings(caps, 'wifi').unlockAllFps : replaced.unlockAllFps)
          .indexOf(replaced.frameRate) >= 0, JSON.stringify(replaced));
        assert.deepEqual(profile.frameRateReplacements(replaced, caps, 'wifi'), {}, JSON.stringify(replaced));
      }
    }
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
