'use strict';

// The languages in the real page: the language of the TV (tizen.systeminfo LOCALE of the simulated TV) picks the
// language of the app (a German TV in Austria or Switzerland gets German, a Spanish TV in Mexico Spanish, a French TV in
// Canada French), and the language menu of the General settings lists Auto and every language by its own name, reached and
// chosen with the remote and with a gamepad. Picking a language translates the page at once and stores it; Auto follows
// the TV again. Every data-i18n text of the page is a key of the locale files (the browser decodes &amp; in the
// attribute) and shows translated in every language, System information names the connection in the language of the
// app, and the tooltips of the header buttons (also Quit app on the PC and the button of a new update) take one line
// inside the safe area of the screen under their button in every language, also with text 10 % wider than this machine
// draws it (tests/browser/text-stress.js). The rules of wasm/platform/i18n.js itself are in
// tests/unit/i18n-locales.test.js, the German texts in tests/unit/german-texts.test.js, the Spanish and French texts in
// tests/unit/spanish-french-texts.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { openApp, startHarness, waitForStorage } = require('./harness');
const { forEachTextWidth } = require('./text-stress');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const TV = { tv: 's90c', conn: 'wifi' };
const lang = (page) => page.evaluate(() => document.documentElement.getAttribute('lang'));
const waitForFocus = (page, id) => page.waitForFunction((elementId) => document.activeElement && document.activeElement.id === elementId, id, { timeout: 3000 });
// The entries of the language menu: value, text and lang attribute
const menuEntries = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('ul.languageMenu li'),
  (li) => [li.getAttribute('data-value'), li.textContent.trim(), li.getAttribute('lang')]));
const languageButton = (page) => page.evaluate(() => {
  const button = document.getElementById('selectLanguage');
  return [button.getAttribute('data-value'), button.textContent.trim(), button.getAttribute('lang')];
});

// Settings, DOWN to General (the fifth section), OK: the focus goes to the language field
async function openLanguageField(page) {
  await page.evaluate(() => $('#settingsBtn').trigger('click'));
  await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
  await page.waitForTimeout(100);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  await waitForFocus(page, 'selectLanguage');
}

test('the language of the TV picks the language of the app: German also in Austria and Switzerland, Spanish in the Americas, French in Canada, else English', async () => {
  const cases = [
    ['de_DE', 'de-DE', 'Einstellungen'],
    ['de_AT', 'de-DE', 'Einstellungen'],
    ['de_CH', 'de-DE', 'Einstellungen'],
    ['es_ES', 'es-ES', 'Ajustes'],
    ['es_MX', 'es-ES', 'Ajustes'],
    ['fr_FR', 'fr-FR', 'Paramètres'],
    ['fr_CA', 'fr-FR', 'Paramètres'],
    ['pt_PT', 'pt-BR', 'Configurações'],
    ['it_IT', 'en-US', 'Settings'],
    ['en_GB', 'en-US', 'Settings'],
  ];
  for (const [locale, expected, settings] of cases) {
    const app = await openApp(harness, { tv: Object.assign({ locale }, TV) });
    try {
      assert.equal(await lang(app.page), expected, locale);
      assert.equal(await app.page.evaluate(() => t('Settings')), settings, locale);
      // The translation pass ran over the page
      assert.equal(await app.page.evaluate(() => $('[data-i18n="Settings"]').first().text().trim()), settings, locale);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the language menu lists Auto and each language by its own name, and a choice translates the page and is stored', async () => {
  const app = await openApp(harness, { tv: Object.assign({ locale: 'en_US' }, TV) });
  const { page } = app;
  try {
    await openLanguageField(page);
    assert.deepEqual(await languageButton(page), ['auto', 'Auto', null]);
    // OK opens the menu: Auto in the language of the app, then English, Deutsch, Español, Français, Português (Brasil)
    // in their own language
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => isPopupMenuActive('languageMenu'));
    const names = await page.evaluate(() => i18n.getLocaleNames());
    assert.deepEqual(await menuEntries(page), [['auto', 'Auto', null]].concat(names.map((locale) => [locale.code, locale.name, locale.code])));
    assert.deepEqual(names, [{ code: 'en-US', name: 'English' }, { code: 'de-DE', name: 'Deutsch' }, { code: 'es-ES', name: 'Español' },
      { code: 'fr-FR', name: 'Français' }, { code: 'pt-BR', name: 'Português (Brasil)' }]);

    // DOWN to Deutsch (Auto, English, Deutsch) and OK: the page turns German, the choice is stored
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE');
    await waitForStorage(page, (values) => values.languagePreference === 'de-DE');
    await waitForFocus(page, 'selectLanguage');
    assert.equal(await page.evaluate(() => isPopupMenuActive('languageMenu')), false);
    assert.deepEqual(await languageButton(page), ['de-DE', 'Deutsch', 'de-DE']);
    assert.equal(await page.evaluate(() => $('#header-title').text().trim()), 'Einstellungen');
    assert.equal(await page.evaluate(() => $('#interfaceSettings label[data-i18n="Language"]').text().trim()), 'Sprache');
    // Auto is German now, the names of the languages stay as they are
    assert.deepEqual(await menuEntries(page), [['auto', 'Automatisch', null]].concat(names.map((locale) => [locale.code, locale.name, locale.code])));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a stored language wins over the TV, Auto follows the TV again, and a language the app lacks counts as Auto', async () => {
  // German stored on a Brazilian TV: German at the start, Auto back to Portuguese
  const app = await openApp(harness, { tv: Object.assign({ locale: 'pt_BR' }, TV), stored: { languagePreference: 'de-DE' } });
  const { page } = app;
  try {
    assert.equal(await lang(page), 'de-DE');
    await openLanguageField(page);
    assert.deepEqual(await languageButton(page), ['de-DE', 'Deutsch', 'de-DE']);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => isPopupMenuActive('languageMenu'));
    // The highlight starts on the first entry, Auto
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'pt-BR');
    await waitForStorage(page, (values) => values.languagePreference === 'auto');
    assert.deepEqual(await languageButton(page), ['auto', 'Automático', null]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }

  // A stored language that the app doesn't have follows the TV
  const unknown = await openApp(harness, { tv: Object.assign({ locale: 'de_AT' }, TV), stored: { languagePreference: 'it-IT' } });
  try {
    assert.equal(await lang(unknown.page), 'de-DE');
    assert.deepEqual(await languageButton(unknown.page), ['auto', 'Automatisch', null]);
    assert.deepEqual(unknown.errors, []);
  } finally {
    await unknown.context.close();
  }
});

test('a gamepad reaches the language menu and picks a language with the D-pad and A', async () => {
  const app = await openApp(harness, { tv: Object.assign({ locale: 'en_US' }, TV) });
  const { page } = app;
  // A press and release of a button, as gamepad.js reports it to the menu handler of index.js
  const button = async (index) => {
    for (const pressed of [true, false]) {
      await page.evaluate(({ i, down }) => window.dispatchEvent(new CustomEvent('gamepadinputchanged',
        { detail: { changes: [{ type: 'button', index: i, pressed: down }] } })), { i: index, down: pressed });
    }
    // A runs after the navigation delay of 150 ms
    await page.waitForTimeout(300);
  };
  const DPAD_DOWN = 13;
  const A = 0;
  try {
    await page.evaluate(() => $('#settingsBtn').trigger('click'));
    await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
    await page.waitForTimeout(100);
    // The D-pad down to General, the fifth section
    for (let i = 0; i < 4; i++) {
      await button(DPAD_DOWN);
    }
    await button(A);
    await waitForFocus(page, 'selectLanguage');
    await button(A);
    await page.waitForFunction(() => isPopupMenuActive('languageMenu'));
    await button(DPAD_DOWN);
    await button(DPAD_DOWN);
    await button(A);
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'de-DE');
    await waitForStorage(page, (values) => values.languagePreference === 'de-DE');
    // The focus goes back to the language field once the menu has closed
    await waitForFocus(page, 'selectLanguage');
    assert.equal(await page.evaluate(() => isPopupMenuActive('languageMenu')), false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Français with the remote and Español with a gamepad translate the page, and Auto is in their language', async () => {
  const app = await openApp(harness, { tv: Object.assign({ locale: 'en_US' }, TV) });
  const { page } = app;
  const button = async (index) => {
    for (const pressed of [true, false]) {
      await page.evaluate(({ i, down }) => window.dispatchEvent(new CustomEvent('gamepadinputchanged',
        { detail: { changes: [{ type: 'button', index: i, pressed: down }] } })), { i: index, down: pressed });
    }
    await page.waitForTimeout(300);
  };
  const DPAD_UP = 12;
  const A = 0;
  const highlighted = () => page.evaluate(() => $('ul.languageMenu li.hovered').attr('data-value'));
  try {
    await openLanguageField(page);
    // Remote: OK, DOWN four times (Auto, English, Deutsch, Español, Français), OK
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => isPopupMenuActive('languageMenu'));
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'fr-FR');
    await waitForStorage(page, (values) => values.languagePreference === 'fr-FR');
    await waitForFocus(page, 'selectLanguage');
    assert.deepEqual(await languageButton(page), ['fr-FR', 'Français', 'fr-FR']);
    assert.equal(await page.evaluate(() => $('#header-title').text().trim()), 'Paramètres');
    assert.equal(await page.evaluate(() => $('#interfaceSettings label[data-i18n="Language"]').text().trim()), 'Langue');
    assert.equal((await menuEntries(page))[0][1], 'Automatique');

    // Gamepad: A opens the menu on the current language, Français; the D-pad up once to Español, A
    await button(A);
    await page.waitForFunction(() => isPopupMenuActive('languageMenu'));
    assert.equal(await highlighted(), 'fr-FR');
    await button(DPAD_UP);
    assert.equal(await highlighted(), 'es-ES');
    await button(A);
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'es-ES');
    await waitForStorage(page, (values) => values.languagePreference === 'es-ES');
    await waitForFocus(page, 'selectLanguage');
    assert.deepEqual(await languageButton(page), ['es-ES', 'Español', 'es-ES']);
    assert.equal(await page.evaluate(() => $('#header-title').text().trim()), 'Ajustes');
    assert.equal(await page.evaluate(() => $('#interfaceSettings label[data-i18n="Language"]').text().trim()), 'Idioma');
    assert.equal((await menuEntries(page))[0][1], 'Automático');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('every data-i18n text of the page is a key of the locale files, so that every language translates it', async () => {
  // The browser decodes character references in attribute values, e.g. data-i18n="press &amp; hold" reads 'press & hold'
  const languages = fs.readdirSync(path.join(REPO_ROOT, 'wasm/static/locales')).filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')).filter((name) => name !== 'en-US');
  // The list of the source texts stays in the repository, but not in the widget (CMakeLists.txt)
  const englishKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales/en-US.json'), 'utf8')));
  for (const language of languages) {
    const app = await openApp(harness, { tv: TV, stored: { languagePreference: language } });
    try {
      const result = await app.page.evaluate(async ({ code, keys }) => {
        const english = {};
        keys.forEach((key) => { english[key] = key; });
        const translated = await fetch('static/locales/' + code + '.json').then((response) => response.json());
        const missing = [];
        const untranslated = [];
        document.querySelectorAll('[data-i18n], [data-i18n-placeholder]').forEach((element) => {
          const key = element.getAttribute('data-i18n') || element.getAttribute('data-i18n-placeholder');
          if (!Object.prototype.hasOwnProperty.call(english, key)) {
            missing.push(key);
          } else if (element.hasAttribute('data-i18n') && translated[key] !== key && element.textContent.trim() === key.trim()) {
            // Still the English text (the value fields of the menus show their chosen entry instead)
            untranslated.push(key);
          }
        });
        return { lang: document.documentElement.getAttribute('lang'), missing, untranslated };
      }, { code: language, keys: englishKeys });
      assert.deepEqual(result, { lang: language, missing: [], untranslated: [] });
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('English needs no locale file and a translated language loads only its own, since the widget has no en-US.json', async () => {
  // Every fetch of the page, recorded from before the first script of the app
  const recordFetches = () => {
    window.__fetchedUrls = [];
    const originalFetch = window.fetch;
    window.fetch = function(resource) {
      window.__fetchedUrls.push(String(resource && resource.url ? resource.url : resource));
      return originalFetch.apply(this, arguments);
    };
  };
  const cases = [['en_US', 'en-US', 'Settings', []], ['de_DE', 'de-DE', 'Einstellungen', ['static/locales/de-DE.json']]];
  for (const [locale, expectedLang, settingsText, expectedFetches] of cases) {
    const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi', locale }, initScripts: [recordFetches] });
    try {
      assert.equal(await lang(app.page), expectedLang);
      assert.equal(await app.page.evaluate(() => i18n.t('Settings')), settingsText);
      // A text without a translation shows its key, with its values filled in
      assert.equal(await app.page.evaluate(() => i18n.t('No such text %1$s', 'X')), 'No such text X');
      // English after a switch from German, and back: still no request for en-US.json
      await app.page.evaluate(() => i18n.setLanguage('en-US'));
      assert.equal(await lang(app.page), 'en-US');
      assert.equal(await app.page.evaluate(() => i18n.t('Settings')), 'Settings');
      const localeFetches = await app.page.evaluate(() => window.__fetchedUrls.filter((url) => url.indexOf('locales/') >= 0));
      assert.deepEqual(localeFetches, expectedFetches, locale);
      assert.ok(!app.logs.some((line) => /Failed to load locale/.test(line)), app.logs.join('\n'));
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('System information names the network connection in the language of the app', async () => {
  const cases = [
    ['wifi', 'de_DE', 'Art der Netzwerkverbindung: WLAN'], ['ethernet', 'de_DE', 'Art der Netzwerkverbindung: Ethernet'],
    ['wifi', 'es_ES', 'Tipo de conexión de red: Wi-Fi'], ['ethernet', 'fr_FR', 'Type de connexion réseau\u00a0: Ethernet'],
  ];
  for (const [conn, locale, expected] of cases) {
    const app = await openApp(harness, { tv: { tv: 's90c', conn, locale } });
    try {
      const info = await app.page.evaluate(() => document.getElementById('systemInfoBtn').innerHTML.replace(/<br\s*\/?>/g, '\n')
        .replace(/&nbsp;/g, '\u00a0'));
      assert.ok(info.split('\n').indexOf(expected) >= 0, info);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('the tooltips of the header buttons take one line inside the safe area of the screen in every language, also with 10 % wider text', async () => {
  const languages = fs.readdirSync(path.join(REPO_ROOT, 'wasm/static/locales')).filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
  // The tooltip as the page places it for its button (material.min.js, then placeTooltip() of launcher.js), from its left
  // position and size, since it grows in from a scale of 0
  const tooltipBox = (page, button) => page.evaluate((id) => {
    document.getElementById(id).dispatchEvent(new MouseEvent('mouseenter'));
    const tooltip = document.querySelector('.mdl-tooltip[for="' + id + '"]');
    const rect = document.getElementById(id).getBoundingClientRect();
    const style = getComputedStyle(tooltip);
    const left = parseFloat(tooltip.style.left) + (parseFloat(tooltip.style.marginLeft) || 0);
    const box = { text: tooltip.textContent.trim(), left: Math.round(left), right: Math.round(left + tooltip.offsetWidth), width: innerWidth,
      button: [Math.round(rect.left), Math.round(rect.right)],
      lines: Math.round((tooltip.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight)) };
    document.getElementById(id).dispatchEvent(new MouseEvent('mouseleave'));
    return box;
  }, button);
  const check = async (page, buttons, where) => {
    await forEachTextWidth(page, async (stress) => {
      for (const button of buttons) {
        const box = await tooltipBox(page, button);
        const message = where + stress + ' ' + button + ' ' + JSON.stringify(box);
        // Inside the safe area of the screen (96 px from each edge, as the rest of the UI), which some TVs crop
        assert.ok(box.left >= 96 && box.right <= box.width - 96, message);
        // Under its button: centred, or flush with an edge of the button near the edge of the screen
        assert.ok(box.left <= box.button[1] && box.right >= box.button[0], message);
        assert.equal(box.lines, 1, message);
      }
    });
  };
  for (const language of languages) {
    const app = await openApp(harness, { tv: TV, stored: { languagePreference: language } });
    try {
      // The hosts screen with the button of a new update
      await app.page.evaluate(() => updateAppButton('9.0.0'));
      await check(app.page, ['updateAppBtn', 'rescanNetworkBtn', 'settingsBtn', 'supportBtn'], language + ' hosts');
      // The apps of a host whose app runs: Quit app on the PC, the rightmost button, which shows only while an app runs
      await app.page.evaluate(async () => {
        const host = {
          paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 13,
          appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
          refreshServerInfo: () => Promise.resolve(),
          getAppList: () => Promise.resolve([{ id: 12, title: 'Steam Big Picture' }, { id: 13, title: 'Cyberpunk 2077' }]),
          getAppById: (id) => Promise.resolve({ id: Number(id), title: 'Cyberpunk 2077' }),
          getBoxArt: () => Promise.resolve('static/res/placeholder_game.svg'),
          pollServer: (callback) => callback(host),
          toString: () => 'GAMING-PC',
        };
        api = host;
        await showApps(host);
        Navigation.switch();
        Navigation.change(Views.Apps);
      });
      await app.page.waitForFunction(() => $('#game-grid .game-container').length > 0 && $('#quitRunningAppBtn').is(':visible'), null, { timeout: 5000 });
      await check(app.page, ['quitRunningAppBtn'], language + ' apps');
      await app.page.evaluate(() => showSettings());
      await app.page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
      await check(app.page, ['goBackBtn', 'restoreDefaultsBtn'], language + ' settings');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});
