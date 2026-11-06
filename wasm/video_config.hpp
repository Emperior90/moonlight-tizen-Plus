#pragma once
// Rules of the video stream that the module asks the host and the TV for: the H.264 level of the video track that
// StartupVidDecSetup() in wasm/wasmplayer.cpp offers to the TV, and the color range that StartStream() in wasm/main.cpp
// requests from the host. The header has no other dependencies, so the native tests can check it on its own
// (tests/native/video_config_test.cpp).

#include <cstdint>

#include <Limelight.h>

// The limits of H.264 level 4.2 (Table A-1 of ITU-T H.264): the largest frame in macroblocks of 16 x 16 pixels (MaxFS)
// and the most macroblocks per second (MaxMBPS). They cover 1080p at up to 60 FPS. tv_profile.js has the same values
// (H264_LEVEL_LIMITS) for its decoder check and its warnings.
constexpr uint32_t kH264Level42MaxFrameMacroblocks = 8704;
constexpr uint32_t kH264Level42MaxMacroblocksPerSecond = 522240;

// Whether an H.264 stream of this resolution and frame rate is above level 4.2, e.g. 1440p at 60 FPS, 4K at 30 FPS or
// 1080p at 120 FPS. Samsung specifies H.264 up to level 5.1 for its UHD TVs, and a Q70D on Tizen 9 started 4K at 30 FPS
// only with level 5.1 in its codec string (brightcraft/moonlight-tizen discussion 166), so such a stream offers level
// 5.1 to the TV first. A stream up to 1080p at 60 FPS keeps level 4.2 alone, so that what works today stays the same.
inline bool ExceedsH264Level42(int width, int height, int fps) {
  if (width <= 0 || height <= 0 || fps <= 0) {
    return false;
  }
  const uint64_t frameMacroblocks = static_cast<uint64_t>((width + 15) / 16) * static_cast<uint64_t>((height + 15) / 16);
  return frameMacroblocks > kH264Level42MaxFrameMacroblocks ||
         frameMacroblocks * static_cast<uint64_t>(fps) > kH264Level42MaxMacroblocksPerSecond;
}

// The color range (COLOR_RANGE_FULL or COLOR_RANGE_LIMITED of moonlight-common-c) that the host is asked for, from the
// switch 'Full color range', the HDR switch and the video formats offered to the host. Sunshine writes the range into
// every stream, HDR included, and HDR10 is limited range, so a TV that ignored the flag in PQ mode would clip the detail
// in shadows and highlights. So a stream with HDR on in a 10-bit format always asks for the limited range, and the
// switch applies only while HDR is off. At 10 bits the limited range loses nothing visible.
inline int GetStreamColorRange(bool fullRange, bool hdrMode, int supportedVideoFormats) {
  if (hdrMode && (supportedVideoFormats & VIDEO_FORMAT_MASK_10BIT) != 0) {
    return COLOR_RANGE_LIMITED;
  }
  return fullRange ? COLOR_RANGE_FULL : COLOR_RANGE_LIMITED;
}
