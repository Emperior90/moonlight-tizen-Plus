#pragma once
// Host stand-in for <emscripten.h> for the C tests of moonlight-common-c (tests/native/*_test.c), whose Limelog()
// writes through emscripten_log(). The C++ stubs in tests/native/stubs need a C++ compiler, so the C tests use this
// one.
#define EM_LOG_CONSOLE 1
static inline void emscripten_log(int flags, const char* format, ...) {
  (void)flags;
  (void)format;
}
