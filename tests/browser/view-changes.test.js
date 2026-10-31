'use strict';

// Checks that the views change without the fixed wait of 500 ms that upstream had before each of them (showHosts(),
// showSettings() and showApps() in wasm/platform/index.js): the settings and the hosts show at once, and opening a host
// asks for its app list at once. Only right after it stopped a running scan of the network does the app list wait a
// moment (SCAN_ABORT_PAUSE_MS), while the TV drops the requests of the scan. The auto-repeat of a held OK, which the
// wait used to swallow, is ignored instead (tests/unit/navigation-keys.test.js).

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

test('the settings and the hosts show at once', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const shown = await app.page.evaluate(() => {
      showSettings();
      // Right after the call, without waiting for a timer
      const settings = { settings: $('#settings-list').is(':visible'), spinner: $('#wasmSpinner').is(':visible'), restore: $('#restoreDefaultsBtn').is(':visible') };
      $('#goBackBtn').trigger('click');
      const hosts = { hosts: $('#host-grid').is(':visible'), settings: $('#settings-list').is(':visible'), spinner: $('#wasmSpinner').is(':visible') };
      return { settings, hosts };
    });
    assert.deepEqual(shown, {
      settings: { settings: true, spinner: false, restore: true },
      hosts: { hosts: true, settings: false, spinner: false },
    });
    // The remote works in the hosts right away
    await app.page.keyboard.press('ArrowUp');
    await app.page.keyboard.press('ArrowRight');
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'settingsBtn');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// Open a paired host whose app list arrives at once, and return how long after showApps() the app list was asked for
const openHost = (page) => page.evaluate(async () => {
  const host = new NvHTTP('10.0.0.2', '0123456789abcdef', '', '');
  Object.assign(host, { paired: true, online: true, hostname: 'GAMING-PC', serverUid: 'HOST1', currentGame: 0 });
  let askedAfter = null;
  const start = performance.now();
  host.getAppList = () => {
    askedAfter = performance.now() - start;
    return Promise.resolve([]);
  };
  await showApps(host);
  return Math.round(askedAfter);
});

test('opening a host asks for its app list at once, and waits a moment only right after it stopped a scan', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.waitForFunction(() => isSubnetScanFinished === true, null, { timeout: 15000 });
    const direct = await openHost(app.page);
    assert.ok(direct < 100, 'the app list was asked for after ' + direct + ' ms');
    assert.equal(await app.page.evaluate(() => $('#game-grid').is(':visible')), true);

    // A scan of the network runs: opening the host stops it, and asks for the app list a moment later
    await app.page.evaluate(() => {
      window.subnetScanPromise = new Promise(() => {});
      window.subnetScanAbortCtrl = new AbortController();
      window.__scanSignal = window.subnetScanAbortCtrl.signal;
    });
    const afterScan = await openHost(app.page);
    assert.ok(afterScan >= 290 && afterScan < 1000, 'the app list was asked for after ' + afterScan + ' ms');
    assert.equal(await app.page.evaluate(() => window.__scanSignal.aborted), true);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
