// A module whose HTTP start fails, appended to the stub of the module with the option
// `moduleScripts: ['failing-start.js']`. An init script names the call that fails in window.__failStart: 'makeCert'
// (the module can't make the pairing certificate of a fresh install) or 'httpInit' (it can't load the stored
// certificate, with the text of wasm/http.cpp). The call is recorded like the other calls of the stub and rejects, as
// the real module answers such a call; the stub keeps checking its number of arguments.
(function() {
  'use strict';
  var record = function(name, args) {
    window.__wasmCalls.push({ name: name, args: Array.prototype.slice.call(args) });
  };
  if (window.__failStart === 'makeCert') {
    Module.makeCert = function() {
      record('makeCert', arguments);
      return { type: 'reject', ret: 'Simulated failure of mkcert_generate()' };
    };
  } else if (window.__failStart === 'httpInit') {
    Module.httpInit = function() {
      record('httpInit', arguments);
      return { type: 'reject', ret: 'Error loading cert into memory' };
    };
  }
})();
