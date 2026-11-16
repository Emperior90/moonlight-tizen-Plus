// Checks the limit of the IDR frame requests while an IDR frame is already on its way, a change of Moonlight Plus to
// the vendored moonlight-common-c in 2.3.1 (moonlight-common-c/src/IdrRequestLimit.h and its use in ControlStream.c).
// Every LiRequestIdrFrame() used to send a request to the host, and Sunshine encodes a keyframe for each one, so the
// requests of a loss episode a frame apart brought one large keyframe each (moonlight-tv issue #639: about 30 per
// second). Now a request is held while the IDR frame of a request sent less than a window ago is on its way: an IDR
// frame that arrives answers it and ends the hold at once, and when the window ends without one, one request is sent
// for all that were held.
// The first part drives the rule on its own with a clock of the test: a burst within the window sends one, an IDR
// frame ends the hold, a lost IDR frame gets one new request when the window ends, a loss episode without any IDR
// frame sends one request per window, and the window of 2 round trip times plus 2 frame intervals with its bounds of
// 50 and 250 ms, the longest without a known round trip time, which a slow answer of the host lengthens to a quarter
// more than the time its last IDR frame took to arrive after the first request for it.
// The second part runs the IDR request thread of ControlStream.c (included directly) with the real ENet over the
// loopback interface, like control_stream_state_test.c, and counts the requests that arrive at the PC: a burst, an IDR
// frame that arrives during the hold, a stop during a hold (the thread still ends at once), and the window from the
// round trip time that ENet measures and the frame rate of the stream. The depacketizer side, which tells the limit
// that an IDR frame arrived, is checked in video_depacketizer_test.c.

// The control stream and the socket code of moonlight-common-c need the GNU extensions of the C library (in6_pktinfo)
#define _GNU_SOURCE

#include "test_support_c.h"

#include "../../moonlight-common-c/src/Limelight-internal.h"

#include <arpa/inet.h>
#include <pthread.h>
#include <string.h>
#include <time.h>

#include "../../moonlight-common-c/src/ControlStream.c"
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

// ---- The rule ----

// The thread asks the rule at `nowMs` with a window of `windowMs`; returns whether it sends
static bool next(PIDR_REQUEST_LIMIT limit, uint64_t nowMs, uint32_t windowMs, uint32_t* waitMs) {
  return IdrLimitNext(limit, nowMs, windowMs, waitMs);
}

static void ABurstWithinTheWindowSendsOne(void) {
  IDR_REQUEST_LIMIT limit;
  uint32_t waitMs = 99;
  IdrLimitReset(&limit);
  // Nothing asked yet: wait for a request
  CHECK(!next(&limit, 1000, 100, &waitMs));
  CHECK_EQ_INT(waitMs, 0);
  // The first request of a stream is sent at once
  CHECK(!IdrLimitOnRequest(&limit, 1000));
  CHECK(next(&limit, 1000, 100, &waitMs));
  CHECK_EQ_INT(waitMs, 0);
  // Ten more within the window of 100 ms are held, and the thread waits for the end of the hold
  for (int i = 1; i <= 10; i++) {
    CHECK(IdrLimitOnRequest(&limit, 1000 + 5 * i));
    CHECK(!next(&limit, 1000 + 5 * i, 100, &waitMs));
    CHECK_EQ_INT(waitMs, 100 - 5 * i);
  }
  CHECK(!next(&limit, 1099, 100, &waitMs));
  CHECK_EQ_INT(waitMs, 1);
  CHECK_EQ_INT(limit.sent, 1);
  CHECK_EQ_INT(limit.held, 10);
}

static void AnIdrFrameEndsTheHold(void) {
  IDR_REQUEST_LIMIT limit;
  uint32_t waitMs;
  IdrLimitReset(&limit);
  IdrLimitOnRequest(&limit, 1000);
  CHECK(next(&limit, 1000, 100, &waitMs));
  CHECK(IdrLimitOnRequest(&limit, 1010));
  // The IDR frame on its way answers the held request: nothing is sent, neither now nor when the window ends
  IdrLimitOnIdrFrame(&limit, 1015);
  CHECK(!next(&limit, 1020, 100, &waitMs));
  CHECK_EQ_INT(waitMs, 0);
  CHECK(!next(&limit, 1100, 100, &waitMs));
  CHECK(!next(&limit, 1500, 100, &waitMs));
  CHECK_EQ_INT(limit.sent, 1);
  CHECK_EQ_INT(limit.held, 1);
  // A request after an IDR frame, still within the window of the request before it, is sent at once
  IdrLimitReset(&limit);
  IdrLimitOnRequest(&limit, 2000);
  CHECK(next(&limit, 2000, 100, &waitMs));
  IdrLimitOnIdrFrame(&limit, 2020);
  CHECK(!IdrLimitOnRequest(&limit, 2030));
  CHECK(next(&limit, 2030, 100, &waitMs));
  CHECK_EQ_INT(limit.sent, 2);
  CHECK_EQ_INT(limit.held, 0);
  // An IDR frame also answers a request that the thread hadn't sent yet: it arrived after the request
  IdrLimitOnIdrFrame(&limit, 2035);
  IdrLimitOnRequest(&limit, 2040);
  IdrLimitOnIdrFrame(&limit, 2041);
  CHECK(!next(&limit, 2041, 100, &waitMs));
  CHECK_EQ_INT(limit.sent, 2);
}

static void ALostIdrFrameGetsOneNewRequestWhenTheWindowEnds(void) {
  IDR_REQUEST_LIMIT limit;
  uint32_t waitMs;
  IdrLimitReset(&limit);
  IdrLimitOnRequest(&limit, 1000);
  CHECK(next(&limit, 1000, 100, &waitMs));
  // The IDR frame never arrives; the depacketizer asks again three times
  IdrLimitOnRequest(&limit, 1017);
  IdrLimitOnRequest(&limit, 1034);
  IdrLimitOnRequest(&limit, 1051);
  CHECK(!next(&limit, 1051, 100, &waitMs));
  CHECK_EQ_INT(waitMs, 49);
  // One request for all of them when the window ends, which starts the next window
  CHECK(next(&limit, 1100, 100, &waitMs));
  CHECK(!next(&limit, 1100, 100, &waitMs));
  CHECK_EQ_INT(limit.sent, 2);
  CHECK_EQ_INT(limit.held, 3);
  CHECK(IdrLimitOnRequest(&limit, 1150));
  CHECK(!next(&limit, 1150, 100, &waitMs));
  CHECK_EQ_INT(waitMs, 50);
  // A window that passed without a held request ends the hold: the next request goes out at once
  IdrLimitReset(&limit);
  IdrLimitOnRequest(&limit, 1000);
  CHECK(next(&limit, 1000, 100, &waitMs));
  CHECK(!next(&limit, 1200, 100, &waitMs));
  CHECK(!IdrLimitOnRequest(&limit, 1300));
  CHECK(next(&limit, 1300, 100, &waitMs));
}

static void ALossEpisodeWithoutAnyIdrFrameSendsOneRequestPerWindow(void) {
  // The depacketizer asks every 17 ms for one second (a 60 FPS stream that keeps losing frames), and the thread asks
  // the rule every millisecond: one request per window of 100 ms instead of 59
  IDR_REQUEST_LIMIT limit;
  uint32_t waitMs;
  int requests = 0;
  int sent = 0;
  IdrLimitReset(&limit);
  for (uint64_t now = 0; now <= 1000; now++) {
    if (now % 17 == 0) {
      IdrLimitOnRequest(&limit, now);
      requests++;
    }
    sent += next(&limit, now, 100, &waitMs) ? 1 : 0;
  }
  CHECK_EQ_INT(requests, 59);
  CHECK_EQ_INT(sent, 11);
  CHECK_EQ_INT(limit.sent, 11);
  CHECK_EQ_INT(limit.held, 58);
}

static void TheWindowIsTwoRoundTripsAndTwoFramesWithinItsBounds(void) {
  // 60 FPS: two frame intervals are 34 ms (rounded up)
  CHECK_EQ_INT(IdrLimitWindowMs(true, 0, 60), 50);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 8, 60), 50);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 9, 60), 52);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 40, 60), 114);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 108, 60), 250);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 109, 60), 250);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 500, 60), 250);
  CHECK_EQ_INT(IdrLimitWindowMs(true, UINT32_MAX, 60), 250);
  // Other frame rates: 17 ms at 120 FPS, 67 ms at 30 FPS, 2 s at 1 FPS
  CHECK_EQ_INT(IdrLimitWindowMs(true, 10, 120), 50);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 50, 120), 117);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 50, 30), 167);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 1, 1), 250);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 0, 1000), 50);
}

static void WithoutAKnownRoundTripTheWindowIsTheLongest(void) {
  CHECK_EQ_INT(IdrLimitWindowMs(false, 0, 60), 250);
  CHECK_EQ_INT(IdrLimitWindowMs(false, 5, 120), 250);
  // Nor without a frame rate
  CHECK_EQ_INT(IdrLimitWindowMs(true, 5, 0), 250);
  CHECK_EQ_INT(IdrLimitWindowMs(true, 5, -60), 250);
}

static void TheWindowIsLongerThanTheLastAnswerOfTheHost(void) {
  // Wi-Fi with a round trip of 5 ms at 60 FPS gives the shortest window, 50 ms, but a large keyframe arrives only 64 ms
  // after the request: in a loss episode the request held for a later loss goes out at the end of that window, just
  // before the keyframe. The answer is timed from the first request, so the next window is a quarter longer than the
  // 64 ms, 80 ms, and a later request waits for the keyframe instead of bringing another one.
  IDR_REQUEST_LIMIT limit;
  uint32_t waitMs;
  const uint32_t windowMs = IdrLimitWindowMs(true, 5, 60);
  CHECK_EQ_INT(windowMs, 50);
  IdrLimitReset(&limit);
  CHECK_EQ_INT(IdrLimitAnsweredWindowMs(&limit, windowMs), 50);
  IdrLimitOnRequest(&limit, 1000);
  CHECK(next(&limit, 1000, windowMs, &waitMs));
  CHECK(IdrLimitOnRequest(&limit, 1020));
  CHECK(!next(&limit, 1020, windowMs, &waitMs));
  CHECK_EQ_INT(waitMs, 30);
  CHECK(next(&limit, 1050, windowMs, &waitMs));
  // The keyframe of the first request arrives 14 ms after the second one went out, 64 ms after the first
  IdrLimitOnIdrFrame(&limit, 1064);
  CHECK_EQ_INT(limit.answerMs, 64);
  CHECK_EQ_INT(limit.slowestAnswerMs, 64);
  CHECK_EQ_INT(IdrLimitAnsweredWindowMs(&limit, windowMs), 80);
  // The next loss: its request goes out at once with a window of 80 ms, and a later request waits for the keyframe
  CHECK(!IdrLimitOnRequest(&limit, 1100));
  CHECK(next(&limit, 1100, windowMs, &waitMs));
  CHECK(IdrLimitOnRequest(&limit, 1140));
  CHECK(!next(&limit, 1160, windowMs, &waitMs));
  CHECK_EQ_INT(waitMs, 20);
  IdrLimitOnIdrFrame(&limit, 1164);
  CHECK(!next(&limit, 1180, windowMs, &waitMs));
  CHECK_EQ_INT(limit.sent, 3);
  CHECK_EQ_INT(limit.held, 2);
  // A faster answer shortens it again, to no less than the window of the round trip time
  IdrLimitOnRequest(&limit, 1300);
  CHECK(next(&limit, 1300, windowMs, &waitMs));
  IdrLimitOnIdrFrame(&limit, 1320);
  CHECK_EQ_INT(limit.answerMs, 20);
  CHECK_EQ_INT(IdrLimitAnsweredWindowMs(&limit, windowMs), 50);
  CHECK_EQ_INT(IdrLimitAnsweredWindowMs(&limit, 114), 114);
  CHECK_EQ_INT(limit.slowestAnswerMs, 64);
}

static void ASlowAnswerLengthensTheWindowNoFurtherThanItsBound(void) {
  IDR_REQUEST_LIMIT limit;
  uint32_t waitMs;
  IdrLimitReset(&limit);
  IdrLimitOnRequest(&limit, 1000);
  CHECK(next(&limit, 1000, 50, &waitMs));
  IdrLimitOnIdrFrame(&limit, 1240);
  CHECK_EQ_INT(limit.answerMs, 240);
  CHECK_EQ_INT(IdrLimitAnsweredWindowMs(&limit, 50), 250);
  IdrLimitOnRequest(&limit, 2000);
  CHECK(next(&limit, 2000, 50, &waitMs));
  CHECK(IdrLimitOnRequest(&limit, 2010));
  CHECK(!next(&limit, 2010, 50, &waitMs));
  CHECK_EQ_INT(waitMs, 240);
  // An IDR frame without a request sent since the last one isn't an answer, nor one more than a second after the
  // request (the host may have sent it for another reason, e.g. a restart of its encoder)
  IdrLimitOnIdrFrame(&limit, 2100);
  CHECK_EQ_INT(limit.answerMs, 100);
  IdrLimitOnIdrFrame(&limit, 2150);
  CHECK_EQ_INT(limit.answerMs, 100);
  IdrLimitOnRequest(&limit, 3000);
  CHECK(next(&limit, 3000, 50, &waitMs));
  IdrLimitOnIdrFrame(&limit, 4001);
  CHECK_EQ_INT(limit.answerMs, 100);
  CHECK_EQ_INT(limit.slowestAnswerMs, 240);
  // A lost keyframe: the request after it is timed from the first one, which comes out too long and only lengthens
  // the next window (at most to its bound)
  IdrLimitOnRequest(&limit, 5000);
  CHECK(next(&limit, 5000, 50, &waitMs));
  CHECK(!IdrLimitOnRequest(&limit, 5300));
  CHECK(next(&limit, 5300, 50, &waitMs));
  IdrLimitOnIdrFrame(&limit, 5360);
  CHECK_EQ_INT(limit.answerMs, 360);
  CHECK_EQ_INT(IdrLimitAnsweredWindowMs(&limit, 50), 250);
  // A request more than a second after an unanswered one starts the time anew
  IdrLimitOnRequest(&limit, 6000);
  CHECK(next(&limit, 6000, 50, &waitMs));
  IdrLimitOnRequest(&limit, 8000);
  CHECK(next(&limit, 8000, 50, &waitMs));
  IdrLimitOnIdrFrame(&limit, 8060);
  CHECK_EQ_INT(limit.answerMs, 60);
  CHECK_EQ_INT(limit.slowestAnswerMs, 360);
  // A new stream starts without a measured answer
  IdrLimitReset(&limit);
  CHECK_EQ_INT(limit.answerMs, 0);
  CHECK_EQ_INT(limit.slowestAnswerMs, 0);
  CHECK_EQ_INT(IdrLimitAnsweredWindowMs(&limit, 50), 50);
}

// ---- The IDR request thread of ControlStream.c ----

// The lines of the library and the errors that ended the connection
static int terminations;
static void connectionTerminated(int errorCode) {
  (void)errorCode;
  terminations++;
}
static void logMessage(const char* format, ...) {
  (void)format;
}

// A Sunshine host (the negative fourth number) with the unencrypted control stream of 7.1.415, and a stream at
// `fps` frames per second
static void startControlStreamWith(int fps) {
  AppVersionQuad[0] = 7;
  AppVersionQuad[1] = 1;
  AppVersionQuad[2] = 415;
  AppVersionQuad[3] = -1;
  memset(&ListenerCallbacks, 0, sizeof(ListenerCallbacks));
  ListenerCallbacks.connectionTerminated = connectionTerminated;
  ListenerCallbacks.logMessage = logMessage;
  memset(&StreamConfig, 0, sizeof(StreamConfig));
  StreamConfig.fps = fps;
  terminations = 0;
  CHECK_EQ_INT(initializeControlStream(), 0);
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

static uint64_t nowMs(void) {
  return PltGetMillis();
}

// Service the PC for `ms` milliseconds and return how many requests for an IDR frame arrived. A host of this version
// gets them as a reference frame invalidation (requestIdrFrame() in ControlStream.c).
static int requestsAtThePc(int ms) {
  ENetEvent event;
  int requests = 0;
  const uint64_t end = nowMs() + (uint64_t)ms;
  while (nowMs() < end) {
    while (enet_host_service(pcHost, &event, 1) > 0) {
      if (event.type == ENET_EVENT_TYPE_RECEIVE) {
        if (event.packet->dataLength >= 2 &&
            (short)(event.packet->data[0] | (event.packet->data[1] << 8)) == packetTypes[IDX_INVALIDATE_REF_FRAMES]) {
          requests++;
        }
        enet_packet_destroy(event.packet);
      }
    }
  }
  return requests;
}

// The threads of the control stream that the test needs: the receive thread services ENet for the client (the
// acknowledgements of the PC), and the IDR request thread
static bool startThreads(void) {
  if (!connectHosts()) {
    closeHosts();
    return false;
  }
  CHECK_EQ_INT(PltCreateThread("ControlRecv", controlReceiveThreadFunc, NULL, &controlReceiveThread), 0);
  CHECK_EQ_INT(PltCreateThread("ReqIdrFrame", requestIdrFrameFunc, NULL, &requestIdrFrameThread), 0);
  return true;
}

// The end of the control stream as stopControlStream() does it for these threads; returns how long the IDR request
// thread took to end
static uint64_t stopThreads(void) {
  uint64_t start;
  uint64_t idrThreadMs;
  stopping = true;
  LbqSignalQueueShutdown(&invalidReferenceFrameTuples);
  LbqSignalQueueShutdown(&frameFecStatusQueue);
  LbqSignalQueueDrain(&asyncCallbackQueue);
  start = nowMs();
  PltSetEvent(&idrFrameRequiredEvent);
  PltInterruptThread(&requestIdrFrameThread);
  PltJoinThread(&requestIdrFrameThread);
  idrThreadMs = nowMs() - start;
  PltInterruptThread(&controlReceiveThread);
  PltJoinThread(&controlReceiveThread);
  closeHosts();
  destroyControlStream();
  return idrThreadMs;
}

static void ABurstOfRequestsSendsOneAndOneMoreWhenTheWindowEnds(void) {
  uint32_t sent, held, slowest;
  // Without a frame rate the window is the longest, 250 ms, whatever the round trip time on the loopback interface
  startControlStreamWith(0);
  if (!startThreads()) {
    return;
  }
  // 20 requests 5 ms apart, the depacketizer and the decoder asking during a loss episode: the first one is sent, the
  // others wait for its IDR frame, which never comes. Each used to be sent.
  for (int i = 0; i < 20; i++) {
    LiRequestIdrFrame();
    PltSleepMs(5);
  }
  CHECK_EQ_INT(requestsAtThePc(50), 1);
  // When the window ends without an IDR frame, one request for all of them; then nothing more
  CHECK_EQ_INT(requestsAtThePc(250), 1);
  CHECK_EQ_INT(requestsAtThePc(300), 0);
  LiGetIdrFrameRequestStats(&sent, &held, &slowest);
  CHECK_EQ_INT(sent, 2);
  CHECK_EQ_INT(held, 19);
  // No IDR frame, so no answer was measured
  CHECK_EQ_INT(slowest, 0);
  CHECK_EQ_INT(terminations, 0);
  stopThreads();
}

static void AnIdrFrameDuringTheHoldAnswersItAndEndsIt(void) {
  uint32_t sent, held, slowest;
  startControlStreamWith(0);
  if (!startThreads()) {
    return;
  }
  LiRequestIdrFrame();
  CHECK_EQ_INT(requestsAtThePc(30), 1);
  // A request while the IDR frame is on its way is held, and the IDR frame that arrives answers it: nothing is sent
  // when the window ends
  LiRequestIdrFrame();
  CHECK_EQ_INT(requestsAtThePc(30), 0);
  connectionReceivedIdrFrame();
  CHECK_EQ_INT(requestsAtThePc(300), 0);
  // A request after an IDR frame is sent at once, also within the window of the request before it
  LiRequestIdrFrame();
  CHECK_EQ_INT(requestsAtThePc(30), 1);
  connectionReceivedIdrFrame();
  LiRequestIdrFrame();
  CHECK_EQ_INT(requestsAtThePc(30), 1);
  LiGetIdrFrameRequestStats(&sent, &held, &slowest);
  CHECK_EQ_INT(sent, 3);
  CHECK_EQ_INT(held, 1);
  // The first IDR frame came about 60 ms after its request, the second about 30 ms
  CHECK(slowest >= 55 && slowest < IDR_LIMIT_MAX_ANSWER_MS);
  if (!(slowest >= 55 && slowest < IDR_LIMIT_MAX_ANSWER_MS)) {
    printf("  # the slowest answer took %u ms\n", (unsigned)slowest);
  }
  stopThreads();
}

static void AStopDuringAHoldEndsTheThreadAtOnce(void) {
  startControlStreamWith(0);
  if (!startThreads()) {
    return;
  }
  LiRequestIdrFrame();
  CHECK_EQ_INT(requestsAtThePc(30), 1);
  // A held request: the thread waits up to 250 ms for the end of the hold
  LiRequestIdrFrame();
  CHECK_EQ_INT(requestsAtThePc(20), 0);
  const uint64_t stopMs = stopThreads();
  CHECK(stopMs < 100);
  if (stopMs >= 100) {
    printf("  # the IDR request thread took %llu ms to end\n", (unsigned long long)stopMs);
  }
}

static void TheWindowFollowsTheRoundTripTimeOfEnetAndTheFrameRate(void) {
  // Without a peer there is no round trip time: the longest window
  startControlStreamWith(60);
  CHECK_EQ_INT(idrRequestWindowMs(), 250);
  if (connectHosts()) {
    peer->roundTripTime = 40;
    CHECK_EQ_INT(idrRequestWindowMs(), 114);
    StreamConfig.fps = 120;
    CHECK_EQ_INT(idrRequestWindowMs(), 97);
    peer->roundTripTime = 2;
    CHECK_EQ_INT(idrRequestWindowMs(), 50);
    peer->roundTripTime = 200;
    CHECK_EQ_INT(idrRequestWindowMs(), 250);
  }
  closeHosts();
  stopping = true;
  destroyControlStream();
}

int main(void) {
  RUN_TEST("a burst of requests within the window sends one", ABurstWithinTheWindowSendsOne);
  RUN_TEST("an IDR frame answers the held requests and ends the hold", AnIdrFrameEndsTheHold);
  RUN_TEST("a lost IDR frame gets one new request when the window ends",
           ALostIdrFrameGetsOneNewRequestWhenTheWindowEnds);
  RUN_TEST("a loss episode without any IDR frame sends one request per window",
           ALossEpisodeWithoutAnyIdrFrameSendsOneRequestPerWindow);
  RUN_TEST("the window is 2 round trips and 2 frame intervals, between 50 and 250 ms",
           TheWindowIsTwoRoundTripsAndTwoFramesWithinItsBounds);
  RUN_TEST("without a known round trip time the window is the longest", WithoutAKnownRoundTripTheWindowIsTheLongest);
  RUN_TEST("the window is a quarter longer than the last answer of the host when that is longer",
           TheWindowIsLongerThanTheLastAnswerOfTheHost);
  RUN_TEST("a slow answer lengthens the window no further than its bound, and only an answer counts",
           ASlowAnswerLengthensTheWindowNoFurtherThanItsBound);
  CHECK_EQ_INT(enet_initialize(), 0);
  RUN_TEST("the thread sends one of a burst at once and one more when the window ends without an IDR frame",
           ABurstOfRequestsSendsOneAndOneMoreWhenTheWindowEnds);
  RUN_TEST("the thread sends nothing for a request that an IDR frame answered, and at once after it",
           AnIdrFrameDuringTheHoldAnswersItAndEndsIt);
  RUN_TEST("a stop during a hold ends the thread at once", AStopDuringAHoldEndsTheThreadAtOnce);
  RUN_TEST("the window follows the round trip time of ENet and the frame rate of the stream",
           TheWindowFollowsTheRoundTripTimeOfEnetAndTheFrameRate);
  enet_deinitialize();
  return test_summary();
}
