'use strict';

// Pins the graph of the full performance statistics in wasm/platform/messages.js: the point of the graph that a
// 'StatMsg: ' message carries on its first line (the messages of tests/fixtures/stats-graph-points.tsv, whose writing
// side tests/native/compact_stats_test.cpp checks) and the text after it, a text without a point shown as it is; the
// colour steps of the round-trip time for a local network (below 5, 5 to 9, 10 to 19, 20 ms or more) in colours of the
// theme; one slot per message of the full statistics, which come about every 2 seconds (every second stats window of
// the module, kFullStatsWindows in wasm/compact_stats.hpp), for the last 60 of them with gaps for the slots without
// figures; the time that the graph covers, which its label names; and the scale of the bars. The browser tests
// (tests/browser/stats-graph-position.test.js) draw it in the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

function loadMessages() {
  return loadPlatformScripts(['wasm/platform/messages.js'], { globals: { t: (text) => text } });
}

// The lines of the fixture as { line, rtt, lost }
function readFixture() {
  return read('tests/fixtures/stats-graph-points.tsv')
    .split('\n')
    .filter((line) => line && line[0] !== '#')
    .map((line) => {
      const fields = line.split('\t');
      return { line: fields[2], rtt: fields[3] === '' ? null : Number(fields[3]), lost: Number(fields[4]) };
    });
}

test('the point of each message of the fixture, and the text after it unchanged', () => {
  const parse = loadMessages().get('parseFullStatsMessage');
  const cases = readFixture();
  assert.equal(cases.length, 5);
  const text = 'Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\nPending frames: 0 (max 1)\n';
  for (const entry of cases) {
    assert.ok(entry.line.indexOf('StatMsg: ') === 0, entry.line);
    const message = entry.line + '\n' + text;
    assert.deepEqual(plain(parse(message.slice('StatMsg: '.length))), { point: { rtt: entry.rtt, lost: entry.lost }, text: text }, entry.line);
  }
});

test('a text without a point, or with a first line that is no point, is shown as it is', () => {
  const parse = loadMessages().get('parseFullStatsMessage');
  for (const text of ['Video stream: 3840x2160\nPending frames: 0\n', '', '{"rtt":3}', '{broken}\nVideo stream: 1920x1080\n',
    'Frames dropped: {"rtt":3}\n']) {
    assert.deepEqual(plain(parse(text)), { point: null, text: text }, JSON.stringify(text));
  }
  // Figures that aren't numbers count as unknown or none
  assert.deepEqual(plain(parse('{"rtt":"3","lost":-2}\nText')), { point: { rtt: null, lost: 0 }, text: 'Text' });
});

test('the colour steps of the RTT for a local network, in colours of the theme', () => {
  const messages = loadMessages();
  const step = messages.get('getStatsGraphRttStep');
  const steps = [1, 4, 4.9, 5, 9, 9.9, 10, 19, 20, 85, 4294967295].map((rtt) => step(rtt));
  assert.deepEqual(steps, [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 3]);
  // Unknown
  assert.deepEqual([null, 0, undefined, NaN].map((rtt) => step(rtt)), [-1, -1, -1, -1]);
  // Mint, amber, orange and red of style.css, grey for an unknown RTT and red for the drop marks
  const css = read('wasm/static/css/style.css');
  const token = (name) => new RegExp('--' + name + ': (#[0-9A-F]{6})', 'i').exec(css)[1].toUpperCase();
  const orange = /--grad-warm: linear-gradient\(120deg, #FF4D8D 0%, (#[0-9A-F]{6}) 100%\)/i.exec(css)[1].toUpperCase();
  assert.deepEqual(plain(messages.get('STATS_GRAPH_RTT_COLORS')), [token('mint'), token('amber'), orange, token('red')]);
  assert.equal(messages.get('STATS_GRAPH_UNKNOWN_COLOR'), token('text-3'));
  assert.equal(messages.get('STATS_GRAPH_DROP_COLOR'), token('red'));
});

test('one slot per message of the full statistics, about every 2 seconds, with gaps for the slots without figures', () => {
  const messages = loadMessages();
  const add = messages.get('addStatsGraphPoint');
  const points = () => plain(messages.get('statsGraphPoints'));
  // About every 2 seconds, as the decoder thread sends them: at every second stats window of a little more than a second
  for (let i = 0; i < 5; i++) {
    add({ rtt: i + 1, lost: 0 }, 10000 + i * 2033);
  }
  assert.deepEqual(points().map((point) => point.rtt), [1, 2, 3, 4, 5]);
  // A message that the main thread handles up to a second early or late leaves no gap and takes no second slot
  add({ rtt: 6, lost: 0 }, 10000 + 5 * 2033 + 900);
  add({ rtt: 7, lost: 0 }, 10000 + 6 * 2033);
  assert.deepEqual(points().map((point) => point.rtt), [1, 2, 3, 4, 5, 6, 7]);
  // No figures for 8 seconds (e.g. while the video track was closed): 3 empty slots before the next point
  add({ rtt: 9, lost: 2 }, 10000 + 6 * 2033 + 8000);
  assert.deepEqual(points().slice(-5), [{ rtt: 7, lost: 0 }, null, null, null, { rtt: 9, lost: 2 }]);
  // Only the last 60 slots stay
  for (let i = 0; i < 70; i++) {
    add({ rtt: 100 + i, lost: 0 }, 40000 + i * 2000);
  }
  assert.equal(points().length, 60);
  assert.equal(points()[0].rtt, 110);
  assert.equal(points()[59].rtt, 169);
  // Two minutes and more without figures leave only the new point after empty slots
  add({ rtt: 3, lost: 0 }, 40000 + 69 * 2000 + 600000);
  assert.equal(points().length, 60);
  assert.deepEqual(points().slice(-2), [null, { rtt: 3, lost: 0 }]);
  assert.equal(points().filter((point) => point !== null).length, 1);
  messages.get('resetStatsGraph')();
  assert.deepEqual(points(), []);
  // The first point after a reset has no gap before it, however long ago the last one came
  add({ rtt: 4, lost: 0 }, 999999999);
  assert.deepEqual(points(), [{ rtt: 4, lost: 0 }]);
});

test('a slot of the graph is the time between two messages of the module, and the label of the graph names its 2 minutes', () => {
  const messages = loadMessages();
  // The module sends the full statistics at every kFullStatsWindows-th stats window, and a window ends with the first
  // frame after 1000 ms
  const windows = Number(/^constexpr int kFullStatsWindows = (\d+);$/m.exec(read('wasm/compact_stats.hpp'))[1]);
  const windowMs = Number(/if \(m_ActiveWndVideoStats\.measurementStartTimestamp \+ (\d+) < nowMs\) \{/.exec(read('wasm/wasmplayer.cpp'))[1]);
  assert.equal(windows, 2);
  assert.equal(windowMs, 1000);
  assert.equal(messages.get('STATS_GRAPH_SLOT_MS'), windows * windowMs);
  assert.equal(messages.get('STATS_GRAPH_SLOTS'), 60);
  assert.equal(messages.get('getStatsGraphSpanLabel')(), '2 min');
  // The canvas says so next to the scale of the bars
  const texts = [];
  const context = {
    setTransform() {}, clearRect() {}, fillRect() {},
    measureText: (text) => ({ width: text.length * 8 }),
    fillText: (text) => texts.push(text),
  };
  messages.get('drawStatsGraph')({ getContext: () => context, width: 0, height: 0 }, [{ rtt: 30, lost: 0 }]);
  assert.deepEqual(texts, ['RTT', '0–50 ms \u00b7 2 min', 'Net drops']);
});

test('the bars reach up to 25 ms, or the next multiple of 25 ms above the highest RTT', () => {
  const scale = loadMessages().get('getStatsGraphScaleMs');
  assert.equal(scale([]), 25);
  assert.equal(scale([null, { rtt: null, lost: 3 }]), 25);
  assert.equal(scale([{ rtt: 3, lost: 0 }, { rtt: 25, lost: 0 }]), 25);
  assert.equal(scale([{ rtt: 3, lost: 0 }, null, { rtt: 26, lost: 0 }]), 50);
  assert.equal(scale([{ rtt: 120, lost: 0 }]), 125);
});
