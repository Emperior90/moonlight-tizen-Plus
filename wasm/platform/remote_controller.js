// Check if a key event comes from a key that opens the menus: Play/Pause, Play or Pause of the remote. The Pause/Break
// key of a keyboard has the key code of Pause as well, but is named 'Pause', and goes to the PC during a stream.
function isMenuKeyEvent(e) {
  const keyCode = e.keyCode;
  return keyCode === tvKey.KEY_PLAY_PAUSE || keyCode === tvKey.KEY_PLAY || (keyCode === tvKey.KEY_PAUSE && e.key !== 'Pause');
}

// A held arrow key repeats faster than a slow TV shows the steps of the focus (each one moves the mark and fills the
// hero, launcher.js), so the repeats queued up behind the steps and the selection ran on after the key was let go. A
// repeat that the remote sent before the last arrow step reached the screen is dropped instead: the selection moves as
// fast as the TV can show it and stops with the key. A press that is no repeat always moves. Repeats are dropped for
// ARROW_REPEAT_DROP_MAX_MS after the last arrow step at most, so that a held key still moves if the time of the key
// events (Event.timeStamp) runs on another clock than performance.now() on a TV, or a frame never comes.
const ARROW_REPEAT_DROP_MAX_MS = 500;
let arrowStepShownAt = 0; // When the frame of the last arrow step was done (performance.now()), Infinity until then
let arrowStepsPending = 0; // The arrow steps whose frame is not done yet
let arrowStepAt = -Infinity; // When the last arrow step was handled (performance.now()), initial value is -Infinity

function isStaleArrowRepeat(e) {
  return e.repeat === true && typeof e.timeStamp === 'number' && e.timeStamp > 0 && e.timeStamp < arrowStepShownAt &&
    typeof performance !== 'undefined' && performance.now() - arrowStepAt < ARROW_REPEAT_DROP_MAX_MS;
}

// Note an arrow step: it is on the screen once its animation frame ran (the task after the frame)
function noteArrowStep() {
  if (typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') {
    return;
  }
  arrowStepAt = performance.now();
  arrowStepShownAt = Infinity;
  arrowStepsPending++;
  requestAnimationFrame(function() {
    setTimeout(function() {
      arrowStepsPending--;
      if (arrowStepsPending === 0) {
        arrowStepShownAt = performance.now();
      }
    }, 0);
  });
}

function remoteControllerHandler(e) {
  const keyCode = e.keyCode;
  const target = e.target || {};
  const isArrowKey = keyCode >= tvKey.KEY_LEFT && keyCode <= tvKey.KEY_DOWN;

  // The arrow keys move the focus of the menus, which scroll it into view (launcher.js): the browser mustn't scroll as
  // well, except in a text field or a list, which need the keys, and during a stream
  if (isArrowKey && isInGame !== true && !target.isContentEditable &&
    (!/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || /^(checkbox|radio|range)$/.test(target.type))) {
    e.preventDefault();
  }
  if (isArrowKey && isInGame !== true) {
    if (isStaleArrowRepeat(e)) {
      return;
    }
    noteArrowStep();
  }

  switch (keyCode) {
    case tvKey.KEY_UP:
      // Navigate in the up direction
      Navigation.up();
      break;
    case tvKey.KEY_DOWN:
      // Navigate in the down direction
      Navigation.down();
      break;
    case tvKey.KEY_LEFT:
      // Navigate in the left direction
      Navigation.left();
      break;
    case tvKey.KEY_RIGHT:
      // Navigate in the right direction
      Navigation.right();
      break;
    case tvKey.KEY_ENTER:
    case tvKey.KEY_REMOTE_ENTER:
      e.preventDefault(); // Prevent native asynchronous click
      // Ignore the auto-repeat of a held key: the views change at once, so an OK held a little too long would otherwise
      // also press the item of the next view, e.g. start the app that is selected after opening a host
      if (e.repeat) {
        break;
      }
      // Select the current item
      Navigation.accept();
      break;
    case tvKey.KEY_RETURN:
      // Go back or cancel the operation
      Navigation.back();
      break;
    case tvKey.KEY_VOLUME_UP:
      // Increase the volume
      tizen.tvaudiocontrol.setVolumeUp();
      break;
    case tvKey.KEY_VOLUME_DOWN:
      // Decrease the volume
      tizen.tvaudiocontrol.setVolumeDown();
      break;
    case tvKey.KEY_VOLUME_MUTE:
      // Mute the volume
      tizen.tvaudiocontrol.setMute();
      break;
    case tvKey.KEY_CHANNEL_UP:
      // Triggers the press action
      Navigation.press();
      break;
    case tvKey.KEY_CHANNEL_DOWN:
      // Triggers the switch action
      Navigation.switch();
      break;
    case tvKey.KEY_RED:
      // Ignore the auto-repeat of a held key
      if (e.repeat) {
        break;
      }
      if (isInGame === true && !wasmSessionStarted) {
        // The stream is still starting, so cancel its start instead of stopping a session that doesn't exist yet
        cancelStreamLaunch();
      } else if (isInGame === true) {
        // Terminate the connection
        Module.stopStream();
      }
      break;
    case tvKey.KEY_YELLOW:
      // Step the performance stats overlay to its next level: Off, Compact, Full, Off
      if (isInGame === true && wasmSessionStarted) {
        Module.toggleStats();
      } else if (isInGame === true) {
        // The stream is still starting ('Starting...'): step the setting, which the start request then hands to the
        // module. The module may still hold the level of an earlier stream, which its start request replaces.
        savePerformanceStatsLevel((getPerformanceStatsLevel() + 1) % 3);
      }
      break;
    case tvKey.KEY_PLAY_PAUSE:
    case tvKey.KEY_PLAY:
    case tvKey.KEY_PAUSE:
      // Ignore the auto-repeat of a held key and the Pause/Break key of a keyboard
      if (e.repeat || !isMenuKeyEvent(e)) {
        break;
      }
      e.preventDefault();
      if (isInGame === true) {
        // Open or close the Stream Menu (menus.js)
        toggleStreamMenu();
      } else {
        // Open the menu of the current host or app, like CH+
        Navigation.press();
      }
      break;
    default:
      break;
  }
}
