// Checks the ports that moonlight-common-c (moonlight-common-c/src/ConnectionTester.c) names for a failed connection
// stage and for a termination, as LiStringifyPortFlags() writes them into the messages of wasm/connectionlistener.cpp
// (wasm/connection_ports.hpp): the RTSP handshake needs TCP 48010, UDP 48000 and UDP 48010, the control stream UDP
// 47999, and a stream that received no video UDP 47998 and UDP 48000. The other stages name no ports, so their message
// stays as before. The connectivity test of the file, which opens sockets, isn't used by the app; its socket functions
// are stubs that fail the test if they are called.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/ConnectionTester.c"

#include <stdlib.h>
#include <string.h>

int initializePlatformSockets(void) { abort(); }
void cleanupPlatformSockets(void) { abort(); }
int resolveHostName(const char* host, int family, int tcpTestPort, struct sockaddr_storage* addr, SOCKADDR_LEN* addrLen) {
  (void)host;
  (void)family;
  (void)tcpTestPort;
  (void)addr;
  (void)addrLen;
  abort();
}
SOCKET createSocket(int addressFamily, int socketType, int protocol, bool nonBlocking) {
  (void)addressFamily;
  (void)socketType;
  (void)protocol;
  (void)nonBlocking;
  abort();
}
int pollSockets(struct pollfd* pollFds, int pollFdsCount, int timeoutMs) {
  (void)pollFds;
  (void)pollFdsCount;
  (void)timeoutMs;
  abort();
}
void closeSocket(SOCKET s) {
  (void)s;
  abort();
}
void PltSleepMs(int ms) {
  (void)ms;
  abort();
}

// The size of the buffer in wasm/connectionlistener.cpp (kPortListLength of wasm/connection_ports.hpp)
#define PORT_LIST_LENGTH 128

static char portList[PORT_LIST_LENGTH];

static const char* ports(unsigned int portFlags) {
  memset(portList, 'x', sizeof(portList));
  LiStringifyPortFlags(portFlags, ", ", portList, sizeof(portList));
  return portList;
}

static void test_stage_ports(void) {
  CHECK(strcmp(ports(LiGetPortFlagsFromStage(STAGE_RTSP_HANDSHAKE)), "TCP 48010, UDP 48000, UDP 48010") == 0);
  CHECK(strcmp(ports(LiGetPortFlagsFromStage(STAGE_CONTROL_STREAM_START)), "UDP 47999") == 0);
}

static void test_stages_without_ports(void) {
  for (int stage = STAGE_NONE; stage < STAGE_MAX; stage++) {
    if (stage == STAGE_RTSP_HANDSHAKE || stage == STAGE_CONTROL_STREAM_START) {
      continue;
    }
    CHECK_EQ_INT(LiGetPortFlagsFromStage(stage), 0);
  }
  // No ports give an empty text, which leaves the message of the stage as it was
  CHECK(strcmp(ports(0), "") == 0);
}

static void test_termination_ports(void) {
  CHECK(strcmp(ports(LiGetPortFlagsFromTerminationErrorCode(ML_ERROR_NO_VIDEO_TRAFFIC)), "UDP 47998, UDP 48000") == 0);
  CHECK_EQ_INT(LiGetPortFlagsFromTerminationErrorCode(ML_ERROR_GRACEFUL_TERMINATION), 0);
  CHECK_EQ_INT(LiGetPortFlagsFromTerminationErrorCode(ML_ERROR_NO_VIDEO_FRAME), 0);
  CHECK_EQ_INT(LiGetPortFlagsFromTerminationErrorCode(ML_ERROR_UNEXPECTED_EARLY_TERMINATION), 0);
}

static void test_every_port_fits_the_buffer(void) {
  // Every port that moonlight-common-c knows (VALID_PORT_FLAG_MASK of ConnectionTester.c)
  const char* all = ports(VALID_PORT_FLAG_MASK);
  CHECK(strcmp(all, "TCP 47984, TCP 47989, TCP 48010, UDP 47998, UDP 47999, UDP 48000, UDP 48010") == 0);
  CHECK(strlen(all) < PORT_LIST_LENGTH);
}

int main(void) {
  RUN_TEST("the RTSP handshake and the control stream name their ports", test_stage_ports);
  RUN_TEST("the other stages name no ports", test_stages_without_ports);
  RUN_TEST("a stream without video traffic names the video and audio ports", test_termination_ports);
  RUN_TEST("the list of every port fits the buffer of the message", test_every_port_fits_the_buffer);
  return test_summary();
}
