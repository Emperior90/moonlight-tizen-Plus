'use strict';

// The native build (CMakeLists.txt, Dockerfile, .dockerignore) and the sources of the WebAssembly module carry no dead
// code of moonlight-chrome and NaCl any more: no h264bitstream (only an unused #include was left of it), no profiling
// code that nothing called, no NaCl entry point Init(), no display message callbacks that moonlight-common-c dropped
// (and with them the 'TransientMsg: ' branch of messages.js), no Opus encoder (the app only decodes; tests/native/run.sh
// builds the decoder from the list of CMakeLists.txt and decodes with it), no CPPLINT.cfg, and no member of
// MoonlightInstance that is written but never read. Every file the build names exists, and the Docker build context
// leaves out the models of opus/dnn, which nothing compiles.

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
});

test('the Dockerfile copies only what exists, and the build context leaves out opus/dnn', () => {
  const dockerfile = read('Dockerfile');
  const copies = [];
  dockerfile.replace(/^COPY --chown=moonlight (\S+) /gm, (all, source) => copies.push(source));
  assert.ok(copies.length >= 10, copies.join(' '));
  copies.filter((source) => source.indexOf('[') < 0 && source.indexOf('*') < 0).forEach((source) => assert.ok(exists(source), source));
  assert.equal(dockerfile.indexOf('h264bitstream'), -1);
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
