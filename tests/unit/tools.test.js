'use strict';

// Checks that the checkers in tests/tools catch what they are meant to catch, so a broken checker can't let newer
// JavaScript or a split EM_ASM block through unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const es2018 = require('../tools/check-es2018');
const emAsm = require('../tools/check-em-asm');

// Write the source into a temporary file, run the check on it and remove the file again
function checkSource(name, source, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-tools-test-'));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, source);
    return check(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const loaded = es2018.loadAcorn();
const acornMissing = loaded ? false : 'acorn is not installed (run npm ci --prefix tests); the check itself falls back to the copy bundled with Node';
const checkScript = (source) => checkSource('sample.js', source, (file) => es2018.checkFile(loaded.acorn, file));

test('the ES2018 check accepts ES2018 code', { skip: acornMissing }, () => {
  assert.deepEqual(checkScript([
    'async function load(options) {',
    '  const { url, ...rest } = options;',
    '  const merged = { ...rest, url };',
    '  for await (const part of []) {}',
    '  return /(?<year>\\d{4})/s.test(await fetch(url)) && Object.entries(merged).flat();',
    '}',
    'Promise.resolve().finally(() => {});',
  ].join('\n')), []);
});

test('the ES2018 check rejects newer syntax', { skip: acornMissing }, () => {
  for (const source of ['var a = b?.c;', 'var a = b ?? c;', 'class A { x = 1; }', 'try { f(); } catch { }', 'var big = 1n;', 'var a = 1_000;']) {
    assert.equal(checkScript(source).length, 1, source);
  }
});

test('the ES2018 check reports newer built-ins, but not same-named properties', { skip: acornMissing }, () => {
  const problems = checkScript([
    'var o = Object.fromEntries([]);',
    'var s = "a".replaceAll("a", "b");',
    'var last = [1].at(-1);',
    'var g = globalThis;',
    'Promise.allSettled([]);',
  ].join('\n'));
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.deepEqual(checkScript('var p = { globalThis: 1, at: 2 }; var q = p.globalThis + p.at;'), []);
});

test('the EM_ASM check accepts commas inside parentheses, literals and comments', () => {
  const source = [
    'void f() {',
    '  MAIN_THREAD_EM_ASM({',
    '    var s = "a, b"; var c = \'x, y\';',
    '    handle(UTF8ToString($0), $1); // a comment, with a comma',
    '    /* another, comment */',
    '  }, text, length);',
    '  EM_ASM(Module[\'noExitRuntime\'] = true);',
    '}',
  ].join('\n');
  assert.deepEqual(checkSource('good.cpp', source, emAsm.checkFile), []);
});

test('the EM_ASM check reports a comma outside parentheses in a code block', () => {
  const source = [
    'void f() {',
    '  EM_ASM({',
    '    var a = 1, b = 2;',
    '  });',
    '  const int n = EM_ASM_INT({',
    '    return [1, 2].length;',
    '  });',
    '}',
  ].join('\n');
  const problems = checkSource('bad.cpp', source, emAsm.checkFile);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.ok(problems[0].indexOf('line 2:') === 0 && problems[1].indexOf('line 5:') === 0, problems.join('\n'));
});
