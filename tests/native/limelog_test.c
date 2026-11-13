// Checks how a log line of moonlight-common-c leaves the library (Limelog() of moonlight-common-c/src/Platform.h), built
// with the definitions that CMakeLists.txt gives the library (run.sh reads them, so the test builds the macro that the
// release builds): with LC_LOG the line goes to the listener of the connection, which the app keeps for its diagnostic
// log (ClLibraryLogMessage() of wasm/connectionlistener.cpp; connection_interrupt_test.cpp runs that side). Until
// 2.3.1 the release lacked LC_LOG, so the lines of the library (lost packets and frames, the recovery from them, the
// RTSP handshake, the receive buffer of the sockets) only reached the console of the thread that logged them, which
// nothing reads on a TV. The listener takes a format, so the line is its argument, and a '%' in a line stays as it is.
// Before the first connection the library has no listener; a line of that time still goes to the console.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/Limelight-internal.h"

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

// What Connection.c provides
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;

// The listener of a client, which formats what it gets like ClLogMessage() of the app
static int listenerCalls;
static char listenerLine[1024];
static void listenerLogMessage(const char* format, ...) {
  va_list args;
  va_start(args, format);
  vsnprintf(listenerLine, sizeof(listenerLine), format, args);
  va_end(args);
  listenerCalls++;
}

static void reset(bool withListener) {
  memset(&ListenerCallbacks, 0, sizeof(ListenerCallbacks));
  ListenerCallbacks.logMessage = withListener ? listenerLogMessage : NULL;
  listenerCalls = 0;
  listenerLine[0] = 0;
  emscripten_log_calls = 0;
  emscripten_log_last_format = NULL;
}

static void test_a_line_reaches_the_listener_formatted(void) {
  reset(true);
  // As RtpVideoQueue.c and VideoDepacketizer.c log a frame that the network lost
  Limelog("Unrecoverable frame %d: %d+%d=%d received < %d needed\n", 4521, 10, 1, 11, 12);
  CHECK_EQ_INT(listenerCalls, 1);
  CHECK(strcmp(listenerLine, "Unrecoverable frame 4521: 10+1=11 received < 12 needed\n") == 0);
  Limelog("Waiting for IDR frame\n");
  CHECK_EQ_INT(listenerCalls, 2);
  CHECK(strcmp(listenerLine, "Waiting for IDR frame\n") == 0);
  // Not to the console as well: the listener of the app writes there itself
  CHECK_EQ_INT(emscripten_log_calls, 0);
}

static void test_a_percent_sign_in_a_line_stays(void) {
  reset(true);
  // ControlStream.c
  Limelog("Control message took over 10 ms to send (net latency: %u ms | packet loss: %f%%)\n", 3u, 0.5);
  CHECK_EQ_INT(listenerCalls, 1);
  CHECK(strcmp(listenerLine, "Control message took over 10 ms to send (net latency: 3 ms | packet loss: 0.500000%)\n") == 0);
  // A text of the host that looks like a format isn't read as one
  Limelog("getaddrinfo(%s) failed: %d\n", "100%d-of-%s", -2);
  CHECK_EQ_INT(listenerCalls, 2);
  CHECK(strcmp(listenerLine, "getaddrinfo(100%d-of-%s) failed: -2\n") == 0);
}

static void test_a_long_line_is_cut_not_overrun(void) {
  reset(true);
  // (a length that the compiler can't see, so that it doesn't warn about the cut that this test is about)
  static volatile size_t hostLength = 1999;
  char* host = malloc(hostLength + 1);
  memset(host, 'h', hostLength);
  host[hostLength] = 0;
  Limelog("No working addresses found for host: %s\n", host);
  free(host);
  CHECK_EQ_INT(listenerCalls, 1);
  // The macro formats into 1024 bytes
  CHECK_EQ_INT(strlen(listenerLine), 1023);
  CHECK(strncmp(listenerLine, "No working addresses found for host: hhhh", 41) == 0);
}

static void test_without_a_listener_the_line_goes_to_the_console(void) {
  reset(false);
  static const char format[] = "No response from STUN server\n";
  Limelog(format);
  CHECK_EQ_INT(listenerCalls, 0);
  CHECK_EQ_INT(emscripten_log_calls, 1);
  CHECK(emscripten_log_last_format == format);
}

int main(void) {
  RUN_TEST("a log line of the library reaches the listener of the connection, formatted",
           test_a_line_reaches_the_listener_formatted);
  RUN_TEST("a percent sign in a line stays as it is", test_a_percent_sign_in_a_line_stays);
  RUN_TEST("a line longer than the buffer of the macro is cut", test_a_long_line_is_cut_not_overrun);
  RUN_TEST("before the first connection, without a listener, a line goes to the console",
           test_without_a_listener_the_line_goes_to_the_console);
  return test_summary();
}
