'use strict';

// Helpers for the Playwright tests: start the widget server and Chromium, open the app on a simulated TV (optionally
// with settings already stored in IndexedDB, like an existing install), and read what the settings screen shows and
// what the app stored.

const { requireDevModule } = require('../lib/dev-modules');
const { startServer } = require('./server');

const { chromium } = requireDevModule('playwright');

// IndexedDB layout of the app (wasm/platform/index.js: dbName, dbVersion, storeName). Values are stored as JSON text.
const DB_NAME = 'GameStreamingDB';
const DB_VERSION = 1;
const STORE_NAME = 'GameStreamingStore';

// Console texts that mark the end of the start of the app. The tests wait for all of them before they interact, since
// e.g. the first translation pass rewrites every element with a data-i18n attribute, such as the menu items and the
// labels of the dialog buttons.
const READY_SIGNALS = [
  // loadUserDataCb() loaded the last stored setting (the bitrate preset state)
  'Auto adjust bitrate state',
  // loadSystemInfo() ran as the callback of the first translation pass of i18n.js
  'Loading system information...',
  // restoreUiAfterWasmLoad() showed the hosts view after the (stubbed) WebAssembly module started
  'Entering "Show Hosts" mode.',
];
const READY_TIMEOUT_MS = 15000;
// restoreUiAfterWasmLoad() focuses the current item 100 ms after it showed the hosts view
const READY_SETTLE_MS = 150;

// The video settings that the optimal settings button and Restore Defaults store. A fresh install stores only the
// last one (whether the bitrate presets follow the video settings) and works the others out at every start.
const VIDEO_KEYS = ['resolution', 'frameRate', 'bitrate', 'videoCodec', 'hdrMode', 'unlockAllFps', 'framePacing',
  'fullRange', 'gameMode', 'optimizeBitrate', 'autoAdjustBitrate'];

// Start the server and the browser that a test file shares between its tests
async function startHarness() {
  const server = await startServer(0);
  const browser = await chromium.launch();
  return {
    baseUrl: server.url,
    browser,
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

// Fill IndexedDB of the app's origin with the given settings before the app runs, the way the app stores them
function seedStorage(page, values) {
  return page.evaluate(({ dbName, dbVersion, storeName, entries }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      Object.keys(entries).forEach((key) => store.put(JSON.stringify(entries[key]), key));
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  }), { dbName: DB_NAME, dbVersion: DB_VERSION, storeName: STORE_NAME, entries: values });
}

// Read everything the app stored, as an object of parsed values. Only call this once the app has opened its database.
function readStorage(page) {
  return page.evaluate(({ dbName, storeName }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const values = {};
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve(values);
        return;
      }
      const cursorRequest = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          values[cursor.key] = JSON.parse(cursor.value);
          cursor.continue();
        } else {
          db.close();
          resolve(values);
        }
      };
    };
  }), { dbName: DB_NAME, storeName: STORE_NAME });
}

// Keep only the given keys of the stored values (missing keys stay missing)
function pick(values, keys) {
  const picked = {};
  keys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      picked[key] = values[key];
    }
  });
  return picked;
}

// Poll the stored values until the predicate accepts them, since the app writes them asynchronously
async function waitForStorage(page, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  let values = await readStorage(page);
  while (!predicate(values)) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the stored settings, last read: ' + JSON.stringify(values));
    }
    await page.waitForTimeout(50);
    values = await readStorage(page);
  }
  return values;
}

// Resolve once the app logged every ready signal (by default READY_SIGNALS), i.e. it finished starting
function appStarted(app, readySignals) {
  return new Promise((resolve, reject) => {
    const missing = (readySignals || READY_SIGNALS).slice();
    const timer = setTimeout(() => {
      app.page.off('console', onConsole);
      reject(new Error('The app did not finish starting within ' + READY_TIMEOUT_MS + ' ms, missing: ' + JSON.stringify(missing)));
    }, READY_TIMEOUT_MS);
    function onConsole(message) {
      const text = message.text();
      for (let i = missing.length - 1; i >= 0; i--) {
        if (text.indexOf(missing[i]) >= 0) {
          missing.splice(i, 1);
        }
      }
      if (missing.length === 0) {
        clearTimeout(timer);
        app.page.off('console', onConsole);
        setTimeout(resolve, READY_SETTLE_MS);
      }
    }
    app.page.on('console', onConsole);
  });
}

// Build the app URL for a simulated TV (see mocks/tv-mock.js for the options)
function appUrl(baseUrl, tvOptions) {
  const params = new URLSearchParams();
  Object.keys(tvOptions || {}).forEach((key) => params.set(key, String(tvOptions[key])));
  const query = params.toString();
  return baseUrl + '/index.html' + (query ? '?' + query : '');
}

// Open the app in a fresh browser profile on a simulated TV, optionally with settings stored beforehand.
// Resolves once the app finished starting, or once it logged the given `readySignals` instead, e.g. for a start that
// stops early on purpose. `app.logs` collects the console, `app.errors` the uncaught errors.
async function openApp(harness, options) {
  const opts = options || {};
  const context = await harness.browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // Keep the tests off the real network: the app scans the local subnet for hosts on startup
  await context.route('**/*', (route) => {
    if (route.request().url().indexOf(harness.baseUrl + '/') === 0) {
      route.continue();
    } else {
      route.abort();
    }
  });
  if (opts.mockConfig) {
    await context.addInitScript((config) => {
      window.__MOCK_CONFIG__ = config;
    }, opts.mockConfig);
  }
  if (opts.initScripts) {
    for (const script of opts.initScripts) {
      await context.addInitScript(script);
    }
  }

  const page = await context.newPage();
  const app = { context, page, logs: [], errors: [], url: appUrl(harness.baseUrl, opts.tv) };
  page.on('console', (message) => app.logs.push(message.text()));
  page.on('pageerror', (error) => app.errors.push(error.message));

  if (opts.stored) {
    await page.goto(harness.baseUrl + '/__test__/blank.html');
    await seedStorage(page, opts.stored);
  }

  const started = appStarted(app, opts.readySignals);
  await page.goto(app.url);
  await started;
  return app;
}

// Reload the app (e.g. to see what an existing install loads on its next start) and wait until it started again
async function reloadApp(app) {
  const started = appStarted(app);
  await app.page.reload();
  await started;
}

// Read the video settings as the settings screen shows them
function readVideoSettings(page) {
  return page.evaluate(() => {
    const switchState = (id) => document.getElementById(id).checked;
    return {
      resolution: String($('#selectResolution').data('value')),
      resolutionLabel: $('#selectResolution').text().trim(),
      frameRate: String($('#selectFramerate').data('value')),
      frameRateOptions: $('.videoFramerateMenu li').map(function() {
        return String($(this).data('value'));
      }).get(),
      codec: String($('#selectCodec').data('value')),
      bitrate: String($('#bitrateSlider').val()),
      bitrateLabel: $('#selectBitrate').text().trim(),
      hdr: switchState('hdrModeSwitch'),
      unlockAllFps: switchState('unlockAllFpsSwitch'),
      framePacing: switchState('framePacingSwitch'),
      fullRange: switchState('fullRangeSwitch'),
      gameMode: switchState('gameModeSwitch'),
      gameModeDisabled: document.getElementById('gameModeSwitch').disabled,
      optimizeBitrate: switchState('optimizeBitrateSwitch'),
      autoAdjustBitrate: autoAdjustBitrate,
    };
  });
}

// Read the other settings that Restore Defaults resets
function readOtherSettings(page) {
  return page.evaluate(() => {
    const switchState = (id) => document.getElementById(id).checked;
    return {
      ipAddressFieldMode: switchState('ipAddressFieldModeSwitch'),
      sortAppsList: switchState('sortAppsListSwitch'),
      optimizeGames: switchState('optimizeGamesSwitch'),
      rumbleFeedback: switchState('rumbleFeedbackSwitch'),
      mouseEmulation: switchState('mouseEmulationSwitch'),
      flipABfaceButtons: switchState('flipABfaceButtonsSwitch'),
      flipXYfaceButtons: switchState('flipXYfaceButtonsSwitch'),
      controllerType: String($('#selectControllerType').data('value')),
      audioBackend: String($('#selectAudioBackend').data('value')),
      audioConfig: String($('#selectAudio').data('value')),
      audioSync: switchState('audioSyncSwitch'),
      audioJitter: String($('#jitterSlider').val()),
      audioClockSync: switchState('audioClockSyncSwitch'),
      playHostAudio: switchState('playHostAudioSwitch'),
      decryptHostAudio: switchState('decryptHostAudioSwitch'),
      refFrameInvalidation: switchState('refFrameInvalidationSwitch'),
      hdrMetadata: switchState('hdrMetadataSwitch'),
      disableWarnings: switchState('disableWarningsSwitch'),
      performanceStats: switchState('performanceStatsSwitch'),
    };
  });
}

module.exports = {
  DB_NAME,
  STORE_NAME,
  VIDEO_KEYS,
  appUrl,
  openApp,
  pick,
  readOtherSettings,
  readStorage,
  readVideoSettings,
  reloadApp,
  startHarness,
  waitForStorage,
};
