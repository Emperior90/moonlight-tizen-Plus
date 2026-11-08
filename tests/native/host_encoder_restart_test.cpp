// Checks the rule that tells the keyframe of a restart of the video encoder of the host apart from a recovery keyframe
// (wasm/host_encoder_restart.hpp): Sunshine sends the HDR mode each time it creates an encoder, so every message after
// the first of a stream is a restart, and one keyframe within a second of it, before or after, belongs to it, also when
// the two threads read their clocks in the other order than they store their results. A new stream starts counting
// again (StartStream() of wasm/main.cpp resets it). hdr_metadata_submit_test.cpp runs the rule in the decoder path of
// wasm/wasmplayer.cpp.

#include "host_encoder_restart.hpp"

#include "test_support.h"

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

int main() {
  test_support::RunTest("the first HDR mode message of a stream is no restart", TheFirstMessageOfAStreamIsNoRestart);
  test_support::RunTest("one keyframe within a second after the message belongs to the restart",
                        OneKeyframeWithinASecondAfterTheMessageBelongsToIt);
  test_support::RunTest("a message within a second after a recovery keyframe claims it once",
                        AMessageWithinASecondAfterTheKeyframeClaimsItOnce);
  test_support::RunTest("a message stamped just before a keyframe that missed it claims it once",
                        AMessageStampedJustBeforeTheKeyframeThatItMissedClaimsItOnce);
  return test_support::Summary();
}
