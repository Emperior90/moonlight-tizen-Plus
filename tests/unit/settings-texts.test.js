'use strict';

// Checks the texts of the settings and the screens that the cleanup of 2.2.0 made consistent, in wasm/index.html and the
// locale files: one word per thing in English and Brazilian Portuguese (controller, PC, mouse emulation), one locale key
// per text (no keys that differ only by case), the switches that keep a label of their own, the texts that no longer
// send NVIDIA users to GeForce Experience, the one text for H.264 without HDR, and the navigation guide, whose lines
// name each key once and describe what it does today.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const readLocale = (name) => JSON.parse(read('wasm/static/locales/' + name + '.json'));
const english = readLocale('en-US');
const portuguese = readLocale('pt-BR');
const keys = Object.keys(english);
const html = read('wasm/index.html');

test('English and Brazilian Portuguese say controller, PC and mouse emulation', () => {
  // The English texts are the keys
  assert.deepEqual(keys.filter((key) => /gamepad/i.test(key)), []);
  assert.deepEqual(keys.filter((key) => /mouse mode/i.test(key)), []);
  // The PC is a PC, not a host, wherever the UI names it as a thing of its own (the host software, e.g. Wolf hosts,
  // the host name and the host PC stay)
  for (const old of ['Add Host', 'Delete Host', 'Delete All Hosts', 'Hosts', 'Host Details', 'Remove all hosts', 'As on the host',
    'Host address field mode', 'Play audio on host', 'the host', 'No host exists.']) {
    assert.equal(Object.prototype.hasOwnProperty.call(english, old), false, old);
  }
  for (const current of ['Add PC', 'Delete PC', 'Delete All PCs', 'PCs', 'PC Details', 'Remove all PCs', 'As on the PC']) {
    assert.ok(Object.prototype.hasOwnProperty.call(english, current), current);
  }
  assert.deepEqual(keys.filter((key) => /\bgamepads?\b/i.test(portuguese[key])), []);
  assert.equal(portuguese['Controller'], 'Controle');
  assert.equal(portuguese['Add PC'], 'Adicionar PC');
});

test('a text has one locale key, not one per spelling', () => {
  const byLowerCase = {};
  keys.forEach((key) => {
    (byLowerCase[key.toLowerCase()] = byLowerCase[key.toLowerCase()] || []).push(key);
  });
  const duplicates = Object.keys(byLowerCase).filter((key) => byLowerCase[key].length > 1).map((key) => byLowerCase[key].sort().join(' / '));
  // A key name as printed next to a word of a sentence, and a value next to the word within a sentence
  assert.deepEqual(duplicates.sort(), ['None / none', 'Off / off', 'START / Start']);
  for (const merged of ['Navigation Guide', 'RUNNING']) {
    assert.equal(Object.prototype.hasOwnProperty.call(english, merged), false, merged);
  }
  // The running state is one key, which the stylesheet writes in capitals on a chip
  assert.match(read('wasm/static/css/style.css'), /\.status-chip\.chip-running \{[^}]*text-transform: uppercase;/);
});

test('only the switches without a help text have a label of their own, and the badge New is gone', () => {
  const settings = html.slice(html.indexOf('<div id="settings-list"'), html.indexOf('<div id="game-grid">'));
  const labels = settings.match(/class="mdl-switch__label" data-i18n="[^"]*"/g) || [];
  assert.deepEqual(labels.map((label) => /data-i18n="([^"]*)"/.exec(label)[1]), ['Allow playing audio on the PC and on this TV',
    'Allow controller rumble while streaming', 'Allow a controller to switch to mouse emulation by holding Start']);
  // Each of these rows has an empty help text, which the label replaces
  labels.forEach((label) => {
    const row = settings.slice(settings.lastIndexOf('<div class="setting-option">', settings.indexOf(label)), settings.indexOf(label));
    assert.match(row, /<span class="mdl-list__item-text-body"><\/span>/, label);
  });
  assert.equal(/badge-new|data-i18n="New"/.test(html), false);
  assert.equal(/\.badge-new\b/.test(read('wasm/static/css/style.css')), false);
});

test('no text sends NVIDIA users to GameStream in GeForce Experience, and H.264 without HDR has one text', () => {
  assert.deepEqual(keys.filter((key) => /GeForce Experience/.test(key)), []);
  assert.ok(Object.prototype.hasOwnProperty.call(english, 'Failed to connect to %1$s. Make sure that Sunshine (or another GameStream host) is running on the PC.'));
  assert.deepEqual(keys.filter((key) => /H\.264/.test(key) && /HDR/.test(key)), ['H.264 has no HDR, so HDR is off.']);
  // The dead branch for a codec that the menu can't select is gone
  assert.equal(read('wasm/platform/index.js').indexOf('Selected codec does not support the HDR profile.'), -1);
});

test('the navigation guide names the OK key of the remote, describes the mouse emulation once and drops what the app does not do', () => {
  const guide = html.slice(html.indexOf('<ul id="navGuideDialogText">'), html.indexOf('</ul>', html.indexOf('<ul id="navGuideDialogText">')));
  const rows = guide.split('<li class="navGuideDialogControls">').slice(1).map((row) => ({
    remote: (row.match(/class="navGuideRemoteText" data-i18n="([^"]*)"/g) || []).map((key) => /data-i18n="([^"]*)"/.exec(key)[1]),
    gamepad: (row.match(/class="navGuideGamepadText" data-i18n="([^"]*)"/g) || []).map((key) => /data-i18n="([^"]*)"/.exec(key)[1]),
    text: /<span data-i18n="(— [^"]*)"/.exec(row)[1],
  }));
  // The centre key of the remote is OK, and SELECT is only the button of a controller
  const ok = rows.find((row) => row.gamepad.indexOf('A') >= 0);
  assert.deepEqual(ok.remote, ['OK']);
  assert.deepEqual(rows.filter((row) => row.remote.indexOf('SELECT') >= 0), []);
  // The mouse emulation in one row, the other rows without it
  const mouse = rows.filter((row) => /mouse/i.test(row.text));
  assert.equal(mouse.length, 1, JSON.stringify(mouse));
  assert.deepEqual(mouse[0].gamepad, ['START (HOLD 1 S)']);
  assert.match(mouse[0].text, /the left stick moves the pointer, the right stick scrolls, A or LB clicks left, B or RB clicks right, X or Y clicks the middle button/);
  assert.deepEqual(rows.filter((row) => /in emulation/.test(row.text)), []);
  // RETURN sends Esc during a stream, RED disconnects, and the Stream Menu line lists no entries
  assert.match(rows.find((row) => row.remote.indexOf('RETURN') >= 0).text, /During a stream, RETURN sends Esc to the PC\./);
  assert.match(rows.find((row) => row.remote.indexOf('RED') >= 0).text, /^— Disconnect, while the app keeps running on the PC; cancels a stream that is starting\.$/);
  assert.equal(rows.find((row) => row.gamepad.indexOf('SELECT + START (HOLD 1 S)') >= 0).text, '— Open or close the Stream Menu during a stream.');
  // The TV handles its volume keys itself, and CH- only set the focus
  assert.deepEqual(rows.filter((row) => row.remote.some((key) => /VOLUME|CHANNEL DOWN/.test(key))), []);
  // One key for the title and the setting
  assert.equal(html.indexOf('data-i18n="Navigation Guide"'), -1);
});
