'use strict';

// Checks that the checkers in tests/tools catch what they are meant to catch, so a broken checker can't let newer
// JavaScript, a split EM_ASM block or a broken link of the documents through unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const es2018 = require('../tools/check-es2018');
const emAsm = require('../tools/check-em-asm');
const markdownLinks = require('../tools/check-markdown-links');

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

// Write the Markdown files into a temporary folder ({ relative path: content }), run the link check on the first one and
// remove the folder again
function checkMarkdown(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-links-test-'));
  try {
    Object.keys(files).forEach((name) => {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), files[name]);
    });
    return markdownLinks.checkFile(path.join(dir, Object.keys(files)[0]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the link check derives the heading anchors of GitHub', () => {
  assert.equal(markdownLinks.headingSlug('3. Installation'), '3-installation');
  assert.equal(markdownLinks.headingSlug('15. Updating from the earlier release v1.19.0-s90c.1'), '15-updating-from-the-earlier-release-v1190-s90c1');
  assert.equal(markdownLinks.headingSlug('Host settings (Sunshine)'), 'host-settings-sunshine');
  assert.equal(markdownLinks.headingSlug('A.8 Dein Ziel: 4K60, beste Bildqualität'), 'a8-dein-ziel-4k60-beste-bildqualität');
  assert.equal(markdownLinks.headingSlug('The `fec_percentage` and [Sunshine](https://x.y) — notes'), 'the-fec_percentage-and-sunshine--notes');
  const anchors = markdownLinks.headingAnchors('# Notes\n## Notes\n```\n# Not a heading\n```\n<a id="custom"></a>\n');
  assert.deepEqual(Array.from(anchors).sort(), ['custom', 'notes', 'notes-1']);
});

test('the link check accepts existing files, folders and headings, and skips web addresses and code', () => {
  assert.deepEqual(checkMarkdown({
    'docs/GUIDE.md': [
      '# Guide',
      '## 1. Requirements',
      '[Requirements](#1-requirements), [Controllers](CONTROLLERS.md#buttons), [Folder](profiles), [Image](profiles/a.png "title")',
      '![Badge](https://img.shields.io/x) [Web](https://example.com/missing.md) [Mail](mailto:a@b.c)',
      '`[inline code](missing.md)`',
      '```',
      '[fenced code](missing.md)',
      '```',
      '<a href="CONTROLLERS.md"><img src="profiles/a.png"/></a>',
      '[ref]: CONTROLLERS.md',
    ].join('\n'),
    'docs/CONTROLLERS.md': '# Controllers\n## Buttons\n',
    'docs/profiles/a.png': 'png',
  }), []);
});

test('the link check reports missing files, images and headings', () => {
  const problems = checkMarkdown({
    'README.md': [
      '# Readme',
      '[Missing](docs/MISSING.md)',
      '![Missing image](docs/missing.png)',
      '[Missing heading](docs/GUIDE.md#9-nothing)',
      '[Missing local heading](#nothing)',
      '<img src="docs/also-missing.png">',
      '[ref]: docs/missing-ref.md',
    ].join('\n'),
    'docs/GUIDE.md': '# Guide\n## 1. Requirements\n',
  });
  assert.equal(problems.length, 6, problems.join('\n'));
  ['line 2:', 'line 3:', 'line 4:', 'line 5:', 'line 6:', 'line 7:'].forEach((prefix, i) => {
    assert.ok(problems[i].indexOf(prefix) === 0, problems.join('\n'));
  });
});

test('the documents of the repository have no broken local links', () => {
  const files = markdownLinks.defaultFiles();
  assert.ok(files.some((file) => file.endsWith(path.join('docs', 'GUIDE.md'))), 'docs/GUIDE.md is checked');
  files.forEach((file) => {
    assert.deepEqual(markdownLinks.checkFile(file), [], file);
  });
});
