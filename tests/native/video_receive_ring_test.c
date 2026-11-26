// Checks the ring between the two threads of the video receive of 2.3.5 (moonlight-common-c/src/VideoReceiveRing.h,
// included directly) with real threads and the real mutexes, condition variables and clock of Platform.c:
//  - the packets reach the processing thread in order, with their length and the time the reader noted, in batches of
//    at most VRR_BATCH, also when the processing thread puts a buffer of its own into each slot (plain video, whose
//    buffer goes to the RTP queue) and keeps the buffer of a rejected packet;
//  - a full ring drops nothing: the reader waits for room (and is told how long), and goes on once room comes;
//  - a processing thread that finds the ring empty looks again for a while before it waits, so that a reader whose
//    packets come one after the other rarely has to wake it, also on a clock that steps in 0.1 ms like performance.now()
//    of the TV: the look lasts at least VRR_LINGER_US and at most a step more, from any start within a step (on a
//    simulated clock), and the time it looked is told apart from the time it waited;
//  - the stop wakes a thread that waits, either one; after the end of the reader the processing thread takes what is
//    left, then ends;
//  - the figures (the most packets in the ring, also since the start of a minute; the times the ring was full and for
//    how long; the wakes), and a ring that is freed whole, also when it could only be made in part.
// The threads only record what they see; the checks run on the main thread after the joins, and a watchdog ends the
// test if a thread is never woken. The test runs with the flags of run.sh (the address and undefined behaviour
// sanitizers) and, by the line below, once more with the thread sanitizer, which must report nothing.
// Thread sanitizer: yes

// The thread functions of Platform.c need the GNU extensions of the C library
#define _GNU_SOURCE

// (GCC tells the thread sanitizer with __SANITIZE_THREAD__, Clang with __has_feature)
#if defined(__SANITIZE_THREAD__)
#define RING_TEST_THREAD_SANITIZER 1
#elif defined(__has_feature)
#if __has_feature(thread_sanitizer)
#define RING_TEST_THREAD_SANITIZER 1
#endif
#endif

#include "test_support_c.h"

#include "../../moonlight-common-c/src/Limelight-internal.h"
#include "../../moonlight-common-c/src/Platform.c"

// The allocations of the ring go through these, so that an allocation can fail and none is left behind
static long outstandingAllocations;
static int allocationsBeforeFailure = -1;
static bool allocationFails(void) {
  if (allocationsBeforeFailure == 0) {
    return true;
  }
  if (allocationsBeforeFailure > 0) {
    allocationsBeforeFailure--;
  }
  return false;
}
static void* TestMalloc(size_t size) {
  if (allocationFails()) {
    return NULL;
  }
  outstandingAllocations++;
  return malloc(size);
}
static void* TestCalloc(size_t count, size_t size) {
  if (allocationFails()) {
    return NULL;
  }
  outstandingAllocations++;
  return calloc(count, size);
}
static void TestFree(void* pointer) {
  if (pointer != NULL) {
    outstandingAllocations--;
  }
  free(pointer);
}
// The clock of the ring: that of Platform.c, rounded down to steps of ringClockStepUs (100 for a clock in steps of
// 0.1 ms like performance.now() of the TV), or, with ringClockSimulated, a clock for one thread at a time that moves on
// by 1 us at each read and stands still between the reads. The threads of the test keep the clock of Platform.c.
static uint64_t ringClockStepUs = 1;
static bool ringClockSimulated;
static uint64_t simulatedUs;
static uint64_t RingClockMicros(void) {
  const uint64_t nowUs = ringClockSimulated ? simulatedUs++ : PltGetMicroseconds();
  return nowUs / ringClockStepUs * ringClockStepUs;
}
#define malloc(size) TestMalloc(size)
#define calloc(count, size) TestCalloc(count, size)
#define free(pointer) TestFree(pointer)
#define PltGetMicroseconds() RingClockMicros()
#include "../../moonlight-common-c/src/VideoReceiveRing.h"
#undef malloc
#undef calloc
#undef free
#undef PltGetMicroseconds

#include <pthread.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

// What the library would provide
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
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

#define SLOT_SIZE 64

static VIDEO_RECV_RING ring;

// ---- A reader that publishes a numbered packet into each slot ----

typedef struct {
  uint32_t packets;      // to publish
  uint32_t published;    // done
  bool stoppedEarly;     // VrrPublish() returned NULL
  uint32_t gapUs;        // the time between two packets, busy on the clock (not a count of steps, which a slower
                         // machine or the thread sanitizer would make longer)
  uint64_t waitedUs;     // what VrrPublish() said it waited for room, in all
  uint32_t waits;        // the publishes that waited
} READER;

static volatile uint32_t sink;

static void spin(uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    sink += i;
  }
}

// Busy until the clock of Platform.c shows `us` more
static void busyFor(uint32_t us) {
  const uint64_t endUs = PltGetMicroseconds() + us;
  while (PltGetMicroseconds() < endUs) {
  }
}

static void* readerThread(void* context) {
  READER* reader = (READER*)context;
  PVIDEO_RECV_SLOT slot = VrrFirstSlot(&ring);
  for (uint32_t n = 0; n < reader->packets; n++) {
    uint64_t waitedUs;
    memcpy(slot->buffer, &n, sizeof(n));
    slot = VrrPublish(&ring, (int)(8 + n % 50), 1000000ULL + n, &waitedUs);
    reader->published++;
    reader->waitedUs += waitedUs;
    if (waitedUs > 0) {
      reader->waits++;
    }
    if (slot == NULL) {
      reader->stoppedEarly = true;
      break;
    }
    if (reader->gapUs > 0) {
      busyFor(reader->gapUs);
    }
  }
  VrrClose(&ring);
  return NULL;
}

// ---- A processing thread that checks each packet and swaps buffers like plain video ----

typedef struct {
  uint32_t taken;
  uint32_t outOfOrder;
  uint32_t wrongLength;
  uint32_t wrongTime;
  uint32_t maxBatch;
  bool swap;               // put a buffer of its own into each slot (plain video)
  uint32_t workSpins;      // busy work per packet
  uint64_t idleUs;
  uint64_t lookUs;         // of it, the time it looked again
  uint32_t looksTooLong;   // takes whose look was longer than their idle time
  VIDEO_RECV_RING_FIGURES figures;
  // A gate that holds the thread before its first take
  pthread_mutex_t gateMutex;
  pthread_cond_t gateCond;
  bool gateOpen;
} PROCESSOR;

static void* processorThread(void* context) {
  PROCESSOR* processor = (PROCESSOR*)context;
  char* spare = NULL;
  uint32_t released = 0;

  pthread_mutex_lock(&processor->gateMutex);
  while (!processor->gateOpen) {
    pthread_cond_wait(&processor->gateCond, &processor->gateMutex);
  }
  pthread_mutex_unlock(&processor->gateMutex);

  for (;;) {
    uint32_t first;
    uint64_t idleUs;
    uint64_t lookUs;
    uint32_t taken = VrrReleaseAndTake(&ring, released, &first, &idleUs, &lookUs, &processor->figures, false);
    processor->idleUs += idleUs;
    processor->lookUs += lookUs;
    if (lookUs > idleUs) {
      processor->looksTooLong++;
    }
    if (taken == 0) {
      break;
    }
    if (taken > processor->maxBatch) {
      processor->maxBatch = taken;
    }
    for (uint32_t i = 0; i < taken; i++) {
      PVIDEO_RECV_SLOT slot = VrrSlot(&ring, first + i);
      uint32_t n;
      memcpy(&n, slot->buffer, sizeof(n));
      if (n != processor->taken) {
        processor->outOfOrder++;
      }
      if (slot->length != (int)(8 + n % 50)) {
        processor->wrongLength++;
      }
      if (slot->receiveTimeUs != 1000000ULL + n) {
        processor->wrongTime++;
      }
      if (processor->swap) {
        // The buffer goes to the RTP queue (here: freed) and the slot gets a new one, as VideoStream.c does
        if (spare == NULL) {
          spare = (char*)TestMalloc(SLOT_SIZE);
        }
        char* packet = slot->buffer;
        slot->buffer = spare;
        spare = NULL;
        if (n % 3 == 0) {
          spare = packet;  // a rejected packet: the buffer is used again
        }
        else {
          TestFree(packet);
        }
      }
      spin(processor->workSpins);
      processor->taken++;
    }
    released = taken;
  }
  TestFree(spare);
  return NULL;
}

static void openGate(PROCESSOR* processor) {
  pthread_mutex_lock(&processor->gateMutex);
  processor->gateOpen = true;
  pthread_cond_signal(&processor->gateCond);
  pthread_mutex_unlock(&processor->gateMutex);
}

static void initProcessor(PROCESSOR* processor, bool swap, uint32_t workSpins, bool gateOpen) {
  memset(processor, 0, sizeof(*processor));
  processor->swap = swap;
  processor->workSpins = workSpins;
  processor->gateOpen = gateOpen;
  pthread_mutex_init(&processor->gateMutex, NULL);
  pthread_cond_init(&processor->gateCond, NULL);
}

static void destroyProcessor(PROCESSOR* processor) {
  pthread_mutex_destroy(&processor->gateMutex);
  pthread_cond_destroy(&processor->gateCond);
}

// The depth of the ring and the flags of the waits, read under its mutex
static uint32_t ringDepth(void) {
  PltLockMutex(&ring.mutex);
  uint32_t depth = ring.head - ring.tail;
  PltUnlockMutex(&ring.mutex);
  return depth;
}

static bool readerWaits(void) {
  PltLockMutex(&ring.mutex);
  bool waiting = ring.readerWaiting;
  PltUnlockMutex(&ring.mutex);
  return waiting;
}

static bool processorWaits(void) {
  PltLockMutex(&ring.mutex);
  bool waiting = ring.processorWaiting;
  PltUnlockMutex(&ring.mutex);
  return waiting;
}

// Waits up to 5 s for a condition that another thread brings about
static bool waitFor(bool (*condition)(void)) {
  for (int i = 0; i < 5000; i++) {
    if (condition()) {
      return true;
    }
    usleep(1000);
  }
  return false;
}

// The ring is freed whole: its buffers, its slots, its mutex and its condition variables
static void checkRingFreed(void) {
  CHECK(ring.slots == NULL);
  CHECK_EQ_INT(outstandingAllocations, 0);
  CHECK_EQ_INT(activeMutexes, 0);
  CHECK_EQ_INT(activeCondVars, 0);
}

// A case that hangs, e.g. a thread that waits and is never woken, fails the test instead
static void onWatchdog(int signal) {
  (void)signal;
  static const char message[] = "  # FAILED: the case didn't end within 60 s (a thread that is never woken?)\n";
  if (write(STDOUT_FILENO, message, sizeof(message) - 1) < 0) {
    _exit(2);
  }
  _exit(1);
}

static void runCase(const char* name, void (*function)(void)) {
  alarm(60);
  RUN_TEST(name, function);
  alarm(0);
}

// ---- The cases ----

static void runOrder(uint32_t slots, bool swap, uint32_t workSpins, READER* reader, PROCESSOR* processor) {
  pthread_t r, p;
  reader->packets = 50000;
  CHECK_EQ_INT(VrrInitialize(&ring, slots, SLOT_SIZE), 0);
  initProcessor(processor, swap, workSpins, true);
  pthread_create(&p, NULL, processorThread, processor);
  pthread_create(&r, NULL, readerThread, reader);
  pthread_join(r, NULL);
  pthread_join(p, NULL);
  CHECK_EQ_INT(reader->published, 50000);
  CHECK(!reader->stoppedEarly);
  CHECK_EQ_INT(processor->taken, 50000);
  CHECK_EQ_INT(processor->outOfOrder, 0);
  CHECK_EQ_INT(processor->wrongLength, 0);
  CHECK_EQ_INT(processor->wrongTime, 0);
  CHECK(processor->maxBatch >= 1 && processor->maxBatch <= VRR_BATCH);
  CHECK(processor->figures.maxDepth >= 1 && processor->figures.maxDepth <= slots);
  // The figures of the last take, after the end of the reader, have every wait of the reader
  CHECK_EQ_INT(processor->figures.fullWaitUs, reader->waitedUs);
  CHECK(processor->figures.fullWaits >= reader->waits);
  // The time it looked again is part of its idle time
  CHECK_EQ_INT(processor->looksTooLong, 0);
  CHECK(processor->lookUs <= processor->idleUs);
  printf("  # %u slots, %s, clock in steps of %llu us: up to %u in the ring, full %llu times (%llu us), %llu wakes, idle "
         "%llu us (looking %llu us), batches up to %u\n",
         slots, swap ? "buffers swapped" : "buffers kept", (unsigned long long)ringClockStepUs, processor->figures.maxDepth,
         (unsigned long long)processor->figures.fullWaits, (unsigned long long)processor->figures.fullWaitUs,
         (unsigned long long)processor->figures.wakes, (unsigned long long)processor->idleUs,
         (unsigned long long)processor->lookUs, processor->maxBatch);
  destroyProcessor(processor);
  VrrDestroy(&ring);
  checkRingFreed();
}

static void test_packets_arrive_in_order_with_length_and_time(void) {
  READER reader;
  PROCESSOR processor;
  memset(&reader, 0, sizeof(reader));
  runOrder(1024, true, 0, &reader, &processor);
  memset(&reader, 0, sizeof(reader));
  runOrder(1024, false, 0, &reader, &processor);
}

static void test_a_small_ring_fills_and_the_reader_waits_without_losing_a_packet(void) {
  // A slow processing thread and a ring of 8: the reader finds it full again and again
  READER reader;
  PROCESSOR processor;
  memset(&reader, 0, sizeof(reader));
  runOrder(8, true, 2000, &reader, &processor);
  CHECK(processor.figures.fullWaits > 0);
  CHECK(reader.waits > 0);
  CHECK_EQ_INT(processor.figures.maxDepth, 8);
}

static void runSlowReader(uint64_t clockStepUs) {
  // A packet every 40 us, well within VRR_LINGER_US: the processing thread finds the ring empty after nearly every
  // packet, but looks again for a while before it waits, so the reader rarely has to wake it (tens of wakes for 50,000
  // packets on an idle machine with 4 CPUs, also with the clock in steps of 0.1 ms; one per packet without the look).
  // The bound leaves room for a loaded machine with 2 CPUs, where the reader is often held up for longer than the look
  // (up to 17,075 wakes were seen there)
  READER reader;
  PROCESSOR processor;
  memset(&reader, 0, sizeof(reader));
  reader.gapUs = 40;
  ringClockStepUs = clockStepUs;
  runOrder(1024, true, 0, &reader, &processor);
  ringClockStepUs = 1;
  CHECK(processor.idleUs > 0);
  CHECK(processor.lookUs > 0);
#if defined(RING_TEST_THREAD_SANITIZER)
  printf("  # (the bound of the wakes is not checked under the thread sanitizer, which slows each look down)\n");
#else
  if (sysconf(_SC_NPROCESSORS_ONLN) >= 2) {
    CHECK(processor.figures.wakes < 40000);
  }
  else {
    printf("  # (the bound of the wakes needs two processors, this machine has one)\n");
  }
#endif
}

static void test_a_slow_reader_wakes_a_waiting_processing_thread_rarely(void) {
  runSlowReader(1);
  // The same with the clock of the ring in steps of 0.1 ms, as on the TV
  runSlowReader(100);
}

// ---- The look again on a simulated clock ----

// The simulated time when the processing thread waited, read by a thread that then publishes a packet, which wakes it
static uint64_t lookEndUs;
static bool processorWaited;

static void* publishOnceTheProcessorWaits(void* context) {
  (void)context;
  processorWaited = waitFor(processorWaits);
  // (the processing thread waits: it reads the clock again only once this packet woke it)
  lookEndUs = simulatedUs;
  uint64_t waitedUs;
  VrrPublish(&ring, 10, 1, &waitedUs);
  return NULL;
}

static void test_the_look_again_lasts_at_least_the_linger_time_on_a_clock_in_steps(void) {
  // A clock in steps of 1 us, of 5 us (performance.now() of a page that is isolated) and of 0.1 ms (that of the TV),
  // which moves on by 1 us at each read: from each start within a step, the processing thread looks for at least
  // VRR_LINGER_US and at most a step more, then waits, and the reader's packet wakes it (a wake that the ring counts).
  // A look that ended at the next step of the clock would last 0 to 100 us on the clock of the TV, and the reader would
  // have to wake the thread for a third to a half of the packets of a frame. The time it looked comes apart from the
  // time it waited, and both as the clock of the ring shows them.
  const uint64_t steps[3] = { 1, 5, 100 };
  ringClockSimulated = true;
  for (int s = 0; s < 3; s++) {
    uint64_t shortest = UINT64_MAX;
    uint64_t longest = 0;
    int wrong = 0;
    ringClockStepUs = steps[s];
    for (uint64_t phase = 0; phase < steps[s]; phase++) {
      pthread_t publisher;
      uint32_t first = 0;
      uint64_t idleUs = 0;
      uint64_t lookUs = 0;
      VIDEO_RECV_RING_FIGURES figures;
      const uint64_t startUs = 1000000 + phase;
      CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
      simulatedUs = startUs;
      processorWaited = false;
      lookEndUs = 0;
      pthread_create(&publisher, NULL, publishOnceTheProcessorWaits, NULL);
      const uint32_t taken = VrrReleaseAndTake(&ring, 0, &first, &idleUs, &lookUs, &figures, false);
      pthread_join(publisher, NULL);
      // The last read of the look was the one before the wait
      const uint64_t lookedUs = lookEndUs - 1 - startUs;
      shortest = lookedUs < shortest ? lookedUs : shortest;
      longest = lookedUs > longest ? lookedUs : longest;
      // The look as the clock of the ring showed it, and the idle time, which ends with one more read after the wake
      const uint64_t roundedLookUs = (startUs + lookedUs) / steps[s] * steps[s] - startUs / steps[s] * steps[s];
      const uint64_t roundedIdleUs = (startUs + lookedUs + 1) / steps[s] * steps[s] - startUs / steps[s] * steps[s];
      if (!processorWaited || taken != 1 || figures.wakes != 1 || lookUs != roundedLookUs || idleUs != roundedIdleUs) {
        if (wrong++ == 0) {
          printf("  # steps of %llu us, start %llu us into a step: waited %d, took %u, %llu wakes, looked %llu us (%llu "
                 "on the clock, %llu expected), idle %llu us (%llu expected)\n", (unsigned long long)steps[s],
                 (unsigned long long)phase, processorWaited, taken, (unsigned long long)figures.wakes,
                 (unsigned long long)lookedUs, (unsigned long long)lookUs, (unsigned long long)roundedLookUs,
                 (unsigned long long)idleUs, (unsigned long long)roundedIdleUs);
        }
      }
      VrrDestroy(&ring);
      checkRingFreed();
    }
    printf("  # clock in steps of %llu us: the look lasted %llu to %llu us\n", (unsigned long long)steps[s],
           (unsigned long long)shortest, (unsigned long long)longest);
    CHECK_EQ_INT(wrong, 0);
    CHECK(shortest >= VRR_LINGER_US);
    CHECK(longest <= VRR_LINGER_US + steps[s]);
  }
  ringClockSimulated = false;
  ringClockStepUs = 1;
}

static void test_the_reader_waits_when_the_ring_is_full_and_goes_on_when_room_comes(void) {
  READER reader;
  PROCESSOR processor;
  pthread_t r, p;
  memset(&reader, 0, sizeof(reader));
  reader.packets = 20;
  CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
  initProcessor(&processor, true, 0, false);
  pthread_create(&p, NULL, processorThread, &processor);
  pthread_create(&r, NULL, readerThread, &reader);
  CHECK(waitFor(readerWaits));
  CHECK_EQ_INT(ringDepth(), 8);
  // The reader waits with the eighth packet published: none is lost while it waits
  usleep(20000);
  openGate(&processor);
  pthread_join(r, NULL);
  pthread_join(p, NULL);
  CHECK_EQ_INT(processor.taken, 20);
  CHECK_EQ_INT(processor.outOfOrder, 0);
  CHECK(processor.figures.fullWaits >= 1);
  CHECK_EQ_INT(processor.figures.maxDepth, 8);
  // It was told that it waited (at least the 20 ms before the gate opened), and the figures have the same time
  CHECK(reader.waits >= 1);
  CHECK(reader.waitedUs >= 20000);
  CHECK_EQ_INT(processor.figures.fullWaitUs, reader.waitedUs);
  destroyProcessor(&processor);
  VrrDestroy(&ring);
  checkRingFreed();
}

static void test_the_stop_wakes_a_reader_that_waits_for_room(void) {
  READER reader;
  pthread_t r;
  memset(&reader, 0, sizeof(reader));
  reader.packets = 100;
  CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
  pthread_create(&r, NULL, readerThread, &reader);
  CHECK(waitFor(readerWaits));
  VrrStop(&ring);
  pthread_join(r, NULL);
  CHECK(reader.stoppedEarly);
  CHECK_EQ_INT(reader.published, 8);
  // A publish after the stop returns no slot either
  uint64_t waitedUs = 1;
  CHECK(VrrPublish(&ring, 10, 1, &waitedUs) == NULL);
  CHECK_EQ_INT(waitedUs, 0);
  VrrDestroy(&ring);
  checkRingFreed();
}

static void test_the_stop_wakes_a_processing_thread_that_waits_for_packets(void) {
  PROCESSOR processor;
  pthread_t p;
  CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
  initProcessor(&processor, true, 0, true);
  pthread_create(&p, NULL, processorThread, &processor);
  CHECK(waitFor(processorWaits));
  VrrStop(&ring);
  pthread_join(p, NULL);
  CHECK_EQ_INT(processor.taken, 0);
  // Its wait counts as idle time
  CHECK(processor.idleUs > 0);
  // A stopped ring gives nothing, even with packets in it
  uint64_t waitedUs;
  uint32_t first;
  uint64_t idleUs;
  uint64_t lookUs;
  VIDEO_RECV_RING_FIGURES figures;
  CHECK(VrrPublish(&ring, 10, 1, &waitedUs) == NULL);
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 0, &first, &idleUs, &lookUs, &figures, false), 0);
  destroyProcessor(&processor);
  VrrDestroy(&ring);
  checkRingFreed();
}

static void test_after_the_reader_ends_the_processing_thread_takes_what_is_left(void) {
  READER reader;
  PROCESSOR processor;
  pthread_t r, p;
  memset(&reader, 0, sizeof(reader));
  reader.packets = 5;
  CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
  pthread_create(&r, NULL, readerThread, &reader);
  pthread_join(r, NULL);
  initProcessor(&processor, true, 0, true);
  pthread_create(&p, NULL, processorThread, &processor);
  pthread_join(p, NULL);
  CHECK_EQ_INT(processor.taken, 5);
  CHECK_EQ_INT(processor.outOfOrder, 0);
  // No look again and no wait on a ring that the reader closed
  CHECK_EQ_INT(processor.idleUs, 0);
  CHECK_EQ_INT(processor.figures.wakes, 0);
  destroyProcessor(&processor);
  VrrDestroy(&ring);
  checkRingFreed();

  // The close also wakes a processing thread that waits for packets
  memset(&reader, 0, sizeof(reader));
  CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
  initProcessor(&processor, true, 0, true);
  pthread_create(&p, NULL, processorThread, &processor);
  CHECK(waitFor(processorWaits));
  pthread_create(&r, NULL, readerThread, &reader);
  pthread_join(r, NULL);
  pthread_join(p, NULL);
  CHECK_EQ_INT(processor.taken, 0);
  destroyProcessor(&processor);
  VrrDestroy(&ring);
  checkRingFreed();
}

static void test_the_most_packets_of_a_minute_start_again_with_it(void) {
  // On one thread: 6 packets in, 4 taken and given back, the figures with a new minute, 1 more in
  uint64_t waitedUs;
  uint32_t first;
  uint64_t idleUs;
  uint64_t lookUs;
  VIDEO_RECV_RING_FIGURES figures;
  CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
  PVIDEO_RECV_SLOT slot = VrrFirstSlot(&ring);
  for (int i = 0; i < 6; i++) {
    CHECK(slot != NULL);
    slot = VrrPublish(&ring, 10, 1, &waitedUs);
  }
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 0, &first, &idleUs, &lookUs, &figures, false), 6);
  CHECK_EQ_INT(first, 0);
  CHECK_EQ_INT(figures.maxDepth, 6);
  CHECK_EQ_INT(figures.windowMaxDepth, 6);
  // Give 4 back and start a new minute: 2 are left in the ring
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 4, &first, &idleUs, &lookUs, &figures, true), 2);
  CHECK_EQ_INT(first, 4);
  CHECK_EQ_INT(figures.windowMaxDepth, 6);
  slot = VrrPublish(&ring, 10, 1, &waitedUs);
  CHECK(slot == VrrSlot(&ring, 7));
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 0, &first, &idleUs, &lookUs, &figures, false), 3);
  CHECK_EQ_INT(figures.maxDepth, 6);
  CHECK_EQ_INT(figures.windowMaxDepth, 3);
  CHECK_EQ_INT(figures.fullWaits, 0);
  CHECK_EQ_INT(figures.wakes, 0);
  // A batch is at most VRR_BATCH: a ring of 64 with 40 packets in it gives 32, then 8
  VrrDestroy(&ring);
  checkRingFreed();
  CHECK_EQ_INT(VrrInitialize(&ring, 64, SLOT_SIZE), 0);
  slot = VrrFirstSlot(&ring);
  for (int i = 0; i < 40; i++) {
    slot = VrrPublish(&ring, 10, 1, &waitedUs);
  }
  CHECK(slot != NULL);
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 0, &first, &idleUs, &lookUs, &figures, false), VRR_BATCH);
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, VRR_BATCH, &first, &idleUs, &lookUs, &figures, false), 8);
  CHECK_EQ_INT(first, VRR_BATCH);
  VrrDestroy(&ring);
  checkRingFreed();
}

static void test_a_ring_is_freed_whole_also_when_it_was_made_in_part(void) {
  // A ring that was never made (all zeros, as initializeVideoStream() leaves it) and one destroyed twice
  memset(&ring, 0, sizeof(ring));
  VrrDestroy(&ring);
  checkRingFreed();
  CHECK_EQ_INT(VrrInitialize(&ring, 16, SLOT_SIZE), 0);
  CHECK_EQ_INT(outstandingAllocations, 17);
  CHECK_EQ_INT(activeMutexes, 1);
  CHECK_EQ_INT(activeCondVars, 2);
  VrrDestroy(&ring);
  VrrDestroy(&ring);
  checkRingFreed();
  // The slots can't be allocated, or the 1st, 6th or 16th buffer of a slot can't
  const int failures[4] = { 0, 1, 6, 16 };
  for (int i = 0; i < 4; i++) {
    allocationsBeforeFailure = failures[i];
    CHECK_EQ_INT(VrrInitialize(&ring, 16, SLOT_SIZE), -1);
    allocationsBeforeFailure = -1;
    checkRingFreed();
    // and nothing is freed twice: a destroy after it does nothing
    VrrDestroy(&ring);
    checkRingFreed();
  }
}

int main(void) {
  signal(SIGALRM, onWatchdog);
  runCase("the packets reach the processing thread in order, with their length and time",
           test_packets_arrive_in_order_with_length_and_time);
  runCase("a small ring fills, the reader waits, and no packet is lost",
           test_a_small_ring_fills_and_the_reader_waits_without_losing_a_packet);
  runCase("a slow reader wakes a waiting processing thread, but rarely, also with a clock in steps of 0.1 ms",
          test_a_slow_reader_wakes_a_waiting_processing_thread_rarely);
  runCase("the look again lasts at least VRR_LINGER_US and a step at most on a clock in steps, from any start, and is "
          "counted apart from the wait",
          test_the_look_again_lasts_at_least_the_linger_time_on_a_clock_in_steps);
  runCase("the reader waits on a full ring, is told how long, and goes on when room comes",
           test_the_reader_waits_when_the_ring_is_full_and_goes_on_when_room_comes);
  runCase("the stop wakes a reader that waits for room", test_the_stop_wakes_a_reader_that_waits_for_room);
  runCase("the stop wakes a processing thread that waits for packets",
           test_the_stop_wakes_a_processing_thread_that_waits_for_packets);
  runCase("after the reader ends, the processing thread takes what is left",
           test_after_the_reader_ends_the_processing_thread_takes_what_is_left);
  runCase("the most packets of a minute start again with it, and a batch is at most VRR_BATCH",
           test_the_most_packets_of_a_minute_start_again_with_it);
  runCase("a ring is freed whole, also when it could only be made in part",
           test_a_ring_is_freed_whole_also_when_it_was_made_in_part);
  return test_summary();
}
