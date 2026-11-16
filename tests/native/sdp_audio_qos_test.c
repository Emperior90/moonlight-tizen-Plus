// Checks the QoS that the app asks the host for (x-nv-vqos[0].qosTrafficType and x-nv-aqos.qosTrafficType of the SDP,
// moonlight-common-c/src/SdpGenerator.c, included directly with Misc.c for LiInitializeStreamConfiguration()):
//  - On the local network (STREAM_CFG_AUTO resolves to STREAM_CFG_LOCAL for a private address, Connection.c), the
//    library asks for video QoS 5 and audio QoS 4, as upstream does. The host then tags its video and audio sockets
//    with DSCP: Sunshine, Apollo, Vibepollo and Foundation Sunshine turn the tag of each socket on only for a value
//    other than 0 (enable_socket_qos() in their src/stream.cpp, with qWAVE on Windows and IP_TOS on Linux).
//  - The setting 'Prioritize sound on Wi-Fi' off (disableAudioQos of STREAM_CONFIGURATION, a local patch of Moonlight
//    Plus, set from the start request in StartStream() of wasm/main.cpp) asks for audio QoS 0 on the local network,
//    while the video keeps its QoS 5.
//  - A remote stream asks for no QoS at all, with the setting on or off, as before.
//  - LiInitializeStreamConfiguration() leaves the flag false, so a stream configuration of the library without it keeps
//    the QoS of upstream.
// The host is a Sunshine host (a negative fourth version number).

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

// The QoS types of one SDP: video, audio, and how often each attribute appears
typedef struct {
  char video[8];
  char audio[8];
  int videoCount;
  int audioCount;
} QOS_TYPES;

// The value of an attribute of the payload ("a=<name>:<value> \r\n") and how often it appears
static int attribute(const char* payload, const char* name, char* value, size_t valueSize) {
  char key[96];
  snprintf(key, sizeof(key), "a=%s:", name);
  value[0] = 0;
  int count = 0;
  for (const char* start = strstr(payload, key); start != NULL; start = strstr(start + 1, key)) {
    if (count++ == 0) {
      const char* text = start + strlen(key);
      size_t length = strcspn(text, " \r\n");
      if (length >= valueSize) {
        length = valueSize - 1;
      }
      memcpy(value, text, length);
      value[length] = 0;
    }
  }
  return count;
}

// The QoS types that the SDP asks for, for a stream on the local network or a remote one, with the flag of the setting
// (or a configuration as LiInitializeStreamConfiguration() leaves it when setFlag is false)
static QOS_TYPES qos(int streamingRemotely, bool setFlag, bool disableAudioQos) {
  QOS_TYPES types;
  memset(&types, 0, sizeof(types));
  LiInitializeStreamConfiguration(&StreamConfig);
  StreamConfig.width = 3840;
  StreamConfig.height = 2160;
  StreamConfig.fps = 60;
  StreamConfig.bitrate = 75000;
  StreamConfig.packetSize = 1392;
  StreamConfig.streamingRemotely = streamingRemotely;
  StreamConfig.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
  if (setFlag) {
    StreamConfig.disableAudioQos = disableAudioQos;
  }
  memset(&AudioCallbacks, 0, sizeof(AudioCallbacks));
  memset(&VideoCallbacks, 0, sizeof(VideoCallbacks));
  AppVersionQuad[0] = 7;
  AppVersionQuad[1] = 1;
  AppVersionQuad[2] = 431;
  AppVersionQuad[3] = -1;
  NegotiatedVideoFormat = VIDEO_FORMAT_H265;
  VideoPortNumber = 47998;
  RemoteAddr.ss_family = AF_INET;
  int length = 0;
  char* payload = getSdpPayloadForStreamConfig(13, &length);
  CHECK(payload != NULL && length > 0);
  if (payload != NULL) {
    payload[length] = 0;
    types.videoCount = attribute(payload, "x-nv-vqos[0].qosTrafficType", types.video, sizeof(types.video));
    types.audioCount = attribute(payload, "x-nv-aqos.qosTrafficType", types.audio, sizeof(types.audio));
    free(payload);
  }
  return types;
}

static void expect(QOS_TYPES types, const char* video, const char* audio) {
  if (strcmp(types.video, video) != 0 || strcmp(types.audio, audio) != 0) {
    printf("  # video QoS %s (%d times), audio QoS %s (%d times)\n", types.video, types.videoCount, types.audio,
           types.audioCount);
  }
  CHECK(strcmp(types.video, video) == 0);
  CHECK(strcmp(types.audio, audio) == 0);
  // Each attribute once, so that the host can't read a second value
  CHECK_EQ_INT(types.videoCount, 1);
  CHECK_EQ_INT(types.audioCount, 1);
}

static void test_a_local_stream_asks_for_the_qos_of_video_and_audio_by_default(void) {
  // As LiInitializeStreamConfiguration() leaves it, and with the setting on (the default)
  expect(qos(STREAM_CFG_LOCAL, false, false), "5", "4");
  expect(qos(STREAM_CFG_LOCAL, true, false), "5", "4");
}

static void test_the_setting_off_sends_the_audio_without_qos_and_keeps_the_video_qos(void) {
  expect(qos(STREAM_CFG_LOCAL, true, true), "5", "0");
  // The next stream with the setting on again asks for the audio QoS again
  expect(qos(STREAM_CFG_LOCAL, true, false), "5", "4");
}

static void test_a_remote_stream_asks_for_no_qos_either_way(void) {
  expect(qos(STREAM_CFG_REMOTE, false, false), "0", "0");
  expect(qos(STREAM_CFG_REMOTE, true, false), "0", "0");
  expect(qos(STREAM_CFG_REMOTE, true, true), "0", "0");
}

int main(void) {
  RUN_TEST("a local stream asks for the QoS of video (5) and audio (4) by default",
           test_a_local_stream_asks_for_the_qos_of_video_and_audio_by_default);
  RUN_TEST("the setting off sends the audio without QoS (0) and keeps the video QoS (5)",
           test_the_setting_off_sends_the_audio_without_qos_and_keeps_the_video_qos);
  RUN_TEST("a remote stream asks for no QoS, with the setting on or off", test_a_remote_stream_asks_for_no_qos_either_way);
  return test_summary();
}
