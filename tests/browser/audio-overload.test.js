'use strict';

// Checks the message about sound that keeps the TV busy, in the real page (showAudioOverloadMessage() in messages.js).
// The module sends 'AudioOverloadMsg: <channels>,<ms per second>' once per stream start, when decoding the sound and
// handing it to the player took more than its limit per second of audio over 10 seconds (wasm/audio_load.hpp, whose rule
// tests/native/audio_load_test.cpp checks, and tests/native/audio_decoder_test.cpp that the audio thread sends it):
// - a 5.1 or 7.1 stream shows one message, which names the two ways out, Surround audio quality Efficient and Stereo,
//   with the performance statistics off as well as on, in the language of the app;
// - once per session: a second message of the same stream shows nothing, and neither does the message of the stream
//   after a reconnect of the Stream Menu, which stays in the session, while the next stream that is started may show it
//   again;
// - a stereo stream shows none, since it has no lighter sound to change to, and neither does a message that arrives
//   after the stream ended or while only its start runs;
// - the message fits the screen in every language, also with 10 % wider text.
// The hint of the session report for such a stream is checked by tests/unit/diagnostics.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');
const { forEachTextWidth } = require('./text-stress');

const TV = { tv: 's90c', conn: 'wifi' };
const MESSAGE = 'The sound is keeping the TV busy. If it stutters, set Surround audio quality to Efficient, or Audio configuration to Stereo.';

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Open the app with a host that answers the launch and resume requests at once, and keep the messages of the snackbar
// in window.__snackbar. stopStream() ends the stream like the module, and the reconnect of the Stream Menu waits 100 ms
// instead of 1 s.
async function openWithHost(stored) {
  const app = await openApp(harness, { tv: TV, stored: Object.assign({ bitrate: '40', autoAdjustBitrate: false }, stored) });
  await app.page.evaluate(() => {
    SETTINGS_RESTART_DELAY_MS = 100;
    const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03, refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null),
      launchApp: (appId) => {
        host.currentGame = appId;
        return Promise.resolve(ok);
      },
      resumeApp: () => Promise.resolve(ok),
      quitApp: () => Promise.resolve(),
      toString: () => 'GAMING-PC',
    };
    window.__host = host;
    api = host;
    showApps = () => Promise.resolve();
    Module.stopStream = function() {
      handleMessage('streamTerminated: 0');
      return { type: 'resolve', ret: null };
    };
    window.__snackbar = [];
    document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbar.push(data.message);
    window.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  });
  return app;
}

// Start a stream of app 8 that reaches 'Connection Established'
const startStream = (page) => page.evaluate(async () => {
  startGame(window.__host, 8);
  await window.wait(300);
  handleMessage('Connection Established');
});
const endStream = (page) => page.evaluate(async () => {
  handleMessage('streamTerminated: 0');
  await window.wait(100);
});
// Send the message of the module for a stream with the given channels, and return what the snackbar showed for it
const overload = (page, channels) => page.evaluate((count) => {
  window.__snackbar.length = 0;
  handleMessage('AudioOverloadMsg: ' + count + ',412');
  return window.__snackbar.slice();
}, channels);

test('a surround stream whose sound keeps the TV busy shows one message per session, with the statistics off', async () => {
  for (const config of ['51Surround', '71Surround']) {
    const channels = config === '51Surround' ? 6 : 8;
    const app = await openWithHost({ audioConfig: config, surroundQuality: 'High' });
    try {
      const { page } = app;
      await startStream(page);
      // The statistics are off, the default, and no overlay shows
      assert.equal(await page.evaluate(() => getPerformanceStatsLevel()), 0);
      assert.deepEqual(await overload(page, channels), [MESSAGE], config);
      // The stream stays overloaded, and the module of a later build could tell again: nothing more in this session
      assert.deepEqual(await overload(page, channels), [], config);

      // A new quality from the Stream Menu reconnects within the session: the stream after it tells nothing either
      const reconnected = await page.evaluate(async () => {
        window.__startStreamArgs = null;
        const restarting = restartStreamWithSettings({ surroundQuality: 'Efficient' });
        await window.wait(600);
        handleMessage('Connection Established');
        return { restarting, started: !!window.__startStreamArgs, inGame: isInGame };
      });
      assert.deepEqual(reconnected, { restarting: true, started: true, inGame: true }, config);
      assert.deepEqual(await overload(page, channels), [], config + ' after the reconnect');

      // The next stream is a new session, which may be told once again
      await endStream(page);
      assert.deepEqual(await overload(page, channels), [], config + ' after the end of the stream');
      await startStream(page);
      assert.deepEqual(await overload(page, channels), [MESSAGE], config + ', next stream');
      assert.deepEqual(await overload(page, channels), [], config + ', next stream');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('with the full statistics on, the message shows as well, next to the overlay', async () => {
  const app = await openWithHost({ audioConfig: '51Surround', performanceStats: 2 });
  try {
    const { page } = app;
    await startStream(page);
    assert.equal(await page.evaluate(() => getPerformanceStatsLevel()), 2);
    assert.deepEqual(await overload(page, 6), [MESSAGE]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('no message for a stereo stream, before the stream connected its start request, or after it ended', async () => {
  const app = await openWithHost({ audioConfig: 'Stereo' });
  try {
    const { page } = app;
    // No stream at all
    assert.deepEqual(await overload(page, 6), []);
    await startStream(page);
    // Stereo and mono have no lighter sound, and a message without a channel count is no surround stream
    assert.deepEqual(await overload(page, 2), []);
    assert.deepEqual(await overload(page, 1), []);
    assert.deepEqual(await page.evaluate(() => {
      window.__snackbar.length = 0;
      handleMessage('AudioOverloadMsg: ');
      handleMessage('AudioOverloadMsg: x');
      return window.__snackbar.slice();
    }), []);
    // None of them used up the one message of the session
    assert.deepEqual(await overload(page, 6), [MESSAGE]);
    await endStream(page);
    assert.deepEqual(await overload(page, 8), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the message follows the language, names the settings as the UI shows them and fits the screen, also with 10 % wider text', async () => {
  const LANGUAGES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
  const app = await openApp(harness, { tv: TV, stored: { audioConfig: '51Surround' } });
  try {
    const { page } = app;
    // The real snackbar, as a stream shows it, for 700 ms instead of 5 s, so that the next one doesn't have to wait
    await page.evaluate(() => {
      const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
      const show = snackbar.showSnackbar.bind(snackbar);
      snackbar.showSnackbar = (data) => show(Object.assign({}, data, { timeout: 700 }));
    });
    for (const language of LANGUAGES) {
      await page.evaluate((locale) => i18n.setLanguage(locale), language);
      await page.waitForFunction((locale) => document.documentElement.getAttribute('lang') === locale, language);
      await forEachTextWidth(page, async (stress) => {
        const shown = await page.evaluate(async () => {
          isInGame = true;
          wasmSessionStarted = true;
          audioOverloadWarning = false;
          handleMessage('AudioOverloadMsg: 6,412');
          isInGame = false;
          wasmSessionStarted = false;
          await new Promise((resolve) => setTimeout(resolve, 350));
          const snackbar = document.getElementById('snackbar');
          const text = snackbar.querySelector('.mdl-snackbar__text');
          const box = snackbar.getBoundingClientRect();
          const names = ['Surround audio quality', 'Efficient', 'Audio configuration', 'Stereo'].map((key) => t(key));
          return { active: snackbar.classList.contains('mdl-snackbar--active'), text: text.textContent,
            inside: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
            cut: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1,
            lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)),
            names: names.filter((name) => text.textContent.indexOf(name) < 0) };
        });
        const where = language + stress + ' ' + JSON.stringify(shown);
        assert.equal(shown.active, true, where);
        assert.equal(shown.inside, true, where);
        assert.equal(shown.cut, false, where);
        assert.ok(shown.lines <= 3, where);
        // The names of both settings and both values, as the settings show them in this language
        assert.deepEqual(shown.names, [], where);
        assert.equal(shown.text === MESSAGE, language === 'en-US', where);
        // Let the snackbar go before the next one
        await page.waitForFunction(() => !document.getElementById('snackbar').classList.contains('mdl-snackbar--active'), null, { timeout: 3000 });
        await page.waitForTimeout(400);
      });
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
