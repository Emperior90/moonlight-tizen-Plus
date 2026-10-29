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

test('both Enter keys accept and prevent the native click', () => {
  const { recorder, press } = loadRemoteController();
  assert.equal(press('KEY_ENTER'), true);
  assert.equal(press('KEY_REMOTE_ENTER'), true);
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

test('YELLOW toggles the performance statistics only while streaming', () => {
  const remote = loadRemoteController();
  remote.press('KEY_YELLOW');
  remote.platform.run('isInGame = true;');
  remote.press('KEY_YELLOW');
  assert.deepEqual(remote.moduleCalls, ['toggleStats']);
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
  // The key handler no longer sets the unused flag isGamepadActive (removed in plan WP6), which would create a global
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
