'use strict';

// The runtime checks of plan WP8 in the real page, with the simulated tizentvwasm and MediaSource of the TV
// (tests/browser/mocks/tv-mock.js, options wasmPlayer and codecs):
// - Game mode: a WASM player that says clearly that it doesn't offer the Ultra Low Latency mode keeps the switch off
//   and disabled whatever is stored, explains it, and starts the stream without it. With the mode, or without a clear
//   answer, the rules by Tizen version stay (Tizen 9.0 off with the ForceGM hint), except that Tizen 5.5 with the mode
//   lets the switch be turned on. System information shows the answer and the API levels.
// - Codec check: System information shows the answers of MediaSource, or why they don't count, and only a counting no
//   for AV1 labels its menu entry, which stays selectable and keeps the label after a translation pass.
// - A stream that ends with error -200 after the TV rejected its video track names the codec, resolution and frame
//   rate (the format of the message is pinned in tests/unit/video-track-rejection.test.js).
// The rules themselves are tested in tests/unit/runtime-checks.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, readVideoSettings, startHarness, waitForStorage } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Position of the game mode in the arguments of the start request (SyncFunctions.startRequest in messages.js)
const START_ARG_VIDEO_CODEC = 23;
const START_ARG_GAME_MODE = 26;

const ULL_LINE = 'Ultra Low Latency mode (Game mode): ';
const LEVELS_LINE = 'WASM player API levels: ';
const DECODERS_LINE = 'Video decoders (MediaSource check): ';
const LEVEL52_LINE = 'Video decoders at level 5.2 (4K above 60 FPS): ';
const AV1_NOTE = 'AV1 (may not be supported by this TV)';
const GENERIC_200 = 'The TV was unable to start the streaming with the selected video settings. Try reducing the resolution or frame rate and consider changing the codec.';

// The lines of System information (innerText turned the line breaks into <br> elements)
function readSystemInfoLines(page) {
  return page.evaluate(() => document.getElementById('systemInfoBtn').innerHTML.split(/<br\s*\/?>/));
}

// The lines of System information about the WASM player and the decoders
async function readCheckLines(page) {
  return (await readSystemInfoLines(page)).filter((line) => [ULL_LINE, LEVELS_LINE, DECODERS_LINE, LEVEL52_LINE].some((prefix) => line.indexOf(prefix) === 0));
}

// What the AV1 entry of the video codec menu and the codec field show
function readCodecMenu(page) {
  return page.evaluate(() => {
    const item = document.querySelector('.videoCodecMenu li[data-value="AV1"]');
    return {
      av1: item.textContent.trim(),
      av1Disabled: item.hasAttribute('disabled') || item.classList.contains('unsupported-resolution'),
      others: $('.videoCodecMenu li:not([data-value="AV1"])').map(function() {
        return $(this).text().trim();
      }).get(),
      field: $('#selectCodec').text().trim(),
      value: String($('#selectCodec').data('value')),
    };
  });
}

// Record the snackbar messages of the page
function recordSnackbar(page) {
  return page.evaluate(() => {
    const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
    const show = snackbar.showSnackbar.bind(snackbar);
    window.__snackbarMessages = [];
    snackbar.showSnackbar = (data) => {
      window.__snackbarMessages.push(data.message);
      show(data);
    };
  });
}
const snackbarMessages = (page) => page.evaluate(() => window.__snackbarMessages.slice());

// Start a stream with a simulated host and return the arguments of the start request. The stream keeps running until
// the test sends its end with handleMessage(), which endStream() does.
function startStream(page) {
  return page.evaluate(async () => {
    let launch = null;
    const reply = () => new Promise((resolve) => {
      launch = resolve;
    });
    const host = {
      paired: true, serverUid: 'HOST1', address: '10.0.0.2', httpPort: 47989, currentGame: 0, appVersion: '7.1.431.-1', gfeVersion: '',
      serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
      launchApp: reply,
      resumeApp: reply,
    };
    window.__originalShowApps = window.__originalShowApps || showApps;
    showApps = () => Promise.resolve();
    window.__startStreamArgs = null;
    startGame(host, 8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    launch('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return window.__startStreamArgs;
  });
}

// Send the messages of the WebAssembly module that end the stream, e.g. ['streamTerminated: -200']
function endStream(page, messages) {
  return page.evaluate(async (texts) => {
    texts.forEach((text) => handleMessage(text));
    await new Promise((resolve) => setTimeout(resolve, 100));
    showApps = window.__originalShowApps;
  }, messages);
}

test('a WASM player without the Ultra Low Latency mode keeps the game mode off and disabled, whatever the Tizen version', async () => {
  const cases = [
    { tv: { tv: 'uhd', wasmPlayer: 'noUll' }, levels: '0, 1, 2, 3, 4' },
    // Without isApiFeatureSupported() the glue code of the WASM player never uses the mode
    { tv: { tv: 'uhd', wasmPlayer: 'apiLevels' }, levels: '0, 1, 2, 3' },
    // Nor on an older player without availableApis, whose API level the glue code derives from its classes
    { tv: { tv: 'uhd', wasmPlayer: 'legacy' }, levels: '0' },
    { tv: { tv: 'fhd', wasmPlayer: 'legacy' }, levels: '0' },
    { tv: { tv: 's90c', wasmPlayer: 'noUll' }, levels: '0, 1, 2, 3, 4' },
    { tv: { tv: 'fhd', wasmPlayer: 'noUll' }, levels: '0, 1, 2, 3, 4' },
  ];
  for (const entry of cases) {
    const label = JSON.stringify(entry.tv);
    const app = await openApp(harness, { tv: entry.tv });
    try {
      const shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.gameMode, shown.gameModeDisabled], [false, true], label);
      assert.deepEqual((await readCheckLines(app.page)).slice(0, 2), [ULL_LINE + 'No', LEVELS_LINE + entry.levels], label);
      assert.ok(app.logs.some((line) => line.indexOf('WASM Player: {"ultraLowLatency":"no"') >= 0), label);
      assert.deepEqual(app.errors, [], label);
    } finally {
      await app.context.close();
    }
  }
});

test('a stored game mode stays stored but off, the remote explains why, and the stream starts without it', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi', wasmPlayer: 'noUll' }, stored: { gameMode: true } });
  const { page } = app;
  try {
    let shown = await readVideoSettings(page);
    assert.deepEqual([shown.gameMode, shown.gameModeDisabled], [false, true]);
    assert.equal((await readStorage(page)).gameMode, true);

    // The remote presses the disabled switch
    await page.evaluate(() => clickElement(document.getElementById('gameModeBtn')));
    await page.waitForTimeout(400);
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('warningDialogTitle').textContent,
      text: document.getElementById('warningDialogText').innerHTML,
      open: isDialogOpen,
    }));
    assert.equal(dialog.open, true);
    assert.equal(dialog.title, 'Unsupported Feature');
    assert.ok(dialog.text.indexOf('The video player of this TV reports that it doesn\'t offer the Ultra Low Latency mode that Game Mode uses, so the stream uses the Low Latency mode.<br><br>Since the Game Mode cannot be enabled') === 0, dialog.text);
    await page.evaluate(() => $('#closeWarning').trigger('click'));
    shown = await readVideoSettings(page);
    assert.deepEqual([shown.gameMode, shown.gameModeDisabled], [false, true]);

    // The stream asks for the Low Latency mode, which the WASM player would have used anyway
    const args = await startStream(page);
    assert.equal(args[START_ARG_VIDEO_CODEC], 'HEVC');
    assert.equal(args[START_ARG_GAME_MODE], 0);
    await endStream(page, ['streamTerminated: 0']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the optimal settings say why the game mode stays off and remove a stored value', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi', wasmPlayer: 'noUll' }, stored: { gameMode: true } });
  const { page } = app;
  try {
    await page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    const text = await page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
    assert.ok(text.indexOf('• Game mode off, because the video player of this TV doesn\'t offer the Ultra Low Latency mode<br>') >= 0, text);
    assert.ok(text.indexOf('Game mode on') < 0, text);
    await page.evaluate(() => $('#continueWarning').trigger('click'));
    const stored = await waitForStorage(page, (values) => values.bitrate === '80');
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'gameMode'), false);
    const shown = await readVideoSettings(page);
    assert.deepEqual([shown.gameMode, shown.gameModeDisabled, shown.resolution, shown.hdr], [false, true, '3840:2160', true]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('with the Ultra Low Latency mode or without a clear answer, the game mode follows the Tizen version as before', async () => {
  const cases = [
    // Tizen 6.5: on by default
    { tv: { tv: 'uhd', wasmPlayer: 'ull' }, expected: [true, false], answer: 'Yes', levels: '0, 1, 2, 3, 4, 5' },
    { tv: { tv: 'uhd', wasmPlayer: 'none' }, expected: [true, false], answer: 'Unknown', levels: 'Unknown' },
    { tv: { tv: 'uhd', wasmPlayer: 'disagree' }, expected: [true, false], answer: 'Unknown', levels: '0, 1, 2, 3, 4, 5' },
    { tv: { tv: 'uhd', wasmPlayer: 'throws' }, expected: [true, false], answer: 'Unknown', levels: 'Unknown' },
    // Tizen 5.5: off and disabled, unless the WASM player offers the mode, where the switch can be turned on
    { tv: { tv: 'fhd', wasmPlayer: 'none' }, expected: [false, true], answer: 'Unknown', levels: 'Unknown' },
    { tv: { tv: 'fhd', wasmPlayer: 'ull' }, expected: [false, false], answer: 'Yes', levels: '0, 1, 2, 3, 4, 5' },
    // Tizen 9.0: off, the switch can be turned on with the compatibility warning
    { tv: { tv: 's90c', wasmPlayer: 'ull' }, expected: [false, false], answer: 'Yes', levels: '0, 1, 2, 3, 4, 5' },
    { tv: { tv: 's90c', wasmPlayer: 'none' }, expected: [false, false], answer: 'Unknown', levels: 'Unknown' },
  ];
  for (const entry of cases) {
    const label = JSON.stringify(entry.tv);
    const app = await openApp(harness, { tv: entry.tv });
    try {
      const shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.gameMode, shown.gameModeDisabled], entry.expected, label);
      assert.deepEqual((await readCheckLines(app.page)).slice(0, 2), [ULL_LINE + entry.answer, LEVELS_LINE + entry.levels], label);
      assert.deepEqual(app.errors, [], label);
    } finally {
      await app.context.close();
    }
  }
});

test('on Tizen 5.5 with the Ultra Low Latency mode, the game mode can be turned on and is stored', async () => {
  const app = await openApp(harness, { tv: { tv: 'fhd', wasmPlayer: 'ull' } });
  const { page } = app;
  try {
    await page.evaluate(() => $('#gameModeSwitch').trigger('click'));
    const stored = await waitForStorage(page, (values) => values.gameMode === true);
    assert.equal(stored.gameMode, true);
    const args = await startStream(page);
    assert.equal(args[START_ARG_GAME_MODE], 1);
    await endStream(page, ['streamTerminated: 0']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('on Tizen 5.5 with the Ultra Low Latency mode, the optimal settings say that they turn a game mode that is on off', async () => {
  const app = await openApp(harness, { tv: { tv: 'fhd', conn: 'wifi', wasmPlayer: 'ull' } });
  const { page } = app;
  try {
    await page.evaluate(() => $('#gameModeSwitch').trigger('click'));
    await waitForStorage(page, (values) => values.gameMode === true);
    await page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    const text = await page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
    assert.ok(text.indexOf('• Game mode off<br>') >= 0, text);
    assert.ok(text.indexOf('Game mode on') < 0, text);
    await page.evaluate(() => $('#continueWarning').trigger('click'));
    const stored = await waitForStorage(page, (values) => values.gameMode === false);
    assert.equal(stored.gameMode, false);
    const shown = await readVideoSettings(page);
    assert.deepEqual([shown.gameMode, shown.gameModeDisabled], [false, false], 'off, but the switch can still be turned on');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
  // Where the game mode can't be turned on, or on Tizen 9.0 with its own note, the dialog has no such line
  for (const tv of [{ tv: 'fhd', wasmPlayer: 'none' }, { tv: 's90c', wasmPlayer: 'ull' }, { tv: 'uhd', wasmPlayer: 'ull' }]) {
    const other = await openApp(harness, { tv: Object.assign({ conn: 'wifi' }, tv) });
    try {
      await other.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
      const text = await other.page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
      assert.ok(text.indexOf('• Game mode off<br>') < 0, JSON.stringify(tv) + ': ' + text);
      assert.deepEqual(other.errors, []);
    } finally {
      await other.context.close();
    }
  }
});

test('the S90C keeps its settings and the ForceGM hint with the Ultra Low Latency mode (plan section 3)', async () => {
  for (const forceGM of [0, 1]) {
    const reference = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', forceGM } });
    const withMode = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', forceGM, wasmPlayer: 'ull' } });
    try {
      const expected = await readVideoSettings(reference.page);
      assert.deepEqual(await readVideoSettings(withMode.page), expected);
      assert.deepEqual([expected.resolution, expected.frameRate, expected.codec, expected.hdr, expected.bitrate, expected.unlockAllFps, expected.gameMode, expected.framePacing],
        ['3840:2160', '60', 'HEVC', true, '100', true, false, true]);
      await withMode.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
      const text = await withMode.page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
      const hint = forceGM
        ? 'ForceGM variant detected: the app asks the TV for its Game Mode, so the Game mode setting stays off here and the decoder uses the Low Latency mode.'
        : 'Game mode stays disabled on Tizen 9.0, so install the ForceGM variant for the lowest latency.';
      assert.ok(text.indexOf(hint) >= 0, text);
      assert.ok(text.indexOf('Ultra Low Latency') < 0, text);
      assert.deepEqual(withMode.errors, []);
    } finally {
      await reference.context.close();
      await withMode.context.close();
    }
  }
});

test('System information shows the answers of the codec check, or why they do not count', async () => {
  const YES_ALL = 'H.264: Yes, HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes';
  const YES_52 = 'HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes';
  const expected = {
    all: [DECODERS_LINE + YES_ALL, LEVEL52_LINE + YES_52],
    noAv1: [DECODERS_LINE + 'H.264: Yes, HEVC: Yes, HEVC Main10: Yes, AV1: No, AV1 Main10: No', LEVEL52_LINE + 'HEVC: Yes, HEVC Main10: Yes, AV1: No, AV1 Main10: No'],
    noAv1Main10: [DECODERS_LINE + 'H.264: Yes, HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: No', LEVEL52_LINE + 'HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: No'],
    noLevel52: [DECODERS_LINE + YES_ALL, LEVEL52_LINE + 'HEVC: No, HEVC Main10: No, AV1: No, AV1 Main10: No'],
    acceptsBogus: [DECODERS_LINE + 'Unknown (the answers of the TV are not reliable)'],
    noH264: [DECODERS_LINE + 'Unknown (the answers of the TV are not reliable)'],
    throws: [DECODERS_LINE + 'Unknown (the answers of the TV are not reliable)'],
    none: [DECODERS_LINE + 'Unknown (not available)'],
  };
  for (const codecs of Object.keys(expected)) {
    const app = await openApp(harness, { tv: { tv: 'uhd', codecs } });
    try {
      assert.deepEqual((await readCheckLines(app.page)).slice(2), expected[codecs], codecs);
      const menu = await readCodecMenu(app.page);
      // Only a counting no for AV1 in 8 and 10 bits labels its entry
      assert.equal(menu.av1, codecs === 'noAv1' ? AV1_NOTE : 'AV1', codecs);
      assert.equal(menu.av1Disabled, false, codecs);
      assert.deepEqual(menu.others, ['H.264', 'HEVC'], codecs);
      assert.equal(app.logs.filter((line) => line.indexOf('Video Decoders (MediaSource check): ') >= 0).length > 0, true, codecs);
      assert.deepEqual(app.errors, [], codecs);
    } finally {
      await app.context.close();
    }
  }
});

test('the AV1 entry with the note stays selectable, the field shows the codec, and a translation pass keeps the note', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', codecs: 'noAv1' } });
  const { page } = app;
  try {
    await page.evaluate(() => saveVideoCodec.call(document.querySelector('.videoCodecMenu li[data-value="AV1"]')));
    await waitForStorage(page, (values) => values.videoCodec === 'AV1');
    let menu = await readCodecMenu(page);
    assert.deepEqual([menu.av1, menu.field, menu.value], [AV1_NOTE, 'AV1', 'AV1']);

    await page.evaluate(() => window.i18n.refreshUI());
    menu = await readCodecMenu(page);
    assert.deepEqual([menu.av1, menu.field, menu.value], [AV1_NOTE, 'AV1', 'AV1']);

    await page.evaluate(() => window.i18n.setLanguage('pt-BR'));
    menu = await readCodecMenu(page);
    assert.deepEqual([menu.av1, menu.field], ['AV1 (pode não ser suportado por esta TV)', 'AV1']);
    const lines = await readSystemInfoLines(page);
    assert.ok(lines.indexOf('Decodificadores de Vídeo (verificação do MediaSource): H.264: Sim, HEVC: Sim, HEVC Main10: Sim, AV1: Não, AV1 Main10: Não') >= 0, lines.join('\n'));
    assert.ok(lines.indexOf('Modo de Latência Ultrabaixa (Modo Jogo): Desconhecido') >= 0, lines.join('\n'));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stored AV1 codec shows the codec in the field and the note in the menu', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', codecs: 'noAv1' }, stored: { videoCodec: 'AV1', hdrMode: false } });
  try {
    let menu = await readCodecMenu(app.page);
    assert.deepEqual([menu.av1, menu.field, menu.value], [AV1_NOTE, 'AV1', 'AV1']);
    // Also when the stored settings load after the menu got its note, without a translation pass after them
    await app.page.evaluate(() => loadStoredSettings());
    await app.page.waitForTimeout(500);
    menu = await readCodecMenu(app.page);
    assert.deepEqual([menu.av1, menu.field, menu.value], [AV1_NOTE, 'AV1', 'AV1']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stream that the TV rejects names the codec, resolution and frame rate, and only for that stream', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  const { page } = app;
  try {
    await recordSnackbar(page);
    await startStream(page);
    await endStream(page, ['VideoTrackRejected: AV1 Main10,3840,2160,60', 'streamTerminated: -200']);
    assert.deepEqual(await snackbarMessages(page), ['The TV rejected AV1 Main10 at 3840x2160@60 FPS. Choose HEVC as the video codec.']);

    // A rejection that arrives after its stream was already stopped doesn't name the next stream's error
    await page.evaluate(() => handleMessage('VideoTrackRejected: HEVC Main10,3840,2160,120'));
    await startStream(page);
    await endStream(page, ['streamTerminated: -200']);
    assert.deepEqual((await snackbarMessages(page)).slice(1), [GENERIC_200]);

    // Translated
    await page.evaluate(() => window.i18n.setLanguage('pt-BR'));
    await startStream(page);
    await endStream(page, ['VideoTrackRejected: HEVC Main10,3840,2160,120', 'streamTerminated: -200']);
    assert.deepEqual((await snackbarMessages(page)).slice(2), ['A TV rejeitou HEVC Main10 em 3840x2160@120 FPS. Desative o HDR ou reduza a resolução ou a taxa de quadros.']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
