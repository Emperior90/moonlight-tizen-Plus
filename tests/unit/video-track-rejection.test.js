'use strict';

// Pins the message of a stream that ends with error -200 after the TV rejected its video track:
// handleMessage() in wasm/platform/messages.js keeps the video format of the 'VideoTrackRejected: ' message that
// wasm/wasmplayer.cpp sends (the formats of tests/fixtures/video-track-rejections.tsv, whose writing side
// tests/native/video_track_rejection_test.cpp checks), and the stream termination that follows names the codec,
// resolution and frame rate with what to change. Without that message, the generic text stays. The browser tests show
// the message in the real page (tests/browser/runtime-checks.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const GENERIC = 'The TV was unable to start the streaming with the selected video settings. Try reducing the resolution or frame rate and consider changing the codec.';

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
    ['H.264,1280,720,144', 'Choose HEVC as the video codec, or lower the frame rate.'],
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
