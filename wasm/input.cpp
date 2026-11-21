#include "moonlight_wasm.hpp"
#include "text_input.hpp"

#include <Limelight.h>

#include <algorithm>
#include <cmath>
#include <set>

#define KEY_PREFIX 0x80

// Keys and mouse buttons that the stream sent to the host as pressed and that the host didn't get the release of yet.
// The handlers below run on the main thread, which is the only one that uses them.
static std::set<uint32_t> heldKeys;
static std::set<int> heldMouseButtons;

// Release every key and mouse button that the host still holds from the stream
static void ReleaseHeldInput() {
  for (uint32_t keyCode : heldKeys) {
    LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, KEY_ACTION_UP, 0);
  }
  heldKeys.clear();
  for (int button : heldMouseButtons) {
    LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, button);
  }
  heldMouseButtons.clear();
}

// Whether a key code is one of a PC keyboard: a Windows virtual-key code, of which the host reads only the low byte (a
// code with the prefix 0x80). The keys that only a TV has are above 0xFF (RETURN 10009, the color keys 403 to 406, CH+
// 427, CH- 428, Source 10072, Channel list 10073, Play/Pause 10252, the keys of the keyboard of the TV), and the host
// would get only their low byte, an unrelated key (CH- 0xAC types M with the US layout of Sunshine). A key that the
// browser couldn't name is 0. moonlight-qt drops the keys it can't map in the same way (keyboard.cpp).
static bool IsPcKeyCode(uint32_t keyCode) {
  return keyCode != 0 && keyCode <= 0xFF;
}

static int ConvertButtonToLiButton(unsigned short button) {
  switch (button) {
    case 0:
      return BUTTON_LEFT;
    case 1:
      return BUTTON_MIDDLE;
    case 2:
      return BUTTON_RIGHT;
    default:
      return 0;
  }
}

static char GetModifierFlags(const EmscriptenKeyboardEvent &event) {
  char flags = 0;

  if (event.ctrlKey == true) {
    flags |= MODIFIER_CTRL;
  }
  if (event.altKey == true) {
    flags |= MODIFIER_ALT;
  }
  if (event.shiftKey == true) {
    flags |= MODIFIER_SHIFT;
  }

  return flags;
}

EM_BOOL MoonlightInstance::HandleMouseDown(const EmscriptenMouseEvent &event) {
  if (!m_MouseLocked) {
    LockMouse();
    m_MouseLastPosX = event.screenX;
    m_MouseLastPosY = event.screenY;
    return EM_TRUE;
  }

  // The movement that the input thread didn't send yet goes first, so that the click lands where the pointer is
  // (FlushMouseMovement())
  FlushMouseMovement();
  const int button = ConvertButtonToLiButton(event.button);
  LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, button);
  heldMouseButtons.insert(button);
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleMouseMove(const EmscriptenMouseEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  m_MouseDeltaX.fetch_add(static_cast<int32_t>(event.movementX));
  m_MouseDeltaY.fetch_add(static_cast<int32_t>(event.movementY));

  m_MouseLastPosX = event.screenX;
  m_MouseLastPosY = event.screenY;

  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleMouseUp(const EmscriptenMouseEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  FlushMouseMovement();
  const int button = ConvertButtonToLiButton(event.button);
  LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, button);
  heldMouseButtons.erase(button);
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleWheel(const EmscriptenWheelEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  // Inverted delta y-axis to restore correct wheel direction, in thousandths of a tick (bounded, so that the conversion
  // of an absurd delta can't overflow)
  const double milliTicks = std::max(-1000000.0, std::min(1000000.0, -event.deltaY * 1000.0));
  m_AccumulatedMilliTicks.fetch_add(static_cast<int32_t>(std::lround(milliTicks)));
  // The horizontal wheel (a tilt wheel, a touchpad scrolled sideways), at the same scale and not inverted: a positive
  // deltaX scrolls right in the browser and on the host
  const double milliTicksX = std::max(-1000000.0, std::min(1000000.0, event.deltaX * 1000.0));
  m_AccumulatedMilliTicksX.fetch_add(static_cast<int32_t>(std::lround(milliTicksX)));
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleKeyDown(const EmscriptenKeyboardEvent &event) {
  const uint32_t keyCode = event.keyCode;
  if (!IsPcKeyCode(keyCode) || !m_MouseLocked) {
    return EM_FALSE;
  }

  char modifiers = GetModifierFlags(event);

  // Ctrl + Alt + Shift + Q ends the stream and Ctrl + Alt + Shift + S steps the statistics; every other key with these
  // modifiers goes to the PC (e.g. an F key, with which Sunshine switches the display). Before 2.3.3 such a key also
  // ended the pointer lock once the modifiers were up, after which no key reached the PC any more: a TV has no desktop
  // to give the pointer to, and the Stream Menu releases it itself (openStreamMenu() in menus.js).
  if (modifiers == (MODIFIER_CTRL | MODIFIER_ALT | MODIFIER_SHIFT)) {
    if (keyCode == 0x51) { // Q key
      // Terminate the connection
      stopStream();
      return EM_TRUE;
    } else if (keyCode == 0x53) { // S key
      // Toggle performance stats overlay
      toggleStats();
      return EM_TRUE;
    }
  }

  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, KEY_ACTION_DOWN, modifiers);
  heldKeys.insert(keyCode);
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleKeyUp(const EmscriptenKeyboardEvent &event) {
  const uint32_t keyCode = event.keyCode;
  if (!IsPcKeyCode(keyCode) || !m_MouseLocked) {
    return EM_FALSE;
  }

  // Only the release of a key that the host got pressed: the first key of a stream, which only locks the pointer
  // (initSpecialKeys() in index.js), can be released after the lock, and Q and S of Ctrl + Alt + Shift stay on the TV
  if (heldKeys.erase(keyCode) == 0) {
    return EM_TRUE;
  }
  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, KEY_ACTION_UP, GetModifierFlags(event));
  return EM_TRUE;
}

EM_BOOL handleKeyDown(int eventType, const EmscriptenKeyboardEvent *event, void *userData) {
  return g_Instance->HandleKeyDown(*event);
}

EM_BOOL handleKeyUp(int eventType, const EmscriptenKeyboardEvent *event, void *userData) {
  return g_Instance->HandleKeyUp(*event);
}

EM_BOOL handleMouseMove(int eventType, const EmscriptenMouseEvent *event, void *userData) {
  return g_Instance->HandleMouseMove(*event);
}

EM_BOOL handleMouseUp(int eventType, const EmscriptenMouseEvent *event, void *userData) {
  return g_Instance->HandleMouseUp(*event);
}

EM_BOOL handleMouseDown(int eventType, const EmscriptenMouseEvent *event, void *userData) {
  return g_Instance->HandleMouseDown(*event);
}

EM_BOOL handleWheel(int eventType, const EmscriptenWheelEvent *event, void *userData) {
  return g_Instance->HandleWheel(*event);
}

EM_BOOL handlePointerLockChange(int eventType, const EmscriptenPointerlockChangeEvent *pointerlockChangeEvent, void *userData) {
  if (!pointerlockChangeEvent) {
    return false;
  }

  if (pointerlockChangeEvent->isActive) {
    g_Instance->DidLockMouse(0);
  } else {
    g_Instance->MouseLockLost();
  }

  return true;
}

EM_BOOL handlePointerLockError(int eventType, const void *reserved, void *userData) {
  g_Instance->DidLockMouse(eventType);
  return true;
}

// The part of a movement or scroll amount that fits the 16-bit field of its packet
static short ClampToShort(int64_t value) {
  return static_cast<short>(std::max<int64_t>(-32768, std::min<int64_t>(32767, value)));
}

// Send the mouse movement that the main thread added up (HandleMouseMove()). The input thread calls it every 5 ms
// (ReportMouseMovement()), and the main thread right before a mouse button (HandleMouseDown(), HandleMouseUp()), so that
// a click comes after the movement before it. Both can: the exchange gives each movement to one of them, and
// LiSendMouseMoveEvent() of moonlight-common-c takes its own lock.
void MoonlightInstance::FlushMouseMovement() {
  // Take what the main thread added up and reset it in one step, so that a movement that arrives meanwhile stays for
  // the next report instead of being reset unsent. The idea comes from the fork of samirmartins (moonlight-tizen,
  // 78ef238).
  int32_t deltaX = m_MouseDeltaX.exchange(0);
  int32_t deltaY = m_MouseDeltaY.exchange(0);
  // A movement beyond the 16 bits of a packet (e.g. after the input thread was held up) goes out in several packets
  // instead of wrapping around
  while (deltaX != 0 || deltaY != 0) {
    const short x = ClampToShort(deltaX);
    const short y = ClampToShort(deltaY);
    LiSendMouseMoveEvent(x, y);
    deltaX -= x;
    deltaY -= y;
  }
}

// Send wheel ticks in thousandths with send (LiSendHighResScrollEvent() or LiSendHighResHScrollEvent())
static void SendScroll(int32_t milliTicks, int (*send)(short)) {
  // We can have fractional ticks here, so multiply by WHEEL_DELTA to get actual scroll distance and use the high-res
  // variant. More scrolling than a packet holds (over 6553 ticks, e.g. after the input thread was held up) goes out in
  // several packets like a large movement, instead of being cut at 16 bits.
  int64_t scroll = static_cast<int64_t>(milliTicks) * 5 / 1000;
  while (scroll != 0) {
    const short amount = ClampToShort(scroll);
    send(amount);
    scroll -= amount;
  }
}

void MoonlightInstance::ReportMouseMovement() {
  FlushMouseMovement();
  // The wheel only here, on the input thread: the batching of LiSendHighResScrollEvent() for GeForce Experience takes
  // no lock. The horizontal wheel is an extension of Sunshine, which GeForce Experience refuses, as for the right stick
  // of the mouse emulation (gamepad.cpp).
  SendScroll(m_AccumulatedMilliTicks.exchange(0), LiSendHighResScrollEvent);
  SendScroll(m_AccumulatedMilliTicksX.exchange(0), LiSendHighResHScrollEvent);
}

void MoonlightInstance::LockMouse() {
  emscripten_request_pointerlock(kCanvasName, false);
}

void MoonlightInstance::UnlockMouse() {
  emscripten_exit_pointerlock();
}

void MoonlightInstance::DidLockMouse(int32_t result) {
  if (result != 0) {
    ClLogMessage("Error locking mouse, event type: %d\n", result);
  }

  // No IDR frame is requested here any more: the old one dumped a frame queue built up by a stalled GL
  // pipeline, which doesn't exist with the hardware video plane of the TV, and every IDR frame from the host
  // is briefly soft, because the encoder caps its size to that of a normal frame.
  m_MouseLocked = (result == 0);
}

void MoonlightInstance::MouseLockLost() {
  m_MouseLocked = false;
  // Without the pointer lock, HandleKeyUp() and HandleMouseUp() pass nothing on, so the releases of the keys and mouse
  // buttons that are held now would never reach the host, which keeps them held (and repeats a held key) until they are
  // pressed again: e.g. W held to walk or the right mouse button held to aim when the Stream Menu opens, which releases
  // the pointer and keeps the keys in the UI. Release them on the host now.
  ReleaseHeldInput();
}

void sendKeyboardEvent(uint32_t keyCode, uint16_t action, char modifiers) {
  // Send a keyboard event to the host
  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, action, modifiers);
}

// Send a text that the user typed on the TV to the host as Unicode text (wasm/text_input.hpp), whole or not at all.
// JavaScript calls it as Module.sendText(text) on the main thread during a stream; LiSendUtf8TextEvent() only queues the
// text for the input thread. Returns a TextInputResult. The text can be a password, so it is never logged.
int sendText(std::string text) {
  return SendTextInput(text, LiSendUtf8TextEvent);
}

EMSCRIPTEN_BINDINGS(input) {
  emscripten::function("sendKeyboardEvent", &sendKeyboardEvent);
  emscripten::function("sendText", &sendText);
}
