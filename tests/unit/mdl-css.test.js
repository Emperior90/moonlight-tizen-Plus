'use strict';

// wasm/static/css/material.min.css is Material Design Lite 1.3.0 trimmed by tools/trim-mdl-css.js to the rules that an
// element of the app can match: it keeps the licence header of MDL with a note of the change, has no rule left that
// the tool would remove (so a change of the app that leaves rules unused, or an untrimmed copy, shows up here), and
// still has the rules of every MDL component the app uses. The tool itself keeps classes inside :not(), attribute
// selectors and pseudo-classes out of its decision, and keeps a selector list with a vendor-prefixed pseudo-element
// whole. The screenshots of every scene were compared pixel by pixel before and after the trim (CHANGELOG.md, 2.2.0).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { trimCss, neededNames, splitTopLevel, HEADER } = require('../../tools/trim-mdl-css');

const CSS_FILE = path.join(REPO_ROOT, 'wasm/static/css/material.min.css');
const read = () => fs.readFileSync(CSS_FILE, 'utf8');

test('material.min.css starts with the Apache-2.0 header of MDL 1.3.0 and says that it was changed', () => {
  const css = read();
  assert.equal(css.indexOf(HEADER), 0);
  assert.match(HEADER, /@version v1\.3\.0\n \* @license Apache-2\.0\n \* @copyright 2015 Google, Inc\.\n/);
  assert.match(HEADER, /Changed for Moonlight Plus: tools\/trim-mdl-css\.js removed/);
  assert.equal(css.indexOf('/*', HEADER.length), -1, 'one comment only');
});

test('material.min.css has no rule left that no element of the app can match (run node tools/trim-mdl-css.js after a change)', () => {
  const css = read();
  const result = trimCss(css, REPO_ROOT);
  assert.equal(result.stats.removedRules, 0);
  assert.equal(result.css, css);
  // The untrimmed library is about 140 KB, the trimmed one about 57 KB
  assert.ok(Buffer.byteLength(css) < 70000, String(Buffer.byteLength(css)));
});

test('the rules of every MDL component that the app uses are still there', () => {
  const css = read();
  const has = (selector) => css.indexOf(selector + '{') >= 0 || css.indexOf(selector + ',') >= 0 || css.indexOf(',' + selector + '{') >= 0;
  [
    '.mdl-button', '.mdl-button--icon', '.mdl-switch', '.mdl-switch__track', '.mdl-switch__thumb', '.mdl-switch.is-checked .mdl-switch__thumb',
    '.mdl-menu__container', '.mdl-menu__item', '.mdl-menu__container.is-visible', '.mdl-slider', '.mdl-textfield', '.mdl-textfield__input',
    '.mdl-tooltip', '.mdl-tooltip.is-active', '.mdl-snackbar', '.mdl-snackbar--active', '.mdl-layout', '.mdl-dialog',
  ].forEach((selector) => assert.ok(has(selector), selector));
  // Parts of MDL that no element uses are gone
  ['.mdl-color--red', '.mdl-color-text--', '.mdl-cell--4-col', '.mdl-grid', '.mdl-mega-footer', '.mdl-mini-footer', '.mdl-typography--display-4', '.mdl-chip']
    .forEach((selector) => assert.equal(css.indexOf(selector), -1, selector));
});

test('trim-mdl-css decides on the classes and ids of a selector, without :not(), attributes and pseudo-classes', () => {
  assert.deepEqual(neededNames('.mdl-button:not(.mdl-button--icon):hover'), ['mdl-button']);
  assert.deepEqual(neededNames('.mdl-switch.is-checked>#x .y[data-a=".z"]::after'), ['mdl-switch', 'is-checked', 'x', 'y']);
  assert.deepEqual(neededNames('html input[type=button]'), []);
  assert.deepEqual(splitTopLevel('.a:not(.b,.c), .d [x="1,2"]'), ['.a:not(.b,.c)', '.d [x="1,2"]']);
});

test('trim-mdl-css removes unused rules and selectors, keeps @keyframes and vendor selector lists whole, and drops empty @media', () => {
  // A repository with an app that uses only the class "used"
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trim-mdl-'));
  try {
    fs.mkdirSync(path.join(root, 'wasm/platform'), { recursive: true });
    fs.mkdirSync(path.join(root, 'wasm/static/js/mdns-browser'), { recursive: true });
    fs.writeFileSync(path.join(root, 'wasm/index.html'), '<div class="used"></div>');
    fs.writeFileSync(path.join(root, 'wasm/static/js/utils.js'), '');
    fs.writeFileSync(path.join(root, 'wasm/static/js/material.min.js'), 'el.classList.add("runtime")');
    const source = '/* old header */@charset "UTF-8";html{color:red}.used,.unused{a:1}.unused{b:2}.runtime{c:3}' +
      '@media (max-width:1px){.unused{d:4}}@media print{.used{e:5}}@keyframes k{0%{opacity:0}}' +
      '.used::-moz-range-thumb,.unused::-moz-range-thumb{f:6}.unused::-moz-focus-inner,.unused2{g:7}';
    const result = trimCss(source, root);
    assert.equal(result.css, HEADER + '@charset "UTF-8";html{color:red}.used{a:1}.runtime{c:3}@media print{.used{e:5}}' +
      '@keyframes k{0%{opacity:0}}.used::-moz-range-thumb,.unused::-moz-range-thumb{f:6}\n');
    assert.deepEqual(result.stats, { rules: 8, removedRules: 3 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
