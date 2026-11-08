'use strict';

// Pins the local patch of the vendored moonlight-common-c that gives an RTSP answer which doesn't decrypt with the key
// of the start an error code of its own, ML_ERROR_RTSP_DECRYPT_FAILED (-300), and how the app handles it. Sunshine
// answers like that while it still holds an earlier start: it drops the launch session of a /launch or /resume that
// comes meanwhile, answers the request with success all the same, and then checks and answers the RTSP requests of that
// start with the key of the one it holds. Upstream reports it as -1, like most RTSP failures, which the app showed as a
// blocked port. tests/native/rtsp_decrypt_error_test.c runs the handshake against a stand-in for the RTSP server of
// Sunshine, tests/native/connection_interrupt_test.cpp the stage failure of wasm/connectionlistener.cpp, and
// tests/browser/held-host-start.test.js the wait, the start once more and the message. A later update of the vendored
// copy would drop the patch unnoticed, so this file checks its code and the places that record it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const readLocale = (name) => JSON.parse(read('wasm/static/locales/' + name + '.json'));
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
const HELD_START_MESSAGE = 'The PC is still holding an earlier start, e.g. from another device. Wait a few seconds and start again.';

// The body of a C function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

test('Limelight.h defines ML_ERROR_RTSP_DECRYPT_FAILED as -300, apart from the other error codes', () => {
  const header = read('moonlight-common-c/src/Limelight.h');
  assert.match(header, /\n#define ML_ERROR_RTSP_DECRYPT_FAILED -300\n/);
  assert.match(header, /\/\/ Moonlight Plus: this error is passed to ConnListenerStageFailed\(\) for STAGE_RTSP_HANDSHAKE/);
  // No other code of moonlight-common-c or of the app has the value
  const codes = (text) => (text.match(/#define \w*ERROR\w* -?\d+/g) || []).map((line) => line.split(' '));
  const others = codes(header).concat(codes(read('wasm/moonlight_wasm.hpp')))
    .filter(([, name]) => name !== 'ML_ERROR_RTSP_DECRYPT_FAILED');
  assert.ok(others.length >= 8, others.map(([, name]) => name).join(', '));
  others.forEach(([, name, value]) => assert.notEqual(Number(value), -300, name));
});

test('RtspConnection.c reports a failed decryption of an encrypted answer with it, and every other failure as before', () => {
  const source = read('moonlight-common-c/src/RtspConnection.c');
  const unseal = functionBody(source, 'static bool unsealRtspMessage(char* rawMessage, int rawMessageLen, PRTSP_MESSAGE response, int* error) {');
  // Only the failure of the decryption sets it, right after its log line
  assert.match(unseal, /Limelog\("Failed to decrypt RTSP response\\n"\);\s+(\/\/[^\n]*\n\s+)*\*error = ML_ERROR_RTSP_DECRYPT_FAILED;\s+free\(decryptedMessage\);\s+return false;/);
  assert.equal((unseal.match(/\*error = /g) || []).length, 1);
  assert.equal((source.match(/ML_ERROR_RTSP_DECRYPT_FAILED/g) || []).length, 2, 'the comment of the function and the line');
  // The one call passes the error of the request on, which the requests of the handshake return (ret = error)
  assert.equal((source.match(/unsealRtspMessage\(/g) || []).length, 2, 'the definition and one call');
  const tcp = functionBody(source, 'static bool transactRtspMessageTcp(');
  assert.match(tcp, /ret = unsealRtspMessage\(responseBuffer, offset, response, error\);/);
  const handshake = functionBody(source, 'int performRtspHandshake(PSERVER_INFORMATION serverInfo) {');
  assert.match(handshake, /if \(!requestOptions\(&response, &error\)\) \{\s+Limelog\("RTSP OPTIONS request failed: %d\\n", error\);\s+ret = error;/);
  // The native test runs it
  assert.match(read('tests/native/rtsp_decrypt_error_test.c'), /#include "\.\.\/\.\.\/moonlight-common-c\/src\/RtspConnection\.c"/);
});

test('the module shows no dialog with the ports for it, and the front end starts the stream once more', () => {
  const listener = read('wasm/connectionlistener.cpp');
  const stageFailed = listener.slice(listener.indexOf('void MoonlightInstance::ClStageFailed'));
  const skip = stageFailed.indexOf('if (stage == STAGE_RTSP_HANDSHAKE && errorCode == ML_ERROR_RTSP_DECRYPT_FAILED) {\n    return;\n  }');
  assert.ok(skip > 0 && skip < stageFailed.indexOf('PostToJs(std::string("DialogMsg: ")'), 'before the dialog');
  const messages = read('wasm/platform/messages.js');
  assert.match(messages, /var retryKind = errorCode === -100 \? 'noVideo' : errorCode === -300 \? 'heldStart' : '';/);
  const index = read('wasm/platform/index.js');
  assert.match(index, /const STREAM_RESTART_NO_VIDEO = 'noVideo';\nconst STREAM_RESTART_HELD_START = 'heldStart';/);
  // The hold covers ping_timeout of Sunshine (10 s by default) and a second of margin
  assert.match(index, /\nvar HOST_START_HOLD_MS = 11000;\n/);
});

// Load messages.js with a t() that translates with the given locale like i18n.js does, recording the snackbar notices
function loadMessages(locale) {
  const texts = readLocale(locale);
  const format = (text, values) => text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  const t = (key, ...values) => format(Object.prototype.hasOwnProperty.call(texts, key) ? texts[key] : key, values);
  const notices = [];
  const dialogs = [];
  const jquery = () => ({ css: jquery, removeClass: jquery, addClass: jquery, text: jquery, hide: jquery, show: jquery });
  const platform = loadPlatformScripts(['wasm/platform/messages.js', 'wasm/platform/menus.js'], {
    globals: {
      t,
      snackbarLogLong: (key, ...values) => notices.push(t(key, ...values)),
      warningDialog: (title, text) => dialogs.push({ title, text }),
      $: jquery,
      Rumble: { stopAll: () => {} },
      setTvScreenSaver: () => {},
      stopAudioScheduler: () => {},
      streamLaunchHost: null,
      api: null,
      streamLaunchId: 0,
      isInGame: true,
    },
  });
  return { notices, dialogs, handleMessage: platform.get('handleMessage') };
}

test('a stream that ends with -300 and no start once more tells that the PC still holds an earlier start, in every language', () => {
  LOCALES.forEach((locale) => {
    const app = loadMessages(locale);
    app.handleMessage('streamTerminated: -300');
    const expected = readLocale(locale)[HELD_START_MESSAGE];
    assert.ok(expected, locale);
    assert.deepEqual(app.notices, [expected], locale);
    assert.deepEqual(app.dialogs, [], locale);
    // Neither the error code nor the ports of the handshake
    assert.doesNotMatch(app.notices[0], /-300|48010/, locale);
  });
});

test('the countdown of the launch screen is translated with its number of seconds', () => {
  const key = 'Waiting for the PC to release the previous start (%1$s s)...';
  LOCALES.forEach((locale) => {
    const text = readLocale(locale)[key];
    assert.ok(text, locale);
    assert.equal((text.match(/%1\$s s\)/g) || []).length, 1, locale);
  });
  assert.equal(readLocale('de-DE')[key], 'Warten, bis der PC den vorherigen Start freigibt (%1$s s) …');
});

test('the upstream baseline and the changelog record the patch', () => {
  const common = JSON.parse(read('.github/dependency-baselines.json')).dependencies.find((dep) => dep.id === 'moonlight-common-c');
  assert.match(common.note, /ML_ERROR_RTSP_DECRYPT_FAILED for an RTSP answer that doesn't decrypt with the key of the start/);
  const changelog = read('CHANGELOG.md');
  const unreleased = changelog.slice(changelog.indexOf('## 2.3.0 '), changelog.indexOf('## 2.2.1 '));
  assert.match(unreleased, /ML_ERROR_RTSP_DECRYPT_FAILED/);
});
