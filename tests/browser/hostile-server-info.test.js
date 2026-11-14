'use strict';

// Checks, in the real page with its XML parser, what a device on the local network can do with the answers that the
// app asks it for (wasm/static/js/utils.js, wasm/static/js/mdns-browser/main.js). The scan of the network asks every
// address for a server info over plain HTTP; up to 2.3.0
//  - an answer with the unique ID of a paired PC moved that PC to the address of the device, with its ports and its
//    MAC address, so the PC showed offline and Wake-on-LAN had a wrong MAC address;
//  - the fields of an answer were kept as they came: an address such as 'evil.example/x?' sent the next poll of the TV
//    to another host and path, a missing HTTPS port stood as NaN in every HTTPS URL, texts had no limit, and the
//    display modes of every poll were added to the ones before;
//  - one <App> without an <ID> in an app list left the PC without any apps.
// Now a paired PC moves only to an address that proved its pinned key over HTTPS, each field of a server info is kept
// by its rule, and a broken entry of an app list is left out. tests/unit/scan-known-host.test.js,
// tests/unit/server-info-fields.test.js and tests/unit/app-list-entries.test.js check the rules one by one.
// The devices are those of mocks/lan-devices.js: only the answers of the network are simulated.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness, waitForStorage, SUNSHINE_HOSTS } = require('./harness');

const TV = { tv: 's90c', conn: 'wifi' };

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// A server info with the given elements; `xml` is added as it is
function serverInfo(fields) {
  const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const all = Object.assign({ hostname: 'GAMING-PC', appversion: '7.1.431.-1', GfeVersion: '3.23.0.74', uniqueid: 'HOST1', HttpsPort: '47984',
    ExternalPort: '47989', mac: '00:11:22:33:44:55', LocalIP: '10.0.0.2', ServerCodecModeSupport: '3843', PairStatus: '1', currentgame: '0',
    state: 'SUNSHINE_SERVER_FREE' }, fields);
  return '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' + Object.keys(all).map((name) => (
    name === 'xml' ? all[name] : '<' + name + '>' + escape(all[name]) + '</' + name + '>')).join('') + '</root>';
}

const displayModes = (modes) => '<SupportedDisplayMode>' + modes.map((mode) => '<DisplayMode><Width>' + mode[0] + '</Width><Height>' + mode[1] +
  '</Height><RefreshRate>' + mode[2] + '</RefreshRate></DisplayMode>').join('') + '</SupportedDisplayMode>';

// The paired PC of the harness (HOST1 at 10.0.0.2, pinned key 'PPK') as a device of the network: over HTTP it answers
// a client it doesn't know, without its MAC address
const REAL_PC = { http: serverInfo({ mac: '00:00:00:00:00:00', PairStatus: '0' }), https: serverInfo({}), key: 'PPK' };

// Open the app with the given devices, wait for the scan of the start and stop the polling, so that only the test asks
async function openWithDevices(devices, stored) {
  const app = await openApp(harness, { tv: TV, moduleScripts: ['lan-devices.js'], stored, initScripts: ['window.__lanDevices = ' + JSON.stringify(devices) + ';'] });
  await app.page.waitForFunction(() => isSubnetScanFinished === true, null, { timeout: 15000 });
  await app.page.evaluate(() => {
    stopPollingHosts();
    window.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // What the app holds of a host
    window.hostState = (serverUid) => {
      const host = hosts[serverUid];
      return host ? { address: host.address, localAddress: host.localAddress, externalIP: host.externalIP, macAddress: host.macAddress,
        httpPort: host.httpPort, httpsPort: host.httpsPort, externalPort: host.externalPort, baseUrlHttps: host._baseUrlHttps,
        baseUrlHttp: host._baseUrlHttp, paired: host.paired, ppkstr: host.ppkstr, hostname: host.hostname } : null;
    };
  });
  // Let a poll that was on its way end
  await app.page.waitForTimeout(300);
  return app;
}

const requestsTo = (page, address) => page.evaluate((to) => window.__lan.requests.filter((request) => request.address === to).map((request) => (
  request.scheme + ' ' + request.address + ':' + request.port + request.path + (request.key ? ' key ' + request.key : ''))), address);

test('the scan moves a paired PC only to an address that proved its pinned key', async () => {
  const app = await openWithDevices({ '10.0.0.2': REAL_PC }, { hosts: SUNSHINE_HOSTS });
  try {
    const stored = { address: '10.0.0.2', localAddress: '10.0.0.2', externalIP: '', macAddress: '00:11:22:33:44:55', httpPort: 47989, httpsPort: 47984,
      externalPort: 47989, baseUrlHttps: 'https://10.0.0.2:47984', baseUrlHttp: 'http://10.0.0.2:47989', paired: true, ppkstr: 'PPK', hostname: 'GAMING-PC' };
    assert.deepEqual(await app.page.evaluate(() => window.hostState('HOST1')), stored);
    const storedBefore = (await readStorage(app.page)).hosts.HOST1;

    // A device at 10.9.9.9 answers the scan with the unique ID of the PC, its own MAC address and port, and the claim
    // that the TV is paired with it. It has no HTTPS with the key of the PC.
    await app.page.evaluate((impostor) => {
      window.__lan.devices['10.9.9.9'] = { http: impostor, https: impostor, key: 'KEY-OF-THE-DEVICE' };
      findNvService('ipv4:10.9.9.9');
    }, serverInfo({ mac: 'de:ad:be:ef:00:01', LocalIP: '10.9.9.9', HttpsPort: '1234' }));
    await app.page.waitForFunction(() => window.__lan.requests.some((request) => request.scheme === 'https' && request.address === '10.9.9.9'), null, { timeout: 5000 });
    await app.page.waitForTimeout(500);
    // Nothing of the PC changed, in the app or in what it stored, and the PC list still has the one PC
    assert.deepEqual(await app.page.evaluate(() => window.hostState('HOST1')), stored);
    assert.deepEqual((await readStorage(app.page)).hosts.HOST1, storedBefore);
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), ['HOST1']);
    assert.equal(await app.page.locator('#host-grid .host-container').count(), 1);
    // The device was asked for a proof at the stored HTTPS port of the PC, with the pinned key
    assert.deepEqual(await requestsTo(app.page, '10.9.9.9'), ['http 10.9.9.9:47989/serverinfo', 'https 10.9.9.9:47984/serverinfo key PPK']);
    const refused = app.logs.filter((line) => line.indexOf('answered the scan with the unique ID of the paired PC GAMING-PC, but didn\'t prove to be that PC') >= 0);
    assert.equal(refused.length, 1, app.logs.filter((line) => line.indexOf('main.js') >= 0).join('\n'));
    assert.match(refused[0], /A device at 10\.9\.9\.9 .* Keeping the PC at 10\.0\.0\.2\.$/);

    // The PC itself gets the address 10.0.0.77 and a new network card
    await app.page.evaluate(({ overHttp, overHttps }) => {
      delete window.__lan.devices['10.0.0.2'];
      window.__lan.devices['10.0.0.77'] = { http: overHttp, https: overHttps, key: 'PPK' };
      findNvService('ipv4:10.0.0.77');
    }, { overHttp: serverInfo({ mac: '00:00:00:00:00:00', PairStatus: '0', LocalIP: '10.0.0.77', HttpsPort: '1111' }),
      overHttps: serverInfo({ mac: 'a8:a1:59:12:ab:ce', LocalIP: '10.0.0.77' }) });
    await app.page.waitForFunction(() => hosts.HOST1.address === '10.0.0.77', null, { timeout: 5000 });
    const moved = Object.assign({}, stored, { address: '10.0.0.77', localAddress: '10.0.0.77', macAddress: 'a8:a1:59:12:ab:ce',
      baseUrlHttps: 'https://10.0.0.77:47984', baseUrlHttp: 'http://10.0.0.77:47989' });
    assert.deepEqual(await app.page.evaluate(() => window.hostState('HOST1')), moved);
    assert.deepEqual(await requestsTo(app.page, '10.0.0.77'), ['http 10.0.0.77:47989/serverinfo', 'https 10.0.0.77:47984/serverinfo key PPK']);
    // And it is stored there
    const storage = await waitForStorage(app.page, (values) => values.hosts && values.hosts.HOST1 && values.hosts.HOST1.address === '10.0.0.77');
    assert.deepEqual([storage.hosts.HOST1._baseUrlHttps, storage.hosts.HOST1._baseUrlHttp, storage.hosts.HOST1.macAddress, storage.hosts.HOST1.localAddress,
      storage.hosts.HOST1.ppkstr], ['https://10.0.0.77:47984', 'http://10.0.0.77:47989', 'a8:a1:59:12:ab:ce', '10.0.0.77', 'PPK']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the fields of a server info are kept by their rules, and none sends the TV to another host', async () => {
  const UID = 'A1B2C3D4E5F60718';
  const app = await openWithDevices({}, undefined);
  // Every request of the page, also the ones that look whether an address answers
  const pageRequests = [];
  app.page.on('request', (request) => pageRequests.push(request.url()));
  try {
    const long = 'x'.repeat(50000);
    const hostile = serverInfo({ uniqueid: UID, hostname: 'evil.example/x?\nPC' + long, LocalIP: 'evil.example/x?', ExternalIP: 'evil.example:8080/y#',
      HttpsPort: 'abc', ExternalPort: '', mac: long, appversion: '7.1.431.-1' + long, GfeVersion: long, gputype: long, state: 'SUNSHINE_SERVER_FREE' + long,
      PairStatus: '0', xml: displayModes([[1920, 1080, 60], [1920, 1080, 120], ['x', 'y', 'z'], ['', '', ''], [0, 0, 0], [3840, 2160, 60]].concat(
        Array.from({ length: 3000 }, (unused, index) => [5000 + index, 1080, 60]))) });
    await app.page.evaluate((answer) => {
      window.__lan.devices['10.9.9.5'] = { http: answer };
      findNvService('ipv4:10.9.9.5');
    }, hostile);
    // The device is listed: it has a unique ID that the app takes
    await app.page.waitForFunction((uid) => !!document.getElementById('host-container-' + uid), UID, { timeout: 5000 });
    await app.page.evaluate(() => stopPollingHosts());
    await app.page.waitForTimeout(300);
    const state = await app.page.evaluate((uid) => Object.assign(window.hostState(uid), { appVersion: hosts[uid].appVersion, gfeVersion: hosts[uid].gfeVersion,
      gputype: hosts[uid].gputype, serverState: hosts[uid].serverState, modes: Object.keys(hosts[uid].supportedDisplayModes),
      fullHd: hosts[uid].supportedDisplayModes['1080:1920'], candidates: getServerAddressCandidates(hosts[uid]), stored: JSON.stringify(hosts[uid]).length }), UID);
    // The name without the line break and cut, no address but its own, the default ports, no MAC address
    assert.equal(state.hostname, ('evil.example/x? PC' + long).slice(0, 64));
    assert.deepEqual([state.address, state.localAddress, state.externalIP, state.httpsPort, state.httpPort, state.externalPort, state.macAddress],
      ['10.9.9.5', '', '', 47984, 47989, 47989, undefined]);
    assert.deepEqual([state.baseUrlHttps, state.baseUrlHttp], ['https://10.9.9.5:47984', 'http://10.9.9.5:47989']);
    assert.deepEqual([state.appVersion.length, state.gfeVersion.length, state.gputype.length, state.serverState.length], [32, 32, 64, 64]);
    assert.deepEqual(state.candidates, ['10.9.9.5']);
    // The display modes: numbers only, and at most 128 resolutions of the 1024 entries that are read
    assert.equal(state.modes.length, 128);
    assert.deepEqual(state.modes.filter((mode) => !/^\d+:\d+$/.test(mode)), []);
    assert.deepEqual(state.fullHd, [60, 120]);
    assert.ok(state.stored < 5000, String(state.stored));
    // The name shows in the PC list as text
    assert.equal(await app.page.locator('#host-container-' + UID + ' img, #host-container-' + UID + ' script').count(), 0);

    // The next answer has other display modes, which replace the ones before
    const polled = await app.page.evaluate(async ({ uid, answer }) => {
      window.__lan.devices['10.9.9.5'] = { http: answer };
      await new Promise((resolve) => hosts[uid].pollServer(resolve));
      return hosts[uid].supportedDisplayModes;
    }, { uid: UID, answer: serverInfo({ uniqueid: UID, hostname: 'DEVICE', PairStatus: '0', xml: displayModes([[2560, 1440, 144], ['a', 'b', 'c']]) }) });
    assert.deepEqual(polled, { '1440:2560': [144] });

    // The device stops answering after an answer with addresses of its choosing. The poll then tried every address
    // that the answer named; now it asks the address of the device, its name with .local, and nothing else.
    const offline = await app.page.evaluate(async ({ uid, answer }) => {
      window.__lan.devices['10.9.9.5'] = { http: answer };
      await new Promise((resolve) => hosts[uid].pollServer(resolve));
      const kept = [hosts[uid].localAddress, hosts[uid].externalIP, hosts[uid].hostname];
      delete window.__lan.devices['10.9.9.5'];
      window.__lan.requests.length = 0;
      await new Promise((resolve) => hosts[uid].pollServer(resolve));
      await new Promise((resolve) => hosts[uid].pollServer(resolve));
      return { kept, online: hosts[uid].online, asked: window.__lan.requests.map((request) => request.address) };
    }, { uid: UID, answer: serverInfo({ uniqueid: UID, hostname: 'DEVICE', PairStatus: '0', LocalIP: 'user@evil.example', ExternalIP: 'evil.example/x?' }) });
    assert.deepEqual(offline.kept, ['', '', 'DEVICE']);
    assert.equal(offline.online, false);
    assert.deepEqual(offline.asked, ['10.9.9.5', 'DEVICE.local', '10.9.9.5', 'DEVICE.local']);
    const elsewhere = pageRequests.filter((url) => url.indexOf(harness.baseUrl + '/') !== 0 && !/^http:\/\/(10\.9\.9\.5|DEVICE\.local|device\.local):47989\/serverinfo/.test(url));
    assert.deepEqual(elsewhere, []);
    assert.equal(pageRequests.some((url) => url.indexOf('evil') >= 0), false);
    assert.ok(pageRequests.some((url) => url.indexOf('http://10.9.9.5:47989/serverinfo') === 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('an app list with broken entries shows the other apps', async () => {
  const appList = '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' +
    '<App><IsHdrSupported>1</IsHdrSupported><AppTitle>Cyberpunk 2077</AppTitle><ID>101</ID></App>' +
    '<App><IsHdrSupported>1</IsHdrSupported><AppTitle>No ID</AppTitle></App>' +
    '<App><IsHdrSupported>1</IsHdrSupported><ID>103</ID></App>' +
    '<App><AppTitle>Not a number</AppTitle><ID>../x</ID></App>' +
    '<App/>' +
    '<App><IsHdrSupported>1</IsHdrSupported><AppTitle>Desktop &amp; more</AppTitle><ID>102</ID><UUID>8CB5C136-DA67-4F99-B4A1-F9CD35005CF4</UUID></App></root>';
  const app = await openWithDevices({ '10.0.0.2': { http: REAL_PC.http, https: { '/serverinfo': REAL_PC.https, '/applist': appList }, key: 'PPK' } }, { hosts: SUNSHINE_HOSTS });
  try {
    const result = await app.page.evaluate(() => hosts.HOST1.getAppListWithCacheFlush().then((list) => ({ list }), (error) => ({ error: String(error) })));
    // Before, the entry without an <ID> threw, and the PC had no app list at all
    assert.deepEqual(result, { list: [{ id: 101, title: 'Cyberpunk 2077' }, { id: 102, title: 'Desktop & more', uuid: '8CB5C136-DA67-4F99-B4A1-F9CD35005CF4' }] });
    const warnings = app.logs.filter((line) => line.indexOf('Left out 4 of the 6 entries of the app list of GAMING-PC') >= 0);
    assert.equal(warnings.length, 1, app.logs.filter((line) => line.indexOf('getAppListWithCacheFlush') >= 0).join('\n'));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
