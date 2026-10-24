#pragma once
// Host build of wasm/gamepad.cpp for the native tests. The Emscripten and Samsung headers come from tests/native/stubs,
// and gamepad.cpp is included directly, so a test can read and reset its file-level state (slotState, sentState,
// mouseEmulationActive). The functions below stand in for moonlight-common-c and the rest of the app: they record
// what gamepad.cpp sends to the host, and the EM_ASM hook answers the browser Gamepad API from the simulated slots.

#include "../../wasm/gamepad.cpp"

#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
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
std::vector<int> scrolls;
std::vector<int> horizontalScrolls;
std::vector<std::string> postedToJs;
int stopStreamCalls = 0;
int toggleStatsCalls = 0;
int failNextPackets = 0; // number of upcoming controller packets that fail like a full input queue
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

// Clear what was recorded and the state of gamepad.cpp, as at the start of a new stream with the given settings
inline void Reset(bool rumbleFeedback = false, bool mouseEmulation = false, bool flipAB = false, bool flipXY = false) {
  padPackets.clear();
  arrivals.clear();
  mouseButtons.clear();
  scrolls.clear();
  horizontalScrolls.clear();
  postedToJs.clear();
  stopStreamCalls = 0;
  toggleStatsCalls = 0;
  failNextPackets = 0;
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
  mouseEmulationActive = false;
  // What the app does when a stream starts
  Instance()->HandleGamepadInputState(rumbleFeedback, mouseEmulation, flipAB, flipXY);
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

// Poll for the given real time, since the mouse emulation toggle measures the Start press with std::chrono::steady_clock
inline void PollForRealTime(int milliseconds, int stepMs = 5) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(milliseconds);
  while (std::chrono::steady_clock::now() < end) {
    std::this_thread::sleep_for(std::chrono::milliseconds(stepMs));
    Poll(static_cast<uint64_t>(stepMs));
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
  harness::arrivals.push_back({ controllerNumber, activeGamepadMask, type, supportedButtonFlags, capabilities });
  return 0;
}
uint64_t LiGetMillis(void) {
  return harness::nowMs;
}
int LiSendMouseMoveEvent(short, short) {
  return 0;
}
int LiSendMouseButtonEvent(char action, int button) {
  harness::mouseButtons.push_back({ action, button });
  return 0;
}
int LiSendScrollEvent(signed char amount) {
  harness::scrolls.push_back(amount);
  return 0;
}
int LiSendHScrollEvent(signed char amount) {
  harness::horizontalScrolls.push_back(amount);
  return 0;
}
void MoonlightInstance::ClLogMessage(const char*, ...) {}
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
