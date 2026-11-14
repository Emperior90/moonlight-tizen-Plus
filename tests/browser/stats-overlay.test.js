'use strict';

// Checks the lighter full performance statistics of 2.3.1 in the real page:
// - their box costs the TV less to draw with each update: no text shadow and no blur, a smaller font with tighter
//   lines, and at most 860 pixels of text, where the few longer lines wrap. With every line that the module can send
//   at once, in every language and with text 10 % wider than this machine draws it (tests/browser/text-stress.js), the
//   box stays inside the safe area of the screen in each corner and nothing runs out of it;
// - without the shadow the white text is still readable over a bright picture, since the surface of the box is dark
//   enough: its contrast to the text over a white picture is at least 7:1;
// - the compact line keeps its one line in its pill, however long, without a text shadow either;
// - the first line of the full statistics names the app with its version, the audio backend as the settings name it
//   and the audio setting in effect (stereo, or 5.1 or 7.1 with the surround audio quality; always stereo with Web
//   Audio, whatever the settings store), in the language of the app, so that a photo of the overlay tells which build
//   and which audio path ran. It is one line, and the compact line doesn't have it;
// - the help text of the setting says how often each level updates: Compact every second, Full every 2 seconds;
// - the two lines that show what a bitrate costs keep their one line in every language: the bitrate line, which says
//   in few words that the received figure is the video alone while the configured bitrate also holds the error
//   correction (FEC) and the audio, and the frame receive time with its share of the frame time. The longest line sets
//   the width of the box, and a line that wraps adds to its height.
// The figures themselves and their two stats windows are pinned by tests/native/stats_overlay_test.cpp, the slots of
// the graph by tests/unit/stats-graph.test.js, the line by tests/unit/frequent-messages.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');
const { forEachTextWidth } = require('./text-stress');

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
const LANGUAGES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
// Every line that the module can send at once, with wide figures
const FULL_TEXT = 'Video stream: 3840x2160 119.88 FPS (Codec: HEVC 10-bit HDR)\n' +
  'Incoming frame rate from network: 119.88 FPS\n' +
  'Decoding frame rate: 119.88 FPS\n' +
  'Rendering frame rate: 119.88 FPS\n' +
  'Bitrate: 148.52 Mbps video received, 150.0 Mbps configured (with FEC and audio)\n' +
  'Host frame rate (30 s): 119.88 FPS\n' +
  'Host processing latency min/max/average: 4.1/12.9/6.3 ms\n' +
  'Frames dropped by your network connection: 0.42%\n' +
  'Average network latency: 12 ms (variance: 3 ms)\n' +
  'Average frame receive time: 13.21 ms (159% of the frame time)\n' +
  'Average frame wait time: 0.42 ms\n' +
  'Average frame pacing delay: 5.87 ms\n' +
  'Average rendering time: 0.31 ms\n' +
  'Pending frames: 1 (max 3)\n' +
  'Host frame intervals: deviation 0.47 ms, p95 17.0 ms, 0.0% off cadence\n' +
  'TV player frame intervals: deviation 1.92 ms, p95 19.4 ms, 3.1% off cadence\n' +
  'Session frames dropped by network: 1234 (0.42%)\n' +
  'Session frames dropped by the TV: 12 (video pipeline resets: 1)\n' +
  'Session recovery keyframes: 17\n' +
  'TV player rejections: buffer full 12 (10 recovered), keyframe required 3, track not ready 2, other 1 (last code -5)\n' +
  'Session FEC recoveries: 1234 blocks, 5678 packets (longest 12 ms, 3 slow, 2 failed)\n' +
  'Worst FEC block: 18 of 20 parity packets used\n' +
  'Audio stream: Opus 7.1 surround (8 channels), 10 ms packets, 450 kbps\n' +
  'Audio CPU: decode 104.21 ms/s (max 2.31 ms), output 66.42 ms/s (max 22.31 ms)\n' +
  'Session audio packets lost by network: 123/456789 (0.03%)\n' +
  'Session audio decode errors: 2, TV audio player rejections: 3\n' +
  'WASM heap top: 96 of 128 MB (+12 MB this stream)\n';
const COMPACT_MESSAGE = 'StatCompactMsg: {"w":3840,"h":2160,"fps":120,"codec":"HEVC","bits":10,"hdr":1,"rfps":119.88,"mbps":148.5,' +
  '"rtt":12,"drop":0.42,"delay":6.3}';

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

const sendFullStats = (page, text) => page.evaluate((body) => handleMessage('StatMsg: {"rtt":12,"lost":2}\n' + body), text);
const overlayLines = (page) => page.evaluate(() => {
  const element = document.querySelector('#performance-stats .stats-text');
  return element ? element.textContent.split('\n') : [];
});

// The contrast of two colours [r, g, b] as WCAG 2 defines it
function contrast(first, second) {
  const luminance = (colour) => {
    const [r, g, b] = colour.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

test('the full statistics are a small box without a text shadow that stays readable over a bright picture, in every language', async () => {
  for (const language of LANGUAGES) {
    const app = await openApp(harness, { tv: TV, stored: { performanceStats: 2, languagePreference: language, audioConfig: '71Surround' } });
    try {
      await app.page.waitForFunction((lang) => document.documentElement.getAttribute('lang') === lang, language, { timeout: 5000 });
      await startStream(app);
      // The app was hidden during the stream, so that the line about it shows as well
      await app.page.evaluate(() => {
        streamHiddenCount = 2;
        streamVideoTrackCloseCount = 1;
        streamVideoTrackCloseReason = 3;
      });
      await sendFullStats(app.page, FULL_TEXT);
      const lines = await overlayLines(app.page);
      // The line about the app, the 27 lines of the module, the network connection and the line about the background
      assert.equal(lines.length, 30, language);
      await forEachTextWidth(app.page, async (stress) => {
        for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
          await app.page.evaluate((value) => showStatsPosition(value), corner);
          const box = await app.page.evaluate(() => {
            const overlay = document.getElementById('performance-stats');
            const text = overlay.querySelector('.stats-text');
            const rect = overlay.getBoundingClientRect();
            const style = getComputedStyle(overlay);
            const textStyle = getComputedStyle(text);
            return {
              left: rect.left, top: rect.top, right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.bottom,
              width: rect.width, height: rect.height, textWidth: text.getBoundingClientRect().width,
              overflow: [overlay.scrollWidth - overlay.clientWidth, text.scrollWidth - text.clientWidth],
              shadows: [style.textShadow, textStyle.textShadow], filters: [style.filter, style.backdropFilter || style.webkitBackdropFilter || 'none'],
              fontSize: textStyle.fontSize, lineHeight: parseFloat(textStyle.lineHeight), color: textStyle.color,
              background: style.backgroundColor, whiteSpace: textStyle.whiteSpace, compact: overlay.classList.contains('is-compact'),
            };
          });
          const where = language + ' ' + corner + stress;
          assert.equal(box.compact, false, where);
          // Nothing that the TV renders over the video with each update
          assert.deepEqual(box.shadows, ['none', 'none'], where);
          assert.deepEqual(box.filters, ['none', 'none'], where);
          // A smaller box: 18 pixel text in tight lines, at most 860 pixels wide, and the longer lines wrap inside it
          assert.equal(box.fontSize, '18px', where);
          assert.ok(box.lineHeight <= 23, where + ' line height ' + box.lineHeight);
          assert.equal(box.whiteSpace, 'pre-wrap', where);
          assert.ok(box.textWidth <= 860.5, where + ' text width ' + box.textWidth);
          assert.ok(box.width <= 893, where + ' width ' + box.width);
          assert.deepEqual(box.overflow, [0, 0], where);
          // Inside the safe area of the screen, with every line there is
          assert.ok(box.left >= 64 && box.right >= 64 && box.top >= 48 && box.bottom >= 48, where + ' ' + JSON.stringify(box));
          // Its area, which the time to draw it follows: below 0.8 megapixels with every line (the box of 2.3.0 took
          // 1.06 megapixels in English and 1.35 in Spanish for these lines)
          if (!stress) {
            assert.ok(box.width * box.height <= 800000, where + ' area ' + Math.round(box.width * box.height));
          }
          // White text on a surface that is dark enough over a white picture, the brightest there is
          assert.equal(box.color, 'rgb(255, 255, 255)', where);
          const surface = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(box.background);
          assert.ok(surface, where + ' ' + box.background);
          const alpha = Number(surface[4]);
          const overWhite = [1, 2, 3].map((index) => Math.round(Number(surface[index]) * alpha + 255 * (1 - alpha)));
          assert.ok(contrast([255, 255, 255], overWhite) >= 7, where + ' contrast ' + contrast([255, 255, 255], overWhite).toFixed(2));
        }
      });
      assert.deepEqual(app.errors, [], language);
    } finally {
      await app.context.close();
    }
  }
});

test('the bitrate line and the frame receive time keep their one line in the box, in every language', async () => {
  for (const language of LANGUAGES) {
    const app = await openApp(harness, { tv: TV, stored: { performanceStats: 2, languagePreference: language, audioConfig: '71Surround' } });
    try {
      await app.page.waitForFunction((lang) => document.documentElement.getAttribute('lang') === lang, language, { timeout: 5000 });
      await startStream(app);
      await sendFullStats(app.page, FULL_TEXT);
      // The rows that each line of the text takes in the box
      const lines = await app.page.evaluate(() => {
        const text = document.querySelector('#performance-stats .stats-text');
        const node = text.firstChild;
        const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
        let offset = 0;
        return node.textContent.split('\n').map((line) => {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + line.length);
          offset += line.length + 1;
          return { line: line, rows: Math.round(range.getBoundingClientRect().height / lineHeight) };
        });
      });
      const bitrate = lines.filter((entry) => /148\.52 Mbps/.test(entry.line));
      const receive = lines.filter((entry) => /13\.21 ms/.test(entry.line));
      assert.equal(bitrate.length, 1, language);
      assert.equal(receive.length, 1, language);
      // Both figures of the bitrate and what the configured one holds besides the video, translated as a whole
      assert.match(bitrate[0].line, /148\.52 Mbps .*150\.0 Mbps .*\(.*FEC.*\)$/, language);
      assert.match(receive[0].line, /13\.21 ms \(159[ \u00a0]?% .*\)$/, language);
      if (language !== 'en-US') {
        assert.doesNotMatch(bitrate[0].line + receive[0].line, /received|configured|with FEC|of the frame time/, language);
      }
      assert.equal(bitrate[0].rows, 1, language + ': ' + bitrate[0].line);
      assert.equal(receive[0].rows, 1, language + ': ' + receive[0].line);
      // (the measurement tells a wrapped line: the line of the rejections of the player is longer than the box is wide)
      assert.ok(lines.filter((entry) => /12 \(10 /.test(entry.line))[0].rows >= 2, language);
      assert.deepEqual(app.errors, [], language);
    } finally {
      await app.context.close();
    }
  }
});

test('the compact line keeps its one line in its pill, however long, without a text shadow', async () => {
  const app = await openApp(harness, { tv: TV, stored: { performanceStats: 1, languagePreference: 'es-ES' } });
  try {
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'es-ES', null, { timeout: 5000 });
    await startStream(app);
    await app.page.evaluate((message) => handleMessage(message), COMPACT_MESSAGE);
    const pill = await app.page.evaluate(() => {
      const overlay = document.getElementById('performance-stats');
      const style = getComputedStyle(overlay);
      return {
        text: overlay.textContent, compact: overlay.classList.contains('is-compact'), maxWidth: style.maxWidth,
        whiteSpace: style.whiteSpace, shadow: style.textShadow, fontSize: style.fontSize,
        height: overlay.getBoundingClientRect().height, overflow: overlay.scrollWidth - overlay.clientWidth,
      };
    });
    assert.equal(pill.compact, true);
    // No line about the app in the compact line
    assert.equal(pill.text.indexOf('Moonlight'), -1);
    assert.ok(pill.text.indexOf('4K120 HEVC HDR') === 0, pill.text);
    assert.deepEqual([pill.maxWidth, pill.whiteSpace, pill.shadow, pill.fontSize], ['none', 'nowrap', 'none', '20px']);
    assert.ok(pill.height < 50, 'one line: ' + pill.height);
    assert.equal(pill.overflow, 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the first line of the full statistics names the app version, the audio backend and the audio setting in effect', async () => {
  // [stored settings, simulated TV, the end of the line]
  const cases = [
    [{}, {}, 'TV media player (EMSS) · Stereo'],
    // A stored 5.1 without a stored quality streams in the default quality, Efficient
    [{ audioConfig: '51Surround' }, {}, 'TV media player (EMSS) · 5.1 Efficient'],
    [{ audioConfig: '71Surround', surroundQuality: 'High' }, {}, 'TV media player (EMSS) · 7.1 High'],
    // Web Audio streams stereo whatever the settings store
    [{ audioBackend: 'WebAudio', audioConfig: '71Surround', surroundQuality: 'High' }, {}, 'Browser (Web Audio) · Stereo'],
    [{ audioBackend: 'Disabled', audioConfig: '51Surround' }, {}, 'No audio output'],
    // In the language of the app, with the names of the settings
    [{ audioConfig: '51Surround', languagePreference: 'de-DE' }, {}, 'TV-Mediaplayer (EMSS) · 5.1 Sparsam'],
    [{ audioBackend: 'Disabled', languagePreference: 'fr-FR' }, {}, 'Pas de sortie audio'],
  ];
  for (const [stored, tv, ending] of cases) {
    const app = await openApp(harness, { tv: Object.assign({}, TV, tv), stored: Object.assign({ performanceStats: 2 }, stored) });
    try {
      if (stored.languagePreference) {
        await app.page.waitForFunction((lang) => document.documentElement.getAttribute('lang') === lang, stored.languagePreference, { timeout: 5000 });
      }
      await startStream(app);
      await sendFullStats(app.page, FULL_TEXT);
      const lines = await overlayLines(app.page);
      const version = await app.page.evaluate(() => appInfo.version);
      assert.match(version, /^\d+\.\d+\.\d+$/);
      assert.equal(lines[0], 'Moonlight Plus ' + version + ' · ' + ending, JSON.stringify(stored));
      // One line: the text of the module follows it
      assert.ok(/3840x2160 119\.88 FPS/.test(lines[1]), lines[1]);
      assert.equal(lines.filter((line) => line.indexOf('Moonlight Plus') === 0).length, 1);
      assert.deepEqual(app.errors, [], JSON.stringify(stored));
    } finally {
      await app.context.close();
    }
  }
});

test('the ForceGM variant says so in the line, and the help text of the setting says how often each level updates', async () => {
  const app = await openApp(harness, { tv: Object.assign({ forceGM: true }, TV), stored: { performanceStats: 2 } });
  try {
    const help = await app.page.evaluate(() => $('#selectPerformanceStats').closest('.setting-option').find('.mdl-list__item-text-body').text().trim());
    assert.equal(help, '- Compact shows one line with the main figures over the stream, updated every second. Full shows every figure, ' +
      'updated every 2 seconds. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.');
    await startStream(app);
    await sendFullStats(app.page, FULL_TEXT);
    const version = await app.page.evaluate(() => appInfo.version);
    assert.equal((await overlayLines(app.page))[0], 'Moonlight Plus-ForceGM ' + version + ' · TV media player (EMSS) · Stereo');
    // The same name and version as System information shows
    const systemInfo = await app.page.evaluate(() => document.getElementById('systemInfoBtn').innerText);
    assert.ok(systemInfo.indexOf('App Version: Moonlight Plus-ForceGM v' + version) === 0, systemInfo.slice(0, 80));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
