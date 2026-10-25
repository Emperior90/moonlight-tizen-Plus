'use strict';

// Every translation pass of wasm/platform/i18n.js (at the start and after a change of the language) rewrites each
// element with a data-i18n attribute from its key. A dialog title or text that the scripts set when the dialog opens
// must therefore not have one: a dialog that opened before the first translation pass had its title reset to the
// placeholder 'Warning' and its text to the placeholder text. This checks wasm/index.html against the scripts, and the
// browser tests (browser/startup-robustness.test.js) check the dialogs themselves. The buttons whose label the scripts
// switch (e.g. Cancel and Close of the pairing dialog) keep their data-i18n attribute, since the scripts set their
// first label back when the dialog opens again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const INDEX_HTML = path.join(REPO_ROOT, 'wasm', 'index.html');
const PLATFORM_DIR = path.join(REPO_ROOT, 'wasm', 'platform');

// The IDs of the elements whose content the platform scripts set, with getElementById(id).innerHTML/innerText/
// textContent = ... or $('#id').html(...)/.text(...)
function idsWithContentSetByScripts() {
  const ids = new Set();
  fs.readdirSync(PLATFORM_DIR).filter((name) => name.endsWith('.js')).forEach((name) => {
    const source = fs.readFileSync(path.join(PLATFORM_DIR, name), 'utf8');
    const patterns = [
      /getElementById\('([A-Za-z0-9_-]+)'\)\.(?:innerHTML|innerText|textContent)\s*=[^=]/g,
      /\$\('#([A-Za-z0-9_-]+)'\)\.(?:html|text)\(\s*[^)\s]/g,
    ];
    patterns.forEach((pattern) => {
      let match = null;
      while ((match = pattern.exec(source)) !== null) {
        ids.add(match[1]);
      }
    });
  });
  return ids;
}

// The opening tags of the elements inside the <dialog> elements of index.html, by ID
function dialogElementTags() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const tags = new Map();
  const dialogPattern = /<dialog\b[\s\S]*?<\/dialog>/g;
  let dialog = null;
  while ((dialog = dialogPattern.exec(html)) !== null) {
    const tagPattern = /<[a-z0-9]+\b[^>]*\bid="([^"]+)"[^>]*>/g;
    let tag = null;
    while ((tag = tagPattern.exec(dialog[0])) !== null) {
      tags.set(tag[1], tag[0]);
    }
  }
  return tags;
}

test('no dialog title or text that the scripts set has a data-i18n attribute', () => {
  const setByScripts = idsWithContentSetByScripts();
  const tags = dialogElementTags();
  const checked = Array.from(setByScripts).filter((id) => tags.has(id) && /Dialog(?:Title|Text)$/.test(id)).sort();
  // The check has to see the dialogs it is about
  ['warningDialogTitle', 'warningDialogText', 'deleteHostDialogTitle', 'deleteHostDialogText', 'quitAppDialogText',
    'restartAppDialogText', 'pairingDialogText'].forEach((id) => assert.ok(checked.indexOf(id) >= 0, id));
  const offending = checked.filter((id) => /\sdata-i18n=/.test(tags.get(id)));
  assert.deepEqual(offending, [], 'remove data-i18n from these elements, since the translation pass would reset what the scripts set');
});

test('the static texts of the dialogs keep their data-i18n attribute', () => {
  const tags = dialogElementTags();
  ['restoreDefaultsDialogTitle', 'restoreDefaultsDialogText', 'restartAppDialogTitle', 'quitAppDialogTitle', 'closeWarning',
    'continueWarning'].forEach((id) => assert.ok(/\sdata-i18n=/.test(tags.get(id) || ''), id));
});
