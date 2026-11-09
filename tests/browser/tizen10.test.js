'use strict';

// Checks the real UI of wasm/ on a simulated Tizen 10 TV (the models of 2026, and older TVs that Samsung updates),
// compared with the same TV on Tizen 9.0: the start screen, the settings and what a fresh install stores, the optimal
// settings dialog, System information, the game mode switch with its warning, and a simulated stream start with its
// start request; the version strings 10, 10.0.0, 10.5 and 11.0 behave like 10.0. And the compatibility warning of the
// Ultra low latency mode once after an update of the TV to Tizen 9.0 or newer (2.3.1): a switch stored on below 9.0,
// or by a version of the app that stored no Tizen version, warns at the first start on the newer version and never
// again, while a fresh install and a switch turned on there after its warning don't; another open dialog or a stream at
// that moment leaves it for the next start, and a switch turned off by then needs none. No Tizen 10 TV has run
// Moonlight Plus yet: the strings of the 2026 TV are illustrative, not read from a real device.

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  VIDEO_KEYS, openApp, pick, readOtherSettings, readStorage, readVideoSettings, restartAppOn, startHarness, waitForStorage,
} = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const TV_2026 = { tv: 'uhd', model: 'QE65Q80HAT', series: '26_PONTUSM_QTV', modelCode: '26_PONTUSM', firmware: 'T-INFOLINK2026-1000' };

// The arguments of the start request, in the order of startGame() and SyncFunctions.startRequest (messages.js)
const START_REQUEST_FIELDS = ['host', 'httpPort', 'width', 'height', 'frameRate', 'bitrateKbps', 'rikey', 'rikeyid', 'appVersion',
  'gfeVersion', 'rtspUrl', 'codecModes', 'framePacing', 'optimizeGames', 'rumbleFeedback', 'mouseEmulation', 'controllerMappings',
  'audioBackend', 'audioConfig', 'audioSync', 'audioJitter', 'playHostAudio', 'decryptHostAudio', 'videoCodec',
  'hdrMode', 'fullRange', 'gameMode', 'disableWarnings', 'performanceStats', 'refFrameInvalidation', 'hdrMetadata', 'controllerType',
  'surroundQuality'];

// Start a stream against a host simulated in the page (as in stream-lifecycle.test.js) and return the start request
async function simulatedStreamStart(page) {
  const run = await page.evaluate(async () => {
    const calls = { stop: 0 };
    const origStop = Module.stopStream;
    Module.stopStream = () => {
      calls.stop++;
      return { type: 'resolve', ret: null };
    };
    const origShowApps = showApps;
    showApps = () => Promise.resolve();
    let launch = null;
    const host = {
      paired: true, serverUid: 'HOST1', address: '10.0.0.2', httpPort: 47989, currentGame: 0, appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
      getAppList: () => Promise.resolve([]),
      launchApp: () => new Promise((resolve, reject) => { launch = { resolve, reject }; }),
      resumeApp: () => new Promise((resolve, reject) => { launch = { resolve, reject }; }),
    };
    window.__startStreamArgs = null;
    startGame(host, 8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    launch.resolve('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const args = window.__startStreamArgs;
    handleMessage('Connection Established');
    const streaming = { isInGame, wasmSessionStarted };
    handleMessage('streamTerminated: 0');
    const ended = { isInGame, wasmSessionStarted };
    await new Promise((resolve) => setTimeout(resolve, 300));
    Module.stopStream = origStop;
    showApps = origShowApps;
    return { args, streaming, ended };
  });
  assert.ok(Array.isArray(run.args) && run.args.length === START_REQUEST_FIELDS.length, 'the start request was sent with every argument');
  const request = {};
  START_REQUEST_FIELDS.forEach((field, index) => {
    request[field] = run.args[index];
  });
  delete request.rikey;
  delete request.rikeyid;
  return { request, streaming: run.streaming, ended: run.ended };
}

// Everything a user sees or the app stores on a fresh install, for a differential comparison
async function observe(tvOptions) {
  const app = await openApp(harness, { tv: tvOptions });
  try {
    const page = app.page;
    const result = {};
    result.view = await page.evaluate(() => ({
      hostGrid: $('#host-grid').is(':visible'),
      addHost: $('#host-add').is(':visible'),
      header: $('#main-header').is(':visible'),
      spinner: $('#wasmSpinner').is(':visible'),
    }));
    result.video = await readVideoSettings(page);
    result.other = await readOtherSettings(page);
    result.stored = pick(await readStorage(page), VIDEO_KEYS.concat(['settingsSchema', 'optimizeGames', 'rumbleFeedback']));
    result.systemInfo = await page.evaluate(() => document.getElementById('systemInfoBtn').innerHTML.split(/<br\s*\/?>/).filter((line) => line && !/^Controllers?/.test(line)));
    result.stream = await simulatedStreamStart(page);
    await page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    result.dialog = await page.evaluate(() => ({
      title: document.getElementById('warningDialogTitle').innerHTML,
      text: document.getElementById('warningDialogText').innerHTML,
      tiles: Array.prototype.map.call(document.querySelectorAll('#warningDialogValues .value-tile'), (tile) => tile.textContent.trim()),
    }));
    await page.evaluate(() => $('#closeWarning').trigger('click'));
    result.warnings = app.logs.filter((line) => /Warning: Failed to get|safeTvCall/.test(line));
    result.errors = app.errors;
    return result;
  } finally {
    await app.context.close();
  }
}

// Replace the version strings of Tizen 10 by those of Tizen 9, so that only the behaviour is compared
function asTizen9(value) {
  return JSON.parse(JSON.stringify(value).replace(/Tizen 10\.0/g, 'Tizen 9.0'));
}

const CASES = [
  ['2026 UHD TV over Wi-Fi, no tizentvwasm', Object.assign({ conn: 'wifi' }, TV_2026)],
  ['2026 UHD TV over Ethernet, WASM player with the Ultra Low Latency mode', Object.assign({ conn: 'ethernet', wasmPlayer: 'ull' }, TV_2026)],
  ['2026 UHD TV over Wi-Fi, WASM player without the mode', Object.assign({ conn: 'wifi', wasmPlayer: 'noUll' }, TV_2026)],
  ['2026 UHD TV, ForceGM variant', Object.assign({ conn: 'wifi', forceGM: 1 }, TV_2026)],
  ['2026 UHD TV, ForceGM variant, WASM player with the mode', Object.assign({ conn: 'wifi', forceGM: 1, wasmPlayer: 'ull' }, TV_2026)],
  ['S90C after an update to Tizen 10', { tv: 's90c', conn: 'wifi' }],
  ['S90C after an update to Tizen 10, ForceGM', { tv: 's90c', conn: 'wifi', forceGM: 1 }],
];

describe('Tizen 10.0 shows and does exactly what Tizen 9.0 does (differential)', { concurrency: 2 }, () => {
  for (const [name, tv] of CASES) {
    test(name, async () => {
      const t9 = await observe(Object.assign({}, tv, { tizen: '9.0' }));
      const t10 = await observe(Object.assign({}, tv, { tizen: '10.0' }));
      assert.deepEqual(t10.errors, []);
      assert.deepEqual(t10.warnings, []);
      assert.deepEqual(asTizen9(t10), t9);
      // The version itself is shown as Tizen 10.0
      assert.ok(t10.systemInfo.indexOf('Platform Version: Tizen 10.0') >= 0, t10.systemInfo.join('\n'));
      assert.ok(t10.dialog.text.indexOf('Tizen 10.0') >= 0, t10.dialog.text);
    });
  }
});

describe('a 2026 TV on Tizen 10.0 in detail', () => {
  test('settings, dialog, System information and the start request', async () => {
    const r = await observe(Object.assign({ conn: 'wifi', tizen: '10.0' }, TV_2026));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.view, { hostGrid: true, addHost: true, header: true, spinner: false });
    assert.deepEqual([r.video.resolution, r.video.frameRate, r.video.codec, r.video.bitrate, r.video.hdr, r.video.unlockAllFps,
      r.video.gameMode, r.video.gameModeDisabled, r.video.framePacing, r.video.fullRange],
    ['3840:2160', '60', 'HEVC', '80', true, false, false, false, true, false]);
    assert.deepEqual(r.stored.settingsSchema, 4);
    assert.equal(Object.prototype.hasOwnProperty.call(r.stored, 'gameMode'), false, 'a fresh install stores no game mode');
    const lines = r.dialog.text.split('<br>');
    assert.ok(lines.indexOf('Detected: 4K panel, HDR, Tizen 10.0, Wi-Fi') >= 0, r.dialog.text);
    assert.ok(r.dialog.text.indexOf('The Ultra low latency mode stays off on Tizen 10.0, so install the ForceGM variant for the lowest latency.') >= 0, r.dialog.text);
    assert.ok(r.dialog.text.indexOf('Ultra low latency mode on') < 0, r.dialog.text);
    assert.equal(r.dialog.title, 'Optimal settings for this TV (QE65Q80HAT)');
    for (const line of ['App Version: Moonlight Plus v2.3.1', 'Platform Version: Tizen 10.0', 'TV Firmware Version: T-INFOLINK2026-1000',
      'TV Model Series: 26_PONTUSM_QTV', 'TV Model Name: QE65Q80HAT', 'TV Model Group: 26_PONTUSM (model year 2026)', 'Panel: 4K',
      'HDR Support: Yes', 'Tested Profile: None']) {
      assert.ok(r.systemInfo.indexOf(line) >= 0, line + '\n' + r.systemInfo.join('\n'));
    }
    assert.deepEqual(r.stream.streaming, { isInGame: true, wasmSessionStarted: true });
    assert.deepEqual(r.stream.ended, { isInGame: false, wasmSessionStarted: false });
    assert.deepEqual(pick(r.stream.request, ['width', 'height', 'frameRate', 'bitrateKbps', 'videoCodec', 'hdrMode', 'gameMode', 'framePacing', 'optimizeGames']),
      { width: '3840', height: '2160', frameRate: '60', bitrateKbps: '80000', videoCodec: 'HEVC', hdrMode: 1, gameMode: 0, framePacing: 1, optimizeGames: 1 });
  });

  test('ForceGM variant: System information and the dialog name it', async () => {
    const r = await observe(Object.assign({ conn: 'wifi', tizen: '10.0', forceGM: 1 }, TV_2026));
    assert.ok(r.systemInfo.indexOf('App Version: Moonlight Plus-ForceGM v2.3.1') >= 0, r.systemInfo.join('\n'));
    assert.ok(r.dialog.text.indexOf('ForceGM variant detected: the app asks the TV for its Game Mode') >= 0, r.dialog.text);
    assert.equal(r.stream.request.gameMode, 0, 'the ForceGM variant streams in the Low Latency mode');
  });

  test('turning the Ultra low latency mode on warns with Tizen 10.0, turning it off gives no warning of old TVs', async () => {
    const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi', tizen: '10.0' }, TV_2026) });
    try {
      const { page } = app;
      await page.evaluate(() => $('#gameModeSwitch').trigger('click'));
      await page.waitForFunction(() => isDialogOpen && document.getElementById('warningDialogTitle').textContent === 'Compatibility Warning', null, { timeout: 3000 });
      const text = await page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
      assert.ok(text.indexOf('The Ultra low latency mode is not compatible with Tizen 10.0 due to platform changes introduced by Samsung.') === 0, text);
      assert.equal((await readStorage(page)).gameMode, true);
      await page.evaluate(() => $('#closeWarning').trigger('click'));
      await page.waitForTimeout(300);
      await page.evaluate(() => $('#gameModeSwitch').trigger('click'));
      await page.waitForTimeout(400);
      assert.equal((await readStorage(page)).gameMode, false);
      assert.equal(app.logs.some((line) => line.indexOf('Turning off the Ultra low latency mode may increase latency') >= 0), false);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });

  test('a WASM player without the mode: the switch stays off and disabled, and its click explains why', async () => {
    const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi', tizen: '10.0', wasmPlayer: 'noUll' }, TV_2026) });
    try {
      const video = await readVideoSettings(app.page);
      assert.deepEqual([video.gameMode, video.gameModeDisabled], [false, true]);
      await app.page.evaluate(() => clickElement(document.getElementById('gameModeBtn')));
      await app.page.waitForFunction(() => isDialogOpen && document.getElementById('warningDialogTitle').textContent === 'Unsupported Feature', null, { timeout: 3000 });
      const text = await app.page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
      assert.ok(text.indexOf('The video player of this TV reports that it doesn\'t offer the Ultra Low Latency mode') === 0, text);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });

  test('version strings of later TVs: 10, 10.0.0, 10.5 and 11.0 behave like 10.0', async () => {
    const reference = asTizen9(await observe(Object.assign({ conn: 'wifi', tizen: '10.0' }, TV_2026)));
    for (const version of ['10', '10.0.0', '10.5', '11.0']) {
      const r = await observe(Object.assign({ conn: 'wifi', tizen: version }, TV_2026));
      const normalized = JSON.parse(JSON.stringify(r).split('Tizen ' + version).join('Tizen 9.0'));
      assert.deepEqual(normalized, reference, version);
    }
  });

  test('an unreadable platform version falls back to the rules of Tizen 6 to 8: game mode on', async () => {
    const r = await observe(Object.assign({ conn: 'wifi', tizen: '10.0', failApis: 'tizen.systeminfo.getCapability' }, TV_2026));
    assert.equal(r.video.gameMode, true);
    assert.equal(r.stream.request.gameMode, 1);
  });
});

// The compatibility warning of the Ultra low latency mode, which a start shows once for a switch left on from before an
// update of the TV to Tizen 9.0 or newer (warnGameModeAfterTizenUpdate() in index.js)
const COMPATIBILITY_WARNING = 'Compatibility Warning';
const UPDATE_WARNING_LOG = 'and the TV now runs Tizen';
const EXISTING_INSTALL = { uniqueid: '0123456789abcdef', cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' }, settingsSchema: 4 };

// Wait for the compatibility warning and return its text
async function waitForCompatibilityWarning(page) {
  await page.waitForFunction((title) => isDialogOpen && document.getElementById('warningDialogTitle').textContent === title,
    COMPATIBILITY_WARNING, { timeout: 4000 });
  return page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
}

// Give the start the time that the warning would take (it shows 500 ms after the hosts), and say whether it showed
async function compatibilityWarningShows(page) {
  await page.waitForTimeout(1500);
  return page.evaluate((title) => isDialogOpen && document.getElementById('warningDialogTitle').textContent === title, COMPATIBILITY_WARNING);
}

async function closeWarning(page) {
  await page.evaluate(() => $('#closeWarning').trigger('click'));
  await page.waitForFunction(() => !isDialogOpen, null, { timeout: 2000 });
}

// An init script that runs `action` in the page in the 500 ms between the hosts showing with the warning pending and
// the warning itself (scheduleGameModeUpdateWarning() in index.js), at the first start of the tab only, so that a
// restart shows what a later start does. The page watches for that moment itself, because openApp() returns some time
// after the hosts showed, which may be after the warning on a slow machine.
function inWarningWindow(action) {
  return `(${function(act) {
    if (sessionStorage.getItem('actedInWarningWindow')) {
      return;
    }
    const timer = setInterval(() => {
      if (typeof isGameModeUpdateWarningPending === 'undefined' || !isGameModeUpdateWarningPending || !isStartupUiShown) {
        return;
      }
      clearInterval(timer);
      sessionStorage.setItem('actedInWarningWindow', '1');
      act();
    }, 5);
  }})(${action});`;
}

// A switch stored on on Tizen 8.0, on a 2026 TV that now runs Tizen 10.0
const STORED_BEFORE_UPDATE = Object.assign({ gameMode: true, gameModePlatformVer: '8.0' }, EXISTING_INSTALL);
const TV_2026_ON_TIZEN_10 = Object.assign({ conn: 'wifi', tizen: '10.0' }, TV_2026);

describe('the compatibility warning once after an update of the TV to Tizen 9.0 or newer', () => {
  test('a switch turned on on Tizen 8.0 warns once at the first start on Tizen 10.0, and the warning only informs', async () => {
    const tizen8 = { tv: 'uhd', conn: 'wifi', tizen: '8.0' };
    const app = await openApp(harness, { tv: tizen8 });
    try {
      const { page } = app;
      // On by default on Tizen 8.0: turn it off and on again, which stores it with the version of the TV
      assert.equal((await readVideoSettings(page)).gameMode, true);
      await page.evaluate(() => $('#gameModeSwitch').trigger('click'));
      await waitForStorage(page, (values) => values.gameMode === false);
      await page.evaluate(() => $('#gameModeSwitch').trigger('click'));
      const stored = await waitForStorage(page, (values) => values.gameMode === true);
      assert.equal(stored.gameModePlatformVer, '8.0');
      assert.equal(await compatibilityWarningShows(page), false, 'no warning on Tizen 8.0');

      // The firmware of the TV moves it to Tizen 10.0, which keeps the stored settings
      await restartAppOn(harness, app, Object.assign({}, tizen8, { tizen: '10.0' }));
      const text = await waitForCompatibilityWarning(page);
      assert.ok(text.indexOf('The Ultra low latency mode is not compatible with Tizen 10.0 due to platform changes introduced by Samsung.') === 0, text);
      assert.ok(text.indexOf('<b>ForceGM variant and game mode</b>') > 0, text);
      assert.equal((await waitForStorage(page, (values) => values.gameModePlatformVer === '10.0')).gameMode, true);
      assert.equal(app.logs.filter((line) => line.indexOf('The Ultra low latency mode is on from Tizen 8.0, and the TV now runs Tizen 10.0') >= 0).length, 1);
      await closeWarning(page);
      // It informs only: the switch stays on and the stream asks for the Ultra Low Latency mode until it is turned off
      assert.equal((await readVideoSettings(page)).gameMode, true);
      assert.equal((await simulatedStreamStart(page)).request.gameMode, 1);

      // The next start on Tizen 10.0 doesn't warn again
      await restartAppOn(harness, app, Object.assign({}, tizen8, { tizen: '10.0' }));
      assert.equal(await compatibilityWarningShows(page), false, 'shown once');
      assert.equal(app.logs.filter((line) => line.indexOf(UPDATE_WARNING_LOG) >= 0).length, 1);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });

  test('a fresh install on Tizen 10.0 shows no warning and stores no game mode', async () => {
    const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi', tizen: '10.0' }, TV_2026) });
    try {
      assert.equal(await compatibilityWarningShows(app.page), false);
      assert.equal((await readVideoSettings(app.page)).gameMode, false);
      const stored = await readStorage(app.page);
      assert.equal('gameMode' in stored || 'gameModePlatformVer' in stored, false, JSON.stringify(Object.keys(stored)));
      assert.equal(app.logs.some((line) => line.indexOf(UPDATE_WARNING_LOG) >= 0), false);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });

  test('a switch turned on on Tizen 9.0 after its warning doesn\'t warn at the next start, also after an update to 10.0', async () => {
    const s90c = { tv: 's90c', conn: 'wifi' };
    const app = await openApp(harness, { tv: s90c });
    try {
      const { page } = app;
      await page.evaluate(() => $('#gameModeSwitch').trigger('click'));
      // The warning of the switch, as before
      assert.ok((await waitForCompatibilityWarning(page)).indexOf('not compatible with Tizen 9.0') > 0);
      assert.equal((await waitForStorage(page, (values) => values.gameMode === true)).gameModePlatformVer, '9.0');
      await closeWarning(page);
      await restartAppOn(harness, app, s90c);
      assert.equal(await compatibilityWarningShows(page), false, 'next start on Tizen 9.0');
      assert.equal((await readVideoSettings(page)).gameMode, true);
      await restartAppOn(harness, app, Object.assign({ tizen: '10.0' }, s90c));
      assert.equal(await compatibilityWarningShows(page), false, 'after an update from 9.0 to 10.0');
      assert.equal(app.logs.some((line) => line.indexOf(UPDATE_WARNING_LOG) >= 0), false);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });

  test('a switch stored on by 2.3.0 or earlier, without a Tizen version, warns once on Tizen 9.0', async () => {
    const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: Object.assign({ gameMode: true }, EXISTING_INSTALL) });
    try {
      const { page } = app;
      assert.ok((await waitForCompatibilityWarning(page)).indexOf('not compatible with Tizen 9.0') > 0);
      assert.equal((await waitForStorage(page, (values) => values.gameModePlatformVer === '9.0')).gameMode, true);
      assert.ok(app.logs.some((line) => line.indexOf('The Ultra low latency mode is on from a version that stored no Tizen version, and the TV now runs Tizen 9.0') >= 0));
      await closeWarning(page);
      await restartAppOn(harness, app, { tv: 's90c', conn: 'wifi' });
      assert.equal(await compatibilityWarningShows(page), false);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });

  test('another open dialog or a stream when the warning is due leaves it for the next start, which shows it', async () => {
    for (const entry of [
      // Another dialog, as the Wake PC dialog of a PC picked right after the hosts showed would be
      { action: () => navigationGuideDialog(), log: 'over another dialog', close: () => $('#closeNavGuide').trigger('click') },
      // A stream, which the test only flags: the warning comes 500 ms after the hosts show, too soon to start one
      { action: () => { isInGame = true; }, log: 'during a stream', close: () => { isInGame = false; } },
    ]) {
      const app = await openApp(harness, { tv: TV_2026_ON_TIZEN_10, stored: STORED_BEFORE_UPDATE, initScripts: [inWarningWindow(entry.action)] });
      try {
        const { page } = app;
        assert.equal(await compatibilityWarningShows(page), false, entry.log);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('actedInWarningWindow')), '1', entry.log + ': acted before the warning');
        assert.equal(app.logs.filter((line) => line.indexOf('Not showing the compatibility warning of the Ultra low latency mode ' + entry.log +
          ', so a later start shows it.') >= 0).length, 1, entry.log);
        const stored = await readStorage(page);
        assert.deepEqual([stored.gameMode, stored.gameModePlatformVer], [true, '8.0'], entry.log + ': nothing new is stored');
        await page.evaluate(entry.close);

        await restartAppOn(harness, app, TV_2026_ON_TIZEN_10);
        assert.ok((await waitForCompatibilityWarning(page)).indexOf('not compatible with Tizen 10.0') > 0, entry.log);
        assert.equal((await waitForStorage(page, (values) => values.gameModePlatformVer === '10.0')).gameMode, true);
        await closeWarning(page);
        assert.deepEqual(app.errors, [], entry.log);
      } finally {
        await app.context.close();
      }
    }
  });

  test('a switch turned off before the warning is due needs none, also at the next start', async () => {
    const app = await openApp(harness, {
      tv: TV_2026_ON_TIZEN_10, stored: STORED_BEFORE_UPDATE, initScripts: [inWarningWindow(() => $('#gameModeSwitch').trigger('click'))],
    });
    try {
      const { page } = app;
      assert.equal(await compatibilityWarningShows(page), false);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('actedInWarningWindow')), '1', 'acted before the warning');
      // The switch stores itself off with the current version, as any change of it does
      const stored = await waitForStorage(page, (values) => values.gameMode === false);
      assert.equal(stored.gameModePlatformVer, '10.0');
      assert.equal(app.logs.some((line) => line.indexOf('Not showing the compatibility warning') >= 0), false);
      await restartAppOn(harness, app, TV_2026_ON_TIZEN_10);
      assert.equal(await compatibilityWarningShows(page), false, 'next start');
      assert.equal((await readVideoSettings(page)).gameMode, false);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });

  test('no warning where the switch is stored off, or where the video player doesn\'t offer the mode', async () => {
    for (const entry of [
      { stored: { gameMode: false, gameModePlatformVer: '8.0' }, tv: { conn: 'wifi', tizen: '10.0' } },
      { stored: { gameMode: true, gameModePlatformVer: '8.0' }, tv: { conn: 'wifi', tizen: '10.0', wasmPlayer: 'noUll' } },
    ]) {
      const app = await openApp(harness, { tv: Object.assign({}, TV_2026, entry.tv), stored: Object.assign({}, EXISTING_INSTALL, entry.stored) });
      try {
        assert.equal(await compatibilityWarningShows(app.page), false, JSON.stringify(entry));
        assert.equal((await readStorage(app.page)).gameModePlatformVer, '8.0', 'nothing new is stored');
        assert.deepEqual(app.errors, []);
      } finally {
        await app.context.close();
      }
    }
  });
});
