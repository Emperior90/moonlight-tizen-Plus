'use strict';

// Checks the Rescan network button of the Hosts header (rescanNetwork() in wasm/platform/index.js): the remote and a
// gamepad reach it from the host grid, it runs the subnet scan of static/js/mdns-browser/main.js again with the polling
// of the known hosts paused, runs only once at a time, and resumes the polling only while the hosts are shown, with one
// poll loop per host also when it was pressed during the scan or the first polls at startup. It also checks that the
// header still presses Settings after a return from the settings, now that the button comes first. The scan is
// replaced by one that the test finishes by hand; the calls of the polling are recorded.

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
      // The refresh icon of the sprite, which must be drawn there
      icon: $('#rescanNetworkBtn use').attr('xlink:href'),
      iconDrawn: document.querySelector('#icon-sprite symbol#i-refresh') !== null,
      label: $('#rescanNetworkTooltip').text().trim(),
      order: $('nav.mdl-navigation > button').map(function() { return this.id; }).get(),
    }));
    assert.deepEqual(shown, { visible: true, icon: '#i-refresh', iconDrawn: true, label: 'Rescan network',
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

// Replace the known hosts by two simulated ones whose server info requests take refreshMs, and the scan by one that the
// test finishes by hand and that returns the running scan to a second caller, like startSubnetScanner(). The polls of
// each host (pollServer() of utils.js, which the poll loop calls every 5 seconds) are counted in window.__polls.
const simulateHosts = (page, refreshMs) => page.evaluate((delay) => {
  stopPollingHosts();
  Object.keys(hosts).forEach((uid) => delete hosts[uid]);
  document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = () => {};
  window.__polls = {};
  window.__starts = 0;
  ['HOST1', 'HOST2'].forEach((uid, index) => {
    const host = new NvHTTP('10.0.0.' + (10 + index), 'client', '', '');
    host.serverUid = uid;
    host.paired = false;
    window.__polls[uid] = 0;
    host.refreshServerInfo = () => new Promise((resolve) => setTimeout(resolve, delay));
    host.selectServerAddress = (onSuccess) => setTimeout(() => onSuccess(host.address), 10);
    const realPoll = host.pollServer;
    host.pollServer = function(onComplete) {
      window.__polls[uid]++;
      return realPoll.call(host, onComplete);
    };
    hosts[uid] = host;
  });
  window.subnetScanPromise = null;
  window.__finishScan = null;
  startSubnetScanner = () => {
    if (!window.subnetScanPromise) {
      window.subnetScanPromise = new Promise((resolve) => {
        window.__finishScan = () => {
          window.subnetScanPromise = null;
          resolve();
        };
      });
    }
    return window.subnetScanPromise;
  };
  const realStart = startPollingHosts;
  startPollingHosts = function() {
    window.__starts++;
    return realStart();
  };
}, refreshMs);

// Count the polls of each host for a bit more than one poll interval (5 s) after the scan finished
const pollsAfterScan = (page) => page.evaluate(async () => {
  window.__finishScan();
  // The first refreshes of the resumed polling end, and each loop waits 5 seconds for its first poll
  await new Promise((resolve) => setTimeout(resolve, 200));
  Object.keys(window.__polls).forEach((uid) => {
    window.__polls[uid] = 0;
  });
  await new Promise((resolve) => setTimeout(resolve, 5300));
  const polls = Object.assign({}, window.__polls);
  stopPollingHosts();
  return { polls, starts: window.__starts };
});

test('Rescan network during the scan at startup leaves one poll loop per host', async () => {
  const app = await openWithScan();
  try {
    await simulateHosts(app.page, 20);
    await app.page.evaluate(async () => {
      discoverHostsAtStartup();
      while (!window.__finishScan) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // The button presses into the running scan, which both resume the polling once it ends
      $('#rescanNetworkBtn').trigger('click');
    });
    const result = await pollsAfterScan(app.page);
    assert.equal(result.starts, 3, 'the start, the end of the scan and the end of the rescan start the polling');
    assert.deepEqual(result.polls, { HOST1: 1, HOST2: 1 });
    assert.equal(await app.page.evaluate(() => $('#rescanNetworkBtn').hasClass('is-scanning')), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Rescan network during the first polls at startup leaves one poll loop per host', async () => {
  const app = await openWithScan();
  try {
    // The first server info requests of the start are still running when the button is pressed
    await simulateHosts(app.page, 300);
    await app.page.evaluate(async () => {
      discoverHostsAtStartup();
      await new Promise((resolve) => setTimeout(resolve, 20));
      $('#rescanNetworkBtn').trigger('click');
      while (!window.__finishScan) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // The start waits for its first polls before it joins the scan of the button
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const result = await pollsAfterScan(app.page);
    assert.deepEqual(result.polls, { HOST1: 1, HOST2: 1 });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
