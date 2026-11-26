#pragma once
// After a stall: when a packet of the stream reaches the TV media player (EMSS) after the sound appended so far has
// already ended, the player ran dry (e.g. the Wi-Fi stalled for a moment), and the packets that queued up on the way
// arrive right after it, back to back. Each of them adds its duration to the sound that waits in the player, so without
// a limit the sound stays behind the picture by the length of the stall for the rest of the stream (the lead of
// audio_lead.hpp), and several stalls add up. moonlight-qt bounds its queue the same way (it drops sound while more
// than 30 ms wait). For kAudioCatchUpSeconds after such a packet, auddec.cpp skips each packet while more than
// kAudioBufferMargin (100 ms) of sound waits in the player, whatever 'Limit audio delay' says, which applies that limit
// at all times (also to the slow drift of the clock of the PC). Sound that arrives in real time never waits that long,
// so only the backlog of a stall is skipped. The first packet of a stream starts nothing: the player was never fed.
// Only the audio thread uses it, after AudDecInit() and before AudDecCleanup(), like the tracker of audio_lead.hpp. The
// header has no other dependencies, so the native tests can check it on its own (tests/native/audio_catch_up_test.cpp).

#include <cstdint>

constexpr double kAudioCatchUpSeconds = 1.0;

struct AudioCatchUp {
  double until = 0.0;  // the catch-up runs until then, in seconds since the first packet
  bool running = false;
  bool skipping = false;  // a packet of this catch-up was skipped
  uint32_t stalls = 0;  // the catch-ups that skipped sound
  uint32_t skipped = 0;  // the packets they skipped

  void Reset() {
    until = 0.0;
    running = false;
    skipping = false;
    stalls = 0;
    skipped = 0;
  }

  // A packet at nowSeconds, while the sound appended so far ends at endSeconds (0 before the first one): returns
  // whether the catch-up runs for it
  bool Update(double nowSeconds, double endSeconds) {
    if (endSeconds > 0.0 && endSeconds < nowSeconds) {
      until = nowSeconds + kAudioCatchUpSeconds;
      running = true;
      skipping = false;
    } else if (running && nowSeconds >= until) {
      running = false;
    }
    return running;
  }

  // The catch-up skipped a packet: one more stall for its first one
  void CountSkipped() {
    if (!skipping) {
      skipping = true;
      stalls++;
    }
    skipped++;
  }
};
