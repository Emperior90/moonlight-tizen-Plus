'use strict';

// Checks the Spanish and French texts (wasm/static/locales/es-ES.json, fr-FR.json) beyond what tests/tools/i18n-check.js
// checks for every language: the form of address (Spanish "tú", French "vous"), the terms of the glossary in
// docs/TRANSLATING.md, the punctuation of each language (¿ and ¡ in Spanish, a no-break space before : ; ? ! and inside
// « » in French), the key names as they are printed on the remote and the gamepad, and the names the texts refer to
// (settings, menu entries) as the translated UI shows them. The German texts are checked in german-texts.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const readLocale = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales', name + '.json'), 'utf8'));
const english = readLocale('en-US');
const spanish = readLocale('es-ES');
const french = readLocale('fr-FR');
const keys = Object.keys(english);
const NBSP = ' ';
// The texts of a language that match a pattern
const matching = (texts, pattern) => keys.filter((key) => pattern.test(texts[key])).map((key) => texts[key]);

test('the Spanish texts use the informal tú, never usted', () => {
  // usted and the formal imperatives of the verbs that the texts use with tú
  const formal = /\b(usted|ustedes|Seleccione|Pulse|Introduzca|Intente|Compruebe|Elija|Asegúrese|Reinicie|Espere|Active|Desactive|Considere|Vuelva)\b/;
  assert.deepEqual(matching(spanish, formal), []);
  assert.match(spanish['Are you sure you want to exit Moonlight?'], /^¿Seguro que quieres /);
  assert.match(spanish['Please enter a valid PC address!'], /^Introduce /);
  assert.match(spanish['Leave both sticks at rest, then press OK. RETURN cancels.'], /^Deja /);
});

test('the French texts use vous, never tu', () => {
  assert.deepEqual(matching(french, /(^|[\s’(])(tu|toi|ton|ta|tes|te|t’)(?=[\s,.!?]|$)/i), []);
  assert.match(french['Are you sure you want to exit Moonlight?'], /^Voulez-vous vraiment /);
  assert.match(french['Please enter a valid PC address!'], /^Saisissez /);
  assert.match(french['Leave both sticks at rest, then press OK. RETURN cancels.'], /^Laissez /);
});

test('Spanish questions and exclamations open with ¿ and ¡, and quotes are « »', () => {
  keys.forEach((key) => {
    const text = spanish[key];
    const count = (pattern) => (text.match(pattern) || []).length;
    assert.equal(count(/¿/g), count(/\?/g), text);
    assert.equal(count(/¡/g), count(/!/g), text);
    assert.equal(count(/«/g), count(/»/g), text);
  });
  assert.deepEqual(matching(spanish, /"/), []);
  // A text in quotes, e.g. the name of a setting in a hint
  assert.match(spanish['If this TV has a 120 Hz panel, you can turn on \'Unlock all frame rates\' below the frame rate to stream at up to 120 FPS.'],
    /«Desbloquear todas las frecuencias de fotogramas»/);
});

test('French texts have a no-break space before : ; ? ! and inside « », and the typographic apostrophe', () => {
  // A normal space would let the sign start a line of its own
  assert.deepEqual(matching(french, / [:;?!»]|« /), []);
  assert.deepEqual(matching(french, /[^\s\d]«|»[^\s.,]/), []);
  assert.deepEqual(matching(french, /['"]/), []);
  assert.equal(french['Are you sure you want to exit Moonlight?'], 'Voulez-vous vraiment quitter Moonlight' + NBSP + '?');
  assert.equal(french['Codec:'], 'Codec' + NBSP + ':');
  assert.match(french['%1$s is hidden. Choose "Show hidden apps" in the menu of an app to see it again.'],
    new RegExp('«' + NBSP + 'Afficher les applications masquées' + NBSP + '»'));
  // No break between a number and its percent sign in either language
  [spanish, french].forEach((texts) => assert.deepEqual(matching(texts, / %(?!\d\$)/), []));
});

test('the Spanish and French texts use the terms of the glossary', () => {
  const glossary = [
    // [texts, English key, the term, words the texts don't use for it]
    [spanish, 'Controller', 'Mando', /\b(gamepads?|controlador(es)? de juego)\b/i],
    [spanish, 'Remote Control', 'Mando a distancia', /control remoto/i],
    [spanish, 'Settings', 'Ajustes', /Configuraciones/],
    [spanish, 'Pair', 'Vincular', /emparejar|\bpairing\b/i],
    [spanish, 'Ultra low latency mode', 'Modo de latencia ultrabaja', /game ?mode/i],
    [spanish, 'Stream Menu', 'Menú de transmisión', /retransmisi|(?<!Game )\bstreaming\b|Menú de stream/i],
    [spanish, 'Rumble feedback', 'Vibración del mando', /\brumble\b/i],
    // European Spanish words that Latin American users also understand, not words of only one region
    [spanish, 'Unknown', 'Desconocido', /\b(ordenador|computadora|anfitri[oó]n)\b/i],
    [french, 'Controller', 'Manette', /\b(gamepads?|contrôleurs?)\b/i],
    [french, 'Remote Control', 'Télécommande', /\btélé-commande\b/i],
    [french, 'Settings', 'Paramètres', /\bRéglages\b/],
    [french, 'Pair', 'Associer', /\b(appairer|jumeler|pairing)\b/i],
    [french, 'Ultra low latency mode', 'Mode latence ultra-faible', /game ?mode/i],
    [french, 'Stream Menu', 'Menu de streaming', /\bdiffusion\b(?! broadcast)|Menu de diffusion/i],
    [french, 'Rumble feedback', 'Vibrations', /\brumble\b/i],
  ];
  // (the heading of the English guide that a text names stays English)
  const withoutGuideHeading = (texts) => keys.reduce((result, key) => {
    result[key] = texts[key].replace('<b>ForceGM variant and game mode</b>', '');
    return result;
  }, {});
  glossary.forEach(([texts, source, term, avoided]) => {
    assert.equal(texts[source], term, source);
    assert.deepEqual(matching(withoutGuideHeading(texts), avoided), [], source);
  });
  // The PC is "equipo" or "PC" in Spanish and "PC" in French; "hôte" stays only for the hostname and for hosts like Wolf
  assert.equal(spanish['Add PC'], 'Añadir equipo');
  assert.equal(french['Add PC'], 'Ajouter un PC');
  // The game mode of the TV, which the ForceGM variant asks for, keeps its name
  assert.match(spanish['ForceGM variant detected: the app asks the TV for its Game Mode, so the Ultra low latency mode setting stays off here and the decoder uses the Low Latency mode.'], /Modo Juego/);
  assert.match(french['ForceGM variant detected: the app asks the TV for its Game Mode, so the Ultra low latency mode setting stays off here and the decoder uses the Low Latency mode.'], /mode Jeu/);
  const hostSoftware = /host ?name|Hostname|Wolf|host audio/;
  assert.deepEqual(keys.filter((key) => /hôte/.test(french[key]) && !hostSoftware.test(key)).map((key) => french[key]), []);
  // A typographic ellipsis instead of three dots, and the decimal comma
  [spanish, french].forEach((texts) => {
    assert.deepEqual(matching(texts, /\.\.\./), []);
    assert.match(texts['— Navigate to the next item, and increase the bitrate in 0.5 Mbps steps.'], /0,5 Mbps/);
  });
});

test('the key names stay as printed on the remote and the gamepad, the other keys get the words of the language', () => {
  ['OK', 'RETURN', 'CH+', 'Play/Pause', 'PLAY/PAUSE', 'SELECT', 'START', 'LB', 'RB', 'ESC'].forEach((name) => {
    const pattern = new RegExp('(^|[^\\w/])' + name.replace(/[+/]/g, '\\$&') + '($|[^\\w/])');
    keys.filter((key) => pattern.test(english[key])).forEach((key) => {
      assert.ok(pattern.test(spanish[key]), name + ' in ' + JSON.stringify(spanish[key]));
      assert.ok(pattern.test(french[key]), name + ' in ' + JSON.stringify(french[key]));
    });
  });
  const remoteKeys = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'RED', 'YELLOW', 'CHANNEL UP'];
  assert.deepEqual(remoteKeys.map((key) => spanish[key]),
    ['ARRIBA', 'ABAJO', 'IZQUIERDA', 'DERECHA', 'ROJO', 'AMARILLO', 'CH+']);
  assert.deepEqual(remoteKeys.map((key) => french[key]),
    ['HAUT', 'BAS', 'GAUCHE', 'DROITE', 'ROUGE', 'JAUNE', 'CH+']);
  assert.equal(spanish['App options: CH+ or Play/Pause on the remote, Select on a controller'],
    'Opciones: CH+ o Play/Pause (mando a distancia), Select (mando)');
  assert.equal(french['App options: CH+ or Play/Pause on the remote, Select on a controller'],
    'Options' + NBSP + ': CH+ ou Play/Pause (télécommande), Select (manette)');
  // The colour keys in sentences
  assert.match(spanish['Stop the current stream first (RED button).'], /botón rojo/);
  assert.match(french['Stop the current stream first (RED button).'], /touche rouge/);
});

test('texts that name a setting, a value or a menu entry use its Spanish and French name', () => {
  const references = [
    ['If this TV has a 120 Hz panel, you can turn on \'Unlock all frame rates\' below the frame rate to stream at up to 120 FPS.', 'Unlock all frame rates'],
    ['ForceGM variant detected: the app asks the TV for its Game Mode, so the Ultra low latency mode setting stays off here and the decoder uses the Low Latency mode.', 'Ultra low latency mode'],
    ['— Turn the mouse emulation on or off during a stream, if the Input Settings allow it (the Stream Menu always can): the left stick moves the pointer, the right stick scrolls, A or LB clicks left, B or RB clicks right, X or Y clicks the middle button.', 'Input Settings'],
    ['— Turn the mouse emulation on or off during a stream, if the Input Settings allow it (the Stream Menu always can): the left stick moves the pointer, the right stick scrolls, A or LB clicks left, B or RB clicks right, X or Y clicks the middle button.', 'Stream Menu'],
    ['%1$s is hidden. Choose "Show hidden apps" in the menu of an app to see it again.', 'Show hidden apps (%1$s)'],
    ['- Choose Auto to match your TV locale, or manually select your desired language from the list.', 'Auto'],
    ['- Auto picks the type from the name of each controller. Choose PlayStation to get PlayStation button prompts and the touchpad button in games, if the PC supports it.', 'Auto'],
    ['- Compact shows one line with the main figures over the stream, Full every figure. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Compact'],
    ['- Compact shows one line with the main figures over the stream, Full every figure. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Full'],
    ['- Compact shows one line with the main figures over the stream, Full every figure. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Stream Menu'],
    ['— Step the performance statistics overlay through Off, Compact and Full.', 'Off'],
    ['The PC often sent whole frames again after a loss: turn on Reference frame invalidation in the Advanced Settings.', 'Reference frame invalidation'],
    ['The PC often sent whole frames again after a loss: turn on Reference frame invalidation in the Advanced Settings.', 'Advanced Settings'],
    ['raise to %1$s ms or enable Audio clock sync', 'Audio clock sync'],
    ['OK on the field opens the keyboard of the TV, whose Done key sends the text. RETURN or B: back to the Stream Menu', 'Stream Menu'],
    ['For more information about this incompatibility and the ForceGM variant, see <b>ForceGM variant and game mode</b> in the guide of Moonlight Plus, which the Support button at the top of the screen links to.', 'Support'],
  ];
  [['es-ES', spanish], ['fr-FR', french]].forEach(([locale, texts]) => {
    references.forEach(([text, name]) => {
      const translatedName = texts[name].replace(/ \(%1\$s\)$/, '');
      assert.ok(texts[text].toLowerCase().indexOf(translatedName.toLowerCase()) >= 0, locale + ': ' + translatedName + ' in ' + texts[text]);
    });
    // The section of the guide keeps its English heading, since the guide is in English
    assert.match(texts['For more information about this incompatibility and the ForceGM variant, see <b>ForceGM variant and game mode</b> in the guide of Moonlight Plus, which the Support button at the top of the screen links to.'],
      /<b>ForceGM variant and game mode<\/b>/);
  });
  // The fallback name of a PC in 'Failed to connect to %1$s...' fits the preposition of the sentence
  assert.equal(spanish['Failed to connect to %1$s. Make sure that Sunshine (or another GameStream host) is running on the PC.']
    .replace('%1$s', spanish['the PC']).indexOf('con el equipo'), 'No se pudo conectar '.length);
  assert.ok(french['Failed to connect to %1$s. Make sure that Sunshine (or another GameStream host) is running on the PC.']
    .replace('%1$s', french['the PC']).indexOf('se connecter à ce PC') > 0);
});

test('a line without an entry says "none" in the gender of its noun, as a text of its own', () => {
  // Keys of the remote (teclas, touches) are feminine, the controllers in French (manettes) as well
  const cases = [
    ['Registered by Moonlight: None', 'Registradas por Moonlight: ninguna', 'Enregistrées par Moonlight' + NBSP + ': aucune'],
    ['Left to the TV: None', 'Reservadas al televisor: ninguna', 'Laissées au téléviseur' + NBSP + ': aucune'],
    ['Controllers: None', 'Mandos: ninguno', 'Manettes' + NBSP + ': aucune'],
    ['Buttons: None', 'Botones: ninguno', 'Boutons' + NBSP + ': aucun'],
    ['Tested Profile: None', 'Perfil probado: ninguno', 'Profil testé' + NBSP + ': aucun'],
  ];
  cases.forEach(([key, es, fr]) => {
    assert.equal(spanish[key], es, key);
    assert.equal(french[key], fr, key);
  });
  // The line of a value keeps the start of the line with entries
  cases.forEach(([key]) => {
    const template = key.replace(/None$/, '%1$s');
    if (Object.prototype.hasOwnProperty.call(english, template)) {
      assert.equal(spanish[key].split(':')[0], spanish[template].split(':')[0], key);
      assert.equal(french[key].split(NBSP + ':')[0], french[template].split(NBSP + ':')[0], key);
    }
  });
  // The generic word stays only for a value of its own (the target of a button in the button mapping)
  const sources = ['wasm/platform/input_test.js', 'wasm/platform/index.js', 'wasm/platform/button_mapping.js']
    .map((file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')).join('\n');
  assert.equal((sources.match(/t\('None'\)/g) || []).length, 1);
  assert.match(sources, /return target === MAPPED_BUTTON_NONE \? t\('None'\) :/);
});
