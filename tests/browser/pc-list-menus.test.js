'use strict';

// Checks the PC list with the keys of the remote and a gamepad that the real polling reads: its header, the menu of a
// PC and the dialogs behind it (updateAppButton(), hostMenuDialog(), hostDetailsDialog() and deleteHostDialog() in
// wasm/platform/index.js; Views.Hosts, HostsNav, HostsMenuHighlight and Stack.push() in wasm/platform/navigation.js).
// The PCs are the one of mocks/sunshine-host.js (GAMING-PC, online and paired) and two that don't answer (OFFICE-PC,
// paired, and LIVING-ROOM, not paired).
// - when the update button appears in the header, OK presses the button that is highlighted, not the one before it
// - a second CH+, or a second Select of a gamepad, opens the menu of a PC once, so that one RETURN closes it; CH+,
//   Play/Pause and Select open the menu from the menu icon of a PC too, like OK
// - the PC details name the real state of the PC
// - the second press of a double OK or A that opens the Wake PC dialog or the PC details doesn't close them at once
// - UP keeps the highlight on the only button of a dialog (PC details, navigation guide, support, Update, pairing)
// - after a PC was deleted, from CH+ or from its menu icon, one card is highlighted, the one that is selected

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./harness');
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
const pcDetails = (page) => page.evaluate(() => document.querySelector('.host-details-text').innerHTML.split('<br>')
  .filter((line) => /^(Name|State|Pair State): /.test(line)));

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

test('a second CH+ or Select opens the menu of a PC once, and CH+, Play/Pause and Select open it from its menu icon', async () => {
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
