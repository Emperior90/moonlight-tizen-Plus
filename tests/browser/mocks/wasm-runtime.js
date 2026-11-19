// What the probe of WebAssembly that the app logs once the module is up (logWebAssemblyFeatures() in tv_profile.js) reads
// from the module and the TV, appended to the stub of the module with the option `moduleScripts: ['wasm-runtime.js']`:
// - the flag USE_HOST_BINDINGS that the glue code of Samsung's Emscripten SDK keeps in the built moonlight-wasm.js (true
//   when the sockets of the module use the host bindings of the TV), as a top-level 'let' of the script of the module
//   like the real one, which the other scripts of the page read by its name;
// - supportedInstructions() of the simulated tizentvwasm (tv-mock.js, option wasmPlayer), where there is one, with names
//   made up for the tests.
let USE_HOST_BINDINGS = true;
if (window.tizentvwasm) {
  window.tizentvwasm.supportedInstructions = function() {
    return ['test-set-a', 'test-set-b'];
  };
}
