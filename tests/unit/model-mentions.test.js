'use strict';

// Checks that the app (everything under wasm/ and res/) mentions the S90C only where it must stay: the
// internal IDs that let existing installs update in place (the
// widget, package, app and service IDs in res/config.xml and the preview file prefix) and the tested profile in
// VERIFIED_PROFILES. Every other place names "this TV" and takes its values from the TV profile
// (wasm/platform/tv_profile.js), and the display name is 'Moonlight Plus', so the earlier display name
// 'Moonlight S90C' appears nowhere. Like `grep -ri s90c wasm/ res/`, but every line it finds must be on the allow-list
// below, and every entry of the allow-list must still be needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const SCANNED_DIRS = ['wasm', 'res'];
const MODEL_PATTERN = /s90c/i;
// The display name before 1.19.100, also with another separator or none
const OLD_DISPLAY_NAME_PATTERN = /moonlight[\s_-]*s90c/i;

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
    file: 'res/config.xml',
    pattern: /^<widget xmlns:tizen="http:\/\/tizen\.org\/ns\/widgets" xmlns="http:\/\/www\.w3\.org\/ns\/widgets" id="http:\/\/samsung\.tv\/MoonlightWasmS90C" version="\d+\.\d+\.\d+" viewmodes="fullscreen">$/,
    reason: 'the widget ID, an internal ID kept by decision D2 so that an update installs in place',
  },
  {
    file: 'res/config.xml',
    pattern: /^\s*<tizen:application id="MLightS90C\.MoonlightWasm" package="MLightS90C" required_version="5\.5" launch_mode="caller"\/>$/,
    reason: 'the app and package IDs, internal IDs kept by decision D2 so that an update keeps its settings and pairing',
  },
  {
    file: 'res/config.xml',
    pattern: /^\s*<tizen:service id="MLightS90C\.service" on-boot="true" auto-restart="true">$/,
    reason: 'the service ID of the Smart Hub preview, an internal ID kept by decision D2',
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

// List the files of all scanned directories
function listScannedFiles() {
  return SCANNED_DIRS.reduce((files, dir) => files.concat(listFiles(dir)), []);
}

// Find every line of the scanned text files that matches a pattern, as { file, line, text }
function findLines(pattern) {
  const found = [];
  listScannedFiles().forEach((file) => {
    const text = readText(file);
    if (text === null) {
      return;
    }
    text.split(/\r?\n/).forEach((lineText, index) => {
      if (pattern.test(lineText)) {
        found.push({ file, line: index + 1, text: lineText });
      }
    });
  });
  return found;
}

// Find every line that mentions the model
function findMentions() {
  return findLines(MODEL_PATTERN);
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
  assert.deepEqual(listScannedFiles().filter((file) => MODEL_PATTERN.test(file)), []);
});

test('the earlier display name Moonlight S90C appears nowhere in the app', () => {
  // The allow-list never covers it: the display name is 'Moonlight Plus'
  assert.deepEqual(findLines(OLD_DISPLAY_NAME_PATTERN).map((found) => `${found.file}:${found.line}: ${found.text.trim()}`), []);
  assert.equal(ALLOW_LIST.some((entry) => entry.pattern.test('<name>Moonlight S90C</name>')), false);
  assert.equal(ALLOW_LIST.some((entry) => entry.pattern.test('  "Moonlight S90C": "Moonlight S90C",')), false);
});

test('the scan itself works: it finds the allowed mentions, and the allow-list rejects other ones', () => {
  // Guard against a scan that silently finds nothing (e.g. a wrong folder): the allowed mentions must be found
  const mentions = findMentions();
  assert.ok(mentions.some((mention) => mention.file === 'wasm/platform/tv_profile.js'), JSON.stringify(mentions));
  assert.ok(mentions.some((mention) => mention.file === 'res/config.xml'), JSON.stringify(mentions));
  assert.ok(MODEL_PATTERN.test('isS90cModel') && MODEL_PATTERN.test('Samsung S90C optimization'));
  assert.equal(ALLOW_LIST.some((entry) => entry.pattern.test("$('#s90cProfileBtn').on('click', s90cSettingsDialog);")), false);
  // The entries of the IDs allow no other text on their lines, e.g. a description of the old build
  assert.equal(ALLOW_LIST.some((entry) => entry.pattern.test('    <description>Moonlight Game Streaming (Samsung S90C build)</description>')), false);
  assert.equal(ALLOW_LIST.some((entry) => entry.pattern.test(
    '    <tizen:service id="MLightS90C.service" on-boot="true" auto-restart="true"> <!-- Moonlight S90C -->')), false);
  assert.ok(OLD_DISPLAY_NAME_PATTERN.test('Moonlight S90C') && OLD_DISPLAY_NAME_PATTERN.test('moonlight-s90c'));
  assert.equal(OLD_DISPLAY_NAME_PATTERN.test('MoonlightWasmS90C'), false);
});
