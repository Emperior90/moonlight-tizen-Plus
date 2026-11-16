'use strict';

// Pins how far the sound of the TV media player runs ahead of the clock of the TV, a measurement of 2.3.1
// (wasm/audio_lead.hpp), where its parts have to agree and no native test sees all of them: the tracker is a pure header
// without a lock or an atomic, which only the audio thread of auddec.cpp feeds, on the EMSS path after the Web Audio
// backend has returned, with every packet that reached it (also those that 'Limit audio delay' skips); each start
// begins it afresh and its end hands the figures to the report through the statistics of the audio stream, which
// VidDecCleanup() takes before the message is built; the front end gives the hint the state of 'Limit audio delay'.
// The behaviour itself is run by tests/native/audio_lead_test.cpp (the estimator on simulated streams),
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
  const skipped = play.indexOf('if (s_AudioSyncEnabled && ntp + kAudioBufferMargin < s_estimatedAudioEnd) {');
  const update = play.indexOf('s_estimatedAudioEnd = std::max(s_estimatedAudioEnd, ntp) + s_frameDuration;');
  const feedSkipped = play.indexOf('s_AudioLead.AddPacket(');
  const feedOther = play.lastIndexOf('s_AudioLead.AddPacket(');
  assert.ok(webAudioReturn > 0 && skipped > webAudioReturn && feedSkipped > skipped, 'the skipped packet counts');
  assert.ok(play.indexOf('return;', feedSkipped) < update && feedOther > update, 'the others count after the update');
  // Each start begins afresh, before the disabled output returns, and only the TV media player is measured
  const init = functionBody(decoder, 'int MoonlightInstance::AudDecInit(');
  assert.ok(init.indexOf('s_AudioLead.Reset(s_AudioBackend == AudioBackend::Emss ?') > 0);
  assert.ok(init.indexOf('s_AudioLead.Reset(') < init.indexOf('if (s_AudioBackend == AudioBackend::Disabled) {'));
  // The end of the stream logs it and keeps its figures, then starts it again empty
  const cleanup = functionBody(decoder, 'void MoonlightInstance::AudDecCleanup(void) {');
  assert.match(cleanup, /const AudioLeadSummary lead = s_AudioLead\.Finish\(\);[\s\S]*FormatAudioLeadLog\(lead, line, sizeof\(line\)\)[\s\S]*g_AudioStreamStats\.hasDrift = lead\.hasDrift;[\s\S]*s_AudioLead\.Reset\(0\.0\);\n\}/);
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
