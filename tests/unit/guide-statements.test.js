'use strict';

// Checks statements of the documents that describe what the code does, against the code, so that a change of the rules
// fails here until the documents follow (the table of recommended bitrates has its own test, guide-bitrate-table.test.js):
// - the warnings that the TV classes of docs/GUIDE.md section 2 get above 60 FPS at 4K (resolutionFramerateWarningKey())
// - the game mode on Tizen 5.5 with a WASM player that offers the Ultra Low Latency mode, and the switch that stays
//   disabled on a TV whose WASM player doesn't offer it (getGameModeDefault())
// - the limit of the bitrate presets on TVs without a tested profile (presetBitrateLimit())
// - the controller type that System information shows when the setting overrides the detection
// - the Start of a hold that switches the mouse emulation on, which the game sees (wasm/gamepad.cpp)
// - the version suffix of a release promoted from a pre-release, and what the earlier release v1.19.0-s90c.1 offers
// - the audio path that the section on surround sound with a soundbar describes: the 5.1 entry of the audio
//   configuration, the 6-channel PCM track that only the EMSS backend adds, the two channels of the Web Audio output and
//   the Audio stream line that the check reads
// The release notes of a release (docs/RELEASE_NOTES_STABLE.md) only give the essentials, so the statements that they
// carried until 1.19.100 are checked in the guide and the patch notes (docs/PATCH_NOTES.md), where they are now.

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
  for (const file of ['docs/GUIDE.md', 'docs/RELEASE_NOTES_STABLE.md', 'docs/PATCH_NOTES.md', 'CHANGELOG.md', 'wasm/platform/tv_profile.js']) {
    assert.doesNotMatch(read(file), /highest (decoder )?level of Samsung TVs|Level 5\.2 on every Samsung TV/i, file);
  }
});

test('the guide gives the game mode of Tizen 5.5 with the exception for a WASM player that offers the mode', () => {
  assert.equal(profile.getGameModeDefault('5.5', 'yes'), false, 'off, but the switch can be turned on');
  assert.equal(profile.getGameModeDefault('5.5', 'unknown'), null, 'off and disabled');
  const gameModeItem = GUIDE.split('\n').find((line) => line.indexOf('- **Game mode:**') === 0);
  assert.match(gameModeItem, /On Tizen 5\.5 it is off and disabled, unless the video player of the TV says that it offers the Ultra Low Latency mode/);
  // The patch notes of 1.19.100: a disabled switch on every TV whose WASM player says that it lacks the mode
  for (const version of ['5.5', '6.0', '6.5', '7.0', '8.0', '9.0']) {
    assert.equal(profile.getGameModeDefault(version, 'no'), null, 'Tizen ' + version + ': off and disabled');
  }
  assert.equal(profile.isGameModeUnavailable({ wasmPlayer: { ultraLowLatency: 'no' } }), true);
  assert.match(read('docs/PATCH_NOTES.md'), /a disabled \*Game mode\* switch where the TV can't use it/);
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
  for (const file of ['README.md', 'docs/GUIDE.md', 'docs/PATCH_NOTES.md']) {
    assert.match(read(file), /announces (later )?is (a release of )?the regular Moonlight Tizen app/, file);
  }
  const archive = read('docs/profiles/S90C/RELEASE_NOTES_v1.19.0-s90c.1.md');
  assert.match(archive.split('\n').slice(0, 4).join('\n'), /\*\*Correction:\*\* the note under \*Hinweise\* that the update check/);
  // Tizen Studio always needs a Samsung account for the Samsung certificate, Apps2Samsung only on Tizen 7.0 and newer
  assert.match(GUIDE, /Apps2Samsung asks for a Samsung account on Tizen 7\.0 and newer\. Tizen Studio always needs one/);
});

test('the section on surround sound with a soundbar describes the audio path of the app as the code does', () => {
  const start = GUIDE.indexOf('### Surround sound with a soundbar');
  assert.ok(start > GUIDE.indexOf('## 11. Audio') && start < GUIDE.indexOf('## 12. '), 'a part of section 11');
  const section = GUIDE.slice(start, GUIDE.indexOf('## 12. '));
  // The entry of the audio configuration that the section names, and EMSS as the default backend
  const html = read('wasm/index.html');
  assert.match(html, /data-value="51Surround" data-i18n="5\.1 Surround Sound"/);
  assert.match(html, /id="selectAudioBackend"[^>]*data-value="EMSS"/);
  assert.match(read('wasm/platform/index.js'), /const defaultAudioBackend = 'EMSS';/);
  assert.match(section, /\*Audio configuration\*: \*5\.1 Surround Sound\*, and \*Audio backend\*: \*EMSS\* \(the default\)/);
  // Only the EMSS backend gives the media player of the TV an audio track: PCM with the 5.1 layout for 6 channels
  const player = read('wasm/wasmplayer.cpp');
  assert.match(player, /if \(g_Instance->m_AudioBackend == AudioBackend::Emss\) \{[\s\S]*?case 6:\s*channelLayout = samsung::wasm::ChannelLayout::k5_1;[\s\S]*?"audio\/webm; codecs=\\"pcm\\""/);
  assert.match(section, /With 5\.1, the app decodes it to 6-channel PCM for the media player of the TV/);
  // Web Audio plays every frame into the destination of the audio context and never raises its channel count from the
  // default of two, so the browser mixes 5.1 down to stereo
  const audio = read('wasm/platform/audio.js');
  assert.match(audio, /source\.connect\(_audContext\.destination\)/);
  assert.doesNotMatch(audio, /\.channelCount\s*=|channelCountMode|channelInterpretation/);
  assert.match(section, /Web Audio plays through the output of the browser, which the app leaves at two channels, so it mixes 5\.1 down to stereo/);
  // The Audio stream line names the layout as the check quotes it
  const stats = read('wasm/audio_stream_stats.hpp');
  assert.match(stats, /case 6:\s*return "5\.1 surround";/);
  assert.match(stats, /"%s \(%d channels\)", layoutName, channels/);
  assert.match(stats, /case 2:\s*return "Stereo";/);
  assert.match(section, /should say \*Opus 5\.1 surround \(6 channels\)\*\. If it says \*Stereo\*, the host only offers stereo\./);
  // Untested, as the guide marks it, with the sources it names
  assert.match(section, /Untested: nobody has confirmed discrete 5\.1 from the app on a TV yet/);
  assert.ok(section.indexOf('](https://www.samsung.com/sg/support/tv-audio-video/what-is-earc-and-how-to-set-on-samsung-smart-tv/)') > 0);
  assert.ok(section.indexOf('](https://github.com/fidoboy/moonlight-tizen-ac3/blob/master/docs/Troubleshooting-Guide.md)') > 0);
});
