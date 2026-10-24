// Pins the controller behaviour of wasm/gamepad.cpp during a stream: the controller type and buttons announced to the
// host, the face button swaps, the button combos and the capabilities. The known bugs of plan finding C7 and the
// gamepad items of plan WP7 (mouse emulation, scrolling, button 17) are todo tests, which don't fail the run and turn
// into regular tests once they are fixed.

#include "gamepad_harness.h"
#include "test_support.h"

using harness::Connect;
using harness::Poll;
using harness::PollForRealTime;
using harness::SetButton;
using harness::padPackets;

static const char* kXboxId = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)";
static const char* kDualSenseId = "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)";
static const uint32_t kStandardButtons = A_FLAG | B_FLAG | X_FLAG | Y_FLAG | LB_FLAG | RB_FLAG | BACK_FLAG | PLAY_FLAG |
  LS_CLK_FLAG | RS_CLK_FLAG | UP_FLAG | DOWN_FLAG | LEFT_FLAG | RIGHT_FLAG | SPECIAL_FLAG;

// The controller type for an id as the browser reports it, cut to 63 bytes like the Emscripten event struct
static int TypeOf(const char* id) {
  char truncated[EM_HTML5_MEDIUM_STRING_LEN_BYTES];
  std::strncpy(truncated, id, sizeof(truncated) - 1);
  truncated[sizeof(truncated) - 1] = 0;
  return GetControllerType(truncated);
}

static void TestControllerTypes() {
  CHECK_EQ(TypeOf(kXboxId), LI_CTYPE_XBOX);
  CHECK_EQ(TypeOf("Generic X-Box pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)"), LI_CTYPE_XBOX);
  CHECK_EQ(TypeOf(kDualSenseId), LI_CTYPE_PS);
  CHECK_EQ(TypeOf("Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"), LI_CTYPE_PS);
  CHECK_EQ(TypeOf("Sony Interactive Entertainment Wireless Controller (Vendor: 054c Product: 05c4)"), LI_CTYPE_PS);
  CHECK_EQ(TypeOf("HORIPAD FPS for PlayStation 4 (Vendor: 0f0d Product: 0066)"), LI_CTYPE_PS);
  CHECK_EQ(TypeOf("054c-0ce6-DualSense Wireless Controller"), LI_CTYPE_PS);
  CHECK_EQ(TypeOf("Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)"), LI_CTYPE_NINTENDO);
  CHECK_EQ(TypeOf("Joy-Con L+R (STANDARD GAMEPAD)"), LI_CTYPE_NINTENDO);
  // Without a vendor or a known name the type stays unknown
  CHECK_EQ(TypeOf("8BitDo Ultimate 2C Wireless Controller (STANDARD GAMEPAD Vendor: 2dc8 Product: 310a)"), LI_CTYPE_UNKNOWN);
  CHECK_EQ(TypeOf("Wireless Controller"), LI_CTYPE_UNKNOWN);
  CHECK_EQ(TypeOf("Pro Controller"), LI_CTYPE_UNKNOWN);
  CHECK_EQ(TypeOf(""), LI_CTYPE_UNKNOWN);
}

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
  harness::Instance()->HandleGamepadInputState(false, false, true, false);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);
}

// The button flags sent for one pressed button with the given face button swaps. gamepad.cpp builds them in a short,
// so Y (0x8000) reaches the int argument sign-extended; moonlight-common-c keeps only the low 16 bits of a negative
// value (sendControllerEventInternal() in InputStream.c), which this compares as well.
static int FlagsFor(int button, bool flipAB, bool flipXY) {
  harness::Reset(false, false, flipAB, flipXY);
  Connect(0);
  Poll();
  SetButton(0, button, true);
  Poll();
  return padPackets.empty() ? -1 : (padPackets.back().buttons & 0xFFFF);
}

static void TestFaceButtonSwaps() {
  CHECK_EQ(FlagsFor(0, false, false), A_FLAG);
  CHECK_EQ(FlagsFor(2, false, false), X_FLAG);
  CHECK_EQ(FlagsFor(0, true, false), B_FLAG);
  CHECK_EQ(FlagsFor(1, true, false), A_FLAG);
  CHECK_EQ(FlagsFor(2, true, false), X_FLAG);
  CHECK_EQ(FlagsFor(2, false, true), Y_FLAG);
  CHECK_EQ(FlagsFor(3, false, true), X_FLAG);
  CHECK_EQ(FlagsFor(0, true, true), B_FLAG);
  CHECK_EQ(FlagsFor(3, true, true), X_FLAG);
  // The other buttons keep their flags
  CHECK_EQ(FlagsFor(9, true, true), PLAY_FLAG);
  CHECK_EQ(FlagsFor(12, false, false), UP_FLAG);
  CHECK_EQ(FlagsFor(16, false, false), SPECIAL_FLAG);
}

static void TestStopCombo() {
  // LB + RB + Back + Start ends the stream
  harness::Reset();
  Connect(0);
  Poll();
  for (int button : { 4, 5, 8, 9 }) {
    SetButton(0, button, true);
  }
  SetButton(0, 11, true); // with the right stick pressed as well, the combo doesn't match
  Poll();
  CHECK_EQ(harness::stopStreamCalls, 0);
  SetButton(0, 11, false);
  Poll();
  CHECK_EQ(harness::stopStreamCalls, 1);
}

static void TestStatsCombo() {
  // Back + LB + RB + X toggles the performance statistics once per hold
  harness::Reset();
  Connect(0);
  Poll();
  for (int button : { 2, 4, 5, 8 }) {
    SetButton(0, button, true);
  }
  for (int i = 0; i < 20; ++i) {
    Poll();
  }
  CHECK_EQ(harness::toggleStatsCalls, 1);
  SetButton(0, 2, false);
  Poll();
  SetButton(0, 2, true);
  Poll();
  CHECK_EQ(harness::toggleStatsCalls, 2);
  for (int button : { 2, 4, 5, 8 }) {
    SetButton(0, button, false);
  }
  Poll();
}

static void TestMouseEmulationToggle() {
  // Holding Start for a second turns the mouse emulation on, and the controller then acts as a mouse
  harness::Reset(false, true);
  Connect(0);
  Poll();
  SetButton(0, 9, true);
  for (int i = 0; i < 400 && !mouseEmulationActive; ++i) {
    PollForRealTime(5);
  }
  CHECK(mouseEmulationActive);
  CHECK(!harness::postedToJs.empty() && harness::postedToJs.back() == "mouseEmulationOn");
  SetButton(0, 9, false);
  Poll();
  const size_t packetsBefore = padPackets.size();
  harness::mouseButtons.clear();
  SetButton(0, 0, true);
  Poll();
  CHECK_EQ(padPackets.size(), packetsBefore);
  bool leftPressed = false;
  for (const auto& event : harness::mouseButtons) {
    leftPressed = leftPressed || (event.button == BUTTON_LEFT && event.action == BUTTON_ACTION_PRESS);
  }
  CHECK(leftPressed);
  SetButton(0, 0, false);
  Poll();
  // Turning the setting off ends the mouse emulation on the next poll
  harness::Instance()->HandleGamepadInputState(false, false, false, false);
  Poll();
  CHECK(!mouseEmulationActive);
}

static void TodoMouseEmulationResetForNewStream() {
  harness::Reset(false, true);
  mouseEmulationActive = true; // left on at the end of the previous stream
  harness::Instance()->HandleGamepadInputState(false, true, false, false); // the next stream starts
  CHECK(!mouseEmulationActive);
  Connect(0);
  Poll();
  SetButton(0, 0, true);
  Poll();
  CHECK(!padPackets.empty() && (padPackets.back().buttons & A_FLAG));
  mouseEmulationActive = false;
}

static void TodoMouseButtonsOnlyOnChange() {
  // Two controllers in mouse emulation, the first holds A: one left press and nothing else
  harness::Reset(false, true);
  Connect(0);
  Connect(1);
  Poll();
  mouseEmulationActive = true;
  SetButton(0, 0, true);
  harness::mouseButtons.clear();
  for (int i = 0; i < 10; ++i) {
    Poll();
  }
  int presses = 0;
  int releases = 0;
  for (const auto& event : harness::mouseButtons) {
    if (event.button == BUTTON_LEFT) {
      (event.action == BUTTON_ACTION_PRESS ? presses : releases)++;
    }
  }
  CHECK_EQ(presses, 1);
  CHECK_EQ(releases, 0);
  CHECK_EQ(harness::mouseButtons.size(), 1u);
  mouseEmulationActive = false;
}

static void TodoNeutralPadBeforeMouseMode() {
  // Walking forward while holding Start: the host must not keep Start and the stick held once the mouse mode starts
  harness::Reset(false, true);
  Connect(0);
  Poll();
  harness::slots[0].axis[0] = 0.8;
  SetButton(0, 9, true);
  for (int i = 0; i < 400 && !mouseEmulationActive; ++i) {
    PollForRealTime(5);
  }
  CHECK(mouseEmulationActive);
  CHECK(!padPackets.empty() && !(padPackets.back().buttons & PLAY_FLAG));
  CHECK(!padPackets.empty() && padPackets.back().leftStickX == 0);
  SetButton(0, 9, false);
  harness::slots[0].axis[0] = 0.0;
  Poll();
  mouseEmulationActive = false;
}

static void TodoOneTogglePerHold() {
  harness::Reset(false, true);
  Connect(0);
  Poll();
  SetButton(0, 9, true);
  int toggles = 0;
  bool previous = mouseEmulationActive;
  const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(2100);
  while (std::chrono::steady_clock::now() < end) {
    PollForRealTime(5);
    if (mouseEmulationActive != previous) {
      toggles++;
      previous = mouseEmulationActive;
    }
  }
  CHECK_EQ(toggles, 1);
  SetButton(0, 9, false);
  Poll();
  mouseEmulationActive = false;
}

static void TodoScrollAtPartialDeflection() {
  harness::Reset(false, true);
  Connect(0);
  Poll();
  mouseEmulationActive = true;
  harness::slots[0].axis[3] = -0.9;
  for (int i = 0; i < 20; ++i) {
    Poll();
  }
  int scrolled = 0;
  for (int amount : harness::scrolls) {
    scrolled += amount != 0;
  }
  CHECK(scrolled > 0);
  harness::slots[0].axis[3] = 0.0;
  Poll();
  mouseEmulationActive = false;
}

static void TodoButton17() {
  // The touchpad click of a DualSense (button 17) is sent as the touchpad button, the Share or Capture button of
  // other controllers as the misc button
  harness::Reset();
  Connect(0, kDualSenseId, "standard", 18, 4);
  Poll();
  SetButton(0, 17, true);
  Poll();
  CHECK(!padPackets.empty() && (padPackets.back().buttons & TOUCHPAD_FLAG));
  harness::Reset();
  Connect(0, kXboxId, "standard", 18, 4);
  Poll();
  SetButton(0, 17, true);
  Poll();
  CHECK(!padPackets.empty() && (padPackets.back().buttons & MISC_FLAG));
}

int main() {
  harness::Install();
  test_support::RunTest("controller type from the gamepad id", TestControllerTypes);
  test_support::RunTest("arrival: type, buttons, analog triggers and rumble only when usable", TestArrival);
  test_support::RunTest("A/B and X/Y swaps", TestFaceButtonSwaps);
  test_support::RunTest("LB + RB + Back + Start ends the stream only as the exact combo", TestStopCombo);
  test_support::RunTest("Back + LB + RB + X toggles the statistics once per hold", TestStatsCombo);
  test_support::RunTest("holding Start turns the mouse emulation on", TestMouseEmulationToggle);
  test_support::RunTodoTest("a new stream starts without the mouse emulation of the previous one", "Known bug C7 (plan WP7): mouseEmulationActive is not reset by HandleGamepadInputState", TodoMouseEmulationResetForNewStream);
  test_support::RunTodoTest("mouse buttons are sent only when they change, across controllers", "Known bug C7 (plan WP7): every controller sends press or release on every poll", TodoMouseButtonsOnlyOnChange);
  test_support::RunTodoTest("the host gets Start released and the sticks centred before the mouse mode starts", "Known bug (plan WP7)", TodoNeutralPadBeforeMouseMode);
  test_support::RunTodoTest("holding Start toggles the mouse emulation once per hold", "Known bug (plan WP7): it toggles again every second", TodoOneTogglePerHold);
  test_support::RunTodoTest("the right stick scrolls at partial deflection", "Known bug (plan WP7): the scroll amount is truncated to 0 below full deflection", TodoScrollAtPartialDeflection);
  test_support::RunTodoTest("button 17 is sent as the touchpad or misc button", "Plan WP7: button 17 is ignored", TodoButton17);
  return test_support::Summary();
}
