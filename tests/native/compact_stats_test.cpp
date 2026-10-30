// Checks the levels of the performance statistics overlay and the message of its compact line (wasm/compact_stats.hpp):
// every press of the stats key (the remote, the Stream Menu, the gamepad combo and the keyboard combo all end up in
// TogglePerformanceStats() of wasm/wasmplayer.cpp) steps Off, Compact, Full, Off, also when two threads press at once,
// the level of the front end is clamped, and the figures become the message of tests/fixtures/compact-stats.tsv, which
// tests/unit/compact-stats.test.js reads on the side of the front end. The message of the full statistics starts with the
// point of their graph (tests/fixtures/stats-graph-points.tsv, read by tests/unit/stats-graph.test.js), then the text.

#include "compact_stats.hpp"
#include "test_support.h"

#include <cmath>
#include <cstdlib>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

struct CompactCase {
  CompactVideoStats stats;
  std::string codec;
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

static std::vector<CompactCase> ReadCompactCases() {
  std::string path = __FILE__;
  path = path.substr(0, path.find_last_of('/') + 1) + "../fixtures/compact-stats.tsv";
  std::ifstream file(path);
  std::vector<CompactCase> cases;
  std::string line;
  while (std::getline(file, line)) {
    if (line.empty() || line[0] == '#') {
      continue;
    }
    const std::vector<std::string> fields = SplitTabs(line);
    if (fields.size() != 13) {
      test_support::Check(false, "fixture line \"" + line + "\"", "expected 13 fields", __FILE__, __LINE__);
      continue;
    }
    CompactCase entry = {};
    entry.stats.width = (uint32_t)std::atoi(fields[0].c_str());
    entry.stats.height = (uint32_t)std::atoi(fields[1].c_str());
    entry.stats.fps = (uint32_t)std::atoi(fields[2].c_str());
    entry.codec = fields[3];
    entry.stats.tenBit = std::atoi(fields[4].c_str()) == 10;
    entry.stats.hdr = std::atoi(fields[5].c_str()) == 1;
    entry.stats.renderedFps = std::strtof(fields[6].c_str(), nullptr);
    entry.stats.bitrateMbps = std::strtof(fields[7].c_str(), nullptr);
    entry.stats.rttMs = (uint32_t)std::atoi(fields[8].c_str());
    entry.stats.networkDropPercent = std::strtof(fields[9].c_str(), nullptr);
    entry.stats.waitPacingMs = std::strtof(fields[10].c_str(), nullptr);
    entry.message = fields[11];
    cases.push_back(entry);
  }
  return cases;
}

static std::string Message(const CompactVideoStats& stats, size_t length = 256) {
  std::vector<char> output(length, 'x');
  const int written = FormatCompactStatsMessage(stats, output.data(), output.size());
  if (written < 0) {
    return "<too short>";
  }
  CHECK_EQ((size_t)written, std::string(output.data()).size());
  return std::string(output.data());
}

static void LevelsStepOffCompactFullOff() {
  CHECK_EQ(NextPerformanceStatsLevel(kPerformanceStatsOff), kPerformanceStatsCompact);
  CHECK_EQ(NextPerformanceStatsLevel(kPerformanceStatsCompact), kPerformanceStatsFull);
  CHECK_EQ(NextPerformanceStatsLevel(kPerformanceStatsFull), kPerformanceStatsOff);
  // CHECK_EQ evaluates its arguments twice, so each press is made once before the check
  std::atomic<int> level{kPerformanceStatsOff};
  int pressed = CyclePerformanceStatsLevel(level);
  CHECK_EQ(pressed, kPerformanceStatsCompact);
  CHECK_EQ(level.load(), kPerformanceStatsCompact);
  pressed = CyclePerformanceStatsLevel(level);
  CHECK_EQ(pressed, kPerformanceStatsFull);
  pressed = CyclePerformanceStatsLevel(level);
  CHECK_EQ(pressed, kPerformanceStatsOff);
  CHECK_EQ(level.load(), kPerformanceStatsOff);
  CHECK_EQ(FormatPerformanceStatsLevelMessage(kPerformanceStatsOff), std::string("StatLevelMsg: 0"));
  CHECK_EQ(FormatPerformanceStatsLevelMessage(kPerformanceStatsCompact), std::string("StatLevelMsg: 1"));
  CHECK_EQ(FormatPerformanceStatsLevelMessage(kPerformanceStatsFull), std::string("StatLevelMsg: 2"));
}

static void TheLevelOfTheFrontEndIsClamped() {
  // startStream() gets the setting of the front end: 0, 1 or 2, anything else is Off
  CHECK_EQ(ClampPerformanceStatsLevel(0), kPerformanceStatsOff);
  CHECK_EQ(ClampPerformanceStatsLevel(1), kPerformanceStatsCompact);
  CHECK_EQ(ClampPerformanceStatsLevel(2), kPerformanceStatsFull);
  CHECK_EQ(ClampPerformanceStatsLevel(3), kPerformanceStatsOff);
  CHECK_EQ(ClampPerformanceStatsLevel(-1), kPerformanceStatsOff);
  // An unknown level steps to Compact, like Off, and is reported as Off
  CHECK_EQ(NextPerformanceStatsLevel(7), kPerformanceStatsCompact);
  std::atomic<int> level{9};
  const int pressed = CyclePerformanceStatsLevel(level);
  CHECK_EQ(pressed, kPerformanceStatsCompact);
  CHECK_EQ(level.load(), kPerformanceStatsCompact);
  CHECK_EQ(FormatPerformanceStatsLevelMessage(5), std::string("StatLevelMsg: 0"));
}

static void EveryPressMovesOneLevelWhenTwoThreadsPress() {
  // The remote (main thread) and the gamepad combo (gamepad thread) press at the same time: no press may get lost or
  // count twice, so the levels the presses report are each level equally often, and the end level follows the count
  constexpr int kPressesPerThread = 30000;
  std::atomic<int> level{kPerformanceStatsOff};
  std::vector<int> counts[2] = {std::vector<int>(3, 0), std::vector<int>(3, 0)};
  std::vector<std::thread> threads;
  for (int t = 0; t < 2; t++) {
    threads.emplace_back([&level, &counts, t]() {
      for (int i = 0; i < kPressesPerThread; i++) {
        counts[t][CyclePerformanceStatsLevel(level)]++;
      }
    });
  }
  for (std::thread& thread : threads) {
    thread.join();
  }
  CHECK_EQ(level.load(), (2 * kPressesPerThread) % 3);
  for (int value = 0; value < 3; value++) {
    CHECK_EQ(counts[0][value] + counts[1][value], 2 * kPressesPerThread / 3);
  }
}

static void FixtureMessages() {
  std::vector<CompactCase> cases = ReadCompactCases();
  CHECK_EQ(cases.size(), 6u);
  for (CompactCase& entry : cases) {
    entry.stats.codec = entry.codec.c_str();
    CHECK_EQ(Message(entry.stats), entry.message);
  }
}

static void UnknownFiguresAndShortOutput() {
  CompactVideoStats stats = {};
  stats.width = 3840;
  stats.height = 2160;
  stats.fps = 60;
  stats.codec = "HEVC";
  stats.tenBit = true;
  stats.hdr = false;
  // Figures that are not numbers are left out as null, so that the JSON stays valid
  stats.renderedFps = std::nanf("");
  stats.bitrateMbps = HUGE_VALF;
  stats.networkDropPercent = -1.0f;
  stats.waitPacingMs = -0.5f;
  CHECK_EQ(Message(stats), std::string("StatCompactMsg: {\"w\":3840,\"h\":2160,\"fps\":60,\"codec\":\"HEVC\",\"bits\":10,\"hdr\":0,"
                                       "\"rfps\":null,\"mbps\":null,\"rtt\":null,\"drop\":null,\"delay\":null}"));
  // No codec yet
  stats.codec = nullptr;
  CHECK(Message(stats).find("\"codec\":\"\"") != std::string::npos);
  // The decoder thread formats into 256 bytes, which the longest message fits easily
  stats.codec = "H.264";
  stats.width = 4294967295u;
  stats.height = 4294967295u;
  stats.fps = 4294967295u;
  stats.renderedFps = 1e9f;
  stats.bitrateMbps = 1e9f;
  stats.rttMs = 4294967295u;
  stats.networkDropPercent = 100.0f;
  stats.waitPacingMs = 1e9f;
  CHECK(Message(stats, 256).size() < 256);
  CHECK_EQ(Message(stats, 40), std::string("<too short>"));
  std::vector<char> output(40, 'x');
  CHECK_EQ(FormatCompactStatsMessage(stats, output.data(), output.size()), -1);
  CHECK_EQ(std::string(output.data()), std::string(""));
}

// The points of tests/fixtures/stats-graph-points.tsv as { rtt, lost, first line of the message }
struct GraphCase {
  StatsGraphPoint point;
  std::string line;
};

static std::vector<GraphCase> ReadGraphCases() {
  std::string path = __FILE__;
  path = path.substr(0, path.find_last_of('/') + 1) + "../fixtures/stats-graph-points.tsv";
  std::ifstream file(path);
  std::vector<GraphCase> cases;
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
    GraphCase entry = {};
    entry.point.rttMs = (uint32_t)std::strtoul(fields[0].c_str(), nullptr, 10);
    entry.point.networkDroppedFrames = (uint32_t)std::strtoul(fields[1].c_str(), nullptr, 10);
    entry.line = fields[2];
    cases.push_back(entry);
  }
  return cases;
}

static void TheFullStatisticsStartWithThePointOfTheirGraph() {
  const std::vector<GraphCase> cases = ReadGraphCases();
  CHECK_EQ(cases.size(), 5u);
  for (const GraphCase& entry : cases) {
    // The point on the first line, the text unchanged after it
    CHECK_EQ(FormatFullStatsMessage(entry.point, "Video stream: 3840x2160\nPending frames: 0 (max 1)\n"),
             entry.line + "\nVideo stream: 3840x2160\nPending frames: 0 (max 1)\n");
  }
  // No text yet
  const StatsGraphPoint point = {7, 1};
  CHECK_EQ(FormatFullStatsMessage(point, nullptr), std::string("StatMsg: {\"rtt\":7,\"lost\":1}\n"));
}

int main() {
  test_support::RunTest("the levels step Off, Compact, Full, Off", LevelsStepOffCompactFullOff);
  test_support::RunTest("the level of the front end is clamped", TheLevelOfTheFrontEndIsClamped);
  test_support::RunTest("every press moves one level when two threads press at once", EveryPressMovesOneLevelWhenTwoThreadsPress);
  test_support::RunTest("the message of the figures of the fixture", FixtureMessages);
  test_support::RunTest("unknown figures and an output that is too short", UnknownFiguresAndShortOutput);
  test_support::RunTest("the full statistics start with the point of their graph", TheFullStatisticsStartWithThePointOfTheirGraph);
  return test_support::Summary();
}
