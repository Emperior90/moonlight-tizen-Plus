// Checks the Wake-on-LAN magic packet of wasm/wake_on_lan.hpp, which MoonlightInstance::WakeOnLan_private() in
// wasm/main.cpp sends: the MAC address and the unknown 00:00:00:00:00:00, the packet, the broadcast address of the
// subnet of the TV, and the rounds: 3 rounds 75 ms apart, each to the ports 9 and 7 of 255.255.255.255, of the subnet
// broadcast address and of ff02::1. The sends and the waits go to recording stand-ins instead of a socket.
// unit/wake-on-lan.test.js checks that main.cpp answers every request, also for the unknown MAC address.

#include "wake_on_lan.hpp"
#include "test_support.h"

#include <string>
#include <vector>

static std::string Describe(const sockaddr* address) {
  char text[INET6_ADDRSTRLEN] = {};
  if (address->sa_family == AF_INET6) {
    const sockaddr_in6* ipv6 = reinterpret_cast<const sockaddr_in6*>(address);
    inet_ntop(AF_INET6, &ipv6->sin6_addr, text, sizeof(text));
    return std::string("[") + text + "]:" + std::to_string(ntohs(ipv6->sin6_port));
  }
  const sockaddr_in* ipv4 = reinterpret_cast<const sockaddr_in*>(address);
  inet_ntop(AF_INET, &ipv4->sin_addr, text, sizeof(text));
  return std::string(text) + ":" + std::to_string(ntohs(ipv4->sin_port));
}

static void MacAddress() {
  unsigned char mac[6];
  CHECK(ParseMacAddress("AA:bb:0C:dd:EE:01", mac));
  CHECK(mac[0] == 0xAA && mac[1] == 0xBB && mac[2] == 0x0C && mac[3] == 0xDD && mac[4] == 0xEE && mac[5] == 0x01);
  CHECK(!IsZeroMacAddress(mac));
  CHECK(!ParseMacAddress("", mac));
  CHECK(!ParseMacAddress("AA:BB:CC:DD:EE", mac));
  CHECK(!ParseMacAddress("not a MAC", mac));
  // The address of a host that didn't report its MAC address
  CHECK(ParseMacAddress("00:00:00:00:00:00", mac));
  CHECK(IsZeroMacAddress(mac));
  CHECK_EQ(std::string(kWakeOnLanUnknownMacError), std::string("The PC hasn't reported its MAC address (00:00:00:00:00:00)"));
}

static void MagicPacket() {
  const unsigned char mac[6] = { 0x02, 0x11, 0x22, 0x33, 0x44, 0x55 };
  unsigned char packet[kMagicPacketSize];
  BuildMagicPacket(mac, packet);
  for (int i = 0; i < 6; i++) {
    CHECK_EQ(packet[i], 0xFF);
  }
  for (int copy = 0; copy < 16; copy++) {
    for (int i = 0; i < 6; i++) {
      CHECK_EQ(packet[6 + copy * 6 + i], mac[i]);
    }
  }
}

static void SubnetBroadcastAddress() {
  in_addr address;
  CHECK(ParseSubnetBroadcastAddress("192.168.0.255", &address));
  CHECK_EQ(address.s_addr, inet_addr("192.168.0.255"));
  CHECK(ParseSubnetBroadcastAddress("10.0.255.255", &address));
  // Nothing to add when the TV didn't tell it, or for an address that is no subnet broadcast
  CHECK(!ParseSubnetBroadcastAddress("", &address));
  CHECK(!ParseSubnetBroadcastAddress("255.255.255.255", &address));
  CHECK(!ParseSubnetBroadcastAddress("0.0.0.0", &address));
  CHECK(!ParseSubnetBroadcastAddress("192.168.0", &address));
  CHECK(!ParseSubnetBroadcastAddress("ff02::1", &address));
}

// The targets of main.cpp: the limited broadcast and the subnet broadcast on the IPv4 socket, ff02::1 on the IPv6 one
static std::vector<WakeOnLanTarget> Targets(bool withSubnet) {
  std::vector<WakeOnLanTarget> targets;
  in_addr address;
  address.s_addr = htonl(INADDR_BROADCAST);
  targets.push_back(MakeWakeOnLanTarget(4, address));
  if (withSubnet && ParseSubnetBroadcastAddress("192.168.0.255", &address)) {
    targets.push_back(MakeWakeOnLanTarget(4, address));
  }
  in6_addr allNodes;
  inet_pton(AF_INET6, "ff02::1", &allNodes);
  targets.push_back(MakeWakeOnLanTarget(6, allNodes));
  return targets;
}

static void Rounds() {
  std::vector<std::string> events;
  const int sent = SendWakeOnLanRounds(Targets(true),
    [&events](int socket, const sockaddr* address, socklen_t length) {
      CHECK_EQ(length, address->sa_family == AF_INET6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in));
      CHECK_EQ(socket, address->sa_family == AF_INET6 ? 6 : 4);
      events.push_back(Describe(address));
      return true;
    },
    [&events](int milliseconds) {
      events.push_back("wait " + std::to_string(milliseconds) + " ms");
    });
  CHECK_EQ(sent, 18);
  const std::vector<std::string> round = {
    "255.255.255.255:9", "255.255.255.255:7", "192.168.0.255:9", "192.168.0.255:7", "[ff02::1]:9", "[ff02::1]:7",
  };
  std::vector<std::string> expected;
  for (int i = 0; i < 3; i++) {
    if (i > 0) {
      expected.push_back("wait 75 ms");
    }
    expected.insert(expected.end(), round.begin(), round.end());
  }
  CHECK(events == expected);
  if (events != expected) {
    for (const std::string& event : events) {
      std::printf("  # %s\n", event.c_str());
    }
  }
}

static void RoundsWithoutSubnetAndFailedSends() {
  // Without the address of the TV the subnet broadcast is left out, and sends that fail (e.g. IPv6 on a TV without
  // it) don't count
  std::vector<std::string> sends;
  int waits = 0;
  const int sent = SendWakeOnLanRounds(Targets(false),
    [&sends](int, const sockaddr* address, socklen_t) {
      sends.push_back(Describe(address));
      return address->sa_family == AF_INET;
    },
    [&waits](int) {
      waits++;
    });
  CHECK_EQ(sends.size(), 12u);
  CHECK_EQ(sent, 6);
  CHECK_EQ(waits, 2);
  CHECK_EQ(sends[0], std::string("255.255.255.255:9"));
  CHECK_EQ(sends[2], std::string("[ff02::1]:9"));

  // Nothing sent at all
  CHECK_EQ(SendWakeOnLanRounds(Targets(false), [](int, const sockaddr*, socklen_t) { return false; }, [](int) {}), 0);
}

int main() {
  test_support::RunTest("a MAC address is read, and 00:00:00:00:00:00 is the unknown one", MacAddress);
  test_support::RunTest("the magic packet is 6 times 0xFF and the MAC address 16 times", MagicPacket);
  test_support::RunTest("the broadcast address of the subnet of the TV is added only when it is one", SubnetBroadcastAddress);
  test_support::RunTest("the packet goes out 3 times 75 ms apart to the ports 9 and 7 of every target", Rounds);
  test_support::RunTest("without the subnet the targets are the limited broadcast and ff02::1, failed sends don't count",
                        RoundsWithoutSubnetAndFailedSends);
  return test_support::Summary();
}
