#!/usr/bin/env node
'use strict';

// Checks the locale files without changing them:
// 1. Runs wasm/static/js/i18n-sync.js on a temporary copy of wasm/ and fails if it would change any locale file, i.e.
//    when a UI string was added, changed or removed without running `node wasm/static/js/i18n-sync.js`.
// 2. Fails unless the locale files are exactly the languages of LOCALES in wasm/platform/i18n.js (each named in its own
//    language), and unless every language other than English has its list of texts that stay English,
//    tests/tools/i18n-same-as-english/<locale>.json.
// 3. Fails if a locale file misses a key of en-US.json or has a key en-US.json doesn't have.
// 4. Fails if a text is still the English text, unless the key is in the list of its language (texts that are the same
//    in both languages, such as "HEVC", and for pt-BR the texts that were untranslated when this check was added).
//    So every new UI string needs a translation in every language.
// 5. Fails if a translation loses or adds a placeholder (%1$s), an HTML tag (<br>, <b>), a line break, the dash that
//    starts a help text or a dash line of the navigation guide (the stylesheet hides the first letter of a help text),
//    or a space at the start or end, and if a text has a character reference such as &amp;, which the translation
//    pass of data-i18n elements would show as it is (it sets their text, not their HTML).
//
// Usage: node tests/tools/i18n-check.js

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { REPO_ROOT } = require('../lib/dev-modules');

const LOCALES_DIR = path.join(REPO_ROOT, 'wasm', 'static', 'locales');
const I18N_SCRIPT = path.join(REPO_ROOT, 'wasm', 'platform', 'i18n.js');
const SAME_AS_ENGLISH_DIR = path.join(__dirname, 'i18n-same-as-english');
const SOURCE_LOCALE = 'en-US';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Describe how two versions of a locale file differ, by key
function describeDifference(before, after) {
  const lines = [];
  Object.keys(after).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      lines.push('added ' + JSON.stringify(key));
    } else if (before[key] !== after[key]) {
      lines.push('changed ' + JSON.stringify(key));
    }
  });
  Object.keys(before).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      lines.push('removed ' + JSON.stringify(key));
    }
  });
  if (lines.length === 0) {
    lines.push('same keys and texts, different order or formatting');
  }
  return lines;
}

// 1. The locale files must be what i18n-sync.js produces
function checkSync(problems) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-i18n-check-'));
  try {
    fs.cpSync(path.join(REPO_ROOT, 'wasm'), path.join(tempRoot, 'wasm'), { recursive: true });
    childProcess.execFileSync(process.execPath, [path.join(tempRoot, 'wasm', 'static', 'js', 'i18n-sync.js')], {
      cwd: tempRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tempLocales = path.join(tempRoot, 'wasm', 'static', 'locales');
    const names = new Set(fs.readdirSync(LOCALES_DIR).concat(fs.readdirSync(tempLocales)).filter((name) => name.endsWith('.json')));
    Array.from(names).sort().forEach((name) => {
      const repoFile = path.join(LOCALES_DIR, name);
      const syncedFile = path.join(tempLocales, name);
      if (!fs.existsSync(repoFile) || !fs.existsSync(syncedFile)) {
        problems.push(`${name}: exists only ${fs.existsSync(repoFile) ? 'in the repository' : 'after the sync'}`);
        return;
      }
      if (fs.readFileSync(repoFile, 'utf8') !== fs.readFileSync(syncedFile, 'utf8')) {
        const lines = describeDifference(readJson(repoFile), readJson(syncedFile));
        problems.push(`${name} is not in sync, run 'node wasm/static/js/i18n-sync.js':\n    ` + lines.slice(0, 20).join('\n    ') +
          (lines.length > 20 ? `\n    ... and ${lines.length - 20} more` : ''));
      }
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

// The languages of the app: the array literal of `const LOCALES = [...]` in the source of i18n.js
function readAppLocales(source) {
  const match = /const LOCALES = (\[[\s\S]*?\]);/.exec(source);
  if (!match) {
    throw new Error('wasm/platform/i18n.js has no `const LOCALES = [...];`');
  }
  return vm.runInNewContext(match[1]);
}

// 2. The locale files, the languages of i18n.js and the lists of texts that stay English belong together
function checkLocaleSet(appLocales, localeFiles, sameAsEnglishFiles) {
  const problems = [];
  const codes = appLocales.map((locale) => locale.code);
  if (codes[0] !== SOURCE_LOCALE) {
    problems.push(`LOCALES in wasm/platform/i18n.js must start with ${SOURCE_LOCALE}, the language of the source texts`);
  }
  appLocales.forEach((locale) => {
    if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale.code) || typeof locale.name !== 'string' || !locale.name.trim()) {
      problems.push('LOCALES in wasm/platform/i18n.js has an entry without a locale code like de-DE or without a name: ' + JSON.stringify(locale));
    }
  });
  codes.filter((code, index) => codes.indexOf(code) !== index).forEach((code) => {
    problems.push('LOCALES in wasm/platform/i18n.js lists ' + code + ' twice');
  });
  codes.filter((code) => localeFiles.indexOf(code) < 0).forEach((code) => {
    problems.push(`LOCALES in wasm/platform/i18n.js lists ${code}, but wasm/static/locales/${code}.json doesn't exist`);
  });
  localeFiles.filter((code) => codes.indexOf(code) < 0).forEach((code) => {
    problems.push(`wasm/static/locales/${code}.json has no entry in LOCALES of wasm/platform/i18n.js, so the app never shows it`);
  });
  localeFiles.filter((code) => code !== SOURCE_LOCALE && sameAsEnglishFiles.indexOf(code) < 0).forEach((code) => {
    problems.push(`${code} has no list of the texts that stay English: add tests/tools/i18n-same-as-english/${code}.json`);
  });
  sameAsEnglishFiles.filter((code) => localeFiles.indexOf(code) < 0 || code === SOURCE_LOCALE).forEach((code) => {
    problems.push(`tests/tools/i18n-same-as-english/${code}.json belongs to no translated locale file`);
  });
  return problems;
}

// What a translation has to keep from the English text
const placeholders = (text) => (text.match(/%\d+\$[sd]/g) || []).sort();
const htmlTags = (text) => (text.match(/<\/?[a-zA-Z][^>]*>/g) || []).map((tag) => tag.toLowerCase()).sort();
const lineBreaks = (text) => (text.match(/\n/g) || []).length;
const leadingDash = (text) => (/^(- |— )/.exec(text) || [''])[0];
const outerSpaces = (text) => [/^\s*/.exec(text)[0], /\s*$/.exec(text)[0]];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 3. to 5. for one language: returns the problems and the notes about its list of texts that stay English
function checkTranslation(locale, english, translated, sameAsEnglish) {
  const problems = [];
  const notes = [];
  const listFile = `tests/tools/i18n-same-as-english/${locale}.json`;
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  Object.keys(english).filter((key) => !has(translated, key)).forEach((key) => {
    problems.push(`${locale}.json misses the key ${JSON.stringify(key)}`);
  });
  Object.keys(translated).filter((key) => !has(english, key)).forEach((key) => {
    problems.push(`${locale}.json has a key that en-US.json does not have: ${JSON.stringify(key)}`);
  });

  const allowed = new Set(sameAsEnglish);
  Object.keys(english).filter((key) => has(translated, key)).forEach((key) => {
    const source = english[key];
    const text = translated[key];
    if (typeof text !== 'string' || !text.trim()) {
      problems.push(`${locale}.json has an empty text for ${JSON.stringify(key)}`);
      return;
    }
    if (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(text)) {
      problems.push(`${locale}.json has a character reference in ${JSON.stringify(key)}, write the character itself: ${JSON.stringify(text)}`);
    }
    if (text === source && !allowed.has(key)) {
      problems.push(`${locale}.json has no translation for ${JSON.stringify(key)} (translate it, or add the key to ${listFile} ` +
        'if the text is the same in both languages)');
    }
    const lost = [];
    if (!same(placeholders(source), placeholders(text))) {
      lost.push('the placeholders ' + JSON.stringify(placeholders(source)));
    }
    if (!same(htmlTags(source), htmlTags(text))) {
      lost.push('the HTML tags ' + JSON.stringify(htmlTags(source)));
    }
    if (lineBreaks(source) !== lineBreaks(text)) {
      lost.push(lineBreaks(source) + ' line break(s)');
    }
    if (leadingDash(source) !== leadingDash(text)) {
      lost.push('the leading ' + JSON.stringify(leadingDash(source) || 'text without a dash'));
    }
    if (!same(outerSpaces(source), outerSpaces(text))) {
      lost.push('the spaces at the start and end ' + JSON.stringify(outerSpaces(source)));
    }
    if (lost.length > 0) {
      problems.push(`${locale}.json changes ${lost.join(', ')} of ${JSON.stringify(key)}: ${JSON.stringify(text)}`);
    }
  });
  allowed.forEach((key) => {
    if (!has(english, key)) {
      notes.push(`${listFile} lists a key that no longer exists: ${JSON.stringify(key)}`);
    } else if (has(translated, key) && translated[key] !== english[key]) {
      notes.push(`${listFile} lists a key that is translated now: ${JSON.stringify(key)}`);
    }
  });
  return { problems, notes };
}

const jsonNames = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length)).sort();

function main() {
  const problems = [];
  const notes = [];
  checkSync(problems);
  const localeFiles = jsonNames(LOCALES_DIR);
  const appLocales = readAppLocales(fs.readFileSync(I18N_SCRIPT, 'utf8'));
  problems.push(...checkLocaleSet(appLocales, localeFiles, jsonNames(SAME_AS_ENGLISH_DIR)));
  const english = readJson(path.join(LOCALES_DIR, SOURCE_LOCALE + '.json'));
  const translatedLocales = localeFiles.filter((locale) => locale !== SOURCE_LOCALE);
  translatedLocales.forEach((locale) => {
    const listFile = path.join(SAME_AS_ENGLISH_DIR, locale + '.json');
    const sameAsEnglish = fs.existsSync(listFile) ? readJson(listFile).keys : [];
    const result = checkTranslation(locale, english, readJson(path.join(LOCALES_DIR, locale + '.json')), sameAsEnglish);
    problems.push(...result.problems);
    notes.push(...result.notes);
  });
  notes.forEach((note) => console.log('# note: ' + note));
  if (problems.length > 0) {
    problems.forEach((problem) => console.log('not ok - ' + problem));
    console.log(`# i18n check failed with ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`ok - locale files are in sync with the UI strings, and ${translatedLocales.join(', ')} have every key and translation`);
}

module.exports = { readAppLocales, checkLocaleSet, checkTranslation };

if (require.main === module) {
  main();
}
