const Controller = (function() {
  let pollingInterval = null;
  let listenersAdded = false;
  const gamepads = {};

  // Stick values in the menus. The resting sticks of worn or third-party controllers often report a few hundredths, and
  // Chromium applies no dead zone, so a value within AXIS_REST_ZONE counts as 0, and a change smaller than
  // AXIS_CHANGE_STEP is not reported unless it crosses AXIS_MOVE_THRESHOLD, past which the menus move (ACTION_THRESHOLD
  // in index.js), or AXIS_RELEASE_THRESHOLD, below which a direction of the menus ends (ACTION_RELEASE_THRESHOLD in
  // index.js). Without this, a jittering stick sent up to 200 events per second to the main thread.
  const AXIS_REST_ZONE = 0.15;
  const AXIS_CHANGE_STEP = 0.05;
  const AXIS_MOVE_THRESHOLD = 0.5;
  const AXIS_RELEASE_THRESHOLD = 0.3;
  // Number of characters of a gamepad id that the stream sees: the Emscripten event struct keeps 63 bytes of it, which
  // GetControllerType() in wasm/controller_type.hpp detects the controller type from
  const STREAM_ID_LENGTH = 63;
  // How often the menus read the gamepads, in ms: about once per frame of the screen, which no real button press is
  // shorter than. The held D-pad and stick repeat by time (index.js), so it doesn't change how fast they repeat.
  const MENU_POLL_INTERVAL_MS = 16;
  // A read of the gamepads that comes this long after the one before it is late: the page was busy meanwhile, e.g. with
  // drawing the step of a press, and what the read finds changed can have happened that long ago
  const LATE_POLL_MS = 3 * MENU_POLL_INTERVAL_MS;
  // The time of the read before the one that runs (null for the first one since the polling started), and by how many
  // ms the read that runs came later than it was due, 0 for one that is not late. The menus get it with the changes of
  // the read (lateBy), so that they don't take a D-pad press after a busy moment for a bounce of the press before it.
  let lastPollAt = null;
  let pollLateBy = 0;

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

  // Zone of the menus that a stick value is in: past the move threshold (-2 or 2), between the release and the move
  // threshold (-1 or 1), where a direction holds but none starts, or at rest (0)
  function moveZone(value) {
    const magnitude = Math.abs(value);
    const zone = magnitude > AXIS_MOVE_THRESHOLD ? 2 : (magnitude > AXIS_RELEASE_THRESHOLD ? 1 : 0);
    return value < 0 ? -zone : zone;
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
        // A value that is not a number is no stick position (the Gamepad API types the axes as doubles, which excludes
        // NaN, so this only guards against a broken report). One in the snapshot (taken when the gamepad appeared, when
        // the polling resumed, or from the baseline of its evidence) takes the first number as the resting position
        // without a move, as hasInputChanged() does for the evidence. Otherwise the first number of a stick that rests
        // past AXIS_MOVE_THRESHOLD would be reported as a move, and the menus would keep scrolling while it rests there.
        // One in a read is skipped and the axis keeps its last position, so a single one neither stops the repeat of a
        // held stick nor, by the rule above, turns the next number into a resting position that swallows the move. The
        // trade-off: a stick that keeps reading a non-number keeps its last position too, also a held one, whose repeat
        // in the menus then goes on until a number arrives or another button ends it.
        if (!isFiniteNumber(value)) {
          continue;
        }
        if (!isFiniteNumber(previous)) {
          this.axes[i] = value;
          continue;
        }
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
          detail: { gamepad: index, changes, lateBy: pollLateBy },
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

  // Smallest move of an analog button or axis away from the baseline that counts as input (kInputChangeStep in
  // wasm/gamepad.cpp)
  const INPUT_CHANGE_STEP = 0.01;
  // Evidence per slot index that it holds a controller: { id, validated, byInput, baseline: { buttons, axes } }
  const evidence = {};
  // Slots that counted by a change of their input since the last 'gamepadvalidated' event
  let validatedByInput = [];

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  // The input of a gamepad as the baseline that a change is measured from
  function recordBaseline(buttons, axes) {
    return {
      buttons: Array.prototype.map.call(buttons, (button) => ({ pressed: !!button.pressed, value: button.value })),
      axes: Array.prototype.slice.call(axes),
    };
  }

  // Check if the input of a slot changed since it appeared, as HasGamepadInputChanged() in wasm/gamepad.cpp does: a
  // button whose pressed state flipped, or a button value or axis that moved more than INPUT_CHANGE_STEP away from the
  // baseline. A value that wasn't finite in the baseline takes the first finite one.
  function hasInputChanged(buttons, axes, baseline) {
    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      const base = baseline.buttons[i];
      if (!!button.pressed !== base.pressed) {
        return true;
      }
      if (isFiniteNumber(button.value)) {
        if (isFiniteNumber(base.value) && Math.abs(button.value - base.value) > INPUT_CHANGE_STEP) {
          return true;
        }
        if (!isFiniteNumber(base.value)) {
          base.value = button.value;
        }
      }
    }
    for (let i = 0; i < axes.length; i++) {
      if (isFiniteNumber(axes[i])) {
        if (isFiniteNumber(baseline.axes[i]) && Math.abs(axes[i] - baseline.axes[i]) > INPUT_CHANGE_STEP) {
          return true;
        }
        if (!isFiniteNumber(baseline.axes[i])) {
          baseline.axes[i] = axes[i];
        }
      }
    }
    return false;
  }

  // Check if a slot holds a controller, and not one of the placeholders that Tizen reports as connected, and record what
  // it shows now as evidence. The rule is the one of PollGamepads() in wasm/gamepad.cpp (tests/fixtures/
  // gamepad-evidence.tsv keeps both the same): a slot counts with a positive timestamp, or once its input changed since
  // it appeared, since Tizen 5.5 reports a timestamp of 0 for real controllers too (upstream fdf4fbe, PR #192 by
  // podrezov, GPL-3.0). A static value never counts, also a button held since the slot appeared (its release does) or a
  // stick that rests off-centre. The evidence stays while the same id is in the slot, also when its timestamp reads 0
  // later; an empty slot (no gamepad) forgets it. The menus, the input test, System information, the button mapping,
  // the Stream Menu and the mask of a stream start (getConnectedGamepadMask() in utils.js) all count with this, and the
  // polling of the menus gathers the evidence. The index defaults to that of the gamepad.
  function isRealGamepad(gamepad, index) {
    const slot = index === undefined ? (gamepad ? gamepad.index : -1) : index;
    // No slot of the browser is below 0 (e.g. null without an index), so there is no evidence to record or forget
    if (slot < 0) {
      return false;
    }
    if (!gamepad || !gamepad.connected) {
      delete evidence[slot];
      return false;
    }
    let state = evidence[slot];
    if (!state || state.id !== gamepad.id) {
      state = evidence[slot] = { id: gamepad.id, validated: false, byInput: false, baseline: null };
    }
    if (state.validated) {
      return true;
    }
    if (isFiniteNumber(gamepad.timestamp) && gamepad.timestamp > 0) {
      state.validated = true;
      return true;
    }
    // The input is compared only with a baseline of the same button and axis count; another count takes a new baseline
    const buttons = gamepad.buttons || [];
    const axes = gamepad.axes || [];
    const baseline = state.baseline;
    if (!baseline || baseline.buttons.length !== buttons.length || baseline.axes.length !== axes.length) {
      state.baseline = recordBaseline(buttons, axes);
      return false;
    }
    if (!hasInputChanged(buttons, axes, baseline)) {
      return false;
    }
    state.validated = true;
    state.byInput = true;
    validatedByInput.push(slot);
    // The timestamp as it reads, which is 0 on Tizen 5.5 (the log line of PollGamepads() in wasm/gamepad.cpp names it too)
    console.log('%c[gamepad.js, isRealGamepad]', 'color: gray;', 'Gamepad ' + slot + ' reports a timestamp of ' + gamepad.timestamp + ' and counts as a controller since its input changed: ' + formatGamepadInfo(describeGamepad(gamepad)));
    return true;
  }

  // Tell the UI about the slots that counted by a change of their input with a 'gamepadvalidated' event for each, so it
  // lists them: System information, the Stream Menu and the controllers of the button mapping (index.js). The polling
  // of the menus sends them once it gathered the evidence of every slot and before the menus get the input of that
  // poll, so the entry that such a controller brings (Mouse emulation in the Stream Menu, Calibrate the sticks in the
  // button mapping) already shows when the press that made it count moves the selection. It also sends them for a slot
  // that another reader validated before (e.g. the input test), and a listener never runs inside a reader such as
  // getConnectedGamepads(). With nothing pending it returns at once.
  function reportValidatedGamepads() {
    if (validatedByInput.length === 0) {
      return;
    }
    const slots = validatedByInput;
    validatedByInput = [];
    slots.forEach((index) => {
      window.dispatchEvent(new CustomEvent('gamepadvalidated', { detail: { gamepad: index } }));
    });
  }

  // Record the evidence of every slot of a read of the gamepads: an empty slot forgets its evidence
  function observeGamepads(connectedGamepads) {
    Object.keys(evidence).forEach((index) => {
      if (!connectedGamepads[index]) {
        delete evidence[index];
      }
    });
    for (let i = 0; i < connectedGamepads.length; i++) {
      if (connectedGamepads[i]) {
        isRealGamepad(connectedGamepads[i], i);
      }
    }
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
    observeGamepads(connectedGamepads);
    const result = [];
    for (let i = 0; i < connectedGamepads.length; i++) {
      if (isRealGamepad(connectedGamepads[i], i)) {
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
      // A controller whose button or axis count changed (e.g. one switched to another mode), or another gamepad in the
      // slot that the polling reads before the browser's events for the change (Chromium M69 of Tizen 5.5 queues the
      // disconnect and connect events for a new id after the read; newer versions send them inside getGamepads()). The
      // input that the old snapshot holds ends, and a fresh snapshot replaces it instead of rejecting every later one,
      // but only for a gamepad that counts as a controller: one that doesn't yet (e.g. one with a timestamp of 0 that
      // sent no input of its own, see isRealGamepad()) gets none here. The connection event that Chromium M69 sends
      // after the read still takes one in gamepadConnected(), as for any gamepad that the browser announces, so a button
      // that it holds presses once in the menus instead of twice. Without that event, the branch below takes it once it
      // counts, like a controller found without a connection event.
      const counts = isRealGamepad(gamepad);
      console.log('%c[gamepad.js, analyzeGamepad]', 'color: gray;', 'Gamepad ' + index + ' changed its layout or was replaced, ' +
        (counts ? 'taking a new snapshot: ' : 'dropping its snapshot until it counts as a controller: ') + formatGamepadInfo(describeGamepad(gamepad)));
      endHeldInput(index);
      if (!counts) {
        delete gamepads[index];
        return;
      }
      pGamepad = gamepads[index] = new Gamepad(gamepad, true);
    } else if (!pGamepad && isRealGamepad(gamepad)) {
      // A controller that never fired a gamepadconnected event, e.g. one that was announced before the listener was
      // added. One that counted by a change of its input (a timestamp of 0, see isRealGamepad()) starts from its
      // baseline, the buttons and sticks as the menus first saw them, so the press or stick move that made it count
      // moves the menus. A button held since then (e.g. a combo held when the stream ended, see resetGamepads()) is no
      // evidence and no new press: such a controller counts on its release, which the menus only take as the end of a
      // repeat, and its next press moves them.
      console.log('%c[gamepad.js, analyzeGamepad]', 'color: gray;', 'Found gamepad ' + index + ' without a connection event: ' + formatGamepadInfo(describeGamepad(gamepad)));
      const state = evidence[index];
      const baseline = state && state.byInput ? state.baseline : null;
      pGamepad = gamepads[index] = baseline ? new Gamepad({ id: gamepad.id, buttons: baseline.buttons, axes: baseline.axes }, false) :
        new Gamepad(gamepad, true);
    }

    if (pGamepad) {
      pGamepad.analyzeButtonsAndAxes(index, gamepad.buttons, gamepad.axes);
    }
  }

  function pollGamepads() {
    const now = performance.now();
    const sinceLastPoll = lastPollAt === null ? 0 : now - lastPollAt;
    pollLateBy = sinceLastPoll >= LATE_POLL_MS ? sinceLastPoll - MENU_POLL_INTERVAL_MS : 0;
    lastPollAt = now;
    const connectedGamepads = readGamepads();
    // Gather the evidence of every slot, also of a controller that the menus know from its connection event, so that
    // System information, the button mapping and the mask of a stream start count it
    observeGamepads(connectedGamepads);
    // Before the menus get the input, so the UI lists a controller that counts by this input before it moves the
    // selection (see reportValidatedGamepads())
    reportValidatedGamepads();
    for (let i = 0; i < connectedGamepads.length; i++) {
      if (connectedGamepads[i]) {
        analyzeGamepad(connectedGamepads[i]);
      }
    }
    // A slot validated after the report above (by a listener of that report or of the input that reads the gamepads
    // again through getConnectedGamepads(), whose read can be newer, or by a gamepad whose index differs from its slot
    // in the read) is told now rather than a poll later
    reportValidatedGamepads();
    // What is reported outside a read (the end of the input of a gamepad that disconnects) is not late
    pollLateBy = 0;
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
      lastPollAt = null;
      pollingInterval = setInterval(pollGamepads, MENU_POLL_INTERVAL_MS);
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
    isRealGamepad,
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
  // The gamepads that a rumble of the host found missing or unable to rumble, by index: the log gets the warning once
  // per rumble, not with each change of its strength, which a game sends up to 60 times per second. stop() forgets the
  // gamepad, so the next rumble warns again.
  const warned = {};

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
    snackbarLogLong('Controller %1$s (%2$s) does not support rumble on this TV.', index, name ? name : t('Unknown'));
  }

  function clearReplay(index) {
    if (active[index]) {
      clearInterval(active[index].timer);
      delete active[index];
    }
  }

  // Run a warning about the rumble of a gamepad, unless this rumble already had one (see `warned`)
  function warnOnce(index, warn) {
    if (!warned[index]) {
      warned[index] = true;
      warn();
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
      warnOnce(index, () => reportUnsupported(index, gamepad, error));
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
    delete warned[index];
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
      warnOnce(index, () => console.warn('%c[gamepad.js, Rumble]', 'color: gray;', 'Warning: No gamepad ' + index + ' to play the rumble on.'));
      return;
    }
    if (!canPlayEffects(gamepad)) {
      clearReplay(index);
      warnOnce(index, () => reportUnsupported(index, gamepad, 'it has no vibration actuator'));
      return;
    }
    // Play it now and again every REPLAY_INTERVAL_MS from now on, until the host sends 0
    clearReplay(index);
    const rumble = { weakMagnitude, strongMagnitude, timer: null };
    active[index] = rumble;
    rumble.timer = setInterval(() => replay(index), REPLAY_INTERVAL_MS);
    playEffect(index, gamepad, rumble);
  }

  // Stop every rumble that is still on, when the stream ends, and forget the warnings of its rumbles
  function stopAll() {
    Object.keys(active).forEach((index) => stop(Number(index)));
    Object.keys(warned).forEach((index) => delete warned[index]);
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
