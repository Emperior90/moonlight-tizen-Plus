// Checks that a stop during the start of a stream interrupts the connection setup of moonlight-common-c
// (wasm/connectionlistener.cpp): CancelPendingSetup(), which StopConnection() and a termination by the host call, sets
// the interrupt flag of LiInterruptConnection(), so that LiStartConnection gives up at its next step instead of setting
// up the whole stream. LiStartConnection clears that flag when it begins (Connection.c), so a stop that came before
// would be lost; ClStageStarting(), which runs for every stage after that, sets it again. It also checks that every line
// that the module logs with ClLogMessage() goes into the ring of the diagnostic log (wasm/diagnostic_log.hpp), from which
// the front end takes it. connectionlistener.cpp is included directly; the functions below stand in for
// moonlight-common-c and the rest of the module.

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

int main() {
  test_support::RunTest("a stop during the connection setup interrupts it", TestStopDuringTheSetupInterruptsIt);
  test_support::RunTest("a stop before LiStartConnection cleared the interrupt flag is not lost",
                        TestStopBeforeTheSetupBeganIsNotLost);
  test_support::RunTest("without a stop the setup is not interrupted", TestNoInterruptWithoutAStop);
  test_support::RunTest("the lines that the module logs go into the diagnostic log", TestLoggedLinesGoIntoTheDiagnosticLog);
  return test_support::Summary();
}
