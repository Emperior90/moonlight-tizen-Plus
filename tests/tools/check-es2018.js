#!/usr/bin/env node
'use strict';

// Checks that the JavaScript running on the TV stays within ES2018, the level of Chromium M69, the browser engine of
// Tizen 5.5 (2020 TVs). Newer syntax such as optional chaining (?.), nullish coalescing (??), class fields or BigInt
// literals is a syntax error there, which stops the whole script from loading.
//
// 1. Syntax: every file is parsed with acorn and `ecmaVersion: 2018`. acorn comes from tests/node_modules
//    (`npm ci --prefix tests`), NODE_PATH or the global npm folder; without it, the check falls back to the copy of
//    acorn that Node itself bundles (loaded with --expose-internals), so it never silently skips.
// 2. Built-ins: a parser can't see calls of newer built-in functions (e.g. Object.fromEntries), so the syntax tree is
//    also searched for the newer built-ins listed below, which Chromium M69 doesn't have.
//
// Usage: node tests/tools/check-es2018.js [files...] (default: the files that run on the TV, see TARGETS)

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT, tryRequire } = require('../lib/dev-modules');

const ECMA_VERSION = 2018;

// The scripts that run on the TV: the platform scripts, the shared helpers, the Smart Hub service, Samsung's
// platform.js and the subnet scan (mdns-browser/main.js). The minified vendor libraries (jQuery, Material Design Lite)
// are left out.
const TARGETS = [
  { dir: 'wasm/platform', pattern: /\.js$/ },
  { file: 'wasm/static/js/utils.js' },
  { dir: 'wasm/static/js/mdns-browser', pattern: /\.js$/ },
  { file: 'res/service/service.js' },
  { file: 'res/platform.js' },
];

// Built-ins newer than Chromium M69, with the Chromium version that added them
const NEWER_STATIC_MEMBERS = {
  'Object.fromEntries': 73,
  'Object.hasOwn': 93,
  'Promise.allSettled': 76,
  'Promise.any': 85,
};
const NEWER_METHODS = {
  matchAll: 73,
  replaceAll: 85,
  at: 92,
  findLast: 97,
  findLastIndex: 97,
};
const NEWER_GLOBALS = {
  globalThis: 71,
  queueMicrotask: 71,
  structuredClone: 98,
  AggregateError: 85,
  WeakRef: 84,
  FinalizationRegistry: 84,
};

// Look a name up in one of the tables above, ignoring what objects inherit (e.g. toString)
function lookup(table, name) {
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}

// Load acorn, or return null when only the fallback through --expose-internals is left
function loadAcorn() {
  const installed = tryRequire('acorn');
  if (installed) {
    return { acorn: installed, source: 'acorn ' + installed.version };
  }
  if (process.execArgv.indexOf('--expose-internals') >= 0) {
    try {
      const bundled = require('internal/deps/acorn/acorn/dist/acorn');
      return { acorn: bundled, source: 'acorn ' + bundled.version + ' bundled with Node ' + process.version };
    } catch (error) {
      return null;
    }
  }
  return null;
}

// List the files to check, relative to the repository root
function listTargets() {
  const files = [];
  TARGETS.forEach((target) => {
    if (target.file) {
      files.push(target.file);
      return;
    }
    fs.readdirSync(path.join(REPO_ROOT, target.dir)).filter((name) => target.pattern.test(name)).sort().forEach((name) => {
      files.push(target.dir + '/' + name);
    });
  });
  return files;
}

// Visit every node of a syntax tree with its parent
function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') {
    return;
  }
  visit(node, parent);
  Object.keys(node).forEach((key) => {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((child) => walk(child, node, visit));
    } else if (value && typeof value.type === 'string') {
      walk(value, node, visit);
    }
  });
}

// Find uses of built-ins newer than Chromium M69
function findNewerBuiltIns(ast) {
  const problems = [];
  const report = (node, name, chromium) => {
    problems.push(`line ${node.loc.start.line}: ${name} needs Chromium ${chromium} (Tizen 5.5 has Chromium 69)`);
  };
  walk(ast, null, (node, parent) => {
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
      const name = node.property.name;
      const staticMember = node.object.type === 'Identifier' ? lookup(NEWER_STATIC_MEMBERS, node.object.name + '.' + name) : undefined;
      if (staticMember) {
        report(node, node.object.name + '.' + name, staticMember);
      } else if (lookup(NEWER_METHODS, name) && parent && parent.type === 'CallExpression' && parent.callee === node) {
        report(node, '.' + name + '()', lookup(NEWER_METHODS, name));
      }
    } else if (node.type === 'Identifier' && lookup(NEWER_GLOBALS, node.name)) {
      // Only references count, not e.g. a property named like the global
      const isProperty = parent && ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
        (parent.type === 'Property' && parent.key === node && !parent.computed));
      if (!isProperty) {
        report(node, node.name, lookup(NEWER_GLOBALS, node.name));
      }
    }
  });
  return problems;
}

// Check one file (relative to the repository root, or absolute) and return its problems
function checkFile(acorn, relativePath) {
  const source = fs.readFileSync(path.resolve(REPO_ROOT, relativePath), 'utf8');
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: ECMA_VERSION, sourceType: 'script', locations: true, allowHashBang: true });
  } catch (error) {
    return [`syntax newer than ES${ECMA_VERSION} or invalid: ${error.message}`];
  }
  return findNewerBuiltIns(ast);
}

function main() {
  const loaded = loadAcorn();
  if (!loaded) {
    if (process.execArgv.indexOf('--expose-internals') >= 0) {
      console.error('check-es2018: no acorn found, not even the copy bundled with Node. Run `npm ci --prefix tests`.');
      process.exit(2);
    }
    // Run again with access to the acorn copy that Node bundles
    const result = childProcess.spawnSync(process.execPath, ['--expose-internals', __filename].concat(process.argv.slice(2)), { stdio: 'inherit' });
    process.exit(result.status === null ? 2 : result.status);
  }

  const files = process.argv.length > 2
    ? process.argv.slice(2).map((file) => path.relative(REPO_ROOT, path.resolve(file)))
    : listTargets();
  let failures = 0;
  files.forEach((file) => {
    const problems = checkFile(loaded.acorn, file);
    if (problems.length > 0) {
      failures++;
      console.log(`not ok - ${file}`);
      problems.forEach((problem) => console.log(`  # ${problem}`));
    } else {
      console.log(`ok - ${file}`);
    }
  });
  console.log(`# ${files.length} files checked for ES${ECMA_VERSION} (Chromium M69) with ${loaded.source}, ${failures} with problems`);
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { checkFile, findNewerBuiltIns, listTargets, loadAcorn };
