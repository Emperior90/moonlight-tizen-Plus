// Checks the local patch of moonlight-common-c that reports an encrypted RTSP answer which doesn't decrypt with the key
// of the start with an error code of its own, ML_ERROR_RTSP_DECRYPT_FAILED (moonlight-common-c/src/Limelight.h;
// unsealRtspMessage() and transactRtspMessageTcp() in RtspConnection.c), instead of the -1 of every other failure.
// Sunshine answers like that while it still holds the launch session of an earlier start: it keeps one only, drops the
// session of a /launch or /resume that comes meanwhile while it answers that request with success, and checks and
// answers the RTSP requests of the dropped start with the key of the one it holds ("Failed to verify RTSP message tag"
// in its log). The app tells the user that the PC still holds an earlier start instead of naming the ports of the
// handshake, and starts the stream once more after the hold (retryStreamStart() in wasm/platform/index.js).
//
// performRtspHandshake() runs over TCP on the loopback interface against a stand-in for the RTSP server of Sunshine,
// which answers each request once with a message encrypted like Sunshine encrypts it (AES-128-GCM, the IV from the
// sequence number of the answer and 'H', 'R'; src/rtsp.cpp of Sunshine): with the key of the start, with another key,
// unencrypted, or not at all. The test includes RtspConnection.c with the files it needs; RtspParser.c is built as a
// unit of its own, because Rtsp.h, which both include, has no include guard. LC_LOG sends the log lines of
// moonlight-common-c to ListenerCallbacks.logMessage, as in the other clients of Moonlight, instead of the console of
// Emscripten, so that the test can read them.
// Build with: -DLC_LOG moonlight-common-c/src/RtspParser.c -lcrypto

// The socket code of moonlight-common-c needs the GNU extensions of the C library (in6_pktinfo)
#define _GNU_SOURCE

#include "test_support_c.h"

#include <openssl/evp.h>

#include "../../moonlight-common-c/src/RtspConnection.c"
#include "../../moonlight-common-c/src/PlatformCrypto.c"
#include "../../moonlight-common-c/src/PlatformSockets.c"
#include "../../moonlight-common-c/src/Platform.c"
#include "../../moonlight-common-c/src/Misc.c"
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
#include <unistd.h>

// What the other files of moonlight-common-c provide (Connection.c and the streams); the handshake ends before it needs
// more of them
struct sockaddr_storage RemoteAddr;
struct sockaddr_storage LocalAddr;
SOCKADDR_LEN AddrLen;
int AppVersionQuad[4];
STREAM_CONFIGURATION StreamConfig;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
AUDIO_RENDERER_CALLBACKS AudioCallbacks;
DECODER_RENDERER_CALLBACKS VideoCallbacks;
int NegotiatedVideoFormat;
volatile bool ConnectionInterrupted;
bool HighQualitySurroundSupported;
bool ReferenceFrameInvalidationSupported;
uint16_t RtspPortNumber;
uint16_t ControlPortNumber;
uint16_t AudioPortNumber;
uint16_t VideoPortNumber;
uint32_t ControlConnectData;
uint32_t SunshineFeatureFlags;
uint32_t EncryptionFeaturesSupported;
uint32_t EncryptionFeaturesRequested;
uint32_t EncryptionFeaturesEnabled;
bool AudioEncryptionEnabled;
SS_PING AudioPingPayload;
SS_PING VideoPingPayload;
OPUS_MULTISTREAM_CONFIGURATION HighQualityOpusConfig;
OPUS_MULTISTREAM_CONFIGURATION NormalQualityOpusConfig;

char* getSdpPayloadForStreamConfig(int rtspClientVersion, int* length) {
  (void)rtspClientVersion;
  *length = 0;
  return NULL;
}
int notifyAudioPortNegotiationComplete(void) {
  return 0;
}

// The log of the client, which Limelog() hands each line formatted already (LC_LOG)
static char clientLog[4096];
static void clientLogMessage(const char* format, ...) {
  strncat(clientLog, format, sizeof(clientLog) - strlen(clientLog) - 1);
}

// ---- The stand-in for the RTSP server of Sunshine ----

// How the server answers the first request; it closes every later connection without an answer, which ends the
// handshake at its second request (DESCRIBE)
enum answer { ANSWER_WITH_KEY_OF_START, ANSWER_WITH_OTHER_KEY, ANSWER_UNENCRYPTED, ANSWER_NOTHING };

static int listenFd = -1;
static uint16_t serverPort;
static enum answer serverAnswer;
static unsigned char serverKey[16];

static const unsigned char keyOfStart[16] = { 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
                                             0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f };
static const unsigned char keyOfEarlierStart[16] = { 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
                                                    0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f };

static bool readFully(int fd, unsigned char* buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t got = recv(fd, buffer + offset, length - offset, 0);
    if (got <= 0) {
      return false;
    }
    offset += (size_t)got;
  }
  return true;
}

// AES-128-GCM with a 12-byte IV and a 16-byte tag, as crypto.cpp of Sunshine encrypts
static void encrypt(const unsigned char* key, const unsigned char* iv, unsigned char* tag, unsigned char* data,
                    int length) {
  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  int outLength = 0;
  int finalLength = 0;
  CHECK(EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, NULL, NULL) == 1);
  CHECK(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL) == 1);
  CHECK(EVP_EncryptInit_ex(ctx, NULL, NULL, key, iv) == 1);
  CHECK(EVP_EncryptUpdate(ctx, data, &outLength, data, length) == 1);
  CHECK(EVP_EncryptFinal_ex(ctx, data + outLength, &finalLength) == 1);
  CHECK(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag) == 1);
  EVP_CIPHER_CTX_free(ctx);
}

// Send "RTSP/1.0 200 OK" the way the server is set to: in the encrypted frame of Sunshine (typeAndLength with the
// encryption bit, the sequence number, the tag, then the encrypted message), or as plain text
static void sendAnswer(int fd) {
  const char* text = "RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n";
  const int length = (int)strlen(text);
  if (serverAnswer == ANSWER_UNENCRYPTED) {
    send(fd, text, (size_t)length, MSG_NOSIGNAL);
    return;
  }
  unsigned char message[24 + 64];
  const uint32_t sequenceNumber = 1;
  const uint32_t typeAndLength = htonl(0x80000000u | (uint32_t)length);
  const uint32_t sequenceField = htonl(sequenceNumber);
  unsigned char iv[12] = { 0 };
  memcpy(message, &typeAndLength, 4);
  memcpy(message + 4, &sequenceField, 4);
  memcpy(message + 24, text, (size_t)length);
  // The IV holds the sequence number in little endian byte order and 'H', 'R' for an answer of the host
  iv[0] = (unsigned char)sequenceNumber;
  iv[10] = 'H';
  iv[11] = 'R';
  encrypt(serverKey, iv, message + 8, message + 24, length);
  send(fd, message, 24 + (size_t)length, MSG_NOSIGNAL);
}

static void* serverThread(void* context) {
  (void)context;
  bool answered = false;
  for (;;) {
    int fd = accept(listenFd, NULL, NULL);
    if (fd < 0) {
      return NULL;
    }
    // Read the encrypted request: its header of 24 bytes, then as many bytes as it says
    unsigned char header[24];
    if (readFully(fd, header, sizeof(header))) {
      uint32_t typeAndLength;
      memcpy(&typeAndLength, header, 4);
      uint32_t length = ntohl(typeAndLength) & ~0x80000000u;
      unsigned char payload[2048];
      if (length <= sizeof(payload) && readFully(fd, payload, length) && !answered && serverAnswer != ANSWER_NOTHING) {
        sendAnswer(fd);
        answered = true;
      }
    }
    shutdown(fd, SHUT_RDWR);
    close(fd);
  }
}

static void startServer(void) {
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK), .sin_port = 0 };
  socklen_t length = sizeof(address);
  listenFd = socket(AF_INET, SOCK_STREAM, 0);
  CHECK(listenFd >= 0);
  CHECK(bind(listenFd, (struct sockaddr*)&address, sizeof(address)) == 0);
  CHECK(listen(listenFd, 4) == 0);
  CHECK(getsockname(listenFd, (struct sockaddr*)&address, &length) == 0);
  serverPort = ntohs(address.sin_port);
}

// The RTSP stage of LiStartConnection() (Connection.c) for a start with keyOfStart, against a server that answers its
// first request as given and closes the connection of every later one. Returns the result of the handshake.
static int handshake(enum answer answer, const unsigned char* answerKey) {
  startServer();
  serverAnswer = answer;
  memcpy(serverKey, answerKey, sizeof(serverKey));
  pthread_t thread;
  CHECK(pthread_create(&thread, NULL, serverThread, NULL) == 0);

  // The session URL of the answer to /launch or /resume: rtspenc:// turns the encryption of the RTSP requests on
  char url[64];
  snprintf(url, sizeof(url), "rtspenc://127.0.0.1:%u", serverPort);
  SERVER_INFORMATION serverInfo;
  memset(&serverInfo, 0, sizeof(serverInfo));
  serverInfo.address = "127.0.0.1";
  serverInfo.rtspSessionUrl = url;
  memset(&StreamConfig, 0, sizeof(StreamConfig));
  memcpy(StreamConfig.remoteInputAesKey, keyOfStart, sizeof(keyOfStart));
  StreamConfig.bitrate = 20000;
  StreamConfig.streamingRemotely = STREAM_CFG_LOCAL;
  StreamConfig.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
  struct sockaddr_in* remote = (struct sockaddr_in*)&RemoteAddr;
  memset(&RemoteAddr, 0, sizeof(RemoteAddr));
  remote->sin_family = AF_INET;
  remote->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  AddrLen = sizeof(struct sockaddr_in);
  memset(&LocalAddr, 0, sizeof(LocalAddr));
  RtspPortNumber = serverPort;
  // A Sunshine host (7.1.431.-1), which takes RTSP over TCP
  AppVersionQuad[0] = 7;
  AppVersionQuad[1] = 1;
  AppVersionQuad[2] = 431;
  AppVersionQuad[3] = -1;
  ConnectionInterrupted = false;
  ListenerCallbacks.logMessage = clientLogMessage;
  clientLog[0] = '\0';

  int result = performRtspHandshake(&serverInfo);

  // Closing the socket ends the accept() of the server thread
  shutdown(listenFd, SHUT_RDWR);
  close(listenFd);
  pthread_join(thread, NULL);
  return result;
}

// The answer of a host that holds an earlier start: the key of that start, which the TV can't decrypt
static void test_answer_with_another_key_reports_its_own_error(void) {
  int result = handshake(ANSWER_WITH_OTHER_KEY, keyOfEarlierStart);
  CHECK_EQ_INT(result, ML_ERROR_RTSP_DECRYPT_FAILED);
  CHECK(strstr(clientLog, "Failed to decrypt RTSP response") != NULL);
  CHECK(strstr(clientLog, "RTSP OPTIONS request failed: -300") != NULL);
}

// The answer with the key of the start decrypts: OPTIONS passes, and the handshake ends at DESCRIBE, whose connection
// the server closes without an answer, with the -1 of upstream
static void test_answer_with_the_key_of_the_start_decrypts(void) {
  int result = handshake(ANSWER_WITH_KEY_OF_START, keyOfStart);
  CHECK_EQ_INT(result, -1);
  CHECK(strstr(clientLog, "Failed to decrypt RTSP response") == NULL);
  CHECK(strstr(clientLog, "RTSP OPTIONS request failed") == NULL);
  CHECK(strstr(clientLog, "RTSP DESCRIBE request failed: -1") != NULL);
}

// The other failures of an answer keep the -1 of upstream: an unencrypted answer on an encrypted session, and a
// connection that the host closes without an answer (as Sunshine does when it holds no start at all)
static void test_other_failures_stay_minus_one(void) {
  int result = handshake(ANSWER_UNENCRYPTED, keyOfStart);
  CHECK_EQ_INT(result, -1);
  CHECK(strstr(clientLog, "Rejecting unencrypted RTSP message") != NULL);
  CHECK(strstr(clientLog, "RTSP OPTIONS request failed: -1") != NULL);

  result = handshake(ANSWER_NOTHING, keyOfStart);
  CHECK_EQ_INT(result, -1);
  CHECK(strstr(clientLog, "Failed to decrypt RTSP response") == NULL);
  CHECK(strstr(clientLog, "RTSP OPTIONS request failed: -1") != NULL);
}

// The code differs from the termination codes of moonlight-common-c and from -1
static void test_the_code_is_its_own(void) {
  const int others[] = { -1, ML_ERROR_GRACEFUL_TERMINATION, ML_ERROR_NO_VIDEO_TRAFFIC, ML_ERROR_NO_VIDEO_FRAME,
                         ML_ERROR_UNEXPECTED_EARLY_TERMINATION, ML_ERROR_PROTECTED_CONTENT, ML_ERROR_FRAME_CONVERSION };
  CHECK_EQ_INT(ML_ERROR_RTSP_DECRYPT_FAILED, -300);
  for (size_t i = 0; i < sizeof(others) / sizeof(others[0]); i++) {
    CHECK(ML_ERROR_RTSP_DECRYPT_FAILED != others[i]);
  }
}

int main(void) {
  RUN_TEST("an answer encrypted with another key ends the handshake with ML_ERROR_RTSP_DECRYPT_FAILED",
           test_answer_with_another_key_reports_its_own_error);
  RUN_TEST("an answer encrypted with the key of the start decrypts", test_answer_with_the_key_of_the_start_decrypts);
  RUN_TEST("an unencrypted answer and no answer keep -1", test_other_failures_stay_minus_one);
  RUN_TEST("ML_ERROR_RTSP_DECRYPT_FAILED is a code of its own", test_the_code_is_its_own);
  return test_summary();
}
