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
//   configuration, the 6-channel PCM track that only the EMSS backend adds, the two channels of the Web Audio output
//   (for which the app asks the PC for stereo since 2.3.1) and the Audio stream line that the check reads
// - the surround audio quality: Efficient as the default since 2.3.1, the row only for 5.1 and 7.1 with the TV media
//   player (Web Audio streams stereo), the 15 Mbps from which the host sends its high quality, the 10 ms packets of
//   Efficient, stereo that it never touches, the Audio CPU line and the limit of the overload message
// - the statistics of 2.3.1: the full statistics every 2 seconds with a graph of 2 minutes, the line about the app, the
//   receive time as a share of the frame time, what the received bitrate counts, the Wi-Fi refresh and the buffer
//   correction of Web Audio; the latency of a higher bitrate in Finding your bitrate; the lowest host frame rate and
//   the hints of the Last session report; the lines of moonlight-common-c and the uncaught errors in the diagnostic
//   log, and the messages that the troubleshooting quotes
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
// - the fork package of 2.3.1: a stored PC that is unknown until its first poll answers, the device name of a pairing,
//   Prioritize sound on Wi-Fi, continuous audio without a switch, the drift of the sound with its hint, the limit of the
//   requests for a keyframe, the 7.1 correction that leaves a fixed host alone, the Sunshine versions that accept FEC 0,
//   HDR10+ that never reaches the TV in HEVC, and the new name of the Sunshine repository
// - the statistics and the log of 2.3.2: the times of a frame from the microsecond clock with their steps of about
//   0.1 ms on the TV, the longest frame times, the arrival rate of the frames (at IP level, data packets only, with its
//   minimum, neither the bitrate nor the Wi-Fi link rate) in the full statistics and Last session, the QoS line of each
//   socket of a stream and the WebAssembly line at the start of the app
// - the keys of a stream (2.3.3): the first key of a PC keyboard only gives the stream the keys (not Esc or a modifier
//   key), RETURN sends Esc, the keys of a TV never reach the PC, Ctrl + Alt + Shift with Q, S (once per press) or
//   another key, and the horizontal wheel
// - the messages and the overlays of a stream (2.3.3): how long a message shows, and where the Stream Menu and the
//   messages go beside the statistics
// - the video receive lines of the diagnostic log (2.3.4): the mode of the receive thread, the lines of a minute and of
//   the stream with their sample of about every 64th read, the lines of the poll() calls of the samples, the line of
//   the frame receive time, how to read them against *Frames arrive at*, and where the guide points to them
// - the keys in the menus (2.3.5): Esc works as RETURN, a held RETURN goes back one level, CH+ once per press and the
//   same key closes the menu of a PC, RIGHT and LEFT between the list of the sections and a section, the keys of the
//   address field of Add PC, B on the launch screen, Exit and Restart on Cancel, and the question of Quit app on the PC
//   in the Stream Menu
// - the first start of the guide (2.3.5): the scan of the /24 network on port 47989, Add PC with its number fields or
//   its text field, the pairing with a PIN of four digits, the troubleshooting rows of the failed pairings and of an
//   app list that couldn't be read, No sound at all; and the README, which claims no tested surround output and, like
//   the guide, names the separate fork for Tizen 5.0
// The release notes of a release (docs/RELEASE_NOTES.md) only give the essentials, so the statements that they
// carried until 1.19.100 are checked in the guide and the patch notes (docs/PATCH_NOTES.md), where they are now.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const tvMock = require('../browser/mocks/tv-mock');
const profile = require('../../wasm/platform/tv_profile');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

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
  // The README lists the Nightjar client among the projects that Moonlight Plus took code from, as the source comments
  // and the list of local changes of moonlight-common-c do
  assert.match(read('README.md'), /from `host-termination\.patch` of the Nightjar client \(GPL-3\.0\)\. The source files and the notices name what comes from where\./);
  assert.match(read('moonlight-common-c/src/ControlStream.c'), /from host-termination\.patch of Nightjar/);
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
  // default of two, so since 2.3.1 a stream with Web Audio asks the PC for stereo, whatever the audio configuration
  // (getStreamAudioConfig() in index.js, which the launch, resume and start requests use)
  const audio = read('wasm/platform/audio.js');
  assert.match(audio, /source\.connect\(_audContext\.destination\)/);
  assert.doesNotMatch(audio, /\.channelCount\s*=|channelCountMode|channelInterpretation/);
  assert.match(read('wasm/platform/index.js'), /function getStreamAudioConfig\(audioConfig, audioBackend\) \{\s+return audioBackend === 'WebAudio' \? 'Stereo' : audioConfig;/);
  assert.match(section, /Web Audio plays through the output of the browser, which the app leaves at two channels, so with Web Audio the app asks the PC for stereo/);
  assert.doesNotMatch(GUIDE, /mixes 5\.1 down to stereo/);
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
  // Since 2.3.1 the row also needs the TV media player: Web Audio streams stereo, so the rows of the audio configuration
  // and of the quality don't show with it (nor without audio output)
  assert.match(index, /function isAudioConfigurationAvailable\(\) \{\s+return !isAudioOutputDisabled\(\) && !isWebAudioBackendSelected\(\);/);
  assert.match(index, /\$\('#surroundQualityOption'\)\.toggle\(isAudioConfigurationAvailable\(\) && isSurroundAudioSelected\(\)\);/);
  assert.match(section, /Settings → Audio Settings → \*Surround audio quality\*, shown only with 5\.1 or 7\.1 and the TV media player:/);
  // A chosen quality stays, an install without one follows the default, and Restore Defaults and the optimal settings
  // button set the default (applyOptimalStreamingSettings())
  assert.match(read('wasm/platform/tv_profile.js'), /surroundQuality: DEFAULT_SURROUND_QUALITY/);
  assert.match(section, /A quality that you chose stays\. An install that never chose one follows the default, and the app tells it once when its stream changes/);
  assert.match(section, /\*Restore Defaults\* and the optimal settings button set \*Efficient\*/);
  // The overload message: more than 300 ms of work per second of sound over 10 s (wasm/audio_load.hpp)
  const load = read('wasm/audio_load.hpp');
  assert.match(load, /constexpr uint32_t kAudioLoadWindowMs = 10000;/);
  assert.match(load, /constexpr uint32_t kAudioOverloadMsPerSecond = 300;/);
  assert.match(section, /takes more than 300 ms per second of sound over 10 seconds, the app says so once per session/);
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
  // The README lists the Nightjar client among the projects that Moonlight Plus took code from, as the source comments
  // and the list of local changes of moonlight-common-c do
  assert.match(read('README.md'), /from `host-termination\.patch` of the Nightjar client \(GPL-3\.0\)\. The source files and the notices name what comes from where\./);
  assert.match(read('moonlight-common-c/src/ControlStream.c'), /from host-termination\.patch of Nightjar/);
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
  // for any other value); 0 turns FEC off from the Sunshine pre-release v2026.1115.211404 (#5454, 82b22c7) on, and from
  // the nightlies Vibepollo 2.14.11 and Vibeshine 2.14.0 on (git tag --contains). No v2026.1103 release exists. The
  // pre-release reads it with {0, 100}, the nightlies with {0, 255} (src/config.cpp of each tag).
  const host = guideSection('## Host settings (Sunshine)');
  assert.match(host, /The stable releases of Sunshine \(v2026\.914\.233613\), Apollo \(v0\.4\.8\), Vibepollo and Vibeshine \(2\.0\.6\) accept 1 to 255 and ignore any other value without a warning, so 0 leaves it at 20\. Only the Sunshine pre-release v2026\.1115\.211404 and newer \(#5454, which accepts 0 to 100 and ignores a value above 100\), the Vibepollo nightly 2\.14\.11 and newer and the Vibeshine nightly 2\.14\.0 and newer \(0 to 255\) accept 0, which turns error correction off/);
  assert.doesNotMatch(GUIDE, /v2026\.1103/);
  // The pacing ceiling of Vibepollo and Vibeshine starts from the encoder bitrate, which already has the error
  // correction taken out of the bitrate of the app (src/rtsp.cpp and pacing_reservation_for_config() in src/stream.cpp
  // of Vibepollo 2.0.6), so the guide doesn't add the FEC on top of the bitrate a second time
  assert.match(GUIDE, /set it well above the bitrate of the app plus about 10 %: the error correction comes out of that bitrate/);
  assert.doesNotMatch(GUIDE, /× \(1 \+ `fec_percentage` \/ 100\)/);
  // max_bitrate is only read by the avcodec encoders; the NVENC encoder of Sunshine on Windows takes the client bitrate
  assert.match(host, /caps the bitrate of the encoder \(after error correction and audio\) with AMD, Intel and software encoding and on Linux; Sunshine's NVENC encoder on Windows ignores it/);
  assert.match(fec, /as long as \*Session frames dropped by network\* stays at 0 and \*Worst FEC block\* doesn't often come close to its limit/);
  assert.match(fec, /If losses appear, first raise it to 10 again at the same bitrate/);
  assert.match(fec, /the TV decodes more video bits at the same bitrate setting/);
  // The bullet of the host settings points there instead of only saying to keep the default
  assert.doesNotMatch(GUIDE, /the share of error correction data\. Keep the default\./);
  // The received bitrate of the statistics only adds up the video frames (wasmplayer.cpp), of the two stats windows
  // that its figures cover, so it can't reach the configured bitrate, and the troubleshooting of a blocky picture gives
  // the same ceiling as the FEC section
  const player = read('wasm/wasmplayer.cpp');
  assert.match(player, /total_bytes \+= decodeUnit->fullLength;/);
  assert.match(player, /s_LastWndBytes = total_bytes;\s+total_bytes = 0;/);
  assert.match(player, /receivedBitrate = \(\(\(uint64_t\)s_LastWndBytes \+ total_bytes\) \* 8\.0f\)/);
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
  assert.match(picture, /\*\*HDR10\+ Gaming:\*\* off\. It is a feature for HDMI sources\. Sunshine, Apollo and Vibepollo send no HDR10\+ metadata; Foundation Sunshine sends HDR10\+ dynamic metadata/);
  // HDR10+ travels in SEI messages, which moonlight-common-c strips from the start of every H.264 and HEVC frame and from
  // the parameter sets of a keyframe, so in HEVC it never reaches the player; an AV1 frame goes through unparsed
  const depacketizer = read('moonlight-common-c/src/VideoDepacketizer.c');
  assert.match(depacketizer, /while \(isAccessUnitDelimiter\(currentPos\) \|\| isSeiNal\(currentPos\)\) \{\s+skipToNextNal\(currentPos\);/);
  assert.match(depacketizer, /while \(isSeiNal\(&currentPos\)\) \{\s+skipToNextNal\(&currentPos\);/);
  assert.match(read('wasm/wasmplayer.cpp'), /An AV1 frame comes as one temporal unit that moonlight-common-c doesn't parse/);
  assert.match(picture, /In HEVC it never reaches the TV: HDR10\+ travels in SEI messages in front of the picture data of a frame, and the streaming library of the app drops every such message\. In AV1 the app doesn't parse the frames, so the metadata reaches the video player of the TV; whether the player uses it is untested\./);
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
  // game between fullscreen and a window, and Ctrl + Alt + Shift with a key other than Q and S goes to the PC as well,
  // and since 2.3.3 no longer ends the pointer lock
  assert.ok(GUIDE.indexOf('No request of the app causes it, but keys sent to the PC can: e.g. *Alt + Enter* or *Alt + Tab* from the Stream Menu') > 0);
  assert.match(read('wasm/platform/menus.js'), /streamMenuKeyAltEnter: \[0xA4, 0x0D\]/);
  assert.equal(read('wasm/input.cpp').indexOf('m_WaitingForAllModifiersUp'), -1);
  assert.match(read('wasm/input.cpp'), /keyCode == 0x53\) \{ \/\/ S key[\s\S]{0,120}if \(!event\.repeat\) \{\s+toggleStats\(\);\s+\}\s+return EM_TRUE;\s+\}\s+\}\s+LiSendKeyboardEvent\(/);
  assert.equal(GUIDE.indexOf('Nothing on the TV causes it'), -1);
  // A new controller type takes effect once Sunshine creates a new virtual controller, which the guide and
  // CONTROLLERS.md list the same ways (input.cpp and process.cpp of Sunshine 2026.914)
  // The README lists the Nightjar client among the projects that Moonlight Plus took code from, as the source comments
  // and the list of local changes of moonlight-common-c do
  assert.match(read('README.md'), /from `host-termination\.patch` of the Nightjar client \(GPL-3\.0\)\. The source files and the notices name what comes from where\./);
  assert.match(read('moonlight-common-c/src/ControlStream.c'), /from host-termination\.patch of Nightjar/);
  const controllers = read('docs/CONTROLLERS.md');
  ['the game that the app started was closed on the PC', 'a restart of Sunshine', 'the controller disconnects during a stream']
    .forEach((way) => {
      assert.ok(troubleshooting.indexOf(way) > 0, 'guide: ' + way);
      assert.ok(controllers.indexOf(way) > 0, 'CONTROLLERS.md: ' + way);
    });
  assert.match(player, /\} else if \(!GetHostEncoderRestarts\(\)\.IsRestartKeyframe\(idrMs\)\) \{\s+s_RecoveryIdrFrames\+\+;/);
  assert.ok(guideSection('## Performance statistics').indexOf('The first keyframe of a new encoder that the PC started during the stream doesn\'t count') > 0);
});

test('the guide describes the statistics of 2.3.1 as the code makes them: the update every 2 seconds, the receive time and the received bitrate', () => {
  const stats = guideSection('## Performance statistics');
  // The module sends the full statistics at every second stats window of about a second, the compact line at each one,
  // and the graph has one bar per update over 60 bars
  assert.match(read('wasm/compact_stats.hpp'), /constexpr int kFullStatsWindows = 2;/);
  const messages = read('wasm/platform/messages.js');
  assert.match(messages, /const STATS_GRAPH_SLOTS = 60;/);
  assert.match(messages, /const STATS_GRAPH_SLOT_MS = 2000;/);
  assert.match(stats, /\*\*Full\*\* shows every line below and updates every 2 seconds\./);
  assert.match(stats, /It updates every second\. That is the stream as set up/);
  assert.match(stats, /a slim graph shows the last 2 minutes: one bar per update/);
  assert.doesNotMatch(stats, /last 60 seconds|one bar per second|\*\*Network and TV, per second\*\*/);
  // The line about the app at the top, from getStreamBuildInfo(), and the audio configuration it names
  assert.match(read('wasm/platform/index.js'), /streamBuildInfo = getStreamBuildInfo\(/);
  assert.match(stats, /The first line names the app with its version, the audio backend and the audio setting of the stream, e\.g\. \*Moonlight Plus 2\.3\.1 · TV media player \(EMSS\) · 5\.1 Efficient\*/);
  // The receive time with its share of the frame time, and the bitrate line with what received counts
  const player = read('wasm/wasmplayer.cpp');
  assert.ok(player.indexOf('"Average frame receive time: %.2f ms (%.0f%% of the frame time)\\n"') > 0);
  assert.ok(player.indexOf('"Bitrate: %.2f Mbps video received, %.1f Mbps configured (with FEC and audio)\\n"') > 0);
  assert.ok(tableRow('Average frame receive time')[1].indexOf('e.g. *8.65 ms (52% of the frame time)* at 60 FPS') > 0);
  // (the first row named Bitrate is the one of the Stream Menu)
  assert.match(stats, /\n\| Bitrate \| The video that arrived in the last 2 seconds \(\*video received\*\), and the bitrate set in the app \(\*configured\*\), which also holds the error correction and the audio of the host/);
  // The Wi-Fi signal is read again 5 seconds after the last reading, at the next update, which comes every 2 seconds
  assert.match(read('wasm/platform/index.js'), /if \(now - lastWifiSignalRefreshMs < 5000\) \{/);
  assert.match(tableRow('Network connection')[1], /refreshed about every 6 seconds/);
  // The Web Audio value that 2.3.0 called clock sync
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  assert.ok(english['Audio session: underruns %1$s, skipped %2$s, lost %3$s, buffer correction %4$s, suggested buffer %5$s']);
  assert.match(tableRow('Audio buffer, Audio session')[1], /the \*buffer correction\* of \*Audio clock sync\*/);
  assert.match(guideSection('## Audio'), /Its \*buffer correction\* \(called \*clock sync\* before 2\.3\.1\) is how much faster or slower the sound plays/);
});

test('the guide gives the latency of a higher bitrate and looks for the lowest bitrate that looks as good, as the texts of the app do', () => {
  const bitrate = guideSection('## Finding your bitrate');
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  // The figure that the help text and the optimal settings dialog give, with where it was measured
  assert.ok(Object.keys(english).some((key) => key.indexOf('about 0.6 to 0.8 ms more latency per 10 Mbps, measured on one fast Wi-Fi connection') > 0));
  assert.match(bitrate, /On one fast Wi-Fi connection \(4K at 60 FPS, 150 to 180 Mbps\), every 10 Mbps more added about 0\.6 to 0\.8 ms of latency/);
  assert.match(bitrate, /So look for the lowest bitrate at which fast scenes look as good as at a higher one, below the first bitrate at which frames get lost:/);
  assert.match(bitrate, /5\. If it passes and fast scenes still look blocky, raise the bitrate by about 15 to 20 %\./);
  assert.match(bitrate, /7\. Use the lowest step that looks as good as the higher ones, and never one that failed\./);
  assert.doesNotMatch(GUIDE, /Find the highest bitrate that stays clean|Use the highest step that passed/);
  // No text of the app ties a higher bitrate to the absence of dropped frames any more, nor does the guide
  assert.doesNotMatch(GUIDE, /raise the bitrate up to [^.]* if [^.]*no dropped frames|raise it only if the performance statistics show no dropped frames/i);
  // The help text gives the gap between configured and received with its condition, the guide the same measurement
  assert.ok(Object.keys(english).some((key) => key.indexOf('so the statistics show about 9% less as received (with 5% error correction)') > 0));
  assert.match(bitrate, /in one measurement with 5 % error correction about 9 % below/);
  // The 100 Mbps port: 75 Mbps at 60 FPS is 1.25 Mbit per frame, about 12.5 ms at the line rate
  assert.equal(75 / 60 / 100 * 1000, 12.5);
  assert.match(bitrate, /a frame of 75 Mbps at 60 FPS needs about 13 of the 16\.7 ms between two frames \(computed from the speed of the port, not measured\)/);
});

test('the guide describes the Last session report, the diagnostic log and the messages of 2.3.1 as the code does', () => {
  const report = tableRow('Last session')[1];
  // The lowest host frame rate: windows of 30 s without the first one and without a paused host, low below 95 %
  const session = read('wasm/session_report.hpp');
  assert.match(session, /constexpr uint32_t kHostRateLowPercent = 95;/);
  assert.match(session, /constexpr uint32_t kHostRatePausedRepeatPercent = 5;/);
  assert.ok(report.indexOf('the host frame rate of the lowest 30 seconds and in how many half minutes it stayed below 95 % of the stream rate') > 0, report);
  assert.ok(report.indexOf('without the first half minute of a stream and without those of a paused game, in which the PC repeats at least 5 % of its frames') > 0, report);
  // The hint about the frames of the PC only without the hints about the network and a busy encoder
  const diagnostics = read('wasm/platform/diagnostics.js');
  assert.match(diagnostics, /if \(!network && isHostEncoderSaturated\(report\)\) \{\s+hints\.push\('host'\);\s+\} else if \(!network && isHostShortOfFrames\(report\)\) \{\s+hints\.push\('hostFrames'\);/);
  assert.ok(report.indexOf('Without that hint and without the one about the network, a stream of at least 2 minutes in which the PC often sent fewer frames than the stream asked for') > 0, report);
  assert.doesNotMatch(report, /A low host frame rate alone gives no hint/);
  // The hint about keyframes only for a PC that offered reference frame invalidation
  assert.match(diagnostics, /report\.recoveryKeyframes >= 3 && report\.hostRfi && /);
  assert.ok(report.indexOf('comes only after a stream from a PC that offered it (an NVIDIA graphics card)') > 0, report);
  // The diagnostic log: the lines of moonlight-common-c with their limit by kind, and the uncaught errors
  assert.match(read('CMakeLists.txt'), /target_compile_definitions\(moonlight-common-c PUBLIC[\s\S]*?LC_LOG\)/);
  const ring = read('wasm/diagnostic_log.hpp');
  assert.match(ring, /static constexpr uint32_t kKindBurst = 10;/);
  assert.match(ring, /static constexpr uint64_t kKindRefillMs = 60000;/);
  const log = guideSection('### Diagnostic log');
  assert.ok(log.indexOf('A line that comes for every lost packet or frame is kept 10 times, then once a minute with the number of the similar lines that were left out') > 0, log);
  assert.match(diagnostics, /const MAX_UNCAUGHT_LINES = 20;/);
  assert.ok(log.indexOf('each different one once per session and at most 20') > 0, log);
  // The lines of the streaming engine that the troubleshooting explains are those of moonlight-common-c
  const library = ['VideoDepacketizer.c', 'RtpVideoQueue.c', 'ControlStream.c'].map((file) => read('moonlight-common-c/src/' + file)).join('\n');
  ['Limelog("Video decode unit queue overflow\\n");', 'Limelog("Waiting for IDR frame\\n");', 'Limelog("Unrecoverable frame %d', 'Limelog("Network dropped %d frames', 'Limelog("IDR frame request sent\\n");']
    .forEach((line) => assert.ok(library.indexOf(line) > 0, line));
  const troubleshooting = guideSection('## Troubleshooting');
  ['"Unrecoverable frame"', '"Waiting for IDR frame"', '"Video decode unit queue overflow"', '*IDR frame request sent*']
    .forEach((name) => assert.ok(troubleshooting.indexOf(name) > 0, name));
  // The messages that the troubleshooting quotes are the texts of the app
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  ['Unable to start the stream. The reason is in the diagnostic log (Settings, About).',
    'The sound is keeping the TV busy. If it stutters, set Surround audio quality to Efficient, or Audio configuration to Stereo.']
    .forEach((message) => {
      assert.equal(english[message], message);
      assert.ok(troubleshooting.indexOf('| "' + message + '" |') >= 0, message);
    });
  assert.ok(english['The PC can\'t encode the selected codec, so it sent %1$s, which the TV rejected at %2$sx%3$s@%4$s FPS. Choose a resolution up to 1080p.']);
  assert.ok(troubleshooting.indexOf('*The PC can\'t encode the selected codec, so it sent H.264, which the TV rejected at …*') > 0);
  assert.match(read('wasm/auddec.cpp'), /Creating the Opus decoder failed with error %d \(%s\), so the audio stream can't start/);
  assert.ok(troubleshooting.indexOf('*Creating the Opus decoder failed* before "audio stream establishment failed"') > 0);
});

test('the guide describes the changes of the fork package of 2.3.1 as the code makes them', () => {
  const index = read('wasm/platform/index.js');
  const utils = read('wasm/static/js/utils.js');
  // A stored PC is unknown until its first poll answers, OK waits for it, and its details say Unknown
  // (loadHTTPCertsCb(), hostChosen(), hostDetailsDialog() in index.js)
  assert.match(index, /revivedHost\.online = null;\s+revivedHost\.currentGame = 0;/);
  assert.match(index, /'Waiting for the first answer of ' \+ host\.hostname \+ ' before opening it\.'/);
  assert.match(index, /host\.online === true \? t\('ONLINE'\) : \(host\.online === false \? t\('OFFLINE'\) : t\('Unknown'\)\)/);
  assert.match(GUIDE, /Right after the app starts, a PC that the app knows shows no state until its first check answers/);
  assert.match(GUIDE, /Meanwhile its menu offers \*Wake PC\* and its details say \*State: Unknown\*\./);
  // The device name of a pairing: Moonlight Plus (model of the TV), roth for GeForce Experience; Apollo and Vibepollo
  // store it with brackets, and a TV paired earlier keeps its name there
  assert.match(utils, /var PAIRING_DEVICE_NAME_PREFIX = 'Moonlight Plus \(';/);
  assert.match(utils, /var PAIRING_DEVICE_NAME_DEFAULT = 'roth';/);
  assert.match(utils, /if \(isNvidiaServerSoftware \|\| typeof model !== 'string'\) \{\s+return PAIRING_DEVICE_NAME_DEFAULT;/);
  assert.match(GUIDE, /Sunshine lists the waiting request as \*Moonlight Plus \(model of the TV\)\*, e\.g\. \*Moonlight Plus \(QE55S90CAT\)\*/);
  assert.match(guideSection('### Apollo and Vibepollo'), /shows there as \*Moonlight Plus \[model of the TV\]\*, e\.g\. \*Moonlight Plus \[QE55S90CAT\]\* \(Apollo and Vibepollo turn the parentheses of the name into brackets\)/);
  assert.match(read('README.md'), /When pairing, the app tells the PC the model name of the TV as System information shows it/);
  // Prioritize sound on Wi-Fi: on by default and after Restore Defaults, only the audio of a local stream loses its QoS
  const audio = guideSection('## Audio');
  assert.match(read('wasm/index.html'), /<label data-i18n="Prioritize sound on Wi-Fi">Prioritize sound on Wi-Fi<\/label>/);
  assert.match(index, /const defaultAudioQos = true;/);
  assert.match(index, /if \(previousValue\.audioQos == null\) \{[^}]{0,400}?#audioQosBtn.\)\.MaterialSwitch\.on\(\);/);
  assert.match(read('moonlight-common-c/src/SdpGenerator.c'), /"x-nv-aqos\.qosTrafficType", StreamConfig\.disableAudioQos \? "0" : "4"\);/);
  assert.match(audio, /\*\*Prioritize sound on Wi-Fi\*\* \(Settings → Audio Settings, on by default, since 2\.3\.1\)/);
  assert.match(audio, /the PC then sends the sound without priority, and the picture keeps it/);
  assert.ok(index.indexOf("'\\n Prioritize sound on Wi-Fi (audio QoS on the local network): ' + audioQos") > 0);
  assert.ok(audio.indexOf('*Prioritize sound on Wi-Fi (audio QoS on the local network): 0*') > 0);
  // The app always asks for continuous audio, without a switch
  assert.match(index, /const continuousAudio = 1;/);
  assert.doesNotMatch(read('wasm/index.html'), /continuousAudio/i);
  assert.match(audio, /Sunshine does it from v2026\.516\.143833 on, Vibeshine from 1\.14\.7 and Vibepollo from 2\.0\.2; older versions and other host software ignore the request\./);
  assert.match(audio, /and there is no switch for it any more\./);
  // The drift of the sound: at least 10 minutes of sound after the first minute, a hint from 50 ms per hour
  const lead = read('wasm/audio_lead.hpp');
  assert.match(lead, /constexpr double kAudioLeadSettleSeconds = 60\.0;/);
  assert.match(lead, /constexpr double kAudioDriftMinSeconds = 600\.0;/);
  assert.match(read('wasm/platform/diagnostics.js'), /const AUDIO_DRIFT_HINT_MS_PER_HOUR = 50;/);
  assert.ok(JSON.parse(read('wasm/static/locales/en-US.json'))['Sound received ahead of the TV clock: %1$s ms after the first minute, %2$s ms at the end, at most %3$s ms; drift %4$s ms per hour']);
  assert.match(audio, /After at least 10 minutes of sound, the \[report of the last session\]\(#system-information-and-diagnostic-log\) has a line such as \*Sound received ahead of the TV clock: 25 ms after the first minute, 92 ms at the end, at most 95 ms; drift \+53 ms per hour\*\./);
  assert.match(audio, /From \+50 ms per hour on, while \*Limit audio delay\* is off, the report suggests turning it on/);
  assert.match(tableRow('Last session')[1], /A drift of the sound of 50 ms per hour or more gets a hint to turn on \*Limit audio delay\*, while it is off\./);
  assert.match(lead, /"Audio lead of the stream \(sound received ahead of the TV clock, %u s "/);
  assert.ok(guideSection('### Diagnostic log').indexOf('*Audio lead of the stream (sound received ahead of the TV clock, 10 s averages): …*') > 0);
  // The requests for a keyframe: held for 50 to 250 ms while one is on its way, counted at the end of the stream
  const limit = read('moonlight-common-c/src/IdrRequestLimit.h');
  assert.match(limit, /#define IDR_LIMIT_MIN_WINDOW_MS 50\n#define IDR_LIMIT_MAX_WINDOW_MS 250\n/);
  assert.match(read('wasm/wasmplayer.cpp'), /"IDR frame requests of the stream: %u sent, %u held while an IDR frame was on its way\\n"/);
  assert.match(guideSection('## Troubleshooting'), /further requests wait until it arrives, for at most twice the round trip time plus two frame times \(50 to 250 ms\)/);
  // or a quarter longer than the last keyframe took, within the same bound, and the end line names the slowest one
  assert.match(limit, /uint32_t answeredMs = limit->answerMs \+ limit->answerMs \/ 4;/);
  assert.match(guideSection('## Troubleshooting'), /or a quarter longer than the last keyframe took to arrive if that was longer \(a large keyframe over Wi-Fi; still at most 250 ms\)/);
  assert.match(read('wasm/wasmplayer.cpp'), /"IDR frame came %u ms after its request\\n"/);
  assert.ok(guideSection('## Troubleshooting').indexOf('(*the slowest IDR frame came … ms after its request*)') > 0);
  assert.ok(guideSection('### Diagnostic log').indexOf('*IDR frame requests of the stream: 3 sent, 17 held while an IDR frame was on its way*') > 0);
  // The lines of the frame bounds and the start check that the ports of 2.3.1 added to the depacketizer
  const depacketizer = read('moonlight-common-c/src/VideoDepacketizer.c');
  ['Limelog("Depacketizer detected invalid frame start: %u\\n"', 'Limelog("Depacketizer rejected oversized or unallocatable frame: %u\\n"']
    .forEach((line) => assert.ok(depacketizer.indexOf(line) > 0, line));
  assert.match(depacketizer, /#define MAX_VIDEO_REASSEMBLED_FRAME_SIZE \(32 \* 1024 \* 1024\)/);
  assert.ok(guideSection('## Troubleshooting').indexOf('*Depacketizer detected invalid frame start* and *Depacketizer rejected oversized or unallocatable frame* (since 2.3.1) mark a frame that arrived broken or far too large (over 32 MiB)') > 0);
  // The 7.1 correction touches only the wrong order of the older hosts, so a fixed host plays as it is
  assert.match(read('wasm/opus_layout.hpp'), /static const unsigned char kMisrotatedMapping\[8\] = \{ 0, 1, 2, 7, 4, 5, 3, 6 \};/);
  assert.match(guideSection('### Surround audio quality'), /Sunshine fixed it in its pre-release v2026\.1115\.211404 \(#6019\); Apollo v0\.4\.8, Vibepollo up to its nightly 2\.17\.3 and Vibeshine up to its nightly 2\.14\.5 still announce it wrongly\. The app now corrects exactly this wrong order and leaves the right order of a fixed host as it is/);
  assert.doesNotMatch(GUIDE, /Sunshine fixed it in November 2026/);
  // The Sunshine repository moved; the documents link its new name
  for (const [file, text] of [['README.md', read('README.md')], ['docs/GUIDE.md', GUIDE]]) {
    assert.doesNotMatch(text, /github\.com\/LizardByte\/Sunshine/, file);
    assert.match(text, /\(https:\/\/github\.com\/SunshineStream\/Sunshine\)/, file);
  }
  // The README lists the Nightjar client among the projects that Moonlight Plus took code from, as the source comments
  // and the list of local changes of moonlight-common-c do
  assert.match(read('README.md'), /from `host-termination\.patch` of the Nightjar client \(GPL-3\.0\)\. The source files and the notices name what comes from where\./);
  assert.match(read('moonlight-common-c/src/ControlStream.c'), /from host-termination\.patch of Nightjar/);
  const controllers = read('docs/CONTROLLERS.md');
  assert.doesNotMatch(controllers, /github\.com\/LizardByte\/Sunshine/);
  assert.match(controllers, /\(https:\/\/github\.com\/SunshineStream\/Sunshine\/blob\/master\/docs\/configuration\.md\)/);
});

test('the guide describes the frame times, the arrival rate and the log lines of 2.3.2 as the code makes them', () => {
  const player = read('wasm/wasmplayer.cpp');
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  const stats = guideSection('## Performance statistics');
  // The times of a frame come from the microsecond clock, which on the TV is performance.now() of the browser
  assert.match(read('moonlight-common-c/src/Platform.c'), /uint64_t PltGetMicroseconds\(void\) \{[\s\S]*?clock_gettime\(CLOCK_MONOTONIC, &tv\);/);
  assert.match(player, /AddFrameTime\(m_ActiveWndVideoStats\.totalReassemblyTimeUs, m_ActiveWndVideoStats\.maxReassemblyTimeUs,\s+decodeUnit->receiveTimeUs, decodeUnit->enqueueTimeUs\);/);
  assert.ok(stats.indexOf('The times of a frame come from the clock of the browser of the TV, which may count in steps of about 0.1 ms, so a single time is not exact: the averages show hundredths of a millisecond and the longest times tenths') > 0);
  // The longest frame times: one line after the averages, in tenths of a millisecond, and in Last session
  assert.ok(player.indexOf('"Average rendering time: %.2f ms\\n"\n      "Longest frame times (ms): receive %.1f, wait %.1f, pacing %.1f, rendering %.1f\\n"') > 0);
  assert.ok(english['Longest frame times (ms): receive %1$s, wait %2$s, pacing %3$s, rendering %4$s']);
  const longest = tableRow('Longest frame times (ms)')[1];
  assert.ok(longest.indexOf('The longest time of a single frame in the 2 seconds at each of the four steps above: *receive*, *wait*, *pacing* and *rendering*') === 0, longest);
  // The arrival rate: right after the frame receive time, from the data packets at IP level, with its minimum
  assert.ok(player.indexOf('"Average frame receive time: %.2f ms (%.0f%% of the frame time)\\n"\n      "%s"') > 0);
  assert.ok(player.indexOf('snprintf(arrivalLine, sizeof(arrivalLine), "Frames arrive at: %u Mbps\\n", arrivalMbps);') > 0);
  assert.ok(english['Frames arrive at: %1$s Mbps']);
  const arrival = read('wasm/frame_arrival.hpp');
  assert.match(arrival, /constexpr uint32_t kFrameArrivalMinFrames = 10;/);
  assert.match(arrival, /constexpr uint64_t kFrameArrivalMinTimeUs = 20000;/);
  const queue = read('moonlight-common-c/src/RtpVideoQueue.c');
  assert.match(queue, /queue->packetOverheadBytes = \(RemoteAddr\.ss_family == AF_INET6 \? 40 : 20\) \+ 8 \+/);
  // A block that needed parity packets counts up to the one that completed it; both ends of a span are times when the
  // receive thread reads the packets (the first packet of the block, and the packet that can complete it): since 2.3.5
  // the times that the reader noted and RtpvAddPacket() is given
  assert.match(queue, /static void addFecBlockArrival\(PRTP_VIDEO_QUEUE queue, uint64_t endUs\) \{\s+if \(queue->receivedDataPackets \+ queue->receivedParityPackets > 1\) \{/);
  assert.match(queue, /queue->bufferFirstRecvTimeUs = receiveTimeUs;/);
  assert.match(queue, /arrivalEndUs = receiveTimeUs;\s+\}\s+\}\s+(\/\/.*\s+)*if \(reconstructFrame\(queue\) == 0\)/);
  assert.match(read('moonlight-common-c/src/VideoStream.c'), /RtpvAddPacket\(&rtpQueue, packet, length, \(PRTPV_QUEUE_ENTRY\)&packetBuffer\[decryptedSize\],\s+slot->receiveTimeUs\);/);
  const rate = tableRow('Frames arrive at')[1];
  ['for each frame the bytes of its data packets with their IP and UDP headers over the time from its first to its last data packet, summed over the 2 seconds',
    'Parity packets of the error correction don\'t count, unless a frame needed them to replace lost packets: then its time runs to the last parity packet it needed, so a lost packet makes the figure a little lower',
    'It is the speed at which the TV receives a frame, usually limited by the Wi-Fi of the TV',
    'neither the bitrate nor the link rate of the Wi-Fi: a TV\'s Wi-Fi module usually stays well below the link rate that the router shows for it',
    'The times are when the app reads the packets, not when they reach the TV: if the TV reads them more slowly than they come in, the figure shows that slower pace and the frame receive time rises with it, so a low figure can also mean that the TV can\'t keep up; if the app reads a backlog at once after a hold-up, the figure reads too high',
    'The line is missing when there were too few frames to tell (fewer than 10, or less than 20 ms of arrival in all, e.g. on a still desktop)']
    .forEach((text) => assert.ok(rate.indexOf(text) >= 0, text));
  // The research's figure: 8.65 ms for a frame of 4K60 at 150 Mbps over Wi-Fi come to about 275 Mbps at IP level
  // (207 data packets of 1392 bytes plus 44 bytes of headers, the first one not counted)
  assert.equal(Math.round(206 * 1436 * 8 / 8650), 274);
  assert.ok(guideSection('## Finding your bitrate').indexOf('*Frames arrive at* (since 2.3.2) gives the speed at which the TV receives a frame, e.g. about *275 Mbps* for the 8.65 ms above (computed from that measurement, not measured): usually the speed of the network path, but lower when the TV itself can\'t take the packets as fast as they come') > 0);
  // Nowhere a claim that the arrival rate can only err high: when the receive thread falls behind within a frame, it
  // reads too low (tests/native/frame_arrival_test.c)
  [read('docs/GUIDE.md'), read('CHANGELOG.md'), read('docs/PATCH_NOTES.md'), read('wasm/frame_arrival.hpp')]
    .forEach((text) => assert.doesNotMatch(text, /can only (read|be) too high/));
  assert.ok(guideSection('## Finding your bitrate').indexOf('a TV\'s Wi-Fi module usually stays well below that link rate') > 0);
  // Both lines in the report of the last session, as describeSessionReport() adds them after the frame receive time
  const diagnostics = read('wasm/platform/diagnostics.js');
  assert.match(diagnostics, /if \(report\.arrivalMbps > 0\) \{\s+lines\.push\(t\('Frames arrive at: %1\$s Mbps'/);
  assert.ok(tableRow('Last session')[1].indexOf('how fast the frames of the stream arrived (*Frames arrive at*) and the longest time of a single frame of the stream at each step (*Longest frame times (ms)*, e.g. *receive 36.0, wait 3.1, pacing 11.8, rendering 4.2*)') > 0);
  // The QoS line of each socket of a stream, which only reads the socket, and the marking that ENet asks for
  const log = guideSection('### Diagnostic log');
  const sockets = read('moonlight-common-c/src/PlatformSockets.c');
  assert.ok(sockets.indexOf('Limelog("%s socket QoS: %s%s\\n", name, priority, typeOfService);') > 0);
  assert.ok(sockets.indexOf('snprintf(priority, sizeof(priority), "priority set, ");') > 0);
  assert.match(read('moonlight-common-c/src/ControlStream.c'), /logSocketQos\(client->socket, RemoteAddr\.ss_family, "Control", SOCK_QOS_NOT_SET_HERE\);/);
  assert.match(read('moonlight-common-c/enet/unix.c'), /value = value \? \(46 << 2 \| 0x01\) : 0; \/\/ DSCP: Expedited Forwarding/);
  assert.equal((46 << 2 | 0x01).toString(16).toUpperCase(), 'B9');
  assert.ok(log.indexOf('*Video socket QoS: priority set, IP_TOS 0x00* after the receive buffer of the video socket, the same for the audio socket, and *Control socket QoS: IP_TOS 0xB9* for the control connection') > 0, log);
  // The WebAssembly line at the start of the app, as tv_profile.js writes it
  assert.match(read('wasm/platform/index.js'), /function moduleDidLoad\(\) \{[\s\S]{0,200}?logWebAssemblyFeatures\(\);/);
  let call = 0;
  const line = profile.describeWebAssemblyFeatures(profile.probeWebAssemblyFeatures({
    webAssembly: { validate: () => call++ === 2 }, tizentvwasm: null, socketHostBindingsFlag: true,
  }));
  assert.equal(line, 'WebAssembly features: SIMD 128 no, bulk memory no, threads yes, sign extension no; supportedInstructions of the TV: not offered; socket host bindings: used');
  assert.ok(log.indexOf('e.g. *' + line + '*') > 0, log);
  // Every value that the line can show for the socket host bindings and the instruction sets is explained, and the
  // line also comes when the module failed before moduleDidLoad()
  assert.match(read('wasm/platform/index.js'), /function onNativeModuleFailure\(details\) \{[\s\S]{0,400}?logWebAssemblyFeatures\(\);/);
  const values = profile.probeWebAssemblyFeatures({ webAssembly: null, tizentvwasm: null, socketHostBindingsFlag: null });
  assert.equal(values.socketHostBindings, 'not offered by the TV');
  ['*used*', '*not used*', '*offered by the TV*', '*not offered by the TV*', '*not offered*', '*unknown*', '*failed*',
    'the app already uses threads', 'e.g. when it failed to start (the line then comes with its error)']
    .forEach((text) => assert.ok(log.indexOf(text) > 0, text));
  // The QoS lines tell nothing about the marking of what the PC sends
  assert.ok(log.indexOf('The marking of what the PC sends, the picture and the sound, is set by the PC and doesn\'t show in these lines (*Prioritize sound on Wi-Fi* changes that marking, not these lines)') > 0);
});

test('the guide describes the keys of a stream as the code handles them', () => {
  // The first key of a PC keyboard locks the pointer once the stream connected, without reaching the PC; RETURN sends
  // Esc first (initSpecialKeys() in index.js), the keys of a TV never reach the PC, and the same range of key codes holds
  // in the page and in the module (isPcKeyEvent(), IsPcKeyCode())
  const section = guideSection('## Stream Menu and app menu');
  assert.ok(section.indexOf('**Keys in a stream.** The arrows and OK of the remote and the keys of a USB keyboard go to the PC. ' +
    'The first key of a stream only gives the stream the keys and doesn\'t reach the PC, so press it again; the same after Moonlight was in the background.') === 1,
  'the paragraph opens the section');
  ['RETURN sends Esc to the PC, also as the first key.', 'CH+, CH-, GREEN, BLUE and Source do nothing there.',
    'Esc, Shift, Ctrl, Alt and the Windows key can\'t be that first key and do nothing until another key gave the stream the keys.',
    'Ctrl + Alt + Shift + Q ends the stream and Ctrl + Alt + Shift + S steps the statistics, once per press; other combinations with Ctrl + Alt + Shift go to the PC ' +
    '(with an F key only if the TV passes it as one: [Input test](CONTROLLERS.md#input-test) shows 112 to 123 for F1 to F12).',
    'Ctrl + Alt + Shift with S or another key turned the keyboard off until RETURN (which sent Esc) or a click.',
    'A USB mouse gets the stream with its first click, and its wheel also scrolls sideways'].forEach((text) => {
    assert.ok(section.indexOf(text) > 0, text);
  });
  // After a command of Shut down or restart the PC from the PC list, the stream has no lock yet
  assert.ok(GUIDE.indexOf('If the first key does nothing on the PC, it gave the stream the keys (see [Stream Menu and app menu](#stream-menu-and-app-menu)): press it again. ' +
    'Avoid RETURN there: it sends Esc, which can cancel the question.') > 0);
  // Esc and the modifier keys leave the lock to the next key (their keydown is no user gesture), and a held S or Q of
  // Ctrl + Alt + Shift acts once
  const index = read('wasm/platform/index.js');
  assert.match(index, /const NO_GESTURE_KEYS = \['Escape', 'Shift', 'Control', 'Alt', 'AltGraph', 'Meta',/);
  assert.match(index, /function isPcKeyEvent\(e\) \{\s+return e\.keyCode > 0 && e\.keyCode <= 0xFF;\s+\}/);
  assert.match(index, /if \(e\.key === 'XF86Back'\) \{[\s\S]{0,200}sendEscapeKeyToHost\(\);\s+lockStreamPointer\(\);/);
  assert.match(index, /\} else if \(isStreamConnected && isPcKeyEvent\(e\)\) \{[\s\S]{0,700}if \(canKeyLockPointer\(e\)\) \{\s+lockStreamPointer\(\);\s+\}[\s\S]{0,300}e\.preventDefault\(\);\s+\}/);
  const input = read('wasm/input.cpp');
  assert.match(input, /return keyCode != 0 && keyCode <= 0xFF;/);
  assert.match(input, /if \(heldKeys\.erase\(keyCode\) == 0\) \{\s+return EM_TRUE;\s+\}/);
  assert.match(input, /if \(!event\.repeat\) \{\s+stopStream\(\);\s+\}/);
  // Run, left open with the command, would get Enter from the second OK of the next stream
  assert.ok(GUIDE.indexOf('press RETURN (Esc) in the next stream before anything else, since OK would run the command from its second press.') > 0);
  // The horizontal wheel
  assert.match(input, /LiSendHighResHScrollEvent/);
});

test('the guide describes Shut down or restart the PC as menus.js does it, and the panels of the Stream Menu', () => {
  const menus = read('wasm/platform/menus.js');
  const start = GUIDE.indexOf('### Shut down or restart the PC');
  assert.ok(start > GUIDE.indexOf('## Stream Menu and app menu') && start < GUIDE.indexOf('## Finding your bitrate'), 'the section is part of the Stream Menu chapter');
  const section = GUIDE.slice(start, GUIDE.indexOf('## Finding your bitrate'));
  // The commands, the way they are typed, the waits and the cases where it can't work
  ['`shutdown /s /t 0`', '`shutdown /r /t 0`', 'Windows key + R', '2 seconds later', 'half a second later it presses Enter', 'lock screen',
    'Without `/f`', 'its app named *Desktop*', 'the countdown runs for 5 seconds', 'RETURN cancels', 'closes *Run* with Esc'].forEach((text) => {
    assert.ok(section.indexOf(text) > 0, text);
  });
  assert.ok(menus.indexOf("const PC_POWER_COMMANDS = { shutdown: 'shutdown /s /t 0', restart: 'shutdown /r /t 0' };") > 0);
  assert.ok(menus.indexOf('const PC_POWER_RUN_KEYS = [0x5B, 0x52];') > 0);
  assert.match(menus, /var PC_POWER_TYPE_DELAY_MS = 2000;[\s\S]*var PC_POWER_ENTER_DELAY_MS = 500;[\s\S]*var PC_POWER_HINT_MS = 30000;/);
  assert.match(menus, /var PC_POWER_LIST_DELAY_MS = 5000;/);
  // The troubleshooting names what keeps it from working, and the Stream Menu table the panels
  assert.ok(GUIDE.indexOf('- **Shut down or restart the PC does nothing:** the game blocks the Windows key') > 0);
  assert.ok(GUIDE.indexOf('| Shortcuts… | Opens a panel with the keys for the PC in two groups: *In the game* (Alt + Enter, Esc, Alt + F4) and *Windows* (Windows key, Alt + Tab).') > 0);
  assert.ok(GUIDE.indexOf('| Function keys… | Opens F1 to F12 as a block of keys, 4 in a row') > 0);
  assert.ok(GUIDE.indexOf('RETURN or B go back one level') > 0);
  // B goes back one level in CONTROLLERS.md as well
  assert.ok(read('docs/CONTROLLERS.md').indexOf('B back one level: from a panel such as *Shortcuts…* or *Function keys…* to the menu, from the menu to the game') > 0);
});

test('the guide describes the trust of a PC of 2.3.3 as the code does it', () => {
  const index = read('wasm/platform/index.js');
  const utils = read('wasm/static/js/utils.js');
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  // The two rows of the troubleshooting table quote the beginnings of the messages of the code
  const refused = '%1$s no longer accepts this TV: its pairing was removed or turned off on the PC. Select it in the list of PCs to pair it again.';
  const mismatch = '%1$s answers with a different key than at its pairing: another PC may have its address now, or Sunshine was set up anew on it. If the PC is asleep, wake it from its options. Otherwise try "Rescan network", and if that doesn\'t help, delete the PC and add it again.';
  assert.equal(english[refused], refused);
  assert.equal(english[mismatch], mismatch);
  assert.ok(GUIDE.indexOf('| "… no longer accepts this TV: its pairing was removed or turned off on the PC. …" | The PC answered with the key that the TV pinned at the pairing') > 0);
  assert.ok(GUIDE.indexOf('| "… answers with a different key than at its pairing: …" | The TV keeps the key of the PC from the pairing') > 0);
  // The quotes of the rows are the beginnings of the messages, right after the name of the PC
  [[refused, /\| "… (no longer accepts this TV: [^"…]+) …" \|/], [mismatch, /\| "… (answers with a different key than at its pairing:) …" \|/]].forEach(([key, row]) => {
    const quote = row.exec(GUIDE);
    assert.ok(quote, String(row));
    assert.equal(english[key].indexOf(quote[1]), '%1$s '.length, quote[1]);
  });
  // The rows say what to do: the key stays after a cancelled or failed pairing, and a PC that may sleep is woken first
  assert.ok(GUIDE.indexOf('the PC shows *Online* again at its next check, also after a pairing that you cancelled or that failed, since the TV keeps the key of the PC until a new pairing succeeds.') > 0);
  assert.ok(GUIDE.indexOf('If the PC may be asleep, wake it first with *Wake PC* in its options (OK does that too when *Always wake this PC automatically* is on)') > 0);
  assert.ok(GUIDE.indexOf('Another key at the public address of your network doesn\'t count, unless the PC was last reached there or you entered it') > 0);
  // The PC list: Unpaired for a PC that refused the TV, its own message for another key, OK names the PC
  assert.ok(GUIDE.indexOf('A paired PC that no longer accepts this TV (since 2.3.3, e.g. after *Unpair All* in Sunshine) shows *Unpaired*, and OK pairs it again with a new PIN, also while it runs a game') > 0);
  assert.ok(GUIDE.indexOf('and otherwise the message *Failed to connect to GAMING-PC …*.') > 0);
  // The 401 answer over HTTPS with the pinned key is the refusal; a mismatch of the key never marks the PC
  assert.match(utils, /var HOST_REFUSED_TV_ERROR = 'HOST_REFUSED_TV';/);
  assert.match(utils, /return this\._parseXML\(xmlStr\)\.find\('root'\)\.attr\('status_code'\) == 401;/);
  assert.match(utils, /if \(this\._isUnauthorizedAnswer\(ret\)\) \{\s+return Promise\.reject\(HOST_REFUSED_TV_ERROR\);/);
  // pair() leaves out a refused key while it pairs, and gives it back when the pairing pinned none
  assert.match(utils, /if \(!this\.paired && this\.ppkstr && this\._refusedByHost\) \{[\s\S]{0,300}this\.ppkstr = null;/);
  assert.match(utils, /if \(refusedKey && this\.ppkstr === null\) \{[\s\S]{0,250}this\.ppkstr = refusedKey;/);
  // Another key at the external address counts only where the PC was used
  assert.match(utils, /\(addr !== this\.externalIP \|\| addr === this\.address \|\| addr === this\.userEnteredAddress\)/);
  // OK on an offline PC: Wake PC with Auto WoL also for another key, else the message of another key
  assert.match(index, /if \(host\.autoWolEnabled === true\) \{\s+autoWolDialog\([\s\S]{0,500}\} else if \(host\.pinnedKeyMismatch === true\) \{/);
  // Pairing while the PC runs an app: no refusal before the request, a wrong PIN first, and an unconfirmed pairing
  // gets the general text
  assert.equal(index.indexOf('is currently in a game session'), -1);
  assert.match(index, /if \(String\(failedPairing\) === '-7'\) \{[\s\S]{0,400}\} else if \(failedPairing !== PAIRING_NOT_CONFIRMED_ERROR && nvhttpHost\.currentGame != 0\) \{/);
  // The top of the PC list for another key, and the length of the signature of the host
  assert.match(read('wasm/platform/launcher.js'), /const keyMismatch = state === 'offline' && host\.pinnedKeyMismatch === true;/);
  assert.match(read('libgamestream/pairing.c'), /#define PAIRING_SIGNATURE_MAX_BYTES 512/);
});

test('the guide describes the app list of 2.3.3 as the code does it', () => {
  const index = read('wasm/platform/index.js');
  const utils = read('wasm/static/js/utils.js');
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  // A running app that the list doesn't have: the list is read once more, the questions name the PC, the quit goes out
  assert.ok(GUIDE.indexOf('When the PC runs an app that the list doesn\'t show, e.g. one added on the PC since, the app reads the list once more; ' +
    'for an app that still isn\'t there the questions name the PC instead (*Another app is running on GAMING-PC …*, *… the app that is running on GAMING-PC?*), ' +
    'and *Quit app on the PC* quits it as well') > 0);
  // The quoted beginnings and ends are those of the two questions
  assert.equal(english['Another app is running on %1$s. Would you like to quit it and start %2$s?'].indexOf('Another app is running on %1$s'), 0);
  assert.ok(/the app that is running on %1\$s\? /.test(english['Are you sure you want to quit the app that is running on %1$s? All unsaved data will be lost.']));
  // A question or a list built again that waited for the PC is dropped after RETURN to the PC list (the visit of the
  // app list at the press, appListVisitOf())
  assert.ok(GUIDE.indexOf('A question or a list built again that waited for the PC is dropped when you went back to the PC list meanwhile.') > 0);
  assert.match(index, /var pressVisit = isRestart \? null : appListVisitOf\(host\);/);
  // So is what follows a quit after RETURN: the quit (stopGame()) builds the list and calls back only in the visit of
  // the press, and the start after Yes changes the view and starts the other app only then
  assert.ok(GUIDE.indexOf('So is what follows a quit: when you press RETURN while the PC still quits a game (which can take several seconds), ' +
    'the quit goes on, but the PC list stays and the other app doesn\'t start (since 2.3.3; before, the app list came back and the app started).') > 0);
  assert.match(index, /function stopGame\(host, callbackFunction, pressVisit\) \{/);
  assert.match(index, /var showAppsAfterQuit = function\(quitSucceeded, refusalSaid\) \{\s+if \(pressVisit !== undefined && pressVisit !== null && !isAppListVisitShown\(host, pressVisit\)\) \{/);
  assert.match(index, /if \(!isPressListShown\(\)\) \{[\s\S]{0,250}return;\s+\}\s+startGame\(host, appID\);/);
  assert.match(index, /\}, pressVisit\);/);
  assert.match(index, /appListVisit\+\+;/);
  assert.match(index, /function findHostApp\(host, appId\) \{\s+var isCached = !!host\._memCachedApplist;/);
  assert.ok(english['Are you sure you want to quit the app that is running on %1$s? All unsaved data will be lost.']);
  assert.ok(english['Another app is running on %1$s. Would you like to quit it and start %2$s?']);
  assert.match(index, /findHostApp\(host, host\.currentGame\)\.then\(quit, function\(failedGetApp\) \{[\s\S]{0,300}quit\(null\);/);
  // Refresh apps: only for a paired PC that is online, and it says how it went
  assert.ok(GUIDE.indexOf('*Refresh apps* (for a paired PC that is online; it then says how many apps the PC lists, or that the list couldn\'t be read ' +
    'and what to check, or that the PC no longer accepts this TV, which then shows it *Unpaired* at once)') > 0);
  assert.ok(english['The app list of %1$s couldn\'t be read. Make sure that Sunshine (or another GameStream host) is running on the PC, then try again.']);
  // The 401 answer of the list marks the PC as not paired, as a poll does
  assert.match(utils, /if \(this\.ppkstr && \$root\.attr\('status_code'\) == 401\) \{[\s\S]{0,200}this\.markRefusedByHost\(\);[\s\S]{0,80}return Promise\.reject\(HOST_REFUSED_TV_ERROR\);/);
  assert.ok(GUIDE.indexOf('also right after its app list or *Refresh apps* got this answer') > 0);
  // Right after: both draw the card of the PC again at once, before the next check of the PC list
  assert.match(index, /if \(failedAppList === HOST_REFUSED_TV_ERROR\) \{\s+updateHostStatusIndicator\(host\);/);
  assert.match(index, /if \(failed === HOST_REFUSED_TV_ERROR\) \{\s+updateHostStatusIndicator\(host\);/);
  assert.match(index, /function refreshHostApps\(host\) \{/);
  assert.match(index, /id: 'refreshApps-' \+ host\.hostname,[\s\S]{0,120}shown: host\.online === true && host\.paired === true,/);
  assert.ok(english['The app list of %1$s is up to date: %2$s.']);
  // An error answer of the PC is a list that couldn't be read, not an empty list
  assert.equal(utils.indexOf('// TODO: Bubble up an error here'), -1);
  assert.match(utils, /return Promise\.reject\('The app list was answered with status ' \+ \$root\.attr\('status_code'\)\);/);
  // The box art of the same PC shows at once; no PC is polled during a stream
  assert.ok(GUIDE.indexOf('The box art that already showed shows at once when you return to the same PC, e.g. after a stream, unless the apps of ' +
    'another PC were open in between or *Refresh apps* ran (since 2.3.3).') > 0);
  assert.match(index, /var appGridBoxArt = \{ serverUid: null, urls: \{\} \};/);
  const showStreamMode = index.slice(index.indexOf('function showStreamMode() {'), index.indexOf('\n}\n', index.indexOf('function showStreamMode() {')));
  assert.match(showStreamMode, /isInGame = true;[\s\S]{0,300}stopPollingHosts\(\);/);
  // An empty list or one that couldn't be read says why at the top; the hint of the app options only with apps
  assert.ok(GUIDE.indexOf('A PC without apps shows *No apps yet* with what to do, and a list that couldn\'t be read says so at the top of the screen, ' +
    'with what to do: RETURN, then open the PC again, which reads its list again; the hint for the app options shows only while there are apps.') > 0);
  assert.ok(english['The app list of this PC couldn\'t be read. Go back with RETURN and open the PC to try again.']);
  assert.match(index, /\$\('#appMenuHint'\)\.toggle\(\$\('#game-grid \.game-container'\)\.length > 0\);/);
  assert.match(index, /if \(!isDialogOpen && \(Navigation\.isCurrent\(Views\.Apps\) \|\| Navigation\.isCurrent\(Views\.AppsNav\)\)\) \{/);
  // The start screen of an app without box art shows the gamepad of its tile
  assert.ok(GUIDE.indexOf('**Start of a stream.** The box art of the app (the gamepad picture of a tile without box art)') === GUIDE.indexOf('**Start of a stream.**'));
  const launcher = read('wasm/platform/launcher.js');
  const prepareStart = launcher.slice(launcher.indexOf('prepareStart: function('), launcher.indexOf('refresh: function('));
  assert.ok(prepareStart.indexOf("overlineKey ? 'static/res/placeholder_game.svg' : 'static/res/placeholder_error.svg'") > 0);
  // The two new rows of the troubleshooting table
  assert.ok(GUIDE.indexOf('| "The app is still running on …, probably because another device started it." | The same for an app that the app list doesn\'t show.') > 0);
  assert.ok(GUIDE.indexOf('| "The selected app is no longer available on this PC. Showing the current app list." | The app was removed or renamed on the PC') > 0);
});

test('the guide says how long a message shows and where the Stream Menu and the messages go beside the statistics, as the code does', () => {
  const index = read('wasm/platform/index.js');
  // How long: from 5 to 15 seconds by the length of the text, short messages (snackbarLog(): confirmations, but also
  // "Failed to launch …" after a failed start request) 2.5 seconds, a dialog until it is closed; one at a time (the
  // queue of the snackbar of MDL); and the log keeps the English text of most messages (snackbarLog() and
  // snackbarLogLong() log the key with its values; a few callers pass a text that is translated already, e.g. the
  // notice of an Apollo host that ended the running app)
  assert.ok(guideSection('## Troubleshooting').indexOf('A message at the bottom of the screen shows for 5 to 15 seconds, depending on its ' +
    'length (short messages, e.g. a confirmation or "Failed to launch …", 2.5 seconds), and one in a dialog until you close it. ' +
    'Messages at the bottom show one at a time, so one that comes meanwhile waits for those before it, after a change of a video ' +
    'setting with several warnings up to about a minute. The [diagnostic log](#diagnostic-log) keeps the English text of most ' +
    'messages.') > 0);
  assert.match(index, /snackbarLog\('Failed to launch %1\$s', appToStart\.title\);/);
  assert.match(index, /const SNACKBAR_LONG_MIN_MS = 5000;/);
  assert.match(index, /const SNACKBAR_LONG_MAX_MS = 15000;/);
  assert.match(index, /function snackbarLog\(\.\.\.args\) \{\s+const translatedMessage = t\(\.\.\.args\);\s+console\.log\('%c\[index\.js, snackbarLog\]', 'color: green;', \.\.\.args\);\s+showSnackbarMessage\(translatedMessage, 2500\);/);
  assert.match(index, /function snackbarLogLong\(\.\.\.args\) \{\s+const translatedMessage = t\(\.\.\.args\);\s+console\.log\('%c\[index\.js, snackbarLogLong\]', 'color: green;', \.\.\.args\);/);
  // The Stream Menu on the left while the setting names a right corner, also with the statistics off
  assert.ok(guideSection('## Stream Menu and app menu').indexOf('to open the Stream Menu on the right of the picture, or on the left while ' +
    '*Statistics position* is a right corner (see [Performance statistics](#performance-statistics)), inside the safe area of the screen.') > 0);
  assert.ok(guideSection('## Performance statistics').indexOf('at the top right the connection warnings move to the top left, in a right corner ' +
    'the Stream Menu opens on the left, and in a bottom corner messages show beside the full statistics or above the compact line)') > 0);
  assert.match(index, /\$\('#streamMenuOverlay'\)\.toggleClass\('is-left', chosenPosition === 'top-right' \|\| chosenPosition === 'bottom-right'\)/);
  // The place of a message: beside the full statistics in a bottom corner, above the compact line, otherwise the middle.
  // While the statistics are empty or hidden (before their first figures, after a step of the level, or off), the level
  // of the setting once the module started the session of the stream, and the middle before it.
  const app = loadPlatformScripts(INDEX_SCRIPTS, { tv: { tv: 's90c', conn: 'wifi' } });
  const place = (inGame, classes, options) => {
    const opts = options || {};
    const overlay = { firstChild: opts.empty ? null : {}, classList: { contains: (name) => classes.indexOf(name) >= 0 } };
    app.context.document.getElementById = (id) => (id === 'performance-stats' ? overlay : null);
    app.context.getComputedStyle = () => ({ display: opts.hidden ? 'none' : 'block' });
    app.run('isInGame = ' + inGame + '; wasmSessionStarted = ' + !!opts.session + '; getPerformanceStatsLevel = function() { return ' +
      (opts.level || 0) + '; };');
    return app.get('getSnackbarPlace')();
  };
  assert.equal(place(true, ['stats-bottom-left', 'is-compact']), 'raised');
  assert.equal(place(true, ['stats-bottom-right', 'is-compact']), 'raised');
  assert.equal(place(true, ['stats-bottom-left']), 'right');
  assert.equal(place(true, ['stats-bottom-right']), 'left');
  assert.equal(place(true, ['stats-top-left']), '');
  assert.equal(place(true, ['stats-top-right', 'is-compact']), '');
  assert.equal(place(false, ['stats-bottom-left']), '');
  // The statistics that show win over the setting
  assert.equal(place(true, ['stats-bottom-left'], { session: true, level: 1 }), 'right');
  // Empty or hidden statistics in a bottom corner: the level that is about to show once the session started
  for (const state of [{ empty: true }, { hidden: true }, { empty: true, hidden: true }]) {
    const where = JSON.stringify(state);
    assert.equal(place(true, ['stats-bottom-left'], Object.assign({ session: true, level: 2 }, state)), 'right', where);
    assert.equal(place(true, ['stats-bottom-right'], Object.assign({ session: true, level: 2 }, state)), 'left', where);
    assert.equal(place(true, ['stats-bottom-right', 'is-compact'], Object.assign({ session: true, level: 1 }, state)), 'raised', where);
    assert.equal(place(true, ['stats-bottom-left'], Object.assign({ session: true, level: 1 }, state)), 'raised', where);
    // Off, before the session (e.g. Failed to launch while isInGame is still true), in a top corner, after the stream
    assert.equal(place(true, ['stats-bottom-left'], Object.assign({ session: true, level: 0 }, state)), '', where);
    assert.equal(place(true, ['stats-bottom-left'], Object.assign({ session: false, level: 2 }, state)), '', where);
    assert.equal(place(true, ['stats-top-left'], Object.assign({ session: true, level: 2 }, state)), '', where);
    assert.equal(place(false, ['stats-bottom-left'], Object.assign({ session: true, level: 2 }, state)), '', where);
  }
  // The connection warning gets its surface from the stylesheet alone: no code sets an inline background on it (it
  // would beat the stylesheet for the rest of the stream), also not the start, the retry or the reconnect of a stream
  const messages = read('wasm/platform/messages.js');
  assert.doesNotMatch(index + messages, /#connection-warnings[^;\n]*\.css\(\s*\{?\s*['"]?background/);
  for (const name of ['startGame', 'retryStreamStart', 'resumeStreamAfterSettingsChange']) {
    const start = index.indexOf('function ' + name + '(');
    const body = index.slice(start, index.indexOf('\n}\n', start));
    assert.ok(start > 0 && body.indexOf("$('#connection-warnings, #performance-stats').text('');") > 0, name);
  }
});

// A format of C with its conversions replaced by the given values in order, without its line break
function formatC(format, values) {
  let index = 0;
  return format.replace(/\\n$/, '').replace(/%%|%(?:\.2f|02u|llu|u|d|s)/g, (conversion) => {
    if (conversion === '%%') {
      return '%';
    }
    assert.ok(index < values.length, 'a value for ' + conversion);
    return String(values[index++]);
  });
}

test('the guide describes the video receive lines of 2.3.4 as the code makes them', () => {
  const video = read('moonlight-common-c/src/VideoStream.c');
  const player = read('wasm/wasmplayer.cpp');
  const log = guideSection('### Diagnostic log');
  const timeoutMs = Number(/^#define UDP_RECV_POLL_TIMEOUT_MS (\d+)$/m.exec(read('moonlight-common-c/src/Limelight-internal.h'))[1]);
  const sampleEvery = Number(/^#define VIDEO_RECV_SAMPLE_EVERY (\d+)$/m.exec(video)[1]);
  const intervalUs = Number(/^#define VIDEO_RECV_LINE_INTERVAL_US (\d+)ULL$/m.exec(video)[1]);
  assert.equal(timeoutMs, 100);
  assert.equal(sampleEvery, 64);
  assert.equal(intervalUs, 60 * 1000 * 1000);
  // The three modes, as the receive thread logs them
  const formatOf = (source, pattern) => {
    const match = pattern.exec(source);
    assert.ok(match, String(pattern));
    return match[1];
  };
  const timeoutMode = formatC(formatOf(video, /Limelog\("(Video receive mode: one recvfrom\(\)[^"]*)",\s+UDP_RECV_POLL_TIMEOUT_MS\);/), [timeoutMs]);
  const noWaitMode = formatC(formatOf(video, /Limelog\("(Video receive mode: no receive timeout, socket that never waits[^"]*)"\);/), []);
  const pollMode = formatC(formatOf(video, /Limelog\("(Video receive mode: no receive timeout, poll\(\)[^"]*)"\);/), []);
  assert.equal(timeoutMode, 'Video receive mode: one recvfrom() per packet with a receive timeout of 100 ms; back-to-back reads off (not needed)');
  assert.ok(log.indexOf('At the start, *' + timeoutMode + '* on a TV whose sockets take a receive timeout') > 0, log);
  assert.ok(log.indexOf('*' + noWaitMode + '* on a TV whose sockets take none') > 0);
  const pollEnd = 'poll() before each recvfrom(); back-to-back reads off (no socket that never waits)';
  assert.ok(pollMode.endsWith(pollEnd), pollMode);
  assert.ok(log.indexOf('*… ' + pollEnd + '* means that such a socket couldn\'t be made') > 0);
  // On a TV without a receive timeout the second socket logs its receive buffer and QoS lines too, as bindUdpSocket()
  // does, since both share one body
  assert.match(read('moonlight-common-c/src/PlatformSockets.c'), /SOCKET bindUdpSocketNoWait\([^)]*\) \{\n#ifdef SOCK_NONBLOCK\n    return bindUdpSocketOfType\(/);
  assert.ok(log.indexOf('On such a TV the lines of the receive buffer and the QoS of the video socket come twice: the second set is that of the socket the stream uses') > 0);
  // The line of a minute and the one of the stream, with the example of the guide built from the format of the code
  const minute = formatOf(video, /Limelog\("(Video receive, last %u s: [^"]*)",/);
  assert.ok(log.indexOf('Once a minute while the picture comes, *' + formatC(minute.slice(0, minute.indexOf(': ') + 2), [intervalUs / 1000000]) + '…*') > 0);
  const stream = formatOf(video, /Limelog\("(Video receive of the stream, %u s: [^"]*)",/);
  const example = formatC(stream, [312, 4973512, '1.00', '91', '3.2', '28.5', '362', '0.4']);
  assert.equal(example, 'Video receive of the stream, 312 s: 4973512 packets, 1.00 socket calls each, 91% were waiting; 3.2 us to read a waiting packet, 28.5 us of other work per packet: up to 362 Mbps; clock read 0.4 us');
  assert.ok(log.indexOf('e.g. *' + example + '* (an example, not a measurement)') > 0);
  // A pause adds a call per 100 ms, two with back-to-back reads (an empty read and the poll()), and the poll() of a sample
  // is counted apart
  const sockets = read('moonlight-common-c/src/PlatformSockets.c');
  assert.match(video, /figures\.socketCalls \+= \(useSelect && err > 0\) \? 2 : 1;/);
  assert.match(sockets, /\(\*socketCalls\)\+\+;\s+err = \(int\)recvfrom\(s, buffer, size, 0, NULL, NULL\);/);
  assert.match(sockets, /\(\*socketCalls\)\+\+;\s+err = pollSockets\(&pfd, 1, timeoutMs\);/);
  assert.match(video, /figures\.checkPolls\+\+;/);
  // The gaps of the samples, from VIDEO_RECV_SAMPLE_EVERY - 16 to VIDEO_RECV_SAMPLE_EVERY + 15
  assert.match(video, /return VIDEO_RECV_SAMPLE_EVERY - 16 \+ \(\*state >> 27\);/);
  ['the socket calls per packet (each ' + timeoutMs + ' ms without a packet adds one, two with back-to-back reads; the poll() of the check below isn\'t counted)',
    'The app checks about every ' + sampleEvery + 'th read, at gaps that vary from ' + (sampleEvery - 16) + ' to ' + (sampleEvery + 15) + ' reads so that it doesn\'t keep checking the same packet of frames of one size: it asks the socket with poll() whether a packet is waiting (with back-to-back reads every read tells it) and reads the clock around it, which may count in steps of 0.1 ms',
    'without the time of the clock reads themselves (*clock read*). *n/a* means there was nothing to measure.',
    'counted like *Frames arrive at*']
    .forEach((text) => assert.ok(log.indexOf(text) > 0, text));
  // The lines of the poll() calls of the samples, only where the socket isn't read back to back
  const check = formatOf(video, /Limelog\("(Video receive check of the stream: [^"]*)",/);
  const checkFailed = formatOf(video, /Limelog\("(Video receive check: poll\(\) without a timeout failed: )%d\\n", pollError\);/);
  assert.match(video, /if \(sampled && receiveMode != VIDEO_RECV_MODE_NO_WAIT\) \{/);
  assert.ok(log.indexOf('Without back-to-back reads, a last line counts these poll() calls, the only socket calls that the check adds, e.g. *' + formatC(check, [4870, '2.1', 0]) + '*: their time is also what a poll() costs on the TV.') > 0);
  assert.ok(log.indexOf('If they fail, *' + checkFailed + '…* comes once with the error, and the share of waiting packets shows *n/a*.') > 0);
  // The line of the frame receive time of the app, with the figures of Last session
  const frame = formatOf(player, /ClLogMessage\("(Frame receive of the stream: [^"]*frames arrive at %u Mbps)\\n",/);
  assert.ok(log.indexOf('After it, *' + formatC(frame, [10, '52', 276]) + '*: the *Average frame receive time* and *Frames arrive at* of the stream, as *Last session* in System information gives them') > 0);
  assert.match(player, /report\.receiveTimeX100 = AverageUsX100\(totals\.totalReassemblyTimeUs, totals\.decodedFrames\);/);
  // How to read them: the two readings and their thresholds
  ['To read them, compare *up to* with *Frames arrive at*. Not more than about a quarter above it (or below it), with 80 % or more of the packets waiting: the app reads as fast as it can',
    'At least twice *Frames arrive at*, or fewer than half of the packets waiting: the app waits for the packets, so the network sets the receive time',
    'Many waiting packets alone don\'t decide it, since Wi-Fi hands packets over in bursts.',
    // The parity packets of a block that arrived whole cost the queue little and don't count for the rate of the frames
    'A high share of error correction (FEC) raises *up to* by up to about that share, since its extra packets cost the app little and *Frames arrive at* leaves them out.']
    .forEach((text) => assert.ok(log.indexOf(text) > 0, text));
  // The pointers of the guide to them: above 150 Mbps and in the troubleshooting
  assert.ok(guideSection('### Above 150 Mbps').indexOf('Whether the app or the Wi-Fi of the TV sets that pace, the lines *Video receive …* of the [diagnostic log](#diagnostic-log) tell after a stream (since 2.3.4).') > 0);
  const trouble = GUIDE.split('\n').find((line) => line.indexOf('- **A long frame receive time at a high bitrate, e.g. 10 ms at 180 Mbps over Wi-Fi:**') === 0);
  assert.ok(trouble, 'the troubleshooting bullet');
  assert.ok(trouble.indexOf('read *Video receive of the stream* and *Frame receive of the stream* at the end of the [diagnostic log](#diagnostic-log)') > 0);
  // The texts of the guide are the start of the lines of the code
  assert.ok(stream.indexOf('Video receive of the stream') === 0 && frame.indexOf('Frame receive of the stream') === 0);
});

test('the guide describes the two threads of the video receive and the processing lines of 2.3.5 as the code makes them', () => {
  const video = read('moonlight-common-c/src/VideoStream.c');
  const ring = read('moonlight-common-c/src/VideoReceiveRing.h');
  const log = guideSection('### Diagnostic log');
  const ringPackets = Number(/\n#ifndef VIDEO_RECV_RING_PACKETS\n#define VIDEO_RECV_RING_PACKETS (\d+)\n#endif\n/.exec(video)[1]);
  assert.equal(ringPackets, 1024);
  const formatOf = (pattern) => {
    const match = pattern.exec(video);
    assert.ok(match, String(pattern));
    return match[1];
  };
  // The reader: its other work is noting the time and handing the packet over, a wait for room doesn't count, and its
  // rate counts one clock read per packet
  assert.match(video, /figures\.workUs \+= nowUs - workStartUs - workWaitedUs;/);
  assert.match(video, /\* 8 \/\s+\(readUs \+ workUs \+ clockUs\);/);
  ['and of everything else the reading thread does for a packet until it reads the next one (since 2.3.5 it only notes the time and hands the packet to a second thread; a wait for room between them doesn\'t count here); and from these, with one clock read per packet, the speed at which the reading thread could take packets that are waiting, counted like *Frames arrive at*.']
    .forEach((text) => assert.ok(log.indexOf(text) > 0, text));
  // The processing thread: its lines once a minute and at the end, the example built from the format of the code
  const process = formatOf(/Limelog\("(Video processing of the stream, %u s: [^"]*)\\n",/);
  const minute = formatOf(/Limelog\("(Video processing, last %u s: [^"]*)\\n",/);
  assert.ok(minute.indexOf('Video processing, last ') === 0);
  assert.match(video, /if \(nowUs - windowStartUs >= VIDEO_RECV_LINE_INTERVAL_US\) \{\s+if \(figures\.packets > windowStart\.packets\) \{\s+logVideoProcessFigures\(/);
  const example = formatC(process, [312, 4973512, '14.2', '61', '809', 212, ringPackets, 0, 0, 2240]);
  assert.equal(example, 'Video processing of the stream, 312 s: 4973512 packets, 14.2 us of work each, idle 61%: up to 809 Mbps; ring up to 212 of 1024 packets, full 0 times for 0 ms; 2240 wakes');
  assert.ok(log.indexOf('Since 2.3.5 a second thread does the work on the packets that the first one reads, with a ring of ' + ringPackets + ' packets between them. Its lines come once a minute and at the end, e.g. *' + example + '* (an example, not a measurement)') > 0);
  // No packet is dropped: a reader that finds the ring full waits for room
  assert.match(ring, /while \(ring->head - ring->tail == ring->slotCount && !ring->stopped\) \{\s+ring->readerWaiting = true;\s+PltWaitForConditionVariable\(&ring->roomCond, &ring->mutex\);/);
  assert.doesNotMatch(ring.replace(/\/\/.*$/gm, ''), /drop/i);
  // The wakes are those of a waiting processing thread by the reader
  assert.match(ring, /if \(ring->processorWaiting\) \{\s+ring->processorWaiting = false;\s+ring->figures\.wakes\+\+;\s+PltSignalConditionVariable\(&ring->packetsCond\);/);
  ['the packets it took (as many as the reading thread read, unless some were left at the end), its time per packet (error correction, decryption, putting the frame together at its last packet), the share of the time it had nothing to do, the speed at which it could take packets, counted like *Frames arrive at*',
    'then the most packets that waited in the ring, how often the ring was full and for how long the reading thread waited for room (no packet is dropped: they wait in the receive buffer of the TV), and how often the reading thread had to wake it.',
    'With two threads (since 2.3.5), the slower of the two sets the pace: compare the lower of the two *up to* with *Frames arrive at*. A ring that was *full* means the second thread was the limit at those times; a high *idle* share means it keeps up.']
    .forEach((text) => assert.ok(log.indexOf(text) > 0, text));
  // The rows of the statistics stay true: the times are still when the app reads the packets (the reader notes them)
  assert.ok(tableRow('Frames arrive at')[1].indexOf('The times are when the app reads the packets, not when they reach the TV') >= 0);
  assert.match(video, /stampUs = PltGetMicroseconds\(\);/);
});

test('the guide and the controller page describe the keys in the menus of 2.3.5 as the code handles them', () => {
  const remote = read('wasm/platform/remote_controller.js');
  const navigation = read('wasm/platform/navigation.js');
  const index = read('wasm/platform/index.js');
  const menus = read('wasm/platform/menus.js');
  const controllers = read('docs/CONTROLLERS.md');
  // Esc is RETURN, without its own action, and the auto-repeat of RETURN goes back no further; CH+ once per press
  assert.ok(GUIDE.indexOf('**Keys in the menus.** Esc of a USB keyboard works as RETURN (since 2.3.5;') > 0);
  assert.match(remote, /case KEY_ESCAPE:[\s\S]{0,700}e\.preventDefault\(\);\s+\/\/ falls through\s+case tvKey\.KEY_RETURN:/);
  assert.match(remote, /\/\/ the PC list and on to Exit Moonlight, which could stay open with Exit selected \(before 2\.3\.5\)\s+if \(e\.repeat\) \{\s+break;\s+\}\s+\/\/ Go back or cancel the operation\s+Navigation\.back\(\);/);
  assert.ok(GUIDE.indexOf('A held RETURN goes back one level (before 2.3.5 it went on through the levels to *Exit Moonlight*), and CH+ acts once per press.') > 0);
  assert.match(remote, /case tvKey\.KEY_CHANNEL_UP:[\s\S]{0,300}if \(e\.repeat\) \{\s+break;\s+\}\s+Navigation\.press\(\);/);
  // The no longer dispatched Escape of the drop-downs
  assert.equal(navigation.indexOf("new KeyboardEvent('keydown'"), -1);
  // The address field of Add PC: Enter and Done (65376) accept, Cancel (65385) goes back
  assert.ok(GUIDE.indexOf('Enter of a keyboard or *Done* of the keyboard of the TV ends the address and selects *Continue*, *Cancel* of the keyboard of the TV only closes the field, and LEFT and RIGHT move in the text') > 0);
  assert.match(remote, /const KEY_IME_DONE = 65376;\s+const KEY_IME_CANCEL = 65385;/);
  assert.match(navigation, /if \(currentItem === 'ipAddressTextInput' && isIpTextFieldEditing\(\)\) \{[\s\S]{0,500}handleIpTextFieldState\(false\);\s+focusElement\(this\.view\.select\(this\.view\.func\(\)\.indexOf\('continueAddHost'\)\)\);\s+Navigation\.guardAccept\(this\);/);
  // The menu of a PC closes with the key that opened it
  assert.ok(GUIDE.indexOf('since 2.3.5 the key that opened it closes it again, as in the app menu.') > 0);
  assert.match(navigation, /HostMenuDialog: \{[\s\S]{0,1200}press: function\(\) \{[\s\S]{0,200}resolveElement\('closeHostMenu'\)\.click\(\);/);
  // RIGHT opens a section, LEFT goes back in each of the 7 sections
  assert.ok(GUIDE.indexOf('RIGHT opens the selected section like OK, and LEFT in a section goes back to the list of sections like RETURN (since 2.3.5)') > 0);
  ['BasicSettings', 'InterfaceSettings', 'InputSettings', 'AudioSettings', 'VideoSettings', 'AdvancedSettings', 'AboutSettings'].forEach((view) => {
    const start = navigation.indexOf('\n  ' + view + ': {');
    const end = navigation.indexOf('\n  },', start);
    assert.match(navigation.slice(start, end), /left: function\(\) \{\s+this\.back\(\);\s+\}/, view);
  });
  // B on the launch screen
  assert.ok(GUIDE.indexOf('since 2.3.5 B of a controller and Esc of a keyboard (the bottom of the launch screen names RETURN, RED and B)') > 0);
  assert.ok(controllers.indexOf('| B (Circle) | Back, like RETURN on the remote. On the launch screen *Starting…* it cancels the start like RETURN and RED (since 2.3.5;') > 0);
  assert.match(index, /if \(isInGame === true && !isStreamConnected\) \{\s+handleLaunchScreenGamepadInput\(gamepadIndex, e\.detail\.changes, now\);\s+return;\s+\}/);
  assert.match(index, /function handleLaunchScreenGamepadInput\(gamepadIndex, changes, now\) \{[\s\S]{0,200}change\.index !== 1[\s\S]{0,600}endStartingOrRunningStream\(\);/);
  assert.match(read('wasm/platform/messages.js'), /isStreamConnected = true;\s+\/\/[^\n]*\n\s+runGuarded\('stopGamepadsOfLaunchScreen'/);
  assert.match(read('wasm/index.html'), /<span class="keycap keycap-red" data-i18n="RED">RED<\/span><span class="keycap" data-i18n="B">B<\/span>/);
  // Exit and Restart open on Cancel, the restart that Restore Defaults asks for on Restart
  assert.ok(GUIDE.indexOf('and so do *Exit Moonlight*, which RETURN opens from the PC list, *Restart Moonlight* (both since 2.3.5)') > 0);
  assert.ok(GUIDE.indexOf('The restart that *Restore Defaults* asks for opens on *Restart*.') > 0);
  assert.match(index, /function exitAppDialog\(\) \{[\s\S]{0,600}pushConfirmationView\(Views\.ExitMoonlightDialog\);/);
  assert.match(index, /function restartAppDialog\(\) \{[\s\S]{0,700}pushConfirmationView\(Views\.RestartMoonlightDialog\);/);
  assert.match(index, /function requiredRestartAppDialog\(\) \{[\s\S]{0,1200}Views\.RestartMoonlightDialog\.view\.index = 0;\s+Navigation\.push\(Views\.RestartMoonlightDialog\);/);
  // Quit app on the PC in the Stream Menu asks first, in a panel of its own that opens on Cancel
  assert.ok(tableRow('Quit app on the PC')[1].indexOf('Asks first, with *Cancel* selected (since 2.3.5; before, it quit at once)') === 0);
  assert.match(menus, /const STREAM_MENU_PANELS = \{[^}]*streamMenuQuit: 'streamQuitPanel' \};/);
  assert.match(menus, /\} else if \(id === 'streamMenuDisconnect' \|\| id === 'streamQuitConfirm'\) \{[\s\S]{0,200}quitAppAfterStream = id === 'streamQuitConfirm';/);
  assert.match(read('wasm/index.html'), /<div id="streamQuitPanel"[^>]*>[\s\S]{0,600}<button type="button" id="streamQuitCancel"[\s\S]{0,400}<button type="button" id="streamQuitConfirm"/);
});

test('the guide describes the first start, the failed pairings, an unreadable app list and no sound as the code does them (2.3.5)', () => {
  const index = read('wasm/platform/index.js');
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  // A section of its own in the installation, before the part on the regular Moonlight app, listed in the contents
  const installation = GUIDE.slice(GUIDE.indexOf('\n## Installation\n'), GUIDE.indexOf('\n## The screens of the app\n'));
  assert.ok(installation.indexOf('\n### Install the file\n') < installation.indexOf('\n### First start\n') &&
    installation.indexOf('\n### First start\n') < installation.indexOf('\n### Next to the regular Moonlight app\n'), 'the order of the sections');
  assert.ok(GUIDE.indexOf('[first start](#first-start)') > 0, 'the contents list');
  const first = guideSection('### First start');
  // The search of the start: the /24 network of the TV on port 47989 (wasm/static/js/mdns-browser/main.js)
  const scanner = read('wasm/static/js/mdns-browser/main.js');
  assert.match(scanner, /Scan the \/24 subnet/);
  assert.match(scanner, /discoveredHost\.httpPort = 47989;/);
  assert.match(first, /asks every address of the \/24 network of the TV on port 47989/);
  // The empty PC list says what the search does (launcher.js)
  assert.ok(english['Moonlight finds PCs that run Sunshine (or another GameStream host) on your network. You can also add one by its address.']);
  assert.match(first, /the empty PC list says so/);
  // Add PC: four number fields by default, preset to the network of the TV, the text field for a name, an IPv6 address
  // or a port, and the PC joins the list only once it is paired
  assert.match(index, /const defaultIpAddressFieldMode = true;/);
  assert.match(index, /return \[Number\(parts\[0\]\), Number\(parts\[1\]\), Number\(parts\[2\]\), 0\];/);
  assert.equal(english['- Four number fields for an IPv4 address. Turn it off to type a name, an IPv6 address or a port.'],
    '- Four number fields for an IPv4 address. Turn it off to type a name, an IPv6 address or a port.');
  assert.match(first, /four number fields for an IPv4 address, preset to the network of the TV/);
  assert.match(first, /turn off Settings → General → \*Numeric PC address input\* first/);
  assert.match(index, /pairingDialog\(_nvhttpHost, function\(\) \{\s+\/\/ Add the host to the grid after successful pairing\s+addHostToGrid\(_nvhttpHost\);/);
  assert.match(first, /the PC joins the list once it is paired/);
  // The PIN has four digits (generatePairingPin() of utils.js), and the app list opens after the pairing (hostChosen())
  assert.match(read('wasm/static/js/utils.js'), /return String\('0000' \+ cryptoRand\(10000\)\)\.slice\(-4\);/);
  assert.match(first, /The dialog shows a PIN of four digits\./);
  assert.match(first, /The dialog closes once the PC confirms the pairing, and the app list of the PC opens\./);
  // The rows of the troubleshooting quote the texts of the app
  const troubleshooting = guideSection('## Troubleshooting');
  [['Error: Failed to pair with %1$s.<br><br>Please try pairing with the PC again.', '| "Error: Failed to pair with …" |'],
    ['Error: %1$s is currently busy!<br><br>You must stop the running app in order to pair with the PC.', '| "Error: … is currently busy! …" |'],
    ['A pairing request is currently in progress. Please wait for it to timeout or finish before trying again.', '| "A pairing request is currently in progress. …" |'],
    ['Unable to retrieve your list of apps at this time. Please refresh the list of apps or try again later!', '| "Unable to retrieve your list of apps at this time. …"'],
    ['The app list of %1$s couldn\'t be read. Make sure that Sunshine (or another GameStream host) is running on the PC, then try again.', ' or "The app list of … couldn\'t be read. …" |'],
  ].forEach(([key, row]) => {
    assert.equal(english[key], key);
    assert.ok(troubleshooting.indexOf(row) > 0, row);
  });
  // No sound at all: the backend Disabled turns it off, the Opus decoder line of the log, the line of the statistics
  assert.match(read('wasm/index.html'), /<li class="mdl-menu__item" data-value="Disabled" data-i18n="Disabled">Disabled<\/li>/);
  assert.match(troubleshooting, /- \*\*No sound at all:\*\* check Settings → Audio Settings → \*Audio backend\*: \*Disabled\* turns the sound off\./);
  assert.match(troubleshooting, /if the \[diagnostic log\]\(#diagnostic-log\) shows \*Creating the Opus decoder failed\*, choose Stereo/);
});

test('the README claims no tested surround output, and the README and the guide point owners of Tizen 5.0 TVs elsewhere (2.3.5)', () => {
  const readme = read('README.md');
  const improvements = readme.slice(readme.indexOf('## Main improvements'), readme.indexOf('## Requirements'));
  // The guide says that nobody has confirmed discrete 5.1 from the app on a TV (pinned above), so the README doesn't
  // list it as working, and it promises no 7.1, which the guide calls experimental
  assert.doesNotMatch(improvements, /5\.1 through a soundbar|7\.1/);
  assert.match(improvements, /a check of what reaches your soundbar \(5\.1 from the app is still untested on a TV\)/);
  assert.ok(improvements.indexOf('(docs/GUIDE.md#surround-sound-with-a-soundbar)') > 0);
  // The package needs Tizen 5.5 (res/config.xml); a separate community fork exists for Tizen 5.0, which this fork names
  // as such without vouching for it
  assert.match(read('res/config.xml'), /required_version="5\.5"/);
  for (const [file, text] of [['README.md', readme], ['docs/GUIDE.md', GUIDE]]) {
    assert.ok(text.indexOf('For the TVs of 2019 with Tizen 5.0, Moonlight Tizen points to [moonlight-tizen50](https://github.com/WMP/moonlight-tizen50), a separate community fork that Moonlight Plus has not tried.') > 0, file);
  }
});
