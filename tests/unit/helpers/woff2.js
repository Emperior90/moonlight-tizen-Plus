'use strict';

// Reads the character map (cmap) of a WOFF2 font without a font library: the table directory, the Brotli-compressed
// table data (zlib of Node) and the cmap subtables of format 4 and 12. Used by roboto-fonts.test.js and
// theme-assets.test.js.

const assert = require('node:assert/strict');
const fs = require('fs');
const zlib = require('zlib');

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

module.exports = { readCodePoints };
