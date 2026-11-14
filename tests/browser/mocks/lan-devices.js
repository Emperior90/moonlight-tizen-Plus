// A simulated local network for the stub of the WebAssembly module (moonlight-wasm.js), which openApp() appends to the
// stub with the option `moduleScripts: ['lan-devices.js']`. It answers the HTTP requests of the module by the address
// they go to: window.__lan.devices maps an address to what the device there answers,
//   { http: <answers>, https: <answers>, key: <the pinned key that its HTTPS answers need> }
// where <answers> is the XML of its server info, or an object { '/serverinfo': ..., '/applist': ... } by path. A request
// to an address without a device, to a path without an answer, or over a scheme that the device doesn't speak fails at
// once (-1, like a refused connection), and an HTTPS request with another pinned key than the one of the device fails
// with the certificate mismatch of the module (-100), as for a device that isn't the paired PC.
// window.__lan.requests records every request ({ url, scheme, address, port, path, key }). An init script can set
// window.__lanDevices to the devices of the start.
(function() {
  'use strict';
  var lan = window.__lan = { devices: window.__lanDevices || {}, requests: [], delayMs: 5 };

  Module.openUrl = function(id, url, key) {
    var match = /^(https?):\/\/(\[[^\]]*\]|[^\/:]*):(\d+)(\/[^?#]*)?/.exec(url);
    var request = { url: url, scheme: match ? match[1] : '', address: match ? match[2] : '', port: match ? Number(match[3]) : 0,
      path: match && match[4] ? match[4] : '', key: key || null };
    lan.requests.push(request);
    setTimeout(function() {
      var device = Object.prototype.hasOwnProperty.call(lan.devices, request.address) ? lan.devices[request.address] : null;
      var answers = device ? device[request.scheme] : null;
      if (!answers) {
        handlePromiseMessage(id, 'reject', -1);
        return;
      }
      if (request.scheme === 'https' && device.key !== request.key) {
        handlePromiseMessage(id, 'reject', -100);
        return;
      }
      var answer = typeof answers === 'string' ? (request.path === '/serverinfo' ? answers : null) : answers[request.path];
      if (answer === null || answer === undefined) {
        handlePromiseMessage(id, 'reject', -1);
        return;
      }
      handlePromiseMessage(id, 'resolve', answer);
    }, lan.delayMs);
  };
})();
