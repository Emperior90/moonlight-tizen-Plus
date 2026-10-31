'use strict';

// Runs shell steps of the release workflow (.github/workflows/release-development.yml, named "Release") with bash
// against a simulated GitHub API (a fake curl on PATH), a fake gh and a temporary git repository:
// - .github/scripts/check-support-path.sh, which the promotion and the pre-release run before they publish, as a
//   warning: Issues must be turned on, and the default branch must have the issue forms and the guide that the README,
//   the release notes and the Support dialog of the app send users to
// - the cleanup of a pre-release run: it deletes the earlier pre-release of exactly this branch and its tag (not that of
//   a branch whose name only contains this one, and never a full release), reading 100 releases per request
// - the step that creates the pre-release with gh, on the commit of the run, with both widget files and the notes
// - the step 'Promote the pre-release to a full release': it compares the app sources of the commit of the run with
//   those of the pre-release before it checks the release tag against res/config.xml of the pre-release, so that a
//   version raised after the pre-release is named as the cause instead of a wrong tag, and it gives the release the
//   notes of the commit of the run with one line of links (the commit of the files, and the documents of the commit of
//   the run), but only once the patch notes of that commit date the section of the version instead of calling it a
//   pre-release
// - the permissions of the jobs: only those that their steps use

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const API_URL = 'https://api.github.com/repos/owner/repo';

// A fake curl for the options that the workflows use (-sSL, -o, -w '%{http_code}', -H, -X, --data @-). It answers from
// the routes of a JSON state file ('METHOD url' -> { status, body }), records every request, and, like GitHub, moves the
// tag of a release that a PATCH changes onto its target commit.
const FAKE_CURL = `
const fs = require('fs');
const stateFile = process.env.FAKE_GITHUB_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
let output = null;
let writeOut = null;
let method = 'GET';
let data = null;
let url = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-o') { output = args[++i]; }
  else if (arg === '-w') { writeOut = args[++i]; }
  else if (arg === '-H') { i++; }
  else if (arg === '-X') { method = args[++i]; }
  else if (arg === '--data') { data = args[++i]; }
  else if (arg[0] === '-') { }
  else { url = arg; }
}
if (data === '@-') {
  data = fs.readFileSync(0, 'utf8');
}
state.requests.push({ method, url, data });
let answer = state.routes[method + ' ' + url];
if (method === 'PATCH' && /\\/releases\\/\\d+$/.test(url)) {
  const body = JSON.parse(data);
  state.routes['GET ' + state.apiUrl + '/git/ref/tags/' + body.tag_name] = { status: 200, body: { object: { sha: body.target_commitish, type: 'commit' } } };
  answer = { status: 200, body: {} };
} else if (method === 'DELETE') {
  answer = { status: 204, body: '' };
}
answer = answer || { status: 404, body: { message: 'Not Found' } };
fs.writeFileSync(stateFile, JSON.stringify(state));
const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
if (output) { fs.writeFileSync(output, text); } else { process.stdout.write(text); }
if (writeOut === '%{http_code}') { process.stdout.write(String(answer.status)); }
`;

// Create a folder with the fake curl and a state file with the given routes
function createFakeGithub(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-fake-github-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), '#!' + process.execPath + '\n' + FAKE_CURL, { mode: 0o755 });
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ apiUrl: API_URL, routes, requests: [] }));
  return {
    dir,
    env: { PATH: bin + path.delimiter + process.env.PATH, FAKE_GITHUB_STATE: stateFile, GITHUB_TOKEN: 'token', API_URL },
    requests: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).requests,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Run a bash script, returning its exit code and output (stdout and stderr together)
function runBash(script, options) {
  const result = childProcess.spawnSync('bash', ['-c', script], Object.assign({ encoding: 'utf8' }, options));
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

// Routes of the repository API: Issues on or off, the default branch, and the files that it has
function repositoryRoutes(hasIssues, defaultBranch, filesOnDefaultBranch) {
  const routes = { ['GET ' + API_URL]: { status: 200, body: { has_issues: hasIssues, default_branch: defaultBranch } } };
  filesOnDefaultBranch.forEach((file) => {
    routes['GET ' + API_URL + '/contents/' + file + '?ref=' + defaultBranch] = { status: 200, body: { path: file } };
  });
  return routes;
}

const SUPPORT_FILES = ['.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/config.yml', 'docs/GUIDE.md'];
const CHECK_SCRIPT = path.join(REPO_ROOT, '.github', 'scripts', 'check-support-path.sh');

test('the support check fails while Issues are off and the default branch lacks the issue forms and the guide', () => {
  // The state of the fork when the generalization was reviewed: Issues off, and master still upstream Moonlight Tizen
  const github = createFakeGithub(repositoryRoutes(false, 'master', []));
  try {
    const result = runBash('bash "' + CHECK_SCRIPT + '"', { env: Object.assign({}, process.env, github.env) });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /::error::Issues are turned off for this repository/);
    SUPPORT_FILES.forEach((file) => {
      assert.ok(result.output.indexOf('::error::The default branch master has no ' + file + '.') >= 0, result.output);
    });
    assert.match(result.output, /merge the branch of this release into master, or make it the default branch/);

    // As a warning for a pre-release, which still gets built
    const warned = runBash('bash "' + CHECK_SCRIPT + '"', { env: Object.assign({}, process.env, github.env, { SUPPORT_CHECK_MODE: 'warn' }) });
    assert.equal(warned.status, 0, warned.output);
    assert.match(warned.output, /::warning::Issues are turned off/);
    assert.doesNotMatch(warned.output, /::error::/);
  } finally {
    github.cleanup();
  }
});

test('the support check passes with Issues on and the issue forms and the guide on the default branch', () => {
  const github = createFakeGithub(repositoryRoutes(true, 'master', SUPPORT_FILES));
  try {
    const result = runBash('bash "' + CHECK_SCRIPT + '"', { env: Object.assign({}, process.env, github.env) });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /The issue tracker is turned on, and the default branch master has the issue forms and the guide\./);
    assert.deepEqual(github.requests().map((request) => request.url),
      [API_URL].concat(SUPPORT_FILES.map((file) => API_URL + '/contents/' + file + '?ref=master')));
  } finally {
    github.cleanup();
  }

  // One file missing, or an API error that isn't a missing file
  const missingGuide = createFakeGithub(repositoryRoutes(true, 'main', SUPPORT_FILES.slice(0, 2)));
  try {
    const result = runBash('bash "' + CHECK_SCRIPT + '"', { env: Object.assign({}, process.env, missingGuide.env) });
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(result.output.split('\n').filter((line) => line.indexOf('::error::') === 0).map((line) => line.split('.')[0]),
      ['::error::The default branch main has no docs/GUIDE']);
  } finally {
    missingGuide.cleanup();
  }
  const routes = repositoryRoutes(true, 'master', SUPPORT_FILES);
  routes['GET ' + API_URL + '/contents/docs/GUIDE.md?ref=master'] = { status: 500, body: { message: 'Server Error' } };
  const failing = createFakeGithub(routes);
  try {
    const result = runBash('bash "' + CHECK_SCRIPT + '"', { env: Object.assign({}, process.env, failing.env) });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Unexpected status 500 while looking up docs\/GUIDE\.md on master/);
  } finally {
    failing.cleanup();
  }
});

const WORKFLOW_FILE = 'release-development.yml';
const readWorkflow = () => fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', WORKFLOW_FILE), 'utf8');

test('the release workflow runs the support check before it publishes, as a warning that doesn\'t stop the release', () => {
  const development = readWorkflow();
  const promotion = development.slice(development.indexOf('  promote-pre-release:'));
  assert.ok(/SUPPORT_CHECK_MODE: warn\s+run: bash \.github\/scripts\/check-support-path\.sh/.test(promotion));
  assert.ok(promotion.indexOf('check-support-path.sh') < promotion.indexOf('- name: Promote the pre-release to a full release'));
  const preRelease = development.slice(development.indexOf('  run-and-upload-release:'), development.indexOf('  promote-pre-release:'));
  assert.ok(/SUPPORT_CHECK_MODE: warn\s+run: bash \.github\/scripts\/check-support-path\.sh/.test(preRelease));
  assert.ok(preRelease.indexOf('check-support-path.sh') < preRelease.indexOf('- name: Create GitHub pre-release'));
});

test('the only release workflow is "Release": a full release is always a promoted pre-release', () => {
  assert.match(readWorkflow(), /^name: Release$/m);
  const workflows = fs.readdirSync(path.join(REPO_ROOT, '.github', 'workflows')).sort();
  assert.deepEqual(workflows.filter((name) => /release/i.test(name)), [WORKFLOW_FILE], 'release-stable.yml built an untested build from master');
});

// Return the run script of a step of a workflow, without its indentation
function stepScript(workflowFile, stepName) {
  const lines = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', workflowFile), 'utf8').split('\n');
  const stepIndex = lines.findIndex((line) => line.trim() === '- name: ' + stepName);
  assert.ok(stepIndex >= 0, 'step ' + stepName);
  const runIndex = lines.findIndex((line, index) => index > stepIndex && /^\s*run: \|\s*$/.test(line));
  const nextStepIndex = lines.findIndex((line, index) => index > stepIndex && /^\s*- name: /.test(line));
  assert.ok(runIndex > stepIndex && (nextStepIndex < 0 || runIndex < nextStepIndex), 'the step ' + stepName + ' runs a script of its own');
  const runIndent = lines[runIndex].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && line.match(/^\s*/)[0].length <= runIndent) {
      break;
    }
    body.push(line);
  }
  const indent = Math.min.apply(null, body.filter((line) => line.trim() !== '').map((line) => line.match(/^\s*/)[0].length));
  return body.map((line) => line.slice(Math.min(indent, line.length))).join('\n');
}

// A git repository with the files that the promotion reads, whose first commit is the one of the pre-release
function createRepository(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-promotion-'));
  const git = (...args) => childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const setVersion = (value) => write('res/config.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<widget xmlns="http://www.w3.org/ns/widgets" id="http://example.com/app" version="' + value + '"></widget>\n');
  git('init', '-q');
  setVersion(version);
  write('wasm/platform/index.js', '// app\n');
  write('docs/RELEASE_NOTES.md', 'Notes\n');
  write('CHANGELOG.md', '# Changelog\n');
  write('tests/unit/example.test.js', '// test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'pre-release');
  return {
    dir,
    preRelease: git('rev-parse', 'HEAD'),
    write,
    setVersion,
    commit: () => {
      git('add', '-A');
      git('commit', '-q', '-m', 'run');
      return git('rev-parse', 'HEAD');
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Run the promotion step in the repository with a simulated pre-release v2026.1025.1200 of the given commit
function promote(repo, runSha, releaseTag) {
  const github = createFakeGithub({
    ['GET ' + API_URL + '/releases/tags/v2026.1025.1200']: { status: 200, body: { id: 7, prerelease: true } },
    ['GET ' + API_URL + '/git/ref/tags/v2026.1025.1200']: { status: 200, body: { object: { sha: repo.preRelease, type: 'commit' } } },
    ['GET ' + API_URL + '/releases/7']: { status: 200, body: { html_url: 'https://github.com/owner/repo/releases/7', tag_name: releaseTag, name: 'n', prerelease: false, draft: false, assets: [] } },
  });
  try {
    const result = runBash(stepScript('release-development.yml', 'Promote the pre-release to a full release'), {
      cwd: repo.dir,
      env: Object.assign({}, process.env, github.env, {
        PROMOTE_TAG: 'v2026.1025.1200',
        RELEASE_TAG: releaseTag,
        REPO_URL: 'https://github.com/owner/repo',
        GITHUB_SHA: runSha,
      }),
    });
    result.requests = github.requests();
    return result;
  } finally {
    github.cleanup();
  }
}

test('the promotion names a version raised after the pre-release as a changed app source, whatever tag it gets', () => {
  const repo = createRepository('1.19.100');
  try {
    repo.setVersion('1.19.101');
    const runSha = repo.commit();
    for (const releaseTag of ['v1.19.100', 'v1.19.101']) {
      const result = promote(repo, runSha, releaseTag);
      assert.equal(result.status, 1, result.output);
      assert.ok(result.output.indexOf('The app sources changed since the commit ' + repo.preRelease + ' of the pre-release:\nres/config.xml\n') >= 0, result.output);
      assert.match(result.output, /Build a new pre-release from this commit and promote that one/);
      assert.doesNotMatch(result.output, /Use the release tag/, releaseTag + ': no advice for a tag that can never work');
      assert.equal(result.requests.filter((request) => request.method !== 'GET').length, 0, 'nothing was changed');
    }
  } finally {
    repo.cleanup();
  }
});

test('the promotion checks the release tag against the version of the pre-release, and ignores changes to tests and documents', () => {
  const repo = createRepository('1.19.100');
  try {
    repo.write('tests/unit/example.test.js', '// a fixed test\n');
    repo.write('docs/RELEASE_NOTES.md', 'Final notes\n');
    repo.write('docs/PATCH_NOTES.md', '# Patch notes\n');
    repo.write('.github/workflows/release.yml', 'name: x\n');
    const runSha = repo.commit();

    const wrongTag = promote(repo, runSha, 'v1.19.101');
    assert.equal(wrongTag.status, 1, wrongTag.output);
    assert.match(wrongTag.output, /The release tag v1\.19\.101 doesn't match the app version 1\.19\.100 in res\/config\.xml of the pre-release\./);
    assert.match(wrongTag.output, /Use the release tag v1\.19\.100/);
    assert.equal(wrongTag.requests.filter((request) => request.method !== 'GET').length, 0);

    const result = promote(repo, runSha, 'v1.19.100');
    assert.equal(result.status, 0, result.output);
    const patch = result.requests.find((request) => request.method === 'PATCH');
    assert.ok(patch, result.output);
    const body = JSON.parse(patch.data);
    assert.deepEqual([body.tag_name, body.target_commitish, body.name, body.prerelease, body.make_latest], ['v1.19.100', runSha, 'Moonlight Plus v1.19.100', false, 'true']);
    assert.ok(body.body.indexOf('Final notes') >= 0, 'the notes of the commit of the run');
    // One line of links: the commit of the files, and the patch notes of the commit of the run (it has no guide)
    assert.ok(body.body.indexOf('\n- **Commit**: [`' + repo.preRelease.slice(0, 7) + '`](https://github.com/owner/repo/commit/' + repo.preRelease + ')' +
      ' · [Patch notes](https://github.com/owner/repo/blob/' + runSha + '/docs/PATCH_NOTES.md)\n') > 0, body.body);
    assert.doesNotMatch(body.body, /\[Guide\]|\[!WARNING\]/, 'no link to a missing guide, and no warning in a full release');
    assert.ok(result.requests.some((request) => request.method === 'DELETE' && request.url === API_URL + '/git/refs/tags/v2026.1025.1200'));
  } finally {
    repo.cleanup();
  }
});

test('the promotion refuses patch notes whose section of the version still says Pre-release', () => {
  const repo = createRepository('1.19.100');
  try {
    const patchNotes = (firstLine) => '# Patch notes\n\n## 1.19.1000\n\n*Pre-release, in testing.* Not this one.\n\n## 1.19.100\r\n\n' + firstLine +
      ' A summary.\n\n> **Install:** by hand.\n\n## 1.19.0-s90c.1\n\n*2026-10-23.* Older.\n';
    repo.write('docs/PATCH_NOTES.md', patchNotes('*Pre-release, in testing.*'));
    const undated = promote(repo, repo.commit(), 'v1.19.100');
    assert.equal(undated.status, 1, undated.output);
    assert.match(undated.output, /The section 1\.19\.100 of docs\/PATCH_NOTES\.md still says Pre-release\./);
    assert.match(undated.output, /add v1\.19\.100 to RELEASES in tests\/unit\/patch-notes\.test\.js/);
    assert.equal(undated.requests.filter((request) => request.method !== 'GET').length, 0, 'nothing was changed');

    // Dated, the promotion goes on; a pre-release section of another version doesn't matter
    ['api_response.json', 'existing_ref.json', 'release_notes.md'].forEach((file) => fs.rmSync(path.join(repo.dir, file), { force: true }));
    repo.write('docs/PATCH_NOTES.md', patchNotes('*2026-10-30.*'));
    const dated = promote(repo, repo.commit(), 'v1.19.100');
    assert.equal(dated.status, 0, dated.output);
    assert.ok(dated.requests.some((request) => request.method === 'PATCH'), dated.output);
  } finally {
    repo.cleanup();
  }
});

test('the promotion refuses a commit whose app sources differ from the pre-release', () => {
  const repo = createRepository('1.19.100');
  try {
    repo.write('wasm/platform/index.js', '// changed app\n');
    const result = promote(repo, repo.commit(), 'v1.19.100');
    assert.equal(result.status, 1, result.output);
    assert.ok(result.output.indexOf('of the pre-release:\nwasm/platform/index.js\n') >= 0, result.output);
    assert.equal(result.requests.filter((request) => request.method !== 'GET').length, 0);
  } finally {
    repo.cleanup();
  }
});

// Run the cleanup step of a pre-release run of the branch against the given answer to the list of releases
const CLEANUP_STEP = 'Check and delete any existing GitHub pre-releases from the same branch';
function cleanUp(branch, releasesAnswer) {
  const github = createFakeGithub({ ['GET ' + API_URL + '/releases?per_page=100']: releasesAnswer });
  try {
    const result = runBash(stepScript(WORKFLOW_FILE, CLEANUP_STEP), { env: Object.assign({}, process.env, github.env, { BRANCH: branch }) });
    result.requests = github.requests();
    return result;
  } finally {
    github.cleanup();
  }
}

test('a pre-release run deletes the earlier pre-release of exactly its branch, and nothing of other branches or full releases', () => {
  const release = (id, tag, prerelease) => ({ id, name: 'Moonlight Plus ' + tag, tag_name: tag, prerelease });
  const result = cleanUp('stufe-2', { status: 200, body: [
    release(11, 'v2026.1030.1200-stufe-2', true),
    // Branches whose names contain the name of this one: they keep their pre-releases
    release(12, 'v2026.1030.1300-stufe-2-fix', true),
    release(13, 'v2026.1029.0900-x-stufe-2', true),
    release(14, 'v2026.1029.0800-main', true),
    // Full releases, also one that kept the tag of a pre-release of this branch
    release(15, 'v2.1.0', false),
    release(16, 'v2026.1028.1000-stufe-2', false),
    // A tag without the timestamp is not one of this workflow
    release(17, 'stufe-2', true),
  ] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.requests.filter((request) => request.method === 'DELETE').map((request) => request.url),
    [API_URL + '/releases/11', API_URL + '/git/refs/tags/v2026.1030.1200-stufe-2']);
  // One page of up to 100 releases (the API gives 30 without per_page)
  assert.deepEqual(result.requests.filter((request) => request.method === 'GET').map((request) => request.url), [API_URL + '/releases?per_page=100']);

  // A branch with slashes, which the workflow turns into dashes, and a branch without an earlier pre-release
  const slashed = cleanUp('feature-audio', { status: 200, body: [release(21, 'v2026.1030.1200-feature-audio', true), release(22, 'v2026.1030.1200-audio', true)] });
  assert.deepEqual(slashed.requests.filter((request) => request.method === 'DELETE').map((request) => request.url),
    [API_URL + '/releases/21', API_URL + '/git/refs/tags/v2026.1030.1200-feature-audio']);
  const none = cleanUp('stufe-3', { status: 200, body: [release(11, 'v2026.1030.1200-stufe-2', true)] });
  assert.equal(none.status, 0, none.output);
  assert.match(none.output, /No pre-releases found for branch: stufe-3/);
  assert.equal(none.requests.filter((request) => request.method === 'DELETE').length, 0);
});

test('a pre-release run stops when it can\'t read the releases, instead of reading the error as no releases', () => {
  const result = cleanUp('stufe-2', { status: 401, body: { message: 'Bad credentials' } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Could not read the releases: \{"message":"Bad credentials"\}/);
  assert.equal(result.requests.filter((request) => request.method === 'DELETE').length, 0);
});

test('the pre-release is created with gh on the commit of the run, with both widget files and the prepared notes', () => {
  const workflow = readWorkflow();
  // The actions create-release and upload-release-asset are archived and no longer maintained
  assert.doesNotMatch(workflow, /actions\/create-release|actions\/upload-release-asset/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-fake-gh-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const argsFile = path.join(dir, 'args.json');
    fs.writeFileSync(path.join(bin, 'gh'), '#!' + process.execPath + '\n' +
      'require("fs").writeFileSync(' + JSON.stringify(argsFile) + ', JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN || null }));\n',
      { mode: 0o755 });
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const result = runBash(stepScript(WORKFLOW_FILE, 'Create GitHub pre-release'), {
      env: Object.assign({}, process.env, {
        PATH: bin + path.delimiter + process.env.PATH,
        TIMESTAMP: '2026.1031.1405',
        BRANCH: 'stufe-2',
        GITHUB_SHA: sha,
        GITHUB_REPOSITORY: 'owner/repo',
      }),
    });
    assert.equal(result.status, 0, result.output);
    const recorded = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(recorded.args, ['release', 'create', 'v2026.1031.1405-stufe-2', 'Moonlight.wgt', 'Moonlight-ForceGM.wgt',
      '--repo', 'owner/repo', '--target', sha, '--title', 'Moonlight Plus v2026.1031.1405-stufe-2', '--notes-file', 'release_notes.md',
      '--prerelease']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The token of the run reaches gh
  const step = workflow.slice(workflow.indexOf('- name: Create GitHub pre-release'));
  assert.match(step, /^\s+env:\n\s+GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n\s+run: \|/m);
});

// Return the permissions of each job of the workflow: { job: { scope: access } }
function jobPermissions(workflow) {
  const jobs = {};
  let job = null;
  let inPermissions = false;
  workflow.slice(workflow.indexOf('\njobs:\n')).split('\n').forEach((line) => {
    const jobMatch = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (jobMatch) {
      job = jobMatch[1];
      jobs[job] = {};
      inPermissions = false;
      return;
    }
    if (/^ {4}permissions:\s*$/.test(line)) {
      inPermissions = true;
      return;
    }
    const scope = /^ {6}([a-z-]+): ([a-z]+)\s*$/.exec(line);
    if (inPermissions && scope) {
      jobs[job][scope[1]] = scope[2];
    } else if (!/^\s*#/.test(line)) {
      inPermissions = false;
    }
  });
  return jobs;
}

test('each job of the release workflow gets only the permissions that its steps use', () => {
  assert.deepEqual(jobPermissions(readWorkflow()), {
    'build-and-push-image': { contents: 'read', packages: 'write' },
    'run-and-upload-release': { contents: 'write', packages: 'read' },
    'promote-pre-release': { contents: 'write' },
  });
});
