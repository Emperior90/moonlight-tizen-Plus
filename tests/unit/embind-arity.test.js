'use strict';

// Checks the number of arguments of each function of the WebAssembly module (2.3.5): tests/lib/embind-arity.js reads
// them from the Embind bindings of wasm/*.cpp and the declarations of their C++ functions, and the stub of the module in
// the browser tests (browser/mocks/moonlight-wasm.js) throws like Embind on the TV when a call passes another number:
// - the table that the sources give today, which pins startStream at 34 arguments (a hard rule of the start request)
// - every bound function has a stand-in in the stub
// - the parser on small samples: templates with commas, emscripten::val, void, a signature over two lines, comments;
//   the forms of a binding that Embind takes (policies after the function, `function(` after `using namespace
//   emscripten`, a function of a namespace), and an error for one that it can't read, so that none is left out
// - the stub with the table: a call with 33 arguments of startStream throws Embind's BindingError, 34 pass, also for a
//   function that a test puts in later

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { REPO_ROOT } = require('../lib/dev-modules');
const { readEmbindArity, countParameters } = require('../lib/embind-arity');

const STUB = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'browser', 'mocks', 'moonlight-wasm.js'), 'utf8');

test('the functions of the module take the numbers of arguments of their C++ functions', () => {
  assert.deepEqual(readEmbindArity(REPO_ROOT), {
    makeCert: 0, httpInit: 3, openUrl: 4, sendKeyboardEvent: 3, sendText: 1,
    startStream: 34, stopStream: 0, cancelRequest: 0, toggleStats: 0, setStreamMenuOpen: 1, setStreamPageHidden: 1,
    toggleMouseEmulation: 0, requestIdrFrame: 0, getAudioChannelCount: 0, takeDiagnosticLog: 0, stun: 1, pair: 7,
    wakeOnLan: 3,
  });
});

test('the stub of the module has a stand-in for every function that the module binds', () => {
  Object.keys(readEmbindArity(REPO_ROOT)).forEach((name) => {
    assert.match(STUB, new RegExp('\\n  Module\\.' + name + ' = function\\('), name);
  });
});

test('the parser counts the parameters of C++ signatures', () => {
  assert.equal(countParameters(''), 0);
  assert.equal(countParameters(' void '), 0);
  assert.equal(countParameters('int a'), 1);
  assert.equal(countParameters('std::map<std::string, int> values, emscripten::val callback'), 2);
  assert.equal(countParameters('std::function<void(int, int)> done, const char* text'), 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-embind-'));
  try {
    fs.writeFileSync(path.join(dir, 'api.hpp'), [
      '// void twoLines(int commented);',
      'MessageResult twoLines(std::string first, int second,',
      '                       bool third);',
      'void none();',
      'std::pair<int, int> templated(std::vector<std::pair<int, int>> list, emscripten::val ppk);',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'bind.cpp'), [
      '/* emscripten::function("commented", &none); */',
      'static int defined(void) {',
      '  return 0;',
      '}',
      'EMSCRIPTEN_BINDINGS(sample) {',
      '  emscripten::function("twoLines", &twoLines);',
      '  emscripten::function("none", &none);',
      '  emscripten::function("templated", &templated);',
      '  emscripten::function("defined", &defined);',
      '}',
    ].join('\n'));
    assert.deepEqual(readEmbindArity(REPO_ROOT, dir), { twoLines: 3, none: 0, templated: 2, defined: 0 });
    // A bound function without a signature is an error, not a guess
    fs.appendFileSync(path.join(dir, 'bind.cpp'), '\nEMSCRIPTEN_BINDINGS(more) { emscripten::function("lost", &lost); }\n');
    assert.throws(() => readEmbindArity(REPO_ROOT, dir), /The signature of lost, which Embind binds as lost, was not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the parser reads every form of a binding that Embind takes, and stops at one that it cannot read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-embind-'));
  const write = (bindings) => fs.writeFileSync(path.join(dir, 'bind.cpp'), [
    '#include <emscripten/bind.h>',
    'using namespace emscripten;',
    'void one(int a);',
    'void two(int* a, int b);',
    'void three(int a, int b, int c);',
    'namespace ns {',
    'void four(int a, int b, int c, int d);',
    '}',
    'int ns::five(int a, int b, int c, int d, int e) {',
    '  return a;',
    '}',
    'struct Player { void play(int a); static int make(); };',
    'EMSCRIPTEN_BINDINGS(sample) {',
  ].concat(bindings, ['}']).join('\n'));
  try {
    write([
      '  emscripten::function("one", &one);',
      '  emscripten::function("two", &two, emscripten::allow_raw_pointers());',
      '  function("three", &three);',
      '  emscripten::function("four", &ns::four);',
      '  function("five", ns::five, allow_raw_pointers(), return_value_policy::reference());',
      // A method of a class_ and a std::function are no functions of the module, and a string is no binding
      '  class_<Player>("Player").function("play", &Player::play).class_function("make", &Player::make);',
      '  value_object<std::function<void(int)>>("function(x)");',
    ]);
    assert.deepEqual(readEmbindArity(REPO_ROOT, dir), { one: 1, two: 2, three: 3, four: 4, five: 5 });
    // A binding in another form is an error: it would leave the function unchecked in the stub
    [
      ['a lambda', '  function("lambda", optional_override([](int a) { return a; }));', /function\("lambda", optional_override\(.*\) at bind\.cpp:14 can't be read/],
      ['select_overload', '  emscripten::function("picked", select_overload<void(int)>(&one));', /function\("picked", select_overload<void\(int\)>\(&one\)\) at bind\.cpp:14 can't be read/],
      ['template arguments', '  emscripten::function<void, int>("typed", &one);', /The Embind binding at bind\.cpp:14 can't be read: function is not followed by its arguments/],
      ['a name that is no string', '  function(NAME, &one);', /function\(NAME, &one\) at bind\.cpp:14 can't be read/],
      ['an argument that is no policy', '  function("extra", &one, 5);', /function\("extra", &one, 5\) at bind\.cpp:14 can't be read/],
      ['a name bound twice', '  function("one", &one);\n  function("one", &two);', /one is bound twice by Embind \(bind\.cpp:14 and bind\.cpp:15\)/],
      ['a function of a namespace without a signature', '  function("six", &ns::six);', /The signature of ns::six, which Embind binds as six, was not found/],
    ].forEach(([name, binding, error]) => {
      write([binding]);
      assert.throws(() => readEmbindArity(REPO_ROOT, dir), error, name);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the stub of the module throws like Embind on a wrong number of arguments', () => {
  const errors = [];
  const context = {
    window: { __embindArity: readEmbindArity(REPO_ROOT), __tvMock: { config: { wasmStartMs: 1e9 } } },
    Module: { onRuntimeInitialized() {} },
    console: { error: (text) => errors.push(text) },
    setTimeout: () => 0,
    handleMessage: () => {},
    isFinite,
  };
  vm.createContext(context);
  vm.runInContext(STUB, context);
  const startArgs = (count) => Array.from({ length: count }, () => 0);
  // 33 arguments: the error of Embind, also on the console, where the harness of the browser tests sees it
  assert.throws(() => context.Module.startStream(...startArgs(33)), (error) => {
    assert.equal(error.name, 'BindingError');
    assert.equal(error.message, 'function startStream called with 33 arguments, expected 34 args!');
    return true;
  });
  assert.deepEqual(errors, ['BindingError: function startStream called with 33 arguments, expected 34 args!']);
  // 34 arguments: the stand-in answers
  assert.deepEqual({ ...context.Module.startStream(...startArgs(34)) }, { type: 'resolve', ret: null });
  assert.equal(context.window.__startStreamArgs.length, 34);
  // A function that a test puts in later is checked as well, and one that it read before keeps its own check
  const before = context.Module.setStreamMenuOpen;
  context.Module.setStreamMenuOpen = function(open) {
    return before.call(this, open) === undefined ? 'replaced ' + open : 'unexpected';
  };
  assert.equal(context.Module.setStreamMenuOpen(true), 'replaced true');
  assert.throws(() => context.Module.setStreamMenuOpen(), /function setStreamMenuOpen called with 0 arguments, expected 1 args!/);
  assert.throws(() => context.Module.setStreamMenuOpen(true, false), /called with 2 arguments, expected 1 args!/);
  // Without the table (outside the harness), the stub takes any call as before
  const plain = { window: { __tvMock: { config: { wasmStartMs: 1e9 } } }, Module: {}, console, setTimeout: () => 0, handleMessage: () => {}, isFinite };
  vm.createContext(plain);
  vm.runInContext(STUB, plain);
  assert.deepEqual({ ...plain.Module.stopStream('extra') }, { type: 'resolve', ret: null });
});

test('a binding that the stub lacks stops it at its start', () => {
  const arity = Object.assign({}, readEmbindArity(REPO_ROOT), { newFunction: 2 });
  const context = { window: { __embindArity: arity, __tvMock: { config: { wasmStartMs: 1e9 } } }, Module: {}, console, setTimeout: () => 0, handleMessage: () => {}, isFinite };
  vm.createContext(context);
  assert.throws(() => vm.runInContext(STUB, context), /The stub of the module has no function newFunction, which the module binds/);
});
