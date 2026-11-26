'use strict';

// Checks how the workflows of .github/workflows run the code of others and how long they may run (2.3.5):
// - every action is pinned by the full commit of a release, with the version of that release as a comment
//   (`uses: owner/action@<40 hex> # vX.Y.Z`), the form Dependabot updates: a tag can be moved to other code, a commit
//   can't; and one action has one commit and one version in every workflow
// - every job has a timeout of at most an hour, so that a hung step (e.g. the installer of Tizen Studio under expect)
//   ends instead of holding a runner for six hours
// - every checkout keeps no token in the clone (`persist-credentials: false`): no job pushes with git, and the release
//   build copies the .git folder into the Docker build
// - every workflow sets its permissions, at the top or in every job

const test = require('node:test');
const assert = require('node:assert/strict');
const { workflowFiles, readWorkflow, jobs, keyValue, keyBlock, steps } = require('./helpers/workflows');

const USES = /^\s*(?:- )?uses: ([\w.-]+\/[\w./-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)\s*$/;

test('there are workflows, each with jobs', () => {
  const files = workflowFiles();
  assert.ok(files.length >= 5, files.join(', '));
  files.forEach((name) => assert.ok(Object.keys(jobs(readWorkflow(name))).length > 0, name));
});

test('every action is pinned by the commit of a release, with its version as a comment, the same in every workflow', () => {
  const pins = new Map();
  let count = 0;
  workflowFiles().forEach((name) => {
    readWorkflow(name).split('\n').forEach((line, index) => {
      if (!/^\s*(?:- )?uses:/.test(line)) {
        return;
      }
      count++;
      const match = USES.exec(line);
      assert.ok(match, `${name}:${index + 1}: pin the action by commit, with the version as a comment: ${line.trim()}`);
      const [, action, sha, version] = match;
      const pin = sha + ' # ' + version;
      if (pins.has(action)) {
        assert.equal(pin, pins.get(action).pin, `${name}:${index + 1}: ${action} is pinned as ${pins.get(action).pin} in ${pins.get(action).where}`);
      } else {
        pins.set(action, { pin, where: `${name}:${index + 1}` });
      }
    });
  });
  assert.ok(count >= 10, 'the uses lines of the workflows: ' + count);
  // The actions in use today: a new one needs its commit and version looked up the same way
  assert.deepEqual([...pins.keys()].sort(), ['actions/checkout', 'actions/setup-node', 'docker/build-push-action']);
});

test('every job has a timeout of at most an hour', () => {
  workflowFiles().forEach((name) => {
    Object.entries(jobs(readWorkflow(name))).forEach(([job, lines]) => {
      const value = keyValue(lines, 4, 'timeout-minutes');
      assert.ok(value !== undefined, `${name}: the job ${job} has no timeout-minutes`);
      assert.match(value, /^\d+$/, `${name}: ${job}`);
      assert.ok(Number(value) >= 1 && Number(value) <= 60, `${name}: ${job} may run ${value} minutes`);
    });
  });
});

test('every checkout keeps no token in the clone', () => {
  let checkouts = 0;
  workflowFiles().forEach((name) => {
    Object.entries(jobs(readWorkflow(name))).forEach(([job, lines]) => {
      steps(lines).filter((step) => /^actions\/checkout@/.test(step.uses || '')).forEach((step) => {
        checkouts++;
        assert.equal(keyValue(step.with, 10, 'persist-credentials'), 'false', `${name}: the checkout of ${job}`);
      });
    });
  });
  assert.ok(checkouts >= 7, 'checkouts: ' + checkouts);
});

test('every workflow sets its permissions, at the top or in every job', () => {
  workflowFiles().forEach((name) => {
    const text = readWorkflow(name);
    const lines = text.split('\n');
    if (keyBlock(lines, 0, 'permissions') !== null) {
      return;
    }
    Object.entries(jobs(text)).forEach(([job, jobLines]) => {
      assert.ok(keyBlock(jobLines, 4, 'permissions') !== null, `${name}: the job ${job} sets no permissions, nor does the workflow`);
    });
  });
});
