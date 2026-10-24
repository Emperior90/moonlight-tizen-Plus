'use strict';

// Static server that assembles the widget the way the build installs it (CMakeLists.txt) straight from the repository,
// with the simulated TV in place of the Tizen runtime and a stub in place of the WebAssembly module:
//   /index.html                    wasm/index.html, with tv-mock.js inserted as the first script of <head>
//   /platform.js                   res/platform.js
//   /platform/*, /static/*         wasm/platform, wasm/static
//   /$WEBAPIS/webapis/webapis.js   tests/browser/mocks/webapis.js (simulated Samsung product APIs)
//   /moonlight-wasm.js             tests/browser/mocks/moonlight-wasm.js (stub of the WebAssembly module)
//   /__test__/*                    tests/browser/mocks (tv-mock.js, blank.html)
//
// Run it on its own to look at the UI in a desktop browser:
//   node tests/browser/server.js [port]
// and open e.g. http://127.0.0.1:8765/index.html?tv=fhd&conn=wifi (see mocks/tv-mock.js for the options).

const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MOCKS_DIR = path.join(__dirname, 'mocks');
const TV_MOCK_TAG = '<script type="text/javascript" src="__test__/tv-mock.js"></script>';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Folders served below a URL prefix, in the layout of the installed widget
const MOUNTS = [
  { prefix: '/platform/', dir: path.join(REPO_ROOT, 'wasm', 'platform') },
  { prefix: '/static/', dir: path.join(REPO_ROOT, 'wasm', 'static') },
  { prefix: '/__test__/', dir: MOCKS_DIR },
];

// Single files served at a fixed URL
const FILES = {
  '/platform.js': path.join(REPO_ROOT, 'res', 'platform.js'),
  '/$WEBAPIS/webapis/webapis.js': path.join(MOCKS_DIR, 'webapis.js'),
  '/moonlight-wasm.js': path.join(MOCKS_DIR, 'moonlight-wasm.js'),
};

// Return index.html with the simulated Tizen runtime loaded before every app script, like on a TV
function renderIndexHtml() {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'index.html'), 'utf8');
  const headMatch = /<head[^>]*>/i.exec(html);
  if (!headMatch) {
    throw new Error('wasm/index.html has no <head> element to insert the simulated TV into');
  }
  const insertAt = headMatch.index + headMatch[0].length;
  return html.slice(0, insertAt) + '\n  ' + TV_MOCK_TAG + html.slice(insertAt);
}

// Map a URL path to a file, or return null if it isn't part of the widget
function resolveFile(urlPath) {
  if (FILES[urlPath]) {
    return FILES[urlPath];
  }
  for (const mount of MOUNTS) {
    if (urlPath.indexOf(mount.prefix) === 0) {
      const file = path.resolve(mount.dir, '.' + path.sep + urlPath.slice(mount.prefix.length));
      // Never serve anything outside the mounted folder
      if (file.indexOf(mount.dir + path.sep) !== 0) {
        return null;
      }
      return file;
    }
  }
  return null;
}

function send(response, status, contentType, body) {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

function handleRequest(request, response) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch (error) {
    send(response, 400, 'text/plain; charset=utf-8', 'Bad request');
    return;
  }

  if (urlPath === '/' || urlPath === '/index.html') {
    try {
      send(response, 200, CONTENT_TYPES['.html'], renderIndexHtml());
    } catch (error) {
      send(response, 500, 'text/plain; charset=utf-8', String(error && error.message));
    }
    return;
  }

  const file = resolveFile(urlPath);
  if (!file) {
    send(response, 404, 'text/plain; charset=utf-8', 'Not found: ' + urlPath);
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      send(response, 404, 'text/plain; charset=utf-8', 'Not found: ' + urlPath);
      return;
    }
    send(response, 200, CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', data);
  });
}

// Start the server on the given port (0 picks a free one) and resolve with its base URL and a close function
function startServer(port, host) {
  const server = http.createServer(handleRequest);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, host || '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://${address.address}:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startServer, renderIndexHtml };

if (require.main === module) {
  const port = parseInt(process.argv[2] || '8765', 10);
  startServer(port).then((server) => {
    console.log(`Serving the widget at ${server.url}/index.html (e.g. ?tv=fhd&conn=wifi), press Ctrl+C to stop`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
