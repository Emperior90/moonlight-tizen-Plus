'use strict';

// Checks 'Shut down or restart the PC…' in the menu of a PC in the PC list (pcPowerDialog(), startPcPowerSession() and
// choosePcPowerApp() in wasm/platform/index.js, armPcPowerCommand() and endPcPowerCommand() in menus.js, the end of the
// stream in messages.js), with the keys of the remote, against the simulated Sunshine of mocks/sunshine-host.js:
// - the entry shows for a PC that is online and paired, between View Details and Delete PC, and not otherwise
// - the question opens on Cancel, ignores a double OK, and Cancel or RETURN close it without a request to the PC
// - a session launches the Desktop app (or resumes the app that runs), names its purpose on the launch screen, waits for
//   the picture, counts down, types the command (the same sequence as the Stream Menu, tests/unit/pc-power.test.js) and
//   ends on the PC list with "… is shutting down." when the PC ends the stream; meanwhile the first key of the remote
//   gives the stream the keys (since 2.3.3), so that the question of Windows can be answered
// - a PC whose running app the list of the TV lacks reads the list once more (since 2.3.3) and resumes the app; one that
//   runs an app that the PC doesn't list either gets a message of its own
// - a PC without a Desktop app gets a message and nothing starts; RETURN during the countdown ends the stream and quits
//   the Desktop app that the session launched, but not a game it resumed; no picture, no command; a stream without video
//   starts once more and counts down again; a start that the PC refuses leaves nothing for the next start
// - the question and the entry fit in every language, also with text 10 % wider

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, startHarness } = require('./harness');
const { THREE_HOSTS, doubleKey, key, menuState, openMenus, selectItem, takeSnackbars, timed } = require('./menu-driver');
const { forEachTextWidth } = require('./text-stress');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const DESKTOP_APPS = [{ id: 1, title: 'Desktop' }, { id: 2, title: 'Steam Big Picture' }, { id: 104, title: 'Forza Horizon 5' }];

// Open the app with the PC of the simulated Sunshine (or the three PCs of menu-driver.js), once the polling found it
// online. config goes to the simulated Sunshine (currentGame, apps), local to localStorage before the app starts. The
// waits of the start once more are short, and the module calls get their time (performance.now()) in `at`.
async function openPcList(config, hostsList, local) {
  const app = await openMenus(harness, {
    moduleScripts: ['sunshine-host.js'], stored: { hosts: hostsList || SUNSHINE_HOSTS },
    initScripts: ['window.__sunshineConfig = ' + JSON.stringify(config || {}) + ';' +
      Object.keys(local || {}).map((name) => 'localStorage.setItem(' + JSON.stringify(name) + ', ' + JSON.stringify(local[name]) + ');').join('')],
  });
  await app.page.waitForFunction(() => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true, null, { timeout: 15000 });
  await app.page.evaluate(() => {
    STREAM_RETRY_DELAY_MS = 100;
    HOST_START_HOLD_MS = 0;
    const push = window.__wasmCalls.push;
    window.__wasmCalls.push = function(call) {
      call.at = performance.now();
      return push.call(this, call);
    };
  });
  return app;
}

// The menu of GAMING-PC (its card selected, CH+), Shut down or restart the PC…, and the choice of the question with the
// keys of the remote
async function choosePower(page, choice) {
  await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
  await key(page, 'chup', 400);
  await selectItem(page, 'HostMenuDialog', 'powerHost-GAMING-PC', 'up', 'down');
  await key(page, 'ok', 0);
  // The question opens 100 ms after the menu closed
  await page.waitForFunction(() => window.__view === 'PcPowerDialog' && document.getElementById('pcPowerDialog').open, null, { timeout: 3000 });
  await page.waitForTimeout(150);
  if (choice) {
    await selectItem(page, 'PcPowerDialog', choice, 'up', 'down');
    await key(page, 'ok', 100);
  }
}

// The key events and texts that went to the module, as 'name args'
const sentToPc = (page) => page.evaluate(() => window.__wasmCalls.filter((call) => call.name === 'sendKeyboardEvent' || call.name === 'sendText')
  .map((call) => call.name + ' ' + call.args.join(',')));
// The requests to the PC that start, resume or quit an app
const startRequests = (page) => page.evaluate(() => window.__sunshine.http.filter((request) => /^\/(launch|resume|cancel)/.test(request)));
// The video of the stream plays (the first frame showed)
const videoPlays = (page) => page.evaluate(() => document.getElementById('wasm_module').dispatchEvent(new Event('timeupdate')));

const WIN_R = ['sendKeyboardEvent 32859,3,8', 'sendKeyboardEvent 32850,3,8', 'sendKeyboardEvent 32850,4,8', 'sendKeyboardEvent 32859,4,0'];
const ENTER_KEY = ['sendKeyboardEvent 32781,3,0', 'sendKeyboardEvent 32781,4,0'];

test('the menu of a PC that is online and paired offers Shut down or restart the PC… in red before Delete PC, an offline or unpaired PC doesn\'t', async () => {
  const app = await openPcList({}, THREE_HOSTS);
  try {
    await app.page.waitForFunction(() => hosts.HOST2.online === false && hosts.HOST3.online === false, null, { timeout: 15000 });
    const menuOf = (uid, change) => app.page.evaluate(({ id, extra }) => {
      const host = Object.assign(Object.create(Object.getPrototypeOf(hosts[id])), hosts[id], extra || {});
      hostMenuDialog(host);
      const items = Array.prototype.map.call(document.querySelectorAll('#hostMenuDialog-' + host.serverUid + ' button'),
        (button) => [button.id, button.classList.contains('is-danger')]);
      document.getElementById('closeHostMenu').click();
      return items;
    }, { id: uid, extra: change });
    assert.deepEqual(await menuOf('HOST1'), [['refreshApps-GAMING-PC', false], ['viewDetails-GAMING-PC', false], ['powerHost-GAMING-PC', true],
      ['deleteHost-GAMING-PC', true], ['closeHostMenu', false]]);
    // Offline and paired, offline and unpaired, online and unpaired, online but unknown yet
    assert.deepEqual((await menuOf('HOST2')).map((item) => item[0]), ['wakeHost-OFFICE-PC', 'viewDetails-OFFICE-PC', 'deleteHost-OFFICE-PC', 'closeHostMenu']);
    assert.deepEqual((await menuOf('HOST3')).map((item) => item[0]), ['wakeHost-LIVING-ROOM', 'viewDetails-LIVING-ROOM', 'deleteHost-LIVING-ROOM', 'closeHostMenu']);
    assert.ok(!(await menuOf('HOST1', { paired: false })).some((item) => item[0].indexOf('powerHost-') === 0), 'unpaired');
    // Nor Refresh apps, since the app list of a PC that isn't paired can't be asked (since 2.3.3)
    assert.ok(!(await menuOf('HOST1', { paired: false })).some((item) => item[0].indexOf('refreshApps-') === 0), 'unpaired');
    assert.ok(!(await menuOf('HOST1', { online: undefined })).some((item) => item[0].indexOf('powerHost-') === 0), 'unknown');
    // (The console has the errors of the PCs that don't answer, and of the menus closed at once by this test)
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the question opens on Cancel, ignores the second OK of a double press, and Cancel or RETURN close it with the selection on the PC and no request', async () => {
  const app = await openPcList({ apps: DESKTOP_APPS });
  try {
    await choosePower(app.page);
    let state = await menuState(app.page);
    assert.deepEqual([state.current, state.marked, state.openDialogs], ['cancelPcPower', ['cancelPcPower'], ['pcPowerDialog']]);
    assert.deepEqual(await app.page.evaluate(() => ({
      title: $('#pcPowerDialogTitle').text(), subtitle: $('#pcPowerDialogSubtitle').text(),
      buttons: Array.prototype.map.call(document.querySelectorAll('#pcPowerDialog button'), (button) => button.textContent.trim()),
      session: $('#pcPowerDialogSession').text(),
    })), {
      title: 'Shut down or restart the PC?', subtitle: 'GAMING-PC', buttons: ['Cancel', 'Restart the PC', 'Shut down the PC'],
      session: 'For this, Moonlight Plus first streams the app that runs on the PC, or else its Desktop app, for a few seconds.',
    });
    // UP stays on Cancel, DOWN stops on Shut down the PC
    await key(app.page, 'up', 100);
    await key(app.page, 'down', 100);
    await key(app.page, 'down', 100);
    await key(app.page, 'down', 100);
    assert.equal((await menuState(app.page)).current, 'shutdownPcPower');
    await key(app.page, 'back', 400);
    state = await menuState(app.page);
    // The focus is where the other questions of the menu of a PC leave it
    assert.deepEqual([state.view, state.openDialogs, state.current, state.marked, state.focused],
      ['Hosts', [], 'host-container-HOST1', ['host-container-HOST1'], 'hostMenuButton-HOST1']);
    // A double OK on the entry of the menu opens the question, whose Cancel the second OK doesn't press
    await key(app.page, 'chup', 400);
    await selectItem(app.page, 'HostMenuDialog', 'powerHost-GAMING-PC', 'up', 'down');
    await doubleKey(app.page, 'ok', 400, 150);
    state = await menuState(app.page);
    assert.deepEqual([state.view, state.current, state.openDialogs], ['PcPowerDialog', 'cancelPcPower', ['pcPowerDialog']]);
    // OK on Cancel after the wait closes it
    await app.page.waitForTimeout(350);
    await key(app.page, 'ok', 400);
    state = await menuState(app.page);
    assert.deepEqual([state.view, state.openDialogs, state.current, state.marked, state.focused],
      ['Hosts', [], 'host-container-HOST1', ['host-container-HOST1'], 'hostMenuButton-HOST1']);
    assert.deepEqual(await startRequests(app.page), []);
    assert.equal(await app.page.evaluate(() => isInGame), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Shut down from the PC list launches Desktop, waits for the picture, counts down, types the command and ends on the PC list', async () => {
  const app = await openPcList({ apps: DESKTOP_APPS });
  try {
    await app.page.evaluate(() => {
      PC_POWER_LIST_DELAY_MS = 1000;
    });
    await takeSnackbars(app.page);
    await choosePower(app.page, 'shutdownPcPower');
    await app.page.waitForFunction(() => isInGame === true, null, { timeout: 10000 });
    // The launch screen says what the start is for
    assert.equal(await app.page.evaluate(() => $('.launch-overline').text()), 'Shut down the PC');
    await app.page.waitForFunction(() => isStreamConnected === true, null, { timeout: 10000 });
    assert.deepEqual(await startRequests(app.page), ['/launch 1']);
    // The PC was opened as OK does: its app list is under the stream
    assert.equal(await app.page.evaluate(() => api && api.hostname), 'GAMING-PC');
    // Connected, but no picture yet: no countdown and nothing sent
    await app.page.waitForTimeout(1500);
    assert.deepEqual(await sentToPc(app.page), []);
    assert.ok(!(await takeSnackbars(app.page)).some((message) => message.indexOf('shuts down') >= 0));
    // The picture shows: the countdown, then the sequence
    const shownAt = await app.page.evaluate(() => performance.now());
    await videoPlays(app.page);
    assert.deepEqual(await takeSnackbars(app.page), ['GAMING-PC shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED']);
    await app.page.waitForFunction(() => window.__wasmCalls.some((call) => call.name === 'sendKeyboardEvent' && call.args[0] === 32781), null, { timeout: 8000 });
    await app.page.waitForTimeout(100);
    assert.deepEqual(await sentToPc(app.page), [...WIN_R, 'sendText shutdown /s /t 0', ...ENTER_KEY]);
    const firstKeyAt = await app.page.evaluate(() => window.__wasmCalls.find((call) => call.name === 'sendKeyboardEvent').at);
    assert.ok(firstKeyAt - shownAt >= 990, 'the countdown lasts PC_POWER_LIST_DELAY_MS: ' + Math.round(firstKeyAt - shownAt) + ' ms');
    assert.deepEqual(await takeSnackbars(app.page), ['Shutdown command sent to the PC']);
    // The stream goes on, so that the question of Windows about open apps can be answered with the remote: its video has
    // the focus, and the first key asks for the pointer lock, which gives the stream the keys (since 2.3.3; before, only
    // RETURN did, which sends Esc to the PC first and can cancel that question)
    assert.equal(await app.page.evaluate(() => document.activeElement && document.activeElement.id), 'wasm_module');
    await app.page.evaluate(() => {
      window.__videoMouseDowns = 0;
      document.getElementById('wasm_module').addEventListener('mousedown', () => window.__videoMouseDowns++, true);
    });
    await key(app.page, 'right', 100);
    assert.equal(await app.page.evaluate(() => window.__videoMouseDowns), 1, 'the first key asks for the pointer lock');
    assert.deepEqual(await sentToPc(app.page), [...WIN_R, 'sendText shutdown /s /t 0', ...ENTER_KEY], 'no Esc');
    // The PC goes off and ends the stream
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await app.page.waitForTimeout(600);
    const state = await menuState(app.page);
    assert.equal(state.view, 'Hosts');
    assert.equal(await app.page.evaluate(() => $('#host-grid').is(':visible')), true);
    assert.deepEqual(await takeSnackbars(app.page), ['GAMING-PC is shutting down.']);
    // No quit of Desktop, and the request of the session is over
    assert.deepEqual(await startRequests(app.page), ['/launch 1']);
    assert.deepEqual(await app.page.evaluate(() => [streamPcPower, pcPowerCommand]), [null, null]);
    assert.ok(!app.logs.some((line) => line.indexOf('shutdown /') >= 0), 'the log has no command');
    assert.ok(app.logs.some((line) => line.indexOf('PC power: shutdown of GAMING-PC: streaming app 1 (launch).') >= 0));
    // The session isn't a game that was played: the app list keeps its selection, and Recently played doesn't list Desktop
    assert.deepEqual(await app.page.evaluate(() => [localStorage.getItem('lastOpenedApp_HOST1'), localStorage.getItem('recentApps_HOST1')]), [null, null]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Restart from the PC list resumes the game that runs on the PC, without the question to quit it, and ends with "is restarting."', async () => {
  const app = await openPcList({ currentGame: 104, apps: DESKTOP_APPS });
  try {
    await app.page.waitForFunction(() => Number(hosts.HOST1.currentGame) === 104, null, { timeout: 10000 });
    await app.page.evaluate(() => {
      PC_POWER_LIST_DELAY_MS = 200;
    });
    await takeSnackbars(app.page);
    await choosePower(app.page, 'restartPcPower');
    await app.page.waitForFunction(() => isInGame === true, null, { timeout: 10000 });
    assert.equal(await app.page.evaluate(() => $('.launch-overline').text()), 'Restart the PC');
    await app.page.waitForFunction(() => isStreamConnected === true, null, { timeout: 10000 });
    assert.deepEqual(await startRequests(app.page), ['/resume']);
    assert.deepEqual((await menuState(app.page)).openDialogs, [], 'no question to quit the running game');
    await videoPlays(app.page);
    await app.page.waitForFunction(() => window.__wasmCalls.some((call) => call.name === 'sendKeyboardEvent' && call.args[0] === 32781), null, { timeout: 8000 });
    assert.deepEqual(await sentToPc(app.page), [...WIN_R, 'sendText shutdown /r /t 0', ...ENTER_KEY]);
    await app.page.evaluate(() => handleMessage('streamTerminated: -1'));
    await app.page.waitForTimeout(600);
    assert.deepEqual(await takeSnackbars(app.page), ['GAMING-PC restarts in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED',
      'Restart command sent to the PC', 'GAMING-PC is restarting.']);
    assert.equal((await menuState(app.page)).view, 'Hosts');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a double OK on Shut down the PC starts the shutdown, not the game that the app list selects, and CH+ opens no app menu meanwhile', async () => {
  // The app list of GAMING-PC selects Forza, the last app that was played
  const app = await openPcList({ apps: DESKTOP_APPS }, null, { lastOpenedApp_HOST1: '104' });
  try {
    await app.page.evaluate(() => {
      PC_POWER_LIST_DELAY_MS = 200;
      // The PC answers slowly, as over Wi-Fi: the app list shows while the session reads its apps and startGame() reads
      // the app, and takes the keys
      const host = hosts.HOST1;
      const slow = (name, ms) => {
        const real = host[name];
        host[name] = function() {
          const args = arguments;
          return new Promise((resolve) => setTimeout(resolve, ms)).then(() => real.apply(host, args));
        };
      };
      // The tiles show after about 400 ms, the session has read its apps after about 800 ms, and startGame() the app
      // after about 1600 ms, when the launch screen shows
      slow('getAppList', 400);
      slow('getAppById', 800);
      window.__appMenus = 0;
      const open = openAppMenu;
      openAppMenu = function() {
        window.__appMenus++;
        return open.apply(this, arguments);
      };
    });
    await takeSnackbars(app.page);
    await choosePower(app.page);
    await selectItem(app.page, 'PcPowerDialog', 'shutdownPcPower', 'up', 'down');
    // OK and its second press 150 ms later, CH+ on the tile of Forza once the tiles show, and OK on it while startGame()
    // of the session reads the app (a start of Forza then would replace the shutdown; the app list ignores a second start
    // within 2 s, so this is the one)
    await timed(app.page, [{ at: 0, key: 'ok' }, { at: 150, key: 'ok' }, { at: 550, key: 'chup' }, { at: 1150, key: 'ok' }], 0);
    await app.page.waitForFunction(() => isStreamConnected === true, null, { timeout: 10000 });
    assert.deepEqual(await startRequests(app.page), ['/launch 1']);
    assert.deepEqual(await app.page.evaluate(() => [$('.launch-overline').text(), streamPcPower && streamPcPower.kind, window.__appMenus]),
      ['Shut down the PC', 'shutdown', 0]);
    assert.ok(app.logs.some((line) => line.indexOf('Ignoring the start of app 104 while the PC is about to be shut down or restarted') >= 0));
    await videoPlays(app.page);
    await app.page.waitForFunction(() => window.__wasmCalls.some((call) => call.name === 'sendKeyboardEvent' && call.args[0] === 32781), null, { timeout: 8000 });
    assert.deepEqual(await sentToPc(app.page), [...WIN_R, 'sendText shutdown /s /t 0', ...ENTER_KEY]);
    // The session is over once its start began: the app list takes OK again after the stream
    await app.page.evaluate(() => handleMessage('streamTerminated: 0'));
    await app.page.waitForTimeout(600);
    assert.deepEqual(await app.page.evaluate(() => [pcPowerSessionStart, localStorage.getItem('lastOpenedApp_HOST1')]), [null, '104']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a double click on Shut down the PC starts one session and leaves the views in order, so RETURN goes from the app list to the PC list', async () => {
  const app = await openPcList({ apps: DESKTOP_APPS });
  try {
    await choosePower(app.page);
    await app.page.evaluate(() => {
      $('#shutdownPcPower').click();
      $('#shutdownPcPower').click();
    });
    await app.page.waitForFunction(() => isStreamConnected === true, null, { timeout: 10000 });
    assert.deepEqual(await startRequests(app.page), ['/launch 1']);
    // RED ends the stream: the app list, then RETURN to the PC list
    await key(app.page, 'red', 0);
    await app.page.waitForFunction(() => isInGame === false && window.__view === 'Apps', null, { timeout: 5000 });
    await app.page.waitForTimeout(1500);
    await key(app.page, 'back', 400);
    const state = await menuState(app.page);
    assert.deepEqual([state.view, state.current, state.marked], ['Hosts', 'host-container-HOST1', ['host-container-HOST1']]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC that runs an app its app list doesn\'t show gets a message of its own, and nothing starts', async () => {
  const app = await openPcList({ currentGame: 999, apps: DESKTOP_APPS });
  try {
    await app.page.waitForFunction(() => Number(hosts.HOST1.currentGame) === 999, null, { timeout: 10000 });
    await takeSnackbars(app.page);
    await app.page.evaluate(() => {
      window.__requestsFrom = window.__sunshine.http.length;
    });
    await choosePower(app.page, 'shutdownPcPower');
    await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 5000 });
    assert.deepEqual(await takeSnackbars(app.page), ['GAMING-PC runs an app that isn\'t in its app list. Quit it first with "Quit app on the PC", then try again.']);
    // The session read the list of the PC once more after its server info, since the list that the TV had lacked the
    // app (findHostApp() in index.js, since 2.3.3), before it said so
    const requests = await app.page.evaluate(() => window.__sunshine.http.slice(window.__requestsFrom));
    assert.ok(requests.indexOf('/applist', requests.indexOf('/serverinfo') + 1) > 0, requests.join(', '));
    assert.ok(app.logs.some((line) => line.indexOf('App 999 is not in the app list that GAMING-PC sent before, reading the list again.') >= 0));
    await app.page.waitForTimeout(500);
    assert.deepEqual(await startRequests(app.page), []);
    assert.deepEqual(await app.page.evaluate(() => [isInGame, pcPowerSessionStart]), [false, null]);
    assert.equal((await menuState(app.page)).view, 'Apps');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC whose running app the list of the TV lacks reads the list once more and resumes the app', async () => {
  const app = await openPcList({ apps: DESKTOP_APPS });
  try {
    // The TV read the list of the PC; then the PC got a new app, which another device started
    await app.page.evaluate(async () => {
      PC_POWER_LIST_DELAY_MS = 200;
      await hosts.HOST1.getAppListWithCacheFlush();
      window.__sunshine.apps.push({ id: 999, title: 'New Game' });
      window.__sunshine.currentGame = 999;
    });
    await takeSnackbars(app.page);
    await choosePower(app.page, 'restartPcPower');
    await app.page.waitForFunction(() => isInGame === true, null, { timeout: 10000 });
    assert.equal(await app.page.evaluate(() => $('.launch-overline').text()), 'Restart the PC');
    await app.page.waitForFunction(() => window.__sunshine.http.some((request) => request.indexOf('/resume') === 0), null, { timeout: 10000 });
    assert.deepEqual(await startRequests(app.page), ['/resume']);
    assert.equal(await app.page.evaluate(() => streamLaunchAppId), 999);
    assert.ok(!(await takeSnackbars(app.page)).some((message) => message.indexOf('isn\'t in its app list') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC without a Desktop app and with nothing running gets a message, and nothing starts', async () => {
  const app = await openPcList({ apps: [{ id: 2, title: 'Steam Big Picture' }, { id: 104, title: 'Forza Horizon 5' }] });
  try {
    await takeSnackbars(app.page);
    await choosePower(app.page, 'shutdownPcPower');
    await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 5000 });
    assert.deepEqual(await takeSnackbars(app.page), ['GAMING-PC has no Desktop app to stream for this. Stream one of its apps and use the Stream Menu instead.']);
    assert.deepEqual(await startRequests(app.page), []);
    assert.equal(await app.page.evaluate(() => isInGame), false);
    // The app list of the PC shows
    assert.equal((await menuState(app.page)).view, 'Apps');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RETURN during the countdown ends the stream: the Desktop app that the session launched is quit again, a resumed game keeps running', async () => {
  for (const config of [{ apps: DESKTOP_APPS, currentGame: 0, quits: ['/launch 1', '/cancel'] }, { apps: DESKTOP_APPS, currentGame: 104, quits: ['/resume'] }]) {
    const app = await openPcList(config);
    try {
      await app.page.waitForFunction((game) => Number(hosts.HOST1.currentGame) === game, config.currentGame, { timeout: 10000 });
      await choosePower(app.page, 'shutdownPcPower');
      await app.page.waitForFunction(() => isStreamConnected === true, null, { timeout: 10000 });
      await videoPlays(app.page);
      await app.page.waitForTimeout(1000);
      await key(app.page, 'back', 0);
      await app.page.waitForFunction(() => isInGame === false && window.__view === 'Apps', null, { timeout: 5000 });
      if (config.quits.includes('/cancel')) {
        await app.page.waitForFunction(() => window.__sunshine.http.some((request) => request.indexOf('/cancel') === 0), null, { timeout: 5000 });
      } else {
        await app.page.waitForTimeout(1000);
      }
      assert.deepEqual(await sentToPc(app.page), [], 'nothing was typed');
      assert.deepEqual(await startRequests(app.page), config.quits);
      assert.equal(await app.page.evaluate(() => isInGame), false);
      assert.equal((await menuState(app.page)).view, 'Apps');
      assert.deepEqual(await app.page.evaluate(() => [streamPcPower, pcPowerCommand]), [null, null]);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('without a picture nothing is typed; a stream without video starts once more with the request and counts down after the longest wait for its picture', async () => {
  const app = await openPcList({ apps: DESKTOP_APPS });
  try {
    await app.page.evaluate(() => {
      PC_POWER_PICTURE_WAIT_MS = 2000;
      PC_POWER_LIST_DELAY_MS = 200;
    });
    await takeSnackbars(app.page);
    await choosePower(app.page, 'shutdownPcPower');
    await app.page.waitForFunction(() => isStreamConnected === true, null, { timeout: 10000 });
    await app.page.waitForTimeout(1000);
    assert.deepEqual(await sentToPc(app.page), []);
    // No video arrived: the stream starts once more, without a quit, and keeps the request
    await app.page.evaluate(() => handleMessage('streamTerminated: -100'));
    await app.page.waitForTimeout(50);
    assert.ok(!(await startRequests(app.page)).includes('/cancel'), 'the Desktop app isn\'t quit');
    assert.deepEqual(await app.page.evaluate(() => [isInGame, streamPcPower && streamPcPower.kind, $('.launch-overline').text()]), [true, 'shutdown', 'Shut down the PC']);
    await app.page.waitForFunction(() => isStreamConnected === true, null, { timeout: 10000 });
    // The second start resumes the Desktop app that the first one launched. Its video tells nothing either: the countdown
    // starts PC_POWER_PICTURE_WAIT_MS after the connection, when a stream without video would have ended
    assert.deepEqual(await startRequests(app.page), ['/launch 1', '/resume']);
    await app.page.waitForTimeout(1000);
    assert.deepEqual(await sentToPc(app.page), []);
    await app.page.waitForFunction(() => window.__wasmCalls.some((call) => call.name === 'sendKeyboardEvent' && call.args[0] === 32781), null, { timeout: 8000 });
    assert.deepEqual(await sentToPc(app.page), [...WIN_R, 'sendText shutdown /s /t 0', ...ENTER_KEY]);
    assert.ok(app.logs.some((line) => line.indexOf('the picture shows (no answer of the video within 2000 ms)') >= 0));
    assert.deepEqual((await takeSnackbars(app.page)).filter((message) => message.indexOf('shuts down') >= 0),
      ['GAMING-PC shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a start that the PC refuses ends on the app list, and the next ordinary start has no command and says Starting again, in every language', async () => {
  const app = await openPcList({ apps: DESKTOP_APPS });
  try {
    await app.page.evaluate(() => {
      // Another device streams: Sunshine refuses the launch
      const launch = hosts.HOST1.launchApp;
      hosts.HOST1.launchApp = function() {
        hosts.HOST1.launchApp = launch;
        return Promise.resolve('<root status_code="503" status_message="Another device is streaming"></root>');
      };
    });
    await takeSnackbars(app.page);
    await choosePower(app.page, 'shutdownPcPower');
    await app.page.waitForFunction(() => window.__snackbars.some((message) => message.indexOf('503') >= 0) && isInGame === false, null, { timeout: 8000 });
    assert.ok((await takeSnackbars(app.page)).some((message) => message.indexOf('503') >= 0));
    assert.equal((await menuState(app.page)).view, 'Apps');
    // The next ordinary start: Starting, and no command once its picture shows
    await app.page.evaluate(() => startGame(hosts.HOST1, 104));
    await app.page.waitForFunction(() => isInGame === true, null, { timeout: 10000 });
    assert.deepEqual(await app.page.evaluate(() => [$('.launch-overline').text(), $('.launch-overline').attr('data-i18n'), streamPcPower]), ['Starting', 'Starting', null]);
    await app.page.waitForFunction(() => isStreamConnected === true, null, { timeout: 10000 });
    await videoPlays(app.page);
    await app.page.waitForTimeout(1500);
    assert.deepEqual(await sentToPc(app.page), []);
    assert.equal(await app.page.evaluate(() => pcPowerCommand), null);
    // The overline of a power session follows a change of the language (its key stays on the element)
    await app.page.evaluate(() => Launcher.prepareStart(hosts.HOST1, 1, 'Desktop', 'Shut down the PC'));
    await app.page.evaluate(() => i18n.setLanguage('de-DE'));
    await app.page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE');
    assert.equal(await app.page.evaluate(() => $('.launch-overline').text()), 'PC herunterfahren');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('in every language the question and the entry of the menu of a PC fit, with each choice on one line, also with 10 % wider text', async () => {
  const app = await openPcList({ apps: DESKTOP_APPS });
  try {
    const languages = await app.page.evaluate(() => i18n.getSupportedLocales());
    for (const language of languages) {
      await app.page.evaluate((locale) => i18n.setLanguage(locale), language);
      await app.page.waitForFunction((locale) => document.documentElement.getAttribute('lang') === locale, language);
      await forEachTextWidth(app.page, async (stress) => {
        const name = language + stress;
        const fit = await app.page.evaluate(() => {
          const lines = (element) => {
            const style = getComputedStyle(element);
            return Math.round((element.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) /
              parseFloat(style.lineHeight));
          };
          hostMenuDialog(hosts.HOST1);
          const entry = document.querySelector('#powerHost-GAMING-PC .overlay-menu-label');
          const entryLines = lines(entry);
          document.getElementById('closeHostMenu').click();
          pcPowerDialog(hosts.HOST1);
          const dialog = document.getElementById('pcPowerDialog');
          const rect = dialog.getBoundingClientRect();
          const result = {
            entryLines,
            inside: rect.top >= window.innerHeight * 0.05 && rect.bottom <= window.innerHeight * 0.95 && rect.left >= window.innerWidth * 0.05 &&
              rect.right <= window.innerWidth * 0.95,
            scrolls: dialog.scrollHeight > dialog.clientHeight,
            titleLines: lines(document.getElementById('pcPowerDialogTitle')),
            labels: Array.prototype.map.call(dialog.querySelectorAll('.overlay-menu-label'), lines),
            height: Math.round(rect.height),
          };
          document.getElementById('cancelPcPower').click();
          return result;
        });
        assert.equal(fit.entryLines, 1, name + ' ' + JSON.stringify(fit));
        assert.ok(fit.inside && !fit.scrolls && fit.titleLines <= 2, name + ' ' + JSON.stringify(fit));
        assert.deepEqual(fit.labels, [1, 1, 1], name);
      });
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
