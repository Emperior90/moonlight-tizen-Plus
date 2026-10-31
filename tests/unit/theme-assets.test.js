'use strict';

// Checks the static parts of the theme of the menus (wasm/static/css/style.css and the icon sprite of
// wasm/index.html) against the limits of the TVs: Tizen 5.5 runs Chromium 69, so the stylesheets use none of the CSS
// that came later (flexbox gap, clamp(), min(), max(), aspect-ratio, backdrop-filter, :is(), :where(), :has(),
// :focus-visible, inset, the individual transform properties, selector lists in :not()), and the weak CPUs of the TVs
// only animate transform and opacity, with no blur filter and no will-change. The icons are SVG symbols of one sprite,
// referenced with xlink:href, so the Material icon fonts (about 900 KB) and their stylesheet are gone and nothing may
// use them again; the sprite holds only symbols that the page or the scripts use. Texts are at least 16 px, the weights
// of the theme lie in the weight range of its Manrope face, the face lists exactly the characters of its font file and
// that file has every character of the UI texts, and the ambient light of the box art needs no canvas. No element asks
// for the ripple effect of MDL, and res/platform.js keeps only what the app uses. tests/browser/theme-ui.test.js,
// theme-hero.test.js and theme-settings.test.js check the rendered page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { readCodePoints } = require('./helpers/woff2');
const { readAppLocales } = require('../tools/i18n-check');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
// The stylesheets of this app (material.min.css is the library of Material Design Lite, only trimmed to the rules the
// app can use by tools/trim-mdl-css.js, see tests/unit/mdl-css.test.js)
const OWN_STYLESHEETS = ['wasm/static/css/style.css', 'wasm/static/css/roboto.css'];
const INDEX_HTML = 'wasm/index.html';

// The CSS of a stylesheet without its comments, and its declarations as { property, value }
function cssWithoutComments(file) {
  return read(file).replace(/\/\*[\s\S]*?\*\//g, '');
}
function declarations(css) {
  const found = [];
  const pattern = /([-a-z]+)\s*:\s*([^;{}]+);/gi;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    found.push({ property: match[1].toLowerCase(), value: match[2].trim() });
  }
  return found;
}

// Every file of a folder, recursively, relative to the repository
function listFiles(dir) {
  return fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).reduce((files, entry) => {
    const file = dir + '/' + entry.name;
    return files.concat(entry.isDirectory() ? listFiles(file) : [file]);
  }, []);
}

test('the stylesheets use only CSS that Chromium 69 supports', () => {
  const forbidden = [
    [/(^|[^-\w])gap\s*:/, 'gap (only grid-gap works in Chromium 69, flexbox gap came in Chromium 84)'],
    [/(^|[^-\w])row-gap\s*:/, 'row-gap'],
    [/(^|[^-\w])(clamp|min|max)\(/, 'clamp(), min() or max()'],
    [/aspect-ratio/, 'aspect-ratio'],
    [/backdrop-filter/, 'backdrop-filter'],
    [/:(is|where|has)\(/, ':is(), :where() or :has()'],
    [/:focus-visible/, ':focus-visible'],
    [/(^|[^-\w])inset\s*:/, 'the inset property'],
    [/(^|[;{\s])(translate|rotate|scale)\s*:/, 'an individual transform property'],
    [/:not\([^)]*,/, 'a selector list inside :not()'],
  ];
  OWN_STYLESHEETS.forEach((file) => {
    const css = cssWithoutComments(file);
    forbidden.forEach(([pattern, name]) => {
      assert.equal(pattern.test(css), false, file + ' uses ' + name);
    });
  });
});

test('the stylesheets animate only transform and opacity, without blur or will-change', () => {
  OWN_STYLESHEETS.forEach((file) => {
    const css = cssWithoutComments(file);
    const decls = declarations(css);
    decls.filter((decl) => decl.property === 'transition' || decl.property === 'transition-property').forEach((decl) => {
      decl.value.split(',').forEach((part) => {
        const property = part.trim().split(/\s+/)[0];
        assert.ok(['transform', 'opacity', 'none'].indexOf(property) >= 0,
          file + ' has a transition of ' + property + ': ' + decl.value);
      });
    });
    // will-change only as 'auto', which turns off the layer that Material Design Lite asks for on its switches
    assert.deepEqual(decls.filter((decl) => decl.property === 'will-change' && decl.value !== 'auto'), [], file + ' uses will-change');
    assert.equal(/filter\s*:[^;]*blur\(/.test(css), false, file + ' uses a blur filter');
    // The keyframes change transform and opacity only
    const keyframes = css.match(/@keyframes\s+[-\w]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) || [];
    keyframes.forEach((block) => {
      declarations(block).forEach((decl) => {
        assert.ok(decl.property === 'transform' || decl.property === 'opacity', file + ' animates ' + decl.property + ': ' + block);
      });
    });
  });
});

test('the only running animations are the loading bars and the icon of a running network scan', () => {
  const css = cssWithoutComments('wasm/static/css/style.css');
  const infinite = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rule.exec(css)) !== null) {
    if (/animation\s*:[^;]*infinite/.test(match[2])) {
      infinite.push(match[1].trim());
    }
  }
  assert.deepEqual(infinite, ['#wasmSpinner > .bar1, .launch-bar::after', '#rescanNetworkBtn.is-scanning .navigation-button-icons']);
  // Both stop for the users who ask for less motion
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /#wasmSpinner > \.bar1, \.launch-bar::after \{\s*animation: none;/);
  assert.match(reduced, /#rescanNetworkBtn\.is-scanning \.navigation-button-icons \{\s*animation: none;/);
});

test('the stream view paints no page backdrop, so that the video plane of the TV shows', () => {
  const css = cssWithoutComments('wasm/static/css/style.css');
  assert.match(css, /body\[data-view="stream"\]::before,\s*body\[style\*="transparent"\]::before \{\s*display: none;/);
  // The Stream Menu lies on the live video without a scrim of its own
  assert.match(css, /\.stream-menu-backdrop \{[^}]*background: transparent;/);
});

test('the icons are symbols of one sprite on a 24 px grid, referenced with xlink:href', () => {
  const html = read(INDEX_HTML);
  const sprites = html.match(/<svg id="icon-sprite"[^>]*>/g) || [];
  assert.equal(sprites.length, 1);
  assert.match(sprites[0], /xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/);
  const symbols = (html.match(/<symbol [^>]*>/g) || []).map((tag) => ({ id: /id="([^"]+)"/.exec(tag)[1], viewBox: /viewBox="([^"]+)"/.exec(tag)[1] }));
  const ids = symbols.map((symbol) => symbol.id);
  assert.ok(ids.length >= 35, 'the sprite has ' + ids.length + ' symbols');
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'duplicate symbols');
  symbols.forEach((symbol) => assert.equal(symbol.viewBox, '0 0 24 24', symbol.id));
  // Every reference in the page and in the scripts uses xlink:href (Chromium 69 also knows href, older SVG code only
  // xlink:href) and names a symbol of the sprite
  const sources = [INDEX_HTML, 'wasm/platform/index.js', 'wasm/platform/launcher.js', 'wasm/platform/menus.js',
    'wasm/platform/button_mapping.js', 'wasm/platform/input_test.js', 'wasm/platform/diagnostics.js'];
  sources.forEach((file) => {
    const text = read(file).replace(/<!--[\s\S]*?-->/g, '');
    const uses = text.match(/<use\b[^>]*>/g) || [];
    uses.forEach((use) => {
      assert.match(use, /\sxlink:href="#i-/, file + ': ' + use);
      assert.doesNotMatch(use, /\shref=/, file + ': ' + use);
      const id = /xlink:href="#(i-[a-z-]+)"/.exec(use);
      if (id) {
        assert.ok(ids.indexOf(id[1]) >= 0, file + ' uses the missing symbol ' + id[1]);
      }
    });
  });
  // The icons the 1.19.101 UI needs: the Rescan network button, the Stream Menu and the app menu
  ['i-refresh', 'i-play', 'i-stats', 'i-mouse', 'i-keyboard', 'i-stop', 'i-power', 'i-quit', 'i-eye', 'i-eye-off', 'i-apps', 'i-close']
    .forEach((id) => assert.ok(ids.indexOf(id) >= 0, 'the sprite has ' + id));
  // Every symbol is used: by a reference in the page or the scripts, or by its name, which the scripts complete with
  // '#i-' (icon() of launcher.js, the host menu of index.js)
  const code = sources.map((file) => read(file).replace(/<symbol [^>]*>/g, '')).join('\n');
  ids.forEach((id) => assert.ok(code.indexOf('#' + id + '"') >= 0 || code.indexOf('\'' + id.slice(2) + '\'') >= 0, id + ' is not used'));
  // Stop is a filled square, so that it doesn't read as an empty checkbox next to the On/Off values of the Stream Menu
  assert.match(html, /<symbol id="i-stop"[^>]*><rect [^>]*fill="currentColor"\/><\/symbol>/);
});

test('no Material icon ligature, icon font or icon stylesheet is left', () => {
  // Ligature icons were <i class="material-icons">name</i> in the page and in the scripts
  const scanned = listFiles('wasm').filter((file) => /\.(html|js|css)$/.test(file) && !/material\.min\.(css|js)$/.test(file) &&
    !/\/(build|node_modules)\//.test(file));
  scanned.forEach((file) => {
    assert.doesNotMatch(read(file), /material-icons|Material Icons|MaterialIcons/, file);
  });
  const files = listFiles('wasm/static');
  assert.deepEqual(files.filter((file) => /MaterialIcons|material-icons\.css/.test(file)), []);
  // The widget gets the whole static folder (apart from the files CMakeLists.txt excludes by name), so a removed file
  // needs no change of the install list
  assert.match(read('CMakeLists.txt'), /install\(DIRECTORY wasm\/static DESTINATION widget(\s+PATTERN "[^"]+" EXCLUDE)*\)/);
  assert.doesNotMatch(read('CMakeLists.txt'), /MaterialIcons|material-icons/);
});

test('Manrope is the font of the UI, with Roboto as its fallback, and its licence ships with it', () => {
  const css = cssWithoutComments('wasm/static/css/style.css');
  assert.match(css, /--font: 'Manrope', 'Roboto', /);
  assert.match(css, /src: url\(\.\.\/fonts\/Manrope-latin-wght\.woff2\) format\('woff2'\);/);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'wasm/static/fonts/Manrope-latin-wght.woff2')));
  assert.match(read('wasm/static/fonts/Manrope-OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(read(INDEX_HTML), /<link rel="stylesheet" href="static\/css\/roboto\.css">/);
});

test('the Manrope face lists exactly the characters of its font file, and that file has every character of the UI texts', () => {
  const css = read('wasm/static/css/style.css');
  const face = /@font-face \{[^}]*font-family: 'Manrope';[^}]*\}/.exec(css)[0];
  const range = new Set();
  /unicode-range: ([^;]+);/.exec(face)[1].split(',').forEach((part) => {
    const bounds = part.trim().replace(/^U\+/, '').split('-').map((hex) => parseInt(hex, 16));
    for (let c = bounds[0]; c <= (bounds.length > 1 ? bounds[1] : bounds[0]); c++) {
      range.add(c);
    }
  });
  const font = readCodePoints(path.join(REPO_ROOT, 'wasm/static/fonts/Manrope-latin-wght.woff2'));
  // The control characters belong to the range (as in roboto.css) without glyphs; every other character of the range is in
  // the font, and every character of the font in the range, so that the rest falls back to Roboto
  const hex = (c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0');
  assert.deepEqual(Array.from(range).filter((c) => c >= 0x20 && !font.has(c)).map(hex), []);
  assert.deepEqual(Array.from(font).filter((c) => c >= 0x20 && !range.has(c)).map(hex), []);
  // The texts of the page and of every language
  const texts = [read(INDEX_HTML).replace(/<[^>]*>/g, ' ')];
  const locales = fs.readdirSync(path.join(REPO_ROOT, 'wasm/static/locales')).filter((name) => name.endsWith('.json'));
  assert.ok(locales.length >= 3, locales.join(' '));
  locales.forEach((name) => {
    const messages = JSON.parse(read('wasm/static/locales/' + name));
    Object.keys(messages).forEach((key) => texts.push(messages[key].replace(/<[^>]*>/g, ' ')));
  });
  // and the names of the languages in the language menu
  readAppLocales(read('wasm/platform/i18n.js')).forEach((locale) => texts.push(locale.name));
  const missing = new Set();
  texts.join(' ').replace(/&[a-z]+;|&#\d+;/g, ' ').split('').forEach((character) => {
    const c = character.codePointAt(0);
    if (c >= 0x20 && !font.has(c)) {
      missing.add(character + ' ' + hex(c));
    }
  });
  assert.deepEqual(Array.from(missing), []);
});

test('texts are at least 16 px, and every weight of the theme lies in the weight range of the Manrope face', () => {
  const css = cssWithoutComments('wasm/static/css/style.css');
  const decls = declarations(css);
  // 0 hides the dash of the help texts (::first-letter) and the space between chips
  const sizes = decls.filter((decl) => decl.property === 'font-size' && decl.value !== '0').map((decl) => decl.value);
  sizes.forEach((size) => assert.match(size, /^\d+(px|rem)$/, size));
  // 1rem is 16 px, the default size of the page
  const pixels = sizes.map((size) => parseFloat(size) * (/rem$/.test(size) ? 16 : 1));
  assert.ok(Math.min.apply(null, pixels) >= 16, sizes.join(' '));
  const face = /@font-face \{[^}]*font-family: 'Manrope';[^}]*font-weight: (\d+) (\d+);/.exec(css);
  assert.ok(face, 'the Manrope face names its weight range');
  const weights = decls.filter((decl) => decl.property === 'font-weight' && /^\d+$/.test(decl.value)).map((decl) => Number(decl.value));
  weights.forEach((weight) => assert.ok(weight >= Number(face[1]) && weight <= Number(face[2]), 'font-weight ' + weight));
});

test('the ambient light of the box art is drawn with CSS gradients, without a canvas in the page', () => {
  assert.doesNotMatch(read(INDEX_HTML), /<canvas/);
  const css = cssWithoutComments('wasm/static/css/style.css');
  assert.doesNotMatch(css, /canvas/);
  // The glows take the colours that launcher.js sets
  ['--a1', '--a2', '--a3'].forEach((name) => assert.match(css, new RegExp('radial-gradient\\([^;]*rgba\\(var\\(' + name + '\\)')));
});

test('no element asks for the MDL ripple effect, which the theme never shows, and the focus circle of the switches stays hidden', () => {
  const sources = [INDEX_HTML, 'wasm/platform/index.js', 'wasm/platform/menus.js', 'wasm/platform/launcher.js', 'wasm/platform/navigation.js'];
  sources.forEach((file) => assert.equal(read(file).indexOf('mdl-js-ripple-effect'), -1, file));
  // Without the class MDL builds no ripple container, so the stylesheet needs no rule to hide one; the grey circle that
  // MDL draws around the thumb of a focused switch stays hidden
  const css = cssWithoutComments('wasm/static/css/style.css');
  assert.equal(/ripple/.test(css), false);
  assert.match(css, /\.mdl-switch__focus-helper\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

test('res/platform.js keeps the key codes, platformOnLoad() and the copyright line of Samsung, without the unused list of key names', () => {
  const platform = read('res/platform.js');
  assert.equal(platform.split('\n')[0], '// Copyright (c) 2015 Samsung Electronics. All rights reserved.');
  assert.equal(platform.indexOf('buttonsNames'), -1);
  assert.equal(platform.indexOf('Sample usage'), -1);
  assert.match(platform, /function platformOnLoad\(handler\)/);
  assert.match(platform, /KEY_PLAY_PAUSE: 10252,/);
});
