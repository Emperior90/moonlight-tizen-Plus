// Checks the audio lines of the performance stats (wasm/audio_stream_stats.hpp): the negotiated codec, channel layout
// and packet duration of the Opus stream, the data rate between two readings, the time of the decoder and of the
// hand-over to the player per second of audio with the longest packet of each, the packets the network lost (handed to
// the decoder without data for packet loss concealment), and the errors of the decoder and the audio player of the TV.
// auddec.cpp counts on the audio thread and FormatVideoStats() in wasm/wasmplayer.cpp prints once per second, so the
// test also counts from several threads at once.

#include "audio_stream_stats.hpp"
#include "test_support.h"

#include <atomic>
#include <string>
#include <thread>
#include <vector>

AudioStreamStats g_AudioStreamStats;

static std::string Format(AudioStreamStats& stats, AudioRateWindow& window, uint64_t nowMs, size_t length = 512) {
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

// One second of 5 ms packets as auddec.cpp counts them: the decoder takes decodeUs and the hand-over outputUs per packet
static void FeedDecodes(AudioStreamStats& stats, int count, int samples, uint32_t decodeUs, uint32_t outputUs) {
  for (int i = 0; i < count; i++) {
    stats.CountDecode(decodeUs, samples);
    stats.CountOutput(outputUs);
  }
}

static void CpuLineGivesTheTimePerSecondOfAudioAndTheLongestPacket() {
  AudioStreamStats stats;
  AudioRateWindow window;
  stats.Reset(6, 240, 48000, 1000);
  // 5.1 at high quality: 200 packets of 110 us (22 ms per second of audio), one packet of 400 us, and the hand-over
  FeedPackets(stats, 200, 960);
  FeedDecodes(stats, 199, 240, 110, 2);
  stats.CountDecode(400, 240);
  stats.CountOutput(55);
  std::string text = Format(stats, window, 2000);
  // (199 * 110 + 400) us over 200 * 240 samples, i.e. 1 s of audio; (199 * 2 + 55) us for the hand-over
  CHECK_EQ(text,
           std::string("Audio stream: Opus 5.1 surround (6 channels), 5 ms packets, 1536 kbps\n"
                       "Audio CPU: decode 22.29 ms/s (max 0.40 ms), output 0.45 ms/s (max 0.06 ms)\n"
                       "Session audio packets lost by network: 0/200 (0.00%)\n"));
  // The next reading takes only its own window: half a second of 10 ms packets of 100 us, and its own maxima
  FeedDecodes(stats, 50, 480, 100, 3);
  text = Format(stats, window, 2500);
  CHECK(text.find("Audio CPU: decode 10.00 ms/s (max 0.10 ms), output 0.30 ms/s (max 0.00 ms)\n") != std::string::npos);
  CHECK_EQ(stats.decodeMaxUs.load(), 0u);
  CHECK_EQ(stats.outputMaxUs.load(), 0u);
}

static void CpuLineCountsConcealedAndRejectedPacketsAndShowsOnlyWithDecodedAudio() {
  AudioStreamStats stats;
  AudioRateWindow window;
  stats.Reset(2, 240, 48000, 1000);
  // Before any audio was decoded there is no CPU line
  CHECK(Format(stats, window, 1500).find("Audio CPU") == std::string::npos);
  // A concealed packet decodes samples too; a rejected one only costs time, which counts for the audio around it
  stats.CountDecode(30, 240);
  stats.CountDecode(50, 240);
  stats.CountDecode(20, 0);
  CHECK_EQ(stats.decodedSamples.load(), 480u);
  CHECK(Format(stats, window, 1600).find("Audio CPU: decode 10.00 ms/s (max 0.05 ms), output 0.00 ms/s (max 0.00 ms)\n") !=
        std::string::npos);
  // A window without decoded audio (e.g. while the TV player didn't start) has no line, and its time goes to none
  stats.CountDecode(40, -1);
  CHECK(Format(stats, window, 1700).find("Audio CPU") == std::string::npos);
  stats.CountDecode(60, 240);
  CHECK(Format(stats, window, 1800).find("Audio CPU: decode 12.00 ms/s (max 0.06 ms)") != std::string::npos);
}

static void CpuLineStartsOverWithANewStream() {
  AudioStreamStats stats;
  AudioRateWindow window;
  stats.Reset(8, 240, 48000, 10000);
  FeedDecodes(stats, 200, 240, 150, 2);
  CHECK(Format(stats, window, 11000).find("Audio CPU: decode 30.00 ms/s (max 0.15 ms)") != std::string::npos);
  FeedDecodes(stats, 200, 240, 150, 2);
  stats.Reset(6, 480, 48000, 20000);
  FeedDecodes(stats, 100, 480, 100, 4);
  CHECK(Format(stats, window, 21000).find("Audio CPU: decode 10.00 ms/s (max 0.10 ms), output 0.40 ms/s (max 0.00 ms)\n") !=
        std::string::npos);
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

// The audio thread raises the maxima while the overlay takes and resets them: every packet counts for one reading, so
// the largest value always shows in one of them and none shows in two
static void MaximaFromSeveralThreadsWhileTheOverlayReads() {
  AudioStreamStats stats;
  stats.Reset(6, 240, 48000, 1000);
  std::atomic<bool> done{false};
  std::thread audio([&stats, &done]() {
    for (uint32_t i = 1; i <= 200000; i++) {
      stats.CountDecode(i == 150000 ? 900000 : i % 500, 240);
      stats.CountOutput(i == 150000 ? 800000 : i % 300);
    }
    done = true;
  });
  AudioRateWindow window;
  int decodeHits = 0;
  int outputHits = 0;
  uint64_t now = 1001;
  auto read = [&]() {
    const std::string text = Format(stats, window, now++);
    decodeHits += text.find("decode") != std::string::npos && text.find("(max 900.00 ms)") != std::string::npos ? 1 : 0;
    outputHits += text.find("(max 800.00 ms)\n") != std::string::npos ? 1 : 0;
  };
  while (!done) {
    read();
  }
  audio.join();
  read();
  CHECK_EQ(decodeHits, 1);
  CHECK_EQ(outputHits, 1);
  CHECK_EQ(stats.decodedSamples.load(), 200000u * 240u);
}

int main() {
  test_support::RunTest("no audio lines before the audio stream is set up", NothingBeforeTheAudioStreamIsSetUp);
  test_support::RunTest("a stereo stream with its data rate and no loss", StereoStreamWithRateAndNoLoss);
  test_support::RunTest("the 5.1 and 7.1 layouts, an unusual channel count and the packet durations",
                        SurroundLayoutsAndPacketDurations);
  test_support::RunTest("lost packets, decoder errors and player rejections", LostPacketsAndErrors);
  test_support::RunTest("the data rate follows the window between readings and restarts with a new stream",
                        RateFollowsTheWindowAndANewStream);
  test_support::RunTest("the CPU line gives the time per second of audio and the longest packet of each reading",
                        CpuLineGivesTheTimePerSecondOfAudioAndTheLongestPacket);
  test_support::RunTest("the CPU line counts concealed and rejected packets and shows only with decoded audio",
                        CpuLineCountsConcealedAndRejectedPacketsAndShowsOnlyWithDecodedAudio);
  test_support::RunTest("the CPU line starts over with a new stream", CpuLineStartsOverWithANewStream);
  test_support::RunTest("an output buffer that is too short fails", ShortOutputFails);
  test_support::RunTest("packets counted from several threads while the overlay reads", CountsFromSeveralThreads);
  test_support::RunTest("the maxima raised on the audio thread while the overlay takes them",
                        MaximaFromSeveralThreadsWhileTheOverlayReads);
  return test_support::Summary();
}
