#pragma once
// Host stand-in for emscripten::val: every value is null and every call does nothing
#include <string>
namespace emscripten {
struct val {
  static val null() { return val(); }
  static val global(const char* = nullptr) { return val(); }
  template<typename T> static val array(const T&) { return val(); }
  static val array() { return val(); }
  template<typename T> T as() const { return T(); }
  template<typename... A> val call(const char*, A...) const { return val(); }
  template<typename T> val operator[](T) const { return val(); }
  template<typename T> void set(const char*, T) {}
  bool isNull() const { return true; }
  bool isUndefined() const { return true; }
};
template<typename T> std::vector<T> vecFromJSArray(const val&) { return {}; }
}
