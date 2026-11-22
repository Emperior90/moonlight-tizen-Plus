'use strict';

// Checks what the app list says when its PC no longer accepts this TV (since 2.3.3): Sunshine forgot the TV while its
// app list showed or during a stream ("Unpair All", or the TV turned off in its list of clients), and answers every
// HTTPS request with its 401 answer, which refreshServerInfoAtAddress() of utils.js rejects with HOST_REFUSED_TV_ERROR.
// - OK on an app (startGame() in wasm/platform/index.js) says so instead of "Failed to connect", and once a check marked
//   the PC not paired, it says so instead of nothing,
// - "Quit app on the PC" (stopGame()) the same, instead of "Unable to quit the app" or nothing, also when the PC
//   refuses the TV only right after it quit the app,
// - the end of a stream (leaveStreamView() of messages.js) goes to the PC list with that message, where the PC shows
//   Unpaired after its next check, instead of an empty app list; with a dialog over the stream, the app list shows
//   with the message,
// - "Shut down or restart the PC" from the PC list (startPcPowerSession()) says so instead of "Failed to connect",
// - opening the PC, whose app list it answers with its 401 answer (getAppListWithCacheFlush() of utils.js), says so and
//   marks the PC not paired at once, as a poll does, instead of an app list that couldn't be read for no reason.
// The PC is the simulated Sunshine of mocks/sunshine-host.js, stored as paired; state.unpair() makes it forget the TV.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, openApp, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const REFUSED = 'GAMING-PC no longer accepts this TV: its pairing was removed or turned off on the PC. Select it in the list of PCs to pair it again.';

// Open the app with the simulated PC stored as paired (running currentGame, if any), record the snackbar messages,
// and open its app list as OK on its card does. The app list resumes the polling of the PC once its box art loaded
// (showApps()), which the tests stop again: they poll by hand (poll()), so that no poll of the 5-second loop changes the
// requests or the state that they check.
async function openAppList(currentGame) {
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    moduleScripts: ['sunshine-host.js'],
    stored: { hosts: SUNSHINE_HOSTS },
    initScripts: ['window.__sunshineConfig = { currentGame: ' + (currentGame || 0) + ' };'],
  });
  await app.page.waitForFunction((game) => hosts.HOST1 && hosts.HOST1.online === true && Number(hosts.HOST1.currentGame) === game,
    currentGame || 0, { timeout: 10000 });
  await app.page.evaluate(() => {
    window.__snackbars = [];
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    const show = snackbar.showSnackbar.bind(snackbar);
    snackbar.showSnackbar = (data) => {
      window.__snackbars.push(data.message);
      show(data);
    };
    $('#host-container-HOST1').click();
  });
  await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length > 0 &&
    !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
  // The polling resumed, and its first request ended (its loop waits for the next poll)
  await app.page.waitForFunction(() => typeof activePolls.HOST1 === 'number', null, { timeout: 5000 });
  await app.page.evaluate(() => endBackgroundPollingOfHost(hosts.HOST1));
  await app.page.waitForTimeout(300);
  return app;
}

// OK on the tile of Cyberpunk 2077 (app 101), which ignores an OK right after another one (lastAppTileClickAt)
const startApp = (page) => page.evaluate(() => {
  lastHostClickAt = -Infinity;
  lastAppTileClickAt = -Infinity;
  $('#game-container-101').click();
});

// What the app shows, and the requests since the last call
const take = (page) => page.evaluate(() => ({
  view: document.body.getAttribute('data-view'),
  loading: $('#wasmSpinner').is(':visible') ? $('#wasmSpinnerMessage').text() : '',
  startScreen: $('#loadingSpinner').is(':visible'),
  isInGame,
  snackbars: window.__snackbars.splice(0),
  requests: window.__sunshine.http.splice(0),
  paired: hosts.HOST1.paired,
}));

// The poll of the PC (openAppList() stopped the background polling)
const poll = (page) => page.evaluate(() => new Promise((resolve) => hosts.HOST1.pollServer(() => resolve())));

test('OK on an app of a PC that no longer accepts the TV says so, also once a check marked the PC not paired', async () => {
  const app = await openAppList();
  try {
    await take(app.page);
    await app.page.evaluate(() => window.__sunshine.unpair());
    // The refresh of the start gets the 401 answer: no launch request, the app list stays
    await startApp(app.page);
    await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 5000 });
    await app.page.waitForTimeout(200);
    let state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual(state.requests, ['/serverinfo']);
    assert.deepEqual([state.view, state.startScreen, state.isInGame], ['apps', false, false]);

    // A check marks the PC not paired; OK on an app says the same, without a request
    await poll(app.page);
    assert.equal((await take(app.page)).paired, false);
    await startApp(app.page);
    await app.page.waitForTimeout(400);
    state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual(state.requests, []);
    assert.deepEqual([state.view, state.startScreen, state.isInGame], ['apps', false, false]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('"Quit app on the PC" of a PC that no longer accepts the TV says so, without the quit request', async () => {
  const app = await openAppList(101);
  try {
    await take(app.page);
    await app.page.evaluate(() => window.__sunshine.unpair());
    // A check marked the PC not paired: the message at once, without the question to quit and without a request, as OK
    // on an app (2.3.3 in testing asked "Are you sure you want to quit …?" first, and only Yes said that it can't)
    await poll(app.page);
    assert.equal((await take(app.page)).paired, false);
    await app.page.evaluate(() => $('#quitRunningAppBtn').trigger('click'));
    await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 5000 });
    await app.page.waitForTimeout(500);
    let state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual(state.requests, []);
    assert.deepEqual(await app.page.evaluate(() => [document.getElementById('quitAppDialog').open, isDialogOpen]), [false, false]);

    // Before such a check: the question, then the refresh before the quit gets the 401 answer, and the quit request
    // isn't sent
    await app.page.evaluate(() => {
      hosts.HOST1.paired = true;
      $('#quitRunningAppBtn').trigger('click');
    });
    await app.page.waitForFunction(() => document.getElementById('quitAppDialog').open, null, { timeout: 3000 });
    await app.page.evaluate(() => $('#continueQuitApp').trigger('click'));
    await app.page.waitForFunction(() => window.__snackbars.length > 0 && $('#game-grid').is(':visible') && !$('#wasmSpinner').is(':visible'),
      null, { timeout: 5000 });
    await app.page.waitForTimeout(500);
    state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.equal(state.requests[0], '/serverinfo');
    assert.equal(state.requests.indexOf('/cancel'), -1, JSON.stringify(state.requests));
    assert.equal(await app.page.evaluate(() => window.__sunshine.currentGame), 101);
    // The list from the copy resumed the polling of the PC: its first check (which marks the PC not paired) ends, and the
    // polling stops again, as in openAppList()
    await app.page.waitForFunction(() => typeof activePolls.HOST1 === 'number', null, { timeout: 5000 });
    await app.page.evaluate(() => endBackgroundPollingOfHost(hosts.HOST1));
    await app.page.waitForTimeout(300);
    await take(app.page);

    // Before such a check and without the copy of the app list in the TV: the question reads the list first, whose 401
    // answer marks the PC not paired, so the message comes instead of the question (2.3.3 in testing asked first)
    await app.page.evaluate(() => {
      hosts.HOST1.paired = true;
      hosts.HOST1._memCachedApplist = null;
      $('#quitRunningAppBtn').trigger('click');
    });
    await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 5000 });
    await app.page.waitForTimeout(500);
    state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual(state.requests, ['/applist']);
    assert.deepEqual(await app.page.evaluate(() => [document.getElementById('quitAppDialog').open, isDialogOpen]), [false, false]);
    assert.equal(await app.page.evaluate(() => window.__sunshine.currentGame), 101);
    // The app list told it: the PC is not paired any more
    assert.equal((await take(app.page)).paired, false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('"Quit app on the PC" says so when the PC refuses the TV only right after it quit the app', async () => {
  const app = await openAppList(101);
  try {
    await take(app.page);
    // The PC quits the app (/cancel), and forgets the TV right after: the refresh that checks the quit gets the 401 answer
    await app.page.evaluate(() => {
      window.__sunshine.onAnswered = (path) => {
        if (path === '/cancel') {
          window.__sunshine.unpair();
        }
      };
      $('#quitRunningAppBtn').trigger('click');
    });
    await app.page.waitForFunction(() => document.getElementById('quitAppDialog').open, null, { timeout: 3000 });
    await app.page.evaluate(() => $('#continueQuitApp').trigger('click'));
    await app.page.waitForFunction((text) => window.__snackbars.indexOf(text) >= 0, REFUSED, { timeout: 5000 });
    await app.page.waitForTimeout(500);
    const state = await take(app.page);
    assert.deepEqual(state.requests.slice(0, 3), ['/serverinfo', '/cancel', '/serverinfo']);
    assert.equal(state.snackbars[state.snackbars.length - 1], REFUSED, JSON.stringify(state.snackbars));
    assert.deepEqual(state.snackbars.filter((message) => /Unable to quit|still running|Successfully quit/.test(message)), []);
    assert.equal(await app.page.evaluate(() => window.__sunshine.currentGame), 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the end of a stream of a PC that no longer accepts the TV goes to the PC list with that message, where the PC shows Unpaired', async () => {
  const app = await openAppList();
  try {
    await startApp(app.page);
    await app.page.waitForFunction(() => wasmSessionStarted && $('#wasm_module').is(':visible'), null, { timeout: 8000 });
    await take(app.page);
    // Sunshine forgets the TV during the stream, which then ends
    await app.page.evaluate(() => {
      window.__sunshine.unpair();
      handleMessage('streamTerminated: 0');
    });
    await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'hosts' && window.__snackbars.length > 0, null, { timeout: 5000 });
    await app.page.waitForTimeout(300);
    const state = await take(app.page);
    assert.deepEqual(state.snackbars, [REFUSED]);
    assert.deepEqual([state.view, state.loading, state.startScreen, state.isInGame], ['hosts', '', false, false]);
    assert.equal(await app.page.evaluate(() => $('#host-grid').is(':visible') && !$('#game-grid').is(':visible')), true);
    // The check of the PC list marks it not paired
    await app.page.waitForFunction(() => document.getElementById('host-container-HOST1').getAttribute('data-state') === 'locked', null, { timeout: 5000 });
    assert.deepEqual(await app.page.evaluate(() => [hosts.HOST1.online, hosts.HOST1.paired, hosts.HOST1.ppkstr]), [true, false, 'PPK']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('"Quit app on the PC" of the Stream Menu of a PC that dropped the TV during the stream says so once, also without the app list in the TV', async () => {
  // With the copy of the app list that the TV read, the list shows from it; without one, the list after the quit gets the
  // 401 answer as well, which said it once more in 2.3.3 in testing (stopGame() passes refusalSaid to showApps())
  for (const hasList of [true, false]) {
    const app = await openAppList(101);
    try {
      await startApp(app.page);
      await app.page.waitForFunction(() => wasmSessionStarted && $('#wasm_module').is(':visible'), null, { timeout: 8000 });
      await take(app.page);
      // Sunshine forgets the TV during the stream, which the Stream Menu's "Quit app on the PC" then ends (menus.js)
      await app.page.evaluate((keepList) => {
        window.__sunshine.unpair();
        if (!keepList) {
          hosts.HOST1._memCachedApplist = null;
        }
        quitAppAfterStream = true;
        handleMessage('streamTerminated: 0');
      }, hasList);
      await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && !$('#wasmSpinner').is(':visible') &&
        window.__snackbars.length > 0, null, { timeout: 5000 });
      await app.page.waitForTimeout(1000);
      const state = await take(app.page);
      assert.deepEqual(state.snackbars, [REFUSED], 'with the list: ' + hasList);
      assert.equal(state.requests.indexOf('/cancel'), -1, JSON.stringify(state.requests));
      assert.deepEqual(state.requests.filter((request) => request === '/applist'), hasList ? [] : ['/applist']);
      assert.deepEqual([state.loading, state.startScreen, state.isInGame], ['', false, false]);
      if (!hasList) {
        // The list couldn't be read, and the card of the PC shows it Unpaired already
        assert.deepEqual(await app.page.evaluate(() => [$('#game-grid img').attr('src'), hosts.HOST1.paired,
          document.getElementById('host-container-HOST1').getAttribute('data-state')]), ['static/res/applist_error.svg', false, 'locked']);
      }
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('OK on another app of a PC that drops the TV right after the server info of the start says so, without the question to quit', async () => {
  // Without the copy of the app list in the TV (the start reads the list for the app it starts), and with a copy that
  // lacks the running app (the question reads the list once more): the 401 answer of the list marks the PC not paired,
  // and the start says so instead of "Unable to retrieve your list of apps …" or the question
  for (const variant of ['no list', 'running app missing']) {
    const app = await openAppList(variant === 'no list' ? 101 : 999);
    try {
      await app.page.evaluate((noList) => {
        if (noList) {
          hosts.HOST1._memCachedApplist = null;
        }
        window.__sunshine.onAnswered = (path) => {
          if (path === '/serverinfo') {
            window.__sunshine.onAnswered = null;
            window.__sunshine.unpair();
          }
        };
      }, variant === 'no list');
      await take(app.page);
      await app.page.evaluate(() => {
        lastHostClickAt = -Infinity;
        lastAppTileClickAt = -Infinity;
        $('#game-container-103').click();
      });
      await app.page.waitForFunction(() => window.__snackbars.length > 0, null, { timeout: 5000 });
      await app.page.waitForTimeout(500);
      const state = await take(app.page);
      assert.deepEqual(state.snackbars, [REFUSED], variant);
      assert.deepEqual(state.requests, ['/serverinfo', '/applist'], variant);
      assert.deepEqual([state.view, state.startScreen, state.isInGame, state.paired], ['apps', false, false, false], variant);
      assert.deepEqual(await app.page.evaluate(() => [document.getElementById('quitAppDialog').open, isDialogOpen,
        document.getElementById('host-container-HOST1').getAttribute('data-state')]), [false, false, 'locked'], variant);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the end of a stream of a PC that no longer accepts the TV, with a dialog over it, says so and leaves the dialog on the app list', async () => {
  const app = await openAppList();
  try {
    await startApp(app.page);
    await app.page.waitForFunction(() => wasmSessionStarted && $('#wasm_module').is(':visible'), null, { timeout: 8000 });
    await take(app.page);
    // Sunshine forgets the TV during the stream, which then ends, and a dialog opens over its end (as the message of an
    // error can) before the refresh of the PC answers
    await app.page.evaluate(() => {
      window.__sunshine.unpair();
      handleMessage('streamTerminated: 0');
      warningDialog('Connection Error', 'The connection to the PC was lost.');
    });
    await app.page.waitForFunction((text) => window.__snackbars.indexOf(text) >= 0, REFUSED, { timeout: 5000 });
    await app.page.waitForTimeout(500);
    const state = await take(app.page);
    assert.ok(state.snackbars.indexOf(REFUSED) >= 0, JSON.stringify(state.snackbars));
    assert.deepEqual([state.loading, state.startScreen, state.isInGame], ['', false, false]);
    // No PC list, whose view change would take the place of the dialog: the dialog stays over the app list
    assert.deepEqual(await app.page.evaluate(() => [isDialogOpen, $('#host-grid').is(':visible'), $('#game-grid').is(':visible'),
      document.querySelector('dialog[open]') !== null]), [true, false, true, true]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('"Shut down the PC" from the PC list of a PC that no longer accepts the TV says so, and streams nothing', async () => {
  // With the copy of the app list that the TV read (the server info of the session gets the 401 answer), and without
  // one (the app list that the session opens first gets it, which marks the PC not paired and says so: since 2.3.3,
  // getAppListWithCacheFlush() of utils.js and showApps(); the session then asks nothing more, so the message shows once)
  for (const hasList of [true, false]) {
    const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, moduleScripts: ['sunshine-host.js'], stored: { hosts: SUNSHINE_HOSTS } });
    try {
      await app.page.waitForFunction(() => hosts.HOST1 && hosts.HOST1.online === true && hosts.HOST1.paired === true, null, { timeout: 10000 });
      await app.page.evaluate(async (keepList) => {
        window.__snackbars = [];
        document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbars.push(data.message);
        if (keepList) {
          await hosts.HOST1.getAppList();
        } else {
          hosts.HOST1._memCachedApplist = null;
        }
        // Sunshine forgot the TV a moment ago, before a check of the PC list noticed it
        window.__sunshine.unpair();
        startPcPowerSession(hosts.HOST1, 'shutdown');
      }, hasList);
      await app.page.waitForFunction((text) => window.__snackbars.indexOf(text) >= 0, REFUSED, { timeout: 5000 });
      await app.page.waitForTimeout(300);
      const state = await take(app.page);
      assert.deepEqual(state.snackbars, [REFUSED], 'with the list: ' + hasList);
      assert.equal(state.requests.filter((request) => /^\/(launch|resume)/.test(request)).length, 0, JSON.stringify(state.requests));
      assert.deepEqual(await app.page.evaluate(() => [window.__sunshine.starts.length, isPcPowerSessionStarting(), isInGame]), [0, false, false]);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('opening a PC whose app list it answers with its 401 answer says so, and the PC shows Unpaired at once', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, moduleScripts: ['sunshine-host.js'], stored: { hosts: SUNSHINE_HOSTS } });
  try {
    await app.page.waitForFunction(() => hosts.HOST1 && hosts.HOST1.online === true && hosts.HOST1.paired === true, null, { timeout: 10000 });
    // No check of the PC list runs from now on: one that is still on its way ends first (its answer still accepts the
    // TV), so that only the app list can tell the TV that the PC refuses it, and no check draws the card of the PC
    await app.page.evaluate(() => stopPollingHosts());
    await app.page.waitForTimeout(300);
    await app.page.evaluate(() => {
      window.__snackbars = [];
      document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbars.push(data.message);
      // Sunshine forgot the TV a moment ago, before a check of the PC list noticed it, and the TV has no copy of the list
      window.__sunshine.unpair();
      hosts.HOST1._memCachedApplist = null;
      window.__sunshine.http.splice(0);
      $('#host-container-HOST1').click();
    });
    await app.page.waitForFunction((text) => window.__snackbars.indexOf(text) >= 0, REFUSED, { timeout: 5000 });
    await app.page.waitForTimeout(300);
    const state = await take(app.page);
    // The request of the list told it (since 2.3.3; in testing only the next poll did, and the list said to try again
    // later): the PC is not paired any more, and the top of the screen says that the list couldn't be read
    assert.deepEqual([state.view, state.snackbars, state.requests.filter((request) => request === '/applist'), state.paired],
      ['apps', [REFUSED], ['/applist'], false]);
    assert.deepEqual(await app.page.evaluate(() => [$('#game-grid img').attr('src'), document.getElementById('hero-text').textContent]),
      ['static/res/applist_error.svg', 'The app list of this PC couldn\'t be read. Go back with RETURN and open the PC to try again.']);
    // RETURN: the PC list shows the PC Unpaired at once, also while the first check of the PC list still waits for the
    // PC, which answers slowly from now on (2.3.3 in testing showed it Online until that check was back)
    await app.page.evaluate(() => {
      window.__sunshine.delayMs = 1500;
    });
    await app.page.evaluate(() => {
      ['keydown', 'keyup'].forEach((type) => {
        const event = new KeyboardEvent(type, { key: 'XF86Back', bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { value: 10009 });
        Object.defineProperty(event, 'which', { value: 10009 });
        (document.activeElement || document.body).dispatchEvent(event);
      });
    });
    await app.page.waitForFunction(() => document.body.getAttribute('data-view') === 'hosts', null, { timeout: 3000 });
    await app.page.waitForTimeout(300);
    assert.deepEqual(await app.page.evaluate(() => [$('#host-container-HOST1 .host-chips').text(),
      document.getElementById('host-container-HOST1').getAttribute('data-state')]), ['UNPAIRED', 'locked']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
