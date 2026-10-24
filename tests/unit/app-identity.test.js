'use strict';

// Pins the identifiers that let an update install over the current build with its settings and pairing kept, and
// that let it run next to the regular Moonlight app (plan decision D2 and the last rows of the S90C invariants in plan
// section 3): the package, app and service IDs, the Smart Hub preview port and the preview file prefix. The display
// name may change; these must not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

// Return the value of an XML attribute of the first element with the given tag name
function xmlAttribute(xml, tagName, attribute) {
  const element = new RegExp('<' + tagName + '\\b[^>]*>').exec(xml);
  assert.ok(element, 'element <' + tagName + '> not found');
  const value = new RegExp('\\s' + attribute + '="([^"]*)"').exec(element[0]);
  assert.ok(value, 'attribute ' + attribute + ' of <' + tagName + '> not found');
  return value[1];
}

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
