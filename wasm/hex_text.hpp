#pragma once
// Writes bytes as hex digits, for the text of the client certificate that the pairing sends to the host (LoadCert() in
// http.cpp fills g_CertHex with it, gs_pair() in libgamestream/pairing.c puts it into the request). C and C++ can
// include this header, and tests/native/hex_text_test.cpp runs it.
//
// LoadCert() converted each byte with sprintf("%02x") from a char, which is signed here: a byte of 0x80 or more was
// widened to a negative int and printed eight digits (ffffff80) instead of two. For one of the last three bytes of the
// certificate that wrote 2 to 6 bytes past the end of the buffer, and anywhere else the byte came out as ff. A
// certificate that the app wrote is ASCII, so this took a damaged stored one with such a byte outside its base64
// block, e.g. a character that isn't ASCII after the END line.

#include <stdbool.h>
#include <stddef.h>

// Writes the `length` bytes at `bytes` as two lowercase hex digits each, followed by a terminating zero, to `hex`,
// which holds `hexSize` bytes. Returns false and writes an empty text (where there is room for one) when the buffer
// is missing or holds less than length * 2 + 1 bytes: it never writes past hexSize.
static inline bool WriteHexText(const char* bytes, size_t length, char* hex, size_t hexSize) {
  static const char kDigits[] = "0123456789abcdef";
  if (hex == NULL || hexSize == 0) {
    return false;
  }
  if (length > (hexSize - 1) / 2) {
    hex[0] = '\0';
    return false;
  }
  for (size_t i = 0; i < length; i++) {
    // Through unsigned char, so that every byte is 0 to 255 whatever the sign of char
    const unsigned char byte = (unsigned char)bytes[i];
    hex[i * 2] = kDigits[byte >> 4];
    hex[i * 2 + 1] = kDigits[byte & 0x0F];
  }
  hex[length * 2] = '\0';
  return true;
}
