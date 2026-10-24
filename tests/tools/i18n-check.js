#!/usr/bin/env node
'use strict';

// Checks the locale files without changing them:
// 1. Runs wasm/static/js/i18n-sync.js on a temporary copy of wasm/ and fails if it would change any locale file, i.e.
//    when a UI string was added, changed or removed without running `node wasm/static/js/i18n-sync.js`.
// 2. Fails if pt-BR.json misses a key of en-US.json or has a key en-US.json doesn't have.
// 3. Fails if a pt-BR text is still the English text, unless the key is in i18n-ptbr-same-as-english.json (texts that
//    are the same in both languages, such as "HEVC", and the texts that were untranslated when this check was added).
//    So every new UI string needs a Brazilian Portuguese translation.
//
// Usage: node tests/tools/i18n-check.js

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const LOCALES_DIR = path.join(REPO_ROOT, 'wasm', 'static', 'locales');
const SOURCE_LOCALE = 'en-US';
const SAME_AS_ENGLISH_FILE = path.join(__dirname, 'i18n-ptbr-same-as-english.json');

const problems = [];
const notes = [];

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
function checkSync() {
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

// 2. and 3. pt-BR must have exactly the keys of en-US, and a translation for every new key
function checkPortuguese() {
  const english = readJson(path.join(LOCALES_DIR, SOURCE_LOCALE + '.json'));
  const portuguese = readJson(path.join(LOCALES_DIR, 'pt-BR.json'));
  const missing = Object.keys(english).filter((key) => !Object.prototype.hasOwnProperty.call(portuguese, key));
  const extra = Object.keys(portuguese).filter((key) => !Object.prototype.hasOwnProperty.call(english, key));
  missing.forEach((key) => problems.push('pt-BR.json misses the key ' + JSON.stringify(key)));
  extra.forEach((key) => problems.push('pt-BR.json has a key that en-US.json does not have: ' + JSON.stringify(key)));

  const allowed = new Set(readJson(SAME_AS_ENGLISH_FILE).keys);
  Object.keys(english).forEach((key) => {
    if (portuguese[key] === english[key] && !allowed.has(key)) {
      problems.push('pt-BR.json has no translation for ' + JSON.stringify(key) +
        ' (translate it, or add the key to tests/tools/i18n-ptbr-same-as-english.json if the text is the same in both languages)');
    }
  });
  allowed.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(english, key)) {
      notes.push('i18n-ptbr-same-as-english.json lists a key that no longer exists: ' + JSON.stringify(key));
    } else if (Object.prototype.hasOwnProperty.call(portuguese, key) && portuguese[key] !== english[key]) {
      notes.push('i18n-ptbr-same-as-english.json lists a key that is translated now: ' + JSON.stringify(key));
    }
  });
}

function main() {
  checkSync();
  checkPortuguese();
  notes.forEach((note) => console.log('# note: ' + note));
  if (problems.length > 0) {
    problems.forEach((problem) => console.log('not ok - ' + problem));
    console.log(`# i18n check failed with ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('ok - locale files are in sync with the UI strings, and pt-BR has every key and translation');
}

main();
