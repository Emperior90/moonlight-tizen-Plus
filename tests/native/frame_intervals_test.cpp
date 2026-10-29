// Checks the regularity of the frame intervals in the full performance statistics (wasm/frame_intervals.hpp): the
// intervals of the host from its capture times per frame number, the intervals at which the frames reach the video
// player, the standard deviation, the 95th percentile and the share off the cadence over two stats windows, the restarts
// after a pause or a step back, the fixed size of a window, and the line of the overlay.

#include "frame_intervals.hpp"
#include "test_support.h"

#include <cmath>
#include <string>
#include <vector>

static constexpr uint32_t kFrame60Us = 16666;

static bool Near(double actual, double expected, double tolerance) {
  return std::fabs(actual - expected) <= tolerance;
}

static std::string Line(const char* label, const FrameIntervalSummary& summary) {
  char output[160];
  const int written = FormatFrameIntervalLine(label, summary, output, sizeof(output));
  if (written < 0) {
    return "<too short>";
  }
  CHECK_EQ((size_t)written, std::string(output).size());
  return std::string(output);
}

static FrameIntervalWindow Window(const std::vector<uint32_t>& intervalsUs) {
  FrameIntervalWindow window = {};
  for (uint32_t interval : intervalsUs) {
    AddFrameInterval(window, interval);
  }
  return window;
}

static void SteadyHostAt60FpsWithMillisecondTimestamps() {
  // The capture times come in whole milliseconds, so a perfect 60 FPS host alternates 16 and 17 ms (16.667 on average)
  FrameIntervalClock clock = {};
  FrameIntervalWindow window = {};
  for (int frame = 1; frame <= 61; frame++) {
    RecordHostFrameInterval(clock, window, 5000 + (uint32_t)(frame * 1000 / 60), frame);
  }
  CHECK_EQ(window.count, 60);
  const FrameIntervalWindow empty = {};
  const FrameIntervalSummary summary = SummarizeFrameIntervals(empty, window, kFrame60Us);
  CHECK_EQ(summary.count, 60);
  CHECK(Near(summary.deviationMs, 0.471, 0.001));
  CHECK(Near(summary.p95Ms, 17.0, 1e-9));
  CHECK(Near(summary.offCadencePercent, 0.0, 1e-9));
  CHECK_EQ(Line("Host", summary), std::string("Host frame intervals: deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence\n"));
}

static void HostIntervalsArePerFrameNumber() {
  // A frame lost on the network (or sent again without a new image and left out) between two captured frames is no gap
  // of the host: the 33 ms between frames 10 and 12 are two intervals of 16.5 ms
  FrameIntervalClock clock = {};
  FrameIntervalWindow window = {};
  RecordHostFrameInterval(clock, window, 1000, 10);
  RecordHostFrameInterval(clock, window, 1033, 12);
  CHECK_EQ(window.count, 1);
  CHECK_EQ(window.intervalsUs[0], 16500u);
  // A stall of the host itself (the next frame number 50 ms later) is one long interval
  RecordHostFrameInterval(clock, window, 1083, 13);
  CHECK_EQ(window.count, 2);
  CHECK_EQ(window.intervalsUs[1], 50000u);
  const FrameIntervalWindow empty = {};
  CHECK(Near(SummarizeFrameIntervals(empty, window, kFrame60Us).offCadencePercent, 50.0, 1e-9));
}

static void RestartsWithoutAnInterval() {
  FrameIntervalClock clock = {};
  FrameIntervalWindow window = {};
  // The first frame has nothing to compare with
  RecordHostFrameInterval(clock, window, 47721000, 100);
  CHECK_EQ(window.count, 0);
  // The 90 kHz RTP timestamp wrapped (the time steps back): no interval, and the next one is measured from here
  RecordHostFrameInterval(clock, window, 5, 101);
  CHECK_EQ(window.count, 0);
  RecordHostFrameInterval(clock, window, 22, 102);
  CHECK_EQ(window.count, 1);
  CHECK_EQ(window.intervalsUs[0], 17000u);
  // A pause of more than a second (e.g. while the app was hidden) is no interval
  RecordHostFrameInterval(clock, window, 1023, 103);
  CHECK_EQ(window.count, 1);
  // A step back of the frame number (a host reset) or the same frame number again is no interval either
  RecordHostFrameInterval(clock, window, 1040, 90);
  RecordHostFrameInterval(clock, window, 1057, 90);
  CHECK_EQ(window.count, 1);
  RecordHostFrameInterval(clock, window, 1074, 91);
  CHECK_EQ(window.count, 2);
  // Exactly one second is still an interval
  RecordHostFrameInterval(clock, window, 2074, 92);
  CHECK_EQ(window.count, 3);
  CHECK_EQ(window.intervalsUs[2], 1000000u);
  // A new stream starts without a previous frame
  ResetFrameIntervalClock(clock);
  RecordHostFrameInterval(clock, window, 2091, 93);
  CHECK_EQ(window.count, 3);
}

static void PlayerIntervalsCountEachFrame() {
  // The player gets a frame every 16.666 ms, then misses one (lost on the network or rejected): that shows as one
  // interval of two frames, since the player had nothing new for that time
  FrameIntervalClock clock = {};
  FrameIntervalWindow window = {};
  uint64_t nowUs = 7000000;
  RecordPlayerFrameInterval(clock, window, nowUs);
  for (int i = 0; i < 9; i++) {
    nowUs += kFrame60Us;
    RecordPlayerFrameInterval(clock, window, nowUs);
  }
  nowUs += 2 * kFrame60Us;
  RecordPlayerFrameInterval(clock, window, nowUs);
  CHECK_EQ(window.count, 10);
  CHECK_EQ(window.intervalsUs[8], kFrame60Us);
  CHECK_EQ(window.intervalsUs[9], 2 * kFrame60Us);
  const FrameIntervalWindow empty = {};
  const FrameIntervalSummary summary = SummarizeFrameIntervals(empty, window, kFrame60Us);
  CHECK(Near(summary.offCadencePercent, 10.0, 1e-9));
  CHECK(Near(summary.p95Ms, 33.332, 1e-9));
  // A pause over a second (the video track was closed) and a clock that steps back give no interval
  RecordPlayerFrameInterval(clock, window, nowUs + 1500000);
  RecordPlayerFrameInterval(clock, window, nowUs);
  CHECK_EQ(window.count, 10);
  RecordPlayerFrameInterval(clock, window, nowUs + 17000);
  CHECK_EQ(window.count, 11);
  CHECK_EQ(window.intervalsUs[10], 17000u);
}

static void DeviationPercentileAndCadence() {
  // Standard deviation of the population: 10 and 20 ms average 15 ms, 5 ms off each
  const FrameIntervalWindow empty = {};
  FrameIntervalSummary summary = SummarizeFrameIntervals(empty, Window({10000, 20000}), 15000);
  CHECK(Near(summary.deviationMs, 5.0, 1e-9));
  // 95th percentile by nearest rank: of 1..100 ms the 95th value, of 1..20 ms the 19th, of 1..10 ms the 10th
  std::vector<uint32_t> hundred;
  for (uint32_t ms = 100; ms >= 1; ms--) {
    hundred.push_back(ms * 1000);
  }
  const FrameIntervalWindow first = Window(std::vector<uint32_t>(hundred.begin(), hundred.begin() + 50));
  const FrameIntervalWindow second = Window(std::vector<uint32_t>(hundred.begin() + 50, hundred.end()));
  CHECK(Near(SummarizeFrameIntervals(first, second, 50000).p95Ms, 95.0, 1e-9));
  std::vector<uint32_t> twenty;
  for (uint32_t ms = 1; ms <= 20; ms++) {
    twenty.push_back(ms * 1000);
  }
  CHECK(Near(SummarizeFrameIntervals(empty, Window(twenty), 10000).p95Ms, 19.0, 1e-9));
  CHECK(Near(SummarizeFrameIntervals(Window({1000, 2000, 3000, 4000, 5000}), Window({6000, 7000, 8000, 9000, 10000}), 5000).p95Ms,
             10.0, 1e-9));
  // Off the cadence means more than a quarter of the frame duration off it, in either direction
  summary = SummarizeFrameIntervals(empty, Window({20000, 20001, 12000, 11999, 16000}), 16000);
  CHECK_EQ(summary.count, 5);
  CHECK(Near(summary.offCadencePercent, 40.0, 1e-9));
  // Nothing to summarize
  summary = SummarizeFrameIntervals(empty, empty, kFrame60Us);
  CHECK_EQ(summary.count, 0);
  CHECK(Near(summary.deviationMs, 0.0, 1e-12) && Near(summary.p95Ms, 0.0, 1e-12) && Near(summary.offCadencePercent, 0.0, 1e-12));
}

static void TwoWindowsAndTheFixedSize() {
  // A window keeps its first kFrameIntervalWindowSize intervals, and the summary covers both windows
  FrameIntervalWindow full = {};
  for (int i = 0; i < kFrameIntervalWindowSize + 44; i++) {
    AddFrameInterval(full, kFrame60Us);
  }
  CHECK_EQ(full.count, kFrameIntervalWindowSize);
  const FrameIntervalSummary summary = SummarizeFrameIntervals(full, full, kFrame60Us);
  CHECK_EQ(summary.count, 2 * kFrameIntervalWindowSize);
  CHECK(Near(summary.deviationMs, 0.0, 1e-9));
  // A window that starts over drops its intervals
  ResetFrameIntervals(full);
  CHECK_EQ(full.count, 0);
  CHECK_EQ(SummarizeFrameIntervals(full, Window({kFrame60Us}), kFrame60Us).count, 1);
}

static void LineOfTheOverlay() {
  FrameIntervalSummary summary = {};
  summary.count = 120;
  summary.deviationMs = 1.234;
  summary.p95Ms = 18.26;
  summary.offCadencePercent = 2.5;
  CHECK_EQ(Line("TV player", summary),
           std::string("TV player frame intervals: deviation 1.23 ms, p95 18.3 ms, 2.5% off cadence\n"));
  // Nothing to compare with fewer than two intervals
  summary.count = 1;
  CHECK_EQ(Line("Host", summary), std::string(""));
  // An output that is too short
  summary.count = 2;
  std::vector<char> shortOutput(20, 'x');
  CHECK_EQ(FormatFrameIntervalLine("Host", summary, shortOutput.data(), shortOutput.size()), -1);
  CHECK_EQ(std::string(shortOutput.data()), std::string(""));
}

int main() {
  test_support::RunTest("a steady 60 FPS host with timestamps in whole milliseconds", SteadyHostAt60FpsWithMillisecondTimestamps);
  test_support::RunTest("the host intervals are per frame number", HostIntervalsArePerFrameNumber);
  test_support::RunTest("a step back, a pause or a reset starts over without an interval", RestartsWithoutAnInterval);
  test_support::RunTest("the player intervals count each frame that reached the player", PlayerIntervalsCountEachFrame);
  test_support::RunTest("standard deviation, 95th percentile and the share off the cadence", DeviationPercentileAndCadence);
  test_support::RunTest("two windows and the fixed size of a window", TwoWindowsAndTheFixedSize);
  test_support::RunTest("the line of the overlay", LineOfTheOverlay);
  return test_support::Summary();
}
