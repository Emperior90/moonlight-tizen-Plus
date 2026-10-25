const Controller = (function() {
  let pollingInterval = null;
  let listenersAdded = false;
  const gamepads = {};

  // Stick values in the menus. The resting sticks of worn or third-party controllers often report a few hundredths, and
  // Chromium applies no dead zone, so a value within AXIS_REST_ZONE counts as 0, and a change smaller than
  // AXIS_CHANGE_STEP is not reported unless it crosses AXIS_MOVE_THRESHOLD, past which the menus move (ACTION_THRESHOLD
  // in index.js). Without this, a jittering stick sent up to 200 events per second to the main thread.
  const AXIS_REST_ZONE = 0.15;
  const AXIS_CHANGE_STEP = 0.05;
  const AXIS_MOVE_THRESHOLD = 0.5;
  // Number of characters of a gamepad id that the stream sees: the Emscripten event struct keeps 63 bytes of it, which
  // GetControllerType() in wasm/controller_type.hpp detects the controller type from
  const STREAM_ID_LENGTH = 63;

  class Button {
    constructor(button) {
      this.value = button.value;
      this.pressed = button.pressed;
    }
  }

  // Stick value with the rest zone applied
  function restZoneValue(value) {
    return Math.abs(value) < AXIS_REST_ZONE ? 0 : value;
  }

  // Side of the move threshold that a stick value is on: -1, 0 or 1
  function moveZone(value) {
    return value < -AXIS_MOVE_THRESHOLD ? -1 : (value > AXIS_MOVE_THRESHOLD ? 1 : 0);
  }

  class Gamepad {
    // Snapshot of a gamepad. A gamepad that is new to the menus starts with all buttons released, so the press that made
    // the browser announce it (Chromium exposes a controller only after its first input, and its first snapshot already
    // holds that press) is reported. The sticks start from their current position, so a stick that rests off-centre
    // doesn't move the menus.
    constructor(gamepad, buttonsReleased) {
      this.id = gamepad.id;
      this.buttons = gamepad.buttons.map((button) => new Button(buttonsReleased ? { pressed: false, value: 0 } : button));
      this.axes = gamepad.axes.map(restZoneValue); // Store initial axis values
    }

    // Check if a snapshot comes from the same controller with the same buttons and axes layout
    matches(gamepad) {
      return this.id === gamepad.id && this.buttons.length === gamepad.buttons.length && this.axes.length === gamepad.axes.length;
    }

    // List the end of the input that this snapshot holds, its pressed buttons released and its sticks back at rest, for
    // when the gamepad is gone or another snapshot replaces this one
    releaseChanges() {
      const changes = [];
      this.buttons.forEach((button, i) => {
        if (button.pressed) {
          changes.push({ type: 'button', index: i, pressed: false });
        }
      });
      this.axes.forEach((value, i) => {
        if (value !== 0) {
          changes.push({ type: 'axis', index: i, value: 0 });
        }
      });
      return changes;
    }

    analyzeButtonsAndAxes(index, newButtons, newAxes) {
      const changes = [];

      for (let i = 0; i < newButtons.length; ++i) {
        if (this.buttons[i].pressed !== newButtons[i].pressed) {
          changes.push({
            type: 'button',
            index: i,
            pressed: newButtons[i].pressed,
          });
        }
      }

      for (let i = 0; i < newAxes.length; i++) {
        const value = restZoneValue(newAxes[i]);
        const previous = this.axes[i];
        if (Math.abs(value - previous) >= AXIS_CHANGE_STEP || moveZone(value) !== moveZone(previous)) {
          changes.push({
            type: 'axis',
            index: i,
            value: value
          });
          // Keep the reported value instead of every new one, so a slow drift is reported once it adds up to a step
          this.axes[i] = value;
        }
      }

      reportChanges(index, changes);

      this.buttons = newButtons.map((button) => new Button(button));
    }
  }

  // Report the changes of a gamepad to the menus (index.js)
  function reportChanges(index, changes) {
    if (changes.length > 0) {
      window.dispatchEvent(new CustomEvent('gamepadinputchanged', {
          detail: { gamepad: index, changes },
        })
      );
    }
  }

  // Report that the input held in the snapshot of a gamepad ended, before the snapshot is dropped or replaced, so that a
  // D-pad or stick that was held doesn't keep repeating in the menus. While polling is paused for the stream, the menus
  // already cancelled their repeat, and they take fresh snapshots when polling resumes.
  function endHeldInput(index) {
    if (gamepads[index] && pollingInterval) {
      reportChanges(index, gamepads[index].releaseChanges());
    }
  }

  // Read the gamepad slots of the browser. Tizen 5.5 (Chromium M69) and newer have the standard navigator.getGamepads()
  function readGamepads() {
    return (navigator.getGamepads && navigator.getGamepads()) || [];
  }

  // Check if a slot holds a controller, and not one of the placeholders that Tizen reports as connected but whose
  // timestamp stays 0 until they send input (see getConnectedGamepadMask() in utils.js and PollGamepads() in gamepad.cpp)
  function isRealGamepad(gamepad) {
    return !!gamepad && !!gamepad.connected && gamepad.timestamp !== 0;
  }

  // Read the USB vendor id from a lower-cased gamepad id, in the format of Chromium on Linux ('... (STANDARD GAMEPAD
  // Vendor: 054c Product: 0ce6)') or of other Chromium builds ('054c-0ce6-DualSense Wireless Controller'), or -1
  function getVendorId(lowerId) {
    const vendorIndex = lowerId.indexOf('vendor:');
    if (vendorIndex >= 0) {
      const match = /^ *([0-9a-f]{4})/.exec(lowerId.slice(vendorIndex + 7));
      return match ? parseInt(match[1], 16) : -1;
    }
    const prefix = /^([0-9a-f]{4})-[0-9a-f]{4}-/.exec(lowerId);
    return prefix ? parseInt(prefix[1], 16) : -1;
  }

  // Detect the controller family that the stream announces to the PC, with the same rules as GetControllerType() in
  // wasm/controller_type.hpp, applied to the part of the id that the stream sees (tests/fixtures/controller-types.tsv
  // keeps both in sync): PlayStation, Xbox, Nintendo or Unknown. The vendor id decides first (Sony, Microsoft, Nintendo,
  // and 8BitDo, whose controllers report their own vendor id in their X-input mode with the Xbox layout and in their
  // D-input mode), then a name hint.
  function getControllerType(id) {
    const lower = String(id || '').slice(0, STREAM_ID_LENGTH).toLowerCase();
    const contains = (needle) => lower.indexOf(needle) >= 0;
    switch (getVendorId(lower)) {
      case 0x054c: // Sony
        return 'PlayStation';
      case 0x045e: // Microsoft
      case 0x2dc8: // 8BitDo
        return 'Xbox';
      case 0x057e: // Nintendo
        return 'Nintendo';
      default:
        break;
    }
    if (contains('dualsense') || contains('dualshock') || contains('playstation') ||
        contains('sony interactive entertainment') || contains('sony computer entertainment')) {
      return 'PlayStation';
    }
    if (contains('xbox') || contains('x-box') || contains('8bitdo')) {
      return 'Xbox';
    }
    if (contains('nintendo') || contains('joy-con')) {
      return 'Nintendo';
    }
    return 'Unknown';
  }

  // Name of a controller for messages: its id without the vendor and product numbers, e.g. 'Xbox Wireless Controller'
  // for 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)' or '045e-0b13-Xbox Wireless Controller'
  function getControllerName(id) {
    return String(id || '').replace(/\s*\([^()]*vendor[^()]*\)\s*$/i, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim();
  }

  // Describe what a gamepad reports, for the log, the notice about a non-standard layout and System information
  function describeGamepad(gamepad) {
    const actuator = gamepad.vibrationActuator;
    return {
      index: gamepad.index,
      id: String(gamepad.id || ''),
      name: getControllerName(gamepad.id),
      mapping: String(gamepad.mapping || ''),
      buttons: gamepad.buttons ? gamepad.buttons.length : 0,
      axes: gamepad.axes ? gamepad.axes.length : 0,
      rumble: !!(actuator && typeof actuator.playEffect === 'function'),
      type: getControllerType(gamepad.id),
    };
  }

  // Format the fields of describeGamepad() for a log line. JSON.stringify() of a Gamepad object only gives {}.
  function formatGamepadInfo(info) {
    return 'id="' + info.id + '", mapping="' + info.mapping + '", buttons=' + info.buttons + ', axes=' + info.axes +
      ', rumble=' + (info.rumble ? 'yes' : 'no') + ', type=' + info.type;
  }

  // Describe the controllers that are connected now
  function getConnectedGamepads() {
    const connectedGamepads = readGamepads();
    const result = [];
    for (let i = 0; i < connectedGamepads.length; i++) {
      if (isRealGamepad(connectedGamepads[i])) {
        result.push(describeGamepad(connectedGamepads[i]));
      }
    }
    return result;
  }

  // Take the snapshot of a gamepad that the browser announced. The polling may have found it already (e.g. it read the
  // slot before the event arrived), and then that snapshot stays, so the press that woke the gamepad is not reported twice.
  function gamepadConnected(gamepad) {
    const known = gamepads[gamepad.index];
    if (!known || !known.matches(gamepad)) {
      endHeldInput(gamepad.index);
      gamepads[gamepad.index] = new Gamepad(gamepad, true);
    }
  }

  function gamepadDisconnected(gamepad) {
    endHeldInput(gamepad.index);
    delete gamepads[gamepad.index];
  }

  function analyzeGamepad(gamepad) {
    const index = gamepad.index;
    let pGamepad = gamepads[index];

    if (pGamepad && !pGamepad.matches(gamepad)) {
      // Another controller in the same slot, or one whose button or axis count changed (e.g. a Tizen placeholder replaced
      // by the real controller, or a controller switched to another mode), so take a fresh snapshot instead of rejecting
      // every later one
      console.log('%c[gamepad.js, analyzeGamepad]', 'color: gray;', 'Gamepad ' + index + ' changed its layout or was replaced, taking a new snapshot: ' + formatGamepadInfo(describeGamepad(gamepad)));
      endHeldInput(index);
      pGamepad = gamepads[index] = new Gamepad(gamepad, true);
    } else if (!pGamepad && isRealGamepad(gamepad)) {
      // A controller that never fired a gamepadconnected event, e.g. one that was announced before the listener was added
      console.log('%c[gamepad.js, analyzeGamepad]', 'color: gray;', 'Found gamepad ' + index + ' without a connection event: ' + formatGamepadInfo(describeGamepad(gamepad)));
      pGamepad = gamepads[index] = new Gamepad(gamepad, true);
    }

    if (pGamepad) {
      pGamepad.analyzeButtonsAndAxes(index, gamepad.buttons, gamepad.axes);
    }
  }

  function pollGamepads() {
    const connectedGamepads = readGamepads();
    for (let i = 0; i < connectedGamepads.length; i++) {
      if (connectedGamepads[i]) {
        analyzeGamepad(connectedGamepads[i]);
      }
    }
  }

  // Take a fresh snapshot of every known or connected gamepad without reporting any changes, so input that happened
  // while polling was paused (e.g. a button combo held when the stream ended) is not replayed, also for a controller that
  // the menus never saw before
  function resetGamepads() {
    const connectedGamepads = readGamepads();
    for (let i = 0; i < connectedGamepads.length; i++) {
      const gamepad = connectedGamepads[i];
      if (gamepad && (gamepads[gamepad.index] || isRealGamepad(gamepad))) {
        gamepads[gamepad.index] = new Gamepad(gamepad, false);
      }
    }
  }

  function startWatching() {
    // Register the connection listeners only once, since polling can be paused and resumed
    if (!listenersAdded) {
      window.addEventListener('gamepadconnected', function(e) {
        gamepadConnected(e.gamepad);
      });
      window.addEventListener('gamepaddisconnected', function(e) {
        gamepadDisconnected(e.gamepad);
      });
      listenersAdded = true;
    }
    if (!pollingInterval) {
      resetGamepads();
      pollingInterval = setInterval(pollGamepads, 5);
      // The menus take over again: no rumble of a stream may go on here (the end of the stream already stopped them)
      Rumble.stopAll();
    }
  }

  function stopWatching() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  return {
    startWatching,
    stopWatching,
    describeGamepad,
    formatGamepadInfo,
    getConnectedGamepads,
    getControllerType,
  };
})();

// Rumble of the gamepads during a stream. The host sends the strength of the two motors of a controller whenever it
// changes ('controllerRumble: ...', see handleMessage() in messages.js), and this plays it on the vibration actuator of
// the gamepad in the same slot.
const Rumble = (function() {
  // Chromium plays one effect for at most 5000 ms (longer ones are rejected), and the host doesn't send an unchanged
  // rumble again, so a rumble that stays on is played again every REPLAY_INTERVAL_MS, before the previous effect ends;
  // the new effect replaces the running one without a gap
  const EFFECT_DURATION_MS = 5000;
  const REPLAY_INTERVAL_MS = 4000;
  // Short effect that tells the user that rumble works when a gamepad connects
  const TEST_EFFECT_DURATION_MS = 500;
  // Rumble that the host keeps on per gamepad index: { weakMagnitude, strongMagnitude, timer }
  const active = {};
  // Ids of the gamepads that were told that they can't rumble, once per app session
  const unsupportedNotices = new Set();

  function getGamepad(index) {
    const gamepads = (navigator.getGamepads && navigator.getGamepads()) || [];
    return gamepads[index] || null;
  }

  function canPlayEffects(gamepad) {
    return !!(gamepad && gamepad.vibrationActuator && typeof gamepad.vibrationActuator.playEffect === 'function');
  }

  // Call the actuator and catch every failure, a thrown error as well as a rejected promise, so that a controller or TV
  // without working motors leaves no unhandled promise rejection
  function callActuator(call, onFailure) {
    try {
      Promise.resolve(call()).catch(onFailure);
    } catch (error) {
      onFailure(error);
    }
  }

  // Log why a gamepad can't rumble, and tell the user once per controller (by its id), e.g. for a controller whose
  // driver on the TV has no rumble support
  function reportUnsupported(index, gamepad, reason) {
    console.warn('%c[gamepad.js, Rumble]', 'color: gray;', 'Warning: Gamepad ' + index + ' can\'t rumble: ' + reason);
    const id = gamepad ? String(gamepad.id || '') : '';
    if (unsupportedNotices.has(id)) {
      return;
    }
    unsupportedNotices.add(id);
    const name = gamepad ? Controller.describeGamepad(gamepad).name : '';
    snackbarLogLong('Gamepad %1$s (%2$s) does not support rumble on this TV.', index, name ? name : t('Unknown'));
  }

  function clearReplay(index) {
    if (active[index]) {
      clearInterval(active[index].timer);
      delete active[index];
    }
  }

  function playEffect(index, gamepad, rumble) {
    callActuator(() => gamepad.vibrationActuator.playEffect('dual-rumble', {
      startDelay: 0,
      duration: EFFECT_DURATION_MS,
      weakMagnitude: rumble.weakMagnitude,
      strongMagnitude: rumble.strongMagnitude,
    }), (error) => {
      // The actuator refused the effect, so don't play it again
      if (active[index] === rumble) {
        clearReplay(index);
      }
      reportUnsupported(index, gamepad, error);
    });
  }

  // Play the rumble again while the host keeps it on, as long as the gamepad is still there
  function replay(index) {
    const rumble = active[index];
    const gamepad = getGamepad(index);
    if (!rumble || !canPlayEffects(gamepad)) {
      clearReplay(index);
      return;
    }
    playEffect(index, gamepad, rumble);
  }

  // Stop the rumble of a gamepad: the host sent 0 for both motors, the stream ended or the gamepad disconnected.
  // reset() stops the motors at once; an actuator without it gets an effect with both motors at 0, which replaces the
  // running one. A gamepad that is gone only loses its replay.
  function stop(index) {
    clearReplay(index);
    const gamepad = getGamepad(index);
    if (!canPlayEffects(gamepad)) {
      return;
    }
    const actuator = gamepad.vibrationActuator;
    const onFailure = (error) => {
      console.warn('%c[gamepad.js, Rumble]', 'color: gray;', 'Warning: Failed to stop the rumble of gamepad ' + index + ': ' + error);
    };
    if (typeof actuator.reset === 'function') {
      callActuator(() => actuator.reset(), onFailure);
    } else {
      callActuator(() => actuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: EFFECT_DURATION_MS,
        weakMagnitude: 0,
        strongMagnitude: 0,
      }), onFailure);
    }
  }

  // Play the rumble that the host sent for the gamepad in a slot, with the strength (0 to 1) of its weak (high
  // frequency) and strong (low frequency) motor. Both at 0 stop it.
  function play(index, weakMagnitude, strongMagnitude) {
    if (!(weakMagnitude > 0) && !(strongMagnitude > 0)) {
      stop(index);
      return;
    }
    const gamepad = getGamepad(index);
    if (!gamepad) {
      console.warn('%c[gamepad.js, Rumble]', 'color: gray;', 'Warning: No gamepad ' + index + ' to play the rumble on.');
      return;
    }
    if (!canPlayEffects(gamepad)) {
      clearReplay(index);
      reportUnsupported(index, gamepad, 'it has no vibration actuator');
      return;
    }
    // Play it now and again every REPLAY_INTERVAL_MS from now on, until the host sends 0
    clearReplay(index);
    const rumble = { weakMagnitude, strongMagnitude, timer: null };
    active[index] = rumble;
    rumble.timer = setInterval(() => replay(index), REPLAY_INTERVAL_MS);
    playEffect(index, gamepad, rumble);
  }

  // Stop every rumble that is still on, when the stream ends
  function stopAll() {
    Object.keys(active).forEach((index) => stop(Number(index)));
  }

  // Play a short rumble on a gamepad that just connected, so the user feels that rumble works, or tell that it can't
  function test(gamepad) {
    if (!canPlayEffects(gamepad)) {
      reportUnsupported(gamepad.index, gamepad, 'it has no vibration actuator');
      return;
    }
    callActuator(() => gamepad.vibrationActuator.playEffect('dual-rumble', {
      startDelay: 0,
      duration: TEST_EFFECT_DURATION_MS,
      weakMagnitude: 0.5,
      strongMagnitude: 0.5,
    }), (error) => reportUnsupported(gamepad.index, gamepad, error));
  }

  return {
    play,
    stop,
    stopAll,
    test,
  };
})();
