'use strict';

// Pins the check of the unique ID of a host (isValidServerUid() of wasm/static/js/utils.js) and the places where an ID
// enters the app. The ID comes from the server info of any device that answers on the local network, unpaired and over
// plain HTTP, and the app uses it as a key of plain objects (the hosts, their polls, the Smart Hub tiles) and in the
// element IDs of the PC list. Up to 2.3.0 it was taken as it came: '__proto__' made the scan of the network write the
// addresses of the device into Object.prototype, after which every loop over the hosts found them and the PC list was
// broken until the app restarted, 'constructor' was taken for a known host, and an ID such as 'x,#main-content' matched
// other parts of the page as a selector. Now an ID is 1 to 64 letters, digits, dashes and underscores and not the name
// of a property that every object has, and anything else counts as a server info without an ID, which is ignored:
//  - _parseServerInfo() checks it before it keeps anything of the answer, with one line in the log. It runs here with a
//    stand-in for the XML parser of jQuery; tests/browser/hostile-host-id.test.js runs it in the page with the scan.
//  - The hosts that an earlier version stored are taken over only with such an ID (keepValidStoredHosts() of index.js).
//  - A lookup by an ID from outside the app (a deep link of a Smart Hub tile) finds hosts only (getHostByUid()).
// The IDs of real hosts pass: GeForce Experience, Sunshine and Apollo send hexadecimal digits, Sunshine and Apollo as
// a UUID with dashes, in upper case.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext, loadPlatformScripts, plain } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The unique IDs of real hosts, by their form
const REAL_IDS = [
  // A UUID in upper case, as Sunshine and Apollo send it
  'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876',
  '00000000-0000-0000-0000-000000000000',
  // The same in lower case (Wolf)
  'f3e2d1c0-b9a8-4765-8432-10fedcba9876',
  // Hexadecimal digits in upper case without dashes, 16 and 32 of them (GeForce Experience)
  '0123456789ABCDEF',
  'A1B2C3D4E5F60718293A4B5C6D7E8F90',
  // The IDs of the tests and of the simulated host
  'HOST1', '7A3F', 'A', 'test', 'host_2',
  // The longest ID
  'a'.repeat(64),
];

// IDs that the app must not take: the names of the properties that every object has, selectors, markup, other
// characters, nothing and too much
const OBJECT_NAMES = ['__proto__', 'constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'];
const HOSTILE_IDS = OBJECT_NAMES.concat([
  'x,#main-content', '#main-content', 'a b', 'a.b', 'a>b', 'a+b', 'a~b', 'a:hover', 'a[b]', '*',
  '<script>alert(1)</script>', '"', '\'', '`', 'a/b', 'a\\b', '../x', 'a%20b', 'a&b', 'a=b', 'a;b', 'a?b', 'a@b',
  'HOST1\u0000', 'IDä', '‮HOST1', '',
  'a'.repeat(65), 'A1B2C3D4-'.repeat(8),
]);

function loadUtils() {
  const platform = createPlatformContext({ globals: { crypto: webcrypto } });
  platform.load('wasm/static/js/utils.js');
  // A stand-in for $($.parseXML()) of jQuery, which the unit tests don't have, with what _parseServerInfo() reads:
  // attr() of the root element, and find(), text() and each() of the elements below it
  platform.run(`NvHTTP.prototype._parseXML = function(xml) {
    var decode = function(text) {
      return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    };
    var element = function(inner, tag) {
      return {
        attr: function(name) {
          var match = new RegExp('<root[^>]*\\\\s' + name + '="([^"]*)"').exec(tag);
          return match ? match[1] : undefined;
        },
        find: function(name) {
          var match = new RegExp('(<' + name + '(?:\\\\s[^>]*)?>)([\\\\s\\\\S]*?)</' + name + '>').exec(inner);
          return element(match ? match[2] : '', match ? match[1] : '');
        },
        text: function() {
          return decode(inner);
        },
        each: function() {},
      };
    };
    return element(xml, '');
  };`);
  return platform;
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The server info of a host with the given unique ID (null for an answer without the element)
function serverInfo(uniqueId) {
  return '<?xml version="1.0" encoding="utf-8"?><root status_code="200"><hostname>GAMING-PC</hostname>' +
    '<appversion>7.1.431.-1</appversion><GfeVersion>3.23.0.74</GfeVersion>' +
    (uniqueId === null ? '' : '<uniqueid>' + escapeXml(uniqueId) + '</uniqueid>') +
    '<HttpsPort>47984</HttpsPort><ExternalPort>47989</ExternalPort><mac>00:11:22:33:44:55</mac><LocalIP>10.0.0.66</LocalIP>' +
    '<ServerCodecModeSupport>197377</ServerCodecModeSupport><PairStatus>0</PairStatus><currentgame>0</currentgame>' +
    '<state>SUNSHINE_SERVER_FREE</state></root>';
}

// Parse the server info with the given unique ID as a new host at 10.0.0.66 does (the scan of the network, Add PC)
function parseAsNewHost(platform, uniqueId) {
  platform.context.__info = serverInfo(uniqueId);
  const before = platform.consoleMessages.length;
  const result = plain(platform.run(`(function() {
    var host = new NvHTTP('10.0.0.66', 'CLIENT');
    var parsed = host._parseServerInfo(__info);
    return { parsed: parsed, serverUid: host.serverUid, hostname: host.hostname, localAddress: host.localAddress, paired: host.paired,
      appVersion: host.appVersion };
  })()`));
  result.warnings = platform.consoleMessages.slice(before).filter((message) => message.level === 'warn').map((message) => message.text);
  return result;
}

test('the IDs of real hosts are taken: hexadecimal digits and UUIDs, in upper and lower case', () => {
  const platform = loadUtils();
  const isValid = platform.get('isValidServerUid');
  REAL_IDS.forEach((id) => {
    assert.equal(isValid(id), true, id);
    const result = parseAsNewHost(platform, id);
    assert.equal(result.parsed, true, id);
    assert.equal(result.serverUid, id);
    assert.equal(result.hostname, 'GAMING-PC');
    assert.equal(result.localAddress, '10.0.0.66');
    assert.deepEqual(result.warnings, [], id);
  });
  // The spaces around the ID in the XML are no part of it
  assert.equal(parseAsNewHost(platform, '  0123456789ABCDEF\n').serverUid, '0123456789ABCDEF');
});

test('the names of the properties of every object, selectors and other characters are no ID', () => {
  const platform = loadUtils();
  const isValid = platform.get('isValidServerUid');
  // Every name that an object of the page has, whatever the list above knows
  const inherited = plain(platform.run('Object.getOwnPropertyNames(Object.prototype)'));
  assert.ok(inherited.indexOf('__proto__') >= 0 && inherited.indexOf('constructor') >= 0 && inherited.length >= 12, inherited.join(' '));
  inherited.concat(HOSTILE_IDS).forEach((id) => assert.equal(isValid(id), false, JSON.stringify(id)));
  // A line break at the end doesn't pass as the end of the ID, and only a text is an ID
  ['HOST1\n', '\nHOST1', 'HOST1\r', 'HO\nST1', ' HOST1', 'HOST1 '].forEach((id) => assert.equal(isValid(id), false, JSON.stringify(id)));
  [undefined, null, 5, 0, true, {}, ['HOST1'], { toString: () => 'HOST1' }].forEach((id) => assert.equal(isValid(id), false, String(id)));
  // The pattern itself: 1 to 64 letters, digits, dashes and underscores
  assert.equal(String(platform.get('SERVER_UID_PATTERN')), '/^[A-Za-z0-9_-]{1,64}$/');
});

test('a server info with such an ID, or without one, is ignored with one line in the log, and nothing of it is kept', () => {
  const platform = loadUtils();
  HOSTILE_IDS.filter((id) => id.trim() === id && id.indexOf('\u0000') < 0).concat([null]).forEach((id) => {
    const result = parseAsNewHost(platform, id);
    const name = JSON.stringify(id);
    assert.equal(result.parsed, false, name);
    // The host object is as it was made: no ID, the address as its name, nothing of the answer
    assert.deepEqual([result.serverUid, result.hostname, result.localAddress, result.paired, result.appVersion], ['', '10.0.0.66', '', false, ''], name);
    assert.equal(result.warnings.length, 1, name + ': ' + result.warnings.join(' | '));
    assert.match(result.warnings[0], /Warning: Ignoring the server info of 10\.0\.0\.66: /, name);
    if (!id) {
      assert.match(result.warnings[0], /it has no unique ID\.$/);
    } else {
      // The length and the start of the ID as JSON, never the whole of a long one
      assert.ok(result.warnings[0].indexOf('its unique ID of ' + id.length + ' characters, starting with ' + JSON.stringify(id.slice(0, 24)) + ',') >= 0, result.warnings[0]);
      assert.equal(result.warnings[0].indexOf(id.length > 24 ? id : '\n'), -1, name);
    }
  });
  // Nothing was written into the objects of the page
  assert.deepEqual(plain(platform.run('Object.keys({})')), []);
  assert.deepEqual(plain(platform.run('(function() { var names = []; for (var name in {}) { names.push(name); } return names; })()')), []);
  assert.equal(platform.run('Object.prototype.hasOwnProperty.call(Object.prototype, "address")'), false);
});

test('a known host still answers only with its own ID, without a line for another one', () => {
  const platform = loadUtils();
  platform.context.__own = serverInfo('F3E2D1C0-B9A8-4765-8432-10FEDCBA9876');
  platform.context.__other = serverInfo('0123456789ABCDEF');
  platform.context.__hostile = serverInfo('__proto__');
  const before = platform.consoleMessages.length;
  const result = plain(platform.run(`(function() {
    var host = new NvHTTP('10.0.0.66', 'CLIENT');
    host.serverUid = 'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876';
    return [host._parseServerInfo(__own), host._parseServerInfo(__other), host._parseServerInfo(__hostile), host.serverUid];
  })()`));
  assert.deepEqual(result, [true, false, false, 'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876']);
  // The answer of another device at the address of a known host is silent as before (it comes with every poll)
  assert.deepEqual(platform.consoleMessages.slice(before).filter((message) => message.level === 'warn'), []);
});

test('_parseServerInfo() checks the ID before it keeps anything of the answer', () => {
  const utils = read('wasm/static/js/utils.js');
  const body = utils.slice(utils.indexOf('  _parseServerInfo: function(xmlStr) {'), utils.indexOf('  getAppById: function(appId) {'));
  const check = body.indexOf('if (!isValidServerUid(serverUid)) {');
  assert.ok(check > 0);
  // No property of the host is set before the check, and the ID is the checked one
  assert.equal(/this\.\w+ = /.test(body.slice(0, check)), false);
  assert.match(body.slice(check), /this\.serverUid = serverUid;/);
  assert.equal((body.match(/find\('uniqueid'\)/g) || []).length, 1);
  assert.match(utils, /return typeof serverUid === 'string' && SERVER_UID_PATTERN\.test\(serverUid\) && !\(serverUid in Object\.prototype\);/);
});

// index.js with utils.js, as the page has them once it loaded
function loadIndex() {
  return loadPlatformScripts(['wasm/platform/tv_profile.js', 'wasm/platform/index.js', 'wasm/static/js/utils.js'], { tv: { tv: 's90c', conn: 'wifi' } });
}

test('the hosts that an earlier version stored are taken over only with an ID that the app takes', () => {
  const app = loadIndex();
  const keep = app.get('keepValidStoredHosts');
  const host = (serverUid, hostname) => ({ hostname: hostname, address: '10.0.0.2', serverUid: serverUid, paired: true });
  // As the storage gives them: JSON.parse() makes '__proto__' and 'constructor' properties of the object itself
  const stored = JSON.parse(JSON.stringify({
    'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876': host('F3E2D1C0-B9A8-4765-8432-10FEDCBA9876', 'SUNSHINE-PC'),
    '0123456789ABCDEF': host('0123456789ABCDEF', 'GFE-PC'),
    'x,#main-content': host('x,#main-content', 'SELECTOR'),
    constructor: host('constructor', 'CONSTRUCTOR'),
    '': host('', 'EMPTY'),
    'a b': host('a b', 'SPACE'),
    // The ID inside the host is what the cards of the PC list are made of
    GOOD1: host('x,#main-content', 'OTHER-ID-INSIDE'),
    GOOD2: { hostname: 'NO-ID-INSIDE', address: '10.0.0.3' },
    GOOD3: null,
    GOOD4: 'text',
  }).replace('{', '{"__proto__":' + JSON.stringify(host('__proto__', 'PROTO')) + ','));
  assert.ok(Object.prototype.hasOwnProperty.call(stored, '__proto__'));
  const before = app.consoleMessages.length;
  const kept = keep(stored);
  assert.deepEqual(plain(kept), {
    'F3E2D1C0-B9A8-4765-8432-10FEDCBA9876': host('F3E2D1C0-B9A8-4765-8432-10FEDCBA9876', 'SUNSHINE-PC'),
    '0123456789ABCDEF': host('0123456789ABCDEF', 'GFE-PC'),
  });
  assert.deepEqual(Object.keys(kept), ['F3E2D1C0-B9A8-4765-8432-10FEDCBA9876', '0123456789ABCDEF']);
  // An ordinary object: a loop over it finds the two hosts and nothing else
  const names = [];
  for (const name in kept) {
    names.push(name);
  }
  assert.equal(names.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(kept, '__proto__'), false);
  // One line per host that is left out, with its name
  const warnings = app.consoleMessages.slice(before).filter((message) => message.level === 'warn').map((message) => message.text);
  assert.equal(warnings.length, 9, warnings.join('\n'));
  ['PROTO', 'SELECTOR', 'CONSTRUCTOR', 'EMPTY', 'SPACE', 'OTHER-ID-INSIDE', 'NO-ID-INSIDE'].forEach((name) => {
    assert.equal(warnings.filter((text) => text.indexOf('Leaving out a stored host') >= 0 && text.indexOf('"' + name + '"') >= 0).length, 1, name);
  });
  // No stored hosts, or something else than an object
  [undefined, null, 'hosts', 5].forEach((value) => assert.deepEqual(plain(keep(value)), {}));

  // The start of the app loads the hosts through it
  const index = read('wasm/platform/index.js');
  assert.match(index, /getData\('hosts', function\(previousValue\) \{\s+hosts = keepValidStoredHosts\(previousValue\.hosts\);/);
});

test('a lookup by ID finds hosts only, never a property that every object has', () => {
  const app = loadIndex();
  const find = app.get('getHostByUid');
  app.run('hosts = { HOST1: { hostname: "GAMING-PC", serverUid: "HOST1" } };');
  assert.deepEqual(plain(find('HOST1')), { hostname: 'GAMING-PC', serverUid: 'HOST1' });
  OBJECT_NAMES.concat(['HOST2', 'x,#main-content', '', undefined, null, 5]).forEach((id) => {
    assert.equal(find(id), undefined, String(id));
  });
  // The plain lookup that it replaces found the constructor of every object
  assert.equal(typeof app.run('hosts["constructor"]'), 'function');

  // The deep links of the Smart Hub tiles, the scan of the network and Add PC look a host up that way
  const index = read('wasm/platform/index.js');
  ['function waitForHostAndNavigate(serverUid) {', 'function waitForHostAndNavigateToApp(serverUid, appId) {'].forEach((signature) => {
    const body = index.slice(index.indexOf(signature), index.indexOf('\n}\n', index.indexOf(signature)));
    assert.match(body, /var host = getHostByUid\(serverUid\);/, signature);
    assert.equal(/hosts\[serverUid\]/.test(body), false, signature);
  });
  assert.match(index, /var knownHost = getHostByUid\(_nvhttpHost\.serverUid\);\s+if \(knownHost != null\) \{/);
  const scan = read('wasm/static/js/mdns-browser/main.js');
  assert.match(scan, /var knownHost = getHostByUid\(returnedDiscoveredHost\.serverUid\);\s+if \(knownHost != null\) \{/);
  assert.equal(/hosts\[/.test(scan), false);
});

test('no element of the PC list is found by a selector that an ID of a host is a part of', () => {
  ['wasm/platform/index.js', 'wasm/platform/launcher.js', 'wasm/platform/navigation.js', 'wasm/platform/menus.js',
    'wasm/static/js/mdns-browser/main.js'].forEach((file) => {
    const source = read(file);
    // e.g. $('#host-container-' + host.serverUid) or document.querySelector('#host-' + host.serverUid)
    assert.deepEqual(source.match(/(?:\$|querySelector(?:All)?)\(\s*'#host-[\w-]*'\s*\+/g) || [], [], file);
  });
  const index = read('wasm/platform/index.js');
  assert.equal((index.match(/\$\(document\.getElementById\('host-container-' \+ host\.serverUid\)\)\.remove\(\);/g) || []).length, 2);
  assert.match(index, /var hostCell = document\.getElementById\('host-' \+ host\.serverUid\);\s+var indicator = document\.getElementById\('host-status-' \+ host\.serverUid\);/);
});
