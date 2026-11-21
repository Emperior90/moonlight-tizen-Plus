// A simulated Sunshine host for the stub of the WebAssembly module (moonlight-wasm.js), which openApp() appends to the
// stub with the option `moduleScripts: ['sunshine-host.js']`. It answers the HTTP requests of the module to 10.0.0.2
// (serverinfo, applist, launch, resume, cancel) like a paired Sunshine PC named GAMING-PC (uniqueid HOST1) does, and
// rejects every other request at once, like an address without a host, so the startup scan of the network ends quickly.
// A started stream connects (first its control stream, 'ControlStreamConnected', as the module posts it, then the rest)
// and shows its video after 150 ms, and a stopped one ends at once. SUNSHINE_HOSTS of
// browser/harness.js is this PC as the hosts list of an existing install stores it.
// window.__sunshine holds the state that a test reads or changes: the running app (currentGame), the app list, the
// requests (http, as '/path' or '/path appid'), the started streams (starts) and the stopped ones (stops). An init script
// can set window.__sunshineConfig = { currentGame: <app ID> } for a PC that already runs an app when the TV starts, and
// { apps: [{ id, title }, ...] } for another app list than the five apps below. { offline: true } makes it a PC that is
// off: every request fails like one that nobody answers (state.offline = false turns it on again). { hold: true } holds
// the answers until the test calls state.release(), e.g. to see the app before the first poll of a stored PC ended; the
// app gives up on a request after 5 s (sendMessage() in messages.js), so a test releases them before that.
// The trust between the TV and the PC: by default the PC knows the TV (state.knowsTv) and answers over HTTP and HTTPS
// alike, as before. { unpaired: true } makes it a PC that doesn't know the TV: its server info over HTTP says
// PairStatus 0 (as Sunshine's always does over HTTP, state.httpPairStatus), and every HTTPS request gets the answer of
// Sunshine for a client that it doesn't accept, HTTP 200 with <root status_code="401" ...> (on_verify_failed in
// src/nvhttp.cpp). state.unpair() makes a PC that knew the TV forget it, like "Unpair All" in Sunshine or the TV turned
// off in its list of clients, and state.knowsTv = true takes it back without a pairing. The pairing itself is
// Module.pair (gs_pair() of the module), recorded in state.pairs with its PIN, which answers after state.delayMs with
// the key of the PC: with state.pairError (e.g. '-7' for a wrong PIN, used once, so that the next attempt pairs) it
// fails, and otherwise the PC knows the TV from then on, unless state.confirmPairing is false ({ confirmPairing: false
// }), after which the pairchallenge request over HTTPS gets the 401 answer instead of <paired>1</paired>. { key:
// 'sha256//...' } (state.key, or state.newKey(key) later, like Sunshine set up anew) is the key of the PC: an HTTPS
// request with another pinned key fails with the certificate mismatch of the module (-100), and the pairing pins this
// key; without a key, the pairing pins 'sha256//SUNSHINE' and no pinned key is checked. state.requests records every
// request as { scheme, path, key }, with its pinned key or null.
(function() {
  'use strict';
  var config = window.__sunshineConfig || {};
  var state = window.__sunshine = {
    currentGame: config.currentGame || 0,
    apps: config.apps || [{ id: 101, title: 'Cyberpunk 2077' }, { id: 102, title: 'Desktop' }, { id: 103, title: 'Steam Big Picture' },
      { id: 104, title: 'Forza Horizon 5' }, { id: 105, title: 'Elden Ring' }],
    http: [],
    starts: [],
    stops: 0,
    delayMs: 30,
    offline: !!config.offline,
    hold: !!config.hold,
    held: [],
    release: function() {
      state.hold = false;
      state.held.splice(0).forEach(function(answer) {
        setTimeout(answer, 0);
      });
    },
    knowsTv: !config.unpaired,
    httpPairStatus: config.unpaired ? 0 : 1,
    key: config.key || null,
    pairs: [],
    pairError: null,
    confirmPairing: config.confirmPairing !== false,
    requests: [],
    unpair: function() {
      state.knowsTv = false;
      state.httpPairStatus = 0;
    },
    newKey: function(key) {
      state.key = key;
    },
  };

  // The answer of Sunshine over HTTPS to a client whose certificate it doesn't accept
  function unauthorized(path) {
    return '<?xml version="1.0" encoding="utf-8"?><root status_code="401" query="' + path +
      '" status_message="The client is not authorized. Certificate verification failed."/>';
  }

  function serverInfo(pairStatus) {
    var busy = state.currentGame != 0;
    return '<?xml version="1.0" encoding="utf-8"?><root status_code="200"><hostname>GAMING-PC</hostname>' +
      '<appversion>7.1.431.-1</appversion><GfeVersion>3.23.0.74</GfeVersion><uniqueid>HOST1</uniqueid>' +
      '<HttpsPort>47984</HttpsPort><ExternalPort>47989</ExternalPort><mac>00:11:22:33:44:55</mac><LocalIP>10.0.0.2</LocalIP>' +
      '<ServerCodecModeSupport>197377</ServerCodecModeSupport><PairStatus>' + pairStatus + '</PairStatus><currentgame>' + state.currentGame +
      '</currentgame><state>' + (busy ? 'SUNSHINE_SERVER_BUSY' : 'SUNSHINE_SERVER_FREE') + '</state></root>';
  }

  function appList() {
    return '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' + state.apps.map(function(app) {
      return '<App><IsHdrSupported>1</IsHdrSupported><AppTitle>' + app.title + '</AppTitle><ID>' + app.id + '</ID></App>';
    }).join('') + '</root>';
  }

  Module.openUrl = function(id, url, key) {
    var path = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    var appId = /[?&]appid=(\d+)/.exec(url);
    if (!/^https?:\/\/10\.0\.0\.2:/.test(url)) {
      setTimeout(function() {
        handlePromiseMessage(id, 'reject', -1);
      }, 0);
      return;
    }
    var https = /^https:/.test(url);
    state.http.push(path + (appId ? ' ' + appId[1] : ''));
    state.requests.push({ scheme: https ? 'https' : 'http', path: path, key: key || null });
    var answer = function() {
      if (state.offline) {
        handlePromiseMessage(id, 'reject', -1);
      } else if (https && state.key && key !== state.key) {
        // GS_CERT_MISMATCH of the module: the PC answered with another key than the pinned one
        handlePromiseMessage(id, 'reject', -100);
      } else if (https && !state.knowsTv) {
        handlePromiseMessage(id, 'resolve', unauthorized(path));
      } else if (path === '/serverinfo') {
        handlePromiseMessage(id, 'resolve', serverInfo(https ? 1 : state.httpPairStatus));
      } else if (path === '/pair' && https) {
        // The pairchallenge request after the pairing
        handlePromiseMessage(id, 'resolve', '<?xml version="1.0" encoding="utf-8"?><root status_code="200"><paired>1</paired></root>');
      } else if (path === '/applist') {
        handlePromiseMessage(id, 'resolve', appList());
      } else if (path === '/launch') {
        state.currentGame = parseInt(appId[1], 10);
        handlePromiseMessage(id, 'resolve', '<root status_code="200"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0><gamesession>1</gamesession></root>');
      } else if (path === '/resume') {
        handlePromiseMessage(id, 'resolve', '<root status_code="200"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0><resume>1</resume></root>');
      } else if (path === '/cancel') {
        state.currentGame = 0;
        handlePromiseMessage(id, 'resolve', '<root status_code="200"><cancel>1</cancel></root>');
      } else {
        handlePromiseMessage(id, 'reject', -1);
      }
    };
    if (state.hold) {
      state.held.push(answer);
    } else {
      setTimeout(answer, state.delayMs);
    }
  };

  // The pairing (gs_pair() of the module, which asks the PC over HTTP and waits for the PIN on it): version, address,
  // HTTP port, PIN, unique ID and name of the TV, as pair() of wasm/main.cpp takes them
  Module.pair = function(id, version, address, httpPort, pin, uid, deviceName) {
    window.__wasmCalls.push({ name: 'pair', args: Array.prototype.slice.call(arguments) });
    state.pairs.push({ version: version, address: address, httpPort: httpPort, pin: pin, uid: uid, deviceName: deviceName });
    setTimeout(function() {
      if (state.offline) {
        handlePromiseMessage(id, 'reject', -1);
        return;
      }
      if (state.pairError !== null) {
        var error = state.pairError;
        state.pairError = null;
        handlePromiseMessage(id, 'reject', error);
        return;
      }
      state.knowsTv = state.confirmPairing !== false;
      handlePromiseMessage(id, 'resolve', state.key || 'sha256//SUNSHINE');
    }, state.delayMs);
  };

  var startStream = Module.startStream;
  Module.startStream = function() {
    var result = startStream.apply(this, arguments);
    state.starts.push({ width: arguments[2], height: arguments[3], fps: arguments[4], bitrate: arguments[5] });
    setTimeout(function() {
      handleMessage('ControlStreamConnected');
      handleMessage('Connection Established');
      handleMessage('displayVideo');
    }, 150);
    return result;
  };

  Module.stopStream = function() {
    state.stops++;
    window.__wasmCalls.push({ name: 'stopStream', args: [] });
    setTimeout(function() {
      handleMessage('streamTerminated: 0');
    }, 20);
    return { type: 'resolve', ret: null };
  };
})();
