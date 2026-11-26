'use strict';

// A simulated PC for the browser tests that start a stream without the simulated Sunshine (mocks/sunshine-host.js):
// one object with everything that the start, the stream, its end and the app list ask of a PC, so that a test helper
// doesn't build its own host that lacks a method a later change of the app calls (a fake host without getAppList()
// made the end of a stream throw unseen until 2.3.5). New tests use it instead of a host of their own.
//
// `fakeHostScript` goes into `openApp(harness, { initScripts: [fakeHostScript] })`, or `installFakeHost(page)` puts
// it into a page that is open already. It defines `window.__createFakeHost(overrides)` in the page, which returns the
// host (also as window.__host). The host
// - is HOST1, GAMING-PC at 10.0.0.2, paired and online, running no app, with the version and codecs of a Sunshine;
// - records 'refresh', 'launch', 'resume' and 'quit' in window.__hostCalls, and hands each to `overrides.record` too;
// - answers launchApp() and resumeApp() at once with the answer of a start (launchApp() also sets currentGame), or,
//   with `overrides.holdLaunch`, keeps them waiting: window.__launch then holds { resolve, reject } of the last one;
// - knows the apps of `overrides.apps` (default none) for getAppList() and getAppById() ('Game <id>' for another id);
// - takes the fields of `overrides.fields` over its own (e.g. { currentGame: 8 }).

// Runs in the page (as an init script or with page.evaluate)
function fakeHostScript() {
  const START_ANSWER = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
  window.__fakeHostStartAnswer = START_ANSWER;
  window.__createFakeHost = (overrides) => {
    const opts = overrides || {};
    window.__hostCalls = [];
    window.__launch = null;
    const record = (name) => {
      window.__hostCalls.push(name);
      if (opts.record) {
        opts.record(name);
      }
    };
    const apps = opts.apps || [];
    const start = (appId) => {
      if (opts.holdLaunch) {
        return new Promise((resolve, reject) => {
          window.__launch = { resolve, reject };
        });
      }
      if (appId !== undefined) {
        host.currentGame = appId;
      }
      return Promise.resolve(START_ANSWER);
    };
    const host = Object.assign({
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo() {
        record('refresh');
        return Promise.resolve();
      },
      getAppList() {
        return Promise.resolve(apps.slice());
      },
      getAppById(id) {
        if (!id) {
          return Promise.resolve(null);
        }
        return Promise.resolve(apps.find((app) => app.id === id) || { id: id, title: 'Game ' + id });
      },
      launchApp(appId) {
        record('launch');
        return start(appId);
      },
      resumeApp() {
        record('resume');
        return start();
      },
      quitApp() {
        record('quit');
        host.currentGame = 0;
        return Promise.resolve();
      },
      toString() {
        return host.hostname;
      },
    }, opts.fields);
    window.__host = host;
    return host;
  };
}

// Define window.__createFakeHost() in a page that is open already
function installFakeHost(page) {
  return page.evaluate(fakeHostScript);
}

module.exports = { fakeHostScript, installFakeHost };
