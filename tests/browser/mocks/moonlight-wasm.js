// Stand-in for the WebAssembly module (moonlight-wasm.js), so that the UI loads in a desktop browser without the
// native build. common.js creates the `Module` object and loads this script; the functions below answer like the
// real module does for a successful call, and every call is recorded in `window.__wasmCalls` for the tests.
(function() {
  'use strict';
  var ok = function(ret) {
    return { type: 'resolve', ret: ret === undefined ? null : ret };
  };
  var record = function(name, args) {
    window.__wasmCalls.push({ name: name, args: Array.prototype.slice.call(args) });
  };
  window.__wasmCalls = [];
  window.__startStreamArgs = null;

  Module.makeCert = function() {
    record('makeCert', arguments);
    return ok({ cert: 'TEST-CERT', privateKey: 'TEST-KEY' });
  };
  Module.httpInit = function() {
    record('httpInit', arguments);
    return ok();
  };
  Module.startStream = function() {
    record('startStream', arguments);
    window.__startStreamArgs = Array.prototype.slice.call(arguments);
    return ok();
  };
  Module.stopStream = function() {
    record('stopStream', arguments);
    return ok();
  };
  Module.cancelRequest = function() {
    record('cancelRequest', arguments);
    return ok();
  };
  // HTTP requests to hosts never answer, which the UI treats like an unreachable host after its timeout
  Module.openUrl = function() {
    record('openUrl', arguments);
  };
  Module.toggleStats = function() {
    record('toggleStats', arguments);
  };
  Module.setStreamMenuOpen = function() {
    record('setStreamMenuOpen', arguments);
  };
  Module.toggleMouseEmulation = function() {
    record('toggleMouseEmulation', arguments);
  };
  Module.sendKeyboardEvent = function() {
    record('sendKeyboardEvent', arguments);
  };
  Module.stun = function() {
    record('stun', arguments);
  };
  Module.pair = function() {
    record('pair', arguments);
  };
  Module.wakeOnLan = function() {
    record('wakeOnLan', arguments);
  };

  // The real runtime calls this once the module is compiled and its threads are ready, which the simulated TV can delay
  // (wasmStartMs, see tv-mock.js)
  var startMs = window.__tvMock && isFinite(window.__tvMock.config.wasmStartMs) ? window.__tvMock.config.wasmStartMs : 50;
  setTimeout(function() {
    Module.onRuntimeInitialized();
  }, startMs);
})();
