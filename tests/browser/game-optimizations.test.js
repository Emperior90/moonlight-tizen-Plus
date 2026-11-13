'use strict';

// Checks 'Optimize game settings' (Settings > Advanced Settings) in the real page: since settings schema 4 (2.3.0) it is
// on for a fresh install, after Restore Defaults and after the optimal settings button, whose dialog names it, as in
// moonlight-qt and moonlight-android; the launch and resume requests send it to Sunshine as it is, and to GeForce
// Experience only at 720p, 1080p or 4K at up to 60 FPS (getGameOptimizationsRequest() in index.js), with a line in the
// start log when it is held back. unit/game-optimizations.test.js pins the rule, existing-install.test.js the snapshot
// that keeps it off for an install of an earlier version, and video-defaults.test.js what Restore Defaults stores.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness, waitForStorage } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const EXISTING_INSTALL = { uniqueid: '0123456789abcdef', cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' } };

// The display modes that a GeForce Experience host lists, keyed by height and width like NvHTTP in utils.js
const GFE_DISPLAY_MODES = { '720:1280': [60], '1080:1920': [60, 120], '1440:2560': [60, 144], '2160:3840': [60] };

// Select a resolution and frame rate like a click on their menus does
function selectVideo(page, resolution, frameRate) {
  return page.evaluate(({ res, fps }) => {
    saveResolution.call($('.videoResolutionMenu li[data-value="' + res + '"]')[0]);
    saveFramerate.call($('.videoFramerateMenu li[data-value="' + fps + '"]')[0]);
  }, { res: resolution, fps: String(frameRate) });
}

// Start app 8 on a host with the given fields that answers the launch and resume requests at once, and return the sops
// argument of the request: a launch, or a resume when the host runs app 8 already
function startAndReadSops(page, hostFields) {
  return page.evaluate(async (fields) => {
    showApps = () => Promise.resolve();
    Module.stopStream = () => {
      handleMessage('streamTerminated: 0');
      return { type: 'resolve', ret: null };
    };
    const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
    const requests = [];
    const host = Object.assign({
      paired: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03, refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
      // launchApp(appId, mode, sops, ...) and resumeApp(mode, sops, ...)
      launchApp: function() {
        requests.push({ kind: 'launch', mode: arguments[1], sops: arguments[2] });
        return Promise.resolve(ok);
      },
      resumeApp: function() {
        requests.push({ kind: 'resume', mode: arguments[0], sops: arguments[1] });
        return Promise.resolve(ok);
      },
    }, fields);
    startGame(host, 8);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The stream connects before it ends, which releases its start on the host, so the next start doesn't wait
    // (held-host-start.test.js)
    handleMessage('Connection Established');
    Module.stopStream();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return requests;
  }, hostFields || {});
}

const sopsSwitch = (page) => page.evaluate(() => document.getElementById('optimizeGamesSwitch').checked);

test('a fresh install has it on and sends it to Sunshine at every resolution and frame rate, with the launch and the resume', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    assert.equal(await sopsSwitch(app.page), true);
    assert.deepEqual(await startAndReadSops(app.page), [{ kind: 'launch', mode: '3840x2160x60', sops: 1 }]);
    assert.deepEqual(await startAndReadSops(app.page, { currentGame: 8 }), [{ kind: 'resume', mode: '3840x2160x60', sops: 1 }]);
    for (const [res, fps] of [['2560:1440', 120], ['3200:1800', 90], ['1920:1080', 30]]) {
      await selectVideo(app.page, res, fps);
      const requests = await startAndReadSops(app.page, { isNvidiaServerSoftware: false });
      assert.deepEqual(requests.map((request) => request.sops), [1], res + '@' + fps);
    }
    assert.ok(app.logs.some((line) => line.indexOf('Optimize game settings: 1') >= 0));
    assert.equal(app.logs.filter((line) => line.indexOf('not sent to GeForce Experience') >= 0).length, 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('GeForce Experience gets it only at 720p, 1080p or 4K at up to 60 FPS, and the start log says when it is held back', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  const gfe = { isNvidiaServerSoftware: true, supportedDisplayModes: GFE_DISPLAY_MODES };
  try {
    const cases = [
      ['3840:2160', 60, 1], ['1920:1080', 60, 1], ['1280:720', 30, 1],
      // GeForce Experience would set the game to 720p at 60 FPS
      ['2560:1440', 60, 0], ['3200:1800', 60, 0], ['1920:1080', 120, 0], ['3840:2160', 90, 0],
    ];
    for (const [res, fps, sops] of cases) {
      await selectVideo(app.page, res, fps);
      assert.deepEqual((await startAndReadSops(app.page, gfe)).map((request) => request.sops), [sops], res + '@' + fps);
      assert.deepEqual((await startAndReadSops(app.page, Object.assign({ currentGame: 8 }, gfe))).map((request) => request.sops), [sops],
        'resume ' + res + '@' + fps);
    }
    assert.equal(app.logs.filter((line) => line.indexOf('Optimize game settings: 0 (not sent to GeForce Experience at this resolution and frame rate)') >= 0).length, 8);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('switched off, no host gets it', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: Object.assign({ settingsSchema: 5, optimizeGames: false }, EXISTING_INSTALL) });
  try {
    assert.equal(await sopsSwitch(app.page), false);
    assert.deepEqual((await startAndReadSops(app.page)).map((request) => request.sops), [0]);
    await selectVideo(app.page, '1920:1080', 60);
    assert.deepEqual((await startAndReadSops(app.page, { isNvidiaServerSoftware: true, supportedDisplayModes: GFE_DISPLAY_MODES })).map((request) => request.sops), [0]);
    assert.equal(app.logs.filter((line) => line.indexOf('not sent to GeForce Experience') >= 0).length, 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the optimal settings button names it and turns it on for an install that had it off', async () => {
  // An install of 2.2.1 that never switched it keeps it off through the snapshot of settings schema 4
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' }, stored: Object.assign({ settingsSchema: 3 }, EXISTING_INSTALL) });
  try {
    await waitForStorage(app.page, (values) => values.settingsSchema === 5 && values.optimizeGames === false);
    assert.equal(await sopsSwitch(app.page), false);
    await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    const text = await app.page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
    assert.ok(text.indexOf('&#8226; Video frame pacing on, limited color range, unlock all frame rates off, optimize game settings on, surround audio quality Efficient<br>') >= 0 ||
      text.indexOf('• Video frame pacing on, limited color range, unlock all frame rates off, optimize game settings on, surround audio quality Efficient<br>') >= 0, text);
    // Cancel keeps it off
    await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    assert.equal(await sopsSwitch(app.page), false);
    await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    await app.page.evaluate(() => $('#continueWarning').trigger('click'));
    assert.equal(await sopsSwitch(app.page), true);
    await waitForStorage(app.page, (values) => values.optimizeGames === true);
    assert.equal((await readStorage(app.page)).optimizeGames, true);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
