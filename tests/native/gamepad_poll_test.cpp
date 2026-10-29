// Pins how PollGamepads() (wasm/gamepad.cpp) reads the controllers during a stream and what it sends to the host:
// one batched main-thread call per poll (or the single Emscripten calls when its helper is missing), an arrival per
// controller, the controller state only when it changes plus a refresh every 100 ms, a retry after a dropped packet,
// and the controller mask when controllers come and go.

#include "gamepad_harness.h"
#include "test_support.h"

using harness::Connect;
using harness::Disconnect;
using harness::Poll;
using harness::padPackets;

// The whole life of two controllers in one stream, through the batched read or the fallback path
static void RunControllerLifecycle(bool fallback) {
  harness::Reset();
  harness::useFallbackPath = fallback;

  // An arrival sends the arrival event and the first state right away
  Connect(0);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK_EQ(padPackets.size(), 1u);
  CHECK(padPackets[0].controller == 0 && padPackets[0].activeMask == 1 && padPackets[0].buttons == 0);

  // An unchanged state is not sent again within the refresh interval
  for (int i = 0; i < 10; ++i) {
    Poll(5);
  }
  CHECK_EQ(padPackets.size(), 1u);

  // A stick or trigger movement is sent on the same poll, scaled to the protocol ranges (Y axes inverted)
  harness::slots[0].axis[0] = 0.5;
  harness::slots[0].axis[1] = -0.25;
  harness::slots[0].analogButton[6] = 0.5;
  Poll();
  CHECK_EQ(padPackets.size(), 2u);
  CHECK_EQ(padPackets[1].leftStickX, static_cast<short>(0.5 * 32767));
  CHECK_EQ(padPackets[1].leftStickY, static_cast<short>(0.25 * 32767));
  CHECK_EQ(static_cast<int>(padPackets[1].leftTrigger), static_cast<int>(static_cast<unsigned char>(0.5 * 255)));

  // A button press and its release are both sent
  harness::SetButton(0, 0, true);
  Poll();
  CHECK(padPackets.size() == 3 && (padPackets[2].buttons & A_FLAG));
  harness::SetButton(0, 0, false);
  Poll();
  CHECK(padPackets.size() == 4 && !(padPackets[3].buttons & A_FLAG));

  // An unchanged state is refreshed once the 100 ms interval has passed
  Poll(50);
  CHECK_EQ(padPackets.size(), 4u);
  Poll(50);
  CHECK_EQ(padPackets.size(), 5u);
  Poll(5);
  CHECK_EQ(padPackets.size(), 5u);

  // A packet dropped by a full input queue is sent again on the next poll
  harness::SetButton(0, 1, true);
  harness::failNextPackets = 1;
  Poll();
  CHECK_EQ(padPackets.size(), 5u);
  Poll();
  CHECK(padPackets.size() == 6 && (padPackets[5].buttons & B_FLAG));
  Poll();
  CHECK_EQ(padPackets.size(), 6u);

  // A second controller changes the mask, so both controllers send their state again
  Connect(1);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);
  CHECK_EQ(padPackets.size(), 8u);
  CHECK(padPackets[6].controller == 0 && padPackets[6].activeMask == 3);
  CHECK(padPackets[7].controller == 1 && padPackets[7].activeMask == 3);

  // A removal sends a zeroed state without the removed bit, and the other controller resends with the new mask
  Disconnect(1);
  Poll();
  CHECK_EQ(padPackets.size(), 10u);
  CHECK(padPackets[8].controller == 1 && padPackets[8].activeMask == 1 && padPackets[8].buttons == 0);
  CHECK(padPackets[9].controller == 0 && padPackets[9].activeMask == 1);

  // Reconnecting the same idle controller announces it again and sends its state after the arrival
  Connect(1);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 3u);
  CHECK_EQ(padPackets.size(), 12u);
  CHECK(padPackets[10].controller == 0 && padPackets[10].activeMask == 3);
  CHECK(padPackets[11].controller == 1 && padPackets[11].activeMask == 3);
  Poll();
  CHECK_EQ(padPackets.size(), 12u);
}

static void TestBatchedRead() {
  RunControllerLifecycle(false);
}

static void TestFallbackRead() {
  RunControllerLifecycle(true);
}

// Tizen reports placeholder slots with a zero timestamp, which must not be announced until they report input
static void TestPlaceholderSlots() {
  harness::Reset();
  Connect(0);
  harness::slots[0].timestamp = 0.0;
  Poll();
  CHECK_EQ(harness::arrivals.size(), 0u);
  CHECK_EQ(padPackets.size(), 0u);
  harness::slots[0].timestamp = 250.0;
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
  CHECK_EQ(padPackets.size(), 1u);
  // Once seen, the same controller stays real even if its timestamp reads zero again
  harness::slots[0].timestamp = 0.0;
  harness::SetButton(0, 3, true);
  Poll();
  CHECK(padPackets.size() == 2 && (padPackets[1].buttons & Y_FLAG));
}

// Another controller in the same slot (a different id) is removed and announced as a new one
static void TestReplacedController() {
  harness::Reset();
  Connect(0);
  Poll();
  Connect(0, "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)");
  Poll();
  CHECK_EQ(harness::arrivals.size(), 2u);
  CHECK_EQ(harness::arrivals[1].type, LI_CTYPE_PS);
  CHECK(padPackets.size() >= 2 && padPackets[1].activeMask == 0 && padPackets[1].buttons == 0);
}

// A browser that can't read the gamepads makes the poll send nothing
static void TestFailedRead() {
  harness::Reset();
  harness::numSlots = 0;
  Connect(0);
  Poll();
  CHECK_EQ(harness::arrivals.size(), 0u);
  CHECK_EQ(padPackets.size(), 0u);
}

// A read that throws on the main thread, every 5 ms for the whole stream, is logged only by the JavaScript code, which
// does so the first and every 1000th time: the poll must not log it again each time
static void TestThrowingReadIsNotLoggedEachPoll() {
  harness::Reset();
  Connect(0);
  harness::batchedReadResult = -3;
  harness::PollFor(5000);
  CHECK_EQ(harness::logMessages.size(), 0u);
  CHECK_EQ(harness::arrivals.size(), 0u);
  CHECK_EQ(padPackets.size(), 0u);

  // A read that fails without an exception (no Gamepad API) is still logged here
  harness::batchedReadResult = -1;
  Poll();
  CHECK_EQ(harness::logMessages.size(), 1u);
  CHECK(!harness::logMessages.empty() && harness::logMessages[0] == "Failed to sample gamepad data!\n");

  // Once the read works again, the controller arrives
  harness::batchedReadResult = 0;
  Poll();
  CHECK_EQ(harness::arrivals.size(), 1u);
}

int main() {
  harness::Install();
  test_support::RunTest("batched read: arrival, send on change, refresh, retry, mask changes", TestBatchedRead);
  test_support::RunTest("fallback read: the same behaviour through the single Emscripten calls", TestFallbackRead);
  test_support::RunTest("Tizen placeholder slots are announced only once they report input", TestPlaceholderSlots);
  test_support::RunTest("a controller replaced in the same slot is removed and announced again", TestReplacedController);
  test_support::RunTest("no slots: nothing is announced or sent", TestFailedRead);
  test_support::RunTest("a read that throws is not logged again by every poll", TestThrowingReadIsNotLoggedEachPoll);
  return test_support::Summary();
}
