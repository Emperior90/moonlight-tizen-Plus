// Pins the keyboard and mouse input of the stream in wasm/input.cpp: keys and mouse buttons reach the host only while
// the pointer is locked, and those that the host still holds when the pointer lock ends are released there at once
// (MouseLockLost()). Without the lock, HandleKeyUp() and HandleMouseUp() pass nothing on, so a key that was held when
// the Stream Menu opened (which releases the pointer and keeps the keys in the UI) would otherwise stay held on the
// host until it is pressed again. Since 2.3.3 also: Ctrl + Alt + Shift with a key, pressed in the order in which the
// browser reports it, never ends the pointer lock (before, every combination other than Q and S did, after which no
// key reached the host), only the key codes of a PC keyboard (1 to 0xFF) reach the host, and a release reaches it only
// for a key whose press it got (the first key of a stream only locks the pointer, see initSpecialKeys() in index.js).
// input.cpp is included directly; the functions below stand in for moonlight-common-c and record what it sends.

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
int LiSendHighResHScrollEvent(short) {
  return 0;
}
int LiSendUtf8TextEvent(const char*, unsigned int) {  // sendText(), which text_input_test.cpp checks
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
  em_pointerlock_requests() = 0;
  em_pointerlock_exits() = 0;
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

// Ctrl, Alt and Shift pressed one after the other as the browser reports them: the keydown of a modifier already carries
// its own flag, so the keydown of Shift has all three
static void PressCtrlAltShift() {
  Instance()->HandleKeyDown(Key(17, true));
  Instance()->HandleKeyDown(Key(18, true, true));
  Instance()->HandleKeyDown(Key(16, true, true, true));
}

// ... and released in the same order: the keyup of a modifier no longer carries its own flag
static void ReleaseCtrlAltShift() {
  Instance()->HandleKeyUp(Key(17, false, true, true));
  Instance()->HandleKeyUp(Key(18, false, false, true));
  Instance()->HandleKeyUp(Key(16));
}

// What the host gets for Ctrl, Alt and Shift pressed and released as above
static const char* const kModifiersDown[] = {
  "key down 0x8011 modifiers 2", "key down 0x8012 modifiers 6", "key down 0x8010 modifiers 7",
};
static const char* const kModifiersUp[] = {
  "key up 0x8011 modifiers 5", "key up 0x8012 modifiers 1", "key up 0x8010 modifiers 0",
};

static void TestStatsShortcutKeepsTheKeyboard() {
  // Ctrl + Alt + Shift + S steps the statistics without pressing S on the host, and the keyboard goes on reaching the
  // host afterwards: before 2.3.3 the release of the last modifier ended the pointer lock (the keydown of Shift already
  // carried all three modifiers), and the host got the release of S, whose press it never got
  Reset();
  Lock();
  PressCtrlAltShift();
  const EM_BOOL handled = Instance()->HandleKeyDown(Key(0x53, true, true, true));
  CHECK_EQ(handled, EM_TRUE);
  const EM_BOOL released = Instance()->HandleKeyUp(Key(0x53, true, true, true));
  CHECK_EQ(released, EM_TRUE);
  ReleaseCtrlAltShift();
  CHECK_EQ(toggleStatsCalls, 1);
  CHECK_EQ(em_pointerlock_exits().load(), 0);
  const std::vector<std::string> expected = {
    kModifiersDown[0], kModifiersDown[1], kModifiersDown[2], kModifiersUp[0], kModifiersUp[1], kModifiersUp[2],
  };
  CHECK(sent == expected);

  // The next key reaches the host
  sent.clear();
  const EM_BOOL next = Instance()->HandleKeyDown(Key(87));
  CHECK_EQ(next, EM_TRUE);
  const std::vector<std::string> w = { "key down 0x8057 modifiers 0" };
  CHECK(sent == w);
}

static void TestOtherCtrlAltShiftCombinationsGoToTheHost() {
  // Ctrl + Alt + Shift with another key, e.g. F1, with which Sunshine switches the display it captures, or N, goes to
  // the host whole, and the pointer stays locked
  const unsigned long keys[] = { 112, 0x4E };
  for (unsigned long key : keys) {
    Reset();
    Lock();
    PressCtrlAltShift();
    const EM_BOOL down = Instance()->HandleKeyDown(Key(key, true, true, true));
    CHECK_EQ(down, EM_TRUE);
    Instance()->HandleKeyUp(Key(key, true, true, true));
    ReleaseCtrlAltShift();
    char keyDown[64];
    char keyUp[64];
    std::snprintf(keyDown, sizeof(keyDown), "key down 0x%04lx modifiers 7", 0x8000 | key);
    std::snprintf(keyUp, sizeof(keyUp), "key up 0x%04lx modifiers 7", 0x8000 | key);
    const std::vector<std::string> expected = {
      kModifiersDown[0], kModifiersDown[1], kModifiersDown[2], keyDown, keyUp, kModifiersUp[0], kModifiersUp[1],
      kModifiersUp[2],
    };
    CHECK(sent == expected);
    CHECK_EQ(em_pointerlock_exits().load(), 0);
    CHECK_EQ(stopStreamCalls + toggleStatsCalls, 0);
  }
}

static void TestTvKeysNeverReachTheHost() {
  // The keys that only a TV has (the color keys, CH+, CH-, RETURN, Source, Channel list, Play/Pause, Pause, keys of the
  // keyboard of the TV) and a key the browser couldn't name are left to the app: the host would get only the low byte
  // of their code, an unrelated key (CH- 428 = 0x1AC as 0xAC, which Sunshine types as M)
  Reset();
  Lock();
  const unsigned long codes[] = { 403, 404, 405, 406, 427, 428, 10009, 10072, 10073, 10252, 415, 65376, 65385, 0, 256 };
  for (unsigned long code : codes) {
    const EM_BOOL down = Instance()->HandleKeyDown(Key(code));
    const EM_BOOL up = Instance()->HandleKeyUp(Key(code));
    CHECK_EQ(down, EM_FALSE);
    CHECK_EQ(up, EM_FALSE);
  }
  CHECK(sent.empty());
  // None of them is held on the host
  Instance()->MouseLockLost();
  CHECK(sent.empty());

  // The highest code of a PC keyboard still goes
  Lock();
  Instance()->HandleKeyDown(Key(0xFF));
  Instance()->HandleKeyUp(Key(0xFF));
  const std::vector<std::string> expected = { "key down 0x80ff modifiers 0", "key up 0x80ff modifiers 0" };
  CHECK(sent == expected);
}

static void TestReleaseWithoutPressStaysOnTheTv() {
  // The first key of a stream (RIGHT) comes before the lock and goes nowhere; the module doesn't ask for the lock itself
  // (the page does, initSpecialKeys() in index.js). Its release, which can come after the lock, doesn't reach the host
  // alone
  Reset();
  const EM_BOOL first = Instance()->HandleKeyDown(Key(39));
  CHECK_EQ(first, EM_FALSE);
  CHECK_EQ(em_pointerlock_requests().load(), 0);
  Lock();
  const EM_BOOL release = Instance()->HandleKeyUp(Key(39));
  CHECK_EQ(release, EM_TRUE);
  CHECK(sent.empty());
  // The next press of the key reaches the host with its release
  Instance()->HandleKeyDown(Key(39));
  Instance()->HandleKeyUp(Key(39));
  const std::vector<std::string> right = { "key down 0x8027 modifiers 0", "key up 0x8027 modifiers 0" };
  CHECK(sent == right);

  // The release of Q of Ctrl + Alt + Shift + Q, which ends the stream without pressing Q on the host, stays on the TV too
  Reset();
  Lock();
  PressCtrlAltShift();
  Instance()->HandleKeyDown(Key(0x51, true, true, true));
  CHECK_EQ(stopStreamCalls, 1);
  sent.clear();
  Instance()->HandleKeyUp(Key(0x51, true, true, true));
  CHECK(sent.empty());
}

int main() {
  test_support::RunTest("keys and mouse buttons held when the pointer lock ends are released on the host",
                        TestHeldInputIsReleasedWhenTheLockEnds);
  test_support::RunTest("keys and mouse buttons released before are not released again",
                        TestReleasedInputIsNotReleasedAgain);
  test_support::RunTest("without the pointer lock nothing reaches the host", TestNothingReachesTheHostWithoutTheLock);
  test_support::RunTest("Ctrl + Alt + Shift + S in the order of the browser steps the statistics and keeps the keyboard",
                        TestStatsShortcutKeepsTheKeyboard);
  test_support::RunTest("Ctrl + Alt + Shift with another key goes to the host and keeps the keyboard",
                        TestOtherCtrlAltShiftCombinationsGoToTheHost);
  test_support::RunTest("the keys that only a TV has never reach the host", TestTvKeysNeverReachTheHost);
  test_support::RunTest("a release whose press the host didn't get stays on the TV", TestReleaseWithoutPressStaysOnTheTv);
  return test_support::Summary();
}
