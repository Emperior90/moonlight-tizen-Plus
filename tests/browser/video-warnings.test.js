'use strict';

// The warnings of the video settings on the settings screen (plan WP4), which come from the rules in
// wasm/platform/tv_profile.js (tests/unit/video-warnings.test.js checks the rules themselves):
// - a TV without a tested 120 Hz profile is told that many Samsung TVs have 60 Hz panels, that 4K at 90 or 120 FPS needs
//   a level 5.2 decoder, and that 4K at 144 FPS exceeds level 5.2; the S90C keeps its texts (plan section 3)
// - each warning shows once per selection, a selection with another warning shows that one right away
// - HDR switched on for a TV that doesn't report HDR warns, an HDR TV doesn't
// - the bitrate warning starts at the decoder cap of the TV and names it, also for a preset above the cap

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness, waitForStorage } = require('./harness');

const TEXTS = {
  fpsAbove60Hz: 'Warning: Many Samsung TVs have 60 Hz panels, and Tizen apps often show only about 60 FPS',
  needsLevel52: 'Warning: This resolution and frame rate need a video decoder with HEVC or AV1 Level 5.2',
  exceedsLevel52: 'Warning: This resolution and frame rate exceed HEVC and AV1 Level 5.2',
  testedDecoder: 'Warning: The video decoder of the TV supports 4K up to 120 FPS',
  lowerEnd: 'Warning: This resolution and frame rate may not perform well on lower-end devices or slower connections!',
  hdr: 'Warning: This TV does not report HDR support',
  decoderCap: 'Warning: Bitrates above %1$s Mbps exceed what is recommended for the video decoder of this TV',
};

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

// Count each warning of TEXTS in the log
function counts(app) {
  const result = {};
  Object.keys(TEXTS).forEach((name) => {
    result[name] = count(app, TEXTS[name]);
  });
  return result;
}

// The counts of TEXTS with the given ones set, and every other one 0
function only(expected) {
  const result = {};
  Object.keys(TEXTS).forEach((name) => {
    result[name] = expected[name] || 0;
  });
  return result;
}

// Pick a menu entry like a click does
function pickResolution(page, value) {
  return page.evaluate((resolution) => saveResolution.call($('.videoResolutionMenu li[data-value="' + resolution + '"]')[0]), value);
}
function pickFrameRate(page, value) {
  return page.evaluate((frameRate) => saveFramerate.call($('.videoFramerateMenu li[data-value="' + frameRate + '"]')[0]), String(value));
}

// Switch 'Unlock all frame rates' on, like the user does, so that the menu offers 90, 120 and 144 FPS
async function unlockAllFrameRates(page) {
  await page.evaluate(() => {
    document.querySelector('#unlockAllFpsBtn').MaterialSwitch.on();
    saveUnlockAllFps();
    handleUnlockAllFps();
  });
}

// Move the bitrate slider by hand, like the user does in the bitrate menu
function setBitrateByHand(page, bitrate) {
  return page.evaluate((value) => {
    $('#bitrateSlider')[0].MaterialSlider.change(value);
    $('#bitrateSlider').trigger('input');
  }, String(bitrate));
}

// Pick a low bitrate by hand, so that it stays when the resolution and frame rate change. Otherwise the bitrate of a
// fresh install follows the presets (plan D9), whose 120 or 140 Mbps at 4K above 60 FPS add the bitrate warning.
function keepBitrate(page) {
  return setBitrateByHand(page, 40);
}

test('a 4K TV without a tested profile: 60 Hz panels, level 5.2, and 4K at 144 FPS (cases 1 to 3)', async () => {
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' } });
  try {
    await keepBitrate(app.page);
    await unlockAllFrameRates(app.page);
    await pickFrameRate(app.page, 120);
    assert.deepEqual(counts(app), only({ needsLevel52: 1 }), '4K at 120 FPS');
    await pickFrameRate(app.page, 90);
    assert.deepEqual(counts(app), only({ needsLevel52: 1 }), '4K at 90 FPS has the same warning, which shows once');
    await pickFrameRate(app.page, 144);
    assert.deepEqual(counts(app), only({ needsLevel52: 1, exceedsLevel52: 1 }), '4K at 144 FPS');
    await pickResolution(app.page, '1920:1080');
    assert.deepEqual(counts(app), only({ needsLevel52: 1, exceedsLevel52: 1, fpsAbove60Hz: 1 }), '1080p at 144 FPS');
    await pickFrameRate(app.page, 60);
    await pickFrameRate(app.page, 120);
    assert.deepEqual(counts(app), only({ needsLevel52: 1, exceedsLevel52: 1, fpsAbove60Hz: 2 }), 'again after 60 FPS');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a Full HD TV is told about 60 Hz panels above 60 FPS', async () => {
  const app = await openApp(harness, { tv: { tv: 'fhd', conn: 'wifi' } });
  try {
    await keepBitrate(app.page);
    await unlockAllFrameRates(app.page);
    await pickFrameRate(app.page, 120);
    assert.deepEqual(counts(app), only({ fpsAbove60Hz: 1 }));
    await pickResolution(app.page, '1280:720');
    assert.deepEqual(counts(app), only({ fpsAbove60Hz: 1 }), 'the same warning shows once');
  } finally {
    await app.context.close();
  }
});

test('the S90C keeps its warnings: none at 1080p, lower-end devices at 4K up to 120 FPS, its decoder above (plan section 3)', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await keepBitrate(app.page);
    await pickResolution(app.page, '1920:1080');
    await pickFrameRate(app.page, 144);
    assert.deepEqual(counts(app), only({}), '1080p at 144 FPS');
    await pickResolution(app.page, '3840:2160');
    assert.deepEqual(counts(app), only({ testedDecoder: 1 }), '4K at 144 FPS');
    await pickFrameRate(app.page, 120);
    assert.deepEqual(counts(app), only({ testedDecoder: 1, lowerEnd: 1 }), '4K at 120 FPS');
    await pickFrameRate(app.page, 90);
    assert.deepEqual(counts(app), only({ testedDecoder: 1, lowerEnd: 1 }), '4K at 90 FPS has the same warning');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('HDR switched on for a TV that does not report HDR warns, and is still stored (case 4)', async () => {
  for (const [tvOptions, warns] of [[{ tv: 'fhd' }, true], [{ tv: 'uhd', hdr: 0 }, true], [{ tv: 'uhd' }, false], [{ tv: 's90c' }, false]]) {
    const label = JSON.stringify(tvOptions);
    const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi' }, tvOptions) });
    try {
      // Switch HDR off and on again like the user does, with HEVC selected
      for (const state of ['off', 'on']) {
        await app.page.evaluate((switchState) => {
          document.querySelector('#hdrModeBtn').MaterialSwitch[switchState]();
          saveHdrMode();
        }, state);
        await app.page.waitForTimeout(300);
      }
      assert.equal(count(app, TEXTS.hdr), warns ? 1 : 0, label);
      const stored = await waitForStorage(app.page, (values) => values.hdrMode === true);
      assert.equal(stored.hdrMode, true, label);
      assert.deepEqual(app.errors, [], label);
    } finally {
      await app.context.close();
    }
  }
});

test('the bitrate warning starts at the decoder cap of the TV and names it (case 5)', async () => {
  for (const [tv, cap] of [['s90c', 100], ['uhd', 80], ['fhd', 50]]) {
    const app = await openApp(harness, { tv: { tv, conn: 'wifi' } });
    try {
      await setBitrateByHand(app.page, cap);
      assert.equal(count(app, TEXTS.decoderCap), 0, tv + ' at ' + cap);
      await setBitrateByHand(app.page, cap + 0.5);
      await setBitrateByHand(app.page, cap + 10);
      assert.equal(count(app, TEXTS.decoderCap), 1, tv + ' above ' + cap + ', once');
      assert.ok(app.logs.some((line) => line.indexOf(TEXTS.decoderCap) >= 0 && new RegExp(' ' + cap + '$').test(line)), tv + ' names ' + cap);
      // Back at the cap, the warning shows again the next time
      await setBitrateByHand(app.page, cap);
      await setBitrateByHand(app.page, cap + 0.5);
      assert.equal(count(app, TEXTS.decoderCap), 2, tv);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('a preset above the decoder cap of the TV warns about the bitrate too', async () => {
  // After a fresh install the bitrate follows the presets (plan D9): 4K at 120 FPS gets the preset of 120 Mbps
  const app = await openApp(harness, { tv: { tv: 'uhd', conn: 'wifi' } });
  try {
    await unlockAllFrameRates(app.page);
    await pickFrameRate(app.page, 120);
    assert.equal(await app.page.evaluate(() => $('#bitrateSlider').val()), '120');
    assert.deepEqual(counts(app), only({ needsLevel52: 1, decoderCap: 1 }));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('locking the higher frame rates resets the warning, so that it shows again after they are unlocked', async () => {
  const app = await openApp(harness, { tv: { tv: 'fhd', conn: 'wifi' } });
  try {
    await keepBitrate(app.page);
    await unlockAllFrameRates(app.page);
    await pickFrameRate(app.page, 120);
    assert.deepEqual(counts(app), only({ fpsAbove60Hz: 1 }));
    // Switching 'Unlock all frame rates' off resets the frame rate to 60 FPS
    await app.page.evaluate(() => {
      document.querySelector('#unlockAllFpsBtn').MaterialSwitch.off();
      handleUnlockAllFps();
    });
    assert.equal(await app.page.evaluate(() => String($('#selectFramerate').data('value'))), '60');
    await unlockAllFrameRates(app.page);
    await pickFrameRate(app.page, 120);
    assert.deepEqual(counts(app), only({ fpsAbove60Hz: 2 }));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
