'use strict';

// Checks tools/patch-embind-string.js, which the Dockerfile runs on the generated moonlight-wasm.js. The code that
// Embind generates to read a std::string from C++ (fromWireType) writes a zero into the byte after the string and puts
// the old byte back afterwards; that byte can be the head of the next chunk of the heap, which another thread may
// change in between (see the script). The patched code reads the same string without writing anything.
//
// fixtures/embind-std-string.js is an unchanged excerpt of the moonlight-wasm.js of a release build of this app. The
// tests patch it, evaluate the original and the patched registration of std::string on a simulated heap that records
// every write, run the script as the Dockerfile does, and check the step of the Dockerfile.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { REPO_ROOT } = require('../lib/dev-modules');

const SCRIPT = path.join(REPO_ROOT, 'tools/patch-embind-string.js');
const FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/embind-std-string.js');
const { ORIGINAL, PATCHED, patchEmbindString } = require(SCRIPT);

const fixture = fs.readFileSync(FIXTURE, 'utf8');

// The value of the byte after the string in the tests: the lowest byte of the head of the next chunk of the heap
const GUARD = 0xab;

// Evaluate the registration of std::string of the given source on a simulated heap and return a reader that puts a
// string into the heap the way C++ does (a 32-bit length, then the bytes, no terminator) and reads it back with
// fromWireType. HEAPU8 records every write; `duringRead(heap, guardIndex)` runs whenever the code decodes a segment,
// standing in for another thread that works on the heap at that moment.
function loadRegistration(source) {
  const memory = new ArrayBuffer(4096);
  const bytes = new Uint8Array(memory);
  const writes = [];
  const freed = [];
  let registered = null;
  const sandbox = {
    HEAPU8: new Proxy(bytes, {
      set(target, property, value) {
        writes.push({ index: Number(property), value });
        target[property] = value;
        return true;
      },
    }),
    HEAPU32: new Uint32Array(memory),
    readLatin1String: (name) => name,
    registerType: (rawType, descriptor) => {
      registered = descriptor;
    },
    _free: (pointer) => freed.push(pointer),
    simpleReadValueFromPointer: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: FIXTURE });
  vm.runInContext('__embind_register_std_string(1, "std::string")', sandbox);
  assert.ok(registered && typeof registered.fromWireType === 'function', 'std::string was not registered');

  const decode = sandbox.UTF8ToString;
  return {
    writes,
    freed,
    bytes,
    // Write the UTF-8 bytes at the pointer, followed by the guard byte, and read them back as a std::string
    read(utf8, options) {
      const opts = options || {};
      const pointer = 256;
      const guardIndex = pointer + 4 + utf8.length;
      bytes.fill(0);
      new Uint32Array(memory)[pointer >> 2] = utf8.length;
      bytes.set(utf8, pointer + 4);
      bytes[guardIndex] = opts.guard === undefined ? GUARD : opts.guard;
      writes.length = 0;
      const guardDuringRead = [];
      sandbox.UTF8ToString = function(ptr, maxBytesToRead) {
        guardDuringRead.push(bytes[guardIndex]);
        if (opts.duringRead) {
          opts.duringRead(bytes, guardIndex);
        }
        return decode(ptr, maxBytesToRead);
      };
      const value = registered.fromWireType(pointer);
      return { value, guardIndex, guardDuringRead, guardAfter: bytes[guardIndex], writes: writes.slice() };
    },
  };
}

// Strings that C++ posts to JavaScript: plain text, the multiple of 8 that hits the next chunk, multi-byte UTF-8,
// empty, and zero bytes inside the string, which Embind keeps as U+0000
const STRINGS = [
  'hello',
  'abcdefgh',
  'abcdefghijklmnop',
  '',
  'a\u0000b',
  '\u0000',
  'abc\u0000',
  '\u0000abc',
  '\u0000\u0000',
  'Grüße, äöü €',
  'controller 🎮 ok',
  JSON.stringify({ stats: 'Average frame pacing delay: 0.42 ms', fps: 59.94, lines: ['RTT 3 ms', 'Drops 0'] }),
];

test('the original code is in the generated file exactly once and the patch replaces it', () => {
  const patched = patchEmbindString(fixture);
  assert.equal(patched.split(ORIGINAL).length - 1, 0);
  assert.equal(patched.split(PATCHED).length - 1, 1);
  // Nothing else changes
  assert.equal(patched.replace(PATCHED, ORIGINAL), fixture);
});

test('both versions read every string the same way, and the patched one never writes to the heap', () => {
  const original = loadRegistration(fixture);
  const patched = loadRegistration(patchEmbindString(fixture));
  STRINGS.forEach((text) => {
    const utf8 = Buffer.from(text, 'utf8');
    const before = original.read(utf8);
    const after = patched.read(utf8);
    assert.equal(before.value, text, 'original: ' + JSON.stringify(text));
    assert.equal(after.value, text, 'patched: ' + JSON.stringify(text));
    assert.deepEqual(after.writes, [], 'the patched code wrote to the heap for ' + JSON.stringify(text));
    assert.equal(after.guardAfter, GUARD);
    after.guardDuringRead.forEach((value) => assert.equal(value, GUARD));
  });
  // Every read frees the buffer of C++ once, in both versions
  assert.equal(original.freed.length, STRINGS.length);
  assert.equal(patched.freed.length, STRINGS.length);
});

test('the original code writes a zero into the byte after the string while it decodes', () => {
  const original = loadRegistration(fixture);
  const result = original.read(Buffer.from('abcdefgh'));
  assert.equal(result.value, 'abcdefgh');
  assert.deepEqual(result.writes, [{ index: result.guardIndex, value: 0 }, { index: result.guardIndex, value: GUARD }]);
  assert.deepEqual(result.guardDuringRead, [0]);
});

test('a change of the next chunk by another thread during the read is lost with the original code and kept with the patch', () => {
  // Another thread's malloc or free updates the head of the next chunk while JavaScript decodes the string
  const otherThread = (bytes, guardIndex) => {
    bytes[guardIndex] = 0xcd;
  };
  const original = loadRegistration(fixture).read(Buffer.from('abcdefgh'), { duringRead: otherThread });
  assert.equal(original.guardAfter, GUARD, 'the original code puts the old byte back over the change of the other thread');
  const patched = loadRegistration(patchEmbindString(fixture)).read(Buffer.from('abcdefgh'), { duringRead: otherThread });
  assert.equal(patched.guardAfter, 0xcd, 'the patched code must keep the change of the other thread');
});

test('a string followed by a zero byte reads the same in both versions', () => {
  const original = loadRegistration(fixture).read(Buffer.from('hello'), { guard: 0 });
  const patched = loadRegistration(patchEmbindString(fixture)).read(Buffer.from('hello'), { guard: 0 });
  assert.equal(original.value, 'hello');
  assert.equal(patched.value, 'hello');
  assert.deepEqual(original.writes, []);
  assert.deepEqual(patched.writes, []);
});

test('the patch refuses a file that is already patched or where the code is missing or ambiguous', () => {
  assert.throws(() => patchEmbindString(patchEmbindString(fixture)), /found 0 times, expected exactly once \(the file may already be patched\)/);
  assert.throws(() => patchEmbindString(fixture.replace('var endCharSwap=0;', 'var endCharSwap = 0;')), /found 0 times.*SDK change/);
  assert.throws(() => patchEmbindString(fixture + ORIGINAL), /found 2 times/);
  assert.throws(() => patchEmbindString(''), /found 0 times/);
});

// Run the script as the Dockerfile does, on a copy of the fixture in a temporary folder
function runScript(args) {
  return childProcess.spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8' });
}

test('the script patches the file in place and fails on a second run, a missing file or no argument', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'embind-patch-'));
  try {
    const file = path.join(folder, 'moonlight-wasm.js');
    fs.writeFileSync(file, fixture);
    const first = runScript([file]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Patched the reading of std::string/);
    assert.equal(fs.readFileSync(file, 'utf8'), patchEmbindString(fixture));

    const second = runScript([file]);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /Error: unable to patch .*already be patched/);
    assert.equal(fs.readFileSync(file, 'utf8'), patchEmbindString(fixture), 'a failed run must leave the file as it is');

    const missing = runScript([path.join(folder, 'missing.js')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ENOENT/);

    const usage = runScript([]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the script keeps to the syntax of the Node 12 of the Emscripten SDK', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  // Optional chaining, nullish coalescing, logical assignment and numeric separators came after Node 12.9
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ''), /\?\.|\?\?|\|\|=|&&=|\d_\d/);
  // The credit of the port
  assert.match(source, /fidoboy\/moonlight-tizen-ac3/);
  assert.match(source, /mmadej20/);
});

test('the Dockerfile patches the installed moonlight-wasm.js before packaging and fails when the patch fails', () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
  const lines = dockerfile.split(/\r?\n/);
  const find = (pattern) => lines.findIndex((line) => pattern.test(line));
  const install = find(/^RUN cmake --install build --prefix build$/);
  const copy = find(/^COPY --chown=moonlight tools\/patch-embind-string\.js \.\/moonlight-tizen\/tools\/$/);
  const run = find(/^RUN \/home\/moonlight\/emscripten-release-bundle\/emsdk\/node\/12\.9\.1_64bit\/bin\/node moonlight-tizen\/tools\/patch-embind-string\.js build\/widget\/moonlight-wasm\.js$/);
  const packaging = find(/spawn tizen package/);
  assert.ok(install >= 0 && copy >= 0 && run >= 0 && packaging >= 0, 'a step is missing');
  assert.ok(install < run && copy < run && run < packaging, 'the patch must run after the install and before packaging');
  // The RUN line is the whole command: nothing may ignore its exit code
  assert.doesNotMatch(lines[run], /\|\||;|\\$/);
  // The script is in the build context
  const dockerignore = fs.readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8');
  assert.doesNotMatch(dockerignore, /^tools\/?$/m);
});
