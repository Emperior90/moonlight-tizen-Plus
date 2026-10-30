// Pins the controller behaviour of wasm/gamepad.cpp during a stream: the controller type and buttons announced to the
// host (also the type of the setting "Controller type sent to the PC"), the face button swaps, button 17, the button
// combos, the capabilities and the mouse emulation (its toggle, the controller state it leaves on the host, the mouse
// buttons of several controllers, scrolling and the reset for a new stream). The type detection itself has its own
// tests in controller_type_test.cpp.

#include "gamepad_harness.h"
#include "test_support.h"

using harness::Connect;
using harness::Poll;
using harness::PollFor;
using harness::SetButton;
using harness::padPackets;

static const char* kXboxId = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)";
static const char* kDualSenseId = "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)";
static const uint32_t kStandardButtons = A_FLAG | B_FLAG | X_FLAG | Y_FLAG | LB_FLAG | RB_FLAG | BACK_FLAG | PLAY_FLAG |
  LS_CLK_FLAG | RS_CLK_FLAG | UP_FLAG | DOWN_FLAG | LEFT_FLAG | RIGHT_FLAG | SPECIAL_FLAG;

// Standard button indices used below
static constexpr int kButtonA = 0;
static constexpr int kButtonB = 1;
static constexpr int kButtonX = 2;
static constexpr int kButtonY = 3;
static constexpr int kButtonLB = 4;
static constexpr int kButtonRB = 5;
static constexpr int kButtonBack = 8;
static constexpr int kButtonStart = 9;

static void TestArrival() {
  // A standard controller announces its type, the 15 button flags and analog triggers
  harness::Reset();
  Connect(0, kDualSenseId);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK_EQ(harness::arrivals[0].type, LI_CTYPE_PS);
  CHECK_EQ(harness::arrivals[0].supportedButtons, kStandardButtons);
  CHECK_EQ(harness::arrivals[0].capabilities, LI_CCAP_ANALOG_TRIGGERS);

  // Rumble is announced only with the rumble setting on and an actuator present
  harness::Reset(true);
  Connect(0);
  Poll();
  CHECK_EQ(harness::arrivals[0].capabilities, LI_CCAP_ANALOG_TRIGGERS);
  harness::Reset(true);
  harness::hasRumbleActuator = true;
  Connect(0);
  Poll();
  CHECK_EQ(harness::arrivals[0].capabilities, LI_CCAP_ANALOG_TRIGGERS | LI_CCAP_RUMBLE);
  harness::Reset(false);
  harness::hasRumbleActuator = true;
  Connect(0);
  Poll();
  CHECK_EQ(harness::arrivals[0].capabilities, LI_CCAP_ANALOG_TRIGGERS);

  // A layout with 7 buttons or fewer has no analog triggers
  harness::Reset();
  Connect(0, "Simple pad", "", 6, 2);
  Poll();
  CHECK_EQ(harness::arrivals[0].capabilities, 0);
  CHECK_EQ(harness::arrivals[0].supportedButtons, static_cast<uint32_t>(A_FLAG | B_FLAG | X_FLAG | Y_FLAG | LB_FLAG | RB_FLAG));

  // A changed setting announces the controllers again with the new data
  harness::Reset();
  Connect(0);
  Poll();
  harness::Instance()->HandleGamepadInputState(false, false, harness::FaceButtonSwapMapping(true, false), LI_CTYPE_UNKNOWN);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);

  // Touchpad, motion sensors, battery, LED and trigger rumble are never announced: the browser has no data for them
  harness::Reset(true);
  harness::hasRumbleActuator = true;
  Connect(0, kDualSenseId, "standard", 18, 4);
  Poll();
  CHECK_EQ(harness::arrivals[0].capabilities & ~(LI_CCAP_ANALOG_TRIGGERS | LI_CCAP_RUMBLE), 0);
}

// Count the log lines that contain a text
static int CountLogs(const std::string& text) {
  int count = 0;
  for (const std::string& message : harness::logMessages) {
    if (message.find(text) != std::string::npos) {
      count++;
    }
  }
  return count;
}

static void TestArrivalLog() {
  // A non-standard controller: the log shows the raw mapping and layout that the browser reports
  harness::Reset();
  Connect(1, "Generic USB Joystick (Vendor: 0079 Product: 0006)", "", 16, 6);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK_EQ(CountLogs("Controller 1 announced: id=\"Generic USB Joystick (Vendor: 0079 Product: 0006)\", mapping=\"\", buttons=16, axes=6, rumble=off, type=Unknown\n"), 1);
  // Later polls don't log it again
  Poll();
  Poll();
  CHECK_EQ(CountLogs("announced"), 1);

  // A standard controller with the rumble setting on, with and without an actuator. The id is the part that the
  // Emscripten event struct keeps (63 bytes).
  harness::Reset(true);
  harness::hasRumbleActuator = true;
  Connect(0, kDualSenseId);
  Poll();
  CHECK_EQ(CountLogs("Controller 0 announced: id=\"DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Pr\", mapping=\"standard\", buttons=17, axes=4, rumble=yes, type=PlayStation\n"), 1);
  harness::Reset(true);
  Connect(0);
  Poll();
  CHECK_EQ(CountLogs("mapping=\"standard\", buttons=17, axes=4, rumble=no, type=Xbox\n"), 1);

  // An arrival that the host didn't take is not logged; the retry on a later poll logs it once
  harness::Reset();
  harness::failNextArrivals = 1;
  Connect(0);
  Poll();
  CHECK_EQ(CountLogs("announced"), 0);
  Poll();
  CHECK_EQ(CountLogs("announced"), 1);
  CHECK_EQ(harness::arrivals.size(), 1u);
}

static void TestControllerTypeSetting() {
  // The setting "Controller type sent to the PC" replaces the detected type in the arrival, and the log names both
  harness::Reset(false, false, false, false, LI_CTYPE_PS);
  Connect(0, kXboxId);
  Connect(1, "Generic USB Joystick (Vendor: 0079 Product: 0006)", "", 16, 6);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);
  CHECK_EQ(harness::arrivals[0].type, LI_CTYPE_PS);
  CHECK_EQ(harness::arrivals[1].type, LI_CTYPE_PS);
  CHECK_EQ(CountLogs("Controller 0 announced: id=\"Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product\", mapping=\"standard\", buttons=17, axes=4, rumble=off, type=PlayStation (setting, detected Xbox)\n"), 1);
  CHECK_EQ(CountLogs("type=PlayStation (setting, detected Unknown)\n"), 1);

  // A setting that matches the detected type logs the type alone
  harness::Reset(false, false, false, false, LI_CTYPE_PS);
  Connect(0, kDualSenseId);
  Poll();
  CHECK_EQ(harness::arrivals[0].type, LI_CTYPE_PS);
  CHECK_EQ(CountLogs("type=PlayStation\n"), 1);

  harness::Reset(false, false, false, false, LI_CTYPE_XBOX);
  Connect(0, kDualSenseId);
  Poll();
  CHECK_EQ(harness::arrivals[0].type, LI_CTYPE_XBOX);
  harness::Reset(false, false, false, false, LI_CTYPE_NINTENDO);
  Connect(0, kXboxId);
  Poll();
  CHECK_EQ(harness::arrivals[0].type, LI_CTYPE_NINTENDO);

  // The next stream with Auto announces the detected type again
  harness::Instance()->HandleGamepadInputState(false, false, harness::FaceButtonSwapMapping(false, false), LI_CTYPE_UNKNOWN);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);
  CHECK_EQ(harness::arrivals[1].type, LI_CTYPE_XBOX);
}

// The button flags sent for one pressed button with the given face button swaps. They are an int, so Y (0x8000)
// arrives as it is instead of sign-extended from a short, which set every extended button flag before
// moonlight-common-c masked it (sendControllerEventInternal() in InputStream.c). Back and Start reach the host once the
// window of the Stream Menu combo has passed (stream_menu_combo_test.cpp), so the button is held that long.
static int FlagsFor(int button, bool flipAB, bool flipXY) {
  harness::Reset(false, false, flipAB, flipXY);
  Connect(0);
  Poll();
  SetButton(0, button, true);
  Poll();
  PollFor(static_cast<int>(kComboChordWindowMs));
  return padPackets.empty() ? -1 : padPackets.back().buttons;
}

static void TestFaceButtonSwaps() {
  CHECK_EQ(FlagsFor(kButtonA, false, false), A_FLAG);
  CHECK_EQ(FlagsFor(kButtonX, false, false), X_FLAG);
  CHECK_EQ(FlagsFor(kButtonY, false, false), Y_FLAG);
  CHECK_EQ(FlagsFor(kButtonA, true, false), B_FLAG);
  CHECK_EQ(FlagsFor(kButtonB, true, false), A_FLAG);
  CHECK_EQ(FlagsFor(kButtonX, true, false), X_FLAG);
  CHECK_EQ(FlagsFor(kButtonX, false, true), Y_FLAG);
  CHECK_EQ(FlagsFor(kButtonY, false, true), X_FLAG);
  CHECK_EQ(FlagsFor(kButtonA, true, true), B_FLAG);
  CHECK_EQ(FlagsFor(kButtonY, true, true), X_FLAG);
  // The other buttons keep their flags
  CHECK_EQ(FlagsFor(kButtonStart, true, true), PLAY_FLAG);
  CHECK_EQ(FlagsFor(12, false, false), UP_FLAG);
  CHECK_EQ(FlagsFor(16, false, false), SPECIAL_FLAG);
}

static void TestButton17() {
  // The touchpad click of a DualSense (button 17) is the touchpad button, which the arrival announces
  harness::Reset();
  Connect(0, kDualSenseId, "standard", 18, 4);
  Poll();
  CHECK_EQ(harness::arrivals[0].supportedButtons, kStandardButtons | TOUCHPAD_FLAG);
  SetButton(0, 17, true);
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().buttons == TOUCHPAD_FLAG);

  // The Share or Capture button of other controllers is the misc button
  harness::Reset();
  Connect(0, kXboxId, "standard", 18, 4);
  Poll();
  CHECK_EQ(harness::arrivals[0].supportedButtons, kStandardButtons | MISC_FLAG);
  SetButton(0, 17, true);
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().buttons == MISC_FLAG);

  // The type of the setting decides: an Xbox controller sent to the PC as a PlayStation controller has a touchpad button
  harness::Reset(false, false, false, false, LI_CTYPE_PS);
  Connect(0, kXboxId, "standard", 18, 4);
  Poll();
  CHECK_EQ(harness::arrivals[0].supportedButtons, kStandardButtons | TOUCHPAD_FLAG);
  SetButton(0, 17, true);
  SetButton(0, kButtonY, true);
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().buttons == (TOUCHPAD_FLAG | Y_FLAG));

  // Buttons after 17 are not sent
  harness::Reset();
  Connect(0, kXboxId, "", 20, 4);
  Poll();
  CHECK_EQ(harness::arrivals[0].supportedButtons, kStandardButtons | MISC_FLAG);
  SetButton(0, 18, true);
  SetButton(0, 19, true);
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().buttons == 0);
}

static void TestStopCombo() {
  // LB + RB + Back + Start ends the stream
  harness::Reset();
  Connect(0);
  Poll();
  for (int button : { kButtonLB, kButtonRB, kButtonBack, kButtonStart }) {
    SetButton(0, button, true);
  }
  SetButton(0, 11, true); // with the right stick pressed as well, the combo doesn't match
  Poll();
  CHECK_EQ(harness::stopStreamCalls, 0);
  SetButton(0, 11, false);
  Poll();
  CHECK_EQ(harness::stopStreamCalls, 1);

  // The face button swaps don't change it
  harness::Reset(false, false, true, true);
  Connect(0);
  Poll();
  for (int button : { kButtonLB, kButtonRB, kButtonBack, kButtonStart }) {
    SetButton(0, button, true);
  }
  Poll();
  CHECK_EQ(harness::stopStreamCalls, 1);
}

static void TestStatsCombo() {
  // Back + LB + RB + X toggles the performance statistics once per hold
  harness::Reset();
  Connect(0);
  Poll();
  for (int button : { kButtonX, kButtonLB, kButtonRB, kButtonBack }) {
    SetButton(0, button, true);
  }
  for (int i = 0; i < 20; ++i) {
    Poll();
  }
  CHECK_EQ(harness::toggleStatsCalls, 1);
  SetButton(0, kButtonX, false);
  Poll();
  SetButton(0, kButtonX, true);
  Poll();
  CHECK_EQ(harness::toggleStatsCalls, 2);
  for (int button : { kButtonX, kButtonLB, kButtonRB, kButtonBack }) {
    SetButton(0, button, false);
  }
  Poll();

  // The combo takes the physical buttons, before the X/Y swap: still X (the left button), not Y
  harness::Reset(false, false, false, true);
  Connect(0);
  Poll();
  for (int button : { kButtonY, kButtonLB, kButtonRB, kButtonBack }) {
    SetButton(0, button, true);
  }
  Poll();
  CHECK_EQ(harness::toggleStatsCalls, 0);
  SetButton(0, kButtonY, false);
  SetButton(0, kButtonX, true);
  Poll();
  CHECK_EQ(harness::toggleStatsCalls, 1);
}

// Hold Start on a controller until the mouse emulation toggles, then release it. Returns how long it was held.
static int HoldStartUntilToggle(int controller) {
  const bool before = mouseEmulationActive;
  SetButton(controller, kButtonStart, true);
  int heldMs = 0;
  while (mouseEmulationActive == before && heldMs < 3000) {
    Poll(5);
    heldMs += 5;
  }
  SetButton(controller, kButtonStart, false);
  Poll();
  return heldMs;
}

// The last packet sent for a controller, or nullptr
static const harness::PadPacket* LastPacketOf(int controller) {
  for (auto packet = padPackets.rbegin(); packet != padPackets.rend(); ++packet) {
    if (packet->controller == controller) {
      return &*packet;
    }
  }
  return nullptr;
}

// Check that a packet releases everything: no button, triggers at 0 and sticks centred
static bool IsNeutral(const harness::PadPacket* packet) {
  return packet && packet->buttons == 0 && packet->leftTrigger == 0 && packet->rightTrigger == 0 && packet->leftStickX == 0 &&
    packet->leftStickY == 0 && packet->rightStickX == 0 && packet->rightStickY == 0;
}

static void TestMouseEmulationToggle() {
  // Holding Start for a second turns the mouse emulation on, and the controller then acts as a mouse
  harness::Reset(false, true);
  Connect(0);
  Poll();
  SetButton(0, kButtonStart, true);
  PollFor(990);
  CHECK(!mouseEmulationActive);
  PollFor(20);
  CHECK(mouseEmulationActive);
  CHECK(!harness::postedToJs.empty() && harness::postedToJs.back() == "mouseEmulationOn");
  SetButton(0, kButtonStart, false);
  Poll();
  const size_t packetsBefore = padPackets.size();
  harness::mouseButtons.clear();
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(padPackets.size(), packetsBefore);
  CHECK(harness::mouseButtons.size() == 1 && harness::mouseButtons[0].button == BUTTON_LEFT &&
        harness::mouseButtons[0].action == BUTTON_ACTION_PRESS);
  SetButton(0, kButtonA, false);
  Poll();

  // The left stick moves the mouse as before: 10 pixels per poll at full deflection, nothing at rest
  harness::mouseMoves.clear();
  harness::slots[0].axis[0] = 1.0;
  Poll();
  CHECK(harness::mouseMoves.size() == 1 && harness::mouseMoves[0] == std::make_pair(10, 0));
  harness::slots[0].axis[0] = 0.0;
  harness::slots[0].axis[1] = 1.0;
  Poll();
  CHECK(harness::mouseMoves.size() == 2 && harness::mouseMoves[1] == std::make_pair(0, 10));
  harness::slots[0].axis[1] = 0.0;
  PollFor(100);
  CHECK_EQ(harness::mouseMoves.size(), 2u);

  // New settings (the start of a stream) end the mouse emulation; the Stream Menu can turn it on without the setting
  harness::Instance()->HandleGamepadInputState(false, false, harness::FaceButtonSwapMapping(false, false), LI_CTYPE_UNKNOWN);
  Poll();
  CHECK(!mouseEmulationActive);
}

static void TestOneTogglePerHold() {
  // Holding Start for 2.1 seconds toggles once, instead of again after every further second
  harness::Reset(false, true);
  Connect(0);
  Poll();
  SetButton(0, kButtonStart, true);
  int toggles = 0;
  bool previous = mouseEmulationActive;
  for (int elapsed = 0; elapsed < 2100; elapsed += 5) {
    Poll(5);
    if (mouseEmulationActive != previous) {
      toggles++;
      previous = mouseEmulationActive;
    }
  }
  CHECK_EQ(toggles, 1);
  CHECK(mouseEmulationActive);

  // The next hold turns it off again
  SetButton(0, kButtonStart, false);
  Poll();
  CHECK(mouseEmulationActive);
  const int heldMs = HoldStartUntilToggle(0);
  CHECK(!mouseEmulationActive);
  CHECK(heldMs >= 1000 && heldMs <= 1010);
  CHECK(harness::postedToJs.size() == 2 && harness::postedToJs[1] == "mouseEmulationOff");

  // Start held with LB, RB or Back, the buttons of the combos, doesn't toggle, even once they are released again.
  // (Back + Start opens the Stream Menu instead.)
  for (int comboButton : { kButtonLB, kButtonRB, kButtonBack }) {
    harness::Reset(false, true);
    Connect(0);
    Poll();
    SetButton(0, kButtonStart, true);
    SetButton(0, comboButton, true);
    PollFor(1500);
    CHECK(!mouseEmulationActive);
    SetButton(0, comboButton, false);
    PollFor(1500);
    CHECK(!mouseEmulationActive);
    SetButton(0, kButtonStart, false);
    Poll();
    const std::vector<std::string> expected = comboButton == kButtonBack ? std::vector<std::string>{ "streamMenuRequested" } :
      std::vector<std::string>{};
    CHECK(harness::postedToJs == expected);
  }

  // With the mouse emulation switch off, holding Start never toggles, and the host gets Start all along
  harness::Reset(false, false);
  Connect(0);
  Poll();
  SetButton(0, kButtonStart, true);
  PollFor(1500);
  CHECK(!mouseEmulationActive);
  CHECK(harness::postedToJs.empty());
  CHECK(!padPackets.empty() && (padPackets.back().buttons & PLAY_FLAG));
}

static void TestNeutralPadBeforeMouseMode() {
  // Walking forward while holding Start, with a second controller walking and holding A: the host must not keep Start,
  // A and the sticks held once the mouse mode starts
  harness::Reset(false, true);
  Connect(0);
  Connect(1);
  Poll();
  harness::slots[0].axis[0] = 0.8;
  harness::slots[1].axis[1] = -0.6;
  harness::slots[1].analogButton[7] = 0.5;
  SetButton(1, kButtonA, true);
  SetButton(0, kButtonStart, true);
  Poll();
  PollFor(static_cast<int>(kComboChordWindowMs));
  CHECK(LastPacketOf(0) && (LastPacketOf(0)->buttons & PLAY_FLAG));
  for (int elapsed = 0; elapsed < 3000 && !mouseEmulationActive; elapsed += 5) {
    Poll(5);
  }
  CHECK(mouseEmulationActive);
  // The poll that turned it on sent both controllers with nothing pressed and the sticks centred
  CHECK(IsNeutral(LastPacketOf(0)));
  CHECK(IsNeutral(LastPacketOf(1)));
  CHECK(LastPacketOf(1) && LastPacketOf(1)->activeMask == 3);

  // While the mouse mode is on, the host gets no controller states, not even the periodic refresh
  const size_t packetsInMouseMode = padPackets.size();
  SetButton(0, kButtonStart, false);
  PollFor(500);
  CHECK_EQ(padPackets.size(), packetsInMouseMode);

  // A controller that arrives changes the mask, so every controller sends its neutral state again with the new mask; a
  // state that the input queue didn't take is sent again on the next poll
  harness::failNextPackets = 1;
  Connect(2);
  Poll();
  CHECK(LastPacketOf(0) && LastPacketOf(0)->activeMask == 3);
  CHECK(IsNeutral(LastPacketOf(2)) && LastPacketOf(2)->activeMask == 7);
  Poll();
  CHECK(IsNeutral(LastPacketOf(0)) && LastPacketOf(0)->activeMask == 7);

  // Turning it off: the controllers send their state again at once, without the Start of the hold that turned it off,
  // and the left mouse button that the second controller held is released
  harness::mouseButtons.clear();
  SetButton(0, kButtonStart, true);
  for (int elapsed = 0; elapsed < 3000 && mouseEmulationActive; elapsed += 5) {
    Poll(5);
  }
  CHECK(!mouseEmulationActive);
  CHECK(LastPacketOf(0) && !(LastPacketOf(0)->buttons & PLAY_FLAG) && LastPacketOf(0)->leftStickX == static_cast<short>(0.8 * 32767));
  CHECK(LastPacketOf(1) && (LastPacketOf(1)->buttons & A_FLAG) && LastPacketOf(1)->leftStickY == static_cast<short>(0.6 * 32767) &&
        LastPacketOf(1)->rightTrigger == static_cast<unsigned char>(0.5 * 255));
  CHECK(harness::mouseButtons.size() == 1 && harness::mouseButtons[0].button == BUTTON_LEFT &&
        harness::mouseButtons[0].action == BUTTON_ACTION_RELEASE);
  PollFor(500);
  CHECK(LastPacketOf(0) && !(LastPacketOf(0)->buttons & PLAY_FLAG));

  // Once released and pressed again, Start reaches the host again, after the window of the Stream Menu combo
  SetButton(0, kButtonStart, false);
  Poll();
  SetButton(0, kButtonStart, true);
  Poll();
  PollFor(static_cast<int>(kComboChordWindowMs));
  CHECK(LastPacketOf(0) && (LastPacketOf(0)->buttons & PLAY_FLAG));
}

static void TestMouseEmulationResetForNewStream() {
  // A stream ends in mouse mode, with Start and A held
  harness::Reset(false, true);
  Connect(0);
  Poll();
  SetButton(0, kButtonStart, true);
  PollFor(1010);
  CHECK(mouseEmulationActive);
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(harness::mouseButtons.size(), 1u);

  // The next stream starts without the mouse emulation
  harness::Instance()->HandleGamepadInputState(false, true, harness::FaceButtonSwapMapping(false, false), LI_CTYPE_UNKNOWN);
  CHECK(!mouseEmulationActive);
  padPackets.clear();
  harness::mouseButtons.clear();
  Poll();
  // The controller acts as a controller: A and Start reach the host (Start after the window of the Stream Menu combo),
  // and its new host gets no mouse button release
  CHECK(!padPackets.empty() && (padPackets.back().buttons & A_FLAG));
  PollFor(static_cast<int>(kComboChordWindowMs));
  CHECK(!padPackets.empty() && (padPackets.back().buttons & A_FLAG) && (padPackets.back().buttons & PLAY_FLAG));
  CHECK(harness::mouseButtons.empty());
  // The Start that is still held counts as a new hold from the start of the stream
  PollFor(500 - static_cast<int>(kComboChordWindowMs));
  CHECK(!mouseEmulationActive);
  PollFor(510);
  CHECK(mouseEmulationActive);
}

// Count the mouse button events of a button and action
static int CountMouseButtons(int button, char action) {
  int count = 0;
  for (const auto& event : harness::mouseButtons) {
    count += event.button == button && event.action == action;
  }
  return count;
}

static void TestMouseButtonsOnlyOnChange() {
  // Two controllers in mouse emulation, the first holds A: one left press and nothing else
  harness::Reset(false, true);
  Connect(0);
  Connect(1);
  Poll();
  HoldStartUntilToggle(0);
  CHECK(mouseEmulationActive);
  harness::mouseButtons.clear();
  SetButton(0, kButtonA, true);
  PollFor(50);
  CHECK_EQ(CountMouseButtons(BUTTON_LEFT, BUTTON_ACTION_PRESS), 1);
  CHECK_EQ(harness::mouseButtons.size(), 1u);

  // The second controller holds A as well, then the first one lets go: the button stays held
  SetButton(1, kButtonA, true);
  Poll();
  SetButton(0, kButtonA, false);
  PollFor(50);
  CHECK_EQ(harness::mouseButtons.size(), 1u);

  // RB holds the right button and X the middle button; letting go of everything releases each button once
  SetButton(0, kButtonRB, true);
  SetButton(0, kButtonX, true);
  Poll();
  CHECK_EQ(CountMouseButtons(BUTTON_RIGHT, BUTTON_ACTION_PRESS), 1);
  CHECK_EQ(CountMouseButtons(BUTTON_MIDDLE, BUTTON_ACTION_PRESS), 1);
  SetButton(0, kButtonRB, false);
  SetButton(0, kButtonX, false);
  SetButton(1, kButtonA, false);
  PollFor(50);
  CHECK_EQ(CountMouseButtons(BUTTON_LEFT, BUTTON_ACTION_RELEASE), 1);
  CHECK_EQ(CountMouseButtons(BUTTON_RIGHT, BUTTON_ACTION_RELEASE), 1);
  CHECK_EQ(CountMouseButtons(BUTTON_MIDDLE, BUTTON_ACTION_RELEASE), 1);
  CHECK_EQ(harness::mouseButtons.size(), 6u);

  // An event that the input queue didn't take is sent on the next poll
  harness::failNextMouseButtons = 1;
  SetButton(1, kButtonB, true);
  Poll();
  CHECK_EQ(harness::mouseButtons.size(), 6u);
  Poll();
  CHECK_EQ(CountMouseButtons(BUTTON_RIGHT, BUTTON_ACTION_PRESS), 2);
  Poll();
  CHECK_EQ(harness::mouseButtons.size(), 7u);

  // Leaving the mouse emulation releases the held button
  HoldStartUntilToggle(0);
  CHECK(!mouseEmulationActive);
  CHECK_EQ(CountMouseButtons(BUTTON_RIGHT, BUTTON_ACTION_RELEASE), 2);
  PollFor(50);
  CHECK_EQ(harness::mouseButtons.size(), 8u);
}

// Sum the amounts of scroll events
static int Sum(const std::vector<int>& amounts) {
  int sum = 0;
  for (int amount : amounts) {
    sum += amount;
  }
  return sum;
}

// Check that every amount of scroll events lies within a range
static bool AllWithin(const std::vector<int>& amounts, int low, int high) {
  for (int amount : amounts) {
    if (amount < low || amount > high) {
      return false;
    }
  }
  return true;
}

static void TestScroll() {
  harness::Reset(false, true);
  Connect(0);
  Poll();
  HoldStartUntilToggle(0);
  CHECK(mouseEmulationActive);

  // A stick within the rest zone doesn't scroll
  harness::slots[0].axis[2] = 0.12;
  harness::slots[0].axis[3] = -0.1;
  PollFor(1000);
  CHECK(harness::scrolls.empty());
  CHECK(harness::horizontalScrolls.empty());

  // Half deflection up scrolls about 2.5 notches (120 units each) per second, in steps of a quarter notch, where it
  // scrolled not at all before
  harness::slots[0].axis[2] = 0.0;
  harness::slots[0].axis[3] = -0.5;
  PollFor(1000);
  CHECK(Sum(harness::scrolls) >= 240 && Sum(harness::scrolls) <= 330);
  CHECK(AllWithin(harness::scrolls, 30, 40));

  // At 90 % deflection it scrolls faster
  harness::scrolls.clear();
  harness::slots[0].axis[3] = -0.9;
  PollFor(1000);
  CHECK(Sum(harness::scrolls) >= 1300 && Sum(harness::scrolls) <= 1450);

  // Full deflection down scrolls 15 notches per second, where it scrolled one notch on every poll (200 per second) before
  harness::scrolls.clear();
  harness::slots[0].axis[3] = 1.0;
  PollFor(1000);
  CHECK(Sum(harness::scrolls) <= -1750 && Sum(harness::scrolls) >= -1810);

  // Back at rest, it stops, and the rest of a step doesn't add to the next scroll
  harness::slots[0].axis[3] = 0.0;
  PollFor(100);
  harness::scrolls.clear();
  PollFor(1000);
  CHECK(harness::scrolls.empty());

  // Half deflection right scrolls horizontally
  harness::slots[0].axis[2] = 0.5;
  PollFor(1000);
  CHECK(harness::scrolls.empty());
  CHECK(Sum(harness::horizontalScrolls) >= 240 && Sum(harness::horizontalScrolls) <= 330);

  // A host without horizontal scrolling (GFE): what it can't take doesn't pile up
  harness::horizontalScrollResult = LI_ERR_UNSUPPORTED;
  harness::horizontalScrolls.clear();
  PollFor(1000);
  CHECK(!harness::horizontalScrolls.empty() && AllWithin(harness::horizontalScrolls, 30, 40));

  // The sticks of two controllers add up
  harness::Reset(false, true);
  Connect(0);
  Connect(1);
  Poll();
  HoldStartUntilToggle(0);
  harness::slots[0].axis[3] = -0.5;
  harness::slots[1].axis[3] = -0.5;
  PollFor(1000);
  CHECK(Sum(harness::scrolls) >= 540 && Sum(harness::scrolls) <= 620);
}

int main() {
  harness::Install();
  test_support::RunTest("arrival: type, buttons, analog triggers and rumble only when usable", TestArrival);
  test_support::RunTest("arrival: the controller is logged with its id, mapping, layout, rumble and type", TestArrivalLog);
  test_support::RunTest("arrival: the controller type of the setting replaces the detected one", TestControllerTypeSetting);
  test_support::RunTest("A/B and X/Y swaps", TestFaceButtonSwaps);
  test_support::RunTest("button 17 is sent as the touchpad or misc button", TestButton17);
  test_support::RunTest("LB + RB + Back + Start ends the stream only as the exact combo", TestStopCombo);
  test_support::RunTest("Back + LB + RB + X toggles the statistics once per hold, on the physical buttons", TestStatsCombo);
  test_support::RunTest("holding Start turns the mouse emulation on", TestMouseEmulationToggle);
  test_support::RunTest("holding Start toggles the mouse emulation once per hold", TestOneTogglePerHold);
  test_support::RunTest("the host gets Start released and the sticks centred before the mouse mode starts", TestNeutralPadBeforeMouseMode);
  test_support::RunTest("a new stream starts without the mouse emulation of the previous one", TestMouseEmulationResetForNewStream);
  test_support::RunTest("mouse buttons are sent only when they change, across controllers", TestMouseButtonsOnlyOnChange);
  test_support::RunTest("the right stick scrolls at partial deflection, with a rest zone and a curve", TestScroll);
  return test_support::Summary();
}
