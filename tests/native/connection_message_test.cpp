// Checks the message of a failed connection stage (wasm/connection_ports.hpp), which names the ports of the host PC
// that the stage needs (the port lists come from moonlight-common-c, see port_flags_test.c), moved to the ports of a
// host that doesn't use the default ones, as the RTSP port in its session URL shows. The texts are those that
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

static void RtspPortOfSessionUrl() {
  // The port after the last colon, like parseRtspPortNumberFromUrl() of moonlight-common-c, also after an IPv6 address
  CHECK_EQ(GetRtspPortFromSessionUrl("rtsp://192.168.1.10:48010"), 48010);
  CHECK_EQ(GetRtspPortFromSessionUrl("rtsp://192.168.1.10:50021"), 50021);
  CHECK_EQ(GetRtspPortFromSessionUrl("rtspenc://[fe80::1]:47021"), 47021);
  // Without a valid port (no session URL from GFE, no port, out of range), moonlight-common-c uses 48010
  CHECK_EQ(GetRtspPortFromSessionUrl(""), kDefaultRtspPort);
  CHECK_EQ(GetRtspPortFromSessionUrl("rtsp://192.168.1.10"), kDefaultRtspPort);
  CHECK_EQ(GetRtspPortFromSessionUrl("rtsp://192.168.1.10:0"), kDefaultRtspPort);
  CHECK_EQ(GetRtspPortFromSessionUrl("rtsp://192.168.1.10:70000"), kDefaultRtspPort);
  CHECK_EQ(GetPortOffsetFromSessionUrl("rtsp://192.168.1.10:48010"), 0);
  CHECK_EQ(GetPortOffsetFromSessionUrl(""), 0);
}

static void HostWithAnotherPort() {
  // Sunshine with the port 50000 moves every port by 2011: RTSP on TCP 50021, video, control and audio on UDP 50009,
  // 50010 and 50011, and names RTSP port 50021 in the session URL
  const int offset = GetPortOffsetFromSessionUrl("rtsp://192.168.1.10:50021");
  CHECK_EQ(offset, 2011);
  CHECK_EQ(MovePortList("TCP 48010, UDP 48000, UDP 48010", offset), std::string("TCP 50021, UDP 50011, UDP 50021"));
  CHECK_EQ(MovePortList("UDP 47999", offset), std::string("UDP 50010"));
  CHECK_EQ(MovePortList("UDP 47998, UDP 48000", offset), std::string("UDP 50009, UDP 50011"));
  CHECK_EQ(FormatStageFailedMessage("RTSP handshake", 10060, MovePortList("TCP 48010, UDP 48000, UDP 48010", offset)),
           std::string("RTSP handshake failed (error 10060)\n\n"
                       "Check that the firewall of the host PC and your router don't block these ports: "
                       "TCP 50021, UDP 50011, UDP 50021"));
  // A lower port setting moves them down, and the default ports stay as they are
  CHECK_EQ(MovePortList("UDP 47998, UDP 48000", GetPortOffsetFromSessionUrl("rtsp://10.0.0.2:47021")),
           std::string("UDP 47009, UDP 47011"));
  CHECK_EQ(MovePortList("TCP 48010, UDP 48000, UDP 48010", 0), std::string("TCP 48010, UDP 48000, UDP 48010"));
  CHECK_EQ(MovePortList("", offset), std::string(""));
}

static void MovedPortOutOfRange() {
  // The RTSP port is the highest port of the lists, so the moved ports stay within the range up to 65535
  CHECK_EQ(MovePortList("TCP 48010, UDP 48000, UDP 48010", GetPortOffsetFromSessionUrl("rtsp://10.0.0.2:65535")),
           std::string("TCP 65535, UDP 65525, UDP 65535"));
  // A port that would drop below 1 names no ports at all, so the message stays without the hint
  const int offset = GetPortOffsetFromSessionUrl("rtsp://10.0.0.2:10");
  CHECK_EQ(MovePortList("UDP 47998, UDP 48000", offset), std::string(""));
  CHECK_EQ(MovePortList("TCP 48010, UDP 48000, UDP 48010", offset), std::string(""));
  CHECK_EQ(FormatStageFailedMessage("control stream establishment", -1, MovePortList("UDP 47999", offset)),
           std::string("control stream establishment failed (error -1)"));
}

int main() {
  test_support::RunTest("a stage that needs ports names them after its error", StageWithPorts);
  test_support::RunTest("a stage without ports keeps its message", StageWithoutPorts);
  test_support::RunTest("the hint with the ports", Hint);
  test_support::RunTest("the RTSP port and the port offset of the session URL", RtspPortOfSessionUrl);
  test_support::RunTest("a host with another port gets its own ports named", HostWithAnotherPort);
  test_support::RunTest("a moved port out of range names no ports", MovedPortOutOfRange);
  return test_support::Summary();
}
