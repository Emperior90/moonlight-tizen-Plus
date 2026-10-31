'use strict';

// The package check: CMakeLists.txt installs the whole wasm/static folder into the widget (Moonlight.wgt), so every
// file placed there ships to every TV, used or not. This is how 2.1.0 shipped a CA bundle that curl never read
// (221 KB), eight icons of the Chrome app and a Node tool. A file under wasm/static must be used by the app: named by
// a src or href of wasm/index.html, a string of a script (wasm/platform, wasm/static/js, res) or a url() of a
// stylesheet. Allowed without that are the locale files (i18n.js builds their names), and the licence of the Manrope
// font, which the SIL OFL requires next to the font. Files that CMakeLists.txt leaves out of the widget (PATTERN ...
// EXCLUDE) need no use, and every such pattern must still match a file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { installedDirectories, isExcluded } = require('../lib/widget-files');

const WASM_DIR = path.join(REPO_ROOT, 'wasm');
const STATIC_DIR = path.join(WASM_DIR, 'static');
// Files that are used without a name in the sources (paths relative to wasm/)
const ALLOWED = [
  /^static\/locales\/[a-z]{2}-[A-Z]{2}\.json$/,
  /^static\/fonts\/Manrope-OFL\.txt$/,
];

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((files, entry) => {
    const full = path.join(dir, entry.name);
    return files.concat(entry.isDirectory() ? listFiles(full) : [full]);
  }, []);
}

const relativeToWasm = (file) => path.relative(WASM_DIR, file).split(path.sep).join('/');

function staticExcludes() {
  const entry = installedDirectories(REPO_ROOT).find((item) => item.dir === 'wasm/static');
  assert.ok(entry, 'CMakeLists.txt installs wasm/static into the widget');
  return entry.excludes;
}

// The files of wasm/static that the widget gets
function packagedStaticFiles() {
  const excludes = staticExcludes();
  return listFiles(STATIC_DIR).filter((file) => !isExcluded(path.relative(STATIC_DIR, file), excludes));
}

// Every file of wasm/static that the app names: resolved from the attributes of index.html and the strings of the
// scripts relative to the widget root, and from the url() of the stylesheets relative to the stylesheet
function referencedFiles(packaged) {
  const used = new Set();
  const addRelativeTo = (baseDir, reference) => {
    const clean = reference.replace(/[?#].*$/, '');
    if (!clean || /^(data:|https?:|#)/.test(clean)) {
      return;
    }
    used.add(relativeToWasm(path.resolve(baseDir, clean)));
  };

  const html = fs.readFileSync(path.join(WASM_DIR, 'index.html'), 'utf8');
  html.replace(/\b(?:src|href)\s*=\s*"([^"]+)"/g, (all, reference) => addRelativeTo(WASM_DIR, reference));

  const scripts = listFiles(path.join(WASM_DIR, 'platform')).concat(listFiles(path.join(STATIC_DIR, 'js')),
    listFiles(path.join(REPO_ROOT, 'res'))).filter((file) => /\.js$/.test(file));
  scripts.forEach((file) => {
    fs.readFileSync(file, 'utf8').replace(/(['"`])(static\/[^'"`$]+)\1/g, (all, quote, reference) => addRelativeTo(WASM_DIR, reference));
  });

  packaged.filter((file) => /\.css$/.test(file)).forEach((file) => {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, quote, reference) => addRelativeTo(path.dirname(file), reference));
  });
  return used;
}

test('every file of wasm/static that the widget gets is used by the app or allowed (the package check)', () => {
  const packaged = packagedStaticFiles();
  const used = referencedFiles(packaged);
  const unused = packaged.map(relativeToWasm).filter((file) => !used.has(file) && !ALLOWED.some((pattern) => pattern.test(file)));
  assert.deepEqual(unused, [], 'Files in wasm/static that nothing uses go into every Moonlight.wgt: delete them, or leave ' +
    'them out with PATTERN "<name>" EXCLUDE in CMakeLists.txt if the repository needs them');
});

test('every file the app names in wasm/static exists and is in the widget', () => {
  const packaged = new Set(packagedStaticFiles().map(relativeToWasm));
  const missing = Array.from(referencedFiles(packagedStaticFiles())).filter((file) => /^static\//.test(file) && !packaged.has(file));
  assert.deepEqual(missing, []);
});

test('the files CMakeLists.txt leaves out of the widget exist, and the app loads none of them', () => {
  const excludes = staticExcludes();
  assert.deepEqual(excludes, ['en-US.json', 'i18n-sync.js']);
  const all = listFiles(STATIC_DIR);
  excludes.forEach((glob) => {
    const matches = all.filter((file) => isExcluded(path.relative(STATIC_DIR, file), [glob]));
    assert.ok(matches.length > 0, 'PATTERN "' + glob + '" EXCLUDE matches no file of wasm/static');
  });
  // English needs no locale file (wasm/platform/i18n.js), and the Node tool is not a script of the page
  assert.equal(fs.readFileSync(path.join(WASM_DIR, 'index.html'), 'utf8').indexOf('i18n-sync'), -1);
  assert.match(fs.readFileSync(path.join(WASM_DIR, 'platform', 'i18n.js'), 'utf8'),
    /function loadLocaleFile\(locale\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(locale === SOURCE_LOCALE\) \{\n\s*return Promise\.resolve\(\{\}\);/);
});

test('the leftovers of moonlight-chrome are gone from the widget: CA bundle, app icons, favicon and the mDNS packet code', () => {
  ['curl', 'icons', 'favicon', 'js/mdns-browser/dns.js'].forEach((name) => {
    assert.equal(fs.existsSync(path.join(STATIC_DIR, name)), false, 'wasm/static/' + name);
  });
  // curl reads no CA bundle: every HTTPS request pins the key of the host (libgamestream/http.c)
  const http = fs.readFileSync(path.join(REPO_ROOT, 'libgamestream', 'http.c'), 'utf8');
  assert.equal(http.indexOf('CURLOPT_CAINFO'), -1);
  assert.match(http, /CURLOPT_PINNEDPUBLICKEY, ppkstr/);
  // The subnet scan stays, without the commented-out Chrome code (chrome.sockets)
  const scanner = fs.readFileSync(path.join(STATIC_DIR, 'js', 'mdns-browser', 'main.js'), 'utf8');
  assert.match(scanner, /function startSubnetScanner\(/);
  assert.equal(/ServiceFinder|^\s*\/\/.*chrome\.sockets/m.test(scanner), false);
  assert.equal(/ServiceFinder|finder\.byService_/.test(fs.readFileSync(path.join(WASM_DIR, 'platform', 'index.js'), 'utf8')), false);
});
