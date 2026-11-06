'use strict';

// Pins wasm/platform/diagnostics.js: what the log hides (the remote input keys, the pairing secrets and PIN, the unique
// ID, the RTSP session URL, the public IP address, also by its value in a URL once utils.js or index.js hands it over,
// and every MAC address but the all-zero one, also in a host object that the line cuts) and what it keeps (the
// local addresses and the names of the PCs), the log of the current and the previous session (a new session for each stream, the
// lines of the console with the style of '%c' left out and the console still getting them, the lines that only repeat
// the overlay left out, a repeated line counted, the oldest lines dropped when a session is full, the native lines of the
// module merged by their time and hidden the same way), the report of the last session read from the messages of
// tests/fixtures/session-reports.tsv with their hints and its lines for System information, and the heartbeat of a stream
// that reports once at the next start that the app ended during it (not for a stream in the background), that the
// native lines come from the ring that every log line of the module enters, that the module sets the listener that logs
// the errors of the media element, and that each stream starts the host figures of its report from zero.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { webcrypto } = require('crypto');
const { createPlatformContext, loadPlatformScripts, plain } = require('./helpers/platform-loader');

// Load diagnostics.js with a clock of the test (Date.now()), a module stub whose native lines a test sets, and an
// interval that the test runs by hand
function loadDiagnostics(options) {
  const opts = options || {};
  const clock = { now: opts.now || 1700000000000 };
  const RealDate = Date;
  function TestDate(value) {
    return new RealDate(value === undefined ? clock.now : value);
  }
  TestDate.now = () => clock.now;
  const intervals = [];
  const module = { nativeLog: '', takeDiagnosticLog() {
    const lines = this.nativeLog;
    this.nativeLog = '';
    return lines;
  } };
  const platform = loadPlatformScripts(['wasm/platform/diagnostics.js'], {
    globals: Object.assign({
      t: (text, ...args) => args.reduce((result, arg, index) => result.split('%' + (index + 1) + '$s').join(String(arg)), text),
      Date: TestDate,
      Module: module,
      setInterval: (fn) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: (id) => {
        intervals[id - 1] = null;
      },
    }, opts.globals || {}),
  });
  return { platform, clock, module, intervals, log: platform.get('DiagnosticLog') };
}

// The texts of the lines of a session, without their time and source
function texts(session) {
  return plain(session.lines).map((line) => line.replace(/^\d\d:\d\d:\d\d\.\d{3} (native|app   ) /, ''));
}

test('the log hides the input keys, the pairing secrets, the PIN, the unique ID and the RTSP address', () => {
  const redact = loadDiagnostics().platform.get('redactDiagnosticText');
  const cases = [
    ['https://10.0.0.2:47984/launch?uniqueid=0123456789ABCDEF&appid=8&rikey=00112233445566778899aabbccddeeff&rikeyid=12345678&localAudioPlayMode=0',
      'https://10.0.0.2:47984/launch?uniqueid=<hidden>&appid=8&rikey=<hidden>&rikeyid=<hidden>&localAudioPlayMode=0'],
    ['pair?devicename=roth&updateState=1&phrase=getservercert&salt=00ff&clientcert=ABCD', 'pair?devicename=roth&updateState=1&phrase=getservercert&salt=<hidden>&clientcert=<hidden>'],
    ['pair?clientchallenge=11&serverchallengeresp=22&clientpairingsecret=33', 'pair?clientchallenge=<hidden>&serverchallengeresp=<hidden>&clientpairingsecret=<hidden>'],
    ['Setting the RTSP session URL to: rtsp://10.0.0.2:48010', 'Setting the RTSP session URL to: rtsp://<hidden>'],
    ['sessionUrl0 rtspenc://192.168.1.20:48010/x and RTSPRU://host:1', 'sessionUrl0 rtsp://<hidden> and rtsp://<hidden>'],
    ['Please enter the PIN 4711 on the PC', 'Please enter the PIN <hidden> on the PC'],
    ['rikey: 0011aabb, pin=1234; uniqueid is ABCDEF', 'rikey: <hidden>, pin=<hidden>; uniqueid is <hidden>'],
  ];
  cases.forEach(([text, expected]) => assert.equal(redact(text), expected));
  // Other lines stay as they are, e.g. numbers that only look like a PIN and words that start with pin
  ['Paired host address: 10.0.0.2:47989 with result: 0', 'Spinning 1234 frames', 'Pinned 4 apps', 'Starting RTSP handshake...']
    .forEach((text) => assert.equal(redact(text), text));
  assert.equal(redact(null), '');
});

test('the log hides the unique ID of the client in every form that the app logs, and the values it knows anywhere', () => {
  const app = loadDiagnostics();
  const redact = app.platform.get('redactDiagnosticText');
  const cases = [
    // NvHTTP.toString() (utils.js) of host polling, the app list and errors
    ['Stopping background polling of host: 10.0.0.2\r\nhostname: GAMING-PC\r\nclient UID: 0123456789ABCDEF\r\nserver UID: 7A3F',
      'Stopping background polling of host: 10.0.0.2\r\nhostname: GAMING-PC\r\nclient UID: <hidden>\r\nserver UID: 7A3F'],
    // A host object as JSON (formatConsoleArguments()), also inside a JSON string
    ['Current host object: {"hostname":"PC","clientUid":"0123456789ABCDEF","serverUid":"7A3F"}',
      'Current host object: {"hostname":"PC","clientUid":"<hidden>","serverUid":"7A3F"}'],
    ['{"value":"{\\"uniqueid\\":\\"0123456789ABCDEF\\",\\"x\\":1}"}', '{"value":"{\\"uniqueid\\":\\"<hidden>\\",\\"x\\":1}"}'],
    // getData() and getMultipleData() of index.js at every start, and storeMultipleData() of a fresh install
    ['Reading data from DB key: uniqueid with value: "0123456789ABCDEF"', 'Reading data from DB key: uniqueid with value: <hidden>'],
    ['Reading data from DB keys: uniqueid, settingsSchema with values: {"uniqueid":"0123456789ABCDEF","settingsSchema":3}',
      'Reading data from DB keys: uniqueid, settingsSchema with values: {"uniqueid":"<hidden>","settingsSchema":3}'],
    ['Storing data at keys: uniqueid, settingsSchema with data: {"uniqueid":"0123456789ABCDEF","settingsSchema":3}',
      'Storing data at keys: uniqueid, settingsSchema with data: {"uniqueid":"<hidden>","settingsSchema":3}'],
    // The client certificate with its private key, as it is read, stored or made
    ['Reading data from DB key: cert with value: {"cert":{"cert":"-----BEGIN CERTIFICATE-----\\nMIIC","privateKey":"-----BEGIN PRIVATE KEY-----\\nMIIE"}}',
      'Reading data from DB key: cert with value: <hidden>'],
    ['Generated new certificate:  {"cert":"-----BEGIN CERTIFICATE-----\\nMIIC\\n","privateKey":"-----BEGIN PRIVATE KEY-----\\nMIIEv\\n-----END PRIVATE KEY-----\\n"}',
      'Generated new certificate:  {"cert":"-----BEGIN CERTIFICATE-----\\nMIIC\\n","privateKey":"<hidden>"}'],
    ['key\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nend', 'key\n<hidden>\nend'],
  ];
  cases.forEach(([text, expected]) => assert.equal(redact(text), expected));

  // The unique ID and the remote input key of the latest start, once the app knows them, wherever they appear: in a
  // line kept afterwards and in one that the log kept before
  app.platform.run(`console.log('Pairing with 0123456789ABCDEF as 0123456789abcdef0123456789abcdef');`);
  const hide = app.platform.get('hideDiagnosticValue');
  hide('uniqueid', '0123456789ABCDEF');
  hide('rikey', '0123456789abcdef0123456789abcdef');
  // A short value is never hidden, since it could be an ordinary word or number
  hide('rikey2', '1234');
  app.platform.run(`
    console.log('Unknown answer of 10.0.0.2 for 0123456789ABCDEF');
    console.log('Remote input key 0123456789abcdef0123456789abcdef in use, 1234 frames');
  `);
  assert.deepEqual(texts(app.log.getSessions()[0]), [
    'Pairing with <hidden> as <hidden>',
    'Unknown answer of 10.0.0.2 for <hidden>',
    'Remote input key <hidden> in use, 1234 frames',
  ]);
  // A new start replaces the key it hides
  hide('rikey', 'ffeeddccbbaa99887766554433221100');
  assert.equal(redact('ffeeddccbbaa99887766554433221100 and 0123456789ABCDEF'), '<hidden> and <hidden>');
});

test('the log hides the public IP address and the MAC addresses, but keeps the all-zero MAC, the local addresses and the PC names', () => {
  const app = loadDiagnostics();
  const redact = app.platform.get('redactDiagnosticText');
  const cases = [
    // NvHTTP.toString() (utils.js), which errors of the host polling and the app list print
    ['host name: GAMING-PC\r\nhost address: 192.168.1.20\r\nlocal address: 192.168.1.20\r\nexternal IP: 203.0.113.7\r\nmac address: 3C:7C:3F:12:AB:CD\r\nhttps port: 47984',
      'host name: GAMING-PC\r\nhost address: 192.168.1.20\r\nlocal address: 192.168.1.20\r\nexternal IP: <hidden>\r\nmac address: <hidden>\r\nhttps port: 47984'],
    // The line of the STUN result before 2.2.0, in a log of an older build
    ['[utils.js, updateExternalAddressIP4] External IPv4 address of GAMING-PC is 203.0.113.7',
      '[utils.js, updateExternalAddressIP4] External IPv4 address of GAMING-PC is <hidden>'],
    // A host object as JSON (the stored hosts, formatConsoleArguments()), also inside a JSON string
    ['Storing data at key: hosts with data: {"A1":{"hostname":"GAMING-PC","address":"192.168.1.20","externalIP":"203.0.113.7","macAddress":"3c-7c-3f-12-ab-cd"}}',
      'Storing data at key: hosts with data: {"A1":{"hostname":"GAMING-PC","address":"192.168.1.20","externalIP":"<hidden>","macAddress":"<hidden>"}}'],
    ['{"value":"{\\"externalIP\\":\\"203.0.113.7\\",\\"x\\":1}"}', '{"value":"{\\"externalIP\\":\\"<hidden>\\",\\"x\\":1}"}'],
    // The server info of the host
    ['<ExternalIP>203.0.113.7</ExternalIP><LocalIP>192.168.1.20</LocalIP><mac>3c:7c:3f:12:ab:cd</mac>',
      '<ExternalIP><hidden></ExternalIP><LocalIP>192.168.1.20</LocalIP><mac><hidden></mac>'],
    // Wake-on-LAN (index.js and the native lines of main.cpp): the all-zero MAC of a host that never reported its MAC stays
    ['Updated MAC address for host GAMING-PC from 00:00:00:00:00:00 to 3C:7C:3F:12:AB:CD',
      'Updated MAC address for host GAMING-PC from 00:00:00:00:00:00 to <hidden>'],
    ['Sent 6 of 6 magic packets to MAC address: 3C:7C:3F:12:AB:CD (subnet broadcast: 192.168.1.255)',
      'Sent 6 of 6 magic packets to MAC address: <hidden> (subnet broadcast: 192.168.1.255)'],
    // A host without a public address yet (the default of NvHTTP, logged by its constructor): the label of the next line stays
    ['local address: 192.168.1.20\r\nexternal IP: \r\nmac address: 3C:7C:3F:12:AB:CD\r\n',
      'local address: 192.168.1.20\r\nexternal IP: \r\nmac address: <hidden>\r\n'],
    ['external IP: \nmac address: undefined', 'external IP: \nmac address: undefined'],
  ];
  cases.forEach(([text, expected]) => assert.equal(redact(text), expected));
  // What support needs stays: the all-zero MAC, local and link-local addresses, times and other hex numbers
  ['Not sending a magic packet: the MAC address of the host is unknown (00:00:00:00:00:00)', 'Invalid MAC address format: 00-00-00-00-00-00',
    'Found host with IP address: 192.168.1.20', 'Looking for the external IPv4 address of GAMING-PC...', 'fe80::1a2b:3c4d at 12:34:56',
    'Error: External IPv4 address lookup failed!', 'aa:bb:cc:dd:ee', 'external port: 47989']
    .forEach((text) => assert.equal(redact(text), text));
  // The native lines of the module are hidden the same way
  app.module.nativeLog = app.clock.now + '\tSent 6 of 6 magic packets to MAC address: 3c:7c:3f:12:ab:cd (subnet broadcast: 192.168.1.255)\n';
  assert.deepEqual(texts(app.log.getSessions()[0]), ['Sent 6 of 6 magic packets to MAC address: <hidden> (subnet broadcast: 192.168.1.255)']);
  // The app no longer logs the address that STUN found, and NvHTTP.toString() keeps the labels that the log hides
  const utils = fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/js/utils.js'), 'utf8');
  const stun = utils.slice(utils.indexOf('updateExternalAddressIP4: function()'), utils.indexOf('pair: function('));
  assert.ok(stun.length > 0);
  (stun.match(/console\.\w+\([^\n]*/g) || []).forEach((line) => assert.doesNotMatch(line, /externalIP|addr\b/, line));
  assert.match(utils, /string \+= 'external IP: ' \+ this\.externalIP/);
  assert.match(utils, /string \+= 'mac address: ' \+ this\.macAddress/);
});

test('the log hides a public address that the app learnt wherever it appears, e.g. in the URLs of requests to a host that does not answer', () => {
  const app = loadDiagnostics();
  const redact = app.platform.get('redactDiagnosticText');
  const hide = app.platform.get('hideDiagnosticAddress');
  // A poll of the address that STUN found, kept before the app learnt it, is hidden once the log is shown
  app.platform.run(`console.warn('%c[utils.js, _openUrlWithTimeout]', 'color: orange;', 'Skipping dead/hanging URL to prevent C++ WASM freeze: https://203.0.113.7:47984/serverinfo?uniqueid=0123456789ABCDEF&uuid=1234');`);
  hide('203.0.113.7');
  assert.deepEqual(texts(app.log.getSessions()[0]),
    ['W [utils.js, _openUrlWithTimeout] Skipping dead/hanging URL to prevent C++ WASM freeze: https://<hidden>:47984/serverinfo?uniqueid=<hidden>&uuid=1234']);
  // The lines of _openUrlWithTimeout() (utils.js) and sendMessage() (messages.js), the native lines and a host as text
  const cases = [
    ['Skipping dead/hanging URL to prevent C++ WASM freeze: https://203.0.113.7:47984/serverinfo?uniqueid=X&uuid=1234',
      'Skipping dead/hanging URL to prevent C++ WASM freeze: https://<hidden>:47984/serverinfo?uniqueid=<hidden>&uuid=1234'],
    ['Warning: HTTPS request timed out, canceling C++ HTTP request for URL: http://203.0.113.7:47989/serverinfo?uniqueid=X',
      'Warning: HTTPS request timed out, canceling C++ HTTP request for URL: http://<hidden>:47989/serverinfo?uniqueid=<hidden>'],
    ['Connecting to 203.0.113.7.', 'Connecting to <hidden>.'],
    ['host address: 203.0.113.7\r\nlocal address: 192.168.1.20', 'host address: <hidden>\r\nlocal address: 192.168.1.20'],
  ];
  cases.forEach(([text, expected]) => assert.equal(redact(text), expected));
  // Only the whole address: other addresses that start or end like it, and a GFE version, stay
  ['203.0.113.70 and 1203.0.113.7 and 203.0.113.7.5', 'gfe version: 3.23.0.74'].forEach((text) => assert.equal(redact(text), text));
  // An IPv6 address as well, but not a private, loopback or link-local address, or text that only looks like an address
  hide('2001:db8:85a3::8a2e:370:7334');
  assert.equal(redact('http://[2001:DB8:85A3::8A2E:370:7334]:47989/serverinfo and 2001:db8:85a3::8a2e:370:73345'),
    'http://[<hidden>]:47989/serverinfo and 2001:db8:85a3::8a2e:370:73345');
  ['192.168.1.20', '10.0.0.2', '172.16.5.4', '127.0.0.1', '169.254.1.2', 'fe80::1', 'fd00::2', '::1', '12:34:56', '3C:7C:3F:12:AB:CD',
    'GAMING-PC', '', undefined].forEach((address) => hide(address));
  ['Polling 192.168.1.20, 10.0.0.2, 172.16.5.4, 127.0.0.1 and 169.254.1.2', 'fe80::1 fd00::2 ::1 at 12:34:56', 'host name: GAMING-PC']
    .forEach((text) => assert.equal(redact(text), text));
  // A host object as JSON is hidden before formatConsoleArguments() cuts it, so a MAC address cut in half is hidden too
  const host = { hostname: 'Living Room Gaming PC RTX 4090 Ti (2)', address: '192.168.1.20', userEnteredAddress: '192.168.1.20',
    localAddress: '192.168.1.20', externalIP: '198.51.100.23', macAddress: '3C:7C:3F:12:AB:CD', httpsPort: 47984 };
  assert.match(JSON.stringify(host).slice(0, 200), /"macAddress":"3C:7C:3F:12:AB$/, 'the cut falls inside the MAC address');
  const formatted = app.log.formatConsoleArguments(['Error: Failed to contact the PC!', host]);
  assert.match(formatted, /"externalIP":"<hidden>","macAddress":"<hidden>"/);
  ['198.51.100.23', '3C:7C', 'AB:CD'].forEach((secret) => assert.equal(formatted.indexOf(secret), -1, secret));
  // A value that the cut left without its closing quote is hidden up to the end of its line, not into the next lines
  assert.equal(redact('{"hostname":"PC","clientUid":"<hid \nhost name: PC\r\nexternal IP: 203.0.113.7\r\nclient UID: 0123456789ABCDEF'),
    '{"hostname":"PC","clientUid":"<hidden>\nhost name: PC\r\nexternal IP: <hidden>\r\nclient UID: <hidden>');
});

test('the app hands every public address of a host to the log: from STUN, the server info and the stored hosts', async () => {
  // STUN (updateExternalAddressIP4() of utils.js), with diagnostics.js loaded before utils.js as in index.html
  const platform = createPlatformContext({
    globals: { crypto: webcrypto, sendMessage: (method) => Promise.resolve(method === 'STUN' ? '198.51.100.23' : null) },
  });
  platform.load('wasm/platform/diagnostics.js');
  platform.load('wasm/static/js/utils.js');
  const host = platform.run('new NvHTTP("192.168.1.20", "0123456789abcdef", "", "")');
  await host.updateExternalAddressIP4();
  assert.equal(host.externalIP, '198.51.100.23');
  assert.equal(platform.get('redactDiagnosticText')('Skipping dead/hanging URL: https://198.51.100.23:47984/serverinfo'),
    'Skipping dead/hanging URL: https://<hidden>:47984/serverinfo');
  // A host logged as an object and with NvHTTP.toString(), as index.js does: the object is cut after its hidden client
  // UID, and the lines of toString() stay readable with their values hidden
  host.hostname = 'GAMING-PC';
  host.macAddress = '3C:7C:3F:12:AB:CD';
  platform.context.loggedHost = host;
  platform.run(`console.log('%c[index.js, showApps]', 'color: green;', 'Current host object: \\n', loggedHost, '\\n' + loggedHost.toString());`);
  const sessions = platform.get('DiagnosticLog').getSessions();
  const line = sessions[sessions.length - 1].lines.filter((text) => text.indexOf('Current host object') >= 0)[0];
  assert.match(line, /"clientUid":"<hidden> host name: GAMING-PC host address: 192\.168\.1\.20 local address: {2}external IP: <hidden> mac address: <hidden> /);
  ['198.51.100.23', '3C:7C:3F:12:AB:CD', '0123456789abcdef'].forEach((secret) => assert.equal(line.indexOf(secret), -1, secret));
  // <ExternalIP> of the server info (_parseServerInfo() needs jQuery, which the browser tests have) and the stored hosts
  const utils = fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/js/utils.js'), 'utf8');
  assert.match(utils, /this\.externalIP = externIP;[^]{0,200}?hideDiagnosticAddress\(externIP\);/);
  const index = fs.readFileSync(path.join(REPO_ROOT, 'wasm/platform/index.js'), 'utf8');
  assert.match(index, /revivedHost\.externalIP = hosts\[hostUID\]\.externalIP;[^]{0,250}?hideDiagnosticAddress\(revivedHost\.externalIP\);/);
  // Every place that sets the public address of a host is one of these three
  assert.deepEqual((utils + index).match(/\w+\.externalIP = [^;]+;/g),
    ["this.externalIP = '';", 'this.externalIP = externIP;', 'this.externalIP = addr;', 'revivedHost.externalIP = hosts[hostUID].externalIP;']);
});

test('the console lines go into the log without their styles, and the console still gets them', () => {
  const app = loadDiagnostics();
  app.platform.run(`
    console.log('%c[index.js, startGame]', 'color: green;', 'Starting app 8 with', { width: 3840 }, 7);
    console.warn('%c[gamepad.js, Rumble]', 'color: gray;', 'Warning: no actuator');
    console.error(new Error('broken'));
  `);
  const session = app.log.getSessions()[0];
  assert.deepEqual(texts(session), [
    '[index.js, startGame] Starting app 8 with {"width":3840} 7',
    'W [gamepad.js, Rumble] Warning: no actuator',
    'E Error: broken',
  ]);
  // The console of the page still got every call with its arguments
  const messages = app.platform.consoleMessages.map((entry) => entry.level + ' ' + entry.text);
  assert.deepEqual(messages, ['log %c[index.js, startGame] color: green; Starting app 8 with [object Object] 7',
    'warn %c[gamepad.js, Rumble] color: gray; Warning: no actuator', 'error Error: broken']);
});

test('the overlay messages stay out, a repeated line is counted, and a full session drops its oldest lines', () => {
  const app = loadDiagnostics();
  app.platform.run(`
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', 'StatMsg: {"rtt":3,"lost":0}');
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', 'StatCompactMsg: {"w":3840}');
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', 'Connection Established');
  `);
  for (let i = 0; i < 5; i++) {
    app.clock.now += 100;
    app.log.add('Input queue reached maximum size limit');
  }
  app.clock.now += 2000;
  app.log.add('Input queue reached maximum size limit');
  assert.deepEqual(texts(app.log.getSessions()[0]), [
    '[messages.js, handleMessage] Message data:  Connection Established',
    'Input queue reached maximum size limit',
    '(the line before came 4 more times)',
    'Input queue reached maximum size limit',
  ]);
  for (let i = 0; i < 700; i++) {
    app.log.add('Line ' + i);
  }
  const lines = texts(app.log.getSessions()[0]);
  assert.equal(lines.length, 601);
  assert.equal(lines[0], '… 104 earlier lines are no longer kept');
  assert.equal(lines[1], 'Line 100');
  assert.equal(lines[600], 'Line 699');
});

test('each stream starts a session: the log keeps the current and the previous one, with the native lines by time', () => {
  const app = loadDiagnostics();
  app.log.add('Before the first stream');
  // Lines of the module that came before and after a line of the app
  app.module.nativeLog = (app.clock.now - 5) + '\tEMSS::OnOpen\n' + (app.clock.now + 5) + '\tRTSP handshake with rtsp://10.0.0.2:48010\n';
  app.clock.now += 10;
  app.log.startSession('stream');
  app.log.add('First stream');
  app.clock.now += 10;
  app.log.startSession('stream');
  app.log.add('Second stream');
  app.module.nativeLog = (app.clock.now + 1) + '\tVIDEO ElementaryMediaTrack::OnTrackOpen\n';
  const sessions = plain(app.log.getSessions());
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((session) => session.current), [false, true]);
  // The lines before the first stream are gone, the native lines are merged by their time and hidden like the others
  assert.deepEqual(texts(sessions[0]), ['First stream']);
  assert.deepEqual(texts(sessions[1]), ['Second stream', 'VIDEO ElementaryMediaTrack::OnTrackOpen']);
  assert.match(sessions[1].lines[1], /^\d\d:\d\d:\d\d\.\d{3} native VIDEO/);
  const fresh = loadDiagnostics();
  fresh.log.add('Before the first stream');
  fresh.module.nativeLog = (fresh.clock.now - 5) + '\tEMSS::OnOpen\n' + (fresh.clock.now + 5) + '\tRTSP handshake with rtsp://10.0.0.2:48010\n';
  fresh.log.startSession('stream');
  assert.deepEqual(texts(plain(fresh.log.getSessions())[0]), ['EMSS::OnOpen', 'Before the first stream', 'RTSP handshake with rtsp://<hidden>']);
  // A module without the function or one that throws leaves the log as it is
  const broken = loadDiagnostics({ globals: { Module: { takeDiagnosticLog() {
    throw new Error('not ready');
  } } } });
  assert.doesNotThrow(() => broken.log.startSession('stream'));
  assert.match(texts(plain(broken.log.getSessions())[0])[0], /^W Taking the lines of the native log failed: Error: not ready$/);
});

// The lines of tests/fixtures/session-reports.tsv as { name, message, hints }
function readReports() {
  return fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/session-reports.tsv'), 'utf8')
    .split('\n').filter((line) => line && line[0] !== '#').map((line) => {
      const fields = line.split('\t');
      return { name: fields[0], fields, message: fields[19], hints: fields[20].split(',') };
    });
}

test('the report of each message of the fixture, with its hints', () => {
  const app = loadDiagnostics();
  const parse = app.platform.get('parseSessionReport');
  const hints = app.platform.get('getSessionReportHints');
  const reports = readReports();
  assert.equal(reports.length, 15);
  reports.forEach((entry) => {
    assert.ok(entry.message.indexOf('SessionReportMsg: ') === 0, entry.name);
    const report = plain(parse(entry.message.slice('SessionReportMsg: '.length)));
    assert.equal(report.durationMs, Number(entry.fields[1]), entry.name);
    assert.equal(report.codec, entry.fields[2], entry.name);
    assert.equal(report.frames, Number(entry.fields[7]), entry.name);
    assert.equal(report.heapGrowthMb, Number(entry.fields[16]), entry.name);
    assert.equal(report.hostFrameRateX100, Number(entry.fields[17]), entry.name);
    assert.equal(report.hostProcessingLatencyX10, Number(entry.fields[18]), entry.name);
    assert.deepEqual(plain(hints(report, { refFrameInvalidation: false })), entry.hints, entry.name);
  });
  // With reference frame invalidation already on, the recovery keyframes give no hint of their own
  const network = reports.filter((entry) => entry.name === 'network')[0];
  assert.deepEqual(plain(hints(parse(network.message.slice(18)), { refFrameInvalidation: true })), ['network']);
  // A message that isn't a report, and figures that aren't numbers
  assert.equal(parse('{broken'), null);
  assert.equal(parse('42'), null);
  assert.equal(plain(parse('{"frames":"many","durationMs":-5}')).frames, 0);
});

// A clean report of a long stream at a frame rate, with the best host frame rate and the host processing latency given
function hostReport(fps, hostFrameRate, hostLatencyMs, extra) {
  return Object.assign({ durationMs: 1800000, codec: 'HEVC Main10', width: 3840, height: 2160, fps, bitrateKbps: 75000,
    frames: fps * 1800, networkDroppedFrames: 0, tvDroppedFrames: 0, videoResets: 0, recoveryKeyframes: 0,
    fecRecoveredBlocks: 0, fecFailures: 0, heapTopMb: 60, heapTotalMb: 128, heapGrowthMb: 0,
    hostFrameRateX100: Math.round(hostFrameRate * 100), hostProcessingLatencyX10: Math.round(hostLatencyMs * 10) }, extra || {});
}

test('the hint about the refresh rate of the PC comes only for a host at 59.94 or 119.88 FPS in a 60 or 120 FPS stream', () => {
  const hints = loadDiagnostics().platform.get('getSessionReportHints');
  const cases = [
    // 60 FPS: the band of 59.94 +- 0.02 FPS, which the best window of a 59.94 Hz display reads (59.93 to 59.94)
    [60, 59.94, ['hostRefresh']], [60, 59.93, ['hostRefresh']], [60, 59.95, ['hostRefresh']], [60, 59.96, ['hostRefresh']],
    [60, 59.92, ['ok']], [60, 59.97, ['ok']], [60, 60, ['ok']], [60, 59.99, ['ok']], [60, 60.01, ['ok']],
    // a host that drops frames or a game capped below the stream is no display at 59.94 Hz
    [60, 59, ['ok']], [60, 58.5, ['ok']], [60, 30, ['ok']], [60, 0, ['ok']],
    // 120 FPS: 119.88 +- 0.04 FPS
    [120, 119.88, ['hostRefresh']], [120, 119.85, ['hostRefresh']], [120, 119.92, ['hostRefresh']],
    [120, 119.83, ['ok']], [120, 119.93, ['ok']], [120, 120, ['ok']], [120, 59.94, ['ok']],
    // other stream rates have no NTSC display rate to compare with
    [30, 29.97, ['ok']], [90, 89.91, ['ok']],
  ];
  cases.forEach(([fps, host, expected]) => assert.deepEqual(plain(hints(hostReport(fps, host, 4))), expected, fps + ' FPS, host ' + host));
});

test('the hint about the encoder of the PC needs a busy host in a long session without the network hint', () => {
  const hints = loadDiagnostics().platform.get('getSessionReportHints');
  const cases = [
    // more than 75 % of the time between two frames: 12.5 ms at 60 FPS, 8.33 ms at 90, 6.25 ms at 120, 25 ms at 30
    [hostReport(60, 60, 12.6), ['host']], [hostReport(60, 60, 12.5), ['ok']], [hostReport(60, 60, 5), ['ok']],
    [hostReport(120, 120, 6.3), ['host']], [hostReport(120, 120, 6.2), ['ok']],
    [hostReport(90, 90, 8.4), ['host']], [hostReport(90, 90, 8.3), ['ok']],
    [hostReport(30, 30, 25.1), ['host']], [hostReport(30, 30, 20), ['ok']],
    // a low host frame rate alone (a static scene, a capped game, the minimum frame rate of Sunshine) gives no hint
    [hostReport(60, 30, 4), ['ok']], [hostReport(120, 45, 3), ['ok']],
    // a host without the figure (0) gives none either
    [hostReport(60, 60, 0), ['ok']],
    // at least 2 minutes
    [hostReport(60, 60, 14, { durationMs: 119000 }), ['ok']], [hostReport(60, 60, 14, { durationMs: 120000 }), ['host']],
    // not with many frames lost on the network, whose keyframes make the encoder look busier, while a few lost frames
    // that give no network hint (fewer than 10, or less than 0.5 %) don't stop it
    [hostReport(60, 60, 14, { networkDroppedFrames: 600 }), ['network']],
    [hostReport(60, 60, 14, { networkDroppedFrames: 9 }), ['host']], [hostReport(60, 60, 14, { networkDroppedFrames: 500 }), ['host']],
    [hostReport(60, 60, 14, { networkDroppedFrames: 540 }), ['network']],
    // with the TV dropping frames too, both show, and with a host display at 59.94 Hz as well
    [hostReport(60, 59.94, 14, { tvDroppedFrames: 600 }), ['tv', 'host', 'hostRefresh']],
  ];
  cases.forEach(([report, expected]) => assert.deepEqual(plain(hints(report)), expected, JSON.stringify(report)));
});

test('the hints about the PC name its figures', () => {
  const app = loadDiagnostics();
  const text = app.platform.get('getSessionReportHintText');
  assert.equal(text('host', hostReport(60, 60, 13.8)),
    'The PC took 13.8 ms of the 16.7 ms between two frames to encode a frame, so it may have skipped frames: use a faster encoder preset on the PC, or a lower resolution or frame rate.');
  assert.equal(text('host', hostReport(120, 120, 7.1)),
    'The PC took 7.1 ms of the 8.3 ms between two frames to encode a frame, so it may have skipped frames: use a faster encoder preset on the PC, or a lower resolution or frame rate.');
  assert.equal(text('hostRefresh', hostReport(60, 59.94, 4)),
    'The PC sent 59.94 instead of 60 frames per second, which shows as a short stutter about every 17 seconds: set the display of the PC to exactly 60 Hz.');
  assert.equal(text('hostRefresh', hostReport(120, 119.88, 4)),
    'The PC sent 119.88 instead of 120 frames per second, which shows as a short stutter about every 8 seconds: set the display of the PC to exactly 120 Hz.');
});

test('the lines of the report in System information', () => {
  const app = loadDiagnostics();
  const describe = app.platform.get('describeSessionReport');
  assert.deepEqual(plain(describe(null)), ['Last session: None yet']);
  const network = readReports().filter((entry) => entry.name === 'network')[0];
  const report = app.platform.get('parseSessionReport')(network.message.slice(18));
  assert.deepEqual(plain(describe(report, { refFrameInvalidation: false })), [
    'Last session: 10 min 0 s, HEVC Main10, 3840x2160, 60 FPS, 100 Mbps',
    'Frames lost on the network: 540 of 36,000 (1.50%)',
    'Frames dropped by the TV: 0, video resets: 1, recovery keyframes: 4',
    'FEC repairs: 900 blocks, 6 failed',
    'Host frame rate (best 30 s): 60.00 FPS, average host processing latency: 6.1 ms',
    'WASM heap at the end: 62 of 128 MB (+1 MB in this session)',
    'Hint: Many frames were lost on the network: use a cable or lower the bitrate.',
    'Hint: The PC often sent whole frames again after a loss: turn on Reference frame invalidation in the Advanced Settings.',
  ]);
  // Bitrates up to the end of the slider (250 Mbps), with the half Mbps of its steps
  assert.equal(plain(describe(Object.assign({}, report, { bitrateKbps: 247500 }), {}))[0],
    'Last session: 10 min 0 s, HEVC Main10, 3840x2160, 60 FPS, 247.5 Mbps');
  assert.equal(plain(describe(Object.assign({}, report, { bitrateKbps: 250000 }), {}))[0],
    'Last session: 10 min 0 s, HEVC Main10, 3840x2160, 60 FPS, 250 Mbps');
  const noVideo = readReports().filter((entry) => entry.name === 'no-video')[0];
  const lines = plain(describe(app.platform.get('parseSessionReport')(noVideo.message.slice(18)), {}));
  assert.equal(lines[0], 'Last session: 4 s, No video, 75 Mbps');
  assert.equal(lines[lines.length - 1], 'Hint: No video arrived from the PC in this session.');
  // Without either figure of the host its line is left out, and a missing one is Unknown
  assert.equal(lines.filter((line) => line.indexOf('Host frame rate') === 0).length, 0);
  assert.equal(plain(describe(Object.assign({}, report, { hostFrameRateX100: 0 }), {}))[4],
    'Host frame rate (best 30 s): Unknown, average host processing latency: 6.1 ms');
  assert.equal(plain(describe(Object.assign({}, report, { hostProcessingLatencyX10: 0 }), {}))[4],
    'Host frame rate (best 30 s): 60.00 FPS, average host processing latency: Unknown');
  // The hint of a host display at 59.94 Hz with its figures
  const refresh = readReports().filter((entry) => entry.name === 'host-refresh')[0];
  const refreshLines = plain(describe(app.platform.get('parseSessionReport')(refresh.message.slice(18)), {}));
  assert.deepEqual(refreshLines.slice(4), [
    'Host frame rate (best 30 s): 59.94 FPS, average host processing latency: 4.7 ms',
    'WASM heap at the end: 61 of 128 MB (+1 MB in this session)',
    'Hint: The PC sent 59.94 instead of 60 frames per second, which shows as a short stutter about every 17 seconds: set the display of the PC to exactly 60 Hz.',
  ]);
});

test('the heartbeat of a stream reports once at the next start that the app ended during it', () => {
  const storage = {};
  const localStorage = {
    getItem: (key) => (key in storage ? storage[key] : null),
    setItem: (key, value) => {
      storage[key] = String(value);
    },
  };
  const app = loadDiagnostics({ globals: { localStorage } });
  const heartbeat = app.platform.get('StreamHeartbeat');
  const key = heartbeat.STORAGE_KEY;
  assert.equal(heartbeat.takePreviousRun(), null);
  heartbeat.start();
  assert.equal(JSON.parse(storage[key]).state, 'streaming');
  // Each beat takes the native lines, and a beat much too late notes a blocked main thread
  app.module.nativeLog = app.clock.now + '\tA native line\n';
  app.clock.now += heartbeat.INTERVAL_MS;
  app.intervals[0]();
  app.clock.now += heartbeat.INTERVAL_MS + 4000;
  app.intervals[0]();
  assert.deepEqual(texts(app.log.getSessions()[0]), ['A native line', 'W The main thread was blocked for about 4000 ms during the stream']);
  const lastBeat = app.clock.now;
  assert.deepEqual(plain(JSON.parse(storage[key])), { state: 'streaming', startedAt: lastBeat - 2 * heartbeat.INTERVAL_MS - 4000, lastBeat });

  // The app ended during the stream: the next start reports it once
  const next = loadDiagnostics({ globals: { localStorage }, now: lastBeat + 60000 });
  const previousRun = plain(next.platform.get('StreamHeartbeat').takePreviousRun());
  assert.deepEqual(previousRun, { lastBeat, minutes: 0 });
  assert.equal(next.platform.get('StreamHeartbeat').takePreviousRun(), null);

  // A stream that ended in a way the app saw is not reported
  heartbeat.start();
  heartbeat.stop('the stream ended');
  assert.equal(JSON.parse(storage[key]).state, 'idle');
  assert.equal(app.intervals.filter(Boolean).length, 0);
  assert.equal(loadDiagnostics({ globals: { localStorage } }).platform.get('StreamHeartbeat').takePreviousRun(), null);

  // Nor one that the TV closed in the background
  const hidden = loadDiagnostics({ globals: { localStorage } });
  hidden.platform.context.document.visibilityState = 'hidden';
  hidden.platform.get('StreamHeartbeat').start();
  assert.equal(JSON.parse(storage[key]).state, 'hidden');
  assert.equal(loadDiagnostics({ globals: { localStorage } }).platform.get('StreamHeartbeat').takePreviousRun(), null);

  // Storage that fails is ignored
  const failing = loadDiagnostics({ globals: { localStorage: { getItem() {
    throw new Error('blocked');
  }, setItem() {
    throw new Error('blocked');
  } } } });
  assert.doesNotThrow(() => failing.platform.get('StreamHeartbeat').start());
  assert.equal(failing.platform.get('StreamHeartbeat').takePreviousRun(), null);
});

test('the front end takes the native lines from the ring of the module, which every line of the module enters', () => {
  // ClLogMessage() keeps each line in the ring without waiting (tests/native/connection_interrupt_test.cpp runs it), and
  // takeDiagnosticLog() of main.cpp, which diagnostics.js calls, empties it
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  assert.match(read('wasm/connectionlistener.cpp'),
    /void MoonlightInstance::ClLogMessage\(const char\* format, \.\.\.\) \{[\s\S]{0,400}GetDiagnosticLog\(\)\.TryAppend\(DiagnosticLogNowMs\(\), message\);/);
  const main = read('wasm/main.cpp');
  assert.match(main, /std::string takeDiagnosticLog\(\) \{\s+return GetDiagnosticLog\(\)\.Take\(\);\s+\}/);
  assert.match(main, /emscripten::function\("takeDiagnosticLog", &takeDiagnosticLog\);/);
  assert.match(read('wasm/platform/diagnostics.js'), /Module\.takeDiagnosticLog\(\)/);
});

test('the module sets the listener that logs the errors of the media element once, and it outlives the element', () => {
  // native/player_errors_test.cpp runs the listener, which the media element only calls once the constructor of
  // MoonlightInstance (wasm/main.cpp, which no native test builds) has set it
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const main = read('wasm/main.cpp');
  const start = main.indexOf('MoonlightInstance::MoonlightInstance()');
  const end = main.indexOf('MoonlightInstance::~MoonlightInstance()');
  assert.ok(start >= 0 && end > start, 'the constructor of MoonlightInstance');
  const constructor = main.slice(start, end);
  const body = constructor.slice(constructor.indexOf(') {'));
  assert.match(body, /if \(!m_MediaElement\.SetListener\(&m_MediaElementListener\)\) \{\s+ClLogMessage\(/);
  assert.equal((main.match(/SetListener\(&m_MediaElementListener\)/g) || []).length, 1, 'set once, for the life of the module');
  // The listener is built before the element that holds it and destroyed after it: the order of the members decides
  // that, and the initializer list follows it
  const initializerListener = constructor.indexOf('m_MediaElementListener(this)');
  const initializerElement = constructor.indexOf('m_MediaElement("wasm_module")');
  assert.ok(initializerListener > 0 && initializerElement > initializerListener, 'initializer list');
  const header = read('wasm/moonlight_wasm.hpp');
  const memberListener = header.indexOf('  MediaElementListener m_MediaElementListener;');
  const memberElement = header.indexOf('  samsung::html::HTMLMediaElement m_MediaElement;');
  assert.ok(memberListener > 0 && memberElement > memberListener, 'members of MoonlightInstance');
  assert.match(read('tests/native/player_errors_test.cpp'), /#include "\.\.\/\.\.\/wasm\/wasmplayer\.cpp"/);
});

test('each stream starts the host figures of its report from zero', () => {
  // native/stats_overlay_test.cpp runs ResetHostFrameRate() between two streams; VidDecSetup(), which waits for the
  // media pipeline of the TV and so runs in no native test, calls it for each stream
  const source = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'wasmplayer.cpp'), 'utf8');
  const start = source.indexOf('int MoonlightInstance::VidDecSetup(');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, 'VidDecSetup()');
  const setup = source.slice(start, end);
  assert.match(setup, /\n {2}ResetHostFrameRate\(\);\n/);
  assert.ok(setup.indexOf('ResetHostFrameRate();') < setup.indexOf('StartupVidDecSetup('), 'before the media pipeline is set up');
  const reset = source.slice(source.indexOf('static void ResetHostFrameRate() {'));
  assert.match(reset.slice(0, reset.indexOf('\n}\n')), /s_HostFrameRateBest = 0\.0f;/);
});

// Record the length of every text that the redaction rules run over
function spyRedaction(app) {
  const lengths = [];
  const redact = app.platform.get('redactDiagnosticText');
  app.platform.context.redactDiagnosticText = (text) => {
    lengths.push(String(text).length);
    return redact(text);
  };
  return lengths;
}

test('a huge line is cut before the redaction runs over it, and the secrets in the part it keeps are still hidden', () => {
  const app = loadDiagnostics();
  const lengths = spyRedaction(app);
  // A message of the module of a few MB, e.g. a large answer that 'Message data: ' printed
  const secrets = 'rikey=00112233445566778899aabbccddeeff mac 3C:7C:3F:12:AB:CD uniqueid: 0123456789ABCDEF ';
  app.log.add('Message data: ' + secrets + 'x'.repeat(4 * 1024 * 1024));
  const line = texts(app.log.getSessions()[0])[0];
  assert.equal(line.length, 400);
  assert.ok(line.endsWith('…'));
  assert.equal(line.slice(0, 104), 'Message data: rikey=<hidden> mac <hidden> uniqueid: <hidden> ' + 'x'.repeat(43));
  // The rules ran over the start of the text only, never over the whole of it
  assert.ok(lengths.length > 0 && Math.max(...lengths) < 2000, JSON.stringify(lengths));

  // A secret that the cut of the start leaves half is never kept: the start grows while the redaction shortened it so
  // much that the half secret would fall into the kept part (here every 'rikey=' value becomes '<hidden>')
  // (12 keys of 70 characters, and a MAC address across the end of the first start of 912 characters, which the 12
  // keys shorten to 179)
  lengths.length = 0;
  const keys = Array.from({ length: 12 }, (unused, index) => 'rikey=' + String(index).padStart(2, '0') + 'a'.repeat(62)).join('&');
  const across = keys + ' ' + 'q'.repeat(53) + ' AA:BB:CC:DD:EE:FF ';
  assert.equal(across.indexOf('AA:BB'), 906);
  app.clock.now += 5000;
  app.log.add(across + 'y'.repeat(100000));
  const shrunk = texts(app.log.getSessions()[0])[1];
  assert.equal(shrunk.slice(0, 245), Array(12).fill('rikey=<hidden>').join('&') + ' ' + 'q'.repeat(53) + ' <hidden> ' + 'y'.repeat(2));
  assert.doesNotMatch(shrunk, /AA:|aaaa/);
  assert.ok(Math.max(...lengths) < 20000, JSON.stringify(lengths));

  // A private key at the start that is longer than the first start keeps the text after it, without the key
  app.clock.now += 5000;
  const key = '-----BEGIN PRIVATE KEY-----\n' + 'MIIE'.repeat(800) + '\n-----END PRIVATE KEY-----';
  app.log.add('Client cert: ' + key + ' then mac 3C:7C:3F:12:AB:CD and ' + 'z'.repeat(50000));
  const afterKey = texts(app.log.getSessions()[0])[2];
  assert.match(afterKey, /^Client cert: <hidden> then mac <hidden> and z+…$/);

  // A value that the app knows is hidden in the kept part however long it is (hideDiagnosticValue())
  const known = 'K'.repeat(300) + '-known-value';
  app.platform.get('hideDiagnosticValue')('rikey', known);
  app.clock.now += 5000;
  app.log.add('w'.repeat(390) + known + 'v'.repeat(10000));
  assert.doesNotMatch(texts(app.log.getSessions()[0])[3], /KK/);
});

test('an object goes into a line as the start of its JSON, without turning the whole object into text, and its secrets hidden', () => {
  const app = loadDiagnostics();
  const lengths = spyRedaction(app);
  const format = app.platform.get('DiagnosticLog').formatConsoleArguments;
  // Box art bytes and a large list as they could reach the console
  const bytes = app.platform.run('new Uint8Array(2 * 1024 * 1024)');
  const list = app.platform.run('Array.from({ length: 200000 }, (unused, index) => ({ id: index, title: "App " + index }))');
  const host = app.platform.run(`({ hostname: 'GAMING-PC', uniqueid: '0123456789ABCDEF', macAddress: '3c:7c:3f:12:ab:cd',
    externalIP: '203.0.113.7', ppkstr: '-----BEGIN PRIVATE KEY-----\\n' + 'MIIE'.repeat(100000) + '\\n-----END PRIVATE KEY-----' })`);
  // JSON.stringify() of the page never gets the whole object
  const stringified = [];
  const json = app.platform.get('JSON');
  const stringify = json.stringify;
  json.stringify = function(value) {
    stringified.push(value);
    return stringify.apply(json, arguments);
  };
  try {
    const text = format([bytes, list, host]);
    // Each object keeps the first 200 characters of its JSON
    const bytesJson = ('{' + Array.from({ length: 100 }, (unused, index) => '"' + index + '":0').join(',')).slice(0, 200);
    const listJson = ('[' + Array.from({ length: 10 }, (unused, index) => '{"id":' + index + ',"title":"App ' + index + '"}').join(',')).slice(0, 200);
    assert.ok(text.startsWith(bytesJson + ' ' + listJson + ' {'), text);
    assert.match(text, /\{"hostname":"GAMING-PC","uniqueid":"<hidden>","macAddress":"<hidden>","externalIP":"<hidden>","ppkstr":"<hidden>/);
  } finally {
    json.stringify = stringify;
  }
  assert.ok(!stringified.includes(bytes) && !stringified.includes(list) && !stringified.includes(host));
  // The private key of 400 KB, which ends the JSON, is hidden from a start of at most 16 KB
  assert.ok(Math.max(...lengths) <= 16 * 1024, JSON.stringify(lengths));

  // The start of the JSON is the same as the start of JSON.stringify() for any value, and an object that is '{}' still
  // shows as its name, an object with a cycle as well
  const jsonStart = app.platform.get('jsonStart');
  const values = app.platform.run(`[
    { a: 1, b: 'two', c: [1, 2, { d: undefined, e: function() {} }], f: null, g: new Date(0) },
    [undefined, function() {}, NaN, Infinity, -0, 'é\\u2028"\\\\'], { toJSON: function() { return { replaced: true }; } },
    { n: new Number(3), s: new String('s'), b: new Boolean(false) }, new Uint8Array([1, 2, 250]), { a: [, , 3] }, 'text', 7, null,
    { nested: { deep: ['x'.repeat(50), 'y\\n'.repeat(30)] } }
  ]`);
  values.forEach((value) => {
    const full = stringify.call(json, value);
    [0, 1, 5, 17, 40, 100, full.length - 1, full.length, full.length + 5].forEach((size) => {
      assert.equal(jsonStart(value, size), full.slice(0, size), full + ' / ' + size);
    });
  });
  assert.equal(format([app.platform.run('new Map([[1, 2]])')]), '[object Map]');
  assert.equal(format([app.platform.run('(function() { const loop = { a: 1 }; loop.self = loop; return loop; })()')]), '[object Object]');
});

test('a long native line is cut before the redaction runs over it as well', () => {
  const app = loadDiagnostics();
  const lengths = spyRedaction(app);
  app.module.nativeLog = app.clock.now + '\tCURL: request with PPK 3C:7C:3F:12:AB:CD ' + 'p'.repeat(500000) + '\n';
  const line = texts(app.log.getSessions()[0])[0];
  assert.equal(line.length, 400);
  assert.match(line, /^CURL: request with PPK <hidden> p+…$/);
  assert.ok(Math.max(...lengths) < 2000, JSON.stringify(lengths));
});
