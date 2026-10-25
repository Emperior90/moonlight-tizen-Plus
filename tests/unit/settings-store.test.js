'use strict';

// How getData() and removeData() of wasm/platform/index.js use IndexedDB, with a simulated database whose requests the
// tests answer by hand. getData() passed an undefined variable on its error paths and threw a ReferenceError instead of
// calling back, so a setting that couldn't be read stopped the settings after it from loading. Now every path calls
// back exactly once and asynchronously, with null and true as the second argument when the key couldn't be read. The
// browser tests (browser/startup-robustness.test.js) check what the app does with that.

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

// A database whose transactions are recorded, so that a test can answer the request of each one, or fail it
function createFakeDb(options) {
  const opts = options || {};
  const transactions = [];
  const db = {
    transaction(storeName, mode) {
      if (opts.transactionError) {
        throw opts.transactionError;
      }
      const transaction = { storeName, mode, requests: [], deleted: [] };
      transaction.objectStore = () => ({
        get(key) {
          const request = { key, result: undefined };
          transaction.requests.push(request);
          return request;
        },
        delete(key) {
          transaction.deleted.push(key);
          return {};
        },
      });
      transactions.push(transaction);
      return transaction;
    },
  };
  return { db, transactions };
}

// Load index.js with the fake database already open, and return getData() with a recorder of its callbacks
function withFakeDb(options) {
  const platform = loadPlatformScripts(INDEX_SCRIPTS, { tv: { tv: 's90c' } });
  const fake = createFakeDb(options);
  platform.context.__fakeDb = fake.db;
  platform.run('db = __fakeDb;');
  const calls = [];
  const read = (key) => platform.get('getData')(key, function(value, isReadFailed) {
    calls.push({ value: plain(value), isReadFailed });
  });
  return { platform, transactions: fake.transactions, calls, read };
}

// Let the timers that are due run
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('getData() passes a stored value, and null for a key that is not stored', () => {
  const store = withFakeDb();
  store.read('bitrate');
  store.read('frameRate');
  assert.equal(store.transactions[0].mode, 'readonly');
  store.transactions[0].requests[0].result = JSON.stringify('80');
  store.transactions[0].requests[0].onsuccess({});
  store.transactions[1].requests[0].onsuccess({});
  assert.deepEqual(store.calls, [
    { value: { bitrate: '80' }, isReadFailed: false },
    { value: { frameRate: null }, isReadFailed: false },
  ]);
});

test('getData() calls back once with null when the transaction fails, instead of throwing a ReferenceError', () => {
  const store = withFakeDb();
  store.read('hdrMode');
  const transaction = store.transactions[0];
  // A failed request reports an error and then aborts its transaction
  assert.doesNotThrow(() => transaction.onerror({}));
  assert.doesNotThrow(() => transaction.onabort({}));
  assert.deepEqual(store.calls, [{ value: { hdrMode: null }, isReadFailed: true }]);
  assert.ok(store.platform.consoleMessages.some((message) => message.level === 'error' && message.text.indexOf('Unable to read data at the key: hdrMode') >= 0));
});

test('getData() calls back with null when the transaction aborts without an error', () => {
  const store = withFakeDb();
  store.read('cert');
  store.transactions[0].onabort({});
  assert.deepEqual(store.calls, [{ value: { cert: null }, isReadFailed: true }]);
});

test('getData() calls back with null for a stored value that is not valid JSON', () => {
  const store = withFakeDb();
  store.read('uniqueid');
  store.transactions[0].requests[0].result = '{broken';
  assert.doesNotThrow(() => store.transactions[0].requests[0].onsuccess({}));
  assert.deepEqual(store.calls, [{ value: { uniqueid: null }, isReadFailed: true }]);
});

test('getData() calls back asynchronously with null when the database can\'t start a transaction', async () => {
  const store = withFakeDb({ transactionError: new Error('InvalidStateError: the database connection is closing') });
  assert.doesNotThrow(() => store.read('gameMode'));
  // Not at once: the settings start to load during the window load event, before the switches are set up
  assert.deepEqual(store.calls, []);
  await tick();
  assert.deepEqual(store.calls, [{ value: { gameMode: null }, isReadFailed: true }]);
  await tick();
  assert.equal(store.calls.length, 1);
});

test('getData() calls back only once when the callback throws and so aborts the transaction', () => {
  const platform = loadPlatformScripts(INDEX_SCRIPTS, { tv: { tv: 's90c' } });
  const fake = createFakeDb();
  platform.context.__fakeDb = fake.db;
  platform.run('db = __fakeDb;');
  let callCount = 0;
  platform.get('getData')('bitrate', function() {
    callCount++;
    throw new Error('failure in the callback');
  });
  const transaction = fake.transactions[0];
  transaction.requests[0].result = JSON.stringify('80');
  assert.throws(() => transaction.requests[0].onsuccess({}), /failure in the callback/);
  // IndexedDB aborts a transaction when its success handler throws
  transaction.onabort({});
  assert.equal(callCount, 1);
});

test('removeData() deletes the key in a writing transaction and calls back once it completed', () => {
  const store = withFakeDb();
  let isRemoved = false;
  store.platform.get('removeData')('gameMode', function() {
    isRemoved = true;
  });
  const transaction = store.transactions[0];
  assert.equal(transaction.mode, 'readwrite');
  assert.deepEqual(transaction.deleted, ['gameMode']);
  assert.equal(isRemoved, false);
  transaction.oncomplete({});
  assert.equal(isRemoved, true);
});
