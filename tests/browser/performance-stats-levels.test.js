'use strict';

// Checks the three levels of the performance statistics in the real page: the setting offers Off, Compact and Full,
// stores the level (a stored true of the earlier switch shows as Full) and starts the stream with it; during the stream
// YELLOW, the Stream Menu entry and the gamepad or keyboard combo (whose 'StatLevelMsg: ' the module sends on its own)
// step Off, Compact, Full, Off, and the setting, the Stream Menu and the overlay follow; YELLOW during 'Starting...'
// steps the setting, which the stream then starts with; the overlay shows only the figures of its level
// ('StatCompactMsg: ' as the compact line, 'StatMsg: ' as the full text) and drops the ones still on their way from
// another level or after the end of the stream; and the compact line sits top-left in one line on the dark surface of the theme, also in
// every other language of the app. The module stub steps the level like the module (tests/browser/mocks/moonlight-wasm.js); the native side is
// checked by tests/native/compact_stats_test.cpp and tests/native/stats_overlay_test.cpp.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { openApp, readStorage, reloadApp, startHarness, waitForStorage } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const TV = { tv: 's90c', conn: 'wifi' };
const YELLOW = [405, 'ColorF2Yellow'];
const PLAY_PAUSE = [10252, 'MediaPlayPause'];
const DOWN = [40, 'ArrowDown'];
const ENTER = [13, 'Enter'];

const COMPACT_MESSAGE = 'StatCompactMsg: {"w":3840,"h":2160,"fps":60,"codec":"HEVC","bits":10,"hdr":1,"rfps":59.94,"mbps":74.2,' +
  '"rtt":3,"drop":0.10,"delay":6.3}';
const COMPACT_LINE = '4K60 HEVC HDR · 59.9 fps · 74 Mb/s · RTT 3 ms · Net drops 0.1% · Wait+pacing 6.3 ms';
const FULL_MESSAGE = 'StatMsg: Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\n' +
  'Host frame intervals: deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence\n';

// Press and release a key of the remote on the focused element, like the TV delivers it
const remoteKey = (page, keyCode, key) => page.evaluate(({ code, name }) => {
  ['keydown', 'keyup'].forEach((type) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  });
}, { code: keyCode, name: key });

// Start a stream of app 8 on a simulated host, up to the launch request, which waits for finishStream()
async function beginStream(app) {
  await app.page.evaluate(async () => {
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null),
      launchApp: () => new Promise((resolve) => {
        window.__launch = resolve;
      }),
      quitApp: () => Promise.resolve(),
      toString: () => 'GAMING-PC',
    };
    window.__host = host;
    api = host;
    showApps = () => Promise.resolve();
    startGame(host, 8);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

// The host answers the launch request of beginStream(), and the stream reaches 'Connection Established'
async function finishStream(app) {
  await app.page.evaluate(async () => {
    window.__launch('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>');
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.__host.currentGame = 8;
    handleMessage('Connection Established');
  });
}

// Start a stream of app 8 on a simulated host that reaches 'Connection Established'
async function startStream(app) {
  await beginStream(app);
  await finishStream(app);
}

// What the page shows of the statistics: the level of the setting, its label, and the overlay
const statsState = (page) => page.evaluate(() => ({
  level: $('#selectPerformanceStats').attr('data-value'),
  label: $('#selectPerformanceStats').text().trim(),
  shown: $('#performance-stats').is(':visible'),
  compact: $('#performance-stats').hasClass('is-compact'),
  text: $('#performance-stats').text(),
}));

test('the setting offers Off, Compact and Full, stores the level and keeps it after a restart', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    let state = await statsState(app.page);
    assert.deepEqual([state.level, state.label], ['0', 'Off'], 'Off on a fresh install');
    const items = await app.page.evaluate(() => $('.performanceStatsMenu li').map((i, li) => li.getAttribute('data-value') + ' ' + li.textContent.trim()).get());
    assert.deepEqual(items, ['0 Off', '1 Compact', '2 Full']);
    // The remote reaches the menu in the Advanced Settings, and its three entries
    assert.ok((await app.page.evaluate(() => Views.AdvancedSettings.view.func())).indexOf('selectPerformanceStats') >= 0);
    assert.deepEqual(await app.page.evaluate(() => Array.prototype.map.call(Views.SelectPerformanceStatsMenu.view.func(),
      (item) => item.getAttribute('data-value'))), ['0', '1', '2']);
    await app.page.evaluate(() => $('.performanceStatsMenu li[data-value="1"]').trigger('click'));
    state = await statsState(app.page);
    assert.deepEqual([state.level, state.label], ['1', 'Compact']);
    await waitForStorage(app.page, (values) => values.performanceStats === 1);
    await reloadApp(app);
    state = await statsState(app.page);
    assert.deepEqual([state.level, state.label], ['1', 'Compact'], 'kept after a restart');
    await app.page.evaluate(() => $('.performanceStatsMenu li[data-value="2"]').trigger('click'));
    await waitForStorage(app.page, (values) => values.performanceStats === 2);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the true and false that the switch of earlier versions stored show as Full and Off', async () => {
  for (const [stored, level, label] of [[true, '2', 'Full'], [false, '0', 'Off'], ['broken', '0', 'Off']]) {
    const app = await openApp(harness, { tv: TV, stored: { performanceStats: stored } });
    try {
      const state = await statsState(app.page);
      assert.deepEqual([state.level, state.label], [level, label], String(stored));
      // The stored value stays until the level changes
      assert.equal((await readStorage(app.page)).performanceStats, stored);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the stream starts with the level of the setting', async () => {
  for (const level of [0, 1, 2]) {
    const app = await openApp(harness, { tv: TV, stored: { performanceStats: level } });
    try {
      await startStream(app);
      assert.equal(await app.page.evaluate(() => window.__startStreamArgs[28]), level);
      // The overlay waits for the first figures of the stream
      assert.equal((await statsState(app.page)).shown, false);
    } finally {
      await app.context.close();
    }
  }
});

test('YELLOW steps Off, Compact, Full, Off, and the overlay shows only the figures of its level', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await startStream(app);
    // Off: no figures show
    await app.page.evaluate((messages) => messages.forEach((message) => handleMessage(message)), [COMPACT_MESSAGE, FULL_MESSAGE]);
    assert.equal((await statsState(app.page)).shown, false);

    // Compact: the setting follows, and the overlay waits for the figures of the compact line
    await remoteKey(app.page, ...YELLOW);
    let state = await statsState(app.page);
    assert.deepEqual([state.level, state.label, state.shown], ['1', 'Compact', false]);
    await waitForStorage(app.page, (values) => values.performanceStats === 1);
    // Text of the full statistics still on its way from before is dropped
    await app.page.evaluate((message) => handleMessage(message), FULL_MESSAGE);
    assert.equal((await statsState(app.page)).shown, false);
    await app.page.evaluate((message) => handleMessage(message), COMPACT_MESSAGE);
    state = await statsState(app.page);
    assert.deepEqual([state.shown, state.compact, state.text], [true, true, COMPACT_LINE]);

    // Full: the compact line goes, and the full text replaces it
    await remoteKey(app.page, ...YELLOW);
    state = await statsState(app.page);
    assert.deepEqual([state.level, state.label, state.shown], ['2', 'Full', false]);
    await app.page.evaluate((message) => handleMessage(message), COMPACT_MESSAGE);
    assert.equal((await statsState(app.page)).shown, false);
    await app.page.evaluate((message) => handleMessage(message), FULL_MESSAGE);
    state = await statsState(app.page);
    assert.equal(state.shown, true);
    assert.equal(state.compact, false);
    assert.ok(state.text.indexOf('Video stream: 3840x2160 60.00 FPS') === 0, state.text);
    assert.ok(state.text.indexOf('Host frame intervals: deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence') >= 0, state.text);
    await waitForStorage(app.page, (values) => values.performanceStats === 2);
    // Emptied as the start of a stream and the retry after no video do it, its outlined surface doesn't stay behind
    await app.page.evaluate(() => $('#connection-warnings, #performance-stats').css('background', 'transparent').text(''));
    assert.equal((await statsState(app.page)).shown, false);
    await app.page.evaluate((message) => handleMessage(message), FULL_MESSAGE);
    assert.equal((await statsState(app.page)).shown, true);

    // Off again
    await remoteKey(app.page, ...YELLOW);
    state = await statsState(app.page);
    assert.deepEqual([state.level, state.label, state.shown, state.text], ['0', 'Off', false, '']);
    await app.page.evaluate((messages) => messages.forEach((message) => handleMessage(message)), [COMPACT_MESSAGE, FULL_MESSAGE]);
    assert.equal((await statsState(app.page)).shown, false);
    await waitForStorage(app.page, (values) => values.performanceStats === 0);
    assert.deepEqual(await app.page.evaluate(() => window.__wasmCalls.filter((call) => call.name === 'toggleStats').length), 3);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the last figures that the module sends after the end of the stream don\'t show the overlay over the app list', async () => {
  for (const [level, message] of [[1, COMPACT_MESSAGE], [2, FULL_MESSAGE]]) {
    const app = await openApp(harness, { tv: TV, stored: { performanceStats: level } });
    try {
      await startStream(app);
      await app.page.evaluate((text) => handleMessage(text), message);
      assert.equal((await statsState(app.page)).shown, true, 'shown during the stream at level ' + level);
      // RED or Disconnect: the end of the stream hides the overlay, then the decoder thread sends its last window
      await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
      assert.equal((await statsState(app.page)).shown, false);
      await app.page.evaluate((text) => handleMessage(text), message);
      const state = await statsState(app.page);
      assert.deepEqual([state.shown, await app.page.evaluate(() => isInGame)], [false, false], 'level ' + level);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('YELLOW during \'Starting...\' steps the level that the stream then starts with', async () => {
  // A stream that ended on Compact leaves the module on Compact; the next one starts on Compact as well
  const app = await openApp(harness, { tv: TV, stored: { performanceStats: 1 } });
  try {
    await startStream(app);
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await beginStream(app);
    await remoteKey(app.page, ...YELLOW);
    let state = await statsState(app.page);
    assert.deepEqual([state.level, state.label, state.shown], ['2', 'Full', false]);
    await waitForStorage(app.page, (values) => values.performanceStats === 2);
    await finishStream(app);
    // The module starts on the level that the setting shows, and the overlay shows the figures of that level
    assert.equal(await app.page.evaluate(() => window.__startStreamArgs[28]), 2);
    await app.page.evaluate((messages) => messages.forEach((message) => handleMessage(message)), [COMPACT_MESSAGE, FULL_MESSAGE]);
    state = await statsState(app.page);
    assert.deepEqual([state.shown, state.compact], [true, false]);
    // Both step together from there
    await remoteKey(app.page, ...YELLOW);
    state = await statsState(app.page);
    assert.deepEqual([state.level, state.label], ['0', 'Off']);
    assert.equal(await app.page.evaluate(() => window.__wasmCalls.filter((call) => call.name === 'toggleStats').length), 1);
    await app.page.evaluate((messages) => messages.forEach((message) => handleMessage(message)), [COMPACT_MESSAGE, FULL_MESSAGE]);
    assert.equal((await statsState(app.page)).shown, false);

    // The module still holds Off of that stream when the user picks Compact in the settings: YELLOW during the next
    // launch steps from Compact, the level that the setting shows, to Full
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await app.page.evaluate(() => $('.performanceStatsMenu li[data-value="1"]').trigger('click'));
    await beginStream(app);
    await remoteKey(app.page, ...YELLOW);
    assert.equal((await statsState(app.page)).level, '2');
    await finishStream(app);
    assert.equal(await app.page.evaluate(() => window.__startStreamArgs[28]), 2);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }

  // On Off with a fresh module, the first press during the launch isn't lost
  const fresh = await openApp(harness, { tv: TV });
  try {
    await beginStream(fresh);
    await remoteKey(fresh.page, ...YELLOW);
    assert.equal((await statsState(fresh.page)).level, '1');
    await finishStream(fresh);
    assert.equal(await fresh.page.evaluate(() => window.__startStreamArgs[28]), 1);
    await fresh.page.evaluate((message) => handleMessage(message), COMPACT_MESSAGE);
    const state = await statsState(fresh.page);
    assert.deepEqual([state.shown, state.compact, state.text], [true, true, COMPACT_LINE]);
    assert.deepEqual(fresh.errors, []);
  } finally {
    await fresh.context.close();
  }
});

test('the Stream Menu shows the level, steps it, and follows a level the gamepad or keyboard combo set', async () => {
  const app = await openApp(harness, { tv: TV, stored: { performanceStats: true } });
  try {
    await startStream(app);
    await remoteKey(app.page, ...PLAY_PAUSE);
    assert.equal(await app.page.evaluate(() => isStreamMenuOpen), true);
    const value = () => app.page.evaluate(() => ({
      text: $('#streamMenuStatsValue').text(),
      on: $('#streamMenuStatsValue').hasClass('is-on'),
    }));
    // A stored true is Full
    assert.deepEqual(await value(), { text: 'Full', on: true });
    await remoteKey(app.page, ...DOWN);
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'streamMenuStats');
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await value(), { text: 'Off', on: false });
    await remoteKey(app.page, ...ENTER);
    assert.deepEqual(await value(), { text: 'Compact', on: true });
    assert.equal(await app.page.evaluate(() => isStreamMenuOpen), true, 'the menu stays open');
    // The gamepad thread or the keyboard handler of the module reports a level on its own
    await app.page.evaluate(() => handleMessage('StatLevelMsg: 2'));
    assert.deepEqual(await value(), { text: 'Full', on: true });
    assert.equal((await statsState(app.page)).level, '2');
    // A level the module doesn't know is Off
    await app.page.evaluate(() => handleMessage('StatLevelMsg: 7'));
    assert.deepEqual(await value(), { text: 'Off', on: false });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the compact line sits top-left in one line on the dark surface of the theme, also in every other language', async () => {
  const localesDir = path.join(REPO_ROOT, 'wasm/static/locales');
  const languages = fs.readdirSync(localesDir).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, ''));
  assert.ok(languages.indexOf('pt-BR') >= 0 && languages.indexOf('de-DE') >= 0, languages.join(' '));
  for (const lang of languages) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, lang + '.json'), 'utf8'));
    const app = await openApp(harness, { tv: TV, stored: { performanceStats: 1, languagePreference: lang } });
    try {
      await app.page.waitForFunction((code) => document.documentElement.getAttribute('lang') === code, lang, { timeout: 5000 });
      // The setting names the stored level in the language of the app
      assert.equal(await app.page.evaluate(() => $('#selectPerformanceStats').text().trim()), messages['Compact']);
      await startStream(app);
      // The longest line: every figure with two-digit and three-digit numbers
      await app.page.evaluate(() => handleMessage('StatCompactMsg: {"w":1920,"h":1080,"fps":120,"codec":"HEVC","bits":10,"hdr":1,' +
        '"rfps":119.88,"mbps":148.6,"rtt":120,"drop":12.50,"delay":16.7}'));
      const layout = await app.page.evaluate(() => {
        const overlay = document.getElementById('performance-stats');
        const rect = overlay.getBoundingClientRect();
        const style = getComputedStyle(overlay);
        return {
          text: overlay.textContent,
          left: Math.round(rect.left), top: Math.round(rect.top), right: rect.right, height: rect.height,
          lineHeight: parseFloat(style.lineHeight), padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
          whiteSpace: style.whiteSpace, color: style.color, background: style.backgroundColor,
          filter: style.filter, backdrop: style.backdropFilter || style.webkitBackdropFilter || 'none',
          warningsLeft: document.getElementById('connection-warnings').getBoundingClientRect().left,
        };
      });
      const label = messages['Net drops'];
      if (lang !== 'en-US') {
        assert.notEqual(label, 'Net drops', lang + ' translates the label');
      }
      assert.ok(layout.text.indexOf('1080p120 HEVC HDR · 119.9 fps · 149 Mb/s · RTT 120 ms · ' + label + ' 12.5%') === 0, layout.text);
      // Where the overlay was before, inside the screen, and in one line
      assert.deepEqual([layout.left, layout.top], [64, 48]);
      assert.ok(layout.right < 1920 - 64, 'inside the screen: ' + layout.right);
      assert.equal(layout.whiteSpace, 'nowrap');
      assert.ok(layout.height <= layout.lineHeight + layout.padding + 1, JSON.stringify(layout));
      // White text on the dark surface of the theme, without a blur over the video
      assert.equal(layout.color, 'rgb(255, 255, 255)');
      assert.equal(layout.background, 'rgba(10, 13, 26, 0.8)');
      assert.equal(layout.filter, 'none');
      assert.equal(layout.backdrop, 'none');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});
