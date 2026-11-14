#pragma once
// The totals of a stream that the front end keeps as the report of the last session (Settings > About > System
// information, 'Last session', with hints in plain language from wasm/platform/diagnostics.js). VidDecCleanup() in
// wasm/wasmplayer.cpp gathers them when the stream ends and sends them as one small JSON object, e.g.
//   SessionReportMsg: {"durationMs":754000,"codec":"HEVC Main10","width":3840,"height":2160,"fps":60,...}
// so the front end never parses the text of the performance statistics, which only exists while they are shown. The
// figures are those of the session lines of the full statistics, the load of the audio thread (audio_load.hpp), the
// frame rate of the host in its best and its lowest 30 s window, and the time a frame took to arrive. The idea of a
// report at the end of a stream comes from the fork of samirmartins (moonlight-tizen, 1d8f2e3 and bcdcda5,
// diagnostics.js). The header has no other dependencies, so the native tests can check it on its own
// (tests/native/session_report_test.cpp).

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

struct SessionReport {
  uint64_t durationMs = 0; // from the setup of the video decoder to the end of the stream
  const char* codec = ""; // the negotiated video format, e.g. "HEVC Main10" (VideoFormatReportName())
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps = 0;
  uint32_t bitrateKbps = 0; // the bitrate the stream asked the host for
  uint32_t frames = 0; // frames the host sent
  uint32_t networkDroppedFrames = 0;
  uint32_t tvDroppedFrames = 0; // frames the TV dropped itself (e.g. a full decode unit queue)
  uint32_t videoResets = 0; // resets of the video pipeline of moonlight-common-c
  uint32_t recoveryKeyframes = 0; // keyframes the host sent to recover the stream after a loss
  uint32_t fecRecoveredBlocks = 0; // losses that the parity packets repaired
  uint32_t fecFailures = 0; // losses that they couldn't repair
  uint32_t heapTopMb = 0; // top of the WASM heap at the end of the stream
  uint32_t heapTotalMb = 0; // the fixed size of the WASM memory
  uint32_t heapGrowthMb = 0; // growth of the heap during the stream
  // The highest frame rate of the host in a 30 s window of its capture times (UpdateHostFrameRate() in wasmplayer.cpp),
  // in hundredths of FPS, or 0 when no window was completed. A host captures at most one image per refresh of its
  // display, so the best window shows the refresh rate of the display, e.g. 5994 for 59.94 Hz, while static scenes, a
  // game capped below the stream and the minimum frame rate of Sunshine only lower the other windows.
  uint32_t hostFrameRateX100 = 0;
  // The average time the host needed to capture and encode a frame, in tenths of a millisecond (the unit of
  // frameHostProcessingLatency of moonlight-common-c), or 0 when the host sent none
  uint32_t hostProcessingLatencyX10 = 0;
  // The lowest frame rate of the host in a 30 s window that counts, in hundredths of FPS, with the number of these
  // windows and how many of them stayed below kHostRateLowPercent of the stream rate (HostRateWindows below), all 0
  // when none counted: unlike the best window, they show a host that delivered fewer frames than the stream asked for
  uint32_t hostFrameRateLowX100 = 0;
  uint32_t hostWindows = 0;
  uint32_t hostLowWindows = 0;
  // What the bitrate costs: the average time from the first to the last packet of a frame, in hundredths of a
  // millisecond, over the whole stream and in its highest stats window of about a second (0 without a frame, or without
  // a window that counts, IsReceiveTimeWindowCounted() below). It grows with the size of the frames and so with the
  // bitrate, and the front end shows it as a share of the time between two frames.
  uint32_t receiveTimeX100 = 0;
  uint32_t receiveTimePeakX100 = 0;
  // The audio stream: its channels (0 when no audio was decoded), and the work of the audio thread on it in
  // milliseconds per second of audio, decoding plus hand-over to the player, over the whole stream and in its busiest
  // window of 10 seconds (0 for a stream that ended before one), with the number of windows above the limit of an
  // overload (AudioLoadMonitor in audio_load.hpp)
  uint32_t audioChannels = 0;
  uint32_t audioLoadMsPerS = 0;
  uint32_t audioLoadPeakMsPerS = 0;
  uint32_t audioOverloadedWindows = 0;
  // Whether the host offered reference frame invalidation for this stream (LiHostSupportsReferenceFrameInvalidation()
  // of moonlight-common-c): only then can the setting of that name recover a loss without a keyframe, so only then
  // does the hint about recovery keyframes name it. Sunshine offers it with its NVENC encoder alone.
  bool hostRfi = false;
};

// The size of the buffer that the message is built in. The longest message, with every figure at its largest, has 771
// characters (tests/native/session_report_test.cpp checks that it fits with room for three more figures): a message that
// doesn't fit is not sent at all.
constexpr size_t kSessionReportMessageSize = 1024;

// The 30 s windows of the host frame rate that count for the lowest frame rate of the report. UpdateHostFrameRate() in
// wasmplayer.cpp completes a window and hands it to AddHostRateWindow(). Two kinds of windows say nothing about a host
// that can't keep up and are left out: the first window of a stream, with the desktop, the launcher and the loading of
// the game, and a window of a paused host, in which at least kHostRatePausedRepeatPercent of the frames were repeats of
// the previous image (a still picture, a video or a game far below the stream rate, where Sunshine fills up to its
// minimum frame rate). A window of 30 s doesn't trip on a single late frame: one missing frame of 1800 reads 59.97.
constexpr uint32_t kHostRateLowPercent = 95;
constexpr uint32_t kHostRatePausedRepeatPercent = 5;

struct HostRateWindows {
  uint32_t completed = 0; // every completed window of the stream, to tell its first one
  uint32_t counted = 0; // the windows that count
  uint32_t low = 0; // of these, the ones below kHostRateLowPercent of the stream rate
  float lowest = 0.0f; // the lowest frame rate of a window that counts, 0 without one
};

// Add a completed window: the rate of its new images in FPS, the frames the host sent in it (by their frame numbers)
// and how many of them were repeats, for a stream at streamFps
inline void AddHostRateWindow(HostRateWindows& windows, float rate, uint32_t frames, uint32_t repeats, uint32_t streamFps) {
  const bool first = windows.completed == 0;
  windows.completed++;
  if (first || frames == 0 ||
      static_cast<uint64_t>(repeats) * 100 >= static_cast<uint64_t>(frames) * kHostRatePausedRepeatPercent) {
    return;
  }
  if (windows.counted == 0 || rate < windows.lowest) {
    windows.lowest = rate;
  }
  windows.counted++;
  if (rate * 100.0f < static_cast<float>(streamFps * kHostRateLowPercent)) {
    windows.low++;
  }
}

// Whether a stats window of about a second counts for the highest average frame receive time of the report: one with at
// least half the frames of the stream rate, so that a few frames around a stall or of a host that sends little don't
// set the figure
inline bool IsReceiveTimeWindowCounted(uint32_t frames, uint32_t streamFps) {
  return frames > 0 && frames * 2 >= streamFps;
}

// Name of a video format of moonlight-common-c (the VIDEO_FORMAT_* values of Limelight.h) for the report
inline const char* VideoFormatReportName(int videoFormat) {
  switch (videoFormat) {
    case 0x0001: return "H.264"; // VIDEO_FORMAT_H264
    case 0x0100: return "HEVC"; // VIDEO_FORMAT_H265
    case 0x0200: return "HEVC Main10"; // VIDEO_FORMAT_H265_MAIN10
    case 0x1000: return "AV1"; // VIDEO_FORMAT_AV1_MAIN8
    case 0x2000: return "AV1 Main10"; // VIDEO_FORMAT_AV1_MAIN10
    default: return "";
  }
}

// The message to the front end with the totals of a session
inline std::string FormatSessionReportMessage(const SessionReport& report) {
  // Only 32-bit values go through the varargs of snprintf: a stream would need 49 days to pass UINT32_MAX ms
  const uint32_t durationMs = report.durationMs > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(report.durationMs);
  char json[kSessionReportMessageSize];
  const int length = std::snprintf(json, sizeof(json),
    "SessionReportMsg: {\"durationMs\":%u,\"codec\":\"%s\",\"width\":%u,\"height\":%u,\"fps\":%u,\"bitrateKbps\":%u,"
    "\"frames\":%u,\"networkDroppedFrames\":%u,\"tvDroppedFrames\":%u,\"videoResets\":%u,\"recoveryKeyframes\":%u,"
    "\"fecRecoveredBlocks\":%u,\"fecFailures\":%u,\"heapTopMb\":%u,\"heapTotalMb\":%u,\"heapGrowthMb\":%u,"
    "\"hostFrameRateX100\":%u,\"hostProcessingLatencyX10\":%u,\"hostFrameRateLowX100\":%u,\"hostWindows\":%u,"
    "\"hostLowWindows\":%u,\"receiveTimeX100\":%u,\"receiveTimePeakX100\":%u,\"audioChannels\":%u,"
    "\"audioLoadMsPerS\":%u,\"audioLoadPeakMsPerS\":%u,\"audioOverloadedWindows\":%u,\"hostRfi\":%u}",
    durationMs, report.codec ? report.codec : "", report.width, report.height,
    report.fps, report.bitrateKbps, report.frames, report.networkDroppedFrames, report.tvDroppedFrames, report.videoResets,
    report.recoveryKeyframes, report.fecRecoveredBlocks, report.fecFailures, report.heapTopMb, report.heapTotalMb,
    report.heapGrowthMb, report.hostFrameRateX100, report.hostProcessingLatencyX10, report.hostFrameRateLowX100,
    report.hostWindows, report.hostLowWindows, report.receiveTimeX100, report.receiveTimePeakX100, report.audioChannels,
    report.audioLoadMsPerS, report.audioLoadPeakMsPerS, report.audioOverloadedWindows, report.hostRfi ? 1u : 0u);
  return length > 0 && length < static_cast<int>(sizeof(json)) ? std::string(json) : std::string();
}
