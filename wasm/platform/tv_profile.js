// TV capability profile and the video settings derived from it. index.html loads this file before index.js, which uses
// it for the defaults of a fresh install, for Restore Defaults, for the optimal streaming settings button and its
// dialog, for the warnings of the video settings, for the one-time settings snapshot of existing installs, and for the
// checks of the WASM player (Ultra Low Latency mode) and of the video decoders that System information shows. Keeping
// these rules in one place means that the defaults, the button, the text of its dialog and the warnings can't drift
// apart.
//
// Rules for this file:
// - It's a plain script whose functions and constants become globals in the browser, with a module.exports guard at
//   the end, so that the unit tests (tests/unit) can load it in Node without a TV.
// - ES2018 only (Chromium M69 on Tizen 5.5), and no DOM access.
// - Every call of a Tizen or Samsung API goes through safeTvCall(), so that a missing privilege, an unusual firmware or
//   the TV simulator can't stop the app from loading. A failed call falls back to what the app assumed before it
//   could ask: a Full HD panel without HDR and unknown model strings.
// - Nothing switches a feature on by guessing from a model name or the Tizen version. Only a profile of a model that
//   was tested on the real TV (VERIFIED_PROFILES) may override a detected capability.

// Version of the layout of the stored settings, stored at the key below. Up to version 1 the default of a video setting
// was worked out again at every start and never stored, so a new default in a later build also changed every existing
// install where the user never touched that setting. Version 2 stores the defaults of version 1 once for existing
// installs (legacySettingsSnapshot()), and a fresh install starts at version 2 with the defaults derived for its TV.
// When a later build changes the default of a stored setting again, it raises the version and freezes the defaults of
// the previous version the same way. Version 3 turned the rumble on by default, so it stores the earlier default (off)
// once for an existing install that never switched it (schema2Snapshot()), and it drops the stored value of the switch
// 'Continuous audio from the host', which is gone since the host always keeps sending audio (SCHEMA_3_REMOVED_KEYS).
const SETTINGS_SCHEMA_VERSION = 3;
const SETTINGS_SCHEMA_KEY = 'settingsSchema';

const RECOMMENDED_ETHERNET_BITRATE = 75; // Highest recommended bitrate in Mbps over the 100 Mbps Ethernet port of Samsung TVs, leaving headroom for FEC, network overhead and larger frames
const ETHERNET_MAX_BITRATE = 80; // Highest bitrate in Mbps that fits the 100 Mbps Ethernet port that Samsung TVs usually have, including FEC and network overhead, above which the bitrate warning names the port
const UNKNOWN_CONNECTION_MAX_BITRATE = 80; // Highest recommended bitrate in Mbps when the network connection type of the TV is unknown
const NETWORK_HEADROOM_FACTOR = 1.25; // Factor above the standard preset that a known network connection gets, for a sharper picture in fast motion
const UHD_DECODER_CAP_MBPS = 80; // Highest recommended bitrate in Mbps for a 4K or 8K TV without a tested profile, which Samsung specifies for HEVC at 4K and 60 FPS on most of its models
const FHD_DECODER_CAP_MBPS = 50; // Highest recommended bitrate in Mbps for a Full HD TV, which Samsung specifies for HEVC at 1080p and 60 FPS on its Full HD models
const MAX_BITRATE_MBPS = 150; // Highest bitrate in Mbps of the bitrate slider (index.html)

// Highest luma sample rates (width x height x frame rate) of the decoder levels of HEVC and AV1. Level 5.1 covers 4K at
// up to 64 FPS, and every supported TV decodes it. Level 5.2 covers 4K at up to 128 FPS, which the 4K TVs with a 120 Hz
// panel decode, and 8K TVs decode 8K at 60 FPS, which is above it (level 6.1). The level 5.1 value is the same as
// kLevel51MaxLumaSampleRate in wasmplayer.cpp, which offers level 5.2 to the TV for faster streams, the highest level
// that the app asks the TV for.
const LEVEL_51_MAX_LUMA_SAMPLE_RATE = 534773760;
const LEVEL_52_MAX_LUMA_SAMPLE_RATE = 1069547520;

// TV models whose settings were tested on the real TV. A profile is selected by its regular expression, which is
// tested against the model name and the model series, and overrides what the TV can't report through its APIs:
// - unlockAllFps: the panel shows more than 60 Hz, so 'Unlock all frame rates' starts switched on
// - decoderCapMbps: the highest bitrate in Mbps that the video decoder of this model handled in the tests
// - refresh120: the panel runs at 120 Hz or more
// Every other model gets the values derived from its detected capabilities.
const VERIFIED_PROFILES = Object.freeze([
  // Samsung S90C (2023 OLED with a 144 Hz panel), the TV this app was tuned and tested on
  Object.freeze({ id: 'S90C', match: /S90C/i, unlockAllFps: true, decoderCapMbps: 100, refresh120: true }),
]);

// Standard bitrate presets in Mbps by resolution and frame rate. 1800p is interpolated by pixel count between the
// 1440p and 2160p presets.
var STANDARD_BITRATE_PRESETS = {
  '854:480': { '30': 2, '60': 4, '90': 5, '120': 6, '144': 8 },
  '1280:720': { '30': 5, '60': 10, '90': 12, '120': 15, '144': 18 },
  '1920:1080': { '30': 10, '60': 20, '90': 25, '120': 30, '144': 35 },
  '2560:1440': { '30': 20, '60': 40, '90': 50, '120': 60, '144': 70 },
  '3200:1800': { '30': 30, '60': 60, '90': 75, '120': 90, '144': 100 },
  '3840:2160': { '30': 40, '60': 80, '90': 100, '120': 120, '144': 140 },
};

// Frozen copy of the default bitrates in Mbps of settings schema 1, which ignored the resolution: 75 Mbps over Ethernet,
// 100 Mbps over Wi-Fi (tuned for the decoder of the first tested model in VERIFIED_PROFILES) and 80 Mbps for an unknown
// connection. Never change these values: they describe what existing installs showed before the snapshot, not what new
// installs should get.
const LEGACY_DEFAULT_BITRATES = Object.freeze({ ethernet: 75, wifi: 100, unknown: 80 });

// The video settings that the snapshot of settings schema 2 stores for an existing install when they are unset, in the
// order in which loadStoredSettings() in index.js loads them
const LEGACY_SNAPSHOT_KEYS = Object.freeze(['resolution', 'unlockAllFps', 'frameRate', 'bitrate', 'videoCodec', 'hdrMode',
  'framePacing', 'fullRange', 'gameMode', 'optimizeBitrate', 'autoAdjustBitrate']);

// Frozen copy of the defaults of settings schema 2 that settings schema 3 changed: the rumble was off until the user
// switched it on. Never change these values: they describe what existing installs showed before the snapshot of
// settings schema 3, not what new installs should get.
const SCHEMA_2_DEFAULTS = Object.freeze({ rumbleFeedback: false });

// The stored keys of the settings that settings schema 3 removed: the switch 'Continuous audio from the host' of an
// A/B test, since the launch and resume requests always ask for audio during silence now
const SCHEMA_3_REMOVED_KEYS = Object.freeze(['continuousAudio']);

// Call a Tizen or Samsung API and return its result, or the fallback value if the call throws (e.g. a missing API
// object, a missing privilege or an unusual firmware) or returns nothing
function safeTvCall(label, call, fallback) {
  try {
    const value = call();
    return value === undefined ? fallback : value;
  } catch (error) {
    console.warn('%c[tv_profile.js, safeTvCall]', 'color: purple;', 'Warning: Failed to get the ' + label + ', using ' + JSON.stringify(fallback) + ' instead: ' + (error && error.message ? error.message : error));
    return fallback;
  }
}

// Return the global object of the given name, or undefined where it doesn't exist (e.g. tizen in Node)
function getTvGlobal(name) {
  if (typeof window !== 'undefined' && window[name] !== undefined) {
    return window[name];
  }
  if (typeof self !== 'undefined' && self[name] !== undefined) {
    return self[name];
  }
  return undefined;
}

// Get the active network connection type of the TV, which is either 'ethernet', 'wifi' or 'unknown'. The webapis object
// can be passed in for the tests, otherwise the global one of the TV is used.
function detectConnectionType(webapisObject) {
  const webApi = webapisObject !== undefined ? webapisObject : getTvGlobal('webapis');
  try {
    if (webApi && webApi.network && typeof webApi.network.getActiveConnectionType === 'function') {
      // Compare with the constants of the API, falling back to their documented values (WIFI = 1, ETHERNET = 3)
      const connectionTypes = webApi.network.NetworkActiveConnectionType || {};
      const ethernetType = connectionTypes.ETHERNET !== undefined ? connectionTypes.ETHERNET : 3;
      const wifiType = connectionTypes.WIFI !== undefined ? connectionTypes.WIFI : 1;
      const activeType = webApi.network.getActiveConnectionType();
      if (activeType === ethernetType) {
        return 'ethernet';
      } else if (activeType === wifiType) {
        return 'wifi';
      }
    }
  } catch (e) {
    console.warn('%c[tv_profile.js, detectConnectionType]', 'color: purple;', 'Warning: Failed to get the active network connection type: ' + e);
  }
  return 'unknown';
}

// Return the tested profile whose regular expression matches the model name or the model series, or null
function findVerifiedProfile(modelName, modelSeries) {
  const modelText = String(modelName) + ' ' + String(modelSeries);
  for (let i = 0; i < VERIFIED_PROFILES.length; i++) {
    if (VERIFIED_PROFILES[i].match.test(modelText)) {
      return VERIFIED_PROFILES[i];
    }
  }
  return null;
}

// Return the model year that the 'YY_' prefix of the model code suggests (e.g. 2023 for '23_PONTUSM'), or null. It's
// only a hint for the System information and the logs, and never decides a setting, since Samsung updates older TVs
// to newer Tizen versions and sells models of one year for longer.
function getModelYearHint(modelCode) {
  const match = /^(\d{2})_/.exec(String(modelCode));
  return match ? 2000 + parseInt(match[1], 10) : null;
}

// Name of the WASM player API in the list of tizentvwasm.availableApis, and its feature of the Ultra Low Latency mode,
// which the game mode asks for (main.cpp)
const EMSS_API_NAME = 'ElementaryMediaStreamSource';
const ULTRA_LOW_LATENCY_FEATURE = 'ultra-low-latency';

// Copy an array, or an array-like object of the TV (e.g. a list of the Tizen web runtime), into an array, or return
// null for anything else
function toArrayOrNull(value) {
  if (Array.isArray(value)) {
    return value.slice();
  }
  return value && typeof value === 'object' && typeof value.length === 'number' ? Array.prototype.slice.call(value) : null;
}

// Detect whether the WASM player of the TV offers the Ultra Low Latency mode that the game mode asks for. It follows the
// glue code of Samsung's Emscripten SDK in the built moonlight-wasm.js, which decides it when it creates the media
// source: it uses the mode only when the ElementaryMediaStreamSource entry of tizentvwasm.availableApis lists the
// feature 'ultra-low-latency', and otherwise falls back to the Low Latency mode with only a console warning. On a TV
// whose tizentvwasm has availableApis but no isApiFeatureSupported(), the glue code replaces the features of that entry
// with ones derived from its API levels, which never include the Ultra Low Latency mode. On an older player without
// availableApis, the glue code describes the player by its classes (getLegacyApis()): API level 1 with the feature
// 'base-emss' when its media track has a session ID, otherwise API level 0 with 'legacy-emss', so it never uses the mode
// there either. The tizentvwasm object can be passed in for the tests, otherwise the global one of the TV is used.
// Returns:
// - ultraLowLatency: 'yes', 'no', or 'unknown' when the TV doesn't say it clearly: without tizentvwasm (e.g. in a
//   desktop browser), without an ElementaryMediaStreamSource entry or class (the WASM player can't stream then), or
//   when the feature list and isApiFeatureSupported() disagree
// - source: what the answer is based on: 'features' (availableApis with isApiFeatureSupported()), 'apiLevels'
//   (availableApis without isApiFeatureSupported()), 'legacy' (no availableApis), 'none' (no tizentvwasm) or 'error'
//   (reading tizentvwasm failed)
// - apiLevels: the API levels of the WASM player (for an older player the one that the glue code derives), or null
function detectWasmPlayerFeatures(tizentvwasmObject) {
  const wasmApi = tizentvwasmObject !== undefined ? tizentvwasmObject : getTvGlobal('tizentvwasm');
  const result = { ultraLowLatency: 'unknown', source: 'none', apiLevels: null };
  if (!wasmApi || (typeof wasmApi !== 'object' && typeof wasmApi !== 'function')) {
    return result;
  }
  try {
    if (wasmApi.availableApis === undefined) {
      // An older player, which the glue code describes by its classes and never gives the Ultra Low Latency mode
      result.source = 'legacy';
      if (wasmApi.ElementaryMediaStreamSource) {
        const track = wasmApi.ElementaryMediaTrack;
        const hasSessionId = !!(track && track.prototype && Object.prototype.hasOwnProperty.call(track.prototype, 'sessionId'));
        result.apiLevels = [hasSessionId ? 1 : 0];
        result.ultraLowLatency = 'no';
      }
      return result;
    }
    // The glue code only checks whether isApiFeatureSupported is defined, so a value that isn't a function still keeps
    // the feature list of the TV (calling it then fails, which leaves the decision to the feature list)
    result.source = wasmApi.isApiFeatureSupported !== undefined ? 'features' : 'apiLevels';
    const availableApis = toArrayOrNull(wasmApi.availableApis) || [];
    const emssInfo = availableApis.find(function(apiInfo) {
      return apiInfo && apiInfo.name === EMSS_API_NAME;
    });
    if (!emssInfo) {
      return result;
    }
    const apiLevels = toArrayOrNull(emssInfo.apiLevels);
    result.apiLevels = apiLevels;
    if (result.source === 'apiLevels') {
      // The glue code gives this entry the features 'base-emss', 'video-texture' and 'software-decoding' at most
      result.ultraLowLatency = 'no';
      return result;
    }
    const features = toArrayOrNull(emssInfo.features);
    const listed = features ? features.indexOf(ULTRA_LOW_LATENCY_FEATURE) >= 0 : null;
    const answer = safeTvCall('Ultra Low Latency mode support of the WASM player', function() {
      return wasmApi.isApiFeatureSupported(EMSS_API_NAME, ULTRA_LOW_LATENCY_FEATURE);
    }, null);
    // The glue code decides by the feature list alone, so isApiFeatureSupported() only has to agree with it
    if (listed === true && answer !== false) {
      result.ultraLowLatency = 'yes';
    } else if (listed === false && answer === false) {
      result.ultraLowLatency = 'no';
    }
  } catch (error) {
    console.warn('%c[tv_profile.js, detectWasmPlayerFeatures]', 'color: purple;', 'Warning: Failed to read the features of the WASM player: ' + (error && error.message ? error.message : error));
    result.ultraLowLatency = 'unknown';
    result.source = 'error';
  }
  return result;
}

// The video codecs that wasmplayer.cpp offers to the TV when it adds the video track (the MIME types of
// StartupVidDecSetup()), which the decoder check asks the TV about: H.264 at level 4.2, and HEVC and AV1 at level 5.1
// and, for streams above the luma sample rate of level 5.1 (e.g. 4K at 90 or 120 FPS), at level 5.2.
// tests/unit/runtime-checks.test.js checks that they are exactly the ones of wasmplayer.cpp.
const VIDEO_DECODER_PROBES = Object.freeze([
  Object.freeze({ codec: 'H.264', level: '4.2', mimeType: 'video/mp4; codecs="avc1.64002A"' }),
  Object.freeze({ codec: 'HEVC', level: '5.1', mimeType: 'video/mp4; codecs="hev1.1.6.L153.B0"' }),
  Object.freeze({ codec: 'HEVC', level: '5.2', mimeType: 'video/mp4; codecs="hev1.1.6.L156.B0"' }),
  Object.freeze({ codec: 'HEVC Main10', level: '5.1', mimeType: 'video/mp4; codecs="hev1.2.4.L153.B0"' }),
  Object.freeze({ codec: 'HEVC Main10', level: '5.2', mimeType: 'video/mp4; codecs="hev1.2.4.L156.B0"' }),
  Object.freeze({ codec: 'AV1', level: '5.1', mimeType: 'video/mp4; codecs="av01.0.13M.08"' }),
  Object.freeze({ codec: 'AV1', level: '5.2', mimeType: 'video/mp4; codecs="av01.0.14M.08"' }),
  Object.freeze({ codec: 'AV1 Main10', level: '5.1', mimeType: 'video/mp4; codecs="av01.0.13M.10"' }),
  Object.freeze({ codec: 'AV1 Main10', level: '5.2', mimeType: 'video/mp4; codecs="av01.0.14M.10"' }),
]);

// A codec that doesn't exist. A browser that accepts it doesn't really check the codecs, so its answers don't count.
const BOGUS_CODEC_PROBE = 'video/mp4; codecs="bogus.0.0"';
// H.264 at level 4.2 (1080p at 60 FPS), which every Samsung TV decodes. A browser that rejects it doesn't answer for
// the decoders of the TV, so its answers don't count either.
const H264_CONTROL_PROBE = 'video/mp4; codecs="avc1.64002A"';

// Ask the MediaSource of the browser of the TV which of the video codecs of the WASM player (VIDEO_DECODER_PROBES) it
// supports. The WASM player decodes through its own path, which MediaSource may not mirror exactly, so the answers are
// only shown and used for a hint, never to block a setting. They count only when the browser rejects a codec that
// doesn't exist (BOGUS_CODEC_PROBE) and accepts H.264 at level 4.2 (H264_CONTROL_PROBE), and otherwise every answer is
// 'unknown'. The MediaSource object can be passed in for the tests, otherwise the global one is used. Returns:
// - reliable: whether the answers count
// - reason: 'ok', 'unavailable' (no MediaSource.isTypeSupported()), 'bogusAccepted' (the codec that doesn't exist was
//   accepted), 'h264Rejected' (H.264 at level 4.2 was rejected) or 'controlFailed' (a check of the two failed)
// - results: 'yes', 'no' or 'unknown' for each MIME type of VIDEO_DECODER_PROBES
// - answers: what isTypeSupported() returned for each MIME type and the codec that doesn't exist: true, false, or null
//   when the call failed, for the logs
function probeVideoDecoders(mediaSourceObject) {
  const mediaSource = mediaSourceObject !== undefined ? mediaSourceObject : getTvGlobal('MediaSource');
  const result = { reliable: false, reason: 'unavailable', results: {}, answers: {} };
  const mimeTypes = VIDEO_DECODER_PROBES.map(function(probe) {
    return probe.mimeType;
  });
  mimeTypes.forEach(function(mimeType) {
    result.results[mimeType] = 'unknown';
  });
  if (!mediaSource || typeof mediaSource.isTypeSupported !== 'function') {
    return result;
  }
  // Ask once per MIME type, keeping only true and false
  const ask = function(mimeType) {
    if (!Object.prototype.hasOwnProperty.call(result.answers, mimeType)) {
      const answer = safeTvCall('decoder support for ' + mimeType, function() {
        return mediaSource.isTypeSupported(mimeType);
      }, null);
      result.answers[mimeType] = typeof answer === 'boolean' ? answer : null;
    }
    return result.answers[mimeType];
  };
  mimeTypes.forEach(ask);
  const bogusAnswer = ask(BOGUS_CODEC_PROBE);
  const h264Answer = ask(H264_CONTROL_PROBE);
  if (bogusAnswer === true) {
    result.reason = 'bogusAccepted';
  } else if (h264Answer === false) {
    result.reason = 'h264Rejected';
  } else if (bogusAnswer !== false || h264Answer !== true) {
    result.reason = 'controlFailed';
  } else {
    result.reliable = true;
    result.reason = 'ok';
    mimeTypes.forEach(function(mimeType) {
      const answer = result.answers[mimeType];
      result.results[mimeType] = answer === true ? 'yes' : (answer === false ? 'no' : 'unknown');
    });
  }
  return result;
}

// Return the answer of the decoder check (probeVideoDecoders()) for a codec of VIDEO_DECODER_PROBES at a level, e.g.
// ('AV1 Main10', '5.1'): 'yes', 'no' or 'unknown'
function getVideoDecoderSupport(probe, codec, level) {
  for (let i = 0; i < VIDEO_DECODER_PROBES.length; i++) {
    const entry = VIDEO_DECODER_PROBES[i];
    if (entry.codec === codec && entry.level === level) {
      return probe && probe.results && probe.results[entry.mimeType] ? probe.results[entry.mimeType] : 'unknown';
    }
  }
  return 'unknown';
}

// Whether the decoder check says clearly that the TV can't decode AV1, which only labels the AV1 entry of the video
// codec menu and never blocks it: the answers count, and AV1 at level 5.1 is 'no' both in 8 and in 10 bits, since a
// decoder for 10 bits also decodes 8 bits and differing answers aren't clear
function isAv1ReportedUnsupported(probe) {
  return !!(probe && probe.reliable) && getVideoDecoderSupport(probe, 'AV1', '5.1') === 'no' &&
    getVideoDecoderSupport(probe, 'AV1 Main10', '5.1') === 'no';
}

// Detect what the TV can do, through its Tizen and Samsung product APIs. The API objects can be passed in for the tests
// ({ tizen, webapis, screen, tizentvwasm, mediaSource }), otherwise the global ones of the TV are used. Returns:
// - platformVer, modelName, modelSeries, modelCode: what the TV reports, or null if it can't be read
// - is4k, is8k, isHdr: the panel and HDR support, false if it can't be read
// - maxWidth, maxHeight: the largest resolution the resolution menu offers
// - connection: the active network connection type at the time of the detection ('ethernet', 'wifi' or 'unknown')
// - profile: the tested profile of this model (VERIFIED_PROFILES), or null
// - modelYearHint: the model year suggested by the model code, or null (only shown, never used for a decision)
// - wasmPlayer: whether the WASM player offers the Ultra Low Latency mode (detectWasmPlayerFeatures())
// - videoDecoders: the answers of the decoder check (probeVideoDecoders()), only shown and used for hints
function detectTvCapabilities(apis) {
  const given = apis || {};
  const tizenApi = given.tizen !== undefined ? given.tizen : getTvGlobal('tizen');
  const webApi = given.webapis !== undefined ? given.webapis : getTvGlobal('webapis');
  const screenInfo = given.screen !== undefined ? given.screen : getTvGlobal('screen');

  const platformVer = safeTvCall('Tizen platform version', function() {
    return tizenApi.systeminfo.getCapability('http://tizen.org/feature/platform.version');
  }, null);
  const modelSeries = safeTvCall('TV model series', function() {
    return webApi.productinfo.getModel();
  }, null);
  const modelName = safeTvCall('TV model name', function() {
    return webApi.productinfo.getRealModel();
  }, null);
  const modelCode = safeTvCall('TV model group', function() {
    return webApi.productinfo.getModelCode();
  }, null);
  // The panel checks don't exist on every firmware, so a missing function counts as no
  const is4k = !!safeTvCall('4K panel support', function() {
    return typeof webApi.productinfo.isUdPanelSupported === 'function' && webApi.productinfo.isUdPanelSupported();
  }, false);
  const is8k = !!safeTvCall('8K panel support', function() {
    return typeof webApi.productinfo.is8KPanelSupported === 'function' && webApi.productinfo.is8KPanelSupported();
  }, false);
  const isHdr = !!safeTvCall('HDR support', function() {
    return webApi.avinfo.isHdrTvSupport();
  }, false);

  // The resolution menu offers everything up to the panel resolution
  let maxWidth = 1920;
  let maxHeight = 1080;
  if (is8k) {
    maxWidth = 7680;
    maxHeight = 4320;
  } else if (is4k) {
    maxWidth = 3840;
    maxHeight = 2160;
  } else if (screenInfo && safeTvCall('screen size', function() {
    return screenInfo.width >= 2560 || screenInfo.height >= 1440;
  }, false)) {
    // The physical screen resolution happens to be 1440p
    maxWidth = 2560;
    maxHeight = 1440;
  }

  return {
    platformVer: platformVer,
    modelName: modelName,
    modelSeries: modelSeries,
    modelCode: modelCode,
    is4k: is4k,
    is8k: is8k,
    isHdr: isHdr,
    maxWidth: maxWidth,
    maxHeight: maxHeight,
    connection: detectConnectionType(webApi === undefined ? null : webApi),
    profile: findVerifiedProfile(modelName, modelSeries),
    modelYearHint: getModelYearHint(modelCode),
    wasmPlayer: detectWasmPlayerFeatures(given.tizentvwasm),
    videoDecoders: probeVideoDecoders(given.mediaSource),
  };
}

// Return the standard preset in Mbps for a resolution and frame rate, or null for a frame rate without a preset
function getStandardPresetBitrate(res, frameRate) {
  var presets = STANDARD_BITRATE_PRESETS[res];
  if (!presets) {
    // Unrecognized option! In case someone screws with the JS to add custom resolutions.
    return 10;
  }
  var preset = presets[String(frameRate)];
  return preset !== undefined ? preset : null;
}

// Return the highest bitrate in Mbps that the video decoder of the TV is recommended for: the tested value of its
// profile, otherwise what Samsung specifies for HEVC at 60 FPS on most 4K models, or on its Full HD models
function getDecoderCapMbps(caps) {
  if (caps && caps.profile && caps.profile.decoderCapMbps) {
    return caps.profile.decoderCapMbps;
  }
  return caps && (caps.is4k || caps.is8k) ? UHD_DECODER_CAP_MBPS : FHD_DECODER_CAP_MBPS;
}

// Get the recommended bitrate in Mbps for a resolution, a frame rate and the network connection type of the TV, starting
// from the standard preset of that resolution and frame rate:
// - Ethernet: 25 % above the preset, but at most 75 Mbps, because the bursts of packets from the much faster host PC
//   cause packet loss above that on the 100 Mbps port of Samsung TVs
// - Wi-Fi: 25 % above the preset, which 5 GHz Wi-Fi can carry
// - unknown connection: the preset, but at most 80 Mbps
// None of them goes above the decoder cap of the TV (getDecoderCapMbps()). For the tested model in VERIFIED_PROFILES this
// gives 75 / 100 / 80 Mbps for 4K at 60 FPS, the values it was tested with.
function recommendedBitrate(res, frameRate, connectionType, caps) {
  let preset = getStandardPresetBitrate(res, frameRate);
  if (preset === null) {
    // A frame rate without a preset gets the preset of 60 FPS
    preset = getStandardPresetBitrate(res, 60);
  }
  const decoderCap = getDecoderCapMbps(caps);
  switch (connectionType) {
    case 'ethernet':
      return Math.min(Math.round(preset * NETWORK_HEADROOM_FACTOR), RECOMMENDED_ETHERNET_BITRATE, decoderCap);
    case 'wifi':
      return Math.min(Math.round(preset * NETWORK_HEADROOM_FACTOR), decoderCap);
    default:
      return Math.min(preset, decoderCap, UNKNOWN_CONNECTION_MAX_BITRATE);
  }
}

// Return the bitrate in Mbps that the optimal streaming settings dialog suggests as the upper end for raising the
// bitrate over Wi-Fi, when the performance statistics show no dropped frames: twice the standard preset of the
// resolution and frame rate, but at most the highest bitrate of the slider and the decoder cap of the TV
// (getDecoderCapMbps()), above which the bitrate warning appears. When the recommended bitrate already reaches it, the
// dialog says so instead.
function bitrateRaiseLimit(res, frameRate, caps) {
  let preset = getStandardPresetBitrate(res, frameRate);
  if (preset === null) {
    // A frame rate without a preset gets the preset of 60 FPS
    preset = getStandardPresetBitrate(res, 60);
  }
  return Math.min(2 * preset, MAX_BITRATE_MBPS, getDecoderCapMbps(caps));
}

// Return the highest bitrate that a bitrate preset may set on this TV and network connection, as { mbps, reason }, or
// null for no limit:
// - over Ethernet RECOMMENDED_ETHERNET_BITRATE (reason 'ethernet'), since the 100 Mbps port that Samsung TVs usually
//   have can't carry more without packet loss
// - on a TV without a tested profile, also the highest bitrate that recommendedBitrate() gives for any resolution and
//   frame rate on this connection (reason 'recommended'): the decoder cap of the TV (getDecoderCapMbps()), and over an
//   unknown connection UNKNOWN_CONNECTION_MAX_BITRATE, so that a preset (e.g. 120 Mbps for 4K at 120 FPS) never sets a
//   bitrate above the recommendation of the app, which the bitrate warning would then warn about
// A TV with a tested profile keeps the standard presets above its decoder cap (e.g. 120 Mbps for 4K at 120 FPS on the
// first model of VERIFIED_PROFILES), which its tests went up to. The bitrate slider still goes up to MAX_BITRATE_MBPS on
// every TV.
function presetBitrateLimit(connectionType, caps) {
  let limit = null;
  if (connectionType === 'ethernet') {
    limit = { mbps: RECOMMENDED_ETHERNET_BITRATE, reason: 'ethernet' };
  }
  if (!(caps && caps.profile)) {
    let recommendedMax = getDecoderCapMbps(caps);
    if (connectionType !== 'ethernet' && connectionType !== 'wifi') {
      recommendedMax = Math.min(recommendedMax, UNKNOWN_CONNECTION_MAX_BITRATE);
    }
    if (!limit || recommendedMax < limit.mbps) {
      limit = { mbps: recommendedMax, reason: 'recommended' };
    }
  }
  return limit;
}

// Return the bitrate in Mbps as the bitrate slider (index.html) holds it: rounded to its steps of 0.5 Mbps, within 0.5
// and MAX_BITRATE_MBPS
function sliderBitrate(mbps) {
  return Math.min(MAX_BITRATE_MBPS, Math.max(0.5, Math.round(mbps * 2) / 2));
}

// Return the optimized bitrate preset ('Optimize bitrate presets') in Mbps for a resolution, frame rate, codec and HDR
// mode, before the bitrate slider rounds it: the luma samples per second divided by 8309 (SDR) or 6630.5 (HDR) give
// the bitrate in kbps for H.264, of which HEVC needs 60 % and AV1 40 %. A result that isn't positive gives 10 kbps.
// Sweet-spot formula reference: https://www.reddit.com/r/MoonlightStreaming/comments/1gg2cdy/sweet_spot_bitrate/
function getOptimizedPresetBitrate(res, frameRate, videoCodec, hdrMode) {
  const size = parseResolution(res) || { width: NaN, height: NaN };
  // Multiplier to adjust bitrate based on codec efficiency
  const codecMultiplier = { H264: 1.0, HEVC: 0.6, AV1: 0.4 }[videoCodec];
  // Bitrate factor depends on HDR state
  const bitrateFactor = hdrMode ? 6630.5 : 8309;
  const baseBitrate = size.width * size.height * Number(frameRate) / bitrateFactor;
  let finalBitrate = Math.round(baseBitrate * codecMultiplier);
  // Apply the default bitrate value in case of invalid calculation
  if (finalBitrate <= 0) {
    finalBitrate = 10;
  }
  return finalBitrate / 1000;
}

// Return the bitrates in Mbps that the standard and the optimized bitrate presets set for a resolution, frame rate,
// codec and HDR mode on this TV and network connection, rounded like the bitrate slider and limited like
// presetBitrateLimit() says, as { standard, optimized }. standard is null for a frame rate without a standard preset,
// which leaves the bitrate as it is.
function presetBitrates(res, frameRate, videoCodec, hdrMode, connectionType, caps) {
  const limit = presetBitrateLimit(connectionType, caps);
  const limited = function(mbps) {
    const bitrate = sliderBitrate(mbps);
    return limit && bitrate > limit.mbps ? limit.mbps : bitrate;
  };
  const standard = getStandardPresetBitrate(res, frameRate);
  return {
    standard: standard === null ? null : limited(standard),
    optimized: limited(getOptimizedPresetBitrate(res, frameRate, videoCodec, hdrMode)),
  };
}

// Return the default of the game mode (Ultra Low Latency mode of the WASM player) for a Tizen platform version and the
// answer of the WASM player whether it offers that mode ('yes', 'no' or 'unknown', see detectWasmPlayerFeatures()):
// - null when the WASM player says that it doesn't offer the mode, whose glue code would fall back to the Low Latency
//   mode anyway (the switch stays off and disabled, and no value is stored)
// - false on Tizen 9.0 and newer, where it can freeze the video on the first frame (the ForceGM variant asks the TV for
//   its Game Mode instead)
// - on Tizen 5.5, whose WASM player didn't offer it: false (off, but the switch can be turned on) when the WASM player
//   says that it does offer it, and otherwise null
// - true on every other version (e.g. 6.0, 6.5, 7.0 and 8.0)
function getGameModeDefault(platformVer, ultraLowLatency) {
  if (ultraLowLatency === 'no') {
    return null;
  }
  const version = parseFloat(platformVer);
  if (version >= 9.0) {
    return false;
  } else if (version === 5.5) {
    return ultraLowLatency === 'yes' ? false : null;
  }
  return true;
}

// Whether the game mode switch stays off and disabled on this TV whatever is stored: when the WASM player says that it
// doesn't offer the Ultra Low Latency mode (see detectWasmPlayerFeatures())
function isGameModeUnavailable(caps) {
  return !!(caps && caps.wasmPlayer && caps.wasmPlayer.ultraLowLatency === 'no');
}

// Derive the optimal video settings for a TV (see detectTvCapabilities()) and the network connection type. They are the
// defaults of a fresh install and what Restore Defaults and the optimal streaming settings button apply:
// - the highest resolution of the panel up to 4K, at 60 FPS, because Tizen apps commonly render at around 60 FPS
// - HEVC, the most efficient codec that every host GPU with HDR support can encode, and HDR when the TV supports it,
//   which streams HDR10 when HDR is enabled on the host and 10-bit SDR otherwise
// - the recommended bitrate for the resolution, frame rate and connection (recommendedBitrate())
// - 'Unlock all frame rates' only for a tested profile with a high refresh rate panel, since most TVs show 60 Hz
// - the game mode by Tizen version and by what the WASM player offers (getGameModeDefault()), with null meaning off,
//   disabled and not stored
// - frame pacing on, the limited color range (the standard for video, which keeps the detail in dark and bright areas),
//   and the standard bitrate presets instead of the optimized ones, which aim for a lower bitrate
function deriveOptimalSettings(caps, connectionType) {
  const capabilities = caps || {};
  const profile = capabilities.profile || null;
  const resolution = capabilities.is4k || capabilities.is8k ? '3840:2160' : '1920:1080';
  const frameRate = 60;
  return {
    resolution: resolution,
    frameRate: frameRate,
    videoCodec: 'HEVC',
    hdrMode: !!capabilities.isHdr,
    bitrate: recommendedBitrate(resolution, frameRate, connectionType, capabilities),
    unlockAllFps: profile ? !!profile.unlockAllFps : false,
    gameMode: getGameModeDefault(capabilities.platformVer, capabilities.wasmPlayer ? capabilities.wasmPlayer.ultraLowLatency : 'unknown'),
    framePacing: true,
    fullRange: false,
    optimizeBitrate: false,
  };
}

// Message keys of the warnings and hints for the video settings. The rules below decide which one applies to a TV
// (see detectTvCapabilities()), and showVideoWarning() in index.js shows the text of each key, where i18n-sync.js finds
// the texts for the locale files.
const VIDEO_WARNINGS = Object.freeze({
  // More than 60 FPS on a TV without a tested 120 Hz profile, whose panel and Tizen app may show only about 60 FPS
  FPS_ABOVE_60_HZ: 'fpsAbove60Hz',
  // A stream above the luma sample rate of level 5.1 (e.g. 4K at 90 or 120 FPS) on a 4K TV without a tested 120 Hz
  // profile
  NEEDS_LEVEL_52: 'needsLevel52',
  // A stream above the luma sample rate of level 5.2 (4K at 144 FPS), the highest level that the app asks the TV for
  EXCEEDS_LEVEL_52: 'exceedsLevel52',
  // The same on a TV with a tested 120 Hz profile, whose decoder handled 4K at up to 120 FPS in the tests
  EXCEEDS_TESTED_DECODER: 'exceedsTestedDecoder',
  // More than 1080p and more than 60 FPS within level 5.2 on a TV with a tested 120 Hz profile
  HIGH_RESOLUTION_FPS: 'highResolutionFps',
  // 90 FPS, which neither a 60 Hz nor a 120 Hz output divides evenly
  FPS_90_CADENCE: 'cadenceAt90Fps',
  // HDR switched on for a TV that doesn't report HDR support
  HDR_NOT_REPORTED: 'hdrNotReported',
  // A bitrate above what the 100 Mbps Ethernet port that Samsung TVs usually have can carry (ETHERNET_MAX_BITRATE)
  ETHERNET_BITRATE: 'ethernetBitrate',
  // A bitrate above the decoder cap of the TV (getDecoderCapMbps())
  BITRATE_ABOVE_CAP: 'bitrateAboveCap',
  // H.264 above 1080p, which Samsung TVs generally can't decode
  H264_RESOLUTION: 'h264Resolution',
});

// Return the width and height in pixels of a resolution value of the resolution menu (e.g. '3840:2160'), or null
function parseResolution(res) {
  const parts = String(res).split(':');
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  return parts.length === 2 && width > 0 && height > 0 ? { width: width, height: height } : null;
}

// Whether the TV has a tested profile of a model whose panel runs at 120 Hz or more (VERIFIED_PROFILES), which also
// means that its decoder handled 4K at up to 120 FPS in the tests
function hasTested120HzProfile(caps) {
  return !!(caps && caps.profile && caps.profile.refresh120);
}

// Return the message key of the warning for a resolution and frame rate on a TV (VIDEO_WARNINGS), or null. It returns
// one key, the first that applies:
// - above the luma sample rate of level 5.2 (4K at 144 FPS), a warning on every TV, which on a TV with a tested 120 Hz
//   profile names the 4K at 120 FPS that its decoder handled
// - without a tested 120 Hz profile: on a 4K TV above the luma sample rate of level 5.1 (e.g. 4K at 90 or 120 FPS), that
//   it needs a level 5.2 decoder, and otherwise above 60 FPS at any resolution, that many Samsung TVs have 60 Hz panels.
//   So a 4K stream above 60 FPS gets the level 5.2 warning, and the 60 Hz panel warning appears for lower resolutions
//   above 60 FPS (up to 1440p, or 1800p at 90 FPS). An 8K TV decodes 8K at 60 FPS, beyond level 5.2, so it gets the
//   60 Hz panel warning there instead, since its panel may run at 60 Hz as well.
// - with a tested 120 Hz profile: above 1080p and above 60 FPS, that it may not perform well on slower connections
function resolutionFramerateWarningKey(res, frameRate, caps) {
  const size = parseResolution(res);
  const fps = parseInt(frameRate, 10);
  if (!size || !(fps > 0)) {
    return null;
  }
  const lumaSampleRate = size.width * size.height * fps;
  const tested120Hz = hasTested120HzProfile(caps);
  if (lumaSampleRate > LEVEL_52_MAX_LUMA_SAMPLE_RATE) {
    return tested120Hz ? VIDEO_WARNINGS.EXCEEDS_TESTED_DECODER : VIDEO_WARNINGS.EXCEEDS_LEVEL_52;
  }
  if (!tested120Hz) {
    if (lumaSampleRate > LEVEL_51_MAX_LUMA_SAMPLE_RATE && !(caps && caps.is8k)) {
      return VIDEO_WARNINGS.NEEDS_LEVEL_52;
    }
    return fps > 60 ? VIDEO_WARNINGS.FPS_ABOVE_60_HZ : null;
  }
  return size.width > 1920 && size.height > 1080 && fps > 60 ? VIDEO_WARNINGS.HIGH_RESOLUTION_FPS : null;
}

// Return the message key of the cadence hint for a frame rate (VIDEO_WARNINGS), or null. 90 FPS divides neither a 60 Hz
// nor a 120 Hz output evenly, which holds for every TV.
function framerateCadenceWarningKey(frameRate) {
  return parseInt(frameRate, 10) === 90 ? VIDEO_WARNINGS.FPS_90_CADENCE : null;
}

// Return the message key of the warning for the HDR mode on a TV (VIDEO_WARNINGS), or null: HDR switched on for a TV
// that doesn't report HDR support
function hdrWarningKey(hdrMode, caps) {
  return hdrMode && !(caps && caps.isHdr) ? VIDEO_WARNINGS.HDR_NOT_REPORTED : null;
}

// Return the message key of the warning for a bitrate in Mbps on a TV with the network connection type (VIDEO_WARNINGS),
// or null: above ETHERNET_MAX_BITRATE over Ethernet, the 100 Mbps port that Samsung TVs usually have, and otherwise above
// the decoder cap of the TV (getDecoderCapMbps(), e.g. 100 Mbps for a tested model, 80 Mbps for other 4K and 8K TVs)
function bitrateWarningKey(bitrate, connectionType, caps) {
  const mbps = parseFloat(bitrate);
  if (!(mbps > 0)) {
    return null;
  }
  if (connectionType === 'ethernet' && mbps > ETHERNET_MAX_BITRATE) {
    return VIDEO_WARNINGS.ETHERNET_BITRATE;
  }
  return mbps > getDecoderCapMbps(caps) ? VIDEO_WARNINGS.BITRATE_ABOVE_CAP : null;
}

// Return the message key of the warning for a video codec at a resolution (VIDEO_WARNINGS), or null: H.264 above 1080p,
// which Samsung TVs generally decode only up to level 4.2 (1080p)
function h264ResolutionWarningKey(videoCodec, res) {
  const size = parseResolution(res);
  return videoCodec === 'H264' && size && size.width > 1920 ? VIDEO_WARNINGS.H264_RESOLUTION : null;
}

// Frozen copy of the default resolution of settings schema 1: the highest resolution of the menu up to 4K, including
// 1440p for a screen that reports at least 2560 x 1440 pixels
function legacyOptimalResolution(maxWidth) {
  if (maxWidth >= 3840) {
    return '3840:2160';
  } else if (maxWidth >= 2560) {
    return '2560:1440';
  }
  return '1920:1080';
}

// Frozen copy of the resolution that settings schema 1 loaded for a stored resolution: one wider than the resolution
// menu offers was replaced by 4K, or by 1080p on a TV without a 4K panel, and stored before the state of the bitrate
// presets was decided from it (see legacySettingsSnapshot())
function legacyLoadedResolution(storedResolution, maxWidth) {
  if (storedResolution == null) {
    return storedResolution;
  }
  const width = parseInt(String(storedResolution).split(':')[0], 10);
  if (width > maxWidth) {
    return maxWidth >= 3840 ? '3840:2160' : '1920:1080';
  }
  return storedResolution;
}

// Frozen copy of the default video settings of settings schema 1, for a TV (see detectTvCapabilities()), its network
// connection type and the stored video codec (null if none is stored). Never change these rules: the snapshot of an
// existing install has to store exactly what it showed before, also after the defaults for new installs changed.
function legacyDefaults(caps, connectionType, storedVideoCodec) {
  const capabilities = caps || {};
  const videoCodec = storedVideoCodec != null ? storedVideoCodec : 'HEVC';
  const version = parseFloat(capabilities.platformVer);
  let gameMode = true;
  if (version >= 9.0) {
    gameMode = false;
  } else if (version === 5.5) {
    gameMode = null;
  }
  return {
    resolution: legacyOptimalResolution(capabilities.maxWidth),
    unlockAllFps: true,
    frameRate: 60,
    bitrate: Object.prototype.hasOwnProperty.call(LEGACY_DEFAULT_BITRATES, connectionType) ? LEGACY_DEFAULT_BITRATES[connectionType] : LEGACY_DEFAULT_BITRATES.unknown,
    videoCodec: 'HEVC',
    // HDR was on for HDR-capable TVs, unless the stored codec is H.264, which has no HDR profile
    hdrMode: !!capabilities.isHdr && videoCodec !== 'H264',
    framePacing: true,
    fullRange: false,
    optimizeBitrate: false,
    gameMode: gameMode,
  };
}

// Decide whether a stored bitrate came from the bitrate presets, which earlier versions applied on every resolution and
// frame rate change, so that it keeps following the video settings. The optimized presets always follow them. A stored
// bitrate that differs from the standard preset of the stored resolution and frame rate (limited to 75 Mbps over
// Ethernet, like the presets are) was picked by hand or set by the optimal streaming settings, and is kept.
// `stored` holds the stored values of bitrate, resolution, frameRate and optimizeBitrate (null when unset).
function followsBitratePresets(stored, connectionType) {
  const values = stored || {};
  let followsPresets = values.optimizeBitrate == true;
  if (!followsPresets && values.bitrate != null && values.resolution != null && values.frameRate != null) {
    let preset = getStandardPresetBitrate(values.resolution, values.frameRate);
    if (preset !== null && preset > RECOMMENDED_ETHERNET_BITRATE && connectionType === 'ethernet') {
      preset = RECOMMENDED_ETHERNET_BITRATE;
    }
    followsPresets = preset !== null && parseFloat(values.bitrate) === preset;
  }
  return followsPresets;
}

// Return the settings that the one-time snapshot of settings schema 2 stores for an existing install: for every video
// setting that is still unset, the value that settings schema 1 showed for it (legacyDefaults()), and for the state of
// the bitrate presets the decision that settings schema 1 made from the stored values (followsBitratePresets()), which
// saw a stored resolution above the resolution menu already replaced (legacyLoadedResolution()). Stored values are never
// replaced, and the game mode is left out on Tizen 5.5, where a stored value would enable its switch. The bitrate is
// stored as text, like the bitrate slider stores it.
function legacySettingsSnapshot(stored, caps, connectionType) {
  const values = stored || {};
  const defaults = legacyDefaults(caps, connectionType, values.videoCodec);
  defaults.autoAdjustBitrate = followsBitratePresets(Object.assign({}, values, {
    resolution: legacyLoadedResolution(values.resolution, caps ? caps.maxWidth : undefined),
  }), connectionType);
  const snapshot = {};
  LEGACY_SNAPSHOT_KEYS.forEach(function(key) {
    if (values[key] == null && defaults[key] != null) {
      snapshot[key] = key === 'bitrate' ? String(defaults[key]) : defaults[key];
    }
  });
  return snapshot;
}

// Return the settings that the one-time snapshot of settings schema 3 stores for an existing install of settings schema
// 2 or older: the default of settings schema 2 (SCHEMA_2_DEFAULTS) for every setting whose default changed and that is
// still unset, so that the install shows what it showed before. Stored values are never replaced.
function schema2Snapshot(stored) {
  const values = stored || {};
  const snapshot = {};
  Object.keys(SCHEMA_2_DEFAULTS).forEach(function(key) {
    if (values[key] == null) {
      snapshot[key] = SCHEMA_2_DEFAULTS[key];
    }
  });
  return snapshot;
}

// Export the functions and constants for the unit tests in Node, where this file is loaded as a module
if (typeof module === 'object' && module && module.exports) {
  module.exports = {
    SETTINGS_SCHEMA_VERSION: SETTINGS_SCHEMA_VERSION,
    SETTINGS_SCHEMA_KEY: SETTINGS_SCHEMA_KEY,
    RECOMMENDED_ETHERNET_BITRATE: RECOMMENDED_ETHERNET_BITRATE,
    ETHERNET_MAX_BITRATE: ETHERNET_MAX_BITRATE,
    UNKNOWN_CONNECTION_MAX_BITRATE: UNKNOWN_CONNECTION_MAX_BITRATE,
    UHD_DECODER_CAP_MBPS: UHD_DECODER_CAP_MBPS,
    FHD_DECODER_CAP_MBPS: FHD_DECODER_CAP_MBPS,
    MAX_BITRATE_MBPS: MAX_BITRATE_MBPS,
    LEVEL_51_MAX_LUMA_SAMPLE_RATE: LEVEL_51_MAX_LUMA_SAMPLE_RATE,
    LEVEL_52_MAX_LUMA_SAMPLE_RATE: LEVEL_52_MAX_LUMA_SAMPLE_RATE,
    VERIFIED_PROFILES: VERIFIED_PROFILES,
    VIDEO_WARNINGS: VIDEO_WARNINGS,
    STANDARD_BITRATE_PRESETS: STANDARD_BITRATE_PRESETS,
    LEGACY_DEFAULT_BITRATES: LEGACY_DEFAULT_BITRATES,
    LEGACY_SNAPSHOT_KEYS: LEGACY_SNAPSHOT_KEYS,
    EMSS_API_NAME: EMSS_API_NAME,
    ULTRA_LOW_LATENCY_FEATURE: ULTRA_LOW_LATENCY_FEATURE,
    VIDEO_DECODER_PROBES: VIDEO_DECODER_PROBES,
    BOGUS_CODEC_PROBE: BOGUS_CODEC_PROBE,
    H264_CONTROL_PROBE: H264_CONTROL_PROBE,
    safeTvCall: safeTvCall,
    detectConnectionType: detectConnectionType,
    findVerifiedProfile: findVerifiedProfile,
    getModelYearHint: getModelYearHint,
    detectWasmPlayerFeatures: detectWasmPlayerFeatures,
    probeVideoDecoders: probeVideoDecoders,
    getVideoDecoderSupport: getVideoDecoderSupport,
    isAv1ReportedUnsupported: isAv1ReportedUnsupported,
    detectTvCapabilities: detectTvCapabilities,
    getStandardPresetBitrate: getStandardPresetBitrate,
    getDecoderCapMbps: getDecoderCapMbps,
    recommendedBitrate: recommendedBitrate,
    bitrateRaiseLimit: bitrateRaiseLimit,
    presetBitrateLimit: presetBitrateLimit,
    sliderBitrate: sliderBitrate,
    getOptimizedPresetBitrate: getOptimizedPresetBitrate,
    presetBitrates: presetBitrates,
    getGameModeDefault: getGameModeDefault,
    isGameModeUnavailable: isGameModeUnavailable,
    deriveOptimalSettings: deriveOptimalSettings,
    parseResolution: parseResolution,
    hasTested120HzProfile: hasTested120HzProfile,
    resolutionFramerateWarningKey: resolutionFramerateWarningKey,
    framerateCadenceWarningKey: framerateCadenceWarningKey,
    hdrWarningKey: hdrWarningKey,
    bitrateWarningKey: bitrateWarningKey,
    h264ResolutionWarningKey: h264ResolutionWarningKey,
    legacyOptimalResolution: legacyOptimalResolution,
    legacyLoadedResolution: legacyLoadedResolution,
    legacyDefaults: legacyDefaults,
    followsBitratePresets: followsBitratePresets,
    legacySettingsSnapshot: legacySettingsSnapshot,
    SCHEMA_2_DEFAULTS: SCHEMA_2_DEFAULTS,
    SCHEMA_3_REMOVED_KEYS: SCHEMA_3_REMOVED_KEYS,
    schema2Snapshot: schema2Snapshot,
  };
}
