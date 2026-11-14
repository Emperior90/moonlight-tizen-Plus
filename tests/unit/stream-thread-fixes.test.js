'use strict';

// Pins four fixes of the native stream code in the code, next to the native tests that run them: the mouse movement and
// wheel that the main and the input thread share go through atomic exchanges (native/mouse_input_test.cpp), a stop
// during the start of a stream interrupts the connection setup, also when it came before LiStartConnection cleared its
// interrupt flag (native/connection_interrupt_test.cpp), and the RTSP parser of moonlight-common-c stays within its
// buffer for an answer cut off inside a header (native/rtsp_parser_test.c). That was a local fix of the parser with
// strtok_r() until the parser of upstream moonlight-common-c aeba988 replaced it, which reads line by line and
// checks every read against the end of the buffer. The fourth: the connection thread and the stop thread of a stream
// are created and joined through wasm/stream_threads.hpp only, which joins each of them once
// (native/stream_threads_test.cpp runs the rule; wasm/main.cpp, which calls it, is built by no native test, so the
// places and the order of its calls are pinned here). The same header tells an answer of the media source of the TV
// to its close that comes after the next start from one in time (the last three tests of that native test), and the
// last test here pins that CloseMediaSource() of main.cpp releases the tracks through that rule only.

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
  const source = read('moonlight-common-c/src/RtspParser.c');
  const parser = functionBody(source, 'int parseRtspMessage(');
  // The parser of aeba988, without strtok_r(), whose tokens ran up to the null terminator of a cut-off message
  assert.doesNotMatch(parser, /strtok_r\(/);
  assert.match(parser, /if \(length <= 0\) \{\s+return RTSP_ERROR_MALFORMED;\s+\}/);
  assert.match(parser, /char\* bufferEnd = messageBuffer \+ length;/);
  assert.match(parser, /while \(ptr <= bufferEnd\) \{\s+if \(checkMessageEnded\(ptr, messageBuffer, length, &payload\)\) \{/);
  // The end of the message is looked for only within the buffer, and each read there needs the bytes to remain
  const ended = functionBody(source, 'static bool checkMessageEnded(');
  assert.match(ended, /if \(endCheck <= messageBuffer \+ length\) \{\s+int remaining = \(int\)\(\(messageBuffer \+ length\) - endCheck\);/);
  assert.match(ended, /remaining == 1 && endCheck\[0\] == '\\r'/);
  assert.match(ended, /remaining >= 2 && memcmp\(endCheck, "\\r\\n", 2\) == 0/);
  assert.match(ended, /remaining >= 1 && endCheck\[0\] == '\\n'/);
  // The LF after a CR is only read when it is inside the buffer
  assert.match(functionBody(source, 'static char* getNextLine('), /if \(origEnd == '\\r' && nextLine < bufferEnd && \*nextLine == '\\n'\) \{/);
  assert.match(read('tests/native/rtsp_parser_test.c'), /test_truncated_message_is_malformed/);
});

test('the connection thread and the stop thread of a stream are created and joined through stream_threads.hpp only', () => {
  const main = read('wasm/main.cpp');
  const header = read('wasm/moonlight_wasm.hpp');
  assert.match(header, /#include "stream_threads\.hpp"/);
  assert.match(header, /\n {2}StreamThreads m_StreamThreads;\n/);
  // No handle and no flag of these threads past the bookkeeping, in any file of the module
  for (const file of ['wasm/main.cpp', 'wasm/moonlight_wasm.hpp', 'wasm/connectionlistener.cpp', 'wasm/wasmplayer.cpp']) {
    assert.doesNotMatch(read(file), /m_ConnectionThread\b|m_StopThread\b|m_StopIssued\b/, file);
  }
  // The only thread that main.cpp still creates and joins itself is the input thread
  assert.deepEqual(main.match(/pthread_(?:create|join)\([^;]*;/g).filter((call) => !/m_InputThread/.test(call)), []);

  // StartStream(): the joins come first, before the state that the thread of the start before read is reset, and a
  // connection thread that can't be created ends the start
  const start = functionBody(main, 'MessageResult MoonlightInstance::StartStream(');
  const begin = start.indexOf('if (m_StreamThreads.BeginStart()) {');
  assert.ok(begin > 0 && begin < start.indexOf('m_ConnectionCancelled = false;'), 'BeginStart() comes before the reset');
  assert.ok(begin < start.indexOf('PostToJs('), 'BeginStart() comes before the first message of the new stream');
  assert.equal(start.split('m_StreamThreads.BeginStart()').length - 1, 1);
  assert.match(start, /if \(!m_StreamThreads\.StartConnectionThread\(MoonlightInstance::ConnectionThreadFunc, this\)\) \{[^}]*OnConnectionStopped\(0\);\s+\}/);
  assert.equal(main.split('m_StreamThreads.StartConnectionThread(').length - 1, 1);

  // OnConnectionStopped(): one stop per start, and the stop thread only for the first
  const stopped = functionBody(main, 'void MoonlightInstance::OnConnectionStopped(');
  const issued = stopped.search(/if \(!m_StreamThreads\.IssueStop\(\)\) \{[^}]*return;\s+\}/);
  const stopThread = stopped.indexOf('m_StreamThreads.StartStopThread(MoonlightInstance::StopThreadFunc, NULL)');
  assert.ok(issued > 0 && stopThread > issued, 'the stop thread is created after the check for a repeated stop');
  assert.equal(main.split('m_StreamThreads.StartStopThread(').length - 1, 1);

  // StopThreadFunc(): the connection thread is joined before LiStopConnection(), which must not run during
  // LiStartConnection()
  const stop = functionBody(main, 'void* MoonlightInstance::StopThreadFunc(');
  const join = stop.indexOf('g_Instance->m_StreamThreads.JoinConnectionThread();');
  assert.ok(join > 0 && join < stop.indexOf('LiStopConnection();') && join < stop.indexOf('LiSendKeyboardEvent('));

  // ConnectionThreadFunc(): joins nothing, and posts its termination without waiting for the front end, as its last
  // step: the next StartStream() joins the thread of a start that failed on its own on the main thread, which the
  // thread must not wait for then
  const connection = functionBody(main, 'void* MoonlightInstance::ConnectionThreadFunc(');
  assert.doesNotMatch(connection, /JoinConnectionThread|BeginStart|pthread_join/);
  assert.doesNotMatch(connection, /PostToJs\(\s*(?:std::string\()?MSG_STREAM_TERMINATED/);
  assert.match(connection, /if \(me->m_ConnectionCancelled\) \{\s+\/\/[^\n]*\n\s+if \(!me->m_StreamThreads\.IsStopIssued\(\)\) \{\s+PostToJsAsync\(MSG_STREAM_TERMINATED \+ std::to_string\(0\)\);\s+\}\s+\} else \{\s+PostToJsAsync\(MSG_STREAM_TERMINATED \+ std::to_string\(err\)\);\s+\}\s+return NULL;/);

  // The rule itself is in the header, which the native test runs with real threads
  const rule = read('wasm/stream_threads.hpp');
  assert.match(rule, /typedef StreamThreadsOf<PlatformThreads> StreamThreads;/);
  assert.match(read('tests/native/stream_threads_test.cpp'), /#include "stream_threads\.hpp"/);
});

test('the answer of the media source to its close releases the tracks only while no other stream was started', () => {
  const main = read('wasm/main.cpp');
  const close = functionBody(main, 'void MoonlightInstance::CloseMediaSource(');
  // The number of the start is read before Close() and kept by the answer, which can come after the wait gave up
  const number = close.indexOf('const unsigned int closingStart = m_StreamThreads.StartNumber();');
  const call = close.indexOf('m_Source->Close([closingStart](samsung::wasm::OperationResult err) {');
  assert.ok(number > 0 && call > number, 'the number of the start is read before the source is asked to close');
  assert.match(close, /if \(!ReleaseTracksOfClosedSource\(g_Instance->m_StreamThreads, closingStart, g_Instance->m_AudioTrack,\s+g_Instance->m_VideoTrack\)\) \{\s+ClLogMessage\("[^"]*"\);\s+\}/);
  // No track is emptied past the rule, in any file of the module
  for (const file of ['wasm/main.cpp', 'wasm/wasmplayer.cpp', 'wasm/auddec.cpp']) {
    assert.doesNotMatch(read(file), /m_(?:Audio|Video)Track = samsung::wasm::ElementaryMediaTrack\(\)/, file);
  }
  // A late answer still ends the wait of the thread that closes the source, as before
  const answered = close.indexOf('g_Instance->m_SourceClosed = true;');
  assert.ok(answered > call && answered < close.indexOf('m_SourceClosedCV.wait_for('));

  // The rule: the number rises once per start, after the joins of the threads that close the source of the stream
  // before, and an answer for another number leaves the tracks alone
  const rule = read('wasm/stream_threads.hpp');
  const begin = rule.slice(rule.indexOf('bool BeginStart() {'), rule.indexOf('bool StartConnectionThread('));
  const raised = begin.indexOf('m_StartNumber.fetch_add(1);');
  assert.ok(raised > begin.indexOf('Threads::Join(m_StopThread);') && raised > begin.indexOf('JoinConnectionThread();'));
  assert.equal(rule.split('m_StartNumber.fetch_add(').length - 1, 1);
  assert.match(rule, /if \(threads\.StartNumber\(\) != closingStart\) \{\s+return false;\s+\}\s+audioTrack = Track\(\);\s+videoTrack = Track\(\);\s+return true;/);
  assert.match(read('tests/native/stream_threads_test.cpp'), /ReleaseTracksOfClosedSource\(threads, closingStart, audioTrack, videoTrack\)/);
});
