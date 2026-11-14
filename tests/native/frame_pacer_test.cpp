// Checks the timing of the video decoder thread in VidDecSubmitDecodeUnit() (wasm/wasmplayer.cpp, included directly): the
// presentation timestamps that follow the capture times of the host, the frame pacer that releases the frames at an
// even pace, and the retry of a frame that the video player of the TV rejects because its buffer is full.
// The video player of the TV shows a frame as soon as it is appended (in both latency modes of the app), so the moments
// of the appends are what the viewer sees. The test runs the frames on a simulated clock: std::chrono::steady_clock and
// usleep() of the file are replaced by the clock of the test, LiGetMillis() follows it, and the stub of AppendPacket()
// (TestAppendPacketHook() in stubs/samsung/wasm/common.h) records the moment and the presentation timestamp of every
// append. The frames of a scenario arrive in the decode unit queue at the times it gives, and the decoder thread takes
// the next one as soon as it is free, as moonlight-common-c does, and LiGetPendingVideoFrames() counts the frames that
// arrived meanwhile. The scenarios follow the probes that measured the pacer (a host at a steady rate, on the grid of a
// faster display, below the stream rate, with frames lost, a capture timer that wakes up late now and then, a host that
// skips a tick, a latency that rises and falls back, for seconds or for 1.3 to 2.8 s, a broad jitter), with uniform
// arrival jitter and normally distributed noise of the capture times, both from a seeded std::mt19937, whose numbers
// the C++ standard fixes on every platform (the noise is drawn here, since std::normal_distribution isn't fixed).
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
// decoder gets it (decodeUnit->presentationTimeMs), the moment it arrives in the decode unit queue (simulated seconds),
// whether the video track of the TV is closed then (the decoder thread discards it), whether it is a duplicate of
// Sunshine (the previous image encoded again, which carries no host processing latency), and whether it is a keyframe
// (the first frame of a scenario is one too)
struct Frame {
  int number;
  double captureMs;
  uint32_t hostTimeMs;
  double arrival;
  bool trackClosed = false;
  bool duplicate = false;
  bool keyframe = false;
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
bool LiHostSupportsReferenceFrameInvalidation(void) {
  return false;
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
static int Submit(int number, bool idr, uint32_t hostTimeMs, double arrival, bool duplicate = false) {
  static char data[1000];
  LENTRY entry = {};
  entry.data = data;
  entry.length = sizeof(data);
  entry.bufferType = BUFFER_TYPE_PICDATA;
  DECODE_UNIT unit = {};
  unit.frameNumber = number;
  unit.frameType = idr ? FRAME_TYPE_IDR : FRAME_TYPE_PFRAME;
  unit.frameHostProcessingLatency = duplicate ? 0 : 40;
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
    g_Instance->*Pointer(VideoStartedMember()) = !frame.trackClosed;
    outcome.result =
      Submit(frame.number, runningIndex == 0 || frame.keyframe, frame.hostTimeMs, frame.arrival, frame.duplicate);
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

// Noise of sigmaMs (normally distributed, cut off at 3 sigma) on the capture times as the host stamps them, e.g. the
// wake-up of the capture timer on the host; the frames are still captured, and arrive, on the grid of the stream rate
static void StampNoise(std::vector<Frame>& frames, double sigmaMs, unsigned seed) {
  std::mt19937 random(seed);
  for (Frame& frame : frames) {
    // Box-Muller from two uniform numbers in (0, 1]
    const double u1 = (random() + 1.0) / 4294967296.0;
    const double u2 = (random() + 1.0) / 4294967296.0;
    const double noise = sigmaMs * std::sqrt(-2.0 * std::log(u1)) * std::cos(2.0 * 3.14159265358979323846 * u2);
    frame.hostTimeMs = HostTimeMs(frame.captureMs + std::clamp(noise, -3.0 * sigmaMs, 3.0 * sigmaMs));
  }
}

// The capture times of a Windows host whose display refreshes at displayHz, faster than the stream rate: Sunshine
// captures on the tick of the stream rate (its timer wakes up to lateMs late) and stamps each frame with the present
// time of the latest desktop update, on the grid of the display (display_vram.cpp). captureMs is the moment of the
// capture, which the frame arrives after.
static void StampOnDisplayGrid(std::vector<Frame>& frames, double displayHz, double lateMs, unsigned seed) {
  std::mt19937 random(seed);
  const double first = frames.front().captureMs;
  const double refreshMs = 1000.0 / displayHz;
  for (Frame& frame : frames) {
    frame.captureMs += random() / 4294967296.0 * lateMs;
    frame.hostTimeMs = HostTimeMs(first + std::floor((frame.captureMs - first) / refreshMs + 1e-9) * refreshMs);
  }
}

// The capture times of a Linux host whose capture timer wakes up up to 0.4 ms late, and now and then (a share of the
// frames) loMs to hiMs late, e.g. on a busy host; the frames are still captured, and arrive, on the grid of the stream
// rate
static void StampLate(std::vector<Frame>& frames, double share, double loMs, double hiMs, unsigned seed) {
  std::mt19937 random(seed);
  for (Frame& frame : frames) {
    const double late = random() / 4294967296.0 < share ? loMs + random() / 4294967296.0 * (hiMs - loMs)
                                                         : random() / 4294967296.0 * 0.4;
    frame.hostTimeMs = HostTimeMs(frame.captureMs + late);
  }
}

// The frames of a Windows host for `seconds` whose display refreshes at displayHz, faster than the stream rate, with a
// capture timer that wakes up 0.1 ms late, and at a share of the ticks loMs to hiMs later. Sunshine captures in frame
// pacing groups (display_base.cpp): from the present time of the first image of a group on, at every tick of the
// stream rate, and stamps each frame with the present time of the latest desktop update, on the grid of the display
// (display_vram.cpp). A capture that wakes up late takes the image of the display at that time and goes out that much
// later. When a tick has no new image, the group ends: with skipTick (the model of the probes before), the host waits
// up to 2 ms for one and otherwise skips the tick; without it (Sunshine), the capture waits for the next image and
// starts a new group at its present time, so the ticks move. The frame numbers stay consecutive. captureMs is the
// moment of the capture, which the frame is sent at; ticks gets the time the host meant each frame for (its tick, or
// the present time that starts a group).
static std::vector<Frame> WindowsHost(double seconds, int fps, double displayHz, double share, double loMs, double hiMs,
                                      bool skipTick, unsigned seed, std::vector<double>& ticks) {
  const double frameMs = 1000.0 / fps;
  const double refreshMs = 1000.0 / displayHz;
  const double first = 1000.37;
  // The display presents at first - 0.3 + j * refreshMs: the index of the latest present at atMs, and its time
  auto latest = [first, refreshMs](double atMs) { return (long)std::floor((atMs - first + 0.3) / refreshMs + 1e-9); };
  auto presentAt = [first, refreshMs](long index) { return first - 0.3 + index * refreshMs; };
  std::mt19937 random(seed);
  std::vector<Frame> frames;
  ticks.clear();
  double groupStart = first;
  int groupFrames = 0;
  long lastImage = -1;
  while (groupStart + groupFrames * frameMs - first <= seconds * 1000.0) {
    const double tick = groupStart + groupFrames * frameMs;
    const double late = random() / 4294967296.0 < share ? loMs + random() / 4294967296.0 * (hiMs - loMs) : 0.0;
    double captureMs = tick + 0.1 + late;
    long image = latest(captureMs);
    double meant = tick;
    if (image <= lastImage) {
      image = lastImage + 1;
      if (skipTick && presentAt(image) > captureMs + 2.0) {
        groupFrames++;
        continue;
      }
      captureMs = presentAt(image) + 0.1;
      if (!skipTick) {
        // A new group from this image on
        meant = presentAt(image);
        groupStart = meant;
        groupFrames = 0;
      }
    }
    lastImage = image;
    groupFrames++;
    frames.push_back({(int)frames.size() + 1, captureMs, HostTimeMs(presentAt(image)), 0.0});
    ticks.push_back(meant);
  }
  return frames;
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

// Counts of the frames captured from fromMs (after the first capture) on: how many there are, and how many of them
// pass a check
struct Count {
  int frames = 0;
  int passed = 0;
};

// The timestamps from fromMs on that are exactly one frame duration after the one before (frame numbers count: a frame
// after a gap of the frame numbers is that many frame durations more after it)
static Count StepsOfOneFrame(const std::vector<Frame>& frames, const std::vector<Outcome>& outcomes, int fps,
                             double fromMs) {
  Count count;
  for (size_t i = 1; i < outcomes.size(); i++) {
    if (outcomes[i].captureMs - outcomes.front().captureMs >= fromMs) {
      count.frames++;
      const int frameSteps = frames[i].number - frames[i - 1].number;
      count.passed += std::abs(outcomes[i].pts - outcomes[i - 1].pts - (double)frameSteps / fps) < 1e-9 ? 1 : 0;
    }
  }
  return count;
}

// The appends from fromMs on that come within toleranceMs of their capture interval after the append before (of a
// host that sends its frames at their capture times), or of a frame duration (intervalMs > 0)
static Count EvenAppends(const std::vector<Outcome>& outcomes, double fromMs, double toleranceMs,
                         double intervalMs = 0) {
  Count count;
  for (size_t i = 1; i < outcomes.size(); i++) {
    if (outcomes[i].captureMs - outcomes.front().captureMs >= fromMs) {
      count.frames++;
      const double expectedMs = intervalMs > 0 ? intervalMs : outcomes[i].captureMs - outcomes[i - 1].captureMs;
      count.passed += std::abs((outcomes[i].append - outcomes[i - 1].append) * 1000 - expectedMs) <= toleranceMs ? 1 : 0;
    }
  }
  return count;
}

static std::string Describe(const Count& count) {
  return std::to_string(count.passed) + " of " + std::to_string(count.frames);
}

// A steady host: the timestamps and the pace of the appends stay exactly as they were before the timestamps followed
// the capture times, which come in whole milliseconds, also when the host stamps them with some timing noise (0.25 ms
// at 60 FPS, 0.35 ms at 120 FPS)
static void SteadyHostKeepsTheTimestampsAndThePace() {
  for (const auto& run : {std::make_tuple(60, 0.0), std::make_tuple(60, 0.25), std::make_tuple(120, 0.35)}) {
    const int fps = std::get<0>(run);
    const double frameMs = 1000.0 / fps;
    const std::string name = std::to_string(fps) + " FPS, noise " + Describe(std::get<1>(run)) + " ms: ";
    std::vector<Frame> frames = Host(20, [frameMs](int k) { return 1000.37 + k * frameMs; });
    if (std::get<1>(run) > 0) {
      StampNoise(frames, std::get<1>(run), 11);
    }
    Arrive(frames, fps, 4.0, 1);
    const std::vector<Outcome> outcomes = Run(fps, frames);
    int wrongSteps = 0;
    for (size_t i = 1; i < outcomes.size(); i++) {
      wrongSteps += std::abs(outcomes[i].pts - outcomes[i - 1].pts - 1.0 / fps) > 1e-9 ? 1 : 0;
    }
    test_support::Check(wrongSteps == 0, name + "every timestamp one frame duration after the one before",
                        std::to_string(wrongSteps) + " other steps", __FILE__, __LINE__);
    CHECK(std::abs(outcomes.back().pts - (outcomes.size() - 1) / (double)fps) < 1e-6);
    // After the first windows of the pacer, the frames reach the player every frame duration
    int intervals = 0;
    int even = 0;
    for (size_t i = 1; i < outcomes.size(); i++) {
      if (outcomes[i].captureMs - outcomes.front().captureMs >= 3000) {
        intervals++;
        even += std::abs((outcomes[i].append - outcomes[i - 1].append) * 1000 - frameMs) <= 0.3 ? 1 : 0;
      }
    }
    test_support::Check(even >= intervals * 0.97,
                        name + "97% of the append intervals within 0.3 ms of a frame duration",
                        std::to_string(even) + " of " + std::to_string(intervals), __FILE__, __LINE__);
    const double held = HeldPercent(outcomes, 3000);
    test_support::Check(held > 95, name + "the pacer holds more than 95% of the frames", Describe(held), __FILE__,
                        __LINE__);
  }
}

// A Windows host whose display refreshes faster than the stream rate, but not at a multiple of it: Sunshine sends the
// frames on the tick of the stream rate and stamps them on the grid of the display, e.g. 7, 7, 7, 7 and 14 ms apart at
// 120 FPS from 144 Hz. The timestamps and the appends keep the pace of the ticks, as for a steady host (the pacer
// copied the steps of the display into the appends, 7 and 14 ms apart instead of 8.3 ms at 120 FPS from 144 Hz). After
// the first second, in which the timestamps settle on the capture times, every timestamp is one frame duration after
// the one before. With the capture timer up to 2 ms late, the capture times of 120 FPS from 144 Hz spread over almost
// a whole frame duration, and nearly every timestamp still is.
static void HostDisplayOffTheStreamGridKeepsThePace() {
  const std::tuple<int, double, double> cases[] = {{60, 75, 0.5},   {60, 100, 0.5},  {60, 144, 0.5},  {60, 165, 0.5},
                                                   {90, 120, 0.5},  {90, 144, 0.5},  {120, 144, 0.5}, {120, 165, 0.5},
                                                   {120, 144, 2.0}, {120, 165, 2.0}};
  for (const auto& host : cases) {
    const int fps = std::get<0>(host);
    const double lateMs = std::get<2>(host);
    const double frameMs = 1000.0 / fps;
    const std::string name = std::to_string(fps) + " FPS from a " + Describe(std::get<1>(host)) +
      " Hz display, timer up to " + Describe(lateMs) + " ms late: ";
    std::vector<Frame> frames = Host(20, [frameMs](int k) { return 1000.37 + k * frameMs; });
    StampOnDisplayGrid(frames, std::get<1>(host), lateMs, 12);
    Arrive(frames, fps, 4.0, 13);
    const std::vector<Outcome> outcomes = Run(fps, frames);
    int steps = 0;
    int wrongSteps = 0;
    int intervals = 0;
    int even = 0;
    for (size_t i = 1; i < outcomes.size(); i++) {
      const double t = outcomes[i].captureMs - outcomes.front().captureMs;
      if (t >= 1000) {
        steps++;
        wrongSteps += std::abs(outcomes[i].pts - outcomes[i - 1].pts - 1.0 / fps) > 1e-9 ? 1 : 0;
      }
      if (t >= 3000) {
        intervals++;
        even += std::abs((outcomes[i].append - outcomes[i - 1].append) * 1000 - frameMs) <= 0.3 ? 1 : 0;
      }
    }
    if (lateMs <= 0.5) {
      test_support::Check(wrongSteps == 0, name + "every timestamp one frame duration after the one before",
                          std::to_string(wrongSteps) + " other steps of " + std::to_string(steps), __FILE__, __LINE__);
    } else {
      test_support::Check(wrongSteps <= steps / 100,
                          name + "99% of the timestamps one frame duration after the one before",
                          std::to_string(wrongSteps) + " other steps of " + std::to_string(steps), __FILE__, __LINE__);
    }
    test_support::Check(even >= intervals * 0.97,
                        name + "97% of the append intervals within 0.3 ms of a frame duration",
                        std::to_string(even) + " of " + std::to_string(intervals), __FILE__, __LINE__);
    const double held = HeldPercent(outcomes, 3000);
    test_support::Check(held > 95, name + "the pacer holds more than 95% of the frames", Describe(held), __FILE__,
                        __LINE__);
  }
}

// The reviewer's display probe at 120 FPS from a 165 Hz display (final230-pacer/probe/display_probe.cpp): Sunshine
// stamps each frame with the latest present of the display before its tick, the frames arrive 7 ms after their tick
// plus 0 to 4 ms. After the first second every timestamp is one frame duration after the one before, and the appends
// keep the pace of the ticks exactly: an append interval differs from a frame duration (by more than the 0.3 ms that
// handing a frame to the player takes, and the microseconds of the clock) only where the time difference of the pacer
// changed, at the end of a window. (The probe counted 1.0 instead of 0.2 per 1000 frames off their refresh for a79cb97
// and this version, at one of its 64 phases of the TV: the appends lie on that phase, to half a microsecond.)
static void DisplayProbeAt165HzKeepsThePaceOfTheTicks() {
  const double gridMs = 1000.0 / 165;
  std::vector<Frame> frames = Host(20, [](int k) { return 1000.37 + k * kFrame120; });
  for (Frame& frame : frames) {
    frame.hostTimeMs = HostTimeMs(std::floor((frame.captureMs - 0.5) / gridMs) * gridMs + 0.5);
  }
  Arrive(frames, 120, 4.0, 2);
  const std::vector<Outcome> outcomes = Run(120, frames);
  const Count steps = StepsOfOneFrame(frames, outcomes, 120, 1000);
  test_support::Check(steps.passed == steps.frames, "every timestamp one frame duration after the one before",
                      Describe(steps), __FILE__, __LINE__);
  int intervals = 0;
  int moved = 0;
  int windowChanges = 0;
  for (size_t i = 2; i < outcomes.size(); i++) {
    if (outcomes[i].captureMs - outcomes.front().captureMs >= 3000) {
      intervals++;
      moved += std::abs((outcomes[i].append - outcomes[i - 1].append) * 1000 - kFrame120) > 0.01 ? 1 : 0;
      windowChanges += outcomes[i - 1].ptsDiff != outcomes[i - 2].ptsDiff ? 1 : 0;
    }
  }
  test_support::Check(moved <= windowChanges,
                      "the appends move off the pace of the ticks only where the time difference of the pacer changed",
                      std::to_string(moved) + " of " + std::to_string(intervals) + " intervals, " +
                        std::to_string(windowChanges) + " changes",
                      __FILE__, __LINE__);
  const double held = HeldPercent(outcomes, 3000);
  test_support::Check(held > 99, "the pacer holds more than 99% of the frames", Describe(held), __FILE__, __LINE__);
}

// Frames lost on the network: the timestamp moves on by the lost frames, so the frames after the gap arrive at their
// usual time and the pacer holds them again at once (it passed every frame through for 1.5 to 2.4 s). This holds for 4
// lost frames, for a Wi-Fi roam of 300 ms and for an outage of 1.5 s.
static void LostFramesKeepThePacerHolding() {
  std::vector<Frame> all = Host(20, [](int k) { return 1000.37 + k * kFrame60; });
  Arrive(all, 60, 4.0, 2);
  // The first lost frame and the number lost: at 5, 9, 11, 13 and 15 s
  const std::pair<int, int> losses[] = {{300, 4}, {540, 4}, {660, 18}, {780, 4}, {900, 90}};
  std::vector<Frame> frames;
  std::vector<std::pair<int, int>> firstAfterGap;
  for (const Frame& frame : all) {
    const int k = frame.number - 1;
    bool lost = false;
    for (const auto& loss : losses) {
      lost = lost || (k >= loss.first && k < loss.first + loss.second);
      if (k == loss.first + loss.second) {
        firstAfterGap.push_back({(int)frames.size(), loss.second});
      }
    }
    if (!lost) {
      frames.push_back(frame);
    }
  }
  const std::vector<Outcome> outcomes = Run(60, frames);
  CHECK_EQ(firstAfterGap.size(), 5u);
  for (const auto& gap : firstAfterGap) {
    const int index = gap.first;
    const std::string name = std::to_string(gap.second) + " frames lost: ";
    // The frame after the gap is one frame duration more than the lost frames later
    const double stepFrames = (outcomes[index].pts - outcomes[index - 1].pts) * 60;
    test_support::Check(std::abs(stepFrames - (gap.second + 1)) < 1e-6,
                        name + "the timestamp moves on by the lost frames", Describe(stepFrames) + " frames", __FILE__,
                        __LINE__);
    // One of the first two frames after the gap is held back again, and nearly all of the next second
    test_support::Check(Held(outcomes[index]) || Held(outcomes[index + 1]),
                        name + "one of the first two frames after the gap held", "", __FILE__, __LINE__);
    const double afterMs = outcomes[index].captureMs - outcomes.front().captureMs;
    const double held = HeldPercent(outcomes, afterMs, afterMs + 1000);
    test_support::Check(held > 90, name + "the pacer holds more than 90% of the frames of the second after the gap",
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
  // A host display at 72 Hz, slower than a 120 FPS stream (or a game at 72 FPS with a variable refresh rate): Sunshine
  // sends each frame at its present, 1.67 frame durations apart, off the grid of the stream rate. The timestamps follow
  // the capture times, so the appends keep the pace of the presents (counting whole frame durations, they alternated
  // between one and two frame durations, 8.3 and 16.7 ms apart).
  frames = Host(20, [](int k) { return 1000.37 + k * 1000.0 / 72; });
  Arrive(frames, 120, 4.0, 15);
  const std::vector<Outcome> outcomes = Run(120, frames);
  held = HeldPercent(outcomes, 3000);
  test_support::Check(held > 90, "72 Hz host display in a 120 FPS stream: more than 90% of the frames held",
                      Describe(held), __FILE__, __LINE__);
  int intervals = 0;
  int following = 0;
  for (size_t i = 1; i < outcomes.size(); i++) {
    if (outcomes[i].captureMs - outcomes.front().captureMs >= 3000) {
      intervals++;
      const double captureIntervalMs = outcomes[i].captureMs - outcomes[i - 1].captureMs;
      following += std::abs((outcomes[i].append - outcomes[i - 1].append) * 1000 - captureIntervalMs) <= 1.5 ? 1 : 0;
    }
  }
  test_support::Check(following >= intervals * 0.95,
                      "72 Hz host display in a 120 FPS stream: 95% of the append intervals within 1.5 ms of the "
                      "capture intervals",
                      std::to_string(following) + " of " + std::to_string(intervals), __FILE__, __LINE__);
}

// A host display at 59.94 Hz in a 60 FPS stream on a link with little jitter: Sunshine sends each frame at its present,
// one frame in 1000 is missing, and the timestamps follow the slower host (the pacer held only a third of the frames, as
// the host fell behind its timestamps by 1 ms per second and the time difference followed only every second window). A
// host display at 60.06 Hz that sent each frame at its present (Sunshine sends on the tick from a display faster than
// the stream rate, see HostDisplaySlightlyFasterKeepsTheGridOfTheTicks) keeps the grid of the stream rate, which runs
// ahead of it by 1 ms per second, as before the timestamps followed the capture times; the time difference follows the
// arrival times down at the end of each window. In a 120 FPS stream, a host display at 59.94 or 60.06 Hz sends every
// frame at its present, a tick late (Sunshine starts a new frame pacing group with each one): the timestamps follow the
// presents, also as they drift against the ticks by 1 ms per second (e36c85c followed a display at 60.06 Hz only at 0.6
// ms per second and held 86% of the frames, 2.2.1 none).
static void HostDisplayAt5994HzStaysPaced() {
  for (const auto& host : {std::make_pair(60, 59.94), std::make_pair(60, 60.06), std::make_pair(120, 59.94),
                           std::make_pair(120, 60.06)}) {
    const int fps = host.first;
    const double hostHz = host.second;
    const std::string name = std::to_string(fps) + " FPS from " + Describe(hostHz) + " Hz: ";
    std::vector<Frame> frames = Host(40, [hostHz](int k) { return 1000.37 + k * 1000.0 / hostHz; });
    Arrive(frames, fps, 2.0, 5);
    const std::vector<Outcome> outcomes = Run(fps, frames);
    const double held = HeldPercent(outcomes, 3000);
    test_support::Check(held > (fps == 120 ? 95 : 90), name + "most frames held", Describe(held), __FILE__, __LINE__);
    if (fps == 60 && hostHz > 60) {
      const Count steps = StepsOfOneFrame(frames, outcomes, fps, 0);
      test_support::Check(steps.passed == steps.frames, name + "every timestamp one frame duration after the one before",
                          Describe(steps), __FILE__, __LINE__);
      continue;
    }
    if (fps == 60) {
      // The timestamps stay within 2 ms of the capture times: they keep the top of the range of their offset from the
      // capture times within 1 ms, and the capture times come in whole milliseconds
      double worst = 0;
      for (const Outcome& outcome : outcomes) {
        const double hostElapsedMs = std::floor(outcome.captureMs) - std::floor(outcomes.front().captureMs);
        worst = std::max(worst, std::abs(outcome.pts * 1000 - hostElapsedMs));
      }
      test_support::Check(worst <= 2.0 + 1e-6, name + "timestamps within 2 ms of the capture times", Describe(worst),
                          __FILE__, __LINE__);
    }
    const Count even = EvenAppends(outcomes, 3000, 1.0);
    test_support::Check(even.passed >= even.frames * 0.97, name + "97% of the appends within 1 ms of the presents",
                        Describe(even), __FILE__, __LINE__);
  }
}

// A Windows host whose display refreshes only slightly faster than the stream rate (60.06 or 60.02 Hz at 60 FPS,
// 120.12 or 120.03 Hz at 120 FPS): Sunshine sends every frame on the tick of the stream rate (its frame pacing group
// goes on as long as each tick has a new image) and stamps it with the latest present, which lags the tick by 1 ms more
// every second (0.3 ms at 60.02 Hz) and then jumps back by a refresh, every 16.7 s at 60.06 Hz. The timestamps keep the
// grid of the ticks, every one a frame duration after the one before, and the appends keep the pace (e36c85c followed
// the drift by 1 ms per second, and the jump back then looked like a skipped tick: 12 to 23 frames per 1000 off their
// refresh at 60.06 and 120.12 Hz, against 1.3 to 2.5 for 2.2.1). The same holds for a display near twice the stream
// rate (60 FPS from 119.88 or 119.97 Hz, 30 FPS from 59.94 or 60.03 Hz), whose latest present drifts against the tick
// within a refresh and jumps back (e36c85c: 4.6 instead of 1.2 per 1000 at 119.88 Hz), and for capture times stamped
// up to 1 ms late on top.
static void HostDisplaySlightlyFasterKeepsTheGridOfTheTicks() {
  const std::tuple<int, double, double, double> cases[] = {
    {60, 60.06, 40, 0}, {60, 60.02, 60, 0}, {120, 120.12, 40, 0}, {120, 120.03, 40, 0}, {60, 119.88, 40, 0},
    {60, 119.97, 40, 0}, {30, 59.94, 40, 0}, {30, 60.03, 40, 0}, {60, 60.06, 40, 1.0}, {120, 120.12, 40, 1.0}};
  for (const auto& host : cases) {
    const int fps = std::get<0>(host);
    const double frameMs = 1000.0 / fps;
    const std::string name = std::to_string(fps) + " FPS from a " + Describe(std::get<1>(host)) + " Hz display" +
      (std::get<3>(host) > 0 ? ", stamped up to 1 ms late: " : ": ");
    std::vector<Frame> frames = Host(std::get<2>(host), [frameMs](int k) { return 1000.37 + k * frameMs; });
    StampOnDisplayGrid(frames, std::get<1>(host), 0.3, 31);
    if (std::get<3>(host) > 0) {
      std::mt19937 random(32);
      for (Frame& frame : frames) {
        frame.hostTimeMs += random() / 4294967296.0 < std::get<3>(host) / 2 ? 1 : 0;
      }
    }
    Arrive(frames, fps, 4.0, 33);
    const std::vector<Outcome> outcomes = Run(fps, frames);
    const Count steps = StepsOfOneFrame(frames, outcomes, fps, 0);
    test_support::Check(steps.passed == steps.frames, name + "every timestamp one frame duration after the one before",
                        Describe(steps), __FILE__, __LINE__);
    const Count even = EvenAppends(outcomes, 3000, 0.3, frameMs);
    test_support::Check(even.passed >= even.frames * 0.97,
                        name + "97% of the append intervals within 0.3 ms of a frame duration", Describe(even), __FILE__,
                        __LINE__);
    const double held = HeldPercent(outcomes, 3000);
    test_support::Check(held > 95, name + "the pacer holds more than 95% of the frames", Describe(held), __FILE__,
                        __LINE__);
  }
}

// The RTP timestamp wraps at 2^32 after about 13.3 hours, so the capture time jumps from 47,721,850 ms to 5 ms here
// (the host captured that frame 13.8 ms after the one before): the timestamp moves on by that interval, counted as one
// frame duration, and the pacer neither waits for days nor stops holding the frames. A steady host keeps the exact
// timestamps across the wrap, also when the frames around it are lost.
static void WrapOfTheCaptureTimeKeepsThePace() {
  std::vector<Frame> frames = Host(4, [](int k) {
    return k <= 120 ? 47721850.4 - (120 - k) * kFrame60 : 47721858.84 + 5.4 + (k - 121) * kFrame60;
  });
  CHECK_EQ(frames[120].hostTimeMs, 47721850u);
  CHECK_EQ(frames[121].hostTimeMs, 5u);
  Arrive(frames, 60, 4.0, 6);
  const std::vector<Outcome> outcomes = Run(60, frames);
  const double stepMs = (outcomes[121].pts - outcomes[120].pts) * 1000;
  test_support::Check(stepMs >= 13 && stepMs <= 17, "a step of 13 to 17 ms across the wrap", Describe(stepMs),
                      __FILE__, __LINE__);
  double longestHold = 0;
  for (size_t i = 121; i < outcomes.size(); i++) {
    longestHold = std::max(longestHold, (outcomes[i].append - outcomes[i].dequeue) * 1000);
    CHECK(outcomes[i].pts > outcomes[i - 1].pts);
  }
  test_support::Check(longestHold <= kFrame60, "no frame after the wrap held longer than one frame",
                      Describe(longestHold), __FILE__, __LINE__);
  const double held = HeldPercent(outcomes, outcomes[121].captureMs - outcomes.front().captureMs);
  test_support::Check(held > 90, "more than 90% of the frames after the wrap held", Describe(held), __FILE__, __LINE__);

  // The 4 frames after 47,721,850 ms are lost, so the next one comes 5 frame durations later at 74 ms
  std::vector<Frame> steady = Host(4, [](int k) { return 47721850.4 + (k - 120) * kFrame60; });
  Arrive(steady, 60, 4.0, 6);
  steady.erase(steady.begin() + 121, steady.begin() + 125);
  CHECK_EQ(steady[120].hostTimeMs, 47721850u);
  CHECK_EQ(steady[121].hostTimeMs, 74u);
  const std::vector<Outcome> steadyOutcomes = Run(60, steady);
  int wrongSteps = 0;
  for (size_t i = 1; i < steadyOutcomes.size(); i++) {
    const double frames = i == 121 ? 5 : 1;
    wrongSteps += std::abs(steadyOutcomes[i].pts - steadyOutcomes[i - 1].pts - frames / 60) > 1e-9 ? 1 : 0;
  }
  test_support::Check(wrongSteps == 0, "a steady host: every timestamp one frame duration after the one before, and 5 "
                      "across the lost frames", std::to_string(wrongSteps) + " other steps", __FILE__, __LINE__);
}

// Capture times that repeat or step back keep the timestamps rising by at least 1 ms. A frame that repeats the capture
// time of the frame before and arrives right after it (2 ms) is that image encoded again: it takes 1 ms, and the next
// frame goes on from it. A frame on its tick whose capture time repeats the one before (the capture time before it came
// late) or steps back (the clock of the host stepped back by 50 ms, less than a break) is a new frame and takes a frame
// duration (e36c85c gave every such frame 1 ms, which made the frames after them look a frame late: 14 to 27 per 1000
// off their refresh for a clock step of 50 ms, against 1.1 to 2.4 for 2.2.1). A duplicate of Sunshine (no host
// processing latency, stamped with the end of the send of the frame before) takes 1 ms, and the next frame goes on from
// the frame before it, also after a lost frame.
static void RepeatedOrEarlierCaptureTimesKeepTheTimestampsRising() {
  std::vector<Frame> frames;
  // Frames 1 to 6 on their ticks; frame 7 repeats 6, 2 ms later; frames 8 and 9 on their ticks, the capture time of 8
  // late by 15 ms (the same millisecond as 9)
  const double captureMs[] = {1000.4, 1017.1, 1033.7, 1050.4, 1067.1, 1083.7, 1083.7, 1100.4, 1117.1};
  const double sendMs[] = {1000.4, 1017.1, 1033.7, 1050.4, 1067.1, 1083.7, 1085.7, 1100.4, 1117.1};
  for (int k = 0; k < 9; k++) {
    frames.push_back({k + 1, captureMs[k], HostTimeMs(captureMs[k] + (k == 7 ? 16.7 : 0)), (sendMs[k] - 1000 + 7) / 1000.0});
  }
  CHECK_EQ(frames[6].hostTimeMs, frames[5].hostTimeMs);
  CHECK_EQ(frames[8].hostTimeMs, frames[7].hostTimeMs);
  // 10 s more of frames on their ticks, arriving with a jitter of 0 to 4 ms, and at 5 s the clock of the host steps
  // back by 50 ms
  std::mt19937 random(37);
  for (int k = 9; k < 600; k++) {
    const double capture = 1000.4 + (k - 1) * kFrame60;
    frames.push_back({k + 1, capture, HostTimeMs(capture - (k >= 300 ? 50 : 0)),
                      (capture - 1000 + 7 + random() / 4294967296.0 * 4.0) / 1000.0});
  }
  KeepInOrder(frames, 60);
  std::vector<Outcome> outcomes = Run(60, frames);
  for (size_t i = 1; i < outcomes.size(); i++) {
    test_support::Check(outcomes[i].pts - outcomes[i - 1].pts >= 1e-3 - 1e-9, "each step at least 1 ms",
                        Describe((outcomes[i].pts - outcomes[i - 1].pts) * 1000), __FILE__, __LINE__);
  }
  const auto stepMs = [&outcomes](size_t i) { return (outcomes[i].pts - outcomes[i - 1].pts) * 1000; };
  test_support::Check(std::abs(stepMs(6) - 1) < 1e-6, "the image encoded again right after takes 1 ms",
                      Describe(stepMs(6)), __FILE__, __LINE__);
  for (size_t i : {7, 8}) {
    test_support::Check(std::abs(stepMs(i) - kFrame60) < 1e-6,
                        "frame " + std::to_string(i + 1) + " on its tick takes a frame duration", Describe(stepMs(i)),
                        __FILE__, __LINE__);
  }
  const Count steps = StepsOfOneFrame(frames, outcomes, 60, 4900);
  test_support::Check(steps.passed == steps.frames,
                      "the frames around the clock stepping back by 50 ms take a frame duration each", Describe(steps),
                      __FILE__, __LINE__);
  const double held = HeldPercent(outcomes, 4900);
  test_support::Check(held > 95, "more than 95% of the frames around the clock stepping back held", Describe(held),
                      __FILE__, __LINE__);

  // A steady host at 60 FPS that loses a frame, and the keyframe that the client then asks for goes out from the
  // previous image 7 ms after the next frame, stamped with the end of the send of that frame (2 ms after it): the
  // duplicate takes 1 ms, and the frames after it stay on the grid of the ticks (2.2.1 and e36c85c gave it a frame
  // duration, so every later frame looked a frame early)
  frames = Host(10, [](int k) { return 1000.37 + k * kFrame60; });
  Arrive(frames, 60, 2.0, 34);
  frames.erase(frames.begin() + 300);
  Frame duplicate = frames[300];
  duplicate.hostTimeMs = HostTimeMs(frames[300].captureMs + 2.0);
  duplicate.arrival = frames[300].arrival + 7e-3;
  duplicate.duplicate = true;
  frames.insert(frames.begin() + 301, duplicate);
  for (size_t i = 301; i < frames.size(); i++) {
    frames[i].number = (int)i + 2;
  }
  KeepInOrder(frames, 60);
  outcomes = Run(60, frames);
  test_support::Check(std::abs(stepMs(300) - 2 * kFrame60) < 1e-6, "the frame after the lost one takes two frame durations",
                      Describe(stepMs(300)), __FILE__, __LINE__);
  test_support::Check(std::abs(stepMs(301) - 1) < 1e-6, "the duplicate takes 1 ms", Describe(stepMs(301)), __FILE__,
                      __LINE__);
  test_support::Check(std::abs(stepMs(302) - (kFrame60 - 1)) < 1e-6,
                      "the frame after the duplicate goes on from the frame before it", Describe(stepMs(302)), __FILE__,
                      __LINE__);
  frames.erase(frames.begin() + 301);
  outcomes.erase(outcomes.begin() + 301);
  for (size_t i = 301; i < frames.size(); i++) {
    frames[i].number--;
  }
  const Count grid = StepsOfOneFrame(frames, outcomes, 60, 0);
  test_support::Check(grid.passed == grid.frames, "every other timestamp on the grid of the ticks", Describe(grid),
                      __FILE__, __LINE__);
}

// The frames of a host at 60 FPS for 12 s, in which something happens at frame 240 (4 s): the host sends nothing for
// gapMs, the clock of its capture times steps by clockStepMs (the frames still come on time), or the video track of
// the TV is closed for 3 s, which discards the frames meanwhile. 3 frames captured 3 s later are lost on the network.
static std::vector<Frame> HostWithABreak(double gapMs, double clockStepMs, bool trackClosed, unsigned seed) {
  std::vector<Frame> frames = Host(12 + gapMs / 1000, [gapMs](int k) {
    return 1000.37 + k * kFrame60 + (k >= 240 ? gapMs : 0.0);
  });
  Arrive(frames, 60, 4.0, seed);
  for (Frame& frame : frames) {
    const int k = frame.number - 1;
    if (k >= 240) {
      frame.hostTimeMs = HostTimeMs(frame.captureMs + clockStepMs);
    }
    frame.trackClosed = trackClosed && k >= 240 && k < 420;
  }
  const int lostFrom = trackClosed ? 600 : 420;
  frames.erase(frames.begin() + lostFrom, frames.begin() + lostFrom + 3);
  return frames;
}

// After a break in the stream, the timestamps go on by one frame duration instead of the length of the break, as
// before: when the track was closed (e.g. while the app was hidden, for minutes), after a gap of more than 10 s, longer
// than any network outage that the stream survives, and when the clock of the capture times steps back by more than
// 100 ms (counting each earlier capture time as 1 ms turned the pacing off until the clock caught up, for 200 ms back:
// the frames looked later and later). They follow the capture times again from the frame after the break, so the
// frames lost 3 s later move the timestamp on by 4 frames, and the pacer holds the frames after them. A network outage
// of 8 s is followed instead.
static void BreakInTheStreamMovesOnByOneFrame() {
  struct Case {
    const char* name;
    double gapMs;
    double clockStepMs;
    bool trackClosed;
  };
  const Case cases[] = {{"track closed for 3 s", 0, 0, true},
                        {"gap of 12 s", 12000, 0, false},
                        {"clock 5 s back", 0, -5000, false},
                        {"clock 200 ms back", 0, -200, false},
                        {"outage of 8 s", 8000, 0, false}};
  for (const Case& test : cases) {
    const std::string name = std::string(test.name) + ": ";
    const std::vector<Frame> frames = HostWithABreak(test.gapMs, test.clockStepMs, test.trackClosed, 7);
    const std::vector<Outcome> outcomes = Run(60, frames);
    // The first frame after the break, and the last frame before it that was appended
    const int after = test.trackClosed ? 420 : 240;
    const double stepFrames = (outcomes[after].pts - outcomes[239].pts) * 60;
    const double expected = test.gapMs > 0 && test.gapMs <= 10000 ? (test.gapMs + kFrame60) / kFrame60 : 1;
    test_support::Check(std::abs(stepFrames - expected) < 1e-6, name + "the timestamp after the break",
                        Describe(stepFrames) + " frames instead of " + Describe(expected), __FILE__, __LINE__);
    // The next frame follows it by one frame duration
    const double nextStepFrames = (outcomes[after + 1].pts - outcomes[after].pts) * 60;
    test_support::Check(std::abs(nextStepFrames - 1) < 1e-6, name + "the timestamp of the frame after it",
                        Describe(nextStepFrames) + " frames", __FILE__, __LINE__);
    if (test.gapMs > 0 && test.gapMs <= 10000) {
      test_support::Check(Held(outcomes[after]) || Held(outcomes[after + 1]),
                          name + "one of the first two frames after the outage held", "", __FILE__, __LINE__);
    }
    // The 3 frames lost 3 s after the break
    const int lost = after + 180;
    const double lostStepFrames = (outcomes[lost].pts - outcomes[lost - 1].pts) * 60;
    test_support::Check(std::abs(lostStepFrames - 4) < 1e-6, name + "the timestamp moves on by the 3 lost frames",
                        Describe(lostStepFrames) + " frames", __FILE__, __LINE__);
    const double afterMs = outcomes[lost].captureMs - outcomes.front().captureMs;
    const double held = HeldPercent(outcomes, afterMs, afterMs + 1000);
    test_support::Check(held > 90, name + "more than 90% of the frames of the second after the lost frames held",
                        Describe(held), __FILE__, __LINE__);
  }
}

// The latency of the network rises by riseMs for about 4 s (over 300 ms, from 5 s on) and falls back at once at fallMs.
// The frames captured just before the fall arrive late and the next ones right behind them.
static std::vector<Frame> LatencyStep(int fps, double riseMs, unsigned seed, double fallMs = 9000) {
  const double frameMs = 1000.0 / fps;
  std::vector<Frame> frames = Host(14, [frameMs](int k) { return 1000.37 + k * frameMs; });
  Arrive(frames, fps, 4.0, seed);
  for (Frame& frame : frames) {
    const double t = frame.captureMs - frames.front().captureMs;
    if (t >= 5000 && t < fallMs) {
      frame.arrival += riseMs / 1000.0 * std::min(1.0, (t - 5000) / 300.0);
    }
  }
  KeepInOrder(frames, fps);
  return frames;
}

// When the latency falls back after a sustained rise, the pacer follows the fall with the frames that show it, instead
// of holding every frame back by the old latency for up to a second, which piled up 17 frames at 120 FPS (the decode
// unit queue holds 15 and is flushed with a keyframe request when it overflows). The window of the pacer starts again
// with the fall, so its end doesn't raise the time difference with the frames of the rise, and the time difference
// takes the jitter allowance on top of the earlier arrival time, so that the pacer goes on holding the frames after the
// fall (89% at 120 FPS without the allowance), also when the fall comes late in a window (it held only 50 to 60% of
// them, while the end of the window took the time difference back up and the next early frame took it down again).
static void FallOfTheLatencyIsFollowedAtOnce() {
  for (double fallMs : {9000.0, 9850.0}) {
    for (const auto& step : {std::make_tuple(120, 150.0), std::make_tuple(120, 100.0), std::make_tuple(60, 100.0)}) {
      const int fps = std::get<0>(step);
      const double riseMs = std::get<1>(step);
      const double frameMs = 1000.0 / fps;
      const std::vector<Outcome> outcomes = Run(fps, LatencyStep(fps, riseMs, 8, fallMs));
      const double first = outcomes.front().captureMs;
      const std::string name = std::to_string(fps) + " FPS, " + Describe(riseMs) + " ms, fall at " +
        Describe(fallMs / 1000) + " s: ";
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
        if (t >= fallMs) {
          longestHold = std::max(longestHold, (outcome.append - outcome.arrival) * 1000);
        }
        // The frames that arrive at their usual time again (captured more than the rise after the fall) are paced by
        // the time difference of before the rise
        if (t >= fallMs + riseMs + 2 * frameMs && t < fallMs + 1000 &&
            (outcome.ptsDiff - before) * 1000 > 2 * frameMs) {
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
      const double held = HeldPercent(outcomes, fallMs + riseMs, fallMs + riseMs + 2000);
      test_support::Check(held > 95, name + "more than 95% of the frames of the 2 s after the fall held",
                          Describe(held), __FILE__, __LINE__);
    }
  }
}

// The latency of the network rises by riseMs from upMs on and falls back until downMs, over rampMs each (LatencyStep
// falls back at once)
static std::vector<Frame> LatencyEpisode(int fps, double riseMs, unsigned seed, double upMs, double downMs,
                                         double rampMs) {
  const double frameMs = 1000.0 / fps;
  std::vector<Frame> frames = Host(14, [frameMs](int k) { return 1000.37 + k * frameMs; });
  Arrive(frames, fps, 4.0, seed);
  for (Frame& frame : frames) {
    const double t = frame.captureMs - frames.front().captureMs;
    double extraMs = 0;
    if (t >= upMs && t < downMs) {
      extraMs = riseMs * std::min({1.0, (t - upMs) / rampMs, (downMs - t) / rampMs});
    }
    frame.arrival += extraMs / 1000.0;
  }
  KeepInOrder(frames, fps);
  return frames;
}

// What happened after a fall of the latency at fallMs (after the first capture): the most frames waiting in the decode
// unit queue over the whole run, the share of the frames of the 2 s after the fall that the pacer held, and how long
// they waited on average after they arrived, in ms
struct AfterFall {
  int mostPending;
  double held;
  double meanWaitMs;
};
static AfterFall AfterTheFall(const std::vector<Outcome>& outcomes, double fallMs) {
  AfterFall after = {0, HeldPercent(outcomes, fallMs, fallMs + 2000), 0};
  int frames = 0;
  for (const Outcome& outcome : outcomes) {
    after.mostPending = std::max(after.mostPending, outcome.pending);
    const double t = outcome.captureMs - outcomes.front().captureMs;
    if (t >= fallMs && t < fallMs + 2000) {
      after.meanWaitMs += (outcome.append - outcome.arrival) * 1000;
      frames++;
    }
  }
  after.meanWaitMs /= std::max(frames, 1);
  return after;
}

// A latency that rises by 150 or 250 ms for 1.3 to 2.8 s at 120 FPS (from 5 s on, over 300 ms) and falls back at once,
// as over Wi-Fi with bufferbloat: the pacer follows a rise at the end of the second window that shows it, and the fall
// comes before that or soon after it, while one of the last two windows still has frames from before the rise. The
// pacer follows the fall all the same, with the frame that shows it or once 4 frames wait behind it, instead of
// holding every frame by the old latency until the end of the window: that left 17 frames waiting (29 after 250 ms),
// more than the 15 that the decode unit queue holds, which then flushes them with a keyframe request, and it did so
// again and again, since the timestamps of the frames after the flush still showed them early. The frames of the 2 s
// after the fall waited 73 ms on average (114 ms after 250 ms); 2.2.1 overflowed the queue too, once in most such
// episodes. A latency that rises and falls over 300 ms each, for 1.5 or 2 s from 5 to 6 s on, at 60 and 120 FPS, is
// followed the same way (up to 17 frames waited at 120 FPS, and the frames after the fall 60 to 75 ms on average at 60
// FPS). After the fall the pacer holds the frames again (9243201 held 44 to 62% of them).
static void ShortLatencyEpisodeKeepsTheQueueShort() {
  for (double riseMs : {150.0, 250.0}) {
    for (double fallMs = 6300; fallMs <= 7800; fallMs += 100) {
      const std::string name = "120 FPS, " + Describe(riseMs) + " ms until " + Describe(fallMs / 1000) + " s: ";
      const AfterFall after = AfterTheFall(Run(120, LatencyStep(120, riseMs, 8, fallMs)), fallMs + riseMs);
      test_support::Check(after.mostPending <= 10, name + "at most 10 frames waiting",
                          std::to_string(after.mostPending), __FILE__, __LINE__);
      test_support::Check(after.held > 85, name + "more than 85% of the frames of the 2 s after the fall held",
                          Describe(after.held), __FILE__, __LINE__);
      test_support::Check(after.meanWaitMs <= 15, name + "the frames after the fall wait 15 ms or less on average",
                          Describe(after.meanWaitMs), __FILE__, __LINE__);
    }
  }
  for (int fps : {60, 120}) {
    for (double lengthMs : {1500.0, 2000.0}) {
      for (double upMs = 5000; upMs <= 6000; upMs += 100) {
        const std::string name = std::to_string(fps) + " FPS, 150 ms for " + Describe(lengthMs / 1000) +
          " s from " + Describe(upMs / 1000) + " s: ";
        const AfterFall after =
          AfterTheFall(Run(fps, LatencyEpisode(fps, 150, 8, upMs, upMs + lengthMs, 300)), upMs + lengthMs);
        test_support::Check(after.mostPending <= 10, name + "at most 10 frames waiting",
                            std::to_string(after.mostPending), __FILE__, __LINE__);
        test_support::Check(after.held > 90, name + "more than 90% of the frames of the 2 s after the fall held",
                            Describe(after.held), __FILE__, __LINE__);
        test_support::Check(after.meanWaitMs <= 25, name + "the frames after the fall wait 25 ms or less on average",
                            Describe(after.meanWaitMs), __FILE__, __LINE__);
      }
    }
  }
}

// A capture timer on a busy Linux host that now and then wakes up late (and the frame goes out that much later): 1% of
// the capture times 2 to 8 ms late, 0.3% 3 to 10 ms late, or 5% 2 to 6 ms late, at 60 and 120 FPS, 8 streams of 20 s
// each. At 120 FPS a capture time more than about 4.5 ms late fits a skipped tick better than its own, and the next
// frame puts it back on the grid. A late capture time doesn't move the timestamps: they keep the grid of the ticks
// (e36c85c raised the top of the range of the offset with a single late capture time and moved the timestamps along
// for a while, 16 per 1000 frames off their refresh at 120 FPS with 1% 2 to 8 ms late, against 6 for 2.2.1).
static void LateCaptureTimerKeepsThePace() {
  for (int fps : {60, 120}) {
    for (const auto& late :
         {std::make_tuple(0.01, 2.0, 8.0), std::make_tuple(0.003, 3.0, 10.0), std::make_tuple(0.05, 2.0, 6.0)}) {
      const double frameMs = 1000.0 / fps;
      const std::string name = std::to_string(fps) + " FPS, " + Describe(std::get<0>(late) * 100) + "% " +
        Describe(std::get<1>(late)) + " to " + Describe(std::get<2>(late)) + " ms late: ";
      Count steps;
      Count even;
      double held = 0;
      for (unsigned seed = 21; seed < 29; seed++) {
        std::vector<Frame> frames = Host(20, [frameMs](int k) { return 1000.37 + k * frameMs; });
        StampLate(frames, std::get<0>(late), std::get<1>(late), std::get<2>(late), seed);
        Arrive(frames, fps, 4.0, seed + 100);
        const std::vector<Outcome> outcomes = Run(fps, frames);
        const Count runSteps = StepsOfOneFrame(frames, outcomes, fps, 3000);
        const Count runEven = EvenAppends(outcomes, 3000, 0.3, frameMs);
        steps.frames += runSteps.frames;
        steps.passed += runSteps.passed;
        even.frames += runEven.frames;
        even.passed += runEven.passed;
        held += HeldPercent(outcomes, 3000) / 8;
      }
      test_support::Check(steps.passed >= steps.frames * 0.99,
                          name + "99% of the timestamps one frame duration after the one before", Describe(steps),
                          __FILE__, __LINE__);
      test_support::Check(even.passed >= even.frames * 0.97,
                          name + "97% of the append intervals within 0.3 ms of a frame duration", Describe(even),
                          __FILE__, __LINE__);
      test_support::Check(held > 97, name + "the pacer holds more than 97% of the frames", Describe(held), __FILE__,
                          __LINE__);
    }
  }
}

// The timestamps from fromMs on that lie exactly on the grid of the ticks from the first frame (frame numbers count)
static Count TimestampsOnTheGrid(const std::vector<Frame>& frames, const std::vector<Outcome>& outcomes, int fps,
                                 double fromMs) {
  Count count;
  for (size_t i = 1; i < outcomes.size(); i++) {
    if (outcomes[i].captureMs - outcomes.front().captureMs >= fromMs) {
      count.frames++;
      const double gridPts = outcomes.front().pts + (double)(frames[i].number - frames.front().number) / fps;
      count.passed += std::abs(outcomes[i].pts - gridPts) < 1e-6 ? 1 : 0;
    }
  }
  return count;
}

// A capture timer on a busy Linux host that wakes up late, so that the frame goes out that much later too, for two
// frames in a row. Two capture times 2.6 and 2.4 ms late raise the top of the range of the offset for good, but the
// timestamps don't follow it, as no other frame confirms it (43e25f0 moved them 1.4 ms later, 0.1 ms per frame); two
// capture times 5 and 5.5 ms late, which arrive late as well, make the timestamps follow the second one, and the frame
// after them, back on the grid of before, takes them back to it (43e25f0 kept the shift of 2.5 ms and counted the host as
// irregular for a second). In a stream at 90 FPS on a 120 Hz TV, each such move of the timestamps put about a third of
// the frames on another refresh until the next window of the pacer: with 5% of the capture times 2 to 6 ms late, 43e25f0
// showed 130 frames per 1000 on another refresh than they should be in the first 20 s of a stream, against 98 for 2.2.1
// (this version 100). In such streams, nearly every timestamp stays on the grid of the ticks.
static void LateCaptureTimerPairsKeepTheGrid() {
  const double frameMs = 1000.0 / 90;
  std::vector<Frame> frames = Host(14, [frameMs](int k) { return 1000.37 + k * frameMs; });
  for (const auto& late : {std::make_pair(450, 2.6), std::make_pair(451, 2.4), std::make_pair(810, 5.0),
                           std::make_pair(811, 5.5)}) {
    frames[late.first].captureMs += late.second;
    frames[late.first].hostTimeMs = HostTimeMs(frames[late.first].captureMs);
  }
  Arrive(frames, 90, 2.0, 51);
  std::vector<Outcome> outcomes = Run(90, frames);
  int offGrid = 0;
  std::string firstOffGrid;
  for (size_t i = 1; i < outcomes.size(); i++) {
    const double offGridMs = (outcomes[i].pts - outcomes.front().pts - (double)i / 90) * 1000;
    if (i == 811) {
      test_support::Check(offGridMs > 0 && offGridMs <= 3.0, "the second frame 5.5 ms late is followed, by up to 3 ms",
                          Describe(offGridMs), __FILE__, __LINE__);
    } else if (std::abs(offGridMs) > 1e-6) {
      if (offGrid++ == 0) {
        firstOffGrid = "frame " + std::to_string(i + 1) + " by " + Describe(offGridMs) + " ms";
      }
    }
  }
  test_support::Check(offGrid == 0, "every other timestamp on the grid of the ticks",
                      std::to_string(offGrid) + " off it, the first " + firstOffGrid, __FILE__, __LINE__);
  const double held = HeldPercent(outcomes, 3000);
  test_support::Check(held > 95, "the pacer holds more than 95% of the frames", Describe(held), __FILE__, __LINE__);

  // 5% of the capture times 2 to 6 ms late, and the frames sent that much later, at 90 FPS, 8 streams of 20 s
  Count onGrid;
  for (unsigned seed = 52; seed < 60; seed++) {
    frames = Host(20, [frameMs](int k) { return 1000.37 + k * frameMs; });
    std::mt19937 random(seed);
    for (Frame& frame : frames) {
      if (random() / 4294967296.0 < 0.05) {
        frame.captureMs += 2.0 + random() / 4294967296.0 * 4.0;
        frame.hostTimeMs = HostTimeMs(frame.captureMs);
      }
    }
    Arrive(frames, 90, 2.0, seed + 100);
    outcomes = Run(90, frames);
    const Count runOnGrid = TimestampsOnTheGrid(frames, outcomes, 90, 0);
    onGrid.frames += runOnGrid.frames;
    onGrid.passed += runOnGrid.passed;
  }
  test_support::Check(onGrid.passed >= onGrid.frames * 0.99,
                      "90 FPS, 5% 2 to 6 ms late: 99% of the timestamps on the grid of the ticks", Describe(onGrid),
                      __FILE__, __LINE__);
}

// 24 FPS content (a film) in a 60 FPS stream: Sunshine sends each new image at its present, and when no new image comes
// within two frame durations after one (half the stream rate is its default minimum frame rate), the image again, as a
// duplicate stamped with the end of the send of the frame before. The new images keep their pace, 41.7 ms apart, and
// the pacer holds them (2.2.1 held none). The duplicates arrive more than a frame duration later than their timestamps
// suggest and stay out of the window of the pacer: with them, its median jumped between the two, and the time
// difference with it by 9 ms from window to window.
static void SunshineDuplicatesKeepThePaceOfTheNewImages() {
  std::vector<Frame> frames;
  for (int k = 0; k < 24 * 30; k++) {
    const double presentMs = 1000.37 + k * 1000.0 / 24;
    frames.push_back({(int)frames.size() + 1, presentMs, HostTimeMs(presentMs), 0.0});
    // The duplicate goes out two frame durations after the image was encoded (3 ms), stamped with the end of its send
    Frame duplicate = {(int)frames.size() + 1, presentMs + 3.0 + 2 * kFrame60, HostTimeMs(presentMs + 5.0), 0.0};
    duplicate.duplicate = true;
    frames.push_back(duplicate);
  }
  Arrive(frames, 60, 2.0, 36);
  const std::vector<Outcome> outcomes = Run(60, frames);
  std::vector<Outcome> images;
  for (size_t i = 0; i < outcomes.size(); i += 2) {
    images.push_back(outcomes[i]);
  }
  const double held = HeldPercent(images, 3000);
  test_support::Check(held > 85, "more than 85% of the new images held", Describe(held), __FILE__, __LINE__);
  const Count even = EvenAppends(images, 3000, 1.0);
  test_support::Check(even.passed >= even.frames * 0.97, "97% of the new images appended within 1 ms of their pace",
                      Describe(even), __FILE__, __LINE__);
  double lowest = 1e9;
  double highest = -1e9;
  for (const Outcome& outcome : outcomes) {
    if (outcome.captureMs - outcomes.front().captureMs >= 3000) {
      lowest = std::min(lowest, outcome.ptsDiff);
      highest = std::max(highest, outcome.ptsDiff);
    }
  }
  test_support::Check((highest - lowest) * 1000 < 4, "the time difference of the pacer stays within 4 ms",
                      Describe((highest - lowest) * 1000), __FILE__, __LINE__);
}

// A frame lost on the network, as this client gets it: without reference frame invalidation (the app announces no such
// capability), moonlight-common-c drops every frame after the lost one until a keyframe, which it asks for with the
// first complete frame after the loss. The request reaches the host 11 ms after that frame was sent, so Sunshine sends
// one more frame as usual (dropped too) and then encodes the previous image again as the keyframe: a duplicate sent 3
// ms after that frame, stamped with the end of its send (4 ms after it, stream.cpp), that arrives keyframeMs after it,
// between two frames. The decoder gets the frame before the loss, the duplicate after a gap of 3 frame numbers, and
// the next frame. frames[lost] is the lost frame; captureMs is the moment the host sent a frame. A host other than
// Sunshine (marked false) reports a processing latency for the duplicate as well.
static void LoseFrameUntilKeyframe(std::vector<Frame>& frames, size_t lost, double keyframeMs, bool marked = true) {
  Frame duplicate = frames[lost + 2];
  duplicate.number++;
  duplicate.captureMs += 3.0;
  duplicate.hostTimeMs = HostTimeMs(frames[lost + 2].captureMs + 4.0);
  duplicate.arrival += keyframeMs / 1000.0;
  duplicate.duplicate = marked;
  duplicate.keyframe = true;
  for (size_t i = lost + 3; i < frames.size(); i++) {
    frames[i].number++;
  }
  frames[lost + 2] = duplicate;
  frames.erase(frames.begin() + lost, frames.begin() + lost + 2);
}

// A host that sends its frames at its own pace below the stream rate, so that the timestamps follow its capture times
// (a host display at 50 Hz in a 60 FPS stream, at 100 Hz in a 120 FPS stream, a game at 48 to 60 FPS on a display with
// a variable refresh rate), loses a frame every 2 s, and the keyframe that the client then asks for is a duplicate (see
// LoseFrameUntilKeyframe). The frame after the duplicate moves the timestamp on by the capture times since the frame
// before the loss, and the pacer goes on holding the frames (43e25f0 counted the frames lost before the duplicate twice,
// as lost and as ticks that the host skipped: the timestamp jumped 2 to 4 frame durations too far, the time difference
// of the pacer followed it down as a fall of the latency, and the pacer passed every frame through for about 2 s, 160
// instead of 53 frames per 1000 off their refresh with a game at 48 to 60 FPS). The same holds for a steady host at the
// stream rate at 60 FPS whose duplicate carries no mark (a host other than Sunshine) and arrives early between two
// ticks, 3 ms after it was sent: its capture time adds less than half a frame duration to the lost frames, so it takes
// only the lost frames, without a frame duration of its own (43e25f0 gave it the place of the next frame on the grid,
// and the timestamps ran a frame ahead of the host after every loss). So does one that arrives 12 ms after it was sent,
// less than 0.6 frame durations before the next tick (a large keyframe): it is a keyframe, which a new image would make
// add about a frame duration (a79cb97 gave it that place, and held every later frame a frame duration longer until the
// next window of the pacer: 20 instead of 10 per 1000 frames off their refresh at 60 FPS with 1% lost and unmarked
// duplicates). An unmarked duplicate whose capture time adds half a frame duration or more (most of them at 120 FPS)
// still takes that place.
static void LossBeforeAKeyframeDuplicateKeepsThePace() {
  const std::tuple<int, double, double, bool> cases[] = {
    {60, 50.0, 9.0, true}, {120, 100.0, 4.0, true}, {60, 0.0, 9.0, true}, {60, 60.0, 3.0, false},
    {60, 60.0, 12.0, false}};
  for (const auto& host : cases) {
    const int fps = std::get<0>(host);
    const double hostHz = std::get<1>(host);
    const bool marked = std::get<3>(host);
    const std::string name = std::to_string(fps) + " FPS from " +
      (hostHz > 0 ? "a " + Describe(hostHz) + " Hz display" : "a game at 48 to 60 FPS with a variable refresh rate") +
      (marked ? ": " : ", duplicates unmarked, arriving " + Describe(std::get<2>(host)) + " ms after the send: ");
    std::vector<Frame> frames;
    if (hostHz > 0) {
      frames = Host(24, [hostHz](int k) { return 1000.37 + k * 1000.0 / hostHz; });
    } else {
      std::mt19937 random(41);
      std::vector<double> presents = {1000.37};
      while (presents.back() < 25000) {
        presents.push_back(presents.back() + 1000.0 / 60 + random() / 4294967296.0 * (1000.0 / 48 - 1000.0 / 60));
      }
      frames = Host(24, [presents](int k) { return presents[k]; });
    }
    Arrive(frames, fps, 4.0, 42);
    // A frame lost every 2 s from 4 s on
    std::vector<size_t> duplicateAt;
    for (double atMs = 4000; atMs < 22000; atMs += 2000) {
      size_t lost = 0;
      while (frames[lost].captureMs - frames.front().captureMs < atMs) {
        lost++;
      }
      LoseFrameUntilKeyframe(frames, lost, std::get<2>(host), marked);
      duplicateAt.push_back(lost);
    }
    KeepInOrder(frames, fps);
    const std::vector<Outcome> outcomes = Run(fps, frames);
    int duplicates = 0;
    for (size_t i : duplicateAt) {
      duplicates++;
      const std::string at = name + "duplicate " + std::to_string(duplicates) + ": ";
      test_support::Check((outcomes[i].pts - outcomes[i - 1].pts) * 1000 >= 1 - 1e-6, at + "it takes at least 1 ms",
                          Describe((outcomes[i].pts - outcomes[i - 1].pts) * 1000), __FILE__, __LINE__);
      // The timestamp of the frame after the duplicate, from the frame before the loss, against the capture times
      const double ptsStepMs = (outcomes[i + 1].pts - outcomes[i - 1].pts) * 1000;
      const double hostStepMs = (double)frames[i + 1].hostTimeMs - (double)frames[i - 1].hostTimeMs;
      test_support::Check(std::abs(ptsStepMs - hostStepMs) <= 1.0 + 1e-6,
                          at + "the frame after it moves on by the capture times since the frame before the loss",
                          Describe(ptsStepMs) + " ms for " + Describe(hostStepMs) + " ms", __FILE__, __LINE__);
      // The time difference of the pacer stays where it was (it fell by the frame durations counted too many, as if
      // the latency had fallen), and the pacer holds the frames
      const double afterMs = outcomes[i + 1].captureMs - outcomes.front().captureMs;
      double lowest = 1e9;
      for (size_t j = i + 1; j < outcomes.size() && outcomes[j].captureMs - outcomes[i + 1].captureMs < 2000; j++) {
        lowest = std::min(lowest, outcomes[j].ptsDiff);
      }
      test_support::Check((outcomes[i - 1].ptsDiff - lowest) * 1000 < 1000.0 / fps / 2,
                          at + "the time difference of the pacer falls by less than half a frame duration in the 2 s "
                          "after it",
                          Describe((outcomes[i - 1].ptsDiff - lowest) * 1000) + " ms", __FILE__, __LINE__);
      const double held = HeldPercent(outcomes, afterMs, afterMs + 2000);
      test_support::Check(held > 90, at + "the pacer holds more than 90% of the frames of the 2 s after it",
                          Describe(held), __FILE__, __LINE__);
    }
    CHECK_EQ(duplicates, 9);
  }
}

// A steady host at 60 FPS that skips a tick at 5 and 9 s (a game that missed its frame), with no frame lost: the frame
// after the skip can't tell it from a capture timer that woke up late, so its timestamp moves on by one frame duration,
// and the next frame, which shows the skip too and arrives a frame duration later as well, by two. A skip within a
// second after that, at 9.5 s, is taken at once, as are frames lost on the network (see LostFramesKeepThePacerHolding),
// which show in the frame numbers. The pacer holds the frames after the skips.
static void HostSkippingATickIsFollowedWithTheNextFrame() {
  std::vector<Frame> frames = Host(14, [](int k) {
    return 1000.37 + (k + (k >= 300 ? 1 : 0) + (k >= 540 ? 1 : 0) + (k >= 570 ? 1 : 0)) * kFrame60;
  });
  Arrive(frames, 60, 4.0, 23);
  const std::vector<Outcome> outcomes = Run(60, frames);
  for (const auto& skip : {std::make_pair(300, 1.0), std::make_pair(301, 2.0), std::make_pair(540, 1.0),
                           std::make_pair(541, 2.0), std::make_pair(570, 2.0), std::make_pair(571, 1.0)}) {
    const double stepFrames = (outcomes[skip.first].pts - outcomes[skip.first - 1].pts) * 60;
    test_support::Check(std::abs(stepFrames - skip.second) < 1e-6,
                        "frame " + std::to_string(skip.first) + ": the timestamp moves on by " +
                          Describe(skip.second) + " frame durations",
                        Describe(stepFrames), __FILE__, __LINE__);
  }
  const double held = HeldPercent(outcomes, 5000);
  test_support::Check(held > 95, "more than 95% of the frames after the first skip held", Describe(held), __FILE__,
                      __LINE__);
}

// A game below a 120 FPS stream on a host display with a variable refresh rate (48 to 60 FPS, 16.7 to 20.8 ms apart)
// for 3 s, then V-synced at 60 FPS on the 120 Hz display, e.g. a cut scene: the timestamps follow the capture times
// during the first part, and go back onto the grid of the stream rate for the second, although its capture times step
// by 16 and 17 ms, as whole milliseconds (they followed the rounded capture times for good, up to 1 ms off the grid:
// 60 to 70 per 1000 frames off their refresh on a 120 Hz TV instead of 32)
static void HostFollowedBelowTheStreamRateGoesBackToTheGrid() {
  for (unsigned seed : {41u, 42u, 43u}) {
    std::mt19937 random(seed);
    std::vector<double> captures = {1000.37};
    while (captures.back() < 4000) {
      captures.push_back(captures.back() + 1000.0 / 60 + random() / 4294967296.0 * (1000.0 / 48 - 1000.0 / 60));
    }
    const double vsyncMs = 1000.37 + std::ceil((captures.back() + kFrame60 - 1000.37) / kFrame120) * kFrame120;
    for (int k = 0; vsyncMs + k * kFrame60 < 12000; k++) {
      captures.push_back(vsyncMs + k * kFrame60);
    }
    std::vector<Frame> frames =
      Host(10.5, [&captures](int k) { return captures[std::min<size_t>(k, captures.size() - 1)]; });
    Arrive(frames, 120, 4.0, seed);
    const std::vector<Outcome> outcomes = Run(120, frames);
    Count count;
    for (size_t i = 1; i < outcomes.size(); i++) {
      if (outcomes[i].captureMs - outcomes.front().captureMs >= 5000) {
        count.frames++;
        const double stepFrames = (outcomes[i].pts - outcomes[i - 1].pts) * 120;
        count.passed += std::abs(stepFrames - std::round(stepFrames)) < 1e-3 ? 1 : 0;
      }
    }
    test_support::Check(count.passed >= count.frames * 0.95,
                        "60 FPS after a variable refresh rate in a 120 FPS stream (seed " + std::to_string(seed) +
                          "): 95% of the timestamps whole frame durations after the one before",
                        Describe(count), __FILE__, __LINE__);
    const double held = HeldPercent(outcomes, 5000);
    test_support::Check(held > 90,
                        "60 FPS after a variable refresh rate in a 120 FPS stream (seed " + std::to_string(seed) +
                          "): more than 90% of the frames held",
                        Describe(held), __FILE__, __LINE__);
  }
}

// The frames from fromMs on that a TV at the stream rate shows on another refresh than the one after the frame before
// that their ticks call for (a frame shown on its tick plus the median delay), per 1000 frames, averaged over 24 phases
// of the refresh of the TV
static double OffTheirRefresh(const std::vector<Outcome>& outcomes, const std::vector<double>& ticks, int fps,
                              double fromMs) {
  const double refreshMs = 1000.0 / fps;
  std::vector<double> delays;
  for (size_t i = 0; i < outcomes.size(); i++) {
    if (outcomes[i].append >= 0 && outcomes[i].captureMs - outcomes.front().captureMs >= fromMs) {
      delays.push_back(outcomes[i].append * 1000 - ticks[i]);
    }
  }
  std::nth_element(delays.begin(), delays.begin() + delays.size() / 2, delays.end());
  const double delay = delays[delays.size() / 2];
  double total = 0;
  for (int phase = 0; phase < 24; phase++) {
    const double psi = refreshMs * (phase + 0.5) / 24;
    long long shownBefore = 0;
    long long dueBefore = 0;
    bool have = false;
    int pairs = 0;
    int off = 0;
    for (size_t i = 0; i < outcomes.size(); i++) {
      if (outcomes[i].append < 0 || outcomes[i].captureMs - outcomes.front().captureMs < fromMs) {
        continue;
      }
      const long long shown = (long long)std::ceil((outcomes[i].append * 1000 - psi) / refreshMs);
      const long long due = (long long)std::ceil((ticks[i] + delay - psi) / refreshMs);
      if (have) {
        pairs++;
        off += (shown - shownBefore) != (due - dueBefore) ? 1 : 0;
      }
      shownBefore = shown;
      dueBefore = due;
      have = true;
    }
    total += pairs == 0 ? 0 : 1000.0 * off / pairs;
  }
  return total / 24;
}

// A Windows host at 120 FPS whose display refreshes at 165 or 144 Hz, and whose capture timer wakes up late now and
// then (see WindowsHost): a capture that wakes up late takes the next image of the display, and the next tick then has
// none, so that the host skips it (the model of the earlier probes) or Sunshine starts its frame pacing anew from the
// next image, which moves the ticks. The capture times hardly show either: the late image is one refresh before the
// next one, at most 6 ms. The frames on another refresh of a TV at 120 Hz than their ticks call for, per 1000 frames,
// over 12 streams of 20 s:
//  - 5% of the captures 2 to 6 ms late at 165 Hz, the tick skipped: 24 (a79cb97 35, 9243201 102). After a skipped tick
//    that the capture times didn't show, two frames that ran ahead of the grid and the frame after them, back on the
//    grid of before but a frame duration later, took the timestamps back to the grid of before (see kHostSteadyMs).
//  - 2% of the captures 1 to 6 ms late at 165 and 144 Hz, Sunshine starting anew: 8.5 and 17 (a79cb97 12.5 and 22.5,
//    9243201 86 and 261), and 5% 2 to 6 ms late at 165 Hz: 39 (a79cb97 54). A top of the range that only single frames
//    reach (at 165 Hz, every eighth frame) waited for two frames in a row to confirm it (see above kHostOffsetDecayMs).
static void LateCapturesOfAWindowsHostKeepThePace() {
  const std::tuple<double, double, double, double, bool, double> cases[] = {
    {165, 0.05, 2.0, 6.0, true, 30}, {165, 0.02, 1.0, 6.0, false, 11}, {144, 0.02, 1.0, 6.0, false, 20},
    {165, 0.05, 2.0, 6.0, false, 47}};
  for (const auto& host : cases) {
    const std::string name = "120 FPS from " + Describe(std::get<0>(host)) + " Hz, " +
      Describe(std::get<1>(host) * 100) + "% of the captures " + Describe(std::get<2>(host)) + " to " +
      Describe(std::get<3>(host)) + " ms late, " + (std::get<4>(host) ? "the next tick skipped" : "Sunshine") + ": ";
    double off = 0;
    for (unsigned seed = 61; seed < 73; seed++) {
      std::vector<double> ticks;
      std::vector<Frame> frames = WindowsHost(20, 120, std::get<0>(host), std::get<1>(host), std::get<2>(host),
                                              std::get<3>(host), std::get<4>(host), seed, ticks);
      Arrive(frames, 120, 4.0, seed + 100);
      const std::vector<Outcome> outcomes = Run(120, frames);
      off += OffTheirRefresh(outcomes, ticks, 120, 3000) / 12;
    }
    test_support::Check(off < std::get<5>(host),
                        name + "fewer than " + Describe(std::get<5>(host)) + " per 1000 frames off their refresh",
                        Describe(off), __FILE__, __LINE__);
  }
}

// The changes of the time difference of the pacer within a window. The end of a window starts the next one a second or
// more after it, while following a fall of the arrival time starts the window again earlier.
static int ChangesWithinAWindow(const std::vector<Outcome>& outcomes) {
  int changes = 0;
  for (size_t i = 1; i < outcomes.size(); i++) {
    const bool windowEnded = outcomes[i].windowStart - outcomes[i - 1].windowStart >= 1.0;
    if (outcomes[i].ptsDiff != outcomes[i - 1].ptsDiff && !windowEnded) {
      changes++;
    }
  }
  return changes;
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
    const int changes = ChangesWithinAWindow(Run(fps, frames));
    test_support::Check(changes == 0, std::to_string(fps) + " FPS: no change of the time difference within a window",
                        std::to_string(changes), __FILE__, __LINE__);
  }
}

// Arrival jitter broader than about three frame durations (0 to 30 or 40 ms at 120 FPS, 0 to 60 ms at 60 FPS): a single
// frame that arrives early doesn't take the time difference of the pacer down with it, since it isn't a frame duration
// earlier than every frame of the previous window. The time difference only changes at the end of a window, as without
// the following of a fall, and the pacer holds as many frames as then, about 60 to 65% (it held 10 to 36% and passed
// the others straight through, when every frame more than two frame durations early set the time difference).
static void BroadJitterKeepsThePacerHolding() {
  for (const auto& jitter : {std::make_pair(120, 30.0), std::make_pair(120, 40.0), std::make_pair(60, 60.0)}) {
    const int fps = jitter.first;
    const double frameMs = 1000.0 / fps;
    const std::string name = std::to_string(fps) + " FPS, jitter 0 to " + Describe(jitter.second) + " ms: ";
    std::vector<Frame> frames = Host(30, [frameMs](int k) { return 1000.37 + k * frameMs; });
    Arrive(frames, fps, jitter.second, 16);
    const std::vector<Outcome> outcomes = Run(fps, frames);
    const int changes = ChangesWithinAWindow(outcomes);
    test_support::Check(changes == 0, name + "no change of the time difference within a window",
                        std::to_string(changes), __FILE__, __LINE__);
    const double held = HeldPercent(outcomes, 3000);
    test_support::Check(held > 55, name + "the pacer holds more than 55% of the frames", Describe(held), __FILE__,
                        __LINE__);
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
  test_support::RunTest("a host display off the grid of the stream rate keeps the pace",
                        HostDisplayOffTheStreamGridKeepsThePace);
  test_support::RunTest("the display probe at 120 FPS from 165 Hz keeps the pace of the ticks",
                        DisplayProbeAt165HzKeepsThePaceOfTheTicks);
  test_support::RunTest("after frames lost on the network the pacer holds the frames again at once",
                        LostFramesKeepThePacerHolding);
  test_support::RunTest("a host below the stream rate stays paced", HostBelowTheStreamRateStaysPaced);
  test_support::RunTest("a host display at 59.94 or 60.06 Hz stays paced", HostDisplayAt5994HzStaysPaced);
  test_support::RunTest("a host display slightly faster than the stream rate keeps the grid of the ticks",
                        HostDisplaySlightlyFasterKeepsTheGridOfTheTicks);
  test_support::RunTest("the wrap of the capture time after 13.3 hours keeps the pace", WrapOfTheCaptureTimeKeepsThePace);
  test_support::RunTest("repeated or earlier capture times keep the timestamps rising",
                        RepeatedOrEarlierCaptureTimesKeepTheTimestampsRising);
  test_support::RunTest("a break in the stream moves the timestamps on by one frame, an outage by its length",
                        BreakInTheStreamMovesOnByOneFrame);
  test_support::RunTest("a fall of the latency after a sustained rise is followed at once",
                        FallOfTheLatencyIsFollowedAtOnce);
  test_support::RunTest("the usual jitter doesn't move the pacer within a window", UsualJitterDoesNotMoveThePacerWithinAWindow);
  test_support::RunTest("a broad jitter keeps the pacer holding the frames", BroadJitterKeepsThePacerHolding);
  test_support::RunTest("a short rise and fall of the latency keeps the decode unit queue short",
                        ShortLatencyEpisodeKeepsTheQueueShort);
  test_support::RunTest("a capture timer that wakes up late now and then keeps the pace", LateCaptureTimerKeepsThePace);
  test_support::RunTest("two late capture times in a row keep the timestamps on the grid", LateCaptureTimerPairsKeepTheGrid);
  test_support::RunTest("duplicates of Sunshine keep the pace of the new images", SunshineDuplicatesKeepThePaceOfTheNewImages);
  test_support::RunTest("a loss before a keyframe duplicate keeps the pace of a host below the stream rate",
                        LossBeforeAKeyframeDuplicateKeepsThePace);
  test_support::RunTest("a host that skips a tick is followed with the next frame",
                        HostSkippingATickIsFollowedWithTheNextFrame);
  test_support::RunTest("late captures of a Windows host keep the pace", LateCapturesOfAWindowsHostKeepThePace);
  test_support::RunTest("a host followed below the stream rate goes back to the grid with V-synced content",
                        HostFollowedBelowTheStreamRateGoesBackToTheGrid);
  test_support::RunTest("a full buffer of the player is retried for 16 ms", FullBufferIsRetriedFor16Ms);
  test_support::RunTest("the retry stops when the track closes, and other rejections aren't retried",
                        RetryStopsWhenTheTrackCloses);
  return test_support::Summary();
}
