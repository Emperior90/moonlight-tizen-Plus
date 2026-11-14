'use strict';

// Checks the box art server of the Smart Hub preview service (res/service/service.js). It listens on every network
// interface of the TV (port 8889), so any device on the LAN can send it a request. It must answer only a plain preview
// file name such as '/preview-s90c-881448767.jpg' and build the file path from that name alone: a route with '..', a
// further slash, a percent-encoded character, an absolute path or another extension gets a 404 and never reaches the
// file system. The service runs in a Node vm context with simulated Tizen APIs and simulated `http` and `fs` modules
// that record what the server reads.
// Since 2.3.1 a tile of the preview data, which comes through an app control that another app on the TV may be able to
// send, maps its route only to a file with the file name of the route (before, to any path, which the server then sent
// to whoever asked for the route), and the server tells the app less about its requests: one line per request, with
// the route cut to 80 characters, and at most 5 lines per minute about requests that it didn't serve (60 about the ones
// it served). Before, every request sent up to five lines to the app, with a route of any length, so a device on the
// local network could flood the app and its diagnostic log during a stream.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const url = require('url');
const vm = require('vm');
const { REPO_ROOT } = require('../lib/dev-modules');

const SERVICE_FILE = path.join(REPO_ROOT, 'res/service/service.js');
const DOCUMENTS = '/opt/usr/home/owner/content/Documents/';
const HOME_DOCUMENTS = '/home/owner/content/Documents/';

// The file name prefix of the preview images of the app, read from utils.js so that the test follows a change there
function readPreviewPrefix() {
  const match = /\bvar SMART_HUB_PREVIEW_FILE_PREFIX = '([^']*)';/.exec(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/js/utils.js'), 'utf8'));
  assert.ok(match, 'SMART_HUB_PREVIEW_FILE_PREFIX not found in wasm/static/js/utils.js');
  return match[1];
}

const PREFIX = readPreviewPrefix();

// Load the service into a fresh context. `files` maps the paths that the simulated file system has to their content,
// `appControl` is what getRequestedAppControl() returns (null: started without data, which starts the server on a TV
// with the preview API)
function loadService(options) {
  const opts = options || {};
  const files = opts.files || {};
  const reads = [];
  const logs = [];
  const server = { handler: null, listenedOn: null };
  // The clock of the service, which a test moves to let a minute pass
  const clock = { now: 1700000000000 };

  const simulatedFs = {
    readFileSync(filePath) {
      reads.push(filePath);
      if (Object.prototype.hasOwnProperty.call(files, filePath)) {
        return Buffer.from(files[filePath]);
      }
      const error = new Error('ENOENT: no such file or directory, open \'' + filePath + '\'');
      error.code = 'ENOENT';
      throw error;
    },
  };
  const simulatedHttp = {
    createServer(handler) {
      server.handler = handler;
      return {
        on() {},
        listen(port, host, callback) {
          server.listenedOn = { port, host };
          if (callback) {
            callback();
          }
        },
      };
    },
  };
  const application = {
    appInfo: { packageId: 'MLightS90C' },
    getRequestedAppControl: () => (opts.appControl === undefined ? null : opts.appControl),
    exit() {},
  };
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    tizen: {
      application: { getCurrentApplication: () => application },
      messageport: {
        requestRemoteMessagePort: () => ({
          sendMessage(messages) {
            messages.forEach((message) => logs.push(message.value));
          },
        }),
      },
    },
    webapis: {
      preview: { setPreviewData(data, onSuccess) { sandbox.previewData = data; onSuccess(); } },
      network: { getIp: () => '192.168.1.20' },
    },
    module: { exports: {} },
    Date: { now: () => clock.now },
    require(name) {
      if (name === 'fs') {
        return simulatedFs;
      }
      if (name === 'http') {
        return simulatedHttp;
      }
      if (name === 'url') {
        return url;
      }
      throw new Error('Cannot find module \'' + name + '\'');
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SERVICE_FILE, 'utf8'), sandbox, { filename: SERVICE_FILE });
  sandbox.module.exports.onRequest();
  assert.ok(server.handler, 'the service did not start its box art server');

  return {
    reads,
    logs,
    server,
    sandbox,
    clock,
    // Send a GET request with this raw request target and return the status, headers and body
    request(requestTarget) {
      const response = { status: null, headers: null, body: null };
      server.handler({ method: 'GET', url: requestTarget }, {
        writeHead(status, headers) {
          response.status = status;
          response.headers = headers || {};
        },
        end(body) {
          response.body = body === undefined ? null : String(body);
        },
      });
      return response;
    },
  };
}

test('the server listens on the preview port of this build on every interface', () => {
  const service = loadService();
  assert.deepEqual(service.server.listenedOn, { port: 8889, host: '0.0.0.0' });
});

test('a preview file of the app is served from the documents directory after a reboot', () => {
  const fileName = PREFIX + '881448767.jpg';
  assert.match('/' + fileName, /^\/(preview-[A-Za-z0-9_-]+\.jpg)$/, 'the app\'s file names must fit the route pattern');
  const service = loadService({ files: { [DOCUMENTS + fileName]: 'jpeg data' } });
  const response = service.request('/' + fileName + '?v=1730000000000');
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'image/jpeg');
  assert.equal(response.body, 'jpeg data');
  assert.deepEqual(service.reads, [DOCUMENTS + fileName]);
});

test('the second documents directory is tried when the first has no such file', () => {
  const fileName = PREFIX + '42.jpg';
  const service = loadService({ files: { [HOME_DOCUMENTS + fileName]: 'jpeg data' } });
  const response = service.request('/' + fileName);
  assert.equal(response.status, 200);
  assert.deepEqual(service.reads, [DOCUMENTS + fileName, HOME_DOCUMENTS + fileName]);
});

test('a preview file name that exists nowhere gets a 404', () => {
  const service = loadService();
  const response = service.request('/' + PREFIX + '1.jpg');
  assert.equal(response.status, 404);
  assert.deepEqual(service.reads, [DOCUMENTS + PREFIX + '1.jpg', HOME_DOCUMENTS + PREFIX + '1.jpg']);
});

test('the file names of the regular Moonlight app and negative app IDs fit the pattern', () => {
  const service = loadService({ files: { [DOCUMENTS + 'preview-123.jpg']: 'a', [DOCUMENTS + PREFIX + '-5_x.jpg']: 'b' } });
  assert.equal(service.request('/preview-123.jpg').status, 200);
  assert.equal(service.request('/' + PREFIX + '-5_x.jpg').status, 200);
});

// Requests that tried to leave the documents directory or read another file. None of them may reach the file system,
// even though the simulated file system has a file at every path that a traversal could aim at.
const REJECTED_TARGETS = [
  // Dot segments, which the old check (prefix '/preview-' and suffix '.jpg') let through
  '/preview-x/../../../../etc/passwd.jpg',
  '/preview-x/../../owner/apps_rw/MLightS90C/data/secret.jpg',
  '/preview-a.jpg/../../x.jpg',
  '/../preview-a.jpg',
  '/./preview-a.jpg',
  '/preview-..jpg',
  '/preview-../x.jpg',
  // Percent-encoded dots, slashes, backslashes and NUL, which the server must not decode into a path
  '/preview-%2e%2e%2f%2e%2e%2fetc%2fpasswd.jpg',
  '/preview-%2E%2E/%2E%2E/x.jpg',
  '/preview-..%2f..%2fx.jpg',
  '/preview-..%5c..%5cx.jpg',
  '/preview-a%00.jpg',
  '/preview-a.jpg%00.png',
  '/%70review-a.jpg',
  // Backslashes and further slashes
  '/preview-..\\..\\x.jpg',
  '//preview-a.jpg',
  '/preview-a.jpg/',
  '/sub/preview-a.jpg',
  // Absolute paths
  '/opt/usr/home/owner/content/Documents/preview-a.jpg',
  '//etc/preview-a.jpg',
  '/etc/passwd',
  // Other extensions, other names, nothing
  '/preview-a.png',
  '/preview-a.jpeg',
  '/preview-a.JPG',
  '/preview-a.jpg.png',
  '/preview-a.jpgx',
  '/preview-.jpg',
  '/preview-a b.jpg',
  '/preview-a+b.jpg',
  '/Preview-a.jpg',
  '/boxart-a.jpg',
  '/index.html',
  '/',
];

test('requests for anything but a plain preview file name get a 404 without reading a file', () => {
  const files = {};
  // A file at every plausible target, so that a missing check would show up as a 200
  ['/etc/passwd', '/etc/passwd.jpg', DOCUMENTS + 'preview-a.jpg', DOCUMENTS + 'preview-a.png', '/x.jpg'].forEach((file) => {
    files[file] = 'secret';
  });
  REJECTED_TARGETS.forEach((target) => {
    const service = loadService({ files });
    const response = service.request(target);
    assert.equal(response.status, 404, 'expected a 404 for ' + JSON.stringify(target));
    assert.notEqual(response.body, 'secret', 'served a file for ' + JSON.stringify(target));
    assert.deepEqual(service.reads, [], 'read a file for ' + JSON.stringify(target));
  });
});

test('an absolute request target is reduced to its path before the check', () => {
  const service = loadService({ files: { [DOCUMENTS + 'preview-a.jpg']: 'a' } });
  // A proxy-style absolute URL names the same plain file name
  assert.equal(service.request('http://192.168.1.20:8889/preview-a.jpg').status, 200);
  assert.equal(service.request('http://192.168.1.20:8889/preview-x/../../etc/passwd.jpg').status, 404);
  assert.deepEqual(service.reads, [DOCUMENTS + 'preview-a.jpg']);
});

// Preview data as the app sends it (setSmartHubPreview() in wasm/platform/index.js): each tile names its image route
// and the file of its box art
function previewAppControl(tiles) {
  const data = { sections: [{ title: 'Host', tiles }] };
  return { appControl: { data: [{ key: 'Preview', value: [JSON.stringify(data)] }] } };
}

test('a tile of the app maps its route to its box art file', () => {
  const route = '/' + PREFIX + '7.jpg';
  // The documents directory as the TV names it to the app (tizen.filesystem.toURI('documents') in showApps() of
  // index.js), here another one than the two that the server tries by itself
  const file = '/opt/media/documents' + route;
  const service = loadService({
    appControl: previewAppControl([
      { title: 'Desktop', image_url: 'http://127.0.0.1:8889' + route + '?v=1', txtPath: file },
    ]),
    files: { [file]: 'box art' },
  });
  const response = service.request(route + '?v=2');
  assert.equal(response.status, 200);
  assert.equal(response.body, 'box art');
  assert.deepEqual(service.reads, [file]);
  assert.ok(service.logs.indexOf('Mapped route ' + route + ' to ' + file) >= 0, service.logs.join('\n'));
  // The tile goes to the preview API with the IP of the TV and without the file path
  const tile = JSON.parse(service.sandbox.previewData).sections[0].tiles[0];
  assert.equal(tile.image_url, 'http://192.168.1.20:8889' + route + '?v=1');
  assert.equal(tile.txtPath, undefined);
});

test('a tile whose route is not a preview file name is not mapped', () => {
  const service = loadService({
    appControl: previewAppControl([
      { title: 'Evil', image_url: 'http://127.0.0.1:8889/preview-x/../../x.jpg', txtPath: '/etc/passwd' },
      { title: 'Evil 2', image_url: 'http://127.0.0.1:8889/secret.png', txtPath: '/etc/shadow' },
    ]),
    files: { '/etc/passwd': 'secret', '/etc/shadow': 'secret' },
  });
  assert.equal(service.request('/preview-x/../../x.jpg').status, 404);
  assert.equal(service.request('/secret.png').status, 404);
  assert.deepEqual(service.reads, []);
});

test('the route pattern is the documented one', () => {
  const source = fs.readFileSync(SERVICE_FILE, 'utf8');
  assert.match(source, /var PREVIEW_ROUTE_PATTERN = \/\^\\\/\(preview-\[A-Za-z0-9_-\]\+\\\.jpg\)\$\/;/);
  // The fallback builds its paths from the captured file name, not from the request path
  assert.doesNotMatch(source, /Documents' \+ route/);
});

test('a tile maps its route only to a file with the file name of the route', () => {
  const secrets = ['/etc/passwd', '/opt/usr/home/owner/apps_rw/MLightS90C/data/GAMING-PC/boxart-7.png', '/etc/' + PREFIX + '2.jpg.bak',
    '/etc/x' + PREFIX + '3.jpg', '/etc/' + PREFIX + '4.jpg/../passwd', '/etc/' + PREFIX + '5.jpg/', 'C:\\secret\\' + PREFIX + '6.jpg', '/etc/shadow'];
  const files = {};
  secrets.forEach((file) => {
    files[file] = 'secret';
  });
  // The preview file of app 7 is in the documents directory, where the server finds it by its name
  files[DOCUMENTS + PREFIX + '7.jpg'] = 'preview of app 7';
  const tile = (id, txtPath) => ({ title: 'App ' + id, image_url: 'http://127.0.0.1:8889/' + PREFIX + id + '.jpg?v=1', txtPath });
  const service = loadService({
    appControl: previewAppControl([tile(1, secrets[0]), tile(7, secrets[1]), tile(2, secrets[2]), tile(3, secrets[3]), tile(4, secrets[4]), tile(5, secrets[5]),
      tile(6, secrets[6]), tile(8, { toString: () => '/etc/shadow' }), tile(9, ['/etc/shadow']), tile(10, 5)]),
    files,
  });
  // None of the paths is mapped, each with a line that says so
  assert.equal(service.logs.filter((line) => /^Mapped route /.test(line)).length, 0);
  assert.equal(service.logs.filter((line) => /^Not mapping the route \/preview-[\w-]+\.jpg to .*, whose file name is not the one of the route$/.test(line)).length, 10,
    service.logs.join('\n'));
  // The routes answer from the documents directory, like after a reboot of the TV, or not at all
  [1, 2, 3, 4, 5, 6, 8, 9, 10].forEach((id) => {
    const response = service.request('/' + PREFIX + id + '.jpg');
    assert.equal(response.status, 404, String(id));
    assert.notEqual(response.body, 'secret', String(id));
  });
  // A tile that an earlier version stored with the path of the box art in the private storage still shows its preview
  const stored = service.request('/' + PREFIX + '7.jpg');
  assert.deepEqual([stored.status, stored.body], [200, 'preview of app 7']);
  // Nothing but the documents directories was read
  service.reads.forEach((file) => assert.match(file, /^\/(opt\/usr\/)?home\/owner\/content\/Documents\/preview-[\w-]+\.jpg$/));
  assert.equal(service.reads.some((file) => secrets.indexOf(file) >= 0), false);
  // The tiles still go to the preview API, without their paths
  const tiles = JSON.parse(service.sandbox.previewData).sections[0].tiles;
  assert.equal(tiles.length, 10);
  tiles.forEach((sent) => assert.deepEqual([sent.txtPath, /^http:\/\/192\.168\.1\.20:8889\/preview-/.test(sent.image_url)], [undefined, true]));

  // The file name is compared as it is: the same name in any directory is the file of the route
  const moved = loadService({
    appControl: previewAppControl([tile(1, '/somewhere/else/' + PREFIX + '1.jpg'), tile(2, PREFIX + '2.jpg')]),
    files: { ['/somewhere/else/' + PREFIX + '1.jpg']: 'one', [PREFIX + '2.jpg']: 'two' },
  });
  assert.deepEqual([moved.request('/' + PREFIX + '1.jpg').body, moved.request('/' + PREFIX + '2.jpg').body], ['one', 'two']);
});

test('a request for a name that every object has is no mapped route', () => {
  // The routes are the keys of a plain object, which also has 'constructor' and '__proto__'; the pattern keeps such
  // names out, and the lookup takes own properties only
  const source = fs.readFileSync(SERVICE_FILE, 'utf8');
  assert.match(source, /if \(Object\.prototype\.hasOwnProperty\.call\(routeMap, route\)\) \{/);
  const service = loadService();
  ['/constructor', '/__proto__', '/toString', '/hasOwnProperty'].forEach((target) => {
    assert.equal(service.request(target).status, 404, target);
  });
  assert.deepEqual(service.reads, []);
});

// The lines that the server sent to the app since `from`
const linesSince = (service, from) => service.logs.slice(from);

test('each request sends one line to the app, with its route cut to 80 characters', () => {
  const fileName = PREFIX + '7.jpg';
  const service = loadService({ files: { [DOCUMENTS + fileName]: 'jpeg data' } });
  let from = service.logs.length;
  assert.equal(service.request('/' + fileName).status, 200);
  assert.deepEqual(linesSince(service, from), ['Successfully served fallback binary image from ' + DOCUMENTS + fileName]);
  from = service.logs.length;
  assert.equal(service.request('/' + PREFIX + '8.jpg').status, 404);
  assert.deepEqual(linesSince(service, from), ['Route not found in routeMap or fallbacks for: /' + PREFIX + '8.jpg']);
  from = service.logs.length;
  assert.equal(service.request('/etc/passwd').status, 404);
  assert.deepEqual(linesSince(service, from), ['Rejected a request for a route that is not a preview file name: /etc/passwd']);

  // A route of 100,000 characters, of which a line shows the first 80 and the length
  from = service.logs.length;
  const long = '/' + 'x'.repeat(100000);
  assert.equal(service.request(long).status, 404);
  assert.deepEqual(linesSince(service, from), ['Rejected a request for a route that is not a preview file name: ' + long.slice(0, 80) + '... (100001 characters)']);
  // A route of 80 characters shows whole
  from = service.logs.length;
  const exact = '/' + 'y'.repeat(79);
  service.request(exact);
  assert.deepEqual(linesSince(service, from), ['Rejected a request for a route that is not a preview file name: ' + exact]);
  service.logs.forEach((line) => assert.ok(line.length < 250, String(line.length)));
});

test('at most five lines per minute about requests that were not served reach the app', () => {
  const service = loadService({ files: { [DOCUMENTS + PREFIX + '7.jpg']: 'jpeg data' } });
  const from = service.logs.length;
  // A device that asks for 300 routes within a few seconds: routes that are no preview file names, and preview file
  // names that exist nowhere
  for (let i = 0; i < 300; i++) {
    assert.equal(service.request(i % 2 ? '/etc/passwd' + i : '/' + PREFIX + (1000 + i) + '.jpg').status, 404);
    service.clock.now += 10;
  }
  const first = linesSince(service, from);
  assert.equal(first.length, 5, first.join('\n'));
  assert.deepEqual(first.map((line) => /^(Rejected a request for a route that is not a preview file name|Route not found in routeMap or fallbacks for): /.test(line)), [true, true, true, true, true]);
  // A request that is served still gets its line in between
  assert.equal(service.request('/' + PREFIX + '7.jpg').status, 200);
  assert.equal(linesSince(service, from).length, 6);
  assert.match(service.logs[service.logs.length - 1], /^Successfully served fallback binary image from /);

  // Less than a minute after the first line: still nothing
  service.clock.now += 50000;
  service.request('/etc/shadow');
  assert.equal(linesSince(service, from).length, 6);
  // A minute after it, the next line names how many were left out
  service.clock.now += 10000;
  service.request('/etc/shadow');
  const later = linesSince(service, from);
  assert.equal(later.length, 7);
  assert.equal(later[6], 'Rejected a request for a route that is not a preview file name: /etc/shadow (296 more lines of this kind were left out since the last one)');
  // And five lines per minute again
  for (let i = 0; i < 50; i++) {
    service.request('/x' + i);
  }
  assert.equal(linesSince(service, from).length, 11);
  // A clock that was set back doesn't silence the lines for good
  service.clock.now -= 3600000;
  service.request('/y');
  assert.equal(linesSince(service, from).length, 12);
  assert.match(service.logs[service.logs.length - 1], /\/y \(46 more lines of this kind were left out since the last one\)$/);
});

test('at most sixty lines per minute about served requests reach the app, and every request is answered', () => {
  const service = loadService({ files: { [DOCUMENTS + PREFIX + '7.jpg']: 'jpeg data' } });
  const from = service.logs.length;
  for (let i = 0; i < 500; i++) {
    const response = service.request('/' + PREFIX + '7.jpg?v=' + i);
    assert.deepEqual([response.status, response.body], [200, 'jpeg data']);
  }
  assert.equal(linesSince(service, from).length, 60);
  // The limit of the lines about requests that weren't served is its own
  service.request('/etc/passwd');
  assert.equal(linesSince(service, from).length, 61);
  service.clock.now += 60000;
  service.request('/' + PREFIX + '7.jpg');
  assert.equal(service.logs[service.logs.length - 1], 'Successfully served fallback binary image from ' + DOCUMENTS + PREFIX + '7.jpg (440 more lines of this kind were left out since the last one)');
  const source = fs.readFileSync(SERVICE_FILE, 'utf8');
  assert.match(source, /var LOG_ROUTE_MAX_LENGTH = 80;/);
  assert.match(source, /var REJECTED_LOG_LINES_PER_MINUTE = 5;\s+var SERVED_LOG_LINES_PER_MINUTE = 60;\s+var LOG_LIMIT_WINDOW_MS = 60000;/);
});
