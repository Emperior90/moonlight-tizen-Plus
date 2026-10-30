#pragma once
// Text that the user types on the TV during a stream and that goes to the host as Unicode text, through sendText() in
// input.cpp (Module.sendText(text) in JavaScript) and LiSendUtf8TextEvent() of moonlight-common-c. The host types it
// as it is, whatever the keyboard layout of the PC, e.g. a login or a search without a USB keyboard. Since upstream
// moonlight-common-c 4a95eb3 the text travels on the keyboard channel, in order with the key presses, and since
// 0405384 Sunshine gets up to 32 bytes of it per packet without the pause of 50 ms that GameStream needs. The idea
// comes from Artemis (the keyboard of its game menu) and StreamLight 8.0.0.
//
// The text can be a password, so neither this code nor sendText() logs it, its length or any of its bytes. A text is
// sent whole or not at all: it must be well-formed UTF-8 without control characters (Enter and Tab go to the host as
// key presses) and at most kTextInputMaxBytes long. A lone surrogate of a JavaScript string can't be refused here:
// stringToUTF8() of Emscripten 1.39, which Embind converts the text with, merges it with the next character into
// another valid code point, so JavaScript refuses such a text itself (encodeURIComponent() throws on it).
// tests/native/text_input_test.cpp runs it.

#include <cstddef>
#include <cstdint>
#include <string>

// The most bytes of UTF-8 that one call sends: 1024 ASCII characters, or 341 of a script with 3 bytes per character
// (e.g. Japanese). In JavaScript, new TextEncoder().encode(text).length gives the size of a text.
constexpr size_t kTextInputMaxBytes = 1024;

// What sendText() returns, also to JavaScript
enum TextInputResult : int {
  kTextInputOk = 0,             // the text is valid (CheckTextInput()) or queued for the host (sendText())
  kTextInputNotStreaming = -1,  // no stream runs, or it is stopping
  kTextInputEmpty = -2,
  kTextInputTooLong = -3,       // more than kTextInputMaxBytes bytes
  kTextInputInvalid = -4,       // not well-formed UTF-8, or a control character
  kTextInputNotSent = -5,       // the input queue of the stream is full, or memory ran out
};

// The length of the well-formed UTF-8 sequence at text[offset] and its code point, or 0 if there is none there. The
// ranges are those of table 3-7 of the Unicode Standard, which leaves out overlong forms, the surrogates U+D800 to
// U+DFFF and everything above U+10FFFF.
inline size_t DecodeUtf8(const std::string& text, size_t offset, uint32_t* codePoint) {
  const uint8_t first = static_cast<uint8_t>(text[offset]);
  uint8_t secondMin = 0x80;
  uint8_t secondMax = 0xBF;
  size_t length;
  if (first < 0x80) {
    *codePoint = first;
    return 1;
  } else if (first >= 0xC2 && first <= 0xDF) {
    length = 2;
    *codePoint = first & 0x1F;
  } else if (first >= 0xE0 && first <= 0xEF) {
    length = 3;
    *codePoint = first & 0x0F;
    if (first == 0xE0) {
      secondMin = 0xA0;  // overlong below U+0800
    } else if (first == 0xED) {
      secondMax = 0x9F;  // a surrogate from U+D800 on
    }
  } else if (first >= 0xF0 && first <= 0xF4) {
    length = 4;
    *codePoint = first & 0x07;
    if (first == 0xF0) {
      secondMin = 0x90;  // overlong below U+10000
    } else if (first == 0xF4) {
      secondMax = 0x8F;  // above U+10FFFF
    }
  } else {
    return 0;  // a continuation byte, or a byte that never starts a sequence (C0, C1, F5 to FF)
  }

  if (text.size() - offset < length) {
    return 0;
  }
  for (size_t i = 1; i < length; i++) {
    const uint8_t next = static_cast<uint8_t>(text[offset + i]);
    if (next < (i == 1 ? secondMin : 0x80) || next > (i == 1 ? secondMax : 0xBF)) {
      return 0;
    }
    *codePoint = (*codePoint << 6) | (next & 0x3F);
  }
  return length;
}

// The C0 controls (with NUL, Tab, line feed and carriage return), DEL and the C1 controls
inline bool IsTextInputControl(uint32_t codePoint) {
  return codePoint < 0x20 || (codePoint >= 0x7F && codePoint <= 0x9F);
}

// Whether text can go to the host: kTextInputOk, or the reason why not
inline TextInputResult CheckTextInput(const std::string& text) {
  if (text.empty()) {
    return kTextInputEmpty;
  }
  if (text.size() > kTextInputMaxBytes) {
    return kTextInputTooLong;
  }
  size_t offset = 0;
  while (offset < text.size()) {
    uint32_t codePoint = 0;
    const size_t length = DecodeUtf8(text, offset, &codePoint);
    if (length == 0 || IsTextInputControl(codePoint)) {
      return kTextInputInvalid;
    }
    offset += length;
  }
  return kTextInputOk;
}

// Send a valid text whole with send, which is LiSendUtf8TextEvent() (a parameter for the tests). Returns a
// TextInputResult.
template <typename Send>
inline int SendTextInput(const std::string& text, Send send) {
  const TextInputResult check = CheckTextInput(text);
  if (check != kTextInputOk) {
    return check;
  }
  const int result = send(text.data(), static_cast<unsigned int>(text.size()));
  if (result == 0) {
    return kTextInputOk;
  }
  // LiSendUtf8TextEvent() returns -2 before the input stream started and after it stopped, -1 when memory ran out and
  // a positive error of the queue when it is full
  return result == -2 ? kTextInputNotStreaming : kTextInputNotSent;
}
