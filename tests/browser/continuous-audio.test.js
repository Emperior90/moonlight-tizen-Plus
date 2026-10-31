'use strict';

// Checks the audio parameters of the launch and resume requests of a stream: every request asks the host for audio also
// during silence (continuousAudio=1, see tests/unit/continuous-audio.test.js), which earlier versions had as the switch
// 'Continuous audio from the host' for an A/B test. The switch is gone, and the stored value of an install that had
// switched it off is dropped once by the snapshot of settings schema 3, with a log line. The requests also tell the
// host the audio configuration of the settings (surroundAudioInfo: the channel mask << 16 | the channel count), which
// was always stereo before.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness, waitForStorage } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Start app 7 on a simulated paired host built on NvHTTP, whose requests go through a replaced sendMessage(), and
// return the path and the audio parameters of the launch or resume request
const launchRequest = (page, currentGame) => page.evaluate(async (runningApp) => {
  const host = new NvHTTP('10.0.0.2', '0123456789abcdef', '', '');
  Object.assign(host, { paired: true, hostname: 'GAMING-PC', serverUid: 'HOST1', currentGame: runningApp, ppkstr: 'PINNED-CERT' });
  host._baseUrlHttps = 'https://10.0.0.2:47984';
  host.refreshServerInfo = () => Promise.resolve(true);
  host.getAppById = (id) => Promise.resolve({ id: id, title: 'Game ' + id });
  let request = null;
  const realSendMessage = sendMessage;
  sendMessage = (method, params) => {
    if (method === 'openUrl' && !request) {
      request = new URL(params[0]);
      return Promise.resolve('<root status_code="200"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>');
    }
    return Promise.resolve(null);
  };
  showApps = () => Promise.resolve();
  try {
    startGame(host, 7);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    sendMessage = realSendMessage;
    isInGame = false;
  }
  return request ? {
    path: request.pathname,
    continuousAudio: request.searchParams.get('continuousAudio'),
    surroundAudioInfo: request.searchParams.get('surroundAudioInfo'),
  } : null;
}, currentGame);

test('there is no switch for it, and every launch and resume asks the host for audio during silence', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const shown = await app.page.evaluate(() => ({
      rows: document.querySelectorAll('#continuousAudioOption, #continuousAudioSwitch').length,
      items: Views.AudioSettings.view.func(),
    }));
    assert.equal(shown.rows, 0);
    // (Decrypt host audio is in the Experimental block of the Advanced Settings since 2.2.0)
    assert.deepEqual(shown.items, ['selectAudioBackend', 'selectAudio', 'audioSyncBtn', 'playHostAudioBtn']);
    assert.equal(Object.prototype.hasOwnProperty.call(await readStorage(app.page), 'continuousAudio'), false);

    assert.deepEqual(await launchRequest(app.page, 0), { path: '/launch', continuousAudio: '1', surroundAudioInfo: String(0x030002) });
    assert.deepEqual(await launchRequest(app.page, 7), { path: '/resume', continuousAudio: '1', surroundAudioInfo: String(0x030002) });
    assert.ok(app.logs.some((line) => line.indexOf('Continuous audio from the host: 1') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('an install that had switched it off asks for it as well, and its stored value is dropped once with a log line', async () => {
  const app = await openApp(harness, {
    tv: { tv: 's90c', conn: 'wifi' },
    stored: { uniqueid: '0123456789abcdef', cert: { cert: 'TEST-CERT', privateKey: 'TEST-KEY' }, settingsSchema: 2, continuousAudio: false },
  });
  try {
    const stored = await waitForStorage(app.page, (values) => values.settingsSchema === 3 && !('continuousAudio' in values));
    assert.equal(stored.continuousAudio, undefined);
    assert.ok(app.logs.some((line) => line.indexOf('Removing the stored value of a setting that no longer exists: continuousAudio = false') >= 0));
    assert.deepEqual(await launchRequest(app.page, 0), { path: '/launch', continuousAudio: '1', surroundAudioInfo: String(0x030002) });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the launch and resume requests tell the host the audio configuration of the settings', async () => {
  // 5.1 as stored by the settings
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { audioConfig: '51Surround' } });
  try {
    assert.equal(await app.page.evaluate(() => $('#selectAudio').data('value')), '51Surround');
    // The channel mask (front left and right, centre, LFE, back left and right) << 16 | 6 channels
    assert.deepEqual(await launchRequest(app.page, 0), { path: '/launch', continuousAudio: '1', surroundAudioInfo: String(0x3F0006) });
    assert.deepEqual(await launchRequest(app.page, 7), { path: '/resume', continuousAudio: '1', surroundAudioInfo: String(0x3F0006) });
    // 7.1 with 8 channels, and stereo for a value the settings don't know, which the module streams in stereo too
    const infos = {};
    for (const config of ['71Surround', 'Stereo', 'Quad']) {
      await app.page.evaluate((value) => $('#selectAudio').data('value', value), config);
      infos[config] = (await launchRequest(app.page, 0)).surroundAudioInfo;
    }
    assert.deepEqual(infos, { '71Surround': String(0x63F0008), 'Stereo': String(0x030002), 'Quad': String(0x030002) });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
