// Checks the arrival figures of a frame that the RTP video queue of moonlight-common-c (moonlight-common-c/src/
// RtpVideoQueue.c, included directly) hands over with its packets since 2.3.2, from which the app shows the rate at
// which the frames arrive ('Frames arrive at' of the full statistics, wasm/frame_arrival.hpp): the time from the first
// packet to the last data packet of each FEC block, summed over the blocks of the frame, and the bytes at IP level of the
// data packets that arrived in that time (each block's after its first), with the IP and UDP headers and the header of
// an encrypted packet. Parity packets don't count, a block that needed FEC recovery counts up to the parity packet
// that completed it (with the parity packets it needed, and without the time of the recovery), a block with a single
// packet adds nothing, and the time between two blocks (the parity of the first) is left out.
// The case of the research: at 150 Mbps 4K60 a frame took 8.65 ms from its first to its last packet on an S90C over
// 5 GHz Wi-Fi, about 42 us per data packet of 1392 bytes, which is about 275 Mbps at IP level.
// The test feeds packets the way VideoStream.c does (the queue entry behind the packet in the same allocation) on a
// clock of the test, with FEC on; a stand-in for the Reed-Solomon recovery fills in the missing data packets.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/RtpVideoQueue.c"

#include <stdlib.h>
#include <string.h>

// What the other files of moonlight-common-c provide to the queue: a Sunshine host with multi-block FEC, the packet
// size of the app (wasm/main.cpp), an IPv4 host without video encryption unless a test changes them
int AppVersionQuad[4] = {7, 1, 431, 0};
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
struct sockaddr_storage RemoteAddr;
uint32_t EncryptionFeaturesEnabled;

#define PACKET_SIZE 1392
// The RTP header with its extension, before the video packet header
#define RTP_HEADER_SIZE ((int)sizeof(RTP_PACKET) + 4)
// The bytes of a data packet at IP level: IPv4 and UDP headers, the RTP header and the video packet of PACKET_SIZE
#define IP_PACKET_BYTES (20 + 8 + RTP_HEADER_SIZE + PACKET_SIZE)
#define MAX_FRAMES 16

// The clock of PltGetMicroseconds(), which the test sets to the arrival time of each packet
static uint64_t nowUs = 1000000;
static uint64_t fakeMillis;

// What the depacketizer got: per frame, its packets and the arrival figures of its first packet, and whether all its
// packets carried the same figures
static uint32_t frameIndexes[MAX_FRAMES];
static uint32_t framePackets[MAX_FRAMES];
static uint32_t frameArrivalUs[MAX_FRAMES];
static uint32_t frameArrivalBytes[MAX_FRAMES];
static bool frameFiguresSame[MAX_FRAMES];
static int frameCount;
static int recoveries;
// How long the stand-in for the Reed-Solomon recovery takes on the clock of the test
static uint64_t recoveryCostUs;

void notifyFrameLost(unsigned int frameNumber, bool speculative) {
  (void)frameNumber;
  (void)speculative;
}

void queueRtpPacket(PRTPV_QUEUE_ENTRY entry) {
  PNV_VIDEO_PACKET nvPacket = (PNV_VIDEO_PACKET)(((char*)entry->packet) + RTP_HEADER_SIZE);
  if (frameCount == 0 || frameIndexes[frameCount - 1] != nvPacket->frameIndex) {
    if (frameCount < MAX_FRAMES) {
      frameIndexes[frameCount] = nvPacket->frameIndex;
      framePackets[frameCount] = 0;
      frameArrivalUs[frameCount] = entry->frameArrivalTimeUs;
      frameArrivalBytes[frameCount] = entry->frameArrivalBytes;
      frameFiguresSame[frameCount] = true;
      frameCount++;
    }
  }
  if (frameCount > 0) {
    framePackets[frameCount - 1]++;
    frameFiguresSame[frameCount - 1] &= entry->frameArrivalTimeUs == frameArrivalUs[frameCount - 1] &&
                                        entry->frameArrivalBytes == frameArrivalBytes[frameCount - 1];
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
  return false;
}

uint64_t PltGetMillis(void) {
  return ++fakeMillis;
}

uint64_t PltGetMicroseconds(void) {
  return nowUs;
}

// A stand-in for the Reed-Solomon recovery: it fills in each missing data packet with the flags of its place in the
// block, which the queue checks, as a real recovery would restore them
static reed_solomon testCodec;
void reed_solomon_init(void) {}
reed_solomon* reed_solomon_new(int dataShards, int parityShards) {
  testCodec.data_shards = dataShards;
  testCodec.parity_shards = parityShards;
  return &testCodec;
}
void reed_solomon_release(reed_solomon* rs) {
  (void)rs;
}
int reed_solomon_reconstruct(reed_solomon* rs, unsigned char** shards, unsigned char* marks, int nrShards, int blockSize) {
  recoveries++;
  nowUs += recoveryCostUs;
  for (int i = 0; i < nrShards && i < rs->data_shards; i++) {
    if (marks[i]) {
      memset(shards[i], 0, (size_t)blockSize);
      PNV_VIDEO_PACKET nvPacket = (PNV_VIDEO_PACKET)(shards[i] + RTP_HEADER_SIZE);
      nvPacket->flags = (uint8_t)(FLAG_CONTAINS_PIC_DATA | (i == 0 ? FLAG_SOF : 0) |
                                  (i == rs->data_shards - 1 ? FLAG_EOF : 0));
    }
  }
  return 0;
}

static RTP_VIDEO_QUEUE queue;
static uint16_t blockFirstSequenceNumber;

static void resetQueue(int addressFamily, uint32_t encryption) {
  RemoteAddr.ss_family = (sa_family_t)addressFamily;
  EncryptionFeaturesEnabled = encryption;
  StreamConfig.packetSize = PACKET_SIZE;
  RtpvInitializeQueue(&queue);
  frameCount = 0;
  recoveries = 0;
  recoveryCostUs = 0;
  blockFirstSequenceNumber = 100;
}

// Packet `index` of an FEC block (data packets first, then the parity packets), arriving at timeUs; returns whether
// the queue took it
static bool sendPacket(uint32_t frameIndex, int blockNumber, int lastBlockNumber, int dataPackets, int fecPercentage,
                       int index, uint64_t timeUs) {
  const int length = RTP_HEADER_SIZE + PACKET_SIZE;
  char* buffer = (char*)calloc(1, (size_t)length + sizeof(RTPV_QUEUE_ENTRY));
  PRTP_PACKET packet = (PRTP_PACKET)buffer;
  PNV_VIDEO_PACKET nvPacket = (PNV_VIDEO_PACKET)(buffer + RTP_HEADER_SIZE);
  packet->header = 0x80 | FLAG_EXTENSION;
  packet->packetType = 127;
  packet->sequenceNumber = (uint16_t)(blockFirstSequenceNumber + index);
  packet->timestamp = frameIndex * 1500;  // 90 kHz at 60 FPS
  nvPacket->frameIndex = frameIndex;
  nvPacket->streamPacketIndex = packet->sequenceNumber;
  if (index < dataPackets) {
    nvPacket->flags = (uint8_t)(FLAG_CONTAINS_PIC_DATA | (index == 0 && blockNumber == 0 ? FLAG_SOF : 0) |
                                (index == dataPackets - 1 ? FLAG_EOF : 0));
  }
  nvPacket->multiFecFlags = 0x10;
  nvPacket->multiFecBlocks = (uint8_t)((lastBlockNumber << 6) | (blockNumber << 4));
  nvPacket->fecInfo = ((uint32_t)dataPackets << 22) | ((uint32_t)index << 12) | ((uint32_t)fecPercentage << 4);
  nowUs = timeUs;
  if (RtpvAddPacket(&queue, packet, length, (PRTPV_QUEUE_ENTRY)(buffer + length)) != RTPF_RET_QUEUED) {
    // A rejected packet stays with the caller
    free(buffer);
    return false;
  }
  return true;
}

static int parityPacketsOf(int dataPackets, int fecPercentage) {
  return (dataPackets * fecPercentage + 99) / 100;
}

// Send an FEC block: its data packets from startUs, spacingUs apart, except those in `lost` (a bitmask of the first 32),
// then its parity packets at the same pace. Returns the time after its last packet. The next block starts after its
// sequence numbers.
static uint64_t sendBlock(uint32_t frameIndex, int blockNumber, int lastBlockNumber, int dataPackets, int fecPercentage,
                          uint64_t startUs, uint64_t spacingUs, uint32_t lost) {
  const int total = dataPackets + parityPacketsOf(dataPackets, fecPercentage);
  uint64_t timeUs = startUs;
  for (int i = 0; i < total; i++, timeUs += spacingUs) {
    if (i < 32 && (lost & (1u << i))) {
      continue;
    }
    sendPacket(frameIndex, blockNumber, lastBlockNumber, dataPackets, fecPercentage, i, timeUs);
  }
  blockFirstSequenceNumber = (uint16_t)(blockFirstSequenceNumber + total);
  return timeUs;
}

// The case of the research: 207 data packets of 1392 bytes, 42 us apart, are 8.65 ms from the first to the last; the
// 42 parity packets of 20 % FEC that follow them don't count. 206 packets of 1436 bytes at IP level arrive in 8,652 us,
// i.e. at 273.5 Mbps.
static void test_a_4k60_frame_at_150_mbps_arrives_at_about_275_mbps(void) {
  resetQueue(AF_INET, 0);
  sendBlock(1, 0, 0, 207, 20, 2000000, 42, 0);
  sendBlock(2, 0, 0, 207, 20, 2016667, 42, 0);
  CHECK_EQ_INT(frameCount, 2);
  CHECK_EQ_INT(framePackets[0], 207);
  CHECK_EQ_INT(recoveries, 0);
  for (int i = 0; i < 2; i++) {
    CHECK_EQ_INT(frameArrivalUs[i], 206 * 42);
    CHECK_EQ_INT(frameArrivalBytes[i], 206 * IP_PACKET_BYTES);
    CHECK_EQ_INT(IP_PACKET_BYTES, 1436);
    CHECK(frameFiguresSame[i]);
  }
  // In Mbps (bits per microsecond), as the app works it out: about 275
  const double mbps = frameArrivalBytes[0] * 8.0 / frameArrivalUs[0];
  CHECK(mbps > 270.0 && mbps < 280.0);
  RtpvCleanupQueue(&queue);
}

// A frame of two FEC blocks: the time of each block from its first packet to its last data packet, without the time
// between them, when the parity packets of the first block arrive (and are rejected, since the block is complete)
static void test_the_blocks_of_a_frame_count_without_the_time_between_them(void) {
  resetQueue(AF_INET, 0);
  // Block 0: 5 data packets at 0, 50, ..., 200 us and 1 parity packet at 250; block 1: 3 data packets at 1000, 1050,
  // 1100 and 1 parity packet at 1150
  sendBlock(1, 0, 1, 5, 20, 3000000, 50, 0);
  sendBlock(1, 1, 1, 3, 20, 3001000, 50, 0);
  CHECK_EQ_INT(frameCount, 1);
  CHECK_EQ_INT(framePackets[0], 8);
  CHECK_EQ_INT(frameArrivalUs[0], 200 + 100);
  CHECK_EQ_INT(frameArrivalBytes[0], (4 + 2) * IP_PACKET_BYTES);
  CHECK(frameFiguresSame[0]);
  RtpvCleanupQueue(&queue);
}

// A block that needed FEC recovery counts up to the parity packet that completed it, with the bytes of the packets
// that arrived after its first (the parity packets it needed among them): the slot of a missing data packet counts as
// time without bytes. Under the packet loss of Wi-Fi, frames keep their figures rather than leaving the rate to the
// few frames that came through whole. The time of the recovery itself, which runs on the receive thread, doesn't
// count: the clock is read before it. Packets 40 us apart, 10 data and 2 parity packets per block.
static void test_a_block_that_needed_fec_recovery_counts_up_to_its_last_parity_packet(void) {
  resetQueue(AF_INET, 0);
  recoveryCostUs = 3000;
  // Frame 1: data packet 4 lost; the first parity packet (at 400 us) completes the block
  sendBlock(1, 0, 0, 10, 20, 4000000, 40, 1u << 4);
  CHECK_EQ_INT(recoveries, 1);
  // Frame 2: block 0 complete (360 us), block 1 without its last data packet, completed by its first parity packet
  sendBlock(2, 0, 1, 10, 20, 4016000, 40, 0);
  sendBlock(2, 1, 1, 10, 20, 4017000, 40, 1u << 9);
  CHECK_EQ_INT(recoveries, 2);
  // Frame 3: complete; frame 4: the last two data packets lost, completed by the second parity packet (440 us)
  sendBlock(3, 0, 0, 10, 20, 4033000, 40, 0);
  sendBlock(4, 0, 0, 10, 20, 4050000, 40, (1u << 8) | (1u << 9));
  CHECK_EQ_INT(recoveries, 3);
  CHECK_EQ_INT(frameCount, 4);
  CHECK_EQ_INT(framePackets[0], 10);
  CHECK_EQ_INT(framePackets[1], 20);
  CHECK_EQ_INT(frameArrivalUs[0], 10 * 40);
  CHECK_EQ_INT(frameArrivalBytes[0], 9 * IP_PACKET_BYTES);
  CHECK_EQ_INT(frameArrivalUs[1], 9 * 40 + 10 * 40);
  CHECK_EQ_INT(frameArrivalBytes[1], (9 + 9) * IP_PACKET_BYTES);
  CHECK_EQ_INT(frameArrivalUs[2], 9 * 40);
  CHECK_EQ_INT(frameArrivalBytes[2], 9 * IP_PACKET_BYTES);
  CHECK_EQ_INT(frameArrivalUs[3], 11 * 40);
  CHECK_EQ_INT(frameArrivalBytes[3], (7 + 2) * IP_PACKET_BYTES);
  for (int i = 0; i < 4; i++) {
    CHECK(frameFiguresSame[i]);
  }
  RtpvCleanupQueue(&queue);
}

// The case of the research with one data packet lost: the frame is completed by its first parity packet, one slot
// later, with as many packets after the first as without the loss, so it reads lower by about the share of the missing
// packet (1 of 207), not higher and not without figures
static void test_a_4k60_frame_with_a_lost_packet_reads_a_little_lower(void) {
  resetQueue(AF_INET, 0);
  sendBlock(1, 0, 0, 207, 20, 2000000, 42, 0);
  sendBlock(2, 0, 0, 207, 20, 2016667, 42, 1u << 20);
  CHECK_EQ_INT(frameCount, 2);
  CHECK_EQ_INT(recoveries, 1);
  CHECK_EQ_INT(frameArrivalUs[1], 207 * 42);
  CHECK_EQ_INT(frameArrivalBytes[1], 206 * IP_PACKET_BYTES);
  const double whole = frameArrivalBytes[0] * 8.0 / frameArrivalUs[0];
  const double repaired = frameArrivalBytes[1] * 8.0 / frameArrivalUs[1];
  CHECK(repaired < whole && repaired > whole * (1.0 - 2.0 / 207));
  CHECK(repaired > 270.0);
  RtpvCleanupQueue(&queue);
}

// A block with a single data packet adds nothing: there is no time between two of its packets, and the clock of the
// TV would turn its handling into a time without bytes. A frame of one packet has no figures.
static void test_a_block_of_one_data_packet_adds_nothing(void) {
  resetQueue(AF_INET, 0);
  sendBlock(1, 0, 0, 1, 20, 5000000, 30, 0);
  sendBlock(2, 0, 1, 4, 20, 5016000, 30, 0);
  sendBlock(2, 1, 1, 1, 20, 5017000, 30, 0);
  CHECK_EQ_INT(frameCount, 2);
  CHECK_EQ_INT(frameArrivalUs[0], 0);
  CHECK_EQ_INT(frameArrivalBytes[0], 0);
  CHECK_EQ_INT(frameArrivalUs[1], 3 * 30);
  CHECK_EQ_INT(frameArrivalBytes[1], 3 * IP_PACKET_BYTES);
  RtpvCleanupQueue(&queue);
}

// Data packets out of order: the time runs from the first packet that arrived to the last, and the bytes are those of
// the packets after the first that arrived. On a coarse clock all packets of a frame can share one reading: the frame
// keeps its bytes with a time of 0, which the app adds up all the same.
static void test_out_of_order_packets_and_a_coarse_clock(void) {
  resetQueue(AF_INET, 0);
  const int order[4] = {1, 0, 3, 2};
  for (int i = 0; i < 4; i++) {
    sendPacket(1, 0, 0, 4, 0, order[i], 6000000 + (uint64_t)i * 100);
  }
  blockFirstSequenceNumber = (uint16_t)(blockFirstSequenceNumber + 4);
  sendBlock(2, 0, 0, 4, 0, 6016000, 0, 0);
  CHECK_EQ_INT(frameCount, 2);
  CHECK_EQ_INT(frameArrivalUs[0], 300);
  CHECK_EQ_INT(frameArrivalBytes[0], 3 * IP_PACKET_BYTES);
  CHECK_EQ_INT(frameArrivalUs[1], 0);
  CHECK_EQ_INT(frameArrivalBytes[1], 3 * IP_PACKET_BYTES);
  RtpvCleanupQueue(&queue);
}

// The bytes at IP level follow the network of the stream: 40 bytes of IPv6 header instead of 20, and with video
// encryption the header of each encrypted packet
static void test_the_bytes_include_the_headers_of_the_network(void) {
  const struct {
    int family;
    uint32_t encryption;
    int packetBytes;
  } cases[] = {
    {AF_INET, 0, IP_PACKET_BYTES},
    {AF_INET6, 0, IP_PACKET_BYTES + 20},
    {AF_INET, SS_ENC_VIDEO, IP_PACKET_BYTES + (int)sizeof(ENC_VIDEO_HEADER)},
    {AF_INET6, SS_ENC_VIDEO | SS_ENC_AUDIO, IP_PACKET_BYTES + 20 + (int)sizeof(ENC_VIDEO_HEADER)},
    {AF_INET, SS_ENC_AUDIO, IP_PACKET_BYTES},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
    resetQueue(cases[i].family, cases[i].encryption);
    sendBlock(1, 0, 0, 3, 20, 7000000, 10, 0);
    CHECK_EQ_INT(frameCount, 1);
    CHECK_EQ_INT(frameArrivalBytes[0], 2 * cases[i].packetBytes);
    RtpvCleanupQueue(&queue);
  }
  CHECK_EQ_INT(sizeof(ENC_VIDEO_HEADER), 32);
}

int main(void) {
  RUN_TEST("a 4K60 frame at 150 Mbps (8.65 ms, 42 us per data packet) arrives at about 275 Mbps at IP level",
           test_a_4k60_frame_at_150_mbps_arrives_at_about_275_mbps);
  RUN_TEST("the FEC blocks of a frame count without the time between them",
           test_the_blocks_of_a_frame_count_without_the_time_between_them);
  RUN_TEST("a block that needed FEC recovery counts up to the parity packet that completed it, without the recovery",
           test_a_block_that_needed_fec_recovery_counts_up_to_its_last_parity_packet);
  RUN_TEST("a 4K60 frame with a lost data packet reads lower by about the share of the missing packet",
           test_a_4k60_frame_with_a_lost_packet_reads_a_little_lower);
  RUN_TEST("an FEC block of one data packet adds nothing", test_a_block_of_one_data_packet_adds_nothing);
  RUN_TEST("out-of-order data packets, and a coarse clock that gives a frame no time",
           test_out_of_order_packets_and_a_coarse_clock);
  RUN_TEST("the bytes at IP level include the IPv4 or IPv6 header and the header of an encrypted packet",
           test_the_bytes_include_the_headers_of_the_network);
  return test_summary();
}
