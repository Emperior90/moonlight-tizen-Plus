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
// - a callback of a poll that throws neither keeps the other callbacks from the result nor keeps later polls from
//   starting.
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
// the scan of the network that the dialog runs before each poll is window.__scan (a pending promise) or none.
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
    assert.deepEqual(await events(app.page), ['wol', 'cancel'], 'one request, no poll after the failure');
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
    // Past the 100 ms after which enter() of the view focuses its selection again
    await app.page.waitForTimeout(250);
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'cancelAutoWol');
    assert.equal(await app.page.evaluate(() => elementId(Views.AutoWolDialog.view.current())), 'cancelAutoWol');
    await remoteKey(app.page, ...OK);
    const state = await dialogState(app.page);
    assert.deepEqual([state.open, state.overlay, state.isDialogOpen], [false, 'none', false]);
    assert.equal(await app.page.evaluate(() => document.querySelector('#autoWolCheckboxSwitch').checked), autoWolBefore,
      'OK did not switch Auto-WOL');
    assert.deepEqual(await events(app.page), ['wol', 'cancel']);
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
    assert.deepEqual(await events(app.page), ['wol', 'cancel']);
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
    // The dialog polls again 1 second after its first poll ended, which reaches the PC; the background polling would
    // only poll again after 5 seconds
    await app.page.waitForFunction(() => window.__events.indexOf('success') >= 0, null, { timeout: 3000 }).catch(() => {});
    const state = await dialogState(app.page);
    const recorded = await events(app.page);
    assert.deepEqual([state.open, state.isDialogOpen], [false, false], 'the dialog closed: ' + JSON.stringify(recorded));
    // The first poll of the dialog, which the background polling joined after its refresh at the end of the scan,
    // and the next poll of the dialog, which reached the PC
    assert.deepEqual(recorded, ['poll', 'refresh failed', 'poll', 'success']);
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
    assert.deepEqual(await events(app.page), ['wol', 'refresh ok', 'success'], 'the dialog itself never polled');
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
    assert.deepEqual((await events(app.page)).filter((entry) => entry !== 'wol'), ['cancel']);
    assert.deepEqual(app.errors, []);
  } finally {
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
