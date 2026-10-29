// Pins the keyboard and mouse input of the stream in wasm/input.cpp: keys and mouse buttons reach the host only while
// the pointer is locked, and those that the host still holds when the pointer lock ends are released there at once
// (MouseLockLost()). Without the lock, HandleKeyUp() and HandleMouseUp() pass nothing on, so a key that was held when
// the Stream Menu opened (which releases the pointer and keeps the keys in the UI) would otherwise stay held on the
// host until it is pressed again. input.cpp is included directly; the functions below stand in for moonlight-common-c
// and record what it sends.

#include "../../wasm/input.cpp"

#include "test_support.h"

#include <cstring>
#include <string>
#include <vector>

// What input.cpp sent to the host, as 'key down 0x8057 modifiers 0', 'key up 0x8057 modifiers 0', 'mouse press 3' or
// 'mouse release 3'
static std::vector<std::string> sent;
static int stopStreamCalls = 0;
static int toggleStatsCalls = 0;

MoonlightInstance* g_Instance = nullptr;

int LiSendKeyboardEvent(short keyCode, char keyAction, char modifiers) {
  char text[64];
  std::snprintf(text, sizeof(text), "key %s 0x%04x modifiers %d", keyAction == KEY_ACTION_DOWN ? "down" : "up",
                static_cast<unsigned short>(keyCode), modifiers);
  sent.push_back(text);
  return 0;
}
int LiSendMouseButtonEvent(char action, int button) {
  const std::string name = action == BUTTON_ACTION_PRESS ? "mouse press " : "mouse release ";
  sent.push_back(name + std::to_string(button));
  return 0;
}
int LiSendMouseMoveEvent(short, short) {
  return 0;
}
int LiSendHighResScrollEvent(short) {
  return 0;
}
void MoonlightInstance::ClLogMessage(const char*, ...) {}
MessageResult stopStream() {
  stopStreamCalls++;
  return MessageResult();
}
void toggleStats() {
  toggleStatsCalls++;
}

// The instance that the handlers run on. They only use plain members, so it is never constructed (the vptr check of
// UBSan is off for this reason, see run.sh), like the instance of tests/native/gamepad_harness.h.
static MoonlightInstance* Instance() {
  alignas(MoonlightInstance) static unsigned char storage[sizeof(MoonlightInstance)];
  return reinterpret_cast<MoonlightInstance*>(storage);
}

// Start each test with an unlocked pointer, nothing held and nothing recorded
static void Reset() {
  Instance()->MouseLockLost();
  sent.clear();
  stopStreamCalls = 0;
  toggleStatsCalls = 0;
}

static void Lock() {
  Instance()->DidLockMouse(0);
}

static EmscriptenKeyboardEvent Key(unsigned long keyCode, bool ctrl = false, bool alt = false, bool shift = false) {
  EmscriptenKeyboardEvent event;
  std::memset(&event, 0, sizeof(event));
  event.keyCode = keyCode;
  event.ctrlKey = ctrl;
  event.altKey = alt;
  event.shiftKey = shift;
  return event;
}

static EmscriptenMouseEvent Mouse(unsigned short button) {
  EmscriptenMouseEvent event;
  std::memset(&event, 0, sizeof(event));
  event.button = button;
  return event;
}

static void TestHeldInputIsReleasedWhenTheLockEnds() {
  // Shift + W held to run and the right mouse button held to aim when the pointer lock ends (the Stream Menu opens)
  Reset();
  Lock();
  Instance()->HandleKeyDown(Key(16, false, false, true));
  Instance()->HandleKeyDown(Key(87, false, false, true));
  Instance()->HandleMouseDown(Mouse(2));
  CHECK_EQ(sent.size(), 3u);
  sent.clear();
  Instance()->MouseLockLost();
  const std::vector<std::string> released = {
    "key up 0x8010 modifiers 0", "key up 0x8057 modifiers 0", "mouse release 3",
  };
  CHECK(sent == released);

  // Their releases arrive while the menu is open and reach the host no more, which already has them released
  sent.clear();
  CHECK_EQ(Instance()->HandleKeyUp(Key(87)), EM_FALSE);
  CHECK_EQ(Instance()->HandleKeyUp(Key(16)), EM_FALSE);
  CHECK_EQ(Instance()->HandleMouseUp(Mouse(2)), EM_FALSE);
  CHECK(sent.empty());

  // Each one is released once: the next end of the lock releases nothing
  Lock();
  Instance()->MouseLockLost();
  CHECK(sent.empty());
}

static void TestReleasedInputIsNotReleasedAgain() {
  // A key and a mouse button that went up before the lock ended are not sent again
  Reset();
  Lock();
  Instance()->HandleKeyDown(Key(65));
  Instance()->HandleKeyUp(Key(65));
  Instance()->HandleMouseDown(Mouse(0));
  Instance()->HandleMouseUp(Mouse(0));
  Instance()->HandleKeyDown(Key(68));
  sent.clear();
  Instance()->MouseLockLost();
  const std::vector<std::string> released = { "key up 0x8044 modifiers 0" };
  CHECK(sent == released);

  // The auto-repeat of a held key is one key on the host, released once
  Reset();
  Lock();
  for (int i = 0; i < 3; ++i) {
    Instance()->HandleKeyDown(Key(13));
  }
  sent.clear();
  Instance()->MouseLockLost();
  CHECK_EQ(sent.size(), 1u);
}

static void TestNothingReachesTheHostWithoutTheLock() {
  // Without the lock, a key goes nowhere, and a mouse button only asks for the lock
  Reset();
  CHECK_EQ(Instance()->HandleKeyDown(Key(87)), EM_FALSE);
  CHECK_EQ(Instance()->HandleMouseDown(Mouse(0)), EM_TRUE);
  CHECK(sent.empty());
  Instance()->MouseLockLost();
  CHECK(sent.empty());

  // Ctrl + Alt + Shift + Q stops the stream without pressing Q on the host, and a release of the modifiers that ends
  // the lock afterwards releases only what the host got
  Reset();
  Lock();
  Instance()->HandleKeyDown(Key(17, true));
  Instance()->HandleKeyDown(Key(0x51, true, true, true));
  CHECK_EQ(stopStreamCalls, 1);
  sent.clear();
  Instance()->MouseLockLost();
  const std::vector<std::string> released = { "key up 0x8011 modifiers 0" };
  CHECK(sent == released);
}

int main() {
  test_support::RunTest("keys and mouse buttons held when the pointer lock ends are released on the host",
                        TestHeldInputIsReleasedWhenTheLockEnds);
  test_support::RunTest("keys and mouse buttons released before are not released again",
                        TestReleasedInputIsNotReleasedAgain);
  test_support::RunTest("without the pointer lock nothing reaches the host", TestNothingReachesTheHostWithoutTheLock);
  return test_support::Summary();
}
