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
  // The PC is "PC" in both languages, one name for one thing (the English texts say PC since 2.2.0); Spanish keeps
  // "servidor" only for host software (Sunshine or another GameStream host, hosts like Wolf), French "hôte" only for the
  // hostname and for hosts like Wolf
  assert.equal(spanish['Add PC'], 'Añadir PC');
  assert.equal(french['Add PC'], 'Ajouter un PC');
  ['PCs', 'PC Details', 'the PC', 'Remove all PCs', 'Delete All PCs', 'Are you sure you want to delete all saved PCs?',
    'No PC is saved.', 'All PCs have been deleted.'].forEach((key) => assert.match(spanish[key], /\bPC\b/, key));
  assert.deepEqual(matching(spanish, /\bequipos?\b/i), []);
  const hostSoftwareEs = /GameStream host|Wolf/;
  assert.deepEqual(keys.filter((key) => /\bservidor(es)?\b/.test(spanish[key]) && !hostSoftwareEs.test(key) && key !== 'Decrypt host audio')
    .map((key) => spanish[key]), []);
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
    ['- Compact shows one line with the main figures over the stream, updated every second. Full shows every figure, updated every 2 seconds. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Compact'],
    ['- Compact shows one line with the main figures over the stream, updated every second. Full shows every figure, updated every 2 seconds. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Full'],
    ['- Compact shows one line with the main figures over the stream, updated every second. Full shows every figure, updated every 2 seconds. While streaming, the YELLOW key and the Stream Menu switch between Off, Compact and Full.', 'Stream Menu'],
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
    .replace('%1$s', spanish['the PC']).indexOf('con el PC'), 'No se pudo conectar '.length);
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

test('the panels of the Stream Menu and the power command: the no-break space of French, the colour key in a sentence, comando in Spanish', () => {
  const k11 = 'Only for a Windows PC that shows its desktop or a game, not the lock screen. Moonlight Plus opens Run (Windows key + R) and types the command. If an app has unsaved work, Windows asks first. Some games block the Windows key: switch to the desktop first (Alt + Tab).';
  const countdowns = ['%1$s shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED',
    '%1$s restarts in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED',
    'The PC shuts down in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED',
    'The PC restarts in a few seconds. To cancel (e.g. on the lock screen): RETURN or RED'];
  ['RETURN or B: back to the Stream Menu', 'Shut down or restart the PC?', k11].concat(countdowns).forEach((key) => {
    assert.ok(!/[^ ][:?]/.test(french[key]) && / [:?]/.test(french[key]), 'fr: ' + french[key]);
  });
  countdowns.forEach((key) => {
    assert.ok(spanish[key].endsWith('Para cancelar (p. ej., en la pantalla de bloqueo): RETURN o botón rojo'), key);
    assert.ok(french[key].endsWith('Pour annuler (par exemple sur l’écran de verrouillage) : RETURN ou touche rouge'), key);
  });
  assert.equal(spanish['Shut down or restart the PC?'], '¿Apagar o reiniciar el PC?');
  // Unsaved work comes first, so that the sentence can't be read as 'Windows asks whether …'
  assert.ok(spanish[k11].indexOf('Si una aplicación tiene cambios sin guardar, Windows pregunta antes.') > 0, spanish[k11]);
  assert.ok(french[k11].indexOf('Si une application a des modifications non enregistrées, Windows demande d’abord confirmation.') > 0, french[k11]);
  // A host without a name: a sentence of its own that starts with a capital letter
  assert.equal(spanish['The PC is shutting down.'], 'El PC se está apagando.');
  assert.equal(french['The PC is shutting down.'], 'Le PC s’éteint.');
  // The menu entry of the app list in its name of each language, quoted as the language does
  const notListed = '%1$s runs an app that isn\'t in its app list. Quit it first with "Quit app on the PC", then try again.';
  assert.ok(spanish[notListed].indexOf('«' + spanish['Quit app on the PC'] + '»') > 0, spanish[notListed]);
  assert.ok(french[notListed].indexOf('«\u00a0' + french['Quit app on the PC'] + '\u00a0»') > 0, french[notListed]);
  // "command" is "comando", as in the other Spanish texts, never "orden"
  [k11, 'Shutdown command sent to the PC', 'Restart command sent to the PC', 'The command couldn\'t be sent to the PC. Try again.'].forEach((key) => {
    assert.ok(/comando/i.test(spanish[key]) && !/\borden\b/i.test(spanish[key]), 'es: ' + spanish[key]);
  });
  [['es-ES', spanish], ['fr-FR', french]].forEach(([locale, texts]) => {
    assert.ok(texts[k11].toLowerCase().indexOf(texts['Windows key'].toLowerCase() + ' + r') > 0, locale + ': ' + texts[k11]);
    assert.ok(texts['RETURN or B: back to the Stream Menu'].endsWith(texts['Stream Menu']), locale);
    assert.ok(texts['%1$s has no Desktop app to stream for this. Stream one of its apps and use the Stream Menu instead.'].indexOf(texts['Stream Menu']) > 0, locale);
  });
});
