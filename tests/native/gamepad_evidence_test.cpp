// Pins when PollGamepads() (wasm/gamepad.cpp) takes a slot that the browser reports as connected for a controller: with
// a positive timestamp, or once its input changed since the slot appeared, since Tizen 5.5 reports a timestamp of 0 for
// real controllers too, while the placeholder slots of Tizen report 0 and never change (upstream fdf4fbe, PR #192 by
// podrezov). The frames of tests/fixtures/gamepad-evidence.tsv are checked here and against Controller.isRealGamepad()
// of wasm/platform/gamepad.js (tests/unit/gamepad-js.test.js), so the menus count the controllers that the stream
// announces. The other tests check that the input which made a controller count reaches the host on the same poll,
// that the button combos work with it, and that the evidence stays for the next stream.

#include "gamepad_harness.h"
#include "test_support.h"

#include <cmath>
#include <fstream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

using harness::Connect;
using harness::Disconnect;
using harness::Poll;
using harness::PollFor;
using harness::SetButton;
using harness::padPackets;

static const char* kTimestampLog = "reports a timestamp of 0 and counts as a controller since its input changed";

// Standard button indices used below
static constexpr int kButtonA = 0;
static constexpr int kButtonLB = 4;
static constexpr int kButtonRB = 5;
static constexpr int kButtonBack = 8;
static constexpr int kButtonStart = 9;

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

// Plug in a controller at a slot that reports a timestamp of 0, as on Tizen 5.5 or as a placeholder
static void ConnectWithoutTimestamp(int index, const char* id = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)") {
  Connect(index, id);
  harness::slots[index].timestamp = 0.0;
}

// ===== The frames of tests/fixtures/gamepad-evidence.tsv =====

struct EvidenceCase {
  std::string name;
  std::string expected; // '1' or '0' per frame
  std::vector<std::string> frames;
};

static std::vector<EvidenceCase> ReadEvidenceCases() {
  std::string path = __FILE__;
  path = path.substr(0, path.find_last_of('/') + 1) + "../fixtures/gamepad-evidence.tsv";
  std::ifstream file(path);
  std::vector<EvidenceCase> cases;
  std::string line;
  while (std::getline(file, line)) {
    if (line.empty() || line[0] == '#') {
      continue;
    }
    std::istringstream fields(line);
    EvidenceCase entry;
    std::string frames;
    if (!std::getline(fields, entry.name, '\t') || !std::getline(fields, entry.expected, '\t') || !std::getline(fields, frames)) {
      continue;
    }
    std::istringstream frameList(frames);
    std::string frame;
    while (frameList >> frame) {
      entry.frames.push_back(frame);
    }
    cases.push_back(entry);
  }
  return cases;
}

static std::vector<std::string> Split(const std::string& text, char separator) {
  std::vector<std::string> parts;
  std::string part;
  std::istringstream stream(text);
  while (std::getline(stream, part, separator)) {
    parts.push_back(part);
  }
  if (!text.empty() && text.back() == separator) {
    parts.push_back("");
  }
  return parts;
}

static double ParseValue(const std::string& text) {
  return text == "nan" ? std::numeric_limits<double>::quiet_NaN() : std::stod(text);
}

// Fill slot 0 with a frame of the fixture: timestamp/buttons/axes[/id], or - for an empty slot
static bool SetFrame(const std::string& frame) {
  if (frame == "-") {
    Disconnect(0);
    return true;
  }
  const std::vector<std::string> parts = Split(frame, '/');
  if (parts.size() < 3 || parts.size() > 4) {
    return false;
  }
  const std::string id = parts.size() == 4 ? parts[3] : "Pad";
  Connect(0, id.c_str(), "standard", 0, 0);
  EmscriptenGamepadEvent& event = harness::slots[0];
  event.timestamp = ParseValue(parts[0]);
  const std::vector<std::string> buttons = parts[1].empty() ? std::vector<std::string>() : Split(parts[1], ',');
  const std::vector<std::string> axes = parts[2].empty() ? std::vector<std::string>() : Split(parts[2], ',');
  event.numButtons = static_cast<int>(buttons.size());
  event.numAxes = static_cast<int>(axes.size());
  for (size_t i = 0; i < buttons.size(); ++i) {
    const bool pressed = !buttons[i].empty() && buttons[i].back() == '*';
    event.digitalButton[i] = pressed ? EM_TRUE : EM_FALSE;
    event.analogButton[i] = ParseValue(pressed ? buttons[i].substr(0, buttons[i].size() - 1) : buttons[i]);
  }
  for (size_t i = 0; i < axes.size(); ++i) {
    event.axis[i] = ParseValue(axes[i]);
  }
  return true;
}

static void TestFixtureFrames() {
  const std::vector<EvidenceCase> cases = ReadEvidenceCases();
  CHECK(cases.size() >= 15u);
  for (const EvidenceCase& entry : cases) {
    test_support::Check(entry.expected.size() == entry.frames.size(), "frames of \"" + entry.name + "\"", "", __FILE__, __LINE__);
    harness::Reset();
    std::string actual;
    for (const std::string& frame : entry.frames) {
      test_support::Check(SetFrame(frame), "frame " + frame + " of \"" + entry.name + "\"", "", __FILE__, __LINE__);
      Poll();
      // The slot counts once the host got its arrival
      actual += slotState[0].announced ? '1' : '0';
    }
    test_support::Check(actual == entry.expected, "\"" + entry.name + "\"", "actual " + actual + ", expected " + entry.expected,
                        __FILE__, __LINE__);
  }
}

// ===== The input that made a controller count, and what follows =====

// The first press of a controller with a timestamp of 0 announces it, and the packet of the same poll carries the press
static void TestFirstPressReachesTheHost() {
  harness::Reset();
  ConnectWithoutTimestamp(0);
  PollFor(200);
  CHECK_EQ(harness::arrivals.size(), 0u);
  CHECK_EQ(padPackets.size(), 0u);

  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK(!harness::arrivals.empty() && harness::arrivals[0].controller == 0 && harness::arrivals[0].type == LI_CTYPE_XBOX);
  CHECK_EQ(padPackets.size(), 1u);
  CHECK(!padPackets.empty() && padPackets[0].activeMask == 1 && (padPackets[0].buttons & A_FLAG));
  // The log says why it counts, before the arrival line, once
  CHECK_EQ(CountLogs(std::string("Controller 0 ") + kTimestampLog), 1);
  CHECK(harness::logMessages.size() >= 2 && harness::logMessages[0].find(kTimestampLog) != std::string::npos &&
        harness::logMessages[1].find("Controller 0 announced") != std::string::npos);

  // From now on its input is sent like that of any controller, and it isn't logged again
  SetButton(0, kButtonA, false);
  Poll();
  CHECK(padPackets.size() == 2 && padPackets[1].buttons == 0);
  PollFor(200);
  CHECK_EQ(CountLogs(kTimestampLog), 1);
  CHECK_EQ(harness::arrivals.size(), 1u);

  // A controller with a positive timestamp next to it is announced at once, without that log line
  Connect(1, "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)");
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);
  CHECK_EQ(CountLogs(kTimestampLog), 1);
}

// A stick move of more than 0.01 counts and is sent on the same poll; a jitter of 0.009 around a resting value of 0.3
// never counts, however long it goes on, while one of 0.011 does
static void TestStickMoveAndJitter() {
  harness::Reset();
  ConnectWithoutTimestamp(0);
  harness::slots[0].axis[0] = 0.3;
  Poll();
  for (int i = 0; i < 1000; ++i) {
    harness::slots[0].axis[0] = (i % 2) ? 0.309 : 0.291;
    Poll();
  }
  CHECK_EQ(harness::arrivals.size(), 0u);
  CHECK_EQ(padPackets.size(), 0u);
  harness::slots[0].axis[0] = 0.289;
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK(padPackets.size() == 1 && padPackets[0].leftStickX == static_cast<short>(0.289 * 32767));

  // A move of the right stick from its first value counts the same way
  harness::Reset();
  ConnectWithoutTimestamp(0);
  Poll();
  harness::slots[0].axis[3] = -0.5;
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK(padPackets.size() == 1 && padPackets[0].rightStickY == static_cast<short>(0.5 * 32767));
}

// A button held since the slot appeared is no evidence, since a placeholder can report one: the controller counts on
// the release, and the host gets the release
static void TestHeldButtonCountsOnRelease() {
  harness::Reset();
  ConnectWithoutTimestamp(0);
  SetButton(0, kButtonA, true);
  PollFor(100);
  CHECK_EQ(harness::arrivals.size(), 0u);
  SetButton(0, kButtonA, false);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK(padPackets.size() == 1 && padPackets[0].buttons == 0);
}

// A value that isn't a number at first takes the first number as its baseline, so it doesn't count by turning into one
static void TestValueThatIsNotANumber() {
  harness::Reset();
  ConnectWithoutTimestamp(0);
  harness::slots[0].analogButton[6] = std::numeric_limits<double>::quiet_NaN();
  PollFor(50);
  harness::slots[0].analogButton[6] = 0.4;
  PollFor(50);
  CHECK_EQ(harness::arrivals.size(), 0u);
  CHECK(slotState[0].hasBaseline && slotState[0].baseline.analogButton[6] == 0.4);
  harness::slots[0].analogButton[6] = 0.6;
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK(padPackets.size() == 1 && padPackets[0].leftTrigger == static_cast<unsigned char>(0.6 * 255));
}

// The stop combo as the first input of a controller with a timestamp of 0 ends the stream, like the stats combo toggles
// the statistics
static void TestCombosAsFirstInput() {
  harness::Reset();
  ConnectWithoutTimestamp(0);
  Poll();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  SetButton(0, kButtonLB, true);
  SetButton(0, kButtonRB, true);
  Poll();
  CHECK_EQ(harness::stopStreamCalls, 1);
  CHECK_EQ(harness::arrivals.size(), 1u);

  harness::Reset();
  ConnectWithoutTimestamp(0);
  Poll();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonLB, true);
  SetButton(0, kButtonRB, true);
  SetButton(0, 2, true); // X
  Poll();
  CHECK_EQ(harness::toggleStatsCalls, 1);
}

// A disconnect and another controller in the slot (another id) need new evidence, and the host loses the controller
static void TestDisconnectAndReplacement() {
  harness::Reset();
  ConnectWithoutTimestamp(0);
  Poll();
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);

  // Unplugged: the host gets a zeroed state without the controller, and it comes back without evidence
  Disconnect(0);
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().activeMask == 0 && padPackets.back().buttons == 0);
  CHECK(!slotState[0].validated && !slotState[0].hasBaseline);
  ConnectWithoutTimestamp(0);
  PollFor(100);
  CHECK_EQ(harness::arrivals.size(), 1u);
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);

  // Another controller with the same layout and a held button: removed, then not counted, with its baseline taken at
  // its first sight, so its release on the next poll counts
  const size_t packetsBefore = padPackets.size();
  ConnectWithoutTimestamp(0, "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)");
  SetButton(0, kButtonA, true);
  Poll();
  CHECK(padPackets.size() == packetsBefore + 1 && padPackets.back().activeMask == 0);
  CHECK_EQ(harness::arrivals.size(), 2u);
  CHECK(slotState[0].hasBaseline && !slotState[0].validated && slotState[0].baseline.digitalButton[kButtonA] == EM_TRUE);
  SetButton(0, kButtonA, false);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 3u);
  CHECK(harness::arrivals.size() == 3 && harness::arrivals[2].type == LI_CTYPE_PS);
}

// The evidence stays for the next stream (HandleGamepadInputState() only clears the arrivals), so the controller is
// announced at once, before any input
static void TestNextStreamAnnouncesAtOnce() {
  harness::Reset();
  ConnectWithoutTimestamp(0);
  Poll();
  SetButton(0, kButtonA, true);
  Poll();
  SetButton(0, kButtonA, false);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);

  // What main.cpp does at the start of the next stream
  harness::Instance()->HandleGamepadInputState(false, false, "", LI_CTYPE_UNKNOWN);
  harness::arrivals.clear();
  padPackets.clear();
  harness::logMessages.clear();
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK_EQ(padPackets.size(), 1u);
  CHECK(slotState[0].validated);
  CHECK_EQ(CountLogs(kTimestampLog), 0);
}

int main() {
  harness::Install();
  test_support::RunTest("the frames of tests/fixtures/gamepad-evidence.tsv", TestFixtureFrames);
  test_support::RunTest("the first press of a controller with a timestamp of 0 announces it and reaches the host", TestFirstPressReachesTheHost);
  test_support::RunTest("a stick move counts, a jitter of 0.009 never does, one of 0.011 does", TestStickMoveAndJitter);
  test_support::RunTest("a button held since the slot appeared counts on its release", TestHeldButtonCountsOnRelease);
  test_support::RunTest("a value that is not a number takes the first number as its baseline", TestValueThatIsNotANumber);
  test_support::RunTest("the stop and stats combos work as the first input", TestCombosAsFirstInput);
  test_support::RunTest("a disconnect and another controller in the slot need new evidence", TestDisconnectAndReplacement);
  test_support::RunTest("the next stream announces a controller that counted at once", TestNextStreamAnnouncesAtOnce);
  return test_support::Summary();
}
