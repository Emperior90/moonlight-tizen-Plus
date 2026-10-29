'use strict';

// Pins three fixes of the native stream code in the code, next to the native tests that run them: the mouse movement and
// wheel that the main and the input thread share go through atomic exchanges (native/mouse_input_test.cpp), a stop
// during the start of a stream interrupts the connection setup, also when it came before LiStartConnection cleared its
// interrupt flag (native/connection_interrupt_test.cpp), and the RTSP parser of moonlight-common-c stays within its
// buffer for an answer cut off inside a header (native/rtsp_parser_test.c), a local fix until the parser of upstream
// moonlight-common-c aeba988 replaces it.

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

test('the mouse movement and wheel pass between the threads through atomic exchanges', () => {
  const header = read('wasm/moonlight_wasm.hpp');
  assert.match(header, /std::atomic<int32_t> m_AccumulatedMilliTicks;/);
  assert.match(header, /std::atomic<int32_t> m_MouseDeltaX, m_MouseDeltaY;/);
  const input = read('wasm/input.cpp');
  const move = functionBody(input, 'EM_BOOL MoonlightInstance::HandleMouseMove(');
  assert.match(move, /m_MouseDeltaX\.fetch_add\(/);
  assert.match(move, /m_MouseDeltaY\.fetch_add\(/);
  assert.match(functionBody(input, 'EM_BOOL MoonlightInstance::HandleWheel('), /m_AccumulatedMilliTicks\.fetch_add\(/);
  const report = functionBody(input, 'void MoonlightInstance::ReportMouseMovement(');
  assert.match(report, /int32_t deltaX = m_MouseDeltaX\.exchange\(0\);\s+int32_t deltaY = m_MouseDeltaY\.exchange\(0\);/);
  assert.match(report, /const int32_t milliTicks = m_AccumulatedMilliTicks\.exchange\(0\);/);
  // No read and separate reset any more
  assert.doesNotMatch(report, /= 0;/);
  assert.match(read('tests/native/mouse_input_test.cpp'), /#include "\.\.\/\.\.\/wasm\/input\.cpp"/);
});

test('a stop during the start of a stream interrupts the connection setup', () => {
  const listener = read('wasm/connectionlistener.cpp');
  const cancel = functionBody(listener, 'void MoonlightInstance::CancelPendingSetup(');
  const flag = cancel.indexOf('m_ConnectionCancelled = true;');
  const interrupt = cancel.indexOf('LiInterruptConnection();');
  assert.ok(flag > 0 && interrupt > flag, 'the flag that ClStageStarting() reads is set before the interrupt');
  // LiStartConnection clears the interrupt flag when it begins, before the first stage starts
  const stage = functionBody(listener, 'void MoonlightInstance::ClStageStarting(');
  assert.match(stage, /if \(g_Instance && g_Instance->m_ConnectionCancelled\) \{\s+LiInterruptConnection\(\);\s+\}\s+PostToJs\(/);
  const connection = read('moonlight-common-c/src/Connection.c');
  const start = functionBody(connection, 'int LiStartConnection(');
  assert.ok(start.indexOf('ConnectionInterrupted = false;') < start.indexOf('ListenerCallbacks.stageStarting(STAGE_PLATFORM_INIT);'));
  // Both a stop of the user and a termination by the host cancel the setup
  assert.match(functionBody(read('wasm/main.cpp'), 'void MoonlightInstance::StopConnection('), /CancelPendingSetup\(\);/);
  assert.match(functionBody(listener, 'void MoonlightInstance::ClConnectionTerminated('), /g_Instance->CancelPendingSetup\(\);/);
  assert.match(read('tests/native/connection_interrupt_test.cpp'), /#include "\.\.\/\.\.\/wasm\/connectionlistener\.cpp"/);
});

test('the RTSP parser checks the end of a header against its buffer before it reads there', () => {
  const parser = functionBody(read('moonlight-common-c/src/RtspParser.c'), 'int parseRtspMessage(');
  const end = parser.indexOf('endCheck = &token[0] + strlen(token) + 1;');
  const bound = parser.indexOf('if (endCheck > messageBuffer + length) {\n                    exitCode = RTSP_ERROR_MALFORMED;\n                    goto ExitFailure;');
  const firstRead = parser.indexOf('if (startsWith(endCheck, "\\n")');
  assert.ok(end > 0 && bound > end && firstRead > bound, 'the check comes between endCheck and its first read');
  assert.match(read('tests/native/rtsp_parser_test.c'), /test_truncated_message_is_malformed/);
});
