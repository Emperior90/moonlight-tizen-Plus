#!/usr/bin/env bash
# Builds every native test (tests/native/*_test.cpp) on the host with g++ and the address and undefined behaviour
# sanitizers, with the Emscripten 1.39 and Samsung headers replaced by the stubs in tests/native/stubs, and runs them.
# Each test includes the source file it tests (e.g. wasm/gamepad.cpp) directly. The C tests (tests/native/*_test.c)
# include C files of moonlight-common-c and libgamestream the same way and are built with gcc and the stubs in
# tests/native/stubs_c. A test that needs more options or a library names them in a comment line
# '// Build with: -lcrypto'; a test that includes OpenSSL or curl is skipped with a notice when their headers are
# missing, like the syntax check of wasm/http.cpp below.
# The executables go to tests/native/build. Set CXX and CC to use other compilers.
#
# The vptr check of UBSan is off, because the tests call member functions of MoonlightInstance, whose virtual
# functions and type information are defined in files the tests don't build (wasm/main.cpp).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/build"
cxx="${CXX:-g++}"
cc="${CC:-gcc}"
mkdir -p "$out"

flags=(
  -std=c++17 -g -O1 -fno-omit-frame-pointer
  -fsanitize=address,undefined -fno-sanitize=vptr -fno-sanitize-recover=all
  -I"$here/stubs" -I"$repo/wasm" -I"$repo/wasm/dispatcher" -I"$repo/moonlight-common-c/src" -I"$repo/opus/include"
  -I"$repo/h264bitstream"
)
cflags=(
  -std=gnu99 -g -O1 -fno-omit-frame-pointer
  -fsanitize=address,undefined -fno-sanitize-recover=all
  -I"$here/stubs_c" -I"$repo/moonlight-common-c/src" -I"$repo/moonlight-common-c/enet/include"
  -I"$repo/moonlight-common-c/reedsolomon"
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

have_header() {
  printf '#include <%s>\n' "$1" | "$cc" -x c -fsyntax-only - 2>/dev/null
}

for source in "$here"/*_test.c; do
  [ -e "$source" ] || continue
  name="$(basename "$source" .c)"
  if grep -q '#include <openssl/' "$source" && ! have_header openssl/ssl.h; then
    echo "# Skipped $name: the headers of OpenSSL are missing"
    continue
  fi
  if grep -q '#include <curl/' "$source" && ! have_header curl/curl.h; then
    echo "# Skipped $name: the headers of curl are missing"
    continue
  fi
  # shellcheck disable=SC2207
  extra=($(sed -n 's|^// Build with: ||p' "$source"))
  echo "# Building $name"
  # (the form of the expansion keeps an empty list working with 'set -u' in the bash 3.2 of macOS)
  "$cc" "${cflags[@]}" -o "$out/$name" "$source" ${extra[@]+"${extra[@]}"} -lpthread
  echo "# Running $name"
  if ! "$out/$name"; then
    echo "# $name failed"
    failed=1
  fi
done

# Compile every source file of the WebAssembly module without linking (-fsyntax-only), with the same stubs, so that an
# error that only the release build would see (e.g. a private member used outside its class) fails here: most of
# these files are in no test. wasm/http.cpp needs the headers of curl and OpenSSL and is checked when they exist.
syntax_flags=(-std=gnu++17 -fsyntax-only -DSAMSUNG_WRT -DOS_WASM -DNDEBUG
  -I"$here/stubs" -I"$repo/wasm" -I"$repo/wasm/dispatcher" -I"$repo/moonlight-common-c/src"
  -I"$repo/moonlight-common-c/enet/include" -I"$repo/moonlight-common-c/reedsolomon" -I"$repo/libgamestream"
  -I"$repo/h264bitstream" -I"$repo/opus/include")
for source in "$repo"/wasm/*.cpp; do
  name="$(basename "$source")"
  if [ "$name" = "http.cpp" ] && ! printf '#include <curl/curl.h>\n#include <openssl/ssl.h>\n' |
      "$cxx" -x c++ -fsyntax-only - 2>/dev/null; then
    echo "# Skipped the syntax check of wasm/$name: the headers of curl or OpenSSL are missing"
    continue
  fi
  echo "# Checking the syntax of wasm/$name"
  if ! "$cxx" "${syntax_flags[@]}" "$source"; then
    echo "# wasm/$name doesn't compile"
    failed=1
  fi
done
for source in "$repo"/wasm/*.c "$repo"/moonlight-common-c/src/*.c; do
  echo "# Checking the syntax of ${source#"$repo"/}"
  if ! "$cc" -std=gnu99 -fsyntax-only -I"$here/stubs_c" -I"$repo/moonlight-common-c/src" \
      -I"$repo/moonlight-common-c/enet/include" -I"$repo/moonlight-common-c/reedsolomon" "$source"; then
    echo "# ${source#"$repo"/} doesn't compile"
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "# Native tests failed"
  exit 1
fi
echo "# All native tests passed (todo tests are known bugs)"
