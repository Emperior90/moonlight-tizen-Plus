#pragma once
// Statistics of the audio stream for the performance stats overlay: the codec, the channel layout and the packet
// duration that the RTSP negotiation settled on (which can differ from the audio setting when the host offers less),
// the data rate of the Opus packets, and the packets that neither arrived nor were repaired by the audio FEC, which
// moonlight-common-c hands to the decoder as an empty packet for packet loss concealment. auddec.cpp counts them on the
// audio thread, and FormatVideoStats() in wasmplayer.cpp prints them on the video decoder thread about once per second,
// so the counters are atomics that are read without a lock (a line may mix values of two packets, which is fine for a
// display). The header has no other dependencies, so the native tests can check it on its own
// (tests/native/audio_stream_stats_test.cpp).

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>

struct AudioStreamStats {
  // 0 until an audio stream is set up, and while the audio output is disabled
  std::atomic<int> channelCount{0};
  std::atomic<int> samplesPerFrame{0};
  std::atomic<int> sampleRate{0};
  // Time of the setup on the clock of LiGetMillis(), where the data rate of the first reading starts
  std::atomic<uint64_t> startMs{0};
  // Opus data received, without the RTP header and the FEC packets
  std::atomic<uint64_t> receivedBytes{0};
  std::atomic<uint32_t> receivedPackets{0};
  // Packets the network lost that the audio FEC couldn't repair, played as concealed audio
  std::atomic<uint32_t> lostPackets{0};
  // Packets the Opus decoder rejected
  std::atomic<uint32_t> decodeErrors{0};
  // Packets the audio player of the TV rejected (EMSS backend only)
  std::atomic<uint32_t> playerRejections{0};

  // Start the statistics of a new audio stream
  void Reset(int channels, int samples, int rate, uint64_t nowMs) {
    receivedBytes = 0;
    receivedPackets = 0;
    lostPackets = 0;
    decodeErrors = 0;
    playerRejections = 0;
    samplesPerFrame = samples;
    sampleRate = rate;
    startMs = nowMs;
    channelCount = channels;
  }

  // Count a packet that moonlight-common-c hands to the decoder: an empty one stands for a lost packet
  void CountPacket(const void* data, int length) {
    if (data == nullptr || length <= 0) {
      lostPackets.fetch_add(1, std::memory_order_relaxed);
    } else {
      receivedPackets.fetch_add(1, std::memory_order_relaxed);
      receivedBytes.fetch_add((uint64_t)length, std::memory_order_relaxed);
    }
  }
};

// The statistics of the running audio stream (defined in auddec.cpp)
extern AudioStreamStats g_AudioStreamStats;

// The reading of the data rate before the current one, kept by the thread that formats the overlay
struct AudioRateWindow {
  uint64_t lastBytes = 0;
  uint64_t lastMs = 0;
};

// Name of the channel layout of the Opus stream, or nullptr for an unusual channel count
inline const char* GetAudioChannelLayoutName(int channelCount) {
  switch (channelCount) {
    case 1:
      return "Mono";
    case 2:
      return "Stereo";
    case 6:
      return "5.1 surround";
    case 8:
      return "7.1 surround";
    default:
      return nullptr;
  }
}

// Write the audio lines of the overlay, e.g.
//   Audio stream: Opus 5.1 surround (6 channels), 5 ms packets, 512 kbps
//   Session audio packets lost by network: 3/12000 (0.03%)
// and, once there are any, the packets the decoder or the audio player of the TV rejected. The data rate is that of
// the Opus packets since the previous reading (since the setup for the first one). Returns the number of characters
// written, 0 before an audio stream is set up, or -1 if the output is too short.
inline int FormatAudioStreamStats(const AudioStreamStats& stats, AudioRateWindow& window, uint64_t nowMs, char* output,
                                  size_t length) {
  const int channels = stats.channelCount.load();
  if (channels <= 0 || length == 0) {
    if (length > 0) {
      output[0] = 0;
    }
    return 0;
  }
  const uint64_t bytes = stats.receivedBytes.load();
  const uint64_t startMs = stats.startMs.load();
  // Start the window at the setup for the first reading and for a new stream
  if (window.lastMs == 0 || window.lastMs < startMs || bytes < window.lastBytes) {
    window.lastBytes = 0;
    window.lastMs = startMs;
  }
  char rate[32];
  if (nowMs > window.lastMs) {
    // Bytes per millisecond times 8 is kilobits per second
    snprintf(rate, sizeof(rate), "%u kbps", (unsigned)((bytes - window.lastBytes) * 8 / (nowMs - window.lastMs)));
    window.lastBytes = bytes;
    window.lastMs = nowMs;
  } else {
    snprintf(rate, sizeof(rate), "N/A");
  }

  char layout[48];
  const char* layoutName = GetAudioChannelLayoutName(channels);
  if (layoutName != nullptr) {
    snprintf(layout, sizeof(layout), "%s (%d channels)", layoutName, channels);
  } else {
    snprintf(layout, sizeof(layout), "%d channels", channels);
  }
  const int sampleRate = stats.sampleRate.load();
  const double packetMs = sampleRate > 0 ? stats.samplesPerFrame.load() * 1000.0 / sampleRate : 0.0;

  const uint32_t received = stats.receivedPackets.load();
  const uint32_t lost = stats.lostPackets.load();
  const uint32_t total = received + lost;
  int offset = 0;
  int ret = snprintf(output, length,
    "Audio stream: Opus %s, %g ms packets, %s\n"
    "Session audio packets lost by network: %u/%u (%.2f%%)\n",
    layout, packetMs, rate, lost, total, total != 0 ? lost * 100.0 / total : 0.0);
  if (ret < 0 || (size_t)ret >= length) {
    return -1;
  }
  offset += ret;

  const uint32_t decodeErrors = stats.decodeErrors.load();
  const uint32_t playerRejections = stats.playerRejections.load();
  if (decodeErrors != 0 || playerRejections != 0) {
    ret = snprintf(&output[offset], length - offset,
      "Session audio decode errors: %u, TV audio player rejections: %u\n",
      decodeErrors, playerRejections);
    if (ret < 0 || (size_t)ret >= length - offset) {
      return -1;
    }
    offset += ret;
  }
  return offset;
}
