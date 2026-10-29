'use strict';

// Checks that each @font-face of wasm/static/css/roboto.css loads the Roboto file that has the glyphs of its
// unicode-range. Before 1.19.101 the latin face (ASCII and Latin-1) loaded the latin-ext file, which has no ASCII
// glyphs, and the other way round, so the TV drew the UI text in a fallback font wherever no Roboto was installed.
//
// The test reads the character map (cmap) of the WOFF2 files itself: the table directory, the Brotli-compressed table
// data (zlib of Node) and the cmap subtables of format 4 and 12.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { REPO_ROOT } = require('../lib/dev-modules');

const CSS_FILE = path.join(REPO_ROOT, 'wasm/static/css/roboto.css');

// Tags of the known tables of WOFF2, by their index in the flags byte (WOFF2 specification, 5.1)
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
  'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln',
  'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf',
  'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

// Return the raw cmap table of a WOFF2 font
function readWoff2Cmap(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.toString('latin1', 0, 4), 'wOF2', file + ' is not a WOFF2 file');
  const numTables = data.readUInt16BE(12);
  const totalCompressedSize = data.readUInt32BE(20);
  let offset = 48;
  const readBase128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = data[offset++];
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) {
        return value;
      }
    }
    throw new Error('invalid UIntBase128 in ' + file);
  };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = data[offset++];
    let tag;
    if ((flags & 0x3f) === 63) {
      tag = data.toString('latin1', offset, offset + 4);
      offset += 4;
    } else {
      tag = KNOWN_TAGS[flags & 0x3f];
    }
    const version = flags >> 6;
    const origLength = readBase128();
    // glyf and loca are transformed with version 0, every other table with a version other than 0
    const transformed = (tag === 'glyf' || tag === 'loca') ? version !== 3 : version !== 0;
    const length = transformed ? readBase128() : origLength;
    tables.push({ tag, length });
  }
  const stream = zlib.brotliDecompressSync(data.subarray(offset, offset + totalCompressedSize));
  let position = 0;
  for (const table of tables) {
    if (table.tag === 'cmap') {
      return stream.subarray(position, position + table.length);
    }
    position += table.length;
  }
  throw new Error('no cmap table in ' + file);
}

// Return the set of code points that the font maps to a glyph other than .notdef
function readCodePoints(file) {
  const cmap = readWoff2Cmap(file);
  const codePoints = new Set();
  const numSubtables = cmap.readUInt16BE(2);
  for (let i = 0; i < numSubtables; i++) {
    const platformId = cmap.readUInt16BE(4 + i * 8);
    const encodingId = cmap.readUInt16BE(6 + i * 8);
    const subtable = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(subtable);
    const unicode = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!unicode) {
      continue;
    }
    if (format === 4) {
      const segCount = cmap.readUInt16BE(subtable + 6) / 2;
      const endCodes = subtable + 14;
      const startCodes = endCodes + segCount * 2 + 2;
      const idDeltas = startCodes + segCount * 2;
      const idRangeOffsets = idDeltas + segCount * 2;
      for (let s = 0; s < segCount; s++) {
        const start = cmap.readUInt16BE(startCodes + s * 2);
        const end = cmap.readUInt16BE(endCodes + s * 2);
        const delta = cmap.readInt16BE(idDeltas + s * 2);
        const rangeOffset = cmap.readUInt16BE(idRangeOffsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph;
          if (rangeOffset === 0) {
            glyph = (c + delta) & 0xffff;
          } else {
            const glyphIndexAddress = idRangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
            glyph = cmap.readUInt16BE(glyphIndexAddress);
            glyph = glyph === 0 ? 0 : (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) {
            codePoints.add(c);
          }
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(subtable + 12);
      for (let g = 0; g < groups; g++) {
        const start = cmap.readUInt32BE(subtable + 16 + g * 12);
        const end = cmap.readUInt32BE(subtable + 20 + g * 12);
        const startGlyph = cmap.readUInt32BE(subtable + 24 + g * 12);
        for (let c = start; c <= end; c++) {
          if (startGlyph + (c - start) !== 0) {
            codePoints.add(c);
          }
        }
      }
    }
  }
  return codePoints;
}

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
