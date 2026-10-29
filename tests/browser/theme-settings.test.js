'use strict';

// Checks the parts of the theme that show the settings in the real page (wasm/static/css/style.css,
// wasm/platform/launcher.js and the hooks in wasm/platform/index.js): the option rows put the help text across the
// whole row and show the label of a switch only where an option has no help text, so that no label wraps to three lines
// in English or Brazilian Portuguese; each section carries its colour into the header, the bar of its tile, the focused
// row and its switches; the optimal settings dialog shows the values that deriveOptimalSettings() returns as tiles; the
// header shows the stream profile of the settings and follows every change; and chips and badges are at least 16 px.
// The rows are opaque, so that the stars of the backdrop never show between their letters, and rows that scroll out at
// the top of their pane fade out instead of ending in a hard cut. Long dialogs fit the screen in Brazilian Portuguese,
// and a dialog that is too long scrolls only its text, so that its title and buttons stay in view.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

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
const CATEGORIES = ['basicSettings', 'interfaceSettings', 'hostSettings', 'inputSettings', 'audioSettings', 'videoSettings',
  'advancedSettings', 'aboutSettings'];

// The colours [r, g, b] of the pixels of a region of the screen as the page shows it, row by row
async function pixels(page, clip) {
  const png = await page.screenshot({ clip });
  const data = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return Array.from(canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data);
  }, png.toString('base64'));
  const result = [];
  for (let i = 0; i < data.length; i += 4) {
    result.push([data[i], data[i + 1], data[i + 2]]);
  }
  return result;
}

async function openSettings(page, language) {
  if (language) {
    await page.evaluate((locale) => i18n.setLanguage(locale), language);
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => showSettings());
  await page.waitForFunction(() => $('#settings-list').is(':visible') && !$('#wasmSpinner').is(':visible'));
}

// The layout of every shown option row of a settings section: how many lines its title and the label of its switch take,
// whether that label shows, how wide the help text is next to the row, and whether its control stays inside the row
const rowLayout = (page, category) => page.evaluate((name) => {
  handleSettingsView(name);
  const lines = (element) => {
    const style = getComputedStyle(element);
    return Math.round(element.getBoundingClientRect().height / parseFloat(style.lineHeight));
  };
  return Array.prototype.filter.call(document.querySelectorAll('#' + name + ' > .setting-option'), (row) => row.offsetParent !== null)
    .map((row) => {
      const help = row.querySelector(':scope > .mdl-list__item-text-body');
      const switchLabel = row.querySelector('.mdl-switch__label');
      const control = row.querySelector(':scope > div[id]');
      const rowRect = row.getBoundingClientRect();
      const result = {
        title: row.querySelector(':scope > label').textContent.trim().split('\n')[0],
        titleLines: lines(row.querySelector(':scope > label')),
        helpText: help.textContent.trim() !== '',
        controlInside: control.getBoundingClientRect().right <= rowRect.right + 1 &&
          Array.prototype.every.call(control.querySelectorAll('.mdl-button'), (button) => button.scrollWidth <= button.clientWidth + 1),
      };
      if (result.helpText) {
        // The help text runs across the row: its width is the width of the row without its padding
        result.helpAcrossRow = Math.abs(help.getBoundingClientRect().width - (rowRect.width - 56)) < 2;
      }
      if (switchLabel) {
        result.switchLabel = getComputedStyle(switchLabel).display === 'none' ? 'hidden' : 'shown';
        if (result.switchLabel === 'shown') {
          result.switchLabelLines = lines(switchLabel);
        }
      }
      return result;
    });
}, category);

test('the help text runs across each row, a switch label shows only without help text, and no label takes three lines', async () => {
  for (const language of [null, 'pt-BR']) {
    const app = await openApp(harness, { tv: TV });
    try {
      await openSettings(app.page, language);
      for (const category of CATEGORIES) {
        const rows = await rowLayout(app.page, category);
        assert.ok(rows.length > 0, category);
        rows.forEach((row) => {
          const where = (language || 'en-US') + ' ' + category + ' ' + row.title + ': ' + JSON.stringify(row);
          assert.ok(row.titleLines <= 2, where);
          assert.equal(row.controlInside, true, where);
          if (row.helpText) {
            assert.equal(row.helpAcrossRow, true, where);
          }
          if ('switchLabel' in row) {
            // The label repeats the help text, so it shows only in place of a missing one, on one line
            assert.equal(row.switchLabel, row.helpText ? 'hidden' : 'shown', where);
            if (!row.helpText) {
              assert.equal(row.switchLabelLines, 1, where);
            }
          }
        });
      }
      // The rows of the Input Settings without help text: the label of the switch takes its place
      const input = await rowLayout(app.page, 'inputSettings');
      assert.ok(input.filter((row) => row.switchLabel === 'shown').length >= 4, JSON.stringify(input));
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('a badge stays on the line of its title in both languages: the button of the optimal settings wraps instead', async () => {
  for (const language of [null, 'pt-BR']) {
    const app = await openApp(harness, { tv: TV });
    try {
      await openSettings(app.page, language);
      const badges = [];
      for (const category of CATEGORIES) {
        await app.page.evaluate((name) => handleSettingsView(name), category);
        await app.page.waitForTimeout(300);
        badges.push(...await app.page.evaluate((name) => Array.prototype.filter.call(document.querySelectorAll('#' + name + ' .badge'),
          (badge) => badge.offsetParent !== null).map((badge) => {
          const row = badge.closest('.setting-option');
          const lines = badge.parentElement.querySelector('span:not(.badge)').getClientRects();
          const last = lines[lines.length - 1];
          const box = badge.getBoundingClientRect();
          const control = row.querySelector(':scope > div[id]').getBoundingClientRect();
          return {
            badge: badge.textContent.trim(),
            onTitleLine: box.top + box.height / 2 > last.top && box.top + box.height / 2 < last.bottom && box.left >= last.right,
            // The badge ends before the control, and the control inside the row
            clear: box.right + 20 <= control.left && control.right <= row.getBoundingClientRect().right,
          };
        }), category));
      }
      assert.equal(badges.length, 6, JSON.stringify(badges));
      badges.forEach((badge) => assert.deepEqual([badge.onTitleLine, badge.clear], [true, true], (language || 'en-US') + ' ' +
        JSON.stringify(badges)));
      // The button of the optimal settings: one line in English, two in Brazilian Portuguese, inside its row either way
      const button = await app.page.evaluate(() => {
        handleSettingsView('basicSettings');
        const element = document.getElementById('optimalSettingsBtn');
        const span = element.querySelector('span');
        return { lines: Math.round(span.getBoundingClientRect().height / parseFloat(getComputedStyle(span).lineHeight)),
          inside: element.scrollWidth <= element.clientWidth + 1 };
      });
      assert.deepEqual(button, { lines: language ? 2 : 1, inside: true });
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});

test('each settings section carries its colour into the header, its tile, the focused row and its switches', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await openSettings(app.page);
    const look = (category) => app.page.evaluate((name) => {
      handleSettingsView(name);
      return new Promise((resolve) => setTimeout(() => {
        const section = document.getElementById('header-section');
        const row = document.querySelector('#' + name + ' .setting-option.is-current');
        const checked = document.querySelector('#' + name + ' .mdl-switch.is-checked .mdl-switch__track');
        resolve({
          attribute: document.body.getAttribute('data-section'),
          header: [section.textContent, getComputedStyle(section).display, getComputedStyle(section).color],
          tile: getComputedStyle(document.querySelector('.settings-category.selected'), '::before').backgroundColor,
          row: row ? getComputedStyle(row).boxShadow.split(') ')[0] + ')' : null,
          switchTrack: checked ? getComputedStyle(checked).backgroundColor : null,
        });
      }, 400));
    }, category);
    // Video Settings: coral. The HDR switch is on for this TV.
    const coral = 'rgb(255, 90, 110)';
    assert.deepEqual(await look('videoSettings'), { attribute: 'videoSettings', header: ['Video Settings', 'block', coral], tile: coral,
      row: 'rgba(255, 90, 110, 0.85)', switchTrack: coral });
    // Basic Settings: violet. Its frame pacing switch is on.
    const violet = 'rgb(139, 107, 255)';
    assert.deepEqual(await look('basicSettings'), { attribute: 'basicSettings', header: ['Basic Settings', 'block', violet], tile: violet,
      row: 'rgba(139, 107, 255, 0.85)', switchTrack: violet });
    // The name follows a change of the language
    await app.page.evaluate(() => i18n.setLanguage('pt-BR'));
    await app.page.waitForTimeout(400);
    assert.equal(await app.page.evaluate(() => document.getElementById('header-section').textContent), 'Configurações Básicas');
    // Back to the list of the sections: no section in the header
    await app.page.evaluate(() => resetSettingsView());
    assert.deepEqual(await app.page.evaluate(() => [document.body.hasAttribute('data-section'),
      getComputedStyle(document.getElementById('header-section')).display]), [false, 'none']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the switches keep no fades or layers of the framework, only the thumb moves, and the focus paints no box', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await openSettings(app.page);
    await app.page.evaluate(() => handleSettingsView('inputSettings'));
    await app.page.waitForTimeout(400);
    // Every switch of the page and its shown parts: what fades (a transition longer than 0 s) and what keeps a layer
    const motion = await app.page.evaluate(() => {
      const result = [];
      document.querySelectorAll('.mdl-switch').forEach((element) => {
        [element].concat(Array.from(element.querySelectorAll('*'))).forEach((part) => {
          const style = getComputedStyle(part);
          if (style.display === 'none') {
            return;
          }
          const fades = style.transitionDuration.split(', ').some((duration) => parseFloat(duration) > 0);
          result.push((part.className.baseVal === undefined ? part.className : 'svg') + ': ' + (fades ? style.transitionProperty : 'none') +
            ', will-change ' + style.willChange);
        });
      });
      return result;
    });
    assert.ok(motion.length >= 40, JSON.stringify(motion));
    motion.forEach((line) => {
      assert.match(line, /: (none|transform), will-change auto$/, line);
    });
    assert.ok(motion.some((line) => /^mdl-switch__thumb: transform/.test(line)), JSON.stringify(motion));
    // DOWN through the switches of the input settings: the focused switch paints no box of its own, its track shows the ring
    const look = () => app.page.evaluate(() => {
      const element = document.querySelector('#inputSettings .mdl-switch.hovered');
      return element && [element.id, getComputedStyle(element).backgroundColor,
        getComputedStyle(element.querySelector('.mdl-switch__track')).boxShadow.indexOf('rgb(255, 255, 255)') >= 0];
    });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(await look());
      await app.page.keyboard.press('ArrowDown');
      await app.page.waitForTimeout(150);
    }
    assert.deepEqual(seen, ['rumbleFeedbackBtn', 'mouseEmulationBtn', 'flipABfaceButtonsBtn', 'flipXYfaceButtonsBtn'].map((id) =>
      [id, 'rgba(0, 0, 0, 0)', true]));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the optimal settings dialog shows the values of deriveOptimalSettings() as tiles, and other warnings show none', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await openSettings(app.page);
    const dialog = () => app.page.evaluate(() => {
      const shown = (selector) => getComputedStyle(document.querySelector(selector)).display !== 'none';
      return {
        tiles: shown('#warningDialogValues') ? Array.prototype.map.call(document.querySelectorAll('#warningDialogValues .value-tile'),
          (tile) => Array.prototype.map.call(tile.children, (part) => part.textContent)) : [],
        optimalBadge: shown('#warningDialog .badge-optimal'),
        warningBadge: shown('#warningDialog .badge-warning'),
      };
    });
    const close = () => app.page.evaluate(() => document.getElementById('closeWarning').click());
    // The values of this TV (4K panel with HDR on Wi-Fi)
    await app.page.evaluate(() => optimalSettingsDialog());
    const expected = await app.page.evaluate(() => deriveOptimalSettings(tvCapabilities, getActiveConnectionType()));
    assert.deepEqual(expected.resolution + ' ' + expected.frameRate + ' ' + expected.videoCodec, '3840:2160 60 HEVC');
    assert.deepEqual(await dialog(), {
      tiles: [['Video resolution', '4K', '3840 x 2160'], ['Video frame rate', '60', 'FPS'], ['Video bitrate', String(expected.bitrate), 'Mbps'],
        ['Video codec', 'HEVC', 'HDR']],
      optimalBadge: true,
      warningBadge: false,
    });
    await close();
    // The tiles come from what deriveOptimalSettings() returns, not from the text of the dialog
    await app.page.evaluate(() => {
      const derive = deriveOptimalSettings;
      window.deriveOptimalSettings = (caps, connection) => Object.assign(derive(caps, connection),
        { resolution: '1920:1080', bitrate: 42.5, hdrMode: false });
      optimalSettingsDialog();
    });
    assert.deepEqual((await dialog()).tiles, [['Video resolution', '1080p', '1920 x 1080'], ['Video frame rate', '60', 'FPS'],
      ['Video bitrate', '42.5', 'Mbps'], ['Video codec', 'HEVC', 'no HDR']]);
    await close();
    // A plain warning: no tiles, and the warning badge
    await app.page.evaluate(() => warningDialog('Warning', 'Something happened.'));
    assert.deepEqual(await dialog(), { tiles: [], optimalBadge: false, warningBadge: true });
    await close();
    // The Wake-on-LAN warning has two buttons as well, but no tiles either
    await app.page.evaluate(() => wakeOnLanWarningDialog({ hostname: 'PC', macAddress: '02:00:00:00:00:01' }));
    assert.deepEqual(await dialog(), { tiles: [], optimalBadge: false, warningBadge: true });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the header shows the stream profile of the settings, follows every change and hides during a stream', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    const profile = () => app.page.evaluate(() => {
      const chip = document.getElementById('header-profile');
      return [chip.textContent, getComputedStyle(chip).display !== 'none' && $(chip).is(':visible')];
    });
    // The settings of this TV: 4K, 60 FPS, HEVC with HDR, on the hosts screen next to the network chip
    assert.deepEqual(await profile(), ['4K · 60 FPS · HEVC HDR', true]);
    assert.equal(await app.page.evaluate(() => document.getElementById('header-profile').nextElementSibling.id), 'header-status');
    await openSettings(app.page);
    assert.deepEqual(await profile(), ['4K · 60 FPS · HEVC HDR', true]);
    // Every change of the resolution, the frame rate, the codec or HDR shows at once
    await app.page.evaluate(() => $('.videoResolutionMenu li[data-value="1920:1080"]').trigger('click'));
    assert.deepEqual((await profile())[0], '1080p · 60 FPS · HEVC HDR');
    await app.page.evaluate(() => $('.videoFramerateMenu li[data-value="30"]').trigger('click'));
    assert.deepEqual((await profile())[0], '1080p · 30 FPS · HEVC HDR');
    await app.page.evaluate(() => document.querySelector('#hdrModeBtn').MaterialSwitch.off());
    assert.deepEqual((await profile())[0], '1080p · 30 FPS · HEVC');
    await app.page.evaluate(() => {
      document.querySelector('#hdrModeBtn').MaterialSwitch.on();
      $('#av1').trigger('click');
    });
    assert.deepEqual((await profile())[0], '1080p · 30 FPS · AV1 HDR');
    // H.264 has no HDR
    await app.page.evaluate(() => $('#h264').trigger('click'));
    await app.page.waitForTimeout(300);
    assert.deepEqual((await profile())[0], '1080p · 30 FPS · H.264');
    // The optimal settings bring it back
    await app.page.evaluate(() => applyOptimalStreamingSettings(getActiveConnectionType(), true));
    assert.deepEqual((await profile())[0], '4K · 60 FPS · HEVC HDR');
    // It is built again for another language, from the localized names of the codec menu
    await app.page.evaluate(() => i18n.setLanguage('pt-BR'));
    await app.page.waitForTimeout(400);
    assert.deepEqual((await profile())[0], '4K · 60 FPS · HEVC HDR');
    // No chip while a stream plays
    await app.page.evaluate(() => {
      showStreamMode();
      $('#main-header').show();
    });
    assert.deepEqual(await profile(), ['4K · 60 FPS · HEVC HDR', false]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('chips and badges are at least 16 px, and the chip of a host card fits in Brazilian Portuguese', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await app.page.evaluate(() => i18n.setLanguage('pt-BR'));
    await app.page.waitForTimeout(400);
    await app.page.evaluate(() => {
      window.beginBackgroundPollingOfHost = function() {};
      const make = (uid, name, online, paired, currentGame) => ({
        serverUid: uid, hostname: name, online: online, paired: paired, currentGame: currentGame || 0, address: '10.0.0.1',
        externalPort: 47989, httpPort: 47989, httpsPort: 47984, macAddress: '00:11:22:33:44:55', appVersion: '7.1.431.-1',
        gfeVersion: '', serverCodecModeSupport: 0x1F03, toString: () => name, updateExternalAddressIP4() {}, clearBoxArt() {},
        refreshServerInfo: () => Promise.resolve(), pollServer(callback) {
          callback(this);
        },
      });
      [make('A', 'GAMING-PC', true, true, 7), make('BB', 'HTPC', false, true), make('CCC', 'OFFICE', true, false)]
        .forEach((host) => addHostToGrid(host));
      updateAppButton('9.0.0');
    });
    await app.page.keyboard.press('ArrowRight');
    await app.page.waitForTimeout(300);
    const sizes = await app.page.evaluate(() => {
      const size = (element, pseudo) => parseFloat(getComputedStyle(element, pseudo || null).fontSize);
      const chips = Array.prototype.map.call(document.querySelectorAll('.status-chip'), (chip) => size(chip));
      const cards = Array.prototype.map.call(document.querySelectorAll('.host-chips'), (box) => ({
        chips: box.children.length,
        fits: Array.prototype.every.call(box.children, (chip) => chip.getBoundingClientRect().right <= box.getBoundingClientRect().right),
      }));
      return {
        chips: chips.length >= 6 && Math.min.apply(null, chips),
        badges: Math.min.apply(null, Array.prototype.map.call(document.querySelectorAll('.badge'), (badge) => size(badge))),
        updateBadge: size(document.querySelector('.mdl-badge'), '::after'),
        cards,
      };
    });
    assert.ok(sizes.chips >= 16, JSON.stringify(sizes));
    assert.ok(sizes.badges >= 16, JSON.stringify(sizes));
    assert.ok(sizes.updateBadge >= 16, JSON.stringify(sizes));
    // One chip per card (RUNNING, OFFLINE, NÃO PAREADO), which fits
    assert.deepEqual(sizes.cards, [{ chips: 1, fits: true }, { chips: 1, fits: true }, { chips: 1, fits: true }]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the settings rows are opaque, and rows that scroll out at the top of the pane fade out instead of ending in a hard cut', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await openSettings(app.page);
    await app.page.evaluate(() => handleSettingsView('videoSettings'));
    await app.page.waitForTimeout(500);
    const state = () => app.page.evaluate(() => {
      const rows = Array.prototype.filter.call(document.querySelectorAll('#videoSettings > .setting-option'), (row) => row.offsetParent !== null);
      return {
        scrolled: document.getElementById('settings-right-pane').scrollTop,
        // The background colour of every row, the current one included, has no alpha (rgb() instead of rgba())
        opaque: rows.every((row) => /^rgb\(/.test(getComputedStyle(row).backgroundColor)),
        current: rows.filter((row) => row.classList.contains('is-current')).length,
      };
    });
    // Down through every row and back up: the pane scrolls, and every row is opaque
    const seen = [];
    for (const key of Array(9).fill('ArrowDown').concat(Array(9).fill('ArrowUp'))) {
      await app.page.keyboard.press(key);
      await app.page.waitForTimeout(200);
      seen.push(await state());
    }
    assert.ok(Math.max.apply(null, seen.map((step) => step.scrolled)) > 0, JSON.stringify(seen));
    seen.forEach((step) => assert.deepEqual([step.opaque, step.current], [true, 1], JSON.stringify(step)));

    // A row that lies across the top edge of the scrolled pane: its top fades into the backdrop, lower down it is opaque
    const band = await app.page.evaluate(() => {
      const pane = document.getElementById('settings-right-pane');
      // The second shown row, which isn't the current one (the first, after the keys above)
      const row = Array.prototype.filter.call(document.querySelectorAll('#videoSettings > .setting-option'),
        (element) => element.offsetParent !== null)[1];
      pane.scrollTop = 0;
      const top = pane.getBoundingClientRect().top;
      // The row starts 20 px above the top of the pane
      pane.scrollTop = row.getBoundingClientRect().top - top + 20;
      return { x: Math.round(row.getBoundingClientRect().left + 8), y: Math.round(top), mask: getComputedStyle(pane).webkitMaskImage };
    });
    assert.equal(band.mask, 'linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 32px)');
    await app.page.waitForTimeout(100);
    const column = await pixels(app.page, { x: band.x, y: band.y, width: 1, height: 48 });
    const light = (colour) => colour[0] + colour[1] + colour[2];
    // The row is #171B2E: almost the backdrop at the edge, its own colour below the fade
    assert.ok(light(column[1]) + 20 < light(column[44]), JSON.stringify([column[1], column[44]]));
    assert.deepEqual(column[44], [23, 27, 46]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the arrow keys move through every row of a long section without scrolling on their own: the focused row stays in view', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await openSettings(app.page);
    // Whether the browser's own action of each key (scrolling the pane) was prevented, seen after the key handler ran
    await app.page.evaluate(() => {
      window.__prevented = [];
      document.addEventListener('keydown', (event) => window.__prevented.push(event.key + ':' + event.defaultPrevented));
    });
    // Video Settings (6 rows) and About (4 tall rows) need the pane to scroll for their last rows, Basic Settings (5 rows)
    // fits on the screen
    const ROWS = { videoSettings: 6, aboutSettings: 4, basicSettings: 5 };
    for (const section of Object.keys(ROWS)) {
      await app.page.evaluate((name) => handleSettingsView(name), section);
      await app.page.waitForTimeout(400);
      // The current row, and for every shown row whether it lies fully below the fade at the top of the pane (32 px)
      // and above its bottom edge
      const state = () => app.page.evaluate((name) => {
        const pane = document.getElementById('settings-right-pane');
        const view = pane.getBoundingClientRect();
        const rows = Array.prototype.filter.call(document.querySelectorAll('#' + name + ' .setting-option'), (row) => row.offsetParent !== null);
        const current = rows.findIndex((row) => row.classList.contains('is-current'));
        const box = rows[current].getBoundingClientRect();
        return {
          current,
          visible: rows.map((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top >= view.top + 32 - 0.5 && rect.bottom <= view.bottom + 0.5;
          }),
          // The space between the current row and the fade above it, and between the row and the bottom edge
          gaps: [Math.round(box.top - view.top - 32), Math.round(view.bottom - box.bottom)],
          scroll: pane.scrollTop,
        };
      }, section);
      let before = await state();
      const count = before.visible.length;
      assert.equal(count, ROWS[section], section + ': ' + JSON.stringify(before));
      assert.deepEqual([before.current, before.scroll], [0, 0], section);
      // DOWN through every row and on to the first one (the list wraps around), then UP to the last one and back to the
      // first, twice
      const keys = Array(count).fill('ArrowDown').concat(Array(count).fill('ArrowUp'));
      const scrolls = [];
      for (const key of keys.concat(keys)) {
        await app.page.keyboard.press(key);
        await app.page.waitForTimeout(150);
        const after = await state();
        const expected = (before.current + (key === 'ArrowDown' ? 1 : count - 1)) % count;
        const where = section + ' ' + key + ' to row ' + expected + ': ' + JSON.stringify([before, after]);
        assert.equal(after.current, expected, where);
        assert.equal(after.visible[expected], true, where);
        // The pane scrolls only to bring a row into view that wasn't fully in view, so it never drifts, and then only as
        // far as that row needs: it ends right below the fade or at the bottom edge
        if (before.visible[expected]) {
          assert.equal(after.scroll, before.scroll, where);
        } else {
          assert.ok(Math.min(Math.abs(after.gaps[0]), Math.abs(after.gaps[1])) <= 1, where);
        }
        scrolls.push(after.scroll);
        before = after;
      }
      // Both rounds scroll the same way and end at the top; the rows of Basic Settings need no scrolling at all
      assert.deepEqual(scrolls.slice(keys.length), scrolls.slice(0, keys.length), section);
      assert.equal(before.scroll, 0, section);
      assert.equal(Math.max.apply(null, scrolls) > 0, section !== 'basicSettings', section + ': ' + JSON.stringify(scrolls));
    }
    const prevented = await app.page.evaluate(() => window.__prevented);
    assert.equal(prevented.length, 2 * 2 * (6 + 4 + 5), JSON.stringify(prevented));
    assert.ok(prevented.every((entry) => /:true$/.test(entry)), JSON.stringify(prevented));

    // During a stream the arrow keys keep their own action, for the PC
    await app.page.evaluate(() => {
      window.__prevented = [];
      isInGame = true;
    });
    await app.page.keyboard.press('ArrowDown');
    await app.page.evaluate(() => {
      isInGame = false;
    });
    assert.deepEqual(await app.page.evaluate(() => window.__prevented), ['ArrowDown:false']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }

  // In the text field of the Add Host dialog (the address as text instead of four numbers) the arrow keys move the caret
  const dialog = await openApp(harness, { tv: TV, stored: { ipAddressFieldMode: false } });
  try {
    await dialog.page.evaluate(() => {
      addHostDialog();
      window.__prevented = [];
      document.addEventListener('keydown', (event) => window.__prevented.push(event.key + ':' + event.defaultPrevented));
    });
    await dialog.page.waitForTimeout(300);
    // OK on the text field makes it editable
    await dialog.page.keyboard.press('Enter');
    await dialog.page.waitForFunction(() => document.activeElement.id === 'ipAddressTextInput' && !document.activeElement.readOnly);
    await dialog.page.keyboard.type('10.0.0.25');
    await dialog.page.keyboard.press('ArrowLeft');
    await dialog.page.keyboard.press('ArrowLeft');
    assert.deepEqual(await dialog.page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart,
      window.__prevented.filter((entry) => /^Arrow/.test(entry))]), ['ipAddressTextInput', 7, ['ArrowLeft:false', 'ArrowLeft:false']]);
    assert.deepEqual(dialog.errors, []);
  } finally {
    await dialog.context.close();
  }
});

test('long dialogs fit the screen in Brazilian Portuguese on 4K TVs, and a text that is too long scrolls on its own', async () => {
  // The open dialog: whether it or its text scrolls, and whether its title, badge and buttons lie inside it on the screen
  const measure = (page) => page.evaluate(() => {
    const dialog = Array.prototype.find.call(document.querySelectorAll('dialog'), (element) => element.open);
    const box = dialog.getBoundingClientRect();
    const content = dialog.querySelector('.mdl-dialog__content');
    const inside = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= box.top && rect.bottom <= box.bottom && rect.top >= 0 && rect.bottom <= window.innerHeight;
    };
    const badge = Array.prototype.find.call(dialog.querySelectorAll('.dialog-badge'), (element) => element.offsetParent !== null);
    const result = { id: dialog.id, dialogScrolls: dialog.scrollHeight > dialog.clientHeight,
      textScrolls: content.scrollHeight > content.clientHeight, title: inside(dialog.querySelector('.mdl-dialog__title')),
      badge: badge ? inside(badge) : null, buttons: inside(dialog.querySelector('.mdl-dialog__actions')) };
    dialog.close();
    dialog.parentElement.style.display = 'none';
    isDialogOpen = false;
    Navigation.pop();
    return result;
  });
  for (const tv of ['s90c', 'uhd']) {
    const app = await openApp(harness, { tv: { tv, conn: 'ethernet' } });
    try {
      await app.page.evaluate(() => i18n.setLanguage('pt-BR'));
      await app.page.waitForTimeout(400);
      for (const open of ['navigationGuideDialog', 'optimalSettingsDialog', 'appSupportDialog']) {
        await app.page.evaluate((name) => window[name](), open);
        await app.page.waitForTimeout(300);
        const dialog = await measure(app.page);
        const where = tv + ' ' + JSON.stringify(dialog);
        assert.deepEqual([dialog.dialogScrolls, dialog.textScrolls, dialog.title, dialog.buttons], [false, false, true, true], where);
        assert.notEqual(dialog.badge, false, where);
      }
      // A text far too long for the screen: only the text scrolls, the title, the badge and the buttons stay in view
      await app.page.evaluate(() => warningDialog('Warning', Array(40).fill('A line of a long warning.').join('<br>')));
      await app.page.waitForTimeout(300);
      assert.deepEqual(await measure(app.page), { id: 'warningDialog', dialogScrolls: false, textScrolls: true, title: true, badge: true,
        buttons: true });
      assert.deepEqual(app.errors, []);
    } finally {
      await app.context.close();
    }
  }
});
