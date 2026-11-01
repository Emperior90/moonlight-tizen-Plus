// A simulated Sunshine host for the stub of the WebAssembly module (moonlight-wasm.js), which openApp() appends to the
// stub with the option `moduleScripts: ['sunshine-host.js']`. It answers the HTTP requests of the module to 10.0.0.2
// (serverinfo, applist, launch, resume, cancel) like a paired Sunshine PC named GAMING-PC (uniqueid HOST1) does, and
// rejects every other request at once, like an address without a host, so the startup scan of the network ends quickly.
// A started stream connects and shows its video after 150 ms, and a stopped one ends at once. SUNSHINE_HOSTS of
// browser/harness.js is this PC as the hosts list of an existing install stores it.
// window.__sunshine holds the state that a test reads or changes: the running app (currentGame), the app list, the
// requests (http, as '/path' or '/path appid'), the started streams (starts) and the stopped ones (stops). An init script
// can set window.__sunshineConfig = { currentGame: <app ID> } for a PC that already runs an app when the TV starts.
(function() {
  'use strict';
  var config = window.__sunshineConfig || {};
  var state = window.__sunshine = {
    currentGame: config.currentGame || 0,
    apps: [{ id: 101, title: 'Cyberpunk 2077' }, { id: 102, title: 'Desktop' }, { id: 103, title: 'Steam Big Picture' },
      { id: 104, title: 'Forza Horizon 5' }, { id: 105, title: 'Elden Ring' }],
    http: [],
    starts: [],
    stops: 0,
    delayMs: 30,
  };

  function serverInfo() {
    var busy = state.currentGame != 0;
    return '<?xml version="1.0" encoding="utf-8"?><root status_code="200"><hostname>GAMING-PC</hostname>' +
      '<appversion>7.1.431.-1</appversion><GfeVersion>3.23.0.74</GfeVersion><uniqueid>HOST1</uniqueid>' +
      '<HttpsPort>47984</HttpsPort><ExternalPort>47989</ExternalPort><mac>00:11:22:33:44:55</mac><LocalIP>10.0.0.2</LocalIP>' +
      '<ServerCodecModeSupport>197377</ServerCodecModeSupport><PairStatus>1</PairStatus><currentgame>' + state.currentGame +
      '</currentgame><state>' + (busy ? 'SUNSHINE_SERVER_BUSY' : 'SUNSHINE_SERVER_FREE') + '</state></root>';
  }

  function appList() {
    return '<?xml version="1.0" encoding="utf-8"?><root status_code="200">' + state.apps.map(function(app) {
      return '<App><IsHdrSupported>1</IsHdrSupported><AppTitle>' + app.title + '</AppTitle><ID>' + app.id + '</ID></App>';
    }).join('') + '</root>';
  }

  Module.openUrl = function(id, url) {
    var path = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    var appId = /[?&]appid=(\d+)/.exec(url);
    if (!/^https?:\/\/10\.0\.0\.2:/.test(url)) {
      setTimeout(function() {
        handlePromiseMessage(id, 'reject', -1);
      }, 0);
      return;
    }
    state.http.push(path + (appId ? ' ' + appId[1] : ''));
    setTimeout(function() {
      if (path === '/serverinfo') {
        handlePromiseMessage(id, 'resolve', serverInfo());
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
    }, state.delayMs);
  };

  var startStream = Module.startStream;
  Module.startStream = function() {
    var result = startStream.apply(this, arguments);
    state.starts.push({ width: arguments[2], height: arguments[3], fps: arguments[4], bitrate: arguments[5] });
    setTimeout(function() {
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
