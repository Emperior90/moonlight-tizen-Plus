// Checks how the RTP video queue of moonlight-common-c (moonlight-common-c/src/RtpVideoQueue.c) reports lost frames for
// reference frame invalidation (RFI) when a frame is split into several FEC blocks, the fix of upstream commit d85371c
// ('Fix RFI after a multi-block frame loss'): a frame that loses a whole FEC block is reported by its own frame number,
// and the report no longer hides the loss of the next frame, which the host would otherwise never learn about. Without
// that, the host keeps referencing a frame the TV never decoded until the next keyframe.
//
// The test includes RtpVideoQueue.c and feeds it packets the way VideoStream.c does (the queue entry sits behind the
// packet in the same allocation), with RFI enabled and FEC off, so that a missing packet always loses its block.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/RtpVideoQueue.c"

#include <stdlib.h>
#include <string.h>

// What the other files of moonlight-common-c provide to the queue
int AppVersionQuad[4] = {7, 1, 431, 0};  // a host with multi-block FEC
STREAM_CONFIGURATION StreamConfig;

#define PAYLOAD_SIZE 32
#define MAX_EVENTS 64

static unsigned int lostFrames[MAX_EVENTS];
static bool lostFramesSpeculative[MAX_EVENTS];
static int lostFrameCount;
static unsigned int submittedFrames[MAX_EVENTS];
static int submittedPacketCount;
static uint64_t fakeMillis;

void notifyFrameLost(unsigned int frameNumber, bool speculative) {
  if (lostFrameCount < MAX_EVENTS) {
    lostFramesSpeculative[lostFrameCount] = speculative;
    lostFrames[lostFrameCount++] = frameNumber;
  }
}

// The depacketizer takes over the entry (and with it the packet) of a completed frame
void queueRtpPacket(PRTPV_QUEUE_ENTRY entry) {
  PNV_VIDEO_PACKET nvPacket = (PNV_VIDEO_PACKET)(((char*)entry->packet) + sizeof(RTP_PACKET) + 4);
  if (submittedPacketCount < MAX_EVENTS) {
    submittedFrames[submittedPacketCount++] = nvPacket->frameIndex;
  }
  free(entry->packet);
}

void connectionSawFrame(uint32_t frameIndex) {
  (void)frameIndex;
}

void connectionSendFrameFecStatus(PSS_FRAME_FEC_STATUS fecStatus) {
  (void)fecStatus;
}

bool isReferenceFrameInvalidationEnabled(void) {
  return true;
}

uint64_t PltGetMillis(void) {
  return ++fakeMillis;
}

// FEC recovery is never needed with FEC off; a call would mean that the test lost track of the queue
void reed_solomon_init(void) {}
reed_solomon* reed_solomon_new(int dataShards, int parityShards) {
  (void)dataShards;
  (void)parityShards;
  abort();
}
void reed_solomon_release(reed_solomon* rs) {
  (void)rs;
}
int reed_solomon_reconstruct(reed_solomon* rs, unsigned char** shards, unsigned char* marks, int nrShards, int blockSize) {
  (void)rs;
  (void)shards;
  (void)marks;
  (void)nrShards;
  (void)blockSize;
  abort();
}

static RTP_VIDEO_QUEUE queue;
static uint16_t nextSequenceNumber;

static void resetQueue(void) {
  RtpvInitializeQueue(&queue);
  lostFrameCount = 0;
  submittedPacketCount = 0;
  nextSequenceNumber = 100;
}

// Build the packet with its queue entry behind it, as VideoStream.c allocates them (fields in host byte order, as the
// receive thread converts the RTP header before it calls the queue)
static PRTP_PACKET makePacket(uint16_t sequenceNumber, uint32_t frameIndex, int blockNumber, int lastBlockNumber,
                              int fecIndex, int dataPackets, PRTPV_QUEUE_ENTRY* entry) {
  const size_t packetLength = sizeof(RTP_PACKET) + 4 + sizeof(NV_VIDEO_PACKET) + PAYLOAD_SIZE;
  char* buffer = (char*)calloc(1, packetLength + sizeof(RTPV_QUEUE_ENTRY));
  PRTP_PACKET packet = (PRTP_PACKET)buffer;
  PNV_VIDEO_PACKET nvPacket = (PNV_VIDEO_PACKET)(buffer + sizeof(RTP_PACKET) + 4);
  packet->header = 0x80 | FLAG_EXTENSION;
  packet->packetType = 127;
  packet->sequenceNumber = sequenceNumber;
  packet->timestamp = frameIndex * 1500;  // 90 kHz at 60 FPS
  nvPacket->frameIndex = frameIndex;
  nvPacket->streamPacketIndex = sequenceNumber;
  nvPacket->flags = fecIndex == dataPackets - 1 ? FLAG_EOF : 0;
  nvPacket->multiFecFlags = 0x10;
  nvPacket->multiFecBlocks = (uint8_t)((lastBlockNumber << 6) | (blockNumber << 4));
  // Data packets, index in the block, FEC percentage 0
  nvPacket->fecInfo = ((uint32_t)dataPackets << 22) | ((uint32_t)fecIndex << 12);
  *entry = (PRTPV_QUEUE_ENTRY)(buffer + packetLength);
  return packet;
}

// Send the packets of one FEC block of a frame; `lost` lists the indexes in the block that the network drops (a
// bitmask), and every packet still uses up its sequence number
static void sendBlock(uint32_t frameIndex, int blockNumber, int lastBlockNumber, int dataPackets, unsigned int lost) {
  for (int i = 0; i < dataPackets; i++) {
    uint16_t sequenceNumber = nextSequenceNumber++;
    if (lost & (1u << i)) {
      continue;
    }
    PRTPV_QUEUE_ENTRY entry;
    PRTP_PACKET packet = makePacket(sequenceNumber, frameIndex, blockNumber, lastBlockNumber, i, dataPackets, &entry);
    const int length = (int)(sizeof(RTP_PACKET) + 4 + sizeof(NV_VIDEO_PACKET) + PAYLOAD_SIZE);
    if (RtpvAddPacket(&queue, packet, length, entry) != RTPF_RET_QUEUED) {
      // A rejected packet stays with the caller
      free(packet);
    }
  }
}

#define ALL_LOST 0xFFFFFFFFu

static int submittedPacketsOf(uint32_t frameIndex) {
  int count = 0;
  for (int i = 0; i < submittedPacketCount; i++) {
    if (submittedFrames[i] == frameIndex) {
      count++;
    }
  }
  return count;
}

static void test_complete_frames_are_submitted_without_loss_reports(void) {
  resetQueue();
  sendBlock(1, 0, 0, 3, 0);
  sendBlock(2, 0, 1, 2, 0);
  sendBlock(2, 1, 1, 2, 0);
  CHECK_EQ_INT(lostFrameCount, 0);
  CHECK_EQ_INT(submittedPacketsOf(1), 3);
  CHECK_EQ_INT(submittedPacketsOf(2), 4);
  CHECK_EQ_INT(RtpvGetCurrentFrameNumber(&queue), 3);
  RtpvCleanupQueue(&queue);
}

// Frame 2 loses its first block completely, so its second block arrives first. Then frame 3 is lost completely: the
// loss of frame 3 must still be reported when frame 4 arrives (before d85371c the report of frame 2 suppressed it).
static void test_lost_first_block_does_not_hide_the_next_lost_frame(void) {
  resetQueue();
  sendBlock(1, 0, 0, 2, 0);
  sendBlock(2, 0, 1, 2, ALL_LOST);
  sendBlock(2, 1, 1, 2, 0);
  CHECK_EQ_INT(lostFrameCount, 1);
  CHECK_EQ_INT(lostFrames[0], 2);
  sendBlock(3, 0, 0, 2, ALL_LOST);
  sendBlock(4, 0, 0, 2, 0);
  CHECK_EQ_INT(lostFrameCount, 2);
  CHECK_EQ_INT(lostFrames[1], 3);
  CHECK(!lostFramesSpeculative[0] && !lostFramesSpeculative[1]);
  // Frame 2 is dropped, frame 4 decodes
  CHECK_EQ_INT(submittedPacketsOf(2), 0);
  CHECK_EQ_INT(submittedPacketsOf(4), 2);
  RtpvCleanupQueue(&queue);
}

// Frame 2 is lost completely and frame 3 loses its first block: the report names frame 3, the newest lost frame, so
// that the invalidated range reaches it (before d85371c it named frame 2, the frame the queue expected)
static void test_lost_block_reports_the_frame_of_the_packet(void) {
  resetQueue();
  sendBlock(1, 0, 0, 2, 0);
  sendBlock(2, 0, 0, 2, ALL_LOST);
  sendBlock(3, 0, 1, 2, ALL_LOST);
  sendBlock(3, 1, 1, 2, 0);
  CHECK_EQ_INT(lostFrameCount, 1);
  CHECK_EQ_INT(lostFrames[0], 3);
  sendBlock(4, 0, 0, 2, 0);
  CHECK_EQ_INT(lostFrameCount, 1);
  CHECK_EQ_INT(submittedPacketsOf(4), 2);
  RtpvCleanupQueue(&queue);
}

// Frame 2 gets only part of its first block before its second block starts. The frame is reported once, and the next
// completely lost frame is reported as well
static void test_incomplete_block_does_not_hide_the_next_lost_frame(void) {
  resetQueue();
  sendBlock(1, 0, 0, 2, 0);
  sendBlock(2, 0, 1, 3, 1u << 2);  // the last packet of the block is lost, so no hole is visible before the next block
  sendBlock(2, 1, 1, 3, 0);
  CHECK_EQ_INT(lostFrameCount, 1);
  CHECK_EQ_INT(lostFrames[0], 2);
  sendBlock(3, 0, 0, 2, ALL_LOST);
  sendBlock(4, 0, 0, 2, 0);
  CHECK_EQ_INT(lostFrameCount, 2);
  CHECK_EQ_INT(lostFrames[1], 3);
  CHECK_EQ_INT(submittedPacketsOf(4), 2);
  RtpvCleanupQueue(&queue);
}

int main(void) {
  RUN_TEST("complete frames with one and two FEC blocks are submitted without a loss report",
           test_complete_frames_are_submitted_without_loss_reports);
  RUN_TEST("a frame that lost its first FEC block does not hide the loss of the next frame (upstream d85371c)",
           test_lost_first_block_does_not_hide_the_next_lost_frame);
  RUN_TEST("a lost FEC block reports the frame of the packet that revealed it (upstream d85371c)",
           test_lost_block_reports_the_frame_of_the_packet);
  RUN_TEST("an incomplete FEC block does not hide the loss of the next frame (upstream d85371c)",
           test_incomplete_block_does_not_hide_the_next_lost_frame);
  return test_summary();
}
