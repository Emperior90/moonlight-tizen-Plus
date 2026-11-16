'use strict';

// Checks the result of a pairing in the pairing dialog (pairingDialog() of wasm/platform/index.js): a wrong PIN, which
// gs_pair() of libgamestream/pairing.c reports as GS_PIN_WRONG (-7) once the host answered with a hash that doesn't
// match the PIN (native/pairing_test.c), is shown as such, any other failure keeps the general message, and the log
// names the host without the PIN. The button reads Cancel, then Close after a failure, in the language of the app. The
// pairing itself is answered by the test through the pair() of the host.

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

// Open the pairing dialog for an unpaired host whose pair() waits until the test settles it with window.__settlePair
async function openPairingDialog(app) {
  await app.page.evaluate(() => {
    pairingCert = pairingCert || { cert: 'cert', privateKey: 'key' };
    window.__pairingResult = null;
    pairingDialog({ hostname: 'OFFICE', online: true, paired: false, currentGame: 0, toString: () => 'OFFICE',
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
  });
  await app.page.waitForFunction(() => typeof window.__settlePair === 'function');
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
