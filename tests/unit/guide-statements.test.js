'use strict';

// Checks statements of the documents that describe what the code does, against the code, so that a change of the rules
// fails here until the documents follow (the table of recommended bitrates has its own test, guide-bitrate-table.test.js):
// - the warnings that the TV classes of docs/GUIDE.md get above 60 FPS at 4K (resolutionFramerateWarningKey())
// - 120 FPS as the highest frame rate since 2.2.1 removed 144 FPS, and what becomes of a stored 144 FPS
//   (offeredFrameRates(), frameRateReplacements())
// - the game mode on Tizen 5.5 with a WASM player that offers the Ultra Low Latency mode, and the switch that stays
//   disabled on a TV whose WASM player doesn't offer it (getGameModeDefault())
// - the bitrate presets, which give the recommended bitrate of every resolution and frame rate (presetBitrate())
// - the end of the bitrate slider and of the bitrate entry of the Stream Menu (MAX_BITRATE_MBPS), and what a bitrate
//   above 150 Mbps needs
// - the controller type that System information shows when the setting overrides the detection
// - the Start of a hold that switches the mouse emulation on, which the game sees (wasm/gamepad.cpp)
// - the buttons in the menus of docs/CONTROLLERS.md that the navigation guide of wasm/index.html leaves out
// - the version suffix of a release promoted from a pre-release, and that the README and the guide no longer carry the
//   install notes of the earlier release v1.19.0-s90c.1 (Moonlight S90C), which only the history of the patch notes keeps,
//   and that no current document links its German documents at its tag any more (since 2.3.1)
// - the audio path that the section on surround sound with a soundbar describes: the 5.1 entry of the audio
//   configuration, the 6-channel PCM track that only the EMSS backend adds, the two channels of the Web Audio output and
//   the Audio stream line that the check reads
// - the surround audio quality: High as the default, the row only for 5.1 and 7.1, the 15 Mbps from which the host
//   sends its high quality, the 10 ms packets of Efficient, stereo that it never touches, and the Audio CPU line
// - what the host does with the stream: the share of the bitrate that Sunshine leaves to the encoder at a given FEC,
//   which caps the received bitrate of the statistics, the parity packets that Moonlight asks for, the display device
//   configuration of Sunshine that is off by default and follows the Video HDR switch that every start sends, the
//   reconnects of the app that speak against reverting it at every disconnect, the virtual display of Apollo that the
//   app never asks for, the 4:2:0 formats that are the only ones the app asks for, the HDR static metadata that only
//   goes into HEVC and AV1, and the switch that keeps the sound off the speakers of the host
// - the latency modes of the Ultra low latency switch and the Game Mode that only the ForceGM variant asks for, which
//   the TV picture settings and the fallback for a corrupted picture above 1080p build on
// - Tizen 10 in the README and the guide, which follows the rules of Tizen 9.0 and newer, with what is known about it
//   (simulated only, one report of the upstream app on an S85H, untested with Moonlight Plus), and the check of the
//   switch after an update of Tizen with the one-time warning of 2.3.1
// - the wait after an abandoned start (the 11 seconds, the countdown and the starts that the app remembers), the start
//   once more and the message after a start that the PC dropped, and the log line of a restart of the encoder of the PC,
//   whose keyframe the statistics leave out
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

// The text of a section of the guide, from its heading (e.g. '### Error correction (FEC)') to the next heading of the
// same or a higher level
function guideSection(heading) {
  const level = /^#+/.exec(heading)[0].length;
  const start = GUIDE.indexOf('\n' + heading + '\n');
  assert.ok(start >= 0, 'the guide has the heading ' + heading);
  const rest = GUIDE.slice(start + heading.length + 2);
  const next = rest.search(new RegExp('^#{1,' + level + '} ', 'm'));
  return next < 0 ? rest : rest.slice(0, next);
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
  assert.match(row60Hz, /60 Hz panels appears at lower resolutions above 60 FPS/);
  // An 8K TV: the 60 Hz panel warning at 4K at 90 and 120 FPS
  for (const fps of [90, 120]) {
    assert.equal(profile.resolutionFramerateWarningKey('3840:2160', fps, uhd8k), profile.VIDEO_WARNINGS.FPS_ABOVE_60_HZ);
  }
  const row8k = tableRow('8K')[1];
  assert.match(row8k, /4K at 90 or 120 FPS gets the warning that many Samsung TVs have 60 Hz panels instead of the Level 5.2 warning/);
  // No frame rate of the menu exceeds level 5.2 since 144 FPS is gone, so the TV classes don't name that warning
  for (const caps of [uhd, uhd8k, capsOf({ tv: 's90c' })]) {
    for (const fps of profile.offeredFrameRates(true)) {
      const key = profile.resolutionFramerateWarningKey('3840:2160', fps, caps);
      assert.ok(key !== profile.VIDEO_WARNINGS.EXCEEDS_LEVEL_52 && key !== profile.VIDEO_WARNINGS.EXCEEDS_TESTED_DECODER, String(fps));
    }
  }
  for (const name of ['4K, 60 Hz panel', '4K, 120 Hz panel', '8K']) {
    assert.doesNotMatch(tableRow(name)[1], /144 FPS|exceeds Level 5\.2/, name);
  }
  // No document calls level 5.2 the highest level of all Samsung TVs any more
  for (const file of ['docs/GUIDE.md', 'docs/RELEASE_NOTES.md', 'docs/PATCH_NOTES.md', 'CHANGELOG.md', 'wasm/platform/tv_profile.js']) {
    assert.doesNotMatch(read(file), /highest (decoder )?level of Samsung TVs|Level 5\.2 on every Samsung TV/i, file);
  }
});

test('the guide names 120 FPS as the highest frame rate, and what becomes of a 144 FPS of an earlier version', () => {
  const unlocked = profile.offeredFrameRates(true);
  assert.equal(unlocked[unlocked.length - 1], 120);
  const item = GUIDE.split('\n').find((line) => line.indexOf('- **Highest frame rate:**') === 0);
  assert.ok(item, 'the item of the known limits');
  assert.match(item, /^- \*\*Highest frame rate:\*\* 120 FPS\. Version 2\.2\.1 removed 144 FPS, because the video player of Samsung TVs doesn't start a stream at 144 FPS/);
  const s90c = capsOf({ tv: 's90c' });
  assert.equal(profile.frameRateReplacements({ frameRate: 144, unlockAllFps: true }, s90c, 'wifi').frameRate, 120);
  assert.equal(profile.frameRateReplacements({ frameRate: 144, unlockAllFps: false }, s90c, 'wifi').frameRate, 60);
  assert.match(item, /A 144 FPS set in an earlier version becomes 120 FPS, or 60 FPS while \*Unlock all frame rates\* is off\.$/);
  // No other statement of the guide offers 144 FPS
  assert.deepEqual(GUIDE.split('\n').filter((line) => /\b144 FPS/.test(line)), [item]);
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
  for (const fps of [90, 120]) {
    assert.equal(profile.presetBitrate('3840:2160', fps, 'wifi', s90c), 100, 'S90C at 4K and ' + fps + ' FPS');
  }
  assert.equal(profile.getDecoderCapMbps(s90c), 100);
  assert.equal(profile.getBitrateWarningMbps(s90c), 150);
  // The app names 150 Mbps as the recommendation for the decoder of the S90C in its warning, so the guide calls the
  // 100 Mbps the highest bitrate of the presets, not a decoder cap
  assert.match(GUIDE, /On the tested S90C over Wi-Fi, 4K at 90 or 120 FPS gets 100 Mbps, the highest bitrate its presets give \(the warning starts above 150 Mbps\);/);
  assert.doesNotMatch(GUIDE, /gets 100 Mbps, its decoder cap/);
  // The presets are the bitrates that the optimal settings button applies for the same resolution and frame rate
  for (const conn of ['ethernet', 'wifi', 'unknown']) {
    const optimal = profile.deriveOptimalSettings(s90c, conn);
    assert.equal(profile.presetBitrate(optimal.resolution, optimal.frameRate, conn, s90c), optimal.bitrate, conn);
  }
  assert.match(GUIDE, /Once you move the bitrate slider yourself \(or change the bitrate in the Stream Menu\), the app keeps your bitrate/);
});

test('the guide says what the optimal settings button resets and where its dialog opens, as the app does', () => {
  // The notice about a kept bitrate (applyBitratePresets() in index.js) and the guide both say that the button also
  // resets the codec and the other video settings
  const locale = JSON.parse(read('wasm/static/locales/en-US.json'));
  assert.ok(Object.keys(locale).some((key) => key.indexOf('Keeping your bitrate of %1$s Mbps') === 0 &&
    key.indexOf('but it also resets the codec and the other video settings.') > 0));
  assert.match(GUIDE, /The button lets the bitrate follow again, but it also resets the codec and the other video settings \(e\.g\. AV1 goes back to HEVC\)/);
  // The dialog opens on Cancel like the dialogs that confirm an action that can't be undone (pushConfirmationView())
  assert.match(read('wasm/platform/index.js'), /pushConfirmationView\(Views\.WarningDialog\);/);
  assert.match(GUIDE, /The dialog opens on \*Cancel\*, so that pressing OK twice on the button doesn't replace your settings/);
});

test('the guide names the end of the slider and of the Stream Menu, and what a bitrate above 150 Mbps needs', () => {
  const menus = read('wasm/platform/menus.js');
  assert.match(menus, /return \{ min: STREAM_MENU_BITRATE_STEP, max: MAX_BITRATE_MBPS \};/);
  assert.equal(profile.MAX_BITRATE_MBPS, 250);
  const row = tableRow('Bitrate');
  assert.match(row[1], /change it in 5 Mbps steps, from 5 Mbps up to 250 Mbps like the slider\. Above the warning threshold of the TV \(150 Mbps on the tested S90C profile, 80 Mbps on other 4K and 8K TVs, 50 Mbps on Full HD TVs\), OK shows the same warning as the slider\./);
  assert.equal(profile.getBitrateWarningMbps(capsOf({ tv: 's90c' })), 150);
  assert.equal(profile.getBitrateWarningMbps(capsOf({ tv: 'uhd' })), 80);
  assert.equal(profile.getBitrateWarningMbps(capsOf({ tv: 'fhd' })), 50);
  const above = GUIDE.slice(GUIDE.indexOf('\n### Above 150 Mbps\n'), GUIDE.indexOf('\n## ', GUIDE.indexOf('\n### Above 150 Mbps\n')));
  assert.ok(above.length > 0, 'the guide has the section Above 150 Mbps');
  assert.match(above, /The slider and the Stream Menu go up to 250 Mbps/);
  assert.match(above, /Only a strong 5 GHz or 6 GHz Wi-Fi link close to the router carries that much; the Ethernet port of the TV has 100 Mbps\./);
  assert.match(above, /If `max_bitrate` of Sunshine is set, it must allow the bitrate with AMD, Intel and software encoding and on Linux; Sunshine's NVENC encoder on Windows ignores it/);
  assert.match(above, /The bitrate warning of the TV stays \(above 150 Mbps on the S90C\)/);
  assert.doesNotMatch(GUIDE, /goes up to 150 Mbps|up to the decoder cap of the TV \(100 Mbps|Above the decoder cap of the TV \(100 Mbps/);
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

test('the documents explain the version of a promoted release, and only the history mentions the earlier build Moonlight S90C', () => {
  assert.match(tableRow('App Version')[1], /a full release that was promoted from a tested pre-release, because it keeps the files of the pre-release/);
  // The old S90C build (v1.19.0-s90c.1) has served its purpose: the README and the guide no longer explain how to update
  // from it, and only the history of the patch notes still says what it announces
  assert.match(read('docs/PATCH_NOTES.md'), /announces (later )?is (a release of )?the regular Moonlight Tizen app/);
  for (const file of ['README.md', 'docs/GUIDE.md']) {
    const text = read(file);
    assert.doesNotMatch(text, /announces (later )?is (a release of )?the regular Moonlight Tizen app/, file);
    assert.doesNotMatch(text, /Moonlight S90C/, file);
    assert.doesNotMatch(text, /The earlier release v1\.19\.0-s90c\.1/, file);
  }
  // Its German documents are no longer linked at their tag (see the test of the tested bitrate steps below)
  assert.equal(GUIDE.indexOf('stays with the files of the tag [v1.19.0-s90c.1]('), -1);
  assert.match(GUIDE, /The only tested model so far is the Samsung S90C \(55-inch OLED, 2023, Tizen 9\.0\)\.\n/);
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

test('the section on the surround audio quality describes the setting, the negotiation and the statistics as the code does', () => {
  const section = guideSection('### Surround audio quality');
  const audioSection = GUIDE.indexOf('\n## Audio\n');
  assert.ok(audioSection > 0 && GUIDE.indexOf('\n### Surround audio quality\n') > audioSection, 'a part of the section Audio');
  // The setting: Efficient by default (since 2.3.1; 2.3.0 had High), shown only with 5.1 and 7.1
  const index = read('wasm/platform/index.js');
  assert.match(index, /return loadedSurroundQuality\(\$\('#selectSurroundQuality'\)\.data\('value'\)\);/);
  assert.match(read('wasm/platform/tv_profile.js'), /^const DEFAULT_SURROUND_QUALITY = 'Efficient';$/m);
  assert.match(index, /return audioConfig === '51Surround' \|\| audioConfig === '71Surround';/);
  assert.match(read('wasm/index.html'), /id="selectSurroundQuality" class="mdl-button mdl-js-button" data-value="Efficient"/);
  assert.match(section, /Settings → Audio Settings → \*Surround audio quality\*, shown only with 5\.1 or 7\.1:/);
  assert.match(section, /\*\*Efficient\*\* \(default\)/);
  assert.doesNotMatch(section, /\*\*High\*\* \(default\)/);
  // The negotiation of moonlight-common-c: high quality surround from 15 Mbps on in 5 ms packets, unless the decoder is
  // declared slow, which gives 10 ms packets; the app declares it only for more than 2 channels
  const threshold = Number(/#define HIGH_AUDIO_BITRATE_THRESHOLD (\d+)/.exec(read('moonlight-common-c/src/Limelight-internal.h'))[1]);
  assert.equal(threshold, 15000);
  assert.match(section, /from a video bitrate of 15 Mbps on, the host sends its high quality surround in 5 ms packets/);
  const sdp = read('moonlight-common-c/src/SdpGenerator.c');
  assert.match(sdp, /\(AudioCallbacks\.capabilities & CAPABILITY_SLOW_OPUS_DECODER\) == 0\) \{\s+\/\/ Enable high quality mode for surround sound/);
  assert.match(sdp, /if \(\(AudioCallbacks\.capabilities & CAPABILITY_SLOW_OPUS_DECODER\) \|\|[\s\S]{0,400}AudioPacketDuration = 10;/);
  assert.match(section, /\*\*Efficient\*\* \(default\) asks for the normal quality in 10 ms packets at every bitrate/);
  assert.match(read('wasm/audio_capabilities.hpp'), /CHANNEL_COUNT_FROM_AUDIO_CONFIGURATION\(audioConfiguration\) > 2/);
  assert.match(section, /Stereo is never affected: the app asks for the same stereo as at \*High\*\./);
  // The statistics it points to: the Audio stream line with its packet duration, and the Audio CPU line
  const stats = read('wasm/audio_stream_stats.hpp');
  assert.match(stats, /"Audio stream: Opus %s, %g ms packets, %s\\n"/);
  assert.match(stats, /"Audio CPU: decode %\.2f ms\/s \(max %\.2f ms\), output %\.2f ms\/s \(max %\.2f ms\)\\n"/);
  assert.match(section, /\*5 ms packets\* and about 1536 kbps for 5\.1 at \*High\*, \*10 ms packets\* and about 256 kbps at \*Efficient\*/);
  assert.match(section, /10 ms\/s is 1 % of one CPU core\./);
  // 7.1 links the statement of the soundbar section instead of repeating it
  assert.match(section, /7\.1 brings nothing on a Samsung TV \(see \[what the connection carries\]\(#surround-sound-with-a-soundbar\)\)/);
  assert.match(guideSection('### Surround sound with a soundbar'), /7\.1 PCM is not supported\./);
});

// The headings of level 2 of a Markdown document, without the contents list
const level2Headings = (text) => text.split('\n').filter((line) => /^## /.test(line)).map((line) => line.slice(3).trim()).filter((heading) => heading !== 'Contents');

test('the guide and the controller page have headings without numbers, in the order of use, each in the contents list', () => {
  // Numbers in the headings changed every link to a heading whenever a section was added or moved
  assert.deepEqual(level2Headings(GUIDE), ['Requirements', 'Installation', 'The screens of the app', 'Optimal settings for this TV',
    'Stream Menu and app menu', 'Finding your bitrate', 'Host settings (Sunshine)', 'ForceGM variant and game mode',
    'TV picture settings', 'HDR', 'Audio', 'Performance statistics', 'System information and diagnostic log',
    'When Moonlight goes to the background', 'Known limits', 'Troubleshooting']);
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

test('the README and the guide count Tizen 10 as Tizen 9.0 or newer, as strong as the evidence, and say to check the switch after an update', () => {
  // The rules of Tizen 9.0 and newer compare the version as a number, so 10.0 follows them (unit/tizen10.test.js)
  assert.equal(profile.getGameModeDefault('10.0', 'unknown'), false);
  assert.equal(profile.isGameModeFromBeforeTizen9(true, '8.0', '10.0'), true);
  assert.equal(profile.isGameModeFromBeforeTizen9(true, '9.0', '10.0'), false);
  const readme = read('README.md');
  for (const [file, text] of [['README.md', readme], ['docs/GUIDE.md', GUIDE]]) {
    assert.ok(text.indexOf('| Tizen 9.0 or newer, including Tizen 10 (models of 2026) | `Moonlight-ForceGM.wgt` |') >= 0, file + ': the table of the files');
    // What is known: the simulation, one report of the upstream app on an S85H that needed its ForceGM variant, and no
    // test of Moonlight Plus on such a TV
    assert.match(text, /in simulated tests the app behaves (on Tizen 10 )?the same as on Tizen 9/i, file);
    assert.match(text, /One owner of an S85H with Tizen 10 reported to (the upstream )?Moonlight Tizen( project)? that with its regular file the stream ended without a picture, and that its ForceGM variant helped \(\[issue 126[^\]]*\]\(https:\/\/github\.com\/brightcraft\/moonlight-tizen\/issues\/126\)\)/, file);
    assert.match(text, /Moonlight Plus (itself )?has not been tested on a Tizen 10 TV yet/, file);
    assert.doesNotMatch(text, /tested on Tizen 10|works on Tizen 10|Tizen 10 is supported/i, file);
  }
  assert.match(readme, /including Tizen 10 of the models of 2026, which Moonlight Plus has not been tested on yet/);
  assert.match(GUIDE, /Newer includes Tizen 10 of the models of 2026, which Moonlight Plus has not been tested on yet/);
  // The freeze is known on Tizen 9 only
  assert.match(GUIDE, /The switch can freeze the picture on Tizen 9\. Whether it still does on Tizen 10 is not known, so the app treats Tizen 10 the same way\./);
  // The hint after an update of Tizen, with the one-time warning of 2.3.1 as the code does it
  const forceGm = GUIDE.slice(GUIDE.indexOf('\n## ForceGM variant and game mode\n'), GUIDE.indexOf('\n## TV picture settings\n'));
  assert.match(forceGm, /- \*\*After an update of Tizen\*\* \(e\.g\. from 8\.0 to 9\.0, or to 10\.0\): [^\n]*Check in Settings → Video Settings that the switch is off/);
  assert.match(forceGm, /Since 2\.3\.1, the first start on Tizen 9\.0 or newer shows the compatibility warning of the switch once when it is still on from an earlier version of Tizen\. Versions up to 2\.3\.0 didn't store the Tizen version with the switch, so a switch that one of them stored also gets the warning once/);
  assert.match(readme, /Keep the \*Ultra low latency mode\* switch of the app off with it, also after an update of the TV to a newer Tizen version\./);
});

test('the guide gives the tested bitrate steps of the S90C itself, and no document links the documents of v1.19.0-s90c.1', () => {
  const bitrate = GUIDE.slice(GUIDE.indexOf('\n## Finding your bitrate\n'), GUIDE.indexOf('\n## ', GUIDE.indexOf('\n## Finding your bitrate\n') + 1));
  assert.match(bitrate, /\*\*Samsung S90C over Wi-Fi:\*\* starts at 100 Mbps, the recommendation that also suits a weaker Wi-Fi link, and the app warns above 150 Mbps, which this model streams in daily use \(4K HDR in AV1 over 5 GHz Wi-Fi, `fec_percentage` 5 in Sunshine\)\. The tuning plan of the first release for this model tests 100 → 120 → 135 → 150 Mbps/);
  assert.equal(profile.presetBitrate('3840:2160', 60, 'wifi', capsOf({ tv: 's90c' })), 100);
  assert.equal(profile.getBitrateWarningMbps(capsOf({ tv: 's90c' })), 150);
  // The archive of the German documents left the branch in 2.2.0, and since 2.3.1, as the owner decided, no current
  // document links it at its tag any more (the history of the changelog and the patch notes still names the tag)
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'docs', 'profiles')));
  const documents = ['README.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', '.github/CONTRIBUTING.md', 'tests/README.md']
    .concat(fs.readdirSync(path.join(REPO_ROOT, 'docs')).filter((name) => name.endsWith('.md')).map((name) => 'docs/' + name));
  assert.ok(documents.indexOf('docs/GUIDE.md') >= 0 && documents.indexOf('docs/PATCH_NOTES.md') >= 0 && documents.indexOf('docs/RELEASE_NOTES.md') >= 0);
  for (const file of documents) {
    assert.doesNotMatch(read(file), /moonlight-tizen-Plus\/(?:tree|blob)\/v1\.19\.0-s90c\.1/, file + ' links the tag v1.19.0-s90c.1');
  }
  assert.doesNotMatch(read('README.md'), /S90C documents of the first release/);
  assert.doesNotMatch(GUIDE, /German tuning guide/);
  // The patch notes keep their pointer to the changelog, without the documents of the tag
  assert.match(read('docs/PATCH_NOTES.md'), /\nEvery technical detail of every version is in the \[changelog\]\(\.\.\/CHANGELOG\.md\)\.\n/);
});

test('the controller page names the menu buttons that the navigation guide leaves out', () => {
  const controllers = read('docs/CONTROLLERS.md');
  const start = controllers.indexOf('\n## Buttons in the menus\n');
  const section = controllers.slice(start, controllers.indexOf('\n## ', start + 1));
  // The buttons of the table by their Xbox names (before a slash or a bracket), e.g. "Select / View (Share, Create)"
  const buttons = section.split('\n').filter((line) => /^\| /.test(line) && !/^\| (Button|---)/.test(line))
    .map((line) => line.split('|')[1].trim().split(' / ')[0].replace(/ \(.*\)$/, ''));
  assert.deepEqual(buttons, ['A', 'B', 'D-pad, left stick', 'Select', 'Start']);
  // The controller keys of the navigation guide (wasm/index.html), each line of a button as its own key
  const guideKeys = [];
  const pattern = /class="navGuideGamepadText" data-i18n="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(read('wasm/index.html'))) !== null) {
    guideKeys.push(match[1]);
  }
  const KEYS = { 'A': ['A'], 'B': ['B'], 'D-pad, left stick': ['D-PAD UP', 'L-STICK UP'], 'Select': ['SELECT'], 'Start': ['START'] };
  const missing = buttons.filter((button) => KEYS[button].some((key) => guideKeys.indexOf(key) < 0));
  // Start (CH- on the remote) only sets the focus, and the guide has no line for it since 2.2.0
  assert.deepEqual(missing, ['Start']);
  const sentence = section.split('\n').find((line) => line.indexOf('- The in-app *Navigation guide* (Settings → About) lists') === 0);
  assert.ok(sentence, 'the controller page refers to the navigation guide');
  assert.match(sentence, new RegExp('lists the same buttons except ' + missing.join(' and ') + ','));
});

test('the README and the guide name the PC list, its chip and its Add PC card as the English UI does', () => {
  // The title of the first screen and its card for a new PC (wasm/platform/index.js, wasm/index.html)
  assert.match(read('wasm/platform/index.js'), /\$\('#header-title'\)\.attr\('data-i18n', 'PCs'\)/);
  assert.match(read('wasm/index.html'), /<span class="host-text" data-i18n="Add PC">Add PC<\/span>/);
  const readme = read('README.md');
  const hostsShot = readme.split('\n').find((line) => line.indexOf('](docs/images/hosts.jpg)') > 0);
  assert.ok(hostsShot, 'the README shows docs/images/hosts.jpg');
  assert.match(hostsShot, /titled PCs/);
  assert.match(hostsShot, /with one Running chip/);
  assert.match(hostsShot, /next to the Add PC card/);
  // Names of 2.1.0 that the screens no longer show: the screen Hosts, the card Add Host, three chips of a PC, and the
  // gamepad in the header of the app list
  for (const [file, text] of [['README.md', readme], ['docs/GUIDE.md', GUIDE]]) {
    assert.doesNotMatch(text, /Add Host|Hosts screen|host list\b|\*\*Hosts\.\*\*|\| Hosts \||Running, Online and Paired|Select on a gamepad/, file);
  }
  assert.match(GUIDE, /\*\*PC list\.\*\* The first screen, titled \*PCs\*\./);
});

// The video bitrate that Sunshine gives the encoder for the bitrate of the app (src/rtsp.cpp of Sunshine, when the
// client sends x-ml-video.configuredBitrateKbps as moonlight-common-c does): the FEC share comes off first, then the
// audio (256 Kbps per channel of high quality audio, at most a fifth) and 500 Kbps for packet headers and control data
// (at most a tenth)
function sunshineEncoderMbps(bitrateMbps, fecPercentage, channels) {
  let kbps = bitrateMbps * 1000;
  kbps /= 100 / (100 - fecPercentage);
  kbps -= Math.min(256 * channels, kbps / 5);
  kbps -= Math.min(500, kbps / 10);
  return kbps / 1000;
}

test('the guide gives the share of the bitrate that Sunshine leaves to the encoder, and the parity packets Moonlight asks for', () => {
  // The default audio of the app is stereo, and moonlight-common-c asks for high quality audio from 15 Mbps on
  assert.match(read('wasm/platform/index.js'), /const defaultAudioConfig = 'Stereo';/);
  const threshold = Number(/#define HIGH_AUDIO_BITRATE_THRESHOLD (\d+)/.exec(read('moonlight-common-c/src/Limelight-internal.h'))[1]);
  assert.ok(150000 >= threshold, 'high quality audio at 150 Mbps');
  const fec = guideSection('### Error correction (FEC)');
  assert.match(fec, /Sunshine gives the encoder the bitrate × \(100 − FEC\) \/ 100, minus the audio and about 0\.5 Mbps\./);
  const at20 = Math.round(sunshineEncoderMbps(150, 20, 2));
  const at5 = Math.round(sunshineEncoderMbps(150, 5, 2));
  assert.deepEqual([at20, at5], [119, 141]);
  assert.ok(fec.indexOf('At 150 Mbps, the video gets about ' + at20 + ' Mbps at FEC 20 and about ' + at5 + ' Mbps at FEC 5.') >= 0, fec);
  assert.ok(fec.indexOf('(at 150 Mbps about ' + at5 + ' instead of ' + at20 + ' Mbps)') >= 0, fec);
  // The section Above 150 Mbps rounds the same arithmetic to 10 Mbps
  assert.equal(Math.round(sunshineEncoderMbps(250, 20, 2) / 10) * 10, 200);
  assert.match(GUIDE, /so at 250 Mbps the encoder gets about 200 Mbps/);
  // moonlight-common-c asks for at least 2 parity packets per FEC block, which Sunshine adds to every block
  assert.match(read('moonlight-common-c/src/SdpGenerator.c'), /"x-nv-vqos\[0\]\.fec\.minRequiredFecPackets", "2"\)/);
  assert.match(fec, /at least 2 parity packets in every block of a frame, so 2 lost packets in a block are always repaired/);
  assert.match(fec, /20 → 10 → 5 \(not 0, see \[Host settings\]/);
  // The stable Sunshine and its forks accept fec_percentage 1 to 255 (int_between_f in src/config.cpp keeps the default
  // for any other value); only the Sunshine pre-releases from v2026.1103 on accept 0, which turns FEC off
  const host = guideSection('## Host settings (Sunshine)');
  assert.match(host, /accept 1 to 255 and ignore any other value without a warning, so 0 leaves it at 20\. Only the Sunshine pre-releases from v2026\.1103 on accept 0, which turns error correction off/);
  // max_bitrate is only read by the avcodec encoders; the NVENC encoder of Sunshine on Windows takes the client bitrate
  assert.match(host, /caps the bitrate of the encoder \(after error correction and audio\) with AMD, Intel and software encoding and on Linux; Sunshine's NVENC encoder on Windows ignores it/);
  assert.match(fec, /as long as \*Session frames dropped by network\* stays at 0 and \*Worst FEC block\* doesn't often come close to its limit/);
  assert.match(fec, /If losses appear, first raise it to 10 again at the same bitrate/);
  assert.match(fec, /the TV decodes more video bits at the same bitrate setting/);
  // The bullet of the host settings points there instead of only saying to keep the default
  assert.doesNotMatch(GUIDE, /the share of error correction data\. Keep the default\./);
  // The received bitrate of the statistics only adds up the video frames (wasmplayer.cpp), so it can't reach the
  // configured bitrate, and the troubleshooting of a blocky picture gives the same ceiling as the FEC section
  const player = read('wasm/wasmplayer.cpp');
  assert.match(player, /total_bytes \+= decodeUnit->fullLength;/);
  assert.match(player, /receivedBitrate = \(total_bytes \* 8\.0f\)/);
  const blocky = GUIDE.split('\n').find((line) => line.indexOf('- **Blocky picture although the bitrate is high:**') === 0);
  assert.ok(blocky, 'the troubleshooting item');
  assert.ok(blocky.indexOf('It counts only the video, so it tops out at the share that Sunshine leaves to the encoder') > 0, blocky);
  assert.ok(blocky.indexOf('at 150 Mbps *configured*, about ' + at20 + ' Mbps at FEC 20 and about ' + at5 + ' Mbps at FEC 5') > 0, blocky);
  assert.doesNotMatch(blocky, /If much less arrives/);
});

test('the guide says that Sunshine changes the host display only with its display device configuration, which is off by default', () => {
  const host = guideSection('## Host settings (Sunshine)');
  assert.match(host, /The display device configuration of Sunshine \(\*Device configuration\* in its web UI, `dd_configuration_option`, Windows only\) is off by default \(`disabled`\), and with it all its `dd_` options/);
  assert.match(host, /Set it to `ensure_active` \(\*Activate the display automatically\*\), or to `ensure_only_display` for a virtual display/);
  // The statement of 2.2.1 that the refresh rate follows the stream anyway, which needs the configuration on
  assert.doesNotMatch(GUIDE, /follows the selected frame rate anyway/);
  // The app reconnects on purpose (index.js), so a revert at every disconnect would switch the display back and forth
  const index = read('wasm/platform/index.js');
  assert.match(index, /function retryStreamStart\(/);
  assert.match(index, /function restartStreamWithSettings\(/);
  assert.match(host, /Leave `dd_config_revert_on_disconnect` off\. Moonlight Plus reconnects on purpose, for a new bitrate or surround quality from the Stream Menu and once more when no video arrived at the start/);
  // The HDR option of the configuration follows the HDR state that the app sends as hdrMode with every start: the
  // state of the Video HDR switch goes in the place of enableHdr into both requests
  const utils = read('wasm/static/js/utils.js');
  assert.equal((utils.match(/'&hdrMode=' \+ enableHdr/g) || []).length, 2, '/launch and /resume');
  assert.match(index, /const hdrMode = \$\('#hdrModeSwitch'\)\.parent\(\)\.hasClass\('is-checked'\) \? 1 : 0;/);
  const withoutComments = index.replace(/\/\/[^\n]*/g, '');
  for (const request of ['launchApp', 'resumeApp']) {
    const parameters = new RegExp(request + ': function\\(([^)]*)\\)').exec(utils)[1].split(',').map((name) => name.trim());
    const start = withoutComments.indexOf('host.' + request + '(');
    assert.ok(start >= 0, 'index.js calls host.' + request);
    const call = withoutComments.slice(start + request.length + 6, withoutComments.indexOf(').then(', start));
    // The arguments at the top level of the call (the frame rate argument concatenates strings, without commas)
    const args = call.split(',').map((arg) => arg.trim());
    assert.equal(args.length, parameters.length, request + ': ' + args.join(' | '));
    assert.equal(args[parameters.indexOf('enableHdr')], 'hdrMode', request);
  }
  assert.match(host, /turns HDR on or off as \*Video HDR\* of the app \(Settings → Video Settings\) asks/);
});

test('the guide says that the app never asks Apollo for its virtual display', () => {
  // Apollo creates its virtual display for virtualDisplay=1 in /launch, or for a device or an app set to always create it
  for (const file of ['wasm/static/js/utils.js', 'wasm/platform/index.js']) {
    assert.doesNotMatch(read(file), /virtualDisplay/, file);
  }
  const apollo = guideSection('### Apollo and Vibepollo');
  assert.match(apollo, /Apollo creates its virtual display when a client asks for it, which Moonlight Plus doesn't, for its own \*Virtual Display\* entry in the app list, for a device or an app that is set to always create one, and in its \*Headless Mode\*\./);
  assert.match(apollo, /switch \*Always create virtual display\* on for the TV in \*Device Management\*/);
  assert.doesNotMatch(apollo, /creates its virtual display only when a client asks/);
  assert.match(apollo, /The rule of exactly 60 Hz in \[Host settings\]\(#host-settings-sunshine\) is for a physical display or a virtual display with a fixed refresh rate\./);
  assert.match(guideSection('## Host settings (Sunshine)'), /Set the host display to exactly 60 Hz \(or 120 Hz for 120 FPS streams\), not 59\.94 Hz\./);
});

test('the guide names 4:2:0 as the color sampling of the stream, since the app asks for no 4:4:4 format', () => {
  // Every video format that the native code names (the masks aside) is a 4:2:0 format of moonlight-common-c
  const limelight = read('moonlight-common-c/src/Limelight.h');
  const valueOf = (name) => {
    const match = new RegExp('#define ' + name + '\\s+(0x[0-9A-Fa-f]+)').exec(limelight);
    assert.ok(match, name + ' in Limelight.h');
    return Number(match[1]);
  };
  const yuv444 = valueOf('VIDEO_FORMAT_MASK_YUV444');
  const named = new Set();
  fs.readdirSync(path.join(REPO_ROOT, 'wasm')).filter((name) => /\.(cpp|hpp|h)$/.test(name)).forEach((name) => {
    for (const match of read('wasm/' + name).matchAll(/\bVIDEO_FORMAT_(?!MASK_)[A-Z0-9_]+/g)) {
      named.add(match[0]);
    }
  });
  assert.ok(named.has('VIDEO_FORMAT_H265_MAIN10') && named.has('VIDEO_FORMAT_AV1_MAIN10'), [...named].join(', '));
  named.forEach((name) => assert.equal(valueOf(name) & yuv444, 0, name));
  // The formats that the app offers the host, masks and numbers included: VIDEO_FORMAT_MASK_YUV444 or
  // VIDEO_FORMAT_MASK_H264 there would ask for 4:4:4
  const main = read('wasm/main.cpp');
  const offers = [...main.matchAll(/supportedVideoFormats\s*\|?=(?!=)([^;]*);/g)].map((match) => match[1]);
  assert.ok(offers.length >= 3, offers.join(' / '));
  offers.forEach((offer) => {
    let value = 0;
    for (const match of offer.matchAll(/\bVIDEO_FORMAT_[A-Z0-9_]+\b|\b0x[0-9A-Fa-f]+\b|\b\d+\b/g)) {
      value |= /^VIDEO_FORMAT_/.test(match[0]) ? valueOf(match[0]) : Number(match[0]);
    }
    assert.equal(value & yuv444, 0, offer);
  });
  const item = GUIDE.split('\n').find((line) => line.indexOf('- **Color sampling:**') === 0);
  assert.ok(item, 'the item of the known limits');
  assert.match(item, /the stream is 4:2:0\. Samsung TVs decode HEVC Main and Main10 and AV1 Main, which have no YUV 4:4:4, so the app doesn't offer it/);
});

test('the guide describes the latency modes and the Game Mode of the two files as the code selects them', () => {
  // The switch selects the Ultra Low Latency mode of the WASM player when on and the Low Latency mode when off
  assert.match(read('wasm/main.cpp'), /gameMode \? EmssLatencyMode::kUltraLow : EmssLatencyMode::kLow/);
  const forceGm = guideSection('## ForceGM variant and game mode');
  assert.match(forceGm, /Samsung documents the Ultra Low Latency mode as the Low Latency mode with the video enhancements of the TV off and its game mode on/);
  // Only the ForceGM build adds the Game Mode metadata, so the standard file with the switch off never asks for it
  assert.doesNotMatch(read('res/config.xml'), /use\.game\.mode/);
  const dockerfile = read('Dockerfile');
  const injection = dockerfile.slice(dockerfile.indexOf('if [ "$FORCE_GAME_MODE" = "true" ]; then'));
  assert.ok(injection.indexOf('use.game.mode" value="true"') > 0 && injection.indexOf('use.game.mode') < injection.indexOf('else'), 'the metadata only for ForceGM');
  assert.match(forceGm, /lost it only with a build that never asks for Game Mode, as `Moonlight\.wgt` with the \*Ultra low latency mode\* switch off does/);
  // The section on the picture settings of the TV and what it recommends
  const picture = guideSection('## TV picture settings');
  for (const [setting, value] of [['Picture Mode', 'Movie for SDR, Filmmaker Mode (or Movie) for HDR'], ['Color Space', 'Auto'],
    ['Sharpness', '0. A few steps are fine at 1080p or 1440p'], ['Contrast Enhancer', 'Off'],
    ['Noise Reduction (on older models Digital Clean View)', 'Off'], ['Picture Clarity (on older models Auto Motion Plus)', 'Off'],
    ['Auto HDR Remastering', 'Off'], ['Color Tone', 'Warm2'], ['HDR Tone Mapping', 'Static'], ['Shadow Detail', '0'],
    ['Local Dimming (LED and Mini LED models)', 'High']]) {
    const cells = tableRow(setting);
    assert.equal(cells[1].indexOf(value), 0, setting + ': ' + cells[1]);
  }
  assert.match(picture, /\*\*Game HDR:\*\* \*Basic\* \(HGiG\)\. The TV then doesn't tone-map HDR itself/);
  // Foundation Sunshine sends HDR10+ to a client that reports no dynamic HDR capabilities, as this app; the other hosts
  // of the Sunshine family send none
  assert.match(picture, /\*\*HDR10\+ Gaming:\*\* off\. It is a feature for HDMI sources\. LizardByte Sunshine, Apollo and Vibepollo send no HDR10\+ metadata; Foundation Sunshine sends HDR10\+ dynamic metadata/);
  assert.doesNotMatch(GUIDE, /Neither Sunshine nor the app sends HDR10\+ metadata/);
  assert.match(picture, /\*\*Dynamic Black Equalizer:\*\* 0\./);
  assert.match(picture, /Some features of the TV belong to its HDMI inputs and do nothing for the stream of an app: VRR and FreeSync, ALLM/);
  assert.match(picture, /The menu names vary by model year/);
  // Samsung names no single enhancement that the Ultra Low Latency mode turns off, and its game mode is what the Game
  // Mode entries belong to, so the section applies with the switch on as well
  assert.match(picture, /With the \*Ultra low latency mode\* switch on, the video player also turns the video enhancements of the TV off, as Samsung documents the mode, without naming them\./);
  assert.match(picture, /Color Tone, HDR Tone Mapping and the Game Mode entries below apply in every case\./);
  assert.doesNotMatch(picture, /with the switch off, and with the ForceGM variant, the picture settings below apply/);
  assert.doesNotMatch(forceGm, /only selects the latency mode/);
  // Switching the Ultra Low Latency mode off against micro-stutter also gives up its game mode with the standard file
  const microStutter = GUIDE.split('\n').find((line) => line.indexOf('  - *A regular micro-stutter in smooth camera pans on Tizen 6.0 to 8.0:*') === 0);
  assert.ok(microStutter, 'the troubleshooting item');
  assert.match(microStutter, /With `Moonlight\.wgt` this also gives up the game mode that the Ultra Low Latency mode turns on; the ForceGM variant with the switch off keeps the Game Mode of the TV/);
});

test('the guide limits the HDR static metadata to HEVC and AV1, and names the switch that keeps the sound off the host speakers', () => {
  // The metadata goes into HEVC keyframes as SEI messages and into AV1 keyframes as metadata OBUs (wasmplayer.cpp), and
  // a host that sends it during the stream gets asked for a keyframe in both formats (ClSetHdrMode)
  const player = read('wasm/wasmplayer.cpp');
  assert.match(player, /if \(enabled && s_HdrMetadataEnabled && \(s_VideoFormat & \(VIDEO_FORMAT_MASK_H265 \| VIDEO_FORMAT_MASK_AV1\)\) &&/);
  assert.match(player, /\(hevcStream \|\| av1Stream\) && LiGetHdrMetadata\(&hdrMetadata\) &&/);
  assert.match(player, /if \(insertHdrMetadata && av1Stream\) \{/);
  const calibration = guideSection('### HDR calibration');
  assert.match(calibration, /\*HDR static metadata\* passes the same values to the TV, in HEVC and AV1 streams\./);
  assert.match(calibration, /With \*HDR static metadata\* on, a virtual display that reports a very high peak/);
  assert.match(guideSection('## HDR'), /with every HEVC and AV1 keyframe, so that the tone mapping of the TV matches the host\. Sunshine's NVENC encoder writes only the color space into an AV1 stream and no HDR metadata/);
  // The log line that the guide names is the one the module writes
  assert.ok(player.indexOf('"HDR static metadata: inserted into AV1 keyframes (peak %u nits') >= 0);
  // Play audio on the PC (Audio Settings, off when nothing is stored) sends localAudioPlayMode, and with it Sunshine
  // keeps the sink of the host instead of the Steam Streaming Speakers
  const html = read('wasm/index.html');
  const audioSettings = html.slice(html.indexOf('<div id="audioSettings"'), html.indexOf('<div id="inputSettings"'));
  assert.ok(audioSettings.indexOf('data-i18n="Play audio on the PC"') > 0, 'the switch in Audio Settings');
  const index = read('wasm/platform/index.js');
  assert.match(index, /if \(previousValue\.playHostAudio == null\) \{\s*document\.querySelector\('#playHostAudioBtn'\)\.MaterialSwitch\.off\(\);/);
  assert.match(read('wasm/static/js/utils.js'), /'&localAudioPlayMode=' \+ localAudio/);
  assert.match(GUIDE, /Keep \*Play audio on the PC\* \(Settings → Audio Settings, off by default\) off, so that Sunshine plays the sound into the \*Steam Streaming Speakers\* and not on the speakers of the host at the same time\./);
});

test('the guide describes the wait after an abandoned start, the held start message and the restart of the encoder as the code does them', () => {
  const index = read('wasm/platform/index.js');
  const messages = read('wasm/platform/messages.js');
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  const troubleshooting = guideSection('## Troubleshooting');
  // The message, the countdown and the 11 seconds after the answer of the PC (HOST_START_HOLD_MS), which cover the
  // default ping_timeout of Sunshine
  const message = 'The PC is still holding an earlier start, e.g. from another device. Wait a few seconds and start again.';
  assert.ok(messages.indexOf("snackbarLogLong('" + message + "');") > 0);
  assert.ok(troubleshooting.indexOf('| "' + message + '" (before 2.3.0: "RTSP handshake failed (error -1)" with the ports') > 0);
  assert.match(index, /\nvar HOST_START_HOLD_MS = 11000;\n/);
  assert.ok(troubleshooting.indexOf('wait until 11 seconds after the PC accepted the earlier start (or after its request failed), which covers the default `ping_timeout`') > 0);
  assert.ok(english['Waiting for the PC to release the previous start (%1$s s)...']);
  assert.ok(troubleshooting.indexOf('(*Waiting for the PC to release the previous start*)') > 0);
  // The starts that the app remembers, as rememberHeldHostStart() names them
  ['it accepted a start that was cancelled', 'a start it accepted was cancelled',
    'the stream of a start it accepted ended before its control stream connected', 'its launch request failed', 'its resume request failed']
    .forEach((why) => assert.ok(index.indexOf("'" + why + "'") > 0, why));
  assert.ok(troubleshooting.indexOf('(cancelled, ended before their stream connected, or whose request failed on the TV)') > 0);
  // Sunshine drops the new start, not the one it holds (rtsp.cpp of Sunshine), and only /cancel was checked
  assert.ok(troubleshooting.indexOf('Sunshine keeps the earlier one and drops the new one') > 0);
  assert.ok(troubleshooting.indexOf('*Quit app on the PC* doesn\'t release it either') > 0);
  // One start once more, and the message only after it
  assert.match(index, /if \(streamRetried\[restartKind\] \|\| !host/);
  assert.ok(troubleshooting.indexOf('it starts once more by itself after the same wait, and the message shows only if that fails as well') > 0);
  // The restart of the encoder: the log line that the guide quotes, and the keyframe that the statistics leave out
  const player = read('wasm/wasmplayer.cpp');
  assert.ok(player.indexOf('ClLogMessage("The PC restarted its video encoder (e.g. after a display, HDR or desktop change on the PC)\\n");') > 0);
  assert.ok(GUIDE.indexOf('the diagnostic log shows "The PC restarted its video encoder":** Sunshine rebuilt its screen capture and its encoder during the stream') > 0);
  // The app never asks for it, but the keys of the Stream Menu and of a keyboard reach the PC: Alt + Enter switches a
  // game between fullscreen and a window, and Ctrl + Alt + Shift with a key other than Q and S goes to the PC as well
  assert.ok(GUIDE.indexOf('No request of the app causes it, but keys sent to the PC can: e.g. *Alt + Enter* or *Alt + Tab* from the Stream Menu') > 0);
  assert.match(read('wasm/platform/menus.js'), /streamMenuKeyAltEnter: \[0xA4, 0x0D\]/);
  assert.match(read('wasm/input.cpp'), /\} else \{\s+\/\/ Wait until these keys come up to unlock the mouse\s+m_WaitingForAllModifiersUp = true;\s+\}\s+\}\s+LiSendKeyboardEvent\(/);
  assert.equal(GUIDE.indexOf('Nothing on the TV causes it'), -1);
  // A new controller type takes effect once Sunshine creates a new virtual controller, which the guide and
  // CONTROLLERS.md list the same ways (input.cpp and process.cpp of Sunshine 2026.914)
  const controllers = read('docs/CONTROLLERS.md');
  ['the game that the app started was closed on the PC', 'a restart of Sunshine', 'the controller disconnects during a stream']
    .forEach((way) => {
      assert.ok(troubleshooting.indexOf(way) > 0, 'guide: ' + way);
      assert.ok(controllers.indexOf(way) > 0, 'CONTROLLERS.md: ' + way);
    });
  assert.match(player, /\} else if \(!GetHostEncoderRestarts\(\)\.IsRestartKeyframe\(idrMs\)\) \{\s+s_RecoveryIdrFrames\+\+;/);
  assert.ok(guideSection('## Performance statistics').indexOf('The first keyframe of a new encoder that the PC started during the stream doesn\'t count') > 0);
});
