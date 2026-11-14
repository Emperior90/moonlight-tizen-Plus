// Checks the audio stream that the app asks the host for, with the capabilities of its audio renderer
// (GetAudioRendererCapabilities() of wasm/audio_capabilities.hpp, which ConnectionThreadFunc() in wasm/main.cpp uses) and
// the SDP negotiation of moonlight-common-c (moonlight-common-c/src/SdpGenerator.c, included directly):
//  - 'Surround audio quality' High, the default, keeps what earlier versions asked for: 5.1 and 7.1 in the high quality
//    of the host from a video bitrate of 15 Mbps on, in 5 ms packets, and the normal quality below it.
//  - Efficient asks for the normal quality of 5.1 and 7.1 in 10 ms packets at every bitrate.
//  - Stereo never declares the decoder slow, whatever the setting, so it keeps its 5 ms packets and the request that
//    Sunshine answers with its high quality stereo: the flag would also make the RTSP request of RtspConnection.c
//    name the host 0.0.0.0, which Sunshine reads as a request for its stereo of 96 kbps
//    (tests/unit/surround-quality.test.js pins that condition of RtspConnection.c, which needs a network connection).
//  - The Web Audio backend keeps its 10 ms packets below 5 Mbps.
// The host is a Sunshine host (a negative fourth version number) on the local network that offers high quality
// surround, as Sunshine does.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/SdpGenerator.c"
#include "../../wasm/audio_capabilities.hpp"

#include <stdlib.h>
#include <string.h>

// What the other files of moonlight-common-c provide (the listener takes the log lines in the release build, LC_LOG;
// this test sets none)
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
struct sockaddr_storage RemoteAddr;
int AppVersionQuad[4];
STREAM_CONFIGURATION StreamConfig;
DECODER_RENDERER_CALLBACKS VideoCallbacks;
AUDIO_RENDERER_CALLBACKS AudioCallbacks;
int NegotiatedVideoFormat;
bool HighQualitySurroundSupported;
bool HighQualitySurroundEnabled;
int AudioPacketDuration;
bool AudioEncryptionEnabled;
uint16_t RtspPortNumber;
uint16_t VideoPortNumber;
uint32_t SunshineFeatureFlags;
uint32_t EncryptionFeaturesSupported;
uint32_t EncryptionFeaturesRequested;
uint32_t EncryptionFeaturesEnabled;

bool PltSafeStrcpy(char* dest, size_t dest_size, const char* src) {
  if (strlen(src) >= dest_size) {
    dest[0] = 0;
    return false;
  }
  strcpy(dest, src);
  return true;
}
bool isReferenceFrameInvalidationEnabled(void) {
  return false;
}
void addrToUrlSafeString(struct sockaddr_storage* addr, char* string, size_t stringLength) {
  (void)addr;
  snprintf(string, stringLength, "10.0.0.2");
}

// The SDP payload for a stream with the given audio configuration, video bitrate in kbps and capabilities
static char* negotiate(int audioConfiguration, int bitrateKbps, int capabilities) {
  memset(&StreamConfig, 0, sizeof(StreamConfig));
  StreamConfig.width = 3840;
  StreamConfig.height = 2160;
  StreamConfig.fps = 60;
  StreamConfig.bitrate = bitrateKbps;
  StreamConfig.packetSize = 1392;
  StreamConfig.streamingRemotely = STREAM_CFG_LOCAL;
  StreamConfig.audioConfiguration = audioConfiguration;
  memset(&AudioCallbacks, 0, sizeof(AudioCallbacks));
  AudioCallbacks.capabilities = capabilities;
  memset(&VideoCallbacks, 0, sizeof(VideoCallbacks));
  AppVersionQuad[0] = 7;
  AppVersionQuad[1] = 1;
  AppVersionQuad[2] = 431;
  AppVersionQuad[3] = -1;
  NegotiatedVideoFormat = VIDEO_FORMAT_H265;
  HighQualitySurroundSupported = true;
  HighQualitySurroundEnabled = false;
  AudioPacketDuration = 0;
  VideoPortNumber = 47998;
  RemoteAddr.ss_family = AF_INET;
  int length = 0;
  char* payload = getSdpPayloadForStreamConfig(13, &length);
  CHECK(payload != NULL && length > 0);
  if (payload != NULL) {
    payload[length] = 0;
  }
  return payload;
}

// The value of an attribute of the payload ("a=<name>:<value> \r\n"), or "" when it isn't there
static const char* attribute(const char* payload, const char* name) {
  static char value[64];
  value[0] = 0;
  char key[96];
  snprintf(key, sizeof(key), "a=%s:", name);
  const char* start = payload != NULL ? strstr(payload, key) : NULL;
  if (start != NULL) {
    start += strlen(key);
    size_t length = strcspn(start, " \r\n");
    if (length >= sizeof(value)) {
      length = sizeof(value) - 1;
    }
    memcpy(value, start, length);
    value[length] = 0;
  }
  return value;
}

// Negotiate and check the quality attribute, the packet duration and what moonlight-common-c remembers of them
static void expect(int audioConfiguration, int bitrateKbps, bool webAudio, bool efficient, const char* quality,
                   int packetMs) {
  const int capabilities = GetAudioRendererCapabilities(webAudio, efficient, audioConfiguration);
  char* payload = negotiate(audioConfiguration, bitrateKbps, capabilities);
  if (strcmp(attribute(payload, "x-nv-audio.surround.AudioQuality"), quality) != 0 || AudioPacketDuration != packetMs) {
    printf("  # %d channels at %d kbps, %s, %s: AudioQuality %s, %d ms packets\n",
           CHANNEL_COUNT_FROM_AUDIO_CONFIGURATION(audioConfiguration), bitrateKbps, webAudio ? "Web Audio" : "EMSS",
           efficient ? "Efficient" : "High", attribute(payload, "x-nv-audio.surround.AudioQuality"), AudioPacketDuration);
  }
  CHECK(strcmp(attribute(payload, "x-nv-audio.surround.AudioQuality"), quality) == 0);
  CHECK_EQ_INT(AudioPacketDuration, packetMs);
  char packetDuration[8];
  snprintf(packetDuration, sizeof(packetDuration), "%d", packetMs);
  CHECK(strcmp(attribute(payload, "x-nv-aqos.packetDuration"), packetDuration) == 0);
  CHECK(HighQualitySurroundEnabled == (strcmp(quality, "1") == 0));
  free(payload);
}

static void test_high_keeps_the_high_quality_of_surround(void) {
  expect(AUDIO_CONFIGURATION_51_SURROUND, 75000, false, false, "1", 5);
  expect(AUDIO_CONFIGURATION_71_SURROUND, 75000, false, false, "1", 5);
  expect(AUDIO_CONFIGURATION_51_SURROUND, 15000, false, false, "1", 5);
  // Below 15 Mbps the host sends its normal quality anyway
  expect(AUDIO_CONFIGURATION_51_SURROUND, 14000, false, false, "0", 5);
}

static void test_efficient_asks_for_the_normal_quality_in_10_ms_packets(void) {
  expect(AUDIO_CONFIGURATION_51_SURROUND, 75000, false, true, "0", 10);
  expect(AUDIO_CONFIGURATION_71_SURROUND, 75000, false, true, "0", 10);
  expect(AUDIO_CONFIGURATION_51_SURROUND, 250000, false, true, "0", 10);
  expect(AUDIO_CONFIGURATION_51_SURROUND, 14000, false, true, "0", 10);
  // The same with the Web Audio backend and with the audio output disabled, which negotiates like EMSS
  expect(AUDIO_CONFIGURATION_51_SURROUND, 75000, true, true, "0", 10);
  CHECK_EQ_INT(GetAudioRendererCapabilities(false, true, AUDIO_CONFIGURATION_71_SURROUND),
               CAPABILITY_DIRECT_SUBMIT | CAPABILITY_SLOW_OPUS_DECODER);
}

static void test_stereo_never_declares_a_slow_decoder(void) {
  CHECK_EQ_INT(GetAudioRendererCapabilities(false, true, AUDIO_CONFIGURATION_STEREO), CAPABILITY_DIRECT_SUBMIT);
  CHECK_EQ_INT(GetAudioRendererCapabilities(true, true, AUDIO_CONFIGURATION_STEREO),
               CAPABILITY_DIRECT_SUBMIT | CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION);
  expect(AUDIO_CONFIGURATION_STEREO, 75000, false, true, "0", 5);
  expect(AUDIO_CONFIGURATION_STEREO, 75000, false, false, "0", 5);
  // The RTSP request of RtspConnection.c names the host 0.0.0.0, which Sunshine reads as a request for its low quality
  // stereo, only for a decoder that declares itself slow (or a remote surround stream)
  CHECK((GetAudioRendererCapabilities(false, true, AUDIO_CONFIGURATION_STEREO) & CAPABILITY_SLOW_OPUS_DECODER) == 0);
}

static void test_web_audio_keeps_its_10_ms_packets_below_5_mbps(void) {
  expect(AUDIO_CONFIGURATION_STEREO, 4000, true, false, "0", 10);
  expect(AUDIO_CONFIGURATION_STEREO, 4000, false, false, "0", 5);
  expect(AUDIO_CONFIGURATION_STEREO, 75000, true, false, "0", 5);
  expect(AUDIO_CONFIGURATION_51_SURROUND, 75000, true, false, "1", 5);
}

int main(void) {
  RUN_TEST("High keeps the high quality of 5.1 and 7.1 from 15 Mbps on, in 5 ms packets",
           test_high_keeps_the_high_quality_of_surround);
  RUN_TEST("Efficient asks for the normal quality of 5.1 and 7.1 in 10 ms packets",
           test_efficient_asks_for_the_normal_quality_in_10_ms_packets);
  RUN_TEST("stereo never declares a slow decoder", test_stereo_never_declares_a_slow_decoder);
  RUN_TEST("the Web Audio backend keeps its 10 ms packets below 5 Mbps", test_web_audio_keeps_its_10_ms_packets_below_5_mbps);
  return test_summary();
}
