// Checks the hex text of the client certificate (wasm/hex_text.hpp, which LoadCert() of wasm/http.cpp fills g_CertHex
// with for the pairing request): every byte gives two lowercase digits, also the bytes of 0x80 and more that a char,
// which is signed on this platform, holds as negative values, and nothing is written past the buffer. Before,
// sprintf("%02x") of such a char printed eight digits (ffffff80): for one of the last three bytes of the certificate
// that ran 2 to 6 bytes past the end of the buffer on the heap, at the start of the app, and anywhere else the byte
// came out as ff. A certificate that the app wrote is ASCII, and its text is the same as before.
// The buffers are on the heap in their exact size, so the address sanitizer of run.sh sees a write past them, and the
// second test keeps guard bytes behind the buffer as well, for a build without it.

#include "hex_text.hpp"

#include "test_support.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// The hex text of the bytes, from a buffer on the heap of exactly the size that LoadCert() gives it
static std::string HexOf(const std::string& bytes) {
  std::vector<char> hex(bytes.size() * 2 + 1, 'x');
  CHECK(WriteHexText(bytes.data(), bytes.size(), hex.data(), hex.size()));
  CHECK_EQ(hex.back(), '\0');
  return std::string(hex.data());
}

static void EveryByteGivesTwoDigits() {
  // The lowest and the highest byte that a signed char holds as a positive value, and as a negative one
  CHECK_EQ(HexOf(std::string("\x00\x7F\x80\xFF", 4)), std::string("007f80ff"));
  CHECK_EQ(HexOf(std::string("\x00", 1)), std::string("00"));
  CHECK_EQ(HexOf("\x7F"), std::string("7f"));
  CHECK_EQ(HexOf("\x80"), std::string("80"));
  CHECK_EQ(HexOf("\xFF"), std::string("ff"));
  CHECK_EQ(HexOf(""), std::string(""));
  // All 256 values, each one against its value printed as an unsigned number
  std::string all;
  std::string expected;
  for (int value = 0; value < 256; value++) {
    all.push_back((char)value);
    char digits[3];
    std::snprintf(digits, sizeof(digits), "%02x", (unsigned int)value);
    expected += digits;
  }
  const std::string hex = HexOf(all);
  CHECK_EQ(hex.size(), (size_t)512);
  CHECK_EQ(hex, expected);
}

static void BytesOf0x80AndMoreStayWithinTheBuffer() {
  // A stored certificate with a character that isn't ASCII behind its END line (UTF-8: two bytes of 0x80 and more), as
  // each of its last three bytes, and as all of them
  const std::string pem = "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n";
  for (const std::string& tail : {std::string("\xC3\xA9"), std::string("\xC3\xA9\n"), std::string("\xC3\xA9\n\n"),
                                  std::string("\xFF\xFF\xFF"), std::string("\x80")}) {
    const std::string text = pem + tail;
    const size_t hexSize = text.size() * 2 + 1;
    // Guard bytes behind the buffer that LoadCert() allocates
    std::vector<char> hex(hexSize + 16, 'G');
    CHECK(WriteHexText(text.data(), text.size(), hex.data(), hexSize));
    CHECK_EQ(std::strlen(hex.data()), text.size() * 2);
    for (size_t i = hexSize; i < hex.size(); i++) {
      CHECK_EQ(hex[i], 'G');
    }
    // The same in a buffer of the exact size, and two digits per byte up to the last one
    const std::string digits = HexOf(text);
    CHECK_EQ(digits.size(), text.size() * 2);
    CHECK_EQ(digits.substr(0, 10), std::string("2d2d2d2d2d"));
    char last[3];
    std::snprintf(last, sizeof(last), "%02x", (unsigned int)(unsigned char)text.back());
    CHECK_EQ(digits.substr(digits.size() - 2), std::string(last));
    CHECK(digits.find("ffffff") == std::string::npos || tail == "\xFF\xFF\xFF");
  }
}

static void AsciiCertificateKeepsItsText() {
  // What the pairing sent before: sprintf("%02x") of each char, which is right for the ASCII of a PEM certificate
  const std::string pem =
    "-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIUQ0Zz+/abc123XYZ=\r\n-----END CERTIFICATE-----\n\t ~";
  std::string before;
  for (const char character : pem) {
    char digits[16];
    std::sprintf(digits, "%02x", character);
    before += digits;
  }
  CHECK_EQ(HexOf(pem), before);
}

static void BufferThatIsTooSmallIsNotWrittenPast() {
  const char bytes[] = {'\x12', '\xAB', '\xFF'};
  // One byte short of the 7 that three bytes need: nothing but an empty text, and no byte past the size given
  std::vector<char> hex(6 + 8, 'G');
  CHECK(!WriteHexText(bytes, sizeof(bytes), hex.data(), 6));
  CHECK_EQ(hex[0], '\0');
  for (size_t i = 1; i < hex.size(); i++) {
    CHECK_EQ(hex[i], 'G');
  }
  // Exactly 7 fit
  CHECK(WriteHexText(bytes, sizeof(bytes), hex.data(), 7));
  CHECK_EQ(std::string(hex.data()), std::string("12abff"));
  CHECK_EQ(hex[7], 'G');
  // No room at all, and no buffer (malloc() failed): nothing is written
  char none = 'G';
  CHECK(!WriteHexText(bytes, sizeof(bytes), &none, 0));
  CHECK_EQ(none, 'G');
  CHECK(!WriteHexText(bytes, sizeof(bytes), nullptr, 7));
  // A length that would overflow the size calculation is refused as well
  char small[4] = {'G', 'G', 'G', 'G'};
  CHECK(!WriteHexText(bytes, (size_t)-1, small, sizeof(small)));
  CHECK_EQ(small[0], '\0');
  CHECK_EQ(small[1], 'G');
}

int main() {
  test_support::RunTest("every byte gives two lowercase hex digits: 0x00, 0x7F, 0x80, 0xFF and all 256 values",
                        EveryByteGivesTwoDigits);
  test_support::RunTest("bytes of 0x80 and more at the end of a certificate stay within the buffer",
                        BytesOf0x80AndMoreStayWithinTheBuffer);
  test_support::RunTest("the hex text of an ASCII certificate is the one that was sent before",
                        AsciiCertificateKeepsItsText);
  test_support::RunTest("a buffer that is too small gets an empty text and no byte past its size",
                        BufferThatIsTooSmallIsNotWrittenPast);
  return test_support::Summary();
}
