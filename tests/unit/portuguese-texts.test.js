'use strict';

// Checks the Brazilian Portuguese texts (wasm/static/locales/pt-BR.json) beyond what tests/tools/i18n-check.js checks for
// every language: the form of address (você, never tu), the terms of the glossary in docs/TRANSLATING.md (PC for the host
// PC, parear, app, transmissão, taxa de bits, controle, despertar, apertar), the typography (typographic quotes and
// ellipsis, decimal comma, sentence case for labels, for the lines of System information and inside sentences), the key
// names as they are printed on the remote and the gamepad, and the names the texts refer to (settings, menu entries) as
// the translated UI shows them, with their case. The glossary has not been reviewed by a native
// speaker yet (docs/TRANSLATING.md); these checks keep the texts consistent with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const readLocale = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales', name + '.json'), 'utf8'));
const english = readLocale('en-US');
const portuguese = readLocale('pt-BR');
const keys = Object.keys(english);
// The texts of pt-BR that match a pattern (the window title of the app keeps its English product name)
const matching = (pattern) => keys.filter((key) => key !== 'Moonlight Game Streaming' && pattern.test(portuguese[key])).map((key) => portuguese[key]);

test('the Brazilian Portuguese texts use você, never tu', () => {
  assert.deepEqual(matching(/\b(tu|teu|tua|teus|tuas|contigo|vós|vocês)\b/i), []);
  assert.match(portuguese['Are you sure you want to exit Moonlight?'], /^Você tem certeza de que deseja /);
  assert.match(portuguese['Leave both sticks at rest, then press OK. RETURN cancels.'], /^Deixe /);
});

test('the Brazilian Portuguese texts use the terms of the glossary', () => {
  const glossary = [
    // [English key, the term, words the texts don't use for it]
    ['Controller', 'Controle', /\b(gamepads?|joysticks?|controlador(es)?)\b/i],
    ['Remote Control', 'Controle remoto', /\bcontrole da TV\b/i],
    ['Settings', 'Configurações', /\bAjustes\b/],
    ['Pair', 'Parear', /emparelh|\bpairing\b/i],
    ['Apps', 'Apps', /\baplicativos?\b/i],
    ['Stream Menu', 'Menu da transmissão', /\bstream(s|ing)?\b/i],
    ['Bitrate', 'Taxa de bits', /\bbitrate\b/i],
    ['Rumble feedback', 'Feedback de vibração', /\brumble\b/i],
    ['Stereo', 'Estéreo', /\bStereo\b/],
  ];
  glossary.forEach(([source, term, avoided]) => {
    assert.equal(portuguese[source], term, source);
    assert.deepEqual(matching(avoided), [], source);
  });
  // The PC is "PC" ("o PC", "os PCs"), one name for one thing; "host" stays only for the host name and for host software
  // (Sunshine or another GameStream host, hosts like Wolf, the audio and the figures of the host)
  assert.equal(portuguese['Add PC'], 'Adicionar PC');
  assert.deepEqual(matching(/\bPC host\b|\bcomputador(es)?\b|\bmáquinas?\b/i), []);
  const hostSoftware = /host ?name|Hostname|GameStream host|Wolf|host audio|Host frame|host processing|Host processing|the other host/;
  assert.deepEqual(keys.filter((key) => /\bhosts?\b/i.test(portuguese[key]) && !hostSoftware.test(key)).map((key) => portuguese[key]), []);
  // The TV is feminine
  assert.deepEqual(matching(/\b(o|do|no|este|esse) TV\b/), []);
  // Waking the PC is despertar, as in Despertar PC (not ligar), and a press of a key or a button is apertar (not pressionar)
  const wakePc = keys.filter((key) => /\bwak(e|es|ing)\b/i.test(key.replace(/Wake-on-LAN/gi, '')) && /\bPC\b/.test(key));
  assert.ok(wakePc.length >= 6, wakePc.join('\n'));
  wakePc.forEach((key) => assert.match(portuguese[key], /despert/i, key));
  assert.deepEqual(matching(/\bpression/i), []);
  assert.match(portuguese['Press a key of the remote'], /^Aperte /);
});

test('Brazilian Portuguese uses typographic quotes and ellipsis, the decimal comma and sentence case', () => {
  // “ ”, neither straight double nor single quotes (nor ‘ ’)
  assert.deepEqual(matching(/"/), []);
  assert.deepEqual(matching(/(^|[\s(>])'[^']+'|‘/), []);
  assert.deepEqual(matching(/\.\.\./), []);
  keys.forEach((key) => {
    const text = portuguese[key];
    assert.equal((text.match(/“/g) || []).length, (text.match(/”/g) || []).length, text);
  });
  assert.match(portuguese['— Navigate to the next item, increase the bitrate in 0.5 Mbps steps, and open the selected category of the settings.'], /0,5 Mbps/);
  // Labels, titles and section names in sentence case, as in Spanish and French; product names (Web Audio, Full HD,
  // Xbox) and the Modo Jogo of the TV keep their capitals
  [['Basic Settings', 'Configurações básicas'], ['Video Settings', 'Configurações de vídeo'], ['Audio Settings', 'Configurações de áudio'],
    ['Input Settings', 'Configurações de entrada'], ['Advanced Settings', 'Configurações avançadas'], ['Restore Defaults', 'Restaurar padrões'],
    ['View Details', 'Ver detalhes'], ['Delete All PCs', 'Excluir todos os PCs'], ['Remote Control', 'Controle remoto']]
    .forEach(([key, text]) => assert.equal(portuguese[key], text, key));
  // The names of the Stream Menu and of the sections (Menu da transmissão, Configurações de áudio) keep the capital that the UI
  // shows when a text names them
  const exceptions = /^(Menu|Configurações|Moonlight|Plus|Sunshine|Apollo|Vibepollo|Wake-on-LAN|Web|Audio|EMSS|HDR|HDR10|HEVC|AV1|ForceGM|Tizen|GameStream|Brasil|Smart|Hub|Wi-Fi|Ethernet|Desktop|Steam|Windows|Opus|Full|HD|Xbox|PlayStation|Nintendo|Jogo|Player|WASM|MediaSource|Mbps|FPS|PIN|RTSP|MAC|IP|ID|PC|PCs|TV|TVs|OK|RETURN|Moonlight:?)$/;
  const titleCase = keys.filter((key) => {
    if (key === 'Moonlight Game Streaming') {
      return false;
    }
    const text = portuguese[key].replace(/<[^>]+>/g, ' ');
    const words = text.split(/\s+/).filter(Boolean);
    // Labels, not sentences: short ones, and the lines of System information (ending in ':' or ': %1$s') at any length
    if (words.length < 2 || (words.length > 8 && !/:( %\d\$s)?$/.test(text.trim())) || /[.!?]$/.test(text.trim())) {
      return false;
    }
    return words.slice(1).some((word, index) => /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+[:,]?$/.test(word) && !exceptions.test(word.replace(/[:,]$/, '')) &&
      !/[:(.!?]$/.test(words[index]));
  }).map((key) => portuguese[key]);
  assert.deepEqual(titleCase, []);
  // Inside a sentence too: no two capitalized words in a row past its first word (e.g. not "o modo de Latência Ultrabaixa"),
  // leaving out quoted names (“ ”) and parentheses, which can name the English menus of other apps; and the sections and
  // the Stream Menu, which keep only their first capital (not "nas Configurações de Áudio")
  const capital = /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+$/;
  const titleCaseInSentences = [];
  keys.filter((key) => key !== 'Moonlight Game Streaming').forEach((key) => {
    const text = portuguese[key].replace(/<[^>]+>/g, ' ').replace(/“[^”]*”/g, ' “” ').replace(/\([^)]*\)/g, ' () ');
    text.split(/[.!?:;]\s+|^\s*[-—]\s+|\s+[-—]\s+/).forEach((sentence) => {
      const words = sentence.split(/\s+/).filter(Boolean);
      for (let i = 1; i + 1 < words.length; i++) {
        const next = words[i + 1].replace(/[,.;:!?]+$/, '');
        if (capital.test(words[i]) && capital.test(next) && !exceptions.test(words[i]) && !exceptions.test(next)) {
          titleCaseInSentences.push(words[i] + ' ' + next + ' in ' + portuguese[key]);
        }
      }
    });
  });
  assert.deepEqual(titleCaseInSentences, []);
  assert.deepEqual(matching(/\bConfigurações (?:Básicas|de (?:Vídeo|Áudio|Entrada)|Avançadas)\b|\bMenu da Transmissão\b/), []);
});

test('the key names stay as printed on the remote and the gamepad, the other keys get the Portuguese words', () => {
  ['OK', 'RETURN', 'CH+', 'Play/Pause', 'PLAY/PAUSE', 'SELECT', 'START', 'LB', 'RB', 'ESC'].forEach((name) => {
    const pattern = new RegExp('(^|[^\\w/])' + name.replace(/[+/]/g, '\\$&') + '($|[^\\w/])');
    keys.filter((key) => pattern.test(english[key])).forEach((key) => {
      assert.ok(pattern.test(portuguese[key]), name + ' in ' + JSON.stringify(portuguese[key]));
    });
  });
  assert.deepEqual(['UP', 'DOWN', 'LEFT', 'RIGHT', 'RED', 'YELLOW'].map((key) => portuguese[key]),
    ['CIMA', 'BAIXO', 'ESQUERDA', 'DIREITA', 'VERMELHO', 'AMARELO']);
  assert.match(portuguese['Stop the current stream first (RED button).'], /botão VERMELHO/);
});

test('texts that name a setting or a menu entry use its Portuguese name', () => {
  const references = [
    ['%1$s is hidden. Choose "Show hidden apps" in the menu of an app to see it again.', 'Show hidden apps (%1$s)'],
    ['%1$s runs an app that isn\'t in its app list. Quit it first with "Quit app on the PC", then try again.', 'Quit app on the PC'],
    ['In the web UI of Sunshine on the PC, add apps under "Applications", then choose "Refresh apps" in the menu of this PC in the PC list.', 'Refresh apps'],
    ['This PC answers with a different key than at its pairing. Try "Rescan network", or delete the PC and add it again.', 'Rescan network'],
    ['The PC often sent whole frames again after a loss: turn on Reference frame invalidation in the Advanced Settings.', 'Advanced Settings'],
    ['RETURN or B: back to the Stream Menu', 'Stream Menu'],
  ];
  references.forEach(([text, name]) => {
    // With its case: the sections and the Stream Menu keep their first capital and nothing more
    const translatedName = portuguese[name].replace(/ \(%1\$s\)$/, '');
    assert.ok(portuguese[text].indexOf(translatedName) >= 0, translatedName + ' in ' + portuguese[text]);
  });
});
