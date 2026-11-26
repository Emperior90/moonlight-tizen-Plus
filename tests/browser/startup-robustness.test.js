'use strict';

// How the app copes with what can go wrong while it starts:
// - A stored value that IndexedDB can't read. getData() passed an undefined variable on its error paths and threw a
//   ReferenceError instead of calling back. Now the callback gets null and learns that the read failed: a setting shows
//   its default for this start, and nothing that a read error made up replaces a stored value (the certificate and
//   unique ID, which keep the pairing with every host, and the bitrate preset state).
// - A dialog that opens before the first translation pass of i18n.js, which rewrote every element with a data-i18n
//   attribute and so reset the title and text of the dialog to its placeholders (e.g. 'Warning').
// - Since 2.3.5, a database that can't be opened (openIndexDB() calls back after an error, a block or a throw, so the
//   restart text of a failed read shows), a pairing certificate that the module can't make (makeCert) and a stored one
//   that it can't load (httpInit): each ends the loading screen with a message, without the moving bar, and no request
//   goes to a PC. Up to 2.3.4 the first and the last stayed on 'Loading Moonlight...' for good, and the second threw
//   on the missing certificate and polled the stored PCs anyway.
// - Since 2.3.5, a write that IndexedDB aborts (e.g. with a QuotaExceededError on a full flash memory, which fires only
//   the abort event) is logged, and so is a new certificate that can't be stored; the start asks once for persistent
//   storage and logs the answer.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, openApp, pick, readStorage, readVideoSettings, startHarness, waitForStorage } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// What an install that already started once has stored
const EXISTING_INSTALL = {
  uniqueid: '0123456789abcdef',
  cert: { cert: 'STORED-CERT', privateKey: 'STORED-KEY' },
};

// Init script that makes IndexedDB fail to read the given keys, as { key: mode }. With 'throw', reading the key throws
// at once (the catch path of getData()); with 'abort', the transaction aborts, which fails the request with an error
// event and then aborts the transaction (its error and abort handlers). Either error arrives before the answers to the
// keys requested earlier, which a real read error of the database wouldn't, so the tests pick settings whose defaults
// don't depend on other settings (unlike HDR, whose default depends on the codec).
function failingReads(failures) {
  const install = (keys) => {
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      if (keys[key] === 'throw') {
        throw new DOMException('Simulated read error of ' + key, 'UnknownError');
      }
      const request = originalGet.call(this, key);
      if (keys[key] === 'abort') {
        this.transaction.abort();
      }
      return request;
    };
  };
  return { content: '(' + install.toString() + ')(' + JSON.stringify(failures) + ');' };
}

// Init script that holds back the locale files of i18n.js until window.__releaseLocales() is called, which delays its
// first translation pass
function heldLocales() {
  const install = () => {
    const originalFetch = window.fetch;
    let release = null;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    window.__releaseLocales = release;
    window.fetch = function(input, init) {
      if (String(input).indexOf('static/locales/') >= 0) {
        return released.then(() => originalFetch.call(window, input, init));
      }
      return originalFetch.apply(window, arguments);
    };
  };
  return { content: '(' + install.toString() + ')();' };
}

// Wait until the app logged a line that contains the text
async function waitForLog(app, text) {
  const deadline = Date.now() + 5000;
  while (!app.logs.some((line) => line.indexOf(text) >= 0)) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the log line: ' + text);
    }
    await app.page.waitForTimeout(50);
  }
}

// The WebAssembly calls of the start, without the HTTP requests to hosts
function wasmCalls(page) {
  return page.evaluate(() => window.__wasmCalls.map((call) => call.name).filter((name) => name !== 'openUrl'));
}

test('a certificate that can\'t be read is not replaced, and the app asks for a restart', async () => {
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    stored: Object.assign({ settingsSchema: 5 }, EXISTING_INSTALL),
    initScripts: [failingReads({ cert: 'abort' })],
    readySignals: ['Auto adjust bitrate state', 'Loading system information...', 'Failed to read the stored certificate'],
  });
  try {
    await app.page.waitForTimeout(300);
    // No new certificate and no HTTP start with one: the pairing with every host stays as it is
    assert.deepEqual(await wasmCalls(app.page), []);
    assert.deepEqual(pick(await readStorage(app.page), ['uniqueid', 'cert', 'settingsSchema']), Object.assign({ settingsSchema: 5 }, EXISTING_INSTALL));
    assert.equal(await app.page.evaluate(() => $('#wasmSpinnerMessage').text()), 'Unable to read the stored pairing data. Please restart Moonlight.');
    assert.equal(await app.page.evaluate(() => $('#wasmSpinner').is(':visible')), true, 'the app stays on the loading screen');
    assert.equal(await app.page.evaluate(() => $('#wasmSpinner').hasClass('startup-failed')), true, 'without the moving bar');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a unique ID that can\'t be read is not replaced, and the install is not taken for a fresh one', async () => {
  const app = await openApp(harness, {
    tv: { tv: 'uhd', conn: 'wifi' },
    // An existing install without a settings schema, whose snapshot can't read the unique ID either
    stored: EXISTING_INSTALL,
    initScripts: [failingReads({ uniqueid: 'throw' })],
    readySignals: ['Auto adjust bitrate state', 'Loading system information...', 'Failed to read the stored unique ID'],
  });
  try {
    await app.page.waitForTimeout(300);
    assert.deepEqual(await wasmCalls(app.page), []);
    // Neither a new unique ID nor the settings schema of a fresh install is stored, so the snapshot of this existing
    // install still happens at a later start that can read its unique ID
    const stored = await readStorage(app.page);
    assert.equal(stored.uniqueid, EXISTING_INSTALL.uniqueid);
    assert.deepEqual(stored.cert, EXISTING_INSTALL.cert);
    assert.equal('settingsSchema' in stored, false);
    assert.ok(app.logs.some((line) => line.indexOf('Failed to read the stored settings, so the settings schema stays as it is.') >= 0));
    assert.equal(await app.page.evaluate(() => $('#wasmSpinnerMessage').text()), 'Unable to read the stored pairing data. Please restart Moonlight.');
    assert.equal(await app.page.evaluate(() => $('#wasmSpinner').hasClass('startup-failed')), true, 'without the moving bar');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a setting that can\'t be read shows its default for this start, and the following settings still load', async () => {
  const stored = Object.assign({ settingsSchema: 5, framePacing: false, fullRange: true, performanceStats: true }, EXISTING_INSTALL);
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    stored,
    initScripts: [failingReads({ framePacing: 'throw', fullRange: 'abort' })],
  });
  try {
    const shown = await readVideoSettings(app.page);
    // Both show their default, and the settings loaded after them are as stored
    assert.equal(shown.framePacing, true);
    assert.equal(shown.fullRange, false);
    // (the true that the switch of earlier versions stored shows as the level Full)
    assert.equal(await app.page.evaluate(() => $('#selectPerformanceStats').attr('data-value')), '2');
    // The stored values stay as they are, and the app started as usual with the stored certificate
    await app.page.waitForTimeout(300);
    assert.deepEqual(pick(await readStorage(app.page), ['framePacing', 'fullRange']), { framePacing: false, fullRange: true });
    assert.deepEqual(await wasmCalls(app.page), ['httpInit']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a bitrate preset state that can\'t be read keeps the bitrate and stores no new decision', async () => {
  // The stored 80 Mbps are the 4K preset over Wi-Fi, so a decision made without the stored state would store that the
  // presets follow the video settings, in place of the stored false
  const stored = Object.assign({
    settingsSchema: 5, autoAdjustBitrate: false, bitrate: '80', resolution: '3840:2160', frameRate: 60,
  }, EXISTING_INSTALL);
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    stored,
    initScripts: [failingReads({ autoAdjustBitrate: 'abort' })],
  });
  try {
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.autoAdjustBitrate], ['80', false]);
    assert.ok(app.logs.some((line) => line.indexOf('Auto adjust bitrate state not decided, since a stored value could not be read: false') >= 0));
    await app.page.waitForTimeout(300);
    assert.equal((await readStorage(app.page)).autoAdjustBitrate, false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the stored values are read as before when IndexedDB works', async () => {
  // The same install without read errors: the bitrate preset state is loaded as stored, and nothing is rewritten
  const stored = Object.assign({
    settingsSchema: 5, autoAdjustBitrate: false, bitrate: '80', resolution: '3840:2160', frameRate: 60, hdrMode: false,
  }, EXISTING_INSTALL);
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored });
  try {
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.autoAdjustBitrate, shown.hdr], ['80', false, false]);
    await waitForStorage(app.page, (values) => values.autoAdjustBitrate === false);
    await app.page.waitForTimeout(300);
    assert.deepEqual(await readStorage(app.page), stored);
    assert.deepEqual(await wasmCalls(app.page), ['httpInit']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a dialog opened before the first translation pass keeps its title and text', async () => {
  // On a German TV: English needs no locale file (wasm/platform/i18n.js), so its translation pass can't be held back
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi', locale: 'de_DE' },
    initScripts: [heldLocales()],
    // The app starts without waiting for the translation (loadSystemInfo() only runs after the translation pass)
    readySignals: ['Auto adjust bitrate state', 'Entering "Show Hosts" mode.'],
  });
  try {
    assert.equal(app.logs.some((line) => line.indexOf('Loading system information...') >= 0), false, 'not translated yet');
    await app.page.evaluate(() => warningDialog('Compatibility Warning', 'A warning that opened before the translation.'));
    await app.page.evaluate(() => window.__releaseLocales());
    await waitForLog(app, 'Loading system information...');
    const dialog = await app.page.evaluate(() => ({
      title: document.getElementById('warningDialogTitle').innerHTML,
      text: document.getElementById('warningDialogText').innerHTML,
      open: document.getElementById('warningDialog').open,
    }));
    assert.deepEqual(dialog, { title: 'Compatibility Warning', text: 'A warning that opened before the translation.', open: true });
    // A static text of the page is still translated by the same pass
    assert.equal(await app.page.evaluate(() => $('#closeWarning').text()), 'Schließen');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the dialogs whose texts the app sets keep them through a later translation pass', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    // The texts the app sets when the dialogs open, which a translation pass reset to the placeholders of index.html
    const opened = await app.page.evaluate(() => {
      const read = (id) => document.getElementById(id).innerHTML;
      const result = {};
      requiredRestartAppDialog();
      window.i18n.refreshUI();
      result.restart = read('restartAppDialogText');
      deleteHostDialog({ hostname: 'Test PC', serverUid: 'test' });
      window.i18n.refreshUI();
      result.deleteHost = [read('deleteHostDialogTitle'), read('deleteHostDialogText')];
      return result;
    });
    assert.deepEqual(opened, {
      restart: 'In order for your changes to take effect, a restart of the application is required.<br><br>Would you like to proceed with the restart?',
      deleteHost: ['Delete PC', 'Are you sure you want to delete Test PC?'],
    });
    // The static title of the restart dialog is still translated
    assert.equal(await app.page.evaluate(() => document.getElementById('restartAppDialogTitle').textContent), 'Restart Moonlight');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// The loading screen: its text, whether it shows, whether it stopped its moving bar, and whether that bar is drawn
const loadingScreen = (page) => page.evaluate(() => ({
  text: $('#wasmSpinnerMessage').text(),
  shown: $('#wasmSpinner').is(':visible'),
  failed: $('#wasmSpinner').hasClass('startup-failed'),
  barShown: $('#wasmSpinner > .bar1').is(':visible'),
}));

// The names of all WebAssembly calls, requests to hosts included
const allWasmCalls = (page) => page.evaluate(() => window.__wasmCalls.map((call) => call.name));

// The ways indexedDB.open() fails, as on a TV whose storage of the app is damaged: an error event, a throw (e.g. a
// SecurityError), and a block by another connection (none exists on a TV, whose database stays at version 1). Each open
// calls back once (fail() in openIndexDB()), and the start shows the restart text of a failed read.
const OPEN_FAILURES = [
  ['answers with an error', () => {
    IDBFactory.prototype.open = function() {
      const request = { error: new DOMException('Simulated open error', 'UnknownError') };
      setTimeout(() => request.onerror && request.onerror({ target: request }), 20);
      return request;
    };
  }, 'UnknownError: Simulated open error'],
  ['throws', () => {
    IDBFactory.prototype.open = function() {
      throw new DOMException('Simulated throw', 'SecurityError');
    };
  }, 'SecurityError: Simulated throw'],
  ['is blocked', () => {
    IDBFactory.prototype.open = function() {
      const request = {};
      setTimeout(() => request.onblocked && request.onblocked({ target: request }), 20);
      return request;
    };
  }, 'the database is blocked by another connection'],
];
for (const [how, failOpen, why] of OPEN_FAILURES) {
  test('a database that can\'t be opened (open() ' + how + ') ends the loading screen with the restart text', async () => {
    const app = await openApp(harness, {
      tv: { tv: 's90c', conn: 'wifi' },
      initScripts: [{ content: '(' + failOpen.toString() + ')();' }],
      // Up to 2.3.4 the first translation pass never ended, since getData() never called back
      readySignals: ['Cannot create or access the IndexedDB database', 'Loading system information...'],
    });
    try {
      await app.page.waitForTimeout(500);
      assert.deepEqual(await loadingScreen(app.page), {
        text: 'Unable to read the stored pairing data. Please restart Moonlight.', shown: true, failed: true, barShown: false,
      });
      assert.deepEqual(await allWasmCalls(app.page), [], 'neither a new certificate nor an HTTP start');
      // (the reads of the start may open the database more than once before the first failure ends)
      assert.ok(app.logs.some((line) => line.indexOf('Error: Cannot create or access the IndexedDB database: ' + why) >= 0),
        app.logs.filter((line) => /IndexedDB/.test(line)).join('\n'));
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });
}

test('a certificate that can\'t be made ends the loading screen with a message, without httpInit or polls', async () => {
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    moduleScripts: ['failing-start.js'],
    initScripts: [{ content: 'window.__failStart = \'makeCert\';' }],
    // A stored PC, which must not be asked without a certificate
    stored: { hosts: SUNSHINE_HOSTS },
    readySignals: ['Failed to generate a new certificate', 'Loading system information...'],
  });
  try {
    await app.page.waitForTimeout(500);
    assert.deepEqual(await loadingScreen(app.page), {
      text: 'Moonlight couldn\'t create its pairing certificate. Please restart Moonlight.', shown: true, failed: true, barShown: false,
    });
    // Up to 2.3.4 the next step read the certificate of undefined (an unhandled rejection), and the stored PCs loaded and
    // were polled anyway
    assert.deepEqual(await allWasmCalls(app.page), ['makeCert']);
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), [], 'no stored PC loaded');
    assert.equal('cert' in await readStorage(app.page), false, 'nothing stored, so the next start makes a certificate again');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a certificate that the module can\'t load ends the loading screen with a message', async () => {
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    moduleScripts: ['failing-start.js'],
    initScripts: [{ content: 'window.__failStart = \'httpInit\';' }],
    stored: Object.assign({ settingsSchema: 5, hosts: SUNSHINE_HOSTS }, EXISTING_INSTALL),
    readySignals: ['Failed HTTP initialization', 'Loading system information...'],
  });
  try {
    await app.page.waitForTimeout(500);
    const screen = await loadingScreen(app.page);
    assert.deepEqual([screen.shown, screen.failed, screen.barShown], [true, true, false]);
    assert.equal(screen.text, 'The stored pairing certificate can\'t be used. Please restart Moonlight. If this message comes again, uninstall ' +
      'Moonlight before you install it again, which deletes its settings and pairings.');
    assert.deepEqual(await allWasmCalls(app.page), ['httpInit']);
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), [], 'no stored PC loaded');
    // The stored certificate stays: a restart may load it
    assert.deepEqual((await readStorage(app.page)).cert, EXISTING_INSTALL.cert);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the texts of a start that can\'t go on fit the loading screen in every language', async () => {
  for (const locale of ['de_DE', 'es_ES', 'fr_FR', 'pt_BR']) {
    const app = await openApp(harness, {
      tv: { tv: 's90c', conn: 'wifi', locale },
      moduleScripts: ['failing-start.js'],
      initScripts: [{ content: 'window.__failStart = \'httpInit\';' }],
      stored: Object.assign({ settingsSchema: 5 }, EXISTING_INSTALL),
      readySignals: ['Failed HTTP initialization', 'Loading system information...'],
    });
    try {
      await app.page.waitForTimeout(500);
      const box = await app.page.evaluate(() => {
        const message = document.getElementById('wasmSpinnerMessage');
        const rect = message.getBoundingClientRect();
        const lines = Math.round(rect.height / parseFloat(getComputedStyle(message).lineHeight));
        return {
          text: message.textContent, lines, left: rect.left, right: rect.right, scrollWidth: message.scrollWidth, clientWidth: message.clientWidth,
          failed: $('#wasmSpinner').hasClass('startup-failed'), loadingText: t('Loading Moonlight...'),
        };
      });
      // The message of the failure in the language of the TV, not the loading text
      assert.equal(box.failed, true, locale);
      assert.notEqual(box.text, box.loadingText, locale);
      assert.notEqual(box.text.indexOf('Moonlight'), -1, locale);
      assert.ok(box.lines <= 3, locale + ': ' + box.lines + ' lines');
      assert.ok(box.left >= 0 && box.right <= 1920 && box.scrollWidth <= box.clientWidth, locale + ': ' + JSON.stringify(box));
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('a new certificate whose write is aborted (a full flash memory) is logged, and the start goes on', async () => {
  // The write of the certificate aborts its transaction, and only the abort event reaches the transaction, as for a
  // QuotaExceededError
  const abortCert = { content: '(' + (() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.apply(this, arguments);
      if (key === 'cert') {
        request.addEventListener('error', (event) => event.stopPropagation());
        this.transaction.abort();
      }
      return request;
    };
  }).toString() + ')();' };
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [abortCert] });
  try {
    await waitForLog(app, 'Failed to store the new pairing certificate');
    // (a transaction that the test aborts has no error, unlike one that the database aborts)
    assert.ok(app.logs.some((line) => line.indexOf('Error: Unable to store data at the key: cert in IndexedDB: the transaction was aborted') >= 0),
      app.logs.filter((line) => /IndexedDB/.test(line)).join('\n'));
    assert.equal('cert' in await readStorage(app.page), false);
    // The start went on with the certificate of this start
    assert.deepEqual(await allWasmCalls(app.page), ['makeCert', 'httpInit']);
    assert.equal(await app.page.evaluate(() => $('#host-grid').is(':visible')), true);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the first write of a fresh install that is aborted is logged with its keys, and the start goes on', async () => {
  // The unique ID and the settings schema of a fresh install go in one transaction (storeMultipleData()), which the
  // write of the schema, the last one, aborts; only the abort event reaches the transaction, as for a QuotaExceededError
  const abortFirstWrite = { content: '(' + (() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.apply(this, arguments);
      if (key === 'settingsSchema') {
        request.addEventListener('error', (event) => event.stopPropagation());
        this.transaction.abort();
      }
      return request;
    };
  }).toString() + ')();' };
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [abortFirstWrite] });
  try {
    await waitForLog(app, 'in IndexedDB was aborted');
    assert.ok(app.logs.some((line) => line.indexOf('Error: Storing the keys: uniqueid, settingsSchema in IndexedDB was aborted') >= 0),
      app.logs.filter((line) => /IndexedDB/.test(line)).join('\n'));
    assert.equal('uniqueid' in await readStorage(app.page), false);
    assert.deepEqual(await allWasmCalls(app.page), ['makeCert', 'httpInit']);
    assert.equal(await app.page.evaluate(() => $('#host-grid').is(':visible')), true);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the app asks once per start for persistent storage and logs the answer', async () => {
  const persist = { content: '(' + (() => {
    window.__persistCalls = 0;
    navigator.storage.persisted = () => Promise.resolve(false);
    navigator.storage.persist = () => {
      window.__persistCalls++;
      return Promise.resolve(true);
    };
  }).toString() + ')();' };
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [persist] });
  try {
    assert.equal(await app.page.evaluate(() => window.__persistCalls), 1, 'the database opens twice at a start, the request once');
    assert.ok(app.logs.some((line) => line.indexOf('Persistent storage granted: the storage will not be cleared except by explicit user action.') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
