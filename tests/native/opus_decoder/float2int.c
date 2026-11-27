// The local patch of opus/celt/float_cast.h (tests/unit/vendored-opus-patch.test.js): in WebAssembly float2int()
// rounds with one float addition instead of lrintf(). The native build of this machine takes the __SSE__ branch of the
// header, so this file is built with -D__EMSCRIPTEN__ -U__SSE__ (tests/native/run.sh) to reach the branch of the
// WebAssembly build, and compares it with lrintf() of the C library: every float from 0.25 to 65536 in size of both
// signs (all that FLOAT2INT16() can round to something else than 0, and beyond), and FLOAT2INT16() on the values that
// its clamping handles (0, denormals, the limits, infinities and NaN).
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "float_cast.h"

#if !defined(__EMSCRIPTEN__) || defined(__SSE__)
#error "build with -D__EMSCRIPTEN__ -U__SSE__ to reach the branch of the WebAssembly build"
#endif
#ifdef float2int
#error "float2int() is the lrintf() macro of float_cast.h, not the branch of the patch"
#endif

static float FromBits(uint32_t bits) {
  float x;
  memcpy(&x, &bits, sizeof(x));
  return x;
}

static int16_t ReferenceFloat2Int16(float x) {
  x = x * CELT_SIG_SCALE;
  x = MAX32(x, -32768);
  x = MIN32(x, 32767);
  return (int16_t)lrintf(x);
}

int main(void) {
  unsigned long long checked = 0, wrong = 0;
  // Exponents 125 to 142: 0.25 <= |x| < 65536
  for (uint32_t sign = 0; sign < 2; sign++) {
    for (uint32_t bits = 125u << 23; bits < 143u << 23; bits++) {
      const float x = FromBits(sign << 31 | bits);
      checked++;
      if (float2int(x) != (opus_int32)lrintf(x)) {
        if (wrong++ < 5) printf("float2int(%.9g) = %d, lrintf() %ld\n", x, float2int(x), lrintf(x));
      }
    }
  }
  const float special[] = { 0.0f, -0.0f, FromBits(1), FromBits(0x80000001u), 1e-20f, 0.5f / 32768, 1.5f / 32768,
    2.5f / 32768, 1.0f, -1.0f, 32767.5f / 32768, -32768.5f / 32768, 2.0f, -2.0f, 1e30f, -1e30f, INFINITY, -INFINITY,
    NAN, -NAN };
  unsigned specialWrong = 0;
  for (size_t i = 0; i < sizeof(special) / sizeof(special[0]); i++) {
    if (FLOAT2INT16(special[i]) != ReferenceFloat2Int16(special[i])) {
      specialWrong++;
      printf("FLOAT2INT16(%g) = %d, with lrintf() %d\n", special[i], FLOAT2INT16(special[i]),
        ReferenceFloat2Int16(special[i]));
    }
  }
  printf("%s - float2int() of float_cast.h for WebAssembly: %llu floats, %llu unlike lrintf(); FLOAT2INT16(): %u of %u "
    "special values unlike\n", wrong == 0 && specialWrong == 0 ? "ok" : "not ok", checked, wrong, specialWrong,
    (unsigned)(sizeof(special) / sizeof(special[0])));
  return wrong == 0 && specialWrong == 0 ? 0 : 1;
}
