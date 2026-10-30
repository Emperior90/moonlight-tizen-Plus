// Checks the performance statistics overlay in the video decoder path (wasm/wasmplayer.cpp, included directly): every
// call of TogglePerformanceStats() (the remote, the Stream Menu, the gamepad combo and the keyboard combo) steps the
// level Off, Compact, Full, Off and reports it to the front end; at each stats window VidDecSubmitDecodeUnit() sends
// nothing while the level is Off, the figures of the compact line while it is Compact, and the text of the full
// statistics with the regularity of the frame intervals of the host and the video player while it is Full, after the
// point of their graph (the round-trip time and the frames lost on the network in the window that just ended); and when the
// stream ends, VidDecCleanup() sends the totals of the session for its report (wasm/session_report.hpp). The functions
// below stand in for moonlight-common-c and the rest of the module; LiGetMillis() follows a clock of the test.
// VidDecSetup() waits for the media pipeline of the TV, so the test sets up the state of a stream the same way instead
// (StartStream() below).

#include "../../wasm/wasmplayer.cpp"

#include "test_support.h"

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

AudioStreamStats g_AudioStreamStats;
MoonlightInstance* g_Instance = nullptr;

// The test sets two members of the instance that the module writes itself: that the video track is open and the level of
// the overlay. They are private, and an explicit template instantiation is the one place where C++ lets code name a
// private member, so PrivateMember hands out pointers to them.
template <typename Tag, typename Tag::Type Member>
struct PrivateMember {
  friend typename Tag::Type Pointer(Tag) {
    return Member;
  }
};
struct VideoStartedMember {
  using Type = std::atomic<bool> MoonlightInstance::*;
  friend Type Pointer(VideoStartedMember);
};
struct StatsLevelMember {
  using Type = std::atomic<int> MoonlightInstance::*;
  friend Type Pointer(StatsLevelMember);
};
struct StreamConfigMember {
  using Type = STREAM_CONFIGURATION MoonlightInstance::*;
  friend Type Pointer(StreamConfigMember);
};
template struct PrivateMember<VideoStartedMember, &MoonlightInstance::m_VideoStarted>;
template struct PrivateMember<StreamConfigMember, &MoonlightInstance::m_StreamConfig>;
template struct PrivateMember<StatsLevelMember, &MoonlightInstance::m_PerformanceStatsLevel>;

static std::atomic<int>& StatsLevel() {
  return g_Instance->*Pointer(StatsLevelMember());
}

static uint64_t nowMs = 0;
static std::vector<std::string> posted;
static std::vector<std::string> postedAsync;

uint64_t LiGetMillis(void) {
  return nowMs;
}
void LiRequestIdrFrame(void) {}
bool LiGetHdrMetadata(PSS_HDR_METADATA) {
  return false;
}
uint32_t LiGetClientVideoResets(void) {
  return 0;
}
uint32_t LiGetClientDroppedVideoFrames(void) {
  return 0;
}
int LiGetPendingVideoFrames(void) {
  return 0;
}
bool LiGetEstimatedRttInfo(uint32_t* estimatedRtt, uint32_t* estimatedRttVariance) {
  *estimatedRtt = 3;
  *estimatedRttVariance = 1;
  return true;
}
bool LiGetCurrentHostDisplayHdrMode(void) {
  return true;
}
void LiGetVideoNetworkStats(PVIDEO_NETWORK_STATS stats) {
  std::memset(stats, 0, sizeof(*stats));
}
void LiTerminateConnectionAsync(int) {}
void PostToJs(std::string message) {
  posted.push_back(message);
}
void PostToJsAsync(std::string message) {
  postedAsync.push_back(message);
}
void MoonlightInstance::ClLogMessage(const char*, ...) {}
void MoonlightInstance::CancelPendingSetup() {}
void MoonlightInstance::OnConnectionStopped(uint32_t) {}

// The instance and the decoder state of a running 4K60 HEVC Main10 stream at the given level, as StartStream() and
// VidDecSetup() leave them. The instance is never constructed (the vptr check of UBSan is off for this reason, see
// run.sh).
static void StartStream(int level) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  std::memset(storage, 0, sizeof(storage));
  g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  g_Instance->*Pointer(VideoStartedMember()) = true;
  StatsLevel() = level;
  posted.clear();
  postedAsync.clear();
  nowMs = 100000;

  s_VideoFormat = VIDEO_FORMAT_H265_MAIN10;
  s_Width = 3840;
  s_Height = 2160;
  s_Framerate = 60;
  s_frameDuration = TimeStamp(1.0 / 60);
  s_pktPts = 0s;
  s_FramePacingEnabled = false;
  s_HdrMetadataEnabled = false;
  s_DecodeBuffer.resize(INITIAL_DECODE_BUFFER_LEN);
  s_StatString.assign(4096, 0);
  ResetFrameIntervalClock(s_HostIntervalClock);
  ResetFrameIntervalClock(s_PlayerIntervalClock);
  for (int i = 0; i < 2; i++) {
    ResetFrameIntervals(s_HostIntervals[i]);
    ResetFrameIntervals(s_PlayerIntervals[i]);
  }
  memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));
  memset(&m_LastWndVideoStats, 0, sizeof(m_LastWndVideoStats));
  memset(&m_GlobalVideoStats, 0, sizeof(m_GlobalVideoStats));
  m_LastFrameNumber = 0;
  total_bytes = 0;
  s_ReceivedFirstIdrFrame = false;
  s_RecoveryIdrFrames = 0;
  s_SessionTvDroppedFrames = 0;
  s_SessionStartMs = nowMs;
  (g_Instance->*Pointer(StreamConfigMember())).bitrate = 75000;
  s_HostRateWindowOpen = false;
  s_HostFrameRate = 0.0f;
  s_TerminatingStream = false;
}

// Submit one frame of 100 KB that the host captured at captureMs, or encoded again without a new image (a repeat: no
// host processing latency, and a send time instead of a capture time)
static void SubmitFrame(int frameNumber, unsigned int captureMs, bool repeat) {
  static char data[100000];
  LENTRY entry = {};
  entry.data = data;
  entry.length = sizeof(data);
  entry.bufferType = BUFFER_TYPE_PICDATA;
  DECODE_UNIT unit = {};
  unit.frameNumber = frameNumber;
  unit.frameType = frameNumber == 1 ? FRAME_TYPE_IDR : FRAME_TYPE_PFRAME;
  unit.frameHostProcessingLatency = repeat ? 0 : 40;
  unit.presentationTimeMs = captureMs;
  // The last packet came 1 ms after the first, and the frame waited 2 ms for the decoder thread
  unit.receiveTimeMs = nowMs - 3;
  unit.enqueueTimeMs = nowMs - 2;
  unit.fullLength = sizeof(data);
  unit.bufferList = &entry;
  // (CHECK_EQ evaluates its arguments twice)
  const int result = MoonlightInstance::VidDecSubmitDecodeUnit(&unit);
  CHECK_EQ(result, DR_OK);
}

// Submit the next frames of a steady 60 FPS host, whose capture times come in whole milliseconds, delayed by delayMs.
// The clock of the TV follows the capture times. Every repeatEvery-th frame (0 for none) is a repeat, sent 5 ms after
// the capture time it would have had.
static int nextFrame = 1;
static void SubmitFrames(int count, unsigned int delayMs = 0, int repeatEvery = 0) {
  for (int i = 0; i < count; i++, nextFrame++) {
    const unsigned int captureMs = (unsigned int)(nextFrame * 1000 / 60) + delayMs;
    nowMs = 100000 + captureMs;
    const bool repeat = repeatEvery != 0 && nextFrame % repeatEvery == 0;
    SubmitFrame(nextFrame, captureMs + (repeat ? 5 : 0), repeat);
  }
}

static bool StartsWith(const std::string& text, const std::string& prefix) {
  return text.compare(0, prefix.size(), prefix) == 0;
}

static void EachToggleStepsOneLevelAndReportsIt() {
  StartStream(kPerformanceStatsOff);
  for (int expected : {kPerformanceStatsCompact, kPerformanceStatsFull, kPerformanceStatsOff, kPerformanceStatsCompact}) {
    g_Instance->TogglePerformanceStats();
    CHECK_EQ(StatsLevel().load(), expected);
  }
  const std::vector<std::string> expected = {"StatLevelMsg: 1", "StatLevelMsg: 2", "StatLevelMsg: 0", "StatLevelMsg: 1"};
  CHECK(posted == expected);
  // The toggle sends no figures of its own: they follow from the decoder thread at the next stats window
  CHECK(postedAsync.empty());
}

static void NothingWhileTheLevelIsOff() {
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  SubmitFrames(200);
  CHECK(postedAsync.empty());
  CHECK(posted.empty());
}

static void CompactLevelSendsTheFiguresOnly() {
  StartStream(kPerformanceStatsCompact);
  nextFrame = 1;
  SubmitFrames(200);
  CHECK(!postedAsync.empty());
  for (const std::string& message : postedAsync) {
    CHECK(StartsWith(message, "StatCompactMsg: {\"w\":3840,\"h\":2160,\"fps\":60,\"codec\":\"HEVC\",\"bits\":10,\"hdr\":1,\"rfps\":"));
    CHECK(message.find("StatMsg") == std::string::npos);
  }
  // The figures of the last two windows: 60 frames per second of 100 KB each (48 Mbps), the RTT, no frame lost on the
  // network, and the 2 ms each frame waited for the decoder thread plus no frame pacing (it is off)
  const std::string& last = postedAsync.back();
  CHECK(last.find("\"mbps\":48.0,\"rtt\":3,\"drop\":0.00,\"delay\":2.0}") != std::string::npos);
  const size_t fps = last.find("\"rfps\":") + 7;
  const double rendered = std::atof(last.c_str() + fps);
  CHECK(rendered > 59.5 && rendered < 60.5);
}

static void FullLevelSendsTheTextWithTheFrameIntervals() {
  StartStream(kPerformanceStatsFull);
  nextFrame = 1;
  // Every 10th frame is a repeat without a capture time, which the host intervals leave out
  SubmitFrames(200, 0, 10);
  CHECK(!postedAsync.empty());
  const std::string& last = postedAsync.back();
  // The point of the graph first: the RTT and no frame lost on the network in the last window
  CHECK(StartsWith(last, "StatMsg: {\"rtt\":3,\"lost\":0}\nVideo stream: 3840x2160 "));
  CHECK(last.find("(Codec: HEVC 10-bit HDR)") != std::string::npos);
  CHECK(last.find("\nAverage frame wait time: 2.00 ms\n") != std::string::npos);
  // The capture times of a steady 60 FPS host in whole milliseconds alternate 16 and 17 ms
  CHECK(last.find("\nHost frame intervals: deviation 0.4") != std::string::npos);
  CHECK(last.find("ms, p95 17.0 ms, 0.0% off cadence\n") != std::string::npos);
  // The player line follows the real clock of the test, which submits the frames at once
  CHECK(last.find("\nTV player frame intervals: deviation ") != std::string::npos);
  // The lines come after the averages of the frame times, before the session totals
  CHECK(last.find("Host frame intervals:") > last.find("Pending frames:"));
  CHECK(last.find("TV player frame intervals:") < last.find("Session frames dropped by network:"));
  for (const std::string& message : postedAsync) {
    CHECK(StartsWith(message, "StatMsg: "));
  }
}

static void TheIntervalWindowsFollowTheStatsWindows() {
  // The lines cover the last two stats windows: a stall of the host shows at the next two windows, then drops out
  StartStream(kPerformanceStatsFull);
  nextFrame = 1;
  SubmitFrames(130);
  CHECK(postedAsync.back().find("Host frame intervals: deviation 0.4") != std::string::npos);
  CHECK(postedAsync.back().find("ms, p95 17.0 ms, 0.0% off cadence\n") != std::string::npos);
  // The next frame comes 50 ms late, and the frames after it keep that delay
  postedAsync.clear();
  SubmitFrames(62, 50);
  CHECK_EQ(postedAsync.size(), 1u);
  const std::string withStall = postedAsync.back();
  const size_t line = withStall.find("Host frame intervals: ");
  CHECK(line != std::string::npos);
  const std::string hostLine = withStall.substr(line, withStall.find('\n', line) - line);
  CHECK(hostLine.find(", 0.0% off cadence") == std::string::npos);
  CHECK(hostLine.find("deviation 0.4") == std::string::npos);
  // Still in the previous window at the next one
  postedAsync.clear();
  SubmitFrames(62, 50);
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(postedAsync.back().find("ms, p95 17.0 ms, 0.0% off cadence\n") == std::string::npos);
  // Gone after that
  postedAsync.clear();
  SubmitFrames(62, 50);
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(postedAsync.back().find("Host frame intervals: deviation 0.4") != std::string::npos);
  CHECK(postedAsync.back().find("ms, p95 17.0 ms, 0.0% off cadence\n") != std::string::npos);
}

static void TheGraphPointCountsTheFramesLostInTheLastWindow() {
  StartStream(kPerformanceStatsFull);
  nextFrame = 1;
  SubmitFrames(70);
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(StartsWith(postedAsync.back(), "StatMsg: {\"rtt\":3,\"lost\":0}\n"));
  // 4 frames never arrive in the next window: the point of that window counts them, while the text covers two windows
  postedAsync.clear();
  SubmitFrames(10);
  nextFrame += 4;
  SubmitFrames(48);
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(StartsWith(postedAsync.back(), "StatMsg: {\"rtt\":3,\"lost\":4}\nVideo stream: "));
  // The window after it lost none, though the text still shows the loss of the previous window
  postedAsync.clear();
  SubmitFrames(62);
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(StartsWith(postedAsync.back(), "StatMsg: {\"rtt\":3,\"lost\":0}\n"));
  CHECK(postedAsync.back().find("\nFrames dropped by your network connection: 0.00%") == std::string::npos);
}

static void TheEndOfTheStreamSendsTheSessionReport() {
  // A stream of about 2 seconds, in which 4 frames never arrived, sends its totals once its decoder is cleaned up, with
  // the window that was still open, without waiting for the main thread
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  SubmitFrames(70);
  nextFrame += 4;
  SubmitFrames(20);
  CHECK(postedAsync.empty());
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(posted.empty());
  const uintptr_t heapTop = (uintptr_t)sbrk(0);
  const std::string expected = "SessionReportMsg: {\"durationMs\":" + std::to_string(nowMs - 100000) +
    ",\"codec\":\"HEVC Main10\",\"width\":3840,\"height\":2160,\"fps\":60,\"bitrateKbps\":75000,\"frames\":94,"
    "\"networkDroppedFrames\":4,\"tvDroppedFrames\":0,\"videoResets\":0,\"recoveryKeyframes\":0,\"fecRecoveredBlocks\":0,"
    "\"fecFailures\":0,\"heapTopMb\":" + std::to_string(heapTop >> 20) + ",\"heapTotalMb\":128,\"heapGrowthMb\":";
  CHECK(!postedAsync.empty() && postedAsync.back().compare(0, expected.size(), expected) == 0);
  if (!postedAsync.empty() && postedAsync.back().compare(0, expected.size(), expected) != 0) {
    std::printf("  # got %s\n  # expected %s...\n", postedAsync.back().c_str(), expected.c_str());
  }
}

int main() {
  test_support::RunTest("each toggle steps one level and reports it", EachToggleStepsOneLevelAndReportsIt);
  test_support::RunTest("nothing is sent while the level is Off", NothingWhileTheLevelIsOff);
  test_support::RunTest("the Compact level sends only the figures of the compact line", CompactLevelSendsTheFiguresOnly);
  test_support::RunTest("the Full level sends the text with the frame intervals", FullLevelSendsTheTextWithTheFrameIntervals);
  test_support::RunTest("the frame intervals cover the last two stats windows", TheIntervalWindowsFollowTheStatsWindows);
  test_support::RunTest("the point of the graph counts the frames lost in the last window", TheGraphPointCountsTheFramesLostInTheLastWindow);
  test_support::RunTest("the end of the stream sends the totals of the session", TheEndOfTheStreamSendsTheSessionReport);
  return test_support::Summary();
}
