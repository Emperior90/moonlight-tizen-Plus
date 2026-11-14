'use strict';

// Pins that the messages which the module sends again and again during a stream write no console line of their own
// (dispatchMessage() in wasm/platform/messages.js): the statistics ('StatMsg: ' about every 2 seconds, 'StatCompactMsg: '
// about every second) and the rumble of a game ('controllerRumble: ', up to 60 times per second; its own lines are in
// tests/unit/rumble.test.js). Writing the line cost more than handling the message, since the console hook of the
// diagnostic log makes a text of every line (tests/unit/diagnostics.test.js: it never kept these lines, and drops them
// before redacting them). Every other message keeps its line, the overlay still gets the statistics, and
// logFrequentMessages, set in the console of a debugger, brings the lines back. Also pins the first line of the full
// statistics, which names the app and the sound of the stream (streamBuildInfo of index.js, getStreamBuildInfo()).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

const FULL = 'StatMsg: {"rtt":3,"lost":0}\nVideo stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\nPending frames: 0 (max 1)\n';
const COMPACT = 'StatCompactMsg: {"w":3840,"h":2160,"fps":60,"codec":"HEVC","bits":10,"hdr":1,"rfps":59.94,"mbps":74.2,' +
  '"rtt":3,"drop":0.10,"delay":6.3}';

// Load messages.js during a running stream at the given level of the statistics (0 off, 1 compact, 2 full), with an
// overlay element that keeps the text it is given
function loadMessages(level, globals) {
  const overlay = {
    children: [],
    style: {},
    textContent: '',
    classList: { toggle() {} },
    querySelector: (selector) => overlay.children.find((child) => '.' + child.className === selector) || null,
    appendChild: (child) => overlay.children.push(child),
    insertBefore: (child) => overlay.children.unshift(child),
    removeChild: (child) => overlay.children.splice(overlay.children.indexOf(child), 1),
  };
  const platform = loadPlatformScripts(['wasm/platform/messages.js'], {
    globals: Object.assign({
      t: (text) => text,
      isInGame: true,
      wasmSessionStarted: true,
      PERFORMANCE_STATS_COMPACT: 1,
      PERFORMANCE_STATS_FULL: 2,
      getPerformanceStatsLevel: () => level,
      streamNetworkInfo: 'Network connection: Wi-Fi',
      refreshStreamNetworkInfo: () => {},
      document: {
        addEventListener() {},
        getElementById: (id) => (id === 'performance-stats' ? overlay : null),
        // The canvas of the graph has no context here, so nothing is drawn
        createElement: () => ({ className: '', textContent: '' }),
      },
    }, globals || {}),
  });
  return {
    platform,
    handleMessage: platform.get('handleMessage'),
    lines: () => platform.consoleMessages.map((message) => message.text.replace(/^%c\[[^\]]+\] color: \w+; /, '')),
    text: () => {
      const element = overlay.querySelector('.stats-text');
      return element ? element.textContent : '';
    },
  };
}

test('the statistics messages write no console line, and the overlay still shows them', () => {
  const full = loadMessages(2);
  for (let i = 0; i < 30; i++) {
    full.handleMessage(FULL);
  }
  assert.deepEqual(full.lines(), []);
  assert.equal(full.text(), 'Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\nPending frames: 0 (max 1)\nNetwork connection: Wi-Fi');
  assert.equal(full.platform.get('statsGraphPoints').length, 30);

  const compact = loadMessages(1);
  for (let i = 0; i < 30; i++) {
    compact.handleMessage(COMPACT);
  }
  assert.deepEqual(compact.lines(), []);
  assert.equal(compact.text(), '4K60 HEVC HDR · 59.9 fps · 74 Mb/s · RTT 3 ms · Net drops 0.1% · Wait+pacing 6.3 ms');

  // Nor the ones that are still on their way from another level, or at the level Off
  const off = loadMessages(0);
  off.handleMessage(FULL);
  off.handleMessage(COMPACT);
  assert.deepEqual(off.lines(), []);
  assert.equal(off.text(), '');
});

test('every other message keeps its console line, also one that only names a frequent message', () => {
  const app = loadMessages(2);
  app.handleMessage('Some other message');
  app.handleMessage('A message about StatMsg: and controllerRumble: 0,1,1');
  // The texts start with the name of the message, so a longer name is another message
  app.handleMessage('StatMsgs: 1');
  assert.deepEqual(app.lines(), [
    'Message data:  Some other message',
    'Message data:  A message about StatMsg: and controllerRumble: 0,1,1',
    'Message data:  StatMsgs: 1',
  ]);
  // The three names are the ones that the diagnostic log drops, so the log loses nothing that it kept
  const frequent = /const FREQUENT_MESSAGE = \/\^\(\?:([A-Za-z|]+)\): \/;/.exec(read('wasm/platform/messages.js'))[1];
  const noise = /const NOISE = \/\^\\\[messages\\\.js, handleMessage\\\] Message data: \+\(\?:([A-Za-z|]+)\): \/;/.exec(read('wasm/platform/diagnostics.js'))[1];
  assert.equal(frequent, 'StatMsg|StatCompactMsg|controllerRumble');
  assert.equal(noise, frequent);
});

test('logFrequentMessages brings the console line of every message back for a debugging session', () => {
  const app = loadMessages(2);
  assert.equal(app.platform.get('logFrequentMessages'), false);
  app.platform.run('logFrequentMessages = true;');
  app.handleMessage(FULL);
  app.handleMessage(COMPACT);
  assert.deepEqual(app.lines(), ['Message data:  ' + FULL, 'Message data:  ' + COMPACT]);
});

test('the full statistics start with the line about the app and the sound of the stream', () => {
  const app = loadMessages(2, { streamBuildInfo: 'Moonlight Plus 2.3.1 · TV media player (EMSS) · 5.1 Efficient' });
  app.handleMessage(FULL);
  assert.equal(app.text(), 'Moonlight Plus 2.3.1 · TV media player (EMSS) · 5.1 Efficient\n' +
    'Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\nPending frames: 0 (max 1)\nNetwork connection: Wi-Fi');
  // The compact line stays one line
  const compact = loadMessages(1, { streamBuildInfo: 'Moonlight Plus 2.3.1 · TV media player (EMSS) · 5.1 Efficient' });
  compact.handleMessage(COMPACT);
  assert.equal(compact.text().indexOf('Moonlight'), -1);
});

test('the line names the version, the audio backend as the settings name it and the audio setting in effect', () => {
  const platform = loadPlatformScripts(['wasm/platform/tv_profile.js', 'wasm/platform/index.js'], { tv: { tv: 's90c', conn: 'wifi' } });
  platform.context.t = (text) => '<' + text + '>';
  const line = platform.get('getStreamBuildInfo');
  const streamConfig = platform.get('getStreamAudioConfig');
  // The media player of the TV plays what the settings ask for; only 5.1 and 7.1 have a surround audio quality
  assert.equal(line('Moonlight Plus 2.3.1', 'EMSS', '51Surround', 'Efficient'), 'Moonlight Plus 2.3.1 · <TV media player (EMSS)> · 5.1 <Efficient>');
  assert.equal(line('Moonlight Plus 2.3.1', 'EMSS', '51Surround', 'High'), 'Moonlight Plus 2.3.1 · <TV media player (EMSS)> · 5.1 <High>');
  assert.equal(line('Moonlight Plus 2.3.1', 'EMSS', '71Surround', 'Efficient'), 'Moonlight Plus 2.3.1 · <TV media player (EMSS)> · 7.1 <Efficient>');
  assert.equal(line('Moonlight Plus 2.3.1', 'EMSS', '71Surround', 'High'), 'Moonlight Plus 2.3.1 · <TV media player (EMSS)> · 7.1 <High>');
  assert.equal(line('Moonlight Plus 2.3.1', 'EMSS', 'Stereo', 'Efficient'), 'Moonlight Plus 2.3.1 · <TV media player (EMSS)> · <Stereo>');
  assert.equal(line('Moonlight Plus 2.3.1', 'EMSS', 'Stereo', 'High'), 'Moonlight Plus 2.3.1 · <TV media player (EMSS)> · <Stereo>');
  // Web Audio always streams stereo, whatever the settings store (getStreamAudioConfig())
  for (const stored of ['Stereo', '51Surround', '71Surround']) {
    assert.equal(line('Moonlight Plus 2.3.1', 'WebAudio', streamConfig(stored, 'WebAudio'), 'Efficient'),
      'Moonlight Plus 2.3.1 · <Browser (Web Audio)> · <Stereo>', stored);
  }
  // No audio output: no audio setting is in effect
  assert.equal(line('Moonlight Plus 2.3.1', 'Disabled', '71Surround', 'High'), 'Moonlight Plus 2.3.1 · <No audio output>');
  // What the module does with values that it doesn't know: the media player of the TV, and stereo (wasm/main.cpp)
  assert.equal(line('Moonlight Plus 2.3.1', 'Other', 'Quad', 'High'), 'Moonlight Plus 2.3.1 · <TV media player (EMSS)> · <Stereo>');
  // A development build names its commit, and the line is one line
  const version = platform.get('getBuildVersion');
  assert.equal(version('2.3.1'), '2.3.1');
  for (const backend of ['EMSS', 'WebAudio', 'Disabled']) {
    assert.equal(line('Moonlight Plus-ForceGM 2.3.1 (pre-abc1234)', backend, '51Surround', 'High').indexOf('\n'), -1);
  }

  // startGame() builds it from what this start sends: the audio backend, the audio configuration of the stream and
  // the surround audio quality that the start request carries, with the name and version as System information has them
  const index = read('wasm/platform/index.js');
  const start = index.slice(index.indexOf('function startGame('));
  assert.match(start, /streamBuildInfo = getStreamBuildInfo\(appInfo\.name \+ \(checkForceGMVariant\(\) \? '-ForceGM' : ''\) \+ ' ' \+ getBuildVersion\(appInfo\.version\),\s+audioBackend, audioConfig, surroundQuality\);/);
  assert.match(start, /var audioConfig = getStreamAudioConfig\(audioConfigSetting, audioBackend\);/);
  // The texts are the ones of the settings
  const html = read('wasm/index.html');
  for (const text of ['TV media player (EMSS)', 'Browser (Web Audio)', 'Stereo', 'Efficient', 'High']) {
    assert.ok(html.indexOf('data-i18n="' + text + '"') >= 0, text);
  }
});
