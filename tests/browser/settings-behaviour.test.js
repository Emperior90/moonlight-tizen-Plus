'use strict';

// Pins how the video settings react to changes on the settings screen (from the earlier rounds of fixes): the bitrate
// presets, which are the recommended bitrates since 2.2.0, and when they follow the resolution and frame rate, the 5 /
// 0.5 Mbps steps of the bitrate menu up to 250 Mbps and a stored bitrate up there, the Ethernet limit of the presets,
// the frame rates up to 120 FPS (without the 144 FPS that 2.2.1 removed), and the one-shot hints and warnings (90 FPS,
// H.264 above 1080p and above 60 FPS, codec fallbacks, AV1).

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
    // The bitrate of a fresh install follows the presets until it is picked by hand
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
    // The notice names the recommended bitrate of the selection it appeared for (4K at 120 FPS: the decoder cap), and
    // that the button also resets the codec and the other video settings
    const messages = await app.page.evaluate(() => window.__snackbarMessages);
    assert.deepEqual(messages.filter((message) => message.indexOf('Keeping your bitrate of') === 0), [
      'Keeping your bitrate of 62 Mbps (recommended for these video settings: 100 Mbps). The optimal settings button lets the bitrate follow the video settings again, but it also resets the codec and the other video settings.',
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
      'Keeping your bitrate of 25 Mbps (recommended for these video settings: 13 Mbps). The optimal settings button lets the bitrate follow the video settings again, but it also resets the codec and the other video settings.',
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
      await pickFrameRate(app.page, 120);
      await pickResolution(app.page, '3200:1800');
      shown = await readVideoSettings(app.page);
      // 1800p at 120 FPS: 25 % above the standard preset of 90 Mbps over Wi-Fi, and the preset itself without a detected
      // connection, both limited to the cap
      assert.deepEqual([shown.bitrate, shown.resolution], ['80', '3200:1800'], conn + ': 1800p at 120 FPS');
      await pickResolution(app.page, '2560:1440');
      // 1440p at 120 FPS: 25 % above the standard preset of 60 Mbps over Wi-Fi, and the preset itself without a detected
      // connection, both within the cap
      assert.equal((await readVideoSettings(app.page)).bitrate, conn === 'wifi' ? '75' : '60', conn + ': the 1440p 120 FPS preset');
      assert.equal(count(app, 'has been limited to'), 0, conn);
      assert.equal(count(app, 'exceed what is recommended for the video decoder of this TV'), 0, conn + ': no bitrate warning');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the frame rate menu never offers 144 FPS: 90 and 120 FPS with the switch on, on the S90C and on TVs without a tested profile', async () => {
  // 2.2.1 removed 144 FPS, as upstream 7d8ab56 did, since the video player of Samsung TVs never starts it (upstream dd7dfdf)
  const options = (page) => page.evaluate(() => $('.videoFramerateMenu li').map(function() {
    return String($(this).data('value'));
  }).get());
  const unlock = (page, state) => page.evaluate((switchState) => {
    document.querySelector('#unlockAllFpsBtn').MaterialSwitch[switchState]();
    saveUnlockAllFps();
    handleUnlockAllFps();
  }, state);
  for (const [tv, unlockedByDefault] of [['s90c', true], ['uhd', false], ['fhd', false]]) {
    const app = await openApp(harness, { tv: { tv, conn: 'wifi' } });
    try {
      assert.deepEqual(await options(app.page), unlockedByDefault ? ['30', '60', '90', '120'] : ['30', '60'], tv + ': default');
      for (const [state, expected] of [['on', ['30', '60', '90', '120']], ['off', ['30', '60']], ['on', ['30', '60', '90', '120']], ['on', ['30', '60', '90', '120']]]) {
        await unlock(app.page, state);
        assert.deepEqual(await options(app.page), expected, tv + ': ' + state);
      }
      // 120 FPS is the highest, and the switch turned off goes back to 60 FPS from it, as before
      await pickFrameRate(app.page, 120);
      assert.equal((await readVideoSettings(app.page)).frameRate, '120', tv);
      await unlock(app.page, 'off');
      assert.equal((await readVideoSettings(app.page)).frameRate, '60', tv);
      // The optimal settings button sets 60 FPS and the switch of the TV
      await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
      await app.page.evaluate(() => $('#continueWarning').trigger('click'));
      const shown = await readVideoSettings(app.page);
      assert.deepEqual([shown.frameRate, shown.frameRateOptions], ['60', unlockedByDefault ? ['30', '60', '90', '120'] : ['30', '60']], tv + ': optimal');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the bitrate menu steps 5 Mbps with UP/DOWN and 0.5 Mbps with LEFT/RIGHT, within 0.5 to 250 Mbps', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const bitrate = async () => (await readVideoSettings(app.page)).bitrate;
    // The ends of the slider and their labels
    assert.deepEqual(await app.page.evaluate(() => [$('#bitrateSlider').attr('min'), $('#bitrateSlider').attr('max'),
      $('#bitrateSlider').attr('step'), $('#bitrateLowestValue').text(), $('#bitrateHighestValue').text()]), ['0.5', '250', '0.5', '0.5', '250']);
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
    assert.equal(await bitrate(), '205', 'past 150 Mbps, the end of the slider before 2.2.0');
    await app.page.evaluate(() => {
      for (let i = 0; i < 10; i++) {
        Views.SelectBitrateMenu.up();
      }
      Views.SelectBitrateMenu.right();
    });
    const top = await readVideoSettings(app.page);
    assert.deepEqual([top.bitrate, top.bitrateLabel], ['250', '250 Mbps'], 'no further than 250 Mbps');
    await app.page.evaluate(() => Views.SelectBitrateMenu.left());
    assert.equal(await bitrate(), '249.5');
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

test('a stored bitrate above 150 Mbps stays as it is at the start and after a restart, and a stream starts with it', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { bitrate: '200', autoAdjustBitrate: false } });
  try {
    let shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.bitrateLabel, shown.autoAdjustBitrate], ['200', '200 Mbps', false]);
    // A new resolution keeps the bitrate picked by hand, and the next start still shows it
    await pickResolution(app.page, '2560:1440');
    assert.equal((await readVideoSettings(app.page)).bitrate, '200');
    await app.page.waitForTimeout(300);
    await reloadApp(app);
    shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.bitrateLabel], ['200', '200 Mbps']);
    // 247.5 Mbps, picked by hand, is stored as it is and comes back after a restart
    await app.page.evaluate(() => {
      $('#bitrateSlider')[0].MaterialSlider.change('247.5');
      $('#bitrateSlider').trigger('input');
    });
    await app.page.waitForTimeout(300);
    await reloadApp(app);
    shown = await readVideoSettings(app.page);
    assert.deepEqual([shown.bitrate, shown.bitrateLabel], ['247.5', '247.5 Mbps']);
    // The start request of a stream carries it in kbps (startGame() in index.js)
    await app.page.evaluate(async () => {
      const host = {
        paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
        appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
        refreshServerInfo: () => Promise.resolve(),
        getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
        launchApp: () => Promise.resolve('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>'),
        toString: () => 'GAMING-PC',
      };
      api = host;
      startGame(host, 8);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    assert.equal(await app.page.evaluate(() => window.__startStreamArgs && window.__startStreamArgs[5]), '247500');
    assert.deepEqual(app.errors, []);
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

// The H.264 warnings (h264WarningKey() in tv_profile.js)
const H264_RESOLUTION_WARNING = 'This TV may not decode H.264 at this resolution and frame rate';
const H264_FRAME_RATE_WARNING = 'H.264 above 60 FPS may fail to start on Samsung TVs';

test('H.264 above level 5.1 warns, and the warning fires again after the optimal settings button reset the codec', async () => {
  // 4K at 60 FPS, the default of the S90C, is above H.264 level 5.1, the highest that the app offers to the TV
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const warnings = () => count(app, H264_RESOLUTION_WARNING);
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
    assert.equal(count(app, H264_RESOLUTION_WARNING), 1);
  } finally {
    await app.context.close();
  }
});

test('H.264 above 1080p warns only where the TV rejects level 5.1, which the app offers to the TV since 2.3.0', async () => {
  // The decoder check of the TV accepts H.264 at level 5.1 (codecs 'all'), or rejects it ('noH264Level51')
  for (const [codecs, expected] of [['all', 0], ['noH264Level51', 1]]) {
    const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', codecs } });
    try {
      await pickResolution(app.page, '2560:1440');
      await app.page.evaluate(() => updateVideoCodec('#h264', 'H264'));
      // 1440p and 4K at 30 FPS are within level 5.1
      await pickFrameRate(app.page, 30);
      await pickResolution(app.page, '3840:2160');
      assert.equal(count(app, H264_RESOLUTION_WARNING), expected, codecs);
      // 4K at 60 FPS is above it on every TV, also where the TV accepts level 5.1
      await pickFrameRate(app.page, 60);
      assert.equal(count(app, H264_RESOLUTION_WARNING), codecs === 'all' ? 1 : expected, codecs);
      // Up to 1080p nothing warns
      await pickResolution(app.page, '1920:1080');
      assert.equal(count(app, H264_FRAME_RATE_WARNING), 0, codecs);
      assert.deepEqual(app.errors, [], codecs);
    } finally {
      await app.context.close();
    }
  }
});

test('H.264 above 60 FPS warns at any resolution, also when the frame rate changes after the codec', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await pickResolution(app.page, '1280:720');
    await app.page.evaluate(() => updateVideoCodec('#h264', 'H264'));
    assert.equal(count(app, H264_FRAME_RATE_WARNING), 0);
    await pickFrameRate(app.page, 120);
    assert.equal(count(app, H264_FRAME_RATE_WARNING), 1);
    // Once per message: another frame rate above 60 FPS doesn't repeat it, and after 60 FPS it shows again
    await pickFrameRate(app.page, 90);
    assert.equal(count(app, H264_FRAME_RATE_WARNING), 1);
    await pickFrameRate(app.page, 60);
    await pickFrameRate(app.page, 120);
    assert.equal(count(app, H264_FRAME_RATE_WARNING), 2);
    // HEVC never warns
    await app.page.evaluate(() => updateVideoCodec('#hevc', 'HEVC'));
    await pickFrameRate(app.page, 90);
    assert.equal(count(app, H264_FRAME_RATE_WARNING), 2);
    assert.deepEqual(app.errors, []);
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
