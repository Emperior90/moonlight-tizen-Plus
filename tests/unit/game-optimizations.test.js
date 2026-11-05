'use strict';

// Checks the sops value that the launch and resume requests send for 'Optimize game settings'
// (getGameOptimizationsRequest() in wasm/platform/index.js): Sunshine and the hosts based on it get the setting as it
// is, since they only use it to switch the display of the host to the stream; GeForce Experience, which rewrites the
// settings of the game and sets them to 720p at 60 FPS for a resolution it doesn't know or more than 60 FPS, gets it
// only at 720p, 1080p or 4K at up to 60 FPS and at a display mode that the host lists, like moonlight-qt (session.cpp)
// and moonlight-android (NvHTTP.java) do. Since 2.3.0 the setting is on by default (tv-profile.test.js), so this keeps
// the default safe on a GeForce Experience host. browser/game-optimizations.test.js checks that the start of a stream
// sends it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

const platform = loadPlatformScripts(INDEX_SCRIPTS);
const request = platform.get('getGameOptimizationsRequest');

// The display modes of a host as NvHTTP (utils.js) keeps them: height:width -> refresh rates
const GFE_MODES = { '720:1280': [60], '1080:1920': [60, 120], '2160:3840': [60], '1440:2560': [60, 144] };

test('Sunshine-based hosts get the setting as it is, at every resolution and frame rate', () => {
  for (const host of [{ isNvidiaServerSoftware: false }, { isNvidiaServerSoftware: false, supportedDisplayModes: {} }, {}, null]) {
    for (const [width, height] of [['1280', '720'], ['1920', '1080'], ['2560', '1440'], ['3200', '1800'], ['3840', '2160']]) {
      for (const fps of ['30', '60', '90', '120']) {
        assert.equal(request(host, width, height, fps, true), 1, JSON.stringify(host) + ' ' + width + 'x' + height + '@' + fps);
        assert.equal(request(host, width, height, fps, false), 0);
      }
    }
  }
});

test('GeForce Experience gets it only at 720p, 1080p or 4K, at up to 60 FPS', () => {
  const gfe = { isNvidiaServerSoftware: true, supportedDisplayModes: GFE_MODES };
  assert.equal(request(gfe, '1280', '720', '60', true), 1);
  assert.equal(request(gfe, '1920', '1080', '30', true), 1);
  assert.equal(request(gfe, '3840', '2160', '60', true), 1);
  // A resolution that GeForce Experience doesn't know for its game settings, even when the host lists it as a mode
  assert.equal(request(gfe, '2560', '1440', '60', true), 0);
  assert.equal(request(gfe, '3200', '1800', '60', true), 0);
  assert.equal(request(gfe, '854', '480', '60', true), 0);
  // More than 60 FPS
  assert.equal(request(gfe, '1920', '1080', '90', true), 0);
  assert.equal(request(gfe, '1920', '1080', '120', true), 0);
  assert.equal(request(gfe, '3840', '2160', '120', true), 0);
  // Off stays off
  assert.equal(request(gfe, '1920', '1080', '60', false), 0);
});

test('GeForce Experience gets it only at a display mode that the host lists, when it lists any', () => {
  const only1080p = { isNvidiaServerSoftware: true, supportedDisplayModes: { '1080:1920': [60] } };
  assert.equal(request(only1080p, '1920', '1080', '60', true), 1);
  assert.equal(request(only1080p, '3840', '2160', '60', true), 0);
  assert.equal(request(only1080p, '1280', '720', '60', true), 0);
  // A host that lists no display modes: the three resolutions that GeForce Experience knows
  for (const host of [{ isNvidiaServerSoftware: true, supportedDisplayModes: {} }, { isNvidiaServerSoftware: true }]) {
    assert.equal(request(host, '3840', '2160', '60', true), 1);
    assert.equal(request(host, '2560', '1440', '60', true), 0);
  }
});

test('the start of a stream sends the result to the launch and resume requests, and logs when it holds it back', () => {
  const index = require('fs').readFileSync(require('path').join(require('../lib/dev-modules').REPO_ROOT, 'wasm', 'platform', 'index.js'), 'utf8');
  assert.match(index, /const optimizeGames = getGameOptimizationsRequest\(host, streamWidth, streamHeight, frameRate, optimizeGamesSetting\);/);
  assert.equal((index.match(/optimizeGames, \/\/ Optimize game settings \(SOPS\)/g) || []).length, 2);
  assert.match(index, /not sent to GeForce Experience at this resolution and frame rate/);
});
