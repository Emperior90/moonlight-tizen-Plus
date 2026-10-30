// Checks the button mapping and the stick calibration of the controllers: the text of the front end that
// wasm/controller_mapping.hpp reads (one line per controller, malformed lines and calibrations left out, and the text of
// tests/fixtures/button-mappings.txt that wasm/platform/button_mapping.js writes), the mapping
// each controller gets (its own line before the line for every controller), the buttons and triggers of MapButtons(),
// CalibrateAxis(), and in wasm/gamepad.cpp during a stream: the buttons that the host gets and the arrival announces,
// the triggers moved to buttons and back, a button that presses nothing, the Guide button and button 17 kept, the
// calibrated sticks, and the Stream Menu, stop and statistics combos detected on the physical buttons before the mapping.

#include "gamepad_harness.h"
#include "test_support.h"

#include <fstream>
#include <string>

using harness::Connect;
using harness::Poll;
using harness::PollFor;
using harness::SetButton;
using harness::padPackets;

static const char* kXboxId = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)";
static const char* kPadId = "8BitDo SN30 Pro (Vendor: 2dc8 Product: 6101)";

static constexpr int kButtonA = 0;
static constexpr int kButtonB = 1;
static constexpr int kButtonX = 2;
static constexpr int kButtonY = 3;
static constexpr int kButtonLB = 4;
static constexpr int kButtonRB = 5;
static constexpr int kButtonLT = 6;
static constexpr int kButtonRT = 7;
static constexpr int kButtonBack = 8;
static constexpr int kButtonStart = 9;

// The targets of a line: each button presses itself, except the given pairs
static std::string Targets(std::initializer_list<std::pair<int, int>> changes) {
  int targets[kMappedButtons];
  for (int i = 0; i < kMappedButtons; ++i) {
    targets[i] = i;
  }
  for (const auto& change : changes) {
    targets[change.first] = change.second;
  }
  std::string text;
  for (int i = 0; i < kMappedButtons; ++i) {
    text += (i == 0 ? "" : ",") + std::to_string(targets[i]);
  }
  return text;
}

static const char* kIdentity = "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15";

static void TestParse() {
  const std::string calibration = "0.1,-0.05,-0.8,0.9,-0.95,0.85,0,0,-1,1,-1,1";
  const ControllerMappings mappings = ParseControllerMappings(
    Targets({ { 0, 1 }, { 1, 0 } }) + ";;*\n" +
    Targets({ { 2, -1 } }) + ";" + calibration + ";" + kXboxId + "\n" +
    // Malformed lines: too few targets, a target out of range, a fraction, no id, no separators
    "0,1,2;;short\n" +
    Targets({ { 3, 16 } }) + ";;range\n" +
    "0.5,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15;;fraction\n" +
    kIdentity + ";;\n" +
    "garbage\n" +
    // A malformed calibration only loses the calibration, and a stick without enough range only its own
    std::string(kIdentity) + ";1,2,3;bad calibration\n" +
    kIdentity + ";0,0,-0.1,0.1,-1,1,0.2,0,-0.6,1,-1,1;short range\n");
  CHECK_EQ(mappings.size(), 4u);
  if (mappings.size() != 4) {
    return;
  }
  CHECK_EQ(mappings[0].id, std::string("*"));
  CHECK_EQ(mappings[0].targets[0], 1);
  CHECK_EQ(mappings[0].targets[1], 0);
  CHECK_EQ(mappings[0].targets[2], 2);
  CHECK(!mappings[0].sticks[0].valid && !mappings[0].sticks[1].valid);

  // The id comes last and keeps its separators; it is cut to the 63 bytes the stream sees
  CHECK_EQ(mappings[1].id, std::string(kXboxId).substr(0, 63));
  CHECK_EQ(mappings[1].targets[2], kButtonUnmapped);
  CHECK(mappings[1].sticks[0].valid);
  CHECK_EQ(mappings[1].sticks[0].centreX, 0.1);
  CHECK_EQ(mappings[1].sticks[0].centreY, -0.05);
  CHECK_EQ(mappings[1].sticks[0].minX, -0.8);
  CHECK_EQ(mappings[1].sticks[0].maxY, 0.85);
  CHECK(mappings[1].sticks[1].valid);

  CHECK_EQ(mappings[2].id, std::string("bad calibration"));
  CHECK(!mappings[2].sticks[0].valid && !mappings[2].sticks[1].valid);
  CHECK_EQ(mappings[3].id, std::string("short range"));
  CHECK(!mappings[3].sticks[0].valid);
  // The right stick of that line, whose centre lies 0.2 off with enough range on both sides, keeps its calibration
  CHECK(mappings[3].sticks[1].valid);
  // A centre too far from 0 makes no calibration either
  CHECK(!IsCalibratedAxis(0.6, -0.2, 1.0));
  CHECK(IsCalibratedAxis(0.2, -0.6, 1.0));
  CHECK(!IsCalibratedAxis(0.0, -1.2, 1.0));

  // An empty text has no mappings
  CHECK(ParseControllerMappings("").empty());
}

// The text of tests/fixtures/button-mappings.txt, which tests/unit/button-mapping.test.js writes from a stored mapping
static std::string ReadFixtureText() {
  std::string path = __FILE__;
  path = path.substr(0, path.find_last_of('/') + 1) + "../fixtures/button-mappings.txt";
  std::ifstream file(path);
  std::string line;
  std::string text;
  while (std::getline(file, line)) {
    if (!line.empty() && line[0] != '#') {
      text += (text.empty() ? "" : "\n") + line;
    }
  }
  return text;
}

static void TestFixture() {
  const ControllerMappings mappings = ParseControllerMappings(ReadFixtureText());
  CHECK_EQ(mappings.size(), 3u);
  if (mappings.size() != 3) {
    return;
  }
  // A and B swapped for every controller
  const int all = FindControllerMapping(mappings, "Generic USB Joystick");
  CHECK_EQ(all, 0);
  CHECK(mappings[0].targets[0] == 1 && mappings[0].targets[1] == 0 && mappings[0].targets[2] == 2);
  // The Xbox controller with its own line: D-pad left and right swapped, A as it is, and its left stick calibrated
  const int xbox = FindControllerMapping(mappings, std::string(kXboxId).substr(0, 63).c_str());
  CHECK_EQ(xbox, 1);
  if (xbox == 1) {
    CHECK(mappings[1].targets[0] == 0 && mappings[1].targets[14] == 15 && mappings[1].targets[15] == 14);
    CHECK(mappings[1].sticks[0].valid);
    CHECK_EQ(mappings[1].sticks[0].centreX, 0.05);
    CHECK_EQ(mappings[1].sticks[0].maxY, 0.95);
    // The right stick of the line is the calibration of a stick as it is
    CHECK(mappings[1].sticks[1].valid && mappings[1].sticks[1].minX == -1.0 && mappings[1].sticks[1].maxY == 1.0);
  }
  // The 8BitDo controller with the buttons of every controller and its right stick calibrated
  const int pad = FindControllerMapping(mappings, kPadId);
  CHECK_EQ(pad, 2);
  if (pad == 2) {
    CHECK_EQ(mappings[2].targets[0], 1);
    CHECK(mappings[2].sticks[1].valid);
    CHECK_EQ(mappings[2].sticks[1].centreY, 0.1);
    CHECK_EQ(mappings[2].sticks[1].minY, -0.6);
  }
}

static void TestFind() {
  const ControllerMappings mappings = ParseControllerMappings(
    std::string(kIdentity) + ";;" + kPadId + "\n" + Targets({ { 0, 1 } }) + ";;*\n");
  CHECK_EQ(FindControllerMapping(mappings, kPadId), 0);
  CHECK_EQ(FindControllerMapping(mappings, kXboxId), 1);
  // Without a line for every controller, a controller without its own has none
  const ControllerMappings own = ParseControllerMappings(std::string(kIdentity) + ";;" + kPadId);
  CHECK_EQ(FindControllerMapping(own, kXboxId), -1);
  CHECK_EQ(FindControllerMapping(own, nullptr), -1);
  // The id of the event is cut to 63 bytes, and so is the one of the line
  const ControllerMappings xbox = ParseControllerMappings(std::string(kIdentity) + ";;" + kXboxId);
  CHECK_EQ(FindControllerMapping(xbox, std::string(kXboxId).substr(0, 63).c_str()), 0);
}

static void TestMapButtons() {
  int targets[kMappedButtons];
  for (int i = 0; i < kMappedButtons; ++i) {
    targets[i] = i;
  }
  targets[kButtonA] = kButtonB;
  targets[kButtonB] = kButtonA;
  targets[kButtonX] = kButtonUnmapped;
  targets[kButtonLT] = kButtonY; // the left trigger presses Y
  targets[kButtonLB] = kButtonRT; // LB pulls the right trigger
  targets[kButtonRT] = kButtonRT;
  int pressed[18] = {};
  double values[18] = {};
  pressed[kButtonA] = 1;
  values[kButtonA] = 1.0;
  pressed[kButtonX] = 1;
  values[kButtonX] = 1.0;
  pressed[kButtonLT] = 1;
  values[kButtonLT] = 0.4;
  values[kButtonRT] = 0.3; // not far enough to count as pressed
  pressed[kButtonLB] = 1;
  values[kButtonLB] = 1.0;
  bool outPressed[kMappedButtons];
  double outValues[kMappedButtons];
  MapButtons(targets, pressed, values, 18, outPressed, outValues);
  CHECK(outPressed[kButtonB] && !outPressed[kButtonA]);
  CHECK(!outPressed[kButtonX]);
  CHECK(outPressed[kButtonY]);
  CHECK_EQ(outValues[kButtonLT], 0.0);
  // The right trigger gets the highest of its own value and the one of LB
  CHECK_EQ(outValues[kButtonRT], 1.0);
  // Only the buttons the controller has count
  MapButtons(targets, pressed, values, 1, outPressed, outValues);
  CHECK(outPressed[kButtonB] && !outPressed[kButtonY]);
  CHECK_EQ(outValues[kButtonRT], 0.0);
}

static void TestCalibrateAxis() {
  // A worn stick that rests at 0.1 and reaches -0.8 and 0.7
  CHECK_EQ(CalibrateAxis(0.1, 0.1, -0.8, 0.7), 0.0);
  CHECK_EQ(CalibrateAxis(0.7, 0.1, -0.8, 0.7), 1.0);
  CHECK_EQ(CalibrateAxis(-0.8, 0.1, -0.8, 0.7), -1.0);
  CHECK(std::fabs(CalibrateAxis(0.4, 0.1, -0.8, 0.7) - 0.5) < 1e-9);
  CHECK(std::fabs(CalibrateAxis(-0.35, 0.1, -0.8, 0.7) + 0.5) < 1e-9);
  // Beyond what it reached during the calibration it stays at the end
  CHECK_EQ(CalibrateAxis(0.95, 0.1, -0.8, 0.7), 1.0);
  CHECK_EQ(CalibrateAxis(-1.0, 0.1, -0.8, 0.7), -1.0);
  // No dead zone: a value just off the centre moves
  CHECK(CalibrateAxis(0.11, 0.1, -0.8, 0.7) > 0.0);
}

// The buttons of the last packet, or -1 without one
static int LastButtons() {
  return padPackets.empty() ? -1 : padPackets.back().buttons;
}

// The buttons the host gets for one held button with the given mapping text
static int FlagsWith(const std::string& mapping, int button, const char* id = kXboxId) {
  harness::ResetWithMapping(false, false, mapping);
  Connect(0, id);
  Poll();
  SetButton(0, button, true);
  Poll();
  PollFor(static_cast<int>(kComboChordWindowMs));
  return LastButtons();
}

static void TestStreamButtons() {
  const std::string swapAB = Targets({ { 0, 1 }, { 1, 0 } });
  CHECK_EQ(FlagsWith(swapAB + ";;*", kButtonA), B_FLAG);
  CHECK_EQ(FlagsWith(swapAB + ";;*", kButtonB), A_FLAG);
  // A controller's own line beats the line for every controller
  const std::string own = Targets({ { 0, 3 } }) + ";;" + kPadId + "\n" + swapAB + ";;*";
  CHECK_EQ(FlagsWith(own, kButtonA, kPadId), Y_FLAG);
  CHECK_EQ(FlagsWith(own, kButtonB, kPadId), B_FLAG);
  CHECK_EQ(FlagsWith(own, kButtonA, kXboxId), B_FLAG);
  // A button that presses nothing
  CHECK_EQ(FlagsWith(Targets({ { 2, -1 } }) + ";;*", kButtonX), 0);
  // Several buttons can press the same one
  CHECK_EQ(FlagsWith(Targets({ { 1, 0 } }) + ";;*", kButtonB), A_FLAG);
  // The D-pad, and a face button moved to Back that reaches the host once the window of the combo passed
  CHECK_EQ(FlagsWith(Targets({ { 12, 15 } }) + ";;*", 12), RIGHT_FLAG);
  CHECK_EQ(FlagsWith(Targets({ { 3, 8 } }) + ";;*", kButtonY), BACK_FLAG);
  // The Guide button and button 17 keep their meaning
  CHECK_EQ(FlagsWith(Targets({ { 0, 1 } }) + ";;*", 16), SPECIAL_FLAG);
  harness::ResetWithMapping(false, false, swapAB + ";;*");
  Connect(0, kXboxId, "standard", 18, 4);
  Poll();
  SetButton(0, 17, true);
  Poll();
  CHECK_EQ(LastButtons(), MISC_FLAG);
}

static void TestArrivalButtons() {
  // The arrival announces the buttons that the buttons of the controller press
  harness::ResetWithMapping(false, false, Targets({ { 0, 1 }, { 2, -1 }, { 3, -1 } }) + ";;*");
  Connect(0, "Simple pad", "", 6, 2);
  Poll();
  CHECK(!harness::arrivals.empty() &&
        harness::arrivals[0].supportedButtons == static_cast<uint32_t>(B_FLAG | LB_FLAG | RB_FLAG));
}

static void TestTriggers() {
  // The left trigger as A, and RB as the right trigger
  harness::ResetWithMapping(false, false, Targets({ { kButtonLT, kButtonA }, { kButtonRB, kButtonRT } }) + ";;*");
  Connect(0);
  Poll();
  harness::slots[0].analogButton[kButtonLT] = 0.6;
  harness::slots[0].digitalButton[kButtonLT] = EM_TRUE;
  SetButton(0, kButtonRB, true);
  Poll();
  CHECK(!padPackets.empty());
  if (!padPackets.empty()) {
    CHECK_EQ(padPackets.back().buttons, A_FLAG);
    CHECK_EQ(padPackets.back().leftTrigger, 0);
    CHECK_EQ(padPackets.back().rightTrigger, 255);
  }
  // The triggers as they are without a mapping
  harness::Reset();
  Connect(0);
  Poll();
  harness::slots[0].analogButton[kButtonLT] = 0.6;
  harness::slots[0].analogButton[kButtonRT] = 0.2;
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().leftTrigger == 153 && padPackets.back().rightTrigger == 51);
}

static void TestCalibratedSticks() {
  // The left stick rests at 0.1 and reaches -0.8 and 0.7 on X, and the full range on Y; the right stick is calibrated
  // as it is
  const std::string mapping = std::string(kIdentity) + ";0.1,0,-0.8,0.7,-1,1,0,0,-1,1,-1,1;" + kXboxId;
  harness::ResetWithMapping(false, false, mapping);
  Connect(0);
  Poll();
  harness::slots[0].axis[0] = 0.1;
  harness::slots[0].axis[1] = -0.5;
  harness::slots[0].axis[2] = 0.25;
  Poll();
  CHECK(!padPackets.empty());
  if (!padPackets.empty()) {
    CHECK_EQ(padPackets.back().leftStickX, 0);
    CHECK_EQ(padPackets.back().leftStickY, 16383); // the Y axis of the protocol points up
    CHECK_EQ(padPackets.back().rightStickX, 8191);
  }
  harness::slots[0].axis[0] = 0.7;
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().leftStickX == 32767);
  // Another controller without a calibration sends its sticks as they are
  harness::ResetWithMapping(false, false, mapping);
  Connect(0, kPadId);
  Poll();
  harness::slots[0].axis[0] = 0.7;
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().leftStickX == 22936);
}

static void TestCombosOnPhysicalButtons() {
  // Back and Start mapped elsewhere: holding them still opens the Stream Menu, and the game gets neither them nor what
  // they are mapped to
  harness::ResetWithMapping(false, false, Targets({ { kButtonBack, kButtonA }, { kButtonStart, kButtonB } }) + ";;*");
  Connect(0);
  Poll();
  const size_t before = padPackets.size();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  PollFor(static_cast<int>(kStreamMenuHoldMs) + 20);
  int count = 0;
  for (const std::string& message : harness::postedToJs) {
    count += message == "streamMenuRequested";
  }
  CHECK_EQ(count, 1);
  bool leaked = false;
  for (size_t i = before; i < padPackets.size(); ++i) {
    leaked = leaked || (padPackets[i].buttons & (A_FLAG | B_FLAG | BACK_FLAG | PLAY_FLAG)) != 0;
  }
  CHECK(!leaked);

  // A short Back + Start that isn't the combo reaches the game afterwards as what they are mapped to
  harness::ResetWithMapping(false, false, Targets({ { kButtonBack, kButtonA }, { kButtonStart, kButtonB } }) + ";;*");
  Connect(0);
  Poll();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  PollFor(300);
  CHECK_EQ(LastButtons(), 0);
  SetButton(0, kButtonBack, false);
  SetButton(0, kButtonStart, false);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG | B_FLAG);

  // The button that chose an entry of the Stream Menu stays away from the game, also as what it is mapped to
  harness::ResetWithMapping(false, false, Targets({ { kButtonA, kButtonX } }) + ";;*");
  Connect(0);
  Poll();
  setStreamMenuOpen(true);
  Poll();
  SetButton(0, kButtonA, true);
  Poll();
  setStreamMenuOpen(false);
  PollFor(50);
  CHECK_EQ(LastButtons(), 0);
  SetButton(0, kButtonA, false);
  Poll();
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(LastButtons(), X_FLAG);

  // A face button mapped to Start doesn't make a Stream Menu combo with Back
  harness::ResetWithMapping(false, false, Targets({ { kButtonA, kButtonStart } }) + ";;*");
  Connect(0);
  Poll();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonA, true);
  PollFor(static_cast<int>(kStreamMenuHoldMs) + 20);
  count = 0;
  for (const std::string& message : harness::postedToJs) {
    count += message == "streamMenuRequested";
  }
  CHECK_EQ(count, 0);

  // The stop combo on the physical LB, RB, Back and Start, mapped to other buttons
  harness::ResetWithMapping(false, false, Targets({ { kButtonLB, kButtonY }, { kButtonRB, kButtonX } }) + ";;*");
  Connect(0);
  Poll();
  for (int button : { kButtonLB, kButtonRB, kButtonBack, kButtonStart }) {
    SetButton(0, button, true);
  }
  Poll();
  CHECK_EQ(harness::stopStreamCalls, 1);

  // Buttons mapped to LB, RB, Back and Start don't stop it
  harness::ResetWithMapping(false, false, Targets({ { kButtonA, kButtonLB }, { kButtonB, kButtonRB }, { kButtonX, kButtonBack }, { kButtonY, kButtonStart } }) + ";;*");
  Connect(0);
  Poll();
  for (int button : { kButtonA, kButtonB, kButtonX, kButtonY }) {
    SetButton(0, button, true);
  }
  PollFor(50);
  CHECK_EQ(harness::stopStreamCalls, 0);
}

int main() {
  harness::Install();
  test_support::RunTest("the text of the button mapping: one line per controller, malformed ones left out", TestParse);
  test_support::RunTest("the text of the fixture that the front end writes", TestFixture);
  test_support::RunTest("a controller gets its own mapping, else the one for every controller", TestFind);
  test_support::RunTest("the buttons and triggers as the game gets them", TestMapButtons);
  test_support::RunTest("a calibrated axis: the centre is 0 and the ends it reached are -1 and 1", TestCalibrateAxis);
  test_support::RunTest("stream: the host gets the mapped buttons, the Guide button and button 17 as they are", TestStreamButtons);
  test_support::RunTest("stream: the arrival announces the mapped buttons", TestArrivalButtons);
  test_support::RunTest("stream: triggers mapped to buttons and buttons to triggers", TestTriggers);
  test_support::RunTest("stream: the calibrated sticks of a controller", TestCalibratedSticks);
  test_support::RunTest("stream: the Stream Menu and stop combos on the physical buttons, before the mapping", TestCombosOnPhysicalButtons);
  return test_support::Summary();
}
