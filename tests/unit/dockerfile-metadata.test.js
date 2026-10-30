'use strict';

// Runs the step of the Dockerfile that injects the build metadata into wasm/platform/index.js (plan WP5), on a copy of
// the file in a temporary folder, and checks the app it produces:
// - a release or development build fails with a clear message when REPO_OWNER or REPO_NAME is missing or invalid,
//   instead of building an app that checks the upstream repository for updates;
// - a complete build replaces the placeholders, and the in-app update check of the built app reads the releases of
//   the repository it was built from. Before WP5 the build also replaced the placeholder in the fallback comparison
//   of fetchLatestRelease(), so every build of this fork checked the upstream repository.
//
// The step is taken from the Dockerfile itself, joined like Docker joins a RUN instruction (comment lines inside it
// dropped, line continuations removed), and run with `sh` as in the Ubuntu image. It needs GNU sed, as in that image.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { createPlatformContext } = require('./helpers/platform-loader');

const INDEX_PATH = 'moonlight-tizen/wasm/platform/index.js';

// Return the RUN instructions of the Dockerfile as the shell commands Docker runs
function dockerRunCommands() {
  const lines = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8').split(/\r?\n/);
  const commands = [];
  let current = null;
  lines.forEach((line) => {
    // Docker drops comment lines, also inside an instruction that continues over several lines
    if (/^\s*#/.test(line)) {
      return;
    }
    if (current === null) {
      if (!/^RUN\s/.test(line)) {
        return;
      }
      current = '';
      line = line.replace(/^RUN\s/, '');
    }
    if (/\\$/.test(line)) {
      current += line.slice(0, -1);
    } else {
      commands.push(current + line);
      current = null;
    }
  });
  return commands;
}

// The RUN instruction that injects the build metadata
function metadataCommand() {
  const matching = dockerRunCommands().filter((command) => command.includes('__REPO_OWNER__'));
  assert.equal(matching.length, 1, 'expected one RUN instruction that replaces the repository placeholders');
  return matching[0];
}

// Run the metadata step with the given build arguments on a fresh copy of index.js, and return its result and the
// injected file
function runMetadataStep(buildArgs) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-dockerfile-'));
  try {
    fs.mkdirSync(path.join(workDir, path.dirname(INDEX_PATH)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'wasm/platform/index.js'), path.join(workDir, INDEX_PATH));
    // Like the ARG lines of the Dockerfile: BUILD_TYPE defaults to release, the others to empty
    const env = { PATH: process.env.PATH, BUILD_TYPE: 'release', REPO_OWNER: '', REPO_NAME: '' };
    Object.assign(env, buildArgs);
    const result = childProcess.spawnSync('sh', ['-c', metadataCommand()], { cwd: workDir, env, encoding: 'utf8' });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      index: fs.readFileSync(path.join(workDir, INDEX_PATH), 'utf8'),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Load an index.js source into a platform context and return the URL that the update check fetches
async function updateCheckUrl(indexSource) {
  const requests = [];
  const fetch = (url) => {
    requests.push(url);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ tag_name: 'v1.19.100', body: "## What's Changed:\n\n- A change\n\n**Full Changelog**: x" }),
    });
  };
  const platform = createPlatformContext({ globals: { fetch } });
  // messages.js comes before index.js in the page, as the release notes of the update check use its escapeHTML()
  platform.load('wasm/platform/messages.js');
  platform.load('wasm/platform/tv_profile.js');
  platform.run(indexSource);
  const release = await platform.get('fetchLatestRelease')();
  assert.equal(release.latestVersion, '1.19.100');
  assert.equal(requests.length, 1);
  return requests[0];
}

const hasGnuSed = childProcess.spawnSync('sed', ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = hasGnuSed ? false : 'needs GNU sed, as in the Ubuntu image of the Dockerfile';

test('the metadata step is found and joined like Docker joins it', { skip: SKIP }, () => {
  const command = metadataCommand();
  assert.ok(command.includes('sed -i "s/__REPO_NAME__/$REPO_NAME/g"'), command);
  assert.ok(!command.includes('#'), 'a comment line was left in the command');
});

test('a release or development build fails clearly without the repository owner or name', { skip: SKIP }, () => {
  const cases = [
    { BUILD_TYPE: 'release' },
    { BUILD_TYPE: 'release', REPO_OWNER: 'someone' },
    { BUILD_TYPE: 'release', REPO_NAME: 'moonlight-tizen-Plus' },
    { BUILD_TYPE: 'development' },
    { BUILD_TYPE: 'development', REPO_NAME: 'moonlight-tizen-Plus' },
  ];
  cases.forEach((buildArgs) => {
    const result = runMetadataStep(buildArgs);
    assert.notEqual(result.status, 0, JSON.stringify(buildArgs));
    assert.match(result.output, /Error: a (release|development) build needs the repository/, JSON.stringify(buildArgs));
    assert.match(result.output, /--build-arg REPO_OWNER=<owner> --build-arg REPO_NAME=<repo>/);
    // Nothing was injected
    assert.ok(result.index.includes("const REPO_OWNER = '__REPO_OWNER__';"), JSON.stringify(buildArgs));
    assert.ok(result.index.includes("const BUILD_TYPE = '__BUILD_TYPE__';"), JSON.stringify(buildArgs));
  });
});

test('a release or development build fails clearly with a repository owner or name that sed would break on', { skip: SKIP }, () => {
  const owner = runMetadataStep({ REPO_OWNER: 'some/one', REPO_NAME: 'repo' });
  assert.notEqual(owner.status, 0);
  assert.match(owner.output, /Error: invalid repo owner 'some\/one'/);
  const name = runMetadataStep({ BUILD_TYPE: 'development', REPO_OWNER: 'someone', REPO_NAME: 'repo&name' });
  assert.notEqual(name.status, 0);
  assert.match(name.output, /Error: invalid repo name 'repo&name'/);
});

test('a complete build injects the repository, and its update check reads the releases of that repository', { skip: SKIP }, async () => {
  for (const buildType of ['release', 'development']) {
    const result = runMetadataStep({ BUILD_TYPE: buildType, REPO_OWNER: 'Some-Owner', REPO_NAME: 'moonlight-tizen-Plus' });
    assert.equal(result.status, 0, result.output);
    assert.ok(result.index.includes("const REPO_OWNER = 'Some-Owner';"));
    assert.ok(result.index.includes("const REPO_NAME = 'moonlight-tizen-Plus';"));
    assert.ok(result.index.includes(`const BUILD_TYPE = '${buildType}';`));
    assert.equal(/__REPO_(OWNER|NAME)__/.test(result.index), false, 'a repository placeholder is left');
    assert.equal(await updateCheckUrl(result.index), 'https://api.github.com/repos/Some-Owner/moonlight-tizen-Plus/releases/latest');
  }
});

test('an app that was not built with the Dockerfile falls back to the upstream repository', { skip: SKIP }, async () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'wasm/platform/index.js'), 'utf8');
  assert.equal(await updateCheckUrl(source), 'https://api.github.com/repos/brightcraft/moonlight-tizen/releases/latest');
  // Another build type than release or development keeps the placeholders it isn't given, and the same fallback
  const other = runMetadataStep({ BUILD_TYPE: 'local' });
  assert.equal(other.status, 0, other.output);
  assert.equal(await updateCheckUrl(other.index), 'https://api.github.com/repos/brightcraft/moonlight-tizen/releases/latest');
});
