'use strict';

// Checks that each @font-face of wasm/static/css/roboto.css loads the Roboto file that has the glyphs of its
// unicode-range. Before 1.19.101 the latin face (ASCII and Latin-1) loaded the latin-ext file, which has no ASCII
// glyphs, and the other way round, so the TV drew the UI text in a fallback font wherever no Roboto was installed.
//
// The test reads the character map (cmap) of the WOFF2 files itself (helpers/woff2.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { readCodePoints } = require('./helpers/woff2');

const CSS_FILE = path.join(REPO_ROOT, 'wasm/static/css/roboto.css');

// The @font-face rules of roboto.css with the file and unicode-range of each, keyed by the comment above them
function readFontFaces() {
  const css = fs.readFileSync(CSS_FILE, 'utf8');
  const faces = {};
  const pattern = /\/\* ([\w-]+) \*\/\s*@font-face \{([^}]*)\}/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    const body = match[2];
    const url = /url\(([^)]+)\)/.exec(body);
    const range = /unicode-range: ([^;]+);/.exec(body);
    assert.ok(url && range, 'incomplete @font-face for ' + match[1]);
    faces[match[1]] = {
      file: path.resolve(path.dirname(CSS_FILE), url[1]),
      ranges: range[1].split(',').map((part) => {
        const bounds = part.trim().replace(/^U\+/, '').split('-').map((hex) => parseInt(hex, 16));
        return { start: bounds[0], end: bounds.length > 1 ? bounds[1] : bounds[0] };
      }),
    };
  }
  return faces;
}

const missing = (codePoints, start, end, except) => {
  const result = [];
  for (let c = start; c <= end; c++) {
    if (!codePoints.has(c) && !(except || []).includes(c)) {
      result.push('U+' + c.toString(16).toUpperCase().padStart(4, '0'));
    }
  }
  return result;
};

test('roboto.css has a latin and a latin-ext face with existing files', () => {
  const faces = readFontFaces();
  assert.deepEqual(Object.keys(faces).sort(), ['latin', 'latin-ext']);
  Object.values(faces).forEach((face) => assert.ok(fs.existsSync(face.file), face.file + ' does not exist'));
});

test('the latin face loads the file with the ASCII and Latin-1 glyphs', () => {
  const face = readFontFaces().latin;
  assert.equal(face.ranges[0].start, 0x0000);
  assert.equal(face.ranges[0].end, 0x00ff);
  const codePoints = readCodePoints(face.file);
  assert.deepEqual(missing(codePoints, 0x20, 0x7e), [], 'ASCII missing in ' + path.basename(face.file));
  assert.deepEqual(missing(codePoints, 0xa0, 0xff), [], 'Latin-1 missing in ' + path.basename(face.file));
  // The single characters of its range that Roboto has
  [0x0131, 0x0152, 0x0153, 0x20ac, 0x2026, 0x2013, 0x2014].forEach((c) => assert.ok(codePoints.has(c), c.toString(16)));
});

test('the latin-ext face loads the file with the Latin Extended-A glyphs', () => {
  const face = readFontFaces()['latin-ext'];
  assert.equal(face.ranges[0].start, 0x0100);
  const codePoints = readCodePoints(face.file);
  // U+0131, U+0152 and U+0153 belong to the latin face
  assert.deepEqual(missing(codePoints, 0x100, 0x17f, [0x0131, 0x0152, 0x0153]), [], 'Latin Extended-A missing in ' + path.basename(face.file));
  assert.equal(missing(codePoints, 0x41, 0x5a).length, 26, 'the latin-ext file has no ASCII letters');
});

test('every face covers more of its own range than the other file does', () => {
  const faces = readFontFaces();
  const files = Object.keys(faces).map((name) => ({ name, codePoints: readCodePoints(faces[name].file) }));
  Object.keys(faces).forEach((name) => {
    const coverage = (codePoints) => faces[name].ranges.reduce((count, range) => {
      for (let c = range.start; c <= range.end; c++) {
        count += codePoints.has(c) ? 1 : 0;
      }
      return count;
    }, 0);
    const own = files.find((entry) => entry.name === name);
    const other = files.find((entry) => entry.name !== name);
    assert.ok(coverage(own.codePoints) > coverage(other.codePoints), name + ' loads the file of the other face');
  });
});
