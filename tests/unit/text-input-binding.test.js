'use strict';

// Pins how JavaScript reaches sendText() of wasm/input.cpp, which sends a text typed on the TV to the host: the Embind
// registration (which the native tests can't run, since tests/native/stubs registers nothing), the checks of
// wasm/text_input.hpp before LiSendUtf8TextEvent(), and that neither logs the text, which can be a password.
// native/text_input_test.cpp runs sendText() itself, and the mock of the module answers like it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The body of a function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

const LOGGING = /ClLogMessage|Limelog|printf|PostToJs|console\.|std::cout|std::cerr|emscripten_log/;

test('JavaScript calls sendText(), which sends only a checked text with LiSendUtf8TextEvent()', () => {
  const input = read('wasm/input.cpp');
  assert.match(input, /#include "text_input\.hpp"/);
  const bindings = functionBody(input, 'EMSCRIPTEN_BINDINGS(input) {');
  assert.match(bindings, /emscripten::function\("sendText", &sendText\);/);
  const body = functionBody(input, 'int sendText(std::string text) {');
  assert.match(body, /return SendTextInput\(text, LiSendUtf8TextEvent\);/);
  assert.doesNotMatch(body, LOGGING);
  // LiSendUtf8TextEvent() is used nowhere else (outside the comments), so no text skips the checks
  const code = input.replace(/\/\/.*$/gm, '');
  assert.equal((code.match(/LiSendUtf8TextEvent/g) || []).length, 1);
  assert.match(read('tests/native/text_input_test.cpp'), /#include "\.\.\/\.\.\/wasm\/input\.cpp"/);
});

test('the checks of a typed text log nothing', () => {
  const header = read('wasm/text_input.hpp');
  assert.doesNotMatch(header.replace(/^\s*\/\/.*$/gm, ''), LOGGING);
  assert.match(header, /constexpr size_t kTextInputMaxBytes = 1024;/);
});

test('the mock of the module answers sendText() like the module during a stream', () => {
  assert.match(read('tests/browser/mocks/moonlight-wasm.js'),
               /Module\.sendText = function\(\) \{\s+record\('sendText', arguments\);\s+return 0;\s+\};/);
});
