'use strict';

// Checks the box art server of the Smart Hub preview service (res/service/service.js). It listens on every network
// interface of the TV (port 8889), so any device on the LAN can send it a request. It must answer only a plain preview
// file name such as '/preview-s90c-881448767.jpg' and build the file path from that name alone: a route with '..', a
// further slash, a percent-encoded character, an absolute path or another extension gets a 404 and never reaches the
// file system. The service runs in a Node vm context with simulated Tizen APIs and simulated `http` and `fs` modules
// that record what the server reads.

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
  const service = loadService({
    appControl: previewAppControl([
      { title: 'Desktop', image_url: 'http://127.0.0.1:8889' + route + '?v=1', txtPath: '/opt/usr/apps/boxart/7.jpg' },
    ]),
    files: { '/opt/usr/apps/boxart/7.jpg': 'box art' },
  });
  const response = service.request(route + '?v=2');
  assert.equal(response.status, 200);
  assert.equal(response.body, 'box art');
  assert.deepEqual(service.reads, ['/opt/usr/apps/boxart/7.jpg']);
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
