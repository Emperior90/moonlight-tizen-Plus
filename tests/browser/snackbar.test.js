'use strict';

// Checks the messages of the app in the real snackbar of MDL (showSnackbarMessage() in wasm/platform/index.js, the
// .mdl-snackbar rules of style.css), as 2.3.3 changed them:
// - how long a message shows: snackbarLog() 2.5 seconds, snackbarLogLong() the time its translated text takes to read,
//   1.5 seconds and 50 ms per character from 5 to 15 seconds (getSnackbarLongTimeout(), which
//   tests/unit/snackbar-time.test.js pins), snackbarLogFor() the time of its caller; and dismissSnackbar() still ends a
//   long message at once, so that the next one shows after the fade of 250 ms;
// - a message shows above the dimmed overlay of a dialog and above the overlay menus, e.g. Failed to connect after Add PC
//   (the dialog stays open for a correction, and the message below it) and the messages of the button mapping panel: the
//   snackbar kept the z-index 3 of MDL before, under .dialog-overlay (999) and .overlay-menu-backdrop (1000). The button
//   mapping panel ends above a message of three lines, so that the notice of a controller with a non-standard layout
//   that connects while it is open never covers its focused entry, and the open Stream Menu, which has no scrim, stays
//   above the messages (1002), so that a message above the compact line never covers its last entry or its hint;
// - while the performance statistics show in a bottom corner, a message never covers them: beside the full statistics
//   at the bottom of the other side, and above the compact line (getSnackbarPlace() and placeSnackbar() in index.js),
//   in English and German, also with text 10 % wider (tests/browser/text-stress.js). With the statistics in a top corner
//   and after the stream, messages show in the middle as before. The place is chosen when a message shows, not when it
//   is queued, by the level that is about to show once the session of the stream started (a message before the first
//   figures, e.g. the codec fallback, or while a step of the level waits for them), and the message slides in from below
//   in its place, never sideways. A launch request that failed, before the session, keeps its message in the middle.

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
// The hint 30 seconds after the power command of the Stream Menu (menus.js), which sends the user back to its last entry:
// three lines in German
const POWER_HINT = ['The PC hasn\'t shut down. If Windows asks about open apps, answer on the PC. If nothing happened, switch to the desktop and try again.'];
const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
// A controller that the browser doesn't map to the standard layout (mapping ''): its notice takes three lines in German
const NON_STANDARD_ID = 'Wireless Controller (Vendor: 054c Product: 09cc)';

// Simulated gamepads, installed before the app starts: navigator.getGamepads() returns window.__pads, and
// __connectPad(index, id, mapping) fills a slot and fires gamepadconnected
function simulatedGamepads() {
  window.__pads = [null, null, null, null];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__pads.slice() });
  window.__connectPad = (index, id, mapping) => {
    const pad = {
      index, id, mapping: mapping === undefined ? 'standard' : mapping, connected: true, timestamp: 1, vibrationActuator: null,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0],
    };
    window.__pads[index] = pad;
    const event = new Event('gamepadconnected');
    Object.defineProperty(event, 'gamepad', { value: pad });
    window.dispatchEvent(event);
  };
}

// Press and release a key of the remote on the focused element, like the TV delivers it
const remoteKey = (page, keyCode, key) => page.evaluate(({ code, name }) => {
  ['keydown', 'keyup'].forEach((type) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  });
}, { code: keyCode, name: key });
const PLAY_PAUSE = [10252, 'MediaPlayPause'];
const DOWN = [40, 'ArrowDown'];

// Press DOWN until the element with the given id has the focus
async function focusByDown(page, id) {
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => document.activeElement.id) === id) {
      return;
    }
    await remoteKey(page, ...DOWN);
  }
  throw new Error('DOWN never reached ' + id);
}

// The points of an element (left, middle and right, at half and four fifths of its height) whose topmost element lies
// outside the given container, each with that element
const coveredPoints = (page, selector, container) => page.evaluate(({ query, inside }) => {
  const rect = document.querySelector(query).getBoundingClientRect();
  const covered = [];
  [0.5, 0.8].forEach((y) => [16, rect.width / 2, rect.width - 16].forEach((x) => {
    const hit = document.elementFromPoint(rect.left + x, rect.top + rect.height * y);
    if (!hit || !hit.closest(inside)) {
      covered.push(Math.round(rect.left + x) + ',' + Math.round(rect.top + rect.height * y) + ' ' + (hit ? hit.id || hit.className : 'nothing'));
    }
  }));
  return covered;
}, { query: selector, inside: container });

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

// Start a stream of app 8 on a simulated host that reaches 'Connection Established', after the given messages of the
// module, which it sends while it sets up the stream (e.g. the codec fallback)
async function startStream(app, beforeConnected) {
  await app.page.evaluate(async (early) => {
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
    early.forEach((message) => handleMessage(message));
    handleMessage('Connection Established');
  }, beforeConnected || []);
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

test('a message shows above the dimmed overlay of a dialog and of the button mapping panel, which ends above a message of three lines', async () => {
  // In German, whose notice of a controller with a non-standard layout takes three lines
  const app = await openApp(harness, { tv: TV, initScripts: [simulatedGamepads], stored: { languagePreference: 'de-DE' } });
  const page = app.page;
  try {
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE', null, { timeout: 5000 });
    // Above the overlays of the dialogs and of the overlay menus, except the Stream Menu, which has no scrim and stays
    // above the messages
    const zIndex = await page.evaluate(() => ['#snackbar', '#addHostDialogOverlay', '#buttonMappingOverlay', '#streamMenuOverlay']
      .map((selector) => Number(getComputedStyle(document.querySelector(selector)).zIndex)));
    assert.ok(zIndex[0] > Math.max(zIndex[1], zIndex[2]), JSON.stringify(zIndex));
    assert.ok(zIndex[3] > zIndex[0], JSON.stringify(zIndex));
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
    // The button mapping panel: its messages show above its dimmed overlay instead of behind it
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
      const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { inSnackbar: !!(element && element.closest('#snackbar')), element: element ? element.id || element.className : null };
    });
    assert.equal(hit.inSnackbar, true, JSON.stringify(hit));
    // A controller with a non-standard layout connects while Close has the focus, e.g. to map it: its notice of three
    // lines (about 10 seconds) shows below the panel, so the focus and the hint stay in sight (2.3.3 in testing covered
    // Close at every point)
    await page.evaluate(() => dismissSnackbar());
    await focusByDown(page, 'buttonMappingClose');
    await page.evaluate((id) => window.__connectPad(0, id, ''), NON_STANDARD_ID);
    // After 'has been connected' (2.5 s)
    await page.waitForFunction(() => {
      const element = document.getElementById('snackbar');
      return element.classList.contains('mdl-snackbar--active') && element.MaterialSnackbar.timeout_ > 5000;
    }, null, { timeout: 6000 });
    await page.waitForTimeout(650);
    const notice = await rectOf(page, '#snackbar');
    const panel = await rectOf(page, '#buttonMappingPanel');
    const where = JSON.stringify({ notice, panel });
    assert.ok(notice.bottom - notice.top >= 120, 'three lines: ' + where);
    assert.ok(!intersect(notice, panel), where);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'buttonMappingClose');
    assert.deepEqual(await coveredPoints(page, '#buttonMappingClose', '#buttonMappingPanel'), [], where);
    assert.deepEqual(await coveredPoints(page, '#buttonMappingPanel .overlay-menu-hint', '#buttonMappingPanel'), [], where);
    // The panel keeps the safe area of the screen
    assert.ok(panel.top >= 54 && panel.bottom <= 1026, where);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the open Stream Menu stays above a message, so a message above the compact line never covers its last entry or its hint', async () => {
  // The tallest Stream Menu (a controller brings the mouse emulation entry, a 7.1 stream the surround quality entry),
  // with the compact line at the bottom right, in German, whose power hint takes three lines
  const app = await openApp(harness, { tv: TV, initScripts: [simulatedGamepads],
    stored: { performanceStats: 1, languagePreference: 'de-DE', audioConfig: '71Surround' } });
  const page = app.page;
  try {
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE', null, { timeout: 5000 });
    await page.evaluate((id) => window.__connectPad(0, id), XBOX_ID);
    await startStream(app);
    await page.evaluate((compact) => {
      showStatsPosition('bottom-right');
      handleMessage(compact);
      dismissSnackbar();
    }, COMPACT_MESSAGE);
    await page.waitForTimeout(400);
    await remoteKey(page, ...PLAY_PAUSE);
    // The last entry, Shut down or restart the PC…, to which the power hint sends the user
    await focusByDown(page, 'streamMenuPower');
    const shown = await show(page, 'snackbarLogLong', POWER_HINT);
    await page.waitForTimeout(650);
    const message = await rectOf(page, '#snackbar');
    const menu = await rectOf(page, '#streamMenu');
    const where = JSON.stringify({ message, menu });
    // Above the compact line, three lines high, and over the lowest part of the menu, so that the points below tell
    // which of them is on top (2.3.3 in testing: the message, over the lower half of the focused entry and the hint)
    assert.deepEqual(shown.classes.filter((name) => /^is-(left|right|raised)$/.test(name)), ['is-raised']);
    assert.ok(message.bottom - message.top >= 120 && intersect(message, menu), where);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'streamMenuPower');
    assert.deepEqual(await coveredPoints(page, '#streamMenuPower', '#streamMenu'), [], where);
    assert.deepEqual(await coveredPoints(page, '#streamMenu .overlay-menu-hint', '#streamMenu'), [], where);
    // The rest of the message stays in sight beside the menu, which opens on the left: the backdrop of the Stream Menu
    // is transparent
    assert.ok(menu.right + 40 < message.right, where);
    const beside = await pixels(page, { x: menu.right + 10, y: message.top, width: message.right - menu.right - 20, height: message.bottom - message.top });
    const brightest = Math.max(...beside.map((pixel) => Math.max(...pixel)));
    assert.ok(brightest >= 200, 'the brightest pixel of the message beside the menu: ' + brightest);
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

// The place classes of the snackbar
const placesOf = (page) => page.evaluate(() => Array.prototype.slice.call(document.getElementById('snackbar').classList)
  .filter((name) => /^is-(left|right|raised)$/.test(name)));

// Show a message for 1.2 s, queue a second one behind it, step the statistics to the given level meanwhile (the stats
// key, 'StatLevelMsg: '), and return the place classes that the second one has once it shows
async function queuedPlace(page, level) {
  return page.evaluate(async (next) => {
    const element = document.getElementById('snackbar');
    const textElement = element.querySelector('.mdl-snackbar__text');
    const expected = t('No app is currently running.');
    dismissSnackbar();
    await new Promise((resolve) => setTimeout(resolve, 300));
    snackbarLogFor(1200, 'Text sent to the PC');
    snackbarLog('No app is currently running.');
    // The first one shows, the second one waits in the queue
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (textElement.textContent !== t('Text sent to the PC') || element.MaterialSnackbar.queuedNotifications_.length !== 1) {
      throw new Error('The first message doesn\'t show with the second one queued: ' + textElement.textContent);
    }
    handleMessage('StatLevelMsg: ' + next);
    const start = performance.now();
    while (performance.now() - start < 4000) {
      if (element.classList.contains('mdl-snackbar--active') && textElement.textContent === expected) {
        return Array.prototype.slice.call(element.classList).filter((name) => /^is-(left|right|raised)$/.test(name));
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The queued message didn\'t show');
  }, level);
}

test('a message gets the place of the moment it shows: before the first figures by the level that is about to show, after a queue by the level then, and it slides in without a sideways move', async () => {
  // A launch request that fails comes before the session of the stream, while isInGame is still true: its message keeps
  // the middle, also with the full statistics chosen for the bottom left
  const failed = await openApp(harness, { tv: TV, stored: { performanceStats: 2 } });
  try {
    await failed.page.evaluate(() => showStatsPosition('bottom-left'));
    const launchFailure = await failed.page.evaluate(async () => {
      let fail = null;
      const host = {
        paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
        appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
        refreshServerInfo: () => Promise.resolve(),
        getAppById: (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null),
        launchApp: () => new Promise((resolve, reject) => {
          fail = reject;
        }),
        quitApp: () => Promise.resolve(),
        toString: () => 'GAMING-PC',
      };
      api = host;
      showApps = () => Promise.resolve();
      startGame(host, 8);
      await new Promise((resolve) => setTimeout(resolve, 100));
      fail('HTTP 503');
      const element = document.getElementById('snackbar');
      const expected = t('Failed to launch %1$s', 'Game 8');
      const start = performance.now();
      while (performance.now() - start < 3000) {
        if (element.classList.contains('mdl-snackbar--active') && element.textContent.trim() === expected) {
          return { classes: Array.prototype.slice.call(element.classList), session: wasmSessionStarted };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { shows: element.textContent.trim() };
    });
    assert.equal(launchFailure.session, false, JSON.stringify(launchFailure));
    assert.deepEqual(launchFailure.classes.filter((name) => /^is-(left|right|raised)$/.test(name)), [], JSON.stringify(launchFailure));
    assert.deepEqual(failed.errors, []);
  } finally {
    await failed.context.close();
  }

  // The codec fallback, which the module sends while it sets up the video stream, before 'Connection Established' and
  // the first figures (2.3.3 in testing: in the middle, over the statistics that then showed under it for its 8 s)
  for (const setup of [{ level: 2, corner: 'bottom-left', place: 'is-right' }, { level: 1, corner: 'bottom-right', place: 'is-raised' }]) {
    const where = 'level ' + setup.level + ' ' + setup.corner;
    const app = await openApp(harness, { tv: TV, stored: { performanceStats: setup.level, audioConfig: '71Surround' } });
    const page = app.page;
    try {
      await page.evaluate((corner) => showStatsPosition(corner), setup.corner);
      await startStream(app, ['CodecFallbackMsg: H264']);
      const codec = await page.evaluate(() => ({
        text: document.querySelector('#snackbar .mdl-snackbar__text').textContent,
        stats: document.getElementById('performance-stats').textContent,
      }));
      assert.equal(codec.text, await page.evaluate(() => t('The host PC can\'t encode the selected codec, so the stream uses H.264 instead, which Samsung TVs generally decode only up to 1080p.')), where);
      assert.equal(codec.stats, '', where);
      assert.deepEqual(await placesOf(page), [setup.place], where);
      // The first figures, under which it stays
      await page.evaluate(({ level, text, compact }) => handleMessage(level === 2 ? 'StatMsg: {"rtt":12,"lost":2}\n' + text : compact),
        { level: setup.level, text: FULL_TEXT, compact: COMPACT_MESSAGE });
      await page.waitForTimeout(650);
      const message = await rectOf(page, '#snackbar');
      const stats = await rectOf(page, '#performance-stats');
      assert.ok(stats.right - stats.left > 100, where + ' the statistics show: ' + JSON.stringify(stats));
      assert.ok(!intersect(message, stats), where + ': the message ' + JSON.stringify(message) + ' covers the statistics ' + JSON.stringify(stats));

      if (setup.level === 2) {
        // A message queued while the full statistics show at the bottom left, which shows once a step of the level
        // turned them off: in the middle, not in the column that they left free when it was queued
        assert.deepEqual(await queuedPlace(page, 0), [], where);
        // And one that shows after a step to Compact, before its first figures: already above the compact line
        await page.evaluate((text) => {
          handleMessage('StatLevelMsg: 2');
          handleMessage('StatMsg: {"rtt":12,"lost":2}\n' + text);
        }, FULL_TEXT);
        assert.deepEqual(await queuedPlace(page, 1), ['is-raised'], where);
        // It slides in from below in its new place: from the middle (the statistics at the top left) to the left column
        // (the full statistics at the bottom right), its left edge stays at 96 px on every frame of the slide
        await page.evaluate((text) => {
          handleMessage('StatLevelMsg: 2');
          handleMessage('StatMsg: {"rtt":12,"lost":2}\n' + text);
          showStatsPosition('top-left');
        }, FULL_TEXT);
        await show(page, 'snackbarLog', ['Text sent to the PC']);
        assert.deepEqual(await placesOf(page), [], where);
        const frames = await page.evaluate(async () => {
          const element = document.getElementById('snackbar');
          const textElement = element.querySelector('.mdl-snackbar__text');
          const expected = t('No app is currently running.');
          showStatsPosition('bottom-right');
          dismissSnackbar();
          snackbarLog('No app is currently running.');
          const lefts = [];
          const start = performance.now();
          while (performance.now() - start < 900) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (textElement.textContent === expected) {
              lefts.push(Math.round(element.getBoundingClientRect().left));
            }
          }
          return lefts;
        });
        assert.ok(frames.length >= 10, JSON.stringify(frames));
        assert.ok(frames.every((left) => Math.abs(left - 96) <= 1), 'the left edge on each frame: ' + JSON.stringify(frames));
        assert.deepEqual(await placesOf(page), ['is-left'], where);
      }
      assert.deepEqual(app.errors, [], where);
    } finally {
      await app.context.close();
    }
  }
});
