'use strict';

// Pins wasm/platform/diagnostics.js: what the log hides (the remote input keys, the pairing secrets and PIN, the unique
// ID, the RTSP session URL, the public IP address, also by its value in a URL once utils.js or index.js hands it over,
// and every MAC address but the all-zero one, also in a host object that the line cuts) and what it keeps (the local
// addresses and the names of the PCs), the log of the current and the previous session (a new session for each stream,
// the lines of the console with the style of '%c' left out and the console still getting them, the lines that only
// repeat the overlay or a rumble left out before they are redacted, a repeated line counted, the oldest lines dropped
// when a session is full, the native lines of the module merged by their time and hidden the same way, the uncaught
// errors and unhandled promise rejections of the page, each different one once and 20 at most per session), the report
// of the last session read from the messages of tests/fixtures/session-reports.tsv with their hints and its lines for
// System information (also the frame receive time as a share of the frame time, the lowest host frame rate with its
// windows, and the hint about a PC that delivered fewer frames than the stream asked for; a report without these
// figures, as 2.3.0 sent it, is read as before), a report that
// can't be read logged with the reason and its whole text, and the heartbeat of a stream that reports once at the next
// start that the app ended during it (not for a stream in the background), that the native lines come from the ring
// that every log line of the module enters, that the module sets the listener that logs the errors of the media
// element, that every setup call of the video player whose refusal would end the start with -200 logs that refusal,
// and that each stream starts the host figures of its report from zero.

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

test('a line that only repeats the overlay or a rumble is dropped before the work of redacting it', () => {
  const app = loadDiagnostics();
  // Count the passes of the redaction over a text
  app.platform.run(`
    var redactionPasses = 0;
    var redactDiagnosticTextOfTheScript = redactDiagnosticText;
    redactDiagnosticText = function(text) {
      redactionPasses++;
      return redactDiagnosticTextOfTheScript(text);
    };
  `);
  // The lines that messages.js writes for these messages while its logFrequentMessages is set for a debugging session
  app.platform.run(`
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', 'StatMsg: {"rtt":3,"lost":0}\\nVideo stream: 3840x2160 60.00 FPS');
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', 'StatCompactMsg: {"w":3840}');
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', 'controllerRumble: 0,0.5,0.25');
  `);
  app.log.add('[messages.js, handleMessage] Message data:  controllerRumble: 0,0.5,0.25');
  assert.equal(app.platform.get('redactionPasses'), 0);
  assert.deepEqual(texts(app.log.getSessions()[0]), []);
  // Any other line is redacted and kept, also one of the same script and one that only names such a message
  app.platform.run(`
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', 'StatLevelMsg: 2');
    console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.25 (the changes of its strength are not logged until it stops)...');
    console.log('%c[index.js]', 'color: green;', 'The module sent StatMsg: nothing, rikey=00112233');
  `);
  assert.ok(app.platform.get('redactionPasses') >= 3);
  assert.deepEqual(texts(app.log.getSessions()[0]), [
    '[messages.js, handleMessage] Message data:  StatLevelMsg: 2',
    '[messages.js, handleMessage] Playing rumble on gamepad 0 with weak magnitude 0.5 and strong magnitude 0.25 (the changes of its strength are not logged until it stops)...',
    '[index.js] The module sent StatMsg: nothing, rikey=<hidden>',
  ]);
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

// Send an 'error' or 'unhandledrejection' event to the listeners that diagnostics.js put on the window
function dispatchToWindow(app, type, properties) {
  const event = Object.assign({ type, defaultPrevented: false, preventDefault() {
    this.defaultPrevented = true;
  } }, properties);
  app.platform.context.dispatchEvent(event);
  return event;
}

test('an uncaught error of the page is a line of the log, with its script, line and column', () => {
  const app = loadDiagnostics();
  // One listener for each event, on the window, although the capture is asked for again
  app.log.captureUncaught(app.platform.context);
  assert.equal(app.platform.windowListeners.error.length, 1);
  assert.equal(app.platform.windowListeners.unhandledrejection.length, 1);

  const event = dispatchToWindow(app, 'error', { message: 'Uncaught TypeError: host.refreshServerInfo is not a function',
    filename: 'file:///opt/usr/apps/AbCdEf1234/res/wgt/platform/index.js?v=2', lineno: 502, colno: 10 });
  // The log only reads the event: the console of the browser still reports the error
  assert.equal(event.defaultPrevented, false);
  app.clock.now += 5000;
  // A message without the word of Chromium gets it, and an error without a script (a script of another origin) no place
  dispatchToWindow(app, 'error', { message: 'ReferenceError: nothing is not defined', filename: 'http://127.0.0.1:8080/static/js/utils.js', lineno: 7, colno: 3 });
  dispatchToWindow(app, 'error', { message: 'Script error.', filename: '', lineno: 0, colno: 0 });
  dispatchToWindow(app, 'error', {});
  const lines = texts(app.log.getSessions()[0]);
  assert.deepEqual(lines, [
    'E Uncaught TypeError: host.refreshServerInfo is not a function (index.js:502:10)',
    'E Uncaught error: ReferenceError: nothing is not defined (utils.js:7:3)',
    'E Uncaught error: Script error.',
    // The event without a message is the same text again, which is only counted
    '… 1 more uncaught errors or unhandled promise rejections are not kept (the same ones again, or more than 20 different ones in this session)',
  ]);
  // The folders of the app on the TV, which hold its package ID, are not in the log
  assert.equal(lines.join('\n').indexOf('AbCdEf1234'), -1);
  // The line has the time of the error
  assert.match(plain(app.log.getSessions()[0].lines)[1], /^\d\d:\d\d:\d\d\.\d{3} app {3} E Uncaught error: ReferenceError/);
});

test('an unhandled promise rejection is a line of the log, with the reason and the place of an error', () => {
  const app = loadDiagnostics();
  // What Embind throws for a start request with an argument of the wrong type, as Chromium formats its stack
  const binding = { name: 'BindingError', message: 'Cannot pass "undefined" as a int',
    stack: 'BindingError: Cannot pass "undefined" as a int\n    at Object.toWireType (file:///opt/usr/apps/AbCdEf1234/res/wgt/moonlight-wasm.js:1:23456)\n' +
      '    at Object.startStream (file:///opt/usr/apps/AbCdEf1234/res/wgt/moonlight-wasm.js:1:34567)\n    at startRequest (file:///x/platform/messages.js:12:42)' };
  const event = dispatchToWindow(app, 'unhandledrejection', { reason: binding });
  assert.equal(event.defaultPrevented, false);
  // An error whose stack has no brackets, one without a stack, and reasons that are no errors: a number (the error
  // codes of the module), a text, an object, nothing
  dispatchToWindow(app, 'unhandledrejection', { reason: { name: 'TypeError', message: 'Failed to fetch',
    stack: 'TypeError: Failed to fetch\n    at http://127.0.0.1:8080/static/js/utils.js:517:14' } });
  dispatchToWindow(app, 'unhandledrejection', { reason: { name: 'Error', message: 'no stack' } });
  dispatchToWindow(app, 'unhandledrejection', { reason: { message: 'no name', stack: 'at <anonymous>:1:1' } });
  dispatchToWindow(app, 'unhandledrejection', { reason: -1 });
  dispatchToWindow(app, 'unhandledrejection', { reason: 'Failed to parse server info from HTTP' });
  dispatchToWindow(app, 'unhandledrejection', { reason: { status: 503, hostname: 'GAMING-PC' } });
  dispatchToWindow(app, 'unhandledrejection', { reason: undefined });
  dispatchToWindow(app, 'unhandledrejection', { reason: null });
  dispatchToWindow(app, 'unhandledrejection', {});
  const lines = texts(app.log.getSessions()[0]);
  assert.deepEqual(lines, [
    'E Unhandled promise rejection: BindingError: Cannot pass "undefined" as a int (moonlight-wasm.js:1:23456)',
    'E Unhandled promise rejection: TypeError: Failed to fetch (utils.js:517:14)',
    'E Unhandled promise rejection: Error: no stack',
    'E Unhandled promise rejection: no name (<anonymous>:1:1)',
    'E Unhandled promise rejection: -1',
    'E Unhandled promise rejection: Failed to parse server info from HTTP',
    'E Unhandled promise rejection: {"status":503,"hostname":"GAMING-PC"}',
    'E Unhandled promise rejection: undefined',
    'E Unhandled promise rejection: null',
    '… 1 more uncaught errors or unhandled promise rejections are not kept (the same ones again, or more than 20 different ones in this session)',
  ]);
  assert.equal(lines.join('\n').indexOf('AbCdEf1234'), -1);
});

test('the uncaught errors are hidden like every line of the log', () => {
  const app = loadDiagnostics();
  app.platform.get('hideDiagnosticValue')('uniqueid', '0123456789ABCDEF');
  app.platform.get('hideDiagnosticAddress')('203.0.113.7');
  dispatchToWindow(app, 'error', { message: 'Uncaught Error: request https://203.0.113.7:47984/launch?uniqueid=0123456789ABCDEF&rikey=00112233445566778899aabbccddeeff failed',
    filename: 'http://x/platform/index.js', lineno: 1, colno: 2 });
  dispatchToWindow(app, 'unhandledrejection', { reason: 'Wake-on-LAN to 3C:7C:3F:12:AB:CD failed, PIN 4711, client 0123456789ABCDEF' });
  dispatchToWindow(app, 'unhandledrejection', { reason: { name: 'Error', message: 'rtsp://10.0.0.2:48010 refused\nrikeyid=12345678' } });
  dispatchToWindow(app, 'unhandledrejection', { reason: { clientUid: '0123456789ABCDEF', externalIP: '203.0.113.7', hostname: 'GAMING-PC' } });
  const lines = texts(app.log.getSessions()[0]);
  assert.deepEqual(lines, [
    'E Uncaught Error: request https://<hidden>:47984/launch?uniqueid=<hidden>&rikey=<hidden> failed (index.js:1:2)',
    'E Unhandled promise rejection: Wake-on-LAN to <hidden> failed, PIN <hidden>, client <hidden>',
    'E Unhandled promise rejection: Error: rtsp://<hidden> refused rikeyid=<hidden>',
    'E Unhandled promise rejection: {"clientUid":"<hidden>","externalIP":"<hidden>","hostname":"GAMING-PC"}',
  ]);
  // A long text is cut like every line
  dispatchToWindow(app, 'error', { message: 'Uncaught Error: ' + 'x'.repeat(5000) });
  const long = texts(app.log.getSessions()[0])[4];
  assert.equal(long.length, 2 + 400);
  assert.match(long, /^E Uncaught Error: x+…$/);
});

test('an error that repeats can\'t flood the log: each different one once, and 20 at most per session', () => {
  const app = loadDiagnostics();
  const lengths = spyRedaction(app);
  // The same error for every frame of ten minutes at 60 FPS, between other lines
  app.platform.run(`console.log('before');`);
  for (let i = 0; i < 36000; i++) {
    dispatchToWindow(app, 'error', { message: 'Uncaught TypeError: frame is undefined', filename: 'http://x/platform/gamepad.js', lineno: 9, colno: 1 });
    app.clock.now += 16;
  }
  app.platform.run(`console.log('after');`);
  assert.deepEqual(texts(app.log.getSessions()[0]), [
    'before',
    'E Uncaught TypeError: frame is undefined (gamepad.js:9:1)',
    'after',
    '… 35999 more uncaught errors or unhandled promise rejections are not kept (the same ones again, or more than 20 different ones in this session)',
  ]);
  // Two errors that take turns are no repeat of the line before, and still come once each
  for (let i = 0; i < 100; i++) {
    dispatchToWindow(app, 'unhandledrejection', { reason: i % 2 ? 'first' : 'second' });
  }
  assert.equal(texts(app.log.getSessions()[0]).filter((line) => /^E Unhandled promise rejection: (first|second)$/.test(line)).length, 2);

  // Errors that differ each time (e.g. with a counter in their text): 20 of the session are kept, the 3 above included
  const redactions = lengths.length;
  for (let i = 0; i < 5000; i++) {
    dispatchToWindow(app, 'error', { message: 'Uncaught Error: packet ' + i + ' lost' });
  }
  const session = texts(app.log.getSessions()[0]);
  const kept = session.filter((line) => /^E (Uncaught|Unhandled)/.test(line));
  assert.equal(kept.length, 20);
  assert.equal(kept[kept.length - 1], 'E Uncaught Error: packet 16 lost');
  assert.equal(session[session.length - 1],
    '… ' + (35999 + 98 + 5000 - 17) + ' more uncaught errors or unhandled promise rejections are not kept (the same ones again, or more than 20 different ones in this session)');
  // The other lines of the session are all still there, and lines of the app are still kept after the limit
  assert.deepEqual(session.slice(0, 3), ['before', 'E Uncaught TypeError: frame is undefined (gamepad.js:9:1)', 'after']);
  app.platform.run(`console.error('a line of the app');`);
  assert.ok(texts(app.log.getSessions()[0]).indexOf('E a line of the app') > 0);
  // Past the limit an error is only counted, without the work of hiding its text: 17 texts were redacted, not 5000
  assert.ok(lengths.length - redactions < 100, String(lengths.length - redactions));

  // A new session (a stream starts) keeps its own: the one before stays as it was, and the error is kept again
  app.log.startSession('stream');
  dispatchToWindow(app, 'error', { message: 'Uncaught TypeError: frame is undefined', filename: 'http://x/platform/gamepad.js', lineno: 9, colno: 1 });
  const sessions = app.log.getSessions();
  assert.equal(texts(sessions[0]).filter((line) => /^E (Uncaught|Unhandled)/.test(line)).length, 20);
  assert.deepEqual(texts(sessions[1]), ['E Uncaught TypeError: frame is undefined (gamepad.js:9:1)']);
});

// The lines of tests/fixtures/session-reports.tsv as { name, message, hints }
function readReports() {
  return fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/session-reports.tsv'), 'utf8')
    .split('\n').filter((line) => line && line[0] !== '#').map((line) => {
      const fields = line.split('\t');
      return { name: fields[0], fields, message: fields[29], hints: fields[30].split(',') };
    });
}

test('the report of each message of the fixture, with its hints', () => {
  const app = loadDiagnostics();
  const parse = app.platform.get('parseSessionReport');
  const hints = app.platform.get('getSessionReportHints');
  const reports = readReports();
  assert.equal(reports.length, 31);
  reports.forEach((entry) => {
    assert.equal(entry.fields.length, 31, entry.name);
    assert.ok(entry.message.indexOf('SessionReportMsg: ') === 0, entry.name);
    const report = plain(parse(entry.message.slice('SessionReportMsg: '.length)));
    assert.equal(report.durationMs, Number(entry.fields[1]), entry.name);
    assert.equal(report.codec, entry.fields[2], entry.name);
    assert.equal(report.frames, Number(entry.fields[7]), entry.name);
    assert.equal(report.heapGrowthMb, Number(entry.fields[16]), entry.name);
    assert.equal(report.hostFrameRateX100, Number(entry.fields[17]), entry.name);
    assert.equal(report.hostProcessingLatencyX10, Number(entry.fields[18]), entry.name);
    assert.deepEqual([report.audioChannels, report.audioLoadMsPerS, report.audioLoadPeakMsPerS, report.audioOverloadedWindows],
      entry.fields.slice(19, 23).map(Number), entry.name);
    assert.equal(report.hostRfi, entry.fields[23] === '1', entry.name);
    assert.deepEqual([report.hostFrameRateLowX100, report.hostWindows, report.hostLowWindows, report.receiveTimeX100,
      report.receiveTimePeakX100], entry.fields.slice(24, 29).map(Number), entry.name);
    assert.deepEqual(plain(hints(report, { refFrameInvalidation: false })), entry.hints, entry.name);
  });
  // The fixture has a PC that delivered too few frames, with and without the other hints that go before it
  ['host-frames', 'host-frames-few', 'host-frames-network', 'host-frames-encoder', 'host-frames-short', 'host-frames-120'].forEach((name) => {
    assert.equal(reports.filter((entry) => entry.name === name).length, 1, name);
  });
  // Both answers of a host are read
  assert.deepEqual(Array.from(new Set(reports.map((entry) => entry.fields[23]))).sort(), ['0', '1']);
  // With reference frame invalidation already on, the recovery keyframes give no hint of their own
  const network = reports.filter((entry) => entry.name === 'network')[0];
  assert.deepEqual(plain(hints(parse(network.message.slice(18)), { refFrameInvalidation: true })), ['network']);
  // A message that isn't a report, and figures that aren't numbers
  assert.equal(parse('{broken'), null);
  assert.equal(parse('42'), null);
  assert.equal(plain(parse('{"frames":"many","durationMs":-5}')).frames, 0);
  // The report of a module without the figures of the audio thread gives no hint about them
  const older = plain(parse('{"durationMs":600000,"codec":"HEVC","fps":60,"frames":36000}'));
  assert.deepEqual([older.audioChannels, older.audioLoadMsPerS, older.audioLoadPeakMsPerS, older.audioOverloadedWindows], [0, 0, 0, 0]);
  assert.deepEqual(plain(hints(older, {})), ['ok']);
});

// The message of 2.3.0, which had neither the lowest host frame rate with its windows nor the frame receive time
const MESSAGE_230 = '{"durationMs":600000,"codec":"HEVC Main10","width":3840,"height":2160,"fps":60,"bitrateKbps":100000,' +
  '"frames":36000,"networkDroppedFrames":3,"tvDroppedFrames":0,"videoResets":0,"recoveryKeyframes":0,' +
  '"fecRecoveredBlocks":12,"fecFailures":0,"heapTopMb":62,"heapTotalMb":128,"heapGrowthMb":1,' +
  '"hostFrameRateX100":5984,"hostProcessingLatencyX10":84,"audioChannels":2,"audioLoadMsPerS":140,' +
  '"audioLoadPeakMsPerS":152,"audioOverloadedWindows":0,"hostRfi":1}';

test('the hint about the frames of the PC comes for a host that delivered clearly fewer frames in a good part of a clean session', () => {
  const app = loadDiagnostics();
  const parse = app.platform.get('parseSessionReport');
  const hints = app.platform.get('getSessionReportHints');
  const text = app.platform.get('getSessionReportHintText');
  const byName = (name) => plain(parse(readReports().filter((entry) => entry.name === name)[0].message.slice(18)));
  // The session of the finding: the best 30 s window reads 59.84 FPS and encoding took 8.4 ms, so neither the hint
  // about the refresh rate nor the one about the encoder comes, while the PC delivered about 51 instead of 60 frames
  // per second in 12 of its 39 half minutes. That read 'No problems found' before.
  const session = byName('host-frames');
  assert.deepEqual([session.hostFrameRateX100, session.hostProcessingLatencyX10, session.hostFrameRateLowX100, session.hostWindows,
    session.hostLowWindows], [5984, 84, 5090, 39, 12]);
  assert.deepEqual(plain(hints(session, {})), ['hostFrames']);
  const without = Object.assign({}, session, { hostFrameRateLowX100: 0, hostWindows: 0, hostLowWindows: 0 });
  assert.deepEqual(plain(hints(without, {})), ['ok']);
  const low = (windows, lowWindows, extra) => Object.assign({}, session, { hostWindows: windows, hostLowWindows: lowWindows }, extra || {});
  const cases = [
    // At least a fifth of the windows that count, and at least 2 of them
    [low(39, 8), ['hostFrames']], [low(39, 7), ['ok']], [low(40, 8), ['hostFrames']], [low(41, 8), ['ok']],
    [low(10, 2), ['hostFrames']], [low(3, 2), ['hostFrames']], [low(3, 1), ['ok']], [low(1, 1), ['ok']],
    [low(239, 48), ['hostFrames']], [low(239, 47), ['ok']], [low(39, 39), ['hostFrames']], [low(39, 0), ['ok']],
    // A session of at least 2 minutes, like the hint about the encoder
    [low(3, 3, { durationMs: 119000 }), ['ok']], [low(3, 3, { durationMs: 120000 }), ['hostFrames']],
    // Not with many frames lost on the network, which gets the hint about the network alone; a few lost frames that
    // give no network hint don't stop it
    [low(39, 12, { networkDroppedFrames: 900 }), ['network']], [low(39, 12, { networkDroppedFrames: 9 }), ['hostFrames']],
    [low(39, 12, { networkDroppedFrames: 300 }), ['hostFrames']],
    // A busy encoder already explains the missing frames: its hint comes instead, never both
    [low(39, 12, { hostProcessingLatencyX10: 126 }), ['host']], [low(39, 12, { hostProcessingLatencyX10: 125 }), ['hostFrames']],
    // It comes after the hints about the network, the TV and the sound, and before the others
    [low(39, 12, { tvDroppedFrames: 2000 }), ['tv', 'hostFrames']],
    [low(39, 12, { tvDroppedFrames: 2000, audioOverloadedWindows: 3 }), ['tv', 'audio', 'hostFrames']],
    [low(39, 12, { recoveryKeyframes: 5, fecFailures: 2 }), ['hostFrames', 'keyframes', 'fec']],
    // A report without a frame rate of the stream gives none
    [low(39, 12, { fps: 0 }), ['ok']],
  ];
  cases.forEach(([report, expected]) => assert.deepEqual(plain(hints(report, {})), expected, JSON.stringify(report)));
  // The fixture rows of the same session: too few low windows, the network, the encoder, a short session, 120 FPS
  assert.deepEqual(plain(hints(byName('host-frames-few'), {})), ['ok']);
  assert.deepEqual(plain(hints(byName('host-frames-network'), {})), ['network']);
  assert.deepEqual(plain(hints(byName('host-frames-encoder'), {})), ['host']);
  assert.deepEqual(plain(hints(byName('host-frames-short'), {})), ['ok']);
  assert.deepEqual(plain(hints(byName('host-frames-120'), {})), ['hostFrames']);

  // The text names the figures and stays neutral: a game or video limited to fewer frames reads the same. It doesn't
  // blame the bitrate, the network or the encoder, and it names the display of the PC, the other common cause: a stream
  // at 120 FPS from a PC whose display runs at 60 Hz gets 60 new frames per second, which lower graphics settings don't
  // change (the text before told only to lower them).
  const hint = text('hostFrames', session);
  assert.equal(hint, 'The PC often sent fewer frames than the stream asked for: in 12 of 39 half minutes fewer than 57 per second, ' +
    '50.9 at the lowest. That is normal for a game or video limited to fewer frames, or for a display of the PC set to fewer Hz ' +
    'than the frame rate of the stream (e.g. 60 Hz at 120 FPS). Otherwise lower the graphics settings of the game or the frame ' +
    'rate of the stream.');
  assert.doesNotMatch(hint, /bitrate|network|encoder|could not deliver/i);
  // The limit of a low window follows the stream rate: 95 % of it, as the module counts them
  assert.match(text('hostFrames', byName('host-frames-120')), /in 8 of 19 half minutes fewer than 114 per second, 98\.5 at the lowest\./);
  assert.match(text('hostFrames', low(39, 12, { fps: 90 })), /fewer than 85\.5 per second/);
  const native = fs.readFileSync(path.join(REPO_ROOT, 'wasm/session_report.hpp'), 'utf8');
  assert.equal(Number(/constexpr uint32_t kHostRateLowPercent = (\d+);/.exec(native)[1]), app.platform.get('HOST_LOW_RATE_PERCENT'));
  assert.equal(app.platform.get('HOST_LOW_RATE_PERCENT'), 95);

  // A report of 2.3.0 has none of these figures: it is read as before and gets no hint about the frames of the PC
  const report230 = plain(parse(MESSAGE_230));
  assert.deepEqual([report230.hostFrameRateLowX100, report230.hostWindows, report230.hostLowWindows, report230.receiveTimeX100,
    report230.receiveTimePeakX100], [0, 0, 0, 0, 0]);
  assert.deepEqual([report230.hostFrameRateX100, report230.hostProcessingLatencyX10, report230.frames, report230.hostRfi], [5984, 84, 36000, true]);
  assert.deepEqual(plain(hints(report230, {})), ['ok']);
  // Figures that aren't numbers count as missing
  const broken = plain(parse('{"durationMs":600000,"fps":60,"frames":36000,"hostWindows":"39","hostLowWindows":-12,"receiveTimeX100":null}'));
  assert.deepEqual([broken.hostWindows, broken.hostLowWindows, broken.receiveTimeX100], [0, 0, 0]);
});

test('the report shows the frame receive time as a share of the frame time, and the lowest host frame rate with its windows', () => {
  const app = loadDiagnostics();
  const parse = app.platform.get('parseSessionReport');
  const describe = app.platform.get('describeSessionReport');
  const byName = (name) => parse(readReports().filter((entry) => entry.name === name)[0].message.slice(18));
  // The session of the finding at 180 Mbps and 60 FPS: a frame took 11.10 ms to arrive on average, which is 67 % of
  // the 16.7 ms between two frames, and 13.85 ms (83 %) in the highest second
  const lines = plain(describe(byName('host-frames'), {}));
  assert.deepEqual(lines, [
    'Last session: 20 min 0 s, AV1 Main10, 3840x2160, 60 FPS, 180 Mbps',
    'Frames lost on the network: 4 of 66,400 (0.01%)',
    'Frames dropped by the TV: 0, video resets: 0, recovery keyframes: 0',
    'FEC repairs: 25 blocks, 0 failed',
    'Average frame receive time: 11.10 ms (67% of the frame time), highest second: 13.85 ms (83%)',
    'Host frame rate (best 30 s): 59.84 FPS, average host processing latency: 8.4 ms',
    'Host frame rate (lowest 30 s): 50.90 FPS, below 57 FPS in 12 of 39 half minutes',
    'WASM heap at the end: 62 of 128 MB (+1 MB in this session)',
    'Hint: The PC often sent fewer frames than the stream asked for: in 12 of 39 half minutes fewer than 57 per second, 50.9 at the lowest. ' +
      'That is normal for a game or video limited to fewer frames, or for a display of the PC set to fewer Hz than the frame rate of the ' +
      'stream (e.g. 60 Hz at 120 FPS). Otherwise lower the graphics settings of the game or the frame rate of the stream.',
  ]);
  // With too few low windows for the hint, the figures still show
  const few = plain(describe(byName('host-frames-few'), {}));
  assert.equal(few[6], 'Host frame rate (lowest 30 s): 50.90 FPS, below 57 FPS in 7 of 39 half minutes');
  assert.equal(few[few.length - 1], 'Hint: No problems found in this session.');
  // The share follows the frame rate of the stream: 6.02 ms are 72 % of the 8.3 ms between two frames at 120 FPS,
  // and the limit of a low window is 114 FPS there
  const fast = plain(describe(byName('host-frames-120'), {}));
  assert.equal(fast[4], 'Average frame receive time: 6.02 ms (72% of the frame time), highest second: 7.31 ms (88%)');
  assert.equal(fast[6], 'Host frame rate (lowest 30 s): 98.50 FPS, below 114 FPS in 8 of 19 half minutes');
  const report = plain(byName('clean'));
  const receiveLine = (extra) => plain(describe(Object.assign({}, report, extra), {})).filter((line) => line.indexOf('Average frame receive time') === 0);
  assert.deepEqual(receiveLine({}), ['Average frame receive time: 4.12 ms (25% of the frame time), highest second: 6.55 ms (39%)']);
  // The figures of the finding: 8.65 ms at 60 FPS are 52 % of the frame time, 9.35 ms 56 %, 9.90 ms 59 %
  assert.deepEqual(receiveLine({ receiveTimeX100: 865, receiveTimePeakX100: 0 }), ['Average frame receive time: 8.65 ms (52% of the frame time)']);
  assert.match(receiveLine({ receiveTimeX100: 935 })[0], /9\.35 ms \(56% of the frame time\)/);
  assert.match(receiveLine({ receiveTimeX100: 990 })[0], /9\.90 ms \(59% of the frame time\)/);
  // A frame can take longer than the time between two frames, e.g. on a link that the bitrate overloads
  assert.match(receiveLine({ receiveTimeX100: 1530, receiveTimePeakX100: 2100, fps: 60 })[0], /15\.30 ms \(92% of the frame time\), highest second: 21\.00 ms \(126%\)/);
  assert.match(receiveLine({ receiveTimeX100: 1000, receiveTimePeakX100: 1250, fps: 30 })[0], /10\.00 ms \(30% of the frame time\), highest second: 12\.50 ms \(38%\)/);
  // Without a frame, or without the figure (a report of 2.3.0), the line is left out, and so is the line of the lowest
  // host frame rate without a window that counts
  assert.deepEqual(receiveLine({ receiveTimeX100: 0, receiveTimePeakX100: 0 }), []);
  assert.deepEqual(receiveLine({ fps: 0 }), []);
  const lowLine = (extra) => plain(describe(Object.assign({}, report, extra), {})).filter((line) => line.indexOf('Host frame rate (lowest 30 s)') === 0);
  assert.deepEqual(lowLine({}), ['Host frame rate (lowest 30 s): 59.96 FPS, below 57 FPS in 0 of 24 half minutes']);
  assert.deepEqual(lowLine({ hostWindows: 0, hostLowWindows: 0, hostFrameRateLowX100: 0 }), []);
  assert.deepEqual(lowLine({ fps: 90 }), ['Host frame rate (lowest 30 s): 59.96 FPS, below 85.5 FPS in 0 of 24 half minutes']);
  // A paused host (the row of a static scene): the best window shows, no window counts for the lowest
  const paused = plain(describe(byName('host-static'), {}));
  assert.ok(paused.indexOf('Host frame rate (best 30 s): 30.01 FPS, average host processing latency: 4.2 ms') > 0, paused.join('\n'));
  assert.equal(paused.filter((line) => line.indexOf('Host frame rate (lowest 30 s)') === 0).length, 0);
  // The report of 2.3.0 shows what it showed before
  assert.deepEqual(plain(describe(parse(MESSAGE_230), {})), [
    'Last session: 10 min 0 s, HEVC Main10, 3840x2160, 60 FPS, 100 Mbps',
    'Frames lost on the network: 3 of 36,000 (0.01%)',
    'Frames dropped by the TV: 0, video resets: 0, recovery keyframes: 0',
    'FEC repairs: 12 blocks, 0 failed',
    'Host frame rate (best 30 s): 59.84 FPS, average host processing latency: 8.4 ms',
    'WASM heap at the end: 62 of 128 MB (+1 MB in this session)',
    'Hint: No problems found in this session.',
  ]);
});

test('the hint about recovery keyframes names Reference frame invalidation only for a host that offered it', () => {
  const app = loadDiagnostics();
  const parse = app.platform.get('parseSessionReport');
  const hints = app.platform.get('getSessionReportHints');
  const reports = readReports();
  const byName = (name) => plain(parse(reports.filter((entry) => entry.name === name)[0].message.slice(18)));
  // The same stream with 5 recovery keyframes from a host that offered it and from one that didn't
  const offered = byName('keyframes');
  const notOffered = byName('keyframes-host-without-rfi');
  assert.equal(offered.recoveryKeyframes, 5);
  assert.deepEqual(Object.assign({}, offered, { hostRfi: false }), notOffered);
  assert.deepEqual(plain(hints(offered, { refFrameInvalidation: false })), ['keyframes']);
  assert.deepEqual(plain(hints(notOffered, { refFrameInvalidation: false })), ['ok']);
  // With the setting already on there is nothing to suggest, whatever the host offered
  assert.deepEqual(plain(hints(offered, { refFrameInvalidation: true })), ['ok']);
  assert.deepEqual(plain(hints(notOffered, { refFrameInvalidation: true })), ['ok']);
  // Next to another hint as well
  assert.deepEqual(plain(hints(byName('network'), {})), ['network', 'keyframes']);
  assert.deepEqual(plain(hints(byName('network-host-without-rfi'), {})), ['network']);
  // H.264 never gets it: the app asks for reference frame invalidation only with HEVC and AV1
  assert.deepEqual(plain(hints(Object.assign({}, offered, { codec: 'H.264' }), {})), ['ok']);

  // The message of 2.3.0, which had no hostRfi, is still read: nothing is known about its host, so no hint names the
  // setting
  const message230 = '{"durationMs":600000,"codec":"HEVC Main10","width":3840,"height":2160,"fps":60,"bitrateKbps":100000,' +
    '"frames":36000,"networkDroppedFrames":540,"tvDroppedFrames":0,"videoResets":1,"recoveryKeyframes":4,' +
    '"fecRecoveredBlocks":900,"fecFailures":6,"heapTopMb":62,"heapTotalMb":128,"heapGrowthMb":1,' +
    '"hostFrameRateX100":6000,"hostProcessingLatencyX10":61}';
  const report230 = plain(parse(message230));
  assert.equal(report230.hostRfi, false);
  assert.equal(report230.recoveryKeyframes, 4);
  assert.equal(report230.networkDroppedFrames, 540);
  assert.deepEqual(plain(hints(report230, { refFrameInvalidation: false })), ['network']);
  // Only 1 and true count as an offer
  [0, false, '1', 'yes', 2, null, {}].forEach((value) => {
    assert.equal(plain(parse(JSON.stringify({ frames: 10, hostRfi: value }))).hostRfi, false, JSON.stringify(value));
  });
  assert.equal(plain(parse('{"frames":10,"hostRfi":1}')).hostRfi, true);
  assert.equal(plain(parse('{"frames":10,"hostRfi":true}')).hostRfi, true);
});

test('the hint about the sound comes for a surround stream with a window above the limit of the module, with its busiest window', () => {
  const app = loadDiagnostics();
  const hints = app.platform.get('getSessionReportHints');
  const text = app.platform.get('getSessionReportHintText');
  const audio = (channels, windows, extra) => hostReport(60, 60, 4, Object.assign({ audioChannels: channels, audioLoadMsPerS: 250,
    audioLoadPeakMsPerS: 340, audioOverloadedWindows: windows }, extra || {}));
  const cases = [
    // The module counts the windows above its limit (wasm/audio_load.hpp), so the front end keeps no limit of its own:
    // one window is enough, none gives no hint whatever the figures say
    [audio(6, 1), ['audio']], [audio(8, 1), ['audio']], [audio(8, 200), ['audio']],
    [audio(6, 0), ['ok']], [audio(8, 0, { audioLoadMsPerS: 900, audioLoadPeakMsPerS: 900 }), ['ok']],
    // Stereo and mono have no lighter sound to change to, and without an audio output nothing was decoded
    [audio(2, 50), ['ok']], [audio(1, 50), ['ok']], [audio(0, 0), ['ok']],
    // It comes after the hints about the network and the TV and before the others
    [audio(8, 5, { networkDroppedFrames: 2000, tvDroppedFrames: 2000 }), ['network', 'tv', 'audio']],
    [audio(8, 5, { hostProcessingLatencyX10: 140, hostFrameRateX100: 5994 }), ['audio', 'host', 'hostRefresh']],
  ];
  cases.forEach(([report, expected]) => assert.deepEqual(plain(hints(report)), expected, JSON.stringify(report)));
  assert.equal(text('audio', audio(8, 5, { audioLoadPeakMsPerS: 447 })),
    'Decoding and playing the sound took the TV up to 447 ms per second: if the sound stuttered, set Surround audio quality to Efficient, or Audio configuration to Stereo.');
  // In System information, after the figures of the session
  const describe = app.platform.get('describeSessionReport');
  const lines = plain(describe(audio(6, 1), {}));
  assert.equal(lines[lines.length - 1],
    'Hint: Decoding and playing the sound took the TV up to 340 ms per second: if the sound stuttered, set Surround audio quality to Efficient, or Audio configuration to Stereo.');
  // A session that already streamed in the quality Efficient is told the one way that is left, and one in High both
  const efficient = 'Decoding and playing the sound took the TV up to 447 ms per second: if the sound stuttered, set Audio configuration to Stereo.';
  assert.equal(text('audio', audio(8, 5, { audioLoadPeakMsPerS: 447 }), { surroundQuality: 'Efficient' }), efficient);
  assert.ok(text('audio', audio(8, 5), { surroundQuality: 'High' }).indexOf('set Surround audio quality to Efficient, or Audio configuration to Stereo.') > 0);
  const efficientLines = plain(describe(audio(8, 5, { audioLoadPeakMsPerS: 447 }), { surroundQuality: 'Efficient' }));
  assert.equal(efficientLines[efficientLines.length - 1], 'Hint: ' + efficient);
  assert.equal(efficientLines.join('\n').indexOf('Surround audio quality'), -1);
  // The quality changes which remedy the hint names, never whether it comes
  assert.deepEqual(plain(hints(audio(8, 5), { surroundQuality: 'Efficient' })), ['audio']);
  assert.deepEqual(plain(hints(audio(8, 0), { surroundQuality: 'High' })), ['ok']);
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
    'Average frame receive time: 5.48 ms (33% of the frame time), highest second: 19.20 ms (115%)',
    'Host frame rate (best 30 s): 60.00 FPS, average host processing latency: 6.1 ms',
    'Host frame rate (lowest 30 s): 59.90 FPS, below 57 FPS in 0 of 19 half minutes',
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
  assert.equal(plain(describe(Object.assign({}, report, { hostFrameRateX100: 0 }), {}))[5],
    'Host frame rate (best 30 s): Unknown, average host processing latency: 6.1 ms');
  assert.equal(plain(describe(Object.assign({}, report, { hostProcessingLatencyX10: 0 }), {}))[5],
    'Host frame rate (best 30 s): 60.00 FPS, average host processing latency: Unknown');
  // The hint of a host display at 59.94 Hz with its figures
  const refresh = readReports().filter((entry) => entry.name === 'host-refresh')[0];
  const refreshLines = plain(describe(app.platform.get('parseSessionReport')(refresh.message.slice(18)), {}));
  assert.deepEqual(refreshLines.slice(5), [
    'Host frame rate (best 30 s): 59.94 FPS, average host processing latency: 4.7 ms',
    'Host frame rate (lowest 30 s): 59.93 FPS, below 57 FPS in 0 of 59 half minutes',
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

test('every setup call of the video player whose result the start depends on logs a refusal', () => {
  // A listener of the media source or of a track that the player refuses, or a media source that the media element
  // refuses, let the start wait out the 5 seconds of the media setup and end with -200 without a word in the log (until
  // 2.3.1). The calls run in StartStream() (main.cpp) and StartupVidDecSetup() (wasmplayer.cpp), which wait for the
  // media pipeline of the TV and so run in no native test; native/player_errors_test.cpp checks the line itself
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const calls = [];
  for (const file of ['wasm/main.cpp', 'wasm/wasmplayer.cpp']) {
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      if (!/(?:\.|->)(?:SetListener|SetSrc)\(/.test(line) || /^\s*\/\//.test(line)) {
        return;
      }
      calls.push(file + ': ' + line.trim());
      // The media element listener of the constructor checks its result in the if itself (see the test above)
      if (/if \(!m_MediaElement\.SetListener\(&m_MediaElementListener\)\)/.test(line)) {
        return;
      }
      const result = /^\s*auto (\w+) = /.exec(line);
      assert.ok(result, file + ':' + (index + 1) + ': the result is kept: ' + line.trim());
      const next = lines.slice(index + 1, index + 4).join('\n');
      assert.ok(next.indexOf('if (!' + result[1] + ') {') >= 0, file + ':' + (index + 1) + ': the result is checked');
      assert.match(next, new RegExp('ClLogMessage\\("%s", FormatPlayerSetupRejectedLog\\("[^"]+",\\s*static_cast<int>\\(' + result[1] + '\\.operation_result\\)\\)\\.c_str\\(\\)\\);'),
        file + ':' + (index + 1) + ': a refusal is logged with its result');
    });
  }
  // The media element listener, the media source listener, the two track listeners and the media source of the element
  assert.equal(calls.length, 5, calls.join('\n'));
  assert.match(read('wasm/main.cpp'), /#include "player_errors\.hpp"/);
  // The guide names the line where it explains the error -200
  assert.match(read('docs/GUIDE.md'), /\(-200\) \| The same error without a rejected format[^\n]*If the \[diagnostic log\]\(#diagnostic-log\) shows "The video player of the TV rejected …" before the error/);
  assert.match(read('wasm/player_errors.hpp'), /"The video player of the TV rejected "/);
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
  // The windows of its lowest frame rate with it, and the highest frame receive time with the other statistics
  assert.match(reset.slice(0, reset.indexOf('\n}\n')), /s_HostRateWindows = HostRateWindows\(\);/);
  assert.match(setup, /\n {2}s_ReceiveTimePeakX100 = 0;\n/);
  assert.ok(setup.indexOf('s_ReceiveTimePeakX100 = 0;') < setup.indexOf('StartupVidDecSetup('), 'before the media pipeline is set up');
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

test('a session report that can\'t be read is logged with the reason, its length and its escaped text in parts', () => {
  const app = loadPlatformScripts(['wasm/platform/tv_profile.js', 'wasm/platform/diagnostics.js', 'wasm/platform/index.js'],
    { tv: { tv: 's90c', conn: 'wifi' } });
  const before = app.consoleMessages.length;
  const broken = '{"durationMs":12,"codec":"AV1\u0001' + 'x'.repeat(400);
  app.get('keepSessionReport')(broken);
  const warnings = app.consoleMessages.slice(before).filter((message) => message.level === 'warn').map((message) => message.text);
  assert.equal(warnings.length, 3, JSON.stringify(warnings));
  assert.match(warnings[0], /can't be read \(.+, 430 characters\)$/);
  // The control character shows escaped, and the parts together are the whole text as JSON
  const parts = warnings.slice(1).map((text) => {
    const match = /Report text at (\d+): (.*)$/.exec(text);
    assert.ok(match, text);
    return { start: Number(match[1]), text: match[2] };
  });
  assert.deepEqual(parts.map((part) => part.start), [0, 300]);
  assert.ok(parts.every((part) => part.text.length <= 300));
  assert.equal(parts.map((part) => part.text).join(''), JSON.stringify(broken));
  assert.match(parts[0].text, /\\u0001/);
  assert.equal(app.get('lastSessionReport'), null);
});
