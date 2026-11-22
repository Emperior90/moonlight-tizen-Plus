'use strict';

// Checks the messages of the app in the real snackbar of MDL (showSnackbarMessage() in wasm/platform/index.js, the
// .mdl-snackbar rules of style.css), as 2.3.3 changed them:
// - how long a message shows: snackbarLog() 2.5 seconds, snackbarLogLong() the time its translated text takes to read,
//   1.5 seconds and 50 ms per character from 5 to 15 seconds (getSnackbarLongTimeout(), which
//   tests/unit/snackbar-time.test.js pins), snackbarLogFor() the time of its caller; and dismissSnackbar() still ends a
//   long message at once, so that the next one shows after the fade of 250 ms;
// - a message shows above the dimmed overlay of a dialog and above the overlay menus, e.g. Failed to connect after Add PC
//   (the dialog stays open for a correction) and the messages of the button mapping panel: the snackbar kept the
//   z-index 3 of MDL before, under .dialog-overlay (999) and .overlay-menu-backdrop (1000);
// - while the performance statistics show in a bottom corner, a message never covers them: beside the full statistics
//   at the bottom of the other side, and above the compact line (getSnackbarPlace() and placeSnackbar() in index.js),
//   in English and German, also with text 10 % wider (tests/browser/text-stress.js). With the statistics in a top corner
//   and after the stream, messages show in the middle as before.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');
const { forEachTextWidth } = require('./text-stress');
const { FULL_TEXT } = require('./full-stats-text');

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
// The message of a start that the PC didn't answer within 120 seconds (endStreamStartWithoutAnswer() in index.js): 253
// characters in English, 294 in German
const START_TIMEOUT = ['%1$s didn\'t answer the start of %2$s within %3$s seconds. A command that Sunshine (or another GameStream host) runs before the app, e.g. to switch the display, may be waiting on the PC. End it or restart Sunshine, then start the app again.',
  'GAMING-PC', 'Cyberpunk 2077', 120];
const FAILED_TO_CONNECT = ['Failed to connect to %1$s. Make sure that Sunshine (or another GameStream host) is running on the PC.', '192.168.178.3'];
const COMPACT_MESSAGE = 'StatCompactMsg: {"w":1920,"h":1080,"fps":120,"codec":"HEVC","bits":10,"hdr":1,"rfps":119.88,"mbps":148.6,' +
  '"rtt":120,"drop":12.50,"delay":16.7}';

// End what the snackbar shows and drops, show a message with one of the functions of index.js, and wait until it shows:
// its text, its time (the timeout of MDL for the shown message) and its classes
async function show(page, name, args) {
  return page.evaluate(async ({ fn, values }) => {
    const element = document.getElementById('snackbar');
    const textElement = element.querySelector('.mdl-snackbar__text');
    const offset = fn === 'snackbarLogFor' ? 1 : 0;
    const expected = t(...values.slice(offset));
    dismissSnackbar();
    window[fn](...values);
    const start = performance.now();
    while (performance.now() - start < 3000) {
      if (element.classList.contains('mdl-snackbar--active') && textElement.textContent === expected) {
        return { text: expected, timeout: element.MaterialSnackbar.timeout_, classes: Array.prototype.slice.call(element.classList) };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The message didn\'t show: ' + expected + ' (shows: ' + textElement.textContent + ')');
  }, { fn: name, values: args });
}

// The box of an element on the screen
const rectOf = (page, selector) => page.evaluate((query) => {
  const rect = document.querySelector(query).getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}, selector);
const intersect = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// The RGB values of the pixels of a part of the screen
async function pixels(page, clip) {
  const png = await page.screenshot({ clip });
  const data = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return Array.from(canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data);
  }, png.toString('base64'));
  const result = [];
  for (let i = 0; i < data.length; i += 4) {
    result.push([data[i], data[i + 1], data[i + 2]]);
  }
  return result;
}

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

test('a message shows for the time of its kind, a long one as long as its text takes to read, and dismissSnackbar() ends it at once', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    // [function, arguments, time in ms]
    const cases = [
      ['snackbarLog', ['No app is currently running.'], 2500],
      // Up to 70 characters: the 5 seconds of every long message before 2.3.3
      ['snackbarLogLong', ['Mouse emulation is activated'], 5000],
      // 253 characters: 1.5 s + 50 ms x 253
      ['snackbarLogLong', START_TIMEOUT, 14150],
      ['snackbarLogFor', [2800, 'No app is currently running.'], 2800],
    ];
    for (const [name, args, time] of cases) {
      const shown = await show(app.page, name, args);
      assert.equal(shown.timeout, time, name + ' ' + shown.text);
    }
    // The time of the translated text: 294 characters in German, more than the 15 seconds at most
    await app.page.evaluate(() => i18n.setLanguage('de-DE'));
    const german = await show(app.page, 'snackbarLogLong', START_TIMEOUT);
    assert.ok(german.text.indexOf('GAMING-PC hat auf den Start von Cyberpunk 2077') === 0, german.text);
    assert.equal(german.timeout, 15000);
    // A message that is no longer true ends at once, also a long one, and the next one shows after the fade of 250 ms
    const next = await app.page.evaluate(async () => {
      const element = document.getElementById('snackbar');
      const textElement = element.querySelector('.mdl-snackbar__text');
      const expected = t('Text sent to the PC');
      const start = performance.now();
      dismissSnackbar();
      snackbarLog('Text sent to the PC');
      while (performance.now() - start < 3000) {
        if (element.classList.contains('mdl-snackbar--active') && textElement.textContent === expected) {
          return { after: performance.now() - start, timeout: element.MaterialSnackbar.timeout_ };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return null;
    });
    assert.ok(next && next.after < 400, JSON.stringify(next));
    assert.equal(next.timeout, 2500);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a message shows above the dimmed overlay of a dialog and above the button mapping panel', async () => {
  const app = await openApp(harness, { tv: TV });
  const page = app.page;
  try {
    // Above the overlays of the dialogs and of the overlay menus
    const zIndex = await page.evaluate(() => ['#snackbar', '#addHostDialogOverlay', '#buttonMappingOverlay', '#streamMenuOverlay']
      .map((selector) => Number(getComputedStyle(document.querySelector(selector)).zIndex)));
    assert.ok(zIndex[0] > Math.max(zIndex[1], zIndex[2], zIndex[3]), JSON.stringify(zIndex));
    // Add PC with an address that doesn't answer: the dialog stays open for a correction, and the message below it is
    // bright, not dimmed by the overlay of the dialog (2.3.2: its brightest pixel 71 of 255)
    await page.evaluate(() => addHostDialog());
    await page.waitForFunction(() => document.getElementById('addHostDialog').open && $('#addHostDialogOverlay').is(':visible'));
    await show(page, 'snackbarLogLong', FAILED_TO_CONNECT);
    await page.waitForTimeout(600);
    const message = await rectOf(page, '#snackbar');
    const dialog = await rectOf(page, '#addHostDialog');
    assert.ok(!intersect(message, dialog), JSON.stringify({ message, dialog }));
    const shown = await pixels(page, { x: message.left, y: message.top, width: message.right - message.left, height: message.bottom - message.top });
    const brightest = Math.max(...shown.map((pixel) => Math.max(...pixel)));
    assert.ok(brightest >= 200, 'the brightest pixel of the message: ' + brightest);
    await page.evaluate(() => $('#cancelAddHost').trigger('click'));
    await page.waitForFunction(() => !document.getElementById('addHostDialog').open);
    await page.evaluate(() => dismissSnackbar());
    // The button mapping panel: its messages show over its lowest rows instead of behind it
    await page.evaluate(() => $('#settingsBtn').trigger('click'));
    await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await page.evaluate(() => handleSettingsView('inputSettings'));
    await page.waitForFunction(() => $('#buttonMappingBtn').is(':visible'));
    await page.evaluate(() => $('#buttonMappingBtn').trigger('click'));
    await page.waitForFunction(() => $('#buttonMappingOverlay').is(':visible'));
    await show(page, 'snackbarLog', ['The buttons of all controllers are as printed again.']);
    await page.waitForTimeout(600);
    const hit = await page.evaluate(() => {
      const rect = document.getElementById('snackbar').getBoundingClientRect();
      const panel = document.getElementById('buttonMappingPanel').getBoundingClientRect();
      const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { inSnackbar: !!(element && element.closest('#snackbar')), element: element ? element.id || element.className : null,
        overPanel: rect.top < panel.bottom && rect.left < panel.right && panel.left < rect.right };
    });
    // (the message lies over the panel, so that the hit tells which of them is on top)
    assert.equal(hit.overPanel, true, JSON.stringify(hit));
    assert.equal(hit.inSnackbar, true, JSON.stringify(hit));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('with the statistics in a bottom corner a message shows beside the full statistics or above the compact line, never over them', async () => {
  for (const language of ['en-US', 'de-DE']) {
    const app = await openApp(harness, { tv: TV, stored: { performanceStats: 2, languagePreference: language, audioConfig: '71Surround' } });
    const page = app.page;
    try {
      await page.waitForFunction((lang) => document.documentElement.getAttribute('lang') === lang, language, { timeout: 5000 });
      await startStream(app);
      await page.evaluate((text) => handleMessage('StatMsg: {"rtt":12,"lost":2}\n' + text), FULL_TEXT);
      for (const level of ['full', 'compact']) {
        if (level === 'compact') {
          await page.evaluate((message) => {
            handleMessage('StatLevelMsg: 1');
            handleMessage(message);
          }, COMPACT_MESSAGE);
        }
        await forEachTextWidth(page, async (stress) => {
          for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
            const where = language + ' ' + level + ' ' + corner + stress;
            await page.evaluate((value) => showStatsPosition(value), corner);
            const shown = await show(page, 'snackbarLogLong', START_TIMEOUT);
            // Once it slid in
            await page.waitForTimeout(650);
            const message = await rectOf(page, '#snackbar');
            const stats = await rectOf(page, '#performance-stats');
            assert.ok(stats.right - stats.left > 100, where + ' the statistics show: ' + JSON.stringify(stats));
            const places = shown.classes.filter((name) => /^is-(left|right|raised)$/.test(name));
            if (corner.indexOf('bottom') === 0) {
              assert.ok(!intersect(message, stats), where + ': the message ' + JSON.stringify(message) + ' covers the statistics ' + JSON.stringify(stats));
              assert.ok(message.left >= 96 && message.right <= 1824, where + ' ' + JSON.stringify(message));
              if (level === 'full') {
                // At the bottom of the other side
                assert.deepEqual(places, [corner === 'bottom-left' ? 'is-right' : 'is-left'], where);
                assert.ok(Math.abs(message.bottom - 1040) <= 1, where + ' ' + JSON.stringify(message));
                assert.ok(corner === 'bottom-left' ? message.left >= stats.right : message.right <= stats.left, where);
              } else {
                // Above the compact line, in the middle
                assert.deepEqual(places, ['is-raised'], where);
                assert.ok(Math.abs(message.bottom - 976) <= 1, where + ' ' + JSON.stringify(message));
                assert.ok(message.bottom <= stats.top, where);
                assert.ok(Math.abs(message.left - (1920 - message.right)) <= 1, where + ' ' + JSON.stringify(message));
              }
            } else {
              // In the middle of the bottom, as before
              assert.deepEqual(places, [], where);
              assert.ok(Math.abs(message.left - (1920 - message.right)) <= 1, where + ' ' + JSON.stringify(message));
              assert.ok(Math.abs(message.bottom - 1040) <= 1, where + ' ' + JSON.stringify(message));
            }
          }
        });
      }
      // After the stream (the statistics were at the bottom right), the next message shows in the middle again
      await page.evaluate(() => handleMessage('streamTerminated: 0'));
      await page.waitForTimeout(300);
      const shown = await show(page, 'snackbarLog', ['No app is currently running.']);
      await page.waitForTimeout(650);
      const message = await rectOf(page, '#snackbar');
      assert.deepEqual(shown.classes.filter((name) => /^is-(left|right|raised)$/.test(name)), [], language);
      assert.ok(Math.abs(message.left - (1920 - message.right)) <= 1, language + ' ' + JSON.stringify(message));
      assert.deepEqual(app.errors, [], language);
    } finally {
      await app.context.close();
    }
  }
});
