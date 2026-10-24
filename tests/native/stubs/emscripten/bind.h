#pragma once
// Host stand-in for the embind registration macros, which register nothing
#include <vector>
#include <emscripten/val.h>
namespace emscripten {
template<typename T> struct value_object { value_object(const char*) {} template<typename F> value_object& field(const char*, F) { return *this; } };
template<typename F> void function(const char*, F) {}
}
#define EMSCRIPTEN_BINDINGS(name) static void embind_init_##name()
