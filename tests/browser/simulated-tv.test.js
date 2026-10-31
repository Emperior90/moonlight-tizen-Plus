'use strict';

// Checks the test setup itself (the simulated TV and the stub of the WebAssembly module, see mocks/), and pins what the
// UI derives directly from the TV: the System information text (which since 1.19.100 also shows what the app detected:
// panel, HDR, connection type, tested profile and the model year hint, and the connected gamepads, none
// here; see gamepad-controllers.test.js) and the resolutions marked as unsupported, also after a translation pass of
// i18n.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readVideoSettings, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Read what index.js took from the product APIs at startup
function readTvGlobals(page) {
  return page.evaluate(() => ({
    modelName,
    modelSeries,
    modelGroup,
    platformVer,
    is4kPanel,
    is8kPanel,
    isHdrCapable,
    maxSupportedWidth,
    profile: tvCapabilities.profile ? tvCapabilities.profile.id : null,
    connection: getActiveConnectionType(),
  }));
}

test('the query string configures the simulated TV', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', model: 'QE65Q90TAT', tizen: '6.0', hdr: 0, panel: '8k', conn: 'error' } });
  try {
    assert.deepEqual(await readTvGlobals(app.page), {
      modelName: 'QE65Q90TAT',
      modelSeries: '22_PONTUSM_QTV',
      modelGroup: '22_PONTUSM',
      platformVer: '6.0',
      is4kPanel: true,
      is8kPanel: true,
      isHdrCapable: false,
      maxSupportedWidth: 7680,
      profile: null,
      connection: 'unknown',
    });
    // A failing network API counts as an unknown connection
    assert.equal((await readVideoSettings(app.page)).bitrate, '80');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a configuration from an init script wins over the query string', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, mockConfig: { tv: 'fhd', conn: 'ethernet' } });
  try {
    const globals = await readTvGlobals(app.page);
    assert.equal(globals.modelName, 'UE43T5300AU');
    assert.equal(globals.platformVer, '5.5');
    assert.equal(globals.connection, 'ethernet');
  } finally {
    await app.context.close();
  }
});

test('the WebAssembly stub starts the UI: a fresh install creates a certificate first', async () => {
  const fresh = await openApp(harness, { tv: { tv: 's90c' } });
  try {
    const calls = await fresh.page.evaluate(() => window.__wasmCalls.map((call) => call.name).filter((name) => name !== 'openUrl'));
    assert.deepEqual(calls, ['makeCert', 'httpInit']);
    assert.equal(await fresh.page.evaluate(() => $('#wasmSpinner').is(':visible')), false, 'the loading spinner is gone');
  } finally {
    await fresh.context.close();
  }
  const existing = await openApp(harness, {
    tv: { tv: 's90c' },
    stored: { uniqueid: '0123456789abcdef', cert: { cert: 'STORED-CERT', privateKey: 'STORED-KEY' } },
  });
  try {
    const calls = await existing.page.evaluate(() => window.__wasmCalls.filter((call) => call.name !== 'openUrl'));
    assert.deepEqual(calls, [{ name: 'httpInit', args: ['STORED-CERT', 'STORED-KEY', '0123456789abcdef'] }]);
  } finally {
    await existing.context.close();
  }
});

// Read the resolutions that the menu marks as unsupported, with their disabled state and label
function readUnsupportedResolutions(page) {
  return page.evaluate(() => $('.videoResolutionMenu li.unsupported-resolution').map(function() {
    return { value: String($(this).data('value')), disabled: $(this).attr('disabled') === 'disabled', label: $(this).text().trim() };
  }).get());
}

// Return the resolutions that the menu marks as unsupported on a simulated TV
async function unsupportedResolutionsOn(tvOptions) {
  const app = await openApp(harness, { tv: tvOptions });
  try {
    return await readUnsupportedResolutions(app.page);
  } finally {
    await app.context.close();
  }
}

test('resolutions above the panel are marked unsupported and disabled', async () => {
  assert.deepEqual(await unsupportedResolutionsOn({ tv: 's90c' }), []);
  assert.deepEqual(await unsupportedResolutionsOn({ tv: '8k' }), []);
  const fhd = await unsupportedResolutionsOn({ tv: 'fhd' });
  assert.deepEqual(fhd.map((item) => [item.value, item.disabled]), [['2560:1440', true], ['3200:1800', true], ['3840:2160', true]]);
});

test('the unsupported resolutions keep their [Unsupported] label after every translation pass', async () => {
  // The first translation pass of i18n.js rewrote the menu items from their data-i18n key and dropped the label
  const app = await openApp(harness, { tv: { tv: 'fhd' } });
  try {
    assert.deepEqual((await readUnsupportedResolutions(app.page)).map((item) => item.label), [
      '2560 x 1440 (1440p) [Unsupported]',
      '3200 x 1800 (1800p) [Unsupported]',
      '3840 x 2160 (4K) [Unsupported]',
    ]);
    // A change of the language translates the label too, and the supported resolutions get none
    await app.page.evaluate(() => window.i18n.setLanguage('pt-BR'));
    assert.deepEqual((await readUnsupportedResolutions(app.page)).map((item) => item.label), [
      '2560 x 1440 (1440p) [Não suportada]',
      '3200 x 1800 (1800p) [Não suportada]',
      '3840 x 2160 (4K) [Não suportada]',
    ]);
    assert.deepEqual(await app.page.evaluate(() => $('.videoResolutionMenu li:not(.unsupported-resolution)').map(function() {
      return $(this).text().trim();
    }).get()), ['854 x 480 (480p)', '1280 x 720 (720p)', '1920 x 1080 (1080p)']);
    // The selected resolution keeps its label without the suffix
    assert.equal(await app.page.evaluate(() => $('#selectResolution').text().trim()), '1920 x 1080 (1080p)');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// Read the System information as text (innerText turned the line breaks into <br> elements)
function readSystemInfo(page) {
  return page.evaluate(() => document.getElementById('systemInfoBtn').innerHTML.replace(/<br\s*\/?>/g, '\n'));
}

// The simulated TVs have no tizentvwasm and answer yes for every codec of the WASM player by default (see
// runtime-checks.test.js for the other answers of the runtime checks)
test('System information shows the app, the model strings and what the app detected about the TV', async () => {
  const expected = [
    {
      tv: { tv: 's90c', conn: 'ethernet' },
      lines: [
        'App Version: Moonlight Plus v2.2.0',
        'Platform Version: Tizen 9.0',
        'TV Model Series: 23_PONTUSM_OLED',
        'TV Model Name: QE55S90CAT',
        'TV Model Group: 23_PONTUSM (model year 2023)',
        'Panel: 4K',
        'HDR Support: Yes',
        'Network Connection Type: Ethernet',
        'Tested Profile: S90C',
        'Ultra Low Latency mode (Game mode): Unknown',
        'WASM player API levels: Unknown',
        'Video decoders (MediaSource check): H.264: Yes, HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes',
        'Video decoders at level 5.2 (4K above 60 FPS): HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes',
        'Controllers: None',
        '',
        'Last session: None yet',
      ],
    },
    {
      tv: { tv: 'fhd', conn: 'wifi' },
      lines: [
        'App Version: Moonlight Plus v2.2.0',
        'Platform Version: Tizen 5.5',
        'TV Model Series: 20_KANTM2_FHD',
        'TV Model Name: UE43T5300AU',
        'TV Model Group: 20_KANTM2 (model year 2020)',
        'Panel: Full HD',
        'HDR Support: No',
        'Network Connection Type: Wi-Fi',
        'Tested Profile: None',
        'Ultra Low Latency mode (Game mode): Unknown',
        'WASM player API levels: Unknown',
        'Video decoders (MediaSource check): H.264: Yes, HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes',
        'Video decoders at level 5.2 (4K above 60 FPS): HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes',
        'Controllers: None',
        '',
        'Last session: None yet',
      ],
    },
    {
      tv: { tv: '8k', conn: 'unknown', modelCode: 'NOYEAR' },
      lines: [
        'App Version: Moonlight Plus v2.2.0',
        'Platform Version: Tizen 6.5',
        'TV Model Series: 22_PONTUSM_8K',
        'TV Model Name: QE65QN900BT',
        'TV Model Group: NOYEAR',
        'Panel: 8K',
        'HDR Support: Yes',
        'Network Connection Type: Unknown',
        'Tested Profile: None',
        'Ultra Low Latency mode (Game mode): Unknown',
        'WASM player API levels: Unknown',
        'Video decoders (MediaSource check): H.264: Yes, HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes',
        'Video decoders at level 5.2 (4K above 60 FPS): HEVC: Yes, HEVC Main10: Yes, AV1: Yes, AV1 Main10: Yes',
        'Controllers: None',
        '',
        'Last session: None yet',
      ],
    },
  ];
  for (const entry of expected) {
    const app = await openApp(harness, { tv: entry.tv });
    try {
      assert.equal(await readSystemInfo(app.page), entry.lines.join('\n'), JSON.stringify(entry.tv));
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('System information shows the current connection type when the About settings open', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'ethernet' } });
  try {
    assert.ok((await readSystemInfo(app.page)).indexOf('Network Connection Type: Ethernet') >= 0);
    // The TV switches to Wi-Fi while the app runs
    await app.page.evaluate(() => {
      window.__tvMock.config.conn = 'wifi';
    });
    await app.page.evaluate(() => showSettings());
    await app.page.waitForTimeout(600);
    await app.page.evaluate(() => handleSettingsView('aboutSettings'));
    assert.ok((await readSystemInfo(app.page)).indexOf('Network Connection Type: Wi-Fi') >= 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('System information without its element only logs an error instead of throwing', async () => {
  // The else branch of loadSystemInfo() wrote the error text into the missing element, which threw a TypeError
  const app = await openApp(harness, { tv: { tv: 'fhd' } });
  try {
    const result = await app.page.evaluate(() => {
      document.getElementById('systemInfoBtn').remove();
      try {
        loadSystemInfo();
        return 'no exception';
      } catch (error) {
        return String(error);
      }
    });
    assert.equal(result, 'no exception');
    assert.ok(app.logs.some((line) => line.indexOf('Failed to load system information, since its element is missing!') >= 0));
    // A later translation pass runs its callbacks without an exception, including the one after loadSystemInfo() that
    // labels the unsupported resolutions
    await app.page.evaluate(() => window.i18n.refreshUI());
    assert.equal((await readUnsupportedResolutions(app.page))[0].label, '2560 x 1440 (1440p) [Unsupported]');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Support dialog leads to the guide and the issue tracker of Moonlight Plus, also in pt-BR', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' } });
  const { page } = app;
  try {
    await page.evaluate(() => $('#supportBtn').trigger('click'));
    const dialog = await page.evaluate(() => ({
      open: document.getElementById('appSupportDialog').open,
      title: document.getElementById('appSupportDialogTitle').textContent.trim(),
      text: document.getElementById('appSupportDialogText').textContent.replace(/\s+/g, ' ').trim(),
      qrWidth: document.getElementById('supportQrCode').naturalWidth,
    }));
    assert.equal(dialog.open, true);
    assert.equal(dialog.title, 'Moonlight Plus Support');
    assert.ok(dialog.text.indexOf('Please report problems with Moonlight Plus on its issue tracker on GitHub, not to Moonlight Tizen.') >= 0, dialog.text);
    assert.ok(dialog.text.indexOf('Scan the QR code below to open the guide of Moonlight Plus') >= 0, dialog.text);
    assert.ok(dialog.qrWidth > 0, 'the QR code loads');
    await page.evaluate(() => window.i18n.setLanguage('pt-BR'));
    const translated = await page.evaluate(() => document.getElementById('appSupportDialogTitle').textContent.trim());
    assert.equal(translated, 'Suporte do Moonlight Plus');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('turning the game mode on on Tizen 9.0 points to the guide of Moonlight Plus instead of the upstream wiki', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  const { page } = app;
  try {
    await page.evaluate(() => $('#gameModeSwitch').trigger('click'));
    await page.waitForFunction(() => isDialogOpen && document.getElementById('warningDialogTitle').textContent === 'Compatibility Warning', null, { timeout: 3000 });
    const text = await page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
    assert.ok(text.indexOf('see <b>ForceGM variant and game mode</b> in the guide of Moonlight Plus, which the Support button at the top of the screen links to.') >= 0, text);
    assert.ok(!/wiki/i.test(text), text);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
