'use strict';

// Checks the lines about how the app reads the video from the network that the diagnostic log has since 2.3.4, and the
// rules of the receive loop that no native test can see (the loop itself and the socket that never waits are run by
// tests/native/video_receive_test.c and tests/native/udp_no_wait_test.c, the two threads of 2.3.5 and their ring by
// tests/native/video_receive_threads_test.c and tests/native/video_receive_ring_test.c). Since 2.3.5 the video is
// received by two threads: the reader (VideoReceiveThreadProc()), whose lines these are, only reads the packets into the
// slots of a ring (moonlight-common-c/src/VideoReceiveRing.h) and notes when it read each one, and the processing thread
// (VideoProcessThreadProc()) does the rest and logs lines of its own:
// - the texts of the mode line, of the line of a minute, of the line of the stream and of the lines of the poll() calls
//   of the samples that VideoReceiveThreadProc() of moonlight-common-c/src/VideoStream.c logs, each one string literal,
//   with the sample of about every 64th receive (at gaps drawn from 48 to 79), the minute of 60 s and the timeout of
//   100 ms that they name, and their longest form within the 239 characters that a line of the diagnostic log keeps;
// - the poll() without a timeout of a sample, which only counts a readable socket as a packet waiting and leaves a
//   sample out when it fails, and the wake of the receive thread before each join of it;
// - the order of the mode decision: the socket that never waits, which startVideoStream() puts in place of the first
//   socket before the receive buffer is read and before the renderer and the threads start, then the receive timeout;
// - what is never used on a socket of the TV (fcntl() and ioctl(FIONBIO) abort the module, ioctl(FIONREAD) answers
//   ENOTTY after a round trip to the main thread, recvmmsg() receives nothing, MSG_DONTWAIT is unknown or dropped), and
//   SOCK_NONBLOCK only where the platform has it; the audio stream and the STUN request read as before;
// - the two threads: the start of the ring and of the processing thread before the reader, the stop of the ring before
//   each join of either thread and its end after them, the time of the read as an argument of RtpvAddPacket(), the
//   buffer of a plain packet that changes hands without a copy, and the lines of the processing thread (one a minute,
//   one for the stream), each one string literal within the 239 characters;
// - the line of the frame receive time of the stream that VidDecCleanup() of wasm/wasmplayer.cpp logs;
// - the redaction of the diagnostic log (wasm/platform/diagnostics.js) leaves every form of these lines as it is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const VIDEO = read('moonlight-common-c/src/VideoStream.c');
const SOCKETS = read('moonlight-common-c/src/PlatformSockets.c');
const RING = read('moonlight-common-c/src/VideoReceiveRing.h');

// The body of a C function of a source, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

// The code of a C source without its comments
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// The formats of the lines, with the escapes of C (a line break is the two characters \n)
const MODE_TIMEOUT = 'Video receive mode: one recvfrom() per packet with a receive timeout of %d ms; back-to-back reads off (not needed)\\n';
const MODE_POLL = 'Video receive mode: no receive timeout, poll() before each recvfrom(); back-to-back reads off (no socket that never waits)\\n';
const MODE_NO_WAIT = 'Video receive mode: no receive timeout, socket that never waits; back-to-back reads on (poll() only when no packet is waiting)\\n';
const MINUTE = 'Video receive, last %u s: %llu packets/s, %.2f socket calls each, %s%% were waiting; %s us to read a waiting packet, %s us of other work per packet: up to %s Mbps\\n';
const STREAM = 'Video receive of the stream, %u s: %llu packets, %.2f socket calls each, %s%% were waiting; %s us to read a waiting packet, %s us of other work per packet: up to %s Mbps; clock read %s us\\n';
const CHECK = 'Video receive check of the stream: %llu calls of poll() without a timeout, %s us each, %llu failed\\n';
const CHECK_FAILED = 'Video receive check: poll() without a timeout failed: %d\\n';
const PROC_MINUTE = 'Video processing, last %u s: %llu packets/s, %s us of work each, idle %s%%: up to %s Mbps; ring up to %u of %u packets, full %u times for %u ms; %u wakes\\n';
const PROC_STREAM = 'Video processing of the stream, %u s: %llu packets, %s us of work each, idle %s%%: up to %s Mbps; ring up to %u of %u packets, full %u times for %u ms; %u wakes\\n';
const FRAME = 'Frame receive of the stream: %u.%02u ms on average, frames arrive at %u Mbps\\n';
const FRAME_FEW = 'Frame receive of the stream: %u.%02u ms on average, frames arrive at: too few frames to tell\\n';

// A format with its conversions replaced by the given values in order, as printf() would write it, without the line
// break
function format(text, values) {
  let index = 0;
  return text.replace(/\\n$/, '').replace(/%%|%(?:\.2f|02u|llu|u|d|s)/g, (conversion) => {
    if (conversion === '%%') {
      return '%';
    }
    assert.ok(index < values.length, 'a value for ' + conversion + ' of ' + text);
    return String(values[index++]);
  });
}

test('the receive thread logs its mode, a line each minute and one for the stream, each a literal of a known text', () => {
  // Each format is one string literal of a Limelog() call, the mode of a receive timeout with the timeout as its value
  assert.match(VIDEO, new RegExp('Limelog\\("' + MODE_TIMEOUT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '",\\s+UDP_RECV_POLL_TIMEOUT_MS\\);'));
  [MODE_POLL, MODE_NO_WAIT].forEach((text) => assert.ok(VIDEO.indexOf('Limelog("' + text + '");') > 0, text));
  assert.ok(VIDEO.indexOf('Limelog("' + MINUTE + '",\n') > 0, 'the line of a minute');
  assert.ok(VIDEO.indexOf('Limelog("' + STREAM + '",\n') > 0, 'the line of the stream');
  assert.ok(VIDEO.indexOf('Limelog("' + CHECK + '",\n') > 0, 'the line of the poll() calls of the samples');
  assert.ok(VIDEO.indexOf('Limelog("' + CHECK_FAILED + '", pollError);') > 0, 'the line of a failed poll()');
  // Nothing else of the library logs a line that starts like them
  const formats = (withoutComments(VIDEO).match(/Limelog\("Video receive[^"]*"/g) || []);
  assert.equal(formats.length, 7);
  // The lines of the processing thread (since 2.3.5), each with its ten values
  assert.ok(VIDEO.indexOf('Limelog("' + PROC_MINUTE + '",\n') > 0, 'the line of a minute of the processing thread');
  assert.ok(VIDEO.indexOf('Limelog("' + PROC_STREAM + '",\n') > 0, 'the line of the stream of the processing thread');
  assert.equal((withoutComments(VIDEO).match(/Limelog\("Video processing[^"]*"/g) || []).length, 2);
  // The figures that the lines and the guide name
  assert.match(VIDEO, /^#define VIDEO_RECV_SAMPLE_EVERY 64$/m);
  assert.match(VIDEO, /^#define VIDEO_RECV_LINE_INTERVAL_US 60000000ULL$/m);
  assert.match(read('moonlight-common-c/src/Limelight-internal.h'), /^#define UDP_RECV_POLL_TIMEOUT_MS 100$/m);
  // A sample at gaps from 48 to 79 receives, from a generator that the thread seeds itself (no shared state)
  assert.match(VIDEO, /sampled = receives == nextSampleReceive;\s+if \(sampled\) \{\s+nextSampleReceive = receives \+ nextVideoReceiveSampleGap\(&sampleState\);/);
  assert.match(functionBody(VIDEO, 'static uint32_t nextVideoReceiveSampleGap(uint32_t* state) {'),
    /\*state = \*state \* 1664525u \+ 1013904223u;\s+return VIDEO_RECV_SAMPLE_EVERY - 16 \+ \(\*state >> 27\);/);
  assert.match(VIDEO, /sampleState = VIDEO_RECV_SAMPLE_SEED;\s+nextSampleReceive = nextVideoReceiveSampleGap\(&sampleState\);/);
  // The sample asks the socket whether a packet is waiting with a poll() without a timeout of the video socket alone,
  // timed between two clock reads, unless the socket that never waits tells it with every read; only a readable socket
  // counts as a packet waiting, and a failed poll() leaves the sample out
  const thread = functionBody(VIDEO, 'static void VideoReceiveThreadProc(void* context) {');
  assert.match(thread, /waitingKnown = receiveMode == VIDEO_RECV_MODE_NO_WAIT;/);
  assert.match(thread, /if \(sampled && receiveMode != VIDEO_RECV_MODE_NO_WAIT\) \{/);
  assert.match(thread, /uint64_t pollStartUs = PltGetMicroseconds\(\);\s+pfd\.fd = rtpSocket;\s+pfd\.events = POLLIN;\s+pfd\.revents = 0;\s+pollResult = pollSockets\(&pfd, 1, 0\);\s+pollError = pollResult < 0 \? \(int\)LastSocketError\(\) : 0;\s+receiveStartUs = PltGetMicroseconds\(\);\s+figures\.checkPolls\+\+;\s+figures\.checkPollUs \+= receiveStartUs - pollStartUs;/);
  assert.match(thread, /if \(pollResult < 0\) \{\s+if \(figures\.checkPollFailures\+\+ == 0\) \{/);
  assert.match(thread, /else \{\s+waitingKnown = true;\s+waiting = pollResult > 0 && \(pfd\.revents & POLLIN\) != 0;\s+\}/);
  assert.match(thread, /if \(waitingKnown\) \{\s+figures\.checked\+\+;/);
  assert.doesNotMatch(withoutComments(VIDEO), /isSocketReadable\(/);
  // The line of the stream comes once, after the loop (and the close of the ring, since 2.3.5), when a packet was read,
  // followed by the one of the samples
  assert.match(thread, /\n    \}\n\n(\s*\/\/.*\n)*\s+VrrClose\(&receiveRing\);\n\n(\s*\/\/.*\n)*\s+if \(figures\.packets > 0\) \{\s+logVideoReceiveFigures\(&figures, NULL, PltGetMicroseconds\(\) - streamStartUs, true\);\s+\}/);
  // The counters have one writer, the receive thread (and the processing thread its own), and are plain fields of a
  // struct on its stack; the ring takes a mutex
  assert.doesNotMatch(VIDEO, /_Atomic|atomic_|__atomic|__sync_/);
  assert.doesNotMatch(RING, /_Atomic|atomic_|__atomic|__sync_/);
});

test('the lines fit within a line of the diagnostic log at their longest', () => {
  // The largest value of each conversion, and of each text that the code passes: the waiting share at most 100, the times
  // at most 99999.9 us, the rate at most 99999 Mbps (or "n/a", which is shorter)
  const seconds = 4294967295;
  const count = '18446744073709551615';
  const lines = [
    format(MODE_TIMEOUT, [100]),
    format(MODE_POLL, []),
    format(MODE_NO_WAIT, []),
    format(MINUTE, [seconds, count, '999.99', '100', '99999.9', '99999.9', '99999']),
    format(STREAM, [seconds, count, '999.99', '100', '99999.9', '99999.9', '99999', '99999.9']),
    format(CHECK, [count, '99999.9', count]),
    format(CHECK_FAILED, [-2147483648]),
    format(PROC_MINUTE, [seconds, count, '99999.9', '100', '99999', seconds, seconds, seconds, seconds, seconds]),
    format(PROC_STREAM, [seconds, count, '99999.9', '100', '99999', seconds, seconds, seconds, seconds, seconds]),
    format(FRAME, [42949672, '95', seconds]),
    format(FRAME_FEW, [42949672, '95']),
  ];
  lines.forEach((line) => assert.ok(line.length <= 239, line.length + ': ' + line));
  // (the longest lines of the processing thread, as the spec of 2.3.5 counted them)
  assert.equal(lines[7].length, 225);
  assert.equal(lines[8].length, 232);
  // The clamps that keep the texts that short
  assert.match(VIDEO, /else if \(value > 99999\.9\) \{\s+value = 99999\.9;/);
  assert.match(VIDEO, /if \(callsEach > 999\.99\) \{\s+callsEach = 999\.99;/);
  assert.match(VIDEO, /if \(mbps > 99999\) \{\s+mbps = 99999;/);
  assert.match(VIDEO, /if \(clockUs > 99999\.9\) \{\s+clockUs = 99999\.9;/);
  assert.match(VIDEO, /snprintf\(waiting, sizeof\(waiting\), "%u", \(unsigned int\)\(\(d\.checkedWaiting \* 100 \+ d\.checked \/ 2\) \/ d\.checked\)\);/);
  // The processing thread: its work per packet and its rate clamped like those of the reader, its counts within 32 bits
  const process = functionBody(VIDEO, 'static void logVideoProcessFigures(');
  assert.match(process, /if \(value > 99999\.9\) \{\s+value = 99999\.9;/);
  assert.match(process, /if \(mbps > 99999\) \{\s+mbps = 99999;/);
  assert.match(process, /snprintf\(idle, sizeof\(idle\), "%u", \(unsigned int\)\(\(idleUs \* 100 \+ elapsedUs \/ 2\) \/ elapsedUs\)\);/);
  assert.match(process, /idleUs = d\.idleUs < elapsedUs \? d\.idleUs : elapsedUs;/);
  assert.equal((process.match(/clampedVideoCount\(/g) || []).length, 6);
  assert.match(functionBody(VIDEO, 'static unsigned int clampedVideoCount(uint64_t value) {'),
    /return value > 4294967295ULL \? 4294967295U : \(unsigned int\)value;/);
  // The rate at IP level, with the headers of IPv4 or IPv6 and UDP, like 'Frames arrive at' (RtpVideoQueue.c), for the
  // lines of both threads; the reader's with the clock read per packet that notes when it read the packet
  assert.match(functionBody(VIDEO, 'static unsigned int videoReceiveOverheadBytes(void) {'),
    /overheadBytes = \(RemoteAddr\.ss_family == AF_INET6 \? 40 : 20\) \+ 8;/);
  assert.equal((withoutComments(VIDEO).match(/videoReceiveOverheadBytes\(\)/g) || []).length, 2);
  assert.match(VIDEO, /double mbps = \(\(double\)d\.bytes \/ \(double\)d\.packets \+ videoReceiveOverheadBytes\(\)\) \* 8 \/\s+\(readUs \+ workUs \+ clockUs\);/);
  assert.match(read('moonlight-common-c/src/RtpVideoQueue.c'), /queue->packetOverheadBytes = \(RemoteAddr\.ss_family == AF_INET6 \? 40 : 20\) \+ 8 \+/);
});

test('the socket that never waits replaces the first one before the threads start, and the thread then reads it back to back', () => {
  const thread = functionBody(VIDEO, 'static void VideoReceiveThreadProc(void* context) {');
  const noWait = thread.indexOf('if (rtpSocketNoWait) {');
  const timeout = thread.indexOf('else if (setNonFatalRecvTimeoutMs(rtpSocket, UDP_RECV_POLL_TIMEOUT_MS) < 0) {');
  const unsupported = thread.indexOf('Limelog("Video Receive: SO_RCVTIMEO unsupported, polling before each receive\\n");');
  const mode = thread.indexOf('logVideoReceiveMode(receiveMode);');
  const loop = thread.indexOf('while (!PltIsThreadInterrupted(&receiveThread)) {');
  assert.ok(noWait > 0 && timeout > noWait && unsupported > timeout && mode > unsupported && loop > mode, 'the order of the mode decision');
  assert.match(thread, /if \(rtpSocketNoWait\) \{\s+(\/\/.*\s+)*useSelect = false;\s+receiveMode = VIDEO_RECV_MODE_NO_WAIT;\s+\}/);
  // The socket that never waits is read with recvUdpSocketNoWait(), the others as before with recvUdpSocket()
  // (since 2.3.5 into the buffer of a slot of the ring)
  assert.match(thread, /if \(receiveMode == VIDEO_RECV_MODE_NO_WAIT\) \{[\s\S]*?err = recvUdpSocketNoWait\(rtpSocket,\s+slot->buffer,\s+receiveSize,\s+&waited,\s+&socketCalls\);[\s\S]*?\}\s+else \{\s+err = recvUdpSocket\(rtpSocket,\s+slot->buffer,\s+receiveSize,\s+useSelect,\s+NULL,\s+NULL\);/);

  const start = functionBody(VIDEO, 'int startVideoStream(void* rendererContext, int drFlags) {');
  const bind = start.indexOf('rtpSocket = bindUdpSocket(RemoteAddr.ss_family, &LocalAddr, AddrLen,');
  const check = start.indexOf('if (setNonFatalRecvTimeoutMs(rtpSocket, UDP_RECV_POLL_TIMEOUT_MS) < 0) {');
  const replace = start.indexOf('SOCKET noWaitSocket = bindUdpSocketNoWait(RemoteAddr.ss_family, &LocalAddr, AddrLen,');
  const replaced = start.indexOf('rtpSocketNoWait = true;');
  const buffer = start.indexOf('getsockopt(rtpSocket, SOL_SOCKET, SO_RCVBUF');
  const ring = start.indexOf('VrrInitialize(&receiveRing, VIDEO_RECV_RING_PACKETS, slotSize)');
  const renderer = start.indexOf('VideoCallbacks.start();');
  const processing = start.indexOf('PltCreateThread("VideoProc", VideoProcessThreadProc, NULL, &processThread);');
  const threads = start.indexOf('PltCreateThread("VideoRecv"');
  assert.ok(bind > 0 && check > bind && replace > check && replaced > replace && buffer > replaced &&
    ring > buffer && renderer > ring && processing > renderer && threads > processing, 'the order of the start');
  // Only when the first socket took no receive timeout, with the same buffer and QoS, and the first one closed
  assert.match(start, /rtpSocketNoWait = false;\s+if \(setNonFatalRecvTimeoutMs\(rtpSocket, UDP_RECV_POLL_TIMEOUT_MS\) < 0\) \{\s+SOCKET noWaitSocket = bindUdpSocketNoWait\(RemoteAddr\.ss_family, &LocalAddr, AddrLen,\s+RTP_RECV_PACKETS_BUFFERED \* \(StreamConfig\.packetSize \+ MAX_RTP_HEADER_SIZE\),\s+SOCK_QOS_TYPE_VIDEO\);\s+if \(noWaitSocket != INVALID_SOCKET\) \{\s+closeSocket\(rtpSocket\);\s+rtpSocket = noWaitSocket;\s+rtpSocketNoWait = true;\s+\}\s+\}/);
  assert.match(functionBody(VIDEO, 'void initializeVideoStream(void) {'), /rtpSocketNoWait = false;/);

  // The read of the socket that never waits: one recvfrom() for a packet that is waiting, poll() only after a read that
  // found nothing, with one descriptor and up to 100 ms in all: after a poll() that said readable while the read found
  // nothing, it waits for the rest of the 100 ms
  const reads = functionBody(SOCKETS, 'int recvUdpSocketNoWait(SOCKET s, char* buffer, int size, bool* waited, int* socketCalls) {');
  assert.match(reads, /err = \(int\)recvfrom\(s, buffer, size, 0, NULL, NULL\);\s+if \(err > 0\) \{\s+return err;\s+\}/);
  assert.match(reads, /if \(!\*waited\) \{\s+waitStartMs = PltGetMillis\(\);\s+timeoutMs = UDP_RECV_POLL_TIMEOUT_MS;\s+\}/);
  assert.match(reads, /uint64_t waitedMs = PltGetMillis\(\) - waitStartMs;\s+if \(waitedMs >= UDP_RECV_POLL_TIMEOUT_MS\) \{\s+return 0;\s+\}\s+timeoutMs = UDP_RECV_POLL_TIMEOUT_MS - \(int\)waitedMs;/);
  assert.match(reads, /err = pollSockets\(&pfd, 1, timeoutMs\);/);
  assert.equal((reads.match(/\brecvfrom\(/g) || []).length, 1);
  assert.equal((reads.match(/\bpollSockets\(/g) || []).length, 1);
  // The wake of a read that waits: an empty datagram of the socket to its own address (the loopback address for the any
  // address), sent before each join of the receive thread when it reads a socket that never waits
  const wake = functionBody(SOCKETS, 'int wakeUdpSocketReader(SOCKET s) {');
  assert.match(wake, /if \(getsockname\(s, \(struct sockaddr\*\)&address, &addressLength\) == SOCKET_ERROR\) \{/);
  assert.match(wake, /if \(sendto\(s, &nothing, 0, 0, \(struct sockaddr\*\)&address, addressLength\) == SOCKET_ERROR\) \{/);
  assert.match(functionBody(VIDEO, 'static void wakeVideoReceiveThread(void) {'), /if \(rtpSocketNoWait\) \{\s+wakeUdpSocketReader\(rtpSocket\);\s+\}/);
  const joins = (VIDEO.match(/PltJoinThread\(&receiveThread\);/g) || []).length;
  assert.equal(joins, 4);
  assert.equal((VIDEO.match(/wakeVideoReceiveThread\(\);\s+(?:PltJoinThread\(&udpPingThread\);\s+)?PltJoinThread\(&receiveThread\);/g) || []).length, joins);
  // Since 2.3.5 the ring is stopped right before each wake, so that neither thread waits for the other, and the
  // processing thread is joined right after the reader
  assert.equal((VIDEO.match(/VrrStop\(&receiveRing\);\s+(?:\/\/.*\s+)*wakeVideoReceiveThread\(\);\s+(?:PltJoinThread\(&udpPingThread\);\s+)?PltJoinThread\(&receiveThread\);\s+PltJoinThread\(&processThread\);/g) || []).length, joins);
  const header = read('moonlight-common-c/src/PlatformSockets.h');
  assert.match(header, /SOCKET bindUdpSocketNoWait\(int addressFamily, struct sockaddr_storage\* localAddr, SOCKADDR_LEN addrLen, int bufferSize, int socketQosType\);/);
  assert.match(header, /int recvUdpSocketNoWait\(SOCKET s, char\* buffer, int size, bool\* waited, int\* socketCalls\);/);
});

test('since 2.3.5 the reader only reads and hands each packet with its read time to the processing thread, without a copy', () => {
  assert.match(VIDEO, /#include "Limelight-internal\.h"\n#include "VideoReceiveRing\.h"\n/);
  assert.match(VIDEO, /\n#ifndef VIDEO_RECV_RING_PACKETS\n#define VIDEO_RECV_RING_PACKETS 1024\n#endif\n/);
  assert.match(functionBody(VIDEO, 'void initializeVideoStream(void) {'), /memset\(&receiveRing, 0, sizeof\(receiveRing\)\);/);
  // The reader: a clock read per packet (that of its sample for a sampled one), the first packet's time for the limit
  // of the first frame and the lines, then the publish; a wait for room in the ring is not its work
  const reader = withoutComments(functionBody(VIDEO, 'static void VideoReceiveThreadProc(void* context) {'));
  assert.match(reader, /slot = VrrFirstSlot\(&receiveRing\);\s+while \(!PltIsThreadInterrupted\(&receiveThread\)\) \{/);
  assert.match(reader, /figures\.workUs \+= nowUs - workStartUs - workWaitedUs;/);
  assert.match(reader, /workStartUs = clockUs;\s+workSampled = true;\s+stampUs = endUs;\s+\}\s+else \{\s+stampUs = PltGetMicroseconds\(\);\s+\}/);
  assert.match(reader, /firstDataTimeMs = stampUs \/ 1000;\s+streamStartUs = stampUs;/);
  assert.match(reader, /slot = VrrPublish\(&receiveRing, err, stampUs, &workWaitedUs\);\s+if \(slot == NULL\) \{\s+break;\s+\}\s+\}\s+VrrClose\(&receiveRing\);/);
  // and nothing of the processing: no decryption, no queue, no limit of the first frame, no buffer of its own
  assert.doesNotMatch(reader, /RtpvAddPacket|PltDecryptMessage|receivedFullFrame|PltGetMillis|malloc\(|free\(/);
  // The processing thread: the limit of the first frame by the read time, the plain buffer handed to the queue and
  // replaced in its slot by a buffer of its own, the read time to the queue, and the stop of the ring when it ends the
  // stream
  const processing = withoutComments(functionBody(VIDEO, 'static void VideoProcessThreadProc(void* context) {'));
  assert.match(processing, /if \(!receivedFullFrame && slot->receiveTimeUs \/ 1000 - firstDataTimeMs >= FIRST_FRAME_TIMEOUT_SEC \* 1000\) \{\s+Limelog\("Terminating connection due to lack of a successful video frame\\n"\);\s+ListenerCallbacks\.connectionTerminated\(ML_ERROR_NO_VIDEO_FRAME\);/);
  assert.match(processing, /packetBuffer = slot->buffer;\s+slot->buffer = buffer;/);
  assert.match(processing, /queueStatus = RtpvAddPacket\(&rtpQueue, packet, length, \(PRTPV_QUEUE_ENTRY\)&packetBuffer\[decryptedSize\],\s+slot->receiveTimeUs\);/);
  assert.match(processing, /if \(queueStatus == RTPF_RET_QUEUED\) \{\s+buffer = NULL;\s+\}\s+else if \(!encrypted\) \{\s+buffer = packetBuffer;\s+\}/);
  assert.match(processing, /if \(stopping\) \{\s+VrrStop\(&receiveRing\);\s+\}/);
  assert.equal((processing.match(/\bmemcpy\(/g) || []).length, 0);
  // The slot holds a packet as the socket gives it, with the entry of the RTP queue behind a plain one
  assert.match(VIDEO, /int slotSize = StreamConfig\.packetSize \+ MAX_RTP_HEADER_SIZE \+\s+\(\(EncryptionFeaturesEnabled & SS_ENC_VIDEO\) \? \(int\)sizeof\(ENC_VIDEO_HEADER\) : \(int\)sizeof\(RTPV_QUEUE_ENTRY\)\);/);
  // The ring drops nothing: a reader that finds it full waits for room
  assert.match(functionBody(RING, 'static PVIDEO_RECV_SLOT VrrPublish('),
    /while \(ring->head - ring->tail == ring->slotCount && !ring->stopped\) \{\s+ring->readerWaiting = true;\s+PltWaitForConditionVariable\(&ring->roomCond, &ring->mutex\);/);
  // The stop: the processing thread is joined after each stop of the ring (the four with the reader, and the failed start
  // of the reader), and the ring is freed after the socket is closed, in each of the six ends
  assert.equal((VIDEO.match(/PltJoinThread\(&processThread\);/g) || []).length, 5);
  assert.equal((VIDEO.match(/VrrStop\(&receiveRing\);\s+PltJoinThread\(&processThread\);/g) || []).length, 1);
  assert.equal((VIDEO.match(/VrrStop\(&receiveRing\);/g) || []).length, 6);
  assert.equal((VIDEO.match(/VrrDestroy\(&receiveRing\);\s+VideoCallbacks\.cleanup\(\);/g) || []).length, 6);
  // The time of the read reaches the RTP queue, which reads the microsecond clock no more
  assert.match(read('moonlight-common-c/src/RtpVideoQueue.h'),
    /int RtpvAddPacket\(PRTP_VIDEO_QUEUE queue, PRTP_PACKET packet, int length, PRTPV_QUEUE_ENTRY packetEntry,\s+uint64_t receiveTimeUs\);/);
  assert.doesNotMatch(withoutComments(read('moonlight-common-c/src/RtpVideoQueue.c')), /PltGetMicroseconds/);
  // The thread pool of the module still has room for the new thread
  assert.match(read('CMakeLists.txt'), /-s PTHREAD_POOL_SIZE=20 \\/);
});

test('the receive loop uses nothing on a socket that the TV can\'t take, and the audio and STUN read as before', () => {
  const never = /MSG_DONTWAIT|FIONREAD|FIONBIO|recvmmsg|\bfcntl\(|\bioctl|\bselect\(/;
  assert.doesNotMatch(withoutComments(VIDEO), never);
  for (const signature of ['int recvUdpSocketNoWait(', 'SOCKET bindUdpSocketNoWait(', 'int wakeUdpSocketReader(']) {
    assert.doesNotMatch(withoutComments(functionBody(SOCKETS, signature)), never, signature);
  }
  // The shared body of bindUdpSocket() creates the socket as before, without setSocketNonBlocking()
  assert.match(functionBody(SOCKETS, 'static SOCKET bindUdpSocketOfType('), /s = createSocket\(addressFamily, socketType, IPPROTO_UDP, false\);/);
  // setSocketNonBlocking() still does nothing under Emscripten, where fcntl(F_SETFL) of a socket aborts the module
  assert.match(SOCKETS, /int setSocketNonBlocking\(SOCKET s, bool enabled\) \{\n#if defined\(__EMSCRIPTEN__\)\n    return SOCKET_ERROR;\n#else\n/);
  // SOCK_NONBLOCK only where the platform defines it
  let depth = 0;
  let guarded = 0;
  let uses = 0;
  withoutComments(SOCKETS).split('\n').forEach((line) => {
    if (/^\s*#\s*if/.test(line)) {
      depth++;
      if (/^\s*#\s*ifdef SOCK_NONBLOCK\s*$/.test(line) && guarded === 0) {
        guarded = depth;
      }
      return;
    }
    if (/^\s*#\s*endif/.test(line)) {
      if (guarded === depth) {
        guarded = 0;
      }
      depth--;
      return;
    }
    if (/^\s*#\s*(else|elif)/.test(line) && guarded === depth) {
      guarded = -depth;
      return;
    }
    if (/\bSOCK_NONBLOCK\b/.test(line)) {
      uses++;
      assert.ok(guarded > 0, 'SOCK_NONBLOCK outside of #ifdef SOCK_NONBLOCK: ' + line);
    }
  });
  assert.equal(uses, 1);
  assert.doesNotMatch(withoutComments(VIDEO), /SOCK_NONBLOCK/);
  // Only the video calls the new functions; the audio stream and the STUN request keep recvUdpSocket() and bindUdpSocket()
  const library = path.join(REPO_ROOT, 'moonlight-common-c/src');
  fs.readdirSync(library).filter((name) => /\.c$/.test(name) && name !== 'VideoStream.c' && name !== 'PlatformSockets.c')
    .forEach((name) => {
      assert.doesNotMatch(fs.readFileSync(path.join(library, name), 'utf8'), /\b(bindUdpSocketNoWait|recvUdpSocketNoWait|wakeUdpSocketReader)\(/, name);
    });
  for (const name of ['AudioStream.c', 'SimpleStun.c']) {
    const source = read('moonlight-common-c/src/' + name);
    assert.match(source, /= recvUdpSocket\(/, name);
    assert.match(source, /= bindUdpSocket\(/, name);
  }
});

test('the end of a stream logs its frame receive time and arrival rate, after the rate of the report', () => {
  const player = read('wasm/wasmplayer.cpp');
  const cleanup = functionBody(player, 'void MoonlightInstance::VidDecCleanup(void) {');
  const rate = cleanup.indexOf('report.arrivalMbps = FrameArrivalMbps(');
  const line = cleanup.indexOf('ClLogMessage("' + FRAME + '",');
  const few = cleanup.indexOf('ClLogMessage("' + FRAME_FEW + '",');
  assert.ok(rate > 0 && line > rate && few > line, 'the line after the rate');
  assert.match(cleanup, /if \(totals\.decodedFrames > 0\) \{\s+if \(report\.arrivalMbps > 0\) \{\s+ClLogMessage\("Frame receive of the stream: /);
  assert.match(cleanup, /\(unsigned\)\(report\.receiveTimeX100 \/ 100\), \(unsigned\)\(report\.receiveTimeX100 % 100\), \(unsigned\)report\.arrivalMbps\);/);
});

test('the redaction of the diagnostic log leaves every form of the video receive lines as it is', () => {
  const redact = loadPlatformScripts(['wasm/platform/diagnostics.js'], { globals: { Date } }).get('redactDiagnosticText');
  // The formats as the code has them (the first test pins their texts)
  const player = read('wasm/wasmplayer.cpp');
  const codeFormat = (source, start) => {
    const match = new RegExp('(?:Limelog|ClLogMessage)\\("(' + start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"]*)"').exec(source);
    assert.ok(match, start);
    return match[1];
  };
  const timeoutMode = codeFormat(VIDEO, 'Video receive mode: one recvfrom()');
  const pollMode = codeFormat(VIDEO, 'Video receive mode: no receive timeout, poll()');
  const noWaitMode = codeFormat(VIDEO, 'Video receive mode: no receive timeout, socket');
  const minute = codeFormat(VIDEO, 'Video receive, last ');
  const stream = codeFormat(VIDEO, 'Video receive of the stream, ');
  const check = codeFormat(VIDEO, 'Video receive check of the stream: ');
  const checkFailed = codeFormat(VIDEO, 'Video receive check: ');
  const procMinute = codeFormat(VIDEO, 'Video processing, last ');
  const procStream = codeFormat(VIDEO, 'Video processing of the stream, ');
  const frame = codeFormat(player, 'Frame receive of the stream: %u.%02u ms on average, frames arrive at %u');
  const frameFew = codeFormat(player, 'Frame receive of the stream: %u.%02u ms on average, frames arrive at: ');
  [
    format(timeoutMode, [100]),
    format(pollMode, []),
    format(noWaitMode, []),
    format(minute, [60, 16180, '1.00', '91', '3.2', '28.5', '362']),
    format(minute, [64, 10, '1.00', '0', 'n/a', '30.0', 'n/a']),
    format(stream, [312, 4973512, '1.00', '91', '3.2', '28.5', '362', '0.4']),
    format(stream, [1, 3, '2.00', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a']),
    format(check, [4870, '2.1', 0]),
    format(checkFailed, [28]),
    format(procMinute, [60, 16180, '14.2', '61', '809', 212, 1024, 0, 0, 37]),
    format(procStream, [312, 4973512, '14.2', '61', '809', 212, 1024, 0, 0, 2240]),
    format(procStream, [1, 3, 'n/a', '100', 'n/a', 3, 1024, 1, 12, 1]),
    format(frame, [10, '52', 276]),
    format(frameFew, [1, '00']),
  ].forEach((line) => {
    assert.equal(redact(line), line);
  });
  // The examples of the guide among them
  assert.equal(format(stream, [312, 4973512, '1.00', '91', '3.2', '28.5', '362', '0.4']),
    'Video receive of the stream, 312 s: 4973512 packets, 1.00 socket calls each, 91% were waiting; 3.2 us to read a waiting packet, 28.5 us of other work per packet: up to 362 Mbps; clock read 0.4 us');
  assert.equal(format(frame, [10, '52', 276]), 'Frame receive of the stream: 10.52 ms on average, frames arrive at 276 Mbps');
  assert.equal(format(procStream, [312, 4973512, '14.2', '61', '809', 212, 1024, 0, 0, 2240]),
    'Video processing of the stream, 312 s: 4973512 packets, 14.2 us of work each, idle 61%: up to 809 Mbps; ring up to 212 of 1024 packets, full 0 times for 0 ms; 2240 wakes');
});
