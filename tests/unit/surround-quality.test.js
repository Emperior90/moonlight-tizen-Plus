'use strict';

// Pins how the setting 'Surround audio quality' reaches the module, which the native tests can't check since they
// don't build the Embind registration or ConnectionThreadFunc() of wasm/main.cpp:
// - startStream() of wasm/main.cpp and wasm/moonlight_wasm.hpp take it as their last parameter, and both start requests
//   of startGame() (index.js) send exactly as many arguments, with it last, and StartStream() logs whether the stream
//   gets it (not a stereo stream, which keeps its quality);
// - the connection thread takes the capabilities of the audio renderer from GetAudioRendererCapabilities() of
//   wasm/audio_capabilities.h with the setting and the audio configuration of the stream, which
//   tests/native/sdp_audio_quality_test.c runs through the SDP negotiation of moonlight-common-c;
// - RtspConnection.c names the host 0.0.0.0 for a decoder that declares itself slow, which Sunshine reads as a request
//   for its low quality stereo, so the header must keep the flag away from stereo;
// - getAudioChannelCount(), which the Stream Menu reads to show its surround quality entry, is registered and answers
//   the channels of the audio statistics, and the mock of the module answers like it;
// - getStreamAudioChannels() of menus.js reads 0 without the call and a number with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// The body of a function, from its signature to the closing brace at the start of a line
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function not found: ' + signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'end of the function not found: ' + signature);
  return source.slice(start, end + 2);
}

// The parameter names of a C++ declaration or definition that starts with the given text
function parameters(source, start) {
  const index = source.indexOf(start);
  assert.ok(index >= 0, start);
  const open = source.indexOf('(', index);
  const close = source.indexOf(')', open);
  return source.slice(open + 1, close).split(',').map((parameter) => parameter.trim().split(/\s+/).pop());
}

test('startStream() takes the surround audio quality last, and both start requests send it', () => {
  const main = read('wasm/main.cpp');
  const header = read('wasm/moonlight_wasm.hpp');
  const definition = parameters(main, 'MessageResult startStream(');
  assert.equal(definition.length, 33);
  assert.equal(definition[definition.length - 1], 'surroundQuality');
  assert.deepEqual(parameters(main, 'MessageResult MoonlightInstance::StartStream('), definition);
  assert.deepEqual(parameters(header, 'MessageResult startStream('), definition);
  assert.deepEqual(parameters(header, '  MessageResult StartStream('), definition);
  // startStream() hands it on, and StartStream() logs and keeps it
  assert.match(functionBody(main, 'MessageResult startStream('), /refFrameInvalidation, hdrMetadata, controllerType, surroundQuality\);/);
  const start = functionBody(main, 'MessageResult MoonlightInstance::StartStream(');
  assert.match(start, /PostToJs\("Setting the Surround audio quality to: " \+ surroundQuality\);/);
  assert.match(start, /m_EfficientSurroundAudio = surroundQuality == "Efficient";/);
  // The log names what the stream gets, from the final audio configuration: Efficient changes only more than 2 channels
  assert.match(start, /\} else if \(CHANNEL_COUNT_FROM_AUDIO_CONFIGURATION\(m_StreamConfig\.audioConfiguration\) > 2\) \{\s+PostToJs\("Selecting the surround audio quality to: Efficient \(normal quality, 10 ms packets\)"\);\s+\} else \{\s+(\/\/[^\n]*\n\s+)*PostToJs\("Selecting the surround audio quality to: Efficient \(not applied: stereo\)"\);/);
  assert.ok(start.indexOf('m_AudioConfig = m_StreamConfig.audioConfiguration;') < start.indexOf('Efficient (normal quality, 10 ms packets)'));
  assert.match(main, /emscripten::function\("startStream", &startStream\);/);

  // The two start requests of startGame() (resume and launch) send one argument per parameter, the setting last
  const index = read('wasm/platform/index.js');
  const requests = [...index.matchAll(/sendMessage\('startRequest', \[([\s\S]*?)\]\);/g)].map((match) =>
    match[1].split(',').map((argument) => argument.trim()).filter((argument) => argument !== ''));
  assert.equal(requests.length, 2);
  requests.forEach((request) => {
    assert.equal(request.length, definition.length, request.join(' '));
    assert.equal(request[request.length - 1], 'surroundQuality');
  });
  assert.match(read('wasm/platform/messages.js'), /hdrMetadata, controllerType, surroundQuality \*\//);
});

test('the connection thread takes the capabilities of the audio renderer from audio_capabilities.h', () => {
  const main = read('wasm/main.cpp');
  assert.match(main, /#include "audio_capabilities\.h"/);
  const thread = functionBody(main, 'void* MoonlightInstance::ConnectionThreadFunc(void* context) {');
  assert.match(thread, /const int audioCapabilities = GetAudioRendererCapabilities\(me->m_AudioBackend == AudioBackend::WebAudio,\s+me->m_EfficientSurroundAudio, me->m_StreamConfig\.audioConfiguration\);/);
  assert.match(thread, /MoonlightInstance::s_ArCallbacks\.capabilities = audioCapabilities;/);
  // Every flag it can set is named in the log of the stream start
  ['CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION', 'CAPABILITY_SLOW_OPUS_DECODER'].forEach((flag) => {
    assert.match(thread, new RegExp('if \\(audioCapabilities & ' + flag + '\\) \\{\\s+audioCapabilityNames \\+= " \\| ' + flag + '";'));
  });
  // The capabilities are only set there, before every connection
  assert.equal((main.replace(/\/\/.*$/gm, '').match(/s_ArCallbacks\.capabilities\s*=/g) || []).length, 1);
  // The header declares the decoder slow for more than 2 channels only
  const header = read('wasm/audio_capabilities.h');
  assert.match(header, /if \(efficientSurround && CHANNEL_COUNT_FROM_AUDIO_CONFIGURATION\(audioConfiguration\) > 2\) \{\s+capabilities \|= CAPABILITY_SLOW_OPUS_DECODER;/);
  assert.match(read('tests/native/sdp_audio_quality_test.c'), /#include "\.\.\/\.\.\/wasm\/audio_capabilities\.h"/);
});

test('RtspConnection.c names the host 0.0.0.0 for a slow decoder, which is why stereo never declares one', () => {
  const rtsp = read('moonlight-common-c/src/RtspConnection.c');
  assert.match(rtsp, /if \(StreamConfig\.bitrate >= HIGH_AUDIO_BITRATE_THRESHOLD &&\s+\(AudioCallbacks\.capabilities & CAPABILITY_SLOW_OPUS_DECODER\) == 0 &&/);
  assert.match(rtsp, /else \{\s+PltSafeStrcpy\(urlAddr, sizeof\(urlAddr\), "0\.0\.0\.0"\);/);
});

test('getAudioChannelCount() answers the channels of the audio statistics, and the mock and the Stream Menu read it', () => {
  const main = read('wasm/main.cpp');
  assert.match(main, /emscripten::function\("getAudioChannelCount", &getAudioChannelCount\);/);
  assert.match(functionBody(main, 'int getAudioChannelCount() {'), /return g_AudioStreamStats\.channelCount\.load\(\);/);
  assert.match(read('wasm/moonlight_wasm.hpp'), /^int getAudioChannelCount\(\);$/m);
  // The statistics have 0 channels while the audio output is disabled (AudDecInit() in auddec.cpp)
  assert.match(functionBody(read('wasm/auddec.cpp'), 'int MoonlightInstance::AudDecInit('),
    /if \(s_AudioBackend == AudioBackend::Disabled\) \{\s+\/\/ No audio lines in the performance stats\s+g_AudioStreamStats\.channelCount = 0;/);
  assert.match(read('tests/browser/mocks/moonlight-wasm.js'), /Module\.getAudioChannelCount = function\(\) \{/);

  const withModule = (module) => loadPlatformScripts(['wasm/platform/menus.js'], { globals: { Module: module } }).get('getStreamAudioChannels')();
  assert.equal(withModule({}), 0, 'a module without the call');
  assert.equal(withModule({ getAudioChannelCount: () => 6 }), 6);
  assert.equal(withModule({ getAudioChannelCount: () => 0 }), 0);
  assert.equal(withModule({ getAudioChannelCount: () => undefined }), 0);
});
