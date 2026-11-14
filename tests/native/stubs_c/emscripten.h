#pragma once
// Host stand-in for <emscripten.h> for the C tests of moonlight-common-c (tests/native/*_test.c), whose Limelog()
// writes through emscripten_log() when no listener takes its lines. The C++ stubs in tests/native/stubs need a C++
// compiler, so the C tests use this one. A test can read how many lines went to the console and the format of the last
// one (each file that includes this header has its own count).
#define EM_LOG_CONSOLE 1
static int emscripten_log_calls = 0;
static const char* emscripten_log_last_format = 0;
static inline void emscripten_log(int flags, const char* format, ...) {
  (void)flags;
  emscripten_log_calls++;
  emscripten_log_last_format = format;
}
