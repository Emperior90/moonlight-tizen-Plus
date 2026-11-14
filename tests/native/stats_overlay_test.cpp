// Checks the performance statistics overlay in the video decoder path (wasm/wasmplayer.cpp, included directly): every
// call of TogglePerformanceStats() (the remote, the Stream Menu, the gamepad combo and the keyboard combo) steps the
// level Off, Compact, Full, Off and reports it to the front end; at each stats window VidDecSubmitDecodeUnit() sends
// nothing while the level is Off and the figures of the compact line while it is Compact, and at every second window
// while it is Full the text of the full statistics with the regularity of the frame intervals of the host and the video
// player, after the point of their graph (the round-trip time and the frames lost on the network in the two windows of
// the message). Every figure of a message covers these two windows: the frame rates, the bitrate, the averages, the
// highest number of pending frames and the frame intervals, and the session totals include them. The line of the frame
// receive time also shows it as a share of the time between two frames, and the bitrate line says that the received
// figure is the video alone. When the stream ends, VidDecCleanup() sends the totals of the session for its report
// (wasm/session_report.hpp), with the lowest 30 s window of the host frame rate that counts and the average frame
// receive time over the stream and in its highest stats window. The functions
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
// The time of the test clock at which each message of postedAsync was sent
static std::vector<uint64_t> postedAsyncAtMs;
// The frames that wait in the decode unit queue, as moonlight-common-c reports them
static int pendingFrames = 0;
// The size of the frames that SubmitFrame() submits
static int frameBytes = 100000;
// The time from the first to the last packet of the frames that SubmitFrame() submits, in milliseconds
static unsigned int frameReceiveMs = 1;

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
// What the host of the stream offered for reference frame invalidation in the RTSP handshake
static bool hostOffersRfi = false;
bool LiHostSupportsReferenceFrameInvalidation(void) {
  return hostOffersRfi;
}
uint32_t LiGetClientDroppedVideoFrames(void) {
  return 0;
}
int LiGetPendingVideoFrames(void) {
  return pendingFrames;
}
bool LiGetEstimatedRttInfo(uint32_t* estimatedRtt, uint32_t* estimatedRttVariance) {
  *estimatedRtt = 3;
  *estimatedRttVariance = 1;
  return true;
}
bool LiGetCurrentHostDisplayHdrMode(void) {
  return true;
}
// The network figures of moonlight-common-c, all zero unless a test sets them
static VIDEO_NETWORK_STATS s_TestNetworkStats;
void LiGetVideoNetworkStats(PVIDEO_NETWORK_STATS stats) {
  *stats = s_TestNetworkStats;
}
void LiTerminateConnectionAsync(int) {}
void PostToJs(std::string message) {
  posted.push_back(message);
}
void PostToJsAsync(std::string message) {
  postedAsync.push_back(message);
  postedAsyncAtMs.push_back(nowMs);
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
  postedAsyncAtMs.clear();
  pendingFrames = 0;
  frameBytes = 100000;
  frameReceiveMs = 1;
  nowMs = 100000;
  std::memset(&s_TestNetworkStats, 0, sizeof(s_TestNetworkStats));

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
  s_LastWndBytes = 0;
  s_PendingFramesMax = 0;
  s_LastWndPendingFramesMax = 0;
  s_FullStatsWindowsToSkip = 0;
  s_ReceiveTimePeakX100 = 0;
  s_ReceivedFirstIdrFrame = false;
  s_RecoveryIdrFrames = 0;
  s_SessionTvDroppedFrames = 0;
  s_SessionStartMs = nowMs;
  (g_Instance->*Pointer(StreamConfigMember())).bitrate = 75000;
  ResetHostFrameRate();
  s_TerminatingStream = false;
}

// Submit one frame of frameBytes (100 KB unless a test changes it) that the host captured at captureMs in hostLatency
// tenths of a millisecond (4 ms by default), or encoded again without a new image (a repeat: no host processing
// latency, and a send time instead of a capture time)
static void SubmitFrame(int frameNumber, unsigned int captureMs, bool repeat, uint16_t hostLatency = 40) {
  static char data[100000];
  LENTRY entry = {};
  entry.data = data;
  entry.length = frameBytes;
  entry.bufferType = BUFFER_TYPE_PICDATA;
  DECODE_UNIT unit = {};
  unit.frameNumber = frameNumber;
  unit.frameType = frameNumber == 1 ? FRAME_TYPE_IDR : FRAME_TYPE_PFRAME;
  unit.frameHostProcessingLatency = repeat ? 0 : hostLatency;
  unit.presentationTimeMs = captureMs;
  // The last packet came frameReceiveMs (1 ms unless a test changes it) after the first, and the frame waited 2 ms for
  // the decoder thread
  unit.receiveTimeMs = nowMs - 2 - frameReceiveMs;
  unit.enqueueTimeMs = nowMs - 2;
  unit.fullLength = frameBytes;
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

// Submit the next frames, delayed by delayMs, until one of them ends the stats window (which starts the byte count of
// the next one)
static void SubmitFramesToTheEndOfTheWindow(unsigned int delayMs = 0) {
  do {
    SubmitFrames(1, delayMs);
  } while (total_bytes != 0);
}

static bool StartsWith(const std::string& text, const std::string& prefix) {
  return text.compare(0, prefix.size(), prefix) == 0;
}

// The line of a message that starts with the given label, without the label, or an empty text
static std::string LineAfter(const std::string& message, const std::string& label) {
  const size_t start = message.find("\n" + label);
  if (start == std::string::npos) {
    return "";
  }
  const size_t from = start + 1 + label.size();
  return message.substr(from, message.find('\n', from) - from);
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
  // One message per stats window, about once per second
  CHECK_EQ(postedAsync.size(), 3u);
  for (size_t i = 1; i < postedAsyncAtMs.size(); i++) {
    CHECK(postedAsyncAtMs[i] - postedAsyncAtMs[i - 1] > 1000 && postedAsyncAtMs[i] - postedAsyncAtMs[i - 1] < 1050);
  }
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
  // The 1 ms that each frame took to arrive is 6 % of the 16.7 ms between two frames of the stream
  CHECK_EQ(LineAfter(last, "Average frame receive time: "), std::string("1.00 ms (6% of the frame time)"));
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

static void FullLevelShowsOneBitrateLineAndNoReceiveBuffer() {
  StartStream(kPerformanceStatsFull);
  nextFrame = 1;
  // The receive buffer of the video socket and a worst FEC block, as moonlight-common-c reports them during a stream
  s_TestNetworkStats.requestedReceiveBufferSize = 1024 * 1024;
  s_TestNetworkStats.reportedReceiveBufferSize = 512 * 1024;
  s_TestNetworkStats.fecWorstMissingPackets = 2;
  s_TestNetworkStats.fecWorstParityPackets = 4;
  SubmitFrames(200);
  CHECK(!postedAsync.empty());
  const std::string& last = postedAsync.back();
  // 100 KB per frame at 60 FPS is about 48 Mbps; the app set 75 Mbps
  const size_t bitrate = last.find("\nBitrate: 48.0");
  CHECK(bitrate != std::string::npos);
  // The received figure counts the video alone, and the line says what else the configured bitrate has to hold
  CHECK(last.find(" Mbps video received, 75.0 Mbps configured (with FEC and audio)\n") == bitrate + 15);
  CHECK(last.find("Mbps received,") == std::string::npos);
  CHECK(bitrate > last.find("\nRendering frame rate: "));
  CHECK(last.find("Incoming bitrate from network") == std::string::npos);
  CHECK(last.find("Configured bitrate") == std::string::npos);
  // The receive buffer stays the same for the whole stream: only the log of the stream start names it
  CHECK(last.find("receive buffer") == std::string::npos);
  CHECK(last.find("\nWorst FEC block: 2 of 4 parity packets used\n") != std::string::npos);
  CHECK(last.find("\nWASM heap top: ") != std::string::npos);
  if (bitrate == std::string::npos) {
    std::printf("  # got %s\n", last.c_str());
  }
}

static void TheIntervalWindowsFollowTheStatsWindows() {
  // The lines cover the two stats windows of their message: a stall of the host shows in the next message, whichever of
  // its two windows had it, and is gone in the message after it
  for (int stallWindow : {2, 3}) {
    StartStream(kPerformanceStatsFull);
    nextFrame = 1;
    // The first window sends its message
    SubmitFramesToTheEndOfTheWindow();
    CHECK_EQ(postedAsync.size(), 1u);
    CHECK(postedAsync.back().find("Host frame intervals: deviation 0.4") != std::string::npos);
    CHECK(postedAsync.back().find("ms, p95 17.0 ms, 0.0% off cadence\n") != std::string::npos);
    postedAsync.clear();
    if (stallWindow == 3) {
      // The second window sends none
      SubmitFramesToTheEndOfTheWindow();
      CHECK(postedAsync.empty());
    }
    // The next frame comes 50 ms late, and the frames after it keep that delay
    SubmitFramesToTheEndOfTheWindow(50);
    if (stallWindow == 2) {
      // The window of the stall sent no message: the one after it does
      CHECK(postedAsync.empty());
      SubmitFramesToTheEndOfTheWindow(50);
    }
    CHECK_EQ(postedAsync.size(), 1u);
    const std::string hostLine = LineAfter(postedAsync.back(), "Host frame intervals: ");
    CHECK(!hostLine.empty());
    CHECK(hostLine.find(", 0.0% off cadence") == std::string::npos);
    CHECK(hostLine.find("deviation 0.4") == std::string::npos);
    // Gone in the message after it, two windows later
    postedAsync.clear();
    SubmitFramesToTheEndOfTheWindow(50);
    CHECK(postedAsync.empty());
    SubmitFramesToTheEndOfTheWindow(50);
    CHECK_EQ(postedAsync.size(), 1u);
    CHECK(postedAsync.back().find("Host frame intervals: deviation 0.4") != std::string::npos);
    CHECK(postedAsync.back().find("ms, p95 17.0 ms, 0.0% off cadence\n") != std::string::npos);
  }
}

static void TheGraphPointCountsTheFramesLostInTheWindowsOfItsMessage() {
  StartStream(kPerformanceStatsFull);
  nextFrame = 1;
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(StartsWith(postedAsync.back(), "StatMsg: {\"rtt\":3,\"lost\":0}\n"));
  // 4 frames never arrive in the next window, which sends no message, and 2 in the one after it: the point of the next
  // message counts the 6 of its two windows, like its text, and the totals of the session have them already, also
  // the 2 of the window that just ended
  postedAsync.clear();
  SubmitFrames(10);
  nextFrame += 4;
  SubmitFramesToTheEndOfTheWindow();
  CHECK(postedAsync.empty());
  SubmitFrames(10);
  nextFrame += 2;
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(StartsWith(postedAsync.back(), "StatMsg: {\"rtt\":3,\"lost\":6}\nVideo stream: "));
  CHECK(StartsWith(LineAfter(postedAsync.back(), "Frames dropped by your network connection: "), "4."));
  CHECK(StartsWith(LineAfter(postedAsync.back(), "Session frames dropped by network: "), "6 ("));
  // The two windows after them lost none: the next message has no loss in its point or its text, and the totals keep it
  postedAsync.clear();
  SubmitFramesToTheEndOfTheWindow();
  CHECK(postedAsync.empty());
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(StartsWith(postedAsync.back(), "StatMsg: {\"rtt\":3,\"lost\":0}\n"));
  CHECK_EQ(LineAfter(postedAsync.back(), "Frames dropped by your network connection: "), std::string("0.00%"));
  CHECK(StartsWith(LineAfter(postedAsync.back(), "Session frames dropped by network: "), "6 ("));
}

static void TheFullLevelSendsAtEverySecondWindow() {
  // The same frames at the Compact level, which sends at every stats window, to count the windows
  StartStream(kPerformanceStatsCompact);
  nextFrame = 1;
  SubmitFrames(440);
  const size_t windows = postedAsync.size();
  CHECK_EQ(windows, 7u);
  // The Full level: the first window sends, so that the overlay shows within about a second, then every second one,
  // about every 2 seconds
  StartStream(kPerformanceStatsFull);
  nextFrame = 1;
  SubmitFrames(440);
  CHECK_EQ(postedAsync.size(), (windows + 1) / 2);
  CHECK(!postedAsyncAtMs.empty() && postedAsyncAtMs.front() - 100000 < 1100);
  for (size_t i = 1; i < postedAsyncAtMs.size(); i++) {
    CHECK(postedAsyncAtMs[i] - postedAsyncAtMs[i - 1] > 2000 && postedAsyncAtMs[i] - postedAsyncAtMs[i - 1] < 2100);
  }
  // A step through Off and Compact back to Full: the first window at the Full level sends again, although the last
  // message of the full statistics is only one window old
  postedAsync.clear();
  StatsLevel() = kPerformanceStatsCompact;
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK(StartsWith(postedAsync.back(), "StatCompactMsg: "));
  StatsLevel() = kPerformanceStatsFull;
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 2u);
  CHECK(StartsWith(postedAsync.back(), "StatMsg: "));
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 2u);
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 3u);
}

static void EveryFigureCoversTheTwoWindowsOfItsMessage() {
  // Frames of 100 KB in one stats window (48 Mbps) and of 50 KB in the next (24 Mbps), and a queue of 3 frames for a
  // moment in the first of the two: the message after them shows the bitrate of both windows together, 36 Mbps, and
  // the queue of the earlier one, at the Full level, where no message came in between, ...
  StartStream(kPerformanceStatsFull);
  nextFrame = 1;
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 1u);
  SubmitFrames(5);
  pendingFrames = 3;
  SubmitFrames(1);
  pendingFrames = 0;
  SubmitFramesToTheEndOfTheWindow();
  frameBytes = 50000;
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 2u);
  const double fullBitrate = std::atof(LineAfter(postedAsync.back(), "Bitrate: ").c_str());
  CHECK(fullBitrate > 35.5 && fullBitrate < 36.5);
  CHECK_EQ(LineAfter(postedAsync.back(), "Pending frames: "), std::string("0 (max 3)"));
  // 60 frames per second over the two windows
  const double incoming = std::atof(LineAfter(postedAsync.back(), "Incoming frame rate from network: ").c_str());
  CHECK(incoming > 59.5 && incoming < 60.5);
  if (!(fullBitrate > 35.5 && fullBitrate < 36.5)) {
    std::printf("  # got %s\n", postedAsync.back().c_str());
  }
  // The queue is gone from the message after it
  frameBytes = 100000;
  SubmitFramesToTheEndOfTheWindow();
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 3u);
  CHECK_EQ(LineAfter(postedAsync.back(), "Pending frames: "), std::string("0 (max 0)"));

  // ... and at the Compact level, whose line comes at every window with the figures of the last two
  StartStream(kPerformanceStatsCompact);
  nextFrame = 1;
  SubmitFramesToTheEndOfTheWindow();
  SubmitFramesToTheEndOfTheWindow();
  frameBytes = 50000;
  SubmitFramesToTheEndOfTheWindow();
  CHECK_EQ(postedAsync.size(), 3u);
  CHECK(postedAsync.back().find("\"mbps\":36.0,") != std::string::npos);
  if (postedAsync.back().find("\"mbps\":36.0,") == std::string::npos) {
    std::printf("  # got %s\n", postedAsync.back().c_str());
  }
}

static void TheEndOfTheStreamSendsTheSessionReport() {
  // A stream of about 2 seconds, in which 4 frames never arrived, sends its totals once its decoder is cleaned up, with
  // the window that was still open, without waiting for the main thread. Its audio stream, which ended before the
  // video stream, left the load of the audio thread for it (AudDecCleanup() in wasm/auddec.cpp). Its host offered
  // reference frame invalidation, which the report carries for its hint about recovery keyframes.
  hostOffersRfi = true;
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  SubmitFrames(70);
  nextFrame += 4;
  SubmitFrames(20);
  CHECK(postedAsync.empty());
  g_AudioStreamStats.loadChannels = 8;
  g_AudioStreamStats.loadMsPerSecond = 412;
  g_AudioStreamStats.loadPeakMsPerSecond = 447;
  g_AudioStreamStats.overloadedWindows = 3;
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
  // No 30 s window of the host frame rate was completed in 2 seconds; each frame took the host 4 ms, and 1 ms to
  // arrive, over the stream and in its one stats window
  const std::string end = ",\"hostFrameRateX100\":0,\"hostProcessingLatencyX10\":40,\"hostFrameRateLowX100\":0,"
    "\"hostWindows\":0,\"hostLowWindows\":0,\"receiveTimeX100\":100,\"receiveTimePeakX100\":100,\"audioChannels\":8,"
    "\"audioLoadMsPerS\":412,\"audioLoadPeakMsPerS\":447,\"audioOverloadedWindows\":3,\"hostRfi\":1}";
  CHECK(!postedAsync.empty() && postedAsync.back().size() > end.size() &&
    postedAsync.back().compare(postedAsync.back().size() - end.size(), end.size(), end) == 0);

  // The report took the load of the audio thread: a stream that ends before its audio stream started (the video stream
  // starts first) reports none, instead of the figures of the stream before it. Its host (e.g. Sunshine with an AMD
  // or Intel encoder) offered no reference frame invalidation.
  CHECK_EQ(g_AudioStreamStats.loadChannels.load(), 0u);
  hostOffersRfi = false;
  StartStream(kPerformanceStatsOff);
  postedAsync.clear();
  MoonlightInstance::VidDecCleanup();
  // (and without a frame, no frame receive time)
  const std::string noAudio = ",\"receiveTimeX100\":0,\"receiveTimePeakX100\":0,\"audioChannels\":0,\"audioLoadMsPerS\":0,"
    "\"audioLoadPeakMsPerS\":0,\"audioOverloadedWindows\":0,\"hostRfi\":0}";
  CHECK(!postedAsync.empty() && postedAsync.back().size() > noAudio.size() &&
    postedAsync.back().compare(postedAsync.back().size() - noAudio.size(), noAudio.size(), noAudio) == 0);
}

// The number after "key": in a message of JSON figures, or -1
static long JsonNumber(const std::string& message, const std::string& key) {
  const size_t position = message.find("\"" + key + "\":");
  return position == std::string::npos ? -1 : std::strtol(message.c_str() + position + key.size() + 3, nullptr, 10);
}

static void TheSessionReportHasTheBestHostFrameRateAndTheHostLatency() {
  // A host display at 59.94 Hz for 70 s, then a static scene at 30 FPS for 70 s, in which the host repeats every 5th
  // frame, and the host needs 4 or 6 ms per new image: the report keeps the best 30 s window, so the 59.94 Hz of the
  // display still shows, and the average host processing latency leaves out the repeats, which carry none
  StartStream(kPerformanceStatsOff);
  int frameNumber = 1;
  double captureMs = 1000.0;
  for (; captureMs < 71000.0; frameNumber++, captureMs += 1001.0 / 60) {
    nowMs = 100000 + (uint64_t)captureMs;
    SubmitFrame(frameNumber, (unsigned int)std::lround(captureMs), false, frameNumber % 2 == 0 ? 40 : 60);
  }
  for (; captureMs < 141000.0; frameNumber++, captureMs += 1000.0 / 30) {
    nowMs = 100000 + (uint64_t)captureMs;
    const bool repeat = frameNumber % 5 == 0;
    SubmitFrame(frameNumber, (unsigned int)std::lround(captureMs) + (repeat ? 5 : 0), repeat, frameNumber % 2 == 0 ? 40 : 60);
  }
  postedAsync.clear();
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(postedAsync.size(), 1u);
  const std::string report = postedAsync.empty() ? std::string() : postedAsync.back();
  const long hostFrameRate = JsonNumber(report, "hostFrameRateX100");
  CHECK(hostFrameRate >= 5993 && hostFrameRate <= 5995);
  CHECK_EQ(JsonNumber(report, "hostProcessingLatencyX10"), 50L);
  if (hostFrameRate < 5993 || hostFrameRate > 5995) {
    std::printf("  # got %s\n", report.c_str());
  }
  // A 60 Hz display reads 60.00 in its best window
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  SubmitFrames(60 * 65);
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(JsonNumber(postedAsync.empty() ? std::string() : postedAsync.back(), "hostFrameRateX100"), 6000L);
}

static void EachStreamReportsOnlyItsOwnHostFigures() {
  // After a stream whose best window read 60.00, the next stream of the same app run is too short for a window of its
  // own: its report has no host frame rate rather than the 60.00 of the stream before (ResetHostFrameRate(), which
  // VidDecSetup() calls for each stream)
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  SubmitFrames(60 * 35);
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(JsonNumber(postedAsync.empty() ? std::string() : postedAsync.back(), "hostFrameRateX100"), 6000L);
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  SubmitFrames(120);
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(postedAsync.size(), 1u);
  CHECK_EQ(JsonNumber(postedAsync.empty() ? std::string() : postedAsync.back(), "hostFrameRateX100"), 0L);

  // The average host processing latency covers the stats window that was still open when the stream ended, and is
  // rounded: 61 frames at 4.0 ms and then 19 frames at 6.1 ms, the last ones in the open window, average
  // (61 * 40 + 19 * 61) / 80 = 44.99 tenths of a millisecond, which is 4.5 ms (the closed windows alone give 4.0 ms,
  // and a cut-off division 4.4 ms)
  StartStream(kPerformanceStatsOff);
  for (int frameNumber = 1; frameNumber <= 80; frameNumber++) {
    const unsigned int captureMs = (unsigned int)(frameNumber * 1000 / 60);
    nowMs = 100000 + captureMs;
    SubmitFrame(frameNumber, captureMs, false, frameNumber <= 61 ? 40 : 61);
  }
  // At least one stats window was closed, and the frames at 6.1 ms are all in the window that is still open
  CHECK(m_GlobalVideoStats.framesWithHostProcessingLatency > 0);
  CHECK_EQ(m_GlobalVideoStats.totalHostProcessingLatency, 40u * m_GlobalVideoStats.framesWithHostProcessingLatency);
  CHECK(m_ActiveWndVideoStats.framesWithHostProcessingLatency >= 19);
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(JsonNumber(postedAsync.empty() ? std::string() : postedAsync.back(), "hostProcessingLatencyX10"), 45L);
}

// Submit the frames of a host for the given number of seconds at a rate of new images, starting at captureMs: every
// repeatEvery-th frame (0 for none) is a repeat of the previous image, sent 5 ms after the capture time it would have
// had. The clock of the TV follows the capture times.
static void SubmitHostPhase(int& frameNumber, double& captureMs, double seconds, double framesPerSecond, int repeatEvery) {
  const double end = captureMs + seconds * 1000.0;
  for (; captureMs < end; frameNumber++, captureMs += 1000.0 / framesPerSecond) {
    nowMs = 100000 + (uint64_t)captureMs;
    const bool repeat = repeatEvery != 0 && frameNumber % repeatEvery == 0;
    SubmitFrame(frameNumber, (unsigned int)std::lround(captureMs) + (repeat ? 5 : 0), repeat);
  }
}

static void TheSessionReportHasTheLowestHostFrameRate() {
  // A 60 FPS stream of a game: 30 s of loading at 30 FPS, a minute at 60 FPS, a minute and a half in which the PC
  // renders only 51 frames per second (without repeats: the gaps stay below the 33 ms of Sunshine's minimum frame
  // rate), a minute of a paused game (15 new images per second and a repeat after each), and 32 s at 60 FPS again.
  // The report counts the 30 s windows without the first one of the stream and the two of the paused host: 6, of
  // which the 3 at 51 FPS are below 95 % of the stream rate, and its lowest window is one of them, while the best one
  // still shows the 60 Hz of the display
  StartStream(kPerformanceStatsOff);
  int frameNumber = 1;
  double captureMs = 1000.0;
  SubmitHostPhase(frameNumber, captureMs, 30, 30, 0);
  SubmitHostPhase(frameNumber, captureMs, 60, 60, 0);
  SubmitHostPhase(frameNumber, captureMs, 90, 51, 0);
  SubmitHostPhase(frameNumber, captureMs, 60, 30, 2);
  SubmitHostPhase(frameNumber, captureMs, 32, 60, 0);
  CHECK_EQ(s_HostRateWindows.completed, 9u);
  postedAsync.clear();
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(postedAsync.size(), 1u);
  const std::string report = postedAsync.empty() ? std::string() : postedAsync.back();
  CHECK_EQ(JsonNumber(report, "hostWindows"), 6L);
  CHECK_EQ(JsonNumber(report, "hostLowWindows"), 3L);
  const long lowest = JsonNumber(report, "hostFrameRateLowX100");
  CHECK(lowest >= 5050 && lowest <= 5150);
  const long best = JsonNumber(report, "hostFrameRateX100");
  CHECK(best >= 5995 && best <= 6005);
  if (lowest < 5050 || lowest > 5150 || JsonNumber(report, "hostWindows") != 6 || JsonNumber(report, "hostLowWindows") != 3) {
    std::printf("  # got %s\n", report.c_str());
  }

  // A steady host at the rate of the stream has no low window, and its lowest window reads 60.00 like its best; the
  // first window is not among the 2 that count
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  SubmitFrames(60 * 95);
  MoonlightInstance::VidDecCleanup();
  const std::string steady = postedAsync.empty() ? std::string() : postedAsync.back();
  CHECK_EQ(JsonNumber(steady, "hostWindows"), 2L);
  CHECK_EQ(JsonNumber(steady, "hostLowWindows"), 0L);
  CHECK_EQ(JsonNumber(steady, "hostFrameRateLowX100"), 6000L);
  CHECK_EQ(JsonNumber(steady, "hostFrameRateX100"), 6000L);

  // The next stream of the same app run is too short for a second window: it reports no lowest window and no windows
  // rather than those of the stream before it (ResetHostFrameRate())
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  SubmitFrames(60 * 35);
  MoonlightInstance::VidDecCleanup();
  const std::string brief = postedAsync.empty() ? std::string() : postedAsync.back();
  CHECK_EQ(JsonNumber(brief, "hostFrameRateX100"), 6000L);
  CHECK_EQ(JsonNumber(brief, "hostWindows"), 0L);
  CHECK_EQ(JsonNumber(brief, "hostLowWindows"), 0L);
  CHECK_EQ(JsonNumber(brief, "hostFrameRateLowX100"), 0L);
}

static void TheFrameReceiveTimeShowsAsAShareOfTheFrameTime() {
  // Frames that take 9 ms from their first to their last packet in a 60 FPS stream fill 54 % of the 16.7 ms between
  // two frames: the full statistics show both, and the report of the session has the average in hundredths of a
  // millisecond, over the stream and in its highest stats window
  StartStream(kPerformanceStatsFull);
  nextFrame = 1;
  frameReceiveMs = 9;
  SubmitFrames(200);
  CHECK(!postedAsync.empty());
  CHECK_EQ(LineAfter(postedAsync.empty() ? std::string() : postedAsync.back(), "Average frame receive time: "),
    std::string("9.00 ms (54% of the frame time)"));
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(JsonNumber(postedAsync.back(), "receiveTimeX100"), 900L);
  CHECK_EQ(JsonNumber(postedAsync.back(), "receiveTimePeakX100"), 900L);

  // The share follows the frame rate of the stream: 5 ms are 60 % of the 8.3 ms between two frames at 120 FPS
  StartStream(kPerformanceStatsFull);
  s_Framerate = 120;
  nextFrame = 1;
  frameReceiveMs = 5;
  SubmitFrames(200);
  CHECK_EQ(LineAfter(postedAsync.empty() ? std::string() : postedAsync.back(), "Average frame receive time: "),
    std::string("5.00 ms (60% of the frame time)"));

  // A stream with scenes of different weight: three stats windows of frames that take 9 ms, three of 12 ms and two of
  // 4 ms. The highest window is one at 12 ms, and the average covers every frame.
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  for (unsigned int receiveMs : {9u, 9u, 9u, 12u, 12u, 12u, 4u, 4u}) {
    frameReceiveMs = receiveMs;
    SubmitFramesToTheEndOfTheWindow();
  }
  CHECK_EQ(s_ReceiveTimePeakX100, 1200u);
  // Then the stream stalls: for more than a second only every 6th frame arrives, and each takes 150 ms. That stats
  // window has fewer than half the frames of the stream rate, so it doesn't set the highest window ...
  frameReceiveMs = 150;
  unsigned int delayMs = 0;
  do {
    nextFrame += 5;
    delayMs += 10;
    SubmitFrames(1, delayMs);
  } while (total_bytes != 0);
  CHECK(m_LastWndVideoStats.decodedFrames >= 5 && m_LastWndVideoStats.decodedFrames < 30);
  CHECK(m_LastWndVideoStats.totalReassemblyTime / m_LastWndVideoStats.decodedFrames > 100);
  CHECK_EQ(s_ReceiveTimePeakX100, 1200u);
  // ... and neither do the 10 frames of the window that is still open when the stream ends, while the average over
  // the stream has them all
  frameReceiveMs = 4;
  SubmitFrames(10, delayMs);
  const uint64_t totalMs = (uint64_t)m_GlobalVideoStats.totalReassemblyTime + m_ActiveWndVideoStats.totalReassemblyTime;
  const uint32_t frames = m_GlobalVideoStats.decodedFrames + m_ActiveWndVideoStats.decodedFrames;
  CHECK(m_ActiveWndVideoStats.decodedFrames < 30);
  postedAsync.clear();
  MoonlightInstance::VidDecCleanup();
  const std::string report = postedAsync.empty() ? std::string() : postedAsync.back();
  CHECK_EQ(JsonNumber(report, "receiveTimePeakX100"), 1200L);
  const long average = JsonNumber(report, "receiveTimeX100");
  CHECK_EQ(average, (long)((totalMs * 100 + frames / 2) / frames));
  // (about 480 frames at 9, 12 and 4 ms and a few at 150 ms)
  CHECK(average > 850 && average < 1200);

  // The window that is still open at the end counts when it has enough frames: a second at 9 ms, then 40 frames at
  // 15 ms (the first frame of a window is the one that ended the window before it, here one at 9 ms)
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  frameReceiveMs = 9;
  SubmitFramesToTheEndOfTheWindow();
  frameReceiveMs = 15;
  SubmitFrames(39);
  CHECK_EQ(s_ReceiveTimePeakX100, 900u);
  CHECK_EQ(m_ActiveWndVideoStats.decodedFrames, 40u);
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(JsonNumber(postedAsync.back(), "receiveTimePeakX100"), (long)((9 + 39 * 15) * 100 + 20) / 40);

  // The average is rounded: three frames of 1, 2 and 2 ms took 1.67 ms. So short a stream has no stats window that
  // counts, and so no highest one.
  StartStream(kPerformanceStatsOff);
  nextFrame = 1;
  for (unsigned int receiveMs : {1u, 2u, 2u}) {
    frameReceiveMs = receiveMs;
    SubmitFrames(1);
  }
  MoonlightInstance::VidDecCleanup();
  CHECK_EQ(JsonNumber(postedAsync.back(), "receiveTimeX100"), 167L);
  CHECK_EQ(JsonNumber(postedAsync.back(), "receiveTimePeakX100"), 0L);
}

int main() {
  test_support::RunTest("each toggle steps one level and reports it", EachToggleStepsOneLevelAndReportsIt);
  test_support::RunTest("nothing is sent while the level is Off", NothingWhileTheLevelIsOff);
  test_support::RunTest("the Compact level sends only the figures of the compact line", CompactLevelSendsTheFiguresOnly);
  test_support::RunTest("the Full level sends the text with the frame intervals", FullLevelSendsTheTextWithTheFrameIntervals);
  test_support::RunTest("the Full level shows one bitrate line and not the receive buffer", FullLevelShowsOneBitrateLineAndNoReceiveBuffer);
  test_support::RunTest("the frame intervals cover the two stats windows of their message", TheIntervalWindowsFollowTheStatsWindows);
  test_support::RunTest("the point of the graph counts the frames lost in the two windows of its message",
    TheGraphPointCountsTheFramesLostInTheWindowsOfItsMessage);
  test_support::RunTest("the Full level sends at every second stats window, the Compact level at every one",
    TheFullLevelSendsAtEverySecondWindow);
  test_support::RunTest("the bitrate and the pending frames cover the two windows of their message",
    EveryFigureCoversTheTwoWindowsOfItsMessage);
  test_support::RunTest("the end of the stream sends the totals of the session", TheEndOfTheStreamSendsTheSessionReport);
  test_support::RunTest("the report of the session has the best host frame rate and the average host latency",
    TheSessionReportHasTheBestHostFrameRateAndTheHostLatency);
  test_support::RunTest("each stream reports only its own host figures, with the open window and rounded",
    EachStreamReportsOnlyItsOwnHostFigures);
  test_support::RunTest("the report of the session has the lowest host frame rate, without the start and a paused host",
    TheSessionReportHasTheLowestHostFrameRate);
  test_support::RunTest("the frame receive time shows as a share of the frame time, and the report has its average and highest window",
    TheFrameReceiveTimeShowsAsAShareOfTheFrameTime);
  return test_support::Summary();
}
