#pragma once

// Moonlight Plus (since 2.3.5): the ring of packets between the two threads of the video receive. This is a change of
// Moonlight Plus to the vendored library, not part of upstream moonlight-common-c.
//
// The reader thread (VideoReceiveThreadProc() of VideoStream.c) only reads the socket: it receives each packet into
// the buffer of the next free slot, notes the time it read it and publishes the slot. The processing thread
// (VideoProcessThreadProc()) takes the published slots in order, in batches of up to VRR_BATCH, and gives them back
// when it is done with them. A full ring drops nothing: the reader waits for room, and the packets wait in the receive
// buffer of the socket meanwhile, as they did while the single receive thread of 2.3.4 was busy.
//
// One mutex guards the indexes and the flags (the C code of the module uses no atomics, see
// tests/unit/native-atomics.test.js); the reader takes it once per packet, the processing thread once per batch. The
// contents of a slot need no lock: the reader writes a slot only between taking it (VrrFirstSlot() or VrrPublish()
// returns it) and publishing it, and the processing thread uses it only between taking it and giving it back, and the
// mutex orders the two. A thread waits only when it has to: the processing thread as soon as the ring is empty, and the
// reader when the ring is full. Each one wakes the other only when the other waits, so the reader wakes the processing
// thread for the first packet it publishes after the processing thread began to wait, and no packet is left in the ring
// while the processing thread waits, whether the reader then reads on or waits for the socket.
//
// The processing thread doesn't look again for packets before it waits. The test version of 2.3.5 did, for at least
// 100 us by the clock (100 to 200 us on the clock of the TV, which steps in 0.1 ms), so that the reader rarely had to
// wake it while the packets of a frame came. But they come about 40 us apart on average (the frames arrive at about
// 270 Mbps over the Wi-Fi of the TV). In a simulation on a PC with 14 us of work per packet, the look went on through
// nearly every gap of a frame whose packets came evenly, so it kept a core busy for as long as they came, and for 100
// to 200 us after each burst of one whose packets came in bursts. Waiting at once costs a wake for many of the packets
// instead (a signal on the reader, the return from the wait on this thread), which in that simulation took both
// threads together 17 to 22 % less CPU than the look at 155 to 250 Mbps, and 4 to 9 % less with 30 us of work per
// packet. A test of the test version on a TV showed signs that the rest of the TV had less CPU than with 2.3.2. Where
// the reader sets the pace (it reads waiting packets one after the other), each signal adds to its time per packet;
// waking the processing thread only for several packets or when the reader's read finds nothing would spare most of
// them.
//
// Plain video: the processing thread hands the buffer of a slot to the RTP queue and puts a buffer of its own into
// the slot in its place, so no packet is copied. Encrypted video: the slot keeps its buffer, which the processing
// thread decrypts into a buffer of its own.
//
// The functions are static, for VideoStream.c and the native tests (tests/native/video_receive_ring_test.c,
// tests/native/video_receive_threads_test.c), which include this header.

#include "Platform.h"
#include "PlatformThreads.h"

// The packets that the processing thread takes at most before it gives them back
#define VRR_BATCH 32

typedef struct _VIDEO_RECV_SLOT {
    char* buffer;            // the slot's buffer, of the size given to VrrInitialize()
    int length;              // the bytes that the reader received into it
    uint64_t receiveTimeUs;  // when the reader read them (PltGetMicroseconds())
} VIDEO_RECV_SLOT, *PVIDEO_RECV_SLOT;

// The figures of the ring for the lines of the processing thread, all since the start except windowMaxDepth
typedef struct _VIDEO_RECV_RING_FIGURES {
    uint32_t maxDepth;        // the most packets that were in the ring at once
    uint32_t windowMaxDepth;  // the same since the last VrrReleaseAndTake() with startWindow
    uint64_t fullWaits;       // the times that the reader found the ring full and waited for room
    uint64_t fullWaitUs;      // the time it waited
    uint64_t wakes;           // the times that the reader woke the waiting processing thread
} VIDEO_RECV_RING_FIGURES;

typedef struct _VIDEO_RECV_RING {
    PLT_MUTEX mutex;
    PLT_COND packetsCond;    // the processing thread waits here for packets
    PLT_COND roomCond;       // the reader waits here for room
    PVIDEO_RECV_SLOT slots;
    uint32_t slotCount;      // a power of two
    uint32_t head;           // the slots published (the reader writes it)
    uint32_t tail;           // the slots given back (the processing thread writes it)
    bool readerWaiting;
    bool processorWaiting;
    bool closed;             // the reader ended: the processing thread takes what is left, then ends
    bool stopped;            // the stream stops or the processing thread ended: nobody waits any more
    VIDEO_RECV_RING_FIGURES figures;
} VIDEO_RECV_RING, *PVIDEO_RECV_RING;

// Frees the buffers of the slots, the slots, the condition variables and the mutex, also of a ring that
// VrrInitialize() left half made; a ring that is all zeros (or was destroyed already) is left as it is
static void VrrDestroy(PVIDEO_RECV_RING ring) {
    uint32_t i;

    if (ring->slots == NULL) {
        return;
    }
    for (i = 0; i < ring->slotCount; i++) {
        free(ring->slots[i].buffer);
    }
    free(ring->slots);
    ring->slots = NULL;
    PltDeleteConditionVariable(&ring->roomCond);
    PltDeleteConditionVariable(&ring->packetsCond);
    PltDeleteMutex(&ring->mutex);
}

// A ring of slotCount slots (a power of two) with a buffer of slotSize bytes each: 0, or -1 when memory is short (then
// nothing is left to free)
static int VrrInitialize(PVIDEO_RECV_RING ring, uint32_t slotCount, int slotSize) {
    uint32_t i;

    LC_ASSERT(slotCount != 0 && (slotCount & (slotCount - 1)) == 0);
    memset(ring, 0, sizeof(*ring));
    if (PltCreateMutex(&ring->mutex) != 0) {
        return -1;
    }
    if (PltCreateConditionVariable(&ring->packetsCond, &ring->mutex) != 0) {
        PltDeleteMutex(&ring->mutex);
        return -1;
    }
    if (PltCreateConditionVariable(&ring->roomCond, &ring->mutex) != 0) {
        PltDeleteConditionVariable(&ring->packetsCond);
        PltDeleteMutex(&ring->mutex);
        return -1;
    }
    ring->slotCount = slotCount;
    ring->slots = (PVIDEO_RECV_SLOT)calloc(slotCount, sizeof(VIDEO_RECV_SLOT));
    if (ring->slots == NULL) {
        PltDeleteConditionVariable(&ring->roomCond);
        PltDeleteConditionVariable(&ring->packetsCond);
        PltDeleteMutex(&ring->mutex);
        return -1;
    }
    for (i = 0; i < slotCount; i++) {
        ring->slots[i].buffer = (char*)malloc(slotSize);
        if (ring->slots[i].buffer == NULL) {
            VrrDestroy(ring);
            return -1;
        }
    }
    return 0;
}

// The reader: the slot to receive the first packet into
static PVIDEO_RECV_SLOT VrrFirstSlot(PVIDEO_RECV_RING ring) {
    return &ring->slots[0];
}

// The reader: publishes the slot it received a packet into (the one that VrrFirstSlot() or the last VrrPublish()
// returned), with the length of the packet and the time it read it, wakes a processing thread that waits for packets,
// and returns the slot for the next packet, after waiting for room while the ring is full; NULL once the ring is
// stopped. *waitedUs gets the time it waited for room (0 without a wait).
static PVIDEO_RECV_SLOT VrrPublish(PVIDEO_RECV_RING ring, int length, uint64_t receiveTimeUs, uint64_t* waitedUs) {
    // (head is written by this thread only, so it is read here without the mutex)
    PVIDEO_RECV_SLOT slot = &ring->slots[ring->head & (ring->slotCount - 1)];
    PVIDEO_RECV_SLOT next;
    uint32_t depth;

    slot->length = length;
    slot->receiveTimeUs = receiveTimeUs;
    *waitedUs = 0;

    PltLockMutex(&ring->mutex);
    ring->head++;
    depth = ring->head - ring->tail;
    if (depth > ring->figures.maxDepth) {
        ring->figures.maxDepth = depth;
    }
    if (depth > ring->figures.windowMaxDepth) {
        ring->figures.windowMaxDepth = depth;
    }
    if (ring->processorWaiting) {
        ring->processorWaiting = false;
        ring->figures.wakes++;
        PltSignalConditionVariable(&ring->packetsCond);
    }
    if (depth == ring->slotCount && !ring->stopped) {
        // No slot is free for the next packet: wait until the processing thread gives one back
        uint64_t waitStartUs = PltGetMicroseconds();
        ring->figures.fullWaits++;
        while (ring->head - ring->tail == ring->slotCount && !ring->stopped) {
            ring->readerWaiting = true;
            PltWaitForConditionVariable(&ring->roomCond, &ring->mutex);
        }
        ring->readerWaiting = false;
        *waitedUs = PltGetMicroseconds() - waitStartUs;
        ring->figures.fullWaitUs += *waitedUs;
    }
    next = ring->stopped ? NULL : &ring->slots[ring->head & (ring->slotCount - 1)];
    PltUnlockMutex(&ring->mutex);
    return next;
}

// The reader, when it ends: the processing thread takes the packets that are left, then ends
static void VrrClose(PVIDEO_RECV_RING ring) {
    PltLockMutex(&ring->mutex);
    ring->closed = true;
    if (ring->processorWaiting) {
        ring->processorWaiting = false;
        PltSignalConditionVariable(&ring->packetsCond);
    }
    PltUnlockMutex(&ring->mutex);
}

// The stop of the stream, or the processing thread when it ends early: neither thread waits any more, VrrPublish()
// returns NULL and VrrReleaseAndTake() 0 from now on
static void VrrStop(PVIDEO_RECV_RING ring) {
    PltLockMutex(&ring->mutex);
    ring->stopped = true;
    ring->processorWaiting = false;
    ring->readerWaiting = false;
    PltSignalConditionVariable(&ring->packetsCond);
    PltSignalConditionVariable(&ring->roomCond);
    PltUnlockMutex(&ring->mutex);
}

// The processing thread: gives back the `released` slots it took last, wakes a reader that waits for room, then takes
// the next ones, waiting while there are none, and returns how many it took (at most VRR_BATCH, from *first on, an
// index for VrrSlot()): 0 once the ring is stopped, or closed and empty. *idleUs gets the time from finding the ring
// empty until it runs again after the wait, which includes the time it takes to wake it (0 when the ring wasn't
// empty); *figures the figures of the ring, whose windowMaxDepth then starts again from the packets now in the ring if
// startWindow.
static uint32_t VrrReleaseAndTake(PVIDEO_RECV_RING ring, uint32_t released, uint32_t* first, uint64_t* idleUs,
                                  VIDEO_RECV_RING_FIGURES* figures, bool startWindow) {
    uint32_t taken;

    *idleUs = 0;
    PltLockMutex(&ring->mutex);
    ring->tail += released;
    if (released > 0 && ring->readerWaiting) {
        ring->readerWaiting = false;
        PltSignalConditionVariable(&ring->roomCond);
    }
    if (ring->head == ring->tail && !ring->stopped && !ring->closed) {
        uint64_t startUs;

        // Nothing to do: wait for the reader at once (the clock is read without the mutex, and a packet, a close or a
        // stop that came meanwhile is seen by the check below, without a wait)
        PltUnlockMutex(&ring->mutex);
        startUs = PltGetMicroseconds();
        PltLockMutex(&ring->mutex);
        while (ring->head == ring->tail && !ring->stopped && !ring->closed) {
            ring->processorWaiting = true;
            PltWaitForConditionVariable(&ring->packetsCond, &ring->mutex);
        }
        ring->processorWaiting = false;
        PltUnlockMutex(&ring->mutex);
        *idleUs = PltGetMicroseconds() - startUs;
        PltLockMutex(&ring->mutex);
    }
    taken = ring->stopped ? 0 : ring->head - ring->tail;
    if (taken > VRR_BATCH) {
        taken = VRR_BATCH;
    }
    *first = ring->tail;
    *figures = ring->figures;
    if (startWindow) {
        ring->figures.windowMaxDepth = ring->head - ring->tail;
    }
    PltUnlockMutex(&ring->mutex);
    return taken;
}

// The processing thread: the slot of an index from VrrReleaseAndTake()
static PVIDEO_RECV_SLOT VrrSlot(PVIDEO_RECV_RING ring, uint32_t index) {
    return &ring->slots[index & (ring->slotCount - 1)];
}
