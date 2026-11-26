'use strict';

// Checks the state of a stored PC at the start of the app (loadHTTPCertsCb(), hostChosen(), whenHostStatusKnown() and
// the deep links of wasm/platform/index.js). The hosts are stored as the NvHTTP objects of the last session, with
// `online` and `currentGame`, and up to 2.3.0 the app started with them: a PC that is off now showed ONLINE (or Running,
// with the app it ran then), and a quick OK or a Smart Hub tile asked it for its app list and waited for that request
// to fail instead of offering Wake PC; a PC that was off then but is on now showed OFFLINE, and OK offered Wake PC. Now
// a stored PC is unknown (no state on its card) until the first poll of this start ends, and OK and the deep links wait
// for that poll and then go on as for an online or an offline PC:
// - a PC stored online that is off now: unknown, then offline; OK during the wait opens the Wake PC dialog (Auto WoL)
//   or says that it can't connect, without a request for the app list; its menu offers Wake PC meanwhile,
// - a choice that waits is dropped once the user left the PC list or deleted the PC, and only the latest of two choices
//   goes on,
// - a PC stored offline that is on now: unknown, then online; OK during the wait opens its apps, no Wake PC,
// - the Running state of the last session doesn't show, and the PC details say that the state is unknown,
// - OK on an unknown host whose poll doesn't run starts that poll,
// - a host that 2.3.0 stored while one of its polls ran (the callbacks of the poll as null) is polled again,
// - a Smart Hub deep link to an app waits the same way: Wake PC for the PC that is off, the stream for the one that
//   is on,
// - a paired PC that answers with its pinned key that it no longer accepts the TV (Sunshine's 401 answer) shows
//   Unpaired, and OK pairs it again over plain HTTP, which keeps its MAC address; one that accepts the TV again shows
//   Online without a pairing; a device that answers with another key leaves the PC offline with a message of its own
//   and never pairs it, while OK still opens Wake PC with Auto WoL (since 2.3.3); another PC that answers at the
//   public address of the household (NAT loopback) doesn't count as such a device.
// The PC is the simulated Sunshine of mocks/sunshine-host.js, which holds its answers until the test releases them.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, openApp, startHarness, waitForStorage } = require('./harness');

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

// Runs before the scripts of the app: every state that the card of HOST1 gets (launcher.js sets data-state), and the
// snackbar messages once the app started (watchSnackbar())
function recordCardStates() {
  window.__states = [];
  new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.target.id === 'host-container-HOST1') {
        const state = record.target.getAttribute('data-state');
        if (window.__states[window.__states.length - 1] !== state) {
          window.__states.push(state);
        }
      }
    });
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
}

// Open the app with HOST1 stored with the given fields, on a simulated Sunshine with the given configuration
async function openWithStoredPc(fields, sunshineConfig) {
  const hosts = { HOST1: Object.assign({}, SUNSHINE_HOSTS.HOST1, fields) };
  const app = await openApp(harness, {
    tv: TV, moduleScripts: ['sunshine-host.js'], stored: { hosts },
    initScripts: [recordCardStates, 'window.__sunshineConfig = ' + JSON.stringify(sunshineConfig || {}) + ';'],
  });
  await app.page.evaluate(() => {
    window.__snackbars = [];
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    const show = snackbar.showSnackbar.bind(snackbar);
    snackbar.showSnackbar = (data) => {
      window.__snackbars.push(data.message);
      show(data);
    };
  });
  return app;
}

// What the app shows of HOST1 and what it asked the PC
const pcState = (page) => page.evaluate(() => ({
  online: hosts.HOST1.online,
  card: document.getElementById('host-container-HOST1').getAttribute('data-state'),
  chips: $('#host-container-HOST1 .host-chips').text(),
  states: window.__states.slice(),
  requests: window.__sunshine.http.slice(),
  wolDialog: document.getElementById('autoWolDialog').open,
  wakeRequests: window.__wasmCalls.filter((call) => call.name === 'wakeOnLan').length,
  view: document.body.getAttribute('data-view'),
  snackbars: window.__snackbars.slice(),
}));

// OK on the card of HOST1, as the remote gives it
const chooseHost = (page) => page.evaluate(() => $('#host-container-HOST1').trigger('click'));

test('a PC stored as online that is off now is unknown until its first poll fails, and OK then opens Wake PC without asking for the app list', async () => {
  const app = await openWithStoredPc({ online: true, autoWolEnabled: true }, { offline: true, hold: true });
  try {
    let state = await pcState(app.page);
    assert.equal(state.online, null);
    assert.equal(state.card, 'unknown');
    assert.equal(state.chips, '');
    assert.deepEqual(state.states, ['unknown']);

    // A quick OK waits for the first poll: no dialog, no request for the app list, still the hosts
    await chooseHost(app.page);
    await app.page.waitForTimeout(300);
    state = await pcState(app.page);
    assert.equal(state.wolDialog, false);
    assert.deepEqual(state.requests, ['/serverinfo'], 'only the first poll so far');
    assert.equal(state.view, 'hosts');
    assert.ok(app.logs.some((line) => line.indexOf('Waiting for the first answer of GAMING-PC before opening it.') >= 0));

    // The poll fails: offline, and the choice goes on as for an offline PC with Auto WoL, at once
    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForFunction(() => document.getElementById('autoWolDialog').open, null, { timeout: 3000 });
    state = await pcState(app.page);
    assert.equal(state.online, false);
    assert.equal(state.card, 'offline');
    assert.deepEqual(state.states, ['unknown', 'offline']);
    assert.ok(state.wakeRequests >= 1, 'the dialog sent the Wake-on-LAN request');
    assert.equal(state.requests.indexOf('/applist'), -1, 'no request for the app list: ' + JSON.stringify(state.requests));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a choice that waits for the first poll is dropped once the user left the hosts, and a later choice takes its place', async () => {
  const app = await openWithStoredPc({ online: true, autoWolEnabled: true }, { offline: true, hold: true });
  try {
    // OK, and then the settings before the PC answered: nothing opens over the settings
    await chooseHost(app.page);
    await app.page.evaluate(() => $('#settingsBtn').trigger('click'));
    await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'settings', null, { timeout: 3000 });
    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForFunction(() => hosts.HOST1.online === false, null, { timeout: 3000 });
    await app.page.waitForTimeout(300);
    let state = await pcState(app.page);
    assert.equal(state.wolDialog, false);
    assert.equal(state.view, 'settings');
    assert.deepEqual(state.snackbars.filter((message) => message.indexOf('Failed to connect') >= 0), []);

    // Back on the hosts, two choices while the states are unknown: only the later one goes on, also when the PC of the
    // earlier one answers first
    await app.page.evaluate(() => $('#goBackBtn').trigger('click'));
    await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'hosts' && $('#host-grid').is(':visible'), null, { timeout: 3000 });
    await app.page.evaluate(() => {
      window.__chosen = [];
      const realAutoWolDialog = autoWolDialog;
      autoWolDialog = function(host) {
        window.__chosen.push(host.hostname);
        return realAutoWolDialog.apply(this, arguments);
      };
      const other = Object.assign(new NvHTTP('10.0.0.9', 'client', '', ''), { serverUid: 'HOST2', hostname: 'OFFICE-PC', online: null, autoWolEnabled: true });
      hosts.HOST1.online = null;
      const answerAfter = (host, ms) => new Promise((resolve) => setTimeout(() => {
        host.online = false;
        resolve();
      }, ms));
      hostStatusChecks.HOST2 = answerAfter(other, 100);
      hostStatusChecks.HOST1 = answerAfter(hosts.HOST1, 300);
      hostChosen(other);
      hostChosen(hosts.HOST1);
    });
    await app.page.waitForFunction(() => document.getElementById('autoWolDialog').open, null, { timeout: 3000 });
    await app.page.waitForTimeout(200);
    assert.deepEqual(await app.page.evaluate(() => window.__chosen), ['GAMING-PC']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a choice that waits for the first poll is dropped when its PC is deleted meanwhile', async () => {
  const app = await openWithStoredPc({ online: true, autoWolEnabled: true }, { offline: true, hold: true });
  try {
    // OK, and then Delete PC from its menu before the PC answered: the confirmation has closed once the poll ends
    await chooseHost(app.page);
    await app.page.evaluate(() => {
      deleteHostDialog(hosts.HOST1);
      document.getElementById('continueDeleteHost').click();
    });
    await app.page.waitForFunction(() => !('HOST1' in hosts) && !isDialogOpen, null, { timeout: 3000 });
    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForTimeout(500);
    const state = await app.page.evaluate(() => ({
      wolDialog: document.getElementById('autoWolDialog').open,
      wakeRequests: window.__wasmCalls.filter((call) => call.name === 'wakeOnLan').length,
      requests: window.__sunshine.http.slice(),
      view: document.body.getAttribute('data-view'),
      snackbars: window.__snackbars.slice(),
    }));
    // Neither the Wake PC dialog nor "Failed to connect" for a PC that is no longer listed, and no app list
    assert.equal(state.wolDialog, false);
    assert.equal(state.wakeRequests, 0);
    assert.deepEqual(state.snackbars.filter((message) => message.indexOf('Failed to connect') >= 0), []);
    assert.equal(state.requests.indexOf('/applist'), -1, JSON.stringify(state.requests));
    assert.equal(state.view, 'hosts');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('without Auto WoL, OK on a PC that turned out to be off says that it can\'t connect, and its menu offered Wake PC meanwhile', async () => {
  const app = await openWithStoredPc({ online: true, autoWolEnabled: false }, { offline: true, hold: true });
  try {
    // The menu while the state is unknown: Wake PC (its dialog closes once the PC answers), no Refresh apps
    const entries = await app.page.evaluate(() => {
      hostMenuDialog(hosts.HOST1);
      const labels = $('#hostMenuDialog-HOST1 .overlay-menu-label').map(function() {
        return $(this).text();
      }).get();
      $('#closeHostMenu').trigger('click');
      return labels;
    });
    assert.deepEqual(entries, ['Wake PC', 'View Details', 'Delete PC', 'Close']);

    await chooseHost(app.page);
    await app.page.waitForTimeout(300);
    assert.deepEqual((await pcState(app.page)).snackbars, []);
    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 3000 });
    const state = await pcState(app.page);
    assert.equal(state.online, false);
    // The message names the PC, as every other one does (since 2.3.3)
    assert.deepEqual(state.snackbars, ['Failed to connect to GAMING-PC. Make sure that Sunshine (or another GameStream host) is running on the PC.']);
    assert.equal(state.wolDialog, false);
    assert.equal(state.requests.indexOf('/applist'), -1, 'no request for the app list: ' + JSON.stringify(state.requests));
    assert.equal(state.view, 'hosts');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC stored as offline that is on now is unknown until it answers, and OK then opens its apps instead of Wake PC', async () => {
  const app = await openWithStoredPc({ online: false, autoWolEnabled: true }, { hold: true });
  try {
    let state = await pcState(app.page);
    assert.equal(state.online, null);
    assert.equal(state.card, 'unknown');
    assert.deepEqual(state.states, ['unknown']);

    // Up to 2.3.0 this OK opened the Wake PC dialog at once, for a PC that is on
    await chooseHost(app.page);
    await app.page.waitForTimeout(300);
    state = await pcState(app.page);
    assert.equal(state.wolDialog, false);
    assert.equal(state.wakeRequests, 0);

    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForFunction(() => document.getElementById('game-container-101') && document.body.getAttribute('data-view') === 'apps', null, { timeout: 5000 });
    state = await pcState(app.page);
    assert.equal(state.online, true);
    assert.deepEqual(state.states, ['unknown', 'online']);
    assert.equal(state.wolDialog, false);
    assert.equal(state.wakeRequests, 0);
    assert.deepEqual(state.snackbars.filter((message) => message.indexOf('Failed to connect') >= 0), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Running state of the last session doesn\'t show, and the PC details say that the state is unknown until the PC answers', async () => {
  // The PC ran Forza Horizon 5 (104) when the hosts were saved, and runs nothing now
  const app = await openWithStoredPc({ online: true, currentGame: 104 }, { hold: true });
  try {
    let state = await pcState(app.page);
    assert.equal(state.card, 'unknown');
    assert.equal(state.chips, '');
    const details = await app.page.evaluate(() => {
      hostDetailsDialog(hosts.HOST1);
      const text = Array.prototype.map.call(document.querySelectorAll('#hostDetailsDialogText-HOST1 tr'),
        (row) => row.cells[0].textContent + ' ' + row.cells[1].textContent);
      $('#closeHostDetails').trigger('click');
      return text;
    });
    assert.ok(details.indexOf('State: Unknown') >= 0, JSON.stringify(details));
    // No game runs: a dash, as for every value that the PC didn't report (2.3.4: the ID 0)
    assert.ok(details.indexOf('Running Game ID: \u2014') >= 0, JSON.stringify(details));

    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForFunction(() => hosts.HOST1.online === true, null, { timeout: 3000 });
    await app.page.waitForTimeout(100);
    state = await pcState(app.page);
    assert.equal(state.card, 'online');
    assert.deepEqual(state.states, ['unknown', 'online'], 'never Running');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK on a host whose state is unknown without a poll that runs starts that poll and goes on with its answer', async () => {
  const app = await openWithStoredPc({ online: true });
  try {
    await app.page.waitForFunction(() => hosts.HOST1.online === true && isSubnetScanFinished, null, { timeout: 5000 });
    // No request decides the state of the host now (e.g. a later way of adding hosts that forgets to poll them)
    await app.page.evaluate(() => {
      stopPollingHosts();
      delete hostStatusChecks.HOST1;
      hosts.HOST1.online = null;
      window.__sunshine.http.length = 0;
    });
    await chooseHost(app.page);
    await app.page.waitForFunction(() => document.getElementById('game-container-101') && document.body.getAttribute('data-view') === 'apps', null, { timeout: 5000 });
    const state = await pcState(app.page);
    assert.equal(state.online, true);
    assert.equal(state.requests[0], '/serverinfo', 'the poll came first: ' + JSON.stringify(state.requests));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC that 2.3.0 stored while one of its polls ran loads, and its polls run again', async () => {
  // JSON.stringify() of the NvHTTP object in the middle of a poll: the callbacks of the poll became null, and the counts
  // of the polls of that session were stored with them. The MAC address differs from the one the PC sends now.
  const app = await openWithStoredPc({
    online: true, currentGame: 104, _pollCount: 7, _consecutivePollFailures: 1, _pollCompletionCallbacks: [null],
    macAddress: '00:11:22:33:44:00', numofapps: 5, appVersion: '7.1.431.-1', gfeVersion: '3.23.0.74', serverMajorVersion: 7,
    serverState: 'SUNSHINE_SERVER_BUSY', isNvidiaServerSoftware: false, gputype: '', supportedDisplayModes: {}, autoWolEnabled: false,
  });
  try {
    await app.page.waitForFunction(() => hosts.HOST1.online === true, null, { timeout: 5000 });
    // A poll ends (it waited forever for the stored one before), and as the first one of this start it stores the MAC
    // address that the PC sent
    const polled = await app.page.evaluate(() => Promise.race([
      new Promise((resolve) => hosts.HOST1.pollServer(() => resolve('done'))),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000)),
    ]));
    assert.equal(polled, 'done');
    const stored = await waitForStorage(app.page, (values) => values.hosts && values.hosts.HOST1 && values.hosts.HOST1.macAddress === '00:11:22:33:44:55');
    assert.equal(stored.hosts.HOST1.hostname, 'GAMING-PC');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a Smart Hub tile of a PC stored as online that is off now waits for the first poll and then opens Wake PC, without asking for the app list', async () => {
  const app = await openWithStoredPc({ online: true, autoWolEnabled: true }, { offline: true, hold: true });
  try {
    await app.page.evaluate(() => waitForHostAndNavigateToApp('HOST1', 101));
    // The deep link looks every second: it waits, since the PC hasn't answered
    await app.page.waitForTimeout(1300);
    let state = await pcState(app.page);
    assert.deepEqual(state.requests, ['/serverinfo']);
    assert.equal(state.wolDialog, false);

    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForFunction(() => document.getElementById('autoWolDialog').open, null, { timeout: 5000 });
    state = await pcState(app.page);
    assert.equal(state.online, false);
    assert.equal(state.requests.indexOf('/applist'), -1, 'no request for the app list: ' + JSON.stringify(state.requests));
    assert.equal(state.requests.indexOf('/launch 101'), -1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a Smart Hub tile of a PC stored as offline that is on now waits for the first poll and then starts the app', async () => {
  const app = await openWithStoredPc({ online: false, autoWolEnabled: true }, { hold: true });
  try {
    await app.page.evaluate(() => waitForHostAndNavigateToApp('HOST1', 101));
    await app.page.waitForTimeout(1300);
    let state = await pcState(app.page);
    assert.deepEqual(state.requests, ['/serverinfo']);
    assert.equal(state.wolDialog, false);

    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForFunction(() => window.__sunshine.starts.length === 1, null, { timeout: 8000 });
    state = await pcState(app.page);
    assert.ok(state.requests.indexOf('/launch 101') >= 0, JSON.stringify(state.requests));
    assert.equal(state.wolDialog, false);
    assert.equal(state.wakeRequests, 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a Smart Hub tile of a PC whose state is unknown after the scan at startup still waits for its poll and then starts the app', async () => {
  const app = await openWithStoredPc({ online: true });
  try {
    await app.page.waitForFunction(() => hosts.HOST1.online === true && isSubnetScanFinished, null, { timeout: 5000 });
    // The polls that the end of the scan started answer first
    await app.page.waitForTimeout(500);
    // The scan at startup is over, and the state of the PC is unknown again until a poll that the PC holds answers. The
    // deep link used to take that for offline once the scan was over, and then only opened the app list.
    await app.page.evaluate(() => {
      window.__sunshine.hold = true;
      hosts.HOST1.online = null;
      beginBackgroundPollingOfHost(hosts.HOST1);
      waitForHostAndNavigateToApp('HOST1', 101);
    });
    await app.page.waitForTimeout(1300);
    assert.equal(await app.page.evaluate(() => document.body.getAttribute('data-view')), 'hosts');
    await app.page.evaluate(() => window.__sunshine.release());
    await app.page.waitForFunction(() => window.__sunshine.starts.length === 1, null, { timeout: 8000 });
    assert.ok((await pcState(app.page)).requests.indexOf('/launch 101') >= 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

const K1 = 'GAMING-PC answers with a different key than at its pairing: another PC may have its address now, or Sunshine was set up anew on it. If the PC is asleep, wake it from its options. Otherwise try "Rescan network", and if that doesn\'t help, delete the PC and add it again.';
const K2 = 'This PC answers with a different key than at its pairing. Try "Rescan network", or delete the PC and add it again.';

// What the hero shows of the focused card: its text and its key hints
const heroOf = (page) => page.evaluate(() => ({
  text: document.getElementById('hero-text').textContent,
  hints: Array.prototype.map.call(document.querySelectorAll('#hero-hints .hint'), (hint) => hint.textContent),
}));

test('a paired PC that no longer accepts the TV shows Unpaired, and OK pairs it again with a new PIN, over plain HTTP', async () => {
  // Sunshine forgot the TV ("Unpair All"): it answers every HTTPS request with its 401 answer
  const app = await openWithStoredPc({ online: true }, { unpaired: true });
  try {
    await app.page.waitForFunction(() => hosts.HOST1.online === true, null, { timeout: 5000 });
    let state = await pcState(app.page);
    assert.equal(state.card, 'locked');
    assert.equal(state.chips, 'UNPAIRED');
    // Straight from unknown to Unpaired: the first check of the polling marks it (beginBackgroundPollingOfHost())
    assert.deepEqual(state.states, ['unknown', 'locked']);
    assert.deepEqual(await app.page.evaluate(() => [hosts.HOST1.paired, hosts.HOST1.ppkstr, hosts.HOST1.pinnedKeyMismatch]), [false, 'PPK', false]);
    const refusals = () => app.logs.filter((line) => line.indexOf('GAMING-PC answered with its pinned key that it no longer accepts this TV (status 401)') >= 0);
    assert.equal(refusals().length, 1);
    // The hero of the card: pair it
    await app.page.keyboard.press('ArrowRight');
    await app.page.waitForTimeout(200);
    assert.deepEqual(await heroOf(app.page), { text: 'Select it to pair this TV with the PC using a PIN.', hints: ['OKPair', 'Options'] });

    // OK: the pairing dialog, whose pairing starts over plain HTTP without the old key
    await app.page.evaluate(() => {
      window.__requestsAtDialog = -1;
      new MutationObserver(() => {
        if (document.getElementById('pairingDialog').open && window.__requestsAtDialog < 0) {
          window.__requestsAtDialog = window.__sunshine.requests.length;
        }
      }).observe(document.getElementById('pairingDialog'), { attributes: true, attributeFilter: ['open'] });
    });
    await chooseHost(app.page);
    await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && document.getElementById('game-container-101'),
      null, { timeout: 8000 });
    state = await pcState(app.page);
    assert.deepEqual(state.snackbars.filter((message) => /Failed|no longer accepts/.test(message)), []);
    assert.ok(state.snackbars.indexOf('Successfully paired with GAMING-PC') >= 0, JSON.stringify(state.snackbars));
    const pairing = await app.page.evaluate(() => ({ pairs: window.__sunshine.pairs.length, at: window.__requestsAtDialog,
      requests: window.__sunshine.requests.slice(), key: hosts.HOST1.ppkstr, paired: hosts.HOST1.paired }));
    assert.equal(pairing.pairs, 1);
    assert.deepEqual([pairing.key, pairing.paired], ['sha256//SUNSHINE', true]);
    assert.ok(pairing.at >= 0);
    const afterDialog = pairing.requests.slice(pairing.at);
    assert.deepEqual(afterDialog[0], { scheme: 'http', path: '/serverinfo', key: null });
    assert.deepEqual(afterDialog.filter((request) => request.key === 'PPK'), []);
    assert.ok(afterDialog.some((request) => request.scheme === 'https' && request.path === '/pair' && request.key === 'sha256//SUNSHINE'));
    const stored = await waitForStorage(app.page, (values) => values.hosts && values.hosts.HOST1 && values.hosts.HOST1.ppkstr === 'sha256//SUNSHINE');
    assert.equal(stored.hosts.HOST1.paired, true);
    // The answer over HTTP has the MAC address 00:00:00:00:00:00, which replaced the one of the PC up to 2.3.3 in testing
    assert.equal(stored.hosts.HOST1.macAddress, '00:11:22:33:44:55');
    assert.equal(refusals().length, 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC that answers with another key stays Offline with its own message; OK wakes it with Auto WoL, else says what to do, and never pairs it', async () => {
  // Sunshine set up anew, or another PC with its address while it sleeps: another key than the one pinned at the pairing
  // (GS_CERT_MISMATCH of the module)
  const app = await openWithStoredPc({ online: true, autoWolEnabled: true }, { key: 'sha256//NEW' });
  try {
    await app.page.waitForFunction(() => hosts.HOST1.online === false, null, { timeout: 5000 });
    let state = await pcState(app.page);
    assert.equal(state.card, 'offline');
    assert.equal(state.chips, 'OFFLINE');
    assert.deepEqual(await app.page.evaluate(() => [hosts.HOST1.paired, hosts.HOST1.ppkstr, hosts.HOST1.pinnedKeyMismatch]), [true, 'PPK', true]);
    // The hero says what it is, and OK wakes the PC (Auto WoL), as for any offline PC
    await app.page.keyboard.press('ArrowRight');
    await app.page.waitForTimeout(200);
    assert.deepEqual(await heroOf(app.page), { text: K2, hints: ['OKWake PC', 'Options'] });

    // OK: the Wake PC dialog, which finds the PC once it wakes, also at a new address (2.3.3 in testing showed K1 and
    // didn't wake it)
    await chooseHost(app.page);
    await app.page.waitForFunction(() => document.getElementById('autoWolDialog').open, null, { timeout: 3000 });
    state = await pcState(app.page);
    assert.ok(state.wakeRequests >= 1, 'the dialog sent the Wake-on-LAN request');
    assert.deepEqual(state.snackbars, []);
    await app.page.evaluate(() => $('#cancelAutoWol').trigger('click'));
    await app.page.waitForTimeout(200);

    // Without Auto WoL: the message that says what to do, no dialog, no Wake-on-LAN request, and the hero without the hint
    const wakeRequests = (await pcState(app.page)).wakeRequests;
    await app.page.evaluate(() => {
      hosts.HOST1.autoWolEnabled = false;
      isClickPrevented = false;
      Launcher.refresh();
    });
    await app.page.waitForTimeout(200);
    assert.deepEqual(await heroOf(app.page), { text: K2, hints: ['Options'] });
    await chooseHost(app.page);
    await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 3000 });
    await app.page.waitForTimeout(300);
    state = await pcState(app.page);
    assert.deepEqual(state.snackbars, [K1]);
    assert.equal(state.wolDialog, false);
    assert.equal(state.wakeRequests, wakeRequests);
    const pairing = await app.page.evaluate(() => ({ dialog: document.getElementById('pairingDialog').open, pairs: window.__sunshine.pairs.length,
      pairRequests: window.__sunshine.requests.filter((request) => request.path === '/pair').length,
      moduleCalls: window.__wasmCalls.filter((call) => call.name === 'pair').length }));
    assert.deepEqual(pairing, { dialog: false, pairs: 0, pairRequests: 0, moduleCalls: 0 });
    assert.equal(state.view, 'hosts');
    assert.ok(app.logs.some((line) => line.indexOf('Error: GAMING-PC answers with another key than the one pinned at its pairing.') >= 0));
    assert.deepEqual(await app.page.evaluate(() => [hosts.HOST1.paired, hosts.HOST1.ppkstr]), [true, 'PPK']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC that is off, whose public address another PC answers with its own key, shows as off, and OK wakes it', async () => {
  // The external address of a PC is the public address of the household (STUN), the same for every PC, which the router
  // hands to the PC that it forwards the port to (NAT loopback), here another PC with Sunshine and its own key
  const app = await openWithStoredPc({ online: true, autoWolEnabled: true, externalIP: '203.0.113.7' }, { offline: true, otherPcAt: ['203.0.113.7'] });
  try {
    await app.page.waitForFunction(() => hosts.HOST1.online === false && window.__sunshine.otherPcRequests >= 1, null, { timeout: 8000 });
    await app.page.waitForTimeout(300);
    assert.deepEqual(await app.page.evaluate(() => [hosts.HOST1.paired, hosts.HOST1.ppkstr, hosts.HOST1.pinnedKeyMismatch]), [true, 'PPK', false]);
    await app.page.keyboard.press('ArrowRight');
    await app.page.waitForTimeout(200);
    assert.deepEqual(await heroOf(app.page), { text: 'This PC is not reachable. Turn it on, or wake it from its options.', hints: ['OKWake PC', 'Options'] });
    await chooseHost(app.page);
    await app.page.waitForFunction(() => document.getElementById('autoWolDialog').open, null, { timeout: 3000 });
    const state = await pcState(app.page);
    assert.ok(state.wakeRequests >= 1, 'the dialog sent the Wake-on-LAN request');
    assert.deepEqual(state.snackbars, []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC that accepts the TV again shows Online at its next check, without a pairing', async () => {
  const app = await openWithStoredPc({ online: true }, { unpaired: true });
  try {
    await app.page.waitForFunction(() => hosts.HOST1.online === true && hosts.HOST1.paired === false, null, { timeout: 5000 });
    assert.equal((await pcState(app.page)).card, 'locked');
    // The TV turned on again in the list of clients of Sunshine
    await app.page.evaluate(() => {
      window.__sunshine.knowsTv = true;
    });
    await app.page.waitForFunction(() => hosts.HOST1.paired === true, null, { timeout: 8000 });
    const state = await pcState(app.page);
    assert.equal(state.card, 'online');
    assert.deepEqual(state.states, ['unknown', 'locked', 'online']);
    assert.deepEqual(await app.page.evaluate(() => [hosts.HOST1.ppkstr, window.__sunshine.pairs.length]), ['PPK', 0]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
