'use strict';

// Checks statements of the documents that describe what the code does, against the code, so that a change of the rules
// fails here until the documents follow (the table of recommended bitrates has its own test, guide-bitrate-table.test.js):
// - the warnings that the TV classes of docs/GUIDE.md section 2 get above 60 FPS at 4K (resolutionFramerateWarningKey())
// - the game mode on Tizen 5.5 with a WASM player that offers the Ultra Low Latency mode (getGameModeDefault())
// - the limit of the bitrate presets on TVs without a tested profile (presetBitrateLimit())
// - the controller type that System information shows when the setting overrides the detection
// - the Start of a hold that switches the mouse emulation on, which the game sees (wasm/gamepad.cpp)
// - the version suffix of a release promoted from a pre-release, and what the earlier release v1.19.0-s90c.1 offers

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const tvMock = require('../browser/mocks/tv-mock');
const profile = require('../../wasm/platform/tv_profile');

const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
const GUIDE = read('docs/GUIDE.md');

// The capabilities of a simulated TV (see tests/browser/mocks/tv-mock.js)
function capsOf(tvOptions) {
  const apis = tvMock.createTizenApis(tvMock.parseConfig('', tvOptions), (callback) => callback());
  return profile.detectTvCapabilities({ tizen: apis.tizen, webapis: apis.webapis });
}

// The row of a table of the guide whose first cell is the given text, as its cells
function tableRow(firstCell) {
  const line = GUIDE.split('\n').find((entry) => entry.indexOf('| ' + firstCell + ' |') === 0);
  assert.ok(line, 'row ' + firstCell);
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

// What each warning key of the resolution and frame rate is called in the guide
const WARNING_WORDS = {
  [profile.VIDEO_WARNINGS.NEEDS_LEVEL_52]: '90 and 120 FPS need a Level 5.2 decoder',
  [profile.VIDEO_WARNINGS.FPS_ABOVE_60_HZ]: 'many Samsung TVs have 60 Hz panels',
};

test('the TV classes of the guide name the warnings that 4K above 60 FPS gets on them', () => {
  const uhd = capsOf({ tv: 'uhd' });
  const uhd8k = capsOf({ tv: '8k' });
  // A 4K TV without a tested profile, whatever its panel: the level 5.2 warning at 4K, the 60 Hz panel warning below
  for (const fps of [90, 120]) {
    assert.equal(profile.resolutionFramerateWarningKey('3840:2160', fps, uhd), profile.VIDEO_WARNINGS.NEEDS_LEVEL_52);
    assert.equal(profile.resolutionFramerateWarningKey('2560:1440', fps, uhd), profile.VIDEO_WARNINGS.FPS_ABOVE_60_HZ);
  }
  const row60Hz = tableRow('4K, 60 Hz panel')[1];
  assert.ok(row60Hz.indexOf(WARNING_WORDS[profile.VIDEO_WARNINGS.NEEDS_LEVEL_52]) >= 0, row60Hz);
  assert.ok(row60Hz.indexOf('144 FPS exceeds Level 5.2') >= 0, row60Hz);
  assert.match(row60Hz, /60 Hz panels appears at lower resolutions above 60 FPS/);
  // An 8K TV: the 60 Hz panel warning at 4K at 90 and 120 FPS, and still the warning above level 5.2 at 144 FPS
  for (const fps of [90, 120]) {
    assert.equal(profile.resolutionFramerateWarningKey('3840:2160', fps, uhd8k), profile.VIDEO_WARNINGS.FPS_ABOVE_60_HZ);
  }
  assert.equal(profile.resolutionFramerateWarningKey('3840:2160', 144, uhd8k), profile.VIDEO_WARNINGS.EXCEEDS_LEVEL_52);
  const row8k = tableRow('8K')[1];
  assert.match(row8k, /4K at 90 or 120 FPS gets the warning that many Samsung TVs have 60 Hz panels instead of the Level 5.2 warning/);
  assert.match(row8k, /4K at 144 FPS still gets the warning that it exceeds Level 5.2/);
  // No document calls level 5.2 the highest level of all Samsung TVs any more
  for (const file of ['docs/GUIDE.md', 'docs/RELEASE_NOTES_STABLE.md', 'CHANGELOG.md', 'wasm/platform/tv_profile.js']) {
    assert.doesNotMatch(read(file), /highest (decoder )?level of Samsung TVs|Level 5\.2 on every Samsung TV/i, file);
  }
});

test('the guide gives the game mode of Tizen 5.5 with the exception for a WASM player that offers the mode', () => {
  assert.equal(profile.getGameModeDefault('5.5', 'yes'), false, 'off, but the switch can be turned on');
  assert.equal(profile.getGameModeDefault('5.5', 'unknown'), null, 'off and disabled');
  const gameModeItem = GUIDE.split('\n').find((line) => line.indexOf('- **Game mode:**') === 0);
  assert.match(gameModeItem, /On Tizen 5\.5 it is off and disabled, unless the video player of the TV says that it offers the Ultra Low Latency mode/);
  assert.match(read('docs/RELEASE_NOTES_STABLE.md'), /off and disabled on 5\.5 unless the video player of the TV offers the Ultra Low Latency mode/);
});

test('the guide names the limit of the bitrate presets on TVs without a tested profile', () => {
  assert.deepEqual(profile.presetBitrateLimit('unknown', capsOf({ tv: 'uhd' })), { mbps: profile.UNKNOWN_CONNECTION_MAX_BITRATE, reason: 'recommended' });
  assert.match(GUIDE, /On a TV without a tested profile they are also limited to the highest bitrate that the app recommends for it, which is the decoder cap of the TV class, or 80 Mbps when the connection isn't detected\./);
  assert.equal(profile.UNKNOWN_CONNECTION_MAX_BITRATE, 80);
});

test('the documents describe the controller type of System information and the Start of the mouse emulation as the code does', () => {
  const locale = JSON.parse(read('wasm/static/locales/en-US.json'));
  assert.ok(Object.prototype.hasOwnProperty.call(locale, '%1$s (setting, detected: %2$s)'));
  assert.ok(tableRow('Gamepad N')[1].indexOf('*PlayStation (setting, detected: Xbox)*') >= 0);
  const controllers = read('docs/CONTROLLERS.md');
  assert.match(controllers, /System information shows the type sent to the PC for each controller\. When the setting overrides the detection, it names the detected type as well/);
  assert.doesNotMatch(controllers, /System information shows the type that Auto detects/);
  // Only the hold that switches the mouse emulation off keeps Start from the game (mouseEmulationHold[].toggled in
  // wasm/gamepad.cpp); the hold that switches it on sends Start until the switch
  assert.match(read('wasm/gamepad.cpp'), /mouseEmulationHold\[gamepadID\]\.toggled/);
  assert.match(controllers, /When a hold switches mouse mode off, the game doesn't get that Start\. When a hold switches it on, the game sees Start held until the switch/);
  assert.doesNotMatch(controllers, /The game doesn't get the Start of the hold that switched it\./);
});

test('the documents explain the version of a promoted release and what the earlier release v1.19.0-s90c.1 offers', () => {
  assert.match(tableRow('App Version')[1], /a full release that was promoted from a tested pre-release, because it keeps the files of the pre-release/);
  assert.match(read('docs/RELEASE_NOTES_STABLE.md'), /A release promoted from a tested pre-release keeps its files, so System information shows its version with the commit of the pre-release/);
  for (const file of ['README.md', 'docs/GUIDE.md', 'docs/RELEASE_NOTES_STABLE.md']) {
    assert.match(read(file), /announces (later )?is (a release of )?the regular Moonlight Tizen app/, file);
  }
  const archive = read('docs/profiles/S90C/RELEASE_NOTES_v1.19.0-s90c.1.md');
  assert.match(archive.split('\n').slice(0, 4).join('\n'), /\*\*Correction:\*\* the note under \*Hinweise\* that the update check/);
  // Tizen Studio always needs a Samsung account for the Samsung certificate, Apps2Samsung only on Tizen 7.0 and newer
  assert.match(GUIDE, /Apps2Samsung asks for a Samsung account on Tizen 7\.0 and newer\. Tizen Studio always needs one/);
});
