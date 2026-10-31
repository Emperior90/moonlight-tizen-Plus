'use strict';

// Checks how wasm/platform/index.js uses the TV capability profile of wasm/platform/tv_profile.js when both are loaded
// like on a TV (index.html loads tv_profile.js first): the globals it takes from the detected capabilities, the
// standard bitrate presets and Ethernet limits it shares with the profile, the connection type detection, the tested
// profile of the S90C, and that a failing Tizen or Samsung API no longer stops index.js from loading. The rules of the profile itself
// are checked in tv-profile.test.js, and the browser tests check how the settings screen uses them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SCRIPTS, createPlatformContext, loadPlatformScripts, plain } = require('./helpers/platform-loader');

// Load tv_profile.js and index.js on a simulated TV (see tests/browser/mocks/tv-mock.js) and return the platform context
function onTv(tvOptions, screen) {
  return loadPlatformScripts(INDEX_SCRIPTS, { tv: tvOptions, screen });
}

test('the S90C keeps its recommended bitrates of 75 / 100 / 80 Mbps at 4K', () => {
  const platform = onTv({ tv: 's90c' });
  const derive = (conn) => plain(platform.get('deriveOptimalSettings')(platform.get('tvCapabilities'), conn));
  assert.deepEqual(['ethernet', 'wifi', 'unknown'].map((conn) => derive(conn).bitrate), [75, 100, 80]);
  assert.equal(derive('wifi').resolution, '3840:2160');
});

test('other TVs get the recommended bitrate for their panel and connection', () => {
  const bitratesOn = (tv) => {
    const platform = onTv({ tv });
    return ['ethernet', 'wifi', 'unknown'].map((conn) => platform.get('deriveOptimalSettings')(platform.get('tvCapabilities'), conn).bitrate);
  };
  assert.deepEqual(bitratesOn('uhd'), [75, 80, 80]);
  assert.deepEqual(bitratesOn('8k'), [75, 80, 80]);
  assert.deepEqual(bitratesOn('fhd'), [25, 25, 20]);
});

test('the bitrate limits for the 100 Mbps Ethernet port', () => {
  const platform = onTv({ tv: 's90c' });
  assert.equal(platform.get('ETHERNET_MAX_BITRATE'), 80);
  assert.equal(platform.get('RECOMMENDED_ETHERNET_BITRATE'), 75);
  // The fixed bitrates of the S90C tuning only remain as the frozen defaults of settings schema 1
  assert.equal(platform.get('typeof getRecommendedBitrate'), 'undefined');
  assert.deepEqual(plain(platform.get('LEGACY_DEFAULT_BITRATES')), { ethernet: 75, wifi: 100, unknown: 80 });
});

test('the default resolution is the highest the panel supports, up to 4K', () => {
  const resolutionOn = (tvOptions, screen) => {
    const platform = onTv(tvOptions, screen);
    return platform.get('deriveOptimalSettings')(platform.get('tvCapabilities'), 'wifi').resolution;
  };
  assert.equal(resolutionOn({ tv: 's90c' }), '3840:2160');
  assert.equal(resolutionOn({ tv: 'uhd' }), '3840:2160');
  assert.equal(resolutionOn({ tv: '8k' }), '3840:2160');
  assert.equal(resolutionOn({ tv: 'fhd' }), '1920:1080');
  // A screen that reports 1440p no longer decides the default: Samsung sells no 1440p panels
  assert.equal(resolutionOn({ tv: 'fhd' }, { width: 2560, height: 1440 }), '1920:1080');
});

test('the frozen defaults of settings schema 1 keep the 1440p screen check for the snapshot of existing installs', () => {
  const platform = onTv({ tv: 'fhd' }, { width: 2560, height: 1440 });
  assert.equal(platform.get('legacyDefaults')(platform.get('tvCapabilities'), 'wifi', null).resolution, '2560:1440');
  assert.equal(onTv({ tv: 's90c' }).get('legacyDefaults(tvCapabilities, "wifi", null).resolution'), '3840:2160');
});

test('the largest supported size follows the panel APIs', () => {
  const sizeOn = (tvOptions, screen) => plain(onTv(tvOptions, screen).get('[maxSupportedWidth, maxSupportedHeight]'));
  assert.deepEqual(sizeOn({ tv: '8k' }), [7680, 4320]);
  assert.deepEqual(sizeOn({ tv: 's90c' }), [3840, 2160]);
  assert.deepEqual(sizeOn({ tv: 'fhd' }), [1920, 1080]);
  // The resolution menu still offers 1440p on a non-4K TV whose screen reports at least 2560 pixels
  assert.deepEqual(sizeOn({ tv: 'fhd' }, { width: 2560, height: 1440 }), [2560, 1440]);
});

test('the standard bitrate presets in Mbps', () => {
  const platform = onTv({ tv: 's90c' });
  assert.deepEqual(plain(platform.get('STANDARD_BITRATE_PRESETS')), {
    '854:480': { 30: 2, 60: 4, 90: 5, 120: 6, 144: 8 },
    '1280:720': { 30: 5, 60: 10, 90: 12, 120: 15, 144: 18 },
    '1920:1080': { 30: 10, 60: 20, 90: 25, 120: 30, 144: 35 },
    '2560:1440': { 30: 20, 60: 40, 90: 50, 120: 60, 144: 70 },
    '3200:1800': { 30: 30, 60: 60, 90: 75, 120: 90, 144: 100 },
    '3840:2160': { 30: 40, 60: 80, 90: 100, 120: 120, 144: 140 },
  });
  const getStandardPresetBitrate = platform.get('getStandardPresetBitrate');
  assert.equal(getStandardPresetBitrate('3840:2160', 60), 80);
  assert.equal(getStandardPresetBitrate('1920:1080', '60'), 20);
  assert.equal(getStandardPresetBitrate('3840:2160', 75), null, 'a frame rate without a preset');
  assert.equal(getStandardPresetBitrate('1000:1000', 60), 10, 'an unknown resolution falls back to 10 Mbps');
});

test('the connection type comes from the network API of the TV', () => {
  assert.equal(onTv({ conn: 'ethernet' }).get('getActiveConnectionType()'), 'ethernet');
  assert.equal(onTv({ conn: 'wifi' }).get('getActiveConnectionType()'), 'wifi');
  assert.equal(onTv({ conn: 'unknown' }).get('getActiveConnectionType()'), 'unknown');
  // A failing API counts as unknown and logs a warning instead of throwing
  const failing = onTv({ conn: 'error' });
  assert.equal(failing.get('getActiveConnectionType()'), 'unknown');
  assert.ok(failing.consoleMessages.some((message) => message.level === 'warn' && message.text.indexOf('Failed to get the active network connection type') >= 0));
});

test('the connection type falls back to the documented constants (WIFI = 1, ETHERNET = 3)', () => {
  const platform = onTv({ conn: 'ethernet' });
  platform.run('delete webapis.network.NetworkActiveConnectionType');
  assert.equal(platform.get('getActiveConnectionType()'), 'ethernet');
  platform.run('webapis.network.getActiveConnectionType = function() { return 1; }');
  assert.equal(platform.get('getActiveConnectionType()'), 'wifi');
});

test('the tested profile of the S90C is selected by the model name or the model series', () => {
  const profileOn = (tvOptions) => onTv(tvOptions).get('tvCapabilities.profile ? tvCapabilities.profile.id : null');
  assert.equal(profileOn({ tv: 's90c' }), 'S90C');
  assert.equal(profileOn({ tv: 'uhd' }), null);
  assert.equal(profileOn({ tv: 'fhd' }), null);
  assert.equal(profileOn({ tv: 'uhd', model: 'qe65s90caexxu' }), 'S90C', 'case-insensitive, other sizes and regions');
  assert.equal(profileOn({ tv: 'uhd', series: '23_S90C_OLED' }), 'S90C', 'from the model series');
  assert.equal(profileOn({ tv: 'uhd', model: 'QE55S95CAT' }), null, 'the S95C is another model');
  // The model check only drove the 'not an S90C' note of the dialog, which is gone
  assert.equal(onTv({ tv: 's90c' }).get('typeof isS90cModel'), 'undefined');
});

test('the HDR capability and the panel flags come from the product APIs', () => {
  const s90c = onTv({ tv: 's90c' });
  assert.deepEqual(plain(s90c.get('[isHdrCapable, is4kPanel, is8kPanel, platformVer]')), [true, true, false, '9.0']);
  const fhd = onTv({ tv: 'fhd' });
  assert.deepEqual(plain(fhd.get('[isHdrCapable, is4kPanel, is8kPanel, platformVer]')), [false, false, false, '5.5']);
  assert.deepEqual(plain(s90c.get('[modelName, modelSeries, modelGroup]')), ['QE55S90CAT', '23_PONTUSM_OLED', '23_PONTUSM']);
});

test('the ForceGM variant is detected from the game mode metadata of the app', () => {
  assert.equal(onTv({ tv: 's90c' }).get('checkForceGMVariant()'), false);
  assert.equal(onTv({ tv: 's90c', forceGM: true }).get('checkForceGMVariant()'), true);
});

test('index.js loads when the Tizen and Samsung APIs fail, with the fallbacks of a Full HD TV without HDR', () => {
  const platform = createPlatformContext({ tv: { tv: 's90c' } });
  // Every call that index.js made at load without protection before, failing in a different way
  platform.run(`
    tizen.application.getAppInfo = function() { throw new Error('Simulated missing privilege'); };
    tizen.systeminfo.getCapability = function() { throw new Error('Simulated systeminfo failure'); };
    webapis.productinfo.getModel = function() { throw new Error('Simulated productinfo failure'); };
    webapis.productinfo.getRealModel = function() { return null; };
    delete webapis.productinfo.getModelCode;
    webapis.productinfo.isUdPanelSupported = function() { throw new Error('Simulated panel check failure'); };
    delete webapis.avinfo;
  `);
  INDEX_SCRIPTS.forEach((script) => platform.load(script));
  assert.deepEqual(
    plain(platform.get('[platformVer, modelSeries, modelName, modelGroup, is4kPanel, is8kPanel, isHdrCapable, maxSupportedWidth, tvCapabilities.profile]')),
    [null, null, null, null, false, false, false, 1920, null]);
  assert.deepEqual(plain(platform.get('appInfo')), { id: '', packageId: '', name: 'Moonlight', version: '' });
  const warnings = platform.consoleMessages.filter((message) => message.level === 'warn').map((message) => message.text);
  for (const label of ['application information', 'Tizen platform version', 'TV model series', 'TV model group', '4K panel support', 'HDR support']) {
    assert.ok(warnings.some((text) => text.indexOf('Failed to get the ' + label) >= 0), label + ': ' + JSON.stringify(warnings));
  }
  // The defaults follow from the fallbacks
  assert.deepEqual(plain(platform.get('deriveOptimalSettings(tvCapabilities, "wifi")')), {
    resolution: '1920:1080', frameRate: 60, videoCodec: 'HEVC', hdrMode: false, bitrate: 25, unlockAllFps: false, gameMode: true,
    framePacing: true, fullRange: false,
  });
});

test('index.js loads without any webapis object', () => {
  const platform = createPlatformContext({ tv: { tv: 'uhd' } });
  platform.run('delete window.webapis');
  INDEX_SCRIPTS.forEach((script) => platform.load(script));
  assert.deepEqual(plain(platform.get('[platformVer, modelName, is4kPanel, isHdrCapable, maxSupportedWidth]')), ['6.5', null, false, false, 1920]);
  assert.equal(platform.get('getActiveConnectionType()'), 'unknown');
});
