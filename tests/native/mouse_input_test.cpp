// Checks the mouse movement and wheel of a stream in wasm/input.cpp, which two threads share: the main thread adds the
// movements and wheel ticks up (HandleMouseMove(), HandleWheel()) while the input thread sends and resets them every
// 5 ms (ReportMouseMovement()). With plain fields, a movement that arrived between the read and the reset of the input
// thread was lost; with atomic exchanges every movement reaches the host. A movement or a scroll beyond the 16 bits of a
// packet goes out in several packets instead of wrapping around or being cut off. Since 2.3.3 a mouse button sends the
// movement before it first, from the main thread (FlushMouseMovement()), so that a click lands where the pointer is,
// also while the input thread holds a movement that it took but didn't queue yet, and the horizontal wheel scrolls
// sideways (LiSendHighResHScrollEvent()). input.cpp is included directly; the functions below stand in for
// moonlight-common-c and add up what it sends.

#include "../../wasm/input.cpp"

#include "test_support.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// What input.cpp sent to the host. Both threads send movements (the main thread the one before a mouse button), so the
// stand-ins take a lock, as LiSendMouseMoveEvent() of moonlight-common-c does; only the input thread scrolls, but into
// the same list of events.
static std::mutex sendMutex;
static long long sentX = 0;
static long long sentY = 0;
static long long sentScroll = 0;
static long long sentHScroll = 0;
static std::vector<short> moves;
static std::vector<short> scrolls;
static std::vector<short> hscrolls;
// The movements and mouse buttons in the order the host got them, as 'move 12,-3', 'press 1' or 'release 1', and the
// vertical and horizontal scrolling as 'scroll -5' or 'hscroll 5'
static std::vector<std::string> events;

MoonlightInstance* g_Instance = nullptr;

int LiSendKeyboardEvent(short, char, char) {
  return 0;
}
int LiSendMouseButtonEvent(char action, int button) {
  std::lock_guard<std::mutex> lock(sendMutex);
  events.push_back(std::string(action == BUTTON_ACTION_PRESS ? "press " : "release ") + std::to_string(button));
  return 0;
}
// A pause of one thread in LiSendMouseMoveEvent(), right after FlushMouseMovement() took the movement and before
// moonlight-common-c queues it, as when the system lets another thread run there: pausedThread is held until the main
// thread clicked (clicked) or 200 ms passed, and movementTaken says that it got there
static std::mutex pauseMutex;
static std::condition_variable pauseChanged;
static std::thread::id pausedThread;
static bool movementTaken = false;
static bool clicked = false;

int LiSendMouseMoveEvent(short deltaX, short deltaY) {
  {
    std::unique_lock<std::mutex> pause(pauseMutex);
    if (std::this_thread::get_id() == pausedThread) {
      movementTaken = true;
      pauseChanged.notify_all();
      pauseChanged.wait_for(pause, std::chrono::milliseconds(200), [] { return clicked; });
    }
  }
  std::lock_guard<std::mutex> lock(sendMutex);
  sentX += deltaX;
  sentY += deltaY;
  moves.push_back(deltaX);
  events.push_back("move " + std::to_string(deltaX) + "," + std::to_string(deltaY));
  return 0;
}
int LiSendHighResScrollEvent(short amount) {
  std::lock_guard<std::mutex> lock(sendMutex);
  sentScroll += amount;
  scrolls.push_back(amount);
  events.push_back("scroll " + std::to_string(amount));
  return 0;
}
int LiSendHighResHScrollEvent(short amount) {
  std::lock_guard<std::mutex> lock(sendMutex);
  sentHScroll += amount;
  hscrolls.push_back(amount);
  events.push_back("hscroll " + std::to_string(amount));
  return 0;
}
int LiSendUtf8TextEvent(const char*, unsigned int) {  // sendText(), which text_input_test.cpp checks
  return 0;
}
void MoonlightInstance::ClLogMessage(const char*, ...) {}
MessageResult stopStream() {
  return MessageResult();
}
void toggleStats() {}

// The instance that the handlers run on. They only use plain and atomic members, so it is never constructed (the vptr
// check of UBSan is off for this reason, see run.sh), like the instance of input_release_test.cpp.
static MoonlightInstance* Instance() {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  return reinterpret_cast<MoonlightInstance*>(storage);
}

static void Reset() {
  Instance()->DidLockMouse(0);
  Instance()->ReportMouseMovement();
  sentX = sentY = sentScroll = sentHScroll = 0;
  moves.clear();
  scrolls.clear();
  hscrolls.clear();
  events.clear();
}

static EmscriptenMouseEvent Move(long x, long y) {
  EmscriptenMouseEvent event;
  std::memset(&event, 0, sizeof(event));
  event.movementX = x;
  event.movementY = y;
  return event;
}

static EmscriptenWheelEvent Wheel(double deltaY, double deltaX = 0) {
  EmscriptenWheelEvent event;
  std::memset(&event, 0, sizeof(event));
  event.deltaY = deltaY;
  event.deltaX = deltaX;
  return event;
}

static EmscriptenMouseEvent Button(unsigned short button) {
  EmscriptenMouseEvent event;
  std::memset(&event, 0, sizeof(event));
  event.button = button;
  return event;
}

static void TestNoMovementIsLostBetweenTheThreads() {
  // The main thread moves the mouse and turns the wheel as fast as it can while the input thread reports without a
  // pause, which makes a read and reset of the input thread meet the additions of the main thread over and over. Now and
  // then it clicks, which sends the movement from the main thread while the input thread sends it as well.
  Reset();
  const int kMoves = 400000;
  std::atomic<bool> moving{true};
  std::thread input([&moving] {
    while (moving.load()) {
      Instance()->ReportMouseMovement();
    }
    Instance()->ReportMouseMovement();
  });
  for (int i = 0; i < kMoves; ++i) {
    Instance()->HandleMouseMove(Move(1, -2));
    if (i % 4 == 0) {
      Instance()->HandleWheel(Wheel(-1));
    }
    if (i % 1000 == 0) {
      Instance()->HandleMouseDown(Button(0));
      Instance()->HandleMouseUp(Button(0));
    }
  }
  moving = false;
  input.join();
  CHECK_EQ(sentX, static_cast<long long>(kMoves));
  CHECK_EQ(sentY, -2LL * kMoves);
  // One tick of the wheel scrolls by 5 (WHEEL_DELTA / 24 of the high-resolution scroll)
  CHECK_EQ(sentScroll, 5LL * (kMoves / 4));
}

static void TestLargeMovementGoesOutInSeveralPackets() {
  // A movement beyond the 16 bits of a packet, e.g. after the input thread was held up, keeps its direction and size
  Reset();
  Instance()->HandleMouseMove(Move(40000, 0));
  Instance()->HandleMouseMove(Move(30000, -5));
  Instance()->ReportMouseMovement();
  CHECK_EQ(sentX, 70000LL);
  CHECK_EQ(sentY, -5LL);
  const std::vector<short> expected = { 32767, 32767, 4466 };
  CHECK(moves == expected);

  Reset();
  Instance()->HandleMouseMove(Move(-70000, 0));
  Instance()->ReportMouseMovement();
  CHECK_EQ(sentX, -70000LL);
}

static void TestWheelKeepsItsAmount() {
  // A notch of 100 pixels in either direction, and fractions of a tick added up until they are sent
  Reset();
  Instance()->HandleWheel(Wheel(100));
  Instance()->ReportMouseMovement();
  CHECK_EQ(sentScroll, -500LL);
  Reset();
  Instance()->HandleWheel(Wheel(-0.5));
  Instance()->HandleWheel(Wheel(-0.5));
  Instance()->HandleWheel(Wheel(-0.5));
  Instance()->ReportMouseMovement();
  CHECK_EQ(sentScroll, 7LL);
  // Nothing more to send until the next movement
  Instance()->ReportMouseMovement();
  CHECK_EQ(sentScroll, 7LL);
  CHECK(moves.empty());
}

static void TestLargeScrollGoesOutInSeveralPackets() {
  // More wheel ticks than the 16 bits of a packet hold (6553 ticks of 5), e.g. after the input thread was held up while
  // the main thread went on adding them, which the test above can meet on a busy machine: nothing is cut off
  Reset();
  for (int i = 0; i < 7000; ++i) {
    Instance()->HandleWheel(Wheel(-1));
  }
  Instance()->ReportMouseMovement();
  CHECK_EQ(sentScroll, 35000LL);
  const std::vector<short> up = { 32767, 2233 };
  CHECK(scrolls == up);
  Reset();
  for (int i = 0; i < 14000; ++i) {
    Instance()->HandleWheel(Wheel(1));
  }
  Instance()->ReportMouseMovement();
  CHECK_EQ(sentScroll, -70000LL);
  const std::vector<short> down = { -32768, -32768, -4464 };
  CHECK(scrolls == down);
}

static void TestClickComesAfterTheMovementBeforeIt() {
  // A quick move and a click right after it, before the input thread sent the move: the host gets the move first, so
  // that the click lands where the pointer is (before 2.3.3 it got press, release, move 14,-3)
  Reset();
  Instance()->HandleMouseMove(Move(12, -3));
  Instance()->HandleMouseDown(Button(0));
  Instance()->HandleMouseMove(Move(2, 0));
  Instance()->HandleMouseUp(Button(0));
  Instance()->ReportMouseMovement();
  const std::vector<std::string> expected = { "move 12,-3", "press 1", "move 2,0", "release 1" };
  CHECK(events == expected);
}

static void TestClickWaitsForTheMovementTheInputThreadTook() {
  // The input thread took the movement for its report and is held up before moonlight-common-c queued it, when the main
  // thread clicks: the click waits for that movement (mouseFlushMutex). Without the lock the main thread found nothing
  // left to send and queued the press first: press 1, then move 12,0
  Reset();
  Instance()->HandleMouseMove(Move(12, 0));
  std::thread input([] {
    {
      std::lock_guard<std::mutex> pause(pauseMutex);
      pausedThread = std::this_thread::get_id();
    }
    Instance()->ReportMouseMovement();
  });
  {
    std::unique_lock<std::mutex> pause(pauseMutex);
    pauseChanged.wait(pause, [] { return movementTaken; });
  }
  Instance()->HandleMouseDown(Button(0));
  {
    std::lock_guard<std::mutex> pause(pauseMutex);
    clicked = true;
  }
  pauseChanged.notify_all();
  input.join();
  Instance()->HandleMouseUp(Button(0));
  {
    std::lock_guard<std::mutex> pause(pauseMutex);
    pausedThread = std::thread::id();
    movementTaken = false;
    clicked = false;
  }
  const std::vector<std::string> expected = { "move 12,0", "press 1", "release 1" };
  CHECK(events == expected);
}

static void TestHorizontalWheelScrollsSideways() {
  // A tilt wheel or a touchpad scrolled sideways: a positive deltaX scrolls right on the host, at the scale of the
  // vertical wheel, without scrolling it vertically
  Reset();
  Instance()->HandleWheel(Wheel(0, 100));
  Instance()->ReportMouseMovement();
  const std::vector<short> right = { 500 };
  CHECK(hscrolls == right);
  CHECK(scrolls.empty());
  // Fractions of a tick add up until they are sent, as for the vertical wheel, but not inverted
  Reset();
  Instance()->HandleWheel(Wheel(0, -0.5));
  Instance()->HandleWheel(Wheel(0, -0.5));
  Instance()->HandleWheel(Wheel(0, -0.5));
  Instance()->ReportMouseMovement();
  CHECK_EQ(sentHScroll, -7LL);
  // Both directions at once: the vertical wheel first
  Reset();
  Instance()->HandleWheel(Wheel(1, 1));
  Instance()->ReportMouseMovement();
  const std::vector<std::string> both = { "scroll -5", "hscroll 5" };
  CHECK(events == both);
  // Beyond the 16 bits of a packet in several packets
  Reset();
  for (int i = 0; i < 7000; ++i) {
    Instance()->HandleWheel(Wheel(0, 1));
  }
  Instance()->ReportMouseMovement();
  const std::vector<short> large = { 32767, 2233 };
  CHECK(hscrolls == large);
}

int main() {
  test_support::RunTest("no mouse movement or wheel tick is lost between the main and the input thread",
                        TestNoMovementIsLostBetweenTheThreads);
  test_support::RunTest("a movement beyond 16 bits goes out in several packets", TestLargeMovementGoesOutInSeveralPackets);
  test_support::RunTest("the wheel keeps its amount and direction", TestWheelKeepsItsAmount);
  test_support::RunTest("a scroll beyond 16 bits goes out in several packets", TestLargeScrollGoesOutInSeveralPackets);
  test_support::RunTest("a click comes after the movement before it", TestClickComesAfterTheMovementBeforeIt);
  test_support::RunTest("a click waits for the movement that the input thread took but didn't queue yet",
                        TestClickWaitsForTheMovementTheInputThreadTook);
  test_support::RunTest("the horizontal wheel scrolls sideways, right as right", TestHorizontalWheelScrollsSideways);
  return test_support::Summary();
}
