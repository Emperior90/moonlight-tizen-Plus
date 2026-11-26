#pragma once
// How far the sound of a stream with the TV media player (EMSS) runs ahead of the clock of the TV, and how fast that
// changes over a long session. This only measures; nothing is corrected. A PC whose clock runs a little faster than the
// one of the TV sends more sound per second than the TV's clock counts, so more and more of it waits in the player and
// the sound falls behind the picture: moonlight-qt PR #2101 measured 25 to 92 ms over 75 minutes (+53 ms per hour at a
// clock mismatch of 15 ppm), moonlight-tv issue #516 80 to 130 ms over 30 minutes on an LG C2. 'Limit audio delay'
// (off by default) caps the lead at 100 ms by skipping sound (auddec.cpp), and since 2.3.5 the catch-up after a stall
// does the same for the sound that piled up during it, whatever the switch says (audio_catch_up.hpp); but nothing told
// how far it runs ahead.
//
// auddec.cpp hands every packet that reaches the EMSS path to AudioLeadTracker::AddPacket() on the audio thread: the
// time since the first packet on the monotonic clock of the TV, and the lead after it, i.e. how far the end of the
// sound appended so far runs ahead of that time (s_estimatedAudioEnd minus the time). Nothing here is shared between
// threads: Reset() runs before the audio thread of a stream starts and Finish() after it ended, so the hot path takes
// no lock and costs a few additions and comparisons per packet. Two figures come out of it:
// - The lead, as averages over windows of 10 s: in the first window after the first minute, in the last window and in
//   the highest one. This is what the code of the app believes waits in the player. It follows the rule of auddec.cpp:
//   after a gap that empties the player it starts again from the packet after the gap, and a late packet followed by
//   the packets that queued up behind it raises it by the time the player ran dry, up to 100 ms (audio_catch_up.hpp).
// - The drift in milliseconds per hour, from the sound that arrived against the clock of the TV: the packets so far
//   times their duration (the clock of the PC, which sends one packet per packet duration) minus the time (the clock of
//   the TV). Network delay only ever lowers this offset, so each window keeps its highest value, which comes from the
//   packets that arrived the fastest, and delay that comes and goes doesn't move it. The fit is the median of the
//   slopes between points of the same stretch that lie kAudioDriftPairSeconds apart, so a single step, an odd window or
//   a gap changes only a few of the slopes. The lead is not fitted itself, since every late packet steps it up.
//
// What it sees, and what not: it compares the arrival of the sound with the system clock of the TV. So it shows a PC
// whose clock runs faster than the TV's (a positive drift) or slower (a negative one; the lead doesn't show that, as
// the player then runs short instead of filling up). It can't see a drift between the system clock of the TV and its
// sound output (its loudspeakers, or a soundbar over eARC), which plays the sound on a clock of its own, nor the delay
// that the player, the TV or a soundbar add.
//
// The start of a stream (kAudioLeadSettleSeconds) is not measured: the player starts, the host may send what it had
// queued, and the first late packets of the network raise the lead. A pause of more than kAudioLeadGapSeconds between
// two packets is a gap: the PC paused its sound (a host that leaves out silence) or the network stalled. It ends a
// stretch of the drift, since the offset after a pause of the PC is lower by the length of the pause, and the next
// kAudioLeadGapSettleSeconds aren't measured either. A drift needs kAudioDriftMinSeconds of measured sound and
// kAudioDriftMinPairs slopes; a shorter session has none. The header has no other dependencies, so the native tests
// can check it on its own (tests/native/audio_lead_test.cpp).

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdio>

constexpr double kAudioLeadSettleSeconds = 60.0;
// With continuous audio, a packet comes every 5 or 10 ms, and the audio queue of moonlight-common-c waits at most about
// 50 ms for a lost packet before it hands over the next ones (RtpAudioQueue.c), so a longer pause is a gap
constexpr double kAudioLeadGapSeconds = 0.1;
constexpr double kAudioLeadGapSettleSeconds = 10.0;
constexpr double kAudioLeadWindowSeconds = 10.0;
constexpr double kAudioDriftPairSeconds = 300.0;
constexpr double kAudioDriftMinSeconds = 600.0;
constexpr uint32_t kAudioDriftMinPairs = 10;
// The windows kept for the fit: 2 hours of windows of 10 s. A longer session keeps every second one of them and makes
// its windows twice as long from then on, so any length fits.
constexpr size_t kAudioLeadMaxPoints = 720;
// The largest drift that the figures carry, in milliseconds per hour (a clock that is 0.03 % off)
constexpr double kAudioDriftLimitMsPerHour = 1000000.0;

// The figures of a stream, as AudioLeadTracker gathered them
struct AudioLeadSummary {
  bool measured = false;  // a window was measured; without one the leads are 0
  double startMs = 0.0;  // the lead in the first window after the first minute
  double endMs = 0.0;  // in the last window
  double maxMs = 0.0;  // in the highest window
  double measuredSeconds = 0.0;  // the time of the sound that was measured
  uint32_t gaps = 0;  // pauses of more than kAudioLeadGapSeconds, also those in the first minute
  bool hasDrift = false;  // enough sound for a drift
  double driftMsPerHour = 0.0;
  uint32_t pairs = 0;  // the slopes of the drift
};

struct AudioLeadTracker {
  // The duration of a packet in seconds, 0 for a stream that is not measured
  double packetSeconds = 0.0;
  uint32_t packets = 0;
  double lastSeconds = 0.0;
  double settleUntil = 0.0;
  // Whether the packet before was measured, so that the time from it counts
  bool measuring = false;
  uint32_t stretch = 0;
  double windowSeconds = kAudioLeadWindowSeconds;
  // The open window: its first and last measured packet, the sum of the leads, and the highest offset with its time
  bool windowOpen = false;
  double windowStart = 0.0;
  double windowLast = 0.0;
  uint32_t windowPackets = 0;
  double windowLeadSum = 0.0;
  double windowBestOffset = 0.0;
  double windowBestTime = 0.0;
  AudioLeadSummary summary;
  // The windows for the fit, and the room for its slopes
  size_t points = 0;
  double pointTime[kAudioLeadMaxPoints];
  double pointOffset[kAudioLeadMaxPoints];
  uint32_t pointStretch[kAudioLeadMaxPoints];
  double slopes[kAudioLeadMaxPoints];

  // Start with a new stream whose packets last packetDuration seconds (0: not measured). The arrays keep their old
  // values, which nothing reads beyond points.
  void Reset(double packetDuration) {
    packetSeconds = packetDuration > 0.0 ? packetDuration : 0.0;
    packets = 0;
    lastSeconds = 0.0;
    settleUntil = 0.0;
    measuring = false;
    stretch = 0;
    windowSeconds = kAudioLeadWindowSeconds;
    windowOpen = false;
    windowPackets = 0;
    summary = AudioLeadSummary();
    points = 0;
  }

  // A packet that reached the player, or was meant to (also one that the player rejected, that the decoder failed on
  // or that 'Limit audio delay' skipped: the PC sent its sound all the same), at nowSeconds on the monotonic clock of
  // the TV, with the lead in seconds after it
  void AddPacket(double nowSeconds, double leadSeconds) {
    if (packetSeconds <= 0.0) {
      return;
    }
    packets++;
    if (packets == 1) {
      settleUntil = nowSeconds + kAudioLeadSettleSeconds;
      lastSeconds = nowSeconds;
      return;
    }
    const double interval = nowSeconds - lastSeconds;
    lastSeconds = nowSeconds;
    if (interval > kAudioLeadGapSeconds) {
      // A pause in the sound ends the stretch and its window, and the next stretch starts once it settled
      CloseWindow();
      summary.gaps++;
      stretch++;
      measuring = false;
      settleUntil = std::max(settleUntil, nowSeconds + kAudioLeadGapSettleSeconds);
      return;
    }
    if (nowSeconds < settleUntil) {
      return;
    }
    // The sound that the PC sent, on its own clock, minus the time of the TV
    const double offset = packets * packetSeconds - nowSeconds;
    if (measuring) {
      summary.measuredSeconds += interval;
    }
    measuring = true;
    if (!windowOpen) {
      windowOpen = true;
      windowStart = nowSeconds;
      windowPackets = 0;
      windowLeadSum = 0.0;
      windowBestOffset = offset;
      windowBestTime = nowSeconds;
    }
    windowLast = nowSeconds;
    windowPackets++;
    windowLeadSum += leadSeconds > 0.0 ? leadSeconds : 0.0;
    if (offset > windowBestOffset) {
      windowBestOffset = offset;
      windowBestTime = nowSeconds;
    }
    if (nowSeconds - windowStart >= windowSeconds) {
      CloseWindow();
    }
  }

  // The figures of the stream, once it ended: the window that is still open counts if it covers half a window
  AudioLeadSummary Finish() {
    CloseWindow();
    summary.pairs = 0;
    size_t later = 0;
    for (size_t i = 0; i < points; i++) {
      if (later <= i) {
        later = i + 1;
      }
      while (later < points && pointStretch[later] == pointStretch[i] &&
             pointTime[later] - pointTime[i] < kAudioDriftPairSeconds) {
        later++;
      }
      if (later >= points) {
        break;
      }
      if (pointStretch[later] == pointStretch[i]) {
        slopes[summary.pairs++] = (pointOffset[later] - pointOffset[i]) / (pointTime[later] - pointTime[i]);
      }
    }
    summary.hasDrift = summary.measuredSeconds >= kAudioDriftMinSeconds && summary.pairs >= kAudioDriftMinPairs;
    summary.driftMsPerHour = 0.0;
    if (summary.hasDrift) {
      const size_t middle = summary.pairs / 2;
      std::nth_element(slopes, slopes + middle, slopes + summary.pairs);
      double median = slopes[middle];
      if (summary.pairs % 2 == 0) {
        median = (median + *std::max_element(slopes, slopes + middle)) / 2.0;
      }
      summary.driftMsPerHour = std::max(-kAudioDriftLimitMsPerHour,
        std::min(kAudioDriftLimitMsPerHour, median * 3600.0 * 1000.0));
    }
    return summary;
  }

 private:
  void CloseWindow() {
    if (!windowOpen) {
      return;
    }
    windowOpen = false;
    if (windowPackets == 0 || windowLast - windowStart < windowSeconds / 2.0) {
      return;
    }
    const double leadMs = windowLeadSum / windowPackets * 1000.0;
    if (!summary.measured) {
      summary.measured = true;
      summary.startMs = leadMs;
      summary.maxMs = leadMs;
    }
    summary.endMs = leadMs;
    summary.maxMs = std::max(summary.maxMs, leadMs);
    if (points == kAudioLeadMaxPoints) {
      // Keep every second window, and make the windows twice as long from now on
      for (size_t i = 0; 2 * i < points; i++) {
        pointTime[i] = pointTime[2 * i];
        pointOffset[i] = pointOffset[2 * i];
        pointStretch[i] = pointStretch[2 * i];
      }
      points = (points + 1) / 2;
      windowSeconds *= 2.0;
    }
    pointTime[points] = windowBestTime;
    pointOffset[points] = windowBestOffset;
    pointStretch[points] = stretch;
    points++;
  }
};

// The line of the diagnostic log at the end of a stream, e.g.
//   Audio lead of the stream (sound received ahead of the TV clock, 10 s averages): 24 ms after the first minute,
//   92 ms at the end, 95 ms at most; drift +53 ms per hour from 74.0 min of sound, 1 gap
// without a drift: '...; no drift, it needs 10 min of sound (9.0 min, 0 gaps)', and for a stream that ended before
// a window was measured: 'Audio lead of the stream: not measured, too little sound after the first minute (0 gaps)'.
// The line fits a line of the diagnostic log (240 bytes, diagnostic_log.hpp). Returns the number of characters
// written, or -1 if the output is too short.
inline int FormatAudioLeadLog(const AudioLeadSummary& summary, char* output, size_t length) {
  int written;
  if (!summary.measured) {
    written = snprintf(output, length, "Audio lead of the stream: not measured, too little sound after the first "
      "minute (%u gaps)\n", summary.gaps);
  } else if (summary.hasDrift) {
    written = snprintf(output, length, "Audio lead of the stream (sound received ahead of the TV clock, %u s "
      "averages): %.0f ms after the first minute, %.0f ms at the end, %.0f ms at most; drift %+.0f ms per hour from "
      "%.1f min of sound, %u gaps\n", (unsigned)kAudioLeadWindowSeconds, summary.startMs, summary.endMs,
      summary.maxMs, summary.driftMsPerHour, summary.measuredSeconds / 60.0, summary.gaps);
  } else {
    written = snprintf(output, length, "Audio lead of the stream (sound received ahead of the TV clock, %u s "
      "averages): %.0f ms after the first minute, %.0f ms at the end, %.0f ms at most; no drift, it needs %u min of "
      "sound (%.1f min, %u gaps)\n", (unsigned)kAudioLeadWindowSeconds, summary.startMs, summary.endMs, summary.maxMs,
      (unsigned)(kAudioDriftMinSeconds / 60.0), summary.measuredSeconds / 60.0, summary.gaps);
  }
  return written < 0 || (size_t)written >= length ? -1 : written;
}
