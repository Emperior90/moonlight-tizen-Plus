'use strict';

// Checks the translation of the audio lines of the performance stats: wasm/audio_stream_stats.hpp writes them in
// English (pinned by tests/native/audio_stream_stats_test.cpp) and replaceKnownStatsLabels() of
// wasm/platform/messages.js translates their labels, the channel layout, the channel count and the packet duration,
// with the real locale files. The video lines around them keep their translation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const readLocale = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales', name + '.json'), 'utf8'));
const NATIVE_TEST = fs.readFileSync(path.join(REPO_ROOT, 'tests/native/audio_stream_stats_test.cpp'), 'utf8');

// Load messages.js with a t() that translates with the given locale like i18n.js does
function loadTranslator(locale) {
  const messages = readLocale(locale);
  const t = (key, ...values) => {
    const text = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key;
    return text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  };
  const platform = loadPlatformScripts(['wasm/platform/messages.js'], { globals: { t } });
  return platform.get('replaceKnownStatsLabels');
}

// Lines as the native test expects them from FormatAudioStreamStats()
const STEREO = 'Audio stream: Opus Stereo (2 channels), 5 ms packets, 256 kbps';
const SURROUND = 'Audio stream: Opus 5.1 surround (6 channels), 10 ms packets, 512 kbps';
const SEVEN = 'Opus 7.1 surround (8 channels), 5 ms packets, 0 kbps';
const ODD = 'Audio stream: Opus 4 channels, 2.5 ms packets, 0 kbps';
const LOST = 'Session audio packets lost by network: 3/400 (0.75%)';
const ERRORS = 'Session audio decode errors: 1, TV audio player rejections: 2';

test('the sample lines are those that the native test expects', () => {
  [STEREO, SURROUND, SEVEN, ODD, LOST, ERRORS].forEach((line) => assert.ok(NATIVE_TEST.includes(line), line));
});

test('English keeps the audio lines as they are', () => {
  const translate = loadTranslator('en-US');
  const text = [STEREO, LOST, ERRORS, 'Audio stream: Opus 7.1 surround (8 channels), 5 ms packets, N/A', ODD].join('\n');
  assert.equal(translate(text), text);
});

test('Brazilian Portuguese translates the labels, the layout, the channels and the packet duration', () => {
  const translate = loadTranslator('pt-BR');
  const pt = readLocale('pt-BR');
  const text = [
    'Video stream: 3840x2160 59.94 FPS (Codec: HEVC 10-bit HDR)',
    SURROUND,
    LOST,
    ERRORS,
    ODD,
    'Session frames dropped by the TV: 0 (video pipeline resets: 0)',
  ].join('\n');
  const lines = translate(text).split('\n');
  assert.equal(lines[0].indexOf(pt['Video stream:']), 0);
  assert.equal(lines[1], pt['Audio stream:'] + ' Opus ' + pt['5.1 surround'] + ' (' + pt['%1$s channels'].replace('%1$s', '6') + '), ' +
    pt['%1$s ms packets'].replace('%1$s', '10') + ', 512 kbps');
  assert.equal(lines[2], pt['Session audio packets lost by network:'] + ' 3/400 (0.75%)');
  assert.equal(lines[3], pt['Session audio decode errors:'] + ' 1, ' + pt['TV audio player rejections:'] + ' 2');
  assert.equal(lines[4], pt['Audio stream:'] + ' Opus ' + pt['%1$s channels'].replace('%1$s', '4') + ', ' + pt['%1$s ms packets'].replace('%1$s', '2.5') + ', 0 kbps');
  // The TV player line of the video stays apart from the audio player line
  assert.equal(lines[5].indexOf(pt['Session frames dropped by the TV:']), 0);
  assert.doesNotMatch(lines.join('\n'), /Audio stream|channels|ms packets|lost by network|decode errors|audio player/);
});

test('every layout name that the native code writes has a translation key', () => {
  const header = fs.readFileSync(path.join(REPO_ROOT, 'wasm/audio_stream_stats.hpp'), 'utf8');
  const names = Array.from(header.matchAll(/return "([^"]+)";/g), (match) => match[1]);
  assert.deepEqual(names, ['Mono', 'Stereo', '5.1 surround', '7.1 surround']);
  const en = readLocale('en-US');
  const pt = readLocale('pt-BR');
  names.concat(['Audio stream:', '%1$s channels', '%1$s ms packets', 'Session audio packets lost by network:',
    'Session audio decode errors:', 'TV audio player rejections:']).forEach((key) => {
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), 'en-US misses ' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(pt, key), 'pt-BR misses ' + key);
  });
});
