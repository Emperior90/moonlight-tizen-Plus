'use strict';

// Checks the test setup itself (the simulated TV and the stub of the WebAssembly module, see mocks/), and pins what the
// UI derives directly from the TV: the System information text (which since plan WP3 also shows what the app detected:
// panel, HDR, connection type, tested profile and the model year hint) and the resolutions marked as unsupported.

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

// Return the resolutions that the menu marks as unsupported, with their disabled state and label
async function unsupportedResolutionsOn(tvOptions) {
  const app = await openApp(harness, { tv: tvOptions });
  try {
    return await app.page.evaluate(() => $('.videoResolutionMenu li.unsupported-resolution').map(function() {
      return { value: String($(this).data('value')), disabled: $(this).attr('disabled') === 'disabled', label: $(this).text().trim() };
    }).get());
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

test('the unsupported resolutions keep their [Unsupported] label', {
  todo: 'Found while writing the tests: the first translation pass of i18n.js rewrites the menu items and drops the label',
}, async () => {
  const fhd = await unsupportedResolutionsOn({ tv: 'fhd' });
  assert.deepEqual(fhd.map((item) => item.label), [
    '2560 x 1440 (1440p) [Unsupported]',
    '3200 x 1800 (1800p) [Unsupported]',
    '3840 x 2160 (4K) [Unsupported]',
  ]);
});

// Read the System information as text (innerText turned the line breaks into <br> elements)
function readSystemInfo(page) {
  return page.evaluate(() => document.getElementById('systemInfoBtn').innerHTML.replace(/<br\s*\/?>/g, '\n'));
}

test('System information shows the app, the model strings and what the app detected about the TV (plan WP3)', async () => {
  const expected = [
    {
      tv: { tv: 's90c', conn: 'ethernet' },
      lines: [
        'App Version: Moonlight S90C v1.19.0',
        'Platform Version: Tizen 9.0',
        'TV Model Series: 23_PONTUSM_OLED',
        'TV Model Name: QE55S90CAT',
        'TV Model Group: 23_PONTUSM',
        'Model Year (from the model group): 2023',
        'Panel: 4K',
        'HDR Support: Yes',
        'Network Connection Type: Ethernet',
        'Tested Profile: S90C',
      ],
    },
    {
      tv: { tv: 'fhd', conn: 'wifi' },
      lines: [
        'App Version: Moonlight S90C v1.19.0',
        'Platform Version: Tizen 5.5',
        'TV Model Series: 20_KANTM2_FHD',
        'TV Model Name: UE43T5300AU',
        'TV Model Group: 20_KANTM2',
        'Model Year (from the model group): 2020',
        'Panel: Full HD',
        'HDR Support: No',
        'Network Connection Type: Wi-Fi',
        'Tested Profile: None',
      ],
    },
    {
      tv: { tv: '8k', conn: 'unknown', modelCode: 'NOYEAR' },
      lines: [
        'App Version: Moonlight S90C v1.19.0',
        'Platform Version: Tizen 6.5',
        'TV Model Series: 22_PONTUSM_8K',
        'TV Model Name: QE65QN900BT',
        'TV Model Group: NOYEAR',
        'Model Year (from the model group): Unknown',
        'Panel: 8K',
        'HDR Support: Yes',
        'Network Connection Type: Unknown',
        'Tested Profile: None',
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
