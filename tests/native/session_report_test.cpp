// Checks the message with the totals of a stream (wasm/session_report.hpp) that the front end keeps as the report of the
// last session: the totals of each line of tests/fixtures/session-reports.tsv become exactly its message, which
// tests/unit/diagnostics.test.js reads back with the hints of the line, and the names of the video formats. That
// VidDecCleanup() sends it with the totals of the stream is checked in stats_overlay_test.cpp.

#include "../../wasm/session_report.hpp"

#include "test_support.h"

#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

// Split a line of the fixture at its tabs
static std::vector<std::string> SplitTabs(const std::string& line) {
  std::vector<std::string> fields;
  std::stringstream stream(line);
  std::string field;
  while (std::getline(stream, field, '\t')) {
    fields.push_back(field);
  }
  return fields;
}

static uint32_t Number(const std::string& text) {
  return static_cast<uint32_t>(std::strtoul(text.c_str(), nullptr, 10));
}

static void TestFixtureMessages() {
  std::string path = __FILE__;
  path = path.substr(0, path.find_last_of('/') + 1) + "../fixtures/session-reports.tsv";
  std::ifstream file(path);
  CHECK(file.good());
  std::string line;
  int checked = 0;
  while (std::getline(file, line)) {
    if (line.empty() || line[0] == '#') {
      continue;
    }
    const std::vector<std::string> fields = SplitTabs(line);
    if (fields.size() != 19) {
      test_support::Check(false, "fixture line \"" + line + "\"", "expected 19 fields", __FILE__, __LINE__);
      continue;
    }
    SessionReport report;
    report.durationMs = std::strtoull(fields[1].c_str(), nullptr, 10);
    report.codec = fields[2].c_str();
    report.width = Number(fields[3]);
    report.height = Number(fields[4]);
    report.fps = Number(fields[5]);
    report.bitrateKbps = Number(fields[6]);
    report.frames = Number(fields[7]);
    report.networkDroppedFrames = Number(fields[8]);
    report.tvDroppedFrames = Number(fields[9]);
    report.videoResets = Number(fields[10]);
    report.recoveryKeyframes = Number(fields[11]);
    report.fecRecoveredBlocks = Number(fields[12]);
    report.fecFailures = Number(fields[13]);
    report.heapTopMb = Number(fields[14]);
    report.heapTotalMb = Number(fields[15]);
    report.heapGrowthMb = Number(fields[16]);
    const std::string message = FormatSessionReportMessage(report);
    CHECK_EQ(message, fields[17]);
    checked++;
  }
  CHECK_EQ(checked, 7);
}

static void TestVideoFormatNames() {
  CHECK_EQ(std::string(VideoFormatReportName(0x0001)), std::string("H.264"));
  CHECK_EQ(std::string(VideoFormatReportName(0x0100)), std::string("HEVC"));
  CHECK_EQ(std::string(VideoFormatReportName(0x0200)), std::string("HEVC Main10"));
  CHECK_EQ(std::string(VideoFormatReportName(0x1000)), std::string("AV1"));
  CHECK_EQ(std::string(VideoFormatReportName(0x2000)), std::string("AV1 Main10"));
  // No format yet (no video arrived) or one the module doesn't stream
  CHECK_EQ(std::string(VideoFormatReportName(0)), std::string(""));
  CHECK_EQ(std::string(VideoFormatReportName(0x0004)), std::string(""));
}

int main() {
  test_support::RunTest("the totals of each fixture line become its message", TestFixtureMessages);
  test_support::RunTest("the names of the video formats in the report", TestVideoFormatNames);
  return test_support::Summary();
}
