'use strict';

// Checks that every rule that depends on the Tizen version, the model year or the firmware treats a Tizen 10 TV (the
// models of 2026, and older TVs that Samsung updates) the way it treats Tizen 9, and that later versions such as 10.5
// and 11.0 follow as well. Tizen 10 reports a version with two digits before the dot, which a comparison of the text
// would take for older than 9.0 ('10.0' >= '9.0' is false in JavaScript), and that would turn the Ultra low latency
// mode on, which can freeze the picture there. Loads wasm/platform/tv_profile.js as a module and tv_profile.js +
// index.js in a vm context on a simulated TV (tests/browser/mocks/tv-mock.js): a differential of everything that the
// rules derive on Tizen 9.0 and 10.0, every comparison of the platform version in wasm/platform, the model year and
// firmware strings of 2026, the fallback for a version that can't be read, and the rule that tells a game mode switch
// stored before an update of the TV to Tizen 9.0 or newer (isGameModeFromBeforeTizen9()). No Tizen 10 TV has run
// Moonlight Plus yet: the strings of the 2026 TV are illustrative, and tests/browser/tizen10.test.js runs the real UI on
// such a simulated TV.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const tvMock = require('../browser/mocks/tv-mock');
const profile = require('../../wasm/platform/tv_profile');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

// An illustrative 2026 UHD TV: the strings follow the pattern of the presets (year prefix of the model code, firmware
// 'T-<project><year>-<build>'), they are not read from a real device
const TV_2026 = { tv: 'uhd', model: 'QE65Q80HAT', series: '26_PONTUSM_QTV', modelCode: '26_PONTUSM', firmware: 'T-INFOLINK2026-1000' };
const CONNECTIONS = ['ethernet', 'wifi', 'unknown'];
const ULL_ANSWERS = ['unknown', 'yes', 'no'];

function apisFor(tvOptions) {
  const apis = tvMock.createTizenApis(tvMock.parseConfig('', tvOptions), (callback) => callback());
  return { tizen: apis.tizen, webapis: apis.webapis };
}

function detect(tvOptions) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = function() {
    warnings.push(Array.prototype.map.call(arguments, String).join(' '));
  };
  try {
    const caps = profile.detectTvCapabilities(apisFor(tvOptions));
    caps.warnings = warnings;
    return caps;
  } finally {
    console.warn = originalWarn;
  }
}

// Everything that the rules derive from the capabilities, for a differential comparison of two versions
function derived(caps) {
  const out = {};
  for (const conn of CONNECTIONS) {
    out[conn] = {
      optimal: profile.deriveOptimalSettings(caps, conn),
      legacy: profile.legacyDefaults(caps, conn, null),
      snapshot: profile.legacySettingsSnapshot({}, caps, conn),
      raise: profile.bitrateRaiseLimit('3840:2160', 60, caps),
      warnings: ['1920:1080', '2560:1440', '3840:2160'].map((res) => [30, 60, 90, 120].map((fps) => [
        profile.resolutionFramerateWarningKey(res, fps, caps), profile.h264WarningKey('H264', res, fps, caps),
        profile.bitrateWarningKey(150, conn, caps)])),
    };
  }
  out.unavailable = profile.isGameModeUnavailable(caps);
  return out;
}

describe('Tizen 10 against Tizen 9 (differential)', () => {
  for (const tv of [TV_2026, { tv: 's90c' }, { tv: '8k' }, { tv: 'fhd' }]) {
    test(`${tv.model || tv.tv}: every derived value on Tizen 10.0 equals Tizen 9.0`, () => {
      const t9 = detect(Object.assign({}, tv, { tizen: '9.0' }));
      const t10 = detect(Object.assign({}, tv, { tizen: '10.0' }));
      assert.equal(t10.platformVer, '10.0');
      assert.deepEqual(t10.warnings, []);
      assert.deepEqual(derived(t10), derived(t9));
    });
  }

  test('getGameModeDefault(): 10.0, 10, 10.0.0, 10.5, 11.0 and 12.0 give what 9.0 gives, for every answer of the WASM player', () => {
    for (const answer of ULL_ANSWERS) {
      const t9 = profile.getGameModeDefault('9.0', answer);
      for (const version of ['10.0', '10', '10.0.0', ' 10.0', '10.5', '11.0', '12.0', 10]) {
        assert.equal(profile.getGameModeDefault(version, answer), t9, JSON.stringify(version) + ' / ' + answer);
      }
    }
    assert.equal(profile.getGameModeDefault('10.0', 'unknown'), false, 'off, switch enabled');
    assert.equal(profile.getGameModeDefault('10.0', 'yes'), false, 'off, switch enabled');
    assert.equal(profile.getGameModeDefault('10.0', 'no'), null, 'off and disabled');
  });

  test('the lexicographic trap exists in JavaScript, and tv_profile.js avoids it', () => {
    // A string comparison would treat Tizen 10 as older than Tizen 9
    assert.equal('10.0' >= '9.0', false);
    assert.equal(parseFloat('10.0') >= 9.0, true);
    // The rule of 9.0 and newer applies to 10.0 in the defaults of settings schema 1 as well
    assert.equal(profile.legacyDefaults({ platformVer: '10.0', maxWidth: 3840 }, 'wifi', null).gameMode, false);
  });

  test('every comparison of the platform version in wasm/platform goes through parseFloat()', () => {
    const dir = path.join(REPO_ROOT, 'wasm', 'platform');
    const offenders = [];
    const numeric = [];
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
      let enclosing = '(top level)';
      fs.readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, index) => {
        const declaration = /^\s*(?:async\s+)?function\s+(\w+)\s*\(|^\s*(\w+)\s*:\s*function\s*\(/.exec(line);
        if (declaration) {
          enclosing = declaration[1] || declaration[2];
        }
        if (/\/\//.test(line.split('platformVer')[0] || '')) {
          return;
        }
        // platformVer or version compared without parseFloat(), or a version regex with a single digit
        if (/(?<!parseFloat\()\bplatformVer\s*(?:[<>]=?|===?|!==?)/.test(line) || /(?:[<>]=?|===?)\s*platformVer\b/.test(line) ||
            /Tizen\s*\[\d-\d\]/.test(line) || /platform\.version.*(?:match|test|exec)\(/.test(line)) {
          offenders.push(file + ':' + (index + 1) + ': ' + line.trim());
        }
        if (/parseFloat\((?:capabilities\.)?platformVer\)/.test(line)) {
          numeric.push(file + ' ' + enclosing);
        }
      });
    }
    assert.deepEqual(offenders, []);
    // The numeric checks by the function they are in. A new comparison of the platform version goes through parseFloat()
    // and adds its function here (2.3.1 added the Smart Hub service and the switch stored before a Tizen update)
    assert.deepEqual(numeric.sort(), ['index.js optimalSettingsDialog', 'index.js optimalSettingsDialog', 'index.js saveGameMode',
      'index.js saveGameMode', 'index.js smartHubServiceSkipReason', 'navigation.js clickElement', 'tv_profile.js getGameModeDefault',
      'tv_profile.js isGameModeFromBeforeTizen9', 'tv_profile.js legacyDefaults']);
  });
});

describe('model year and firmware strings of 2026 and later', () => {
  test('the model year hint reads the two digits of any year', () => {
    assert.equal(profile.getModelYearHint('26_PONTUSM'), 2026);
    assert.equal(profile.getModelYearHint('27_KANTSU2E'), 2027);
    assert.equal(profile.getModelYearHint('PONTUSM_26'), null, 'only the prefix counts');
    assert.equal(profile.getModelYearHint(null), null);
  });

  test('a 2026 model name or series matches no tested profile, while the S90C on Tizen 10 keeps its profile', () => {
    for (const [model, series] of [['QE65Q80HAT', '26_PONTUSM_QTV'], ['QE55S90HAT', '26_PONTUSM_OLED'], ['QE65S95HAE', '26_OSCARS_OLED'],
      ['UE55U8000HU', '26_KANTSU2E_UHD'], ['QN90H', '26_NIKEM2_QLED']]) {
      assert.equal(profile.findVerifiedProfile(model, series), null, model);
    }
    const s90c = detect({ tv: 's90c', tizen: '10.0' });
    assert.equal(s90c.profile.id, 'S90C');
    assert.deepEqual(CONNECTIONS.map((conn) => profile.deriveOptimalSettings(s90c, conn).bitrate), [75, 100, 80]);
    assert.equal(profile.deriveOptimalSettings(s90c, 'wifi').gameMode, false);
  });

  test('the firmware version is only shown, whatever its form', () => {
    for (const firmware of ['T-INFOLINK2026-1000', 'T-PTMDEUC-2600.1', 'T-NIKEM2AKUC-0000.0', '2600.1']) {
      const caps = detect(Object.assign({}, TV_2026, { tizen: '10.0', firmware }));
      assert.deepEqual(caps.firmware, { version: firmware, source: 'productinfo' });
      assert.equal(caps.modelYearHint, 2026);
    }
  });
});

describe('index.js loaded on a simulated Tizen 10 TV', () => {
  test('the globals and the ForceGM check', () => {
    const platform = loadPlatformScripts(INDEX_SCRIPTS, { tv: Object.assign({ tizen: '10.0' }, TV_2026) });
    assert.deepEqual(plain(platform.get('[platformVer, modelName, modelGroup, is4kPanel, isHdrCapable, tvCapabilities.modelYearHint]')),
      ['10.0', 'QE65Q80HAT', '26_PONTUSM', true, true, 2026]);
    assert.equal(platform.get('deriveOptimalSettings(tvCapabilities, "wifi").gameMode'), false);
    assert.equal(platform.get('checkForceGMVariant()'), false);
    const forceGM = loadPlatformScripts(INDEX_SCRIPTS, { tv: Object.assign({ tizen: '10.0', forceGM: true }, TV_2026) });
    assert.equal(forceGM.get('checkForceGMVariant()'), true);
  });

  test('an unreadable platform version falls back to the rules of an old TV (game mode on)', () => {
    // Documents the fallback: a Tizen 10 TV whose platform.version can't be read gets the default of Tizen 6 to 8
    const caps = detect(Object.assign({}, TV_2026, { tizen: '10.0', failApis: 'tizen.systeminfo.getCapability' }));
    assert.equal(caps.platformVer, null);
    assert.equal(profile.deriveOptimalSettings(caps, 'wifi').gameMode, true);
  });
});

describe('a game mode switch stored before an update of the TV to Tizen 9.0 or newer', () => {
  test('isGameModeFromBeforeTizen9(): on, now on Tizen 9.0 or newer, and stored below 9.0 or without a version', () => {
    const check = profile.isGameModeFromBeforeTizen9;
    // Stored on Tizen 6 to 8, or by a version of the app that stored no Tizen version (2.3.0 and earlier, the settings
    // snapshot of settings schema 1), or on a TV whose version couldn't be read
    for (const stored of ['6.0', '6.5', '7.0', '8.0', '5.5', null, undefined, '', 'Unknown']) {
      for (const now of ['9.0', '9', '10.0', '10', '10.5', '11.0', ' 10.0', 10]) {
        assert.equal(check(true, stored, now), true, JSON.stringify([stored, now]));
      }
    }
    // Turned on on Tizen 9.0 or newer, after the compatibility warning of the switch: no warning, also after 9 -> 10,
    // where a comparison of the text would see '10.0' below '9.0' and warn again at every start
    for (const stored of ['9.0', '9', '9.5', '10.0', '10', '11.0']) {
      for (const now of ['9.0', '10.0', '11.0']) {
        assert.equal(check(true, stored, now), false, JSON.stringify([stored, now]));
      }
    }
    // Below Tizen 9.0, or with a version that can't be read now, the mode is fine and nothing warns
    for (const now of ['5.5', '6.0', '8.0', null, '', 'Tizen 10.0']) {
      assert.equal(check(true, '8.0', now), false, JSON.stringify(now));
      assert.equal(check(true, null, now), false, JSON.stringify(now));
    }
    // A switch stored off, or not stored at all (a fresh install, whose default is off on Tizen 9.0 and newer)
    for (const gameMode of [false, null, undefined, 'true', 1]) {
      assert.equal(check(gameMode, '8.0', '10.0'), false, JSON.stringify(gameMode));
    }
  });

  test('index.js stores the Tizen version with every stored switch and checks it only for a switch stored on', () => {
    const index = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'platform', 'index.js'), 'utf8');
    // Every stored game mode goes through storeGameMode(), which stores the version as well, and removing the switch
    // removes the version with it
    assert.deepEqual(index.match(/storeData\('gameMode'[^)]*\)/g), ["storeData('gameMode', gameMode, null)"]);
    assert.match(index, /function storeGameMode\(gameMode\) \{\s+storeData\('gameMode', gameMode, null\);\s+storeData\(GAME_MODE_PLATFORM_VERSION_KEY, platformVer, null\);\s+\}/);
    assert.equal((index.match(/storeGameMode\((?:chosenGameMode|true|false)\)/g) || []).length, 3, 'the switch, and the optimal settings off and on');
    assert.match(index, /removeData\('gameMode', null\);\s+removeData\(GAME_MODE_PLATFORM_VERSION_KEY, null\);/);
    assert.equal(loadPlatformScripts(INDEX_SCRIPTS).get('GAME_MODE_PLATFORM_VERSION_KEY'), 'gameModePlatformVer');
    // The check runs only where the stored switch is loaded on
    const load = index.slice(index.indexOf("getData('gameMode', function(previousValue) {"), index.indexOf("Load stored refFrameInvalidation preferences."));
    assert.match(load, /\} else \{\s+document\.querySelector\('#gameModeBtn'\)\.MaterialSwitch\.on\(\);\s+\/\/[^\n]*\n\s+checkGameModeAfterTizenUpdate\(\);\s+\}/);
    assert.equal((load.match(/checkGameModeAfterTizenUpdate\(\)/g) || []).length, 1);
  });
});
