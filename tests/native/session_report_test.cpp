// Checks the message with the totals of a stream (wasm/session_report.hpp) that the front end keeps as the report of the
// last session: the totals of each line of tests/fixtures/session-reports.tsv become exactly its message, which
// tests/unit/diagnostics.test.js reads back with the hints of the line, a duration beyond 32 bits is clamped, the
// message has room for the largest figures and for three more, with those of the audio thread and what the host
// offered for reference frame invalidation at its end, and the names of the video formats. Also the two rules of the
// figures that 2.3.1 added: which 30 s windows of the host frame rate count for its lowest window (not the first of a
// stream and not one of a paused host) and which of them are low, and which stats windows count for the highest
// average frame receive time. That VidDecCleanup() sends the message with the totals of the stream, and that the
// decoder path feeds these rules, is checked in stats_overlay_test.cpp.

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
  int hostsWithRfi = 0;
  int hostsWithLowWindows = 0;
  while (std::getline(file, line)) {
    if (line.empty() || line[0] == '#') {
      continue;
    }
    const std::vector<std::string> fields = SplitTabs(line);
    if (fields.size() != 31) {
      test_support::Check(false, "fixture line \"" + line + "\"", "expected 31 fields", __FILE__, __LINE__);
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
    report.hostFrameRateX100 = Number(fields[17]);
    report.hostProcessingLatencyX10 = Number(fields[18]);
    report.audioChannels = Number(fields[19]);
    report.audioLoadMsPerS = Number(fields[20]);
    report.audioLoadPeakMsPerS = Number(fields[21]);
    report.audioOverloadedWindows = Number(fields[22]);
    CHECK(fields[23] == "0" || fields[23] == "1");
    report.hostRfi = fields[23] == "1";
    report.hostFrameRateLowX100 = Number(fields[24]);
    report.hostWindows = Number(fields[25]);
    report.hostLowWindows = Number(fields[26]);
    report.receiveTimeX100 = Number(fields[27]);
    report.receiveTimePeakX100 = Number(fields[28]);
    const std::string message = FormatSessionReportMessage(report);
    CHECK_EQ(message, fields[29]);
    checked++;
    hostsWithRfi += report.hostRfi ? 1 : 0;
    hostsWithLowWindows += report.hostLowWindows > 0 ? 1 : 0;
  }
  CHECK_EQ(checked, 31);
  // Both answers of a host are written
  CHECK(hostsWithRfi > 0 && hostsWithRfi < checked);
  // Hosts with and without windows below the stream rate as well
  CHECK(hostsWithLowWindows > 0 && hostsWithLowWindows < checked);
}

// The new figures sit between those of the host and those of the audio thread, each under its own name, and a report
// that nobody filled in has them at 0
static void TestHostWindowsAndReceiveTime() {
  SessionReport report;
  report.codec = "HEVC";
  const std::string empty = FormatSessionReportMessage(report);
  CHECK(empty.find(",\"hostProcessingLatencyX10\":0,\"hostFrameRateLowX100\":0,\"hostWindows\":0,\"hostLowWindows\":0,"
                   "\"receiveTimeX100\":0,\"receiveTimePeakX100\":0,\"audioChannels\":0,") != std::string::npos);
  report.hostFrameRateLowX100 = 5090;
  report.hostWindows = 40;
  report.hostLowWindows = 6;
  report.receiveTimeX100 = 865;
  report.receiveTimePeakX100 = 1110;
  const std::string filled = FormatSessionReportMessage(report);
  CHECK(filled.find(",\"hostProcessingLatencyX10\":0,\"hostFrameRateLowX100\":5090,\"hostWindows\":40,\"hostLowWindows\":6,"
                    "\"receiveTimeX100\":865,\"receiveTimePeakX100\":1110,\"audioChannels\":0,") != std::string::npos);
}

// Which 30 s windows of the host frame rate count for the report, for a 60 FPS stream: a window has 1800 frames at the
// stream rate
static void TestHostRateWindows() {
  HostRateWindows windows;
  CHECK_EQ(windows.counted, 0u);
  CHECK_EQ(windows.lowest, 0.0f);
  // The first window of a stream doesn't count, however low: the desktop, the launcher, the loading of the game
  AddHostRateWindow(windows, 31.5f, 945, 0, 60);
  CHECK_EQ(windows.completed, 1u);
  CHECK_EQ(windows.counted, 0u);
  CHECK_EQ(windows.low, 0u);
  CHECK_EQ(windows.lowest, 0.0f);
  // A window at the rate of the stream, and one of a display at 59.94 Hz: they count and are not low
  AddHostRateWindow(windows, 60.0f, 1800, 0, 60);
  AddHostRateWindow(windows, 59.94f, 1798, 0, 60);
  CHECK_EQ(windows.counted, 2u);
  CHECK_EQ(windows.low, 0u);
  CHECK_EQ(windows.lowest, 59.94f);
  // A single late frame in 30 s is far from low: 1799 of 1800 frames
  AddHostRateWindow(windows, 59.97f, 1799, 0, 60);
  CHECK_EQ(windows.low, 0u);
  // The limit is 95 % of the stream rate: 57 of 60 frames per second is not low, a little less is
  AddHostRateWindow(windows, 57.0f, 1710, 0, 60);
  CHECK_EQ(windows.low, 0u);
  CHECK_EQ(windows.lowest, 57.0f);
  AddHostRateWindow(windows, 56.9f, 1707, 0, 60);
  CHECK_EQ(windows.low, 1u);
  // A game that renders 51 frames per second: the host sends no repeats for it
  AddHostRateWindow(windows, 50.9f, 1527, 0, 60);
  CHECK_EQ(windows.counted, 6u);
  CHECK_EQ(windows.low, 2u);
  CHECK_EQ(windows.lowest, 50.9f);
  // A few repeats (fewer than 5 % of the frames) still count: 20 of 1560
  AddHostRateWindow(windows, 51.3f, 1560, 20, 60);
  CHECK_EQ(windows.counted, 7u);
  CHECK_EQ(windows.low, 3u);
  // A paused host doesn't count, however low its rate of new images: a still picture (1 new image per second and 29
  // repeats), a video at 24 FPS (a repeat after every image) and exactly 5 % of repeats
  AddHostRateWindow(windows, 1.0f, 900, 870, 60);
  AddHostRateWindow(windows, 24.0f, 1440, 720, 60);
  AddHostRateWindow(windows, 47.5f, 1500, 75, 60);
  CHECK_EQ(windows.counted, 7u);
  CHECK_EQ(windows.low, 3u);
  CHECK_EQ(windows.lowest, 50.9f);
  CHECK_EQ(windows.completed, 11u);
  // Just below 5 % counts again, and a window without frames never does
  AddHostRateWindow(windows, 47.5f, 1500, 74, 60);
  CHECK_EQ(windows.counted, 8u);
  CHECK_EQ(windows.lowest, 47.5f);
  AddHostRateWindow(windows, 0.0f, 0, 0, 60);
  CHECK_EQ(windows.counted, 8u);
  CHECK_EQ(windows.lowest, 47.5f);

  // The limit follows the stream rate: 114 of 120 and 28.5 of 30 frames per second
  HostRateWindows fast;
  AddHostRateWindow(fast, 120.0f, 3600, 0, 120);
  AddHostRateWindow(fast, 114.0f, 3420, 0, 120);
  AddHostRateWindow(fast, 113.9f, 3417, 0, 120);
  CHECK_EQ(fast.counted, 2u);
  CHECK_EQ(fast.low, 1u);
  HostRateWindows slow;
  AddHostRateWindow(slow, 30.0f, 900, 0, 30);
  AddHostRateWindow(slow, 28.5f, 855, 0, 30);
  AddHostRateWindow(slow, 28.4f, 852, 0, 30);
  CHECK_EQ(slow.low, 1u);
  CHECK_EQ(slow.lowest, 28.4f);
}

// Which stats windows count for the highest average frame receive time: at least half the frames of the stream rate
static void TestReceiveTimeWindows() {
  CHECK(IsReceiveTimeWindowCounted(60, 60));
  CHECK(IsReceiveTimeWindowCounted(30, 60));
  CHECK(!IsReceiveTimeWindowCounted(29, 60));
  CHECK(!IsReceiveTimeWindowCounted(1, 60));
  CHECK(!IsReceiveTimeWindowCounted(0, 60));
  CHECK(IsReceiveTimeWindowCounted(60, 120));
  CHECK(!IsReceiveTimeWindowCounted(59, 120));
  CHECK(IsReceiveTimeWindowCounted(15, 30));
  CHECK(IsReceiveTimeWindowCounted(45, 90));
  CHECK(!IsReceiveTimeWindowCounted(44, 90));
  // A stream without a frame rate has no window that counts
  CHECK(!IsReceiveTimeWindowCounted(0, 0));
}

static bool EndsWith(const std::string& text, const std::string& end) {
  return text.size() >= end.size() && text.compare(text.size() - end.size(), end.size(), end) == 0;
}

// What the host offered is the last figure of the message, 1 or 0, and 0 for a report that nobody filled in
static void TestHostRfi() {
  SessionReport report;
  report.codec = "HEVC";
  CHECK(!report.hostRfi);
  const std::string without = FormatSessionReportMessage(report);
  CHECK(EndsWith(without, ",\"audioOverloadedWindows\":0,\"hostRfi\":0}"));
  report.hostRfi = true;
  const std::string with = FormatSessionReportMessage(report);
  CHECK(EndsWith(with, ",\"audioOverloadedWindows\":0,\"hostRfi\":1}"));
  // Nothing else changes
  CHECK_EQ(with.size(), without.size());
  CHECK_EQ(with.substr(0, with.size() - 2), without.substr(0, without.size() - 2));
}

// A duration beyond 32 bits (49 days) is reported as UINT32_MAX, since only 32-bit values go through snprintf
static void TestLongDurationIsClamped() {
  SessionReport report;
  report.durationMs = 5000000000ull;
  report.codec = "AV1";
  const std::string message = FormatSessionReportMessage(report);
  CHECK(message.find("{\"durationMs\":4294967295,\"codec\":\"AV1\",") != std::string::npos);
}

// The message has room for every figure at its largest, since a message that doesn't fit is not sent at all, and its
// buffer has room for three more figures with the longest name and the largest value of today
static void TestLargestFiguresFit() {
  SessionReport report;
  report.durationMs = UINT64_MAX;
  report.codec = "HEVC Main10";
  report.width = report.height = report.fps = report.bitrateKbps = report.frames = report.networkDroppedFrames =
    report.tvDroppedFrames = report.videoResets = report.recoveryKeyframes = report.fecRecoveredBlocks =
    report.fecFailures = report.heapTopMb = report.heapTotalMb = report.heapGrowthMb = report.hostFrameRateX100 =
    report.hostProcessingLatencyX10 = report.hostFrameRateLowX100 = report.hostWindows = report.hostLowWindows =
    report.receiveTimeX100 = report.receiveTimePeakX100 = report.audioChannels = report.audioLoadMsPerS =
    report.audioLoadPeakMsPerS = report.audioOverloadedWindows = UINT32_MAX;
  report.hostRfi = true;
  const std::string message = FormatSessionReportMessage(report);
  CHECK(message.find("SessionReportMsg: {\"durationMs\":4294967295,") == 0);
  CHECK(message.find(",\"hostFrameRateLowX100\":4294967295,\"hostWindows\":4294967295,\"hostLowWindows\":4294967295,"
                     "\"receiveTimeX100\":4294967295,\"receiveTimePeakX100\":4294967295,") != std::string::npos);
  CHECK(message.find(",\"audioChannels\":4294967295,\"audioLoadMsPerS\":4294967295,\"audioLoadPeakMsPerS\":4294967295,"
                     "\"audioOverloadedWindows\":4294967295,\"hostRfi\":1}") != std::string::npos);
  CHECK_EQ(message.back(), '}');
  // Every number of the report is in it at its largest: the 25 that are set above, and the duration
  size_t largest = 0;
  for (size_t at = message.find(":4294967295"); at != std::string::npos; at = message.find(":4294967295", at + 1)) {
    largest++;
  }
  CHECK_EQ(largest, static_cast<size_t>(26));
  // The longest message of today
  CHECK_EQ(message.size(), static_cast<size_t>(771));
  const size_t largestFigure = std::string(",\"hostProcessingLatencyX10\":4294967295").size();
  CHECK(message.size() + 3 * largestFigure < kSessionReportMessageSize);
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
  test_support::RunTest("a duration beyond 32 bits is clamped", TestLongDurationIsClamped);
  test_support::RunTest("the message has room for every figure at its largest and for three more", TestLargestFiguresFit);
  test_support::RunTest("what the host offered for reference frame invalidation ends the message", TestHostRfi);
  test_support::RunTest("the lowest host frame rate, its windows and the frame receive time are in the message",
    TestHostWindowsAndReceiveTime);
  test_support::RunTest("the windows of the host frame rate that count: not the first, not a paused host, low below 95 %",
    TestHostRateWindows);
  test_support::RunTest("the stats windows that count for the highest frame receive time", TestReceiveTimeWindows);
  test_support::RunTest("the names of the video formats in the report", TestVideoFormatNames);
  return test_support::Summary();
}
