'use strict';

// Checks the Wake PC dialog (autoWolDialog() in wasm/platform/index.js) and the poll queue of a host that it waits on
// (NvHTTP.pollServer() in wasm/static/js/utils.js):
// - after a failed request (e.g. 'Failed to create socket', the normal case on some TVs) OK and RETURN close the
//   dialog, whose button handler threw a ReferenceError before, and the dialog points to waking the PC with another
//   device,
// - the dialog closes once the PC answers also when its poll ran while the scan at startup ended, whose background
//   polling threw away the callback of the dialog before (the model of
//   fork-research/repro/wol_callback_race.js), and also when the background polling is the first to reach the PC,
// - the dialog sends the request again while it waits, and stops once it is closed,
// - since 2.3.5 the dialog scans the network when it opens and then at most every WOL_SCAN_INTERVAL_MS (30 seconds)
//   instead of before every poll, the polling of the hosts pauses while it waits (the ends of the scan at startup and of
//   Rescan network don't restart it meanwhile) and resumes once it closes, and after WOL_HINT_DELAY_MS (90 seconds) it
//   says what to check on the PC and keeps waiting,
// - a callback of a poll that throws neither keeps the other callbacks from the result nor keeps later polls from
//   starting,
// - the dialog opens on Cancel, so that OK closes it: it used to open on the switch 'Always wake this PC automatically',
//   which showed no highlight, and OK turned that on. UP selects the switch, which shows a ring then, and OK toggles it.
// The host is an NvHTTP object whose network requests are simulated: the PC answers once window.__pcAwake is true.

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

// Press and release a key of the remote on the focused element, like the TV delivers it
const remoteKey = (page, keyCode, key) => page.evaluate(({ code, name }) => {
  ['keydown', 'keyup'].forEach((type) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  });
}, { code: keyCode, name: key });
const RETURN = [10009, 'XF86Back'];
const OK = [13, 'Enter'];

// The first key after the start only gives the menus the focus (Navigation in navigation.js), so press LEFT, which
// doesn't move on the Add Host card, and wait for the card to have the focus
async function takeFocus(page) {
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'addHostContainer', null, { timeout: 3000 });
}

// Open the app once its scan at startup is over, and replace the known hosts by one offline PC (HOST1) built on NvHTTP:
// its server info refresh takes refreshMs and its address check (selectServerAddress(), the request of every poll)
// pollMs, and both fail until window.__pcAwake is true. Its Wake-on-LAN request answers with `wol` ('ok' or an error
// text to reject with). The requests, the polls and the callbacks of the dialog are recorded in window.__events, and
// the scan of the network that the dialog runs now and then before a poll is window.__scan (a pending promise) or none.
async function openWithOfflineHost(options) {
  const opts = Object.assign({ refreshMs: 50, pollMs: 50, wol: 'ok' }, options);
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  await app.page.waitForFunction(() => isSubnetScanFinished === true, null, { timeout: 15000 });
  await app.page.evaluate((o) => {
    stopPollingHosts();
    Object.keys(hosts).forEach((uid) => delete hosts[uid]);
    document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = () => {};
    window.__pcAwake = false;
    window.__events = [];
    window.__scan = null;
    startSubnetScanner = () => window.__scan || Promise.resolve();
    const host = new NvHTTP('10.0.0.20', 'client', '', '');
    // Not paired, so that a poll that reaches the PC requests nothing else (MAC address, app list)
    Object.assign(host, { serverUid: 'HOST1', hostname: 'GAMING-PC', paired: false, online: false, macAddress: '02:11:22:33:44:55' });
    host.refreshServerInfo = () => new Promise((resolve, reject) => setTimeout(() => {
      window.__events.push('refresh ' + (window.__pcAwake ? 'ok' : 'failed'));
      if (window.__pcAwake) {
        resolve();
      } else {
        reject('offline');
      }
    }, o.refreshMs));
    host.selectServerAddress = (onSuccess, onFailure) => {
      window.__events.push('poll');
      setTimeout(() => (window.__pcAwake ? onSuccess(host.address) : onFailure()), o.pollMs);
    };
    host.sendWOL = () => {
      window.__events.push('wol');
      return o.wol === 'ok' ? Promise.resolve('Sent the magic packets') : Promise.reject(o.wol);
    };
    hosts.HOST1 = host;
    window.__host = host;
    window.openWolDialog = () => autoWolDialog(host, () => window.__events.push('success'), () => window.__events.push('cancel'));
  }, opts);
  return app;
}

// What the dialog shows
const dialogState = (page) => page.evaluate(() => ({
  open: document.getElementById('autoWolDialog').open,
  overlay: document.getElementById('autoWolDialogOverlay').style.display,
  isDialogOpen,
  text: $('#autoWolDialogText').text(),
  button: $('#cancelAutoWol').text().trim(),
}));

const events = (page) => page.evaluate(() => window.__events.slice());

// The events up to the close of the dialog (its cancel or success): since 2.3.5 the polling of the hosts resumes once
// it closed, whose refresh and polls of the host follow
const eventsUntilClosed = (page) => page.evaluate(() => {
  const end = window.__events.findIndex((entry) => entry === 'cancel' || entry === 'success');
  return end < 0 ? window.__events.slice() : window.__events.slice(0, end + 1);
});

test('after a failed request, OK closes the dialog, which names the error and another way to wake the PC', async () => {
  const app = await openWithOfflineHost({ wol: 'Failed to create socket' });
  try {
    await app.page.evaluate(() => window.openWolDialog());
    await app.page.waitForFunction(() => $('#cancelAutoWol').text().trim() === 'OK', null, { timeout: 3000 });
    let state = await dialogState(app.page);
    assert.equal(state.open, true);
    assert.equal(state.text, 'Failed to send Wake-on-LAN request to GAMING-PC!Error: Failed to create socket' +
      'You can wake the PC with another device instead, e.g. with a Wake-on-LAN app on a phone.');
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'cancelAutoWol');

    await app.page.evaluate(() => $('#cancelAutoWol').trigger('click'));
    state = await dialogState(app.page);
    assert.deepEqual([state.open, state.overlay, state.isDialogOpen], [false, 'none', false]);
    assert.deepEqual(await eventsUntilClosed(app.page), ['wol', 'cancel'], 'one request, no poll after the failure');
    assert.ok(app.logs.some((line) => line.indexOf('Wake-on-LAN request failed: Failed to create socket') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('after a failed request, OK is selected, so that OK on the remote closes the dialog and leaves Auto-WOL as it was', async () => {
  const app = await openWithOfflineHost({ wol: 'Failed to create socket' });
  try {
    await takeFocus(app.page);
    const autoWolBefore = await app.page.evaluate(() => document.querySelector('#autoWolCheckboxSwitch').checked);
    await app.page.evaluate(() => window.openWolDialog());
    await app.page.waitForFunction(() => $('#cancelAutoWol').text().trim() === 'OK', null, { timeout: 3000 });
    // Past the 300 ms in which the dialog takes OK for the second press of the one that opened it (navigation.js)
    await app.page.waitForTimeout(350);
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'cancelAutoWol');
    assert.equal(await app.page.evaluate(() => elementId(Views.AutoWolDialog.view.current())), 'cancelAutoWol');
    await remoteKey(app.page, ...OK);
    const state = await dialogState(app.page);
    assert.deepEqual([state.open, state.overlay, state.isDialogOpen], [false, 'none', false]);
    assert.equal(await app.page.evaluate(() => document.querySelector('#autoWolCheckboxSwitch').checked), autoWolBefore,
      'OK did not switch Auto-WOL');
    assert.deepEqual(await eventsUntilClosed(app.page), ['wol', 'cancel']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('after a failed request, RETURN closes the dialog as well', async () => {
  const app = await openWithOfflineHost({ wol: 'The PC hasn\'t reported its MAC address (00:00:00:00:00:00)' });
  try {
    await takeFocus(app.page);
    await app.page.evaluate(() => window.openWolDialog());
    await app.page.waitForFunction(() => $('#cancelAutoWol').text().trim() === 'OK', null, { timeout: 3000 });
    assert.match((await dialogState(app.page)).text, /Error: The PC hasn't reported its MAC address \(00:00:00:00:00:00\)/);
    await remoteKey(app.page, ...RETURN);
    const state = await dialogState(app.page);
    assert.deepEqual([state.open, state.overlay, state.isDialogOpen], [false, 'none', false]);
    assert.deepEqual(await eventsUntilClosed(app.page), ['wol', 'cancel']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the dialog closes once the PC answers, also when its poll ran while the scan at startup ended', async () => {
  // The address check of a poll takes longer than the first server info refresh of the background polling, which the
  // end of the scan starts in the same turn as the poll of the dialog
  const app = await openWithOfflineHost({ refreshMs: 50, pollMs: 200 });
  try {
    await app.page.evaluate(async () => {
      window.__scan = new Promise((resolve) => {
        window.__finishScan = () => {
          window.__scan = null;
          resolve();
        };
      });
      // The start polls the hosts, then scans the network and polls them again once the scan is over
      discoverHostsAtStartup();
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The dialog opens during the scan, sends its request and waits for the same scan before its first poll
      window.openWolDialog();
      await new Promise((resolve) => setTimeout(resolve, 50));
      window.__events.length = 0;
      window.__finishScan();
      // The PC comes up after the first poll, which reports it offline
      await new Promise((resolve) => setTimeout(resolve, 300));
      window.__pcAwake = true;
    });
    // The dialog polls again 1 second after its first poll ended, which reaches the PC
    await app.page.waitForFunction(() => window.__events.indexOf('success') >= 0, null, { timeout: 3000 }).catch(() => {});
    const state = await dialogState(app.page);
    const recorded = await eventsUntilClosed(app.page);
    assert.deepEqual([state.open, state.isDialogOpen], [false, false], 'the dialog closed: ' + JSON.stringify(recorded));
    // The first poll of the dialog after the scan, and its next poll, which reached the PC. Since 2.3.5 the end of the
    // scan doesn't restart the background polling while the dialog waits (up to 2.3.4 its refresh came between them,
    // and its poll joined the one of the dialog), and the callback of the dialog is still not lost.
    assert.deepEqual(recorded, ['poll', 'poll', 'success']);
    assert.equal(recorded.indexOf('refresh failed'), -1, 'the polling of the hosts pauses while the dialog waits');
    assert.equal(await app.page.evaluate(() => window.__host.online), true);
    assert.equal(await app.page.evaluate(() => window.__host._pollCompletionCallbacks.length), 0);
    assert.ok(app.logs.some((line) => line.indexOf('GAMING-PC is online, closing the Wake PC dialog.') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.page.evaluate(() => stopPollingHosts());
    await app.context.close();
  }
});

test('the dialog closes when the background polling reaches the PC first', async () => {
  const app = await openWithOfflineHost();
  try {
    await app.page.evaluate(async () => {
      // A scan of the network that doesn't end keeps the poll of the dialog waiting
      window.__scan = new Promise(() => {});
      window.openWolDialog();
      await new Promise((resolve) => setTimeout(resolve, 100));
      window.__pcAwake = true;
      beginBackgroundPollingOfHost(window.__host);
    });
    await app.page.waitForFunction(() => window.__events.indexOf('success') >= 0, null, { timeout: 2000 }).catch(() => {});
    const state = await dialogState(app.page);
    assert.deepEqual([state.open, state.overlay, state.isDialogOpen], [false, 'none', false]);
    assert.deepEqual(await eventsUntilClosed(app.page), ['wol', 'refresh ok', 'success'], 'the dialog itself never polled');
    // Only the open dialog is notified: a later report of the background polling closes nothing
    assert.equal(await app.page.evaluate(() => wolDialogWait), null);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.page.evaluate(() => stopPollingHosts());
    await app.context.close();
  }
});

test('the dialog sends the request again while it waits, and stops once it is closed', async () => {
  const app = await openWithOfflineHost();
  try {
    const sent = await app.page.evaluate(async () => {
      WOL_RESEND_INTERVAL_MS = 100;
      window.__scan = new Promise(() => {});
      window.openWolDialog();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const whileOpen = window.__events.filter((entry) => entry === 'wol').length;
      $('#cancelAutoWol').trigger('click');
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { whileOpen, afterClose: window.__events.filter((entry) => entry === 'wol').length };
    });
    assert.ok(sent.whileOpen >= 3, 'the first request and again every 100 ms: ' + sent.whileOpen);
    assert.equal(sent.afterClose, sent.whileOpen, 'no request after the dialog closed');
    // The dialog never polled (its scan never ended); after the close the polling of the hosts resumes (since 2.3.5)
    assert.equal((await events(app.page)).filter((entry) => entry !== 'wol')[0], 'cancel');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.page.evaluate(() => stopPollingHosts());
    await app.context.close();
  }
});

// Count the scans of the network in window.__scans, which wait for window.__scan as before
const countScans = (page) => page.evaluate(() => {
  window.__scans = 0;
  startSubnetScanner = () => {
    window.__scans++;
    return window.__scan || Promise.resolve();
  };
});

test('the dialog scans the network when it opens, then at most every WOL_SCAN_INTERVAL_MS, and polls in between', async () => {
  const app = await openWithOfflineHost();
  try {
    await countScans(app.page);
    await app.page.evaluate(async () => {
      WOL_SCAN_INTERVAL_MS = 60000;
      window.openWolDialog();
      await new Promise((resolve) => setTimeout(resolve, 2600));
    });
    // A poll about every second (each 1 second after the one before ended), and one scan, when the dialog opened: up to
    // 2.3.4 a scan of 254 addresses before every poll
    const polls = (await events(app.page)).filter((entry) => entry === 'poll').length;
    assert.equal(await app.page.evaluate(() => window.__scans), 1);
    assert.ok(polls >= 2, 'polls: ' + polls);
    // Once the interval passed, the next poll scans first again
    await app.page.evaluate(async () => {
      WOL_SCAN_INTERVAL_MS = 500;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    const scanCount = await app.page.evaluate(() => window.__scans);
    const allPolls = (await events(app.page)).filter((entry) => entry === 'poll').length;
    assert.ok(scanCount >= 2 && scanCount <= 4, 'scans: ' + scanCount);
    assert.ok(scanCount < allPolls, 'fewer scans (' + scanCount + ') than polls (' + allPolls + ')');
    await app.page.evaluate(() => $('#cancelAutoWol').trigger('click'));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.page.evaluate(() => stopPollingHosts());
    await app.context.close();
  }
});

test('the polling of the hosts pauses while the dialog waits, also past the end of a scan, and resumes once it is closed', async () => {
  const app = await openWithOfflineHost();
  try {
    const seen = await app.page.evaluate(async () => {
      window.__scan = new Promise((resolve) => {
        window.__finishScan = resolve;
      });
      startPollingHosts();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = Object.keys(activePolls);
      // Rescan network runs, and the dialog opens meanwhile (Wake PC in the menu of the PC) and waits for the same scan
      const rescan = rescanNetwork();
      window.openWolDialog();
      const during = Object.keys(activePolls);
      window.__finishScan();
      await rescan;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The end of the scan didn't restart the polling, and the dialog polls its host itself
      const afterScan = Object.keys(activePolls);
      const dialogPolled = window.__events.indexOf('poll') >= 0;
      $('#cancelAutoWol').trigger('click');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const afterClose = Object.keys(activePolls);
      stopPollingHosts();
      return { before, during, afterScan, dialogPolled, afterClose };
    });
    assert.deepEqual(seen, { before: ['HOST1'], during: [], afterScan: [], dialogPolled: true, afterClose: ['HOST1'] });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the dialog says what to check on the PC once it waited WOL_HINT_DELAY_MS, and keeps waiting', async () => {
  const app = await openWithOfflineHost();
  try {
    await app.page.evaluate(async () => {
      WOL_HINT_DELAY_MS = 300;
      window.openWolDialog();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    let state = await dialogState(app.page);
    assert.equal(state.text, 'Wake-on-LAN request sent to GAMING-PC.Waiting for the host PC to wake up and connect to the network...');
    await app.page.waitForTimeout(300);
    state = await dialogState(app.page);
    assert.deepEqual([state.open, state.button], [true, 'Cancel']);
    assert.equal(state.text, 'Wake-on-LAN request sent to GAMING-PC.Waiting for the host PC to wake up and connect to the network...' +
      'GAMING-PC hasn\'t answered yet. Check that Wake-on-LAN is on in its BIOS or UEFI and in the settings of its network adapter, and that Sunshine starts with the PC.');
    assert.ok(app.logs.some((line) => /GAMING-PC hasn't answered \d+ seconds after the Wake-on-LAN request\./.test(line)));
    // It still waits for the PC, and closes once the PC answers
    await app.page.evaluate(async () => {
      window.__pcAwake = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    assert.equal((await dialogState(app.page)).open, false);
    assert.deepEqual(await eventsUntilClosed(app.page).then((list) => list.slice(-1)), ['success']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.page.evaluate(() => stopPollingHosts());
    await app.context.close();
  }
});

test('a poll callback that throws neither keeps the others from the result nor blocks the next poll', async () => {
  const app = await openWithOfflineHost();
  try {
    const result = await app.page.evaluate(async () => {
      const host = window.__host;
      const called = [];
      window.__pcAwake = true;
      host.pollServer((returned) => called.push('first ' + returned.online));
      // Joins the running poll
      host.pollServer(() => {
        throw new Error('broken callback');
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      host.pollServer(() => called.push('next poll'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { called, polls: window.__events.filter((entry) => entry === 'poll').length, pending: host._pollCompletionCallbacks.length };
    });
    assert.deepEqual(result, { called: ['first true', 'next poll'], polls: 2, pending: 0 });
    assert.ok(app.logs.some((line) => line.indexOf('Error: A callback of the poll of GAMING-PC failed:') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// The selection of the dialog: the item of its view, the highlighted controls, the focused one and the ring of the switch
const wolSelection = (page) => page.evaluate(() => ({
  current: elementId(Views.AutoWolDialog.view.current()),
  marked: Array.prototype.map.call(document.querySelectorAll('#autoWolDialog .hovered'), (element) => element.id),
  focused: document.activeElement ? document.activeElement.id : '',
  ring: getComputedStyle(document.getElementById('autoWolCheckboxBtn')).boxShadow,
}));

test('the dialog opens on Cancel, where OK closes it and leaves the automatic wake-up off, and the selected switch shows a ring', async () => {
  const app = await openWithOfflineHost();
  const { page } = app;
  try {
    await takeFocus(page);
    await page.evaluate(() => window.openWolDialog());
    // Past the 100 ms after which enter() of the view focuses its selection again, and the 300 ms in which the dialog
    // takes OK for the second press of the one that opened it (navigation.js)
    await page.waitForTimeout(350);
    assert.deepEqual(await wolSelection(page), { current: 'cancelAutoWol', marked: ['cancelAutoWol'], focused: 'cancelAutoWol', ring: 'none' });
    // OK right away closes the dialog, and the automatic wake-up of the PC stays off
    await remoteKey(page, ...OK);
    let state = await dialogState(page);
    assert.deepEqual([state.open, state.overlay, state.isDialogOpen], [false, 'none', false]);
    assert.deepEqual(await page.evaluate(() => [window.__host.autoWolEnabled === true, document.getElementById('autoWolCheckboxSwitch').checked]), [false, false]);
    assert.equal((await events(page)).filter((event) => event === 'cancel').length, 1);

    // The dialog again: UP selects the switch, whose row shows a white ring, and OK turns it on
    await page.evaluate(() => window.openWolDialog());
    await page.waitForTimeout(250);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(100);
    const selected = await wolSelection(page);
    assert.deepEqual([selected.current, selected.marked], ['autoWolCheckboxBtn', ['autoWolCheckboxBtn']]);
    assert.match(selected.ring, /^rgb\(255, 255, 255\) 0px 0px 0px 3px inset$/);
    // UP once more stays on the switch
    await page.keyboard.press('ArrowUp');
    assert.equal((await wolSelection(page)).current, 'autoWolCheckboxBtn');
    await remoteKey(page, ...OK);
    await page.waitForFunction(() => window.__host.autoWolEnabled === true, null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.getElementById('autoWolCheckboxSwitch').checked), true);
    assert.equal((await dialogState(page)).open, true);
    // DOWN back to Cancel, the ring goes, and OK closes the dialog with the switch as it was set
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    assert.deepEqual(await wolSelection(page), { current: 'cancelAutoWol', marked: ['cancelAutoWol'], focused: 'cancelAutoWol', ring: 'none' });
    await remoteKey(page, ...OK);
    state = await dialogState(page);
    assert.deepEqual([state.open, state.isDialogOpen], [false, false]);
    assert.equal(await page.evaluate(() => window.__host.autoWolEnabled), true);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
