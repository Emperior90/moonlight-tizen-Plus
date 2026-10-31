'use strict';

// Pins the identifiers that let an update install over the current build with its settings and pairing kept, and
// that let it run next to the regular Moonlight app (the last rows of the S90C invariants): the package, app and service IDs, the Smart Hub preview port and the preview file prefix. These must not
// change.
//
// Also checks the branding as Moonlight Plus: the display name 'Moonlight Plus' in res/config.xml and
// in the header of the app, a description that says it is an unofficial Moonlight fork, a numeric version, the icon
// size and format, and that the simulated TV of the tests reports the name and version of res/config.xml.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');
const tvMock = require('../browser/mocks/tv-mock');

const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

// Return the value of an XML attribute of the first element with the given tag name
function xmlAttribute(xml, tagName, attribute) {
  const element = new RegExp('<' + tagName + '\\b[^>]*>').exec(xml);
  assert.ok(element, 'element <' + tagName + '> not found');
  const value = new RegExp('\\s' + attribute + '="([^"]*)"').exec(element[0]);
  assert.ok(value, 'attribute ' + attribute + ' of <' + tagName + '> not found');
  return value[1];
}

// Return the text of the first element with the given tag name
function xmlText(xml, tagName) {
  const element = new RegExp('<' + tagName + '\\b[^>]*>([^<]*)</' + tagName + '>').exec(xml);
  assert.ok(element, 'element <' + tagName + '> not found');
  return element[1];
}

const DISPLAY_NAME = 'Moonlight Plus';

test('config.xml keeps the widget, package, app and service IDs', () => {
  const xml = read('res/config.xml');
  assert.equal(xmlAttribute(xml, 'widget', 'id'), 'http://samsung.tv/MoonlightWasmS90C');
  assert.equal(xmlAttribute(xml, 'tizen:application', 'package'), 'MLightS90C');
  assert.equal(xmlAttribute(xml, 'tizen:application', 'id'), 'MLightS90C.MoonlightWasm');
  assert.equal(xmlAttribute(xml, 'tizen:service', 'id'), 'MLightS90C.service');
});

test('config.xml keeps Tizen 5.5 as the oldest supported platform', () => {
  assert.equal(xmlAttribute(read('res/config.xml'), 'tizen:application', 'required_version'), '5.5');
});

test('the app and the Smart Hub service use the preview port 8889', () => {
  const platform = loadPlatformScripts(INDEX_SCRIPTS);
  assert.equal(platform.get('SMART_HUB_PREVIEW_PORT'), 8889);
  const portMatch = /\bvar PREVIEW_PORT = (\d+);/.exec(read('res/service/service.js'));
  assert.ok(portMatch, 'PREVIEW_PORT not found in res/service/service.js');
  assert.equal(Number(portMatch[1]), 8889);
});

test('the preview images keep their file prefix', () => {
  const prefixMatch = /\bvar SMART_HUB_PREVIEW_FILE_PREFIX = '([^']*)';/.exec(read('wasm/static/js/utils.js'));
  assert.ok(prefixMatch, 'SMART_HUB_PREVIEW_FILE_PREFIX not found in wasm/static/js/utils.js');
  assert.equal(prefixMatch[1], 'preview-s90c-');
});

test('the service derives the app ID from the package ID', () => {
  const service = read('res/service/service.js');
  assert.ok(/var packageId = tizen\.application\.getCurrentApplication\(\)\.appInfo\.packageId;/.test(service));
  assert.ok(/var applicationId = packageId \+ '\.MoonlightWasm';/.test(service));
});

test('config.xml names the app Moonlight Plus, without a TV model or Samsung in the name', () => {
  const name = xmlText(read('res/config.xml'), 'name');
  assert.equal(name, DISPLAY_NAME);
  // Plan section 5: no "Samsung" in the app name, and not the plain name of the official app
  assert.doesNotMatch(name, /samsung|s90c/i);
  assert.notEqual(name.trim(), 'Moonlight');
});

test('config.xml describes the app as an unofficial Moonlight fork for Samsung Tizen TVs', () => {
  const description = xmlText(read('res/config.xml'), 'description');
  assert.match(description, /\bunofficial\b/i);
  assert.match(description, /\bfork\b/i);
  assert.match(description, /\bMoonlight\b/);
  assert.match(description, /\bTizen TVs\b/);
  assert.doesNotMatch(description, /s90c/i);
});

test('config.xml has a numeric x.y.z version that Tizen accepts', () => {
  const version = xmlAttribute(read('res/config.xml'), 'widget', 'version');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, 'version ' + version + ' is not x.y.z');
  // The limits believed to apply to Tizen widget versions: x and y up to 255, z up to 65535
  assert.ok(Number(match[1]) <= 255 && Number(match[2]) <= 255 && Number(match[3]) <= 65535, version);
  assert.equal(version, '2.2.0');
});

test('the header of the app shows the display name of config.xml, translated through its own locale key', () => {
  const header = /<span id="header-title"[^>]*\sdata-i18n="([^"]*)"[^>]*>([^<]*)<\/span>/.exec(read('wasm/index.html'));
  assert.ok(header, 'the header title was not found in wasm/index.html');
  assert.equal(header[1], DISPLAY_NAME);
  assert.equal(header[2], DISPLAY_NAME);
  const english = JSON.parse(read('wasm/static/locales/en-US.json'));
  const portuguese = JSON.parse(read('wasm/static/locales/pt-BR.json'));
  assert.equal(english[DISPLAY_NAME], DISPLAY_NAME);
  // A name, the same in every language
  assert.equal(portuguese[DISPLAY_NAME], DISPLAY_NAME);
});

test('the icon stays a 512 x 512 PNG', () => {
  const png = fs.readFileSync(path.join(REPO_ROOT, 'res/icon.png'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 512, 'width');
  assert.equal(png.readUInt32BE(20), 512, 'height');
  // 8 bits per channel, colour type 2 (RGB without alpha), as before
  assert.equal(png[24], 8);
  assert.equal(png[25], 2);
});

test('the simulated TV of the tests reports the IDs, name and version of config.xml', () => {
  const xml = read('res/config.xml');
  const appInfo = tvMock.createTizenApis(tvMock.parseConfig('', {})).tizen.application.getAppInfo();
  assert.equal(appInfo.id, xmlAttribute(xml, 'tizen:application', 'id'));
  assert.equal(appInfo.packageId, xmlAttribute(xml, 'tizen:application', 'package'));
  assert.equal(appInfo.name, xmlText(xml, 'name'));
  assert.equal(appInfo.version, xmlAttribute(xml, 'widget', 'version'));
});

// The support path of the fork: the Support dialog and the help texts of the app lead to
// the guide and the issue tracker of Moonlight Plus, not to the wiki of upstream Moonlight Tizen
const FORK_GUIDE_URL = 'https://github.com/Emperior90/moonlight-tizen-Plus/blob/HEAD/docs/GUIDE.md';

test('the Support dialog names Moonlight Plus and its issue tracker, and its QR code leads to the guide of the fork', () => {
  const html = read('wasm/index.html');
  const dialog = /<dialog id="appSupportDialog"[\s\S]*?<\/dialog>/.exec(html);
  assert.ok(dialog, 'the Support dialog');
  assert.match(dialog[0], /data-i18n="Moonlight Plus Support"/);
  assert.match(dialog[0], /Please report problems with Moonlight Plus on its issue tracker on GitHub, not to Moonlight Tizen\./);
  assert.match(dialog[0], /<img src="static\/res\/support_qr_code\.svg" id="supportQrCode">/);
  // The SVG names the URL that its modules encode (decoded once with a QR reader when it was generated); the issue
  // template links the same guide
  const svg = read('wasm/static/res/support_qr_code.svg');
  assert.ok(svg.indexOf('<!-- QR code of ' + FORK_GUIDE_URL + ' ') >= 0, 'the QR code names the guide of the fork');
  assert.match(svg, /<svg [^>]*width="\d+" height="\d+" viewBox="0 0 \d+ \d+"/, 'the QR code has an intrinsic size');
  assert.ok(read('.github/ISSUE_TEMPLATE/config.yml').indexOf(FORK_GUIDE_URL) >= 0);
});

test('no text of the app points to the wiki of upstream Moonlight Tizen', () => {
  const locale = JSON.parse(read('wasm/static/locales/en-US.json'));
  const wikiTexts = Object.keys(locale).filter((key) => /\bwiki\b/i.test(key));
  assert.deepEqual(wikiTexts, []);
  assert.ok(!/brightcraft\/moonlight-tizen\/wiki/.test(read('wasm/index.html')));
  assert.ok(!/brightcraft\/moonlight-tizen\/wiki/.test(read('wasm/platform/index.js')));
});
