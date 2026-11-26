// Checks the catch-up of the TV media player after a stall (wasm/audio_catch_up.hpp, since 2.3.5) on synthetic times:
// a packet that arrives after the sound appended so far has ended (the player ran dry) starts it, for 1 second from
// that packet, and another dry-out within it starts it again; the first packet of a stream (nothing appended yet)
// starts nothing; while it runs, a packet is skipped while more than its target (100 ms at first) waits in the player;
// it counts one stall per catch-up that skipped sound and every skipped packet; a dry-out within 2 minutes of a packet
// that found more than the target waiting raises the target by the time the player ran dry, once the backlog of that
// stall goes beyond it, up to 300 ms, while a pause of the host (real-time packets after the dry-out) and a stall more
// than 2 minutes later raise nothing; Reset() clears it all. auddec.cpp skips with it (audio_decoder_test.cpp), and the
// lead simulation follows the same rule (audio_lead_test.cpp).

#include "audio_catch_up.hpp"
#include "test_support.h"

#include <cmath>

static bool Near(double actual, double expected) {
  return std::fabs(actual - expected) < 1e-9;
}

static void TheFirstPacketStartsNothing() {
  AudioCatchUp catchUp;
  // Nothing appended yet: the end is 0, however late the first packet comes
  CHECK(!catchUp.Update(0.0, 0.0));
  CHECK(!catchUp.Update(5.0, 0.0));
  CHECK(!catchUp.running);
  CHECK(!catchUp.Skips(5.0, 5.5));
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

static void PacketsBeyondTheTargetAreSkippedWhileItRuns() {
  AudioCatchUp catchUp;
  CHECK_EQ(catchUp.target, kAudioCatchUpTargetSeconds);
  CHECK_EQ(kAudioCatchUpTargetSeconds, 0.1);
  // Not before a dry-out, however much waits
  CHECK(!catchUp.Update(1.0, 1.5));
  CHECK(!catchUp.Skips(1.0, 1.5));
  // During it: up to the target waits, the packet is kept; beyond it, it is skipped
  CHECK(catchUp.Update(2.0, 1.9));
  CHECK(!catchUp.Skips(2.0, 2.0));
  CHECK(!catchUp.Skips(2.0, 2.099));
  CHECK(catchUp.Skips(2.0, 2.105));
  CHECK(catchUp.Skips(2.5, 2.7));
  // After it, nothing is skipped any more
  CHECK(!catchUp.Update(3.0, 3.2));
  CHECK(!catchUp.Skips(3.0, 3.2));
  CHECK_EQ(catchUp.skipped, 2u);
  CHECK_EQ(catchUp.stalls, 1u);
}

static void SkippedPacketsCountOneStallPerCatchUp() {
  AudioCatchUp catchUp;
  catchUp.Update(1.0, 0.5);
  CHECK(catchUp.Skips(1.0, 1.2));
  CHECK(catchUp.Skips(1.0, 1.2));
  CHECK(catchUp.Skips(1.0, 1.2));
  CHECK_EQ(catchUp.stalls, 1u);
  CHECK_EQ(catchUp.skipped, 3u);
  // A second dry-out within the first catch-up is another stall once it skips (the player was dry for 0.1 ms: the
  // target rises by that much first)
  catchUp.Update(1.5, 1.4999);
  CHECK_EQ(catchUp.stalls, 1u);
  CHECK(catchUp.Skips(1.5, 1.8));
  CHECK_EQ(catchUp.stalls, 2u);
  CHECK_EQ(catchUp.skipped, 4u);
  // A third one after the second ended
  catchUp.Update(2.6, 2.6);
  CHECK(!catchUp.running);
  catchUp.Update(3.0, 2.9999);
  CHECK(catchUp.Skips(3.0, 3.5));
  CHECK(catchUp.Skips(3.0, 3.5));
  CHECK_EQ(catchUp.stalls, 3u);
  CHECK_EQ(catchUp.skipped, 6u);
}

static void AStallThatComesAgainRaisesTheTarget() {
  AudioCatchUp catchUp;
  // A first stall: its backlog beyond 100 ms is skipped, and the target stays
  CHECK(catchUp.Update(30.0, 29.86));
  CHECK(!catchUp.Skips(30.0, 30.099));
  CHECK(catchUp.Skips(30.0, 30.105));
  CHECK_EQ(catchUp.target, kAudioCatchUpTargetSeconds);
  CHECK_EQ(catchUp.raises, 0u);
  // 30 s later the player runs dry again, for 50 ms: the target rises by those 50 ms once the backlog goes beyond the
  // 100 ms, so the backlog of this stall up to 150 ms is kept, and only what goes beyond is skipped
  CHECK(catchUp.Update(60.05, 60.0));
  CHECK_EQ(catchUp.target, kAudioCatchUpTargetSeconds);
  CHECK(!catchUp.Skips(60.05, 60.149));
  CHECK(!catchUp.Skips(60.05, 60.155));
  CHECK(Near(catchUp.target, 0.15));
  CHECK_EQ(catchUp.raises, 1u);
  CHECK(!catchUp.Skips(60.05, 60.199));
  CHECK(catchUp.Skips(60.05, 60.205));
  CHECK_EQ(catchUp.stalls, 2u);
  // Once per dry-out: the next packets of this catch-up skip beyond the raised target
  CHECK(catchUp.Skips(60.06, 60.215));
  CHECK(Near(catchUp.target, 0.15));
  CHECK_EQ(catchUp.raises, 1u);
  // A stall that the raised target absorbs skips nothing and raises nothing
  CHECK(catchUp.Update(90.002, 90.0));
  CHECK(!catchUp.Skips(90.002, 90.15));
  CHECK(Near(catchUp.target, 0.15));
  // A long stall that comes again raises it to 300 ms at most, and no further
  CHECK(catchUp.Update(150.0, 149.5));
  CHECK(!catchUp.Skips(150.0, 150.299));
  CHECK_EQ(catchUp.target, kAudioCatchUpMaxTargetSeconds);
  CHECK_EQ(kAudioCatchUpMaxTargetSeconds, 0.3);
  CHECK(catchUp.Skips(150.0, 150.305));
  CHECK_EQ(catchUp.raises, 2u);
  CHECK(catchUp.Update(160.0, 159.5));
  CHECK(catchUp.Skips(160.0, 160.305));
  CHECK_EQ(catchUp.target, kAudioCatchUpMaxTargetSeconds);
  CHECK_EQ(catchUp.raises, 2u);
}

static void APauseOfTheHostOrALaterStallRaisesNothing() {
  AudioCatchUp catchUp;
  CHECK(catchUp.Update(10.0, 9.7));
  CHECK(catchUp.Skips(10.0, 10.2));
  // A pause of the host of 20 s a minute later: the player runs dry, but the packets after it come in real time, so
  // none finds more than the target waiting, and the second ends without a raise
  CHECK(catchUp.Update(90.0, 70.0));
  for (int i = 0; i < 200; i++) {
    const double now = 90.0 + i * 0.005;
    catchUp.Update(now, now + 0.005);
    CHECK(!catchUp.Skips(now, now + 0.005));
  }
  CHECK(!catchUp.Update(91.0, 91.005));
  CHECK_EQ(catchUp.target, kAudioCatchUpTargetSeconds);
  CHECK_EQ(catchUp.raise, 0.0);
  // A stall more than 2 minutes after the last packet that found more than the target waiting: like the first one
  CHECK(catchUp.Update(10.0 + kAudioCatchUpRepeatSeconds + 0.1, 10.0 + kAudioCatchUpRepeatSeconds - 0.1));
  CHECK_EQ(kAudioCatchUpRepeatSeconds, 120.0);
  CHECK(catchUp.Skips(130.1, 130.205));
  CHECK_EQ(catchUp.target, kAudioCatchUpTargetSeconds);
  CHECK_EQ(catchUp.raises, 0u);
  CHECK_EQ(catchUp.stalls, 2u);
  // A raise that is due expires with its catch-up when no packet of it went beyond the target
  CHECK(catchUp.Update(140.0, 139.9));
  CHECK(catchUp.raise > 0.0);
  CHECK(!catchUp.Update(141.0, 141.005));
  CHECK_EQ(catchUp.raise, 0.0);
}

static void ResetClearsEverything() {
  AudioCatchUp catchUp;
  catchUp.Update(1.0, 0.5);
  CHECK(catchUp.Skips(1.0, 1.2));
  catchUp.Update(2.0, 1.9);
  CHECK(!catchUp.Skips(2.0, 2.15));
  CHECK(catchUp.target > kAudioCatchUpTargetSeconds);
  catchUp.Reset();
  CHECK(!catchUp.running);
  CHECK(!catchUp.skipping);
  CHECK_EQ(catchUp.until, 0.0);
  CHECK_EQ(catchUp.target, kAudioCatchUpTargetSeconds);
  CHECK_EQ(catchUp.raise, 0.0);
  CHECK_EQ(catchUp.lastOverTarget, -1.0);
  CHECK_EQ(catchUp.stalls, 0u);
  CHECK_EQ(catchUp.skipped, 0u);
  CHECK_EQ(catchUp.raises, 0u);
  // The next stream starts from its first packet again, and its first stall raises nothing
  CHECK(!catchUp.Update(0.0, 0.0));
  catchUp.Update(0.2, 0.1);
  CHECK(catchUp.Skips(0.2, 0.35));
  CHECK_EQ(catchUp.stalls, 1u);
  CHECK_EQ(catchUp.target, kAudioCatchUpTargetSeconds);
}

int main() {
  test_support::RunTest("the first packet of a stream, and packets in time, start no catch-up", TheFirstPacketStartsNothing);
  test_support::RunTest("a packet after the end of the appended sound starts a catch-up of 1 second",
                        ADryOutStartsOneSecond);
  test_support::RunTest("another dry-out within the catch-up starts it again from that packet", AnotherDryOutStartsItAgain);
  test_support::RunTest("while the catch-up runs, a packet is skipped while more than its target of 100 ms waits",
                        PacketsBeyondTheTargetAreSkippedWhileItRuns);
  test_support::RunTest("the skipped packets count one stall per catch-up that skipped", SkippedPacketsCountOneStallPerCatchUp);
  test_support::RunTest("a stall that comes again within 2 minutes raises the target by the time the player ran dry, "
                        "up to 300 ms", AStallThatComesAgainRaisesTheTarget);
  test_support::RunTest("a pause of the host, and a stall more than 2 minutes later, raise nothing",
                        APauseOfTheHostOrALaterStallRaisesNothing);
  test_support::RunTest("Reset() clears the catch-up, its counts and its target", ResetClearsEverything);
  return test_support::Summary();
}
