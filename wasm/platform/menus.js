// The Stream Menu and the menu of an app tile.
//
// The Stream Menu opens during a stream with the Play/Pause key of the remote (remoteControllerHandler() in
// remote_controller.js) or by holding Select + Start on a gamepad for 1 second (UpdateStreamMenuCombo() in
// wasm/gamepad.cpp, which posts 'streamMenuRequested'). While it is open, the WebAssembly module sends the PC every
// controller released (setStreamMenuOpen()), the keys of the remote and the keyboard stay in the UI (initSpecialKeys()
// in index.js), and the gamepad polling of the menus runs, so the remote and the gamepads move through the menu as in
// the other menus (Views.StreamMenu in navigation.js). The video keeps playing behind it.
//
// The menu of an app tile opens in the app grid with CH+ or Play/Pause on the remote and Select on a gamepad
// (Views.Apps in navigation.js): Start or Resume, Quit, Hide or show the app, and Show hidden apps. Hidden apps are
// stored per host in localStorage and matched by their ID or their title, since Sunshine can give an app a new ID when
// its entry changes.
//
// A Stream Menu on Play/Pause comes from the fork of fidoboy (moonlight-tizen-ac3, GPL-3.0), which took it from
// Diogo8500 (brightcraft/moonlight-tizen pull request 177). The key combinations are ported from there (see
// buildKeyComboEvents()); the menus, the gamepad combo and the handling of the input here are new.

// Whether the Stream Menu is open
var isStreamMenuOpen = false;
// Whether the mouse emulation of the stream is on, from the 'mouseEmulationOn' and 'mouseEmulationOff' messages
var streamMouseEmulationActive = false;
// Whether the user chose 'Disconnect and quit the app on the PC', so the app is quit once the stream ended (messages.js)
var quitAppAfterStream = false;
// Whether the stream had the pointer locked when the Stream Menu opened, so that Resume locks it again
var streamMenuPointerWasLocked = false;
// Host whose hidden apps the app grid shows, dimmed, after 'Show hidden apps', or null
var showHiddenAppsHost = null;
// Number of apps of the shown host that are hidden, counted when the app grid is built
var appGridHiddenCount = 0;
// Host and app that the app menu is open for, or null
var appMenuTarget = null;

// Keys that the Stream Menu sends to the PC: Windows virtual-key codes, pressed in this order and released in reverse
const STREAM_MENU_KEYS = {
  streamMenuKeyWin: [0x5B], // Left Windows
  streamMenuKeyAltTab: [0xA4, 0x09], // Left Alt + Tab
  streamMenuKeyAltF4: [0xA4, 0x73], // Left Alt + F4
  streamMenuKeyEsc: [0x1B], // Esc
  // The usual key of Windows games and emulators to switch between fullscreen and a window. The stream menu of
  // Diogo8500 (brightcraft/moonlight-tizen pull request 177, 973a61b) offers F11 for this.
  streamMenuKeyAltEnter: [0xA4, 0x0D], // Left Alt + Enter
};
// The modifier flag of each modifier key (MODIFIER_SHIFT, MODIFIER_CTRL, MODIFIER_ALT and MODIFIER_META of
// moonlight-common-c), for the keys that are held while the next ones go down
const KEYBOARD_MODIFIER_FLAGS = { 0xA0: 0x01, 0xA1: 0x01, 0xA2: 0x02, 0xA3: 0x02, 0xA4: 0x04, 0xA5: 0x04, 0x5B: 0x08, 0x5C: 0x08 };
// KEY_ACTION_DOWN and KEY_ACTION_UP of moonlight-common-c
const KEYBOARD_ACTION_DOWN = 0x03;
const KEYBOARD_ACTION_UP = 0x04;
// Key of localStorage that holds the hidden apps of a host, followed by its server UID
const HIDDEN_APPS_KEY_PREFIX = 'hiddenApps_';

// List the keyboard events that press a key combination on the PC: the keys go down in order, each with the modifiers
// held at that point, and come up in reverse order with the modifiers that are still held, so that no key and no
// modifier stays held on the PC. Ported from sendKeyCombinationToHost() of the fork of fidoboy (moonlight-tizen-ac3,
// GPL-3.0).
function buildKeyComboEvents(keyCodes) {
  const events = [];
  let modifiers = 0;
  keyCodes.forEach((keyCode) => {
    modifiers |= KEYBOARD_MODIFIER_FLAGS[keyCode] || 0;
    events.push({ keyCode: keyCode, action: KEYBOARD_ACTION_DOWN, modifiers: modifiers });
  });
  keyCodes.slice().reverse().forEach((keyCode) => {
    modifiers &= ~(KEYBOARD_MODIFIER_FLAGS[keyCode] || 0);
    events.push({ keyCode: keyCode, action: KEYBOARD_ACTION_UP, modifiers: modifiers });
  });
  return events;
}

// Press a key combination on the PC, like sendEscapeKeyToHost() in index.js
function sendKeyComboToHost(keyCodes) {
  buildKeyComboEvents(keyCodes).forEach((event) => {
    Module.sendKeyboardEvent(0x80 << 8 | event.keyCode, event.action, event.modifiers);
  });
}

// Check if one of the dialogs of the page shows, which the menus don't open over
function isDialogShown() {
  return $('.dialog-overlay:visible, .overlay-menu-backdrop:visible').length > 0;
}

// The entries of an overlay menu that show, in their order on the screen
function getOverlayMenuItems(menuId) {
  const menu = document.getElementById(menuId);
  if (!menu) {
    return [];
  }
  return Array.prototype.filter.call(menu.querySelectorAll('.overlay-menu-item'), (item) => !item.hidden);
}

// Tell the WebAssembly module that the Stream Menu opened or closed, so that it stops or resumes the controller input
// of the PC (setStreamMenuOpen() in wasm/gamepad.cpp)
function setStreamMenuInputPaused(paused) {
  if (typeof Module !== 'undefined' && typeof Module.setStreamMenuOpen === 'function') {
    Module.setStreamMenuOpen(paused);
  }
}

// Show the state of an entry of a menu: a text, marked as on or not
function setOverlayMenuText(valueId, text, isOn) {
  const value = document.getElementById(valueId);
  if (value) {
    value.textContent = text;
    value.classList.toggle('is-on', isOn);
  }
}

// Show the state of a switch entry of a menu
function setOverlayMenuValue(valueId, isOn) {
  setOverlayMenuText(valueId, isOn ? t('On') : t('Off'), isOn);
}

// The name of a level of the performance statistics (PERFORMANCE_STATS_* in index.js)
function getPerformanceStatsLevelName(level) {
  return level === 2 ? t('Full') : level === 1 ? t('Compact') : t('Off');
}

// Select an entry of the Stream Menu again after the entries that show changed while it is open, or the last entry
// before it that shows when it doesn't show any more. Otherwise the index of the selection would point at the entry
// after it, which OK presses without it being marked.
function reselectStreamMenuEntry(entry) {
  const entries = getOverlayMenuItems('streamMenu');
  let index = entries.indexOf(entry);
  if (index < 0) {
    const before = entries.filter((item) => entry.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING);
    index = Math.max(0, before.length - 1);
  }
  if (Views.StreamMenu.view.index === index && entries[index] === entry) {
    return;
  }
  unmark(entry);
  Views.StreamMenu.view.index = index;
  mark(entries[index]);
  focusElement(entries[index]);
}

// Fill the Stream Menu with the current state of the stream: the app and host, the level of the performance statistics
// (Off, Compact or Full), whether the mouse emulation is on, and the mouse emulation entry only while a controller is
// connected or the mouse emulation is on. When that entry goes while the menu shows, e.g. after the mouse emulation was
// turned off on it and no controller is connected any more, the selection moves to the entry before it.
function updateStreamMenu() {
  const host = streamLaunchHost || api;
  const subtitle = [streamLaunchAppTitle, host && host.hostname ? host.hostname : ''].filter((text) => !!text).join(' · ');
  $('#streamMenuSubtitle').text(subtitle);
  const statsLevel = getPerformanceStatsLevel();
  setOverlayMenuText('streamMenuStatsValue', getPerformanceStatsLevelName(statsLevel), statsLevel !== 0);
  setOverlayMenuValue('streamMenuMouseValue', streamMouseEmulationActive);
  const mouseEntry = document.getElementById('streamMenuMouse');
  if (mouseEntry) {
    // The selected entry while the menu shows; openStreamMenu() selects the first entry after this
    const selected = $('#streamMenuOverlay').is(':visible') ? Views.StreamMenu.view.current() : null;
    mouseEntry.hidden = !(streamMouseEmulationActive || Controller.getConnectedGamepads().length > 0);
    if (selected) {
      reselectStreamMenuEntry(selected);
    }
  }
}

// Keep the mouse from taking the focus off the Stream Menu (Navigation leaves the menus on a mouse move), as the fork
// of fidoboy does for its stream menu
function stopStreamMenuMouseMove(e) {
  e.stopPropagation();
}

// Keep the buttons and the wheel of a mouse away from the stream while the Stream Menu is open. The menu covers the
// video, but a locked pointer sends its events to the video until the lock ends, and a click on the video would lock
// the pointer for the stream again (HandleMouseDown() in wasm/input.cpp).
const STREAM_MENU_POINTER_EVENTS = ['mousedown', 'mouseup', 'wheel'];
function stopStreamMenuPointerInput(e) {
  if (e.target && e.target.id === 'wasm_module') {
    e.preventDefault();
    e.stopPropagation();
  }
}

// Open the Stream Menu over the running stream. It only opens once the video of the stream shows, and not over a
// dialog.
function openStreamMenu() {
  if (isStreamMenuOpen) {
    return;
  }
  if (isInGame !== true || !wasmSessionStarted || !isStreamConnected || isDialogShown()) {
    console.log('%c[menus.js, openStreamMenu]', 'color: teal;', 'Not opening the Stream Menu without a running stream.');
    return;
  }
  console.log('%c[menus.js, openStreamMenu]', 'color: teal;', 'Opening the Stream Menu.');
  isStreamMenuOpen = true;
  // Stop the controller input of the PC first, and release the pointer, which would move the mouse of the PC. The end
  // of the pointer lock also releases the keys and mouse buttons that the PC still holds (MouseLockLost() in
  // wasm/input.cpp), since their releases stay in the UI from now on.
  setStreamMenuInputPaused(true);
  streamMenuPointerWasLocked = !!document.pointerLockElement;
  if (streamMenuPointerWasLocked && typeof document.exitPointerLock === 'function') {
    document.exitPointerLock();
  }
  window.addEventListener('mousemove', stopStreamMenuMouseMove, true);
  STREAM_MENU_POINTER_EVENTS.forEach((type) => window.addEventListener(type, stopStreamMenuPointerInput, true));

  updateStreamMenu();
  $('#streamMenuOverlay').css('display', 'flex');
  Views.StreamMenu.view.index = 0;
  Navigation.start();
  Navigation.push(Views.StreamMenu);
  // Give the menu the focus at once, so that the first key already moves in it
  Navigation.switch();
  // Read the gamepads in the menu. The polling takes a fresh snapshot, so the held Select + Start don't press anything.
  stopRepeatAction();
  gamepadAxisDirections = {};
  Controller.startWatching();
}

// Close the Stream Menu. With resume, the stream gets the focus back (and the pointer, if it had it); without, the
// stream ends or ended anyway.
function closeStreamMenu(resume) {
  if (!isStreamMenuOpen) {
    return;
  }
  console.log('%c[menus.js, closeStreamMenu]', 'color: teal;', resume ? 'Closing the Stream Menu and resuming the stream.' : 'Closing the Stream Menu.');
  isStreamMenuOpen = false;
  // The WebAssembly module reads the gamepads again
  Controller.stopWatching();
  stopRepeatAction();
  gamepadAxisDirections = {};
  clearTimeout(navigationTimeout);
  Navigation.pop();
  Navigation.stop();
  window.removeEventListener('mousemove', stopStreamMenuMouseMove, true);
  STREAM_MENU_POINTER_EVENTS.forEach((type) => window.removeEventListener(type, stopStreamMenuPointerInput, true));
  $('#streamMenuOverlay').css('display', 'none');
  // The buttons that are still held reach the PC only once they were released (wasm/gamepad.cpp)
  setStreamMenuInputPaused(false);

  if (resume && isInGame === true) {
    const videoElement = document.getElementById('wasm_module');
    videoElement.focus();
    // Lock the pointer again like the Back key does (initSpecialKeys() in index.js): a mouse button press on an
    // unlocked pointer only locks it
    if (streamMenuPointerWasLocked && !document.pointerLockElement) {
      videoElement.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window, clientX: 0, clientY: 0
      }));
    }
  }
  streamMenuPointerWasLocked = false;
}

// Open the Stream Menu, or close it and resume the stream: the Play/Pause key of the remote
function toggleStreamMenu() {
  if (isStreamMenuOpen) {
    closeStreamMenu(true);
  } else {
    openStreamMenu();
  }
}

// Run the action of an entry of the Stream Menu
function runStreamMenuAction(id) {
  if (!isStreamMenuOpen) {
    return;
  }
  console.log('%c[menus.js, runStreamMenuAction]', 'color: teal;', 'Stream Menu entry: ' + id);
  if (id === 'streamMenuResume') {
    closeStreamMenu(true);
  } else if (id === 'streamMenuStats') {
    // The next level (Off, Compact, Full) shows behind the menu; the setting follows the module synchronously
    // ('StatLevelMsg: ' in messages.js)
    Module.toggleStats();
    updateStreamMenu();
  } else if (id === 'streamMenuMouse') {
    // The input thread of the module switches it on its next poll and reports it ('mouseEmulationOn' or 'Off')
    if (typeof Module.toggleMouseEmulation === 'function') {
      Module.toggleMouseEmulation();
    }
  } else if (STREAM_MENU_KEYS[id]) {
    // Back to the stream, where the result of the keys shows
    closeStreamMenu(true);
    sendKeyComboToHost(STREAM_MENU_KEYS[id]);
  } else if (id === 'streamMenuDisconnect' || id === 'streamMenuQuit') {
    quitAppAfterStream = id === 'streamMenuQuit';
    closeStreamMenu(false);
    Module.stopStream();
  }
}

// Read the hidden apps of a host: a list of { id, title }
function loadHiddenApps(serverUid) {
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_APPS_KEY_PREFIX + serverUid) || '[]');
    return Array.isArray(stored) ? stored.filter((entry) => entry && (entry.id !== undefined || entry.title)) : [];
  } catch (error) {
    console.warn('%c[menus.js, loadHiddenApps]', 'color: teal;', 'Warning: Failed to read the hidden apps of ' + serverUid + ': ' + error);
    return [];
  }
}

// Store the hidden apps of a host, or forget them for an empty list
function saveHiddenApps(serverUid, hiddenApps) {
  try {
    if (hiddenApps.length === 0) {
      localStorage.removeItem(HIDDEN_APPS_KEY_PREFIX + serverUid);
    } else {
      localStorage.setItem(HIDDEN_APPS_KEY_PREFIX + serverUid, JSON.stringify(hiddenApps));
    }
  } catch (error) {
    console.warn('%c[menus.js, saveHiddenApps]', 'color: teal;', 'Warning: Failed to store the hidden apps of ' + serverUid + ': ' + error);
  }
}

// Check if an app is hidden: an entry has its ID or its title
function isAppHidden(hiddenApps, app) {
  return hiddenApps.some((entry) => String(entry.id) === String(app.id) || (!!entry.title && entry.title === app.title));
}

// Return the hidden apps with an app hidden, or shown again (every entry with its ID or title is removed)
function setAppHidden(hiddenApps, app, hidden) {
  const others = hiddenApps.filter((entry) => !isAppHidden([entry], app));
  return hidden ? others.concat([{ id: String(app.id), title: app.title }]) : others;
}

// Decide which apps the app grid shows, as a list of { app, hidden } in the order of the list: the apps that aren't
// hidden, the hidden ones as well after 'Show hidden apps', and the running app in any case, so that it can be resumed
// and quit. When every app is hidden, all of them show, so that the grid is never empty and an app menu can show them
// again.
function selectGridApps(appList, hiddenApps, showHidden, currentGame) {
  const entries = appList.map((app) => ({ app: app, hidden: isAppHidden(hiddenApps, app) }));
  const everyAppHidden = entries.length > 0 && entries.every((entry) => entry.hidden);
  return entries.filter((entry) => !entry.hidden || showHidden || everyAppHidden ||
    (!!currentGame && String(entry.app.id) === String(currentGame)));
}

// Name the entries of the app menu, in their order, for an app that is running or not, hidden or not, on a host with
// hiddenCount hidden apps, whose hidden apps show or not
function getAppMenuEntries(state) {
  const entries = [state.running ? 'appMenuResume' : 'appMenuStart'];
  if (state.running) {
    entries.push('appMenuQuit');
  }
  entries.push(state.hidden ? 'appMenuUnhide' : 'appMenuHide');
  if (state.hiddenCount > 0 || state.showHidden) {
    entries.push('appMenuShowHidden');
  }
  entries.push('appMenuClose');
  return entries;
}

// Mark a tile of the app grid as the running app or as a hidden app, with a badge that a theme can restyle
function setAppTileBadge(appBox, kind, shown) {
  const className = 'app-badge-' + kind;
  let badge = appBox.querySelector('.' + className);
  if (shown && !badge) {
    badge = document.createElement('span');
    badge.className = 'app-badge ' + className;
    // A translation pass translates it again (i18n.js)
    badge.setAttribute('data-i18n', kind === 'running' ? 'Running' : 'Hidden');
    badge.textContent = kind === 'running' ? t('Running') : t('Hidden');
    appBox.appendChild(badge);
  } else if (!shown && badge) {
    badge.parentNode.removeChild(badge);
  }
  appBox.classList.toggle(kind === 'running' ? 'current-game-active' : 'app-hidden', shown);
}

// Open the menu of an app tile of the app grid
function openAppMenu(appBox) {
  if (!appBox || !appBox.classList || !appBox.classList.contains('game-container') || !api || isDialogShown()) {
    return;
  }
  const host = api;
  const app = { id: appBox.getAttribute('data-app-id'), title: appBox.getAttribute('aria-label') || '' };
  const running = host.currentGame != 0 && String(host.currentGame) === String(app.id);
  const hidden = isAppHidden(loadHiddenApps(host.serverUid), app);
  const showHidden = showHiddenAppsHost === host.serverUid;
  const entries = getAppMenuEntries({ running: running, hidden: hidden, hiddenCount: appGridHiddenCount, showHidden: showHidden });
  console.log('%c[menus.js, openAppMenu]', 'color: teal;', 'Opening the menu of app ' + app.id + ' (' + app.title + ') with: ' + entries.join(', '));
  appMenuTarget = { host: host, app: app, appBox: appBox };

  $('#appMenuTitle').text(app.title);
  $('#appMenuSubtitle').text(running ? t('Running on %1$s', host.hostname) : (hidden ? t('Hidden') : host.hostname));
  // The stylesheet marks the menu of the running app
  $('#appMenu').toggleClass('is-running', running);
  $('#appMenuShowHiddenLabel').text(showHidden ? t('Hide hidden apps') : t('Show hidden apps (%1$s)', appGridHiddenCount));
  Array.prototype.forEach.call(document.querySelectorAll('#appMenu .overlay-menu-item'), (item) => {
    item.hidden = entries.indexOf(item.id) < 0;
  });

  $('#appMenuOverlay').css('display', 'flex');
  isDialogOpen = true;
  Views.AppMenu.view.index = 0;
  Navigation.push(Views.AppMenu);
  Navigation.switch();
}

// Close the app menu and return to the app grid
function closeAppMenu() {
  if (!appMenuTarget) {
    return;
  }
  appMenuTarget = null;
  $('#appMenuOverlay').css('display', 'none');
  isDialogOpen = false;
  Navigation.pop();
  // Keep the row of the tile in view
  Navigation.switch();
}

// Build the app grid of a host again, e.g. after an app was hidden, and select the tile of an app, or the one at the
// same place if it doesn't show anymore
function refreshAppGrid(host, appId) {
  const previousIndex = Views.Apps.view.index;
  showApps(host).then(() => {
    const tiles = Views.Apps.view.func();
    let index = -1;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i].id === 'game-container-' + appId) {
        index = i;
        break;
      }
    }
    Views.Apps.view.index = index >= 0 ? index : Math.max(0, Math.min(previousIndex, tiles.length - 1));
    Navigation.switch();
    if (!isDialogOpen) {
      Navigation.change(Views.Apps);
    }
  }, (error) => {
    console.error('%c[menus.js, refreshAppGrid]', 'color: teal;', 'Error: Failed to show the apps of ' + host.hostname + ': ' + error);
  });
}

// Run the action of an entry of the app menu
function runAppMenuAction(id) {
  const target = appMenuTarget;
  if (!target) {
    return;
  }
  console.log('%c[menus.js, runAppMenuAction]', 'color: teal;', 'App menu entry ' + id + ' for app ' + target.app.id);
  closeAppMenu();
  const host = target.host;
  const app = target.app;
  if (id === 'appMenuStart' || id === 'appMenuResume') {
    // The same as OK on the tile: start the app, resume it when it runs, or offer to quit the app that runs
    clickElement(target.appBox);
  } else if (id === 'appMenuQuit') {
    quitAppDialog();
  } else if (id === 'appMenuHide' || id === 'appMenuUnhide') {
    const hide = id === 'appMenuHide';
    saveHiddenApps(host.serverUid, setAppHidden(loadHiddenApps(host.serverUid), app, hide));
    if (hide) {
      snackbarLogLong('%1$s is hidden. Choose "Show hidden apps" in the menu of an app to see it again.', app.title);
    } else {
      snackbarLog('%1$s shows again.', app.title);
    }
    // The tiles of Smart Hub leave out the hidden apps as well
    if (typeof updatePreviewData === 'function') {
      updatePreviewData();
    }
    refreshAppGrid(host, app.id);
  } else if (id === 'appMenuShowHidden') {
    showHiddenAppsHost = showHiddenAppsHost === host.serverUid ? null : host.serverUid;
    refreshAppGrid(host, app.id);
  }
}

// Forget the hidden apps of a host that was deleted
function forgetHiddenApps(serverUid) {
  saveHiddenApps(serverUid, []);
  if (showHiddenAppsHost === serverUid) {
    showHiddenAppsHost = null;
  }
}

// Connect the entries of both menus to their actions
function attachOverlayMenuListeners() {
  $('#streamMenu .overlay-menu-item').on('click', function() {
    runStreamMenuAction(this.id);
  });
  $('#appMenu .overlay-menu-item').on('click', function() {
    runAppMenuAction(this.id);
  });
}
