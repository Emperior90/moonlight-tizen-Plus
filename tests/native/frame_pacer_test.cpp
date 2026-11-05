// Checks the timing of the video decoder thread in VidDecSubmitDecodeUnit() (wasm/wasmplayer.cpp, included directly): the
// presentation timestamps that follow the capture times of the host, the frame pacer that releases the frames at an
// even pace, and the retry of a frame that the video player of the TV rejects because its buffer is full.
// The video player of the TV shows a frame as soon as it is appended (in both latency modes of the app), so the moments
// of the appends are what the viewer sees. The test runs the frames on a simulated clock: std::chrono::steady_clock and
// usleep() of the file are replaced by the clock of the test, LiGetMillis() follows it, and the stub of AppendPacket()
// (TestAppendPacketHook() in stubs/samsung/wasm/common.h) records the moment and the presentation timestamp of every
// append. The frames of a scenario arrive in the decode unit queue at the times it gives, and the decoder thread takes
// the next one as soon as it is free, as moonlight-common-c does. The scenarios follow the probe that measured the
// pacer (a host at a steady rate, below the stream rate, with frames lost, a latency that rises and falls back), with
// uniform arrival jitter from a seeded std::mt19937, whose numbers the C++ standard fixes on every platform.
// VidDecSetup() waits for the media pipeline of the TV, so the test sets up the state of a stream the way it does
// (StartStream() below), with its ResetFramePacer().

// The standard headers that wasm/wasmplayer.cpp and its headers use come first, so that the two macros below rename the
// clock and usleep() only in the code of the app
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <future>
#include <initializer_list>
#include <map>
#include <memory>
#include <mutex>
#include <queue>
#include <random>
#include <string>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>
#include <pthread.h>
#include <unistd.h>

// The simulated clock, in seconds. Each reading of the clock takes 1 microsecond, so that the final spin of the pacer
// moves on, and a sleep wakes up 50 microseconds late.
static double simNow = 0.0;

namespace std {
namespace chrono {
// The steady clock of wasm/wasmplayer.cpp (the macro below renames it there). It has to live in std::chrono, since the
// file names std::chrono::steady_clock.
struct TestSteadyClock {
  using duration = std::chrono::nanoseconds;
  using rep = duration::rep;
  using period = duration::period;
  using time_point = std::chrono::time_point<TestSteadyClock, duration>;
  static constexpr bool is_steady = true;
  static time_point now() noexcept {
    const double now = simNow;
    simNow += 1e-6;
    return time_point(duration((rep)std::llround(now * 1e9)));
  }
};
}  // namespace chrono
}  // namespace std

static int TestUsleep(long long microseconds) {
  simNow += microseconds * 1e-6 + 50e-6;
  return 0;
}

#define steady_clock TestSteadyClock
#define usleep TestUsleep
#include "../../wasm/wasmplayer.cpp"
#undef steady_clock
#undef usleep

#include "test_support.h"

AudioStreamStats g_AudioStreamStats;
MoonlightInstance* g_Instance = nullptr;

// The test sets members of the instance that the module writes itself (see stats_overlay_test.cpp)
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

// A frame of a scenario: the time the host captured it (ms of the host clock, not rounded), the capture time as the
// decoder gets it (decodeUnit->presentationTimeMs) and the moment it arrives in the decode unit queue (simulated seconds)
struct Frame {
  int number;
  double captureMs;
  uint32_t hostTimeMs;
  double arrival;
};

// What happened to a frame: when the decoder thread took it from the queue, when it was appended (-1 if it wasn't), its
// presentation timestamp, the time difference of the pacer after it, and the frames waiting in the queue when the thread
// took it
struct Outcome {
  double captureMs;
  double arrival;
  double dequeue;
  double append;
  double pts;
  double ptsDiff;
  double windowStart;
  int pending;
  int result;
};

// The scenario that runs, for LiGetPendingVideoFrames()
static const std::vector<Frame>* runningFrames = nullptr;
static size_t runningIndex = 0;

// The appends: the moment, the timestamp and the number of calls, and the result that the next append returns
static double lastAppendTime = -1;
static double lastAppendPts = -1;
static int appendCalls = 0;
static std::function<int()> appendResult;

uint64_t LiGetMillis(void) {
  return (uint64_t)(100000.0 + simNow * 1000.0);
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
  int pending = 0;
  if (runningFrames != nullptr) {
    for (size_t i = runningIndex + 1; i < runningFrames->size() && (*runningFrames)[i].arrival <= simNow; i++) {
      pending++;
    }
  }
  return pending;
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
void PostToJs(std::string) {}
void PostToJsAsync(std::string) {}
void MoonlightInstance::ClLogMessage(const char*, ...) {}
void MoonlightInstance::CancelPendingSetup() {}
void MoonlightInstance::OnConnectionStopped(uint32_t) {}

// The instance and the decoder state of a running 4K AV1 Main10 stream at the given frame rate, as StartStream() and
// VidDecSetup() leave them. The instance is never constructed (the vptr check of UBSan is off for this reason, see
// run.sh).
static void StartStream(int fps, bool pacing) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  std::memset(storage, 0, sizeof(storage));
  g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  g_Instance->*Pointer(VideoStartedMember()) = true;
  g_Instance->*Pointer(StatsLevelMember()) = kPerformanceStatsOff;
  (g_Instance->*Pointer(StreamConfigMember())).bitrate = 150000;
  s_VideoFormat = VIDEO_FORMAT_AV1_MAIN10;
  s_Width = 3840;
  s_Height = 2160;
  s_Framerate = fps;
  s_frameDuration = TimeStamp(1.0 / (float)fps);
  ResetFramePacer();
  s_FramePacingEnabled = pacing;
  s_HdrMetadataEnabled = false;
  s_DecodeBuffer.resize(INITIAL_DECODE_BUFFER_LEN);
  s_StatString.assign(4096, 0);
  ResetFrameIntervalClock(s_HostIntervalClock);
  ResetFrameIntervalClock(s_PlayerIntervalClock);
  for (int i = 0; i < 2; i++) {
    ResetFrameIntervals(s_HostIntervals[i]);
    ResetFrameIntervals(s_PlayerIntervals[i]);
  }
  std::memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));
  std::memset(&m_LastWndVideoStats, 0, sizeof(m_LastWndVideoStats));
  std::memset(&m_GlobalVideoStats, 0, sizeof(m_GlobalVideoStats));
  m_LastFrameNumber = 0;
  total_bytes = 0;
  s_ReceivedFirstIdrFrame = false;
  s_RecoveryIdrFrames = 0;
  s_SessionTvDroppedFrames = 0;
  s_HostRateWindowOpen = false;
  s_HostFrameRate = 0.0f;
  s_TerminatingStream = false;
  s_AppendBufferFull = 0;
  s_AppendBufferFullRecovered = 0;
  s_AppendKeyframeRequired = 0;
  s_AppendTrackNotReady = 0;
  s_AppendOtherFailures = 0;
  std::memset(s_AppendFailuresByCode, 0, sizeof(s_AppendFailuresByCode));
  s_RejectedModeFailures = 0;
  s_AnyAppendSucceeded = false;
  s_LastAppendSuccessMs = 0;
  s_VideoTrackOpenMs = LiGetMillis();
  appendCalls = 0;
  appendResult = [] { return 0; };
  samsung::wasm::TestAppendPacketHook() = [](const samsung::wasm::ElementaryMediaPacket& packet) {
    appendCalls++;
    const int result = appendResult();
    if (result == 0) {
      lastAppendTime = simNow;
      lastAppendPts = packet.pts.count();
    }
    // Handing a frame to the player takes 0.3 ms
    simNow += 0.3e-3;
    return result;
  };
}

// Hand one frame to VidDecSubmitDecodeUnit(), at the current time of the simulated clock
static int Submit(int number, bool idr, uint32_t hostTimeMs, double arrival) {
  static char data[1000];
  LENTRY entry = {};
  entry.data = data;
  entry.length = sizeof(data);
  entry.bufferType = BUFFER_TYPE_PICDATA;
  DECODE_UNIT unit = {};
  unit.frameNumber = number;
  unit.frameType = idr ? FRAME_TYPE_IDR : FRAME_TYPE_PFRAME;
  unit.frameHostProcessingLatency = 40;
  unit.presentationTimeMs = hostTimeMs;
  unit.enqueueTimeMs = (uint64_t)(100000.0 + arrival * 1000.0);
  unit.receiveTimeMs = unit.enqueueTimeMs - 3;
  unit.fullLength = sizeof(data);
  unit.bufferList = &entry;
  return MoonlightInstance::VidDecSubmitDecodeUnit(&unit);
}

// Run the frames of a scenario through the decoder thread and return what happened to each one
static std::vector<Outcome> Run(int fps, const std::vector<Frame>& frames, bool pacing = true) {
  simNow = frames.front().arrival;
  StartStream(fps, pacing);
  runningFrames = &frames;
  std::vector<Outcome> outcomes;
  double threadFree = simNow;
  for (runningIndex = 0; runningIndex < frames.size(); runningIndex++) {
    const Frame& frame = frames[runningIndex];
    Outcome outcome = {};
    outcome.captureMs = frame.captureMs;
    outcome.arrival = frame.arrival;
    outcome.dequeue = std::max(frame.arrival, threadFree);
    simNow = outcome.dequeue;
    outcome.pending = LiGetPendingVideoFrames();
    const int callsBefore = appendCalls;
    lastAppendTime = -1;
    outcome.result = Submit(frame.number, runningIndex == 0, frame.hostTimeMs, frame.arrival);
    outcome.append = appendCalls != callsBefore ? lastAppendTime : -1;
    outcome.pts = appendCalls != callsBefore ? lastAppendPts : -1;
    outcome.ptsDiff = s_ptsDiff.count();
    outcome.windowStart = s_lastSec.count();
    outcomes.push_back(outcome);
    threadFree = simNow;
  }
  runningFrames = nullptr;
  samsung::wasm::TestAppendPacketHook() = nullptr;
  return outcomes;
}

// The capture time as moonlight-common-c hands it to the decoder: the 90 kHz RTP timestamp of the host (which wraps at
// 2^32) divided by 90, rounded down to whole milliseconds
static uint32_t HostTimeMs(double captureMs) {
  const uint64_t rtp = (uint64_t)std::llround(captureMs * 90.0) % 4294967296ull;
  return (uint32_t)(rtp / 90);
}

// The frames of a host for `seconds`, captured at captureMs(k) for frame k
static std::vector<Frame> Host(double seconds, const std::function<double(int)>& captureMs) {
  std::vector<Frame> frames;
  const double first = captureMs(0);
  for (int k = 0; captureMs(k) - first <= seconds * 1000.0; k++) {
    frames.push_back({k + 1, captureMs(k), HostTimeMs(captureMs(k)), 0.0});
  }
  return frames;
}

// The frames arrive 7 ms after their capture plus a jitter of 0 to jitterMs, in order, and the last packet of one frame
// at least a quarter of a frame duration after the one before (a 150 Mbps stream over a 600 Mbps Wi-Fi link). The
// clock of the TV starts at the first capture.
static void Arrive(std::vector<Frame>& frames, int fps, double jitterMs, unsigned seed) {
  std::mt19937 random(seed);
  const double first = frames.front().captureMs;
  double previous = -1.0;
  for (Frame& frame : frames) {
    const double jitter = random() / 4294967296.0 * jitterMs;
    frame.arrival = std::max((frame.captureMs - first + 7.0 + jitter) / 1000.0, previous + 0.25 / fps);
    previous = frame.arrival;
  }
}

// Keep the arrivals in order after a scenario delayed some of them
static void KeepInOrder(std::vector<Frame>& frames, int fps) {
  for (size_t i = 1; i < frames.size(); i++) {
    frames[i].arrival = std::max(frames[i].arrival, frames[i - 1].arrival + 0.25 / fps);
  }
}

// Whether the pacer held the frame back (more than the few microseconds of the clock readings)
static bool Held(const Outcome& outcome) {
  return outcome.append >= 0 && outcome.append - outcome.dequeue > 0.2e-3;
}

// The share of the frames captured from fromMs (after the first capture) to toMs that the pacer held back, in percent
static double HeldPercent(const std::vector<Outcome>& outcomes, double fromMs, double toMs = 1e12) {
  const double first = outcomes.front().captureMs;
  int frames = 0;
  int held = 0;
  for (const Outcome& outcome : outcomes) {
    if (outcome.captureMs - first >= fromMs && outcome.captureMs - first < toMs) {
      frames++;
      held += Held(outcome) ? 1 : 0;
    }
  }
  return frames == 0 ? 0.0 : 100.0 * held / frames;
}

static std::string Describe(double value) {
  char text[64];
  std::snprintf(text, sizeof(text), "%.3f", value);
  return text;
}

static constexpr double kFrame60 = 1000.0 / 60;
static constexpr double kFrame120 = 1000.0 / 120;

// A steady host: the timestamps and the pace of the appends stay exactly as they were before the timestamps followed
// the capture times, which come in whole milliseconds
static void SteadyHostKeepsTheTimestampsAndThePace() {
  std::vector<Frame> frames = Host(20, [](int k) { return 1000.37 + k * kFrame60; });
  Arrive(frames, 60, 4.0, 1);
  const std::vector<Outcome> outcomes = Run(60, frames);
  int wrongSteps = 0;
  for (size_t i = 1; i < outcomes.size(); i++) {
    wrongSteps += std::abs(outcomes[i].pts - outcomes[i - 1].pts - 1.0 / 60) > 1e-9 ? 1 : 0;
  }
  CHECK_EQ(wrongSteps, 0);
  CHECK(std::abs(outcomes.back().pts - (outcomes.size() - 1) / 60.0) < 1e-6);
  // After the first windows of the pacer, the frames reach the player every 16.67 ms
  int intervals = 0;
  int even = 0;
  for (size_t i = 1; i < outcomes.size(); i++) {
    if (outcomes[i].captureMs - outcomes.front().captureMs >= 3000) {
      intervals++;
      even += std::abs((outcomes[i].append - outcomes[i - 1].append) * 1000 - kFrame60) <= 0.3 ? 1 : 0;
    }
  }
  test_support::Check(even >= intervals * 0.97, "97% of the append intervals within 0.3 ms of 16.67 ms",
                      std::to_string(even) + " of " + std::to_string(intervals), __FILE__, __LINE__);
  const double held = HeldPercent(outcomes, 3000);
  test_support::Check(held > 95, "the pacer holds more than 95% of the frames", Describe(held), __FILE__, __LINE__);
}

// Frames lost on the network: the timestamp moves on by the lost frames, so the frames after the gap arrive at their
// usual time and the pacer holds them again at once (it passed every frame through for 1.5 to 2.4 s)
static void LostFramesKeepThePacerHolding() {
  std::vector<Frame> all = Host(16, [](int k) { return 1000.37 + k * kFrame60; });
  Arrive(all, 60, 4.0, 2);
  std::vector<Frame> frames;
  std::vector<int> firstAfterGap;
  for (const Frame& frame : all) {
    const int k = frame.number - 1;
    // 4 frames lost at 5, 9 and 13 s
    if ((k >= 300 && k < 304) || (k >= 540 && k < 544) || (k >= 780 && k < 784)) {
      continue;
    }
    if (k == 304 || k == 544 || k == 784) {
      firstAfterGap.push_back((int)frames.size());
    }
    frames.push_back(frame);
  }
  const std::vector<Outcome> outcomes = Run(60, frames);
  for (int index : firstAfterGap) {
    // The frame after the gap is 5 frame durations later
    CHECK(std::abs(outcomes[index].pts - outcomes[index - 1].pts - 5.0 / 60) < 1e-6);
    // One of the first two frames after the gap is held back again, and nearly all of the next second
    CHECK(Held(outcomes[index]) || Held(outcomes[index + 1]));
    const double afterMs = outcomes[index].captureMs - outcomes.front().captureMs;
    const double held = HeldPercent(outcomes, afterMs, afterMs + 1000);
    test_support::Check(held > 90, "the pacer holds more than 90% of the frames of the second after the gap",
                        Describe(held), __FILE__, __LINE__);
  }
}

// A host that sends fewer frames than the stream rate: the timestamps follow the capture times, so the pacer holds the
// frames at the pace of the host (it held none, since every frame seemed to arrive later than the one before)
static void HostBelowTheStreamRateStaysPaced() {
  // A game at 50 FPS on a 60 Hz host display: the frames are captured on its refresh, 33, 17, 17, 17 and 17 ms apart
  std::vector<Frame> frames = Host(20, [](int k) { return 1000.37 + std::ceil(k * 20.0 / kFrame60 - 1e-9) * kFrame60; });
  Arrive(frames, 60, 4.0, 3);
  double held = HeldPercent(Run(60, frames), 3000);
  test_support::Check(held > 90, "50 FPS in a 60 FPS stream: more than 90% of the frames held", Describe(held), __FILE__,
                      __LINE__);
  // A game at 80 FPS on a 120 Hz host display in a 120 FPS stream
  frames = Host(20, [](int k) { return 1000.37 + std::ceil(k * 12.5 / kFrame120 - 1e-9) * kFrame120; });
  Arrive(frames, 120, 4.0, 4);
  held = HeldPercent(Run(120, frames), 3000);
  test_support::Check(held > 90, "80 FPS in a 120 FPS stream: more than 90% of the frames held", Describe(held),
                      __FILE__, __LINE__);
}

// A host display at 59.94 Hz in a 60 FPS stream on a link with little jitter: one frame in 1000 is missing, and the
// timestamps follow the slower host (the pacer held only a third of the frames, as the host fell behind its timestamps
// by 1 ms per second and the time difference followed only every second window)
static void HostDisplayAt5994HzStaysPaced() {
  std::vector<Frame> frames = Host(20, [](int k) { return 1000.37 + k * 1000.0 / 59.94; });
  Arrive(frames, 60, 2.0, 5);
  const std::vector<Outcome> outcomes = Run(60, frames);
  const double held = HeldPercent(outcomes, 3000);
  test_support::Check(held > 90, "more than 90% of the frames held", Describe(held), __FILE__, __LINE__);
  // The timestamps stay within 1 ms of the capture times
  double worst = 0;
  for (const Outcome& outcome : outcomes) {
    worst = std::max(worst, std::abs(outcome.pts * 1000 - (std::floor(outcome.captureMs) - std::floor(outcomes.front().captureMs))));
  }
  test_support::Check(worst <= 1.0 + 1e-6, "timestamps within 1 ms of the capture times", Describe(worst), __FILE__,
                      __LINE__);
}

// The RTP timestamp wraps at 2^32 after about 13.3 hours, so the capture time jumps from 47,721,850 ms to 5 ms here
// (the host captured that frame 13.8 ms after the one before): the timestamp moves on by that interval, and the pacer
// neither waits for days nor stops holding the frames
static void WrapOfTheCaptureTimeKeepsThePace() {
  std::vector<Frame> frames = Host(4, [](int k) {
    return k <= 120 ? 47721850.4 - (120 - k) * kFrame60 : 47721858.84 + 5.4 + (k - 121) * kFrame60;
  });
  CHECK_EQ(frames[120].hostTimeMs, 47721850u);
  CHECK_EQ(frames[121].hostTimeMs, 5u);
  Arrive(frames, 60, 4.0, 6);
  const std::vector<Outcome> outcomes = Run(60, frames);
  const double stepMs = (outcomes[121].pts - outcomes[120].pts) * 1000;
  test_support::Check(stepMs >= 13 && stepMs <= 15, "a step of about 14 ms across the wrap", Describe(stepMs), __FILE__,
                      __LINE__);
  double longestHold = 0;
  for (size_t i = 121; i < outcomes.size(); i++) {
    longestHold = std::max(longestHold, (outcomes[i].append - outcomes[i].dequeue) * 1000);
    CHECK(outcomes[i].pts > outcomes[i - 1].pts);
  }
  test_support::Check(longestHold <= kFrame60, "no frame after the wrap held longer than one frame",
                      Describe(longestHold), __FILE__, __LINE__);
  const double held = HeldPercent(outcomes, outcomes[121].captureMs - outcomes.front().captureMs);
  test_support::Check(held > 90, "more than 90% of the frames after the wrap held", Describe(held), __FILE__, __LINE__);
}

// A capture time that repeats or steps back (a frame the host encoded again is stamped with the time it was sent) still
// raises the timestamp by 1 ms, and the next frame follows the later capture time
static void RepeatedOrEarlierCaptureTimesKeepTheTimestampsRising() {
  std::vector<Frame> frames;
  const uint32_t hostTimes[] = {1000, 1016, 1033, 1050, 1050, 1047, 1066, 1083, 1100};
  for (int k = 0; k < 9; k++) {
    frames.push_back({k + 1, (double)hostTimes[k], hostTimes[k], (hostTimes[k] - 1000 + 7) / 1000.0});
  }
  KeepInOrder(frames, 60);
  const std::vector<Outcome> outcomes = Run(60, frames);
  for (size_t i = 1; i < outcomes.size(); i++) {
    test_support::Check(outcomes[i].pts - outcomes[i - 1].pts >= 1e-3 - 1e-9, "each step at least 1 ms",
                        Describe((outcomes[i].pts - outcomes[i - 1].pts) * 1000), __FILE__, __LINE__);
  }
  CHECK(std::abs(outcomes[4].pts - outcomes[3].pts - 1e-3) < 1e-9);
  CHECK(std::abs(outcomes[5].pts - outcomes[4].pts - 1e-3) < 1e-9);
  // 1066 ms is one frame after the later 1050 ms, so the timestamp moves on by one frame duration from the 52 ms of the
  // frame before; the two frames of 1 ms stay in the time of the host, 2 ms ahead of the capture times
  CHECK(std::abs(outcomes[6].pts * 1000 - (52.0 + kFrame60)) < 1e-6);
  CHECK(std::abs(outcomes[8].pts * 1000 - 102.0) < 1e-6);
}

// A break of more than a second (e.g. while the video track was closed) moves the timestamp on by one frame duration
// instead of the length of the break, as before, and the timestamps follow the host again after it
static void BreakInTheStreamMovesOnByOneFrame() {
  std::vector<Frame> frames;
  for (int k = 0; k < 120; k++) {
    const double captureMs = 1000.37 + k * kFrame60 + (k >= 60 ? 5000.0 : 0.0);
    frames.push_back({k + 1, captureMs, HostTimeMs(captureMs), 0.0});
  }
  Arrive(frames, 60, 4.0, 7);
  const std::vector<Outcome> outcomes = Run(60, frames);
  CHECK(std::abs(outcomes[60].pts - outcomes[59].pts - 1.0 / 60) < 1e-9);
  CHECK(std::abs(outcomes[61].pts - outcomes[60].pts - 1.0 / 60) < 1e-9);
}

// The latency of the network rises by riseMs for 4 s (over 300 ms, from 5 s on) and falls back at once at 9 s. The
// frames captured just before the fall arrive late and the next ones right behind them.
static std::vector<Frame> LatencyStep(int fps, double riseMs, unsigned seed) {
  const double frameMs = 1000.0 / fps;
  std::vector<Frame> frames = Host(14, [frameMs](int k) { return 1000.37 + k * frameMs; });
  Arrive(frames, fps, 4.0, seed);
  for (Frame& frame : frames) {
    const double t = frame.captureMs - frames.front().captureMs;
    if (t >= 5000 && t < 9000) {
      frame.arrival += riseMs / 1000.0 * std::min(1.0, (t - 5000) / 300.0);
    }
  }
  KeepInOrder(frames, fps);
  return frames;
}

// When the latency falls back after a sustained rise, the pacer follows the fall with the frames that show it, instead
// of holding every frame back by the old latency for up to a second, which piled up 17 frames at 120 FPS (the decode
// unit queue holds 15 and is flushed with a keyframe request when it overflows)
static void FallOfTheLatencyIsFollowedAtOnce() {
  for (const auto& step : {std::make_tuple(120, 150.0), std::make_tuple(120, 100.0), std::make_tuple(60, 100.0)}) {
    const int fps = std::get<0>(step);
    const double frameMs = 1000.0 / fps;
    const std::vector<Outcome> outcomes = Run(fps, LatencyStep(fps, std::get<1>(step), 8));
    const double first = outcomes.front().captureMs;
    const std::string name = std::to_string(fps) + " FPS, " + Describe(std::get<1>(step)) + " ms: ";
    // The time difference of the pacer before the rise
    double before = 0;
    int mostPending = 0;
    double longestHold = 0;
    int framesWithTheOldDifference = 0;
    for (const Outcome& outcome : outcomes) {
      const double t = outcome.captureMs - first;
      if (t < 5000) {
        before = outcome.ptsDiff;
      }
      mostPending = std::max(mostPending, outcome.pending);
      if (t >= 9000) {
        longestHold = std::max(longestHold, (outcome.append - outcome.arrival) * 1000);
      }
      // The frames that arrive at their usual time again (captured more than the rise after the fall) are paced by the
      // time difference of before the rise. The end of a window can raise it for one frame, since the window still
      // has the frames of the rise, which the next frame undoes before its wait.
      if (t >= 9000 + std::get<1>(step) + 2 * frameMs && t < 10000 && (outcome.ptsDiff - before) * 1000 > 2 * frameMs) {
        framesWithTheOldDifference++;
      }
    }
    test_support::Check(mostPending <= 6, name + "at most 6 frames waiting", std::to_string(mostPending), __FILE__,
                        __LINE__);
    test_support::Check(longestHold <= 2 * frameMs, name + "no frame held longer than two frames after the fall",
                        Describe(longestHold), __FILE__, __LINE__);
    test_support::Check(framesWithTheOldDifference <= 1,
                        name + "the time difference is back within two frames of the one before the rise",
                        std::to_string(framesWithTheOldDifference) + " frames with the old one", __FILE__, __LINE__);
  }
}

// Following a fall of the latency at once leaves the usual streams alone: with arrival jitter of 0 to 10 ms, a burst of
// 3 frames every 3 s and 2% of the frames late by 10 to 25 ms, the time difference of the pacer only changes at the end
// of a window, at 120 FPS as at 60 FPS (a threshold of one frame duration would follow the jitter at 120 FPS)
static void UsualJitterDoesNotMoveThePacerWithinAWindow() {
  for (int fps : {60, 120}) {
    const double frameMs = 1000.0 / fps;
    std::vector<Frame> frames = Host(20, [frameMs](int k) { return 1000.37 + k * frameMs; });
    Arrive(frames, fps, 10.0, 9);
    std::mt19937 random(10);
    for (size_t i = 0; i + 2 < frames.size(); i++) {
      if (random() % 50 == 0) {
        frames[i].arrival += (10.0 + random() / 4294967296.0 * 15.0) / 1000.0;
      }
      if (i > 0 && i % (size_t)(3 * fps) == 0) {
        frames[i].arrival = frames[i + 2].arrival - 0.2e-3;
        frames[i + 1].arrival = frames[i + 2].arrival - 0.1e-3;
      }
    }
    KeepInOrder(frames, fps);
    const std::vector<Outcome> outcomes = Run(fps, frames);
    int changes = 0;
    for (size_t i = 1; i < outcomes.size(); i++) {
      if (outcomes[i].ptsDiff != outcomes[i - 1].ptsDiff && outcomes[i].windowStart == outcomes[i - 1].windowStart) {
        changes++;
      }
    }
    test_support::Check(changes == 0, std::to_string(fps) + " FPS: no change of the time difference within a window",
                        std::to_string(changes), __FILE__, __LINE__);
  }
}

// The buffer of the player is full for fullMs when the second frame of a stream arrives: what the decoder thread
// returns, how long it kept trying, and how often it appended
struct BufferFullOutcome {
  int result;
  double retryMs;
  int calls;
};
static BufferFullOutcome BufferFullFor(int fps, double fullMs, int code = kAppendResultBufferFull) {
  simNow = 1.0;
  StartStream(fps, false);
  // (CHECK_EQ evaluates its arguments twice)
  const int first = Submit(1, true, 1000, simNow);
  CHECK_EQ(first, DR_OK);
  appendCalls = 0;
  const double until = simNow + fullMs / 1000.0;
  appendResult = [until, code] { return simNow < until ? code : 0; };
  const double start = simNow;
  BufferFullOutcome outcome;
  outcome.result = Submit(2, false, 1017, simNow);
  outcome.retryMs = (simNow - start) * 1000;
  outcome.calls = appendCalls;
  samsung::wasm::TestAppendPacketHook() = nullptr;
  return outcome;
}

// A full buffer of the player is retried for at least 16 ms, at 120 FPS as at 60 FPS (it gave up after 8 ms at 120 FPS),
// before the decoder asks for a keyframe; at 30 FPS for one frame duration
static void FullBufferIsRetriedFor16Ms() {
  for (int fps : {60, 120}) {
    const std::string name = std::to_string(fps) + " FPS: ";
    BufferFullOutcome outcome = BufferFullFor(fps, 12);
    test_support::Check(outcome.result == DR_OK && s_AppendBufferFull == 1 && s_AppendBufferFullRecovered == 1,
                        name + "full for 12 ms, appended", std::to_string(outcome.result), __FILE__, __LINE__);
    outcome = BufferFullFor(fps, 40);
    test_support::Check(outcome.result == DR_NEED_IDR && s_AppendBufferFullRecovered == 0,
                        name + "full for 40 ms, keyframe needed", std::to_string(outcome.result), __FILE__, __LINE__);
    test_support::Check(outcome.retryMs >= 15.5 && outcome.retryMs <= 18.5, name + "retried for about 16 ms",
                        Describe(outcome.retryMs), __FILE__, __LINE__);
  }
  BufferFullOutcome outcome = BufferFullFor(30, 25);
  CHECK_EQ(outcome.result, DR_OK);
  outcome = BufferFullFor(30, 60);
  CHECK_EQ(outcome.result, DR_NEED_IDR);
  test_support::Check(outcome.retryMs >= 32.5 && outcome.retryMs <= 35.5, "30 FPS: retried for about 33 ms",
                      Describe(outcome.retryMs), __FILE__, __LINE__);
}

// The retry stops as soon as the video track closes, and a frame that the player rejects for another reason (it
// expects a keyframe) isn't retried at all
static void RetryStopsWhenTheTrackCloses() {
  simNow = 1.0;
  StartStream(120, false);
  const int first = Submit(1, true, 1000, simNow);
  CHECK_EQ(first, DR_OK);
  appendCalls = 0;
  appendResult = [] {
    if (appendCalls == 3) {
      g_Instance->*Pointer(VideoStartedMember()) = false;
    }
    return kAppendResultBufferFull;
  };
  const int second = Submit(2, false, 1008, simNow);
  CHECK_EQ(second, DR_NEED_IDR);
  CHECK_EQ(appendCalls, 3);
  samsung::wasm::TestAppendPacketHook() = nullptr;

  const BufferFullOutcome outcome = BufferFullFor(60, 1000, kAppendResultExpectsKeyframe);
  CHECK_EQ(outcome.result, DR_NEED_IDR);
  CHECK_EQ(outcome.calls, 1);
  CHECK_EQ(s_AppendKeyframeRequired, 1u);
}

int main() {
  test_support::RunTest("a steady host keeps the timestamps and the pace of before", SteadyHostKeepsTheTimestampsAndThePace);
  test_support::RunTest("after frames lost on the network the pacer holds the frames again at once",
                        LostFramesKeepThePacerHolding);
  test_support::RunTest("a host below the stream rate stays paced", HostBelowTheStreamRateStaysPaced);
  test_support::RunTest("a host display at 59.94 Hz stays paced", HostDisplayAt5994HzStaysPaced);
  test_support::RunTest("the wrap of the capture time after 13.3 hours keeps the pace", WrapOfTheCaptureTimeKeepsThePace);
  test_support::RunTest("repeated or earlier capture times keep the timestamps rising",
                        RepeatedOrEarlierCaptureTimesKeepTheTimestampsRising);
  test_support::RunTest("a break in the stream moves the timestamps on by one frame", BreakInTheStreamMovesOnByOneFrame);
  test_support::RunTest("a fall of the latency after a sustained rise is followed at once",
                        FallOfTheLatencyIsFollowedAtOnce);
  test_support::RunTest("the usual jitter doesn't move the pacer within a window", UsualJitterDoesNotMoveThePacerWithinAWindow);
  test_support::RunTest("a full buffer of the player is retried for 16 ms", FullBufferIsRetriedFor16Ms);
  test_support::RunTest("the retry stops when the track closes, and other rejections aren't retried",
                        RetryStopsWhenTheTrackCloses);
  return test_support::Summary();
}
