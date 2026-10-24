'use strict';

// Checks that the app (everything under wasm/) mentions the S90C only where the generalization plan keeps it (plan WP3,
// decision D2 and section 5): the internal IDs that let existing installs update in place, the tested profile in
// VERIFIED_PROFILES, and the display name until it changes in plan WP5 (decision D1). Every other place names "this TV"
// and takes its values from the TV profile (wasm/platform/tv_profile.js). Like `grep -ri s90c wasm/`, but every line it
// finds must be on the allow-list below, and every entry of the allow-list must still be needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const SCANNED_DIR = 'wasm';
const MODEL_PATTERN = /s90c/i;

// Each entry allows the lines of one file that match its pattern. Remove an entry once its reason is gone.
const ALLOW_LIST = [
  {
    file: 'wasm/platform/tv_profile.js',
    pattern: /^\s*\/\/ Samsung S90C \(2023 OLED with a 144 Hz panel\), the TV this app was tuned and tested on$/,
    reason: 'the comment of the tested profile in VERIFIED_PROFILES',
  },
  {
    file: 'wasm/platform/tv_profile.js',
    pattern: /^\s*Object\.freeze\(\{ id: 'S90C', match: \/S90C\/i, /,
    reason: 'the tested profile in VERIFIED_PROFILES, selected by the same model check as before',
  },
  {
    file: 'wasm/static/js/utils.js',
    pattern: /^var SMART_HUB_PREVIEW_FILE_PREFIX = 'preview-s90c-';/,
    reason: 'the file prefix of the Smart Hub preview images, an internal ID kept by decision D2',
  },
  {
    file: 'wasm/index.html',
    pattern: /<span id="header-title" class="mdl-layout-title" data-i18n="Moonlight S90C">Moonlight S90C<\/span>/,
    reason: 'the display name in the header, which plan WP5 changes (decision D1)',
  },
  {
    file: 'wasm/static/locales/en-US.json',
    pattern: /^\s*"Moonlight S90C": "Moonlight S90C",$/,
    reason: 'the locale key of the display name in the header, which plan WP5 changes (decision D1)',
  },
  {
    file: 'wasm/static/locales/pt-BR.json',
    pattern: /^\s*"Moonlight S90C": "Moonlight S90C",$/,
    reason: 'the locale key of the display name in the header, which plan WP5 changes (decision D1)',
  },
];

// File types that are never text, which the scan skips
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.mp3', '.wav', '.ogg']);

// List the files below a directory of the repository, as paths relative to the repository root with forward slashes
function listFiles(relativeDir) {
  const files = [];
  const walk = (dir) => {
    fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).forEach((entry) => {
      const relativePath = dir + '/' + entry.name;
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    });
  };
  walk(relativeDir);
  return files.sort();
}

// Read a file as text, or return null for a binary file (by extension, or a NUL byte in its content)
function readText(relativePath) {
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return null;
  }
  const content = fs.readFileSync(path.join(REPO_ROOT, relativePath));
  return content.includes(0) ? null : content.toString('utf8');
}

// Find every line that mentions the model, as { file, line, text }
function findMentions() {
  const mentions = [];
  listFiles(SCANNED_DIR).forEach((file) => {
    const text = readText(file);
    if (text === null) {
      return;
    }
    text.split(/\r?\n/).forEach((lineText, index) => {
      if (MODEL_PATTERN.test(lineText)) {
        mentions.push({ file, line: index + 1, text: lineText });
      }
    });
  });
  return mentions;
}

test('the app mentions the S90C only where the allow-list keeps it', () => {
  const unexpected = findMentions().filter((mention) => !ALLOW_LIST.some((entry) => entry.file === mention.file && entry.pattern.test(mention.text)));
  assert.deepEqual(unexpected.map((mention) => `${mention.file}:${mention.line}: ${mention.text.trim()}`), [],
    'Name "this TV" instead and take the values from the TV profile, or add an entry with a reason to the allow-list');
});

test('every entry of the allow-list is still needed', () => {
  const mentions = findMentions();
  const unused = ALLOW_LIST.filter((entry) => !mentions.some((mention) => entry.file === mention.file && entry.pattern.test(mention.text)));
  assert.deepEqual(unused.map((entry) => `${entry.file}: ${entry.reason}`), []);
});

test('no file or folder of the app is named after the S90C', () => {
  assert.deepEqual(listFiles(SCANNED_DIR).filter((file) => MODEL_PATTERN.test(file)), []);
});

test('the scan itself works: it finds the allowed mentions, and the allow-list rejects other ones', () => {
  // Guard against a scan that silently finds nothing (e.g. a wrong folder): the allowed mentions must be found
  const mentions = findMentions();
  assert.ok(mentions.some((mention) => mention.file === 'wasm/platform/tv_profile.js'), JSON.stringify(mentions));
  assert.ok(MODEL_PATTERN.test('isS90cModel') && MODEL_PATTERN.test('Samsung S90C optimization'));
  assert.equal(ALLOW_LIST.some((entry) => entry.pattern.test("$('#s90cProfileBtn').on('click', s90cSettingsDialog);")), false);
});
