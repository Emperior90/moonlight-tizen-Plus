'use strict';

// Pins how a stream ends when the app goes to the background (from the earlier rounds of fixes, see the visibilitychange
// handler in wasm/platform/index.js): a short hide such as a TV menu keeps the stream, a longer one ends it with a
// notice on return, a stream whose video the TV took away or that is still connecting ends at once, and a stream that
// is still starting is cancelled. The stop delay is shortened to 400 ms for the tests.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

const NOTICE = 'The stream was ended because Moonlight went to the background';

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Open the app with a shortened stop delay, a recording stopStream and cancelStreamLaunch, and window.__run(), which
// puts the page into the state of a running stream
async function openForBackground() {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  await app.page.evaluate(() => {
    BACKGROUND_STREAM_STOP_DELAY_MS = 400;
    window.__stops = 0;
    window.__cancels = 0;
    window.__origStop = Module.stopStream;
    window.__origCancel = cancelStreamLaunch;
    Module.stopStream = () => {
      window.__stops++;
      handleMessage('streamTerminated: 0');
      return { type: 'resolve', ret: null };
    };
    cancelStreamLaunch = () => {
      window.__cancels++;
      isInGame = false;
    };
    streamLaunchHost = { serverUid: 'H', paired: true, refreshServerInfo: () => new Promise(() => {}) };
    window.__run = () => {
      isInGame = true;
      wasmSessionStarted = true;
      isStreamConnected = true;
      isStreamVideoTrackClosed = false;
      streamVideoTrackCloseReason = -1;
      streamHiddenCount = 0;
      streamVideoTrackCloseCount = 0;
    };
  });
  return app;
}

// Hide or show the page like the TV does when another app or a menu covers it
function setVisibility(app, state) {
  return app.page.evaluate((visibility) => {
    Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

const stops = (app) => app.page.evaluate(() => window.__stops);
const notices = (app) => app.logs.filter((line) => line.indexOf(NOTICE) >= 0).length;

test('a short hide (a TV menu) keeps the stream running without a notice', async () => {
  const app = await openForBackground();
  try {
    await app.page.evaluate(() => window.__run());
    // Hidden for 150 ms, timed inside the page so that a slow test machine can't stretch it past the 400 ms delay
    await app.page.evaluate(() => new Promise((resolve) => {
      const setState = (visibility) => {
        Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      setState('hidden');
      setTimeout(() => {
        setState('visible');
        resolve();
      }, 150);
    }));
    await app.page.waitForTimeout(500);
    assert.equal(await stops(app), 0);
    assert.equal(await app.page.evaluate(() => isInGame), true);
    assert.equal(notices(app), 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a hide longer than the delay ends the stream, with a notice on return', async () => {
  const app = await openForBackground();
  try {
    await app.page.evaluate(() => window.__run());
    await setVisibility(app, 'hidden');
    await app.page.waitForTimeout(700);
    assert.equal(await stops(app), 1);
    assert.equal(await app.page.evaluate(() => isInGame), false);
    await setVisibility(app, 'visible');
    assert.equal(notices(app), 1);
  } finally {
    await app.context.close();
  }
});

test('the TV detaching the video while hidden ends the stream at once, a suspension is left to the timer', async () => {
  const app = await openForBackground();
  try {
    // Reason 2: the TV took the video away
    await app.page.evaluate(() => window.__run());
    await setVisibility(app, 'hidden');
    await app.page.evaluate(() => handleMessage('VideoTrackClosed: 2'));
    await app.page.waitForTimeout(50);
    assert.equal(await stops(app), 1);
    await setVisibility(app, 'visible');

    // Reason 3: only suspended because the app is hidden (e.g. an overlay), so the stream keeps running
    await app.page.evaluate(() => window.__run());
    await setVisibility(app, 'hidden');
    await app.page.evaluate(() => handleMessage('VideoTrackClosed: 3'));
    await app.page.waitForTimeout(100);
    assert.equal(await stops(app), 1);
    assert.equal(await app.page.evaluate(() => isInGame), true);
    const line = await app.page.evaluate(() => getBackgroundStatsLine());
    assert.ok(line.indexOf('hidden during the stream: 1 times') >= 0, line);
    assert.ok(line.indexOf('video closed by the TV: 1 times (last reason 3)') >= 0, line);
    await app.page.evaluate(() => handleMessage('VideoTrackOpened'));
    const noticesBefore = notices(app);
    await setVisibility(app, 'visible');
    await app.page.waitForTimeout(500);
    assert.equal(await stops(app), 1, 'back before the delay: still running');
    assert.equal(notices(app), noticesBefore);
  } finally {
    await app.context.close();
  }
});

test('a video closed while visible keeps the stream, but hiding with the video detached ends it at once', async () => {
  const app = await openForBackground();
  try {
    await app.page.evaluate(() => window.__run());
    await app.page.evaluate(() => handleMessage('VideoTrackClosed: 2'));
    await app.page.waitForTimeout(50);
    assert.equal(await stops(app), 0);
    assert.equal(await app.page.evaluate(() => isInGame), true);
    await app.page.evaluate(() => handleMessage('VideoTrackOpened'));
    assert.equal(await app.page.evaluate(() => isStreamVideoTrackClosed), false, 'reopening clears the closed state');
    await app.page.evaluate(() => handleMessage('VideoTrackClosed: 2'));
    await setVisibility(app, 'hidden');
    await app.page.waitForTimeout(50);
    assert.equal(await stops(app), 1);
    await setVisibility(app, 'visible');
  } finally {
    await app.context.close();
  }
});

test('hiding during the connection setup ends the stream at once, hiding during the start cancels it', async () => {
  const app = await openForBackground();
  try {
    await app.page.evaluate(() => {
      window.__run();
      isStreamConnected = false;
    });
    await setVisibility(app, 'hidden');
    await app.page.waitForTimeout(50);
    assert.equal(await stops(app), 1);
    await setVisibility(app, 'visible');

    await app.page.evaluate(() => {
      isInGame = true;
      wasmSessionStarted = false;
    });
    await setVisibility(app, 'hidden');
    await app.page.waitForTimeout(50);
    assert.equal(await app.page.evaluate(() => window.__cancels), 1);
    await setVisibility(app, 'visible');
  } finally {
    await app.context.close();
  }
});

test('without a stream, hiding ends nothing', async () => {
  const app = await openForBackground();
  try {
    await setVisibility(app, 'hidden');
    await app.page.waitForTimeout(500);
    await setVisibility(app, 'visible');
    assert.equal(await stops(app), 0);
    assert.equal(await app.page.evaluate(() => window.__cancels), 0);
  } finally {
    await app.context.close();
  }
});

test('a start still waiting for the host when hidden never reaches the stream view, and nothing starts while hidden', async () => {
  const app = await openForBackground();
  try {
    const pending = await app.page.evaluate(() => new Promise((resolve) => {
      let release;
      const host = {
        paired: true, serverUid: 'H2', currentGame: 0,
        refreshServerInfo: () => new Promise((done) => {
          release = done;
        }),
        getAppById: (id) => Promise.resolve({ id: id, title: 'G' }),
        launchApp: () => Promise.resolve('<root status_code="200"><sessionUrl0>x</sessionUrl0></root>'),
      };
      cancelStreamLaunch = window.__origCancel;
      startGame(host, 3);
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      release();
      setTimeout(() => {
        const result = { isInGame, spinner: $('#loadingSpinner').css('display') };
        let refreshed = false;
        startGame({ paired: true, serverUid: 'H3', refreshServerInfo: () => {
          refreshed = true;
          return new Promise(() => {});
        } }, 4);
        result.refreshedWhileHidden = refreshed;
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        resolve(result);
      }, 300);
    }));
    assert.deepEqual(pending, { isInGame: false, spinner: 'none', refreshedWhileHidden: false });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
