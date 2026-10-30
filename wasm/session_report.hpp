#pragma once
// The totals of a stream that the front end keeps as the report of the last session (Settings > About > System
// information, 'Last session', with hints in plain language from wasm/platform/diagnostics.js). VidDecCleanup() in
// wasm/wasmplayer.cpp gathers them when the stream ends and sends them as one small JSON object, e.g.
//   SessionReportMsg: {"durationMs":754000,"codec":"HEVC Main10","width":3840,"height":2160,"fps":60,...}
// so the front end never parses the text of the performance statistics, which only exists while they are shown. The
// figures are those of the session lines of the full statistics. The idea of a report at the end of a stream comes from
// the fork of samirmartins (moonlight-tizen, 1d8f2e3 and bcdcda5, diagnostics.js). The header has no other dependencies,
// so the native tests can check it on its own (tests/native/session_report_test.cpp).

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
};

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
  char json[512];
  const int length = std::snprintf(json, sizeof(json),
    "SessionReportMsg: {\"durationMs\":%llu,\"codec\":\"%s\",\"width\":%u,\"height\":%u,\"fps\":%u,\"bitrateKbps\":%u,"
    "\"frames\":%u,\"networkDroppedFrames\":%u,\"tvDroppedFrames\":%u,\"videoResets\":%u,\"recoveryKeyframes\":%u,"
    "\"fecRecoveredBlocks\":%u,\"fecFailures\":%u,\"heapTopMb\":%u,\"heapTotalMb\":%u,\"heapGrowthMb\":%u}",
    static_cast<unsigned long long>(report.durationMs), report.codec ? report.codec : "", report.width, report.height,
    report.fps, report.bitrateKbps, report.frames, report.networkDroppedFrames, report.tvDroppedFrames, report.videoResets,
    report.recoveryKeyframes, report.fecRecoveredBlocks, report.fecFailures, report.heapTopMb, report.heapTotalMb,
    report.heapGrowthMb);
  return length > 0 && length < static_cast<int>(sizeof(json)) ? std::string(json) : std::string();
}
