'use strict';

// Checks the line of the diagnostic log about what the TV supports of WebAssembly, since 2.3.2
// (probeWebAssemblyFeatures(), describeWebAssemblyFeatures() and logWebAssemblyFeatures() of wasm/platform/tv_profile.js):
// - the line names SIMD 128, bulk memory, threads and sign extension (each checked with WebAssembly.validate() of a tiny
//   module), the answer of tizentvwasm.supportedInstructions() and whether the sockets of the module use the host
//   bindings of the TV, in this order;
// - each tiny module is valid, uses its feature and none of the others;
// - a missing API and an API that throws (also a getter, a broken console) give 'unknown' or an error text instead of
//   breaking the start of the app, and the names of the TV are cleaned and limited;
// - the socket host bindings follow the flag USE_HOST_BINDINGS of the glue code, a top-level 'let' of moonlight-wasm.js,
//   and without it whether tizentvwasm.SocketsHostBindings has every function that the glue code takes;
// - the line keeps its end (the socket host bindings) within the length of a line of the diagnostic log, however long
//   the list of the TV is;
// - the app logs the line once per start, from moduleDidLoad() of index.js or, for a module that failed before, from
//   onNativeModuleFailure(), and the redaction of the diagnostic log leaves it as it is;
// - since 2.3.6 a second line about the browser engine follows it (probeDivisionTime(), probeWebEngine() and
//   describeWebEngine()): the division module computes as JavaScript does, with i32.div_s in export 'a' and i64.div_s
//   in export 'b'; the probe gives a ratio with a clock of 0.1 ms and none with clocks that are too coarse; on a fake
//   engine with a fake clock it warms both loops up first, stops within 15 ms, takes at most 6 runs of each loop and
//   calls the ratio clear only from 3 runs on; missing and throwing APIs give 'unknown', everything before the user
//   agent stays within a line of the log, and the redaction of the log leaves the line as it is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const PROFILE = path.join(REPO_ROOT, 'wasm/platform/tv_profile.js');
const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// tv_profile.js loaded afresh, so that its flag of the logged line starts unset
function freshProfile() {
  delete require.cache[require.resolve(PROFILE)];
  return require(PROFILE);
}
const profile = freshProfile();

// The functions of tizentvwasm.SocketsHostBindings that the glue code of the Samsung Emscripten SDK binds
// (library_tizen_socket_host.js of the SDK, as published in its fork on GitHub)
const SDK_HOST_BINDINGS = ['accept', 'bind', 'close', 'connect', 'getPeerName', 'getSockName', 'getSockOpt', 'listen',
  'poll', 'recv', 'recvFrom', 'recvMsg', 'select', 'send', 'sendMsg', 'sendTo', 'setSockOpt', 'shutdown', 'create'];

function hostBindings(names) {
  const bindings = {};
  names.forEach((name) => {
    bindings[name] = () => 0;
  });
  return bindings;
}

// A WebAssembly of a browser that knows only the features that the test names: validate() rejects a module with the
// opcode prefix or the memory flags of another one, as the browsers before each proposal did
function browserWith(features) {
  const rejects = {
    'SIMD 128': (bytes) => bytes.includes(0xFD),
    'bulk memory': (bytes) => bytes.includes(0xFC),
    threads: (bytes) => bytes.includes(0xFE),
    'sign extension': (bytes) => bytes.includes(0xC0),
  };
  return {
    validate(buffer) {
      assert.ok(buffer instanceof Uint8Array);
      const bytes = Array.from(buffer);
      return !Object.keys(rejects).some((name) => features.indexOf(name) < 0 && rejects[name](bytes));
    },
  };
}

function line(apis) {
  return profile.describeWebAssemblyFeatures(profile.probeWebAssemblyFeatures(apis));
}

test('the line names the four features, the instruction sets of the TV and the socket host bindings, in this order', () => {
  const tizentvwasm = { supportedInstructions: () => ['neon', 'vfpv4'], SocketsHostBindings: hostBindings(SDK_HOST_BINDINGS) };
  assert.equal(line({ webAssembly: WebAssembly, tizentvwasm, socketHostBindingsFlag: true }),
    'WebAssembly features: SIMD 128 yes, bulk memory yes, threads yes, sign extension yes; ' +
    'supportedInstructions of the TV: neon vfpv4; socket host bindings: used');
  // A browser of Tizen 5.5 (Chromium 69), whose WebAssembly has threads for the module of the app and none of the rest
  assert.equal(line({ webAssembly: browserWith(['threads']), tizentvwasm: { supportedInstructions: () => [] }, socketHostBindingsFlag: false }),
    'WebAssembly features: SIMD 128 no, bulk memory no, threads yes, sign extension no; ' +
    'supportedInstructions of the TV: none; socket host bindings: not used');
  assert.deepEqual(profile.probeWebAssemblyFeatures({ webAssembly: browserWith(['SIMD 128', 'sign extension']), tizentvwasm: null })
    .features, [
    { name: 'SIMD 128', supported: 'yes' },
    { name: 'bulk memory', supported: 'no' },
    { name: 'threads', supported: 'no' },
    { name: 'sign extension', supported: 'yes' },
  ]);
});

test('each tiny module is a valid module that uses its feature and none of the others', () => {
  assert.deepEqual(profile.WASM_FEATURE_PROBES.map((probe) => probe.name), ['SIMD 128', 'bulk memory', 'threads', 'sign extension']);
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  profile.WASM_FEATURE_PROBES.forEach((probe) => {
    const bytes = Uint8Array.from(probe.bytes);
    assert.deepEqual(Array.from(bytes.slice(0, 8)), header, probe.name);
    // Node knows all four features, so each module validates and compiles
    assert.equal(WebAssembly.validate(bytes), true, probe.name);
    assert.doesNotThrow(() => new WebAssembly.Module(bytes), probe.name);
    // Each module is rejected by a browser without its feature and accepted by one with only its feature
    assert.equal(browserWith([]).validate(bytes), false, probe.name);
    assert.equal(browserWith([probe.name]).validate(bytes), true, probe.name);
  });
  const text = (name) => profile.WASM_FEATURE_PROBES.find((probe) => probe.name === name).bytes.join(',');
  // i8x16.splat and i8x16.popcnt of the final SIMD proposal, in a function that returns a v128
  assert.match(text('SIMD 128'), /,96,0,1,123,.*,253,15,253,98,11$/);
  // memory.copy of a memory of one page
  assert.match(text('bulk memory'), /,5,3,1,0,1,.*,252,10,0,0,11$/);
  // a shared memory of one page and i32.atomic.load
  assert.match(text('threads'), /,5,4,1,3,1,1,.*,254,16,2,0,26,11$/);
  // i32.extend8_s
  assert.match(text('sign extension'), /,65,0,192,26,11$/);
  // The probe hands validate() a fresh copy, so the frozen lists stay as they are
  assert.ok(profile.WASM_FEATURE_PROBES.every((probe) => Object.isFrozen(probe.bytes)));
});

test('missing APIs give unknown, not offered and not offered by the TV', () => {
  const expected = 'WebAssembly features: SIMD 128 unknown, bulk memory unknown, threads unknown, sign extension unknown; ' +
    'supportedInstructions of the TV: not offered; socket host bindings: not offered by the TV';
  assert.equal(line({ webAssembly: null, tizentvwasm: null, socketHostBindingsFlag: null }), expected);
  // Node has no window or self, so the globals of a TV aren't found either
  assert.equal(line({ socketHostBindingsFlag: null }), expected);
  assert.equal(line({ webAssembly: {}, tizentvwasm: {}, socketHostBindingsFlag: null }), expected);
  assert.equal(line({ webAssembly: { validate: 'no function' }, tizentvwasm: 'no object', socketHostBindingsFlag: null }), expected);
  // A TV without the sockets of every function of the glue code
  const partial = hostBindings(SDK_HOST_BINDINGS.filter((name) => name !== 'recvMsg'));
  assert.match(line({ tizentvwasm: { SocketsHostBindings: partial }, socketHostBindingsFlag: null }),
    /; socket host bindings: not offered by the TV$/);
  assert.match(line({ tizentvwasm: { SocketsHostBindings: hostBindings(SDK_HOST_BINDINGS) }, socketHostBindingsFlag: null }),
    /; socket host bindings: offered by the TV$/);
  assert.deepEqual(profile.SOCKET_HOST_BINDING_FUNCTIONS.slice(), SDK_HOST_BINDINGS);
});

test('APIs that throw give unknown or their error, and never stop the probe', () => {
  const failing = {
    validate() {
      throw new Error('Simulated failure of WebAssembly.validate');
    },
  };
  const tizentvwasm = {
    supportedInstructions() {
      throw new Error('Simulated failure of\n  supportedInstructions with a long message that the line cuts after sixty characters');
    },
    get SocketsHostBindings() {
      throw new Error('Simulated failure of SocketsHostBindings');
    },
  };
  assert.equal(line({ webAssembly: failing, tizentvwasm, socketHostBindingsFlag: null }),
    'WebAssembly features: SIMD 128 unknown, bulk memory unknown, threads unknown, sign extension unknown; ' +
    'supportedInstructions of the TV: failed (Simulated failure of supportedInstructions with a long messa); ' +
    'socket host bindings: unknown');
  // Getters that throw, an answer that is no boolean, a list that is none
  const getters = {
    get validate() {
      throw new Error('Simulated getter');
    },
  };
  const odd = { validate: () => 1 };
  assert.match(line({ webAssembly: getters, tizentvwasm: { get supportedInstructions() {
    throw new TypeError('Simulated getter');
  } }, socketHostBindingsFlag: true }),
  /^WebAssembly features: SIMD 128 unknown, bulk memory unknown, threads unknown, sign extension unknown; supportedInstructions of the TV: failed \(Simulated getter\); socket host bindings: used$/);
  assert.match(line({ webAssembly: odd, tizentvwasm: { supportedInstructions: () => 'neon' } }),
    /SIMD 128 unknown, .*; supportedInstructions of the TV: failed \(no list\);/);
  assert.match(line({ tizentvwasm: { supportedInstructions: () => null } }), /supportedInstructions of the TV: failed \(no list\);/);
  // Only one feature fails
  let calls = 0;
  const flaky = {
    validate() {
      calls++;
      if (calls === 2) {
        throw new Error('Simulated failure of one check');
      }
      return true;
    },
  };
  assert.match(line({ webAssembly: flaky }), /^WebAssembly features: SIMD 128 yes, bulk memory unknown, threads yes, sign extension yes;/);
});

test('the names of supportedInstructions() are cleaned and limited, and the list may be array-like', () => {
  const names = ['neon', 'sse4.2', 'a b<c>:d', '', 42, 'x'.repeat(40), null];
  for (let i = 0; i < 12; i++) {
    names.push('set' + i);
  }
  const probe = profile.probeWebAssemblyFeatures({ tizentvwasm: { supportedInstructions: () => names } });
  assert.deepEqual(probe.instructions, ['neon', 'sse4.2', 'abcd', '42', 'x'.repeat(32), 'null', 'set0', 'set1', 'set2',
    'set3', 'set4', 'set5', 'set6', 'set7', 'set8', 'set9']);
  assert.equal(probe.moreInstructions, 2);
  assert.match(profile.describeWebAssemblyFeatures(probe), /supportedInstructions of the TV: neon sse4\.2 abcd 42 x{32} null set0 .* set9 \(\+2 more\);/);
  // A list of the Tizen web runtime that is no array
  const arrayLike = { length: 2, 0: 'neon', 1: 'simd' };
  assert.match(line({ tizentvwasm: { supportedInstructions: () => arrayLike } }), /supportedInstructions of the TV: neon simd;/);
  // The function is called on tizentvwasm, as the glue code does
  const api = { name: 'tv', supportedInstructions() {
    return [this.name];
  } };
  assert.match(line({ tizentvwasm: api }), /supportedInstructions of the TV: tv;/);
});

test('the longest line keeps the socket host bindings within the length of a line of the diagnostic log', () => {
  const maxLineLength = Number(/const MAX_LINE_LENGTH = (\d+);/.exec(read('wasm/platform/diagnostics.js'))[1]);
  // Every other value at its longest: no WebAssembly (unknown), no flag and no host bindings (not offered by the TV),
  // and lists of names at their longest, of a common length, and many short ones, with up to 99999 more
  const lists = [
    Array.from({ length: 100000 }, (_, i) => 'x'.repeat(27) + String(10000 + i)),
    Array.from({ length: 40 }, (_, i) => 'instruction_set_' + i),
    Array.from({ length: 40 }, (_, i) => 'a' + i),
  ];
  lists.forEach((names) => {
    const page = loadPlatformScripts(['wasm/platform/diagnostics.js', 'wasm/platform/tv_profile.js'], {
      globals: { Date, WebAssembly: null, tizentvwasm: { supportedInstructions: () => names } },
    });
    page.run('DiagnosticLog.captureConsole(console);');
    page.run('logWebAssemblyFeatures();');
    const logged = plain(page.get('DiagnosticLog.getSessions()'))[0].lines.filter((text) => text.indexOf('WebAssembly features') >= 0);
    assert.equal(logged.length, 1);
    const text = logged[0].slice(logged[0].indexOf('[tv_profile.js, logWebAssemblyFeatures] '));
    assert.ok(text.length <= maxLineLength, text.length + ': ' + text);
    assert.ok(text.endsWith(' more); socket host bindings: not offered by the TV'), text);
    assert.match(text, /^\[tv_profile\.js, logWebAssemblyFeatures\] WebAssembly features: SIMD 128 unknown, bulk memory unknown, threads unknown, sign extension unknown; supportedInstructions of the TV: \S/);
  });
  // The names that fit are kept whole, in their order, and the others counted
  const probe = profile.probeWebAssemblyFeatures({ tizentvwasm: { supportedInstructions: () => lists[1] } });
  assert.deepEqual(probe.instructions, lists[1].slice(0, probe.instructions.length));
  assert.ok(probe.instructions.join(' ').length <= 150 && probe.instructions.length >= 8, probe.instructions.join(' '));
  assert.equal(probe.instructions.length + probe.moreInstructions, 40);
});

test('the socket host bindings follow the flag of the glue code, a top-level let of moonlight-wasm.js', () => {
  // tv_profile.js and the glue code as two scripts of one page, the second one loaded later (common.js)
  const page = loadPlatformScripts(['wasm/platform/tv_profile.js']);
  const probe = () => plain(page.get('probeWebAssemblyFeatures({ tizentvwasm: null })')).socketHostBindings;
  assert.equal(probe(), 'not offered by the TV', 'before the module loaded');
  page.run('let USE_HOST_BINDINGS = true;');
  assert.equal(probe(), 'used');
  page.run('USE_HOST_BINDINGS = false;');
  assert.equal(probe(), 'not used');
  // A value that is no boolean doesn't count
  page.run('USE_HOST_BINDINGS = "yes";');
  assert.equal(probe(), 'not offered by the TV');
  // In the page, the WebAssembly of the browser is found through window
  assert.match(page.get('describeWebAssemblyFeatures(probeWebAssemblyFeatures())'),
    /^WebAssembly features: SIMD 128 yes, bulk memory yes, threads yes, sign extension yes;/);
});

test('logWebAssemblyFeatures() logs its two lines once per start and never throws', () => {
  const fresh = freshProfile();
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args.map(String).join(' '));
  try {
    assert.equal(fresh.logWebAssemblyFeatures({ webAssembly: WebAssembly, tizentvwasm: null, socketHostBindingsFlag: true }), true);
    assert.equal(fresh.logWebAssemblyFeatures({ webAssembly: WebAssembly, tizentvwasm: null, socketHostBindingsFlag: true }), false);
    assert.equal(fresh.logWebAssemblyFeatures(), false);
  } finally {
    console.log = originalLog;
  }
  // The line about WebAssembly, then the line about the browser engine (tested below)
  assert.equal(logged.length, 2, logged.join('\n'));
  assert.equal(logged[0], '%c[tv_profile.js, logWebAssemblyFeatures] color: purple; WebAssembly features: SIMD 128 yes, ' +
    'bulk memory yes, threads yes, sign extension yes; supportedInstructions of the TV: not offered; socket host bindings: used');
  assert.ok(logged[1].startsWith('%c[tv_profile.js, logWebAssemblyFeatures] color: purple; Web engine: '), logged[1]);

  // Everything throws: WebAssembly, tizentvwasm and even the console
  const broken = freshProfile();
  const throwing = new Proxy({}, { get() {
    throw new Error('Simulated failure of every property');
  } });
  console.log = () => {
    throw new Error('Simulated failure of the console');
  };
  try {
    assert.doesNotThrow(() => assert.equal(broken.logWebAssemblyFeatures({ webAssembly: throwing, tizentvwasm: throwing }), true));
    assert.equal(broken.logWebAssemblyFeatures(), false);
  } finally {
    console.log = originalLog;
  }
  assert.equal(broken.describeWebAssemblyFeatures(broken.probeWebAssemblyFeatures({ webAssembly: throwing, tizentvwasm: throwing,
    socketHostBindingsFlag: null })), 'WebAssembly features: SIMD 128 unknown, bulk memory unknown, threads unknown, ' +
    'sign extension unknown; supportedInstructions of the TV: failed (Simulated failure of every property); socket host bindings: unknown');
});

test('both lines reach the diagnostic log once and their redaction leaves them as they are', () => {
  const page = loadPlatformScripts(['wasm/platform/diagnostics.js', 'wasm/platform/tv_profile.js'], {
    globals: { Date, tizentvwasm: { supportedInstructions: () => ['neon'], SocketsHostBindings: hostBindings(SDK_HOST_BINDINGS) } },
  });
  // diagnostics.js keeps the console lines of the page from its start
  page.run('DiagnosticLog.captureConsole(console);');
  page.run('logWebAssemblyFeatures(); logWebAssemblyFeatures();');
  const all = plain(page.get('DiagnosticLog.getSessions()'))[0].lines;
  const lines = all.filter((text) => text.indexOf('WebAssembly features') >= 0);
  assert.equal(lines.length, 1, lines.join('\n'));
  // (the log counts a line that repeats the one before instead of keeping it again, so no count either)
  assert.ok(all.every((text) => text.indexOf('the line before came') < 0), all.join('\n'));
  const expected = '[tv_profile.js, logWebAssemblyFeatures] WebAssembly features: SIMD 128 yes, bulk memory yes, threads yes, ' +
    'sign extension yes; supportedInstructions of the TV: neon; socket host bindings: offered by the TV';
  assert.ok(lines[0].endsWith(' app    ' + expected), lines[0]);
  const redact = page.get('redactDiagnosticText');
  assert.equal(redact(expected), expected);
  // Every value of the line passes the redaction unchanged
  ['not offered', 'none', 'failed (no list)', 'used', 'not used', 'not offered by the TV', 'unknown'].forEach((value) => {
    const text = 'WebAssembly features: SIMD 128 unknown, bulk memory no, threads yes, sign extension no; ' +
      'supportedInstructions of the TV: ' + value + '; socket host bindings: ' + value;
    assert.equal(redact(text), text);
  });
  // The line about the browser engine comes once as well, and the redaction leaves it as it is, with every form of the
  // division time and the user agents of Tizen 5.5 and 7.0, whose version numbers look a little like addresses
  const engineLines = all.filter((text) => text.indexOf('Web engine: ') >= 0);
  assert.equal(engineLines.length, 1, all.join('\n'));
  const logged = engineLines[0].slice(engineLines[0].indexOf('Web engine: '));
  assert.equal(redact(logged), logged);
  const describe = page.get('describeWebEngine');
  const divisions = [
    { ratio: 1.12, runs: 6, clear: true, stepMs: 0.1, error: null },
    { ratio: 4.2, runs: 2, clear: false, stepMs: 0.005, error: null },
    { ratio: null, runs: 0, clear: false, stepMs: 1, error: 'clock too coarse' },
    { ratio: null, runs: 0, clear: false, stepMs: 0.1, error: 'no run long enough' },
    { ratio: null, runs: 0, clear: false, stepMs: null, error: 'unavailable' },
  ];
  [
    { userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106.1/5.5 TV Safari/537.36',
      cores: '4', platform: 'Linux armv7l', cpuArch: 'armv7' },
    { userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36',
      cores: '8', platform: 'Linux aarch64', cpuArch: 'aarch64' },
    { userAgent: 'unknown', cores: 'unknown', platform: 'unknown', cpuArch: 'unknown' },
  ].forEach((engine) => divisions.forEach((division) => {
    const text = describe(Object.assign({ division }, engine));
    assert.equal(redact(text), text);
  }));
});

test('the app logs the line from moduleDidLoad(), once the runtime of the module is up, or when the module failed, and nowhere else', () => {
  const index = read('wasm/platform/index.js');
  assert.match(index, /function moduleDidLoad\(\) \{\n(?:\s*\/\/.*\n)*\s*logWebAssemblyFeatures\(\);\n\s*loadHTTPCerts\(\);\n\}/);
  // A module that the browser of the TV couldn't start never gets to moduleDidLoad(): its abort reaches
  // onNativeModuleFailure(), which logs the line before its error (tests/browser/runtime-checks.test.js runs it)
  assert.match(index, /function onNativeModuleFailure\(details\) \{\n\s*if \(isNativeModuleFailed\) \{\n\s*return;\n\s*\}\n\s*isNativeModuleFailed = true;\n(?:\s*\/\/.*\n)*\s*logWebAssemblyFeatures\(\);\n\s*console\.error\(/);
  const platform = path.join(REPO_ROOT, 'wasm/platform');
  const calls = fs.readdirSync(platform).filter((name) => /\.js$/.test(name)).map((name) => {
    // (without the comments, which name the function)
    const source = fs.readFileSync(path.join(platform, name), 'utf8').replace(/\/\/.*$/gm, '');
    return (source.match(/(?<!function )\blogWebAssemblyFeatures\(/g) || []).length;
  });
  assert.equal(calls.reduce((sum, count) => sum + count, 0), 2);
  // common.js calls moduleDidLoad() from onRuntimeInitialized of the module, once per start of the page
  assert.match(read('wasm/platform/common.js'), /onRuntimeInitialized: \(\) => \{[\s\S]*?window\.moduleDidLoad\(\);/);
});

// The line about the browser engine, since 2.3.6 (probeDivisionTime(), probeWebEngine() and describeWebEngine())
function fakeClock(stepMs) {
  return { now: () => Math.floor(performance.now() / stepMs) * stepMs };
}

// The sections of a WebAssembly module by their id, each as its bytes (every size in the division module fits in one
// byte of LEB128)
function moduleSections(bytes) {
  const sections = {};
  for (let at = 8; at < bytes.length; at += 2 + bytes[at + 1]) {
    assert.ok(bytes[at + 1] < 128, 'size of section ' + bytes[at]);
    sections[bytes[at]] = bytes.slice(at + 2, at + 2 + bytes[at + 1]);
  }
  return sections;
}

// probeDivisionTime() on a fake engine with a fake clock of 0.1 ms steps: a call of loop 'a' or 'b' moves the clock by
// n times its cost per loop (perLoop) plus its cost per call (perCall), the first call of 0.8 ms or more also by its
// stall (another process that takes the CPU meanwhile), and each reading of the clock by 1 µs. Returns the result and
// the calls ({ name, n, k, from, to }, in ms of the fake clock).
function fakeEngineProbe(costs) {
  let now = 100;
  const calls = [];
  const stalled = {};
  const loop = (name) => (n, k) => {
    const from = now;
    now += n * (costs[name].perLoop || 0) + (costs[name].perCall || 0);
    if (costs[name].stall && !stalled[name] && now - from >= 0.8) {
      stalled[name] = true;
      now += costs[name].stall;
    }
    calls.push({ name, n, k, from, to: now });
    return 0;
  };
  const exportsOf = { a: loop('a'), b: loop('b') };
  const webAssembly = { Module: function() {}, Instance: function() {
    this.exports = exportsOf;
  } };
  const clock = { now: () => {
    now += 0.001;
    return Math.floor(now / 0.1) * 0.1;
  } };
  return { probe: profile.probeDivisionTime({ webAssembly, performance: clock }), calls };
}

test('the division module is valid and both loops compute the same as JavaScript', () => {
  const bytes = new Uint8Array(profile.DIVISION_PROBE_BYTES);
  assert.equal(WebAssembly.validate(bytes), true);
  const loops = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
  [1, 2, 7, 1000].forEach((n) => [3, 7].forEach((k) => {
    let a32 = 123456789;
    let a64 = 123456789n;
    for (let i = 0; i < n; i++) {
      a32 = ((a32 / k) | 0) ^ 0x55555555;
      a64 = (a64 / BigInt(k)) ^ 0x55555555n;
    }
    assert.equal(loops.a(n, k), a32 | 0);
    assert.equal(loops.b(n, k), Number(BigInt.asIntN(32, a64)));
  }));
  // Every value stays within 32 bits, so both loops give the same results, and only the bytes of the module show which
  // division each export runs. One function type (i32, i32) -> i32 for both functions, with no i64 in it
  const sections = moduleSections(Array.from(bytes));
  assert.deepEqual(Object.keys(sections), ['1', '3', '7', '10']);
  assert.deepEqual(sections[1], [1, 96, 2, 127, 127, 1, 127]);
  assert.deepEqual(sections[3], [2, 0, 0]);
  // Export 'a' is the first function and 'b' the second
  assert.deepEqual(sections[7], [2, 1, 97, 0, 0, 1, 98, 0, 1]);
  const code = sections[10];
  assert.equal(code[0], 2);
  const bodyA = code.slice(2, 2 + code[1]);
  const bodyB = code.slice(3 + code[1], 3 + code[1] + code[2 + code[1]]);
  assert.equal(3 + bodyA.length + bodyB.length, code.length);
  const has = (body, sequence) => body.some((_, at) => sequence.every((byte, k) => body[at + k] === byte));
  // 'a': one more i32 local, and a / k with i32.div_s (local.get 2, local.get 1, 0x6D)
  assert.deepEqual(bodyA.slice(0, 3), [1, 1, 127]);
  assert.ok(has(bodyA, [32, 2, 32, 1, 109]), bodyA.join(','));
  // 'b': two i64 locals, k widened with i64.extend_i32_s (local.get 1, 0xAC, local.set 3), a / k with i64.div_s
  // (local.get 2, local.get 3, 0x7F), and the low 32 bits of a returned with i32.wrap_i64 (local.get 2, 0xA7, end)
  assert.deepEqual(bodyB.slice(0, 3), [1, 2, 126]);
  assert.ok(has(bodyB, [32, 1, 172, 33, 3]), bodyB.join(','));
  assert.ok(has(bodyB, [32, 2, 32, 3, 127]), bodyB.join(','));
  assert.deepEqual(bodyB.slice(-4), [32, 2, 167, 11]);
});

test('the division probe gives a ratio with the WebAssembly of the tests, and no ratio with a clock that is too coarse', () => {
  // A busy machine can hold up a run of the i32 loop for so long that the time is up before the i64 loop had a run
  // that counts ('no run long enough', which the line shows as unknown, as on a busy TV), so the probe gets up to 3
  // tries here. Its time limit and its runs are pinned on the fake engine below, since a busy machine stretches the
  // time of the real one.
  let probe = null;
  for (let attempt = 0; attempt < 3 && !(probe && probe.error === null); attempt++) {
    probe = profile.probeDivisionTime({ webAssembly: WebAssembly, performance: fakeClock(0.1) });
  }
  assert.equal(probe.error, null, JSON.stringify(probe));
  assert.ok(probe.runs >= 1 && probe.runs <= 6, JSON.stringify(probe));
  assert.equal(probe.clear, probe.runs >= 3);
  // A 64-bit engine (the one of the tests) divides both with one instruction. A busy machine may leave too few runs
  // for a clear ratio, and then the ratio may be anything.
  assert.ok(!probe.clear || (probe.ratio > 0.5 && probe.ratio < 2), JSON.stringify(probe));
  assert.ok(Math.abs(probe.stepMs - 0.1) < 1e-9, JSON.stringify(probe));
  [{ now: () => 5 }, fakeClock(1), fakeClock(16)].forEach((clock) => {
    const coarse = profile.probeDivisionTime({ webAssembly: WebAssembly, performance: clock });
    assert.deepEqual([coarse.ratio, coarse.runs, coarse.error], [null, 0, 'clock too coarse']);
  });
});

test('on a fake engine the probe warms both loops up, stops within 15 ms and calls the ratio clear only from 3 runs on', () => {
  // Loops of 0.01 and 0.02 µs per division: both warmed up with 1000 divisions by 3 before the clock starts, then up to
  // 6 runs of each that count (from 0.8 ms on, about 1 ms each), all done within 15 ms of the start
  const fast = fakeEngineProbe({ a: { perLoop: 1e-5 }, b: { perLoop: 2e-5 } });
  assert.deepEqual(fast.calls.slice(0, 2).map((call) => [call.name, call.n, call.k]), [['a', 1000, 3], ['b', 1000, 3]]);
  assert.ok(fast.calls.every((call) => call.k === 3));
  assert.deepEqual([fast.probe.runs, fast.probe.clear, fast.probe.error], [6, true, null]);
  assert.ok(fast.probe.ratio > 1.7 && fast.probe.ratio < 2.3, JSON.stringify(fast.probe));
  const start = fast.calls[1].to;
  // (within one step of the clock, which reads the time a little early)
  assert.ok(fast.calls[fast.calls.length - 1].to <= start + 15 + 0.1, JSON.stringify(fast.calls));
  // (a run that counts reads at least 0.8 ms on the clock of 0.1 ms steps, so it took more than 0.8 ms)
  const long = (name) => fast.calls.filter((call) => call.name === name && call.to - call.from >= 0.9);
  assert.deepEqual([long('a').length, long('b').length], [6, 6], JSON.stringify(fast.calls));
  assert.ok(long('a').concat(long('b')).every((call) => call.to - call.from <= 1.2), JSON.stringify(fast.calls));
  // Runs of 0.95 ms whatever their length: 6 of each, and then the probe stops, well within 15 ms
  const capped = fakeEngineProbe({ a: { perCall: 0.95 }, b: { perCall: 0.95 } });
  assert.deepEqual([capped.probe.runs, capped.probe.clear, capped.calls.length], [6, true, 2 + 12]);
  // (each run reads 0.9 or 1.0 ms on the clock)
  assert.ok(capped.probe.ratio >= 0.9 / 1.0 && capped.probe.ratio <= 1.0 / 0.9 + 1e-9, JSON.stringify(capped.probe));
  // An i64 loop of 3 ms per run leaves time for only 2 runs of the i32 loop, and no run starts that would end after
  // 15 ms: a ratio, but not a clear one. With 2 ms per run there are 3, which is enough.
  const slow = fakeEngineProbe({ a: { perLoop: 1e-5 }, b: { perCall: 3 } });
  assert.deepEqual([slow.probe.runs, slow.probe.clear, slow.probe.error], [2, false, null]);
  assert.ok(slow.probe.ratio > 100, JSON.stringify(slow.probe));
  assert.ok(slow.calls[slow.calls.length - 1].to <= slow.calls[1].to + 15 + 0.1, JSON.stringify(slow.calls));
  const slower = fakeEngineProbe({ a: { perLoop: 1e-5 }, b: { perCall: 2 } });
  assert.deepEqual([slower.probe.runs, slower.probe.clear, slower.probe.error], [3, true, null]);
  // A first run of the i32 loop that another process holds up for 14 ms uses up the time before the i64 loop had a
  // run that counts
  const held = fakeEngineProbe({ a: { perLoop: 1e-5, stall: 14 }, b: { perLoop: 1e-5 } });
  assert.deepEqual([held.probe.ratio, held.probe.runs, held.probe.clear, held.probe.error], [null, 0, false, 'no run long enough']);
  // Loops that never take 0.8 ms stop at 2^21 divisions per run
  const tiny = fakeEngineProbe({ a: { perCall: 0.01 }, b: { perCall: 0.01 } });
  assert.deepEqual([tiny.probe.ratio, tiny.probe.runs, tiny.probe.error], [null, 0, 'no run long enough']);
  assert.equal(Math.max.apply(null, tiny.calls.map((call) => call.n)), 1 << 21);
});

test('the line about the browser engine names what the TV says, and unknown for what is missing or throws', () => {
  const tv = {
    navigator: { userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36',
      hardwareConcurrency: 4, platform: 'Linux armv7l' },
    tizen: { systeminfo: { getCapability: (key) => (key === 'http://tizen.org/feature/platform.core.cpu.arch' ? 'armv7' : null) } },
    webAssembly: null,
  };
  assert.equal(profile.describeWebEngine(profile.probeWebEngine(tv)), 'Web engine: i64/i32 division time unknown (unavailable); ' +
    'cores 4; platform Linux armv7l; Tizen CPU architecture armv7; user agent Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36');
  const division = (ratio, runs, stepMs, error) => profile.describeWebEngine({ userAgent: 'u', cores: '4', platform: 'p',
    cpuArch: 'a', division: { ratio: ratio, runs: runs, clear: runs >= 3, stepMs: stepMs, error: error } });
  assert.equal(division(6.25, 3, 0.1, null),
    'Web engine: i64/i32 division time 6.25 (3 runs, clock step 0.10 ms); cores 4; platform p; Tizen CPU architecture a; user agent u');
  assert.equal(division(7.312, 1, 0.1, null).split(';')[0], 'Web engine: i64/i32 division time unclear (7.31 from only 1 run, clock step 0.10 ms)');
  assert.equal(division(null, 0, 1, 'clock too coarse').split(';')[0], 'Web engine: i64/i32 division time unknown (clock too coarse, clock step 1.00 ms)');
  assert.equal(division(1.1, 6, 0.005, null).split(';')[0], 'Web engine: i64/i32 division time 1.10 (6 runs, clock step 0.005 ms)');
  const throwing = new Proxy({}, { get() {
    throw new Error('Simulated failure of every property');
  } });
  assert.equal(profile.describeWebEngine(profile.probeWebEngine({ navigator: throwing, tizen: throwing, webAssembly: throwing })),
    'Web engine: i64/i32 division time unknown (Simulated failure of every property); cores unknown; platform unknown; ' +
    'Tizen CPU architecture unknown; user agent unknown');
  // Everything before the user agent stays within a line of the diagnostic log, whatever the TV answers
  const maxLineLength = Number(/const MAX_LINE_LENGTH = (\d+);/.exec(read('wasm/platform/diagnostics.js'))[1]);
  const long = profile.describeWebEngine(profile.probeWebEngine({ navigator: { userAgent: 'u'.repeat(500),
    hardwareConcurrency: 'c'.repeat(500), platform: 'p'.repeat(500) },
  tizen: { systeminfo: { getCapability: () => 'a'.repeat(500) } }, webAssembly: { Module: function() {
    throw new Error('x'.repeat(500));
  }, Instance: function() {} }, performance: fakeClock(0.1) }));
  const tag = '[tv_profile.js, logWebAssemblyFeatures] ';
  assert.ok((tag + long.slice(0, long.indexOf('; user agent '))).length <= maxLineLength - 60, long);
  assert.ok(long.endsWith('; user agent ' + 'u'.repeat(200)), long);
});
