'use strict';

// Checks, in the real page, that a device on the local network can't break the PC list with the unique ID of its
// server info (isValidServerUid() and _parseServerInfo() of wasm/static/js/utils.js, findNvService() of
// static/js/mdns-browser/main.js, keepValidStoredHosts() and getHostByUid() of wasm/platform/index.js). The scan of the
// network registers every device that answers on port 47989, unpaired and over plain HTTP, and the app used its ID as
// it came, as a key of the hosts and in the element IDs of the PC list: '__proto__' made the scan write the addresses
// of the device into Object.prototype, after which every loop over the hosts found them and the polling threw until the
// app restarted, 'constructor' was taken for a known host, and 'x,#main-content' matched other parts of the page as a
// selector. Such a device is ignored now, with a line in the log, a host that an earlier version stored under such an
// ID is left out, and a deep link with such an ID finds no host. A real host, whose ID is a UUID or hexadecimal
// digits, is listed as before. tests/unit/host-uid.test.js has the check itself with many more IDs.
// The requests run through the real poll of a host (pollServer(), refreshServerInfoAtAddress()); only the answer of the
// network is simulated, by the stub of the WebAssembly module.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness, SUNSHINE_HOSTS } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const SUNSHINE_ID = 'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876';

// Let the devices of window.__devices ({ address: unique ID }) answer /serverinfo, each with its ID and with a local
// address of its choosing, and every other address not at all
async function installNetwork(page) {
  await page.waitForFunction(() => isSubnetScanFinished === true, null, { timeout: 15000 });
  await page.evaluate(() => {
    window.__devices = {};
    window.__requests = [];
    Module.openUrl = function(id, url) {
      const match = /^https?:\/\/([\d.]+):\d+\/serverinfo/.exec(url);
      const address = match ? match[1] : '';
      window.__requests.push(address);
      setTimeout(() => {
        if (!Object.prototype.hasOwnProperty.call(window.__devices, address)) {
          handlePromiseMessage(id, 'reject', -1);
          return;
        }
        const uniqueId = window.__devices[address];
        const escaped = String(uniqueId).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        handlePromiseMessage(id, 'resolve', '<?xml version="1.0" encoding="utf-8"?><root status_code="200"><hostname>DEVICE-' +
          address.split('.')[3] + '</hostname><appversion>7.1.431.-1</appversion><GfeVersion>3.23.0.74</GfeVersion>' +
          (uniqueId === null ? '' : '<uniqueid>' + escaped + '</uniqueid>') +
          '<HttpsPort>47984</HttpsPort><ExternalPort>47989</ExternalPort><mac>00:11:22:33:44:55</mac><LocalIP>EVIL-STRING</LocalIP>' +
          '<ServerCodecModeSupport>197377</ServerCodecModeSupport><PairStatus>0</PairStatus><currentgame>0</currentgame>' +
          '<state>SUNSHINE_SERVER_FREE</state></root>');
      }, 5);
    };
    window.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // What a device could have changed: the PC list, the hosts, the properties of every object, the page
    window.pageState = () => {
      const inherited = [];
      for (const name in {}) {
        inherited.push(name);
      }
      const hostNames = [];
      for (const name in hosts) {
        hostNames.push(name);
      }
      return {
        cards: Array.prototype.map.call(document.querySelectorAll('#host-grid .host-container'), (card) => card.id),
        hosts: hostNames,
        inherited,
        ownOfObjectPrototype: Object.getOwnPropertyNames(Object.prototype).length,
        mainContent: document.querySelectorAll('#main-content').length,
      };
    };
  });
}

test('a device that answers the scan with a hostile unique ID is ignored, and a real host is listed', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await installNetwork(app.page);
    const before = await app.page.evaluate(() => window.pageState());
    assert.deepEqual([before.cards, before.hosts, before.inherited, before.mainContent], [[], [], [], 1]);

    const run = await app.page.evaluate(async (sunshineId) => {
      window.__devices = { '10.9.9.1': '__proto__', '10.9.9.2': 'constructor', '10.9.9.3': 'x,#main-content', '10.9.9.4': null,
        '10.9.9.5': 'a'.repeat(65), '10.9.9.6': '<img src=x onerror=alert(1)>', '10.9.9.7': sunshineId, '10.9.9.8': '0123456789ABCDEF' };
      Object.keys(window.__devices).forEach((address) => findNvService('ipv4:' + address));
      await window.wait(1500);
      const state = window.pageState();
      // The polling of the hosts, which threw for the properties that '__proto__' had left on every object
      stopPollingHosts();
      let pollingError = '';
      try {
        await startPollingHosts();
      } catch (error) {
        pollingError = String(error);
      }
      return { state, pollingError, knownHost: hosts[sunshineId].hostname, localAddress: hosts[sunshineId].localAddress,
        requested: Object.keys(window.__devices).filter((address) => window.__requests.indexOf(address) >= 0).length };
    }, SUNSHINE_ID);
    // Every device was asked, and only the two hosts with a real ID are in the list: a UUID and hexadecimal digits
    assert.equal(run.requested, 8);
    assert.deepEqual(run.state.cards.sort(), ['host-container-0123456789ABCDEF', 'host-container-' + SUNSHINE_ID]);
    assert.deepEqual(run.state.hosts.sort(), ['0123456789ABCDEF', SUNSHINE_ID]);
    assert.equal(run.knownHost, 'DEVICE-7');
    // Nothing reached the properties of every object, and the page is whole
    assert.deepEqual(run.state.inherited, []);
    assert.equal(run.state.ownOfObjectPrototype, before.ownOfObjectPrototype);
    assert.equal(run.state.mainContent, 1);
    assert.equal(run.pollingError, '');
    // One line in the log for each ignored device: its address is the only one that is tried (a device that is still
    // named after its address has no name to try with .local, getLocalNameCandidate() in utils.js)
    const ignored = app.logs.filter((line) => line.indexOf('Ignoring the server info of 10.9.9.') >= 0);
    ['10.9.9.1', '10.9.9.2', '10.9.9.3', '10.9.9.4', '10.9.9.5', '10.9.9.6'].forEach((address) => {
      assert.equal(ignored.filter((line) => line.indexOf('Ignoring the server info of ' + address + ':') >= 0).length, 1, address);
    });
    assert.equal(ignored.length, 6, ignored.join('\n'));
    assert.ok(ignored.some((line) => line.indexOf('10.9.9.4: it has no unique ID.') >= 0));
    assert.ok(ignored.some((line) => line.indexOf('its unique ID of 9 characters, starting with "__proto__"') >= 0));
    assert.deepEqual(app.errors, []);

    // Removing a listed host removes its card and nothing else of the page
    const removed = await app.page.evaluate(async (sunshineId) => {
      deleteHostDialog(hosts[sunshineId]);
      await window.wait(300);
      document.getElementById('continueDeleteHost').click();
      await window.wait(300);
      return window.pageState();
    }, SUNSHINE_ID);
    assert.deepEqual(removed.cards, ['host-container-0123456789ABCDEF']);
    assert.deepEqual(removed.hosts, ['0123456789ABCDEF']);
    assert.equal(removed.mainContent, 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a host that an earlier version stored under such an ID is left out, and a deep link with such an ID finds no host', async () => {
  // What 2.3.0 stored after a scan that met such devices, next to a real PC
  const rogue = (serverUid, hostname) => Object.assign({}, SUNSHINE_HOSTS.HOST1, { serverUid, hostname, address: '10.9.9.3', userEnteredAddress: '',
    ppkstr: null, paired: false, _baseUrlHttps: 'https://10.9.9.3:47984', _baseUrlHttp: 'http://10.9.9.3:47989' });
  const stored = Object.assign({}, SUNSHINE_HOSTS, {
    'x,#main-content': rogue('x,#main-content', 'ROGUE-SELECTOR'),
    constructor: rogue('constructor', 'ROGUE-CONSTRUCTOR'),
    'a b': rogue('a b', 'ROGUE-SPACE'),
  });
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { hosts: stored } });
  try {
    await installNetwork(app.page);
    const state = await app.page.evaluate(() => Object.assign(window.pageState(), { isFunction: typeof hosts.constructor === 'function' }));
    assert.deepEqual(state.cards, ['host-container-HOST1']);
    assert.deepEqual(state.hosts, ['HOST1']);
    assert.equal(state.mainContent, 1);
    // 'constructor' is what every object has again, not a host
    assert.equal(state.isFunction, true);
    ['ROGUE-SELECTOR', 'ROGUE-CONSTRUCTOR', 'ROGUE-SPACE'].forEach((name) => {
      assert.equal(app.logs.filter((line) => line.indexOf('Leaving out a stored host') >= 0 && line.indexOf('"' + name + '"') >= 0).length, 1, name);
    });

    // A deep link of a Smart Hub tile with the name of a property of every object: no host, the notice, no error.
    // Before, hosts['constructor'] was the constructor of every object, which the app then opened as a host.
    const link = await app.page.evaluate(async () => {
      const messages = [];
      document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => messages.push(data.message);
      const chosen = [];
      const realHostChosen = hostChosen;
      hostChosen = function(host) {
        chosen.push(host && host.hostname);
      };
      waitForHostAndNavigate('constructor');
      waitForHostAndNavigateToApp('__proto__', 7);
      await window.wait(1300);
      const missing = { messages: messages.splice(0), chosen: chosen.splice(0) };
      // The link of a tile of the real PC still opens it
      waitForHostAndNavigate('HOST1');
      await window.wait(1300);
      hostChosen = realHostChosen;
      return { missing, known: chosen.slice() };
    });
    assert.deepEqual(link.missing.chosen, []);
    assert.deepEqual(link.missing.messages, ['The selected PC is no longer available in Moonlight.', 'The selected PC is no longer available in Moonlight.']);
    assert.deepEqual(link.known, ['GAMING-PC']);
    assert.deepEqual(app.errors, []);

    // The next save drops the hosts that were left out from the storage as well
    await app.page.evaluate(() => saveHosts());
    await app.page.waitForTimeout(300);
    const again = await app.page.evaluate(() => new Promise((resolve) => getData('hosts', (value) => resolve(Object.keys(value.hosts || {})))));
    assert.deepEqual(again, ['HOST1']);
  } finally {
    await app.context.close();
  }
});
