// Checks the catch-up of the TV media player after a stall (wasm/audio_catch_up.hpp, since 2.3.5) on synthetic times:
// a packet that arrives after the sound appended so far has ended (the player ran dry) starts it, for 1 second from
// that packet, and another dry-out within it starts it again; the first packet of a stream (nothing appended yet)
// starts nothing; it counts one stall per catch-up that skipped sound and every skipped packet; Reset() clears it all.
// auddec.cpp skips the packets of a catch-up while more than 100 ms wait in the player (audio_decoder_test.cpp), and
// the lead simulation follows the same rule (audio_lead_test.cpp).

#include "audio_catch_up.hpp"
#include "test_support.h"

static void TheFirstPacketStartsNothing() {
  AudioCatchUp catchUp;
  // Nothing appended yet: the end is 0, however late the first packet comes
  CHECK(!catchUp.Update(0.0, 0.0));
  CHECK(!catchUp.Update(5.0, 0.0));
  CHECK(!catchUp.running);
  // Packets in time, with sound still waiting in the player, start nothing either
  CHECK(!catchUp.Update(5.005, 5.010));
  CHECK(!catchUp.Update(5.010, 5.010));
  CHECK_EQ(catchUp.stalls, 0u);
  CHECK_EQ(catchUp.skipped, 0u);
}

static void ADryOutStartsOneSecond() {
  AudioCatchUp catchUp;
  // The sound appended so far ended at 2.0 s, and the next packet comes at 2.15 s: the player ran dry
  CHECK(catchUp.Update(2.15, 2.0));
  CHECK(catchUp.running);
  CHECK_EQ(catchUp.until, 2.15 + kAudioCatchUpSeconds);
  // The packets after it, in time or not, are part of it until 1 second after that packet
  CHECK(catchUp.Update(2.151, 2.155));
  CHECK(catchUp.Update(2.5, 2.6));
  CHECK(catchUp.Update(3.149, 3.2));
  CHECK(!catchUp.Update(3.151, 3.2));
  CHECK(!catchUp.running);
  CHECK(!catchUp.Update(4.0, 4.05));
  // A dry-out starts nothing more than the catch-up: nothing counts until a packet was skipped
  CHECK_EQ(catchUp.stalls, 0u);
  CHECK_EQ(catchUp.skipped, 0u);
}

static void AnotherDryOutStartsItAgain() {
  AudioCatchUp catchUp;
  CHECK(catchUp.Update(10.0, 9.9));
  CHECK(catchUp.Update(10.5, 10.6));
  // The player ran dry again within the second: the catch-up runs for a second from this packet
  CHECK(catchUp.Update(10.8, 10.7));
  CHECK_EQ(catchUp.until, 10.8 + kAudioCatchUpSeconds);
  CHECK(catchUp.Update(11.7, 11.75));
  CHECK(!catchUp.Update(11.801, 11.85));
}

static void SkippedPacketsCountOneStallPerCatchUp() {
  AudioCatchUp catchUp;
  catchUp.Update(1.0, 0.5);
  catchUp.CountSkipped();
  catchUp.CountSkipped();
  catchUp.CountSkipped();
  CHECK_EQ(catchUp.stalls, 1u);
  CHECK_EQ(catchUp.skipped, 3u);
  // A second dry-out within the first catch-up is another stall once it skips
  catchUp.Update(1.5, 1.4);
  CHECK_EQ(catchUp.stalls, 1u);
  catchUp.CountSkipped();
  CHECK_EQ(catchUp.stalls, 2u);
  CHECK_EQ(catchUp.skipped, 4u);
  // A third one after the second ended
  catchUp.Update(2.6, 2.6);
  CHECK(!catchUp.running);
  catchUp.Update(3.0, 2.9);
  catchUp.CountSkipped();
  catchUp.CountSkipped();
  CHECK_EQ(catchUp.stalls, 3u);
  CHECK_EQ(catchUp.skipped, 6u);
}

static void ResetClearsEverything() {
  AudioCatchUp catchUp;
  catchUp.Update(1.0, 0.5);
  catchUp.CountSkipped();
  catchUp.Reset();
  CHECK(!catchUp.running);
  CHECK(!catchUp.skipping);
  CHECK_EQ(catchUp.until, 0.0);
  CHECK_EQ(catchUp.stalls, 0u);
  CHECK_EQ(catchUp.skipped, 0u);
  // The next stream starts from its first packet again
  CHECK(!catchUp.Update(0.0, 0.0));
  catchUp.Update(0.2, 0.1);
  catchUp.CountSkipped();
  CHECK_EQ(catchUp.stalls, 1u);
}

int main() {
  test_support::RunTest("the first packet of a stream, and packets in time, start no catch-up", TheFirstPacketStartsNothing);
  test_support::RunTest("a packet after the end of the appended sound starts a catch-up of 1 second",
                        ADryOutStartsOneSecond);
  test_support::RunTest("another dry-out within the catch-up starts it again from that packet", AnotherDryOutStartsItAgain);
  test_support::RunTest("the skipped packets count one stall per catch-up that skipped", SkippedPacketsCountOneStallPerCatchUp);
  test_support::RunTest("Reset() clears the catch-up and its counts", ResetClearsEverything);
  return test_support::Summary();
}
