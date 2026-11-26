// Checks the video receive loop of moonlight-common-c (VideoReceiveThreadProc() and startVideoStream() of
// moonlight-common-c/src/VideoStream.c, included directly) and the lines that it logs since 2.3.4, which tell whether
// the receive thread or the network sets the pace at which the packets of a frame are read:
//  - the mode at the start: one recvfrom() per packet where the socket takes a receive timeout (SO_RCVTIMEO); a poll()
//    before each recvfrom() where it takes none and no socket that never waits can be made; and the back-to-back reads
//    of a socket that never waits (bindUdpSocketNoWait(), recvUdpSocketNoWait()), which replaces the first socket in
//    startVideoStream() before any thread starts, so that a packet that is waiting takes one call and poll() comes
//    only when none is;
//  - the socket calls per packet in each mode, the sample of about every 64th receive (the gaps between the samples
//    drawn by nextVideoReceiveSampleGap(), so that the sample doesn't keep falling on the same packet of frames of one
//    size), the poll() without a timeout before a sample that tells whether its packet was waiting (a failed one leaves
//    it unknown, an error of the socket is no packet waiting) and its time, the clock reads around the sample, the
//    share of waiting packets and the times of the lines, and from them the rate at which the thread could take packets
//    that are waiting, with the headers of IPv4 or IPv6;
//  - what stays as it was: the limit of 10 s without a first packet in every mode, an error that ends the stream, the
//    stop, encrypted video (the read goes to the buffer of the encrypted packet, the bytes count as received);
//  - the wake of a receive thread that reads a socket that never waits before each join (wakeUdpSocketReader()), at the
//    stop and when the start fails after the thread started;
//  - one line a minute while video comes, also when it ends during a pause of the video, none for a minute without
//    packets, one for the whole stream at the end and one for the poll() calls of the samples, each shorter than a line
//    of the diagnostic log keeps and without an address.
// Since 2.3.5 the receive thread (the reader) only reads the packets into the slots of a ring and notes when it read
// each one; the processing thread (VideoProcessThreadProc()) does the rest. So also:
//  - the processing thread gets every packet in order with the time the reader read it, which RtpvAddPacket() is
//    given, and a plain packet in the very buffer it was received into (no copy); encrypted video is decrypted from the
//    buffer of the slot into a buffer of that thread;
//  - the other work per packet of the reader is no longer the work of the RTP queue, and the rate of its lines counts
//    the clock read per packet; the processing thread has its own lines (one a minute of its time, one for the stream);
//  - the limit of 10 s for the first frame runs on the processing thread, by the read times;
//  - the start creates the processing thread before the reader, every stop and failed start stops the ring, joins both
//    and frees the ring;
//  - a plain packet that the RTP queue rejects (a surplus parity packet of a block it completed, a late or a duplicate
//    packet) leaves its buffer with the processing thread, which puts it into the slot of the next packet: no buffer is
//    in two slots and none is lost; an encrypted one leaves the buffer it was decrypted into for the next decryption;
//  - the lines of the processing thread from chosen figures: the work per packet from the time it was busy, the idle
//    share and the part of it that it looked again for packets, the rate, and the counts of the ring of the minute.
//
// The socket, the RTP queue, the threads, the mutexes, the decryption and the clock are stand-ins: the receive calls
// follow a script of entries (a packet, whether it was waiting and how long its receive took; a timeout; an error), the
// clock is a test clock that each read moves on by clockStepUs, a receive by the time of its entry, the poll() of a
// sample by pollUs and the RTP queue by workUs (and the extra work of the entry), and a thread is never run: the test
// calls the entry of the receive thread itself until the script is used up, then that of the processing thread, which
// finds every packet in the ring (it holds them all here; a wait on a condition variable would mean that the test
// lost track of the threads). tests/native/video_receive_threads_test.c runs the two threads for real.

#include "test_support_c.h"

// A ring that takes every packet of a script, so that the reader never waits for the processing thread
#define VIDEO_RECV_RING_PACKETS 32768

#include "../../moonlight-common-c/src/VideoStream.c"

#include <errno.h>
#include <stdarg.h>
#include <string.h>

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

// ---- The log ----

#define MAX_LINES 128
static char lines[MAX_LINES][512];
// The receive calls made when each line was logged
static int lineReceiveCalls[MAX_LINES];
static int lineCount;
// Every line of the receive thread that any case logged, for the check of their length and content
static int receiveLinesSeen;
static int receiveLinesTooLong;
static int receiveLinesWithAddress;
static int receiveCalls;

static bool hasDottedAddress(const char* text) {
  for (const char* c = text; *c != 0; c++) {
    int a, b, d, e;
    char tail;
    if ((c == text || !(c[-1] >= '0' && c[-1] <= '9')) && sscanf(c, "%d.%d.%d.%d%c", &a, &b, &d, &e, &tail) >= 4) {
      return true;
    }
  }
  return false;
}

static void captureLine(const char* format, ...) {
  char line[512];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  if (strncmp(line, "Video receive", 13) == 0 || strncmp(line, "Video processing", 16) == 0) {
    receiveLinesSeen++;
    if (strlen(line) >= 240) {
      receiveLinesTooLong++;
    }
    if (hasDottedAddress(line)) {
      receiveLinesWithAddress++;
    }
  }
  if (lineCount < MAX_LINES) {
    snprintf(lines[lineCount], sizeof(lines[lineCount]), "%s", line);
    lineReceiveCalls[lineCount] = receiveCalls;
    lineCount++;
  }
}

static void printLines(void) {
  for (int i = 0; i < lineCount; i++) {
    printf("  #   logged: %s", lines[i]);
  }
}

// The index of the first line from `from` on that starts with the text, or -1
static int findLineFrom(int from, const char* start) {
  for (int i = from; i < lineCount; i++) {
    if (strncmp(lines[i], start, strlen(start)) == 0) {
      return i;
    }
  }
  return -1;
}

static int findLine(const char* start) {
  return findLineFrom(0, start);
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

static bool hasLine(const char* text) {
  for (int i = 0; i < lineCount; i++) {
    if (strcmp(lines[i], text) == 0) {
      return true;
    }
  }
  return false;
}

static void checkLine(const char* expected) {
  if (!hasLine(expected)) {
    printf("  # expected the line: %s", expected);
  }
  CHECK(hasLine(expected));
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

// The texts of the receive mode, as VideoReceiveThreadProc() is to log them
#define MODE_TIMEOUT "Video receive mode: one recvfrom() per packet with a receive timeout of 100 ms; back-to-back reads off (not needed)\n"
#define MODE_POLL "Video receive mode: no receive timeout, poll() before each recvfrom(); back-to-back reads off (no socket that never waits)\n"
#define MODE_NO_WAIT "Video receive mode: no receive timeout, socket that never waits; back-to-back reads on (poll() only when no packet is waiting)\n"
#define POLL_LINE "Video Receive: SO_RCVTIMEO unsupported, polling before each receive\n"
#define STREAM_LINE "Video receive of the stream, "
#define MINUTE_LINE "Video receive, last "
#define CHECK_LINE "Video receive check of the stream: "
#define CHECK_FAILED_LINE "Video receive check: poll() without a timeout failed: "
#define PROCESS_LINE "Video processing of the stream, "
#define PROCESS_MINUTE_LINE "Video processing, last "

// ---- The script of the receive calls ----

#define ENTRY_PACKET 0
#define ENTRY_TIMEOUT 1
#define ENTRY_ERROR 2

typedef struct {
  int kind;
  int size;              // bytes of a packet
  bool waiting;          // whether the packet was waiting when the thread asked for it
  uint64_t receiveUs;    // what the receive call takes on the test clock
  uint64_t extraWorkUs;  // what the RTP queue takes for it on top of workUs
  int socketCalls;       // the calls that recvUdpSocketNoWait() reports
  int error;             // the errno of an error
} ENTRY;

#define MAX_ENTRIES 32768
static ENTRY script[MAX_ENTRIES];
static int scriptLength;
static int scriptPosition;

static void addEntry(int kind, int size, bool waiting, uint64_t receiveUs, int socketCalls, int error) {
  CHECK(scriptLength < MAX_ENTRIES);
  if (scriptLength >= MAX_ENTRIES) {
    return;
  }
  ENTRY* entry = &script[scriptLength++];
  entry->kind = kind;
  entry->size = size;
  entry->waiting = waiting;
  entry->receiveUs = receiveUs;
  entry->extraWorkUs = 0;
  entry->socketCalls = socketCalls;
  entry->error = error;
}

static void addPacket(int size, bool waiting, uint64_t receiveUs, int socketCalls) {
  addEntry(ENTRY_PACKET, size, waiting, receiveUs, socketCalls, 0);
}

static void addTimeouts(int count, uint64_t receiveUs) {
  for (int i = 0; i < count; i++) {
    // A poll() timeout after a read that found nothing, for a socket that never waits
    addEntry(ENTRY_TIMEOUT, 0, false, receiveUs, 2, 0);
  }
}

// ---- The samples ----

// The receives that the receive thread samples, with the gaps of nextVideoReceiveSampleGap() from its seed (the first
// receive is 1)
#define MAX_SAMPLES 1024
static int samples[MAX_SAMPLES];
static int sampleCount;

static void computeSamples(int receives) {
  uint32_t state = VIDEO_RECV_SAMPLE_SEED;
  uint32_t next = nextVideoReceiveSampleGap(&state);
  sampleCount = 0;
  while ((int)next <= receives && sampleCount < MAX_SAMPLES) {
    samples[sampleCount++] = (int)next;
    next += nextVideoReceiveSampleGap(&state);
  }
}

static bool isSample(int receive) {
  for (int i = 0; i < sampleCount; i++) {
    if (samples[i] == receive) {
      return true;
    }
  }
  return false;
}

// The first sampled receive from `from` on, or -1
static int sampleFrom(int from) {
  for (int i = 0; i < sampleCount; i++) {
    if (samples[i] >= from) {
      return samples[i];
    }
  }
  return -1;
}

// ---- The stand-ins ----

// The test clock: a read returns the time and moves it on by clockStepUs
static uint64_t clockNowUs;
static uint64_t clockStepUs;
// What the RTP queue takes for a packet, and the poll() without a timeout of a sample
static uint64_t workUs;
static uint64_t pollUs;

uint64_t PltGetMicroseconds(void) {
  const uint64_t now = clockNowUs;
  clockNowUs += clockStepUs;
  return now;
}
uint64_t PltGetMillis(void) {
  return 0;
}

// What happened at the start and the stop, in order, e.g. "bind:1000 timeout:1000 create:VideoRecv"
static char events[1024];

static void event(const char* name, const char* detail) {
  if (events[0] != 0) {
    strncat(events, " ", sizeof(events) - strlen(events) - 1);
  }
  strncat(events, name, sizeof(events) - strlen(events) - 1);
  if (detail != NULL) {
    strncat(events, ":", sizeof(events) - strlen(events) - 1);
    strncat(events, detail, sizeof(events) - strlen(events) - 1);
  }
}

static void socketEvent(const char* name, long long s) {
  char detail[24];
  snprintf(detail, sizeof(detail), "%lld", s);
  event(name, detail);
}

static void checkEvents(const char* expected) {
  if (strcmp(events, expected) != 0) {
    printf("  # expected the events: %s\n", expected);
  }
  CHECK(strcmp(events, expected) == 0);
}

#define FIRST_SOCKET 1000
#define NO_WAIT_SOCKET 1001

// The sockets: whether the first one takes a receive timeout, whether a socket that never waits can be made, and
// what each call got
static bool timeoutWorks;
static bool noWaitWorks;
static int bindCalls;
static int bindNoWaitCalls;
static int bindFamily[2];
static struct sockaddr_storage* bindLocalAddr[2];
static SOCKADDR_LEN bindAddrLen[2];
static int bindBufferSize[2];
static int bindQosType[2];
static int timeoutCalls;
static int timeoutCallsOnFirst;
static int closeCalls;
static int closedSocket;

SOCKET bindUdpSocket(int addressFamily, struct sockaddr_storage* localAddr, SOCKADDR_LEN addrLen, int bufferSize,
                     int socketQosType) {
  bindCalls++;
  bindFamily[0] = addressFamily;
  bindLocalAddr[0] = localAddr;
  bindAddrLen[0] = addrLen;
  bindBufferSize[0] = bufferSize;
  bindQosType[0] = socketQosType;
  socketEvent("bind", FIRST_SOCKET);
  return FIRST_SOCKET;
}
SOCKET bindUdpSocketNoWait(int addressFamily, struct sockaddr_storage* localAddr, SOCKADDR_LEN addrLen, int bufferSize,
                           int socketQosType) {
  bindNoWaitCalls++;
  bindFamily[1] = addressFamily;
  bindLocalAddr[1] = localAddr;
  bindAddrLen[1] = addrLen;
  bindBufferSize[1] = bufferSize;
  bindQosType[1] = socketQosType;
  socketEvent("nowait", noWaitWorks ? NO_WAIT_SOCKET : -1);
  return noWaitWorks ? NO_WAIT_SOCKET : INVALID_SOCKET;
}
void closeSocket(SOCKET s) {
  closeCalls++;
  closedSocket = s;
  socketEvent("close", s);
}
int setNonFatalRecvTimeoutMs(SOCKET s, int timeoutMs) {
  CHECK_EQ_INT(timeoutMs, UDP_RECV_POLL_TIMEOUT_MS);
  timeoutCalls++;
  if (s == FIRST_SOCKET) {
    timeoutCallsOnFirst++;
  }
  socketEvent("timeout", s);
  return timeoutWorks ? 0 : -1;
}
int wakeUdpSocketReader(SOCKET s) {
  socketEvent("wake", s);
  return 0;
}
SOCKET connectTcpSocket(struct sockaddr_storage* dstaddr, SOCKADDR_LEN addrlen, unsigned short port, int timeoutSec) {
  (void)dstaddr;
  (void)addrlen;
  (void)port;
  (void)timeoutSec;
  CHECK(false);
  return INVALID_SOCKET;
}
void shutdownTcpSocket(SOCKET s) {
  (void)s;
}

// The receive calls of the script
static int recvCalls;
static int recvCallsWithSelect;
static int recvCallsWithAddress;
static int recvCallsOnOtherSocket;
static int noWaitCalls;
static int noWaitCallsOnOtherSocket;
static char* lastReceiveBuffer;
static int lastReceiveSize;
// For each entry of the script: the buffer it was received into and the clock right after its receive, which is when
// the reader notes that it read it (the clock read after a receive is the next one)
static char* servedBuffer[MAX_ENTRIES];
static uint64_t servedAtUs[MAX_ENTRIES];
// The bytes before the RTP header of a packet (the header of encrypted video)
static int rtpOffset;

// The next entry of the script into the buffer: the size of the packet, 0 for a timeout, -1 with errno for an error
static int serve(char* buffer, int size, bool* waiting, int* socketCalls) {
  CHECK(scriptPosition < scriptLength);
  if (scriptPosition >= scriptLength) {
    *waiting = false;
    *socketCalls = 1;
    return 0;
  }
  const ENTRY* entry = &script[scriptPosition++];
  receiveCalls++;
  lastReceiveBuffer = buffer;
  lastReceiveSize = size;
  clockNowUs += entry->receiveUs;
  servedBuffer[scriptPosition - 1] = buffer;
  servedAtUs[scriptPosition - 1] = clockNowUs;
  *waiting = entry->waiting;
  *socketCalls = entry->socketCalls;
  if (entry->kind == ENTRY_ERROR) {
    errno = entry->error;
    return -1;
  }
  if (entry->kind == ENTRY_TIMEOUT) {
    return 0;
  }
  CHECK(entry->size <= size);
  CHECK(entry->size >= rtpOffset + (int)sizeof(RTP_PACKET));
  memset(buffer, 0, (size_t)entry->size);
  PRTP_PACKET rtp = (PRTP_PACKET)&buffer[rtpOffset];
  rtp->header = 0x90;
  rtp->packetType = 96;
  rtp->sequenceNumber = BE16((uint16_t)scriptPosition);
  return entry->size;
}

int recvUdpSocket(SOCKET s, char* buffer, int size, bool useSelect, struct sockaddr_storage* remoteAddr,
                  SOCKADDR_LEN* addrLen) {
  bool waiting;
  int socketCalls;
  recvCalls++;
  if (useSelect) {
    recvCallsWithSelect++;
  }
  if (remoteAddr != NULL || addrLen != NULL) {
    recvCallsWithAddress++;
  }
  if (s != FIRST_SOCKET) {
    recvCallsOnOtherSocket++;
  }
  return serve(buffer, size, &waiting, &socketCalls);
}
int recvUdpSocketNoWait(SOCKET s, char* buffer, int size, bool* waited, int* socketCalls) {
  bool waiting;
  noWaitCalls++;
  if (s != NO_WAIT_SOCKET) {
    noWaitCallsOnOtherSocket++;
  }
  const int result = serve(buffer, size, &waiting, socketCalls);
  *waited = !waiting;
  return result;
}

// The poll() without a timeout of a sample: readable when the packet of the next receive is waiting, or what the case
// sets for its first calls (a failure, or an error of the socket without a packet)
#define POLL_AS_SCRIPTED 0
#define POLL_FAILS 1
#define POLL_SOCKET_ERROR 2
static int pollCalls;
static int pollAtReceive[MAX_SAMPLES];
static int pollOutcome[16];
static bool pollAlwaysFails;

int pollSockets(struct pollfd* pollFds, int pollFdsCount, int timeoutMs) {
  CHECK_EQ_INT(pollFdsCount, 1);
  CHECK_EQ_INT(timeoutMs, 0);
  CHECK_EQ_INT(pollFds[0].fd, FIRST_SOCKET);
  CHECK_EQ_INT(pollFds[0].events, POLLIN);
  const int outcome = pollAlwaysFails ? POLL_FAILS : pollCalls < 16 ? pollOutcome[pollCalls] : POLL_AS_SCRIPTED;
  if (pollCalls < MAX_SAMPLES) {
    pollAtReceive[pollCalls] = receiveCalls + 1;
  }
  pollCalls++;
  clockNowUs += pollUs;
  if (outcome == POLL_FAILS) {
    errno = EINVAL;
    return -1;
  }
  if (outcome == POLL_SOCKET_ERROR) {
    pollFds[0].revents = POLLERR;
    return 1;
  }
  const bool readable = scriptPosition < scriptLength && script[scriptPosition].kind == ENTRY_PACKET &&
                        script[scriptPosition].waiting;
  pollFds[0].revents = readable ? POLLIN : 0;
  return readable ? 1 : 0;
}

// The threads: created but never run (one can fail); the receive thread ends once the script is used up, the
// processing thread once it took every packet of the ring
static ThreadEntry receiveEntry;
static ThreadEntry processEntry;
static int receiveThreadsCreated;
static int processThreadsCreated;
static const char* failingThread;

int PltCreateThread(const char* name, ThreadEntry entry, void* context, PLT_THREAD* thread) {
  (void)context;
  (void)thread;
  if (failingThread != NULL && strcmp(name, failingThread) == 0) {
    event("fail", name);
    return -1;
  }
  if (strcmp(name, "VideoRecv") == 0) {
    receiveEntry = entry;
    receiveThreadsCreated++;
  }
  if (strcmp(name, "VideoProc") == 0) {
    processEntry = entry;
    processThreadsCreated++;
  }
  event("create", name);
  return 0;
}
void PltInterruptThread(PLT_THREAD* thread) {
  (void)thread;
}
void PltJoinThread(PLT_THREAD* thread) {
  if (thread == &receiveThread) {
    event("join", "VideoRecv");
  }
  if (thread == &processThread) {
    event("join", "VideoProc");
  }
}

// The mutexes and condition variables of the ring: nothing to lock on one thread, but every one made is deleted again
// (VrrDestroy()), and a wait would never end
static int mutexesAlive;
static int condsAlive;
int PltCreateMutex(PLT_MUTEX* mutex) {
  (void)mutex;
  mutexesAlive++;
  return 0;
}
void PltDeleteMutex(PLT_MUTEX* mutex) {
  (void)mutex;
  mutexesAlive--;
}
void PltLockMutex(PLT_MUTEX* mutex) {
  (void)mutex;
}
void PltUnlockMutex(PLT_MUTEX* mutex) {
  (void)mutex;
}
int PltCreateConditionVariable(PLT_COND* cond, PLT_MUTEX* mutex) {
  (void)cond;
  (void)mutex;
  condsAlive++;
  return 0;
}
void PltDeleteConditionVariable(PLT_COND* cond) {
  (void)cond;
  condsAlive--;
}
void PltSignalConditionVariable(PLT_COND* cond) {
  (void)cond;
}
void PltWaitForConditionVariable(PLT_COND* cond, PLT_MUTEX* mutex) {
  (void)cond;
  (void)mutex;
  printf("  # FAILED: a thread of the video receive waits for the other, which this test never runs\n");
  fflush(stdout);
  abort();
}
bool PltIsThreadInterrupted(PLT_THREAD* thread) {
  (void)thread;
  return scriptPosition >= scriptLength;
}
void PltSleepMsInterruptible(PLT_THREAD* thread, int ms) {
  (void)thread;
  (void)ms;
}

// The decryption hands the ciphertext over unchanged
static PLT_CRYPTO_CONTEXT cryptoContext;
static int decryptCalls;
static unsigned char* lastDecryptInput;
static unsigned char* lastDecryptOutput;
// The buffer that each entry of the script was decrypted into
static unsigned char* decryptedInto[MAX_ENTRIES];
// The call (counted from 1) that fails, or 0
static int failingDecryption;

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
  decryptCalls++;
  if (decryptCalls == failingDecryption) {
    return false;
  }
  lastDecryptInput = inputData;
  lastDecryptOutput = outputData;
  {
    // (the ciphertext of the stand-in is the RTP packet as serve() made it, its sequence number the entry plus 1)
    const int index = (int)BE16(((PRTP_PACKET)inputData)->sequenceNumber) - 1;
    if (index >= 0 && index < MAX_ENTRIES) {
      decryptedInto[index] = outputData;
    }
  }
  memcpy(outputData, inputData, (size_t)inputDataLength);
  *outputDataLength = inputDataLength;
  return true;
}

// The RTP queue takes workUs (and the extra work of the entry) for a packet and keeps it (here: frees it), or, every
// rejectEvery-th packet of a case that sets it, rejects it and leaves the buffer to the caller, as the real queue does
// with a surplus parity packet of a block it completed or a late or duplicate packet. It runs on the processing thread
// and finds the entry of the script by the sequence number that serve() gave the packet; the first packet stands for a
// keyframe (notifyKeyFrameReceived(), which the depacketizer calls), unless a case checks the limit for the first
// frame.
static int queuedPackets;
static int lastQueuedLength;
static char* lastQueuedPacket;
static bool noKeyframe;
// Packets out of order, with another time than when the reader read them, or (plain video) in another buffer than the
// one they were received into
static int queuedOutOfOrder;
static int queuedWithWrongTime;
static int queuedInOtherBuffer;
static int lastQueuedIndex;
static int rejectEvery;
static int rejectedPackets;
static bool rejected[MAX_ENTRIES];
// Runs after the processing thread, before the stop (a case that looks into the ring sets it)
static void (*afterProcessing)(void);
// (StreamConfig.packetSize of every case)
#define PACKET_SIZE_OF_STREAM 1392

void RtpvInitializeQueue(PRTP_VIDEO_QUEUE queue) {
  (void)queue;
}
void RtpvCleanupQueue(PRTP_VIDEO_QUEUE queue) {
  (void)queue;
}
int RtpvAddPacket(PRTP_VIDEO_QUEUE queue, PRTP_PACKET packet, int length, PRTPV_QUEUE_ENTRY packetEntry,
                  uint64_t receiveTimeUs) {
  (void)queue;
  const int index = (int)packet->sequenceNumber - 1;
  CHECK(index >= 0 && index < scriptLength);
  if (index < 0 || index >= scriptLength) {
    return RTPF_RET_REJECTED;
  }
  // The queue entry lies behind the RTP packet of the full size, in the same buffer
  CHECK((char*)packetEntry == (char*)packet + PACKET_SIZE_OF_STREAM + MAX_RTP_HEADER_SIZE);
  clockNowUs += workUs + script[index].extraWorkUs;
  if (queuedPackets > 0 && index <= lastQueuedIndex) {
    queuedOutOfOrder++;
  }
  lastQueuedIndex = index;
  if (receiveTimeUs != servedAtUs[index]) {
    queuedWithWrongTime++;
  }
  if ((EncryptionFeaturesEnabled & SS_ENC_VIDEO) == 0 && (char*)packet != servedBuffer[index]) {
    queuedInOtherBuffer++;
  }
  if (rejectEvery > 0 && (index + 1) % rejectEvery == 0) {
    rejected[index] = true;
    rejectedPackets++;
    return RTPF_RET_REJECTED;
  }
  queuedPackets++;
  lastQueuedLength = length;
  lastQueuedPacket = (char*)packet;
  if (!noKeyframe) {
    notifyKeyFrameReceived();
  }
  free(packet);
  return RTPF_RET_QUEUED;
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

// The renderer and the listener
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
  event("start", NULL);
}
static void rendererStop(void) {
}
static void rendererCleanup(void) {
}
static int terminations;
static int terminationError;
static int terminationReceiveCalls;
static void connectionTerminated(int errorCode) {
  terminations++;
  terminationError = errorCode;
  terminationReceiveCalls = receiveCalls;
}

// ---- A stream ----

#define PACKET_SIZE 1392
// A packet of the full size as the socket gets it (the RTP header and the payload of StreamConfig.packetSize)
#define FULL_PACKET (PACKET_SIZE + MAX_RTP_HEADER_SIZE)

static void resetStream(void) {
  memset(lines, 0, sizeof(lines));
  lineCount = 0;
  memset(events, 0, sizeof(events));
  scriptLength = 0;
  scriptPosition = 0;
  clockNowUs = 1000000;
  clockStepUs = 1;
  workUs = 30;
  pollUs = 7;
  timeoutWorks = true;
  noWaitWorks = true;
  bindCalls = 0;
  bindNoWaitCalls = 0;
  timeoutCalls = 0;
  timeoutCallsOnFirst = 0;
  closeCalls = 0;
  closedSocket = -1;
  recvCalls = 0;
  recvCallsWithSelect = 0;
  recvCallsWithAddress = 0;
  recvCallsOnOtherSocket = 0;
  noWaitCalls = 0;
  noWaitCallsOnOtherSocket = 0;
  pollCalls = 0;
  memset(pollOutcome, 0, sizeof(pollOutcome));
  pollAlwaysFails = false;
  receiveCalls = 0;
  lastReceiveBuffer = NULL;
  lastReceiveSize = 0;
  rtpOffset = 0;
  decryptCalls = 0;
  failingDecryption = 0;
  queuedPackets = 0;
  noKeyframe = false;
  queuedOutOfOrder = 0;
  queuedWithWrongTime = 0;
  queuedInOtherBuffer = 0;
  lastQueuedIndex = -1;
  rejectEvery = 0;
  rejectedPackets = 0;
  memset(rejected, 0, sizeof(rejected));
  memset(decryptedInto, 0, sizeof(decryptedInto));
  afterProcessing = NULL;
  receiveEntry = NULL;
  processEntry = NULL;
  receiveThreadsCreated = 0;
  processThreadsCreated = 0;
  failingThread = NULL;
  terminations = 0;
  terminationError = 0;
  terminationReceiveCalls = -1;
  memset(&ListenerCallbacks, 0, sizeof(ListenerCallbacks));
  ListenerCallbacks.logMessage = captureLine;
  ListenerCallbacks.connectionTerminated = connectionTerminated;
  memset(&VideoCallbacks, 0, sizeof(VideoCallbacks));
  VideoCallbacks.setup = rendererSetup;
  VideoCallbacks.start = rendererStart;
  VideoCallbacks.stop = rendererStop;
  VideoCallbacks.cleanup = rendererCleanup;
  VideoCallbacks.capabilities = 0;
  memset(&StreamConfig, 0, sizeof(StreamConfig));
  StreamConfig.packetSize = PACKET_SIZE;
  StreamConfig.width = 3840;
  StreamConfig.height = 2160;
  StreamConfig.fps = 60;
  memset(&RemoteAddr, 0, sizeof(RemoteAddr));
  RemoteAddr.ss_family = AF_INET;
  memset(&LocalAddr, 0, sizeof(LocalAddr));
  LocalAddr.ss_family = AF_INET;
  AddrLen = sizeof(struct sockaddr_in);
  // A host of GFE 7 and later: no TCP socket for the first frame
  AppVersionQuad[0] = 7;
  NegotiatedVideoFormat = VIDEO_FORMAT_H264;
  EncryptionFeaturesEnabled = 0;
  VideoPortNumber = 47998;
  computeSamples(MAX_ENTRIES);
}

// No buffer is in two slots of the ring (the processing thread puts a buffer of its own into each slot of a plain
// packet that it hands to the queue)
static int compareBuffers(const void* a, const void* b) {
  const uintptr_t x = (uintptr_t)*(char* const*)a;
  const uintptr_t y = (uintptr_t)*(char* const*)b;
  return x < y ? -1 : x > y ? 1 : 0;
}
static char* slotBuffers[VIDEO_RECV_RING_PACKETS];
static void checkSlotBuffersDistinct(void) {
  CHECK(receiveRing.slots != NULL);
  if (receiveRing.slots == NULL) {
    return;
  }
  for (uint32_t i = 0; i < receiveRing.slotCount; i++) {
    slotBuffers[i] = receiveRing.slots[i].buffer;
  }
  qsort(slotBuffers, receiveRing.slotCount, sizeof(slotBuffers[0]), compareBuffers);
  int shared = 0;
  for (uint32_t i = 1; i < receiveRing.slotCount; i++) {
    if (slotBuffers[i] == slotBuffers[i - 1]) {
      shared++;
    }
  }
  if (shared > 0) {
    printf("  # %d buffers are in two slots of the ring at once\n", shared);
  }
  CHECK_EQ_INT(shared, 0);
}

// The start up to the threads, the receive thread on this thread until the script is used up (or it ends the stream),
// then the processing thread until it took every packet (or it ends the stream), and the stop, which leaves no mutex
// or condition variable of the ring behind
static void runStream(void) {
  initializeVideoStream();
  CHECK_EQ_INT(startVideoStream(NULL, 0), 0);
  CHECK_EQ_INT(receiveThreadsCreated, 1);
  CHECK_EQ_INT(processThreadsCreated, 1);
  if (receiveEntry != NULL) {
    event("run", NULL);
    receiveEntry(NULL);
  }
  if (processEntry != NULL) {
    event("process", NULL);
    processEntry(NULL);
  }
  checkSlotBuffersDistinct();
  if (afterProcessing != NULL) {
    afterProcessing();
  }
  event("stop", NULL);
  stopVideoStream();
  destroyVideoStream();
  CHECK_EQ_INT(mutexesAlive, 0);
  CHECK_EQ_INT(condsAlive, 0);
  // Every packet that reached the queue did in order, with the time the reader read it and, plain, in its own buffer
  CHECK_EQ_INT(queuedOutOfOrder, 0);
  CHECK_EQ_INT(queuedWithWrongTime, 0);
  CHECK_EQ_INT(queuedInOtherBuffer, 0);
  if (test_current_failed) {
    printf("  # events: %s\n", events);
    printLines();
  }
}

// The stream line as the receive thread is to log it, from the figures of the script: the packets and their bytes,
// the socket calls of the receives, the checked packets and those of them that were waiting, the time to read a
// waiting packet and of the other work per packet (without a clock read), and the time of a clock read; the rate with
// the IP header of the family of the host and the UDP header, and (since 2.3.5) the clock read per packet with which
// the reader notes when it read the packet
static void expectedStreamLine(char* text, size_t size, unsigned int seconds, unsigned long long packets,
                               unsigned long long bytes, unsigned long long socketCalls, unsigned long long checked,
                               unsigned long long checkedWaiting, double readUs, double otherUs, double clockUs) {
  const unsigned int waiting = (unsigned int)((checkedWaiting * 100 + checked / 2) / checked);
  const unsigned int headers = (RemoteAddr.ss_family == AF_INET6 ? 40 : 20) + 8;
  const double mbps = ((double)bytes / (double)packets + headers) * 8 / (readUs + otherUs + clockUs);
  snprintf(text, size,
           "Video receive of the stream, %u s: %llu packets, %.2f socket calls each, %u%% were waiting; %.1f us to read "
           "a waiting packet, %.1f us of other work per packet: up to %u Mbps; clock read %.1f us\n",
           seconds, packets, (double)socketCalls / (double)packets, waiting, readUs, otherUs,
           (unsigned int)(mbps + 0.5), clockUs);
}

// The other work per packet of the reader in the cases: none besides noting the time and handing the packet over, which
// take no time on the test clock (the RTP queue runs on the processing thread)
#define READER_WORK_US 0.0

// The stream line of the processing thread, from the figures of the script: the processing thread runs after the
// reader here, and finds every packet in the ring (so it waits for none, and the ring held them all); its time is the
// work of the RTP queue for each packet and its reads of the clock: one at its first packet, one after each batch of up
// to VRR_BATCH packets (for the line of a minute) and one at its end
static void expectedProcessLine(char* text, size_t size, unsigned long long packets, unsigned long long bytes,
                                uint64_t queueWorkUs) {
  const unsigned long long batches = (packets + VRR_BATCH - 1) / VRR_BATCH;
  const uint64_t elapsedUs = queueWorkUs + (1 + batches) * clockStepUs;
  const unsigned int headers = (RemoteAddr.ss_family == AF_INET6 ? 40 : 20) + 8;
  unsigned int seconds = (unsigned int)((elapsedUs + 500000) / 1000000);
  char rate[16];
  if (seconds == 0) {
    seconds = 1;
  }
  if (elapsedUs > 0) {
    snprintf(rate, sizeof(rate), "%u",
             (unsigned int)(((double)bytes / (double)packets + headers) * 8 * (double)packets / (double)elapsedUs + 0.5));
  }
  else {
    snprintf(rate, sizeof(rate), "n/a");
  }
  snprintf(text, size,
           "Video processing of the stream, %u s: %llu packets, %.1f us of work each, idle 0%% (looking 0%%): up to %s "
           "Mbps; ring up to %llu of 32768 packets, full 0 times for 0 ms; 0 wakes\n",
           seconds, packets, (double)elapsedUs / (double)packets, rate, packets);
}

// The line of the poll() calls of the samples
static void expectedCheckLine(char* text, size_t size, int polls, double pollTimeUs, int failed) {
  snprintf(text, size, "Video receive check of the stream: %d calls of poll() without a timeout, %.1f us each, %d failed\n",
           polls, pollTimeUs, failed);
}

// ---- The tests ----

static void test_the_samples_fall_about_every_64th_receive_at_gaps_that_vary(void) {
  // The gaps of nextVideoReceiveSampleGap(): from 48 to 79 receives, each of them, about 64 on average
  uint32_t state = VIDEO_RECV_SAMPLE_SEED;
  int seen[32] = { 0 };
  unsigned long long sum = 0;
  int outside = 0;
  for (int i = 0; i < 100000; i++) {
    const uint32_t gap = nextVideoReceiveSampleGap(&state);
    sum += gap;
    if (gap < 48 || gap > 79) {
      outside++;
    }
    else {
      seen[gap - 48]++;
    }
  }
  CHECK_EQ_INT(outside, 0);
  for (int i = 0; i < 32; i++) {
    // each about 3125 times
    CHECK(seen[i] > 2500 && seen[i] < 3750);
  }
  CHECK(sum >= 6330000ULL && sum <= 6370000ULL);
  // Of 100 gaps in a row, no gap repeats more than a few times in a row
  state = VIDEO_RECV_SAMPLE_SEED;
  uint32_t last = 0;
  int run = 0;
  int longestRun = 0;
  for (int i = 0; i < 100; i++) {
    const uint32_t gap = nextVideoReceiveSampleGap(&state);
    run = gap == last ? run + 1 : 1;
    longestRun = run > longestRun ? run : longestRun;
    last = gap;
  }
  CHECK(longestRun <= 3);

  // Frames that all have the same number of packets, the last of which costs the depacketizer pass (1000 us in all,
  // 30 us for the others). Up to 2.3.4 that pass ran on the receive thread, and the gaps that vary made its sampled
  // other work per packet the average of the frame, whatever the size of the frame (with a sample at every 64th
  // receive it would have been that of one packet of the frame: 1000 us for frames of 64 packets, 222 us for frames of
  // 320). Since 2.3.5 the pass runs on the processing thread: the reader's other work stays without it, and the line of
  // the processing thread, which counts every packet, has the average of the frame.
  const int frameSizes[3] = { 64, 320, 288 };
  for (int f = 0; f < 3; f++) {
    resetStream();
    const int frame = frameSizes[f];
    const int packets = (32000 / frame) * frame;
    for (int i = 1; i <= packets; i++) {
      addPacket(FULL_PACKET, true, 5, 1);
      if (i % frame == 0) {
        script[scriptLength - 1].extraWorkUs = 1000 - workUs;
      }
    }
    runStream();
    const double average = ((frame - 1) * (double)workUs + 1000) / frame;
    const int stream = findLine(STREAM_LINE);
    CHECK(stream >= 0);
    if (stream >= 0) {
      CHECK(numberBefore(lines[stream], " us of other work per packet") == READER_WORK_US);
    }
    const int process = findLine(PROCESS_LINE);
    CHECK(process >= 0);
    if (process >= 0) {
      const double measured = numberBefore(lines[process], " us of work each");
      if (!(measured > average * 0.99 && measured < average * 1.01)) {
        printf("  # frames of %d packets: %.1f us of work measured, %.1f us on average\n", frame, measured, average);
      }
      CHECK(measured > average * 0.99 && measured < average * 1.01);
    }
  }
}

static void test_timeout_mode_reads_each_packet_with_one_recvfrom_and_samples_about_every_64th(void) {
  for (int ipv6 = 0; ipv6 <= 1; ipv6++) {
    resetStream();
    if (ipv6) {
      RemoteAddr.ss_family = AF_INET6;
      LocalAddr.ss_family = AF_INET6;
      AddrLen = sizeof(struct sockaddr_in6);
    }
    for (int i = 0; i < 256; i++) {
      addPacket(FULL_PACKET, true, 5, 1);
    }
    runStream();
    CHECK_EQ_INT(recvCalls, 256);
    CHECK_EQ_INT(recvCallsWithSelect, 0);
    CHECK_EQ_INT(recvCallsWithAddress, 0);
    CHECK_EQ_INT(recvCallsOnOtherSocket, 0);
    CHECK_EQ_INT(noWaitCalls, 0);
    CHECK_EQ_INT(queuedPackets, 256);
    // The poll() without a timeout comes before the sampled receives only (55, 114, 178 and 248)
    computeSamples(256);
    CHECK_EQ_INT(pollCalls, sampleCount);
    CHECK_EQ_INT(sampleCount, 4);
    for (int i = 0; i < sampleCount && i < pollCalls; i++) {
      CHECK_EQ_INT(pollAtReceive[i], samples[i]);
    }
    // The socket takes the timeout: no socket that never waits, the thread sets the timeout once more, and the stop
    // joins the thread without waking it
    CHECK_EQ_INT(bindNoWaitCalls, 0);
    CHECK_EQ_INT(timeoutCalls, 2);
    CHECK_EQ_INT(timeoutCallsOnFirst, 2);
    CHECK_EQ_INT(countLines(POLL_LINE), 0);
    checkEvents("bind:1000 timeout:1000 start create:VideoProc create:VideoRecv create:VideoDec create:VideoPing run "
                "timeout:1000 process stop join:VideoRecv join:VideoProc close:1000");
    // The mode first, the stream at the end, then the poll() calls of the samples
    const int mode = findLine(MODE_TIMEOUT);
    const int stream = findLine(STREAM_LINE);
    CHECK(mode >= 0);
    CHECK(stream > mode);
    CHECK_EQ_INT(findLine(CHECK_LINE), stream + 1);
    CHECK_EQ_INT(countLines("Video receive mode: "), 1);
    CHECK_EQ_INT(countLines(STREAM_LINE), 1);
    CHECK_EQ_INT(countLines(MINUTE_LINE), 0);
    CHECK_EQ_INT(countLines(CHECK_FAILED_LINE), 0);
    // 5 us to read each packet (the 7 us of the poll() before it don't count), no other work (the 30 us of the queue
    // are the processing thread's since 2.3.5), a clock read of 1 us, which the reader does once per packet to note
    // when it read it; up to (1408 + 28) * 8 / 6 Mbps, over IPv6 (1408 + 48) * 8 / 6 Mbps
    char expected[512];
    expectedStreamLine(expected, sizeof(expected), 1, 256, 256ULL * FULL_PACKET, 256, 4, 4, 5, READER_WORK_US,
                       (double)clockStepUs);
    checkLine(expected);
    checkLine(ipv6 ? "Video receive of the stream, 1 s: 256 packets, 1.00 socket calls each, 100% were waiting; 5.0 us to "
                     "read a waiting packet, 0.0 us of other work per packet: up to 1941 Mbps; clock read 1.0 us\n"
                   : "Video receive of the stream, 1 s: 256 packets, 1.00 socket calls each, 100% were waiting; 5.0 us to "
                     "read a waiting packet, 0.0 us of other work per packet: up to 1915 Mbps; clock read 1.0 us\n");
    // The processing thread: 256 packets of 30 us in the queue and 10 clock reads in 7,689 us, 30.0 us each, up to
    // (1408 + 28) * 8 * 256 / 7689 Mbps, over IPv6 (1408 + 48) * 8 * 256 / 7689 Mbps; it never waited, and the ring held
    // all the packets, as the reader ran first here
    expectedProcessLine(expected, sizeof(expected), 256, 256ULL * FULL_PACKET, 256 * workUs);
    checkLine(expected);
    checkLine(ipv6 ? "Video processing of the stream, 1 s: 256 packets, 30.0 us of work each, idle 0% (looking 0%): up "
                     "to 388 Mbps; ring up to 256 of 32768 packets, full 0 times for 0 ms; 0 wakes\n"
                   : "Video processing of the stream, 1 s: 256 packets, 30.0 us of work each, idle 0% (looking 0%): up "
                     "to 382 Mbps; ring up to 256 of 32768 packets, full 0 times for 0 ms; 0 wakes\n");
    // After the lines of the reader, once
    CHECK(findLine(PROCESS_LINE) > findLine(CHECK_LINE));
    CHECK_EQ_INT(countLines(PROCESS_LINE), 1);
    CHECK_EQ_INT(countLines(PROCESS_MINUTE_LINE), 0);
    // Each poll() of a sample took 7 us, without the clock read
    expectedCheckLine(expected, sizeof(expected), 4, (double)pollUs, 0);
    checkLine(expected);
    checkLine("Video receive check of the stream: 4 calls of poll() without a timeout, 7.0 us each, 0 failed\n");
  }
}

static void test_the_waiting_share_comes_from_the_sample_only(void) {
  resetStream();
  // Four samples (55, 114, 178, 248), then no more
  const int receives = samples[3] + 20;
  CHECK(sampleFrom(samples[3] + 1) > receives);
  for (int i = 1; i <= receives; i++) {
    if (isSample(i)) {
      // The sampled packet of the second sample was not waiting, and its receive took long (it waited for the packet)
      addPacket(FULL_PACKET, i != samples[1], i == samples[1] ? 500 : 5, 1);
    }
    else {
      // The flags of the others differ on purpose: they are not looked at
      addPacket(FULL_PACKET, (i % 3) == 0, 5, 1);
    }
  }
  runStream();
  CHECK_EQ_INT(pollCalls, 4);
  char expected[512];
  // 3 of the 4 sampled packets were waiting; the time to read a waiting packet is theirs only
  expectedStreamLine(expected, sizeof(expected), 1, (unsigned long long)receives,
                     (unsigned long long)receives * FULL_PACKET, (unsigned long long)receives, 4, 3, 5, READER_WORK_US,
                     (double)clockStepUs);
  checkLine(expected);
  const int stream = findLine(STREAM_LINE);
  CHECK(stream >= 0);
  if (stream >= 0) {
    CHECK(strstr(lines[stream], ", 75% were waiting; 5.0 us to read a waiting packet,") != NULL);
  }
}

static void test_a_failed_poll_leaves_a_sample_out_and_a_socket_error_is_no_packet_waiting(void) {
  // The first poll() of a sample fails, the second answers an error of the socket (POLLERR) without a packet, the
  // others that the packet is waiting, as every packet is
  resetStream();
  const int receives = samples[3] + 20;
  for (int i = 0; i < receives; i++) {
    addPacket(FULL_PACKET, true, 5, 1);
  }
  pollOutcome[0] = POLL_FAILS;
  pollOutcome[1] = POLL_SOCKET_ERROR;
  runStream();
  CHECK_EQ_INT(pollCalls, 4);
  // The failure is logged once with its error, before the receive of its sample
  char failed[128];
  snprintf(failed, sizeof(failed), "%s%d\n", CHECK_FAILED_LINE, EINVAL);
  checkLine(failed);
  CHECK_EQ_INT(countLines(CHECK_FAILED_LINE), 1);
  const int failure = findLine(CHECK_FAILED_LINE);
  if (failure >= 0) {
    CHECK_EQ_INT(lineReceiveCalls[failure], samples[0] - 1);
  }
  // Of the three samples whose waiting is known, two were waiting; the read time is theirs only
  char expected[512];
  expectedStreamLine(expected, sizeof(expected), 1, (unsigned long long)receives,
                     (unsigned long long)receives * FULL_PACKET, (unsigned long long)receives, 3, 2, 5, READER_WORK_US,
                     (double)clockStepUs);
  checkLine(expected);
  // The failed poll() is timed and counted too
  checkLine("Video receive check of the stream: 4 calls of poll() without a timeout, 7.0 us each, 1 failed\n");

  // A poll() that fails every time leaves the share unknown instead of showing that no packet was waiting
  resetStream();
  for (int i = 0; i < receives; i++) {
    addPacket(FULL_PACKET, true, 5, 1);
  }
  pollAlwaysFails = true;
  runStream();
  CHECK_EQ_INT(countLines(CHECK_FAILED_LINE), 1);
  const int stream = findLine(STREAM_LINE);
  CHECK(stream >= 0);
  if (stream >= 0) {
    CHECK(strstr(lines[stream], " packets, 1.00 socket calls each, n/a% were waiting; n/a us to read a waiting packet, "
                                "0.0 us of other work per packet: up to n/a Mbps; clock read 1.0 us\n") != NULL);
  }
  checkLine("Video receive check of the stream: 4 calls of poll() without a timeout, 7.0 us each, 4 failed\n");
}

static void test_poll_mode_when_no_socket_that_never_waits_can_be_made(void) {
  resetStream();
  timeoutWorks = false;
  noWaitWorks = false;
  for (int i = 0; i < 128; i++) {
    addPacket(FULL_PACKET, true, 5, 2);
  }
  // A pause of 2 s: a poll() that timed out is one socket call
  addTimeouts(20, 100000);
  runStream();
  // The first socket stays, and is closed at the stop only, which doesn't wake the thread
  CHECK_EQ_INT(bindNoWaitCalls, 1);
  checkEvents("bind:1000 timeout:1000 nowait:-1 start create:VideoProc create:VideoRecv create:VideoDec create:VideoPing "
              "run timeout:1000 process stop join:VideoRecv join:VideoProc close:1000");
  CHECK_EQ_INT(closeCalls, 1);
  CHECK_EQ_INT(closedSocket, FIRST_SOCKET);
  // poll() before each receive, as before
  CHECK_EQ_INT(recvCalls, 148);
  CHECK_EQ_INT(recvCallsWithSelect, 148);
  CHECK_EQ_INT(noWaitCalls, 0);
  computeSamples(148);
  CHECK_EQ_INT(pollCalls, sampleCount);
  // (the samples fall on packets)
  CHECK(sampleCount > 0 && samples[sampleCount - 1] <= 128);
  const int unsupported = findLine(POLL_LINE);
  CHECK(unsupported >= 0);
  CHECK_EQ_INT(findLine(MODE_POLL), unsupported + 1);
  const int stream = findLine(STREAM_LINE);
  CHECK(stream >= 0);
  if (stream >= 0) {
    // 2 calls for each of the 128 packets, 1 for each of the 20 timeouts
    CHECK(strstr(lines[stream], " 128 packets, 2.16 socket calls each, 100% were waiting;") != NULL);
  }
  char expected[512];
  expectedStreamLine(expected, sizeof(expected), 2, 128, 128ULL * FULL_PACKET, 2 * 128 + 20,
                     (unsigned long long)sampleCount, (unsigned long long)sampleCount, 5, READER_WORK_US,
                     (double)clockStepUs);
  checkLine(expected);
  expectedCheckLine(expected, sizeof(expected), sampleCount, (double)pollUs, 0);
  checkLine(expected);
}

static void test_back_to_back_mode_replaces_the_socket_before_the_threads_start(void) {
  resetStream();
  timeoutWorks = false;
  // Bursts of 10 packets: the first of each waited (a read that found nothing, poll() and the read), the others were
  // waiting and took one read. The packet of the first sample waited too (and its receive took long), that of the
  // second was waiting.
  const int packets = 200;
  int waitedPackets = 0;
  int socketCalls = 0;
  for (int receive = 1; receive <= packets; receive++) {
    const bool waited = (receive % 10 == 1 && receive != samples[1]) || receive == samples[0];
    waitedPackets += waited ? 1 : 0;
    socketCalls += waited ? 3 : 1;
    addPacket(FULL_PACKET, !waited, receive == samples[0] ? 900 : 5, waited ? 3 : 1);
  }
  runStream();
  // The socket that never waits is bound like the first one, and replaces it before any thread starts
  CHECK_EQ_INT(bindCalls, 1);
  CHECK_EQ_INT(bindNoWaitCalls, 1);
  CHECK_EQ_INT(bindFamily[1], bindFamily[0]);
  CHECK_EQ_INT(bindFamily[1], AF_INET);
  CHECK(bindLocalAddr[1] == &LocalAddr);
  CHECK(bindLocalAddr[0] == &LocalAddr);
  CHECK_EQ_INT(bindAddrLen[1], bindAddrLen[0]);
  CHECK_EQ_INT(bindAddrLen[1], AddrLen);
  CHECK_EQ_INT(bindBufferSize[1], bindBufferSize[0]);
  CHECK_EQ_INT(bindBufferSize[1], 2048 * (1392 + 16));
  CHECK_EQ_INT(bindQosType[1], bindQosType[0]);
  CHECK_EQ_INT(bindQosType[1], SOCK_QOS_TYPE_VIDEO);
  // The receive thread sets no timeout on it and reads it only with recvUdpSocketNoWait(), without the poll() of a
  // sample; the stop wakes the thread before it joins it
  checkEvents("bind:1000 timeout:1000 nowait:1001 close:1000 start create:VideoProc create:VideoRecv create:VideoDec "
              "create:VideoPing run process stop wake:1001 join:VideoRecv join:VideoProc close:1001");
  CHECK_EQ_INT(timeoutCalls, 1);
  CHECK_EQ_INT(recvCalls, 0);
  CHECK_EQ_INT(pollCalls, 0);
  CHECK_EQ_INT(noWaitCalls, packets);
  CHECK_EQ_INT(noWaitCallsOnOtherSocket, 0);
  CHECK_EQ_INT(queuedPackets, packets);
  CHECK_EQ_INT(countLines(POLL_LINE), 0);
  CHECK(findLine(MODE_NO_WAIT) >= 0);
  CHECK_EQ_INT(countLines("Video receive mode: "), 1);
  CHECK_EQ_INT(countLines(CHECK_LINE), 0);
  // Every packet tells whether it was waiting; only the sampled packets that were waiting count for the read time
  CHECK(script[samples[0] - 1].waiting == false);
  CHECK(script[samples[1] - 1].waiting == true);
  char expected[512];
  expectedStreamLine(expected, sizeof(expected), 1, (unsigned long long)packets,
                     (unsigned long long)packets * FULL_PACKET, (unsigned long long)socketCalls,
                     (unsigned long long)packets, (unsigned long long)(packets - waitedPackets), 5, READER_WORK_US,
                     (double)clockStepUs);
  checkLine(expected);
}

static void test_the_receive_thread_is_woken_before_each_join_when_it_reads_a_socket_that_never_waits(void) {
  // A start that fails after the receive thread started: the decoder thread, then the ping thread can't be created.
  // Since 2.3.5 also before it: the processing thread (created first), then the receive thread can't be created. Each
  // failed start joins the threads it created, the processing thread after the receive thread, and frees the ring.
  const char* const threads[4] = { "VideoDec", "VideoPing", "VideoProc", "VideoRecv" };
  const char* const noWait[4] = {
    "bind:1000 timeout:1000 nowait:1001 close:1000 start create:VideoProc create:VideoRecv fail:VideoDec wake:1001 "
    "join:VideoRecv join:VideoProc close:1001",
    "bind:1000 timeout:1000 nowait:1001 close:1000 start create:VideoProc create:VideoRecv create:VideoDec fail:VideoPing "
    "wake:1001 join:VideoRecv join:VideoProc close:1001",
    "bind:1000 timeout:1000 nowait:1001 close:1000 start fail:VideoProc close:1001",
    "bind:1000 timeout:1000 nowait:1001 close:1000 start create:VideoProc fail:VideoRecv join:VideoProc close:1001",
  };
  const char* const withTimeout[4] = {
    "bind:1000 timeout:1000 start create:VideoProc create:VideoRecv fail:VideoDec join:VideoRecv join:VideoProc close:1000",
    "bind:1000 timeout:1000 start create:VideoProc create:VideoRecv create:VideoDec fail:VideoPing join:VideoRecv "
    "join:VideoProc close:1000",
    "bind:1000 timeout:1000 start fail:VideoProc close:1000",
    "bind:1000 timeout:1000 start create:VideoProc fail:VideoRecv join:VideoProc close:1000",
  };
  for (int t = 0; t < 4; t++) {
    for (int mode = 0; mode < 2; mode++) {
      resetStream();
      timeoutWorks = mode == 0;
      failingThread = threads[t];
      initializeVideoStream();
      CHECK_EQ_INT(startVideoStream(NULL, 0), -1);
      destroyVideoStream();
      checkEvents(mode == 0 ? withTimeout[t] : noWait[t]);
      // The ring is freed (the address sanitizer checks its buffers)
      CHECK_EQ_INT(mutexesAlive, 0);
      CHECK_EQ_INT(condsAlive, 0);
      CHECK(receiveRing.slots == NULL);
    }
  }
}

static void test_the_first_packet_limit_is_unchanged_in_every_mode(void) {
  // The receive timeout, poll() before each receive, the socket that never waits
  const char* const modeLines[3] = { MODE_TIMEOUT, MODE_POLL, MODE_NO_WAIT };
  for (int mode = 0; mode < 3; mode++) {
    resetStream();
    timeoutWorks = mode == 0;
    noWaitWorks = mode == 2;
    // 100 receives of 100 ms without a packet are the 10 s of the limit; the rest is never asked for
    addTimeouts(120, 100000);
    runStream();
    CHECK_EQ_INT(terminations, 1);
    CHECK_EQ_INT(terminationError, ML_ERROR_NO_VIDEO_TRAFFIC);
    CHECK_EQ_INT(terminationReceiveCalls, 100);
    CHECK_EQ_INT(receiveCalls, 100);
    CHECK_EQ_INT(mode == 2 ? noWaitCalls : recvCalls, 100);
    CHECK(hasLine("Terminating connection due to lack of video traffic\n"));
    CHECK(hasLine("No video traffic was ever received from the host!\n"));
    // No packet, so no line of a minute, of the stream or of the samples, and none of the processing thread
    CHECK_EQ_INT(countLines(STREAM_LINE), 0);
    CHECK_EQ_INT(countLines(MINUTE_LINE), 0);
    CHECK_EQ_INT(countLines(CHECK_LINE), 0);
    CHECK_EQ_INT(countLines(PROCESS_LINE), 0);
    CHECK_EQ_INT(queuedPackets, 0);
    CHECK(findLine(modeLines[mode]) >= 0);
  }
}

static void test_an_error_ends_the_loop_and_still_sums_the_stream_up(void) {
  for (int noWait = 0; noWait <= 1; noWait++) {
    resetStream();
    timeoutWorks = noWait == 0;
    for (int i = 0; i < 70; i++) {
      addPacket(FULL_PACKET, true, 5, 1);
    }
    addEntry(ENTRY_ERROR, 0, false, 5, 1, ENETDOWN);
    // Never read: the error ended the loop
    for (int i = 0; i < 5; i++) {
      addPacket(FULL_PACKET, true, 5, 1);
    }
    runStream();
    CHECK_EQ_INT(terminations, 1);
    CHECK_EQ_INT(terminationError, ENETDOWN);
    CHECK_EQ_INT(receiveCalls, 71);
    CHECK_EQ_INT(queuedPackets, 70);
    char failed[128];
    snprintf(failed, sizeof(failed), "Video Receive: recvUdpSocket() failed: %d\n", ENETDOWN);
    CHECK(hasLine(failed));
    CHECK_EQ_INT(countLines(STREAM_LINE), 1);
    const int stream = findLine(STREAM_LINE);
    CHECK(stream > findLine(failed));
    if (stream >= 0) {
      CHECK(strstr(lines[stream], " 70 packets, ") != NULL);
    }
    // The processing thread takes the 70 packets that the reader read before the error, then ends
    const int process = findLine(PROCESS_LINE);
    CHECK(process > stream);
    if (process >= 0) {
      CHECK(strstr(lines[process], " 70 packets, ") != NULL);
    }
  }
}

static void test_the_stop_ends_the_loop_with_one_stream_line(void) {
  resetStream();
  for (int i = 0; i < 100; i++) {
    addPacket(FULL_PACKET, true, 5, 1);
  }
  addTimeouts(20, 100000);
  runStream();
  CHECK_EQ_INT(terminations, 0);
  CHECK_EQ_INT(countLines(STREAM_LINE), 1);
  CHECK_EQ_INT(countLines(MINUTE_LINE), 0);
  const int stream = findLine(STREAM_LINE);
  if (stream >= 0) {
    // Logged once the script was used up, i.e. at the stop
    CHECK_EQ_INT(lineReceiveCalls[stream], 120);
    // 20 timeouts of 100 ms after the 100 packets: 2 s, 1.20 calls each
    CHECK(strncmp(lines[stream], "Video receive of the stream, 2 s: 100 packets, 1.20 socket calls each, ", 71) == 0);
  }
  char expected[512];
  expectedProcessLine(expected, sizeof(expected), 100, 100ULL * FULL_PACKET, 100 * workUs);
  checkLine(expected);

  // A stream with timeouts only (less than the limit) logs none
  resetStream();
  addTimeouts(50, 100000);
  runStream();
  CHECK_EQ_INT(terminations, 0);
  CHECK_EQ_INT(countLines(STREAM_LINE), 0);
  CHECK_EQ_INT(countLines(MINUTE_LINE), 0);
  CHECK_EQ_INT(countLines(CHECK_LINE), 0);
  CHECK_EQ_INT(countLines(PROCESS_LINE), 0);
}

// The lines of a minute of `packets` packets of 100 ms, which the thread waits for, followed by `timeouts` timeouts of
// 100 ms, in timeout mode, with a clock that only the receives move on (the 30 us of the queue are the processing
// thread's since 2.3.5, which runs after the reader here). The check after the sampled packet p comes p * 100 ms after
// the start, the first packet 100 ms after it, so a minute ends at the first sample 60 s after the start of the minute
// (60 s after the first packet for the first one); in the pause at the first timeout 60 s after it. Returns the number
// of lines, each with its receive and its text.
static int expectedMinuteLines(int packets, int timeouts, int receivesAt[2], char texts[2][256]) {
  const uint64_t perPacketUs = 100000;
  // First minute: from the first packet (read 100 ms after the start), so the check after the sampled packet p comes
  // p * 100 ms - 100 ms after it: 59.9 s for p = 600, 60.0 s for p = 601
  CHECK(600 * perPacketUs - 100000 < 60000000ULL && 601 * perPacketUs - 100000 >= 60000000ULL);
  const int first = sampleFrom(601);
  CHECK(first > 0 && first <= packets);
  uint64_t elapsedUs = (uint64_t)first * perPacketUs - 100000;
  receivesAt[0] = first;
  snprintf(texts[0], 256,
           "Video receive, last %u s: %llu packets/s, 1.00 socket calls each, 0%% were waiting; n/a us to read a waiting "
           "packet, 0.0 us of other work per packet: up to n/a Mbps\n",
           (unsigned int)((elapsedUs + 500000) / 1000000), (unsigned long long)first * 1000000 / elapsedUs);
  // Second minute: at a sampled packet, or in the pause
  const int second = sampleFrom(first + 600);
  unsigned long long minutePackets;
  unsigned long long minuteCalls;
  if (second > 0 && second <= packets) {
    receivesAt[1] = second;
    minutePackets = (unsigned long long)(second - first);
    minuteCalls = minutePackets;
    elapsedUs = minutePackets * perPacketUs;
  }
  else {
    const uint64_t beforePauseUs = (uint64_t)(packets - first) * perPacketUs;
    int pause = beforePauseUs >= 60000000ULL ? 1 : (int)((60000000ULL - beforePauseUs + 99999) / 100000);
    if (pause > timeouts) {
      return 1;
    }
    receivesAt[1] = packets + pause;
    minutePackets = (unsigned long long)(packets - first);
    minuteCalls = minutePackets + (unsigned long long)pause;
    elapsedUs = beforePauseUs + (uint64_t)pause * 100000;
  }
  snprintf(texts[1], 256,
           "Video receive, last %u s: %llu packets/s, %.2f socket calls each, 0%% were waiting; n/a us to read a waiting "
           "packet, 0.0 us of other work per packet: up to n/a Mbps\n",
           (unsigned int)((elapsedUs + 500000) / 1000000), minutePackets * 1000000 / elapsedUs,
           (double)minuteCalls / (double)minutePackets);
  return 2;
}

static void test_a_line_each_minute_while_video_comes(void) {
  // A packet every 100 ms, which the thread waits for, for 128 s, then 70 s without video; and for 90 s, so that the
  // second minute ends during the pause
  const int packetCounts[2] = { 1280, 900 };
  for (int run = 0; run < 2; run++) {
    resetStream();
    clockStepUs = 0;
    pollUs = 0;
    const int packets = packetCounts[run];
    for (int i = 0; i < packets; i++) {
      addPacket(FULL_PACKET, false, 100000, 1);
    }
    addTimeouts(700, 100000);
    int receivesAt[2] = { -1, -1 };
    char texts[2][256];
    CHECK_EQ_INT(expectedMinuteLines(packets, 700, receivesAt, texts), 2);
    runStream();
    CHECK_EQ_INT(countLines(MINUTE_LINE), 2);
    const int first = findLine(MINUTE_LINE);
    const int second = first >= 0 ? findLineFrom(first + 1, MINUTE_LINE) : -1;
    CHECK(first >= 0);
    CHECK(second > first);
    // Each line in full, at its receive: a minute line with the figures of the whole stream, or a missing check on a
    // timeout, would differ in the second one
    for (int i = 0; i < 2; i++) {
      const int line = i == 0 ? first : second;
      if (line < 0) {
        continue;
      }
      CHECK_EQ_INT(lineReceiveCalls[line], receivesAt[i]);
      if (strcmp(lines[line], texts[i]) != 0) {
        printf("  # expected the line at receive %d: %s", receivesAt[i], texts[i]);
      }
      CHECK(strcmp(lines[line], texts[i]) == 0);
    }
    if (run == 0) {
      // The first run ends its second minute at a sampled packet, the second one in the pause
      CHECK(receivesAt[1] <= packets);
      CHECK(strncmp(texts[1], "Video receive, last ", 20) == 0 && strstr(texts[1], " 1.00 socket calls each, ") != NULL);
    }
    else {
      CHECK(receivesAt[1] > packets);
      CHECK(strstr(texts[1], " 1.00 socket calls each, ") == NULL);
    }
    // No line for the minute without packets; the stream line at the end
    const int stream = findLine(STREAM_LINE);
    CHECK(stream > second);
    if (stream >= 0) {
      CHECK_EQ_INT(lineReceiveCalls[stream], packets + 700);
    }
    // 1280 packets of 100 ms and 700 timeouts of 100 ms from the first packet on: 198 s with 1.55 calls each; 900
    // packets: 160 s with 1.78 calls each
    checkLine(run == 0 ? "Video receive of the stream, 198 s: 1280 packets, 1.55 socket calls each, 0% were waiting; n/a us "
                         "to read a waiting packet, 0.0 us of other work per packet: up to n/a Mbps; clock read 0.0 us\n"
                       : "Video receive of the stream, 160 s: 900 packets, 1.78 socket calls each, 0% were waiting; n/a us "
                         "to read a waiting packet, 0.0 us of other work per packet: up to n/a Mbps; clock read 0.0 us\n");
    // The processing thread took every packet, each with the time the reader read it (runStream() checks it), and
    // the 128 s of read times passed the limit of 10 s for the first frame only because the first packet stood for a
    // keyframe
    CHECK_EQ_INT(queuedPackets, packets);
    CHECK_EQ_INT(terminations, 0);
  }
}

static void test_encrypted_video_is_read_into_its_own_buffer_and_counted_as_received(void) {
  for (int noWait = 0; noWait <= 1; noWait++) {
    resetStream();
    timeoutWorks = noWait == 0;
    EncryptionFeaturesEnabled = SS_ENC_VIDEO;
    rtpOffset = (int)sizeof(ENC_VIDEO_HEADER);
    const int received = FULL_PACKET + (int)sizeof(ENC_VIDEO_HEADER);
    for (int i = 0; i < 128; i++) {
      addPacket(received, true, 5, 1);
    }
    runStream();
    CHECK_EQ_INT(noWait ? noWaitCalls : recvCalls, 128);
    // The receive gets the buffer of the encrypted packet, with room for its header
    CHECK_EQ_INT(lastReceiveSize, 1392 + 16 + (int)sizeof(ENC_VIDEO_HEADER));
    CHECK_EQ_INT(decryptCalls, 128);
    // The processing thread decrypts from the buffer of the slot, after the header, into a buffer of its own, which
    // goes to the queue
    CHECK(lastDecryptInput == (unsigned char*)lastReceiveBuffer + sizeof(ENC_VIDEO_HEADER));
    CHECK(lastReceiveBuffer != lastQueuedPacket);
    CHECK(lastDecryptOutput == (unsigned char*)lastQueuedPacket);
    CHECK(lastQueuedPacket != servedBuffer[127]);
    CHECK_EQ_INT(lastQueuedLength, FULL_PACKET);
    CHECK_EQ_INT(queuedPackets, 128);
    // The bytes are those received: up to (1440 + 28) * 8 / 6 Mbps
    char expected[512];
    computeSamples(128);
    // (every packet is checked on a socket that never waits, the sampled ones otherwise)
    expectedStreamLine(expected, sizeof(expected), 1, 128, 128ULL * (unsigned long long)received, 128,
                       noWait ? 128 : (unsigned long long)sampleCount, noWait ? 128 : (unsigned long long)sampleCount, 5,
                       READER_WORK_US, (double)clockStepUs);
    checkLine(expected);
    const int stream = findLine(STREAM_LINE);
    CHECK(stream >= 0);
    if (stream >= 0) {
      CHECK(strstr(lines[stream], ": up to 1957 Mbps;") != NULL);
    }
    // The processing thread counts the bytes as received too
    expectedProcessLine(expected, sizeof(expected), 128, 128ULL * (unsigned long long)received, 128 * workUs);
    checkLine(expected);
  }
  // A decryption that fails is logged, and the stream goes on with the next packet
  resetStream();
  EncryptionFeaturesEnabled = SS_ENC_VIDEO;
  rtpOffset = (int)sizeof(ENC_VIDEO_HEADER);
  for (int i = 0; i < 10; i++) {
    addPacket(FULL_PACKET + (int)sizeof(ENC_VIDEO_HEADER), true, 5, 1);
  }
  failingDecryption = 4;
  runStream();
  CHECK_EQ_INT(decryptCalls, 10);
  CHECK_EQ_INT(queuedPackets, 9);
  CHECK_EQ_INT(countLines("Failed to decrypt video packet!\n"), 1);
  CHECK_EQ_INT(terminations, 0);
  // A plain packet is read into the buffer of its slot, which goes to the queue: no copy (since 2.3.5 the processing
  // thread puts a buffer of its own into the slot in its place)
  resetStream();
  for (int i = 0; i < 40; i++) {
    addPacket(FULL_PACKET, true, 5, 1);
  }
  runStream();
  CHECK(lastReceiveBuffer == lastQueuedPacket);
  CHECK_EQ_INT(lastReceiveSize, FULL_PACKET);
  CHECK_EQ_INT(decryptCalls, 0);
  CHECK_EQ_INT(queuedPackets, 40);
}

static void test_the_first_frame_limit_runs_on_the_processing_thread_by_the_read_times(void) {
  // A packet every 100 ms without a keyframe: the first is read at 1.1 s on the test clock, packet k at 1 + k / 10 s.
  // The processing thread, which runs after the reader here, ends the stream at the first packet read 10 s after the
  // first one (packet 101), by the times the reader noted, not by its own clock
  resetStream();
  clockStepUs = 0;
  pollUs = 0;
  noKeyframe = true;
  for (int i = 0; i < 150; i++) {
    addPacket(FULL_PACKET, false, 100000, 1);
  }
  runStream();
  CHECK_EQ_INT(terminations, 1);
  CHECK_EQ_INT(terminationError, ML_ERROR_NO_VIDEO_FRAME);
  checkLine("Terminating connection due to lack of a successful video frame\n");
  CHECK_EQ_INT(queuedPackets, 100);
  // The reader read all of them (here before the processing thread ran)
  CHECK_EQ_INT(receiveCalls, 150);
  const int process = findLine(PROCESS_LINE);
  CHECK(process > findLine("Terminating connection due to lack of a successful video frame\n"));
  if (process >= 0) {
    CHECK(strstr(lines[process], " 101 packets, ") != NULL);
  }

  // With a keyframe in the first packet, the same packets pass
  resetStream();
  clockStepUs = 0;
  pollUs = 0;
  for (int i = 0; i < 150; i++) {
    addPacket(FULL_PACKET, false, 100000, 1);
  }
  runStream();
  CHECK_EQ_INT(terminations, 0);
  CHECK_EQ_INT(queuedPackets, 150);
}

static void test_the_processing_thread_logs_a_line_each_minute_of_its_time(void) {
  // 2100 packets, each of which takes the RTP queue 40 ms: the processing thread checks the minute after each batch of
  // 32 packets (1.28 s), so its first minute ends after 47 batches (60.16 s); then 84 s for the stream
  resetStream();
  clockStepUs = 0;
  pollUs = 0;
  workUs = 40000;
  for (int i = 0; i < 2100; i++) {
    addPacket(FULL_PACKET, true, 5, 1);
  }
  runStream();
  CHECK_EQ_INT(countLines(PROCESS_MINUTE_LINE), 1);
  // 1504 packets in 60.16 s: 25 packets/s, 40,000 us each, up to (1408 + 28) * 8 * 1504 / 60160000 = 0.29 Mbps; the
  // ring held all 2100 packets in that minute
  checkLine("Video processing, last 60 s: 25 packets/s, 40000.0 us of work each, idle 0% (looking 0%): up to 0 Mbps; "
            "ring up to 2100 of 32768 packets, full 0 times for 0 ms; 0 wakes\n");
  checkLine("Video processing of the stream, 84 s: 2100 packets, 40000.0 us of work each, idle 0% (looking 0%): up to 0 "
            "Mbps; ring up to 2100 of 32768 packets, full 0 times for 0 ms; 0 wakes\n");
  const int minute = findLine(PROCESS_MINUTE_LINE);
  CHECK(minute >= 0 && minute < findLine(PROCESS_LINE));
}

// After a stream of plain video with every 5th packet rejected: the slot of the packet after a rejected one has the
// buffer that the rejected packet was received into
static int rejectedBufferElsewhere;
static void checkRejectedBuffersInTheNextSlot(void) {
  rejectedBufferElsewhere = 0;
  for (int i = 0; i + 1 < scriptLength; i++) {
    if (rejected[i] && receiveRing.slots[(uint32_t)(i + 1) & (receiveRing.slotCount - 1)].buffer != servedBuffer[i]) {
      rejectedBufferElsewhere++;
    }
  }
}

static void test_a_packet_that_the_queue_rejects_leaves_its_buffer_for_the_next_one(void) {
  // Plain video, every 5th packet rejected (in a real stream every surplus parity packet of a block that is complete,
  // and every late or duplicate packet): the processing thread put a buffer of its own into the slot of the packet, and
  // the buffer of the rejected packet goes into the slot of the next one. No buffer is in two slots (runStream()) and
  // none is lost (the leak check of the address sanitizer at the end of the test)
  resetStream();
  rejectEvery = 5;
  afterProcessing = checkRejectedBuffersInTheNextSlot;
  for (int i = 0; i < 200; i++) {
    addPacket(FULL_PACKET, true, 5, 1);
  }
  runStream();
  CHECK_EQ_INT(queuedPackets, 160);
  CHECK_EQ_INT(rejectedPackets, 40);
  CHECK_EQ_INT(rejectedBufferElsewhere, 0);
  CHECK_EQ_INT(terminations, 0);
  // Encrypted video: the buffer that a rejected packet was decrypted into is the one the next packet is decrypted into
  resetStream();
  rejectEvery = 5;
  EncryptionFeaturesEnabled = SS_ENC_VIDEO;
  rtpOffset = (int)sizeof(ENC_VIDEO_HEADER);
  for (int i = 0; i < 200; i++) {
    addPacket(FULL_PACKET + (int)sizeof(ENC_VIDEO_HEADER), true, 5, 1);
  }
  runStream();
  CHECK_EQ_INT(queuedPackets, 160);
  CHECK_EQ_INT(rejectedPackets, 40);
  CHECK_EQ_INT(decryptCalls, 200);
  int decryptedElsewhere = 0;
  for (int i = 0; i + 1 < 200; i++) {
    if (rejected[i] && (decryptedInto[i + 1] != decryptedInto[i] || decryptedInto[i] == NULL)) {
      decryptedElsewhere++;
    }
  }
  CHECK_EQ_INT(decryptedElsewhere, 0);
}

static void test_the_lines_of_the_processing_thread_from_chosen_figures(void) {
  // logVideoProcessFigures() itself, with figures that the cases above can't make (the processing thread runs after
  // the reader there, so it never waits, looks or is woken, and the ring is never full)
  resetStream();
  receiveRing.slotCount = 1024;
  // A minute of 1,200,000 packets of 1408 bytes, idle 24 of its 60 s, 9 s of them looking again: busy 36 s, so 30 us
  // of work per packet and up to (1408 + 28) * 8 / 30 = 383 Mbps; the counts of the ring are those of the minute (full
  // 7 - 4 times for 9600 - 2100 us, 2500 - 2000 wakes), its most packets those since the start of the minute
  const VIDEO_PROC_FIGURES before = { .packets = 300000, .bytes = 300000ULL * 1408, .idleUs = 6000000, .lookUs = 3000000 };
  const VIDEO_PROC_FIGURES now = { .packets = 1500000, .bytes = 1500000ULL * 1408, .idleUs = 30000000,
                                   .lookUs = 12000000 };
  const VIDEO_RECV_RING_FIGURES ringBefore = { .maxDepth = 250, .windowMaxDepth = 180, .fullWaits = 4, .fullWaitUs = 2100,
                                               .wakes = 2000 };
  const VIDEO_RECV_RING_FIGURES ringNow = { .maxDepth = 300, .windowMaxDepth = 212, .fullWaits = 7, .fullWaitUs = 9600,
                                            .wakes = 2500 };
  logVideoProcessFigures(&now, &before, &ringNow, &ringBefore, 60000000, false);
  checkLine("Video processing, last 60 s: 20000 packets/s, 30.0 us of work each, idle 40% (looking 15%): up to 383 Mbps; "
            "ring up to 212 of 1024 packets, full 3 times for 8 ms; 500 wakes\n");
  // The whole stream of 75 s: idle 30 s, 12 s of them looking, the most packets in the ring and every count since the
  // start
  logVideoProcessFigures(&now, NULL, &ringNow, NULL, 75000000, true);
  checkLine("Video processing of the stream, 75 s: 1500000 packets, 30.0 us of work each, idle 40% (looking 16%): up to "
            "383 Mbps; ring up to 300 of 1024 packets, full 7 times for 10 ms; 2500 wakes\n");
  // Idle at most the time of the line and looking at most the idle time: nothing left for work, so no rate
  const VIDEO_PROC_FIGURES clamped = { .packets = 3, .bytes = 3 * 1408, .idleUs = 5000000, .lookUs = 7000000 };
  const VIDEO_RECV_RING_FIGURES ringFew = { .maxDepth = 3, .windowMaxDepth = 3, .fullWaits = 1, .fullWaitUs = 12,
                                            .wakes = 1 };
  logVideoProcessFigures(&clamped, NULL, &ringFew, NULL, 1000000, true);
  checkLine("Video processing of the stream, 1 s: 3 packets, 0.0 us of work each, idle 100% (looking 100%): up to n/a "
            "Mbps; ring up to 3 of 1024 packets, full 1 times for 0 ms; 1 wakes\n");
  const VIDEO_PROC_FIGURES moreLookThanIdle = { .packets = 1000, .bytes = 1000 * 1408, .idleUs = 1000000,
                                                .lookUs = 3000000 };
  logVideoProcessFigures(&moreLookThanIdle, NULL, &ringFew, NULL, 10000000, true);
  checkLine("Video processing of the stream, 10 s: 1000 packets, 9000.0 us of work each, idle 10% (looking 10%): up to 1 "
            "Mbps; ring up to 3 of 1024 packets, full 1 times for 0 ms; 1 wakes\n");
  receiveRing.slotCount = 0;
}

static void test_the_lines_fit_the_log_and_name_no_address(void) {
  // Every line of the receive thread and of the processing thread that the cases above logged
  CHECK(receiveLinesSeen >= 40);
  CHECK_EQ_INT(receiveLinesTooLong, 0);
  CHECK_EQ_INT(receiveLinesWithAddress, 0);
  // and long lines of a minute, of the stream and of the samples, with the times at their clamps (the longest form of
  // each, with every number at its largest, is measured by tests/unit/video-receive-lines.test.js)
  resetStream();
  clockStepUs = 0;
  workUs = 99999999;
  pollUs = 99999999;
  for (int i = 0; i < 1280; i++) {
    addPacket(FULL_PACKET, true, 99999999, 1);
  }
  runStream();
  CHECK(countLines(MINUTE_LINE) >= 1);
  CHECK_EQ_INT(countLines(STREAM_LINE), 1);
  char expected[512];
  computeSamples(1280);
  expectedCheckLine(expected, sizeof(expected), sampleCount, 99999.9, 0);
  checkLine(expected);
  const int stream = findLine(STREAM_LINE);
  if (stream >= 0) {
    CHECK(strstr(lines[stream], " 100% were waiting; 99999.9 us to read a waiting packet, 0.0 us of other work per "
                                "packet: up to 0 Mbps; clock read 0.0 us\n") != NULL);
  }
  // The processing thread: a line after each batch of 32 packets of 100 s, with the work at its clamp
  CHECK_EQ_INT(countLines(PROCESS_MINUTE_LINE), 1280 / VRR_BATCH);
  CHECK(hasLine("Video processing, last 3200 s: 0 packets/s, 99999.9 us of work each, idle 0% (looking 0%): up to 0 "
                "Mbps; ring up to 1280 of 32768 packets, full 0 times for 0 ms; 0 wakes\n"));
  checkLine("Video processing of the stream, 128000 s: 1280 packets, 99999.9 us of work each, idle 0% (looking 0%): up "
            "to 0 Mbps; ring up to 1280 of 32768 packets, full 0 times for 0 ms; 0 wakes\n");
  CHECK_EQ_INT(receiveLinesTooLong, 0);
  CHECK_EQ_INT(receiveLinesWithAddress, 0);
  CHECK(hasDottedAddress("from 192.168.1.20 on"));
}

int main(void) {
  RUN_TEST("the samples fall about every 64th receive at gaps that vary, also on frames of one size",
           test_the_samples_fall_about_every_64th_receive_at_gaps_that_vary);
  RUN_TEST("timeout mode reads each packet with one recvfrom() and samples about every 64th receive",
           test_timeout_mode_reads_each_packet_with_one_recvfrom_and_samples_about_every_64th);
  RUN_TEST("the share of waiting packets comes from the sampled receives only",
           test_the_waiting_share_comes_from_the_sample_only);
  RUN_TEST("a failed poll() leaves a sample out and an error of the socket is no packet waiting",
           test_a_failed_poll_leaves_a_sample_out_and_a_socket_error_is_no_packet_waiting);
  RUN_TEST("poll mode, with poll() before each receive, when no socket that never waits can be made",
           test_poll_mode_when_no_socket_that_never_waits_can_be_made);
  RUN_TEST("back-to-back mode replaces the socket before the threads start and reads it with recvUdpSocketNoWait()",
           test_back_to_back_mode_replaces_the_socket_before_the_threads_start);
  RUN_TEST("the receive thread is woken before each join when it reads a socket that never waits",
           test_the_receive_thread_is_woken_before_each_join_when_it_reads_a_socket_that_never_waits);
  RUN_TEST("the limit of 10 s without a first packet is unchanged in every mode",
           test_the_first_packet_limit_is_unchanged_in_every_mode);
  RUN_TEST("an error ends the loop as before and the stream is still summed up",
           test_an_error_ends_the_loop_and_still_sums_the_stream_up);
  RUN_TEST("the stop ends the loop with one stream line, none without a packet",
           test_the_stop_ends_the_loop_with_one_stream_line);
  RUN_TEST("a line each minute while video comes, also when it ends in a pause, none for a minute without packets",
           test_a_line_each_minute_while_video_comes);
  RUN_TEST("encrypted video is read into the buffer of its slot, decrypted into another one, and its bytes count as "
           "received; a plain packet goes to the queue in the buffer it was received into",
           test_encrypted_video_is_read_into_its_own_buffer_and_counted_as_received);
  RUN_TEST("the limit of 10 s for the first frame runs on the processing thread, by the times the reader read the packets",
           test_the_first_frame_limit_runs_on_the_processing_thread_by_the_read_times);
  RUN_TEST("the processing thread logs a line each minute of its time and one for the stream",
           test_the_processing_thread_logs_a_line_each_minute_of_its_time);
  RUN_TEST("a packet that the RTP queue rejects leaves its buffer for the next one: no buffer in two slots, none lost",
           test_a_packet_that_the_queue_rejects_leaves_its_buffer_for_the_next_one);
  RUN_TEST("the lines of the processing thread from chosen figures: work, idle, looking, rate and the ring of the minute",
           test_the_lines_of_the_processing_thread_from_chosen_figures);
  RUN_TEST("the lines fit a line of the diagnostic log and name no address",
           test_the_lines_fit_the_log_and_name_no_address);
  return test_summary();
}
