'use strict';

// Checks the theme of the menus in the real page (wasm/static/css/style.css, the icon sprite of wasm/index.html and
// wasm/platform/launcher.js) on the UI that 1.19.101 added: every icon of the page, also those that the scripts build
// for the host cards, the hero, the network chip and the update button, is a symbol of the sprite and no Material icon
// is left; the icon of the Rescan network button turns while a scan runs; the hint of the app menu is one quiet line
// in the header, which fits in every language, also with text 10 % wider (tests/browser/text-stress.js); the running
// app has one look (a mint ring and the mint Running badge with a play mark) and a hidden app is dimmed with its Hidden
// badge; the Stream Menu lies on the live video as an opaque panel with white focus, a group label, a separator and
// the On/Off value of its switches; the app menu marks the running app and shows Quit
// as a destructive entry. Running is mint on the hosts screen as well; the host menu is a list like the app menu; the
// octets of the Add Host dialog have the chevron and the white focus of the theme; the pairing PIN is large; the count
// of the update button sits on its corner; and a focused dialog button keeps a gap to its neighbour.
// tests/unit/theme-assets.test.js checks the stylesheet and the sprite as files.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');
const { forEachTextWidth } = require('./text-stress');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const MINT = 'rgb(46, 230, 160)';

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
  [make('A', 'GAMING-PC', true, true, 7), make('BB', 'HTPC', false, true), make('CCC', 'OFFICE', true, false), make('DDDD', 'STUDIO', true, true)]
    .forEach((host) => addHostToGrid(host));
});

// Every <use> of the page: its reference, whether that names a symbol of the sprite, and whether it draws something
const iconUses = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('use'), (use) => {
  const reference = use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
  const target = reference.charAt(0) === '#' ? document.getElementById(reference.slice(1)) : null;
  const rect = use.ownerSVGElement.getBoundingClientRect();
  return {
    reference,
    plainHref: use.hasAttribute('href'),
    symbol: !!target && target.tagName.toLowerCase() === 'symbol' && target.parentElement.id === 'icon-sprite',
    shown: rect.width > 0 && rect.height > 0,
    drawn: use.getBBox().width > 0,
  };
}));

// Open the app grid of a simulated host whose app 13 runs, with the given hidden apps
async function openAppList(hidden) {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  await app.page.evaluate(async (hiddenApps) => {
    window.__apps = [{ id: 11, title: 'Desktop' }, { id: 12, title: 'Steam Big Picture' }, { id: 13, title: 'Cyberpunk 2077' }];
    const host = {
      paired: true, online: true, serverUid: 'HOST1', hostname: 'GAMING-PC', address: '10.0.0.2', httpPort: 47989, currentGame: 13,
      appVersion: '7.1.431.-1', gfeVersion: '', serverCodecModeSupport: 0x1F03,
      refreshServerInfo: () => Promise.resolve(),
      getAppList: () => Promise.resolve(window.__apps.slice()),
      getAppById: (id) => Promise.resolve(window.__apps.find((entry) => entry.id == id) || null),
      getBoxArt: () => Promise.resolve('static/res/placeholder_game.svg'),
      // The app polls the host of the app grid every 5 seconds once its box art loaded (showApps() in index.js)
      pollServer: (callback) => callback(host),
      toString: () => 'GAMING-PC',
    };
    if (hiddenApps) {
      localStorage.setItem('hiddenApps_HOST1', JSON.stringify(hiddenApps));
      showHiddenAppsHost = 'HOST1';
    }
    api = host;
    await showApps(host);
    Navigation.switch();
    Navigation.change(Views.Apps);
  }, hidden || null);
  await app.page.waitForFunction(() => $('#game-grid').is(':visible') && !$('#wasmSpinner').is(':visible') &&
    $('#game-grid .game-container').length > 0, null, { timeout: 5000 });
  return app;
}

test('every icon is a symbol of the sprite, also the icons that the scripts build, and no Material icon is left', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await installHosts(app.page);
    await app.page.evaluate(() => {
      updateAppButton('9.0.0');
      Launcher.refreshHeaderStatus();
    });
    // The hero shows the host with the running game and its key hints (OK Open, an arrow for Options)
    await app.page.keyboard.press('ArrowRight');
    await app.page.waitForTimeout(400);
    const uses = await iconUses(app.page);
    const references = uses.map((use) => use.reference);
    // Header buttons, the network chip, the update button, the host tiles, chips and options, and the hero hints
    ['#i-refresh', '#i-gear', '#i-help', '#i-wifi', '#i-download', '#i-pc', '#i-more', '#i-play', '#i-lock', '#i-link', '#i-arrow-up']
      .forEach((reference) => assert.ok(references.indexOf(reference) >= 0, reference + ' in ' + JSON.stringify(references)));
    uses.forEach((use) => {
      assert.equal(use.symbol, true, use.reference + ' names a symbol of the sprite');
      assert.equal(use.plainHref, false, use.reference + ' uses xlink:href only');
      if (use.shown) {
        assert.equal(use.drawn, true, use.reference + ' draws its symbol');
      }
    });
    assert.ok(uses.filter((use) => use.shown).length >= 15, JSON.stringify(uses.filter((use) => use.shown)));
    const leftovers = await app.page.evaluate(() => ({
      ligatures: document.querySelectorAll('.material-icons').length,
      stylesheets: Array.prototype.filter.call(document.styleSheets, (sheet) => /material-icons/.test(sheet.href || '')).length,
      fonts: Array.from(document.fonts).filter((font) => /Material Icons/.test(font.family)).length,
      uiFont: getComputedStyle(document.body).fontFamily,
    }));
    assert.deepEqual(leftovers, { ligatures: 0, stylesheets: 0, fonts: 0, uiFont: 'Manrope, Roboto, SamsungOne, sans-serif' });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Rescan network button is a round header button whose icon turns while a scan runs', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    const look = () => app.page.evaluate(() => {
      const button = document.getElementById('rescanNetworkBtn');
      const settings = document.getElementById('settingsBtn');
      const icon = button.querySelector('.navigation-button-icons');
      return {
        size: [button.offsetWidth, button.offsetHeight],
        sameAsSettings: button.offsetWidth === settings.offsetWidth && button.offsetHeight === settings.offsetHeight,
        round: getComputedStyle(button).borderRadius,
        animation: getComputedStyle(icon).animationName,
      };
    });
    assert.deepEqual(await look(), { size: [64, 64], sameAsSettings: true, round: '50%', animation: 'none' });
    await app.page.evaluate(() => $('#rescanNetworkBtn').addClass('is-scanning'));
    assert.equal((await look()).animation, 'rescan-network-spin');
    // The spin turns the icon only, with a transform
    const turned = await app.page.evaluate(() => new Promise((resolve) => setTimeout(() => {
      resolve(getComputedStyle(document.querySelector('#rescanNetworkBtn .navigation-button-icons')).transform);
    }, 300)));
    assert.match(turned, /^matrix\(/);
    await app.page.evaluate(() => $('#rescanNetworkBtn').removeClass('is-scanning'));
    assert.equal((await look()).animation, 'none');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the hint of the app menu is one quiet line in the header with a key cap', async () => {
  const app = await openAppList();
  try {
    const hint = await app.page.evaluate(() => {
      const element = document.getElementById('appMenuHint');
      const rect = element.getBoundingClientRect();
      const title = document.getElementById('header-title').getBoundingClientRect();
      const nav = document.querySelector('#main-header .mdl-navigation').getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        shown: $(element).is(':visible'),
        oneLine: rect.height <= parseFloat(style.lineHeight) + 1,
        whiteSpace: style.whiteSpace,
        afterTitle: rect.left >= title.right,
        beforeButtons: rect.right <= nav.left,
        keycap: getComputedStyle(element, '::before').backgroundImage.indexOf('url(') >= 0,
        quiet: style.color,
      };
    });
    assert.deepEqual(hint, { shown: true, oneLine: true, whiteSpace: 'nowrap', afterTitle: true, beforeButtons: true, keycap: true,
      quiet: 'rgb(141, 150, 184)' });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the hint of the app menu fits the header without an ellipsis in every language, also with 10 % wider text', async () => {
  const app = await openAppList();
  try {
    const languages = await app.page.evaluate(() => i18n.getSupportedLocales());
    assert.ok(languages.length >= 5, JSON.stringify(languages));
    for (const language of languages) {
      await app.page.evaluate((locale) => i18n.setLanguage(locale), language);
      await app.page.waitForFunction((locale) => document.documentElement.getAttribute('lang') === locale, language);
      await forEachTextWidth(app.page, async (stress) => {
        const hint = await app.page.evaluate(() => {
          const element = document.getElementById('appMenuHint');
          return { text: element.textContent, fits: element.scrollWidth <= element.clientWidth + 1 };
        });
        assert.equal(hint.fits, true, language + stress + ' ' + JSON.stringify(hint));
      });
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the running app has one look, a mint ring and the mint Running badge, and a hidden app is dimmed with its badge', async () => {
  const app = await openAppList([{ id: '12', title: 'Steam Big Picture' }, { id: '13', title: 'Cyberpunk 2077' }]);
  try {
    // Select Desktop, so that the running app shows its ring without the focus
    await app.page.keyboard.press('ArrowRight');
    assert.equal(await app.page.evaluate(() => Views.Apps.view.current().getAttribute('aria-label')), 'Desktop');
    const tiles = await app.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#game-grid .game-container'), (tile) => {
      const badges = Array.prototype.map.call(tile.querySelectorAll('.app-badge'), (badge) => {
        const rect = badge.getBoundingClientRect();
        return {
          text: badge.textContent,
          shownAs: getComputedStyle(badge).textTransform,
          background: getComputedStyle(badge).backgroundImage,
          mark: getComputedStyle(badge, '::before').backgroundImage.indexOf('url(') >= 0,
          top: rect.top - tile.getBoundingClientRect().top,
          bottom: rect.bottom - tile.getBoundingClientRect().top,
        };
      });
      return {
        title: tile.getAttribute('aria-label'),
        ring: getComputedStyle(tile).boxShadow,
        secondBadge: getComputedStyle(tile, '::after').content,
        dim: getComputedStyle(tile, '::before').backgroundColor,
        badges,
      };
    }));
    const running = tiles.find((tile) => tile.title === 'Cyberpunk 2077');
    const hidden = tiles.find((tile) => tile.title === 'Steam Big Picture');
    const plain = tiles.find((tile) => tile.title === 'Desktop');
    // The running app: the mint ring and one badge, a mint pill with a play mark (no second play badge)
    assert.ok(running.ring.indexOf(MINT) >= 0, running.ring);
    assert.equal(running.secondBadge, 'none');
    const runningBadge = running.badges.find((badge) => badge.text === 'Running');
    assert.equal(runningBadge.shownAs, 'uppercase');
    assert.match(runningBadge.background, /linear-gradient/);
    assert.equal(runningBadge.mark, true);
    // It is hidden as well: its Hidden badge sits below the Running badge
    const hiddenOfRunning = running.badges.find((badge) => badge.text === 'Hidden');
    assert.ok(hiddenOfRunning.top >= runningBadge.bottom, JSON.stringify(running.badges));
    // A hidden app: dimmed, with the Hidden badge and its mark
    assert.equal(hidden.dim, 'rgba(10, 13, 26, 0.62)');
    assert.deepEqual(hidden.badges.map((badge) => [badge.text, badge.mark]), [['Hidden', true]]);
    assert.equal(plain.dim, 'rgba(0, 0, 0, 0)');
    assert.deepEqual(plain.badges, []);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the Stream Menu is an opaque panel on the live video, with white focus, its group and its On/Off values', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      streamLaunchHost = { hostname: 'GAMING-PC' };
      streamLaunchAppTitle = 'Game 8';
      showStreamMode();
      $('#loadingSpinner').css('display', 'none');
      $('body').css('backgroundColor', 'transparent');
      isInGame = true;
      wasmSessionStarted = true;
      isStreamConnected = true;
      streamMouseEmulationActive = true;
      openStreamMenu();
    });
    await app.page.keyboard.press('ArrowDown');
    const look = await app.page.evaluate(() => {
      const css = (id, pseudo) => getComputedStyle(document.getElementById(id), pseudo || null);
      const group = getComputedStyle(document.querySelector('#streamMenu .overlay-menu-group'));
      const separator = getComputedStyle(document.querySelector('#streamMenu .overlay-menu-separator'));
      return {
        view: document.body.getAttribute('data-view'),
        pageBackdrop: getComputedStyle(document.body, '::before').display,
        scrim: css('streamMenuOverlay').backgroundColor,
        // The base of the panel is an opaque gradient (rgb() stops only, no rgba())
        panel: /linear-gradient\(rgb\(31, 38, 73\) 0%, rgb\(20, 25, 50\) 100%\)$/.test(css('streamMenu').backgroundImage),
        blur: css('streamMenu').filter,
        focused: document.activeElement.id,
        focus: [css('streamMenuStats').backgroundColor, css('streamMenuStats').color],
        values: [['streamMenuStatsValue', $('#streamMenuStatsValue').text(), $('#streamMenuStatsValue').is(':visible')],
          ['streamMenuMouseValue', $('#streamMenuMouseValue').text(), $('#streamMenuMouseValue').is(':visible')]],
        onPill: css('streamMenuMouseValue').backgroundImage.indexOf('linear-gradient') >= 0,
        group: [group.textTransform, group.borderTopStyle],
        separator: separator.borderTopStyle,
        quit: css('streamMenuQuit').color,
      };
    });
    assert.deepEqual(look, {
      view: 'stream', pageBackdrop: 'none', scrim: 'rgba(0, 0, 0, 0)', panel: true, blur: 'none',
      focused: 'streamMenuStats', focus: ['rgb(255, 255, 255)', 'rgb(10, 13, 26)'],
      values: [['streamMenuStatsValue', 'Off', true], ['streamMenuMouseValue', 'On', true]],
      onPill: true, group: ['uppercase', 'solid'], separator: 'solid', quit: 'rgb(255, 141, 161)',
    });
    // Nothing of the video shows through the panel: a white and a black page behind it give the same pixels
    const clip = await app.page.evaluate(() => {
      const rect = document.getElementById('streamMenu').getBoundingClientRect();
      return { x: Math.round(rect.left + 40), y: Math.round(rect.top + 40), width: Math.round(rect.width - 80), height: 40 };
    });
    const behind = async (colour) => {
      await app.page.evaluate((value) => {
        document.body.style.backgroundColor = value;
      }, colour);
      return pixels(app.page, clip);
    };
    const onWhite = await behind('#ffffff');
    assert.deepEqual(await behind('#000000'), onWhite);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the app menu marks the running app, emphasises Resume and shows Quit as a destructive entry', async () => {
  const app = await openAppList();
  try {
    const open = (title) => app.page.evaluate((name) => {
      openAppMenu(document.querySelector('#game-grid .game-container[aria-label="' + name + '"]'));
      const css = (id) => getComputedStyle(document.getElementById(id));
      const icon = (id) => getComputedStyle(document.querySelector('#' + id + ' .overlay-menu-icon'));
      const result = {
        running: $('#appMenu').hasClass('is-running'),
        subtitle: css('appMenuSubtitle').color,
        mainIcon: icon($('#appMenuResume').is(':visible') ? 'appMenuResume' : 'appMenuStart').backgroundImage.indexOf('linear-gradient') >= 0,
        quit: $('#appMenuQuit').is(':visible') ? [css('appMenuQuit').color, icon('appMenuQuit').color] : null,
        centred: Math.abs(document.getElementById('appMenu').getBoundingClientRect().left +
          document.getElementById('appMenu').getBoundingClientRect().width / 2 - window.innerWidth / 2) < 2,
      };
      closeAppMenu();
      return result;
    }, title);
    assert.deepEqual(await open('Cyberpunk 2077'), { running: true, subtitle: MINT, mainIcon: true,
      quit: ['rgb(255, 141, 161)', 'rgb(255, 92, 122)'], centred: true });
    assert.deepEqual(await open('Desktop'), { running: false, subtitle: 'rgb(141, 150, 184)', mainIcon: true, quit: null, centred: true });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('running is mint on the hosts screen too: the chips of the hero and the card, and the state tile', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await installHosts(app.page);
    await app.page.keyboard.press('ArrowRight');
    await app.page.waitForTimeout(300);
    const look = await app.page.evaluate(() => {
      const background = (element) => getComputedStyle(element).backgroundImage;
      return {
        hero: background(document.querySelector('#hero-chips .chip-running')),
        card: background(document.querySelector('#host-container-A .chip-running')),
        tile: background(document.querySelector('#host-container-A .host-tile')),
        text: getComputedStyle(document.querySelector('#hero-chips .chip-running')).color,
      };
    });
    // The gradient of the Running badge of the running app (#10B981 to #2EE6A0)
    const mint = 'linear-gradient(120deg, rgb(16, 185, 129) 0%, rgb(46, 230, 160) 100%)';
    assert.deepEqual(look, { hero: mint, card: mint, tile: mint, text: 'rgb(4, 38, 26)' });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the host menu is a list like the app menu: an icon per entry, Delete PC in red and Close as the last entry', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await installHosts(app.page);
    await app.page.evaluate(() => hostMenuDialog(Object.assign({}, hosts.A, { hostname: 'GAMING-PC', online: true })));
    await app.page.waitForTimeout(300);
    const menu = await app.page.evaluate(() => {
      const dialog = document.getElementById('hostMenuDialog-A');
      const appMenu = document.getElementById('appMenu');
      return {
        likeAppMenu: getComputedStyle(dialog).width === '640px' && getComputedStyle(dialog).backgroundImage === getComputedStyle(appMenu).backgroundImage,
        title: dialog.querySelector('.overlay-menu-title').textContent,
        entries: Array.prototype.map.call(dialog.querySelectorAll('button'), (button) => [button.id,
          button.querySelector('use').getAttribute('xlink:href'), button.textContent, getComputedStyle(button).textAlign]),
        deleteColour: [getComputedStyle(document.getElementById('deleteHost-GAMING-PC')).color,
          getComputedStyle(document.querySelector('#deleteHost-GAMING-PC .overlay-menu-icon')).color],
        disabled: getComputedStyle(document.getElementById('wakeHost-GAMING-PC')).opacity,
        focused: document.activeElement.id,
        focus: [getComputedStyle(document.activeElement).backgroundColor, getComputedStyle(document.activeElement).color],
      };
    });
    assert.deepEqual(menu, {
      likeAppMenu: true, title: 'GAMING-PC',
      entries: [['refreshApps-GAMING-PC', '#i-refresh', 'Refresh apps', 'left'], ['wakeHost-GAMING-PC', '#i-power', 'Wake PC', 'left'],
        ['deleteHost-GAMING-PC', '#i-trash', 'Delete PC', 'left'], ['viewDetails-GAMING-PC', '#i-info', 'View Details', 'left'],
        ['closeHostMenu', '#i-close', 'Close', 'left']],
      deleteColour: ['rgb(255, 141, 161)', 'rgb(255, 92, 122)'], disabled: '0.45',
      focused: 'refreshApps-GAMING-PC', focus: ['rgb(255, 255, 255)', 'rgb(10, 13, 26)'],
    });
    // DOWN moves through the entries and RETURN closes the menu (Views.HostMenuDialog)
    await app.page.keyboard.press('ArrowDown');
    await app.page.keyboard.press('ArrowDown');
    await app.page.waitForTimeout(200);
    assert.equal(await app.page.evaluate(() => document.activeElement.id), 'deleteHost-GAMING-PC');
    await app.page.evaluate(() => document.getElementById('closeHostMenu').click());
    assert.equal(await app.page.evaluate(() => document.getElementById('hostMenuDialog-A')), null);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the octets of the Add Host dialog show the chevron of the theme instead of the native arrow, and a white focus', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => addHostDialog());
    await app.page.waitForTimeout(300);
    const octets = await app.page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.ip-address-select-field'), (select) => {
      const style = getComputedStyle(select);
      return { appearance: style.webkitAppearance, chevron: /^url\("data:image\/svg\+xml/.test(style.backgroundImage),
        marked: select.classList.contains('hovered'), fill: style.backgroundColor, text: style.color };
    }));
    assert.equal(octets.length, 4);
    octets.forEach((octet) => assert.deepEqual([octet.appearance, octet.chevron], ['none', true], JSON.stringify(octet)));
    // The marked octet is white with dark text, like a focused menu of the settings; the others stay dark
    assert.deepEqual(octets.map((octet) => octet.marked), [true, false, false, false]);
    assert.deepEqual([octets[0].fill, octets[0].text], ['rgb(255, 255, 255)', 'rgb(10, 13, 26)']);
    assert.deepEqual([octets[1].fill, octets[1].text], ['rgba(0, 0, 0, 0.3)', 'rgb(244, 246, 255)']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the pairing dialog shows the PIN large, in tabular figures', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => {
      pairingCert = pairingCert || { cert: 'cert', privateKey: 'key' };
      pairingDialog({ hostname: 'OFFICE', online: true, paired: false, currentGame: 0, toString: () => 'OFFICE',
        pollServer(callback) {
          callback(this);
        }, pair: () => new Promise(() => {}) }, function() {}, function() {});
    });
    await app.page.waitForTimeout(300);
    const pin = await app.page.evaluate(() => {
      const element = document.querySelector('#pairingDialogText b');
      const text = getComputedStyle(document.getElementById('pairingDialogText'));
      return { digits: /^\d{4}$/.test(element.textContent), size: parseFloat(getComputedStyle(element).fontSize),
        textSize: parseFloat(text.fontSize), numbers: getComputedStyle(element).fontVariantNumeric, colour: getComputedStyle(element).color };
    });
    assert.deepEqual(pin, { digits: true, size: 48, textSize: 22, numbers: 'tabular-nums', colour: 'rgb(255, 255, 255)' });
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('the count of the update button sits on its top right corner, outlined, and leaves its icon free', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => updateAppButton('9.0.0'));
    await app.page.waitForFunction(() => getComputedStyle(document.getElementById('updateAppBtn')).opacity === '1', null, { timeout: 4000 });
    const layout = await app.page.evaluate(() => {
      const button = document.getElementById('updateAppBtn').getBoundingClientRect();
      const icon = document.querySelector('#updateAppBtn .icon').getBoundingClientRect();
      return { right: Math.round(button.right), top: Math.round(button.top), icon: [Math.round(icon.left + icon.width / 2), Math.round(icon.top)],
        outline: getComputedStyle(document.querySelector('#updateAppBtn .mdl-badge'), '::after').boxShadow };
    });
    assert.equal(layout.outline, 'rgb(10, 13, 26) 0px 0px 0px 3px');
    // The red count covers the top right corner of the button, and the top of the download icon keeps the button colour
    const red = (colour) => colour[0] > 200 && colour[1] < 130;
    const [corner] = await pixels(app.page, { x: layout.right - 5, y: layout.top + 5, width: 1, height: 1 });
    assert.ok(red(corner), JSON.stringify(corner));
    const iconTop = await pixels(app.page, { x: layout.icon[0] + 6, y: layout.icon[1], width: 8, height: 8 });
    assert.ok(!iconTop.some(red), JSON.stringify(iconTop));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a focused dialog button keeps a gap to its neighbour', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    for (const [open, focused, other] of [['restoreDefaultsDialog', 'continueRestoreDefaults', 'cancelRestoreDefaults'],
      ['restoreDefaultsDialog', 'cancelRestoreDefaults', 'continueRestoreDefaults']]) {
      const gap = await app.page.evaluate(({ dialog, focus, neighbour }) => {
        window[dialog]();
        document.getElementById(focus).focus();
        return new Promise((resolve) => setTimeout(() => {
          const a = document.getElementById(focus).getBoundingClientRect();
          const b = document.getElementById(neighbour).getBoundingClientRect();
          // The ring around the focused button is 4 px wide
          const result = Math.max(b.left - a.right, a.left - b.right) - 4;
          document.getElementById('cancelRestoreDefaults').click();
          resolve(result);
        }, 400));
      }, { dialog: open, focus: focused, neighbour: other });
      assert.ok(gap >= 6, focused + ': ' + gap);
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
