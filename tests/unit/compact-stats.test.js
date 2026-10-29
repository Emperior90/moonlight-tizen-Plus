'use strict';

// Pins the front end of the three levels of the performance statistics (Off, Compact, Full): the compact line that
// formatCompactStatsLine() in wasm/platform/messages.js builds from the figures of a 'StatCompactMsg: ' message (the
// messages of tests/fixtures/compact-stats.tsv, whose writing side tests/native/compact_stats_test.cpp checks), so it
// never parses the translated text of the full statistics; the translation of its labels and of the lines of the frame
// intervals; the levels that index.js reads from the setting (a stored true of the earlier switch is Full); and that all
// four ways of toggling the statistics (YELLOW, the Stream Menu, the gamepad combo and the keyboard combo) end up in
// TogglePerformanceStats() of the module, which steps the level. The browser tests show the line in the real page
// (tests/browser/performance-stats-levels.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The lines of the fixture as { message, line }
function readFixture() {
  return read('tests/fixtures/compact-stats.tsv')
    .split('\n')
    .filter((line) => line && line[0] !== '#')
    .map((line) => {
      const fields = line.split('\t');
      return { message: fields[11], line: fields[12] };
    });
}

// messages.js with a translation function: the source texts, or each key marked as T[key]
function loadMessages(markKeys) {
  const format = (text, values) => text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  const t = (text, ...values) => format(markKeys ? 'T[' + text + ']' : text, values);
  return loadPlatformScripts(['wasm/platform/messages.js'], { globals: { t } });
}

test('the compact line of each message of the fixture', () => {
  const platform = loadMessages(false);
  const parse = platform.get('parseCompactStats');
  const format = platform.get('formatCompactStatsLine');
  const cases = readFixture();
  assert.equal(cases.length, 6);
  for (const entry of cases) {
    assert.ok(entry.message.indexOf('StatCompactMsg: ') === 0, entry.message);
    const data = parse(entry.message.slice('StatCompactMsg: '.length));
    assert.ok(data, entry.message);
    assert.equal(format(data), entry.line);
  }
});

test('the example line of the owner, with the stream as the setting names it and the figures that are known', () => {
  const platform = loadMessages(false);
  const line = platform.get('formatCompactStatsLine')(plain({ w: 3840, h: 2160, fps: 60, codec: 'HEVC', bits: 10, hdr: 1, rfps: 59.94,
    mbps: 74.2, rtt: 3, drop: 0.1, delay: 6.3 }));
  assert.equal(line, '4K60 HEVC HDR · 59.9 fps · 74 Mb/s · RTT 3 ms · Net drops 0.1% · Wait+pacing 6.3 ms');
  // One line: no line break, whatever the figures
  assert.equal(line.indexOf('\n'), -1);
  // Below 10 Mb/s with one decimal, and a 10-bit stream without HDR
  assert.equal(platform.get('formatCompactStatsLine')(plain({ w: 1920, h: 1080, fps: 60, codec: 'AV1', bits: 10, hdr: 0, rfps: null,
    mbps: 4.04, rtt: null, drop: null, delay: null })), '1080p60 AV1 10-bit · 4.0 Mb/s');
});

test('a message that is not an object of figures is no compact line', () => {
  const parse = loadMessages(false).get('parseCompactStats');
  for (const text of ['', 'not json', '[1,2]', '{}', '{"w":3840,"h":2160}', '{"w":"x","h":2160,"fps":60}', 'null', '42']) {
    assert.equal(parse(text), null, text);
  }
  assert.ok(parse('{"w":1280,"h":720,"fps":30,"codec":"HEVC","bits":8,"hdr":0}'));
});

test('the labels of the compact line and of the frame intervals go through the translation', () => {
  const platform = loadMessages(true);
  const line = platform.get('formatCompactStatsLine')(plain({ w: 3840, h: 2160, fps: 60, codec: 'HEVC', bits: 10, hdr: 1, rfps: 60,
    mbps: 80, rtt: 2, drop: 0, delay: 1 }));
  assert.equal(line, '4K60 HEVC HDR · 60.0 fps · 80 Mb/s · RTT 2 ms · T[Net drops] 0.0% · T[Wait+pacing] 1.0 ms');
  const text = platform.get('replaceKnownStatsLabels')(
    'Pending frames: 0 (max 1)\n' +
    'Host frame intervals: deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence\n' +
    'TV player frame intervals: deviation 1.23 ms, p95 18.3 ms, 2.5% off cadence\n');
  assert.ok(text.indexOf('T[Host frame intervals:] T[deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence]') >= 0, text);
  assert.ok(text.indexOf('T[TV player frame intervals:] T[deviation 1.23 ms, p95 18.3 ms, 2.5% off cadence]') >= 0, text);
  // The keys are in the locale files, with a translation for pt-BR that keeps the placeholders
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  const portuguese = JSON.parse(read('wasm/static/locales/pt-BR.json'));
  for (const key of ['Net drops', 'Wait+pacing', 'Host frame intervals:', 'TV player frame intervals:',
    'deviation %1$s ms, p95 %2$s ms, %3$s% off cadence', 'Compact', 'Full', 'Off']) {
    assert.equal(english[key], key);
    assert.ok(portuguese[key] && portuguese[key] !== key, key);
    assert.deepEqual(portuguese[key].match(/%\d\$s/g), key.match(/%\d\$s/g), key);
  }
});

test('the level of a stored or chosen value, with the true of the earlier switch as Full', () => {
  const parse = loadPlatformScripts(INDEX_SCRIPTS).get('parsePerformanceStatsLevel');
  const cases = [[true, 2], [false, 0], [null, 0], [undefined, 0], [0, 0], [1, 1], [2, 2], ['0', 0], ['1', 1], ['2', 2],
    [3, 0], [-1, 0], [1.5, 0], ['Full', 0], [NaN, 0], [{}, 0]];
  for (const [value, level] of cases) {
    assert.equal(parse(value), level, String(value));
  }
});

test('all four ways of toggling the statistics step the level in the module', () => {
  // YELLOW on the remote and the entry of the Stream Menu call the module
  assert.match(read('wasm/platform/remote_controller.js'), /case tvKey\.KEY_YELLOW:[\s\S]{0,200}Module\.toggleStats\(\);/);
  assert.match(read('wasm/platform/menus.js'), /id === 'streamMenuStats'\) \{[\s\S]{0,300}Module\.toggleStats\(\);/);
  // The gamepad combo and the keyboard combo call toggleStats() of main.cpp (tests/native/gamepad_behaviour_test.cpp and
  // input_release_test.cpp run them), which is the function the front end calls
  assert.match(read('wasm/gamepad.cpp'), /physicalFlags == PERF_STATS_BUTTONS\)[\s\S]{0,200}toggleStats\(\);/);
  assert.match(read('wasm/input.cpp'), /keyCode == 0x53\)[\s\S]{0,120}toggleStats\(\);/);
  const main = read('wasm/main.cpp');
  assert.match(main, /void toggleStats\(\) \{\s+g_Instance->TogglePerformanceStats\(\);\s+\}/);
  assert.match(main, /emscripten::function\("toggleStats", &toggleStats\);/);
  // The level of the setting starts the stream, clamped to the three levels
  assert.match(main, /m_PerformanceStatsLevel = ClampPerformanceStatsLevel\(performanceStats\);/);
  assert.match(read('wasm/platform/index.js'), /const performanceStats = getPerformanceStatsLevel\(\);/);
  // TogglePerformanceStats() steps the level and reports it (tests/native/stats_overlay_test.cpp runs it)
  const player = read('wasm/wasmplayer.cpp');
  assert.match(player, /const int level = CyclePerformanceStatsLevel\(m_PerformanceStatsLevel\);\s+[\s\S]{0,300}PostToJs\(FormatPerformanceStatsLevelMessage\(level\)\);/);
});
