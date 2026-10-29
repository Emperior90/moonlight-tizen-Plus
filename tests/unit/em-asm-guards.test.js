'use strict';

// Checks that no JavaScript exception can leave the main thread of the WebAssembly module unable to answer its native
// threads. The code of a MAIN_THREAD_EM_ASM block runs on the main thread for a native thread, which waits for it (or,
// for MAIN_THREAD_ASYNC_EM_ASM, queues it). An exception that left the block would never tell the waiting thread that
// the call is done, and Emscripten 1.39 then stops running proxied calls on the main thread at all, which froze the
// whole app during a stream (see PostToJs() in wasm/main.cpp). So every such block of wasm/ must be one try statement
// with a catch, and running it with handlers that throw must neither throw nor stay silent: it logs the error and, for
// the blocks that return a value, returns the value of a failed call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { REPO_ROOT, requireDevModule } = require('../lib/dev-modules');
const { findBlocks } = require('../tools/check-em-asm');

const acorn = requireDevModule('acorn');

// Every block of wasm/ whose code runs on the main thread for another thread
function mainThreadBlocks() {
  const blocks = [];
  fs.readdirSync(path.join(REPO_ROOT, 'wasm')).filter((name) => /\.(cpp|hpp|c|h)$/.test(name)).sort().forEach((name) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'wasm', name), 'utf8');
    findBlocks(source).filter((block) => block.macro.indexOf('MAIN_THREAD_') === 0).forEach((block) => {
      blocks.push(Object.assign({ file: name }, block));
    });
  });
  return blocks;
}

// The code of a block as the body of the function that Emscripten makes of it, with the arguments $0 to $9
const PARAMETERS = ['$0', '$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9'];
function functionSource(block) {
  return 'function block(' + PARAMETERS.join(', ') + ') ' + block.code;
}

test('the main-thread EM_ASM blocks are all found', () => {
  const blocks = mainThreadBlocks();
  const count = (file) => blocks.filter((block) => block.file === file).length;
  // PostToJs, PostToJsAsync and the two PostPromiseMessage; the audio frames, the jitter buffer and the end of the
  // audio scheduler; the gamepad slots and the rumble check
  assert.equal(count('main.cpp'), 4);
  assert.equal(count('auddec.cpp'), 3);
  assert.equal(count('gamepad.cpp'), 2);
});

test('every main-thread EM_ASM block is one try statement with a catch', () => {
  for (const block of mainThreadBlocks()) {
    const where = block.file + ':' + block.line;
    const program = acorn.parse(functionSource(block), { ecmaVersion: 2018 });
    const body = program.body[0].body.body;
    assert.equal(body.length, 1, where + ' must consist of a single try statement');
    assert.equal(body[0].type, 'TryStatement', where + ' must consist of a single try statement');
    assert.ok(body[0].handler, where + ' must catch the exception');
  }
});

// Run a block on a simulated main thread whose handlers all throw, and return what it returned and logged
function runWithThrowingHandlers(block) {
  const fail = (name) => function() {
    throw new Error(name + ' failed');
  };
  const errors = [];
  const window = {};
  Object.defineProperty(window, '_mlAudioTargetMs', { set: fail('setting _mlAudioTargetMs') });
  const context = vm.createContext({
    console: { error: (...args) => errors.push(args.map(String).join(' ')), log() {}, warn() {} },
    window,
    navigator: { getGamepads: fail('navigator.getGamepads') },
    UTF8ToString: fail('UTF8ToString'),
    HEAPU8: { slice: fail('HEAPU8.slice') },
    HEAP32: new Int32Array(16),
    _free() {},
    handleMessage: fail('handleMessage'),
    handlePromiseMessage: fail('handlePromiseMessage'),
    _audReceiveFrame: fail('_audReceiveFrame'),
    stopAudioScheduler: fail('stopAudioScheduler'),
    __fillGamepadEventData: fail('__fillGamepadEventData'),
  });
  const run = vm.runInContext('(' + functionSource(block) + ')', context);
  let result;
  assert.doesNotThrow(() => {
    result = run(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
  }, block.file + ':' + block.line + ' let an exception escape');
  return { result, errors };
}

test('an exception of a handler is logged and doesn\'t leave the block', () => {
  for (const block of mainThreadBlocks()) {
    const where = block.file + ':' + block.line;
    const { result, errors } = runWithThrowingHandlers(block);
    assert.equal(errors.length, 1, where + ' must log the error once');
    assert.match(errors[0], /failed/, where);
    if (block.macro === 'MAIN_THREAD_EM_ASM_INT') {
      // The gamepad slots count as a failed read that the block logged itself (-3, kGamepadReadException of
      // gamepad.cpp, which doesn't log it again), the rumble check as no rumble
      const expected = block.code.indexOf('__fillGamepadEventData') >= 0 ? -3 : 0;
      assert.equal(Number(result), expected, where + ' returns the value of a failed call');
    }
  }
});

test('the poll of gamepad.cpp knows the result of a read that threw, which it doesn\'t log again', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'gamepad.cpp'), 'utf8');
  assert.match(source, /static const int kGamepadReadException = -3;/);
  assert.match(source, /if \(count == kGamepadReadException\) \{\n\s*return -1;\n/);
});

test('the errors of the calls every 5 ms are logged the first and every 1000th time', () => {
  for (const block of mainThreadBlocks().filter((entry) => /_audReceiveFrame\(|__fillGamepadEventData\(/.test(entry.code))) {
    const where = block.file + ':' + block.line;
    const errors = [];
    const fail = () => {
      throw new Error('handler failed');
    };
    const context = vm.createContext({
      console: { error: (...args) => errors.push(args.map(String).join(' ')) },
      navigator: { getGamepads: fail },
      _audReceiveFrame: fail,
      __fillGamepadEventData: fail,
      HEAP32: new Int32Array(16),
    });
    vm.runInContext('var window = this;', context);
    const run = vm.runInContext('(' + functionSource(block) + ')', context);
    for (let i = 0; i < 2001; i++) {
      run(1, 2, 3, 4, 5, 6, 7);
    }
    assert.equal(errors.length, 3, where);
    assert.match(errors[2], /2001 times/, where);
  }
});
