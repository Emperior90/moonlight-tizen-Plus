#pragma once
// Host build of wasm/gamepad.cpp for the native tests. The Emscripten and Samsung headers come from tests/native/stubs,
// and gamepad.cpp is included directly, so a test can read and reset its file-level state (slotState, sentState,
// mouseEmulationActive). The functions below stand in for moonlight-common-c and the rest of the app: they record
// what gamepad.cpp sends to the host and logs, and the EM_ASM hook answers the browser Gamepad API from the simulated
// slots. LiGetMillis() returns a simulated clock that each Poll() advances, which the send-on-change refresh, the
// mouse emulation toggle and the scroll speed all measure time with.

#include "../../wasm/gamepad.cpp"

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace harness {

// A controller packet sent to the host with LiSendMultiControllerEvent()
struct PadPacket {
  short controller;
  short activeMask;
  int buttons;
  unsigned char leftTrigger;
  unsigned char rightTrigger;
  short leftStickX;
  short leftStickY;
  short rightStickX;
  short rightStickY;
};

// An arrival announced to the host with LiSendControllerArrivalEvent()
struct Arrival {
  int controller;
  int activeMask;
  int type;
  uint32_t supportedButtons;
  int capabilities;
};

// A mouse button event sent with LiSendMouseButtonEvent()
struct MouseButton {
  char action;
  int button;
};

std::vector<PadPacket> padPackets;
std::vector<Arrival> arrivals;
std::vector<MouseButton> mouseButtons;
std::vector<std::pair<int, int>> mouseMoves; // the deltas of LiSendMouseMoveEvent()
std::vector<int> scrolls; // the amounts of LiSendHighResScrollEvent(), 120 per notch, positive scrolls up
std::vector<int> horizontalScrolls; // the amounts of LiSendHighResHScrollEvent(), positive scrolls right
std::vector<std::string> postedToJs;
std::vector<std::string> logMessages; // what gamepad.cpp logged with MoonlightInstance::ClLogMessage()
int stopStreamCalls = 0;
int toggleStatsCalls = 0;
int failNextPackets = 0; // number of upcoming controller packets that fail like a full input queue
int failNextArrivals = 0; // number of upcoming arrival events that fail like a full input queue
int failNextMouseButtons = 0; // number of upcoming mouse button events that fail like a full input queue
int horizontalScrollResult = 0; // what LiSendHighResHScrollEvent() returns: LI_ERR_UNSUPPORTED on a GFE host
uint64_t nowMs = 1000; // what LiGetMillis() returns
bool useFallbackPath = false; // answer the batched read with -2, so gamepad.cpp uses the single Emscripten calls
bool hasRumbleActuator = false; // what the rumble probe of the arrival reports
int numSlots = 4; // number of gamepad slots the browser exposes
EmscriptenGamepadEvent slots[kMaxControllers];
bool slotPresent[kMaxControllers];

// The instance that the member functions of gamepad.cpp are called on. They only use file-level state of gamepad.cpp,
// so the instance is never constructed (the vptr check of UBSan is off for this reason, see run.sh).
inline MoonlightInstance* Instance() {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  return reinterpret_cast<MoonlightInstance*>(storage);
}

// Clear what was recorded and the state of gamepad.cpp, as at the start of a new stream with the given settings. The
// controller type is that of the setting "Controller type sent to the PC", LI_CTYPE_UNKNOWN for Auto.
inline void Reset(bool rumbleFeedback = false, bool mouseEmulation = false, bool flipAB = false, bool flipXY = false,
                  uint8_t controllerType = LI_CTYPE_UNKNOWN) {
  padPackets.clear();
  arrivals.clear();
  mouseButtons.clear();
  mouseMoves.clear();
  scrolls.clear();
  horizontalScrolls.clear();
  postedToJs.clear();
  logMessages.clear();
  stopStreamCalls = 0;
  toggleStatsCalls = 0;
  failNextPackets = 0;
  failNextArrivals = 0;
  failNextMouseButtons = 0;
  horizontalScrollResult = 0;
  useFallbackPath = false;
  hasRumbleActuator = false;
  numSlots = 4;
  std::memset(slots, 0, sizeof(slots));
  std::memset(slotPresent, 0, sizeof(slotPresent));
  for (auto& slot : slotState) {
    slot = {};
  }
  for (auto& sent : sentState) {
    sent = {};
  }
  // What the app does when a stream starts
  Instance()->HandleGamepadInputState(rumbleFeedback, mouseEmulation, flipAB, flipXY, controllerType);
}

// Plug in a controller at a slot. The id is cut to 63 bytes plus NUL like the Emscripten event struct does.
inline void Connect(int index, const char* id = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)",
                    const char* mapping = "standard", int buttons = 17, int axes = 4) {
  EmscriptenGamepadEvent& event = slots[index];
  std::memset(&event, 0, sizeof(event));
  event.timestamp = 100.0 + index;
  event.numButtons = buttons;
  event.numAxes = axes;
  event.connected = EM_TRUE;
  event.index = index;
  std::strncpy(event.id, id, sizeof(event.id) - 1);
  std::strncpy(event.mapping, mapping, sizeof(event.mapping) - 1);
  slotPresent[index] = true;
}

inline void Disconnect(int index) {
  slotPresent[index] = false;
}

inline void SetButton(int index, int button, bool pressed) {
  slots[index].digitalButton[button] = pressed ? EM_TRUE : EM_FALSE;
  slots[index].analogButton[button] = pressed ? 1.0 : 0.0;
}

// Run one poll of the stream after the given time, in the clock of LiGetMillis()
inline void Poll(uint64_t advanceMs = 5) {
  nowMs += advanceMs;
  Instance()->PollGamepads();
}

// Poll every 5 ms like the input thread, for the given time of the simulated clock
inline void PollFor(int milliseconds) {
  for (int elapsed = 0; elapsed < milliseconds; elapsed += 5) {
    Poll(5);
  }
}

// Answer the main-thread EM_ASM blocks of gamepad.cpp: the batched read of all slots and the rumble probe
inline int AnswerEmAsm(const char* code, va_list args) {
  if (std::strstr(code, "__fillGamepadEventData")) {
    if (useFallbackPath) {
      return -2;
    }
    EmscriptenGamepadEvent* events = va_arg(args, EmscriptenGamepadEvent*);
    int* present = va_arg(args, int*);
    const int maxSlots = va_arg(args, int);
    const int eventSize = va_arg(args, int);
    if (eventSize != static_cast<int>(sizeof(EmscriptenGamepadEvent))) {
      std::printf("  # unexpected event size %d\n", eventSize);
      return -1;
    }
    const int count = std::min(numSlots, maxSlots);
    for (int i = 0; i < count; ++i) {
      if (slotPresent[i]) {
        events[i] = slots[i];
        present[i] = 1;
      }
    }
    return count;
  }
  if (std::strstr(code, "vibrationActuator")) {
    return hasRumbleActuator ? 1 : 0;
  }
  std::printf("  # unexpected EM_ASM block: %.60s\n", code);
  return 0;
}

// Answer the single Emscripten gamepad calls of the fallback path
inline int SampleGamepads() {
  return EMSCRIPTEN_RESULT_SUCCESS;
}
inline int CountGamepads() {
  return numSlots;
}
inline int GamepadStatus(int index, EmscriptenGamepadEvent* event) {
  if (index < 0 || index >= numSlots) {
    return EMSCRIPTEN_RESULT_INVALID_PARAM;
  }
  if (!slotPresent[index]) {
    return EMSCRIPTEN_RESULT_NO_DATA;
  }
  *event = slots[index];
  return EMSCRIPTEN_RESULT_SUCCESS;
}

inline void Install() {
  em_asm_sync_hook() = AnswerEmAsm;
  em_gamepad_hook() = { SampleGamepads, CountGamepads, GamepadStatus };
}

}  // namespace harness

// Stand-ins for moonlight-common-c (declared in Limelight.h) and the rest of the app (moonlight_wasm.hpp)
int LiSendMultiControllerEvent(short controllerNumber, short activeGamepadMask, int buttonFlags, unsigned char leftTrigger,
                               unsigned char rightTrigger, short leftStickX, short leftStickY, short rightStickX, short rightStickY) {
  if (harness::failNextPackets > 0) {
    harness::failNextPackets--;
    return -1;
  }
  harness::padPackets.push_back({ controllerNumber, activeGamepadMask, buttonFlags, leftTrigger, rightTrigger, leftStickX,
                                  leftStickY, rightStickX, rightStickY });
  return 0;
}
int LiSendControllerArrivalEvent(uint8_t controllerNumber, uint16_t activeGamepadMask, uint8_t type, uint32_t supportedButtonFlags,
                                 uint16_t capabilities) {
  if (harness::failNextArrivals > 0) {
    harness::failNextArrivals--;
    return -1;
  }
  harness::arrivals.push_back({ controllerNumber, activeGamepadMask, type, supportedButtonFlags, capabilities });
  return 0;
}
uint64_t LiGetMillis(void) {
  return harness::nowMs;
}
int LiSendMouseMoveEvent(short deltaX, short deltaY) {
  // moonlight-common-c sends nothing for a move without a delta
  if (deltaX != 0 || deltaY != 0) {
    harness::mouseMoves.push_back({ deltaX, deltaY });
  }
  return 0;
}
int LiSendMouseButtonEvent(char action, int button) {
  if (harness::failNextMouseButtons > 0) {
    harness::failNextMouseButtons--;
    return -1;
  }
  harness::mouseButtons.push_back({ action, button });
  return 0;
}
int LiSendHighResScrollEvent(short amount) {
  harness::scrolls.push_back(amount);
  return 0;
}
int LiSendHighResHScrollEvent(short amount) {
  harness::horizontalScrolls.push_back(amount);
  return harness::horizontalScrollResult;
}
void MoonlightInstance::ClLogMessage(const char* format, ...) {
  char message[1024];
  va_list args;
  va_start(args, format);
  std::vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  harness::logMessages.push_back(message);
}
void PostToJs(std::string message) {
  harness::postedToJs.push_back(message);
}
void PostToJsAsync(std::string message) {
  harness::postedToJs.push_back(message);
}
MessageResult stopStream() {
  harness::stopStreamCalls++;
  return MessageResult();
}
void toggleStats() {
  harness::toggleStatsCalls++;
}
