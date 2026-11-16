// Checks which error code ends a stream when the host ends it, and that only one of several threads that fail at the
// same time is reported. moonlight-common-c/src/Connection.c (the termination shim ClInternalConnectionTerminated(),
// LiStartConnection(), LiStopConnection()) and ControlStream.c (the control stream over the real ENet) are included
// directly; the other stages are stand-ins. A host of the PC on the loopback interface accepts the control stream and
// ends the stream when a test asks it to.
//
// The ports of 2.3.1, both local changes of Moonlight Plus:
//  - from host-termination.patch of Nightjar: the control receive thread reports the reason of the host before it
//    disconnects the ENet peer. A thread that sends on the control stream (the input thread, the loss statistics, IDR
//    and RFI requests) fails once the peer is disconnected and reports a generic error (-1 from the input stream, a
//    socket error from the others). It used to win when it came in between, and the app then showed 'The connection to
//    the PC was lost (error -1)' instead of the message for the reason of the host (e.g. -104, a video encoding
//    error, or 0 for a normal end, which shows nothing). The test widens that window: when the control receive thread
//    unlocks the ENet mutex with the peer disconnected, a hook waits until a competing input thread has failed and
//    reported its error. Before, the competitor came first; now the reason of the host is taken already.
//  - the check and the claim of the shim are one step under a PLT_MUTEX (terminationMutex, in place of the atomic
//    exchange of upstream b0deb0a and of Nightjar): a thread that ends the connection while another one is in the
//    middle of its claim waits for it, and only the first one is reported, once. Before, two threads could pass the
//    check together, and the app got two callbacks, both with the code of the later one.
// The common ends of a stream give the app the same codes as before: the host ends it (0 after a frame, -102 before the
// first one), the connection drops (-1), the user stops it (no callback; the app reports 0 itself), and a start that
// fails returns its error from LiStartConnection() without a callback (e.g. -300, after which the app starts once
// more). The mutex lives from LiStartConnection() to LiStopConnection() (activeMutexes of Platform.c back at 0), also
// for a start that fails and for a second LiStopConnection(), as the stop thread of the app calls it after a failed
// start.

// The control stream and the socket code of moonlight-common-c need the GNU extensions of the C library (in6_pktinfo)
#define _GNU_SOURCE

// ENet shifts 1 by the number of send attempts less one to compare it with the timeout limit
// (enet_protocol_check_timeouts() in enet/protocol.c), which overflows from the 33rd attempt on. When the PC goes away
// without an answer, the reliable pings of the client are sent again every 1 or 2 ms on the loopback interface, so
// the test of a dropped connection reaches that within the 100 ms for which the control stream waits for pending
// packets. WebAssembly takes the shift count modulo 32, so this doesn't change the TV; the shift checks of the
// undefined behaviour sanitizer are off for this test only.
// Build with: -fno-sanitize=shift

#include "test_support_c.h"

#include "../../moonlight-common-c/src/Limelight-internal.h"

#include <arpa/inet.h>
#include <pthread.h>
#include <stdarg.h>
#include <string.h>
#include <time.h>

// Every unlock of a mutex in ControlStream.c goes through a hook (the race below)
static void HookedUnlockMutex(PLT_MUTEX* mutex);
#define PltUnlockMutex(mutex) HookedUnlockMutex(mutex)
#include "../../moonlight-common-c/src/ControlStream.c"
#undef PltUnlockMutex

#include "../../moonlight-common-c/src/Connection.c"
#include "../../moonlight-common-c/src/ByteBuffer.c"
#include "../../moonlight-common-c/src/FakeCallbacks.c"
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

// ---- Waiting ----

static pthread_mutex_t testMutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t testCond = PTHREAD_COND_INITIALIZER;

static void deadlineIn(struct timespec* deadline, int ms) {
  clock_gettime(CLOCK_REALTIME, deadline);
  deadline->tv_sec += ms / 1000;
  deadline->tv_nsec += (long)(ms % 1000) * 1000 * 1000;
  if (deadline->tv_nsec >= 1000 * 1000 * 1000) {
    deadline->tv_sec++;
    deadline->tv_nsec -= 1000 * 1000 * 1000;
  }
}

// Wait up to `ms` milliseconds until *flag (guarded by testMutex) reaches `count`; returns whether it did
static bool waitFor(const int* flag, int count, int ms) {
  struct timespec deadline;
  deadlineIn(&deadline, ms);
  pthread_mutex_lock(&testMutex);
  while (*flag < count) {
    if (pthread_cond_timedwait(&testCond, &testMutex, &deadline) != 0) {
      break;
    }
  }
  const bool reached = *flag >= count;
  pthread_mutex_unlock(&testMutex);
  return reached;
}

static int readGuarded(const int* value) {
  pthread_mutex_lock(&testMutex);
  const int v = *value;
  pthread_mutex_unlock(&testMutex);
  return v;
}

static void sleepMs(int ms) {
  struct timespec delay = { ms / 1000, (long)(ms % 1000) * 1000 * 1000 };
  nanosleep(&delay, NULL);
}

// ---- The app ----

static int appTerminations;
static int appTerminationCode;
static int appStageFailures;
static int appFailedStage;
static int appFailedStageError;

static void appConnectionTerminated(int errorCode) {
  pthread_mutex_lock(&testMutex);
  appTerminations++;
  appTerminationCode = errorCode;
  pthread_cond_broadcast(&testCond);
  pthread_mutex_unlock(&testMutex);
}

static void appStageFailed(int stage, int errorCode) {
  appStageFailures++;
  appFailedStage = stage;
  appFailedStageError = errorCode;
}

// The log lines of the library, kept quiet
static void appLogMessage(const char* format, ...) {
  (void)format;
}

// ---- The PC ----

static ENetHost* pcHost;
static unsigned short pcPort;
static pthread_t pcThread;
static bool pcStop;
static bool pcSendTermination;
static uint32_t pcTerminationCode;
static bool pcDisconnect;

// Service the host of the PC: accept the control stream, take what it sends, and end it when asked to, by the
// extended termination message of Sunshine (its type, then the HRESULT in big-endian order) or by a disconnect
static void* pcThreadFunc(void* context) {
  ENetPeer* pcPeer = NULL;
  (void)context;
  for (;;) {
    ENetEvent event;
    pthread_mutex_lock(&testMutex);
    const bool stop = pcStop;
    const bool sendTermination = pcSendTermination && pcPeer != NULL;
    const bool disconnect = pcDisconnect && pcPeer != NULL;
    const uint32_t code = pcTerminationCode;
    if (sendTermination) {
      pcSendTermination = false;
    }
    if (disconnect) {
      pcDisconnect = false;
    }
    pthread_mutex_unlock(&testMutex);
    if (stop) {
      break;
    }
    if (sendTermination) {
      const unsigned char message[6] = { 0x00, 0x01, (unsigned char)(code >> 24), (unsigned char)(code >> 16),
                                         (unsigned char)(code >> 8), (unsigned char)code };
      CHECK(enet_peer_send(pcPeer, 0, enet_packet_create(message, sizeof(message), ENET_PACKET_FLAG_RELIABLE)) == 0);
      enet_host_flush(pcHost);
    }
    if (disconnect) {
      enet_peer_disconnect_now(pcPeer, 0);
      pcPeer = NULL;
    }
    while (enet_host_service(pcHost, &event, 2) > 0) {
      if (event.type == ENET_EVENT_TYPE_CONNECT) {
        pcPeer = event.peer;
      }
      else if (event.type == ENET_EVENT_TYPE_RECEIVE) {
        enet_packet_destroy(event.packet);
      }
      else if (event.type == ENET_EVENT_TYPE_DISCONNECT) {
        pcPeer = NULL;
      }
    }
  }
  return NULL;
}

static void startPc(void) {
  struct sockaddr_in loopback;
  ENetAddress bindAddress, pcAddress;
  memset(&loopback, 0, sizeof(loopback));
  loopback.sin_family = AF_INET;
  loopback.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  enet_address_set_address(&bindAddress, (struct sockaddr*)&loopback, sizeof(loopback));
  enet_address_set_port(&bindAddress, 0);
  pcHost = enet_host_create(AF_INET, &bindAddress, 1, CTRL_CHANNEL_COUNT, 0, 0);
  CHECK(pcHost != NULL);
  enet_socket_get_address(pcHost->socket, &pcAddress);
  pcPort = ntohs(((struct sockaddr_in*)&pcAddress.address)->sin_port);
  pcStop = false;
  pcSendTermination = false;
  pcDisconnect = false;
  CHECK(pthread_create(&pcThread, NULL, pcThreadFunc, NULL) == 0);
}

static void stopPc(void) {
  pthread_mutex_lock(&testMutex);
  pcStop = true;
  pthread_mutex_unlock(&testMutex);
  CHECK(pthread_join(pcThread, NULL) == 0);
  enet_host_destroy(pcHost);
  pcHost = NULL;
}

static void pcEndsTheStream(uint32_t hresult) {
  pthread_mutex_lock(&testMutex);
  pcTerminationCode = hresult;
  pcSendTermination = true;
  pthread_mutex_unlock(&testMutex);
}

static void pcDisconnects(void) {
  pthread_mutex_lock(&testMutex);
  pcDisconnect = true;
  pthread_mutex_unlock(&testMutex);
}

// ---- The other stages of a stream (stand-ins) ----

static int rtspHandshakeResult;

int initializeAudioStream(void) {
  return 0;
}
void destroyAudioStream(void) {}
int startAudioStream(void* audioContext, int arFlags) {
  (void)audioContext;
  (void)arFlags;
  return 0;
}
void stopAudioStream(void) {}
int performRtspHandshake(PSERVER_INFORMATION serverInfo) {
  (void)serverInfo;
  if (rtspHandshakeResult != 0) {
    return rtspHandshakeResult;
  }
  // The control port that the host names in its answer to RTSP SETUP
  ControlPortNumber = pcPort;
  return 0;
}
void initializeVideoStream(void) {}
void destroyVideoStream(void) {}
int startVideoStream(void* rendererContext, int drFlags) {
  (void)rendererContext;
  (void)drFlags;
  return 0;
}
void stopVideoStream(void) {}
int initializeInputStream(void) {
  return 0;
}
void destroyInputStream(void) {}
int startInputStream(void) {
  return 0;
}
int LiSendMouseMoveEvent(short deltaX, short deltaY) {
  (void)deltaX;
  (void)deltaY;
  return 0;
}

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

// ---- The input thread, which competes with the control receive thread ----

// It sends input on the control stream every millisecond, as the input thread of InputStream.c does, and when a send
// fails, it ends the connection with -1 as sendInputPacket() does. stopInputStream() (LiStopConnection()) joins it,
// as it joins that thread.
static pthread_t competitorThread;
static bool competitorRunning;
static bool competitorStop;
static int competitorReported;

static void* competitorThreadFunc(void* context) {
  unsigned char input[8] = { 0 };
  (void)context;
  for (;;) {
    pthread_mutex_lock(&testMutex);
    const bool stop = competitorStop;
    pthread_mutex_unlock(&testMutex);
    if (stop) {
      return NULL;
    }
    if (sendInputPacketOnControlStream(input, sizeof(input), 0, 0, false) < 0) {
      ListenerCallbacks.connectionTerminated(-1);
      pthread_mutex_lock(&testMutex);
      competitorReported++;
      pthread_cond_broadcast(&testCond);
      pthread_mutex_unlock(&testMutex);
      return NULL;
    }
    sleepMs(1);
  }
}

static void startCompetitor(void) {
  competitorStop = false;
  competitorReported = 0;
  CHECK(pthread_create(&competitorThread, NULL, competitorThreadFunc, NULL) == 0);
  competitorRunning = true;
}

int stopInputStream(void) {
  if (competitorRunning) {
    pthread_mutex_lock(&testMutex);
    competitorStop = true;
    pthread_mutex_unlock(&testMutex);
    CHECK(pthread_join(competitorThread, NULL) == 0);
    competitorRunning = false;
  }
  return 0;
}

// The hook of the unlocks of ControlStream.c: once armed, the first unlock of the ENet mutex with the peer disconnected
// (the control receive thread after enet_peer_disconnect_now() at the termination of the host) waits up to a second
// for the input thread to fail and report
static bool raceArmed;
static bool raceWaited;
static int raceDone;

static void HookedUnlockMutex(PLT_MUTEX* mutex) {
  bool wait = false;
  if (mutex == &enetMutex && peer != NULL && peer->state == ENET_PEER_STATE_DISCONNECTED) {
    pthread_mutex_lock(&testMutex);
    if (raceArmed) {
      raceArmed = false;
      wait = true;
    }
    pthread_mutex_unlock(&testMutex);
  }
  PltUnlockMutex(mutex);
  if (wait) {
    const bool reported = waitFor(&competitorReported, 1, 1000);
    pthread_mutex_lock(&testMutex);
    raceWaited = reported;
    raceDone++;
    pthread_cond_broadcast(&testCond);
    pthread_mutex_unlock(&testMutex);
  }
}

// ---- The stream ----

static SERVER_INFORMATION serverInfo;
static STREAM_CONFIGURATION streamConfig;
static CONNECTION_LISTENER_CALLBACKS appCallbacks;
static DECODER_RENDERER_CALLBACKS videoCallbacks;
static AUDIO_RENDERER_CALLBACKS audioCallbacks;

// Start a stream to the PC: a Sunshine host (the negative fourth number) with the unencrypted control stream of
// 7.1.415, at 1080p60 in stereo; returns the result of LiStartConnection()
static int startStream(void) {
  pthread_mutex_lock(&testMutex);
  appTerminations = 0;
  appTerminationCode = 12345;
  raceArmed = false;
  raceWaited = false;
  raceDone = 0;
  pthread_mutex_unlock(&testMutex);
  appStageFailures = 0;
  appFailedStage = 0;
  appFailedStageError = 0;
  competitorRunning = false;

  LiInitializeServerInformation(&serverInfo);
  serverInfo.address = "127.0.0.1";
  serverInfo.serverInfoAppVersion = "7.1.415.-1";
  serverInfo.serverCodecModeSupport = SCM_H264;
  LiInitializeStreamConfiguration(&streamConfig);
  streamConfig.width = 1920;
  streamConfig.height = 1080;
  streamConfig.fps = 60;
  streamConfig.bitrate = 20000;
  streamConfig.packetSize = 1392;
  streamConfig.streamingRemotely = STREAM_CFG_LOCAL;
  streamConfig.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
  streamConfig.supportedVideoFormats = VIDEO_FORMAT_H264;
  LiInitializeConnectionCallbacks(&appCallbacks);
  appCallbacks.connectionTerminated = appConnectionTerminated;
  appCallbacks.stageFailed = appStageFailed;
  appCallbacks.logMessage = appLogMessage;
  LiInitializeVideoCallbacks(&videoCallbacks);
  LiInitializeAudioCallbacks(&audioCallbacks);
  return LiStartConnection(&serverInfo, &streamConfig, &appCallbacks, &videoCallbacks, &audioCallbacks, NULL, 0, NULL,
                           0);
}

// The stop thread of the app (StopThreadFunc() in wasm/main.cpp): LiStopConnection(), after which the mutex of the
// shim is gone
static void stopStream(void) {
  LiStopConnection();
  CHECK(!terminationMutexCreated);
  CHECK_EQ_INT(activeMutexes, 0);
}

// The callbacks of the app that came within the next `ms` milliseconds
static int terminationsWithin(int ms) {
  sleepMs(ms);
  return readGuarded(&appTerminations);
}

// ---- The tests ----

// Error codes that no part of the stream uses
#define ERROR_TEST_FIRST -1001
#define ERROR_TEST_SECOND -1002

static void TheReasonOfTheHostWinsOverAnInputThreadThatFailsAfterTheDisconnect(void) {
  startPc();
  CHECK_EQ_INT(startStream(), 0);
  CHECK(terminationMutexCreated);
  startCompetitor();
  sleepMs(50);
  CHECK_EQ_INT(readGuarded(&competitorReported), 0);

  pthread_mutex_lock(&testMutex);
  raceArmed = true;
  pthread_mutex_unlock(&testMutex);
  // NVST_DISCONN_SERVER_VIDEO_ENCODER_CONVERT_INPUT_FRAME_FAILED: 'The host PC reported a fatal video encoding error'
  pcEndsTheStream(0x800e9403);
  CHECK(waitFor(&appTerminations, 1, 3000));
  // The input thread did fail after the disconnect and reported -1 while the control receive thread waited
  CHECK(waitFor(&raceDone, 1, 3000));
  CHECK_EQ_INT(readGuarded(&competitorReported), 1);
  pthread_mutex_lock(&testMutex);
  const bool waited = raceWaited;
  pthread_mutex_unlock(&testMutex);
  CHECK(waited);
  // The app got the reason of the host (ML_ERROR_FRAME_CONVERSION), once; before, it got -1 from the input thread
  CHECK_EQ_INT(terminationsWithin(100), 1);
  CHECK_EQ_INT(readGuarded(&appTerminationCode), ML_ERROR_FRAME_CONVERSION);

  stopStream();
  stopPc();
}

static void TheHostEndsTheStreamNormally(void) {
  startPc();
  CHECK_EQ_INT(startStream(), 0);
  // A frame arrived (connectionSawFrame() of the video stream)
  lastSeenFrame = 120;
  // NVST_DISCONN_SERVER_TERMINATED_CLOSED: the user quit the game on the PC; 0 shows no message in the app
  pcEndsTheStream(0x80030023);
  CHECK(waitFor(&appTerminations, 1, 3000));
  CHECK_EQ_INT(terminationsWithin(50), 1);
  CHECK_EQ_INT(readGuarded(&appTerminationCode), ML_ERROR_GRACEFUL_TERMINATION);
  stopStream();
  stopPc();
}

static void TheHostEndsTheStreamBeforeTheFirstFrame(void) {
  startPc();
  CHECK_EQ_INT(startStream(), 0);
  pcEndsTheStream(0x80030023);
  CHECK(waitFor(&appTerminations, 1, 3000));
  CHECK_EQ_INT(terminationsWithin(50), 1);
  CHECK_EQ_INT(readGuarded(&appTerminationCode), ML_ERROR_UNEXPECTED_EARLY_TERMINATION);
  stopStream();
  stopPc();
}

static void TheConnectionDrops(void) {
  startPc();
  CHECK_EQ_INT(startStream(), 0);
  startCompetitor();
  // The PC goes away without a termination message: the control stream reports -1, and so does the input thread
  pcDisconnects();
  CHECK(waitFor(&appTerminations, 1, 5000));
  CHECK_EQ_INT(terminationsWithin(100), 1);
  CHECK_EQ_INT(readGuarded(&appTerminationCode), -1);
  stopStream();
  stopPc();
}

static void TheUserStopsTheStream(void) {
  startPc();
  CHECK_EQ_INT(startStream(), 0);
  startCompetitor();
  sleepMs(20);
  // RED or the Stream Menu: the app reports 0 itself (StopConnection() in wasm/main.cpp) and stops the connection,
  // which calls back nothing, also not for the input thread that fails meanwhile
  stopStream();
  CHECK_EQ_INT(terminationsWithin(100), 0);
  stopPc();
}

static void AStartThatFailsReturnsItsErrorWithoutACallback(void) {
  startPc();
  // The host answered the RTSP handshake with the key of another start (the local patch of RtspConnection.c), after
  // which the app starts once more
  rtspHandshakeResult = ML_ERROR_RTSP_DECRYPT_FAILED;
  CHECK_EQ_INT(startStream(), ML_ERROR_RTSP_DECRYPT_FAILED);
  rtspHandshakeResult = 0;
  CHECK_EQ_INT(appStageFailures, 1);
  CHECK_EQ_INT(appFailedStage, STAGE_RTSP_HANDSHAKE);
  CHECK_EQ_INT(appFailedStageError, ML_ERROR_RTSP_DECRYPT_FAILED);
  // LiStartConnection() stopped what it had started, and the stop thread of the app stops it once more
  CHECK(!terminationMutexCreated);
  CHECK_EQ_INT(activeMutexes, 0);
  stopStream();
  CHECK_EQ_INT(terminationsWithin(50), 0);
  stopPc();
}

// A thread that ends the connection while another one is in the middle of its claim (it holds terminationMutex) waits
// for it, and then only one of them is reported. Before, the check and the claim were two steps without a lock, and a
// second thread could pass the check before the first one set the flag.
static void* terminatingThreadFunc(void* context) {
  LiTerminateConnectionAsync((int)(intptr_t)context);
  pthread_mutex_lock(&testMutex);
  competitorReported++;
  pthread_cond_broadcast(&testCond);
  pthread_mutex_unlock(&testMutex);
  return NULL;
}

static void AThreadThatEndsTheConnectionWaitsForAClaimInProgress(void) {
  pthread_t first, second;
  startPc();
  CHECK_EQ_INT(startStream(), 0);
  competitorReported = 0;

  PltLockMutex(&terminationMutex);
  CHECK(pthread_create(&first, NULL, terminatingThreadFunc, (void*)(intptr_t)ERROR_TEST_FIRST) == 0);
  // It waits for the claim in progress, and nothing is reported meanwhile
  CHECK(!waitFor(&competitorReported, 1, 200));
  CHECK_EQ_INT(readGuarded(&appTerminations), 0);
  PltUnlockMutex(&terminationMutex);
  CHECK(pthread_join(first, NULL) == 0);
  CHECK(waitFor(&appTerminations, 1, 2000));

  // A later one is not reported
  CHECK(pthread_create(&second, NULL, terminatingThreadFunc, (void*)(intptr_t)ERROR_TEST_SECOND) == 0);
  CHECK(pthread_join(second, NULL) == 0);
  CHECK_EQ_INT(terminationsWithin(50), 1);
  CHECK_EQ_INT(readGuarded(&appTerminationCode), ERROR_TEST_FIRST);
  stopStream();
  stopPc();
}

// Four threads that end the connection at the same moment (e.g. the video and the audio receive threads on a socket
// error, the decoder thread with LiTerminateConnectionAsync() and the control stream): one callback, with the code of
// one of them. The window of the old code is a few instructions wide, so this is a guard of the rule rather than a
// test that catches the old code.
#define RACERS 4
static pthread_barrier_t racersBarrier;

static void* racerThreadFunc(void* context) {
  const int code = (int)(intptr_t)context;
  pthread_barrier_wait(&racersBarrier);
  LiTerminateConnectionAsync(code);
  return NULL;
}

static void OfThreadsThatFailTogetherOnlyOneIsReported(void) {
  int rounds = 0;
  int extraCallbacks = 0;
  startPc();
  for (int round = 0; round < 20; round++) {
    pthread_t racers[RACERS];
    if (startStream() != 0) {
      CHECK(false);
      break;
    }
    rounds++;
    CHECK(pthread_barrier_init(&racersBarrier, NULL, RACERS) == 0);
    for (int i = 0; i < RACERS; i++) {
      CHECK(pthread_create(&racers[i], NULL, racerThreadFunc, (void*)(intptr_t)(ERROR_TEST_FIRST - i)) == 0);
    }
    for (int i = 0; i < RACERS; i++) {
      CHECK(pthread_join(racers[i], NULL) == 0);
    }
    pthread_barrier_destroy(&racersBarrier);
    CHECK(waitFor(&appTerminations, 1, 2000));
    const int callbacks = terminationsWithin(20);
    const int code = readGuarded(&appTerminationCode);
    if (callbacks != 1) {
      extraCallbacks += callbacks - 1;
    }
    CHECK(code <= ERROR_TEST_FIRST && code > ERROR_TEST_FIRST - RACERS);
    stopStream();
  }
  stopPc();
  if (extraCallbacks != 0) {
    printf("  # %d callbacks too many in %d rounds\n", extraCallbacks, rounds);
  }
  CHECK_EQ_INT(extraCallbacks, 0);
  CHECK_EQ_INT(rounds, 20);
}

int main(void) {
  RUN_TEST("the reason of the host wins over an input thread that fails after the disconnect (host-termination.patch of Nightjar)",
           TheReasonOfTheHostWinsOverAnInputThreadThatFailsAfterTheDisconnect);
  RUN_TEST("the host ends the stream normally: 0, as before", TheHostEndsTheStreamNormally);
  RUN_TEST("the host ends the stream before the first frame: -102, as before", TheHostEndsTheStreamBeforeTheFirstFrame);
  RUN_TEST("the connection drops: -1, as before", TheConnectionDrops);
  RUN_TEST("the user stops the stream: no callback, as before", TheUserStopsTheStream);
  RUN_TEST("a start that fails returns its error without a callback, as before", AStartThatFailsReturnsItsErrorWithoutACallback);
  RUN_TEST("a thread that ends the connection waits for a claim in progress, and only the first is reported (terminationMutex)",
           AThreadThatEndsTheConnectionWaitsForAClaimInProgress);
  RUN_TEST("of four threads that fail together only one is reported, once", OfThreadsThatFailTogetherOnlyOneIsReported);
  return test_summary();
}
