#pragma once
// Regularity of the frame intervals for the full performance statistics: how evenly the frames leave the host (from the
// capture time the host sends with each frame) and how evenly they reach the video player of the TV (when AppendPacket()
// takes them in wasm/wasmplayer.cpp). For each, the standard deviation and the 95th percentile of the intervals in the
// last two stats windows (about two seconds, like the other lines of the overlay), and the share of the intervals that
// are more than a quarter of a frame off the frame duration of the stream. Side by side they show where a stutter
// starts: an uneven host line points to the PC, an even host line with an uneven player line to the network or the TV.
// The idea and the two measuring points come from the fork of samirmartins (moonlight-tizen, ad7f60e and 0ab499b: the
// host interval per frame number and RecordAppendCadence() in wasmplayer.cpp, the 95th percentile over a fixed array of
// samples in video_telemetry.hpp).
//
// Only the video decoder thread records the intervals and formats the lines, so nothing here takes a lock: recording an
// interval stores one number into a fixed array, and the summary sorts at most two windows once per second, only while
// the full statistics show. The header has no other dependencies, so the native tests can check it on its own
// (tests/native/frame_intervals_test.cpp).

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <initializer_list>

// Room for the intervals of one stats window (a little over a second), enough for 240 FPS. Intervals beyond it are not
// recorded, so a summary covers the first ones of an overfull window.
constexpr int kFrameIntervalWindowSize = 256;

// A longer interval is a pause of the stream (e.g. while the app was hidden) or a restart of the host, not a frame
// interval, and the next interval is measured from the frame after it
constexpr uint64_t kMaxFrameIntervalUs = 1000000;

// The intervals of one stats window, in microseconds
struct FrameIntervalWindow {
  int count;
  uint32_t intervalsUs[kFrameIntervalWindowSize];
};

// The previous frame of one source of frames: its time and its frame number
struct FrameIntervalClock {
  bool started;
  uint64_t lastUs;
  int lastFrameNumber;
};

// The regularity of the intervals of two windows
struct FrameIntervalSummary {
  // Intervals summarized
  int count;
  // Population standard deviation and 95th percentile (nearest rank) of the intervals, in milliseconds
  double deviationMs;
  double p95Ms;
  // Share of the intervals that are more than a quarter of the frame duration shorter or longer than it
  double offCadencePercent;
};

inline void ResetFrameIntervals(FrameIntervalWindow& window) {
  window.count = 0;
}

inline void ResetFrameIntervalClock(FrameIntervalClock& clock) {
  clock.started = false;
  clock.lastUs = 0;
  clock.lastFrameNumber = 0;
}

inline void AddFrameInterval(FrameIntervalWindow& window, uint32_t intervalUs) {
  if (window.count < kFrameIntervalWindowSize) {
    window.intervalsUs[window.count++] = intervalUs;
  }
}

// Record the interval from the previous frame of a source to this one, divided by the frame numbers between them. A frame
// that goes back in time or in its frame number, or comes more than a second after the previous one, starts over
// without an interval.
inline void RecordFrameInterval(FrameIntervalClock& clock, FrameIntervalWindow& window, uint64_t timeUs, int frameNumber) {
  if (clock.started && timeUs >= clock.lastUs && timeUs - clock.lastUs <= kMaxFrameIntervalUs) {
    const int frames = frameNumber - clock.lastFrameNumber;
    if (frames > 0) {
      AddFrameInterval(window, (uint32_t)((timeUs - clock.lastUs) / (uint64_t)frames));
    }
  }
  clock.started = true;
  clock.lastUs = timeUs;
  clock.lastFrameNumber = frameNumber;
}

// Record a frame of the host from its capture time in milliseconds (the presentation time of the decode unit), per frame
// number: frames lost on the network, and frames the host sent again without a new image (which carry a send time and
// are not recorded), don't count as a gap of the host. The time steps back when the 90 kHz RTP timestamp wraps after
// about 13 hours, which starts over.
inline void RecordHostFrameInterval(FrameIntervalClock& clock, FrameIntervalWindow& window, uint32_t captureMs, int frameNumber) {
  RecordFrameInterval(clock, window, (uint64_t)captureMs * 1000, frameNumber);
}

// Record a frame that the video player of the TV took, at the time it took it. Each frame counts as one interval, so a
// frame that never reached the player (lost on the network or rejected by the player) shows as a long interval: the
// player had no new frame for that time.
inline void RecordPlayerFrameInterval(FrameIntervalClock& clock, FrameIntervalWindow& window, uint64_t nowUs) {
  clock.lastFrameNumber = 0;
  RecordFrameInterval(clock, window, nowUs, 1);
}

// Summarize the intervals of the previous and the current window against the frame duration of the stream
inline FrameIntervalSummary SummarizeFrameIntervals(const FrameIntervalWindow& previous, const FrameIntervalWindow& current,
                                                    uint32_t frameUs) {
  FrameIntervalSummary summary = {};
  uint32_t values[2 * kFrameIntervalWindowSize];
  int count = 0;
  for (const FrameIntervalWindow* window : {&previous, &current}) {
    const int windowCount = std::min(std::max(window->count, 0), kFrameIntervalWindowSize);
    std::copy(window->intervalsUs, window->intervalsUs + windowCount, values + count);
    count += windowCount;
  }
  summary.count = count;
  if (count == 0) {
    return summary;
  }

  double sum = 0.0;
  int offCadence = 0;
  for (int i = 0; i < count; i++) {
    sum += values[i];
    // More than a quarter of the frame duration off it, compared without rounding
    const uint64_t difference = values[i] > frameUs ? values[i] - frameUs : frameUs - values[i];
    if (difference * 4 > frameUs) {
      offCadence++;
    }
  }
  const double mean = sum / count;
  double squares = 0.0;
  for (int i = 0; i < count; i++) {
    squares += (values[i] - mean) * (values[i] - mean);
  }

  // Nearest rank: the smallest value that at least 95 % of the intervals don't exceed
  const int rank = (count * 95 + 99) / 100 - 1;
  std::nth_element(values, values + rank, values + count);

  summary.deviationMs = std::sqrt(squares / count) / 1000.0;
  summary.p95Ms = values[rank] / 1000.0;
  summary.offCadencePercent = offCadence * 100.0 / count;
  return summary;
}

// Write a line of the overlay for a summary, e.g.
//   Host frame intervals: deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence
// handleMessage() in wasm/platform/messages.js translates it. Returns the number of characters written, 0 for fewer
// than two intervals (nothing to compare), or -1 if the output is too short.
inline int FormatFrameIntervalLine(const char* label, const FrameIntervalSummary& summary, char* output, size_t length) {
  if (length == 0) {
    return -1;
  }
  output[0] = 0;
  if (summary.count < 2) {
    return 0;
  }
  const int ret = snprintf(output, length, "%s frame intervals: deviation %.2f ms, p95 %.1f ms, %.1f%% off cadence\n",
                           label, summary.deviationMs, summary.p95Ms, summary.offCadencePercent);
  if (ret < 0 || (size_t)ret >= length) {
    output[0] = 0;
    return -1;
  }
  return ret;
}
