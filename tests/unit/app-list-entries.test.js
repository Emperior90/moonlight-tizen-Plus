'use strict';

// Checks that one broken entry doesn't break the app list of a host (NvHTTP.getAppListWithCacheFlush() and
// parseAppListEntry() of wasm/static/js/utils.js). Each <App> of the answer was read with
// getElementsByTagName('ID')[0].textContent: an entry without an <ID> or without an <AppTitle> threw, which rejected
// the whole list, so the host showed no apps at all, and an ID that is no number became NaN, which named the box art
// files of that app 'boxart-NaN.png' and went into the request of its start. Such an entry is left out now, with one
// line in the log per list, and the other apps show. The answer is read here with a stand-in for the XML parser of the
// page (helpers/xml-stand-in.js); tests/browser/hostile-server-info.test.js reads one with the real parser.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('crypto');
const { createPlatformContext, plain } = require('./helpers/platform-loader');
const { installXmlStandIn } = require('./helpers/xml-stand-in');

// utils.js with a host whose /applist answers with the given XML
function loadHost(answer) {
  const requests = [];
  const platform = createPlatformContext({
    globals: {
      crypto: webcrypto,
      sendMessage(method, params) {
        requests.push(params);
        return Promise.resolve(answer);
      },
    },
  });
  platform.load('wasm/static/js/utils.js');
  installXmlStandIn(platform);
  const host = platform.run('new NvHTTP("10.0.0.2", "0123456789abcdef", "", "")');
  host.hostname = 'GAMING-PC';
  host.ppkstr = 'PPK';
  host._baseUrlHttps = 'https://10.0.0.2:47984';
  const warnings = () => platform.consoleMessages.filter((message) => message.level === 'warn').map((message) => message.text);
  return { platform, host, requests, warnings };
}

const appList = (entries) => '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' + entries.join('') + '</root>';
const app = (id, title, more) => '<App><IsHdrSupported>1</IsHdrSupported><AppTitle>' + title + '</AppTitle><ID>' + id + '</ID>' + (more || '') + '</App>';

test('the app list of an ordinary host is read as before', async () => {
  const { host, requests, warnings } = loadHost(appList([app(881448767, 'Desktop'), app(1093255277, 'Steam Big Picture'), app(' 104\n', ' Forza Horizon 5 '),
    app(7, 'Terminate', '<UUID>8CB5C136-DA67-4F99-B4A1-F9CD35005CF4</UUID>'), app(8, 'Rise &amp; Shine', '<UUID> </UUID>'), app(-5, '')]));
  const list = plain(await host.getAppListWithCacheFlush());
  assert.deepEqual(list, [{ id: 881448767, title: 'Desktop' }, { id: 1093255277, title: 'Steam Big Picture' }, { id: 104, title: 'Forza Horizon 5' },
    { id: 7, title: 'Terminate', uuid: '8CB5C136-DA67-4F99-B4A1-F9CD35005CF4' }, { id: 8, title: 'Rise & Shine' }, { id: -5, title: '' }]);
  assert.deepEqual(warnings(), []);
  assert.match(requests[0][0], /^https:\/\/10\.0\.0\.2:47984\/applist\?uniqueid=/);
  // The list is what the next getAppList() returns
  assert.deepEqual(plain(await host.getAppList()), list);
  assert.equal(requests.length, 1);
});

test('an entry without an ID that is a number, or without a title, is left out, and the other apps show', async () => {
  const broken = [
    // No <ID>, no <AppTitle>, neither
    '<App><IsHdrSupported>1</IsHdrSupported><AppTitle>No ID</AppTitle></App>',
    '<App><IsHdrSupported>1</IsHdrSupported><ID>201</ID></App>',
    '<App></App>',
    '<App/>',
    // IDs that are no whole numbers: they became NaN and named the files 'boxart-NaN.png'
    app('', 'Empty ID'),
    app('abc', 'Letters'),
    app('NaN', 'NaN'),
    app('../../x', 'A path'),
    app('99999999999999999999999', 'Too large'),
    app('Infinity', 'Infinity'),
  ];
  const { host, warnings } = loadHost(appList([app(101, 'Cyberpunk 2077')].concat(broken, [app(102, 'Desktop')])));
  const list = plain(await host.getAppListWithCacheFlush());
  assert.deepEqual(list, [{ id: 101, title: 'Cyberpunk 2077' }, { id: 102, title: 'Desktop' }]);
  // One line for the list, with the numbers and the name of the host
  assert.deepEqual(warnings().length, 1, warnings().join('\n'));
  assert.match(warnings()[0], /Warning: Left out 10 of the 12 entries of the app list of GAMING-PC, which have no numeric ID or no title\.$/);
  // Every ID that is kept names files and requests as a whole number
  list.forEach((entry) => assert.equal(Number.isSafeInteger(entry.id), true));

  // A list of nothing but broken entries is an empty list, not an error
  const empty = loadHost(appList(broken));
  assert.deepEqual(plain(await empty.host.getAppListWithCacheFlush()), []);
  assert.equal(empty.warnings().length, 1);
  assert.deepEqual(plain(await loadHost(appList([])).host.getAppListWithCacheFlush()), []);
});

test('one entry of an app list by its rule', () => {
  const { platform } = loadHost('');
  // An <App> as the parser of the page hands it over, as far as parseAppListEntry() reads it
  const element = (children) => ({
    getElementsByTagName: (name) => (Object.prototype.hasOwnProperty.call(children, name) ? [{ textContent: children[name] }] : []),
  });
  const parse = (children) => plain(platform.get('parseAppListEntry')(element(children)));
  assert.deepEqual(parse({ ID: '101', AppTitle: 'Desktop' }), { id: 101, title: 'Desktop' });
  assert.deepEqual(parse({ ID: ' 101 ', AppTitle: ' Desktop ', UUID: ' ABC ' }), { id: 101, title: 'Desktop', uuid: 'ABC' });
  assert.deepEqual(parse({ ID: '0', AppTitle: '' }), { id: 0, title: '' });
  // The number at the start of the ID counts, as before
  assert.deepEqual(parse({ ID: '12abc', AppTitle: 'x' }), { id: 12, title: 'x' });
  [{ AppTitle: 'x' }, { ID: '1' }, {}, { ID: '', AppTitle: 'x' }, { ID: 'x1', AppTitle: 'x' }, { ID: '9007199254740993', AppTitle: 'x' }].forEach((children) => {
    assert.equal(parse(children), null, JSON.stringify(children));
  });
});
