#pragma once
// Messages that name the ports of the host PC a failed connection needs, so that the user can check them in the
// firewall of the PC and the router, e.g. "RTSP handshake failed (error 10060)" followed by "Check that the firewall of
// the host PC and your router don't block these ports: TCP 48010, UDP 48000, UDP 48010". The ports come from
// LiGetPortFlagsFromStage() and LiGetPortFlagsFromTerminationErrorCode() of moonlight-common-c as the text of
// LiStringifyPortFlags(), moved to the ports of a host that doesn't use the default ones (see
// wasm/connectionlistener.cpp, tests/native/port_flags_test.c), and handleMessage() in wasm/platform/messages.js
// translates the messages. The header has no other dependencies, so the native tests can check it on its own
// (tests/native/connection_message_test.cpp).

#include <cctype>
#include <cstdlib>
#include <string>

// Size of the buffer for LiStringifyPortFlags(), which holds every port that moonlight-common-c knows
constexpr int kPortListLength = 128;

// The RTSP port that the port lists of moonlight-common-c name (ML_PORT_FLAG_TCP_48010), and that it connects to when
// the session URL names none
constexpr int kDefaultRtspPort = 48010;

// The RTSP port of the host in the session URL of the launch reply (sessionUrl0, e.g. "rtsp://192.168.1.10:48010"),
// read like parseRtspPortNumberFromUrl() of moonlight-common-c (Connection.c), which connects to it: the number after
// the last colon, or kDefaultRtspPort without a valid one
inline int GetRtspPortFromSessionUrl(const std::string& sessionUrl) {
  const size_t colon = sessionUrl.rfind(':');
  if (colon == std::string::npos) {
    return kDefaultRtspPort;
  }
  const long port = std::strtol(sessionUrl.c_str() + colon + 1, nullptr, 10);
  if (port <= 0 || port > 65535) {
    return kDefaultRtspPort;
  }
  return static_cast<int>(port);
}

// How far the ports of the host are from the default ports that the port lists of moonlight-common-c name. Sunshine
// moves every port of the stream by the same amount when its port setting isn't the default 47989 (e.g. TCP 50021 for
// RTSP, UDP 50009 to 50011 for video, control and audio with 50000), and names the moved RTSP port in the session URL,
// which moonlight-common-c connects to. A router that forwards other external ports to the default ones doesn't change
// the session URL, and the stream connects to the ports it names then as well.
inline int GetPortOffsetFromSessionUrl(const std::string& sessionUrl) {
  return GetRtspPortFromSessionUrl(sessionUrl) - kDefaultRtspPort;
}

// Move every port of a list of LiStringifyPortFlags() (e.g. "TCP 48010, UDP 48000") by the offset of the ports of the
// host (GetPortOffsetFromSessionUrl()), or return "" when a port would leave the range of valid ports, so that no
// message names a port that the stream doesn't use
inline std::string MovePortList(const std::string& ports, int offset) {
  if (offset == 0) {
    return ports;
  }
  std::string moved;
  size_t position = 0;
  while (position < ports.size()) {
    if (!std::isdigit(static_cast<unsigned char>(ports[position]))) {
      moved += ports[position++];
      continue;
    }
    size_t end = position;
    while (end < ports.size() && std::isdigit(static_cast<unsigned char>(ports[end]))) {
      ++end;
    }
    const long port = std::strtol(ports.substr(position, end - position).c_str(), nullptr, 10) + offset;
    if (port <= 0 || port > 65535) {
      return "";
    }
    moved += std::to_string(port);
    position = end;
  }
  return moved;
}

// The sentence that names the ports a connection needs, or "" for no ports
inline std::string FormatBlockedPortsHint(const std::string& ports) {
  if (ports.empty()) {
    return "";
  }
  return "Check that the firewall of the host PC and your router don't block these ports: " + ports;
}

// Message of a connection stage that failed, followed by the ports the stage needs when there are any. The blank line
// before the ports becomes a paragraph break of the connection error dialog (messages.js).
inline std::string FormatStageFailedMessage(const std::string& stageName, int errorCode, const std::string& ports) {
  std::string message = stageName + " failed (error " + std::to_string(errorCode) + ")";
  if (!ports.empty()) {
    message += "\n\n" + FormatBlockedPortsHint(ports);
  }
  return message;
}
