#pragma once
// Messages that name the ports of the host PC a failed connection needs, so that the user can check them in the
// firewall of the PC and the router, e.g. "RTSP handshake failed (error 10060)" followed by "Check that the firewall of
// the host PC and your router don't block these ports: TCP 48010, UDP 48000, UDP 48010". The ports come from
// LiGetPortFlagsFromStage() and LiGetPortFlagsFromTerminationErrorCode() of moonlight-common-c as the text of
// LiStringifyPortFlags() (see wasm/connectionlistener.cpp, tests/native/port_flags_test.c), and handleMessage() in
// wasm/platform/messages.js translates the messages. The header has no other dependencies, so the native tests can
// check it on its own (tests/native/connection_message_test.cpp).

#include <string>

// Size of the buffer for LiStringifyPortFlags(), which holds every port that moonlight-common-c knows
constexpr int kPortListLength = 128;

// The sentence that names the ports a connection needs, or "" for no ports
inline std::string FormatBlockedPortsHint(const std::string& ports) {
  if (ports.empty()) {
    return "";
  }
  return "Check that the firewall of the host PC and your router don't block these ports: " + ports;
}

// Message of a connection stage that failed, followed by the ports the stage needs when there are any
inline std::string FormatStageFailedMessage(const std::string& stageName, int errorCode, const std::string& ports) {
  std::string message = stageName + " failed (error " + std::to_string(errorCode) + ")";
  if (!ports.empty()) {
    message += "\n\n" + FormatBlockedPortsHint(ports);
  }
  return message;
}
