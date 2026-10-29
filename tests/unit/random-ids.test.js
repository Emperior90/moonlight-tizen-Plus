'use strict';

// Checks that the pairing PIN and the random IDs of wasm/static/js/utils.js come from the cryptographic random
// generator of the browser (crypto.getRandomValues() through cryptoRand()) instead of Math.random(), whose output can
// be predicted from earlier values: the 4-digit PIN that the user enters on the host (generatePairingPin()), the unique
// ID of the install (uniqueid(), created once and then stored) and the UUID of each request to the host (guuid()). A
// unique ID that an install already stored stays as it is (browser/existing-install.test.js and
// browser/startup-robustness.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext } = require('./helpers/platform-loader');

// Load utils.js with a crypto object that records its calls and answers with the given 32-bit values in turn (or with
// real random values once they run out), and a Math.random() that fails the test when anything calls it
function loadUtils(values) {
  const queue = (values || []).slice();
  const crypto = {
    calls: 0,
    getRandomValues(array) {
      crypto.calls++;
      if (queue.length > 0) {
        array[0] = queue.shift();
        return array;
      }
      return webcrypto.getRandomValues(array);
    },
  };
  const platform = createPlatformContext({ globals: { crypto } });
  platform.load('wasm/static/js/utils.js');
  platform.run('Math.random = function() { throw new Error("Math.random() was called"); };');
  return { platform, crypto };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the pairing PIN has four digits and comes from the crypto generator', () => {
  const { platform, crypto } = loadUtils();
  for (let i = 0; i < 200; i++) {
    assert.match(platform.get('generatePairingPin()'), /^\d{4}$/);
  }
  assert.ok(crypto.calls >= 200);
});

test('the pairing PIN keeps its leading zeros and covers 0000 to 9999', () => {
  // cryptoRand(10000) rejects values below (2^32 - 10000) % 10000 = 7296, so that every PIN is equally likely
  const { platform, crypto } = loadUtils([10007, 7296, 19999, 4294967295, 5, 100042]);
  assert.equal(platform.get('generatePairingPin()'), '0007');
  assert.equal(platform.get('generatePairingPin()'), '7296');
  assert.equal(platform.get('generatePairingPin()'), '9999');
  assert.equal(platform.get('generatePairingPin()'), '7295');
  // A value below the limit is drawn again
  assert.equal(platform.get('generatePairingPin()'), '0042');
  assert.equal(crypto.calls, 6);
});

test('PINs vary and include ones with leading zeros', () => {
  const { platform } = loadUtils();
  const pins = new Set();
  let leadingZeros = 0;
  for (let i = 0; i < 2000; i++) {
    const pin = platform.get('generatePairingPin()');
    pins.add(pin);
    if (pin[0] === '0') {
      leadingZeros++;
    }
  }
  // 2000 draws from 10000 PINs give about 1820 different ones; a fixed or badly seeded generator gives far fewer
  assert.ok(pins.size > 1600, 'only ' + pins.size + ' different PINs');
  assert.ok(leadingZeros > 100, 'only ' + leadingZeros + ' PINs with a leading zero');
});

test('the unique ID has 16 hex digits from the crypto generator', () => {
  const { platform, crypto } = loadUtils([0x1f, 0, 0xa, 0xffffffff]);
  const id = platform.get('uniqueid()');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id.slice(0, 4), 'f0af');
  assert.equal(crypto.calls, 16);
});

test('the request UUID is a version 4 UUID from the crypto generator', () => {
  const { platform, crypto } = loadUtils();
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    const id = platform.get('guuid()');
    assert.match(id, UUID_V4);
    ids.add(id);
  }
  assert.equal(ids.size, 100);
  // 30 random hex digits and the variant digit per UUID
  assert.equal(crypto.calls, 100 * 31);
});

test('the variant digit of the request UUID is 8 to b', () => {
  const values = new Array(31).fill(0);
  values[15] = 0xf; // the 16th random digit is the variant digit ('y')
  const { platform } = loadUtils(values);
  assert.equal(platform.get('guuid()'), '00000000-0000-4000-b000-000000000000');
});

test('no script that runs on the TV uses Math.random() for the PIN or the IDs', () => {
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  // The code without its line comments, which may name Math.random()
  const code = (source) => source.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code(read('wasm/static/js/utils.js')), /Math\.random/);
  const index = read('wasm/platform/index.js');
  assert.doesNotMatch(code(index), /Math\.random/);
  // The pairing dialog shows and sends the PIN of generatePairingPin()
  assert.match(index, /var randomNumber = generatePairingPin\(\);/);
  assert.match(index, /nvhttpHost\.pair\(randomNumber\)/);
  // A new unique ID is only created when none is stored
  assert.match(index, /if \(savedUniqueid && savedUniqueid\.uniqueid != null\) \{ \/\/ We have a saved uniqueid\s+myUniqueid = savedUniqueid\.uniqueid;\s+\} else \{\s+myUniqueid = uniqueid\(\);/);
});
