'use strict';

// Checks the Rescan network button of the Hosts header (rescanNetwork() in wasm/platform/index.js): the remote and a
// gamepad reach it from the host grid, it runs the subnet scan of static/js/mdns-browser/main.js again with the polling
// of the known hosts paused, runs only once at a time, and resumes the polling only while the hosts are shown. It also
// checks that the header still presses Settings after a return from the settings, now that the button comes first.
// The scan is replaced by one that the test finishes by hand; the calls of the polling are recorded.

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

// The id of the focused element
const focused = (page) => page.evaluate(() => (document.activeElement ? document.activeElement.id : ''));

// The first key after the start only gives the menus the focus (Navigation in navigation.js), so press LEFT, which
// doesn't move on the Add Host card, and wait for the card to have the focus
async function takeFocus(page) {
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'addHostContainer', null, { timeout: 3000 });
}

// Open the app with a scan that waits for the test, and record the scans, the polling and the snackbar messages
async function openWithScan() {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  // Let the scan of the start finish first, which resumes the polling when it ends
  await app.page.waitForFunction(() => isSubnetScanFinished === true, null, { timeout: 15000 });
  await app.page.evaluate(() => {
    window.__events = [];
    window.__finishScan = null;
    startSubnetScanner = () => {
      window.__events.push('scan');
      return new Promise((resolve) => {
        window.__finishScan = () => {
          window.__events.push('scan finished');
          resolve();
        };
      });
    };
    const realStop = stopPollingHosts;
    stopPollingHosts = function() {
      window.__events.push('stop polling');
      return realStop();
    };
    const realStart = startPollingHosts;
    startPollingHosts = function() {
      window.__events.push('start polling');
      return realStart();
    };
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    window.__snackbarMessages = [];
    snackbar.showSnackbar = (data) => window.__snackbarMessages.push(data.message);
  });
  return app;
}

const state = (page) => page.evaluate(() => ({
  events: window.__events.slice(),
  messages: window.__snackbarMessages.slice(),
  scanning: $('#rescanNetworkBtn').hasClass('is-scanning'),
}));

const finishScan = (page) => page.evaluate(async () => {
  window.__finishScan();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('the button shows in the Hosts header only, with its translated label', async () => {
  const app = await openWithScan();
  try {
    const shown = await app.page.evaluate(() => ({
      visible: $('#rescanNetworkBtn').is(':visible'),
      icon: $('#rescanNetworkBtn i').text().trim(),
      label: $('#rescanNetworkTooltip').text().trim(),
      order: $('nav.mdl-navigation > button').map(function() { return this.id; }).get(),
    }));
    assert.deepEqual(shown, { visible: true, icon: 'refresh', label: 'Rescan network',
      order: ['rescanNetworkBtn', 'settingsBtn', 'supportBtn', 'restoreDefaultsBtn', 'quitRunningAppBtn'] });
    await app.page.evaluate(() => $('#settingsBtn').trigger('click'));
    await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    assert.equal(await app.page.evaluate(() => $('#rescanNetworkBtn').is(':visible')), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the remote reaches the button with UP and starts a scan with OK, which pauses the polling', async () => {
  const app = await openWithScan();
  try {
    // From the Add Host card of an install without hosts, UP goes to the first button of the header
    await takeFocus(app.page);
    assert.equal(await focused(app.page), 'addHostContainer');
    await app.page.keyboard.press('ArrowUp');
    assert.equal(await focused(app.page), 'rescanNetworkBtn');
    await app.page.keyboard.press('Enter');
    let current = await state(app.page);
    assert.deepEqual(current.events, ['stop polling', 'scan']);
    assert.equal(current.scanning, true, 'the icon turns while the scan runs');
    assert.deepEqual(current.messages, ['Scanning the local network to discover new hosts...']);

    // A second OK during the scan starts no second scan
    await app.page.keyboard.press('Enter');
    current = await state(app.page);
    assert.deepEqual(current.events, ['stop polling', 'scan']);
    assert.equal(current.messages[1], 'The local network is already being scanned.');

    await finishScan(app.page);
    current = await state(app.page);
    assert.deepEqual(current.events, ['stop polling', 'scan', 'scan finished', 'start polling']);
    assert.equal(current.scanning, false);
    assert.equal(current.messages[2], 'Finished scanning the local network.');
    assert.equal(await app.page.evaluate(() => isSubnetScanFinished), true);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a gamepad reaches the button with the D-pad and starts a scan with A', async () => {
  const app = await openWithScan();
  try {
    await app.page.evaluate(async () => {
      const send = (index, pressed) => window.dispatchEvent(new CustomEvent('gamepadinputchanged', {
        detail: { changes: [{ type: 'button', index, pressed }] },
      }));
      // The first input only gives the menus the focus, the second moves up
      send(12, true);
      send(12, false);
      send(12, true);
      send(12, false);
      send(0, true);
      send(0, false);
      // A presses after the navigation delay of 150 ms
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    assert.deepEqual((await state(app.page)).events, ['stop polling', 'scan']);
    await finishScan(app.page);
    assert.deepEqual((await state(app.page)).events, ['stop polling', 'scan', 'scan finished', 'start polling']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a scan that ends while the settings are shown leaves the polling stopped', async () => {
  const app = await openWithScan();
  try {
    await app.page.evaluate(() => {
      rescanNetwork();
    });
    await app.page.evaluate(() => $('#settingsBtn').trigger('click'));
    await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await finishScan(app.page);
    const current = await state(app.page);
    // Opening the settings stops the polling as well; nothing starts it again after the scan
    assert.deepEqual(current.events.slice(0, 2), ['stop polling', 'scan']);
    assert.equal(current.events[current.events.length - 1], 'scan finished');
    assert.equal(current.events.includes('start polling'), false);
    assert.equal(current.messages.includes('Finished scanning the local network.'), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('after a return from the settings, OK in the header presses Settings again', async () => {
  const app = await openWithScan();
  try {
    await takeFocus(app.page);
    // Open the settings with the pointer, which leaves the first button of the header (Rescan network) selected
    assert.equal(await app.page.evaluate(() => Views.HostsNav.view.current()), 'rescanNetworkBtn');
    await app.page.evaluate(() => $('#settingsBtn').trigger('click'));
    await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await app.page.waitForTimeout(100);
    // The Return key of the remote goes back to the hosts with the Settings button selected
    await app.page.evaluate(() => remoteControllerHandler({ keyCode: tvKey.KEY_RETURN, repeat: false, preventDefault() {} }));
    await app.page.waitForFunction(() => $('#host-grid').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await app.page.waitForTimeout(700);
    assert.equal(await app.page.evaluate(() => Views.HostsNav.view.current()), 'settingsBtn');
    // UP from the host grid returns to the Settings button, and OK presses it
    await app.page.keyboard.press('ArrowUp');
    assert.equal(await focused(app.page), 'settingsBtn');
    await app.page.keyboard.press('Enter');
    await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    assert.equal((await state(app.page)).events.includes('scan'), false, 'OK opened the settings, not a scan');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
