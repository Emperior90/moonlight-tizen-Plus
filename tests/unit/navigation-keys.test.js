'use strict';

// Pins the key handling of the menus: the Navigation API of wasm/platform/navigation.js, the TV keys that
// initSamsungKeys() registers, and what remoteControllerHandler() (wasm/platform/remote_controller.js) does for each key.
// The gamepad mapping of the menus is in tests/unit/gamepad-menu-handler.test.js and tests/browser/gamepad-menu.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

const NAVIGATION_API = ['up', 'down', 'left', 'right', 'accept', 'back', 'press', 'switch', 'push', 'change', 'pop', 'start', 'stop'];

// Navigation stub that records the operations the key handler runs
function createNavigationRecorder() {
  const operations = [];
  const navigation = {};
  NAVIGATION_API.forEach((name) => {
    navigation[name] = () => operations.push(name);
  });
  return { navigation, operations };
}

// Load res/platform.js and remote_controller.js with recording stubs, and let platformOnLoad() set the key codes
function loadRemoteController(globals) {
  const recorder = createNavigationRecorder();
  const moduleCalls = [];
  const platform = loadPlatformScripts(['res/platform.js', 'wasm/platform/remote_controller.js'], {
    globals: Object.assign({
      Navigation: recorder.navigation,
      Module: {
        stopStream: () => moduleCalls.push('stopStream'),
        toggleStats: () => moduleCalls.push('toggleStats'),
      },
      cancelStreamLaunch: () => moduleCalls.push('cancelStreamLaunch'),
      toggleStreamMenu: () => moduleCalls.push('toggleStreamMenu'),
      // The level of the performance statistics in the settings (index.js), Compact here
      getPerformanceStatsLevel: () => 1,
      savePerformanceStatsLevel: (level) => moduleCalls.push('savePerformanceStatsLevel ' + level),
      isInGame: false,
      wasmSessionStarted: false,
    }, globals || {}),
  });
  platform.run('platformOnLoad({})');
  const tvKey = plain(platform.get('tvKey'));
  // Press a key by name, e.g. press('KEY_UP'), and return whether the default action was prevented
  const press = (keyName, extra) => {
    let prevented = false;
    const event = Object.assign({ keyCode: tvKey[keyName], repeat: false, preventDefault: () => { prevented = true; } }, extra || {});
    platform.get('remoteControllerHandler')(event);
    return prevented;
  };
  return { platform, recorder, moduleCalls, tvKey, press };
}

test('the Navigation API offers these operations', () => {
  const platform = loadPlatformScripts(['wasm/platform/navigation.js']);
  assert.deepEqual(plain(platform.get('Object.keys(Navigation)')), NAVIGATION_API);
  assert.equal(platform.get('typeof Navigation.move'), 'undefined');
});

test('the TV key codes that the handler compares with', () => {
  const { tvKey } = loadRemoteController();
  assert.deepEqual({
    KEY_UP: tvKey.KEY_UP, KEY_DOWN: tvKey.KEY_DOWN, KEY_LEFT: tvKey.KEY_LEFT, KEY_RIGHT: tvKey.KEY_RIGHT,
    KEY_ENTER: tvKey.KEY_ENTER, KEY_REMOTE_ENTER: tvKey.KEY_REMOTE_ENTER, KEY_RETURN: tvKey.KEY_RETURN,
    KEY_CHANNEL_UP: tvKey.KEY_CHANNEL_UP, KEY_CHANNEL_DOWN: tvKey.KEY_CHANNEL_DOWN,
    KEY_RED: tvKey.KEY_RED, KEY_YELLOW: tvKey.KEY_YELLOW,
    KEY_VOLUME_UP: tvKey.KEY_VOLUME_UP, KEY_VOLUME_DOWN: tvKey.KEY_VOLUME_DOWN, KEY_VOLUME_MUTE: tvKey.KEY_VOLUME_MUTE,
  }, {
    KEY_UP: 38, KEY_DOWN: 40, KEY_LEFT: 37, KEY_RIGHT: 39,
    KEY_ENTER: 13, KEY_REMOTE_ENTER: 32, KEY_RETURN: 10009,
    KEY_CHANNEL_UP: 427, KEY_CHANNEL_DOWN: 428,
    KEY_RED: 403, KEY_YELLOW: 405,
    KEY_VOLUME_UP: 447, KEY_VOLUME_DOWN: 448, KEY_VOLUME_MUTE: 449,
  });
});

test('initSamsungKeys() registers the color, source, channel list, channel and media keys', () => {
  const platform = loadPlatformScripts(['res/platform.js', 'wasm/platform/remote_controller.js'].concat(INDEX_SCRIPTS));
  platform.run('initSamsungKeys()');
  const registered = platform.tvCalls.filter((call) => call.name === 'tizen.tvinputdevice.registerKey').map((call) => call.args[0]);
  assert.deepEqual(registered, ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Source', 'ChannelList', 'ChannelDown', 'ChannelUp',
    'MediaPlayPause', 'MediaPlay', 'MediaPause']);
  // The key handler listens on the document
  assert.equal(platform.documentListeners.keydown.length, 1);
  assert.equal(platform.documentListeners.keydown[0], platform.get('remoteControllerHandler'));
});

test('the arrow keys move in the menus', () => {
  const { recorder, press } = loadRemoteController();
  ['KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT'].forEach((key) => press(key));
  assert.deepEqual(recorder.operations, ['up', 'down', 'left', 'right']);
});

test('the arrow keys keep the browser from scrolling, except in a text field and during a stream', () => {
  const remote = loadRemoteController();
  const ARROWS = ['KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT'];
  // The page and the controls that the menus move between (a switch is a check box, the bitrate a range slider)
  [undefined, { tagName: 'DIV' }, { tagName: 'BUTTON', type: 'button' }, { tagName: 'INPUT', type: 'checkbox' },
    { tagName: 'INPUT', type: 'range' }].forEach((target) => {
    ARROWS.forEach((key) => assert.equal(remote.press(key, { target }), true, key + ' on ' + JSON.stringify(target)));
  });
  // A text field needs them for its caret, a drop-down list for its options
  [{ tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'number' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true }].forEach((target) => {
    ARROWS.forEach((key) => assert.equal(remote.press(key, { target }), false, key + ' in ' + JSON.stringify(target)));
  });
  // During a stream they keep their own action, for the PC
  remote.platform.run('isInGame = true; wasmSessionStarted = true;');
  ARROWS.forEach((key) => assert.equal(remote.press(key, { target: { tagName: 'DIV' } }), false, key + ' during a stream'));
  // The menus move for every press
  assert.equal(remote.recorder.operations.length, 4 * 11);
  // The other keys keep their own action as before
  remote.platform.run('isInGame = false; wasmSessionStarted = false;');
  assert.equal(remote.press('KEY_RETURN', { target: { tagName: 'DIV' } }), false);
  assert.equal(remote.press('KEY_CHANNEL_UP', { target: { tagName: 'DIV' } }), false);
});

test('a held arrow key drops the repeats that came before its last step reached the screen, and a press always moves', () => {
  // The animation frames and the task after them run when the test says, at the time of its clock
  const frames = [];
  const tasks = [];
  const clock = { now: 1000 };
  const remote = loadRemoteController({
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback) => tasks.push(callback),
    performance: { now: () => clock.now },
  });
  const operations = remote.recorder.operations;
  const showSteps = (time) => {
    clock.now = time;
    frames.splice(0).forEach((callback) => callback());
    tasks.splice(0).forEach((callback) => callback());
  };
  assert.equal(remote.press('KEY_RIGHT', { timeStamp: 1000 }), true);
  // The remote repeats the held key before the step is on the screen: the repeat is dropped, and still doesn't scroll
  assert.equal(remote.press('KEY_RIGHT', { repeat: true, timeStamp: 1010 }), true);
  assert.equal(remote.press('KEY_DOWN', { repeat: true, timeStamp: 1020 }), true);
  assert.deepEqual(operations, ['right']);
  // A press moves whenever it comes
  remote.press('KEY_LEFT', { timeStamp: 1030 });
  assert.deepEqual(operations, ['right', 'left']);
  // Once the frame of the last step ran, a repeat that the remote sent before then is still dropped, a later one moves
  showSteps(1100);
  remote.press('KEY_LEFT', { repeat: true, timeStamp: 1090 });
  remote.press('KEY_LEFT', { repeat: true, timeStamp: 1110 });
  assert.deepEqual(operations, ['right', 'left', 'left']);
  remote.press('KEY_UP', { repeat: true, timeStamp: 1120 });
  showSteps(1200);
  remote.press('KEY_UP', { repeat: true, timeStamp: 1210 });
  assert.deepEqual(operations, ['right', 'left', 'left', 'up']);
  // A step that comes between the frame of the step before and the task after that frame is still on its way then
  frames.splice(0).forEach((callback) => callback());
  remote.press('KEY_UP', { timeStamp: 1220 });
  clock.now = 1230;
  tasks.splice(0).forEach((callback) => callback());
  remote.press('KEY_UP', { repeat: true, timeStamp: 1235 });
  showSteps(1300);
  remote.press('KEY_UP', { repeat: true, timeStamp: 1310 });
  assert.deepEqual(operations, ['right', 'left', 'left', 'up', 'up', 'up']);
  // The repeat of other keys and the arrow keys during a stream (e.g. in the Stream Menu) are left as they were
  remote.press('KEY_RETURN', { repeat: true, timeStamp: 1305 });
  remote.platform.run('isInGame = true; wasmSessionStarted = true;');
  remote.press('KEY_DOWN', { repeat: true, timeStamp: 1306 });
  assert.deepEqual(operations, ['right', 'left', 'left', 'up', 'up', 'up', 'back', 'down']);
});

test('a held arrow key still moves every half second when the times of its repeats look stale for good', () => {
  // A TV whose key events carry times of another clock, or whose frames don't come: no frame runs here, so every repeat
  // looks as if it came before the last step reached the screen
  const clock = { now: 1000 };
  const remote = loadRemoteController({
    requestAnimationFrame: () => {},
    setTimeout: () => {},
    performance: { now: () => clock.now },
  });
  const operations = remote.recorder.operations;
  remote.press('KEY_RIGHT', { timeStamp: 1000 });
  // Repeats every 100 ms: dropped within 500 ms of the last step, and the first one after that moves again
  for (let time = 1100; time <= 2200; time += 100) {
    clock.now = time;
    remote.press('KEY_RIGHT', { repeat: true, timeStamp: time - 50 });
  }
  assert.deepEqual(operations, ['right', 'right', 'right']);
});

test('both Enter keys accept and prevent the native click', () => {
  const { recorder, press } = loadRemoteController();
  assert.equal(press('KEY_ENTER'), true);
  assert.equal(press('KEY_REMOTE_ENTER'), true);
  assert.deepEqual(recorder.operations, ['accept', 'accept']);
});

test('the auto-repeat of a held OK is ignored, so it can\'t also press the item of the view that the first press opened', () => {
  const { recorder, press } = loadRemoteController();
  // The views change at once (e.g. a host opens its apps), so a repeat would start the selected app
  assert.equal(press('KEY_ENTER'), true);
  assert.equal(press('KEY_ENTER', { repeat: true }), true, 'still no native click');
  assert.equal(press('KEY_REMOTE_ENTER', { repeat: true }), true);
  assert.deepEqual(recorder.operations, ['accept']);
  // The next press accepts again
  press('KEY_ENTER');
  assert.deepEqual(recorder.operations, ['accept', 'accept']);
});

test('Return goes back, CH+ presses and CH- switches', () => {
  const { recorder, press } = loadRemoteController();
  press('KEY_RETURN');
  press('KEY_CHANNEL_UP');
  press('KEY_CHANNEL_DOWN');
  assert.deepEqual(recorder.operations, ['back', 'press', 'switch']);
});

test('the volume keys control the TV volume', () => {
  const { platform, recorder, press } = loadRemoteController();
  press('KEY_VOLUME_UP');
  press('KEY_VOLUME_DOWN');
  press('KEY_VOLUME_MUTE');
  assert.deepEqual(platform.tvCalls.map((call) => call.name), ['tizen.tvaudiocontrol.setVolumeUp', 'tizen.tvaudiocontrol.setVolumeDown', 'tizen.tvaudiocontrol.setMute']);
  assert.deepEqual(recorder.operations, []);
});

test('RED stops a running stream, cancels a starting one and ignores the auto-repeat', () => {
  const remote = loadRemoteController();
  remote.press('KEY_RED');
  assert.deepEqual(remote.moduleCalls, [], 'nothing outside a stream');
  remote.platform.run('isInGame = true; wasmSessionStarted = false;');
  remote.press('KEY_RED');
  assert.deepEqual(remote.moduleCalls, ['cancelStreamLaunch'], 'a stream that is still starting is cancelled');
  remote.platform.run('wasmSessionStarted = true;');
  remote.press('KEY_RED', { repeat: true });
  assert.deepEqual(remote.moduleCalls, ['cancelStreamLaunch'], 'the auto-repeat of a held key is ignored');
  remote.press('KEY_RED');
  assert.deepEqual(remote.moduleCalls, ['cancelStreamLaunch', 'stopStream']);
});

test('YELLOW toggles the performance statistics only while streaming, and steps the setting while the stream starts', () => {
  const remote = loadRemoteController();
  remote.press('KEY_YELLOW');
  assert.deepEqual(remote.moduleCalls, [], 'nothing in the menus');
  // 'Starting...': the start request hands the next level of the setting to the module
  remote.platform.run('isInGame = true;');
  remote.press('KEY_YELLOW');
  assert.deepEqual(remote.moduleCalls, ['savePerformanceStatsLevel 2']);
  remote.platform.run('wasmSessionStarted = true;');
  remote.press('KEY_YELLOW');
  assert.deepEqual(remote.moduleCalls, ['savePerformanceStatsLevel 2', 'toggleStats']);
});

test('Play/Pause, Play and Pause toggle the Stream Menu in a stream and open the menu of a host or app otherwise', () => {
  const remote = loadRemoteController();
  assert.deepEqual({ KEY_PLAY_PAUSE: remote.tvKey.KEY_PLAY_PAUSE, KEY_PLAY: remote.tvKey.KEY_PLAY, KEY_PAUSE: remote.tvKey.KEY_PAUSE },
    { KEY_PLAY_PAUSE: 10252, KEY_PLAY: 415, KEY_PAUSE: 19 });
  // In the menus they press like CH+
  assert.equal(remote.press('KEY_PLAY_PAUSE', { key: 'MediaPlayPause' }), true);
  remote.press('KEY_PLAY', { key: 'MediaPlay' });
  remote.press('KEY_PAUSE', { key: 'MediaPause' });
  assert.deepEqual(remote.recorder.operations, ['press', 'press', 'press']);
  assert.deepEqual(remote.moduleCalls, []);
  // During a stream they open or close the Stream Menu, once per press
  remote.platform.run('isInGame = true; wasmSessionStarted = true;');
  remote.press('KEY_PLAY_PAUSE', { key: 'MediaPlayPause' });
  remote.press('KEY_PLAY_PAUSE', { key: 'MediaPlayPause', repeat: true });
  remote.press('KEY_PAUSE', { key: 'MediaPause' });
  assert.deepEqual(remote.moduleCalls, ['toggleStreamMenu', 'toggleStreamMenu']);
  assert.deepEqual(remote.recorder.operations, ['press', 'press', 'press']);
});

test('the Pause/Break key of a keyboard, which has the key code of Pause, opens no menu', () => {
  const remote = loadRemoteController();
  remote.press('KEY_PAUSE', { key: 'Pause' });
  remote.platform.run('isInGame = true; wasmSessionStarted = true;');
  assert.equal(remote.press('KEY_PAUSE', { key: 'Pause' }), false);
  assert.deepEqual(remote.recorder.operations, []);
  assert.deepEqual(remote.moduleCalls, []);
  const isMenuKeyEvent = remote.platform.get('isMenuKeyEvent');
  assert.equal(isMenuKeyEvent({ keyCode: 19, key: 'Pause' }), false);
  assert.equal(isMenuKeyEvent({ keyCode: 19, key: 'MediaPause' }), true);
  assert.equal(isMenuKeyEvent({ keyCode: 10252, key: 'MediaPlayPause' }), true);
  assert.equal(isMenuKeyEvent({ keyCode: 403, key: 'ColorF0Red' }), false);
});

test('other keys do nothing', () => {
  const remote = loadRemoteController();
  remote.press('KEY_BLUE');
  remote.press('KEY_GREEN');
  assert.deepEqual(remote.recorder.operations, []);
  assert.deepEqual(remote.moduleCalls, []);
  // The key handler no longer sets the unused flag isGamepadActive (removed in 1.19.100), which would create a global
  assert.equal(remote.platform.get('typeof isGamepadActive'), 'undefined');
});

test('every Navigation call in the platform scripts names an existing operation', () => {
  const platformDir = path.join(REPO_ROOT, 'wasm', 'platform');
  const unknown = [];
  fs.readdirSync(platformDir).filter((name) => name.endsWith('.js')).forEach((name) => {
    const source = fs.readFileSync(path.join(platformDir, name), 'utf8');
    const pattern = /\bNavigation\.([A-Za-z_$][\w$]*)\s*\(/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (NAVIGATION_API.indexOf(match[1]) < 0) {
        unknown.push(name + ': Navigation.' + match[1] + '()');
      }
    }
  });
  assert.deepEqual(unknown, []);
});
