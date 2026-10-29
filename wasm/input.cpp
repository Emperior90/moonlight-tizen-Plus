#include "moonlight_wasm.hpp"

#include <Limelight.h>

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

  const int button = ConvertButtonToLiButton(event.button);
  LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, button);
  heldMouseButtons.insert(button);
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleMouseMove(const EmscriptenMouseEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  m_MouseDeltaX += event.movementX;
  m_MouseDeltaY += event.movementY;

  m_MouseLastPosX = event.screenX;
  m_MouseLastPosY = event.screenY;

  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleMouseUp(const EmscriptenMouseEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  const int button = ConvertButtonToLiButton(event.button);
  LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, button);
  heldMouseButtons.erase(button);
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleWheel(const EmscriptenWheelEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  // Inverted delta y-axis to restore correct wheel direction
  m_AccumulatedTicks -= event.deltaY;
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleKeyDown(const EmscriptenKeyboardEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  char modifiers = GetModifierFlags(event);
  uint32_t keyCode = event.keyCode;

  // Check if the current modifier flags match the defined key combination on the keyboard
  if (modifiers == (MODIFIER_CTRL | MODIFIER_ALT | MODIFIER_SHIFT)) {
    if (keyCode == 0x51) { // Q key
      // Terminate the connection
      stopStream();
      return EM_TRUE;
    } else if (keyCode == 0x53) { // S key
      // Toggle performance stats overlay
      toggleStats();
      return EM_TRUE;
    } else {
      // Wait until these keys come up to unlock the mouse
      m_WaitingForAllModifiersUp = true;
    }
  }

  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, KEY_ACTION_DOWN, modifiers);
  heldKeys.insert(keyCode);
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleKeyUp(const EmscriptenKeyboardEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  char modifiers = GetModifierFlags(event);
  uint32_t keyCode = event.keyCode;

  // Check if all modifiers are up now
  if (m_WaitingForAllModifiersUp && modifiers == 0) {
    UnlockMouse();
    m_WaitingForAllModifiersUp = false;
  }

  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, KEY_ACTION_UP, modifiers);
  heldKeys.erase(keyCode);
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

void MoonlightInstance::ReportMouseMovement() {
  if (m_MouseDeltaX != 0 || m_MouseDeltaY != 0) {
    LiSendMouseMoveEvent(m_MouseDeltaX, m_MouseDeltaY);
    m_MouseDeltaX = m_MouseDeltaY = 0;
  }

  if (m_AccumulatedTicks != 0) {
    // We can have fractional ticks here, so multiply by WHEEL_DELTA
    // to get actual scroll distance and use the high-res variant.
    LiSendHighResScrollEvent(m_AccumulatedTicks * 5);
    m_AccumulatedTicks = 0;
  }
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

EMSCRIPTEN_BINDINGS(input) {
  emscripten::function("sendKeyboardEvent", &sendKeyboardEvent);
}
