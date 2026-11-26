#include "Limelight-internal.h"
#include "VideoReceiveRing.h"

#define FIRST_FRAME_MAX 1500
#define FIRST_FRAME_TIMEOUT_SEC 10

#define FIRST_FRAME_PORT 47996

static RTP_VIDEO_QUEUE rtpQueue;

static SOCKET rtpSocket = INVALID_SOCKET;
static SOCKET firstFrameSocket = INVALID_SOCKET;

static PPLT_CRYPTO_CONTEXT decryptionCtx;

static PLT_THREAD udpPingThread;
static PLT_THREAD receiveThread;
static PLT_THREAD decoderThread;
// Moonlight Plus (since 2.3.5): the processing thread of the video receive, and the ring between it and the receive
// thread, which only reads the socket (VideoReceiveRing.h)
static PLT_THREAD processThread;
static VIDEO_RECV_RING receiveRing;

static bool receivedDataFromPeer;
static uint64_t firstDataTimeMs;
static bool receivedFullFrame;

// Receive buffer size of the video socket as reported by the OS, or 0 if unknown
static int rtpReceiveBufferSize;

// Moonlight Plus (since 2.3.4): whether startVideoStream() gave the video a socket whose receive calls never wait,
// because the first one took no receive timeout (see VideoReceiveThreadProc())
static bool rtpSocketNoWait;

// Moonlight Plus (since 2.3.4): how the receive thread reads the socket, which its first line names: one recvfrom() per
// packet with a receive timeout (SO_RCVTIMEO), poll() before each recvfrom() where the socket takes no timeout, or reads
// one after the other of the packets that are waiting from a socket that never waits, with poll() only when none is
#define VIDEO_RECV_MODE_TIMEOUT 0
#define VIDEO_RECV_MODE_POLL 1
#define VIDEO_RECV_MODE_NO_WAIT 2

// Moonlight Plus (since 2.3.4): the lines of the receive thread in the diagnostic log, which tell whether the thread or
// the network sets the pace at which the packets of a frame are read (since 2.3.5 the receive thread only reads the
// packets and hands them to the processing thread, which has lines of its own). About every VIDEO_RECV_SAMPLE_EVERY-th
// receive is sampled: whether its packet was already waiting (a poll() without a timeout before it, which is timed too;
// a socket that never waits tells it with every read) and, around it, reads of the clock, which steps in about 0.1 ms
// on the TV, so only averages over many samples count. The gap to the next sample is drawn from
// VIDEO_RECV_SAMPLE_EVERY - 16 to VIDEO_RECV_SAMPLE_EVERY + 15 receives (nextVideoReceiveSampleGap()), so that the
// sample doesn't keep falling on the same packet of frames that all have the same number of packets, e.g. always or
// never on the last one, whose depacketizer pass costs most. A line comes every VIDEO_RECV_LINE_INTERVAL_US while video
// comes, and one for the whole stream when the thread ends.
#define VIDEO_RECV_SAMPLE_EVERY 64
#define VIDEO_RECV_SAMPLE_SEED 1u
#define VIDEO_RECV_LINE_INTERVAL_US 60000000ULL

typedef struct _VIDEO_RECV_FIGURES {
    uint64_t packets;           // receives that returned a packet
    uint64_t bytes;             // their bytes as received
    uint64_t socketCalls;       // the poll() and recvfrom() calls of the receives
    uint64_t checked;           // packets whose waiting is known: the sampled ones, or all on a socket that never waits
    uint64_t checkedWaiting;    // of them, those that were waiting when the thread asked for them
    uint64_t waitingReceives;   // sampled receives of a packet that was waiting
    uint64_t waitingReceiveUs;  // their time, with one clock read
    uint64_t workSamples;       // sampled packets whose other work was timed
    uint64_t workUs;            // that time, with one clock read
    uint64_t clockSamples;      // two clock reads in a row
    uint64_t clockUs;
    uint64_t checkPolls;        // the poll() calls without a timeout of the samples (not in socketCalls)
    uint64_t checkPollUs;       // their time, with one clock read
    uint64_t checkPollFailures; // of them, those that failed
} VIDEO_RECV_FIGURES;

// Moonlight Plus (since 2.3.5): the figures of the processing thread for its lines, one writer, no atomics
typedef struct _VIDEO_PROC_FIGURES {
    uint64_t packets;  // packets taken from the ring (every packet that the reader read)
    uint64_t bytes;    // their bytes as received
    uint64_t idleUs;   // the time spent looking for packets and waiting for them, from the first packet on
    uint64_t lookUs;   // of it, the time spent looking again for packets before a wait (the thread is on the CPU)
} VIDEO_PROC_FIGURES;

// We can't request an IDR frame until the depacketizer knows
// that a packet was lost. This timeout bounds the time that
// the RTP queue will wait for missing/reordered packets.
#define RTP_QUEUE_DELAY 10

// This is the desired number of video packets that can be
// stored in the socket's receive buffer. 2048 is chosen
// because it should be large enough for all reasonable
// frame sizes (probably 2 or 3 frames) without using too
// much kernel memory with larger packet sizes. It also
// can smooth over transient pauses in network traffic
// and subsequent packet/frame bursts that follow.
#define RTP_RECV_PACKETS_BUFFERED 2048

// Moonlight Plus (since 2.3.5): the packets that the ring between the reader and the processing thread of the video
// holds (VideoReceiveRing.h), a power of two: about 4 frames of 4K at 60 FPS and 150 Mbps. A test may set it before it
// includes this file.
#ifndef VIDEO_RECV_RING_PACKETS
#define VIDEO_RECV_RING_PACKETS 1024
#endif

// Initialize the video stream
void initializeVideoStream(void) {
    initializeVideoDepacketizer(StreamConfig.packetSize);
    RtpvInitializeQueue(&rtpQueue);
    decryptionCtx = PltCreateCryptoContext();
    receivedDataFromPeer = false;
    firstDataTimeMs = 0;
    receivedFullFrame = false;
    rtpReceiveBufferSize = 0;
    rtpSocketNoWait = false;
    // (so that VrrDestroy() leaves a ring alone that startVideoStream() never made)
    memset(&receiveRing, 0, sizeof(receiveRing));
}

// Clean up the video stream
void destroyVideoStream(void) {
    PltDestroyCryptoContext(decryptionCtx);
    destroyVideoDepacketizer();
    RtpvCleanupQueue(&rtpQueue);
}

// UDP Ping proc
static void VideoPingThreadProc(void* context) {
    char legacyPingData[] = { 0x50, 0x49, 0x4E, 0x47 };
    LC_SOCKADDR saddr;

    LC_ASSERT(VideoPortNumber != 0);

    memcpy(&saddr, &RemoteAddr, sizeof(saddr));
    SET_PORT(&saddr, VideoPortNumber);

    // We do not check for errors here. Socket errors will be handled
    // on the read-side in ReceiveThreadProc(). This avoids potential
    // issues related to receiving ICMP port unreachable messages due
    // to sending a packet prior to the host PC binding to that port.
    int pingCount = 0;
    while (!PltIsThreadInterrupted(&udpPingThread)) {
        if (VideoPingPayload.payload[0] != 0) {
            pingCount++;
            VideoPingPayload.sequenceNumber = BE32(pingCount);

            sendto(rtpSocket, (char*)&VideoPingPayload, sizeof(VideoPingPayload), 0, (struct sockaddr*)&saddr, AddrLen);
        }
        else {
            sendto(rtpSocket, legacyPingData, sizeof(legacyPingData), 0, (struct sockaddr*)&saddr, AddrLen);
        }

        PltSleepMsInterruptible(&udpPingThread, 500);
    }
}

// Moonlight Plus (since 2.3.4): the first line of the receive thread, which names how it reads the socket
static void logVideoReceiveMode(int receiveMode) {
    switch (receiveMode) {
    case VIDEO_RECV_MODE_POLL:
        Limelog("Video receive mode: no receive timeout, poll() before each recvfrom(); back-to-back reads off (no socket that never waits)\n");
        break;
    case VIDEO_RECV_MODE_NO_WAIT:
        Limelog("Video receive mode: no receive timeout, socket that never waits; back-to-back reads on (poll() only when no packet is waiting)\n");
        break;
    default:
        Limelog("Video receive mode: one recvfrom() per packet with a receive timeout of %d ms; back-to-back reads off (not needed)\n",
                UDP_RECV_POLL_TIMEOUT_MS);
        break;
    }
}

// Moonlight Plus (since 2.3.4): the bytes that a video packet carries on the network besides what the socket gives,
// its IP and UDP header, for the rates of the lines at IP level like 'Frames arrive at' (RtpVideoQueue.c)
static unsigned int videoReceiveOverheadBytes(void) {
    unsigned int overheadBytes;

#ifdef AF_INET6
    overheadBytes = (RemoteAddr.ss_family == AF_INET6 ? 40 : 20) + 8;
#else
    overheadBytes = 20 + 8;
#endif
    return overheadBytes;
}

// Moonlight Plus (since 2.3.4): the average of a time of the samples in microseconds, without the clock read that it
// contains, as text with one decimal ("n/a" without a sample, *valueUs then -1)
static void formatVideoReceiveTime(char* text, size_t size, uint64_t totalUs, uint64_t samples, double clockUs, double* valueUs) {
    double value;

    if (samples == 0) {
        snprintf(text, size, "n/a");
        *valueUs = -1;
        return;
    }

    value = (double)totalUs / (double)samples - clockUs;
    if (value < 0) {
        value = 0;
    }
    else if (value > 99999.9) {
        value = 99999.9;
    }
    *valueUs = value;
    snprintf(text, size, "%.1f", value);
}

// Moonlight Plus (since 2.3.4): the line of a minute (the figures since before) or of the whole stream (before NULL),
// which in timeout and poll mode ends with the line of the poll() calls without a timeout of its samples
static void logVideoReceiveFigures(const VIDEO_RECV_FIGURES* now, const VIDEO_RECV_FIGURES* before, uint64_t elapsedUs, bool wholeStream) {
    VIDEO_RECV_FIGURES d;
    char waiting[16];
    char readTime[16];
    char workTime[16];
    char capacity[16];
    char clockText[16];
    char pollTime[16];
    double callsEach;
    double clockUs;
    double readUs;
    double workUs;
    double pollUs;
    unsigned int seconds;

    d = *now;
    if (before != NULL) {
        d.packets -= before->packets;
        d.bytes -= before->bytes;
        d.socketCalls -= before->socketCalls;
        d.checked -= before->checked;
        d.checkedWaiting -= before->checkedWaiting;
        d.waitingReceives -= before->waitingReceives;
        d.waitingReceiveUs -= before->waitingReceiveUs;
        d.workSamples -= before->workSamples;
        d.workUs -= before->workUs;
        d.clockSamples -= before->clockSamples;
        d.clockUs -= before->clockUs;
        d.checkPolls -= before->checkPolls;
        d.checkPollUs -= before->checkPollUs;
        d.checkPollFailures -= before->checkPollFailures;
    }

    if (elapsedUs == 0) {
        elapsedUs = 1;
    }
    seconds = (unsigned int)((elapsedUs + 500000) / 1000000);
    if (seconds == 0) {
        seconds = 1;
    }

    callsEach = d.packets > 0 ? (double)d.socketCalls / (double)d.packets : 0;
    if (callsEach > 999.99) {
        callsEach = 999.99;
    }

    if (d.checked > 0) {
        snprintf(waiting, sizeof(waiting), "%u", (unsigned int)((d.checkedWaiting * 100 + d.checked / 2) / d.checked));
    }
    else {
        snprintf(waiting, sizeof(waiting), "n/a");
    }

    if (d.clockSamples > 0) {
        clockUs = (double)d.clockUs / (double)d.clockSamples;
        if (clockUs > 99999.9) {
            clockUs = 99999.9;
        }
        snprintf(clockText, sizeof(clockText), "%.1f", clockUs);
    }
    else {
        clockUs = 0;
        snprintf(clockText, sizeof(clockText), "n/a");
    }

    formatVideoReceiveTime(readTime, sizeof(readTime), d.waitingReceiveUs, d.waitingReceives, clockUs, &readUs);
    formatVideoReceiveTime(workTime, sizeof(workTime), d.workUs, d.workSamples, clockUs, &workUs);

    // The rate at which the thread could take packets that are waiting, at IP level like 'Frames arrive at'
    // (RtpVideoQueue.c): the bits of an average packet with its IP and UDP header per microsecond. Since 2.3.5 the
    // thread reads the clock once per packet to note when it read it, which a sampled packet takes from the clock read
    // of its sample, so that its other work lacks it: the time of one clock read is added.
    if (readUs >= 0 && workUs >= 0 && readUs + workUs + clockUs > 0 && d.packets > 0) {
        double mbps = ((double)d.bytes / (double)d.packets + videoReceiveOverheadBytes()) * 8 /
            (readUs + workUs + clockUs);
        if (mbps > 99999) {
            mbps = 99999;
        }
        snprintf(capacity, sizeof(capacity), "%u", (unsigned int)(mbps + 0.5));
    }
    else {
        snprintf(capacity, sizeof(capacity), "n/a");
    }

    if (wholeStream) {
        Limelog("Video receive of the stream, %u s: %llu packets, %.2f socket calls each, %s%% were waiting; %s us to read a waiting packet, %s us of other work per packet: up to %s Mbps; clock read %s us\n",
                seconds, (unsigned long long)d.packets, callsEach, waiting, readTime, workTime, capacity, clockText);

        // The only socket call that the samples add, and the cost of a poll() on this platform
        if (d.checkPolls > 0) {
            formatVideoReceiveTime(pollTime, sizeof(pollTime), d.checkPollUs, d.checkPolls, clockUs, &pollUs);
            Limelog("Video receive check of the stream: %llu calls of poll() without a timeout, %s us each, %llu failed\n",
                    (unsigned long long)d.checkPolls, pollTime, (unsigned long long)d.checkPollFailures);
        }
    }
    else {
        Limelog("Video receive, last %u s: %llu packets/s, %.2f socket calls each, %s%% were waiting; %s us to read a waiting packet, %s us of other work per packet: up to %s Mbps\n",
                seconds, (unsigned long long)(d.packets * 1000000 / elapsedUs), callsEach, waiting, readTime, workTime, capacity);
    }
}

// Moonlight Plus (since 2.3.4): the receives until the next sample, from VIDEO_RECV_SAMPLE_EVERY - 16 to
// VIDEO_RECV_SAMPLE_EVERY + 15 (on average about every VIDEO_RECV_SAMPLE_EVERY-th receive), from a linear congruential
// generator (the constants of Numerical Recipes), whose top bits are random enough for this and cost one multiplication
static uint32_t nextVideoReceiveSampleGap(uint32_t* state) {
    *state = *state * 1664525u + 1013904223u;
    return VIDEO_RECV_SAMPLE_EVERY - 16 + (*state >> 27);
}

// Moonlight Plus (since 2.3.4): wakes the receive thread before it is joined when it reads a socket that never waits.
// recvUdpSocketNoWait() reads it without a poll() first, so on a platform that took SOCK_NONBLOCK but whose reads of the
// socket still wait, the thread would wait in that read for a packet that never comes once the host stops sending, and
// the join would never return. An empty datagram of the socket to itself ends that read and counts as no packet.
static void wakeVideoReceiveThread(void) {
    if (rtpSocketNoWait) {
        wakeUdpSocketReader(rtpSocket);
    }
}

// Moonlight Plus (since 2.3.4): the line of a minute once VIDEO_RECV_LINE_INTERVAL_US have passed since the last one,
// if a packet of it was sampled (none during a pause of the video); a new minute starts then either way
static void checkVideoReceiveWindow(const VIDEO_RECV_FIGURES* figures, VIDEO_RECV_FIGURES* windowStart, uint64_t* windowStartUs, uint64_t nowUs) {
    if (nowUs - *windowStartUs < VIDEO_RECV_LINE_INTERVAL_US) {
        return;
    }

    if (figures->workSamples > windowStart->workSamples) {
        logVideoReceiveFigures(figures, windowStart, nowUs - *windowStartUs, false);
    }
    *windowStart = *figures;
    *windowStartUs = nowUs;
}

// Receive thread proc. Moonlight Plus (since 2.3.5): it only reads the socket, notes when it read each packet and hands
// the packet to the processing thread (VideoProcessThreadProc()) through the ring, so that it reads the next packet
// while the one before is decrypted, corrected and put into its frame.
static void VideoReceiveThreadProc(void* context) {
    int err;
    int receiveSize;
    bool useSelect;
    int waitingForVideoMs;
    int receiveMode;
    PVIDEO_RECV_SLOT slot;
    VIDEO_RECV_FIGURES figures, windowStart;
    uint32_t receives, nextSampleReceive, sampleState;
    uint64_t streamStartUs, windowStartUs, workStartUs, workWaitedUs;
    bool workSampled;

    // The packet as the socket gives it: the RTP packet, after the header of an encrypted packet with video encryption
    receiveSize = StreamConfig.packetSize + MAX_RTP_HEADER_SIZE +
        ((EncryptionFeaturesEnabled & SS_ENC_VIDEO) ? sizeof(ENC_VIDEO_HEADER) : 0);

    if (rtpSocketNoWait) {
        // Moonlight Plus: startVideoStream() found no receive timeout and gave the video a socket that never waits
        useSelect = false;
        receiveMode = VIDEO_RECV_MODE_NO_WAIT;
    }
    else if (setNonFatalRecvTimeoutMs(rtpSocket, UDP_RECV_POLL_TIMEOUT_MS) < 0) {
        // SO_RCVTIMEO failed, so use select() to wait
        Limelog("Video Receive: SO_RCVTIMEO unsupported, polling before each receive\n");
        useSelect = true;
        receiveMode = VIDEO_RECV_MODE_POLL;
    }
    else {
        // SO_RCVTIMEO timeout set for recv()
        useSelect = false;
        receiveMode = VIDEO_RECV_MODE_TIMEOUT;
    }
    logVideoReceiveMode(receiveMode);

    waitingForVideoMs = 0;
    // Moonlight Plus: the figures of the video receive lines
    memset(&figures, 0, sizeof(figures));
    windowStart = figures;
    receives = 0;
    sampleState = VIDEO_RECV_SAMPLE_SEED;
    nextSampleReceive = nextVideoReceiveSampleGap(&sampleState);
    streamStartUs = 0;
    windowStartUs = 0;
    workStartUs = 0;
    workWaitedUs = 0;
    workSampled = false;
    // Moonlight Plus (since 2.3.5): each packet is received into the buffer of a slot of the ring
    slot = VrrFirstSlot(&receiveRing);
    while (!PltIsThreadInterrupted(&receiveThread)) {
        bool sampled;
        bool waiting;
        bool waitingKnown;
        uint64_t receiveStartUs;
        uint64_t stampUs;

        // Moonlight Plus: the other work since the sampled packet before ends here, and the line of a minute comes. A
        // wait for room in the ring after it is not work of this thread (the lines of the processing thread count it).
        if (workSampled) {
            uint64_t nowUs = PltGetMicroseconds();
            figures.workUs += nowUs - workStartUs - workWaitedUs;
            figures.workSamples++;
            workSampled = false;
            checkVideoReceiveWindow(&figures, &windowStart, &windowStartUs, nowUs);
        }

        // Moonlight Plus: sample about every VIDEO_RECV_SAMPLE_EVERY-th receive
        receives++;
        sampled = receives == nextSampleReceive;
        if (sampled) {
            nextSampleReceive = receives + nextVideoReceiveSampleGap(&sampleState);
        }
        waiting = false;
        // (a socket that never waits tells it with every read)
        waitingKnown = receiveMode == VIDEO_RECV_MODE_NO_WAIT;
        receiveStartUs = 0;
        stampUs = 0;
        if (sampled && receiveMode != VIDEO_RECV_MODE_NO_WAIT) {
            // Whether a packet is waiting: a poll() without a timeout, timed. A failed one leaves it unknown, and only a
            // readable socket counts as a packet waiting, not an error that the socket reports (POLLERR and the like)
            struct pollfd pfd;
            int pollResult;
            int pollError;
            uint64_t pollStartUs = PltGetMicroseconds();

            pfd.fd = rtpSocket;
            pfd.events = POLLIN;
            pfd.revents = 0;
            pollResult = pollSockets(&pfd, 1, 0);
            pollError = pollResult < 0 ? (int)LastSocketError() : 0;
            receiveStartUs = PltGetMicroseconds();
            figures.checkPolls++;
            figures.checkPollUs += receiveStartUs - pollStartUs;
            if (pollResult < 0) {
                if (figures.checkPollFailures++ == 0) {
                    Limelog("Video receive check: poll() without a timeout failed: %d\n", pollError);
                }
            }
            else {
                waitingKnown = true;
                waiting = pollResult > 0 && (pfd.revents & POLLIN) != 0;
            }
        }
        else if (sampled) {
            receiveStartUs = PltGetMicroseconds();
        }

        if (receiveMode == VIDEO_RECV_MODE_NO_WAIT) {
            // Moonlight Plus: the packets that are waiting one after the other, poll() only when none is
            bool waited;
            int socketCalls;

            err = recvUdpSocketNoWait(rtpSocket,
                                      slot->buffer,
                                      receiveSize,
                                      &waited,
                                      &socketCalls);
            figures.socketCalls += socketCalls;
            waiting = !waited;
        }
        else {
            err = recvUdpSocket(rtpSocket,
                                slot->buffer,
                                receiveSize,
                                useSelect,
                                NULL,
                                NULL);
            // Moonlight Plus: poll() and recvfrom() with useSelect (only poll() when it timed out), else one recvfrom()
            figures.socketCalls += (useSelect && err > 0) ? 2 : 1;
        }

        // Moonlight Plus: count the packet, and time the sampled one
        if (err > 0) {
            figures.packets++;
            figures.bytes += (uint64_t)err;
            if (waitingKnown) {
                figures.checked++;
                if (waiting) {
                    figures.checkedWaiting++;
                }
            }
            if (sampled) {
                uint64_t endUs = PltGetMicroseconds();
                uint64_t clockUs = PltGetMicroseconds();
                if (waiting) {
                    figures.waitingReceiveUs += endUs - receiveStartUs;
                    figures.waitingReceives++;
                }
                figures.clockUs += clockUs - endUs;
                figures.clockSamples++;
                workStartUs = clockUs;
                workSampled = true;
                stampUs = endUs;
            }
            else {
                // Moonlight Plus (since 2.3.5): when the reader read the packet, for the frame receive time and the
                // arrival rate
                stampUs = PltGetMicroseconds();
            }
        }

        if (err < 0) {
            Limelog("Video Receive: recvUdpSocket() failed: %d\n", (int)LastSocketError());
            ListenerCallbacks.connectionTerminated(LastSocketFail());
            break;
        }
        else if  (err == 0) {
            // Moonlight Plus: a pause of the video still ends the line of its minute
            if (receivedDataFromPeer) {
                checkVideoReceiveWindow(&figures, &windowStart, &windowStartUs, PltGetMicroseconds());
            }

            if (!receivedDataFromPeer) {
                // If we wait many seconds without ever receiving a video packet,
                // assume something is broken and terminate the connection.
                waitingForVideoMs += UDP_RECV_POLL_TIMEOUT_MS;
                if (waitingForVideoMs >= FIRST_FRAME_TIMEOUT_SEC * 1000) {
                    Limelog("Terminating connection due to lack of video traffic\n");
                    ListenerCallbacks.connectionTerminated(ML_ERROR_NO_VIDEO_TRAFFIC);
                    break;
                }
            }

            // Receive timed out; try again
            continue;
        }

        if (!receivedDataFromPeer) {
            receivedDataFromPeer = true;
            Limelog("Received first video packet after %d ms\n", waitingForVideoMs);

            // Moonlight Plus (since 2.3.5): the time the reader read it, in milliseconds as PltGetMillis() gives it,
            // for the limit for the first frame that the processing thread checks
            firstDataTimeMs = stampUs / 1000;

            // Moonlight Plus: the time of the video receive lines counts from the first packet
            streamStartUs = stampUs;
            windowStartUs = streamStartUs;
        }

        // Moonlight Plus (since 2.3.5): hand the packet to the processing thread, which does the rest (the limit for
        // the first frame, runts, decryption, the RTP queue), and go on with the next slot
        slot = VrrPublish(&receiveRing, err, stampUs, &workWaitedUs);
        if (slot == NULL) {
            // The stream stops, or the processing thread ended
            break;
        }
    }

    // Moonlight Plus (since 2.3.5): the processing thread takes what is left in the ring, then ends
    VrrClose(&receiveRing);

    // Moonlight Plus: the line of the whole stream, once the thread ends (at a stop or after an error)
    if (figures.packets > 0) {
        logVideoReceiveFigures(&figures, NULL, PltGetMicroseconds() - streamStartUs, true);
    }
}

// Moonlight Plus (since 2.3.5): a count for a line, at most 4294967295, so that the line stays within the log
static unsigned int clampedVideoCount(uint64_t value) {
    return value > 4294967295ULL ? 4294967295U : (unsigned int)value;
}

// Moonlight Plus (since 2.3.5): the line of a minute (the figures since before) or of the whole stream (before NULL)
// of the processing thread: its work per packet (the time it didn't look or wait for packets, over the packets), its
// idle share with the part of it that it looked again for packets before it waited (on the CPU, VrrReleaseAndTake()),
// the speed it could take packets at, and the ring: the most packets in it (with those of the batch it works on), the
// times the reader found it full and waited for room and how long, and the times the reader woke this thread
static void logVideoProcessFigures(const VIDEO_PROC_FIGURES* now, const VIDEO_PROC_FIGURES* before,
                                   const VIDEO_RECV_RING_FIGURES* ring, const VIDEO_RECV_RING_FIGURES* ringBefore,
                                   uint64_t elapsedUs, bool wholeStream) {
    VIDEO_PROC_FIGURES d;
    VIDEO_RECV_RING_FIGURES r;
    char workTime[16];
    char idle[16];
    char look[16];
    char capacity[16];
    unsigned int seconds;
    uint64_t busyUs;
    uint64_t idleUs;
    uint64_t lookUs;

    d = *now;
    r = *ring;
    if (before != NULL) {
        d.packets -= before->packets;
        d.bytes -= before->bytes;
        d.idleUs -= before->idleUs;
        d.lookUs -= before->lookUs;
    }
    if (ringBefore != NULL) {
        r.fullWaits -= ringBefore->fullWaits;
        r.fullWaitUs -= ringBefore->fullWaitUs;
        r.wakes -= ringBefore->wakes;
    }

    if (elapsedUs == 0) {
        elapsedUs = 1;
    }
    seconds = (unsigned int)((elapsedUs + 500000) / 1000000);
    if (seconds == 0) {
        seconds = 1;
    }
    idleUs = d.idleUs < elapsedUs ? d.idleUs : elapsedUs;
    lookUs = d.lookUs < idleUs ? d.lookUs : idleUs;
    busyUs = elapsedUs - idleUs;

    if (d.packets > 0) {
        double value = (double)busyUs / (double)d.packets;
        if (value > 99999.9) {
            value = 99999.9;
        }
        snprintf(workTime, sizeof(workTime), "%.1f", value);
    }
    else {
        snprintf(workTime, sizeof(workTime), "n/a");
    }

    snprintf(idle, sizeof(idle), "%u", (unsigned int)((idleUs * 100 + elapsedUs / 2) / elapsedUs));
    snprintf(look, sizeof(look), "%u", (unsigned int)((lookUs * 100 + elapsedUs / 2) / elapsedUs));

    // The rate at which this thread could take packets, at IP level like 'Frames arrive at' (RtpVideoQueue.c): the
    // bits of an average packet with its IP and UDP header per microsecond of its work
    if (d.packets > 0 && busyUs > 0) {
        double mbps = ((double)d.bytes / (double)d.packets + videoReceiveOverheadBytes()) * 8 * (double)d.packets /
            (double)busyUs;
        if (mbps > 99999) {
            mbps = 99999;
        }
        snprintf(capacity, sizeof(capacity), "%u", (unsigned int)(mbps + 0.5));
    }
    else {
        snprintf(capacity, sizeof(capacity), "n/a");
    }

    if (wholeStream) {
        Limelog("Video processing of the stream, %u s: %llu packets, %s us of work each, idle %s%% (looking %s%%): up to %s Mbps; ring up to %u of %u packets, full %u times for %u ms; %u wakes\n",
                seconds, (unsigned long long)d.packets, workTime, idle, look, capacity, r.maxDepth,
                receiveRing.slotCount, clampedVideoCount(r.fullWaits), clampedVideoCount((r.fullWaitUs + 500) / 1000),
                clampedVideoCount(r.wakes));
    }
    else {
        Limelog("Video processing, last %u s: %llu packets/s, %s us of work each, idle %s%% (looking %s%%): up to %s Mbps; ring up to %u of %u packets, full %u times for %u ms; %u wakes\n",
                seconds, (unsigned long long)(d.packets * 1000000 / elapsedUs), workTime, idle, look, capacity,
                r.windowMaxDepth, receiveRing.slotCount, clampedVideoCount(r.fullWaits),
                clampedVideoCount((r.fullWaitUs + 500) / 1000), clampedVideoCount(r.wakes));
    }
}

// Moonlight Plus (since 2.3.5): the processing thread of the video receive. It takes the packets that the reader
// (VideoReceiveThreadProc()) read, in their order, and does what the single receive thread did with them up to 2.3.4:
// the limit for the first frame, runts, the decryption, the byte order and the RTP queue, which corrects errors and
// hands complete frames to the depacketizer. Plain video goes to the RTP queue in the buffer of its slot, which then
// gets a buffer of this thread in its place, so no packet is copied. It ends when the reader ended and the ring is
// empty, or at the stop (VrrStop()), and stops the ring itself when it ends the stream.
static void VideoProcessThreadProc(void* context) {
    int bufferSize, decryptedSize, minSize;
    char* buffer;        // encrypted: the buffer to decrypt into; plain: the buffer for the next slot
    bool encrypted;
    bool stopping;
    bool startWindow;
    uint32_t released, first, taken, i;
    uint64_t idleUs, lookUs, nowUs, streamStartUs, windowStartUs;
    VIDEO_PROC_FIGURES figures, windowStart;
    VIDEO_RECV_RING_FIGURES ringFigures, windowRing;

    encrypted = !!(EncryptionFeaturesEnabled & SS_ENC_VIDEO);
    decryptedSize = StreamConfig.packetSize + MAX_RTP_HEADER_SIZE;
    minSize = sizeof(RTP_PACKET) + (encrypted ? sizeof(ENC_VIDEO_HEADER) : 0);
    bufferSize = decryptedSize + sizeof(RTPV_QUEUE_ENTRY);
    buffer = NULL;
    stopping = false;
    startWindow = false;
    released = 0;
    first = 0;
    streamStartUs = 0;
    windowStartUs = 0;
    memset(&figures, 0, sizeof(figures));
    windowStart = figures;
    memset(&ringFigures, 0, sizeof(ringFigures));
    windowRing = ringFigures;

    while (!stopping) {
        taken = VrrReleaseAndTake(&receiveRing, released, &first, &idleUs, &lookUs, &ringFigures, startWindow);
        released = 0;
        startWindow = false;
        if (streamStartUs != 0) {
            figures.idleUs += idleUs;
            figures.lookUs += lookUs;
        }
        if (taken == 0) {
            break;
        }
        if (streamStartUs == 0) {
            // The figures count from the first packet; the wait for it isn't idle time of the stream
            streamStartUs = PltGetMicroseconds();
            windowStartUs = streamStartUs;
            windowRing = ringFigures;
        }

        for (i = 0; i < taken && !stopping; i++) {
            PVIDEO_RECV_SLOT slot = VrrSlot(&receiveRing, first + i);
            int length = slot->length;
            char* packetBuffer;
            PRTP_PACKET packet;
            int queueStatus;

            figures.packets++;
            figures.bytes += (uint64_t)length;

#ifndef LC_FUZZING
            // The limit for the first frame, by the time the reader read the packet
            if (!receivedFullFrame && slot->receiveTimeUs / 1000 - firstDataTimeMs >= FIRST_FRAME_TIMEOUT_SEC * 1000) {
                Limelog("Terminating connection due to lack of a successful video frame\n");
                ListenerCallbacks.connectionTerminated(ML_ERROR_NO_VIDEO_FRAME);
                stopping = true;
                break;
            }
#endif

            if (length < minSize) {
                // Runt packet
                continue;
            }

            if (buffer == NULL) {
                buffer = (char*)malloc(bufferSize);
                if (buffer == NULL) {
                    Limelog("Video Receive: malloc() failed\n");
                    ListenerCallbacks.connectionTerminated(-1);
                    stopping = true;
                    break;
                }
            }

            // Decrypt the packet into the buffer if encryption is enabled
            if (encrypted) {
                PENC_VIDEO_HEADER encHeader = (PENC_VIDEO_HEADER)slot->buffer;

                // If this frame is below our current frame number, discard it before decryption
                // to save CPU cycles decrypting FEC shards for a frame we already reassembled.
                //
                // Since this is happening _before_ decryption, this packet is not trusted yet.
                // It's imperative that we do not mutate any state based on this packet until
                // after it has been decrypted successfully!
                //
                // It's possible for an attacker to inject a fake packet that has any value of
                // header fields they want, however this provides them no benefit because we will
                // simply drop said packet here (if it's below the current frame number) or it
                // will pass this check and be dropped during decryption (if contents is tampered)
                // or after decryption in the RTP queue (if it's a replay of a previous authentic
                // packet from the host).
                //
                // In short, an attacker spoofing this value via MITM or sending malicious values
                // impersonating the host from off-link doesn't gain them anything. If they have
                // a true MITM, they can DoS our connection by just dropping all our traffic, so
                // tampering with packets to fail this check doesn't accomplish anything they
                // couldn't already do. If they're not on-link, we just throw their malicious
                // traffic away (as mentioned in the paragraph above) and continue accepting
                // legitmate video traffic.
                if (encHeader->frameNumber && LE32(encHeader->frameNumber) < RtpvGetCurrentFrameNumber(&rtpQueue)) {
                    continue;
                }

                if (!PltDecryptMessage(decryptionCtx, ALGORITHM_AES_GCM, 0,
                                       (unsigned char*)StreamConfig.remoteInputAesKey, sizeof(StreamConfig.remoteInputAesKey),
                                       encHeader->iv, sizeof(encHeader->iv),
                                       encHeader->tag, sizeof(encHeader->tag),
                                       ((unsigned char*)(encHeader + 1)), length - sizeof(ENC_VIDEO_HEADER), // The ciphertext is after the header
                                       (unsigned char*)buffer, &length)) {
                    Limelog("Failed to decrypt video packet!\n");
                    continue;
                }
                packetBuffer = buffer;
            }
            else {
                // The buffer of the slot goes to the RTP queue, and this thread's buffer takes its place in the slot
                packetBuffer = slot->buffer;
                slot->buffer = buffer;
            }

            // Convert fields to host byte-order
            packet = (PRTP_PACKET)&packetBuffer[0];
            packet->sequenceNumber = BE16(packet->sequenceNumber);
            packet->timestamp = BE32(packet->timestamp);
            packet->ssrc = BE32(packet->ssrc);

            queueStatus = RtpvAddPacket(&rtpQueue, packet, length, (PRTPV_QUEUE_ENTRY)&packetBuffer[decryptedSize],
                                        slot->receiveTimeUs);

            if (queueStatus == RTPF_RET_QUEUED) {
                // The queue owns the buffer
                buffer = NULL;
            }
            else if (!encrypted) {
                // The buffer of a rejected packet is this thread's now and goes into the next slot
                buffer = packetBuffer;
            }
        }
        released = taken;

        // The line of a minute, if a packet of it was processed
        nowUs = PltGetMicroseconds();
        if (nowUs - windowStartUs >= VIDEO_RECV_LINE_INTERVAL_US) {
            if (figures.packets > windowStart.packets) {
                logVideoProcessFigures(&figures, &windowStart, &ringFigures, &windowRing, nowUs - windowStartUs, false);
            }
            windowStart = figures;
            windowRing = ringFigures;
            windowStartUs = nowUs;
            startWindow = true;
        }
    }

    if (stopping) {
        // The reader mustn't wait for room any more, and ends at its next packet
        VrrStop(&receiveRing);
    }

    // The line of the whole stream, once the thread ends
    if (figures.packets > 0) {
        logVideoProcessFigures(&figures, NULL, &ringFigures, NULL, PltGetMicroseconds() - streamStartUs, true);
    }

    free(buffer);
}

void notifyKeyFrameReceived(void) {
    // Remember that we got a full frame successfully (Moonlight Plus, since 2.3.5: on the processing thread, from the
    // depacketizer, and read only there)
    receivedFullFrame = true;
}

// Decoder thread proc
static void VideoDecoderThreadProc(void* context) {
    while (!PltIsThreadInterrupted(&decoderThread)) {
        VIDEO_FRAME_HANDLE frameHandle;
        PDECODE_UNIT decodeUnit;

        if (!LiWaitForNextVideoFrame(&frameHandle, &decodeUnit)) {
            return;
        }

        LiCompleteVideoFrame(frameHandle, VideoCallbacks.submitDecodeUnit(decodeUnit));
    }
}

// Read the first frame of the video stream
int readFirstFrame(void) {
    // All that matters is that we close this socket.
    // This starts the flow of video on Gen 3 servers.

    closeSocket(firstFrameSocket);
    firstFrameSocket = INVALID_SOCKET;

    return 0;
}

// Terminate the video stream
void stopVideoStream(void) {
    if (!receivedDataFromPeer) {
        Limelog("No video traffic was ever received from the host!\n");
    }

    VideoCallbacks.stop();

    // Wake up client code that may be waiting on the decode unit queue
    stopVideoDepacketizer();
    
    PltInterruptThread(&udpPingThread);
    PltInterruptThread(&receiveThread);
    // Moonlight Plus (since 2.3.5): the ring stops the processing thread (VrrStop() below); this keeps the threads of
    // the platform alike
    PltInterruptThread(&processThread);
    if ((VideoCallbacks.capabilities & (CAPABILITY_DIRECT_SUBMIT | CAPABILITY_PULL_RENDERER)) == 0) {
        PltInterruptThread(&decoderThread);
    }

    if (firstFrameSocket != INVALID_SOCKET) {
        shutdownTcpSocket(firstFrameSocket);
    }

    // Moonlight Plus (since 2.3.5): neither thread of the video receive waits for the other any more
    VrrStop(&receiveRing);
    // Moonlight Plus: a receive thread in a read of a socket that never waits
    wakeVideoReceiveThread();

    PltJoinThread(&udpPingThread);
    PltJoinThread(&receiveThread);
    PltJoinThread(&processThread);
    if ((VideoCallbacks.capabilities & (CAPABILITY_DIRECT_SUBMIT | CAPABILITY_PULL_RENDERER)) == 0) {
        PltJoinThread(&decoderThread);
    }
    
    if (firstFrameSocket != INVALID_SOCKET) {
        closeSocket(firstFrameSocket);
        firstFrameSocket = INVALID_SOCKET;
    }
    if (rtpSocket != INVALID_SOCKET) {
        closeSocket(rtpSocket);
        rtpSocket = INVALID_SOCKET;
    }
    VrrDestroy(&receiveRing);

    VideoCallbacks.cleanup();
}

// Start the video stream
int startVideoStream(void* rendererContext, int drFlags) {
    int err;

    firstFrameSocket = INVALID_SOCKET;

    // This must be called before the decoder thread starts submitting
    // decode units
    LC_ASSERT(NegotiatedVideoFormat != 0);
    err = VideoCallbacks.setup(NegotiatedVideoFormat, StreamConfig.width,
        StreamConfig.height, StreamConfig.fps, rendererContext, drFlags);
    if (err != 0) {
        return err;
    }

    rtpSocket = bindUdpSocket(RemoteAddr.ss_family, &LocalAddr, AddrLen,
                              RTP_RECV_PACKETS_BUFFERED * (StreamConfig.packetSize + MAX_RTP_HEADER_SIZE),
                              SOCK_QOS_TYPE_VIDEO);
    if (rtpSocket == INVALID_SOCKET) {
        VideoCallbacks.cleanup();
        return LastSocketError();
    }

    // Moonlight Plus (since 2.3.4): a video socket that takes no receive timeout would make the receive thread poll()
    // before every packet (VideoReceiveThreadProc()). A socket whose receive calls never wait lets it read the packets
    // that are waiting one after the other and poll() only when none is, so it replaces this one now, before any thread
    // uses it. Where the platform can't create one, the receive thread polls before each packet as before.
    rtpSocketNoWait = false;
    if (setNonFatalRecvTimeoutMs(rtpSocket, UDP_RECV_POLL_TIMEOUT_MS) < 0) {
        SOCKET noWaitSocket = bindUdpSocketNoWait(RemoteAddr.ss_family, &LocalAddr, AddrLen,
                                                  RTP_RECV_PACKETS_BUFFERED * (StreamConfig.packetSize + MAX_RTP_HEADER_SIZE),
                                                  SOCK_QOS_TYPE_VIDEO);
        if (noWaitSocket != INVALID_SOCKET) {
            closeSocket(rtpSocket);
            rtpSocket = noWaitSocket;
            rtpSocketNoWait = true;
        }
    }

    // Remember the receive buffer size that the OS reports, which may be clamped below the request
    {
        int reportedSize = 0;
        SOCKADDR_LEN len = sizeof(reportedSize);
        if (getsockopt(rtpSocket, SOL_SOCKET, SO_RCVBUF, (char*)&reportedSize, &len) == 0 && reportedSize > 0) {
            rtpReceiveBufferSize = reportedSize;
        }
    }

    // Moonlight Plus (since 2.3.5): the ring between the reader and the processing thread, whose slots hold a packet
    // as the socket gives it: with the queue entry of the RTP queue behind it (plain video, whose buffer goes to the
    // queue), or with the header of an encrypted packet
    {
        int slotSize = StreamConfig.packetSize + MAX_RTP_HEADER_SIZE +
            ((EncryptionFeaturesEnabled & SS_ENC_VIDEO) ? (int)sizeof(ENC_VIDEO_HEADER) : (int)sizeof(RTPV_QUEUE_ENTRY));
        if (VrrInitialize(&receiveRing, VIDEO_RECV_RING_PACKETS, slotSize) != 0) {
            Limelog("Video Receive: malloc() failed\n");
            closeSocket(rtpSocket);
            VideoCallbacks.cleanup();
            return -1;
        }
    }

    VideoCallbacks.start();

    // Moonlight Plus (since 2.3.5): the processing thread first, so that the start can still fail without a reader to
    // stop
    err = PltCreateThread("VideoProc", VideoProcessThreadProc, NULL, &processThread);
    if (err != 0) {
        VideoCallbacks.stop();
        closeSocket(rtpSocket);
        VrrDestroy(&receiveRing);
        VideoCallbacks.cleanup();
        return err;
    }

    err = PltCreateThread("VideoRecv", VideoReceiveThreadProc, NULL, &receiveThread);
    if (err != 0) {
        VideoCallbacks.stop();
        VrrStop(&receiveRing);
        PltJoinThread(&processThread);
        closeSocket(rtpSocket);
        VrrDestroy(&receiveRing);
        VideoCallbacks.cleanup();
        return err;
    }

    if ((VideoCallbacks.capabilities & (CAPABILITY_DIRECT_SUBMIT | CAPABILITY_PULL_RENDERER)) == 0) {
        err = PltCreateThread("VideoDec", VideoDecoderThreadProc, NULL, &decoderThread);
        if (err != 0) {
            VideoCallbacks.stop();
            PltInterruptThread(&receiveThread);
            VrrStop(&receiveRing);
            wakeVideoReceiveThread();
            PltJoinThread(&receiveThread);
            PltJoinThread(&processThread);
            closeSocket(rtpSocket);
            VrrDestroy(&receiveRing);
            VideoCallbacks.cleanup();
            return err;
        }
    }

    if (AppVersionQuad[0] == 3) {
        // Connect this socket to open port 47998 for our ping thread
        firstFrameSocket = connectTcpSocket(&RemoteAddr, AddrLen,
                                            FIRST_FRAME_PORT, FIRST_FRAME_TIMEOUT_SEC);
        if (firstFrameSocket == INVALID_SOCKET) {
            VideoCallbacks.stop();
            stopVideoDepacketizer();
            PltInterruptThread(&receiveThread);
            if ((VideoCallbacks.capabilities & (CAPABILITY_DIRECT_SUBMIT | CAPABILITY_PULL_RENDERER)) == 0) {
                PltInterruptThread(&decoderThread);
            }
            VrrStop(&receiveRing);
            wakeVideoReceiveThread();
            PltJoinThread(&receiveThread);
            PltJoinThread(&processThread);
            if ((VideoCallbacks.capabilities & (CAPABILITY_DIRECT_SUBMIT | CAPABILITY_PULL_RENDERER)) == 0) {
                PltJoinThread(&decoderThread);
            }
            closeSocket(rtpSocket);
            VrrDestroy(&receiveRing);
            VideoCallbacks.cleanup();
            return LastSocketError();
        }
    }

    // Start pinging before reading the first frame so GFE knows where
    // to send UDP data
    err = PltCreateThread("VideoPing", VideoPingThreadProc, NULL, &udpPingThread);
    if (err != 0) {
        VideoCallbacks.stop();
        stopVideoDepacketizer();
        PltInterruptThread(&receiveThread);
        if ((VideoCallbacks.capabilities & (CAPABILITY_DIRECT_SUBMIT | CAPABILITY_PULL_RENDERER)) == 0) {
            PltInterruptThread(&decoderThread);
        }
        VrrStop(&receiveRing);
        wakeVideoReceiveThread();
        PltJoinThread(&receiveThread);
        PltJoinThread(&processThread);
        if ((VideoCallbacks.capabilities & (CAPABILITY_DIRECT_SUBMIT | CAPABILITY_PULL_RENDERER)) == 0) {
            PltJoinThread(&decoderThread);
        }
        closeSocket(rtpSocket);
        if (firstFrameSocket != INVALID_SOCKET) {
            closeSocket(firstFrameSocket);
            firstFrameSocket = INVALID_SOCKET;
        }
        VrrDestroy(&receiveRing);
        VideoCallbacks.cleanup();
        return err;
    }

    if (AppVersionQuad[0] == 3) {
        // Read the first frame to start the flow of video
        err = readFirstFrame();
        if (err != 0) {
            stopVideoStream();
            return err;
        }
    }

    return 0;
}

void LiGetVideoNetworkStats(PVIDEO_NETWORK_STATS stats) {
    // The counters have a single writer, the video processing thread (since 2.3.5), so plain reads are enough for the
    // overlay
    stats->fecRecoveredBlocks = rtpQueue.statRecoveredBlocks;
    stats->fecRecoveredPackets = rtpQueue.statRecoveredPackets;
    stats->fecRecoveryFailures = rtpQueue.statRecoveryFailures;
    stats->fecLongestRecoveryMs = rtpQueue.statLongestRecoveryMs;
    stats->fecSlowRecoveries = rtpQueue.statSlowRecoveries;
    stats->fecWorstMissingPackets = rtpQueue.statWorstMissingPackets;
    stats->fecWorstParityPackets = rtpQueue.statWorstParityPackets;
    stats->requestedReceiveBufferSize = RTP_RECV_PACKETS_BUFFERED * (StreamConfig.packetSize + MAX_RTP_HEADER_SIZE);
    stats->reportedReceiveBufferSize = rtpReceiveBufferSize;
}
