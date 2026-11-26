'use strict';

// Pins how far the sound of the TV media player runs ahead of the clock of the TV, a measurement of 2.3.1
// (wasm/audio_lead.hpp), where its parts have to agree and no native test sees all of them: the tracker is a pure header
// without a lock or an atomic, which only the audio thread of auddec.cpp feeds, on the EMSS path after the Web Audio
// backend has returned, with every packet that reached it (also those that 'Limit audio delay' skips); each start
// begins it afresh and its end hands the figures to the report through the statistics of the audio stream, which
// VidDecCleanup() takes before the message is built; the front end gives the hint the state of 'Limit audio delay'.
// Since 2.3.5 the catch-up after a stall (wasm/audio_catch_up.hpp), a pure header as well, skips the sound that piled
// up beyond its target after the player ran dry, while 'Limit audio delay' is off: 100 ms at first, the margin of the
// switch, and up to 300 ms for stalls that come again within 2 minutes; each start resets it, and the end of a stream
// logs and resets it. The packets of the EMSS path are timed by AUDDEC_PACKET_TIME() from a reading of the monotonic
// clock (AUDDEC_CLOCK_NOW(), which since 2.3.6 also starts the decode of the packet), the reading itself unless the
// native test of auddec.cpp replaces it, so no native test runs that default.
// The behaviour itself is run by tests/native/audio_lead_test.cpp (the estimator on simulated streams),
// audio_catch_up_test.cpp (the catch-up),
// audio_decoder_test.cpp (auddec.cpp), session_report_test.cpp and stats_overlay_test.cpp (the report), and
// tests/unit/diagnostics.test.js with the browser test diagnostics.test.js (the line and the hint).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The body of a C++ function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

test('the tracker is a pure header without a lock, which only the audio thread feeds on the EMSS path', () => {
  const header = read('wasm/audio_lead.hpp');
  assert.deepEqual(header.match(/^#include .*$/gm), ['#include <algorithm>', '#include <cstddef>', '#include <cstdint>',
    '#include <cstdio>']);
  assert.doesNotMatch(header.replace(/\/\/.*$/gm, ''), /mutex|atomic|PLT_|lock\(|new |malloc/);
  const decoder = read('wasm/auddec.cpp');
  assert.match(decoder, /#include "audio_lead\.hpp"/);
  // Fed twice, both in the decoder callback after the Web Audio backend returned: for a packet that 'Limit audio
  // delay' skips, and for every other one after the lead was updated
  const play = functionBody(decoder, 'void MoonlightInstance::AudDecDecodeAndPlaySample(char* sampleData, int sampleLength) {');
  const feeds = play.split('s_AudioLead.AddPacket(ntp.count(), (s_estimatedAudioEnd - ntp).count());').length - 1;
  assert.equal(feeds, 2);
  assert.equal(decoder.split('s_AudioLead.AddPacket(').length - 1, 2, 'nowhere else');
  const webAudioReturn = play.indexOf('CheckAudioLoad();\n    return;\n  }');
  const catchUp = play.indexOf('const bool catchingUp = s_AudioCatchUp.Update(ntp.count(), s_estimatedAudioEnd.count());');
  const skipped = play.indexOf('\n  if (skip) {\n');
  const update = play.indexOf('s_estimatedAudioEnd = std::max(s_estimatedAudioEnd, ntp) + s_frameDuration;');
  const feedSkipped = play.indexOf('s_AudioLead.AddPacket(');
  const feedOther = play.lastIndexOf('s_AudioLead.AddPacket(');
  assert.ok(webAudioReturn > 0 && catchUp > webAudioReturn && skipped > catchUp, 'the catch-up is updated before the skip');
  assert.ok(feedSkipped > skipped, 'the skipped packet counts');
  assert.ok(play.indexOf('return;', feedSkipped) < update && feedOther > update, 'the others count after the update');
  // Each start begins afresh, before the disabled output returns, and only the TV media player is measured
  const init = functionBody(decoder, 'int MoonlightInstance::AudDecInit(');
  assert.ok(init.indexOf('s_AudioLead.Reset(s_AudioBackend == AudioBackend::Emss ?') > 0);
  assert.ok(init.indexOf('s_AudioLead.Reset(') < init.indexOf('if (s_AudioBackend == AudioBackend::Disabled) {'));
  // The end of the stream logs it and keeps its figures, then starts it again empty, and so the catch-up after it
  const cleanup = functionBody(decoder, 'void MoonlightInstance::AudDecCleanup(void) {');
  assert.match(cleanup, /const AudioLeadSummary lead = s_AudioLead\.Finish\(\);[\s\S]*FormatAudioLeadLog\(lead, line, sizeof\(line\)\)[\s\S]*g_AudioStreamStats\.hasDrift = lead\.hasDrift;[\s\S]*s_AudioLead\.Reset\(0\.0\);\n[\s\S]*if \(s_AudioCatchUp\.skipped != 0\) \{\s+ClLogMessage\("Skipped %u audio packets \(%\.0f ms of sound\) that piled up after stalls of this stream; stalls: %u, "\s+"sound kept after a stall: up to %\.0f ms\\n",[\s\S]*s_AudioCatchUp\.target \* 1000\.0\);\s+\}\n  s_AudioCatchUp\.Reset\(\);\n\}/);
});

test('the catch-up after a stall is a pure header that the audio thread runs while Limit audio delay is off', () => {
  const header = read('wasm/audio_catch_up.hpp');
  assert.deepEqual(header.match(/^#include .*$/gm), ['#include <cstdint>']);
  assert.doesNotMatch(header.replace(/\/\/.*$/gm, ''), /mutex|atomic|PLT_|lock\(|new |malloc/);
  assert.match(header, /constexpr double kAudioCatchUpSeconds = 1\.0;/);
  // Its target starts at the margin of the switch, and stalls that come again within 2 minutes raise it up to 300 ms
  assert.match(header, /constexpr double kAudioCatchUpTargetSeconds = 0\.1;/);
  assert.match(header, /constexpr double kAudioCatchUpRepeatSeconds = 120\.0;/);
  assert.match(header, /constexpr double kAudioCatchUpMaxTargetSeconds = 0\.3;/);
  const decoder = read('wasm/auddec.cpp');
  assert.match(decoder, /#include "audio_catch_up\.hpp"/);
  assert.match(decoder, /static constexpr TimeStamp kAudioBufferMargin = 100ms;/);
  assert.match(decoder, /\nstatic AudioCatchUp s_AudioCatchUp;\n/);
  // Each start resets it with the end of the appended sound, which its first packet reads
  const init = functionBody(decoder, 'int MoonlightInstance::AudDecInit(');
  assert.match(init, /\n  s_estimatedAudioEnd = 0s;\n  s_AudioCatchUp\.Reset\(\);\n/);
  // The skip of a catch-up is counted and logged apart from the drops of the switch, and the packet still counts for
  // the lead and returns before it is decoded
  const play = functionBody(decoder, 'void MoonlightInstance::AudDecDecodeAndPlaySample(char* sampleData, int sampleLength) {');
  // The switch skips beyond its margin at all times; without it the catch-up decides (and counts), and a raise of its
  // target is logged
  const decision = play.slice(play.indexOf('  bool skip;\n'), play.indexOf('\n  if (skip) {\n'));
  assert.match(decision, /^  bool skip;\n  if \(s_AudioSyncEnabled\) \{\n    skip = ntp \+ kAudioBufferMargin < s_estimatedAudioEnd;\n  \} else \{\n    const double targetBefore = s_AudioCatchUp\.target;\n    skip = catchingUp && s_AudioCatchUp\.Skips\(ntp\.count\(\), s_estimatedAudioEnd\.count\(\)\);\n[\s\S]*if \(s_AudioCatchUp\.target != targetBefore\) \{\s+ClLogMessage\("Another stall within %u minutes: the sound kept after a stall rises from %\.0f to %\.0f ms, "/);
  const branch = play.slice(play.indexOf('\n  if (skip) {\n'), play.indexOf('DecodeAndAppendPacket('));
  assert.match(branch, /if \(s_AudioSyncEnabled\) \{[\s\S]*\+\+s_DroppedPackets % 100 == 1[\s\S]*\} else \{\s+\/\/[^\n]*\n\s+if \(s_AudioCatchUp\.skipped % 100 == 1\) \{\s+ClLogMessage\("Skipping the sound that piled up after a stall beyond %\.0f ms: %u packets of this stream, "\s+"stalls: %u, /);
  assert.match(branch, /s_AudioLead\.AddPacket\(ntp\.count\(\), \(s_estimatedAudioEnd - ntp\)\.count\(\)\);\s+return;\s+\}\n\n\s+\/\/ Decode and append the audio packet to the audio track[^\n]*\n(?:\s+\/\/[^\n]*\n)*\s+const bool appended = $/);
  assert.equal(decoder.split('s_AudioCatchUp.Update(').length - 1, 1);
  assert.equal(decoder.split('s_AudioCatchUp.Skips(').length - 1, 1);
  // The clock of the packets: the monotonic clock of the TV, which only the native test of auddec.cpp replaces, read
  // once per packet (since 2.3.6 the same reading starts its decode, see tests/native/audio_decoder_test.cpp)
  assert.match(decoder, /\n#ifndef AUDDEC_CLOCK_NOW\n#define AUDDEC_CLOCK_NOW\(\) std::chrono::steady_clock::now\(\)\n#endif\n/);
  assert.match(decoder, /\n#ifndef AUDDEC_PACKET_TIME\n#define AUDDEC_PACKET_TIME\(reading\) \(reading\)\n#endif\n/);
  assert.match(play, /\n    s_firstAppend = AUDDEC_PACKET_TIME\(AUDDEC_CLOCK_NOW\(\)\);\n/);
  assert.match(play, /\n  const auto arrival = AUDDEC_CLOCK_NOW\(\);\n  bool lineLogged = false;\n  auto now = AUDDEC_PACKET_TIME\(arrival\);\n  TimeStamp ntp = now - s_firstAppend;\n/);
  assert.equal(decoder.split('AUDDEC_PACKET_TIME').length - 1, 4, 'the definition and the two times of the EMSS path only');
  // Every reading of the clock of the audio thread goes through the seam
  assert.equal(decoder.split('steady_clock::now()').length - 1, 1, 'only in the definition of AUDDEC_CLOCK_NOW()');
});

test('the report takes the figures that the audio stream left, and the hint knows whether Limit audio delay was on', () => {
  const stats = read('wasm/audio_stream_stats.hpp');
  const reset = stats.slice(stats.indexOf('void Reset(int channels'), stats.indexOf('channelCount = channels;'));
  ['leadMs = 0;', 'leadEndMs = 0;', 'leadMaxMs = 0;', 'hasDrift = false;', 'driftMsPerHour = 0;'].forEach((line) => {
    assert.ok(reset.indexOf(line) > 0, line);
  });
  const player = read('wasm/wasmplayer.cpp');
  const cleanup = functionBody(player, 'void MoonlightInstance::VidDecCleanup(void) {');
  const message = cleanup.indexOf('const std::string reportMessage = FormatSessionReportMessage(report);');
  ['report.audioLeadMs = g_AudioStreamStats.leadMs.exchange(0);', 'report.audioLeadEndMs = g_AudioStreamStats.leadEndMs.exchange(0);',
    'report.audioLeadMaxMs = g_AudioStreamStats.leadMaxMs.exchange(0);', 'report.hasAudioDrift = g_AudioStreamStats.hasDrift.exchange(false);',
    'report.audioDriftMsPerHour = g_AudioStreamStats.driftMsPerHour.exchange(0);'].forEach((line) => {
    const at = cleanup.indexOf(line);
    assert.ok(at > 0 && at < message, line);
  });
  const index = read('wasm/platform/index.js');
  const keep = functionBody(index, 'function keepSessionReport(json) {');
  assert.match(keep, /audioSync: \$\('#audioSyncSwitch'\)\.parent\(\)\.hasClass\('is-checked'\)/);
  const diagnostics = read('wasm/platform/diagnostics.js');
  assert.match(diagnostics, /const AUDIO_DRIFT_HINT_MS_PER_HOUR = 50;/);
  assert.match(diagnostics, /!\(options && options\.audioSync\)/);
});
