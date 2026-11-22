'use strict';

// Pins how long the snackbar shows a message (wasm/platform/index.js). Since 2.3.3 snackbarLogLong() shows a message for
// the time it takes to read its translated text on a TV from the couch (getSnackbarLongTimeout()): 1.5 s to notice it
// and 50 ms per character, at least 5 s, as every long message before 2.3.3, and at most 15 s, since the messages that
// come meanwhile wait in the queue of the snackbar. snackbarLog() keeps its 2.5 s and snackbarLogFor() the exact time of
// its caller (the countdown of 'Shut down or restart the PC'). The browser test tests/browser/snackbar.test.js checks the
// time that the real snackbar of MDL gets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
const readLocale = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales', name + '.json'), 'utf8'));

// A t() that translates with a locale file like i18n.js does
function translator(locale) {
  const messages = readLocale(locale);
  return (key, ...values) => {
    const text = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key;
    return text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  };
}

// The messages that end a start without a usable answer of the PC (endStreamStartWithoutAnswer() and
// endStreamStartWithInvalidAnswer() in index.js), the longest that a user must read to know what to do next
const START_TIMEOUT = '%1$s didn\'t answer the start of %2$s within %3$s seconds. A command that Sunshine (or another GameStream host) runs before the app, e.g. to switch the display, may be waiting on the PC. End it or restart Sunshine, then start the app again.';
const INVALID_REPLY = '%1$s answered the start of %2$s with an invalid reply, e.g. after an error in Sunshine (or another GameStream host). Check the log of Sunshine (or the other host) on the PC, then start the app again.';

// index.js in a language, with a showSnackbarMessage() that records the text and the time of each message
function loadIndex(locale) {
  const platform = loadPlatformScripts(INDEX_SCRIPTS, { tv: { tv: 's90c', conn: 'wifi' }, globals: { t: translator(locale || 'en-US') } });
  platform.run('var __shown = []; showSnackbarMessage = function(message, timeoutMs) { __shown.push({ message: message, timeoutMs: timeoutMs }); };');
  return platform;
}

test('a long message shows 1.5 seconds plus 50 ms per character, from 5 to 15 seconds', () => {
  const platform = loadIndex();
  assert.equal(platform.get('SNACKBAR_LONG_MIN_MS'), 5000);
  assert.equal(platform.get('SNACKBAR_LONG_MAX_MS'), 15000);
  assert.equal(platform.get('SNACKBAR_LONG_NOTICE_MS'), 1500);
  assert.equal(platform.get('SNACKBAR_LONG_MS_PER_CHARACTER'), 50);
  const timeout = platform.get('getSnackbarLongTimeout');
  // Up to 70 characters: the 5 seconds that every long message had before 2.3.3
  assert.equal(timeout(''), 5000);
  assert.equal(timeout('x'.repeat(70)), 5000);
  assert.equal(timeout('x'.repeat(71)), 5050);
  assert.equal(timeout('x'.repeat(200)), 11500);
  // From 270 characters: 15 seconds, however long the text (e.g. a notice of the host)
  assert.equal(timeout('x'.repeat(270)), 15000);
  assert.equal(timeout('x'.repeat(2000)), 15000);
  // The length of what the user reads: a value that isn't a string counts by its text
  assert.equal(timeout(12345), 5000);
});

test('each kind of message gets its time: 2.5 s, the time of its length, or the time of its caller', () => {
  const platform = loadIndex();
  platform.get('snackbarLog')('No app is currently running.');
  platform.get('snackbarLogLong')('Mouse emulation is activated');
  platform.get('snackbarLogLong')(START_TIMEOUT, 'GAMING-PC', 'Cyberpunk 2077', 120);
  platform.get('snackbarLogFor')(2800, 'No app is currently running.');
  const shown = plain(platform.get('__shown'));
  assert.deepEqual(shown.map((entry) => entry.timeoutMs), [2500, 5000, 14150, 2800]);
  // The start that the PC didn't answer: 253 characters in English with the PC, the app and the seconds filled in
  assert.equal(shown[2].message.length, 253);
  assert.ok(shown[2].message.startsWith('GAMING-PC didn\'t answer the start of Cyberpunk 2077 within 120 seconds.'));
});

test('the time follows the translated text, and the two start failures show at least 12 seconds in every language', () => {
  LOCALES.forEach((locale) => {
    const platform = loadIndex(locale);
    const t = translator(locale);
    platform.get('snackbarLogLong')(START_TIMEOUT, 'GAMING-PC', 'Cyberpunk 2077', 120);
    platform.get('snackbarLogLong')(INVALID_REPLY, 'GAMING-PC', 'Cyberpunk 2077');
    const shown = plain(platform.get('__shown'));
    assert.equal(shown[0].message, t(START_TIMEOUT, 'GAMING-PC', 'Cyberpunk 2077', 120), locale);
    assert.equal(shown[1].message, t(INVALID_REPLY, 'GAMING-PC', 'Cyberpunk 2077'), locale);
    shown.forEach((entry) => {
      assert.equal(entry.timeoutMs, Math.min(15000, Math.max(5000, 1500 + 50 * entry.message.length)), locale);
      assert.ok(entry.timeoutMs >= 12000, locale + ': ' + entry.timeoutMs + ' ms for ' + entry.message.length + ' characters');
    });
  });
  // German is longer than English, so its start timeout gets the 15 seconds
  const german = loadIndex('de-DE');
  german.get('snackbarLogLong')(START_TIMEOUT, 'GAMING-PC', 'Cyberpunk 2077', 120);
  assert.equal(plain(german.get('__shown'))[0].timeoutMs, 15000);
});
