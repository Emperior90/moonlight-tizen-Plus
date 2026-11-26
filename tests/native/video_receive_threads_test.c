// Checks the two threads of the video receive of 2.3.5 (moonlight-common-c/src/VideoStream.c, included directly, with the
// ring of VideoReceiveRing.h) running for real: the reader (VideoReceiveThreadProc()), which only reads the packets and
// notes when it read each one, and the processing thread (VideoProcessThreadProc()), which does the rest:
//  - every packet reaches RtpvAddPacket() on the processing thread, in order, with the time the reader read it, and a
//    plain packet in the very buffer it was received into (no copy between the threads);
//  - encrypted video is decrypted from the buffer of its slot into a buffer of the processing thread, which the queue
//    gets; a packet that fails to decrypt is logged and the stream goes on;
//  - a ring of 8 packets (defined here before the include) and a slow queue: the ring fills, the reader waits, nothing
//    is lost or reordered, the line of the processing thread counts the times it was full, and the reader's line doesn't
//    count its waits for room as its work;
//  - a queue that rejects every 5th packet (as the real one rejects surplus parity packets and late or duplicate
//    ones): the buffer stays with the processing thread, and the reader never receives into the buffer of a packet that
//    the processing thread hasn't handed to the queue yet (no buffer in two slots);
//  - the idle share of the processing thread: high when it waits for packets, and without the wait for its first one;
//    it waits as soon as the ring is empty (no look again for packets, no looking share in its line), and the reader
//    wakes it for the next packet;
//  - no packet waits in the ring while the processing thread sleeps: after bursts of 1, 37 and 300 packets, each followed
//    by a read that waits for the socket, in each of the three receive modes (the receive timeout, poll() before each
//    receive, and the poll() of a socket that never waits once none is waiting), the processing thread took every packet
//    of the burst and waits with the ring empty while the reader still waits in its read; then the stop while both wait;
//  - the stop while the reader waits for room, while the processing thread waits for packets, and while the reader of a
//    socket that never waits waits in its read (woken by wakeUdpSocketReader()), also in the three failed starts after
//    the reader started; a failed start of the reader stops and joins the processing thread and frees the ring;
//  - the limit of 10 s for the first frame on the processing thread, by the read times, after which the reader ends at
//    its next packet; the limit of 10 s without video; a socket error, after which the processing thread takes what
//    the ring still holds and ends.
// Stand-ins: the sockets serve a script of packets on the reader thread; the threads, mutexes and condition variables
// are those of pthreads (the flag of an interrupted thread with the atomic builtins of GCC, so that the thread
// sanitizer can check the rest; the real Platform.c keeps a plain flag), the clock is CLOCK_MONOTONIC plus a jump that
// the script can add (for the limit of 10 s); RtpvAddPacket() records and frees each packet. The main thread waits for
// the stand-ins through a mutex and a condition variable of the test, which also orders what the threads wrote before
// it reads it. A watchdog ends the test if a stop never returns.
// The test runs with the flags of run.sh (the address and undefined behaviour sanitizers) and, by the line below, once
// more with the thread sanitizer, which must report nothing.
// Thread sanitizer: yes

#define _GNU_SOURCE

#include "test_support_c.h"

// A small ring, so that it fills
#define VIDEO_RECV_RING_PACKETS 8

#include "../../moonlight-common-c/src/VideoStream.c"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// What the other files of moonlight-common-c provide (Connection.c and the others)
struct sockaddr_storage RemoteAddr;
struct sockaddr_storage LocalAddr;
SOCKADDR_LEN AddrLen;
int AppVersionQuad[4];
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
DECODER_RENDERER_CALLBACKS VideoCallbacks;
int NegotiatedVideoFormat;
uint32_t EncryptionFeaturesEnabled;
uint16_t VideoPortNumber;
SS_PING VideoPingPayload;

// ---- What the threads tell the main thread, under one mutex ----

static pthread_mutex_t testMutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t testCond = PTHREAD_COND_INITIALIZER;

#define MAX_LINES 64
static char lines[MAX_LINES][512];
static int lineCount;
static int linesTooLong;
static int terminations;
static int terminationError;
static pthread_t terminationThread;
static pthread_t queueThread;

static void captureLine(const char* format, ...) {
  char line[512];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  pthread_mutex_lock(&testMutex);
  if (strlen(line) >= 240) {
    linesTooLong++;
  }
  if (lineCount < MAX_LINES) {
    snprintf(lines[lineCount++], sizeof(lines[0]), "%s", line);
  }
  pthread_cond_broadcast(&testCond);
  pthread_mutex_unlock(&testMutex);
}

static void connectionTerminated(int errorCode) {
  pthread_mutex_lock(&testMutex);
  terminations++;
  terminationError = errorCode;
  terminationThread = pthread_self();
  pthread_cond_broadcast(&testCond);
  pthread_mutex_unlock(&testMutex);
}

// The lines (call with testMutex held, or after the threads ended)
static int findLine(const char* start) {
  for (int i = 0; i < lineCount; i++) {
    if (strncmp(lines[i], start, strlen(start)) == 0) {
      return i;
    }
  }
  return -1;
}

static int countLines(const char* start) {
  int count = 0;
  for (int i = 0; i < lineCount; i++) {
    if (strncmp(lines[i], start, strlen(start)) == 0) {
      count++;
    }
  }
  return count;
}

static void printLines(void) {
  for (int i = 0; i < lineCount; i++) {
    printf("  #   logged: %s", lines[i]);
  }
}

// The number in a line right after the text, e.g. the packets after "Video processing of the stream, 1 s: ", or -1
static long long numberAfter(const char* line, const char* text) {
  const char* start = strstr(line, text);
  long long value = -1;
  if (start == NULL || sscanf(start + strlen(text), "%lld", &value) != 1) {
    return -1;
  }
  return value;
}

// The number in a line right before the text, e.g. the time before " us of other work per packet", or -1
static double numberBefore(const char* line, const char* text) {
  const char* end = strstr(line, text);
  if (end == NULL) {
    return -1;
  }
  const char* start = end;
  while (start > line && start[-1] != ' ') {
    start--;
  }
  double value = -1;
  if (sscanf(start, "%lf", &value) != 1) {
    return -1;
  }
  return value;
}

#define STREAM_LINE "Video receive of the stream, "
#define PROCESS_LINE "Video processing of the stream, "

// Waits up to 10 s, with testMutex held, until the condition holds
static bool waitUntil(bool (*condition)(void)) {
  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += 10;
  while (!condition()) {
    if (pthread_cond_timedwait(&testCond, &testMutex, &deadline) != 0 && !condition()) {
      return false;
    }
  }
  return true;
}

// ---- The clock: CLOCK_MONOTONIC and a jump that the script adds ----

static uint64_t clockJumpUs;

uint64_t PltGetMicroseconds(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000000 + (uint64_t)now.tv_nsec / 1000 + __atomic_load_n(&clockJumpUs, __ATOMIC_SEQ_CST);
}
uint64_t PltGetMillis(void) {
  return PltGetMicroseconds() / 1000;
}

// ---- The threads, mutexes and condition variables, on pthreads ----

typedef struct {
  ThreadEntry entry;
  void* context;
} THREAD_START;

static void* threadStart(void* context) {
  THREAD_START start = *(THREAD_START*)context;
  free(context);
  start.entry(start.context);
  return NULL;
}

// What the main thread did at the start and the stop, in order, e.g. "create:VideoProc join:VideoRecv"
static char events[1024];

static void event(const char* name, const char* detail) {
  pthread_mutex_lock(&testMutex);
  if (events[0] != 0) {
    strncat(events, " ", sizeof(events) - strlen(events) - 1);
  }
  strncat(events, name, sizeof(events) - strlen(events) - 1);
  if (detail != NULL) {
    strncat(events, ":", sizeof(events) - strlen(events) - 1);
    strncat(events, detail, sizeof(events) - strlen(events) - 1);
  }
  pthread_mutex_unlock(&testMutex);
}

static void checkEvents(const char* expected) {
  pthread_mutex_lock(&testMutex);
  const bool same = strcmp(events, expected) == 0;
  if (!same) {
    printf("  # expected the events: %s\n  # got the events:      %s\n", expected, events);
  }
  pthread_mutex_unlock(&testMutex);
  CHECK(same);
}

static const char* threadName(PLT_THREAD* thread) {
  return thread == &receiveThread ? "VideoRecv" : thread == &processThread ? "VideoProc"
       : thread == &decoderThread ? "VideoDec" : thread == &udpPingThread ? "VideoPing" : "other";
}

static const char* failingThread;
// Runs once the reader was joined, before the next join (a case that holds the processing thread lets it go there)
static void (*afterReaderJoined)(void);
// A start fails only once the reader waits for room in a full ring (the thread or the TCP socket that fails waits for
// it), so that only the stop of the ring can end that wait
static bool failWhenTheRingIsFull;
static bool readerWaitsForRoom(void);
static bool waitForRing(bool (*condition)(void));

int PltCreateThread(const char* name, ThreadEntry entry, void* context, PLT_THREAD* thread) {
  if (failingThread != NULL && strcmp(name, failingThread) == 0) {
    if (failWhenTheRingIsFull) {
      CHECK(waitForRing(readerWaitsForRoom));
    }
    event("fail", name);
    return -1;
  }
  THREAD_START* start = (THREAD_START*)malloc(sizeof(THREAD_START));
  start->entry = entry;
  start->context = context;
  __atomic_store_n(&thread->cancelled, false, __ATOMIC_SEQ_CST);
  CHECK(pthread_create(&thread->thread, NULL, threadStart, start) == 0);
  event("create", name);
  return 0;
}
void PltInterruptThread(PLT_THREAD* thread) {
  __atomic_store_n(&thread->cancelled, true, __ATOMIC_SEQ_CST);
}
bool PltIsThreadInterrupted(PLT_THREAD* thread) {
  return __atomic_load_n(&thread->cancelled, __ATOMIC_SEQ_CST);
}
void PltJoinThread(PLT_THREAD* thread) {
  pthread_join(thread->thread, NULL);
  event("join", threadName(thread));
  if (thread == &receiveThread && afterReaderJoined != NULL) {
    afterReaderJoined();
  }
}
void PltSleepMsInterruptible(PLT_THREAD* thread, int ms) {
  while (ms > 0 && !PltIsThreadInterrupted(thread)) {
    usleep(5000);
    ms -= 5;
  }
}

static int mutexesAlive;
int PltCreateMutex(PLT_MUTEX* mutex) {
  __atomic_add_fetch(&mutexesAlive, 1, __ATOMIC_SEQ_CST);
  return pthread_mutex_init(mutex, NULL);
}
void PltDeleteMutex(PLT_MUTEX* mutex) {
  __atomic_sub_fetch(&mutexesAlive, 1, __ATOMIC_SEQ_CST);
  pthread_mutex_destroy(mutex);
}
void PltLockMutex(PLT_MUTEX* mutex) {
  pthread_mutex_lock(mutex);
}
void PltUnlockMutex(PLT_MUTEX* mutex) {
  pthread_mutex_unlock(mutex);
}
int PltCreateConditionVariable(PLT_COND* cond, PLT_MUTEX* mutex) {
  (void)mutex;
  return pthread_cond_init(cond, NULL);
}
void PltDeleteConditionVariable(PLT_COND* cond) {
  pthread_cond_destroy(cond);
}
void PltSignalConditionVariable(PLT_COND* cond) {
  pthread_cond_signal(cond);
}
void PltWaitForConditionVariable(PLT_COND* cond, PLT_MUTEX* mutex) {
  pthread_cond_wait(cond, mutex);
}

// ---- The script of the reader's socket ----

#define ENTRY_PACKET 0
#define ENTRY_TIMEOUT 1
#define ENTRY_ERROR 2
// A read that waits for the socket until the test lets it go, or the stop ends it (the interrupt of the thread, which
// the receive timeout or the timeout of poll() lets the reader see; the wake of a socket that never waits); it returns
// no packet
#define ENTRY_HOLD 3

typedef struct {
  int kind;
  int size;
  uint64_t jumpUs;  // the clock jumps by this before the receive returns
} ENTRY;

#define MAX_ENTRIES 20000
static ENTRY script[MAX_ENTRIES];
static int scriptLength;
// Written by the reader only; the main thread reads them after a wait under testMutex or after the joins
static int scriptPosition;
static int receivesAfterScript;
// For each entry: the buffer it was received into, and the clock right before the receive returned
static char* servedBuffer[MAX_ENTRIES];
static uint64_t servedUs[MAX_ENTRIES];
// The bytes before the RTP header of a packet (the header of encrypted video)
static int rtpOffset;

static bool timeoutWorks;
static bool noWaitWorks;
static bool readerWoken;
// The reads of ENTRY_HOLD entries that the reader began and ended, and the test lets the one it waits in go (under
// testMutex)
static int holdsBegun;
static int holdsEnded;
static bool holdReleased;
static int closeCalls;
// Whether the processing thread handed each entry to the RTP queue (under testMutex); with checkBusyBuffers (a case
// whose packets all go to the queue), the receives into the buffer of a packet that it hadn't handed over yet
static bool handedToQueue[MAX_ENTRIES];
static bool checkBusyBuffers;
static int servedIntoBusyBuffer;

#define FIRST_SOCKET 1000
#define NO_WAIT_SOCKET 1001
#define FULL_PACKET (1392 + MAX_RTP_HEADER_SIZE)

static void socketEvent(const char* name, long long s) {
  char detail[24];
  snprintf(detail, sizeof(detail), "%lld", s);
  event(name, detail);
}

SOCKET bindUdpSocket(int addressFamily, struct sockaddr_storage* localAddr, SOCKADDR_LEN addrLen, int bufferSize,
                     int socketQosType) {
  (void)addressFamily;
  (void)localAddr;
  (void)addrLen;
  (void)bufferSize;
  (void)socketQosType;
  socketEvent("bind", FIRST_SOCKET);
  return FIRST_SOCKET;
}
SOCKET bindUdpSocketNoWait(int addressFamily, struct sockaddr_storage* localAddr, SOCKADDR_LEN addrLen, int bufferSize,
                           int socketQosType) {
  (void)addressFamily;
  (void)localAddr;
  (void)addrLen;
  (void)bufferSize;
  (void)socketQosType;
  socketEvent("nowait", noWaitWorks ? NO_WAIT_SOCKET : -1);
  return noWaitWorks ? NO_WAIT_SOCKET : INVALID_SOCKET;
}
void closeSocket(SOCKET s) {
  closeCalls++;
  socketEvent("close", s);
}
// Called by startVideoStream() on the main thread, and by the reader (which sets the timeout once more)
int setNonFatalRecvTimeoutMs(SOCKET s, int timeoutMs) {
  (void)s;
  (void)timeoutMs;
  return timeoutWorks ? 0 : -1;
}
int wakeUdpSocketReader(SOCKET s) {
  socketEvent("wake", s);
  pthread_mutex_lock(&testMutex);
  readerWoken = true;
  pthread_cond_broadcast(&testCond);
  pthread_mutex_unlock(&testMutex);
  return 0;
}
SOCKET connectTcpSocket(struct sockaddr_storage* dstaddr, SOCKADDR_LEN addrlen, unsigned short port, int timeoutSec) {
  (void)dstaddr;
  (void)addrlen;
  (void)port;
  (void)timeoutSec;
  // A host of GFE 3 whose port for the first frame doesn't answer
  if (failWhenTheRingIsFull) {
    CHECK(waitForRing(readerWaitsForRoom));
  }
  event("connect", NULL);
  errno = ECONNREFUSED;
  return INVALID_SOCKET;
}
void shutdownTcpSocket(SOCKET s) {
  (void)s;
}
int pollSockets(struct pollfd* pollFds, int pollFdsCount, int timeoutMs) {
  (void)timeoutMs;
  // The poll() without a timeout of a sample: a packet is waiting while the script has one
  for (int i = 0; i < pollFdsCount; i++) {
    pollFds[i].revents = scriptPosition < scriptLength ? POLLIN : 0;
  }
  return scriptPosition < scriptLength ? 1 : 0;
}

// The next entry of the script into the buffer. After the script: a timeout of 1 ms, or, for a socket that never
// waits, a read that waits until wakeUdpSocketReader() (which ends it as no packet)
static int serve(char* buffer, int size, bool noWait) {
  if (scriptPosition >= scriptLength) {
    if (noWait) {
      pthread_mutex_lock(&testMutex);
      while (!readerWoken) {
        pthread_cond_wait(&testCond, &testMutex);
      }
      readerWoken = false;
      pthread_mutex_unlock(&testMutex);
      return 0;
    }
    receivesAfterScript++;
    usleep(1000);
    return 0;
  }
  const int index = scriptPosition;
  const ENTRY* entry = &script[index];
  if (entry->jumpUs > 0) {
    __atomic_add_fetch(&clockJumpUs, entry->jumpUs, __ATOMIC_SEQ_CST);
  }
  if (entry->kind == ENTRY_TIMEOUT) {
    usleep(1000);
    scriptPosition++;
    return 0;
  }
  if (entry->kind == ENTRY_ERROR) {
    scriptPosition++;
    errno = ENETDOWN;
    return -1;
  }
  if (entry->kind == ENTRY_HOLD) {
    pthread_mutex_lock(&testMutex);
    holdsBegun++;
    pthread_cond_broadcast(&testCond);
    while (!holdReleased && !(noWait ? readerWoken : PltIsThreadInterrupted(&receiveThread))) {
      struct timespec deadline;
      clock_gettime(CLOCK_REALTIME, &deadline);
      deadline.tv_nsec += 1000000;
      if (deadline.tv_nsec >= 1000000000) {
        deadline.tv_sec++;
        deadline.tv_nsec -= 1000000000;
      }
      pthread_cond_timedwait(&testCond, &testMutex, &deadline);
    }
    readerWoken = false;
    holdReleased = false;
    holdsEnded++;
    pthread_cond_broadcast(&testCond);
    pthread_mutex_unlock(&testMutex);
    scriptPosition++;
    return 0;
  }
  CHECK(entry->size <= size);
  if (checkBusyBuffers) {
    // (a packet stays in the ring of 8 and the batch of the processing thread, so 64 entries back are enough)
    pthread_mutex_lock(&testMutex);
    for (int j = index > 64 ? index - 64 : 0; j < index; j++) {
      if (servedBuffer[j] == buffer && !handedToQueue[j]) {
        servedIntoBusyBuffer++;
      }
    }
    pthread_mutex_unlock(&testMutex);
  }
  memset(buffer, 0, (size_t)entry->size);
  PRTP_PACKET rtp = (PRTP_PACKET)&buffer[rtpOffset];
  rtp->header = 0x90;
  rtp->packetType = 96;
  // The index in the script, which RtpvAddPacket() finds again (the first entries of a script are packets)
  rtp->sequenceNumber = BE16((uint16_t)index);
  servedBuffer[index] = buffer;
  servedUs[index] = PltGetMicroseconds();
  scriptPosition++;
  return entry->size;
}

int recvUdpSocket(SOCKET s, char* buffer, int size, bool useSelect, struct sockaddr_storage* remoteAddr,
                  SOCKADDR_LEN* addrLen) {
  (void)s;
  (void)useSelect;
  (void)remoteAddr;
  (void)addrLen;
  return serve(buffer, size, false);
}
int recvUdpSocketNoWait(SOCKET s, char* buffer, int size, bool* waited, int* socketCalls) {
  CHECK_EQ_INT(s, NO_WAIT_SOCKET);
  *waited = false;
  *socketCalls = 1;
  return serve(buffer, size, true);
}

static void addPackets(int count, int size) {
  for (int i = 0; i < count && scriptLength < MAX_ENTRIES; i++) {
    script[scriptLength].kind = ENTRY_PACKET;
    script[scriptLength].size = size;
    script[scriptLength].jumpUs = 0;
    scriptLength++;
  }
}

static void addEntry(int kind, uint64_t jumpUs) {
  script[scriptLength].kind = kind;
  script[scriptLength].size = 0;
  script[scriptLength].jumpUs = jumpUs;
  scriptLength++;
}

// ---- The decryption: copies the ciphertext; the call of one entry fails ----

static PLT_CRYPTO_CONTEXT cryptoContext;
static int failingDecryptIndex;
static int decryptCalls;
static int decryptFromOtherBuffer;
static int decryptIntoSlotBuffer;
// The buffer that the decryption of each entry wrote into
static unsigned char* decryptedInto[MAX_ENTRIES];

PPLT_CRYPTO_CONTEXT PltCreateCryptoContext(void) {
  return &cryptoContext;
}
void PltDestroyCryptoContext(PPLT_CRYPTO_CONTEXT ctx) {
  (void)ctx;
}
bool PltDecryptMessage(PPLT_CRYPTO_CONTEXT ctx, int algorithm, int flags, unsigned char* key, int keyLength,
                       unsigned char* iv, int ivLength, unsigned char* tag, int tagLength, unsigned char* inputData,
                       int inputDataLength, unsigned char* outputData, int* outputDataLength) {
  (void)ctx;
  (void)algorithm;
  (void)flags;
  (void)key;
  (void)keyLength;
  (void)iv;
  (void)ivLength;
  (void)tag;
  (void)tagLength;
  const int index = BE16(((PRTP_PACKET)inputData)->sequenceNumber);
  decryptCalls++;
  if (index < 0 || index >= scriptLength) {
    return false;
  }
  if (inputData != (unsigned char*)servedBuffer[index] + sizeof(ENC_VIDEO_HEADER)) {
    decryptFromOtherBuffer++;
  }
  if (outputData == (unsigned char*)servedBuffer[index]) {
    decryptIntoSlotBuffer++;
  }
  if (index == failingDecryptIndex) {
    return false;
  }
  decryptedInto[index] = outputData;
  memcpy(outputData, inputData, (size_t)inputDataLength);
  *outputDataLength = inputDataLength;
  return true;
}

// ---- The RTP queue, on the processing thread ----

// The packets that reached RtpvAddPacket(), queued or rejected (every rejectEvery-th one, if set, without freeing it:
// the buffer stays with the caller, as with the real queue)
static int queuedPackets;
static int rejectEvery;
static int rejectedPackets;
static int queuedOutOfOrder;
static int queuedTooEarly;
static int queuedInOtherBuffer;
static int queuedWithWrongLength;
static int lastQueuedIndex;
static bool noKeyframe;
static int queueWorkUs;
// Holds the first packet until released, so that the ring fills
static bool holdQueue;
static bool queueHeld;

static bool queueIsHeld(void) {
  return queueHeld;
}

static void releaseQueue(void) {
  pthread_mutex_lock(&testMutex);
  holdQueue = false;
  pthread_cond_broadcast(&testCond);
  pthread_mutex_unlock(&testMutex);
}

void RtpvInitializeQueue(PRTP_VIDEO_QUEUE queue) {
  (void)queue;
}
void RtpvCleanupQueue(PRTP_VIDEO_QUEUE queue) {
  (void)queue;
}
int RtpvAddPacket(PRTP_VIDEO_QUEUE queue, PRTP_PACKET packet, int length, PRTPV_QUEUE_ENTRY packetEntry,
                  uint64_t receiveTimeUs) {
  (void)queue;
  (void)packetEntry;
  const uint64_t nowUs = PltGetMicroseconds();
  const int index = packet->sequenceNumber;
  pthread_mutex_lock(&testMutex);
  queueThread = pthread_self();
  while (holdQueue) {
    queueHeld = true;
    pthread_cond_broadcast(&testCond);
    pthread_cond_wait(&testCond, &testMutex);
  }
  queueHeld = false;
  pthread_mutex_unlock(&testMutex);
  CHECK(index >= 0 && index < scriptLength);
  if (index < 0 || index >= scriptLength) {
    return RTPF_RET_REJECTED;
  }
  if (queuedPackets > 0 && index <= lastQueuedIndex) {
    queuedOutOfOrder++;
  }
  lastQueuedIndex = index;
  // Read after the receive returned, and before the processing thread got the packet
  if (receiveTimeUs < servedUs[index] || receiveTimeUs > nowUs) {
    queuedTooEarly++;
  }
  if ((EncryptionFeaturesEnabled & SS_ENC_VIDEO) == 0 ? (char*)packet != servedBuffer[index]
                                                      : (unsigned char*)packet != decryptedInto[index]) {
    queuedInOtherBuffer++;
  }
  if (length != FULL_PACKET) {
    queuedWithWrongLength++;
  }
  if (!noKeyframe) {
    notifyKeyFrameReceived();
  }
  if (queueWorkUs > 0) {
    const uint64_t endUs = nowUs + (uint64_t)queueWorkUs;
    while (PltGetMicroseconds() < endUs) {
    }
  }
  const bool reject = rejectEvery > 0 && (index + 1) % rejectEvery == 0;
  if (!reject) {
    free(packet);
  }
  pthread_mutex_lock(&testMutex);
  handedToQueue[index] = true;
  queuedPackets++;
  if (reject) {
    rejectedPackets++;
  }
  pthread_cond_broadcast(&testCond);
  pthread_mutex_unlock(&testMutex);
  return reject ? RTPF_RET_REJECTED : RTPF_RET_QUEUED;
}
uint32_t RtpvGetCurrentFrameNumber(PRTP_VIDEO_QUEUE queue) {
  (void)queue;
  return 0;
}
void initializeVideoDepacketizer(int pktSize) {
  (void)pktSize;
}
void destroyVideoDepacketizer(void) {
}
void stopVideoDepacketizer(void) {
}
bool LiWaitForNextVideoFrame(VIDEO_FRAME_HANDLE* frameHandle, PDECODE_UNIT* decodeUnit) {
  (void)frameHandle;
  (void)decodeUnit;
  return false;
}
void LiCompleteVideoFrame(VIDEO_FRAME_HANDLE handle, int drStatus) {
  (void)handle;
  (void)drStatus;
}

// ---- The renderer ----

static int rendererSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags) {
  (void)videoFormat;
  (void)width;
  (void)height;
  (void)redrawRate;
  (void)context;
  (void)drFlags;
  return 0;
}
static void rendererStart(void) {
}
static void rendererStop(void) {
}
static void rendererCleanup(void) {
  event("cleanup", NULL);
}

// ---- A stream ----

static void onWatchdog(int signal) {
  (void)signal;
  static const char message[] = "  # FAILED: the case didn't end within 60 s (a thread that is never woken?)\n";
  if (write(STDOUT_FILENO, message, sizeof(message) - 1) < 0) {
    _exit(2);
  }
  _exit(1);
}

static void resetStream(void) {
  alarm(60);
  memset(lines, 0, sizeof(lines));
  lineCount = 0;
  linesTooLong = 0;
  terminations = 0;
  terminationError = 0;
  memset(events, 0, sizeof(events));
  scriptLength = 0;
  scriptPosition = 0;
  receivesAfterScript = 0;
  memset(servedBuffer, 0, sizeof(servedBuffer));
  memset(decryptedInto, 0, sizeof(decryptedInto));
  rtpOffset = 0;
  timeoutWorks = true;
  noWaitWorks = true;
  readerWoken = false;
  holdsBegun = 0;
  holdsEnded = 0;
  holdReleased = false;
  closeCalls = 0;
  memset(handedToQueue, 0, sizeof(handedToQueue));
  checkBusyBuffers = false;
  servedIntoBusyBuffer = 0;
  rejectEvery = 0;
  rejectedPackets = 0;
  __atomic_store_n(&clockJumpUs, 0, __ATOMIC_SEQ_CST);
  failingDecryptIndex = -1;
  decryptCalls = 0;
  decryptFromOtherBuffer = 0;
  decryptIntoSlotBuffer = 0;
  queuedPackets = 0;
  queuedOutOfOrder = 0;
  queuedTooEarly = 0;
  queuedInOtherBuffer = 0;
  queuedWithWrongLength = 0;
  lastQueuedIndex = -1;
  noKeyframe = false;
  queueWorkUs = 0;
  holdQueue = false;
  queueHeld = false;
  failingThread = NULL;
  afterReaderJoined = NULL;
  failWhenTheRingIsFull = false;
  memset(&ListenerCallbacks, 0, sizeof(ListenerCallbacks));
  ListenerCallbacks.logMessage = captureLine;
  ListenerCallbacks.connectionTerminated = connectionTerminated;
  memset(&VideoCallbacks, 0, sizeof(VideoCallbacks));
  VideoCallbacks.setup = rendererSetup;
  VideoCallbacks.start = rendererStart;
  VideoCallbacks.stop = rendererStop;
  VideoCallbacks.cleanup = rendererCleanup;
  memset(&StreamConfig, 0, sizeof(StreamConfig));
  StreamConfig.packetSize = 1392;
  StreamConfig.width = 3840;
  StreamConfig.height = 2160;
  StreamConfig.fps = 60;
  memset(&RemoteAddr, 0, sizeof(RemoteAddr));
  RemoteAddr.ss_family = AF_INET;
  memset(&LocalAddr, 0, sizeof(LocalAddr));
  LocalAddr.ss_family = AF_INET;
  AddrLen = sizeof(struct sockaddr_in);
  AppVersionQuad[0] = 7;
  NegotiatedVideoFormat = VIDEO_FORMAT_H264;
  EncryptionFeaturesEnabled = 0;
  VideoPortNumber = 47998;
}

// The stop, and what every stop leaves: the ring freed, the socket closed once, every packet that reached the queue in
// order, with a time between its receive and its processing, in its own buffer (plain) or the decrypted one
static void stopStream(void) {
  stopVideoStream();
  destroyVideoStream();
  alarm(0);
  CHECK_EQ_INT(mutexesAlive, 0);
  CHECK(receiveRing.slots == NULL);
  // (a socket that never waits replaced the first one, which was closed then)
  CHECK_EQ_INT(closeCalls, timeoutWorks || !noWaitWorks ? 1 : 2);
  CHECK_EQ_INT(queuedOutOfOrder, 0);
  CHECK_EQ_INT(queuedTooEarly, 0);
  CHECK_EQ_INT(queuedInOtherBuffer, 0);
  CHECK_EQ_INT(queuedWithWrongLength, 0);
  CHECK_EQ_INT(servedIntoBusyBuffer, 0);
  CHECK_EQ_INT(linesTooLong, 0);
  if (test_current_failed) {
    printf("  # events: %s\n", events);
    printLines();
  }
}

static int queuedSoFar;
static bool queuedReached(void) {
  return queuedPackets >= queuedSoFar;
}

static bool processorWaitsForPackets(void) {
  pthread_mutex_lock(&receiveRing.mutex);
  const bool waiting = receiveRing.processorWaiting;
  pthread_mutex_unlock(&receiveRing.mutex);
  return waiting;
}

static bool readerWaitsForRoom(void) {
  pthread_mutex_lock(&receiveRing.mutex);
  const bool waiting = receiveRing.readerWaiting;
  pthread_mutex_unlock(&receiveRing.mutex);
  return waiting;
}

// Waits (testMutex not held) until the RTP queue got `count` packets
static bool waitForQueued(int count) {
  pthread_mutex_lock(&testMutex);
  queuedSoFar = count;
  const bool reached = waitUntil(queuedReached);
  pthread_mutex_unlock(&testMutex);
  return reached;
}

// Waits up to 10 s for a condition of the ring
static bool waitForRing(bool (*condition)(void)) {
  for (int i = 0; i < 10000; i++) {
    if (condition()) {
      return true;
    }
    usleep(1000);
  }
  return false;
}

static bool hasProcessLine(void) {
  return findLine(PROCESS_LINE) >= 0;
}

static bool hasStreamLine(void) {
  return findLine(STREAM_LINE) >= 0;
}

static bool terminated(void) {
  return terminations > 0;
}

// ---- The cases ----

static void test_every_packet_reaches_the_queue_in_order_with_its_read_time_and_its_buffer(void) {
  // The queue rejects every 5th packet: its buffer stays with the processing thread, which puts it into the next slot,
  // and the reader never receives into the buffer of a packet that is still on its way (no buffer in two slots)
  resetStream();
  addPackets(20000, FULL_PACKET);
  rejectEvery = 5;
  checkBusyBuffers = true;
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  CHECK(waitForQueued(20000));
  stopStream();
  CHECK_EQ_INT(queuedPackets, 20000);
  CHECK_EQ_INT(rejectedPackets, 4000);
  CHECK_EQ_INT(terminations, 0);
  checkEvents("bind:1000 create:VideoProc create:VideoRecv create:VideoDec create:VideoPing join:VideoPing "
              "join:VideoRecv join:VideoProc join:VideoDec close:1000 cleanup");
  // Both threads summed the stream up: the reader read and the processing thread took the 20,000 packets
  const int stream = findLine(STREAM_LINE);
  const int process = findLine(PROCESS_LINE);
  CHECK(stream >= 0 && process >= 0);
  if (stream >= 0 && process >= 0) {
    CHECK(strstr(lines[stream], ": 20000 packets, ") != NULL);
    CHECK_EQ_INT(numberAfter(strstr(lines[process], " s: "), " s: "), 20000);
    CHECK(strstr(lines[process], " of 8 packets, full ") != NULL);
  }
}

static void test_encrypted_video_is_decrypted_from_the_slot_into_another_buffer(void) {
  resetStream();
  EncryptionFeaturesEnabled = SS_ENC_VIDEO;
  rtpOffset = (int)sizeof(ENC_VIDEO_HEADER);
  addPackets(2000, FULL_PACKET + (int)sizeof(ENC_VIDEO_HEADER));
  failingDecryptIndex = 7;
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  CHECK(waitForQueued(1999));
  stopStream();
  CHECK_EQ_INT(queuedPackets, 1999);
  CHECK_EQ_INT(decryptCalls, 2000);
  CHECK_EQ_INT(decryptFromOtherBuffer, 0);
  CHECK_EQ_INT(decryptIntoSlotBuffer, 0);
  CHECK_EQ_INT(countLines("Failed to decrypt video packet!\n"), 1);
  CHECK_EQ_INT(terminations, 0);
}

static void test_a_full_ring_makes_the_reader_wait_and_loses_nothing(void) {
  // A queue that takes 200 us for each packet (and rejects every 5th), and a reader that reads them at once: the ring
  // of 8 is full again and again, and the reader waits for room each time
  resetStream();
  addPackets(4000, FULL_PACKET);
  queueWorkUs = 200;
  rejectEvery = 5;
  checkBusyBuffers = true;
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  CHECK(waitForQueued(4000));
  stopStream();
  CHECK_EQ_INT(queuedPackets, 4000);
  CHECK_EQ_INT(rejectedPackets, 800);
  const int process = findLine(PROCESS_LINE);
  const int stream = findLine(STREAM_LINE);
  CHECK(process >= 0 && stream >= 0);
  if (process >= 0) {
    CHECK(strstr(lines[process], "; ring up to 8 of 8 packets, full ") != NULL);
    CHECK(numberAfter(lines[process], "of 8 packets, full ") > 0);
    // The processing thread had work most of the time
    CHECK(numberAfter(lines[process], " idle ") < 50);
  }
  if (stream >= 0) {
    // The reader waited for room before about every 8th packet, for the 8 packets of the batch before (1.6 ms): its
    // other work per packet leaves those waits out, or it would be about the 200 us of the queue per packet
    const double otherUs = numberBefore(lines[stream], " us of other work per packet");
    CHECK(otherUs >= 0 && otherUs < 100);
  }
}

static void letTheQueueGo(void) {
  releaseQueue();
}

static void test_the_stop_wakes_a_reader_that_waits_for_room(void) {
  // The queue holds the first packet, the reader fills the ring and waits for room; the stop wakes it (the queue goes
  // on only once the reader was joined, so the stop of the ring alone must end its wait)
  resetStream();
  addPackets(100, FULL_PACKET);
  holdQueue = true;
  afterReaderJoined = letTheQueueGo;
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  pthread_mutex_lock(&testMutex);
  CHECK(waitUntil(queueIsHeld));
  pthread_mutex_unlock(&testMutex);
  CHECK(waitForRing(readerWaitsForRoom));
  stopStream();
  // The reader read the 8 packets that fill the ring (the processing thread holds the slots of its batch until it is
  // done with them) and waited for room before it read the next
  CHECK_EQ_INT(scriptPosition, VIDEO_RECV_RING_PACKETS);
  // The processing thread finished its batch, then ended at the stop of the ring
  CHECK(queuedPackets >= 1 && queuedPackets <= VIDEO_RECV_RING_PACKETS);
  CHECK(countLines(PROCESS_LINE) == 1);
  CHECK(countLines(STREAM_LINE) == 1);
}

static void test_the_stop_wakes_a_processing_thread_that_waits_for_packets(void) {
  // The reader is in its receive timeouts after 100 packets, the processing thread waits for packets
  resetStream();
  addPackets(100, FULL_PACKET);
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  CHECK(waitForQueued(100));
  CHECK(waitForRing(processorWaitsForPackets));
  // It waits for 200 ms more, which its line counts as idle time
  usleep(200000);
  const uint64_t stopStartUs = PltGetMicroseconds();
  stopStream();
  const uint64_t stopUs = PltGetMicroseconds() - stopStartUs;
  CHECK(stopUs < 1000000);
  CHECK_EQ_INT(queuedPackets, 100);
  CHECK(receivesAfterScript > 0);
  const int process = findLine(PROCESS_LINE);
  CHECK(process >= 0);
  if (process >= 0) {
    CHECK_EQ_INT(numberAfter(strstr(lines[process], " s: "), " s: "), 100);
    CHECK(numberAfter(lines[process], " idle ") >= 50);
  }
}

static void test_the_wait_for_the_first_packet_is_no_idle_time(void) {
  // The reader times out 90 times (about 100 ms, and 9 of the 10 s without video) before the first packet, then reads
  // 400 packets at once, each of which takes the queue 200 us: the processing thread is busy for 80 ms from its first
  // packet on, and the stop comes right after the last one, so its idle share stays low; the wait for the first
  // packet doesn't count (the figures start with it), or the share would be 100 %
  resetStream();
  for (int i = 0; i < 90; i++) {
    addEntry(ENTRY_TIMEOUT, 0);
  }
  addPackets(400, FULL_PACKET);
  queueWorkUs = 200;
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  CHECK(waitForQueued(400));
  stopStream();
  CHECK_EQ_INT(queuedPackets, 400);
  CHECK_EQ_INT(terminations, 0);
  const int process = findLine(PROCESS_LINE);
  CHECK(process >= 0);
  if (process >= 0) {
    CHECK_EQ_INT(numberAfter(strstr(lines[process], " s: "), " s: "), 400);
    CHECK(numberAfter(lines[process], " idle ") < 50);
  }
}

static void test_packets_a_millisecond_apart_make_the_processing_thread_wait_and_the_reader_wake_it(void) {
  // 100 packets about 1 ms apart (a receive timeout of the stand-in between them): after each packet the processing
  // thread finds the ring empty and waits at once, and the next packet wakes it. Its line shows a high idle share, no
  // looking share (the test version of 2.3.5 looked again for packets for at least 0.1 ms before it waited, on the
  // CPU), and a wake for nearly every packet
  resetStream();
  for (int i = 0; i < 100; i++) {
    addPackets(1, FULL_PACKET);
    addEntry(ENTRY_TIMEOUT, 0);
  }
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  CHECK(waitForQueued(100));
  stopStream();
  CHECK_EQ_INT(queuedPackets, 100);
  CHECK_EQ_INT(terminations, 0);
  const int process = findLine(PROCESS_LINE);
  CHECK(process >= 0);
  if (process >= 0) {
    CHECK(numberAfter(lines[process], " idle ") >= 50);
    CHECK(strstr(lines[process], "looking") == NULL);
    CHECK(strstr(lines[process], "%: up to ") != NULL);
    CHECK(numberBefore(lines[process], " wakes\n") >= 50);
  }
}

// The hold that the test waits for (counted from 1)
static int holdOfTheTest;

static bool readerHoldsInItsRead(void) {
  return holdsBegun >= holdOfTheTest;
}

static bool readerLeftItsRead(void) {
  return holdsEnded >= holdOfTheTest;
}

// Waits until the reader is in the read of hold `hold`, or (leave) until it left it
static bool waitForHold(int hold, bool leave) {
  pthread_mutex_lock(&testMutex);
  holdOfTheTest = hold;
  const bool reached = waitUntil(leave ? readerLeftItsRead : readerHoldsInItsRead);
  pthread_mutex_unlock(&testMutex);
  return reached;
}

// Lets the reader go on from the hold it waits in, and waits until it left hold `hold`
static bool releaseHold(int hold) {
  pthread_mutex_lock(&testMutex);
  holdReleased = true;
  pthread_cond_broadcast(&testCond);
  pthread_mutex_unlock(&testMutex);
  return waitForHold(hold, true);
}

// Waits up to 3 s (testMutex not held) until the RTP queue got `count` packets
static bool waitForQueuedSoon(int count) {
  for (int i = 0; i < 3000; i++) {
    pthread_mutex_lock(&testMutex);
    const bool reached = queuedPackets >= count;
    pthread_mutex_unlock(&testMutex);
    if (reached) {
      return true;
    }
    usleep(1000);
  }
  return false;
}

static void test_no_packet_waits_in_the_ring_while_the_reader_waits_for_the_socket_in_each_mode(void) {
  // Bursts of 1, 37 and 300 packets, each followed by a read that waits for the socket (the receive timeout of 100 ms,
  // the poll() before each receive, or the poll() of a socket that never waits once none is waiting): while the reader
  // waits there, the processing thread must have every packet of the burst and wait with the ring empty, since the reader
  // woke it for the first packet it published after it began to wait. A hand-over that woke it only for a batch of
  // packets would leave the last packets of a frame in the ring until the next frame. Each burst starts once the
  // processing thread waits (the reader waits in a read before it too), so that its first packet must wake it. Then the
  // stop while the reader waits in its read and the processing thread waits for packets: both end, and the line counts
  // every packet
  static const char* const modes[3] = { "receive timeout", "poll() before each receive", "socket that never waits" };
  static const int bursts[3] = { 1, 37, 300 };
  for (int mode = 0; mode < 3; mode++) {
    resetStream();
    timeoutWorks = mode == 0;
    noWaitWorks = mode == 2;
    addEntry(ENTRY_HOLD, 0);
    for (int b = 0; b < 3; b++) {
      addPackets(bursts[b], FULL_PACKET);
      addEntry(ENTRY_HOLD, 0);
    }
    initializeVideoStream();
    CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
    // The first burst comes once the processing thread waits for its first packet
    CHECK(waitForHold(1, false));
    CHECK(waitForRing(processorWaitsForPackets));
    CHECK(releaseHold(1));
    int total = 0;
    int wrong = 0;
    for (int b = 0; b < 3; b++) {
      total += bursts[b];
      CHECK(waitForHold(b + 2, false));
      // The reader waits for the socket: within 3 s every packet of the burst reaches the queue, and the processing
      // thread waits with nothing left in the ring, while the reader still waits in its read
      const bool queued = waitForQueuedSoon(total);
      const bool waiting = waitForRing(processorWaitsForPackets);
      PltLockMutex(&receiveRing.mutex);
      const uint32_t left = receiveRing.head - receiveRing.tail;
      const bool processorWaiting = receiveRing.processorWaiting;
      PltUnlockMutex(&receiveRing.mutex);
      pthread_mutex_lock(&testMutex);
      const bool stillInItsRead = holdsEnded < b + 2;
      const int queuedNow = queuedPackets;
      pthread_mutex_unlock(&testMutex);
      if (!queued || !waiting || !processorWaiting || left != 0 || !stillInItsRead) {
        if (wrong++ == 0) {
          printf("  # %s, burst of %d: %d of %d packets queued, the processing thread waits %d, %u packets left in the "
                 "ring, the reader in its read %d\n", modes[mode], bursts[b], queuedNow, total, processorWaiting,
                 left, stillInItsRead);
        }
      }
      if (b < 2) {
        // (the processing thread waits: the next burst starts with a wait of it)
        CHECK(releaseHold(b + 2));
      }
    }
    CHECK_EQ_INT(wrong, 0);
    // The stop while the reader waits for the socket after the last burst and the processing thread waits for packets
    stopStream();
    CHECK_EQ_INT(queuedPackets, total);
    CHECK_EQ_INT(terminations, 0);
    const int process = findLine(PROCESS_LINE);
    CHECK(process >= 0);
    if (process >= 0) {
      CHECK_EQ_INT(numberAfter(strstr(lines[process], " s: "), " s: "), total);
    }
    if (test_current_failed) {
      printf("  # (the mode: %s)\n", modes[mode]);
    }
  }
}

static void test_the_reader_of_a_socket_that_never_waits_is_woken_at_the_stop_and_at_a_failed_start(void) {
  // The stop: the reader waits in its read after the script
  resetStream();
  timeoutWorks = false;
  addPackets(100, FULL_PACKET);
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  CHECK(waitForQueued(100));
  CHECK(waitForRing(processorWaitsForPackets));
  stopStream();
  checkEvents("bind:1000 nowait:1001 close:1000 create:VideoProc create:VideoRecv create:VideoDec create:VideoPing "
              "wake:1001 join:VideoPing join:VideoRecv join:VideoProc join:VideoDec close:1001 cleanup");
  // The three starts that fail after the reader started (the decoder thread, the TCP socket of a host of GFE 3, the
  // ping thread): each wakes the reader, joins both threads and frees the ring. They fail while the queue holds the
  // first packet and the reader waits for room in the full ring, which only the stop of the ring ends (the queue goes
  // on once the reader was joined)
  const char* const expected[3] = {
    "bind:1000 nowait:1001 close:1000 create:VideoProc create:VideoRecv fail:VideoDec wake:1001 join:VideoRecv "
    "join:VideoProc close:1001 cleanup",
    "bind:1000 nowait:1001 close:1000 create:VideoProc create:VideoRecv create:VideoDec connect wake:1001 "
    "join:VideoRecv join:VideoProc join:VideoDec close:1001 cleanup",
    "bind:1000 nowait:1001 close:1000 create:VideoProc create:VideoRecv create:VideoDec fail:VideoPing wake:1001 "
    "join:VideoRecv join:VideoProc join:VideoDec close:1001 cleanup",
  };
  for (int failure = 0; failure < 3; failure++) {
    resetStream();
    timeoutWorks = false;
    addPackets(50, FULL_PACKET);
    holdQueue = true;
    afterReaderJoined = letTheQueueGo;
    failWhenTheRingIsFull = true;
    if (failure == 1) {
      AppVersionQuad[0] = 3;
    }
    else {
      failingThread = failure == 0 ? "VideoDec" : "VideoPing";
    }
    initializeVideoStream();
    CHECK(startVideoStream(NULL, 0) != 0);
    destroyVideoStream();
    alarm(0);
    checkEvents(expected[failure]);
    CHECK_EQ_INT(mutexesAlive, 0);
    CHECK(receiveRing.slots == NULL);
    CHECK_EQ_INT(closeCalls, 2);
    // The reader stopped at the full ring
    CHECK_EQ_INT(scriptPosition, VIDEO_RECV_RING_PACKETS);
  }
}

static void test_the_first_frame_limit_ends_the_stream_on_the_processing_thread_by_the_read_times(void) {
  // No keyframe; the clock jumps by 11 s before the 51st packet returns: the processing thread ends the stream at that
  // packet, by the time the reader read it, and the reader ends at its next packet
  resetStream();
  noKeyframe = true;
  addPackets(50, FULL_PACKET);
  addPackets(1, FULL_PACKET);
  script[50].jumpUs = 11000000;
  addPackets(2000, FULL_PACKET);
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  pthread_mutex_lock(&testMutex);
  CHECK(waitUntil(terminated));
  // Both threads end on their own: the reader's line once it saw the stop of the ring
  CHECK(waitUntil(hasStreamLine));
  CHECK(waitUntil(hasProcessLine));
  pthread_mutex_unlock(&testMutex);
  stopStream();
  CHECK_EQ_INT(terminations, 1);
  CHECK_EQ_INT(terminationError, ML_ERROR_NO_VIDEO_FRAME);
  CHECK(pthread_equal(terminationThread, queueThread));
  CHECK_EQ_INT(countLines("Terminating connection due to lack of a successful video frame\n"), 1);
  CHECK_EQ_INT(queuedPackets, 50);
  // The reader read at most a ring and two packets more after the 51st
  CHECK(scriptPosition >= 51 && scriptPosition <= 51 + VIDEO_RECV_RING_PACKETS + 2);
}

static void test_no_video_for_10_s_ends_the_stream(void) {
  // 100 timeouts of the receive (each counts as 100 ms): the reader ends the stream; the processing thread, which waits
  // for packets, ends with it
  resetStream();
  for (int i = 0; i < 120; i++) {
    addEntry(ENTRY_TIMEOUT, 0);
  }
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  pthread_mutex_lock(&testMutex);
  CHECK(waitUntil(terminated));
  pthread_mutex_unlock(&testMutex);
  stopStream();
  CHECK_EQ_INT(terminations, 1);
  CHECK_EQ_INT(terminationError, ML_ERROR_NO_VIDEO_TRAFFIC);
  CHECK_EQ_INT(countLines("Terminating connection due to lack of video traffic\n"), 1);
  CHECK_EQ_INT(countLines("No video traffic was ever received from the host!\n"), 1);
  CHECK_EQ_INT(scriptPosition, 100);
  CHECK_EQ_INT(countLines(PROCESS_LINE), 0);
  CHECK_EQ_INT(queuedPackets, 0);
}

static void test_after_a_socket_error_the_processing_thread_takes_what_is_left(void) {
  // A slow queue, so that the ring is full when the error ends the reader
  resetStream();
  addPackets(500, FULL_PACKET);
  addEntry(ENTRY_ERROR, 0);
  queueWorkUs = 200;
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  pthread_mutex_lock(&testMutex);
  CHECK(waitUntil(terminated));
  // The processing thread ends on its own once the ring is empty
  CHECK(waitUntil(hasProcessLine));
  pthread_mutex_unlock(&testMutex);
  CHECK_EQ_INT(queuedPackets, 500);
  stopStream();
  CHECK_EQ_INT(terminationError, ENETDOWN);
  const int stream = findLine(STREAM_LINE);
  const int process = findLine(PROCESS_LINE);
  CHECK(stream >= 0 && process > stream);
  if (stream >= 0 && process >= 0) {
    CHECK(strstr(lines[stream], ": 500 packets, ") != NULL);
    CHECK_EQ_INT(numberAfter(strstr(lines[process], " s: "), " s: "), 500);
  }
}

static void test_a_failed_start_of_the_reader_stops_and_joins_the_processing_thread(void) {
  for (int noWait = 0; noWait <= 1; noWait++) {
    resetStream();
    timeoutWorks = noWait == 0;
    failingThread = "VideoRecv";
    initializeVideoStream();
    CHECK(startVideoStream(NULL, 0) != 0);
    destroyVideoStream();
    alarm(0);
    checkEvents(noWait ? "bind:1000 nowait:1001 close:1000 create:VideoProc fail:VideoRecv join:VideoProc close:1001 cleanup"
                       : "bind:1000 create:VideoProc fail:VideoRecv join:VideoProc close:1000 cleanup");
    CHECK_EQ_INT(mutexesAlive, 0);
    CHECK(receiveRing.slots == NULL);
    CHECK_EQ_INT(closeCalls, noWait ? 2 : 1);
    CHECK_EQ_INT(countLines(PROCESS_LINE), 0);
  }
}

int main(void) {
  signal(SIGALRM, onWatchdog);
  RUN_TEST("every packet reaches the queue on the processing thread in order, with its read time and in its buffer, and "
           "the buffer of a rejected one is used again, never while its packet is on its way",
           test_every_packet_reaches_the_queue_in_order_with_its_read_time_and_its_buffer);
  RUN_TEST("encrypted video is decrypted from the buffer of its slot into another one, and a failed one is logged",
           test_encrypted_video_is_decrypted_from_the_slot_into_another_buffer);
  RUN_TEST("a full ring makes the reader wait and loses nothing, and the reader's waits are not its work",
           test_a_full_ring_makes_the_reader_wait_and_loses_nothing);
  RUN_TEST("the stop wakes a reader that waits for room", test_the_stop_wakes_a_reader_that_waits_for_room);
  RUN_TEST("the stop wakes a processing thread that waits for packets, within a second, and its wait is idle time",
           test_the_stop_wakes_a_processing_thread_that_waits_for_packets);
  RUN_TEST("the wait for the first packet is no idle time of the processing thread",
           test_the_wait_for_the_first_packet_is_no_idle_time);
  RUN_TEST("packets a millisecond apart make the processing thread wait at once, and the reader wake it for each",
           test_packets_a_millisecond_apart_make_the_processing_thread_wait_and_the_reader_wake_it);
  RUN_TEST("no packet waits in the ring while the reader waits for the socket after a burst, in each receive mode, and "
           "the stop while both wait",
           test_no_packet_waits_in_the_ring_while_the_reader_waits_for_the_socket_in_each_mode);
  RUN_TEST("the reader of a socket that never waits is woken at the stop and at the three failed starts after it",
           test_the_reader_of_a_socket_that_never_waits_is_woken_at_the_stop_and_at_a_failed_start);
  RUN_TEST("the limit of 10 s for the first frame ends the stream on the processing thread, by the read times",
           test_the_first_frame_limit_ends_the_stream_on_the_processing_thread_by_the_read_times);
  RUN_TEST("no video for 10 s ends the stream, and the processing thread with it", test_no_video_for_10_s_ends_the_stream);
  RUN_TEST("after a socket error the processing thread takes what the ring holds, then ends",
           test_after_a_socket_error_the_processing_thread_takes_what_is_left);
  RUN_TEST("a failed start of the reader stops and joins the processing thread and frees the ring",
           test_a_failed_start_of_the_reader_stops_and_joins_the_processing_thread);
  return test_summary();
}
