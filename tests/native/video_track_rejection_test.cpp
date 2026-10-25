// Pins the message of wasm/video_track_rejection.hpp, which wasm/wasmplayer.cpp sends to the front end when the TV
// rejects every profile of the video track: the name of each video format, and the message for the formats of
// tests/fixtures/video-track-rejections.tsv, which tests/unit/video-track-rejection.test.js checks against the reading
// side in wasm/platform/messages.js.

#include "video_track_rejection.hpp"
#include "test_support.h"

#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

struct RejectionCase {
  int videoFormat;
  int width;
  int height;
  int fps;
  std::string message;
};

// Split a line of the fixture at its tabs
static std::vector<std::string> SplitTabs(const std::string& line) {
  std::vector<std::string> fields;
  size_t start = 0;
  while (true) {
    const size_t tab = line.find('\t', start);
    fields.push_back(line.substr(start, tab == std::string::npos ? std::string::npos : tab - start));
    if (tab == std::string::npos) {
      return fields;
    }
    start = tab + 1;
  }
}

static std::vector<RejectionCase> ReadRejectionCases() {
  std::string path = __FILE__;
  path = path.substr(0, path.find_last_of('/') + 1) + "../fixtures/video-track-rejections.tsv";
  std::ifstream file(path);
  std::vector<RejectionCase> cases;
  std::string line;
  while (std::getline(file, line)) {
    if (line.empty() || line[0] == '#') {
      continue;
    }
    const std::vector<std::string> fields = SplitTabs(line);
    if (fields.size() != 5) {
      test_support::Check(false, "fixture line \"" + line + "\"", "expected 5 fields", __FILE__, __LINE__);
      continue;
    }
    cases.push_back({ static_cast<int>(std::strtol(fields[0].c_str(), nullptr, 16)), std::atoi(fields[1].c_str()),
                      std::atoi(fields[2].c_str()), std::atoi(fields[3].c_str()), fields[4] });
  }
  return cases;
}

static void TestFixtureMessages() {
  const std::vector<RejectionCase> cases = ReadRejectionCases();
  CHECK_EQ(cases.size(), 7u);
  for (const RejectionCase& entry : cases) {
    CHECK_EQ(FormatVideoTrackRejectedMessage(entry.videoFormat, entry.width, entry.height, entry.fps), entry.message);
  }
}

static void TestFormatNames() {
  // The video formats that the negotiation of moonlight-common-c picks from those that StartupVidDecSetup() offers
  CHECK_EQ(std::string(GetVideoFormatName(VIDEO_FORMAT_H264)), std::string("H.264"));
  CHECK_EQ(std::string(GetVideoFormatName(VIDEO_FORMAT_H265)), std::string("HEVC"));
  CHECK_EQ(std::string(GetVideoFormatName(VIDEO_FORMAT_H265_MAIN10)), std::string("HEVC Main10"));
  CHECK_EQ(std::string(GetVideoFormatName(VIDEO_FORMAT_AV1_MAIN8)), std::string("AV1"));
  CHECK_EQ(std::string(GetVideoFormatName(VIDEO_FORMAT_AV1_MAIN10)), std::string("AV1 Main10"));
  // A format that the app never offers
  CHECK_EQ(std::string(GetVideoFormatName(0)), std::string("Unknown"));
  CHECK_EQ(std::string(GetVideoFormatName(VIDEO_FORMAT_AV1_HIGH10_444)), std::string("Unknown"));
  CHECK_EQ(FormatVideoTrackRejectedMessage(0, 0, 0, 0), std::string("VideoTrackRejected: Unknown,0,0,0"));
}

static void TestNoSeparatorInNames() {
  // The front end splits the message at its commas, so no name may contain one
  for (int videoFormat : { VIDEO_FORMAT_H264, VIDEO_FORMAT_H265, VIDEO_FORMAT_H265_MAIN10, VIDEO_FORMAT_AV1_MAIN8, VIDEO_FORMAT_AV1_MAIN10, 0 }) {
    CHECK(std::string(GetVideoFormatName(videoFormat)).find(',') == std::string::npos);
  }
}

int main() {
  test_support::RunTest("message for the video formats of the fixture", TestFixtureMessages);
  test_support::RunTest("names of the video formats", TestFormatNames);
  test_support::RunTest("no comma in the names of the video formats", TestNoSeparatorInNames);
  return test_support::Summary();
}
