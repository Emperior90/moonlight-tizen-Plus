// Checks the setup of the video of a stream in StartupVidDecSetup() of wasm/wasmplayer.cpp (included directly, 2.3.5):
// the profiles that it offers the video player of the TV for each format, in their order (a stream above the luma
// sample rate of level 5.1 offers level 5.2 first, H.264 above level 4.2 offers level 5.1 first), the next profile
// after one that the TV rejects with the line of the log that names it, the message to the front end and -200 when the
// TV rejects them all (none for a start that was cancelled meanwhile), -1 for a format without a profile, and -1 before
// any video track when the TV rejects the audio track of the EMSS backend. The stand-in of the Samsung SDK
// (stubs/samsung/wasm/common.h) records the tracks that the app adds and refuses the MIME types that a test names; the
// waits for the media source and the start of the video return at once, since the test sets their states.
// The functions below stand in for moonlight-common-c and the rest of the module, as in player_errors_test.cpp.

#include "../../wasm/wasmplayer.cpp"

#include "test_support.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

AudioStreamStats g_AudioStreamStats;
MoonlightInstance* g_Instance = nullptr;

static std::vector<std::string> logLines;
static std::vector<std::string> posted;

uint64_t LiGetMillis(void) {
  return 0;
}
uint64_t LiGetMicroseconds(void) {
  return 0;
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
void LiGetIdrFrameRequestStats(uint32_t* sent, uint32_t* held, uint32_t* slowestAnswerMs) {
  *sent = 0;
  *held = 0;
  *slowestAnswerMs = 0;
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
void MoonlightInstance::OnConnectionStopped(uint32_t) {}

// The members that the setup reads and writes are private members of MoonlightInstance. An explicit template
// instantiation is the one place where C++ lets code name them, so each template below hands out one of them.
#define MEMBER_ACCESS(Name, Type, Member)                                       \
  template <auto Pointer>                                                       \
  struct Name##Access {                                                         \
    friend Type& Name(MoonlightInstance* instance) { return instance->*Pointer; } \
  };                                                                            \
  Type& Name(MoonlightInstance* instance);                                      \
  template struct Name##Access<&MoonlightInstance::Member>;

MEMBER_ACCESS(ReadyStateOf, samsung::wasm::ElementaryMediaStreamSource::ReadyState, m_EmssReadyState)
MEMBER_ACCESS(SourceOf, std::unique_ptr<samsung::wasm::ElementaryMediaStreamSource>, m_Source)
MEMBER_ACCESS(AudioBackendOf, AudioBackend, m_AudioBackend)
MEMBER_ACCESS(AudioConfigOf, int, m_AudioConfig)
MEMBER_ACCESS(CancelledOf, std::atomic<bool>, m_ConnectionCancelled)
MEMBER_ACCESS(VideoStartedOf, std::atomic<bool>, m_VideoStarted)

using ReadyState = samsung::wasm::ElementaryMediaStreamSource::ReadyState;
namespace stub = samsung::wasm::stub;

// A fresh instance that was never constructed (the vptr check of UBSan is off for this reason, see run.sh), with a
// media source, the given audio backend and the source closed, so that the first wait of the setup returns at once.
// Opening the source opens it and starts the video, so that the later waits return at once as well.
static MoonlightInstance* Instance(AudioBackend backend) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  MoonlightInstance* instance = reinterpret_cast<MoonlightInstance*>(storage);
  if (g_Instance != nullptr) {
    SourceOf(instance).reset();
  }
  std::memset(storage, 0, sizeof(storage));
  g_Instance = instance;
  SourceOf(instance) = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(
    samsung::wasm::ElementaryMediaStreamSource::LatencyMode::kUltraLow, samsung::wasm::ElementaryMediaStreamSource::RenderingMode::kMediaElement);
  AudioBackendOf(instance) = backend;
  AudioConfigOf(instance) = AUDIO_CONFIGURATION_STEREO;
  ReadyStateOf(instance) = ReadyState::kClosed;
  stub::videoTracks.clear();
  stub::rejectedVideoMimes.clear();
  stub::audioTracks = 0;
  stub::rejectAudioTrack = false;
  stub::onAddVideoTrack = nullptr;
  stub::onSourceOpen = [instance] {
    ReadyStateOf(instance) = ReadyState::kOpen;
    VideoStartedOf(instance) = true;
  };
  logLines.clear();
  posted.clear();
  return instance;
}

// The MIME types of the video tracks that the setup offered, in order
static std::vector<std::string> OfferedMimes() {
  std::vector<std::string> mimes;
  for (const auto& track : stub::videoTracks) {
    mimes.push_back(track.mimeType);
  }
  return mimes;
}

static int Setup(int videoFormat, int width, int height, int fps) {
  return MoonlightInstance::StartupVidDecSetup(videoFormat, width, height, fps, nullptr, 0);
}

// The setup runs once, outside CHECK_EQ, which evaluates its arguments twice
#define CHECK_SETUP(videoFormat, width, height, fps, expected) \
  do {                                                         \
    const int result = Setup(videoFormat, width, height, fps); \
    CHECK_EQ(result, expected);                                \
  } while (0)

static bool Logged(const std::string& line) {
  for (const auto& entry : logLines) {
    if (entry == line) {
      return true;
    }
  }
  return false;
}

static std::string Mime(const char* codecs) {
  return std::string("video/mp4; codecs=\"") + codecs + "\"";
}

static void HevcMain10At4K120OffersLevel52ThenFallsBackToLevel51() {
  Instance(AudioBackend::WebAudio);
  stub::rejectedVideoMimes = {Mime("hev1.2.4.L156.B0")};
  CHECK_SETUP(VIDEO_FORMAT_H265_MAIN10, 3840, 2160, 120, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("hev1.2.4.L156.B0"), Mime("hev1.2.4.L153.B0")}));
  CHECK(Logged("The TV rejected the video track (video/mp4; codecs=\"hev1.2.4.L156.B0\", 3840x2160 at 120 FPS)\n"));
  CHECK(Logged("Video codec profile selected: HEVC Main10 Level Profile 5.1\n"));
  CHECK(Logged("Started\n"));
  CHECK(posted.empty());
  // The track that the TV took has the size and the frame rate of the stream; the Web Audio backend adds no audio track
  if (stub::videoTracks.size() == 2) {
    CHECK_EQ(stub::videoTracks[1].width, 3840u);
    CHECK_EQ(stub::videoTracks[1].height, 2160u);
    CHECK_EQ(stub::videoTracks[1].framerate_num, 120u);
    CHECK_EQ(stub::videoTracks[1].framerate_den, 1u);
  }
  CHECK_EQ(stub::audioTracks, 0);
  // Taken at once: one track
  Instance(AudioBackend::WebAudio);
  CHECK_SETUP(VIDEO_FORMAT_H265_MAIN10, 3840, 2160, 120, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("hev1.2.4.L156.B0")}));
}

static void HevcAt4K60OffersLevel51Only() {
  // 3840 x 2160 x 60 = 497,664,000 luma samples per second, within the 534,773,760 of level 5.1
  Instance(AudioBackend::WebAudio);
  CHECK_SETUP(VIDEO_FORMAT_H265, 3840, 2160, 60, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("hev1.1.6.L153.B0")}));
  // Above it, level 5.2 first
  Instance(AudioBackend::WebAudio);
  stub::rejectedVideoMimes = {Mime("hev1.1.6.L156.B0")};
  CHECK_SETUP(VIDEO_FORMAT_H265, 3840, 2160, 120, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("hev1.1.6.L156.B0"), Mime("hev1.1.6.L153.B0")}));
}

static void H264Above1080p60OffersLevel51First() {
  Instance(AudioBackend::WebAudio);
  stub::rejectedVideoMimes = {Mime("avc1.640033")};
  CHECK_SETUP(VIDEO_FORMAT_H264, 2560, 1440, 60, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("avc1.640033"), Mime("avc1.64002A")}));
  CHECK(Logged("The TV rejected the video track (video/mp4; codecs=\"avc1.640033\", 2560x1440 at 60 FPS)\n"));
  Instance(AudioBackend::WebAudio);
  CHECK_SETUP(VIDEO_FORMAT_H264, 1920, 1080, 60, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("avc1.64002A")}));
}

static void Av1At4K120OffersLevel52ThenLevel51() {
  Instance(AudioBackend::WebAudio);
  stub::rejectedVideoMimes = {Mime("av01.0.14M.08")};
  CHECK_SETUP(VIDEO_FORMAT_AV1_MAIN8, 3840, 2160, 120, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("av01.0.14M.08"), Mime("av01.0.13M.08")}));
  Instance(AudioBackend::WebAudio);
  stub::rejectedVideoMimes = {Mime("av01.0.14M.10")};
  CHECK_SETUP(VIDEO_FORMAT_AV1_MAIN10, 3840, 2160, 120, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("av01.0.14M.10"), Mime("av01.0.13M.10")}));
  Instance(AudioBackend::WebAudio);
  CHECK_SETUP(VIDEO_FORMAT_AV1_MAIN10, 3840, 2160, 60, 0);
  CHECK(OfferedMimes() == std::vector<std::string>({Mime("av01.0.13M.10")}));
}

static void EveryProfileRejectedEndsWith200AndTellsTheFrontEnd() {
  MoonlightInstance* instance = Instance(AudioBackend::WebAudio);
  stub::rejectedVideoMimes = {Mime("hev1.2.4.L156.B0"), Mime("hev1.2.4.L153.B0")};
  CHECK_SETUP(VIDEO_FORMAT_H265_MAIN10, 3840, 2160, 120, ERROR_VIDEO_SETUP_FAILED);
  CHECK_EQ(stub::videoTracks.size(), 2u);
  CHECK(posted == std::vector<std::string>({FormatVideoTrackRejectedMessage(VIDEO_FORMAT_H265_MAIN10, 3840, 2160, 120)}));
  CHECK(!Logged("Inb4 source open\n"));
  // A start that is cancelled while the TV rejects the tracks shows no error
  instance = Instance(AudioBackend::WebAudio);
  stub::rejectedVideoMimes = {Mime("hev1.2.4.L156.B0"), Mime("hev1.2.4.L153.B0")};
  stub::onAddVideoTrack = [instance] { CancelledOf(instance) = true; };
  CHECK_SETUP(VIDEO_FORMAT_H265_MAIN10, 3840, 2160, 120, ERROR_VIDEO_SETUP_FAILED);
  CHECK(posted.empty());
}

static void AFormatWithoutAProfileOffersNoTrack() {
  Instance(AudioBackend::WebAudio);
  CHECK_SETUP(VIDEO_FORMAT_H265_REXT8_444, 1920, 1080, 60, -1);
  CHECK(stub::videoTracks.empty());
  CHECK(Logged("Failed to select video codec profile (videoFormat=0x400)\n"));
  CHECK(posted.empty());
}

static void TheEmssBackendStopsBeforeTheVideoWhenTheAudioTrackIsRejected() {
  Instance(AudioBackend::Emss);
  stub::rejectAudioTrack = true;
  CHECK_SETUP(VIDEO_FORMAT_H265, 1920, 1080, 60, -1);
  CHECK_EQ(stub::audioTracks, 1);
  CHECK(stub::videoTracks.empty());
  CHECK(Logged("The TV rejected the audio track\n"));
  CHECK(posted.empty());
}

int main() {
  test_support::RunTest("HEVC Main10 at 4K120 offers level 5.2, then level 5.1 after the TV rejected it",
    HevcMain10At4K120OffersLevel52ThenFallsBackToLevel51);
  test_support::RunTest("HEVC at 4K60 offers level 5.1 only, above it level 5.2 first", HevcAt4K60OffersLevel51Only);
  test_support::RunTest("H.264 above 1080p60 offers level 5.1 first, up to it level 4.2 only", H264Above1080p60OffersLevel51First);
  test_support::RunTest("AV1 Main8 and Main10 at 4K120 offer level 5.2, then level 5.1", Av1At4K120OffersLevel52ThenLevel51);
  test_support::RunTest("every profile rejected ends with -200 and tells the front end, unless the start was cancelled",
    EveryProfileRejectedEndsWith200AndTellsTheFrontEnd);
  test_support::RunTest("a format without a profile offers no track", AFormatWithoutAProfileOffersNoTrack);
  test_support::RunTest("the EMSS backend stops before the video when the TV rejects the audio track",
    TheEmssBackendStopsBeforeTheVideoWhenTheAudioTrackIsRejected);
  SourceOf(g_Instance).reset();
  return test_support::Summary();
}
