'use strict';

// Pins the limit of the IDR frame requests while an IDR frame is on its way, a change of Moonlight Plus to the vendored
// moonlight-common-c in 2.3.1 (moonlight-common-c/src/IdrRequestLimit.h), where its parts have to agree and no native
// test sees all of them: the rule is marked as Plus's own and listed with the local changes of the library
// (.github/dependency-baselines.json), its mutex is a PLT_MUTEX that is only ever held around the rule (a leaf lock, so
// that the depacketizer may call it with its stateLock held), no C11 atomics are used, the depacketizer tells it of an
// IDR frame where it stops waiting for one, and the report of the session and one line of the diagnostic log carry its
// counts (the line also the slowest answer of the host when one was measured). The behaviour itself is run by
// tests/native/idr_request_limit_test.c (the rule, and the IDR request thread over ENet), video_depacketizer_test.c,
// platform_test.c (the timed wait), session_report_test.cpp and stats_overlay_test.cpp.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const library = (file) => read('moonlight-common-c/src/' + file);

// The body of a C function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

test('the rule is Plus\'s own, without C11 atomics, and listed with the local changes of the library', () => {
  const rule = library('IdrRequestLimit.h');
  assert.match(rule, /^#pragma once\n\n\/\/ Moonlight Plus: /);
  assert.match(rule, /not part of upstream moonlight-common-c/);
  assert.match(rule, /#define IDR_LIMIT_MIN_WINDOW_MS 50\n#define IDR_LIMIT_MAX_WINDOW_MS 250\n/);
  ['IdrRequestLimit.h', 'ControlStream.c', 'VideoDepacketizer.c', 'Platform.c'].forEach((file) => {
    assert.doesNotMatch(library(file), /stdatomic|_Atomic|atomic_(load|store|exchange)/, file);
  });
  const baselines = JSON.parse(read('.github/dependency-baselines.json'));
  const common = baselines.dependencies.filter((entry) => entry.id === 'moonlight-common-c')[0];
  assert.match(common.note, /since 2\.3\.1 a limit of the IDR frame requests while an IDR frame is on its way, src\/IdrRequestLimit\.h/);
  assert.match(common.note, /tests\/native\/idr_request_limit_test\.c/);
  // with the declarations that it adds to the headers of the library, so that a sync of a header with upstream keeps them
  assert.match(common.note, /PltWaitForEventTimeout\(\) in Platform\.c \(declared in PlatformThreads\.h\), connectionReceivedIdrFrame\(\) \(declared in Limelight-internal\.h\) and the public LiGetIdrFrameRequestStats\(\) in Limelight\.h/);
});

test('the mutex of the rule is a leaf: only the rule runs while it is held', () => {
  const control = library('ControlStream.c');
  assert.match(control, /#include "IdrRequestLimit\.h"/);
  assert.match(control, /static PLT_MUTEX idrRequestLimitMutex;\nstatic IDR_REQUEST_LIMIT idrRequestLimit;/);
  const held = control.split('PltLockMutex(&idrRequestLimitMutex);').slice(1).map((rest) => {
    const end = rest.indexOf('PltUnlockMutex(&idrRequestLimitMutex);');
    assert.ok(end > 0, 'every lock of the mutex is released');
    return rest.slice(0, end);
  });
  // LiRequestIdrFrame(), connectionReceivedIdrFrame(), LiGetIdrFrameRequestStats() and the IDR request thread
  assert.equal(held.length, 4);
  held.forEach((section) => {
    const calls = (section.match(/\b[A-Za-z_]\w*\s*\(/g) || []).map((call) => call.replace(/\s*\($/, ''));
    calls.forEach((call) => assert.ok(/^(IdrLimit\w+|PltGetMillis)$/.test(call), 'called with the mutex held: ' + call));
  });
  // It lives as long as the event of the IDR requests
  const init = functionBody(control, 'int initializeControlStream(void) {');
  assert.match(init, /PltCreateEvent\(&idrFrameRequiredEvent\);\s+PltCreateMutex\(&idrRequestLimitMutex\);\s+IdrLimitReset\(&idrRequestLimit\);/);
  assert.match(functionBody(control, 'void destroyControlStream(void) {'), /PltDeleteMutex\(&idrRequestLimitMutex\);/);
  // The request thread waits for the end of a hold with a timeout, and still ends at once at a stop
  const thread = functionBody(control, 'static void requestIdrFrameFunc(void* context) {');
  assert.match(thread, /PltWaitForEventTimeout\(&idrFrameRequiredEvent, \(int\)waitMs\);/);
  assert.match(thread, /PltClearEvent\(&idrFrameRequiredEvent\);\s+if \(stopping\) \{\s+\/\/ Bail if we're stopping\s+return;\s+\}/);
  assert.match(functionBody(control, 'int stopControlStream(void) {'), /PltSetEvent\(&idrFrameRequiredEvent\);/);
});

test('the depacketizer tells the rule of an IDR frame where it stops waiting for one', () => {
  const depacketizer = library('VideoDepacketizer.c');
  const calls = depacketizer.split('\n').filter((line) => /^\s+connectionReceivedIdrFrame\(\);/.test(line));
  // The IDR slice of H.264 and HEVC, and the frame header of the other codecs
  assert.equal(calls.length, 2);
  assert.match(depacketizer, /if \(isSeqReferenceFrameStart\(currentPos\)\) \{\s+\/\/ No longer waiting for an IDR frame\s+waitingForIdrFrame = false;[\s\S]{0,200}?connectionReceivedIdrFrame\(\);/);
  assert.match(depacketizer, /case 2: \/\/ IDR frame[\s\S]{0,500}?waitingForIdrFrame = false;[\s\S]{0,400}?connectionReceivedIdrFrame\(\);/);
  assert.match(library('Limelight-internal.h'), /void connectionReceivedIdrFrame\(void\);/);
  assert.match(library('Limelight.h'), /void LiGetIdrFrameRequestStats\(uint32_t\* sent, uint32_t\* held, uint32_t\* slowestAnswerMs\);/);
  assert.match(library('PlatformThreads.h'), /bool PltWaitForEventTimeout\(PLT_EVENT\* event, int timeoutMs\);/);
});

test('the report of the session and one line of the diagnostic log carry the counts', () => {
  const player = read('wasm/wasmplayer.cpp');
  const cleanup = functionBody(player, 'void MoonlightInstance::VidDecCleanup(void) {');
  assert.match(cleanup, /LiGetIdrFrameRequestStats\(&report\.idrRequestsSent, &report\.idrRequestsHeld, &slowestIdrAnswerMs\);\s+if \(slowestIdrAnswerMs > 0\) \{\s+ClLogMessage\("IDR frame requests of the stream: %u sent, %u held while an IDR frame was on its way; the slowest "\s+"IDR frame came %u ms after its request\\n",[\s\S]{0,200}?\} else \{\s+ClLogMessage\("IDR frame requests of the stream: %u sent, %u held while an IDR frame was on its way\\n",/);
  // The time of an answer is taken when the depacketizer tells of the IDR frame, before the mutex
  assert.match(functionBody(library('ControlStream.c'), 'void connectionReceivedIdrFrame(void) {'), /uint64_t nowMs = PltGetMillis\(\);\s+PltLockMutex\(&idrRequestLimitMutex\);\s+IdrLimitOnIdrFrame\(&idrRequestLimit, nowMs\);/);
  assert.ok(cleanup.indexOf('LiGetIdrFrameRequestStats(') < cleanup.indexOf('FormatSessionReportMessage(report)'));
  const report = read('wasm/session_report.hpp');
  assert.match(report, /"\\"idrRequestsSent\\":%u,\\"idrRequestsHeld\\":%u,"/);
  assert.match(report, /report\.recoveryKeyframes, report\.idrRequestsSent, report\.idrRequestsHeld, report\.fecRecoveredBlocks,/);
  const diagnostics = read('wasm/platform/diagnostics.js');
  assert.match(diagnostics, /idrRequestsSent: number\('idrRequestsSent'\),\s+idrRequestsHeld: number\('idrRequestsHeld'\),/);
});
