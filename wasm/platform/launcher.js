// Spotlight UI: the hero of the focused host or app, the chips of the host cards and of the header, the current settings
// row, the value tiles of the optimal settings dialog and the start screen of a stream. It only reads the state of
// index.js and of the page. It follows the 'mouseenter' event of mark() in navigation.js with one capturing listener,
// and ignores those of a real mouse pointer.

// Tell the stylesheet which screen shows: 'hosts', 'apps', 'settings', 'stream' or 'loading'
function setUiView(view) {
  if (document.body) {
    document.body.setAttribute('data-view', view);
  }
  if (view === 'hosts' || view === 'apps') {
    Launcher.refreshHeaderStatus();
    Launcher.refresh();
  }
}

const Launcher = (function() {
  const PLACEHOLDER_ART = /placeholder_(?:error|game)\.svg$/;
  const CODEC_NAMES = { H264: 'H.264', HEVC: 'HEVC', AV1: 'AV1' };
  // How long the focus rests on an app before the ambient light shows its box art, in milliseconds
  const AMBIENT_DELAY_MS = 300;
  let heroElement = null; // The last focused card of the host or app grid, which the hero shows, initial value is null
  let isAway = false; // Whether the focus left the cards for the header, a dialog or a menu, initial value is false
  let currentRow = null; // The settings row of the focused control, initial value is null
  let sampleCanvas = null; // The canvas that samples the colours of box art, initial value is null
  let ambientSource = ''; // The box art whose colours the ambient light of the hero shows, initial value is ''
  let ambientNext = null; // The box art that the ambient light shows next, while ambientTimer runs, initial value is null
  let ambientTimer = 0; // The timer of AMBIENT_DELAY_MS for ambientNext, initial value is 0

  function byId(id) {
    return document.getElementById(id);
  }

  function icon(name) {
    return '<svg class="icon" aria-hidden="true"><use xlink:href="#i-' + name + '"/></svg>';
  }

  // Change an element only for other content, so that the live region of the hero doesn't announce it again
  function setContent(id, value, isMarkup) {
    const element = byId(id);
    if (element && element.lastContent !== value) {
      element.lastContent = value;
      element[isMarkup ? 'innerHTML' : 'textContent'] = value;
    }
  }

  function chip(kind, label, iconName) {
    return '<span class="status-chip chip-' + kind + '">' + (iconName ? icon(iconName) : '<span class="dot"></span>') +
      escapeHTML(label) + '</span>';
  }

  function keyHint(keyLabel, keyIcon, label) {
    return '<span class="hint"><span class="keycap">' + (keyIcon ? icon(keyIcon) : escapeHTML(keyLabel)) + '</span>' +
      escapeHTML(label) + '</span>';
  }

  // Short name of a resolution value, e.g. '3840:2160' is 4K and '1920:1080' is 1080p
  function shortResolution(value) {
    const height = parseInt(String(value || '').split(':')[1], 10);
    if (!height) {
      return '';
    }
    return height >= 4320 ? '8K' : (height >= 2160 ? '4K' : height + 'p');
  }

  // 'running', 'online' (paired), 'locked' (not paired), 'offline', or 'unknown' before the first poll
  function hostState(host) {
    if (!host) {
      return 'add';
    }
    if (host.online === undefined || host.online === null) {
      return 'unknown';
    }
    if (!host.online) {
      return 'offline';
    }
    if (!host.paired) {
      return 'locked';
    }
    return host.currentGame && host.currentGame != 0 ? 'running' : 'online';
  }

  // All chips of a host for the hero, or the one that matters most for its card
  function hostChips(host, state, compact) {
    const chips = [];
    if (state === 'running') {
      chips.push(chip('running', t('RUNNING'), 'play'));
    }
    if (state === 'offline') {
      chips.push(chip('offline', t('OFFLINE')));
    } else if (state === 'locked' && compact) {
      chips.push(chip('locked', t('UNPAIRED'), 'lock'));
    } else if (state !== 'unknown') {
      chips.push(chip('online', t('ONLINE')));
      chips.push(host.paired ? chip('paired', t('PAIRED'), 'link') : chip('locked', t('UNPAIRED'), 'lock'));
    }
    return (compact ? chips.slice(0, 1) : chips).join('');
  }

  function hostCards() {
    return Array.prototype.slice.call(document.querySelectorAll('#host-grid > .host-container'));
  }

  function hostFromCard(card) {
    const match = card && card.id ? /^host-container-(.+)$/.exec(card.id) : null;
    return match && typeof hosts !== 'undefined' ? hosts[match[1]] : null;
  }

  // Whether box art is a landscape banner rather than a portrait cover (600 x 800 or 600 x 900)
  function isWide(art) {
    return !!art && art.naturalWidth > art.naturalHeight * 1.2;
  }

  function setHero(kind, state, content) {
    const hero = byId('launcher-hero');
    if (!hero) {
      return;
    }
    hero.setAttribute('data-kind', kind);
    hero.setAttribute('data-state', state);
    setContent('hero-overline', content.overline || '');
    setContent('hero-title', content.title || '');
    setContent('hero-chips', content.chips || '', true);
    setContent('hero-text', content.text || '');
    setContent('hero-hints', content.hints || '', true);
    const art = content.art || null;
    hero.classList.toggle('has-art', !!art);
    hero.classList.toggle('art-wide', isWide(art));
    const poster = byId('hero-poster');
    const source = art ? art.getAttribute('src') : '';
    if (poster && (poster.getAttribute('src') || '') !== source) {
      if (source) {
        poster.setAttribute('src', source);
      } else {
        poster.removeAttribute('src');
      }
    }
    // The ambient light follows other art, or art that had not loaded yet, once the focus rests: it fades out while the
    // focus moves, so that held keys don't repaint its large area at every step
    if (source !== (ambientNext === null ? ambientSource : ambientNext)) {
      const ambient = byId('hero-ambient');
      clearTimeout(ambientTimer);
      ambientNext = source;
      if (ambient) {
        ambient.classList.remove('is-painted');
      }
      ambientTimer = setTimeout(function() {
        ambientNext = null;
        ambientSource = paintAmbient(ambient, art) ? source : '';
      }, AMBIENT_DELAY_MS);
    }
  }

  // Averaged colours ('r, g, b') of the top, middle and bottom of the box art, drawn into 12 x 16 pixels and weighted
  // by alpha, or null when the art can't be read
  function artColours(art) {
    if (!art || !art.complete || !art.naturalWidth) {
      return null;
    }
    try {
      sampleCanvas = sampleCanvas || document.createElement('canvas');
      sampleCanvas.width = 12;
      sampleCanvas.height = 16;
      const context = sampleCanvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(art, 0, 0, 12, 16);
      const data = context.getImageData(0, 0, 12, 16).data;
      return [[0, 5], [5, 11], [11, 16]].map(function(band) {
        const sum = [0, 0, 0, 0];
        for (let i = band[0] * 48; i < band[1] * 48; i++) {
          sum[i % 4] += i % 4 === 3 ? data[i] : data[i] * data[i - i % 4 + 3];
        }
        const colour = sum.slice(0, 3).map(function(value) {
          return value / (sum[3] || 1);
        });
        // Lift dark averages, so that the light stays visible
        const lift = Math.min(1.8, 220 / (Math.max.apply(null, colour) || 220));
        return colour.map(function(value) {
          return Math.round(Math.min(255, value * Math.max(1, lift)));
        }).join(', ');
      });
    } catch (error) {
      console.warn('%c[launcher.js, artColours]', 'color: gray;', 'Cannot read the colours of the box art: ', error);
      return null;
    }
  }

  // Ambient light of the box art: style.css draws its colours (--a1 to --a3) as radial glows under a vignette
  function paintAmbient(element, art) {
    if (!element) {
      return false;
    }
    const colours = artColours(art);
    if (colours) {
      colours.forEach(function(colour, index) {
        element.style.setProperty('--a' + (index + 1), colour);
      });
    }
    element.classList.toggle('is-painted', !!colours);
    return !!colours;
  }

  function showHost(card) {
    const host = hostFromCard(card);
    if (!host) {
      // The Add Host card, the whole screen while no host is saved
      setHero('host', 'add', {
        overline: t('Moonlight Plus'),
        title: hostCards().length === 0 ? t('Find your gaming PC') : t('Add Host'),
        text: t('Moonlight finds PCs that run Sunshine or GeForce Experience on your network. You can also add one by its address.'),
        hints: keyHint(t('OK'), null, t('Add Host')),
      });
      return;
    }
    const state = hostState(host);
    const texts = {
      online: t('Ready to stream. Select it to see its apps and games.'),
      running: t('A game is running on this PC. Select it to resume.'),
      locked: t('Select it to pair this TV with the PC using a PIN.'),
      offline: t('This PC is not reachable. Turn it on, or wake it from its options.'),
      unknown: '',
    };
    let hints = '';
    if (state === 'online' || state === 'running') {
      hints = keyHint(t('OK'), null, t('Open'));
    } else if (state === 'locked') {
      hints = keyHint(t('OK'), null, t('Pair'));
    } else if (state === 'offline' && host.autoWolEnabled === true) {
      hints = keyHint(t('OK'), null, t('Wake PC'));
    }
    // UP reaches the options button from the first row of cards (Views.Hosts in navigation.js), the options key (CH+ or
    // Play/Pause, the key cap of the app menu hint) opens the menu from any row
    const firstRow = Array.prototype.indexOf.call(card.parentElement.children, card) < 5;
    hints += keyHint('', firstRow ? 'arrow-up' : 'more', t('Options'));
    setHero('host', state, {
      overline: host.address || '',
      title: host.hostname,
      chips: hostChips(host, state, false),
      text: texts[state],
      hints: hints,
    });
  }

  // Without a host card to show: a summary of the hosts, or the empty state while there is none
  function showHostSummary() {
    const list = hostCards().map(hostFromCard).filter(Boolean);
    if (list.length === 0) {
      showHost(null);
      return;
    }
    const states = list.map(hostState).join(' ');
    const offline = list.filter(function(host) {
      return host.online === false;
    }).length;
    const online = list.length - offline - (states.match(/unknown/g) || []).length;
    let state = offline === list.length ? 'offline' : 'unknown';
    if (/running/.test(states)) {
      state = 'running';
    } else if (online) {
      state = 'online';
    }
    setHero('host', state, {
      overline: t('Moonlight Plus'),
      title: t('Your gaming PCs'),
      chips: (online ? chip('online', t('%1$s ONLINE', online)) : '') + (offline ? chip('offline', t('%1$s OFFLINE', offline)) : ''),
      text: t('Select a PC to see its apps and games.'),
    });
  }

  // The box art image of an app card, or null while it loads or when there is none
  function artOf(card) {
    const image = card ? card.querySelector('img') : null;
    const source = image ? image.getAttribute('src') : '';
    return source && !PLACEHOLDER_ART.test(source) ? image : null;
  }

  function showApp(card) {
    const hostName = typeof api !== 'undefined' && api ? api.hostname : '';
    const count = document.querySelectorAll('#game-grid > .game-container').length;
    const overline = hostName + (count ? '  ·  ' + (typeof _n === 'function' ? _n('%1$s app', '%1$s apps', count) : count) : '');
    if (!card) {
      // No app card yet, e.g. while the list of another host loads
      setHero('app', 'idle', { overline: overline, title: hostName });
      return;
    }
    if (!/^game-container-/.test(card.id || '')) {
      // The illustration of an empty or failed app list
      const failed = /applist_error\.svg$/.test(card.getAttribute('src') || '');
      setHero('app', 'empty', {
        overline: hostName,
        title: failed ? t('Apps') : t('No apps yet'),
        text: failed ? t('Unable to retrieve your list of apps at this time. Please refresh the list of apps or try again later!')
          : t('Your list is currently empty. Please add your favorite apps to the list.'),
      });
      return;
    }
    const running = card.classList.contains('current-game-active');
    // A hidden app that shows after 'Show hidden apps' (menus.js)
    const hidden = card.classList.contains('app-hidden');
    setHero('app', running ? 'running' : 'idle', {
      overline: overline,
      title: card.getAttribute('aria-label') || '',
      chips: (running ? chip('running', t('RUNNING'), 'play') : '') + (hidden ? chip('hidden', t('Hidden'), 'eye-off') : ''),
      hints: keyHint(t('OK'), null, running ? t('Resume') : t('Play')),
      art: artOf(card),
    });
  }

  function currentView() {
    return document.body ? document.body.getAttribute('data-view') : '';
  }

  // Fade the bottom edge of the hero while the grid below is scrolled, so that the rows don't end in a hard cut
  function updateFade() {
    const hero = byId('launcher-hero');
    const grid = byId(currentView() === 'apps' ? 'game-grid' : 'host-grid');
    if (hero && grid) {
      hero.classList.toggle('is-scrolled', grid.scrollTop > 4);
    }
  }

  // Show the focused card in the hero, or the last one without key hints while the focus is elsewhere (header, dialogs,
  // menus). Without a card, the hosts screen shows a summary (or the empty state), the apps screen the host.
  function render() {
    const view = currentView();
    const card = heroElement && heroElement.parentElement ? heroElement : null;
    const hero = byId('launcher-hero');
    if (hero) {
      hero.classList.toggle('is-away', isAway);
    }
    if (view === 'apps') {
      showApp(card && card.parentElement.id === 'game-grid' ? card : null);
    } else if (view === 'hosts') {
      // The Add Host card only while it has the focus, as its text reads like the empty state
      if (card && card.parentElement.id === 'host-grid' && !(isAway && card.id === 'addHostContainer')) {
        showHost(card);
      } else {
        showHostSummary();
      }
    }
    updateFade();
  }

  // Light up the settings row of the focused control
  function showSettingsRow(element) {
    const row = element.closest('.setting-option');
    if (row === currentRow) {
      return;
    }
    if (currentRow) {
      currentRow.classList.remove('is-current');
    }
    currentRow = row;
    if (row) {
      row.classList.add('is-current');
    }
  }

  function onMark(event) {
    const element = event.target;
    // A real pointer that rests over the page while the grid scrolls sends its own events, which don't move the focus
    if (event.isTrusted || !element || element.nodeType !== 1 || !element.closest) {
      return;
    }
    // A card, or the options button inside a host card
    const card = element.closest('#host-grid > *, #game-grid > *');
    if (card) {
      heroElement = card;
      isAway = false;
      render();
    } else if (element.closest('.setting-option, .settings-category')) {
      showSettingsRow(element);
    } else if (!isAway) {
      isAway = true;
      render();
    }
  }

  // Show the title on app cards without box art, and the box art in the hero once it has loaded
  function onImageSettled(event) {
    const image = event.target;
    if (!image || image.tagName !== 'IMG') {
      return;
    }
    const card = image.parentElement;
    if (!card || !card.classList || !card.classList.contains('game-container')) {
      return;
    }
    card.classList.toggle('no-art', event.type === 'error' || PLACEHOLDER_ART.test(image.getAttribute('src') || ''));
    if (card === heroElement && currentView() === 'apps') {
      showApp(card);
    }
  }

  // Stream profile of the current settings in the header, e.g. '4K · 60 FPS · HEVC HDR'
  function refreshProfile() {
    const profile = byId('header-profile');
    const resolution = byId('selectResolution');
    const codecButton = byId('selectCodec');
    const frameRate = byId('selectFramerate');
    if (!profile || !resolution || !codecButton || !frameRate) {
      return;
    }
    const codec = codecButton.getAttribute('data-value');
    const hdr = codec !== 'H264' && !!document.querySelector('#hdrModeBtn.is-checked');
    const text = [shortResolution(resolution.getAttribute('data-value')), frameRate.getAttribute('data-value') + ' FPS',
      t(CODEC_NAMES[codec] || codec) + (hdr ? ' ' + t('HDR') : '')].join(' · ');
    setContent('header-profile', icon('video') + escapeHTML(text), true);
  }

  return {
    // Add the icon tile, the chips and the options icon to a new host card (addHostToGrid())
    decorateHostCard: function(container, host) {
      const cell = container.firstElementChild;
      if (cell && !cell.querySelector('.host-tile')) {
        cell.insertAdjacentHTML('afterbegin', '<div class="host-tile" aria-hidden="true">' + icon('pc') + '</div>');
        cell.insertAdjacentHTML('beforeend', '<div class="host-chips" aria-hidden="true"></div>');
      }
      const menu = container.querySelector('.host-menu');
      if (menu && !menu.querySelector('svg')) {
        menu.innerHTML = icon('more');
      }
      this.renderHostStatus(host, container);
    },
    // Show the state of a host on its card and in the hero (updateHostStatusIndicator())
    renderHostStatus: function(host, container) {
      const card = container || byId('host-container-' + host.serverUid);
      if (!card) {
        return;
      }
      const state = hostState(host);
      card.setAttribute('data-state', state);
      const chips = card.querySelector('.host-chips');
      if (chips) {
        chips.innerHTML = hostChips(host, state, true);
      }
      if (currentView() === 'hosts') {
        render();
      }
    },
    // Network connection of the TV and the stream profile in the header
    refreshHeaderStatus: function() {
      refreshProfile();
      const status = byId('header-status');
      if (!status || typeof getActiveConnectionType !== 'function') {
        return;
      }
      let type = 'unknown';
      try {
        type = getActiveConnectionType();
      } catch (error) {
        type = 'unknown';
      }
      if (type === 'wifi') {
        status.innerHTML = icon('wifi') + escapeHTML(t('Wi-Fi'));
      } else if (type === 'ethernet') {
        status.innerHTML = icon('ethernet') + escapeHTML(t('Ethernet'));
      } else {
        status.innerHTML = '';
      }
    },
    // Fill the value tiles of the optimal settings dialog from the settings it applies (deriveOptimalSettings())
    fillValueTiles: function(container, settings) {
      if (!container || !settings) {
        return;
      }
      const tiles = [
        [t('Video resolution'), shortResolution(settings.resolution), String(settings.resolution).replace(':', ' x ')],
        [t('Video frame rate'), settings.frameRate, 'FPS'],
        [t('Video bitrate'), settings.bitrate, 'Mbps'],
        [t('Video codec'), t(CODEC_NAMES[settings.videoCodec] || settings.videoCodec), settings.hdrMode ? t('HDR') : t('no HDR')],
      ];
      container.innerHTML = tiles.map(function(tile) {
        return '<div class="value-tile"><span class="value-label">' + escapeHTML(tile[0]) + '</span><span class="value-number">' +
          escapeHTML(tile[1]) + '</span><span class="value-unit">' + escapeHTML(tile[2]) + '</span></div>';
      }).join('');
    },
    // Fill the start screen of a stream: the box art as a poster, the title and the host (startGame())
    prepareStart: function(host, appId, title) {
      const art = artOf(byId('game-container-' + appId));
      const poster = byId('launch-poster');
      if (poster) {
        poster.setAttribute('src', art ? art.getAttribute('src') : 'static/res/placeholder_game.svg');
        poster.classList.toggle('is-wide', isWide(art));
      }
      paintAmbient(byId('launch-backdrop'), art);
      setContent('launch-title', title || '');
      setContent('launch-host', host && host.hostname ? host.hostname : '');
    },
    // Show the hero again, e.g. when its screen shows or after a change of the language
    refresh: function() {
      render();
      refreshProfile();
    },
    init: function() {
      document.addEventListener('mouseenter', onMark, true);
      const game = byId('game-grid');
      if (game) {
        game.addEventListener('load', onImageSettled, true);
        game.addEventListener('error', onImageSettled, true);
      }
      ['host-grid', 'game-grid'].forEach(function(id) {
        const grid = byId(id);
        if (grid) {
          grid.addEventListener('scroll', updateFade, { passive: true });
          // Added or deleted hosts change the summary; a rebuilt app list removes the card of the hero
          if (typeof MutationObserver === 'function') {
            new MutationObserver(function() {
              if (currentView() === (id === 'host-grid' ? 'hosts' : 'apps')) {
                render();
              }
            }).observe(grid, { childList: true });
          }
        }
      });
      // The profile chip follows the data-value of the menus and the is-checked class of the HDR switch, whoever changes
      // them (the user, Restore Defaults, the optimal settings)
      if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver(refreshProfile);
        ['selectResolution', 'selectFramerate', 'selectCodec', 'hdrModeBtn'].forEach(function(id) {
          if (byId(id)) {
            observer.observe(byId(id), { attributes: true, attributeFilter: ['data-value', 'class'] });
          }
        });
      }
      refreshProfile();
      if (window.i18n && typeof window.i18n.onRefresh === 'function') {
        window.i18n.onRefresh(function() {
          Launcher.refresh();
          Launcher.refreshHeaderStatus();
        });
      }
    },
  };
})();

if (typeof document !== 'undefined' && document.addEventListener) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      Launcher.init();
    });
  } else {
    Launcher.init();
  }
}
