#!/usr/bin/env node
'use strict';

// Checks that the browser tests run on the Chromium build of the CI: the headless shell that the pinned Playwright
// (tests/package.json) expects, whose build and version its browsers.json names. Another build draws text with other
// widths and lays pages out a little differently, so a layout test can pass on it and fail in CI, or the other way
// round (the two CI failures of 2.3.3 passed on a newer Chromium). tests/README.md, "The Chromium of the CI", says how
// to get the pinned build.
//
// `npm run test:browser` runs this first (pretest:browser). It launches Chromium as the tests do and prints one line:
// the build when it is the one of the CI, else a warning that names both builds. With MOONLIGHT_PINNED_CHROMIUM=1, which
// the CI sets, another build is an error (exit code 1); without it, only a warning, so that a machine without the
// pinned build can still run the tests.
//
// Usage: node tests/tools/check-browser-build.js

const fs = require('fs');
const { requireDevModule, resolveDevModuleFile } = require('../lib/dev-modules');

const BROWSER = 'chromium-headless-shell';
const INSTALL_HINT = 'Install the pinned build with `npm run install:browser --prefix tests`, or see "The Chromium of the CI" in tests/README.md.';

// The file of playwright-core, which Playwright installs next to itself or below it
function playwrightCoreFile(file) {
  return resolveDevModuleFile('playwright-core', file) || resolveDevModuleFile('playwright/node_modules/playwright-core', file);
}

// The Chromium build that the installed Playwright expects for headless runs: { revision, browserVersion, playwright }
function expectedBuild() {
  const browsersFile = playwrightCoreFile('browsers.json');
  if (!browsersFile) {
    throw new Error("playwright-core was not found. Install the test tools with 'npm ci --prefix tests'.");
  }
  const entry = JSON.parse(fs.readFileSync(browsersFile, 'utf8')).browsers.find((browser) => browser.name === BROWSER);
  if (!entry) {
    throw new Error(browsersFile + ' names no ' + BROWSER);
  }
  const packageFile = playwrightCoreFile('package.json');
  const playwright = packageFile ? JSON.parse(fs.readFileSync(packageFile, 'utf8')).version : 'unknown';
  return { revision: entry.revision, browserVersion: entry.browserVersion, playwright };
}

// Compare the version that the launched Chromium reports with the expected build: { ok, message }
function compareBuild(actual, expected, strict) {
  if (actual === expected.browserVersion) {
    return { ok: true, message: `Chromium ${actual} (build ${expected.revision}), the one of the CI.` };
  }
  return {
    ok: false,
    message: `${strict ? 'Error' : 'Warning'}: the browser tests run on Chromium ${actual}, but Playwright ${expected.playwright} and the CI use ` +
      `Chromium ${expected.browserVersion} (build ${expected.revision}): text widths and layout differ, so a layout test can pass here ` +
      `and fail in CI, or the other way round. ${INSTALL_HINT}`,
  };
}

// What the check prints and how it ends: { exitCode, line }. `env` is the environment (MOONLIGHT_PINNED_CHROMIUM=1
// makes another build an error).
function decide(actual, expected, env) {
  const strict = (env || {}).MOONLIGHT_PINNED_CHROMIUM === '1';
  const result = compareBuild(actual, expected, strict);
  return { exitCode: result.ok || !strict ? 0 : 1, line: result.message };
}

async function main() {
  const strict = process.env.MOONLIGHT_PINNED_CHROMIUM === '1';
  let expected;
  let actual;
  try {
    expected = expectedBuild();
    const { chromium } = requireDevModule('playwright');
    const browser = await chromium.launch();
    try {
      actual = browser.version();
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.log(`${strict ? 'Error' : 'Warning'}: could not check the Chromium build of the browser tests: ${error.message.split('\n')[0]} ${INSTALL_HINT}`);
    return strict ? 1 : 0;
  }
  const result = decide(actual, expected, process.env);
  console.log(result.line);
  return result.exitCode;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { BROWSER, expectedBuild, compareBuild, decide };
