'use strict';

// Pins the local patch of the vendored Opus 1.5.2 (opus/, otherwise as upstream v1.5.2): opus/celt/arch.h sets
// OPUS_FAST_INT64 also for WebAssembly (__EMSCRIPTEN__), so that the fixed-point decoder of the app multiplies in 64 bits
// as libopus does on 64-bit systems, instead of with the 16-bit partial products of its 32-bit fallback. A later update
// of the vendored Opus would drop it unnoticed, so this file checks the condition, its explanation and the places that
// record the patch: the licence notices of the package and the upstream baseline. tests/native/run.sh evaluates the
// condition with the preprocessor for WebAssembly, a 32-bit target and an LP64 target.

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

test('the patch only matters for the fixed-point build that CMakeLists.txt makes', () => {
  const definitions = /target_compile_definitions\(opus PUBLIC([^)]*)\)/.exec(read('CMakeLists.txt'));
  assert.ok(definitions);
  assert.match(definitions[1], /\bFIXED_POINT\b/);
  // The 64-bit macros that the condition switches are those of the fixed-point code of CELT and of SILK
  assert.match(read('opus/celt/fixed_generic.h'), /#if OPUS_FAST_INT64\n#define MULT32_32_Q31\(a,b\) \(\(opus_val32\)SHR\(\(opus_int64\)\(a\)\*\(opus_int64\)\(b\),31\)\)/);
  assert.match(read('opus/silk/macros.h'), /#if OPUS_FAST_INT64\n#define silk_SMULWB\(a32, b32\)/);
});

test('the licence notices, the upstream baseline and the native tests record the patch', () => {
  const notices = read('wasm/static/licenses/THIRD-PARTY-NOTICES.txt').replace(/\s+/g, ' ');
  assert.ok(notices.indexOf('[6] Opus 1.5.2, the audio codec (only the decoder is built, with one condition in celt/arch.h changed for Moonlight Plus; compiled into moonlight-wasm.wasm)') >= 0);
  const opus = JSON.parse(read('.github/dependency-baselines.json')).dependencies.find((dep) => dep.id === 'opus');
  assert.equal(opus.vendored, 'v1.5.2 (ddbe483) with one local patch: OPUS_FAST_INT64 also for WebAssembly (opus/celt/arch.h)');
  assert.match(opus.note, /the local patch of opus\/celt\/arch\.h/);
  const run = read('tests/native/run.sh');
  assert.match(run, /opus_fast_int64 -D__EMSCRIPTEN__\)" != "1" \] \|\| \[ "\$\(opus_fast_int64\)" != "0" \]/);
});
