#pragma once
// The Wake-on-LAN magic packet of the Wake PC menu (MoonlightInstance::WakeOnLan_private() in main.cpp): the MAC address
// of the host, the packet, and the rounds that send it. tests/native/wake_on_lan_test.cpp runs them.
//
// The packet goes out kWakeOnLanRounds times, kWakeOnLanRoundIntervalMs apart, to the ports 9 and 7 of every target:
// 255.255.255.255, the broadcast address of the subnet of the TV (which a router forwards to the LAN of the host where
// it drops the limited broadcast, from getSubnetBroadcastAddress() in utils.js) and ff02::1, the IPv6 link-local
// all-nodes address. A network card that sleeps deeply, or a switch that only just woke up, can miss a single packet.
// The rounds and the ports come from the fork of samirmartins (moonlight-tizen, wakeonlan.hpp of 97bfe5c), the
// targets follow moonlight-qt (NvComputer::wake() in nvcomputer.cpp).

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

constexpr int kWakeOnLanRounds = 3;
constexpr int kWakeOnLanRoundIntervalMs = 75;
constexpr unsigned short kWakeOnLanPorts[] = { 9, 7 };
constexpr size_t kMagicPacketSize = 102;

// The error of a host without a known MAC address: hosts report 00:00:00:00:00:00 when they don't tell it, e.g.
// Sunshine to a client that isn't paired or asks over HTTP. A label of replaceKnownWolErrorLabels() in messages.js,
// which translates it.
constexpr const char* kWakeOnLanUnknownMacError = "The PC hasn't reported its MAC address (00:00:00:00:00:00)";

// Read a MAC address like 'AA:BB:CC:DD:EE:FF' (also in lower case)
inline bool ParseMacAddress(const std::string& text, unsigned char mac[6]) {
  return std::sscanf(text.c_str(), "%hhx:%hhx:%hhx:%hhx:%hhx:%hhx", &mac[0], &mac[1], &mac[2], &mac[3], &mac[4],
                     &mac[5]) == 6;
}

inline bool IsZeroMacAddress(const unsigned char mac[6]) {
  for (int i = 0; i < 6; i++) {
    if (mac[i] != 0) {
      return false;
    }
  }
  return true;
}

// 6 times 0xFF, then the MAC address 16 times
inline void BuildMagicPacket(const unsigned char mac[6], unsigned char packet[kMagicPacketSize]) {
  std::memset(packet, 0xFF, 6);
  for (int i = 1; i <= 16; i++) {
    std::memcpy(&packet[i * 6], mac, 6);
  }
}

// Read the broadcast address of the subnet of the TV. Returns false for none to add: an empty text (the TV didn't tell
// its address), no IPv4 address, 0.0.0.0, or 255.255.255.255, which is a target anyway.
inline bool ParseSubnetBroadcastAddress(const std::string& text, in_addr* address) {
  in_addr parsed;
  if (text.empty() || inet_pton(AF_INET, text.c_str(), &parsed) != 1) {
    return false;
  }
  if (parsed.s_addr == htonl(INADDR_ANY) || parsed.s_addr == htonl(INADDR_BROADCAST)) {
    return false;
  }
  *address = parsed;
  return true;
}

// Where a round sends the packet: a socket and an address, whose port each send sets
struct WakeOnLanTarget {
  int socket;
  sockaddr_storage address;
  socklen_t length;
};

inline WakeOnLanTarget MakeWakeOnLanTarget(int socket, in_addr address) {
  WakeOnLanTarget target;
  std::memset(&target, 0, sizeof(target));
  sockaddr_in* ipv4 = reinterpret_cast<sockaddr_in*>(&target.address);
  ipv4->sin_family = AF_INET;
  ipv4->sin_addr = address;
  target.socket = socket;
  target.length = sizeof(sockaddr_in);
  return target;
}

inline WakeOnLanTarget MakeWakeOnLanTarget(int socket, const in6_addr& address) {
  WakeOnLanTarget target;
  std::memset(&target, 0, sizeof(target));
  sockaddr_in6* ipv6 = reinterpret_cast<sockaddr_in6*>(&target.address);
  ipv6->sin6_family = AF_INET6;
  ipv6->sin6_addr = address;
  target.socket = socket;
  target.length = sizeof(sockaddr_in6);
  return target;
}

inline void SetWakeOnLanPort(sockaddr_storage* address, unsigned short port) {
  if (address->ss_family == AF_INET6) {
    reinterpret_cast<sockaddr_in6*>(address)->sin6_port = htons(port);
  } else {
    reinterpret_cast<sockaddr_in*>(address)->sin_port = htons(port);
  }
}

// Send the packet in kWakeOnLanRounds rounds, kWakeOnLanRoundIntervalMs apart, each to the ports 9 and 7 of every
// target, and return how many sends worked. send(socket, address, length) sends one packet and returns whether it went
// out, sleepMs(milliseconds) waits between the rounds.
template <typename SendFunction, typename SleepFunction>
int SendWakeOnLanRounds(const std::vector<WakeOnLanTarget>& targets, SendFunction send, SleepFunction sleepMs) {
  int sent = 0;
  for (int round = 0; round < kWakeOnLanRounds; round++) {
    if (round > 0) {
      sleepMs(kWakeOnLanRoundIntervalMs);
    }
    for (const WakeOnLanTarget& target : targets) {
      for (unsigned short port : kWakeOnLanPorts) {
        sockaddr_storage address = target.address;
        SetWakeOnLanPort(&address, port);
        if (send(target.socket, reinterpret_cast<const sockaddr*>(&address), target.length)) {
          sent++;
        }
      }
    }
  }
  return sent;
}
