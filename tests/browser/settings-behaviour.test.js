'use strict';

// Pins how the video settings react to changes on the settings screen (from the earlier rounds of fixes): the bitrate
// presets, which are the recommended bitrates since 2.2.0, and when they follow the resolution and frame rate, the 5 /
// 0.5 Mbps steps of the bitrate menu, the Ethernet limit of the presets, and the one-shot hints and warnings (90 FPS,
// H.264 above 1080p, codec fallbacks, AV1).

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readVideoSettings, reloadApp, startHarness } = require('./harness');

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

// Pick a menu entry like a click does
function pickResolution(page, value) {
  return page.evaluate((resolution) => saveResolution.call($('.videoResolutionMenu li[data-value="' + resolution + '"]')[0]), value);
}
function pickFrameRate(page, value) {
  return page.evaluate((frameRate) => saveFramerate.call($('.videoFramerateMenu li[data-value="' + frameRate + '"]')[0]), String(value));
}

test('over Ethernet the presets stop at 75 Mbps, the recommendation for the port, without a notice', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'ethernet' } });
  try {
    await app.page.evaluate(() => setAutoAdjustBitrate(true));
    await pickFrameRate(app.page, 120);
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.frameRate], ['75', '120']);
    assert.equal(count(app, 'has been limited to'), 0);
    assert.equal(count(app, 'Samsung TVs usually have a 100 Mbps Ethernet port'), 0, 'no warning about the port either');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the switch of the optimized presets is gone, and the codec and HDR leave the bitrate as it is', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    assert.deepEqual(await app.page.evaluate(() => [document.getElementById('optimizeBitrateBtn'), typeof saveOptimizeBitrate]), [null, 'undefined']);
    assert.equal(await app.page.evaluate(() => Views.AdvancedSettings.view.func().indexOf('optimizeBitrateBtn')), -1);
    let shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.autoAdjustBitrate, shown.bitrate, shown.hdr], [true, '100', true]);
    // H.264 turns HDR off, which changed the optimized presets of 2.1.0, but not the recommended bitrate
    await app.page.evaluate(() => saveVideoCodec.call($('.videoCodecMenu li[data-value="H264"]')[0]));
    await app.page.waitForTimeout(400);
    shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.codec, shown.hdr, shown.bitrate], ['H264', false, '100']);
    assert.equal(count(app, 'H.264 has no HDR, so HDR is off.'), 1);
    assert.equal(count(app, 'Keeping your bitrate of'), 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('1800p has its own presets, and 90 FPS shows its cadence hint after each switch to it', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => setAutoAdjustBitrate(true));
    await pickResolution(app.page, '3200:1800');
    let shown = await readVideoSettings(app.page);
    // 25 % above the standard 1800p presets over Wi-Fi (60 and 90 Mbps), within the decoder cap of 100 Mbps
    assert.deepEqual([shown.resolution, shown.bitrate], ['3200:1800', '75']);
    assert.ok(shown.resolutionLabel.indexOf('1800p') >= 0, shown.resolutionLabel);
    await pickFrameRate(app.page, 120);
    shown = await readVideoSettings(app.page);
    assert.equal(shown.bitrate, '100', 'the 1800p 120 FPS preset at the decoder cap');
    const hints = () => count(app, '90 FPS does not divide');
    await pickFrameRate(app.page, 90);
    assert.equal(hints(), 1, 'after 120 -> 90');
    await pickFrameRate(app.page, 60);
    await pickFrameRate(app.page, 90);
    assert.equal(hints(), 2, 'again after 60 -> 90');
  } finally {
    await app.context.close();
  }
});

test('a hand-picked bitrate is kept when the video settings change, with one notice that names the recommended one', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    // The bitrate of a fresh install follows the presets (plan D9) until it is picked by hand
    await app.page.evaluate(() => {
      $('#bitrateSlider')[0].MaterialSlider.change('62');
      $('#bitrateSlider').trigger('input');
    });
    let shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.autoAdjustBitrate, shown.bitrate], [false, '62']);
    // Record the translated messages that the snackbar is asked to show
    await app.page.evaluate(() => {
      const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
      const show = snackbar.showSnackbar.bind(snackbar);
      window.__snackbarMessages = [];
      snackbar.showSnackbar = (data) => {
        window.__snackbarMessages.push(data.message);
        show(data);
      };
    });
    await pickFrameRate(app.page, 120);
    await pickFrameRate(app.page, 60);
    await pickResolution(app.page, '3200:1800');
    shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.frameRate, shown.resolution], ['62', '60', '3200:1800']);
    assert.equal(count(app, 'Keeping your bitrate of'), 1);
    // The notice names the recommended bitrate of the selection it appeared for (4K at 120 FPS: the decoder cap)
    const messages = await app.page.evaluate(() => window.__snackbarMessages);
    assert.deepEqual(messages.filter((message) => message.indexOf('Keeping your bitrate of') === 0), [
      'Keeping your bitrate of 62 Mbps (recommended for these video settings: 100 Mbps). After the optimal settings button, the bitrate follows the video settings again.',
    ]);
  } finally {
    await app.context.close();
  }
});

test('the notice about a kept bitrate names the preset of this TV, also on a Full HD TV, and the button applies it again', async () => {
  const app = await openApp(harness, { tv: { tv: 'fhd', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      $('#bitrateSlider')[0].MaterialSlider.change('25');
      $('#bitrateSlider').trigger('input');
    });
    let shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.autoAdjustBitrate, shown.bitrate, shown.resolution], [false, '25', '1920:1080']);
    await app.page.evaluate(() => {
      const snackbar = document.querySelector('#snackbar').MaterialSnackbar;
      const show = snackbar.showSnackbar.bind(snackbar);
      window.__snackbarMessages = [];
      snackbar.showSnackbar = (data) => {
        window.__snackbarMessages.push(data.message);
        show(data);
      };
    });
    await pickFrameRate(app.page, 30);
    const messages = await app.page.evaluate(() => window.__snackbarMessages);
    assert.deepEqual(messages.filter((message) => message.indexOf('Keeping your bitrate of') === 0), [
      'Keeping your bitrate of 25 Mbps (recommended for these video settings: 13 Mbps). After the optimal settings button, the bitrate follows the video settings again.',
    ]);
    assert.equal((await readVideoSettings(app.page)).bitrate, '25');
    // The button applies 1080p at 60 FPS and its bitrate, which then follows the frame rate: 13 Mbps at 30 FPS, as named
    await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    await app.page.evaluate(() => $('#continueWarning').trigger('click'));
    await pickFrameRate(app.page, 30);
    shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.autoAdjustBitrate, shown.bitrate, shown.frameRate], [true, '13', '30']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('on a TV without a tested profile a preset stays within the decoder cap and the limit of an unknown connection, without a notice', async () => {
  for (const conn of ['wifi', 'unknown']) {
    const app = await openApp(harness, { tv: { tv: 'uhd', conn } });
    try {
      await app.page.evaluate(() => {
        setAutoAdjustBitrate(true);
        document.querySelector('#unlockAllFpsBtn').MaterialSwitch.on();
        handleUnlockAllFps();
      });
      await pickFrameRate(app.page, 90);
      let shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.bitrate, shown.frameRate], ['80', '90'], conn + ': the 4K 90 FPS preset of 100 Mbps is limited to the decoder cap');
      await pickFrameRate(app.page, 144);
      await pickResolution(app.page, '3200:1800');
      shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.bitrate, shown.resolution], ['80', '3200:1800'], conn + ': 1800p at 144 FPS');
      await pickResolution(app.page, '2560:1440');
      // 1440p at 144 FPS: 25 % above the standard preset of 70 Mbps over Wi-Fi, up to the cap, and the preset itself
      // without a detected connection
      assert.equal((await readVideoSettings(app.page)).bitrate, conn === 'wifi' ? '80' : '70', conn + ': the 1440p 144 FPS preset');
      assert.equal(count(app, 'has been limited to'), 0, conn);
      assert.equal(count(app, 'exceed what is recommended for the video decoder of this TV'), 0, conn + ': no bitrate warning');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the bitrate menu steps 5 Mbps with UP/DOWN and 0.5 Mbps with LEFT/RIGHT, within 0.5 to 150 Mbps', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const bitrate = async () => (await readVideoSettings(app.page)).bitrate;
    await app.page.evaluate(() => {
      setAutoAdjustBitrate(true);
      Views.SelectBitrateMenu.up();
      Views.SelectBitrateMenu.up();
      Views.SelectBitrateMenu.right();
    });
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.bitrateLabel], ['110.5', '110.5 Mbps']);
    assert.equal(shown.autoAdjustBitrate, false, 'a change by hand keeps the bitrate from now on');
    await app.page.evaluate(() => {
      Views.SelectBitrateMenu.down();
      Views.SelectBitrateMenu.left();
    });
    assert.equal(await bitrate(), '105');
    await app.page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        Views.SelectBitrateMenu.up();
      }
    });
    assert.equal(await bitrate(), '150');
    await app.page.evaluate(() => {
      $('#bitrateSlider')[0].MaterialSlider.change('3');
      for (let i = 0; i < 3; i++) {
        Views.SelectBitrateMenu.down();
      }
    });
    assert.equal(await bitrate(), '0.5');
  } finally {
    await app.context.close();
  }
});

test('re-selecting the current resolution keeps the bitrate, and the preset state survives a restart', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      $('#bitrateSlider')[0].MaterialSlider.change('100');
      saveBitrate();
      setAutoAdjustBitrate(true);
      saveResolution.call($('.videoResolutionMenu li[data-value="3200:1800"]')[0]);
    });
    assert.equal((await readVideoSettings(app.page)).bitrate, '75', 'a new resolution applies its preset');
    await app.page.evaluate(() => {
      $('#bitrateSlider')[0].MaterialSlider.change('100');
      saveBitrate();
      saveResolution.call($('.videoResolutionMenu li[data-value="3200:1800"]')[0]);
    });
    assert.equal((await readVideoSettings(app.page)).bitrate, '100', 'the same resolution again changes nothing');
    await app.page.waitForTimeout(300);
    await reloadApp(app);
    assert.equal(await app.page.evaluate(() => autoAdjustBitrate), true);
    // The optimal settings of the button keep the bitrate following the presets
    await app.page.evaluate(() => applyOptimalStreamingSettings('wifi'));
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.autoAdjustBitrate, shown.bitrate], [true, '100']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('H.264 above 1080p warns, and the warning fires again after the optimal settings button reset the codec', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const warnings = () => count(app, 'decode H.264 only up to 1080p');
    await app.page.evaluate(() => updateVideoCodec('#h264', 'H264'));
    assert.equal(warnings(), 1);
    await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    await app.page.evaluate(() => $('#continueWarning').trigger('click'));
    await app.page.evaluate(() => updateVideoCodec('#h264', 'H264'));
    assert.equal(warnings(), 2);
  } finally {
    await app.context.close();
  }
});

test('a stored H.264 codec meets the 4K default: warning at startup, and HDR stays off', async () => {
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    stored: { uniqueid: '0123456789abcdef', cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' }, videoCodec: 'H264' },
  });
  try {
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.codec, shown.resolution, shown.hdr], ['H264', '3840:2160', false]);
    assert.equal(count(app, 'decode H.264 only up to 1080p'), 1);
  } finally {
    await app.context.close();
  }
});

test('codec fallbacks of the module show a notice, and AV1 shows its reworded warning', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      handleMessage('CodecFallbackMsg: HEVC');
      handleMessage('CodecFallbackMsg: H264');
      handleMessage('CodecFallbackMsg: SDR');
      handleMessage('CodecFallbackMsg: bogus');
    });
    assert.equal(count(app, 'so the stream uses HEVC instead.'), 1);
    assert.equal(count(app, 'so the stream uses H.264 instead'), 1);
    assert.equal(count(app, 'so the stream runs without HDR.'), 1);
    assert.equal(app.logs.filter((line) => line.indexOf('snackbarLog') >= 0 && line.indexOf('bogus') >= 0).length, 0, 'an unknown value is ignored');
    await app.page.evaluate(() => saveVideoCodec.call($('.videoCodecMenu li[data-value="AV1"]')[0]));
    await app.page.waitForTimeout(300);
    assert.equal(count(app, 'AV1 needs a host GPU with an AV1 encoder'), 1);
    const portuguese = await app.page.evaluate(() => fetch('static/locales/pt-BR.json').then((response) => response.json()));
    assert.ok(portuguese["The host PC can't encode the selected codec, so the stream uses HEVC instead."].indexOf('HEVC') >= 0);
    assert.ok(portuguese["The host PC can't encode 10-bit video with this codec, so the stream runs without HDR."].indexOf('HDR') >= 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
