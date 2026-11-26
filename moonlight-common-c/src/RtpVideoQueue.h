#pragma once

#include "Video.h"

typedef struct _RTPV_QUEUE_ENTRY {
    struct _RTPV_QUEUE_ENTRY* next;
    struct _RTPV_QUEUE_ENTRY* prev;
    PRTP_PACKET packet;
    uint64_t receiveTimeUs;
    uint32_t presentationTimeMs;
    int length;
    bool isParity;
    // Moonlight Plus: the arrival figures of the frame of this packet (frameArrival* of RTP_VIDEO_QUEUE), set on each
    // packet of a complete frame that the queue hands to the depacketizer, which takes them from the first packet
    uint32_t frameArrivalTimeUs;
    uint32_t frameArrivalBytes;
} RTPV_QUEUE_ENTRY, *PRTPV_QUEUE_ENTRY;

typedef struct _RTPV_QUEUE_LIST {
    PRTPV_QUEUE_ENTRY head;
    PRTPV_QUEUE_ENTRY tail;
    uint32_t count;
} RTPV_QUEUE_LIST, *PRTPV_QUEUE_LIST;

typedef struct _RTP_VIDEO_QUEUE {
    RTPV_QUEUE_LIST pendingFecBlockList;
    RTPV_QUEUE_LIST completedFecBlockList;

    uint64_t bufferFirstRecvTimeUs;
    uint32_t bufferLowestSequenceNumber;
    uint32_t bufferHighestSequenceNumber;
    uint32_t bufferFirstParitySequenceNumber;
    uint32_t bufferDataPackets;
    uint32_t bufferParityPackets;
    uint32_t receivedDataPackets;
    uint32_t receivedParityPackets;
    uint32_t receivedHighestSequenceNumber;
    uint32_t fecPercentage;
    uint32_t nextContiguousSequenceNumber;
    uint32_t missingPackets; // # of holes behind receivedHighestSequenceNumber
    bool useFastQueuePath;
    bool reportedLostFrame;

    uint32_t currentFrameNumber;

    bool multiFecCapable;
    uint8_t multiFecCurrentBlockNumber;
    uint8_t multiFecLastBlockNumber;

    uint32_t lastOosFramePresentationTimestamp;
    bool receivedOosData;

    // Session statistics of the FEC recovery, written only by the video processing thread (the receive thread up to
    // 2.3.4) and reset with the queue
    uint32_t statRecoveredBlocks;
    uint32_t statRecoveredPackets;
    uint32_t statRecoveryFailures;
    uint32_t statLongestRecoveryMs;
    uint32_t statSlowRecoveries;
    uint32_t statWorstMissingPackets;
    uint32_t statWorstParityPackets;
    bool statBlockRecorded; // the recovery of the current FEC block was already counted

    // Moonlight Plus: how fast the packets of the current frame arrive, for the arrival rate of the statistics
    // (arrivalTimeUs and arrivalBytes of DECODE_UNIT), written only by the video processing thread. Per FEC block: the
    // bytes at IP level of its packets after the first one until it is complete (its data packets, and the parity
    // packets that a block with missing data packets needed); per frame: the time from the first packet of each
    // block to the packet that completed it and those bytes, summed over its blocks. packetOverheadBytes is what a
    // video packet carries on the network besides the RTP packet that the queue sees (IP and UDP headers, the header
    // of an encrypted packet).
    uint32_t blockArrivalBytes;
    uint32_t frameArrivalTimeUs;
    uint32_t frameArrivalBytes;
    uint32_t packetOverheadBytes;
} RTP_VIDEO_QUEUE, *PRTP_VIDEO_QUEUE;

#define RTPF_RET_QUEUED    0
#define RTPF_RET_REJECTED  1

void RtpvInitializeQueue(PRTP_VIDEO_QUEUE queue);
void RtpvCleanupQueue(PRTP_VIDEO_QUEUE queue);
int RtpvAddPacket(PRTP_VIDEO_QUEUE queue, PRTP_PACKET packet, int length, PRTPV_QUEUE_ENTRY packetEntry,
                  uint64_t receiveTimeUs);
uint32_t RtpvGetCurrentFrameNumber(PRTP_VIDEO_QUEUE queue);
void RtpvSubmitQueuedPackets(PRTP_VIDEO_QUEUE queue);
