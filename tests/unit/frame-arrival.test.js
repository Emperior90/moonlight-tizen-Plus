'use strict';

// Checks the rate at which the frames arrive on the TV since 2.3.2 ('Frames arrive at: 275 Mbps'):
// - moonlight-common-c measures each frame in its RTP video queue from the first packet to the last data packet of each
//   FEC block, with the bytes of the data packets after the first at IP level (IP and UDP headers, and the header of an
//   encrypted packet), counts no parity packet of a block that arrived complete, counts a block that needed FEC
//   recovery up to the parity packet that completed it (the clock read before the recovery), and hands the figures to
//   the decode unit through the depacketizer, which takes them from the first packet of the frame (the figures
//   themselves are pinned by tests/native/frame_arrival_test.c and video_depacketizer_test.c);
// - the app sums them over the stats window and shows the rate in the full statistics after the frame receive time,
//   only from enough frames and time (wasm/frame_arrival.hpp, pinned by tests/native/stats_overlay_test.cpp), and the
//   compact line stays as it was;
// - replaceKnownStatsLabels() of wasm/platform/messages.js translates the line as a whole in every language, with the
//   real locale files, and no language calls it the speed of the Wi-Fi;
// - the report of the session carries the rate of the stream (wasm/session_report.hpp), and Last session shows it after
//   the frame receive time, without it for a report of 2.3.1 or a session without enough frames;
// - the label of the frame receive time is the same in the overlay and in Last session in every language (Spanish
//   shortened it in 2.3.2 to make room for the new line).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const LOCALES = ['de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
const readLocale = (name) => JSON.parse(read('wasm/static/locales/' + name + '.json'));
const KEY = 'Frames arrive at: %1$s Mbps';
// Code without its comments, so that a comment can't satisfy a check
const code = (text) => text.replace(/\/\/.*$/gm, '');

// A t() that translates with a locale file like i18n.js does
function translator(locale) {
  const messages = readLocale(locale);
  return (key, ...values) => {
    const text = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key;
    return text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  };
}

test('moonlight-common-c measures the data packets of each FEC block and hands the figures of the frame to the decode unit', () => {
  const limelight = read('moonlight-common-c/src/Limelight.h');
  const unit = limelight.slice(limelight.indexOf('typedef struct _DECODE_UNIT {'), limelight.indexOf('} DECODE_UNIT, *PDECODE_UNIT;'));
  assert.match(unit, /uint32_t arrivalTimeUs;\s+uint32_t arrivalBytes;/);
  // The figures say what they count: the data packets at IP level, without parity packets
  assert.match(unit, /data packets?[\s\S]*IP level[\s\S]*Parity packets don't count/);

  const queue = code(read('moonlight-common-c/src/RtpVideoQueue.c'));
  // The headers of the network: IPv4 or IPv6, UDP, and the header of an encrypted video packet
  assert.match(queue, /queue->packetOverheadBytes = \(RemoteAddr\.ss_family == AF_INET6 \? 40 : 20\) \+ 8 \+\s+\(\(EncryptionFeaturesEnabled & SS_ENC_VIDEO\) \? \(uint32_t\)sizeof\(ENC_VIDEO_HEADER\) : 0\);/);
  // The packets after the first one of the block add their bytes, after the branches of the data and the parity
  // packets: a block that arrived complete is done at its last data packet, so only a block that needed its parity
  // packets counts them. The time of the packet that can complete the block is read before reconstructFrame(), so that
  // the time of a recovery by FEC doesn't count, and the block counts when it is complete, before it is staged.
  const counting = queue.slice(queue.indexOf('if (isBefore16(packet->sequenceNumber, queue->bufferFirstParitySequenceNumber)) {\n            queue->receivedDataPackets++;'));
  const branches = counting.slice(0, counting.indexOf('uint64_t arrivalEndUs = 0;'));
  assert.match(branches, /receivedDataPackets\+\+[\s\S]*receivedParityPackets\+\+/);
  assert.doesNotMatch(branches, /Arrival/);
  assert.match(counting, /uint64_t arrivalEndUs = 0;\s+if \(queue->receivedDataPackets \+ queue->receivedParityPackets > 1\) \{\s+queue->blockArrivalBytes \+= \(uint32_t\)length \+ queue->packetOverheadBytes;\s+if \(queue->receivedDataPackets \+ queue->receivedParityPackets >= queue->bufferDataPackets\) \{\s+arrivalEndUs = receiveTimeUs;\s+\}\s+\}\s+if \(reconstructFrame\(queue\) == 0\) \{\s+addFecBlockArrival\(queue, arrivalEndUs\);\s+stageCompleteFecBlock\(queue\);/);
  const add = queue.slice(queue.indexOf('static void addFecBlockArrival('), queue.indexOf('static void submitCompletedFrame('));
  assert.match(add, /if \(queue->receivedDataPackets \+ queue->receivedParityPackets > 1\) \{\s+if \(endUs > queue->bufferFirstRecvTimeUs\) \{\s+queue->frameArrivalTimeUs \+= \(uint32_t\)\(endUs - queue->bufferFirstRecvTimeUs\);/);
  assert.doesNotMatch(add, /PltGetMicroseconds/);
  // Since 2.3.5 the queue reads no clock for them: the times are those at which the reader thread of VideoStream.c read
  // the packets, given to RtpvAddPacket() with each one
  assert.doesNotMatch(queue, /PltGetMicroseconds/);
  assert.match(queue, /int RtpvAddPacket\(PRTP_VIDEO_QUEUE queue, PRTP_PACKET packet, int length, PRTPV_QUEUE_ENTRY packetEntry,\s+uint64_t receiveTimeUs\) \{/);
  // The figures of a frame start again at its first block, those of a block at each block
  assert.match(queue, /queue->blockArrivalBytes = 0;\s+if \(fecCurrentBlockNumber == 0\) \{\s+queue->frameArrivalTimeUs = 0;\s+queue->frameArrivalBytes = 0;\s+\}/);
  // Each packet of the frame carries them to the depacketizer, which takes them from the first packet of the frame
  // (since 2.3.5 the packets of the frame go to it at once, queueRtpPackets())
  assert.match(queue, /for \(entry = queue->completedFecBlockList\.head; entry != NULL; entry = entry->next\) \{[^}]*entry->frameArrivalTimeUs = queue->frameArrivalTimeUs;\s+entry->frameArrivalBytes = queue->frameArrivalBytes;\s+\}\s+[^}]*queueRtpPackets\(entry\);/);
  const depacketizer = code(read('moonlight-common-c/src/VideoDepacketizer.c'));
  assert.match(depacketizer, /firstPacketReceiveTimeUs = receiveTimeUs;\s+frameArrivalTimeUs = arrivalTimeUs;\s+frameArrivalBytes = arrivalBytes;/);
  assert.match(depacketizer, /qdu->decodeUnit\.arrivalTimeUs = frameArrivalTimeUs;\s+qdu->decodeUnit\.arrivalBytes = frameArrivalBytes;/);
  assert.match(depacketizer, /queueEntry\.frameArrivalTimeUs,\s+queueEntry\.frameArrivalBytes,/);
  // The receive thread alone writes these figures: no lock and no C11 atomics for them
  [queue, depacketizer].forEach((text) => assert.doesNotMatch(text, /stdatomic|_Atomic|atomic_/));
});

test('the app sums the arrival over the stats window and shows the rate in the full statistics only', () => {
  const player = read('wasm/wasmplayer.cpp');
  assert.match(player, /#include "frame_arrival\.hpp"/);
  // A frame counts with its bytes, also with a time of 0; a frame without bytes doesn't count at all
  assert.match(player, /if \(decodeUnit->arrivalBytes > 0\) \{\s+m_ActiveWndVideoStats\.totalArrivalTimeUs \+= decodeUnit->arrivalTimeUs;\s+m_ActiveWndVideoStats\.totalArrivalBytes \+= decodeUnit->arrivalBytes;\s+m_ActiveWndVideoStats\.arrivalFrames\+\+;\s+\}/);
  assert.match(player, /dst\.totalArrivalTimeUs \+= src\.totalArrivalTimeUs;\s+dst\.totalArrivalBytes \+= src\.totalArrivalBytes;\s+dst\.arrivalFrames \+= src\.arrivalFrames;/);
  // The line follows the frame receive time, and only with a rate
  assert.match(player, /if \(arrivalMbps > 0\) \{\s+snprintf\(arrivalLine, sizeof\(arrivalLine\), "Frames arrive at: %u Mbps\\n", arrivalMbps\);/);
  assert.match(player, /"Average frame receive time: %\.2f ms \(%\.0f%% of the frame time\)\\n"\s+"%s"\s+"Average frame wait time: %\.2f ms\\n"/);
  // The compact line has no rate
  const compact = player.slice(player.indexOf('static CompactVideoStats GetCompactVideoStats('));
  assert.doesNotMatch(compact.slice(0, compact.indexOf('\n}\n')), /Arrival/);
  // The rate needs enough frames and time, and never divides by zero
  const header = code(read('wasm/frame_arrival.hpp'));
  assert.match(header, /constexpr uint32_t kFrameArrivalMinFrames = 10;/);
  assert.match(header, /constexpr uint64_t kFrameArrivalMinTimeUs = 20000;/);
  assert.match(header, /if \(frames < kFrameArrivalMinFrames \|\| totalTimeUs < kFrameArrivalMinTimeUs \|\| totalBytes == 0\) \{\s+return 0;\s+\}/);
});

test('the full statistics translate the line of the arrival rate as a whole, in every language', () => {
  const translate = (locale) => loadPlatformScripts(['wasm/platform/messages.js'], { globals: { t: translator(locale) } }).get('replaceKnownStatsLabels');
  const text = 'Average frame receive time: 8.65 ms (52% of the frame time)\nFrames arrive at: 275 Mbps\nAverage frame wait time: 0.42 ms\n';
  assert.equal(translate('en-US')(text), text);
  LOCALES.forEach((locale) => {
    const t = translator(locale);
    const lines = translate(locale)(text).split('\n');
    assert.equal(lines[0], t('Average frame receive time:') + ' 8.65 ms ' + t('(%1$s% of the frame time)', '52'), locale);
    assert.equal(lines[1], t(KEY, '275'), locale);
    assert.equal(lines[2], t('Average frame wait time:') + ' 0.42 ms', locale);
    // Nothing stays English (German keeps the word Frame, as its glossary does), the figure and its unit are there,
    // and it is a short line, also with four digits
    assert.doesNotMatch(lines[1], /arrive/, locale);
    assert.match(lines[1], /[: ]275 Mbps$/, locale);
    assert.ok(t(KEY, '1234').length <= 45, locale + ': ' + t(KEY, '1234'));
  });
  // It says what it measures, the arrival of the frames, never the speed of the Wi-Fi
  ['en-US'].concat(LOCALES).forEach((locale) => {
    assert.doesNotMatch(readLocale(locale)[KEY], /Wi-?Fi|WLAN|wireless|inalámbric|sans fil|sem fio/i, locale);
  });
  // French puts a no-break space before the colon and uses the typographic apostrophe
  assert.match(readLocale('fr-FR')[KEY], /^Débit d’arrivée des images : %1\$s Mbps$/);
});

test('the report of the session carries the arrival rate, and Last session shows it after the frame receive time', () => {
  const header = read('wasm/session_report.hpp');
  assert.match(header, /uint32_t arrivalMbps = 0;/);
  assert.match(header, /\\"renderTimeMaxX10\\":%u,\\"arrivalMbps\\":%u,\\"audioChannels\\":%u,/);
  assert.match(read('wasm/wasmplayer.cpp'),
    /report\.arrivalMbps = FrameArrivalMbps\(totals\.totalArrivalBytes, totals\.totalArrivalTimeUs, totals\.arrivalFrames\);/);

  const app = loadPlatformScripts(['wasm/platform/diagnostics.js'], { globals: { t: translator('en-US') } });
  const parse = app.get('parseSessionReport');
  const describe = app.get('describeSessionReport');
  const message = '{"durationMs":600000,"codec":"AV1 Main10","width":3840,"height":2160,"fps":60,"bitrateKbps":150000,' +
    '"frames":36000,"receiveTimeX100":865,"receiveTimePeakX100":1110,"receiveTimeMaxX10":362,"waitTimeMaxX10":31,' +
    '"pacingDelayMaxX10":118,"renderTimeMaxX10":42,"arrivalMbps":275,"heapTopMb":62,"heapTotalMb":128,"hostRfi":1}';
  const report = plain(parse(message));
  assert.equal(report.arrivalMbps, 275);
  const lines = plain(describe(report, {}));
  const receive = lines.findIndex((line) => line.indexOf('Average frame receive time:') === 0);
  assert.ok(receive > 0, lines.join('\n'));
  assert.equal(lines[receive + 1], 'Frames arrive at: 275 Mbps');
  assert.equal(lines[receive + 2].indexOf('Longest frame times (ms): '), 0);
  const arrival = (extra) => plain(describe(Object.assign({}, report, extra), {})).filter((line) => line.indexOf('Frames arrive') === 0);
  // A report of 2.3.1 has no rate, nor does a session without enough frames to tell (0)
  const older = plain(parse(message.replace('"arrivalMbps":275,', '')));
  assert.equal(older.arrivalMbps, 0);
  assert.deepEqual(plain(describe(older, {})).filter((line) => line.indexOf('Frames arrive') === 0), []);
  assert.deepEqual(arrival({ arrivalMbps: 0 }), []);
  // Figures that aren't numbers count as missing
  ['"275"', '-3', 'null', '1.5e400'].forEach((value) => {
    assert.equal(plain(parse(message.replace('"arrivalMbps":275', '"arrivalMbps":' + value))).arrivalMbps, 0, value);
  });
  // In another language, with its separators (a rate above 1 Gbps on a fast cable to a fast PC)
  const german = loadPlatformScripts(['wasm/platform/diagnostics.js'], { globals: { t: translator('de-DE') } });
  const germanReport = german.get('parseSessionReport')(message.replace('"arrivalMbps":275', '"arrivalMbps":1050'));
  const germanLines = plain(german.get('describeSessionReport')(germanReport, {}));
  assert.ok(germanLines.some((line) => /^Ankunftsrate der Frames: 1[.,]?050 Mbps$/.test(line)), germanLines.join('\n'));
});

test('the label of the frame receive time is the same in the full statistics and in Last session, in every language', () => {
  LOCALES.forEach((locale) => {
    const messages = readLocale(locale);
    const label = messages['Average frame receive time:'];
    const share = messages['(%1$s% of the frame time)'];
    assert.equal(messages['Average frame receive time: %1$s ms (%2$s% of the frame time)'], label + ' %1$s ms ' + share.replace('%1$s', '%2$s'), locale);
    assert.equal(messages['Average frame receive time: %1$s ms (%2$s% of the frame time), highest second: %3$s ms (%4$s%)'].indexOf(label + ' %1$s ms '), 0, locale);
  });
  // Spanish names the time of reception without repeating the frames, which the share in brackets names
  assert.equal(readLocale('es-ES')['Average frame receive time:'], 'Tiempo medio de recepción:');
});
