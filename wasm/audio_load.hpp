#pragma once
// The load that the audio stream puts on its thread, judged while the stream runs, whatever the level of the
// performance stats: the time of decoding the packets plus the time of handing them to the player, per second of the
// audio that was decoded. Both parts are the totals that auddec.cpp counts on the audio thread for the 'Audio CPU' line
// of the overlay (AudioStreamStats::decodeUs, outputUs and decodedSamples in audio_stream_stats.hpp), so the judgement
// costs three readings of them and a few comparisons per packet, on the thread that counts them. A stream whose sound
// keeps that thread busy for too large a share of the time gets one warning (IsAudioOverloaded()), and every stream
// logs its figures when it ends, so that the limit can be set from streams on real TVs. The header has no other
// dependencies, so the native tests can check it on its own (tests/native/audio_load_test.cpp).

#include <cstddef>
#include <cstdint>
#include <cstdio>

// The audio of one window of the judgement in milliseconds, and the work per second of audio in milliseconds above
// which a window counts as overloaded. Readings of the full statistics on the TV that this app was tuned on (a 4K OLED
// of 2023): 127 to 172 ms per second for stereo and for 5.1 in normal quality, in streams whose sound played fine,
// with single hand-overs of up to 22 ms. Estimated from those readings and a benchmark of the decoder: 290 to 345 ms
// per second for 5.1 in high quality and 345 to 450 for 7.1 in high quality, the one stream whose sound broke up. So
// the limit lies above everything that was measured as good, and it is an estimate until 5.1 and 7.1 in high quality
// are measured on a TV. The average over a window keeps a single long hand-over from counting: one of 22 ms adds
// 2.2 ms per second to a window of 10 seconds.
constexpr uint32_t kAudioLoadWindowMs = 10000;
constexpr uint32_t kAudioOverloadMsPerSecond = 300;

// The hand-overs of one packet to the player that the figures of a stream count as long, in microseconds: 8 ms is
// longer than a packet of 5 ms lasts, and 20 ms is two packets of 10 ms
constexpr uint32_t kAudioLongOutputUs = 8000;
constexpr uint32_t kAudioVeryLongOutputUs = 20000;

// Whether a window overloads the audio thread: its work (decoding plus hand-over, in microseconds) is more than
// kAudioOverloadMsPerSecond for each second of the audio that it decoded (in microseconds of audio), over at least a
// whole window of audio. Work of exactly the limit is not an overload, and neither is any load over less audio.
inline bool IsAudioOverloaded(uint64_t workUs, uint64_t audioUs) {
  return audioUs >= (uint64_t)kAudioLoadWindowMs * 1000 && workUs * 1000 > audioUs * kAudioOverloadMsPerSecond;
}

// The work in milliseconds per second of audio, rounded, for an amount of work in microseconds and the samples per
// channel that were decoded meanwhile; 0 without audio
inline uint32_t AudioLoadMsPerSecond(uint64_t workUs, uint64_t samples, int sampleRate) {
  if (samples == 0 || sampleRate <= 0) {
    return 0;
  }
  return (uint32_t)((workUs * (uint64_t)sampleRate + samples * 500) / (samples * 1000));
}

// The figures of a stream, as AudioLoadMonitor gathered them
struct AudioLoadSummary {
  uint32_t decodeMsPerSecond = 0;  // decoding, over the whole stream
  uint32_t outputMsPerSecond = 0;  // hand-over to the player, over the whole stream
  uint32_t averageMsPerSecond = 0;  // both together, over the whole stream
  uint32_t peakMsPerSecond = 0;  // both together in the window with the most work, 0 before the first window ended
  uint32_t windows = 0;  // windows that ended
  uint32_t overloadedWindows = 0;  // those of them that IsAudioOverloaded() counts
  uint32_t longestOutputUs = 0;  // the longest hand-over of one packet
  uint32_t longOutputs = 0;  // hand-overs longer than kAudioLongOutputUs
  uint32_t veryLongOutputs = 0;  // hand-overs longer than kAudioVeryLongOutputUs
};

// Follows the load of one audio stream from the totals of its statistics. Update() is called on the audio thread after
// every packet with the totals as they are then, which only that thread raises, so the difference to the call before
// is the work of that packet. Nothing here is shared between threads: Reset() runs before the audio thread of a stream
// starts and Summary() after it ended.
struct AudioLoadMonitor {
  int sampleRate = 0;
  // The totals at the last call
  uint64_t decodeUs = 0;
  uint64_t outputUs = 0;
  uint64_t samples = 0;
  // The totals where the open window started
  uint64_t windowDecodeUs = 0;
  uint64_t windowOutputUs = 0;
  uint64_t windowSamples = 0;
  // The work of the window that ended last, for the log line of the warning
  uint32_t lastWindowMsPerSecond = 0;
  uint32_t lastWindowDecodeMsPerSecond = 0;
  uint32_t lastWindowOutputMsPerSecond = 0;
  // Whether Update() answered true for this stream
  bool warned = false;
  AudioLoadSummary summary;

  // Start with a new audio stream, whose statistics start at 0
  void Reset(int rate) {
    *this = AudioLoadMonitor();
    sampleRate = rate;
  }

  // Take the totals after a packet. Returns true once per stream: when the first window that overloads the audio thread
  // ends, which is when the user is told.
  bool Update(uint64_t totalDecodeUs, uint64_t totalOutputUs, uint64_t totalSamples) {
    if (sampleRate <= 0 || totalDecodeUs < decodeUs || totalOutputUs < outputUs || totalSamples < samples) {
      return false;
    }
    const uint64_t packetOutputUs = totalOutputUs - outputUs;
    if (packetOutputUs > summary.longestOutputUs) {
      summary.longestOutputUs = packetOutputUs > UINT32_MAX ? UINT32_MAX : (uint32_t)packetOutputUs;
    }
    if (packetOutputUs > kAudioLongOutputUs) {
      summary.longOutputs++;
      if (packetOutputUs > kAudioVeryLongOutputUs) {
        summary.veryLongOutputs++;
      }
    }
    decodeUs = totalDecodeUs;
    outputUs = totalOutputUs;
    samples = totalSamples;

    // A window ends with the packet that completes its audio
    const uint64_t audioSamples = samples - windowSamples;
    if (audioSamples * 1000 < (uint64_t)sampleRate * kAudioLoadWindowMs) {
      return false;
    }
    const uint64_t decodeWorkUs = decodeUs - windowDecodeUs;
    const uint64_t outputWorkUs = outputUs - windowOutputUs;
    lastWindowMsPerSecond = AudioLoadMsPerSecond(decodeWorkUs + outputWorkUs, audioSamples, sampleRate);
    lastWindowDecodeMsPerSecond = AudioLoadMsPerSecond(decodeWorkUs, audioSamples, sampleRate);
    lastWindowOutputMsPerSecond = AudioLoadMsPerSecond(outputWorkUs, audioSamples, sampleRate);
    windowDecodeUs = decodeUs;
    windowOutputUs = outputUs;
    windowSamples = samples;
    summary.windows++;
    if (lastWindowMsPerSecond > summary.peakMsPerSecond) {
      summary.peakMsPerSecond = lastWindowMsPerSecond;
    }
    if (!IsAudioOverloaded(decodeWorkUs + outputWorkUs, audioSamples * 1000000 / (uint64_t)sampleRate)) {
      return false;
    }
    summary.overloadedWindows++;
    if (warned) {
      return false;
    }
    warned = true;
    return true;
  }

  // The figures of the stream so far
  AudioLoadSummary Summary() const {
    AudioLoadSummary result = summary;
    result.decodeMsPerSecond = AudioLoadMsPerSecond(decodeUs, samples, sampleRate);
    result.outputMsPerSecond = AudioLoadMsPerSecond(outputUs, samples, sampleRate);
    result.averageMsPerSecond = AudioLoadMsPerSecond(decodeUs + outputUs, samples, sampleRate);
    return result;
  }
};

// The log line of the warning, for the window that Update() just judged as the first overloaded one, e.g.
//   Audio overload: decoding and handing over the sound of 8 channels took 412 ms per second of audio over the last
//   10 s (decode 301 ms/s, hand-over 111 ms/s), above the limit of 300 ms/s
// Returns the number of characters written, or -1 if the output is too short.
inline int FormatAudioOverloadLog(const AudioLoadMonitor& monitor, int channels, char* output, size_t length) {
  const int written = snprintf(output, length,
    "Audio overload: decoding and handing over the sound of %d channels took %u ms per second of audio over the last "
    "%u s (decode %u ms/s, hand-over %u ms/s), above the limit of %u ms/s\n",
    channels, monitor.lastWindowMsPerSecond, kAudioLoadWindowMs / 1000,
    monitor.lastWindowDecodeMsPerSecond, monitor.lastWindowOutputMsPerSecond, kAudioOverloadMsPerSecond);
  return written < 0 || (size_t)written >= length ? -1 : written;
}

// The log line with the figures of a stream that ended, e.g.
//   Audio thread work of this stream: decode 104 ms/s, hand-over 66 ms/s, together 170 ms/s of audio; highest 10 s
//   window 181 ms/s, 0 of 75 windows above 300 ms/s; longest hand-over 22.3 ms, 14 longer than 8 ms, 2 longer than 20 ms
// Returns the number of characters written, or -1 if the output is too short.
inline int FormatAudioLoadSummaryLog(const AudioLoadSummary& summary, char* output, size_t length) {
  const int written = snprintf(output, length,
    "Audio thread work of this stream: decode %u ms/s, hand-over %u ms/s, together %u ms/s of audio; highest %u s "
    "window %u ms/s, %u of %u windows above %u ms/s; longest hand-over %.1f ms, %u longer than %u ms, %u longer than "
    "%u ms\n",
    summary.decodeMsPerSecond, summary.outputMsPerSecond, summary.averageMsPerSecond, kAudioLoadWindowMs / 1000,
    summary.peakMsPerSecond, summary.overloadedWindows, summary.windows, kAudioOverloadMsPerSecond,
    summary.longestOutputUs / 1000.0, summary.longOutputs, kAudioLongOutputUs / 1000, summary.veryLongOutputs,
    kAudioVeryLongOutputUs / 1000);
  return written < 0 || (size_t)written >= length ? -1 : written;
}
