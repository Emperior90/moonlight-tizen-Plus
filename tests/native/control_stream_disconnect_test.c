// Checks the interceptor of moonlight-common-c that holds back the ENet disconnect of the host until the control stream
// has processed what arrived before it (ignoreDisconnectIntercept() in moonlight-common-c/src/ControlStream.c), with
// upstream commit e80a786 ('Handle ENet disconnects with short headers'): ENet leaves the 2-byte sentTime out of the
// header of a datagram without reliable commands, and enet_peer_disconnect_now(), which Sunshine ends a session with,
// sends such a datagram. The interceptor used to expect exactly a 4-byte header and missed it, so ENet handled the
// disconnect at once and could drop the termination message of the host that came just before it (the reason of the
// end, e.g. an encoder error, became a generic connection loss). The size of the header now follows its sentTime flag
// and the checksum of the host, and the check of 41cedb8 stays: only a disconnect addressed to our peer and coming from
// its address is held back.
//
// The test includes ControlStream.c with the real ENet of moonlight-common-c and the files it needs, and connects two
// ENet hosts over the loopback interface: the host side disconnects the way Sunshine does, and the client side services
// its host with the interceptor of the control stream. Datagrams that need a checksum or another peer are built by hand
// and given to the interceptor directly (the checksum code of ENet reads and writes misaligned 32-bit values, which the
// sanitizers of run.sh stop at).

// The control stream and the socket code of moonlight-common-c need the GNU extensions of the C library (in6_pktinfo)
#define _GNU_SOURCE

#include "test_support_c.h"

#include "../../moonlight-common-c/src/ControlStream.c"
#include "../../moonlight-common-c/src/ByteBuffer.c"
#include "../../moonlight-common-c/src/LinkedBlockingQueue.c"
#include "../../moonlight-common-c/src/Misc.c"
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
#include <string.h>

// What the other files of moonlight-common-c provide (Connection.c, VideoStream.c); the test never starts a connection
struct sockaddr_storage RemoteAddr;
struct sockaddr_storage LocalAddr;
SOCKADDR_LEN AddrLen;
int AppVersionQuad[4];
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
DECODER_RENDERER_CALLBACKS VideoCallbacks;
int NegotiatedVideoFormat;
volatile bool ConnectionInterrupted;
bool ReferenceFrameInvalidationSupported;
uint16_t ControlPortNumber;
uint32_t ControlConnectData;
uint32_t SunshineFeatureFlags;
uint32_t EncryptionFeaturesEnabled;

// The encryption of the control stream (PlatformCrypto.c needs OpenSSL), which the interceptor never uses
PPLT_CRYPTO_CONTEXT PltCreateCryptoContext(void) {
  return NULL;
}
void PltDestroyCryptoContext(PPLT_CRYPTO_CONTEXT ctx) {
  (void)ctx;
}
bool PltEncryptMessage(PPLT_CRYPTO_CONTEXT ctx, int algorithm, int flags, unsigned char* key, int keyLength,
                       unsigned char* iv, int ivLength, unsigned char* tag, int tagLength, unsigned char* inputData,
                       int inputDataLength, unsigned char* outputData, int* outputDataLength) {
  (void)ctx, (void)algorithm, (void)flags, (void)key, (void)keyLength, (void)iv, (void)ivLength, (void)tag;
  (void)tagLength, (void)inputData, (void)inputDataLength, (void)outputData, (void)outputDataLength;
  return false;
}
bool PltDecryptMessage(PPLT_CRYPTO_CONTEXT ctx, int algorithm, int flags, unsigned char* key, int keyLength,
                       unsigned char* iv, int ivLength, unsigned char* tag, int tagLength, unsigned char* inputData,
                       int inputDataLength, unsigned char* outputData, int* outputDataLength) {
  (void)ctx, (void)algorithm, (void)flags, (void)key, (void)keyLength, (void)iv, (void)ivLength, (void)tag;
  (void)tagLength, (void)inputData, (void)inputDataLength, (void)outputData, (void)outputDataLength;
  return false;
}

// The lengths of the datagrams that reached the interceptor of the client, and what it answered for them
#define MAX_DATAGRAMS 64
static size_t datagramLengths[MAX_DATAGRAMS];
static int interceptAnswers[MAX_DATAGRAMS];
static int datagramCount;

static int recordingIntercept(ENetHost* host, ENetEvent* event) {
  const int answer = ignoreDisconnectIntercept(host, event);
  if (datagramCount < MAX_DATAGRAMS) {
    datagramLengths[datagramCount] = host->receivedDataLength;
    interceptAnswers[datagramCount] = answer;
    datagramCount++;
  }
  return answer;
}

// A host of the PC and a client of the TV, connected over the loopback interface, with the peer of the client as the
// peer of the control stream
static ENetHost* pcHost;
static ENetPeer* pcPeer;

static bool ConnectHosts(void) {
  struct sockaddr_in loopback;
  ENetAddress bindAddress, pcAddress;
  ENetEvent event;
  bool clientConnected = false;
  int i;

  memset(&loopback, 0, sizeof(loopback));
  loopback.sin_family = AF_INET;
  loopback.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  enet_address_set_address(&bindAddress, (struct sockaddr*)&loopback, sizeof(loopback));
  enet_address_set_port(&bindAddress, 0);

  pcHost = enet_host_create(AF_INET, &bindAddress, 1, CTRL_CHANNEL_COUNT, 0, 0);
  client = enet_host_create(AF_INET, &bindAddress, 1, CTRL_CHANNEL_COUNT, 0, 0);
  CHECK(pcHost != NULL);
  CHECK(client != NULL);
  if (pcHost == NULL || client == NULL) {
    return false;
  }
  client->intercept = recordingIntercept;
  datagramCount = 0;
  disconnectPending = false;
  pcPeer = NULL;

  enet_socket_get_address(pcHost->socket, &pcAddress);
  peer = enet_host_connect(client, &pcAddress, CTRL_CHANNEL_COUNT, 0);
  CHECK(peer != NULL);
  // Both sides take the handshake in turns, and a little longer, so that no acknowledgement is left to send
  for (i = 0; i < 200 && !(clientConnected && pcPeer != NULL && peer->state == ENET_PEER_STATE_CONNECTED); i++) {
    while (enet_host_service(pcHost, &event, 1) > 0) {
      if (event.type == ENET_EVENT_TYPE_CONNECT) {
        pcPeer = event.peer;
      }
    }
    while (enet_host_service(client, &event, 1) > 0) {
      if (event.type == ENET_EVENT_TYPE_CONNECT) {
        clientConnected = true;
      }
    }
  }
  for (i = 0; i < 5; i++) {
    enet_host_service(pcHost, &event, 1);
    enet_host_service(client, &event, 1);
  }
  CHECK(clientConnected);
  CHECK(pcPeer != NULL);
  return clientConnected && pcPeer != NULL;
}

static void CloseHosts(void) {
  if (client != NULL) {
    enet_host_destroy(client);
    client = NULL;
  }
  if (pcHost != NULL) {
    enet_host_destroy(pcHost);
    pcHost = NULL;
  }
  peer = NULL;
  pcPeer = NULL;
}

// Service the client after the PC disconnected, and return whether ENet reported the disconnect itself
static bool ServiceClientAfterDisconnect(void) {
  ENetEvent event;
  bool disconnectEvent = false;
  int i;
  for (i = 0; i < 50 && !disconnectPending && !disconnectEvent; i++) {
    while (enet_host_service(client, &event, 2) > 0) {
      if (event.type == ENET_EVENT_TYPE_DISCONNECT) {
        disconnectEvent = true;
      } else if (event.type == ENET_EVENT_TYPE_RECEIVE) {
        enet_packet_destroy(event.packet);
      }
    }
  }
  return disconnectEvent;
}

static void TheDisconnectOfSunshineIsHeldBack(void) {
  // Sunshine ends a session with enet_peer_disconnect_now(): one unsequenced disconnect command, whose datagram has no
  // sentTime, so its header is 2 bytes
  if (!ConnectHosts()) {
    CloseHosts();
    return;
  }
  enet_peer_disconnect_now(pcPeer, 0);
  const bool disconnectEvent = ServiceClientAfterDisconnect();
  CHECK(datagramCount > 0);
  if (datagramCount > 0) {
    CHECK_EQ_INT(datagramLengths[datagramCount - 1], 2 + sizeof(ENetProtocolDisconnect));
    CHECK_EQ_INT(interceptAnswers[datagramCount - 1], 1);
  }
  CHECK(disconnectPending);
  CHECK(!disconnectEvent);
  // The peer stays connected until the control stream has taken what came before and ends it itself
  CHECK_EQ_INT(peer->state, ENET_PEER_STATE_CONNECTED);
  CloseHosts();
}

static void AGracefulDisconnectIsHeldBackAsBefore(void) {
  // enet_peer_disconnect() sends a reliable disconnect, whose datagram carries the sentTime of the 4-byte header
  if (!ConnectHosts()) {
    CloseHosts();
    return;
  }
  enet_peer_disconnect(pcPeer, 0);
  enet_host_flush(pcHost);
  const bool disconnectEvent = ServiceClientAfterDisconnect();
  CHECK(datagramCount > 0);
  if (datagramCount > 0) {
    CHECK_EQ_INT(datagramLengths[datagramCount - 1], sizeof(ENetProtocolHeader) + sizeof(ENetProtocolDisconnect));
    CHECK_EQ_INT(interceptAnswers[datagramCount - 1], 1);
  }
  CHECK(disconnectPending);
  CHECK(!disconnectEvent);
  CloseHosts();
}

// A datagram of a disconnect command to the peer of the control stream, built the way ENet sends it: the peer ID with
// the session and the flags, the sentTime if flagged, the checksum if the host uses one, then the command
static size_t BuildDisconnect(enet_uint8* datagram, enet_uint16 peerID, enet_uint8 sessionID, bool sentTime,
                              bool checksum, enet_uint8 command) {
  size_t length = 0;
  ENetProtocolDisconnect disconnect;
  const enet_uint16 header = ENET_HOST_TO_NET_16((enet_uint16)(peerID | (sessionID << ENET_PROTOCOL_HEADER_SESSION_SHIFT) |
                                                               (sentTime ? ENET_PROTOCOL_HEADER_FLAG_SENT_TIME : 0)));
  memcpy(datagram + length, &header, sizeof(header));
  length += sizeof(header);
  if (sentTime) {
    const enet_uint16 time = ENET_HOST_TO_NET_16(1234);
    memcpy(datagram + length, &time, sizeof(time));
    length += sizeof(time);
  }
  if (checksum) {
    const enet_uint32 sum = 0x12345678;
    memcpy(datagram + length, &sum, sizeof(sum));
    length += sizeof(sum);
  }
  memset(&disconnect, 0, sizeof(disconnect));
  disconnect.header.command = command;
  disconnect.header.channelID = 0xFF;
  memcpy(datagram + length, &disconnect, sizeof(disconnect));
  length += sizeof(disconnect);
  return length;
}

static enet_uint32 TestChecksum(const ENetBuffer* buffers, size_t bufferCount) {
  (void)buffers, (void)bufferCount;
  return 0;
}

// Give a datagram to the interceptor of the control stream as if it had come from the given address
static int InterceptDatagram(ENetHost* host, enet_uint8* datagram, size_t length, const ENetAddress* from) {
  ENetEvent event;
  memset(&event, 0, sizeof(event));
  event.type = ENET_EVENT_TYPE_RECEIVE;
  host->receivedData = datagram;
  host->receivedDataLength = length;
  host->receivedPeerAddress = *from;
  disconnectPending = false;
  const int answer = ignoreDisconnectIntercept(host, &event);
  if (answer == 1) {
    CHECK_EQ_INT(event.type, ENET_EVENT_TYPE_NONE);
  }
  return answer;
}

static void TheHeaderFollowsItsFlagsAndTheChecksum(void) {
  static ENetHost host;
  static ENetPeer ourPeer;
  struct sockaddr_in pcAddress;
  ENetAddress from, other;
  enet_uint8 datagram[64];
  size_t length;
  const enet_uint8 disconnectCommand = ENET_PROTOCOL_COMMAND_DISCONNECT | ENET_PROTOCOL_COMMAND_FLAG_UNSEQUENCED;

  memset(&host, 0, sizeof(host));
  memset(&ourPeer, 0, sizeof(ourPeer));
  memset(&pcAddress, 0, sizeof(pcAddress));
  pcAddress.sin_family = AF_INET;
  pcAddress.sin_addr.s_addr = htonl(0x0A000002);  // 10.0.0.2
  pcAddress.sin_port = htons(47999);
  enet_address_set_address(&from, (struct sockaddr*)&pcAddress, sizeof(pcAddress));
  pcAddress.sin_addr.s_addr = htonl(0x0A000003);
  enet_address_set_address(&other, (struct sockaddr*)&pcAddress, sizeof(pcAddress));
  ourPeer.incomingPeerID = 0;
  ourPeer.incomingSessionID = 1;
  ourPeer.address = from;
  peer = &ourPeer;

  // Without a checksum: a 2-byte header without sentTime and a 4-byte header with it
  length = BuildDisconnect(datagram, 0, 1, false, false, disconnectCommand);
  CHECK_EQ_INT(length, 10);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 1);
  CHECK(disconnectPending);
  length = BuildDisconnect(datagram, 0, 1, true, false, ENET_PROTOCOL_COMMAND_DISCONNECT);
  CHECK_EQ_INT(length, 12);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 1);
  CHECK(disconnectPending);

  // With a checksum, which ENet puts after the sentTime
  host.checksum = TestChecksum;
  length = BuildDisconnect(datagram, 0, 1, false, true, disconnectCommand);
  CHECK_EQ_INT(length, 14);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 1);
  CHECK(disconnectPending);
  length = BuildDisconnect(datagram, 0, 1, true, true, disconnectCommand);
  CHECK_EQ_INT(length, 16);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 1);
  CHECK(disconnectPending);
  // A datagram without the checksum that the host expects is left to ENet, which drops it
  length = BuildDisconnect(datagram, 0, 1, true, false, disconnectCommand);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 0);
  CHECK(!disconnectPending);
  host.checksum = NULL;

  // A disconnect followed by another command, or cut short, is left to ENet
  length = BuildDisconnect(datagram, 0, 1, false, false, disconnectCommand);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length + 4, &from), 0);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length - 1, &from), 0);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, 1, &from), 0);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, 0, &from), 0);
  CHECK(!disconnectPending);

  // Another command of the same size is no disconnect
  length = BuildDisconnect(datagram, 0, 1, false, false, ENET_PROTOCOL_COMMAND_PING);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 0);
  CHECK(!disconnectPending);

  // 41cedb8: only a disconnect to our peer, in its session, from its address
  length = BuildDisconnect(datagram, 1, 1, false, false, disconnectCommand);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 0);
  length = BuildDisconnect(datagram, 0, 2, false, false, disconnectCommand);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 0);
  length = BuildDisconnect(datagram, 0, 1, false, false, disconnectCommand);
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &other), 0);
  CHECK(!disconnectPending);
  // Nor before the control stream has a peer
  peer = NULL;
  CHECK_EQ_INT(InterceptDatagram(&host, datagram, length, &from), 0);
  CHECK(!disconnectPending);
}

int main(void) {
  CHECK_EQ_INT(enet_initialize(), 0);
  RUN_TEST("the disconnect of Sunshine (no sentTime in the header) is held back for the control stream",
           TheDisconnectOfSunshineIsHeldBack);
  RUN_TEST("a graceful disconnect (sentTime in the header) is held back as before", AGracefulDisconnectIsHeldBackAsBefore);
  RUN_TEST("the size of the header follows its sentTime flag and the checksum, and only our peer is intercepted",
           TheHeaderFollowsItsFlagsAndTheChecksum);
  enet_deinitialize();
  return test_summary();
}
