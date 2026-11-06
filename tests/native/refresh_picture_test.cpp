// Checks 'Refresh picture' of the Stream Menu in the module (RefreshPicture() of wasm/wasmplayer.cpp, included directly,
// which requestIdrFrame() of wasm/main.cpp calls for the front end): during a stream it asks moonlight-common-c for a
// keyframe once and marks it as expected, so that the session report doesn't count it as a recovery keyframe; without a
// running stream it asks nothing, since the event and the queue that LiRequestIdrFrame() uses only exist between
// LiStartConnection() and LiStopConnection(). The functions below stand in for moonlight-common-c and the rest of the
// module, like in stats_overlay_test.cpp.

#include "../../wasm/wasmplayer.cpp"

#include "test_support.h"

#include <cstring>
#include <string>

AudioStreamStats g_AudioStreamStats;
MoonlightInstance* g_Instance = nullptr;

// The test sets whether the stream runs, a private member that the module writes itself. An explicit template
// instantiation is the one place where C++ lets code name a private member, so PrivateMember hands out a pointer to it.
template <typename Tag, typename Tag::Type Member>
struct PrivateMember {
  friend typename Tag::Type Pointer(Tag) {
    return Member;
  }
};
struct RunningMember {
  using Type = std::atomic<bool> MoonlightInstance::*;
  friend Type Pointer(RunningMember);
};
template struct PrivateMember<RunningMember, &MoonlightInstance::m_Running>;

static int idrRequests = 0;

uint64_t LiGetMillis(void) {
  return 0;
}
void LiRequestIdrFrame(void) {
  idrRequests++;
}
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
  *estimatedRtt = 0;
  *estimatedRttVariance = 0;
  return true;
}
bool LiGetCurrentHostDisplayHdrMode(void) {
  return false;
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

// An instance whose stream runs or not, as ConnectionThreadFunc() and OnConnectionStopped() leave it. The instance is
// never constructed (the vptr check of UBSan is off for this reason, see run.sh).
static void SetUpInstance(bool running) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  std::memset(storage, 0, sizeof(storage));
  g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  g_Instance->*Pointer(RunningMember()) = running;
  idrRequests = 0;
  s_ExpectedIdrFrame.store(false);
}

static void DuringAStreamItAsksForOneExpectedKeyframe() {
  SetUpInstance(true);
  CHECK(g_Instance->RefreshPicture());
  CHECK_EQ(idrRequests, 1);
  // The keyframe that arrives for it is not counted as a recovery (VidDecSubmitDecodeUnit())
  CHECK(s_ExpectedIdrFrame.load());
  // Every press asks again
  CHECK(g_Instance->RefreshPicture());
  CHECK_EQ(idrRequests, 2);
}

static void WithoutAStreamItAsksNothing() {
  SetUpInstance(false);
  CHECK(!g_Instance->RefreshPicture());
  CHECK_EQ(idrRequests, 0);
  CHECK(!s_ExpectedIdrFrame.load());
}

int main() {
  test_support::RunTest("during a stream it asks for one expected keyframe per press", DuringAStreamItAsksForOneExpectedKeyframe);
  test_support::RunTest("without a running stream it asks nothing", WithoutAStreamItAsksNothing);
  return test_support::Summary();
}
