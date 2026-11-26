'use strict';

// Checks the rules that browser/harness.js applies to every browser test (2.3.5), by running a fixture file of tests
// (browser/fixtures/page-error-check.js) with `node --test` in a child process:
// - a test fails when its page had an uncaught error, also when the test asserts nothing about it, with a message that
//   names the error and says how to allow it; a test that opens the app with allowErrors passes and sees the error
// - a call of a function of the module with another number of arguments than its C++ function takes fails the test,
//   like Embind on the TV throws, also where the app catches the error (the stub of the module logs it)

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'page-error-check.js');

test('a page error or a wrong number of arguments for the module fails the test, unless it allows errors', () => {
  // A run of node --test inside a test file only runs its files without the context of the outer run
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;
  const result = childProcess.spawnSync(process.execPath, ['--test', '--test-reporter=spec', FIXTURE], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 120000, env,
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  // The list of the failed tests at the end of the spec report
  const failing = output.slice(output.lastIndexOf('failing tests:'));
  assert.ok(failing.length < output.length, 'the spec report lists the failed tests: ' + output);
  assert.match(failing, /a page error that the test does not assert/);
  assert.match(failing, /Uncaught errors in the page: thrown in the page on purpose\. Fix them, or open the app with openApp\(harness, \{ allowErrors: true \}\)/);
  assert.match(failing, /a call of the module with a wrong number of arguments that the app catches/);
  assert.match(failing, /Uncaught errors in the page: BindingError: function setStreamMenuOpen called with 0 arguments, expected 1 args!/);
  assert.doesNotMatch(failing, /a page error that the test causes on purpose|a page without errors/);
  assert.match(output, /\n. pass 2\n/);
  assert.match(output, /\n. fail 2\n/);
});
