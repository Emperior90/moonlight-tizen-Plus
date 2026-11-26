'use strict';

// Checks the times of the stages of a frame on the TV since 2.3.2, on a clock finer than a millisecond:
// - moonlight-common-c has the microsecond clock of upstream 82ee2d6 (PltGetMicroseconds(), LiGetMicroseconds()) on
//   the clock and epoch of its millisecond clock, and the decode unit carries its receive and enqueue times in
//   microseconds next to the millisecond fields, which stay for the app (the pacer and the timestamps read them); the
//   rest of 82ee2d6 (its RTP statistics and the audio queue) is not in this copy, and the port uses no C11 atomics;
// - the full statistics have one line with the longest time of a single frame in each stage of the windows of the
//   message, written by FormatVideoStats() of wasm/wasmplayer.cpp (pinned by tests/native/stats_overlay_test.cpp) and
//   translated as a whole in every language by replaceKnownStatsLabels() of wasm/platform/messages.js, with the real
//   locale files; the compact line keeps its figures;
// - the report of the session carries the longest of the stream in tenths of a millisecond (wasm/session_report.hpp),
//   and Last session shows them in one line after the frame receive time, without it for a report of 2.3.1 or a
//   session without a frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const LOCALES = ['de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
const readLocale = (name) => JSON.parse(read('wasm/static/locales/' + name + '.json'));
const KEY = 'Longest frame times (ms): receive %1$s, wait %2$s, pacing %3$s, rendering %4$s';

// A t() that translates with a locale file like i18n.js does
function translator(locale) {
  const messages = readLocale(locale);
  return (key, ...values) => {
    const text = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key;
    return text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  };
}

// The line as FormatVideoStats() writes it (the native test pins these figures)
const LONGEST_LINE = 'Longest frame times (ms): receive 6.4, wait 2.7, pacing 0.0, rendering 1.2';

test('moonlight-common-c has the microsecond clock of 82ee2d6 next to its millisecond clock, without C11 atomics', () => {
  const platform = read('moonlight-common-c/src/Platform.c');
  const micro = platform.slice(platform.indexOf('uint64_t PltGetMicroseconds(void) {'));
  // The same clock as PltGetMillis(), in microseconds, without a start time of its own
  assert.match(micro, /clock_gettime\(CLOCK_MONOTONIC, &tv\);\s+return \(\(uint64_t\)tv\.tv_sec \* 1000000\) \+ \(tv\.tv_nsec \/ 1000\);/);
  assert.match(platform, /clock_gettime\(CLOCK_MONOTONIC, &tv\);\s+return \(\(uint64_t\)tv\.tv_sec \* 1000\) \+ \(tv\.tv_nsec \/ 1000000\);/);
  // (upstream counts from a start time that PltTicksInit() takes once; this copy needs no state for it)
  assert.doesNotMatch(platform.replace(/\/\/.*$/gm, ''), /PltTicksInit|ticks_started/);
  assert.match(read('moonlight-common-c/src/Platform.h'), /uint64_t PltGetMillis\(void\);\nuint64_t PltGetMicroseconds\(void\);/);
  assert.match(read('moonlight-common-c/src/Misc.c'), /uint64_t LiGetMicroseconds\(void\) \{\s+return PltGetMicroseconds\(\);\s+\}/);
  const limelight = read('moonlight-common-c/src/Limelight.h');
  assert.match(limelight, /uint64_t LiGetMillis\(void\);[\s\S]*uint64_t LiGetMicroseconds\(void\);/);
  // The decode unit keeps its millisecond fields and has the microsecond ones
  const unit = limelight.slice(limelight.indexOf('typedef struct _DECODE_UNIT {'), limelight.indexOf('} DECODE_UNIT, *PDECODE_UNIT;'));
  ['receiveTimeMs', 'enqueueTimeMs', 'receiveTimeUs', 'enqueueTimeUs'].forEach((field) => assert.match(unit, new RegExp('uint64_t ' + field + ';'), field));
  // Both pairs from one reading of the clock
  const depacketizer = read('moonlight-common-c/src/VideoDepacketizer.c');
  assert.match(depacketizer, /qdu->decodeUnit\.receiveTimeUs = firstPacketReceiveTimeUs;\s+qdu->decodeUnit\.receiveTimeMs = firstPacketReceiveTimeUs \/ 1000;/);
  assert.match(depacketizer, /qdu->decodeUnit\.enqueueTimeUs = PltGetMicroseconds\(\);\s+qdu->decodeUnit\.enqueueTimeMs = qdu->decodeUnit\.enqueueTimeUs \/ 1000;/);
  // (since 2.3.5 the time at which the reader thread of VideoStream.c read the first packet of the block, on that clock,
  // given to RtpvAddPacket() with each packet)
  assert.match(read('moonlight-common-c/src/RtpVideoQueue.c'), /queue->bufferFirstRecvTimeUs = receiveTimeUs;/);
  assert.match(read('moonlight-common-c/src/VideoStream.c'), /stampUs = PltGetMicroseconds\(\);/);
  // Not the rest of 82ee2d6: no RTP statistics API, and the audio queue still waits in milliseconds
  assert.doesNotMatch(limelight, /LiGetRTPAudioStats|LiGetRTPVideoStats|RTP_VIDEO_STATS/);
  assert.match(read('moonlight-common-c/src/RtpAudioQueue.c'), /block->queueTimeMs = PltGetMillis\(\);/);
  ['Platform.c', 'Misc.c', 'VideoDepacketizer.c', 'RtpVideoQueue.c', 'RtpVideoQueue.h', 'Limelight.h'].forEach((file) => {
    assert.doesNotMatch(read('moonlight-common-c/src/' + file), /stdatomic|_Atomic|atomic_/, file);
  });
});

test('the app times the stages of a frame on the microsecond clock and keeps the millisecond times for the pacer', () => {
  const player = read('wasm/wasmplayer.cpp');
  const submit = player.slice(player.indexOf('int MoonlightInstance::VidDecSubmitDecodeUnit(PDECODE_UNIT decodeUnit) {'),
    player.indexOf('void MoonlightInstance::AddVideoStats('));
  // The pacer and the timestamps still read the times in milliseconds
  assert.match(submit, /const uint64_t dequeueMs = LiGetMillis\(\);\s+const uint64_t dequeueUs = LiGetMicroseconds\(\);/);
  assert.match(submit, /const uint64_t queuedMs = dequeueMs > decodeUnit->enqueueTimeMs \? dequeueMs - decodeUnit->enqueueTimeMs : 0;/);
  // Every stage of the statistics on the microsecond clock, with its longest frame
  assert.equal((submit.match(/AddFrameTime\(/g) || []).length, 4);
  assert.match(submit, /AddFrameTime\(m_ActiveWndVideoStats\.totalReassemblyTimeUs, m_ActiveWndVideoStats\.maxReassemblyTimeUs,\s+decodeUnit->receiveTimeUs, decodeUnit->enqueueTimeUs\);/);
  assert.match(submit, /AddFrameTime\(m_ActiveWndVideoStats\.totalDecodeTimeUs, m_ActiveWndVideoStats\.maxDecodeTimeUs,\s+decodeUnit->enqueueTimeUs, dequeueUs\);/);
  assert.match(submit, /AddFrameTime\(m_ActiveWndVideoStats\.totalPacerTimeUs, m_ActiveWndVideoStats\.maxPacerTimeUs,\s+pacingStartUs, pacingEndUs\);/);
  assert.match(submit, /AddFrameTime\(m_ActiveWndVideoStats\.totalRenderTimeUs, m_ActiveWndVideoStats\.maxRenderTimeUs, beforeRenderUs,\s+LiGetMicroseconds\(\)\);/);
  // No stage is timed in milliseconds any more
  assert.doesNotMatch(submit, /pacingStart = LiGetMillis|beforeRender = LiGetMillis|afterRender = LiGetMillis/);
  // The native line matches the pattern that the front end translates
  assert.ok(player.includes('"Longest frame times (ms): receive %.1f, wait %.1f, pacing %.1f, rendering %.1f\\n"'));
  // The compact line keeps its figures
  assert.match(read('wasm/compact_stats.hpp'),
    /"StatCompactMsg: \{\\"w\\":%u,\\"h\\":%u,\\"fps\\":%u,\\"codec\\":\\"%s\\",\\"bits\\":%d,\\"hdr\\":%d,\\"rfps\\":%s,\\"mbps\\":%s,"\s+"\\"rtt\\":%s,\\"drop\\":%s,\\"delay\\":%s\}"/);
});

test('the full statistics translate the line of the longest frame times as a whole, in every language', () => {
  const translate = (locale) => loadPlatformScripts(['wasm/platform/messages.js'], { globals: { t: translator(locale) } }).get('replaceKnownStatsLabels');
  // English keeps the line, also next to the averages
  const averages = 'Average rendering time: 0.40 ms\n' + LONGEST_LINE + '\nPending frames: 0 (max 3)\n';
  assert.equal(translate('en-US')(averages), averages);
  LOCALES.forEach((locale) => {
    const t = translator(locale);
    const lines = translate(locale)(averages).split('\n');
    assert.equal(lines[0], t('Average rendering time:') + ' 0.40 ms', locale);
    assert.equal(lines[1], t(KEY, '6.4', '2.7', '0.0', '1.2'), locale);
    assert.notEqual(lines[1], LONGEST_LINE, locale);
    // Nothing stays English, every figure is still there, and the unit is named once
    assert.doesNotMatch(lines[1], /Longest|receive|wait|rendering/, locale);
    assert.deepEqual(lines[1].match(/\d+\.\d/g), ['6.4', '2.7', '0.0', '1.2'], locale);
    assert.equal((lines[1].match(/\(ms\)/g) || []).length, 1, locale);
    assert.equal(lines[2], t('Pending frames:') + ' 0 (max 3)', locale);
    // The line stays about as long as the other long lines of the statistics, with wide figures
    const wide = t(KEY, '125.3', '16.7', '33.4', '16.8');
    assert.ok(wide.length <= 85, locale + ': ' + wide.length + ' ' + wide);
  });
  // French puts a no-break space before the colon
  assert.match(readLocale('fr-FR')[KEY], /\(ms\) : /);
});

test('the report of the session carries the longest frame times, and Last session shows them after the receive time', () => {
  const header = read('wasm/session_report.hpp');
  ['receiveTimeMaxX10', 'waitTimeMaxX10', 'pacingDelayMaxX10', 'renderTimeMaxX10'].forEach((field) => {
    assert.match(header, new RegExp('uint32_t ' + field + ' = 0;'), field);
    assert.match(header, new RegExp('\\\\"' + field + '\\\\":%u'), field);
  });
  const player = read('wasm/wasmplayer.cpp');
  assert.match(player, /report\.receiveTimeMaxX10 = TenthsOfMs\(totals\.maxReassemblyTimeUs\);\s+report\.waitTimeMaxX10 = TenthsOfMs\(totals\.maxDecodeTimeUs\);\s+report\.pacingDelayMaxX10 = TenthsOfMs\(totals\.maxPacerTimeUs\);\s+report\.renderTimeMaxX10 = TenthsOfMs\(totals\.maxRenderTimeUs\);/);

  const app = loadPlatformScripts(['wasm/platform/diagnostics.js'], { globals: { t: translator('en-US') } });
  const parse = app.get('parseSessionReport');
  const describe = app.get('describeSessionReport');
  const message = '{"durationMs":600000,"codec":"HEVC Main10","width":3840,"height":2160,"fps":60,"bitrateKbps":100000,' +
    '"frames":36000,"receiveTimeX100":548,"receiveTimePeakX100":1920,"receiveTimeMaxX10":499,"waitTimeMaxX10":58,' +
    '"pacingDelayMaxX10":118,"renderTimeMaxX10":42,"heapTopMb":62,"heapTotalMb":128,"hostRfi":1}';
  const report = plain(parse(message));
  assert.deepEqual([report.receiveTimeMaxX10, report.waitTimeMaxX10, report.pacingDelayMaxX10, report.renderTimeMaxX10], [499, 58, 118, 42]);
  const lines = plain(describe(report, {}));
  const receive = lines.findIndex((line) => line.indexOf('Average frame receive time:') === 0);
  assert.ok(receive > 0, lines.join('\n'));
  assert.equal(lines[receive + 1], 'Longest frame times (ms): receive 49.9, wait 5.8, pacing 11.8, rendering 4.2');
  const longest = (extra) => plain(describe(Object.assign({}, report, extra), {})).filter((line) => line.indexOf('Longest frame times') === 0);
  // Whole milliseconds keep their tenth, and a stage without time shows 0.0 (e.g. the pacing with Video frame pacing off)
  assert.deepEqual(longest({ receiveTimeMaxX10: 170, pacingDelayMaxX10: 0 }), ['Longest frame times (ms): receive 17.0, wait 5.8, pacing 0.0, rendering 4.2']);
  // A report of 2.3.1, without the figures, and a session without a frame have no line
  const older = plain(parse(message.replace(/"receiveTimeMaxX10":499,"waitTimeMaxX10":58,"pacingDelayMaxX10":118,"renderTimeMaxX10":42,/, '')));
  assert.deepEqual([older.receiveTimeMaxX10, older.waitTimeMaxX10, older.pacingDelayMaxX10, older.renderTimeMaxX10], [0, 0, 0, 0]);
  assert.deepEqual(plain(describe(older, {})).filter((line) => line.indexOf('Longest') === 0), []);
  assert.deepEqual(longest({ receiveTimeMaxX10: 0, waitTimeMaxX10: 0, pacingDelayMaxX10: 0, renderTimeMaxX10: 0 }), []);
  // Figures that aren't numbers count as missing
  const broken = plain(parse('{"frames":10,"receiveTimeMaxX10":"40","waitTimeMaxX10":-3,"pacingDelayMaxX10":null}'));
  assert.deepEqual([broken.receiveTimeMaxX10, broken.waitTimeMaxX10, broken.pacingDelayMaxX10, broken.renderTimeMaxX10], [0, 0, 0, 0]);
  // In another language, with its decimal separator
  const german = loadPlatformScripts(['wasm/platform/diagnostics.js'], { globals: { t: translator('de-DE') } });
  const germanLines = plain(german.get('describeSessionReport')(german.get('parseSessionReport')(message), {}));
  assert.ok(germanLines.some((line) => /^Längste Zeiten pro Frame \(ms\): Empfang 49[.,]9, Warten 5[.,]8, Pacing 11[.,]8, Rendern 4[.,]2$/.test(line)),
    germanLines.join('\n'));
});
