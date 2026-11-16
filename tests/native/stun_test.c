// Checks how moonlight-common-c reads the answer of a STUN server (LiFindExternalAddressIP4() in
// moonlight-common-c/src/SimpleStun.c, included directly), with which the app learns the external IPv4 address of the
// network (STUN_private() in wasm/main.cpp, updateExternalAddressIP4() in wasm/static/js/utils.js), with the fixes of
// upstream that Moonlight Plus ported by hand in 2.3.1:
//  - 134eee4: only a valid answer ends the wait; an answer that isn't one (an error answer, another transaction, a
//    broken message) is skipped and the request goes on until its timeout. Before, the first datagram ended it.
//  - 7bf16de: an answer must come from the address and port that the request went to (recvUdpSocket() hands over the
//    source address now). Before, any datagram to the port of the request was taken, so another device on the network
//    could set the address that the app stores.
//  - 2e18599: the length of the message must be a multiple of 4 and the datagram must hold all of it.
//  - ee160c9: an attribute is followed by padding to the next multiple of 4 bytes. Before, the parser stepped over the
//    attribute without its padding, so an attribute of odd length before the address (e.g. SOFTWARE) broke the parse.
// A STUN server on the loopback interface answers each request with the datagrams of the test case, from its own socket
// or from another one.

// The socket code of moonlight-common-c needs the GNU extensions of the C library (in6_pktinfo)
#define _GNU_SOURCE

#include "test_support_c.h"

#include "../../moonlight-common-c/src/SimpleStun.c"
#include "../../moonlight-common-c/src/Platform.c"
#include "../../moonlight-common-c/src/PlatformSockets.c"
#include "../../moonlight-common-c/enet/callbacks.c"
#include "../../moonlight-common-c/enet/compress.c"
#include "../../moonlight-common-c/enet/host.c"
#include "../../moonlight-common-c/enet/list.c"
#include "../../moonlight-common-c/enet/packet.c"
#include "../../moonlight-common-c/enet/peer.c"
#include "../../moonlight-common-c/enet/protocol.c"
#include "../../moonlight-common-c/enet/unix.c"

#include <arpa/inet.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// What the other files of moonlight-common-c provide (Connection.c, PlatformCrypto.c); the test never starts a
// connection
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
struct sockaddr_storage RemoteAddr;
SOCKADDR_LEN AddrLen;
volatile bool ConnectionInterrupted;
STREAM_CONFIGURATION StreamConfig;

static unsigned char nextRandomByte;
void PltGenerateRandomData(unsigned char* data, int length) {
  for (int i = 0; i < length; i++) {
    data[i] = nextRandomByte++;
  }
}

// The log lines of the library
static char logLines[4096];
static void logMessage(const char* format, ...) {
  va_list va;
  const size_t used = strlen(logLines);
  va_start(va, format);
  vsnprintf(logLines + used, sizeof(logLines) - used, format, va);
  va_end(va);
}

// ---- The STUN server ----

#define COOKIE 0x2112a442u
#define BINDING_SUCCESS 0x0101
#define BINDING_ERROR 0x0111
#define ATTRIBUTE_XOR_MAPPED_ADDRESS 0x0020
#define ATTRIBUTE_SOFTWARE 0x8022

// One datagram of an answer: its bytes, whether it comes from the other socket, and whether it carries another
// transaction ID than the request (the server copies the one of the request into the others)
typedef struct {
  unsigned char data[256];
  int length;
  bool fromStranger;
  bool otherTransaction;
} DATAGRAM;

static DATAGRAM script[4];
static int scriptLength;
static int serverSocket = -1;
static int strangerSocket = -1;
static unsigned short serverPort;
static pthread_mutex_t serverMutex = PTHREAD_MUTEX_INITIALIZER;
static bool serverStop;
static int requestsServed;

static void put16(unsigned char* p, unsigned int value) {
  p[0] = (unsigned char)(value >> 8);
  p[1] = (unsigned char)value;
}

static void put32(unsigned char* p, uint32_t value) {
  put16(p, value >> 16);
  put16(p + 2, value & 0xFFFF);
}

// Start an answer of the given type: the header of 20 bytes, with the message length set by finishAnswer()
static DATAGRAM* beginAnswer(unsigned int type, bool fromStranger) {
  DATAGRAM* d = &script[scriptLength++];
  memset(d, 0, sizeof(*d));
  put16(d->data, type);
  put32(d->data + 4, COOKIE);
  d->length = 20;
  d->fromStranger = fromStranger;
  return d;
}

// An attribute with its value, padded to 4 bytes as RFC 5389 has it
static void addAttribute(DATAGRAM* d, unsigned int type, const void* value, int length) {
  unsigned char* p = d->data + d->length;
  put16(p, type);
  put16(p + 2, (unsigned int)length);
  memcpy(p + 4, value, (size_t)length);
  d->length += 4 + ((length + 3) & ~3);
}

// The XOR-MAPPED-ADDRESS of an IPv4 address and port
static void addMappedAddress(DATAGRAM* d, const char* address, unsigned short port) {
  unsigned char value[8];
  struct in_addr in;
  CHECK(inet_pton(AF_INET, address, &in) == 1);
  value[0] = 0;
  value[1] = 1;
  put16(value + 2, port ^ (COOKIE >> 16));
  put32(value + 4, ntohl(in.s_addr) ^ COOKIE);
  addAttribute(d, ATTRIBUTE_XOR_MAPPED_ADDRESS, value, sizeof(value));
}

static void finishAnswer(DATAGRAM* d) {
  put16(d->data + 2, (unsigned int)(d->length - 20));
}

// A successful answer with the given address, from the server or from the other socket
static DATAGRAM* addAnswer(const char* address, bool fromStranger) {
  DATAGRAM* d = beginAnswer(BINDING_SUCCESS, fromStranger);
  addMappedAddress(d, address, 50000);
  finishAnswer(d);
  return d;
}

static bool shouldStop(void) {
  pthread_mutex_lock(&serverMutex);
  const bool stop = serverStop;
  pthread_mutex_unlock(&serverMutex);
  return stop;
}

// Answer every request with the datagrams of the script, 20 ms apart, with the transaction ID of the request
static void* serverThreadFunc(void* context) {
  (void)context;
  while (!shouldStop()) {
    struct pollfd pfd = { serverSocket, POLLIN, 0 };
    if (poll(&pfd, 1, 50) <= 0) {
      continue;
    }
    unsigned char request[64];
    struct sockaddr_in client;
    socklen_t clientLength = sizeof(client);
    const ssize_t received = recvfrom(serverSocket, request, sizeof(request), 0, (struct sockaddr*)&client, &clientLength);
    if (received != 20) {
      continue;
    }
    pthread_mutex_lock(&serverMutex);
    requestsServed++;
    pthread_mutex_unlock(&serverMutex);
    for (int i = 0; i < scriptLength; i++) {
      unsigned char answer[256];
      memcpy(answer, script[i].data, (size_t)script[i].length);
      if (script[i].length >= 20) {
        memcpy(answer + 8, request + 8, 12);
        if (script[i].otherTransaction) {
          answer[8] ^= 0x5a;
        }
      }
      sendto(script[i].fromStranger ? strangerSocket : serverSocket, answer, (size_t)script[i].length, 0,
             (struct sockaddr*)&client, clientLength);
      struct timespec delay = { 0, 20 * 1000 * 1000 };
      nanosleep(&delay, NULL);
    }
  }
  return NULL;
}

static int bindLoopback(const char* address) {
  struct sockaddr_in bindAddress;
  const int s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  CHECK(s >= 0);
  memset(&bindAddress, 0, sizeof(bindAddress));
  bindAddress.sin_family = AF_INET;
  CHECK(inet_pton(AF_INET, address, &bindAddress.sin_addr) == 1);
  CHECK(bind(s, (struct sockaddr*)&bindAddress, sizeof(bindAddress)) == 0);
  return s;
}

static void resetScript(void) {
  scriptLength = 0;
  logLines[0] = 0;
}

// Ask the STUN server on the loopback interface, which answers with the script; the stranger sends from strangerAddress
// (another port of the address of the server, or another address)
static int askServer(const char* strangerAddress, unsigned int* wanAddr, double* seconds) {
  pthread_t server;
  struct sockaddr_in serverAddress;
  socklen_t length = sizeof(serverAddress);
  char port[8];
  struct timespec start, end;

  serverSocket = bindLoopback("127.0.0.1");
  strangerSocket = bindLoopback(strangerAddress);
  CHECK(getsockname(serverSocket, (struct sockaddr*)&serverAddress, &length) == 0);
  serverPort = ntohs(serverAddress.sin_port);
  snprintf(port, sizeof(port), "%u", serverPort);
  serverStop = false;
  requestsServed = 0;
  CHECK(pthread_create(&server, NULL, serverThreadFunc, NULL) == 0);

  *wanAddr = 0;
  clock_gettime(CLOCK_MONOTONIC, &start);
  const int err = LiFindExternalAddressIP4("127.0.0.1", serverPort, wanAddr);
  clock_gettime(CLOCK_MONOTONIC, &end);
  *seconds = (double)(end.tv_sec - start.tv_sec) + (double)(end.tv_nsec - start.tv_nsec) / 1e9;

  pthread_mutex_lock(&serverMutex);
  serverStop = true;
  pthread_mutex_unlock(&serverMutex);
  CHECK(pthread_join(server, NULL) == 0);
  close(serverSocket);
  close(strangerSocket);
  return err;
}

static uint32_t addressOf(const char* text) {
  struct in_addr in;
  CHECK(inet_pton(AF_INET, text, &in) == 1);
  return in.s_addr;
}

static void expectAddress(int err, unsigned int wanAddr, const char* expected) {
  if (err != 0 || wanAddr != addressOf(expected)) {
    char text[INET_ADDRSTRLEN] = "";
    inet_ntop(AF_INET, &wanAddr, text, sizeof(text));
    printf("  # error %d, address %s, expected %s; log:\n%s", err, text, expected, logLines);
  }
  CHECK_EQ_INT(err, 0);
  CHECK(wanAddr == addressOf(expected));
}

// ---- The tests ----

static void APlainAnswerGivesTheAddress(void) {
  unsigned int wanAddr;
  double seconds;
  resetScript();
  addAnswer("203.0.113.7", false);
  const int err = askServer("127.0.0.1", &wanAddr, &seconds);
  expectAddress(err, wanAddr, "203.0.113.7");
  CHECK(seconds < 1.0);
}

static void AnAttributeOfOddLengthIsSteppedOverWithItsPadding(void) {
  unsigned int wanAddr;
  double seconds;
  resetScript();
  // SOFTWARE with 5 bytes (3 bytes of padding) before the address, as servers send their name
  DATAGRAM* d = beginAnswer(BINDING_SUCCESS, false);
  addAttribute(d, ATTRIBUTE_SOFTWARE, "STUN1", 5);
  addMappedAddress(d, "203.0.113.7", 50000);
  finishAnswer(d);
  CHECK_EQ_INT(d->length, 20 + 12 + 12);
  const int err = askServer("127.0.0.1", &wanAddr, &seconds);
  expectAddress(err, wanAddr, "203.0.113.7");
}

static void AnAnswerFromAnotherPortIsIgnored(void) {
  unsigned int wanAddr;
  double seconds;
  resetScript();
  // A valid answer to our request from another port of the same address comes first
  addAnswer("198.51.100.66", true);
  addAnswer("203.0.113.7", false);
  const int err = askServer("127.0.0.1", &wanAddr, &seconds);
  expectAddress(err, wanAddr, "203.0.113.7");
  CHECK(strstr(logLines, "STUN message received from unexpected address") != NULL);
  CHECK(seconds < 1.0);
}

static void AnAnswerFromAnotherAddressIsIgnored(void) {
  unsigned int wanAddr;
  double seconds;
  resetScript();
  addAnswer("198.51.100.66", true);
  addAnswer("203.0.113.7", false);
  const int err = askServer("127.0.0.2", &wanAddr, &seconds);
  expectAddress(err, wanAddr, "203.0.113.7");
  CHECK(strstr(logLines, "STUN message received from unexpected address") != NULL);
}

static void ATruncatedAnswerIsIgnored(void) {
  unsigned int wanAddr;
  double seconds;
  resetScript();
  // The message says 12 bytes, the datagram holds 8 of them, and its address is another one
  DATAGRAM* cut = addAnswer("198.51.100.66", false);
  cut->length -= 4;
  // A datagram shorter than the header of a message
  DATAGRAM* runt = addAnswer("198.51.100.66", false);
  runt->length = 10;
  addAnswer("203.0.113.7", false);
  const int err = askServer("127.0.0.1", &wanAddr, &seconds);
  expectAddress(err, wanAddr, "203.0.113.7");
  CHECK(strstr(logLines, "STUN message truncated: expected 32 bytes, got 28") != NULL);
  CHECK(strstr(logLines, "STUN message truncated: 10") != NULL);
}

static void AMessageLengthThatIsNoMultipleOf4IsIgnored(void) {
  unsigned int wanAddr;
  double seconds;
  resetScript();
  DATAGRAM* odd = addAnswer("198.51.100.66", false);
  odd->data[odd->length++] = 0;
  finishAnswer(odd);
  addAnswer("203.0.113.7", false);
  const int err = askServer("127.0.0.1", &wanAddr, &seconds);
  expectAddress(err, wanAddr, "203.0.113.7");
  CHECK(strstr(logLines, "STUN message length is not a multiple of 4") != NULL);
}

static void AnErrorAnswerOrAnotherTransactionDoesNotEndTheWait(void) {
  unsigned int wanAddr;
  double seconds;
  resetScript();
  DATAGRAM* error = beginAnswer(BINDING_ERROR, false);
  finishAnswer(error);
  DATAGRAM* other = addAnswer("198.51.100.66", false);
  other->otherTransaction = true;
  addAnswer("203.0.113.7", false);
  const int err = askServer("127.0.0.1", &wanAddr, &seconds);
  expectAddress(err, wanAddr, "203.0.113.7");
  CHECK(strstr(logLines, "STUN message type mismatch: 111") != NULL);
  CHECK(strstr(logLines, "STUN transaction ID mismatch") != NULL);
}

static void OnlyBrokenAnswersGiveNoAddress(void) {
  unsigned int wanAddr;
  double seconds;
  resetScript();
  DATAGRAM* cut = addAnswer("198.51.100.66", false);
  cut->length -= 4;
  addAnswer("198.51.100.67", true);
  const int err = askServer("127.0.0.1", &wanAddr, &seconds);
  // The request asks again every second and gives up after 3 seconds (less the time of the answers), without an address
  CHECK(err != 0);
  CHECK(wanAddr == 0);
  CHECK(requestsServed >= 2);
  CHECK(seconds >= 2.0);
}

int main(void) {
  ListenerCallbacks.logMessage = logMessage;
  RUN_TEST("a plain STUN answer gives the address", APlainAnswerGivesTheAddress);
  RUN_TEST("an attribute of odd length before the address is stepped over with its padding (upstream ee160c9)",
           AnAttributeOfOddLengthIsSteppedOverWithItsPadding);
  RUN_TEST("an answer from another port of the server is ignored (upstream 7bf16de)", AnAnswerFromAnotherPortIsIgnored);
  RUN_TEST("an answer from another address is ignored (upstream 7bf16de)", AnAnswerFromAnotherAddressIsIgnored);
  RUN_TEST("a truncated answer is ignored (upstream 2e18599)", ATruncatedAnswerIsIgnored);
  RUN_TEST("a message length that is no multiple of 4 is ignored (upstream 2e18599)",
           AMessageLengthThatIsNoMultipleOf4IsIgnored);
  RUN_TEST("an error answer or another transaction doesn't end the wait (upstream 134eee4)",
           AnErrorAnswerOrAnotherTransactionDoesNotEndTheWait);
  RUN_TEST("only broken answers give no address", OnlyBrokenAnswersGiveNoAddress);
  return test_summary();
}
