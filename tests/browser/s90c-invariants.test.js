'use strict';

// Golden tests for the S90C invariants (what the S90C keeps, whatever the other TVs get) that the settings matrix (video-defaults.test.js) doesn't
// cover: the warnings that must still appear on the S90C, the ForceGM detection in the dialog, and that the applied
// settings are what the next start loads. The S90C has to behave exactly like this after every later change. Only
// the wording of the warnings may be more general: since 1.19.100 the Ethernet warning names the 100 Mbps port
// that Samsung TVs usually have, still above 80 Mbps, and the 4K warning above 120 FPS keeps its text on the S90C.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readVideoSettings, reloadApp, startHarness, waitForStorage } = require('./harness');

const S90C = { tv: 's90c' };
const ETHERNET_WARNING = 'Warning: Samsung TVs usually have a 100 Mbps Ethernet port, so bitrates above %1$s Mbps can cause packet loss.';
const DECODER_4K_WARNING = 'Warning: The video decoder of the TV supports 4K up to 120 FPS';

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Move the bitrate slider by hand, like the user does in the bitrate menu
function setBitrateByHand(page, bitrate) {
  return page.evaluate((value) => {
    $('#bitrateSlider')[0].MaterialSlider.change(value);
    $('#bitrateSlider').trigger('input');
  }, String(bitrate));
}

// Count the log lines that contain the text
const count = (app, text) => app.logs.filter((line) => line.indexOf(text) >= 0).length;

test('S90C over Ethernet: a bitrate above 80 Mbps warns about the 100 Mbps port, once', async () => {
  const app = await openApp(harness, { tv: Object.assign({ conn: 'ethernet' }, S90C) });
  try {
    await setBitrateByHand(app.page, 80);
    assert.equal(count(app, ETHERNET_WARNING), 0, 'no warning at 80 Mbps');
    await setBitrateByHand(app.page, 85);
    await setBitrateByHand(app.page, 90);
    assert.equal(count(app, ETHERNET_WARNING), 1);
    assert.ok(app.logs.some((line) => line.indexOf(ETHERNET_WARNING) >= 0 && / 80$/.test(line)), 'the warning names 80 Mbps');
    assert.equal(await app.page.evaluate(() => autoAdjustBitrate), false, 'a bitrate picked by hand is kept');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('S90C over Wi-Fi: no Ethernet warning at 90 Mbps', async () => {
  const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi' }, S90C) });
  try {
    await setBitrateByHand(app.page, 90);
    assert.equal(count(app, ETHERNET_WARNING), 0);
  } finally {
    await app.context.close();
  }
});

test('S90C: 4K above 120 FPS warns about the decoder', async () => {
  const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi' }, S90C) });
  try {
    await app.page.evaluate(() => saveFramerate.call($('.videoFramerateMenu li[data-value="120"]')[0]));
    assert.equal(count(app, DECODER_4K_WARNING), 0, 'no decoder warning at 4K 120 FPS');
    // Since 1.19.100 a selection with another warning shows it right away, without waiting for a selection without one
    await app.page.evaluate(() => saveFramerate.call($('.videoFramerateMenu li[data-value="144"]')[0]));
    assert.equal(count(app, DECODER_4K_WARNING), 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('S90C with the ForceGM variant: the dialog recognizes it instead of recommending it', async () => {
  const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi', forceGM: true }, S90C) });
  try {
    await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    const text = await app.page.evaluate(() => document.getElementById('warningDialogText').innerHTML);
    assert.ok(text.indexOf('ForceGM variant detected') >= 0, text);
    assert.ok(text.indexOf('install the ForceGM variant') < 0, text);
    await app.page.evaluate(() => $('#closeWarning').trigger('click'));
  } finally {
    await app.context.close();
  }
});

test('S90C: Close in the dialog keeps the current settings', async () => {
  const app = await openApp(harness, { tv: Object.assign({ conn: 'wifi' }, S90C) });
  try {
    await setBitrateByHand(app.page, 55);
    const before = await readVideoSettings(app.page);
    await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
    await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    assert.deepEqual(await readVideoSettings(app.page), before);
    assert.equal(await app.page.evaluate(() => isDialogOpen), false);
  } finally {
    await app.context.close();
  }
});

test('S90C: the applied settings are what the next start loads', async () => {
  for (const conn of ['ethernet', 'wifi', 'unknown']) {
    const app = await openApp(harness, { tv: Object.assign({ conn }, S90C) });
    try {
      await app.page.evaluate(() => $('#optimalSettingsBtn').trigger('click'));
      await app.page.evaluate(() => $('#continueWarning').trigger('click'));
      await waitForStorage(app.page, (values) => values.resolution === '3840:2160' && 'bitrate' in values && values.autoAdjustBitrate === true && 'gameMode' in values);
      const applied = await readVideoSettings(app.page);
      await reloadApp(app);
      assert.deepEqual(await readVideoSettings(app.page), applied, conn);
      assert.deepEqual(
        [applied.resolution, applied.frameRate, applied.codec, applied.hdr, applied.bitrate, applied.unlockAllFps, applied.gameMode,
          applied.framePacing, applied.fullRange, applied.autoAdjustBitrate],
        ['3840:2160', '60', 'HEVC', true, { ethernet: '75', wifi: '100', unknown: '80' }[conn], true, false, true, false, true],
        conn);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});
