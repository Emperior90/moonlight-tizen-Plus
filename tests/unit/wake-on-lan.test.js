'use strict';

// Checks the Wake-on-LAN request around the magic packet of wasm/wake_on_lan.hpp (native/wake_on_lan_test.cpp runs
// the packet and its rounds): MoonlightInstance::WakeOnLan_private() in wasm/main.cpp settles the promise of every
// request, also for a host without a known MAC address (00:00:00:00:00:00), whose request was never answered before,
// which left the Wake PC dialog waiting forever; that error reaches the dialog translated; and NvHTTP.sendWOL() of
// wasm/static/js/utils.js passes the broadcast address of the subnet of the TV, which getSubnetBroadcastAddress() works
// out from the address and the mask of the TV.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext, loadPlatformScripts } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const readLocale = (name) => JSON.parse(read('wasm/static/locales/' + name + '.json'));

// The body of a C++ function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

const UNKNOWN_MAC_ERROR = "The PC hasn't reported its MAC address (00:00:00:00:00:00)";

test('every Wake-on-LAN request is answered, also for the unknown MAC address 00:00:00:00:00:00', () => {
  const body = functionBody(read('wasm/main.cpp'), 'void MoonlightInstance::WakeOnLan_private(');
  const lines = body.split('\n');
  let returns = 0;
  lines.forEach((line, i) => {
    if (/^\s*return;/.test(line)) {
      returns++;
      assert.match(lines[i - 1], /PostPromiseMessage\(callbackId, "reject", /, 'the line before the return in line ' + (i + 1) + ' of the function');
    }
  });
  assert.equal(returns, 5, 'invalid MAC address, unknown MAC address, no socket, no broadcast, nothing sent');
  assert.match(body, /if \(IsZeroMacAddress\(mac\)\) \{[^}]*PostPromiseMessage\(callbackId, "reject", kWakeOnLanUnknownMacError\);\s+return;\s+\}/);
  // The end resolves the promise, or rejects it when no packet went out
  assert.match(body, /if \(sent == 0\) \{\s+PostPromiseMessage\(callbackId, "reject", "Failed to send magic packet to MAC address " \+ macAddress\);\s+return;\s+\}\s+PostPromiseMessage\(callbackId, "resolve", /);
});

test('the error of the unknown MAC address reaches the dialog translated', () => {
  assert.ok(read('wasm/wake_on_lan.hpp').includes('kWakeOnLanUnknownMacError = "' + UNKNOWN_MAC_ERROR + '";'));
  for (const [locale, expected] of [['en-US', UNKNOWN_MAC_ERROR], ['pt-BR', 'O PC não informou seu endereço MAC (00:00:00:00:00:00)']]) {
    const messages = readLocale(locale);
    const t = (key) => (Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key);
    const platform = loadPlatformScripts(['wasm/platform/messages.js'], { globals: { t } });
    assert.equal(platform.get('replaceKnownWolErrorLabels')(UNKNOWN_MAC_ERROR), expected);
    // A failed send names the MAC address after the translated label
    assert.equal(platform.get('replaceKnownWolErrorLabels')('Failed to send magic packet to MAC address 02:00:00:00:00:01'),
      t('Failed to send magic packet to MAC address') + ' 02:00:00:00:00:01');
  }
});

// Load utils.js on a simulated TV with the given address and mask (tv-mock.js)
function loadUtils(tv) {
  const platform = createPlatformContext({ tv: tv });
  platform.load('wasm/static/js/utils.js');
  return platform;
}

test('the broadcast address of the subnet of the TV comes from its address and mask', () => {
  const cases = [
    [{ ip: '192.168.0.50', subnetMask: '255.255.255.0' }, '192.168.0.255'],
    [{ ip: '10.1.2.3', subnetMask: '255.255.0.0' }, '10.1.255.255'],
    [{ ip: '172.16.5.9', subnetMask: '255.255.252.0' }, '172.16.7.255'],
    [{ ip: '192.168.1.6', subnetMask: '255.255.255.252' }, '192.168.1.7'],
    // No subnet broadcast: /31 and /32, a mask that isn't one of a subnet, no or a malformed address
    [{ ip: '192.168.1.6', subnetMask: '255.255.255.254' }, ''],
    [{ ip: '192.168.1.6', subnetMask: '255.255.255.255' }, ''],
    [{ ip: '192.168.1.6', subnetMask: '255.0.255.0' }, ''],
    [{ ip: '', subnetMask: '255.255.255.0' }, ''],
    [{ ip: '0.0.0.0', subnetMask: '255.255.255.0' }, ''],
    [{ ip: '192.168.1.256', subnetMask: '255.255.255.0' }, ''],
    [{ ip: '192.168.1.6', subnetMask: 'unknown' }, ''],
    // An API that fails
    [{ ip: '192.168.0.50', subnetMask: '255.255.255.0', failApis: 'webapis.network.getSubnetMask' }, ''],
    [{ ip: '192.168.0.50', subnetMask: '255.255.255.0', failApis: 'webapis.network' }, ''],
  ];
  for (const [tv, expected] of cases) {
    assert.equal(loadUtils(tv).get('getSubnetBroadcastAddress()'), expected, JSON.stringify(tv));
  }
});

test('sendWOL() passes the MAC address and the subnet broadcast address to the native code', () => {
  const platform = loadUtils({ ip: '192.168.0.50', subnetMask: '255.255.255.0' });
  platform.run('var __sent = []; sendMessage = function(method, params) { __sent.push([method, params]); return Promise.resolve(); };');
  platform.run("new NvHTTP('192.168.0.10', '0123456789abcdef', '', '02:00:00:00:00:01').sendWOL();");
  assert.deepEqual(JSON.parse(platform.get('JSON.stringify(__sent)')), [['wakeOnLan', ['02:00:00:00:00:01', '192.168.0.255']]]);
  // The Embind function takes the callback ID and both of them
  const main = read('wasm/main.cpp');
  assert.match(main, /void wakeOnLan\(int callbackId, std::string macAddress, std::string subnetBroadcast\) \{\s+g_Instance->WakeOnLan\(callbackId, macAddress, subnetBroadcast\);/);
  assert.match(main, /if \(ParseSubnetBroadcastAddress\(subnetBroadcast, &address\)\) \{\s+targets\.push_back\(MakeWakeOnLanTarget\(udpSocket, address\)\);/);
});
