'use strict';

// Pins how 'Refresh picture' of the Stream Menu reaches the module: the Embind registration of requestIdrFrame() in
// wasm/main.cpp (which the native tests can't run, since tests/native/stubs registers nothing), which hands the request
// to RefreshPicture() of wasm/wasmplayer.cpp, the stub of the module that answers like it during a stream, and
// requestStreamKeyframe() of wasm/platform/menus.js, which logs one line with the answer and copes with a module without
// the function. native/refresh_picture_test.cpp runs RefreshPicture() itself, browser/stream-menu-entries.test.js the
// entry in the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The body of a function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

test('JavaScript calls requestIdrFrame(), which asks RefreshPicture() of the instance and answers whether it asked', () => {
  const main = read('wasm/main.cpp');
  const bindings = functionBody(main, 'EMSCRIPTEN_BINDINGS(handle_message) {');
  assert.match(bindings, /emscripten::function\("requestIdrFrame", &requestIdrFrame\);/);
  assert.match(functionBody(main, 'bool requestIdrFrame() {'), /return g_Instance->RefreshPicture\(\);/);
  assert.match(read('wasm/moonlight_wasm.hpp'), /^bool requestIdrFrame\(\);$/m);
  // RefreshPicture() goes through RequestIdrFrame(), which marks the keyframe as expected, so the statistics don't count
  // it as a recovery
  const player = read('wasm/wasmplayer.cpp');
  const refresh = functionBody(player, 'bool MoonlightInstance::RefreshPicture() {');
  assert.match(refresh, /if \(!m_Running\) \{\s+return false;\s+\}\s+RequestIdrFrame\(\);\s+return true;/);
  assert.doesNotMatch(refresh, /LiRequestIdrFrame/);
  assert.match(functionBody(player, 'void MoonlightInstance::RequestIdrFrame() {'), /s_ExpectedIdrFrame\.store\(true\);\s+LiRequestIdrFrame\(\);/);
  assert.match(read('tests/native/refresh_picture_test.cpp'), /#include "\.\.\/\.\.\/wasm\/wasmplayer\.cpp"/);
});

test('the stub of the module offers requestIdrFrame() and answers like the module during a stream', () => {
  assert.match(read('tests/browser/mocks/moonlight-wasm.js'),
               /Module\.requestIdrFrame = function\(\) \{\s+record\('requestIdrFrame', arguments\);\s+return true;\s+\};/);
});

test('requestStreamKeyframe() asks the module once and logs one line with its answer', () => {
  const cases = [
    { name: 'during a stream', module: { requestIdrFrame: () => true }, calls: 1, line: 'Refresh picture: asked the host for a keyframe.' },
    { name: 'without a stream', module: { requestIdrFrame: () => false }, calls: 1, line: 'Refresh picture: no keyframe requested, because the module has no running stream.' },
    // A module of an earlier build without the function: nothing to call, and the app goes on
    { name: 'an older module', module: {}, calls: 0, line: 'Refresh picture: no keyframe requested, because the module has no running stream.' },
  ];
  for (const entry of cases) {
    let calls = 0;
    const module = Object.assign({}, entry.module);
    if (module.requestIdrFrame) {
      const answer = module.requestIdrFrame;
      module.requestIdrFrame = function() {
        calls++;
        return answer();
      };
    }
    const platform = loadPlatformScripts(['wasm/platform/tv_profile.js', 'wasm/platform/menus.js'], {
      globals: { Module: module, t: (text) => text, tvCapabilities: null },
    });
    const before = platform.consoleMessages.length;
    platform.get('requestStreamKeyframe')();
    const lines = platform.consoleMessages.slice(before).map((message) => message.text);
    assert.equal(calls, entry.calls, entry.name);
    assert.equal(lines.length, 1, entry.name + ': ' + JSON.stringify(lines));
    assert.ok(lines[0].indexOf(entry.line) >= 0, entry.name + ': ' + lines[0]);
  }
});
