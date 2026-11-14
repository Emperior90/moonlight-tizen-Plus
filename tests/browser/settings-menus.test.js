'use strict';

// Checks the settings with the keys of the remote and a gamepad that the real polling reads: their drop-downs, and the
// dialogs that open from them (registerMenu in attachListeners(), selectDropdownValue(), keepDropdownOnScreen(),
// restoreDefaultsDialog() and warningDialog() in wasm/platform/index.js; guardAccept(), runOp(), Stack.push() and
// ListView in wasm/platform/navigation.js):
// - a drop-down opens with the highlight on the value that is set, instead of on its first option (480p, 30 FPS, H.264)
//   or on the option that was highlighted the last time
// - the second press of a double OK, or of a double A of a gamepad, changes nothing: the drop-down stays open on the value
//   that is set, and a later OK chooses, or one right after UP or DOWN
// - once something else closed a drop-down (a click beside it, a dialog that opened over it), the keys act on the row
//   again, instead of on the options that no longer show
// - the last drop-down of the Input Settings and of the Advanced Settings shows completely, on the S90C and on a Full HD
//   TV, with the highlight on a visible option
// - UP and DOWN step over the resolutions that a Full HD TV can't show
// - the Advanced Settings keep a selection when their last row went away with the audio output
// - the restart question of Restore Defaults comes at once, and the second press of a double OK doesn't answer it
// - a double OK on the disabled Ultra low latency mode switch of a TV on Tizen 5.5 opens its warning once

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { DROPDOWN_OK_WAIT_MS, startHarness, waitForStorage } = require('./harness');
const {
  PAD, doubleKey, doublePadButton, dropdownOptions, key, menuState, openMenus, openSettingsSection, padButton, rowValue, selectItem, takeSnackbars,
  timed,
} = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// A 4K setup, whose values are the last option of the resolution and the codec menu and the second of the frame rates
const STORED_4K = { resolution: '3840:2160', frameRate: '60', bitrate: '150', videoCodec: 'AV1', hdrMode: true };

// The values of the options of the open drop-down that are highlighted
const markedOptions = async (page) => (await dropdownOptions(page)).filter((option) => option.marked).map((option) => option.value);

test('a drop-down opens on the value that is set, and again after another option was highlighted', async () => {
  const app = await openMenus(harness, { stored: STORED_4K });
  const { page } = app;
  try {
    for (const [category, viewName, rowId, value] of [['basicSettings', 'BasicSettings', 'selectResolution', '3840:2160'],
      ['basicSettings', 'BasicSettings', 'selectFramerate', '60'], ['videoSettings', 'VideoSettings', 'selectCodec', 'AV1']]) {
      if ((await menuState(page)).view !== viewName) {
        await openSettingsSection(page, category);
      }
      await selectItem(page, viewName, rowId, 'up', 'down');
      await key(page, 'ok', 400);
      assert.deepEqual(await markedOptions(page), [value], rowId + ' opens on its value');
      // Another option highlighted, RETURN: the next opening is on the value again, not on that option
      await key(page, 'up', 100);
      assert.notDeepEqual(await markedOptions(page), [value]);
      await key(page, 'back', 400);
      assert.deepEqual((await menuState(page)).dropdowns, []);
      await key(page, 'ok', 400);
      assert.deepEqual(await markedOptions(page), [value], rowId + ' opens on its value the second time');
      await key(page, 'back', 400);
      assert.equal(await rowValue(page, rowId), value);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the second press of a double OK or a double A leaves the drop-down open and the setting as it is, and a later OK chooses', async () => {
  const app = await openMenus(harness, { stored: STORED_4K, pad: true });
  const { page } = app;
  try {
    await openSettingsSection(page, 'basicSettings');
    await selectItem(page, 'BasicSettings', 'selectResolution', 'up', 'down');
    // OK twice, 120 ms apart
    await doubleKey(page, 'ok', 500);
    let state = await menuState(page);
    assert.equal(state.view, 'SelectResolutionMenu');
    assert.deepEqual(state.dropdowns, ['videoResolutionMenu']);
    assert.deepEqual(await markedOptions(page), ['3840:2160']);
    assert.equal(await rowValue(page, 'selectResolution'), '3840:2160');
    // UP and RETURN act at once: no wait before them
    await key(page, 'up', 0);
    assert.deepEqual(await markedOptions(page), ['3200:1800']);
    await key(page, 'back', 400);
    assert.equal((await menuState(page)).view, 'BasicSettings');
    assert.equal(await rowValue(page, 'selectResolution'), '3840:2160');

    // A twice on a gamepad, 70 ms from press to press, on the frame rate
    await selectItem(page, 'BasicSettings', 'selectFramerate', 'up', 'down');
    await doublePadButton(page, PAD.A, 500);
    state = await menuState(page);
    assert.equal(state.view, 'SelectFramerateMenu');
    assert.deepEqual(state.dropdowns, ['videoFramerateMenu']);
    assert.deepEqual(await markedOptions(page), ['60']);
    assert.equal(await rowValue(page, 'selectFramerate'), '60');

    // A choice on purpose: UP to 30 FPS and, after the time in which OK is the second press, A
    await padButton(page, PAD.UP, DROPDOWN_OK_WAIT_MS);
    assert.deepEqual(await markedOptions(page), ['30']);
    await padButton(page, PAD.A, 500);
    assert.equal(await rowValue(page, 'selectFramerate'), '30');
    assert.equal((await menuState(page)).view, 'BasicSettings');
    const stored = await waitForStorage(page, (values) => String(values.frameRate) === '30');
    assert.equal(stored.resolution, '3840:2160');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK right after UP or DOWN in a drop-down that just opened chooses the highlighted option', async () => {
  const app = await openMenus(harness, { stored: STORED_4K, pad: true });
  const { page } = app;
  try {
    await openSettingsSection(page, 'basicSettings');
    // Remote: OK opens the resolutions on 4K, UP 120 ms later highlights 1800p, OK 250 ms after the first chooses it (the
    // drop-down stayed open and needed a third OK before)
    await selectItem(page, 'BasicSettings', 'selectResolution', 'up', 'down');
    await timed(page, [{ at: 0, key: 'ok' }, { at: 120, key: 'up' }, { at: 250, key: 'ok' }], 500);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.dropdowns], ['BasicSettings', []]);
    assert.equal(await rowValue(page, 'selectResolution'), '3200:1800');

    // Gamepad: A opens the frame rates on 60 FPS, the D-pad UP highlights 30 FPS, A 250 ms after the first chooses it
    await selectItem(page, 'BasicSettings', 'selectFramerate', 'up', 'down');
    await timed(page, [{ at: 0, button: PAD.A, pressed: true }, { at: 50, button: PAD.A, pressed: false },
      { at: 120, button: PAD.UP, pressed: true }, { at: 170, button: PAD.UP, pressed: false },
      { at: 250, button: PAD.A, pressed: true }, { at: 300, button: PAD.A, pressed: false }], 500);
    state = await menuState(page);
    assert.deepEqual([state.view, state.dropdowns], ['BasicSettings', []]);
    assert.equal(await rowValue(page, 'selectFramerate'), '30');
    await waitForStorage(page, (values) => String(values.frameRate) === '30' && values.resolution === '3200:1800');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('after a click beside an open drop-down the keys act on the row, not on the options that no longer show', async () => {
  const app = await openMenus(harness, { stored: STORED_4K });
  const { page } = app;
  try {
    await openSettingsSection(page, 'basicSettings');
    await selectItem(page, 'BasicSettings', 'selectFramerate', 'up', 'down');
    await key(page, 'ok', 500);
    assert.equal((await menuState(page)).view, 'SelectFramerateMenu');
    // The mouse of the TV (or a pointer remote) clicks beside the drop-down, which closes it
    await page.mouse.click(300, 900);
    await page.waitForTimeout(400);
    assert.deepEqual((await menuState(page)).dropdowns, []);
    // The first key after the mouse only brings the selection back, the next ones move it in the section
    await key(page, 'down', 200);
    let state = await menuState(page);
    assert.equal(state.view, 'BasicSettings');
    assert.equal(state.current, 'selectFramerate');
    await key(page, 'up', 200);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.focused, state.marked], ['BasicSettings', 'selectResolution', 'selectResolution', ['selectResolution']]);
    // OK opens the drop-down of that row instead of choosing a frame rate unseen, and RETURN leaves the section
    await key(page, 'ok', 500);
    assert.deepEqual((await menuState(page)).dropdowns, ['videoResolutionMenu']);
    await key(page, 'back', 400);
    await key(page, 'back', 400);
    assert.equal((await menuState(page)).view, 'Settings');
    assert.equal(await rowValue(page, 'selectFramerate'), '60');
    assert.equal(await rowValue(page, 'selectResolution'), '3840:2160');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a dialog that opens over a drop-down closes it first: after the dialog the keys are on the row and nothing was chosen', async () => {
  // An install that checked for updates today, so that the automatic check 10 seconds after the start asks nothing here
  const app = await openMenus(harness, { stored: { lastUpdateCheck: Date.now() } });
  const { page } = app;
  try {
    // The answer of GitHub to a check for updates takes its time, in which the user opened the language menu
    await page.evaluate(() => {
      fetchLatestRelease = () => new Promise((resolve) => setTimeout(() => resolve({ latestVersion: '99.0.0', releaseNotes: 'notes' }), 300));
    });
    await openSettingsSection(page, 'interfaceSettings');
    await selectItem(page, 'InterfaceSettings', 'selectLanguage', 'up', 'down');
    await page.evaluate(() => checkForAppUpdates());
    await key(page, 'ok', 500);
    assert.equal((await menuState(page)).view, 'SelectLanguageMenu');
    // The answer is handled 1.5 s after it came
    await page.waitForFunction(() => document.getElementById('updateAppDialog').open, null, { timeout: 5000 });
    await page.waitForTimeout(300);
    let state = await menuState(page);
    assert.equal(state.view, 'UpdateMoonlightDialog');
    assert.deepEqual(state.dropdowns, []);
    assert.deepEqual(state.openDialogs, ['updateAppDialog']);
    // OK closes the dialog, and the keys are on the row of the language: DOWN and UP move in the section, RETURN leaves it
    await key(page, 'ok', 400);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.openDialogs], ['InterfaceSettings', 'selectLanguage', []]);
    await key(page, 'down', 200);
    assert.notEqual((await menuState(page)).current, 'selectLanguage');
    await key(page, 'up', 200);
    assert.equal((await menuState(page)).current, 'selectLanguage');
    await key(page, 'back', 400);
    assert.equal((await menuState(page)).view, 'Settings');
    assert.equal(await rowValue(page, 'selectLanguage'), 'auto');
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('lang')), 'en-US');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

for (const tv of ['s90c', 'fhd']) {
  test('the last drop-down of the Input Settings and of the Advanced Settings shows completely (' + tv + ')', async () => {
    const app = await openMenus(harness, { tv: { tv, conn: 'wifi' } });
    const { page } = app;
    try {
      for (const [category, viewName, rowId, count] of [['inputSettings', 'InputSettings', 'selectControllerType', 4],
        ['advancedSettings', 'AdvancedSettings', 'selectStatsPosition', 4], ['basicSettings', 'BasicSettings', 'selectResolution', 6]]) {
        await openSettingsSection(page, category);
        await selectItem(page, viewName, rowId, 'up', 'down');
        const scrolledBefore = await page.evaluate(() => document.getElementById('settings-right-pane').scrollTop);
        await key(page, 'ok', 600);
        let options = await dropdownOptions(page);
        assert.equal(options.length, count, rowId);
        // On the screen of 1080 px, and not at its very edge
        options.forEach((option) => {
          assert.ok(option.top >= 0 && option.bottom <= 1080 - 16 && option.bottom > option.top,
            rowId + ': the option ' + option.value + ' is on the screen, at ' + option.top + ' to ' + option.bottom + ' px');
        });
        // Each step of the highlight lands on an option that shows
        for (let step = 0; step < count; step++) {
          await key(page, 'down', 60);
          options = await dropdownOptions(page);
          const marked = options.filter((option) => option.marked);
          assert.equal(marked.length, 1, rowId);
          assert.ok(marked[0].top >= 0 && marked[0].bottom <= 1080, rowId + ': the highlighted option ' + marked[0].value + ' shows');
        }
        // A drop-down with room below it leaves the pane where it was
        if (rowId === 'selectResolution') {
          assert.equal(await page.evaluate(() => document.getElementById('settings-right-pane').scrollTop), scrolledBefore);
        }
        await key(page, 'back', 400);
        assert.equal((await menuState(page)).view, viewName);
      }
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });
}

test('UP and DOWN in the resolution menu of a Full HD TV step over the resolutions that it can\'t show', async () => {
  const app = await openMenus(harness, { tv: { tv: 'fhd', conn: 'wifi' } });
  const { page } = app;
  try {
    await openSettingsSection(page, 'basicSettings');
    await selectItem(page, 'BasicSettings', 'selectResolution', 'up', 'down');
    await key(page, 'ok', 500);
    const options = await dropdownOptions(page);
    const disabled = options.filter((option) => option.disabled).map((option) => option.value);
    assert.deepEqual(disabled, ['2560:1440', '3200:1800', '3840:2160']);
    assert.deepEqual(await markedOptions(page), ['1920:1080']);
    // DOWN from the last resolution that the TV shows goes around to the first one, UP back, over the disabled ones
    const seen = [];
    for (const name of ['down', 'down', 'up', 'up', 'up', 'up']) {
      await key(page, name, 60);
      seen.push((await markedOptions(page)).join(','));
    }
    assert.deepEqual(seen, ['854:480', '1280:720', '854:480', '1920:1080', '1280:720', '854:480']);
    await key(page, 'back', 400);
    assert.equal(await rowValue(page, 'selectResolution'), '1920:1080');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Advanced Settings keep a selection after their last row went away with the audio output', async () => {
  const app = await openMenus(harness, {});
  const { page } = app;
  try {
    await openSettingsSection(page, 'advancedSettings');
    // UP from the first row goes around to the last one, Decrypt host audio
    await key(page, 'up', 200);
    assert.equal((await menuState(page)).current, 'decryptHostAudioBtn');
    // Audio Settings > Audio output > Disabled, which takes that row off the Advanced Settings
    await openSettingsSection(page, 'audioSettings');
    await selectItem(page, 'AudioSettings', 'selectAudioBackend', 'up', 'down');
    await key(page, 'ok', 500);
    for (let step = 0; step < 4 && (await markedOptions(page))[0] !== 'Disabled'; step++) {
      await key(page, 'down', 100);
    }
    assert.deepEqual(await markedOptions(page), ['Disabled']);
    await page.waitForTimeout(DROPDOWN_OK_WAIT_MS);
    await key(page, 'ok', 500);
    assert.equal(await rowValue(page, 'selectAudioBackend'), 'Disabled');
    app.consoleErrors.length = 0;
    await openSettingsSection(page, 'advancedSettings');
    const state = await menuState(page);
    // The last row that is left has the selection, the mark and the focus (on its switch), and OK acts on it
    assert.deepEqual([state.view, state.current, state.focused, state.marked], ['AdvancedSettings', 'hdrMetadataBtn', 'hdrMetadataSwitch', ['hdrMetadataBtn']]);
    const before = await page.evaluate(() => document.getElementById('hdrMetadataSwitch').checked);
    await key(page, 'ok', 300);
    assert.equal(await page.evaluate(() => document.getElementById('hdrMetadataSwitch').checked), !before);
    assert.deepEqual(app.consoleErrors.filter((line) => line.indexOf('navigation.js') >= 0), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the restart question of Restore Defaults comes at once, and the second press of a double OK on Continue doesn\'t answer it', async () => {
  const app = await openMenus(harness, { stored: STORED_4K });
  const { page } = app;
  try {
    await page.evaluate(() => {
      window.__restarts = 0;
      restartApplication = () => {
        window.__restarts++;
      };
    });
    await openSettingsSection(page, 'basicSettings');
    await page.evaluate(() => restoreDefaultsDialog());
    await page.waitForTimeout(300);
    assert.equal((await menuState(page)).view, 'RestoreDefaultsDialog');
    // The dialog opens on Cancel: LEFT to Continue, then OK twice 120 ms apart
    await key(page, 'left', 150);
    assert.equal((await menuState(page)).current, 'continueRestoreDefaults');
    await doubleKey(page, 'ok', 300);
    let state = await menuState(page);
    assert.equal(state.view, 'RestartMoonlightDialog');
    assert.deepEqual(state.openDialogs, ['restartAppDialog']);
    assert.equal(await page.evaluate(() => window.__restarts), 0);
    // The question stays: nothing else opens later, where the user may have moved on
    await page.waitForTimeout(2300);
    state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs], ['RestartMoonlightDialog', ['restartAppDialog']]);
    // A later OK answers it
    await key(page, 'ok', 400);
    assert.equal(await page.evaluate(() => window.__restarts), 1);
    assert.ok((await takeSnackbars(page)).indexOf('Settings have been restored to their default values.') >= 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('OK twice on the disabled Ultra low latency mode switch opens its warning once, and the keys work after Close', async () => {
  // A Full HD TV on Tizen 5.5, where the switch is disabled and OK on it explains why
  const app = await openMenus(harness, { tv: { tv: 'fhd', conn: 'wifi' } });
  const { page } = app;
  try {
    await openSettingsSection(page, 'videoSettings');
    await selectItem(page, 'VideoSettings', 'gameModeBtn', 'up', 'down');
    assert.equal(await page.evaluate(() => document.getElementById('gameModeSwitch').disabled), true);
    // The warning opens 250 ms after each OK: two of them 100 ms apart
    await doubleKey(page, 'ok', 700, 100);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs, state.focused], ['WarningDialog', ['warningDialog'], 'closeWarning']);
    assert.equal(await page.evaluate(() => $('#warningDialogTitle').text()), 'Unsupported Feature');
    // One OK closes it, and UP and DOWN move in the section again: a second view of the dialog used to take them
    await key(page, 'ok', 400);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.openDialogs], ['VideoSettings', 'gameModeBtn', []]);
    await key(page, 'up', 200);
    const above = (await menuState(page)).current;
    assert.notEqual(above, 'gameModeBtn');
    await key(page, 'down', 200);
    state = await menuState(page);
    assert.deepEqual([state.view, state.current, state.marked], ['VideoSettings', 'gameModeBtn', ['gameModeBtn']]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
