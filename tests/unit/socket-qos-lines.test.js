'use strict';

// Checks the lines about the QoS of the sockets of a stream that moonlight-common-c logs since 2.3.2 (logSocketQos() of
// moonlight-common-c/src/PlatformSockets.c; the lines themselves are run by tests/native/socket_qos_test.c):
// - bindUdpSocket() logs the line of the video and the audio socket after the receive buffer size of the socket, with
//   the outcome of setSocketQos(), whose options and values stay as they were (the line only reads); since 2.3.4 its
//   body is bindUdpSocketOfType(), which bindUdpSocket() calls with SOCK_DGRAM and bindUdpSocketNoWait() (the socket of
//   the video that never waits) with SOCK_DGRAM | SOCK_NONBLOCK, so that both bind and log alike;
// - the control stream logs the line of its ENet socket right after ENet set the DSCP marking, before it connects;
// - the redaction of the diagnostic log (wasm/platform/diagnostics.js) leaves every form of the line as it is, since it
//   names no address, port or ID.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const SOCKETS = read('moonlight-common-c/src/PlatformSockets.c');

// The body of a C function of a source, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

test('bindUdpSocket() logs the QoS of the video and audio sockets after their receive buffer, and sets it as before', () => {
  const bind = functionBody(SOCKETS, 'static SOCKET bindUdpSocketOfType(');
  assert.match(bind, /^static SOCKET bindUdpSocketOfType\(int addressFamily, int socketType, struct sockaddr_storage\* localAddr, SOCKADDR_LEN addrLen, int bufferSize, int socketQosType\) \{/);
  assert.match(bind, /\n    s = createSocket\(addressFamily, socketType, IPPROTO_UDP, false\);\n/);
  // bindUdpSocket() and the socket of the video that never waits (2.3.4) share it, with only the type of the socket
  assert.match(functionBody(SOCKETS, 'SOCKET bindUdpSocket('),
    /^SOCKET bindUdpSocket\([^)]*\) \{\n    return bindUdpSocketOfType\(addressFamily, SOCK_DGRAM, localAddr, addrLen, bufferSize, socketQosType\);\n\}$/);
  assert.match(functionBody(SOCKETS, 'SOCKET bindUdpSocketNoWait('),
    /\n#ifdef SOCK_NONBLOCK\n    return bindUdpSocketOfType\(addressFamily, SOCK_DGRAM \| SOCK_NONBLOCK, localAddr, addrLen, bufferSize, socketQosType\);\n#else\n[^\n]*\n    return INVALID_SOCKET;\n#endif\n\}$/);
  const set = bind.indexOf('qosResult = setSocketQos(s, socketQosType);');
  const actual = bind.indexOf('Limelog("Actual receive buffer size: %d\\n", bufferSize);');
  const log = bind.indexOf('logSocketQos(s, addressFamily, socketQosType == SOCK_QOS_TYPE_VIDEO ? "Video" :');
  assert.ok(set > 0 && actual > set && log > actual, 'set, then the receive buffer, then the QoS line');
  // Only for a socket with QoS, and as the last step before the socket is handed out
  assert.match(bind.slice(log - 120), /^[\s\S]*if \(socketQosType != SOCK_QOS_TYPE_BEST_EFFORT\) \{\s+logSocketQos\(/);
  assert.match(bind.slice(log), /^[^;]*;\s+\}\s+return s;\s+\}$/);

  // setSocketQos() sets the same options with the same values as upstream, and only reports what happened
  const qos = functionBody(SOCKETS, 'static int setSocketQos(SOCKET s, int socketQosType) {');
  assert.equal((qos.match(/\bsetsockopt\(s, /g) || []).length, 2);
  assert.match(qos, /setsockopt\(s, SOL_SOCKET, SO_NET_SERVICE_TYPE, \(char\*\)&value, sizeof\(value\)\) < 0/);
  assert.match(qos, /setsockopt\(s, SOL_SOCKET, SO_PRIORITY, \(char\*\)&value, sizeof\(value\)\) < 0/);
  assert.match(qos, /case SOCK_QOS_TYPE_AUDIO:\s+value = 6;\s+break;\s+case SOCK_QOS_TYPE_VIDEO:\s+value = 5;/);
  assert.match(qos, /Limelog\("setsockopt\(SO_PRIORITY, %d\) failed: %d\\n", value, result\);/);

  // logSocketQos() reads the type of service and changes nothing on the socket
  const line = functionBody(SOCKETS, 'void logSocketQos(SOCKET s, int addressFamily, const char* name, int priorityResult) {');
  assert.doesNotMatch(line, /\bsetsockopt\(|\bioctl|\bfcntl\(/);
  assert.equal((line.match(/\bgetsockopt\(/g) || []).length, 1);
  assert.match(line, /Limelog\("%s socket QoS: %s%s\\n", name, priority, typeOfService\);/);
  assert.match(read('moonlight-common-c/src/PlatformSockets.h'),
    /void logSocketQos\(SOCKET s, int addressFamily, const char\* name, int priorityResult\);/);
});

test('the control stream logs the QoS of its ENet socket right after ENet marked it, before it connects', () => {
  const control = read('moonlight-common-c/src/ControlStream.c');
  assert.match(control, /enet_socket_set_option \(client->socket, ENET_SOCKOPT_QOS, 1\);\n\n(?:\s*\/\/.*\n)+\s*logSocketQos\(client->socket, RemoteAddr\.ss_family, "Control", SOCK_QOS_NOT_SET_HERE\);\n\n(?:\s*\/\/.*\n)*\s*peer = enet_host_connect\(/);
  assert.equal((control.match(/\blogSocketQos\(/g) || []).length, 1);
  // ENet still marks the socket itself, with Expedited Forwarding and ECT(1) as the native test expects (0xB9)
  assert.match(read('moonlight-common-c/enet/unix.c'), /value = value \? \(46 << 2 \| 0x01\) : 0; \/\/ DSCP: Expedited Forwarding \+ ECT\(1\) \(L4S\)\n\s+result = setsockopt \(socket, IPPROTO_IP, IP_TOS/);
});

test('the redaction of the diagnostic log leaves every form of the QoS line as it is', () => {
  const redact = loadPlatformScripts(['wasm/platform/diagnostics.js'], { globals: { Date } }).get('redactDiagnosticText');
  [
    'Video socket QoS: priority set, IP_TOS 0x00',
    'Audio socket QoS: priority not set (error 50), IP_TOS unknown (error 138)',
    'Video socket QoS: no priority option, IPV6_TCLASS 0x00',
    'Audio socket QoS: priority set, IPV6_TCLASS unknown (error 138)',
    'Control socket QoS: IP_TOS 0xB9',
    'Control socket QoS: no IP_TOS option',
  ].forEach((line) => {
    assert.equal(redact(line), line);
  });
});
