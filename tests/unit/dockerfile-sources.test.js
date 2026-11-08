'use strict';

// Checks that the Docker build gets every source file of the WebAssembly module. The Dockerfile copies the files of
// wasm/ by pattern (wasm/*.c, wasm/*.cpp, wasm/*.hpp and wasm/dispatcher), so a new file with another extension, such
// as the header wasm/audio_capabilities.h of the first 2.3.0 build of 8 November 2026, stays out of the image: the native
// tests compile the files where they are and pass, and only the release build fails ("file not found").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

// The sources of the COPY instructions of the Dockerfile that lie in wasm/, e.g. 'wasm/*.cpp' or 'wasm/dispatcher'
function copiedWasmSources() {
  const lines = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8').split(/\r?\n/);
  const sources = [];
  lines.forEach((line) => {
    const match = /^COPY\s+(.*)$/.exec(line.trim());
    if (!match) {
      return;
    }
    // The arguments without the options (--chown=...), the last one is the destination
    const args = match[1].split(/\s+/).filter((arg) => arg.indexOf('--') !== 0);
    args.slice(0, -1).filter((source) => source.indexOf('wasm/') === 0).forEach((source) => sources.push(source.replace(/\/$/, '')));
  });
  return sources;
}

// Whether a path relative to the repository (e.g. 'wasm/main.cpp') is one of the copied sources or lies in a copied
// folder. A source may hold '*', which matches within one path segment as in Docker.
function isCopied(file, sources) {
  return sources.some((source) => {
    if (source.indexOf('*') < 0) {
      return file === source || file.indexOf(source + '/') === 0;
    }
    const pattern = new RegExp('^' + source.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return pattern.test(file);
  });
}

const SOURCE_FILE = /\.(c|cc|cpp|h|hh|hpp|inc)$/;

test('the Dockerfile copies every source and header file directly in wasm/', () => {
  const sources = copiedWasmSources();
  assert.ok(sources.length >= 3, JSON.stringify(sources));
  const files = fs.readdirSync(path.join(REPO_ROOT, 'wasm')).filter((name) => SOURCE_FILE.test(name)).map((name) => 'wasm/' + name);
  assert.ok(files.indexOf('wasm/main.cpp') >= 0);
  const missing = files.filter((file) => !isCopied(file, sources));
  assert.deepEqual(missing, [], 'not copied into the Docker build: ' + missing.join(', '));
});

test('every header that a source of wasm/ includes from wasm/ reaches the Docker build', () => {
  const sources = copiedWasmSources();
  const dir = path.join(REPO_ROOT, 'wasm');
  const missing = [];
  fs.readdirSync(dir).filter((name) => SOURCE_FILE.test(name)).forEach((name) => {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const include = /^\s*#\s*include\s+"([^"]+)"/gm;
    let match;
    while ((match = include.exec(text)) !== null) {
      const target = path.posix.normalize('wasm/' + match[1]);
      if (fs.existsSync(path.join(REPO_ROOT, target)) && !isCopied(target, sources)) {
        missing.push(name + ' -> ' + target);
      }
    }
  });
  assert.deepEqual(missing, []);
});

test('the check notices a header that the patterns leave out', () => {
  const sources = ['wasm/*.c', 'wasm/*.cpp', 'wasm/*.hpp', 'wasm/dispatcher'];
  assert.equal(isCopied('wasm/audio_capabilities.h', sources), false);
  assert.equal(isCopied('wasm/audio_capabilities.hpp', sources), true);
  assert.equal(isCopied('wasm/dispatcher/lib.hpp', sources), true);
  assert.equal(isCopied('wasm/platform/index.js', sources), false);
});
