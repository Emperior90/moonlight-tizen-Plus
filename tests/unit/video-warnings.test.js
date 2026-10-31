'use strict';

// Tests of the warning rules of wasm/platform/tv_profile.js, which turn the video settings and the detected
// capabilities of a TV into a message key (VIDEO_WARNINGS), and of showVideoWarning() in index.js, which shows the text
// of each key:
// 1. above 60 FPS at any resolution without a tested 120 Hz profile: many Samsung TVs have 60 Hz panels
// 2. above the luma sample rate of level 5.1 on a 4K TV without a tested 120 Hz profile: it needs a level 5.2 decoder
//    (an 8K TV, whose decoder goes beyond level 5.2, gets the warning of case 1 there)
// 3. above the luma sample rate of level 5.2 (4K at 144 FPS): a warning on every TV, today's text on the S90C
// 4. HDR switched on for a TV that doesn't report HDR
// 5. the bitrate warning starts at the decoder cap of the TV instead of a fixed 100 Mbps (the S90C keeps 100 Mbps)
// 6. the Ethernet warning names the 100 Mbps port that Samsung TVs usually have, above 80 Mbps as before
// 7. the H.264 warning above 1080p stays as it is
// The expectations are written out here. The S90C rows are also compared with a copy of the rules before 1.19.100, so that
// every resolution and frame rate of the menus keeps the warning it had.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const tvMock = require('../browser/mocks/tv-mock');
const profile = require('../../wasm/platform/tv_profile');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

const W = profile.VIDEO_WARNINGS;
const RESOLUTIONS = Object.keys(profile.STANDARD_BITRATE_PRESETS);
const FRAME_RATES = [30, 60, 90, 120, 144];
const CONNECTIONS = ['ethernet', 'wifi', 'unknown'];

// The capabilities of a simulated TV (see tests/browser/mocks/tv-mock.js)
function capsOf(tvOptions) {
  const apis = tvMock.createTizenApis(tvMock.parseConfig('', tvOptions), (callback) => callback());
  return profile.detectTvCapabilities({ tizen: apis.tizen, webapis: apis.webapis });
}

const S90C = capsOf({ tv: 's90c' });
const UHD = capsOf({ tv: 'uhd' });
const FHD = capsOf({ tv: 'fhd' });
const UHD_8K = capsOf({ tv: '8k' });
const GENERIC_TVS = { uhd: UHD, fhd: FHD, '8k': UHD_8K };

// The resolution and frame rate warning before 1.19.100, for the comparison with the S90C: above 1080p and 60 FPS, the
// decoder text at 4K above 120 FPS and the text for lower-end devices otherwise
function resolutionFramerateWarningBeforeWp4(res, fps) {
  const width = parseInt(res.split(':')[0], 10);
  const height = parseInt(res.split(':')[1], 10);
  if (width > 1920 && height > 1080 && fps > 60) {
    return width >= 3840 && fps > 120 ? W.EXCEEDS_TESTED_DECODER : W.HIGH_RESOLUTION_FPS;
  }
  return null;
}

// The bitrate warning before 1.19.100: above 80 Mbps over Ethernet, otherwise above 100 Mbps
function bitrateWarningBeforeWp4(bitrate, conn) {
  if (conn === 'ethernet' && bitrate > 80) {
    return W.ETHERNET_BITRATE;
  }
  return bitrate > 100 ? W.BITRATE_ABOVE_CAP : null;
}

// Every bitrate the slider offers, from 0.5 to 150 Mbps in 0.5 Mbps steps
const SLIDER_BITRATES = Array.from({ length: 300 }, (_, i) => (i + 1) / 2);

describe('resolution and frame rate warnings', () => {
  test('the luma sample rate limits are those of HEVC and AV1 level 5.1 and 5.2, and level 5.1 matches wasmplayer.cpp', () => {
    assert.equal(profile.LEVEL_51_MAX_LUMA_SAMPLE_RATE, 534773760);
    assert.equal(profile.LEVEL_52_MAX_LUMA_SAMPLE_RATE, 1069547520);
    const source = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'wasmplayer.cpp'), 'utf8');
    const match = /kLevel51MaxLumaSampleRate\s*=\s*(\d+)/.exec(source);
    assert.ok(match, 'kLevel51MaxLumaSampleRate in wasmplayer.cpp');
    assert.equal(Number(match[1]), profile.LEVEL_51_MAX_LUMA_SAMPLE_RATE);
  });

  test('60 FPS and less never warn, on any TV and at any resolution', () => {
    for (const caps of [S90C, UHD, FHD, UHD_8K]) {
      for (const res of RESOLUTIONS) {
        for (const fps of [30, 60]) {
          assert.equal(profile.resolutionFramerateWarningKey(res, fps, caps), null, res + '@' + fps);
        }
      }
    }
  });

  test('case 1: above 60 FPS without a tested 120 Hz profile, at any resolution within level 5.1', () => {
    for (const tvName of Object.keys(GENERIC_TVS)) {
      const caps = GENERIC_TVS[tvName];
      for (const [res, fps] of [['854:480', 90], ['1280:720', 120], ['1920:1080', 90], ['1920:1080', 120], ['1920:1080', 144],
        ['2560:1440', 90], ['2560:1440', 120], ['3200:1800', 90]]) {
        assert.equal(profile.resolutionFramerateWarningKey(res, fps, caps), W.FPS_ABOVE_60_HZ, tvName + ' ' + res + '@' + fps);
      }
      // 1440p at 144 FPS is 530,841,600 luma samples per second, just within level 5.1
      assert.equal(profile.resolutionFramerateWarningKey('2560:1440', 144, caps), W.FPS_ABOVE_60_HZ, tvName + ' 1440p144');
    }
  });

  test('case 2: above level 5.1 on a 4K TV without a tested 120 Hz profile needs a level 5.2 decoder', () => {
    const LEVEL_52_STREAMS = [['3840:2160', 90], ['3840:2160', 120], ['3200:1800', 120], ['3200:1800', 144]];
    for (const tvName of ['uhd', 'fhd']) {
      const caps = GENERIC_TVS[tvName];
      for (const [res, fps] of LEVEL_52_STREAMS) {
        assert.equal(profile.resolutionFramerateWarningKey(res, fps, caps), W.NEEDS_LEVEL_52, tvName + ' ' + res + '@' + fps);
      }
    }
    // The decoder of an 8K TV goes beyond level 5.2 (8K at 60 FPS is level 6.1), so it gets the 60 Hz panel warning of
    // case 1 instead, since its panel may run at 60 Hz as well
    assert.equal(UHD_8K.is8k, true);
    for (const [res, fps] of LEVEL_52_STREAMS) {
      assert.equal(profile.resolutionFramerateWarningKey(res, fps, UHD_8K), W.FPS_ABOVE_60_HZ, '8k ' + res + '@' + fps);
    }
  });

  test('case 3: above level 5.2 warns on every TV, with the text of its tested decoder on the S90C', () => {
    for (const tvName of Object.keys(GENERIC_TVS)) {
      assert.equal(profile.resolutionFramerateWarningKey('3840:2160', 144, GENERIC_TVS[tvName]), W.EXCEEDS_LEVEL_52, tvName);
    }
    assert.equal(profile.resolutionFramerateWarningKey('3840:2160', 144, S90C), W.EXCEEDS_TESTED_DECODER);
    // Without any capabilities (e.g. before the detection) it's the generic warning
    assert.equal(profile.resolutionFramerateWarningKey('3840:2160', 144, null), W.EXCEEDS_LEVEL_52);
  });

  test('the limits themselves are within the level, one frame more is above it', () => {
    // 4096 x 2176 at 60 and 120 FPS are exactly the luma sample rates of level 5.1 and 5.2
    assert.equal(profile.resolutionFramerateWarningKey('4096:2176', 60, UHD), null);
    assert.equal(profile.resolutionFramerateWarningKey('4096:2176', 61, UHD), W.NEEDS_LEVEL_52);
    assert.equal(profile.resolutionFramerateWarningKey('4096:2176', 120, UHD), W.NEEDS_LEVEL_52);
    assert.equal(profile.resolutionFramerateWarningKey('4096:2176', 121, UHD), W.EXCEEDS_LEVEL_52);
    assert.equal(profile.resolutionFramerateWarningKey('4096:2176', 120, S90C), W.HIGH_RESOLUTION_FPS);
    assert.equal(profile.resolutionFramerateWarningKey('4096:2176', 121, S90C), W.EXCEEDS_TESTED_DECODER);
  });

  test('the S90C keeps the warning of every resolution and frame rate of the menus', () => {
    for (const res of RESOLUTIONS) {
      for (const fps of FRAME_RATES) {
        assert.equal(profile.resolutionFramerateWarningKey(res, fps, S90C), resolutionFramerateWarningBeforeWp4(res, fps), res + '@' + fps);
      }
    }
    // Also with the values as the menus store them (text)
    assert.equal(profile.resolutionFramerateWarningKey('3840:2160', '144', S90C), W.EXCEEDS_TESTED_DECODER);
    assert.equal(profile.resolutionFramerateWarningKey('3840:2160', '120', S90C), W.HIGH_RESOLUTION_FPS);
  });

  test('a TV that only matches the S90C profile by its model series gets the same warnings', () => {
    const bySeries = capsOf({ tv: 'uhd', model: 'UNKNOWN', series: '23_S90C_OLED' });
    assert.equal(profile.resolutionFramerateWarningKey('3840:2160', 120, bySeries), W.HIGH_RESOLUTION_FPS);
    assert.equal(profile.resolutionFramerateWarningKey('1920:1080', 120, bySeries), null);
  });

  test('invalid values give no warning', () => {
    for (const [res, fps] of [['', 120], ['3840', 120], ['abc:def', 120], ['3840:2160', 'x'], ['3840:2160', 0], [undefined, 60]]) {
      assert.equal(profile.resolutionFramerateWarningKey(res, fps, UHD), null, String(res) + '@' + String(fps));
    }
  });

  test('the 90 FPS cadence hint applies to every TV', () => {
    assert.equal(profile.framerateCadenceWarningKey(90), W.FPS_90_CADENCE);
    assert.equal(profile.framerateCadenceWarningKey('90'), W.FPS_90_CADENCE);
    for (const fps of [30, 60, 120, 144, '60', null]) {
      assert.equal(profile.framerateCadenceWarningKey(fps), null, String(fps));
    }
  });
});

describe('HDR warning (case 4)', () => {
  test('HDR switched on for a TV that does not report HDR', () => {
    assert.equal(profile.hdrWarningKey(true, FHD), W.HDR_NOT_REPORTED);
    assert.equal(profile.hdrWarningKey(true, capsOf({ tv: 'uhd', hdr: 0 })), W.HDR_NOT_REPORTED);
    assert.equal(profile.hdrWarningKey(true, null), W.HDR_NOT_REPORTED);
  });

  test('no warning for an HDR TV or with HDR off', () => {
    assert.equal(profile.hdrWarningKey(true, S90C), null);
    assert.equal(profile.hdrWarningKey(true, UHD), null);
    assert.equal(profile.hdrWarningKey(true, capsOf({ tv: 'fhd', hdr: 1 })), null);
    assert.equal(profile.hdrWarningKey(false, FHD), null);
  });
});

describe('bitrate warnings (cases 5 and 6)', () => {
  test('the S90C keeps its warnings for every bitrate of the slider and every connection', () => {
    for (const conn of CONNECTIONS) {
      for (const bitrate of SLIDER_BITRATES) {
        assert.equal(profile.bitrateWarningKey(bitrate, conn, S90C), bitrateWarningBeforeWp4(bitrate, conn), conn + ' ' + bitrate);
      }
    }
  });

  test('the decoder warning starts at the decoder cap of the TV: 100 / 80 / 80 / 50 Mbps', () => {
    for (const [name, caps, cap] of [['s90c', S90C, 100], ['uhd', UHD, 80], ['8k', UHD_8K, 80], ['fhd', FHD, 50]]) {
      for (const conn of ['wifi', 'unknown']) {
        for (const bitrate of SLIDER_BITRATES) {
          assert.equal(profile.bitrateWarningKey(bitrate, conn, caps), bitrate > cap ? W.BITRATE_ABOVE_CAP : null, name + ' ' + conn + ' ' + bitrate);
        }
      }
    }
  });

  test('over Ethernet the port warning comes first above 80 Mbps, and the decoder cap below it', () => {
    assert.equal(profile.bitrateWarningKey(80, 'ethernet', UHD), null);
    assert.equal(profile.bitrateWarningKey(80.5, 'ethernet', UHD), W.ETHERNET_BITRATE);
    assert.equal(profile.bitrateWarningKey(150, 'ethernet', S90C), W.ETHERNET_BITRATE);
    // A Full HD TV with its 50 Mbps cap warns about the decoder from 50.5 Mbps and about the port from 80.5 Mbps
    assert.equal(profile.bitrateWarningKey(50, 'ethernet', FHD), null);
    assert.equal(profile.bitrateWarningKey(60, 'ethernet', FHD), W.BITRATE_ABOVE_CAP);
    assert.equal(profile.bitrateWarningKey(90, 'ethernet', FHD), W.ETHERNET_BITRATE);
  });

  test('the bitrate can be text, as the slider gives it', () => {
    assert.equal(profile.bitrateWarningKey('100.5', 'wifi', S90C), W.BITRATE_ABOVE_CAP);
    assert.equal(profile.bitrateWarningKey('100', 'wifi', S90C), null);
    assert.equal(profile.bitrateWarningKey('', 'wifi', S90C), null);
  });
});

describe('H.264 warning (case 7)', () => {
  test('H.264 above 1080p warns, other codecs and 1080p do not', () => {
    for (const res of ['2560:1440', '3200:1800', '3840:2160']) {
      assert.equal(profile.h264ResolutionWarningKey('H264', res), W.H264_RESOLUTION, res);
      assert.equal(profile.h264ResolutionWarningKey('HEVC', res), null, res);
      assert.equal(profile.h264ResolutionWarningKey('AV1', res), null, res);
    }
    for (const res of ['854:480', '1280:720', '1920:1080']) {
      assert.equal(profile.h264ResolutionWarningKey('H264', res), null, res);
    }
  });
});

describe('bitrate advice of the optimal settings dialog', () => {
  test('twice the preset of the resolution and frame rate, at most 150 Mbps and the decoder cap', () => {
    assert.equal(profile.bitrateRaiseLimit('3840:2160', 60, S90C), 100);
    assert.equal(profile.bitrateRaiseLimit('3840:2160', 60, UHD), 80);
    assert.equal(profile.bitrateRaiseLimit('3840:2160', 60, UHD_8K), 80);
    assert.equal(profile.bitrateRaiseLimit('1920:1080', 60, FHD), 40);
    assert.equal(profile.bitrateRaiseLimit('2560:1440', 60, S90C), 80);
    assert.equal(profile.bitrateRaiseLimit('1920:1080', 30, UHD), 20);
    // A frame rate without a preset uses the preset of 60 FPS
    assert.equal(profile.bitrateRaiseLimit('1920:1080', 75, FHD), 40);
  });

  test('never above the slider, the decoder cap, or twice the preset', () => {
    for (const caps of [S90C, UHD, FHD, UHD_8K]) {
      for (const res of RESOLUTIONS) {
        for (const fps of FRAME_RATES) {
          const limit = profile.bitrateRaiseLimit(res, fps, caps);
          assert.ok(limit <= 150 && limit <= profile.getDecoderCapMbps(caps) && limit <= 2 * profile.getStandardPresetBitrate(res, fps), res + '@' + fps);
        }
      }
    }
  });
});

describe('the texts of the message keys (showVideoWarning() in index.js)', () => {
  const english = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'static', 'locales', 'en-US.json'), 'utf8'));

  // Load index.js on a simulated TV and show the text of a message key, returning the arguments of each snackbar call
  function shownFor(tvOptions, messageKey) {
    const platform = loadPlatformScripts(INDEX_SCRIPTS, { tv: tvOptions });
    platform.run('var __shown = []; snackbarLogLong = function() { __shown.push(Array.prototype.slice.call(arguments)); };');
    platform.get('showVideoWarning')(messageKey);
    return { shown: plain(platform.get('__shown')), warnings: platform.consoleMessages.filter((message) => message.level === 'warn') };
  }

  test('every message key shows one text, which is a key of the locale files', () => {
    for (const messageKey of Object.keys(W).map((name) => W[name])) {
      const result = shownFor({ tv: 'uhd' }, messageKey);
      assert.equal(result.shown.length, 1, messageKey);
      assert.ok(Object.prototype.hasOwnProperty.call(english, result.shown[0][0]), messageKey + ': ' + result.shown[0][0]);
      assert.deepEqual(result.warnings, [], messageKey);
    }
  });

  test('the message keys are unique, and an unknown key shows nothing and logs a warning', () => {
    const values = Object.keys(W).map((name) => W[name]);
    assert.equal(new Set(values).size, values.length);
    const result = shownFor({ tv: 'uhd' }, 'noSuchKey');
    assert.deepEqual(result.shown, []);
    assert.equal(result.warnings.length, 1);
  });

  test('the S90C keeps the texts of its warnings', () => {
    assert.deepEqual(shownFor({ tv: 's90c' }, W.EXCEEDS_TESTED_DECODER).shown,
      [['Warning: The video decoder of the TV supports 4K up to 120 FPS, so higher frame rates at 4K may stutter or fail to start!']]);
    assert.deepEqual(shownFor({ tv: 's90c' }, W.HIGH_RESOLUTION_FPS).shown,
      [['Warning: This resolution and frame rate may not perform well on lower-end devices or slower connections!']]);
    assert.deepEqual(shownFor({ tv: 's90c' }, W.FPS_90_CADENCE).shown,
      [['Warning: 90 FPS does not divide a 60 or 120 Hz output evenly, so motion may be less smooth than at 60 or 120 FPS!']]);
    assert.deepEqual(shownFor({ tv: 's90c' }, W.H264_RESOLUTION).shown,
      [['Warning: Samsung TVs generally decode H.264 only up to 1080p, so use HEVC or AV1 for higher resolutions!']]);
  });

  test('the bitrate texts name the limit: 80 Mbps for the Ethernet port, and the decoder cap of the TV', () => {
    const ethernet = shownFor({ tv: 'fhd' }, W.ETHERNET_BITRATE).shown[0];
    assert.equal(ethernet[0], 'Warning: Samsung TVs usually have a 100 Mbps Ethernet port, so bitrates above %1$s Mbps can cause packet loss. Use 5 GHz Wi-Fi for higher bitrates!');
    assert.equal(ethernet[1], 80);
    for (const [tv, cap] of [['s90c', 100], ['uhd', 80], ['8k', 80], ['fhd', 50]]) {
      const shown = shownFor({ tv }, W.BITRATE_ABOVE_CAP).shown[0];
      assert.ok(shown[0].indexOf('Bitrates above %1$s Mbps exceed what is recommended for the video decoder of this TV') >= 0, shown[0]);
      assert.equal(shown[1], cap, tv);
    }
  });
});
