#pragma once
// Controller type that the stream announces to the host in the controller arrival event (wasm/gamepad.cpp). Sunshine
// picks the controller it emulates from it, e.g. a DualShock 4 with PlayStation button prompts in games for a
// PlayStation controller, and an Xbox controller for an unknown one. The type comes from the Gamepad.id that the browser
// reports, or from the setting "Controller type sent to the PC" when it isn't Auto.
//
// getControllerType() in wasm/platform/gamepad.js applies the same rules for the menus, which log and show the type in
// System information. tests/fixtures/controller-types.tsv lists ids with their types, which the native and the unit
// tests check against both, so keep the two in sync. The header has no other dependencies, so the native tests can
// check it on its own (tests/native/controller_type_test.cpp).

#include <cctype>
#include <cstdint>
#include <string>

#include <Limelight.h>

namespace controller_type_detail {

// Read 4 hex digits of a lower-cased text at a position, e.g. "054c". Returns -1 if they aren't there.
inline int ReadHex4(const std::string& text, size_t position) {
  if (position + 4 > text.size()) {
    return -1;
  }
  int value = 0;
  for (size_t i = position; i < position + 4; ++i) {
    const char c = text[i];
    if (c >= '0' && c <= '9') {
      value = value * 16 + (c - '0');
    } else if (c >= 'a' && c <= 'f') {
      value = value * 16 + (c - 'a' + 10);
    } else {
      return -1;
    }
  }
  return value;
}

// Read the USB vendor id from a lower-cased Gamepad.id. Chromium on Linux, which the browser of the TV is based on,
// writes it as "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)", and other Chromium
// builds as "054c-0ce6-DualSense Wireless Controller". Returns -1 if the id names no vendor, e.g. because the
// Emscripten event struct cut a long id before it.
inline int GetVendorId(const std::string& lowerId) {
  const size_t vendor = lowerId.find("vendor:");
  if (vendor != std::string::npos) {
    size_t position = vendor + 7;
    while (position < lowerId.size() && lowerId[position] == ' ') {
      ++position;
    }
    return ReadHex4(lowerId, position);
  }
  if (lowerId.size() >= 10 && lowerId[4] == '-' && lowerId[9] == '-' && ReadHex4(lowerId, 5) >= 0) {
    return ReadHex4(lowerId, 0);
  }
  return -1;
}

}  // namespace controller_type_detail

// Detect the controller family from Gamepad.id: PlayStation, Xbox, Nintendo or unknown. The vendor id decides first:
// Sony (054c), Microsoft (045e), Nintendo (057e), and 8BitDo (2dc8), whose controllers report their own vendor id in
// their X-input mode with the Xbox layout and in their D-input mode, whose non-standard layout the app can't map anyway,
// while their Switch and macOS modes report the vendor id of Nintendo or Sony. Without one of these vendors, a name
// hint decides, e.g. "HORIPAD FPS for PlayStation 4" or "Generic X-Box pad", the name the Linux driver gives the
// Xbox-compatible controllers of other vendors. Everything else is unknown, for which the host emulates an Xbox
// controller.
inline uint8_t GetControllerType(const char* id) {
  // Guard against null or empty id strings
  if (!id || !*id) {
    return LI_CTYPE_UNKNOWN;
  }

  // Lower-case the id once so all checks are case-insensitive
  std::string lower(id);
  for (char& c : lower) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }

  switch (controller_type_detail::GetVendorId(lower)) {
    case 0x054c: // Sony
      return LI_CTYPE_PS;
    case 0x045e: // Microsoft
    case 0x2dc8: // 8BitDo
      return LI_CTYPE_XBOX;
    case 0x057e: // Nintendo
      return LI_CTYPE_NINTENDO;
    default:
      break;
  }

  // Helper for simple substring search on the lower-cased id
  const auto contains = [&](const char* needle) {
    return lower.find(needle) != std::string::npos;
  };

  if (contains("dualsense") || contains("dualshock") || contains("playstation") ||
      contains("sony interactive entertainment") || contains("sony computer entertainment")) {
    return LI_CTYPE_PS;
  }
  if (contains("xbox") || contains("x-box") || contains("8bitdo")) {
    return LI_CTYPE_XBOX;
  }
  if (contains("nintendo") || contains("joy-con")) {
    return LI_CTYPE_NINTENDO;
  }

  return LI_CTYPE_UNKNOWN;
}

// Name of a controller type for the log and the settings, the same names as getControllerType() in
// platform/gamepad.js and the values of the setting "Controller type sent to the PC"
inline const char* GetControllerTypeName(uint8_t type) {
  switch (type) {
    case LI_CTYPE_PS:
      return "PlayStation";
    case LI_CTYPE_XBOX:
      return "Xbox";
    case LI_CTYPE_NINTENDO:
      return "Nintendo";
    default:
      return "Unknown";
  }
}

// Controller type chosen with the setting "Controller type sent to the PC" (the value the frontend sends with the
// start request): LI_CTYPE_XBOX, LI_CTYPE_PS or LI_CTYPE_NINTENDO, or LI_CTYPE_UNKNOWN for Auto, which detects the
// type of each controller from its id. An unexpected value counts as Auto.
inline uint8_t GetControllerTypeFromSetting(const std::string& setting) {
  if (setting == "Xbox") {
    return LI_CTYPE_XBOX;
  } else if (setting == "PlayStation") {
    return LI_CTYPE_PS;
  } else if (setting == "Nintendo") {
    return LI_CTYPE_NINTENDO;
  }
  return LI_CTYPE_UNKNOWN;
}
