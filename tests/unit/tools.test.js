'use strict';

// Checks that the checkers in tests/tools catch what they are meant to catch, so a broken checker can't let newer
// JavaScript, a split EM_ASM block, a broken link of the documents or a broken translation through unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const es2018 = require('../tools/check-es2018');
const emAsm = require('../tools/check-em-asm');
const markdownLinks = require('../tools/check-markdown-links');
const i18nCheck = require('../tools/i18n-check');

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

test('the EM_ASM blocks are listed with their macro, line and code, without the macro definitions', () => {
  const source = [
    '#define MAIN_THREAD_EM_ASM(code, ...) emscripten_asm_const_int_sync_on_main_thread(#code)',
    'void f(const char* text) {',
    '  MAIN_THREAD_EM_ASM({',
    '    try {',
    '      handleMessage(UTF8ToString($0)); // a comment, with a comma',
    '    } catch (e) {',
    '    }',
    '  }, text);',
    '  const int n = EM_ASM_INT({ return 1; });',
    '}',
  ].join('\n');
  const blocks = emAsm.findBlocks(source);
  assert.deepEqual(blocks.map((block) => [block.macro, block.line]), [['MAIN_THREAD_EM_ASM', 3], ['EM_ASM_INT', 9]]);
  assert.ok(blocks[0].code.indexOf('{\n    try {') === 0 && /\}\n {2}\}$/.test(blocks[0].code), blocks[0].code);
  assert.equal(blocks[1].code, '{ return 1; }');
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

test('the link check follows links to the default branch of this fork into the repository, with their headings', () => {
  assert.equal(markdownLinks.localTarget('https://github.com/Emperior90/moonlight-tizen-Plus/blob/HEAD/docs/GUIDE.md#troubleshooting'), '/docs/GUIDE.md#troubleshooting');
  assert.equal(markdownLinks.localTarget('https://github.com/Emperior90/moonlight-tizen-Plus/tree/HEAD/docs'), '/docs');
  // A tag, a branch or the issue tracker is not a file of the default branch
  ['https://github.com/Emperior90/moonlight-tizen-Plus/tree/v1.19.0-s90c.1/docs', 'https://github.com/Emperior90/moonlight-tizen-Plus/issues',
    'https://github.com/brightcraft/moonlight-tizen/blob/HEAD/docs/GUIDE.md'].forEach((target) => {
    assert.equal(markdownLinks.localTarget(target), target);
  });
  const problems = checkMarkdown({
    'form.yml': [
      'value: |',
      '  See the [guide](https://github.com/Emperior90/moonlight-tizen-Plus/blob/HEAD/docs/GUIDE.md#no-such-heading).',
      '  And the [controllers](https://github.com/Emperior90/moonlight-tizen-Plus/blob/HEAD/docs/CONTROLLERS.md).',
      '  And a [missing page](https://github.com/Emperior90/moonlight-tizen-Plus/blob/HEAD/docs/MISSING.md).',
    ].join('\n'),
  });
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.ok(problems[0].indexOf('line 2: \'https://github.com/Emperior90/moonlight-tizen-Plus/blob/HEAD/docs/GUIDE.md#no-such-heading\' names the heading #no-such-heading') === 0, problems[0]);
  assert.ok(problems[1].indexOf('line 4:') === 0 && problems[1].indexOf('docs/MISSING.md, which doesn\'t exist') > 0, problems[1]);
});

test('the documents of the repository have no broken local links', () => {
  const files = markdownLinks.defaultFiles();
  ['docs/GUIDE.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/CONTRIBUTING.md', 'tests/README.md', 'SECURITY.md'].forEach((name) => {
    assert.ok(files.some((file) => file.endsWith(path.join(...name.split('/')))), name + ' is checked');
  });
  files.forEach((file) => {
    assert.deepEqual(markdownLinks.checkFile(file), [], file);
  });
});

// A small source locale and a German translation of it for the checks of tests/tools/i18n-check.js
const ENGLISH = {
  'Settings': 'Settings',
  'HEVC': 'HEVC',
  'Connecting to %1$s...': 'Connecting to %1$s...',
  'Line one<br><br>Line two': 'Line one<br><br>Line two',
  'Slow connection.\nReduce your bitrate!': 'Slow connection.\nReduce your bitrate!',
  '- Help text of a setting.': '- Help text of a setting.',
  '— Stop the stream.': '— Stop the stream.',
  ' (Running)': ' (Running)',
};
const GERMAN = {
  'Settings': 'Einstellungen',
  'HEVC': 'HEVC',
  'Connecting to %1$s...': 'Verbinde mit %1$s …',
  'Line one<br><br>Line two': 'Zeile eins<br><br>Zeile zwei',
  'Slow connection.\nReduce your bitrate!': 'Langsame Verbindung.\nVerringere die Bitrate!',
  '- Help text of a setting.': '- Hilfetext einer Einstellung.',
  '— Stop the stream.': '— Den Stream beenden.',
  ' (Running)': ' (Läuft)',
};

test('the i18n check accepts a complete translation and texts that its list keeps in English', () => {
  assert.deepEqual(i18nCheck.checkTranslation('de-DE', ENGLISH, GERMAN, ['HEVC']), { problems: [], notes: [] });
});

test('the i18n check reports missing, extra, empty and untranslated texts', () => {
  const german = Object.assign({}, GERMAN, { 'Unknown key': 'Unbekannt', 'Settings': 'Settings', ' (Running)': ' ' });
  delete german['— Stop the stream.'];
  const result = i18nCheck.checkTranslation('de-DE', ENGLISH, german, []);
  assert.equal(result.problems.length, 5, result.problems.join('\n'));
  ['misses the key "— Stop the stream."', 'a key that en-US.json does not have: "Unknown key"', 'no translation for "Settings"',
    'no translation for "HEVC"', 'an empty text for " (Running)"'].forEach((part) => {
    assert.ok(result.problems.some((problem) => problem.indexOf(part) >= 0), part + '\n' + result.problems.join('\n'));
  });
  // A listed key that no longer exists or is translated now is a note, not a problem
  const notes = i18nCheck.checkTranslation('de-DE', ENGLISH, GERMAN, ['HEVC', 'Settings', 'Removed key']).notes;
  assert.equal(notes.length, 2, notes.join('\n'));
});

test('the i18n check reports a character reference, which a data-i18n element would show as it is', () => {
  const result = i18nCheck.checkTranslation('pt-BR', ENGLISH, Object.assign({}, GERMAN, { 'Settings': 'Defina &amp; segure' }), ['HEVC']);
  assert.equal(result.problems.length, 1, result.problems.join('\n'));
  assert.match(result.problems[0], /character reference in "Settings"/);
});

test('the i18n check reports a translation that loses a placeholder, an HTML tag, a line break, a dash or a space', () => {
  const broken = {
    'Connecting to %1$s...': 'Verbinde mit %2$s …',
    'Line one<br><br>Line two': 'Zeile eins<br>Zeile zwei',
    'Slow connection.\nReduce your bitrate!': 'Langsame Verbindung. Verringere die Bitrate!',
    '- Help text of a setting.': 'Hilfetext einer Einstellung.',
    '— Stop the stream.': '- Den Stream beenden.',
    ' (Running)': '(Läuft)',
  };
  const result = i18nCheck.checkTranslation('de-DE', ENGLISH, Object.assign({}, GERMAN, broken), ['HEVC']);
  assert.equal(result.problems.length, Object.keys(broken).length, result.problems.join('\n'));
  ['the placeholders', 'the HTML tags', 'line break', 'the leading "- "', 'the leading "— "', 'the spaces at the start'].forEach((part, i) => {
    assert.ok(result.problems[i].indexOf(part) >= 0, part + ': ' + result.problems[i]);
  });
});

test('the i18n check reads the languages of i18n.js and wants a locale file and a list for each', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'wasm', 'platform', 'i18n.js'), 'utf8');
  const locales = i18nCheck.readAppLocales(source);
  assert.equal(locales[0].code, 'en-US');
  assert.ok(locales.every((locale) => typeof locale.name === 'string' && locale.name.length > 0), JSON.stringify(locales));
  const appLocales = [{ code: 'en-US', name: 'English' }, { code: 'de-DE', name: 'Deutsch' }];
  assert.deepEqual(i18nCheck.checkLocaleSet(appLocales, ['de-DE', 'en-US'], ['de-DE']), []);
  const problems = [
    // A language without its file, a file without its language, a language without its list, a list without its language
    i18nCheck.checkLocaleSet(appLocales.concat([{ code: 'fr-FR', name: 'Français' }]), ['de-DE', 'en-US'], ['de-DE']),
    i18nCheck.checkLocaleSet(appLocales, ['de-DE', 'en-US', 'it-IT'], ['de-DE', 'it-IT']),
    i18nCheck.checkLocaleSet(appLocales, ['de-DE', 'en-US'], []),
    i18nCheck.checkLocaleSet(appLocales, ['de-DE', 'en-US'], ['de-DE', 'en-US']),
    // English not first, a language twice, a language without a name
    i18nCheck.checkLocaleSet(appLocales.slice().reverse(), ['de-DE', 'en-US'], ['de-DE']),
    i18nCheck.checkLocaleSet(appLocales.concat([{ code: 'de-DE', name: 'Deutsch' }]), ['de-DE', 'en-US'], ['de-DE']),
    i18nCheck.checkLocaleSet(appLocales.concat([{ code: 'pt-BR', name: '' }]), ['de-DE', 'en-US', 'pt-BR'], ['de-DE', 'pt-BR']),
  ];
  problems.forEach((list, i) => assert.equal(list.length, 1, i + ': ' + list.join('\n')));
});
