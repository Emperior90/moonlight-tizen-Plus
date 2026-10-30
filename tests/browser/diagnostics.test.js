'use strict';

// Checks the diagnostics of wasm/platform/diagnostics.js in the real page: the diagnostic log under About, reached with
// the remote and a gamepad, with the lines of the app and the native lines of the module (from the stub of the module)
// merged, the input keys, the unique ID of the install (also in the lines about a host) and the RTSP address hidden,
// scrolled with UP and DOWN and closed with RETURN; a new session of the log for each stream, not for its start once
// more; the report of the last session in System information, also in German, and System information that fits the
// screen and scrolls with UP and DOWN in every language; and the heartbeat of a stream: the notice at the next start
// that the app ended during a stream, shown once, no notice after a stream that ended normally, and none after a start
// that the host refused or that failed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHarness, openApp, reloadApp } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// Press and release a key of the remote on the focused element, like the TV delivers it
const remoteKey = (page, keyCode, key) => page.evaluate(({ code, name }) => {
  ['keydown', 'keyup'].forEach((type) => {
    const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    (document.activeElement || document.body).dispatchEvent(event);
  });
}, { code: keyCode, name: key });
const RETURN = [10009, 'XF86Back'];
const UP = [38, 'ArrowUp'];
const DOWN = [40, 'ArrowDown'];
const ENTER = [13, 'Enter'];

// A host whose launch request succeeds at once, a start of app 8 that reaches 'Connection Established', and the
// snackbar messages in window.__snackbar
function installStreaming(page) {
  return page.evaluate(() => {
    window.__snackbar = [];
    document.querySelector('#snackbar').MaterialSnackbar.showSnackbar = (data) => window.__snackbar.push(data.message);
    window.__host = {
      paired: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppById: (id) => Promise.resolve({ id: id, title: 'Game ' + id }),
      launchApp: () => Promise.resolve('<root status_code="200" status_message="OK"><sessionUrl0>rtsp://10.0.0.2:48010</sessionUrl0></root>'),
    };
    showApps = () => Promise.resolve();
    Module.stopStream = () => {
      handleMessage('streamTerminated: 0');
      return { type: 'resolve', ret: null };
    };
    window.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  });
}

test('the diagnostic log under About: app and native lines, secrets hidden, scrolled and closed with the remote', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    // The unique ID of this install, made and stored at its first start (loadHTTPCertsCb() in index.js)
    await app.page.waitForFunction(() => typeof myUniqueid === 'string' && myUniqueid.length > 0);
    const uniqueId = await app.page.evaluate(() => {
      // A host as the app lists and polls it, logged as an object and with NvHTTP.toString() (utils.js)
      const host = new NvHTTP('10.0.0.3', myUniqueid, '10.0.0.3');
      host.hostname = 'GAMING-PC';
      console.log('%c[index.js, showApps]', 'color: green;', 'Current host object: \n', host, '\n' + host.toString());
      return myUniqueid;
    });
    await app.page.evaluate(() => {
      const now = Date.now();
      // Lines of the module from before and after a line of the app, one with the RTSP address of a stream
      window.__nativeLog = (now - 2) + '\tEMSS::OnOpen\n' + (now + 2) + '\tRTSP handshake with rtsp://10.0.0.2:48010\n';
      console.log('%c[utils.js, openUrl]', 'color: gray;', 'https://10.0.0.2:47984/launch?uniqueid=0123456789ABCDEF&rikey=00112233445566778899aabbccddeeff&rikeyid=777');
      for (let i = 0; i < 80; i++) {
        console.log('Filler line ' + i);
      }
      $('#settingsBtn').trigger('click');
    });
    await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await app.page.evaluate(() => handleSettingsView('aboutSettings'));
    await app.page.waitForTimeout(400);
    assert.deepEqual(await app.page.evaluate(() => Views.AboutSettings.view.func()),
      ['systemInfoBtn', 'diagnosticLogBtn', 'navigationGuideBtn', 'checkUpdatesBtn', 'restartAppBtn']);
    await remoteKey(app.page, ...DOWN);
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'diagnosticLogBtn');
    await remoteKey(app.page, ...ENTER);
    await app.page.waitForTimeout(200);
    const shown = await app.page.evaluate(() => {
      const box = document.getElementById('diagnosticLogText');
      const area = box.parentElement;
      return {
        open: document.getElementById('diagnosticLogDialog').open,
        titles: Array.prototype.map.call(box.querySelectorAll('.log-session-title'), (title) => title.textContent),
        text: box.textContent,
        atEnd: area.scrollTop > 0 && area.scrollTop + area.clientHeight >= area.scrollHeight - 2,
        scrollTop: area.scrollTop,
      };
    });
    assert.equal(shown.open, true);
    assert.equal(shown.titles.length, 1);
    assert.match(shown.titles[0], /^This session, since /);
    assert.equal(shown.atEnd, true, 'the log opens at its end');
    // The native lines in the order of their time around the line of the app, and the secrets hidden
    const native = shown.text.indexOf('native EMSS::OnOpen');
    const launch = shown.text.indexOf('[utils.js, openUrl] https://10.0.0.2:47984/launch?uniqueid=<hidden>&rikey=<hidden>&rikeyid=<hidden>');
    const rtsp = shown.text.indexOf('native RTSP handshake with rtsp://<hidden>');
    assert.ok(native >= 0 && launch > native && rtsp > launch, shown.text.slice(0, 2000));
    ['0123456789ABCDEF', '00112233445566778899aabbccddeeff', '777', '10.0.0.2:48010', uniqueId].forEach((secret) => {
      assert.equal(shown.text.indexOf(secret), -1, secret);
    });
    assert.ok(shown.text.indexOf('client UID: <hidden>') > 0, 'the host line is in the log');
    // UP scrolls up, DOWN down again, and RETURN closes the log with the focus back on its button
    await remoteKey(app.page, ...UP);
    const up = await app.page.evaluate(() => document.getElementById('diagnosticLogText').parentElement.scrollTop);
    assert.equal(up, shown.scrollTop - 240);
    await remoteKey(app.page, ...DOWN);
    assert.equal(await app.page.evaluate(() => document.getElementById('diagnosticLogText').parentElement.scrollTop), shown.scrollTop);
    await remoteKey(app.page, ...RETURN);
    await app.page.waitForTimeout(250);
    const closed = await app.page.evaluate(() => ({
      open: document.getElementById('diagnosticLogDialog').open,
      overlay: getComputedStyle(document.getElementById('diagnosticLogDialogOverlay')).display,
      text: document.getElementById('diagnosticLogText').textContent,
      focus: document.activeElement.id,
      isDialogOpen,
    }));
    assert.deepEqual(closed, { open: false, overlay: 'none', text: '', focus: 'diagnosticLogBtn', isDialogOpen: false });
    // A gamepad opens and closes it too: A on the button, B in the log
    await app.page.evaluate(() => handleGamepadMenuInput({ detail: { gamepad: 0, changes: [{ type: 'button', index: 0, pressed: true }] } }));
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.evaluate(() => document.getElementById('diagnosticLogDialog').open), true);
    await app.page.evaluate(() => handleGamepadMenuInput({ detail: { gamepad: 0, changes: [{ type: 'button', index: 0, pressed: false }, { type: 'button', index: 1, pressed: true }] } }));
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.evaluate(() => document.getElementById('diagnosticLogDialog').open), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stream starts a session of the log, keeps its report, and its heartbeat ends with it', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', locale: 'de_DE' } });
  try {
    await installStreaming(app.page);
    const run = await app.page.evaluate(async () => {
      console.log('Before the stream');
      startGame(window.__host, 8);
      await window.wait(300);
      handleMessage('Connection Established');
      const streaming = JSON.parse(localStorage.getItem('moonlightStreamHeartbeat'));
      // A start once more (the retry after no video) stays in the session of the stream
      handleMessage('streamTerminated: -100');
      await window.wait(NO_VIDEO_RETRY_DELAY_MS + 300);
      handleMessage('Connection Established');
      const sessionsWhileStreaming = DiagnosticLog.getSessions().length;
      // The stream ends, and the module sends its totals after the end
      Module.stopStream();
      window.__nativeLog = Date.now() + '\tWASM heap top after the stream: 62 of 128 MB (+1 MB this stream)\n';
      handleMessage('SessionReportMsg: {"durationMs":600000,"codec":"HEVC Main10","width":3840,"height":2160,"fps":60,"bitrateKbps":100000,"frames":36000,"networkDroppedFrames":540,"tvDroppedFrames":0,"videoResets":1,"recoveryKeyframes":4,"fecRecoveredBlocks":900,"fecFailures":6,"heapTopMb":62,"heapTotalMb":128,"heapGrowthMb":1}');
      const sessions = DiagnosticLog.getSessions();
      loadSystemInfo();
      return {
        streaming: streaming.state,
        ended: JSON.parse(localStorage.getItem('moonlightStreamHeartbeat')).state,
        sessionsWhileStreaming,
        previous: sessions[0].lines.join('\n'),
        current: sessions[1].lines.join('\n'),
        info: document.getElementById('systemInfoBtn').innerHTML.split(/<br\s*\/?>/),
      };
    });
    assert.equal(run.streaming, 'streaming');
    assert.equal(run.ended, 'idle');
    assert.equal(run.sessionsWhileStreaming, 2);
    assert.ok(run.previous.indexOf('Before the stream') >= 0);
    assert.equal(run.current.indexOf('Before the stream'), -1);
    assert.ok(run.current.indexOf('streamTerminated: -100') >= 0, 'the retry is in the session of the stream');
    assert.ok(run.current.indexOf('native WASM heap top after the stream') >= 0, 'the native lines of the end belong to the stream');
    // The report in System information, in German, after an empty line
    const start = run.info.indexOf('Letzte Sitzung: 10 min 0 s, HEVC Main10, 3840x2160, 60 FPS, 100 Mbps');
    assert.ok(start > 0, run.info.join('\n'));
    assert.equal(run.info[start - 1], '');
    assert.deepEqual(run.info.slice(start + 1), [
      'Im Netz verlorene Frames: 540 von 36.000 (1,50 %)',
      'Vom TV verworfene Frames: 0, Video-Neustarts: 1, Keyframes zur Wiederherstellung: 4',
      'FEC-Reparaturen: 900 Blöcke, 6 fehlgeschlagen',
      'WASM-Heap am Ende: 62 von 128 MB (+1 MB in dieser Sitzung)',
      'Tipp: Viele Frames gingen im Netzwerk verloren: Nutze ein Kabel oder senke die Bitrate.',
      'Tipp: Der PC musste nach Verlusten oft ganze Frames neu senden: Schalte Referenzbild-Invalidierung in den Videoeinstellungen ein.',
    ]);
    // A stream that ended normally leaves no notice for the next start
    await reloadApp(app);
    await app.page.waitForTimeout(300);
    assert.equal(app.logs.filter((line) => line.indexOf('The app ended during a stream the last time it ran') >= 0).length, 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a start that the host refuses or that fails ends its heartbeat, so the next start shows no notice', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await installStreaming(app.page);
    const runs = await app.page.evaluate(async () => {
      const host = window.__host;
      const record = () => JSON.parse(localStorage.getItem('moonlightStreamHeartbeat') || '{}');
      // The app list shows again after a failed start, as with the real showApps()
      showApps = () => {
        showAppsMode();
        return Promise.resolve();
      };
      host.getAppById = (id) => Promise.resolve(id === 22 ? { id: 22, title: 'Terminate', uuid: 'E16CBE1B-295D-4632-9A76-EC4180C857D3' } :
        { id: id, title: 'Game ' + id });
      // Start an app whose launch or resume request the test answers once the heartbeat runs
      const run = async (appId, currentGame, answer) => {
        host.currentGame = currentGame;
        let settle = null;
        host.launchApp = host.resumeApp = () => new Promise((resolve, reject) => {
          settle = () => (answer instanceof Error ? reject(answer) : resolve(answer));
        });
        startGame(host, appId);
        await window.wait(200);
        const during = record().state;
        settle();
        await window.wait(300);
        return during + ' > ' + record().state + (isInGame ? ' in game' : '');
      };
      const results = {
        terminate: await run(22, 13, '<root status_code="410" status_message="App terminated."><resume>0</resume></root>'),
        permission: await run(8, 0, '<root status_code="403" status_message="Permission denied"/>'),
        busy: await run(8, 0, '<root status_code="503" status_message="Service Unavailable"/>'),
        launchFails: await run(8, 0, new Error('timeout')),
        resumeRefused: await run(8, 8, '<root status_code="503" status_message="Service Unavailable"/>'),
        resumeFails: await run(8, 8, new Error('timeout')),
      };
      // No beat follows in the menus
      await window.wait(StreamHeartbeat.INTERVAL_MS + 500);
      results.later = record().state;
      return results;
    });
    assert.deepEqual(runs, {
      terminate: 'streaming > idle', permission: 'streaming > idle', busy: 'streaming > idle', launchFails: 'streaming > idle',
      resumeRefused: 'streaming > idle', resumeFails: 'streaming > idle', later: 'idle',
    });
    await reloadApp(app);
    await app.page.waitForTimeout(300);
    assert.equal(app.logs.filter((line) => line.indexOf('The app ended during a stream the last time it ran') >= 0).length, 0);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

// The message of a stream with three hints, the most that a report has (the row 'everything' of the shared fixture)
const THREE_HINTS_REPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'session-reports.tsv'), 'utf8').split('\n')
  .filter((line) => line.indexOf('everything\t') === 0)[0].split('\t').slice(-2)[0];
// Four controllers with long names
const FOUR_PADS = ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
  '8BitDo Ultimate 2C Wireless Controller (STANDARD GAMEPAD Vendor: 2dc8 Product: 310b)',
  'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'];

test('System information with four controllers and a report with three hints fits the screen in every language, and UP and DOWN scroll it', async () => {
  for (const locale of ['en_US', 'de_DE', 'es_ES', 'fr_FR', 'pt_BR']) {
    const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', locale } });
    try {
      await app.page.evaluate(async ({ report, ids }) => {
        const pads = ids.map((id, index) => ({ index, id, mapping: 'standard', connected: true, timestamp: 1, vibrationActuator: null,
          buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] }));
        Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads.slice() });
        handleMessage(report);
        $('#settingsBtn').trigger('click');
      }, { report: THREE_HINTS_REPORT, ids: FOUR_PADS });
      await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
      await app.page.evaluate(() => {
        handleSettingsView('aboutSettings');
        loadSystemInfo();
      });
      await app.page.waitForTimeout(400);
      // What the box shows: its lines, where it is, and how far it scrolled
      const box = () => app.page.evaluate(() => {
        const info = document.getElementById('systemInfoBtn');
        const pane = document.getElementById('settings-right-pane').getBoundingClientRect();
        const rect = info.getBoundingClientRect();
        return {
          focus: document.activeElement.id, lines: info.innerHTML.split(/<br\s*\/?>/).length, top: rect.top, bottom: rect.bottom,
          paneTop: pane.top, screen: window.innerHeight, scrollTop: info.scrollTop, maxScroll: info.scrollHeight - info.clientHeight,
        };
      });
      const first = await box();
      assert.equal(first.focus, 'systemInfoBtn', locale);
      // Four controllers, an empty line, five lines of the report and three hints
      const info = await app.page.evaluate(() => document.getElementById('systemInfoBtn').innerHTML.split(/<br\s*\/?>/));
      assert.equal(info.filter((line) => /: 8BitDo Ultimate 2C|: Pro Controller|: DualSense|: Xbox Wireless/.test(line)).length, 4, locale);
      assert.equal(info.length - info.indexOf('') - 1, 8, locale + ': ' + info.join('\n'));
      // The whole box is on the screen, below the top of the pane
      assert.ok(first.top >= first.paneTop && first.bottom <= first.screen, locale + ': ' + JSON.stringify(first));
      assert.ok(first.maxScroll > 0, locale + ': the lines are taller than the box');
      // DOWN scrolls to its last line, then moves on; UP comes back and scrolls to its first line
      let state = first;
      let presses = 0;
      while (state.focus === 'systemInfoBtn' && presses < 20) {
        await remoteKey(app.page, ...DOWN);
        const next = await box();
        if (next.focus === 'systemInfoBtn') {
          assert.ok(next.scrollTop > state.scrollTop, locale + ': each DOWN scrolls on');
        } else {
          assert.ok(state.scrollTop >= state.maxScroll - 1, locale + ': DOWN leaves the box only at its end');
          assert.equal(next.focus, 'diagnosticLogBtn', locale);
        }
        state = next;
        presses++;
      }
      assert.equal(state.focus, 'diagnosticLogBtn', locale);
      await remoteKey(app.page, ...UP);
      state = await box();
      assert.equal(state.focus, 'systemInfoBtn', locale);
      for (let i = 0; i < 20 && state.scrollTop > 0; i++) {
        await remoteKey(app.page, ...UP);
        state = await box();
      }
      assert.deepEqual([state.focus, state.scrollTop], ['systemInfoBtn', 0], locale);
      // UP at its first line moves on as in the other lists of the settings, round to the last row
      await remoteKey(app.page, ...UP);
      assert.equal((await box()).focus, 'restartAppBtn', locale);
      assert.deepEqual(app.errors, [], locale);
    } finally {
      await app.context.close();
    }
  }
});

// The record of a heartbeat that a stream left when the app ended during it, put there once per tab
function crashedStream() {
  if (!sessionStorage.getItem('seededHeartbeat')) {
    sessionStorage.setItem('seededHeartbeat', '1');
    const now = Date.now();
    localStorage.setItem('moonlightStreamHeartbeat', JSON.stringify({ state: 'streaming', startedAt: now - 25 * 60000, lastBeat: now - 60000 }));
  }
  window.__notices = [];
  document.addEventListener('DOMContentLoaded', () => {
    const show = () => {
      const snackbar = document.querySelector('#snackbar');
      if (snackbar && snackbar.MaterialSnackbar) {
        const original = snackbar.MaterialSnackbar.showSnackbar.bind(snackbar.MaterialSnackbar);
        snackbar.MaterialSnackbar.showSnackbar = (data) => {
          window.__notices.push(data.message);
          return original(data);
        };
      } else {
        setTimeout(show, 10);
      }
    };
    show();
  });
}

test('the next start says once that the app ended during the last stream', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' }, initScripts: [crashedStream] });
  try {
    await app.page.waitForTimeout(300);
    const first = await app.page.evaluate(() => ({ notices: window.__notices.slice(), record: JSON.parse(localStorage.getItem('moonlightStreamHeartbeat')) }));
    assert.deepEqual(first.notices.filter((text) => /ended during the last stream/.test(text)),
      ['Moonlight ended during the last stream, e.g. after a crash or when the TV was switched off. Its diagnostic log was in memory only.']);
    assert.equal(first.record.state, 'idle');
    assert.ok(app.logs.some((line) => line.indexOf('the stream had run for about 24 minutes') >= 0));
    // It is in the log of this session as well
    assert.ok(await app.page.evaluate(() => DiagnosticLog.getSessions()[0].lines.some((line) => line.indexOf('The app ended during a stream the last time it ran') >= 0)));
    // Not again at the next start
    await reloadApp(app);
    await app.page.waitForTimeout(300);
    assert.deepEqual(await app.page.evaluate(() => window.__notices.filter((text) => /ended during the last stream/.test(text))), []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
