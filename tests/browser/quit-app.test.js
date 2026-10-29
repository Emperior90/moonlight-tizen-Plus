'use strict';

// Checks quitting the running app of a host in the UI (stopGame() of wasm/platform/index.js with the real
// NvHTTP.quitApp() of wasm/static/js/utils.js): the server info is refreshed once the host answered /cancel, a host
// that keeps the app running (e.g. one that another device started) is reported instead of 'Successfully quit', and the
// start of another app that needed the quit doesn't follow a failed quit. The requests to the host are answered by the
// test through a replaced sendMessage().

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Install a paired host built on NvHTTP that runs app 7. Its server info refresh reports app 7 until the host answered
// /cancel, and then `window.__stillRunning ? 7 : 0`. The snackbar messages and the order of the requests are recorded.
async function openWithHost() {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  await app.page.evaluate(() => {
    window.__events = [];
    window.__stillRunning = false;
    window.__cancelAnswered = false;
    window.__showApps = 0;
    const host = new NvHTTP('10.0.0.2', '0123456789abcdef', '', '');
    Object.assign(host, { paired: true, hostname: 'GAMING-PC', ppkstr: 'PINNED-CERT', serverUid: 'HOST1', currentGame: 7 });
    host._baseUrlHttps = 'https://10.0.0.2:47984';
    host.refreshServerInfo = () => {
      window.__events.push('refresh');
      host.currentGame = window.__cancelAnswered && !window.__stillRunning ? 0 : 7;
      return Promise.resolve(true);
    };
    host.getAppById = (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null);
    window.__host = host;
    sendMessage = (method, params) => {
      window.__events.push(method + ' ' + String(params[0]).replace(/\?.*$/, '').replace('https://10.0.0.2:47984', ''));
      return new Promise((resolve) => setTimeout(() => {
        window.__cancelAnswered = true;
        window.__events.push('answered');
        resolve('<root status_code="200"><cancel>1</cancel></root>');
      }, 200));
    };
    showApps = () => {
      window.__showApps++;
      return Promise.resolve();
    };
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    window.__snackbarMessages = [];
    snackbar.showSnackbar = (data) => window.__snackbarMessages.push(data.message);
  });
  return app;
}

// Run stopGame() and wait for its callback
const quit = (page) => page.evaluate(() => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timedOut: true }), 5000);
  stopGame(window.__host, (quitSucceeded) => {
    clearTimeout(timer);
    resolve({
      quitSucceeded,
      events: window.__events.slice(),
      messages: window.__snackbarMessages.slice(),
      showApps: window.__showApps,
      currentGame: window.__host.currentGame,
    });
  });
}));

test('a quit refreshes the server info after the host answered /cancel and reports success', async () => {
  const app = await openWithHost();
  try {
    const result = await quit(app.page);
    assert.deepEqual(result.events, ['refresh', 'openUrl /cancel', 'answered', 'refresh']);
    assert.equal(result.quitSucceeded, true);
    assert.equal(result.currentGame, 0);
    assert.deepEqual(result.messages, ['Quitting Game 7...', 'Successfully quit Game 7']);
    assert.equal(result.showApps, 1, 'the app list shows that no app runs');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a host that keeps the app running is reported instead of a successful quit', async () => {
  const app = await openWithHost();
  try {
    await app.page.evaluate(() => {
      window.__stillRunning = true;
    });
    const result = await quit(app.page);
    assert.deepEqual(result.events, ['refresh', 'openUrl /cancel', 'answered', 'refresh']);
    assert.equal(result.quitSucceeded, false);
    assert.deepEqual(result.messages, ['Quitting Game 7...',
      'Game 7 is still running on GAMING-PC, probably because another device started it. Quit it on that device or on the PC.']);
    assert.equal(result.showApps, 1, 'the app list shows the app that still runs');
    assert.ok(app.logs.some((line) => line.includes('GAMING-PC still runs the app 7')));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a failed /cancel request is reported', async () => {
  const app = await openWithHost();
  try {
    await app.page.evaluate(() => {
      sendMessage = (method, params) => {
        window.__events.push(method + ' ' + String(params[0]).replace(/\?.*$/, '').replace('https://10.0.0.2:47984', ''));
        return Promise.reject(-1);
      };
    });
    const result = await quit(app.page);
    assert.deepEqual(result.events, ['refresh', 'openUrl /cancel']);
    assert.equal(result.quitSucceeded, false);
    assert.deepEqual(result.messages, ['Quitting Game 7...', 'Unable to quit Game 7. Check the connection to GAMING-PC and try again.']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// Start app 8 while app 7 runs, confirm the quit in the dialog, and record whether startGame() runs again for app 8
async function startOtherApp(page, stillRunning) {
  return page.evaluate(async (keepRunning) => {
    window.__stillRunning = keepRunning;
    window.__restarts = [];
    const realStartGame = startGame;
    startGame(window.__host, 8);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const dialogText = $('#quitAppDialogText').text();
    // The quit callback starts app 8 again through the global startGame()
    startGame = (host, appId) => window.__restarts.push(appId);
    $('#continueQuitApp').click();
    await new Promise((resolve) => setTimeout(resolve, 3600));
    startGame = realStartGame;
    return { dialogText, restarts: window.__restarts.slice(), messages: window.__snackbarMessages.slice() };
  }, stillRunning);
}

test('starting another app follows the quit of the running one', async () => {
  const app = await openWithHost();
  try {
    const result = await startOtherApp(app.page, false);
    assert.equal(result.dialogText, 'Game 7 is already running. Would you like to quit it and start Game 8?');
    assert.deepEqual(result.restarts, [8]);
    assert.ok(result.messages.includes('Successfully quit Game 7'));
  } finally {
    await app.context.close();
  }
});

test('starting another app does not follow a failed quit', async () => {
  const app = await openWithHost();
  try {
    const result = await startOtherApp(app.page, true);
    assert.deepEqual(result.restarts, [], 'the start would only ask to quit the same app again');
    assert.ok(result.messages.some((message) => message.startsWith('Game 7 is still running on GAMING-PC')));
  } finally {
    await app.context.close();
  }
});
