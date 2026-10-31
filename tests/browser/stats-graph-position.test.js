'use strict';

// Checks the graph of the full performance statistics and the setting 'Statistics position' in the real page:
// - the full statistics show a slim graph above their text, drawn on a canvas once per 'StatMsg: ' message from the point
//   on its first line (the round-trip time as a bar in the colour of its step for a local network, a red mark for a
//   second with frames lost on the network, a grey stub while the RTT is unknown), without that line in the text and
//   without any message or timer of its own; the compact line has no graph, and the graph starts again with a new level
//   or a new stream;
// - the setting offers the four corners, top left by default, reached with the remote, stored and kept after a restart,
//   named in the language of the app and reset by Restore Defaults; the compact line and the full statistics show in the
//   chosen corner inside the safe area, and at the top right the connection warnings move to the top left.
// The pure logic is pinned by tests/unit/stats-graph.test.js, the native side by tests/native/compact_stats_test.cpp and
// tests/native/stats_overlay_test.cpp.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
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
const TEXT = 'Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\nFrames dropped by your network connection: 0.10%\n';
const COMPACT_MESSAGE = 'StatCompactMsg: {"w":3840,"h":2160,"fps":60,"codec":"HEVC","bits":10,"hdr":1,"rfps":59.94,"mbps":74.2,' +
  '"rtt":3,"drop":0.10,"delay":6.3}';
// The colours of the graph: mint, amber, orange and red of the theme, grey for an unknown RTT
const MINT = [46, 230, 160];
const AMBER = [255, 197, 71];
const ORANGE = [255, 138, 76];
const RED = [255, 92, 122];
const GREY = [141, 150, 184];

// Start a stream of app 8 on a simulated host that reaches 'Connection Established'
async function startStream(app) {
  await app.page.evaluate(async () => {
    let launch = null;
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null),
      launchApp: () => new Promise((resolve) => {
        launch = resolve;
      }),
      resumeApp: () => Promise.resolve('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>'),
      quitApp: () => Promise.resolve(),
      toString: () => 'GAMING-PC',
    };
    api = host;
    showApps = () => Promise.resolve();
    startGame(host, 8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (launch) {
      launch('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    host.currentGame = 8;
    handleMessage('Connection Established');
  });
}

// Send the full statistics with the points of the graph [rtt, lost] (rtt null for unknown) one second apart, as the
// decoder thread does, on a clock of the test that starts at startMs
function sendFullStats(page, points, startMs) {
  return page.evaluate(({ list, text, start }) => {
    const realNow = Date.now;
    try {
      list.forEach((point, index) => {
        Date.now = () => start + index * 1000;
        handleMessage('StatMsg: {"rtt":' + point[0] + ',"lost":' + point[1] + '}\n' + text);
      });
    } finally {
      Date.now = realNow;
    }
  }, { list: points, text: TEXT, start: startMs || 1000000 });
}

// What the overlay shows: its children, its text, and the colour of the canvas at points of slots [slot, y] in CSS pixels
// (a slot is 8 pixels wide, its bar 6 pixels from x + 1)
const overlay = (page, probes) => page.evaluate((points) => {
  const element = document.getElementById('performance-stats');
  const canvas = element.querySelector('canvas');
  const colours = canvas ? points.map(([slot, y]) => {
    const ratio = canvas.width / 480;
    return Array.prototype.slice.call(canvas.getContext('2d').getImageData(Math.round((slot * 8 + 4) * ratio), Math.round(y * ratio), 1, 1).data);
  }) : [];
  return {
    shown: $(element).is(':visible'),
    children: Array.prototype.map.call(element.children, (child) => child.tagName.toLowerCase() + '.' + child.className),
    text: element.textContent,
    size: canvas ? [canvas.width, canvas.height, canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height] : null,
    colours: colours,
  };
}, probes || []);

// A colour of the canvas: [r, g, b] for an opaque pixel, null for an empty one
const colour = (rgba) => (rgba[3] === 0 ? null : rgba.slice(0, 3));

test('the full statistics show the graph of the RTT and the network drops above their text, one slot per message', async () => {
  const app = await openApp(harness, { tv: TV, stored: { performanceStats: 2 } });
  try {
    await startStream(app);
    await app.page.evaluate(() => {
      window.__draws = 0;
      const draw = drawStatsGraph;
      drawStatsGraph = function() {
        window.__draws++;
        return draw.apply(this, arguments);
      };
    });
    // 3 ms, 7 ms with 2 frames lost, 12 ms, 20 ms, unknown with 1 lost (the newest in slot 59)
    await sendFullStats(app.page, [[3, 0], [7, 2], [12, 0], [20, 0], ['null', 1]]);
    // Each bar from the bottom (y 72) up to its share of the scale (25 ms over 36 pixels), the drop marks at y 24 to 30
    const state = await overlay(app.page, [[55, 70], [55, 66], [56, 68], [56, 60], [57, 60], [57, 54], [58, 50], [58, 41],
      [59, 71], [59, 68], [55, 27], [56, 27], [59, 27]]);
    assert.equal(state.shown, true);
    assert.deepEqual(state.children, ['canvas.stats-graph', 'div.stats-text']);
    // The text without the point of the graph
    assert.equal(state.text, TEXT + 'Network connection: Wi-Fi (signal strength: 78 percent)');
    assert.deepEqual(state.size.slice(2), [480, 72]);
    assert.deepEqual(state.colours.map(colour), [
      MINT, null, // 3 ms: 4 pixels
      AMBER, null, // 7 ms: 10 pixels
      ORANGE, null, // 12 ms: 17 pixels
      RED, null, // 20 ms: 29 pixels
      GREY, null, // unknown: a stub of 2 pixels
      null, RED, RED, // the drop marks of the seconds with frames lost
    ]);
    assert.equal(await app.page.evaluate(() => window.__draws), 5);
    // Nothing draws between the messages
    await app.page.waitForTimeout(1200);
    assert.equal(await app.page.evaluate(() => window.__draws), 5);

    // 60 slots: the oldest point leaves on the left
    const many = Array.from({ length: 60 }, (value, index) => [index === 59 ? 40 : 2, 0]);
    await sendFullStats(app.page, many, 2000000);
    const full = await overlay(app.page, [[0, 70], [59, 45], [59, 41]]);
    // The highest RTT, 40 ms, raises the scale to 50 ms: its bar reaches 29 pixels
    assert.deepEqual(full.colours.map(colour), [MINT, RED, null]);
    assert.equal(await app.page.evaluate(() => statsGraphPoints.length), 60);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the compact line has no graph, and a new level, a new stream or text without a point start it again', async () => {
  const app = await openApp(harness, { tv: TV, stored: { performanceStats: 2 } });
  try {
    await startStream(app);
    await sendFullStats(app.page, [[3, 0], [4, 0], [5, 0]]);
    assert.equal(await app.page.evaluate(() => statsGraphPoints.length), 3);
    // Off, Compact: the compact line shows without a graph
    await app.page.evaluate(() => handleMessage('StatLevelMsg: 0'));
    await app.page.evaluate(() => handleMessage('StatLevelMsg: 1'));
    await app.page.evaluate((message) => handleMessage(message), COMPACT_MESSAGE);
    let state = await overlay(app.page);
    assert.deepEqual(state.children, ['div.stats-text']);
    // Full again: the graph starts with the next point, not with the seconds before
    await app.page.evaluate(() => handleMessage('StatLevelMsg: 2'));
    await sendFullStats(app.page, [[6, 0]], 5000000);
    assert.deepEqual(await app.page.evaluate(() => JSON.parse(JSON.stringify(statsGraphPoints))), [{ rtt: 6, lost: 0 }]);
    // Text without a point (e.g. from a module before the graph) shows without a graph
    await app.page.evaluate(() => {
      resetStatsGraph();
      handleMessage('StatMsg: Video stream: 1920x1080 60.00 FPS (Codec: HEVC)\n');
    });
    state = await overlay(app.page);
    assert.deepEqual([state.shown, state.children], [true, ['div.stats-text']]);
    // The overlay emptied by a script, as the start of a stream does, builds its elements again
    await sendFullStats(app.page, [[3, 0]], 6000000);
    await app.page.evaluate(() => $('#connection-warnings, #performance-stats').css('background', 'transparent').text(''));
    assert.equal((await overlay(app.page)).shown, false);
    await sendFullStats(app.page, [[4, 0]], 6001000);
    state = await overlay(app.page);
    assert.deepEqual([state.shown, state.children], [true, ['canvas.stats-graph', 'div.stats-text']]);
    // A new stream starts without the points of the one before
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await startStream(app);
    assert.deepEqual(await app.page.evaluate(() => statsGraphPoints.length), 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// What the setting shows
const positionSetting = (page) => page.evaluate(() => ({
  value: $('#selectStatsPosition').attr('data-value'),
  label: $('#selectStatsPosition').text().trim(),
}));

test('the setting offers the four corners, top left by default, reached with the remote, stored and kept', async () => {
  const app = await openApp(harness, { tv: TV });
  const { page } = app;
  try {
    assert.deepEqual(await positionSetting(page), { value: 'top-left', label: 'Top left' });
    assert.deepEqual(await page.evaluate(() => $('.statsPositionMenu li').map((i, li) => li.getAttribute('data-value') + ' ' + li.textContent.trim()).get()),
      ['top-left Top left', 'top-right Top right', 'bottom-left Bottom left', 'bottom-right Bottom right']);
    // Settings, DOWN to the Advanced Settings (the sixth section), OK, DOWN four times: the remote reaches it after the
    // statistics, before the Experimental block
    await page.evaluate(() => $('#settingsBtn').trigger('click'));
    await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await page.waitForTimeout(100);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Views.AdvancedSettings.view.current() === 'optimizeGamesBtn', null, { timeout: 3000 });
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown');
    }
    assert.equal(await page.evaluate(() => Views.AdvancedSettings.view.current()), 'selectStatsPosition');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'selectStatsPosition');
    // OK opens the menu, DOWN to Bottom right, OK chooses it
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => isPopupMenuActive('statsPositionMenu'));
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await waitForStorage(page, (values) => values.statsPosition === 'bottom-right');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'selectStatsPosition', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => isPopupMenuActive('statsPositionMenu')), false);
    assert.deepEqual(await positionSetting(page), { value: 'bottom-right', label: 'Bottom right' });
    assert.equal(await page.evaluate(() => document.getElementById('performance-stats').className), 'stats-bottom-right');

    await reloadApp(app);
    assert.deepEqual(await positionSetting(app.page), { value: 'bottom-right', label: 'Bottom right' });
    // Restore Defaults goes back to the top left
    await app.page.evaluate(() => restoreDefaultsSettingsValues());
    await waitForStorage(app.page, (values) => values.statsPosition === 'top-left');
    assert.deepEqual(await positionSetting(app.page), { value: 'top-left', label: 'Top left' });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the statistics show in the chosen corner inside the safe area, and the warnings make room at the top right', async () => {
  const app = await openApp(harness, { tv: TV, stored: { performanceStats: 1, statsPosition: 'broken' } });
  try {
    // A stored value that the app doesn't know is the top left
    assert.deepEqual(await positionSetting(app.page), { value: 'top-left', label: 'Top left' });
    await startStream(app);
    const place = async (position, level) => {
      await app.page.evaluate((corner) => $('.statsPositionMenu li[data-value="' + corner + '"]').trigger('click'), position);
      if (level === 1) {
        await app.page.evaluate((message) => handleMessage(message), COMPACT_MESSAGE);
      } else {
        await sendFullStats(app.page, [[3, 0], [9, 1]], 9000000 + Math.random() * 1000);
      }
      await app.page.evaluate(() => {
        $('#connection-warnings').css('background', 'rgba(0, 0, 0, 0.5)').text('Slow connection to PC.');
      });
      return app.page.evaluate(() => {
        const box = document.getElementById('performance-stats').getBoundingClientRect();
        const warnings = document.getElementById('connection-warnings').getBoundingClientRect();
        return {
          left: Math.round(box.left), top: Math.round(box.top), right: Math.round(window.innerWidth - box.right),
          bottom: Math.round(window.innerHeight - box.bottom), warningsLeft: Math.round(warnings.left),
          warningsRight: Math.round(window.innerWidth - warnings.right),
        };
      });
    };
    for (const level of [1, 2]) {
      await app.page.evaluate((value) => handleMessage('StatLevelMsg: ' + value), level);
      let box = await place('top-left', level);
      assert.deepEqual([box.left, box.top, box.warningsRight], [64, 48, 64], 'top left ' + level);
      box = await place('top-right', level);
      assert.deepEqual([box.right, box.top, box.warningsLeft], [64, 48, 64], 'top right ' + level);
      box = await place('bottom-left', level);
      assert.deepEqual([box.left, box.bottom, box.warningsRight], [64, 48, 64], 'bottom left ' + level);
      box = await place('bottom-right', level);
      assert.deepEqual([box.right, box.bottom, box.warningsRight], [64, 48, 64], 'bottom right ' + level);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the corners are named in the language of the app', async () => {
  const app = await openApp(harness, { tv: TV, stored: { languagePreference: 'de-DE', statsPosition: 'top-right' } });
  try {
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE', null, { timeout: 5000 });
    assert.deepEqual(await positionSetting(app.page), { value: 'top-right', label: 'Oben rechts' });
    assert.equal(await app.page.evaluate(() => $('#advancedSettings label[data-i18n="Statistics position"]').text().trim()), 'Position der Statistik');
    // A change of the language names the chosen corner again
    await app.page.evaluate(() => i18n.setLanguage('pt-BR'));
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'pt-BR', null, { timeout: 5000 });
    assert.deepEqual(await positionSetting(app.page), { value: 'top-right', label: 'Superior direito' });
    assert.equal((await readStorage(app.page)).statsPosition, 'top-right');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
