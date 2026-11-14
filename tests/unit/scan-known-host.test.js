'use strict';

// Checks what the search for PCs does with a PC that the app already knows (findNvService() and moveKnownHostTo() of
// wasm/static/js/mdns-browser/main.js). The scan asks every address of the subnet for a server info over plain HTTP,
// and any device can read the unique ID of a PC from the PC itself and answer the scan with it. Up to 2.3.0 such an
// answer was enough to move a paired PC: its address, local address, both base URLs and MAC address were overwritten
// and saved, so the PC showed offline (the pinned key didn't match the device) and Wake-on-LAN got a wrong MAC address,
// until a later scan found the real PC again. Now a paired PC moves only once the new address answered the server info
// over HTTPS with the key that was pinned at the pairing, and takes the ports and the MAC address of that answer:
//  - a device that answers with the unique ID of a paired PC changes nothing that is stored;
//  - the real PC at a new address is adopted;
//  - a PC that isn't paired has no key to prove itself with and is taken as before, as is a new PC.
// utils.js and main.js run in a vm context with a simulated network: each address answers the server info over HTTP
// and over HTTPS as the test says, the latter only for the right pinned key. tests/browser/hostile-server-info.test.js
// runs both directions in the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext, plain } = require('./helpers/platform-loader');
const { installXmlStandIn } = require('./helpers/xml-stand-in');

const UID = 'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876';
const OTHER_UID = '0A1B2C3D-4E5F-4071-8293-A4B5C6D7E8F9';
// A certificate mismatch of the module (GS_CERT_MISMATCH)
const CERT_MISMATCH = -100;

function serverInfo(fields) {
  const all = Object.assign({ hostname: 'GAMING-PC', appversion: '7.1.431.-1', GfeVersion: '3.23.0.74', uniqueid: UID, HttpsPort: '47984', ExternalPort: '47989',
    mac: '00:00:00:00:00:00', LocalIP: '192.168.1.20', ServerCodecModeSupport: '3843', PairStatus: '0', currentgame: '0', state: 'SUNSHINE_SERVER_FREE' }, fields);
  return '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' + Object.keys(all).map((name) => '<' + name + '>' + all[name] + '</' + name + '>').join('') + '</root>';
}

// Load utils.js and the scan with the parts of index.js that they call, and a network of `devices`:
// { address: { http: <answer>, https: <answer>, key: <the pinned key that the HTTPS answer needs> } }
function loadScan(devices) {
  const requests = [];
  const platform = createPlatformContext({
    globals: {
      crypto: webcrypto,
      myUniqueid: 'CLIENT',
      isInGame: false,
      hosts: {},
      // The request that looks whether an address answers: the tests have no network, so it fails at once, which hands
      // the request to the module
      fetch() {
        return Promise.reject(new TypeError('Failed to fetch'));
      },
      sendMessage(method, params) {
        if (method === 'STUN') {
          return Promise.resolve('203.0.113.9');
        }
        const match = /^(https?):\/\/([^/:]+):(\d+)\/serverinfo\?/.exec(String(params[0]));
        requests.push(match ? match[1] + ' ' + match[2] + ':' + match[3] + (params[1] ? ' key ' + params[1] : '') : String(params[0]));
        const device = match && Object.prototype.hasOwnProperty.call(devices, match[2]) ? devices[match[2]] : null;
        if (!device || !device[match[1]]) {
          return Promise.reject(-1);
        }
        if (match[1] === 'https' && device.key !== params[1]) {
          return Promise.reject(CERT_MISMATCH);
        }
        return Promise.resolve(device[match[1]]);
      },
    },
  });
  platform.load('wasm/static/js/utils.js');
  installXmlStandIn(platform);
  // What index.js gives the scan: the lookup of a known host, the save of the hosts, the MAC address update (which
  // writes the MAC address of the given host into the stored one), the PC list and the polling
  platform.run(`var __saved = [];
    var __macUpdates = [];
    var __added = [];
    function getHostByUid(serverUid) {
      return isValidServerUid(serverUid) && Object.prototype.hasOwnProperty.call(hosts, serverUid) ? hosts[serverUid] : undefined;
    }
    function saveHosts() {
      __saved.push(JSON.stringify(hosts));
    }
    function updateMacAddress(host) {
      __macUpdates.push(host.macAddress);
      if (hosts[host.serverUid] && host.macAddress != '00:00:00:00:00:00') {
        hosts[host.serverUid].macAddress = host.macAddress;
      }
    }
    function addHostToGrid(host) {
      hosts[host.serverUid] = host;
      __added.push(host.serverUid);
    }
    function beginBackgroundPollingOfHost() {}`);
  platform.load('wasm/static/js/mdns-browser/main.js');
  return {
    platform,
    requests,
    // A stored host at 192.168.1.20, paired (with the pinned key 'PPK') or not
    addKnownHost(paired) {
      platform.context.__paired = paired;
      platform.context.__uid = UID;
      platform.run(`(function() {
        var host = new NvHTTP('192.168.1.20', 'CLIENT', '', 'a8:a1:59:12:ab:cd');
        host.hostname = 'GAMING-PC';
        host.serverUid = __uid;
        host.localAddress = '192.168.1.20';
        host.httpPort = 47989;
        host.httpsPort = 47984;
        host.externalPort = 47989;
        host.ppkstr = __paired ? 'PPK' : null;
        host.paired = __paired;
        host.online = false;
        host._baseUrlHttps = 'https://192.168.1.20:47984';
        host._baseUrlHttp = 'http://192.168.1.20:47989';
        hosts[__uid] = host;
      })()`);
    },
    // What is stored of the known host and what the scan did
    state() {
      const host = platform.get('hosts')[UID];
      return plain({ address: host.address, localAddress: host.localAddress, macAddress: host.macAddress, httpPort: host.httpPort, httpsPort: host.httpsPort,
        baseUrlHttps: host._baseUrlHttps, baseUrlHttp: host._baseUrlHttp, paired: host.paired, ppkstr: host.ppkstr, hostname: host.hostname,
        saved: platform.get('__saved').length, macUpdates: platform.get('__macUpdates'), added: platform.get('__added') });
    },
    async scan(address) {
      platform.get('findNvService')('ipv4:' + address);
      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    warnings: () => platform.consoleMessages.filter((message) => message.level === 'warn').map((message) => message.text),
    logs: () => platform.consoleMessages.filter((message) => message.level === 'log').map((message) => message.text),
  };
}

const STORED = { address: '192.168.1.20', localAddress: '192.168.1.20', macAddress: 'a8:a1:59:12:ab:cd', httpPort: 47989, httpsPort: 47984,
  baseUrlHttps: 'https://192.168.1.20:47984', baseUrlHttp: 'http://192.168.1.20:47989', paired: true, ppkstr: 'PPK', hostname: 'GAMING-PC',
  saved: 0, macUpdates: [], added: [] };

// What a device that plays the PC answers the scan with: the unique ID of the PC, and its own address, port and MAC.
// It also claims that the TV is paired with it, which made the poll of the scan itself write its MAC address into
// the stored PC (updateMacAddress() in pollServer() of utils.js).
const IMPOSTOR = serverInfo({ hostname: 'GAMING-PC', mac: 'de:ad:be:ef:00:01', LocalIP: '192.168.1.66', HttpsPort: '1234', PairStatus: '1' });

test('a device that answers the scan with the unique ID of a paired PC changes nothing that is stored', async () => {
  // Without HTTPS at all, with HTTPS under its own key, and with HTTPS that answers whatever key is asked for but with
  // another unique ID (which a real key can't do; the answer is checked all the same)
  const devices = [
    { http: IMPOSTOR },
    { http: IMPOSTOR, https: IMPOSTOR, key: 'KEY-OF-THE-DEVICE' },
    { http: IMPOSTOR, https: serverInfo({ uniqueid: OTHER_UID, mac: 'de:ad:be:ef:00:01', LocalIP: '192.168.1.66' }), key: 'PPK' },
  ];
  for (const device of devices) {
    const scan = loadScan({ '192.168.1.66': device });
    scan.addKnownHost(true);
    assert.deepEqual(scan.state(), STORED);
    await scan.scan('192.168.1.66');
    // Nothing moved, nothing saved, no MAC address taken, no second entry in the list
    assert.deepEqual(scan.state(), STORED, JSON.stringify(Object.keys(device)));
    // The device was asked to prove itself: over HTTPS, at the stored port of the PC (not the one the device named),
    // with the pinned key
    assert.deepEqual(scan.requests, ['http 192.168.1.66:47989', 'https 192.168.1.66:47984 key PPK']);
    const warnings = scan.warnings().filter((text) => text.indexOf('[main.js, moveKnownHostTo]') >= 0);
    assert.equal(warnings.length, 1, scan.warnings().join('\n'));
    assert.match(warnings[0], /Warning: A device at 192\.168\.1\.66 answered the scan with the unique ID of the paired PC GAMING-PC, but didn't prove to be that PC over HTTPS with its pinned key \(.+\)\. Keeping the PC at 192\.168\.1\.20\.$/);
  }
});

test('the real PC at a new address is adopted, with the ports and the MAC address of its authenticated answer', async () => {
  // The PC got a new address and a new network card. Over HTTP it answers a client it can't know with a MAC address
  // of zeros; a device on the way could change that answer, here its HTTPS port
  const overHttp = serverInfo({ LocalIP: '192.168.1.77', HttpsPort: '1111' });
  const overHttps = serverInfo({ LocalIP: '192.168.1.77', mac: 'a8:a1:59:12:ab:ce', PairStatus: '1' });
  const scan = loadScan({ '192.168.1.77': { http: overHttp, https: overHttps, key: 'PPK' } });
  scan.addKnownHost(true);
  await scan.scan('192.168.1.77');
  assert.deepEqual(scan.state(), Object.assign({}, STORED, { address: '192.168.1.77', localAddress: '192.168.1.77', macAddress: 'a8:a1:59:12:ab:ce',
    baseUrlHttps: 'https://192.168.1.77:47984', baseUrlHttp: 'http://192.168.1.77:47989', saved: 1 }));
  assert.deepEqual(scan.requests, ['http 192.168.1.77:47989', 'https 192.168.1.77:47984 key PPK']);
  // What was saved is the host at its new address
  const saved = JSON.parse(scan.platform.get('__saved')[0])[UID];
  assert.deepEqual([saved.address, saved._baseUrlHttps, saved._baseUrlHttp, saved.macAddress, saved.ppkstr],
    ['192.168.1.77', 'https://192.168.1.77:47984', 'http://192.168.1.77:47989', 'a8:a1:59:12:ab:ce', 'PPK']);
  assert.deepEqual(scan.warnings(), []);
  assert.equal(scan.logs().filter((text) => text.indexOf('Updating address for server UID: ' + UID + ' from 192.168.1.20 to 192.168.1.77') >= 0).length, 1);

  // The scan finds it there again: nothing to do, nothing saved, no further request for a proof, although the HTTPS
  // port of the answer over HTTP is another one than the stored one
  scan.requests.length = 0;
  await scan.scan('192.168.1.77');
  assert.equal(scan.state().saved, 1);
  assert.deepEqual(scan.requests, ['http 192.168.1.77:47989']);
});

test('a paired PC that the scan finds at its own address stays as it is', async () => {
  const scan = loadScan({ '192.168.1.20': { http: serverInfo({}), https: serverInfo({ mac: 'a8:a1:59:12:ab:cd', PairStatus: '1' }), key: 'PPK' } });
  scan.addKnownHost(true);
  await scan.scan('192.168.1.20');
  assert.deepEqual(scan.state(), STORED);
  assert.deepEqual(scan.requests, ['http 192.168.1.20:47989']);
  assert.deepEqual(scan.warnings(), []);
});

test('a known PC that isn\'t paired is taken from the answer of the scan, as before, and so is a new PC', async () => {
  // Nothing about it can be authenticated: it has no pinned key
  const scan = loadScan({ '192.168.1.77': { http: serverInfo({ LocalIP: '192.168.1.77', mac: 'a8:a1:59:12:ab:ce', HttpsPort: '48984' }) },
    '192.168.1.88': { http: serverInfo({ uniqueid: OTHER_UID, hostname: 'OTHER-PC', LocalIP: '192.168.1.88' }) } });
  scan.addKnownHost(false);
  await scan.scan('192.168.1.77');
  assert.deepEqual(scan.state(), Object.assign({}, STORED, { paired: false, ppkstr: null, address: '192.168.1.77', localAddress: '192.168.1.77',
    macAddress: 'a8:a1:59:12:ab:ce', baseUrlHttps: 'https://192.168.1.77:48984', baseUrlHttp: 'http://192.168.1.77:47989', saved: 1,
    macUpdates: ['a8:a1:59:12:ab:ce'] }));
  assert.deepEqual(scan.requests, ['http 192.168.1.77:47989']);

  await scan.scan('192.168.1.88');
  assert.deepEqual(scan.state().added, [OTHER_UID]);
  assert.equal(scan.state().saved, 2);
  assert.equal(scan.platform.get('hosts')[OTHER_UID].hostname, 'OTHER-PC');
});

test('the scan takes nothing of its answer over for a host with a pinned key', () => {
  const scan = fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/js/mdns-browser/main.js'), 'utf8');
  // The branch of a paired host comes before the one that copies the answer, and calls the check
  const paired = scan.indexOf('} else if (knownHost.ppkstr) {');
  const copies = scan.indexOf('knownHost.address = returnedDiscoveredHost.address;');
  assert.ok(paired > 0 && copies > paired);
  assert.match(scan.slice(paired, copies), /if \(existingAddress !== returnedDiscoveredHost\.address\) \{\s+moveKnownHostTo\(knownHost, returnedDiscoveredHost\.address\);\s+\}\s+\} else \{/);
  // The check asks the stored host itself, which uses HTTPS and its pinned key once it has one
  const move = scan.slice(scan.indexOf('function moveKnownHostTo(knownHost, discoveredAddress) {'), scan.indexOf('window.subnetScanAbortCtrl = null;'));
  assert.match(move, /return knownHost\.refreshServerInfoAtAddress\(discoveredAddress\)\.then\(function\(\) \{/);
  assert.equal(/returnedDiscoveredHost|updateMacAddress/.test(move), false);
  const utils = fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/js/utils.js'), 'utf8');
  // The poll of a host hands its MAC address to the stored host only when it has a pinned key itself
  assert.match(utils, /if \(this\.paired && this\.ppkstr && this\._pollCount === 0\) \{\s+updateMacAddress\(this\);/);
  assert.equal((utils.match(/updateMacAddress\(/g) || []).length, 1);
  assert.match(utils, /if \(this\.ppkstr == null\) \{ \/\/ No pinned cert/);
  assert.match(utils, /return this\._openUrlWithTimeout\('https:\/\/' \+ urlAddr \+ ':' \+ this\.httpsPort \+ '\/serverinfo\?' \+ this\._buildUidStr\(\), this\.ppkstr\)/);
});
