// Checks two fixes of upstream moonlight-common-c in its platform code (moonlight-common-c/src/Platform.c and
// PlatformSockets.c, included directly), which Moonlight Plus ported by hand in 2.3.1:
//  - a84a69a (PR #172): PltClearEvent() clears the event under the mutex of the event, as PltSetEvent() and
//    PltWaitForEvent() use it. The IDR request thread of the control stream clears idrFrameRequiredEvent while other
//    threads set it (LiRequestIdrFrame()), and the clear without the mutex was a data race. The test holds the mutex on
//    one thread and clears the event on another: the clear waits for the mutex; it returned at once before.
//  - dc09c9f: isInSubnetV6() compares the bits of a prefix from the most significant bit of each byte on. It used to
//    take them from the least significant bit, so isPrivateNetworkAddress(), with which LiStartConnection() decides
//    whether a stream with STREAM_CFG_AUTO (wasm/main.cpp) is local or remote, missed most private IPv6 addresses: a
//    unique local address of fd00::/8 and link-local addresses outside fe80::/16 counted as remote (no QoS tags, 500
//    kbps less bitrate, no high quality surround sound), while fe00::/16, fe40::/16 and 7c00::/8, which are no private
//    ranges, counted as local. The library decides by the range of the address alone, not by the subnet of the TV: a
//    global address counts as remote even in the subnet of the TV, before and after the fix.

// It also checks PltWaitForEventTimeout(), which Moonlight Plus added in 2.3.1 for its limit of the IDR frame requests
// (IdrRequestLimit.h): the wait ends at its timeout without the event, and at once when the event is set before or
// during it.

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

#include <arpa/inet.h>
#include <pthread.h>
#include <string.h>
#include <time.h>

// What the other files of moonlight-common-c provide (Connection.c); the test never starts a connection
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
struct sockaddr_storage RemoteAddr;
SOCKADDR_LEN AddrLen;
volatile bool ConnectionInterrupted;
STREAM_CONFIGURATION StreamConfig;

// ---- a84a69a: PltClearEvent() under the mutex of the event ----

static PLT_EVENT event;
static pthread_mutex_t clearMutex = PTHREAD_MUTEX_INITIALIZER;
static bool clearDone;

static void* clearThreadFunc(void* context) {
  (void)context;
  PltClearEvent(&event);
  pthread_mutex_lock(&clearMutex);
  clearDone = true;
  pthread_mutex_unlock(&clearMutex);
  return NULL;
}

static bool isClearDone(void) {
  pthread_mutex_lock(&clearMutex);
  const bool done = clearDone;
  pthread_mutex_unlock(&clearMutex);
  return done;
}

static void sleepMs(int ms) {
  struct timespec delay = { ms / 1000, (long)(ms % 1000) * 1000 * 1000 };
  nanosleep(&delay, NULL);
}

static void AClearWaitsForTheMutexOfTheEvent(void) {
  pthread_t clearer;
  CHECK_EQ_INT(PltCreateEvent(&event), 0);
  PltSetEvent(&event);
  clearDone = false;

  // Another thread is inside PltSetEvent() or PltWaitForEvent(), which hold the mutex of the event
  PltLockMutex(&event.mutex);
  CHECK(pthread_create(&clearer, NULL, clearThreadFunc, NULL) == 0);
  sleepMs(200);
  // The clear waits for the mutex, and the event is still set meanwhile
  CHECK(!isClearDone());
  CHECK(event.signalled);
  PltUnlockMutex(&event.mutex);

  CHECK(pthread_join(clearer, NULL) == 0);
  CHECK(isClearDone());
  CHECK(!event.signalled);
  PltCloseEvent(&event);
}

static void SetWaitAndClearWorkAsBefore(void) {
  CHECK_EQ_INT(PltCreateEvent(&event), 0);
  CHECK(!event.signalled);
  PltSetEvent(&event);
  // A set event lets the waiter through at once, and stays set until it is cleared
  PltWaitForEvent(&event);
  PltWaitForEvent(&event);
  CHECK(event.signalled);
  PltClearEvent(&event);
  CHECK(!event.signalled);
  PltSetEvent(&event);
  PltWaitForEvent(&event);
  CHECK(event.signalled);
  PltCloseEvent(&event);
}

// ---- PltWaitForEventTimeout() (Moonlight Plus, for the limit of the IDR frame requests in ControlStream.c) ----

static uint64_t elapsedSince(uint64_t startMs) {
  return PltGetMillis() - startMs;
}

static void* setThreadFunc(void* context) {
  (void)context;
  sleepMs(50);
  PltSetEvent(&event);
  return NULL;
}

static void ATimedWaitEndsAtTheTimeoutOrWhenTheEventIsSet(void) {
  pthread_t setter;
  uint64_t start;
  CHECK_EQ_INT(PltCreateEvent(&event), 0);
  // Not set: the wait ends after the timeout, not before, and says so
  start = PltGetMillis();
  CHECK(!PltWaitForEventTimeout(&event, 120));
  CHECK(elapsedSince(start) >= 119);
  CHECK(elapsedSince(start) < 1000);
  // Set before: at once, and the event stays set
  PltSetEvent(&event);
  start = PltGetMillis();
  CHECK(PltWaitForEventTimeout(&event, 5000));
  CHECK(elapsedSince(start) < 100);
  CHECK(event.signalled);
  PltClearEvent(&event);
  // Set by another thread during the wait: the wait ends then, long before its timeout
  CHECK(pthread_create(&setter, NULL, setThreadFunc, NULL) == 0);
  start = PltGetMillis();
  CHECK(PltWaitForEventTimeout(&event, 5000));
  CHECK(elapsedSince(start) >= 40);
  CHECK(elapsedSince(start) < 1000);
  CHECK(pthread_join(setter, NULL) == 0);
  PltClearEvent(&event);
  // A timeout of 0 only looks
  CHECK(!PltWaitForEventTimeout(&event, 0));
  PltSetEvent(&event);
  CHECK(PltWaitForEventTimeout(&event, 0));
  PltCloseEvent(&event);
}

// ---- dc09c9f: private IPv6 addresses ----

static bool isPrivate(const char* text) {
  struct sockaddr_storage address;
  memset(&address, 0, sizeof(address));
  if (strchr(text, ':') != NULL) {
    struct sockaddr_in6* sin6 = (struct sockaddr_in6*)&address;
    sin6->sin6_family = AF_INET6;
    CHECK(inet_pton(AF_INET6, text, &sin6->sin6_addr) == 1);
  }
  else {
    struct sockaddr_in* sin = (struct sockaddr_in*)&address;
    sin->sin_family = AF_INET;
    CHECK(inet_pton(AF_INET, text, &sin->sin_addr) == 1);
  }
  return isPrivateNetworkAddress(&address);
}

static void expectPrivate(const char* text, bool expected) {
  const bool actual = isPrivate(text);
  if (actual != expected) {
    printf("  # %s: %s, expected %s\n", text, actual ? "local" : "remote", expected ? "local" : "remote");
  }
  CHECK(actual == expected);
}

static void LinkLocalAddressesAreLocal(void) {
  // fe80::/10: the addresses that the TV and the PC give themselves (fe80::/64), and the whole range up to febf
  expectPrivate("fe80::1", true);
  expectPrivate("fe80::1c2d:3eff:fe4f:5a6b", true);
  expectPrivate("fe81::1", true);
  expectPrivate("feaa:1::2", true);
  expectPrivate("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true);
  // fec0::/10, the old site-local range
  expectPrivate("fec0::1", true);
  expectPrivate("fef1::1", true);
}

static void UniqueLocalAddressesAreLocal(void) {
  // fc00::/7; routers hand out fd00::/8 (with a random 40-bit prefix)
  expectPrivate("fd00::1", true);
  expectPrivate("fd12:3456:789a:1::10", true);
  expectPrivate("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true);
  expectPrivate("fc00::1", true);
}

static void GlobalAndOtherAddressesAreRemote(void) {
  // Global unicast (2000::/3), also when the PC is in the same /64 as the TV (e.g. 2a02:8108:1234:5600::10 and ::20)
  expectPrivate("2001:db8::1", false);
  expectPrivate("2a02:8108:1234:5600::20", false);
  expectPrivate("2a02:8108:1234:5601::20", false);
  // Just outside the private ranges
  expectPrivate("fbff:ffff::1", false);
  expectPrivate("fe7f:ffff::1", false);
  // Reserved and multicast ranges that the old code took for link-local or unique local
  expectPrivate("fe00::1", false);
  expectPrivate("fe40::1", false);
  expectPrivate("7c00::1", false);
  expectPrivate("ff02::1", false);
  // An IPv4 address mapped into IPv6 is judged by its IPv6 form, before and after the fix
  expectPrivate("::ffff:192.168.1.10", false);
}

static void Ipv4AddressesAreJudgedAsBefore(void) {
  expectPrivate("192.168.1.20", true);
  expectPrivate("10.0.0.5", true);
  expectPrivate("172.16.0.1", true);
  expectPrivate("172.31.255.254", true);
  expectPrivate("169.254.10.20", true);
  expectPrivate("172.32.0.1", false);
  expectPrivate("8.8.8.8", false);
}

int main(void) {
  RUN_TEST("a clear of an event waits for the mutex of the event (upstream a84a69a)", AClearWaitsForTheMutexOfTheEvent);
  RUN_TEST("set, wait and clear of an event work as before", SetWaitAndClearWorkAsBefore);
  RUN_TEST("a timed wait for an event ends at its timeout or when the event is set",
           ATimedWaitEndsAtTheTimeoutOrWhenTheEventIsSet);
  RUN_TEST("link-local IPv6 addresses (fe80::/10, fec0::/10) are local (upstream dc09c9f)", LinkLocalAddressesAreLocal);
  RUN_TEST("unique local IPv6 addresses (fc00::/7, fd00::/8) are local (upstream dc09c9f)", UniqueLocalAddressesAreLocal);
  RUN_TEST("global, reserved and multicast IPv6 addresses are remote (upstream dc09c9f)", GlobalAndOtherAddressesAreRemote);
  RUN_TEST("IPv4 addresses are judged as before", Ipv4AddressesAreJudgedAsBefore);
  return test_summary();
}
