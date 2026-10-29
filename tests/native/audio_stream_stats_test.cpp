// Checks the audio lines of the performance stats (wasm/audio_stream_stats.hpp): the negotiated codec, channel layout
// and packet duration of the Opus stream, the data rate between two readings, the packets the network lost (handed to
// the decoder without data for packet loss concealment), and the errors of the decoder and the audio player of the TV.
// auddec.cpp counts on the audio thread and FormatVideoStats() in wasm/wasmplayer.cpp prints once per second, so the
// test also counts from several threads at once.

#include "audio_stream_stats.hpp"
#include "test_support.h"

#include <string>
#include <thread>
#include <vector>

AudioStreamStats g_AudioStreamStats;

static std::string Format(const AudioStreamStats& stats, AudioRateWindow& window, uint64_t nowMs, size_t length = 512) {
  std::vector<char> output(length, 'x');
  int written = FormatAudioStreamStats(stats, window, nowMs, output.data(), output.size());
  if (written < 0) {
    return "<too short>";
  }
  CHECK_EQ((size_t)written, std::string(output.data()).size());
  return std::string(output.data());
}

static void FeedPackets(AudioStreamStats& stats, int count, int bytes) {
  static const char data[1] = {0};
  for (int i = 0; i < count; i++) {
    stats.CountPacket(data, bytes);
  }
}

static void NothingBeforeTheAudioStreamIsSetUp() {
  AudioStreamStats stats;
  AudioRateWindow window;
  const std::string text = Format(stats, window, 5000);
  CHECK_EQ(text, std::string(""));
}

static void StereoStreamWithRateAndNoLoss() {
  AudioStreamStats stats;
  AudioRateWindow window;
  stats.Reset(2, 240, 48000, 1000);
  // One second of 5 ms packets of 160 bytes: 200 * 160 * 8 = 256 kbps
  FeedPackets(stats, 200, 160);
  // Format() moves the window of the data rate, so it is called once per reading (CHECK_EQ evaluates twice)
  const std::string text = Format(stats, window, 2000);
  CHECK_EQ(text,
           std::string("Audio stream: Opus Stereo (2 channels), 5 ms packets, 256 kbps\n"
                       "Session audio packets lost by network: 0/200 (0.00%)\n"));
}

static void SurroundLayoutsAndPacketDurations() {
  AudioStreamStats stats;
  AudioRateWindow window;
  stats.Reset(6, 480, 48000, 1000);
  FeedPackets(stats, 100, 640);
  const std::string text = Format(stats, window, 2000);
  CHECK_EQ(text,
           std::string("Audio stream: Opus 5.1 surround (6 channels), 10 ms packets, 512 kbps\n"
                       "Session audio packets lost by network: 0/100 (0.00%)\n"));
  AudioStreamStats seven;
  AudioRateWindow sevenWindow;
  seven.Reset(8, 240, 48000, 1000);
  CHECK(Format(seven, sevenWindow, 1500).find("Opus 7.1 surround (8 channels), 5 ms packets, 0 kbps\n") != std::string::npos);
  AudioStreamStats odd;
  AudioRateWindow oddWindow;
  odd.Reset(4, 120, 48000, 1000);
  CHECK(Format(odd, oddWindow, 1500).find("Audio stream: Opus 4 channels, 2.5 ms packets, 0 kbps\n") == 0);
}

static void LostPacketsAndErrors() {
  AudioStreamStats stats;
  AudioRateWindow window;
  stats.Reset(2, 240, 48000, 1000);
  FeedPackets(stats, 397, 100);
  // moonlight-common-c hands a lost packet to the decoder without data
  stats.CountPacket(nullptr, 0);
  stats.CountPacket(nullptr, 0);
  stats.CountPacket(nullptr, 0);
  CHECK_EQ(stats.receivedPackets.load(), 397u);
  CHECK_EQ(stats.lostPackets.load(), 3u);
  std::string text = Format(stats, window, 2000);
  CHECK(text.find("Session audio packets lost by network: 3/400 (0.75%)\n") != std::string::npos);
  CHECK(text.find("Session audio decode errors") == std::string::npos);
  stats.decodeErrors++;
  stats.playerRejections += 2;
  text = Format(stats, window, 3000);
  CHECK(text.find("Session audio decode errors: 1, TV audio player rejections: 2\n") != std::string::npos);
}

static void RateFollowsTheWindowAndANewStream() {
  AudioStreamStats stats;
  AudioRateWindow window;
  stats.Reset(2, 240, 48000, 10000);
  FeedPackets(stats, 200, 100);  // 160 kbps over the first second
  CHECK(Format(stats, window, 11000).find(", 160 kbps\n") != std::string::npos);
  FeedPackets(stats, 100, 100);  // 80 kbps over the next second
  CHECK(Format(stats, window, 12000).find(", 80 kbps\n") != std::string::npos);
  // A reading at the same time has no rate
  CHECK(Format(stats, window, 12000).find(", N/A\n") != std::string::npos);
  // A new stream starts its rate at its own setup
  stats.Reset(6, 240, 48000, 20000);
  FeedPackets(stats, 50, 400);  // 160000 bits in 500 ms = 320 kbps
  CHECK(Format(stats, window, 20500).find("5.1 surround (6 channels), 5 ms packets, 320 kbps\n") != std::string::npos);
}

static void ShortOutputFails() {
  AudioStreamStats stats;
  AudioRateWindow window;
  stats.Reset(2, 240, 48000, 1000);
  const std::string text = Format(stats, window, 2000, 40);
  CHECK_EQ(text, std::string("<too short>"));
}

static void CountsFromSeveralThreads() {
  AudioStreamStats stats;
  stats.Reset(2, 240, 48000, 1000);
  std::vector<std::thread> threads;
  for (int t = 0; t < 4; t++) {
    threads.emplace_back([&stats]() {
      static const char data[1] = {0};
      for (int i = 0; i < 10000; i++) {
        stats.CountPacket(i % 100 == 0 ? nullptr : data, i % 100 == 0 ? 0 : 10);
      }
    });
  }
  AudioRateWindow window;
  for (int i = 0; i < 100; i++) {
    Format(stats, window, 1001 + i);
  }
  for (auto& thread : threads) {
    thread.join();
  }
  CHECK_EQ(stats.lostPackets.load(), 400u);
  CHECK_EQ(stats.receivedPackets.load(), 39600u);
  CHECK_EQ(stats.receivedBytes.load(), 396000u);
}

int main() {
  test_support::RunTest("no audio lines before the audio stream is set up", NothingBeforeTheAudioStreamIsSetUp);
  test_support::RunTest("a stereo stream with its data rate and no loss", StereoStreamWithRateAndNoLoss);
  test_support::RunTest("the 5.1 and 7.1 layouts, an unusual channel count and the packet durations",
                        SurroundLayoutsAndPacketDurations);
  test_support::RunTest("lost packets, decoder errors and player rejections", LostPacketsAndErrors);
  test_support::RunTest("the data rate follows the window between readings and restarts with a new stream",
                        RateFollowsTheWindowAndANewStream);
  test_support::RunTest("an output buffer that is too short fails", ShortOutputFails);
  test_support::RunTest("packets counted from several threads while the overlay reads", CountsFromSeveralThreads);
  return test_support::Summary();
}
