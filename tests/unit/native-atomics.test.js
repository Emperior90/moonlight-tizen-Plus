'use strict';

// Keeps the 8-byte atomic operations that the runtime of the TV gets wrong out of the native code of the app (wasm/,
// moonlight-common-c/src and libgamestream).
//
// The defect: the Samsung Emscripten SDK 1.39.4.7 that the Dockerfile installs (fastcomp) has no 8-byte atomic
// instructions. Its clang inlines atomics of up to 4 bytes only (MaxAtomicInlineWidth = 32 for the Emscripten target,
// lib/Basic/Targets/AsmJS.h of emscripten-fastcomp-clang 1.39.4) and turns every 8-byte operation of std::atomic and of
// the __atomic and __c11_atomic builtins into a call of a helper such as __atomic_load_8 (lib/CodeGen/CGAtomic.cpp),
// which system/lib/pthread/library_pthread_asmjs.c of Samsung's Emscripten (branch samsung_fork) emulates with spin
// locks. __atomic_load_8, __atomic_store_8, __atomic_exchange_8 and __atomic_fetch_add/sub/and/or/xor_8 there (lines
// 168-176 and 183-201) take what the compiler passes and return the old value, as they should. __atomic_compare_exchange_8
// (lines 178-181) doesn't: it takes one parameter more than the compiler passes, returns the old value instead of
// whether it swapped, and never writes the value it found back to expected. So compare_exchange_strong() and
// compare_exchange_weak() on an 8-byte atomic swap when the value matches, but return the lowest bit of the old value,
// and leave expected as it was when they don't swap. The release build warns about every such call ("asm2wasm adding
// operands in call from ... to $___atomic_compare_exchange_8"). The __sync builtins of 8 bytes are worse: clang emits
// them as atomic instructions, of which fastcomp lowers only add, sub, and, or and xor of 8 bytes
// (lib/Target/JSBackend/NaCl/ExpandI64.cpp); a compare-and-swap or an exchange of 8 bytes ends in an assertion that a
// release build of the compiler leaves out. g++ and clang on a PC get all of it right, so the native tests don't see it
// (tests/native/host_encoder_restart_test.cpp builds its rule with a copy of the compare-exchange of the TV).
//
// How to tell a right use from a wrong one: on a std::atomic of at most 4 bytes (bool, int, int32_t, uint32_t, float, a
// pointer; long and size_t are 4 bytes in WebAssembly too) every operation is right. On a std::atomic of 8 bytes
// (uint64_t, int64_t, long long, double, ...) load(), store(), exchange(), fetch_add(), fetch_sub(), fetch_and(),
// fetch_or(), fetch_xor() and the operators made of them (=, the conversion, ++, --, +=, -=, &=, |=, ^=) are right, and
// compare_exchange_strong() and compare_exchange_weak() (also as std::atomic_compare_exchange_*()) are wrong. Keep such
// a value in 4 bytes (wasm/host_encoder_restart.hpp keeps the lower 32 bits of the clock) or behind a mutex.
//
// The check accepts a compare-exchange only on an atomic whose declaration it finds, as std::atomic<T> with a type T of
// at most 4 bytes, in one of these files (a name declared with another type anywhere counts as 8 bytes). It goes by the
// name of the atomic, so it also reads the declarations that give a name another type: the standard aliases such as
// std::atomic_uint64_t (8 bytes) or std::atomic_int, the names of a 'using' or 'typedef' of an atomic, and a name
// declared with auto or decltype, whose type it can't tell and which therefore fails the check. A short name such as
// max or level, used for a 4-byte atomic in one place, thus can't let an 8-byte one through in another. It rejects the
// __atomic, __c11_atomic and __sync builtins and C11 atomics, whose size a scan can't tell: the native code uses
// std::atomic in C++ and the mutexes of the platform layer in C (PLT_MUTEX in moonlight-common-c).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

// The native code of the WebAssembly module, with the subdirectories
const NATIVE_DIRECTORIES = ['wasm', 'moonlight-common-c/src', 'libgamestream'];

// The types of at most 4 bytes in WebAssembly, after the whitespace is collapsed and std:: and const are removed; a
// pointer counts too. samsung::wasm::SessionId is an int32_t (session_id.h of the SDK).
const SMALL_TYPES = new Set([
  'bool', 'char', 'signed char', 'unsigned char', 'char16_t', 'char32_t', 'wchar_t', 'short', 'unsigned short', 'int',
  'unsigned', 'unsigned int', 'long', 'unsigned long', 'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t',
  'uint32_t', 'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t', 'float', 'samsung::wasm::SessionId',
]);

function isSmallType(type) {
  const normalized = type.replace(/\bstd::/g, '').replace(/\b(const|volatile)\b/g, '').replace(/\s+/g, ' ').trim();
  return SMALL_TYPES.has(normalized) || normalized.endsWith('*');
}

// The source with its comments and the contents of its string and character literals replaced by spaces, so that the
// lines keep their numbers
function codeOnly(source) {
  let code = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      code += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === '\'') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      code += c + source.slice(i + 1, j).replace(/[^\n]/g, ' ') + c;
      i = j + 1;
    } else {
      code += c;
      i++;
    }
  }
  return code;
}

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

// The names declared as std::atomic<T> (a variable, a member, a parameter, also a list of them) with their types
const ATOMIC_TYPE = /\b(?:std::)?atomic\s*<((?:[^<>;{}()]|<[^<>;{}()]*>)+)>/g;
// The standard aliases of std::atomic (std::atomic_int, std::atomic_uint64_t, ...), with the type each stands for: the
// short names of the standard, else the name after atomic_ (an unknown one is no small type, so it fails the check)
const ATOMIC_ALIAS = /\b(?:std::)?atomic_([a-z]\w*)/g;
const ATOMIC_ALIAS_TYPES = {
  schar: 'signed char', uchar: 'unsigned char', ushort: 'unsigned short', uint: 'unsigned int', ulong: 'unsigned long',
  llong: 'long long', ullong: 'unsigned long long',
};
// Declarations whose type the check can't tell: auto (also auto& and auto*) and decltype(...)
const UNKNOWN_TYPE = [[/\bauto\b/g, 'auto'], [/\bdecltype\s*\((?:[^()]|\([^()]*\))*\)/g, 'decltype']];
// A name declared after a type: a variable, a member, a parameter, a reference or a pointer
const DECLARED_NAME = /^\s*(?:&&?|\*)?\s*([A-Za-z_]\w*)(?=\s*[,;{=():[])/;

// The names that a 'using' or 'typedef' gives an atomic type, with the type of its value
function atomicTypeAliases(code) {
  const aliases = new Map();
  const typeOf = (text) => {
    const atomic = /^(?:std::)?atomic\s*<((?:[^<>;{}()]|<[^<>;{}()]*>)+)>$/.exec(text.trim());
    if (atomic) {
      return atomic[1].trim();
    }
    const alias = /^(?:std::)?atomic_([a-z]\w*)$/.exec(text.trim());
    return alias ? ATOMIC_ALIAS_TYPES[alias[1]] || alias[1] : undefined;
  };
  for (const match of code.matchAll(/\busing\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) {
    const type = typeOf(match[2]);
    if (type) {
      aliases.set(match[1], type);
    }
  }
  for (const match of code.matchAll(/\btypedef\s+([^;]+?)\s+([A-Za-z_]\w*)\s*;/g)) {
    const type = typeOf(match[1]);
    if (type) {
      aliases.set(match[2], type);
    }
  }
  return aliases;
}

// The names declared after the type that ends at `end` of the code: the first one, and another of the same
// declaration after an initializer
function namesAfter(code, end) {
  const names = [];
  let rest = code.slice(end);
  let name = DECLARED_NAME.exec(rest);
  while (name) {
    names.push(name[1]);
    rest = rest.slice(name[0].length);
    name = /^\s*(?:\{[^{};]*\}|=[^,;]*)?\s*,\s*([A-Za-z_]\w*)(?=\s*[,;{=])/.exec(rest);
  }
  return names;
}

// The declarations of atomics in the code, as { name, type }: std::atomic<T>, the standard aliases, the names of
// typeAliases (those of every file), and the names declared with a type the check can't tell
function atomicDeclarations(code, typeAliases) {
  const declarations = [];
  const add = (names, type) => names.forEach((name) => declarations.push({ name, type }));
  for (const match of code.matchAll(ATOMIC_TYPE)) {
    add(namesAfter(code, match.index + match[0].length), match[1].trim());
  }
  for (const match of code.matchAll(ATOMIC_ALIAS)) {
    add(namesAfter(code, match.index + match[0].length), ATOMIC_ALIAS_TYPES[match[1]] || match[1]);
  }
  (typeAliases || new Map()).forEach((type, alias) => {
    for (const match of code.matchAll(new RegExp('\\b' + alias + '\\b', 'g'))) {
      add(namesAfter(code, match.index + match[0].length), type);
    }
  });
  UNKNOWN_TYPE.forEach(([pattern, type]) => {
    for (const match of code.matchAll(pattern)) {
      add(namesAfter(code, match.index + match[0].length), type);
    }
  });
  return declarations;
}

const MEMBER_COMPARE_EXCHANGE = /\bcompare_exchange_(?:strong|weak)\s*\(/g;
const FREE_COMPARE_EXCHANGE = /\batomic_compare_exchange_(?:strong|weak)(?:_explicit)?\s*\(\s*&?\s*([\w.>-]*)/g;
const BUILTINS = [
  [/\b(?:__atomic_|__c11_atomic_|__sync_)\w+/g, 'a builtin whose size the check can\'t tell (use std::atomic or a mutex)'],
  [/\b_Atomic\b|<stdatomic\.h>/g, 'a C11 atomic whose size the check can\'t tell (use PLT_MUTEX in C)'],
];

// Scans the files ({ name: source }) and returns the problems ('file:line: ...') and the compare-exchanges it accepts
function scan(files) {
  const codes = Object.keys(files).sort().map((file) => ({ file, code: codeOnly(files[file]) }));
  const typeAliases = new Map();
  codes.forEach(({ code }) => atomicTypeAliases(code).forEach((type, alias) => typeAliases.set(alias, type)));
  const typesOf = new Map();
  codes.forEach(({ code }) => atomicDeclarations(code, typeAliases).forEach(({ name, type }) => {
    typesOf.set(name, (typesOf.get(name) || new Set()).add(type));
  }));
  const problems = [];
  const accepted = [];
  const checkObject = (file, code, index, object, what) => {
    const where = file + ':' + lineOf(code, index);
    const types = object ? typesOf.get(object) : undefined;
    if (!types) {
      problems.push(where + ': ' + what + ' on ' + (object || 'an expression') + ', whose declaration as ' +
        'std::atomic<T> the check doesn\'t find, so it may be an 8-byte one that the runtime of the TV gets wrong');
    } else if (![...types].every(isSmallType)) {
      problems.push(where + ': ' + what + ' on ' + object + ' (std::atomic<' + [...types].join('> or <') +
        '>), an 8-byte compare-exchange that the runtime of the TV gets wrong');
    } else {
      accepted.push({ file, line: lineOf(code, index), name: object, type: [...types].join(', ') });
    }
  };
  codes.forEach(({ file, code }) => {
    for (const match of code.matchAll(MEMBER_COMPARE_EXCHANGE)) {
      const object = /([A-Za-z_]\w*)\s*(?:\.|->)\s*$/.exec(code.slice(Math.max(0, match.index - 200), match.index));
      checkObject(file, code, match.index, object && object[1], match[0].replace(/\s*\($/, '()'));
    }
    for (const match of code.matchAll(FREE_COMPARE_EXCHANGE)) {
      const object = /([A-Za-z_]\w*)$/.exec(match[1]);
      checkObject(file, code, match.index, object && object[1], match[0].replace(/\s*\(.*$/s, '()'));
    }
    BUILTINS.forEach(([pattern, what]) => {
      for (const match of code.matchAll(pattern)) {
        problems.push(file + ':' + lineOf(code, match.index) + ': ' + match[0] + ', ' + what);
      }
    });
  });
  return { problems, accepted, typesOf };
}

function nativeFiles() {
  const files = {};
  const walk = (directory) => {
    fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).forEach((entry) => {
      const file = directory + '/' + entry.name;
      if (entry.isDirectory()) {
        walk(file);
      } else if (/\.(c|cpp|h|hpp)$/.test(entry.name)) {
        files[file] = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      }
    });
  };
  NATIVE_DIRECTORIES.forEach(walk);
  return files;
}

test('the native code has no 8-byte atomic operation that the runtime of the TV gets wrong', () => {
  const files = nativeFiles();
  assert.ok(Object.keys(files).length > 50, 'the native files are found');
  assert.deepEqual(scan(files).problems, []);
});

test('the compare-exchanges of the native code are all found, on atomics of 4 bytes', () => {
  const { accepted, typesOf } = scan(nativeFiles());
  assert.deepEqual(accepted.map(({ file, name, type }) => file + ' ' + name + ' ' + type), [
    'wasm/audio_stream_stats.hpp max uint32_t',
    'wasm/compact_stats.hpp level int',
    'wasm/host_encoder_restart.hpp m_RestartMs uint32_t',
    'wasm/host_encoder_restart.hpp m_RestartMs uint32_t',
  ], 'a new or moved compare-exchange: check by hand that its atomic has at most 4 bytes (see the comment at the top) ' +
    'before adding it to this list; the check goes by the name of the atomic and can be misled by a name used twice');
  // The 8-byte atomics of the statistics are found too, and their load(), store() and fetch_add() are right
  ['s_VideoTrackOpenMs', 'startMs', 'receivedBytes', 'decodeUs', 'decodedSamples', 'outputUs'].forEach((name) => {
    assert.deepEqual([...typesOf.get(name)], ['uint64_t'], name);
  });
  assert.deepEqual([...typesOf.get('m_MouseDeltaY')], ['int32_t'], 'the second name of a declaration');
});

test('the check rejects the 8-byte compare-exchanges and the builtins, and accepts the right uses', () => {
  const wrong = (source) => scan({ 'wrong.cpp': source }).problems;
  const right = (source) => scan({ 'right.cpp': source }).problems;
  // The defect of wasm/host_encoder_restart.hpp of 2.3.1
  assert.equal(wrong('std::atomic<uint64_t> m_RestartMs{0};\n' +
    'bool Claim(uint64_t ms) { return m_RestartMs.compare_exchange_strong(ms, 0); }').length, 1);
  assert.match(wrong('static std::atomic<std::uint64_t> a;\nvoid f(uint64_t e) {\n  a.compare_exchange_weak(e, 1);\n}')[0],
    /^wrong\.cpp:3: compare_exchange_weak\(\) on a \(std::atomic<std::uint64_t>\), an 8-byte compare-exchange/);
  assert.equal(wrong('std::atomic<double> d;\nvoid f(double e) { d.compare_exchange_strong(e, 1.0); }').length, 1);
  assert.equal(wrong('std::atomic<int64_t> a{0}, b{1};\nvoid f(int64_t e) { b.compare_exchange_strong(e, 2); }').length,
    1);
  assert.equal(wrong('void f(std::atomic<unsigned long long>& x, unsigned long long e) {\n' +
    '  while (!x.compare_exchange_weak(e, e + 1)) {}\n}').length, 1);
  assert.equal(wrong('struct S { std::atomic<uint64_t> m_Time; };\n' +
    'void f(S* s, uint64_t e) { s->m_Time.compare_exchange_strong(e, 0); }').length, 1);
  assert.equal(wrong('std::atomic<uint64_t> v;\nvoid f(uint64_t e) { std::atomic_compare_exchange_strong(&v, &e, 1); }')
    .length, 1);
  // A name declared with an 8-byte type in one place and a 4-byte one in another counts as 8 bytes
  assert.equal(scan({ 'a.hpp': 'std::atomic<uint32_t> count;', 'b.hpp': 'std::atomic<uint64_t> count;',
    'c.cpp': 'void f(uint32_t e) { count.compare_exchange_strong(e, 0); }' }).problems.length, 1);
  // An atomic that the check can't find the declaration of
  assert.match(wrong('void f(uint64_t e) { Get().compare_exchange_strong(e, 0); }')[0], /on an expression, whose/);
  assert.match(wrong('void f(uint64_t e) { s_Unknown.compare_exchange_strong(e, 0); }')[0], /on s_Unknown, whose/);
  // The standard aliases of std::atomic, by their size
  assert.match(wrong('std::atomic_uint64_t v;\nvoid f(uint64_t e) { v.compare_exchange_strong(e, 0); }')[0],
    /on v \(std::atomic<uint64_t>\), an 8-byte compare-exchange/);
  ['atomic_ullong', 'std::atomic_llong', 'atomic_int64_t', 'std::atomic_uintmax_t', 'atomic_int_least64_t', 'atomic_uint_fast64_t']
    .forEach((alias) => assert.equal(wrong(alias + ' v{0};\nvoid f(uint64_t e) { v.compare_exchange_weak(e, 0); }').length, 1, alias));
  assert.deepEqual(right('std::atomic_int a, b{0};\nstd::atomic_uint c;\nstd::atomic_bool d;\n' +
    'void f(int e, unsigned e2, bool e3) { b.compare_exchange_strong(e, 1); c.compare_exchange_weak(e2, 1u); d.compare_exchange_strong(e3, true); }'), []);
  // A short name that a 4-byte atomic uses elsewhere doesn't let an 8-byte one through: a parameter of an alias type,
  // the name of a 'using' or 'typedef' of an atomic, a reference with auto or decltype
  const elsewhere = 'static void RaiseMax(std::atomic<uint32_t>& max, uint32_t v) { uint32_t seen = max.load(); ' +
    'while (seen < v && !max.compare_exchange_weak(seen, v)) {} }\nstd::atomic<int> level;\n';
  [
    'static void RaiseMax64(std::atomic_uint64_t& max, uint64_t v) { uint64_t seen = max.load(); ' +
      'while (seen < v && !max.compare_exchange_weak(seen, v)) {} }',
    'using AtomicMs = std::atomic<uint64_t>;\nAtomicMs level;\nvoid f(uint64_t e) { level.compare_exchange_strong(e, 0); }',
    'typedef std::atomic<int64_t> AtomicMs;\nstruct S { AtomicMs level{0}; };\nvoid f(S& s, int64_t e) { s.level.compare_exchange_strong(e, 0); }',
    'using Wide = std::atomic_ullong;\nvoid f(Wide* level, unsigned long long e) { level->compare_exchange_weak(e, 0); }',
    'std::atomic<uint64_t> s_OpenMs;\nvoid f(uint64_t e) { auto& max = s_OpenMs; max.compare_exchange_strong(e, 0); }',
    'std::atomic<uint64_t> s_OpenMs;\nvoid f(uint64_t e) { decltype(s_OpenMs)& level = s_OpenMs; level.compare_exchange_strong(e, 0); }',
  ].forEach((source) => {
    const problems = scan({ 'a.hpp': elsewhere, 'b.cpp': source }).problems;
    assert.equal(problems.filter((problem) => problem.indexOf('b.cpp:') === 0).length, 1, source + '\n' + problems.join('\n'));
    assert.ok(problems.every((problem) => problem.indexOf('an 8-byte compare-exchange') > 0), problems.join('\n'));
  });
  // The builtins and C11 atomics, whose size the check can't tell
  assert.equal(wrong('bool f(uint64_t* v) { return __sync_bool_compare_and_swap(v, 1, 2); }').length, 1);
  assert.equal(wrong('uint64_t f(uint64_t* v) { return __sync_lock_test_and_set(v, 2); }').length, 1);
  assert.equal(wrong('bool f(uint64_t* v, uint64_t* e) { return __atomic_compare_exchange_n(v, e, 2, 0, 5, 5); }')
    .length, 1);
  assert.equal(wrong('#include <stdatomic.h>\n_Atomic long long counter;').length, 2);

  // 4-byte compare-exchanges, and the right operations of 8 bytes
  assert.deepEqual(right('std::atomic<uint32_t> a{0};\nvoid f(uint32_t e) { a.compare_exchange_strong(e, 1); }'), []);
  assert.deepEqual(right('void Raise(std::atomic<int>& level, int e) {\n' +
    '  while (!level.compare_exchange_weak(e, e + 1, std::memory_order_relaxed)) {}\n}'), []);
  assert.deepEqual(right('std::atomic<Frame*> p;\nvoid f(Frame* e) { p.compare_exchange_weak(e, nullptr); }'), []);
  assert.deepEqual(right('std::atomic<samsung::wasm::SessionId> m_Id;\n' +
    'void f(samsung::wasm::SessionId e) { m_Id.compare_exchange_strong(e, 1); }'), []);
  assert.deepEqual(right('std::atomic<uint64_t> big{0};\nuint64_t f() {\n  big.store(1);\n  big = 2;\n  big++;\n' +
    '  big += 3;\n  big.fetch_add(4, std::memory_order_relaxed);\n  big.fetch_or(8);\n  return big.exchange(0) + big.load();\n}'),
  []);
  // Comments and texts
  assert.deepEqual(right('std::atomic<uint64_t> big;\n// big.compare_exchange_strong(e, 0) would be wrong\n' +
    '/* __sync_val_compare_and_swap */\nconst char* text = "big.compare_exchange_weak(e, 0) __atomic_load_8";'), []);
});
