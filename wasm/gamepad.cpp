#include "moonlight_wasm.hpp"
#include "controller_type.hpp"
#include "controller_mapping.hpp"

#include <iostream>
#include <array>
#include <atomic>
#include <utility>
#include <sstream>
#include <chrono>
#include <thread>
#include <cmath>
#include <map>
#include <cstring>
#include <cctype>
#include <string>
#include <algorithm>
#include <limits>
#include <vector>

#include <Limelight.h>
#include <emscripten/emscripten.h>

// Maximum number of controllers supported by the Moonlight protocol
static constexpr int kMaxControllers = 16;

// Bitmask for gamepad combo buttons to stop the streaming session
const int STOP_STREAM_BUTTONS = BACK_FLAG | PLAY_FLAG | LB_FLAG | RB_FLAG;

// Bitmask for gamepad combo buttons to toggle the performance stats overlay
const int PERF_STATS_BUTTONS = BACK_FLAG | LB_FLAG | RB_FLAG | X_FLAG;

// Bitmask for gamepad combo buttons to open the Stream Menu, held for kStreamMenuHoldMs (see UpdateStreamMenuCombo())
const int STREAM_MENU_BUTTONS = BACK_FLAG | PLAY_FLAG;

// Flag for gamepad to track controller rumble state
bool rumbleFeedbackSwitch = false;

// Flags for gamepad to track mouse emulation state
bool mouseEmulationSwitch = false;
bool mouseEmulationActive = false;

// The button mapping and the stick calibration of the setting "Button mapping" (controller_mapping.hpp), set at the start
// of every stream before the input polling starts
static ControllerMappings controllerMappings;

// Controller type of the setting "Controller type sent to the PC", or LI_CTYPE_UNKNOWN to detect it from the id of
// each controller (Auto, see controller_type.hpp)
uint8_t controllerTypeSetting = LI_CTYPE_UNKNOWN;

// For explanation on ordering, see: https://www.w3.org/TR/gamepad/#remapping
// Enumeration for gamepad buttons
enum GamepadButton {
  A, B, X, Y,
  LeftBumper, RightBumper,
  LeftTrigger, RightTrigger,
  Back, Play,
  LeftStick, RightStick,
  Up, Down, Left, Right,
  Special,
  // The extra button that Chromium maps after the standard ones: the touchpad click of PlayStation controllers, the
  // Share button of Xbox Series controllers and the Capture button of Nintendo controllers
  Misc,
  Count,
};

// For explanation on ordering, see: https://www.w3.org/TR/gamepad/#remapping
// Enumeration for gamepad axis
enum GamepadAxis {
  LeftX = 0,
  LeftY = 1,
  RightX = 2,
  RightY = 3,
};

// Per-slot state used for Tizen placeholder filtering, id tracking and arrival announcements
struct ControllerSlotState {
  bool seenTimestamp = false; // true once a non-zero timestamp was observed for this id
  bool announced = false; // true after LiSendControllerArrivalEvent succeeded
  std::string id; // last known Gamepad.id (used to detect replacements)
  uint8_t type = LI_CTYPE_UNKNOWN; // controller type announced to the host (detected or from the setting)
  int mapping = -1; // index of the mapping of this controller in controllerMappings, or -1 for none
};

static ControllerSlotState slotState[kMaxControllers];

// Controller state last sent to the host per slot. Many polls read the same state again (buttons
// and sticks at rest, or no new report from the controller yet), and those can skip sending
// another reliable packet over the network.
struct SentControllerState {
  bool valid = false; // false until a state was sent for the current device
  uint64_t timeMs = 0; // when the state was last sent
  short activeGamepadMask = 0;
  int buttonFlags = 0;
  unsigned char leftTrigger = 0;
  unsigned char rightTrigger = 0;
  short leftStickX = 0;
  short leftStickY = 0;
  short rightStickX = 0;
  short rightStickY = 0;
};

static SentControllerState sentState[kMaxControllers];

// Interval to resend an unchanged controller state, so the host is refreshed while idle
static constexpr uint64_t kControllerRefreshIntervalMs = 100;

// Mouse emulation: holding Start for kMouseEmulationHoldMs turns it on or off. While it is on, the left sticks move the
// mouse, the right sticks scroll and the face buttons and bumpers hold the mouse buttons, and the host gets no
// controller states.
static constexpr uint64_t kMouseEmulationHoldMs = 1000;

// The hold of Start of one controller, which can toggle the mouse emulation once
struct MouseEmulationHold {
  bool held = false; // Start is held
  uint64_t pressMs = 0; // when Start was pressed
  bool used = false; // this hold toggled already, or Back, LB or RB joined it for a button combo, so it can't toggle
  bool toggled = false; // this hold toggled, so the host doesn't get Start until it is released
};

static MouseEmulationHold mouseEmulationHold[kMaxControllers];

// Button combos that are held per controller, so that a held combo triggers only once
static bool comboTriggered[kMaxControllers];

// Stream Menu combo: holding Back and Start together, and no other button, for kStreamMenuHoldMs opens the Stream Menu.
// So that the game doesn't act on the combo, a press of Back or Start reaches the host kComboChordWindowMs later,
// unless the other one joins it meanwhile: then the host gets neither while both are held. Another button held with it
// rules out the combo, so the host gets the press at once then, together with that button, which keeps the order of a
// hotkey with Back as its modifier (e.g. Select + R1 in RetroArch). A press that ends earlier, or a Back + Start that
// ends before it opened the menu (e.g. the Select + Start hotkey of RetroArch), reaches the host afterwards for as long
// as it was held. Once the combo opened the menu, the host gets neither until it is released.
static constexpr uint64_t kStreamMenuHoldMs = 1000;
static constexpr uint64_t kComboChordWindowMs = 100;

// What the host gets of Back or Start of one controller
struct ComboButton {
  bool held = false; // the button is held
  bool withheld = false; // it is held, and the host doesn't have it yet
  bool dropped = false; // it is held, and the host doesn't get it: the combo opened the Stream Menu
  uint64_t pressMs = 0; // when it was pressed
  uint64_t replayUntilMs = 0; // the host gets the button pressed until then: a press it didn't get while it was held
};

// The Stream Menu combo of one controller
struct StreamMenuCombo {
  ComboButton back;
  ComboButton start;
  uint64_t chordMs = 0; // when Back and Start started to be held together and alone, or 0
  // This hold opened the Stream Menu, so new presses of Back and Start are dropped until both are released
  bool opened = false;
};

static StreamMenuCombo streamMenuCombo[kMaxControllers];

// The Stream Menu is open (setStreamMenuOpen(), called by the UI on the main thread): the host gets every controller
// released, no mouse input and no button combos, while the menus of the UI read the controllers. The buttons that are
// held when it closes, e.g. the one that chose Resume, reach the host only once they were released and pressed again.
static std::atomic<bool> streamMenuOpen{false};
static bool inputPaused = false; // the state of streamMenuOpen that the input thread follows
static int heldSinceMenu[kMaxControllers]; // buttons, as the host gets them, held since the Stream Menu closed

// The Stream Menu asked to turn the mouse emulation on or off (toggleMouseEmulation()), which the next poll does
static std::atomic<bool> mouseEmulationToggleRequested{false};

// Mouse buttons that the host holds because of the mouse emulation, as a combination of these bits
static constexpr int kMouseLeft = 1;
static constexpr int kMouseMiddle = 2;
static constexpr int kMouseRight = 4;
static int sentMouseButtons = 0;

// Scrolling with the right stick in the mouse emulation, in the high-resolution units of the scroll events, where 120 is
// one notch of a mouse wheel (WHEEL_DELTA). A stick within kScrollRestZone doesn't scroll; past it, the speed follows a
// quadratic curve up to kMaxScrollNotchesPerSecond at full deflection. The amount adds up across polls and is sent once
// it reaches kScrollStepUnits, a quarter notch, so a partly deflected stick scrolls evenly without an event on every poll.
static constexpr double kWheelDelta = 120.0;
static constexpr double kScrollRestZone = 0.15;
static constexpr double kMaxScrollNotchesPerSecond = 15.0;
static constexpr double kScrollStepUnits = kWheelDelta / 4;
// Poll interval of the input thread (InputThreadFunc() in main.cpp), counted for the first poll in mouse mode, and the
// longest time that one poll scrolls for after a stall
static constexpr uint64_t kPollIntervalMs = 5;
static constexpr uint64_t kMaxScrollIntervalMs = 50;
static double pendingScrollX = 0.0;
static double pendingScrollY = 0.0;
static uint64_t lastScrollMs = 0; // 0 until the first poll in mouse mode

// Flag that the host gets for a button of the standard layout. The extra button 17 is the touchpad button for a
// PlayStation controller, which Sunshine passes on to its emulated DualShock 4, and the misc button (Share or Capture)
// for the others; a GFE host gets the Guide button for the misc button instead (moonlight-common-c).
static int GetButtonFlag(int index, uint8_t type) {
  // Standard Gamepad layout; triggers are analog so they contribute no flags
  static constexpr int kButtons[] = {
    A_FLAG, B_FLAG, X_FLAG, Y_FLAG,
    LB_FLAG, RB_FLAG,
    0, 0, // triggers are analog, not flags
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };

  if (index == GamepadButton::Misc) {
    return type == LI_CTYPE_PS ? TOUCHPAD_FLAG : MISC_FLAG;
  } else if (index < 0 || index > GamepadButton::Special) {
    return 0;
  }
  return kButtons[index];
}

// The mapping of a controller (controller_mapping.hpp), or nullptr for the buttons and sticks as they are
static const ControllerMapping* GetControllerMapping(int index) {
  return index >= 0 && index < static_cast<int>(controllerMappings.size()) ? &controllerMappings[index] : nullptr;
}

// Build the supported-buttons mask advertised in the arrival event: the buttons that the buttons of the controller press
// with its mapping. Button 17 is only advertised for a controller that reports it, i.e. with 18 buttons or more.
static uint32_t GetSupportedButtons(int numButtons, uint8_t type, const ControllerMapping* mapping) {
  uint32_t flags = 0;
  const int limit = std::min(numButtons, static_cast<int>(GamepadButton::Count));

  // Iterate through the buttons and set the appropriate flags
  for (int i = 0; i < limit; ++i) {
    const int target = (mapping && i < kMappedButtons) ? mapping->targets[i] : i;
    flags |= static_cast<uint32_t>(GetButtonFlag(target, type));
  }

  return flags;
}

// Function to map gamepad buttons to flags. They take an int, since the touchpad and misc buttons lie above 16 bits.
static int GetButtonFlags(const EmscriptenGamepadEvent& gamepad, uint8_t type) {
  // Triggers are considered analog buttons in the "Emscripten API", however they need
  // to be passed in separate arguments for "Limelight" (it even lacks flags for them).
  int result = 0;
  const int limit = std::min(gamepad.numButtons, static_cast<int>(GamepadButton::Count));

  // Iterate through the gamepad buttons and set the corresponding flags
  for (int i = 0; i < limit; ++i) {
    if (gamepad.digitalButton[i] == EM_TRUE) {
      result |= GetButtonFlag(i, type);
    }
  }

  return result;
}

// The input of one controller on this poll, in the ranges of the protocol, as the host gets it
struct ControllerInput {
  int buttonFlags = 0; // with the button mapping of the controller
  double leftTrigger = 0.0;
  double rightTrigger = 0.0;
  double leftStickX = 0.0;
  double leftStickY = 0.0;
  double rightStickX = 0.0;
  double rightStickY = 0.0;
};

// Read the input of a controller as the host gets it: the physical buttons in passedFlags that are pressed (the flags of
// the physical buttons that pass, never Back and Start), Back and Start in comboFlags as the Stream Menu combo passes
// them on (pressed, also when they are replayed after their release) and the triggers, with the button mapping and the
// stick calibration of the controller applied after the browser filled the event (__fillGamepadEventData() in
// ReadGamepadSlots()). The button combos run on the physical buttons before this.
static ControllerInput ReadControllerInput(const EmscriptenGamepadEvent& gamepad, uint8_t type, const ControllerMapping* mapping,
                                           int passedFlags, int comboFlags) {
  ControllerInput input;
  passedFlags &= ~STREAM_MENU_BUTTONS;
  comboFlags &= STREAM_MENU_BUTTONS;
  double leftTrigger = gamepad.analogButton[GamepadButton::LeftTrigger];
  double rightTrigger = gamepad.analogButton[GamepadButton::RightTrigger];
  double axes[4] = {
    gamepad.axis[GamepadAxis::LeftX], gamepad.axis[GamepadAxis::LeftY],
    gamepad.axis[GamepadAxis::RightX], gamepad.axis[GamepadAxis::RightY],
  };
  if (!mapping) {
    input.buttonFlags = (GetButtonFlags(gamepad, type) & passedFlags) | comboFlags;
  } else {
    // The physical buttons that pass, of which the triggers always do, mapped to the buttons of the game
    int pressedButtons[GamepadButton::Count] = {};
    double buttonValues[GamepadButton::Count] = {};
    const int limit = std::min(gamepad.numButtons, static_cast<int>(GamepadButton::Count));
    for (int i = 0; i < limit; ++i) {
      const int flag = GetButtonFlag(i, type);
      if (flag & STREAM_MENU_BUTTONS) {
        pressedButtons[i] = (comboFlags & flag) != 0;
        buttonValues[i] = pressedButtons[i] ? 1.0 : 0.0;
      } else if (flag == 0 || (passedFlags & flag)) {
        pressedButtons[i] = gamepad.digitalButton[i] == EM_TRUE;
        buttonValues[i] = gamepad.analogButton[i];
      }
    }
    bool pressed[kMappedButtons];
    double values[kMappedButtons];
    MapButtons(mapping->targets, pressedButtons, buttonValues, limit, pressed, values);
    for (int i = 0; i < kMappedButtons; ++i) {
      if (pressed[i]) {
        input.buttonFlags |= GetButtonFlag(i, type);
      }
    }
    // The Guide button and button 17 keep their meaning
    for (int i = GamepadButton::Special; i < limit; ++i) {
      if (pressedButtons[i]) {
        input.buttonFlags |= GetButtonFlag(i, type);
      }
    }
    leftTrigger = values[kMappedLeftTrigger];
    rightTrigger = values[kMappedRightTrigger];
    for (int stick = 0; stick < 2; ++stick) {
      const StickCalibration& calibration = mapping->sticks[stick];
      if (calibration.valid) {
        axes[stick * 2] = CalibrateAxis(axes[stick * 2], calibration.centreX, calibration.minX, calibration.maxX);
        axes[stick * 2 + 1] = CalibrateAxis(axes[stick * 2 + 1], calibration.centreY, calibration.minY, calibration.maxY);
      }
    }
  }
  input.leftTrigger = leftTrigger * std::numeric_limits<unsigned char>::max();
  input.rightTrigger = rightTrigger * std::numeric_limits<unsigned char>::max();
  input.leftStickX = axes[0] * std::numeric_limits<short>::max();
  input.leftStickY = -axes[1] * std::numeric_limits<short>::max();
  input.rightStickX = axes[2] * std::numeric_limits<short>::max();
  input.rightStickY = -axes[3] * std::numeric_limits<short>::max();
  return input;
}

// Check if two controller states would send the same packet to the host
static bool IsSameControllerState(const SentControllerState& a, const SentControllerState& b) {
  return a.activeGamepadMask == b.activeGamepadMask && a.buttonFlags == b.buttonFlags &&
    a.leftTrigger == b.leftTrigger && a.rightTrigger == b.rightTrigger &&
    a.leftStickX == b.leftStickX && a.leftStickY == b.leftStickY &&
    a.rightStickX == b.rightStickX && a.rightStickY == b.rightStickY;
}

// The result of the batched read below for an exception, which its JavaScript code logs itself
static const int kGamepadReadException = -3;

// Read every browser gamepad slot into events, marking the filled ones in slotPresent.
// Returns the number of slots read (capped at kMaxControllers), or -1 on failure.
static int ReadGamepadSlots(EmscriptenGamepadEvent* events, int* slotPresent) {
  // Each Emscripten gamepad function is proxied to the main thread on its own, which costs two
  // round trips plus one per slot on every poll. Read all slots in a single round trip instead,
  // so the main thread stays free for the audio scheduler while streaming.
  // An exception counts as a failed read (-3, kGamepadReadException) instead of leaving the main thread unable to run
  // proxied calls (see PostToJs() in main.cpp); the catch logs it the first and every 1000th time, since this runs
  // every 5 ms, and the code below doesn't log it again.
  const int count = MAIN_THREAD_EM_ASM_INT({
    try {
      // Use the individual Emscripten calls below if their internal helper is not available
      if (typeof __fillGamepadEventData !== 'function') {
        return -2;
      }
      var gamepads = navigator.getGamepads ? navigator.getGamepads() : (navigator.webkitGetGamepads ? navigator.webkitGetGamepads() : null);
      if (!gamepads) {
        return -1;
      }
      var count = Math.min(gamepads.length, $2);
      for (var i = 0; i < count; ++i) {
        if (gamepads[i]) {
          __fillGamepadEventData($0 + i * $3, gamepads[i]);
          HEAP32[($1 >> 2) + i] = 1;
        }
      }
      return count;
    } catch (e) {
      window._mlGamepadReadErrors = (window._mlGamepadReadErrors || 0) + 1;
      if (window._mlGamepadReadErrors % 1000 === 1) {
        console.error('%c[gamepad.cpp, ReadGamepadSlots]', 'color: gray;', 'Error: Reading the gamepads failed (' + window._mlGamepadReadErrors + ' times):', e);
      }
      return -3;
    }
  }, events, slotPresent, kMaxControllers, (int)sizeof(EmscriptenGamepadEvent));

  if (count == kGamepadReadException) {
    return -1;
  } else if (count == -1) {
    MoonlightInstance::ClLogMessage("Failed to sample gamepad data!\n");
    return -1;
  } else if (count != -2) {
    return count;
  }

  // Guard check if sampling gamepad data is not successful
  if (emscripten_sample_gamepad_data() != EMSCRIPTEN_RESULT_SUCCESS) {
    MoonlightInstance::ClLogMessage("Failed to sample gamepad data!\n");
    return -1;
  }

  // Query how many gamepad slots the browser currently exposes
  const auto numGamepads = emscripten_get_num_gamepads();
  // Guard check if retrieving the number of gamepads is not supported
  if (numGamepads == EMSCRIPTEN_RESULT_NOT_SUPPORTED) {
    MoonlightInstance::ClLogMessage("Failed to get number of gamepads!\n");
    return -1;
  }

  // Cap at the protocol maximum of 16 controllers
  const int limit = std::min(numGamepads, kMaxControllers);
  for (int i = 0; i < limit; ++i) {
    // Check if the gamepad status retrieval is successful for the current slot
    if (emscripten_get_gamepad_status(i, &events[i]) == EMSCRIPTEN_RESULT_SUCCESS) {
      slotPresent[i] = 1;
    }
  }

  return limit;
}

// Turn the mouse emulation on or off. When it ends, every controller sends its full state again on the next poll, and
// SendMouseButtons(0) releases the mouse buttons that the host still holds.
static void SetMouseEmulationActive(bool active) {
  mouseEmulationActive = active;
  pendingScrollX = 0.0;
  pendingScrollY = 0.0;
  lastScrollMs = 0;
  if (!active) {
    for (auto& state : sentState) {
      state.valid = false;
    }
  }
}

// Follow the hold of Start of a controller, and toggle the mouse emulation (with its switch on) once Start was held for
// kMouseEmulationHoldMs: only once per hold, so a longer hold doesn't switch it back, and not when Back, LB or RB are
// held with Start, which belong to the button combos, so a slowly pressed stop combo doesn't turn it on first.
static void UpdateMouseEmulationToggle(int controller, int physicalFlags, uint64_t nowMs) {
  MouseEmulationHold& hold = mouseEmulationHold[controller];
  if (!(physicalFlags & PLAY_FLAG)) {
    // Released: the next press starts a new hold
    hold = {};
    return;
  }
  if (!hold.held) {
    hold.held = true;
    hold.pressMs = nowMs;
  }
  if (physicalFlags & (BACK_FLAG | LB_FLAG | RB_FLAG)) {
    hold.used = true;
  }
  if (!mouseEmulationSwitch || hold.used || nowMs - hold.pressMs < kMouseEmulationHoldMs) {
    return;
  }

  hold.used = true;
  hold.toggled = true;
  // Toggle mouse emulation state and notify the user
  SetMouseEmulationActive(!mouseEmulationActive);
  PostToJs(std::string(mouseEmulationActive ? "mouseEmulationOn" : "mouseEmulationOff"));
}

// Follow Back or Start of a controller for the Stream Menu combo. A new press is withheld, or dropped while the combo
// that opened the menu is still held. A withheld press reaches the host once kComboChordWindowMs have passed since it
// was pressed, unless Back and Start are held together and alone (the chord), or at once when another button is held
// with it (others), and a withheld press that is released gets replayed for as long as it was held.
static void UpdateComboButton(ComboButton& button, bool pressed, bool chord, bool others, bool menuOpened,
                              uint64_t nowMs) {
  if (pressed && !button.held) {
    button.held = true;
    button.withheld = !menuOpened;
    button.dropped = menuOpened;
    button.pressMs = nowMs;
  } else if (!pressed && button.held) {
    if (button.withheld) {
      button.replayUntilMs = nowMs + (nowMs - button.pressMs);
    }
    button.held = false;
    button.withheld = false;
    button.dropped = false;
  }
  if (button.withheld && !chord && (others || nowMs - button.pressMs >= kComboChordWindowMs)) {
    button.withheld = false;
  }
}

// Check if the host gets Back or Start of a controller on this poll: the button is held and passed on, or its replay
// runs
static bool ComboButtonReachesHost(const ComboButton& button, uint64_t nowMs) {
  return (button.held && !button.withheld && !button.dropped) || nowMs < button.replayUntilMs;
}

// Run the Stream Menu combo of a controller on its physical buttons, open the Stream Menu once Back and Start were held
// together and alone for kStreamMenuHoldMs, and return which of the physical Back and Start the host gets on this poll
// (BACK_FLAG and PLAY_FLAG), as the combo passes them on. The menu opens once per hold, and a press of Start that came
// first and already reached the host is released there when the menu opens.
static int UpdateStreamMenuCombo(int controller, int physicalFlags, uint64_t nowMs) {
  StreamMenuCombo& combo = streamMenuCombo[controller];
  const bool chord = physicalFlags == STREAM_MENU_BUTTONS;
  // Another button is held, which rules out the combo
  const bool others = (physicalFlags & ~STREAM_MENU_BUTTONS) != 0;
  if (!chord) {
    combo.chordMs = 0;
  } else if (combo.chordMs == 0) {
    combo.chordMs = nowMs;
  }

  UpdateComboButton(combo.back, (physicalFlags & BACK_FLAG) != 0, chord, others, combo.opened, nowMs);
  UpdateComboButton(combo.start, (physicalFlags & PLAY_FLAG) != 0, chord, others, combo.opened, nowMs);

  if (chord && !combo.opened && nowMs - combo.chordMs >= kStreamMenuHoldMs) {
    combo.opened = true;
    ComboButton* buttons[] = { &combo.back, &combo.start };
    for (ComboButton* button : buttons) {
      button->withheld = false;
      button->dropped = true;
      button->replayUntilMs = 0;
    }
    // Ask the UI to open the Stream Menu, without waiting for the main thread
    PostToJsAsync(std::string("streamMenuRequested"));
  } else if (combo.opened && !(physicalFlags & STREAM_MENU_BUTTONS)) {
    // Both are released: the next hold can open the menu again
    combo.opened = false;
  }

  int flags = 0;
  if (ComboButtonReachesHost(combo.back, nowMs)) {
    flags |= BACK_FLAG;
  }
  if (ComboButtonReachesHost(combo.start, nowMs)) {
    flags |= PLAY_FLAG;
  }
  return flags;
}

// Called by the UI on the main thread when the Stream Menu opens or closes (bound in main.cpp)
void setStreamMenuOpen(bool open) {
  streamMenuOpen.store(open);
}

// Called by the UI on the main thread for the mouse emulation entry of the Stream Menu, which works whatever the
// setting "Mouse emulation" (that setting only allows the hold of Start). The input thread toggles it on its next poll.
void toggleMouseEmulation() {
  mouseEmulationToggleRequested.store(true);
}

// Send the state of a controller with nothing pressed and the sticks centred, unless the host has it already. The host
// keeps the last state it got while the mouse emulation sends none, and that state holds at least Start, which turned
// the mouse emulation on, and often a stick. A state that couldn't be queued is sent again on the next poll.
static void SendNeutralState(int controller, short activeGamepadMask, uint64_t nowMs) {
  SentControllerState neutral;
  neutral.activeGamepadMask = activeGamepadMask;
  SentControllerState& lastState = sentState[controller];
  if (lastState.valid && IsSameControllerState(lastState, neutral)) {
    return;
  }
  if (LiSendMultiControllerEvent(controller, activeGamepadMask, 0, 0, 0, 0, 0, 0, 0) == 0) {
    neutral.valid = true;
    neutral.timeMs = nowMs;
    lastState = neutral;
  }
}

// Mouse buttons that a controller holds in the mouse emulation: A or LB the left button, X or Y the middle button, and
// B or RB the right button
static int GetMouseButtons(int buttonFlags) {
  int buttons = 0;
  if (buttonFlags & (A_FLAG | LB_FLAG)) {
    buttons |= kMouseLeft;
  }
  if (buttonFlags & (X_FLAG | Y_FLAG)) {
    buttons |= kMouseMiddle;
  }
  if (buttonFlags & (B_FLAG | RB_FLAG)) {
    buttons |= kMouseRight;
  }
  return buttons;
}

// Send a press or release for each mouse button that changed since it was last sent: the buttons that any controller
// holds in the mouse emulation, or none once it ended. All controllers share one mouse, so an idle controller doesn't
// release the button that another one holds, and nothing is sent while nothing changes. A button whose event couldn't
// be queued is sent again on the next poll.
static void SendMouseButtons(int buttons) {
  struct MouseButtonBit {
    int bit;
    int button;
  };
  static constexpr MouseButtonBit kMouseButtons[] = {
    { kMouseLeft, BUTTON_LEFT },
    { kMouseMiddle, BUTTON_MIDDLE },
    { kMouseRight, BUTTON_RIGHT },
  };

  for (const MouseButtonBit& entry : kMouseButtons) {
    if (!((buttons ^ sentMouseButtons) & entry.bit)) {
      continue;
    }
    const char action = (buttons & entry.bit) ? BUTTON_ACTION_PRESS : BUTTON_ACTION_RELEASE;
    if (LiSendMouseButtonEvent(action, entry.button) == 0) {
      sentMouseButtons ^= entry.bit;
    }
  }
}

// Scroll speed of one stick axis (-1 to 1) in the mouse emulation, in high-resolution units per second
static double GetScrollSpeed(double axis) {
  const double magnitude = std::fabs(axis);
  if (magnitude <= kScrollRestZone) {
    return 0.0;
  }
  const double deflection = std::min(1.0, (magnitude - kScrollRestZone) / (1.0 - kScrollRestZone));
  const double speed = deflection * deflection * kMaxScrollNotchesPerSecond * kWheelDelta;
  return axis < 0 ? -speed : speed;
}

// Add the scroll of one direction for the given time, and send it once it reaches a step. The fraction below a whole
// unit stays for the next poll. A stick back at rest drops what is left, so it doesn't add to the next scroll, and an
// event that couldn't be queued (or a horizontal scroll, which GFE hosts don't support) is dropped instead of adding up.
static void AddScroll(double* pending, double speed, double seconds, int (*sendScroll)(short)) {
  if (speed == 0.0) {
    *pending = 0.0;
    return;
  }
  *pending += speed * seconds;
  if (std::fabs(*pending) < kScrollStepUnits) {
    return;
  }
  const short amount = static_cast<short>(*pending);
  *pending -= amount;
  if (sendScroll(amount) != 0) {
    *pending = 0.0;
  }
}

// Scroll with the summed right sticks of all controllers for the time since the previous poll in mouse mode, at most
// kMaxScrollIntervalMs after a stall. The high-resolution scroll events carry fractions of a notch, which the
// LiSendScrollEvent() and LiSendHScrollEvent() of moonlight-common-c can't, so a partly deflected stick can scroll.
static void SendScroll(double speedX, double speedY, uint64_t nowMs) {
  const uint64_t elapsedMs = lastScrollMs == 0 ? kPollIntervalMs : std::min(nowMs - lastScrollMs, kMaxScrollIntervalMs);
  lastScrollMs = nowMs;
  const double seconds = static_cast<double>(elapsedMs) / 1000.0;
  AddScroll(&pendingScrollX, speedX, seconds, LiSendHighResHScrollEvent);
  AddScroll(&pendingScrollY, speedY, seconds, LiSendHighResScrollEvent);
}

// Called at the start of every stream with its gamepad settings, before the input polling starts (the native tests also
// call it to change a setting). It clears the announced flags so arrival is re-sent with updated data, and starts the
// stream without the mouse emulation, held combos and mouse buttons of the previous stream. The button mapping comes as
// the text of controller_mapping.hpp.
void MoonlightInstance::HandleGamepadInputState(bool rumbleFeedback, bool mouseEmulation, const std::string& buttonMappings,
                                                uint8_t controllerType) {
  // Force re-announce on next poll so the host gets the updated button map / capabilities
  for (int i = 0; i < kMaxControllers; ++i) {
    slotState[i].announced = false;
    mouseEmulationHold[i] = {};
    comboTriggered[i] = false;
    streamMenuCombo[i] = {};
    heldSinceMenu[i] = 0;
  }

  // A stream that ended in mouse mode must not start the next one in mouse mode, where the controllers would seem dead.
  // The host of a new stream holds no mouse buttons. A Stream Menu of the previous stream is closed.
  SetMouseEmulationActive(false);
  sentMouseButtons = 0;
  streamMenuOpen.store(false);
  inputPaused = false;
  mouseEmulationToggleRequested.store(false);

  // Store the new settings for use during polling
  rumbleFeedbackSwitch = rumbleFeedback;
  mouseEmulationSwitch = mouseEmulation;
  controllerTypeSetting = controllerType;
  controllerMappings = ParseControllerMappings(buttonMappings);
}

// Function to poll gamepad input
void MoonlightInstance::PollGamepads() {
  // Temporary storage for this poll's gamepad events and presence flags
  EmscriptenGamepadEvent events[kMaxControllers]{};
  int slotPresent[kMaxControllers] = { 0 };

  // See matching logic in "[utils.js] getConnectedGamepadMask()" – these must stay in sync!

  // Read every browser slot once so later logic can work from a stable snapshot
  const int limit = ReadGamepadSlots(events, slotPresent);
  if (limit < 0) {
    return;
  }

  // Snapshot slots, build physical-index mask, and collect removals / arrivals
  short activeGamepadMask = 0;
  std::vector<int> removed;
  std::vector<int> arrived;

  // Decide per slot: still real, removed, or newly arrived
  for (int i = 0; i < kMaxControllers; ++i) {
    ControllerSlotState& state = slotState[i];

    const bool connected = slotPresent[i] && events[i].connected; // slot exists and reports connected
    const char* currentId = (connected && events[i].id) ? events[i].id : ""; // current Gamepad.id (or empty)
    const double timestamp = connected ? events[i].timestamp : 0.0; // current timestamp (0 if disconnected)
    const bool sameDevice = (state.id == currentId); // true when the id has not changed

    // Real = connected and (non-zero timestamp, or previously seen real with same id)
    // This keeps the Tizen placeholder workaround while detecting replacements
    const bool real = connected && (timestamp != 0.0 || (sameDevice && state.seenTimestamp));

    // Previously announced but gone or replaced → queue removal
    if (state.announced && (!real || !sameDevice)) {
      removed.push_back(i);
      state.announced = false;
    }

    // Not a real controller (placeholder or disconnected) → clear state and skip
    if (!real) {
      state = {}; // clear so a future different device starts fresh
      continue;
    }

    // Record identity and mark this physical bit in the active mask
    state.id = currentId;
    state.seenTimestamp = true;
    activeGamepadMask |= static_cast<short>(1 << i);

    // Queue an arrival event if we have not announced this device yet
    if (!state.announced) {
      arrived.push_back(i);
    }
  }

  // Send zeroed events for removed / replaced controllers so the host cleans up, and forget their held Start and combos
  for (int i : removed) {
    LiSendMultiControllerEvent(i, activeGamepadMask & ~(1 << i), 0, 0, 0, 0, 0, 0, 0);
    sentState[i] = {};
    mouseEmulationHold[i] = {};
    comboTriggered[i] = false;
    streamMenuCombo[i] = {};
    heldSinceMenu[i] = 0;
  }

  // Announce new (or re-arrived) controllers so Sunshine can pick the right profile
  for (int i : arrived) {
    const auto& gamepad = events[i];
    // The type from the setting "Controller type sent to the PC", or the one detected from the id with Auto
    const uint8_t detectedType = GetControllerType(gamepad.id);
    const uint8_t type = controllerTypeSetting != LI_CTYPE_UNKNOWN ? controllerTypeSetting : detectedType;
    const int mapping = FindControllerMapping(controllerMappings, gamepad.id);
    const uint32_t buttons = GetSupportedButtons(gamepad.numButtons, type, GetControllerMapping(mapping));

    // Only advertise capabilities the browser actually provides
    uint16_t capabilities = (gamepad.numButtons > 7) ? LI_CCAP_ANALOG_TRIGGERS : 0;

    // The browser Gamepad API does not expose motion, battery, RGB or touchpad
    // data. Only advertise rumble when our existing feedback path can use it.
    const char* rumbleState = "off";
    if (rumbleFeedbackSwitch) {
      // An exception counts as no rumble (see PostToJs() in main.cpp)
      const int hasRumble = MAIN_THREAD_EM_ASM_INT({
        try {
          var gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
          var gamepad = gamepads[$0];
          return !!(gamepad && gamepad.vibrationActuator && typeof gamepad.vibrationActuator.playEffect === 'function');
        } catch (e) {
          console.error('%c[gamepad.cpp, PollGamepads]', 'color: gray;', 'Error: Checking the rumble of a gamepad failed:', e);
          return 0;
        }
      }, i);
      // Advertise rumble only when the actuator is actually available
      if (hasRumble) {
        capabilities |= LI_CCAP_RUMBLE;
      }
      rumbleState = hasRumble ? "yes" : "no";
    }

    // On failure leave un-announced; next poll will retry
    if (LiSendControllerArrivalEvent(i, activeGamepadMask, type, buttons, capabilities) == 0) {
      slotState[i].announced = true;
      slotState[i].type = type;
      slotState[i].mapping = mapping;
      // Send the full state of the new controller on this poll
      sentState[i] = {};
      // Log what the controller reports as separate fields, so a support log shows how the browser maps it (a mapping
      // other than "standard" means the raw layout of the driver, which the fixed button and axis indices above may
      // read wrongly) and which type the host was told. Rumble is "off" while the rumble setting is off, and a type
      // from the setting names the detected one as well.
      std::string typeText = GetControllerTypeName(type);
      if (type != detectedType) {
        typeText += std::string(" (setting, detected ") + GetControllerTypeName(detectedType) + ")";
      }
      MoonlightInstance::ClLogMessage("Controller %d announced: id=\"%s\", mapping=\"%s\", buttons=%d, axes=%d, rumble=%s, type=%s\n",
        i, gamepad.id, gamepad.mapping, gamepad.numButtons, gamepad.numAxes, rumbleState, typeText.c_str());
      // Say which button mapping of the setting "Button mapping" it got, if any
      const ControllerMapping* buttonMapping = GetControllerMapping(mapping);
      if (buttonMapping) {
        MoonlightInstance::ClLogMessage("Controller %d uses the button mapping %s%s\n", i,
          buttonMapping->id == kAllControllersId ? "of all controllers" : "of its own",
          (buttonMapping->sticks[0].valid || buttonMapping->sticks[1].valid) ? ", with a stick calibration" : "");
      }
    }
  }

  const uint64_t nowMs = LiGetMillis();

  // Follow the Stream Menu of the UI. When it opens, the combos and holds of Start that are in progress end, since the
  // host gets nothing while it is open; when it closes, the buttons that are held stay away from the host until they
  // are released.
  const bool paused = streamMenuOpen.load();
  const bool resumed = inputPaused && !paused;
  if (paused && !inputPaused) {
    for (int i = 0; i < kMaxControllers; ++i) {
      streamMenuCombo[i] = {};
      mouseEmulationHold[i] = {};
    }
    pendingScrollX = 0.0;
    pendingScrollY = 0.0;
    lastScrollMs = 0;
  }
  inputPaused = paused;

  // Turn the mouse emulation on or off for the entry of the Stream Menu, and notify the user as the hold of Start does
  if (mouseEmulationToggleRequested.exchange(false)) {
    SetMouseEmulationActive(!mouseEmulationActive);
    PostToJs(std::string(mouseEmulationActive ? "mouseEmulationOn" : "mouseEmulationOff"));
  }

  // Read the input of every real, already-announced controller, and run its button combos and the mouse emulation
  // toggle before anything is sent, so the mouse emulation that one controller turns on applies to all of them at once
  ControllerInput inputs[kMaxControllers];
  bool hasInput[kMaxControllers] = { false };
  for (int gamepadID = 0; gamepadID < limit; ++gamepadID) {
    // Skip slots that are inactive or still waiting for a successful arrival
    if (!(activeGamepadMask & (1 << gamepadID)) || !slotState[gamepadID].announced) {
      continue;
    }

    // Process input for active gamepad
    hasInput[gamepadID] = true;
    // While the Stream Menu is open, its buttons belong to the menus of the UI, and the host gets nothing of them
    if (paused) {
      continue;
    }
    const EmscriptenGamepadEvent& event = events[gamepadID];
    const int physicalFlags = GetButtonFlags(event, slotState[gamepadID].type);

    // The buttons that were held when the Stream Menu closed reach the host once they were released and pressed again
    if (resumed) {
      heldSinceMenu[gamepadID] = physicalFlags;
    }
    heldSinceMenu[gamepadID] &= physicalFlags;
    // The physical buttons without Back and Start held since then, which mustn't count as a new combo or hold either
    const int liveFlags = physicalFlags & ~(heldSinceMenu[gamepadID] & STREAM_MENU_BUTTONS);

    // Check the button combinations on the physical buttons, before the button mapping, so they are the same with every
    // mapping (the Navigation Guide documents them in the Xbox layout: A bottom, X left)
    if (physicalFlags == STOP_STREAM_BUTTONS) {
      // Terminate the connection
      stopStream();
      return;
    } else if (physicalFlags == PERF_STATS_BUTTONS) {
      if (!comboTriggered[gamepadID]) {
        // Toggle performance stats overlay
        toggleStats();
        // Mark combo as triggered until buttons are released
        comboTriggered[gamepadID] = true;
      }
    } else {
      // Reset when buttons are released
      comboTriggered[gamepadID] = false;
    }

    // Open the Stream Menu with a hold of Back + Start, which the host doesn't get
    const int comboFlags = UpdateStreamMenuCombo(gamepadID, liveFlags, nowMs);

    // Toggle mouse emulation on and off based on how long the PLAY/START button is pressed
    UpdateMouseEmulationToggle(gamepadID, liveFlags, nowMs);

    // The physical buttons that the host gets: not those held since the Stream Menu closed, Back and Start as the combo
    // passes them on, and not the hold of Start that toggled the mouse emulation until Start is released, so turning
    // the mouse emulation off doesn't press Start in the game. Then the button mapping of the controller.
    const int startHeld = mouseEmulationHold[gamepadID].toggled ? PLAY_FLAG : 0;
    inputs[gamepadID] = ReadControllerInput(event, slotState[gamepadID].type, GetControllerMapping(slotState[gamepadID].mapping),
                                            physicalFlags & ~heldSinceMenu[gamepadID], comboFlags & ~startHeld);
  }

  if (paused) {
    // The Stream Menu is open: release the controllers and the mouse buttons on the host once, and send nothing else
    for (int gamepadID = 0; gamepadID < limit; ++gamepadID) {
      if (hasInput[gamepadID]) {
        SendNeutralState(gamepadID, activeGamepadMask, nowMs);
      }
    }
    SendMouseButtons(0);
    return;
  }

  if (mouseEmulationActive) {
    // If mouse emulation is active, then send mouse input to the desired handler (acts as a mouse)
    int mouseButtons = 0;
    double scrollSpeedX = 0.0;
    double scrollSpeedY = 0.0;
    for (int gamepadID = 0; gamepadID < limit; ++gamepadID) {
      if (!hasInput[gamepadID]) {
        continue;
      }
      const ControllerInput& input = inputs[gamepadID];

      // Release the buttons and sticks of the controller on the host once
      SendNeutralState(gamepadID, activeGamepadMask, nowMs);

      // Left Stick values are mapped to horizontal and vertical mouse movements
      const float baseMouseSpeed = 10.0f;
      const float leftStickMagnitude = std::sqrt(input.leftStickX * input.leftStickX + input.leftStickY * input.leftStickY) / std::numeric_limits<short>::max();
      const float mouseSpeed = baseMouseSpeed * leftStickMagnitude;
      const float mouseXDelta = static_cast<float>(input.leftStickX) / std::numeric_limits<short>::max() * mouseSpeed;
      const float mouseYDelta = -static_cast<float>(input.leftStickY) / std::numeric_limits<short>::max() * mouseSpeed;

      // Send a mouse move event with the specified delta values for both horizontal (X-axis) and vertical (Y-axis) coordinates
      LiSendMouseMoveEvent(static_cast<int>(mouseXDelta), static_cast<int>(mouseYDelta));

      // Right Stick values are mapped to horizontal and vertical mouse scrolls, summed over the controllers
      scrollSpeedX += GetScrollSpeed(input.rightStickX / std::numeric_limits<short>::max());
      scrollSpeedY += GetScrollSpeed(input.rightStickY / std::numeric_limits<short>::max());

      // Face Buttons values are mapped to control mouse buttons, combined over the controllers
      mouseButtons |= GetMouseButtons(input.buttonFlags);
    }
    SendScroll(scrollSpeedX, scrollSpeedY, nowMs);
    SendMouseButtons(mouseButtons);
  } else {
    // Release the mouse buttons that the mouse emulation left held on the host
    SendMouseButtons(0);

    // If mouse emulation is inactive, then send gamepad input to the desired handler (acts as a gamepad)
    for (int gamepadID = 0; gamepadID < limit; ++gamepadID) {
      if (!hasInput[gamepadID]) {
        continue;
      }
      const ControllerInput& input = inputs[gamepadID];

      SentControllerState state;
      state.activeGamepadMask = activeGamepadMask;
      state.buttonFlags = input.buttonFlags;
      state.leftTrigger = static_cast<unsigned char>(input.leftTrigger);
      state.rightTrigger = static_cast<unsigned char>(input.rightTrigger);
      state.leftStickX = static_cast<short>(input.leftStickX);
      state.leftStickY = static_cast<short>(input.leftStickY);
      state.rightStickX = static_cast<short>(input.rightStickX);
      state.rightStickY = static_cast<short>(input.rightStickY);

      // Skip polls that read the same state again, but refresh the host periodically
      SentControllerState& lastState = sentState[gamepadID];
      if (!lastState.valid || !IsSameControllerState(lastState, state) ||
          nowMs - lastState.timeMs >= kControllerRefreshIntervalMs) {
        // Remember the state only once it was queued, so a dropped event is retried on the next poll
        if (LiSendMultiControllerEvent(
              gamepadID, state.activeGamepadMask, state.buttonFlags, state.leftTrigger,
              state.rightTrigger, state.leftStickX, state.leftStickY, state.rightStickX, state.rightStickY) == 0) {
          state.valid = true;
          state.timeMs = nowMs;
          lastState = state;
        }
      }
    }
  }
}

// Function to send controller rumble feedback for gamepad
void MoonlightInstance::ClControllerRumble(unsigned short controllerNumber, unsigned short lowFreqMotor, unsigned short highFreqMotor) {
  const float weakMagnitude = static_cast<float>(highFreqMotor) / static_cast<float>(UINT16_MAX);
  const float strongMagnitude = static_cast<float>(lowFreqMotor) / static_cast<float>(UINT16_MAX);

  // Check if the rumble feedback switch is checked
  if (rumbleFeedbackSwitch) {
    std::ostringstream ss;
    ss << controllerNumber << "," << weakMagnitude << "," << strongMagnitude;
    PostToJsAsync(std::string("controllerRumble: ") + ss.str());
  }
}
