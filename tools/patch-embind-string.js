'use strict';

// Patches the generated moonlight-wasm.js so that a std::string that C++ returns to JavaScript is read without
// writing to the heap. The code that Embind generates for it (fromWireType of std::string) writes a zero into the byte
// after the string and puts the old byte back when it is done, because the buffer that C++ made (malloc of 4 + length,
// no terminator) has no zero at the end. That byte is outside of the buffer, and nothing holds the lock of the
// allocator while it is written: when the length of the string is a multiple of 8, it is the lowest byte of the head
// of the next chunk of the heap, so a malloc or free of another thread that changes that head in between has its
// change overwritten by the old byte. The heap is then damaged, and the next free that looks at the head can crash or
// hang with the lock of the allocator taken, which freezes the whole app. Every std::string that the module posts to
// JavaScript (messages, HTTP responses, the performance stats) goes through this code while up to 20 threads
// (PTHREAD_POOL_SIZE in CMakeLists.txt) use the same heap. UTF8ToString of this Emscripten takes the number of bytes to
// read, so the terminator is not needed.
//
// Ported from the fork of fidoboy (https://github.com/fidoboy/moonlight-tizen-ac3, tools/patch-embind-string.js,
// GPL-3.0 like this project), whose fix is based on a patch by mmadej20 (https://github.com/mmadej20). Changes: plain
// log lines, and a check of the written file.
//
// Usage: node tools/patch-embind-string.js <moonlight-wasm.js>
// The Dockerfile runs it with the Node 12 of the Emscripten SDK right after `cmake --install`, so it sticks to the
// syntax of Node 12. It exits with an error, which fails the build, unless it finds the code it replaces exactly once.

const fs = require('fs');

// fromWireType of std::string (UTF-8) in the output of the Samsung Emscripten 1.39.4.7, as the generated file has it
// (whitespace removed at -O2, names kept)
const ORIGINAL =
  'var endChar=HEAPU8[value+4+length];var endCharSwap=0;if(endChar!=0){endCharSwap=endChar;HEAPU8[value+4+length]=0}' +
  'var decodeStartPtr=value+4;for(var i=0;i<=length;++i){var currentBytePtr=value+4+i;if(HEAPU8[currentBytePtr]==0){' +
  'var stringSegment=UTF8ToString(decodeStartPtr);if(str===undefined)str=stringSegment;else{str+=String.fromCharCode(0);' +
  'str+=stringSegment}decodeStartPtr=currentBytePtr+1}}if(endCharSwap!=0)HEAPU8[value+4+length]=endCharSwap}';

// The segments end at a zero byte inside the string and at its length; the byte after the string is neither read nor
// written
const PATCHED =
  'var decodeStartPtr=value+4;for(var i=0;i<=length;++i){var currentBytePtr=value+4+i;if(i==length||HEAPU8[currentBytePtr]==0){' +
  'var stringSegment=UTF8ToString(decodeStartPtr,currentBytePtr-decodeStartPtr);if(str===undefined)str=stringSegment;else{' +
  'str+=String.fromCharCode(0);str+=stringSegment}decodeStartPtr=currentBytePtr+1}}}';

// Count the non-overlapping occurrences of a text in the source
function occurrences(source, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) {
      return count;
    }
    count++;
    from = at + needle.length;
  }
}

// Return the source with the original code replaced, or throw unless the original code occurs exactly once
function patchEmbindString(source) {
  const found = occurrences(source, ORIGINAL);
  if (found !== 1) {
    throw new Error('the reading of a std::string was found ' + found + ' times, expected exactly once' +
      (occurrences(source, PATCHED) > 0 ? ' (the file may already be patched)' : ' (did the Emscripten SDK change?)'));
  }
  // A function as the replacement, so that '$' in the patched code is never read as a pattern
  return source.replace(ORIGINAL, function() {
    return PATCHED;
  });
}

// Patch the file in place and read it back: the original code must be gone and the patched code there exactly once
function patchFile(file) {
  fs.writeFileSync(file, patchEmbindString(fs.readFileSync(file, 'utf8')));
  const written = fs.readFileSync(file, 'utf8');
  if (occurrences(written, ORIGINAL) !== 0 || occurrences(written, PATCHED) !== 1) {
    throw new Error('the patched file does not contain the patched code exactly once');
  }
}

module.exports = { ORIGINAL, PATCHED, patchEmbindString, patchFile };

// Run as a command-line script, but allow the tests to import it without touching a file
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('patch-embind-string: Usage: node tools/patch-embind-string.js <moonlight-wasm.js>');
    process.exit(2);
  }
  try {
    patchFile(file);
    console.log('patch-embind-string: Patched the reading of std::string in ' + file);
  } catch (error) {
    console.error('patch-embind-string: Error: unable to patch ' + file + ': ' + error.message);
    process.exit(1);
  }
}
