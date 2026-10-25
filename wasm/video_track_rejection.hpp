#pragma once
// Message to the front end when the TV rejects every profile of the video track that StartupVidDecSetup() in
// wasm/wasmplayer.cpp offers it. It names the video format, e.g. "VideoTrackRejected: AV1 Main10,3840,2160,60", and
// handleMessage() in wasm/platform/messages.js keeps it for the stream termination with error -200 that follows, whose
// message then names the codec, resolution and frame rate that the TV rejected instead of the generic text. The header
// has no other dependencies, so the native tests can check it on its own (tests/native/video_track_rejection_test.cpp).

#include <string>

#include <Limelight.h>

// Name of the codec and profile of a video format for the messages to the user, e.g. "AV1 Main10", or "Unknown"
inline const char* GetVideoFormatName(int videoFormat) {
  if (videoFormat & VIDEO_FORMAT_H264) {
    return "H.264";
  } else if (videoFormat & VIDEO_FORMAT_H265) {
    return "HEVC";
  } else if (videoFormat & VIDEO_FORMAT_H265_MAIN10) {
    return "HEVC Main10";
  } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN8) {
    return "AV1";
  } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN10) {
    return "AV1 Main10";
  }
  return "Unknown";
}

// Message to the front end that the TV rejected the video track of a video format at a resolution and frame rate
inline std::string FormatVideoTrackRejectedMessage(int videoFormat, int width, int height, int fps) {
  return std::string("VideoTrackRejected: ") + GetVideoFormatName(videoFormat) + "," + std::to_string(width) + "," +
    std::to_string(height) + "," + std::to_string(fps);
}
