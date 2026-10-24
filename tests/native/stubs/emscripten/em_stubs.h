#pragma once
// Host stand-ins for the parts of the Emscripten 1.39 headers that the app's native code uses, so that its files can be
// built with g++ for the native tests. The EM_ASM macros keep the shape of Emscripten 1.39 (the code block is one
// macro argument), so a code block with a comma outside parentheses fails here just like in the real build. A test
// can answer the main-thread EM_ASM calls through em_asm_sync_hook() and the gamepad calls through em_gamepad_hook().
#include <cstdint>
#include <cstdarg>
typedef int EM_BOOL;
#define EM_TRUE 1
#define EM_FALSE 0
// Same macro shapes as Emscripten 1.39.4 (asm.js), so top-level commas in a code block still break the build
#define _EM_ASM_PREP_ARGS(...) , ##__VA_ARGS__
inline int emscripten_asm_const_int(const char*, ...) { return 0; }
typedef int (*em_asm_sync_hook_t)(const char* code, va_list args);
inline em_asm_sync_hook_t& em_asm_sync_hook() { static em_asm_sync_hook_t hook = nullptr; return hook; }
inline int emscripten_asm_const_int_sync_on_main_thread(const char* code, ...) {
  int result = 0;
  if (em_asm_sync_hook()) { va_list args; va_start(args, code); result = em_asm_sync_hook()(code, args); va_end(args); }
  return result;
}
inline void emscripten_asm_const_async_on_main_thread(const char*, ...) {}
#define EM_ASM(code, ...) ((void)emscripten_asm_const_int(#code _EM_ASM_PREP_ARGS(__VA_ARGS__)))
#define EM_ASM_INT(code, ...) emscripten_asm_const_int(#code _EM_ASM_PREP_ARGS(__VA_ARGS__))
#define MAIN_THREAD_EM_ASM(code, ...) ((void)emscripten_asm_const_int_sync_on_main_thread(#code _EM_ASM_PREP_ARGS(__VA_ARGS__)))
#define MAIN_THREAD_EM_ASM_INT(code, ...) emscripten_asm_const_int_sync_on_main_thread(#code _EM_ASM_PREP_ARGS(__VA_ARGS__))
#define MAIN_THREAD_ASYNC_EM_ASM(code, ...) ((void)emscripten_asm_const_async_on_main_thread(#code _EM_ASM_PREP_ARGS(__VA_ARGS__)))
#define EM_LOG_CONSOLE 1
#define EM_FUNC_SIG_V 0
#define EM_FUNC_SIG_VI 1
inline void emscripten_log(int, const char*, ...) {}
inline int emscripten_sync_run_in_main_runtime_thread(int, ...) { return 0; }
struct EmscriptenMouseEvent { long screenX, screenY, clientX, clientY, movementX, movementY; unsigned short button, buttons; int ctrlKey, shiftKey, altKey, metaKey; };
struct EmscriptenWheelEvent { EmscriptenMouseEvent mouse; double deltaX, deltaY, deltaZ; unsigned long deltaMode; };
struct EmscriptenKeyboardEvent { char key[32]; char code[32]; unsigned long location; int ctrlKey, shiftKey, altKey, metaKey, repeat; unsigned long charCode, keyCode, which; };
struct EmscriptenPointerlockChangeEvent { int isActive; };
typedef EM_BOOL (*em_key_callback_func)(int, const EmscriptenKeyboardEvent*, void*);
typedef EM_BOOL (*em_mouse_callback_func)(int, const EmscriptenMouseEvent*, void*);
typedef EM_BOOL (*em_wheel_callback_func)(int, const EmscriptenWheelEvent*, void*);
typedef EM_BOOL (*em_pointerlockchange_callback_func)(int, const EmscriptenPointerlockChangeEvent*, void*);
typedef EM_BOOL (*em_pointerlockerror_callback_func)(int, const void*, void*);
inline int emscripten_set_keyup_callback(const char*, void*, EM_BOOL, em_key_callback_func) { return 0; }
inline int emscripten_set_keydown_callback(const char*, void*, EM_BOOL, em_key_callback_func) { return 0; }
inline int emscripten_set_mousedown_callback(const char*, void*, EM_BOOL, em_mouse_callback_func) { return 0; }
inline int emscripten_set_mouseup_callback(const char*, void*, EM_BOOL, em_mouse_callback_func) { return 0; }
inline int emscripten_set_mousemove_callback(const char*, void*, EM_BOOL, em_mouse_callback_func) { return 0; }
inline int emscripten_set_wheel_callback(const char*, void*, EM_BOOL, em_wheel_callback_func) { return 0; }
inline int emscripten_set_pointerlockchange_callback(const char*, void*, EM_BOOL, em_pointerlockchange_callback_func) { return 0; }
inline int emscripten_set_pointerlockerror_callback(const char*, void*, EM_BOOL, em_pointerlockerror_callback_func) { return 0; }
inline int emscripten_request_pointerlock(const char*, EM_BOOL) { return 0; }
inline int emscripten_exit_pointerlock() { return 0; }

// Gamepad API (layout as in Emscripten 1.39.4 html5.h)
typedef int EMSCRIPTEN_RESULT;
typedef char EM_UTF8;
#define EMSCRIPTEN_RESULT_SUCCESS 0
#define EMSCRIPTEN_RESULT_NOT_SUPPORTED -1
#define EMSCRIPTEN_RESULT_INVALID_PARAM -5
#define EMSCRIPTEN_RESULT_NO_DATA -7
#define EM_HTML5_MEDIUM_STRING_LEN_BYTES 64
typedef struct EmscriptenGamepadEvent {
  double timestamp;
  int numAxes;
  int numButtons;
  double axis[64];
  double analogButton[64];
  EM_BOOL digitalButton[64];
  EM_BOOL connected;
  long index;
  EM_UTF8 id[EM_HTML5_MEDIUM_STRING_LEN_BYTES];
  EM_UTF8 mapping[EM_HTML5_MEDIUM_STRING_LEN_BYTES];
} EmscriptenGamepadEvent;
struct em_gamepad_hooks { int (*sample)(); int (*num)(); int (*status)(int, EmscriptenGamepadEvent*); };
inline em_gamepad_hooks& em_gamepad_hook() { static em_gamepad_hooks hooks{}; return hooks; }
inline EMSCRIPTEN_RESULT emscripten_sample_gamepad_data(void) { return em_gamepad_hook().sample ? em_gamepad_hook().sample() : 0; }
inline int emscripten_get_num_gamepads(void) { return em_gamepad_hook().num ? em_gamepad_hook().num() : 0; }
inline EMSCRIPTEN_RESULT emscripten_get_gamepad_status(int i, EmscriptenGamepadEvent* e) { return em_gamepad_hook().status ? em_gamepad_hook().status(i, e) : 0; }
