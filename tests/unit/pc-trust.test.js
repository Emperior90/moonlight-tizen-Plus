'use strict';

// Checks the trust between the TV and a paired PC in NvHTTP of wasm/static/js/utils.js:
// - a paired PC is asked over HTTPS only, and curl checks its key against the one pinned at the pairing. Sunshine (and
//   Apollo, Vibepollo, Vibeshine) answers a client whose certificate it no longer accepts (the TV removed from its paired
//   devices, "Unpair All", or turned off in its list of clients) with HTTP 200 and <root status_code="401" ...>. That
//   answer comes from the PC itself, so refreshServerInfoAtAddress() rejects it with HOST_REFUSED_TV_ERROR without
//   taking any field, and a poll takes the PC for online and not paired (markRefusedByHost(), logged once). Up to 2.3.2
//   the PC showed offline for good.
// - a device that answers at the address of the PC with another key (GS_CERT_MISMATCH, -100) isn't authenticated: the
//   PC goes offline as before, never online or not paired, and pinnedKeyMismatch says why until another result comes.
// - the pairing of a PC that refused the TV drops the old key and starts over plain HTTP, and a pairing that the PC
//   doesn't confirm (no <paired>1</paired> in its answer to the pairchallenge request) fails and drops the new key.
// utils.js runs in a vm context with a simulated network: sendMessage() answers each request by its scheme and address.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('crypto');
const { createPlatformContext, plain } = require('./helpers/platform-loader');
const { installXmlStandIn } = require('./helpers/xml-stand-in');

const KEY = 'PPK';
const NEW_KEY = 'sha256//NEW';
const UNAUTHORIZED = '<?xml version="1.0" encoding="utf-8"?><root status_code="401" query="/serverinfo" status_message="The client is not authorized. Certificate verification failed."/>';
const PAIRED_ANSWER = '<?xml version="1.0" encoding="utf-8"?><root status_code="200"><paired>1</paired></root>';

function serverInfo(fields) {
  const all = Object.assign({ hostname: 'OTHER-NAME', appversion: '7.1.431.-1', uniqueid: 'HOST1', HttpsPort: '47984', ExternalPort: '47989',
    mac: '00:11:22:33:44:99', LocalIP: '10.0.0.2', PairStatus: '1', currentgame: '0', state: 'SUNSHINE_SERVER_FREE' }, fields);
  return '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' + Object.keys(all).map((name) => '<' + name + '>' + all[name] + '</' + name + '>').join('') + '</root>';
}

// Load utils.js with a network(method, params, request) that answers each request; request is
// { scheme, address, path, key }. Every request is recorded as text: 'pair', or '<scheme> <address><path>' and the
// pinned key, if any.
function loadUtils(network) {
  const requests = [];
  const platform = createPlatformContext({
    globals: {
      crypto: webcrypto,
      isInGame: false,
      myUniqueid: 'CLIENT',
      tvCapabilities: null,
      updateMacAddress() {},
      // The request that looks whether an address answers: the tests have no network, so it fails at once, which hands
      // the request to the module
      fetch() {
        return Promise.reject(new TypeError('Failed to fetch'));
      },
      sendMessage(method, params) {
        if (method === 'pair') {
          requests.push('pair');
          return network(method, params, null);
        }
        const match = /^(https?):\/\/([^/:]+):(\d+)(\/[^?]*)/.exec(String(params[0]));
        const request = { scheme: match[1], address: match[2], path: match[4], key: params[1] || null };
        requests.push(request.scheme + ' ' + request.address + request.path + (request.key ? ' key ' + request.key : ''));
        return network(method, params, request);
      },
    },
  });
  platform.load('wasm/static/js/utils.js');
  installXmlStandIn(platform);
  return {
    platform,
    requests,
    // A paired PC GAMING-PC (HOST1) at 10.0.0.2 with the pinned key, online, with the fields of its last answer
    addPairedHost(fields) {
      platform.context.__fields = fields || {};
      platform.run(`var host = new NvHTTP('10.0.0.2', 'CLIENT', '10.0.0.2', '00:11:22:33:44:55');
        host.hostname = 'GAMING-PC'; host.serverUid = 'HOST1'; host.localAddress = '10.0.0.2'; host.httpPort = 47989;
        host.httpsPort = 47984; host.externalPort = 47989; host.ppkstr = ${JSON.stringify(KEY)}; host.paired = true; host.online = true;
        host.currentGame = 104; host.appVersion = '7.1.431.-1';
        Object.assign(host, __fields);`);
    },
    poll() {
      return platform.run('new Promise((resolve) => host.pollServer(resolve))');
    },
    state() {
      return plain(platform.run(`({ online: host.online, paired: host.paired, key: host.ppkstr, mismatch: host.pinnedKeyMismatch,
        address: host.address, baseUrlHttps: host._baseUrlHttps || null, hostname: host.hostname, httpsPort: host.httpsPort,
        macAddress: host.macAddress, currentGame: host.currentGame, localAddress: host.localAddress })`));
    },
    warnings: () => platform.consoleMessages.filter((message) => message.level === 'warn').map((message) => message.text),
  };
}

const refusalLines = (utils) => utils.warnings().filter((text) => text.indexOf('[utils.js, markRefusedByHost]') >= 0);

test('a paired PC that answers with its pinned key that it no longer accepts the TV is online and not paired, and nothing of the answer is taken', async () => {
  const utils = loadUtils((method, params, request) => Promise.resolve(request.scheme === 'https' ? UNAUTHORIZED : serverInfo({ PairStatus: '0' })));
  utils.addPairedHost();
  await utils.poll();
  assert.deepEqual(utils.state(), { online: true, paired: false, key: KEY, mismatch: false, address: '10.0.0.2', baseUrlHttps: 'https://10.0.0.2:47984',
    hostname: 'GAMING-PC', httpsPort: 47984, macAddress: '00:11:22:33:44:55', currentGame: 104, localAddress: '10.0.0.2' });
  // Only over HTTPS with the pinned key: no fallback to plain HTTP
  assert.deepEqual(utils.requests, ['https 10.0.0.2/serverinfo key PPK']);
  const lines = refusalLines(utils);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Warning: GAMING-PC answered with its pinned key that it no longer accepts this TV \(status 401\): its pairing was removed or turned off on the PC\. It shows as not paired until it is paired again\.$/);
  assert.equal(/10\.0\.0\.2|PPK/.test(lines[0]), false, 'neither the address nor the key in the line');

  // The next poll says the same, without another line
  await utils.poll();
  assert.equal(utils.state().paired, false);
  assert.equal(refusalLines(utils).length, 1);

  // A paired PC that refuses the TV again is logged again
  utils.platform.run('host.paired = true;');
  await utils.poll();
  assert.equal(utils.state().paired, false);
  assert.equal(refusalLines(utils).length, 2);
});

test('refreshServerInfoAtAddress() rejects the 401 answer with HOST_REFUSED_TV_ERROR and changes nothing; only the polls mark the PC', async () => {
  const utils = loadUtils(() => Promise.resolve(UNAUTHORIZED));
  utils.addPairedHost();
  const before = utils.state();
  const error = await utils.platform.run('host.refreshServerInfoAtAddress("10.0.0.2").then(() => "resolved", (error) => error)');
  assert.equal(error, 'HOST_REFUSED_TV');
  assert.equal(error, utils.platform.get('HOST_REFUSED_TV_ERROR'));
  assert.deepEqual(utils.state(), before);
  assert.deepEqual(refusalLines(utils), []);
  // A 401 answer over HTTP proves nothing: a host without a pinned key fails as before
  utils.platform.run('host.ppkstr = null;');
  const httpError = await utils.platform.run('host.refreshServerInfoAtAddress("10.0.0.2").then(() => "resolved", (error) => error)');
  assert.equal(httpError, 'Failed to parse server info from HTTP');
});

test('a device with another key at every address leaves the PC paired and goes offline like a PC that is off, with its own flag until another result', async () => {
  let error = '-100';
  const utils = loadUtils(() => Promise.reject(error));
  utils.addPairedHost();
  await utils.poll();
  // The first failure keeps the PC online, as for any failure
  assert.deepEqual([utils.state().online, utils.state().paired, utils.state().mismatch], [true, true, true]);
  await utils.poll();
  const state = utils.state();
  assert.deepEqual([state.online, state.paired, state.key, state.mismatch, state.address], [false, true, KEY, true, '10.0.0.2']);
  // The address and the name with .local, each with the pinned key
  assert.deepEqual(utils.requests.slice(0, 2), ['https 10.0.0.2/serverinfo key PPK', 'https GAMING-PC.local/serverinfo key PPK']);
  assert.deepEqual(refusalLines(utils), []);
  // The PC is off now: no device answers, and the flag goes
  error = -1;
  await utils.poll();
  assert.deepEqual([utils.state().online, utils.state().mismatch], [false, false]);
  // The module sends the number as text; the mocks of the tests as a number
  assert.equal(utils.platform.run('isPinnedKeyMismatchError("-100") && isPinnedKeyMismatchError(-100)'), true);
  assert.equal(utils.platform.run('isPinnedKeyMismatchError(-1) || isPinnedKeyMismatchError("HOST_REFUSED_TV") || isPinnedKeyMismatchError(undefined)'), false);
});

test('the refusal of the PC at its local address wins over a device with another key at its old address', async () => {
  const utils = loadUtils((method, params, request) => {
    if (request.address === '10.0.0.9') {
      return Promise.reject('-100');
    }
    if (request.address === '10.0.0.2') {
      return Promise.resolve(UNAUTHORIZED);
    }
    return Promise.reject(-1);
  });
  utils.addPairedHost({ address: '10.0.0.9', userEnteredAddress: '10.0.0.9' });
  await utils.poll();
  const state = utils.state();
  assert.deepEqual([state.online, state.paired, state.mismatch, state.address, state.baseUrlHttps], [true, false, false, '10.0.0.2', 'https://10.0.0.2:47984']);
  assert.deepEqual(utils.requests, ['https 10.0.0.9/serverinfo key PPK', 'https GAMING-PC.local/serverinfo key PPK', 'https 10.0.0.2/serverinfo key PPK']);
});

test('a PC that accepts the TV again is paired again at its next poll, without a pairing', async () => {
  let refuses = true;
  const utils = loadUtils(() => Promise.resolve(refuses ? UNAUTHORIZED : serverInfo({ hostname: 'GAMING-PC' })));
  utils.addPairedHost();
  await utils.poll();
  assert.equal(utils.state().paired, false);
  refuses = false;
  await utils.poll();
  assert.deepEqual([utils.state().online, utils.state().paired, utils.state().key], [true, true, KEY]);
});

test('the pairing of a PC that refused the TV drops the old key, starts over plain HTTP and pins the new key', async () => {
  const utils = loadUtils((method, params, request) => {
    if (method === 'pair') {
      return Promise.resolve(NEW_KEY);
    }
    if (request.scheme === 'http') {
      return Promise.resolve(serverInfo({ hostname: 'GAMING-PC', PairStatus: '0' }));
    }
    return Promise.resolve(request.key === NEW_KEY ? (request.path === '/pair' ? PAIRED_ANSWER : serverInfo({ hostname: 'GAMING-PC' })) : UNAUTHORIZED);
  });
  utils.addPairedHost();
  await utils.poll();
  assert.equal(utils.state().paired, false);
  utils.requests.length = 0;
  const result = await utils.platform.run('host.pair("1234")');
  assert.equal(result, true);
  assert.deepEqual([utils.state().paired, utils.state().key], [true, NEW_KEY]);
  assert.deepEqual(utils.requests.slice(0, 2), ['http 10.0.0.2/serverinfo', 'pair']);
  assert.match(utils.requests[2], /^https 10\.0\.0\.2\/pair key sha256\/\/NEW$/);
  assert.equal(utils.requests.length, 3);
  assert.ok(utils.platform.consoleMessages.some((message) => message.text.indexOf('Pairing GAMING-PC again: dropping the key pinned at its earlier pairing, which it no longer accepts.') >= 0));
  // The next poll asks over HTTPS with the new key
  await utils.poll();
  assert.equal(utils.requests[3], 'https 10.0.0.2/serverinfo key sha256//NEW');
  assert.deepEqual([utils.state().online, utils.state().paired], [true, true]);
});

test('a pairing that the PC doesn\'t confirm fails with PAIRING_NOT_CONFIRMED_ERROR and drops the new key', async () => {
  let challengeAnswer = () => Promise.resolve(UNAUTHORIZED);
  const utils = loadUtils((method, params, request) => {
    if (method === 'pair') {
      return Promise.resolve(NEW_KEY);
    }
    if (request.path === '/pair') {
      return challengeAnswer();
    }
    return Promise.resolve(serverInfo({ hostname: 'GAMING-PC', PairStatus: '0' }));
  });
  utils.platform.run(`var host = new NvHTTP('10.0.0.2', 'CLIENT', '10.0.0.2'); host.httpPort = 47989;`);
  await utils.poll();
  assert.equal(utils.state().paired, false);
  const error = await utils.platform.run('host.pair("1234").then(() => "resolved", (error) => error)');
  assert.equal(error, 'PAIRING_NOT_CONFIRMED');
  assert.equal(error, utils.platform.get('PAIRING_NOT_CONFIRMED_ERROR'));
  assert.deepEqual([utils.state().paired, utils.state().key], [false, null]);
  assert.ok(utils.warnings().some((text) => /\[utils\.js, pair\].*Warning: GAMING-PC didn't confirm the pairing\.$/.test(text)), utils.warnings().join('\n'));
  // An answer without <paired>1</paired> as well
  challengeAnswer = () => Promise.resolve('<?xml version="1.0" encoding="utf-8"?><root status_code="200"><paired>0</paired></root>');
  assert.equal(await utils.platform.run('host.pair("1234").then(() => "resolved", (error) => error)'), 'PAIRING_NOT_CONFIRMED');
  assert.equal(utils.state().key, null);
  // A pairchallenge request that fails keeps its error and the new key: the PC may have stored the pairing, which the
  // next poll tells
  challengeAnswer = () => Promise.reject(-1);
  assert.equal(await utils.platform.run('host.pair("1234").then(() => "resolved", (error) => error)'), -1);
  assert.equal(utils.state().key, NEW_KEY);
});
