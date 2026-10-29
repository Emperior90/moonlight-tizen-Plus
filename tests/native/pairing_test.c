// Runs the pairing of libgamestream/pairing.c (gs_pair()) against a simulated host that answers like Sunshine
// (nvhttp.cpp: getservercert, clientchallenge, serverchallengeresp, clientpairingsecret), with real keys and
// certificates of OpenSSL. It checks that the client trusts only a host that knows the PIN: the hash of the host's
// challenge response must match the PIN (a wrong PIN is GS_PIN_WRONG, and a host that doesn't know the PIN never gets
// the signed secret of the client, only one of random bytes that ends its pairing session); that a wrong PIN leaves no
// stale session on a host that keeps the session of a client like Sunshine v2025.924, which would fail the next
// attempt; that the fields of the answers are only read with their exact length (a longer one
// would overflow the buffers on the stack, which the address sanitizer catches); and, through the leak check of the
// address sanitizer at exit, that the signature of the client is freed. http_request() is replaced by the simulated
// host, so no network is needed.
//
// Build with: -ftrivial-auto-var-init=pattern -lcrypto
// (the pattern fills the variables on the stack that the code leaves unset, so that sending one shows in the test)

// The AES functions of OpenSSL that pairing.c uses are deprecated since OpenSSL 3.0 but still there
#define OPENSSL_SUPPRESS_DEPRECATED

#include "test_support_c.h"

#include "../../libgamestream/pairing.c"

#include <openssl/aes.h>
#include <openssl/bn.h>
#include <openssl/rsa.h>

X509* g_Cert;
EVP_PKEY* g_PrivateKey;
char* g_UniqueId;
char* g_CertHex;

// A key and a self-signed certificate like the ones of mkcert.c (2048-bit RSA, SHA-256)
typedef struct {
  EVP_PKEY* key;
  X509* cert;
  char* pem;
} IDENTITY;

static IDENTITY create_identity(const char* name) {
  IDENTITY identity = { NULL, NULL, NULL };
  EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, NULL);
  EVP_PKEY_keygen_init(ctx);
  EVP_PKEY_CTX_set_rsa_keygen_bits(ctx, 2048);
  EVP_PKEY_keygen(ctx, &identity.key);
  EVP_PKEY_CTX_free(ctx);

  identity.cert = X509_new();
  X509_set_version(identity.cert, 2);
  ASN1_INTEGER_set(X509_get_serialNumber(identity.cert), 0);
  X509_gmtime_adj(X509_get_notBefore(identity.cert), 0);
  X509_gmtime_adj(X509_get_notAfter(identity.cert), 60L * 60 * 24 * 365);
  X509_set_pubkey(identity.cert, identity.key);
  X509_NAME* subject = X509_get_subject_name(identity.cert);
  X509_NAME_add_entry_by_txt(subject, "CN", MBSTRING_ASC, (const unsigned char*)name, -1, -1, 0);
  X509_set_issuer_name(identity.cert, subject);
  X509_sign(identity.cert, identity.key, EVP_sha256());

  BIO* bio = BIO_new(BIO_s_mem());
  PEM_write_bio_X509(bio, identity.cert);
  BUF_MEM* mem = NULL;
  BIO_get_mem_ptr(bio, &mem);
  identity.pem = malloc(mem->length + 1);
  memcpy(identity.pem, mem->data, mem->length);
  identity.pem[mem->length] = 0;
  BIO_free(bio);
  return identity;
}

static void free_identity(IDENTITY* identity) {
  EVP_PKEY_free(identity->key);
  X509_free(identity->cert);
  free(identity->pem);
}

static char* to_hex(const unsigned char* data, size_t length) {
  char* hex = malloc(length * 2 + 1);
  bytes_to_hex((unsigned char*)data, hex, length);
  return hex;
}

// The hex value of a parameter of the request URL, e.g. salt=...
static bool url_parameter(const char* url, const char* name, unsigned char* out, size_t length) {
  char key[64];
  snprintf(key, sizeof(key), "%s=", name);
  const char* start = strstr(url, key);
  if (start == NULL) {
    return false;
  }
  start += strlen(key);
  size_t digits = strcspn(start, "&");
  char* hex = strndup(start, digits);
  bool ok = hex_to_bytes(hex, out, length) == GS_OK;
  free(hex);
  return ok;
}

static int hash_length_of(int version) {
  return version >= 7 ? 32 : 20;
}

static void hash_of(int version, const unsigned char* data, size_t length, unsigned char* out) {
  if (version >= 7) {
    SHA256(data, length, out);
  } else {
    SHA1(data, length, out);
  }
}

static void signature_of(X509* cert, const unsigned char** data, int* length) {
  const ASN1_BIT_STRING* signature = NULL;
  X509_get0_signature(&signature, NULL, cert);
  *data = signature->data;
  *length = signature->length;
}

// The simulated host and what it saw
static struct {
  IDENTITY identity;
  int version;           // the server major version, 7 and up use SHA-256
  char pin[5];           // the PIN that the user entered on the host
  bool knowsPin;         // false for an impostor that answers without knowing the PIN
  const char* challengeResponseHex;  // an answer to the client challenge to send instead of the real one
  const char* pairingSecretHex;      // a pairing secret to send instead of the real one
  const char* plainCertHex;          // a certificate to send instead of the real one
  IDENTITY* signer;      // the key that signs the pairing secret, the host's own unless set
  // Keep a pairing session per client like Sunshine up to v2025.924 (nvhttp.cpp): getservercert finds an existing
  // session (map_id_sess.emplace()), each stage checks the phase of the one before (last_phase) and fails the pairing
  // otherwise, and only clientpairingsecret or a failed stage removes the session (remove_session()); /unpair is unknown
  bool sunshineSessions;
  bool hasSession;
  int lastPhase;
  // State of the pairing
  AES_KEY encryptKey, decryptKey;
  unsigned char serverSecret[16];
  unsigned char serverChallenge[16];
  unsigned char clientHash[32];
  // What happened
  int requests;
  int unpairs;
  bool gotClientPairingSecret;
  bool clientSecretSigned;  // the client's pairing secret carried a valid signature of the client's key
  bool clientProvedPin;  // the hash and signature of the client's pairing secret were right
  const char* failure;   // the status message of the last stage that Sunshine failed
  bool clientHashPadded; // the bytes of the client's hash after a SHA-1 hash were zeros
} host;

static IDENTITY client;
static IDENTITY realHost;
static IDENTITY otherKey;

// The phases of a pairing session of Sunshine (PAIR_PHASE)
enum { PHASE_NONE, PHASE_GETSERVERCERT, PHASE_CLIENTCHALLENGE, PHASE_SERVERCHALLENGERESP };

static void reset_host(int version, const char* pin) {
  memset(&host, 0, sizeof(host));
  host.identity = realHost;
  host.version = version;
  snprintf(host.pin, sizeof(host.pin), "%s", pin);
  host.knowsPin = true;
  host.signer = &realHost;
  host.clientHashPadded = true;
}

static void answer(PHTTP_DATA data, const char* text) {
  free(data->memory);
  data->memory = strdup(text);
  data->size = strlen(text);
}

static void answer_paired(PHTTP_DATA data, const char* paired, const char* name, const char* value) {
  size_t length = 256 + (value ? strlen(value) : 0);
  char* text = malloc(length);
  if (name != NULL) {
    snprintf(text, length, "<root status_code=\"200\"><paired>%s</paired><%s>%s</%s></root>", paired, name, value, name);
  } else {
    snprintf(text, length, "<root status_code=\"200\"><paired>%s</paired></root>", paired);
  }
  answer(data, text);
  free(text);
}

// fail_pair() of Sunshine: paired 0 with status 400, and the session is removed
static void fail_pair(PHTTP_DATA data, const char* message) {
  host.failure = message;
  host.hasSession = false;
  answer(data, "<root status_code=\"400\"><paired>0</paired></root>");
}

// The checks of a stage of Sunshine before it runs: the session must exist and be in the phase of the stage before.
// Returns false when the stage was answered with a failure.
static bool enter_phase(PHTTP_DATA data, int expectedPhase, int phase, const char* outOfOrder) {
  if (!host.sunshineSessions) {
    return true;
  }
  if (!host.hasSession) {
    host.failure = "Invalid uniqueid";
    answer(data, "<root status_code=\"400\" status_message=\"Invalid uniqueid\"></root>");
    return false;
  }
  if (host.lastPhase != expectedPhase) {
    fail_pair(data, outOfOrder);
    return false;
  }
  host.lastPhase = phase;
  return true;
}

static void handle_get_server_cert(const char* url, PHTTP_DATA data) {
  if (host.sunshineSessions && !host.hasSession) {
    host.hasSession = true;
    host.lastPhase = PHASE_NONE;
  }
  // The user enters the PIN, then getservercert() of Sunshine runs with the session that it found
  if (!enter_phase(data, PHASE_NONE, PHASE_GETSERVERCERT, "Out of order call to getservercert")) {
    return;
  }

  unsigned char saltedPin[20];
  unsigned char aesKey[32];
  url_parameter(url, "salt", saltedPin, 16);
  memcpy(saltedPin + 16, host.pin, 4);
  hash_of(host.version, saltedPin, sizeof(saltedPin), aesKey);
  AES_set_encrypt_key(aesKey, 128, &host.encryptKey);
  AES_set_decrypt_key(aesKey, 128, &host.decryptKey);
  RAND_bytes(host.serverSecret, 16);
  RAND_bytes(host.serverChallenge, 16);

  char* certHex = host.plainCertHex ? strdup(host.plainCertHex) : to_hex((unsigned char*)host.identity.pem, strlen(host.identity.pem));
  answer_paired(data, "1", "plaincert", certHex);
  free(certHex);
}

static void handle_client_challenge(const char* url, PHTTP_DATA data) {
  if (!enter_phase(data, PHASE_GETSERVERCERT, PHASE_CLIENTCHALLENGE, "Out of order call to clientchallenge")) {
    return;
  }
  unsigned char encrypted[16];
  unsigned char challenge[16];
  url_parameter(url, "clientchallenge", encrypted, 16);
  AES_decrypt(encrypted, challenge, &host.decryptKey);

  // hash(client challenge + signature of the host certificate + server secret) + server challenge, padded to 48 bytes
  const unsigned char* signature;
  int signatureLength;
  signature_of(host.identity.cert, &signature, &signatureLength);
  unsigned char hashed[16 + 512 + 16];
  memcpy(hashed, challenge, 16);
  memcpy(hashed + 16, signature, signatureLength);
  memcpy(hashed + 16 + signatureLength, host.serverSecret, 16);
  unsigned char plain[48];
  memset(plain, 0, sizeof(plain));
  if (host.knowsPin) {
    hash_of(host.version, hashed, 16 + signatureLength + 16, plain);
  } else {
    // An impostor can't decrypt the challenge, so its hash can't match
    RAND_bytes(plain, hash_length_of(host.version));
  }
  memcpy(plain + hash_length_of(host.version), host.serverChallenge, 16);
  unsigned char encryptedResponse[48];
  for (int i = 0; i < 48; i += 16) {
    AES_encrypt(plain + i, encryptedResponse + i, &host.encryptKey);
  }

  char* hex = host.challengeResponseHex ? strdup(host.challengeResponseHex) : to_hex(encryptedResponse, sizeof(encryptedResponse));
  answer_paired(data, "1", "challengeresponse", hex);
  free(hex);
}

static void handle_server_challenge_response(const char* url, PHTTP_DATA data) {
  if (!enter_phase(data, PHASE_CLIENTCHALLENGE, PHASE_SERVERCHALLENGERESP, "Out of order call to serverchallengeresp")) {
    return;
  }
  unsigned char encrypted[32];
  url_parameter(url, "serverchallengeresp", encrypted, 32);
  for (int i = 0; i < 32; i += 16) {
    AES_decrypt(encrypted + i, host.clientHash + i, &host.decryptKey);
  }
  // A SHA-1 hash fills 20 of the 32 bytes, the rest are zeros (moonlight-qt pads it the same way)
  for (int i = hash_length_of(host.version); i < 32; i++) {
    host.clientHashPadded = host.clientHashPadded && host.clientHash[i] == 0;
  }

  // The server secret and its signature with the key of the host
  unsigned char pairingSecret[16 + 256];
  memcpy(pairingSecret, host.serverSecret, 16);
  EVP_MD_CTX* ctx = EVP_MD_CTX_create();
  size_t signatureLength = 256;
  EVP_DigestSignInit(ctx, NULL, EVP_sha256(), NULL, host.signer->key);
  EVP_DigestSignUpdate(ctx, host.serverSecret, 16);
  EVP_DigestSignFinal(ctx, pairingSecret + 16, &signatureLength);
  EVP_MD_CTX_destroy(ctx);

  char* hex = host.pairingSecretHex ? strdup(host.pairingSecretHex) : to_hex(pairingSecret, sizeof(pairingSecret));
  answer_paired(data, "1", "pairingsecret", hex);
  free(hex);
}

static void handle_client_pairing_secret(const char* url, PHTTP_DATA data) {
  if (!enter_phase(data, PHASE_SERVERCHALLENGERESP, PHASE_SERVERCHALLENGERESP, "Out of order call to clientpairingsecret")) {
    return;
  }
  unsigned char clientPairingSecret[16 + 256];
  host.gotClientPairingSecret = true;
  bool ok = url_parameter(url, "clientpairingsecret", clientPairingSecret, sizeof(clientPairingSecret));

  // hash(server challenge + signature of the client certificate + client secret) must be what the client sent before
  const unsigned char* signature;
  int signatureLength;
  signature_of(client.cert, &signature, &signatureLength);
  unsigned char hashed[16 + 256 + 16];
  unsigned char expected[32];
  memcpy(hashed, host.serverChallenge, 16);
  memcpy(hashed + 16, signature, 256);
  memcpy(hashed + 16 + 256, clientPairingSecret, 16);
  hash_of(host.version, hashed, sizeof(hashed), expected);
  host.clientSecretSigned = verifySignature(clientPairingSecret, 16, clientPairingSecret + 16, 256, client.cert);
  ok = ok && memcmp(expected, host.clientHash, hash_length_of(host.version)) == 0;
  ok = ok && host.clientSecretSigned;
  host.clientProvedPin = ok;
  // Sunshine ends the session here, whatever the result
  host.hasSession = false;
  // An impostor accepts any client
  answer_paired(data, ok || !host.knowsPin ? "1" : "0", NULL, NULL);
}

PHTTP_DATA http_create_data() {
  PHTTP_DATA data = calloc(1, sizeof(HTTP_DATA));
  data->memory = strdup("");
  data->maxSize = HTTP_MAX_RESPONSE_SIZE;
  return data;
}

void http_free_data(PHTTP_DATA data) {
  if (data != NULL) {
    free(data->memory);
    free(data);
  }
}

int http_request(const char* url, const char* ppkstr, PHTTP_DATA data) {
  (void)ppkstr;
  host.requests++;
  if (strstr(url, "/unpair?") != NULL) {
    host.unpairs++;
    // Sunshine has no such route and answers 404, which curl reports as a completed request
    answer(data, host.sunshineSessions ? "Not Found" : "<root status_code=\"200\"></root>");
  } else if (strstr(url, "phrase=getservercert") != NULL) {
    handle_get_server_cert(url, data);
  } else if (strstr(url, "clientchallenge=") != NULL) {
    handle_client_challenge(url, data);
  } else if (strstr(url, "serverchallengeresp=") != NULL) {
    handle_server_challenge_response(url, data);
  } else if (strstr(url, "clientpairingsecret=") != NULL) {
    handle_client_pairing_secret(url, data);
  } else {
    return GS_FAILED;
  }
  return GS_OK;
}

static int pair(const char* pin) {
  char* ppk = NULL;
  int result = gs_pair(host.version, "10.0.0.2", 47989, pin, &ppk);
  if (result == GS_OK) {
    CHECK(ppk != NULL && strncmp(ppk, "sha256//", 8) == 0);
  } else {
    CHECK(ppk == NULL);
  }
  free(ppk);
  return result;
}

static void test_correct_pin_pairs(void) {
  reset_host(7, "1234");
  CHECK_EQ_INT(pair("1234"), GS_OK);
  CHECK(host.clientProvedPin);
  CHECK_EQ_INT(host.unpairs, 0);
}

static void test_correct_pin_pairs_with_sha1(void) {
  // Hosts below server major version 7 hash with SHA-1, whose 20 bytes the client pads with zeros to 32 for AES
  reset_host(6, "0042");
  CHECK_EQ_INT(pair("0042"), GS_OK);
  CHECK(host.clientProvedPin);
  CHECK(host.clientHashPadded);
}

static void test_wrong_pin_is_reported_as_such(void) {
  reset_host(7, "9999");
  CHECK_EQ_INT(pair("1234"), GS_PIN_WRONG);
  // The client never sends its signed secret, only one of random bytes that ends the session on the host, and unpairs
  CHECK(host.gotClientPairingSecret);
  CHECK(!host.clientSecretSigned);
  CHECK(!host.clientProvedPin);
  CHECK_EQ_INT(host.unpairs, 1);

  reset_host(6, "9999");
  CHECK_EQ_INT(pair("1234"), GS_PIN_WRONG);
  CHECK(!host.clientSecretSigned);
  CHECK(!host.clientProvedPin);
}

static void test_pairing_after_a_wrong_pin_succeeds_on_sunshine(void) {
  // The user mistypes the PIN on the host, then pairs again with the right one. Sunshine up to v2025.924 keeps the
  // session of the first attempt until clientpairingsecret ends it: without it, the second attempt found the stale
  // session ('Out of order call to getservercert') and failed, and only the third one worked
  reset_host(7, "9999");
  host.sunshineSessions = true;
  CHECK_EQ_INT(pair("1234"), GS_PIN_WRONG);
  CHECK(!host.clientSecretSigned);
  CHECK(!host.hasSession);

  snprintf(host.pin, sizeof(host.pin), "%s", "5678");
  host.failure = NULL;
  CHECK_EQ_INT(pair("5678"), GS_OK);
  CHECK(host.failure == NULL);
  CHECK(host.clientProvedPin);
  CHECK(!host.hasSession);

  // The same after a host that doesn't know the PIN at all
  reset_host(7, "1234");
  host.sunshineSessions = true;
  host.knowsPin = false;
  CHECK_EQ_INT(pair("1234"), GS_PIN_WRONG);
  CHECK(!host.clientSecretSigned);
  host.knowsPin = true;
  CHECK_EQ_INT(pair("1234"), GS_OK);
  CHECK(host.failure == NULL);
}

static void test_host_without_the_pin_is_not_trusted(void) {
  // A device that answers at the address of the host and accepts every stage, without knowing the PIN, with a valid
  // signature of its own key: before the hash check the client trusted its certificate
  reset_host(7, "1234");
  host.knowsPin = false;
  CHECK_EQ_INT(pair("1234"), GS_PIN_WRONG);
  // The impostor gets a pairing secret of random bytes, never one signed with the key of the client
  CHECK(!host.clientSecretSigned);
  CHECK(!host.clientProvedPin);
}

static void test_pairing_secret_of_another_key_is_rejected(void) {
  reset_host(7, "1234");
  host.signer = &otherKey;
  CHECK_EQ_INT(pair("1234"), GS_FAILED);
  CHECK(!host.gotClientPairingSecret);
  CHECK_EQ_INT(host.unpairs, 1);
}

static char* repeat_hex(char digit, size_t count) {
  char* hex = malloc(count + 1);
  memset(hex, digit, count);
  hex[count] = 0;
  return hex;
}

static void test_challenge_response_is_read_with_its_exact_length(void) {
  // 48 bytes are 96 hex digits. A longer answer overflowed the buffer on the stack, a shorter one left part of it unset.
  size_t lengths[] = { 4096, 98, 94, 64, 0 };
  for (size_t i = 0; i < sizeof(lengths) / sizeof(lengths[0]); i++) {
    char* hex = repeat_hex('a', lengths[i]);
    reset_host(7, "1234");
    host.challengeResponseHex = hex;
    CHECK_EQ_INT(pair("1234"), GS_INVALID);
    CHECK_EQ_INT(host.requests, 3);  // getservercert, clientchallenge, unpair
    CHECK_EQ_INT(host.unpairs, 1);
    free(hex);
  }
  // The right length with a character that isn't a hex digit
  char* hex = repeat_hex('a', 96);
  hex[95] = 'g';
  reset_host(7, "1234");
  host.challengeResponseHex = hex;
  CHECK_EQ_INT(pair("1234"), GS_INVALID);
  free(hex);
}

static void test_pairing_secret_is_read_with_its_exact_length(void) {
  // 272 bytes are 544 hex digits
  size_t lengths[] = { 8192, 546, 542, 32, 0 };
  for (size_t i = 0; i < sizeof(lengths) / sizeof(lengths[0]); i++) {
    char* hex = repeat_hex('0', lengths[i]);
    reset_host(7, "1234");
    host.pairingSecretHex = hex;
    CHECK_EQ_INT(pair("1234"), GS_INVALID);
    CHECK(!host.gotClientPairingSecret);
    free(hex);
  }
}

static void test_certificate_must_be_hex(void) {
  reset_host(7, "1234");
  host.plainCertHex = "2d2d2d";  // "---", no certificate
  CHECK_EQ_INT(pair("1234"), GS_FAILED);
  reset_host(7, "1234");
  host.plainCertHex = "2d2d2";  // odd number of digits
  CHECK_EQ_INT(pair("1234"), GS_FAILED);
  reset_host(7, "1234");
  host.plainCertHex = "2d2dzz";
  CHECK_EQ_INT(pair("1234"), GS_FAILED);
  // Sunshine sends an empty certificate while another pairing is in progress
  reset_host(7, "1234");
  host.plainCertHex = "";
  CHECK_EQ_INT(pair("1234"), GS_FAILED);
}

static void test_pin_must_have_four_digits(void) {
  reset_host(7, "1234");
  CHECK_EQ_INT(pair("123"), GS_INVALID);
  CHECK_EQ_INT(pair("12345"), GS_INVALID);
  CHECK_EQ_INT(host.requests, 0);
}

static void test_hex_to_bytes(void) {
  unsigned char bytes[3];
  CHECK_EQ_INT(hex_to_bytes("00aBff", bytes, 3), GS_OK);
  CHECK(bytes[0] == 0x00 && bytes[1] == 0xab && bytes[2] == 0xff);
  CHECK_EQ_INT(hex_to_bytes("00abf", bytes, 3), GS_INVALID);
  CHECK_EQ_INT(hex_to_bytes("00abff00", bytes, 3), GS_INVALID);
  CHECK_EQ_INT(hex_to_bytes("00ab f", bytes, 3), GS_INVALID);
  CHECK_EQ_INT(hex_to_bytes("0x0102", bytes, 3), GS_INVALID);
  CHECK_EQ_INT(hex_to_bytes(NULL, bytes, 3), GS_INVALID);
}

static void test_xml_search_reads_the_value_after_its_start_tag(void) {
  char* value = NULL;
  char answer[] = "<root></paired><paired>1</paired></root>";
  CHECK_EQ_INT(xml_search(answer, strlen(answer), "paired", &value), GS_OK);
  CHECK(value != NULL && strcmp(value, "1") == 0);
  free(value);
  char missing[] = "<root><paired>1</root>";
  CHECK_EQ_INT(xml_search(missing, strlen(missing), "paired", &value), GS_FAILED);
}

int main(void) {
  client = create_identity("NVIDIA GameStream Client");
  realHost = create_identity("Sunshine Gamestream Host");
  otherKey = create_identity("Someone else");
  g_Cert = client.cert;
  g_PrivateKey = client.key;
  g_UniqueId = "0123456789ABCDEF";
  g_CertHex = to_hex((unsigned char*)client.pem, strlen(client.pem));

  RUN_TEST("pairing with the right PIN succeeds and the host verifies the client", test_correct_pin_pairs);
  RUN_TEST("pairing with a host below version 7 hashes with SHA-1 and pads the hash with zeros",
           test_correct_pin_pairs_with_sha1);
  RUN_TEST("a wrong PIN is GS_PIN_WRONG, and the client never sends its signed secret", test_wrong_pin_is_reported_as_such);
  RUN_TEST("pairing right after a wrong PIN succeeds on a host that keeps the session like Sunshine v2025.924",
           test_pairing_after_a_wrong_pin_succeeds_on_sunshine);
  RUN_TEST("a host that doesn't know the PIN is not trusted, even when it accepts every stage",
           test_host_without_the_pin_is_not_trusted);
  RUN_TEST("a pairing secret signed with another key than the host certificate's is rejected",
           test_pairing_secret_of_another_key_is_rejected);
  RUN_TEST("the challenge response is read only with its exact length of 48 bytes",
           test_challenge_response_is_read_with_its_exact_length);
  RUN_TEST("the pairing secret is read only with its exact length of 272 bytes",
           test_pairing_secret_is_read_with_its_exact_length);
  RUN_TEST("the certificate of the host must be a whole hex string", test_certificate_must_be_hex);
  RUN_TEST("the PIN must have 4 digits", test_pin_must_have_four_digits);
  RUN_TEST("hex fields are decoded only with their exact length and hex digits", test_hex_to_bytes);
  RUN_TEST("an XML value is read after its start tag", test_xml_search_reads_the_value_after_its_start_tag);

  free(g_CertHex);
  free_identity(&client);
  free_identity(&realHost);
  free_identity(&otherKey);
  return test_summary();
}
