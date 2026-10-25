'use strict';

// Checks the in-app update check, checkVersionUpdate() in wasm/platform/index.js, which compares the version of the
// installed app (the plain x.y.z of res/config.xml) with the tag of the latest GitHub release (without its leading
// 'v'). Since plan WP5 it compares the numeric x.y.z first and then the number at the end of a suffix, so that a
// release of this fork such as v1.19.100 is announced, and a missing or malformed version is never an update.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

const platform = loadPlatformScripts(INDEX_SCRIPTS);
const checkVersionUpdate = platform.get('checkVersionUpdate');
const parseAppVersion = platform.get('parseAppVersion');

test('the cases of plan WP5', () => {
  // The first release of this fork is announced to an installed upstream 1.19.0 build or a build of this fork before it
  assert.equal(checkVersionUpdate('1.19.0', '1.19.100'), true);
  assert.equal(checkVersionUpdate('1.19.100', '1.19.100'), false);
  // The earlier release v1.19.0-s90c.1 is the build that installs as 1.19.0, so it is no update for it
  assert.equal(checkVersionUpdate('1.19.0', '1.19.0-s90c.1'), false);
  assert.equal(checkVersionUpdate('1.19.100', '1.20.0'), true);
  assert.equal(checkVersionUpdate('1.19.100', 'not-a-version'), false);
  assert.equal(checkVersionUpdate('not-a-version', '1.19.100'), false);
});

test('a higher patch, minor or major version is an update', () => {
  assert.equal(checkVersionUpdate('1.19.0', '1.19.1'), true);
  assert.equal(checkVersionUpdate('1.19.0', '1.20.0'), true);
  assert.equal(checkVersionUpdate('1.19.0', '2.0.0'), true);
  assert.equal(checkVersionUpdate('1.19.9', '1.20.0'), true);
  assert.equal(checkVersionUpdate('1.19.100', '1.19.101'), true);
});

test('the parts are compared as numbers, not as text', () => {
  assert.equal(checkVersionUpdate('1.9.0', '1.10.0'), true);
  assert.equal(checkVersionUpdate('1.10.0', '1.9.0'), false);
  assert.equal(checkVersionUpdate('1.19.99', '1.19.100'), true);
  assert.equal(checkVersionUpdate('1.19.100', '1.19.99'), false);
  assert.equal(checkVersionUpdate('1.19.0', '1.19.00'), false);
});

test('the same or a lower version is no update', () => {
  assert.equal(checkVersionUpdate('1.19.0', '1.19.0'), false);
  assert.equal(checkVersionUpdate('1.19.1', '1.19.0'), false);
  assert.equal(checkVersionUpdate('2.0.0', '1.99.99'), false);
  // A release of upstream Moonlight Tizen below the version of this fork is no update for it
  assert.equal(checkVersionUpdate('1.19.100', '1.19.1'), false);
});

test('a missing version is no update', () => {
  assert.equal(checkVersionUpdate('', '1.19.1'), false);
  assert.equal(checkVersionUpdate('1.19.0', ''), false);
  assert.equal(checkVersionUpdate(null, '1.19.1'), false);
  assert.equal(checkVersionUpdate('1.19.0', undefined), false);
  assert.equal(checkVersionUpdate(undefined, undefined), false);
});

test('a malformed version is no update, in either position', () => {
  const malformed = ['1.19', '1', '1.19.x', '1..19', '1.19.0 beta', 'v', 'latest', '-1.19.1', '1.19.1.', ' . . ', '1,19,1'];
  malformed.forEach((version) => {
    assert.equal(checkVersionUpdate('1.19.0', version), false, 'latest ' + JSON.stringify(version));
    assert.equal(checkVersionUpdate(version, '9.99.999'), false, 'current ' + JSON.stringify(version));
  });
  // Values of another type, e.g. a cached version that was stored as a number, or a broken API reply
  [1.19, 2, {}, [], true].forEach((version) => {
    assert.equal(checkVersionUpdate('1.19.0', version), false, 'latest ' + JSON.stringify(version));
    assert.equal(checkVersionUpdate(version, '9.99.999'), false, 'current ' + JSON.stringify(version));
  });
});

test('a fourth part in the installed version is ignored once the release is higher', () => {
  assert.equal(checkVersionUpdate('1.19.0.1', '1.19.1'), true);
  assert.equal(checkVersionUpdate('1.19.0.1', '1.19.0'), false);
});

test('a newer x.y.z release with a suffix is an update, the same x.y.z with a suffix alone is not (plan C5)', () => {
  assert.equal(checkVersionUpdate('1.19.0', '1.19.1-s90c.1'), true);
  assert.equal(checkVersionUpdate('1.19.0', '1.19.0-s90c.2'), false);
  assert.equal(checkVersionUpdate('1.19.100', '1.19.0-s90c.2'), false);
  assert.equal(checkVersionUpdate('1.19.100', '1.20.0-beta'), true);
  assert.equal(checkVersionUpdate('1.19.0', '1.19.0-beta'), false);
  // An installed version is a plain x.y.z on the TV; one with a suffix gets no update from the same x.y.z either
  assert.equal(checkVersionUpdate('1.19.0-s90c.2', '1.19.0'), false);
});

test('with the same x.y.z, the suffix numbers decide when both versions have one', () => {
  assert.equal(checkVersionUpdate('1.19.0-s90c.1', '1.19.0-s90c.2'), true);
  assert.equal(checkVersionUpdate('1.19.0-s90c.2', '1.19.0-s90c.2'), false);
  assert.equal(checkVersionUpdate('1.19.0-s90c.2', '1.19.0-s90c.1'), false);
  assert.equal(checkVersionUpdate('1.19.0-s90c.9', '1.19.0-s90c.10'), true);
  assert.equal(checkVersionUpdate('1.19.0.1', '1.19.0.2'), true);
  assert.equal(checkVersionUpdate('1.19.0-rc2', '1.19.0-rc3'), true);
  // A suffix without a number at its end gives nothing to compare
  assert.equal(checkVersionUpdate('1.19.0-s90c.1', '1.19.0-s90c'), false);
  assert.equal(checkVersionUpdate('1.19.0-s90c', '1.19.0-s90c.1'), false);
});

test('a leading v and surrounding spaces are accepted', () => {
  assert.equal(checkVersionUpdate('1.19.0', 'v1.19.100'), true);
  assert.equal(checkVersionUpdate(' 1.19.0 ', '1.19.100\n'), true);
});

test('parseAppVersion splits a version into its numbers', () => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(parseAppVersion('1.19.100')), { parts: [1, 19, 100], suffixNumber: null });
  assert.deepEqual(plain(parseAppVersion('1.19.0-s90c.2')), { parts: [1, 19, 0], suffixNumber: 2 });
  assert.deepEqual(plain(parseAppVersion('1.19.0-s90c.12')), { parts: [1, 19, 0], suffixNumber: 12 });
  assert.deepEqual(plain(parseAppVersion('1.19.0.1')), { parts: [1, 19, 0], suffixNumber: 1 });
  assert.deepEqual(plain(parseAppVersion('1.19.0-s90c')), { parts: [1, 19, 0], suffixNumber: null });
  assert.equal(parseAppVersion('1.19'), null);
  assert.equal(parseAppVersion(''), null);
  assert.equal(parseAppVersion(null), null);
});

test('the version in res/config.xml is a plain x.y.z that the check reads, and the release of it is no update', () => {
  const widget = /<widget\b[^>]*>/.exec(fs.readFileSync(path.join(REPO_ROOT, 'res/config.xml'), 'utf8'));
  assert.ok(widget, '<widget> not found in res/config.xml');
  const version = /\sversion="([^"]*)"/.exec(widget[0])[1];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.notEqual(parseAppVersion(version), null);
  // The release tag of a version is 'v' plus the version (checked by the promotion in release-development.yml)
  assert.equal(checkVersionUpdate(version, 'v' + version), false);
  assert.equal(checkVersionUpdate('1.19.0', version), true, 'the version of this fork must be newer than upstream 1.19.0');
});
