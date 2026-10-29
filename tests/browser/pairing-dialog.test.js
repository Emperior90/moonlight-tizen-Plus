'use strict';

// Checks the result of a pairing in the pairing dialog (pairingDialog() of wasm/platform/index.js): a wrong PIN, which
// gs_pair() of libgamestream/pairing.c reports as GS_PIN_WRONG (-7) once the host answered with a hash that doesn't
// match the PIN (native/pairing_test.c), is shown as such, any other failure keeps the general message, and the log
// names the host without the PIN. The pairing itself is answered by the test through the pair() of the host.

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
    assert.equal(dialog.text, 'Error: The PIN entered on OFFICE was wrong.Please, try pairing with the host again and enter the new PIN.');
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
    assert.equal(dialog.text, 'Error: Failed to pair with OFFICE.Please, try pairing with the host again.');
    assert.equal(dialog.button, 'Close');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
