// Checks the ring between the two threads of the video receive of 2.3.5 (moonlight-common-c/src/VideoReceiveRing.h,
// included directly) with real threads and the real mutexes, condition variables and clock of Platform.c:
//  - the packets reach the processing thread in order, with their length and the time the reader noted, in batches of
//    at most VRR_BATCH, also when the processing thread puts a buffer of its own into each slot (plain video, whose
//    buffer goes to the RTP queue) and keeps the buffer of a rejected packet;
//  - a full ring drops nothing: the reader waits for room (and is told how long), and goes on once room comes;
//  - a processing thread that finds the ring empty waits at once, without looking again for packets first (on a
//    simulated clock it reads the clock once before it waits, from any start within a step of a clock in steps of 1 us,
//    5 us or 0.1 ms like performance.now() of the TV), so that between the packets of a reader that publishes one every
//    40 us it sleeps instead of keeping a core busy, and the reader wakes it for the next one;
//  - what another thread does while the processing thread reads the clock without the mutex, before its wait or after
//    it (a hook on the clock of the ring), is seen once it takes the mutex again: a packet or a full ring is taken
//    without a wait before it, a close or a stop ends the take, and nothing is missed after the wait either;
//  - no packet is left in the ring while the processing thread waits: after each burst of 1 to 40 packets that the
//    reader publishes, the processing thread takes them all before it waits;
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
// A hook on the reads of the clock of the ring by one thread (clockHookOn, set and cleared while no other thread of the
// test runs): at its read number clockHookOnRead, clockHookAction() runs on that thread first. Inside
// VrrReleaseAndTake() of the processing thread each read comes between an unlock of the mutex and the next lock.
static pthread_t clockHookThread;
static bool clockHookOn;
static int clockHookOnRead;
static int clockHookReads;
static void (*clockHookAction)(void);
// The clock of the ring: that of Platform.c, rounded down to steps of ringClockStepUs (100 for a clock in steps of
// 0.1 ms like performance.now() of the TV), or, with ringClockSimulated, a clock for one thread at a time that moves on
// by 1 us at each read and stands still between the reads. The threads of the test keep the clock of Platform.c.
static uint64_t ringClockStepUs = 1;
static bool ringClockSimulated;
static uint64_t simulatedUs;
static uint64_t RingClockMicros(void) {
  if (clockHookOn && pthread_equal(pthread_self(), clockHookThread) && ++clockHookReads == clockHookOnRead) {
    clockHookAction();
  }
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

// The CPU time of the calling thread
static uint64_t threadCpuUs(void) {
  struct timespec now;
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &now);
  return (uint64_t)now.tv_sec * 1000000 + (uint64_t)now.tv_nsec / 1000;
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
  uint64_t cpuUs;          // its CPU time (CLOCK_THREAD_CPUTIME_ID) from the gate on
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

  const uint64_t cpuStartUs = threadCpuUs();
  for (;;) {
    uint32_t first;
    uint64_t idleUs;
    uint32_t taken = VrrReleaseAndTake(&ring, released, &first, &idleUs, &processor->figures, false);
    processor->idleUs += idleUs;
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
  processor->cpuUs = threadCpuUs() - cpuStartUs;
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
  printf("  # %u slots, %s, clock in steps of %llu us: up to %u in the ring, full %llu times (%llu us), %llu wakes, idle "
         "%llu us, CPU %llu us, batches up to %u\n",
         slots, swap ? "buffers swapped" : "buffers kept", (unsigned long long)ringClockStepUs, processor->figures.maxDepth,
         (unsigned long long)processor->figures.fullWaits, (unsigned long long)processor->figures.fullWaitUs,
         (unsigned long long)processor->figures.wakes, (unsigned long long)processor->idleUs,
         (unsigned long long)processor->cpuUs, processor->maxBatch);
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

static void test_a_reader_with_packets_40_us_apart_wakes_the_processing_thread_which_sleeps_meanwhile(void) {
  // A packet every 40 us (the packets of a 4K frame come about that far apart on average over the Wi-Fi of the TV, here
  // evenly): the processing thread finds the ring empty after nearly every packet and waits at once, so the reader
  // wakes it for many of them and it is asleep for most of the 2 s. A processing thread that looked again for 100 us
  // before it waited, as the test version of 2.3.5 did, would find every next packet while it looks, but keep a core
  // busy all the time (its CPU time would be about the 2 s of the run). The bound of its CPU time leaves room for a
  // loaded machine with 2 CPUs; the thread sanitizer makes each wake slower, so it isn't checked there
  READER reader;
  PROCESSOR processor;
  memset(&reader, 0, sizeof(reader));
  reader.gapUs = 40;
  const uint64_t startUs = PltGetMicroseconds();
  runOrder(1024, true, 0, &reader, &processor);
  const uint64_t runUs = PltGetMicroseconds() - startUs;
  printf("  # the run took %llu us, the processing thread %llu us of CPU for %llu wakes\n", (unsigned long long)runUs,
         (unsigned long long)processor.cpuUs, (unsigned long long)processor.figures.wakes);
  CHECK(processor.idleUs > 0);
  CHECK(processor.figures.wakes > 0);
#if defined(RING_TEST_THREAD_SANITIZER)
  printf("  # (the bound of the CPU time is not checked under the thread sanitizer, which slows each wake down)\n");
#else
  if (sysconf(_SC_NPROCESSORS_ONLN) >= 2) {
    CHECK(processor.cpuUs * 2 < runUs);
  }
  else {
    printf("  # (the bound of the CPU time needs two processors, this machine has one)\n");
  }
#endif
}

// ---- The wait of the processing thread on a simulated clock ----

// The simulated time when the processing thread waited, read by a thread that then publishes a packet, which wakes it
static uint64_t waitStartUs;
static bool processorWaited;

static void* publishOnceTheProcessorWaits(void* context) {
  (void)context;
  processorWaited = waitFor(processorWaits);
  // (the processing thread waits: it reads the clock again only once this packet woke it)
  waitStartUs = simulatedUs;
  uint64_t waitedUs;
  VrrPublish(&ring, 10, 1, &waitedUs);
  return NULL;
}

static void test_a_processing_thread_that_finds_the_ring_empty_waits_at_once(void) {
  // A clock in steps of 1 us, of 5 us (performance.now() of a page that is isolated) and of 0.1 ms (that of the TV),
  // which moves on by 1 us at each read: from each start within a step, the processing thread reads the clock once
  // (for its idle time) and waits, and the reader's packet wakes it (a wake that the ring counts). The test version of
  // 2.3.5 looked again for packets first, for at least 100 us by the clock, reading it about a hundred times. The idle
  // time comes from the clock of the ring, from that read to the one after the wake
  const uint64_t steps[3] = { 1, 5, 100 };
  ringClockSimulated = true;
  for (int s = 0; s < 3; s++) {
    uint64_t mostReads = 0;
    int wrong = 0;
    ringClockStepUs = steps[s];
    for (uint64_t phase = 0; phase < steps[s]; phase++) {
      pthread_t publisher;
      uint32_t first = 0;
      uint64_t idleUs = 0;
      VIDEO_RECV_RING_FIGURES figures;
      const uint64_t startUs = 1000000 + phase;
      CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
      simulatedUs = startUs;
      processorWaited = false;
      waitStartUs = 0;
      pthread_create(&publisher, NULL, publishOnceTheProcessorWaits, NULL);
      const uint32_t taken = VrrReleaseAndTake(&ring, 0, &first, &idleUs, &figures, false);
      pthread_join(publisher, NULL);
      // The reads of the clock before the wait
      const uint64_t reads = waitStartUs - startUs;
      mostReads = reads > mostReads ? reads : mostReads;
      // The idle time as the clock of the ring shows it: from the read before the wait to the one after the wake
      const uint64_t roundedIdleUs = (waitStartUs) / steps[s] * steps[s] - startUs / steps[s] * steps[s];
      if (!processorWaited || taken != 1 || figures.wakes != 1 || reads != 1 || idleUs != roundedIdleUs) {
        if (wrong++ == 0) {
          printf("  # steps of %llu us, start %llu us into a step: waited %d, took %u, %llu wakes, %llu reads of the "
                 "clock before the wait, idle %llu us (%llu expected)\n", (unsigned long long)steps[s],
                 (unsigned long long)phase, processorWaited, taken, (unsigned long long)figures.wakes,
                 (unsigned long long)reads, (unsigned long long)idleUs, (unsigned long long)roundedIdleUs);
        }
      }
      VrrDestroy(&ring);
      checkRingFreed();
    }
    printf("  # clock in steps of %llu us: at most %llu reads of the clock before the wait\n", (unsigned long long)steps[s],
           (unsigned long long)mostReads);
    CHECK_EQ_INT(wrong, 0);
  }
  ringClockSimulated = false;
  ringClockStepUs = 1;
}

// ---- What comes between the unlock and the lock around the processing thread's reads of the clock ----

// What another thread does at the hook: publish a packet and close the ring, fill the ring until the reader waits for
// room and then close it, close it, or stop it
enum { WINDOW_PACKET = 1, WINDOW_FULL, WINDOW_CLOSE, WINDOW_STOP };
static const char* const windowNames[] = { "", "a packet", "a full ring", "the close", "the stop" };
static int windowKind;
static pthread_t windowHelper;
static bool windowHelperRuns;
static uint32_t windowPublished;   // by the helper
static uint32_t wakerPublished;    // by the thread that ends the wait (read 2)
static pthread_mutex_t windowMutex = PTHREAD_MUTEX_INITIALIZER;
static bool windowDone;            // the processing thread took all it would
static bool windowHung;            // it didn't within 5 s, and the guard stopped the ring

static void* windowHelperThread(void* context) {
  (void)context;
  uint64_t waitedUs;
  if (windowKind == WINDOW_PACKET) {
    VrrPublish(&ring, 10, 1, &waitedUs);
    windowPublished++;
    VrrClose(&ring);
  }
  else if (windowKind == WINDOW_FULL) {
    // (the reader waits for room at the last slot, and goes on once the processing thread gives slots back)
    PVIDEO_RECV_SLOT next;
    do {
      next = VrrPublish(&ring, 10, 1, &waitedUs);
      windowPublished++;
    } while (next != NULL && windowPublished < ring.slotCount + 40);
    VrrClose(&ring);
  }
  else if (windowKind == WINDOW_CLOSE) {
    VrrClose(&ring);
  }
  else {
    VrrStop(&ring);
  }
  return NULL;
}

// The hook, on the processing thread between the unlock and the lock: the helper does its part (with a full ring, until
// the reader waits for room, which it does under the mutex that the processing thread then takes)
static void runWindowHelper(void) {
  pthread_create(&windowHelper, NULL, windowHelperThread, NULL);
  if (windowKind == WINDOW_FULL) {
    windowHelperRuns = true;
    waitFor(readerWaits);
  }
  else {
    pthread_join(windowHelper, NULL);
  }
}

// The packet that ends the wait, for the hook on the read after it
static void* wakeTheWaitingProcessor(void* context) {
  (void)context;
  uint64_t waitedUs;
  waitFor(processorWaits);
  VrrPublish(&ring, 10, 1, &waitedUs);
  wakerPublished = 1;
  return NULL;
}

// A processing thread that is never woken would hang the case: after 5 s this stops the ring, which ends any wait
static void* stopAHungProcessor(void* context) {
  (void)context;
  for (int i = 0; i < 5000; i++) {
    pthread_mutex_lock(&windowMutex);
    const bool done = windowDone;
    pthread_mutex_unlock(&windowMutex);
    if (done) {
      return NULL;
    }
    usleep(1000);
  }
  pthread_mutex_lock(&windowMutex);
  windowHung = true;
  pthread_mutex_unlock(&windowMutex);
  VrrStop(&ring);
  return NULL;
}

// The main thread is the processing thread: with the hook on its read of the clock before the wait (1) or after it
// (2), it takes until the ring gives no more
static int runWindow(int onRead, int kind, uint32_t slots) {
  pthread_t waker, guard;
  uint32_t first = 0;
  uint64_t idleUs;
  VIDEO_RECV_RING_FIGURES figures;
  CHECK_EQ_INT(VrrInitialize(&ring, slots, SLOT_SIZE), 0);
  windowKind = kind;
  windowHelperRuns = false;
  windowPublished = 0;
  wakerPublished = 0;
  windowDone = false;
  windowHung = false;
  clockHookThread = pthread_self();
  clockHookOnRead = onRead;
  clockHookReads = 0;
  clockHookAction = runWindowHelper;
  clockHookOn = true;
  if (onRead == 2) {
    pthread_create(&waker, NULL, wakeTheWaitingProcessor, NULL);
  }
  pthread_create(&guard, NULL, stopAHungProcessor, NULL);

  uint32_t taken = VrrReleaseAndTake(&ring, 0, &first, &idleUs, &figures, false);
  const int readsOfTheFirstTake = clockHookReads;
  const uint64_t wakesOfTheFirstTake = figures.wakes;
  clockHookOnRead = 0;
  uint32_t total = taken;
  while (taken > 0) {
    taken = VrrReleaseAndTake(&ring, taken, &first, &idleUs, &figures, false);
    total += taken;
  }
  pthread_mutex_lock(&windowMutex);
  windowDone = true;
  const bool hung = windowHung;
  pthread_mutex_unlock(&windowMutex);
  pthread_join(guard, NULL);
  if (windowHelperRuns) {
    pthread_join(windowHelper, NULL);
  }
  if (onRead == 2) {
    pthread_join(waker, NULL);
  }
  clockHookOn = false;

  const uint32_t published = windowPublished + wakerPublished;
  // Every packet is taken, unless the ring was stopped
  const uint32_t expected = kind == WINDOW_STOP ? 0 : published;
  // At read 1 the processing thread hasn't waited yet: what came before its lock is seen there, without a wait (and a
  // close or a stop ends the take with 0); at read 2 the one packet that ended its wait woke it once
  const uint64_t expectedWakes = onRead == 1 ? 0 : 1;
  const bool right =
      !hung && readsOfTheFirstTake >= onRead && wakesOfTheFirstTake == expectedWakes && total == expected;
  printf("  # %s at read %d of the clock, ring of %u: %s, %llu wakes in the first take, %u of %u packets taken\n",
         windowNames[kind], onRead, slots, hung ? "never woken (stopped after 5 s)" : "ended",
         (unsigned long long)wakesOfTheFirstTake, total, published);
  VrrDestroy(&ring);
  checkRingFreed();
  return right ? 0 : 1;
}

static void test_what_comes_between_the_unlock_and_the_lock_around_the_reads_of_the_clock(void) {
  // The processing thread reads the clock for its idle time without the mutex: once before it waits, between the check
  // that finds the ring empty and the wait, and once after the wait. Whatever another thread does in either window must
  // be seen when the processing thread takes the mutex again: a packet published then, a ring filled until the reader
  // waits for room, a close or a stop. Missing it before the wait would leave the processing thread asleep with a
  // packet in the ring or after a close or stop that no one repeats; the reader wakes only a thread that waits
  int wrong = 0;
  for (int onRead = 1; onRead <= 2; onRead++) {
    for (int kind = WINDOW_PACKET; kind <= WINDOW_STOP; kind++) {
      wrong += runWindow(onRead, kind, kind == WINDOW_FULL ? 8 : 1024);
      if (kind == WINDOW_FULL && onRead == 1) {
        wrong += runWindow(onRead, kind, 1);
      }
    }
  }
  CHECK_EQ_INT(wrong, 0);
}

// ---- No packet is left in the ring while the processing thread waits ----

// The reader of the case: bursts of 1 to 40 packets, each published back to back; after each burst it waits until the
// processing thread waits (up to 5 s) and looks into the ring at that moment, under its mutex
typedef struct {
  uint32_t published;
  uint32_t bursts;
  uint32_t leftInTheRing;     // bursts after which the processing thread waited with packets in the ring
  uint32_t neverWaited;       // bursts after which it didn't wait within 5 s
} BURST_READER;

static void* burstReaderThread(void* context) {
  BURST_READER* reader = (BURST_READER*)context;
  PVIDEO_RECV_SLOT slot = VrrFirstSlot(&ring);
  for (uint32_t round = 0; round < 5; round++) {
    for (uint32_t size = 1; size <= 40; size++) {
      for (uint32_t k = 0; k < size; k++) {
        uint64_t waitedUs;
        const uint32_t n = reader->published;
        memcpy(slot->buffer, &n, sizeof(n));
        slot = VrrPublish(&ring, (int)(8 + n % 50), 1000000ULL + n, &waitedUs);
        reader->published++;
      }
      reader->bursts++;
      // The reader would wait for the socket now
      bool waited = false;
      for (int i = 0; i < 5000 && !waited; i++) {
        PltLockMutex(&ring.mutex);
        if (ring.processorWaiting) {
          waited = true;
          if (ring.head != ring.tail) {
            reader->leftInTheRing++;
          }
        }
        PltUnlockMutex(&ring.mutex);
        if (!waited) {
          usleep(1000);
        }
      }
      if (!waited) {
        reader->neverWaited++;
      }
    }
  }
  VrrClose(&ring);
  return NULL;
}

static void test_no_packet_is_left_in_the_ring_while_the_processing_thread_waits(void) {
  // After each burst, whatever its size, the processing thread waits only once it took every packet of it: the reader
  // wakes it for the first packet it publishes after it began to wait, so it never sleeps on a packet while the reader
  // waits for the socket (a reader that woke it only for a batch of several packets would leave the last packets of a
  // frame in the ring until the next frame)
  BURST_READER reader;
  PROCESSOR processor;
  pthread_t r, p;
  memset(&reader, 0, sizeof(reader));
  CHECK_EQ_INT(VrrInitialize(&ring, 1024, SLOT_SIZE), 0);
  initProcessor(&processor, true, 0, true);
  pthread_create(&p, NULL, processorThread, &processor);
  pthread_create(&r, NULL, burstReaderThread, &reader);
  pthread_join(r, NULL);
  pthread_join(p, NULL);
  CHECK_EQ_INT(reader.bursts, 200);
  CHECK_EQ_INT(reader.leftInTheRing, 0);
  CHECK_EQ_INT(reader.neverWaited, 0);
  CHECK_EQ_INT(processor.taken, reader.published);
  CHECK_EQ_INT(processor.outOfOrder, 0);
  CHECK_EQ_INT(processor.wrongLength, 0);
  CHECK_EQ_INT(processor.wrongTime, 0);
  destroyProcessor(&processor);
  VrrDestroy(&ring);
  checkRingFreed();
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
  VIDEO_RECV_RING_FIGURES figures;
  CHECK(VrrPublish(&ring, 10, 1, &waitedUs) == NULL);
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 0, &first, &idleUs, &figures, false), 0);
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
  // No wait on a ring that the reader closed
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
  VIDEO_RECV_RING_FIGURES figures;
  CHECK_EQ_INT(VrrInitialize(&ring, 8, SLOT_SIZE), 0);
  PVIDEO_RECV_SLOT slot = VrrFirstSlot(&ring);
  for (int i = 0; i < 6; i++) {
    CHECK(slot != NULL);
    slot = VrrPublish(&ring, 10, 1, &waitedUs);
  }
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 0, &first, &idleUs, &figures, false), 6);
  CHECK_EQ_INT(first, 0);
  CHECK_EQ_INT(figures.maxDepth, 6);
  CHECK_EQ_INT(figures.windowMaxDepth, 6);
  // Give 4 back and start a new minute: 2 are left in the ring
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 4, &first, &idleUs, &figures, true), 2);
  CHECK_EQ_INT(first, 4);
  CHECK_EQ_INT(figures.windowMaxDepth, 6);
  slot = VrrPublish(&ring, 10, 1, &waitedUs);
  CHECK(slot == VrrSlot(&ring, 7));
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 0, &first, &idleUs, &figures, false), 3);
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
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, 0, &first, &idleUs, &figures, false), VRR_BATCH);
  CHECK_EQ_INT(VrrReleaseAndTake(&ring, VRR_BATCH, &first, &idleUs, &figures, false), 8);
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
  runCase("a reader with packets 40 us apart wakes the processing thread, which sleeps between them instead of keeping "
          "a core busy",
          test_a_reader_with_packets_40_us_apart_wakes_the_processing_thread_which_sleeps_meanwhile);
  runCase("a processing thread that finds the ring empty waits at once, from any start on a clock in steps",
          test_a_processing_thread_that_finds_the_ring_empty_waits_at_once);
  runCase("a packet, a full ring, a close or a stop between the unlock and the lock around the processing thread's "
          "reads of the clock is seen when it takes the lock",
          test_what_comes_between_the_unlock_and_the_lock_around_the_reads_of_the_clock);
  runCase("no packet is left in the ring while the processing thread waits, after bursts of 1 to 40 packets",
          test_no_packet_is_left_in_the_ring_while_the_processing_thread_waits);
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
