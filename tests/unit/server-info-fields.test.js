'use strict';

// Pins the rules for the fields of a server info (wasm/static/js/utils.js). Like the unique ID (host-uid.test.js),
// they come from whatever device answered, for a host that isn't paired over plain HTTP, and the app stores them with
// the host. Up to 2.3.0 they were kept as they came:
//  - LocalIP, ExternalIP and the name with '.local' became addresses of the next poll, joined into its URL, so
//    'evil.example/x?' sent the request of the TV to another host and path; the check for the TV itself knew only
//    '127.*', '::1' and 'localhost';
//  - a missing or bad HttpsPort was NaN and stood in every HTTPS URL of the host, and the request that looks whether
//    an address answers found the HTTPS port anywhere in the URL, also inside an IPv6 address;
//  - the MAC address, the name, the versions, the GPU name and the state had no form and no limit, and the display
//    modes of every poll were added to the ones before, with 'NaN:NaN' for values that are no numbers.
// Each rule is a small function, checked here on its own and through _parseServerInfo(), which runs with a stand-in
// for the XML parser of the page (helpers/xml-stand-in.js). A field that breaks its rule is left out or cut; the host
// is listed all the same, and the answers of ordinary hosts are kept as they are. The repository holds no answers
// captured from real PCs: the three below are written after the form of the answers of Sunshine, Apollo and GeForce
// Experience. tests/browser/hostile-server-info.test.js runs the rules in the page with the real parser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext, loadPlatformScripts, plain } = require('./helpers/platform-loader');
const { escapeXml, installXmlStandIn } = require('./helpers/xml-stand-in');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// utils.js with the stand-in for the XML parser, and a sendMessage() and fetch() that record the requests
function loadUtils() {
  const requests = [];
  const platform = createPlatformContext({
    globals: {
      crypto: webcrypto,
      sendMessage(method, params) {
        requests.push(String(params[0]));
        return Promise.reject(-1);
      },
      fetch(url) {
        requests.push('fetch ' + url);
        return Promise.reject(new TypeError('Failed to fetch'));
      },
    },
  });
  platform.load('wasm/static/js/utils.js');
  installXmlStandIn(platform);
  platform.requests = requests;
  return platform;
}

// A server info with the given elements ({ name: text }, or a string of XML for elements with children)
function serverInfo(fields) {
  return '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' + Object.keys(fields).map((name) => (
    name === 'xml' ? fields[name] : '<' + name + '>' + escapeXml(fields[name]) + '</' + name + '>')).join('') + '</root>';
}

const displayModes = (modes) => '<SupportedDisplayMode>' + modes.map((mode) => '<DisplayMode><Width>' + mode[0] + '</Width><Height>' +
  mode[1] + '</Height><RefreshRate>' + mode[2] + '</RefreshRate></DisplayMode>').join('') + '</SupportedDisplayMode>';

// The fields that the answers below share with every host
const BASE = { hostname: 'GAMING-PC', appversion: '7.1.431.-1', GfeVersion: '3.23.0.74', uniqueid: 'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876',
  HttpsPort: '47984', ExternalPort: '47989', mac: '00:11:22:33:44:55', LocalIP: '192.168.1.20', ServerCodecModeSupport: '3843',
  PairStatus: '1', currentgame: '0', state: 'SUNSHINE_SERVER_FREE' };

// Parse answers one after the other with one host object, made by `setup` (code that gets `host`), and return what the
// app keeps of them
function parseWith(platform, answers, setup) {
  platform.context.__answers = answers;
  return plain(platform.run(`(function() {
    var host = new NvHTTP('192.168.1.20', 'CLIENT');
    ${setup || ''}
    var parsed = __answers.map(function(answer) { return host._parseServerInfo(answer); });
    return { parsed: parsed, hostname: host.hostname, serverUid: host.serverUid, localAddress: host.localAddress, externalIP: host.externalIP,
      macAddress: host.macAddress === undefined ? null : host.macAddress, httpsPort: host.httpsPort, httpPort: host.httpPort,
      externalPort: host.externalPort, paired: host.paired, appVersion: host.appVersion, gfeVersion: host.gfeVersion,
      serverMajorVersion: host.serverMajorVersion, gputype: host.gputype, numofapps: host.numofapps, serverState: host.serverState,
      isNvidiaServerSoftware: host.isNvidiaServerSoftware, currentGame: host.currentGame, serverCodecModeSupport: host.serverCodecModeSupport,
      supportedDisplayModes: host.supportedDisplayModes, candidates: getServerAddressCandidates(host), json: JSON.stringify(host) };
  })()`));
}

const parseOne = (platform, fields, setup) => parseWith(platform, [serverInfo(Object.assign({}, BASE, fields))], setup);

// Addresses of hosts as they are: IPv4, IPv6 in several spellings, DNS names
const IPV4_ADDRESSES = ['192.168.1.20', '10.0.0.2', '172.16.254.1', '8.8.8.8', '255.255.255.255', '1.2.3.4', '192.168.001.020'];
const IPV6_ADDRESSES = ['fe80::1c2d:3eff:fe4f:5a6b', '2001:db8::1', '2001:0db8:85a3:0000:0000:8a2e:0370:7334', 'fd00::2', '::ffff:192.168.1.20',
  '2001:DB8::ABCD', '1:2:3:4:5:6:7:8', '1::', '1:2:3:4:5:6:7::', '64:ff9b::192.0.2.33'];
const DNS_NAMES = ['gaming-pc', 'GAMING-PC', 'gaming-pc.local', 'pc.lan', 'my.host.example.com', 'my_pc.lan', 'a', 'pc1', '1pc', 'pc-1.home.arpa',
  'xn--bro-hoa.example', 'x'.repeat(63) + '.lan', 'constructor', 'toString'];

// What a field of a server info must never put into a URL
const NO_ADDRESSES = ['evil.example/x?', 'evil.example/x', 'evil.example?x', 'evil.example#x', 'user@evil.example', 'evil.example:80', '10.0.0.2:47989',
  'http://evil.example', '//evil.example', 'evil.example\\x', 'evil example', ' 10.0.0.2', '10.0.0.2 ', '10.0.0.2\n', '\t', '', '[fe80::1]', 'fe80::1%eth0',
  'fe80::1%25eth0', '%31', 'a%2eb', 'a..b', '.a', 'a.', '.', '..', 'a,b', 'a;b', 'a&b', 'a=b', 'a+b', 'a*', '<a>', '"a"', 'ä.example', '例え.jp',
  // Numbers that a URL reads as an IPv4 address in another spelling, e.g. as the TV itself
  '127.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '017700000001', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.256', '1.2.3.0x4', 'host.1', '1.2.3.4.',
  // IPv6 that is none
  ':::', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3', '12345::1', 'g::1', '::1.2.3', '::1.2.3.256', '1.2.3.4::', ':1', '1:', '::ffff:1.2.3.4:5',
  'x'.repeat(64) + '.lan', ('a'.repeat(60) + '.').repeat(5) + 'toolong', undefined, null, 5, {}, ['10.0.0.2']];

test('IPv4 addresses, IPv6 addresses and DNS names are addresses, and nothing else is', () => {
  const platform = loadUtils();
  const isServerAddress = platform.get('isServerAddress');
  IPV4_ADDRESSES.concat(IPV6_ADDRESSES, DNS_NAMES).forEach((address) => assert.equal(isServerAddress(address), true, address));
  NO_ADDRESSES.forEach((address) => assert.equal(isServerAddress(address), false, JSON.stringify(address)));

  // The three kinds, each by its own function
  const parseIpv4 = platform.get('parseIpv4Address');
  const parseIpv6 = platform.get('parseIpv6Address');
  const isDnsName = platform.get('isDnsName');
  assert.deepEqual(plain(parseIpv4('192.168.1.20')), [192, 168, 1, 20]);
  assert.deepEqual(plain(parseIpv4('192.168.001.020')), [192, 168, 1, 20]);
  IPV6_ADDRESSES.concat(DNS_NAMES).forEach((address) => assert.equal(parseIpv4(address), null, address));
  assert.deepEqual(plain(parseIpv6('fe80::1c2d:3eff:fe4f:5a6b')), [0xfe80, 0, 0, 0, 0x1c2d, 0x3eff, 0xfe4f, 0x5a6b]);
  assert.deepEqual(plain(parseIpv6('::')), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(plain(parseIpv6('::1')), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(plain(parseIpv6('1::')), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(plain(parseIpv6('::ffff:192.168.1.20')), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0114]);
  assert.deepEqual(plain(parseIpv6('1:2:3:4:5:6:7:8')), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(plain(parseIpv6('1:2:3:4:5:6:1.2.3.4')), [1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
  IPV4_ADDRESSES.concat(DNS_NAMES).forEach((address) => assert.equal(parseIpv6(address), null, address));
  DNS_NAMES.forEach((name) => assert.equal(isDnsName(name), true, name));
  IPV4_ADDRESSES.concat(IPV6_ADDRESSES).forEach((address) => assert.equal(isDnsName(address), false, address));
});

test('every address that the Add PC dialog takes is an address, except a name that ends in a number or is longer than a DNS name', () => {
  const app = loadPlatformScripts(['wasm/platform/tv_profile.js', 'wasm/platform/index.js', 'wasm/static/js/utils.js'], { tv: { tv: 's90c', conn: 'wifi' } });
  const isValidHostAddress = app.get('isValidHostAddress');
  const isServerAddress = app.get('isServerAddress');
  const samples = IPV4_ADDRESSES.concat(IPV6_ADDRESSES, DNS_NAMES, NO_ADDRESSES.filter((address) => typeof address === 'string'),
    ['192.168.1.5', '0.0.0.0', '127.0.0.1', '::1', '::', 'fe80::1', 'sunshine', 'my-pc.fritz.box', 'a-b.c-d.e', 'PC', '10.0.0.2.nip.io']);
  let taken = 0;
  samples.forEach((address) => {
    if (!isValidHostAddress(address)) {
      return;
    }
    taken++;
    // A name whose last label is a number and that is no IPv4 address in its usual spelling
    const endsInNumber = address.indexOf(':') < 0 && /^(\d+|0[xX][0-9A-Fa-f]*)$/.test(address.slice(address.lastIndexOf('.') + 1)) &&
      app.get('parseIpv4Address')(address) === null;
    // A label of more than 63 characters, or more than 253 in all, which no DNS server answers
    const tooLong = address.length > 253 || address.split('.').some((label) => label.length > 63);
    assert.equal(isServerAddress(address), !endsInNumber && !tooLong, address);
  });
  // The comparison saw addresses of every kind, and the names that the dialog takes and a poll doesn't ask
  assert.ok(taken >= 30, String(taken));
  ['127.1', '2130706433', '1.2.3', 'host.1', '256.1.1.1'].forEach((address) => {
    assert.deepEqual([isValidHostAddress(address), isServerAddress(address)], [true, false], address);
  });
});

test('the TV itself in every spelling: loopback, the unspecified address, inside an IPv6 address, localhost', () => {
  const platform = loadUtils();
  const isOwn = platform.get('isOwnMachineAddress');
  ['127.0.0.1', '127.1.2.3', '127.255.255.255', '127.000.000.001', '0.0.0.0', '000.000.000.000', '::1', '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001', '::0001', '0::1', '::', '0:0:0:0:0:0:0:0', '::0', '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001',
    '0:0:0:0:0:ffff:127.0.0.1', '::ffff:0.0.0.0', '::ffff:0:0', '::127.0.0.1', '::7f00:1', 'localhost', 'LOCALHOST', 'LocalHost', 'tv.localhost',
    'a.b.localhost'].forEach((address) => assert.equal(isOwn(address), true, address));
  ['192.168.1.20', '10.0.0.2', '126.255.255.255', '128.0.0.1', '1.127.0.1', '0.0.0.1', '1.0.0.0', '::2', '1::', 'fe80::1', '::ffff:192.168.1.20',
    '::ffff:126.0.0.1', '2001:db8::7f00:1', '1::7f00:1', '::ffff:0:7f00:1', 'gaming-pc', 'localhost.lan', 'notlocalhost', 'mylocalhost', 'local', '',
    undefined, null].forEach((address) => assert.equal(isOwn(address), false, String(address)));
  // What the check knew before: these spellings of the TV itself went into the poll
  const before = (address) => address === '127.0.0.1' || address === '::1' || address.startsWith('127.') || address === 'localhost';
  ['0.0.0.0', '::', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1'].forEach((address) => assert.equal(before(address), false, address));
});

test('a poll tries the address, the name with .local, the local, the external and the entered address, each once, and nothing that is no address', () => {
  const platform = loadUtils();
  const candidates = (host) => plain(platform.get('getServerAddressCandidates')(host));
  // The order of a host as it is stored
  assert.deepEqual(candidates({ address: '192.168.1.20', hostname: 'GAMING-PC', localAddress: '192.168.1.21', externalIP: '203.0.113.7', userEnteredAddress: 'pc.lan' }),
    ['192.168.1.20', 'GAMING-PC.local', '192.168.1.21', '203.0.113.7', 'pc.lan']);
  // Each one once, and no empty one
  assert.deepEqual(candidates({ address: '192.168.1.20', hostname: 'gaming-pc.local', localAddress: '192.168.1.20', externalIP: '', userEnteredAddress: '192.168.1.20' }),
    ['192.168.1.20', 'gaming-pc.local']);
  // A new host is named after its address, which gets no '.local': the name must be a DNS name
  assert.deepEqual(candidates({ address: '10.0.0.66', hostname: '10.0.0.66', localAddress: '', externalIP: '', userEnteredAddress: '' }), ['10.0.0.66']);
  assert.deepEqual(candidates({ address: 'fe80::1', hostname: 'fe80::1', localAddress: '', externalIP: '', userEnteredAddress: 'fe80::1' }), ['fe80::1']);
  ['Living Room PC', 'Büro-PC', 'evil.example/x?', 'a/../b', 'PC@home', '', '..'].forEach((hostname) => {
    assert.deepEqual(candidates({ address: '10.0.0.2', hostname, localAddress: '', externalIP: '', userEnteredAddress: '' }), ['10.0.0.2'], hostname);
    assert.equal(platform.get('getLocalNameCandidate')(hostname), '', hostname);
  });
  assert.equal(platform.get('getLocalNameCandidate')('GAMING-PC'), 'GAMING-PC.local');
  assert.equal(platform.get('getLocalNameCandidate')('Gaming-PC.LOCAL'), 'Gaming-PC.LOCAL');
  // Nothing that is no address, from whatever field, and never the TV itself
  assert.deepEqual(candidates({ address: 'evil.example/x?', hostname: 'PC', localAddress: 'evil.example:8080/', externalIP: 'user@evil.example', userEnteredAddress: '10.0.0.2/x' }),
    ['PC.local']);
  assert.deepEqual(candidates({ address: '10.0.0.2', hostname: 'PC', localAddress: '127.0.0.1', externalIP: '::ffff:127.0.0.1', userEnteredAddress: '0.0.0.0' }),
    ['10.0.0.2', 'PC.local']);
  assert.deepEqual(candidates({ address: 'localhost', hostname: 'PC.localhost', localAddress: 'tv.localhost', externalIP: '', userEnteredAddress: '' }), ['PC.localhost.local']);
  assert.deepEqual(candidates({ address: '::1', hostname: 'PC', localAddress: '0:0:0:0:0:0:0:1', externalIP: '::', userEnteredAddress: '2130706433' }), ['PC.local']);
  // A name that every object has as a property is an address like any other name (the list was an object before)
  assert.deepEqual(candidates({ address: 'constructor', hostname: 'toString', localAddress: '', externalIP: '', userEnteredAddress: '' }),
    ['constructor', 'toString.local']);
});

test('a server info can\'t send the next poll to another host and path', async () => {
  const platform = loadUtils();
  const hostile = parseOne(platform, { hostname: 'evil.example/x?', LocalIP: 'evil.example/x?', ExternalIP: 'evil.example:8080/y#' });
  assert.deepEqual(hostile.parsed, [true]);
  // The host is listed, under its name, without the two addresses
  assert.deepEqual([hostile.hostname, hostile.localAddress, hostile.externalIP], ['evil.example/x?', '', '']);
  assert.deepEqual(hostile.candidates, ['192.168.1.20']);

  // The poll itself asks the address of the host and nothing else, also for a host that 2.3.0 stored with such values
  platform.requests.length = 0;
  const online = await platform.run(`new Promise(function(resolve) {
    window.isInGame = false;
    var host = new NvHTTP('192.168.1.20', 'CLIENT');
    host.httpPort = 47989;
    host.hostname = 'evil.example/x?';
    host.localAddress = 'evil.example/x?';
    host.externalIP = 'evil.example:8080/y#';
    host.userEnteredAddress = 'user@evil.example';
    host.pollServer(function(polled) { resolve(polled.online); });
  })`);
  assert.equal(online, false);
  assert.ok(platform.requests.length >= 1);
  platform.requests.forEach((url) => assert.match(url, /^(fetch )?http:\/\/192\.168\.1\.20:47989\/serverinfo\?/, url));

  // An address that is none isn't asked at all, e.g. the stored address of a host
  platform.requests.length = 0;
  for (const address of ['evil.example/x?', '10.0.0.2:1/x?', '', undefined]) {
    platform.context.__address = address;
    await assert.rejects(platform.run('new NvHTTP("192.168.1.20", "CLIENT").refreshServerInfoAtAddress(__address)'), /is no address/);
  }
  assert.deepEqual(platform.requests, []);
  // The local address and the external address of ordinary hosts are kept
  const ordinary = parseOne(platform, { LocalIP: 'fe80::1c2d:3eff:fe4f:5a6b', ExternalIP: '203.0.113.7' });
  assert.deepEqual([ordinary.localAddress, ordinary.externalIP], ['fe80::1c2d:3eff:fe4f:5a6b', '203.0.113.7']);
  assert.deepEqual(ordinary.candidates, ['192.168.1.20', 'GAMING-PC.local', 'fe80::1c2d:3eff:fe4f:5a6b', '203.0.113.7']);
  // An address of the TV itself is kept as what the host reported, and not asked
  const loopback = parseOne(platform, { LocalIP: '127.0.0.1' });
  assert.deepEqual([loopback.localAddress, loopback.candidates], ['127.0.0.1', ['192.168.1.20', 'GAMING-PC.local']]);
});

test('a port is a whole number from 1 to 65535', () => {
  const platform = loadUtils();
  const parsePort = platform.get('parsePort');
  const isPortNumber = platform.get('isPortNumber');
  [['47984', 47984], ['1', 1], ['65535', 65535], [' 47984\n', 47984], ['00080', 80], [47989, 47989]].forEach(([text, port]) => {
    assert.equal(parsePort(text), port, JSON.stringify(text));
  });
  ['', ' ', '0', '65536', '99999', '100000', '-1', '+1', '47984abc', 'abc', '4798.4', '4,798', '0x50', '1e3', '47984 47984', 'NaN', undefined, null].forEach((text) => {
    assert.equal(parsePort(text), 0, JSON.stringify(text));
  });
  [1, 80, 47984, 65535].forEach((port) => assert.equal(isPortNumber(port), true, String(port)));
  [0, -1, 65536, 1.5, NaN, Infinity, '47984', null, undefined].forEach((port) => assert.equal(isPortNumber(port), false, String(port)));
  assert.deepEqual([platform.get('DEFAULT_HTTP_PORT'), platform.get('DEFAULT_HTTPS_PORT')], [47989, 47984]);
});

test('a server info without an HTTPS port, or with a bad one, keeps the port of the host, or the default port: never NaN', () => {
  const platform = loadUtils();
  const without = (name) => {
    const fields = Object.assign({}, BASE);
    delete fields[name];
    return serverInfo(fields);
  };
  // A new host, e.g. from the Add PC dialog: the default port
  for (const answer of [without('HttpsPort'), serverInfo(Object.assign({}, BASE, { HttpsPort: '' })), serverInfo(Object.assign({}, BASE, { HttpsPort: 'abc' })),
    serverInfo(Object.assign({}, BASE, { HttpsPort: '0' })), serverInfo(Object.assign({}, BASE, { HttpsPort: '70000' })),
    serverInfo(Object.assign({}, BASE, { HttpsPort: '47984/x' })), serverInfo(Object.assign({}, BASE, { xml: '<HttpsPort>1</HttpsPort>' }))]) {
    const result = parseWith(platform, [answer]);
    assert.deepEqual([result.parsed, result.httpsPort], [[true], 47984], answer);
    // What the app stores of the host (NaN is stored as null)
    assert.deepEqual([JSON.parse(result.json).httpsPort, JSON.parse(result.json).externalPort], [47984, 47989], answer);
  }
  // A host with a port of its own keeps it for an answer without one, and takes a new one
  assert.equal(parseWith(platform, [serverInfo(Object.assign({}, BASE, { HttpsPort: '48984' })), without('HttpsPort')]).httpsPort, 48984);
  assert.equal(parseWith(platform, [serverInfo(Object.assign({}, BASE, { HttpsPort: 'x' }))], 'host.httpsPort = 48984;').httpsPort, 48984);
  assert.equal(parseWith(platform, [without('HttpsPort'), serverInfo(Object.assign({}, BASE, { HttpsPort: '48984' }))]).httpsPort, 48984);
  // What a host that 2.3.0 polled without the element had: NaN, stored as null
  assert.equal(parseWith(platform, [without('HttpsPort')], 'host.httpsPort = NaN;').httpsPort, 47984);

  // The external port, which the app only shows: the one of the answer, else the one before, else the HTTP port
  assert.equal(parseOne(platform, { ExternalPort: '48000' }).externalPort, 48000);
  assert.equal(parseWith(platform, [without('ExternalPort')]).externalPort, 47989);
  assert.equal(parseWith(platform, [without('ExternalPort')], 'host.httpPort = 48989;').externalPort, 48989);
  assert.equal(parseWith(platform, [serverInfo(Object.assign({}, BASE, { ExternalPort: '48000' })), without('ExternalPort')]).externalPort, 48000);
  assert.equal(parseOne(platform, { ExternalPort: 'NaN' }, 'host.externalPort = NaN;').externalPort, 47989);
});

test('the request that looks whether an address answers rewrites only an https:// URL to the HTTPS port right after the host', () => {
  const platform = loadUtils();
  const preflight = platform.get('getPreflightUrl');
  // The server info over HTTPS: the same host over plain HTTP
  assert.equal(preflight('https://192.168.1.20:47984/serverinfo?uniqueid=1&uuid=2', 47984, 47989), 'http://192.168.1.20:47989/serverinfo');
  assert.equal(preflight('https://gaming-pc.local:47984/applist?uniqueid=1', 47984, 47989), 'http://gaming-pc.local:47989/serverinfo');
  assert.equal(preflight('https://[fe80::1c2d:3eff:fe4f:5a6b]:47984/serverinfo?uniqueid=1', 47984, 47989), 'http://[fe80::1c2d:3eff:fe4f:5a6b]:47989/serverinfo');
  assert.equal(preflight('https://10.0.0.2:48984', 48984, 48989), 'http://10.0.0.2:48989/serverinfo');
  // Anything else as it is
  const unchanged = [
    // Plain HTTP, also when the HTTP port holds the digits of the HTTPS port or the HTTPS port stands in the query
    ['http://192.168.1.20:47989/serverinfo?uniqueid=1', 47984, 47989],
    ['http://192.168.1.20:47984/serverinfo', 47984, 47989],
    ['http://192.168.1.20:4798/serverinfo', 4798, 47989],
    ['http://192.168.1.20:47989/serverinfo?x=:47984', 47984, 47989],
    // Another port than the HTTPS port of the host
    ['https://192.168.1.20:47985/serverinfo', 47984, 47989],
    ['https://192.168.1.20:479840/serverinfo', 47984, 47989],
    ['https://192.168.1.20/serverinfo?p=:47984', 47984, 47989],
    // The port inside an IPv6 address, which the search anywhere in the URL took for the HTTPS port
    ['https://[fe80::4798:1]:1234/serverinfo', 4798, 47989],
    ['https://[2001:db8:47984::1]:1234/serverinfo', 47984, 47989],
    // A host without a port of its own (NaN before 2.3.1)
    ['https://192.168.1.20:47984/serverinfo', NaN, 47989],
    ['https://192.168.1.20:47984/serverinfo', 47984, 0],
    ['https://192.168.1.20:NaN/serverinfo', NaN, 47989],
    // No host this function knows
    ['https://user:47984@evil.example/serverinfo', 47984, 47989],
    ['ftp://192.168.1.20:47984/serverinfo', 47984, 47989],
  ];
  unchanged.forEach(([url, httpsPort, httpPort]) => assert.equal(preflight(url, httpsPort, httpPort), url, url));
  // What the search anywhere in the URL made of two of them
  const before = (url, httpsPort, httpPort) => {
    const portIndex = url.indexOf(':' + httpsPort);
    return portIndex !== -1 ? url.substring(0, portIndex).replace('https://', 'http://') + ':' + httpPort + '/serverinfo' : url;
  };
  assert.equal(before('https://[fe80::4798:1]:1234/serverinfo', 4798, 47989), 'http://[fe80::47989/serverinfo');
  assert.equal(before('http://192.168.1.20:47989/serverinfo?x=:47984', 47984, 47989), 'http://192.168.1.20:47989/serverinfo?x=:47989/serverinfo');
  // _openUrlWithTimeout() uses it
  assert.match(read('wasm/static/js/utils.js'), /var preflightUrl = getPreflightUrl\(url, this\.httpsPort, this\.httpPort\);/);
});

test('a MAC address is six pairs of hexadecimal digits, and anything else leaves the one of the host', () => {
  const platform = loadUtils();
  const isMac = platform.get('isMacAddress');
  ['00:11:22:33:44:55', 'a8:a1:59:12:ab:cd', 'A8:A1:59:12:AB:CD', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'].forEach((mac) => assert.equal(isMac(mac), true, mac));
  ['', '00:11:22:33:44', '00:11:22:33:44:55:66', '00-11-22-33-44-55', '001122334455', '0:1:2:3:4:5', '00:11:22:33:44:5g', '00:11:22:33:44:55 ', ' 00:11:22:33:44:55',
    '00:11:22:33:44:55\n', '00:11:22:33:44:55;rm', '<script>', 'x'.repeat(1000), undefined, null, 5].forEach((mac) => assert.equal(isMac(mac), false, String(mac).slice(0, 40)));

  assert.equal(parseOne(platform, { mac: 'A8:A1:59:12:AB:CD' }).macAddress, 'A8:A1:59:12:AB:CD');
  assert.equal(parseOne(platform, { mac: ' a8:a1:59:12:ab:cd\n' }).macAddress, 'a8:a1:59:12:ab:cd');
  // A host without one yet stays without, and a host with one keeps it
  ['x'.repeat(1000), '00:11:22:33:44', 'evil', ''].forEach((mac) => {
    assert.equal(parseOne(platform, { mac }).macAddress, null, mac.slice(0, 20));
    assert.equal(parseOne(platform, { mac }, 'host.macAddress = "a8:a1:59:12:ab:cd";').macAddress, 'a8:a1:59:12:ab:cd', mac.slice(0, 20));
  });
});

test('the texts are kept without control characters and up to a length that every real host stays below', () => {
  const platform = loadUtils();
  const clean = platform.get('cleanServerText');
  // The names of hosts stay as their users chose them, in every script and with every sign
  ['GAMING-PC', 'DESKTOP-4F7K2QX', 'Living Room PC', 'Büro-PC', 'ゲーミングPC', 'Игровой ПК', 'Kid\'s PC (4090) & more <fast>', 'מחשב', 'a'.repeat(64)].forEach((name) => {
    assert.equal(clean(name, 64), name, name);
  });
  assert.equal(clean('  GAMING-PC \n', 64), 'GAMING-PC');
  // Line breaks, tabs and the characters that turn the reading direction around become one space
  assert.equal(clean('GAMING\r\nPC', 64), 'GAMING PC');
  assert.equal(clean('GAMING\tPC\u0000\u0007', 64), 'GAMING PC');
  assert.equal(clean('\u202eCP-GNIMAG\u202c\u2066x\u2069\u2028y\u2029', 64), 'CP-GNIMAG x y');
  assert.equal(clean('a\u007f\u0080\u009fb', 64), 'a b');
  // Cut to the length, not in the middle of a character of two units, and without a space at the end
  assert.equal(clean('a'.repeat(65), 64), 'a'.repeat(64));
  assert.equal(clean('a'.repeat(100000), 64).length, 64);
  assert.equal(clean('a'.repeat(63) + '😀', 64), 'a'.repeat(63));
  assert.equal(clean('a'.repeat(62) + '😀', 64), 'a'.repeat(62) + '😀');
  assert.equal(clean('a'.repeat(63) + ' b', 64), 'a'.repeat(63));
  [undefined, null, ''].forEach((text) => assert.equal(clean(text, 64), ''));
  assert.deepEqual([platform.get('SERVER_NAME_MAX_LENGTH'), platform.get('SERVER_TEXT_MAX_LENGTH'), platform.get('SERVER_VERSION_MAX_LENGTH')], [64, 64, 32]);

  // Through the server info: every text of a host that sends megabytes is cut, and the host is listed
  const long = 'x'.repeat(200000);
  const flooded = parseOne(platform, { hostname: long, appversion: '7.1.431.-1' + long, GfeVersion: long, gputype: long, numofapps: long,
    state: 'SUNSHINE_SERVER_BUSY' + long });
  assert.deepEqual(flooded.parsed, [true]);
  assert.deepEqual([flooded.hostname.length, flooded.appVersion.length, flooded.gfeVersion.length, flooded.gputype.length, flooded.numofapps.length,
    flooded.serverState.length], [64, 32, 32, 64, 32, 64]);
  assert.ok(flooded.json.length < 2000, String(flooded.json.length));
  assert.equal(flooded.serverMajorVersion, 7);
  // A name of nothing but control characters is no name
  assert.equal(parseOne(platform, { hostname: '\n\t ' }).hostname, 'UNKNOWN');
  assert.equal(parseOne(platform, { hostname: 'GAMING\nPC' }).hostname, 'GAMING PC');
});

test('display modes are positive numbers within limits, and at most so many of them', () => {
  const platform = loadUtils();
  const parse = (entries) => plain(platform.get('parseDisplayModes')(entries));
  const mode = (width, height, refreshRate) => ({ width: String(width), height: String(height), refreshRate: String(refreshRate) });
  assert.deepEqual(parse([mode(1920, 1080, 60), mode(1920, 1080, 120), mode(3840, 2160, 60), mode(1920, 1080, 60), mode(' 2560 ', '1440\n', '144')]),
    { '1080:1920': [60, 120], '2160:3840': [60], '1440:2560': [144] });
  // A refresh rate with a fraction counts by its whole part, as before
  assert.deepEqual(parse([mode(1920, 1080, '59.94'), mode(1920, 1080, '119.88')]), { '1080:1920': [59, 119] });
  // Entries with a value that is no positive number within the limits are left out: never 'NaN:NaN'
  const bad = [mode('', '', ''), mode('abc', 1080, 60), mode(1920, 'abc', 60), mode(1920, 1080, 'abc'), mode(0, 1080, 60), mode(1920, 0, 60), mode(1920, 1080, 0),
    mode(-1920, 1080, 60), mode(1920, 1080, -60), mode(32768, 1080, 60), mode(1920, 32768, 60), mode(1920, 1080, 1001), mode('1920px', 1080, 60),
    mode('1e3', 1080, 60), mode('0x780', 1080, 60), mode('NaN', 'NaN', 'NaN'), mode('__proto__', 'constructor', 60), mode(1920, '1080:1', 60),
    { width: undefined, height: null, refreshRate: undefined }, {}];
  assert.deepEqual(parse(bad), {});
  assert.deepEqual(parse(bad.concat([mode(32767, 32767, 1000), mode(1, 1, 1)])), { '32767:32767': [1000], '1:1': [1] });
  assert.deepEqual(parse([]), {});
  assert.deepEqual(parse(undefined), {});
  // The limits: entries read, resolutions and refresh rates per resolution
  const limits = ['DISPLAY_MODE_MAX_ENTRIES', 'DISPLAY_MODE_MAX_RESOLUTIONS', 'DISPLAY_MODE_MAX_RATES', 'DISPLAY_MODE_MAX_SIZE', 'DISPLAY_MODE_MAX_RATE'].map((name) => platform.get(name));
  assert.deepEqual(limits, [1024, 128, 32, 32767, 1000]);
  const manyRates = parse(Array.from({ length: 500 }, (unused, index) => mode(1920, 1080, index + 1)));
  assert.equal(manyRates['1080:1920'].length, 32);
  const manyResolutions = parse(Array.from({ length: 500 }, (unused, index) => mode(1000 + index, 1080, 60)));
  assert.equal(Object.keys(manyResolutions).length, 128);
  // A resolution that is kept still takes rates once the limit of the resolutions is reached
  const full = parse(Array.from({ length: 200 }, (unused, index) => mode(1000 + index, 1080, 60)).concat([mode(1000, 1080, 120), mode(5000, 1080, 60)]));
  assert.deepEqual([Object.keys(full).length, full['1080:1000'], full['1080:5000']], [128, [60, 120], undefined]);
  const manyEntries = parse(Array.from({ length: 1030 }, (unused, index) => mode(1920, 1080, 60)).concat([mode(3840, 2160, 60)]));
  assert.deepEqual(manyEntries, { '1080:1920': [60] });
  // Whatever a server info sends, what the app keeps of its display modes stays small
  const worst = parse(Array.from({ length: 5000 }, (unused, index) => mode(1 + (index % 300), 1 + (index % 7), 1 + (index % 900))));
  assert.ok(JSON.stringify(worst).length < 128 * (16 + 32 * 5), String(JSON.stringify(worst).length));
});

test('the display modes of one server info replace the ones of the one before', () => {
  const platform = loadUtils();
  const first = serverInfo(Object.assign({}, BASE, { xml: displayModes([[1920, 1080, 60], [1920, 1080, 120], [3840, 2160, 60]]) }));
  const second = serverInfo(Object.assign({}, BASE, { xml: displayModes([[2560, 1440, 144], ['x', 'y', 'z'], ['', '', '']]) }));
  const none = serverInfo(BASE);
  assert.deepEqual(parseWith(platform, [first]).supportedDisplayModes, { '1080:1920': [60, 120], '2160:3840': [60] });
  // Before, the second answer added to the first, with 'NaN:NaN' for its two entries without numbers
  assert.deepEqual(parseWith(platform, [first, second]).supportedDisplayModes, { '1440:2560': [144] });
  assert.deepEqual(parseWith(platform, [first, first, first]).supportedDisplayModes, { '1080:1920': [60, 120], '2160:3840': [60] });
  assert.deepEqual(parseWith(platform, [first, none]).supportedDisplayModes, {});
  // What 2.3.0 stored of a host goes with its next answer
  assert.deepEqual(parseWith(platform, [second], 'host.supportedDisplayModes = { "NaN:NaN": [null], "1080:1920": [60] };').supportedDisplayModes, { '1440:2560': [144] });
  // The one use of the display modes still reads them: Optimize game settings for GeForce Experience (index.js)
  const index = read('wasm/platform/index.js');
  assert.match(index, /const displayModes = host\.supportedDisplayModes \|\| \{\};/);
  assert.match(index, /Object\.prototype\.hasOwnProperty\.call\(displayModes, streamHeight \+ ':' \+ streamWidth\)/);
  assert.deepEqual((index + read('wasm/platform/menus.js') + read('wasm/platform/navigation.js') + read('wasm/platform/launcher.js')).match(/supportedDisplayModes/g), ['supportedDisplayModes']);
});

// Answers in the form of the three kinds of hosts. Sunshine and Apollo answer a client that isn't paired over HTTP with
// a MAC address of zeros and without the running app; GeForce Experience names its GPU and has no external port.
const SUNSHINE_MODES = [[1280, 720, 30], [1280, 720, 60], [1280, 720, 120], [1920, 1080, 30], [1920, 1080, 60], [1920, 1080, 120], [2560, 1440, 60],
  [2560, 1440, 120], [3840, 2160, 60], [3840, 2160, 120]];
const REAL_ANSWERS = {
  'Sunshine, paired, over HTTPS': {
    answer: '<?xml version="1.0" encoding="utf-8"?>\n<root status_code="200"><hostname>GAMING-PC</hostname><appversion>7.1.431.-1</appversion>' +
      '<GfeVersion>3.23.0.74</GfeVersion><uniqueid>F3E2D1C0-B9A8-4765-8432-10FEDCBA9876</uniqueid><HttpsPort>47984</HttpsPort><ExternalPort>47989</ExternalPort>' +
      '<MaxLumaPixelsHEVC>1869449984</MaxLumaPixelsHEVC><mac>a8:a1:59:12:ab:cd</mac><LocalIP>192.168.1.20</LocalIP><ServerCodecModeSupport>3843</ServerCodecModeSupport>' +
      displayModes(SUNSHINE_MODES) + '<PairStatus>1</PairStatus><currentgame>881448767</currentgame><state>SUNSHINE_SERVER_BUSY</state></root>',
    expected: { hostname: 'GAMING-PC', serverUid: 'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876', localAddress: '192.168.1.20', externalIP: '', macAddress: 'a8:a1:59:12:ab:cd',
      httpsPort: 47984, externalPort: 47989, paired: true, appVersion: '7.1.431.-1', gfeVersion: '3.23.0.74', serverMajorVersion: 7, gputype: '', numofapps: '',
      serverState: 'SUNSHINE_SERVER_BUSY', isNvidiaServerSoftware: false, currentGame: 881448767, serverCodecModeSupport: 3843,
      supportedDisplayModes: { '720:1280': [30, 60, 120], '1080:1920': [30, 60, 120], '1440:2560': [60, 120], '2160:3840': [60, 120] } },
  },
  'Sunshine on other ports, not paired, over HTTP': {
    answer: '<?xml version="1.0" encoding="utf-8"?>\n<root status_code="200"><hostname>Living Room PC</hostname><appversion>7.1.431.-1</appversion>' +
      '<GfeVersion>3.23.0.74</GfeVersion><uniqueid>0A1B2C3D-4E5F-4071-8293-A4B5C6D7E8F9</uniqueid><HttpsPort>48984</HttpsPort><ExternalPort>48989</ExternalPort>' +
      '<MaxLumaPixelsHEVC>1869449984</MaxLumaPixelsHEVC><mac>00:00:00:00:00:00</mac><LocalIP>fd00::1c2d:3eff:fe4f:5a6b</LocalIP>' +
      '<ServerCodecModeSupport>197377</ServerCodecModeSupport><PairStatus>0</PairStatus><currentgame>0</currentgame><state>SUNSHINE_SERVER_FREE</state></root>',
    expected: { hostname: 'Living Room PC', serverUid: '0A1B2C3D-4E5F-4071-8293-A4B5C6D7E8F9', localAddress: 'fd00::1c2d:3eff:fe4f:5a6b', externalIP: '',
      macAddress: '00:00:00:00:00:00', httpsPort: 48984, externalPort: 48989, paired: false, appVersion: '7.1.431.-1', gfeVersion: '3.23.0.74', serverMajorVersion: 7,
      gputype: '', numofapps: '', serverState: 'SUNSHINE_SERVER_FREE', isNvidiaServerSoftware: false, currentGame: 0, serverCodecModeSupport: 197377,
      supportedDisplayModes: {} },
  },
  'Apollo, paired, with its own elements': {
    answer: '<?xml version="1.0" encoding="utf-8"?>\n<root status_code="200"><hostname>ゲーミングPC</hostname><appversion>7.1.431.-1</appversion>' +
      '<GfeVersion>3.23.0.74</GfeVersion><uniqueid>9C8B7A6D-5E4F-4321-8765-0FEDCBA98765</uniqueid><HttpsPort>47984</HttpsPort><ExternalPort>47989</ExternalPort>' +
      '<MaxLumaPixelsHEVC>1869449984</MaxLumaPixelsHEVC><mac>3c:7c:3f:12:ab:cd</mac><Permission>4294967295</Permission><VirtualDisplayCapable>true</VirtualDisplayCapable>' +
      '<VirtualDisplayDriverReady>true</VirtualDisplayDriverReady><LocalIP>10.0.0.5</LocalIP><ServerCodecModeSupport>3843</ServerCodecModeSupport>' +
      displayModes([[1920, 1080, 60], [3840, 2160, 60]]) + '<PairStatus>1</PairStatus><currentgame>0</currentgame><currentgameuuid></currentgameuuid>' +
      '<state>SUNSHINE_SERVER_FREE</state></root>',
    expected: { hostname: 'ゲーミングPC', serverUid: '9C8B7A6D-5E4F-4321-8765-0FEDCBA98765', localAddress: '10.0.0.5', externalIP: '', macAddress: '3c:7c:3f:12:ab:cd',
      httpsPort: 47984, externalPort: 47989, paired: true, appVersion: '7.1.431.-1', gfeVersion: '3.23.0.74', serverMajorVersion: 7, gputype: '', numofapps: '',
      serverState: 'SUNSHINE_SERVER_FREE', isNvidiaServerSoftware: false, currentGame: 0, serverCodecModeSupport: 3843,
      supportedDisplayModes: { '1080:1920': [60], '2160:3840': [60] } },
  },
  'GeForce Experience, paired': {
    answer: '<?xml version="1.0" encoding="UTF-16"?>\n<root protocol_version="0.1" query="serverinfo" status_code="200" status_message="OK">' +
      '<hostname>DESKTOP-4F7K2QX</hostname><appversion>7.1.431.0</appversion><GfeVersion>3.23.0.74</GfeVersion><uniqueid>A1B2C3D4E5F60718</uniqueid>' +
      '<HttpsPort>47984</HttpsPort><ExternalIP>203.0.113.7</ExternalIP><mac>A8:A1:59:12:AB:CD</mac><MaxLumaPixelsH264>0</MaxLumaPixelsH264>' +
      '<MaxLumaPixelsHEVC>1869449984</MaxLumaPixelsHEVC><LocalIP>192.168.1.30</LocalIP><ServerCodecModeSupport>771</ServerCodecModeSupport>' +
      displayModes([[2560, 1440, 144], [2560, 1440, 120], [2560, 1440, 60], [1920, 1080, 144], [1920, 1080, 60], [1280, 720, 60]]) +
      '<PairStatus>1</PairStatus><currentgame>0</currentgame><state>MJOLNIR_STATE_SERVER_FREE</state><gputype>NVIDIA GeForce RTX 4070 Ti SUPER</gputype>' +
      '<numofapps>12</numofapps><ServerCapability>1</ServerCapability></root>',
    expected: { hostname: 'DESKTOP-4F7K2QX', serverUid: 'A1B2C3D4E5F60718', localAddress: '192.168.1.30', externalIP: '203.0.113.7', macAddress: 'A8:A1:59:12:AB:CD',
      httpsPort: 47984, externalPort: 47989, paired: true, appVersion: '7.1.431.0', gfeVersion: '3.23.0.74', serverMajorVersion: 7,
      gputype: 'NVIDIA GeForce RTX 4070 Ti SUPER', numofapps: '12', serverState: 'MJOLNIR_STATE_SERVER_FREE', isNvidiaServerSoftware: true, currentGame: 0,
      serverCodecModeSupport: 771, supportedDisplayModes: { '1440:2560': [144, 120, 60], '1080:1920': [144, 60], '720:1280': [60] } },
  },
};

test('the answers of Sunshine, Apollo and GeForce Experience are kept as they are', () => {
  const platform = loadUtils();
  Object.keys(REAL_ANSWERS).forEach((name) => {
    // As the scan of the network asks a new host
    const result = parseWith(platform, [REAL_ANSWERS[name].answer], 'host.httpPort = 47989; host.httpsPort = 47984;');
    assert.deepEqual(result.parsed, [true], name);
    Object.keys(REAL_ANSWERS[name].expected).forEach((field) => {
      assert.deepEqual(result[field], REAL_ANSWERS[name].expected[field], name + ': ' + field);
    });
    // Every address of the answer is one that the next poll asks
    const expected = REAL_ANSWERS[name].expected;
    const localName = platform.get('getLocalNameCandidate')(expected.hostname);
    const addresses = ['192.168.1.20'].concat(localName ? [localName] : [], [expected.localAddress], expected.externalIP ? [expected.externalIP] : []);
    assert.deepEqual(result.candidates, addresses.filter((address, index) => addresses.indexOf(address) === index), name);
    // Nothing of it is NaN in what the app stores (NaN is stored as null; a host that isn't paired has no key yet)
    const stored = JSON.parse(result.json);
    assert.deepEqual(Object.keys(stored).filter((key) => stored[key] === null), ['ppkstr'], name);
  });
  // The answers of the tests themselves: the simulated host of the browser tests and the one of host-uid.test.js
  const simulated = read('tests/browser/mocks/sunshine-host.js');
  assert.match(simulated, /<HttpsPort>47984<\/HttpsPort><ExternalPort>47989<\/ExternalPort><mac>00:11:22:33:44:55<\/mac><LocalIP>10\.0\.0\.2<\/LocalIP>/);
  const ofTests = parseOne(platform, { hostname: 'GAMING-PC', uniqueid: 'HOST1', LocalIP: '10.0.0.2', ServerCodecModeSupport: '197377' });
  assert.deepEqual([ofTests.parsed, ofTests.hostname, ofTests.serverUid, ofTests.localAddress, ofTests.macAddress, ofTests.httpsPort, ofTests.externalPort],
    [[true], 'GAMING-PC', 'HOST1', '10.0.0.2', '00:11:22:33:44:55', 47984, 47989]);
});

test('_parseServerInfo() keeps each field by its rule', () => {
  const utils = read('wasm/static/js/utils.js');
  const body = utils.slice(utils.indexOf('  _parseServerInfo: function(xmlStr) {'), utils.indexOf('  getAppById: function(appId) {'));
  // No text of the answer goes into the host as it came: each one through its rule, or as a number or a comparison
  const kept = body.match(/this\.\w+ = [^;]+;/g) || [];
  const unchecked = kept.filter((line) => /\$root\.find\(/.test(line) && !/cleanServerText\(|parseInt\(|== 1;/.test(line));
  assert.deepEqual(unchecked, []);
  assert.match(body, /this\.localAddress = isServerAddress\(localAddress\) \? localAddress : '';/);
  assert.match(body, /if \(isServerAddress\(externIP\)\) \{/);
  assert.match(body, /if \(isMacAddress\(macAddr\)\) \{\s+this\.macAddress = macAddr;/);
  assert.match(body, /var httpsPort = parsePort\(\$root\.find\('HttpsPort'\)\.text\(\)\);/);
  assert.match(body, /this\.supportedDisplayModes = parseDisplayModes\(displayModes\);/);
  // The poll takes its addresses from the checked list, and the request for a server info checks its address
  assert.match(utils, /var candidates = getServerAddressCandidates\(this\);/);
  assert.match(utils, /refreshServerInfoAtAddress: function\(givenAddress\) \{[^}]*?if \(!isServerAddress\(givenAddress\)\) \{\s+return Promise\.reject\(/);
});
