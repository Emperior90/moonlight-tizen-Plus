// Simulated Samsung product APIs (`webapis`), served by the test server at the path the app loads the real ones from
// on a TV ($WEBAPIS/webapis/webapis.js). The objects come from tv-mock.js, which the server inserts as the first
// script of index.html, so both share one configuration (see tv-mock.js for the options).
(function() {
  'use strict';
  if (!window.__tvMock) {
    throw new Error('tv-mock.js must be loaded before webapis.js (the test server inserts it into index.html)');
  }
  window.webapis = window.__tvMock.apis.webapis;
})();
