// Checks the mouse movement and wheel of a stream in wasm/input.cpp, which two threads share: the main thread adds the
// movements and wheel ticks up (HandleMouseMove(), HandleWheel()) while the input thread sends and resets them every
// 5 ms (ReportMouseMovement()). With plain fields, a movement that arrived between the read and the reset of the input
// thread was lost; with atomic exchanges every movement reaches the host. A movement beyond the 16 bits of a packet
// goes out in several packets instead of wrapping around. input.cpp is included directly; the functions below stand in
// for moonlight-common-c and add up what it sends.

#include "../../wasm/input.cpp"

#include "test_support.h"

#include <atomic>
#include <cstring>
#include <thread>
#include <vector>

// What input.cpp sent to the host. The input thread is the only one that sends movements and scrolling.
static long long sentX = 0;
static long long sentY = 0;
static long long sentScroll = 0;
static std::vector<short> moves;

MoonlightInstance* g_Instance = nullptr;

int LiSendKeyboardEvent(short, char, char) {
  return 0;
}
int LiSendMouseButtonEvent(char, int) {
  return 0;
}
int LiSendMouseMoveEvent(short deltaX, short deltaY) {
  sentX += deltaX;
  sentY += deltaY;
  moves.push_back(deltaX);
  return 0;
}
int LiSendHighResScrollEvent(short amount) {
  sentScroll += amount;
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
  sentX = sentY = sentScroll = 0;
  moves.clear();
}

static EmscriptenMouseEvent Move(long x, long y) {
  EmscriptenMouseEvent event;
  std::memset(&event, 0, sizeof(event));
  event.movementX = x;
  event.movementY = y;
  return event;
}

static EmscriptenWheelEvent Wheel(double deltaY) {
  EmscriptenWheelEvent event;
  std::memset(&event, 0, sizeof(event));
  event.deltaY = deltaY;
  return event;
}

static void TestNoMovementIsLostBetweenTheThreads() {
  // The main thread moves the mouse and turns the wheel as fast as it can while the input thread reports without a
  // pause, which makes a read and reset of the input thread meet the additions of the main thread over and over
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

int main() {
  test_support::RunTest("no mouse movement or wheel tick is lost between the main and the input thread",
                        TestNoMovementIsLostBetweenTheThreads);
  test_support::RunTest("a movement beyond 16 bits goes out in several packets", TestLargeMovementGoesOutInSeveralPackets);
  test_support::RunTest("the wheel keeps its amount and direction", TestWheelKeepsItsAmount);
  return test_support::Summary();
}
