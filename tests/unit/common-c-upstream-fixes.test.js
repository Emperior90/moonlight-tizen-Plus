'use strict';

// Pins the fixes of upstream moonlight-common-c that this fork took into its vendored copy (moonlight-common-c/, based
// on upstream 8599b60 with local patches) in the code, so that a later sync or merge can't drop them unnoticed. The
// RTSP option list (5ec8397), the RTSP parser of aeba988, the loss reports of the RTP video queue (d85371c), the
// input packets of 4a95eb3, 0405384 and 448b2c6, the interceptor of ENet disconnects (41cedb8, e80a786), the audio
// socket of a failed audio start (4aa7ea4), the frame state of the depacketizer (bf71226, 348d5d1, e64327c, ae6633e,
// 0b4a44d), the HDR metadata and the queues of the control stream (74a61b9, 348d5d1), the sequence number of the
// encrypted RTSP requests (0b4a44d), audio packets without payload (18922a1), the clear of an event (a84a69a), private
// IPv6 addresses (dc09c9f), the answer of a STUN server (134eee4, 7bf16de, 2e18599, ee160c9) and the end of a stream by
// the host (host-termination.patch of Nightjar, a local change) also have native tests that run the code
// (native/rtsp_parser_test.c, native/rtp_video_queue_test.c, native/input_stream_test.c,
// native/control_stream_disconnect_test.c, native/audio_stream_start_test.c, native/video_depacketizer_test.c,
// native/control_stream_state_test.c, native/rtsp_decrypt_error_test.c, native/platform_test.c, native/stun_test.c and
// native/connection_termination_test.c); the other fixes sit in functions that need a network connection, so this
// file checks their code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, 'moonlight-common-c/src', file), 'utf8');

// The body of a C function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

test('e2722dc: the periodic ping writes its 4-byte length as 32 bits, leaving no uninitialized bytes', () => {
  const body = functionBody(read('ControlStream.c'), 'static void lossStatsThreadFunc(void* context) {');
  assert.match(body, /char periodicPingPayload\[8\];\s+BbInitializeWrappedBuffer\(&byteBuffer, periodicPingPayload, 0, sizeof\(periodicPingPayload\), BYTE_ORDER_LITTLE\);\s+BbPut32\(&byteBuffer, 4\); \/\/ Length of payload\s+BbPut32\(&byteBuffer, 0\);/);
  assert.doesNotMatch(body, /BbPut16\(&byteBuffer, 4\)/);
});

test('41cedb8: an ENet disconnect is only intercepted when it is addressed to our peer from its address', () => {
  const body = functionBody(read('ControlStream.c'), 'static int ignoreDisconnectIntercept(ENetHost* host, ENetEvent* event) {');
  const guard = body.indexOf('peerID != peer->incomingPeerID');
  const disconnect = body.indexOf('ENET_PROTOCOL_COMMAND_DISCONNECT');
  assert.ok(guard > 0 && disconnect > guard, 'the peer check must come before the disconnect is acted on');
  assert.match(body, /peer == NULL \|\|\s+peerID != peer->incomingPeerID \|\|\s+sessionID != peer->incomingSessionID \|\|\s+!enet_address_equal\(&host->receivedPeerAddress, &peer->address\)\) \{\s+return 0;\s+\}/);
});

test('e80a786: the interceptor sizes the header of a disconnect by its sentTime flag and the checksum of the host', () => {
  const body = functionBody(read('ControlStream.c'), 'static int ignoreDisconnectIntercept(ENetHost* host, ENetEvent* event) {');
  assert.match(body, /if \(host->receivedDataLength >= sizeof\(ENetProtocolCommandHeader\)\) \{/);
  assert.match(body, /size_t headerSize = \(peerID & ENET_PROTOCOL_HEADER_FLAG_SENT_TIME\) \?\s+sizeof\(ENetProtocolHeader\) :\s+sizeof\(ENetProtocolHeader\) - sizeof\(protoHeader->sentTime\);/);
  assert.match(body, /if \(host->checksum != NULL\) \{\s+headerSize \+= sizeof\(enet_uint32\);\s+\}/);
  assert.match(body, /if \(host->receivedDataLength != headerSize \+ sizeof\(ENetProtocolDisconnect\)\) \{\s+return 0;\s+\}/);
  assert.doesNotMatch(body, /receivedDataLength == sizeof\(ENetProtocolHeader\) \+ sizeof\(ENetProtocolDisconnect\)/);
});

test('7b026e7: RTSP responses are limited in size and a malformed Session header ends the handshake', () => {
  const source = read('RtspConnection.c');
  assert.match(source, /#define MAX_RTSP_RESPONSE_SIZE \(1024 \* 1024\)/);
  const enet = functionBody(source, 'static bool transactRtspMessageEnet(');
  assert.equal((enet.match(/> MAX_RTSP_RESPONSE_SIZE\)/g) || []).length, 2, 'the first and every further ENet packet');
  const tcp = functionBody(source, 'static bool transactRtspMessageTcp(');
  assert.equal((tcp.match(/MAX_RTSP_RESPONSE_SIZE\)/g) || []).length, 2, 'the buffer growth and every read');
  assert.equal((tcp.match(/\*error = EMSGSIZE;/g) || []).length, 2);
  // strtok_r() returns NULL for an empty Session header, which strdup() got before
  assert.match(source, /sessionToken = strtok_r\(sessionId, ";", &strtokCtx\);\s+if \(sessionToken == NULL \|\| sessionToken\[0\] == '\\0'\) \{/);
  assert.doesNotMatch(source, /strdup\(strtok_r\(/);
});

test('5ec8397 and d85371c are in the code the native tests run', () => {
  const insertOption = functionBody(read('RtspParser.c'), 'void insertOption(POPTION_ITEM* optionsHead, POPTION_ITEM opt) {');
  assert.match(insertOption, /if \(current == opt\) \{/);
  assert.match(insertOption, /free\(opt\);/);
  const addPacket = functionBody(read('RtpVideoQueue.c'), 'int RtpvAddPacket(');
  assert.equal((addPacket.match(/queue->reportedLostFrame = false;\s+return RTPF_RET_REJECTED;/g) || []).length, 2);
  assert.match(addPacket, /notifyFrameLost\(nvPacket->frameIndex, false\);\s+\}\s+\/\/ We dropped a block of this frame/);
  const native = (file) => fs.readFileSync(path.join(REPO_ROOT, 'tests/native', file), 'utf8');
  assert.match(native('rtsp_parser_test.c'), /#include "\.\.\/\.\.\/moonlight-common-c\/src\/RtspParser\.c"/);
  assert.match(native('rtp_video_queue_test.c'), /#include "\.\.\/\.\.\/moonlight-common-c\/src\/RtpVideoQueue\.c"/);
});

test('0fa805d: a DESCRIBE answer without content ends the handshake before its SDP is read', () => {
  const body = functionBody(read('RtspConnection.c'), 'int performRtspHandshake(PSERVER_INFORMATION serverInfo) {');
  const guard = body.indexOf('if (!response.payload) {\n            Limelog("RTSP DESCRIBE no content in response\\n");\n            ret = -1;\n            goto Exit;');
  const firstRead = body.indexOf('strstr(response.payload,');
  assert.ok(guard > 0 && firstRead > guard, 'the check must come before the first read of the payload');
});

test('dff1690: an Opus channel count above the maximum is refused before the mapping is filled', () => {
  const body = functionBody(read('RtspConnection.c'), 'static int parseOpusConfigFromParamString(');
  const guard = body.indexOf('if (channelCount > AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT) {');
  assert.ok(guard > 0 && guard < body.indexOf('opusConfig->channelCount = channelCount;'));
  assert.match(body, /Limelog\("Invalid channel count: %d\\n", channelCount\);\s+return -1;/);
});

test('20c05ed: the RTT for the statistics is read without the ENet mutex', () => {
  const body = functionBody(read('ControlStream.c'), 'bool LiGetEstimatedRttInfo(');
  assert.doesNotMatch(body, /PltLockMutex|PltUnlockMutex/);
  assert.match(body, /peer != NULL && peer->state == ENET_PEER_STATE_CONNECTED/);
});

test('342b106: a control message is encrypted in place, without a stack buffer of 256 bytes', () => {
  const body = functionBody(read('ControlStream.c'), 'static bool sendMessageEnet(');
  assert.doesNotMatch(body, /tempBuffer/);
  assert.match(body, /packet = \(PNVCTL_ENET_PACKET_HEADER_V2\)\(\(\(unsigned char\*\)\(encPacket \+ 1\)\) \+ AES_GCM_TAG_LENGTH\);/);
  assert.match(body, /enet_packet_create\(NULL,\s+sizeof\(\*encPacket\) \+ AES_GCM_TAG_LENGTH \+ sizeof\(\*packet\) \+ paylen,/);
});

test('aeba988, 4a95eb3, 0405384 and 448b2c6 are in the code the native tests run', () => {
  assert.doesNotMatch(read('Rtsp.h'), /TOKEN_OPTION/);
  assert.doesNotMatch(read('Limelight-internal.h'), /CTRL_CHANNEL_UTF8/);
  const input = read('InputStream.c');
  assert.match(functionBody(input, 'int LiSendUtf8TextEvent('), /holder->channelId = CTRL_CHANNEL_KEYBOARD;/);
  assert.match(input, /static uint32_t getUtf8CodePointLength\(const char\* utf8Text, uint32_t offset\) \{/);
  const native = (file) => fs.readFileSync(path.join(REPO_ROOT, 'tests/native', file), 'utf8');
  const inputTest = native('input_stream_test.c');
  assert.match(inputTest, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/InputStream\.c"/);
  for (const commit of ['4a95eb3', '0405384', '448b2c6']) {
    assert.ok(inputTest.includes('(upstream ' + commit + ')'), 'a test of ' + commit);
  }
  assert.ok(native('rtsp_parser_test.c').includes('(upstream aeba988)'));
});

test('4aa7ea4: a failed audio start leaves the audio socket to destroyAudioStream(), which closes it once', () => {
  const source = read('AudioStream.c');
  const start = functionBody(source, 'int startAudioStream(void* audioContext, int arFlags) {');
  assert.doesNotMatch(start, /closeSocket\(/);
  // Both error paths still stop the renderer and clean it up
  assert.equal((start.match(/AudioCallbacks\.stop\(\);/g) || []).length, 2);
  assert.equal((start.match(/AudioCallbacks\.cleanup\(\);/g) || []).length, 2);
  const destroy = functionBody(source, 'void destroyAudioStream(void) {');
  assert.match(destroy, /closeSocket\(rtpSocket\);\s+rtpSocket = INVALID_SOCKET;/);
  assert.equal((source.match(/closeSocket\(rtpSocket\)/g) || []).length, 1);
  const native = fs.readFileSync(path.join(REPO_ROOT, 'tests/native/audio_stream_start_test.c'), 'utf8');
  assert.match(native, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/AudioStream\.c"/);
  assert.ok(native.includes('(upstream 4aa7ea4)'));
});

test('bf71226, 348d5d1, e64327c, ae6633e, 0b4a44d and 74a61b9 are in the code the native tests run', () => {
  const native = (file) => fs.readFileSync(path.join(REPO_ROOT, 'tests/native', file), 'utf8');
  const depacketizerTest = native('video_depacketizer_test.c');
  assert.match(depacketizerTest, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/VideoDepacketizer\.c"/);
  for (const commit of ['bf71226', '348d5d1', 'e64327c', 'ae6633e', '0b4a44d']) {
    assert.ok(depacketizerTest.includes(commit), 'a test of ' + commit);
  }
  const controlTest = native('control_stream_state_test.c');
  assert.match(controlTest, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/ControlStream\.c"/);
  for (const commit of ['74a61b9', '348d5d1']) {
    assert.ok(controlTest.includes(commit), 'a test of ' + commit);
  }
  const rtspTest = native('rtsp_decrypt_error_test.c');
  assert.match(rtspTest, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/RtspConnection\.c"/);
  assert.ok(rtspTest.includes('0b4a44d'));
  assert.match(functionBody(read('RtspConnection.c'), 'int performRtspHandshake(PSERVER_INFORMATION serverInfo) {'),
    /\n {4}encryptionSequenceNumber = 0;\n/);
});

test('e64327c: the lock of the depacketizer is a PLT_MUTEX, released to submit a frame and to ask for the keyframe of a refresh', () => {
  const source = read('VideoDepacketizer.c');
  // Not the C11 atomics of upstream, which are untested with the fastcomp Emscripten 1.39 of Samsung
  assert.match(source, /\nstatic PLT_MUTEX stateLock;\n/);
  assert.doesNotMatch(source + read('ControlStream.c'), /stdatomic|atomic_bool|atomic_load|atomic_store/);
  // A frame submitted on the receive thread can return DR_NEED_IDR, which takes the lock again in requestDecoderRefresh()
  const reassemble = functionBody(source, 'static void reassembleFrame(int frameNumber) {');
  assert.match(reassemble, /PltUnlockMutex\(&stateLock\);\s+validateDecodeUnitForPlayback\(&qdu->decodeUnit\);\s+LiCompleteVideoFrame\(qdu, VideoCallbacks\.submitDecodeUnit\(&qdu->decodeUnit\)\);\s+PltLockMutex\(&stateLock\);/);
  const refresh = functionBody(source, 'void requestDecoderRefresh(void) {');
  const unlock = refresh.indexOf('PltUnlockMutex(&stateLock);');
  assert.ok(refresh.indexOf('PltLockMutex(&stateLock);') >= 0 && unlock > 0);
  assert.ok(unlock < refresh.indexOf('freeDecodeUnitList(') && unlock < refresh.indexOf('LiRequestIdrFrame();'));
  assert.match(functionBody(source, 'static void processRtpPayload(PNV_VIDEO_PACKET videoPacket, int length,'),
    /PltLockMutex\(&stateLock\);\s+processRtpPayloadLocked\([^;]+\);\s+PltUnlockMutex\(&stateLock\);/);
  assert.match(functionBody(source, 'void notifyFrameLost(unsigned int frameNumber, bool speculative) {'),
    /^[^{]*\{\s+PltLockMutex\(&stateLock\);[^]*PltUnlockMutex\(&stateLock\);\s+\}$/);
});

test('the decode buffer of the app takes the largest frame of the depacketizer and no more', () => {
  // native/decode_buffer_cap_test.cpp runs the cap; the two bounds are defined in two files and stay in step
  assert.match(read('VideoDepacketizer.c'), /#define MAX_VIDEO_REASSEMBLED_FRAME_SIZE \(32 \* 1024 \* 1024\)/);
  const player = fs.readFileSync(path.join(REPO_ROOT, 'wasm/wasmplayer.cpp'), 'utf8');
  assert.match(player, /#define MAX_DECODE_BUFFER_LEN \(32 \* 1024 \* 1024 \+ MAX_SPS_EXTRA_SIZE \+ MAX_HDR_METADATA_SEI_SIZE\)/);
  // Each stream logs its first frame over the cap: VidDecSetup(), which waits for the media pipeline of the TV and so
  // runs in no native test, starts the flag afresh before the media pipeline is set up
  const start = player.indexOf('int MoonlightInstance::VidDecSetup(');
  const setup = player.slice(start, player.indexOf('\n}\n', start));
  assert.match(setup, /\n {2}s_OversizedFrameLogged = false;\n/);
  assert.ok(setup.indexOf('s_OversizedFrameLogged = false;') < setup.indexOf('StartupVidDecSetup('));
});

test('18922a1, a84a69a, dc09c9f, 134eee4, 7bf16de, 2e18599 and ee160c9 are in the code the native tests run', () => {
  const native = (file) => fs.readFileSync(path.join(REPO_ROOT, 'tests/native', file), 'utf8');
  // An audio packet without payload is dropped, encrypted or not
  const decode = functionBody(read('AudioStream.c'), 'static void decodeInputData(PQUEUED_AUDIO_PACKET packet) {');
  assert.equal((decode.match(/if \(dataLength == 0\) \{\s+LC_ASSERT_VT\(false\);\s+return;\s+\}/g) || []).length, 2);
  assert.ok(native('audio_stream_start_test.c').includes('(upstream 18922a1)'));
  // The clear of an event takes the mutex of the event, as the set and the wait do
  assert.match(functionBody(read('Platform.c'), 'void PltClearEvent(PLT_EVENT* event) {'),
    /PltLockMutex\(&event->mutex\);\s+event->signalled = false;\s+PltUnlockMutex\(&event->mutex\);/);
  // The bits of an IPv6 prefix from the most significant bit of each byte on
  const sockets = read('PlatformSockets.c');
  assert.match(functionBody(sockets, 'bool isInSubnetV6('), /unsigned char mask = 0x80 >> \(i % 8\);/);
  const platformTest = native('platform_test.c');
  assert.match(platformTest, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/Platform\.c"/);
  assert.match(platformTest, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/PlatformSockets\.c"/);
  for (const commit of ['a84a69a', 'dc09c9f']) {
    assert.ok(platformTest.includes('(upstream ' + commit + ')'), 'a test of ' + commit);
  }
  // A STUN answer counts only when it is valid and comes from the address that the request went to
  const stun = read('SimpleStun.c');
  const validate = functionBody(stun, 'static bool validateStunResponse(');
  assert.ok(validate.indexOf('remoteAddrMatch') < validate.indexOf('STUN message truncated'), 'the source first');
  assert.match(validate, /if \(\(stunBodyLen & 0x3\) != 0\) \{/);
  assert.match(validate, /else if \(bytesRead < \(int\)\(sizeof\(STUN_MESSAGE\) \+ stunBodyLen\)\) \{/);
  assert.match(stun, /int attrPaddedLen = \(attrLen \+ 3\) & ~3;/);
  assert.equal((stun.match(/validResponse = validateStunResponse\(bytesRead, &reqMsg, &resp\.hdr, stunAddrs, &remoteAddr\);/g) || []).length, 2);
  // Every caller of recvUdpSocket() names the source address it wants, or NULL
  assert.match(read('PlatformSockets.h'), /int recvUdpSocket\(SOCKET s, char\* buffer, int size, bool useSelect,\s+struct sockaddr_storage\* remoteAddr, SOCKADDR_LEN\* addrLen\);/);
  for (const file of ['AudioStream.c', 'VideoStream.c', 'SimpleStun.c']) {
    const calls = read(file).match(/= recvUdpSocket\([^;]*\);/g) || [];
    assert.ok(calls.length > 0, file);
    calls.forEach((call) => assert.equal(call.split(',').length, 6, file + ': ' + call));
  }
  const stunTest = native('stun_test.c');
  assert.match(stunTest, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/SimpleStun\.c"/);
  for (const commit of ['134eee4', '7bf16de', '2e18599', 'ee160c9']) {
    assert.ok(stunTest.includes('(upstream ' + commit + ')'), 'a test of ' + commit);
  }
});

test('the host termination reason is taken before the ENet peer is disconnected, and claimed under a PLT_MUTEX', () => {
  // The local change of host-termination.patch of Nightjar, which native/connection_termination_test.c runs
  const receive = functionBody(read('ControlStream.c'), 'static void controlReceiveThreadFunc(void* context) {');
  const termination = receive.slice(receive.indexOf('packetTypes[IDX_TERMINATION]'));
  const callback = termination.indexOf('ListenerCallbacks.connectionTerminated((int)terminationErrorCode);');
  const disconnect = termination.indexOf('enet_peer_disconnect_now(peer, 0);');
  assert.ok(callback > 0 && disconnect > callback, 'the reason of the host is reported before the disconnect');
  const connection = read('Connection.c');
  // Not the atomic exchange of upstream and of Nightjar: C11 atomics are untested with the fastcomp Emscripten 1.39
  assert.doesNotMatch(connection, /stdatomic|atomic_bool|atomic_exchange|atomic_store/);
  assert.match(connection, /\nstatic PLT_MUTEX terminationMutex;\n/);
  assert.match(functionBody(connection, 'static void ClInternalConnectionTerminated(int errorCode)'),
    /PltLockMutex\(&terminationMutex\);\s+if \(alreadyTerminated \|\| ConnectionInterrupted\) \{\s+PltUnlockMutex\(&terminationMutex\);\s+return;\s+\}\s+terminationCallbackErrorCode = errorCode;\s+alreadyTerminated = true;\s+PltUnlockMutex\(&terminationMutex\);/);
  // The mutex exists before the first stage that starts a thread and until the last of them is undone
  const start = functionBody(connection, 'int LiStartConnection(');
  const created = start.indexOf('PltCreateMutex(&terminationMutex)');
  assert.ok(created > 0 && created < start.indexOf('alreadyTerminated = false;'));
  assert.ok(created < start.indexOf('initializePlatform()'));
  const stop = functionBody(connection, 'void LiStopConnection(void) {');
  const deleted = stop.indexOf('PltDeleteMutex(&terminationMutex);');
  assert.ok(deleted > stop.indexOf('destroyAudioStream();') && deleted < stop.indexOf('cleanupPlatform();'));
  const native = fs.readFileSync(path.join(REPO_ROOT, 'tests/native/connection_termination_test.c'), 'utf8');
  assert.match(native, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/Connection\.c"/);
  assert.match(native, /#include "\.\.\/\.\.\/moonlight-common-c\/src\/ControlStream\.c"/);
});
