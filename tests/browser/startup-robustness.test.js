'use strict';

// How the app copes with what can go wrong while it starts:
// - A stored value that IndexedDB can't read. getData() passed an undefined variable on its error paths and threw a
//   ReferenceError instead of calling back. Now the callback gets null and learns that the read failed: a setting shows
//   its default for this start, and nothing that a read error made up replaces a stored value (the certificate and
//   unique ID, which keep the pairing with every host, and the bitrate preset state).
// - A dialog that opens before the first translation pass of i18n.js, which rewrote every element with a data-i18n
//   attribute and so reset the title and text of the dialog to its placeholders (e.g. 'Warning').

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, pick, readStorage, readVideoSettings, startHarness, waitForStorage } = require('./harness');

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
    stored: Object.assign({ settingsSchema: 3 }, EXISTING_INSTALL),
    initScripts: [failingReads({ cert: 'abort' })],
    readySignals: ['Auto adjust bitrate state', 'Loading system information...', 'Failed to read the stored certificate'],
  });
  try {
    await app.page.waitForTimeout(300);
    // No new certificate and no HTTP start with one: the pairing with every host stays as it is
    assert.deepEqual(await wasmCalls(app.page), []);
    assert.deepEqual(pick(await readStorage(app.page), ['uniqueid', 'cert', 'settingsSchema']), Object.assign({ settingsSchema: 3 }, EXISTING_INSTALL));
    assert.equal(await app.page.evaluate(() => $('#wasmSpinnerMessage').text()), 'Unable to read the stored pairing data. Please restart Moonlight.');
    assert.equal(await app.page.evaluate(() => $('#wasmSpinner').is(':visible')), true, 'the app stays on the loading screen');
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
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a setting that can\'t be read shows its default for this start, and the following settings still load', async () => {
  const stored = Object.assign({ settingsSchema: 3, framePacing: false, fullRange: true, performanceStats: true }, EXISTING_INSTALL);
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
    settingsSchema: 3, autoAdjustBitrate: false, bitrate: '80', resolution: '3840:2160', frameRate: 60,
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
    settingsSchema: 3, autoAdjustBitrate: false, bitrate: '80', resolution: '3840:2160', frameRate: 60, hdrMode: false,
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
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
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
    assert.equal(await app.page.evaluate(() => $('#closeWarning').text()), 'Close');
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
      deleteHost: ['Delete Host', 'Are you sure you want to delete Test PC?'],
    });
    // The static title of the restart dialog is still translated
    assert.equal(await app.page.evaluate(() => document.getElementById('restartAppDialogTitle').textContent), 'Restart Moonlight');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
