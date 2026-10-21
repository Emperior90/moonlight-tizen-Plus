#include "moonlight_wasm.hpp"

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <utility>
#include <vector>

#include <h264_stream.h>

#include <assert.h>
#include <pthread.h>
#include <unistd.h>

#include "samsung/wasm/elementary_audio_track_config.h"
#include "samsung/wasm/elementary_media_packet.h"
#include "samsung/wasm/elementary_video_track_config.h"
#include "samsung/html/html_media_element_listener.h"
#include "samsung/wasm/operation_result.h"

#define INITIAL_DECODE_BUFFER_LEN 1024 * 1024
#define MAX_SPS_EXTRA_SIZE 32

// Space reserved in an IDR frame for the HDR metadata SEI NAL units: two NAL units of at most
// 6 + 2 + 24 + 1 bytes and 6 + 2 + 4 + 1 bytes, plus the emulation prevention bytes within them
#define MAX_HDR_METADATA_SEI_SIZE 64

using std::chrono_literals::operator""s;
using std::chrono_literals::operator""ms;
using EmssReadyState = samsung::wasm::ElementaryMediaStreamSource::ReadyState;
using EmssOperationResult = samsung::wasm::OperationResult;
using EmssAsyncResult = samsung::wasm::OperationResult;
using HTMLAsyncResult = samsung::wasm::OperationResult;
using TimeStamp = samsung::wasm::Seconds;

static constexpr TimeStamp kFrameTimeMargin = 0.5ms;
static constexpr TimeStamp kPacingSpinTime = 1ms;
static constexpr TimeStamp kTimeWindow = 1s;
static constexpr uint32_t kSampleRate = 48000;

// Maximum time to wait for each step of the media pipeline setup. The TV normally completes each
// step well within a second, but never completes some of them when it doesn't support the stream.
static constexpr std::chrono::milliseconds kMediaSetupTimeout{5000};

// Maximum luma sample rate of HEVC and AV1 level 5.1, which covers 4K at up to 64 FPS. Faster
// streams (e.g. 4K at 90 or 120 FPS) need level 5.2, which the TVs with a 120 Hz panel decode,
// such as the S90C that supports HEVC and AV1 at 3840x2160 and 120 FPS.
static constexpr uint64_t kLevel51MaxLumaSampleRate = 534773760;

static uint32_t s_VideoFormat = 0;
static uint32_t s_Width = 0;
static uint32_t s_Height = 0;
static uint32_t s_Framerate = 0;

static std::vector<unsigned char> s_DecodeBuffer;

static TimeStamp s_frameDuration;
static TimeStamp s_pktPts;

static TimeStamp s_ptsDiff;
static TimeStamp s_lastSec;

// Pacing offset calculated from the previous time window, which a rise of the offset has to be supported by
static TimeStamp s_lastWindowOffset;

// Arrival times of the frames in the current pacing window relative to their presentation timestamps, in seconds
static std::vector<double> s_PacingLateness;

static std::chrono::time_point<std::chrono::steady_clock> s_firstAppend;
static std::chrono::time_point<std::chrono::steady_clock> s_lastTime;

static bool s_hasFirstFrame = false;
static bool s_FramePacingEnabled = false;
static bool s_HdrMetadataEnabled = false;

static uint32_t total_bytes = 0;
static int m_LastFrameNumber = 0;

// IDR frames received after the first one that the host sent to recover the stream, i.e. not the ones this
// client requested itself after a focus or track change (flagged from the main thread, consumed by the decoder thread)
static bool s_ReceivedFirstIdrFrame = false;
static uint32_t s_RecoveryIdrFrames = 0;
static std::atomic<bool> s_ExpectedIdrFrame{false};

static std::string s_StatString = "";

static VIDEO_STATS m_ActiveWndVideoStats;
static VIDEO_STATS m_LastWndVideoStats;
static VIDEO_STATS m_GlobalVideoStats;

MoonlightInstance::SourceListener::SourceListener(
  MoonlightInstance* instance
) : m_Instance(instance) {}

void MoonlightInstance::SourceListener::OnSourceOpen() {
  ClLogMessage("EMSS::OnOpen\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_EmssReadyState = EmssReadyState::kOpen;
  m_Instance->m_EmssStateChanged.notify_all();
}

void MoonlightInstance::SourceListener::OnSourceOpenPending() {
  ClLogMessage("EMSS::OnOpenPending\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_EmssReadyState = EmssReadyState::kOpenPending;
  m_Instance->m_EmssStateChanged.notify_all();
}

void MoonlightInstance::SourceListener::OnSourceClosed() {
  ClLogMessage("EMSS::OnClosed\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_EmssReadyState = EmssReadyState::kClosed;
  m_Instance->m_EmssStateChanged.notify_all();
}

MoonlightInstance::AudioTrackListener::AudioTrackListener(
  MoonlightInstance* instance
) : m_Instance(instance) {}

void MoonlightInstance::AudioTrackListener::OnTrackOpen() {
  ClLogMessage("AUDIO ElementaryMediaTrack::OnTrackOpen\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_AudioStarted = true;
  m_Instance->m_EmssAudioStateChanged.notify_all();
}

void MoonlightInstance::AudioTrackListener::OnTrackClosed(samsung::wasm::ElementaryMediaTrack::CloseReason) {
  ClLogMessage("AUDIO ElementaryMediaTrack::OnTrackClosed\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_AudioStarted = false;
}

void MoonlightInstance::AudioTrackListener::OnSessionIdChanged(samsung::wasm::SessionId new_session_id) {
  ClLogMessage("AUDIO ElementaryMediaTrack::OnSessionIdChanged\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_AudioSessionId.store(new_session_id);
}

MoonlightInstance::VideoTrackListener::VideoTrackListener(
  MoonlightInstance* instance
) : m_Instance(instance) {}

void MoonlightInstance::VideoTrackListener::OnTrackOpen() {
  ClLogMessage("VIDEO ElementaryMediaTrack::OnTrackOpen\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_VideoStarted = true;
  m_Instance->m_EmssVideoStateChanged.notify_all();
  RequestIdrFrame();
}

void MoonlightInstance::VideoTrackListener::OnTrackClosed(samsung::wasm::ElementaryMediaTrack::CloseReason) {
  ClLogMessage("VIDEO ElementaryMediaTrack::OnTrackClosed\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_VideoStarted = false;
}

void MoonlightInstance::VideoTrackListener::OnSessionIdChanged(samsung::wasm::SessionId new_session_id) {
  ClLogMessage("VIDEO ElementaryMediaTrack::OnSessionIdChanged\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_VideoSessionId.store(new_session_id);
}

void MoonlightInstance::DidChangeFocus(bool got_focus) {
  // Request an IDR frame to dump the frame queue that may have
  // built up from the GL pipeline being stalled.
  if (got_focus) {
    RequestIdrFrame();
  }
}

// Request an IDR frame for a reason other than recovering the stream, so the session stats don't count it as a recovery
void MoonlightInstance::RequestIdrFrame() {
  s_ExpectedIdrFrame.store(true);
  LiRequestIdrFrame();
}

// The host sends its HDR metadata over the control channel, which can arrive after the first IDR frame was
// submitted, or change when the host display switches HDR on mid-stream. The metadata SEI only goes into IDR
// frames, so request one when the metadata becomes available during the stream. Before the track is open,
// OnTrackOpen requests the IDR frame anyway.
void MoonlightInstance::ClSetHdrMode(bool enabled) {
  if (enabled && s_HdrMetadataEnabled && (s_VideoFormat & VIDEO_FORMAT_MASK_H265) &&
      g_Instance != nullptr && g_Instance->m_VideoStarted) {
    RequestIdrFrame();
  }
}

bool MoonlightInstance::InitializeRenderingSurface(int width, int height) {
  return true;
}

// Logs why a step of the media pipeline setup stopped waiting, and returns the error to report for it
int MoonlightInstance::MediaSetupWaitFailed(const char* step) {
  if (g_Instance->m_ConnectionCancelled) {
    ClLogMessage("Connection cancelled during %s wait\n", step);
    return -1;
  }
  ClLogMessage("Timed out after %lld ms during %s wait\n", (long long)kMediaSetupTimeout.count(), step);
  return ERROR_VIDEO_SETUP_FAILED;
}

int MoonlightInstance::StartupVidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags) {
  // Bind the media source to the media element
  g_Instance->m_MediaElement.SetSrc(g_Instance->m_Source.get());
  // Mark the source as attached, so that it gets closed if the connection fails from here on
  g_Instance->m_SourceAttached = true;
  ClLogMessage("Waiting to close\n");

  if (!g_Instance->WaitFor(&g_Instance->m_EmssStateChanged, [] {
    return g_Instance->m_EmssReadyState == EmssReadyState::kClosed;
  }, kMediaSetupTimeout)) {
    return MediaSetupWaitFailed("initial close");
  }
  ClLogMessage("Closed\n");

  // The Web Audio backend renders the audio itself in platform/audio.js, so the EMSS audio
  // track is only added when the EMSS backend is selected
  if (g_Instance->m_AudioBackend == AudioBackend::Emss) {
    samsung::wasm::ChannelLayout channelLayout; // Selected audio channel layout from audio config
    switch (CHANNEL_COUNT_FROM_AUDIO_CONFIGURATION(g_Instance->m_AudioConfig)) {
      case 2:
        channelLayout = samsung::wasm::ChannelLayout::kStereo; // Audio Channel: Stereo
        ClLogMessage("Selected channel layout for Stereo audio\n");
        break;
      case 6:
        channelLayout = samsung::wasm::ChannelLayout::k5_1; // Audio Channel: 5.1 Surround Sound
        ClLogMessage("Selected channel layout for 5.1 Surround audio\n");
        break;
      case 8:
        channelLayout = samsung::wasm::ChannelLayout::k7_1; // Audio Channel: 7.1 Surround Sound
        ClLogMessage("Selected channel layout for 7.1 Surround audio\n");
        break;
      default:
        ClLogMessage("Unable to select channel layout from audio configuration\n");
        break;
    }

    auto add_track_result = g_Instance->m_Source->AddTrack(
      samsung::wasm::ElementaryAudioTrackConfig {
        "audio/webm; codecs=\"pcm\"", // Audio Codec: Pulse Code Modulation (PCM) Profile
        {}, // Extradata: Empty
        samsung::wasm::DecodingMode::kHardware, // Decoding mode: Hardware
        samsung::wasm::SampleFormat::kS16, // Sample Format: 16-bit signed integer (S16)
        channelLayout, // Channel Layout: Stereo (2-CH), 5.1 Surround (6-CH), 7.1 Surround (8-CH)
        kSampleRate, // Sample Rate: 48 kHz (48000 Hz)
      }
    );
    if (add_track_result) {
      g_Instance->m_AudioTrack = std::move(*add_track_result);
      g_Instance->m_AudioTrack.SetListener(&g_Instance->m_AudioTrackListener);
    } else {
      // Fail now, because a track that was never added will never open
      ClLogMessage("The TV rejected the audio track\n");
      return -1;
    }
  }

  {
    // Streams that exceed the luma sample rate of level 5.1 (e.g. 4K at 120 FPS) offer level 5.2 first,
    // so that the TV sets up its decoder for the actual stream, and fall back to level 5.1 for TVs that
    // reject it. Streams up to 4K at 60 FPS keep using level 5.1 only, which all supported TVs accept.
    const bool needsLevel52 = (uint64_t)width * height * redrawRate > kLevel51MaxLumaSampleRate;
    std::vector<std::pair<const char*, const char*>> videoProfiles; // MIME-type and profile name, in order of preference
    if (videoFormat & VIDEO_FORMAT_H264) {
      // NOTE: Samsung TVs generally decode H.264 only up to level 4.2 (1080p), so higher resolutions should use HEVC or AV1
      videoProfiles.push_back({"video/mp4; codecs=\"avc1.64002A\"", "H.264 High Level Profile 4.2"});
    } else if (videoFormat & VIDEO_FORMAT_H265) {
      if (needsLevel52) {
        videoProfiles.push_back({"video/mp4; codecs=\"hev1.1.6.L156.B0\"", "HEVC Main Level Profile 5.2"});
      }
      videoProfiles.push_back({"video/mp4; codecs=\"hev1.1.6.L153.B0\"", "HEVC Main Level Profile 5.1"});
    } else if (videoFormat & VIDEO_FORMAT_H265_MAIN10) {
      if (needsLevel52) {
        videoProfiles.push_back({"video/mp4; codecs=\"hev1.2.4.L156.B0\"", "HEVC Main10 Level Profile 5.2"});
      }
      videoProfiles.push_back({"video/mp4; codecs=\"hev1.2.4.L153.B0\"", "HEVC Main10 Level Profile 5.1"});
    } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN8) {
      if (needsLevel52) {
        videoProfiles.push_back({"video/mp4; codecs=\"av01.0.14M.08\"", "AV1 Main Level Profile 5.2"});
      }
      videoProfiles.push_back({"video/mp4; codecs=\"av01.0.13M.08\"", "AV1 Main Level Profile 5.1"});
    } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN10) {
      if (needsLevel52) {
        videoProfiles.push_back({"video/mp4; codecs=\"av01.0.14M.10\"", "AV1 Main10 Level Profile 5.2"});
      }
      videoProfiles.push_back({"video/mp4; codecs=\"av01.0.13M.10\"", "AV1 Main10 Level Profile 5.1"});
    } else {
      ClLogMessage("Failed to select video codec profile (videoFormat=0x%x)\n", videoFormat);
      return -1;
    }

    bool videoTrackAdded = false;
    for (const auto& videoProfile : videoProfiles) {
      ClLogMessage("Video codec profile selected: %s\n", videoProfile.second);
      ClLogMessage("Using mimeType %s\n", videoProfile.first);
      auto add_track_result = g_Instance->m_Source->AddTrack(
        samsung::wasm::ElementaryVideoTrackConfig {
          videoProfile.first, // MIME-type: Selected Video Format
          {}, // Extradata: Empty
          samsung::wasm::DecodingMode::kHardware, // Decoding mode: Hardware
          static_cast<uint32_t>(width), // Video resolution: Width
          static_cast<uint32_t>(height), // Video resolution: Height
          static_cast<uint32_t>(redrawRate), // Framerate: Numerator
          1, // Framerate: Denominator
        }
      );
      if (add_track_result) {
        g_Instance->m_VideoTrack = std::move(*add_track_result);
        g_Instance->m_VideoTrack.SetListener(&g_Instance->m_VideoTrackListener);
        videoTrackAdded = true;
        break;
      }
      ClLogMessage("The TV rejected the video track (%s, %dx%d at %d FPS)\n", videoProfile.first, width, height, redrawRate);
    }
    if (!videoTrackAdded) {
      // Fail now, because a track that was never added will never open
      return ERROR_VIDEO_SETUP_FAILED;
    }
  }

  ClLogMessage("Inb4 source open\n");
  g_Instance->m_Source->Open([](EmssOperationResult){});
  if (!g_Instance->WaitFor(&g_Instance->m_EmssStateChanged, [] {
    return g_Instance->m_EmssReadyState == EmssReadyState::kOpenPending ||
           g_Instance->m_EmssReadyState == EmssReadyState::kOpen;
  }, kMediaSetupTimeout)) {
    return MediaSetupWaitFailed("open");
  }

  ClLogMessage("Source ready to open\n");
  g_Instance->m_MediaElement.Play([](EmssOperationResult err) {
    if (err != EmssOperationResult::kSuccess) {
      ClLogMessage("Play error\n");
    } else {
      ClLogMessage("Play success\n");
    }
  });

  ClLogMessage("Waiting to start\n");
  // Only the EMSS backend opens an audio track, so the Web Audio backend has nothing to wait for
  if (g_Instance->m_AudioBackend == AudioBackend::Emss) {
    if (!g_Instance->WaitFor(&g_Instance->m_EmssAudioStateChanged, [] {
      return g_Instance->m_AudioStarted.load();
    }, kMediaSetupTimeout)) {
      return MediaSetupWaitFailed("audio start");
    }
  }
  if (!g_Instance->WaitFor(&g_Instance->m_EmssVideoStateChanged, [] {
    return g_Instance->m_VideoStarted.load();
  }, kMediaSetupTimeout)) {
    return MediaSetupWaitFailed("video start");
  }

  ClLogMessage("Started\n");
  return 0;
}

int MoonlightInstance::VidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags) {
  ClLogMessage("Video decoding setup has started.\n");

  // Resize the decode buffer based on initial decode buffer length
  s_DecodeBuffer.resize(INITIAL_DECODE_BUFFER_LEN);

  // Set the video format, video resolution and video frame rate based on the input parameters
  s_VideoFormat = videoFormat;
  s_Width = width;
  s_Height = height;
  s_Framerate = redrawRate;

  // Calculate frame duration from the frame rate
  s_frameDuration = TimeStamp(1.0 / (float)redrawRate);

  // Initialize packet timestamp to zero
  s_pktPts = 0s;

  // Flag indicating whether this is the first frame of video to be decoded
  s_hasFirstFrame = false;

  // Initialize the last second timestamp to zero
  s_lastSec = 0s;

  // Initialize the timestamp difference to zero
  s_ptsDiff = 0s;
  s_lastWindowOffset = 0s;

  // Clear the frame arrival times of the pacing window from a previous stream
  s_PacingLateness.clear();
  s_PacingLateness.reserve(256);

  // Set the frame pacing flag based on instance configuration
  s_FramePacingEnabled = g_Instance->m_FramePacingEnabled;

  // Set the HDR metadata flag based on instance configuration
  s_HdrMetadataEnabled = g_Instance->m_HdrMetadataEnabled;

  // Preallocate space for the performance stats string
  s_StatString.resize(1500);

  // Clear active window video statistics to start fresh
  memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));

  // Clear last window video statistics from previous session
  memset(&m_LastWndVideoStats, 0, sizeof(m_LastWndVideoStats));

  // Reset global video statistics for new decoding session
  memset(&m_GlobalVideoStats, 0, sizeof(m_GlobalVideoStats));

  // Reset last frame number to prevent massive integer underflow on subsequent streams
  m_LastFrameNumber = 0;

  // Reset the received byte count so the bitrate doesn't include data from a previous stream
  total_bytes = 0;

  // Reset the recovery keyframe count so the session totals don't include a previous stream
  s_ReceivedFirstIdrFrame = false;
  s_RecoveryIdrFrames = 0;
  s_ExpectedIdrFrame.store(false);

  // Ensure that StartupVidDecSetup is called every time when VidDecSetup is invoked to reinitialize the media pipeline
  int initVidDec = StartupVidDecSetup(videoFormat, width, height, redrawRate, context, drFlags);

  // Check and handle errors from video decoding configuration and propagating failures
  if (initVidDec != 0) {
    ClLogMessage("Initialization of video decoding configuration failed: %d\n", initVidDec);
    return initVidDec;
  }

  return DR_OK;
}

void MoonlightInstance::VidDecCleanup(void) {
  // Clear the decode buffer
  s_DecodeBuffer.clear();

  // Shrink the decode buffer to fit its contents
  s_DecodeBuffer.shrink_to_fit();
}

// Write a value of the given number of bytes in big-endian byte order
static void WriteBigEndian(std::vector<unsigned char>& out, uint32_t value, int bytes) {
  for (int i = bytes - 1; i >= 0; --i) {
    out.push_back((unsigned char)((value >> (8 * i)) & 0xFF));
  }
}

// Write an HEVC prefix SEI NAL unit with a single SEI message in Annex B byte stream format, and return its size.
// The payload is copied with the emulation prevention bytes that keep it from forming a start code.
static size_t WriteSeiNalUnit(unsigned char* out, unsigned char payloadType, const std::vector<unsigned char>& payload) {
  size_t size = 0;

  // Start code prefix and the NAL unit header of a prefix SEI (type 39, layer 0, temporal id 0)
  out[size++] = 0x00;
  out[size++] = 0x00;
  out[size++] = 0x00;
  out[size++] = 0x01;
  out[size++] = 0x4E;
  out[size++] = 0x01;

  // The SEI message (payload type and size below 255 fit in one byte each) and the RBSP trailing bits
  std::vector<unsigned char> rbsp;
  rbsp.push_back(payloadType);
  rbsp.push_back((unsigned char)payload.size());
  rbsp.insert(rbsp.end(), payload.begin(), payload.end());
  rbsp.push_back(0x80);

  int zeroBytes = 0;
  for (unsigned char byte : rbsp) {
    // Insert an emulation prevention byte before a byte of 0x03 or less that follows two zero bytes
    if (zeroBytes >= 2 && byte <= 0x03) {
      out[size++] = 0x03;
      zeroBytes = 0;
    }
    out[size++] = byte;
    zeroBytes = (byte == 0x00) ? zeroBytes + 1 : 0;
  }

  return size;
}

// Write the HDR10 static metadata of the host as SEI NAL units (mastering display colour volume and, when
// available, content light level info), so that the TV can tone map the stream for the display the host
// renders for, and return the number of bytes written (at most MAX_HDR_METADATA_SEI_SIZE)
static size_t WriteHdrMetadataSei(unsigned char* out, const SS_HDR_METADATA& metadata) {
  size_t size = 0;

  // Mastering display colour volume (payload type 137): the primaries in green, blue, red order, the white
  // point, and the maximum and minimum luminance in units of 0.0001 cd/m2
  std::vector<unsigned char> masteringDisplay;
  for (int primary : {1, 2, 0}) {
    WriteBigEndian(masteringDisplay, metadata.displayPrimaries[primary].x, 2);
    WriteBigEndian(masteringDisplay, metadata.displayPrimaries[primary].y, 2);
  }
  WriteBigEndian(masteringDisplay, metadata.whitePoint.x, 2);
  WriteBigEndian(masteringDisplay, metadata.whitePoint.y, 2);
  WriteBigEndian(masteringDisplay, (uint32_t)metadata.maxDisplayLuminance * 10000, 4);
  WriteBigEndian(masteringDisplay, metadata.minDisplayLuminance, 4);
  size += WriteSeiNalUnit(&out[size], 137, masteringDisplay);

  // Content light level info (payload type 144): the maximum content and frame average light level in cd/m2
  if (metadata.maxContentLightLevel != 0 || metadata.maxFrameAverageLightLevel != 0) {
    std::vector<unsigned char> contentLightLevel;
    WriteBigEndian(contentLightLevel, metadata.maxContentLightLevel, 2);
    WriteBigEndian(contentLightLevel, metadata.maxFrameAverageLightLevel, 2);
    size += WriteSeiNalUnit(&out[size], 144, contentLightLevel);
  }

  return size;
}

// Calculate the time difference that the frame pacer releases the frames at, relative to their presentation
// timestamps, from the arrival times of the frames in the last time window. It covers the usual arrival jitter
// (the median plus three standard deviations, estimated from the median absolute deviation, so that a few
// stalled frames can't inflate it), which releases the frames at an even pace, and it's capped at half a frame
// above the median, so that frames skipped by the host within the window can't hold back the next window.
// Taking the time difference of whichever frame ended the window instead latched onto the delay of a stalled
// frame, and only recovered by the frame time margin per window, which held back every frame by up to tens of
// milliseconds over Wi-Fi.
static TimeStamp CalculatePacingOffset(std::vector<double>& lateness) {
  // Find the median arrival time, which is the usual phase of the frames
  std::nth_element(lateness.begin(), lateness.begin() + lateness.size() / 2, lateness.end());
  const double median = lateness[lateness.size() / 2];
  // Find the median absolute deviation, which estimates the jitter without being skewed by stalled frames
  for (double& value : lateness) {
    value = std::abs(value - median);
  }
  std::nth_element(lateness.begin(), lateness.begin() + lateness.size() / 2, lateness.end());
  const double jitter = 3.0 * 1.4826 * lateness[lateness.size() / 2];
  return TimeStamp(median + std::min(jitter, s_frameDuration.count() / 2));
}

int MoonlightInstance::VidDecSubmitDecodeUnit(PDECODE_UNIT decodeUnit) {
  // Check if video playback has not started
  if (!g_Instance->m_VideoStarted) {
    return DR_OK;
  }

  // Record when this thread picked up the frame, which is the end of its wait in the decode unit queue
  const uint64_t dequeueMs = LiGetMillis();

  // Declare variables for entry data, offset, and total length
  PLENTRY entry;
  unsigned int offset;
  unsigned int totalLength;

  // Build one packet from multiple data chunks
  totalLength = decodeUnit->fullLength;

  // HDR metadata is only inserted into the IDR frames of an HEVC stream, when the host provides it
  SS_HDR_METADATA hdrMetadata;
  bool insertHdrMetadata = s_HdrMetadataEnabled && decodeUnit->frameType == FRAME_TYPE_IDR &&
    (s_VideoFormat & VIDEO_FORMAT_MASK_H265) && LiGetHdrMetadata(&hdrMetadata) &&
    hdrMetadata.maxDisplayLuminance != 0 && hdrMetadata.displayPrimaries[0].x != 0;

  // Check if the frame type from the decoding unit is IDR frame
  if (decodeUnit->frameType == FRAME_TYPE_IDR) {
    // Add some extra space in case we need to do an SPS fixup
    totalLength += MAX_SPS_EXTRA_SIZE;
    // Add the space for the HDR metadata SEI NAL units
    totalLength += MAX_HDR_METADATA_SEI_SIZE;
  }

  // Ensure the decode buffer is large enough to hold the full packet
  if (totalLength > s_DecodeBuffer.size()) {
    // Resize decode buffer to accommodate the larger data
    s_DecodeBuffer.resize(totalLength);
  }

  // Initialize the entry pointer to the start of the buffer list
  entry = decodeUnit->bufferList;

  // Initialize the offset to 0 before starting to copy data
  offset = 0;

  // Iterate through the buffer list of video data entries
  while (entry != NULL) {
    // Insert the HDR metadata SEI NAL units after the parameter sets, right before the first slice of the frame
    if (insertHdrMetadata && entry->bufferType == BUFFER_TYPE_PICDATA) {
      offset += WriteHdrMetadataSei(&s_DecodeBuffer[offset], hdrMetadata);
      insertHdrMetadata = false;
    }
    // Copy the data of the current entry to the decode buffer at the specified offset
    memcpy(&s_DecodeBuffer[offset], entry->data, entry->length);
    // Update the offset based on the length of the copied data
    offset += entry->length;
    // Move to the next entry in the buffer list
    entry = entry->next;
  }

  // Get the current time
  auto now = std::chrono::steady_clock::now();

  // Check if this is the first video frame
  if (!s_hasFirstFrame) {
    // Record the time of the first frame
    s_firstAppend = std::chrono::steady_clock::now();
    // Update the flag to indicate that the first frame has been processed
    s_hasFirstFrame = true;
  }

  // Count the IDR frames after the first one that the host sent to recover the stream (e.g. after packet
  // loss), because each one is a visible hiccup in the session. The ones this client requested itself
  // after a focus or track change are expected and not counted.
  if (decodeUnit->frameType == FRAME_TYPE_IDR) {
    const bool expected = s_ExpectedIdrFrame.exchange(false);
    if (s_ReceivedFirstIdrFrame && !expected) {
      s_RecoveryIdrFrames++;
    }
    s_ReceivedFirstIdrFrame = true;
  }

  // Calculate the start of the pacing duration in milliseconds
  uint32_t pacingStart = LiGetMillis();

  // Check if the frame pacing is enabled
  if (s_FramePacingEnabled) {
    // Calculate the time elapsed since the first frame
    TimeStamp fromStart = now - s_firstAppend;
    // Record when the frame arrived relative to its presentation timestamp. This uses the time it was queued
    // rather than the time this thread got to it, so that the delay the pacer adds to the previous frames
    // doesn't feed back into the pace of the next ones.
    uint64_t queuedMs = dequeueMs > decodeUnit->enqueueTimeMs ? dequeueMs - decodeUnit->enqueueTimeMs : 0;
    s_PacingLateness.push_back((fromStart - TimeStamp(queuedMs / 1000.0) - s_pktPts).count());
    // Wait until the packet timestamp is within the frame time margin
    while (s_pktPts > fromStart - s_ptsDiff + kFrameTimeMargin) {
      // Calculate the remaining wait time until the packet timestamp is within the frame time margin
      TimeStamp waitTime = s_pktPts - (fromStart - s_ptsDiff + kFrameTimeMargin);
      // Sleep through most of the wait to free up the CPU for the other streaming threads,
      // and only spin for the final stretch in case the sleep wakes up late
      if (waitTime > kPacingSpinTime) {
        usleep(std::chrono::duration_cast<std::chrono::microseconds>(waitTime - kPacingSpinTime).count());
      }
      // Update the current time and recalculate the elapsed time
      now = std::chrono::steady_clock::now();
      fromStart = now - s_firstAppend;
    }
    // Synchronize packet presentation timing every time window
    if (fromStart > s_lastSec + kTimeWindow) {
      // Start the next time window from the current time
      s_lastSec = fromStart;
      // Update the time difference from the arrival times of the frames in the last time window. A rise is only
      // followed as far as the previous window supports it too, because the burst of frames delivered after a
      // network stall raises the offset of the window it lands in, which would hold back every frame of the next
      // window (and overflow the decode unit queue at 120 FPS). A permanent rise, e.g. after frames were lost,
      // shows up in two consecutive windows and is followed by the second one. A drop takes effect right away.
      const TimeStamp windowOffset = CalculatePacingOffset(s_PacingLateness);
      if (windowOffset > s_ptsDiff) {
        s_ptsDiff = std::max(s_ptsDiff, std::min(windowOffset, s_lastWindowOffset));
      } else {
        s_ptsDiff = windowOffset;
      }
      s_lastWindowOffset = windowOffset;
      s_PacingLateness.clear();
    }
  }

  // Calculate the end of the pacing duration in milliseconds
  uint32_t pacingEnd = LiGetMillis();

  // Measure total pacer time based on calculated pacing duration
  m_ActiveWndVideoStats.totalPacerTime += pacingEnd - pacingStart;

  // Update the timestamp of the last packet append
  s_lastTime = now;

  // Track the total number of bytes received by the decoding unit
  total_bytes += decodeUnit->fullLength;

  // Start performance stats collection if this is the first frame
  if (!m_LastFrameNumber) {
    // Record the timestamp when measurement started
    m_ActiveWndVideoStats.measurementStartTimestamp = LiGetMillis();
    m_LastFrameNumber = decodeUnit->frameNumber;
  } else {
    // Any frame number greater than the last frame number + 1 represents a dropped frame
    m_ActiveWndVideoStats.networkDroppedFrames += decodeUnit->frameNumber - (m_LastFrameNumber + 1);
    m_ActiveWndVideoStats.totalFrames += decodeUnit->frameNumber - (m_LastFrameNumber + 1);
    m_LastFrameNumber = decodeUnit->frameNumber;
  }

  // Get the current time in milliseconds to check whether the stats window has elapsed
  uint32_t nowMs = LiGetMillis();

  // Flip performance stats window roughly every second
  if (m_ActiveWndVideoStats.measurementStartTimestamp + 1000 < nowMs) {
    // Update performance stats overlay if it's enabled
    if (g_Instance->m_PerformanceStatsEnabled == true) {
      // Create a container to hold aggregated stats for display
      VIDEO_STATS lastTwoWndStats = {};
      // Calculate the bitrate in megabits per second from the bytes received over the actual length of this window
      lastTwoWndStats.receivedBitrate = (total_bytes * 8.0f) / ((nowMs - m_ActiveWndVideoStats.measurementStartTimestamp) * 1000.0f);
      // Add last window and current window to the aggregated stats
      AddVideoStats(m_LastWndVideoStats, lastTwoWndStats);
      AddVideoStats(m_ActiveWndVideoStats, lastTwoWndStats);
      // Convert the aggregated stats to a display string
      FormatVideoStats(lastTwoWndStats, s_StatString.data(), s_StatString.length());
      // Send the formatted stats string to the JS frontend for overlay display, without waiting
      // for the main thread, since that would hold up the next frames on this decoder thread
      PostToJsAsync(std::string("StatMsg: ") + s_StatString.data());
      // Clear the stats string buffer for the next use
      std::fill(s_StatString.begin(), s_StatString.end(), 0);
    }
    // Reset byte count for the next measurement interval, even while the overlay is hidden,
    // so that enabling the overlay mid-stream doesn't report every byte since the stream started
    total_bytes = 0;
    // Accumulate active window stats into global stats for overall tracking
    AddVideoStats(m_ActiveWndVideoStats, m_GlobalVideoStats);
    // Move current active stats to last window stats and reset active window stats for new interval
    memcpy(&m_LastWndVideoStats, &m_ActiveWndVideoStats, sizeof(m_ActiveWndVideoStats));
    memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));
    m_ActiveWndVideoStats.measurementStartTimestamp = LiGetMillis();
  }

  // Update min host processing latency if a valid value was provided
  if (decodeUnit->frameHostProcessingLatency != 0) {
    // Take the minimum of current min latency and new latency
    if (m_ActiveWndVideoStats.minHostProcessingLatency != 0) {
      m_ActiveWndVideoStats.minHostProcessingLatency = MIN(m_ActiveWndVideoStats.minHostProcessingLatency, decodeUnit->frameHostProcessingLatency);
    } else {
      m_ActiveWndVideoStats.minHostProcessingLatency = decodeUnit->frameHostProcessingLatency;
    }
    // Count how many frames included host processing latency data
    m_ActiveWndVideoStats.framesWithHostProcessingLatency += 1;
  }

  // Update max and total host processing latency
  m_ActiveWndVideoStats.maxHostProcessingLatency = MAX(m_ActiveWndVideoStats.maxHostProcessingLatency, decodeUnit->frameHostProcessingLatency);
  m_ActiveWndVideoStats.totalHostProcessingLatency += decodeUnit->frameHostProcessingLatency;

  // Count the received frame and increment total frames
  m_ActiveWndVideoStats.receivedFrames++;
  m_ActiveWndVideoStats.totalFrames++;

  // Create an ElementaryMediaPacket and start decoding with the decoded video data
  samsung::wasm::ElementaryMediaPacket pkt {
    s_pktPts, // presentation timestamp
    s_pktPts, // decoding timestamp
    s_frameDuration, // packet duration
    decodeUnit->frameType == FRAME_TYPE_IDR, // packet of frame type
    offset, // packet size
    s_DecodeBuffer.data(), // pointer to packet payload
    s_Width, // packet of width
    s_Height, // packet of height
    s_Framerate, // packet of framerate numerator
    1, // packet of framerate denominator
    g_Instance->m_VideoSessionId.load() // session identifier
  };

  // Track the time from the first to the last packet of this frame (its transfer over the network) and the
  // time the complete frame waited in the decode unit queue until this thread picked it up (with frame pacing
  // on, that includes the time this thread was still holding the previous frame when this one arrived early)
  m_ActiveWndVideoStats.totalReassemblyTime += (uint32_t)MAX(0, (int32_t)(decodeUnit->enqueueTimeMs - decodeUnit->receiveTimeMs));
  m_ActiveWndVideoStats.totalDecodeTime += (uint32_t)MAX(0, (int32_t)(dequeueMs - decodeUnit->enqueueTimeMs));
  m_ActiveWndVideoStats.decodedFrames++;

  // Calculate time before rendering
  uint32_t beforeRender = LiGetMillis();

  // Attempt to append the packet to the video track for rendering
  if (g_Instance->m_VideoTrack.AppendPacket(pkt)) {
    // Calculate time after rendering
    uint32_t afterRender = LiGetMillis();
    // Increment packet timestamp for next frame
    s_pktPts += s_frameDuration;
    // Track total render time and count rendered frames
    m_ActiveWndVideoStats.totalRenderTime += afterRender - beforeRender;
    m_ActiveWndVideoStats.renderedFrames++;
  } else {
    ClLogMessage("Append video packet failed\n");
    return DR_NEED_IDR;
  }

  return DR_OK;
}

void MoonlightInstance::AddVideoStats(VIDEO_STATS& src, VIDEO_STATS& dst) {
  // Accumulate video stats from src into dst for aggregated metrics
  dst.receivedFrames += src.receivedFrames;
  dst.decodedFrames += src.decodedFrames;
  dst.renderedFrames += src.renderedFrames;
  dst.totalFrames += src.totalFrames;
  dst.networkDroppedFrames += src.networkDroppedFrames;
  dst.totalReassemblyTime += src.totalReassemblyTime;
  dst.totalDecodeTime += src.totalDecodeTime;
  dst.totalPacerTime += src.totalPacerTime;
  dst.totalRenderTime += src.totalRenderTime;

  // Update minimum host processing latency if it's not set or if the source has a valid smaller value
  if (dst.minHostProcessingLatency == 0) {
    dst.minHostProcessingLatency = src.minHostProcessingLatency;
  } else if (src.minHostProcessingLatency != 0) {
    dst.minHostProcessingLatency = MIN(dst.minHostProcessingLatency, src.minHostProcessingLatency);
  }

  // Update the maximum host processing latency if the current source value is higher
  dst.maxHostProcessingLatency = MAX(dst.maxHostProcessingLatency, src.maxHostProcessingLatency);
  dst.totalHostProcessingLatency += src.totalHostProcessingLatency;
  dst.framesWithHostProcessingLatency += src.framesWithHostProcessingLatency;

  // Attempt to retrieve the latest estimated RTT and variance
  if (!LiGetEstimatedRttInfo(&dst.lastRtt, &dst.lastRttVariance)) {
    // Set RTTs to 0 if unavailable
    dst.lastRtt = 0;
    dst.lastRttVariance = 0;
  } else {
    // Our logic to determine if RTT is valid depends on us never
    // getting an RTT of 0. ENet currently ensures RTTs are >= 1.
    assert(dst.lastRtt > 0);
  }

  // Get the current time in milliseconds
  auto now = LiGetMillis();

  // Initialize the measurement start point if this is the first video stat window
  if (!dst.measurementStartTimestamp) {
    dst.measurementStartTimestamp = src.measurementStartTimestamp;
  }

  // Ensure the global measurement timestamp has already started first
  assert(dst.measurementStartTimestamp <= src.measurementStartTimestamp);

  // Compute frames per second metrics for various stages of the video pipeline
  dst.totalFps = (float)dst.totalFrames / ((float)(now - dst.measurementStartTimestamp) / 1000);
  dst.receivedFps = (float)dst.receivedFrames / ((float)(now - dst.measurementStartTimestamp) / 1000);
  dst.decodedFps = (float)dst.decodedFrames / ((float)(now - dst.measurementStartTimestamp) / 1000);
  dst.renderedFps = (float)dst.renderedFrames / ((float)(now - dst.measurementStartTimestamp) / 1000);
}

void MoonlightInstance::FormatVideoStats(VIDEO_STATS& stats, char* output, int length) {
  int ret;
  int offset = 0;
  const char* codecString;

  // Start with an empty string
  output[offset] = 0;

  // Determine the video format being used and assign a readable string
  switch (s_VideoFormat) {
    case VIDEO_FORMAT_H264: // H.264 codec
      codecString = "H.264";
      break;
    case VIDEO_FORMAT_H265: // HEVC codec
      codecString = "HEVC";
      break;
    case VIDEO_FORMAT_H265_MAIN10: // HEVC Main10 codec
      if (LiGetCurrentHostDisplayHdrMode()) {
        codecString = "HEVC 10-bit HDR";
      } else {
        codecString = "HEVC 10-bit SDR";
      }
      break;
    case VIDEO_FORMAT_AV1_MAIN8: // AV1 codec
      codecString = "AV1";
      break;
    case VIDEO_FORMAT_AV1_MAIN10: // AV1 Main10 codec
      if (LiGetCurrentHostDisplayHdrMode()) {
        codecString = "AV1 10-bit HDR";
      } else {
        codecString = "AV1 10-bit SDR";
      }
      break;
    default: // Unknown codec
      assert(false);
      codecString = "UNKNOWN";
      break;
  }

  // If there is a meaningful received frame rate, print basic stream info
  if (stats.receivedFps > 0) {
    if (codecString != nullptr) {
      // Print video resolution, frame rate, and codec name
      ret = snprintf(
        &output[offset], length - offset,
        "Video stream: %dx%d %.2f FPS (Codec: %s)\n",
        s_Width, s_Height, stats.totalFps, codecString
      );
      // Abort if string formatting failed or buffer overflowed
      if (ret < 0 || ret >= length - offset) {
        assert(false);
        return;
      }
      offset += ret;
    }

    // Print frame rates at various stages of the pipeline
    ret = snprintf(
      &output[offset], length - offset,
      "Incoming frame rate from network: %.2f FPS\n"
      "Decoding frame rate: %.2f FPS\n"
      "Rendering frame rate: %.2f FPS\n"
      "Incoming bitrate from network: %.2f Mbps\n",
      stats.receivedFps, stats.decodedFps, stats.renderedFps, stats.receivedBitrate
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Only display host processing latency if latency data exists
  if (stats.framesWithHostProcessingLatency > 0) {
    // Print min, max, and average host processing latency in milliseconds
    ret = snprintf(
      &output[offset], length - offset,
      "Host processing latency min/max/average: %.1f/%.1f/%.1f ms\n",
      (float)stats.minHostProcessingLatency / 10, (float)stats.maxHostProcessingLatency / 10,
      (float)stats.totalHostProcessingLatency / 10 / stats.framesWithHostProcessingLatency
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Show remaining statistics only if some frames have been rendered
  if (stats.renderedFrames != 0) {
    char rttString[32];
    // Format the round-trip time string
    if (stats.lastRtt != 0) {
      // Print the last RTT including variance in milliseconds
      snprintf(
        rttString, sizeof(rttString),
        "%u ms (variance: %u ms)",
        stats.lastRtt, stats.lastRttVariance
      );
    } else {
      // Otherwise, print as "N/A" if RTT is unavailable
      snprintf(rttString, sizeof(rttString), "N/A");
    }

    // Print detailed drop rates and the time a frame spends in each stage on the TV: the transfer of its
    // packets, the wait for the video thread, the frame pacing and the hand-over to the hardware decoder
    ret = snprintf(
      &output[offset], length - offset,
      "Frames dropped by your network connection: %.2f%%\n"
      "Average network latency: %s\n"
      "Average frame receive time: %.2f ms\n"
      "Average frame wait time: %.2f ms\n"
      "Average frame pacing delay: %.2f ms\n"
      "Average rendering time: %.2f ms\n"
      "Pending frames: %d\n",
      (float)stats.networkDroppedFrames / stats.totalFrames * 100,
      rttString,
      (float)stats.totalReassemblyTime / stats.decodedFrames,
      (float)stats.totalDecodeTime / stats.decodedFrames,
      (float)stats.totalPacerTime / stats.renderedFrames,
      (float)stats.totalRenderTime / stats.renderedFrames,
      LiGetPendingVideoFrames()
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Show the totals of the whole session, so that brief drops between the overlay updates aren't missed
  if (m_GlobalVideoStats.totalFrames != 0) {
    // Print the network frame drops and the recovery keyframes since the stream started
    ret = snprintf(
      &output[offset], length - offset,
      "Session frames dropped by network: %u (%.2f%%)\n"
      "Session recovery keyframes: %u\n",
      m_GlobalVideoStats.networkDroppedFrames,
      (float)m_GlobalVideoStats.networkDroppedFrames / m_GlobalVideoStats.totalFrames * 100,
      s_RecoveryIdrFrames
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }
}

void MoonlightInstance::TogglePerformanceStats() {
  // Toggle the performance stats overlay flag
  m_PerformanceStatsEnabled = !m_PerformanceStatsEnabled;

  // Notify the JS code that performance stats overlay is enabled or disabled
  if (m_PerformanceStatsEnabled) {
    PostToJs(std::string("StatMsg: ") + s_StatString.data());
  } else {
    PostToJs(std::string("NoStatMsg: "));
  }
}

bool MoonlightInstance::WaitFor(std::condition_variable* variable, std::function<bool()> condition, std::chrono::milliseconds timeout) {
  std::unique_lock<std::mutex> lock(m_Mutex);
  variable->wait_for(lock, timeout, [&]() { return m_ConnectionCancelled.load() || condition(); });
  // Report whether the condition was met, rather than the connection being cancelled or the wait timing out
  return !m_ConnectionCancelled.load() && condition();
}

DECODER_RENDERER_CALLBACKS MoonlightInstance::s_DrCallbacks = {
  .setup = MoonlightInstance::VidDecSetup,
  .cleanup = MoonlightInstance::VidDecCleanup,
  .submitDecodeUnit = MoonlightInstance::VidDecSubmitDecodeUnit,
  .capabilities = 0,
};
