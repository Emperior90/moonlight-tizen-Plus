'use strict';

// Pins the two local patches of the vendored Opus 1.5.2 (opus/, otherwise as upstream v1.5.2). opus/celt/arch.h sets
// OPUS_FAST_INT64 also for WebAssembly (__EMSCRIPTEN__), so that the integer arithmetic of the decoder multiplies in 64
// bits as libopus does on 64-bit systems, instead of with the 16-bit partial products of its 32-bit fallback: that of
// CELT and SILK in the fixed-point build of the app up to 2.3.5, that of SILK in the floating-point build since 2.3.6. A
// later update of the vendored Opus would drop it unnoticed, so this file checks the condition, its explanation and the
// places that record the patch: the licence notices of the package and the upstream baseline. tests/native/run.sh
// evaluates the condition with the preprocessor for WebAssembly, a 32-bit target and an LP64 target. Since 2.3.6
// opus/celt/float_cast.h also rounds with one float addition in WebAssembly instead of lrintf(), which Emscripten 1.39
// fastcomp builds as the rintf() of its library; tests/native/opus_decoder/float2int.c compares it with lrintf().

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

test('opus/celt/arch.h sets OPUS_FAST_INT64 for WebAssembly and keeps the conditions of upstream', () => {
  const header = read('opus/celt/arch.h');
  const block = /\/\* Set this if opus_int64 is a native type of the CPU\. \*\/[\s\S]*?#endif/.exec(header);
  assert.ok(block, 'the block of OPUS_FAST_INT64');
  assert.match(block[0], /\n#if defined\(__x86_64__\) \|\| defined\(__LP64__\) \|\| defined\(_WIN64\) \|\| defined\(__EMSCRIPTEN__\)\n#define OPUS_FAST_INT64 1\n#else\n#define OPUS_FAST_INT64 0\n#endif$/);
  // The comment says why, and that the patch is local
  assert.match(block[0], /Moonlight Plus: also WebAssembly \(__EMSCRIPTEN__\)/);
  assert.match(block[0], /tests\/unit\/vendored-opus-patch\.test\.js pins this\s+line/);
  // The condition is the only place that decides it
  assert.equal((header.match(/#define OPUS_FAST_INT64 /g) || []).length, 2);
  assert.equal((header.match(/__EMSCRIPTEN__/g) || []).length, 2, 'the comment and the condition');
});

test('the patch still matters for the SILK decoder of the floating-point build that CMakeLists.txt makes', () => {
  const definitions = /target_compile_definitions\(opus PUBLIC([^)]*)\)/.exec(read('CMakeLists.txt'));
  assert.ok(definitions);
  // The floating-point build since 2.3.6 (tests/unit/native-build.test.js)
  assert.doesNotMatch(definitions[1], /\bFIXED_POINT\b/);
  // The 64-bit macros that the condition switches are those of the fixed-point code of CELT, which only the fixed-point
  // build includes, and of SILK, whose decoder computes in integers in both builds: SigProc_FIX.h includes macros.h
  // whatever FIXED_POINT says, and arch.h includes fixed_generic.h only for FIXED_POINT
  assert.match(read('opus/celt/fixed_generic.h'), /#if OPUS_FAST_INT64\n#define MULT32_32_Q31\(a,b\) \(\(opus_val32\)SHR\(\(opus_int64\)\(a\)\*\(opus_int64\)\(b\),31\)\)/);
  assert.match(read('opus/silk/macros.h'), /#if OPUS_FAST_INT64\n#define silk_SMULWB\(a32, b32\)/);
  assert.match(read('opus/silk/SigProc_FIX.h'), /\n#include "macros\.h"\n/);
  assert.match(read('opus/celt/arch.h'), /\n#ifdef FIXED_POINT\n[\s\S]*?#include "fixed_generic\.h"[\s\S]*?\n#else \/\* FIXED_POINT \*\//);
});

test('the licence notices, the upstream baseline and the native tests record the patch', () => {
  const notices = read('wasm/static/licenses/THIRD-PARTY-NOTICES.txt').replace(/\s+/g, ' ');
  assert.ok(notices.indexOf('[6] Opus 1.5.2, the audio codec (only the decoder is built, with one condition in celt/arch.h and the rounding of celt/float_cast.h in WebAssembly changed for Moonlight Plus; compiled into moonlight-wasm.wasm)') >= 0);
  const opus = JSON.parse(read('.github/dependency-baselines.json')).dependencies.find((dep) => dep.id === 'opus');
  assert.equal(opus.vendored, 'v1.5.2 (ddbe483) with two local patches: OPUS_FAST_INT64 also for WebAssembly (opus/celt/arch.h), float2int() with one float addition in WebAssembly (opus/celt/float_cast.h)');
  assert.match(opus.note, /the local patch of opus\/celt\/arch\.h/);
  assert.match(opus.note, /opus\/celt\/float_cast\.h/);
  const run = read('tests/native/run.sh');
  assert.match(run, /opus_fast_int64 -D__EMSCRIPTEN__\)" != "1" \] \|\| \[ "\$\(opus_fast_int64\)" != "0" \]/);
});

test('opus/celt/float_cast.h rounds with one float addition in WebAssembly, before the lrintf() branch', () => {
  const header = read('opus/celt/float_cast.h');
  const branch = '#elif defined(__EMSCRIPTEN__) && !defined(FIXED_POINT)\n';
  const at = header.indexOf(branch);
  assert.ok(at > 0, 'the branch of the patch');
  // Before the branch of lrintf(), which the WebAssembly build took up to 2.3.6, and after the __SSE__ branch, which
  // native x86 builds keep
  assert.ok(at < header.indexOf('#elif defined(HAVE_LRINTF) && defined(__STDC_VERSION__)'));
  assert.ok(at > header.indexOf('#if defined(__GNUC__) && defined(__SSE__)'));
  const body = header.slice(at, header.indexOf('#elif defined(HAVE_LRINTF)'));
  assert.match(body, /u\.f = x \+ 12582912\.0f;\n\s*return u\.i - 0x4B400000;/);
  assert.match(body, /Moonlight Plus:/);
  assert.match(body, /tests\/unit\/vendored-opus-patch\.test\.js pins this branch/);
  assert.equal((header.match(/__EMSCRIPTEN__/g) || []).length, 1);
  // FLOAT2INT16() still clamps before it rounds, which keeps every value in the exact range of the addition
  assert.match(header, /x = MAX32\(x, -32768\);\n\s*x = MIN32\(x, 32767\);\n\s*return \(opus_int16\)float2int\(x\);/);
  // The native suite checks the branch against lrintf() of the C library
  assert.match(read('tests/native/run.sh'), /-D__EMSCRIPTEN__ -U__SSE__ "\$\{opus_defines\[@\]\}"[\s\S]*?opus_decoder\/float2int\.c/);
});
