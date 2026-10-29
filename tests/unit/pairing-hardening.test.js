'use strict';

// Pins the parts of the hardened pairing and HTTP requests that live outside libgamestream (whose behaviour
// native/pairing_test.c and native/http_request_test.c run): the native code doesn't log the pairing PIN or the remote
// input key of a stream, and the box art gets the larger answer limit of libgamestream/http.h. The pairing dialog with
// a wrong PIN is in browser/pairing-dialog.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The body of a C++ function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

test('the native code logs neither the pairing PIN nor the remote input key', () => {
  const main = read('wasm/main.cpp');
  const start = functionBody(main, 'MessageResult MoonlightInstance::StartStream(');
  assert.doesNotMatch(start, /PostToJs\([^;]*rikey/);
  assert.doesNotMatch(start, /Remote input key/);
  const pair = functionBody(main, 'void MoonlightInstance::Pair_private(');
  // randomNumber is the PIN: it may only go to gs_pair()
  assert.equal((pair.match(/randomNumber/g) || []).length, 2, 'the parameter and the call of gs_pair()');
  assert.match(pair, /gs_pair\([^;]*randomNumber\.c_str\(\)/);
  assert.doesNotMatch(pair, /PIN: %s/);
  assert.doesNotMatch(functionBody(main, 'void MoonlightInstance::Pair('), /randomNumber\.c_str\(\)/);
});

test('the box art gets the larger answer limit, the other requests the default one', () => {
  const http = read('wasm/http.cpp');
  const openUrl = functionBody(http, 'void MoonlightInstance::OpenUrl_private(');
  const limit = openUrl.indexOf('if (binaryResponse) {\n    data->maxSize = HTTP_MAX_BOX_ART_RESPONSE_SIZE;\n  }');
  assert.ok(limit > 0, 'the binary answers (the box art) get HTTP_MAX_BOX_ART_RESPONSE_SIZE');
  assert.ok(openUrl.indexOf('err = http_request(') > limit, 'before the request');
  const header = read('libgamestream/http.h');
  assert.match(header, /#define HTTP_MAX_RESPONSE_SIZE \(\(size_t\)4 \* 1024 \* 1024\)/);
  assert.match(header, /#define HTTP_MAX_BOX_ART_RESPONSE_SIZE \(\(size_t\)16 \* 1024 \* 1024\)/);
  // A failed request reaches JavaScript with its error code, e.g. -8 for GS_RESPONSE_TOO_LARGE
  assert.match(read('libgamestream/errors.h'), /#define GS_RESPONSE_TOO_LARGE -8/);
  assert.match(openUrl, /PostPromiseMessage\(callbackId, "reject", std::to_string\(err\)\);/);
});

test('the native tests run the real pairing and request code', () => {
  const native = (file) => read(path.join('tests/native', file));
  assert.match(native('pairing_test.c'), /#include "\.\.\/\.\.\/libgamestream\/pairing\.c"/);
  assert.match(native('http_request_test.c'), /#include "\.\.\/\.\.\/libgamestream\/http\.c"/);
  // The wrong PIN code that index.js checks is the one of libgamestream
  assert.match(read('libgamestream/errors.h'), /#define GS_PIN_WRONG -7\n/);
  assert.match(read('wasm/platform/index.js'), /String\(failedPairing\) === '-7'/);
});
