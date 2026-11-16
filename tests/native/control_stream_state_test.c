// Checks the state of the control stream of moonlight-common-c (moonlight-common-c/src/ControlStream.c, included
// directly) that other threads read or hand over, with the fixes of upstream that Moonlight Plus ported by hand in 2.3.1:
//  - 74a61b9: the HDR metadata of the host is written under a mutex on the control receive thread, and
//    LiGetHdrMetadata() copies it under the same mutex. The decoder thread reads it for every keyframe while 'HDR
//    static metadata' is on (wasm/wasmplayer.cpp), and Sunshine sends the HDR mode message each time it creates an
//    encoder, which is when the keyframe of that encoder arrives, so a copy during an update could mix the values of
//    the old and the new message (or zeros, since the update starts by clearing the metadata).
//  - 348d5d1: an RFI range and an FEC status report queued after the stop shut their queues down are freed.
// The HDR check runs the real control receive thread over ENet on the loopback interface (like
// control_stream_disconnect_test.c) and catches it in the middle of an update: every BbGet16() of ControlStream.c goes
// through a hook, which lets a reader thread call LiGetHdrMetadata() in the middle of the metadata and waits up to
// 200 ms for its copy. With the mutex the reader waits until the update is complete and then gets the new metadata; without
// it, it copies at once and gets half of it.

// The control stream and the socket code of moonlight-common-c need the GNU extensions of the C library (in6_pktinfo)
#define _GNU_SOURCE

#include "test_support_c.h"

#include "../../moonlight-common-c/src/Limelight-internal.h"

#include <arpa/inet.h>
#include <pthread.h>
#include <string.h>
#include <time.h>

// The allocations of ControlStream.c less its frees, so that an entry it loses shows up
static long controlStreamAllocations;
static void* TestMalloc(size_t size) {
  controlStreamAllocations++;
  return malloc(size);
}
static void TestFree(void* pointer) {
  if (pointer != NULL) {
    controlStreamAllocations--;
  }
  free(pointer);
}
static bool HookedBbGet16(PBYTE_BUFFER buff, uint16_t* s);
#define malloc(size) TestMalloc(size)
#define free(pointer) TestFree(pointer)
#define BbGet16(buff, s) HookedBbGet16(buff, s)
#include "../../moonlight-common-c/src/ControlStream.c"
#undef malloc
#undef free
#undef BbGet16

#include "../../moonlight-common-c/src/ByteBuffer.c"
#include "../../moonlight-common-c/src/LinkedBlockingQueue.c"
#include "../../moonlight-common-c/src/Misc.c"
#include "../../moonlight-common-c/src/Platform.c"
#include "../../moonlight-common-c/src/PlatformSockets.c"
#include "../../moonlight-common-c/enet/callbacks.c"
#include "../../moonlight-common-c/enet/compress.c"
#include "../../moonlight-common-c/enet/host.c"
#include "../../moonlight-common-c/enet/list.c"
#include "../../moonlight-common-c/enet/packet.c"
#include "../../moonlight-common-c/enet/peer.c"
#include "../../moonlight-common-c/enet/protocol.c"
#include "../../moonlight-common-c/enet/unix.c"

// What the other files of moonlight-common-c provide (Connection.c, VideoStream.c); the test never starts a connection
struct sockaddr_storage RemoteAddr;
struct sockaddr_storage LocalAddr;
SOCKADDR_LEN AddrLen;
int AppVersionQuad[4];
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
DECODER_RENDERER_CALLBACKS VideoCallbacks;
int NegotiatedVideoFormat;
volatile bool ConnectionInterrupted;
bool ReferenceFrameInvalidationSupported;
uint16_t ControlPortNumber;
uint32_t ControlConnectData;
uint32_t SunshineFeatureFlags;
uint32_t EncryptionFeaturesEnabled;

// The encryption of the control stream (PlatformCrypto.c needs OpenSSL), which the test never uses: the host version
// below is one without the encrypted control stream
PPLT_CRYPTO_CONTEXT PltCreateCryptoContext(void) {
  return NULL;
}
void PltDestroyCryptoContext(PPLT_CRYPTO_CONTEXT ctx) {
  (void)ctx;
}
bool PltEncryptMessage(PPLT_CRYPTO_CONTEXT ctx, int algorithm, int flags, unsigned char* key, int keyLength,
                       unsigned char* iv, int ivLength, unsigned char* tag, int tagLength, unsigned char* inputData,
                       int inputDataLength, unsigned char* outputData, int* outputDataLength) {
  (void)ctx, (void)algorithm, (void)flags, (void)key, (void)keyLength, (void)iv, (void)ivLength, (void)tag;
  (void)tagLength, (void)inputData, (void)inputDataLength, (void)outputData, (void)outputDataLength;
  return false;
}
bool PltDecryptMessage(PPLT_CRYPTO_CONTEXT ctx, int algorithm, int flags, unsigned char* key, int keyLength,
                       unsigned char* iv, int ivLength, unsigned char* tag, int tagLength, unsigned char* inputData,
                       int inputDataLength, unsigned char* outputData, int* outputDataLength) {
  (void)ctx, (void)algorithm, (void)flags, (void)key, (void)keyLength, (void)iv, (void)ivLength, (void)tag;
  (void)tagLength, (void)inputData, (void)inputDataLength, (void)outputData, (void)outputDataLength;
  return false;
}

// A Sunshine host (the negative fourth number) with the unencrypted control stream of 7.1.415
static void startControlStreamState(void) {
  AppVersionQuad[0] = 7;
  AppVersionQuad[1] = 1;
  AppVersionQuad[2] = 415;
  AppVersionQuad[3] = -1;
  memset(&ListenerCallbacks, 0, sizeof(ListenerCallbacks));
  CHECK_EQ_INT(initializeControlStream(), 0);
}

// The end of the control stream as stopControlStream() starts it: its queues are shut down
static void shutDownQueues(void) {
  stopping = true;
  LbqSignalQueueShutdown(&invalidReferenceFrameTuples);
  LbqSignalQueueShutdown(&frameFecStatusQueue);
  LbqSignalQueueDrain(&asyncCallbackQueue);
}

// ---- The HDR metadata ----

// The reader on the decoder thread, which copies the metadata when the hook asks it to
static pthread_mutex_t readerMutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t readerCond = PTHREAD_COND_INITIALIZER;
static bool readerGo;
static bool readerDone;
static bool readerGotMetadata;
static SS_HDR_METADATA readerMetadata;

static void* readerThreadFunc(void* context) {
  (void)context;
  pthread_mutex_lock(&readerMutex);
  while (!readerGo) {
    pthread_cond_wait(&readerCond, &readerMutex);
  }
  pthread_mutex_unlock(&readerMutex);
  SS_HDR_METADATA metadata;
  const bool got = LiGetHdrMetadata(&metadata);
  pthread_mutex_lock(&readerMutex);
  readerGotMetadata = got;
  readerMetadata = metadata;
  readerDone = true;
  pthread_cond_broadcast(&readerCond);
  pthread_mutex_unlock(&readerMutex);
  return NULL;
}

// Wait up to `ms` milliseconds for the reader to finish; returns whether it did
static bool waitForReader(int ms) {
  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += ms / 1000;
  deadline.tv_nsec += (long)(ms % 1000) * 1000 * 1000;
  if (deadline.tv_nsec >= 1000 * 1000 * 1000) {
    deadline.tv_sec++;
    deadline.tv_nsec -= 1000 * 1000 * 1000;
  }
  pthread_mutex_lock(&readerMutex);
  while (!readerDone) {
    if (pthread_cond_timedwait(&readerCond, &readerMutex, &deadline) != 0) {
      break;
    }
  }
  const bool done = readerDone;
  pthread_mutex_unlock(&readerMutex);
  return done;
}

// The hook of BbGet16() in ControlStream.c: once armed, its fifth call, in the middle of the display primaries of an HDR
// mode message, lets the reader copy the metadata and gives it 200 ms
static bool hookArmed;
static int hookCalls;
static bool readerDoneDuringUpdate;

static bool HookedBbGet16(PBYTE_BUFFER buff, uint16_t* s) {
  if (hookArmed && ++hookCalls == 5) {
    hookArmed = false;
    pthread_mutex_lock(&readerMutex);
    readerGo = true;
    pthread_cond_broadcast(&readerCond);
    pthread_mutex_unlock(&readerMutex);
    readerDoneDuringUpdate = waitForReader(200);
  }
  return BbGet16(buff, s);
}

// The 13 values of an HDR mode message of Sunshine, in the order of the message: base + 0 to base + 12
static void expectedMetadata(SS_HDR_METADATA* metadata, uint16_t base) {
  memset(metadata, 0, sizeof(*metadata));
  for (int i = 0; i < 3; i++) {
    metadata->displayPrimaries[i].x = (uint16_t)(base + 2 * i);
    metadata->displayPrimaries[i].y = (uint16_t)(base + 2 * i + 1);
  }
  metadata->whitePoint.x = (uint16_t)(base + 6);
  metadata->whitePoint.y = (uint16_t)(base + 7);
  metadata->maxDisplayLuminance = (uint16_t)(base + 8);
  metadata->minDisplayLuminance = (uint16_t)(base + 9);
  metadata->maxContentLightLevel = (uint16_t)(base + 10);
  metadata->maxFrameAverageLightLevel = (uint16_t)(base + 11);
  metadata->maxFullFrameLuminance = (uint16_t)(base + 12);
}

static bool sameMetadata(const SS_HDR_METADATA* a, const SS_HDR_METADATA* b) {
  return memcmp(a, b, sizeof(*a)) == 0;
}

// A host of the PC and a client of the TV, connected over the loopback interface, with the peer of the client as the
// peer of the control stream
static ENetHost* pcHost;
static ENetPeer* pcPeer;

static bool connectHosts(void) {
  struct sockaddr_in loopback;
  ENetAddress bindAddress, pcAddress;
  ENetEvent event;
  bool clientConnected = false;
  int i;

  memset(&loopback, 0, sizeof(loopback));
  loopback.sin_family = AF_INET;
  loopback.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  enet_address_set_address(&bindAddress, (struct sockaddr*)&loopback, sizeof(loopback));
  enet_address_set_port(&bindAddress, 0);

  pcHost = enet_host_create(AF_INET, &bindAddress, 1, CTRL_CHANNEL_COUNT, 0, 0);
  client = enet_host_create(AF_INET, &bindAddress, 1, CTRL_CHANNEL_COUNT, 0, 0);
  CHECK(pcHost != NULL);
  CHECK(client != NULL);
  if (pcHost == NULL || client == NULL) {
    return false;
  }
  pcPeer = NULL;
  enet_socket_get_address(pcHost->socket, &pcAddress);
  peer = enet_host_connect(client, &pcAddress, CTRL_CHANNEL_COUNT, 0);
  CHECK(peer != NULL);
  for (i = 0; i < 200 && !(clientConnected && pcPeer != NULL && peer->state == ENET_PEER_STATE_CONNECTED); i++) {
    while (enet_host_service(pcHost, &event, 1) > 0) {
      if (event.type == ENET_EVENT_TYPE_CONNECT) {
        pcPeer = event.peer;
      }
    }
    while (enet_host_service(client, &event, 1) > 0) {
      if (event.type == ENET_EVENT_TYPE_CONNECT) {
        clientConnected = true;
      }
    }
  }
  CHECK(clientConnected);
  CHECK(pcPeer != NULL);
  return clientConnected && pcPeer != NULL;
}

static void closeHosts(void) {
  if (client != NULL) {
    enet_host_destroy(client);
    client = NULL;
  }
  if (pcHost != NULL) {
    enet_host_destroy(pcHost);
    pcHost = NULL;
  }
  peer = NULL;
  pcPeer = NULL;
}

// Send an HDR mode message of Sunshine from the PC: the type, HDR on, then the 13 values from `base` on
static void sendHdrMode(uint16_t base) {
  uint8_t message[2 + 1 + 13 * 2];
  size_t length = 0;
  const uint16_t type = 0x010e;
  message[length++] = (uint8_t)(type & 0xFF);
  message[length++] = (uint8_t)(type >> 8);
  message[length++] = 1;
  for (int i = 0; i < 13; i++) {
    const uint16_t value = (uint16_t)(base + i);
    message[length++] = (uint8_t)(value & 0xFF);
    message[length++] = (uint8_t)(value >> 8);
  }
  ENetPacket* packet = enet_packet_create(message, length, ENET_PACKET_FLAG_RELIABLE);
  CHECK(enet_peer_send(pcPeer, 0, packet) == 0);
  enet_host_flush(pcHost);
}

// Wait up to 2 seconds until the metadata of the given message is in place, servicing the PC meanwhile
static bool waitForMetadata(uint16_t base) {
  SS_HDR_METADATA expected, metadata;
  ENetEvent event;
  expectedMetadata(&expected, base);
  for (int i = 0; i < 2000; i++) {
    if (LiGetHdrMetadata(&metadata) && sameMetadata(&metadata, &expected)) {
      return true;
    }
    while (enet_host_service(pcHost, &event, 1) > 0) {
      if (event.type == ENET_EVENT_TYPE_RECEIVE) {
        enet_packet_destroy(event.packet);
      }
    }
  }
  return false;
}

static void HdrMetadataReadDuringAnUpdateIsNeverAMix(void) {
  pthread_t reader;
  SS_HDR_METADATA newMetadata;
  startControlStreamState();
  CHECK(!LiGetCurrentHostDisplayHdrMode());
  if (!connectHosts()) {
    closeHosts();
    return;
  }
  CHECK_EQ_INT(PltCreateThread("ControlRecv", controlReceiveThreadFunc, NULL, &controlReceiveThread), 0);

  // The first HDR mode message of the stream
  sendHdrMode(1000);
  CHECK(waitForMetadata(1000));
  CHECK(LiGetCurrentHostDisplayHdrMode());

  // The next one, from a new encoder of the host, with the reader copying in its middle
  readerGo = false;
  readerDone = false;
  readerDoneDuringUpdate = false;
  hookCalls = 0;
  CHECK(pthread_create(&reader, NULL, readerThreadFunc, NULL) == 0);
  hookArmed = true;
  sendHdrMode(2000);
  CHECK(waitForMetadata(2000));
  CHECK(waitForReader(2000));
  CHECK(pthread_join(reader, NULL) == 0);
  CHECK(!hookArmed);
  // The reader waited for the update and got the new metadata whole
  CHECK(!readerDoneDuringUpdate);
  CHECK(readerGotMetadata);
  expectedMetadata(&newMetadata, 2000);
  CHECK(sameMetadata(&readerMetadata, &newMetadata));

  PltInterruptThread(&controlReceiveThread);
  PltJoinThread(&controlReceiveThread);
  closeHosts();
  shutDownQueues();
  destroyControlStream();
}

static void WithoutHdrNoMetadataIsHandedOut(void) {
  SS_HDR_METADATA metadata;
  startControlStreamState();
  CHECK(!LiGetHdrMetadata(&metadata));
  CHECK(!LiGetCurrentHostDisplayHdrMode());
  shutDownQueues();
  destroyControlStream();
}

// ---- The queues at a stop ----

static void AnRfiRangeAndAnFecStatusQueuedAtAStopAreFreed(void) {
  SS_FRAME_FEC_STATUS fecStatus;
  startControlStreamState();
  // Reference frame invalidation for HEVC, offered by the host and taken by the decoder
  ReferenceFrameInvalidationSupported = true;
  NegotiatedVideoFormat = VIDEO_FORMAT_H265;
  VideoCallbacks.capabilities = CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC;
  CHECK(isReferenceFrameInvalidationEnabled());
  shutDownQueues();

  const long before = controlStreamAllocations;
  connectionDetectedFrameLoss(10, 12);
  CHECK_EQ_INT(controlStreamAllocations, before);
  memset(&fecStatus, 0, sizeof(fecStatus));
  connectionSendFrameFecStatus(&fecStatus);
  CHECK_EQ_INT(controlStreamAllocations, before);

  ReferenceFrameInvalidationSupported = false;
  NegotiatedVideoFormat = 0;
  VideoCallbacks.capabilities = 0;
  destroyControlStream();
}

int main(void) {
  CHECK_EQ_INT(enet_initialize(), 0);
  RUN_TEST("HDR metadata read during an update is never a mix of the old and the new",
           HdrMetadataReadDuringAnUpdateIsNeverAMix);
  RUN_TEST("without HDR mode no metadata is handed out", WithoutHdrNoMetadataIsHandedOut);
  RUN_TEST("an RFI range and an FEC status queued at a stop are freed", AnRfiRangeAndAnFecStatusQueuedAtAStopAreFreed);
  enet_deinitialize();
  return test_summary();
}
