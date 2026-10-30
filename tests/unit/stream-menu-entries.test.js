'use strict';

// Pins the pure logic of the bitrate entry and of 'Type text…' of the Stream Menu (wasm/platform/menus.js): the steps of
// 5 Mbps within 5 Mbps and the decoder cap of the TV (getDecoderCapMbps() in tv_profile.js), also from a bitrate of the
// slider that lies between the steps or above the cap; the check of a text for the PC before it goes to sendText() of
// the module, with the same answers and the same limit as wasm/text_input.hpp, including the lone surrogate that the
// module can't see; a message for every answer that isn't sent; and the keys that the field of the text panel leaves to
// the field. The browser tests (tests/browser/stream-menu-entries.test.js) run both entries in the page, the native test
// tests/native/text_input_test.cpp the module side.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// menus.js with tv_profile.js for the decoder cap, the capabilities of a TV, and a translation that marks each key
function loadMenus(caps) {
  const format = (text, values) => text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  return loadPlatformScripts(['wasm/platform/tv_profile.js', 'wasm/platform/menus.js'], {
    globals: { t: (text, ...values) => format('T[' + text + ']', values), TextEncoder, tvCapabilities: caps || null },
  });
}

test('LEFT and RIGHT step the bitrate to the next multiple of 5 Mbps within the range', () => {
  const step = loadMenus().get('stepStreamBitrate');
  const range = { min: 5, max: 100 };
  const walk = (start, direction, presses) => {
    const seen = [];
    let mbps = start;
    for (let i = 0; i < presses; i++) {
      mbps = step(mbps, direction, range);
      seen.push(mbps);
    }
    return seen;
  };
  assert.deepEqual(walk(40, 1, 3), [45, 50, 55]);
  assert.deepEqual(walk(40, -1, 3), [35, 30, 25]);
  // A bitrate of the slider between the steps goes to the next step in the direction of the key
  assert.equal(step(37.5, 1, range), 40);
  assert.equal(step(37.5, -1, range), 35);
  assert.equal(step(0.5, 1, range), 5);
  // The limits stay where they are
  assert.deepEqual(walk(90, 1, 4), [95, 100, 100, 100]);
  assert.deepEqual(walk(15, -1, 4), [10, 5, 5, 5]);
  // Below the lowest step the bitrate only goes up, above the highest it only goes down, straight to the highest one
  assert.equal(step(2, -1, range), 2);
  assert.equal(step(2, 1, range), 5);
  assert.equal(step(150, 1, range), 150);
  assert.equal(step(150, -1, range), 100);
  assert.equal(step(102.5, -1, range), 100);
});

test('the range of the bitrate entry ends at the decoder cap of the TV', () => {
  // The tested profile of the S90C (100 Mbps), a 4K TV without a profile (80 Mbps) and a Full HD TV (50 Mbps)
  const cases = [
    [{ profile: { decoderCapMbps: 100 }, is4k: true }, 100],
    [{ profile: null, is4k: true, is8k: false }, 80],
    [{ profile: null, is4k: false, is8k: true }, 80],
    [{ profile: null, is4k: false, is8k: false }, 50],
  ];
  for (const [caps, max] of cases) {
    const menus = loadMenus(caps);
    assert.deepEqual(plain(menus.get('getStreamMenuBitrateRange()')), { min: 5, max: max }, JSON.stringify(caps));
    assert.equal(menus.get('getDecoderCapMbps')(menus.get('tvCapabilities')), max);
    // Never above the cap, however often RIGHT is pressed
    let mbps = 5;
    for (let i = 0; i < 40; i++) {
      mbps = menus.get('stepStreamBitrate')(mbps, 1, menus.get('getStreamMenuBitrateRange()'));
    }
    assert.equal(mbps, max);
  }
});

test('a text for the PC is checked like sendText() of the module, with its answers and its limit', () => {
  const menus = loadMenus();
  const check = menus.get('checkStreamText');
  // The answers and the limit are those of wasm/text_input.hpp
  const header = read('wasm/text_input.hpp');
  const native = (name) => Number(new RegExp(name + ' = (-?\\d+)').exec(header)[1]);
  assert.deepEqual([menus.get('TEXT_INPUT_OK'), menus.get('TEXT_INPUT_NO_STREAM'), menus.get('TEXT_INPUT_EMPTY'),
    menus.get('TEXT_INPUT_TOO_LONG'), menus.get('TEXT_INPUT_INVALID'), menus.get('TEXT_INPUT_NOT_SENT')],
  [native('kTextInputOk'), native('kTextInputNotStreaming'), native('kTextInputEmpty'), native('kTextInputTooLong'),
    native('kTextInputInvalid'), native('kTextInputNotSent')]);
  assert.equal(menus.get('TEXT_INPUT_MAX_BYTES'), native('kTextInputMaxBytes'));

  assert.equal(check('Hello PC'), 0);
  assert.equal(check('Grüße, ¿qué tal? 東京 😀'), 0);
  assert.equal(check(' '), 0, 'spaces are text');
  assert.equal(check(''), -2);
  assert.equal(check(null), -2);
  // The limit counts bytes of UTF-8: 1024 ASCII characters, 512 two-byte ones, 256 emoji of four bytes
  assert.equal(check('a'.repeat(1024)), 0);
  assert.equal(check('a'.repeat(1025)), -3);
  assert.equal(check('ü'.repeat(512)), 0);
  assert.equal(check('ü'.repeat(513)), -3);
  assert.equal(check('😀'.repeat(256)), 0);
  assert.equal(check('😀'.repeat(256) + 'a'), -3);
  // A lone surrogate, which the string conversion of Emscripten 1.39 would join with the next character
  assert.equal(check('a\ud83db'), -4);
  assert.equal(check('\ude00'), -4);
  assert.equal(check('x\ud83d'), -4);
  // Control characters: line breaks and Tab go to the PC as keys, not as text
  for (const control of ['\n', '\r', '\t', '\u0000', '\u001b', '\u007f', '\u0085', '\u009f']) {
    assert.equal(check('a' + control + 'b'), -4, JSON.stringify(control));
  }
  // The characters next to them are text
  assert.equal(check(' ~ '), 0);
});

test('every answer that isn\'t sent has a message of its own, and none names the text', () => {
  const menus = loadMenus();
  const message = menus.get('getStreamTextError');
  const messages = [-1, -2, -3, -4, -5].map((result) => message(result));
  assert.deepEqual(messages, [
    'T[The text can\'t be sent, since the stream has ended.]',
    'T[Type a text first.]',
    'T[The text is too long to send at once. Send it in shorter parts.]',
    'T[The text has a character that can\'t be sent.]',
    'T[The text couldn\'t be sent. Try again.]',
  ]);
  // An answer that the module may give one day is a failure to send
  assert.equal(message(-9), messages[4]);
});

test('the field of the text panel leaves the keys of the keyboard to the field', () => {
  const menus = loadMenus();
  const handled = [].concat(plain(menus.get('STREAM_TEXT_SEND_KEYS')), plain(menus.get('STREAM_TEXT_CANCEL_KEYS')),
    plain(menus.get('STREAM_TEXT_LEAVE_KEYS')), plain(menus.get('STREAM_TEXT_REMOTE_KEYS')));
  // Enter and the Done key of the keyboard of the TV send, RETURN, its Cancel key and Esc cancel, DOWN and Tab leave
  assert.deepEqual(plain(menus.get('STREAM_TEXT_SEND_KEYS')), [13, 65376]);
  assert.deepEqual(plain(menus.get('STREAM_TEXT_CANCEL_KEYS')), [10009, 65385, 27]);
  assert.deepEqual(plain(menus.get('STREAM_TEXT_LEAVE_KEYS')), [40, 9]);
  // The keys that type, edit or move in the field are none of them: letters, digits (also of the remote), space,
  // Backspace, Delete, LEFT, RIGHT, UP, Home, End and the key of a composition of the keyboard of the TV (229)
  for (const keyCode of [65, 90, 48, 57, 32, 8, 46, 37, 39, 38, 36, 35, 229, 186, 222]) {
    assert.equal(handled.indexOf(keyCode), -1, String(keyCode));
  }
  // The keys of the remote that keep their action in the Stream Menu: the coloured keys, Play/Pause, Play, Pause, CH+, CH-
  const platform = read('res/platform.js');
  const code = (name) => Number(new RegExp(name + ': (\\d+)').exec(platform)[1]);
  assert.deepEqual(plain(menus.get('STREAM_TEXT_REMOTE_KEYS')), ['KEY_RED', 'KEY_GREEN', 'KEY_YELLOW', 'KEY_BLUE', 'KEY_PLAY_PAUSE',
    'KEY_PLAY', 'KEY_PAUSE', 'KEY_CHANNEL_UP', 'KEY_CHANNEL_DOWN'].map(code));
});

test('the text panel logs only the answer of a text, never the text or its length', () => {
  const source = read('wasm/platform/menus.js');
  const start = source.indexOf('function sendStreamText()');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const logs = body.split('\n').filter((line) => /console\.\w+\(/.test(line));
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.ok(logs[0].indexOf("'Answer to the text for the PC: ' + result") >= 0, logs[0]);
  assert.ok(!/text\b(?!')|\.length/.test(logs[0].replace(/'[^']*'/g, '')), logs[0]);
});
