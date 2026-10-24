'use strict';

// Pins the current behaviour of the in-app update check, checkVersionUpdate() in wasm/platform/index.js, which compares
// the version of the installed app with the tag of the latest GitHub release (without its leading 'v').

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

const platform = loadPlatformScripts(INDEX_SCRIPTS);
const checkVersionUpdate = platform.get('checkVersionUpdate');

test('a higher patch, minor or major version is an update', () => {
  assert.equal(checkVersionUpdate('1.19.0', '1.19.1'), true);
  assert.equal(checkVersionUpdate('1.19.0', '1.20.0'), true);
  assert.equal(checkVersionUpdate('1.19.0', '2.0.0'), true);
  assert.equal(checkVersionUpdate('1.19.9', '1.20.0'), true);
});

test('the parts are compared as numbers, not as text', () => {
  assert.equal(checkVersionUpdate('1.9.0', '1.10.0'), true);
  assert.equal(checkVersionUpdate('1.10.0', '1.9.0'), false);
});

test('the same or a lower version is no update', () => {
  assert.equal(checkVersionUpdate('1.19.0', '1.19.0'), false);
  assert.equal(checkVersionUpdate('1.19.1', '1.19.0'), false);
  assert.equal(checkVersionUpdate('2.0.0', '1.99.99'), false);
});

test('a missing version is no update', () => {
  assert.equal(checkVersionUpdate('', '1.19.1'), false);
  assert.equal(checkVersionUpdate('1.19.0', ''), false);
  assert.equal(checkVersionUpdate(null, '1.19.1'), false);
  assert.equal(checkVersionUpdate('1.19.0', undefined), false);
});

test('a fourth part in the installed version is ignored once the release is higher', () => {
  assert.equal(checkVersionUpdate('1.19.0.1', '1.19.1'), true);
});

test('current behaviour: a release tag with a suffix is never an update (plan C5, changed by WP5)', () => {
  // The part with the suffix ("0-s90c") is NaN, which compares neither higher nor lower, so the check stays quiet.
  // The fork's tag v1.19.0-s90c.2 was chosen for that reason (docs/RELEASE_NOTES_STABLE.md).
  assert.equal(checkVersionUpdate('1.19.0', '1.19.0-s90c.2'), false);
  // A shorter installed version also never sees the extra part of the release as higher
  assert.equal(checkVersionUpdate('1.19', '1.19.1'), false);
});

test('a newer x.y.z release with a suffix is detected as an update', {
  todo: 'Known gap C5 (plan WP5): a suffix makes the compared part NaN, so a fork release can never be announced',
}, () => {
  assert.equal(checkVersionUpdate('1.19.0', '1.19.1-s90c.1'), true);
});
