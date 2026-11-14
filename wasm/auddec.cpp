#include "moonlight_wasm.hpp"
#include "audio_load.hpp"
#include "audio_stream_stats.hpp"
#include "opus_layout.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>

#include <emscripten.h>

#include "samsung/wasm/elementary_media_packet.h"

using std::chrono_literals::operator""s;
using std::chrono_literals::operator""ms;
using TimeStamp = samsung::wasm::Seconds;

#define MAX_CHANNEL_COUNT 8
#define FRAME_SIZE 240

static constexpr TimeStamp kAudioBufferMargin = 100ms;

// Number of decoded frames kept in the Web Audio slot pool. Frames are handed to the main
// thread by pointer, so a slot must stay untouched long enough for the scheduler to read it.
// The pool covers well over a second of audio, because a slot that is overwritten before the
// main thread got to it is played as the audio of a later frame rather than being skipped.
static constexpr int kAudioSlotCount = 128;

// Largest number of samples per channel the Web Audio slot pool can hold. The RTSP negotiation
// never asks for more than 10 ms of audio per packet, which is 480 samples at 48 kHz. This is
// also the distance between the channels of a frame, as the samples are stored per channel.
static constexpr size_t kAudioSlotStride = 480;

// Largest decoded frame the Web Audio slot pool can hold, over all of the possible channels
static constexpr size_t kAudioSlotElements = kAudioSlotStride * MAX_CHANNEL_COUNT;

// Jitter buffer target used by the Web Audio backend when the user has not selected one
static constexpr int kDefaultAudioJitterMs = 100;

// Decoded samples of the packet that the EMSS backend appends, interleaved: one frame of the negotiated size over all of
// its channels (AudDecInit())
static std::vector<opus_int16> s_DecodeBuffer;

AudioStreamStats g_AudioStreamStats;

// The load of the audio stream on this thread, from the totals of the statistics above (audio_load.hpp). Only touched
// where the statistics are counted: on the audio thread, and before it starts and after it ended.
static AudioLoadMonitor s_AudioLoad;

static TimeStamp s_frameDuration;
static TimeStamp s_pktPts;
static TimeStamp s_estimatedAudioEnd;

static size_t s_samplesPerFrame;
static size_t s_channelCount;
static int s_sampleRate;

static std::chrono::time_point<std::chrono::steady_clock> s_firstAppend;

static bool s_hasFirstFrame = false;
static bool s_AudioSyncEnabled = false;

// Audio backend rendering the stream, latched when the audio stream is initialized so that
// the decoding callbacks cannot observe a backend change made while a stream is running
static AudioBackend s_AudioBackend = AudioBackend::Emss;

// Rotating pool of decoded frames for the Web Audio backend. This is statically allocated
// because the scheduler on the main thread reads a slot asynchronously, so the memory must
// stay valid for the lifetime of the application rather than that of a streaming session.
//
// The samples are stored per channel and already scaled to the -1.0 to 1.0 range that the Web
// Audio API expects, so the main thread only has to copy them into an audio buffer. Converting
// them here keeps that work on the audio thread, which is the one thread that Game Mode does
// not load with the video packets that are submitted to the elementary media pipeline.
static float s_AudioSlots[kAudioSlotCount][kAudioSlotElements];
static int s_AudioSlotIndex = 0;

// Interleaved samples of the frame that is being decoded, before it is split per channel
static opus_int16 s_AudioPcm[kAudioSlotElements];

// Index of the next frame handed to the scheduler, which reports the frames that never made
// it to the main thread as gaps in its statistics
static int s_AudioSequence = 0;

// Frames the Opus decoder rejected since the last time it was reported
static int s_AudioDecodeErrors = 0;

// Packets that the audio player of the TV rejected, and packets that 'Limit audio delay' dropped, since the start of the
// stream. Both can happen for every packet of a stream (200 per second with 5 ms packets), so they are logged in batches
// like the errors of the decoder above: logging each one from the audio thread would cost more time than the packet.
static int s_AppendFailures = 0;
static int s_DroppedPackets = 0;

// Arrival of the previous packet with audio data. Sunshine sends no packets while the host is silent, so a long
// gap before a packet tells the scheduler that the host paused its audio, which empties the schedule without
// any sound missing, rather than an underrun.
static std::chrono::steady_clock::time_point s_LastAudioDataTime;
static bool s_HasLastAudioDataTime = false;

static inline TimeStamp FrameDuration(double samplesPerFrame, double sampleRate) {
  // Calculate the duration of a frame based on the number of samples per frame and the sample rate
  return TimeStamp(samplesPerFrame / sampleRate);
}

// The microseconds between two readings of the monotonic clock, for the work of the audio thread in the performance
// stats (AudioStreamStats::CountDecode() and CountOutput()). A reading cost about 0.1 us in WebAssembly built with the
// compiler of the app and run by Node.js on a PC, against 30 to 150 us for decoding a packet there. A clock that the
// browser of the TV rounds more coarsely still adds up to the right total over the many packets of a second; only the
// maxima are rounded then.
static inline uint32_t ElapsedUs(std::chrono::steady_clock::time_point start, std::chrono::steady_clock::time_point end) {
  const long long us = std::chrono::duration_cast<std::chrono::microseconds>(end - start).count();
  return us <= 0 ? 0 : (uint32_t)std::min<long long>(us, UINT32_MAX);
}

// Decode a packet with the Opus decoder into the given buffer, and count the time it took and the samples per channel
// it decoded for the performance stats. The end of the decode is returned, where the hand-over to the player starts.
static int DecodeTimed(OpusMSDecoder* decoder, const unsigned char* sampleData, int sampleLength, opus_int16* pcm,
                       int frameSize, std::chrono::steady_clock::time_point* decodeEnd) {
  const auto decodeStart = std::chrono::steady_clock::now();
  const int decodeLen = opus_multistream_decode(decoder, sampleData, sampleLength, pcm, frameSize, 0);
  *decodeEnd = std::chrono::steady_clock::now();
  g_AudioStreamStats.CountDecode(ElapsedUs(decodeStart, *decodeEnd), decodeLen);
  return decodeLen;
}

// Judge the load of the audio thread after a packet (audio_load.hpp), from the totals that DecodeTimed() and the
// hand-over just raised. Once per stream, when the first window ends in which decoding and hand-over took more than the
// limit per second of audio, the figures go to the log and the front end is told, which shows the user a message once
// per session ('AudioOverloadMsg: ' in wasm/platform/messages.js). The message doesn't wait for the main thread, and it
// comes whatever the level of the performance stats, since the statistics are always counted.
static void CheckAudioLoad() {
  if (!s_AudioLoad.Update(g_AudioStreamStats.decodeUs.load(std::memory_order_relaxed),
        g_AudioStreamStats.outputUs.load(std::memory_order_relaxed),
        g_AudioStreamStats.decodedSamples.load(std::memory_order_relaxed))) {
    return;
  }
  char line[320];
  if (FormatAudioOverloadLog(s_AudioLoad, (int)s_channelCount, line, sizeof(line)) > 0) {
    MoonlightInstance::ClLogMessage("%s", line);
  }
  PostToJsAsync("AudioOverloadMsg: " + std::to_string(s_channelCount) + "," +
    std::to_string(s_AudioLoad.lastWindowMsPerSecond));
}

// Destroy the Opus decoder of a stream, if there is one, and free the decode buffer of the EMSS backend. Only called
// where no packet can be decoded: before a stream starts (AudDecInit()) and once the receive thread of
// moonlight-common-c, which decodes, has ended (AudDecCleanup(), called by stopAudioStream() in AudioStream.c).
static void ReleaseDecoder(OpusMSDecoder*& decoder) {
  if (decoder != nullptr) {
    opus_multistream_decoder_destroy(decoder);
    decoder = nullptr;
  }

  // Clear the decode buffer
  s_DecodeBuffer.clear();

  // Shrink the decode buffer to fit its contents
  s_DecodeBuffer.shrink_to_fit();
}

// Returns whether the packet was appended to the audio track, i.e. whether the player of the TV got its audio
static bool DecodeAndAppendPacket(samsung::wasm::ElementaryMediaTrack* track, samsung::wasm::SessionId session_id,
  OpusMSDecoder* decoder, const unsigned char* sampleData, int sampleLength) {
  // Nothing to decode with: a stream has no decoder before AudDecInit() and after AudDecCleanup()
  if (!decoder) {
    return false;
  }

  // Decode the incoming audio packet using Opus decoder. It writes at most the negotiated frame size per channel, which
  // the decode buffer holds (AudDecInit()).
  std::chrono::steady_clock::time_point decodeEnd;
  const int decodeLen = DecodeTimed(decoder, sampleData, sampleLength, s_DecodeBuffer.data(), (int)s_samplesPerFrame,
    &decodeEnd);

  // Check if audio decoding failed. Nothing is appended for the packet then, and the next packet that is appended
  // carries only the samples that its own decode wrote, so there is nothing to clear in the buffer.
  if (decodeLen <= 0) {
    g_AudioStreamStats.decodeErrors.fetch_add(1, std::memory_order_relaxed);
    return false;
  }

  // Calculate desired buffer size in bytes for decoded audio data
  size_t s_desiredBufferSize = sizeof(opus_int16) * decodeLen * s_channelCount;

  // Create an ElementaryMediaPacket and start decoding with the decoded audio data
  samsung::wasm::ElementaryMediaPacket pkt {
    s_pktPts, // presentation timestamp
    s_pktPts, // decoding timestamp
    s_frameDuration, // packet duration
    true, // bool value indicating if packet is a keyframe
    s_desiredBufferSize, // packet size
    s_DecodeBuffer.data(), // pointer to packet payload
    0, 0, 0, 1, // packet of width, height, framerate numerator and framerate denominator
    session_id // session identifier
  };

  // Attempt to append the packet to the audio track for rendering. Its time counts from the end of the decode, since
  // the packet description in between costs next to nothing, which saves a reading of the clock.
  const bool appended = (bool)track->AppendPacket(pkt);
  g_AudioStreamStats.CountOutput(ElapsedUs(decodeEnd, std::chrono::steady_clock::now()));
  if (appended) {
    // If successful, update the presentation timestamp for the next packet
    s_pktPts += s_frameDuration;
  } else {
    g_AudioStreamStats.playerRejections.fetch_add(1, std::memory_order_relaxed);
    // Report the rejected packets in batches (the first and every 100th), see s_AppendFailures
    if (++s_AppendFailures % 100 == 1) {
      MoonlightInstance::ClLogMessage("Append audio packet failed: the audio player of the TV rejected %d packets of this stream\n",
        s_AppendFailures);
    }
  }
  return appended;
}

static void DecodeAndScheduleFrame(OpusMSDecoder* decoder, const unsigned char* sampleData, int sampleLength) {
  // Nothing to decode with: a stream has no decoder before AudDecInit() and after AudDecCleanup()
  if (!decoder) {
    return;
  }

  // Decode the incoming audio packet using Opus decoder. The whole slot is offered to the
  // decoder rather than the negotiated frame size, so a packet that carries more audio than
  // the RTSP negotiation announced is still decoded instead of being rejected. A lost packet
  // (no data) is concealed with exactly one negotiated frame instead, because libopus fills
  // the whole requested size for concealment: offering the slot turned every lost 5 ms packet
  // into 10 ms of audio, which raised the audio delay by 5 ms for each loss.
  const bool concealLoss = (sampleData == nullptr || sampleLength <= 0);
  const int frameSize = concealLoss ? (int)std::min<size_t>(s_samplesPerFrame, kAudioSlotStride) : (int)kAudioSlotStride;
  std::chrono::steady_clock::time_point decodeEnd;
  int decodeLen = DecodeTimed(decoder, sampleData, sampleLength, s_AudioPcm, frameSize, &decodeEnd);

  // Check if audio decoding failed
  if (decodeLen <= 0) {
    g_AudioStreamStats.decodeErrors.fetch_add(1, std::memory_order_relaxed);
    // Report the rejected packets in batches, as logging every one of them from the audio
    // thread would cost more time than decoding them
    if (++s_AudioDecodeErrors % 100 == 1) {
      MoonlightInstance::ClLogMessage("The Opus decoder rejected %d audio packets, last with error %d\n",
        s_AudioDecodeErrors, decodeLen);
    }
    return;
  }

  // Take the next slot of the pool so the scheduler still has time to read the previous ones
  float* slot = s_AudioSlots[s_AudioSlotIndex];

  // Split the interleaved samples per channel and scale them to the -1.0 to 1.0 range that
  // the Web Audio API expects, so the main thread only has to copy them out of the heap
  for (size_t channel = 0; channel < s_channelCount; channel++) {
    float* output = slot + channel * kAudioSlotStride;
    for (int sample = 0; sample < decodeLen; sample++) {
      output[sample] = s_AudioPcm[sample * s_channelCount + channel] / 32768.0f;
    }
  }

  // Advance to the next slot only once a frame was written, so a failed decode does not
  // consume the protection window that the already scheduled frames rely on
  s_AudioSlotIndex = (s_AudioSlotIndex + 1) % kAudioSlotCount;

  // Number this frame so the scheduler can report the ones that never reached the main thread
  int sequence = s_AudioSequence++;

  // Measure the time since the previous packet with audio data (0 for the first one and for concealed losses)
  int arrivalGapMs = 0;
  if (!concealLoss) {
    const auto now = std::chrono::steady_clock::now();
    if (s_HasLastAudioDataTime) {
      arrivalGapMs = (int)std::min<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(now - s_LastAudioDataTime).count(), 3600000LL);
    }
    s_LastAudioDataTime = now;
    s_HasLastAudioDataTime = true;
  }

  // Hand the decoded samples to the audio scheduler running on the main thread. This is
  // asynchronous, so the audio thread is never blocked waiting on the browser event loop.
  // A failure of the scheduler is logged (the first and every 1000th, since this runs every 5 ms) and doesn't leave the
  // main thread unable to run proxied calls (see PostToJs() in main.cpp)
  MAIN_THREAD_ASYNC_EM_ASM({
    try {
      if (typeof _audReceiveFrame === 'function') {
        _audReceiveFrame($0, $1, $2, $3, $4, $5, $6);
      }
    } catch (e) {
      window._mlAudioFrameErrors = (window._mlAudioFrameErrors || 0) + 1;
      if (window._mlAudioFrameErrors % 1000 === 1) {
        console.error('%c[auddec.cpp, AudDecDecodeAndPlaySample]', 'color: gray;', 'Error: _audReceiveFrame() failed (' + window._mlAudioFrameErrors + ' times):', e);
      }
    }
  }, (int)(size_t)slot, decodeLen, (int)s_channelCount, s_sampleRate,
     (int)kAudioSlotStride, sequence, arrivalGapMs);

  // The hand-over to the player is the conversion to the slot and the post to the main thread, from the end of the
  // decode
  g_AudioStreamStats.CountOutput(ElapsedUs(decodeEnd, std::chrono::steady_clock::now()));
}

int MoonlightInstance::AudDecInit(int audioConfiguration, POPUS_MULTISTREAM_CONFIGURATION opusConfig, void* context, int arFlags) {
  int rc;

  ClLogMessage("MoonlightInstance::AudDecInit\n");

  // Nothing decodes between two streams, so a decoder that is still there is destroyed before this start creates its
  // own. AudDecCleanup() destroys the one of a stream that ended; moonlight-common-c only calls it for a start that got
  // past this function.
  ReleaseDecoder(g_Instance->m_OpusDecoder);

  // Log the layout that the host announced for this stream, as moonlight-common-c read it from the DESCRIBE answer
  char mappingText[32];
  FormatOpusMapping(opusConfig->mapping, opusConfig->channelCount, mappingText, sizeof(mappingText));
  ClLogMessage("Opus layout of the stream: channels %d, streams %d, coupled streams %d, mapping %s\n",
    opusConfig->channelCount, opusConfig->streams, opusConfig->coupledStreams, mappingText);

  // Latch the audio backend selected for this streaming session
  s_AudioBackend = g_Instance->m_AudioBackend;

  // Judge the load of this stream from its first packet; without an audio output nothing is decoded and nothing judged
  s_AudioLoad.Reset(s_AudioBackend == AudioBackend::Disabled ? 0 : opusConfig->sampleRate);

  // Skip creating the Opus decoder when the audio output is disabled, as every audio packet is discarded
  if (s_AudioBackend == AudioBackend::Disabled) {
    // No audio lines in the performance stats
    g_AudioStreamStats.channelCount = 0;
    ClLogMessage("Audio output is disabled, so the audio stream will be discarded\n");
    return 0;
  }

  // Start the audio statistics of the performance stats with the negotiated format of this stream
  g_AudioStreamStats.Reset(opusConfig->channelCount, opusConfig->samplesPerFrame, opusConfig->sampleRate,
    LiGetMillis());

  // Initialize packet timestamp to zero
  s_pktPts = 0s;

  // Initialize samples per frame (240 or 480), channels count (2, 6, 8) and sample rate (48000)
  s_samplesPerFrame = opusConfig->samplesPerFrame;
  s_channelCount = opusConfig->channelCount;
  s_sampleRate = opusConfig->sampleRate;

  // Size the decode buffer for one decoded frame over all channels. It holds samples, not bytes: the size in bytes that
  // earlier versions gave it made it twice as large as needed. The decoder never writes more than the frame size that
  // DecodeAndAppendPacket() offers it, which is this negotiated one.
  s_DecodeBuffer.assign(s_samplesPerFrame * s_channelCount, 0);

  // Log the rejected and dropped packets of this stream from the first one again
  s_AppendFailures = 0;
  s_DroppedPackets = 0;

  // Calculate the frame duration based on the samples per frame (240) and sample rate (48000)
  s_frameDuration = FrameDuration(opusConfig->samplesPerFrame, opusConfig->sampleRate);

  // The mapping to decode with is the one of the stream, except for the 7.1 that a host with a faulty channel rotation
  // announces for its normal quality (Sunshine v2026.914, Apollo, Vibeshine), which would play three channels in the
  // wrong place (opus_layout.hpp)
  unsigned char mapping[AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT];
  if (GetOpusDecoderMapping(opusConfig, mapping)) {
    FormatOpusMapping(mapping, opusConfig->channelCount, mappingText, sizeof(mappingText));
    ClLogMessage("This is the 7.1 layout of a host that rotates the mapping of its normal quality wrongly, which would "
      "mix up LFE, side left and side right: decoding with the mapping %s instead\n", mappingText);
  }

  // Create the Opus decoder with the provided configuration parameters
  rc = OPUS_OK;
  g_Instance->m_OpusDecoder = opus_multistream_decoder_create(
    opusConfig->sampleRate, opusConfig->channelCount,
    opusConfig->streams, opusConfig->coupledStreams,
    mapping, &rc
  );

  // Without a decoder the audio stream can't start: Opus refuses a layout that makes no sense (OPUS_BAD_ARG), or the
  // memory for the decoder is missing (OPUS_ALLOC_FAIL). The start of the stream fails at this stage with the error.
  if (g_Instance->m_OpusDecoder == nullptr) {
    ClLogMessage("Creating the Opus decoder failed with error %d (%s), so the audio stream can't start\n", rc,
      opus_strerror(rc));
    // Free the decode buffer of this start: moonlight-common-c doesn't call AudDecCleanup() for a start that fails here
    ReleaseDecoder(g_Instance->m_OpusDecoder);
    return rc != OPUS_OK ? rc : -1;
  }

  // Initialize the estimated audio end time
  s_estimatedAudioEnd = 0s;

  // Flag indicating whether this is the first frame of audio to be decoded
  s_hasFirstFrame = false;

  // Set the audio synchronization flag based on instance configuration
  s_AudioSyncEnabled = g_Instance->m_AudioSyncEnabled;

  // Prepare the audio scheduler when the Web Audio backend is selected
  if (s_AudioBackend == AudioBackend::WebAudio) {
    // Refuse to stream audio that cannot fit in a slot of the pool, as writing a larger
    // frame would corrupt the neighboring slots that are waiting to be scheduled
    if (s_samplesPerFrame > kAudioSlotStride || s_channelCount > MAX_CHANNEL_COUNT) {
      ClLogMessage("Decoded audio frames of %d samples over %d channels are too large for the Web Audio backend!\n",
        (int)s_samplesPerFrame, (int)s_channelCount);
      // Destroy the decoder of this start, for the same reason
      ReleaseDecoder(g_Instance->m_OpusDecoder);
      return -1;
    }

    // Report the audio format the RTSP negotiation settled on, so that a packet duration other
    // than the expected one can be told apart from the scheduler falling behind
    ClLogMessage("Negotiated %d samples per frame over %d channels at %d Hz, which is %.1f ms of audio per packet\n",
      (int)s_samplesPerFrame, (int)s_channelCount, s_sampleRate, s_frameDuration.count() * 1000.0);

    // Start writing decoded frames at the beginning of the slot pool
    s_AudioSlotIndex = 0;
    s_AudioSequence = 0;
    s_AudioDecodeErrors = 0;
    s_HasLastAudioDataTime = false;

    // Select the jitter buffer target requested by the user, or the default one when unset
    int audioJitterMs = g_Instance->m_AudioJitterMs > 0 ? g_Instance->m_AudioJitterMs : kDefaultAudioJitterMs;
    ClLogMessage("Selected the Web Audio backend with a jitter buffer of %d ms\n", audioJitterMs);

    // Publish the jitter buffer target to the audio scheduler in platform/audio.js
    MAIN_THREAD_ASYNC_EM_ASM({
      try {
        window._mlAudioTargetMs = $0;
      } catch (e) {
        console.error('%c[auddec.cpp, AudDecInit]', 'color: gray;', 'Error: Setting the jitter buffer failed:', e);
      }
    }, audioJitterMs);
  } else {
    ClLogMessage("Selected the EMSS audio backend\n");
  }

  return 0;
}

void MoonlightInstance::AudDecCleanup(void) {
  // Stop the audio scheduler so it does not keep playing frames that were decoded
  // before the streaming session ended
  if (s_AudioBackend == AudioBackend::WebAudio) {
    MAIN_THREAD_ASYNC_EM_ASM({
      try {
        if (typeof stopAudioScheduler === 'function') {
          stopAudioScheduler();
        }
      } catch (e) {
        console.error('%c[auddec.cpp, AudDecCleanup]', 'color: gray;', 'Error: stopAudioScheduler() failed:', e);
      }
    });
  }

  // Destroy the Opus decoder of the stream and free its decode buffer. The receive thread of moonlight-common-c, which
  // decodes, has ended before this is called (stopAudioStream() in AudioStream.c).
  ReleaseDecoder(g_Instance->m_OpusDecoder);

  // Log the work of the audio thread over the stream, and keep its load for the report of the session, which
  // VidDecCleanup() sends after this (audio_load.hpp). A stream that decoded nothing has neither.
  const AudioLoadSummary load = s_AudioLoad.Summary();
  if (s_AudioLoad.samples != 0) {
    char line[320];
    if (FormatAudioLoadSummaryLog(load, line, sizeof(line)) > 0) {
      ClLogMessage("%s", line);
    }
    g_AudioStreamStats.loadChannels = (uint32_t)s_channelCount;
    g_AudioStreamStats.loadMsPerSecond = load.averageMsPerSecond;
    g_AudioStreamStats.loadPeakMsPerSecond = load.peakMsPerSecond;
    g_AudioStreamStats.overloadedWindows = load.overloadedWindows;
  }
  s_AudioLoad.Reset(0);
}

void MoonlightInstance::AudDecDecodeAndPlaySample(char* sampleData, int sampleLength) {
  // Discard the audio packet without decoding it when the audio output is disabled
  if (s_AudioBackend == AudioBackend::Disabled) {
    return;
  }

  // Count the packet for the performance stats; one without data stands for a lost packet
  g_AudioStreamStats.CountPacket(sampleData, sampleLength);

  // Check if the Web Audio backend is rendering this streaming session
  if (s_AudioBackend == AudioBackend::WebAudio) {
    // Decode the audio packet and schedule it for playback on the main thread
    DecodeAndScheduleFrame(g_Instance->m_OpusDecoder,
      reinterpret_cast<unsigned char*>(sampleData), sampleLength
    );
    CheckAudioLoad();
    return;
  }

  // Check if audio playback has not started
  if (!g_Instance->m_AudioStarted) {
    return;
  }

  // Check if this is the first audio frame
  if (!s_hasFirstFrame) {
    // Record the time of the first frame
    s_firstAppend = std::chrono::steady_clock::now();
    // Update the flag to indicate that the first frame has been processed
    s_hasFirstFrame = true;
  }

  // Get the current time and calculate the time elapsed since the first frame
  auto now = std::chrono::steady_clock::now();
  TimeStamp ntp = now - s_firstAppend;

  // Check if audio synchronization is enabled and if packet dropping is necessary to avoid overflow
  if (s_AudioSyncEnabled && ntp + kAudioBufferMargin < s_estimatedAudioEnd) {
    // Report the dropped packets in batches (the first and every 100th), see s_DroppedPackets
    if (++s_DroppedPackets % 100 == 1) {
      ClLogMessage("Dropping audio packets to avoid overflow: %d packets of this stream, PTS=%.03f NTP=%.03f\n",
        s_DroppedPackets, s_pktPts.count(), ntp.count());
    }
    return;
  }

  // Decode and append the audio packet to the audio track
  const bool appended = DecodeAndAppendPacket(&g_Instance->m_AudioTrack,
    g_Instance->m_AudioSessionId.load(), g_Instance->m_OpusDecoder,
    reinterpret_cast<unsigned char*>(sampleData), sampleLength
  );
  CheckAudioLoad();

  // Update the estimated audio end time to prevent future overflow. Only for a packet that the player took: one that
  // the decoder failed on or that the player rejected puts no audio into its buffer, and counting a burst of them made
  // 'Limit audio delay' drop the good packets after it as the overflow of a buffer that was empty.
  if (appended) {
    s_estimatedAudioEnd = std::max(s_estimatedAudioEnd, ntp) + s_frameDuration;
  }
}

// NOTE: The capabilities are updated before every connection in ConnectionThreadFunc, as the
// Web Audio backend also announces CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION. The value
// below is the one used by the EMSS backend, which is the default audio backend.
AUDIO_RENDERER_CALLBACKS MoonlightInstance::s_ArCallbacks = {
  .init = MoonlightInstance::AudDecInit,
  .cleanup = MoonlightInstance::AudDecCleanup,
  .decodeAndPlaySample = MoonlightInstance::AudDecDecodeAndPlaySample,
  .capabilities = CAPABILITY_DIRECT_SUBMIT,
};
