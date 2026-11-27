'use strict';

// The native build (CMakeLists.txt, Dockerfile, .dockerignore) and the sources of the WebAssembly module carry no dead
// code of moonlight-chrome and NaCl any more: no h264bitstream (only an unused #include was left of it), no profiling
// code that nothing called, no NaCl entry point Init(), no display message callbacks that moonlight-common-c dropped
// (and with them the 'TransientMsg: ' branch of messages.js), no Opus encoder (the app only decodes; tests/native/run.sh
// builds the decoder from the list of CMakeLists.txt and decodes with it), no CPPLINT.cfg, and no member of
// MoonlightInstance that is written but never read. Every file the build names exists, the Docker build context
// leaves out the models of opus/dnn, which nothing compiles, and the unused headers of ports/ are gone. The module is
// compiled and linked with -O3 (since 2.3.5). Since 2.3.6 Opus is the floating-point build of libopus, as a test of its
// CPU time on the TV (Audio CPU: decode of the full statistics), with the same files as the fixed-point build before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(REPO_ROOT, file));
const cmake = () => read('CMakeLists.txt').replace(/#[^\n]*/g, '');

// The source files of a target of CMakeLists.txt
function targetSources(name) {
  const match = new RegExp('add_(?:library|executable)\\(' + name + '(?: STATIC)?\\s+([^)]*)\\)').exec(cmake());
  assert.ok(match, 'target ' + name);
  return match[1].split(/\s+/).filter((item) => /\.(c|cpp)$/.test(item));
}

test('every source file that CMakeLists.txt builds exists, and h264bitstream and profiling.cpp are gone', () => {
  const targets = [];
  cmake().replace(/add_(?:library|executable)\((\S+)/g, (all, name) => targets.push(name));
  assert.deepEqual(targets, ['moonlight-rs', 'moonlight-enet', 'moonlight-common-c', 'libgamestream', 'opus', 'moonlight-wasm']);
  targets.forEach((name) => targetSources(name).forEach((file) => assert.ok(exists(file), file)));
  assert.equal(/h264bitstream|profiling/.test(cmake()), false);
  assert.equal(exists('h264bitstream'), false);
  assert.equal(exists('wasm/profiling.cpp'), false);
  assert.equal(exists('wasm/CPPLINT.cfg'), false);
  // Each definition of enet once
  assert.equal(cmake().match(/HAS_SOCKLEN_T=1/g).length, 1);
});

test('CMakeLists.txt builds the decoder of Opus without its encoder', () => {
  const opus = targetSources('opus');
  ['opus/celt/celt_decoder.c', 'opus/silk/dec_API.c', 'opus/silk/PLC.c', 'opus/src/opus_decoder.c', 'opus/src/opus_multistream_decoder.c']
    .forEach((file) => assert.ok(opus.indexOf(file) >= 0, file));
  const encoderFiles = opus.filter((file) => /encoder|enc_API|encode_|_FIX\.c$|\/fixed\/|analysis\.c|mlp|NSQ|VAD\.c|control_codec|init_encoder/.test(file));
  assert.deepEqual(encoderFiles, []);
  assert.equal(opus.length, 65);
  // The decoder check of the native tests reads the same list
  assert.match(read('tests/native/run.sh'), /sed -n '\/\^add_library\(opus STATIC\/,\/\^\)\/p' "\$repo\/CMakeLists.txt"/);
  assert.ok(exists('tests/native/opus_decoder/decode.c'));
  // The audio decoder of the app is linked with that library too, under the leak check, and destroys what it creates
  assert.match(read('tests/native/run.sh'), /for source in "\$here"\/opus_decoder\/\*_test\.cpp; do/);
  assert.match(read('tests/native/run.sh'), /"\$source" "\$opus_out\/libopus\.a" -lm -lpthread/);
  assert.match(read('tests/native/opus_decoder/app_decoder_test.cpp'), /#include "\.\.\/\.\.\/\.\.\/wasm\/auddec\.cpp"/);
  const auddec = read('wasm/auddec.cpp');
  assert.equal((auddec.match(/opus_multistream_decoder_create\(/g) || []).length, 1);
  assert.equal((auddec.match(/opus_multistream_decoder_destroy\(/g) || []).length, 1);
});

test('CMakeLists.txt builds Opus in floating point, without fast math, and the native tests build it the same way', () => {
  // The definitions and include directories of the target: no FIXED_POINT, the float directory of SILK instead of the
  // fixed one (also for the module), FLOAT_APPROX of libopus (celt_exp2() as a polynomial), and no fast math
  const definitions = /target_compile_definitions\(opus PUBLIC([^)]*)\)/.exec(cmake());
  assert.ok(definitions);
  assert.deepEqual(definitions[1].trim().split(/\s+/), ['USE_ALLOCA', 'HAVE_LRINT', 'HAVE_LRINTF', 'OPUS_BUILD', 'FLOAT_APPROX']);
  const includes = (target) => new RegExp('target_include_directories\\(' + target + ' PUBLIC([^)]*)\\)').exec(cmake())[1].trim().split(/\s+/);
  assert.deepEqual(includes('opus'), ['opus/include', 'opus/src', 'opus/silk', 'opus/celt', 'opus/silk/float']);
  assert.ok(includes('moonlight-wasm').indexOf('opus/silk/float') >= 0);
  assert.doesNotMatch(cmake(), /FIXED_POINT|silk\/fixed|fast-math|ffast|OPUS_FAST_MATH/);
  // The decode API of the app is unchanged: 16-bit samples
  const auddec = read('wasm/auddec.cpp');
  assert.ok(auddec.indexOf('opus_multistream_decode(decoder,') > 0);
  assert.doesNotMatch(auddec, /opus_multistream_decode_float/);
  // tests/native/run.sh reads the definitions and the include directories of the target, so that it builds what the
  // release builds
  const run = read('tests/native/run.sh');
  assert.match(run, /sed -n '\/\^target_compile_definitions\(opus PUBLIC\/,\/\)\/p' "\$repo\/CMakeLists\.txt"/);
  assert.match(run, /sed -n '\/\^target_include_directories\(opus PUBLIC\/,\/\)\/p' "\$repo\/CMakeLists\.txt"/);
  assert.match(run, /"\$\{opus_defines\[@\]\}" "\$\{opus_includes\[@\]\}"/);
  assert.doesNotMatch(run, /silk\/fixed/);
});

test('the Dockerfile copies only what exists, and the build context leaves out opus/dnn', () => {
  const dockerfile = read('Dockerfile');
  const copies = [];
  dockerfile.replace(/^COPY --chown=moonlight (\S+) /gm, (all, source) => copies.push(source));
  assert.ok(copies.length >= 10, copies.join(' '));
  copies.filter((source) => source.indexOf('[') < 0 && source.indexOf('*') < 0).forEach((source) => assert.ok(exists(source), source));
  assert.equal(dockerfile.indexOf('h264bitstream'), -1);
  // The headers of OpenSSL 1.0.2d, curl 7.44.0 and zlib 1.2.8 in ports/include, which no build read (the Samsung
  // Emscripten ports bring their own), are gone since 2.2.0
  assert.equal(exists('ports'), false);
  assert.ok(copies.indexOf('ports') < 0, copies.join(' '));
  const ignored = read('.dockerignore').split('\n').map((line) => line.trim());
  assert.ok(ignored.indexOf('opus/dnn') >= 0);
  // Nothing that the build compiles lies there
  assert.deepEqual(targetSources('opus').filter((file) => file.indexOf('opus/dnn/') === 0), []);
});

test('the module has no NaCl entry point, no profiling functions, no h264bitstream include and no transient messages', () => {
  const header = read('wasm/moonlight_wasm.hpp');
  assert.equal(/\bInit\(uint32_t argc/.test(header + read('wasm/main.cpp')), false);
  assert.equal(/Profiler|ENABLE_PROFILING|PROFILING_MESSAGE_THRESHOLD/.test(header), false);
  assert.equal(read('wasm/wasmplayer.cpp').indexOf('h264_stream.h'), -1);
  assert.equal(/ClDisplay(Transient)?Message/.test(header + read('wasm/connectionlistener.cpp')), false);
  assert.equal(read('wasm/platform/messages.js').indexOf('TransientMsg'), -1);
  // The dialog message of a failed connection stage stays
  assert.match(read('wasm/connectionlistener.cpp'), /PostToJs\(std::string\("DialogMsg: "\)/);
  assert.match(read('wasm/platform/messages.js'), /msg\.indexOf\('DialogMsg: '\) === 0/);
});

test('every member of MoonlightInstance that the module writes is also read', () => {
  const header = read('wasm/moonlight_wasm.hpp');
  const sources = fs.readdirSync(path.join(REPO_ROOT, 'wasm')).filter((file) => /\.(cpp|hpp)$/.test(file))
    .map((file) => read(path.join('wasm', file))).join('\n');
  const members = [];
  header.replace(/^\s+(?:static\s+)?[A-Za-z_][\w:<>,\s*]*?[\s*]((m_)[A-Za-z0-9_]+)\s*(?:=[^;]*|\{[^}]*\})?;/gm, (all, name) => members.push(name));
  assert.ok(members.length > 30, members.join(' '));
  const writeOnly = members.filter((name) => {
    // Leave out the declaration, then count the uses that are not a plain assignment
    const uses = sources.split('\n').filter((line) => new RegExp('\\b' + name + '\\b').test(line) &&
      !new RegExp('^\\s+(?:static\\s+)?[A-Za-z_][\\w:<>,\\s*]*?[\\s*]' + name + '\\s*(?:=[^;]*|\\{[^}]*\\})?;').test(line));
    return uses.every((line) => new RegExp('^\\s*(?:g_Instance->|this->|me->)?' + name + '\\s*=[^=]').test(line));
  });
  assert.deepEqual(writeOnly, []);
  ['m_HttpPort', 'm_OptimizeGamesEnabled', 'm_RumbleFeedbackEnabled', 'm_MouseEmulationEnabled', 'm_PlayHostAudioEnabled',
    'm_DecryptHostAudioEnabled', 'm_HdrModeEnabled', 'm_FullRangeEnabled', 'm_GameModeEnabled'].forEach((name) => {
    assert.equal(new RegExp('\\b' + name + '\\b').test(sources), false, name);
  });
});

test('the module is compiled and linked with -O3 (2.3.5), and the native tests keep their own level', () => {
  // With the Emscripten 1.39 fastcomp of the build, -O3 runs Binaryen and the code generator at level 3 (the LLVM
  // passes already ran at that level with -O2) and makes the glue code smaller (meta-DCE, shorter names between
  // JavaScript and WebAssembly)
  const compile = /^add_compile_options\(([^)]*)\)/m.exec(cmake());
  assert.ok(compile, 'add_compile_options');
  assert.match(compile[1], /(?:^|\s)-O3(?:\s|$)/);
  assert.doesNotMatch(compile[1], /(?:^|\s)-O[012s](?:\s|$)/);
  const link = /set_target_properties\(moonlight-wasm\s+PROPERTIES\s+LINK_FLAGS\s+"([^"]*)"/.exec(cmake());
  assert.ok(link, 'LINK_FLAGS of moonlight-wasm');
  assert.match(link[1], /(?:^|\s)-O3(?:\s|\\|$)/);
  assert.doesNotMatch(link[1], /(?:^|\s)-O[012s](?:\s|\\|$)/);
  // -flto stays with both
  assert.match(compile[1], /(?:^|\s)-flto(?:\s|$)/);
  assert.match(link[1], /(?:^|\s)-flto(?:\s|\\|$)/);
  // The native tests build with -O1 and the sanitizers, whatever the module uses
  assert.match(read('tests/native/run.sh'), /-std=gnu99 -g -O1 -fno-omit-frame-pointer/);
});
