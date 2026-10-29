'use strict';

// Checks that a failed connection names the ports of the host PC it needs: wasm/connectionlistener.cpp adds the ports
// of LiGetPortFlagsFromStage() to the message of a failed stage (formatted by wasm/connection_ports.hpp, pinned by
// tests/native/connection_message_test.cpp) and sends the ports of LiGetPortFlagsFromTerminationErrorCode() before a
// termination (tests/native/port_flags_test.c checks the port lists of moonlight-common-c). wasm/platform/messages.js
// translates the stage message and names the ports in the message of a stream that received no video.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const readLocale = (name) => JSON.parse(read('wasm/static/locales/' + name + '.json'));

// The message of the RTSP handshake as the native test expects it from FormatStageFailedMessage()
const RTSP_MESSAGE = 'RTSP handshake failed (error 10060)\n\n' +
  'Check that the firewall of the host PC and your router don\'t block these ports: TCP 48010, UDP 48000, UDP 48010';
// The ports as the page shows them: each protocol joined to its port with a no-break space, so that no line ends between
// them
const SHOWN_PORTS = 'TCP\u00a048010, UDP\u00a048000, UDP\u00a048010';

// Load messages.js with a t() that translates with the given locale like i18n.js does, recording the snackbar notices
function loadMessages(locale) {
  const messages = readLocale(locale || 'en-US');
  const format = (text, values) => text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  const t = (key, ...values) => format(Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key, values);
  const notices = [];
  const dialogs = [];
  const jquery = () => ({ css: jquery, removeClass: jquery, addClass: jquery, text: jquery, hide: jquery, show: jquery });
  // menus.js holds the Stream Menu state that the end of a stream resets
  const platform = loadPlatformScripts(['wasm/platform/messages.js', 'wasm/platform/menus.js'], {
    globals: {
      t,
      snackbarLogLong: (key, ...values) => notices.push(t(key, ...values)),
      warningDialog: (title, text) => dialogs.push({ title, text }),
      $: jquery,
      Rumble: { stopAll: () => {} },
      setTvScreenSaver: () => {},
      stopAudioScheduler: () => {},
      streamLaunchHost: null,
      api: null,
      streamLaunchId: 0,
      isInGame: true,
    },
  });
  return { platform, notices, dialogs, handleMessage: platform.get('handleMessage'), translate: platform.get('translateBackendMessage') };
}

test('the messages are those of the native test', () => {
  const nativeTest = read('tests/native/connection_message_test.cpp');
  assert.ok(nativeTest.includes('"RTSP handshake failed (error 10060)\\n\\n"'));
  assert.ok(nativeTest.includes('"Check that the firewall of the host PC and your router don\'t block these ports: "'));
  assert.ok(nativeTest.includes('"TCP 48010, UDP 48000, UDP 48010"'));
  assert.ok(read('tests/native/port_flags_test.c').includes('"UDP 47998, UDP 48000"'));
});

test('a failed stage shows its error and the ports in the connection error dialog, as two paragraphs', () => {
  const app = loadMessages('en-US');
  app.handleMessage('DialogMsg: ' + RTSP_MESSAGE);
  // The dialog shows HTML (warningDialog() in index.js): the blank line becomes a paragraph break, the rest stays text
  // (tests/browser/connection-error-dialog.test.js checks the lines that the dialog shows)
  assert.deepEqual(app.dialogs.map((dialog) => dialog.text), ['RTSP handshake failed (error 10060)<br><br>' +
    'Check that the firewall of the host PC and your router don&#39;t block these ports: ' + SHOWN_PORTS]);
  // A stage without ports keeps its message
  assert.equal(app.translate('video stream establishment failed (error -1)'), 'video stream establishment failed (error -1)');
  app.handleMessage('DialogMsg: video stream establishment failed (error -1)');
  assert.equal(app.dialogs[1].text, 'video stream establishment failed (error -1)');
});

test('Brazilian Portuguese translates the stage, its error and the hint, and keeps the ports', () => {
  const app = loadMessages('pt-BR');
  const pt = readLocale('pt-BR');
  const translated = app.translate(RTSP_MESSAGE);
  const expected = pt['%1$s failed (error %2$s)'].replace('%1$s', pt['RTSP handshake']).replace('%2$s', '10060') + '\n\n' +
    pt['Check that the firewall of the host PC and your router don\'t block these ports: %1$s'].replace('%1$s', SHOWN_PORTS);
  assert.equal(translated, expected);
  assert.doesNotMatch(translated, /failed|firewall of the host/);
});

test('a stream without video names the ports that the module sent before the termination', () => {
  const app = loadMessages('en-US');
  app.handleMessage('TerminationPortsMsg: UDP 47998, UDP 48000');
  app.handleMessage('streamTerminated: -100');
  assert.deepEqual(app.notices, ['No video received from host. Check that the firewall of the host PC and your router don\'t block these ports: ' +
    'UDP\u00a047998, UDP\u00a048000']);
  // The ports belong to that termination only
  app.platform.run('isInGame = true;');
  app.handleMessage('streamTerminated: -100');
  assert.equal(app.notices[1], 'No video received from host. Check the host PC\'s firewall and port forwarding rules.');
});

test('the native code sends the ports of the stage and of the termination, moved to the ports of the host', () => {
  const listener = read('wasm/connectionlistener.cpp');
  // Both lists come from LiStringifyPortFlags(), moved by the offset of the RTSP port in the session URL of the host
  // (connection_message_test.cpp checks the offset for a host with another port)
  assert.match(listener, /LiStringifyPortFlags\(portFlags, ", ", ports, sizeof\(ports\)\);\s+return MovePortList\(ports, GetPortOffsetFromSessionUrl\(g_Instance->m_RtspUrl\)\);/);
  assert.match(listener, /PostToJs\(std::string\("DialogMsg: "\) \+ FormatStageFailedMessage\(LiGetStageName\(stage\), errorCode,\s+GetHostPortList\(LiGetPortFlagsFromStage\(stage\)\)\)\);/);
  const terminated = listener.slice(listener.indexOf('void MoonlightInstance::ClConnectionTerminated'));
  const portsMessage = terminated.indexOf('PostToJs(std::string("TerminationPortsMsg: ") + ports);');
  const stopped = terminated.indexOf('onConnectionStopped, errorCode);');
  assert.ok(portsMessage > 0 && stopped > portsMessage, 'the ports must arrive before the termination');
  assert.match(terminated, /GetHostPortList\(LiGetPortFlagsFromTerminationErrorCode\(errorCode\)\)/);
  // The session URL that moonlight-common-c connects to is the one the host sent (main.cpp)
  assert.match(read('wasm/main.cpp'), /serverInfo\.rtspSessionUrl = me->m_RtspUrl\.c_str\(\);/);
});

test('the start of a stream drops the ports named for the termination of an earlier one', () => {
  const index = read('wasm/platform/index.js');
  const starts = index.split("sendMessage('startRequest'").length - 1;
  assert.equal(starts, 2);
  assert.equal((index.match(/terminationBlockedPorts = '';\s*rejectedVideoTrack = null;\s*sendMessage\('startRequest'/g) || []).length, starts);
});
