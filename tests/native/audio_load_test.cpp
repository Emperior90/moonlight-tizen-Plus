// Checks the judgement of the load of the audio thread (wasm/audio_load.hpp): the rule of an overload at its limits
// (more than 300 ms of decoding and hand-over per second of audio, over a window of at least 10 seconds of audio), the
// figures of the streams that played fine on the TV the app was tuned on, which must never give a warning (127 to
// 172 ms per second, with single hand-overs of up to 22 ms), the estimated figures of 5.1 and 7.1 in high quality, which
// must, the windows of the monitor with 5 and 10 ms packets, one warning per stream, and the two log lines.
// auddec.cpp feeds the monitor with the totals of its statistics (audio_decoder_test.cpp).

#include "audio_load.hpp"
#include "test_support.h"

#include <string>

// The microseconds of audio in a number of seconds
static uint64_t AudioSeconds(double seconds) {
  return (uint64_t)(seconds * 1000000.0);
}

static void RuleAtItsLimits() {
  // Exactly the limit is no overload, and one microsecond more is
  CHECK(!IsAudioOverloaded(3000000, AudioSeconds(10)));
  CHECK(IsAudioOverloaded(3000001, AudioSeconds(10)));
  CHECK(!IsAudioOverloaded(2999999, AudioSeconds(10)));
  // The limit is per second of audio, whatever the length of the window above 10 seconds
  CHECK(!IsAudioOverloaded(3600000, AudioSeconds(12)));
  CHECK(IsAudioOverloaded(3600001, AudioSeconds(12)));
  // Less than a whole window of audio is never judged, whatever its load
  CHECK(!IsAudioOverloaded(9000000, AudioSeconds(9.999999)));
  CHECK(!IsAudioOverloaded(500000, AudioSeconds(1)));
  CHECK(!IsAudioOverloaded(1000000, 0));
  CHECK(IsAudioOverloaded(9000000, AudioSeconds(10)));
  // No work is no overload
  CHECK(!IsAudioOverloaded(0, AudioSeconds(10)));
  CHECK_EQ(kAudioLoadWindowMs, 10000u);
  CHECK_EQ(kAudioOverloadMsPerSecond, 300u);
}

static void MeasuredAndEstimatedStreams() {
  // Readings of streams whose sound played fine, decoding plus hand-over in ms per second of audio: stereo 127 to 170,
  // 5.1 in normal quality 166 to 172
  for (uint64_t load : {127u, 150u, 166u, 170u, 172u}) {
    CHECK(!IsAudioOverloaded(load * 10000, AudioSeconds(10)));
  }
  // Estimated for 5.1 in high quality (290 to 345) and for 7.1 in high quality (345 to 450), the stream that broke up:
  // the lower end of 5.1 stays below the limit, everything from 301 on is above it
  CHECK(!IsAudioOverloaded(290 * 10000, AudioSeconds(10)));
  for (uint64_t load : {301u, 345u, 400u, 450u}) {
    CHECK(IsAudioOverloaded(load * 10000, AudioSeconds(10)));
  }
  CHECK_EQ(AudioLoadMsPerSecond(1720000, 480000, 48000), 172u);
  CHECK_EQ(AudioLoadMsPerSecond(3454999, 480000, 48000), 345u);
  CHECK_EQ(AudioLoadMsPerSecond(3455000, 480000, 48000), 346u);
  // Without audio there is no load to name
  CHECK_EQ(AudioLoadMsPerSecond(5000, 0, 48000), 0u);
  CHECK_EQ(AudioLoadMsPerSecond(5000, 480, 0), 0u);
}

// A length that is too short for a log line, which the compiler can't see, so that it doesn't warn about the cut
static size_t ShortLength() {
  static volatile size_t length = 60;
  return length;
}

// Feed the monitor with packets of the given audio, each with the given decoding and hand-over time in microseconds,
// on top of the totals so far, and return how often Update() answered true. CHECK_EQ() evaluates its arguments twice,
// so the tests keep the answer of Feed() before they check it.
struct Feeder {
  AudioLoadMonitor monitor;
  uint64_t decodeUs = 0;
  uint64_t outputUs = 0;
  uint64_t samples = 0;

  int Feed(int packets, int samplesPerPacket, uint32_t decode, uint32_t output) {
    int warnings = 0;
    for (int i = 0; i < packets; i++) {
      decodeUs += decode;
      outputUs += output;
      samples += (uint64_t)samplesPerPacket;
      warnings += monitor.Update(decodeUs, outputUs, samples) ? 1 : 0;
    }
    return warnings;
  }
};

static void GoodStreamWithLongHandOversNeverWarns() {
  // 5.1 in normal quality with the averages that were measured: 10 ms packets, 1.04 ms of decoding and 0.66 ms of
  // hand-over each (104 and 66 ms per second). On top, in every second, one hand-over of 22.3 ms, the longest that was
  // seen, and four of 14 ms, which is more long hand-overs than any reading had, for 5 minutes
  Feeder feeder;
  feeder.monitor.Reset(48000);
  int warnings = 0;
  for (int second = 0; second < 300; second++) {
    warnings += feeder.Feed(95, 480, 1040, 660);
    warnings += feeder.Feed(1, 480, 1040, 22300);
    warnings += feeder.Feed(4, 480, 1040, 14000);
  }
  CHECK_EQ(warnings, 0);
  const AudioLoadSummary summary = feeder.monitor.Summary();
  CHECK_EQ(summary.windows, 30u);
  CHECK_EQ(summary.overloadedWindows, 0u);
  // 104 + (95 * 0.66 + 22.3 + 4 * 14) = 104 + 141 ms per second
  CHECK_EQ(summary.decodeMsPerSecond, 104u);
  CHECK_EQ(summary.outputMsPerSecond, 141u);
  CHECK_EQ(summary.averageMsPerSecond, 245u);
  CHECK_EQ(summary.peakMsPerSecond, 245u);
  CHECK_EQ(summary.longestOutputUs, 22300u);
  CHECK_EQ(summary.longOutputs, 1500u);
  CHECK_EQ(summary.veryLongOutputs, 300u);
}

static void OverloadedStreamWarnsOnceWhenItsFirstWindowEnds() {
  // 7.1 in high quality as estimated: 5 ms packets, 1.5 ms of decoding and 0.55 ms of hand-over each (300 and 110 ms
  // per second)
  Feeder feeder;
  feeder.monitor.Reset(48000);
  // Nothing before 10 seconds of audio are complete (2000 packets of 5 ms)
  {
    const int warnings = feeder.Feed(1999, 240, 1500, 550);
    CHECK_EQ(warnings, 0);
  }
  CHECK_EQ(feeder.monitor.Summary().windows, 0u);
  CHECK_EQ(feeder.monitor.Summary().peakMsPerSecond, 0u);
  // The packet that completes the window gives the warning, with the figures of that window for the log
  {
    const int warnings = feeder.Feed(1, 240, 1500, 550);
    CHECK_EQ(warnings, 1);
  }
  CHECK_EQ(feeder.monitor.lastWindowMsPerSecond, 410u);
  CHECK_EQ(feeder.monitor.lastWindowDecodeMsPerSecond, 300u);
  CHECK_EQ(feeder.monitor.lastWindowOutputMsPerSecond, 110u);
  char line[320];
  CHECK(FormatAudioOverloadLog(feeder.monitor, 8, line, sizeof(line)) > 0);
  CHECK_EQ(std::string(line),
           std::string("Audio overload: decoding and handing over the sound of 8 channels took 410 ms per second of audio "
                       "over the last 10 s (decode 300 ms/s, hand-over 110 ms/s), above the limit of 300 ms/s\n"));
  // Every later window counts, and none warns again
  {
    const int warnings = feeder.Feed(20000, 240, 1500, 550);
    CHECK_EQ(warnings, 0);
  }
  const AudioLoadSummary summary = feeder.monitor.Summary();
  CHECK_EQ(summary.windows, 11u);
  CHECK_EQ(summary.overloadedWindows, 11u);
  CHECK_EQ(summary.peakMsPerSecond, 410u);
  CHECK_EQ(summary.averageMsPerSecond, 410u);
  CHECK_EQ(summary.longOutputs, 0u);
  // A new stream starts over and warns again
  feeder = Feeder();
  feeder.monitor.Reset(48000);
  {
    const int warnings = feeder.Feed(1000, 480, 3000, 1100);
    CHECK_EQ(warnings, 1);
  }
  // A line that doesn't fit fails
  CHECK_EQ(FormatAudioOverloadLog(feeder.monitor, 8, line, ShortLength()), -1);
}

static void WindowsAreJudgedOneByOne() {
  // A stream at 250 ms per second with one window at 350: only that window counts, and it is the one that warns
  Feeder feeder;
  feeder.monitor.Reset(48000);
  {
    const int warnings = feeder.Feed(3000, 480, 1500, 1000);
    CHECK_EQ(warnings, 0);
  }
  {
    const int warnings = feeder.Feed(999, 480, 2500, 1000);
    CHECK_EQ(warnings, 0);
  }
  {
    const int warnings = feeder.Feed(1, 480, 2500, 1000);
    CHECK_EQ(warnings, 1);
  }
  {
    const int warnings = feeder.Feed(3000, 480, 1500, 1000);
    CHECK_EQ(warnings, 0);
  }
  AudioLoadSummary summary = feeder.monitor.Summary();
  CHECK_EQ(summary.windows, 7u);
  CHECK_EQ(summary.overloadedWindows, 1u);
  CHECK_EQ(summary.peakMsPerSecond, 350u);
  CHECK_EQ(summary.averageMsPerSecond, 264u);
  // A burst of work that ends within a window doesn't overload it: 3 seconds at 900 ms per second in a window that is
  // otherwise idle average 270
  feeder = Feeder();
  feeder.monitor.Reset(48000);
  {
    const int warnings = feeder.Feed(300, 480, 6000, 3000);
    CHECK_EQ(warnings, 0);
  }
  {
    const int warnings = feeder.Feed(700, 480, 0, 0);
    CHECK_EQ(warnings, 0);
  }
  summary = feeder.monitor.Summary();
  CHECK_EQ(summary.windows, 1u);
  CHECK_EQ(summary.overloadedWindows, 0u);
  CHECK_EQ(summary.peakMsPerSecond, 270u);
  // A window at exactly the limit is no overload, and the next one just above it is
  feeder = Feeder();
  feeder.monitor.Reset(48000);
  {
    const int warnings = feeder.Feed(1000, 480, 2000, 1000);
    CHECK_EQ(warnings, 0);
  }
  CHECK_EQ(feeder.monitor.Summary().peakMsPerSecond, 300u);
  {
    const int warnings = feeder.Feed(999, 480, 2000, 1000);
    CHECK_EQ(warnings, 0);
  }
  {
    const int warnings = feeder.Feed(1, 480, 2000, 1001);
    CHECK_EQ(warnings, 1);
  }
}

static void PacketsThatDecodeNothingAndBrokenTotals() {
  // Packets that the decoder rejects take time and give no audio: the window ends once 10 seconds of audio were decoded
  Feeder feeder;
  feeder.monitor.Reset(48000);
  {
    const int warnings = feeder.Feed(500, 0, 1000, 0);
    CHECK_EQ(warnings, 0);
  }
  CHECK_EQ(feeder.monitor.Summary().windows, 0u);
  {
    const int warnings = feeder.Feed(999, 480, 1000, 1000);
    CHECK_EQ(warnings, 0);
  }
  {
    const int warnings = feeder.Feed(1, 480, 1000, 1000);
    CHECK_EQ(warnings, 0);
  }
  CHECK_EQ(feeder.monitor.Summary().windows, 1u);
  CHECK_EQ(feeder.monitor.Summary().peakMsPerSecond, 250u);
  // Without a sample rate (no audio output) nothing is judged, and totals that went back are ignored
  AudioLoadMonitor idle;
  idle.Reset(0);
  CHECK(!idle.Update(90000000, 0, 4800000));
  CHECK_EQ(idle.Summary().windows, 0u);
  CHECK_EQ(idle.Summary().averageMsPerSecond, 0u);
  AudioLoadMonitor monitor;
  monitor.Reset(48000);
  CHECK(!monitor.Update(1000, 1000, 480));
  CHECK(!monitor.Update(500, 1000, 960));
  CHECK_EQ(monitor.samples, 480u);
  // Before Reset() a monitor judges nothing
  AudioLoadMonitor fresh;
  CHECK(!fresh.Update(90000000, 0, 4800000));
}

static void SummaryLine() {
  Feeder feeder;
  feeder.monitor.Reset(48000);
  for (int second = 0; second < 750; second++) {
    feeder.Feed(98, 480, 1040, 660);
    feeder.Feed(1, 480, 1040, 9000);
    feeder.Feed(1, 480, 1040, second % 50 == 0 ? 22300 : 660);
  }
  char line[320];
  CHECK(FormatAudioLoadSummaryLog(feeder.monitor.Summary(), line, sizeof(line)) > 0);
  CHECK_EQ(std::string(line),
           std::string("Audio thread work of this stream: decode 104 ms/s, hand-over 75 ms/s, together 179 ms/s of audio; "
                       "highest 10 s window 181 ms/s, 0 of 75 windows above 300 ms/s; longest hand-over 22.3 ms, 765 "
                       "longer than 8 ms, 15 longer than 20 ms\n"));
  CHECK_EQ(FormatAudioLoadSummaryLog(feeder.monitor.Summary(), line, ShortLength()), -1);
  // A stream that ended before its first window names no window
  AudioLoadMonitor shortStream;
  shortStream.Reset(48000);
  shortStream.Update(52000, 33000, 24000);
  CHECK(FormatAudioLoadSummaryLog(shortStream.Summary(), line, sizeof(line)) > 0);
  CHECK(std::string(line).find("decode 104 ms/s, hand-over 66 ms/s, together 170 ms/s of audio; highest 10 s window 0 ms/s, "
                               "0 of 0 windows above 300 ms/s") != std::string::npos);
}

int main() {
  test_support::RunTest("the rule of an overload at its limits", RuleAtItsLimits);
  test_support::RunTest("the measured streams are no overload, the estimated high quality surround streams are",
                        MeasuredAndEstimatedStreams);
  test_support::RunTest("a stream that played fine never warns, with hand-overs of up to 22 ms in every second",
                        GoodStreamWithLongHandOversNeverWarns);
  test_support::RunTest("an overloaded stream warns once, when its first window of 10 seconds ends",
                        OverloadedStreamWarnsOnceWhenItsFirstWindowEnds);
  test_support::RunTest("each window is judged on its own, at the limit and around it", WindowsAreJudgedOneByOne);
  test_support::RunTest("packets without audio, no audio output and totals that went back",
                        PacketsThatDecodeNothingAndBrokenTotals);
  test_support::RunTest("the log line with the figures of a stream", SummaryLine);
  return test_support::Summary();
}
