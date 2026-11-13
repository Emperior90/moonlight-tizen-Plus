// Checks that a stop during the start of a stream interrupts the connection setup of moonlight-common-c
// (wasm/connectionlistener.cpp): CancelPendingSetup(), which StopConnection() and a termination by the host call, sets
// the interrupt flag of LiInterruptConnection(), so that LiStartConnection gives up at its next step instead of setting
// up the whole stream. LiStartConnection clears that flag when it begins (Connection.c), so a stop that came before
// would be lost; ClStageStarting(), which runs for every stage after that, sets it again. It also checks that every line
// that the module logs with ClLogMessage() goes into the ring of the diagnostic log (wasm/diagnostic_log.hpp), from which
// the front end takes it, that the lines of moonlight-common-c go there through the listener that the module gives the
// library (ClLibraryLogMessage(), which Limelog() calls with the line as the argument of "%s", see limelog_test.c),
// unchanged and limited by their kind, and that a failed RTSP handshake whose answer had the key of another start
// (ML_ERROR_RTSP_DECRYPT_FAILED, a local patch of moonlight-common-c) shows no dialog with the ports of the handshake,
// since the front end explains it, and that the end of the stage that connects the control stream, which releases the
// start on the host, tells the front end ("ControlStreamConnected"), unless the stream is already being stopped.
// connectionlistener.cpp is included directly; the functions below stand in for moonlight-common-c and the rest of the
// module.

#include "../../wasm/connectionlistener.cpp"

#include "test_support.h"

#include <cstring>
#include <sstream>
#include <string>
#include <vector>

// The interrupt flag of moonlight-common-c (ConnectionInterrupted in Connection.c)
static bool connectionInterrupted = false;
static std::vector<std::string> posted;

MoonlightInstance* g_Instance = nullptr;

void LiInterruptConnection(void) {
  connectionInterrupted = true;
}
const char* LiGetStageName(int stage) {
  return stage == STAGE_PLATFORM_INIT ? "platform initialization" : "RTSP handshake";
}
unsigned int LiGetPortFlagsFromStage(int) {
  return 0;
}
unsigned int LiGetPortFlagsFromTerminationErrorCode(int) {
  return 0;
}
void LiStringifyPortFlags(unsigned int, const char*, char* outputBuffer, int outputBufferLength) {
  if (outputBufferLength > 0) {
    outputBuffer[0] = '\0';
  }
}
void PostToJs(std::string message) {
  posted.push_back(message);
}
void PostToJsAsync(std::string message) {
  posted.push_back(message);
}
void MoonlightInstance::OnConnectionStarted(uint32_t) {}
void MoonlightInstance::OnConnectionStopped(uint32_t) {}
void MoonlightInstance::ClControllerRumble(unsigned short, unsigned short, unsigned short) {}
void MoonlightInstance::ClSetHdrMode(bool) {}

// The instance of a new stream, as StartStream() leaves it: not cancelled. It is never constructed (the vptr check of
// UBSan is off for this reason, see run.sh); its mutex and condition variables are valid when zeroed, which is their
// static initializer on Linux.
static MoonlightInstance* NewStream() {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  std::memset(storage, 0, sizeof(storage));
  g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  connectionInterrupted = false;
  posted.clear();
  return g_Instance;
}

// What LiStartConnection does when it begins
static void StartConnection() {
  connectionInterrupted = false;
}

static void TestStopDuringTheSetupInterruptsIt() {
  MoonlightInstance* instance = NewStream();
  StartConnection();
  MoonlightInstance::ClStageStarting(STAGE_PLATFORM_INIT);
  CHECK(!connectionInterrupted);
  instance->CancelPendingSetup();
  CHECK(connectionInterrupted);
  // The next stage keeps it interrupted
  MoonlightInstance::ClStageStarting(STAGE_RTSP_HANDSHAKE);
  CHECK(connectionInterrupted);
}

static void TestStopBeforeTheSetupBeganIsNotLost() {
  // The stop comes while the connection thread posts its first messages, before LiStartConnection cleared the flag
  MoonlightInstance* instance = NewStream();
  instance->CancelPendingSetup();
  StartConnection();
  CHECK(!connectionInterrupted);
  MoonlightInstance::ClStageStarting(STAGE_PLATFORM_INIT);
  CHECK(connectionInterrupted);
  CHECK_EQ(posted.back(), std::string("ProgressMsg: Starting platform initialization..."));
}

static void TestNoInterruptWithoutAStop() {
  NewStream();
  StartConnection();
  MoonlightInstance::ClStageStarting(STAGE_PLATFORM_INIT);
  MoonlightInstance::ClStageStarting(STAGE_RTSP_HANDSHAKE);
  CHECK(!connectionInterrupted);
  CHECK_EQ(posted.size(), 2u);
}

static void TestLoggedLinesGoIntoTheDiagnosticLog() {
  GetDiagnosticLog().Take();
  const uint64_t before = DiagnosticLogNowMs();
  MoonlightInstance::ClLogMessage("Starting %s on port %d\n", "RTSP handshake", 48010);
  MoonlightInstance::ClLogMessage("Video stream is %dx%dx%d (format 0x%x)\n", 3840, 2160, 60, 0x100);
  const uint64_t after = DiagnosticLogNowMs();
  // One record "<time>\t<text>\n" per line, with the wall clock of the line and without the line break of the message
  std::vector<std::string> texts;
  std::istringstream records(GetDiagnosticLog().Take());
  std::string record;
  while (std::getline(records, record)) {
    const size_t tab = record.find('\t');
    CHECK(tab != std::string::npos);
    const uint64_t time = std::stoull(record.substr(0, tab));
    CHECK(time >= before && time <= after);
    texts.push_back(record.substr(tab + 1));
  }
  CHECK_EQ(texts.size(), 2u);
  CHECK_EQ(texts[0], std::string("Starting RTSP handshake on port 48010"));
  CHECK_EQ(texts[1], std::string("Video stream is 3840x2160x60 (format 0x100)"));
  const std::string rest = GetDiagnosticLog().Take();
  CHECK_EQ(rest, std::string());
}

// The callbacks that the module hands to LiStartConnection(), which are private: an explicit template instantiation is
// the one place where C++ lets code name a private member (as in stats_overlay_test.cpp)
template <typename Tag, typename Tag::Type Member>
struct PrivateMember {
  friend typename Tag::Type Pointer(Tag) {
    return Member;
  }
};
struct ListenerCallbacksMember {
  using Type = CONNECTION_LISTENER_CALLBACKS*;
  friend Type Pointer(ListenerCallbacksMember);
};
template struct PrivateMember<ListenerCallbacksMember, &MoonlightInstance::s_ClCallbacks>;

// The texts of the lines in the ring, which empties it
static std::vector<std::string> TakeLogTexts() {
  std::vector<std::string> texts;
  std::istringstream records(GetDiagnosticLog().Take());
  std::string record;
  while (std::getline(records, record)) {
    texts.push_back(record.substr(record.find('\t') + 1));
  }
  return texts;
}

static void TestLinesOfTheLibraryGoIntoTheDiagnosticLog() {
  TakeLogTexts();
  // What moonlight-common-c calls for each of its log lines (Limelog() of Platform.h with LC_LOG)
  const ConnListenerLogMessage logMessage = Pointer(ListenerCallbacksMember())->logMessage;
  CHECK(logMessage == &MoonlightInstance::ClLibraryLogMessage);
  logMessage("%s", "Video decode unit queue overflow\n");
  logMessage("%s", "Control message took over 10 ms to send (net latency: 3 ms | packet loss: 0.500000%)\n");
  // A text that looks like a format is kept as it is
  logMessage("%s", "getaddrinfo(100%d-of-%s) failed: -2\n");
  // A line that the library logs in two parts
  logMessage("%s", "Starting video stream...");
  logMessage("%s", "done\n");
  const std::vector<std::string> texts = TakeLogTexts();
  CHECK_EQ(texts.size(), 5u);
  if (texts.size() == 5) {
    CHECK_EQ(texts[0], std::string("Video decode unit queue overflow"));
    CHECK_EQ(texts[1], std::string("Control message took over 10 ms to send (net latency: 3 ms | packet loss: 0.500000%)"));
    CHECK_EQ(texts[2], std::string("getaddrinfo(100%d-of-%s) failed: -2"));
    CHECK_EQ(texts[3], std::string("Starting video stream..."));
    CHECK_EQ(texts[4], std::string("done"));
  }
}

static void TestALineOfTheLibraryPerFrameDoesNotFillTheDiagnosticLog() {
  TakeLogTexts();
  const ConnListenerLogMessage logMessage = Pointer(ListenerCallbacksMember())->logMessage;
  // A network that loses a packet in every frame, for a minute of a 120 FPS stream, with a line of the app in between
  for (int frame = 0; frame < 7200; frame++) {
    char line[96];
    snprintf(line, sizeof(line), "Recovered 1 video data shards from frame %d\n", 100 + frame);
    logMessage("%s", line);
    if (frame == 3600) {
      MoonlightInstance::ClLogMessage("Append audio packet failed: the audio player of the TV rejected %d packets of this stream\n", 1);
    }
  }
  const std::vector<std::string> texts = TakeLogTexts();
  // The first ten of their kind (DiagnosticLogRing::kKindBurst) and the line of the app: nothing was pushed out of the
  // ring of 256 lines, and the lines left out are counted for the next line of the kind
  CHECK_EQ(texts.size(), static_cast<size_t>(DiagnosticLogRing::kKindBurst) + 1);
  if (texts.size() == DiagnosticLogRing::kKindBurst + 1) {
    CHECK_EQ(texts[0], std::string("Recovered 1 video data shards from frame 100"));
    CHECK_EQ(texts[9], std::string("Recovered 1 video data shards from frame 109"));
    CHECK_EQ(texts[10], std::string("Append audio packet failed: the audio player of the TV rejected 1 packets of this stream"));
  }
  // The lines of the app themselves are never limited
  for (int i = 0; i < 50; i++) {
    MoonlightInstance::ClLogMessage("Line %d of the app\n", i);
  }
  // CHECK_EQ() evaluates its arguments twice, so the lines are taken first
  const size_t appLines = TakeLogTexts().size();
  CHECK_EQ(appLines, 50u);
}

static void TestHandshakeWithTheKeyOfAnotherStartShowsNoPortDialog() {
  // Without an instance the ports are those of the stage (none in this stand-in), unmoved
  g_Instance = nullptr;
  posted.clear();
  // The host answered with the key of another start that it still holds: the termination that follows explains it
  // (retryStreamStart() in index.js), the ports of the handshake would mislead
  MoonlightInstance::ClStageFailed(STAGE_RTSP_HANDSHAKE, ML_ERROR_RTSP_DECRYPT_FAILED);
  CHECK_EQ(posted.size(), 0u);
  // Every other error of the handshake keeps its dialog
  MoonlightInstance::ClStageFailed(STAGE_RTSP_HANDSHAKE, -1);
  CHECK_EQ(posted.size(), 1u);
  CHECK_EQ(posted.back(), std::string("DialogMsg: RTSP handshake failed (error -1)"));
  // The code means this in the RTSP handshake only
  MoonlightInstance::ClStageFailed(STAGE_PLATFORM_INIT, ML_ERROR_RTSP_DECRYPT_FAILED);
  CHECK_EQ(posted.size(), 2u);
  CHECK_EQ(posted.back(), std::string("DialogMsg: platform initialization failed (error -300)"));
}

static void TestConnectedControlStreamIsPosted() {
  MoonlightInstance* instance = NewStream();
  // moonlight-common-c calls it for the end of every stage (Connection.c, through s_ClCallbacks, which
  // unit/rtsp-decrypt-error.test.js pins); only the start of the control stream is posted
  for (int stage = STAGE_PLATFORM_INIT; stage < STAGE_MAX; stage++) {
    MoonlightInstance::ClStageComplete(stage);
  }
  CHECK_EQ(posted.size(), 1u);
  CHECK_EQ(posted.back(), std::string("ControlStreamConnected"));
  // A stream that is being stopped already told the front end its end, which the message would only reach after it
  posted.clear();
  instance->CancelPendingSetup();
  MoonlightInstance::ClStageComplete(STAGE_CONTROL_STREAM_START);
  CHECK_EQ(posted.size(), 0u);
}

int main() {
  test_support::RunTest("a stop during the connection setup interrupts it", TestStopDuringTheSetupInterruptsIt);
  test_support::RunTest("a stop before LiStartConnection cleared the interrupt flag is not lost",
                        TestStopBeforeTheSetupBeganIsNotLost);
  test_support::RunTest("without a stop the setup is not interrupted", TestNoInterruptWithoutAStop);
  test_support::RunTest("the lines that the module logs go into the diagnostic log", TestLoggedLinesGoIntoTheDiagnosticLog);
  test_support::RunTest("the lines of moonlight-common-c go into the diagnostic log through the listener, unchanged",
                        TestLinesOfTheLibraryGoIntoTheDiagnosticLog);
  test_support::RunTest("a line of moonlight-common-c that comes once per frame doesn't fill the diagnostic log",
                        TestALineOfTheLibraryPerFrameDoesNotFillTheDiagnosticLog);
  test_support::RunTest("a handshake answered with the key of another start shows no dialog with the ports",
                        TestHandshakeWithTheKeyOfAnotherStartShowsNoPortDialog);
  test_support::RunTest("the connected control stream is posted to the front end, not for a stream being stopped",
                        TestConnectedControlStreamIsPosted);
  return test_support::Summary();
}
