'use strict';

// Checks the continuousAudio parameter of the launch and resume requests (NvHTTP.launchApp() and resumeApp() in
// wasm/static/js/utils.js): with it, Sunshine keeps sending audio packets during silence (fbcf2116, from
// v2026.516.143833 on; other hosts ignore it). It is in the request only while the setting 'Continuous audio from the
// host' is on, so that the request without it is exactly the one of earlier versions for an A/B test.
// tests/browser/continuous-audio.test.js checks the setting and that the start of a stream passes it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('crypto');
const { createPlatformContext } = require('./helpers/platform-loader');

// Load utils.js with a sendMessage() that records the URL of every request
function loadUtils() {
  // The unique ID of every request comes from the random generator of the browser
  const platform = createPlatformContext({ globals: { crypto: webcrypto } });
  platform.load('wasm/static/js/utils.js');
  platform.run('var __urls = []; sendMessage = function(method, params) { __urls.push(params[0]); return Promise.resolve(); };');
  platform.run("var __host = new NvHTTP('192.168.0.10', '0123456789abcdef', '', ''); __host._baseUrlHttps = 'https://192.168.0.10:47984';");
  return platform;
}

const query = (url) => new URL(url).searchParams;

test('the launch and resume requests ask for continuous audio only while it is on', () => {
  const platform = loadUtils();
  platform.run("__host.launchApp(7, '3840x2160x60', 0, 'KEY', 1, 1, 0, 0x030002, 1, 1);");
  platform.run("__host.resumeApp('3840x2160x60', 0, 'KEY', 1, 1, 0, 0x030002, 1, 1);");
  platform.run("__host.launchApp(7, '3840x2160x60', 0, 'KEY', 1, 1, 0, 0x030002, 1, 0);");
  platform.run("__host.resumeApp('3840x2160x60', 0, 'KEY', 1, 1, 0, 0x030002, 1, 0);");
  // Without the random ID of each request
  const urls = JSON.parse(platform.get('JSON.stringify(__urls)')).map((url) => url.replace(/&uuid=[0-9a-f-]+/, ''));
  assert.equal(urls.length, 4);
  assert.deepEqual(urls.map((url) => new URL(url).pathname), ['/launch', '/resume', '/launch', '/resume']);
  assert.deepEqual(urls.map((url) => query(url).get('continuousAudio')), ['1', '1', null, null]);
  // The parameter is added at the end; the rest of the request stays the one of earlier versions
  assert.equal(urls[0], urls[2] + '&continuousAudio=1');
  assert.equal(urls[1], urls[3] + '&continuousAudio=1');
  assert.equal(query(urls[0]).get('appid'), '7');
  assert.equal(query(urls[0]).get('gcmap'), '1');
});
