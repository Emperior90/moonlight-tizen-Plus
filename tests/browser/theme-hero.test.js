'use strict';

// Checks the hero of the hosts and apps screens and the start screen of a stream in the real page
// (wasm/platform/launcher.js and wasm/static/css/style.css): the hero keeps the last focused host or app while the focus
// is in the header, a dialog or a menu, shows a summary of the hosts when no card has the focus and never falls back to
// the empty state "Find your gaming PC" while hosts exist; box art shows uncropped, as a 3:4 poster for portrait covers
// (600 x 800, 600 x 900) and as a banner only for landscape art, in the hero and on the start screen; the ambient light
// is made of averaged colours of the art drawn as radial glows (no stretched canvas); and the rows that scroll under the
// hero fade out instead of ending in a hard cut. The hero follows the focus only (mark() of navigation.js), never a real
// mouse pointer; it offers UP for the options of a host only where UP reaches them; the ambient light changes only once
// the focus rests and covers the right part of the screen only; the tiles keep the top of portrait covers and ring the
// focused card with a dark gap, so that the ring shows on light box art; and the tooltips of the header buttons lie above
// the PC illustration.

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

// Add four simulated hosts in four states (a game running, offline, not paired, online), without polling
const installHosts = (page) => page.evaluate(() => {
  window.beginBackgroundPollingOfHost = function() {};
  window.endBackgroundPollingOfHost = function() {};
  const make = (uid, name, online, paired, currentGame) => ({
    serverUid: uid, hostname: name, online: online, paired: paired, currentGame: currentGame || 0, address: '10.0.0.' + uid.length,
    externalPort: 47989, httpPort: 47989, httpsPort: 47984, macAddress: '00:11:22:33:44:55', appVersion: '7.1.431.-1', gfeVersion: '',
    serverCodecModeSupport: 0x1F03, toString: () => name, updateExternalAddressIP4() {}, clearBoxArt() {},
    refreshServerInfo: () => Promise.resolve(), pollServer(callback) {
      callback(this);
    },
  });
  window.__hosts = [make('A', 'GAMING-PC', true, true, 7), make('BB', 'HTPC', false, true), make('CCC', 'OFFICE', true, false),
    make('DDDD', 'STUDIO', true, true)];
  window.__hosts.forEach((host) => addHostToGrid(host));
});

// What the hero shows
const hero = (page) => page.evaluate(() => {
  const element = document.getElementById('launcher-hero');
  return {
    kind: element.getAttribute('data-kind'),
    state: element.getAttribute('data-state'),
    title: document.getElementById('hero-title').textContent,
    chips: Array.prototype.map.call(document.querySelectorAll('#hero-chips .status-chip'), (chip) => chip.textContent),
    hints: getComputedStyle(document.getElementById('hero-hints')).visibility,
  };
});

// A box art cover of the given size as an SVG data URL: two halves in two colours, with a logo bar at the top
const cover = (width, height, top, bottom) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
  '<rect width="' + width + '" height="' + (height / 2) + '" fill="' + top + '"/>' +
  '<rect y="' + (height / 2) + '" width="' + width + '" height="' + (height / 2) + '" fill="' + bottom + '"/></svg>');

const APPS = [
  { id: 21, title: 'A Steam Cover', art: cover(600, 900, '#ff0000', '#0000ff') },
  { id: 22, title: 'B Sunshine Cover', art: cover(600, 800, '#ffd400', '#111111') },
  { id: 23, title: 'C Landscape Banner', art: cover(920, 430, '#00ff00', '#ff00ff') },
];

// Open the app grid of a simulated host with box art (APPS or the given apps); `extra` more apps without art fill further
// rows
async function openAppList(extra, apps) {
  const app = await openApp(harness, { tv: TV });
  await app.page.evaluate(async ({ apps, more }) => {
    window.__apps = apps.concat(Array.from({ length: more }, (unused, index) => ({ id: 100 + index, title: 'Z Game ' + (index + 10) })));
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 0,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppList: () => Promise.resolve(window.__apps.map((entry) => ({ id: entry.id, title: entry.title }))),
      getAppById: (id) => Promise.resolve(window.__apps.find((entry) => entry.id == id) || null),
      getBoxArt: (id) => {
        const entry = window.__apps.find((item) => item.id == id);
        return entry && entry.art ? Promise.resolve(entry.art) : Promise.reject(new Error('no box art'));
      },
      // The app polls the host of the app grid every 5 seconds once its box art loaded (showApps() in index.js)
      pollServer: (callback) => callback(host),
      toString: () => 'GAMING-PC',
    };
    window.__host = host;
    api = host;
    await showApps(host);
    Navigation.switch();
    Navigation.change(Views.Apps);
  }, { apps: apps || APPS, more: extra || 0 });
  await app.page.waitForFunction((count) => $('#game-grid').is(':visible') && !$('#wasmSpinner').is(':visible') &&
    document.querySelectorAll('#game-grid .game-container img.fade-in').length >= count, (apps || APPS).length, { timeout: 5000 });
  return app;
}

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
const isWhite = (colour) => colour.every((value) => value > 235);
const isDark = (colour) => colour.every((value) => value < 60);

// The centre of an element on the screen
const centreOf = (page, selector) => page.evaluate((query) => {
  const rect = document.querySelector(query).getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}, selector);

// Press a key of the remote and give the navigation time to handle it
const press = async (page, key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(250);
};

// Move the focus to the app card with the given title
const focusApp = (page, title) => page.evaluate((name) => {
  const cards = Array.from(Views.Apps.view.func());
  const index = cards.findIndex((card) => card.getAttribute('aria-label') === name);
  unmark(Views.Apps.view.current());
  Views.Apps.view.index = index;
  mark(cards[index]);
}, title);

test('the hero keeps the last host while the focus is elsewhere, and never shows the empty state while hosts exist', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    // No host yet: the empty state, with the Add Host card focused
    assert.equal((await hero(app.page)).title, 'Find your gaming PC');
    await installHosts(app.page);
    // The Add Host card still has the focus: it names itself, no longer the empty state
    assert.deepEqual(await hero(app.page), { kind: 'host', state: 'add', title: 'Add PC', chips: [], hints: 'visible' });
    // The focus moves to the header before any host had it: a summary of the hosts
    await press(app.page, 'ArrowUp');
    assert.equal(await app.page.evaluate(() => document.querySelector('#main-header .hovered').id), 'rescanNetworkBtn');
    assert.deepEqual(await hero(app.page), { kind: 'host', state: 'running', title: 'Your gaming PCs', chips: ['3 ONLINE', '1 OFFLINE'],
      hints: 'hidden' });
    // A host gets the focus, then its options button and the header: the hero keeps the host, in the header without its
    // key hints
    await press(app.page, 'ArrowDown');
    await press(app.page, 'ArrowRight');
    // One chip, the one of its card (running means online and paired as well)
    const gamingPc = { kind: 'host', state: 'running', title: 'GAMING-PC', chips: ['Running'], hints: 'visible' };
    assert.deepEqual(await hero(app.page), gamingPc);
    await press(app.page, 'ArrowUp');
    assert.equal(await app.page.evaluate(() => document.querySelector('#host-container-A .host-menu.hovered') !== null), true);
    assert.deepEqual(await hero(app.page), gamingPc);
    await press(app.page, 'ArrowUp');
    assert.equal(await app.page.evaluate(() => document.querySelector('#main-header .hovered') !== null), true);
    assert.deepEqual(await hero(app.page), Object.assign({}, gamingPc, { hints: 'hidden' }));
    // The host menu, a warning and a new status of another host keep it too
    await app.page.evaluate(() => hostMenuDialog(window.__hosts[0]));
    await app.page.waitForTimeout(150);
    assert.equal((await hero(app.page)).title, 'GAMING-PC');
    await app.page.evaluate(() => {
      document.querySelector('#closeHostMenu').click();
      warningDialog('Warning', 'A warning');
    });
    await app.page.waitForTimeout(150);
    assert.equal((await hero(app.page)).title, 'GAMING-PC');
    await app.page.evaluate(() => {
      document.getElementById('closeWarning').click();
      window.__hosts[3].online = false;
      updateHostStatusIndicator(window.__hosts[3]);
    });
    assert.equal((await hero(app.page)).title, 'GAMING-PC');
    // Its card goes: the summary of the other hosts
    await app.page.evaluate(() => {
      $('#host-container-A').remove();
      delete hosts.A;
    });
    await app.page.waitForTimeout(50);
    assert.deepEqual(await hero(app.page), { kind: 'host', state: 'online', title: 'Your gaming PCs', chips: ['1 ONLINE', '2 OFFLINE'],
      hints: 'hidden' });
    // Only without any host does the empty state come back
    await app.page.evaluate(() => {
      Object.keys(hosts).forEach((uid) => {
        $('#host-container-' + uid).remove();
        delete hosts[uid];
      });
    });
    await app.page.waitForTimeout(50);
    assert.equal((await hero(app.page)).title, 'Find your gaming PC');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the hero of the apps screen keeps the last app while the focus is in the header', async () => {
  const app = await openAppList();
  try {
    await focusApp(app.page, 'B Sunshine Cover');
    assert.deepEqual(await hero(app.page), { kind: 'app', state: 'idle', title: 'B Sunshine Cover', chips: [], hints: 'visible' });
    await press(app.page, 'ArrowUp');
    assert.equal(await app.page.evaluate(() => document.querySelector('#main-header .hovered') !== null), true);
    assert.deepEqual(await hero(app.page), { kind: 'app', state: 'idle', title: 'B Sunshine Cover', chips: [], hints: 'hidden' });
    // The app menu keeps it as well
    await press(app.page, 'ArrowDown');
    await app.page.evaluate(() => openAppMenu(Views.Apps.view.current()));
    assert.equal((await hero(app.page)).title, 'B Sunshine Cover');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('box art shows uncropped: portrait covers as a poster and landscape art as a banner, in the hero and on the start screen', async () => {
  const app = await openAppList();
  try {
    const look = (title) => focusApp(app.page, title).then(() => app.page.evaluate(() => {
      const poster = document.getElementById('hero-poster');
      const rect = poster.getBoundingClientRect();
      return {
        wide: document.getElementById('launcher-hero').classList.contains('art-wide'),
        height: Math.round(rect.height),
        // The shown ratio equals the ratio of the art: nothing is cut off
        ratio: Math.round(rect.width / rect.height * 100) / 100,
        art: Math.round(poster.naturalWidth / poster.naturalHeight * 100) / 100,
        fit: getComputedStyle(poster).objectFit,
        mask: getComputedStyle(poster).webkitMaskImage !== 'none',
      };
    }));
    assert.deepEqual(await look('A Steam Cover'), { wide: false, height: 372, ratio: 0.67, art: 0.67, fit: 'cover', mask: false });
    assert.deepEqual(await look('B Sunshine Cover'), { wide: false, height: 372, ratio: 0.75, art: 0.75, fit: 'cover', mask: false });
    assert.deepEqual(await look('C Landscape Banner'), { wide: true, height: 372, ratio: 2.14, art: 2.14, fit: 'cover', mask: true });

    // The start screen: the poster on the left, the overline, title and host on the right with the bar and the message
    const start = (id, title) => app.page.evaluate(({ appId, name }) => {
      $('#loadingSpinnerMessage').text(t('Starting %1$s...', name));
      Launcher.prepareStart(window.__host, appId, name);
      showStreamMode();
      const poster = document.getElementById('launch-poster');
      const rect = poster.getBoundingClientRect();
      const box = (element) => element.getBoundingClientRect();
      const bar = box(document.querySelector('.launch-bar'));
      const message = box(document.getElementById('loadingSpinnerMessage'));
      const info = box(document.querySelector('.launch-info'));
      const result = {
        source: poster.getAttribute('src') === ($('#game-container-' + appId + ' img').attr('src') || 'static/res/placeholder_game.svg'),
        wide: poster.classList.contains('is-wide'),
        ratio: Math.round(rect.width / rect.height * 100) / 100,
        art: Math.round(poster.naturalWidth / poster.naturalHeight * 100) / 100,
        overline: document.querySelector('.launch-overline').textContent,
        overlineShownAs: getComputedStyle(document.querySelector('.launch-overline')).textTransform,
        title: document.getElementById('launch-title').textContent,
        host: document.getElementById('launch-host').textContent,
        textRightOfPoster: info.left >= rect.right && bar.left >= rect.right && message.left >= rect.right,
        barBelowText: bar.top >= info.bottom && message.top >= bar.bottom,
        aligned: bar.left === info.left && message.left === info.left,
        // The poster and the column of text, bar and message are centred together on the screen
        centred: Math.abs((rect.left + Math.max(info.right, bar.right, message.right)) / 2 - window.innerWidth / 2) <= 1,
        canvases: document.querySelectorAll('canvas').length,
      };
      document.getElementById('loadingSpinner').style.display = 'none';
      return result;
    }, { appId: id, name: title });
    const common = { source: true, overline: 'Starting', overlineShownAs: 'uppercase', host: 'GAMING-PC', textRightOfPoster: true,
      barBelowText: true, aligned: true, centred: true, canvases: 0 };
    assert.deepEqual(await start(21, 'A Steam Cover'), Object.assign({ wide: false, ratio: 0.67, art: 0.67, title: 'A Steam Cover' }, common));
    assert.deepEqual(await start(23, 'C Landscape Banner'), Object.assign({ wide: true, ratio: 2.14, art: 2.14, title: 'C Landscape Banner' },
      common));
    // A title too long for one line takes two, in the widest column
    const long = 'B Sunshine Cover, the Game of the Year Edition with Every Expansion';
    assert.deepEqual(await start(22, long), Object.assign({ wide: false, ratio: 0.75, art: 0.75, title: long }, common));
    assert.deepEqual(await app.page.evaluate(() => {
      document.getElementById('loadingSpinner').style.display = 'inline-block';
      const title = document.getElementById('launch-title');
      const result = [Math.round(title.getBoundingClientRect().width), Math.round(title.getBoundingClientRect().height /
        parseFloat(getComputedStyle(title).lineHeight))];
      document.getElementById('loadingSpinner').style.display = 'none';
      return result;
    }), [720, 2]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the ambient light is made of averaged colours of the box art, drawn as radial glows', async () => {
  const app = await openAppList();
  try {
    const ambient = (id) => app.page.evaluate((elementId) => {
      const element = document.getElementById(elementId);
      const style = getComputedStyle(element);
      const colour = (name) => element.style.getPropertyValue(name).split(',').map((value) => parseInt(value, 10));
      return {
        painted: element.classList.contains('is-painted'),
        opacity: style.opacity,
        glows: (style.backgroundImage.match(/radial-gradient/g) || []).length,
        top: colour('--a1'),
        bottom: colour('--a3'),
      };
    }, id);
    // The cover is red above and blue below. The light shows once the focus rested and the light faded in.
    await focusApp(app.page, 'A Steam Cover');
    await app.page.waitForFunction(() => getComputedStyle(document.getElementById('hero-ambient')).opacity === '1', null, { timeout: 3000 });
    const lit = await ambient('hero-ambient');
    assert.deepEqual([lit.painted, lit.opacity, lit.glows], [true, '1', 3]);
    assert.ok(lit.top[0] > 200 && lit.top[2] < 60, JSON.stringify(lit.top));
    assert.ok(lit.bottom[2] > 200 && lit.bottom[0] < 60, JSON.stringify(lit.bottom));
    await app.page.evaluate(() => Launcher.prepareStart(window.__host, 21, 'A Steam Cover'));
    const start = await ambient('launch-backdrop');
    assert.deepEqual([start.painted, start.glows, start.top, start.bottom], [true, 3, lit.top, lit.bottom]);
    // An app without box art: no ambient light
    await app.page.evaluate(() => Launcher.prepareStart(window.__host, 999, 'No Art'));
    assert.equal((await ambient('launch-backdrop')).painted, false);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the rows that scroll under the hero fade out instead of ending in a hard cut', async () => {
  const app = await openAppList(12);
  try {
    const fade = () => app.page.evaluate(() => ({
      scrolled: document.getElementById('game-grid').scrollTop > 0,
      opacity: getComputedStyle(document.getElementById('launcher-hero'), '::after').opacity,
    }));
    await focusApp(app.page, 'A Steam Cover');
    assert.deepEqual(await fade(), { scrolled: false, opacity: '0' });
    // One row down: the grid scrolls after the focus moved, so the fade follows the scrolling itself
    await press(app.page, 'ArrowDown');
    await app.page.waitForFunction(() => getComputedStyle(document.getElementById('launcher-hero'), '::after').opacity === '1', null,
      { timeout: 3000 });
    assert.deepEqual(await fade(), { scrolled: true, opacity: '1' });
    // The fade lies above the top of the grid and spans the width of the screen
    const band = await app.page.evaluate(() => {
      const hero = document.getElementById('launcher-hero').getBoundingClientRect();
      const grid = document.getElementById('game-grid').getBoundingClientRect();
      const style = getComputedStyle(document.getElementById('launcher-hero'), '::after');
      return { atGridTop: Math.abs(hero.bottom - grid.top) < 2, height: style.height, width: style.width,
        gradient: /linear-gradient/.test(style.backgroundImage) };
    });
    assert.deepEqual(band, { atGridTop: true, height: '72px', width: '1920px', gradient: true });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a real mouse pointer that rests over the page changes neither the hero nor its key hints, only the focus does', async () => {
  const app = await openAppList(12);
  try {
    await focusApp(app.page, 'A Steam Cover');
    // The pointer moves over another tile (navigation.js then leaves the focus until the next key): the hero keeps the
    // focused app
    const banner = await centreOf(app.page, '#game-grid .game-container[aria-label="C Landscape Banner"]');
    await app.page.mouse.move(banner.x, banner.y);
    await app.page.waitForTimeout(100);
    assert.equal((await hero(app.page)).title, 'A Steam Cover');
    // The remote takes the focus back and moves it a row down, and the grid scrolls under the resting pointer: the hero
    // names the focused app, not the tile that the pointer rests on
    await press(app.page, 'ArrowDown');
    await press(app.page, 'ArrowDown');
    await app.page.waitForTimeout(600);
    const state = await app.page.evaluate(() => ({ focused: Views.Apps.view.current().getAttribute('aria-label'),
      hero: document.getElementById('hero-title').textContent }));
    assert.notEqual(state.focused, 'A Steam Cover');
    assert.equal(state.hero, state.focused);
    // The pointer over the header doesn't hide the key hints of the focused card
    const header = await centreOf(app.page, '#header-title');
    await app.page.mouse.move(header.x, header.y);
    await app.page.waitForTimeout(100);
    assert.deepEqual(await hero(app.page), { kind: 'app', state: 'idle', title: state.focused, chips: [], hints: 'visible' });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the hero offers UP for the options of a host only in the first row of cards, and the options key in the others', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await app.page.evaluate(() => {
      window.beginBackgroundPollingOfHost = function() {};
      window.endBackgroundPollingOfHost = function() {};
      for (let i = 0; i < 6; i++) {
        addHostToGrid({ serverUid: 'H' + i, hostname: 'PC-' + i, online: true, paired: true, currentGame: 0, address: '10.0.0.' + i,
          externalPort: 47989, httpPort: 47989, httpsPort: 47984, macAddress: '00:11:22:33:44:55', appVersion: '7.1.431.-1',
          gfeVersion: '', serverCodecModeSupport: 0x1F03, toString: () => 'PC-' + i, updateExternalAddressIP4() {}, clearBoxArt() {},
          refreshServerInfo: () => Promise.resolve(), pollServer(callback) {
            callback(this);
          } });
      }
    });
    // The key hints of the hero: the key cap (its text or icon) and the label
    const hints = () => app.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#hero-hints .hint'), (hint) => {
      const use = hint.querySelector('use');
      return [use ? use.getAttribute('xlink:href') : hint.querySelector('.keycap').textContent, hint.lastChild.textContent];
    }));
    // The first host, in the first row (the Add Host card and four hosts): UP reaches its options button
    await press(app.page, 'ArrowRight');
    assert.equal((await hero(app.page)).title, 'PC-0');
    assert.deepEqual(await hints(), [['OK', 'Open'], ['#i-arrow-up', 'Options']]);
    // A host in the second row: UP moves to the row above, so the hero names the options key (the key cap of the app
    // menu hint) instead
    await press(app.page, 'ArrowDown');
    assert.equal((await hero(app.page)).title, 'PC-5');
    assert.deepEqual(await hints(), [['OK', 'Open'], ['#i-more', 'Options']]);
    await press(app.page, 'ArrowUp');
    assert.equal((await hero(app.page)).title, 'PC-0');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the hero of a PC that runs a game says what OK does: it opens the PC, where the game is resumed or quit', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await installHosts(app.page);
    // GAMING-PC runs a game; the focus moves from the Add Host card to it
    await press(app.page, 'ArrowRight');
    const read = () => app.page.evaluate(() => ({
      title: document.getElementById('hero-title').textContent,
      text: document.getElementById('hero-text').textContent,
      ok: document.querySelector('#hero-hints .hint').textContent,
    }));
    assert.deepEqual(await read(), { title: 'GAMING-PC', text: 'A game is running on this PC. Open it to resume or quit the game.',
      ok: 'OKOpen' });
    await app.page.evaluate(() => i18n.setLanguage('pt-BR'));
    await app.page.waitForTimeout(400);
    await press(app.page, 'ArrowRight');
    await press(app.page, 'ArrowLeft');
    assert.deepEqual(await read(), { title: 'GAMING-PC', text: 'Um jogo está em execução neste PC. Abra-o para retomar ou encerrar.',
      ok: 'OKAbrir' });
    // OK opens the PC (its app list), it doesn't resume the game by itself
    await app.page.evaluate(() => {
      window.__opened = [];
      hostChosen = (host) => window.__opened.push(host.hostname);
      startGame = () => window.__opened.push('startGame');
    });
    await press(app.page, 'Enter');
    assert.deepEqual(await app.page.evaluate(() => window.__opened), ['GAMING-PC']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the ambient light follows the box art only once the focus rests, and covers only the right part of the screen', async () => {
  const app = await openAppList();
  try {
    const ambient = () => app.page.evaluate(() => {
      const element = document.getElementById('hero-ambient');
      return { painted: element.classList.contains('is-painted'), top: element.style.getPropertyValue('--a1') };
    });
    const rested = () => app.page.waitForFunction(() => document.getElementById('hero-ambient').classList.contains('is-painted'), null,
      { timeout: 3000 });
    await focusApp(app.page, 'A Steam Cover');
    await rested();
    const red = await ambient();
    // Quick moves over two more apps: the light fades out and keeps its colours, so that nothing large is painted again
    await focusApp(app.page, 'B Sunshine Cover');
    await app.page.waitForTimeout(100);
    await focusApp(app.page, 'C Landscape Banner');
    await app.page.waitForTimeout(100);
    assert.deepEqual(await ambient(), { painted: false, top: red.top });
    // The focus rests: the light shows the colours of that app (green above)
    await rested();
    const green = await ambient();
    assert.notEqual(green.top, red.top);
    assert.ok(green.top.split(',')[1] > 200, green.top);
    // Away and back before the light changed: the colours of the app the focus rests on, not of the one in between
    await focusApp(app.page, 'A Steam Cover');
    await app.page.waitForTimeout(100);
    await focusApp(app.page, 'C Landscape Banner');
    await rested();
    assert.deepEqual(await ambient(), green);
    // The glows lie right of the text: the light starts at 40 % of the width
    const box = await app.page.evaluate(() => {
      const rect = document.getElementById('hero-ambient').getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.right)];
    });
    assert.deepEqual(box, [768, 1920]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the chips of the header stay readable over the ambient light of the brightest box art', async () => {
  // A white and yellow cover: the brightest light the hero can paint behind the header
  const app = await openAppList(0, [{ id: 41, title: 'A Bright Cover', art: cover(600, 800, '#ffffff', '#ffd400') }]);
  try {
    await focusApp(app.page, 'A Bright Cover');
    await app.page.waitForFunction(() => getComputedStyle(document.getElementById('hero-ambient')).opacity === '1', null, { timeout: 3000 });
    // The boxes of the text and icon of each chip, and their text colour
    const chips = await app.page.evaluate(() => ['header-profile', 'header-status'].map((id) => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(id));
      const rect = range.getBoundingClientRect();
      return { id, colour: getComputedStyle(document.getElementById(id)).color.match(/\d+/g).slice(0, 3).map(Number),
        clip: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } };
    }));
    assert.ok(chips.every((chip) => chip.clip.width > 40 && chip.clip.x > 768), JSON.stringify(chips));
    // What lies behind the text: the chips without their text and icons
    await app.page.addStyleTag({ content: '.header-status, .header-status * { color: transparent !important; }' });
    await app.page.waitForTimeout(100);
    // Relative luminance and contrast ratio of WCAG 2
    const luminance = (colour) => {
      const linear = colour.map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    for (const chip of chips) {
      const text = luminance(chip.colour);
      const worst = Math.min.apply(null, (await pixels(app.page, chip.clip)).map((colour) => {
        const back = luminance(colour);
        return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
      }));
      assert.ok(worst >= 4.5, chip.id + ': ' + worst.toFixed(2) + ':1');
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the tiles keep the top of portrait covers, and ring the focused card with a dark gap that shows on light box art', async () => {
  // A 600 x 900 cover with a green band at its top, where Steam and Sunshine covers have their logo, and a white cover
  const banded = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" ' +
    'height="900"><rect width="600" height="900" fill="#ff0000"/><rect width="600" height="40" fill="#00ff00"/></svg>');
  const app = await openAppList(0, [{ id: 31, title: 'A Logo Cover', art: banded }, { id: 32, title: 'B White Cover', art: cover(600, 800,
    '#ffffff', '#ffffff') }]);
  try {
    await focusApp(app.page, 'B White Cover');
    await app.page.waitForTimeout(400);
    // The tile (3:4) crops the cover at the bottom: its first rows show the band
    const tile = await app.page.evaluate(() => {
      const rect = document.querySelector('#game-grid .game-container[aria-label="A Logo Cover"]').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top) };
    });
    const top = await pixels(app.page, { x: tile.x, y: tile.y + 2, width: 1, height: 10 });
    assert.ok(top.every((colour) => colour[1] > 200 && colour[0] < 60), JSON.stringify(top));

    // The white cover has the focus: white ring, dark gap, white cover, from the outside in
    const edge = await app.page.evaluate(() => {
      const rect = document.querySelector('#game-grid .game-container[aria-label="B White Cover"]').getBoundingClientRect();
      return { x: Math.round(rect.left), y: Math.round(rect.top + rect.height / 2) };
    });
    const row = await pixels(app.page, { x: edge.x - 8, y: edge.y, width: 12, height: 1 });
    // x - 8 to x + 3: the white ring (about 4 px), the dark gap (about 3 px), then the cover
    assert.ok(isWhite(row[2]) && isWhite(row[3]), JSON.stringify(row));
    assert.ok(isDark(row[6]), JSON.stringify(row));
    assert.ok(isWhite(row[11]), JSON.stringify(row));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the tooltips of the header buttons lie above the PC illustration of the hero', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await installHosts(app.page);
    await press(app.page, 'ArrowRight');
    await press(app.page, 'ArrowUp');
    await press(app.page, 'ArrowUp');
    for (const id of ['rescanNetworkBtn', 'settingsBtn']) {
      await app.page.evaluate((button) => {
        unmark(Views.HostsNav.view.current());
        Views.HostsNav.view.index = Array.prototype.indexOf.call(Views.HostsNav.view.func(), button);
        mark(button);
      }, id);
      await app.page.waitForTimeout(300);
      const layout = await app.page.evaluate((button) => {
        const tooltip = document.querySelector('.mdl-tooltip[for="' + button + '"]');
        const bezel = document.querySelector('#hero-pc rect[fill="url(#pc-bezel)"]').getBoundingClientRect();
        return { shown: tooltip.classList.contains('is-active'), bottom: tooltip.getBoundingClientRect().bottom, bezel: bezel.top };
      }, id);
      assert.equal(layout.shown, true, id);
      assert.ok(layout.bottom + 8 <= layout.bezel, id + ': ' + JSON.stringify(layout));
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a PC shows one state chip in the hero, the same as on its card: Running, Online, Unpaired or Offline', async () => {
  const app = await openApp(harness, { tv: TV });
  try {
    await installHosts(app.page);
    const seen = [];
    // From the Add PC card to the four PCs: GAMING-PC (a game runs), HTPC (offline), OFFICE (not paired), STUDIO (online)
    for (let i = 0; i < 4; i++) {
      await press(app.page, 'ArrowRight');
      seen.push(await app.page.evaluate(() => {
        const title = document.getElementById('hero-title').textContent;
        const host = window.__hosts.find((entry) => entry.hostname === title);
        const current = document.getElementById('host-container-' + host.serverUid);
        return {
          title: title,
          hero: Array.prototype.map.call(document.querySelectorAll('#hero-chips .status-chip'), (chip) => chip.className + ' ' + chip.textContent),
          card: Array.prototype.map.call(current.querySelectorAll('.host-chips .status-chip'), (chip) => chip.className + ' ' + chip.textContent),
          // The stylesheet writes the running state in capitals, like the other states
          shown: Array.prototype.map.call(document.querySelectorAll('#hero-chips .status-chip'), (chip) => getComputedStyle(chip).textTransform),
        };
      }));
    }
    assert.deepEqual(seen.map((entry) => [entry.title, entry.hero]), [
      ['GAMING-PC', ['status-chip chip-running Running']],
      ['HTPC', ['status-chip chip-offline OFFLINE']],
      ['OFFICE', ['status-chip chip-locked UNPAIRED']],
      ['STUDIO', ['status-chip chip-online ONLINE']],
    ]);
    seen.forEach((entry) => assert.deepEqual(entry.hero, entry.card, entry.title));
    assert.equal(seen[0].shown[0], 'uppercase');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the hint of an app says Start like its menu, and Resume for the running app', async () => {
  const app = await openAppList();
  try {
    const hint = () => app.page.evaluate(() => document.querySelector('#hero-hints .hint').textContent);
    assert.equal(await hint(), 'OKStart');
    await app.page.evaluate(() => {
      window.__host.currentGame = 21;
      stylizeBoxArts(window.__host, window.__apps);
      Launcher.refresh();
    });
    await focusApp(app.page, 'A Steam Cover');
    assert.equal(await hint(), 'OKResume');
    await app.page.evaluate(() => i18n.setLanguage('de-DE'));
    await app.page.waitForTimeout(400);
    await focusApp(app.page, 'B Sunshine Cover');
    assert.equal(await hint(), 'OKStarten');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the button Quit app on the PC only shows while an app runs, and the header row of the app list goes with it', async () => {
  const app = await openAppList();
  try {
    const header = () => app.page.evaluate(() => ({
      shown: $('#quitRunningAppBtn').css('display') !== 'none',
      row: Views.AppsNav.view.func(),
      tooltip: $('#quitRunningAppTooltip').text().trim(),
    }));
    // No app runs on the host: no button that would only say so
    assert.deepEqual(await header(), { shown: false, row: ['goBackBtn'], tooltip: 'Quit app on the PC' });
    // An app runs: the button shows with the mark of its tile, and the header row reaches it
    await app.page.evaluate(async () => {
      window.__host.currentGame = 22;
      await showApps(window.__host);
    });
    await app.page.waitForFunction(() => $('#game-container-22').hasClass('current-game-active'));
    assert.deepEqual(await header(), { shown: true, row: ['goBackBtn', 'quitRunningAppBtn'], tooltip: 'Quit app on the PC' });
    await app.page.evaluate(() => {
      Navigation.change(Views.AppsNav);
      Views.AppsNav.view.index = 1;
    });
    // The app quits: the button goes, and the header row falls back to the back button
    await app.page.evaluate(async () => {
      window.__host.currentGame = 0;
      await showApps(window.__host);
    });
    await app.page.waitForFunction(() => !$('#game-container-22').hasClass('current-game-active'));
    assert.deepEqual(await header(), { shown: false, row: ['goBackBtn'], tooltip: 'Quit app on the PC' });
    assert.equal(await app.page.evaluate(() => Views.AppsNav.view.current()), 'goBackBtn');
    // Back on the hosts and into the apps of a host whose app runs, the button shows at once
    await app.page.evaluate(async () => {
      showHostsMode();
      window.__host.currentGame = 21;
      await showApps(window.__host);
    });
    assert.equal((await header()).shown, true);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
