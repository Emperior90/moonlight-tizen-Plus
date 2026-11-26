'use strict';

// Checks the PC list with the keys of the remote and a gamepad that the real polling reads: its header, the menu of a
// PC and the dialogs behind it (updateAppButton(), hostMenuDialog(), hostDetailsDialog() and deleteHostDialog() in
// wasm/platform/index.js; Views.Hosts, HostsNav, HostsMenuHighlight and Stack.push() in wasm/platform/navigation.js).
// The PCs are the one of mocks/sunshine-host.js (GAMING-PC, online and paired) and two that don't answer (OFFICE-PC,
// paired, and LIVING-ROOM, not paired).
// - when the update button appears in the header, OK presses the button that is highlighted, not the one before it
// - a second CH+, or a second Select of a gamepad, opens the menu of a PC once, so that one RETURN closes it; CH+,
//   Play/Pause and Select open the menu from the menu icon of a PC too, like OK, and since 2.3.5 the key that opened it
//   closes it again, as in the app menu, while a held CH+ opens it once
// - the PC details name the real state of the PC
// - the second press of a double OK or A that opens the Wake PC dialog or the PC details doesn't close them at once
// - UP keeps the highlight on the only button of a dialog (PC details, navigation guide, support, Update, pairing)
// - after a PC was deleted, from CH+ or from its menu icon, one card is highlighted, the one that is selected
// - Refresh apps says how many apps the PC lists (or none), or that its list couldn't be read and what to check, also for
//   an error answer of the PC, and that the PC no longer accepts the TV for its answer of status 401, after which the PC
//   shows Unpaired at once (since 2.3.3, refreshHostApps())

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { startHarness } = require('./harness');
const { forEachTextWidth } = require('./text-stress');
const { PAD, THREE_HOSTS, doubleKey, doublePadButton, key, menuState, openMenus, padButton, selectItem, takeSnackbars, timed } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Open the app with the three PCs, once the polling found the first one online and the scan of the network is over
async function openWithPcs(options) {
  const app = await openMenus(harness, Object.assign({ moduleScripts: ['sunshine-host.js'], stored: { hosts: THREE_HOSTS } }, options));
  await app.page.waitForFunction(() => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true &&
    hosts.HOST2 && hosts.HOST3 && isSubnetScanFinished === true, null, { timeout: 15000 });
  return app;
}

// The overlays of the PC menus that exist, and the lines of the open PC details about the state of the PC
const pcMenuOverlays = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('[id^="hostMenuDialogOverlay-"]'), (overlay) => overlay.id));
const pcDetails = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.host-details-text tr'),
  (row) => row.cells[0].textContent + ' ' + row.cells[1].textContent).filter((line) => /^(Name|State|Pair State): /.test(line)));

// The lines that the navigation wrote to the console as errors, e.g. 'Cannot mark the unresolved target'
const navigationErrors = (app) => app.consoleErrors.filter((line) => line.indexOf('navigation.js') >= 0);

for (const [rights, button] of [[0, 'rescanNetworkBtn'], [1, 'settingsBtn'], [2, 'supportBtn']]) {
  test('when the update button appears in the header, OK presses the highlighted button (' + button + ')', async () => {
    const app = await openMenus(harness, {});
    const { page } = app;
    try {
      await page.evaluate(() => {
        fetchLatestRelease = () => Promise.resolve({ latestVersion: '99.0.0', releaseNotes: 'notes' });
      });
      // UP to the header, which opens on Rescan network, and RIGHT to the button
      await key(page, 'up');
      for (let i = 0; i < rights; i++) {
        await key(page, 'right', 150);
      }
      let state = await menuState(page);
      assert.deepEqual([state.view, state.current, state.marked, state.focused], ['HostsNav', button, [button], button]);
      // The check for updates of the start found a newer version (10 seconds after the start on the TV)
      await page.evaluate(() => updateAppButton('99.0.0'));
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => $('#updateAppBtn').length), 1);
      state = await menuState(page);
      assert.deepEqual([state.view, state.current, state.marked, state.focused], ['HostsNav', button, [button], button]);
      // LEFT and RIGHT still move from that button
      if (rights > 0) {
        await key(page, 'left', 150);
        await key(page, 'right', 150);
        assert.equal((await menuState(page)).current, button);
      }
      await key(page, 'ok', 900);
      state = await menuState(page);
      const messages = await takeSnackbars(page);
      assert.equal(await page.evaluate(() => document.getElementById('updateAppDialog').open), false);
      if (button === 'rescanNetworkBtn') {
        assert.equal(messages[0], 'Scanning the local network for new PCs...');
        assert.equal(state.view, 'HostsNav');
      } else if (button === 'settingsBtn') {
        assert.equal(state.view, 'Settings');
        assert.deepEqual(messages, []);
      } else {
        assert.deepEqual([state.view, state.openDialogs], ['MoonlightSupportDialog', ['appSupportDialog']]);
        assert.deepEqual(messages, []);
      }
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });
}

test('a second CH+ or Select opens the menu of a PC once, CH+, Play/Pause and Select open it from its menu icon, and the same key closes it again', async () => {
  const app = await openWithPcs({ pad: true });
  const { page } = app;
  try {
    await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
    // CH+ twice, 80 ms apart: the menu button is clicked 250 ms after each
    await doubleKey(page, 'chup', 700, 80);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.dialogs, state.openDialogs], ['HostMenuDialog', ['hostMenuDialogOverlay-HOST1'], ['hostMenuDialog-HOST1']]);
    assert.deepEqual(await pcMenuOverlays(page), ['hostMenuDialogOverlay-HOST1']);
    assert.equal(state.focused, 'refreshApps-GAMING-PC');
    // One RETURN closes it, and the keys are on the PC list
    await key(page, 'back', 400);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.dialogs, state.marked], ['Hosts', 'host-container-HOST1', [], ['host-container-HOST1']]);
    assert.deepEqual(await pcMenuOverlays(page), []);
    // CH+ opens it, and one more CH+ closes it again, as in the app menu (since 2.3.5; before, it only set the focus)
    await key(page, 'chup', 500);
    assert.equal((await menuState(page)).view, 'HostMenuDialog');
    await key(page, 'chup', 500);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.dialogs, state.openDialogs, state.marked],
      ['Hosts', 'host-container-HOST1', [], [], ['host-container-HOST1']]);
    assert.deepEqual([await pcMenuOverlays(page), await page.evaluate(() => isDialogOpen)], [[], false]);
    // A held CH+ (a keydown and its auto-repeat every 100 ms for 0.8 s) opens it once, and it stays open: whether the
    // menu shows, every 20 ms from the keydown to 0.5 s after the keyup, without the repeats of the same state
    const shown = await page.evaluate(() => new Promise((resolve) => {
      const states = [];
      const sample = setInterval(() => {
        const open = document.querySelectorAll('[id^="hostMenuDialogOverlay-"]').length > 0;
        if (states[states.length - 1] !== open) {
          states.push(open);
        }
      }, 20);
      const send = (type, repeat) => {
        const event = new KeyboardEvent(type, { key: 'ChannelUp', bubbles: true, cancelable: true, repeat });
        Object.defineProperty(event, 'keyCode', { value: 427 });
        Object.defineProperty(event, 'which', { value: 427 });
        (document.activeElement || document.body).dispatchEvent(event);
      };
      let count = 0;
      const next = () => {
        send('keydown', count > 0);
        count++;
        if (count <= 8) {
          setTimeout(next, 100);
          return;
        }
        send('keyup', false);
        setTimeout(() => {
          clearInterval(sample);
          resolve(states);
        }, 500);
      };
      next();
    }));
    assert.deepEqual(shown, [false, true], 'the menu opened once and stayed open');
    state = await menuState(page);
    assert.deepEqual([state.view, state.dialogs], ['HostMenuDialog', ['hostMenuDialogOverlay-HOST1']]);
    await key(page, 'back', 400);
    assert.equal((await menuState(page)).view, 'Hosts');
    await key(page, 'right', 200);
    assert.equal((await menuState(page)).current, 'host-container-HOST2');
    await key(page, 'left', 200);

    // Select of a gamepad twice, 70 ms from press to press
    await doublePadButton(page, PAD.SELECT, 700);
    state = await menuState(page);
    assert.deepEqual([state.view, state.dialogs], ['HostMenuDialog', ['hostMenuDialogOverlay-HOST1']]);
    assert.deepEqual(await pcMenuOverlays(page), ['hostMenuDialogOverlay-HOST1']);
    await padButton(page, PAD.B, 400);
    state = await menuState(page);
    assert.deepEqual([state.view, state.dialogs], ['Hosts', []]);
    // Select opens it and closes it again
    await padButton(page, PAD.SELECT, 500);
    assert.equal((await menuState(page)).view, 'HostMenuDialog');
    await padButton(page, PAD.SELECT, 500);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.dialogs], ['Hosts', 'host-container-HOST1', []]);

    // UP to the menu icon of the PC: OK, CH+, Play/Pause and Select each open the menu
    await key(page, 'up', 200);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.marked], ['HostsMenuHighlight', 'hostMenuButton-HOST1', ['hostMenuButton-HOST1']]);
    for (const open of [() => key(page, 'ok', 500), () => key(page, 'chup', 500), () => key(page, 'playpause', 500), () => padButton(page, PAD.SELECT, 500)]) {
      await open();
      state = await menuState(page);
      assert.deepEqual([state.view, state.dialogs], ['HostMenuDialog', ['hostMenuDialogOverlay-HOST1']]);
      await key(page, 'back', 400);
      assert.equal((await menuState(page)).view, 'HostsMenuHighlight');
    }
    // Play/Pause closes the menu that it opened from the menu icon, back on the icon
    await key(page, 'playpause', 500);
    assert.equal((await menuState(page)).view, 'HostMenuDialog');
    await key(page, 'playpause', 500);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.dialogs], ['HostsMenuHighlight', 'hostMenuButton-HOST1', []]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the PC details name the real state of the PC, like its card', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    const expected = {
      HOST1: ['Name: GAMING-PC', 'State: ONLINE', 'Pair State: PAIRED'],
      HOST2: ['Name: OFFICE-PC', 'State: OFFLINE', 'Pair State: PAIRED'],
      HOST3: ['Name: LIVING-ROOM', 'State: OFFLINE', 'Pair State: UNPAIRED'],
    };
    for (const uid of Object.keys(expected)) {
      // CH+ on the card, View Details, OK
      await selectItem(page, 'Hosts', 'host-container-' + uid, 'left', 'right');
      await key(page, 'chup', 600);
      await selectItem(page, 'HostMenuDialog', 'viewDetails-' + expected[uid][0].slice(6), 'up', 'down');
      await key(page, 'ok', 500);
      const state = await menuState(page);
      assert.deepEqual([state.view, state.openDialogs], ['HostDetailsDialog', ['hostDetailsDialog-' + uid]]);
      assert.deepEqual(await pcDetails(page), expected[uid]);
      // What the card of the PC shows: offline or not, and the lock of a PC that is not paired
      const card = await page.evaluate((id) => ({ online: !!hosts[id].online, paired: !!hosts[id].paired }), uid);
      assert.deepEqual(card, { online: expected[uid][1] === 'State: ONLINE', paired: expected[uid][2] === 'Pair State: PAIRED' });
      await key(page, 'ok', 400);
      assert.equal((await menuState(page)).view, 'Hosts');
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a double OK or A that opens the Wake PC dialog or the PC details keeps them open', async () => {
  // OFFICE-PC (HOST2) is offline; with 'Always wake this PC automatically' on, OK on its card opens the Wake PC dialog
  const hostsWithAutoWake = JSON.parse(JSON.stringify(THREE_HOSTS));
  hostsWithAutoWake.HOST2.autoWolEnabled = true;
  const app = await openWithPcs({ pad: true, stored: { hosts: hostsWithAutoWake } });
  const { page } = app;
  try {
    await page.evaluate(() => {
      window.__wol = 0;
      hosts.HOST2.sendWOL = () => {
        window.__wol++;
        return Promise.resolve('Sent the magic packets');
      };
    });
    const wakeDialog = () => page.evaluate(() => ({ open: document.getElementById('autoWolDialog').open, wol: window.__wol,
      autoWake: hosts.HOST2.autoWolEnabled === true }));
    // The dialog opens on Cancel, so the second OK of a double press closed it at once before (nothing waited for the PC
    // any more); a later OK closes it
    const closeWakeDialog = async () => {
      await key(page, 'ok', 400);
      assert.equal((await wakeDialog()).open, false);
      assert.equal((await menuState(page)).view, 'Hosts');
    };

    // OK twice, 120 ms apart, on the offline PC
    await selectItem(page, 'Hosts', 'host-container-HOST2', 'left', 'right');
    await doubleKey(page, 'ok', 400);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.openDialogs], ['AutoWolDialog', 'cancelAutoWol', ['autoWolDialog']]);
    assert.deepEqual(await wakeDialog(), { open: true, wol: 1, autoWake: true });
    await closeWakeDialog();

    // Wake PC, the first entry of the menu of an offline PC: OK twice 120 ms apart, and A twice 170 ms apart (later
    // than the 150 ms in which the menus take a second A for the same press)
    const doubleA = () => timed(page, [{ at: 0, button: PAD.A, pressed: true }, { at: 60, button: PAD.A, pressed: false },
      { at: 170, button: PAD.A, pressed: true }, { at: 230, button: PAD.A, pressed: false }], 400);
    for (const press of [() => doubleKey(page, 'ok', 400), doubleA]) {
      await key(page, 'chup', 600);
      await selectItem(page, 'HostMenuDialog', 'wakeHost-OFFICE-PC', 'up', 'down');
      await press();
      state = await menuState(page);
      assert.deepEqual([state.view, state.openDialogs], ['AutoWolDialog', ['autoWolDialog']]);
      assert.equal((await wakeDialog()).open, true);
      await closeWakeDialog();
    }
    assert.equal((await wakeDialog()).autoWake, true, 'the switch of the dialog was never pressed');

    // View Details, OK twice 120 ms apart: the details stay, and a later OK closes them
    await key(page, 'chup', 600);
    await selectItem(page, 'HostMenuDialog', 'viewDetails-OFFICE-PC', 'up', 'down');
    await doubleKey(page, 'ok', 400);
    state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs], ['HostDetailsDialog', ['hostDetailsDialog-HOST2']]);
    await key(page, 'ok', 400);
    assert.deepEqual([(await menuState(page)).view, (await menuState(page)).openDialogs], ['Hosts', []]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('UP keeps the highlight on the only button of a dialog, which OK presses', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    // The PC details, the navigation guide, the support dialog, the Update dialog and the pairing dialog (whose pairing
    // never ends here)
    const dialogs = [
      [() => hostDetailsDialog(hosts.HOST1), 'HostDetailsDialog', 'closeHostDetails'],
      [() => navigationGuideDialog(), 'NavigationGuideDialog', 'closeNavGuide'],
      [() => appSupportDialog(), 'MoonlightSupportDialog', 'closeAppSupport'],
      [() => updateAppDialog('99.0.0', 'notes'), 'UpdateMoonlightDialog', 'closeUpdateApp'],
      [() => {
        pairingCert = pairingCert || { cert: 'cert', privateKey: 'key' };
        pairingDialog({ hostname: 'OFFICE', online: true, paired: false, currentGame: 0, toString: () => 'OFFICE',
          pollServer(callback) {
            callback(this);
          },
          pair: () => new Promise(() => {}) }, () => {}, () => {});
      }, 'PairingDialog', 'cancelPairing'],
    ];
    for (const [open, viewName, button] of dialogs) {
      await page.evaluate(open);
      await page.waitForTimeout(300);
      await key(page, 'up', 200);
      let state = await menuState(page);
      assert.deepEqual([state.view, state.current, state.marked, state.focused], [viewName, button, [button], button]);
      await key(page, 'down', 100);
      await key(page, 'up', 100);
      state = await menuState(page);
      assert.deepEqual([state.marked, state.focused], [[button], button], viewName);
      await key(page, 'ok', 400);
      state = await menuState(page);
      assert.deepEqual([state.view, state.openDialogs], ['Hosts', []], viewName);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('after a PC was deleted, from CH+ or from its menu icon, the one highlighted card is the selected one', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    // Delete LIVING-ROOM, the last card, from CH+: Delete PC, OK, and Continue in the question, which opens on Cancel
    await selectItem(page, 'Hosts', 'host-container-HOST3', 'left', 'right');
    await key(page, 'chup', 600);
    await selectItem(page, 'HostMenuDialog', 'deleteHost-LIVING-ROOM', 'up', 'down');
    await key(page, 'ok', 500);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.current], ['DeleteHostDialog', 'cancelDeleteHost']);
    await key(page, 'left', 150);
    await key(page, 'ok', 500);
    assert.equal(await page.evaluate(() => document.getElementById('host-container-HOST3')), null);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.marked, state.focused, state.openDialogs],
      ['Hosts', 'addHostContainer', ['addHostContainer'], 'addHostContainer', []]);
    // RIGHT moves the highlight with the selection: still one card
    await key(page, 'right', 200);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.marked], ['Hosts', 'host-container-HOST1', ['host-container-HOST1']]);

    // Delete OFFICE-PC from its menu icon: UP, OK, Delete PC, OK, Continue
    await key(page, 'right', 200);
    await key(page, 'up', 200);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current], ['HostsMenuHighlight', 'hostMenuButton-HOST2']);
    await key(page, 'ok', 600);
    await selectItem(page, 'HostMenuDialog', 'deleteHost-OFFICE-PC', 'up', 'down');
    await key(page, 'ok', 500);
    await key(page, 'left', 150);
    app.consoleErrors.length = 0;
    await key(page, 'ok', 500);
    assert.equal(await page.evaluate(() => document.getElementById('host-container-HOST2')), null);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.marked, state.focused, state.openDialogs],
      ['Hosts', 'addHostContainer', ['addHostContainer'], 'addHostContainer', []]);
    await key(page, 'right', 200);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.marked], ['Hosts', 'host-container-HOST1', ['host-container-HOST1']]);
    // The icon of the PC that is gone is neither marked nor unmarked
    assert.deepEqual(navigationErrors(app).filter((line) => /Cannot (mark|unmark) the unresolved target: undefined/.test(line)), []);
    assert.deepEqual(await page.evaluate(() => Object.keys(hosts)), ['HOST1']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Refresh apps says how many apps the PC lists, or that the list couldn\'t be read', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    // CH+ on the PC opens its menu on Refresh apps, and OK runs it
    const refresh = async () => {
      await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
      await page.evaluate(() => {
        window.__requestsFrom = window.__sunshine.http.length;
      });
      await key(page, 'chup', 600);
      assert.equal((await menuState(page)).focused, 'refreshApps-GAMING-PC');
      await key(page, 'ok', 900);
      return {
        snackbars: await takeSnackbars(page),
        appListRequests: await page.evaluate(() => window.__sunshine.http.slice(window.__requestsFrom).filter((request) => request === '/applist').length),
      };
    };
    await takeSnackbars(page);
    assert.deepEqual(await refresh(), { snackbars: ['Refreshing the list of GAMING-PC applications...', 'The app list of GAMING-PC is up to date: 5 apps.'],
      appListRequests: 1 });
    // The PC lists one app now
    await page.evaluate(() => {
      window.__sunshine.apps = window.__sunshine.apps.slice(0, 1);
    });
    assert.deepEqual((await refresh()).snackbars, ['Refreshing the list of GAMING-PC applications...', 'The app list of GAMING-PC is up to date: 1 app.']);
    // None (a sentence of its own, without a count: French takes the singular for 0, which _n() doesn't know)
    await page.evaluate(() => {
      window.__sunshine.apps = [];
    });
    assert.deepEqual((await refresh()).snackbars, ['Refreshing the list of GAMING-PC applications...', 'The app list of GAMING-PC is up to date: no apps.']);
    await page.evaluate(() => {
      window.__sunshine.apps = [{ id: 101, title: 'Cyberpunk 2077' }];
    });
    assert.deepEqual((await refresh()).snackbars, ['Refreshing the list of GAMING-PC applications...', 'The app list of GAMING-PC is up to date: 1 app.']);
    // The request of the list fails: the message says what to check before the next try (2.3.3 in testing advised to
    // refresh the list of apps, which had just failed)
    const failed = ['Refreshing the list of GAMING-PC applications...',
      'The app list of GAMING-PC couldn\'t be read. Make sure that Sunshine (or another GameStream host) is running on the PC, then try again.'];
    await page.evaluate(() => {
      window.__answerAppList = (id) => handlePromiseMessage(id, 'reject', -1);
      const openUrl = Module.openUrl;
      Module.openUrl = function(id, url) {
        if (/\/applist\?/.test(url) && window.__answerAppList) {
          window.__sunshine.http.push('/applist');
          const answer = window.__answerAppList;
          setTimeout(() => answer(id), 30);
          return;
        }
        return openUrl.apply(this, arguments);
      };
    });
    assert.deepEqual((await refresh()).snackbars, failed);
    // Another error status of the PC (e.g. a busy host): a failure as well (not an empty list), and the list that the TV
    // has stays
    await page.evaluate(() => {
      window.__answerAppList = (id) => handlePromiseMessage(id, 'resolve', '<root status_code="503" status_message="Busy"/>');
    });
    assert.deepEqual((await refresh()).snackbars, failed);
    assert.deepEqual(await page.evaluate(() => hosts.HOST1._memCachedApplist.map((entry) => entry.id)), [101]);
    // The box art of the PC is deleted each time: the files of this TV can't be listed here (no listDirectory() in the
    // simulated file system), which is logged instead of an unhandled rejection
    assert.ok(app.logs.some((line) => line.indexOf('Warning: Failed to clear the box art of GAMING-PC') >= 0));
    // The PC forgot the TV ("Unpair All" in Sunshine), which no poll noticed yet (they are stopped here), and answers
    // with its error for a client that it no longer accepts (status 401, with the key that the TV pinned): as after a
    // poll, the PC shows Unpaired at once, its list in the TV is gone, and the message says what to do, where 2.3.3 in
    // testing said to try again later
    await page.evaluate(() => {
      endBackgroundPollingOfHost(hosts.HOST1);
      window.__answerAppList = null;
      window.__sunshine.unpair();
    });
    assert.deepEqual((await refresh()).snackbars, ['Refreshing the list of GAMING-PC applications...',
      'GAMING-PC no longer accepts this TV: its pairing was removed or turned off on the PC. Select it in the list of PCs to pair it again.']);
    assert.deepEqual(await page.evaluate(() => [hosts.HOST1.paired, hosts.HOST1._memCachedApplist, $('#host-container-HOST1 .host-chips').text()]),
      [false, null, 'UNPAIRED']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the PC details show the badge of a PC and two columns, labels and values, with a dash for what the PC never reported, in every language', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR']) {
      const texts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales', locale + '.json'), 'utf8'));
      await page.evaluate((language) => i18n.setLanguage(language), locale);
      await page.waitForTimeout(400);
      await forEachTextWidth(page, async (stress) => {
        const where = locale + stress;
        // A PC that never reported its MAC address, with no game running
        const details = await page.evaluate(() => {
          const host = Object.assign(Object.create(Object.getPrototypeOf(hosts.HOST1)), hosts.HOST1, { macAddress: undefined, currentGame: 0 });
          hostDetailsDialog(host);
          const dialog = document.getElementById('hostDetailsDialog-HOST1');
          const rows = Array.prototype.map.call(dialog.querySelectorAll('.host-details-text tr'), (row) => {
            // Where the texts of the cells end and start, without their padding
            const range = document.createRange();
            range.selectNodeContents(row.cells[0]);
            const label = range.getBoundingClientRect();
            range.selectNodeContents(row.cells[1]);
            const value = range.getBoundingClientRect();
            return { label: row.cells[0].textContent, value: row.cells[1].textContent, labelRight: label.right, valueLeft: value.left,
              labelColour: getComputedStyle(row.cells[0]).color, valueColour: getComputedStyle(row.cells[1]).color };
          });
          const probe = document.createElement('span');
          document.body.appendChild(probe);
          probe.style.color = 'var(--text-3)';
          const text3 = getComputedStyle(probe).color;
          probe.style.color = 'var(--text)';
          const text = getComputedStyle(probe).color;
          probe.remove();
          const result = { badge: (dialog.querySelector('.dialog-badge use') || { getAttribute: () => null }).getAttribute('xlink:href'), rows, text3, text,
            fits: dialog.scrollWidth <= dialog.clientWidth + 1 };
          $('#closeHostDetails').trigger('click');
          return result;
        });
        assert.equal(details.badge, '#i-pc', where);
        // The labels are the texts of the keys up to their value, e.g. 'Nom\u00a0:' in French
        const labels = ['Name: %1$s', 'State: %1$s', 'Active Address: %1$s', 'UUID: %1$s', 'Local Address: %1$s', 'MAC Address: %1$s',
          'Pair State: %1$s', 'Running Game ID: %1$s', 'HTTP Port: %1$s', 'HTTPS Port: %1$s'].map((key) => texts[key].replace('%1$s', '').trim());
        assert.deepEqual(details.rows.map((row) => row.label), labels, where);
        const values = details.rows.map((row) => row.value);
        assert.deepEqual([values[0], values[1], values[5], values[6], values[7], values[8], values[9]],
          ['GAMING-PC', texts.ONLINE, '\u2014', texts.PAIRED, '\u2014', '47989', '47984'], where);
        // 2.3.4: NULL (KEINE, NUL, NULO), 'undefined' for the MAC address and the game ID 0
        values.forEach((value) => assert.doesNotMatch(value, /^(NULL|KEINE|NUL|NULO|undefined|0)$/, where));
        // One column of values, right of the column of labels, in the colours of the theme
        assert.ok(Math.max(...details.rows.map((row) => row.valueLeft)) - Math.min(...details.rows.map((row) => row.valueLeft)) <= 1, where);
        details.rows.forEach((row) => assert.ok(row.labelRight + 20 <= row.valueLeft, where + ' ' + JSON.stringify(row)));
        assert.deepEqual([...new Set(details.rows.map((row) => row.labelColour))], [details.text3], where);
        assert.deepEqual([...new Set(details.rows.map((row) => row.valueColour))], [details.text], where);
        assert.equal(details.fits, true, where);
      });
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
