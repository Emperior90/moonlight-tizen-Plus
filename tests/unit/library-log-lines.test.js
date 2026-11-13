'use strict';

// Pins the texts and the build settings that bring the log lines of moonlight-common-c into the diagnostic log, where
// two files have to agree and no native test can see both:
//  - ClLibraryLogMessage() of wasm/connectionlistener.cpp keeps the two messages of each stage of a start and of a stop
//    ("Starting video stream..." without a line break, then "done") without the limit by kind of the other lines. It
//    knows them by their text, so the test checks that Connection.c still logs its stages this way and that no other
//    line of the library looks like one: a line that comes once per packet or frame must never pass as a stage.
//  - The release build and the native tests take LC_LOG, which sends Limelog() to the listener, from the same place
//    (the moonlight-common-c target of CMakeLists.txt). A test with a definition of its own had hidden for several
//    versions that the release sent no line of the library to the app.
// The behaviour itself is run by the native tests: limelog_test.c (the macro, built like the release),
// connection_interrupt_test.cpp (the listener) and diagnostic_log_test.cpp (the limit by kind).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const LIBRARY = 'moonlight-common-c/src';

// The format of every Limelog() call of the library: the string literals that follow the opening parenthesis, joined,
// with the escapes of C still in them (a line break is the two characters \n)
function limelogFormats() {
  const formats = [];
  fs.readdirSync(path.join(REPO_ROOT, LIBRARY)).filter((name) => /\.c$/.test(name)).sort().forEach((name) => {
    const source = read(LIBRARY + '/' + name);
    const call = /\bLimelog\s*\(/g;
    let match;
    while ((match = call.exec(source)) !== null) {
      let rest = source.slice(match.index + match[0].length);
      // (a comment that names Limelog() is no call)
      if (rest.charAt(0) === ')') {
        continue;
      }
      let format = '';
      let literals = 0;
      let literal;
      while ((literal = /^(?:\s|\\\n)*"((?:\\.|[^"\\])*)"/.exec(rest)) !== null) {
        format += literal[1];
        literals++;
        rest = rest.slice(literal[0].length);
      }
      formats.push({ file: name, format: format, literal: literals > 0 });
    }
  });
  return formats;
}

test('Connection.c logs each stage as "<stage>..." and "done", and no other line of the library looks like one', () => {
  const formats = limelogFormats();
  // Every call has a string literal as its format (a format from a variable could hold any text)
  assert.ok(formats.length > 250, 'the Limelog() calls of the library were found');
  assert.deepEqual(formats.filter((entry) => !entry.literal), []);

  // The first message of a stage ends with three dots and has no line break; only Connection.c logs such messages
  const firstParts = formats.filter((entry) => /\.\.\.$/.test(entry.format));
  assert.equal(firstParts.length, 20, 'eleven stages of a start and nine of a stop');
  assert.deepEqual(firstParts.filter((entry) => entry.file !== 'Connection.c'), []);
  firstParts.forEach((entry) => {
    assert.match(entry.format, /^(Initializing|Resolving|Starting|Stopping|Cleaning up) [a-zA-Z ]+\.\.\.$/);
  });
  // The second one is "done" with a line break, once per stage, and nowhere else in the library
  const done = formats.filter((entry) => entry.format === 'done\\n');
  assert.equal(done.length, 20);
  assert.deepEqual(done.filter((entry) => entry.file !== 'Connection.c'), []);
  // In Connection.c each stage is followed by its "done" before the next stage begins
  const order = formats.filter((entry) => entry.file === 'Connection.c' &&
    (/\.\.\.$/.test(entry.format) || entry.format === 'done\\n')).map((entry) => (entry.format === 'done\\n' ? 'd' : 's'));
  assert.equal(order.join(''), 'sd'.repeat(20));

  // The listener knows the two by exactly these texts
  const listener = read('wasm/connectionlistener.cpp');
  assert.match(listener, /static bool IsLibraryStageMessage\(const char\* message\) \{\s+const size_t length = std::strlen\(message\);\s+return std::strcmp\(message, "done\\n"\) == 0 \|\| \(length >= 3 && std::strcmp\(message \+ length - 3, "\.\.\."\) == 0\);\s+\}/);
  // and limits every other line of the library by its kind
  assert.match(listener, /if \(IsLibraryStageMessage\(message\)\) \{\s+GetDiagnosticLog\(\)\.TryAppend\(DiagnosticLogNowMs\(\), message\);\s+\} else \{\s+GetDiagnosticLog\(\)\.TryAppendLimited\(DiagnosticLogNowMs\(\), message\);\s+\}/);
});

test('the release and the native tests take LC_LOG from the same place, the library target of CMakeLists.txt', () => {
  const definitions = /target_compile_definitions\(moonlight-common-c PUBLIC([^)]*)\)/.exec(read('CMakeLists.txt'));
  assert.ok(definitions);
  assert.deepEqual(definitions[1].trim().split(/\s+/), ['LC_CHROME', 'LC_LOG']);
  // run.sh reads that list for the C tests that include a file of the library and for the syntax check of its files
  const run = read('tests/native/run.sh');
  assert.match(run, /common_c_defines=\(\$\(sed -n '\/\^target_compile_definitions\(moonlight-common-c PUBLIC\/,\/\)\/p' "\$repo\/CMakeLists\.txt"/);
  assert.match(run, /if grep -q 'moonlight-common-c\/' "\$source"; then\s+defines=\(\$\{common_c_defines\[@\]\+"\$\{common_c_defines\[@\]\}"\}\)/);
  assert.match(run, /-fsyntax-only \$\{common_c_defines\[@\]\+"\$\{common_c_defines\[@\]\}"\}/);
  // and no test or build file defines a switch of the library on its own (outside the comments of run.sh)
  const native = path.join(REPO_ROOT, 'tests/native');
  fs.readdirSync(native).filter((name) => /\.(c|cpp|h)$/.test(name)).forEach((name) => {
    const source = fs.readFileSync(path.join(native, name), 'utf8');
    assert.doesNotMatch(source, /-D\s*LC_[A-Z]+|#\s*define\s+LC_[A-Z]+/, name);
  });
  assert.doesNotMatch(run.replace(/^\s*#.*$/gm, ''), /LC_[A-Z]+/);
  assert.doesNotMatch(read('Dockerfile'), /LC_LOG|LC_CHROME/);
  // A C test that includes a file of the library which logs provides the listener, as Connection.c does in the app
  fs.readdirSync(native).filter((name) => /_test\.c$/.test(name)).forEach((name) => {
    const source = fs.readFileSync(path.join(native, name), 'utf8');
    const included = /#include "\.\.\/\.\.\/moonlight-common-c\/src\/([A-Za-z]+\.c)"/g;
    let match;
    let logs = false;
    while ((match = included.exec(source)) !== null) {
      logs = logs || /\bLimelog\s*\(/.test(read(LIBRARY + '/' + match[1]));
    }
    if (logs) {
      assert.match(source, /^CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;$/m, name);
    }
  });
});

test('Limelog() hands the listener the line as the argument of "%s", and the app registers the listener that keeps it', () => {
  const header = read(LIBRARY + '/Platform.h');
  const branch = /#ifdef LC_LOG\n([\s\S]*?)#else\n/.exec(header);
  assert.ok(branch, 'the LC_LOG branch of Platform.h');
  assert.match(branch[1], /snprintf\(limelogLine_, sizeof\(limelogLine_\), format, ##__VA_ARGS__\); \\\n\s+ListenerCallbacks\.logMessage\("%s", limelogLine_\); \\/);
  // Without a listener the line still goes to the console
  assert.match(branch[1], /else if \(EM_LOG_CONSOLE\) \{ \\\n\s+emscripten_log\(EM_LOG_CONSOLE, format, ##__VA_ARGS__\); \\/);
  // No call of the library passes something named like the buffer of the macro
  fs.readdirSync(path.join(REPO_ROOT, LIBRARY)).filter((name) => /\.[ch]$/.test(name) && name !== 'Platform.h').forEach((name) => {
    assert.doesNotMatch(read(LIBRARY + '/' + name), /\blimelogLine_\b/, name);
  });
  const listener = read('wasm/connectionlistener.cpp');
  assert.match(listener, /\.logMessage = MoonlightInstance::ClLibraryLogMessage,/);
  assert.match(read('wasm/moonlight_wasm.hpp'), /static void ClLibraryLogMessage\(const char\* format, \.\.\.\);/);
});
