'use strict';

// Pins how the video settings react to changes on the settings screen (from the earlier rounds of fixes): the bitrate
// presets and when they follow the resolution and frame rate, the 5 / 0.5 Mbps steps of the bitrate menu, the
// Ethernet limit of the presets, and the one-shot hints and warnings (90 FPS, H.264 above 1080p, codec fallbacks, AV1).

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

test('over Ethernet a preset above 75 Mbps is limited to 75 Mbps, with a notice', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'ethernet' } });
  try {
    await app.page.evaluate(() => setAutoAdjustBitrate(true));
    await pickFrameRate(app.page, 120);
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.frameRate], ['75', '120']);
    assert.equal(count(app, 'The bitrate has been limited to %1$s Mbps, because Samsung TVs usually have a 100 Mbps Ethernet port.'), 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('toggling the optimized presets makes the standard presets follow the video settings again', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      document.querySelector('#optimizeBitrateBtn').MaterialSwitch.on();
      saveOptimizeBitrate();
    });
    await app.page.waitForTimeout(300);
    await app.page.evaluate(() => {
      document.querySelector('#optimizeBitrateBtn').MaterialSwitch.off();
      saveOptimizeBitrate();
    });
    await app.page.waitForTimeout(300);
    const shown = await readVideoSettings(app.page);
    assert.equal(shown.autoAdjustBitrate, true);
    assert.equal(shown.bitrate, '80', 'the standard 4K 60 FPS preset');
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
    assert.deepEqual([shown.resolution, shown.bitrate], ['3200:1800', '60']);
    assert.ok(shown.resolutionLabel.indexOf('1800p') >= 0, shown.resolutionLabel);
    await pickFrameRate(app.page, 120);
    shown = await readVideoSettings(app.page);
    assert.equal(shown.bitrate, '90', 'the 1800p 120 FPS preset');
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

test('a recommended or hand-picked bitrate is kept when the video settings change, with one notice', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    // Since plan D9 the bitrate of a fresh install follows the presets, so the recommended bitrate comes from the button
    await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    await app.page.evaluate(() => $('#continueWarning').trigger('click'));
    let shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.autoAdjustBitrate, shown.bitrate], [false, '100']);
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
    assert.deepEqual([shown.bitrate, shown.frameRate, shown.resolution], ['100', '60', '3200:1800']);
    assert.equal(count(app, 'Keeping your bitrate of'), 1);
    assert.ok(app.logs.some((line) => line.indexOf('Keeping your bitrate of %1$s Mbps') >= 0 && / 100$/.test(line)));
    const messages = await app.page.evaluate(() => window.__snackbarMessages);
    assert.equal(messages.filter((message) => message.indexOf('Keeping your bitrate of 100 Mbps.') === 0).length, 1, JSON.stringify(messages));
  } finally {
    await app.context.close();
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
    assert.equal((await readVideoSettings(app.page)).bitrate, '60', 'a new resolution applies its preset');
    await app.page.evaluate(() => {
      $('#bitrateSlider')[0].MaterialSlider.change('100');
      saveBitrate();
      saveResolution.call($('.videoResolutionMenu li[data-value="3200:1800"]')[0]);
    });
    assert.equal((await readVideoSettings(app.page)).bitrate, '100', 'the same resolution again changes nothing');
    await app.page.waitForTimeout(300);
    await reloadApp(app);
    assert.equal(await app.page.evaluate(() => autoAdjustBitrate), true);
    // The optimal settings of the button switch back to keeping the recommended bitrate
    await app.page.evaluate(() => applyOptimalStreamingSettings('wifi'));
    const shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.autoAdjustBitrate, shown.bitrate], [false, '100']);
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
