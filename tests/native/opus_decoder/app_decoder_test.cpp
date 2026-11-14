// Runs the audio decoder of the app (wasm/auddec.cpp, included directly) with the Opus library that tests/native/run.sh
// builds from the source list of CMakeLists.txt, where audio_decoder_test.cpp has a stand-in for it. run.sh builds it
// with the address sanitizer, whose leak check fails the test when a decoder is left behind.
//  - Every layout that a Sunshine host announces is started, decoded and stopped several times with both backends,
//    and a start that finds a decoder of an earlier stream destroys it: nothing is leaked.
//  - A layout that Opus refuses (a host with surround parameters that make no sense) fails the audio start with a log
//    line, and a packet that arrives all the same is not decoded.
//  - Every channel of the host plays in its place, for stereo, 5.1 and 7.1 in both qualities, and for the 7.1 that a
//    host with the faulty channel rotation announces for its normal quality (wasm/opus_layout.hpp). The layouts are
//    those that moonlight-common-c hands the audio renderer (opus_channel_layout_test.c derives them from the tables
//    of Sunshine with the real parseOpusConfigurations()).
//
// How the place of a channel is checked without an encoder: Sunshine encodes with the mapping 0 1 2 ..., so its channel
// k is the left (k even) or right channel of the coupled stream k / 2 while k is below twice the number of coupled
// streams, and the mono stream k - coupled above (opus_multistream_encoder_create()). A multistream packet is the
// packets of its streams one after another, each but the last one with its length after the first byte (RFC 6716,
// appendix B). The test builds such packets from arbitrary frame data, which the range decoder of Opus accepts like
// any other bit stream, decodes each stream on its own with a plain Opus decoder (opus_decode(), two channels for a
// coupled stream), which knows no mapping, and expects output channel k of the app to carry exactly the samples of
// channel k of the host. All channels of a packet differ, so a channel in the wrong place is seen.

#include "../../../wasm/auddec.cpp"

#include "../test_support.h"

#include <opus.h>

#include <cstdarg>
#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>

MoonlightInstance* g_Instance = nullptr;

// The test sets members of the instance that StartStream() and the media listeners write (see audio_decoder_test.cpp)
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
// The message of an overloaded audio thread (CheckAudioLoad() in auddec.cpp), which no stream of this test is long
// enough for; audio_decoder_test.cpp checks it
void PostToJsAsync(std::string) {
}

static int CountLogs(const char* text) {
  int count = 0;
  for (const std::string& line : logs) {
    count += line.find(text) != std::string::npos ? 1 : 0;
  }
  return count;
}

// ---- The layouts ----

// A layout as moonlight-common-c hands it to the audio renderer, with the packet duration the app asks for
struct Layout {
  const char* name;
  OPUS_MULTISTREAM_CONFIGURATION config;
};

static Layout MakeLayout(const char* name, int channels, int streams, int coupledStreams,
                         std::initializer_list<unsigned char> mapping, int samplesPerFrame) {
  Layout layout = {name, {}};
  layout.config.sampleRate = 48000;
  layout.config.channelCount = channels;
  layout.config.streams = streams;
  layout.config.coupledStreams = coupledStreams;
  layout.config.samplesPerFrame = samplesPerFrame;
  std::copy(mapping.begin(), mapping.end(), layout.config.mapping);
  return layout;
}

// What a Sunshine host announces, as parseOpusConfigurations() reads it: the normal quality in the 10 ms packets of
// 'Surround audio quality' Efficient and in the 5 ms packets of a stream below 15 Mbps, the high quality in 5 ms packets
static const std::vector<Layout>& SunshineLayouts() {
  static const std::vector<Layout> layouts = {
    MakeLayout("stereo", 2, 1, 1, {0, 1}, 240),
    MakeLayout("5.1 in normal quality, 10 ms", 6, 4, 2, {0, 1, 2, 3, 4, 5}, 480),
    MakeLayout("5.1 in normal quality, 5 ms", 6, 4, 2, {0, 1, 2, 3, 4, 5}, 240),
    MakeLayout("5.1 in high quality", 6, 6, 0, {0, 1, 2, 3, 4, 5}, 240),
    MakeLayout("7.1 in normal quality, 10 ms", 8, 5, 3, {0, 1, 2, 3, 4, 5, 6, 7}, 480),
    MakeLayout("7.1 in normal quality of a host with the faulty rotation, 10 ms", 8, 5, 3, {0, 1, 2, 7, 4, 5, 3, 6}, 480),
    MakeLayout("7.1 in normal quality of a host with the faulty rotation, 5 ms", 8, 5, 3, {0, 1, 2, 7, 4, 5, 3, 6}, 240),
    MakeLayout("7.1 in high quality", 8, 8, 0, {0, 1, 2, 3, 4, 5, 6, 7}, 240),
  };
  return layouts;
}

// ---- The packets of the host and what each of its channels carries ----

#define FRAME_DATA_LEN 40

// The packet of one stream: a CELT fullband frame of 5 or 10 ms (TOC configuration 29 or 30, RFC 6716 section 3.1),
// stereo for a coupled stream, with arbitrary data that differs for every stream and packet
static std::vector<unsigned char> StreamPacket(const OPUS_MULTISTREAM_CONFIGURATION& config, int stream, int sequence) {
  const int tocConfig = config.samplesPerFrame == 480 ? 30 : 29;
  const bool stereo = stream < config.coupledStreams;
  std::vector<unsigned char> packet;
  packet.push_back((unsigned char)((tocConfig << 3) | (stereo ? 1 << 2 : 0)));
  unsigned int state = 2463534242u + (unsigned int)stream * 7919u + (unsigned int)sequence * 104729u;
  for (int i = 0; i < FRAME_DATA_LEN; i++) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    packet.push_back((unsigned char)(state >> 11));
  }
  return packet;
}

// The multistream packet that the host sends: every stream but the last one carries its length after the TOC byte
static std::vector<unsigned char> HostPacket(const OPUS_MULTISTREAM_CONFIGURATION& config, int sequence) {
  std::vector<unsigned char> packet;
  for (int stream = 0; stream < config.streams; stream++) {
    const std::vector<unsigned char> part = StreamPacket(config, stream, sequence);
    packet.push_back(part[0]);
    if (stream < config.streams - 1) {
      packet.push_back((unsigned char)(part.size() - 1));
    }
    packet.insert(packet.end(), part.begin() + 1, part.end());
  }
  return packet;
}

// The samples of every channel of the host over the given number of packets, decoded stream by stream
static std::vector<std::vector<opus_int16>> HostChannels(const OPUS_MULTISTREAM_CONFIGURATION& config, int packets) {
  std::vector<std::vector<opus_int16>> channels((size_t)config.channelCount);
  for (int stream = 0; stream < config.streams; stream++) {
    const int streamChannels = stream < config.coupledStreams ? 2 : 1;
    int error = 0;
    OpusDecoder* decoder = opus_decoder_create(config.sampleRate, streamChannels, &error);
    CHECK(decoder != nullptr && error == OPUS_OK);
    if (decoder == nullptr) {
      continue;
    }
    std::vector<opus_int16> pcm((size_t)config.samplesPerFrame * streamChannels);
    for (int sequence = 0; sequence < packets; sequence++) {
      const std::vector<unsigned char> packet = StreamPacket(config, stream, sequence);
      const int decoded = opus_decode(decoder, packet.data(), (opus_int32)packet.size(), pcm.data(), config.samplesPerFrame, 0);
      CHECK_EQ(decoded, config.samplesPerFrame);
      for (int side = 0; side < streamChannels; side++) {
        // The channel of the host that the encoder puts here with its mapping 0 1 2 ...
        const int hostChannel = stream < config.coupledStreams ? 2 * stream + side : config.coupledStreams + stream;
        for (int i = 0; i < config.samplesPerFrame; i++) {
          channels[(size_t)hostChannel].push_back(pcm[(size_t)i * streamChannels + side]);
        }
      }
    }
    opus_decoder_destroy(decoder);
  }
  return channels;
}

// ---- The app ----

// The interleaved samples that the EMSS backend appended to the audio track
static std::vector<opus_int16> appended;

static int StartAudio(AudioBackend backend, const OPUS_MULTISTREAM_CONFIGURATION& layout) {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  if (g_Instance == nullptr) {
    std::memset(storage, 0, sizeof(storage));
    g_Instance = reinterpret_cast<MoonlightInstance*>(storage);
  }
  g_Instance->*Pointer(AudioBackendMember()) = backend;
  g_Instance->*Pointer(AudioSyncMember()) = false;
  logs.clear();
  appended.clear();
  samsung::wasm::TestAppendPacketHook() = [](const samsung::wasm::ElementaryMediaPacket& packet) {
    const opus_int16* samples = (const opus_int16*)packet.data;
    appended.insert(appended.end(), samples, samples + packet.data_size / sizeof(opus_int16));
    return 0;
  };
  OPUS_MULTISTREAM_CONFIGURATION config = layout;
  const int result = MoonlightInstance::AudDecInit(0, &config, nullptr, 0);
  (g_Instance->*Pointer(AudioStartedMember())) = true;
  return result;
}

static void Feed(const OPUS_MULTISTREAM_CONFIGURATION& config, int packets) {
  for (int sequence = 0; sequence < packets; sequence++) {
    std::vector<unsigned char> packet = HostPacket(config, sequence);
    MoonlightInstance::AudDecDecodeAndPlaySample(reinterpret_cast<char*>(packet.data()), (int)packet.size());
  }
}

static bool HasDecoder() {
  return g_Instance->*Pointer(OpusDecoderMember()) != nullptr;
}

// ---- The tests ----

static void EveryLayoutStartsDecodesAndStopsWithoutALeak() {
  // Three rounds over all layouts and both backends: a decoder that a stream leaves behind is no longer referenced
  // once the next one is created, which the leak check reports when the test ends
  for (int round = 0; round < 3; round++) {
    for (const Layout& layout : SunshineLayouts()) {
      for (AudioBackend backend : {AudioBackend::Emss, AudioBackend::WebAudio}) {
        const int result = StartAudio(backend, layout.config);
        CHECK_EQ(result, 0);
        CHECK(HasDecoder());
        Feed(layout.config, 4);
        // A lost packet is concealed
        MoonlightInstance::AudDecDecodeAndPlaySample(nullptr, 0);
        CHECK_EQ(g_AudioStreamStats.decodeErrors.load(), 0u);
        CHECK_EQ(g_AudioStreamStats.decodedSamples.load(), 5u * (unsigned)layout.config.samplesPerFrame);
        if (backend == AudioBackend::Emss) {
          CHECK_EQ(appended.size(), (size_t)5 * layout.config.samplesPerFrame * layout.config.channelCount);
        }
        MoonlightInstance::AudDecCleanup();
        CHECK(!HasDecoder());
      }
    }
  }
  // A stream with the audio output disabled creates no decoder and stops like any other
  const int disabled = StartAudio(AudioBackend::Disabled, SunshineLayouts()[1].config);
  CHECK_EQ(disabled, 0);
  CHECK(!HasDecoder());
  MoonlightInstance::AudDecCleanup();
}

static void StartThatFindsADecoderDestroysIt() {
  // Starts without a stop in between, each with a layout of another size
  for (const Layout& layout : SunshineLayouts()) {
    const int result = StartAudio(AudioBackend::Emss, layout.config);
    CHECK_EQ(result, 0);
    Feed(layout.config, 2);
    CHECK_EQ(appended.size(), (size_t)2 * layout.config.samplesPerFrame * layout.config.channelCount);
  }
  // Disabled audio takes the decoder of the stream before it away too
  const int disabled = StartAudio(AudioBackend::Disabled, SunshineLayouts()[0].config);
  CHECK_EQ(disabled, 0);
  CHECK(!HasDecoder());
  // A second stop finds nothing to destroy
  MoonlightInstance::AudDecCleanup();
  MoonlightInstance::AudDecCleanup();
  CHECK(!HasDecoder());
}

static void LayoutThatOpusRefusesFailsTheAudioStart() {
  const Layout refused[] = {
    // surround-params=81901234567: more coupled streams than streams
    MakeLayout("9 coupled streams of 1", 8, 1, 9, {0, 1, 2, 3, 4, 5, 6, 7}, 240),
    // A mapping entry beyond the 8 stream channels of 5 streams with 3 coupled ones, which Opus finds after it
    // allocated the decoder
    MakeLayout("a stream channel that doesn't exist", 8, 5, 3, {0, 1, 2, 3, 4, 5, 6, 9}, 240),
    MakeLayout("no streams", 6, 0, 0, {0, 1, 2, 3, 4, 5}, 240),
    MakeLayout("no channels", 0, 1, 1, {0, 1}, 240),
  };
  for (AudioBackend backend : {AudioBackend::Emss, AudioBackend::WebAudio}) {
    for (const Layout& layout : refused) {
      const int result = StartAudio(backend, layout.config);
      if (result != OPUS_BAD_ARG) {
        std::printf("  # %s\n", layout.name);
      }
      CHECK_EQ(result, OPUS_BAD_ARG);
      CHECK(!HasDecoder());
      CHECK_EQ(CountLogs("Creating the Opus decoder failed with error -1 (invalid argument), so the audio stream can't start\n"), 1);
      CHECK_EQ(s_DecodeBuffer.size(), (size_t)0);
      // moonlight-common-c ends the start here and sends no packet; one that came all the same is not decoded
      Feed(SunshineLayouts()[0].config, 2);
      MoonlightInstance::AudDecDecodeAndPlaySample(nullptr, 0);
      CHECK(appended.empty());
      CHECK_EQ(g_AudioStreamStats.decodedSamples.load(), 0u);
    }
    // The next start works
    const Layout& stereo = SunshineLayouts()[0];
    const int result = StartAudio(backend, stereo.config);
    CHECK_EQ(result, 0);
    CHECK_EQ(CountLogs("Creating the Opus decoder failed"), 0);
    Feed(stereo.config, 2);
    CHECK_EQ(g_AudioStreamStats.decodedSamples.load(), 2u * 240u);
    MoonlightInstance::AudDecCleanup();
  }
}

// The channels of the host are told apart by their samples: none is silent and no two are the same
static void CheckChannelsDiffer(const std::vector<std::vector<opus_int16>>& host) {
  for (size_t a = 0; a < host.size(); a++) {
    long long energy = 0;
    for (opus_int16 sample : host[a]) {
      energy += (long long)sample * sample;
    }
    CHECK(energy > 0);
    for (size_t b = a + 1; b < host.size(); b++) {
      CHECK(host[a] != host[b]);
    }
  }
}

// The channel of the host whose samples the given output channel carries, or -1 for none of them
static int CarriedChannel(const std::vector<std::vector<opus_int16>>& host, const std::vector<opus_int16>& output) {
  for (size_t channel = 0; channel < host.size(); channel++) {
    if (host[channel] == output) {
      return (int)channel;
    }
  }
  return -1;
}

static void EveryChannelOfTheHostPlaysInItsPlace() {
  const int packets = 6;
  for (const Layout& layout : SunshineLayouts()) {
    const OPUS_MULTISTREAM_CONFIGURATION& config = layout.config;
    const std::vector<std::vector<opus_int16>> host = HostChannels(config, packets);
    CheckChannelsDiffer(host);
    const size_t samples = (size_t)packets * config.samplesPerFrame;

    // The EMSS backend appends the samples interleaved
    int result = StartAudio(AudioBackend::Emss, config);
    CHECK_EQ(result, 0);
    Feed(config, packets);
    CHECK_EQ(appended.size(), samples * config.channelCount);
    for (int channel = 0; channel < config.channelCount && appended.size() == samples * config.channelCount; channel++) {
      std::vector<opus_int16> output;
      for (size_t i = 0; i < samples; i++) {
        output.push_back(appended[i * config.channelCount + channel]);
      }
      const int carried = CarriedChannel(host, output);
      if (carried != channel) {
        std::printf("  # %s, EMSS: output channel %d carries channel %d of the host\n", layout.name, channel, carried);
      }
      CHECK_EQ(carried, channel);
    }
    MoonlightInstance::AudDecCleanup();

    // The Web Audio backend hands over a slot per packet with the samples of each channel in a row, as floats
    result = StartAudio(AudioBackend::WebAudio, config);
    CHECK_EQ(result, 0);
    Feed(config, packets);
    for (int channel = 0; channel < config.channelCount; channel++) {
      bool same = true;
      for (int sequence = 0; sequence < packets && same; sequence++) {
        const float* slot = s_AudioSlots[sequence] + (size_t)channel * kAudioSlotStride;
        for (int i = 0; i < config.samplesPerFrame && same; i++) {
          same = slot[i] == host[(size_t)channel][(size_t)sequence * config.samplesPerFrame + i] / 32768.0f;
        }
      }
      if (!same) {
        std::printf("  # %s, Web Audio: output channel %d doesn't carry channel %d of the host\n", layout.name, channel, channel);
      }
      CHECK(same);
    }
    MoonlightInstance::AudDecCleanup();
  }
}

static void AnnouncedMappingOfTheFaultyRotationPlaysThreeChannelsInTheWrongPlace() {
  // What a decoder created with the mapping as it was announced plays, which is what the app did before: the check
  // above tells the channels apart, and the correction is needed
  const OPUS_MULTISTREAM_CONFIGURATION& config = SunshineLayouts()[5].config;
  CHECK(IsMisrotatedSurround71Layout(&config));
  const int packets = 4;
  const std::vector<std::vector<opus_int16>> host = HostChannels(config, packets);
  int error = 0;
  OpusMSDecoder* decoder = opus_multistream_decoder_create(config.sampleRate, config.channelCount, config.streams,
                                                           config.coupledStreams, config.mapping, &error);
  CHECK(decoder != nullptr && error == OPUS_OK);
  if (decoder == nullptr) {
    return;
  }
  std::vector<std::vector<opus_int16>> output((size_t)config.channelCount);
  std::vector<opus_int16> pcm((size_t)config.samplesPerFrame * config.channelCount);
  for (int sequence = 0; sequence < packets; sequence++) {
    const std::vector<unsigned char> packet = HostPacket(config, sequence);
    const int decoded = opus_multistream_decode(decoder, packet.data(), (opus_int32)packet.size(), pcm.data(),
                                                config.samplesPerFrame, 0);
    CHECK_EQ(decoded, config.samplesPerFrame);
    for (int channel = 0; channel < config.channelCount; channel++) {
      for (int i = 0; i < config.samplesPerFrame; i++) {
        output[(size_t)channel].push_back(pcm[(size_t)i * config.channelCount + channel]);
      }
    }
  }
  opus_multistream_decoder_destroy(decoder);
  // FL FR FC LFE BL BR SL SR: the LFE output carries side right, side left carries LFE and side right carries side left
  const int expected[8] = {0, 1, 2, 7, 4, 5, 3, 6};
  for (int channel = 0; channel < 8; channel++) {
    const int carried = CarriedChannel(host, output[(size_t)channel]);
    CHECK_EQ(carried, expected[channel]);
  }
}

int main() {
  test_support::RunTest("every layout starts, decodes and stops with both backends, three times over",
                        EveryLayoutStartsDecodesAndStopsWithoutALeak);
  test_support::RunTest("a start that finds the decoder of an earlier stream destroys it", StartThatFindsADecoderDestroysIt);
  test_support::RunTest("a layout that Opus refuses fails the audio start with a log line and decodes nothing",
                        LayoutThatOpusRefusesFailsTheAudioStart);
  test_support::RunTest("every channel of the host plays in its place, also 7.1 from a host with the faulty rotation",
                        EveryChannelOfTheHostPlaysInItsPlace);
  test_support::RunTest("the mapping as such a host announces it plays LFE, side left and side right in the wrong place",
                        AnnouncedMappingOfTheFaultyRotationPlaysThreeChannelsInTheWrongPlace);
  return test_support::Summary();
}
