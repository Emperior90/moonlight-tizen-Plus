#!/usr/bin/env node
'use strict';

// Checks the names that the scripts of the app use: the scripts that wasm/index.html loads share one global scope on the
// TV, so a name that nothing declares only fails when its line runs (a ReferenceError), and an assignment to a name
// that nothing declares quietly makes a global that another script may clobber (an implicit global). The check reads
// the scripts in the order of index.html (without the minified libraries and the TV's own webapis.js) as one scope:
// - the top-level var, function, let, const and class of every script, and the `window.<name> =` assignments, are
//   the globals; function scopes hoist their var and function declarations, blocks hold their let, const and class,
//   and catch parameters, for heads, destructuring and default parameters declare names as JavaScript does;
// - a read of a name that nothing declares and ALLOWED_GLOBALS lacks is reported, unless it is the operand of typeof
//   or sits behind a test with `typeof <name>` (e.g. `typeof x === 'function' ? x() : ...`);
// - an assignment to a name that nothing declares is reported, unless ALLOWED_GLOBALS marks the name writable;
// - every inline handler of index.html (onclick="...", onchange="...") may only use declared names.
// A property, an object key, a method name or a label is no use of a name.
//
// Usage: node tests/tools/check-globals.js

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadAcorn } = require('./check-es2018');

const ECMA_VERSION = 2018;

// The names that the scripts may use without declaring them: 'read', or 'write' for one they may also assign. An explicit
// list rather than the globals of Node, so that a name of Node (process, require, Buffer) is reported. A new web API
// needs a line here, which is the moment to check that Chromium 69 of Tizen 5.5 has it.
const ALLOWED_GLOBALS = Object.assign(Object.create(null), {
  // ECMAScript built-ins that the scripts use
  AbortController: 'read', Array: 'read', ArrayBuffer: 'read', Boolean: 'read', Date: 'read', Error: 'read',
  Float32Array: 'read', Infinity: 'read', Int32Array: 'read', Intl: 'read', isFinite: 'read', isNaN: 'read', JSON: 'read',
  Map: 'read', Math: 'read', NaN: 'read', Number: 'read', Object: 'read', parseFloat: 'read', parseInt: 'read',
  Promise: 'read', RegExp: 'read', Set: 'read', String: 'read', TypeError: 'read', Uint32Array: 'read', Uint8Array: 'read',
  undefined: 'read', URL: 'read', WeakMap: 'read', encodeURIComponent: 'read', TextEncoder: 'read',
  // Browser APIs of Chromium 69
  window: 'read', self: 'read', document: 'read', navigator: 'read', console: 'read', performance: 'read',
  localStorage: 'read', setTimeout: 'read', clearTimeout: 'read', setInterval: 'read', clearInterval: 'read',
  requestAnimationFrame: 'read', cancelAnimationFrame: 'read', requestIdleCallback: 'read', getComputedStyle: 'read',
  atob: 'read', fetch: 'read', Blob: 'read', FileReader: 'read', Image: 'read', Event: 'read', CustomEvent: 'read',
  KeyboardEvent: 'read', MouseEvent: 'read', MutationObserver: 'read', Node: 'read', HTMLElement: 'read',
  createImageBitmap: 'read',
  // The libraries that index.html loads before the scripts: jQuery and Material Design Lite
  $: 'read', jQuery: 'read', componentHandler: 'read',
  // The APIs of the TV
  tizen: 'read', webapis: 'read',
  // The WebAssembly module: common.js creates the object for the glue code of Emscripten (createWASMModule())
  Module: 'write',
  // i18n.js puts these on window as global.t and global._n
  t: 'read', _n: 'read',
  // The guard of tv_profile.js that exports its functions when the unit tests load it in Node
  module: 'read',
});

// The scripts that wasm/index.html loads, in its order, relative to the repository root: the minified libraries and
// the webapis.js of the TV are not checked, and platform.js is res/platform.js (CMakeLists.txt installs it there)
function listScripts(repoRoot) {
  const html = fs.readFileSync(path.join(repoRoot, 'wasm', 'index.html'), 'utf8');
  const files = [];
  const pattern = /<script\b[^>]*\bsrc="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const src = match[1];
    if (/\.min\.js$/.test(src) || /^\$WEBAPIS\//.test(src)) {
      continue;
    }
    files.push(src === 'platform.js' ? 'res/platform.js' : 'wasm/' + src);
  }
  return files;
}

// The inline handlers of wasm/index.html: [{ file, line, code }]
function listHandlers(repoRoot) {
  const html = fs.readFileSync(path.join(repoRoot, 'wasm', 'index.html'), 'utf8');
  const handlers = [];
  const pattern = /\son[a-z]+="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const code = match[1].replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    handlers.push({ file: 'wasm/index.html', line: html.slice(0, match.index).split('\n').length, code });
  }
  return handlers;
}

function Scope(parent, isFunction) {
  this.parent = parent;
  this.isFunction = isFunction;
  this.names = new Set();
}
Scope.prototype.has = function(name) {
  for (let scope = this; scope; scope = scope.parent) {
    if (scope.names.has(name)) {
      return true;
    }
  }
  return false;
};

// The names that a pattern declares (a parameter, a variable, a destructuring)
function declarePattern(pattern, scope) {
  if (!pattern) {
    return;
  }
  switch (pattern.type) {
    case 'Identifier':
      scope.names.add(pattern.name);
      break;
    case 'ObjectPattern':
      pattern.properties.forEach((property) => declarePattern(property.type === 'RestElement' ? property.argument : property.value, scope));
      break;
    case 'ArrayPattern':
      pattern.elements.forEach((element) => declarePattern(element, scope));
      break;
    case 'RestElement':
      declarePattern(pattern.argument, scope);
      break;
    case 'AssignmentPattern':
      declarePattern(pattern.left, scope);
      break;
    default:
      break;
  }
}

const isNode = (value) => value && typeof value.type === 'string';
const children = (node) => Object.keys(node).filter((key) => key !== 'loc').map((key) => node[key]);

// Hoist the var and function declarations of a function body or a script into its scope (not those of nested functions)
function hoist(node, scope) {
  if (!isNode(node)) {
    return;
  }
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    node.declarations.forEach((declaration) => declarePattern(declaration.id, scope));
  }
  if (node.type === 'FunctionDeclaration') {
    scope.names.add(node.id.name);
    return;
  }
  if (/Function/.test(node.type) || node.type === 'ClassExpression') {
    return;
  }
  children(node).forEach((value) => {
    if (Array.isArray(value)) {
      value.forEach((child) => hoist(child, scope));
    } else {
      hoist(value, scope);
    }
  });
}

// The let, const and class declarations of a list of statements, which belong to the block
function declareBlock(statements, scope) {
  statements.forEach((statement) => {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      statement.declarations.forEach((declaration) => declarePattern(declaration.id, scope));
    }
    if (statement.type === 'ClassDeclaration') {
      scope.names.add(statement.id.name);
    }
  });
}

// The names whose `typeof` an expression tests
function typeofNames(node, names) {
  const found = names || new Set();
  if (!isNode(node)) {
    return found;
  }
  if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument.type === 'Identifier') {
    found.add(node.argument.name);
  }
  children(node).forEach((value) => {
    if (Array.isArray(value)) {
      value.forEach((child) => typeofNames(child, found));
    } else {
      typeofNames(value, found);
    }
  });
  return found;
}

// Collects the uses of names of one script: { name, line, write, typeofOperand, guarded, scope }
function Walker(file, globals) {
  this.file = file;
  this.globals = globals;
  this.uses = [];
  this.windowNames = new Set();
  this.guards = new Set();
}

Walker.prototype.use = function(node, scope, write, typeofOperand) {
  this.uses.push({ name: node.name, line: node.loc.start.line, write, typeofOperand: !!typeofOperand, guarded: this.guards.has(node.name), scope });
};

// Walk `node` with the names whose typeof `test` checks as guarded
Walker.prototype.guarded = function(test, node, scope) {
  const saved = this.guards;
  this.guards = new Set([...saved, ...typeofNames(test)]);
  this.walk(node, scope);
  this.guards = saved;
};

Walker.prototype.pattern = function(pattern, scope, write) {
  if (!pattern) {
    return;
  }
  switch (pattern.type) {
    case 'Identifier':
      this.use(pattern, scope, write);
      break;
    case 'MemberExpression':
      this.walk(pattern, scope);
      break;
    case 'ObjectPattern':
      pattern.properties.forEach((property) => {
        if (property.type === 'RestElement') {
          this.pattern(property.argument, scope, write);
        } else {
          if (property.computed) {
            this.walk(property.key, scope);
          }
          this.pattern(property.value, scope, write);
        }
      });
      break;
    case 'ArrayPattern':
      pattern.elements.forEach((element) => this.pattern(element, scope, write));
      break;
    case 'RestElement':
      this.pattern(pattern.argument, scope, write);
      break;
    case 'AssignmentPattern':
      this.pattern(pattern.left, scope, write);
      this.walk(pattern.right, scope);
      break;
    default:
      this.walk(pattern, scope);
  }
};

Walker.prototype.fn = function(node, scope) {
  const inner = new Scope(scope, true);
  if (node.type === 'FunctionExpression' && node.id) {
    inner.names.add(node.id.name);
  }
  node.params.forEach((param) => declarePattern(param, inner));
  if (node.type !== 'ArrowFunctionExpression') {
    inner.names.add('arguments');
  }
  // The default values of the parameters see the parameters
  node.params.forEach((param) => this.pattern(param, inner, false));
  if (node.body.type === 'BlockStatement') {
    hoist(node.body, inner);
    declareBlock(node.body.body, inner);
    node.body.body.forEach((statement) => this.walk(statement, inner));
  } else {
    this.walk(node.body, inner);
  }
};

Walker.prototype.walk = function(node, scope) {
  if (!isNode(node)) {
    return;
  }
  switch (node.type) {
    case 'Identifier':
      this.use(node, scope, false);
      return;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      this.fn(node, scope);
      return;
    case 'ClassDeclaration':
    case 'ClassExpression': {
      const inner = new Scope(scope, false);
      if (node.id) {
        inner.names.add(node.id.name);
      }
      this.walk(node.superClass, inner);
      node.body.body.forEach((method) => {
        if (method.computed) {
          this.walk(method.key, inner);
        }
        this.walk(method.value, inner);
      });
      return;
    }
    case 'BlockStatement': {
      const inner = new Scope(scope, false);
      declareBlock(node.body, inner);
      node.body.forEach((statement) => this.walk(statement, inner));
      return;
    }
    case 'SwitchStatement': {
      this.walk(node.discriminant, scope);
      const inner = new Scope(scope, false);
      node.cases.forEach((switchCase) => declareBlock(switchCase.consequent, inner));
      node.cases.forEach((switchCase) => {
        this.walk(switchCase.test, inner);
        switchCase.consequent.forEach((statement) => this.walk(statement, inner));
      });
      return;
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const inner = new Scope(scope, false);
      const head = node.init || node.left;
      if (head && head.type === 'VariableDeclaration' && head.kind !== 'var') {
        head.declarations.forEach((declaration) => declarePattern(declaration.id, inner));
      }
      if (node.type === 'ForStatement') {
        this.walk(node.init, inner);
        this.walk(node.test, inner);
        this.walk(node.update, inner);
      } else {
        if (node.left.type === 'VariableDeclaration') {
          this.walk(node.left, inner);
        } else {
          this.pattern(node.left, inner, true);
        }
        this.walk(node.right, inner);
      }
      this.walk(node.body, inner);
      return;
    }
    case 'CatchClause': {
      const inner = new Scope(scope, false);
      declarePattern(node.param, inner);
      this.walk(node.body, inner);
      return;
    }
    case 'VariableDeclaration':
      node.declarations.forEach((declaration) => {
        this.pattern(declaration.id, scope, true);
        this.walk(declaration.init, scope);
      });
      return;
    case 'AssignmentExpression':
      if (node.left.type === 'MemberExpression' && !node.left.computed && node.left.object.type === 'Identifier' &&
        node.left.object.name === 'window') {
        this.windowNames.add(node.left.property.name);
      }
      this.pattern(node.left, scope, true);
      this.walk(node.right, scope);
      return;
    case 'UpdateExpression':
      this.pattern(node.argument, scope, true);
      return;
    case 'MemberExpression':
      this.walk(node.object, scope);
      if (node.computed) {
        this.walk(node.property, scope);
      }
      return;
    case 'Property':
    case 'MethodDefinition':
      if (node.computed) {
        this.walk(node.key, scope);
      }
      this.walk(node.value, scope);
      return;
    case 'LabeledStatement':
      this.walk(node.body, scope);
      return;
    case 'BreakStatement':
    case 'ContinueStatement':
      return;
    case 'UnaryExpression':
      if (node.operator === 'typeof' && node.argument.type === 'Identifier') {
        this.use(node.argument, scope, false, true);
        return;
      }
      this.walk(node.argument, scope);
      return;
    case 'IfStatement':
    case 'ConditionalExpression':
      this.walk(node.test, scope);
      this.guarded(node.test, node.consequent, scope);
      this.walk(node.alternate, scope);
      return;
    case 'LogicalExpression':
      this.walk(node.left, scope);
      if (node.operator === '&&') {
        this.guarded(node.left, node.right, scope);
      } else {
        this.walk(node.right, scope);
      }
      return;
    default:
      children(node).forEach((value) => {
        if (Array.isArray(value)) {
          value.forEach((child) => this.walk(child, scope));
        } else {
          this.walk(value, scope);
        }
      });
  }
};

// Check scripts that share one global scope, and inline handlers that run in it. `sources` are [{ file, text }] in the
// order the page loads them, `handlers` [{ file, line, code }]. Returns the problems as [{ file, line, name, kind,
// message }], kind 'undeclared', 'implicit global' or 'handler'.
function checkSources(acorn, sources, handlers, allowed) {
  const allow = allowed || ALLOWED_GLOBALS;
  const globals = new Scope(null, true);
  const parsed = sources.map((source) => ({
    file: source.file,
    ast: acorn.parse(source.text, { ecmaVersion: ECMA_VERSION, sourceType: 'script', locations: true }),
  }));
  parsed.forEach(({ ast }) => {
    hoist(ast, globals);
    declareBlock(ast.body, globals);
  });
  const walkers = parsed.map(({ file, ast }) => {
    const walker = new Walker(file, globals);
    ast.body.forEach((statement) => walker.walk(statement, globals));
    return walker;
  });
  const windowNames = new Set();
  walkers.forEach((walker) => walker.windowNames.forEach((name) => windowNames.add(name)));
  const declared = (use) => use.scope.has(use.name) || windowNames.has(use.name);
  const problems = [];
  const seen = new Set();
  const report = (file, line, name, kind, message) => {
    const key = [file, line, name, kind].join('\u0000');
    if (!seen.has(key)) {
      seen.add(key);
      problems.push({ file, line, name, kind, message: `${file}:${line}: ${message}` });
    }
  };
  walkers.forEach((walker) => {
    walker.uses.forEach((use) => {
      if (declared(use)) {
        return;
      }
      if (use.write) {
        if (allow[use.name] !== 'write') {
          report(walker.file, use.line, use.name, 'implicit global', `${use.name} is assigned, but nothing declares it (an implicit global)`);
        }
      } else if (!allow[use.name] && !use.typeofOperand && !use.guarded) {
        report(walker.file, use.line, use.name, 'undeclared', `${use.name} is used, but nothing declares it`);
      }
    });
  });
  (handlers || []).forEach((handler) => {
    const walker = new Walker(handler.file, globals);
    const scope = new Scope(globals, true);
    scope.names.add('event');
    acorn.parse(handler.code, { ecmaVersion: ECMA_VERSION, sourceType: 'script', locations: true }).body.forEach((statement) => walker.walk(statement, scope));
    walker.uses.forEach((use) => {
      if (!declared(use) && !allow[use.name] && !use.typeofOperand) {
        report(handler.file, handler.line, use.name, 'handler', `the inline handler ${JSON.stringify(handler.code)} uses ${use.name}, but nothing declares it`);
      }
    });
  });
  return problems;
}

function main() {
  const loaded = loadAcorn();
  if (!loaded) {
    if (process.execArgv.indexOf('--expose-internals') >= 0) {
      console.error('check-globals: no acorn found, not even the copy bundled with Node. Run `npm ci --prefix tests`.');
      process.exit(2);
    }
    // Run again with access to the acorn copy that Node bundles
    const result = childProcess.spawnSync(process.execPath, ['--expose-internals', __filename].concat(process.argv.slice(2)), { stdio: 'inherit' });
    process.exit(result.status === null ? 2 : result.status);
  }
  const files = listScripts(REPO_ROOT);
  const sources = files.map((file) => ({ file, text: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));
  const handlers = listHandlers(REPO_ROOT);
  const problems = checkSources(loaded.acorn, sources, handlers);
  problems.forEach((problem) => console.log('not ok - ' + problem.message));
  console.log(`# ${files.length} scripts and ${handlers.length} inline handlers of wasm/index.html checked as one global scope with ${loaded.source}, ` +
    `${problems.length} problems`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { ALLOWED_GLOBALS, checkSources, listHandlers, listScripts };
