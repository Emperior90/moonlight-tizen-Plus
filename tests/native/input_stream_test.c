// Checks what the input send thread of moonlight-common-c (moonlight-common-c/src/InputStream.c) puts on the control
// stream, with three upstream commits of moonlight-common-c:
//  - 4a95eb3 ('Send UTF-8 events on the keyboard channel'): a text of LiSendUtf8TextEvent() goes on the keyboard
//    channel, in order with the key presses, instead of a channel of its own that could overtake them or fall behind.
//  - 0405384 ('Pack NV_UNICODE_PACKET densely for Sunshine'): Sunshine gets up to 32 bytes of text per packet, never
//    splitting a code point, and without the pause of at least 50 ms that GameStream needs to type the keys before it.
//    GameStream still gets one code point per packet after that pause, and the last packet of a text now ends the
//    batch of the control stream (moreData) also when its code point has more than one byte.
//  - 448b2c6 ('Latch mouse deltas before sending to prevent starvation'): the thread sends the mouse movement that was
//    pending when it took the packet, and a movement that arrives while it sends waits for a packet of its own, so a
//    mouse that keeps moving can't hold back the packets queued behind it.
//
// The test includes InputStream.c and LinkedBlockingQueue.c and runs the send thread procedure on the test thread
// (inputSendThreadProc() returns once the queue is empty, see PltWaitForConditionVariable() below). The control stream
// of a GFE 3.22 or Sunshine host is encrypted as a whole, so the thread hands it plain packets, which
// sendInputPacketOnControlStream() below records. The host versions come from AppVersionQuad, where Sunshine has a
// negative fourth number.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/InputStream.c"
#include "../../moonlight-common-c/src/LinkedBlockingQueue.c"

#include <stdlib.h>
#include <string.h>

// What the other files of moonlight-common-c provide
int AppVersionQuad[4];
uint32_t SunshineFeatureFlags;
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
struct sockaddr_storage RemoteAddr;
SOCKADDR_LEN AddrLen;

#define MAX_PACKETS 128
#define MAX_PACKET_DATA 64

// A packet that the send thread handed to the control stream
typedef struct {
  uint8_t channelId;
  uint32_t flags;
  bool moreData;
  uint32_t magic;
  int dataLength;  // of the bytes after the magic
  unsigned char data[MAX_PACKET_DATA];
} SENT_PACKET;

static SENT_PACKET sentPackets[MAX_PACKETS];
static int sentPacketCount;
static int sleptMs;
static int flushCalls;
static int terminations;
static uint64_t fakeMillis;
// How many more mouse movements arrive while the send thread sends a mouse packet, like the main thread adds them
static int movesDuringMouseSends;

int sendInputPacketOnControlStream(unsigned char* data, int length, uint8_t channelId, uint32_t flags, bool moreData) {
  uint32_t size;
  uint32_t magic;
  memcpy(&size, data, sizeof(size));
  memcpy(&magic, data + sizeof(size), sizeof(magic));
  CHECK_EQ_INT(length, BE32(size) + sizeof(size));
  if (sentPacketCount < MAX_PACKETS) {
    SENT_PACKET* packet = &sentPackets[sentPacketCount++];
    packet->channelId = channelId;
    packet->flags = flags;
    packet->moreData = moreData;
    packet->magic = LE32(magic);
    packet->dataLength = length - 2 * (int)sizeof(uint32_t);
    memcpy(packet->data, data + 2 * sizeof(uint32_t),
           packet->dataLength < MAX_PACKET_DATA ? packet->dataLength : MAX_PACKET_DATA);
    if (packet->magic == MOUSE_MOVE_REL_MAGIC_GEN5 && movesDuringMouseSends > 0) {
      movesDuringMouseSends--;
      LiSendMouseMoveEvent(1, 0);
    }
  }
  return 0;
}

void flushInputOnControlStream(void) {
  flushCalls++;
}

bool isControlDataInTransit(void) {
  return false;
}

static void connectionTerminated(int errorCode) {
  (void)errorCode;
  terminations++;
}

// The threads: the send thread runs on the test thread (runSendThread()), so the locks have nothing to do
int PltCreateMutex(PLT_MUTEX* mutex) {
  (void)mutex;
  return 0;
}
void PltDeleteMutex(PLT_MUTEX* mutex) {
  (void)mutex;
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
  return 0;
}
void PltDeleteConditionVariable(PLT_COND* cond) {
  (void)cond;
}
void PltSignalConditionVariable(PLT_COND* cond) {
  (void)cond;
}
// The send thread waits for the next packet: the queue is empty, so this run of it is over
void PltWaitForConditionVariable(PLT_COND* cond, PLT_MUTEX* mutex) {
  (void)mutex;
  CHECK(cond == &packetQueue.cond);
  packetQueue.shutdown = true;
}
int PltCreateThread(const char* name, ThreadEntry entry, void* context, PLT_THREAD* thread) {
  (void)name;
  (void)entry;
  (void)context;
  (void)thread;
  return 0;
}
void PltJoinThread(PLT_THREAD* thread) {
  (void)thread;
}
bool PltIsThreadInterrupted(PLT_THREAD* thread) {
  (void)thread;
  return false;
}
void PltSleepMs(int ms) {
  sleptMs += ms;
}
// Each reading is 10 ms later, so the thread never waits to batch mouse packets
uint64_t PltGetMillis(void) {
  fakeMillis += 10;
  return fakeMillis;
}

static PLT_CRYPTO_CONTEXT cryptoContextStub;
PPLT_CRYPTO_CONTEXT PltCreateCryptoContext(void) {
  return &cryptoContextStub;
}
void PltDestroyCryptoContext(PPLT_CRYPTO_CONTEXT ctx) {
  (void)ctx;
}
// Only for the separately encrypted input of hosts before GFE 3.22, which the test doesn't use
bool PltEncryptMessage(PPLT_CRYPTO_CONTEXT ctx, int algorithm, int flags, unsigned char* key, int keyLength,
                       unsigned char* iv, int ivLength, unsigned char* tag, int tagLength, unsigned char* inputData,
                       int inputDataLength, unsigned char* outputData, int* outputDataLength) {
  (void)ctx, (void)algorithm, (void)flags, (void)key, (void)keyLength, (void)iv, (void)ivLength, (void)tag;
  (void)tagLength, (void)inputData, (void)inputDataLength, (void)outputData, (void)outputDataLength;
  CHECK(false);
  return false;
}
// The input socket of hosts before Gen 5, which the test doesn't use either
SOCKET connectTcpSocket(struct sockaddr_storage* dstaddr, SOCKADDR_LEN addrlen, unsigned short port, int timeoutSec) {
  (void)dstaddr, (void)addrlen, (void)port, (void)timeoutSec;
  CHECK(false);
  return INVALID_SOCKET;
}
int enableNoDelay(SOCKET s) {
  (void)s;
  return 0;
}
void shutdownTcpSocket(SOCKET s) {
  (void)s;
}
void closeSocket(SOCKET s) {
  (void)s;
}

// Send everything that is queued now
static void runSendThread(void) {
  inputSendThreadProc(NULL);
  packetQueue.shutdown = false;
}

static void clearRecords(void) {
  sentPacketCount = 0;
  sleptMs = 0;
  flushCalls = 0;
  terminations = 0;
  movesDuringMouseSends = 0;
}

// Start the input stream of a GFE 3.22 or Sunshine host, and send the packet that enables rumble on GFE
static void startStream(bool sunshine) {
  AppVersionQuad[0] = 7;
  AppVersionQuad[1] = 1;
  AppVersionQuad[2] = 431;
  AppVersionQuad[3] = sunshine ? -1 : 0;
  ListenerCallbacks.connectionTerminated = connectionTerminated;
  CHECK_EQ_INT(initializeInputStream(), 0);
  CHECK_EQ_INT(startInputStream(), 0);
  CHECK(encryptedControlStream);
  runSendThread();
  clearRecords();
}

static void stopStream(void) {
  stopInputStream();
  destroyInputStream();
  CHECK_EQ_INT(terminations, 0);
}

static void checkTextPacket(int index, const char* text, bool moreData) {
  CHECK(index < sentPacketCount);
  if (index >= sentPacketCount) {
    return;
  }
  const SENT_PACKET* packet = &sentPackets[index];
  CHECK_EQ_INT(packet->magic, UTF8_TEXT_EVENT_MAGIC);
  CHECK_EQ_INT(packet->channelId, CTRL_CHANNEL_KEYBOARD);
  CHECK_EQ_INT(packet->flags, ENET_PACKET_FLAG_RELIABLE);
  CHECK_EQ_INT(packet->moreData, moreData);
  CHECK_EQ_INT(packet->dataLength, (int)strlen(text));
  CHECK(memcmp(packet->data, text, strlen(text)) == 0);
}

static void sendText(const char* text) {
  CHECK_EQ_INT(LiSendUtf8TextEvent(text, (unsigned int)strlen(text)), 0);
}

static void test_text_goes_on_the_keyboard_channel_in_order_with_keys(void) {
  startStream(true);
  CHECK_EQ_INT(LiSendKeyboardEvent((short)0x8041, KEY_ACTION_DOWN, 0), 0);
  sendText("h");
  CHECK_EQ_INT(LiSendKeyboardEvent((short)0x8041, KEY_ACTION_UP, 0), 0);
  runSendThread();
  CHECK_EQ_INT(sentPacketCount, 3);
  CHECK_EQ_INT(sentPackets[0].magic, KEY_DOWN_EVENT_MAGIC);
  CHECK_EQ_INT(sentPackets[0].channelId, CTRL_CHANNEL_KEYBOARD);
  checkTextPacket(1, "h", false);
  CHECK_EQ_INT(sentPackets[2].magic, KEY_UP_EVENT_MAGIC);
  CHECK_EQ_INT(sentPackets[2].channelId, CTRL_CHANNEL_KEYBOARD);
  stopStream();
}

static void test_sunshine_gets_32_bytes_per_packet_without_a_pause(void) {
  startStream(true);
  // 70 characters: 32 + 32 + 6
  const char* text = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!?#+-=<>";
  CHECK_EQ_INT(strlen(text), 70);
  sendText(text);
  runSendThread();
  CHECK_EQ_INT(sentPacketCount, 3);
  checkTextPacket(0, "0123456789abcdefghijklmnopqrstuv", true);
  checkTextPacket(1, "wxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!?", true);
  checkTextPacket(2, "#+-=<>", false);
  // No wait for the keys before it, which only GameStream needs
  CHECK_EQ_INT(sleptMs, 0);
  CHECK_EQ_INT(flushCalls, 0);
  stopStream();
}

static void test_sunshine_packets_never_split_a_code_point(void) {
  startStream(true);
  // 31 ASCII characters, then the euro sign (3 bytes), which would end at byte 34, so it starts the next packet with an
  // emoji (4 bytes)
  sendText("abcdefghijklmnopqrstuvwxyz01234\xE2\x82\xAC\xF0\x9F\x98\x80");
  runSendThread();
  CHECK_EQ_INT(sentPacketCount, 2);
  checkTextPacket(0, "abcdefghijklmnopqrstuvwxyz01234", true);
  checkTextPacket(1, "\xE2\x82\xAC\xF0\x9F\x98\x80", false);
  stopStream();
}

static void test_gamestream_gets_one_code_point_per_packet_after_a_pause(void) {
  startStream(false);
  sendText("a\xC3\xBC\xE2\x82\xAC\xF0\x9F\x98\x80");
  runSendThread();
  CHECK_EQ_INT(sentPacketCount, 4);
  checkTextPacket(0, "a", true);
  checkTextPacket(1, "\xC3\xBC", true);
  checkTextPacket(2, "\xE2\x82\xAC", true);
  checkTextPacket(3, "\xF0\x9F\x98\x80", false);
  // The last packet ends the batch also when its code point has several bytes, which the code before 0405384 got wrong.
  // The keys before the text went out first, and GameStream got 50 ms to type them.
  CHECK(flushCalls >= 1);
  CHECK(sleptMs >= 50);
  stopStream();
}

static int relativeMouseDeltaX(int index) {
  NV_REL_MOUSE_MOVE_PACKET packet;
  memcpy((unsigned char*)&packet + 2 * sizeof(uint32_t), sentPackets[index].data,
         sizeof(packet) - 2 * sizeof(uint32_t));
  return (short)BE16(packet.deltaX);
}

static void test_a_moving_mouse_does_not_hold_back_the_packets_behind_it(void) {
  startStream(true);
  CHECK_EQ_INT(LiSendMouseMoveEvent(5, 0), 0);
  CHECK_EQ_INT(LiSendKeyboardEvent((short)0x8041, KEY_ACTION_DOWN, 0), 0);
  // The mouse moves on by 1 while each of the next 3 mouse packets is sent
  movesDuringMouseSends = 3;
  runSendThread();
  CHECK_EQ_INT(sentPacketCount, 5);
  if (sentPacketCount == 5) {
    CHECK_EQ_INT(sentPackets[0].magic, MOUSE_MOVE_REL_MAGIC_GEN5);
    CHECK_EQ_INT(relativeMouseDeltaX(0), 5);
    // The key press goes right after the movement that was pending when the thread took its packet
    CHECK_EQ_INT(sentPackets[1].magic, KEY_DOWN_EVENT_MAGIC);
    for (int i = 2; i < 5; i++) {
      CHECK_EQ_INT(sentPackets[i].magic, MOUSE_MOVE_REL_MAGIC_GEN5);
      CHECK_EQ_INT(relativeMouseDeltaX(i), 1);
    }
  }
  CHECK_EQ_INT(movesDuringMouseSends, 0);

  // A movement beyond 16 bits still goes out in as many packets as it takes, the last one without moreData
  clearRecords();
  for (int i = 0; i < 3; i++) {
    CHECK_EQ_INT(LiSendMouseMoveEvent(30000, 0), 0);
  }
  runSendThread();
  CHECK_EQ_INT(sentPacketCount, 3);
  if (sentPacketCount == 3) {
    CHECK_EQ_INT(relativeMouseDeltaX(0), INT16_MAX);
    CHECK_EQ_INT(relativeMouseDeltaX(1), INT16_MAX);
    CHECK_EQ_INT(relativeMouseDeltaX(2), 90000 - 2 * INT16_MAX);
    CHECK(sentPackets[0].moreData && sentPackets[1].moreData && !sentPackets[2].moreData);
  }
  stopStream();
}

int main(void) {
  RUN_TEST("a text goes on the keyboard channel, in order with the key presses (upstream 4a95eb3)",
           test_text_goes_on_the_keyboard_channel_in_order_with_keys);
  RUN_TEST("Sunshine gets up to 32 bytes of text per packet without a pause (upstream 0405384)",
           test_sunshine_gets_32_bytes_per_packet_without_a_pause);
  RUN_TEST("a packet of text for Sunshine never splits a code point (upstream 0405384)",
           test_sunshine_packets_never_split_a_code_point);
  RUN_TEST("GameStream still gets one code point per packet after its pause (upstream 0405384)",
           test_gamestream_gets_one_code_point_per_packet_after_a_pause);
  RUN_TEST("a mouse that keeps moving doesn't hold back the packets queued behind it (upstream 448b2c6)",
           test_a_moving_mouse_does_not_hold_back_the_packets_behind_it);
  return test_summary();
}
