// Checks that the errors which the video player of the TV reports on its own are logged and change nothing else: an
// error of the media pipeline (SourceListener::OnPipelineError(), SDK 1.39.4.7) and an error of the HTML media element
// (MediaElementListener::OnError()), both in wasm/wasmplayer.cpp (included directly) with the lines of
// wasm/player_errors.hpp. The line names the error by its value, says whether a stream was running, and carries a copy
// of the text, which Samsung owns only during the call. Nothing goes to the front end and the stream isn't stopped.
// Also the line for a setup call that the player refuses (FormatPlayerSetupRejectedLog()): the listeners of the media
// source and of the tracks and the media source of the media element, whose results the app ignored until 2.3.1, so
// that a refusal showed only as -200 after the 5 seconds of the media setup. The calls themselves wait for the media
// pipeline of the TV in StartStream() and StartupVidDecSetup(), which no native test runs; tests/unit/diagnostics.test.js
// checks that each one logs this line.
// The functions below stand in for moonlight-common-c and the rest of the module.

#include "../../wasm/wasmplayer.cpp"

#include "test_support.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

AudioStreamStats g_AudioStreamStats;
MoonlightInstance* g_Instance = nullptr;

static std::vector<std::string> logLines;
static std::vector<std::string> posted;
static int stops = 0;

uint64_t LiGetMillis(void) {
  return 0;
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
bool LiGetEstimatedRttInfo(uint32_t*, uint32_t*) {
  return false;
}
bool LiGetCurrentHostDisplayHdrMode(void) {
  return false;
}
void LiGetVideoNetworkStats(PVIDEO_NETWORK_STATS stats) {
  std::memset(stats, 0, sizeof(*stats));
}
void LiTerminateConnectionAsync(int) {}
void PostToJs(std::string message) {
  posted.push_back(message);
}
void PostToJsAsync(std::string message) {
  posted.push_back(message);
}
void MoonlightInstance::ClLogMessage(const char* format, ...) {
  char line[1024];
  va_list args;
  va_start(args, format);
  std::vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  logLines.push_back(line);
}
void MoonlightInstance::CancelPendingSetup() {}
void MoonlightInstance::OnConnectionStopped(uint32_t) {
  stops++;
}

// The listeners and the running flag are private members of MoonlightInstance. An explicit template instantiation is
// the one place where C++ lets code name them, so the templates below hand out what the test needs: the running flag,
// and a call of each listener, built for the instance by the type of its member, which the test never names.
template <typename T>
struct MemberType;
template <typename Class, typename Member>
struct MemberType<Member Class::*> {
  using Type = Member;
};

template <auto Running>
struct RunningAccess {
  friend std::atomic<bool>& RunningOf(MoonlightInstance* instance) {
    return instance->*Running;
  }
};
std::atomic<bool>& RunningOf(MoonlightInstance* instance);
template struct RunningAccess<&MoonlightInstance::m_Running>;

// A listener of the type of a member, built for the instance, called through the interface of the Samsung SDK
template <typename Listener>
static void CallPipelineError(MoonlightInstance* instance, samsung::wasm::MediaPipelineError error, const char* message) {
  Listener listener(instance);
  static_cast<samsung::wasm::ElementaryMediaStreamSourceListener&>(listener).OnPipelineError(error, message);
}
template <typename Listener>
static void CallMediaElementError(MoonlightInstance* instance, samsung::html::MediaError error, const char* message) {
  Listener listener(instance);
  static_cast<samsung::html::HTMLMediaElementListener&>(listener).OnError(error, message);
}

template <auto Listener>
struct SourceListenerAccess {
  friend void ReportPipelineError(MoonlightInstance* instance, samsung::wasm::MediaPipelineError error, const char* message) {
    CallPipelineError<typename MemberType<decltype(Listener)>::Type>(instance, error, message);
  }
};
void ReportPipelineError(MoonlightInstance* instance, samsung::wasm::MediaPipelineError error, const char* message);
template struct SourceListenerAccess<&MoonlightInstance::m_SourceListener>;

template <auto Listener>
struct MediaElementListenerAccess {
  friend void ReportMediaElementError(MoonlightInstance* instance, samsung::html::MediaError error, const char* message) {
    CallMediaElementError<typename MemberType<decltype(Listener)>::Type>(instance, error, message);
  }
};
void ReportMediaElementError(MoonlightInstance* instance, samsung::html::MediaError error, const char* message);
template struct MediaElementListenerAccess<&MoonlightInstance::m_MediaElementListener>;

// An instance that was never constructed (the vptr check of UBSan is off for this reason, see run.sh), with the given
// state of the stream
static MoonlightInstance* Instance(bool running) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  std::memset(storage, 0, sizeof(storage));
  MoonlightInstance* instance = reinterpret_cast<MoonlightInstance*>(storage);
  RunningOf(instance) = running;
  g_Instance = instance;
  logLines.clear();
  posted.clear();
  stops = 0;
  return instance;
}

static void ThePipelineErrorIsLoggedWithACopyOfItsText() {
  MoonlightInstance* instance = Instance(true);
  // The text lives only during the call, like the buffer that the glue code frees right after it
  char text[64];
  std::snprintf(text, sizeof(text), "%s", "Decoder initialization failed");
  ReportPipelineError(instance, samsung::wasm::MediaPipelineError::kGeneralError, text);
  std::memset(text, 'x', sizeof(text) - 1);
  CHECK_EQ(logLines.size(), 1u);
  if (!logLines.empty()) {
    CHECK_EQ(logLines[0], std::string("EMSS::OnPipelineError (error 2: general error) during the stream: Decoder initialization failed\n"));
  }
  // Only logged: nothing for the front end, and the stream goes on
  CHECK(posted.empty());
  CHECK_EQ(stops, 0);
  CHECK(RunningOf(instance).load());
}

static void ThePipelineErrorNamesEveryValue() {
  MoonlightInstance* instance = Instance(false);
  ReportPipelineError(instance, samsung::wasm::MediaPipelineError::kConfigError, "bad config");
  ReportPipelineError(instance, samsung::wasm::MediaPipelineError::kOutOfMemory, nullptr);
  ReportPipelineError(instance, static_cast<samsung::wasm::MediaPipelineError>(9), "");
  const std::vector<std::string> expected = {
    "EMSS::OnPipelineError (error 0: configuration error) without a running stream: bad config\n",
    "EMSS::OnPipelineError (error 3: out of memory) without a running stream: (no text)\n",
    "EMSS::OnPipelineError (error 9: unknown error) without a running stream: (no text)\n",
  };
  CHECK(logLines == expected);
  CHECK(posted.empty());
  CHECK_EQ(stops, 0);
  CHECK_EQ(std::string(MediaPipelineErrorName(1)), std::string("DRM error"));
  CHECK_EQ(std::string(MediaPipelineErrorName(4)), std::string("unknown error"));
  CHECK_EQ(std::string(MediaPipelineErrorName(-1)), std::string("unknown error"));
}

static void TheMediaElementErrorIsLogged() {
  MoonlightInstance* instance = Instance(true);
  std::string text = "PIPELINE_ERROR_DECODE";
  ReportMediaElementError(instance, samsung::html::MediaError::kMediaErrDecode, text.c_str());
  text.assign(text.size(), 'x');
  RunningOf(instance) = false;
  // While the app detaches the player at the end of the stream
  ReportMediaElementError(instance, samsung::html::MediaError::kMediaErrAborted, nullptr);
  const std::vector<std::string> expected = {
    "HTMLMediaElement::OnError (error 3: decode error) during the stream: PIPELINE_ERROR_DECODE\n",
    "HTMLMediaElement::OnError (error 1: aborted) without a running stream: (no text)\n",
  };
  CHECK(logLines == expected);
  CHECK(posted.empty());
  CHECK_EQ(stops, 0);
  CHECK_EQ(std::string(MediaElementErrorName(2)), std::string("network error"));
  CHECK_EQ(std::string(MediaElementErrorName(4)), std::string("source not supported"));
  CHECK_EQ(std::string(MediaElementErrorName(0)), std::string("unknown error"));
  CHECK_EQ(std::string(MediaElementErrorName(5)), std::string("unknown error"));
}

static void ARefusedSetupCallIsLoggedWithItsResult() {
  // The value is that of samsung::wasm::OperationResult, e.g. 7 for a function that the TV doesn't support and 4 for a
  // listener that is already set
  CHECK_EQ(FormatPlayerSetupRejectedLog("the listener of the media source", 7),
    std::string("The video player of the TV rejected the listener of the media source (error 7), so the start may wait in vain and end with -200\n"));
  CHECK_EQ(FormatPlayerSetupRejectedLog("the listener of the video track", 4),
    std::string("The video player of the TV rejected the listener of the video track (error 4), so the start may wait in vain and end with -200\n"));
  // One line each, which the diagnostic log keeps as it is
  const std::string line = FormatPlayerSetupRejectedLog("the media source of the media element", 21);
  CHECK_EQ(line.find('\n'), line.size() - 1);
}

int main() {
  test_support::RunTest("an error of the media pipeline is logged with a copy of its text, and nothing else happens",
    ThePipelineErrorIsLoggedWithACopyOfItsText);
  test_support::RunTest("an error of the media pipeline is named by its value, with or without a stream",
    ThePipelineErrorNamesEveryValue);
  test_support::RunTest("an error of the media element is logged with a copy of its text, during and after a stream",
    TheMediaElementErrorIsLogged);
  test_support::RunTest("a setup call that the player refuses is logged with its result",
    ARefusedSetupCallIsLoggedWithItsResult);
  return test_support::Summary();
}
