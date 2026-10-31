'use strict';

// Checks the manual workflow "Licence and source assets" (.github/workflows/licence-assets.yml):
// - build-inputs keeps the source archives that docs/BUILD.md names, checked against the same SHA-512 checksums, in
//   the release build-inputs, which never becomes the latest release that the in-app update check reads
// - old-release-notices attaches docs/licenses/THIRD-PARTY-NOTICES-before-2.2.txt and the GPL-3.0 text to exactly the
//   four releases that the notices name, and replaces the files of an earlier run

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOW = read('.github/workflows/licence-assets.yml');
const BUILD = read('docs/BUILD.md');
const OLD_NOTICES = 'docs/licenses/THIRD-PARTY-NOTICES-before-2.2.txt';

test('build-inputs downloads the archives of docs/BUILD.md and checks their checksums', () => {
  const checksums = BUILD.match(/`[0-9a-f]{128}`/g).map((value) => value.slice(1, -1));
  assert.equal(checksums.length, 3, 'OpenSSL, curl and zlib');
  checksums.forEach((checksum) => assert.ok(WORKFLOW.indexOf(checksum) >= 0, checksum));
  ['openssl-1.1.1d.tar.gz', 'curl-7.68.0.tar.bz2', 'emscripten-ports/zlib/archive/version_1.zip'].forEach((name) => {
    assert.ok(BUILD.indexOf(name) >= 0 && WORKFLOW.indexOf(name) >= 0, name);
  });
  assert.match(WORKFLOW, /sha512sum -c -/);
  assert.match(WORKFLOW, /set -euo pipefail/);
});

test('the release build-inputs never becomes the latest release, and a second run replaces its files', () => {
  assert.match(WORKFLOW, /gh release create build-inputs [^\n]*\\\n[^\n]*--latest=false/);
  assert.doesNotMatch(WORKFLOW, /--prerelease|make_latest|--latest(?!=false)/);
  assert.match(WORKFLOW, /gh release upload build-inputs build-inputs\/\* --clobber/);
});

test('old-release-notices attaches the notices and the GPL-3.0 text to the four releases before 2.2.0', () => {
  const notices = read(OLD_NOTICES);
  const tags = ['v1.19.0-s90c.1', 'v1.19.100', 'v1.19.101', 'v2.1.0'];
  assert.match(WORKFLOW, new RegExp('for tag in ' + tags.join(' ').replace(/\./g, '\\.') + '; do'));
  tags.forEach((tag) => assert.ok(notices.indexOf(tag) >= 0, tag));
  assert.match(WORKFLOW, /cp docs\/licenses\/THIRD-PARTY-NOTICES-before-2\.2\.txt notices\/THIRD-PARTY-NOTICES\.txt/);
  assert.match(WORKFLOW, /cp LICENSE notices\/LICENSE\.txt/);
  assert.match(WORKFLOW, /gh release upload "\$tag" notices\/THIRD-PARTY-NOTICES\.txt notices\/LICENSE\.txt --clobber/);
  assert.match(notices, /attached to each of\s+these releases as LICENSE\.txt/);
});

test('each job may only write the contents of the repository, and only when started by hand', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(WORKFLOW, /^ {2}(push|schedule|pull_request)/m);
  assert.equal(WORKFLOW.match(/permissions:\n {6}contents: write\n/g).length, 2);
  assert.doesNotMatch(WORKFLOW, /packages:|secrets\./);
});
