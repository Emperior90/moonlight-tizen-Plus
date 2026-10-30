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
//
// Its bitrate entry changes the bitrate in steps of 5 Mbps with LEFT and RIGHT, and OK reconnects the stream with it
// (restartStreamWithBitrate() in index.js), as StreamLight does for its stream settings. 'Type text…' opens a text field
// for the keyboard of the TV, whose text goes to the PC as Unicode (sendText() of wasm/input.cpp), like the keyboard of
// the game menu of Artemis and of StreamLight 8.0.0.

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
// The apps of the host that the app grid was built for last, all of them in its order: { serverUid, apps }, or null
var appGridApps = null;
// Host and app that the app menu is open for, or null
var appMenuTarget = null;
// The bitrate in Mbps that the bitrate entry of the Stream Menu shows, which starts at the bitrate of the stream
var streamMenuBitrateMbps = 0;
// Whether the text panel of 'Type text…' shows in place of the entries of the Stream Menu
var isStreamTextOpen = false;

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
// Keys of localStorage that hold the hidden apps, the favorites and the recently played apps of a host, followed by its
// server UID
const HIDDEN_APPS_KEY_PREFIX = 'hiddenApps_';
const FAVORITE_APPS_KEY_PREFIX = 'favoriteApps_';
const RECENT_APPS_KEY_PREFIX = 'recentApps_';
// How many recently played apps a host keeps, as in the library of the fork of samirmartins (moonlight-tizen, 97bfe5c)
const RECENT_APPS_MAX = 20;
// The orders of the setting 'Sort the list of apps' (index.js), the first one being the default: by title from A to Z
// or Z to A, the recently played apps first, or as the host lists them (e.g. the order that Apollo can set)
const APP_SORT_ORDERS = ['az', 'za', 'recent', 'host'];
// The step of the bitrate entry of the Stream Menu in Mbps, which is also its lowest bitrate
const STREAM_MENU_BITRATE_STEP = 5;
// The answers of sendText() of the WebAssembly module (kTextInput* of wasm/text_input.hpp), which checkStreamText()
// gives as well
const TEXT_INPUT_OK = 0;
const TEXT_INPUT_NO_STREAM = -1;
const TEXT_INPUT_EMPTY = -2;
const TEXT_INPUT_TOO_LONG = -3;
const TEXT_INPUT_INVALID = -4;
const TEXT_INPUT_NOT_SENT = -5;
// The longest text in UTF-8 bytes that goes to the PC at once (kTextInputMaxBytes of wasm/text_input.hpp)
const TEXT_INPUT_MAX_BYTES = 1024;
// The keys that the text panel handles itself while its field takes the text: Enter (of a keyboard) and the Done key of
// the keyboard of the TV send the text, RETURN, its Cancel key and Esc go back to the Stream Menu, DOWN and Tab move to
// the buttons. The keyboard of the TV sends 65376 for Done and 65385 for Cancel (Samsung's guide to the IME).
const STREAM_TEXT_SEND_KEYS = [13, 65376];
const STREAM_TEXT_CANCEL_KEYS = [10009, 65385, 27];
const STREAM_TEXT_LEAVE_KEYS = [40, 9];
// The keys of the remote that keep their action in the Stream Menu while the field takes the text: the coloured keys,
// Play/Pause, Play, Pause and CH+/CH-. Every other key goes to the field (the keys of the keyboard of the TV, a USB
// keyboard and the number keys of the remote).
const STREAM_TEXT_REMOTE_KEYS = [403, 404, 405, 406, 10252, 415, 19, 427, 428];

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

// The lowest and the highest bitrate of the bitrate entry of the Stream Menu in Mbps: 5 Mbps up to the decoder cap of
// the TV (getDecoderCapMbps() in tv_profile.js)
function getStreamMenuBitrateRange() {
  return { min: STREAM_MENU_BITRATE_STEP, max: getDecoderCapMbps(tvCapabilities) };
}

// The bitrate after a press of LEFT (direction -1) or RIGHT (1) on the bitrate entry: the next multiple of 5 Mbps within
// the range. A bitrate above the range (chosen with the slider of the settings) only goes down, to the highest bitrate of
// the range, and one below it only goes up.
function stepStreamBitrate(mbps, direction, range) {
  const current = Number(mbps);
  if (direction > 0 ? current >= range.max : current <= range.min) {
    return current;
  }
  const next = direction > 0 ? Math.floor(current / STREAM_MENU_BITRATE_STEP) * STREAM_MENU_BITRATE_STEP + STREAM_MENU_BITRATE_STEP :
    Math.ceil(current / STREAM_MENU_BITRATE_STEP) * STREAM_MENU_BITRATE_STEP - STREAM_MENU_BITRATE_STEP;
  return Math.min(range.max, Math.max(range.min, next));
}

// Show the bitrate of the bitrate entry: the arrows of LEFT and RIGHT, dimmed at a limit, and, while it differs from the
// bitrate of the stream, the note that OK reconnects. A note given replaces it, e.g. the hint after OK on an unchanged
// bitrate.
function showStreamMenuBitrate(note) {
  const range = getStreamMenuBitrateRange();
  const changed = streamMenuBitrateMbps !== streamBitrateMbps;
  $('#streamMenuBitrateValue').text(streamMenuBitrateMbps + ' Mbps').toggleClass('is-pending', changed);
  $('#streamMenuBitrateLower').toggleClass('is-limit', stepStreamBitrate(streamMenuBitrateMbps, -1, range) === streamMenuBitrateMbps);
  $('#streamMenuBitrateHigher').toggleClass('is-limit', stepStreamBitrate(streamMenuBitrateMbps, 1, range) === streamMenuBitrateMbps);
  $('#streamMenuBitrateNote').text(note || (changed ? t('OK: reconnect (now %1$s Mbps)', streamBitrateMbps) : ''));
}

// Change the bitrate of the bitrate entry with LEFT (-1) or RIGHT (1); OK applies it (applyStreamMenuBitrate())
function changeStreamMenuBitrate(direction) {
  streamMenuBitrateMbps = stepStreamBitrate(streamMenuBitrateMbps, direction, getStreamMenuBitrateRange());
  showStreamMenuBitrate();
}

// Reconnect the stream with the bitrate of the bitrate entry, which becomes the bitrate setting, as if it was chosen with
// the slider of the settings. Nothing happens to an unchanged bitrate except a hint how to change it.
function applyStreamMenuBitrate() {
  const mbps = streamMenuBitrateMbps;
  if (mbps === streamBitrateMbps) {
    showStreamMenuBitrate(t('Change it with LEFT and RIGHT'));
    return;
  }
  $('#bitrateSlider')[0].MaterialSlider.change(String(mbps));
  setAutoAdjustBitrate(false);
  saveBitrate();
  restartStreamWithBitrate(mbps);
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
    // The selected entry while the menu shows; openStreamMenu() selects the first entry after this, and the text panel
    // of 'Type text…' keeps the focus in its field (cancelStreamText() selects the entry again)
    const selected = $('#streamMenuOverlay').is(':visible') && !isStreamTextOpen ? Views.StreamMenu.view.current() : null;
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
  streamMenuBitrateMbps = streamBitrateMbps;
  showStreamMenuBitrate();
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
  // The text panel of 'Type text…' belongs to the menu, and its text is dropped
  if (isStreamTextOpen) {
    hideStreamText();
    Navigation.pop();
  }
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
  } else if (id === 'streamMenuBitrate') {
    applyStreamMenuBitrate();
  } else if (id === 'streamMenuText') {
    openStreamText();
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

// Check a text for the PC as sendText() of the WebAssembly module does (CheckTextInput() of wasm/text_input.hpp), so that
// the text panel can say what is wrong before anything is sent: TEXT_INPUT_OK, or TEXT_INPUT_EMPTY, TEXT_INPUT_TOO_LONG
// (more than 1024 bytes of UTF-8) or TEXT_INPUT_INVALID (a lone surrogate, which the module couldn't tell from a valid
// character since the string conversion of Emscripten 1.39 joins it with the next one, or a control character: line
// breaks and Tab go to the PC as keys, not as text)
function checkStreamText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return TEXT_INPUT_EMPTY;
  }
  try {
    encodeURIComponent(text);
  } catch (e) {
    return TEXT_INPUT_INVALID;
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
    return TEXT_INPUT_INVALID;
  }
  return new TextEncoder().encode(text).length > TEXT_INPUT_MAX_BYTES ? TEXT_INPUT_TOO_LONG : TEXT_INPUT_OK;
}

// The message of the text panel for an answer of checkStreamText() or sendText() that isn't TEXT_INPUT_OK
function getStreamTextError(result) {
  switch (result) {
    case TEXT_INPUT_NO_STREAM:
      return t('The text can\'t be sent, since the stream has ended.');
    case TEXT_INPUT_EMPTY:
      return t('Type a text first.');
    case TEXT_INPUT_TOO_LONG:
      return t('The text is too long to send at once. Send it in shorter parts.');
    case TEXT_INPUT_INVALID:
      return t('The text has a character that can\'t be sent.');
    default:
      return t('The text couldn\'t be sent. Try again.');
  }
}

// Whether the field of the text panel takes the text, i.e. the keyboard of the TV is meant to show for it
function isStreamTextEditing() {
  const input = document.getElementById('streamTextInput');
  return isStreamTextOpen && !!input && !input.readOnly;
}

// Select an item of the text panel (Views.StreamText in navigation.js): 0 the field, 1 Send, 2 Cancel. Leaving the field
// ends its input.
function selectStreamTextItem(index) {
  const view = Views.StreamText.view;
  if (index !== 0) {
    stopStreamTextEditing();
  }
  unmark(view.current());
  view.index = index;
  mark(view.current());
  focusElement(view.current());
}

// Let the field of the text panel take the text and open the keyboard of the TV for it, like the field of the Add Host
// dialog (handleIpTextFieldState() in navigation.js): the keyboard of the TV opens for a focused field that is clicked
function startStreamTextEditing() {
  const input = document.getElementById('streamTextInput');
  selectStreamTextItem(0);
  input.readOnly = false;
  input.focus();
  input.click();
}

// End the input of the field of the text panel, which closes the keyboard of the TV
function stopStreamTextEditing() {
  const input = document.getElementById('streamTextInput');
  input.readOnly = true;
  input.blur();
}

// Open the text panel of 'Type text…' in place of the entries of the Stream Menu, with an empty field that takes the
// text right away. The Stream Menu stays open meanwhile, so the controllers and the keys stay away from the PC, and the
// keys of the keyboard go to the field (initSpecialKeys() in index.js).
function openStreamText() {
  if (!isStreamMenuOpen || isStreamTextOpen) {
    return;
  }
  isStreamTextOpen = true;
  $('#streamTextInput').val('');
  $('#streamTextStatus').text('');
  document.getElementById('streamMenu').hidden = true;
  document.getElementById('streamTextPanel').hidden = false;
  Views.StreamText.view.index = 0;
  Navigation.push(Views.StreamText);
  startStreamTextEditing();
}

// Hide the text panel and drop its text, which is never kept or logged
function hideStreamText() {
  isStreamTextOpen = false;
  stopStreamTextEditing();
  $('#streamTextInput').val('');
  $('#streamTextStatus').text('');
  document.getElementById('streamTextPanel').hidden = true;
  document.getElementById('streamMenu').hidden = false;
}

// Leave the text panel without sending anything: back to the entries of the Stream Menu, on 'Type text…', also when the
// entries before it changed meanwhile
function cancelStreamText() {
  if (!isStreamTextOpen) {
    return;
  }
  hideStreamText();
  Views.StreamMenu.view.index = Math.max(0, getOverlayMenuItems('streamMenu').indexOf(document.getElementById('streamMenuText')));
  Navigation.pop();
  Navigation.switch();
}

// Send the text of the text panel to the PC and resume the stream, where it shows. A text that can't be sent keeps the
// panel open with the reason. Only the answer is logged, never the text or its length.
function sendStreamText() {
  if (!isStreamTextOpen) {
    return;
  }
  const text = $('#streamTextInput').val();
  let result = checkStreamText(text);
  if (result === TEXT_INPUT_OK) {
    result = typeof Module.sendText === 'function' ? Module.sendText(text) : TEXT_INPUT_NOT_SENT;
  }
  console.log('%c[menus.js, sendStreamText]', 'color: teal;', 'Answer to the text for the PC: ' + result);
  if (result !== TEXT_INPUT_OK) {
    $('#streamTextStatus').text(getStreamTextError(result));
    if (result === TEXT_INPUT_EMPTY) {
      startStreamTextEditing();
    }
    return;
  }
  closeStreamMenu(true);
  snackbarLog('Text sent to the PC');
}

// Whether a key event is for the field of the text panel while it takes the text (initSpecialKeys() in index.js)
function isStreamTextFieldEvent(e) {
  return isStreamTextEditing() && e.target === document.getElementById('streamTextInput');
}

// Run the action of a key pressed in the field of the text panel while it takes the text (initSpecialKeys() in index.js):
// the keys that send, cancel or leave the field, and the keys of the remote that keep their action in the Stream Menu,
// which go on to its handler. Returns false for every other key, which the field takes.
function handleStreamTextKey(e) {
  if (e.repeat && STREAM_TEXT_SEND_KEYS.concat(STREAM_TEXT_CANCEL_KEYS).indexOf(e.keyCode) >= 0) {
    // A held key sends or cancels once, and the auto-repeat of OK that opened the panel sends nothing
  } else if (STREAM_TEXT_SEND_KEYS.indexOf(e.keyCode) >= 0) {
    sendStreamText();
  } else if (STREAM_TEXT_CANCEL_KEYS.indexOf(e.keyCode) >= 0) {
    cancelStreamText();
  } else if (STREAM_TEXT_LEAVE_KEYS.indexOf(e.keyCode) >= 0) {
    selectStreamTextItem(1);
  } else if (STREAM_TEXT_REMOTE_KEYS.indexOf(e.keyCode) >= 0) {
    remoteControllerHandler(e);
  } else {
    return false;
  }
  return true;
}

// Read a list of apps of a host that localStorage keeps under a key prefix: a list of { id, title }
function loadAppEntries(prefix, serverUid) {
  try {
    const stored = JSON.parse(localStorage.getItem(prefix + serverUid) || '[]');
    return Array.isArray(stored) ? stored.filter((entry) => entry && (entry.id !== undefined || entry.title)) : [];
  } catch (error) {
    console.warn('%c[menus.js, loadAppEntries]', 'color: teal;', 'Warning: Failed to read ' + prefix + serverUid + ': ' + error);
    return [];
  }
}

// Store a list of apps of a host under a key prefix, or forget it for an empty list
function saveAppEntries(prefix, serverUid, entries) {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(prefix + serverUid);
    } else {
      localStorage.setItem(prefix + serverUid, JSON.stringify(entries));
    }
  } catch (error) {
    console.warn('%c[menus.js, saveAppEntries]', 'color: teal;', 'Warning: Failed to store ' + prefix + serverUid + ': ' + error);
  }
}

// Read the hidden apps of a host: a list of { id, title }
function loadHiddenApps(serverUid) {
  return loadAppEntries(HIDDEN_APPS_KEY_PREFIX, serverUid);
}

// Store the hidden apps of a host, or forget them for an empty list
function saveHiddenApps(serverUid, hiddenApps) {
  saveAppEntries(HIDDEN_APPS_KEY_PREFIX, serverUid, hiddenApps);
}

// The apps of a host that its app grid was built with last, to tell its apps apart (findAppEntry()), or an empty list
function getAppGridApps(serverUid) {
  return appGridApps && appGridApps.serverUid === serverUid ? appGridApps.apps : [];
}

// Find the entry of an app among the favorites or the recently played apps of its host, as its index or -1. An entry
// with the ID and the title of the app is it. Otherwise the title decides, since Sunshine numbered its apps by their
// place in its list before its IDs became hashes, so after a change of the list an ID can belong to another app: an
// entry is the app with its title, unless the entry has the ID and the title of another app of the list (appList, the
// apps of the host when known), since two apps of a host may share a title. Only an entry without a title (the app
// remembered as the last one opened before the list existed) is the app with its ID.
function findAppEntry(entries, app, appList) {
  const id = String(app.id);
  const others = appList || [];
  let index = entries.findIndex((entry) => String(entry.id) === id && (entry.title || '') === (app.title || ''));
  if (index < 0) {
    index = entries.findIndex((entry) => !!entry.title && entry.title === app.title &&
      !others.some((other) => String(other.id) === String(entry.id) && other.title === entry.title));
  }
  if (index < 0) {
    index = entries.findIndex((entry) => !entry.title && String(entry.id) === id);
  }
  return index;
}

// Check if the favorites or the recently played apps of a host have an app (findAppEntry())
function isAppListed(entries, app, appList) {
  return findAppEntry(entries, app, appList) >= 0;
}

// Return a list of entries with the entry of an app removed (findAppEntry()), and put at the front or the end of it
// when added
function setAppEntry(entries, app, appList, place) {
  const index = findAppEntry(entries, app, appList);
  const others = entries.filter((entry, i) => i !== index);
  const entry = { id: String(app.id), title: app.title };
  if (place === 'first') {
    return [entry].concat(others);
  }
  return place === 'last' ? others.concat([entry]) : others;
}

// Check if an app is hidden: an entry has its ID or its title, since the ID of an app can change on the host (Sunshine
// numbers its apps anew when the list changes)
function isAppHidden(hiddenApps, app) {
  return hiddenApps.some((entry) => String(entry.id) === String(app.id) || (!!entry.title && entry.title === app.title));
}

// Return the hidden apps with an app hidden, or shown again (every entry with its ID or title is removed)
function setAppHidden(hiddenApps, app, hidden) {
  const others = hiddenApps.filter((entry) => !isAppHidden([entry], app));
  return hidden ? others.concat([{ id: String(app.id), title: app.title }]) : others;
}

// Read the favorites of a host, which lead its app grid and its Smart Hub tiles: a list of { id, title }
function loadFavoriteApps(serverUid) {
  return loadAppEntries(FAVORITE_APPS_KEY_PREFIX, serverUid);
}

// Store the favorites of a host, or forget them for an empty list
function saveFavoriteApps(serverUid, favoriteApps) {
  saveAppEntries(FAVORITE_APPS_KEY_PREFIX, serverUid, favoriteApps);
}

// Return the favorites with an app added at the end, or removed (only the entry of the app, findAppEntry())
function setAppFavorite(favoriteApps, app, favorite, appList) {
  return setAppEntry(favoriteApps, app, appList, favorite ? 'last' : '');
}

// Read the recently played apps of a host, the latest first: a list of { id, title }. An install that played before
// the list existed starts it with the app it remembers as the last one opened (startGame() in index.js).
function loadRecentApps(serverUid) {
  const recentApps = loadAppEntries(RECENT_APPS_KEY_PREFIX, serverUid);
  if (recentApps.length === 0) {
    const lastOpenedApp = localStorage.getItem('lastOpenedApp_' + serverUid);
    if (lastOpenedApp) {
      return [{ id: String(lastOpenedApp), title: '' }];
    }
  }
  return recentApps;
}

// Put an app at the front of the recently played apps of a host, which keeps the latest RECENT_APPS_MAX (from
// startGame() in index.js, when the host accepted the start of a stream of the app)
function rememberRecentApp(serverUid, app, appList) {
  saveAppEntries(RECENT_APPS_KEY_PREFIX, serverUid, setAppEntry(loadRecentApps(serverUid), app, appList, 'first').slice(0, RECENT_APPS_MAX));
}

// The order of the setting 'Sort the list of apps' for a stored or chosen value: true is Z-A and false A-Z, as the
// switch of earlier versions stored them, and anything unknown A-Z
function parseAppSortOrder(value) {
  if (value === true) {
    return 'za';
  }
  return APP_SORT_ORDERS.indexOf(value) >= 0 ? value : APP_SORT_ORDERS[0];
}

// Order the apps of a host for the app grid and the Smart Hub tiles, as a new list: the favorites first, then the
// other apps, each part in the order of the setting 'Sort the list of apps': 'az' or 'za' by title, 'recent' with the
// recently played apps first (the latest first) and the others from A to Z, or 'host' as the list comes from the host.
// Apps that are equal for an order keep the order of the host. (Array.prototype.sort() of the browser of Tizen 5.5,
// Chromium 69, doesn't keep the order of equal elements, so the position in the list decides between them.) The idea
// of the favorites and the recently played apps comes from the library of the fork of samirmartins (moonlight-tizen,
// GPL-3.0, console-library.js of 97bfe5c).
function orderAppList(appList, sortOrder, favoriteApps, recentApps) {
  const order = parseAppSortOrder(sortOrder);
  const favorites = favoriteApps || [];
  const recent = recentApps || [];
  const byTitle = (a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true, sensitivity: 'base' });
  // The place of an app among the recently played apps, or the end for the others
  const recentRank = (app) => {
    const place = findAppEntry(recent, app, appList);
    return place >= 0 ? place : recent.length;
  };
  const entries = appList.map((app, index) => ({
    app: app, index: index, favorite: isAppListed(favorites, app, appList), rank: order === 'recent' ? recentRank(app) : 0,
  }));
  entries.sort((a, b) => {
    let result = (a.favorite ? 0 : 1) - (b.favorite ? 0 : 1);
    if (result === 0 && order === 'recent') {
      result = a.rank - b.rank || byTitle(a.app, b.app);
    } else if (result === 0 && order === 'za') {
      result = byTitle(b.app, a.app);
    } else if (result === 0 && order === 'az') {
      result = byTitle(a.app, b.app);
    }
    return result || a.index - b.index;
  });
  return entries.map((entry) => entry.app);
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

// Name the entries of the app menu, in their order, for an app that is running or not, a favorite or not, hidden or
// not, on a host with hiddenCount hidden apps, whose hidden apps show or not
function getAppMenuEntries(state) {
  const entries = [state.running ? 'appMenuResume' : 'appMenuStart'];
  if (state.running) {
    entries.push('appMenuQuit');
  }
  entries.push(state.favorite ? 'appMenuUnfavorite' : 'appMenuFavorite');
  entries.push(state.hidden ? 'appMenuUnhide' : 'appMenuHide');
  if (state.hiddenCount > 0 || state.showHidden) {
    entries.push('appMenuShowHidden');
  }
  entries.push('appMenuClose');
  return entries;
}

// The class that marks a tile of the app grid with each badge
const APP_TILE_CLASSES = { running: 'current-game-active', hidden: 'app-hidden', favorite: 'app-favorite' };

// Mark a tile of the app grid as the running app, a hidden app or a favorite, with a badge that a theme can restyle (the
// star of a favorite has no label)
function setAppTileBadge(appBox, kind, shown) {
  const className = 'app-badge-' + kind;
  let badge = appBox.querySelector('.' + className);
  if (shown && !badge) {
    badge = document.createElement('span');
    badge.className = 'app-badge ' + className;
    if (kind === 'favorite') {
      badge.setAttribute('aria-hidden', 'true');
    } else {
      // A translation pass translates it again (i18n.js)
      badge.setAttribute('data-i18n', kind === 'running' ? 'Running' : 'Hidden');
      badge.textContent = kind === 'running' ? t('Running') : t('Hidden');
    }
    appBox.appendChild(badge);
  } else if (!shown && badge) {
    badge.parentNode.removeChild(badge);
  }
  appBox.classList.toggle(APP_TILE_CLASSES[kind], shown);
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
  const favorite = isAppListed(loadFavoriteApps(host.serverUid), app, getAppGridApps(host.serverUid));
  const showHidden = showHiddenAppsHost === host.serverUid;
  const entries = getAppMenuEntries({ running: running, favorite: favorite, hidden: hidden, hiddenCount: appGridHiddenCount, showHidden: showHidden });
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
  } else if (id === 'appMenuFavorite' || id === 'appMenuUnfavorite') {
    const favorite = id === 'appMenuFavorite';
    saveFavoriteApps(host.serverUid, setAppFavorite(loadFavoriteApps(host.serverUid), app, favorite, getAppGridApps(host.serverUid)));
    if (favorite) {
      snackbarLog('%1$s is a favorite now.', app.title);
    } else {
      snackbarLog('%1$s is no longer a favorite.', app.title);
    }
    // The favorites lead the Smart Hub tiles as well
    if (typeof updatePreviewData === 'function') {
      updatePreviewData();
    }
    refreshAppGrid(host, app.id);
  } else if (id === 'appMenuShowHidden') {
    showHiddenAppsHost = showHiddenAppsHost === host.serverUid ? null : host.serverUid;
    refreshAppGrid(host, app.id);
  }
}

// Forget the hidden apps, the favorites and the recently played apps of a host that was deleted
function forgetHiddenApps(serverUid) {
  saveHiddenApps(serverUid, []);
  saveFavoriteApps(serverUid, []);
  saveAppEntries(RECENT_APPS_KEY_PREFIX, serverUid, []);
  if (showHiddenAppsHost === serverUid) {
    showHiddenAppsHost = null;
  }
}

// Connect the entries of both menus to their actions
function attachOverlayMenuListeners() {
  $('#streamMenu .overlay-menu-item').on('click', function() {
    runStreamMenuAction(this.id);
  });
  $('#streamTextSend').on('click', sendStreamText);
  $('#streamTextCancel').on('click', cancelStreamText);
  $('#appMenu .overlay-menu-item').on('click', function() {
    runAppMenuAction(this.id);
  });
}
