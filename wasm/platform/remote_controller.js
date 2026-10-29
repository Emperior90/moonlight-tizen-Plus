// Check if a key event comes from a key that opens the menus: Play/Pause, Play or Pause of the remote. The Pause/Break
// key of a keyboard has the key code of Pause as well, but is named 'Pause', and goes to the PC during a stream.
function isMenuKeyEvent(e) {
  const keyCode = e.keyCode;
  return keyCode === tvKey.KEY_PLAY_PAUSE || keyCode === tvKey.KEY_PLAY || (keyCode === tvKey.KEY_PAUSE && e.key !== 'Pause');
}

function remoteControllerHandler(e) {
  const keyCode = e.keyCode;

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
      // Toggle performance stats overlay
      if (isInGame === true) {
        Module.toggleStats();
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
