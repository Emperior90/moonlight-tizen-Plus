'use strict';

// Pins the parts of the UI around a running stream (from the earlier rounds of fixes): the network line and the labels
// of the performance statistics overlay, the screensaver of the TV, the Back key guard, the refresh of the codec modes
// of the host before a stream, the audio clock sync setting and the help texts that were corrected.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, reloadApp, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const overlayText = (page) => page.evaluate(() => $('#performance-stats').text());

// Put the performance statistics on the level Full during a running stream, as the module reports it after the stats
// key, so that the overlay shows the text of the full statistics ('StatMsg: '), which it does only during a stream
const showFullStats = (page) => page.evaluate(() => {
  isInGame = true;
  wasmSessionStarted = true;
  handleMessage('StatLevelMsg: 2');
});

// Run replaceKnownStatsLabels() with a translation function that marks every key, to see which labels it translates
function translatedLabels(page, text) {
  return page.evaluate((input) => {
    const original = window.t;
    window.t = (key) => 'T[' + key + ']';
    const result = replaceKnownStatsLabels(input);
    window.t = original;
    return result;
  }, text);
}

test('over Ethernet the overlay names the 100 Mbps port and shows the session totals', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'ethernet' } });
  try {
    await showFullStats(app.page);
    await app.page.evaluate(() => {
      updateStreamNetworkInfo();
      handleMessage('StatMsg: Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\nSession frames dropped by network: 0 (0.00%)\nSession recovery keyframes: 0\n');
    });
    const stats = await overlayText(app.page);
    assert.ok(stats.indexOf('Network connection: Ethernet (Samsung TVs usually have a 100 Mbps port)') >= 0, stats);
    assert.ok(stats.indexOf('Session recovery keyframes: 0') >= 0, stats);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('over Wi-Fi the overlay shows the signal strength, refreshed at most every 5 seconds', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await showFullStats(app.page);
    await app.page.evaluate(() => updateStreamNetworkInfo());
    await app.page.waitForTimeout(200);
    await app.page.evaluate(() => handleMessage('StatMsg: Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\n'));
    let stats = await overlayText(app.page);
    assert.ok(stats.indexOf('Network connection: Wi-Fi (signal strength: 78 percent)') >= 0, stats);
    await app.page.evaluate(() => {
      const original = tizen.systeminfo.getPropertyValue;
      tizen.systeminfo.getPropertyValue = (property, onSuccess, onError) => (property === 'WIFI_NETWORK'
        ? onSuccess({ status: 'ON', signalStrength: 0.42 })
        : original(property, onSuccess, onError));
      handleMessage('StatMsg: Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\n');
    });
    await app.page.waitForTimeout(200);
    stats = await overlayText(app.page);
    assert.ok(stats.indexOf('78 percent') >= 0, 'no refresh within 5 s: ' + stats);
    await app.page.evaluate(() => {
      lastWifiSignalRefreshMs = 0;
      handleMessage('StatMsg: Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\n');
    });
    await app.page.waitForTimeout(200);
    await app.page.evaluate(() => handleMessage('StatMsg: Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\n'));
    stats = await overlayText(app.page);
    assert.ok(stats.indexOf('42 percent') >= 0, 'refreshed after 5 s: ' + stats);
  } finally {
    await app.context.close();
  }
});

test('a Wi-Fi signal strength of NaN (reported by the S90C on Tizen 9) is left out', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', wifiSignal: 'nan' } });
  try {
    await showFullStats(app.page);
    await app.page.evaluate(() => updateStreamNetworkInfo());
    await app.page.waitForTimeout(200);
    await app.page.evaluate(() => handleMessage('StatMsg: Video stream: 3840x2160 60.00 FPS (Codec: HEVC 10-bit HDR)\n'));
    const stats = await overlayText(app.page);
    assert.ok(stats.indexOf('Network connection: Wi-Fi') >= 0 && stats.indexOf('signal strength') < 0, stats);
  } finally {
    await app.context.close();
  }
});

test('the overlay labels go through the translation', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await showFullStats(app.page);
    await app.page.evaluate(() => handleMessage('StatMsg: Incoming bitrate from network: 92.10 Mbps\nConfigured bitrate: 100.0 Mbps\nHost frame rate (30 s): 59.94 FPS\n'));
    const stats = await overlayText(app.page);
    assert.ok(stats.indexOf('Configured bitrate: 100.0 Mbps') >= 0 && stats.indexOf('Host frame rate (30 s): 59.94 FPS') >= 0, stats);
    const labels = await translatedLabels(app.page, [
      'Configured bitrate: 1', 'Host frame rate (30 s): 2', 'Session frames dropped by the TV: 1', 'Session FEC recoveries: 1',
      'Worst FEC block: 1', 'UDP receive buffer: 1', 'TV player rejections: buffer full 1 (1 recovered)', 'WASM heap top: 40 of 128 MB (+2 MB this stream)',
    ].join('\n'));
    ['Configured bitrate:', 'Host frame rate (30 s):', 'Session frames dropped by the TV:', 'Session FEC recoveries:', 'Worst FEC block:',
      'UDP receive buffer:', 'TV player rejections:', 'WASM heap top:'].forEach((label) => {
      assert.ok(labels.indexOf('T[' + label + ']') >= 0, label + ' in ' + labels);
    });
  } finally {
    await app.context.close();
  }
});

test('the overlay adds the audio and the TV drop lines', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await showFullStats(app.page);
    const stats = await app.page.evaluate(() => {
      const original = window.getAudioStatsLines;
      window.getAudioStatsLines = () => 'Audio buffer: 100 ms, lead avg 99 ms, min 97 ms, browser latency 30 ms';
      handleMessage('StatMsg: Session frames dropped by the TV: 0 (video pipeline resets: 0)\nSession FEC recoveries: 2 blocks, 3 packets (longest 1 ms, 0 slow, 0 failed)\n');
      window.getAudioStatsLines = original;
      return $('#performance-stats').text();
    });
    ['Audio buffer: 100 ms', 'Session frames dropped by the TV: 0', 'Session FEC recoveries: 2 blocks'].forEach((line) => {
      assert.ok(stats.indexOf(line) >= 0, line + ' in ' + stats);
    });
  } finally {
    await app.context.close();
  }
});

test('the screensaver of the TV is turned off once the stream connects and on again when it ends', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const states = await app.page.evaluate(() => {
      const calls = [];
      webapis.appcommon.setScreenSaver = (state, onSuccess) => {
        calls.push(state);
        if (onSuccess) {
          onSuccess();
        }
      };
      const originalApi = api;
      api = { refreshServerInfo: () => new Promise(() => {}) };
      const safe = (message) => {
        try {
          handleMessage(message);
        } catch (error) {
          calls.push('error: ' + error.message);
        }
      };
      showAppsMode();
      const beforeStream = calls.slice();
      isInGame = true;
      safe('Connection Established');
      safe('Connection Established');
      const during = calls.slice();
      isInGame = false;
      safe('streamTerminated: 0');
      const afterStream = calls.slice();
      safe('Connection Established');
      showAppsMode();
      api = originalApi;
      return { beforeStream, during, afterStream, end: calls.slice() };
    });
    assert.deepEqual(states.beforeStream, [], 'nothing requested before a stream');
    assert.deepEqual(states.during, [0], 'off once when the connection is established');
    assert.deepEqual(states.afterStream, [0, 1], 'on again when the stream ends');
    assert.deepEqual(states.end, [0, 1], 'a late connection after the stop does not turn it off');
  } finally {
    await app.context.close();
  }
});

test('the Back key clicks into the stream only while the pointer is not locked', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const clicks = await app.page.evaluate(() => {
      const video = document.getElementById('wasm_module');
      let downs = 0;
      const onDown = () => {
        downs++;
      };
      video.addEventListener('mousedown', onDown);
      isInGame = true;
      video.dispatchEvent(new KeyboardEvent('keydown', { key: 'XF86Back', bubbles: true }));
      const unlocked = downs;
      Object.defineProperty(document, 'pointerLockElement', { get: () => video, configurable: true });
      video.dispatchEvent(new KeyboardEvent('keydown', { key: 'XF86Back', bubbles: true }));
      const locked = downs - unlocked;
      delete document.pointerLockElement;
      isInGame = false;
      video.removeEventListener('mousedown', onDown);
      return { unlocked, locked };
    });
    assert.deepEqual(clicks, { unlocked: 1, locked: 0 });
    assert.ok(await app.page.evaluate(() => window.__wasmCalls.some((call) => call.name === 'sendKeyboardEvent')), 'Escape was sent to the host');
  } finally {
    await app.context.close();
  }
});

test('the codec modes of the host are read again before a stream, bounded in time, with the earlier ones as fallback', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const result = await app.page.evaluate(async () => {
      const fresh = { serverCodecModeSupport: 0x101, refreshServerInfo() {
        this.serverCodecModeSupport = 0x30301;
        return Promise.resolve();
      } };
      const failing = { serverCodecModeSupport: 0x101, refreshServerInfo() {
        return Promise.reject(-1);
      } };
      const hanging = { serverCodecModeSupport: 0x101, refreshServerInfo() {
        return new Promise(() => {});
      } };
      const t0 = performance.now();
      const a = await refreshCodecModesBeforeStream(fresh);
      const b = await refreshCodecModesBeforeStream(failing);
      const t1 = performance.now();
      const c = await refreshCodecModesBeforeStream(hanging);
      const t2 = performance.now();
      return { a, b, c, quick: t1 - t0, hang: t2 - t1 };
    });
    assert.equal(result.a, 0x30301, 'the fresh value after the launch request');
    assert.equal(result.b, 0x101, 'the earlier value when the refresh fails');
    assert.ok(result.quick < 500, JSON.stringify(result));
    assert.equal(result.c, 0x101, 'the earlier value after the timeout');
    assert.ok(result.hang >= 1400 && result.hang < 2500, 'the 1.5 s timeout: ' + JSON.stringify(result));
  } finally {
    await app.context.close();
  }
});

test('audio clock sync is offered only with the Web Audio backend, off by default, and kept after a restart', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const visibility = () => app.page.evaluate(() => ({
      sync: $('#audioClockSyncOption').is(':visible'),
      jitter: $('#audioJitterOption').is(':visible'),
      checked: document.getElementById('audioClockSyncSwitch').checked,
    }));
    const openAudioSettings = async () => {
      await app.page.evaluate(() => showSettings());
      await app.page.waitForTimeout(500);
      await app.page.evaluate(() => handleSettingsView('audioSettings'));
      await app.page.waitForTimeout(300);
    };
    await openAudioSettings();
    await app.page.evaluate(() => saveAudioBackend.call($('.audioBackendMenu li[data-value="EMSS"]')[0]));
    assert.equal((await visibility()).sync, false, 'hidden with EMSS');
    await app.page.evaluate(() => saveAudioBackend.call($('.audioBackendMenu li[data-value="WebAudio"]')[0]));
    assert.deepEqual(await visibility(), { sync: true, jitter: true, checked: false });
    await app.page.evaluate(() => {
      document.querySelector('#audioClockSyncBtn').MaterialSwitch.on();
      saveAudioClockSync();
    });
    await app.page.waitForTimeout(300);
    await reloadApp(app);
    await openAudioSettings();
    assert.deepEqual(await visibility(), { sync: true, jitter: true, checked: true });
    const items = await app.page.evaluate(() => Views.AudioSettings.view.func());
    assert.ok(items.indexOf('audioClockSyncBtn') > items.indexOf('selectAudioJitter') && items.indexOf('audioClockSyncBtn') >= 0, 'reachable in the navigation: ' + JSON.stringify(items));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the corrected help texts of SOPS, the optimized presets, the game mode and HDR', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const texts = await app.page.evaluate(() => ({
      sops: $('#optimizeGamesMenu').prev().text(),
      presets: $('#optimizeBitrateMenu').prev().text(),
      gameMode: $('#gameModeMenu').prev().text(),
      hdr: $('#videoHdrMenu').prev().text(),
    }));
    assert.ok(texts.sops.indexOf('Lets Sunshine switch the host display') >= 0, texts.sops);
    assert.ok(texts.presets.indexOf('about 45 Mbps') >= 0, texts.presets);
    assert.ok(texts.gameMode.indexOf('Tizen 9') >= 0, texts.gameMode);
    assert.ok(texts.hdr.indexOf('10-bit SDR') >= 0, texts.hdr);
  } finally {
    await app.context.close();
  }
});
