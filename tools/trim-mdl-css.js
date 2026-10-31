'use strict';

// Trims wasm/static/css/material.min.css (Material Design Lite 1.3.0) to the rules that an element of this app can
// match. About 60 % of the library are parts the app never uses: the colour palettes (mdl-color--*), the grid, the
// footers, the typography classes, and components such as cards, chips, tabs, spinners, radios and data tables. Every
// style recalculation on the TV had to test their selectors, and the file is read at every start.
//
// A rule stays when one of its selectors only needs classes and ids that appear somewhere in the app: in
// wasm/index.html, the scripts of wasm/platform, wasm/static/js/utils.js and wasm/static/js/mdns-browser, or anywhere in
// wasm/static/js/material.min.js, which adds classes at runtime (for every component, used or not, so this test keeps
// more than needed rather than less). Classes inside :not(...), attribute selectors and pseudo-classes need nothing.
// Element-only rules, @keyframes and @font-face always stay, an @media block stays with the rules it still has, and a
// selector list with a vendor-prefixed pseudo-class or pseudo-element (e.g. ::-moz-range-thumb) is kept or removed as a
// whole, since a browser drops a whole list that has a selector it doesn't know. Nothing else of a rule changes.
//
// Usage: node tools/trim-mdl-css.js [<untrimmed material.min.css>] [<output file>]
// Both default to wasm/static/css/material.min.css, so running it again after a change of the app only removes the
// rules that became unused. To bring back a part of MDL that was removed, run it on the untrimmed file of the release,
// e.g. https://code.getmdl.io/1.3.0/material.min.css or material.min.css of the npm package material-design-lite@1.3.0,
// after adding the element that uses it. The licence header of MDL (Apache-2.0) is written at the top, with a note
// that the file was changed.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(REPO_ROOT, 'wasm', 'static', 'css', 'material.min.css');

const HEADER =
  '/**\n' +
  ' * material-design-lite - Material Design Components in CSS, JS and HTML\n' +
  ' * @version v1.3.0\n' +
  ' * @license Apache-2.0\n' +
  ' * @copyright 2015 Google, Inc.\n' +
  ' * @link https://github.com/google/material-design-lite\n' +
  ' *\n' +
  ' * Changed for Moonlight Plus: tools/trim-mdl-css.js removed the rules and the selectors that no element of the app\n' +
  ' * can match (colour palettes, grid, footers, typography and the components the app does not use). Everything else\n' +
  ' * is as released.\n' +
  ' */\n';

// The sources whose words count as the classes and ids that the app uses
function appSources(repoRoot) {
  const files = [path.join(repoRoot, 'wasm', 'index.html'), path.join(repoRoot, 'wasm', 'static', 'js', 'utils.js')];
  [path.join(repoRoot, 'wasm', 'platform'), path.join(repoRoot, 'wasm', 'static', 'js', 'mdns-browser')].forEach((dir) => {
    fs.readdirSync(dir).filter((name) => /\.js$/.test(name)).sort().forEach((name) => files.push(path.join(dir, name)));
  });
  files.push(path.join(repoRoot, 'wasm', 'static', 'js', 'material.min.js'));
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

function usedWords(repoRoot) {
  return new Set(appSources(repoRoot).match(/[A-Za-z0-9_-]+/g));
}

// Split at the commas of the top level (not inside parentheses or brackets)
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

// The classes and ids a selector needs, leaving out attribute selectors and pseudo-classes with their arguments
function neededNames(selector) {
  let s = selector.replace(/\[[^\]]*\]/g, '');
  // Pseudo-classes and pseudo-elements, with nested parentheses such as :not(.a)
  let previous;
  do {
    previous = s;
    s = s.replace(/::?[A-Za-z-]+\([^()]*\)/g, '');
  } while (s !== previous);
  s = s.replace(/::?[A-Za-z-]+/g, '');
  const names = [];
  s.replace(/[.#]([A-Za-z0-9_-]+)/g, (all, name) => names.push(name));
  return names;
}

function hasVendorPseudo(selector) {
  return /::?-(webkit|moz|ms|o)-/.test(selector);
}

// Parse a block of CSS into [{ prelude, body }] at the top level of the block
function parseBlock(block) {
  const rules = [];
  let i = 0;
  while (i < block.length) {
    const open = block.indexOf('{', i);
    if (open < 0) {
      const rest = block.slice(i).trim();
      if (rest) {
        rules.push({ prelude: rest, body: null });
      }
      break;
    }
    // A statement without a block, e.g. @charset "UTF-8";
    const semicolon = block.indexOf(';', i);
    if (semicolon >= 0 && semicolon < open && /^\s*@/.test(block.slice(i, semicolon))) {
      rules.push({ prelude: block.slice(i, semicolon + 1).trim(), body: null });
      i = semicolon + 1;
      continue;
    }
    let depth = 1;
    let k = open + 1;
    while (k < block.length && depth) {
      if (block[k] === '{') {
        depth++;
      } else if (block[k] === '}') {
        depth--;
      }
      k++;
    }
    rules.push({ prelude: block.slice(i, open).trim(), body: block.slice(open + 1, k - 1) });
    i = k;
  }
  return rules;
}

function trimBlock(block, used, stats) {
  const out = [];
  parseBlock(block).forEach((rule) => {
    if (rule.body === null) {
      out.push(rule.prelude);
    } else if (/^@(media|supports)/.test(rule.prelude)) {
      const inner = trimBlock(rule.body, used, stats);
      if (inner) {
        out.push(rule.prelude + '{' + inner + '}');
      }
    } else if (/^@/.test(rule.prelude)) {
      out.push(rule.prelude + '{' + rule.body + '}');
    } else {
      const selectors = splitTopLevel(rule.prelude);
      const alive = selectors.filter((selector) => neededNames(selector).every((name) => used.has(name)));
      stats.rules++;
      if (!alive.length) {
        stats.removedRules++;
      } else if (alive.length === selectors.length || selectors.some(hasVendorPseudo)) {
        out.push(rule.prelude + '{' + rule.body + '}');
      } else {
        out.push(alive.join(',') + '{' + rule.body + '}');
      }
    }
  });
  return out.join('');
}

// Return the trimmed stylesheet (with the header) and counts of the rules
function trimCss(css, repoRoot) {
  const stats = { rules: 0, removedRules: 0 };
  const body = trimBlock(css.replace(/\/\*[\s\S]*?\*\//g, '').trim(), usedWords(repoRoot || REPO_ROOT), stats);
  return { css: HEADER + body + '\n', stats };
}

module.exports = { trimCss, neededNames, splitTopLevel, HEADER };

if (require.main === module) {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE;
  const output = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_FILE;
  const source = fs.readFileSync(input, 'utf8');
  const result = trimCss(source);
  fs.writeFileSync(output, result.css);
  console.log(`[trim-mdl-css] ${input} (${Buffer.byteLength(source)} B) -> ${output} (${Buffer.byteLength(result.css)} B): ` +
    `${result.stats.removedRules} of ${result.stats.rules} rules removed`);
}
