// Pins the controller side of the Stream Menu in wasm/gamepad.cpp: the combo that opens it (Back + Start held together
// and alone for 1 second), which the game must not see, the replay of the Back and Start presses that turn out not to be
// the combo, a Back or Start pressed with another button (passed on at once, together with that button), the other
// combos next to it, and the input while the menu is open and after it closed (setStreamMenuOpen()): the host gets the
// controllers released, and the buttons that chose an entry don't reach the game. The mouse emulation entry of the menu
// (toggleMouseEmulation()) works without the setting that allows the hold of Start. While Moonlight is hidden during the
// stream (setStreamPageHidden(), since 2.3.5), the host gets the same as while the menu is open, and the controllers
// aren't read, so that a hidden page that reports none doesn't unplug them on the PC.

#include "gamepad_harness.h"
#include "test_support.h"

using harness::Connect;
using harness::Poll;
using harness::PollFor;
using harness::SetButton;
using harness::padPackets;

// Standard button indices used below
static constexpr int kButtonA = 0;
static constexpr int kButtonB = 1;
static constexpr int kButtonX = 2;
static constexpr int kButtonLB = 4;
static constexpr int kButtonRB = 5;
static constexpr int kButtonRT = 7;
static constexpr int kButtonBack = 8;
static constexpr int kButtonStart = 9;
static constexpr int kButtonUp = 12;

// Count the messages to the UI that are exactly this text
static int CountPosted(const std::string& text) {
  int count = 0;
  for (const std::string& message : harness::postedToJs) {
    count += message == text;
  }
  return count;
}

// Check if a packet sent from the given index on holds any of these button flags
static bool AnyPacketHas(size_t from, int flags) {
  for (size_t i = from; i < padPackets.size(); ++i) {
    if (padPackets[i].buttons & flags) {
      return true;
    }
  }
  return false;
}

// The buttons of the last packet, or -1 without one
static int LastButtons() {
  return padPackets.empty() ? -1 : padPackets.back().buttons;
}

// Start a stream with one Xbox controller that is announced and has sent its first state
static void StartWithController(bool mouseEmulation = false, bool flipAB = false, bool flipXY = false) {
  harness::Reset(false, mouseEmulation, flipAB, flipXY);
  Connect(0);
  Poll();
}

// Poll every 5 ms until the time of the simulated clock, counted from the given start
static void PollUntil(uint64_t startMs, uint64_t elapsedMs) {
  while (harness::nowMs < startMs + elapsedMs) {
    Poll(5);
  }
}

static void TestComboOpensMenuOnce() {
  // Back and Start pressed together and held: the menu opens after 1 second, once, and the game never sees either
  StartWithController();
  const size_t before = padPackets.size();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  Poll();
  const uint64_t pressMs = harness::nowMs;
  PollUntil(pressMs, kStreamMenuHoldMs - 5);
  CHECK_EQ(CountPosted("streamMenuRequested"), 0);
  Poll();
  CHECK_EQ(CountPosted("streamMenuRequested"), 1);
  PollFor(2000);
  CHECK_EQ(CountPosted("streamMenuRequested"), 1);
  CHECK(!AnyPacketHas(before, BACK_FLAG | PLAY_FLAG));

  // Released in any order, without anything reaching the game afterwards either
  SetButton(0, kButtonBack, false);
  PollFor(300);
  SetButton(0, kButtonStart, false);
  PollFor(300);
  CHECK(!AnyPacketHas(before, BACK_FLAG | PLAY_FLAG));

  // The next hold opens it again
  SetButton(0, kButtonStart, true);
  SetButton(0, kButtonBack, true);
  PollFor(static_cast<int>(kStreamMenuHoldMs) + 10);
  CHECK_EQ(CountPosted("streamMenuRequested"), 2);
  CHECK(!AnyPacketHas(before, BACK_FLAG | PLAY_FLAG));

  // Pressed 60 ms apart, which counts as together: the game doesn't see the first one either
  StartWithController();
  const size_t apart = padPackets.size();
  SetButton(0, kButtonStart, true);
  PollFor(60);
  SetButton(0, kButtonBack, true);
  PollFor(static_cast<int>(kStreamMenuHoldMs) + 10);
  CHECK_EQ(CountPosted("streamMenuRequested"), 1);
  CHECK(!AnyPacketHas(apart, BACK_FLAG | PLAY_FLAG));

  // The face button swaps don't change the combo
  StartWithController(false, true, true);
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  PollFor(static_cast<int>(kStreamMenuHoldMs) + 10);
  CHECK_EQ(CountPosted("streamMenuRequested"), 1);
}

static void TestSinglePressesReachTheGame() {
  // Back held alone reaches the game after the window of the combo, and is released with the button
  StartWithController();
  SetButton(0, kButtonBack, true);
  Poll();
  const uint64_t pressMs = harness::nowMs;
  PollUntil(pressMs, kComboChordWindowMs - 5);
  CHECK_EQ(LastButtons(), 0);
  Poll();
  CHECK_EQ(LastButtons(), BACK_FLAG);
  PollFor(500);
  CHECK_EQ(LastButtons(), BACK_FLAG);
  SetButton(0, kButtonBack, false);
  Poll();
  CHECK_EQ(LastButtons(), 0);
  CHECK(harness::postedToJs.empty());

  // A tap of Start shorter than the window reaches the game right after it, for as long as it was held (40 ms)
  StartWithController();
  SetButton(0, kButtonStart, true);
  Poll();
  const uint64_t tapMs = harness::nowMs;
  PollFor(35);
  SetButton(0, kButtonStart, false);
  Poll();
  CHECK_EQ(LastButtons(), PLAY_FLAG);
  const uint64_t replayMs = harness::nowMs;
  CHECK_EQ(replayMs - tapMs, 40u);
  PollUntil(replayMs, 35);
  CHECK_EQ(LastButtons(), PLAY_FLAG);
  Poll();
  CHECK_EQ(LastButtons(), 0);
  CHECK(harness::postedToJs.empty());

  // The other buttons reach the game on the next poll as before
  StartWithController();
  SetButton(0, kButtonA, true);
  SetButton(0, kButtonUp, true);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG | UP_FLAG);
}

static void TestShortChordIsReplayed() {
  // Back + Start released before the menu opened (e.g. the Select + Start hotkey of RetroArch, 300 ms) reaches the game
  // together afterwards, for the time it was held
  StartWithController();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  Poll();
  const uint64_t pressMs = harness::nowMs;
  PollFor(295);
  CHECK_EQ(LastButtons(), 0);
  SetButton(0, kButtonBack, false);
  SetButton(0, kButtonStart, false);
  Poll();
  CHECK_EQ(LastButtons(), BACK_FLAG | PLAY_FLAG);
  PollUntil(pressMs, 595);
  CHECK_EQ(LastButtons(), BACK_FLAG | PLAY_FLAG);
  Poll();
  CHECK_EQ(LastButtons(), 0);
  CHECK(harness::postedToJs.empty());

  // One of them released early: it is replayed, and the other one, still held, reaches the game at once
  StartWithController();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  PollFor(400);
  SetButton(0, kButtonStart, false);
  Poll();
  CHECK_EQ(LastButtons(), BACK_FLAG | PLAY_FLAG);
  PollFor(500);
  CHECK_EQ(LastButtons(), BACK_FLAG);
  CHECK(harness::postedToJs.empty());
}

static void TestBackWithAnotherButton() {
  // Select as the modifier of a hotkey (e.g. Select + R1 to save a state in RetroArch), with R1 30 ms later: the game
  // gets Select together with R1 at once, not R1 first and Select after the window of the combo
  StartWithController();
  SetButton(0, kButtonBack, true);
  Poll();
  CHECK_EQ(LastButtons(), 0);
  PollFor(25);
  SetButton(0, kButtonRB, true);
  Poll();
  CHECK_EQ(LastButtons(), BACK_FLAG | RB_FLAG);
  // A quick tap of R1 (60 ms) overlaps with Select in the game, which still gets Select afterwards while it is held
  PollFor(55);
  SetButton(0, kButtonRB, false);
  Poll();
  CHECK_EQ(LastButtons(), BACK_FLAG);
  SetButton(0, kButtonBack, false);
  Poll();
  CHECK_EQ(LastButtons(), 0);
  CHECK(harness::postedToJs.empty());

  // Select and X pressed on the same poll reach the game together
  StartWithController();
  const size_t together = padPackets.size();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonX, true);
  Poll();
  CHECK_EQ(padPackets.size(), together + 1);
  CHECK_EQ(LastButtons(), BACK_FLAG | X_FLAG);

  // A button that was held first: Start pressed with it reaches the game on the same poll as well
  StartWithController();
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG);
  SetButton(0, kButtonStart, true);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG | PLAY_FLAG);

  // A tap of Select and R1 together, shorter than the window: both reach the game at once and overlap
  StartWithController();
  const size_t tap = padPackets.size();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonRB, true);
  PollFor(40);
  SetButton(0, kButtonBack, false);
  SetButton(0, kButtonRB, false);
  PollFor(100);
  CHECK(padPackets.size() > tap && padPackets[tap].buttons == (BACK_FLAG | RB_FLAG));
  for (size_t i = tap; i < padPackets.size(); ++i) {
    CHECK(padPackets[i].buttons == (BACK_FLAG | RB_FLAG) || padPackets[i].buttons == 0);
  }
  CHECK_EQ(LastButtons(), 0);
  CHECK(harness::postedToJs.empty());
}

static void TestOtherCombosAndButtons() {
  // Back + Start with another button is no Stream Menu combo: both reach the game at once with that button
  StartWithController();
  SetButton(0, kButtonA, true);
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG | BACK_FLAG | PLAY_FLAG);
  PollFor(1500);
  CHECK_EQ(LastButtons(), A_FLAG | BACK_FLAG | PLAY_FLAG);
  CHECK(harness::postedToJs.empty());

  // The stop combo still ends the stream, also when Back + Start came first, as long as LB + RB join within the second
  StartWithController();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  PollFor(600);
  SetButton(0, kButtonLB, true);
  SetButton(0, kButtonRB, true);
  Poll();
  CHECK_EQ(harness::stopStreamCalls, 1);
  CHECK(harness::postedToJs.empty());

  // The statistics combo still toggles once, and Back reaches the game after the window
  StartWithController();
  for (int button : { kButtonBack, kButtonLB, kButtonRB, kButtonX }) {
    SetButton(0, button, true);
  }
  PollFor(static_cast<int>(kComboChordWindowMs) + 50);
  CHECK_EQ(harness::toggleStatsCalls, 1);
  CHECK(LastButtons() & BACK_FLAG);

  // A late Back while Start is held already (Start reached the game) still opens the menu after a second, and the game
  // gets Start released then and Back never
  StartWithController();
  SetButton(0, kButtonStart, true);
  PollFor(300);
  CHECK_EQ(LastButtons(), PLAY_FLAG);
  const size_t late = padPackets.size();
  SetButton(0, kButtonBack, true);
  Poll();
  const uint64_t chordMs = harness::nowMs;
  PollUntil(chordMs, kStreamMenuHoldMs - 5);
  CHECK_EQ(CountPosted("streamMenuRequested"), 0);
  CHECK_EQ(LastButtons(), PLAY_FLAG);
  Poll();
  CHECK_EQ(CountPosted("streamMenuRequested"), 1);
  CHECK_EQ(LastButtons(), 0);
  CHECK(!AnyPacketHas(late, BACK_FLAG));

  // The hold of Start for the mouse emulation never counts a Back + Start hold, and the combo never toggles it
  StartWithController(true);
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  PollFor(2000);
  CHECK(!mouseEmulationActive);
  CHECK_EQ(CountPosted("streamMenuRequested"), 1);
  CHECK_EQ(CountPosted("mouseEmulationOn"), 0);
}

static void TestInputWhileMenuOpen() {
  // Walking with the left stick and holding RT when the menu opens: the game gets the controller released once
  StartWithController();
  harness::slots[0].axis[0] = 0.9;
  harness::slots[0].analogButton[7] = 1.0;
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG);
  setStreamMenuOpen(true);
  Poll();
  const harness::PadPacket* neutral = padPackets.empty() ? nullptr : &padPackets.back();
  CHECK(neutral && neutral->buttons == 0 && neutral->leftStickX == 0 && neutral->rightTrigger == 0);
  const size_t opened = padPackets.size();

  // The buttons that move through the menu, and every combo, don't reach the host while it is open
  SetButton(0, kButtonA, false);
  Poll();
  for (int button : { kButtonUp, kButtonA, kButtonB, kButtonBack, kButtonStart }) {
    SetButton(0, button, true);
    PollFor(50);
    SetButton(0, button, false);
    PollFor(50);
  }
  for (int button : { kButtonLB, kButtonRB, kButtonBack, kButtonStart }) {
    SetButton(0, button, true);
  }
  PollFor(1500);
  for (int button : { kButtonLB, kButtonRB, kButtonBack, kButtonStart }) {
    SetButton(0, button, false);
  }
  PollFor(500);
  CHECK_EQ(padPackets.size(), opened);
  CHECK_EQ(harness::stopStreamCalls, 0);
  CHECK(harness::postedToJs.empty());

  // A controller that connects while the menu is open is announced at the next read of the slots and gets a released
  // state too
  Connect(1);
  Poll(kIdleSlotReadIntervalMs);
  CHECK_EQ(harness::arrivals.size(), 2u);
  CHECK(!padPackets.empty() && padPackets.back().controller == 1 && padPackets.back().buttons == 0);
}

static void TestButtonsHeldWhenMenuCloses() {
  // A chose Resume and is still held when the menu closes: the game doesn't get it until it is released and pressed
  // again, while the stick reaches the game at once
  StartWithController();
  setStreamMenuOpen(true);
  Poll();
  SetButton(0, kButtonA, true);
  harness::slots[0].axis[1] = -1.0;
  Poll();
  setStreamMenuOpen(false);
  PollFor(200);
  CHECK(!padPackets.empty() && padPackets.back().buttons == 0 && padPackets.back().leftStickY == 32767);
  SetButton(0, kButtonA, false);
  Poll();
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG);

  // Back + Start of the combo, still held when the menu closes, neither reach the game nor start a new combo or a
  // hold of Start for the mouse emulation, also once they are released
  StartWithController(true);
  const size_t before = padPackets.size();
  SetButton(0, kButtonBack, true);
  SetButton(0, kButtonStart, true);
  PollFor(static_cast<int>(kStreamMenuHoldMs) + 10);
  CHECK_EQ(CountPosted("streamMenuRequested"), 1);
  setStreamMenuOpen(true);
  PollFor(100);
  setStreamMenuOpen(false);
  PollFor(2500);
  SetButton(0, kButtonBack, false);
  SetButton(0, kButtonStart, false);
  PollFor(500);
  CHECK(!AnyPacketHas(before, BACK_FLAG | PLAY_FLAG));
  CHECK_EQ(CountPosted("streamMenuRequested"), 1);
  CHECK(!mouseEmulationActive);

  // A press of Start that was still withheld when the menu opened (by the remote) is dropped, not replayed afterwards
  StartWithController();
  const size_t pending = padPackets.size();
  SetButton(0, kButtonStart, true);
  PollFor(50);
  setStreamMenuOpen(true);
  Poll();
  SetButton(0, kButtonStart, false);
  PollFor(100);
  setStreamMenuOpen(false);
  PollFor(300);
  CHECK(!AnyPacketHas(pending, PLAY_FLAG));
}

static void TestInputWhileHidden() {
  // A held, the left stick and RT pressed when Moonlight is hidden (Home): the host gets them released once, and nothing
  // else for as long as it stays hidden, also no refresh
  StartWithController();
  SetButton(0, kButtonA, true);
  harness::slots[0].axis[0] = 0.8;
  harness::slots[0].analogButton[kButtonRT] = 1.0;
  Poll();
  CHECK(!padPackets.empty() && padPackets.back().buttons == A_FLAG && padPackets.back().rightTrigger == 255);
  setStreamPageHidden(true);
  const size_t before = padPackets.size();
  PollFor(60000);
  CHECK_EQ(padPackets.size(), before + 1);
  const harness::PadPacket* neutral = padPackets.empty() ? nullptr : &padPackets.back();
  CHECK(neutral && neutral->buttons == 0 && neutral->leftStickX == 0 && neutral->rightTrigger == 0);
  const size_t hidden = padPackets.size();

  // What the browser reports meanwhile (the last state, or the presses in Smart Hub) runs no combo: the stop combo held
  // for 2 seconds doesn't end the stream, and Back + Start held for 1.5 seconds doesn't open the Stream Menu
  SetButton(0, kButtonA, false);
  for (int button : { kButtonLB, kButtonRB, kButtonBack, kButtonStart }) {
    SetButton(0, button, true);
  }
  PollFor(2000);
  CHECK_EQ(harness::stopStreamCalls, 0);
  SetButton(0, kButtonLB, false);
  SetButton(0, kButtonRB, false);
  PollFor(1500);
  SetButton(0, kButtonBack, false);
  SetButton(0, kButtonStart, false);
  PollFor(500);
  CHECK_EQ(CountPosted("streamMenuRequested"), 0);
  CHECK_EQ(padPackets.size(), hidden);

  // The Stream Menu opened and closed while still hidden changes nothing
  setStreamMenuOpen(true);
  PollFor(100);
  setStreamMenuOpen(false);
  PollFor(100);
  CHECK_EQ(padPackets.size(), hidden);

  // Shown again with A, the stick and RT held: the stick and RT reach the game at once, A once released and pressed again
  SetButton(0, kButtonA, true);
  PollFor(100);
  setStreamPageHidden(false);
  Poll();
  CHECK(padPackets.size() == hidden + 1 && padPackets.back().buttons == 0 &&
        padPackets.back().leftStickX == static_cast<short>(0.8 * 32767) && padPackets.back().rightTrigger == 255);
  SetButton(0, kButtonA, false);
  Poll();
  SetButton(0, kButtonA, true);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG);

  // A new stream starts shown, whatever the stream before was left with
  setStreamPageHidden(true);
  Poll();
  CHECK_EQ(LastButtons(), 0);
  harness::Instance()->HandleGamepadInputState(false, false, harness::FaceButtonSwapMapping(false, false), LI_CTYPE_UNKNOWN);
  Poll();
  CHECK_EQ(LastButtons(), A_FLAG);

  // In mouse mode: the held mouse button is released once, and the pointer doesn't move while hidden
  StartWithController(true);
  toggleMouseEmulation();
  Poll();
  SetButton(0, kButtonA, true);
  Poll();
  CHECK(!harness::mouseButtons.empty() && harness::mouseButtons.back().action == BUTTON_ACTION_PRESS);
  harness::mouseButtons.clear();
  harness::mouseMoves.clear();
  setStreamPageHidden(true);
  harness::slots[0].axis[0] = 1.0;
  PollFor(1000);
  CHECK(harness::mouseButtons.size() == 1 && harness::mouseButtons[0].action == BUTTON_ACTION_RELEASE);
  CHECK(harness::mouseMoves.empty());
  CHECK(harness::scrolls.empty());
  setStreamPageHidden(false);
  Poll();
  CHECK(mouseEmulationActive);
  CHECK(harness::mouseMoves.size() == 1 && harness::mouseMoves[0] == std::make_pair(10, 0));
}

// Whether a packet since the given one tells the host that no controller is there any more (a removal of the last one)
static bool AnyRemovalSince(size_t from) {
  for (size_t i = from; i < padPackets.size(); ++i) {
    if (padPackets[i].activeMask == 0) {
      return true;
    }
  }
  return false;
}

static void TestControllersStayOnThePcWhileHidden() {
  // The browser of a hidden page may report no controller at all: the PC keeps it, released, instead of a removal, and
  // when the page shows again with the controller there, it isn't announced a second time
  StartWithController();
  CHECK_EQ(harness::arrivals.size(), 1u);
  SetButton(0, kButtonA, true);
  Poll();
  setStreamPageHidden(true);
  Poll();
  const size_t released = padPackets.size();
  CHECK(!padPackets.empty() && padPackets.back().buttons == 0 && padPackets.back().activeMask == 1);
  harness::Disconnect(0);
  PollFor(5000);
  CHECK_EQ(padPackets.size(), released);
  Connect(0);
  SetButton(0, kButtonA, true);
  setStreamPageHidden(false);
  PollFor(200);
  CHECK(!AnyRemovalSince(released));
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK(!padPackets.empty() && padPackets.back().activeMask == 1 && padPackets.back().buttons == 0);

  // A controller switched off while Moonlight is hidden is removed once the page shows again, and one switched on
  // meanwhile is announced then
  setStreamPageHidden(true);
  Poll();
  harness::Disconnect(0);
  Connect(1);
  PollFor(1000);
  const size_t hidden = padPackets.size();
  CHECK_EQ(harness::arrivals.size(), 1u);
  setStreamPageHidden(false);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);
  CHECK(!harness::arrivals.empty() && harness::arrivals.back().controller == 1);
  CHECK(padPackets.size() > hidden && padPackets[hidden].controller == 0 && padPackets[hidden].activeMask == 2);
}

static void TestMouseModeAndMenu() {
  // The mouse emulation entry turns it on without the setting, which only allows the hold of Start, and off again
  StartWithController(false);
  toggleMouseEmulation();
  Poll();
  CHECK(mouseEmulationActive);
  CHECK_EQ(CountPosted("mouseEmulationOn"), 1);
  PollFor(500);
  CHECK(mouseEmulationActive);
  toggleMouseEmulation();
  Poll();
  CHECK(!mouseEmulationActive);
  CHECK_EQ(CountPosted("mouseEmulationOff"), 1);

  // In mouse mode, the menu releases the held mouse button and stops moving the pointer; it stays in mouse mode after
  StartWithController(true);
  toggleMouseEmulation();
  Poll();
  SetButton(0, kButtonA, true);
  Poll();
  CHECK(!harness::mouseButtons.empty() && harness::mouseButtons.back().action == BUTTON_ACTION_PRESS);
  harness::mouseButtons.clear();
  harness::mouseMoves.clear();
  setStreamMenuOpen(true);
  harness::slots[0].axis[0] = 1.0;
  PollFor(100);
  CHECK(harness::mouseButtons.size() == 1 && harness::mouseButtons[0].action == BUTTON_ACTION_RELEASE);
  CHECK(harness::mouseMoves.empty());
  SetButton(0, kButtonA, false);
  harness::slots[0].axis[0] = 0.0;
  setStreamMenuOpen(false);
  PollFor(100);
  CHECK(mouseEmulationActive);
  harness::slots[0].axis[0] = 1.0;
  Poll();
  CHECK_EQ(harness::mouseMoves.size(), 1u);

  // A new stream starts with the menu closed and nothing requested
  setStreamMenuOpen(true);
  toggleMouseEmulation();
  harness::Instance()->HandleGamepadInputState(false, false, harness::FaceButtonSwapMapping(false, false), LI_CTYPE_UNKNOWN);
  harness::postedToJs.clear();
  SetButton(0, kButtonA, true);
  harness::slots[0].axis[0] = 0.0;
  Poll();
  CHECK(!mouseEmulationActive);
  CHECK(harness::postedToJs.empty());
  CHECK_EQ(LastButtons(), A_FLAG);
}

int main() {
  harness::Install();
  test_support::RunTest("Back + Start held for a second opens the Stream Menu once, unseen by the game", TestComboOpensMenuOnce);
  test_support::RunTest("a single Back or Start reaches the game after the combo window, a tap is replayed", TestSinglePressesReachTheGame);
  test_support::RunTest("a Back + Start released before the menu opened reaches the game afterwards", TestShortChordIsReplayed);
  test_support::RunTest("Back or Start with another button reaches the game at once, together with it", TestBackWithAnotherButton);
  test_support::RunTest("the stop and statistics combos, a late Back and the hold of Start next to the combo", TestOtherCombosAndButtons);
  test_support::RunTest("while the Stream Menu is open the host gets the controllers released and nothing else", TestInputWhileMenuOpen);
  test_support::RunTest("buttons held when the Stream Menu closes reach the game only when pressed again", TestButtonsHeldWhenMenuCloses);
  test_support::RunTest("the mouse emulation entry and the Stream Menu in mouse mode", TestMouseModeAndMenu);
  test_support::RunTest("while Moonlight is hidden the host gets the controllers released once and nothing else, and "
                        "buttons held when it shows again need a new press", TestInputWhileHidden);
  test_support::RunTest("while Moonlight is hidden the controllers aren't read, so the PC keeps them; the read on the "
                        "way back sees which are there", TestControllersStayOnThePcWhileHidden);
  return test_support::Summary();
}
