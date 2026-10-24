#!/usr/bin/env bash
# Builds every native test (tests/native/*_test.cpp) on the host with g++ and the address and undefined behaviour
# sanitizers, with the Emscripten 1.39 and Samsung headers replaced by the stubs in tests/native/stubs, and runs them.
# Each test includes the source file it tests (e.g. wasm/gamepad.cpp) directly. The executables go to
# tests/native/build. Set CXX to use another compiler.
#
# The vptr check of UBSan is off, because the tests call member functions of MoonlightInstance, whose virtual
# functions and type information are defined in files the tests don't build (wasm/main.cpp).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/build"
cxx="${CXX:-g++}"
mkdir -p "$out"

flags=(
  -std=c++17 -g -O1 -fno-omit-frame-pointer
  -fsanitize=address,undefined -fno-sanitize=vptr -fno-sanitize-recover=all
  -I"$here/stubs" -I"$repo/wasm" -I"$repo/wasm/dispatcher" -I"$repo/moonlight-common-c/src" -I"$repo/opus/include"
)
export ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=1:abort_on_error=1}"
export UBSAN_OPTIONS="${UBSAN_OPTIONS:-print_stacktrace=1}"

failed=0
for source in "$here"/*_test.cpp; do
  name="$(basename "$source" .cpp)"
  echo "# Building $name"
  "$cxx" "${flags[@]}" -o "$out/$name" "$source" -lpthread
  echo "# Running $name"
  if ! "$out/$name"; then
    echo "# $name failed"
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "# Native tests failed"
  exit 1
fi
echo "# All native tests passed (todo tests are known bugs)"
