'use strict';

// Checks the dialogs that confirm an action that can't be undone (pushConfirmationView() in wasm/platform/index.js):
// quitting the running app (also before the start of another app), deleting a host or all hosts, Restore Defaults and
// the optimal settings, which replace the video settings, open with the focus on No or Cancel, so that an OK pressed by
// mistake only closes them, and since 2.3.5 so do Exit Moonlight (which RETURN opens from the PC list) and the Restart
// button of About. LEFT still reaches Yes, Apply, Exit or Restart. The restart question that follows Restore Defaults
// keeps Restart. The other dialogs of the warning dialog keep their first button: a warning its Close button, the
// Wake-on-LAN warning Continue. Remove all PCs with Continue deletes every PC with what the app stored for it.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, readStorage, startHarness } = require('./harness');
const { THREE_HOSTS, tvKey } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// The focused element and the button that the view of the dialog selects, once the dialog has focused it
const selection = (page) => page.waitForTimeout(250).then(() => page.evaluate(() => ({
  focused: document.activeElement ? document.activeElement.id : '',
  marked: Array.prototype.filter.call(document.querySelectorAll('dialog[open] .mdl-dialog__actions button'),
    (button) => button.classList.contains('hovered')).map((button) => button.id),
})));

const openDialogs = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('dialog[open]'), (dialog) => dialog.id));

test('Restore Defaults opens on No, and OK there keeps every setting', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { framePacing: false } });
  try {
    await app.page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
    assert.deepEqual(await selection(app.page), { focused: 'cancelRestoreDefaults', marked: ['cancelRestoreDefaults'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await openDialogs(app.page), []);
    assert.equal((await readStorage(app.page)).framePacing, false);
    assert.ok(!app.logs.some((line) => line.indexOf('Settings have been restored to their default values.') >= 0));

    // A second time it opens on No again, also after LEFT selected Yes the time before
    await app.page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
    await selection(app.page);
    await app.page.keyboard.press('ArrowLeft');
    assert.deepEqual(await selection(app.page), { focused: 'continueRestoreDefaults', marked: ['continueRestoreDefaults'] });
    await app.page.evaluate(() => $('#cancelRestoreDefaults').trigger('click'));
    await app.page.evaluate(() => $('#restoreDefaultsBtn').trigger('click'));
    assert.deepEqual(await selection(app.page), { focused: 'cancelRestoreDefaults', marked: ['cancelRestoreDefaults'] });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('deleting a host or all hosts opens on No, and OK there keeps them', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      window.beginBackgroundPollingOfHost = function() {};
      window.endBackgroundPollingOfHost = function() {};
      addHostToGrid({
        serverUid: 'A', hostname: 'GAMING-PC', online: true, paired: true, currentGame: 0, address: '10.0.0.2', externalPort: 47989,
        httpPort: 47989, httpsPort: 47984, macAddress: '00:11:22:33:44:55', toString: () => 'GAMING-PC', updateExternalAddressIP4() {},
        clearBoxArt() {}, refreshServerInfo: () => Promise.resolve(), pollServer(callback) {
          callback(this);
        },
      });
      deleteHostDialog(hosts.A);
    });
    assert.deepEqual(await selection(app.page), { focused: 'cancelDeleteHost', marked: ['cancelDeleteHost'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await openDialogs(app.page), []);
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), ['A']);

    await app.page.evaluate(() => deleteAllHostsDialog());
    assert.deepEqual(await selection(app.page), { focused: 'cancelDeleteHost', marked: ['cancelDeleteHost'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await app.page.evaluate(() => Object.keys(hosts)), ['A']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('quitting the running app opens on No, also when another app is started, and OK there quits nothing', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      window.__quits = 0;
      const host = new NvHTTP('10.0.0.2', '0123456789abcdef', '', '');
      Object.assign(host, { paired: true, hostname: 'GAMING-PC', ppkstr: 'PINNED-CERT', serverUid: 'HOST1', currentGame: 7 });
      host.refreshServerInfo = () => Promise.resolve(true);
      host.getAppById = (id) => Promise.resolve(id ? { id: id, title: 'Game ' + id } : null);
      host.quitApp = () => {
        window.__quits++;
        return Promise.resolve();
      };
      api = host;
      window.__host = host;
      quitAppDialog();
    });
    assert.deepEqual(await selection(app.page), { focused: 'cancelQuitApp', marked: ['cancelQuitApp'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await openDialogs(app.page), []);

    // The start of app 8 while app 7 runs asks to quit app 7 first
    await app.page.evaluate(() => {
      showApps = () => Promise.resolve();
      startGame(window.__host, 8);
    });
    assert.deepEqual(await selection(app.page), { focused: 'cancelQuitApp', marked: ['cancelQuitApp'] });
    assert.match(await app.page.evaluate(() => $('#quitAppDialogText').text()), /Game 7 is already running/);
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.evaluate(() => window.__quits), 0);
    assert.equal(await app.page.evaluate(() => window.__host.currentGame), 7);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the optimal settings open on Cancel, also after LEFT selected Apply the time before, and the other warnings keep their button', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { videoCodec: 'AV1', bitrate: '150', autoAdjustBitrate: false } });
  try {
    const marked = () => app.page.evaluate(() => ['continueWarning', 'closeWarning'].filter((id) => document.getElementById(id).classList.contains('hovered')));
    await app.page.evaluate(() => optimalSettingsDialog());
    assert.deepEqual(await selection(app.page), { focused: 'closeWarning', marked: ['closeWarning'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await openDialogs(app.page), []);
    const stored = await readStorage(app.page);
    assert.deepEqual([stored.videoCodec, stored.bitrate], ['AV1', '150']);

    await app.page.evaluate(() => optimalSettingsDialog());
    await selection(app.page);
    await app.page.keyboard.press('ArrowLeft');
    assert.deepEqual(await selection(app.page), { focused: 'continueWarning', marked: ['continueWarning'] });
    await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    await app.page.evaluate(() => optimalSettingsDialog());
    assert.deepEqual(await selection(app.page), { focused: 'closeWarning', marked: ['closeWarning'] });
    await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    await app.page.waitForTimeout(250);
    assert.deepEqual(await marked(), [], 'no mark stays in the closed dialog');

    // A warning opens on Close, its only button, and the Wake-on-LAN warning on Continue
    await app.page.evaluate(() => warningDialog('Unsupported Feature', 'A warning'));
    assert.deepEqual(await selection(app.page), { focused: 'closeWarning', marked: ['closeWarning'] });
    await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    await app.page.evaluate(() => wakeOnLanWarningDialog({ hostname: 'GAMING-PC', macAddress: '02:11:22:33:44:55' }));
    assert.deepEqual(await selection(app.page), { focused: 'continueWarning', marked: ['continueWarning'] });
    await app.page.evaluate(() => $('#closeWarning').trigger('click'));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Exit Moonlight opens on Cancel, OK there keeps the app, and LEFT then OK exits', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      window.__exits = 0;
      tizen.application.getCurrentApplication = () => ({ exit: () => window.__exits++ });
    });
    // RETURN on the PC list
    await tvKey(app.page, 10009, 'XF86Back');
    assert.deepEqual(await openDialogs(app.page), ['exitAppDialog']);
    assert.deepEqual(await selection(app.page), { focused: 'cancelExitApp', marked: ['cancelExitApp'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual(await openDialogs(app.page), []);
    assert.deepEqual(await app.page.evaluate(() => [window.__exits, isDialogOpen, Navigation.isCurrent(Views.Hosts)]), [0, false, true]);
    // Again, also after LEFT selected Exit the time before: on Cancel; LEFT and OK exit
    await tvKey(app.page, 10009, 'XF86Back');
    await selection(app.page);
    await app.page.keyboard.press('ArrowLeft');
    assert.deepEqual(await selection(app.page), { focused: 'continueExitApp', marked: ['continueExitApp'] });
    await app.page.evaluate(() => $('#cancelExitApp').trigger('click'));
    await tvKey(app.page, 10009, 'XF86Back');
    assert.deepEqual(await selection(app.page), { focused: 'cancelExitApp', marked: ['cancelExitApp'] });
    await app.page.keyboard.press('ArrowLeft');
    await app.page.waitForTimeout(100);
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.evaluate(() => window.__exits), 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Restart Moonlight opens on Cancel, OK there restarts nothing, LEFT then OK restarts, and the question of Restore Defaults opens on Restart', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      window.__restarts = 0;
      restartApplication = () => window.__restarts++;
    });
    // The Restart button of About
    await app.page.evaluate(() => $('#restartAppBtn').trigger('click'));
    assert.deepEqual(await openDialogs(app.page), ['restartAppDialog']);
    assert.deepEqual(await selection(app.page), { focused: 'cancelRestartApp', marked: ['cancelRestartApp'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.deepEqual([await openDialogs(app.page), await app.page.evaluate(() => window.__restarts)], [[], 0]);
    await app.page.evaluate(() => $('#restartAppBtn').trigger('click'));
    await selection(app.page);
    await app.page.keyboard.press('ArrowLeft');
    assert.deepEqual(await selection(app.page), { focused: 'continueRestartApp', marked: ['continueRestartApp'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.evaluate(() => window.__restarts), 1);
    // The restart that Restore Defaults asks for opens on Restart, also after the button of About opened on Cancel
    await app.page.evaluate(() => $('#restartAppBtn').trigger('click'));
    await selection(app.page);
    await app.page.evaluate(() => $('#cancelRestartApp').trigger('click'));
    await app.page.evaluate(() => requiredRestartAppDialog());
    assert.deepEqual(await selection(app.page), { focused: 'continueRestartApp', marked: ['continueRestartApp'] });
    await app.page.evaluate(() => $('#cancelRestartApp').trigger('click'));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Remove all PCs, then Continue, deletes every PC with its storage, its hidden apps and the data of the Smart Hub', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, stored: { hosts: THREE_HOSTS } });
  try {
    await app.page.waitForFunction(() => typeof hosts !== 'undefined' && Object.keys(hosts).length === 3, null, { timeout: 10000 });
    await app.page.evaluate(() => {
      localStorage.setItem('hiddenApps_HOST1', JSON.stringify([{ id: 7, title: 'Desktop' }]));
      _isSmartHubSupported = true;
      _previewApps = { HOST1: [{ id: 7, title: 'Desktop' }] };
      savePreviewApps();
      deleteAllHostsDialog();
    });
    assert.deepEqual(await selection(app.page), { focused: 'cancelDeleteHost', marked: ['cancelDeleteHost'] });
    await app.page.keyboard.press('ArrowLeft');
    assert.deepEqual(await selection(app.page), { focused: 'continueDeleteHost', marked: ['continueDeleteHost'] });
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(400);
    const result = await app.page.evaluate(() => ({
      hosts: Object.keys(hosts),
      cards: document.querySelectorAll('[id^="host-container-"]').length,
      preview: _previewApps,
      hidden: localStorage.getItem('hiddenApps_HOST1'),
      dialogs: Array.prototype.map.call(document.querySelectorAll('dialog[open]'), (dialog) => dialog.id),
    }));
    assert.deepEqual(result, { hosts: [], cards: 0, preview: {}, hidden: null, dialogs: [] });
    const stored = await readStorage(app.page);
    assert.deepEqual([stored.hosts, stored.previewApps], [{}, {}]);
    assert.ok(app.logs.some((line) => line.indexOf('All PCs have been deleted.') >= 0));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
