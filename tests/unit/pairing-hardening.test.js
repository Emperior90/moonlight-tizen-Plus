'use strict';

// Pins the parts of the hardened pairing and HTTP requests that live outside libgamestream (whose behaviour
// native/pairing_test.c and native/http_request_test.c run): the native code doesn't log the pairing PIN or the remote
// input key of a stream, the box art gets the larger answer limit of libgamestream/http.h, and the major version of the
// host that chooses the hash of the pairing is read up to the first dot of its appversion (utils.js), so that a host
// of version 10 or later pairs with SHA-256 like one of version 7. The pairing dialog with a wrong PIN is in
// browser/pairing-dialog.test.js. LoadCert() of wasm/http.cpp, which no native test builds, writes the hex text of the
// client certificate through wasm/hex_text.hpp (native/hex_text_test.cpp runs it) and frees what it took on its two
// error paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext } = require('./helpers/platform-loader');

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

test('the major version of the host is read up to the first dot, so a host of version 10 pairs with SHA-256', () => {
  const platform = createPlatformContext();
  platform.load('wasm/static/js/utils.js');
  const parse = platform.get('parseServerMajorVersion');
  // Sunshine and GeForce Experience report 7.x, older GeForce Experience 3.x to 6.x
  assert.equal(parse('7.1.431.-1'), 7);
  assert.equal(parse('7.1.450.0'), 7);
  assert.equal(parse('3.20.4.14'), 3);
  // Reading only the first character gave 1 for these, which pairs with SHA-1 (libgamestream/pairing.c)
  assert.equal(parse('10.0.1'), 10);
  assert.equal(parse('12.3.4.5'), 12);
  assert.equal(parse('10'), 10);
  // Without a number it stays NaN as before, which the pairing passes as 0
  assert.ok(Number.isNaN(parse('')));
  assert.ok(Number.isNaN(parse('abc')));
  // The server info sets it with this function, and the pairing takes it as it is
  const utils = read('wasm/static/js/utils.js');
  assert.match(utils, /this\.serverMajorVersion = parseServerMajorVersion\(this\.appVersion\);/);
  assert.doesNotMatch(utils, /appVersion\.substring\(0, 1\)/);
  assert.match(read('libgamestream/pairing.c'), /return serverMajorVersion >= 7 \? 32 : 20;/);
  assert.match(read('wasm/main.cpp'), /gs_pair\(atoi\(serverMajorVersion\.c_str\(\)\)/);
});

test('LoadCert() writes the hex text of the certificate within its buffer and frees what it took on its error paths', () => {
  const http = read('wasm/http.cpp');
  assert.match(http, /#include "hex_text\.hpp"/);
  // No sprintf() of a char, which is signed and printed eight digits for a byte of 0x80 or more
  assert.doesNotMatch(http, /sprintf\(/);
  const load = functionBody(http, 'LoadResult MoonlightInstance::LoadCert(');
  assert.match(load, /const size_t certLength = strlen\(certStr\);\s+const size_t certHexSize = certLength \* 2 \+ 1;\s+g_CertHex = reinterpret_cast<char\*>\(malloc\(certHexSize\)\);\s+WriteHexText\(certStr, certLength, g_CertHex, certHexSize\);/);
  // The BIO is freed before each result is looked at, and both error paths free the two copies of the texts
  assert.match(load, /g_Cert = PEM_read_bio_X509\(bio, NULL, NULL, NULL\);\s+BIO_free_all\(bio\);\s+if \(!g_Cert\) \{\s+free\(_certStr\);\s+free\(_keyStr\);\s+return LoadResult::CertErr;\s+\}/);
  assert.match(load, /g_PrivateKey = PEM_read_bio_PrivateKey\(bio, NULL, NULL, NULL\);\s+BIO_free_all\(bio\);\s+if \(!g_PrivateKey\) \{\s+free\(_certStr\);\s+free\(_keyStr\);\s+return LoadResult::PrivateKeyErr;\s+\}/);
  // One BIO_free_all() for each BIO, and the copies are freed before each of the three returns
  assert.equal(load.split('BIO_new_mem_buf(').length - 1, 2);
  assert.equal(load.split('BIO_free_all(bio);').length - 1, 2);
  assert.equal(load.split('return LoadResult::').length - 1, 3);
  assert.equal(load.split('free(_certStr);').length - 1, 3);
  assert.equal(load.split('free(_keyStr);').length - 1, 3);
  // The conversion goes through unsigned char, and the native test runs it
  assert.match(read('wasm/hex_text.hpp'), /const unsigned char byte = \(unsigned char\)bytes\[i\];/);
  assert.match(read('tests/native/hex_text_test.cpp'), /#include "hex_text\.hpp"/);
});
