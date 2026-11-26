'use strict';

// Checks the German texts (wasm/static/locales/de-DE.json) beyond what tests/tools/i18n-check.js checks for every
// language: the informal "du" throughout, the terms of the glossary in docs/TRANSLATING.md (PC, never Rechner,
// Computer or Maschine), the key names as they are
// printed on the remote and the gamepad, and the names the texts refer to (settings, menu entries) as the German UI
// shows them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const readLocale = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales', name + '.json'), 'utf8'));
const english = readLocale('en-US');
const german = readLocale('de-DE');
const keys = Object.keys(english);

test('the German texts use the informal du, never Sie', () => {
  const formal = keys.filter((key) => /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres|Ihnen)\b/.test(german[key]));
  assert.deepEqual(formal.map((key) => german[key]), []);
  // The texts that ask the user to do something address them, e.g. 'Möchtest du ...?'
  assert.match(german['Are you sure you want to exit Moonlight?'], /^Möchtest du /);
  assert.match(german['Please enter a valid PC address!'], /^Bitte gib /);
});

test('the German texts use the terms of the glossary', () => {
  const terms = [
    // [English word, the German term, words the German texts don't use for it]
    ['Controller', 'Controller', /\bGamepads?\b/],
    ['Remote Control', 'Fernbedienung', /Fernsteuerung/],
    ['Pair', 'Koppeln', /\bpair|Pairing/i],
    ['Wi-Fi', 'WLAN', /Wi-?Fi/i],
    ['Settings', 'Einstellungen', /Optionen der App/],
    ['Ultra low latency mode', 'Ultra-Low-Latency-Modus', /Game ?Mode|Spielemodus/],
    ['Rumble feedback', 'Vibration', /Rumble|Rüttel/i],
  ];
  terms.forEach(([source, term, avoided]) => {
    assert.equal(german[source], term, source);
    const offending = keys.filter((key) => avoided.test(german[key]));
    assert.deepEqual(offending.map((key) => german[key]), [], source);
  });
  // The game mode of the TV, which the ForceGM variant asks for, stays Spielmodus
  assert.match(german['ForceGM variant detected: the app asks the TV for its Game Mode, so the Ultra low latency mode setting stays off here and the decoder uses the Low Latency mode.'],
    /Spielmodus des TVs.*Ultra-Low-Latency-Modus/);
  // The PC is a PC (glossary: host, host PC), not a Rechner, Computer or Maschine
  assert.deepEqual(keys.filter((key) => /\b(Rechner|Computer|Maschine)/.test(german[key])).map((key) => german[key]), []);
  // TV for the television (der TV, des TVs), as in the German UI of Samsung
  assert.deepEqual(keys.filter((key) => /Fernseher/.test(german[key])), []);
  // The web UI of a host is its Weboberfläche, as in the pairing dialog and the empty app list
  assert.deepEqual(keys.filter((key) => /Web-?UI/i.test(german[key])).map((key) => german[key]), []);
  assert.deepEqual(keys.filter((key) => /\bweb UI\b/i.test(english[key]) && !/Weboberfläche/.test(german[key])).map((key) => german[key]), []);
  // A typographic ellipsis instead of three dots
  assert.deepEqual(keys.filter((key) => /\.\.\./.test(german[key])), []);
});

test('the key names stay as printed on the remote and the gamepad', () => {
  // Key names that the remote or a gamepad prints, and that German texts keep as they are
  ['OK', 'RETURN', 'CH+', 'Play/Pause', 'PLAY/PAUSE', 'SELECT', 'START', 'LB', 'RB', 'ESC'].forEach((name) => {
    const pattern = new RegExp('(^|[^\\w/])' + name.replace(/[+/]/g, '\\$&') + '($|[^\\w/])');
    keys.filter((key) => pattern.test(english[key])).forEach((key) => {
      assert.ok(pattern.test(german[key]), name + ' in ' + JSON.stringify(german[key]));
    });
  });
  // The keys of the remote without a printed name: arrows and colour keys get German names, CH+ its print
  assert.deepEqual(['UP', 'DOWN', 'LEFT', 'RIGHT', 'RED', 'YELLOW', 'CHANNEL UP'].map((key) => german[key]),
    ['OBEN', 'UNTEN', 'LINKS', 'RECHTS', 'ROT', 'GELB', 'CH+']);
  assert.equal(german['App options: CH+ or Play/Pause on the remote, Select on a controller'],
    'App-Optionen: CH+ oder Play/Pause auf der Fernbedienung, Select am Controller');
  // The colour keys in sentences
  assert.match(german['Stop the current stream first (RED button).'], /rote Taste/);
  assert.match(german['- Compact shows one line with the main figures over the stream, updated every second. Full shows every figure, updated every 2 seconds. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.'], /gelbe Taste/);
});

test('texts that name a setting, a value or a menu entry use its German name', () => {
  // e.g. 'Unlock all frame rates' in the hint of the optimal settings dialog, 'Show hidden apps' in the notice after hiding
  const references = [
    ['If this TV has a 120 Hz panel, you can turn on \'Unlock all frame rates\' below the frame rate to stream at up to 120 FPS.', 'Unlock all frame rates'],
    ['ForceGM variant detected: the app asks the TV for its Game Mode, so the Ultra low latency mode setting stays off here and the decoder uses the Low Latency mode.', 'Ultra low latency mode'],
    ['— Turn the mouse emulation on or off during a stream, if the Input Settings allow it (the Stream Menu always can): the left stick moves the pointer, the right stick scrolls, A or LB clicks left, B or RB clicks right, X or Y clicks the middle button.', 'Stream Menu'],
    ['The PC often sent whole frames again after a loss: turn on Reference frame invalidation in the Advanced Settings.', 'Reference frame invalidation'],
    ['%1$s is hidden. Choose "Show hidden apps" in the menu of an app to see it again.', 'Show hidden apps (%1$s)'],
    ['- Choose Auto to match your TV locale, or manually select your desired language from the list.', 'Auto'],
    ['- Compact shows one line with the main figures over the stream, updated every second. Full shows every figure, updated every 2 seconds. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Compact'],
    ['- Compact shows one line with the main figures over the stream, updated every second. Full shows every figure, updated every 2 seconds. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Full'],
    ['- Compact shows one line with the main figures over the stream, updated every second. Full shows every figure, updated every 2 seconds. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Stream Menu'],
    ['— Step the performance statistics overlay through Off, Compact and Full.', 'Off'],
    ['For more information about this incompatibility and the ForceGM variant, see <b>ForceGM variant and game mode</b> in the guide of Moonlight Plus, which the Support button at the top of the screen links to.', 'Support'],
    // The header button that finds a PC again at a new address
    ['%1$s answers with a different key than at its pairing: another PC may have its address now, or Sunshine was set up anew on it. If the PC is asleep, wake it from its options. Otherwise try "Rescan network", and if that doesn\'t help, delete the PC and add it again.', 'Rescan network'],
    ['This PC answers with a different key than at its pairing. Try "Rescan network", or delete the PC and add it again.', 'Rescan network'],
    // The entry of the menu of a PC that an empty app list points to
    ['In the web UI of Sunshine on the PC, add apps under "Applications", then choose "Refresh apps" in the menu of this PC in the PC list.', 'Refresh apps'],
  ];
  references.forEach(([text, name]) => {
    const germanName = german[name].replace(/ \(%1\$s\)$/, '');
    assert.ok(german[text].indexOf(germanName) >= 0, germanName + ' in ' + german[text]);
  });
  // The help of 'Hide connection warnings' quotes the warning that it hides
  assert.ok(german["- Hides the message 'Slow connection to PC' during a stream."].indexOf(german['Slow connection to PC.\nReduce your bitrate!'].split('.')[0]) >= 0);
  // The section of the guide keeps its English heading, since the guide is in English
  assert.match(german['For more information about this incompatibility and the ForceGM variant, see <b>ForceGM variant and game mode</b> in the guide of Moonlight Plus, which the Support button at the top of the screen links to.'],
    /<b>ForceGM variant and game mode<\/b>/);
  // The progress line 'Starting RTSP handshake...' of the native code reads 'RTSP-Handshake wird gestartet …' (as a whole,
  // see tests/unit/connection-ports.test.js), and the overline of the start screen a status, not a command
  assert.equal(german['Starting the %1$s...'].replace('%1$s', german['RTSP handshake']), 'RTSP-Handshake wird gestartet …');
  assert.equal(german['Starting'], 'Wird gestartet');
});

test('a line without an entry says "keine" or "keines" in lower case, as a text of its own', () => {
  assert.deepEqual(['Registered by Moonlight: None', 'Left to the TV: None', 'Controllers: None', 'Buttons: None', 'Tested Profile: None']
    .map((key) => german[key]), ['Von Moonlight registriert: keine', 'Dem TV überlassen: keine', 'Controller: keine', 'Tasten: keine',
    'Getestetes Profil: keines']);
  // The value of its own (the target of a button in the button mapping) is capitalised
  assert.equal(german['None'], 'Keine');
});

test('the panels of the Stream Menu and the power command use the German names, the colour key in a sentence and quoted names', () => {
  const k11 = 'Only for a Windows PC that shows its desktop or a game, not the lock screen. Moonlight Plus opens Run (Windows key + R) and types the command. If an app has unsaved work, Windows asks first. Some games block the Windows key: switch to the desktop first (Alt + Tab).';
  const noDesktop = '%1$s has no Desktop app to stream for this. Stream one of its apps and use the Stream Menu instead.';
  assert.equal(german['Shortcuts…'], 'Tastenkürzel …');
  assert.equal(german['Function keys…'], 'F-Tasten …');
  assert.equal(german['Shut down or restart the PC…'], 'PC herunterfahren oder neu starten …');
  // Two verbs, not a verb and a noun
  assert.equal(german['Shut down or restart the PC?'], 'Herunterfahren oder neu starten?');
  ['%1$s shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED',
    '%1$s restarts in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED',
    'The PC shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED',
    'The PC restarts in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED'].forEach((key) => {
    assert.ok(german[key].endsWith('Abbrechen (z. B. beim Sperrbildschirm): RETURN oder rote Taste'), key);
  });
  // A host without a name: a sentence of its own with the PC as its subject, not the dative of 'the PC'
  assert.equal(german['The PC shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED'].indexOf('Der PC wird gleich heruntergefahren.'), 0);
  assert.equal(german['The PC is shutting down.'], 'Der PC wird heruntergefahren.');
  assert.equal(german['The PC is restarting.'], 'Der PC wird neu gestartet.');
  // The menu entry of the app list in its German name, quoted
  const notListed = german['%1$s runs an app that isn\'t in its app list. Quit it first with "Quit app on the PC", then try again.'];
  assert.ok(notListed.indexOf('„' + german['Quit app on the PC'] + '“') > 0 && /Beende /.test(notListed), notListed);
  assert.ok(german[k11].indexOf('„Ausführen“ (' + german['Windows key'] + ' + R)') > 0, german[k11]);
  assert.ok(german[noDesktop].indexOf('„Desktop“') > 0 && german[noDesktop].indexOf(german['Stream Menu']) > 0, german[noDesktop]);
  assert.ok(german['RETURN or B: back to the Stream Menu'].endsWith(german['Stream Menu']));
});
