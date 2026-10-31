'use strict';

// The 'Optimal settings for this TV' button and its dialog on the settings screen:
// - the dialog shows exactly what Apply then applies and shows (the tiles the resolution, frame rate, bitrate and codec,
//   the text the other settings, without repeating the tiles), and its 'Detected:' line, which ends with 'tested model'
//   for a tested profile, matches what the app detected, on TVs with and without a tested profile, HDR, a 4K or 8K
//   panel, and over every connection; its buttons are Apply and Cancel, and the other warnings keep Close and Continue
// - the bitrate advice over Wi-Fi stays within the decoder cap, where the bitrate warning starts
// - the button is the first item of the basic settings, and the remote reaches it, opens the dialog and gets back to it
// The values themselves are pinned in video-defaults.test.js; this file checks that the text and the settings agree.

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readVideoSettings, startHarness, waitForStorage } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Count the log lines that contain the text
const count = (app, text) => app.logs.filter((line) => line.indexOf(text) >= 0).length;

const FAILING_PRODUCT_APIS = [
  'tizen.systeminfo.getCapability',
  'webapis.productinfo.getModel',
  'webapis.productinfo.getRealModel',
  'webapis.productinfo.getModelCode',
  'webapis.productinfo.isUdPanelSupported',
  'webapis.avinfo',
].join(',');

// Simulated TVs (tests/browser/mocks/tv-mock.js) whose dialog is compared with what Continue applies
const DIALOG_TVS = {
  's90c': { tv: 's90c' },
  's90c before the Tizen 9.0 update': { tv: 's90c', tizen: '7.0' },
  'S90C found by its model series': { tv: 'uhd', model: 'UNKNOWN', series: '23_S90C_OLED' },
  'uhd': { tv: 'uhd' },
  'uhd without HDR': { tv: 'uhd', hdr: 0 },
  'fhd': { tv: 'fhd' },
  'fhd with HDR on Tizen 6.0': { tv: 'fhd', hdr: 1, tizen: '6.0' },
  '8k': { tv: '8k' },
  'TV whose product APIs fail': { tv: 's90c', failApis: FAILING_PRODUCT_APIS },
};

// Open the dialog of the button and read its title, text (split into lines without the list bullets), value tiles and
// buttons
async function openDialog(page) {
  await page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
  const dialog = await page.evaluate(() => ({
    title: document.getElementById('warningDialogTitle').innerHTML,
    text: document.getElementById('warningDialogText').innerHTML,
    open: isDialogOpen,
    tiles: Array.prototype.map.call(document.querySelectorAll('#warningDialogValues .value-tile'), (tile) =>
      [tile.querySelector('.value-number').textContent, tile.querySelector('.value-unit').textContent]),
    tilesHidden: document.getElementById('warningDialogValues').getAttribute('aria-hidden'),
    buttons: [$('#closeWarning').text().trim(), $('#continueWarning').text().trim()],
  }));
  dialog.lines = dialog.text.split('<br>').map((line) => line.replace(/^• /, ''));
  return dialog;
}

// The line of the dialog that starts with the prefix, without the prefix, or null
function lineAfter(dialog, prefix) {
  const line = dialog.lines.find((entry) => entry.indexOf(prefix) === 0);
  return line === undefined ? null : line.slice(prefix.length);
}

// What index.js detected about the simulated TV, as the dialog should describe it
function readDetected(page) {
  return page.evaluate(() => ({
    modelName,
    panel: is8kPanel ? '8K panel' : (is4kPanel ? '4K panel' : 'Full HD panel'),
    hdr: isHdrCapable ? 'HDR' : 'no HDR',
    tizen: platformVer ? 'Tizen ' + platformVer : 'unknown Tizen version',
    connection: { ethernet: 'Ethernet', wifi: 'Wi-Fi', unknown: 'unknown connection' }[getActiveConnectionType()],
    tested: !!tvCapabilities.profile,
  }));
}

// Move the bitrate slider by hand, like the user does in the bitrate menu
function setBitrateByHand(page, bitrate) {
  return page.evaluate((value) => {
    $('#bitrateSlider')[0].MaterialSlider.change(value);
    $('#bitrateSlider').trigger('input');
  }, String(bitrate));
}

describe('the dialog shows exactly what Apply applies', { concurrency: 3 }, () => {
  for (const tvName of Object.keys(DIALOG_TVS)) {
    for (const conn of ['ethernet', 'wifi', 'unknown']) {
      test(`${tvName} over ${conn}`, async () => {
        const app = await openApp(harness, { tv: Object.assign({ conn }, DIALOG_TVS[tvName]) });
        try {
          const detected = await readDetected(app.page);
          const dialog = await openDialog(app.page);
          assert.equal(dialog.open, true);
          assert.equal(dialog.title, detected.modelName ? `Optimal settings for this TV (${detected.modelName})` : 'Optimal settings for this TV');
          assert.equal(lineAfter(dialog, 'Detected: '),
            [detected.panel, detected.hdr, detected.tizen, detected.connection].concat(detected.tested ? ['tested model'] : []).join(', '), dialog.text);
          // The text doesn't repeat the tiles any more (resolution, codec and bitrate had a line each until 2.1.0)
          ['Tested model', 'Video resolution', 'Video codec', 'Video bitrate'].forEach((prefix) => {
            assert.equal(dialog.lines.some((line) => line.indexOf(prefix) === 0), false, prefix + ': ' + dialog.text);
          });
          // At most 6 lines of text (2.1.0 had up to 10 under the tiles)
          assert.ok(dialog.lines.filter((line) => line).length <= 6, dialog.text);
          assert.equal(dialog.tilesHidden, null, 'screen readers read the tiles');
          assert.deepEqual(dialog.buttons, ['Cancel', 'Apply']);
          const listed = {
            settings: dialog.lines.find((line) => line.indexOf('Video frame pacing ') === 0),
            gameMode: dialog.lines.indexOf('Ultra low latency mode on') >= 0,
            hint120Hz: dialog.text.indexOf('If this TV has a 120 Hz panel, you can turn on') >= 0,
          };

          await app.page.evaluate(() => $('#continueWarning').trigger('click'));
          const shown = await readVideoSettings(app.page);
          assert.deepEqual(dialog.tiles, [
            [shown.resolution === '3840:2160' ? '4K' : shown.resolution.split(':')[1] + 'p', shown.resolution.replace(':', ' x ')],
            [shown.frameRate, 'FPS'],
            [shown.bitrate, 'Mbps'],
            ['HEVC', shown.hdr ? 'HDR' : 'no HDR'],
          ]);
          assert.equal(shown.codec, 'HEVC');
          assert.equal(listed.settings, [
            'Video frame pacing ' + (shown.framePacing ? 'on' : 'off'),
            shown.fullRange ? 'full color range' : 'limited color range',
            'unlock all frame rates ' + (shown.unlockAllFps ? 'on' : 'off'),
          ].join(', '));
          assert.equal(listed.gameMode, shown.gameMode, 'the line of the ultra low latency mode names a mode that is on');
          // A 4K or 8K TV whose higher frame rates stay locked is told how to unlock them for a 120 Hz panel, since the app can't detect the refresh rate of the panel
          assert.equal(listed.hint120Hz, !shown.unlockAllFps && detected.panel !== 'Full HD panel', dialog.text);
          // After the button, the bitrate follows the resolution and frame rate with the presets again (2.2.0)
          assert.equal(shown.autoAdjustBitrate, true);
          const stored = await waitForStorage(app.page, (values) => values.autoAdjustBitrate === true && values.bitrate === shown.bitrate);
          // The other warnings get their buttons back
          assert.deepEqual(await app.page.evaluate(() => [$('#closeWarning').text().trim(), $('#continueWarning').text().trim()]), ['Close', 'Continue']);
          assert.equal(stored.resolution, shown.resolution);
          assert.ok(app.logs.some((line) => line.indexOf('The optimal streaming settings for this TV have been applied.') >= 0));
          assert.deepEqual(app.errors, []);
        } finally {
          await app.context.close();
        }
      });
    }
  }
});

test('the bitrate advice over Wi-Fi stays within the decoder cap, where the bitrate warning of the TV starts', async () => {
  const warning = 'exceed what is recommended for the video decoder of this TV';
  // Per TV: the decoder cap, and the advice (null when the applied bitrate already reaches the cap)
  const expected = { s90c: [100, null], uhd: [80, null], '8k': [80, null], fhd: [50, 40] };
  for (const tvName of Object.keys(expected)) {
    const [cap, advisedLimit] = expected[tvName];
    const app = await openApp(harness, { tv: { tv: tvName, conn: 'wifi' } });
    try {
      const dialog = await openDialog(app.page);
      await app.page.evaluate(() => $('#continueWarning').trigger('click'));
      const applied = parseFloat((await readVideoSettings(app.page)).bitrate);
      const raise = /you can raise the bitrate up to ([\d.]+) Mbps\./.exec(dialog.text);
      const atLimit = dialog.text.indexOf('This is the highest bitrate recommended for the video decoder of this TV') >= 0;
      assert.equal(raise ? parseFloat(raise[1]) : null, advisedLimit, tvName + ': ' + dialog.text);
      assert.equal(atLimit, advisedLimit === null, tvName + ': ' + dialog.text);
      assert.equal(atLimit, applied === cap, tvName + ': the applied bitrate reaches the cap');
      // No warning up to the advised bitrate and the cap, and the warning right above the cap
      await setBitrateByHand(app.page, advisedLimit === null ? applied : advisedLimit);
      await setBitrateByHand(app.page, cap);
      assert.equal(count(app, warning), 0, tvName + ': no warning up to ' + cap + ' Mbps');
      await setBitrateByHand(app.page, cap + 0.5);
      assert.equal(count(app, warning), 1, tvName + ': the warning starts right above ' + cap + ' Mbps');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the button is the first of the basic settings, with its generic label and help text', async () => {
  const app = await openApp(harness, { tv: { tv: 'fhd', conn: 'wifi' } });
  try {
    const button = await app.page.evaluate(() => {
      const option = $('#optimalSettingsBtn').closest('.setting-option');
      return {
        label: option.find('label > span').first().text().trim(),
        help: option.find('.mdl-list__item-text-body').text().trim(),
        ariaLabel: $('#optimalSettingsBtn').attr('aria-label'),
        text: $('#optimalSettingsBtn').text().trim(),
        navigationItems: Views.BasicSettings.view.func(),
        firstOption: $('#basicSettings .setting-option').first().find('button').attr('id'),
      };
    });
    assert.deepEqual(button, {
      label: 'Optimal settings for this TV',
      help: '- Applies the best image quality this TV supports (its highest resolution up to 4K, HEVC, and HDR if the TV supports it) with a bitrate that matches its network connection.',
      ariaLabel: 'Apply the optimal settings for this TV',
      text: 'Apply the optimal streaming settings for this TV',
      // 'Unlock all frame rates' right below the frame rate that it extends (frame pacing is in the Video Settings)
      navigationItems: ['optimalSettingsBtn', 'selectResolution', 'selectFramerate', 'unlockAllFpsBtn', 'selectBitrate'],
      firstOption: 'optimalSettingsBtn',
    });
  } finally {
    await app.context.close();
  }
});

describe('the remote reaches the button', { concurrency: 2 }, () => {
  // The id of the focused element
  const focused = (page) => page.evaluate(() => (document.activeElement ? document.activeElement.id : ''));
  // Wait until the element with the id has the focus
  const waitForFocus = (page, id) => page.waitForFunction((elementId) => document.activeElement && document.activeElement.id === elementId, id, { timeout: 3000 });

  // Open the settings and the basic settings with the remote, like a user does from the hosts view
  async function openBasicSettings(page) {
    await page.evaluate(() => $('#settingsBtn').trigger('click'));
    // showSettings() shows the settings after its loading screen of 500 ms
    await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await page.waitForTimeout(100);
    // The first category (basic settings) is selected, and ENTER opens it
    await page.keyboard.press('Enter');
    // navigateSettingsView() moves the focus to the first option after 250 ms
    await waitForFocus(page, 'optimalSettingsBtn');
  }

  for (const tvName of ['s90c', 'fhd']) {
    test(`${tvName}: ENTER opens the dialog, RIGHT and ENTER close it, and the focus returns to the button`, async () => {
      const app = await openApp(harness, { tv: { tv: tvName, conn: 'wifi' } });
      try {
        await openBasicSettings(app.page);
        assert.equal(await focused(app.page), 'optimalSettingsBtn');
        const before = await readVideoSettings(app.page);

        await app.page.keyboard.press('Enter');
        await app.page.waitForFunction(() => isDialogOpen === true);
        assert.ok((await app.page.evaluate(() => document.getElementById('warningDialogTitle').innerHTML)).indexOf('Optimal settings for this TV') === 0);
        // Apply gets the focus (the view of the dialog moves it there about 100 ms after the dialog opened it on
        // Cancel), and RIGHT moves it to Cancel
        await waitForFocus(app.page, 'continueWarning');
        await app.page.keyboard.press('ArrowRight');
        assert.equal(await focused(app.page), 'closeWarning');
        await app.page.keyboard.press('Enter');
        await app.page.waitForFunction(() => isDialogOpen === false);
        assert.equal(await focused(app.page), 'optimalSettingsBtn');
        assert.deepEqual(await readVideoSettings(app.page), before, 'Cancel keeps the settings');

        // DOWN and UP move through the basic settings in their order
        await app.page.keyboard.press('ArrowDown');
        assert.equal(await focused(app.page), 'selectResolution');
        await app.page.keyboard.press('ArrowUp');
        assert.equal(await focused(app.page), 'optimalSettingsBtn');
        assert.deepEqual(app.errors, []);
      } finally {
        await app.context.close();
      }
    });
  }

  test('ENTER on Apply applies the settings and returns the focus to the button', async () => {
    const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' } });
    try {
      await setBitrateByHand(app.page, 33);
      await openBasicSettings(app.page);
      await app.page.keyboard.press('Enter');
      await app.page.waitForFunction(() => isDialogOpen === true);
      await waitForFocus(app.page, 'continueWarning');
      await app.page.keyboard.press('Enter');
      await app.page.waitForFunction(() => isDialogOpen === false);
      assert.equal(await focused(app.page), 'optimalSettingsBtn');
      const shown = await readVideoSettings(app.page);
      // The bitrate picked by hand (33 Mbps) follows the presets again after the button
      assert.deepEqual([shown.resolution, shown.bitrate, shown.autoAdjustBitrate], ['3840:2160', '80', true]);
      assert.ok(app.logs.some((line) => line.indexOf('The optimal streaming settings for this TV have been applied.') >= 0));
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  });
});

test('in pt-BR the dialog has no English line: tested S90C on Tizen 9.0, an HDR TV on Tizen 6.5, an unknown connection', async () => {
  // English texts that stayed untranslated next to translated lines before
  const ENGLISH = ['Video frame pacing on', 'Ultra low latency mode', 'tested model', 'could not be detected', 'Detected:', 'The following'];
  for (const tv of [{ tv: 's90c', conn: 'wifi' }, { tv: 'uhd', conn: 'unknown' }, { tv: 'fhd', conn: 'ethernet', wasmPlayer: 'ull' }]) {
    const app = await openApp(harness, { tv });
    try {
      await app.page.evaluate(() => window.i18n.setLanguage('pt-BR'));
      if (tv.wasmPlayer) {
        // Tizen 5.5 with the Ultra Low Latency mode: a mode that is on gets the line that Apply turns it off
        await app.page.evaluate(() => $('#gameModeSwitch').trigger('click'));
        await waitForStorage(app.page, (values) => values.gameMode === true);
      }
      const dialog = await openDialog(app.page);
      const label = JSON.stringify(tv) + ': ' + dialog.text + ' ' + dialog.buttons.join(' ');
      ENGLISH.forEach((text) => assert.ok(dialog.text.indexOf(text) < 0, text + ' in ' + label));
      assert.deepEqual(dialog.buttons, ['Cancelar', 'Aplicar'], label);
      if (tv.tv === 's90c') {
        assert.equal(lineAfter(dialog, 'Detectado: '), 'painel 4K, HDR, Tizen 9.0, Wi-Fi, modelo testado', label);
        assert.ok(dialog.lines.indexOf('Ajuste de ritmo de quadros ativado, faixa de cores limitada, desbloquear todas as taxas de quadros ativado') >= 0, label);
        assert.ok(dialog.text.indexOf('O modo de latência ultrabaixa fica desativado no Tizen 9.0, então instale a variante ForceGM para a menor latência.') >= 0, label);
      } else if (tv.tv === 'uhd') {
        assert.ok(dialog.lines.indexOf('Modo de latência ultrabaixa ligado') >= 0, label);
        assert.ok(dialog.text.indexOf('Não foi possível detectar o tipo de conexão de rede da TV') >= 0, label);
      } else {
        assert.ok(dialog.lines.indexOf('Modo de latência ultrabaixa desligado') >= 0, label);
      }
      assert.deepEqual(app.errors, [], label);
    } finally {
      await app.context.close();
    }
  }
});
