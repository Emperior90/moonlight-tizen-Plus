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
//   describeWebEngine()): the division module computes as JavaScript does, the probe gives a ratio within about 15 ms
//   with a clock of 0.1 ms and none with clocks that are too coarse, missing and throwing APIs give 'unknown', and
//   everything before the user agent stays within a line of the log.

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

test('the line reaches the diagnostic log once and its redaction leaves it as it is', () => {
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
  // i32.div_s (0x6D) only in the first function, i64.div_s (0x7F) and i64.extend_i32_s (0xAC) only in the second
  assert.deepEqual([109, 127].map((op) => bytes.indexOf(op) >= 0), [true, true]);
});

test('the division probe gives a ratio within about 15 ms, and no ratio with a clock that is too coarse', () => {
  const started = performance.now();
  const probe = profile.probeDivisionTime({ webAssembly: WebAssembly, performance: fakeClock(0.1) });
  const took = performance.now() - started;
  assert.equal(probe.error, null);
  assert.ok(probe.runs >= 1 && probe.runs <= 6, JSON.stringify(probe));
  assert.equal(probe.clear, probe.runs >= 3);
  // A 64-bit engine (the one of the tests) divides both with one instruction. A busy machine may leave too few runs
  // for a clear ratio, and then the ratio may be anything.
  assert.ok(!probe.clear || (probe.ratio > 0.5 && probe.ratio < 2), JSON.stringify(probe));
  assert.ok(Math.abs(probe.stepMs - 0.1) < 1e-9, JSON.stringify(probe));
  assert.ok(took < 60, took + ' ms');
  [{ now: () => 5 }, fakeClock(1), fakeClock(16)].forEach((clock) => {
    const coarse = profile.probeDivisionTime({ webAssembly: WebAssembly, performance: clock });
    assert.deepEqual([coarse.ratio, coarse.runs, coarse.error], [null, 0, 'clock too coarse']);
  });
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
