'use strict';

// Drives every switch of the settings (and the jitter buffer of the Web Audio backend) with the keys of the remote, as a
// user does, and checks what the app stores and shows after a restart (2.3.5): each row of a section is selected, OK
// toggles it (the handler reads the state of the switch 100 ms after the click, see save...() in index.js), every key
// lands in the storage, the app starts again and shows the stored states, the rows are toggled back and the next start
// shows those again. So a handler that stores under another key, isn't bound to its switch any more, or a switch that
// isn't read back at the start, fails its row. Also the messages and options that some switches bring: the warning of
// higher frame rates with their 90 and 120 FPS options, the compatibility warning of the Ultra low latency mode on
// Tizen 9.0, and the warnings of the experimental switches.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { readOtherSettings, readStorage, readVideoSettings, startHarness, waitForStorage } = require('./harness');
const { key, menuState, openMenus, openSettingsSection, reloadMenus, selectItem, takeSnackbars } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// What the settings screen shows, from both readers of the harness
async function shown(page) {
  return Object.assign({}, await readOtherSettings(page), await readVideoSettings(page));
}

// The rows of a section: the id of the row, the key it stores and the field of the readers that shows it
const SECTIONS = {
  basic: { category: 'basicSettings', view: 'BasicSettings', rows: [['unlockAllFpsBtn', 'unlockAllFps', 'unlockAllFps']] },
  interface: { category: 'interfaceSettings', view: 'InterfaceSettings', rows: [['ipAddressFieldModeBtn', 'ipAddressFieldMode', 'ipAddressFieldMode']] },
  input: {
    category: 'inputSettings', view: 'InputSettings',
    rows: [['rumbleFeedbackBtn', 'rumbleFeedback', 'rumbleFeedback'], ['mouseEmulationBtn', 'mouseEmulation', 'mouseEmulation']],
  },
  audio: {
    category: 'audioSettings', view: 'AudioSettings',
    rows: [['audioSyncBtn', 'audioSync', 'audioSync'], ['playHostAudioBtn', 'playHostAudio', 'playHostAudio'], ['audioQosBtn', 'audioQos', 'audioQos']],
  },
  webAudio: { category: 'audioSettings', view: 'AudioSettings', rows: [['audioClockSyncBtn', 'audioClockSync', 'audioClockSync']] },
  video: {
    category: 'videoSettings', view: 'VideoSettings',
    rows: [['hdrModeBtn', 'hdrMode', 'hdr'], ['framePacingBtn', 'framePacing', 'framePacing'], ['gameModeBtn', 'gameMode', 'gameMode']],
  },
  advanced: {
    category: 'advancedSettings', view: 'AdvancedSettings',
    rows: [
      ['optimizeGamesBtn', 'optimizeGames', 'optimizeGames'], ['fullRangeBtn', 'fullRange', 'fullRange'],
      ['disableWarningsBtn', 'disableWarnings', 'disableWarnings'], ['refFrameInvalidationBtn', 'refFrameInvalidation', 'refFrameInvalidation'],
      ['hdrMetadataBtn', 'hdrMetadata', 'hdrMetadata'], ['decryptHostAudioBtn', 'decryptHostAudio', 'decryptHostAudio'],
    ],
  },
};

// Toggle each row of the section with OK, from the state the screen shows, and wait until every new state is stored.
// `onToggled(rowId, value, messages)` sees the new state of a row and the messages that its OK brought.
async function toggleRows(app, section, onToggled) {
  const { page } = app;
  await openSettingsSection(page, section.category);
  const before = await shown(page);
  const expected = {};
  for (const [rowId, storageKey, field] of section.rows) {
    await selectItem(page, section.view, rowId, 'up', 'down');
    await takeSnackbars(page);
    await key(page, 'ok', 400);
    expected[storageKey] = !before[field];
    if (onToggled) {
      await onToggled(rowId, expected[storageKey], await takeSnackbars(page));
    }
  }
  await waitForStorage(page, (values) => Object.keys(expected).every((name) => values[name] === expected[name]));
  return expected;
}

// After a restart: the storage and the settings screen have the given states
async function assertRestarted(app, section, expected, label) {
  await reloadMenus(app);
  const stored = await readStorage(app.page);
  const screen = await shown(app.page);
  section.rows.forEach(([rowId, storageKey, field]) => {
    assert.equal(stored[storageKey], expected[storageKey], `${label}: ${storageKey} stored`);
    assert.equal(screen[field], expected[storageKey], `${label}: ${rowId} shows the stored state after a restart`);
  });
}

// Toggle the rows of a section, restart, toggle them back, restart, with the checks above
async function roundTrip(app, section, onToggled) {
  const first = await toggleRows(app, section, onToggled);
  await assertRestarted(app, section, first, 'toggled');
  const back = await toggleRows(app, section, onToggled);
  section.rows.forEach(([, storageKey]) => assert.equal(back[storageKey], !first[storageKey], storageKey + ' toggled back'));
  await assertRestarted(app, section, back, 'toggled back');
  return { first, back };
}

test('Basic Settings: Unlock all FPS is stored and kept, with its warning and its frame rates', async () => {
  const app = await openMenus(harness);
  try {
    const turnedOn = [];
    await roundTrip(app, SECTIONS.basic, async (rowId, value, messages) => {
      const options = (await readVideoSettings(app.page)).frameRateOptions;
      if (value) {
        turnedOn.push(messages);
        assert.ok(options.indexOf('90') >= 0 && options.indexOf('120') >= 0, 'the higher frame rates appear: ' + options.join(', '));
      } else {
        assert.ok(options.indexOf('90') < 0 && options.indexOf('120') < 0, 'the higher frame rates go again: ' + options.join(', '));
        assert.deepEqual(messages, [], 'no warning when it is turned off');
      }
    });
    assert.equal(turnedOn.length, 1);
    assert.deepEqual(turnedOn[0], ['Warning: Higher frame rates may not be fully supported by your TV and do not guarantee a smoother experience. Performance issues may occur due to platform limitations!']);
  } finally {
    await app.context.close();
  }
});

test('Interface and Input Settings: each switch is stored and kept', async () => {
  const app = await openMenus(harness);
  try {
    await roundTrip(app, SECTIONS.interface);
    await roundTrip(app, SECTIONS.input);
  } finally {
    await app.context.close();
  }
});

test('Audio Settings of the media player of the TV: each switch is stored and kept', async () => {
  const app = await openMenus(harness);
  try {
    assert.equal((await readOtherSettings(app.page)).audioBackend, 'EMSS');
    await roundTrip(app, SECTIONS.audio);
  } finally {
    await app.context.close();
  }
});

test('Audio Settings of Web Audio: the jitter buffer and Audio clock sync are stored and kept', async () => {
  const app = await openMenus(harness, { stored: { audioBackend: 'WebAudio' } });
  try {
    const { page } = app;
    // The jitter buffer: OK opens its slider, RIGHT twice adds two steps of 25 ms, RETURN closes it
    const setJitter = async (arrow, steps) => {
      await openSettingsSection(page, 'audioSettings');
      await selectItem(page, 'AudioSettings', 'selectAudioJitter', 'up', 'down');
      await key(page, 'ok', 400);
      assert.equal((await menuState(page)).view, 'SelectAudioJitterMenu');
      for (let i = 0; i < steps; i++) {
        await key(page, arrow, 150);
      }
      await key(page, 'back', 400);
    };
    const initial = (await readOtherSettings(page)).audioJitter;
    const raised = String(Number(initial) + 50);
    await setJitter('right', 2);
    await waitForStorage(page, (values) => values.audioJitter === raised);
    assert.equal(await page.evaluate(() => $('#selectAudioJitter').text()), raised + ' ms');
    await reloadMenus(app);
    assert.equal((await readStorage(page)).audioJitter, raised, 'stored as the text of the slider');
    assert.equal((await readOtherSettings(page)).audioJitter, raised);
    assert.equal(await page.evaluate(() => $('#selectAudioJitter').text()), raised + ' ms');
    await setJitter('left', 2);
    await waitForStorage(page, (values) => values.audioJitter === initial);
    await reloadMenus(app);
    assert.equal((await readOtherSettings(page)).audioJitter, initial);
    assert.equal(await page.evaluate(() => $('#selectAudioJitter').text()), initial + ' ms');
    await roundTrip(app, SECTIONS.webAudio);
  } finally {
    await app.context.close();
  }
});

test('Video Settings: HDR, frame pacing and the Ultra low latency mode are stored and kept, with its warning on Tizen 9.0', async () => {
  const app = await openMenus(harness, { tv: { tv: 's90c', conn: 'wifi', wasmPlayer: 'ull' } });
  try {
    const { page } = app;
    assert.equal((await readVideoSettings(page)).codec, 'HEVC');
    const warnings = [];
    await roundTrip(app, SECTIONS.video, async (rowId, value) => {
      if (rowId !== 'gameModeBtn') {
        return;
      }
      if (value) {
        // The compatibility warning of Tizen 9.0 and newer opens; OK closes it
        await page.waitForFunction(() => isDialogOpen && document.getElementById('warningDialogTitle').textContent === 'Compatibility Warning', null, { timeout: 3000 });
        warnings.push(await page.evaluate(() => document.getElementById('warningDialogText').textContent));
        await key(page, 'ok', 500);
        assert.equal(await page.evaluate(() => isDialogOpen), false);
      } else {
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => isDialogOpen), false, 'no warning when it is turned off');
      }
    });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].indexOf('The Ultra low latency mode is not compatible with Tizen 9.0') === 0, warnings[0]);
    // The switch is stored with the Tizen version that it was stored on
    assert.equal((await readStorage(page)).gameModePlatformVer, '9.0');
  } finally {
    await app.context.close();
  }
});

test('Advanced Settings: each switch is stored and kept, and the experimental ones warn when turned on', async () => {
  const app = await openMenus(harness);
  try {
    const messages = {};
    await roundTrip(app, SECTIONS.advanced, (rowId, value, taken) => {
      if (value) {
        messages[rowId] = taken;
      } else {
        assert.deepEqual(taken, [], rowId + ': no message when it is turned off');
      }
    });
    assert.deepEqual(messages.refFrameInvalidationBtn, ['Warning: Reference frame invalidation is experimental. If artifacts remain after a frame drop, disable it again!']);
    assert.deepEqual(messages.hdrMetadataBtn, ['Warning: HDR static metadata is experimental. If HDR streams fail to start or look wrong, disable it again!']);
    assert.deepEqual(messages.decryptHostAudioBtn, ['Only Wolf and Punktfunk-style hosts need this. With Sunshine it only turns on the encryption of the audio, which isn\'t needed.']);
    ['optimizeGamesBtn', 'fullRangeBtn', 'disableWarningsBtn'].forEach((rowId) => assert.deepEqual(messages[rowId], [], rowId));
  } finally {
    await app.context.close();
  }
});
