'use strict';

// Loads the platform scripts of the app (plain browser scripts without exports) into a Node vm context that looks
// enough like the browser of a Samsung TV for their top-level code to run: `window` is the global object, and
// `tizen` and `webapis` come from the simulated TV of the browser tests (tests/browser/mocks/tv-mock.js).
//
// The unit tests then call the functions the scripts define, e.g.:
//   const app = loadPlatformScripts(INDEX_SCRIPTS, { tv: { tv: 'fhd', conn: 'wifi' } });
//   app.get('deriveOptimalSettings')(app.get('tvCapabilities'), 'wifi');
// Top-level `const` and `let` bindings aren't properties of the global object, so get() evaluates the name inside the
// context. Functions that touch the DOM or jQuery are not meant to be called this way; the browser tests cover them.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { REPO_ROOT } = require('../../lib/dev-modules');
const tvMock = require('../../browser/mocks/tv-mock');

// index.js and the scripts it needs, in the order of wasm/index.html: it detects the TV with tv_profile.js at load
const INDEX_SCRIPTS = ['wasm/platform/tv_profile.js', 'wasm/platform/index.js'];

// Minimal event target for window and document, which records the listeners so a test can dispatch to them
function createEventTarget() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, listener) {
      (listeners[type] = listeners[type] || []).push(listener);
    },
    removeEventListener(type, listener) {
      listeners[type] = (listeners[type] || []).filter((entry) => entry !== listener);
    },
    dispatchEvent(event) {
      (listeners[event.type] || []).slice().forEach((listener) => listener.call(null, event));
      return true;
    },
  };
}

// Console that keeps the output of the scripts for the assertions instead of printing it
function createConsole() {
  const messages = [];
  const capture = (level) => function() {
    messages.push({ level, text: Array.prototype.map.call(arguments, String).join(' ') });
  };
  return {
    messages,
    console: { log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error'), debug: capture('debug') },
  };
}

// Create the context. Options:
// - tv: configuration of the simulated TV (see tv-mock.js), e.g. { tv: 's90c', conn: 'wifi' }
// - screen: { width, height } of window.screen (default 1920 x 1080)
// - globals: extra globals, e.g. stubs for Navigation, $ or Module
function createPlatformContext(options) {
  const opts = options || {};
  const config = tvMock.parseConfig('', opts.tv);
  // Answer the asynchronous Tizen callbacks right away, which keeps the unit tests synchronous
  const apis = tvMock.createTizenApis(config, (callback) => callback());
  const windowEvents = createEventTarget();
  const documentEvents = createEventTarget();
  const output = createConsole();
  const storage = {};

  const sandbox = {
    console: output.console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    tizen: apis.tizen,
    webapis: apis.webapis,
    screen: opts.screen || { width: 1920, height: 1080 },
    location: { search: '', href: 'http://localhost/index.html' },
    navigator: { userAgent: 'Node unit test' },
    localStorage: {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
      setItem: (key, value) => {
        storage[key] = String(value);
      },
      removeItem: (key) => {
        delete storage[key];
      },
    },
    document: {
      addEventListener: documentEvents.addEventListener,
      removeEventListener: documentEvents.removeEventListener,
      dispatchEvent: documentEvents.dispatchEvent,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    dispatchEvent: windowEvents.dispatchEvent,
  };
  Object.assign(sandbox, opts.globals || {});
  vm.createContext(sandbox);
  // In a browser the global object is `window` (and `self`)
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  return {
    config,
    context: sandbox,
    tvCalls: apis.calls,
    consoleMessages: output.messages,
    windowListeners: windowEvents.listeners,
    documentListeners: documentEvents.listeners,
    // Run a script file of the repository (path relative to the repository root) in the context
    load(relativePath) {
      const file = path.join(REPO_ROOT, relativePath);
      vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
      return this;
    },
    // Evaluate an expression in the context, e.g. a top-level const of a script
    get(expression) {
      return vm.runInContext(expression, sandbox);
    },
    // Run code in the context
    run(code) {
      return vm.runInContext(code, sandbox);
    },
  };
}

// Copy a value out of the context as plain JSON data. Objects and arrays made inside the context have the prototypes of
// its own realm, which assert.deepStrictEqual() would report as different from the expected literals.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Create a context and load the given scripts into it, in order
function loadPlatformScripts(relativePaths, options) {
  const platform = createPlatformContext(options);
  relativePaths.forEach((relativePath) => platform.load(relativePath));
  return platform;
}

module.exports = { INDEX_SCRIPTS, createPlatformContext, loadPlatformScripts, plain };
