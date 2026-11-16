// Checks the start and the end of the audio stream of moonlight-common-c (moonlight-common-c/src/AudioStream.c,
// included directly) around the audio renderer of the app (wasm/auddec.cpp):
//  - A start that fails because a thread can't be created leaves the audio socket open for destroyAudioStream(), which
//    closes it once (upstream 4aa7ea4, 'Fix double-close of audio socket in error paths'). startAudioStream() closed it
//    there as well before, without marking it closed, so the cleanup of the failed start closed the same descriptor a
//    second time, which by then can belong to another socket or file of the app.
//  - What the audio renderer of the app relies on: a start whose init callback fails (a decoder that can't be created,
//    AudDecInit()) is not followed by a call of its cleanup callback, so the init callback has to leave nothing
//    behind; and the cleanup callback of a stream that ran is called after the receive thread, which decodes the
//    packets, has ended, so it may destroy the decoder.
//  - An audio packet without payload, only an RTP header, plain or decrypting to nothing, is dropped and doesn't reach
//    the decoder of the app (upstream 18922a1, 'Reject audio packets with no payload'). It used to be handed over with
//    a length of 0, which the app takes for a lost packet: it counted it as lost and played a packet of concealment.
//    The placeholder of the queue for a lost packet is still handed over as before (NULL, 0).
//
// The threads, the sockets and the queues are stand-ins: a thread is never run, and a socket is a number whose state
// the test keeps.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/AudioStream.c"

#include <string.h>

// What the other files of moonlight-common-c provide (the listener takes the log lines in the release build, LC_LOG;
// this test sets none)
struct sockaddr_storage RemoteAddr;
struct sockaddr_storage LocalAddr;
SOCKADDR_LEN AddrLen;
int AppVersionQuad[4];
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
AUDIO_RENDERER_CALLBACKS AudioCallbacks;
bool HighQualitySurroundSupported;
bool HighQualitySurroundEnabled;
OPUS_MULTISTREAM_CONFIGURATION NormalQualityOpusConfig;
OPUS_MULTISTREAM_CONFIGURATION HighQualityOpusConfig;
int AudioPacketDuration;
bool AudioEncryptionEnabled;
uint16_t AudioPortNumber;
SS_PING AudioPingPayload;

// ---- The stand-ins ----

// What happened, in order, e.g. "init start create:AudioRecv"
static char events[512];

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

// The audio socket: the descriptor that bindUdpSocket() hands out, whether it is open, how often it was closed, and
// how often a descriptor was closed that was not open (which closes whatever got that number meanwhile)
#define AUDIO_SOCKET 77
static bool socketOpen;
static int closeCalls;
static int closesOfAClosedSocket;

SOCKET bindUdpSocket(int addressFamily, struct sockaddr_storage* localAddr, SOCKADDR_LEN addrLen, int bufferSize,
                     int socketQosType) {
  (void)addressFamily;
  (void)localAddr;
  (void)addrLen;
  (void)bufferSize;
  (void)socketQosType;
  socketOpen = true;
  return AUDIO_SOCKET;
}
void closeSocket(SOCKET s) {
  CHECK_EQ_INT(s, AUDIO_SOCKET);
  closeCalls++;
  if (!socketOpen) {
    closesOfAClosedSocket++;
  }
  socketOpen = false;
  event("close", NULL);
}
int setNonFatalRecvTimeoutMs(SOCKET s, int timeoutMs) {
  (void)s;
  (void)timeoutMs;
  return 0;
}
int recvUdpSocket(SOCKET s, char* buffer, int size, bool useSelect, struct sockaddr_storage* remoteAddr,
                  SOCKADDR_LEN* addrLen) {
  (void)s;
  (void)buffer;
  (void)size;
  (void)useSelect;
  (void)remoteAddr;
  (void)addrLen;
  return 0;
}

// The threads: the one with the given name can't be created, the others are created but never run
static const char* failingThread;
static int failingThreadError;
static const char* threadNames[8];
static PLT_THREAD* threadHandles[8];
static int threadCount;

static const char* nameOf(PLT_THREAD* thread) {
  for (int i = 0; i < threadCount; i++) {
    if (threadHandles[i] == thread) {
      return threadNames[i];
    }
  }
  return "unknown";
}
int PltCreateThread(const char* name, ThreadEntry entry, void* context, PLT_THREAD* thread) {
  (void)entry;
  (void)context;
  if (failingThread != NULL && strcmp(name, failingThread) == 0) {
    event("fail", name);
    return failingThreadError;
  }
  if (threadCount < 8) {
    threadNames[threadCount] = name;
    threadHandles[threadCount] = thread;
    threadCount++;
  }
  event("create", name);
  return 0;
}
void PltInterruptThread(PLT_THREAD* thread) {
  event("interrupt", nameOf(thread));
}
void PltJoinThread(PLT_THREAD* thread) {
  event("join", nameOf(thread));
}
bool PltIsThreadInterrupted(PLT_THREAD* thread) {
  (void)thread;
  return true;
}
void PltSleepMsInterruptible(PLT_THREAD* thread, int ms) {
  (void)thread;
  (void)ms;
}
uint64_t PltGetMillis(void) {
  return 0;
}

// The decryption and the queues, which a stream without packets doesn't use. The decryption fails unless a test asks
// it to succeed: it then hands the data over unchanged, so that a payload of 0 bytes decrypts to nothing.
static PLT_CRYPTO_CONTEXT cryptoContext;
static bool decryptionSucceeds;
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
  if (!decryptionSucceeds) {
    return false;
  }
  memcpy(outputData, inputData, (size_t)inputDataLength);
  *outputDataLength = inputDataLength;
  return true;
}
int LbqInitializeLinkedBlockingQueue(PLINKED_BLOCKING_QUEUE queueHead, int sizeBound) {
  (void)queueHead;
  (void)sizeBound;
  return 0;
}
int LbqOfferQueueItem(PLINKED_BLOCKING_QUEUE queueHead, void* data, PLINKED_BLOCKING_QUEUE_ENTRY entry) {
  (void)queueHead;
  (void)data;
  (void)entry;
  return LBQ_INTERRUPTED;
}
int LbqWaitForQueueElement(PLINKED_BLOCKING_QUEUE queueHead, void** data) {
  (void)queueHead;
  (void)data;
  return LBQ_INTERRUPTED;
}
PLINKED_BLOCKING_QUEUE_ENTRY LbqDestroyLinkedBlockingQueue(PLINKED_BLOCKING_QUEUE queueHead) {
  (void)queueHead;
  return NULL;
}
PLINKED_BLOCKING_QUEUE_ENTRY LbqFlushQueueItems(PLINKED_BLOCKING_QUEUE queueHead) {
  (void)queueHead;
  return NULL;
}
void LbqSignalQueueShutdown(PLINKED_BLOCKING_QUEUE queueHead) {
  (void)queueHead;
}
int LbqGetItemCount(PLINKED_BLOCKING_QUEUE queueHead) {
  (void)queueHead;
  return 0;
}
void RtpaInitializeQueue(PRTP_AUDIO_QUEUE queue) {
  (void)queue;
}
void RtpaCleanupQueue(PRTP_AUDIO_QUEUE queue) {
  (void)queue;
}
int RtpaAddPacket(PRTP_AUDIO_QUEUE queue, PRTP_PACKET packet, uint16_t length) {
  (void)queue;
  (void)packet;
  (void)length;
  return 0;
}
PRTP_PACKET RtpaGetQueuedPacket(PRTP_AUDIO_QUEUE queue, uint16_t customHeaderLength, uint16_t* length) {
  (void)queue;
  (void)customHeaderLength;
  (void)length;
  return NULL;
}

// The audio renderer: its init callback answers the given result, as AudDecInit() of the app does
static int rendererInitResult;
static OPUS_MULTISTREAM_CONFIGURATION rendererConfig;

static int rendererInit(int audioConfiguration, const POPUS_MULTISTREAM_CONFIGURATION opusConfig, void* context,
                        int arFlags) {
  (void)audioConfiguration;
  (void)context;
  (void)arFlags;
  rendererConfig = *opusConfig;
  event("init", NULL);
  return rendererInitResult;
}
static void rendererStart(void) {
  event("start", NULL);
}
static void rendererStop(void) {
  event("stop", NULL);
}
static void rendererCleanup(void) {
  event("cleanup", NULL);
}
// What the decoder of the app got: the number of calls, and the length and the first byte of the last one (-1 for NULL)
static int decodeCalls;
static int lastDecodeLength;
static int lastDecodeFirstByte;
static void rendererDecodeAndPlaySample(char* sampleData, int sampleLength) {
  decodeCalls++;
  lastDecodeLength = sampleLength;
  lastDecodeFirstByte = sampleData != NULL && sampleLength > 0 ? (unsigned char)sampleData[0] : -1;
}

// The connection up to the stage before the audio stream starts: initializeAudioStream() and the audio socket with
// its ping thread, which the RTSP handshake opens (STAGE_AUDIO_STREAM_INIT and STAGE_RTSP_HANDSHAKE of Connection.c)
static void connectUpToTheAudioStart(int capabilities) {
  events[0] = 0;
  socketOpen = false;
  closeCalls = 0;
  closesOfAClosedSocket = 0;
  failingThread = NULL;
  failingThreadError = 0;
  threadCount = 0;
  rendererInitResult = 0;
  memset(&rendererConfig, 0, sizeof(rendererConfig));
  memset(&AudioCallbacks, 0, sizeof(AudioCallbacks));
  AudioCallbacks.init = rendererInit;
  AudioCallbacks.start = rendererStart;
  AudioCallbacks.stop = rendererStop;
  AudioCallbacks.cleanup = rendererCleanup;
  AudioCallbacks.decodeAndPlaySample = rendererDecodeAndPlaySample;
  AudioCallbacks.capabilities = capabilities;
  memset(&StreamConfig, 0, sizeof(StreamConfig));
  StreamConfig.audioConfiguration = AUDIO_CONFIGURATION_71_SURROUND;
  RemoteAddr.ss_family = AF_INET;
  AudioPortNumber = 48000;
  AudioPacketDuration = 10;
  HighQualitySurroundSupported = true;
  HighQualitySurroundEnabled = false;
  // 7.1 in normal quality and in high quality, as parseOpusConfigurations() fills them in
  memset(&NormalQualityOpusConfig, 0, sizeof(NormalQualityOpusConfig));
  NormalQualityOpusConfig.sampleRate = 48000;
  NormalQualityOpusConfig.channelCount = 8;
  NormalQualityOpusConfig.streams = 5;
  NormalQualityOpusConfig.coupledStreams = 3;
  HighQualityOpusConfig = NormalQualityOpusConfig;
  HighQualityOpusConfig.streams = 8;
  HighQualityOpusConfig.coupledStreams = 0;
  CHECK_EQ_INT(initializeAudioStream(), 0);
  CHECK_EQ_INT(notifyAudioPortNegotiationComplete(), 0);
  CHECK(socketOpen);
  CHECK(strcmp(events, "create:AudioPing") == 0);
  events[0] = 0;
}

static void expectEvents(const char* expected) {
  if (strcmp(events, expected) != 0) {
    printf("  # events: %s\n  # expected: %s\n", events, expected);
  }
  CHECK(strcmp(events, expected) == 0);
  events[0] = 0;
}

// ---- The tests ----

static void test_a_receive_thread_that_cannot_be_created_leaves_the_socket_to_the_cleanup(void) {
  // The audio renderer of the app submits on the receive thread (CAPABILITY_DIRECT_SUBMIT)
  connectUpToTheAudioStart(CAPABILITY_DIRECT_SUBMIT);
  failingThread = "AudioRecv";
  failingThreadError = 11;
  const int result = startAudioStream(NULL, 0);
  CHECK_EQ_INT(result, 11);
  // The renderer is stopped and cleaned up, and the socket is not touched
  expectEvents("init start fail:AudioRecv stop cleanup");
  CHECK(socketOpen);
  CHECK_EQ_INT(closeCalls, 0);
  // The cleanup of the failed start (LiStopConnection() for the stage of initializeAudioStream()) closes it, once
  destroyAudioStream();
  expectEvents("interrupt:AudioPing join:AudioPing close");
  CHECK(!socketOpen);
  CHECK_EQ_INT(closeCalls, 1);
  CHECK_EQ_INT(closesOfAClosedSocket, 0);
}

static void test_a_decoder_thread_that_cannot_be_created_leaves_the_socket_to_the_cleanup(void) {
  // A renderer that doesn't submit on the receive thread gets a decoder thread, the second error path of upstream
  // 4aa7ea4
  connectUpToTheAudioStart(0);
  failingThread = "AudioDec";
  failingThreadError = 12;
  const int result = startAudioStream(NULL, 0);
  CHECK_EQ_INT(result, 12);
  expectEvents("init start create:AudioRecv fail:AudioDec stop interrupt:AudioRecv join:AudioRecv cleanup");
  CHECK(socketOpen);
  CHECK_EQ_INT(closeCalls, 0);
  destroyAudioStream();
  CHECK(!socketOpen);
  CHECK_EQ_INT(closeCalls, 1);
  CHECK_EQ_INT(closesOfAClosedSocket, 0);
}

static void test_a_failed_init_of_the_renderer_fails_the_start_without_a_cleanup_call(void) {
  connectUpToTheAudioStart(CAPABILITY_DIRECT_SUBMIT);
  // The error of a decoder that can't be created (OPUS_BAD_ARG)
  rendererInitResult = -1;
  const int result = startAudioStream(NULL, 0);
  CHECK_EQ_INT(result, -1);
  // No thread, and neither stop nor cleanup of the renderer: its init has to leave nothing behind
  expectEvents("init");
  CHECK_EQ_INT(threadCount, 1);
  destroyAudioStream();
  expectEvents("interrupt:AudioPing join:AudioPing close");
  CHECK_EQ_INT(closeCalls, 1);
  CHECK_EQ_INT(closesOfAClosedSocket, 0);
}

static void test_a_stream_that_ran_cleans_the_renderer_up_after_its_receive_thread_ended(void) {
  connectUpToTheAudioStart(CAPABILITY_DIRECT_SUBMIT);
  const int result = startAudioStream(NULL, 0);
  CHECK_EQ_INT(result, 0);
  expectEvents("init start create:AudioRecv");
  // The renderer got the layout of the normal quality with the samples of a 10 ms packet
  CHECK_EQ_INT(rendererConfig.channelCount, 8);
  CHECK_EQ_INT(rendererConfig.streams, 5);
  CHECK_EQ_INT(rendererConfig.coupledStreams, 3);
  CHECK_EQ_INT(rendererConfig.samplesPerFrame, 480);
  stopAudioStream();
  // The cleanup, where the app destroys its decoder, comes after the thread that decodes was joined
  expectEvents("stop interrupt:AudioRecv join:AudioRecv cleanup");
  destroyAudioStream();
  expectEvents("interrupt:AudioPing join:AudioPing close");
  CHECK_EQ_INT(closeCalls, 1);
  CHECK_EQ_INT(closesOfAClosedSocket, 0);
  // A second call finds the socket closed and leaves it alone
  destroyAudioStream();
  CHECK_EQ_INT(closeCalls, 1);
}

// ---- The packets that reach the decoder ----

// A packet of the queue: the RTP header with the given sequence number, then `payloadLength` bytes from 0xF8 on (an
// Opus TOC byte first); `placeholder` makes it the placeholder of the queue for a lost packet (size 0)
static void decode(uint16_t sequenceNumber, int payloadLength, bool placeholder) {
  PQUEUED_AUDIO_PACKET packet = (PQUEUED_AUDIO_PACKET)calloc(1, sizeof(*packet));
  CHECK(packet != NULL);
  if (packet == NULL) {
    return;
  }
  PRTP_PACKET rtp = (PRTP_PACKET)&packet->data[0];
  rtp->packetType = 97;
  rtp->sequenceNumber = sequenceNumber;
  for (int i = 0; i < payloadLength; i++) {
    packet->data[sizeof(*rtp) + i] = (char)(0xF8 + i);
  }
  packet->header.size = placeholder ? 0 : (int)sizeof(*rtp) + payloadLength;
  decodeInputData(packet);
  free(packet);
}

static void startDecoding(bool encrypted) {
  connectUpToTheAudioStart(CAPABILITY_DIRECT_SUBMIT);
  AudioEncryptionEnabled = encrypted;
  decryptionSucceeds = encrypted;
  decodeCalls = 0;
  lastDecodeLength = 0;
  lastDecodeFirstByte = 0;
}

static void stopDecoding(void) {
  AudioEncryptionEnabled = false;
  decryptionSucceeds = false;
  destroyAudioStream();
  events[0] = 0;
}

static void test_a_packet_without_payload_does_not_reach_the_decoder(void) {
  startDecoding(false);
  // A packet with 20 bytes of Opus data is handed over whole
  decode(1, 20, false);
  CHECK_EQ_INT(decodeCalls, 1);
  CHECK_EQ_INT(lastDecodeLength, 20);
  CHECK_EQ_INT(lastDecodeFirstByte, 0xF8);
  // One with only the RTP header is dropped; the old code handed it over with a length of 0
  decode(2, 0, false);
  CHECK_EQ_INT(decodeCalls, 1);
  CHECK_EQ_INT(lastDecodeLength, 20);
  // The next packet goes on as before
  decode(3, 20, false);
  CHECK_EQ_INT(decodeCalls, 2);
  CHECK_EQ_INT(lastDecodeLength, 20);
  stopDecoding();
}

static void test_an_encrypted_packet_that_decrypts_to_nothing_does_not_reach_the_decoder(void) {
  startDecoding(true);
  decode(1, 32, false);
  CHECK_EQ_INT(decodeCalls, 1);
  CHECK_EQ_INT(lastDecodeLength, 32);
  CHECK_EQ_INT(lastDecodeFirstByte, 0xF8);
  decode(2, 0, false);
  CHECK_EQ_INT(decodeCalls, 1);
  // A packet that doesn't decrypt is dropped as before
  decryptionSucceeds = false;
  decode(3, 32, false);
  CHECK_EQ_INT(decodeCalls, 1);
  stopDecoding();
}

static void test_the_placeholder_of_a_lost_packet_still_asks_for_concealment(void) {
  for (int encrypted = 0; encrypted <= 1; encrypted++) {
    startDecoding(encrypted != 0);
    decode(1, 0, true);
    CHECK_EQ_INT(decodeCalls, 1);
    CHECK_EQ_INT(lastDecodeLength, 0);
    CHECK_EQ_INT(lastDecodeFirstByte, -1);
    stopDecoding();
  }
}

int main(void) {
  RUN_TEST("a receive thread that can't be created leaves the audio socket to destroyAudioStream(), which closes it once (upstream 4aa7ea4)",
           test_a_receive_thread_that_cannot_be_created_leaves_the_socket_to_the_cleanup);
  RUN_TEST("a decoder thread that can't be created leaves the audio socket to destroyAudioStream() too (upstream 4aa7ea4)",
           test_a_decoder_thread_that_cannot_be_created_leaves_the_socket_to_the_cleanup);
  RUN_TEST("a failed init of the audio renderer fails the start without a call of its cleanup",
           test_a_failed_init_of_the_renderer_fails_the_start_without_a_cleanup_call);
  RUN_TEST("the renderer of a stream that ran is cleaned up after its receive thread ended",
           test_a_stream_that_ran_cleans_the_renderer_up_after_its_receive_thread_ended);
  RUN_TEST("an audio packet without payload doesn't reach the decoder (upstream 18922a1)",
           test_a_packet_without_payload_does_not_reach_the_decoder);
  RUN_TEST("an encrypted audio packet that decrypts to nothing doesn't reach the decoder (upstream 18922a1)",
           test_an_encrypted_packet_that_decrypts_to_nothing_does_not_reach_the_decoder);
  RUN_TEST("the placeholder of a lost audio packet still asks the decoder for concealment",
           test_the_placeholder_of_a_lost_packet_still_asks_for_concealment);
  return test_summary();
}
