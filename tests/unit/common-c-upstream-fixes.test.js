'use strict';

// Pins the fixes of upstream moonlight-common-c that this fork took into its vendored copy (moonlight-common-c/, based
// on upstream 8599b60 with local patches) in the code, so that a later sync or merge can't drop them unnoticed. The
// RTSP option list (5ec8397), the RTSP parser of aeba988, the loss reports of the RTP video queue (d85371c) and the
// input packets of 4a95eb3, 0405384 and 448b2c6 also have native tests that run the code (native/rtsp_parser_test.c,
// native/rtp_video_queue_test.c and native/input_stream_test.c); the other fixes sit in functions that need a network
// connection, so this file checks their code.

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
