// Checks the frame state of the video depacketizer of moonlight-common-c (moonlight-common-c/src/VideoDepacketizer.c,
// included directly) with the fixes of upstream that Moonlight Plus ported by hand in 2.3.1:
//  - bf71226: a frame is reassembled up to 32 MiB and 65,536 fragments; a larger one is dropped with a keyframe
//    request, and so is a packet that continues a frame whose start never came. That was an assert only, which the
//    release build leaves out, so such a packet became a frame of its own (with the frame type of the frame before) or
//    joined two frames into one. A frame whose decode unit can't be allocated is dropped instead of being glued to the
//    next frame (only here: in the module of the TV a failed allocation aborts the module, the default of Emscripten).
//  - 348d5d1: a frame completed while the decode unit queue is shut down at a stop is freed, without a keyframe
//    request; a queue overflow still counts as a drop of the client (the local counters of Moonlight Plus).
//  - e64327c: a lock between the receive thread and the decoder thread. A decoder refresh (a frame the player rejected,
//    DR_NEED_IDR) while a keyframe is arriving lets that keyframe through instead of dropping it and waiting for the
//    next one; a refresh waits for the packet that the receive thread is processing; a decoder that submits directly
//    may ask for a refresh from its callback, which runs with the lock released.
//  - ae6633e: RFI and IDR waits stay mutually exclusive.
//  - 0b4a44d: a second stream in the same process (every reconnect of the Stream Menu) starts with the consecutive
//    drop count at zero.
// Since 2.3.5 the RTP queue hands the packets of a complete frame over at once (queueRtpPackets(), called by
// submitCompletedFrame() of RtpVideoQueue.c), and the depacketizer takes its lock once for the frame instead of once per
// packet; a keyframe still gives it back after each packet, so that a decoder refresh that waits for the lock gets in
// between its packets and keeps it as before (e64327c). A refresh that waits during another frame now comes after that
// frame, which it flushes from the queue. The slow path of H.264 and HEVC (several NAL units in the first packet of a
// keyframe) makes the same decode unit through either function.
// It also checks where the depacketizer tells the limit of the IDR frame requests of Moonlight Plus (IdrRequestLimit.h,
// tests/native/idr_request_limit_test.c) that an IDR frame arrived: once, at the first packet of the keyframe.
// And the times of a decode unit in microseconds (receiveTimeUs, enqueueTimeUs) that 2.3.2 ported from upstream 82ee2d6
// for the frame times of the statistics, next to the millisecond fields that stay: the receive time of the first packet
// of the frame and the time it was queued, each pair from one reading of the clock, and a presentation time that the
// depacketizer makes up for a host without one still in whole milliseconds of the receive time, as before. Also the
// arrival figures of a frame (arrivalTimeUs, arrivalBytes, 2.3.2), which the RTP video queue hands over with each packet
// of a complete frame (frame_arrival_test.c) and the decode unit takes from the first packet of its frame.
// The test feeds packets the way RtpVideoQueue.c hands them over (the queue entry behind the packet in the same
// allocation, which the depacketizer takes over) for an AV1 stream of Sunshine, whose frames pass through unparsed with
// the frame type in the header, and counts the allocations of VideoDepacketizer.c and of the packets, so that a decode
// unit or packet that the depacketizer loses shows up as a leak. run.sh runs it once more with the thread sanitizer (the
// line below), which must report nothing.
// Thread sanitizer: yes

// The thread functions of Platform.c need the GNU extensions of the C library
#define _GNU_SOURCE

#include "test_support_c.h"

#include "../../moonlight-common-c/src/Limelight-internal.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// Every allocation of VideoDepacketizer.c and of the packets of the test goes through these, and the depacketizer
// frees the packets it takes over with free(). An allocation of VideoDepacketizer.c fails while failingAllocations is
// above zero.
static long outstandingAllocations;
static int failingAllocations;
static void* TestPacketMalloc(size_t size) {
  outstandingAllocations++;
  return malloc(size);
}
static void* TestMalloc(size_t size) {
  if (failingAllocations > 0) {
    failingAllocations--;
    return NULL;
  }
  return TestPacketMalloc(size);
}
static void TestFree(void* pointer) {
  if (pointer != NULL) {
    outstandingAllocations--;
  }
  free(pointer);
}
#define malloc(size) TestMalloc(size)
#define free(pointer) TestFree(pointer)
// The locks that VideoDepacketizer.c takes, counted for its stateLock (2.3.5: once per frame), and a thread that waits
// for that lock: waitingForLock runs right after the next release of stateLock, as a thread of the decoder that waits
// for it would get it first at the earliest
static int stateLockCount;
static void (*waitingForLock)(void);
static void TestLockMutex(PLT_MUTEX* mutex);
static void TestUnlockMutex(PLT_MUTEX* mutex);
#define PltLockMutex(mutex) TestLockMutex(mutex)
#define PltUnlockMutex(mutex) TestUnlockMutex(mutex)
#include "../../moonlight-common-c/src/VideoDepacketizer.c"
#undef PltLockMutex
#undef PltUnlockMutex
#undef malloc
#undef free

#include "../../moonlight-common-c/src/ByteBuffer.c"
#include "../../moonlight-common-c/src/LinkedBlockingQueue.c"
#include "../../moonlight-common-c/src/Platform.c"

static void TestLockMutex(PLT_MUTEX* mutex) {
  if (mutex == &stateLock) {
    stateLockCount++;
  }
  PltLockMutex(mutex);
}

// The state of the depacketizer when the waiting thread got the lock
static bool waiterSawDecodingFrame;
static bool waiterRan;

static void TestUnlockMutex(PLT_MUTEX* mutex) {
  PltUnlockMutex(mutex);
  if (mutex == &stateLock && waitingForLock != NULL) {
    void (*waiter)(void) = waitingForLock;
    waitingForLock = NULL;
    // (read without the lock: the test runs on one thread)
    waiterSawDecodingFrame = decodingFrame;
    waiterRan = true;
    waiter();
  }
}

// Packets made by feedPacket() while preparing go into a list linked like the frame that RtpVideoQueue.c hands over
static bool preparing;
static PRTPV_QUEUE_ENTRY preparedHead;
static PRTPV_QUEUE_ENTRY preparedTail;

// What the other files of moonlight-common-c provide: a Sunshine host (7.1.431.-1) that streams AV1
int AppVersionQuad[4] = {7, 1, 431, -1};
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
DECODER_RENDERER_CALLBACKS VideoCallbacks;
int NegotiatedVideoFormat = VIDEO_FORMAT_AV1_MAIN8;

// Platform.c brings up the sockets and ENet for a connection, which the test never starts
int initializePlatformSockets(void) {
  return 0;
}
void cleanupPlatformSockets(void) {}
int enet_initialize(void) {
  return 0;
}
void enet_deinitialize(void) {}
void enterLowLatencyMode(void) {}
void exitLowLatencyMode(void) {}

// The receive time of the next packet in microseconds, which RtpVideoQueue.c sets from PltGetMicroseconds(): a
// millisecond after the packet before unless a test sets it, on a clock of the test
static uint64_t fakeReceiveUs;
// The arrival figures of the frame that the queue hands over with the next packet (none unless a test sets them)
static uint32_t fakeArrivalUs;
static uint32_t fakeArrivalBytes;
// Packets without a presentation time, as some versions of Sunshine send them
static bool noPresentationTime;
static bool rfiEnabled;
static int idrRequests;
static int rfiRequests;
static int completeFrames;
static void (*keyFrameHook)(void);
static char logLines[8192];

bool isReferenceFrameInvalidationEnabled(void) {
  return rfiEnabled;
}
void LiRequestIdrFrame(void) {
  idrRequests++;
}
void connectionDetectedFrameLoss(uint32_t startFrame, uint32_t endFrame) {
  (void)startFrame;
  (void)endFrame;
  rfiRequests++;
}
void connectionReceivedCompleteFrame(uint32_t frameIndex) {
  (void)frameIndex;
  completeFrames++;
}
// Moonlight Plus: an IDR frame tells the limit of the IDR frame requests (ControlStream.c) that it arrived
static int idrArrivals;
void connectionReceivedIdrFrame(void) {
  idrArrivals++;
}
// Called in reassembleFrame() for every keyframe, so with the lock of the depacketizer held
void notifyKeyFrameReceived(void) {
  if (keyFrameHook != NULL) {
    keyFrameHook();
  }
}
bool LiGetCurrentHostDisplayHdrMode(void) {
  return false;
}

static void logMessage(const char* format, ...) {
  va_list args;
  const size_t used = strlen(logLines);
  va_start(args, format);
  vsnprintf(logLines + used, sizeof(logLines) - used, format, args);
  va_end(args);
}

#define FRAME_TYPE_HEADER_P 1
#define FRAME_TYPE_HEADER_IDR 2

// The stream packet index of the next packet
static uint32_t nextStreamPacketIndex;

static void startStream(bool withRfi) {
  rfiEnabled = withRfi;
  idrRequests = 0;
  rfiRequests = 0;
  completeFrames = 0;
  idrArrivals = 0;
  keyFrameHook = NULL;
  failingAllocations = 0;
  logLines[0] = '\0';
  nextStreamPacketIndex = 0;
  memset(&VideoCallbacks, 0, sizeof(VideoCallbacks));
  ListenerCallbacks.logMessage = logMessage;
  initializeVideoDepacketizer(1392);
}

// The end of a stream as LiStopConnection() does it, after which nothing that the depacketizer allocated may remain
static void endStream(void) {
  stopVideoDepacketizer();
  destroyVideoDepacketizer();
  CHECK_EQ_INT(outstandingAllocations, 0);
  outstandingAllocations = 0;
}

// Hand one packet to the depacketizer as RtpVideoQueue.c does: the RTP header, the video packet header and the payload,
// with the queue entry behind them in the same allocation
static void feedPacket(uint32_t frameIndex, uint8_t flags, const uint8_t* payload, int payloadLength) {
  const int length = (int)(sizeof(RTP_PACKET) + sizeof(NV_VIDEO_PACKET)) + payloadLength;
  const size_t entryOffset = ((size_t)length + 7) & ~(size_t)7;
  char* buffer = TestPacketMalloc(entryOffset + sizeof(RTPV_QUEUE_ENTRY));
  memset(buffer, 0, entryOffset + sizeof(RTPV_QUEUE_ENTRY));
  PNV_VIDEO_PACKET video = (PNV_VIDEO_PACKET)(buffer + sizeof(RTP_PACKET));
  // The depacketizer takes the stream packet index from the upper 24 bits
  video->streamPacketIndex = nextStreamPacketIndex++ << 8;
  video->frameIndex = frameIndex;
  video->flags = flags;
  memcpy(video + 1, payload, (size_t)payloadLength);
  PRTPV_QUEUE_ENTRY entry = (PRTPV_QUEUE_ENTRY)(buffer + entryOffset);
  entry->packet = (PRTP_PACKET)buffer;
  entry->length = length;
  fakeReceiveUs += 1000;
  entry->receiveTimeUs = fakeReceiveUs;
  entry->frameArrivalTimeUs = fakeArrivalUs;
  entry->frameArrivalBytes = fakeArrivalBytes;
  entry->presentationTimeMs = noPresentationTime ? 0 : frameIndex * 16;
  if (preparing) {
    entry->next = NULL;
    if (preparedTail != NULL) {
      preparedTail->next = entry;
    }
    else {
      preparedHead = entry;
    }
    preparedTail = entry;
    return;
  }
  queueRtpPacket(entry);
}

// The packets prepared so far, handed over at once as submitCompletedFrame() of RtpVideoQueue.c does
static void feedPrepared(void) {
  PRTPV_QUEUE_ENTRY head = preparedHead;
  preparedHead = preparedTail = NULL;
  stateLockCount = 0;
  queueRtpPackets(head);
}

// Packet `index` of the `count` packets of an AV1 frame, each with `size` bytes of picture data; the first one starts
// with the frame header of Sunshine (0x01, the host processing latency, the frame type, the length of the last packet)
static uint8_t payload[8 + 65536];
static void feedFramePacket(uint32_t frameIndex, uint8_t frameType, int index, int count, int size) {
  uint8_t flags = FLAG_CONTAINS_PIC_DATA;
  int offset = 0;
  if (index == 0) {
    const int lastLength = count == 1 ? 8 + size : size;
    flags |= FLAG_SOF;
    payload[0] = 0x01;
    payload[1] = 1;
    payload[2] = 0;
    payload[3] = frameType;
    payload[4] = (uint8_t)(lastLength & 0xFF);
    payload[5] = (uint8_t)(lastLength >> 8);
    payload[6] = 0;
    payload[7] = 0;
    offset = 8;
  }
  if (index == count - 1) {
    flags |= FLAG_EOF;
  }
  memset(payload + offset, (int)(frameIndex & 0xFF), (size_t)size);
  feedPacket(frameIndex, flags, payload, offset + size);
}

static void feedFrame(uint32_t frameIndex, uint8_t frameType, int count, int size) {
  for (int i = 0; i < count; i++) {
    feedFramePacket(frameIndex, frameType, i, count, size);
  }
}

// Take the next decode unit from the queue as the decoder thread does (VideoDecoderThreadProc() of VideoStream.c),
// check it and complete it with the given status of the decoder. Returns its full length, or -1 without one.
static int takeFrame(int frameNumber, int frameType, int drStatus) {
  VIDEO_FRAME_HANDLE handle;
  PDECODE_UNIT decodeUnit;
  if (!LiPollNextVideoFrame(&handle, &decodeUnit)) {
    CHECK(!"a decode unit in the queue");
    return -1;
  }
  const int fullLength = decodeUnit->fullLength;
  CHECK_EQ_INT(decodeUnit->frameNumber, frameNumber);
  CHECK_EQ_INT(decodeUnit->frameType, frameType);
  LiCompleteVideoFrame(handle, drStatus);
  return fullLength;
}

// The first keyframe of a stream, which the decoder took
static void startWithAKeyframe(bool withRfi) {
  startStream(withRfi);
  feedFrame(1, FRAME_TYPE_HEADER_IDR, 1, 100);
  CHECK_EQ_INT(takeFrame(1, FRAME_TYPE_IDR, DR_OK), 100);
  CHECK_EQ_INT(idrRequests, 0);
}

static void AFrameOver32MiBIsDroppedWithAKeyframeRequest(void) {
  startWithAKeyframe(false);
  // Exactly 32 MiB of picture data still passes
  feedFrame(2, FRAME_TYPE_HEADER_P, 1024, 32768);
  CHECK_EQ_INT(takeFrame(2, FRAME_TYPE_PFRAME, DR_OK), 32 * 1024 * 1024);
  CHECK_EQ_INT(idrRequests, 0);
  // A frame that grows past it is dropped at the packet that crosses the bound, with a keyframe request, and the rest
  // of the frame is ignored. It used to be reassembled whatever its size.
  for (int i = 0; i < 1024; i++) {
    feedFramePacket(3, FRAME_TYPE_HEADER_P, i, 1026, 32768);
  }
  CHECK_EQ_INT(idrRequests, 0);
  CHECK(strstr(logLines, "Depacketizer rejected oversized or unallocatable frame") == NULL);
  feedFramePacket(3, FRAME_TYPE_HEADER_P, 1024, 1026, 32768);
  CHECK(strstr(logLines, "Depacketizer rejected oversized or unallocatable frame: 3") != NULL);
  CHECK_EQ_INT(idrRequests, 1);
  feedFramePacket(3, FRAME_TYPE_HEADER_P, 1025, 1026, 32768);
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 0);
  CHECK_EQ_INT(idrRequests, 1);
  // The next keyframe recovers the stream
  feedFrame(4, FRAME_TYPE_HEADER_IDR, 2, 100);
  CHECK_EQ_INT(takeFrame(4, FRAME_TYPE_IDR, DR_OK), 200);
  endStream();
}

static void AFrameOf65537FragmentsIsDropped(void) {
  startWithAKeyframe(false);
  feedFrame(2, FRAME_TYPE_HEADER_P, 65536, 1);
  CHECK_EQ_INT(takeFrame(2, FRAME_TYPE_PFRAME, DR_OK), 65536);
  CHECK_EQ_INT(idrRequests, 0);
  feedFrame(3, FRAME_TYPE_HEADER_P, 65537, 1);
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 0);
  CHECK_EQ_INT(idrRequests, 1);
  CHECK(strstr(logLines, "Depacketizer rejected oversized or unallocatable frame: 3") != NULL);
  endStream();
}

static void APacketWithoutTheStartOfItsFrameIsRejected(void) {
  startWithAKeyframe(false);
  // A packet of frame 2 that continues a frame, in sequence, but no packet of frame 2 started it. It used to become a
  // frame of its own, with the frame type of the keyframe before it.
  feedPacket(2, FLAG_CONTAINS_PIC_DATA | FLAG_EOF, payload, 108);
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 0);
  CHECK(strstr(logLines, "Depacketizer detected invalid frame start: 2") != NULL);
  CHECK_EQ_INT(idrRequests, 1);
  // A keyframe recovers the stream
  feedFrame(3, FRAME_TYPE_HEADER_IDR, 1, 100);
  CHECK_EQ_INT(takeFrame(3, FRAME_TYPE_IDR, DR_OK), 100);

  // A packet of frame 5 without its start, in sequence after the first packet of frame 4: it used to join the two
  // frames into one decode unit
  logLines[0] = '\0';
  feedFramePacket(4, FRAME_TYPE_HEADER_P, 0, 2, 100);
  feedFramePacket(5, FRAME_TYPE_HEADER_P, 1, 2, 100);
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 0);
  CHECK(strstr(logLines, "Depacketizer detected invalid frame start: 5") != NULL);
  CHECK_EQ_INT(idrRequests, 2);
  endStream();
}

static void AFrameWhoseDecodeUnitCantBeAllocatedIsDropped(void) {
  startWithAKeyframe(false);
  // The packet buffer becomes the only fragment of the frame, so the decode unit is the one allocation of the
  // depacketizer for this frame
  failingAllocations = 1;
  feedFrame(2, FRAME_TYPE_HEADER_P, 1, 100);
  CHECK_EQ_INT(failingAllocations, 0);
  CHECK(strstr(logLines, "Unable to allocate video decode unit") != NULL);
  CHECK_EQ_INT(idrRequests, 1);
  // The next frame carries only its own data: the chain of the dropped one is gone
  feedFrame(3, FRAME_TYPE_HEADER_IDR, 1, 50);
  CHECK_EQ_INT(takeFrame(3, FRAME_TYPE_IDR, DR_OK), 50);
  endStream();
}

static void AFrameCompletedAtAStopIsFreed(void) {
  startWithAKeyframe(false);
  feedFrame(2, FRAME_TYPE_HEADER_P, 1, 100);
  const int completeBefore = completeFrames;
  // The stop shuts the decode unit queue down while the receive thread still completes a frame
  stopVideoDepacketizer();
  feedFrame(3, FRAME_TYPE_HEADER_P, 2, 100);
  CHECK(strstr(logLines, "Failed to queue video decode unit: 1") != NULL);
  // Nothing to recover at a stop, and no drop of the client
  CHECK_EQ_INT(idrRequests, 0);
  CHECK_EQ_INT(LiGetClientVideoResets(), 0);
  CHECK_EQ_INT(LiGetClientDroppedVideoFrames(), 0);
  CHECK_EQ_INT(completeFrames, completeBefore);
  // endStream() checks that the decode unit of frame 3 and its packets were freed
  endStream();
}

static void AQueueOverflowStillCountsAsADropOfTheClient(void) {
  startWithAKeyframe(false);
  // The queue holds 15 decode units; the 16th overflows it and the queue is flushed
  for (uint32_t frame = 2; frame <= 17; frame++) {
    feedFrame(frame, FRAME_TYPE_HEADER_P, 1, 100);
  }
  CHECK(strstr(logLines, "Video decode unit queue overflow") != NULL);
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 0);
  CHECK_EQ_INT(idrRequests, 1);
  CHECK_EQ_INT(LiGetClientVideoResets(), 1);
  CHECK_EQ_INT(LiGetClientDroppedVideoFrames(), 16);
  // A frame while waiting for the keyframe counts as dropped by the client too
  feedFrame(18, FRAME_TYPE_HEADER_P, 1, 100);
  CHECK_EQ_INT(LiGetClientDroppedVideoFrames(), 17);
  feedFrame(19, FRAME_TYPE_HEADER_IDR, 1, 100);
  CHECK_EQ_INT(takeFrame(19, FRAME_TYPE_IDR, DR_OK), 100);
  endStream();
}

static void ARefreshWhileAKeyframeArrivesKeepsThatKeyframe(void) {
  startWithAKeyframe(false);
  feedFrame(2, FRAME_TYPE_HEADER_P, 1, 100);
  // The first packet of keyframe 3 arrives on the receive thread...
  feedFramePacket(3, FRAME_TYPE_HEADER_IDR, 0, 2, 100);
  // ...while the player rejects frame 2 on the decoder thread, which asks for a refresh (DR_NEED_IDR)
  CHECK_EQ_INT(takeFrame(2, FRAME_TYPE_PFRAME, DR_NEED_IDR), 100);
  CHECK_EQ_INT(idrRequests, 1);
  // The rest of keyframe 3: it answers the refresh. It used to be dropped while waiting for a keyframe, so the picture
  // stood until the keyframe of the request came.
  feedFramePacket(3, FRAME_TYPE_HEADER_IDR, 1, 2, 100);
  CHECK(strstr(logLines, "Waiting for IDR frame") == NULL);
  CHECK_EQ_INT(takeFrame(3, FRAME_TYPE_IDR, DR_OK), 200);
  // The stream goes on with the frames after it, and nothing more is counted as dropped
  feedFrame(4, FRAME_TYPE_HEADER_P, 1, 100);
  CHECK_EQ_INT(takeFrame(4, FRAME_TYPE_PFRAME, DR_OK), 100);
  CHECK_EQ_INT(LiGetClientDroppedVideoFrames(), 0);
  CHECK_EQ_INT(LiGetClientVideoResets(), 1);
  CHECK_EQ_INT(idrRequests, 1);

  // A refresh between two frames still drops the frames up to the next keyframe
  feedFrame(5, FRAME_TYPE_HEADER_P, 1, 100);
  CHECK_EQ_INT(takeFrame(5, FRAME_TYPE_PFRAME, DR_NEED_IDR), 100);
  feedFrame(6, FRAME_TYPE_HEADER_P, 1, 100);
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 0);
  CHECK(strstr(logLines, "Waiting for IDR frame") != NULL);
  CHECK_EQ_INT(LiGetClientDroppedVideoFrames(), 1);
  feedFrame(7, FRAME_TYPE_HEADER_IDR, 1, 100);
  CHECK_EQ_INT(takeFrame(7, FRAME_TYPE_IDR, DR_OK), 100);
  endStream();
}

// A decoder refresh on another thread while the receive thread is inside reassembleFrame() with a keyframe
static pthread_mutex_t refreshMutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t refreshCond = PTHREAD_COND_INITIALIZER;
static bool refreshDone;
static bool refreshDoneDuringFrame;
static pthread_t refreshThread;

static void* refreshThreadFunc(void* context) {
  (void)context;
  requestDecoderRefresh();
  pthread_mutex_lock(&refreshMutex);
  refreshDone = true;
  pthread_cond_signal(&refreshCond);
  pthread_mutex_unlock(&refreshMutex);
  return NULL;
}

static void startRefreshDuringKeyframe(void) {
  struct timespec deadline;
  keyFrameHook = NULL;
  CHECK(pthread_create(&refreshThread, NULL, refreshThreadFunc, NULL) == 0);
  // Give the refresh 200 ms to finish; with the lock it waits for the receive thread instead
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_nsec += 200 * 1000 * 1000;
  if (deadline.tv_nsec >= 1000 * 1000 * 1000) {
    deadline.tv_sec++;
    deadline.tv_nsec -= 1000 * 1000 * 1000;
  }
  pthread_mutex_lock(&refreshMutex);
  while (!refreshDone) {
    if (pthread_cond_timedwait(&refreshCond, &refreshMutex, &deadline) != 0) {
      break;
    }
  }
  refreshDoneDuringFrame = refreshDone;
  pthread_mutex_unlock(&refreshMutex);
}

static void ARefreshWaitsForThePacketOfTheReceiveThread(void) {
  startWithAKeyframe(false);
  refreshDone = false;
  refreshDoneDuringFrame = false;
  keyFrameHook = startRefreshDuringKeyframe;
  feedFrame(2, FRAME_TYPE_HEADER_IDR, 1, 100);
  CHECK(pthread_join(refreshThread, NULL) == 0);
  CHECK(!refreshDoneDuringFrame);
  CHECK(refreshDone);
  // The refresh came after keyframe 2 was queued, so it flushed it and waits for the next keyframe
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 0);
  CHECK_EQ_INT(LiGetClientDroppedVideoFrames(), 1);
  CHECK_EQ_INT(idrRequests, 1);
  CHECK(waitingForIdrFrame);
  endStream();
}

// A decoder that submits directly on the receive thread and rejects the first frame after the keyframe
static int directSubmits;
static int directSubmit(PDECODE_UNIT decodeUnit) {
  directSubmits++;
  return decodeUnit->frameNumber == 2 ? DR_NEED_IDR : DR_OK;
}

static pthread_mutex_t feedMutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t feedCond = PTHREAD_COND_INITIALIZER;
static bool feedDone;

static void* directSubmitFeed(void* context) {
  (void)context;
  feedFrame(1, FRAME_TYPE_HEADER_IDR, 1, 100);
  feedFrame(2, FRAME_TYPE_HEADER_P, 1, 100);
  feedFrame(3, FRAME_TYPE_HEADER_P, 1, 100);
  feedFrame(4, FRAME_TYPE_HEADER_IDR, 1, 100);
  pthread_mutex_lock(&feedMutex);
  feedDone = true;
  pthread_cond_signal(&feedCond);
  pthread_mutex_unlock(&feedMutex);
  return NULL;
}

static void ADirectSubmitMayAskForARefresh(void) {
  pthread_t thread;
  struct timespec deadline;
  startStream(false);
  VideoCallbacks.capabilities = CAPABILITY_DIRECT_SUBMIT;
  VideoCallbacks.submitDecodeUnit = directSubmit;
  directSubmits = 0;
  feedDone = false;
  CHECK(pthread_create(&thread, NULL, directSubmitFeed, NULL) == 0);
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += 10;
  pthread_mutex_lock(&feedMutex);
  while (!feedDone) {
    if (pthread_cond_timedwait(&feedCond, &feedMutex, &deadline) != 0) {
      break;
    }
  }
  const bool done = feedDone;
  pthread_mutex_unlock(&feedMutex);
  if (!done) {
    // The refresh from the submit callback took the lock that the receive thread still held
    printf("  # FAILED: the receive thread hangs in the refresh of a direct submit\n");
    fflush(stdout);
    _exit(1);
  }
  CHECK(pthread_join(thread, NULL) == 0);
  // Frame 3 is dropped while waiting for the keyframe that the refresh asked for, and keyframe 4 is submitted
  CHECK_EQ_INT(directSubmits, 3);
  CHECK_EQ_INT(idrRequests, 1);
  endStream();
}

static void RfiAndIdrWaitsStayMutuallyExclusive(void) {
  startWithAKeyframe(true);
  feedFrame(2, FRAME_TYPE_HEADER_P, 1, 100);
  CHECK_EQ_INT(takeFrame(2, FRAME_TYPE_PFRAME, DR_OK), 100);
  // A lost frame with RFI: wait for the frame after the invalidation
  notifyFrameLost(3, false);
  CHECK_EQ_INT(rfiRequests, 1);
  CHECK(waitingForRefInvalFrame);
  CHECK(!waitingForIdrFrame);
  // A refresh of the decoder turns it into a wait for a keyframe
  requestDecoderRefresh();
  CHECK(waitingForIdrFrame);
  CHECK(!waitingForRefInvalFrame);
  feedFrame(4, FRAME_TYPE_HEADER_IDR, 1, 100);
  CHECK_EQ_INT(takeFrame(4, FRAME_TYPE_IDR, DR_OK), 100);

  // So does the consecutive drop limit during a wait for an RFI frame
  for (unsigned int frame = 5; frame < 5 + CONSECUTIVE_DROP_LIMIT; frame++) {
    notifyFrameLost(frame, false);
    CHECK(waitingForIdrFrame != waitingForRefInvalFrame);
  }
  CHECK(strstr(logLines, "Reached consecutive drop limit") != NULL);
  CHECK(waitingForIdrFrame);
  CHECK(!waitingForRefInvalFrame);
  endStream();
}

static void ASecondStreamStartsWithTheDropCountAtZero(void) {
  // A stream that ends one drop short of the limit, as a reconnect of the Stream Menu during a loss burst does
  startStream(false);
  for (unsigned int frame = 1; frame < CONSECUTIVE_DROP_LIMIT; frame++) {
    notifyFrameLost(frame, false);
  }
  CHECK_EQ_INT(idrRequests, 0);
  endStream();
  // The next stream in the same process: its first drop is its first, not the 120th of the stream before
  startStream(false);
  notifyFrameLost(1, false);
  CHECK_EQ_INT(idrRequests, 0);
  CHECK(strstr(logLines, "Reached consecutive drop limit") == NULL);
  CHECK_EQ_INT(consecutiveFrameDrops, 1);
  endStream();
}

// The only packet of an HEVC keyframe of Sunshine: the frame header, then VPS, SPS and PPS and the slice of the IDR
// picture (IDR_W_RADL), each after a start code
static void feedHevcKeyframe(uint32_t frameIndex) {
  static const uint8_t nals[] = {0, 0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 0, 1, 0x42, 0x01, 0x01, 0, 0, 0, 1, 0x44, 0x01, 0xc1,
                                 0, 0, 0, 1, 0x26, 0x01, 0xaf, 0x10, 0x20};
  const uint8_t header[8] = {0x01, 1, 0, FRAME_TYPE_HEADER_IDR, 0, 0, 0, 0};
  memcpy(payload, header, sizeof(header));
  memcpy(payload + sizeof(header), nals, sizeof(nals));
  feedPacket(frameIndex, FLAG_CONTAINS_PIC_DATA | FLAG_SOF | FLAG_EOF, payload, (int)(sizeof(header) + sizeof(nals)));
}

// The places where the depacketizer stops waiting for an IDR frame tell the limit of the IDR frame requests
// (connectionReceivedIdrFrame(), IdrRequestLimit.h) that one arrived, which ends the hold of later requests: the frame
// header of an AV1 keyframe and the IDR slice of an HEVC keyframe, each once, at the first packet. A P-frame doesn't,
// and neither does the end of a keyframe that answers a decoder refresh, whose first packet already told it before
// the refresh asked for a keyframe.
static void AnIdrFrameTellsTheLimitOfTheRequestsAtItsFirstPacket(void) {
  startStream(false);
  feedFramePacket(1, FRAME_TYPE_HEADER_IDR, 0, 3, 100);
  CHECK_EQ_INT(idrArrivals, 1);
  feedFramePacket(1, FRAME_TYPE_HEADER_IDR, 1, 3, 100);
  feedFramePacket(1, FRAME_TYPE_HEADER_IDR, 2, 3, 100);
  CHECK_EQ_INT(idrArrivals, 1);
  CHECK_EQ_INT(takeFrame(1, FRAME_TYPE_IDR, DR_OK), 300);
  feedFrame(2, FRAME_TYPE_HEADER_P, 2, 100);
  CHECK_EQ_INT(takeFrame(2, FRAME_TYPE_PFRAME, DR_OK), 200);
  CHECK_EQ_INT(idrArrivals, 1);
  // A decoder refresh between the first and the last packet of a keyframe, which that keyframe answers
  feedFramePacket(3, FRAME_TYPE_HEADER_IDR, 0, 2, 100);
  CHECK_EQ_INT(idrArrivals, 2);
  requestDecoderRefresh();
  CHECK_EQ_INT(idrRequests, 1);
  feedFramePacket(3, FRAME_TYPE_HEADER_IDR, 1, 2, 100);
  CHECK_EQ_INT(takeFrame(3, FRAME_TYPE_IDR, DR_OK), 200);
  CHECK_EQ_INT(idrArrivals, 2);
  endStream();

  // HEVC, whose keyframe the depacketizer finds in the bitstream
  NegotiatedVideoFormat = VIDEO_FORMAT_H265;
  startStream(false);
  feedHevcKeyframe(1);
  CHECK_EQ_INT(idrArrivals, 1);
  VIDEO_FRAME_HANDLE handle;
  PDECODE_UNIT decodeUnit;
  CHECK(LiPollNextVideoFrame(&handle, &decodeUnit));
  CHECK_EQ_INT(decodeUnit->frameType, FRAME_TYPE_IDR);
  LiCompleteVideoFrame(handle, DR_OK);
  endStream();
  NegotiatedVideoFormat = VIDEO_FORMAT_AV1_MAIN8;
}

// Take the next decode unit from the queue for a test of its times, or NULL without one
static PDECODE_UNIT pollFrame(VIDEO_FRAME_HANDLE* handle) {
  PDECODE_UNIT decodeUnit = NULL;
  if (!LiPollNextVideoFrame(handle, &decodeUnit)) {
    CHECK(!"a decode unit in the queue");
    return NULL;
  }
  return decodeUnit;
}

static void ADecodeUnitCarriesItsTimesInMicrosecondsAndMilliseconds(void) {
  startWithAKeyframe(false);
  // The first packet of frame 2 arrives at 5,000,999 us, its last one 1.5 ms later: the frame keeps the time of its
  // first packet, in microseconds and in whole milliseconds
  fakeReceiveUs = 5000999 - 1000;
  feedFramePacket(2, FRAME_TYPE_HEADER_P, 0, 2, 100);
  fakeReceiveUs = 5002499 - 1000;
  const uint64_t beforeUs = PltGetMicroseconds();
  feedFramePacket(2, FRAME_TYPE_HEADER_P, 1, 2, 100);
  const uint64_t afterUs = PltGetMicroseconds();
  VIDEO_FRAME_HANDLE handle;
  PDECODE_UNIT decodeUnit = pollFrame(&handle);
  if (decodeUnit != NULL) {
    CHECK_EQ_INT(decodeUnit->frameNumber, 2);
    CHECK_EQ_INT(decodeUnit->receiveTimeUs, 5000999);
    CHECK_EQ_INT(decodeUnit->receiveTimeMs, 5000);
    // The time it was queued, from the clock of the platform, and the same reading in milliseconds, which is what
    // LiGetMillis() returns at that moment
    CHECK(decodeUnit->enqueueTimeUs >= beforeUs && decodeUnit->enqueueTimeUs <= afterUs);
    CHECK_EQ_INT(decodeUnit->enqueueTimeMs, decodeUnit->enqueueTimeUs / 1000);
    CHECK(decodeUnit->enqueueTimeMs >= beforeUs / 1000 && decodeUnit->enqueueTimeMs <= PltGetMillis());
    LiCompleteVideoFrame(handle, DR_OK);
  }
  endStream();
}

static void AMadeUpPresentationTimeStaysInWholeMilliseconds(void) {
  // A host without presentation times: the depacketizer makes them up from the receive time of the first packet of
  // each frame since the first frame of the stream, in whole milliseconds of the clock as before 2.3.2
  startStream(false);
  noPresentationTime = true;
  const uint64_t receiveUs[] = {7000999, 7016000, 7032999, 7049001};
  const unsigned int expectedMs[] = {0, 16, 32, 49};
  for (int i = 0; i < 4; i++) {
    fakeReceiveUs = receiveUs[i] - 1000;
    feedFrame((uint32_t)(i + 1), i == 0 ? FRAME_TYPE_HEADER_IDR : FRAME_TYPE_HEADER_P, 1, 100);
    VIDEO_FRAME_HANDLE handle;
    PDECODE_UNIT decodeUnit = pollFrame(&handle);
    if (decodeUnit != NULL) {
      CHECK_EQ_INT(decodeUnit->frameNumber, i + 1);
      CHECK_EQ_INT(decodeUnit->receiveTimeUs, receiveUs[i]);
      // 7016 - 7000 ms, not the 15 ms of 7,016,000 - 7,000,999 us
      CHECK_EQ_INT(decodeUnit->presentationTimeMs, expectedMs[i]);
      LiCompleteVideoFrame(handle, DR_OK);
    }
  }
  noPresentationTime = false;
  endStream();
}

// The arrival figures of a frame reach its decode unit from its first packet (the queue sets the same on every packet
// of the frame; here the later packets carry others to tell them apart), and a frame without them has none
static void ADecodeUnitCarriesTheArrivalFiguresOfItsFirstPacket(void) {
  startWithAKeyframe(false);
  fakeArrivalUs = 8652;
  fakeArrivalBytes = 295816;
  feedFramePacket(2, FRAME_TYPE_HEADER_P, 0, 3, 100);
  fakeArrivalUs = 1;
  fakeArrivalBytes = 2;
  feedFramePacket(2, FRAME_TYPE_HEADER_P, 1, 3, 100);
  feedFramePacket(2, FRAME_TYPE_HEADER_P, 2, 3, 100);
  fakeArrivalUs = 0;
  fakeArrivalBytes = 0;
  feedFrame(3, FRAME_TYPE_HEADER_P, 2, 100);
  VIDEO_FRAME_HANDLE handle;
  PDECODE_UNIT decodeUnit = pollFrame(&handle);
  if (decodeUnit != NULL) {
    CHECK_EQ_INT(decodeUnit->frameNumber, 2);
    CHECK_EQ_INT(decodeUnit->arrivalTimeUs, 8652);
    CHECK_EQ_INT(decodeUnit->arrivalBytes, 295816);
    LiCompleteVideoFrame(handle, DR_OK);
  }
  decodeUnit = pollFrame(&handle);
  if (decodeUnit != NULL) {
    CHECK_EQ_INT(decodeUnit->frameNumber, 3);
    CHECK_EQ_INT(decodeUnit->arrivalTimeUs, 0);
    CHECK_EQ_INT(decodeUnit->arrivalBytes, 0);
    LiCompleteVideoFrame(handle, DR_OK);
  }
  endStream();
}

static void AFrameTakesTheLockOnceAndAKeyframeOncePerPacket(void) {
  startWithAKeyframe(false);
  preparing = true;
  feedFrame(2, FRAME_TYPE_HEADER_P, 10, 100);
  preparing = false;
  feedPrepared();
  CHECK_EQ_INT(stateLockCount, 1);
  CHECK_EQ_INT(takeFrame(2, FRAME_TYPE_PFRAME, DR_OK), 1000);
  preparing = true;
  feedFrame(3, FRAME_TYPE_HEADER_IDR, 10, 100);
  preparing = false;
  feedPrepared();
  CHECK_EQ_INT(stateLockCount, 10);
  CHECK_EQ_INT(takeFrame(3, FRAME_TYPE_IDR, DR_OK), 1000);
  endStream();
}

// The player rejects frame 2 on the decoder thread (DR_NEED_IDR), which asks for a refresh of the decoder
static void rejectFrame2(void) {
  CHECK_EQ_INT(takeFrame(2, FRAME_TYPE_PFRAME, DR_NEED_IDR), 100);
}

static void AWaitingRefreshGetsInBetweenThePacketsOfAKeyframeAndKeepsIt(void) {
  // ARefreshWhileAKeyframeArrivesKeepsThatKeyframe with the keyframe handed over at once: the refresh, which waits for
  // the lock, gets it after the first packet of keyframe 3, and the rest of the keyframe answers it
  startWithAKeyframe(false);
  feedFrame(2, FRAME_TYPE_HEADER_P, 1, 100);
  preparing = true;
  feedFrame(3, FRAME_TYPE_HEADER_IDR, 3, 100);
  preparing = false;
  waiterRan = false;
  waitingForLock = rejectFrame2;
  feedPrepared();
  CHECK(waiterRan);
  CHECK(waiterSawDecodingFrame);
  CHECK_EQ_INT(stateLockCount, 4);
  CHECK_EQ_INT(idrRequests, 1);
  CHECK(strstr(logLines, "Waiting for IDR frame") == NULL);
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 1);
  CHECK_EQ_INT(takeFrame(3, FRAME_TYPE_IDR, DR_OK), 300);
  feedFrame(4, FRAME_TYPE_HEADER_P, 1, 100);
  CHECK_EQ_INT(takeFrame(4, FRAME_TYPE_PFRAME, DR_OK), 100);
  CHECK_EQ_INT(LiGetClientDroppedVideoFrames(), 0);
  CHECK_EQ_INT(LiGetClientVideoResets(), 1);
  CHECK_EQ_INT(idrRequests, 1);
  endStream();
}

static void AWaitingRefreshDuringAPFrameComesAfterThatFrame(void) {
  // The refresh gets the lock once P-frame 3 is queued, flushes it and waits for a keyframe: the frame counts as dropped
  // by the client (flushed by the refresh rather than dropped at its end, as when the refresh came between two of its
  // packets before 2.3.5) and as received for the connection quality warnings
  startWithAKeyframe(false);
  feedFrame(2, FRAME_TYPE_HEADER_P, 1, 100);
  const int completeBefore = completeFrames;
  preparing = true;
  feedFrame(3, FRAME_TYPE_HEADER_P, 3, 100);
  preparing = false;
  waiterRan = false;
  waitingForLock = rejectFrame2;
  feedPrepared();
  CHECK(waiterRan);
  CHECK(!waiterSawDecodingFrame);
  CHECK_EQ_INT(stateLockCount, 2);
  CHECK_EQ_INT(completeFrames - completeBefore, 1);
  CHECK_EQ_INT(LiGetPendingVideoFrames(), 0);
  CHECK_EQ_INT(clientRefreshDroppedFrames, 1);
  CHECK_EQ_INT(clientRecvDroppedFrames, 0);
  CHECK_EQ_INT(LiGetClientDroppedVideoFrames(), 1);
  CHECK_EQ_INT(idrRequests, 1);
  CHECK(waitingForIdrFrame);
  feedFrame(4, FRAME_TYPE_HEADER_IDR, 1, 100);
  CHECK_EQ_INT(takeFrame(4, FRAME_TYPE_IDR, DR_OK), 100);
  endStream();
}

// An HEVC frame of Sunshine in `count` packets of `size` bytes: the first one with the frame header, then (keyframe)
// VPS, SPS and PPS and the start of the IDR slice (IDR_W_RADL), or (P-frame) the start of a TRAIL_R slice, each after a
// start code; the others with the rest of the slice
static void feedHevcFrame(uint32_t frameIndex, bool keyframe, int count, int size) {
  static const uint8_t keyNals[] = {0, 0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 0, 1, 0x42, 0x01, 0x01, 0, 0, 0, 1, 0x44, 0x01, 0xc1,
                                    0, 0, 0, 1, 0x26, 0x01, 0xaf};
  static const uint8_t pNals[] = {0, 0, 0, 1, 0x02, 0x01, 0xd0};
  for (int i = 0; i < count; i++) {
    uint8_t flags = FLAG_CONTAINS_PIC_DATA;
    int length = 0;
    if (i == 0) {
      const uint8_t header[8] = {0x01, 1, 0, keyframe ? FRAME_TYPE_HEADER_IDR : FRAME_TYPE_HEADER_P, 0, 0, 0, 0};
      flags |= FLAG_SOF;
      memcpy(payload, header, sizeof(header));
      length = (int)sizeof(header);
      memcpy(payload + length, keyframe ? keyNals : pNals, keyframe ? sizeof(keyNals) : sizeof(pNals));
      length += keyframe ? (int)sizeof(keyNals) : (int)sizeof(pNals);
    }
    if (i == count - 1) {
      flags |= FLAG_EOF;
    }
    // Slice data without a start code (bytes from 0x10 on)
    for (int b = 0; b < size; b++) {
      payload[length + b] = (uint8_t)(0x10 + ((i * 7 + b) % 0xe0));
    }
    length += size;
    feedPacket(frameIndex, flags, payload, length);
  }
}

// The next decode unit as text: its number, type and length, then each buffer with its type, length and bytes
static int describeNextFrame(char* text, size_t size) {
  VIDEO_FRAME_HANDLE handle;
  PDECODE_UNIT decodeUnit;
  int buffers = 0;
  if (!LiPollNextVideoFrame(&handle, &decodeUnit)) {
    CHECK(!"a decode unit in the queue");
    return -1;
  }
  size_t used = (size_t)snprintf(text, size, "frame %d type %d length %d:", decodeUnit->frameNumber,
                                 decodeUnit->frameType, decodeUnit->fullLength);
  for (PLENTRY entry = decodeUnit->bufferList; entry != NULL && used < size; entry = entry->next) {
    buffers++;
    used += (size_t)snprintf(text + used, size - used, " [%d %d", entry->bufferType, entry->length);
    for (int i = 0; i < entry->length && used < size; i++) {
      used += (size_t)snprintf(text + used, size - used, " %02x", (uint8_t)entry->data[i]);
    }
    if (used < size) {
      used += (size_t)snprintf(text + used, size - used, "]");
    }
  }
  CHECK(used < size);
  LiCompleteVideoFrame(handle, DR_OK);
  return buffers;
}

static void AnHevcFrameGivesTheSameDecodeUnitThroughEitherFunction(void) {
  static char oneByOne[2][16384];
  static char atOnce[2][16384];
  int buffers[2][2];
  NegotiatedVideoFormat = VIDEO_FORMAT_H265;
  for (int path = 0; path < 2; path++) {
    char (*texts)[16384] = path == 0 ? oneByOne : atOnce;
    startStream(false);
    // A keyframe of 3 packets (the slow path: VPS, SPS and PPS copied, the slice in the packet buffer) and a P-frame of
    // 3 packets
    preparing = path == 1;
    feedHevcFrame(1, true, 3, 200);
    preparing = false;
    if (path == 1) {
      feedPrepared();
      CHECK_EQ_INT(stateLockCount, 3);
    }
    buffers[path][0] = describeNextFrame(texts[0], sizeof(texts[0]));
    preparing = path == 1;
    feedHevcFrame(2, false, 3, 200);
    preparing = false;
    if (path == 1) {
      feedPrepared();
      CHECK_EQ_INT(stateLockCount, 1);
    }
    buffers[path][1] = describeNextFrame(texts[1], sizeof(texts[1]));
    CHECK_EQ_INT(idrRequests, 0);
    endStream();
  }
  for (int frame = 0; frame < 2; frame++) {
    if (strcmp(oneByOne[frame], atOnce[frame]) != 0) {
      printf("  # one by one: %.200s\n  # at once:    %.200s\n", oneByOne[frame], atOnce[frame]);
    }
    CHECK(strcmp(oneByOne[frame], atOnce[frame]) == 0);
    CHECK_EQ_INT(buffers[1][frame], buffers[0][frame]);
  }
  // The keyframe: VPS, SPS, PPS and the picture data of the 3 packets; the P-frame: the picture data of its 3 packets
  CHECK_EQ_INT(buffers[0][0], 6);
  CHECK_EQ_INT(buffers[0][1], 3);
  CHECK(strncmp(oneByOne[0], "frame 1 type 1 length ", 22) == 0);
  CHECK(strncmp(oneByOne[1], "frame 2 type 0 length ", 22) == 0);
  NegotiatedVideoFormat = VIDEO_FORMAT_AV1_MAIN8;
}

int main(void) {
  RUN_TEST("a frame takes the lock once, a keyframe once per packet", AFrameTakesTheLockOnceAndAKeyframeOncePerPacket);
  RUN_TEST("a refresh that waits for the lock gets in between the packets of a keyframe handed over at once and keeps it",
           AWaitingRefreshGetsInBetweenThePacketsOfAKeyframeAndKeepsIt);
  RUN_TEST("a refresh that waits for the lock during a P-frame comes after that frame and flushes it",
           AWaitingRefreshDuringAPFrameComesAfterThatFrame);
  RUN_TEST("an HEVC keyframe and P-frame give the same decode unit through queueRtpPacket() and queueRtpPackets()",
           AnHevcFrameGivesTheSameDecodeUnitThroughEitherFunction);
  RUN_TEST("a frame over 32 MiB is dropped with a keyframe request", AFrameOver32MiBIsDroppedWithAKeyframeRequest);
  RUN_TEST("a frame of more than 65,536 fragments is dropped", AFrameOf65537FragmentsIsDropped);
  RUN_TEST("a packet that continues a frame whose start never came is rejected",
           APacketWithoutTheStartOfItsFrameIsRejected);
  RUN_TEST("a frame whose decode unit can't be allocated is dropped, not glued to the next",
           AFrameWhoseDecodeUnitCantBeAllocatedIsDropped);
  RUN_TEST("a frame completed while the queue is shut down at a stop is freed", AFrameCompletedAtAStopIsFreed);
  RUN_TEST("a queue overflow still counts as a drop of the client", AQueueOverflowStillCountsAsADropOfTheClient);
  RUN_TEST("a decoder refresh while a keyframe arrives keeps that keyframe", ARefreshWhileAKeyframeArrivesKeepsThatKeyframe);
  RUN_TEST("a decoder refresh waits for the packet that the receive thread processes",
           ARefreshWaitsForThePacketOfTheReceiveThread);
  RUN_TEST("a decoder that submits directly may ask for a refresh", ADirectSubmitMayAskForARefresh);
  RUN_TEST("RFI and IDR waits stay mutually exclusive", RfiAndIdrWaitsStayMutuallyExclusive);
  RUN_TEST("a second stream starts with the consecutive drop count at zero", ASecondStreamStartsWithTheDropCountAtZero);
  RUN_TEST("an IDR frame tells the limit of the IDR frame requests at its first packet",
           AnIdrFrameTellsTheLimitOfTheRequestsAtItsFirstPacket);
  RUN_TEST("a decode unit carries the receive time of its first packet and the time it was queued, in microseconds "
           "and milliseconds", ADecodeUnitCarriesItsTimesInMicrosecondsAndMilliseconds);
  RUN_TEST("a made-up presentation time stays in whole milliseconds of the receive time",
           AMadeUpPresentationTimeStaysInWholeMilliseconds);
  RUN_TEST("a decode unit carries the arrival figures of the first packet of its frame",
           ADecodeUnitCarriesTheArrivalFiguresOfItsFirstPacket);
  return test_summary();
}
