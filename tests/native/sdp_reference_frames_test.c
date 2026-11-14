// Checks the number of reference frames that the app allows the host (x-nv-video[0].maxNumReferenceFrames of the SDP,
// moonlight-common-c/src/SdpGenerator.c, included directly with the functions of Misc.c that it asks), and what the
// app learns of the host for the report of the session (LiHostSupportsReferenceFrameInvalidation()):
//  - With the setting 'Reference frame invalidation' on, the decoder callbacks of the app declare it for HEVC and AV1
//    (ConnectionThreadFunc() in wasm/main.cpp). The host is then free to pick its number of reference frames (0) only
//    when it offered reference frame invalidation in its answer to DESCRIBE, which RtspConnection.c keeps in
//    ReferenceFrameInvalidationSupported before the SDP is made: GeForce Experience, and Sunshine with its NVENC
//    encoder.
//  - A host that didn't offer it (Sunshine with an AMD or Intel encoder, or software encoding) answers every
//    invalidation with a keyframe, so the setting can't recover anything there. It gets the limit of one reference
//    frame, like with the setting off: the setting changes nothing on such a host. This is a local patch: upstream
//    sends 0 whenever the decoder declares the capability, and those encoders of Sunshine then drop their limit of one
//    reference frame (tests/unit/host-rfi.test.js pins the patch and the places that use it).
//  - With the setting off, and for H.264, which the app never declares, the limit is one reference frame as before.
// The host is a Sunshine host (a negative fourth version number) on the local network.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/SdpGenerator.c"
#include "../../moonlight-common-c/src/Misc.c"

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
volatile bool ConnectionInterrupted;
bool ReferenceFrameInvalidationSupported;
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
void addrToUrlSafeString(struct sockaddr_storage* addr, char* string, size_t stringLength) {
  (void)addr;
  snprintf(string, stringLength, "10.0.0.2");
}
// The ENet and clock functions that the other functions of Misc.c call, which this test never runs
int enet_host_service(ENetHost* host, ENetEvent* event, enet_uint32 timeout) {
  (void)host, (void)event, (void)timeout;
  return -1;
}
void enet_peer_disconnect_later(ENetPeer* peer, enet_uint32 data) {
  (void)peer, (void)data;
}
void enet_peer_disconnect_now(ENetPeer* peer, enet_uint32 data) {
  (void)peer, (void)data;
}
void enet_packet_destroy(ENetPacket* packet) {
  (void)packet;
}
uint64_t PltGetMillis(void) {
  return 0;
}

// The capabilities that the decoder callbacks of the app declare with the setting on (wasm/main.cpp)
#define SETTING_ON (CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC | CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1)
#define SETTING_OFF 0

// The SDP for a stream in the given video format, with the capabilities of the decoder and what the host offered in
// its answer to DESCRIBE, or NULL
static char* sdp(int videoFormat, int capabilities, bool hostOffersRfi) {
  memset(&StreamConfig, 0, sizeof(StreamConfig));
  StreamConfig.width = 3840;
  StreamConfig.height = 2160;
  StreamConfig.fps = 60;
  StreamConfig.bitrate = 75000;
  StreamConfig.packetSize = 1392;
  StreamConfig.streamingRemotely = STREAM_CFG_LOCAL;
  StreamConfig.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
  memset(&AudioCallbacks, 0, sizeof(AudioCallbacks));
  memset(&VideoCallbacks, 0, sizeof(VideoCallbacks));
  VideoCallbacks.capabilities = capabilities;
  AppVersionQuad[0] = 7;
  AppVersionQuad[1] = 1;
  AppVersionQuad[2] = 431;
  AppVersionQuad[3] = -1;
  NegotiatedVideoFormat = videoFormat;
  ReferenceFrameInvalidationSupported = hostOffersRfi;
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

// The value of x-nv-video[0].maxNumReferenceFrames in that SDP
static const char* referenceFrames(int videoFormat, int capabilities, bool hostOffersRfi) {
  static char value[16];
  value[0] = 0;
  char* payload = sdp(videoFormat, capabilities, hostOffersRfi);
  if (payload == NULL) {
    return value;
  }
  const char* key = "a=x-nv-video[0].maxNumReferenceFrames:";
  const char* start = strstr(payload, key);
  CHECK(start != NULL);
  if (start != NULL) {
    start += strlen(key);
    size_t valueLength = strcspn(start, " \r\n");
    if (valueLength >= sizeof(value)) {
      valueLength = sizeof(value) - 1;
    }
    memcpy(value, start, valueLength);
    value[valueLength] = 0;
    // The attribute is sent once
    CHECK(strstr(start, key) == NULL);
  }
  free(payload);
  return value;
}

static void expect(int videoFormat, int capabilities, bool hostOffersRfi, const char* expected) {
  const char* value = referenceFrames(videoFormat, capabilities, hostOffersRfi);
  if (strcmp(value, expected) != 0) {
    printf("  # format 0x%x, capabilities 0x%x, host %s: maxNumReferenceFrames %s, expected %s\n", videoFormat,
           capabilities, hostOffersRfi ? "offers it" : "doesn't offer it", value, expected);
  }
  CHECK(strcmp(value, expected) == 0);
}

static void test_a_host_that_offers_it_picks_its_reference_frames(void) {
  expect(VIDEO_FORMAT_H265, SETTING_ON, true, "0");
  expect(VIDEO_FORMAT_H265_MAIN10, SETTING_ON, true, "0");
  expect(VIDEO_FORMAT_AV1_MAIN8, SETTING_ON, true, "0");
  expect(VIDEO_FORMAT_AV1_MAIN10, SETTING_ON, true, "0");
  CHECK(isReferenceFrameInvalidationEnabled());
}

static void test_a_host_that_does_not_offer_it_keeps_one_reference_frame(void) {
  expect(VIDEO_FORMAT_H265, SETTING_ON, false, "1");
  expect(VIDEO_FORMAT_H265_MAIN10, SETTING_ON, false, "1");
  expect(VIDEO_FORMAT_AV1_MAIN8, SETTING_ON, false, "1");
  expect(VIDEO_FORMAT_AV1_MAIN10, SETTING_ON, false, "1");
  // The decoder would support it, but nothing uses it
  CHECK(isReferenceFrameInvalidationSupportedByDecoder());
  CHECK(!isReferenceFrameInvalidationEnabled());
}

static void test_the_setting_changes_nothing_on_a_host_that_does_not_offer_it(void) {
  const int formats[] = { VIDEO_FORMAT_H264, VIDEO_FORMAT_H265, VIDEO_FORMAT_H265_MAIN10, VIDEO_FORMAT_AV1_MAIN8,
                          VIDEO_FORMAT_AV1_MAIN10 };
  for (size_t i = 0; i < sizeof(formats) / sizeof(formats[0]); i++) {
    // The whole SDP is the same with the setting on and off
    char* off = sdp(formats[i], SETTING_OFF, false);
    char* on = sdp(formats[i], SETTING_ON, false);
    CHECK(off != NULL && on != NULL && strcmp(on, off) == 0);
    free(off);
    free(on);
    // On a host that offers it, the setting does change the SDP for HEVC and AV1
    off = sdp(formats[i], SETTING_OFF, true);
    on = sdp(formats[i], SETTING_ON, true);
    CHECK(off != NULL && on != NULL && (strcmp(on, off) != 0) == (formats[i] != VIDEO_FORMAT_H264));
    free(off);
    free(on);
  }
}

static void test_without_the_setting_and_for_h264_one_reference_frame(void) {
  expect(VIDEO_FORMAT_H265, SETTING_OFF, true, "1");
  expect(VIDEO_FORMAT_AV1_MAIN10, SETTING_OFF, true, "1");
  expect(VIDEO_FORMAT_H265, SETTING_OFF, false, "1");
  // The app declares the capability for HEVC and AV1 only
  expect(VIDEO_FORMAT_H264, SETTING_ON, true, "1");
  expect(VIDEO_FORMAT_H264, SETTING_ON, false, "1");
}

static void test_the_report_gets_what_the_host_offered(void) {
  // Whatever the decoder declares and whatever the video format is
  referenceFrames(VIDEO_FORMAT_H265, SETTING_OFF, true);
  CHECK(LiHostSupportsReferenceFrameInvalidation());
  referenceFrames(VIDEO_FORMAT_H264, SETTING_ON, true);
  CHECK(LiHostSupportsReferenceFrameInvalidation());
  referenceFrames(VIDEO_FORMAT_H265, SETTING_ON, false);
  CHECK(!LiHostSupportsReferenceFrameInvalidation());
  referenceFrames(VIDEO_FORMAT_AV1_MAIN10, SETTING_OFF, false);
  CHECK(!LiHostSupportsReferenceFrameInvalidation());
}

int main(void) {
  RUN_TEST("with the setting on, a host that offers reference frame invalidation picks its reference frames",
           test_a_host_that_offers_it_picks_its_reference_frames);
  RUN_TEST("with the setting on, a host that doesn't offer it keeps the limit of one reference frame",
           test_a_host_that_does_not_offer_it_keeps_one_reference_frame);
  RUN_TEST("the setting changes nothing in the SDP for a host that doesn't offer it",
           test_the_setting_changes_nothing_on_a_host_that_does_not_offer_it);
  RUN_TEST("without the setting, and for H.264, the limit is one reference frame",
           test_without_the_setting_and_for_h264_one_reference_frame);
  RUN_TEST("the report of the session gets what the host offered", test_the_report_gets_what_the_host_offered);
  return test_summary();
}
