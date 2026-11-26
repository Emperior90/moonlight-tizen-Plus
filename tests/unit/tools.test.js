'use strict';

// Checks that the checkers in tests/tools catch what they are meant to catch, so a broken checker can't let newer
// JavaScript, a name that nothing declares, a split EM_ASM block, a broken link of the documents, a broken translation or
// a browser test run on another Chromium than the CI's through unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const es2018 = require('../tools/check-es2018');
const emAsm = require('../tools/check-em-asm');
const markdownLinks = require('../tools/check-markdown-links');
const i18nCheck = require('../tools/i18n-check');
const browserBuild = require('../tools/check-browser-build');
const globalNames = require('../tools/check-globals');

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
  ['https://github.com/Emperior90/moonlight-tizen-Plus/tree/v2.3.0/docs', 'https://github.com/Emperior90/moonlight-tizen-Plus/issues',
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

test('the check of the Chromium build reads the build of the pinned Playwright', () => {
  // Playwright 1.56.1 of tests/package.json runs its headless shell of build 1194, Chromium 141.0.7390.37: a new
  // Playwright updates this pair and tests/README.md ("The Chromium of the CI")
  assert.deepEqual(browserBuild.expectedBuild(), { revision: '1194', browserVersion: '141.0.7390.37', playwright: '1.56.1' });
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(readme.indexOf('Chromium 141.0.7390.37 (build 1194)') >= 0, 'the README names the pinned build');
});

test('the check of the Chromium build passes the pinned build and warns on another one, an error only in the CI', () => {
  const expected = { revision: '1194', browserVersion: '141.0.7390.37', playwright: '1.56.1' };
  assert.deepEqual(browserBuild.decide('141.0.7390.37', expected, {}), { exitCode: 0, line: 'Chromium 141.0.7390.37 (build 1194), the one of the CI.' });
  assert.equal(browserBuild.decide('141.0.7390.37', expected, { MOONLIGHT_PINNED_CHROMIUM: '1' }).exitCode, 0);
  const local = browserBuild.decide('157.0.8103.78', expected, {});
  assert.equal(local.exitCode, 0, 'a machine without the pinned build can still run the tests');
  assert.match(local.line, /^Warning: the browser tests run on Chromium 157\.0\.8103\.78, but Playwright 1\.56\.1 and the CI use Chromium 141\.0\.7390\.37 \(build 1194\)/);
  assert.match(local.line, /text widths and layout differ, so a layout test can pass here and fail in CI/);
  assert.match(local.line, /npm run install:browser --prefix tests/);
  // CI=true alone doesn't make it an error: only the variable that the workflow Tests sets
  assert.equal(browserBuild.decide('157.0.8103.78', expected, { CI: 'true' }).exitCode, 0);
  const ci = browserBuild.decide('157.0.8103.78', expected, { MOONLIGHT_PINNED_CHROMIUM: '1' });
  assert.equal(ci.exitCode, 1);
  assert.match(ci.line, /^Error: /);
  assert.deepEqual(browserBuild.compareBuild('141.0.7390.38', expected, false).ok, false, 'another patch version is another build');
});

// Check scripts of one page as one global scope: `files` maps file names to sources, in the order the page loads them
const checkGlobals = (files, handlers) => globalNames.checkSources(loaded.acorn,
  Object.keys(files).map((file) => ({ file, text: files[file] })), handlers || []).map((problem) => problem.message);

test('the global name check accepts names that another script declares, and the usual scopes', { skip: acornMissing }, () => {
  assert.deepEqual(checkGlobals({
    'a.js': [
      'var shared = 1;',
      'function helper(value) { return value; }',
      'const LIMIT = 3;',
      'class Box {}',
      'window.fromWindow = function() {};',
    ].join('\n'),
    'b.js': [
      'helper(shared + LIMIT);',
      'new Box();',
      'fromWindow();',
      'function later({ a, b: [c] }, d = a, ...rest) { var e; for (let i = 0; i < 2; i++) { e = i + c + d + rest.length; } return e; }',
      'try { later({ a: 1, b: [2] }); } catch (error) { console.log(error); }',
      'const user = { name: 1, helper };',
      'user.name = user.other;',
      'outer: for (const key in user) { if (key) { continue outer; } }',
      // A name of the TV or a library behind typeof
      'if (typeof notOnEveryTv === "function") { notOnEveryTv(); }',
      'var flag = typeof maybeThere === "boolean" ? maybeThere : false;',
      'typeof neverRead;',
      'hoisted();',
      'function hoisted() { return arguments.length; }',
      'Module = {};',
    ].join('\n'),
  }), []);
});

test('the global name check reports undeclared names, implicit globals and block-scoped names used outside', { skip: acornMissing }, () => {
  assert.deepEqual(checkGlobals({
    'a.js': [
      'function parse(text) {',
      '  $xml = text;',
      '  return $xml;',
      '}',
      'if (true) { let inner = 1; }',
      'inner;',
      'missingFunction();',
      'process.exit(1);',
      'Buffer.from("x");',
      '$ = null;',
    ].join('\n'),
  }), [
    'a.js:2: $xml is assigned, but nothing declares it (an implicit global)',
    'a.js:3: $xml is used, but nothing declares it',
    'a.js:6: inner is used, but nothing declares it',
    'a.js:7: missingFunction is used, but nothing declares it',
    'a.js:8: process is used, but nothing declares it',
    'a.js:9: Buffer is used, but nothing declares it',
    'a.js:10: $ is assigned, but nothing declares it (an implicit global)',
  ]);
  // A guard on another name or another branch doesn't count
  assert.deepEqual(checkGlobals({ 'a.js': 'if (typeof other === "function") { maybe(); } else { other(); }' }), [
    'a.js:1: maybe is used, but nothing declares it',
    'a.js:1: other is used, but nothing declares it',
  ]);
});

test('the global name check reports an inline handler of the page that calls a missing function', { skip: acornMissing }, () => {
  assert.deepEqual(checkGlobals({ 'a.js': 'function handleSettingsView(name) { return name; }' }, [
    { file: 'index.html', line: 4, code: "handleSettingsView('basicSettings')" },
    { file: 'index.html', line: 9, code: 'handleRemoved(event)' },
  ]), ['index.html:9: the inline handler "handleRemoved(event)" uses handleRemoved, but nothing declares it']);
  // The handlers of wasm/index.html, read from the page
  const handlers = globalNames.listHandlers(path.join(__dirname, '..', '..'));
  assert.ok(handlers.length >= 9, JSON.stringify(handlers));
  assert.ok(handlers.some((handler) => handler.code === "handleSettingsView('basicSettings')"));
  // The scripts of the page, in its order, without the libraries and the webapis.js of the TV
  const scripts = globalNames.listScripts(path.join(__dirname, '..', '..'));
  assert.equal(scripts[0], 'res/platform.js');
  assert.ok(scripts.indexOf('wasm/platform/index.js') > 0 && scripts.indexOf('wasm/static/js/utils.js') > scripts.indexOf('wasm/platform/index.js'));
  assert.ok(!scripts.some((file) => /\.min\.js$|webapis/.test(file)), scripts.join(', '));
});
