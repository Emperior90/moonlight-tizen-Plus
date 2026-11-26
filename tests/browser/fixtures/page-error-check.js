'use strict';

// Not a test of the app: browser/harness-checks.test.js runs this file with `node --test` to check the rules of the
// harness. Its name doesn't end in .test.js, so the browser tests don't run it themselves.
// - a page that throws fails its test, although the test asserts nothing about it;
// - with allowErrors the same page passes, and the test sees the error in app.errors;
// - a call of the stub of the module with a wrong number of arguments fails its test, also when the app catches the
//   error;
// - a test without such an error passes.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('../harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const throwInPage = (page) => page.evaluate(() => new Promise((resolve) => {
  setTimeout(() => {
    throw new Error('thrown in the page on purpose');
  }, 0);
  setTimeout(resolve, 100);
}));

test('a page error that the test does not assert', async () => {
  const app = await openApp(harness);
  try {
    await throwInPage(app.page);
  } finally {
    await app.context.close();
  }
});

test('a page error that the test causes on purpose', async () => {
  const app = await openApp(harness, { allowErrors: true });
  try {
    await throwInPage(app.page);
    assert.deepEqual(app.errors, ['thrown in the page on purpose']);
  } finally {
    await app.context.close();
  }
});

test('a call of the module with a wrong number of arguments that the app catches', async () => {
  const app = await openApp(harness);
  try {
    const caught = await app.page.evaluate(() => {
      try {
        Module.setStreamMenuOpen();
        return null;
      } catch (error) {
        return error.name + ': ' + error.message;
      }
    });
    assert.equal(caught, 'BindingError: function setStreamMenuOpen called with 0 arguments, expected 1 args!');
  } finally {
    await app.context.close();
  }
});

test('a page without errors', async () => {
  const app = await openApp(harness);
  try {
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
