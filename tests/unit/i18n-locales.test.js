'use strict';

// Checks the languages of wasm/platform/i18n.js: the list of languages (only those the owner chose, each named in its
// own language, each with its locale file), the language that a language tag of the TV or the browser gets (the
// locale itself, else the locale of the same language, else English), and the language that the app takes from the
// TV (tizen.systeminfo LOCALE first, the browser languages when the TV doesn't answer). The language menu and the
// German UI run in tests/browser/language.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

const LOCALES_DIR = path.join(REPO_ROOT, 'wasm/static/locales');
// The languages that the owner chose, by their own names. Every language costs about 60 KB in the package, so no
// other language joins without a decision of the owner.
const CHOSEN_LANGUAGES = {
  'en-US': 'English',
  'de-DE': 'Deutsch',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'pt-BR': 'Português (Brasil)',
};

// Load i18n.js on a simulated TV; `navigatorLanguages` stands in for the languages of the browser
function loadI18n(tv, navigatorLanguages) {
  const languages = navigatorLanguages || ['en-US'];
  const platform = loadPlatformScripts(['wasm/platform/i18n.js'], {
    tv: tv || {},
    globals: { navigator: { userAgent: 'Node unit test', languages, language: languages[0] } },
  });
  return platform.get('i18n');
}

test('the app has English first and only the chosen languages, each named in its own language and with its locale file', () => {
  const locales = plain(loadI18n().getLocaleNames());
  assert.equal(locales[0].code, 'en-US');
  // English, then the other languages in the order of their codes: Deutsch, Español, Français, Português (Brasil)
  const others = locales.slice(1).map((locale) => locale.code);
  assert.deepEqual(others, others.slice().sort());
  locales.forEach((locale) => {
    assert.ok(Object.prototype.hasOwnProperty.call(CHOSEN_LANGUAGES, locale.code), locale.code + ' is not a chosen language');
    assert.equal(locale.name, CHOSEN_LANGUAGES[locale.code]);
  });
  // Every chosen language is in the list; the locale files are the languages of the list
  assert.deepEqual(locales.map((locale) => locale.code), Object.keys(CHOSEN_LANGUAGES));
  const files = fs.readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, '')).sort();
  assert.deepEqual(files, locales.map((locale) => locale.code).sort());
  assert.deepEqual(plain(loadI18n().getSupportedLocales()), locales.map((locale) => locale.code));
});

test('a language tag of the TV gets its locale, else the locale of its language, else English', () => {
  const i18n = loadI18n();
  const cases = [
    // The Tizen form with an underscore, the browser form with a hyphen, any case, and the language alone
    ['de_DE', 'de-DE'], ['de-DE', 'de-DE'], ['de_AT', 'de-DE'], ['de-CH', 'de-DE'], ['de_LU', 'de-DE'], ['DE_de', 'de-DE'], ['de', 'de-DE'],
    [' de_DE ', 'de-DE'],
    ['pt_BR', 'pt-BR'], ['pt-PT', 'pt-BR'], ['pt_AO', 'pt-BR'], ['pt', 'pt-BR'],
    // Spanish of Spain and of the Americas (es-419 is Latin America), French of France, Canada, Belgium and Switzerland
    ['es_ES', 'es-ES'], ['es-MX', 'es-ES'], ['es_US', 'es-ES'], ['es-AR', 'es-ES'], ['es-419', 'es-ES'], ['es', 'es-ES'],
    ['fr_FR', 'fr-FR'], ['fr-CA', 'fr-FR'], ['fr_BE', 'fr-FR'], ['fr-CH', 'fr-FR'], ['fr', 'fr-FR'],
    ['en_US', 'en-US'], ['en-GB', 'en-US'], ['en', 'en-US'],
    // Languages that the app doesn't have, and values that are no language tag
    ['it_IT', 'en-US'], ['ja-JP', 'en-US'], ['nl', 'en-US'], ['ru_RU', 'en-US'], ['zh-Hant-TW', 'en-US'], ['ko_KR', 'en-US'],
    // The other languages of Spain are languages of their own, not Spanish
    ['ca_ES', 'en-US'], ['eu-ES', 'en-US'], ['gl_ES', 'en-US'],
    ['', 'en-US'], [null, 'en-US'], [undefined, 'en-US'], [42, 'en-US'],
  ];
  cases.forEach(([tag, expected]) => assert.equal(i18n.resolveLocale(tag), expected, JSON.stringify(tag)));
  // Every language of the list takes the tags of all its regions, e.g. es-MX and es-US for es-ES, fr-CA for fr-FR
  plain(i18n.getSupportedLocales()).forEach((code) => {
    const language = code.split('-')[0];
    [code, code.replace('-', '_'), code.toLowerCase(), language, language + '-ZZ', language + '_419'].forEach((tag) => {
      assert.equal(i18n.resolveLocale(tag), code, tag);
    });
  });
});

test('the language of the TV picks the language of the app, also over the language of the browser', async () => {
  const cases = [
    [{ locale: 'de_AT' }, ['en-US'], 'de-DE'],
    [{ locale: 'de_DE' }, ['pt-BR'], 'de-DE'],
    [{ locale: 'pt_PT' }, ['en-US'], 'pt-BR'],
    [{ locale: 'es_MX' }, ['en-US'], 'es-ES'],
    [{ locale: 'es_ES' }, ['fr-FR'], 'es-ES'],
    [{ locale: 'fr_CA' }, ['es-ES'], 'fr-FR'],
    [{ locale: 'en_GB' }, ['de-DE'], 'en-US'],
    // A language that the app doesn't have is English, even if the browser has another language
    [{ locale: 'it_IT' }, ['de-DE'], 'en-US'],
  ];
  for (const [tv, languages, expected] of cases) {
    assert.equal(await loadI18n(tv, languages).detectLocale(), expected, JSON.stringify([tv, languages]));
  }
});

test('without an answer of the TV the first browser language that the app has is the language of the app', async () => {
  const cases = [
    // The simulated TV fails the LOCALE property by default
    [{}, ['de-CH', 'en-US'], 'de-DE'],
    [{}, ['nl-NL', 'pt-PT', 'en-US'], 'pt-BR'],
    [{}, ['ca-ES', 'es-ES', 'en-US'], 'es-ES'],
    [{}, ['nl-BE', 'fr-BE', 'en-US'], 'fr-FR'],
    [{}, ['it-IT'], 'en-US'],
    [{}, [], 'en-US'],
    // getPropertyValue() itself throws
    [{ failApis: 'tizen.systeminfo.getPropertyValue' }, ['de-DE'], 'de-DE'],
  ];
  for (const [tv, languages, expected] of cases) {
    assert.equal(await loadI18n(tv, languages).detectLocale(), expected, JSON.stringify([tv, languages]));
  }
});

test('no message gets an English word as the value of a placeholder', () => {
  // e.g. the name of an unknown host in 'Failed to connect to %1$s...' went in as the English 'the host'
  const scripts = ['index.js', 'messages.js', 'menus.js', 'launcher.js', 'gamepad.js', 'audio.js'].map((name) =>
    fs.readFileSync(path.join(REPO_ROOT, 'wasm/platform', name), 'utf8')).join('\n');
  const literalValues = scripts.match(/\b(?:snackbarLog|snackbarLogLong|t)\(\s*'[^']*%1\$s[^']*',\s*'[^']*'\s*[,)]/g) || [];
  assert.deepEqual(literalValues, []);
});

test('every language keeps the key names as printed on the remote, the keyboard and the gamepad (docs/TRANSLATING.md)', () => {
  const read = (locale) => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale + '.json'), 'utf8'));
  const english = read('en-US');
  const names = ['OK', 'RETURN', 'CH+', 'Play/Pause', 'PLAY/PAUSE', 'SELECT', 'START', 'LB', 'RB', 'ESC'];
  Object.keys(CHOSEN_LANGUAGES).filter((locale) => locale !== 'en-US').forEach((locale) => {
    const texts = read(locale);
    names.forEach((name) => {
      const pattern = new RegExp('(^|[^\\w/])' + name.replace(/[+/]/g, '\\$&') + '($|[^\\w/])');
      Object.keys(english).filter((key) => pattern.test(english[key])).forEach((key) => {
        assert.ok(pattern.test(texts[key]), locale + ': ' + name + ' in ' + JSON.stringify(texts[key]));
      });
    });
  });
  // Brazilian Portuguese named RETURN two ways in one release
  const portuguese = read('pt-BR');
  assert.deepEqual(Object.keys(portuguese).filter((key) => /RETORNAR|Reproduzir\/Pausar|SELETO/i.test(portuguese[key])), []);
});
