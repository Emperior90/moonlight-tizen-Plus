'use strict';

// Locates the development tools of the tests (Playwright, acorn) without making them a hard requirement of every
// test file. They are looked up in this order:
// 1. tests/node_modules, installed with `npm ci --prefix tests` (what the CI workflow does),
// 2. the folders in NODE_PATH and the global npm folder (`npm root -g`), where a machine may already have them,
// so that the tests also run on a machine without registry access as long as the tools are installed globally.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const TESTS_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TESTS_ROOT, '..');

let globalRootCache;

// Return the global npm folder, or null if npm isn't available
function getGlobalNodeModules() {
  if (globalRootCache === undefined) {
    try {
      globalRootCache = childProcess.execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (error) {
      globalRootCache = null;
    }
  }
  return globalRootCache;
}

// Return the candidate folders that may contain the module, in lookup order
function getSearchFolders() {
  const folders = [path.join(TESTS_ROOT, 'node_modules')];
  (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean).forEach((folder) => folders.push(folder));
  const globalRoot = getGlobalNodeModules();
  if (globalRoot) {
    folders.push(globalRoot);
  }
  return folders;
}

// Load a development module by name, or return null if it can't be found anywhere
function tryRequire(name) {
  for (const folder of getSearchFolders()) {
    const candidate = path.join(folder, name);
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }
  return null;
}

// Load a development module by name, or throw an error that explains how to install it
function requireDevModule(name) {
  const loaded = tryRequire(name);
  if (!loaded) {
    throw new Error(`The test tool '${name}' was not found. Install the test tools with 'npm ci --prefix tests' ` +
      `(see tests/README.md), or install '${name}' globally.`);
  }
  return loaded;
}

module.exports = {
  REPO_ROOT,
  TESTS_ROOT,
  requireDevModule,
  tryRequire,
};
