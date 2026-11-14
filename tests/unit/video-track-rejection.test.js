'use strict';

// Pins the message of a stream that ends with error -200 after the TV rejected its video track:
// handleMessage() in wasm/platform/messages.js keeps the video format of the 'VideoTrackRejected: ' message that
// wasm/wasmplayer.cpp sends (the formats of tests/fixtures/video-track-rejections.tsv, whose writing side
// tests/native/video_track_rejection_test.cpp checks), and the stream termination that follows names the codec,
// resolution and frame rate with what to change. Without that message, the generic text stays. The browser tests show
// the message in the real page (tests/browser/runtime-checks.test.js).
// An H.264 stream that the host sent because it couldn't encode the selected codec ('CodecFallbackMsg: H264' of
// ReportVideoFormatFallback() in wasm/wasmplayer.cpp, which comes before the video track is added) is not told to choose
// HEVC: HEVC was selected already, or AV1 with HEVC as its fallback, and the host provided neither.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const GENERIC = 'The TV was unable to start the streaming with the selected video settings. Try reducing the resolution or frame rate and consider changing the codec.';
const H264_FALLBACK_NOTICE = 'The host PC can\'t encode the selected codec, so the stream uses H.264 instead, which Samsung TVs generally decode only up to 1080p.';
const HEVC_FALLBACK_NOTICE = 'The host PC can\'t encode the selected codec, so the stream uses HEVC instead.';
const FALLBACK_REJECTED = 'The PC can\'t encode the selected codec, so it sent %1$s, which the TV rejected at %2$sx%3$s@%4$s FPS. ';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR'];

// The lines of the fixture as { videoFormat, width, height, fps, message }
function readFixture() {
  return fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'video-track-rejections.tsv'), 'utf8')
    .split('\n')
    .filter((line) => line && line[0] !== '#')
    .map((line) => {
      const fields = line.split('\t');
      return { videoFormat: parseInt(fields[0], 16), width: Number(fields[1]), height: Number(fields[2]), fps: Number(fields[3]), message: fields[4] };
    });
}

// Load messages.js with the page functions that the end of a stream calls, recording the snackbar notices translated
// with the source texts
function loadMessages() {
  const notices = [];
  const format = (text, values) => text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  const jquery = () => ({ css: jquery, removeClass: jquery, addClass: jquery, text: jquery, hide: jquery, show: jquery });
  // menus.js holds the Stream Menu state that the end of a stream resets
  const platform = loadPlatformScripts(['wasm/platform/messages.js', 'wasm/platform/menus.js'], {
    globals: {
      t: (text, ...values) => format(text, values),
      snackbarLogLong: (text, ...values) => notices.push(format(text, values)),
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
  return { platform, notices, handleMessage: platform.get('handleMessage') };
}

test('the message of each rejected video format of the fixture names it and what to change', () => {
  const advice = {
    // H.264 above 1080p, and within 1080p, where only a lower frame rate (or HEVC) helps
    'H.264': (entry) => (entry.width > 1920 || entry.height > 1080
      ? 'Choose HEVC as the video codec, or a resolution up to 1080p.'
      : 'Choose HEVC as the video codec, or lower the frame rate.'),
    HEVC: () => 'Lower the resolution or frame rate.',
    'HEVC Main10': () => 'Turn off HDR, or lower the resolution or frame rate.',
    AV1: () => 'Choose HEVC as the video codec.',
    'AV1 Main10': () => 'Choose HEVC as the video codec.',
  };
  const cases = readFixture();
  assert.equal(cases.length, 7);
  for (const entry of cases) {
    const { notices, handleMessage, platform } = loadMessages();
    handleMessage(entry.message);
    const codec = entry.message.replace('VideoTrackRejected: ', '').split(',')[0];
    assert.deepEqual(plain(platform.get('rejectedVideoTrack')), { codec, width: entry.width, height: entry.height, fps: entry.fps }, entry.message);
    handleMessage('streamTerminated: -200');
    assert.deepEqual(notices, ['The TV rejected ' + codec + ' at ' + entry.width + 'x' + entry.height + '@' + entry.fps + ' FPS. ' + advice[codec](entry)], entry.message);
    assert.equal(platform.get('rejectedVideoTrack'), null);
  }
});

test('H.264 within 1080p is not told to choose a resolution up to 1080p, which it already has', () => {
  for (const [format, advice] of [
    ['H.264,1920,1080,120', 'Choose HEVC as the video codec, or lower the frame rate.'],
    ['H.264,1280,720,90', 'Choose HEVC as the video codec, or lower the frame rate.'],
    ['H.264,1920,1200,60', 'Choose HEVC as the video codec, or a resolution up to 1080p.'],
    ['H.264,2560,1080,60', 'Choose HEVC as the video codec, or a resolution up to 1080p.'],
  ]) {
    const { notices, handleMessage } = loadMessages();
    handleMessage('VideoTrackRejected: ' + format);
    handleMessage('streamTerminated: -200');
    const [codec, width, height, fps] = format.split(',');
    assert.deepEqual(notices, ['The TV rejected ' + codec + ' at ' + width + 'x' + height + '@' + fps + ' FPS. ' + advice], format);
  }
});

test('an AV1 Main10 stream at 4K60', () => {
  const { notices, handleMessage } = loadMessages();
  handleMessage('VideoTrackRejected: AV1 Main10,3840,2160,60');
  handleMessage('streamTerminated: -200');
  assert.deepEqual(notices, ['The TV rejected AV1 Main10 at 3840x2160@60 FPS. Choose HEVC as the video codec.']);
});

test('without a rejected video track, error -200 keeps the generic message', () => {
  const { notices, handleMessage } = loadMessages();
  // e.g. a step of the media pipeline setup that timed out, or a player that rejected the frames
  handleMessage('streamTerminated: -200');
  assert.deepEqual(notices, [GENERIC]);
});

test('the rejected video format belongs to its stream only', () => {
  const { notices, handleMessage, platform } = loadMessages();
  // A stream that ends otherwise drops it, so a later -200 of another stream gets the generic message
  handleMessage('VideoTrackRejected: HEVC,3840,2160,120');
  handleMessage('streamTerminated: 0');
  assert.equal(platform.get('rejectedVideoTrack'), null);
  handleMessage('streamTerminated: -200');
  handleMessage('VideoTrackRejected: HEVC,3840,2160,120');
  handleMessage('streamTerminated: -201');
  handleMessage('streamTerminated: -200');
  assert.deepEqual(notices, [GENERIC, 'The video player of the TV stopped with an error during the stream. Start the stream again; if it keeps happening, try a lower bitrate, resolution or frame rate.', GENERIC]);
});

test('a message in another format keeps the generic text', () => {
  const parse = loadMessages().platform.get('parseVideoTrackRejection');
  assert.deepEqual(plain(parse('AV1 Main10,3840,2160,60')), { codec: 'AV1 Main10', width: 3840, height: 2160, fps: 60 });
  assert.deepEqual(plain(parse(' HEVC,1920,1080,60 ')), { codec: 'HEVC', width: 1920, height: 1080, fps: 60 });
  for (const text of ['', 'AV1 Main10', 'AV1,3840,2160', 'AV1,3840,2160,60,1', ',3840,2160,60', 'AV1,wide,2160,60']) {
    assert.equal(parse(text), null, JSON.stringify(text));
  }
  const { notices, handleMessage } = loadMessages();
  handleMessage('VideoTrackRejected: AV1');
  handleMessage('streamTerminated: -200');
  assert.deepEqual(notices, [GENERIC]);
});

test('H.264 that the PC sent instead of the selected codec is not told to choose HEVC', () => {
  for (const [format, advice] of [
    // The default: HEVC selected at 4K60, and a PC that can only encode H.264
    ['H.264,3840,2160,60', 'Choose a resolution up to 1080p.'],
    ['H.264,2560,1440,120', 'Choose a resolution up to 1080p.'],
    ['H.264,1920,1200,60', 'Choose a resolution up to 1080p.'],
    // Within 1080p only a lower frame rate is left
    ['H.264,1920,1080,120', 'Lower the frame rate.'],
    ['H.264,1280,720,90', 'Lower the frame rate.'],
  ]) {
    const { notices, handleMessage, platform } = loadMessages();
    handleMessage('CodecFallbackMsg: H264');
    assert.equal(platform.get('streamCodecFallback'), 'H264');
    handleMessage('VideoTrackRejected: ' + format);
    handleMessage('streamTerminated: -200');
    const [codec, width, height, fps] = format.split(',');
    const message = 'The PC can\'t encode the selected codec, so it sent ' + codec + ', which the TV rejected at ' + width + 'x' + height +
      '@' + fps + ' FPS. ' + advice;
    assert.deepEqual(notices, [H264_FALLBACK_NOTICE, message], format);
    assert.equal(message.indexOf('HEVC'), -1);
    // It belongs to this stream only, like the rejected format
    assert.equal(platform.get('streamCodecFallback'), '');
    assert.equal(platform.get('rejectedVideoTrack'), null);
  }
});

test('the codec that the PC sent instead belongs to its stream only, and only H.264 changes the message', () => {
  // A stream with the fallback ends otherwise: the next stream, with H.264 selected, gets the advice to choose HEVC
  const first = loadMessages();
  first.handleMessage('CodecFallbackMsg: H264');
  first.handleMessage('streamTerminated: 0');
  assert.equal(first.platform.get('streamCodecFallback'), '');
  first.handleMessage('VideoTrackRejected: H.264,3840,2160,60');
  first.handleMessage('streamTerminated: -200');
  assert.deepEqual(first.notices, [H264_FALLBACK_NOTICE,
    'The TV rejected H.264 at 3840x2160@60 FPS. Choose HEVC as the video codec, or a resolution up to 1080p.']);

  // HEVC instead of AV1: the messages of a rejected HEVC stream never named a codec to choose
  for (const [format, advice] of [
    ['HEVC,3840,2160,120', 'Lower the resolution or frame rate.'],
    ['HEVC Main10,3840,2160,120', 'Turn off HDR, or lower the resolution or frame rate.'],
  ]) {
    const { notices, handleMessage, platform } = loadMessages();
    handleMessage('CodecFallbackMsg: HEVC');
    assert.equal(platform.get('streamCodecFallback'), 'HEVC');
    handleMessage('VideoTrackRejected: ' + format);
    handleMessage('streamTerminated: -200');
    const [codec, width, height, fps] = format.split(',');
    assert.deepEqual(notices, [HEVC_FALLBACK_NOTICE, 'The TV rejected ' + codec + ' at ' + width + 'x' + height + '@' + fps + ' FPS. ' + advice], format);
  }

  // SDR instead of HDR is no other codec, and a text that the app doesn't know is none either
  const other = loadMessages();
  other.handleMessage('CodecFallbackMsg: SDR');
  other.handleMessage('CodecFallbackMsg: bogus');
  assert.equal(other.platform.get('streamCodecFallback'), '');
  other.handleMessage('VideoTrackRejected: H.264,3840,2160,60');
  other.handleMessage('streamTerminated: -200');
  assert.equal(other.notices[other.notices.length - 1],
    'The TV rejected H.264 at 3840x2160@60 FPS. Choose HEVC as the video codec, or a resolution up to 1080p.');
  // H.264 instead of the selected codec and SDR instead of HDR together (a PC without HEVC and HDR on)
  const both = loadMessages();
  both.handleMessage('CodecFallbackMsg: H264');
  both.handleMessage('CodecFallbackMsg: SDR');
  assert.equal(both.platform.get('streamCodecFallback'), 'H264');
});

test('the start of a stream drops the codec fallback of an earlier one, and the module reports it before the track', () => {
  const index = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'platform', 'index.js'), 'utf8');
  const starts = index.split("sendMessage('startRequest'").length - 1;
  assert.equal(starts, 2);
  assert.equal((index.match(/streamCodecFallback = '';\s*terminationBlockedPorts = '';\s*rejectedVideoTrack = null;\s*sendMessage\('startRequest'/g) || []).length, starts);
  // VidDecSetup() reports the fallback first and adds the video track, which the TV may reject, after it
  const source = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'wasmplayer.cpp'), 'utf8');
  const setup = source.slice(source.indexOf('int MoonlightInstance::VidDecSetup('));
  const report = setup.indexOf('ReportVideoFormatFallback(g_Instance->m_RequestedVideoFormat, videoFormat);');
  const track = setup.indexOf('int initVidDec = StartupVidDecSetup(');
  assert.ok(report > 0 && track > report);
  assert.match(source, /PostToJs\(std::string\("CodecFallbackMsg: "\) \+ negotiatedCodec\);/);
  assert.match(source, /static const char\* VideoCodecName\(int videoFormat\) \{[\s\S]*?return "AV1";[\s\S]*?return "HEVC";[\s\S]*?return "H264";\s*\}/);
});

test('every language has the two messages of an H.264 stream that the PC sent instead, with their figures', () => {
  for (const advice of ['Choose a resolution up to 1080p.', 'Lower the frame rate.']) {
    const key = FALLBACK_REJECTED + advice;
    const messages = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'platform', 'messages.js'), 'utf8');
    assert.ok(messages.indexOf("snackbarLogLong('" + key.replace(/'/g, "\\'") + "'") >= 0, key);
    for (const locale of LOCALES) {
      const texts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'static', 'locales', locale + '.json'), 'utf8'));
      const text = texts[key];
      assert.equal(typeof text, 'string', locale + ': ' + key);
      ['%1$s', '%2$sx%3$s@%4$s FPS', '1080p'].slice(0, advice.indexOf('1080p') >= 0 ? 3 : 2).forEach((part) => {
        assert.ok(text.indexOf(part) >= 0, locale + ' lacks ' + part + ': ' + text);
      });
      // No language tells to choose a codec that the PC didn't provide
      assert.equal(/HEVC|AV1/.test(text), false, locale + ': ' + text);
      if (locale !== 'en-US') {
        assert.notEqual(text, key, locale);
      }
    }
  }
});

test('wasmplayer.cpp sends the message only when the TV rejected every profile of a start that was not cancelled', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'wasmplayer.cpp'), 'utf8');
  assert.ok(source.indexOf('#include "video_track_rejection.hpp"') >= 0);
  const block = /if \(!videoTrackAdded\) \{([\s\S]*?)return ERROR_VIDEO_SETUP_FAILED;/.exec(source);
  assert.ok(block, 'the failure of the video track');
  assert.match(block[1], /if \(!g_Instance->m_ConnectionCancelled\) \{\s*PostToJs\(FormatVideoTrackRejectedMessage\(videoFormat, width, height, redrawRate\)\);\s*\}/);
  assert.equal(source.split('FormatVideoTrackRejectedMessage(').length - 1, 1);
});

test('the start of a stream drops a rejected video format of an earlier one', () => {
  const index = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'platform', 'index.js'), 'utf8');
  const starts = index.split("sendMessage('startRequest'").length - 1;
  assert.equal(starts, 2);
  assert.equal((index.match(/rejectedVideoTrack = null;\s*sendMessage\('startRequest'/g) || []).length, starts);
});
