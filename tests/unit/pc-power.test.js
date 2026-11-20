'use strict';

// Pins the power sequence of 'Shut down or restart the PC…' (wasm/platform/menus.js, since 2.3.2), which the Stream
// Menu and the menu of a PC in the PC list share: Windows key + R, 2 s later the command as text (sendText() of the
// module, independent of the keyboard layout of the PC), 0.5 s later Enter, with the exact key events; nothing before the
// waits, nothing into another stream, nothing after the stream ended, Esc to close Run when the sequence stops after
// Windows key + R, RETURN that cancels, the hint after 30 s, and what the end of the stream makes of a command
// (endPcPowerCommand()). The diagnostic log gets the steps, never the command. The app that a session of the PC list
// streams (choosePcPowerApp() in index.js). menus.js runs here with a clock of the test and a stub of the module;
// tests/browser/stream-menu-panels.test.js and pc-power.test.js run it in the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

// A clock of the test for setTimeout(), clearTimeout() and performance.now(): advance() runs the timers that are due, in
// the order of their times
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + (Number(ms) || 0), fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        timers.forEach((timer, id) => {
          if (timer.at <= end && (!next || timer.at < next.timer.at)) {
            next = { id, timer };
          }
        });
        if (!next) {
          break;
        }
        timers.delete(next.id);
        now = next.timer.at;
        next.timer.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

// The key events of the module as 'key <code in hex>,<action>,<modifiers>'
const WIN_R = ['key 805b,3,8', 'key 8052,3,8', 'key 8052,4,8', 'key 805b,4,0'];
const ENTER = ['key 800d,3,0', 'key 800d,4,0'];
const ESC = ['key 801b,3,0', 'key 801b,4,0'];

// Load menus.js and remote_controller.js with a running stream (launch 5 of GAMING-PC), the clock, a module stub that
// records its calls with their times, the snackbar messages (with the timeout of snackbarLogFor()), and the times at which
// the message that shows was ended (dismissSnackbar() of index.js). options.video is the video element of the page,
// options.host the host of the stream.
function loadPower(options) {
  const opts = options || {};
  const clock = createClock();
  const calls = [];
  const messages = [];
  const dismissals = [];
  const state = { textAnswer: 0 };
  const record = (text) => calls.push({ at: clock.now(), text });
  const translate = (key, args) => args.reduce((text, arg, index) => text.replace('%' + (index + 1) + '$s', arg), key);
  const doc = {
    visibilityState: 'visible',
    pointerLockElement: null,
    getElementById: (id) => (id === 'wasm_module' ? opts.video || null : null),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const platform = loadPlatformScripts(['wasm/platform/menus.js', 'wasm/platform/remote_controller.js'], {
    globals: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      performance: { now: clock.now },
      TextEncoder,
      document: doc,
      Module: {
        sendKeyboardEvent: (code, action, modifiers) => record('key ' + code.toString(16) + ',' + action + ',' + modifiers),
        sendText: (text) => {
          record('text ' + text);
          return state.textAnswer;
        },
        setStreamMenuOpen: (open) => record('paused ' + open),
        stopStream: () => record('stopStream'),
      },
      isInGame: true,
      wasmSessionStarted: true,
      isStreamConnected: true,
      streamLaunchId: 5,
      streamLaunchHost: opts.host || { hostname: 'GAMING-PC' },
      api: null,
      t: (key, ...args) => translate(key, args),
      snackbarLog: (key, ...args) => messages.push({ at: clock.now(), text: translate(key, args) }),
      snackbarLogLong: (key, ...args) => messages.push({ at: clock.now(), long: true, text: translate(key, args) }),
      snackbarLogFor: (timeout, key, ...args) => messages.push({ at: clock.now(), timeout, text: translate(key, args) }),
      dismissSnackbar: () => dismissals.push(clock.now()),
      cancelStreamLaunch: () => record('cancelStreamLaunch'),
    },
  });
  const ctx = platform.context;
  return {
    platform, ctx, clock, calls, messages, dismissals, state, doc,
    // The calls without their times, and those since a time
    sent: (since) => calls.filter((call) => call.at >= (since || 0)).map((call) => call.text),
    keysAndText: () => calls.filter((call) => /^(key|text) /.test(call.text)).map((call) => call.text),
    log: () => platform.consoleMessages.map((entry) => entry.text).join('\n'),
    // The stream ends as the module reports it (handleMessage() in messages.js): the flags first, then the command
    endStream: (code, quitApp) => {
      ctx.isInGame = false;
      ctx.wasmSessionStarted = false;
      ctx.isStreamConnected = false;
      ctx.streamLaunchId++;
      return plain(ctx.endPcPowerCommand(code, !!quitApp));
    },
  };
}

test('the function keys F1 to F12 of the Stream Menu are one key each, the virtual-key codes 0x70 to 0x7B, pressed and released', () => {
  const power = loadPower();
  const keys = plain(power.platform.get('STREAM_FUNCTION_KEYS'));
  assert.deepEqual(Object.keys(keys), Array.from({ length: 12 }, (value, index) => 'streamMenuKeyF' + (index + 1)));
  Object.keys(keys).forEach((id, index) => {
    assert.deepEqual(keys[id], [0x70 + index], id);
    assert.deepEqual(plain(power.ctx.buildKeyComboEvents(keys[id])), [
      { keyCode: 0x70 + index, action: 0x03, modifiers: 0 },
      { keyCode: 0x70 + index, action: 0x04, modifiers: 0 },
    ], id);
  });
  power.ctx.sendKeyComboToHost(keys.streamMenuKeyF11);
  assert.deepEqual(power.sent(), ['key 807a,3,0', 'key 807a,4,0']);
  // The panels and their entries
  assert.deepEqual(plain(power.platform.get('STREAM_MENU_PANELS')), { streamMenuShortcuts: 'streamShortcutsPanel', streamMenuFKeys: 'streamFKeysPanel',
    streamMenuPower: 'streamPowerPanel' });
  assert.equal(power.platform.get('STREAM_FUNCTION_KEY_COLUMNS'), 4);
});

test('the power commands are a full shutdown and a restart without /f, which the text check of the module lets through', () => {
  const power = loadPower();
  assert.deepEqual(plain(power.platform.get('PC_POWER_COMMANDS')), { shutdown: 'shutdown /s /t 0', restart: 'shutdown /r /t 0' });
  ['shutdown /s /t 0', 'shutdown /r /t 0'].forEach((command) => {
    assert.equal(power.ctx.checkStreamText(command), 0, command);
    assert.ok(command.indexOf('/f') < 0);
  });
  // The waits, which the browser tests may shorten
  assert.deepEqual([power.ctx.PC_POWER_MENU_DELAY_MS, power.ctx.PC_POWER_LIST_DELAY_MS, power.ctx.PC_POWER_PICTURE_WAIT_MS,
    power.ctx.PC_POWER_TYPE_DELAY_MS, power.ctx.PC_POWER_ENTER_DELAY_MS, power.ctx.PC_POWER_HINT_MS, power.ctx.PC_POWER_END_MS],
  [300, 5000, 10000, 2000, 500, 30000, 120000]);
});

for (const kind of ['shutdown', 'restart']) {
  test('from the Stream Menu (' + kind + '): the countdown, then Windows key + R at 300 ms, the command at 2300 ms, Enter at 2800 ms, nothing before', () => {
    const power = loadPower();
    power.ctx.confirmStreamMenuPower(kind);
    // The controllers and the mouse stay away from the PC until Enter
    assert.deepEqual(power.sent(), ['paused true']);
    // The countdown shows at once, in place of the message that shows, until Enter
    assert.deepEqual(power.messages, [{ at: 0, timeout: 2800, text: 'GAMING-PC ' + (kind === 'restart' ? 'restarts' : 'shuts down') +
      ' in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED' }]);
    assert.deepEqual(power.dismissals, [0]);
    assert.equal(power.ctx.isPcPowerSequenceRunning(), true);
    power.clock.advance(299);
    assert.deepEqual(power.keysAndText(), []);
    power.clock.advance(1);
    assert.deepEqual(power.calls.filter((call) => call.at === 300).map((call) => call.text), WIN_R);
    power.clock.advance(1999);
    assert.deepEqual(power.keysAndText(), WIN_R);
    power.clock.advance(1);
    assert.deepEqual(power.calls.filter((call) => call.at === 2300).map((call) => call.text),
      ['text ' + (kind === 'restart' ? 'shutdown /r /t 0' : 'shutdown /s /t 0')]);
    power.clock.advance(499);
    assert.equal(power.keysAndText().length, 5);
    power.clock.advance(1);
    assert.deepEqual(power.calls.filter((call) => call.at === 2800).map((call) => call.text), ENTER.concat(['paused false']));
    assert.equal(power.messages[1].text, kind === 'restart' ? 'Restart command sent to the PC' : 'Shutdown command sent to the PC');
    assert.equal(power.messages[1].at, 2800);
    // The countdown ends before it, so that the message shows at once
    assert.deepEqual(power.dismissals, [0, 2800]);
    assert.equal(power.ctx.isPcPowerSequenceRunning(), false);
    assert.equal(power.ctx.pcPowerCommand.sentAt, 2800);
    // The diagnostic log has the steps and never the command
    const log = power.log();
    ['Windows key + R sent', 'answer to the command: 0', 'Enter sent'].forEach((line) => assert.ok(log.indexOf(line) >= 0, line));
    assert.ok(log.indexOf('shutdown /') < 0, log);
    assert.ok(log.indexOf('PC power (' + kind + ', from the Stream Menu)') >= 0, log);
  });
}

test('from the PC list: the countdown starts once the video plays, or 10 s after the connection at the latest, and lasts 5 s', () => {
  const listeners = {};
  const video = {
    focus() {},
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type, fn) => {
      if (listeners[type] === fn) {
        delete listeners[type];
      }
    },
  };
  const power = loadPower({ video });
  power.ctx.armPcPowerCommand({ kind: 'shutdown', launchedApp: true });
  assert.deepEqual(Object.keys(listeners).sort(), ['playing', 'timeupdate']);
  assert.equal(power.ctx.isPcPowerSequenceRunning(), true);
  // No picture yet: no countdown and nothing sent
  power.clock.advance(3000);
  assert.deepEqual(power.messages, []);
  assert.deepEqual(power.keysAndText(), []);
  // The video plays: the countdown starts, Windows key + R 5 s later, the command 2 s after it, Enter 0.5 s after that
  listeners.timeupdate({ type: 'timeupdate' });
  assert.deepEqual(Object.keys(listeners), []);
  // It lasts until Enter, 7.5 s from now
  assert.deepEqual(power.messages, [{ at: 3000, timeout: 7500, text: 'GAMING-PC shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED' }]);
  power.clock.advance(4999);
  assert.deepEqual(power.keysAndText(), []);
  power.clock.advance(1);
  assert.deepEqual(power.keysAndText(), WIN_R);
  power.clock.advance(2000);
  assert.deepEqual(power.keysAndText(), WIN_R.concat(['text shutdown /s /t 0']));
  power.clock.advance(500);
  assert.deepEqual(power.keysAndText(), WIN_R.concat(['text shutdown /s /t 0']).concat(ENTER));
  assert.equal(power.calls.find((call) => call.text === 'key 800d,3,0').at, 10500);
  assert.ok(power.log().indexOf('PC power (shutdown, from the PC list): the picture shows (the video plays (timeupdate))') >= 0);

  // Without an answer of the video, the countdown starts after PC_POWER_PICTURE_WAIT_MS
  const quiet = loadPower();
  quiet.ctx.armPcPowerCommand({ kind: 'restart', launchedApp: false });
  quiet.clock.advance(9999);
  assert.deepEqual(quiet.messages, []);
  quiet.clock.advance(1);
  assert.deepEqual(quiet.messages.map((message) => message.text), ['GAMING-PC restarts in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED']);
  quiet.clock.advance(5000);
  assert.deepEqual(quiet.keysAndText(), WIN_R);
  quiet.clock.advance(2500);
  assert.deepEqual(quiet.keysAndText(), WIN_R.concat(['text shutdown /r /t 0']).concat(ENTER));
});

test('a command the module couldn\'t queue sends no Enter and closes Run; a stream that is gone gets no message', () => {
  const power = loadPower();
  power.state.textAnswer = -5;
  power.ctx.confirmStreamMenuPower('shutdown');
  power.clock.advance(2300);
  assert.deepEqual(power.keysAndText(), WIN_R.concat(['text shutdown /s /t 0']));
  assert.equal(power.messages[1].text, 'The command couldn\'t be sent to the PC. Try again.');
  // The countdown ended before it
  assert.deepEqual(power.dismissals, [0, 2300]);
  power.clock.advance(500);
  // Run is closed with Esc 500 ms later, the input of the PC comes back, and Enter never follows
  assert.deepEqual(power.sent(2300), ['text shutdown /s /t 0', ...ESC, 'paused false']);
  power.clock.advance(60000);
  assert.ok(!power.keysAndText().includes(ENTER[0]));
  assert.equal(power.messages.length, 2);
  assert.equal(power.ctx.isPcPowerSequenceRunning(), false);

  // -1: no stream (it stops): no Enter, no message, no Esc into a stream that is gone
  const gone = loadPower();
  gone.state.textAnswer = -1;
  gone.ctx.confirmStreamMenuPower('shutdown');
  gone.clock.advance(2300);
  gone.ctx.isInGame = false;
  gone.clock.advance(60000);
  assert.deepEqual(gone.keysAndText(), WIN_R.concat(['text shutdown /s /t 0']));
  assert.equal(gone.messages.length, 1);
});

for (const [step, at] of [['run', 299], ['type', 2299], ['enter', 2799]]) {
  test('a stream that ended before the step "' + step + '" gets nothing more, also when another stream runs by then', () => {
    for (const nextStream of [false, true]) {
      const power = loadPower();
      power.ctx.confirmStreamMenuPower('shutdown');
      power.clock.advance(at);
      const before = power.keysAndText();
      // The stream ends (its launch number changes), and maybe the next one runs already
      power.ctx.isInGame = false;
      power.ctx.streamLaunchId++;
      if (nextStream) {
        power.ctx.isInGame = true;
        power.ctx.streamLaunchId++;
      }
      power.clock.advance(60000);
      assert.deepEqual(power.keysAndText(), before, step + (nextStream ? ' with a next stream' : ''));
      assert.ok(power.log().indexOf('stopped before ' + step + ', since the stream ended') >= 0, power.log());
      assert.equal(power.ctx.isPcPowerSequenceRunning(), false);
    }
  });
}

test('the TV ends the stream during the sequence (RED, the background): Run is closed with Esc before the stream stops, nothing follows', () => {
  for (const at of [1000, 2500]) {
    const power = loadPower();
    power.ctx.confirmStreamMenuPower('shutdown');
    power.clock.advance(at);
    const before = power.keysAndText();
    // RED (endStartingOrRunningStream() of remote_controller.js)
    power.ctx.endStartingOrRunningStream();
    assert.deepEqual(power.sent(at), [...ESC, 'paused false', 'stopStream'], 'RED at ' + at);
    // The countdown, which is no longer true, ends at once
    assert.deepEqual(power.dismissals, [0, at], 'RED at ' + at);
    assert.equal(power.endStream(0), null, 'not sent: an ordinary end');
    power.clock.advance(60000);
    assert.deepEqual(power.keysAndText(), before.concat(ESC));
    assert.equal(power.ctx.pcPowerCommand, null);
  }
  // Before Windows key + R there is no Run to close
  const early = loadPower();
  early.ctx.confirmStreamMenuPower('shutdown');
  early.clock.advance(100);
  early.ctx.endStartingOrRunningStream();
  assert.deepEqual(early.sent(100), ['paused false', 'stopStream']);

  // Moonlight goes to the background after Windows key + R: the next step stops and closes Run in the stream that still
  // runs, until the background stop ends it. The stream that goes on gets the focus back, which the Stream Menu took, so
  // that the remote reaches it when Moonlight shows again.
  const focused = [];
  const hidden = loadPower({ video: { focus: () => focused.push('wasm_module'), dispatchEvent() {} } });
  hidden.ctx.confirmStreamMenuPower('shutdown');
  hidden.clock.advance(1000);
  hidden.doc.visibilityState = 'hidden';
  hidden.clock.advance(1300);
  assert.deepEqual(hidden.keysAndText(), WIN_R.concat(ESC));
  assert.ok(hidden.log().indexOf('stopped before type, since Moonlight is in the background') >= 0);
  assert.deepEqual(hidden.sent(2300), [...ESC, 'paused false']);
  assert.deepEqual(focused, ['wasm_module']);
  assert.deepEqual(hidden.dismissals, [0, 2300]);
  hidden.clock.advance(60000);
  assert.deepEqual(hidden.keysAndText(), WIN_R.concat(ESC));

  // The stream ended before a step: nothing gets the focus
  const endedFocus = [];
  const ended = loadPower({ video: { focus: () => endedFocus.push('wasm_module'), dispatchEvent() {} } });
  ended.ctx.confirmStreamMenuPower('shutdown');
  ended.clock.advance(1000);
  ended.ctx.isInGame = false;
  ended.clock.advance(1300);
  assert.deepEqual(endedFocus, []);

  // A refused text (-5) whose Esc still waits when the TV ends the stream: Run is closed at once, before the stream stops
  const refused = loadPower();
  refused.state.textAnswer = -5;
  refused.ctx.confirmStreamMenuPower('shutdown');
  refused.clock.advance(2400);
  refused.ctx.endStartingOrRunningStream();
  assert.deepEqual(refused.sent(2400), [...ESC, 'paused false', 'stopStream']);
  refused.clock.advance(60000);
  assert.deepEqual(refused.keysAndText(), WIN_R.concat(['text shutdown /s /t 0']).concat(ESC), 'one Esc');
});

test('RETURN cancels a sequence of the Stream Menu (the stream goes on) and ends the stream of a session of the PC list', () => {
  const remoteReturn = (power, repeat) => power.ctx.remoteControllerHandler({ keyCode: 10009, key: 'XF86Back', repeat: !!repeat, preventDefault() {} });
  const power = loadPower();
  power.ctx.tvKey = { KEY_LEFT: 37, KEY_DOWN: 40, KEY_RETURN: 10009 };
  power.ctx.confirmStreamMenuPower('shutdown');
  power.clock.advance(1000);
  remoteReturn(power);
  assert.deepEqual(power.sent(1000), [...ESC, 'paused false']);
  assert.equal(power.messages[power.messages.length - 1].text, 'Cancelled');
  // The countdown ends at once, so that 'Cancelled' shows in its place
  assert.deepEqual(power.dismissals, [0, 1000]);
  assert.equal(power.ctx.pcPowerCommand, null);
  power.clock.advance(60000);
  assert.deepEqual(power.keysAndText(), WIN_R.concat(ESC), 'no text and no Enter');
  assert.ok(!power.sent().includes('stopStream'));

  // From the PC list, RETURN ends the stream of the session (its auto-repeat goes no further)
  const list = loadPower();
  list.ctx.tvKey = { KEY_LEFT: 37, KEY_DOWN: 40, KEY_RETURN: 10009 };
  list.ctx.armPcPowerCommand({ kind: 'shutdown', launchedApp: true });
  list.clock.advance(12000);
  remoteReturn(list);
  assert.deepEqual(list.sent(12000), ['paused false', 'stopStream']);
  // The countdown of the fallback at 10 s ends at once
  assert.deepEqual(list.dismissals, [10000, 12000]);
  assert.equal(list.platform.get('returnCancelledStart'), true);
  assert.deepEqual(list.endStream(0), { ending: 'quit', mayRetry: false, kind: 'shutdown', host: { hostname: 'GAMING-PC' } });
});

test('a second confirmation while a sequence runs sends nothing more, and one after Enter replaces the first and its hint', () => {
  const power = loadPower();
  power.ctx.confirmStreamMenuPower('shutdown');
  power.clock.advance(1000);
  power.ctx.confirmStreamMenuPower('restart');
  power.clock.advance(5000);
  assert.deepEqual(power.keysAndText(), WIN_R.concat(['text shutdown /s /t 0']).concat(ENTER));

  // After Enter (the PC didn't shut down): a second command, whose hint shows once, and the first one's never
  power.ctx.confirmStreamMenuPower('restart');
  power.clock.advance(2800);
  const hints = () => power.messages.filter((message) => message.text.indexOf('hasn\'t') >= 0).map((message) => message.text);
  power.clock.advance(29999);
  assert.deepEqual(hints(), []);
  power.clock.advance(1);
  assert.deepEqual(hints(), ['The PC hasn\'t restarted. If Windows asks about open apps, answer on the PC. If nothing happened, switch to the desktop and try again.']);
  power.clock.advance(120000);
  assert.equal(hints().length, 1);
});

test('the hint shows once 30 s after Enter while the stream runs, and not after the stream ended', () => {
  const power = loadPower();
  power.ctx.confirmStreamMenuPower('shutdown');
  power.clock.advance(2800 + 30000);
  assert.deepEqual(power.messages.slice(2).map((message) => [message.at, message.text]), [[32800,
    'The PC hasn\'t shut down. If Windows asks about open apps, answer on the PC. If nothing happened, switch to the desktop and try again.']]);
  power.clock.advance(120000);
  assert.equal(power.messages.length, 3);
  assert.ok(power.log().indexOf('hint shown') >= 0);

  const ended = loadPower();
  ended.ctx.confirmStreamMenuPower('shutdown');
  ended.clock.advance(2800 + 10000);
  ended.endStream(-1);
  ended.clock.advance(60000);
  assert.equal(ended.messages.length, 2);
});

test('the end of the stream after the command: the PC within 30 s or with an error within 120 s, the TV within 30 s, else as usual', () => {
  // [what ends it, seconds after Enter, code, quit app, expected ending]
  const cases = [
    ['pc', 5, 0, false, 'pc'],
    ['pc', 5, -1, false, 'pc'],
    ['pc', 29, 0, false, 'pc'],
    // A game that closes after the hint (code 0) isn't the PC going off
    ['pc', 60, 0, false, null],
    ['pc', 60, -1, false, 'pc'],
    ['pc', 119, -102, false, 'pc'],
    ['pc', 130, -1, false, null],
    ['pc', 130, 0, false, null],
    // The video player of the TV failed: no end by the PC
    ['pc', 5, -200, false, null],
    ['pc', 5, -201, false, null],
    ['tv', 10, 0, false, 'tv'],
    ['tv', 40, 0, false, null],
    ['tv', 10, 0, true, null],
    ['tv', 130, 0, false, null],
  ];
  for (const [by, seconds, code, quitApp, expected] of cases) {
    for (const kind of ['shutdown', 'restart']) {
      const power = loadPower();
      power.ctx.confirmStreamMenuPower(kind);
      power.clock.advance(2800 + seconds * 1000);
      if (by === 'tv') {
        power.ctx.stopPcPowerCommandForTvStop();
      }
      const end = power.endStream(code, quitApp);
      const name = [by, seconds + ' s', code, quitApp ? 'quit' : '', kind].join(' ');
      assert.deepEqual(end, expected ? { ending: expected, kind, host: { hostname: 'GAMING-PC' } } : null, name);
      assert.equal(power.ctx.pcPowerCommand, null, name + ': no command goes into the next stream');
      assert.equal(power.clock.pending(), 0, name + ': no timer is left');
      if (expected) {
        assert.ok(power.log().indexOf('The stream ended') < 0 && power.log().indexOf('ended by the ' + by.toUpperCase() + '): back to the PC list') >= 0, power.log());
      }
    }
  }
  // No command: nothing to say
  assert.equal(loadPower().endStream(0), null);
  // A command that wasn't sent: a session of the PC list that launched its app quits it again, unless the stream starts
  // once more (no video, a held start), and keeps its request for that start
  const list = loadPower();
  list.ctx.streamPcPower = { kind: 'shutdown', launchedApp: true };
  list.ctx.armPcPowerCommand({ kind: 'shutdown', launchedApp: true });
  assert.deepEqual(list.endStream(-100), { ending: 'quit', mayRetry: true, kind: 'shutdown', host: { hostname: 'GAMING-PC' } });
  assert.deepEqual(plain(list.ctx.streamPcPower), { kind: 'shutdown', launchedApp: true });
  const listEnd = loadPower();
  listEnd.ctx.streamPcPower = { kind: 'shutdown', launchedApp: true };
  listEnd.ctx.armPcPowerCommand({ kind: 'shutdown', launchedApp: true });
  assert.deepEqual(listEnd.endStream(0), { ending: 'quit', mayRetry: false, kind: 'shutdown', host: { hostname: 'GAMING-PC' } });
  assert.equal(listEnd.ctx.streamPcPower, null);
  // One that resumed the running app leaves it running, and one of the Stream Menu ends as usual
  const resumed = loadPower();
  resumed.ctx.armPcPowerCommand({ kind: 'shutdown', launchedApp: false });
  assert.equal(resumed.endStream(0), null);
  const menu = loadPower();
  menu.ctx.confirmStreamMenuPower('shutdown');
  menu.clock.advance(1000);
  assert.equal(menu.endStream(-1), null);
});

test('a reconnect for new settings after Enter drops the command, so its end reconnects instead of going to the PC list', () => {
  const power = loadPower();
  power.ctx.confirmStreamMenuPower('shutdown');
  power.clock.advance(2800 + 10000);
  assert.equal(power.ctx.cancelPcPowerCommand('dropped for a reconnect with new settings'), true);
  // No Esc after Enter, no hint
  assert.deepEqual(power.keysAndText(), WIN_R.concat(['text shutdown /s /t 0']).concat(ENTER));
  assert.equal(power.endStream(0), null);
  power.clock.advance(60000);
  assert.equal(power.messages.length, 2);
});

test('the module input stays paused from the confirmation until Enter, and no command starts without a running stream', () => {
  const power = loadPower();
  power.ctx.confirmStreamMenuPower('shutdown');
  power.clock.advance(2800);
  assert.deepEqual(power.sent().filter((text) => text.indexOf('paused') === 0), ['paused true', 'paused false']);
  assert.equal(power.calls.find((call) => call.text === 'paused false').at, 2800);

  const none = loadPower();
  none.ctx.isStreamConnected = false;
  none.ctx.confirmStreamMenuPower('shutdown');
  none.clock.advance(60000);
  assert.deepEqual(none.keysAndText(), []);
  assert.equal(none.ctx.pcPowerCommand, null);
  assert.deepEqual(none.messages, []);
});

test('from the PC list, a picture that shows while Moonlight is hidden starts no countdown, and nothing is typed', () => {
  const power = loadPower();
  power.ctx.armPcPowerCommand({ kind: 'shutdown', launchedApp: true });
  power.clock.advance(3000);
  power.doc.visibilityState = 'hidden';
  // The longest wait for the picture ends while hidden
  power.clock.advance(7000);
  assert.deepEqual(power.messages, []);
  assert.ok(power.log().indexOf('stopped before the countdown, since Moonlight is in the background') >= 0, power.log());
  power.doc.visibilityState = 'visible';
  power.clock.advance(60000);
  assert.deepEqual(power.keysAndText(), []);
  assert.equal(power.ctx.isPcPowerSequenceRunning(), false);
});

test('a host without a name gets the sentences of the PC itself, never a name put together from another text', () => {
  const power = loadPower({ host: { hostname: '' } });
  power.ctx.confirmStreamMenuPower('shutdown');
  assert.deepEqual(power.messages.map((message) => message.text), ['The PC shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED']);
  const restart = loadPower({ host: {} });
  restart.ctx.confirmStreamMenuPower('restart');
  assert.deepEqual(restart.messages.map((message) => message.text), ['The PC restarts in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED']);
});

test('in the Stream Menu a held RETURN goes back one level, and a held RIGHT that opened a panel doesn\'t move on in it', () => {
  const power = loadPower();
  const steps = [];
  power.ctx.tvKey = { KEY_LEFT: 37, KEY_UP: 38, KEY_RIGHT: 39, KEY_DOWN: 40, KEY_ENTER: 13, KEY_RETURN: 10009 };
  power.ctx.Navigation = { back: () => steps.push('back'), right: () => steps.push('right'), down: () => steps.push('down'), accept: () => steps.push('accept') };
  const key = (keyCode, repeat) => power.ctx.remoteControllerHandler({ keyCode, key: '', repeat: !!repeat, preventDefault() {} });
  power.ctx.isStreamMenuOpen = true;
  // RETURN in a panel: one level back, its auto-repeat goes no further while the menu is open
  key(10009);
  key(10009, true);
  key(10009, true);
  assert.deepEqual(steps, ['back']);
  // Closed (the next RETURN closed it): the held-key logic of index.js keeps the repeats from the PC
  power.ctx.isStreamMenuOpen = false;
  key(10009, true);
  assert.deepEqual(steps, ['back', 'back']);

  // RIGHT opened a panel (streamMenuPanelKeyHeld): its auto-repeat doesn't move, a new press does
  steps.length = 0;
  power.ctx.isStreamMenuOpen = true;
  power.ctx.streamMenuPanelKeyHeld = true;
  key(39, true);
  key(39, true);
  assert.deepEqual(steps, []);
  key(39);
  key(39, true);
  assert.deepEqual(steps, ['right', 'right']);
  // Any other key pressed anew ends it as well
  power.ctx.streamMenuPanelKeyHeld = true;
  key(13);
  key(40, true);
  assert.deepEqual(steps, ['right', 'right', 'accept', 'down']);
});

test('choosePcPowerApp(): the app that runs is resumed, else the app named Desktop is launched, never the tiles of Apollo', () => {
  const app = loadPlatformScripts(INDEX_SCRIPTS, { tv: { tv: 's90c', conn: 'wifi' } });
  const choose = (list, currentGame) => plain(app.get('choosePcPowerApp')(list, currentGame));
  const apps = [{ id: 1, title: 'Cyberpunk 2077' }, { id: 2, title: ' desktop ' }, { id: 8, title: 'Steam Big Picture' }];
  assert.deepEqual(choose(apps, 8), { app: { id: 8, title: 'Steam Big Picture' }, launched: false });
  assert.deepEqual(choose(apps, '8'), { app: { id: 8, title: 'Steam Big Picture' }, launched: false });
  assert.deepEqual(choose(apps, 0), { app: { id: 2, title: ' desktop ' }, launched: true });
  // No Desktop app, or an app that runs but isn't in the list
  assert.equal(choose([{ id: 1, title: 'Cyberpunk 2077' }, { id: 3, title: 'Desktop 2' }], 0), null);
  assert.equal(choose(apps, 99), null);
  assert.equal(choose([], 0), null);
  // The Permission Denied tile and the Terminate tile of Apollo and Vibepollo are never streamed
  assert.equal(choose([{ id: 5, title: 'Desktop', uuid: 'E16CBE1B-295D-4632-9A76-EC4180C857D3' }], 0), null);
  assert.equal(choose([{ id: 114514, title: 'Permission Denied' }], 114514), null);
});
