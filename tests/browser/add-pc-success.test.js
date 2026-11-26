'use strict';

// Checks adding and pairing a PC that succeed (addHostDialog(), pairingDialog() and hostChosen() of
// wasm/platform/index.js, NvHTTP.pair() of wasm/static/js/utils.js), which the other tests only reach with a pairing
// that fails or is cancelled. The PC is the simulated Sunshine of mocks/sunshine-host.js as a PC that doesn't know the
// TV yet ({ unpaired: true }): its server info over HTTP says PairStatus 0, its HTTPS answers are the 401 answer of
// Sunshine until the pairing, and the pairing (Module.pair) pins its key 'sha256//SUNSHINE'.
// - Add PC at 10.0.0.2 and the PIN: one card, stored as paired with the new key, the address field cleared, the
//   polling resumed over HTTPS with that key, and the same after the next start of the app,
// - the same for a PC stored as not paired: the pairing of that PC, no second card,
// - OK on the card of a PC that isn't paired: the PIN, then its app list,
// - a wrong PIN first: its message with Close, and the next attempt pairs, with one card,
// - a PC that runs an app pairs as well (since 2.3.3; the pairing dialog refused it before any request up to 2.3.2),
// - Add PC of a known PC that answers with another key than the pinned one says so and doesn't pair it (the user deletes
//   the PC first).

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, readStorage, reloadApp, startHarness, waitForStorage } = require('./harness');
const { key, openMenus, takeSnackbars } = require('./menu-driver');

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
const KEY = 'sha256//SUNSHINE';

// Runs before the scripts of the app, also after a reload: the PC doesn't know the TV, unless a test noted in the
// session storage of the tab that it paired (the simulated PC starts anew with every load of the page)
function unpairedSunshine() {
  window.__sunshineConfig = sessionStorage.getItem('test-sunshine-knows-tv') ? {} : { unpaired: true };
}

// Open the app with the text field for the address, the given hosts stored and the simulated Sunshine that doesn't
// know the TV, running the app currentGame (if any). The requests of the PC wait `delayMs`, so that the pairing dialog
// shows while the PC pairs.
async function openWithUnpairedSunshine(hosts, delayMs, currentGame) {
  const stored = { ipAddressFieldMode: false };
  if (hosts) {
    stored.hosts = hosts;
  }
  const initScripts = [unpairedSunshine];
  if (currentGame) {
    initScripts.push('window.__sunshineConfig.currentGame = ' + Number(currentGame) + ';');
  }
  const app = await openMenus(harness, { tv: TV, stored, moduleScripts: ['sunshine-host.js'], initScripts });
  await app.page.evaluate((delay) => {
    window.__sunshine.delayMs = delay;
  }, delayMs || 30);
  return app;
}

// Enter the address in the open Add PC dialog and press Continue
const enterAddressAndContinue = (page, address) => page.evaluate((text) => {
  $('#ipAddressTextInput').val(text);
  updateIpAddressInputValidationState();
  $('#continueAddHost').trigger('click');
}, address);

// What the app shows and stores of the PCs, and what it asked the simulated Sunshine
const pcState = (page) => page.evaluate(() => ({
  cards: Array.prototype.map.call(document.querySelectorAll('[id^="host-container-"]'), (element) => element.id),
  hosts: Object.keys(hosts).map((uid) => ({ uid, name: hosts[uid].hostname, paired: hosts[uid].paired, key: hosts[uid].ppkstr })),
  pairingOpen: document.getElementById('pairingDialog').open,
  addOpen: document.getElementById('addHostDialog').open,
  address: $('#ipAddressTextInput').val(),
  pairs: window.__sunshine.pairs.slice(),
  requests: window.__sunshine.requests.slice(),
  view: document.body.getAttribute('data-view'),
}));

const waitForPairingDialog = (page) => page.waitForFunction(() => document.getElementById('pairingDialog').open &&
  window.__sunshine.pairs.length > 0, null, { timeout: 5000 });

test('Add PC and the PIN pair a new PC: one card, stored with its key, the polling resumed over HTTPS, and the same after a restart', async () => {
  const app = await openWithUnpairedSunshine(null, 300);
  const { page } = app;
  try {
    // Add PC with the remote: OK on its card, the address, DOWN to Continue, OK
    await key(page, 'ok', 500);
    await page.evaluate(() => {
      $('#ipAddressTextInput').val('10.0.0.2');
      updateIpAddressInputValidationState();
    });
    await key(page, 'down', 150);
    await takeSnackbars(page);
    await key(page, 'ok', 100);

    // The pairing dialog shows the PIN that the pairing request carries
    await waitForPairingDialog(page);
    const dialog = await page.evaluate(() => ({ pin: $('#pairingDialogText b').text(), button: $('#cancelPairing').text().trim() }));
    let state = await pcState(page);
    assert.match(dialog.pin, /^\d{4}$/);
    assert.equal(dialog.button, 'Cancel');
    assert.equal(state.pairs.length, 1);
    assert.equal(state.pairs[0].pin, dialog.pin);
    assert.equal(state.pairs[0].address, '10.0.0.2');
    assert.equal(state.addOpen, false);

    // The PC pairs: the dialog closes, one card, paired with the key of the pairing, and the address field is empty
    await page.waitForFunction(() => !document.getElementById('pairingDialog').open && 'HOST1' in hosts, null, { timeout: 5000 });
    state = await pcState(page);
    assert.deepEqual(state.cards, ['host-container-HOST1']);
    assert.deepEqual(state.hosts, [{ uid: 'HOST1', name: 'GAMING-PC', paired: true, key: KEY }]);
    assert.equal(state.address, '');
    const snackbars = await takeSnackbars(page);
    assert.ok(snackbars.indexOf('Connecting to GAMING-PC...') >= 0, JSON.stringify(snackbars));
    assert.ok(snackbars.indexOf('Successfully paired with GAMING-PC') >= 0, JSON.stringify(snackbars));
    assert.deepEqual(snackbars.filter((message) => /Failed|Error/.test(message)), []);
    const stored = await readStorage(page);
    assert.deepEqual(Object.keys(stored.hosts), ['HOST1']);
    assert.equal(stored.hosts.HOST1.paired, true);
    assert.equal(stored.hosts.HOST1.ppkstr, KEY);

    // The polling runs again, over HTTPS with the new key
    await page.waitForFunction((pinned) => 'HOST1' in activePolls && window.__sunshine.requests.some((request, index) =>
      index > 0 && request.scheme === 'https' && request.path === '/serverinfo' && request.key === pinned), KEY, { timeout: 5000 });
    await page.waitForFunction(() => hosts.HOST1.online === true, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.getElementById('host-container-HOST1').getAttribute('data-state')), 'online');
    // Its MAC address, which Sunshine sends only over HTTPS (00:00:00:00:00:00 over HTTP), for Wake-on-LAN: from the first
    // check over HTTPS, and stored once the first poll found it (updateMacAddress())
    await page.waitForFunction(() => hosts.HOST1.macAddress === '00:11:22:33:44:55', null, { timeout: 5000 });
    await waitForStorage(page, (values) => values.hosts && values.hosts.HOST1 && values.hosts.HOST1.macAddress === '00:11:22:33:44:55', 8000);
    assert.deepEqual(app.errors, []);

    // The next start of the app has the PC, paired and online
    await page.evaluate(() => sessionStorage.setItem('test-sunshine-knows-tv', '1'));
    await reloadApp(app);
    await page.waitForFunction(() => hosts.HOST1 && hosts.HOST1.online === true, null, { timeout: 5000 });
    await page.waitForTimeout(100);
    state = await pcState(page);
    assert.deepEqual(state.cards, ['host-container-HOST1']);
    assert.deepEqual(state.hosts, [{ uid: 'HOST1', name: 'GAMING-PC', paired: true, key: KEY }]);
    assert.equal(await page.evaluate(() => document.getElementById('host-container-HOST1').getAttribute('data-state')), 'online');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Add PC of a PC that is stored as not paired pairs that PC, without a second card', async () => {
  const app = await openWithUnpairedSunshine({ HOST1: Object.assign({}, SUNSHINE_HOSTS.HOST1, { paired: false, ppkstr: null }) });
  const { page } = app;
  try {
    await page.waitForFunction(() => hosts.HOST1.online === true && !hosts.HOST1.paired, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.getElementById('host-container-HOST1').getAttribute('data-state')), 'locked');
    await page.evaluate(() => $('#addHostContainer').trigger('click'));
    await page.waitForTimeout(300);
    await takeSnackbars(page);
    await enterAddressAndContinue(page, '10.0.0.2');
    await page.waitForFunction(() => window.__sunshine.pairs.length === 1 && !document.getElementById('pairingDialog').open &&
      hosts.HOST1.paired === true, null, { timeout: 5000 });
    const state = await pcState(page);
    assert.deepEqual(state.cards, ['host-container-HOST1']);
    assert.deepEqual(state.hosts, [{ uid: 'HOST1', name: 'GAMING-PC', paired: true, key: KEY }]);
    assert.equal(state.address, '');
    const snackbars = await takeSnackbars(page);
    assert.ok(snackbars.indexOf('Successfully paired with GAMING-PC') >= 0, JSON.stringify(snackbars));
    const stored = await readStorage(page);
    assert.deepEqual(Object.keys(stored.hosts), ['HOST1']);
    assert.equal(stored.hosts.HOST1.ppkstr, KEY);
    await page.waitForFunction(() => hosts.HOST1.online === true &&
      document.getElementById('host-container-HOST1').getAttribute('data-state') === 'online', null, { timeout: 5000 });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK on the card of a PC that isn\'t paired asks for the PIN and then opens its apps', async () => {
  const app = await openWithUnpairedSunshine({ HOST1: Object.assign({}, SUNSHINE_HOSTS.HOST1, { paired: false, ppkstr: null }) }, 200);
  const { page } = app;
  try {
    await page.waitForFunction(() => hosts.HOST1.online === true && !hosts.HOST1.paired, null, { timeout: 5000 });
    await takeSnackbars(page);
    await page.evaluate(() => $('#host-container-HOST1').trigger('click'));
    await waitForPairingDialog(page);
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && document.getElementById('game-container-105'),
      null, { timeout: 8000 });
    const state = await pcState(page);
    assert.equal(state.pairingOpen, false);
    assert.deepEqual(state.hosts, [{ uid: 'HOST1', name: 'GAMING-PC', paired: true, key: KEY }]);
    assert.deepEqual(await page.evaluate(() => [101, 102, 103, 104, 105].map((id) => !!document.getElementById('game-container-' + id))),
      [true, true, true, true, true]);
    assert.ok((await takeSnackbars(page)).indexOf('Successfully paired with GAMING-PC') >= 0);
    assert.equal((await readStorage(page)).hosts.HOST1.ppkstr, KEY);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a wrong PIN is reported with Close, and the next attempt of Add PC pairs, with one card', async () => {
  const app = await openWithUnpairedSunshine();
  const { page } = app;
  try {
    await page.evaluate(() => {
      window.__sunshine.pairError = '-7';
    });
    await page.evaluate(() => $('#addHostContainer').trigger('click'));
    await page.waitForTimeout(300);
    await enterAddressAndContinue(page, '10.0.0.2');
    await page.waitForFunction(() => $('#cancelPairing').text().trim() === 'Close', null, { timeout: 5000 });
    const dialog = await page.evaluate(() => document.getElementById('pairingDialogText').textContent);
    assert.equal(dialog, 'Error: The PIN entered on GAMING-PC was wrong.Please try pairing with the PC again and enter the new PIN.');
    let state = await pcState(page);
    assert.deepEqual(state.cards, []);
    assert.equal(state.pairingOpen, true);

    // Close, and Add PC again: the address is still there, and this time the PIN is right
    await page.evaluate(() => $('#cancelPairing').trigger('click'));
    await page.waitForTimeout(300);
    await page.evaluate(() => $('#addHostContainer').trigger('click'));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => $('#ipAddressTextInput').val()), '10.0.0.2');
    await takeSnackbars(page);
    await page.evaluate(() => $('#continueAddHost').trigger('click'));
    await page.waitForFunction(() => window.__sunshine.pairs.length === 2 && 'HOST1' in hosts && hosts.HOST1.paired === true &&
      !document.getElementById('pairingDialog').open, null, { timeout: 5000 });
    state = await pcState(page);
    assert.deepEqual(state.cards, ['host-container-HOST1']);
    assert.deepEqual(state.hosts, [{ uid: 'HOST1', name: 'GAMING-PC', paired: true, key: KEY }]);
    assert.notEqual(state.pairs[0].pin, undefined);
    assert.ok((await takeSnackbars(page)).indexOf('Successfully paired with GAMING-PC') >= 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Add PC pairs a PC that runs an app, whose card then shows the app running', async () => {
  // The simulated PC runs Cyberpunk 2077, which it tells every client, also over HTTP before the pairing
  const app = await openWithUnpairedSunshine(null, 30, 101);
  const { page } = app;
  try {
    await page.evaluate(() => $('#addHostContainer').trigger('click'));
    await page.waitForTimeout(300);
    await enterAddressAndContinue(page, '10.0.0.2');
    await page.waitForFunction(() => window.__sunshine.pairs.length === 1 && 'HOST1' in hosts && hosts.HOST1.paired === true &&
      !document.getElementById('pairingDialog').open, null, { timeout: 5000 });
    const state = await pcState(page);
    assert.deepEqual(state.cards, ['host-container-HOST1']);
    assert.deepEqual(state.hosts, [{ uid: 'HOST1', name: 'GAMING-PC', paired: true, key: KEY }]);
    const snackbars = await takeSnackbars(page);
    assert.ok(snackbars.indexOf('Successfully paired with GAMING-PC') >= 0, JSON.stringify(snackbars));
    assert.deepEqual(snackbars.filter((message) => /game session|busy/.test(message)), []);
    // Its card shows the running app once its polling resumed over HTTPS
    await page.waitForFunction(() => document.getElementById('host-container-HOST1').getAttribute('data-state') === 'running', null, { timeout: 5000 });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Add PC of a known PC that answers with another key says so, and neither pairs it nor adds a card', async () => {
  // Sunshine set up anew: another key than the one pinned at the pairing of the stored PC
  const app = await openMenus(harness, { tv: TV, stored: { ipAddressFieldMode: false, hosts: SUNSHINE_HOSTS }, moduleScripts: ['sunshine-host.js'],
    initScripts: ['window.__sunshineConfig = { key: "sha256//NEW" };'] });
  const { page } = app;
  try {
    await page.waitForFunction(() => hosts.HOST1.online === false && hosts.HOST1.pinnedKeyMismatch === true, null, { timeout: 5000 });
    await page.evaluate(() => $('#addHostContainer').trigger('click'));
    await page.waitForTimeout(300);
    await takeSnackbars(page);
    await enterAddressAndContinue(page, '10.0.0.2');
    await page.waitForFunction(() => window.__snackbars.some((message) => message.indexOf('answers with a different key') >= 0), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    const state = await pcState(page);
    const snackbars = await takeSnackbars(page);
    assert.equal(snackbars[snackbars.length - 1], 'GAMING-PC answers with a different key than at its pairing: another PC may have its address now, or Sunshine ' +
      'was set up anew on it. If the PC is asleep, wake it from its options. Otherwise try "Rescan network", and if that doesn\'t help, delete the PC and add it again.');
    assert.deepEqual(snackbars.filter((message) => /Failed|paired/.test(message)), []);
    assert.deepEqual([state.pairingOpen, state.pairs.length, await page.evaluate(() => window.__wasmCalls.filter((call) => call.name === 'pair').length)], [false, 0, 0]);
    assert.deepEqual(state.cards, ['host-container-HOST1']);
    assert.deepEqual(state.hosts, [{ uid: 'HOST1', name: 'GAMING-PC', paired: true, key: 'PPK' }]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
