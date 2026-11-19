// A module that fails to start, appended to the stub of the module with the option
// `moduleScripts: ['wasm-start-abort.js']`: its runtime aborts instead of calling onRuntimeInitialized, as when the
// browser of a TV rejects the module (e.g. its shared memory) or the module runs out of memory while it starts. The
// abort goes through Module.onAbort of common.js, as the real runtime's does.
Module.onRuntimeInitialized = function() {
  Module.onAbort('CompileError: simulated failure at the start of the module');
};
