// Checks the channel mapping that the Opus decoder of a stream is created with (GetOpusDecoderMapping() of
// wasm/opus_layout.hpp, which AudDecInit() in wasm/auddec.cpp uses) against the layouts that Sunshine announces: the
// test builds the surround-params lines of the DESCRIBE answer from the tables of Sunshine as its src/rtsp.cpp does,
// once with the rotation of its release v2026.914 (over the entries 3 to 5 whatever the layout; Apollo and Vibeshine
// have the same line) and once with the rotation since its commit 8952d44 (from entry 3 to the last one), and runs
// them through the real parseOpusConfigurations() of moonlight-common-c (RtspConnection.c, included directly).
//
// Sunshine encodes every layout with the mapping 0 1 2 ..., from channels in the order FL FR FC LFE BL BR SL SR that
// the output of the decoder has too, so every channel plays in its place exactly when the decoder gets that mapping
// (wasm/opus_layout.hpp explains how Opus reads it; opus_decoder/app_decoder_test.cpp decodes with it). The test
// expects it for stereo, 5.1 and 7.1 in both qualities and from both hosts, and that only the 7.1 in normal quality of
// the older host needs the correction: every other layout reaches the decoder exactly as moonlight-common-c parsed it,
// as do the 5.1 that moonlight-common-c falls back to for GeForce Experience, a 7.1 paired the same way, and layouts
// that differ from the faulty one in a single value.
//
// The test includes RtspConnection.c with the files it needs; RtspParser.c is built as a unit of its own, because
// Rtsp.h, which both include, has no include guard (see rtsp_decrypt_error_test.c).
// Build with: moonlight-common-c/src/RtspParser.c -lcrypto

// The socket code of moonlight-common-c needs the GNU extensions of the C library (in6_pktinfo)
#define _GNU_SOURCE

#include "test_support_c.h"

#include <openssl/evp.h>

#include "../../moonlight-common-c/src/RtspConnection.c"
#include "../../moonlight-common-c/src/PlatformCrypto.c"
#include "../../moonlight-common-c/src/PlatformSockets.c"
#include "../../moonlight-common-c/src/Platform.c"
#include "../../moonlight-common-c/src/Misc.c"
#include "../../moonlight-common-c/enet/callbacks.c"
#include "../../moonlight-common-c/enet/compress.c"
#include "../../moonlight-common-c/enet/host.c"
#include "../../moonlight-common-c/enet/list.c"
#include "../../moonlight-common-c/enet/packet.c"
#include "../../moonlight-common-c/enet/peer.c"
#include "../../moonlight-common-c/enet/protocol.c"
#include "../../moonlight-common-c/enet/unix.c"

#include "../../wasm/opus_layout.hpp"

#include <string.h>

// What the other files of moonlight-common-c provide (Connection.c and the streams); parseOpusConfigurations() needs
// the stream configuration and the two Opus configurations of them. The listener takes the log lines in the release
// build (LC_LOG); this test sets none.
struct sockaddr_storage RemoteAddr;
struct sockaddr_storage LocalAddr;
SOCKADDR_LEN AddrLen;
int AppVersionQuad[4];
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
AUDIO_RENDERER_CALLBACKS AudioCallbacks;
DECODER_RENDERER_CALLBACKS VideoCallbacks;
int NegotiatedVideoFormat;
volatile bool ConnectionInterrupted;
bool HighQualitySurroundSupported;
bool ReferenceFrameInvalidationSupported;
uint16_t RtspPortNumber;
uint16_t ControlPortNumber;
uint16_t AudioPortNumber;
uint16_t VideoPortNumber;
uint32_t ControlConnectData;
uint32_t SunshineFeatureFlags;
uint32_t EncryptionFeaturesSupported;
uint32_t EncryptionFeaturesRequested;
uint32_t EncryptionFeaturesEnabled;
bool AudioEncryptionEnabled;
SS_PING AudioPingPayload;
SS_PING VideoPingPayload;
OPUS_MULTISTREAM_CONFIGURATION HighQualityOpusConfig;
OPUS_MULTISTREAM_CONFIGURATION NormalQualityOpusConfig;

char* getSdpPayloadForStreamConfig(int rtspClientVersion, int* length) {
  (void)rtspClientVersion;
  *length = 0;
  return NULL;
}
int notifyAudioPortNegotiationComplete(void) {
  return 0;
}

// ---- The host: the tables of Sunshine and the lines its DESCRIBE answer is built from ----

// The speakers in the order of the input of the encoder (platf::speaker in src/platform/common.h of Sunshine), which
// is the order of the output channels of the client (Limelight.h)
enum { FRONT_LEFT, FRONT_RIGHT, FRONT_CENTER, LOW_FREQUENCY, BACK_LEFT, BACK_RIGHT, SIDE_LEFT, SIDE_RIGHT, MAX_SPEAKERS };

// The layouts (audio::stream_configs in src/audio.cpp, in the order of its enum): channels, streams, coupled streams
// and the mapping of the encoder, which is map_stereo, map_surround51 or map_surround71 of platf::speaker
enum { STEREO, HIGH_STEREO, SURROUND51, HIGH_SURROUND51, SURROUND71, HIGH_SURROUND71, MAX_STREAM_CONFIG };

struct HostLayout {
  const char* name;
  int channels;
  int streams;
  int coupledStreams;
  unsigned char mapping[MAX_SPEAKERS];
};

static const struct HostLayout kHostLayouts[MAX_STREAM_CONFIG] = {
  { "stereo", 2, 1, 1, { FRONT_LEFT, FRONT_RIGHT } },
  { "stereo in high quality", 2, 1, 1, { FRONT_LEFT, FRONT_RIGHT } },
  { "5.1 in normal quality", 6, 4, 2, { FRONT_LEFT, FRONT_RIGHT, FRONT_CENTER, LOW_FREQUENCY, BACK_LEFT, BACK_RIGHT } },
  { "5.1 in high quality", 6, 6, 0, { FRONT_LEFT, FRONT_RIGHT, FRONT_CENTER, LOW_FREQUENCY, BACK_LEFT, BACK_RIGHT } },
  { "7.1 in normal quality", 8, 5, 3,
    { FRONT_LEFT, FRONT_RIGHT, FRONT_CENTER, LOW_FREQUENCY, BACK_LEFT, BACK_RIGHT, SIDE_LEFT, SIDE_RIGHT } },
  { "7.1 in high quality", 8, 8, 0,
    { FRONT_LEFT, FRONT_RIGHT, FRONT_CENTER, LOW_FREQUENCY, BACK_LEFT, BACK_RIGHT, SIDE_LEFT, SIDE_RIGHT } },
};

// The two hosts: Sunshine v2026.914 with Apollo and Vibeshine, and Sunshine since its commit 8952d44
enum { HOST_ROTATES_3_TO_5, HOST_ROTATES_TO_THE_LAST_CHANNEL, HOST_COUNT };
static const char* const kHostNames[HOST_COUNT] = { "the host that rotates the entries 3 to 5",
                                                    "the host that rotates up to the last channel" };

// std::rotate(first, middle, last) for the entries of a mapping
static void rotate(unsigned char* first, unsigned char* middle, unsigned char* last) {
  unsigned char rotated[MAX_SPEAKERS];
  const size_t count = (size_t)(last - first);
  const size_t shift = (size_t)(middle - first);
  for (size_t i = 0; i < count; i++) {
    rotated[i] = first[(i + shift) % count];
  }
  memcpy(first, rotated, count);
}

// The surround-params lines of the DESCRIBE answer (cmd_describe() in src/rtsp.cpp): for the normal quality of 5.1 and
// 7.1 the mapping is rotated to the left from entry 3 on, so that the move of the last entry to position 3 that
// Moonlight makes for GeForce Experience gives the mapping of the encoder again. One host rotates up to
// mapping + audio::MAX_STREAM_CONFIG, the number of layouts, and the other one up to the channel count.
static void describe(int host, char* payload, size_t size) {
  payload[0] = 0;
  for (int x = 0; x < MAX_STREAM_CONFIG; x++) {
    const struct HostLayout* layout = &kHostLayouts[x];
    unsigned char mapping[MAX_SPEAKERS];
    memcpy(mapping, layout->mapping, sizeof(mapping));
    if (x == SURROUND51 || x == SURROUND71) {
      rotate(mapping + 3, mapping + 4,
             mapping + (host == HOST_ROTATES_3_TO_5 ? MAX_STREAM_CONFIG : layout->channels));
    }
    char line[96];
    int length = snprintf(line, sizeof(line), "a=fmtp:97 surround-params=%d%d%d", layout->channels, layout->streams,
                          layout->coupledStreams);
    for (int i = 0; i < layout->channels; i++) {
      line[length++] = (char)('0' + mapping[i]);
    }
    line[length++] = '\n';
    line[length] = 0;
    strncat(payload, line, size - strlen(payload) - 1);
  }
}

// ---- The client ----

// The layout that moonlight-common-c hands the audio renderer for a stream of this layout of the host
// (parseOpusConfigurations() and the choice of startAudioStream() in AudioStream.c)
static bool negotiate(int host, int hostLayout, OPUS_MULTISTREAM_CONFIGURATION* config) {
  char payload[512];
  describe(host, payload, sizeof(payload));
  const struct HostLayout* layout = &kHostLayouts[hostLayout];
  memset(&StreamConfig, 0, sizeof(StreamConfig));
  StreamConfig.audioConfiguration = layout->channels == 2 ? AUDIO_CONFIGURATION_STEREO : layout->channels == 6
    ? AUDIO_CONFIGURATION_51_SURROUND : AUDIO_CONFIGURATION_71_SURROUND;
  RTSP_MESSAGE response;
  memset(&response, 0, sizeof(response));
  response.payload = payload;
  response.payloadLength = (int)strlen(payload);
  if (parseOpusConfigurations(&response) != 0) {
    return false;
  }
  const bool high = hostLayout == HIGH_SURROUND51 || hostLayout == HIGH_SURROUND71;
  if (high && !HighQualitySurroundSupported) {
    return false;
  }
  // Stereo has one configuration in the client, whichever of its two bitrates the host sends
  *config = high ? HighQualityOpusConfig : NormalQualityOpusConfig;
  return true;
}

static bool sameMapping(const unsigned char* actual, const unsigned char* expected, int count) {
  if (memcmp(actual, expected, (size_t)count) == 0) {
    return true;
  }
  char actualText[32];
  char expectedText[32];
  FormatOpusMapping(actual, count, actualText, sizeof(actualText));
  FormatOpusMapping(expected, count, expectedText, sizeof(expectedText));
  printf("  # mapping %s, expected %s\n", actualText, expectedText);
  return false;
}

// ---- The tests ----

static void test_describe_lines_of_both_hosts(void) {
  char payload[512];
  describe(HOST_ROTATES_3_TO_5, payload, sizeof(payload));
  CHECK(strcmp(payload, "a=fmtp:97 surround-params=21101\n"
                        "a=fmtp:97 surround-params=21101\n"
                        "a=fmtp:97 surround-params=642012453\n"
                        "a=fmtp:97 surround-params=660012345\n"
                        "a=fmtp:97 surround-params=85301245367\n"
                        "a=fmtp:97 surround-params=88001234567\n") == 0);
  describe(HOST_ROTATES_TO_THE_LAST_CHANNEL, payload, sizeof(payload));
  CHECK(strcmp(payload, "a=fmtp:97 surround-params=21101\n"
                        "a=fmtp:97 surround-params=21101\n"
                        "a=fmtp:97 surround-params=642012453\n"
                        "a=fmtp:97 surround-params=660012345\n"
                        "a=fmtp:97 surround-params=85301245673\n"
                        "a=fmtp:97 surround-params=88001234567\n") == 0);
}

static void test_every_layout_is_decoded_with_the_mapping_of_the_encoder(void) {
  for (int host = 0; host < HOST_COUNT; host++) {
    for (int x = 0; x < MAX_STREAM_CONFIG; x++) {
      const struct HostLayout* layout = &kHostLayouts[x];
      OPUS_MULTISTREAM_CONFIGURATION config;
      memset(&config, 0, sizeof(config));
      const bool negotiated = negotiate(host, x, &config);
      CHECK(negotiated);
      if (!negotiated) {
        continue;
      }
      unsigned char mapping[AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT];
      GetOpusDecoderMapping(&config, mapping);
      // The streams are those of the encoder, and so is the mapping the decoder is created with
      const bool right = config.channelCount == layout->channels && config.streams == layout->streams &&
                         config.coupledStreams == layout->coupledStreams && config.sampleRate == 48000 &&
                         sameMapping(mapping, layout->mapping, layout->channels);
      if (!right) {
        printf("  # %s from %s\n", layout->name, kHostNames[host]);
      }
      CHECK(right);
    }
  }
}

static void test_only_the_71_in_normal_quality_of_the_older_host_is_corrected(void) {
  static const unsigned char kMisrotated[8] = { 0, 1, 2, 7, 4, 5, 3, 6 };
  int corrected = 0;
  for (int host = 0; host < HOST_COUNT; host++) {
    for (int x = 0; x < MAX_STREAM_CONFIG; x++) {
      OPUS_MULTISTREAM_CONFIGURATION config;
      memset(&config, 0, sizeof(config));
      if (!negotiate(host, x, &config)) {
        CHECK(false);
        continue;
      }
      const OPUS_MULTISTREAM_CONFIGURATION parsed = config;
      unsigned char mapping[AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT];
      memset(mapping, 0xEE, sizeof(mapping));
      const bool changed = GetOpusDecoderMapping(&config, mapping);
      // The layout of moonlight-common-c itself is only read
      CHECK(memcmp(&config, &parsed, sizeof(config)) == 0);
      if (host == HOST_ROTATES_3_TO_5 && x == SURROUND71) {
        // What moonlight-common-c makes of surround-params=85301245367: LFE would play side right, side left would
        // play LFE and side right would play side left
        CHECK(sameMapping(parsed.mapping, kMisrotated, 8));
        CHECK(IsMisrotatedSurround71Layout(&config));
        CHECK(changed);
        corrected++;
      } else {
        // Exactly as it was parsed: all 8 entries, also those that the layout doesn't use
        CHECK(!IsMisrotatedSurround71Layout(&config));
        CHECK(!changed);
        if (memcmp(mapping, parsed.mapping, sizeof(mapping)) != 0) {
          printf("  # %s from %s was changed\n", kHostLayouts[x].name, kHostNames[host]);
        }
        CHECK(memcmp(mapping, parsed.mapping, sizeof(mapping)) == 0);
      }
    }
  }
  CHECK_EQ_INT(corrected, 1);
}

// A layout as the audio renderer gets it
static OPUS_MULTISTREAM_CONFIGURATION layoutOf(int channels, int streams, int coupledStreams, const unsigned char* mapping) {
  OPUS_MULTISTREAM_CONFIGURATION config;
  memset(&config, 0, sizeof(config));
  config.sampleRate = 48000;
  config.channelCount = channels;
  config.streams = streams;
  config.coupledStreams = coupledStreams;
  config.samplesPerFrame = 240;
  memcpy(config.mapping, mapping, (size_t)channels);
  return config;
}

static void expectUnchanged(OPUS_MULTISTREAM_CONFIGURATION config) {
  unsigned char mapping[AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT];
  memset(mapping, 0xEE, sizeof(mapping));
  CHECK(!IsMisrotatedSurround71Layout(&config));
  CHECK(!GetOpusDecoderMapping(&config, mapping));
  CHECK(sameMapping(mapping, config.mapping, AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT));
}

static void test_other_layouts_are_left_alone(void) {
  // GeForce Experience: the 5.1 that moonlight-common-c falls back to without surround-params, and a 7.1 that pairs
  // the channels the same way (front left with center, the back pair, the side pair, front right and LFE alone)
  static const unsigned char gfe51[6] = { 0, 4, 1, 5, 2, 3 };
  static const unsigned char gfe71[8] = { 0, 6, 1, 7, 2, 3, 4, 5 };
  expectUnchanged(layoutOf(6, 4, 2, gfe51));
  expectUnchanged(layoutOf(8, 5, 3, gfe71));

  // The faulty mapping with other streams, and with fewer channels
  static const unsigned char misrotated[8] = { 0, 1, 2, 7, 4, 5, 3, 6 };
  expectUnchanged(layoutOf(8, 8, 0, misrotated));
  expectUnchanged(layoutOf(8, 6, 2, misrotated));
  expectUnchanged(layoutOf(8, 4, 4, misrotated));
  expectUnchanged(layoutOf(6, 5, 3, misrotated));

  // 7.1 in 5 streams, 3 of them coupled, with every mapping that differs from the faulty one in a single entry
  for (int i = 0; i < 8; i++) {
    for (int value = 0; value < 8; value++) {
      if (value == misrotated[i]) {
        continue;
      }
      unsigned char mapping[8];
      memcpy(mapping, misrotated, sizeof(mapping));
      mapping[i] = (unsigned char)value;
      expectUnchanged(layoutOf(8, 5, 3, mapping));
    }
  }

  // And the faulty one itself, written by hand as the audio renderer gets it
  OPUS_MULTISTREAM_CONFIGURATION faulty = layoutOf(8, 5, 3, misrotated);
  unsigned char corrected[AUDIO_CONFIGURATION_MAX_CHANNEL_COUNT];
  static const unsigned char inOrder[8] = { 0, 1, 2, 3, 4, 5, 6, 7 };
  CHECK(GetOpusDecoderMapping(&faulty, corrected));
  CHECK(sameMapping(corrected, inOrder, 8));
}

static void test_mapping_text_for_the_log(void) {
  static const unsigned char mapping[8] = { 0, 1, 2, 7, 4, 5, 3, 6 };
  char text[32];
  FormatOpusMapping(mapping, 8, text, sizeof(text));
  CHECK(strcmp(text, "0 1 2 7 4 5 3 6") == 0);
  FormatOpusMapping(mapping, 2, text, sizeof(text));
  CHECK(strcmp(text, "0 1") == 0);
  // Never more than the 8 entries a layout has, and never more than the text holds
  FormatOpusMapping(mapping, 200, text, sizeof(text));
  CHECK(strcmp(text, "0 1 2 7 4 5 3 6") == 0);
  static const unsigned char silent[8] = { 255, 255, 255, 255, 255, 255, 255, 255 };
  FormatOpusMapping(silent, 8, text, sizeof(text));
  CHECK(strcmp(text, "255 255 255 255 255 255 255 255") == 0);
  char small[6];
  FormatOpusMapping(silent, 8, small, sizeof(small));
  CHECK(strlen(small) < sizeof(small));
  FormatOpusMapping(mapping, 0, text, sizeof(text));
  CHECK(text[0] == 0);
}

int main(void) {
  RUN_TEST("the DESCRIBE lines are those of Sunshine: 85301245367 for 7.1 from the older host, 85301245673 from a fixed one",
           test_describe_lines_of_both_hosts);
  RUN_TEST("stereo, 5.1 and 7.1 in both qualities from both hosts are decoded with the mapping of the encoder",
           test_every_layout_is_decoded_with_the_mapping_of_the_encoder);
  RUN_TEST("only the 7.1 in normal quality of the older host is corrected, every other layout stays as it was parsed",
           test_only_the_71_in_normal_quality_of_the_older_host_is_corrected);
  RUN_TEST("layouts paired like GeForce Experience and layouts close to the faulty one are left alone",
           test_other_layouts_are_left_alone);
  RUN_TEST("the mapping is written for the log", test_mapping_text_for_the_log);
  return test_summary();
}
