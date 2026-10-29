// Checks the message of a failed connection stage (wasm/connection_ports.hpp), which names the ports of the host PC
// that the stage needs (the port lists come from moonlight-common-c, see port_flags_test.c). The texts are those that
// tests/unit/connection-ports.test.js translates with wasm/platform/messages.js.

#include "connection_ports.hpp"
#include "test_support.h"

#include <string>

static void StageWithPorts() {
  const std::string message = FormatStageFailedMessage("RTSP handshake", 10060, "TCP 48010, UDP 48000, UDP 48010");
  CHECK_EQ(message, std::string("RTSP handshake failed (error 10060)\n\n"
                                "Check that the firewall of the host PC and your router don't block these ports: "
                                "TCP 48010, UDP 48000, UDP 48010"));
}

static void StageWithoutPorts() {
  const std::string message = FormatStageFailedMessage("video stream establishment", -1, "");
  CHECK_EQ(message, std::string("video stream establishment failed (error -1)"));
}

static void Hint() {
  CHECK_EQ(FormatBlockedPortsHint("UDP 47999"),
           std::string("Check that the firewall of the host PC and your router don't block these ports: UDP 47999"));
  CHECK_EQ(FormatBlockedPortsHint(""), std::string(""));
}

int main() {
  test_support::RunTest("a stage that needs ports names them after its error", StageWithPorts);
  test_support::RunTest("a stage without ports keeps its message", StageWithoutPorts);
  test_support::RunTest("the hint with the ports", Hint);
  return test_support::Summary();
}
