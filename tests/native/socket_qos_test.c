// Checks the line about the QoS of each socket of a stream that Moonlight Plus logs since 2.3.2 (logSocketQos() of
// moonlight-common-c/src/PlatformSockets.c, included directly, with the real ENet), so that the diagnostic log of a TV
// tells whether its sockets take the priority and the DSCP marking that moonlight-common-c sets:
//  - bindUdpSocket() logs one line for the socket of the video and of the audio, after the receive buffer size of the
//    socket: whether setSocketQos() set the priority (SO_PRIORITY here, the option that the Linux of the tests and the
//    Emscripten headers of the TV define), and the type of service as the socket reports it (IP_TOS, IPV6_TCLASS for
//    IPv6). The socket of a STUN request, which gets no QoS, logs none.
//  - the control stream logs the type of service of the socket of ENet after ENet set its QoS (Expedited Forwarding
//    with ECT(1), 0xB9), which ENet doesn't report; without the marking it is 0x00.
//  - a priority that failed, a platform without the option and a socket that can't report its type of service give
//    their error instead of a value.
//  - the lines name no address or port, and the socket keeps working as before (the line only reads).

// The socket code of moonlight-common-c needs the GNU extensions of the C library (in6_pktinfo)
#define _GNU_SOURCE

#include "test_support_c.h"

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

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// What the other files of moonlight-common-c provide (Connection.c); the test never starts a connection
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
struct sockaddr_storage RemoteAddr;
SOCKADDR_LEN AddrLen;
volatile bool ConnectionInterrupted;
STREAM_CONFIGURATION StreamConfig;

// The lines that the library logged, as the listener of the app gets them
#define MAX_LINES 16
static char lines[MAX_LINES][256];
static int lineCount;

static void captureLine(const char* format, ...) {
  va_list args;
  va_start(args, format);
  if (lineCount < MAX_LINES) {
    vsnprintf(lines[lineCount], sizeof(lines[lineCount]), format, args);
    lineCount++;
  }
  va_end(args);
}

static void startCapture(void) {
  memset(lines, 0, sizeof(lines));
  lineCount = 0;
  ListenerCallbacks.logMessage = captureLine;
}

// The index of the first line that starts with the text, or -1
static int findLine(const char* start) {
  for (int i = 0; i < lineCount; i++) {
    if (strncmp(lines[i], start, strlen(start)) == 0) {
      return i;
    }
  }
  return -1;
}

static void printLines(void) {
  for (int i = 0; i < lineCount; i++) {
    fprintf(stderr, "#   logged: %s", lines[i]);
  }
}

// A socket of the stream sends and receives as before: a datagram to itself arrives
static void checkLoopback(SOCKET s) {
  struct sockaddr_in self;
  socklen_t length = sizeof(self);
  CHECK_EQ_INT(getsockname(s, (struct sockaddr*)&self, &length), 0);
  self.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  CHECK_EQ_INT(sendto(s, "PING", 4, 0, (struct sockaddr*)&self, sizeof(self)), 4);
  char buffer[8];
  CHECK_EQ_INT(recvUdpSocket(s, buffer, sizeof(buffer), true, NULL, NULL), 4);
}

static void TheVideoSocketLogsItsQosAfterItsReceiveBuffer(void) {
  startCapture();
  SOCKET s = bindUdpSocket(AF_INET, NULL, 0, 512 * 1024, SOCK_QOS_TYPE_VIDEO);
  CHECK(s != INVALID_SOCKET);
  const int actual = findLine("Actual receive buffer size: ");
  const int qos = findLine("Video socket QoS: ");
  CHECK(actual >= 0);
  // Right after the receive buffer, as the last line of the socket
  CHECK_EQ_INT(qos, actual + 1);
  CHECK_EQ_INT(lineCount, qos + 1);
  if (qos >= 0) {
    CHECK(strcmp(lines[qos], "Video socket QoS: priority set, IP_TOS 0x00\n") == 0);
  }
  checkLoopback(s);
  closeSocket(s);
  if (test_current_failed) {
    printLines();
  }
}

static void TheAudioSocketLogsItsQosWithoutAReceiveBuffer(void) {
  startCapture();
  SOCKET s = bindUdpSocket(AF_INET, NULL, 0, 0, SOCK_QOS_TYPE_AUDIO);
  CHECK(s != INVALID_SOCKET);
  // The audio socket keeps the receive buffer of the system, so its QoS is its only line
  CHECK_EQ_INT(lineCount, 1);
  CHECK(strcmp(lines[0], "Audio socket QoS: priority set, IP_TOS 0x00\n") == 0);
  // The priority that setSocketQos() set for the audio is what the socket has
  int priority = -1;
  socklen_t length = sizeof(priority);
  CHECK_EQ_INT(getsockopt(s, SOL_SOCKET, SO_PRIORITY, &priority, &length), 0);
  CHECK_EQ_INT(priority, 6);
  checkLoopback(s);
  closeSocket(s);
  if (test_current_failed) {
    printLines();
  }
}

static void ASocketWithoutQosLogsNoQosLine(void) {
  startCapture();
  // As the STUN request binds its socket
  SOCKET s = bindUdpSocket(AF_INET, NULL, 0, 0, SOCK_QOS_TYPE_BEST_EFFORT);
  CHECK(s != INVALID_SOCKET);
  CHECK_EQ_INT(lineCount, 0);
  closeSocket(s);
  if (test_current_failed) {
    printLines();
  }
}

static void AnIpv6SocketLogsItsTrafficClass(void) {
  SOCKET probe = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
  if (probe < 0) {
    fprintf(stderr, "#   (skipped: no IPv6 on this machine)\n");
    return;
  }
  close(probe);
  startCapture();
  SOCKET s = bindUdpSocket(AF_INET6, NULL, 0, 0, SOCK_QOS_TYPE_VIDEO);
  CHECK(s != INVALID_SOCKET);
  CHECK_EQ_INT(lineCount, 1);
  CHECK(strcmp(lines[0], "Video socket QoS: priority set, IPV6_TCLASS 0x00\n") == 0);
  closeSocket(s);
  if (test_current_failed) {
    printLines();
  }
}

static void TheControlSocketLogsTheMarkingOfEnet(void) {
  ENetSocket s = enet_socket_create(AF_INET, ENET_SOCKET_TYPE_DATAGRAM);
  CHECK(s != ENET_SOCKET_NULL);
  startCapture();
  // As the control stream does before it connects (ControlStream.c)
  enet_socket_set_option(s, ENET_SOCKOPT_QOS, 1);
  logSocketQos(s, AF_INET, "Control", SOCK_QOS_NOT_SET_HERE);
  // and as ENet does when the PC doesn't answer the marked packets (protocol.c)
  enet_socket_set_option(s, ENET_SOCKOPT_QOS, 0);
  logSocketQos(s, AF_INET, "Control", SOCK_QOS_NOT_SET_HERE);
  CHECK_EQ_INT(lineCount, 2);
  CHECK(strcmp(lines[0], "Control socket QoS: IP_TOS 0xB9\n") == 0);
  CHECK(strcmp(lines[1], "Control socket QoS: IP_TOS 0x00\n") == 0);
  enet_socket_destroy(s);
  if (test_current_failed) {
    printLines();
  }
}

static void FailuresGiveTheirErrorInsteadOfAValue(void) {
  SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  CHECK(s >= 0);
  startCapture();
  logSocketQos(s, AF_INET, "Video", ENOPROTOOPT);
  logSocketQos(s, AF_INET, "Audio", SOCK_QOS_NO_OPTION);
  close(s);
  // A socket that can't report its type of service (here a closed one, on the TV a platform without the option)
  logSocketQos(s, AF_INET, "Video", 0);
  logSocketQos(s, AF_INET6, "Audio", SOCK_QOS_NOT_SET_HERE);
  CHECK_EQ_INT(lineCount, 4);
  char expected[4][128];
  snprintf(expected[0], sizeof(expected[0]), "Video socket QoS: priority not set (error %d), IP_TOS 0x00\n", ENOPROTOOPT);
  snprintf(expected[1], sizeof(expected[1]), "Audio socket QoS: no priority option, IP_TOS 0x00\n");
  snprintf(expected[2], sizeof(expected[2]), "Video socket QoS: priority set, IP_TOS unknown (error %d)\n", EBADF);
  snprintf(expected[3], sizeof(expected[3]), "Audio socket QoS: IPV6_TCLASS unknown (error %d)\n", EBADF);
  for (int i = 0; i < 4; i++) {
    CHECK(strcmp(lines[i], expected[i]) == 0);
  }
  if (test_current_failed) {
    printLines();
  }
}

static void TheLinesNameNoAddressOrPort(void) {
  struct sockaddr_storage local;
  memset(&local, 0, sizeof(local));
  struct sockaddr_in* local4 = (struct sockaddr_in*)&local;
  local4->sin_family = AF_INET;
  local4->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  startCapture();
  SOCKET s = bindUdpSocket(AF_INET, &local, sizeof(struct sockaddr_in), 256 * 1024, SOCK_QOS_TYPE_VIDEO);
  CHECK(s != INVALID_SOCKET);
  struct sockaddr_in bound;
  socklen_t length = sizeof(bound);
  CHECK_EQ_INT(getsockname(s, (struct sockaddr*)&bound, &length), 0);
  char port[16];
  snprintf(port, sizeof(port), "%u", (unsigned int)ntohs(bound.sin_port));
  const int qos = findLine("Video socket QoS: ");
  CHECK(qos >= 0);
  if (qos >= 0) {
    CHECK(strstr(lines[qos], "127.0.0.1") == NULL);
    CHECK(strstr(lines[qos], port) == NULL);
    // Only the words, the option and its value in hex
    for (const char* c = lines[qos]; *c != 0; c++) {
      CHECK((*c >= 'A' && *c <= 'Z') || (*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || strchr(" :,_()\n", *c) != NULL);
    }
  }
  closeSocket(s);
  if (test_current_failed) {
    printLines();
  }
}

int main(void) {
  CHECK_EQ_INT(enet_initialize(), 0);
  RUN_TEST("the video socket logs its QoS right after its receive buffer size", TheVideoSocketLogsItsQosAfterItsReceiveBuffer);
  RUN_TEST("the audio socket logs its QoS, without a receive buffer line", TheAudioSocketLogsItsQosWithoutAReceiveBuffer);
  RUN_TEST("a socket without QoS (the STUN request) logs no QoS line", ASocketWithoutQosLogsNoQosLine);
  RUN_TEST("an IPv6 socket logs its traffic class", AnIpv6SocketLogsItsTrafficClass);
  RUN_TEST("the control socket logs the DSCP marking that ENet sets, and its removal", TheControlSocketLogsTheMarkingOfEnet);
  RUN_TEST("a failed priority, no option and a socket that can't report give their error", FailuresGiveTheirErrorInsteadOfAValue);
  RUN_TEST("the QoS line names no address or port", TheLinesNameNoAddressOrPort);
  enet_deinitialize();
  return test_summary();
}
