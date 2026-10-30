'use strict';

// The stress pass of the layout tests of the languages. Text metrics differ between machines and on the TV: the headless
// shell of Chromium hints glyphs fully unless it is started with --font-render-hinting=none (which some preinstalled
// browsers do), so that each glyph of Manrope is fitted to the pixel grid and a line runs about 4 % wider than without
// hinting, and the TV draws text with its own renderer. A layout that fits by a few pixels on one machine breaks on
// another. widenText() makes every text of the page about 10 % wider with letter spacing on top of the letter spacing
// of the stylesheets, and the tests require the same fit with it; restoreText() takes it away again. On top of the
// hinting of CI that is about 14 % wider than without hinting, which leaves room for the renderer of the TV.

// The added letter spacing in em: an average glyph of Manrope at weight 600 to 800 is about 0.55 em wide, so 0.056 em
// widens a line by about 10.5 %, also with the glyphs hinted. widenText() checks it on a sample of the longest texts of
// the app.
const EXTRA_SPACING_EM = 0.056;
// How much wider text gets at least
const TEXT_STRESS = 1.10;
const STYLE_ID = 'test-text-stress';

// Add the letter spacing in the page: every element gets its own letter spacing (or the one it inherits, carried in
// --stress-base) plus EXTRA_SPACING_EM of its own font size. Form controls start from 0, as the user agent resets them.
function installTextStress({ id, extraEm }) {
  if (document.getElementById(id)) {
    return;
  }
  const length = (value) => (value === 'normal' || /^-?0$/.test(value) ? '0px' : value);
  const rules = ['button, input, select, textarea { --stress-base: 0px; }'];
  const collect = (list, out) => {
    Array.prototype.forEach.call(list, (rule) => {
      if (rule.media && rule.cssRules) {
        const inner = [];
        collect(rule.cssRules, inner);
        if (inner.length) {
          out.push('@media ' + rule.media.mediaText + ' { ' + inner.join(' ') + ' }');
        }
      } else if (rule.selectorText && rule.style) {
        const value = rule.style.getPropertyValue('letter-spacing');
        if (value) {
          const priority = rule.style.getPropertyPriority('letter-spacing') ? ' !important' : '';
          out.push(rule.selectorText + ' { --stress-base: ' + length(value) + priority + '; }');
        }
      }
    });
  };
  Array.prototype.forEach.call(document.styleSheets, (sheet) => {
    if (sheet.ownerNode && sheet.ownerNode.id === id) {
      return;
    }
    collect(sheet.cssRules, rules);
  });
  rules.push('*, *::before, *::after { letter-spacing: calc(var(--stress-base, 0px) + ' + extraEm + 'em) !important; }');
  const style = document.createElement('style');
  style.id = id;
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
}

// How much wider the stress makes a sample of long texts of the app, in Manrope at the weights of the UI
function measureStress({ id, extraEm }) {
  const samples = ['Déconnecter et quitter l’application du PC', 'Sprache und Eingabe der PC-Adresse',
    'Optimale Streaming-Einstellungen für diesen TV übernehmen', 'Configurações ideais para esta TV',
    'Disconnect and quit the app on the PC', 'Sound output and synchronization'];
  const span = document.createElement('span');
  span.style.cssText = 'position: absolute; left: -9999px; top: 0; white-space: nowrap; font-family: var(--font); font-size: 20px;';
  document.body.appendChild(span);
  let widening = Infinity;
  [600, 700, 800].forEach((weight) => {
    span.style.fontWeight = String(weight);
    samples.forEach((text) => {
      span.textContent = text;
      // Inline and important, so that the stress itself doesn't apply to the sample
      span.style.setProperty('letter-spacing', '0px', 'important');
      const plain = span.getBoundingClientRect().width;
      span.style.setProperty('letter-spacing', extraEm + 'em', 'important');
      widening = Math.min(widening, span.getBoundingClientRect().width / plain);
    });
  });
  span.remove();
  return { widening, installed: !!document.getElementById(id) };
}

// Make every text of the page about 10 % wider until restoreText(). Returns the smallest widening of the sample texts.
async function widenText(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(installTextStress, { id: STYLE_ID, extraEm: EXTRA_SPACING_EM });
  const result = await page.evaluate(measureStress, { id: STYLE_ID, extraEm: EXTRA_SPACING_EM });
  if (!result.installed || !(result.widening >= TEXT_STRESS)) {
    throw new Error('The text stress widens text by only ' + JSON.stringify(result));
  }
  return result.widening;
}

// Take the extra letter spacing of widenText() away again
function restoreText(page) {
  return page.evaluate((id) => {
    const style = document.getElementById(id);
    if (style) {
      style.remove();
    }
  }, STYLE_ID);
}

// The passes of a layout test: the text as it is, and the text about 10 % wider. `run(label)` does the checks of a pass;
// label is '' or ' (text 10 % wider)' for the messages of the assertions.
async function forEachTextWidth(page, run) {
  await run('');
  await widenText(page);
  try {
    await run(' (text ' + Math.round((TEXT_STRESS - 1) * 100) + ' % wider)');
  } finally {
    await restoreText(page);
  }
}

module.exports = {
  EXTRA_SPACING_EM,
  TEXT_STRESS,
  forEachTextWidth,
  restoreText,
  widenText,
};
