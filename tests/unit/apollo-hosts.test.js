'use strict';

// Checks how the app reads the answers of Apollo and Vibepollo (wasm/platform/index.js): 410 to a launch is a notice of
// one of their control tiles (Terminate, Disconnect of Remote Monitor or Remote Input) or a request to launch again to
// confirm, not an error; 403 'Permission denied' means that this TV may not launch apps; and the 'Permission Denied'
// tile (ID 114514) that a client without the permission to list apps gets is never started. The answers are those of
// Apollo src/nvhttp.cpp and Vibepollo src/nvhttp.cpp and src/remote_session.cpp. The browser test
// tests/browser/apollo-hosts.test.js checks what the UI shows.

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

const app = loadPlatformScripts(INDEX_SCRIPTS, { tv: { tv: 's90c', conn: 'ethernet' } });

test('410 is a notice, 403 "Permission denied" a missing permission, anything else an error', () => {
  const classify = app.get('classifyLaunchAnswer');
  const answers = [
    // Apollo and Vibepollo after the Terminate tile
    [410, 'App terminated.', 'notice'],
    // Vibepollo asks to confirm with a second launch within 60 seconds
    ['410', 'An app is already running. Launch this app again within 60 seconds to confirm that you want to close it.', 'notice'],
    ['410', 'This will close the active stream but leave Remote Monitor and Remote Input connected. Launch Terminate again within 60 seconds to confirm this was intentional.', 'notice'],
    // Apollo without the permission Launch Apps, Vibepollo with the name of the permission
    ['403', 'Permission denied', 'permission'],
    ['403', 'Permission denied: this device lacks the "Launch applications" permission. Enable it on the host in the Vibepollo Web UI under Client Management.', 'permission'],
    // Other answers stay errors
    ['403', 'Encryption is mandatory for this host but unsupported by the client', 'error'],
    ['400', 'An app is already running on this host', 'error'],
    ['404', 'Cannot find requested application', 'error'],
    ['503', 'Failed to initialize video capture/encoding. Is a display connected and turned on?', 'error'],
    [418, 'Audio capture device is missing. Please reinstall the audio drivers.', 'error'],
    ['500', undefined, 'error'],
  ];
  answers.forEach(([code, message, kind]) => assert.equal(classify(code, message), kind, code + ' ' + message));
});

test('the Permission Denied tile of Apollo and Vibepollo is recognized by its ID and title', () => {
  const isTile = app.get('isHostPermissionTile');
  assert.equal(app.get('HOST_PERMISSION_TILE_ID'), '114514');
  assert.equal(isTile({ id: 114514, title: 'Permission Denied' }), true);
  assert.equal(isTile({ id: '114514', title: 'Permission denied - enable "List applications" for this device in the host\'s Web UI' }), true);
  // A real app with that ID or that title is started as usual
  assert.equal(isTile({ id: 114514, title: 'Steam Big Picture' }), false);
  assert.equal(isTile({ id: 13, title: 'Permission Denied' }), false);
  assert.equal(isTile(null), false);
});

test('the Terminate tile of Apollo and Vibepollo is recognized by its UUID, whatever its title', () => {
  const isTerminate = app.get('isHostTerminateTile');
  assert.equal(isTerminate({ id: 22, title: 'Terminate', uuid: 'E16CBE1B-295D-4632-9A76-EC4180C857D3' }), true);
  assert.equal(isTerminate({ id: 22, title: 'Beenden', uuid: 'e16cbe1b-295d-4632-9a76-ec4180c857d3' }), true);
  // Remote Input, an app without a UUID (Sunshine), or an app named Terminate is no control tile
  assert.equal(isTerminate({ id: 21, title: 'Remote Input', uuid: '8CB5C136-DA67-4F99-B4A1-F9CD35005CF4' }), false);
  assert.equal(isTerminate({ id: 22, title: 'Terminate' }), false);
  assert.equal(isTerminate(null), false);
});
