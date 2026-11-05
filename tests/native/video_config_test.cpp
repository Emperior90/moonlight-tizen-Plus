// Pins the rules of wasm/video_config.hpp: which H.264 streams are above level 4.2, for which StartupVidDecSetup() in
// wasm/wasmplayer.cpp offers level 5.1 to the TV first (streams up to 1080p at 60 FPS keep level 4.2 alone), and the
// color range that StartStream() in wasm/main.cpp asks the host for: the switch 'Full color range' applies only while HDR
// is off, and a stream with HDR on in a 10-bit format always asks for the limited range. tests/unit/runtime-checks.test.js
// checks that tv_profile.js has the same limits of level 4.2.

#include "video_config.hpp"
#include "test_support.h"

static void StreamsUpTo1080pAt60FpsStayAtLevel42() {
  CHECK(!ExceedsH264Level42(1920, 1080, 60));
  CHECK(!ExceedsH264Level42(1920, 1080, 30));
  CHECK(!ExceedsH264Level42(1280, 720, 60));
  CHECK(!ExceedsH264Level42(854, 480, 60));
  // 720p stays within the macroblocks per second of level 4.2 up to 120 FPS
  CHECK(!ExceedsH264Level42(1280, 720, 120));
  // A frame of 1080p takes 120 x 68 macroblocks, since 1080 lines need 68 rows of 16
  CHECK(!ExceedsH264Level42(1920, 1088, 60));
}

static void LargerOrFasterStreamsAreAboveLevel42() {
  // Larger frames than level 4.2 allows (8704 macroblocks), at any frame rate
  CHECK(ExceedsH264Level42(2560, 1440, 30));
  CHECK(ExceedsH264Level42(2560, 1440, 60));
  CHECK(ExceedsH264Level42(3200, 1800, 30));
  CHECK(ExceedsH264Level42(3840, 2160, 30));
  CHECK(ExceedsH264Level42(3840, 2160, 60));
  // More macroblocks per second than level 4.2 allows (522240)
  CHECK(ExceedsH264Level42(1920, 1080, 90));
  CHECK(ExceedsH264Level42(1920, 1080, 120));
  // The limits themselves (Table A-1 of ITU-T H.264)
  CHECK_EQ(kH264Level42MaxFrameMacroblocks, 8704u);
  CHECK_EQ(kH264Level42MaxMacroblocksPerSecond, 522240u);
}

static void InvalidValuesAreNotAboveLevel42() {
  CHECK(!ExceedsH264Level42(0, 1080, 60));
  CHECK(!ExceedsH264Level42(3840, 0, 60));
  CHECK(!ExceedsH264Level42(3840, 2160, 0));
  CHECK(!ExceedsH264Level42(-3840, 2160, 60));
}

static void FullRangeAppliesOnlyWhileHdrIsOff() {
  // HDR off: the switch decides, for 8-bit and for 10-bit formats
  CHECK_EQ(GetStreamColorRange(true, false, VIDEO_FORMAT_H265), COLOR_RANGE_FULL);
  CHECK_EQ(GetStreamColorRange(true, false, VIDEO_FORMAT_H264), COLOR_RANGE_FULL);
  CHECK_EQ(GetStreamColorRange(true, false, VIDEO_FORMAT_AV1_MAIN8 | VIDEO_FORMAT_H265), COLOR_RANGE_FULL);
  CHECK_EQ(GetStreamColorRange(false, false, VIDEO_FORMAT_H265), COLOR_RANGE_LIMITED);
  // HDR on with a 10-bit format, also with the HEVC Main10 fallback of AV1: always the limited range
  CHECK_EQ(GetStreamColorRange(true, true, VIDEO_FORMAT_H265_MAIN10), COLOR_RANGE_LIMITED);
  CHECK_EQ(GetStreamColorRange(true, true, VIDEO_FORMAT_AV1_MAIN10 | VIDEO_FORMAT_H265_MAIN10), COLOR_RANGE_LIMITED);
  CHECK_EQ(GetStreamColorRange(true, true, VIDEO_FORMAT_H265_MAIN10), COLOR_RANGE_LIMITED);
  CHECK_EQ(GetStreamColorRange(false, true, VIDEO_FORMAT_AV1_MAIN10), COLOR_RANGE_LIMITED);
  // HDR on without a 10-bit format (H.264, which has no HDR): the switch decides, as before
  CHECK_EQ(GetStreamColorRange(true, true, VIDEO_FORMAT_H264), COLOR_RANGE_FULL);
  CHECK_EQ(GetStreamColorRange(false, true, VIDEO_FORMAT_H264), COLOR_RANGE_LIMITED);
}

int main() {
  test_support::RunTest("H.264 streams up to 1080p at 60 FPS stay at level 4.2", StreamsUpTo1080pAt60FpsStayAtLevel42);
  test_support::RunTest("larger or faster H.264 streams are above level 4.2", LargerOrFasterStreamsAreAboveLevel42);
  test_support::RunTest("invalid sizes and frame rates are not above level 4.2", InvalidValuesAreNotAboveLevel42);
  test_support::RunTest("Full color range applies only while HDR is off", FullRangeAppliesOnlyWhileHdrIsOff);
  return test_support::Summary();
}
