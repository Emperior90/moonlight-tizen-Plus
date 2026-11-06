'use strict';

// Pins where the color range rule of wasm/video_config.hpp reaches the host: StartStream() in wasm/main.cpp is the only
// place that sets the color range of the stream configuration, which LiStartConnection() sends to the host, and it sets
// it once, through GetStreamColorRange() with the switches 'Full color range' and HDR and the video formats as they are
// offered to the host, after their last change (the fallback to H.264). So a stream with HDR on in a 10-bit format asks
// for the limited range whatever 'Full color range' says. The native tests can't run StartStream() (tests/native/stubs
// has no connection), and native/video_config_test.cpp checks GetStreamColorRange() itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The body of a function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

// The start of each match of a pattern with the flag g
function matchPositions(source, pattern) {
  const positions = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    positions.push(match.index);
  }
  return positions;
}

const main = read('wasm/main.cpp');
const startStream = functionBody(main, 'MessageResult MoonlightInstance::StartStream(');

test('StartStream() sets the color range once, through GetStreamColorRange() with the switches and the offered formats', () => {
  const assignments = matchPositions(startStream, /m_StreamConfig\.colorRange\s*=[^=]/g);
  assert.equal(assignments.length, 1, 'StartStream() must set m_StreamConfig.colorRange exactly once');
  assert.match(startStream, /\n {2}m_StreamConfig\.colorRange = GetStreamColorRange\(fullRange, hdrMode, m_StreamConfig\.supportedVideoFormats\);\n/);
  // The arguments are the switches of the start message
  assert.match(startStream, /\bbool hdrMode, bool fullRange\b/);
  assert.match(main, /#include "video_config\.hpp"/);
});

test('the color range follows the last change of the offered video formats and comes before the connection starts', () => {
  const rangeAt = startStream.indexOf('m_StreamConfig.colorRange = GetStreamColorRange(');
  const formatWrites = matchPositions(startStream, /m_StreamConfig\.supportedVideoFormats\s*(\||&)?=[^=]/g);
  assert.ok(formatWrites.length >= 2, 'the video formats are set in StartStream(): ' + formatWrites.length);
  assert.ok(Math.max.apply(null, formatWrites) < rangeAt, 'the video formats change after the color range was chosen');
  // The connection thread hands m_StreamConfig to LiStartConnection()
  const threadAt = startStream.indexOf('pthread_create(&m_ConnectionThread');
  assert.ok(threadAt > rangeAt, 'the connection thread starts before the color range is set');
});

test('no other source file of the module sets the color range of the stream configuration', () => {
  const wasmDir = path.join(REPO_ROOT, 'wasm');
  const writers = [];
  for (const name of fs.readdirSync(wasmDir)) {
    if (!/\.(cpp|hpp|c|h)$/.test(name)) {
      continue;
    }
    const count = matchPositions(fs.readFileSync(path.join(wasmDir, name), 'utf8'), /\bcolorRange\s*=[^=]/g).length;
    if (count > 0) {
      writers.push(name + ': ' + count);
    }
  }
  assert.deepEqual(writers, ['main.cpp: 1']);
});
