// Button mapping and stick calibration of the controllers (Settings > Input Settings > Button mapping). Each of the 16
// buttons of the standard layout up to the D-pad can press another button in games, or none, for every controller or
// for one controller (by its id), and the sticks of a controller can be calibrated: their centre and how far they reach.
// The stream applies both in the WebAssembly module (wasm/controller_mapping.hpp, gamepad.cpp), after the button combos
// ran on the physical buttons, so Select + Start still opens the Stream Menu; the menus of the app always see the buttons
// as they are. This replaces the switches 'Flip A/B face buttons' and 'Flip X/Y face buttons', whose stored values
// become the mapping for every controller (migrateFaceButtonSwaps()).
// Remapping per controller follows the fork of samirmartins (moonlight-tizen, 6a7ca6d, controller-mapping.js and
// controller-mapping-menu.js), the calibration of the centre and range of each stick the branch joystick-calibration of
// the fork of waresz (874e257 and 9940da6, joystick_calibration.js), without its fixed dead zone.

// ===== The stored mapping =====

const MAPPED_BUTTON_COUNT = 16;
const MAPPED_BUTTON_NONE = -1;
// The key of the mapping for every controller without one of its own (kAllControllersId of controller_mapping.hpp)
const ALL_CONTROLLERS_ID = '*';
// The bytes of a controller id that the stream sees (kControllerIdBytes of controller_mapping.hpp)
const CONTROLLER_ID_BYTES = 63;
// The names of the buttons of the standard layout, in the Xbox layout like the Navigation Guide (A is the bottom button)
const MAPPED_BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'SELECT', 'START', 'LS', 'RS',
  'D-PAD UP', 'D-PAD DOWN', 'D-PAD LEFT', 'D-PAD RIGHT'];
// The least distance from the centre to each end of a calibrated axis, and the farthest centre from 0
// (kMinCalibratedRange and kMaxCalibratedCentre of controller_mapping.hpp)
const CALIBRATION_MIN_RANGE = 0.25;
const CALIBRATION_MAX_CENTRE = 0.5;

// Each button pressing itself
function identityButtons() {
  const buttons = [];
  for (let i = 0; i < MAPPED_BUTTON_COUNT; i++) {
    buttons.push(i);
  }
  return buttons;
}

function isIdentityButtons(buttons) {
  return buttons.every((target, index) => target === index);
}

// The stored mapping without any change: { version, controllers: { id: { name, buttons, sticks } } }
function emptyButtonMappings() {
  return { version: 1, controllers: {} };
}

function isValidButtons(buttons) {
  return Array.isArray(buttons) && buttons.length === MAPPED_BUTTON_COUNT &&
    buttons.every((target) => Number.isInteger(target) && target >= MAPPED_BUTTON_NONE && target < MAPPED_BUTTON_COUNT);
}

// Check the values of one axis like IsCalibratedAxis() of controller_mapping.hpp
function isCalibratedAxis(centre, minimum, maximum) {
  return [centre, minimum, maximum].every((value) => typeof value === 'number' && isFinite(value)) &&
    Math.abs(centre) <= CALIBRATION_MAX_CENTRE && minimum >= -1 && maximum <= 1 &&
    centre - minimum >= CALIBRATION_MIN_RANGE && maximum - centre >= CALIBRATION_MIN_RANGE;
}

function isValidStick(stick) {
  return !!stick && isCalibratedAxis(stick.centreX, stick.minX, stick.maxX) && isCalibratedAxis(stick.centreY, stick.minY, stick.maxY);
}

// A stored value as a valid mapping: what can't be read is left out, and anything else gives the empty mapping
function normalizeButtonMappings(value) {
  const result = emptyButtonMappings();
  if (!value || typeof value !== 'object' || !value.controllers || typeof value.controllers !== 'object') {
    return result;
  }
  Object.keys(value.controllers).forEach((id) => {
    const entry = value.controllers[id];
    if (!entry || typeof entry !== 'object' || !id || /[\r\n]/.test(id)) {
      return;
    }
    const normalized = { name: typeof entry.name === 'string' ? entry.name : '' };
    if (isValidButtons(entry.buttons)) {
      normalized.buttons = entry.buttons.slice();
    }
    if (id !== ALL_CONTROLLERS_ID && Array.isArray(entry.sticks) && entry.sticks.length === 2 && entry.sticks.some(isValidStick)) {
      normalized.sticks = entry.sticks.map((stick) => (isValidStick(stick) ? Object.assign({}, stick) : null));
    }
    if (normalized.buttons || normalized.sticks) {
      result.controllers[id] = normalized;
    }
  });
  return result;
}

// The mapping that the earlier switches 'Flip A/B face buttons' and 'Flip X/Y face buttons' stand for: A and B, or X
// and Y, swapped for every controller
function migrateFaceButtonSwaps(flipAB, flipXY) {
  const mappings = emptyButtonMappings();
  if (flipAB || flipXY) {
    const buttons = identityButtons();
    if (flipAB) {
      buttons[0] = 1;
      buttons[1] = 0;
    }
    if (flipXY) {
      buttons[2] = 3;
      buttons[3] = 2;
    }
    mappings.controllers[ALL_CONTROLLERS_ID] = { name: '', buttons: buttons };
  }
  return mappings;
}

// The id of a controller as the stream sees it: at most 63 bytes of UTF-8, cut before a character that doesn't fit, as
// Emscripten fills the id of its gamepad event
function streamControllerId(id) {
  const text = String(id || '');
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    const length = code < 0x80 ? 1 : (code < 0x800 ? 2 : (code < 0x10000 ? 3 : 4));
    if (bytes + length > CONTROLLER_ID_BYTES) {
      break;
    }
    bytes += length;
    end += character.length;
  }
  return text.slice(0, end);
}

// The buttons that a controller gets: its own, else those for every controller, else each button pressing itself
function getMappingButtons(mappings, id) {
  const own = mappings.controllers[id];
  if (own && own.buttons) {
    return own.buttons.slice();
  }
  const all = mappings.controllers[ALL_CONTROLLERS_ID];
  return all && all.buttons ? all.buttons.slice() : identityButtons();
}

// A copy of the mapping with a changed entry, which goes when nothing is left of it
function withMappingEntry(mappings, id, change) {
  const result = normalizeButtonMappings(mappings);
  const entry = Object.assign({ name: '' }, result.controllers[id] || {});
  change(entry);
  if (entry.buttons && id === ALL_CONTROLLERS_ID && isIdentityButtons(entry.buttons)) {
    delete entry.buttons;
  }
  if (entry.buttons || entry.sticks) {
    result.controllers[id] = entry;
  } else {
    delete result.controllers[id];
  }
  return result;
}

// Let a button of a controller (or of every controller) press another button, or none (MAPPED_BUTTON_NONE)
function setMappedButton(mappings, id, name, button, target) {
  return withMappingEntry(mappings, id, (entry) => {
    entry.buttons = getMappingButtons(mappings, id);
    entry.buttons[button] = target;
    if (name) {
      entry.name = name;
    }
  });
}

// The next target of a button in a direction (-1 or 1): the buttons of the standard layout, then none
function stepMappedButton(target, direction) {
  const count = MAPPED_BUTTON_COUNT + 1;
  const position = target === MAPPED_BUTTON_NONE ? MAPPED_BUTTON_COUNT : target;
  const next = (position + direction + count) % count;
  return next === MAPPED_BUTTON_COUNT ? MAPPED_BUTTON_NONE : next;
}

// Forget the buttons and the calibration of a controller, or the mapping for every controller
function resetControllerMapping(mappings, id) {
  return withMappingEntry(mappings, id, (entry) => {
    delete entry.buttons;
    delete entry.sticks;
  });
}

// Keep the calibration of the sticks of a controller: [left, right], each one or null
function setStickCalibration(mappings, id, name, sticks) {
  return withMappingEntry(mappings, id, (entry) => {
    entry.sticks = sticks && sticks.some(isValidStick) ? sticks.map((stick) => (isValidStick(stick) ? stick : null)) : undefined;
    if (!entry.sticks) {
      delete entry.sticks;
    }
    if (name) {
      entry.name = name;
    }
  });
}

// The range of the axes 0 to 3 while the sticks are moved around their edge: the lowest, the highest and the last value
// of each axis and the number of readings. The calibration keeps these instead of every reading, so a calibration that
// is left open for long neither grows nor takes longer per reading.
function newStickRange() {
  return { count: 0, min: [0, 0, 0, 0], max: [0, 0, 0, 0], last: [0, 0, 0, 0] };
}

// Add a reading of the axes 0 to 3 to a range of newStickRange(), and return the range
function addStickRangeReading(range, reading) {
  for (let axis = 0; axis < 4; axis++) {
    const value = Number(reading[axis]) || 0;
    range.min[axis] = range.count === 0 || value < range.min[axis] ? value : range.min[axis];
    range.max[axis] = range.count === 0 || value > range.max[axis] ? value : range.max[axis];
    range.last[axis] = value;
  }
  range.count++;
  return range;
}

// The calibration of the sticks from the axes read while they rested and while they were moved around their edge (each
// reading the values of axes 0 to 3, the moves as a list of readings or as their range, newStickRange()): the centre is
// the average at rest, the ends the lowest and highest values. A stick without enough range on both sides, or with a
// centre far off, gets none (null).
function computeStickCalibration(restReadings, moveReadings) {
  const range = Array.isArray(moveReadings) ? moveReadings.reduce(addStickRangeReading, newStickRange()) : moveReadings;
  const sticks = [0, 1].map((stick) => {
    const x = stick * 2;
    const y = x + 1;
    if (restReadings.length === 0 || !range || range.count === 0) {
      return null;
    }
    const average = (axis) => restReadings.reduce((sum, reading) => sum + (Number(reading[axis]) || 0), 0) / restReadings.length;
    const calibration = {
      centreX: average(x),
      centreY: average(y),
      minX: Math.max(-1, range.min[x]),
      maxX: Math.min(1, range.max[x]),
      minY: Math.max(-1, range.min[y]),
      maxY: Math.min(1, range.max[y]),
    };
    Object.keys(calibration).forEach((key) => {
      calibration[key] = Math.round(calibration[key] * 10000) / 10000;
    });
    return isValidStick(calibration) ? calibration : null;
  });
  return sticks;
}

// The text of the mapping for the stream (the format of controller_mapping.hpp): one line per controller with a mapping
// of its own, and one for every controller, each '<16 targets>;<calibration>;<id>'
function serializeButtonMappings(mappings) {
  const normalized = normalizeButtonMappings(mappings);
  const lines = [];
  const all = normalized.controllers[ALL_CONTROLLERS_ID];
  if (all && all.buttons) {
    lines.push(all.buttons.join(',') + ';;' + ALL_CONTROLLERS_ID);
  }
  Object.keys(normalized.controllers).forEach((id) => {
    if (id === ALL_CONTROLLERS_ID) {
      return;
    }
    const entry = normalized.controllers[id];
    const calibration = entry.sticks ? entry.sticks.map((stick) => {
      const s = stick || { centreX: 0, centreY: 0, minX: -1, maxX: 1, minY: -1, maxY: 1 };
      return [s.centreX, s.centreY, s.minX, s.maxX, s.minY, s.maxY].join(',');
    }).join(',') : '';
    lines.push(getMappingButtons(normalized, id).join(',') + ';' + calibration + ';' + id);
  });
  return lines.join('\n');
}

// The stored mapping of this TV (loaded with the other settings, loadStoredSettings() in index.js)
let buttonMappings = emptyButtonMappings();

// Keep a changed mapping and store it
function saveButtonMappings(mappings) {
  buttonMappings = normalizeButtonMappings(mappings);
  if (typeof storeData === 'function') {
    storeData('controllerMappings', buttonMappings, null);
  }
}

// ===== The menu of the button mapping =====

const ButtonMappingMenu = (function() {
  // The controller whose mapping is shown, and the readings of the calibration
  let selectedId = ALL_CONTROLLERS_ID;
  let calibration = null; // { id, name, step: 'rest' | 'move', rest: [], move: newStickRange(), timer }
  const CALIBRATION_POLL_MS = 20;
  // Readings at rest that make the centre
  const REST_READINGS = 25;

  // The controllers to choose from: every controller, those connected now, and those with a mapping of their own
  function getControllers() {
    const controllers = [{ id: ALL_CONTROLLERS_ID, name: t('All controllers'), connected: false }];
    Controller.getConnectedGamepads().forEach((info) => {
      const id = streamControllerId(info.id);
      if (!controllers.some((entry) => entry.id === id)) {
        controllers.push({ id: id, name: info.name || t('Unknown'), connected: true, index: info.index });
      }
    });
    Object.keys(buttonMappings.controllers).forEach((id) => {
      if (id !== ALL_CONTROLLERS_ID && !controllers.some((entry) => entry.id === id)) {
        controllers.push({ id: id, name: buttonMappings.controllers[id].name || id, connected: false });
      }
    });
    return controllers;
  }

  function getSelected() {
    const controllers = getControllers();
    return controllers.filter((entry) => entry.id === selectedId)[0] || controllers[0];
  }

  function targetName(target) {
    return target === MAPPED_BUTTON_NONE ? t('None') : t(MAPPED_BUTTON_NAMES[target]);
  }

  // Show the rows of the selected controller
  function render() {
    const selected = getSelected();
    selectedId = selected.id;
    const buttons = getMappingButtons(buttonMappings, selected.id);
    const own = buttonMappings.controllers[selected.id];
    $('#buttonMappingController').text(selected.name);
    let note = t('Xbox layout: A = bottom button');
    if (selected.id !== ALL_CONTROLLERS_ID) {
      note = own && own.buttons ? t('Own buttons') : t('Buttons of all controllers');
      if (own && own.sticks) {
        note += ' · ' + t('Sticks calibrated');
      }
    }
    $('#buttonMappingSubtitle').text(note);
    for (let i = 0; i < MAPPED_BUTTON_COUNT; i++) {
      const value = document.getElementById('buttonMappingValue' + i);
      if (value) {
        value.textContent = targetName(buttons[i]);
        value.classList.toggle('is-pending', buttons[i] !== i);
      }
    }
    // A calibration needs a controller that is connected
    $('#buttonMappingCalibrate').prop('hidden', !selected.connected);
  }

  function open() {
    selectedId = ALL_CONTROLLERS_ID;
    calibration = null;
    $('#buttonMappingPanel').show();
    $('#buttonCalibrationPanel').hide();
    render();
    $('#buttonMappingOverlay').css('display', 'flex');
    isDialogOpen = true;
    Views.ButtonMappingMenu.view.index = 0;
    Navigation.push(Views.ButtonMappingMenu);
    Navigation.switch();
  }

  function close() {
    stopCalibration();
    $('#buttonMappingOverlay').css('display', 'none');
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
  }

  // LEFT or RIGHT on a row: the next controller, or the next target of a button
  function step(item, direction) {
    const id = item ? item.id : '';
    if (id === 'buttonMappingSelect') {
      const controllers = getControllers();
      let index = 0;
      controllers.forEach((entry, i) => {
        if (entry.id === selectedId) {
          index = i;
        }
      });
      selectedId = controllers[(index + direction + controllers.length) % controllers.length].id;
      render();
      return;
    }
    const match = /^buttonMappingRow(\d+)$/.exec(id);
    if (match) {
      const button = Number(match[1]);
      const selected = getSelected();
      const target = stepMappedButton(getMappingButtons(buttonMappings, selected.id)[button], direction);
      saveButtonMappings(setMappedButton(buttonMappings, selected.id, selected.connected ? selected.name : '', button, target));
      console.log('%c[button_mapping.js, step]', 'color: teal;', 'Button ' + MAPPED_BUTTON_NAMES[button] + ' of ' +
        (selected.id === ALL_CONTROLLERS_ID ? 'all controllers' : 'controller "' + selected.name + '"') + ' presses ' +
        (target === MAPPED_BUTTON_NONE ? 'nothing' : MAPPED_BUTTON_NAMES[target]));
      render();
    }
  }

  function reset() {
    const selected = getSelected();
    saveButtonMappings(resetControllerMapping(buttonMappings, selected.id));
    render();
    if (selected.id === ALL_CONTROLLERS_ID) {
      snackbarLog('The buttons of all controllers are as printed again.');
    } else {
      snackbarLog('The buttons and sticks of %1$s are reset.', selected.name);
    }
  }

  // ===== Calibration =====

  function readAxes(index) {
    const gamepads = (navigator.getGamepads && navigator.getGamepads()) || [];
    const gamepad = gamepads[index];
    if (!gamepad || !gamepad.axes || gamepad.axes.length < 4 || streamControllerId(gamepad.id) !== calibration.id) {
      return null;
    }
    return [gamepad.axes[0], gamepad.axes[1], gamepad.axes[2], gamepad.axes[3]];
  }

  // The value of an axis while the sticks move, with the lowest and highest value so far
  function formatRange(range, axis) {
    return range.count === 0 ? '-' : range.last[axis].toFixed(2) + ' (' + range.min[axis].toFixed(2) + ' … ' +
      range.max[axis].toFixed(2) + ')';
  }

  // Show the step of the calibration and what the sticks report
  function renderCalibration() {
    if (calibration.step === 'rest') {
      $('#buttonCalibrationText').text(t('Leave both sticks at rest, then press OK. RETURN cancels.'));
      $('#buttonCalibrationContinueLabel').text(t('Continue'));
    } else {
      $('#buttonCalibrationText').text(t('Move both sticks slowly around their edge two or three times, then press OK.'));
      $('#buttonCalibrationContinueLabel').text(t('Save'));
    }
    const rest = calibration.rest;
    const last = rest.length > 0 ? rest[rest.length - 1] : [0, 0, 0, 0];
    const axisText = (axis) => calibration.step === 'rest' ? last[axis].toFixed(2) : formatRange(calibration.move, axis);
    $('#buttonCalibrationValues').text(
      t('Left stick: X %1$s, Y %2$s', axisText(0), axisText(1)) + '\n' + t('Right stick: X %1$s, Y %2$s', axisText(2), axisText(3)));
  }

  function poll() {
    const axes = readAxes(calibration.index);
    if (!axes) {
      return;
    }
    if (calibration.step === 'rest') {
      calibration.rest.push(axes);
      if (calibration.rest.length > REST_READINGS) {
        calibration.rest.shift();
      }
    } else {
      addStickRangeReading(calibration.move, axes);
    }
    renderCalibration();
  }

  function startCalibration() {
    const selected = getSelected();
    if (!selected.connected) {
      return;
    }
    calibration = { id: selected.id, name: selected.name, index: selected.index, step: 'rest', rest: [], move: newStickRange(), timer: null };
    $('#buttonCalibrationTitle').text(t('Calibrate the sticks of %1$s', selected.name));
    $('#buttonMappingPanel').hide();
    $('#buttonCalibrationPanel').show();
    renderCalibration();
    calibration.timer = setInterval(poll, CALIBRATION_POLL_MS);
    Views.ButtonCalibration.view.index = 0;
    Navigation.change(Views.ButtonCalibration);
    Navigation.switch();
  }

  function stopCalibration() {
    if (calibration && calibration.timer) {
      clearInterval(calibration.timer);
    }
    calibration = null;
  }

  // Back to the rows of the mapping. A stick that was moved or is still held for the calibration doesn't move the focus.
  function leaveCalibration() {
    stopCalibration();
    if (typeof cancelGamepadNavigation === 'function') {
      cancelGamepadNavigation();
    }
    $('#buttonCalibrationPanel').hide();
    $('#buttonMappingPanel').show();
    render();
    Navigation.change(Views.ButtonMappingMenu);
    Navigation.switch();
  }

  // OK: from rest to moving, then keep the calibration
  function continueCalibration() {
    if (!calibration) {
      return;
    }
    if (calibration.step === 'rest') {
      if (calibration.rest.length === 0) {
        snackbarLog('%1$s doesn\'t report its sticks. Move a stick, then try again.', calibration.name);
        return;
      }
      calibration.step = 'move';
      calibration.move = newStickRange();
      renderCalibration();
      return;
    }
    const sticks = computeStickCalibration(calibration.rest, calibration.move);
    if (!sticks[0] && !sticks[1]) {
      snackbarLogLong('The sticks didn\'t move far enough to calibrate them. Move them around their whole edge.');
      calibration.step = 'rest';
      calibration.rest = [];
      renderCalibration();
      return;
    }
    saveButtonMappings(setStickCalibration(buttonMappings, calibration.id, calibration.name, sticks));
    console.log('%c[button_mapping.js, continueCalibration]', 'color: teal;', 'Calibrated the sticks of controller "' +
      calibration.name + '": ' + JSON.stringify(sticks));
    if (sticks[0] && sticks[1]) {
      snackbarLog('The sticks are calibrated.');
    } else {
      snackbarLog('Only one stick moved far enough, so only it is calibrated.');
    }
    leaveCalibration();
  }

  return {
    open: open,
    close: close,
    step: step,
    reset: reset,
    startCalibration: startCalibration,
    continueCalibration: continueCalibration,
    cancelCalibration: leaveCalibration,
    render: render,
  };
})();
