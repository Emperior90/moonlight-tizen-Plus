'use strict';

// Pins how the setting 'Prioritize sound on Wi-Fi' reaches the SDP of the stream, which the native tests can't check
// since they don't build the Embind registration or StartStream() of wasm/main.cpp:
// - startStream() of wasm/main.cpp and wasm/moonlight_wasm.hpp take it as their last parameter (audioQos), both start
//   requests of startGame() (index.js) send it last, from the switch, and StartStream() logs it and sets
//   disableAudioQos of the stream configuration to its opposite after LiInitializeStreamConfiguration(), which would
//   clear it again;
// - disableAudioQos is a local patch of Moonlight Plus to STREAM_CONFIGURATION (moonlight-common-c/src/Limelight.h),
//   and SdpGenerator.c reads it only on the local network, for the audio: the video keeps QoS 5, and a remote stream
//   asks for no QoS either way (tests/native/sdp_audio_qos_test.c runs the SDP);
// - the patch is in the list of the local changes of moonlight-common-c (.github/dependency-baselines.json).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The body of a function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

// The parameters of a C++ declaration or definition that starts with the given text, each as "type name"
function parameters(source, start) {
  const index = source.indexOf(start);
  assert.ok(index >= 0, start);
  const open = source.indexOf('(', index);
  const close = source.indexOf(')', open);
  return source.slice(open + 1, close).split(',').map((parameter) => parameter.trim().replace(/\s+/g, ' '));
}

test('startStream() takes the setting last as a bool, and both start requests send it from the switch', () => {
  const main = read('wasm/main.cpp');
  const header = read('wasm/moonlight_wasm.hpp');
  const definition = parameters(main, 'MessageResult startStream(');
  assert.equal(definition.length, 34);
  assert.equal(definition[definition.length - 1], 'bool audioQos');
  assert.equal(definition[definition.length - 2], 'std::string surroundQuality');
  assert.deepEqual(parameters(main, 'MessageResult MoonlightInstance::StartStream('), definition);
  assert.deepEqual(parameters(header, 'MessageResult startStream('), definition);
  assert.deepEqual(parameters(header, '  MessageResult StartStream('), definition);
  assert.match(functionBody(main, 'MessageResult startStream('), /controllerType, surroundQuality, audioQos\);/);

  const index = read('wasm/platform/index.js');
  const start = functionBody(index, 'function startGame(');
  assert.match(start, /const audioQos = \$\('#audioQosSwitch'\)\.parent\(\)\.hasClass\('is-checked'\) \? 1 : 0;/);
  // The log line of the start request names it (the diagnostic log keeps the console lines)
  assert.match(start, /'\\n Prioritize sound on Wi-Fi \(audio QoS on the local network\): ' \+ audioQos \+/);
  const requests = [...index.matchAll(/sendMessage\('startRequest', \[([\s\S]*?)\]\)\.catch\(/g)].map((match) =>
    match[1].split(',').map((argument) => argument.trim()).filter((argument) => argument !== ''));
  assert.equal(requests.length, 2);
  requests.forEach((request) => {
    assert.equal(request.length, definition.length, request.join(' '));
    assert.deepEqual(request.slice(-2), ['surroundQuality', 'audioQos']);
  });
  assert.match(read('wasm/platform/messages.js'), /hdrMetadata, controllerType, surroundQuality, audioQos \*\//);
});

test('StartStream() logs the setting and asks the library for the audio without QoS when it is off', () => {
  const start = functionBody(read('wasm/main.cpp'), 'MessageResult MoonlightInstance::StartStream(');
  assert.match(start, /PostToJs\("Setting the Prioritize sound on Wi-Fi to: " \+ std::to_string\(audioQos\)\);/);
  // Set after LiInitializeStreamConfiguration(), which clears the whole configuration, and only there
  const init = start.indexOf('LiInitializeStreamConfiguration(&m_StreamConfig);');
  const flag = start.indexOf('m_StreamConfig.disableAudioQos = !audioQos;');
  assert.ok(init >= 0 && flag > init, 'disableAudioQos is set after the configuration is cleared');
  assert.equal((read('wasm/main.cpp').match(/disableAudioQos\s*=/g) || []).length, 1);
  // The library decides local or remote, as before
  assert.match(start, /m_StreamConfig\.streamingRemotely = STREAM_CFG_AUTO;/);
});

test('disableAudioQos is a local patch of STREAM_CONFIGURATION that SdpGenerator.c reads for the audio of a local stream', () => {
  const limelight = read('moonlight-common-c/src/Limelight.h');
  const config = limelight.slice(limelight.indexOf('typedef struct _STREAM_CONFIGURATION {'),
    limelight.indexOf('} STREAM_CONFIGURATION, *PSTREAM_CONFIGURATION;'));
  assert.match(config, /\/\/ Moonlight Plus: if true, a stream on the local network asks the host to send its audio without QoS[\s\S]*?\n {4}bool disableAudioQos;\n$/);

  const sdp = read('moonlight-common-c/src/SdpGenerator.c');
  const qos = sdp.slice(sdp.indexOf('if (StreamConfig.streamingRemotely == STREAM_CFG_LOCAL) {'));
  assert.match(qos, /^if \(StreamConfig\.streamingRemotely == STREAM_CFG_LOCAL\) \{\s+err \|= addAttributeString\(&optionHead, "x-nv-vqos\[0\]\.qosTrafficType", "5"\);\s+(\/\/[^\n]*\n\s+)+err \|= addAttributeString\(&optionHead, "x-nv-aqos\.qosTrafficType", StreamConfig\.disableAudioQos \? "0" : "4"\);\s+\}\s+else \{\s+err \|= addAttributeString\(&optionHead, "x-nv-vqos\[0\]\.qosTrafficType", "0"\);\s+err \|= addAttributeString\(&optionHead, "x-nv-aqos\.qosTrafficType", "0"\);\s+\}/);
  // Nothing else in the library reads it, and the SDP has no other QoS attribute
  const library = fs.readdirSync(path.join(REPO_ROOT, 'moonlight-common-c/src'))
    .filter((name) => /\.[ch]$/.test(name) && !['Limelight.h', 'SdpGenerator.c'].includes(name));
  library.forEach((name) => assert.doesNotMatch(read('moonlight-common-c/src/' + name), /disableAudioQos/, name));
  assert.equal((sdp.match(/qosTrafficType/g) || []).length, 4);
  assert.match(read('tests/native/sdp_audio_qos_test.c'), /#include "\.\.\/\.\.\/moonlight-common-c\/src\/SdpGenerator\.c"/);
});

test('the patch is in the list of the local changes of moonlight-common-c', () => {
  const baselines = JSON.parse(read('.github/dependency-baselines.json'));
  const commonC = baselines.dependencies.find((entry) => entry.id === 'moonlight-common-c');
  assert.ok(commonC, 'the moonlight-common-c entry');
  assert.match(commonC.note, /disableAudioQos of STREAM_CONFIGURATION/);
  assert.match(commonC.note, /tests\/native\/sdp_audio_qos_test\.c/);
});
