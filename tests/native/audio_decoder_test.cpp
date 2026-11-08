// Checks the audio decoder of the stream (wasm/auddec.cpp, included directly) with a stand-in for the Opus decoder and
// the audio track of the stubs: the decode buffer of the EMSS backend holds one negotiated frame over all channels (in
// samples, not bytes) and the decoder is offered exactly that frame; a packet that the decoder rejects appends nothing
// and leaves the buffer as it was, since the next packet carries only its own samples; the packets that the audio player
// of the TV rejects and those that 'Limit audio delay' drops are logged for the first one and every 100th instead of
// each one; and the time of the decoder and of the hand-over to the player (AppendPacket() of the EMSS backend, the post
// of the Web Audio backend) reaches the audio statistics of the overlay (wasm/audio_stream_stats.hpp) with the samples
// that were decoded.

#include "../../wasm/auddec.cpp"

#include "test_support.h"

#include <cstdarg>
#include <cstring>
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

extern "C" OpusMSDecoder* opus_multistream_decoder_create(opus_int32, int channels, int, int, const unsigned char*,
                                                          int* error) {
  decodeChannels = channels;
  *error = OPUS_OK;
  return reinterpret_cast<OpusMSDecoder*>(&fakeDecoder);
}

extern "C" int opus_multistream_decode(OpusMSDecoder*, const unsigned char*, opus_int32, opus_int16* pcm, int frame_size,
                                       int) {
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

// A stream with the given backend and format, as StartStream() and the connection set it up, with the audio track open
static void StartAudio(AudioBackend backend, int channels, int samplesPerFrame, bool audioSync) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  std::memset(storage, 0, sizeof(storage));
  g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  g_Instance->*Pointer(AudioBackendMember()) = backend;
  g_Instance->*Pointer(AudioSyncMember()) = audioSync;
  logs.clear();
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
  OPUS_MULTISTREAM_CONFIGURATION config = {};
  config.sampleRate = 48000;
  config.channelCount = channels;
  config.streams = channels == 2 ? 1 : 4;
  config.coupledStreams = channels == 2 ? 1 : 2;
  config.samplesPerFrame = samplesPerFrame;
  CHECK_EQ(MoonlightInstance::AudDecInit(0, &config, nullptr, 0), 0);
  CHECK((g_Instance->*Pointer(OpusDecoderMember()) != nullptr) == (backend != AudioBackend::Disabled));
  (g_Instance->*Pointer(AudioStartedMember())) = true;
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
  return test_support::Summary();
}
