// Input test (Settings > Input Settings > Input test): every key of the remote or a keyboard with its name, key code and
// how long it was held, every connected controller live with its buttons, triggers and sticks, and the media keys of the
// TV that Moonlight registered. It turns 'Play/Pause doesn't work' into a clear statement. The controllers are read only
// while the test is open, and it registers no keys of its own: it shows what reaches the app. RETURN (or ESC) leaves it
// after showing the key, and on a controller a hold of B for 2 seconds, so that every button can be tested.
// The idea comes from the forks of Diogo8500 (moonlight-tizen, b338488, initKeyDiagnostics) and samirmartins
// (moonlight-tizen, 5c9d247 and 5cd467d); the controller is drawn in the stroke style of the icons of the app.

const InputTest = (function() {
  const POLL_MS = 50;
  const LEAVE_HOLD_MS = 2000;
  const LEAVE_DELAY_MS = 600;
  const HISTORY_LENGTH = 8;
  // The keys that leave the test: RETURN of the remote, ESC of a keyboard
  const LEAVE_KEY_CODES = [10009, 27];
  // How far the dot of a stick moves in the drawing at full deflection
  const STICK_TRAVEL = 12;

  let isOpen = false;
  let timer = null;
  let leaveTimer = null;
  let held = {};
  let history = [];
  let pads = {};
  let leaveHoldSince = 0;

  // The drawing of a controller in the standard layout, in the stroke style of the icons: each button has the index of the
  // standard layout in data-b, a trigger a bar as long as it is pulled in data-t, and a stick its position in data-s
  const PAD_SVG = '<svg class="pad-svg" viewBox="0 0 300 200" aria-hidden="true">' +
    '<rect x="44" y="6" width="64" height="18" rx="7"/><rect data-t="6" class="pad-fill" x="44" y="6" width="0" height="18" rx="7"/>' +
    '<rect x="192" y="6" width="64" height="18" rx="7"/><rect data-t="7" class="pad-fill" x="192" y="6" width="0" height="18" rx="7"/>' +
    '<rect data-b="4" x="44" y="32" width="64" height="12" rx="6"/><rect data-b="5" x="192" y="32" width="64" height="12" rx="6"/>' +
    '<path class="pad-body" d="M76 52H224A46 46 0 0 1 268 88L284 150A24 24 0 0 1 242 170L218 142H82L58 170A24 24 0 0 1 16 150L32 88A46 46 0 0 1 76 52Z"/>' +
    '<circle data-b="10" cx="86" cy="94" r="20"/><circle data-s="0" class="pad-dot" cx="86" cy="94" r="8"/>' +
    '<circle data-b="11" cx="190" cy="136" r="20"/><circle data-s="1" class="pad-dot" cx="190" cy="136" r="8"/>' +
    '<rect data-b="12" x="104" y="115" width="14" height="14" rx="3"/><rect data-b="13" x="104" y="143" width="14" height="14" rx="3"/>' +
    '<rect data-b="14" x="90" y="129" width="14" height="14" rx="3"/><rect data-b="15" x="118" y="129" width="14" height="14" rx="3"/>' +
    '<circle data-b="3" cx="214" cy="76" r="9"/><text class="pad-label" x="214" y="76" font-size="11">Y</text>' +
    '<circle data-b="0" cx="214" cy="112" r="9"/><text class="pad-label" x="214" y="112" font-size="11">A</text>' +
    '<circle data-b="2" cx="196" cy="94" r="9"/><text class="pad-label" x="196" y="94" font-size="11">X</text>' +
    '<circle data-b="1" cx="232" cy="94" r="9"/><text class="pad-label" x="232" y="94" font-size="11">B</text>' +
    '<rect data-b="8" x="128" y="88" width="16" height="10" rx="5"/><rect data-b="9" x="156" y="88" width="16" height="10" rx="5"/>' +
    '<circle data-b="16" cx="150" cy="68" r="8"/><rect data-b="17" x="143" y="106" width="14" height="7" rx="3"/>' +
    '</svg>';

  // The name of a key for the list: its key, or Unidentified when the TV reports none
  function keyName(e) {
    return e.key && e.key !== 'Unidentified' ? e.key : t('Unidentified');
  }

  function renderKeys() {
    const codes = Object.keys(held);
    const current = codes.length > 0 ? held[codes[codes.length - 1]] : history[0];
    const now = Date.now();
    if (!current) {
      $('#inputTestKey').text(t('Press a key of the remote'));
      $('#inputTestKeyInfo').text('');
    } else {
      const heldMs = current.upAt ? current.upAt - current.downAt : now - current.downAt;
      $('#inputTestKey').text(current.key);
      $('#inputTestKeyInfo').text(t('keyCode %1$s · held %2$s ms', current.keyCode, heldMs) +
        (current.repeats > 0 ? ' · ' + t('%1$s repeats', current.repeats) : '') + (current.upAt ? '' : ' · ' + t('held')));
    }
    $('#inputTestHistory').text(history.map((entry) => entry.key + ' · ' + entry.keyCode + ' · ' + (entry.upAt - entry.downAt) + ' ms' +
      (entry.repeats > 0 ? ' · ' + t('%1$s repeats', entry.repeats) : '')).join('\n'));
  }

  // Leave the test a moment after RETURN, so that the key shows first
  function leaveSoon() {
    if (!leaveTimer) {
      leaveTimer = setTimeout(close, LEAVE_DELAY_MS);
    }
  }

  // Every key goes to the test while it is open, and nowhere else: the menus, the remote handler and the default action
  // of the browser don't get it
  function onKey(e) {
    if (!isOpen) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (e.type === 'keydown') {
      const entry = held[e.keyCode];
      if (entry) {
        entry.repeats++;
      } else {
        held[e.keyCode] = { key: keyName(e), keyCode: e.keyCode, downAt: now, upAt: 0, repeats: 0 };
      }
      if (LEAVE_KEY_CODES.indexOf(e.keyCode) >= 0) {
        leaveSoon();
      }
    } else {
      // A release without a press, e.g. of OK that opened the test, is left out
      const entry = held[e.keyCode];
      if (!entry) {
        return;
      }
      delete held[e.keyCode];
      entry.upAt = now;
      history.unshift(entry);
      history = history.slice(0, HISTORY_LENGTH);
      console.log('%c[input_test.js, onKey]', 'color: teal;', 'Key ' + entry.key + ' (' + entry.keyCode + ') held for ' +
        (entry.upAt - entry.downAt) + ' ms' + (entry.repeats > 0 ? ' with ' + entry.repeats + ' repeats' : ''));
    }
    renderKeys();
  }

  // The names of the pressed buttons of a gamepad: those of the standard layout, or their indices for another layout
  function pressedNames(gamepad) {
    const names = [];
    const standard = gamepad.mapping === 'standard';
    gamepad.buttons.forEach((button, index) => {
      if (button.pressed) {
        names.push(standard && index < MAPPED_BUTTON_NAMES.length ? t(MAPPED_BUTTON_NAMES[index]) :
          (standard && index === 16 ? t('Guide') : String(index)));
      }
    });
    return names;
  }

  function createPadCard(gamepad) {
    const info = Controller.describeGamepad(gamepad);
    const card = document.createElement('div');
    card.className = 'pad-card';
    card.innerHTML = '<div class="pad-title"></div><div class="pad-meta"></div>' + PAD_SVG +
      '<div class="pad-readout pad-buttons"></div><div class="pad-readout pad-axes"></div>';
    card.querySelector('.pad-title').textContent = t('Gamepad %1$s: %2$s', info.index, info.name || t('Unknown'));
    card.querySelector('.pad-meta').textContent = (info.mapping === 'standard' ? t('standard layout') : t('non-standard layout')) +
      ' · ' + t('%1$s buttons, %2$s axes', info.buttons, info.axes);
    return { id: gamepad.id, card: card, svg: card.querySelector('svg') };
  }

  // Draw what a gamepad reports now
  function drawPad(view, gamepad) {
    const buttons = gamepad.buttons;
    Array.prototype.forEach.call(view.svg.querySelectorAll('[data-b]'), (part) => {
      const button = buttons[Number(part.getAttribute('data-b'))];
      part.classList.toggle('on', !!button && button.pressed);
    });
    Array.prototype.forEach.call(view.svg.querySelectorAll('[data-t]'), (bar) => {
      const button = buttons[Number(bar.getAttribute('data-t'))];
      bar.setAttribute('width', String(Math.round((button ? button.value : 0) * 64)));
    });
    Array.prototype.forEach.call(view.svg.querySelectorAll('[data-s]'), (dot) => {
      const stick = Number(dot.getAttribute('data-s'));
      const baseX = stick === 0 ? 86 : 190;
      const baseY = stick === 0 ? 94 : 136;
      const x = Number(gamepad.axes[stick * 2]) || 0;
      const y = Number(gamepad.axes[stick * 2 + 1]) || 0;
      dot.setAttribute('cx', (baseX + x * STICK_TRAVEL).toFixed(1));
      dot.setAttribute('cy', (baseY + y * STICK_TRAVEL).toFixed(1));
    });
    const names = pressedNames(gamepad);
    // Each 'none' is a text of its own, since a language may need another word for it in each line (Spanish and French
    // agree it with the noun)
    view.card.querySelector('.pad-buttons').textContent = names.length > 0 ? t('Buttons: %1$s', names.join(', ')) : t('Buttons: None');
    const axes = gamepad.axes.map((value) => (Number(value) || 0).toFixed(2)).join('  ');
    const triggers = gamepad.mapping === 'standard' && buttons.length > 7 ?
      '   LT ' + buttons[6].value.toFixed(2) + '  RT ' + buttons[7].value.toFixed(2) : '';
    view.card.querySelector('.pad-axes').textContent = t('Axes: %1$s', axes) + triggers;
  }

  // Read the gamepads, draw them and follow a hold of B, which leaves the test
  function poll() {
    const gamepads = (navigator.getGamepads && navigator.getGamepads()) || [];
    const container = document.getElementById('inputTestPads');
    const seen = {};
    let holdingB = false;
    for (let i = 0; i < gamepads.length; i++) {
      const gamepad = gamepads[i];
      if (!gamepad || !gamepad.connected || gamepad.timestamp === 0) {
        continue;
      }
      seen[i] = true;
      let view = pads[i];
      if (!view || view.id !== gamepad.id) {
        if (view) {
          view.card.remove();
        }
        view = pads[i] = createPadCard(gamepad);
        container.appendChild(view.card);
      }
      drawPad(view, gamepad);
      holdingB = holdingB || !!(gamepad.buttons[1] && gamepad.buttons[1].pressed);
    }
    Object.keys(pads).forEach((index) => {
      if (!seen[index]) {
        pads[index].card.remove();
        delete pads[index];
      }
    });
    $('#inputTestNoPads').toggle(Object.keys(pads).length === 0);
    const now = Date.now();
    leaveHoldSince = holdingB ? (leaveHoldSince || now) : 0;
    $('#inputTestHint').toggleClass('is-leaving', holdingB);
    if (leaveHoldSince && now - leaveHoldSince >= LEAVE_HOLD_MS) {
      close();
      return;
    }
    // A held key shows how long it is held so far
    if (Object.keys(held).length > 0) {
      renderKeys();
    }
  }

  // The media and colour keys of the TV (tizen.tvinputdevice.getSupportedKeys()): those that Moonlight registered, and
  // those that it leaves to the TV
  function describeTvKeys() {
    let supported = [];
    try {
      supported = tizen.tvinputdevice.getSupportedKeys() || [];
    } catch (error) {
      return t('The TV doesn\'t list its keys.');
    }
    const registered = typeof registeredTvKeys !== 'undefined' ? registeredTvKeys : [];
    const keys = supported.filter((key) => /^(Media|Color)/.test(key.name));
    if (keys.length === 0) {
      return t('The TV lists no media keys.');
    }
    const list = (wanted) => keys.filter((key) => (registered.indexOf(key.name) >= 0) === wanted)
      .map((key) => key.name + ' ' + key.code).join(', ');
    const registeredKeys = list(true);
    const tvKeys = list(false);
    return (registeredKeys ? t('Registered by Moonlight: %1$s', registeredKeys) : t('Registered by Moonlight: None')) + '\n' +
      (tvKeys ? t('Left to the TV: %1$s', tvKeys) : t('Left to the TV: None'));
  }

  function open() {
    if (isOpen) {
      return;
    }
    isOpen = true;
    held = {};
    history = [];
    pads = {};
    leaveHoldSince = 0;
    leaveTimer = null;
    $('#inputTestPads').empty();
    $('#inputTestTvKeys').text(describeTvKeys());
    renderKeys();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    $('#inputTestDialogOverlay').css('display', 'flex');
    document.getElementById('inputTestDialog').showModal();
    isDialogOpen = true;
    Navigation.push(Views.InputTestDialog);
    poll();
    timer = setInterval(poll, POLL_MS);
    console.log('%c[input_test.js, open]', 'color: teal;', 'Opened the input test with ' + Object.keys(pads).length + ' gamepads.');
  }

  function close() {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    clearInterval(timer);
    clearTimeout(leaveTimer);
    timer = null;
    leaveTimer = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    $('#inputTestDialogOverlay').css('display', 'none');
    document.getElementById('inputTestDialog').close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
  }

  return {
    open: open,
    close: close,
    isOpen: () => isOpen,
  };
})();
