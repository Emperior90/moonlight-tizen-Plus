'use strict';

// Checks the result of a pairing in the pairing dialog (pairingDialog() of wasm/platform/index.js): a wrong PIN, which
// gs_pair() of libgamestream/pairing.c reports as GS_PIN_WRONG (-7) once the host answered with a hash that doesn't
// match the PIN (native/pairing_test.c), is shown as such, any other failure keeps the general message, and the log
// names the host without the PIN. The button reads Cancel, then Close after a failure, in the language of the app. The
// pairing itself is answered by the test through the pair() of the host. A PC that runs an app is paired as well
// (since 2.3.3: the dialog refused it before any request), and a failure names the running app, but a wrong PIN as
// such first. A pairing that the PC doesn't confirm (NvHTTP.pair() of utils.js with the simulated Sunshine of
// mocks/sunshine-host.js) is a failure, which was announced as a success up to 2.3.2.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, openApp, startHarness } = require('./harness');
const { openMenus } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Open the pairing dialog for an unpaired host whose pair() waits until the test settles it with window.__settlePair,
// running the app currentGame (0 for none)
async function openPairingDialog(app, currentGame) {
  await app.page.evaluate((game) => {
    pairingCert = pairingCert || { cert: 'cert', privateKey: 'key' };
    window.__pairingResult = null;
    window.__settlePair = null;
    pairingDialog({ hostname: 'OFFICE', online: true, paired: false, currentGame: game, toString: () => 'OFFICE',
      pollServer(callback) {
        callback(this);
      },
      pair(pin) {
        window.__pin = pin;
        return new Promise((resolve, reject) => {
          window.__settlePair = (error) => (error === undefined ? resolve(true) : reject(error));
        });
      } }, () => {
      window.__pairingResult = 'success';
    }, () => {
      window.__pairingResult = 'failure';
    });
  }, currentGame || 0);
  await app.page.waitForFunction(() => typeof window.__settlePair === 'function', null, { timeout: 3000 });
}

async function failPairing(app, error) {
  await app.page.evaluate((reason) => window.__settlePair(reason), error);
  await app.page.waitForFunction(() => window.__pairingResult === 'failure');
  return app.page.evaluate(() => ({
    text: document.getElementById('pairingDialogText').textContent,
    button: document.getElementById('cancelPairing').textContent.trim(),
  }));
}

test('a wrong PIN is reported as such, and the log names the host without the PIN', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await openPairingDialog(app);
    const pin = await app.page.evaluate(() => window.__pin);
    assert.match(pin, /^\d{4}$/);
    const dialog = await failPairing(app, '-7');
    assert.equal(dialog.text, 'Error: The PIN entered on OFFICE was wrong.Please, try pairing with the PC again and enter the new PIN.');
    assert.equal(dialog.button, 'Close');
    assert.ok(app.logs.some((line) => line.indexOf('Sending pairing request to OFFICE') >= 0));
    assert.deepEqual(app.logs.filter((line) => line.indexOf('Sending pairing request') >= 0 && line.indexOf(pin) >= 0), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('another pairing failure keeps the general message', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await openPairingDialog(app);
    const dialog = await failPairing(app, '-1');
    assert.equal(dialog.text, 'Error: Failed to pair with OFFICE.Please, try pairing with the PC again.');
    assert.equal(dialog.button, 'Close');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// Pair with the simulated Sunshine PC through the real NvHTTP.pair(), after a poll like pairingDialog() does it: the
// module's pair() (gs_pair() of libgamestream/pairing.c, which native/pairing_test.c runs) answers with a pinned
// certificate, and the pairchallenge request that follows is answered as paired. Returns the arguments of pair() and
// the URLs of the /pair requests.
async function pairWithSunshine(app) {
  return app.page.evaluate(() => {
    const calls = { pair: [], urls: [] };
    Module.pair = function(id) {
      calls.pair.push(Array.prototype.slice.call(arguments, 1));
      setTimeout(() => handlePromiseMessage(id, 'resolve', 'sha256//PINNED'), 0);
    };
    const openUrl = Module.openUrl;
    Module.openUrl = function(id, url) {
      if (url.indexOf('/pair?') < 0) {
        return openUrl.apply(this, arguments);
      }
      calls.urls.push(url);
      setTimeout(() => handlePromiseMessage(id, 'resolve', '<root status_code="200"><paired>1</paired></root>'), 0);
    };
    const host = new NvHTTP('10.0.0.2', 'CLIENT-UID', '10.0.0.2');
    host.httpPort = 47989;
    return new Promise((resolve) => host.pollServer(resolve)).then(() => host.pair('1234'))
      .then((paired) => Object.assign(calls, { paired: paired }));
  });
}

test('the pairing requests name the TV by the model that System information shows', async () => {
  for (const tv of ['fhd', 's90c']) {
    const app = await openApp(harness, { tv: { tv, conn: 'wifi' }, moduleScripts: ['sunshine-host.js'] });
    try {
      const model = await app.page.evaluate(() => tvCapabilities.modelName);
      assert.equal(model, tv === 'fhd' ? 'UE43T5300AU' : 'QE55S90CAT');
      const name = 'Moonlight%20Plus%20%28' + model + '%29';
      const calls = await pairWithSunshine(app);
      assert.equal(calls.paired, true);
      // version, address, HTTP port, PIN, unique ID, device name: the arguments of pair() in wasm/main.cpp
      assert.deepEqual(calls.pair, [['7', '10.0.0.2', 47989, '1234', 'CLIENT-UID', name]]);
      assert.deepEqual(calls.urls, ['https://10.0.0.2:47984/pair?uniqueid=CLIENT-UID&devicename=' + name + '&updateState=1&phrase=pairchallenge']);
      assert.ok(app.logs.some((line) => line.indexOf('Pairing with GAMING-PC as \'Moonlight Plus (' + model + ')\'.') >= 0));
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('a TV whose model is unknown pairs as roth, as before', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', failApis: 'webapis.productinfo.getRealModel' },
    moduleScripts: ['sunshine-host.js'] });
  try {
    assert.equal(await app.page.evaluate(() => tvCapabilities.modelName), null);
    const calls = await pairWithSunshine(app);
    assert.equal(calls.pair[0][5], 'roth');
    assert.match(calls.urls[0], /&devicename=roth&updateState=1&phrase=pairchallenge$/);
  } finally {
    await app.context.close();
  }
});

test('the button reads Cancel and then Close in the language of the app, also after a translation pass', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { languagePreference: 'de-DE' } });
  const button = () => app.page.evaluate(() => document.getElementById('cancelPairing').textContent.trim());
  try {
    await openPairingDialog(app);
    assert.equal(await button(), 'Abbrechen');
    const dialog = await failPairing(app, '-7');
    assert.equal(dialog.button, 'Schließen');
    assert.match(dialog.text, /^Fehler: Die auf OFFICE eingegebene PIN war falsch\./);
    // A translation pass while the dialog shows its result keeps Close
    await app.page.evaluate(() => i18n.refreshUI());
    assert.equal(await button(), 'Schließen');
    // The next pairing starts with Cancel again
    await app.page.evaluate(() => document.getElementById('cancelPairing').click());
    await openPairingDialog(app);
    assert.equal(await button(), 'Abbrechen');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC that runs an app opens the pairing dialog and pairs', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    // Up to 2.3.2 no dialog opened: a message asked to quit the app first, which a TV that isn't paired can't do
    await openPairingDialog(app, 101);
    assert.match(await app.page.evaluate(() => window.__pin), /^\d{4}$/);
    await app.page.evaluate(() => window.__settlePair());
    await app.page.waitForFunction(() => window.__pairingResult === 'success', null, { timeout: 3000 });
    assert.equal(await app.page.evaluate(() => document.getElementById('pairingDialog').open), false);
    assert.equal(app.logs.filter((line) => /game session/.test(line)).length, 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a wrong PIN on a PC that runs an app is reported as a wrong PIN, another failure names the running app', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await openPairingDialog(app, 101);
    let dialog = await failPairing(app, '-7');
    assert.equal(dialog.text, 'Error: The PIN entered on OFFICE was wrong.Please, try pairing with the PC again and enter the new PIN.');
    assert.equal(dialog.button, 'Close');
    await app.page.evaluate(() => document.getElementById('cancelPairing').click());
    await openPairingDialog(app, 101);
    dialog = await failPairing(app, '-1');
    assert.equal(dialog.text, 'Error: OFFICE is currently busy!You must stop the running app in order to pair with the PC.');
    assert.equal(dialog.button, 'Close');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a pairing that the PC doesn\'t confirm is a failure: Close, no key, and the PC list stays', async () => {
  // GAMING-PC stored as not paired; the simulated Sunshine pairs, but answers the pairchallenge request with its 401
  // answer instead of <paired>1</paired>
  const app = await openMenus(harness, {
    moduleScripts: ['sunshine-host.js'],
    stored: { hosts: { HOST1: Object.assign({}, SUNSHINE_HOSTS.HOST1, { paired: false, ppkstr: null }) } },
    initScripts: ['window.__sunshineConfig = { unpaired: true, confirmPairing: false };'],
  });
  try {
    await app.page.waitForFunction(() => hosts.HOST1.online === true, null, { timeout: 5000 });
    await app.page.evaluate(() => $('#host-container-HOST1').trigger('click'));
    await app.page.waitForFunction(() => $('#cancelPairing').text().trim() === 'Close', null, { timeout: 5000 });
    await app.page.waitForTimeout(300);
    const state = await app.page.evaluate(() => ({
      text: document.getElementById('pairingDialogText').textContent,
      open: document.getElementById('pairingDialog').open,
      view: window.__view,
      dataView: document.body.getAttribute('data-view'),
      snackbars: window.__snackbars.slice(),
      key: hosts.HOST1.ppkstr,
      paired: hosts.HOST1.paired,
      pairs: window.__sunshine.pairs.length,
      challenges: window.__sunshine.requests.filter((request) => request.path === '/pair').length,
    }));
    assert.equal(state.text, 'Error: Failed to pair with GAMING-PC.Please, try pairing with the PC again.');
    assert.deepEqual([state.open, state.view, state.dataView], [true, 'PairingDialog', 'hosts']);
    assert.deepEqual(state.snackbars, ['Failed to pair with GAMING-PC']);
    assert.deepEqual([state.key, state.paired, state.pairs, state.challenges], [null, false, 1, 1]);
    assert.ok(app.logs.some((line) => /\[utils\.js, pair\].*Warning: GAMING-PC didn't confirm the pairing\./.test(line)));
    // Close: back on the PC list, where the PC is still not paired
    await app.page.evaluate(() => document.getElementById('cancelPairing').click());
    await app.page.waitForTimeout(300);
    assert.deepEqual(await app.page.evaluate(() => [window.__view, document.body.getAttribute('data-view'),
      document.getElementById('host-container-HOST1').getAttribute('data-state')]), ['Hosts', 'hosts', 'locked']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
