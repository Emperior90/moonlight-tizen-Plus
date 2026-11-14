#pragma once
// Statistics of the audio stream for the performance stats overlay: the codec, the channel layout and the packet
// duration that the RTSP negotiation settled on (which can differ from the audio setting when the host offers less),
// the data rate of the Opus packets, the packets that neither arrived nor were repaired by the audio FEC, which
// moonlight-common-c hands to the decoder as an empty packet for packet loss concealment, and the time that the audio
// thread spends on decoding the packets and on handing them to the player. auddec.cpp counts them on the audio thread,
// and FormatVideoStats() in wasmplayer.cpp prints them on the video decoder thread with each message of the full
// statistics (about every 2 seconds, kFullStatsWindows in compact_stats.hpp), so the counters are atomics that are read
// without a lock (a line may mix values of two packets, which is fine for a display). The header has no other
// dependencies, so the native tests can check it on its own (tests/native/audio_stream_stats_test.cpp).

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
  // The work of the audio thread per packet in microseconds of a monotonic clock: the time in opus_multistream_decode()
  // (also for a lost packet, which the decoder conceals, and for a packet that it rejects), the samples per channel
  // that it decoded, and the time of handing them to the player (AppendPacket() of the EMSS backend, or the conversion
  // and the post to the main thread of the Web Audio backend). The totals grow for the whole stream like the counters
  // above, and the overlay takes the part of its window; the maxima are those of one packet since the overlay last
  // read them, which sets them back to 0.
  std::atomic<uint64_t> decodeUs{0};
  std::atomic<uint64_t> decodedSamples{0};
  std::atomic<uint32_t> decodeMaxUs{0};
  std::atomic<uint64_t> outputUs{0};
  std::atomic<uint32_t> outputMaxUs{0};
  // The load of the audio thread over the stream that ended (audio_load.hpp): the channels that were decoded, decoding
  // plus hand-over in milliseconds per second of audio over the whole stream and in its busiest window, and the
  // windows that counted as overloaded. AudDecCleanup() in auddec.cpp stores them once the audio thread has ended, and
  // VidDecCleanup() in wasmplayer.cpp takes them for the report of the session, which sets them back to 0, so that a
  // stream that ends before its audio starts doesn't report the figures of the stream before it.
  std::atomic<uint32_t> loadChannels{0};
  std::atomic<uint32_t> loadMsPerSecond{0};
  std::atomic<uint32_t> loadPeakMsPerSecond{0};
  std::atomic<uint32_t> overloadedWindows{0};

  // Start the statistics of a new audio stream
  void Reset(int channels, int samples, int rate, uint64_t nowMs) {
    loadChannels = 0;
    loadMsPerSecond = 0;
    loadPeakMsPerSecond = 0;
    overloadedWindows = 0;
    receivedBytes = 0;
    receivedPackets = 0;
    lostPackets = 0;
    decodeErrors = 0;
    playerRejections = 0;
    decodeUs = 0;
    decodedSamples = 0;
    decodeMaxUs = 0;
    outputUs = 0;
    outputMaxUs = 0;
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

  // Count the time of one call of the decoder and the samples per channel that it decoded (0 when it failed)
  void CountDecode(uint32_t us, int samples) {
    decodeUs.fetch_add(us, std::memory_order_relaxed);
    if (samples > 0) {
      decodedSamples.fetch_add((uint64_t)samples, std::memory_order_relaxed);
    }
    RaiseMax(decodeMaxUs, us);
  }

  // Count the time of handing one decoded packet to the player
  void CountOutput(uint32_t us) {
    outputUs.fetch_add(us, std::memory_order_relaxed);
    RaiseMax(outputMaxUs, us);
  }

 private:
  // Raise a maximum that the overlay sets back to 0 at any time: the compare and exchange starts over when it changed
  // meanwhile, so a packet that comes right after the reading counts for the next window instead of getting lost
  static void RaiseMax(std::atomic<uint32_t>& max, uint32_t value) {
    uint32_t current = max.load(std::memory_order_relaxed);
    while (value > current && !max.compare_exchange_weak(current, value, std::memory_order_relaxed)) {
    }
  }
};

// The statistics of the running audio stream (defined in auddec.cpp)
extern AudioStreamStats g_AudioStreamStats;

// The reading before the current one of the data rate and of the work of the audio thread, kept by the thread that
// formats the overlay
struct AudioRateWindow {
  uint64_t lastBytes = 0;
  uint64_t lastMs = 0;
  uint64_t lastDecodeUs = 0;
  uint64_t lastDecodedSamples = 0;
  uint64_t lastOutputUs = 0;
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
//   Audio CPU: decode 11.80 ms/s (max 0.21 ms), output 0.42 ms/s (max 0.05 ms)
//   Session audio packets lost by network: 3/12000 (0.03%)
// and, once there are any, the packets the decoder or the audio player of the TV rejected. The data rate is that of
// the Opus packets since the previous reading (since the setup for the first one). The CPU line, which shows only once
// audio was decoded since the previous reading, gives the time of the decoder and of the hand-over to the player as
// milliseconds per second of the decoded audio, i.e. the share of one CPU core that they take, and the longest packet
// of each since the previous reading. Returns the number of characters written, 0 before an audio stream is set up, or
// -1 if the output is too short.
inline int FormatAudioStreamStats(AudioStreamStats& stats, AudioRateWindow& window, uint64_t nowMs, char* output,
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
  const uint64_t decodeUs = stats.decodeUs.load();
  const uint64_t decodedSamples = stats.decodedSamples.load();
  const uint64_t outputUs = stats.outputUs.load();
  // Start the window at the setup for the first reading and for a new stream
  if (window.lastMs == 0 || window.lastMs < startMs || bytes < window.lastBytes || decodeUs < window.lastDecodeUs ||
      decodedSamples < window.lastDecodedSamples || outputUs < window.lastOutputUs) {
    window.lastBytes = 0;
    window.lastMs = startMs;
    window.lastDecodeUs = 0;
    window.lastDecodedSamples = 0;
    window.lastOutputUs = 0;
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
  int ret = snprintf(output, length, "Audio stream: Opus %s, %g ms packets, %s\n", layout, packetMs, rate);
  if (ret < 0 || (size_t)ret >= length) {
    return -1;
  }
  offset += ret;

  // The work of the audio thread since the previous reading, per second of the audio that it decoded meanwhile. The
  // maxima are taken and set back to 0 in the same step, so that each packet counts for one reading.
  const uint32_t decodeMaxUs = stats.decodeMaxUs.exchange(0);
  const uint32_t outputMaxUs = stats.outputMaxUs.exchange(0);
  const uint64_t windowSamples = decodedSamples - window.lastDecodedSamples;
  if (windowSamples != 0 && sampleRate > 0) {
    // Microseconds per sample times the samples of one second, in milliseconds
    const double perSecond = sampleRate / (windowSamples * 1000.0);
    ret = snprintf(&output[offset], length - offset,
      "Audio CPU: decode %.2f ms/s (max %.2f ms), output %.2f ms/s (max %.2f ms)\n",
      (decodeUs - window.lastDecodeUs) * perSecond, decodeMaxUs / 1000.0, (outputUs - window.lastOutputUs) * perSecond,
      outputMaxUs / 1000.0);
    if (ret < 0 || (size_t)ret >= length - offset) {
      return -1;
    }
    offset += ret;
  }
  window.lastDecodeUs = decodeUs;
  window.lastDecodedSamples = decodedSamples;
  window.lastOutputUs = outputUs;

  ret = snprintf(&output[offset], length - offset, "Session audio packets lost by network: %u/%u (%.2f%%)\n", lost, total,
    total != 0 ? lost * 100.0 / total : 0.0);
  if (ret < 0 || (size_t)ret >= length - offset) {
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
