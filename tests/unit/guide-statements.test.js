'use strict';

// Checks statements of the documents that describe what the code does, against the code, so that a change of the rules
// fails here until the documents follow (the table of recommended bitrates has its own test, guide-bitrate-table.test.js):
// - the warnings that the TV classes of docs/GUIDE.md get above 60 FPS at 4K (resolutionFramerateWarningKey())
// - the game mode on Tizen 5.5 with a WASM player that offers the Ultra Low Latency mode, and the switch that stays
//   disabled on a TV whose WASM player doesn't offer it (getGameModeDefault())
// - the bitrate presets, which give the recommended bitrate of every resolution and frame rate (presetBitrate())
// - the controller type that System information shows when the setting overrides the detection
// - the Start of a hold that switches the mouse emulation on, which the game sees (wasm/gamepad.cpp)
// - the version suffix of a release promoted from a pre-release, and what the earlier release v1.19.0-s90c.1 offers
// - the audio path that the section on surround sound with a soundbar describes: the 5.1 entry of the audio
//   configuration, the 6-channel PCM track that only the EMSS backend adds, the two channels of the Web Audio output and
//   the Audio stream line that the check reads
// The release notes of a release (docs/RELEASE_NOTES.md) only give the essentials, so the statements that they
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
  for (const file of ['docs/GUIDE.md', 'docs/RELEASE_NOTES.md', 'docs/PATCH_NOTES.md', 'CHANGELOG.md', 'wasm/platform/tv_profile.js']) {
    assert.doesNotMatch(read(file), /highest (decoder )?level of Samsung TVs|Level 5\.2 on every Samsung TV/i, file);
  }
});

test('the guide gives the game mode of Tizen 5.5 with the exception for a WASM player that offers the mode', () => {
  assert.equal(profile.getGameModeDefault('5.5', 'yes'), false, 'off, but the switch can be turned on');
  assert.equal(profile.getGameModeDefault('5.5', 'unknown'), null, 'off and disabled');
  // The setting is called Ultra low latency mode since 2.2.0 (the stored key is still gameMode)
  const gameModeItem = GUIDE.split('\n').find((line) => line.indexOf('- **Ultra low latency mode:**') === 0);
  assert.match(gameModeItem, /On Tizen 5\.5 it is off and disabled, unless the video player of the TV says that it offers the Ultra Low Latency mode/);
  // The patch notes of 1.19.100: a disabled switch on every TV whose WASM player says that it lacks the mode
  for (const version of ['5.5', '6.0', '6.5', '7.0', '8.0', '9.0']) {
    assert.equal(profile.getGameModeDefault(version, 'no'), null, 'Tizen ' + version + ': off and disabled');
  }
  assert.equal(profile.isGameModeUnavailable({ wasmPlayer: { ultraLowLatency: 'no' } }), true);
  assert.match(read('docs/PATCH_NOTES.md'), /a disabled \*Game mode\* switch where the TV can't use it/);
});

test('the guide names the bitrates of the presets at other resolutions and frame rates as the code gives them', () => {
  const uhd = capsOf({ tv: 'uhd' });
  const s90c = capsOf({ tv: 's90c' });
  assert.equal(profile.presetBitrate('2560:1440', 60, 'wifi', uhd), 50);
  assert.match(GUIDE, /every other resolution and frame rate gets its bitrate by the same rules, e\.g\. 50 Mbps for 2560 x 1440 at 60 FPS over Wi-Fi\./);
  for (const fps of [90, 120, 144]) {
    assert.equal(profile.presetBitrate('3840:2160', fps, 'wifi', s90c), 100, 'S90C at 4K and ' + fps + ' FPS');
  }
  assert.equal(profile.getDecoderCapMbps(s90c), 100);
  assert.match(GUIDE, /On the tested S90C over Wi-Fi, 4K at 90, 120 or 144 FPS gets 100 Mbps, its decoder cap;/);
  // The presets are the bitrates that the optimal settings button applies for the same resolution and frame rate
  for (const conn of ['ethernet', 'wifi', 'unknown']) {
    const optimal = profile.deriveOptimalSettings(s90c, conn);
    assert.equal(profile.presetBitrate(optimal.resolution, optimal.frameRate, conn, s90c), optimal.bitrate, conn);
  }
  assert.match(GUIDE, /Once you move the bitrate slider yourself \(or change the bitrate in the Stream Menu\), the app keeps your bitrate/);
});

test('the documents describe the controller type of System information and the Start of the mouse emulation as the code does', () => {
  const locale = JSON.parse(read('wasm/static/locales/en-US.json'));
  assert.ok(Object.prototype.hasOwnProperty.call(locale, '%1$s (setting, detected: %2$s)'));
  assert.ok(Object.prototype.hasOwnProperty.call(locale, 'Controller %1$s: %2$s (%3$s, %4$s buttons, %5$s axes, rumble: %6$s, type: %7$s)'));
  assert.ok(tableRow('Controller N')[1].indexOf('*PlayStation (setting, detected: Xbox)*') >= 0);
  const controllers = read('docs/CONTROLLERS.md');
  assert.match(controllers, /System information shows the type sent to the PC for each controller\. When the setting overrides the detection, it names the detected type as well/);
  assert.doesNotMatch(controllers, /System information shows the type that Auto detects/);
  // Only the hold that switches the mouse emulation off keeps Start from the game (mouseEmulationHold[].toggled in
  // wasm/gamepad.cpp); the hold that switches it on sends Start until the switch
  assert.match(read('wasm/gamepad.cpp'), /mouseEmulationHold\[gamepadID\]\.toggled/);
  assert.match(controllers, /When a hold switches mouse emulation off, the game doesn't get that Start\. When a hold switches it on, the game sees Start held until the switch/);
  assert.doesNotMatch(controllers, /The game doesn't get the Start of the hold that switched it\./);
});

test('the documents explain the version of a promoted release and what the earlier release v1.19.0-s90c.1 offers', () => {
  assert.match(tableRow('App Version')[1], /a full release that was promoted from a tested pre-release, because it keeps the files of the pre-release/);
  for (const file of ['README.md', 'docs/GUIDE.md', 'docs/PATCH_NOTES.md']) {
    assert.match(read(file), /announces (later )?is (a release of )?the regular Moonlight Tizen app/, file);
  }
  // The German notes of v1.19.0-s90c.1 stay at its tag, whose note on the update check the guide corrects: that release
  // will never offer Moonlight Plus
  assert.match(GUIDE, /The earlier release v1\.19\.0-s90c\.1 \(\*Moonlight S90C\* on the TV\) checks the releases of upstream Moonlight Tizen, so it will never offer Moonlight Plus/);
  // Tizen Studio always needs a Samsung account for the Samsung certificate, Apps2Samsung only on Tizen 7.0 and newer
  assert.match(GUIDE, /Apps2Samsung asks for a Samsung account on Tizen 7\.0 and newer\. Tizen Studio always needs one/);
});

test('the section on surround sound with a soundbar describes the audio path of the app as the code does', () => {
  const start = GUIDE.indexOf('### Surround sound with a soundbar');
  const audioSection = GUIDE.indexOf('\n## Audio\n');
  const nextSection = GUIDE.indexOf('\n## ', audioSection + 1);
  assert.ok(audioSection > 0 && start > audioSection && start < nextSection, 'a part of the section Audio');
  const section = GUIDE.slice(start, nextSection);
  // The entry of the audio configuration that the section names, and EMSS as the default backend
  const html = read('wasm/index.html');
  assert.match(html, /data-value="51Surround" data-i18n="5\.1 Surround Sound"/);
  assert.match(html, /id="selectAudioBackend"[^>]*data-value="EMSS" data-i18n="TV media player \(EMSS\)"/);
  assert.match(read('wasm/platform/index.js'), /const defaultAudioBackend = 'EMSS';/);
  assert.match(section, /\*Audio configuration\*: \*5\.1 Surround Sound\*, and \*Audio backend\*: \*TV media player \(EMSS\)\* \(the default\)/);
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

// The headings of level 2 of a Markdown document, without the contents list
const level2Headings = (text) => text.split('\n').filter((line) => /^## /.test(line)).map((line) => line.slice(3).trim()).filter((heading) => heading !== 'Contents');

test('the guide and the controller page have headings without numbers, in the order of use, each in the contents list', () => {
  // Numbers in the headings changed every link to a heading whenever a section was added or moved
  assert.deepEqual(level2Headings(GUIDE), ['Requirements', 'Installation', 'The screens of the app', 'Optimal settings for this TV',
    'Stream Menu and app menu', 'Finding your bitrate', 'Host settings (Sunshine)', 'ForceGM variant and game mode', 'HDR', 'Audio',
    'Performance statistics', 'System information and diagnostic log', 'When Moonlight goes to the background', 'Known limits',
    'Troubleshooting']);
  for (const file of ['docs/GUIDE.md', 'docs/CONTROLLERS.md']) {
    const text = read(file);
    text.split('\n').filter((line) => /^#{2,4} /.test(line)).forEach((line) => {
      assert.doesNotMatch(line, /^#+ \d+\.?\s/, file + ': ' + line);
    });
    // The contents list links each section in its order (the guide adds some subsections on the same line)
    const contents = text.slice(text.indexOf('## Contents'), text.indexOf('\n## ', text.indexOf('## Contents') + 1));
    const listed = contents.split('\n').filter((line) => /^- \[/.test(line)).map((line) => /^- \[([^\]]+)\]/.exec(line)[1]);
    assert.deepEqual(listed, level2Headings(text), file);
  }
});

test('the sections of the guide that the app names by their heading exist', () => {
  // e.g. "see <b>ForceGM variant and game mode</b> in the guide of Moonlight Plus" (wasm/platform/index.js)
  const named = [];
  for (const file of ['wasm/platform/index.js', 'wasm/index.html']) {
    const pattern = /<b>([^<]+)<\/b> in the guide/g;
    let match;
    while ((match = pattern.exec(read(file))) !== null) {
      named.push(match[1]);
    }
  }
  assert.ok(named.indexOf('ForceGM variant and game mode') >= 0, named.join(', '));
  const headings = GUIDE.split('\n').filter((line) => /^#{2,4} /.test(line)).map((line) => line.replace(/^#+ /, '').trim());
  named.forEach((name) => assert.ok(headings.indexOf(name) >= 0, 'the guide has the heading ' + name));
});

test('the guide gives the tested bitrate steps of the S90C itself and links the documents of v1.19.0-s90c.1 at their tag', () => {
  const bitrate = GUIDE.slice(GUIDE.indexOf('\n## Finding your bitrate\n'), GUIDE.indexOf('\n## ', GUIDE.indexOf('\n## Finding your bitrate\n') + 1));
  assert.match(bitrate, /\*\*Samsung S90C over Wi-Fi:\*\* starts at its cap of 100 Mbps\. The tuning plan of this model tests 100 → 120 → 135 → 150 Mbps/);
  // The archive of the German documents left the branch; the tag keeps them
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'docs', 'profiles')));
  const tagLink = 'https://github.com/Emperior90/moonlight-tizen-Plus/tree/v1.19.0-s90c.1/docs';
  for (const file of ['docs/GUIDE.md', 'README.md', 'docs/PATCH_NOTES.md']) {
    assert.ok(read(file).indexOf('](' + tagLink + ')') >= 0, file + ' links the tag v1.19.0-s90c.1');
  }
});
