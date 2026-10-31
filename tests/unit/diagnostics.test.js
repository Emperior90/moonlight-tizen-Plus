'use strict';

// Pins wasm/platform/diagnostics.js: what the log hides (the remote input keys, the pairing secrets and PIN, the unique
// ID and the RTSP session URL), the log of the current and the previous session (a new session for each stream, the
// lines of the console with the style of '%c' left out and the console still getting them, the lines that only repeat
// the overlay left out, a repeated line counted, the oldest lines dropped when a session is full, the native lines of the
// module merged by their time and hidden the same way), the report of the last session read from the messages of
// tests/fixtures/session-reports.tsv with their hints and its lines for System information, and the heartbeat of a stream
// that reports once at the next start that the app ended during it (not for a stream in the background), and that the
// native lines come from the ring that every log line of the module enters.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

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
      return { name: fields[0], fields, message: fields[17], hints: fields[18].split(',') };
    });
}

test('the report of each message of the fixture, with its hints', () => {
  const app = loadDiagnostics();
  const parse = app.platform.get('parseSessionReport');
  const hints = app.platform.get('getSessionReportHints');
  const reports = readReports();
  assert.equal(reports.length, 7);
  reports.forEach((entry) => {
    assert.ok(entry.message.indexOf('SessionReportMsg: ') === 0, entry.name);
    const report = plain(parse(entry.message.slice('SessionReportMsg: '.length)));
    assert.equal(report.durationMs, Number(entry.fields[1]), entry.name);
    assert.equal(report.codec, entry.fields[2], entry.name);
    assert.equal(report.frames, Number(entry.fields[7]), entry.name);
    assert.equal(report.heapGrowthMb, Number(entry.fields[16]), entry.name);
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
    'WASM heap at the end: 62 of 128 MB (+1 MB in this session)',
    'Hint: Many frames were lost on the network: use a cable or lower the bitrate.',
    'Hint: The PC often sent whole frames again after a loss: turn on Reference frame invalidation in the Advanced Settings.',
  ]);
  const noVideo = readReports().filter((entry) => entry.name === 'no-video')[0];
  const lines = plain(describe(app.platform.get('parseSessionReport')(noVideo.message.slice(18)), {}));
  assert.equal(lines[0], 'Last session: 4 s, No video, 75 Mbps');
  assert.equal(lines[lines.length - 1], 'Hint: No video arrived from the PC in this session.');
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
