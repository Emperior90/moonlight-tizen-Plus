'use strict';

// Checks the setting 'Continuous audio from the host' of the Audio Settings: on by default without being stored,
// reachable with the remote, stored when switched, loaded at the next start, and passed to the launch and resume
// requests of a stream, which then ask the host for audio also during silence (continuousAudio=1, see
// tests/unit/continuous-audio.test.js). Restore Defaults turns it on again (video-defaults.test.js).

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, reloadApp, startHarness, waitForStorage } = require('./harness');

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
// return the path and the continuousAudio parameter of the launch or resume request
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
  return request ? { path: request.pathname, continuousAudio: request.searchParams.get('continuousAudio') } : null;
}, currentGame);

test('on by default, reachable in the Audio Settings, and asking the host for audio during silence', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const shown = await app.page.evaluate(() => ({
      checked: document.getElementById('continuousAudioSwitch').checked,
      label: $('#continuousAudioOption > label').text().trim(),
      help: $('#continuousAudioOption .mdl-list__item-text-body').text().trim(),
      // The remote reaches it after 'Play audio on host'
      items: Views.AudioSettings.view.func(),
    }));
    assert.equal(shown.checked, true);
    assert.equal(shown.label, 'Continuous audio from the host');
    assert.match(shown.help, /^- Keeps the host sending audio during silence, .* Needs a recent Sunshine; older hosts ignore it\.$/);
    assert.equal(shown.items.indexOf('continuousAudioBtn'), shown.items.indexOf('playHostAudioBtn') + 1);
    // A fresh install doesn't store the default
    assert.equal(Object.prototype.hasOwnProperty.call(await readStorage(app.page), 'continuousAudio'), false);

    assert.deepEqual(await launchRequest(app.page, 0), { path: '/launch', continuousAudio: '1' });
    assert.deepEqual(await launchRequest(app.page, 7), { path: '/resume', continuousAudio: '1' });
    assert.ok(app.logs.some((line) => line.indexOf('Continuous audio from the host: 1') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('switched off, it is stored, kept at the next start, and left out of the launch and resume requests', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => $('#continuousAudioSwitch').trigger('click'));
    await waitForStorage(app.page, (values) => values.continuousAudio === false);
    assert.equal(await app.page.evaluate(() => document.getElementById('continuousAudioSwitch').checked), false);

    await reloadApp(app);
    assert.equal(await app.page.evaluate(() => document.getElementById('continuousAudioSwitch').checked), false);
    assert.deepEqual(await launchRequest(app.page, 0), { path: '/launch', continuousAudio: null });
    assert.deepEqual(await launchRequest(app.page, 7), { path: '/resume', continuousAudio: null });

    // And on again
    await app.page.evaluate(() => $('#continuousAudioSwitch').trigger('click'));
    await waitForStorage(app.page, (values) => values.continuousAudio === true);
    assert.deepEqual(await launchRequest(app.page, 0), { path: '/launch', continuousAudio: '1' });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
