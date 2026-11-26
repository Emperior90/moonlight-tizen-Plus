'use strict';

// Checks the switch 'Prioritize sound on Wi-Fi' of the Audio Settings (wasm/index.html, index.js, navigation.js) in the
// real page: it is on for a fresh install and for an install of an earlier version, which stored nothing for it (the
// audio QoS that every version asked for on the local network); its row shows with every audio backend and is the
// last control of the Audio Settings; turning it off is stored and loads after a restart; the optimal settings button
// leaves it as it is, and Restore Defaults turns it on and stores that; every start request, of a launch and of a
// resume, carries it as its last argument (1 on, 0 off), and the log line of the start names it. What the module does
// with it is pinned by tests/unit/audio-qos.test.js and run through the SDP by tests/native/sdp_audio_qos_test.c.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, reloadApp, startHarness, waitForStorage } = require('./harness');

const TV = { tv: 's90c', conn: 'wifi' };
const LABEL = 'Prioritize sound on Wi-Fi';
// The help text as the row shows it: without the dash that starts its key (refreshUI() in i18n.js)
const HELP = 'On the home network, asks the PC to send the sound with priority (DSCP), like the picture. Turn it off if ' +
  'only the sound crackles or drops out over Wi-Fi while the picture is clean: some routers handle prioritized sound badly.';

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

async function openSettings(page) {
  await page.evaluate(() => showSettings());
  await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
}

// The row of the switch in the Audio Settings, its state and the controls that UP and DOWN move through there
const audioQosRow = (page) => page.evaluate(() => {
  handleSettingsView('audioSettings');
  const row = document.getElementById('audioQosOption');
  return {
    shown: $(row).is(':visible'), label: row.querySelector('label').textContent.trim(),
    help: row.querySelector('.mdl-list__item-text-body').textContent.trim(),
    on: document.getElementById('audioQosSwitch').checked, items: Views.AudioSettings.view.func(),
  };
});

// Start a stream of app 7 with a host that answers at once, by a launch, or by a resume when the app already runs, and
// return the last argument of the start request
const startRequestAudioQos = (page, resume) => page.evaluate(async (isResume) => {
  const ok = '<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>';
  const host = {
    paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989,
    currentGame: isResume ? 7 : 0, appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
    refreshServerInfo: () => Promise.resolve(), getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
    launchApp: () => Promise.resolve(ok), resumeApp: () => Promise.resolve(ok), toString: () => 'GAMING-PC',
  };
  showApps = () => Promise.resolve();
  window.__startStreamArgs = null;
  startGame(host, 7);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const args = window.__startStreamArgs;
  // The stream connects before it ends, which releases its start on the host, so the next start doesn't wait
  // (held-host-start.test.js)
  handleMessage('Connection Established');
  handleMessage('streamTerminated: 0');
  return args ? [args.length, args[args.length - 1]] : null;
}, resume);

const logLine = (value) => 'Prioritize sound on Wi-Fi (audio QoS on the local network): ' + value;

test('a fresh install has it on, stores nothing, shows it with every audio backend and asks for the audio QoS', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await openSettings(app.page);
    assert.deepEqual(await audioQosRow(app.page), { shown: true, label: LABEL, help: HELP, on: true,
      items: ['selectAudioBackend', 'selectAudio', 'audioSyncBtn', 'playHostAudioBtn', 'audioQosBtn'] });
    // The network setting stays with the Web Audio backend and with the audio output disabled
    for (const backend of ['WebAudio', 'Disabled']) {
      await app.page.evaluate((value) => {
        $('.audioBackendMenu li').filter(function() {
          return $(this).data('value') === value;
        }).click();
      }, backend);
      const row = await audioQosRow(app.page);
      assert.deepEqual([row.shown, row.items.slice(-1)[0]], [true, 'audioQosBtn'], backend);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(await readStorage(app.page), 'audioQos'), false);
    assert.deepEqual(await startRequestAudioQos(app.page, false), [34, 1]);
    assert.deepEqual(await startRequestAudioQos(app.page, true), [34, 1]);
    assert.ok(app.logs.some((line) => line.indexOf(logLine(1)) >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('turned off, it is stored, loads after a restart and asks for the audio without QoS at every start', async () => {
  // An install of an earlier version that stored other audio settings, but nothing for this switch
  const app = await openApp(harness, { tv: TV, stored: { audioSync: true, playHostAudio: true } });
  try {
    await openSettings(app.page);
    assert.equal((await audioQosRow(app.page)).on, true);
    // OK on the switch, as the navigation clicks it (clickElement() in navigation.js)
    await app.page.evaluate(() => document.getElementById('audioQosBtn').click());
    await waitForStorage(app.page, (values) => values.audioQos === false);
    assert.equal((await audioQosRow(app.page)).on, false);
    assert.deepEqual(await startRequestAudioQos(app.page, false), [34, 0]);
    assert.deepEqual(await startRequestAudioQos(app.page, true), [34, 0]);
    assert.ok(app.logs.some((line) => line.indexOf(logLine(0)) >= 0));

    await reloadApp(app);
    await openSettings(app.page);
    assert.equal((await audioQosRow(app.page)).on, false);
    assert.deepEqual(await startRequestAudioQos(app.page, false), [34, 0]);
    // On again is stored as well
    await app.page.evaluate(() => document.getElementById('audioQosBtn').click());
    await waitForStorage(app.page, (values) => values.audioQos === true);
    assert.deepEqual(await startRequestAudioQos(app.page, false), [34, 1]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the optimal settings button leaves it off, and Restore Defaults turns it on and stores that', async () => {
  const app = await openApp(harness, { tv: TV, stored: { audioQos: false } });
  try {
    const { page } = app;
    await openSettings(page);
    assert.equal((await audioQosRow(page)).on, false);
    // The dialog doesn't name it, and Apply leaves it as it is
    await page.evaluate(() => optimalSettingsDialog());
    await page.waitForFunction(() => isDialogOpen);
    assert.doesNotMatch(await page.evaluate(() => document.getElementById('warningDialogText').innerHTML), /sound on Wi-Fi|QoS/i);
    await page.evaluate(() => $('#continueWarning').trigger('click'));
    await page.waitForFunction(() => !isDialogOpen);
    await waitForStorage(page, (values) => values.autoAdjustBitrate === true && 'resolution' in values);
    assert.equal((await audioQosRow(page)).on, false);
    assert.equal((await readStorage(page)).audioQos, false);
    assert.deepEqual(await startRequestAudioQos(page, false), [34, 0]);

    await page.evaluate(() => restoreDefaultsSettingsValues());
    await waitForStorage(page, (values) => values.audioQos === true);
    assert.equal((await audioQosRow(page)).on, true);
    assert.deepEqual(await startRequestAudioQos(page, false), [34, 1]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
