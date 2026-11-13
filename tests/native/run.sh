#!/usr/bin/env bash
# Builds every native test (tests/native/*_test.cpp) on the host with g++ and the address and undefined behaviour
# sanitizers, with the Emscripten 1.39 and Samsung headers replaced by the stubs in tests/native/stubs, and runs them.
# Each test includes the source file it tests (e.g. wasm/gamepad.cpp) directly. The C tests (tests/native/*_test.c)
# include C files of moonlight-common-c and libgamestream the same way and are built with gcc and the stubs in
# tests/native/stubs_c; a test that includes a file of moonlight-common-c gets the definitions that CMakeLists.txt gives
# that library (LC_CHROME, LC_LOG), so that it builds the library as the release does, e.g. with the log lines going to
# the listener of the app. A test that needs more options, a library or another source file names them in a comment line
# '// Build with: -lcrypto' (a C++ test e.g. '// Build with: -std=gnu++17' for a file with an EM_ASM block without
# arguments, whose stub needs the GNU form of __VA_ARGS__ as the syntax check below does); the tests are built from the
# root of the repository, so a source file there is named from it, e.g. moonlight-common-c/src/RtspParser.c. A test that
# includes OpenSSL or curl is skipped with a notice when their headers are missing, like the syntax check of
# wasm/http.cpp below.
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

# The definitions that CMakeLists.txt gives the moonlight-common-c target, for the C tests that include its files and
# for the syntax check of its files below. A test built with a definition that the release lacks can pass on code that
# the release doesn't have: rtsp_decrypt_error_test.c was built with -DLC_LOG while the release sent no log line of the
# library to the app.
# shellcheck disable=SC2207
common_c_defines=($(sed -n '/^target_compile_definitions(moonlight-common-c PUBLIC/,/)/p' "$repo/CMakeLists.txt" |
  sed -e 's/target_compile_definitions(moonlight-common-c PUBLIC//' -e 's/)//' | tr -s ' \n' '\n' | sed -e '/^$/d' -e 's/^/-D/'))
if [ "${#common_c_defines[@]}" -eq 0 ]; then
  echo "# The definitions of the moonlight-common-c target were not found in CMakeLists.txt"
  failed=1
fi
for source in "$here"/*_test.cpp; do
  name="$(basename "$source" .cpp)"
  # shellcheck disable=SC2207
  extra=($(sed -n 's|^// Build with: ||p' "$source"))
  echo "# Building $name"
  (cd "$repo" && "$cxx" "${flags[@]}" -o "$out/$name" "$source" ${extra[@]+"${extra[@]}"} -lpthread)
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
  defines=()
  if grep -q 'moonlight-common-c/' "$source"; then
    defines=(${common_c_defines[@]+"${common_c_defines[@]}"})
  fi
  echo "# Building $name${defines[*]+ (${defines[*]})}"
  # (the form of the expansion keeps an empty list working with 'set -u' in the bash 3.2 of macOS)
  (cd "$repo" && "$cc" "${cflags[@]}" ${defines[@]+"${defines[@]}"} -o "$out/$name" "$source" ${extra[@]+"${extra[@]}"} -lpthread)
  echo "# Running $name"
  if ! "$out/$name"; then
    echo "# $name failed"
    failed=1
  fi
done

# Build the Opus library from the files and definitions that CMakeLists.txt gives it (only the decoder: the app never
# encodes) into a static library, as the release build does, then link and run tests/native/opus_decoder/decode.c,
# which decodes with the functions of the app, and the C++ tests of that folder. A file that the decoder needs and the
# list leaves out fails the link.
opus_out="$out/opus"
rm -rf "$opus_out"
mkdir -p "$opus_out"
# shellcheck disable=SC2207
opus_sources=($(sed -n '/^add_library(opus STATIC/,/^)/p' "$repo/CMakeLists.txt" | grep -o 'opus/[A-Za-z0-9_/]*\.c'))
# shellcheck disable=SC2207
opus_defines=($(sed -n '/^target_compile_definitions(opus PUBLIC/,/)/p' "$repo/CMakeLists.txt" |
  sed -e 's/target_compile_definitions(opus PUBLIC//' -e 's/)//' | tr -s ' \n' '\n' | sed -e '/^$/d' -e 's/^/-D/'))
echo "# Building the Opus decoder from the ${#opus_sources[@]} files of CMakeLists.txt (${opus_defines[*]})"
for source in "${opus_sources[@]}"; do
  if ! "$cc" -std=gnu99 -O1 -w "${opus_defines[@]}" -I"$repo/opus/include" -I"$repo/opus/src" -I"$repo/opus/silk" \
      -I"$repo/opus/celt" -I"$repo/opus/silk/fixed" -c "$repo/$source" -o "$opus_out/$(echo "$source" | tr / _).o"; then
    echo "# $source doesn't compile"
    failed=1
  fi
done
ar rcs "$opus_out/libopus.a" "$opus_out"/*.o
echo "# Running opus_decoder/decode.c"
if ! "$cc" -std=gnu99 -O1 -I"$repo/opus/include" -o "$opus_out/decode" "$here/opus_decoder/decode.c" "$opus_out/libopus.a" -lm ||
    ! "$opus_out/decode"; then
  echo "# The Opus decoder of CMakeLists.txt doesn't link or decode"
  failed=1
fi

# The C++ tests that need this library instead of a stand-in (tests/native/opus_decoder/*_test.cpp), built like the
# tests above: opus_decoder/app_decoder_test.cpp runs the audio decoder of the app (wasm/auddec.cpp) with it, so that
# the leak check of the address sanitizer sees a decoder that the app doesn't destroy (the library itself is built
# without the sanitizers, which still follow its allocations).
for source in "$here"/opus_decoder/*_test.cpp; do
  [ -e "$source" ] || continue
  name="$(basename "$source" .cpp)"
  echo "# Building opus_decoder/$name"
  if ! (cd "$repo" && "$cxx" "${flags[@]}" -std=gnu++17 -o "$opus_out/$name" "$source" "$opus_out/libopus.a" -lm -lpthread); then
    echo "# opus_decoder/$name doesn't build"
    failed=1
    continue
  fi
  echo "# Running opus_decoder/$name"
  if ! "$opus_out/$name"; then
    echo "# opus_decoder/$name failed"
    failed=1
  fi
done

# The local patch of opus/celt/arch.h (tests/unit/vendored-opus-patch.test.js): the WebAssembly build, whose pointers
# are 32 bits wide as on a 32-bit CPU, takes the 64-bit multiplications of Opus, while a 32-bit target without
# Emscripten keeps the 32-bit fallback of upstream. The condition is taken out of the header and evaluated on its own,
# because the system headers of this machine can't be included for another target.
opus_fast_int64() {
  sed -n '/Set this if opus_int64 is a native type of the CPU/,/^#endif/p' "$repo/opus/celt/arch.h" |
    "$cc" -x c -E -dM -U__x86_64__ -U__LP64__ -U_WIN64 "$@" - | sed -n 's/^#define OPUS_FAST_INT64 //p'
}
echo "# Checking OPUS_FAST_INT64 of opus/celt/arch.h for WebAssembly, a 32-bit target and an LP64 target"
if [ "$(opus_fast_int64 -D__EMSCRIPTEN__)" != "1" ] || [ "$(opus_fast_int64)" != "0" ] ||
    [ "$(opus_fast_int64 -D__LP64__)" != "1" ]; then
  echo "# OPUS_FAST_INT64 of opus/celt/arch.h is not 1 for WebAssembly and LP64 and 0 for other 32-bit targets"
  failed=1
fi

# Compile every source file of the WebAssembly module without linking (-fsyntax-only), with the same stubs, so that an
# error that only the release build would see (e.g. a private member used outside its class) fails here: most of
# these files are in no test. wasm/http.cpp needs the headers of curl and OpenSSL and is checked when they exist.
syntax_flags=(-std=gnu++17 -fsyntax-only -DSAMSUNG_WRT -DOS_WASM -DNDEBUG
  -I"$here/stubs" -I"$repo/wasm" -I"$repo/wasm/dispatcher" -I"$repo/moonlight-common-c/src"
  -I"$repo/moonlight-common-c/enet/include" -I"$repo/moonlight-common-c/reedsolomon" -I"$repo/libgamestream"
  -I"$repo/opus/include")
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
  if ! "$cc" -std=gnu99 -fsyntax-only ${common_c_defines[@]+"${common_c_defines[@]}"} -I"$here/stubs_c" \
      -I"$repo/moonlight-common-c/src" -I"$repo/moonlight-common-c/enet/include" \
      -I"$repo/moonlight-common-c/reedsolomon" "$source"; then
    echo "# ${source#"$repo"/} doesn't compile"
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "# Native tests failed"
  exit 1
fi
echo "# All native tests passed (todo tests are known bugs)"
