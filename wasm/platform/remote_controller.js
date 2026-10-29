// Check if a key event comes from a key that opens the menus: Play/Pause, Play or Pause of the remote. The Pause/Break
// key of a keyboard has the key code of Pause as well, but is named 'Pause', and goes to the PC during a stream.
function isMenuKeyEvent(e) {
  const keyCode = e.keyCode;
  return keyCode === tvKey.KEY_PLAY_PAUSE || keyCode === tvKey.KEY_PLAY || (keyCode === tvKey.KEY_PAUSE && e.key !== 'Pause');
}

function remoteControllerHandler(e) {
  const keyCode = e.keyCode;
  const target = e.target || {};

  // The arrow keys move the focus of the menus, which scroll it into view (launcher.js): the browser mustn't scroll as
  // well, except in a text field or a list, which need the keys, and during a stream
  if (keyCode >= tvKey.KEY_LEFT && keyCode <= tvKey.KEY_DOWN && isInGame !== true && !target.isContentEditable &&
    (!/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || /^(checkbox|radio|range)$/.test(target.type))) {
    e.preventDefault();
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
