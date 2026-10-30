// Checks sendText() of wasm/input.cpp, which JavaScript calls as Module.sendText(text) to send a text typed on the TV
// to the host, and its checks in wasm/text_input.hpp: a text goes to LiSendUtf8TextEvent() whole and byte for byte, or
// not at all when it is empty, longer than kTextInputMaxBytes, not well-formed UTF-8 or holds a control character. The
// result tells JavaScript why a text wasn't sent, also when no stream runs. Nothing is logged, since the text can be a
// password. input.cpp is included directly; the functions below stand in for moonlight-common-c.

#include "../../wasm/input.cpp"

#include "test_support.h"

#include <string>
#include <vector>

// The texts that reached LiSendUtf8TextEvent(), what it returns next, and what input.cpp logged
static std::vector<std::string> sentTexts;
static int nextSendResult = 0;
static int logCalls = 0;

MoonlightInstance* g_Instance = nullptr;

int LiSendUtf8TextEvent(const char* text, unsigned int length) {
  sentTexts.push_back(std::string(text, length));
  return nextSendResult;
}
int LiSendKeyboardEvent(short, char, char) {
  return 0;
}
int LiSendMouseButtonEvent(char, int) {
  return 0;
}
int LiSendMouseMoveEvent(short, short) {
  return 0;
}
int LiSendHighResScrollEvent(short) {
  return 0;
}
void MoonlightInstance::ClLogMessage(const char*, ...) {
  logCalls++;
}
MessageResult stopStream() {
  return MessageResult();
}
void toggleStats() {}

static void Reset() {
  sentTexts.clear();
  nextSendResult = 0;
  logCalls = 0;
}

// Send text and check that it went to the host whole (CHECK_EQ() evaluates its arguments twice, so the result of
// sendText() is kept first)
static void CheckSent(const std::string& text) {
  Reset();
  const int result = sendText(text);
  CHECK_EQ(result, static_cast<int>(kTextInputOk));
  CHECK_EQ(sentTexts.size(), 1u);
  if (sentTexts.size() == 1) {
    CHECK(sentTexts[0] == text);
  }
}

// Send text and check that it was refused for the reason and nothing went to the host
static void CheckRefused(const std::string& text, TextInputResult reason) {
  Reset();
  const int result = sendText(text);
  CHECK_EQ(result, static_cast<int>(reason));
  CHECK(sentTexts.empty());
}

static void TestTextsGoToTheHostWhole() {
  CheckSent("user@example.com");
  CheckSent("Gr\xC3\xBC\xC3\x9F" "e aus K\xC3\xB6ln");               // German umlauts and sharp s (2 bytes each)
  CheckSent("\xE3\x83\x91\xE3\x82\xB9\xE3\x83\xAF\xE3\x83\xBC\xE3\x83\x89");  // Japanese (3 bytes each)
  CheckSent("ok \xF0\x9F\x98\x80");                                      // an emoji outside the BMP (4 bytes)
  CheckSent(" ");
}

static void TestTheBoundariesOfEachLengthAreValid() {
  // The first and last code point of each length of UTF-8 that isn't a control character, and those around the
  // surrogates
  CheckSent("\x20");              // U+0020
  CheckSent("\x7E");              // U+007E
  CheckSent("\xC2\xA0");          // U+00A0, the first after the C1 controls
  CheckSent("\xDF\xBF");          // U+07FF
  CheckSent("\xE0\xA0\x80");      // U+0800
  CheckSent("\xED\x9F\xBF");      // U+D7FF
  CheckSent("\xEE\x80\x80");      // U+E000
  CheckSent("\xEF\xBF\xBF");      // U+FFFF
  CheckSent("\xF0\x90\x80\x80");  // U+10000
  CheckSent("\xF4\x8F\xBF\xBF");  // U+10FFFF
}

static void TestAnEmptyTextIsRefused() {
  CheckRefused("", kTextInputEmpty);
}

static void TestTheLengthIsLimited() {
  CHECK_EQ(kTextInputMaxBytes, 1024u);
  CheckSent(std::string(kTextInputMaxBytes, 'a'));
  CheckRefused(std::string(kTextInputMaxBytes + 1, 'a'), kTextInputTooLong);
  // The limit counts bytes: 341 characters of 3 bytes and one of 1 fit, one more byte doesn't
  std::string euros;
  for (int i = 0; i < 341; i++) {
    euros += "\xE2\x82\xAC";
  }
  CheckSent(euros + "a");
  CheckRefused(euros + "ab", kTextInputTooLong);
  // A long text is refused before its bytes are checked
  CheckRefused(std::string(kTextInputMaxBytes + 1, '\x80'), kTextInputTooLong);
}

static void TestMalformedUtf8IsRefused() {
  const std::vector<std::string> malformed = {
    "\x80",                      // a continuation byte without a start
    "a\xBF" "b",                 // a continuation byte in the middle
    "\xC0\xAF",                  // overlong '/' in 2 bytes
    "\xC1\xBF",                  // overlong U+007F in 2 bytes
    "\xE0\x80\xAF",              // overlong '/' in 3 bytes
    "\xE0\x9F\xBF",              // overlong U+07FF in 3 bytes
    "\xF0\x80\x80\xAF",          // overlong '/' in 4 bytes
    "\xF0\x8F\xBF\xBF",          // overlong U+FFFF in 4 bytes
    "\xED\xA0\x80",              // the surrogate U+D800 (as CESU-8 encodes a half of a surrogate pair)
    "\xED\xBF\xBF",              // the surrogate U+DFFF
    "\xF4\x90\x80\x80",          // U+110000, above Unicode
    "\xF5\x80\x80\x80",          // a byte that never starts a sequence
    "\xFF",
    "ab\xE2\x82",                // cut off at the end
    "\xE2\x82" "a",              // cut off in the middle
    "\xF0\x9F\x98",              // an emoji cut off
    "\xC3",                      // a start byte alone
    std::string("a\0b", 3),      // a NUL inside the text
  };
  for (const std::string& text : malformed) {
    CheckRefused(text, kTextInputInvalid);
  }
}

static void TestControlCharactersAreRefused() {
  // Enter and Tab go to the host as key presses, the other controls have no business in a typed text
  const std::vector<std::string> controls = {
    "line\nbreak", "\r", "a\tb", "\x1B", "\x01", "\x1F", "\x7F", "\xC2\x80", "\xC2\x85", "\xC2\x9F",
  };
  for (const std::string& text : controls) {
    CheckRefused(text, kTextInputInvalid);
  }
}

static void TestTheResultTellsWhyTheHostDidntGetIt() {
  // LiSendUtf8TextEvent() returns -2 without a running input stream (before the start, after the stop)
  Reset();
  nextSendResult = -2;
  const int notStreaming = sendText("hello");
  CHECK_EQ(notStreaming, static_cast<int>(kTextInputNotStreaming));
  CHECK_EQ(sentTexts.size(), 1u);
  // -1 when memory ran out, and LBQ_BOUND_EXCEEDED (2) or LBQ_INTERRUPTED (1) from the input queue
  for (int error : { -1, 1, 2 }) {
    Reset();
    nextSendResult = error;
    const int notSent = sendText("hello");
    CHECK_EQ(notSent, static_cast<int>(kTextInputNotSent));
  }
  // The numbers are those that JavaScript gets
  CHECK_EQ(static_cast<int>(kTextInputOk), 0);
  CHECK_EQ(static_cast<int>(kTextInputNotStreaming), -1);
  CHECK_EQ(static_cast<int>(kTextInputEmpty), -2);
  CHECK_EQ(static_cast<int>(kTextInputTooLong), -3);
  CHECK_EQ(static_cast<int>(kTextInputInvalid), -4);
  CHECK_EQ(static_cast<int>(kTextInputNotSent), -5);
}

static void TestNothingIsLogged() {
  Reset();
  sendText("hunter2");
  sendText("pass\nword");
  sendText(std::string(kTextInputMaxBytes + 1, 'a'));
  nextSendResult = -2;
  sendText("hunter2");
  CHECK_EQ(logCalls, 0);
}

int main() {
  test_support::RunTest("a valid text goes to the host whole and byte for byte", TestTextsGoToTheHostWhole);
  test_support::RunTest("the first and last code point of each UTF-8 length are valid",
                        TestTheBoundariesOfEachLengthAreValid);
  test_support::RunTest("an empty text is refused", TestAnEmptyTextIsRefused);
  test_support::RunTest("a text longer than 1024 bytes is refused whole", TestTheLengthIsLimited);
  test_support::RunTest("malformed UTF-8, surrogates, code points above U+10FFFF and NUL are refused",
                        TestMalformedUtf8IsRefused);
  test_support::RunTest("control characters, also line breaks and Tab, are refused", TestControlCharactersAreRefused);
  test_support::RunTest("the result tells JavaScript why the host didn't get a text, also without a stream",
                        TestTheResultTellsWhyTheHostDidntGetIt);
  test_support::RunTest("sendText() logs nothing, since the text can be a password", TestNothingIsLogged);
  return test_support::Summary();
}
