// Checks the socket whose receive calls never wait and its reads, which the video stream of moonlight-common-c uses
// since 2.3.4 on a TV whose sockets take no receive timeout (bindUdpSocketNoWait() and recvUdpSocketNoWait() of
// moonlight-common-c/src/PlatformSockets.c, included directly), with real UDP sockets on the loopback interface and
// with the recvfrom() and poll() calls of the file counted (a macro puts a counting wrapper in their place):
//  - bindUdpSocketNoWait() creates the socket with SOCK_NONBLOCK (fcntl() of a socket aborts the module on the TV) and
//    binds it like bindUdpSocket(), with the same lines of its receive buffer and its QoS; bindUdpSocket() still gives
//    a socket whose calls wait.
//  - a packet that is already waiting is read with one recvfrom() and no poll(); only a read that found nothing is
//    followed by a poll() of up to 100 ms (UDP_RECV_POLL_TIMEOUT_MS) and, when the socket became readable, a read; when
//    that read finds nothing either, poll() waits for the rest of the 100 ms, so that a receive that returns 0 always
//    waited that long, also on a socket that keeps waking poll() without a packet.
//  - the errors: an earlier ICMP Port Unreachable (ECONNREFUSED) is skipped as recvUdpSocket() skips it, EINTR and an
//    empty datagram count as nothing waiting, any other error of recvfrom() or of poll() ends the read at once with -1.
//  - wakeUdpSocketReader() ends a read that waits on the socket with an empty datagram to itself, for a platform that
//    took SOCK_NONBLOCK but whose reads still wait (a socket of bindUdpSocket() plays it here), so that the stop of the
//    video can join its receive thread.
// A datagram that the test sends to the socket is read only once the real poll() saw it, since loopback may deliver it
// a little later on a busy machine. The program ends itself after 30 s, so that a read that waits for good (e.g. on a
// socket that SOCK_NONBLOCK didn't reach) fails the run instead of hanging it.

// The socket code of moonlight-common-c needs the GNU extensions of the C library (in6_pktinfo, SOCK_NONBLOCK)
#define _GNU_SOURCE

#include "test_support_c.h"

#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <poll.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// ---- The counted calls ----

static int recvfromCalls;
static int pollCalls;
// The calls in their order: R for recvfrom(), P for poll()
static char callOrder[32];

static void addCall(char call) {
  const size_t length = strlen(callOrder);
  if (length + 1 < sizeof(callOrder)) {
    callOrder[length] = call;
    callOrder[length + 1] = 0;
  }
}
static int lastPollTimeout;
// recvfrom() fails once with this error before it reads (0: it reads), and so does poll()
static int recvfromFailOnce;
static int pollFailOnce;
// poll() answers 1 this many times without looking at the socket (after wakeDelayMs), then sends a datagram to the socket
// before it polls (sendBeforePoll)
static int readableWithoutData;
static int wakeDelayMs;
static bool sendBeforePoll;
static int peerSocket = -1;
static struct sockaddr_in peerAddress;

static ssize_t testRecvfrom(int s, void* buffer, size_t length, int flags, struct sockaddr* address, socklen_t* addressLength) {
  recvfromCalls++;
  addCall('R');
  if (recvfromFailOnce != 0) {
    errno = recvfromFailOnce;
    recvfromFailOnce = 0;
    return -1;
  }
  return recvfrom(s, buffer, length, flags, address, addressLength);
}

static int testPoll(struct pollfd* fds, nfds_t count, int timeout) {
  pollCalls++;
  addCall('P');
  lastPollTimeout = timeout;
  if (pollFailOnce != 0) {
    errno = pollFailOnce;
    pollFailOnce = 0;
    return -1;
  }
  if (readableWithoutData > 0) {
    readableWithoutData--;
    if (wakeDelayMs > 0) {
      poll(NULL, 0, wakeDelayMs);
    }
    fds[0].revents = POLLIN;
    return 1;
  }
  if (sendBeforePoll) {
    sendBeforePoll = false;
    if (sendto(peerSocket, "DATA", 4, 0, (struct sockaddr*)&peerAddress, sizeof(peerAddress)) != 4) {
      return -1;
    }
  }
  return poll(fds, count, timeout);
}

#define recvfrom testRecvfrom
#define poll testPoll
#include "../../moonlight-common-c/src/Platform.c"
#include "../../moonlight-common-c/src/PlatformSockets.c"
#undef recvfrom
#undef poll

// What ENet provides (initializePlatformSockets()); this test doesn't include it
int enet_initialize(void) {
  return 0;
}
void enet_deinitialize(void) {
}

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

static void printLines(void) {
  for (int i = 0; i < lineCount; i++) {
    fprintf(stderr, "#   logged: %s", lines[i]);
  }
}

// ---- The socket ----

static void resetCounts(void) {
  recvfromCalls = 0;
  pollCalls = 0;
  callOrder[0] = 0;
  lastPollTimeout = -2;
  recvfromFailOnce = 0;
  pollFailOnce = 0;
  sendBeforePoll = false;
  readableWithoutData = 0;
  wakeDelayMs = 0;
}

// The address of a socket on the loopback interface, where it sends to itself
static void loopbackAddressOf(SOCKET s, struct sockaddr_in* address) {
  socklen_t length = sizeof(*address);
  CHECK_EQ_INT(getsockname(s, (struct sockaddr*)address, &length), 0);
  address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
}

// A socket from bindUdpSocketNoWait() on the loopback interface, which sends to itself, and the counters at zero
static SOCKET openNoWaitSocket(void) {
  SOCKET s = bindUdpSocketNoWait(AF_INET, NULL, 0, 0, SOCK_QOS_TYPE_BEST_EFFORT);
  CHECK(s != INVALID_SOCKET);
  loopbackAddressOf(s, &peerAddress);
  peerSocket = s;
  resetCounts();
  return s;
}

// A datagram from the socket to itself, read only once it arrived (the real poll(), which the counters don't see)
static void sendToItself(SOCKET s, const char* data, int length) {
  CHECK_EQ_INT(sendto(s, data, (size_t)length, 0, (struct sockaddr*)&peerAddress, sizeof(peerAddress)), length);
  struct pollfd pfd;
  pfd.fd = s;
  pfd.events = POLLIN;
  pfd.revents = 0;
  CHECK_EQ_INT(poll(&pfd, 1, 5000), 1);
}

static void closeNoWaitSocket(SOCKET s) {
  closeSocket(s);
  peerSocket = -1;
}

// ---- The tests ----

static void test_the_socket_never_waits_and_is_bound_like_the_other(void) {
  startCapture();
  SOCKET waiting = bindUdpSocket(AF_INET, NULL, 0, 512 * 1024, SOCK_QOS_TYPE_VIDEO);
  CHECK(waiting != INVALID_SOCKET);
  char before[MAX_LINES][256];
  const int beforeCount = lineCount;
  memcpy(before, lines, sizeof(before));

  startCapture();
  SOCKET noWait = bindUdpSocketNoWait(AF_INET, NULL, 0, 512 * 1024, SOCK_QOS_TYPE_VIDEO);
  CHECK(noWait != INVALID_SOCKET);
  // Created with SOCK_NONBLOCK; the socket of bindUdpSocket() still waits
  CHECK((fcntl(noWait, F_GETFL) & O_NONBLOCK) != 0);
  CHECK((fcntl(waiting, F_GETFL) & O_NONBLOCK) == 0);
  // The same lines: the receive buffer that was selected and granted, then the QoS of the video socket
  CHECK_EQ_INT(lineCount, beforeCount);
  CHECK_EQ_INT(lineCount, 3);
  for (int i = 0; i < lineCount && i < beforeCount; i++) {
    CHECK(strcmp(lines[i], before[i]) == 0);
  }
  CHECK(strncmp(lines[0], "Selected receive buffer size: ", 30) == 0);
  CHECK(strncmp(lines[1], "Actual receive buffer size: ", 28) == 0);
  CHECK(strcmp(lines[2], "Video socket QoS: priority set, IP_TOS 0x00\n") == 0);
  // The priority of the video is set as on the other socket
  int priority = -1;
  socklen_t length = sizeof(priority);
  CHECK_EQ_INT(getsockopt(noWait, SOL_SOCKET, SO_PRIORITY, &priority, &length), 0);
  CHECK_EQ_INT(priority, 5);
  closeSocket(waiting);
  closeSocket(noWait);
  if (test_current_failed) {
    printLines();
  }
}

static void test_waiting_packets_take_one_recvfrom_each_and_no_poll(void) {
  SOCKET s = openNoWaitSocket();
  for (int i = 0; i < 5; i++) {
    sendToItself(s, "DATA", 4);
  }
  for (int i = 0; i < 5; i++) {
    char buffer[16];
    bool waited = true;
    int socketCalls = -1;
    CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 4);
    CHECK(!waited);
    CHECK_EQ_INT(socketCalls, 1);
  }
  CHECK_EQ_INT(recvfromCalls, 5);
  CHECK_EQ_INT(pollCalls, 0);
  CHECK(strcmp(callOrder, "RRRRR") == 0);
  closeNoWaitSocket(s);
}

static void test_nothing_waiting_takes_one_read_then_a_poll_of_100_ms(void) {
  SOCKET s = openNoWaitSocket();
  char buffer[16];
  bool waited = true;
  int socketCalls = -1;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 0);
  CHECK_EQ_INT(socketCalls, 2);
  CHECK(!waited);
  CHECK_EQ_INT(recvfromCalls, 1);
  CHECK_EQ_INT(pollCalls, 1);
  CHECK_EQ_INT(lastPollTimeout, UDP_RECV_POLL_TIMEOUT_MS);
  CHECK_EQ_INT(lastPollTimeout, 100);
  // The read first, then the wait
  CHECK(strcmp(callOrder, "RP") == 0);
  closeNoWaitSocket(s);
}

static void test_a_packet_that_comes_during_the_wait_is_read_after_the_poll(void) {
  SOCKET s = openNoWaitSocket();
  sendBeforePoll = true;
  char buffer[16];
  bool waited = false;
  int socketCalls = -1;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 4);
  CHECK(waited);
  CHECK_EQ_INT(socketCalls, 3);
  CHECK_EQ_INT(recvfromCalls, 2);
  CHECK_EQ_INT(pollCalls, 1);
  CHECK(memcmp(buffer, "DATA", 4) == 0);
  CHECK(strcmp(callOrder, "RPR") == 0);
  closeNoWaitSocket(s);
}

static void test_a_readable_socket_without_a_packet_waits_for_the_rest_of_the_100_ms(void) {
  SOCKET s = openNoWaitSocket();
  // poll() wakes once without a packet: the read finds nothing, and poll() waits for the rest of the 100 ms, after
  // which the receive returns 0 (it waited that long)
  readableWithoutData = 1;
  char buffer[16];
  bool waited = false;
  int socketCalls = -1;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 0);
  CHECK(waited);
  CHECK_EQ_INT(socketCalls, 4);
  CHECK_EQ_INT(recvfromCalls, 2);
  CHECK_EQ_INT(pollCalls, 2);
  CHECK(lastPollTimeout > 0 && lastPollTimeout <= UDP_RECV_POLL_TIMEOUT_MS);
  CHECK(strcmp(callOrder, "RPRP") == 0);

  // A wake 20 ms into the wait leaves at most 80 ms to wait (unless the machine stalled for the whole 100 ms, after which
  // the receive returns 0 without a second poll())
  resetCounts();
  readableWithoutData = 1;
  wakeDelayMs = 20;
  const uint64_t delayedStartMs = PltGetMillis();
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 0);
  CHECK(pollCalls == 2 || PltGetMillis() - delayedStartMs >= UDP_RECV_POLL_TIMEOUT_MS);
  if (pollCalls == 2) {
    CHECK(lastPollTimeout > 0 && lastPollTimeout <= UDP_RECV_POLL_TIMEOUT_MS - 20);
  }

  // Twice in a row
  resetCounts();
  readableWithoutData = 2;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 0);
  CHECK(waited);
  CHECK_EQ_INT(socketCalls, 6);
  CHECK_EQ_INT(pollCalls, 3);
  CHECK(lastPollTimeout > 0 && lastPollTimeout <= UDP_RECV_POLL_TIMEOUT_MS);
  CHECK(strcmp(callOrder, "RPRPRP") == 0);

  // A packet that comes during the wait after such a wake is read
  resetCounts();
  readableWithoutData = 1;
  sendBeforePoll = true;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 4);
  CHECK(waited);
  CHECK_EQ_INT(socketCalls, 5);
  CHECK(memcmp(buffer, "DATA", 4) == 0);
  CHECK(strcmp(callOrder, "RPRPR") == 0);

  // A socket that wakes poll() without a packet again and again: the receive still returns 0 once the 100 ms passed,
  // instead of polling for good (or returning at once each time)
  resetCounts();
  readableWithoutData = 1000000000;
  const uint64_t startMs = PltGetMillis();
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 0);
  const uint64_t tookMs = PltGetMillis() - startMs;
  CHECK(waited);
  CHECK(pollCalls >= 3);
  CHECK_EQ_INT(socketCalls, recvfromCalls + pollCalls);
  // (a lower bound: the receive returns only once the clock that it reads shows the 100 ms)
  CHECK(tookMs >= UDP_RECV_POLL_TIMEOUT_MS);
  readableWithoutData = 0;
  closeNoWaitSocket(s);
}

static void test_a_poll_error_returns_at_once(void) {
  SOCKET s = openNoWaitSocket();
  pollFailOnce = ENOMEM;
  char buffer[16];
  bool waited = true;
  int socketCalls = -1;
  errno = 0;
  // As in the mode that polls before each read, the error ends the stream (LastSocketFail()) instead of being taken for
  // a timeout
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), -1);
  CHECK_EQ_INT(errno, ENOMEM);
  CHECK(!waited);
  CHECK_EQ_INT(socketCalls, 2);
  CHECK_EQ_INT(recvfromCalls, 1);
  CHECK_EQ_INT(pollCalls, 1);
  CHECK(strcmp(callOrder, "RP") == 0);
  closeNoWaitSocket(s);
}

// ---- A read on another thread ----

typedef struct {
  SOCKET s;
  int result;
  bool waited;
  int socketCalls;
  bool done;
} READER;

static pthread_mutex_t readerMutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t readerDone = PTHREAD_COND_INITIALIZER;

static void* readOnce(void* context) {
  READER* reader = (READER*)context;
  char buffer[16];
  bool waited = true;
  int socketCalls = -1;
  const int result = recvUdpSocketNoWait(reader->s, buffer, sizeof(buffer), &waited, &socketCalls);
  pthread_mutex_lock(&readerMutex);
  reader->result = result;
  reader->waited = waited;
  reader->socketCalls = socketCalls;
  reader->done = true;
  pthread_cond_signal(&readerDone);
  pthread_mutex_unlock(&readerMutex);
  return NULL;
}

// Whether the read of the thread ended within the seconds
static bool waitForReader(READER* reader, int seconds) {
  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += seconds;
  pthread_mutex_lock(&readerMutex);
  while (!reader->done) {
    if (pthread_cond_timedwait(&readerDone, &readerMutex, &deadline) != 0) {
      break;
    }
  }
  const bool done = reader->done;
  pthread_mutex_unlock(&readerMutex);
  return done;
}

static void test_an_empty_datagram_to_itself_ends_a_read_that_waits(void) {
  // A socket whose reads wait, as on a platform that took SOCK_NONBLOCK but ignored it: the first read of
  // recvUdpSocketNoWait() waits for a packet, and only the empty datagram of wakeUdpSocketReader() ends it; the receive
  // then counts it as nothing and returns 0 after its poll() (a timeout of 100 ms). The socket is bound to the any
  // address (the datagram goes to the loopback address) and to an address of its own, as the video socket is bound to
  // the address of the TV.
  for (int bound = 0; bound <= 1; bound++) {
    struct sockaddr_storage local;
    memset(&local, 0, sizeof(local));
    struct sockaddr_in* localIpv4 = (struct sockaddr_in*)&local;
    localIpv4->sin_family = AF_INET;
    localIpv4->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    SOCKET s = bindUdpSocket(AF_INET, bound ? &local : NULL, sizeof(struct sockaddr_in), 0, SOCK_QOS_TYPE_BEST_EFFORT);
    CHECK(s != INVALID_SOCKET);
    CHECK((fcntl(s, F_GETFL) & O_NONBLOCK) == 0);
    resetCounts();
    READER reader;
    memset(&reader, 0, sizeof(reader));
    reader.s = s;
    pthread_t thread;
    CHECK_EQ_INT(pthread_create(&thread, NULL, readOnce, &reader), 0);
    // Time for the thread to get into its read (the outcome is the same when the datagram comes first)
    poll(NULL, 0, 50);
    CHECK(!waitForReader(&reader, 0));
    CHECK_EQ_INT(wakeUdpSocketReader(s), 0);
    const bool done = waitForReader(&reader, 5);
    CHECK(done);
    if (!done) {
      // End the read with a packet from another socket, so that the thread can be joined
      struct sockaddr_in address;
      loopbackAddressOf(s, &address);
      int other = socket(AF_INET, SOCK_DGRAM, 0);
      sendto(other, "DATA", 4, 0, (struct sockaddr*)&address, sizeof(address));
      close(other);
    }
    pthread_join(thread, NULL);
    CHECK_EQ_INT(reader.result, 0);
    CHECK(!reader.waited);
    CHECK_EQ_INT(reader.socketCalls, 2);
    CHECK(strcmp(callOrder, "RP") == 0);
    closeSocket(s);
  }
  // A socket that is closed already has no address: nothing is sent, and the caller goes on
  int closed = socket(AF_INET, SOCK_DGRAM, 0);
  CHECK(closed >= 0);
  close(closed);
  CHECK_EQ_INT(wakeUdpSocketReader(closed), SOCKET_ERROR);
}

static void test_an_icmp_error_is_skipped_like_recvUdpSocket_skips_it(void) {
  SOCKET s = openNoWaitSocket();
  sendToItself(s, "DATA", 4);
  recvfromFailOnce = ECONNREFUSED;
  char buffer[16];
  bool waited = true;
  int socketCalls = -1;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 4);
  CHECK(!waited);
  CHECK_EQ_INT(socketCalls, 2);
  CHECK_EQ_INT(recvfromCalls, 2);
  CHECK_EQ_INT(pollCalls, 0);
  CHECK(strcmp(callOrder, "RR") == 0);
  closeNoWaitSocket(s);
}

static void test_another_error_returns_at_once(void) {
  SOCKET s = openNoWaitSocket();
  sendToItself(s, "DATA", 4);
  recvfromFailOnce = EBADF;
  char buffer[16];
  bool waited = true;
  int socketCalls = -1;
  errno = 0;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), -1);
  CHECK_EQ_INT(errno, EBADF);
  CHECK_EQ_INT(socketCalls, 1);
  CHECK_EQ_INT(recvfromCalls, 1);
  CHECK_EQ_INT(pollCalls, 0);
  CHECK(strcmp(callOrder, "R") == 0);
  closeNoWaitSocket(s);
}

static void test_an_empty_datagram_counts_as_nothing_waiting(void) {
  SOCKET s = openNoWaitSocket();
  sendToItself(s, "", 0);
  char buffer[16];
  bool waited = true;
  int socketCalls = -1;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 0);
  CHECK(!waited);
  CHECK_EQ_INT(socketCalls, 2);
  CHECK_EQ_INT(recvfromCalls, 1);
  CHECK_EQ_INT(pollCalls, 1);
  CHECK(strcmp(callOrder, "RP") == 0);
  closeNoWaitSocket(s);
}

static void test_eintr_counts_as_nothing_waiting(void) {
  SOCKET s = openNoWaitSocket();
  recvfromFailOnce = EINTR;
  char buffer[16];
  bool waited = true;
  int socketCalls = -1;
  CHECK_EQ_INT(recvUdpSocketNoWait(s, buffer, sizeof(buffer), &waited, &socketCalls), 0);
  CHECK(!waited);
  CHECK_EQ_INT(socketCalls, 2);
  CHECK_EQ_INT(recvfromCalls, 1);
  CHECK_EQ_INT(pollCalls, 1);
  CHECK(strcmp(callOrder, "RP") == 0);
  closeNoWaitSocket(s);
}

int main(void) {
  // A read that waits for good (a socket that SOCK_NONBLOCK didn't reach) would hang the run: end it instead
  alarm(30);
  RUN_TEST("bindUdpSocketNoWait() makes a socket that never waits, bound and logged like bindUdpSocket()",
           test_the_socket_never_waits_and_is_bound_like_the_other);
  RUN_TEST("packets that are waiting are read with one recvfrom() each, without poll()",
           test_waiting_packets_take_one_recvfrom_each_and_no_poll);
  RUN_TEST("with nothing waiting, one read, then poll() for 100 ms",
           test_nothing_waiting_takes_one_read_then_a_poll_of_100_ms);
  RUN_TEST("a packet that comes during the wait is read after the poll()",
           test_a_packet_that_comes_during_the_wait_is_read_after_the_poll);
  RUN_TEST("a socket that is readable without a packet waits for the rest of the 100 ms, also when it keeps waking",
           test_a_readable_socket_without_a_packet_waits_for_the_rest_of_the_100_ms);
  RUN_TEST("a poll() error returns at once with -1", test_a_poll_error_returns_at_once);
  RUN_TEST("an ICMP error (ECONNREFUSED) is skipped as recvUdpSocket() skips it",
           test_an_icmp_error_is_skipped_like_recvUdpSocket_skips_it);
  RUN_TEST("another error returns at once with -1", test_another_error_returns_at_once);
  RUN_TEST("an empty datagram counts as nothing waiting", test_an_empty_datagram_counts_as_nothing_waiting);
  RUN_TEST("EINTR counts as nothing waiting", test_eintr_counts_as_nothing_waiting);
  RUN_TEST("an empty datagram of the socket to itself ends a read that waits",
           test_an_empty_datagram_to_itself_ends_a_read_that_waits);
  return test_summary();
}
