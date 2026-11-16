'use strict';

// Checks the name that the pairing requests give the TV (devicename=...), which the host shows for it: Sunshine next to
// the address in its list of pairing requests that wait for a PIN, Apollo and Vibepollo as the name of the paired
// client in their permission lists. Up to 2.3.0 every request sent 'roth', the placeholder that Moonlight clients have
// always sent, which Apollo and Vibepollo show as 'Legacy Moonlight Client'. Now pairingDeviceName() of
// wasm/static/js/utils.js builds 'Moonlight Plus (<model>)' from the model name of the TV that System information shows
// (getRealModel() of webapis.productinfo, never the name the user gave the TV), plain ASCII and at most 64 bytes, with
// 'roth' for GeForce Experience and when no model is known. NvHTTP.pair() sends it URL-encoded to the module, whose
// gs_pair() (libgamestream/pairing.c) puts it into its four requests and checks it once more (native/pairing_test.c
// runs that), and in its own pairchallenge request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext } = require('./helpers/platform-loader');
const tvMock = require('../browser/mocks/tv-mock');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// What gs_pair() takes as it is: unreserved characters and %XX escapes (pairing_device_name() of pairing.c)
const URL_ENCODED_NAME = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/;

// Load utils.js, optionally after tv_profile.js has detected the simulated TV like index.js does at its start
// (tvCapabilities), with a sendMessage() that records the requests and answers them
function loadUtils(options) {
  const opts = options || {};
  const requests = [];
  const platform = createPlatformContext({
    tv: opts.tv,
    globals: {
      crypto: webcrypto,
      sendMessage(method, params) {
        requests.push({ method, params });
        return Promise.resolve(method === 'pair' ? 'sha256//PINNED' : '<root status_code="200"><paired>1</paired></root>');
      },
    },
  });
  if (opts.tv) {
    platform.load('wasm/platform/tv_profile.js');
    platform.run('var tvCapabilities = detectTvCapabilities();');
  }
  platform.load('wasm/static/js/utils.js');
  return { platform, requests };
}

// An unpaired host whose server info refresh reports GeForce Experience or not
function makeHost(utils, isNvidiaServerSoftware) {
  const host = utils.platform.run('new NvHTTP("10.0.0.2", "0123456789abcdef", "", "")');
  host.hostname = 'GAMING-PC';
  host.serverMajorVersion = 7;
  host.httpPort = 47989;
  host._baseUrlHttps = 'https://10.0.0.2:47984';
  host.refreshServerInfo = function() {
    host.isNvidiaServerSoftware = isNvidiaServerSoftware;
    return Promise.resolve(true);
  };
  host._parseXML = function() {
    return { find: () => ({ html: () => '1' }) };
  };
  return host;
}

test('a TV with a model name pairs as Moonlight Plus (<model>)', () => {
  const name = loadUtils().platform.get('pairingDeviceName');
  assert.equal(name('QE55S90CAT', false), 'Moonlight Plus (QE55S90CAT)');
  assert.equal(name('UE43T5300AU', false), 'Moonlight Plus (UE43T5300AU)');
  // Dots, dashes and underscores of a model name stay
  assert.equal(name('QN65QN90D.FXZA', false), 'Moonlight Plus (QN65QN90D.FXZA)');
  assert.equal(name('UE-55_TU7', false), 'Moonlight Plus (UE-55_TU7)');
});

test('no model name, or one with nothing usable, gives roth', () => {
  const name = loadUtils().platform.get('pairingDeviceName');
  for (const model of [null, undefined, '', '   ', '\t\n', 42, {}, ['QE55S90CAT'], 'ÄÖÜ', '電視', '()&=%?', '​']) {
    assert.equal(name(model, false), 'roth', JSON.stringify(model));
  }
});

test('spaces are trimmed and collapsed, and anything but ASCII letters, digits, . - _ is dropped', () => {
  const name = loadUtils().platform.get('pairingDeviceName');
  assert.equal(name('  QE55   S90C AT  ', false), 'Moonlight Plus (QE55 S90C AT)');
  assert.equal(name('QE55S90CÄT', false), 'Moonlight Plus (QE55S90CT)');
  assert.equal(name('QE55S90CAT (Living room)', false), 'Moonlight Plus (QE55S90CAT Living room)');
  assert.equal(name('QE55<b>S90C</b>&x=1', false), 'Moonlight Plus (QE55bS90Cbx1)');
  assert.equal(name('QE55\tS90C\nAT', false), 'Moonlight Plus (QE55S90CAT)');
  assert.equal(name('テレビ QE55S90CAT', false), 'Moonlight Plus (QE55S90CAT)');
});

test('a very long model name is cut so that the whole name has at most 64 bytes', () => {
  const name = loadUtils().platform.get('pairingDeviceName');
  const long = name('A'.repeat(200), false);
  assert.equal(long, 'Moonlight Plus (' + 'A'.repeat(47) + ')');
  assert.equal(Buffer.byteLength(long, 'utf8'), 64);
  // A space where the model is cut doesn't stay in front of the parenthesis
  assert.equal(name('A'.repeat(46) + ' BCDEF', false), 'Moonlight Plus (' + 'A'.repeat(46) + ')');
  // Non-ASCII characters don't count, since they are dropped first
  assert.equal(name('Ä'.repeat(100) + 'QE55S90CAT', false), 'Moonlight Plus (QE55S90CAT)');
});

test('GeForce Experience gets roth, whatever the model', () => {
  const name = loadUtils().platform.get('pairingDeviceName');
  assert.equal(name('QE55S90CAT', true), 'roth');
  assert.equal(name(null, true), 'roth');
});

test('every name is plain ASCII of at most 64 bytes, and its URL form is what gs_pair() takes', () => {
  const utils = loadUtils();
  const name = utils.platform.get('pairingDeviceName');
  const encode = utils.platform.get('encodePairingDeviceName');
  const samples = ['QE55S90CAT', 'x', ' a b ', 'A'.repeat(64), 'A '.repeat(40), '!*\'()~', 'Ünïcødé-Τηλεόραση 55"', '\u0000\u007f\u0080'];
  for (let i = 0; i < 200; i++) {
    let text = '';
    for (let j = 0; j < (i % 90); j++) {
      text += String.fromCharCode((i * 7919 + j * 104729) % 0x3000);
    }
    samples.push(text);
  }
  for (const model of samples) {
    const plain = name(model, false);
    assert.match(plain, /^[\x20-\x7e]+$/, JSON.stringify(model));
    assert.ok(Buffer.byteLength(plain, 'utf8') <= 64, JSON.stringify(model));
    const encoded = encode(plain);
    assert.match(encoded, URL_ENCODED_NAME, JSON.stringify(model));
    assert.equal(decodeURIComponent(encoded), plain);
  }
  // Parentheses and spaces are escaped too, which encodeURIComponent() alone leaves out for ( and )
  assert.equal(encode('Moonlight Plus (QE55S90CAT)'), 'Moonlight%20Plus%20%28QE55S90CAT%29');
  assert.equal(encode('roth'), 'roth');
  assert.equal(encode("a!b'c*d~e"), 'a%21b%27c%2Ad~e');
  // The native test pairs with the name that the app sends for this model
  assert.match(read('tests/native/pairing_test.c'), /#define TV_DEVICE_NAME "Moonlight%20Plus%20%28QE55S90CAT%29"/);
});

test('the model comes from the detection of the TV, getRealModel() of webapis.productinfo', () => {
  for (const preset of ['s90c', 'uhd', 'fhd', '8k']) {
    const utils = loadUtils({ tv: { tv: preset } });
    const model = tvMock.parseConfig('', { tv: preset }).model;
    assert.equal(utils.platform.run('tvCapabilities.modelName'), model);
    assert.equal(utils.platform.run('pairingDeviceName(tvCapabilities.modelName, false)'), 'Moonlight Plus (' + model + ')');
  }
  // The name is built from the model only: the builder reads no API of the TV itself, and the pairing passes it the
  // detected model, so the name that the user gave the TV never reaches it
  const utils = read('wasm/static/js/utils.js');
  const builder = utils.slice(utils.indexOf('function pairingDeviceName('), utils.indexOf('function encodePairingDeviceName('));
  assert.doesNotMatch(builder, /tizen|webapis|tvCapabilities/);
  assert.match(utils, /pairingDeviceName\(typeof tvCapabilities !== 'undefined' && tvCapabilities \? tvCapabilities\.modelName : null,/);
});

test('NvHTTP.pair() sends the name to the module and in its pairchallenge request', async () => {
  const utils = loadUtils({ tv: { tv: 's90c' } });
  const host = makeHost(utils, false);
  assert.equal(await host.pair('1234'), true);
  assert.deepEqual(utils.requests.map((request) => request.method), ['pair', 'openUrl']);
  // version, address, HTTP port, PIN, unique ID, device name: the arguments of pair() in wasm/main.cpp
  assert.deepEqual(Array.from(utils.requests[0].params), ['7', '10.0.0.2', 47989, '1234', '0123456789abcdef',
    'Moonlight%20Plus%20%28QE55S90CAT%29']);
  assert.equal(utils.requests[1].params[0], 'https://10.0.0.2:47984/pair?uniqueid=0123456789abcdef' +
    '&devicename=Moonlight%20Plus%20%28QE55S90CAT%29&updateState=1&phrase=pairchallenge');
  assert.ok(utils.platform.consoleMessages.some((line) => line.text.indexOf('Pairing with GAMING-PC as \'Moonlight Plus (QE55S90CAT)\'.') >= 0));
});

test('NvHTTP.pair() sends roth to GeForce Experience and when the model is unknown', async () => {
  // GeForce Experience, told apart by its server info (MJOLNIR in its state), also gets the fixed unique ID
  let utils = loadUtils({ tv: { tv: 's90c' } });
  await makeHost(utils, true).pair('1234');
  assert.equal(utils.requests[0].params[4], '0123456789ABCDEF');
  assert.equal(utils.requests[0].params[5], 'roth');
  assert.match(utils.requests[1].params[0], /\?uniqueid=0123456789ABCDEF&devicename=roth&updateState=1&phrase=pairchallenge$/);

  // A TV whose model can't be read
  utils = loadUtils({ tv: { tv: 's90c', failApis: 'webapis.productinfo.getRealModel' } });
  assert.equal(utils.platform.run('tvCapabilities.modelName'), null);
  await makeHost(utils, false).pair('1234');
  assert.equal(utils.requests[0].params[5], 'roth');
  assert.match(utils.requests[1].params[0], /&devicename=roth&/);

  // Without the detection at all (tvCapabilities isn't defined)
  utils = loadUtils();
  await makeHost(utils, false).pair('1234');
  assert.equal(utils.requests[0].params[5], 'roth');
});

test('a host that is already paired sends no pairing request, so an existing pairing stays as it is', async () => {
  const utils = loadUtils({ tv: { tv: 's90c' } });
  const host = makeHost(utils, false);
  host.paired = true;
  host.ppkstr = 'sha256//PINNED';
  host.refreshServerInfo = () => Promise.resolve(true);
  assert.equal(await host.pair('1234'), true);
  assert.deepEqual(utils.requests, []);
});

test('the module passes the name from pair() to every pairing request of gs_pair()', () => {
  const main = read('wasm/main.cpp');
  // The entry point of the JavaScript call, up to the closing brace at the start of a line
  const entry = main.slice(main.indexOf('void pair(int callbackId,'), main.indexOf('\n}\n', main.indexOf('void pair(int callbackId,')));
  assert.match(entry, /^void pair\(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber, std::string uniqueId,\s+std::string deviceName\) \{/);
  assert.match(entry, /g_Instance->Pair\(callbackId, serverMajorVersion, address, httpPort, randomNumber, deviceName\);/);
  assert.match(main, /std::bind\(&MoonlightInstance::Pair_private, this, callbackId, serverMajorVersion, address, httpPort, randomNumber,\s+deviceName\)/);
  assert.match(main, /gs_pair\(atoi\(serverMajorVersion\.c_str\(\)\), address\.c_str\(\), \(unsigned short\)httpPort, randomNumber\.c_str\(\),\s+deviceName\.c_str\(\), &ppkstr\);/);
  assert.match(read('wasm/platform/messages.js'), /AsyncFunctions\['pair'\]\(id, \.\.\.params\);/);
  const pairing = read('libgamestream/pairing.c');
  assert.doesNotMatch(pairing, /devicename=roth/);
  assert.equal((pairing.match(/&devicename=%s&updateState=1&/g) || []).length, 5, 'four stages and the request after a wrong PIN');
  assert.doesNotMatch(read('wasm/static/js/utils.js'), /devicename=roth/);
});
