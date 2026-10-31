'use strict';

// Tests of the runtime checks of wasm/platform/tv_profile.js (plan WP8), loaded as a Node module with the simulated
// tizentvwasm and MediaSource of tests/browser/mocks/tv-mock.js:
// - detectWasmPlayerFeatures(): whether the WASM player offers the Ultra Low Latency mode of the game mode, decided like
//   the glue code of Samsung's Emscripten SDK in the built moonlight-wasm.js does, and 'unknown' whenever the TV doesn't
//   say it clearly
// - the game mode default and the S90C values with each answer (plan section 3)
// - probeVideoDecoders(): the answers of MediaSource.isTypeSupported() for the codec strings of wasm/wasmplayer.cpp, which
//   count only when a codec that doesn't exist is rejected and H.264 is accepted, and the AV1 note that a clear 'no' gives
// - that the codec strings and names are the same as in wasm/wasmplayer.cpp and wasm/video_track_rejection.hpp

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const tvMock = require('../browser/mocks/tv-mock');
const profile = require('../../wasm/platform/tv_profile');

const TIZEN_VERSIONS = ['5.5', '6.0', '6.5', '7.0', '8.0', '9.0'];
const CONNECTIONS = ['ethernet', 'wifi', 'unknown'];

// Run a function with console.warn captured, and return its result with the warnings
function withWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = function() {
    warnings.push(Array.prototype.map.call(arguments, String).join(' '));
  };
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

// The simulated tizentvwasm of a mode of tv-mock.js, with null for 'none' (passing undefined would use the global one)
function wasmPlayerOf(mode) {
  const api = tvMock.createWasmPlayerApi(mode);
  return api === undefined ? null : api;
}

// The simulated MediaSource of a codecs mode of tv-mock.js, with null for 'none'
function mediaSourceOf(mode) {
  const mediaSource = tvMock.createMediaSource(mode);
  return mediaSource === undefined ? null : mediaSource;
}

// A MediaSource whose isTypeSupported() answers from a table of codec strings (the part inside codecs="..."), counting
// the calls per MIME type
function tableMediaSource(table) {
  const calls = {};
  return {
    calls,
    isTypeSupported(mimeType) {
      calls[mimeType] = (calls[mimeType] || 0) + 1;
      const codec = /codecs="([^"]*)"/.exec(mimeType)[1];
      const answer = Object.prototype.hasOwnProperty.call(table, codec) ? table[codec] : false;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
}

// The answers of a decoder check as 'codec level' -> answer, e.g. { 'AV1 5.1': 'no', ... }
function answersByCodec(probe) {
  const answers = {};
  profile.VIDEO_DECODER_PROBES.forEach((entry) => {
    answers[entry.codec + ' ' + entry.level] = probe.results[entry.mimeType];
  });
  return answers;
}

// Every codec of VIDEO_DECODER_PROBES with the same answer
function allCodecs(answer) {
  const answers = {};
  profile.VIDEO_DECODER_PROBES.forEach((entry) => {
    answers[entry.codec + ' ' + entry.level] = answer;
  });
  return answers;
}

describe('detectWasmPlayerFeatures()', () => {
  test('follows the glue code of the WASM player for each simulated tizentvwasm', () => {
    const expected = {
      // No tizentvwasm, as in a desktop browser: the rules by Tizen version stay
      none: { ultraLowLatency: 'unknown', source: 'none', apiLevels: null },
      ull: { ultraLowLatency: 'yes', source: 'features', apiLevels: [0, 1, 2, 3, 4, 5] },
      noUll: { ultraLowLatency: 'no', source: 'features', apiLevels: [0, 1, 2, 3, 4] },
      // Without isApiFeatureSupported() the glue code derives features from the API levels, never the Ultra Low Latency mode
      apiLevels: { ultraLowLatency: 'no', source: 'apiLevels', apiLevels: [0, 1, 2, 3] },
      // An older player without availableApis: the glue code describes it by its classes (API level 0 without the session
      // ID of the media track) and never uses the Ultra Low Latency mode there
      legacy: { ultraLowLatency: 'no', source: 'legacy', apiLevels: [0] },
      // The feature list and isApiFeatureSupported() disagree
      disagree: { ultraLowLatency: 'unknown', source: 'features', apiLevels: [0, 1, 2, 3, 4, 5] },
      throws: { ultraLowLatency: 'unknown', source: 'error', apiLevels: null },
    };
    assert.deepEqual(Object.keys(expected).sort(), tvMock.WASM_PLAYER_MODES.slice().sort());
    for (const mode of tvMock.WASM_PLAYER_MODES) {
      const { result, warnings } = withWarnings(() => profile.detectWasmPlayerFeatures(wasmPlayerOf(mode)));
      assert.deepEqual(result, expected[mode], mode);
      assert.equal(warnings.length, mode === 'throws' ? 1 : 0, mode + ': ' + JSON.stringify(warnings));
    }
  });

  test('answers yes only when the feature list has the feature and isApiFeatureSupported() does not deny it', () => {
    const playerWith = (features, answer) => ({
      availableApis: [{ name: 'ElementaryMediaStreamSource', version: '1.4', apiLevels: [1, 5], features }],
      isApiFeatureSupported(apiName, feature) {
        assert.deepEqual([apiName, feature], ['ElementaryMediaStreamSource', 'ultra-low-latency']);
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
    });
    const ull = (player) => withWarnings(() => profile.detectWasmPlayerFeatures(player)).result.ultraLowLatency;
    const failure = new Error('Simulated failure of isApiFeatureSupported');
    assert.equal(ull(playerWith(['base-emss', 'ultra-low-latency'], true)), 'yes');
    // The glue code decides by the feature list alone, so a failing isApiFeatureSupported() doesn't change that
    assert.equal(ull(playerWith(['base-emss', 'ultra-low-latency'], failure)), 'yes');
    assert.equal(ull(playerWith(['base-emss'], false)), 'no');
    // Only a clear false of isApiFeatureSupported() confirms a missing feature
    assert.equal(ull(playerWith(['base-emss'], failure)), 'unknown');
    assert.equal(ull(playerWith(['base-emss'], 0)), 'unknown');
    assert.equal(ull(playerWith(['base-emss'], true)), 'unknown');
    // An entry without a feature list
    assert.equal(ull(playerWith(undefined, true)), 'unknown');
    assert.equal(ull(playerWith(undefined, false)), 'unknown');
    // The glue code only checks whether isApiFeatureSupported is defined, so one that isn't a function keeps the feature
    // list of the TV, which then decides alone
    for (const value of [null, true]) {
      const player = { availableApis: [{ name: 'ElementaryMediaStreamSource', apiLevels: [1, 5], features: ['ultra-low-latency'] }], isApiFeatureSupported: value };
      assert.deepEqual(withWarnings(() => profile.detectWasmPlayerFeatures(player)).result, { ultraLowLatency: 'yes', source: 'features', apiLevels: [1, 5] }, String(value));
    }
  });

  test('an older player without availableApis gets the API level that the glue code derives, and never the mode', () => {
    // getLegacyApis() of the glue code: API level 1 ('base-emss') when the media track has a session ID, otherwise 0
    function ElementaryMediaTrack() {}
    Object.defineProperty(ElementaryMediaTrack.prototype, 'sessionId', { value: 0 });
    assert.deepEqual(profile.detectWasmPlayerFeatures({ ElementaryMediaStreamSource: function() {}, ElementaryMediaTrack }),
      { ultraLowLatency: 'no', source: 'legacy', apiLevels: [1] });
    assert.deepEqual(profile.detectWasmPlayerFeatures({ ElementaryMediaStreamSource: function() {}, ElementaryMediaTrack: function() {} }),
      { ultraLowLatency: 'no', source: 'legacy', apiLevels: [0] });
    assert.deepEqual(profile.detectWasmPlayerFeatures({ ElementaryMediaStreamSource: function() {} }),
      { ultraLowLatency: 'no', source: 'legacy', apiLevels: [0] });
    // Without the class of the WASM player, which can't stream at all, the rules by Tizen version stay
    assert.deepEqual(profile.detectWasmPlayerFeatures({}), { ultraLowLatency: 'unknown', source: 'legacy', apiLevels: null });
    // On Tizen 5.5 to 8.0 the game mode is then off and disabled, as the glue code would use the Low Latency mode anyway
    for (const tizen of ['5.5', '6.0', '6.5', '7.0', '8.0', '9.0']) {
      assert.equal(profile.getGameModeDefault(tizen, 'no'), null, 'Tizen ' + tizen);
    }
  });

  test('reads a list of the TV that is no array, and stays unknown without an entry of the WASM player', () => {
    const arrayLike = {
      availableApis: { length: 1, 0: { name: 'ElementaryMediaStreamSource', apiLevels: { length: 2, 0: 1, 1: 5 }, features: { length: 1, 0: 'ultra-low-latency' } } },
      isApiFeatureSupported: () => true,
    };
    assert.deepEqual(profile.detectWasmPlayerFeatures(arrayLike), { ultraLowLatency: 'yes', source: 'features', apiLevels: [1, 5] });
    assert.deepEqual(profile.detectWasmPlayerFeatures({ availableApis: [{ name: 'TizenSockets', apiLevels: [1], features: [] }], isApiFeatureSupported: () => false }),
      { ultraLowLatency: 'unknown', source: 'features', apiLevels: null });
    assert.deepEqual(profile.detectWasmPlayerFeatures({ availableApis: [] }), { ultraLowLatency: 'unknown', source: 'apiLevels', apiLevels: null });
    assert.deepEqual(profile.detectWasmPlayerFeatures({ availableApis: null }), { ultraLowLatency: 'unknown', source: 'apiLevels', apiLevels: null });
    for (const value of [null, true, 0, 'tizentvwasm']) {
      assert.deepEqual(profile.detectWasmPlayerFeatures(value), { ultraLowLatency: 'unknown', source: 'none', apiLevels: null }, String(value));
    }
  });

  test('leaves the list of the TV as it is, which the glue code reads later', () => {
    for (const mode of ['ull', 'noUll', 'apiLevels', 'disagree']) {
      const player = wasmPlayerOf(mode);
      const before = JSON.stringify(player.availableApis);
      const result = profile.detectWasmPlayerFeatures(player);
      assert.equal(JSON.stringify(player.availableApis), before, mode);
      // The API levels are a copy
      if (result.apiLevels) {
        result.apiLevels.push(99);
        assert.equal(JSON.stringify(player.availableApis), before, mode);
      }
    }
  });

  test('uses the global tizentvwasm of the TV when none is passed in', () => {
    const originalWindow = global.window;
    global.window = { tizentvwasm: wasmPlayerOf('noUll') };
    try {
      assert.equal(profile.detectWasmPlayerFeatures().ultraLowLatency, 'no');
      assert.equal(profile.detectTvCapabilities({ tizen: null, webapis: null }).wasmPlayer.ultraLowLatency, 'no');
    } finally {
      if (originalWindow === undefined) {
        delete global.window;
      } else {
        global.window = originalWindow;
      }
    }
  });
});

describe('the game mode with the answer of the WASM player', () => {
  test('getGameModeDefault() keeps the rules by Tizen version unless the WASM player says it clearly', () => {
    const expected = {
      // As before the check: off and disabled on 5.5, off on 9.0, on otherwise
      unknown: { '5.5': null, '6.0': true, '6.5': true, '7.0': true, '8.0': true, '9.0': false },
      // A WASM player with the mode: the switch can be turned on also on 5.5, where it starts off; the rule of 9.0 stays
      yes: { '5.5': false, '6.0': true, '6.5': true, '7.0': true, '8.0': true, '9.0': false },
      // A WASM player without the mode: off and disabled everywhere
      no: { '5.5': null, '6.0': null, '6.5': null, '7.0': null, '8.0': null, '9.0': null },
    };
    for (const answer of Object.keys(expected)) {
      for (const tizen of TIZEN_VERSIONS) {
        assert.equal(profile.getGameModeDefault(tizen, answer), expected[answer][tizen], answer + ' on Tizen ' + tizen);
      }
    }
    // Without the answer, e.g. from older callers, as before
    for (const tizen of TIZEN_VERSIONS) {
      assert.equal(profile.getGameModeDefault(tizen), expected.unknown[tizen], 'Tizen ' + tizen);
    }
  });

  test('isGameModeUnavailable() only for a clear no of the WASM player', () => {
    assert.equal(profile.isGameModeUnavailable({ wasmPlayer: { ultraLowLatency: 'no' } }), true);
    assert.equal(profile.isGameModeUnavailable({ wasmPlayer: { ultraLowLatency: 'yes' } }), false);
    assert.equal(profile.isGameModeUnavailable({ wasmPlayer: { ultraLowLatency: 'unknown' } }), false);
    assert.equal(profile.isGameModeUnavailable({}), false);
    assert.equal(profile.isGameModeUnavailable(null), false);
  });

  test('the S90C keeps its optimal settings with every answer, and the game mode stays off (plan section 3)', () => {
    const caps = profile.detectTvCapabilities(Object.assign(tvMock.createTizenApis(tvMock.parseConfig('', { tv: 's90c' }), (callback) => callback()), { tizentvwasm: null, mediaSource: null }));
    const golden = {
      ethernet: { resolution: '3840:2160', frameRate: 60, videoCodec: 'HEVC', hdrMode: true, bitrate: 75, unlockAllFps: true, gameMode: false, framePacing: true, fullRange: false },
      wifi: { resolution: '3840:2160', frameRate: 60, videoCodec: 'HEVC', hdrMode: true, bitrate: 100, unlockAllFps: true, gameMode: false, framePacing: true, fullRange: false },
      unknown: { resolution: '3840:2160', frameRate: 60, videoCodec: 'HEVC', hdrMode: true, bitrate: 80, unlockAllFps: true, gameMode: false, framePacing: true, fullRange: false },
    };
    for (const mode of ['none', 'ull', 'disagree']) {
      const withPlayer = Object.assign({}, caps, { wasmPlayer: profile.detectWasmPlayerFeatures(wasmPlayerOf(mode)) });
      for (const conn of CONNECTIONS) {
        assert.deepEqual(profile.deriveOptimalSettings(withPlayer, conn), golden[conn], mode + ' ' + conn);
      }
    }
    // Without the mode, the switch is off and disabled instead of off; everything else stays
    for (const mode of ['noUll', 'legacy']) {
      const withoutMode = Object.assign({}, caps, { wasmPlayer: profile.detectWasmPlayerFeatures(wasmPlayerOf(mode)) });
      for (const conn of CONNECTIONS) {
        assert.deepEqual(profile.deriveOptimalSettings(withoutMode, conn), Object.assign({}, golden[conn], { gameMode: null }), mode + ' ' + conn);
      }
    }
  });

  test('the answer of the decoder check changes no optimal setting', () => {
    const apis = tvMock.createTizenApis(tvMock.parseConfig('', { tv: 'uhd' }), (callback) => callback());
    const reference = profile.deriveOptimalSettings(profile.detectTvCapabilities(Object.assign({}, apis, { tizentvwasm: null, mediaSource: null })), 'wifi');
    for (const mode of tvMock.CODEC_MODES) {
      const caps = withWarnings(() => profile.detectTvCapabilities(Object.assign({}, apis, { tizentvwasm: null, mediaSource: mediaSourceOf(mode) }))).result;
      assert.deepEqual(profile.deriveOptimalSettings(caps, 'wifi'), reference, mode);
    }
  });
});

describe('probeVideoDecoders()', () => {
  test('counts the answers only when the codec that does not exist is rejected and H.264 is accepted', () => {
    const expected = {
      all: { reliable: true, reason: 'ok', answers: allCodecs('yes') },
      noAv1: {
        reliable: true, reason: 'ok', answers: Object.assign(allCodecs('yes'), { 'AV1 5.1': 'no', 'AV1 5.2': 'no', 'AV1 Main10 5.1': 'no', 'AV1 Main10 5.2': 'no' }),
      },
      noAv1Main10: { reliable: true, reason: 'ok', answers: Object.assign(allCodecs('yes'), { 'AV1 Main10 5.1': 'no', 'AV1 Main10 5.2': 'no' }) },
      noLevel52: {
        reliable: true, reason: 'ok', answers: Object.assign(allCodecs('yes'), { 'HEVC 5.2': 'no', 'HEVC Main10 5.2': 'no', 'AV1 5.2': 'no', 'AV1 Main10 5.2': 'no' }),
      },
      acceptsBogus: { reliable: false, reason: 'bogusAccepted', answers: allCodecs('unknown') },
      noH264: { reliable: false, reason: 'h264Rejected', answers: allCodecs('unknown') },
      throws: { reliable: false, reason: 'controlFailed', answers: allCodecs('unknown') },
      none: { reliable: false, reason: 'unavailable', answers: allCodecs('unknown') },
    };
    assert.deepEqual(Object.keys(expected).sort(), tvMock.CODEC_MODES.slice().sort());
    for (const mode of tvMock.CODEC_MODES) {
      const { result } = withWarnings(() => profile.probeVideoDecoders(mediaSourceOf(mode)));
      assert.deepEqual({ reliable: result.reliable, reason: result.reason, answers: answersByCodec(result) }, expected[mode], mode);
    }
  });

  test('keeps the raw answers for the logs, also when they do not count', () => {
    const { result } = withWarnings(() => profile.probeVideoDecoders(mediaSourceOf('acceptsBogus')));
    assert.equal(result.answers[profile.BOGUS_CODEC_PROBE], true);
    profile.VIDEO_DECODER_PROBES.forEach((entry) => assert.equal(result.answers[entry.mimeType], true, entry.mimeType));
    assert.deepEqual(profile.probeVideoDecoders(null).answers, {});
  });

  test('asks once per MIME type, and an answer that fails or is no boolean counts as unknown', () => {
    const table = {
      'avc1.64002A': true, 'hev1.1.6.L153.B0': true, 'hev1.1.6.L156.B0': 'probably', 'hev1.2.4.L153.B0': true,
      'hev1.2.4.L156.B0': new Error('Simulated failure'), 'av01.0.13M.08': false, 'av01.0.14M.08': false,
      'av01.0.13M.10': false, 'av01.0.14M.10': undefined, 'bogus.0.0': false,
    };
    const mediaSource = tableMediaSource(table);
    const { result, warnings } = withWarnings(() => profile.probeVideoDecoders(mediaSource));
    assert.equal(result.reliable, true);
    assert.deepEqual(answersByCodec(result), {
      'H.264 4.2': 'yes', 'HEVC 5.1': 'yes', 'HEVC 5.2': 'unknown', 'HEVC Main10 5.1': 'yes', 'HEVC Main10 5.2': 'unknown',
      'AV1 5.1': 'no', 'AV1 5.2': 'no', 'AV1 Main10 5.1': 'no', 'AV1 Main10 5.2': 'unknown',
    });
    // The H.264 probe is also the check that H.264 is accepted, and still asked only once
    Object.keys(mediaSource.calls).forEach((mimeType) => assert.equal(mediaSource.calls[mimeType], 1, mimeType));
    assert.equal(Object.keys(mediaSource.calls).length, profile.VIDEO_DECODER_PROBES.length + 1);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
  });

  test('a check that fails or answers no boolean makes every answer unknown', () => {
    const base = {
      'avc1.64002A': true, 'hev1.1.6.L153.B0': true, 'hev1.1.6.L156.B0': true, 'hev1.2.4.L153.B0': true, 'hev1.2.4.L156.B0': true,
      'av01.0.13M.08': false, 'av01.0.14M.08': false, 'av01.0.13M.10': false, 'av01.0.14M.10': false, 'bogus.0.0': false,
    };
    for (const change of [{ 'bogus.0.0': new Error('Simulated failure') }, { 'bogus.0.0': 'no' }, { 'avc1.64002A': new Error('Simulated failure') }, { 'avc1.64002A': 'maybe' }]) {
      const { result } = withWarnings(() => profile.probeVideoDecoders(tableMediaSource(Object.assign({}, base, change))));
      assert.deepEqual([result.reliable, result.reason, answersByCodec(result)], [false, 'controlFailed', allCodecs('unknown')], JSON.stringify(Object.keys(change)));
      assert.equal(profile.isAv1ReportedUnsupported(result), false);
    }
  });

  test('uses the global MediaSource when none is passed in, and is part of the detected capabilities', () => {
    const originalWindow = global.window;
    global.window = { MediaSource: mediaSourceOf('noAv1') };
    try {
      assert.equal(profile.probeVideoDecoders().reason, 'ok');
      assert.equal(profile.isAv1ReportedUnsupported(profile.detectTvCapabilities({ tizen: null, webapis: null }).videoDecoders), true);
    } finally {
      if (originalWindow === undefined) {
        delete global.window;
      } else {
        global.window = originalWindow;
      }
    }
    const caps = withWarnings(() => profile.detectTvCapabilities({ tizen: null, webapis: null, mediaSource: mediaSourceOf('noLevel52') })).result;
    assert.equal(profile.getVideoDecoderSupport(caps.videoDecoders, 'HEVC', '5.2'), 'no');
  });

  test('getVideoDecoderSupport() answers unknown for a codec or level that is not probed', () => {
    const probe = profile.probeVideoDecoders(mediaSourceOf('all'));
    assert.equal(profile.getVideoDecoderSupport(probe, 'HEVC Main10', '5.1'), 'yes');
    assert.equal(profile.getVideoDecoderSupport(probe, 'H.264', '5.1'), 'unknown');
    assert.equal(profile.getVideoDecoderSupport(probe, 'VP9', '5.1'), 'unknown');
    assert.equal(profile.getVideoDecoderSupport(null, 'HEVC', '5.1'), 'unknown');
  });

  test('the AV1 note needs counting answers and a no for AV1 in 8 and in 10 bits', () => {
    const noteFor = (mode) => profile.isAv1ReportedUnsupported(withWarnings(() => profile.probeVideoDecoders(mediaSourceOf(mode))).result);
    const expected = { all: false, noAv1: true, noAv1Main10: false, noLevel52: false, acceptsBogus: false, noH264: false, throws: false, none: false };
    for (const mode of tvMock.CODEC_MODES) {
      assert.equal(noteFor(mode), expected[mode], mode);
    }
    // An AV1 that is unknown in 10 bits isn't clear either
    const partly = tableMediaSource({ 'avc1.64002A': true, 'av01.0.13M.08': false, 'av01.0.13M.10': new Error('Simulated failure') });
    assert.equal(profile.isAv1ReportedUnsupported(withWarnings(() => profile.probeVideoDecoders(partly)).result), false);
    assert.equal(profile.isAv1ReportedUnsupported(null), false);
    // Answers that don't count never give the note, whatever they say
    const results = {};
    profile.VIDEO_DECODER_PROBES.forEach((entry) => {
      results[entry.mimeType] = entry.codec.indexOf('AV1') === 0 ? 'no' : 'yes';
    });
    assert.equal(profile.isAv1ReportedUnsupported({ reliable: true, reason: 'ok', results }), true);
    assert.equal(profile.isAv1ReportedUnsupported({ reliable: false, reason: 'bogusAccepted', results }), false);
  });
});

describe('the codecs of the checks and of the native code', () => {
  test('the decoder check asks for exactly the MIME types and levels that wasmplayer.cpp offers to the TV', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'wasmplayer.cpp'), 'utf8');
    const offered = [];
    const pattern = /videoProfiles\.push_back\(\{"((?:\\.|[^"\\])*)",\s*"([^"]*)"\}\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const name = /^(H\.264 High|HEVC Main10|HEVC Main|AV1 Main10|AV1 Main) Level Profile (\d\.\d)$/.exec(match[2]);
      assert.ok(name, 'profile name ' + match[2]);
      const codec = { 'H.264 High': 'H.264', 'HEVC Main': 'HEVC', 'HEVC Main10': 'HEVC Main10', 'AV1 Main': 'AV1', 'AV1 Main10': 'AV1 Main10' }[name[1]];
      offered.push({ codec, level: name[2], mimeType: match[1].replace(/\\"/g, '"') });
    }
    const sortKey = (entry) => entry.codec + ' ' + entry.level;
    const plainProbes = profile.VIDEO_DECODER_PROBES.map((entry) => ({ codec: entry.codec, level: entry.level, mimeType: entry.mimeType }));
    assert.deepEqual(offered.sort((a, b) => sortKey(a).localeCompare(sortKey(b))), plainProbes.sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
    assert.ok(profile.VIDEO_DECODER_PROBES.some((entry) => entry.mimeType === profile.H264_CONTROL_PROBE));
    assert.ok(!profile.VIDEO_DECODER_PROBES.some((entry) => entry.mimeType === profile.BOGUS_CODEC_PROBE));
  });

  test('System information and the message of a rejected video track use the same codec names', () => {
    const header = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'video_track_rejection.hpp'), 'utf8');
    const names = [];
    const pattern = /return "([^"]+)";/g;
    let match;
    while ((match = pattern.exec(header)) !== null) {
      if (match[1] !== 'Unknown') {
        names.push(match[1]);
      }
    }
    const probeNames = Array.from(new Set(profile.VIDEO_DECODER_PROBES.map((entry) => entry.codec)));
    assert.deepEqual(names.sort(), probeNames.sort());
  });
});
