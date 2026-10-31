'use strict';

// Checks the audio parameters of the launch and resume requests (NvHTTP.launchApp() and resumeApp() in
// wasm/static/js/utils.js): with continuousAudio, Sunshine keeps sending audio packets during silence (fbcf2116, from
// v2026.516.143833 on; other hosts ignore it). It is in the request only when the caller passes it, so that the request
// without it is exactly the one of earlier versions; the start of a stream always passes it. The surroundAudioInfo of
// each audio configuration of the settings (getSurroundAudioInfo() in wasm/platform/index.js) is the value that
// moonlight-common-c defines for it. tests/browser/continuous-audio.test.js checks that the start of a stream passes
// both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, createPlatformContext, loadPlatformScripts } = require('./helpers/platform-loader');

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

test('the launch and resume requests ask for continuous audio only when the caller passes it', () => {
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

test('the surroundAudioInfo of each audio configuration is the channel mask << 16 | the channel count of moonlight-common-c', () => {
  // AUDIO_CONFIGURATION_STEREO, _51_SURROUND and _71_SURROUND are MAKE_AUDIO_CONFIGURATION(channelCount, channelMask)
  const header = fs.readFileSync(path.join(REPO_ROOT, 'moonlight-common-c', 'src', 'Limelight.h'), 'utf8');
  const fromHeader = (name) => {
    const match = new RegExp('#define AUDIO_CONFIGURATION_' + name + ' MAKE_AUDIO_CONFIGURATION\\((\\d+), (0x[0-9A-Fa-f]+)\\)').exec(header);
    assert.ok(match, name);
    return (parseInt(match[2], 16) << 16) | parseInt(match[1], 10);
  };
  const platform = loadPlatformScripts(INDEX_SCRIPTS);
  const surroundAudioInfo = platform.get('getSurroundAudioInfo');
  assert.equal(surroundAudioInfo('Stereo'), fromHeader('STEREO'));
  assert.equal(surroundAudioInfo('51Surround'), fromHeader('51_SURROUND'));
  assert.equal(surroundAudioInfo('71Surround'), fromHeader('71_SURROUND'));
  assert.deepEqual([fromHeader('STEREO'), fromHeader('51_SURROUND'), fromHeader('71_SURROUND')], [0x030002, 0x3F0006, 0x63F0008]);
  // The values of the audio configuration menu are exactly these three
  const html = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'index.html'), 'utf8');
  const menu = /<ul[^>]*audioConfigMenu[^>]*>([\s\S]*?)<\/ul>/.exec(html);
  assert.ok(menu);
  assert.deepEqual(Array.from(menu[1].matchAll(/data-value="([^"]+)"/g), (match) => match[1]), ['Stereo', '51Surround', '71Surround']);
  // Anything else is stereo, like the module streams it (wasm/main.cpp)
  assert.equal(surroundAudioInfo('Quad'), 0x030002);
  assert.equal(surroundAudioInfo(undefined), 0x030002);
});
