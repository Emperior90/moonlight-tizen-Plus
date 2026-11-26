'use strict';

// RETURN in every view of the menus whose back() no other browser test ran (23 of the 52 views with a back() in 2.3.4,
// measured with the coverage of the whole suite), Esc of a keyboard on the dialogs and a drop-down, and a held RETURN.
// A back() that names a button that is gone, or a function that throws, otherwise shows only on a TV, as the Wake PC
// dialog did in 2.1.0 (a ReferenceError on RETURN). Each test opens the view the way a user does (or with its opener
// where the way is long), presses the key and checks where the keys are then: the view, its selection and the mark, the
// dialogs that stay open (none), isDialogOpen, and that nothing was done that the key must not do (exit, delete, quit,
// a changed setting, a restart).
// Since 2.3.5 Esc of a keyboard works as RETURN (remoteControllerHandler() in remote_controller.js): before, its own
// action closed a <dialog> by itself and left the dimmed overlay, isDialogOpen and the view of the dialog behind, so that
// the keys acted on the hidden dialog, and OK then exited from Exit Moonlight. Only a trusted Escape has that action, so
// the Esc rows press it with the keyboard of Playwright. Only the row of the address field of Add PC shows that the
// action is prevented: there back() keeps the dialog open while the field takes the text, whereas the other dialogs
// close in their back() anyway. A held RETURN goes back one level (before 2.3.5 its auto-repeat went on through the
// levels, to Exit Moonlight), and Exit Moonlight opens on Cancel.
// tests/unit/navigation-ids.test.js checks that every element that navigation.js names exists.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { readStorage, startHarness } = require('./harness');
const { THREE_HOSTS, key, menuState, openMenus, openSettingsSection, selectItem, tvKey } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// The app with the three PCs of menu-driver.js (GAMING-PC of mocks/sunshine-host.js online and paired), once the polling
// found it and the scan of the network is over
async function openWithPcs(options) {
  const opts = options || {};
  const app = await openMenus(harness, {
    moduleScripts: ['sunshine-host.js'], stored: Object.assign({ hosts: THREE_HOSTS }, opts.stored || {}), initScripts: opts.initScripts,
  });
  await app.page.waitForFunction(() => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true &&
    isSubnetScanFinished === true, null, { timeout: 15000 });
  return app;
}

// Where the keys are: the view and its selection, the marked and the focused element, and what of the dialogs stays
async function where(page) {
  const state = await menuState(page);
  const dialogOpen = await page.evaluate(() => isDialogOpen);
  return { view: state.view, current: state.current, marked: state.marked, openDialogs: state.openDialogs, overlays: state.dialogs, dialogOpen };
}

// The state after a dialog closed: no <dialog> open, no overlay showing, isDialogOpen false
function assertClosed(state, view, current, message) {
  assert.deepEqual([state.view, state.current, state.openDialogs, state.overlays, state.dialogOpen], [view, current, [], [], false],
    message + ' ' + JSON.stringify(state));
}

// RETURN of the remote, or Esc of a keyboard (a trusted key press, whose own action closes a modal <dialog>)
async function press(page, which) {
  if (which === 'Esc') {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } else {
    await key(page, 'back', 400);
  }
}

// A held key: one keydown, `repeats` keydowns with repeat 100 ms apart (the auto-repeat of the remote), and the keyup
async function held(page, code, name, repeats) {
  await tvKey(page, code, name, { types: ['keydown'] });
  for (let i = 0; i < repeats; i++) {
    await page.waitForTimeout(100);
    await tvKey(page, code, name, { types: ['keydown'], repeat: true });
  }
  await tvKey(page, code, name, { types: ['keyup'] });
  await page.waitForTimeout(400);
}

test('Hosts: RETURN opens Exit Moonlight on Cancel, RETURN and Esc close it, and the OK after Esc exits nothing', async () => {
  const app = await openMenus(harness, {});
  const { page } = app;
  try {
    await page.evaluate(() => {
      window.__exits = 0;
      tizen.application.getCurrentApplication = () => ({ exit: () => window.__exits++ });
    });
    assert.equal((await where(page)).current, 'addHostContainer');
    for (const which of ['RETURN', 'Esc']) {
      await press(page, 'RETURN');
      const opened = await where(page);
      assert.deepEqual([opened.view, opened.current, opened.openDialogs, opened.dialogOpen], ['ExitMoonlightDialog', 'cancelExitApp', ['exitAppDialog'], true], which);
      await press(page, which);
      assertClosed(await where(page), 'Hosts', 'addHostContainer', which);
    }
    // The next OK acts on the PC list (Add PC), not on the closed dialog
    await key(page, 'ok', 500);
    assert.equal((await where(page)).view, 'AddHostDialog');
    assert.equal(await page.evaluate(() => window.__exits), 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('AddHostDialog: RETURN and Esc while typing in the address field close only the field, and the next one the dialog', async () => {
  // The one dialog whose back() keeps it open: the own action of a trusted Esc, if not prevented, closed the <dialog>
  // by itself and left its overlay, isDialogOpen and its view behind, as before 2.3.5 on every dialog
  const app = await openMenus(harness, { stored: { ipAddressFieldMode: false } });
  const { page } = app;
  const field = () => page.evaluate(() => {
    const input = document.getElementById('ipAddressTextInput');
    return { value: input.value, readOnly: input.readOnly, focused: document.activeElement === input };
  });
  try {
    for (const which of ['RETURN', 'Esc']) {
      // OK on Add PC, then OK on the address field, which takes the text
      await key(page, 'ok', 500);
      assert.equal((await where(page)).current, 'ipAddressTextInput', which);
      await key(page, 'ok', 300);
      await page.keyboard.type('10.0');
      assert.deepEqual(await field(), { value: '10.0', readOnly: false, focused: true }, which);
      await press(page, which);
      const typing = await where(page);
      assert.deepEqual([typing.view, typing.current, typing.openDialogs, typing.overlays, typing.dialogOpen],
        ['AddHostDialog', 'ipAddressTextInput', ['addHostDialog'], ['addHostDialogOverlay'], true], which + ' ' + JSON.stringify(typing));
      assert.deepEqual(await field(), { value: '10.0', readOnly: true, focused: false }, which);
      await press(page, which);
      assertClosed(await where(page), 'Hosts', 'addHostContainer', which);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('HostsNav and HostsMenuHighlight: RETURN goes back to the PC list, on the Add PC tile and on the card of the PC', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    await selectItem(page, 'Hosts', 'addHostContainer', 'left', 'right');
    await key(page, 'up');
    assert.equal((await where(page)).view, 'HostsNav');
    await press(page, 'RETURN');
    let state = await where(page);
    assert.deepEqual([state.view, state.current, state.marked], ['Hosts', 'addHostContainer', ['addHostContainer']]);

    await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
    await key(page, 'up');
    assert.deepEqual([(await where(page)).view, (await where(page)).current], ['HostsMenuHighlight', 'hostMenuButton-HOST1']);
    await press(page, 'RETURN');
    state = await where(page);
    assert.deepEqual([state.view, state.current, state.marked], ['Hosts', 'host-container-HOST1', ['host-container-HOST1']]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('PairingDialog: RETURN and Esc cancel the pairing, and no second pairing request follows', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    for (const which of ['RETURN', 'Esc']) {
      await page.evaluate(() => {
        pairingCert = pairingCert || { cert: 'cert', privateKey: 'key' };
        window.__pairs = 0;
        pairingDialog({ hostname: 'LIVING-ROOM', online: true, paired: false, currentGame: 0, toString: () => 'LIVING-ROOM',
          pollServer(callback) {
            callback(this);
          },
          pair() {
            window.__pairs++;
            return new Promise(() => {});
          } }, () => {}, () => {});
      });
      await page.waitForTimeout(300);
      assert.deepEqual([(await where(page)).view, (await where(page)).openDialogs], ['PairingDialog', ['pairingDialog']], which);
      await press(page, which);
      assertClosed(await where(page), 'Hosts', (await where(page)).current, which);
      await page.waitForTimeout(500);
      assert.deepEqual(await page.evaluate(() => [window.__pairs, wasPairingCanceled]), [1, true], which);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('DeleteHostDialog: RETURN and Esc keep the PC, in the list and in the storage', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
    for (const which of ['RETURN', 'Esc']) {
      await page.evaluate(() => deleteHostDialog(hosts.HOST1));
      await page.waitForTimeout(300);
      assert.deepEqual([(await where(page)).view, (await where(page)).current], ['DeleteHostDialog', 'cancelDeleteHost'], which);
      await press(page, which);
      assertClosed(await where(page), 'Hosts', 'host-container-HOST1', which);
      assert.deepEqual(await page.evaluate(() => Object.keys(hosts).sort()), ['HOST1', 'HOST2', 'HOST3'], which);
      assert.ok((await readStorage(page)).hosts.HOST1, which);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('HostDetailsDialog: RETURN closes the details that the menu of the PC opened', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
    await key(page, 'chup', 500);
    await selectItem(page, 'HostMenuDialog', 'viewDetails-GAMING-PC', 'up', 'down');
    await key(page, 'ok', 600);
    assert.equal((await where(page)).view, 'HostDetailsDialog');
    await press(page, 'RETURN');
    assertClosed(await where(page), 'Hosts', 'host-container-HOST1', 'RETURN');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[id^="hostDetailsDialogOverlay"]').length), 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('MoonlightSupportDialog and SettingsNav: RETURN goes back to their button in the header of the PC list', async () => {
  const app = await openMenus(harness, {});
  const { page } = app;
  try {
    await key(page, 'up');
    await selectItem(page, 'HostsNav', 'supportBtn', 'left', 'right');
    await key(page, 'ok', 500);
    assert.equal((await where(page)).view, 'MoonlightSupportDialog');
    await press(page, 'RETURN');
    assertClosed(await where(page), 'HostsNav', 'supportBtn', 'Support');

    await selectItem(page, 'HostsNav', 'settingsBtn', 'left', 'right');
    await key(page, 'ok', 500);
    assert.equal((await where(page)).view, 'Settings');
    await key(page, 'up');
    assert.equal((await where(page)).view, 'SettingsNav');
    await press(page, 'RETURN');
    const state = await where(page);
    assert.deepEqual([state.view, state.current, state.marked, (await menuState(page)).focused], ['HostsNav', 'settingsBtn', ['settingsBtn'], 'settingsBtn']);
    assert.equal(await page.evaluate(() => document.body.getAttribute('data-view')), 'hosts');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('VideoSettings: RETURN goes back to the list of the sections, on the tile of Video Settings', async () => {
  const app = await openMenus(harness, {});
  const { page } = app;
  try {
    await openSettingsSection(page, 'videoSettings');
    assert.equal((await where(page)).view, 'VideoSettings');
    await press(page, 'RETURN');
    const tile = await page.evaluate(() => [window.__view, Views.Settings.view.current().getAttribute('data-category'),
      Views.Settings.view.current().classList.contains('hovered')]);
    assert.deepEqual(tile, ['Settings', 'videoSettings', true]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// The drop-downs of the settings whose back() no other test ran: the section and the row, the stored settings
// (audioConfig 5.1 for the surround quality, the Web Audio backend for the jitter buffer), and the view of the drop-down
for (const [section, row, stored, menuView] of [
  ['basicSettings', 'selectBitrate', {}, 'SelectBitrateMenu'],
  ['interfaceSettings', 'selectLanguage', {}, 'SelectLanguageMenu'],
  ['interfaceSettings', 'selectSortAppsList', {}, 'SelectSortAppsListMenu'],
  ['audioSettings', 'selectAudioBackend', {}, 'SelectAudioBackendMenu'],
  ['audioSettings', 'selectAudio', {}, 'SelectAudioMenu'],
  ['audioSettings', 'selectSurroundQuality', { audioConfig: '51Surround' }, 'SelectSurroundQualityMenu'],
  ['audioSettings', 'selectAudioJitter', { audioBackend: 'WebAudio' }, 'SelectAudioJitterMenu'],
  ['advancedSettings', 'selectPerformanceStats', {}, 'SelectPerformanceStatsMenu'],
]) {
  test(menuView + ': RETURN closes the drop-down, back on its row, and the setting stays as it was', async () => {
    const app = await openMenus(harness, { stored });
    const { page } = app;
    try {
      await openSettingsSection(page, section);
      const sectionView = (await where(page)).view;
      await selectItem(page, sectionView, row, 'up', 'down');
      const storedBefore = await readStorage(page);
      const valueBefore = await page.evaluate((id) => $('#' + id).data('value'), row);
      await key(page, 'ok', 600);
      assert.equal((await where(page)).view, menuView);
      await press(page, 'RETURN');
      const state = await where(page);
      assert.deepEqual([state.view, state.current, state.marked, state.openDialogs], [sectionView, row, [row], []]);
      assert.deepEqual((await menuState(page)).dropdowns, []);
      assert.equal(await page.evaluate((id) => $('#' + id).data('value'), row), valueBefore);
      assert.deepEqual(await readStorage(page), storedBefore);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });
}

test('SelectResolutionMenu: Esc of a keyboard closes the drop-down once, like RETURN, and the section stays', async () => {
  const app = await openMenus(harness, {});
  const { page } = app;
  try {
    await openSettingsSection(page, 'basicSettings');
    await selectItem(page, 'BasicSettings', 'selectResolution', 'up', 'down');
    const before = await page.evaluate(() => $('#selectResolution').data('value'));
    for (const which of ['Esc', 'RETURN']) {
      await key(page, 'ok', 600);
      assert.equal((await where(page)).view, 'SelectResolutionMenu', which);
      await press(page, which);
      const state = await where(page);
      assert.deepEqual([state.view, state.current, state.marked], ['BasicSettings', 'selectResolution', ['selectResolution']], which);
      assert.deepEqual((await menuState(page)).dropdowns, [], which);
    }
    assert.equal(await page.evaluate(() => $('#selectResolution').data('value')), before);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('NavigationGuideDialog, UpdateMoonlightDialog and RestartMoonlightDialog: RETURN and Esc go back to their row of About', async () => {
  const app = await openMenus(harness, {});
  const { page } = app;
  try {
    await page.evaluate(() => {
      window.__restarts = 0;
      restartApplication = () => window.__restarts++;
    });
    await openSettingsSection(page, 'aboutSettings');
    const tvCallsBefore = await page.evaluate(() => window.__tvMock.calls.length);
    for (const which of ['RETURN', 'Esc']) {
      // The Navigation guide
      await selectItem(page, 'AboutSettings', 'navigationGuideBtn', 'up', 'down');
      await key(page, 'ok', 500);
      assert.equal((await where(page)).view, 'NavigationGuideDialog', which);
      await press(page, which);
      assertClosed(await where(page), 'AboutSettings', 'navigationGuideBtn', 'Navigation guide ' + which);
      // Restart Moonlight, which opens on Cancel
      await selectItem(page, 'AboutSettings', 'restartAppBtn', 'up', 'down');
      await key(page, 'ok', 500);
      assert.deepEqual([(await where(page)).view, (await where(page)).current], ['RestartMoonlightDialog', 'cancelRestartApp'], which);
      await press(page, which);
      assertClosed(await where(page), 'AboutSettings', 'restartAppBtn', 'Restart ' + which);
      // The answer of a check for updates
      await page.evaluate(() => updateAppDialog('9.9.9', 'Notes'));
      await page.waitForTimeout(300);
      assert.equal((await where(page)).view, 'UpdateMoonlightDialog', which);
      await press(page, which);
      assertClosed(await where(page), 'AboutSettings', 'restartAppBtn', 'Update ' + which);
    }
    assert.equal(await page.evaluate(() => window.__restarts), 0);
    // Nothing else was opened, and the app didn't exit
    assert.deepEqual(await page.evaluate((from) => window.__tvMock.calls.slice(from).map((call) => call.name)
      .filter((name) => /launchAppControl|application\.(exit|hide)/.test(name)), tvCallsBefore), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RestoreDefaultsDialog: RETURN and Esc keep every setting and ask for no restart', async () => {
  const app = await openMenus(harness, { stored: { framePacing: false, bitrate: '50' } });
  const { page } = app;
  try {
    await openSettingsSection(page, 'basicSettings');
    const current = (await where(page)).current;
    const storedBefore = await readStorage(page);
    for (const which of ['RETURN', 'Esc']) {
      await page.evaluate(() => restoreDefaultsDialog());
      await page.waitForTimeout(300);
      assert.deepEqual([(await where(page)).view, (await where(page)).current], ['RestoreDefaultsDialog', 'cancelRestoreDefaults'], which);
      await press(page, which);
      assertClosed(await where(page), 'BasicSettings', current, which);
      await page.waitForTimeout(300);
      assert.deepEqual((await where(page)).openDialogs, [], which);
    }
    assert.deepEqual(await readStorage(page), storedBefore);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('QuitAppDialog: RETURN and Esc on the question of the header button quit nothing', async () => {
  // GAMING-PC runs Cyberpunk 2077 (app 101), so the header of its app list has the button 'Quit app on the PC'
  const app = await openWithPcs({ initScripts: ['window.__sunshineConfig = { currentGame: 101 };'] });
  const { page } = app;
  try {
    await page.waitForFunction(() => Number(hosts.HOST1.currentGame) === 101, null, { timeout: 10000 });
    await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
    await key(page, 'ok', 1500);
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#quitRunningAppBtn').is(':visible'), null, { timeout: 5000 });
    await key(page, 'up');
    await selectItem(page, 'AppsNav', 'quitRunningAppBtn', 'left', 'right');
    for (const which of ['RETURN', 'Esc']) {
      await key(page, 'ok', 500);
      assert.deepEqual([(await where(page)).view, (await where(page)).current], ['QuitAppDialog', 'cancelQuitApp'], which);
      await press(page, which);
      assertClosed(await where(page), 'AppsNav', 'quitRunningAppBtn', which);
    }
    assert.equal(await page.evaluate(() => window.__sunshine.http.filter((request) => request.indexOf('/cancel') === 0).length), 0);
    assert.equal(await page.evaluate(() => Number(hosts.HOST1.currentGame)), 101);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a held RETURN goes back one level: from a section, from Delete PC and from a drop-down, and a held Esc as well', async () => {
  const app = await openWithPcs();
  const { page } = app;
  try {
    // From Delete PC to the PC list, and no further to Exit Moonlight
    await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
    await page.evaluate(() => deleteHostDialog(hosts.HOST1));
    await page.waitForTimeout(300);
    await held(page, 10009, 'XF86Back', 4);
    assertClosed(await where(page), 'Hosts', 'host-container-HOST1', 'Delete PC');
    assert.deepEqual(await page.evaluate(() => Object.keys(hosts).sort()), ['HOST1', 'HOST2', 'HOST3']);

    // From a section to the list of the sections, and no further to the PC list
    await openSettingsSection(page, 'basicSettings');
    await held(page, 10009, 'XF86Back', 4);
    assert.equal((await where(page)).view, 'Settings');

    // From a drop-down to its section
    await key(page, 'ok', 600);
    await selectItem(page, 'BasicSettings', 'selectResolution', 'up', 'down');
    await key(page, 'ok', 600);
    assert.equal((await where(page)).view, 'SelectResolutionMenu');
    await held(page, 10009, 'XF86Back', 4);
    assert.deepEqual([(await where(page)).view, (await where(page)).current, (await menuState(page)).dropdowns], ['BasicSettings', 'selectResolution', []]);

    // Esc held in a section: one level as well
    await held(page, 27, 'Escape', 4);
    assert.equal((await where(page)).view, 'Settings');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
