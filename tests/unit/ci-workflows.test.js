'use strict';

// Checks the two workflows that test every change (2.3.5), and the npm scripts that they run:
// - Module build (module-build.yml) builds the widget file with the toolchain of the release whenever a source that the
//   Dockerfile copies into the build changes: its path filters cover every COPY of the Dockerfile (a source that no
//   filter covers would change the module without a build), the same for pushes and pull requests; it builds exactly
//   like the Standard step of the release (the same build arguments, compared as text, so the two can't drift), pushes
//   no image, uses no registry and only reads the repository
// - Tests (tests.yml) runs the browser tests in shards of the test files next to the other suites, and its job `tests`,
//   whose check run the promotion of a release reads, passes only when every other job passed
// - the npm scripts give the spec report, which ends with the list of the failed tests, also in a log, and pass the
//   shard of the CI to `node --test`

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { TESTS_ROOT } = require('../lib/dev-modules');
const { readDockerfile, dockerInstructions } = require('./helpers/dockerfile');
const { readWorkflow, jobs, keyValue, keyBlock, steps, listItems } = require('./helpers/workflows');

const SCRIPTS = JSON.parse(fs.readFileSync(path.join(TESTS_ROOT, 'package.json'), 'utf8')).scripts;

// The sources of the Dockerfile that need no build when they change, with the reason
const NOT_FILTERED = {
  '.gi[t]/': 'The git metadata of the checkout (for the commit in the app): it changes with every commit, and the build runs for the sources that change with it.',
};

// A path filter of GitHub as a regular expression: ** any path, * any name within a folder
function filterPattern(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**', i)) {
      source += '.*';
      i++;
    } else if (glob[i] === '*') {
      source += '[^/]*';
    } else {
      source += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + source + '$');
}

// Whether a filter covers a source of the Dockerfile: it matches the source or a file below it (a folder, or a glob of
// the Dockerfile such as wasm/*.cpp, taken as its literal text)
function covers(filters, source) {
  const plain = source.replace(/\/$/, '');
  return filters.some((glob) => filterPattern(glob).test(plain) || filterPattern(glob).test(plain + '/file'));
}

// The sources of every COPY of the Dockerfile that copies from the build context (not --from another stage)
function dockerfileSources() {
  const sources = [];
  dockerInstructions(readDockerfile()).filter((instruction) => instruction.name === 'COPY').forEach((instruction) => {
    const words = instruction.args.trim().split(/\s+/);
    if (words.some((word) => /^--from=/.test(word))) {
      return;
    }
    const paths = words.filter((word) => word.indexOf('--') !== 0);
    paths.slice(0, -1).forEach((source) => sources.push(source));
  });
  return sources;
}

const moduleBuild = () => readWorkflow('module-build.yml');
const triggers = (text) => keyBlock(text.split('\n'), 0, 'on');
const pathFilters = (text, event) => listItems(keyBlock(keyBlock(triggers(text), 2, event) || [], 4, 'paths'));

test('Module build runs on a push or pull request that changes a source of the Dockerfile, and by hand', () => {
  const text = moduleBuild();
  const push = pathFilters(text, 'push');
  const pull = pathFilters(text, 'pull_request');
  assert.ok(push.length > 0, 'the paths of push');
  assert.deepEqual(pull, push, 'the same paths for pull requests');
  assert.ok(keyBlock(triggers(text), 2, 'workflow_dispatch') !== null || triggers(text).some((line) => /^ {2}workflow_dispatch:/.test(line)), 'started by hand');
  // Every source that a COPY takes from the repository is covered, or listed above with its reason
  const sources = dockerfileSources();
  ['CMakeLists.txt', 'libgamestream', 'moonlight-common-c', 'opus', 'wasm/*.cpp', 'LICENSE', 'res/', 'wasm/platform/', 'wasm/static/',
    'tools/patch-embind-string.js', '.gi[t]/'].forEach((source) => assert.ok(sources.indexOf(source) >= 0, 'the Dockerfile copies ' + source));
  sources.forEach((source) => {
    if (NOT_FILTERED[source]) {
      assert.ok(!covers(push, source), source + ' is listed as not filtered, but a filter covers it');
      return;
    }
    assert.ok(covers(push, source), 'no path filter of module-build.yml covers the source ' + source + ' of the Dockerfile');
  });
  // So are the Dockerfile, its ignore file and the workflow itself
  ['Dockerfile', '.dockerignore', '.github/workflows/module-build.yml'].forEach((file) => assert.ok(covers(push, file), file));
  // The tests and the documents don't start it
  ['tests/unit/changelog.test.js', 'docs/GUIDE.md', 'CHANGELOG.md', '.github/workflows/tests.yml'].forEach((file) => assert.ok(!covers(push, file), file));
});

test('Module build builds the widget file like the Standard step of the release, and pushes nothing', () => {
  const text = moduleBuild();
  const all = jobs(text);
  assert.deepEqual(Object.keys(all), ['module-build']);
  const job = all['module-build'];
  assert.equal(keyValue(job, 4, 'runs-on'), 'ubuntu-latest', 'the runner of the release');
  assert.ok(Number(keyValue(job, 4, 'timeout-minutes')) > 0);
  const build = steps(job).find((step) => step.name === 'Build the widget file (Standard variant)');
  assert.ok(build, 'the build step');
  assert.match(build.uses, /^docker\/build-push-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  assert.equal(keyValue(build.with, 10, 'context'), '.');
  assert.equal(keyValue(build.with, 10, 'target'), 'wgt');
  assert.equal(keyValue(build.with, 10, 'push'), 'false');
  assert.match(keyValue(build.with, 10, 'outputs'), /^type=local,dest=out\/standard$/);
  // No registry, login, image tags or registry cache
  assert.doesNotMatch(text, /ghcr\.io|registry|docker\/login-action|docker\/metadata-action|^\s+tags:|cache-(from|to):|push: true|secrets\./mi);
  // The same build arguments as the Standard step of the release
  const release = steps(jobs(readWorkflow('release-development.yml'))['build-and-release']).find((step) => step.name === 'Build the widget file (Standard variant)');
  const args = (step) => (keyBlock(step.with, 10, 'build-args') || []).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(args(build), args(release));
  assert.deepEqual(args(build), ['BUILD_TYPE=development', 'REPO_OWNER=${{ github.repository_owner }}', 'REPO_NAME=${{ github.event.repository.name }}', 'FORCE_GAME_MODE=false']);
  // It checks that the widget file holds the three files of the module
  const check = steps(job).find((step) => step.name === 'Check the widget file');
  assert.ok(check && check.run, 'the check of the widget file');
  ['moonlight-wasm.js', 'moonlight-wasm.wasm', 'moonlight-wasm.worker.js'].forEach((file) => assert.ok(check.run.indexOf(file) >= 0, file));
  // It only reads the repository
  assert.deepEqual(keyBlock(text.split('\n'), 0, 'permissions').map((line) => line.trim()).filter((line) => line && line[0] !== '#'), ['contents: read']);
});

test('the check of the widget file of Module build passes with the module and names a missing file', { skip: !hasZip() && 'zip and unzip are not installed' }, (t) => {
  const check = steps(jobs(moduleBuild())['module-build']).find((step) => step.name === 'Check the widget file');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'moonlight-module-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pack = (files) => {
    const content = path.join(dir, 'content');
    fs.rmSync(content, { recursive: true, force: true });
    fs.mkdirSync(path.join(content, 'static'), { recursive: true });
    files.concat(['config.xml', 'static/x.js']).forEach((file) => fs.writeFileSync(path.join(content, file), file));
    fs.mkdirSync(path.join(dir, 'out', 'standard'), { recursive: true });
    fs.rmSync(path.join(dir, 'out', 'standard', 'Moonlight.wgt'), { force: true });
    childProcess.execFileSync('zip', ['-qr', path.join(dir, 'out', 'standard', 'Moonlight.wgt'), '.'], { cwd: content });
    return childProcess.spawnSync('bash', ['-c', check.run], { cwd: dir, encoding: 'utf8' });
  };
  const complete = pack(['moonlight-wasm.js', 'moonlight-wasm.wasm', 'moonlight-wasm.worker.js', 'moonlight-wasm.js.mem']);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  assert.match(complete.stdout, /The widget file holds the module\./);
  // A file of the same name in a folder doesn't count
  const missing = pack(['moonlight-wasm.js', 'moonlight-wasm.wasm', 'static/moonlight-wasm.worker.js']);
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /The widget file lacks moonlight-wasm\.worker\.js\./);
});

function hasZip() {
  return ['zip', 'unzip'].every((tool) => childProcess.spawnSync('sh', ['-c', 'command -v ' + tool], { stdio: 'ignore' }).status === 0);
}

test('Tests runs the browser tests in shards next to the other suites, and its job tests needs all of them', () => {
  const text = readWorkflow('tests.yml');
  const all = jobs(text);
  assert.deepEqual(Object.keys(all).sort(), ['browser', 'checks', 'tests']);
  Object.entries(all).forEach(([id, job]) => {
    assert.ok(Number(keyValue(job, 4, 'timeout-minutes')) > 0, id + ': a timeout');
    assert.equal(keyValue(job, 4, 'runs-on'), 'ubuntu-24.04', id);
  });
  // The shards 1..N of the matrix, each with TEST_SHARD k/N
  const browser = all.browser;
  const matrix = keyBlock(keyBlock(browser, 4, 'strategy'), 6, 'matrix');
  assert.equal(keyValue(keyBlock(browser, 4, 'strategy'), 6, 'fail-fast'), 'false');
  const shards = JSON.parse(keyValue(matrix, 8, 'shard'));
  assert.ok(shards.length >= 2, 'shards: ' + shards);
  assert.deepEqual(shards, shards.map((shard, index) => index + 1));
  const run = steps(browser).find((step) => step.run === 'npm run test:browser');
  assert.ok(run, 'the browser job runs npm run test:browser');
  assert.equal(keyValue(run.env, 10, 'TEST_SHARD'), '${{ matrix.shard }}/' + shards.length);
  assert.equal(keyValue(run.env, 10, 'MOONLIGHT_PINNED_CHROMIUM'), "'1'", 'the CI stops on another Chromium build');
  assert.ok(steps(browser).some((step) => step.run === 'npm run install:browser'), 'the browser job installs the pinned headless Chromium');
  assert.match(keyValue(browser, 4, 'name'), new RegExp('/' + shards.length + '\\)$'));
  // The other job runs every other suite
  const checks = steps(all.checks).map((step) => step.run);
  ['npm ci', 'npm run test:tools', 'npm run test:unit', 'npm run test:native'].forEach((command) => assert.ok(checks.indexOf(command) >= 0, command));
  // The job tests needs every other job, also after a failure, and checks each result
  const summary = all.tests;
  assert.equal(keyValue(summary, 4, 'name'), undefined, 'the check run keeps the name of the job, tests, which the promotion reads');
  assert.deepEqual(JSON.parse(keyValue(summary, 4, 'needs').replace(/(\w+)/g, '"$1"')).sort(), ['browser', 'checks']);
  assert.equal(keyValue(summary, 4, 'if'), '${{ !cancelled() }}');
  const step = steps(summary)[0];
  ['checks', 'browser'].forEach((job) => assert.ok(step.env.some((line) => line.indexOf('${{ needs.' + job + '.result }}') >= 0), job));
});

test('the job tests of Tests passes only when every other job passed', () => {
  const step = steps(jobs(readWorkflow('tests.yml')).tests)[0];
  const env = {};
  step.env.forEach((line) => {
    const match = /^\s+(\w+): \$\{\{ needs\.(\w+)\.result \}\}$/.exec(line);
    if (match) {
      env[match[2]] = match[1];
    }
  });
  assert.deepEqual(Object.keys(env).sort(), ['browser', 'checks']);
  const run = (checks, browser) => childProcess.spawnSync('bash', ['-e', '-c', step.run], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { [env.checks]: checks, [env.browser]: browser }),
  });
  assert.equal(run('success', 'success').status, 0);
  [['success', 'failure'], ['failure', 'success'], ['skipped', 'success'], ['success', 'cancelled'], ['', '']].forEach(([checks, browser]) => {
    const result = run(checks, browser);
    assert.equal(result.status, 1, checks + '/' + browser + ': ' + result.stdout);
    assert.ok(result.stdout.indexOf('Tools, unit and native tests: ' + checks + '\n') >= 0 && result.stdout.indexOf('Browser tests: ' + browser + '\n') >= 0, result.stdout);
  });
});

test('the npm scripts give the spec report also in a log, and the browser tests take the shard of the CI', () => {
  // node --test reads its options before the first test pattern only
  ['test:unit', 'test:browser'].forEach((name) => {
    const script = SCRIPTS[name];
    const glob = script.indexOf('"' + name.split(':')[1] + '/**/*.test.js"');
    assert.ok(glob > 0, name + ': ' + script);
    [' --test-reporter=spec ', ' --test-reporter-destination=stdout '].forEach((option) => {
      assert.ok(script.indexOf(option) > 0 && script.indexOf(option) < glob, name + ' passes' + option + 'before its glob');
    });
  });
  const browser = SCRIPTS['test:browser'];
  assert.ok(browser.indexOf(' ${TEST_SHARD:+--test-shard=$TEST_SHARD} ') > 0 && browser.indexOf('${TEST_SHARD') < browser.indexOf('"browser/'), browser);
  // How sh expands it: nothing without TEST_SHARD, the option with it
  const expand = (shard) => childProcess.execFileSync('sh', ['-c', 'printf "%s|" ${TEST_SHARD:+--test-shard=$TEST_SHARD}'], {
    encoding: 'utf8', env: Object.assign({}, process.env, { TEST_SHARD: shard }),
  });
  assert.equal(expand(''), '|');
  assert.equal(expand('2/2'), '--test-shard=2/2|');
  // The check of the Chromium build runs before the browser tests, and the CI installs the headless shell
  assert.equal(SCRIPTS['pretest:browser'], 'node tools/check-browser-build.js');
  assert.equal(SCRIPTS['install:browser'], 'playwright install --with-deps --only-shell chromium');
});
