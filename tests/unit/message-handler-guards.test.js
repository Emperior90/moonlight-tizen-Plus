'use strict';

// Checks the JavaScript side of the handlers that the native code reaches (wasm/platform/messages.js): a handler that
// throws is logged and the app goes on. handleMessage() catches what a branch throws, and the end of a stream runs each
// of its steps on its own, so that an error in closeStreamMenu() or in one of the steps of leaveStreamView() no longer
// leaves the app in the stream view without a message. handlePromiseMessage() takes the callback of a request off the
// list before it calls it, and only logs an answer that no request waits for any more. The native side wraps the
// calls themselves (unit/em-asm-guards.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlatformScripts } = require('./helpers/platform-loader');

// Load messages.js and menus.js with stubs that record what the end of a stream does. `throwing` names the stubs that
// throw: 'closeStreamMenu', 'Rumble.stopAll', 'setTvScreenSaver', 'stopAudioScheduler' or 'Rumble.play'.
function loadMessages(throwing) {
  const broken = new Set(throwing || []);
  const steps = [];
  const step = (name, run) => function() {
    steps.push(name);
    if (broken.has(name)) {
      throw new Error(name + ' is broken');
    }
    return run ? run.apply(null, arguments) : undefined;
  };
  // jQuery for the DOM steps of leaveStreamView(): records the elements whose display changes
  const jquery = (selector) => {
    const chain = {
      css: (property, value) => {
        if (property === 'display') {
          steps.push(selector + ' display ' + value);
        }
        return chain;
      },
      removeClass: () => chain, addClass: () => chain, text: () => chain, hide: () => chain, show: () => chain,
    };
    return chain;
  };
  const platform = loadPlatformScripts(['wasm/platform/messages.js', 'wasm/platform/menus.js'], {
    globals: {
      t: (key) => key,
      snackbarLogLong: (key) => steps.push('message: ' + key),
      $: jquery,
      Rumble: { stopAll: step('Rumble.stopAll'), play: step('Rumble.play') },
      setTvScreenSaver: step('setTvScreenSaver'),
      stopAudioScheduler: step('stopAudioScheduler'),
      streamLaunchHost: null,
      api: null,
      streamLaunchId: 0,
      isInGame: true,
      wasmSessionStarted: true,
    },
  });
  // Record the Stream Menu closing at the end of the stream (menus.js)
  platform.context.closeStreamMenu = step('closeStreamMenu');
  return { platform, steps, errors: () => platform.consoleMessages.filter((entry) => entry.level === 'error').map((entry) => entry.text) };
}

test('an error in closeStreamMenu() at the end of a stream still leaves the stream view and shows the message', () => {
  const app = loadMessages(['closeStreamMenu']);
  assert.doesNotThrow(() => app.platform.get('handleMessage')('streamTerminated: -101'));
  assert.deepEqual(app.steps, ['closeStreamMenu', 'Rumble.stopAll', 'setTvScreenSaver', 'stopAudioScheduler',
    '#connection-warnings, #performance-stats display none', '#loadingSpinner display none', '#wasm_module display none',
    'message: Your network connection isn\'t performing well. Reduce your video bitrate setting or try a faster connection.']);
  assert.equal(app.platform.get('isInGame'), false);
  assert.equal(app.errors().length, 1);
  assert.match(app.errors()[0], /\[messages\.js, closeStreamMenu\].*Error: closeStreamMenu failed: Error: closeStreamMenu is broken/);
});

test('an error in a step of leaveStreamView() doesn\'t keep the steps after it from running', () => {
  for (const broken of ['Rumble.stopAll', 'setTvScreenSaver', 'stopAudioScheduler']) {
    const app = loadMessages([broken]);
    assert.doesNotThrow(() => app.platform.get('handleMessage')('streamTerminated: 0'), broken);
    assert.deepEqual(app.steps, ['closeStreamMenu', 'Rumble.stopAll', 'setTvScreenSaver', 'stopAudioScheduler',
      '#connection-warnings, #performance-stats display none', '#loadingSpinner display none', '#wasm_module display none'], broken);
    assert.equal(app.errors().length, 1, broken);
    assert.ok(app.errors()[0].indexOf('Error: ' + broken + ' failed:') >= 0, app.errors()[0]);
  }
});

test('a branch of handleMessage() that throws is logged instead of reaching the native caller', () => {
  const app = loadMessages(['Rumble.play']);
  assert.doesNotThrow(() => app.platform.get('handleMessage')('controllerRumble: 0,0.5,0.25'));
  assert.deepEqual(app.steps, ['Rumble.play']);
  assert.equal(app.errors().length, 1);
  assert.match(app.errors()[0], /\[messages\.js, handleMessage\].*Error: handleMessage failed: Error: Rumble\.play is broken/);
});

test('handlePromiseMessage() settles a request once, and only logs an answer that no request waits for', () => {
  const app = loadMessages([]);
  const handlePromiseMessage = app.platform.get('handlePromiseMessage');
  const settled = [];
  app.platform.context.__settled = settled;
  app.platform.run(`
    callbacks[41] = { resolve: (msg) => __settled.push('resolve ' + msg), reject: (msg) => __settled.push('reject ' + msg) };
    callbacks[42] = { resolve: () => { throw new Error('broken callback'); }, reject: () => {} };
  `);
  handlePromiseMessage(41, 'resolve', 'answer');
  assert.deepEqual(settled, ['resolve answer']);
  // A second answer to the same request, or one to a request that never existed
  assert.doesNotThrow(() => handlePromiseMessage(41, 'reject', 'late'));
  assert.doesNotThrow(() => handlePromiseMessage(99, 'resolve', 'unknown'));
  assert.deepEqual(settled, ['resolve answer']);
  const warnings = app.platform.consoleMessages.filter((entry) => entry.level === 'warn').map((entry) => entry.text);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[1].indexOf('No request waits for the answer resolve of request 99.') >= 0, warnings[1]);
  // A callback that throws is logged and taken off the list all the same
  assert.doesNotThrow(() => handlePromiseMessage(42, 'resolve', 'answer'));
  assert.equal(app.platform.get('Object.keys(callbacks).length'), 0);
  assert.equal(app.errors().length, 1);
  assert.match(app.errors()[0], /Error: handlePromiseMessage failed: Error: broken callback/);
});

test('an error in endPcPowerCommand() at the end of a stream still leaves the stream view and shows the message', () => {
  const app = loadMessages([]);
  app.platform.context.endPcPowerCommand = () => {
    app.steps.push('endPcPowerCommand');
    throw new Error('endPcPowerCommand is broken');
  };
  assert.doesNotThrow(() => app.platform.get('handleMessage')('streamTerminated: -101'));
  assert.deepEqual(app.steps, ['closeStreamMenu', 'endPcPowerCommand', 'Rumble.stopAll', 'setTvScreenSaver', 'stopAudioScheduler',
    '#connection-warnings, #performance-stats display none', '#loadingSpinner display none', '#wasm_module display none',
    'message: Your network connection isn\'t performing well. Reduce your video bitrate setting or try a faster connection.']);
  assert.equal(app.errors().length, 1);
  assert.match(app.errors()[0], /Error: endPcPowerCommand failed: Error: endPcPowerCommand is broken/);
});

test('the end of a stream after the power command of the PC goes to the PC list without the error, the retry or the reconnect', () => {
  for (const [ending, code, message] of [['pc', -100, 'message: %1$s is shutting down.'], ['pc', 0, 'message: %1$s is restarting.'], ['tv', -1, null]]) {
    const app = loadMessages([]);
    const context = app.platform.context;
    context.endPcPowerCommand = (errorCode) => {
      app.steps.push('endPcPowerCommand ' + errorCode);
      return { ending, kind: message && message.indexOf('restarting') >= 0 ? 'restart' : 'shutdown', host: { hostname: 'GAMING-PC' } };
    };
    context.showHosts = () => app.steps.push('showHosts');
    context.retryStreamStart = () => app.steps.push('retryStreamStart');
    context.resumeStreamAfterSettingsChange = () => app.steps.push('resumeStreamAfterSettingsChange');
    context.pendingStreamRestart = { bitrateMbps: 20 };
    app.platform.get('handleMessage')('streamTerminated: ' + code);
    assert.deepEqual(app.steps, ['closeStreamMenu', 'endPcPowerCommand ' + code, 'Rumble.stopAll', 'setTvScreenSaver', 'stopAudioScheduler',
      '#connection-warnings, #performance-stats display none', '#loadingSpinner display none', '#wasm_module display none', 'showHosts']
      .concat(message ? [message] : []), ending + ' ' + code);
    assert.equal(context.pendingStreamRestart, null);
    assert.deepEqual(app.errors(), []);
  }
});

test('the PC list says at once that the PC shuts down or restarts, in a sentence of its own for a PC without a name', () => {
  for (const [hostname, kind, message] of [['GAMING-PC', 'shutdown', 'message: %1$s is shutting down.'], ['', 'shutdown', 'message: The PC is shutting down.'],
    ['', 'restart', 'message: The PC is restarting.']]) {
    const app = loadMessages([]);
    const context = app.platform.context;
    context.streamLaunchHost = { hostname: '' };
    context.endPcPowerCommand = () => ({ ending: 'pc', kind, host: { hostname } });
    context.showHosts = () => app.steps.push('showHosts');
    // The message that still shows (the command sent, the hint) ends first
    context.dismissSnackbar = () => app.steps.push('dismissSnackbar');
    app.platform.get('handleMessage')('streamTerminated: 0');
    assert.deepEqual(app.steps.slice(-3), ['showHosts', 'dismissSnackbar', message], hostname + ' ' + kind);
    assert.deepEqual(app.errors(), []);
  }
});

test('a session of the PC list that launched its app quits it at an end before the command, unless the stream starts once more', () => {
  for (const retried of [true, false]) {
    const app = loadMessages([]);
    const context = app.platform.context;
    context.streamLaunchHost = { hostname: 'GAMING-PC', toString: () => 'GAMING-PC' };
    context.endPcPowerCommand = () => ({ ending: 'quit', mayRetry: true, kind: 'shutdown', host: context.streamLaunchHost });
    context.retryStreamStart = (kind) => {
      app.steps.push('retryStreamStart ' + kind);
      return retried;
    };
    context.stopGame = () => app.steps.push('stopGame');
    app.platform.get('handleMessage')('streamTerminated: -100');
    // Without the start once more, the app is quit (stopGame()) and the message of no video follows as usual
    const end = app.steps.filter((entry) => /^(retryStreamStart|stopGame)/.test(entry));
    assert.deepEqual(end, retried ? ['retryStreamStart noVideo'] : ['retryStreamStart noVideo', 'stopGame'], String(retried));
    assert.equal(app.steps.some((entry) => entry.indexOf('message: No video received') === 0), !retried, String(retried));
    // The stream view goes once (removeStreamView() of leaveStreamView()), or not at all for the start once more
    assert.equal(app.steps.filter((entry) => entry === 'setTvScreenSaver').length, retried ? 0 : 1, String(retried));
  }
});
