// Checks the audio decoder of the stream (wasm/auddec.cpp, included directly) with a stand-in for the Opus decoder and
// the audio track of the stubs: the decode buffer of the EMSS backend holds one negotiated frame over all channels (in
// samples, not bytes) and the decoder is offered exactly that frame; a packet that the decoder rejects appends nothing
// and leaves the buffer as it was, since the next packet carries only its own samples; the packets that the audio
// player of the TV rejects and those that 'Limit audio delay' drops are logged for the first one and every 100th
// instead of each one; and the time of the decoder and of the hand-over to the player (AppendPacket() of the EMSS
// backend, the post of the Web Audio backend) reaches the audio statistics of the overlay (wasm/audio_stream_stats.hpp)
// with the samples that were decoded.
//
// The decoder of a stream is destroyed when the stream ends and before another one is created, and a decoder that can't
// be created fails the audio start with a log line instead of decoding without one. Each start logs the layout that
// the host announced, and the 7.1 that a host with a faulty channel rotation announces for its normal quality is
// decoded with the mapping 0 1 2 3 4 5 6 7, while every other layout reaches the decoder as it is (wasm/opus_layout.hpp;
// opus_channel_layout_test.c derives the layouts from the tables of Sunshine, and opus_decoder/app_decoder_test.cpp
// decodes them with the real library).
//
// The load of the audio thread is judged from the totals of the statistics after every packet (wasm/audio_load.hpp,
// whose rule audio_load_test.cpp checks): a stream that needs more than 300 ms of decoding and hand-over per second of
// audio over 10 seconds logs its figures and tells the front end once, with both backends and whatever the level of the
// performance stats, a stream below the limit tells nothing, and every stream that decoded audio logs its figures when
// it ends and leaves them for the report of the session.
//
// auddec.cpp has an EM_ASM block without arguments, whose stub takes the GNU form of __VA_ARGS__ (run.sh):
// Build with: -std=gnu++17

#include "../../wasm/auddec.cpp"

#include "test_support.h"

#include <cmath>
#include <cstdarg>
#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>

MoonlightInstance* g_Instance = nullptr;

// The test sets members of the instance that StartStream() and the media listeners write (see stats_overlay_test.cpp)
template <typename Tag, typename Tag::Type Member>
struct PrivateMember {
  friend typename Tag::Type Pointer(Tag) {
    return Member;
  }
};
struct AudioBackendMember {
  using Type = AudioBackend MoonlightInstance::*;
  friend Type Pointer(AudioBackendMember);
};
struct AudioSyncMember {
  using Type = bool MoonlightInstance::*;
  friend Type Pointer(AudioSyncMember);
};
struct AudioStartedMember {
  using Type = std::atomic<bool> MoonlightInstance::*;
  friend Type Pointer(AudioStartedMember);
};
struct OpusDecoderMember {
  using Type = OpusMSDecoder* MoonlightInstance::*;
  friend Type Pointer(OpusDecoderMember);
};
template struct PrivateMember<AudioBackendMember, &MoonlightInstance::m_AudioBackend>;
template struct PrivateMember<AudioSyncMember, &MoonlightInstance::m_AudioSyncEnabled>;
template struct PrivateMember<AudioStartedMember, &MoonlightInstance::m_AudioStarted>;
template struct PrivateMember<OpusDecoderMember, &MoonlightInstance::m_OpusDecoder>;

static std::vector<std::string> logs;

// The messages that the audio thread posted to the front end without waiting for it
static std::vector<std::string> posted;
void PostToJsAsync(std::string message) {
  posted.push_back(message);
}

void MoonlightInstance::ClLogMessage(const char* format, ...) {
  char text[512];
  va_list args;
  va_start(args, format);
  vsnprintf(text, sizeof(text), format, args);
  va_end(args);
  logs.push_back(text);
}
uint64_t LiGetMillis(void) {
  return 1000;
}

// Wait on the clock without sleeping, so that a call takes at least the given time
static void BusyWait(int us) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::microseconds(us);
  while (std::chrono::steady_clock::now() < end) {
  }
}

// The stand-in for the Opus decoder: each call writes frame_size samples per channel (the channel count of the stream
// that the test set up) with a value of the call, after the given time, or fails with the given error
static int fakeDecoder;
static int decodeChannels = 0;
static int decodeCalls = 0;
static int decodeFrameSize = 0;
static int decodeResult = 0;  // 0: decode a frame, otherwise the error code to return
static int decodeTimeUs = 0;

// The decoders that the app created and destroyed, the layout of the last one, and the error that the next creation
// fails with (0: it succeeds)
static int createCalls = 0;
static int destroyCalls = 0;
static int liveDecoders = 0;
static int mostLiveDecoders = 0;
static int createError = 0;
static int createdStreams = 0;
static int createdCoupledStreams = 0;
static unsigned char createdMapping[AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT];

extern "C" OpusMSDecoder* opus_multistream_decoder_create(opus_int32, int channels, int streams, int coupledStreams,
                                                          const unsigned char* mapping, int* error) {
  createCalls++;
  if (createError != 0) {
    *error = createError;
    return nullptr;
  }
  decodeChannels = channels;
  createdStreams = streams;
  createdCoupledStreams = coupledStreams;
  std::memset(createdMapping, 0xEE, sizeof(createdMapping));
  std::memcpy(createdMapping, mapping, (size_t)channels);
  liveDecoders++;
  mostLiveDecoders = std::max(mostLiveDecoders, liveDecoders);
  *error = OPUS_OK;
  return reinterpret_cast<OpusMSDecoder*>(&fakeDecoder);
}

extern "C" void opus_multistream_decoder_destroy(OpusMSDecoder* decoder) {
  CHECK(decoder == reinterpret_cast<OpusMSDecoder*>(&fakeDecoder));
  destroyCalls++;
  liveDecoders--;
}

extern "C" const char* opus_strerror(int error) {
  return error == OPUS_BAD_ARG ? "invalid argument" : error == OPUS_ALLOC_FAIL ? "memory allocation failed" : "other";
}

extern "C" int opus_multistream_decode(OpusMSDecoder* decoder, const unsigned char*, opus_int32, opus_int16* pcm,
                                       int frame_size, int) {
  // Never without a decoder, and never with one that was destroyed
  CHECK(decoder == reinterpret_cast<OpusMSDecoder*>(&fakeDecoder) && liveDecoders == 1);
  decodeCalls++;
  decodeFrameSize = frame_size;
  BusyWait(decodeTimeUs);
  if (decodeResult != 0) {
    return decodeResult;
  }
  for (int i = 0; i < frame_size * decodeChannels; i++) {
    pcm[i] = (opus_int16)(decodeCalls * 10 + i % 7);
  }
  return frame_size;
}

// The packets that the EMSS backend appended: their timestamp, size and first sample, and the result of each append
struct Appended {
  double pts;
  size_t size;
  int firstSample;
};
static std::vector<Appended> appended;
static int appendResult = 0;  // 0: kSuccess, 1: kFailed
static int appendTimeUs = 0;

// The layout of a stream as moonlight-common-c hands it to the audio renderer
static OPUS_MULTISTREAM_CONFIGURATION Layout(int channels, int streams, int coupledStreams,
                                             std::initializer_list<unsigned char> mapping, int samplesPerFrame = 240) {
  OPUS_MULTISTREAM_CONFIGURATION config = {};
  config.sampleRate = 48000;
  config.channelCount = channels;
  config.streams = streams;
  config.coupledStreams = coupledStreams;
  config.samplesPerFrame = samplesPerFrame;
  std::copy(mapping.begin(), mapping.end(), config.mapping);
  return config;
}

// Start the audio of a stream with the given backend and layout, as StartStream() and the connection set it up, with
// the audio track open, and return what AudDecInit() answered. The instance stays the same from stream to stream, as in
// the app, so a decoder that a stream left behind is still there for the next start.
static int InitAudio(AudioBackend backend, OPUS_MULTISTREAM_CONFIGURATION config, bool audioSync) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  if (g_Instance == nullptr) {
    std::memset(storage, 0, sizeof(storage));
    g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  }
  g_Instance->*Pointer(AudioBackendMember()) = backend;
  g_Instance->*Pointer(AudioSyncMember()) = audioSync;
  (g_Instance->*Pointer(AudioStartedMember())) = false;
  logs.clear();
  posted.clear();
  appended.clear();
  decodeCalls = 0;
  decodeResult = 0;
  decodeTimeUs = 0;
  appendResult = 0;
  appendTimeUs = 0;
  samsung::wasm::TestAppendPacketHook() = [](const samsung::wasm::ElementaryMediaPacket& packet) {
    BusyWait(appendTimeUs);
    appended.push_back({packet.pts.count(), packet.data_size, ((const opus_int16*)packet.data)[0]});
    return appendResult;
  };
  const OPUS_MULTISTREAM_CONFIGURATION announced = config;
  const int result = MoonlightInstance::AudDecInit(0, &config, nullptr, 0);
  // The layout of moonlight-common-c is only read
  CHECK(std::memcmp(&config, &announced, sizeof(config)) == 0);
  (g_Instance->*Pointer(AudioStartedMember())) = true;
  return result;
}

// A stream with the given backend and format that starts
static void StartAudio(AudioBackend backend, int channels, int samplesPerFrame, bool audioSync) {
  const OPUS_MULTISTREAM_CONFIGURATION config =
    channels == 2 ? Layout(2, 1, 1, {0, 1}, samplesPerFrame) : channels == 6
      ? Layout(6, 4, 2, {0, 1, 2, 3, 4, 5}, samplesPerFrame) : Layout(8, 5, 3, {0, 1, 2, 3, 4, 5, 6, 7}, samplesPerFrame);
  // (CHECK_EQ() evaluates its arguments twice, so the start is not one of them)
  const int result = InitAudio(backend, config, audioSync);
  CHECK_EQ(result, 0);
  CHECK((g_Instance->*Pointer(OpusDecoderMember()) != nullptr) == (backend != AudioBackend::Disabled));
}

static void Feed(int count) {
  static char packet[100] = {1};
  for (int i = 0; i < count; i++) {
    MoonlightInstance::AudDecDecodeAndPlaySample(packet, sizeof(packet));
  }
}

static int CountLogs(const char* text) {
  int count = 0;
  for (const std::string& line : logs) {
    count += line.find(text) != std::string::npos ? 1 : 0;
  }
  return count;
}

static void DecodeBufferHoldsOneFrameInSamples() {
  StartAudio(AudioBackend::Emss, 6, 240, false);
  // 240 samples per channel over 6 channels, not the 2880 of a size in bytes
  CHECK_EQ(s_DecodeBuffer.size(), (size_t)1440);
  Feed(3);
  CHECK_EQ(decodeFrameSize, 240);
  CHECK_EQ(appended.size(), (size_t)3);
  for (size_t i = 0; i < appended.size(); i++) {
    // 2880 bytes of 16-bit samples, every 5 ms
    CHECK_EQ(appended[i].size, (size_t)2880);
    CHECK_EQ((int)std::lround(appended[i].pts * 1000), (int)i * 5);
    CHECK_EQ(appended[i].firstSample, (int)(i + 1) * 10);
  }
  // 10 ms packets of 7.1
  StartAudio(AudioBackend::Emss, 8, 480, false);
  CHECK_EQ(s_DecodeBuffer.size(), (size_t)3840);
  Feed(1);
  CHECK_EQ(decodeFrameSize, 480);
  CHECK_EQ(appended.size(), (size_t)1);
  CHECK_EQ(appended[0].size, (size_t)7680);
  MoonlightInstance::AudDecCleanup();
  CHECK_EQ(s_DecodeBuffer.size(), (size_t)0);
}

static void RejectedPacketAppendsNothingAndKeepsTheBuffer() {
  StartAudio(AudioBackend::Emss, 2, 240, false);
  Feed(1);
  const std::vector<opus_int16> before = s_DecodeBuffer;
  decodeResult = OPUS_INVALID_PACKET;
  Feed(1);
  CHECK_EQ(g_AudioStreamStats.decodeErrors.load(), 1u);
  CHECK_EQ(appended.size(), (size_t)1);
  // The buffer isn't cleared for nothing: the next packet overwrites what it appends
  CHECK(s_DecodeBuffer == before);
  decodeResult = 0;
  Feed(1);
  CHECK_EQ(appended.size(), (size_t)2);
  CHECK_EQ(appended[1].firstSample, 30);
  CHECK_EQ(appended[1].size, (size_t)960);
  // The timestamps stay without a gap: the rejected packet took none
  CHECK_EQ((int)std::lround(appended[1].pts * 1000), 5);
}

static void PlayerRejectionsAreLoggedInBatches() {
  StartAudio(AudioBackend::Emss, 6, 240, false);
  appendResult = 1;
  Feed(250);
  CHECK_EQ(g_AudioStreamStats.playerRejections.load(), 250u);
  CHECK_EQ(appended.size(), (size_t)250);
  // The first, the 101st and the 201st, with the count of the stream
  CHECK_EQ(CountLogs("Append audio packet failed"), 3);
  CHECK_EQ(CountLogs("rejected 201 packets of this stream"), 1);
  // A rejected packet doesn't move the timestamp, so the next one takes its place
  CHECK_EQ(appended.back().pts, 0.0);
  // A new stream counts from the first one again
  StartAudio(AudioBackend::Emss, 6, 240, false);
  appendResult = 1;
  Feed(1);
  CHECK_EQ(CountLogs("rejected 1 packets of this stream"), 1);
}

static void DroppedPacketsAreLoggedInBatches() {
  // 'Limit audio delay' drops the packets once more than 100 ms of audio wait in the player. The test feeds them much
  // faster than in real time, so after about 21 packets of 5 ms every further one is dropped.
  StartAudio(AudioBackend::Emss, 2, 240, true);
  Feed(400);
  const int dropped = 400 - (int)appended.size();
  CHECK(dropped >= 300);
  CHECK_EQ(CountLogs("Dropping audio packets to avoid overflow"), (dropped + 99) / 100);
  CHECK_EQ(decodeCalls, (int)appended.size());
}

static void DecodeAndOutputTimesReachTheStatistics() {
  StartAudio(AudioBackend::Emss, 6, 240, false);
  Feed(10);
  decodeTimeUs = 400;
  appendTimeUs = 250;
  Feed(1);
  decodeTimeUs = 0;
  appendTimeUs = 0;
  CHECK_EQ(g_AudioStreamStats.decodedSamples.load(), 11u * 240u);
  CHECK(g_AudioStreamStats.decodeMaxUs.load() >= 400u);
  CHECK(g_AudioStreamStats.decodeUs.load() >= 400u);
  CHECK(g_AudioStreamStats.outputMaxUs.load() >= 250u);
  CHECK(g_AudioStreamStats.outputUs.load() >= 250u);
  // The overlay shows them as time per second of audio: 11 packets of 5 ms are 55 ms of audio, so 400 us are at least
  // 7.27 ms per second
  AudioRateWindow window;
  char text[512];
  CHECK(FormatAudioStreamStats(g_AudioStreamStats, window, 2000, text, sizeof(text)) > 0);
  CHECK(std::string(text).find("Audio CPU: decode ") != std::string::npos);
  double decodeMsPerSecond = 0;
  CHECK_EQ(sscanf(std::strstr(text, "Audio CPU: decode "), "Audio CPU: decode %lf ms/s", &decodeMsPerSecond), 1);
  CHECK(decodeMsPerSecond >= 7.27);
  // A packet that the decoder rejects costs time but decodes no audio
  decodeResult = OPUS_INVALID_PACKET;
  decodeTimeUs = 300;
  Feed(1);
  CHECK_EQ(g_AudioStreamStats.decodedSamples.load(), 11u * 240u);
  CHECK(g_AudioStreamStats.decodeMaxUs.load() >= 300u);
}

static void WebAudioCountsTheDecodeAndThePost() {
  StartAudio(AudioBackend::WebAudio, 2, 240, false);
  decodeTimeUs = 200;
  Feed(4);
  // A lost packet is concealed with one negotiated frame
  MoonlightInstance::AudDecDecodeAndPlaySample(nullptr, 0);
  CHECK_EQ(decodeFrameSize, 240);
  CHECK_EQ(g_AudioStreamStats.decodedSamples.load(), 4u * 480u + 240u);
  CHECK(g_AudioStreamStats.decodeUs.load() >= 5u * 200u);
  CHECK(g_AudioStreamStats.decodeMaxUs.load() >= 200u);
  // Nothing goes to the track of the EMSS backend
  CHECK(appended.empty());
  MoonlightInstance::AudDecCleanup();
}

static void DisabledAudioDecodesNothing() {
  StartAudio(AudioBackend::Disabled, 6, 240, false);
  Feed(5);
  CHECK_EQ(decodeCalls, 0);
  CHECK_EQ(g_AudioStreamStats.channelCount.load(), 0);
  AudioRateWindow window;
  char text[64];
  CHECK_EQ(FormatAudioStreamStats(g_AudioStreamStats, window, 2000, text, sizeof(text)), 0);
}

// The line of the logs that holds the given text, or an empty one
static std::string FindLog(const char* text) {
  for (const std::string& line : logs) {
    if (line.find(text) != std::string::npos) {
      return line;
    }
  }
  return "";
}

static void OverloadedAudioThreadTellsTheFrontEndOncePerStream() {
  for (AudioBackend backend : {AudioBackend::Emss, AudioBackend::WebAudio}) {
    // 7.1 in 5 ms packets: 2000 packets are the 10 seconds of a window. The stand-in of the decoder fills the frame that
    // it is offered, which is a whole slot of 10 ms with the Web Audio backend, so 1000 packets are a window there.
    StartAudio(backend, 8, 240, false);
    const int window = backend == AudioBackend::WebAudio ? 1000 : 2000;
    Feed(window / 2);
    // The work that a slow TV would have had so far: 3.2 s of decoding and 1 s of hand-over within 10 s of audio,
    // counted where the audio thread counts them, so that the test doesn't have to wait for it
    g_AudioStreamStats.CountDecode(3200000, 0);
    g_AudioStreamStats.CountOutput(1000000);
    Feed(window / 2 - 1);
    CHECK(posted.empty());
    CHECK_EQ(CountLogs("Audio overload:"), 0);
    // The packet that completes the window
    Feed(1);
    CHECK_EQ(posted.size(), (size_t)1);
    int channels = 0;
    int load = 0;
    CHECK_EQ(sscanf(posted.empty() ? "" : posted[0].c_str(), "AudioOverloadMsg: %d,%d", &channels, &load), 2);
    CHECK_EQ(channels, 8);
    // 420 ms per second, and the little that the stand-ins of the decoder and the player took in this test
    CHECK(load >= 420 && load < 500);
    CHECK_EQ(CountLogs("Audio overload: decoding and handing over the sound of 8 channels took "), 1);
    CHECK(FindLog("Audio overload:").find(" ms per second of audio over the last 10 s (decode 32") != std::string::npos);
    CHECK(FindLog("Audio overload:").find("above the limit of 300 ms/s\n") != std::string::npos);
    // The stream stays overloaded: no second message and no second line
    g_AudioStreamStats.CountDecode(9000000, 0);
    Feed(2 * window);
    CHECK_EQ(posted.size(), (size_t)1);
    CHECK_EQ(CountLogs("Audio overload:"), 1);
    // Its end logs the figures of the stream and leaves its load for the report of the session
    MoonlightInstance::AudDecCleanup();
    CHECK_EQ(CountLogs("Audio thread work of this stream: decode "), 1);
    CHECK(FindLog("Audio thread work of this stream:").find(" of 3 windows above 300 ms/s; longest hand-over 1000.") !=
          std::string::npos);
    CHECK_EQ(g_AudioStreamStats.loadChannels.load(), 8u);
    CHECK(g_AudioStreamStats.loadMsPerSecond.load() >= 440u);
    CHECK(g_AudioStreamStats.loadPeakMsPerSecond.load() >= 450u);
    CHECK_EQ(g_AudioStreamStats.overloadedWindows.load(), 2u);
    // A second cleanup neither logs the figures again nor changes them
    MoonlightInstance::AudDecCleanup();
    CHECK_EQ(CountLogs("Audio thread work of this stream:"), 1);
    CHECK_EQ(g_AudioStreamStats.overloadedWindows.load(), 2u);
    // The next stream is judged from its own first packet, and tells again when it is overloaded as well
    StartAudio(backend, 6, 480, false);
    CHECK_EQ(g_AudioStreamStats.loadChannels.load(), 0u);
    CHECK_EQ(g_AudioStreamStats.overloadedWindows.load(), 0u);
    g_AudioStreamStats.CountOutput(3100000);
    Feed(999);
    CHECK(posted.empty());
    Feed(1);
    CHECK_EQ(posted.size(), (size_t)1);
    CHECK(!posted.empty() && posted[0].find("AudioOverloadMsg: 6,31") == 0);
    MoonlightInstance::AudDecCleanup();
  }
}

static void AudioThreadBelowTheLimitTellsNothing() {
  // 5.1 in 10 ms packets with the work of the streams that played fine, 1.7 s within each 10 s of audio, and a single
  // hand-over of 22 ms in each window
  StartAudio(AudioBackend::Emss, 6, 480, false);
  for (int window = 0; window < 3; window++) {
    g_AudioStreamStats.CountDecode(1040000, 0);
    g_AudioStreamStats.CountOutput(638000);
    Feed(500);
    g_AudioStreamStats.CountOutput(22000);
    Feed(500);
  }
  CHECK(posted.empty());
  CHECK_EQ(CountLogs("Audio overload:"), 0);
  MoonlightInstance::AudDecCleanup();
  CHECK_EQ(CountLogs("Audio thread work of this stream: decode 10"), 1);
  CHECK(FindLog("Audio thread work of this stream:").find(" 0 of 3 windows above 300 ms/s; ") != std::string::npos);
  CHECK_EQ(g_AudioStreamStats.loadChannels.load(), 6u);
  CHECK(g_AudioStreamStats.loadMsPerSecond.load() >= 170u && g_AudioStreamStats.loadMsPerSecond.load() < 200u);
  CHECK(g_AudioStreamStats.loadPeakMsPerSecond.load() >= 170u && g_AudioStreamStats.loadPeakMsPerSecond.load() < 200u);
  CHECK_EQ(g_AudioStreamStats.overloadedWindows.load(), 0u);

  // A stream that ends before it decoded anything, and one without an audio output, log and leave nothing
  StartAudio(AudioBackend::Emss, 6, 480, false);
  MoonlightInstance::AudDecCleanup();
  CHECK_EQ(CountLogs("Audio thread work of this stream:"), 0);
  CHECK_EQ(g_AudioStreamStats.loadChannels.load(), 0u);
  StartAudio(AudioBackend::Disabled, 6, 480, false);
  Feed(3000);
  MoonlightInstance::AudDecCleanup();
  CHECK(posted.empty());
  CHECK_EQ(CountLogs("Audio thread work of this stream:"), 0);
  CHECK_EQ(CountLogs("Audio overload:"), 0);
}

static void DecoderIsDestroyedWithTheStreamAndBeforeANewOne() {
  // Whatever the tests before left behind
  MoonlightInstance::AudDecCleanup();
  CHECK_EQ(liveDecoders, 0);
  createCalls = destroyCalls = mostLiveDecoders = 0;

  // A stream that ends takes its decoder with it, with both backends
  for (AudioBackend backend : {AudioBackend::Emss, AudioBackend::WebAudio}) {
    StartAudio(backend, 6, 240, false);
    Feed(3);
    CHECK_EQ(liveDecoders, 1);
    MoonlightInstance::AudDecCleanup();
    CHECK_EQ(liveDecoders, 0);
    CHECK(g_Instance->*Pointer(OpusDecoderMember()) == nullptr);
    CHECK_EQ(s_DecodeBuffer.size(), (size_t)0);
    // A packet that arrives now is not decoded, and a second cleanup destroys nothing twice
    const int callsBefore = decodeCalls;
    Feed(2);
    MoonlightInstance::AudDecDecodeAndPlaySample(nullptr, 0);
    CHECK_EQ(decodeCalls, callsBefore);
    MoonlightInstance::AudDecCleanup();
    CHECK_EQ(liveDecoders, 0);
  }
  CHECK_EQ(createCalls, 2);
  CHECK_EQ(destroyCalls, 2);

  // 100 streams in a row, as with the Stream Menu reconnect, leave nothing behind
  for (int i = 0; i < 100; i++) {
    StartAudio(i % 2 == 0 ? AudioBackend::Emss : AudioBackend::WebAudio, i % 3 == 0 ? 8 : 6, 240, false);
    MoonlightInstance::AudDecCleanup();
  }
  CHECK_EQ(createCalls, 102);
  CHECK_EQ(destroyCalls, 102);

  // A start that finds a decoder destroys it before it creates its own, so there is never more than one
  StartAudio(AudioBackend::Emss, 6, 240, false);
  StartAudio(AudioBackend::Emss, 8, 480, false);
  CHECK_EQ(liveDecoders, 1);
  CHECK_EQ(mostLiveDecoders, 1);
  CHECK_EQ(destroyCalls, 103);
  Feed(1);
  CHECK_EQ(appended.size(), (size_t)1);
  // Also a start with the audio output disabled, which creates none
  StartAudio(AudioBackend::Disabled, 6, 240, false);
  CHECK_EQ(liveDecoders, 0);
  CHECK_EQ(createCalls, 104);
  CHECK_EQ(destroyCalls, 104);
  MoonlightInstance::AudDecCleanup();
  CHECK_EQ(destroyCalls, 104);
}

static void DecoderThatCannotBeCreatedFailsTheAudioStart() {
  MoonlightInstance::AudDecCleanup();
  for (AudioBackend backend : {AudioBackend::Emss, AudioBackend::WebAudio}) {
    // Opus refuses the layout (a host with surround parameters that make no sense)
    createError = OPUS_BAD_ARG;
    int result = InitAudio(backend, Layout(8, 1, 9, {0, 1, 2, 3, 4, 5, 6, 7}), false);
    CHECK_EQ(result, OPUS_BAD_ARG);
    CHECK(g_Instance->*Pointer(OpusDecoderMember()) == nullptr);
    CHECK_EQ(liveDecoders, 0);
    CHECK_EQ(CountLogs("Creating the Opus decoder failed with error -1 (invalid argument), so the audio stream can't start"), 1);
    // The decode buffer of the start is not kept: moonlight-common-c calls no cleanup for a start that failed
    CHECK_EQ(s_DecodeBuffer.size(), (size_t)0);
    // No packet is decoded without a decoder (the stand-in checks that it is never called with none)
    Feed(3);
    MoonlightInstance::AudDecDecodeAndPlaySample(nullptr, 0);
    CHECK_EQ(decodeCalls, 0);
    CHECK(appended.empty());
    // No memory for the decoder
    createError = OPUS_ALLOC_FAIL;
    result = InitAudio(backend, Layout(6, 4, 2, {0, 1, 2, 3, 4, 5}), false);
    CHECK_EQ(result, OPUS_ALLOC_FAIL);
    CHECK_EQ(CountLogs("failed with error -7 (memory allocation failed)"), 1);
    CHECK(g_Instance->*Pointer(OpusDecoderMember()) == nullptr);
    // The next start works
    createError = 0;
    StartAudio(backend, 6, 240, false);
    Feed(2);
    CHECK_EQ(decodeCalls, 2);
    CHECK_EQ(CountLogs("Creating the Opus decoder failed"), 0);
    MoonlightInstance::AudDecCleanup();
  }
  // A frame that doesn't fit the slots of the Web Audio backend fails the start too, and leaves no decoder behind
  const int tooLarge = InitAudio(AudioBackend::WebAudio, Layout(6, 4, 2, {0, 1, 2, 3, 4, 5}, 960), false);
  CHECK_EQ(tooLarge, -1);
  CHECK_EQ(CountLogs("are too large for the Web Audio backend"), 1);
  CHECK(g_Instance->*Pointer(OpusDecoderMember()) == nullptr);
  CHECK_EQ(liveDecoders, 0);
}

// Whether the decoder of the last start got the layout with this mapping
static bool CreatedWith(const OPUS_MULTISTREAM_CONFIGURATION& config, const std::vector<unsigned char>& mapping) {
  return decodeChannels == config.channelCount && createdStreams == config.streams &&
         createdCoupledStreams == config.coupledStreams &&
         std::equal(mapping.begin(), mapping.end(), createdMapping) && (int)mapping.size() == config.channelCount;
}

static void LayoutIsLoggedAndOnlyTheMisrotated71IsCorrected() {
  MoonlightInstance::AudDecCleanup();
  // 7.1 in normal quality from a host that rotates only the entries 3 to 5 (surround-params=85301245367, which
  // moonlight-common-c turns into this mapping): decoded as the host encodes it
  const OPUS_MULTISTREAM_CONFIGURATION misrotated = Layout(8, 5, 3, {0, 1, 2, 7, 4, 5, 3, 6}, 480);
  for (AudioBackend backend : {AudioBackend::Emss, AudioBackend::WebAudio}) {
    const int result = InitAudio(backend, misrotated, false);
    CHECK_EQ(result, 0);
    CHECK(CreatedWith(misrotated, {0, 1, 2, 3, 4, 5, 6, 7}));
    CHECK_EQ(CountLogs("Opus layout of the stream: channels 8, streams 5, coupled streams 3, mapping 0 1 2 7 4 5 3 6\n"), 1);
    CHECK_EQ(CountLogs("Opus layout of the stream"), 1);
    CHECK_EQ(CountLogs("mix up LFE, side left and side right: decoding with the mapping 0 1 2 3 4 5 6 7 instead\n"), 1);
    MoonlightInstance::AudDecCleanup();
  }

  // Every other layout reaches the decoder as it is: those of Sunshine (stereo, 5.1 and 7.1 in normal and in high
  // quality), a 5.1 and a 7.1 paired like GeForce Experience, and layouts that differ from the faulty one in one value
  struct Case {
    OPUS_MULTISTREAM_CONFIGURATION config;
    std::vector<unsigned char> mapping;
    const char* log;
  };
  const Case cases[] = {
    {Layout(2, 1, 1, {0, 1}), {0, 1}, "channels 2, streams 1, coupled streams 1, mapping 0 1\n"},
    {Layout(6, 4, 2, {0, 1, 2, 3, 4, 5}, 480), {0, 1, 2, 3, 4, 5}, "channels 6, streams 4, coupled streams 2, mapping 0 1 2 3 4 5\n"},
    {Layout(6, 6, 0, {0, 1, 2, 3, 4, 5}), {0, 1, 2, 3, 4, 5}, "channels 6, streams 6, coupled streams 0, mapping 0 1 2 3 4 5\n"},
    {Layout(8, 5, 3, {0, 1, 2, 3, 4, 5, 6, 7}, 480), {0, 1, 2, 3, 4, 5, 6, 7}, "channels 8, streams 5, coupled streams 3, mapping 0 1 2 3 4 5 6 7\n"},
    {Layout(8, 8, 0, {0, 1, 2, 3, 4, 5, 6, 7}), {0, 1, 2, 3, 4, 5, 6, 7}, "channels 8, streams 8, coupled streams 0, mapping 0 1 2 3 4 5 6 7\n"},
    {Layout(6, 4, 2, {0, 4, 1, 5, 2, 3}), {0, 4, 1, 5, 2, 3}, "channels 6, streams 4, coupled streams 2, mapping 0 4 1 5 2 3\n"},
    {Layout(8, 5, 3, {0, 6, 1, 7, 2, 3, 4, 5}), {0, 6, 1, 7, 2, 3, 4, 5}, "channels 8, streams 5, coupled streams 3, mapping 0 6 1 7 2 3 4 5\n"},
    {Layout(8, 8, 0, {0, 1, 2, 7, 4, 5, 3, 6}), {0, 1, 2, 7, 4, 5, 3, 6}, "channels 8, streams 8, coupled streams 0, mapping 0 1 2 7 4 5 3 6\n"},
    {Layout(8, 6, 2, {0, 1, 2, 7, 4, 5, 3, 6}), {0, 1, 2, 7, 4, 5, 3, 6}, "channels 8, streams 6, coupled streams 2, mapping 0 1 2 7 4 5 3 6\n"},
    {Layout(8, 5, 3, {0, 1, 2, 7, 4, 5, 6, 3}), {0, 1, 2, 7, 4, 5, 6, 3}, "channels 8, streams 5, coupled streams 3, mapping 0 1 2 7 4 5 6 3\n"},
    {Layout(8, 5, 3, {1, 0, 2, 7, 4, 5, 3, 6}), {1, 0, 2, 7, 4, 5, 3, 6}, "channels 8, streams 5, coupled streams 3, mapping 1 0 2 7 4 5 3 6\n"},
  };
  for (const Case& item : cases) {
    const int result = InitAudio(AudioBackend::Emss, item.config, false);
    CHECK_EQ(result, 0);
    CHECK(CreatedWith(item.config, item.mapping));
    CHECK_EQ(CountLogs(item.log), 1);
    CHECK_EQ(CountLogs("Opus layout of the stream"), 1);
    CHECK_EQ(CountLogs("instead"), 0);
    MoonlightInstance::AudDecCleanup();
  }

  // The layout is also logged for a stream whose audio output is disabled, which decodes nothing
  const int disabled = InitAudio(AudioBackend::Disabled, misrotated, false);
  CHECK_EQ(disabled, 0);
  CHECK_EQ(CountLogs("Opus layout of the stream: channels 8, streams 5, coupled streams 3, mapping 0 1 2 7 4 5 3 6\n"), 1);
  CHECK_EQ(CountLogs("instead"), 0);
  CHECK(g_Instance->*Pointer(OpusDecoderMember()) == nullptr);
}

int main() {
  test_support::RunTest("the decode buffer of the EMSS backend holds one negotiated frame, in samples",
                        DecodeBufferHoldsOneFrameInSamples);
  test_support::RunTest("a packet that the decoder rejects appends nothing and leaves the buffer as it was",
                        RejectedPacketAppendsNothingAndKeepsTheBuffer);
  test_support::RunTest("the packets that the player rejects are logged for the first and every 100th",
                        PlayerRejectionsAreLoggedInBatches);
  test_support::RunTest("the packets that Limit audio delay drops are logged for the first and every 100th",
                        DroppedPacketsAreLoggedInBatches);
  test_support::RunTest("the time of the decoder and of AppendPacket() reaches the statistics",
                        DecodeAndOutputTimesReachTheStatistics);
  test_support::RunTest("the Web Audio backend counts the decode and the post", WebAudioCountsTheDecodeAndThePost);
  test_support::RunTest("disabled audio decodes nothing and shows no audio lines", DisabledAudioDecodesNothing);
  test_support::RunTest("an overloaded audio thread logs its figures and tells the front end once per stream",
                        OverloadedAudioThreadTellsTheFrontEndOncePerStream);
  test_support::RunTest("an audio thread below the limit tells nothing, and each stream logs and keeps its figures",
                        AudioThreadBelowTheLimitTellsNothing);
  test_support::RunTest("the decoder is destroyed with its stream and before a new one is created",
                        DecoderIsDestroyedWithTheStreamAndBeforeANewOne);
  test_support::RunTest("a decoder that can't be created fails the audio start with a log line and decodes nothing",
                        DecoderThatCannotBeCreatedFailsTheAudioStart);
  test_support::RunTest("each start logs the layout, and only the 7.1 of a host with the faulty rotation is corrected",
                        LayoutIsLoggedAndOnlyTheMisrotated71IsCorrected);
  return test_support::Summary();
}
