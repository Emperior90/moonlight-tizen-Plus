'use strict';

// Pins the texts and start values of the menus that 2.3.1 completes:
// - the Add PC dialog starts its number fields from the network of the TV (getDefaultIpAddressNumbers() in
//   wasm/platform/index.js) instead of always from 192.168.0.0;
// - the names of the buttons for the Voice Guide of the TV (aria-label) follow the language of the app: wasm/index.html
//   names their key, the translation pass of wasm/platform/i18n.js sets them, and wasm/static/js/i18n-sync.js keeps
//   their keys in the locale files;
// - the full statistics translate the count of the video pipeline resets and the kinds of the rejections of the TV
//   player (replaceKnownStatsLabels() in wasm/platform/messages.js), which stayed English in every language.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts, plain } = require('./helpers/platform-loader');

const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'wasm/index.html'), 'utf8');
const LOCALES = ['de-DE', 'es-ES', 'fr-FR', 'pt-BR'];
const readLocale = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/locales', name + '.json'), 'utf8'));

// A t() that translates with a locale file like i18n.js does
function translator(locale) {
  const messages = readLocale(locale);
  return (key, ...values) => {
    const text = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key;
    return text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1]));
  };
}

test('the number fields of the Add PC dialog start from the network of the TV', () => {
  const numbers = (tv) => plain(loadPlatformScripts(INDEX_SCRIPTS, { tv }).get('getDefaultIpAddressNumbers')());
  // The first three numbers of the address of the TV and a 0: one number is left to set for a PC in the same network
  // (192.168.0.0 for every TV before 2.3.1)
  assert.deepEqual(numbers({ ip: '192.168.178.20' }), [192, 168, 178, 0]);
  assert.deepEqual(numbers({ ip: '10.0.1.77' }), [10, 0, 1, 0]);
  assert.deepEqual(numbers({ ip: '172.16.254.3' }), [172, 16, 254, 0]);
  // No usable address: the start of the earlier versions
  ['0.0.0.0', '127.0.0.1', '', 'fe80::1ff:fe23:4567:890a', '192.168.1', '192.168.1.300', '192.168.1.x', 'undefined'].forEach((ip) => {
    assert.deepEqual(numbers({ ip }), [192, 168, 0, 0], JSON.stringify(ip));
  });
  // The TV doesn't tell its address
  const failing = loadPlatformScripts(INDEX_SCRIPTS, { tv: { ip: '192.168.178.20' } });
  failing.context.webapis.network.getIp = () => {
    throw new Error('Simulated network API failure');
  };
  assert.deepEqual(plain(failing.get('getDefaultIpAddressNumbers')()), [192, 168, 0, 0]);
  delete failing.context.webapis.network;
  assert.deepEqual(plain(failing.get('getDefaultIpAddressNumbers')()), [192, 168, 0, 0]);
});

// The opening tags of index.html that have an aria-label
function tagsWithAriaLabel() {
  return (INDEX_HTML.match(/<[a-z0-9]+\b[^>]*\saria-label="[^"]*"[^>]*>/g) || []).map((tag) => ({
    tag,
    id: (/\sid="([^"]+)"/.exec(tag) || [])[1],
    label: /\saria-label="([^"]*)"/.exec(tag)[1],
    key: (/\sdata-i18n-aria-label="([^"]*)"/.exec(tag) || [])[1],
  }));
}

test('every button name for the Voice Guide in index.html has its key, which every language translates', () => {
  const tags = tagsWithAriaLabel();
  // The header of the PC list, Add PC and the buttons of the settings (English in every language before 2.3.1)
  ['goBackBtn', 'rescanNetworkBtn', 'settingsBtn', 'supportBtn', 'restoreDefaultsBtn', 'quitRunningAppBtn', 'addHostContainer',
    'optimalSettingsBtn', 'checkUpdatesBtn', 'restartAppBtn'].forEach((id) => assert.ok(tags.some((entry) => entry.id === id), id));
  const english = readLocale('en-US');
  tags.forEach((entry) => {
    assert.equal(entry.key, entry.label, entry.id + ': data-i18n-aria-label is the English name');
    assert.ok(Object.prototype.hasOwnProperty.call(english, entry.key), entry.id + ': ' + entry.key);
    LOCALES.forEach((locale) => {
      const translated = readLocale(locale)[entry.key];
      assert.ok(translated && translated !== entry.key, locale + ' translates "' + entry.key + '"');
    });
  });
  // The update button, which index.js adds, is named like its text
  const indexJs = fs.readFileSync(path.join(REPO_ROOT, 'wasm/platform/index.js'), 'utf8');
  assert.match(indexJs, /'aria-label': t\('New update v%1\$s', latestVersion\),\s+'data-i18n-aria-label': 'New update v%1\$s',\s+'data-param': latestVersion/);
});

test('the translation pass sets the button names in the language of the app', async () => {
  const element = (attributes) => ({
    attributes: Object.assign({}, attributes),
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const settings = element({ 'aria-label': 'Settings', 'data-i18n-aria-label': 'Settings' });
  const update = element({ 'aria-label': 'New update v9.9.9', 'data-i18n-aria-label': 'New update v%1$s', 'data-param': '9.9.9' });
  const untouched = element({ 'aria-label': 'Logo' });
  const platform = loadPlatformScripts(['wasm/platform/i18n.js'], {
    globals: {
      fetch: (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(readLocale(/([a-zA-Z-]+)\.json$/.exec(url)[1])) }),
      document: {
        documentElement: element({}),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: (selector) => (selector === '[data-i18n-aria-label]' ? [settings, update] : []),
      },
    },
  });
  const i18n = platform.get('i18n');
  for (const locale of LOCALES) {
    assert.equal(await i18n.setLanguage(locale), locale);
    const t = translator(locale);
    assert.equal(settings.attributes['aria-label'], t('Settings'), locale);
    assert.notEqual(settings.attributes['aria-label'], 'Settings', locale);
    assert.equal(update.attributes['aria-label'], t('New update v%1$s', '9.9.9'), locale);
    assert.ok(update.attributes['aria-label'].indexOf('9.9.9') >= 0, locale);
  }
  // Back to English
  assert.equal(await i18n.setLanguage('en-US'), 'en-US');
  assert.equal(settings.attributes['aria-label'], 'Settings');
  assert.equal(update.attributes['aria-label'], 'New update v9.9.9');
  assert.equal(untouched.attributes['aria-label'], 'Logo');
});

test('i18n-sync.js keeps a key that only a button name uses', () => {
  // The tool on a small copy of the app: a page with one text and one button name, and a locale that has both
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-sync-'));
  try {
    const write = (relativePath, content) => {
      fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(root, relativePath), content);
    };
    write('wasm/static/js/i18n-sync.js', fs.readFileSync(path.join(REPO_ROOT, 'wasm/static/js/i18n-sync.js'), 'utf8'));
    write('wasm/index.html', '<span data-i18n="A text">A text</span><button aria-label="Only a button name" data-i18n-aria-label="Only a button name"></button>');
    write('wasm/static/locales/de-DE.json', JSON.stringify({ 'A text': 'Ein Text', 'Only a button name': 'Nur ein Tastenname', 'No longer used': 'Nicht mehr benutzt' }));
    childProcess.execFileSync(process.execPath, [path.join(root, 'wasm/static/js/i18n-sync.js')], { stdio: 'pipe' });
    const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'wasm/static/locales', name), 'utf8'));
    assert.deepEqual(read('en-US.json'), { 'A text': 'A text', 'Only a button name': 'Only a button name' });
    // The translation of the button name stays (the tool dropped the key as unused before 2.3.1)
    assert.deepEqual(read('de-DE.json'), { 'A text': 'Ein Text', 'Only a button name': 'Nur ein Tastenname' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The two lines of the full statistics as FormatVideoStats() of wasm/wasmplayer.cpp writes them
const DROPPED = 'Session frames dropped by the TV: 4 (video pipeline resets: 1)';
const REJECTIONS = 'TV player rejections: buffer full 4 (3 recovered), keyframe required 1, track not ready 0, other 2 (last code -3)';

test('the sample lines of the statistics are those of the native code', () => {
  const native = fs.readFileSync(path.join(REPO_ROOT, 'wasm/wasmplayer.cpp'), 'utf8');
  assert.ok(native.includes('"Session frames dropped by the TV: %u (video pipeline resets: %u)\\n"'));
  assert.ok(native.includes('"TV player rejections: buffer full %u (%u recovered), keyframe required %u, track not ready %u, other %u (last code %d)\\n"'));
});

test('the full statistics translate the video pipeline resets and the kinds of the TV player rejections', () => {
  const translate = (locale) => loadPlatformScripts(['wasm/platform/messages.js'], { globals: { t: translator(locale) } }).get('replaceKnownStatsLabels');
  // English keeps the lines
  assert.equal(translate('en-US')(DROPPED + '\n' + REJECTIONS), DROPPED + '\n' + REJECTIONS);
  LOCALES.forEach((locale) => {
    const t = translator(locale);
    const lines = translate(locale)(DROPPED + '\n' + REJECTIONS).split('\n');
    assert.equal(lines[0], t('Session frames dropped by the TV:') + ' 4 ' + t('(video pipeline resets: %1$s)', '1'), locale);
    assert.equal(lines[1], t('TV player rejections:') + ' ' +
      t('buffer full %1$s (%2$s recovered), keyframe required %3$s, track not ready %4$s, other %5$s (last code %6$s)', '4', '3', '1', '0', '2', '-3'), locale);
    // Nothing of the two lines stays English, and every number is still there
    assert.doesNotMatch(lines.join('\n'), /video pipeline resets|buffer full|recovered|keyframe required|track not ready|other|last code/, locale);
    assert.deepEqual(lines[1].match(/-?\d+/g), ['4', '3', '1', '0', '2', '-3'], locale);
    assert.deepEqual(lines[0].match(/\d+/g), ['4', '1'], locale);
  });
  assert.equal(translate('de-DE')(DROPPED), 'Vom TV verworfene Frames (Sitzung): 4 (Video-Neustarts: 1)');
});
