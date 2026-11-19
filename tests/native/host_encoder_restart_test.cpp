// Checks the rule that tells the keyframe of a restart of the video encoder of the host apart from a recovery keyframe
// (wasm/host_encoder_restart.hpp): Sunshine sends the HDR mode each time it creates an encoder, so every message after
// the first of a stream is a restart, and one keyframe within a second of it, before or after, belongs to it, also when
// the two threads read their clocks in the other order than they store their results. A new stream starts counting
// again (StartStream() of wasm/main.cpp resets it). hdr_metadata_submit_test.cpp runs the rule in the decoder path of
// wasm/wasmplayer.cpp.
//
// The header is built here with the atomics as the runtime of the TV has them (tv_runtime::atomic below), so that the
// rule is checked with the 8-byte compare-exchange of Samsung's Emscripten 1.39, which g++ doesn't have: with it the
// rule counted the keyframe of a restart whose message arrived at an even millisecond as a recovery. The rule keeps
// the lower 32 bits of the clock, so the times around 0 and around the wrap of those 32 bits are checked too.

#include <atomic>
#include <cstdint>

// std::atomic as the runtime of Samsung's Emscripten 1.39 (fastcomp) has it. The compiler turns every 8-byte atomic
// operation into a call of a helper of system/lib/pthread/library_pthread_asmjs.c of the SDK. Its
// __atomic_compare_exchange_8 swaps when the value matches, but returns the old value, whose lowest bit the caller takes
// for whether it swapped, and never writes the value it found back to expected. Every other operation, and every
// operation on 4 bytes, is right (tests/unit/native-atomics.test.js).
namespace tv_runtime {
using namespace ::std;

template <typename T>
class atomic : public ::std::atomic<T> {
 public:
  using ::std::atomic<T>::atomic;

  bool compare_exchange_strong(T& expected, T desired, ::std::memory_order order = ::std::memory_order_seq_cst) {
    if constexpr (sizeof(T) != 8) {
      return ::std::atomic<T>::compare_exchange_strong(expected, desired, order);
    } else {
      T found = expected;
      const T old = ::std::atomic<T>::compare_exchange_strong(found, desired, order) ? expected : found;
      return (old & 1) != 0;
    }
  }

  bool compare_exchange_weak(T& expected, T desired, ::std::memory_order order = ::std::memory_order_seq_cst) {
    return compare_exchange_strong(expected, desired, order);
  }
};
}  // namespace tv_runtime

// The header with tv_runtime::atomic in place of std::atomic. Its standard headers are already included above, so the
// macro reaches the header alone; tv_runtime finds every other name of std through its using-directive.
#define std tv_runtime
#include "host_encoder_restart.hpp"
#undef std

#include "test_support.h"

// The times of the clock around the wrap of its lower 32 bits
static constexpr uint64_t kWrapMs = uint64_t{1} << 32;

static void TheFirstMessageOfAStreamIsNoRestart() {
  HostEncoderRestarts restarts;
  restarts.Reset();
  CHECK(!restarts.OnHdrModeMessage(1000));
  CHECK(restarts.OnHdrModeMessage(5000));
  CHECK(restarts.OnHdrModeMessage(9000));
  CHECK_EQ(restarts.Restarts(), 2u);
  // A new stream starts with the message of its first encoder again
  restarts.Reset();
  CHECK_EQ(restarts.Restarts(), 0u);
  CHECK(!restarts.OnHdrModeMessage(20000));
  // Its keyframe is no restart keyframe either
  CHECK(!restarts.IsRestartKeyframe(20050));
}

static void OneKeyframeWithinASecondAfterTheMessageBelongsToIt() {
  HostEncoderRestarts restarts;
  restarts.Reset();
  restarts.OnHdrModeMessage(1000);
  restarts.OnHdrModeMessage(5000);
  CHECK(restarts.IsRestartKeyframe(5000 + HostEncoderRestarts::kKeyframeWindowMs));
  // Only one keyframe per restart
  CHECK(!restarts.IsRestartKeyframe(5100 + HostEncoderRestarts::kKeyframeWindowMs / 2));
  // A keyframe more than a second after the message is a recovery
  restarts.OnHdrModeMessage(10000);
  CHECK(!restarts.IsRestartKeyframe(10001 + HostEncoderRestarts::kKeyframeWindowMs));
}

static void AMessageWithinASecondAfterTheKeyframeClaimsItOnce() {
  HostEncoderRestarts restarts;
  restarts.Reset();
  restarts.OnHdrModeMessage(1000);
  // The keyframe arrives first and counts as a recovery until the message comes
  CHECK(!restarts.IsRestartKeyframe(5000));
  CHECK(!restarts.LateRestartKeyframe(5016));
  restarts.OnHdrModeMessage(5300);
  CHECK(restarts.LateRestartKeyframe(5316));
  CHECK(!restarts.LateRestartKeyframe(5333));
  // The restart is answered, so a keyframe after it is a recovery
  CHECK(!restarts.IsRestartKeyframe(5400));
  // A message more than a second after a recovery keyframe claims nothing, and waits for a keyframe of its own
  CHECK(!restarts.LateRestartKeyframe(5400 + HostEncoderRestarts::kKeyframeWindowMs + 1));
  restarts.OnHdrModeMessage(5400 + HostEncoderRestarts::kKeyframeWindowMs + 100);
  CHECK(!restarts.LateRestartKeyframe(5400 + HostEncoderRestarts::kKeyframeWindowMs + 116));
  CHECK(restarts.IsRestartKeyframe(5400 + HostEncoderRestarts::kKeyframeWindowMs + 200));
}

static void AMessageStampedJustBeforeTheKeyframeThatItMissedClaimsItOnce() {
  HostEncoderRestarts restarts;
  restarts.Reset();
  restarts.OnHdrModeMessage(1000);
  // The control thread reads its clock (5000), the decoder thread reads its clock (5001) and finds no message yet, and
  // only then is the message stored: the keyframe counts as a recovery for now
  CHECK(!restarts.IsRestartKeyframe(5001));
  restarts.OnHdrModeMessage(5000);
  // The next frame takes it back, once
  CHECK(restarts.LateRestartKeyframe(5017));
  CHECK(!restarts.LateRestartKeyframe(5034));
  // The message is answered, so it can't swallow a recovery keyframe that follows within the second
  CHECK(!restarts.IsRestartKeyframe(5500));
  CHECK(!restarts.LateRestartKeyframe(5517));
  // A message stored more than a second before a recovery keyframe claims nothing
  restarts.OnHdrModeMessage(7000);
  CHECK(!restarts.IsRestartKeyframe(7000 + HostEncoderRestarts::kKeyframeWindowMs + 1));
  CHECK(!restarts.LateRestartKeyframe(7000 + HostEncoderRestarts::kKeyframeWindowMs + 17));
}

static void ARestartCountsOnceAtAnOddOrEvenMillisecond() {
  // The message first, its keyframe up to a second later
  for (uint64_t messageMs = 5000; messageMs < 5004; messageMs++) {
    for (uint64_t delayMs : {0, 1, 2, 3, 999, 1000}) {
      HostEncoderRestarts restarts;
      restarts.Reset();
      restarts.OnHdrModeMessage(1000);
      restarts.OnHdrModeMessage(messageMs);
      CHECK(restarts.IsRestartKeyframe(messageMs + delayMs));
      CHECK(!restarts.LateRestartKeyframe(messageMs + delayMs + 16));
      CHECK(!restarts.IsRestartKeyframe(messageMs + delayMs + 100));
    }
  }
  // The keyframe first, its message up to a second later
  for (uint64_t keyframeMs = 5000; keyframeMs < 5004; keyframeMs++) {
    for (uint64_t delayMs : {1, 2, 3, 999, 1000}) {
      HostEncoderRestarts restarts;
      restarts.Reset();
      restarts.OnHdrModeMessage(1000);
      CHECK(!restarts.IsRestartKeyframe(keyframeMs));
      restarts.OnHdrModeMessage(keyframeMs + delayMs);
      CHECK(restarts.LateRestartKeyframe(keyframeMs + delayMs + 16));
      CHECK(!restarts.LateRestartKeyframe(keyframeMs + delayMs + 33));
      CHECK(!restarts.IsRestartKeyframe(keyframeMs + delayMs + 100));
    }
  }
}

static void TimesAroundZeroAndTheWrapOfTheLower32Bits() {
  HostEncoderRestarts restarts;
  // A message at 0 ms (0 stands for no message, so it counts as 1 ms) and its keyframe, and one at 2 ms
  restarts.Reset();
  restarts.OnHdrModeMessage(0);
  restarts.OnHdrModeMessage(0);
  CHECK(restarts.IsRestartKeyframe(0));
  restarts.OnHdrModeMessage(2);
  CHECK(restarts.IsRestartKeyframe(500));

  // A message before the wrap and its keyframe after it
  restarts.Reset();
  restarts.OnHdrModeMessage(1000);
  restarts.OnHdrModeMessage(kWrapMs - 300);
  CHECK(restarts.IsRestartKeyframe(kWrapMs + 200));
  CHECK(!restarts.IsRestartKeyframe(kWrapMs + 300));
  // A keyframe before the next wrap and its message after it
  CHECK(!restarts.IsRestartKeyframe(kWrapMs + kWrapMs - 400));
  restarts.OnHdrModeMessage(kWrapMs + kWrapMs + 500);
  CHECK(restarts.LateRestartKeyframe(kWrapMs + kWrapMs + 516));

  // A message at the wrap, whose lower 32 bits are 0, and a keyframe a moment before it or a second after it
  restarts.Reset();
  restarts.OnHdrModeMessage(1000);
  restarts.OnHdrModeMessage(kWrapMs);
  CHECK(restarts.IsRestartKeyframe(kWrapMs - 1));
  restarts.OnHdrModeMessage(kWrapMs + kWrapMs);
  CHECK(restarts.IsRestartKeyframe(kWrapMs + kWrapMs + HostEncoderRestarts::kKeyframeWindowMs));

  // More than a second apart across the wrap: a recovery, which the message can't claim later
  restarts.Reset();
  restarts.OnHdrModeMessage(1000);
  restarts.OnHdrModeMessage(kWrapMs - 600);
  CHECK(!restarts.IsRestartKeyframe(kWrapMs + 401));
  CHECK(!restarts.LateRestartKeyframe(kWrapMs + 417));
  // A recovery keyframe before the wrap no longer takes a message more than a second later
  restarts.Reset();
  restarts.OnHdrModeMessage(1000);
  CHECK(!restarts.IsRestartKeyframe(kWrapMs - 500));
  CHECK(!restarts.LateRestartKeyframe(kWrapMs + 501));
  restarts.OnHdrModeMessage(kWrapMs + 502);
  CHECK(!restarts.LateRestartKeyframe(kWrapMs + 518));
  // That message waits for a keyframe of its own
  CHECK(restarts.IsRestartKeyframe(kWrapMs + 600));
}

int main() {
  test_support::RunTest("the first HDR mode message of a stream is no restart", TheFirstMessageOfAStreamIsNoRestart);
  test_support::RunTest("one keyframe within a second after the message belongs to the restart",
                        OneKeyframeWithinASecondAfterTheMessageBelongsToIt);
  test_support::RunTest("a message within a second after a recovery keyframe claims it once",
                        AMessageWithinASecondAfterTheKeyframeClaimsItOnce);
  test_support::RunTest("a message stamped just before a keyframe that missed it claims it once",
                        AMessageStampedJustBeforeTheKeyframeThatItMissedClaimsItOnce);
  test_support::RunTest("the keyframe of a restart counts once whether its message came at an odd or even millisecond",
                        ARestartCountsOnceAtAnOddOrEvenMillisecond);
  test_support::RunTest("times around 0 and around the wrap of the lower 32 bits of the clock",
                        TimesAroundZeroAndTheWrapOfTheLower32Bits);
  return test_support::Summary();
}
