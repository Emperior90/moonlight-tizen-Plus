/*
 * This file is part of Moonlight Embedded.
 *
 * Copyright (C) 2015 Iwan Timmer
 *
 * Moonlight is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3 of the License, or
 * (at your option) any later version.
 *
 * Moonlight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Moonlight; if not, see <http://www.gnu.org/licenses/>.
 */

#include "http.h"
#include "mkcert.h"
#include "pairing.h"
#include "errors.h"

#include <sys/stat.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <openssl/sha.h>
#include <openssl/aes.h>
#include <openssl/rand.h>
#include <openssl/evp.h>
#include <openssl/x509.h>
#include <openssl/pem.h>
#include <openssl/err.h>
#include <openssl/crypto.h>

const char* gs_error;

extern X509 *g_Cert;
extern EVP_PKEY *g_PrivateKey;
extern char* g_UniqueId;
extern char* g_CertHex;

static int xml_search(char* data, size_t len, char* node, char** result) {
    char startTag[256];
    char endTag[256];
    char* startOffset;
    char* endOffset;
    
    data = strdup(data);
    
    sprintf(startTag, "<%s>", node);
    sprintf(endTag, "</%s>", node);
    
    startOffset = strstr(data, startTag);
    if (startOffset == NULL) {
        free(data);
        return GS_FAILED;
    }
    
    // Look for the end tag after the start tag, so that an end tag earlier in the answer can't cut the value short
    endOffset = strstr(startOffset + strlen(startTag), endTag);
    if (endOffset == NULL) {
        free(data);
        return GS_FAILED;
    }
    
    *endOffset = 0;
    
    *result = malloc(strlen(startOffset + strlen(startTag)) + 1);
    strcpy(*result, startOffset + strlen(startTag));
    
    free(data);
    return GS_OK;
}

static void bytes_to_hex(unsigned char *in, char *out, size_t len) {
    for (int i = 0; i < len; i++) {
        sprintf(out + i * 2, "%02x", in[i]);
    }
    out[len * 2] = 0;
}

static int hex_digit_value(char digit) {
    if (digit >= '0' && digit <= '9')
        return digit - '0';
    if (digit >= 'a' && digit <= 'f')
        return digit - 'a' + 10;
    if (digit >= 'A' && digit <= 'F')
        return digit - 'A' + 10;
    return -1;
}

// Decode a hex string of exactly 2 * len digits into len bytes. Any other length or a character that isn't a hex
// digit fails with GS_INVALID, so that a crafted answer of the host can't write past the buffer, which the earlier
// loop over strlen() of the answer did for the fixed-size buffers on the stack. The idea of decoding the fields with
// their exact length comes from the fork of mmadej20 (moonlight-tizen-modern, hex_utils.c).
static int hex_to_bytes(const char *hex, unsigned char *out, size_t len) {
    if (hex == NULL || strlen(hex) != len * 2)
        return GS_INVALID;

    for (size_t i = 0; i < len; i++) {
        int high = hex_digit_value(hex[i * 2]);
        int low = hex_digit_value(hex[i * 2 + 1]);
        if (high < 0 || low < 0)
            return GS_INVALID;
        out[i] = (unsigned char)((high << 4) | low);
    }
    return GS_OK;
}

static int sign_it(const unsigned char *msg, size_t mlen, unsigned char **sig, size_t *slen, EVP_PKEY *pkey) {
    int result = GS_FAILED;
    
    *sig = NULL;
    *slen = 0;
    
    EVP_MD_CTX *ctx = EVP_MD_CTX_create();
    if (ctx == NULL)
        return GS_FAILED;
    
    const EVP_MD *md = EVP_get_digestbyname("SHA256");
    if (md == NULL)
        goto cleanup;
    
    int rc = EVP_DigestInit_ex(ctx, md, NULL);
    if (rc != 1)
        goto cleanup;
    
    rc = EVP_DigestSignInit(ctx, NULL, md, NULL, pkey);
    if (rc != 1)
        goto cleanup;
    
    rc = EVP_DigestSignUpdate(ctx, msg, mlen);
    if (rc != 1)
        goto cleanup;
    
    size_t req = 0;
    rc = EVP_DigestSignFinal(ctx, NULL, &req);
    if (rc != 1 || !(req > 0))
        goto cleanup;
    
    *sig = OPENSSL_malloc(req);
    if (*sig == NULL)
        goto cleanup;
    
    *slen = req;
    rc = EVP_DigestSignFinal(ctx, *sig, slen);
    if (rc != 1 || req != *slen)
        goto cleanup;
    
    result = GS_OK;
    
cleanup:
    EVP_MD_CTX_destroy(ctx);
    ctx = NULL;
    
    return result;
}

static bool verifySignature(const unsigned char *data, int dataLength, unsigned char *signature, int signatureLength, X509 *cert) {
    EVP_PKEY* pubKey = X509_get_pubkey(cert);
    EVP_MD_CTX *mdctx = NULL;
    mdctx = EVP_MD_CTX_create();
    EVP_DigestVerifyInit(mdctx, NULL, EVP_sha256(), NULL, pubKey);
    EVP_DigestVerifyUpdate(mdctx, data, dataLength);
    int result = EVP_DigestVerifyFinal(mdctx, signature, signatureLength);

    EVP_PKEY_free(pubKey);
    EVP_MD_CTX_destroy(mdctx);
    
    return result > 0;
}

// The length of the hashes of the pairing: SHA-256 from server major version 7 (GFE 3.x and every Sunshine), SHA-1
// before
static int pairing_hash_length(int serverMajorVersion) {
    return serverMajorVersion >= 7 ? 32 : 20;
}

// Check that the host knows the PIN. The first hash_length bytes of its decrypted challenge response must be the hash
// of our challenge (the 16 random bytes before their encryption), the signature of the host's certificate (256 bytes
// for the 2048-bit RSA key of every host) and the secret of its pairing secret (its first 16 bytes). A host that
// encrypted with another PIN, or one that doesn't know the PIN at all and only pretends to be the host, can't produce
// it. The response must hold at least hash_length + 16 bytes, the hash and the challenge of the host. Returns GS_OK,
// GS_PIN_WRONG for a hash that doesn't match, or GS_INVALID or GS_FAILED when the hash can't be computed. Ported from
// moonlight-qt (NvPairingManager::pair) and moonlight-tv (gs_pair in libgamestream/src/client.c), which report the
// mismatch as a wrong PIN.
static int verify_server_challenge_response(int serverMajorVersion, const unsigned char *client_challenge,
                                            X509 *server_cert, const unsigned char *server_secret,
                                            const unsigned char *response, size_t response_length) {
    const int hash_length = pairing_hash_length(serverMajorVersion);
    const ASN1_BIT_STRING *signature = NULL;
    unsigned char expected[EVP_MAX_MD_SIZE];
    unsigned int expected_length = 0;
    int ok;

    if (response_length < (size_t)hash_length + 16)
        return GS_INVALID;

    X509_get0_signature(&signature, NULL, server_cert);
    if (signature == NULL || signature->data == NULL || signature->length <= 0)
        return GS_INVALID;

    EVP_MD_CTX *ctx = EVP_MD_CTX_create();
    if (ctx == NULL)
        return GS_OUT_OF_MEMORY;
    ok = EVP_DigestInit_ex(ctx, serverMajorVersion >= 7 ? EVP_sha256() : EVP_sha1(), NULL) == 1 &&
         EVP_DigestUpdate(ctx, client_challenge, 16) == 1 &&
         EVP_DigestUpdate(ctx, signature->data, (size_t)signature->length) == 1 &&
         EVP_DigestUpdate(ctx, server_secret, 16) == 1 &&
         EVP_DigestFinal_ex(ctx, expected, &expected_length) == 1 &&
         expected_length == (unsigned int)hash_length;
    EVP_MD_CTX_destroy(ctx);
    if (!ok)
        return GS_FAILED;

    return CRYPTO_memcmp(expected, response, (size_t)hash_length) == 0 ? GS_OK : GS_PIN_WRONG;
}

X509* get_cert(PHTTP_DATA data) {
    char *pemcerthex;

    if (xml_search(data->memory, data->size, "plaincert", &pemcerthex) != GS_OK)
        return NULL;

    // Convert cert from hex string to the PEM string and null terminate
    size_t hexstrlen = strlen(pemcerthex);
    char *pemcert = hexstrlen % 2 == 0 ? malloc(hexstrlen / 2 + 1) : NULL;
    if (pemcert == NULL || hex_to_bytes(pemcerthex, (unsigned char*)pemcert, hexstrlen / 2) != GS_OK) {
        free(pemcert);
        free(pemcerthex);
        return NULL;
    }
    pemcert[hexstrlen / 2] = 0;
    free(pemcerthex);

    // pemcert is referenced, but NOT copied!
    BIO* bio = BIO_new_mem_buf(pemcert, -1);

    if (bio) {
        X509* cert = PEM_read_bio_X509(bio, NULL, NULL, NULL);
        BIO_free_all(bio);
        free(pemcert);
        return cert;
    }
    else {
        free(pemcert);
        return NULL;
    }
}

static char* x509_to_curl_ppk_string(X509* x509) {
    BIO* bio = BIO_new(BIO_s_mem());

    // Get x509 public key alone in DER format
    EVP_PKEY* pubkey = X509_get_pubkey(x509);
    i2d_PUBKEY_bio(bio, pubkey);
    EVP_PKEY_free(pubkey);

    BUF_MEM* mem;
    BIO_get_mem_ptr(bio, &mem);

    // SHA256 hash the resulting DER string
    unsigned char pubkeyhash[32];
    SHA256((unsigned char*)mem->data, mem->length, pubkeyhash);
    BIO_free(bio);

    // Base64-encode the resulting SHA256 hash
    bio = BIO_new(BIO_s_mem());
    BIO* b64 = BIO_new(BIO_f_base64());
    bio = BIO_push(b64, bio);
    BIO_set_flags(bio, BIO_FLAGS_BASE64_NO_NL);
    BIO_write(bio, pubkeyhash, sizeof(pubkeyhash));
    BIO_flush(bio);

    BIO_get_mem_ptr(bio, &mem);

    // Assemble the final curl PPK string
    const char* prefix = "sha256//";
    char* ret = malloc(strlen(prefix) + mem->length + 1);
    memcpy(ret, prefix, strlen(prefix));
    memcpy(&ret[strlen(prefix)], mem->data, mem->length);
    ret[strlen(prefix) + mem->length] = 0;

    BIO_free_all(bio);

    return ret;
}

// Safely wraps IPv6 addresses in brackets for URL construction.
// IPv4 addresses and DNS hostnames do not contain colons, so they are untouched.
static void format_address_for_url(const char* address, char* host_for_url, size_t max_len) {
  if (strchr(address, ':') != NULL && address[0] != '[') {
      snprintf(host_for_url, max_len, "[%s]", address);
  } else {
      snprintf(host_for_url, max_len, "%s", address);
  }
}

static unsigned short sanitize_http_port(unsigned short httpPort) {
  if (httpPort == 0) {
    return 47989;
  }

  if (httpPort <= 5 || httpPort > 65514) {
    return 47989;
  }

  return httpPort;
}

int gs_unpair(const char* address, unsigned short httpPort) {
  int ret = GS_OK;
  char url[4096];
  unsigned short sanitizedHttpPort = sanitize_http_port(httpPort);
  PHTTP_DATA data = http_create_data();
  if (data == NULL)
    return GS_OUT_OF_MEMORY;

  char host_for_url[256];
  format_address_for_url(address, host_for_url, sizeof(host_for_url));

  snprintf(url, sizeof(url), "http://%s:%u/unpair?uniqueid=%s", host_for_url, sanitizedHttpPort, g_UniqueId);
  ret = http_request(url, NULL, data);

  http_free_data(data);
  return ret;
}

// Make the host drop its pairing session after a wrong PIN. Sunshine (at least up to v2025.924) keeps the session of a
// client until clientpairingsecret or a failed stage removes it, and it has no /unpair route, so the next pairing
// attempt would get the stale session back and fail with 'Out of order call to getservercert'. A pairing secret of
// random bytes, not signed with our key, fails the check of the host (paired 0) and removes the session, while no valid
// signed secret leaves the client. The answer doesn't matter.
static void abandon_pairing_session(const char* host_for_url, unsigned short httpPort, PHTTP_DATA data) {
  unsigned char random_secret[16 + 256];
  char random_secret_hex[(16 + 256) * 2 + 1];
  char url[4096];

  RAND_bytes(random_secret, sizeof(random_secret));
  bytes_to_hex(random_secret, random_secret_hex, sizeof(random_secret));
  snprintf(url, sizeof(url), "http://%s:%u/pair?uniqueid=%s&devicename=roth&updateState=1&clientpairingsecret=%s", host_for_url, httpPort, g_UniqueId, random_secret_hex);
  http_request(url, NULL, data);
}

int gs_pair(int serverMajorVersion, const char* address, unsigned short httpPort, const char* pin, char** curl_ppk_string) {
  int ret = GS_OK;
  char* result = NULL;
  X509* server_cert = NULL;
  unsigned char* signature = NULL;
  char url[4096];
  unsigned short sanitizedHttpPort = sanitize_http_port(httpPort);
  unsigned char salt_data[16];
  char salt_hex[33];

  *curl_ppk_string = NULL;
  // The PIN is the 4 digits that the user enters on the host, which the AES key below is derived from
  if (pin == NULL || strlen(pin) != 4)
    return GS_INVALID;

  RAND_bytes(salt_data, 16);
  bytes_to_hex(salt_data, salt_hex, 16);

  char host_for_url[256];
  format_address_for_url(address, host_for_url, sizeof(host_for_url));

  snprintf(url, sizeof(url), "http://%s:%u/pair?uniqueid=%s&devicename=roth&updateState=1&phrase=getservercert&salt=%s&clientcert=%s", host_for_url, sanitizedHttpPort, g_UniqueId, salt_hex, g_CertHex);
  PHTTP_DATA data = http_create_data();
  if (data == NULL)
    return GS_OUT_OF_MEMORY;
  else if ((ret = http_request(url, NULL, data)) != GS_OK)
    goto cleanup;

  if ((ret = xml_search(data->memory, data->size, "paired", &result)) != GS_OK)
    goto cleanup;

  if (strcmp(result, "1") != 0) {
    ret = GS_FAILED;
    goto cleanup;
  }

  free(result);
  result = NULL;
  server_cert = get_cert(data);
  if (server_cert == NULL) {
    ret = GS_FAILED;
    goto cleanup;
  }

  unsigned char salt_pin[20];
  unsigned char aes_key_hash[32];
  AES_KEY enc_key, dec_key;
  memcpy(salt_pin, salt_data, 16);
  memcpy(salt_pin+16, pin, 4);

  int hash_length = pairing_hash_length(serverMajorVersion);
  if (serverMajorVersion >= 7)
    SHA256(salt_pin, 20, aes_key_hash);
  else
    SHA1(salt_pin, 20, aes_key_hash);

  AES_set_encrypt_key((unsigned char *)aes_key_hash, 128, &enc_key);
  AES_set_decrypt_key((unsigned char *)aes_key_hash, 128, &dec_key);

  unsigned char challenge_data[16];
  unsigned char challenge_enc[16];
  char challenge_hex[33];
  RAND_bytes(challenge_data, 16);
  AES_encrypt(challenge_data, challenge_enc, &enc_key);
  bytes_to_hex(challenge_enc, challenge_hex, 16);

  snprintf(url, sizeof(url), "http://%s:%u/pair?uniqueid=%s&devicename=roth&updateState=1&clientchallenge=%s", host_for_url, sanitizedHttpPort, g_UniqueId, challenge_hex);
  if ((ret = http_request(url, NULL, data)) != GS_OK)
    goto cleanup;

  free(result);
  result = NULL;
  if ((ret = xml_search(data->memory, data->size, "paired", &result)) != GS_OK)
    goto cleanup;

  if (strcmp(result, "1") != 0) {
    ret = GS_FAILED;
    goto cleanup;
  }

  free(result);
  result = NULL;
  if (xml_search(data->memory, data->size, "challengeresponse", &result) != GS_OK) {
    ret = GS_INVALID;
    goto cleanup;
  }

  // The hash of the host (hash_length bytes) and its challenge (16 bytes), padded to 48 bytes for AES
  unsigned char challenge_response_data_enc[48];
  unsigned char challenge_response_data[48];
  if (hex_to_bytes(result, challenge_response_data_enc, sizeof(challenge_response_data_enc)) != GS_OK) {
    ret = GS_INVALID;
    goto cleanup;
  }

  for (int i = 0; i < 48; i += 16) {
    AES_decrypt(&challenge_response_data_enc[i], &challenge_response_data[i], &dec_key);
  }

  unsigned char client_secret_data[16];
  RAND_bytes(client_secret_data, 16);

  // The signature of our own certificate, 256 bytes for its 2048-bit RSA key (mkcert.c)
  const ASN1_BIT_STRING *asnSignature = NULL;
  X509_get0_signature(&asnSignature, NULL, g_Cert);
  if (asnSignature == NULL || asnSignature->data == NULL || asnSignature->length != 256) {
    ret = GS_FAILED;
    goto cleanup;
  }

  unsigned char challenge_response[16 + 256 + 16];
  unsigned char challenge_response_hash[32];
  unsigned char challenge_response_hash_enc[32];
  char challenge_response_hex[65];
  memset(challenge_response_hash, 0, sizeof(challenge_response_hash));
  memcpy(challenge_response, challenge_response_data + hash_length, 16);
  memcpy(challenge_response + 16, asnSignature->data, 256);
  memcpy(challenge_response + 16 + 256, client_secret_data, 16);
  if (serverMajorVersion >= 7)
    SHA256(challenge_response, 16 + 256 + 16, challenge_response_hash);
  else
    SHA1(challenge_response, 16 + 256 + 16, challenge_response_hash);

  for (int i = 0; i < 32; i += 16) {
    AES_encrypt(&challenge_response_hash[i], &challenge_response_hash_enc[i], &enc_key);
  }
  bytes_to_hex(challenge_response_hash_enc, challenge_response_hex, 32);

  snprintf(url, sizeof(url), "http://%s:%u/pair?uniqueid=%s&devicename=roth&updateState=1&serverchallengeresp=%s", host_for_url, sanitizedHttpPort, g_UniqueId, challenge_response_hex);
  if ((ret = http_request(url, NULL, data)) != GS_OK)
    goto cleanup;

  free(result);
  result = NULL;
  if ((ret = xml_search(data->memory, data->size, "paired", &result)) != GS_OK)
    goto cleanup;

  if (strcmp(result, "1") != 0) {
    ret = GS_FAILED;
    goto cleanup;
  }

  free(result);
  result = NULL;
  if (xml_search(data->memory, data->size, "pairingsecret", &result) != GS_OK) {
    ret = GS_INVALID;
    goto cleanup;
  }

  // The secret of the host (16 bytes) and its signature with the key of the host's certificate (256 bytes)
  unsigned char pairing_secret[16 + 256];
  if (hex_to_bytes(result, pairing_secret, sizeof(pairing_secret)) != GS_OK) {
    ret = GS_INVALID;
    goto cleanup;
  }

  if (!verifySignature(pairing_secret, 16, pairing_secret+16, 256, server_cert)) {
    ret = GS_FAILED;
    goto cleanup;
  }

  // Only a host that knows the PIN gets our signed secret and is trusted with its certificate from now on
  if ((ret = verify_server_challenge_response(serverMajorVersion, challenge_data, server_cert, pairing_secret,
                                              challenge_response_data, sizeof(challenge_response_data))) != GS_OK) {
    // The host is waiting for our pairing secret: let it end the session, so that the next attempt starts afresh
    if (ret == GS_PIN_WRONG)
      abandon_pairing_session(host_for_url, sanitizedHttpPort, data);
    goto cleanup;
  }

  size_t s_len;
  if (sign_it(client_secret_data, 16, &signature, &s_len, g_PrivateKey) != GS_OK || s_len != 256) {
    ret = GS_FAILED;
    goto cleanup;
  }

  unsigned char client_pairing_secret[16 + 256];
  char client_pairing_secret_hex[(16 + 256) * 2 + 1];
  memcpy(client_pairing_secret, client_secret_data, 16);
  memcpy(client_pairing_secret + 16, signature, 256);
  bytes_to_hex(client_pairing_secret, client_pairing_secret_hex, 16 + 256);

  snprintf(url, sizeof(url), "http://%s:%u/pair?uniqueid=%s&devicename=roth&updateState=1&clientpairingsecret=%s", host_for_url, sanitizedHttpPort, g_UniqueId, client_pairing_secret_hex);
  if ((ret = http_request(url, NULL, data)) != GS_OK)
    goto cleanup;

  free(result);
  result = NULL;
  if ((ret = xml_search(data->memory, data->size, "paired", &result)) != GS_OK)
    goto cleanup;

  if (strcmp(result, "1") != 0) {
    ret = GS_FAILED;
    goto cleanup;
  }

  *curl_ppk_string = x509_to_curl_ppk_string(server_cert);

  cleanup:
  if (ret != GS_OK)
    gs_unpair(address, sanitizedHttpPort);
  
  if (result != NULL)
    free(result);

  if (server_cert != NULL)
    X509_free(server_cert);

  // sign_it() allocates the signature, also when it fails afterwards
  if (signature != NULL)
    OPENSSL_free(signature);

  http_free_data(data);

  return ret;
}
