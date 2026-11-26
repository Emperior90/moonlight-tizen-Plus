#pragma once
// After a stall: when a packet of the stream reaches the TV media player (EMSS) after the sound appended so far has
// already ended, the player ran dry (e.g. the Wi-Fi stalled for a moment), and the packets that queued up on the way
// arrive right after it, back to back. Each of them adds its duration to the sound that waits in the player, so without
// a limit the sound stays behind the picture by the length of the stall for the rest of the stream (the lead of
// audio_lead.hpp), and several stalls add up. moonlight-qt bounds its queue the same way (it drops sound while more
// than 30 ms wait). For kAudioCatchUpSeconds after such a packet, auddec.cpp skips each packet while more than the
// target of the catch-up waits in the player, whatever 'Limit audio delay' says (which applies its 100 ms,
// kAudioBufferMargin, at all times, also to the slow drift of the clock of the PC). Sound that arrives in real time
// never waits that long, so only the backlog of a stall is skipped. The first packet of a stream starts nothing: the
// player was never fed.
//
// The target starts at kAudioCatchUpTargetSeconds (the 100 ms of 'Limit audio delay'), so a single stall leaves the
// sound at most that far behind. Right after a trim the player holds about the target, so a stall that comes again and
// is longer than that empties it again: with a fixed target, a network that stalls for 150 ms every 30 s would give a
// gap and a skip at every stall, where the sound without the catch-up (2.3.4) had one gap and then a lead that absorbed
// the next stalls. So when the player runs dry again within kAudioCatchUpRepeatSeconds of the last packet that found
// more than the target waiting, and the backlog of that stall goes beyond the target as well, the target first rises
// by the time the player ran dry, up to kAudioCatchUpMaxTargetSeconds: the sound then keeps about the length of the
// stalls that come again, as before 2.3.5 but bounded. A pause of the host (a silent desktop) also empties the player,
// but the packets after it come in real time, so it neither skips nor raises anything. The target stays raised for the
// rest of the stream; the next stream starts again at kAudioCatchUpTargetSeconds.
//
// Only the audio thread uses it, after AudDecInit() and before AudDecCleanup(), like the tracker of audio_lead.hpp. The
// header has no other dependencies, so the native tests can check it on its own (tests/native/audio_catch_up_test.cpp).

#include <cstdint>

constexpr double kAudioCatchUpSeconds = 1.0;
// The target at the start of a stream, the kAudioBufferMargin of auddec.cpp (tests/unit/audio-lead.test.js pins both)
constexpr double kAudioCatchUpTargetSeconds = 0.1;
constexpr double kAudioCatchUpRepeatSeconds = 120.0;
constexpr double kAudioCatchUpMaxTargetSeconds = 0.3;

struct AudioCatchUp {
  double until = 0.0;  // the catch-up runs until then, in seconds since the first packet
  double target = kAudioCatchUpTargetSeconds;  // the sound that a catch-up keeps in the player, in seconds
  double raise = 0.0;  // what the backlog of this catch-up raises the target by, if it goes beyond it
  double lastOverTarget = -1.0;  // when a packet of a catch-up last found more than the target waiting, -1 for never
  bool running = false;
  bool skipping = false;  // a packet of this catch-up was skipped
  uint32_t stalls = 0;  // the catch-ups that skipped sound
  uint32_t skipped = 0;  // the packets they skipped
  uint32_t raises = 0;  // the times the target rose

  void Reset() {
    until = 0.0;
    target = kAudioCatchUpTargetSeconds;
    raise = 0.0;
    lastOverTarget = -1.0;
    running = false;
    skipping = false;
    stalls = 0;
    skipped = 0;
    raises = 0;
  }

  // A packet at nowSeconds, while the sound appended so far ends at endSeconds (0 before the first one): returns
  // whether the catch-up runs for it
  bool Update(double nowSeconds, double endSeconds) {
    if (endSeconds > 0.0 && endSeconds < nowSeconds) {
      until = nowSeconds + kAudioCatchUpSeconds;
      running = true;
      skipping = false;
      // The player ran dry again soon after a stall whose backlog went beyond the target
      const bool again = lastOverTarget >= 0.0 && nowSeconds - lastOverTarget <= kAudioCatchUpRepeatSeconds;
      raise = again ? nowSeconds - endSeconds : 0.0;
    } else if (running && nowSeconds >= until) {
      running = false;
      raise = 0.0;
    }
    return running;
  }

  // A packet of the catch-up (Update() returned true) at nowSeconds, while the sound appended so far ends at
  // endSeconds: returns whether it is skipped, because more than the target waits in the player, and counts it then.
  // The first such packet after the player ran dry again (see Update()) raises the target first, and is kept if the
  // raised target holds it. Every skip counts, and the first one of a catch-up counts a stall.
  bool Skips(double nowSeconds, double endSeconds) {
    if (!running || nowSeconds + target >= endSeconds) {
      return false;
    }
    lastOverTarget = nowSeconds;
    if (raise > 0.0 && target < kAudioCatchUpMaxTargetSeconds) {
      target = target + raise < kAudioCatchUpMaxTargetSeconds ? target + raise : kAudioCatchUpMaxTargetSeconds;
      raises++;
    }
    raise = 0.0;
    if (nowSeconds + target >= endSeconds) {
      return false;
    }
    if (!skipping) {
      skipping = true;
      stalls++;
    }
    skipped++;
    return true;
  }
};
