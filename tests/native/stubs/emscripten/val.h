#pragma once
// Host stand-in for emscripten::val: every value is null and every call does nothing
#include <string>
#include <type_traits>
#include <vector>
namespace emscripten {
struct val {
  val() = default;
  template<typename T, typename = typename std::enable_if<!std::is_same<typename std::decay<T>::type, val>::value>::type>
  explicit val(T&&) {}
  static val object() { return val(); }
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
  bool operator==(const val&) const { return true; }
  bool operator!=(const val&) const { return false; }
};
template<typename T> std::vector<T> vecFromJSArray(const val&) { return {}; }
}
