// Initialize global variables and constants
var tvCapabilities = detectTvCapabilities(); // Detect the model, panel, HDR support and Tizen version of the TV (tv_profile.js), with fallbacks for every API that fails
var appInfo = safeTvCall('application information', function() {
  return tizen.application.getAppInfo();
}, { id: '', packageId: '', name: 'Moonlight', version: '' }); // Retrieve the application information
var platformVer = tvCapabilities.platformVer; // Device platform version
var modelSeries = tvCapabilities.modelSeries; // Device model series
var modelName = tvCapabilities.modelName; // Device model name
var modelGroup = tvCapabilities.modelCode; // Device model group
var is4kPanel = tvCapabilities.is4k; // Whether the device has a 4K panel
var is8kPanel = tvCapabilities.is8k; // Whether the device has an 8K panel
var maxSupportedWidth = tvCapabilities.maxWidth; // Width of the highest resolution the resolution menu offers
var maxSupportedHeight = tvCapabilities.maxHeight; // Height of the highest resolution the resolution menu offers
var isHdrCapable = tvCapabilities.isHdr; // Whether the device supports HDR
var wasmPlayerFeatures = tvCapabilities.wasmPlayer; // Whether the WASM player offers the Ultra Low Latency mode that the game mode asks for
var videoDecoderProbe = tvCapabilities.videoDecoders; // Answers of the browser about the video codecs of the WASM player, only shown and used for hints
var hosts = {}; // Hosts is an associative array of NvHTTP objects, keyed by server UID
var isHostOpening = false; // Prevents concurrent hostChosen executions, initial value is false
var isHostsLoaded = false; // Indicates if IndexedDB has finished loading hosts
var isSubnetScanFinished = false; // Indicates if the initial subnet scan has completed
var activePolls = {}; // Hosts currently being polled. An associated array of polling IDs, keyed by server UID
var pollGenerations = {}; // Number of the latest start of the polling of each host, keyed by server UID
var pairingCert; // Loads the generated certificate
var myUniqueid;
var api; // The `api` should only be set if we're in a host-specific screen, on the initial screen it should always be null
var isInGame = false; // Flag indicating whether the game has started, initial value is false
var streamLaunchId = 0; // Number of the latest stream launch, which replies of an older or cancelled launch are ignored by, initial value is 0
var streamLaunchHost = null; // Host of the latest stream launch, initial value is null
var streamLaunchAppTitle = ''; // Title of the app of the latest stream launch, which the Stream Menu shows, initial value is empty
var wasmSessionStarted = false; // Flag indicating whether the start request of the current stream reached the WASM module, initial value is false
var isDialogOpen = false; // Flag indicating whether the dialog is open, initial value is false
var isPairingInProgress = false; // Flag indicating whether a pairing process is in progress, initial value is false
var wasPairingCanceled = false; // Flag indicating whether the current pairing process was canceled by the user, initial value is false
var isClickPrevented = false; // Flag indicating whether the click event should be prevented, initial value is false
var resFpsWarning = false; // Message key of the video resolution and frame rate warning that has shown for the current selection (VIDEO_WARNINGS in tv_profile.js), initial value is false
var fps90Warning = false; // Flag indicating whether the 90 FPS cadence hint has been shown, initial value is false
var bitrateWarning = false; // Flag indicating whether the warning about a bitrate above the decoder cap of the TV has shown, initial value is false
var audioWarning = false; // Flag indicating whether the audio configuration warning message has shown, initial value is false
var codecWarning = false; // Flag indicating whether the video codec warning message has shown, initial value is false
var ethernetBitrateWarning = false; // Flag indicating whether the Ethernet bitrate warning message has shown, initial value is false
var ethernetPresetNotice = false; // Flag indicating whether the Ethernet bitrate preset limit message has shown, initial value is false
var recommendedPresetNotice = false; // Flag indicating whether the message about a bitrate preset limited to the recommendation for the TV has shown, initial value is false
var h264ResolutionWarning = false; // Flag indicating whether the H.264 resolution warning message has shown, initial value is false
var autoAdjustBitrate = false; // Flag indicating whether resolution, frame rate, codec and HDR changes apply the bitrate presets, which stops once the bitrate is picked by hand, initial value is false
var keptBitrateNotice = false; // Flag indicating whether the notice about a kept hand-picked bitrate has shown, initial value is false
var tvScreenSaverEnabled = null; // Last screensaver state requested from the TV, initial value is null (never requested)
var streamNetworkInfo = ''; // Network connection summary shown in the performance statistics while streaming, initial value is empty
var streamConnectionType = 'unknown'; // Network connection type of the current streaming session, initial value is unknown
var lastWifiSignalRefreshMs = 0; // Time of the last Wi-Fi signal strength refresh of the network connection summary, initial value is 0
var repeatAction = null; // Flag indicating whether the repeat action is set, initial value is null
var repeatSource = null; // Gamepad input that started the repeat action (e.g. '0 button 13' or '0 axis 1'), which alone may stop it on its release, initial value is null
var lastInvokeTime = 0; // Flag indicating the last invoke time, initial value is 0
var repeatTimeout = null; // Flag indicating whether the repeat timeout is set, initial value is null
var repeatFrame = null; // Animation frame request of the running repeat action, initial value is null
var gamepadAxisDirections = {}; // Direction (-1, 0 or 1) of each gamepad stick axis of the menus past the action threshold, keyed like repeatSource, initial value is empty
var nonStandardGamepadNotices = new Set(); // Ids of the gamepads with a non-standard layout that the notice has shown for since the app started, initial value is empty
var navigationTimeout = null; // Flag indicating whether the navigation timeout is set, initial value is null
const BUILD_TYPE = '__BUILD_TYPE__'; // Placeholder for build type, which should be replaced during the build process
const BUILD_COMMIT = '__BUILD_COMMIT__'; // Placeholder for build commit, which should be replaced during the build process
const SMART_HUB_PREVIEW_PORT = 8889; // Port of the box art server of the Smart Hub service (res/service/service.js). The regular Moonlight app uses 8888, so this build uses its own port to run next to it
const REPO_OWNER = '__REPO_OWNER__'; // Placeholder for repository owner, which should be replaced during the build process
const REPO_NAME = '__REPO_NAME__'; // Placeholder for repository name, which should be replaced during the build process
var _smartHubLocalMessagePort = null; // Local message port for receiving messages from the Smart Hub service
var _smartHubMessagePortListener = null; // Listener ID for the Smart Hub local message port
var _previewApps = {}; // Per-host app cache for Smart Hub Preview: {serverUid: {hostname, address, apps: [{id, title, imageUri}]}}
var _isSmartHubSupported = false; // Flag indicating if Smart Hub Preview is supported on this device

const REPEAT_DELAY = 350; // Repeat delay set to 350ms (milliseconds)
const REPEAT_INTERVAL = 100; // Repeat interval set to 100ms (milliseconds)
const ACTION_THRESHOLD = 0.5; // Threshold for initial navigation set to 0.5
const NAVIGATION_DELAY = 150; // Navigation delay set to 150ms (milliseconds)
const UPDATE_TIMESTAMP = 'lastUpdateCheck'; // Use the update check timestamp key to determine the last update check
const UPDATE_VERSION = 'latestUpdateVersion'; // // Use the update version key to cache the latest version found
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // Automatic check for updates interval is set to 24 hours
const CODEC_MODES_REFRESH_TIMEOUT_MS = 1500; // Longest wait in ms for the codec modes of the host after a launch or resume request

// Called by the common.js module
function attachListeners() {
  changeUiModeForWasmLoad();

  // Register loadSystemInfo to run when language is initialized, and every time it changes, and add the [Unsupported]
  // label to the resolution menu and the note to the video codec menu again after each translation pass rewrote them
  if (window.i18n && typeof window.i18n.onRefresh === 'function') {
    window.i18n.onRefresh(loadSystemInfo);
    window.i18n.onRefresh(labelUnsupportedResolutions);
    window.i18n.onRefresh(labelVideoCodecSupport);
  } else {
    // Fallback if i18n is not present
    loadSystemInfo();
  }

  const i18nInitPromise = (window.i18n && typeof window.i18n.init === 'function')
    ? window.i18n.init().catch((error) => {
      console.warn('%c[index.js, attachListeners]', 'color: green;', 'Warning: i18n initialization failed: ' + error);
    })
    : Promise.resolve();

  i18nInitPromise.finally(() => {
    if (window.i18n && typeof window.i18n.populateLanguageMenu === 'function') {
      window.i18n.populateLanguageMenu(saveLanguagePreference);
    }
  });

  initIpAddressFields();
  filterUnsupportedResolutions();
  labelVideoCodecSupport();

  $('#addHostContainer').on('click', addHostDialog);
  $('#optimalSettingsBtn').on('click', optimalSettingsDialog);
  $('#rescanNetworkBtn').on('click', rescanNetwork);
  $('#settingsBtn').on('click', showSettings);
  $('#supportBtn').on('click', appSupportDialog);
  $('#goBackBtn').on('click', showHosts);
  $('#restoreDefaultsBtn').on('click', restoreDefaultsDialog);
  $('#quitRunningAppBtn').on('click', quitAppDialog);
  $('.videoResolutionMenu li:not(.unsupported-resolution)').on('click', saveResolution);
  $('.videoFramerateMenu li').on('click', saveFramerate);
  $('#bitrateSlider').on('input', function() {
    // A bitrate picked by hand is kept when the resolution, frame rate, codec or HDR changes
    setAutoAdjustBitrate(false);
    saveBitrate();
  });
  $('#framePacingSwitch').on('click', saveFramePacing);
  $('#ipAddressFieldModeSwitch').on('click', saveIpAddressFieldMode);
  $('#ipAddressTextInput').on('input', updateIpAddressInputValidationState);
  $('#sortAppsListSwitch').on('click', saveSortAppsList);
  $('#optimizeGamesSwitch').on('click', saveOptimizeGames);
  $('#removeAllHostsBtn').on('click', deleteAllHostsDialog);
  $('#rumbleFeedbackSwitch').on('click', saveRumbleFeedback);
  $('#mouseEmulationSwitch').on('click', saveMouseEmulation);
  $('#flipABfaceButtonsSwitch').on('click', saveFlipABfaceButtons);
  $('#flipXYfaceButtonsSwitch').on('click', saveFlipXYfaceButtons);
  $('.controllerTypeMenu li').on('click', saveControllerType);
  $('.audioBackendMenu li').on('click', saveAudioBackend);
  $('.audioConfigMenu li').on('click', saveAudioConfiguration);
  $('#audioSyncSwitch').on('click', saveAudioSync);
  $('#audioClockSyncSwitch').on('click', saveAudioClockSync);
  $('#jitterSlider').on('input', saveAudioJitter);
  $('#playHostAudioSwitch').on('click', savePlayHostAudio);
  $('#decryptHostAudioSwitch').on('click', saveDecryptHostAudio);
  $('.videoCodecMenu li').on('click', saveVideoCodec);
  $('#hdrModeSwitch').on('click', saveHdrMode);
  $('#fullRangeSwitch').on('click', saveFullRange);
  $('#gameModeSwitch').on('click', saveGameMode);
  $('#refFrameInvalidationSwitch').on('click', saveRefFrameInvalidation);
  $('#hdrMetadataSwitch').on('click', saveHdrMetadata);
  $('#unlockAllFpsSwitch').on('click', saveUnlockAllFps);
  $('#optimizeBitrateSwitch').on('click', saveOptimizeBitrate);
  $('#disableWarningsSwitch').on('click', saveDisableWarnings);
  $('#performanceStatsSwitch').on('click', savePerformanceStats);
  $('#navigationGuideBtn').on('click', navigationGuideDialog);
  $('#checkUpdatesBtn').on('click', checkForAppUpdates);
  $('#restartAppBtn').on('click', restartAppDialog);
  attachOverlayMenuListeners();

  const registerMenu = (elementId, view) => {
    $(`#${elementId}`).on('click', () => {
      if (view.isActive()) {
        Navigation.pop();
      } else {
        Navigation.push(view);
      }
    });
  }

  registerMenu('selectResolution', Views.SelectResolutionMenu);
  registerMenu('selectFramerate', Views.SelectFramerateMenu);
  registerMenu('selectBitrate', Views.SelectBitrateMenu);
  registerMenu('selectLanguage', Views.SelectLanguageMenu);
  registerMenu('selectControllerType', Views.SelectControllerTypeMenu);
  registerMenu('selectAudioBackend', Views.SelectAudioBackendMenu);
  registerMenu('selectAudio', Views.SelectAudioMenu);
  registerMenu('selectAudioJitter', Views.SelectAudioJitterMenu);
  registerMenu('selectCodec', Views.SelectCodecMenu);

  $(window).resize(fullscreenWasmModule);

  Controller.startWatching();
  window.addEventListener('gamepadinputchanged', handleGamepadMenuInput);
}

// Map the gamepad input of the menus, which gamepad.js reports as 'gamepadinputchanged' events, to Navigation operations
// (W3C standard layout, see wasm/gamepad.cpp). A accepts, B goes back, Select presses and Start switches like CH+ and
// CH- of the remote, each after the navigation delay. The D-pad moves right away and the left stick past the action
// threshold after the navigation delay, and both repeat while held. A release, or a stick back below the threshold, only
// stops the repeat that the same input started, so a jittering resting stick or another released button no longer
// cancels a held D-pad. An action button still ends a repeat, since its operation runs on the focused item.
function handleGamepadMenuInput(e) {
  const gamepadIndex = e.detail.gamepad;
  // Iterate through each change in the gamepad input
  e.detail.changes.forEach((change) => {
    const { type, index, pressed, value } = change;
    const source = gamepadIndex + ' ' + type + ' ' + index;
    if (type === 'button') {
      // Handle button mapping
      const buttonMapping = {
        0: () => Navigation.accept(),
        1: () => Navigation.back(),
        8: () => Navigation.press(),
        9: () => Navigation.switch(),
      };
      // Handle D-Pad mapping
      const dPadMapping = {
        12: () => Navigation.up(),
        13: () => Navigation.down(),
        14: () => Navigation.left(),
        15: () => Navigation.right(),
      };
      // Handle button press
      if (pressed) {
        if (buttonMapping[index]) {
          delayedNavigation(buttonMapping[index]);
          // Clear repeat action and timeout for non-navigation buttons
          stopRepeatAction();
        } else if (dPadMapping[index]) {
          dPadMapping[index]();
          // Set repeat action and timeout to the mapped D-Pad button
          startRepeatAction(dPadMapping[index], source);
        }
      } else if (repeatSource === source) {
        // Clear repeat action and timeout if the button that started it is released
        stopRepeatAction();
      }
    } else if (type === 'axis') {
      // Handle axis mapping: the operations for the negative and the positive direction
      const axisMapping = {
        0: [() => Navigation.left(), () => Navigation.right()],
        1: [() => Navigation.up(), () => Navigation.down()],
      };
      if (!axisMapping[index]) {
        return;
      }
      const direction = value < -ACTION_THRESHOLD ? -1 : (value > ACTION_THRESHOLD ? 1 : 0);
      // A stick that stays on the same side of the threshold only moved a little, or jitters, so it changes nothing
      if (direction === (gamepadAxisDirections[source] || 0)) {
        return;
      }
      gamepadAxisDirections[source] = direction;
      if (direction !== 0) {
        const operation = axisMapping[index][direction < 0 ? 0 : 1];
        delayedNavigation(operation);
        // Set repeat action and timeout to the mapped axis
        startRepeatAction(operation, source);
      } else if (repeatSource === source) {
        // Clear repeat action and timeout if the axis that started it is released
        stopRepeatAction();
      }
    }
  });
}

// Start repeating a navigation operation of a held gamepad input after the repeat delay, replacing the repeat that runs
function startRepeatAction(operation, source) {
  stopRepeatAction();
  repeatAction = operation;
  repeatSource = source;
  lastInvokeTime = Date.now();
  repeatTimeout = setTimeout(() => {
    repeatFrame = requestAnimationFrame(repeatActionHandler);
  }, REPEAT_DELAY);
}

// Stop the repeat action, its pending start and its animation frame loop
function stopRepeatAction() {
  repeatAction = null;
  repeatSource = null;
  clearTimeout(repeatTimeout);
  cancelAnimationFrame(repeatFrame);
}

function changeUiModeForWasmLoad() {
  if (typeof setUiView === 'function') {
    setUiView('loading');
  }
  $('#main-header').hide();
  $('#main-header').children().hide();
  $('#main-content').children().not('#listener, #wasmSpinner').hide();
  $('#wasmSpinner').css('display', 'inline-block');
  $('#wasmSpinnerLogo').show();
  $('#wasmSpinnerMessage').text(t('Loading Moonlight...'));
}

function moduleDidLoad() {
  loadHTTPCerts();
}

// Check if the application is running in a forced Game Mode variant based on Tizen AppMetaData
function checkForceGMVariant() {
  try {
    var metaData = tizen.application.getAppMetaData(appInfo.id);
    // Check if the AppMetaData contains the key-value pair indicating forced Game Mode
    if (metaData && metaData.some(m => m.key === 'http://samsung.com/tv/metadata/use.game.mode' && m.value === 'true')) {
      return true;
    }
  } catch (error) {
    console.warn('%c[index.js, checkForceGMVariant]', 'color: green;', 'Failed to probe AppMetaData for ForceGM check: ', error);
  }
  // Return false if the application is not running in a forced Game Mode variant
  return false;
}

// Formats the build version string based on the build type and commit information
function getBuildVersion(version) {
  // Append pre-release identifier and short commit SHA to the version number for development builds
  if (BUILD_TYPE === 'development' && BUILD_COMMIT) {
    return `${version} (pre-${BUILD_COMMIT})`;
  }
  // Return only the version number without any additional metadata for release builds
  return version;
}

// Handles repeated execution of the current action based on a specified interval
function repeatActionHandler() {
  // Check if repeat action is set and enough time has passed since the last invocation
  if (repeatAction && Date.now() - lastInvokeTime > REPEAT_INTERVAL) {
    repeatAction();
    // Update the last invocation time
    lastInvokeTime = Date.now();
  }
  // Check if repeat action is still set, then schedule the next execution frame
  if (repeatAction) {
    repeatFrame = requestAnimationFrame(repeatActionHandler);
  }
}

// Delays navigation-related callback execution after a specified delay
function delayedNavigation(callback) {
  // Clear any existing navigation timeout
  clearTimeout(navigationTimeout);
  // Set a new navigation timeout with the provided callback and delay
  navigationTimeout = setTimeout(callback, NAVIGATION_DELAY);
}

// Updates the host status indicator based on the host's online and paired status
function updateHostStatusIndicator(host) {
  // Find the desired host cell using the server UUID
  var hostCell = document.querySelector('#host-' + host.serverUid);
  var indicator = document.querySelector('#host-status-' + host.serverUid);

  // Update the host cell inactive styling class
  if (hostCell) {
    // Check if the host is currently online
    if (host.online) {
      // If the host is online, show it as active
      hostCell.classList.remove('host-cell-inactive');
    } else {
      // If the host is offline, show it as inactive
      hostCell.classList.add('host-cell-inactive');
    }
  }

  // Show the state on the card and in the hero area (launcher.js)
  if (typeof Launcher !== 'undefined') {
    Launcher.renderHostStatus(host);
  }

  // If the indicator element is not found, exit the function early
  if (!indicator) {
    return;
  }
  // Set the appropriate status badge based on the host status, which the stylesheet draws from data-status
  if (host.online === undefined || host.online === null) {
    indicator.style.display = 'none';
    indicator.setAttribute('data-status', '');
  } else if (!host.online) {
    indicator.style.display = 'block';
    indicator.setAttribute('data-status', 'offline');
  } else if (host.online && !host.paired) {
    indicator.style.display = 'block';
    indicator.setAttribute('data-status', 'locked');
  } else {
    indicator.style.display = 'none';
    indicator.setAttribute('data-status', '');
  }
}

function beginBackgroundPollingOfHost(host) {
  // Clear any existing polling interval for this host before starting a new one.
  // Without this, every call to beginBackgroundPollingOfHost (e.g. on each navigation
  // back to the host view) would leak the old setInterval, causing multiple overlapping
  // poll loops that corrupt the _pollCompletionCallbacks deduplication guard and
  // prevent the host from ever recovering to the online state.
  endBackgroundPollingOfHost(host);
  // Number this start, so that only its poll loop runs. A start that comes while the first refresh of an earlier one is
  // still running (e.g. Rescan network during the scan at startup, which both resume the polling once the scan ends,
  // or a return to the hosts right after opening one) would otherwise let that refresh start a second loop as well,
  // since it finds the entry of the new start in activePolls: the host would get two requests every 5 seconds, and the
  // timer of one loop could no longer be cleared.
  var generation = (pollGenerations[host.serverUid] || 0) + 1;
  pollGenerations[host.serverUid] = generation;
  var isCurrentPoll = function() {
    return activePolls.hasOwnProperty(host.serverUid) && pollGenerations[host.serverUid] === generation;
  };
  // Ensure the key exists so the check in scheduleNextPoll passes
  activePolls[host.serverUid] = null;

  // Refresh server info before attempting to start background polling of the host
  return host.refreshServerInfo().then(function(ret) {
    console.log('%c[index.js, beginBackgroundPollingOfHost]', 'color: green;', 'Starting background polling of host ' + host.serverUid, host, '\n' + host.toString()); // Logging both object (for console) and toString-ed object (for text logs)
    
    // The fast-path ping succeeded! Mark the host online instantly to prevent the UI from
    // flashing offline in the .finally block, and to skip the redundant 0-delay poll.
    host.online = true;
  }).catch(function(failedRefreshInfo) {
    console.error('%c[index.js, beginBackgroundPollingOfHost]', 'color: green;', 'Error: Failed to refresh server info! Returned error was: ' + failedRefreshInfo + '! Failed server was: ' + '\n', host, '\n' + host.toString()); // Logging both object (for console) and toString-ed object (for text logs)

    // Set host to offline and clear the app list cache
    host.online = false;
    host._memCachedApplist = null;
  }).finally(function() {
    // Update the UI after the network finishes
    updateHostStatusIndicator(host);

    // A later start took over the polling of the host, whose loop may be polling already, so leave its state alone
    if (pollGenerations[host.serverUid] !== generation) return;

    // Reset poll state so that recovery polls from the interval below start with
    // a clean slate. Without this, stale _pollCompletionCallbacks entries from
    // previous (leaked) intervals can block the deduplication guard and prevent
    // pollServer from ever starting a new poll.
    // Note: resetting _consecutivePollFailures to 0 here is always safe. If the
    // host was previously online, this counter was already 0 (it is reset to 0 on
    // every successful poll). Online *recovery* (host.online = true) is set
    // unconditionally in pollServer's success callback regardless of this counter;
    // the counter only gates the *offline* direction (host.online = false after
    // >= 2 consecutive failures inside pollServer), so resetting it here does not
    // interfere with future offline detection either.
    host._consecutivePollFailures = 0;
    host._pollCompletionCallbacks = [];

    var scheduleNextPoll = function(delay) {
      // Stop if the poll was canceled (ID removed from activePolls) or a later start took over
      if (!isCurrentPoll()) return;

      activePolls[host.serverUid] = window.setTimeout(function() {
        // In case it was canceled while waiting
        if (!isCurrentPoll()) return;

        host.pollServer(function(returnedHost) {
          // Update the UI after the network finishes
          updateHostStatusIndicator(returnedHost);

          // In case it was canceled while the network request was running
          if (!isCurrentPoll()) return;

          // Schedule the next poll for 5 seconds AFTER this one finished
          scheduleNextPoll(5000);
        });
      }, delay);
    };

    // Check if the host is currently online
    if (host.online) {
      // The host was already online, so start polling in the background now
      scheduleNextPoll(5000);
    } else {
      // The host was offline, so poll immediately to check the host's status
      scheduleNextPoll(0);
    }
  });
}

function startPollingHosts() {
  var pollPromises = [];
  for (var hostUID in hosts) {
    pollPromises.push(beginBackgroundPollingOfHost(hosts[hostUID]));
  }
  return Promise.all(pollPromises);
}

function endBackgroundPollingOfHost(host) {
  console.log('%c[index.js, endBackgroundPollingOfHost]', 'color: green;', 'Stopping background polling of host ' + host.serverUid, host, '\n' + host.toString()); // Logging both object (for console) and toString-ed object (for text logs)
  // Clear the host's polling interval and remove it from the activePolls object, also while the first
  // refresh is still running and the entry is null, otherwise the polling would start anyway when it finishes
  if (activePolls.hasOwnProperty(host.serverUid)) {
    window.clearTimeout(activePolls[host.serverUid]);
    delete activePolls[host.serverUid];
  }
}

function stopPollingHosts() {
  for (var hostUID in hosts) {
    endBackgroundPollingOfHost(hosts[hostUID]);
  }
}

// Whether a scan of the local network that the Rescan network button started is running
var isNetworkRescanRunning = false;

// Scan the local network for hosts again (the subnet scan of static/js/mdns-browser/main.js, which stands in for mDNS
// discovery on Tizen), e.g. for a PC that came online after the app started or got a new IP address. As at startup, the
// background polling of the known hosts pauses while the scan runs, since both together can exhaust the network stack
// of the TV, and resumes afterwards while the hosts are shown. Returns a promise that resolves once the scan is done.
function rescanNetwork() {
  if (isNetworkRescanRunning) {
    snackbarLog('The local network is already being scanned.');
    return Promise.resolve();
  }
  if (isInGame || typeof startSubnetScanner !== 'function') {
    return Promise.resolve();
  }
  isNetworkRescanRunning = true;
  console.log('%c[index.js, rescanNetwork]', 'color: green;', 'Rescanning the local network for hosts...');
  $('#rescanNetworkBtn').addClass('is-scanning');
  snackbarLog('Scanning the local network to discover new hosts...');
  stopPollingHosts();
  return Promise.resolve().then(function() {
    return startSubnetScanner();
  }).catch(function(error) {
    console.warn('%c[index.js, rescanNetwork]', 'color: green;', 'Warning: The scan of the local network failed: ', error);
  }).then(function() {
    isNetworkRescanRunning = false;
    isSubnetScanFinished = true;
    $('#rescanNetworkBtn').removeClass('is-scanning');
    console.log('%c[index.js, rescanNetwork]', 'color: green;', 'Finished rescanning the local network.');
    // The polling of the hosts runs only while they are shown; opening a host or the settings stopped the scan already
    if (!isInGame && $('#host-grid').is(':visible')) {
      snackbarLog('Finished scanning the local network.');
      startPollingHosts();
    }
  });
}

function snackbarLog(...args) {
  const translatedMessage = t(...args);
  console.log('%c[index.js, snackbarLog]', 'color: green;', ...args);
  var data = {
    message: translatedMessage,
    timeout: 2500
  };
  document.querySelector('#snackbar').MaterialSnackbar.showSnackbar(data);
}

function snackbarLogLong(...args) {
  const translatedMessage = t(...args);
  console.log('%c[index.js, snackbarLogLong]', 'color: green;', ...args);
  var data = {
    message: translatedMessage,
    timeout: 5000
  };
  document.querySelector('#snackbar').MaterialSnackbar.showSnackbar(data);
}

// Handle layout elements when displaying the Hosts view
function showHostsMode() {
  if (typeof setUiView === 'function') {
    setUiView('hosts');
  }
  console.log('%c[index.js, showHostsMode]', 'color: green;', 'Entering "Show Hosts" mode.');
  // Keep the key of the view title, so that a later translation pass translates it instead of resetting it to the app name
  $('#header-title').attr('data-i18n', 'Hosts').html(t('Hosts'));
  $('#header-logo').show();
  $('#main-header').show();
  $('#appMenuHint').hide();
  $('.nav-menu-parent').show();
  $('#updateAppBtn').show();
  $('#rescanNetworkBtn').show();
  $('#settingsBtn').show();
  $('#supportBtn').show();
  $('#main-content').children().not('#listener, #loadingSpinner, #wasmSpinner').show();
  $('#settings-list').hide();
  $('#game-grid').hide();
  $('#goBackBtn').hide();
  $('#restoreDefaultsBtn').hide();
  $('#quitRunningAppBtn').hide();
  $('#connection-warnings').css('display', 'none');
  $('#performance-stats').css('display', 'none');
  $('#main-content').removeClass('fullscreen');
  $('#listener').removeClass('fullscreen');

  Navigation.start();
  Controller.startWatching();
  Navigation.pop();
  // Stop any existing polls before starting new ones to prevent setInterval leaks.
  // Without this, navigating back to the host view multiple times accumulates
  // duplicate polling intervals for each host, which causes race conditions in
  // _pollCompletionCallbacks and prevents the host from recovering to online.
  stopPollingHosts();
  startPollingHosts();
}

// Show the Hosts grid
function showHosts() {
  // Stop navigation before showing the loading screen
  Navigation.stop();

  // Hide the main header and content before showing a loading screen
  $('#main-header').children().hide();
  $('#main-header').css({'backgroundColor': 'transparent', 'boxShadow': 'none'});
  $('#settings-list, #game-grid').hide();

  // Show a spinner while the host list loads
  if (typeof setUiView === 'function') {
    setUiView('loading');
  }
  $('#wasmSpinner').css('display', 'inline-block');
  $('#wasmSpinnerLogo').hide();
  $('#wasmSpinnerMessage').text(t('Loading Hosts...'));

  setTimeout(() => {
    // Hide the spinner after successfully retrieving the host list
    $('#wasmSpinner').hide();

    // Show the main header after the loading screen is complete
    $('#main-header').children().show();
    $('#main-header').css({'backgroundColor': '', 'boxShadow': ''});

    // Navigate to the Hosts view
    showHostsMode();
  }, 500);

  setTimeout(() => {
    var lastOpenedHost = localStorage.getItem('lastOpenedHost');
    if (lastOpenedHost && window.Views && Views.Hosts && Views.Hosts.view) {
      var children = Views.Hosts.view.func();
      for (var i = 0; i < children.length; i++) {
        if (children[i].id === 'host-' + lastOpenedHost) {
          Views.Hosts.view.index = i;
          break;
        }
      }
    }
    Navigation.switch();
  }, 500);
}

function restoreUiAfterWasmLoad() {
  // Stop navigation before showing the loading screen
  Navigation.stop();

  $('#main-header').children().not('#goBackBtn, #restoreDefaultsBtn, #quitRunningAppBtn').show();
  $('#main-content').children().not('#listener, #wasmSpinner, #settings-list, #game-grid').show();
  $('#wasmSpinner').hide();
  $('#loadingSpinner').css('display', 'none');

  // Navigate to the Hosts view
  Navigation.push(Views.Hosts);
  showHostsMode();
  // Set focus to current item and/or scroll to the current host row
  setTimeout(() => Navigation.switch(), 100);

  // Find mDNS host discovered using ServiceFinder (network service discovery)
  // findNvService(function(finder, opt_error) {
  //   if (finder.byService_['_nvstream._tcp']) {
  //     var ips = Object.keys(finder.byService_['_nvstream._tcp']);
  //     for (var i in ips) {
  //       var ip = ips[i];
  //       if (finder.byService_['_nvstream._tcp'][ip]) {
  //         var mDnsDiscoveredHost = new NvHTTP(ip, myUniqueid);
  //         mDnsDiscoveredHost.pollServer(function(returnedDiscoveredHost) {
  //           // Just drop this if the host doesn't respond
  //           if (!returnedDiscoveredHost.online) {
  //             return;
  //           }
  //           if (hosts[returnedDiscoveredHost.serverUid] != null) {
  //             // If we're seeing a host we've already seen before, update it for the current local IP
  //             hosts[returnedDiscoveredHost.serverUid].address = returnedDiscoveredHost.address;
  //             hosts[returnedDiscoveredHost.serverUid].updateExternalAddressIP4();
  //           } else {
  //             // Host must be in the grid before starting background polling
  //             addHostToGrid(returnedDiscoveredHost, true);
  //             beginBackgroundPollingOfHost(returnedDiscoveredHost);
  //           }
  //           saveHosts();
  //         });
  //       }
  //     }
  //   }
  // });


  // Automatically check for a new update after 10 seconds delay at application startup once every 24 hours
  setTimeout(() => checkForAppUpdatesAtStartup(), 10000);
}

// Handles the selection of a host, manages the connection, pairing process, including error handling
function hostChosen(host, onSuccessCallback) {
  // Ignore a host selection (e.g. from a Smart Hub deep link) while a stream is starting or running. This comes
  // before setting the flag below, so that the flag can't stay set.
  if (isInGame) {
    console.warn('%c[index.js, hostChosen]', 'color: green;', 'Warning: Ignoring the host selection while a stream is active.');
    return;
  }

  // Check if a host is already being opened to prevent concurrent executions
  if (isHostOpening) {
    return;
  }

  // Set the flag to indicate that a host is currently being opened
  isHostOpening = true;

  // Check if a pairing request is already in progress to prevent multiple pairing attempts
  if (isPairingInProgress) {
    // Set the flag to indicate that a host is unable to be opened due to an ongoing pairing request
    isHostOpening = false;
    snackbarLogLong('A pairing request is currently in progress. Please wait for it to timeout or finish before trying again.');
    return;
  }
  // The menu of an app tile belongs to the app list it was opened on, which the app list of this host replaces, e.g.
  // for a Smart Hub tile picked while the menu was open. Close it, so that it neither stays over the new app list or
  // the stream that the tile starts, nor keeps the Stream Menu from opening (isDialogShown() in menus.js).
  closeAppMenu();
  localStorage.setItem('lastOpenedHost', host.serverUid);

  // If the host is already offline or fails to connect, notify the user.
  if (!host.online) {
    // Set the flag to indicate that a host is unable to be opened due to being offline or failing to connect
    isHostOpening = false;
    // Only show the Wake PC dialog if the user has explicitly enabled per-host Auto WOL toggle
    if (host.autoWolEnabled === true) {
      autoWolDialog(host, function() {
        // Success callback: The host is now online.
        if (onSuccessCallback) {
          onSuccessCallback();
        } else {
          // Re-call hostChosen(host) to proceed normally.
          hostChosen(host);
        }
      });
    } else {
      // Let the user know what to do to bring the host back online and until then, we'll be back to the previous view.
      console.error('%c[index.js, hostChosen]', 'color: green;', 'Error: Connection to host failed or host is offline!');
      snackbarLogLong('Failed to connect to %1$s. Ensure Sunshine is running on your host PC or GameStream is enabled in GeForce Experience SHIELD settings.', 'the host');
    }
    return;
  }

  // Avoid delay from other polling during pairing
  stopPollingHosts();

  api = host;
  // If the host is not yet paired or has been removed from the server, go to the pairing flow.
  if (!host.paired) {
    // Continue with the pairing flow
    pairingDialog(host, function() {
      // After pairing the host, save the host object, show the apps, and navigate to the Apps view
      saveHosts();
      Navigation.push(Views.Apps);
      showApps(host).then(() => {
        // Scroll to the current game row
        Navigation.switch();
        // Switch to Apps view
        Navigation.change(Views.Apps);
      }).catch(console.error).finally(() => {
        // Reset the flag to indicate that a host failed to show apps list
        isHostOpening = false;
      });
    }, function() {
      // Reset the flag to indicate that a host failed due to unsuccessful pairing
      isHostOpening = false;
      // Resume background polling after the pairing flow
      startPollingHosts();
    });
  } else {
    // But if the host is already paired and online, then we show the apps and navigate to the Apps view as usual.
    Navigation.push(Views.Apps);
    showApps(host).then(() => {
      // Scroll to the current game row
      Navigation.switch();
      // Switch to Apps view
      Navigation.change(Views.Apps);
    }).catch(console.error).finally(() => {
      // Reset the flag to indicate that a host failed to show apps list
      isHostOpening = false;
    });
  }
}

// Handles the change of input mode based on the state of the IP address field mode switch
function handleIpAddressFieldMode() {
  // Finds the existing switch, input field, and select fields elements
  const ipAddressFieldModeSwitch = document.getElementById('ipAddressFieldModeSwitch');
  const ipAddressInputField = document.getElementById('ipAddressInputField');
  const ipAddressSelectFields = document.getElementById('ipAddressSelectFields');
  const ipAddressInput = document.getElementById('ipAddressTextInput');
  const textField = ipAddressInput ? ipAddressInput.closest('.mdl-textfield') : null;

  // Checks if the IP address field mode switch is checked
  if (ipAddressFieldModeSwitch.checked) {
    // Hides the input field and shows the select field
    ipAddressInputField.style.display = 'none';
    ipAddressSelectFields.style.display = 'block';
    if (ipAddressInput && textField) {
      ipAddressInput.setCustomValidity('');
      textField.classList.remove('is-invalid');
    }
  } else {
    // Shows the input field and hides the select field
    ipAddressInputField.style.display = 'block';
    ipAddressSelectFields.style.display = 'none';
    updateIpAddressInputValidationState();
  }
}

// Populates the select IP address fields with options from a specified range
function populateSelectFields(element, start, end, selectedValue) {
  // Iterate through the range from start to end
  for (let i = start; i <= end; i++) {
    // Create a new option element
    const option = document.createElement('option');
    // Set the value and text of the option to the current iteration value
    option.value = i;
    option.text = i;
    // Checks if the current iteration value matches the selected value
    if (i === selectedValue) {
      // Mark the option as selected
      option.selected = true;
    }
    // Append the created option to the select element
    element.appendChild(option);
  }
}

// Initialize the IP address select fields with predefined values
function initIpAddressFields() {
  // Find the existing select fields elements and set the values
  const ipAddressFields = [
    { element: 'ipAddressField1', selectedValue: 192 },
    { element: 'ipAddressField2', selectedValue: 168 },
    { element: 'ipAddressField3', selectedValue: 0 },
    { element: 'ipAddressField4', selectedValue: 0 },
  ];

  // Populate each IP address field with the selected values
  ipAddressFields.forEach(ipAddressField => {
    const element = document.getElementById(ipAddressField.element);
    populateSelectFields(element, 0, 255, ipAddressField.selectedValue);
  });
}

// Mark the resolutions above the panel as unsupported, disable them and add the [Unsupported] label
function filterUnsupportedResolutions() {
  $('.videoResolutionMenu li').each(function() {
    var resData = $(this).data('value');
    if (resData) {
      var resWidth = parseInt(resData.split(':')[0], 10);
      if (resWidth > maxSupportedWidth) {
        $(this).addClass('mdl-menu__item--full-bleed-divider unsupported-resolution');
        $(this).attr('disabled', 'disabled');
      }
    }
  });
  labelUnsupportedResolutions();
}

// Add the [Unsupported] label to the resolutions marked as unsupported. Every translation pass of i18n.js rewrites the
// text of the menu items from their data-i18n key, which drops the label, so this also runs after each one (registered
// in attachListeners()).
function labelUnsupportedResolutions() {
  $('.videoResolutionMenu li.unsupported-resolution').each(function() {
    var resolutionLabel = $(this).attr('data-i18n') ? t($(this).attr('data-i18n')) : $(this).text().trim();
    $(this).text(t('%1$s [Unsupported]', resolutionLabel));
  });
}

// Return the text of a menu item without a note added to it (e.g. by labelVideoCodecSupport()), from its data-i18n key
function getMenuItemLabel(item) {
  return $(item).attr('data-i18n') ? t($(item).attr('data-i18n')) : $(item).text().trim();
}

// Add a note to the AV1 entry of the video codec menu when the decoder check says clearly that the TV can't decode AV1
// (isAv1ReportedUnsupported() in tv_profile.js). It's only a note and AV1 stays selectable, since the check of the
// browser may not mirror the WASM player. Every translation pass of i18n.js rewrites the text of the menu items from
// their data-i18n key, which drops the note, so this also runs after each one (registered in attachListeners()).
function labelVideoCodecSupport() {
  if (!isAv1ReportedUnsupported(videoDecoderProbe)) {
    return;
  }
  console.log('%c[index.js, labelVideoCodecSupport]', 'color: green;', 'The decoder check says that this TV may not decode AV1, labelling its menu entry.');
  $('.videoCodecMenu li[data-value="AV1"]').each(function() {
    $(this).text(t('%1$s (may not be supported by this TV)', getMenuItemLabel(this)));
  });
}

// Get the active network connection type of the TV, which is either 'ethernet', 'wifi' or 'unknown' (see tv_profile.js)
function getActiveConnectionType() {
  return detectConnectionType();
}

// Turn the screensaver of the TV off while streaming and on again afterwards. Samsung asks apps to turn it off during
// playback without remote control input, and a session played only with a gamepad may not count as activity for the
// TV. It's only turned on again after it was turned off here, so that the static menus of the app don't stay on the
// OLED panel, and nothing is requested on TVs without the API.
function setTvScreenSaver(enabled) {
  if (enabled ? tvScreenSaverEnabled !== false : tvScreenSaverEnabled === false) {
    return;
  }
  try {
    if (typeof webapis === 'undefined' || !webapis.appcommon || typeof webapis.appcommon.setScreenSaver !== 'function' || !webapis.appcommon.AppCommonScreenSaverState) {
      return;
    }
    const screenSaverStates = webapis.appcommon.AppCommonScreenSaverState;
    const requestedState = enabled ? screenSaverStates.SCREEN_SAVER_ON : screenSaverStates.SCREEN_SAVER_OFF;
    if (requestedState === undefined) {
      return;
    }
    tvScreenSaverEnabled = enabled;
    webapis.appcommon.setScreenSaver(requestedState, function() {
      console.log('%c[index.js, setTvScreenSaver]', 'color: green;', 'Screensaver of the TV turned ' + (enabled ? 'on' : 'off'));
    }, function(error) {
      console.warn('%c[index.js, setTvScreenSaver]', 'color: green;', 'Warning: Failed to turn the screensaver of the TV ' + (enabled ? 'on' : 'off') + ': ' + (error && error.name) + ' ' + (error && error.message));
    });
  } catch (e) {
    console.warn('%c[index.js, setTvScreenSaver]', 'color: green;', 'Warning: Failed to set the screensaver of the TV: ' + (e && e.name) + ' ' + (e && e.message));
  }
}

// Get the Wi-Fi signal strength of the TV in percent and pass it to the callback function, or null if it's unavailable
function getWifiSignalStrength(callbackFunction) {
  try {
    tizen.systeminfo.getPropertyValue('WIFI_NETWORK', function(wifiNetwork) {
      // Some TVs (e.g. a 2023 model on Tizen 9) report NaN, which is a number too, so only accept a finite value
      if (wifiNetwork && wifiNetwork.status === 'ON' && typeof wifiNetwork.signalStrength === 'number' && isFinite(wifiNetwork.signalStrength)) {
        callbackFunction(Math.max(0, Math.min(100, Math.round(wifiNetwork.signalStrength * 100))));
      } else {
        callbackFunction(null);
      }
    }, function(error) {
      console.warn('%c[index.js, getWifiSignalStrength]', 'color: green;', 'Warning: Failed to get the Wi-Fi signal strength: ' + error.message);
      callbackFunction(null);
    });
  } catch (e) {
    console.warn('%c[index.js, getWifiSignalStrength]', 'color: green;', 'Warning: Failed to get the Wi-Fi signal strength: ' + e);
    callbackFunction(null);
  }
}

// Refresh the Wi-Fi signal strength of the network connection summary at most every 5 seconds, which is called
// for every update of the performance statistics while streaming
function refreshStreamNetworkInfo() {
  if (streamConnectionType !== 'wifi') {
    return;
  }
  const now = Date.now();
  if (now - lastWifiSignalRefreshMs < 5000) {
    return;
  }
  lastWifiSignalRefreshMs = now;
  getWifiSignalStrength(function(signalStrength) {
    if (signalStrength !== null) {
      streamNetworkInfo = t('Network connection: Wi-Fi (signal strength: %1$s percent)', signalStrength);
    }
  });
}

// Update the network connection summary that is shown in the performance statistics while streaming
function updateStreamNetworkInfo() {
  const connectionType = getActiveConnectionType();
  streamConnectionType = connectionType;
  lastWifiSignalRefreshMs = Date.now();
  console.log('%c[index.js, updateStreamNetworkInfo]', 'color: green;', 'Active network connection type: ' + connectionType);
  if (connectionType === 'ethernet') {
    streamNetworkInfo = t('Network connection: Ethernet (Samsung TVs usually have a 100 Mbps port)');
  } else if (connectionType === 'wifi') {
    streamNetworkInfo = t('Network connection: Wi-Fi');
    // Add the signal strength as soon as it's available, since it's retrieved asynchronously
    getWifiSignalStrength(function(signalStrength) {
      if (signalStrength !== null) {
        streamNetworkInfo = t('Network connection: Wi-Fi (signal strength: %1$s percent)', signalStrength);
      }
    });
  } else {
    streamNetworkInfo = '';
  }
}

function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function isValidHostAddress(address) {
  if (!address) {
    return false;
  }

  // IPv4 regex
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  // IPv6 regex
  const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
  
  // Hostname regex (FQDN or short hostname)
  const hostnameRegex = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;

  return ipv4Regex.test(address) || ipv6Regex.test(address) || hostnameRegex.test(address);
}

function isPotentialAddressWithOptionalPort(rawInput) {
  const input = (rawInput || '').trim();
  if (!input) {
    return true;
  }

  // Relaxed validation while typing: allow alphanumeric, dots, hyphens, colons, and brackets
  return /^[a-zA-Z0-9.:\[\]\-]*$/.test(input);
}

function updateIpAddressInputValidationState() {
  const ipAddressInput = document.getElementById('ipAddressTextInput');
  const textField = ipAddressInput ? ipAddressInput.closest('.mdl-textfield') : null;
  const usingSelectFields = $('#ipAddressFieldModeSwitch').prop('checked');

  if (!ipAddressInput || !textField || usingSelectFields) {
    return;
  }

  const inputValue = ipAddressInput.value;
  const isPotentialValue = isPotentialAddressWithOptionalPort(inputValue);

  if (!inputValue.trim()) {
    ipAddressInput.setCustomValidity('');
    textField.classList.remove('is-invalid');
    return;
  }

  if (isPotentialValue) {
    ipAddressInput.setCustomValidity('');
    textField.classList.remove('is-invalid');
  } else {
    ipAddressInput.setCustomValidity('invalid-host');
    textField.classList.add('is-invalid');
  }
}

function parseHostAndPortInput(rawInput) {
  const input = (rawInput || '').trim();

  if (!input) {
    return { valid: false, error: t('Please enter a valid host address!') };
  }

  let hostPart = input;
  let portPart = '';

  // Check for IPv6 with port like [fe80::1]:47989
  const ipv6PortMatch = input.match(/^\[(.*)\]:(\d+)$/);
  // Check for IPv6 surrounded by brackets without port like [fe80::1]
  const ipv6BracketMatch = input.match(/^\[(.*)\]$/);
  
  if (ipv6PortMatch) {
    hostPart = ipv6PortMatch[1];
    portPart = ipv6PortMatch[2];
  } else if (ipv6BracketMatch) {
    hostPart = ipv6BracketMatch[1];
  } else {
    // Check if it has a port but is not an IPv6 address
    const firstColon = input.indexOf(':');
    const lastColon = input.lastIndexOf(':');
    
    if (firstColon > 0 && firstColon === lastColon) {
      hostPart = input.substring(0, firstColon).trim();
      portPart = input.substring(firstColon + 1).trim();
    } else {
      hostPart = input;
    }
  }

  if (!hostPart) {
    return { valid: false, error: t('Please enter a valid host address!') };
  }

  if (!isValidHostAddress(hostPart)) {
    return { valid: false, error: t('Please enter a valid host address!') };
  }

  if (portPart) {
    if (!/^\d{1,5}$/.test(portPart)) {
      return { valid: false, error: t('Port must be a numeric value between 1 and 65535!') };
    }

    const parsedPort = parseInt(portPart, 10);
    if (!isValidPort(parsedPort)) {
      return { valid: false, error: t('Please enter a valid port number between 1 and 65535!') };
    }

    return { valid: true, addr: hostPart, port: parsedPort };
  }

  return { valid: true, addr: hostPart, port: 47989 };
}

// If the `Add Host +` is selected on the host grid, then show the 
// Add Host dialog to enter the connection details for the host PC
function addHostDialog() {
  if (typeof window.abortSubnetScan === 'function') window.abortSubnetScan();
  // Find the existing overlay and dialog elements
  var addHostOverlay = document.querySelector('#addHostDialogOverlay');
  var addHostDialog = document.querySelector('#addHostDialog');
  
  // Show the dialog and push the view
  addHostOverlay.style.display = 'flex';
  addHostDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.AddHostDialog);
  updateIpAddressInputValidationState();
  // Remove focus from any current active element
  document.activeElement.blur();

  // Cancel the operation if the Cancel button is pressed
  $('#cancelAddHost').off('click');
  $('#cancelAddHost').on('click', function() {
    console.log('%c[index.js, addHostDialog]', 'color: green;', 'Closing app dialog and returning.');
    addHostOverlay.style.display = 'none';
    addHostDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    // Re-enable the Continue button after canceling the operation
    $('#continueAddHost').removeClass('mdl-button--disabled').prop('disabled', false);
    // Clear the input field after canceling the operation
    $('#ipAddressTextInput').val('');
    updateIpAddressInputValidationState();
    initIpAddressFields();
  });

  // Send a connection request if the Continue button is pressed
  $('#continueAddHost').off('click');
  $('#continueAddHost').on('click', function() {
    console.log('%c[index.js, addHostDialog]', 'color: green;', 'Adding host, closing app dialog, and returning.');
    // Get the IP address value from the input field or select fields
    var inputHost;
    if ($('#ipAddressFieldModeSwitch').prop('checked')) {
      var ipAddressField1 = $('#ipAddressField1').val();
      var ipAddressField2 = $('#ipAddressField2').val();
      var ipAddressField3 = $('#ipAddressField3').val();
      var ipAddressField4 = $('#ipAddressField4').val();
      inputHost = ipAddressField1 + '.' + ipAddressField2 + '.' + ipAddressField3 + '.' + ipAddressField4;
    } else {
      inputHost = $('#ipAddressTextInput').val();
    }
    // Get the IP address and port from the input and validate them
    var parsedHostInput;
    if ($('#ipAddressFieldModeSwitch').prop('checked')) {
      // Select fields only provide IP octets, so always use default HTTP port
      parsedHostInput = { valid: true, addr: inputHost, port: 47989 };
    } else {
      parsedHostInput = parseHostAndPortInput(inputHost);
    }
    // If the input is invalid, show an error message and return early
    if (!parsedHostInput.valid) {
      snackbarLog(parsedHostInput.error);
      return;
    }
    // Disable the Continue button to prevent multiple connection requests
    setTimeout(() => {
      // Add disabled state after 2 seconds
      $('#continueAddHost').addClass('mdl-button--disabled').prop('disabled', true);
      Navigation.switch();
      // Re-enable the Continue button after 12 seconds
      setTimeout(() => {
        $('#continueAddHost').removeClass('mdl-button--disabled').prop('disabled', false);
        Navigation.switch();
      }, 12000);
    }, 2000);
    // Send a connection request to the Host object based on the given IP address
    var _nvhttpHost = new NvHTTP(parsedHostInput.addr, myUniqueid, parsedHostInput.addr);
    _nvhttpHost.httpPort = parsedHostInput.port;
    console.log('%c[index.js, addHostDialog]', 'color: green;', 'Sending connection request to host address ' + _nvhttpHost.hostname);
    _nvhttpHost.refreshServerInfoAtAddress(parsedHostInput.addr).then(function(success) {
      snackbarLog('Connecting to %1$s...', _nvhttpHost.hostname);
      // Close the dialog if the user has provided the IP address
      console.log('%c[index.js, addHostDialog]', 'color: green;', 'Closing app dialog and returning.');
      addHostOverlay.style.display = 'none';
      addHostDialog.close();
      isDialogOpen = false;
      Navigation.pop();
      // Avoid delay from other polling during pairing
      stopPollingHosts();
      // Check if we already have record of this host. If so, we'll
      // need the PPK string to ensure our pairing status is accurate.
      if (hosts[_nvhttpHost.serverUid] != null) {
        // Update the addresses
        hosts[_nvhttpHost.serverUid].address = _nvhttpHost.address;
        hosts[_nvhttpHost.serverUid].userEnteredAddress = _nvhttpHost.userEnteredAddress;
        hosts[_nvhttpHost.serverUid].httpPort = _nvhttpHost.httpPort;
        // Use the host in the array directly to ensure the PPK propagates after pairing
        pairingDialog(hosts[_nvhttpHost.serverUid], function() {
          saveHosts();
          startPollingHosts();
        }, function() {
          // Resume background polling after the pairing flow
          startPollingHosts();
        });
      } else {
        pairingDialog(_nvhttpHost, function() {
          // Add the host to the grid after successful pairing
          addHostToGrid(_nvhttpHost);
          saveHosts();
          startPollingHosts();
        }, function() {
          // Resume background polling after the pairing flow
          startPollingHosts();
        });
      }
      // Re-enable the Continue button after successful processing
      $('#continueAddHost').removeClass('mdl-button--disabled').prop('disabled', false);
      // Clear the input field after successful processing
      $('#ipAddressTextInput').val('');
      updateIpAddressInputValidationState();
      initIpAddressFields();
    }.bind(this), function(failure) {
      console.error('%c[index.js, addHostDialog]', 'color: green;', 'Error: Failed API object:\n', _nvhttpHost, '\n' + _nvhttpHost.toString()); // Logging both object (for console) and toString-ed object (for text logs)
      snackbarLogLong('Failed to connect to %1$s. Ensure Sunshine is running on your host PC or GameStream is enabled in GeForce Experience SHIELD settings.', _nvhttpHost.hostname || t('the host'));
      // Re-enable the Continue button after failure processing
      $('#continueAddHost').removeClass('mdl-button--disabled').prop('disabled', false);
      // Clear the input field after failure processing
      $('#ipAddressTextInput').val('');
      updateIpAddressInputValidationState();
      initIpAddressFields();
    }.bind(this));
  });
}

// Show the Pairing dialog before pairing with the given NvHTTP host object. Returns whether the pairing was successful or failed.
function pairingDialog(nvhttpHost, onSuccess, onFailure) {
  if (typeof window.abortSubnetScan === 'function') window.abortSubnetScan();
  if (!onFailure) {
    onFailure = function() {}
  }

  if (!pairingCert) {
    console.warn('%c[index.js, pairingDialog]', 'color: green;', 'Warning: Pairing certificate is not generated yet. Please ensure Wasm is initialized properly!');
    snackbarLogLong('Something went wrong with the pairing certificate. Please try pairing with the host PC again.');
    onFailure();
    return;
  }

  nvhttpHost.pollServer(function(returnedNvHTTPHost) {
    if (!returnedNvHTTPHost.online) {
      console.error('%c[index.js, pairingDialog]', 'color: green;', 'Error: Failed to connect to ' + nvhttpHost.hostname + '. Ensure your host PC is online!', nvhttpHost, '\n' + nvhttpHost.toString()); // Logging both object (for console) and toString-ed object (for text logs)
      snackbarLogLong('Failed to connect to %1$s. Ensure Sunshine is running on your host PC or GameStream is enabled in GeForce Experience SHIELD settings.', nvhttpHost.hostname || t('the host'));
      onFailure();
      return;
    }

    if (nvhttpHost.paired) {
      onSuccess();
      return;
    }

    if (nvhttpHost.currentGame != 0) {
      snackbarLogLong('%1$s is currently in a game session. Please quit the running app or restart the computer, then try again.', nvhttpHost.hostname);
      onFailure();
      return;
    }

    // Find the existing overlay and dialog elements
    var pairingOverlay = document.querySelector('#pairingDialogOverlay');
    var pairingDialog = document.querySelector('#pairingDialog');
    var randomNumber = generatePairingPin();

    // Rollback to 'Cancel' button text when opening
    $('#cancelPairing').text('Cancel');

    // Change the dialog text element to include the random PIN number, in bold (style.css shows it large)
    $('#pairingDialogText').html(
      t('Please enter the following PIN on the target PC: %1$s<br><br>', '<b>' + randomNumber + '</b>') + 
      t('If your host PC is running Sunshine (all GPUs), navigate to the Sunshine Web UI to enter the PIN.<br><br>') + 
      t('Alternatively, if your host PC has NVIDIA GameStream (NVIDIA-only), navigate to the GeForce Experience to enter the PIN.<br><br>') + 
      t('This dialog will close once the pairing is complete.')
    );

    // Show the dialog and push the view
    pairingOverlay.style.display = 'flex';
    pairingDialog.showModal();
    isDialogOpen = true;
    Navigation.push(Views.PairingDialog);

    isPairingInProgress = true;
    wasPairingCanceled = false;

    // Cancel the operation if the Cancel button is pressed
    $('#cancelPairing').off('click');
    $('#cancelPairing').on('click', function() {
      console.log('%c[index.js, pairingDialog]', 'color: green;', 'Closing app dialog and returning.');
      sendMessage('cancelRequest', []);
      wasPairingCanceled = true;
      pairingOverlay.style.display = 'none';
      pairingDialog.close();
      isDialogOpen = false;
      Navigation.pop();
    });

    console.log('%c[index.js, pairingDialog]', 'color: green;', 'Sending pairing request to ' + nvhttpHost.hostname + ' with PIN ' + randomNumber);
    nvhttpHost.pair(randomNumber).then(function() {
      isPairingInProgress = false;
      snackbarLog('Successfully paired with %1$s', nvhttpHost.hostname);
      // Close the dialog if the pairing was successful
      console.log('%c[index.js, pairingDialog]', 'color: green;', 'Closing app dialog and returning.');
      pairingOverlay.style.display = 'none';
      pairingDialog.close();
      isDialogOpen = false;
      Navigation.pop();
      onSuccess();
    }, function(failedPairing) {
      isPairingInProgress = false;
      if (wasPairingCanceled) {
        console.log('%c[index.js, pairingDialog]', 'color: green;', 'Ignored pairing failure due to cancellation.');
        // Still let the caller recover, so the host can be selected again and the hosts are polled again
        onFailure();
        return;
      }
      console.error('%c[index.js, pairingDialog]', 'color: green;', 'Error: Failed API object:\n', nvhttpHost, '\n' + nvhttpHost.toString()); // Logging both object (for console) and toString-ed object (for text logs)
      snackbarLog('Failed to pair with %1$s', nvhttpHost.hostname);
      // Keep the modal opened, but change the button for "Close"
      $('#cancelPairing').text('Close');

      // If the host is already in a streaming session or failed during pairing,
      // change the dialog text element to include the hostname and display the returned error message
      if (nvhttpHost.currentGame != 0) {
        $('#pairingDialogText').html(t('Error: %1$s is currently busy!<br><br>You must stop the running app in order to pair with the host.', escapeHTML(nvhttpHost.hostname)));
      } else {
        $('#pairingDialogText').html(t('Error: Failed to pair with %1$s.<br><br>Please, try pairing with the host again.', escapeHTML(nvhttpHost.hostname)));
      }
      onFailure();
    });
  });
}

function autoWolDialog(host, onSuccess, onCancel) {
  var autoWolOverlay = document.querySelector('#autoWolDialogOverlay');
  var autoWolDialog = document.querySelector('#autoWolDialog');

  // Reset the button text to their default state
  $('#cancelAutoWol').html(t('Cancel'));
  Views.AutoWolDialog.view.reset();

  // Set the checkbox state based on the host's autoWolEnabled property
  if (host.autoWolEnabled === true) {
    document.querySelector('#autoWolCheckboxBtn').MaterialSwitch.on();
  } else {
    document.querySelector('#autoWolCheckboxBtn').MaterialSwitch.off();
  }

  // Attach onchange event listener to the Auto WOL checkbox
  $('#autoWolCheckboxSwitch').off('change');
  $('#autoWolCheckboxSwitch').on('change', function() {
    host.autoWolEnabled = $(this).prop('checked');
    console.log('%c[index.js, autoWolDialog]', 'color: green;', 'Host autoWolEnabled set to: ' + host.autoWolEnabled);
    saveHosts();
  });

  autoWolOverlay.style.display = 'flex';
  autoWolDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.AutoWolDialog);
  focusElement('cancelAutoWol');

  var isPolling = true;
  var pollTimeout = null;
  var hasFailed = false;

  var stopPollingTasks = function() {
    isPolling = false;
    if (pollTimeout) clearTimeout(pollTimeout);
    if (typeof abortSubnetScan === 'function') abortSubnetScan();
  };

  var cleanup = function() {
    stopPollingTasks();
    autoWolOverlay.style.display = 'none';
    autoWolDialog.close();
    isDialogOpen = false;
    Navigation.pop();
  };

  var sendWakeRequest = function() {
    $('#autoWolDialogText').html(t('Sending a Wake-on-LAN request to %1$s...', escapeHTML(host.hostname)));

    host.sendWOL().then(function(msg) {
      if (msg) console.log('%c[index.js, autoWolDialog]', 'color: green;', msg);
      $('#autoWolDialogText').html(
        t('Wake-on-LAN request sent to %1$s.', escapeHTML(host.hostname)) + '<br><br>' +
        t('Waiting for the host PC to wake up and connect to the network...')
      );

      var pollLoop = function() {
        if (!isPolling) return;

        // Continuously sweep the subnet to catch the host if it wakes up with a new DHCP IP
        var scanPromise = (typeof startSubnetScanner === 'function')
          ? Promise.resolve(startSubnetScanner()).catch(function(e){
              console.warn('%c[index.js, autoWolDialog]', 'color: orange;', 'Subnet scan failed during WOL wait, continuing to poll:', e);
            })
          : Promise.resolve();

        scanPromise.then(function() {
          if (!isPolling) return; // In case the dialog was closed during the scan
          
          host.pollServer(function(returnedHost) {
            if (!isPolling) return; // In case the dialog was closed while pollServer was running

            if (returnedHost.online) {
              cleanup();
              if (onSuccess) onSuccess();

              // Instantly update the UI to remove the offline styling
              updateHostStatusIndicator(returnedHost);
            } else {
              // Wait 1 second AFTER the previous poll finished before starting the next one.
              // This prevents rapid CPU spinning if the network drops temporarily and requests 
              // fail instantly, while still keeping the WOL check feeling responsive.
              pollTimeout = setTimeout(pollLoop, 1000);
            }
          });
        });
      };

      // Kick off the sequential polling loop
      pollLoop();

    }).catch(function(error) {
      hasFailed = true;
      stopPollingTasks();

      var errorMessage = typeof error === 'string' ? error : (error && error.message ? error.message : 'Unknown error');
      var translatedError = replaceKnownWolErrorLabels(errorMessage);
      $('#autoWolDialogText').html(
        t('Failed to send Wake-on-LAN request to %1$s!', escapeHTML(host.hostname)) + '<br><br>' +
        t('Error: %1$s', translatedError)
      );
      // Change the button text to "OK" to indicate that the user can acknowledge the failure
      $('#cancelAutoWol').html(t('OK'));
    });
  };

  $('#cancelAutoWol').off('click');
  $('#cancelAutoWol').on('click', function() {
    if (hasFailed) {
      console.error('%c[index.js, autoWolDialog]', 'color: green;', 'Wake-on-LAN request failed: ' + errorMessage);
    } else {
      console.log('%c[index.js, autoWolDialog]', 'color: green;', 'Wake-on-LAN request canceled by user.');
    }
    cleanup();
    if (onCancel) onCancel();
  });

  // Send wake request immediately since user explicitly opened the Wake PC menu
  sendWakeRequest();
}

// Add the new NvHTTP Host object inside the host grid
function addHostToGrid(host, ismDNSDiscovered) {
  // Create the host container with the appropriate attributes for the host card
  var hostContainer = $('<div>', {
    id: 'host-container-' + host.serverUid,
    class: 'host-container mdl-card mdl-shadow--4dp',
    role: 'link',
    tabindex: 0,
    'aria-label': host.hostname
  });

  // Create the host cell to serve as a holder for the host box
  var hostCell = $('<div>', {
    id: 'host-' + host.serverUid,
    class: 'mdl-card__title mdl-card--expand'
  });

  // Create the host title wrapper to hold the host title text
  var hostTitle = $('<div>', {
    class: 'host-title mdl-card__title-text'
  });

  // Create the host text placeholder that will contain the host name
  var hostText = $('<span>', {
    class: 'host-text',
    text: host.hostname
  });

  // Create the host menu button with the appropriate attributes for the host menu
  var hostMenu = $('<div>', {
    id: 'hostMenuButton-' + host.serverUid,
    class: 'host-menu',
    role: 'button',
    tabindex: 0,
    'aria-label': host.hostname + ' menu'
  });

  // Create the host center icon to indicate the host's status (online/offline/unpaired)
  var hostStatusIndicator = $('<i>', {
    id: 'host-status-' + host.serverUid,
    class: 'host-center-icon'
  });

  // Append the host text to the host title wrapper
  hostTitle.append(hostText);

  // Handle animation state based on host title text length
  if (host.hostname.length <= 26) {
    // For host title text of 26 characters or less, disable scrolling text animation
    hostText.addClass('disable-animation');
  } else {
    // For host title text longer than 26 characters, enable scrolling text animation
    hostText.removeClass('disable-animation');
  }

  // Append the host title to the host cell
  hostCell.append(hostTitle);

  // Append the host cell to the host container
  hostContainer.append(hostCell);

  // Append the host menu button to the host container
  hostContainer.append(hostMenu);

  // Append the host status indicator to the host container
  hostContainer.append(hostStatusIndicator);

  // Add the icon tile, the status chips and the options icon of the card (launcher.js)
  if (typeof Launcher !== 'undefined') {
    Launcher.decorateHostCard(hostContainer[0], host);
  }

  // Attach the click event listener to the host container
  hostContainer.off('click');
  hostContainer.on('click', function() {
    // Prevent further clicks
    if (isClickPrevented) {
      return;
    }
    // Block subsequent clicks immediately
    isClickPrevented = true;
    // Select the host when the Click key is pressed
    hostChosen(host);
    // Reset the click flag after 2 second delay
    setTimeout(() => isClickPrevented = false, 2000);
  });

  // Attach the click event listener to the host menu button
  hostMenu.off('click');
  hostMenu.on('click', function(e) {
    // Prevent the click event from propagating to the host container
    e.stopPropagation();
    // Select the host menu button when the Click key is pressed
    hostMenuDialog(host);
  });

  // Append the host container to the host grid
  $('#host-grid').append(hostContainer);

  // Set initial status, now that the card is in the page and can be found by its ID
  updateHostStatusIndicator(host);

  // Store the host object in the hosts array using its server UID as the key
  hosts[host.serverUid] = host;

  // Update the host's external IPv4 address if it was discovered via mDNS
  if (ismDNSDiscovered) {
    hosts[host.serverUid].updateExternalAddressIP4();
  }
}

// Function to correctly update and store the valid MAC address of the host in IndexedDB
function updateMacAddress(host) {
  getData('hosts', function(previousValue) {
    var dbHosts = previousValue.hosts != null ? previousValue.hosts : {};
    if (host.macAddress != '00:00:00:00:00:00') {
      if (dbHosts[host.serverUid] && dbHosts[host.serverUid].macAddress != host.macAddress) {
        console.log('%c[index.js, updateMacAddress]', 'color: green;', 'Updated MAC address for host ' + host.hostname + ' from ' + dbHosts[host.serverUid].macAddress + ' to ' + host.macAddress);
        if (hosts[host.serverUid]) {
          hosts[host.serverUid].macAddress = host.macAddress;
        }
        saveHosts();
      }
    }
  });
}

// Show the Host Menu dialog with host button options
function hostMenuDialog(host) {
  // Create an overlay for the dialog and append it to the body
  var hostMenuDialogOverlay = $('<div>', {
    id: 'hostMenuDialogOverlay-' + host.serverUid,
    class: 'dialog-overlay'
  }).appendTo(document.body);

  // Create the dialog element and append it to the overlay, a list with icons like the app menu (menus.js)
  var hostMenuDialog = $('<dialog>', {
    id: 'hostMenuDialog-' + host.serverUid,
    class: 'overlay-menu host-menu-dialog'
  }).appendTo(hostMenuDialogOverlay);

  // Add the dialog title with the host's name
  $('<h3>', {
    id: 'hostMenuDialogTitle-' + host.serverUid,
    class: 'overlay-menu-title',
    text: host.hostname
  }).appendTo($('<div>', { class: 'overlay-menu-header' }).appendTo(hostMenuDialog));

  // A menu entry with a stroke icon of the sprite in index.html
  var hostMenuItem = function(id, icon, text, className) {
    return $('<button>', {
      type: 'button',
      id: id,
      class: 'overlay-menu-item' + (className ? ' ' + className : '')
    }).html('<svg class="overlay-menu-icon icon" aria-hidden="true"><use xlink:href="#i-' + icon + '"/></svg>')
      .append($('<span>', { class: 'overlay-menu-label', text: text }));
  };

  // Define the options for the menu with the corresponding attributes
  var hostMenuDialogOptions = [
    {
      id: 'refreshApps-' + host.hostname,
      icon: 'refresh',
      text: t('Refresh apps'),
      disabled: !host.online,
      action: function() {
        // Refresh the list of apps for the target host
        snackbarLogLong('Refreshing the list of %1$s applications...', host.hostname);
        host.clearBoxArt();
        host.getAppListWithCacheFlush();
      }
    },
    {
      id: 'wakeHost-' + host.hostname,
      icon: 'power',
      text: t('Wake PC'),
      disabled: host.online,
      action: function() {
        // Check if MAC is randomized
        if (isRandomMacAddress(host.macAddress)) {
          // Show warning dialog for randomized MAC addresses
          setTimeout(() => wakeOnLanWarningDialog(host), 100);
        } else {
          // Send a Wake-on-LAN request to the target host
          setTimeout(() => autoWolDialog(host, function() {}, function() {}), 100);
        }
      }
    },
    {
      id: 'deleteHost-' + host.hostname,
      icon: 'trash',
      // Destructive, in red
      class: 'is-danger',
      text: t('Delete PC'),
      action: function() {
        // Remove the selected host from the list
        setTimeout(() => deleteHostDialog(host), 100);
      }
    },
    {
      id: 'viewDetails-' + host.hostname,
      icon: 'info',
      text: t('View Details'),
      action: function() {
        // View details of the selected host
        setTimeout(() => hostDetailsDialog(host), 100);
      }
    },
  ];

  // Loop through each option to create a button in the dialog
  hostMenuDialogOptions.forEach(function(menuOption) {
    var hostMenuDialogOption = hostMenuItem(menuOption.id, menuOption.icon, menuOption.text, menuOption.class)
      .prop('disabled', menuOption.disabled || false);
    // Trigger the action if the Option button is pressed
    hostMenuDialogOption.off('click');
    hostMenuDialogOption.click(function() {
      Navigation.pop();
      menuOption.action();
      $(hostMenuDialogOverlay).css('display', 'none');
      hostMenuDialog[0].close();
      hostMenuDialogOverlay.remove();
      isDialogOpen = false;
    });
    // Append the button to the dialog
    hostMenuDialogOption.appendTo(hostMenuDialog);
  });

  // Create and set up the Close button, the last entry
  var closeHostMenuDialog = hostMenuItem('closeHostMenu', 'close', t('Close'));

  // Close the dialog if the Close button is pressed
  closeHostMenuDialog.off('click');
  closeHostMenuDialog.click(function() {
    console.log('%c[index.js, hostMenuDialog]', 'color: green;', 'Closing app dialog and returning.');
    $(hostMenuDialogOverlay).css('display', 'none');
    hostMenuDialog[0].close();
    hostMenuDialogOverlay.remove();
    isDialogOpen = false;
    Navigation.pop();
  }).appendTo(hostMenuDialog);

  // If the dialog element doesn't support the showModal method, register it with dialogPolyfill
  if (!hostMenuDialog[0].showModal) {
    dialogPolyfill.registerDialog(hostMenuDialog[0]);
  }

  // Show the dialog and push the view
  $(hostMenuDialogOverlay).css('display', 'flex');
  hostMenuDialog[0].showModal();
  isDialogOpen = true;
  Navigation.push(Views.HostMenuDialog, host.hostname);
  setTimeout(() => Navigation.switch(), 5);
}

// Show a confirmation with the Delete Host dialog before removing the host object
function deleteHostDialog(host) {
  // Find the existing overlay and dialog elements
  var deleteHostOverlay = document.querySelector('#deleteHostDialogOverlay');
  var deleteHostDialog = document.querySelector('#deleteHostDialog');

  // Change the dialog title and text elements to include the hostname
  document.getElementById('deleteHostDialogTitle').innerHTML = t('Delete Host');
  document.getElementById('deleteHostDialogText').innerHTML = t('Are you sure you want to delete %1$s?', escapeHTML(host.hostname));

  // Show the dialog and push the view
  deleteHostOverlay.style.display = 'flex';
  deleteHostDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.DeleteHostDialog);

  // Cancel the operation if the Cancel button is pressed
  $('#cancelDeleteHost').off('click');
  $('#cancelDeleteHost').on('click', function() {
    console.log('%c[index.js, deleteHostDialog]', 'color: green;', 'Closing app dialog and returning.');
    deleteHostOverlay.style.display = 'none';
    deleteHostDialog.close();
    isDialogOpen = false;
    Navigation.pop();
  });

  // Remove the host object if the Continue button is pressed
  // locally remove the hostname/ip from the saved `hosts` array
  // NOTE: this does not make the host forget the pairing to us
  // This means we can re-add the host, and will still be paired
  $('#continueDeleteHost').off('click');
  $('#continueDeleteHost').on('click', function() {
    console.log('%c[index.js, deleteHostDialog]', 'color: green;', 'Removing host, closing app dialog, and returning.');
    // Remove the host container from the grid
    $('#host-container-' + host.serverUid).remove();
    // Stop background polling for removed host
    endBackgroundPollingOfHost(host);
    // Remove the host from the hosts object
    delete hosts[host.serverUid];
    // Save the updated hosts
    saveHosts();
    // Remove the host from the preview app cache and update Smart Hub Preview
    delete _previewApps[host.serverUid];
    savePreviewApps();
    updatePreviewData();
    // Forget the apps that were hidden for the host
    forgetHiddenApps(host.serverUid);
    // If host removed, show snackbar message
    snackbarLog('%1$s has been deleted successfully.', host.hostname);
    deleteHostOverlay.style.display = 'none';
    deleteHostDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    // Reset the Hosts view navigation index to prevent possible out-of-bounds errors
    Views.Hosts.view.reset();
    Navigation.switch();
  });
}

// Show a confirmation with the Delete Host dialog before removing all hosts objects
function deleteAllHostsDialog() {
  if (Object.keys(hosts).length === 0) {
    // If there are no hosts, show snackbar message
    snackbarLog('No host exists.');
    return;
  } else {
    // Find the existing overlay and dialog elements
    var deleteHostOverlay = document.querySelector('#deleteHostDialogOverlay');
    var deleteHostDialog = document.querySelector('#deleteHostDialog');

    // Change the dialog title and text elements
    document.getElementById('deleteHostDialogTitle').innerHTML = t('Delete All Hosts');
    document.getElementById('deleteHostDialogText').innerHTML = t('Are you sure you want to delete all existing hosts?');
    
    // Show the dialog and push the view
    deleteHostOverlay.style.display = 'flex';
    deleteHostDialog.showModal();
    isDialogOpen = true;
    Navigation.push(Views.DeleteHostDialog);
  
    // Cancel the operation if the Cancel button is pressed
    $('#cancelDeleteHost').off('click');
    $('#cancelDeleteHost').on('click', function() {
      console.log('%c[index.js, deleteAllHostsDialog]', 'color: green;', 'Closing app dialog and returning.');
      deleteHostOverlay.style.display = 'none';
      deleteHostDialog.close();
      isDialogOpen = false;
      Navigation.pop();
      Navigation.switch();
    });
  
    // Remove all existing hosts if the Continue button is pressed
    $('#continueDeleteHost').off('click');
    $('#continueDeleteHost').on('click', function() {
      console.log('%c[index.js, deleteAllHostsDialog]', 'color: green;', 'Removing all hosts, closing app dialog, and returning.');
      // Stop background polling for all hosts before removing them
      stopPollingHosts();
      // Iterate through all hosts and remove them
      for (var serverUid in hosts) {
        if (hosts.hasOwnProperty(serverUid)) {
          var host = hosts[serverUid];
          // Remove the host container from the grid
          $('#host-container-' + host.serverUid).remove();
          // Remove the host from the hosts object
          delete hosts[host.serverUid];
          // Forget the apps that were hidden for the host
          forgetHiddenApps(host.serverUid);
          // Save the updated hosts (empty hosts object)
          saveHosts();
        }
      }
      // If all hosts removed, show snackbar message
      snackbarLog('All hosts have been deleted successfully.');
      // Clear the preview app cache and update Smart Hub Preview
      _previewApps = {};
      savePreviewApps();
      updatePreviewData();
      deleteHostOverlay.style.display = 'none';
      deleteHostDialog.close();
      isDialogOpen = false;
      Navigation.pop();
      // Reset the Hosts view navigation index to prevent possible out-of-bounds errors
      Views.Hosts.view.reset();
      Navigation.switch();
    });
  }
}

// Show the Host Details dialog with host information details
function hostDetailsDialog(host) {
  // Create an overlay for the dialog and append it to the body
  var hostDetailsDialogOverlay = $('<div>', {
    id: 'hostDetailsDialogOverlay-' + host.serverUid,
    class: 'dialog-overlay'
  }).appendTo(document.body);

  // Create the dialog element and append it to the overlay
  var hostDetailsDialog = $('<dialog>', {
    id: 'hostDetailsDialog-' + host.serverUid,
    class: 'mdl-dialog'
  }).appendTo(hostDetailsDialogOverlay);

  // Add a dialog title named Host Details
  $('<h3>', {
    id: 'hostDetailsDialogTitle-' + host.serverUid,
    class: 'mdl-dialog__title',
    'data-i18n': 'Host Details',
    text: t('Host Details')
  }).appendTo(hostDetailsDialog);

  // Create a content section inside the dialog
  var hostDetailsDialogContent = $('<div>', {
    class: 'mdl-dialog__content'
  }).appendTo(hostDetailsDialog);

  // Add a paragraph with multiple lines of text
  $('<p>', {
    id: 'hostDetailsDialogText-' + host.serverUid,
    class: 'host-details-text',
    html: [
      t('Name: %1$s', escapeHTML(host.hostname)),
      t('State: %1$s', escapeHTML(host.online) ? t('ONLINE') : t('OFFLINE')),
      t('Active Address: %1$s', escapeHTML(host.address) && escapeHTML(host.externalPort) ? escapeHTML(host.address) + ':' + escapeHTML(host.externalPort) : t('NULL')),
      t('UUID: %1$s', escapeHTML(host.serverUid) ? escapeHTML(host.serverUid) : t('NULL')),
      t('Local Address: %1$s', escapeHTML(host.localAddress) && escapeHTML(host.externalPort) ? escapeHTML(host.localAddress) + ':' + escapeHTML(host.externalPort) : t('NULL')),
      t('MAC Address: %1$s', escapeHTML(host.macAddress) ? escapeHTML(host.macAddress) : t('NULL')),
      t('Pair State: %1$s', escapeHTML(host.paired) ? t('PAIRED') : t('UNPAIRED')),
      t('Running Game ID: %1$s', escapeHTML(host.currentGame)),
      t('HTTP Port: %1$s', escapeHTML(host.httpPort) ? escapeHTML(host.httpPort) : t('NULL')),
      t('HTTPS Port: %1$s', escapeHTML(host.httpsPort) ? escapeHTML(host.httpsPort) : t('NULL'))
    ].join('<br>')
  }).appendTo(hostDetailsDialogContent);

  // Create the actions section inside the dialog
  var hostDetailsDialogActions = $('<div>', {
    class: 'mdl-dialog__actions'
  }).appendTo(hostDetailsDialog);

  // Create and set up the Close button
  var closeHostDetailsDialog = $('<button>', {
    type: 'button',
    id: 'closeHostDetails',
    class: 'mdl-button mdl-js-button mdl-button--raised mdl-button--colored mdl-js-ripple-effect',
    'data-i18n': 'Close',
    text: t('Close')
  });

  // Close the dialog if the Close button is pressed
  closeHostDetailsDialog.off('click');
  closeHostDetailsDialog.click(function() {
    console.log('%c[index.js, hostDetailsDialog]', 'color: green;', 'Closing app dialog and returning.');
    $(hostDetailsDialogOverlay).css('display', 'none');
    hostDetailsDialog[0].close();
    hostDetailsDialogOverlay.remove();
    isDialogOpen = false;
    Navigation.pop();
  }).appendTo(hostDetailsDialogActions);

  // If the dialog element doesn't support the showModal method, register it with dialogPolyfill
  if (!hostDetailsDialog[0].showModal) {
    dialogPolyfill.registerDialog(hostDetailsDialog[0]);
  }

  // Show the dialog and push the view
  $(hostDetailsDialogOverlay).css('display', 'flex');
  hostDetailsDialog[0].showModal();
  isDialogOpen = true;
  Navigation.push(Views.HostDetailsDialog);
  setTimeout(() => Navigation.switch(), 5);
}

// Show the Moonlight Plus Support dialog, whose QR code leads to the guide of Moonlight Plus (docs/GUIDE.md)
function appSupportDialog() {
  // Find the existing overlay and dialog elements
  var appSupportDialogOverlay = document.querySelector('#appSupportDialogOverlay');
  var appSupportDialog = document.querySelector('#appSupportDialog');

  // Show the dialog and push the view
  appSupportDialogOverlay.style.display = 'flex';
  appSupportDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.MoonlightSupportDialog);

  // Close the dialog if the Close button is pressed
  $('#closeAppSupport').off('click');
  $('#closeAppSupport').on('click', function() {
    console.log('%c[index.js, appSupportDialog]', 'color: green;', 'Closing app dialog and returning.');
    appSupportDialogOverlay.style.display = 'none';
    appSupportDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
  });
}

// Handle layout elements when displaying the Settings view
function showSettingsMode() {
  if (typeof setUiView === 'function') {
    setUiView('settings');
  }
  console.log('%c[index.js, showSettingsMode]', 'color: green;', 'Entering "Show Settings" mode.');
  $('#header-title').attr('data-i18n', 'Settings').html(t('Settings'));
  $('#header-logo').show();
  $('#main-header').show();
  $('#appMenuHint').hide();
  $('#goBackBtn').show();
  $('#restoreDefaultsBtn').show();
  $('#main-content').children().not('#listener, #loadingSpinner, #wasmSpinner').show();
  $('#host-grid').hide();
  $('#game-grid').hide();
  $('.nav-menu-parent').hide();
  $('#updateAppBtn').hide();
  $('#rescanNetworkBtn').hide();
  $('#settingsBtn').hide();
  $('#supportBtn').hide();
  $('#quitRunningAppBtn').hide();
  $('#connection-warnings').css('display', 'none');
  $('#performance-stats').css('display', 'none');
  $('#main-content').removeClass('fullscreen');
  $('#listener').removeClass('fullscreen');

  stopPollingHosts();
  Navigation.start();
  Controller.startWatching();
  // Register showSettingsMode to re-run every time the language changes
  if (window.i18n && typeof window.i18n.onRefresh === 'function') {
    window.i18n.onRefresh(showSettingsMode);
  }
}

// Show the Settings list
function showSettings() {
  // Stop navigation before showing the loading screen
  Navigation.stop();

  // Hide the main header and content before showing a loading screen
  $('#main-header').children().hide();
  $('#main-header').css({'backgroundColor': 'transparent', 'boxShadow': 'none'});
  $('#host-grid, #game-grid').hide();

  // Show a spinner while the setting list loads
  if (typeof setUiView === 'function') {
    setUiView('loading');
  }
  $('#wasmSpinner').css('display', 'inline-block');
  $('#wasmSpinnerLogo').hide();
  $('#wasmSpinnerMessage').text(t('Loading Settings...'));

  setTimeout(() => {
    // Hide the spinner after successfully retrieving the setting list
    $('#wasmSpinner').hide();

    // Show the main header after the loading screen is complete
    $('#main-header').children().show();
    $('#main-header').css({'backgroundColor': '', 'boxShadow': ''});

    // Show the settings list section
    $('#settings-list').removeClass('hide-container');
    $('#settings-list').css('display', 'flex');
    $('#settings-list').show();

    // Navigate to the Settings view
    Navigation.push(Views.Settings);
    showSettingsMode();
  }, 500);
}

// Reset the current settings view by clearing the selection and hiding the right pane
function resetSettingsView() {
  // Hide all settings options from the right pane
  document.querySelectorAll('.settings-options').forEach(function(settingsOption) {
    settingsOption.style.display = 'none';
  });

  // Remove the 'selected' class from all settings categories
  document.querySelectorAll('.settings-category').forEach(function(settingsCategory) {
    settingsCategory.classList.remove('selected');
  });

  // Remove the section name from the header
  document.body.removeAttribute('data-section');
  $('#header-section').removeAttr('data-i18n').text('');
}

// Navigate to the provided settings view by pushing the target view and set the focus to the setting
function navigateSettingsView(view) {
  Navigation.pop();
  Navigation.push(view);
  setTimeout(() => Navigation.switch(), 250);
}

// Handle category selection, display appropriate options, and navigate to the provided settings pane
function handleSettingsView(category) {
  // Reset the current settings view before navigating to the next settings view
  resetSettingsView();

  // Show appropriate settings options in the target pane based on the selected settings category
  const targetPaneOptions = document.getElementById(category);
  const selectedCategory = document.querySelector(`.settings-category[data-category="${category}"]`);

  // Show the target pane options if the target pane exists
  if (targetPaneOptions) {
    // Show the pane view
    targetPaneOptions.style.display = 'block';
  } else {
    // Otherwise, exit early
    return;
  }

  // Add the 'selected' class to the clicked settings category
  if (selectedCategory) {
    // Mark the category as selected
    selectedCategory.classList.add('selected');
    // Name the section in the header (in its colour), with its locale key for a change of the language
    const sectionLabel = selectedCategory.querySelector('label');
    document.body.setAttribute('data-section', category);
    $('#header-section').attr('data-i18n', sectionLabel.getAttribute('data-i18n')).text(sectionLabel.textContent.trim());
  } else {
    // Otherwise, exit early
    return;
  }

  // Navigate to the corresponding settings view
  switch (category) {
    case 'basicSettings': // Navigate to the BasicSettings view
      navigateSettingsView(Views.BasicSettings);
      break;
    case 'interfaceSettings': // Navigate to the InterfaceSettings view
      navigateSettingsView(Views.InterfaceSettings);
      break;
    case 'hostSettings': // Navigate to the HostSettings view
      navigateSettingsView(Views.HostSettings);
      break;
    case 'inputSettings': // Navigate to the InputSettings view
      navigateSettingsView(Views.InputSettings);
      break;
    case 'audioSettings': // Navigate to the AudioSettings view
      navigateSettingsView(Views.AudioSettings);
      break;
    case 'videoSettings': // Navigate to the VideoSettings view
      navigateSettingsView(Views.VideoSettings);
      break;
    case 'advancedSettings': // Navigate to the AdvancedSettings view
      navigateSettingsView(Views.AdvancedSettings);
      break;
    case 'aboutSettings': // Navigate to the AboutSettings view
      // Refresh the system information, whose network connection type may have changed since the start of the app
      loadSystemInfo();
      navigateSettingsView(Views.AboutSettings);
      break;
    default:
      break;
  }
}

// Show the Navigation Guide dialog
function navigationGuideDialog() {
  // Find the existing overlay and dialog elements
  var navGuideDialogOverlay = document.querySelector('#navGuideDialogOverlay');
  var navGuideDialog = document.querySelector('#navGuideDialog');

  // Show the dialog and push the view
  navGuideDialogOverlay.style.display = 'flex';
  navGuideDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.NavigationGuideDialog);

  // Close the dialog if the Close button is pressed
  $('#closeNavGuide').off('click');
  $('#closeNavGuide').on('click', function() {
    console.log('%c[index.js, navigationGuideDialog]', 'color: green;', 'Closing app dialog and returning.');
    navGuideDialogOverlay.style.display = 'none';
    navGuideDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
  });
}

// Check whether a repository constant still holds its placeholder, i.e. the app was not built with the Dockerfile. The
// pattern must not spell out the placeholders: the build replaces every occurrence of them in this file, which turned
// the former comparison with the placeholder into a comparison with the injected value, so that every build checked
// the upstream repository for updates.
function isRepoPlaceholder(value) {
  return /^__REPO_[A-Z]+__$/.test(value);
}

// Fetch the latest version and release notes from GitHub API
function fetchLatestRelease() {
  // Check if the REPO_OWNER and REPO_NAME are set to placeholders and apply fallback values (an app that was not built
  // with the Dockerfile, which requires them for release and development builds)
  const repoOwner = isRepoPlaceholder(REPO_OWNER) ? 'brightcraft' : REPO_OWNER;
  const repoName = isRepoPlaceholder(REPO_NAME) ? 'moonlight-tizen' : REPO_NAME;

  // GitHub API endpoint to get the latest released version
  const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;

  // Fetch the latest release data from the GitHub API
  return fetch(apiUrl).then(response => {
    if (!response.ok) {
      throw new Error('Network response failed: ' + response.statusText);
    }
    // Parse JSON response
    return response.json();
  }).then(data => {
    // Get the latest version and release notes from the released update
    let latestVersion = data.tag_name.startsWith('v') ? data.tag_name.slice(1) : data.tag_name;
    const releaseNotes = extractReleaseNotes(data.body) || t('• No relevant changes found.');
    return { latestVersion, releaseNotes };
  });
}

// Split a version into its numbers: the numeric x.y.z part as [x, y, z], and the number at the end of a suffix after
// it, e.g. 2 for '1.19.0-beta.2' or 1 for '1.19.0.1' (null without a suffix or when the suffix doesn't end in a
// number). Returns null for a missing or malformed version that doesn't start with x.y.z, e.g. '1.19' or 'latest'.
function parseAppVersion(version) {
  if (typeof version !== 'string') {
    return null;
  }
  // The suffix is a list of letters and digits, each after a separator (-, +, . or _)
  const match = /^v?(\d+)\.(\d+)\.(\d+)((?:[-+._][0-9A-Za-z]+)*)$/.exec(version.trim());
  if (!match) {
    return null;
  }
  const suffixNumber = /(\d+)$/.exec(match[4]);
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    suffixNumber: suffixNumber ? Number(suffixNumber[1]) : null
  };
}

// Compare the current version with the latest version to determine if an update is available. The numeric x.y.z part
// decides first, so that a release of this fork such as 1.19.100 (tag v1.19.100) is announced to an installed 1.19.0.
// With the same x.y.z, the numbers at the end of the suffixes decide when both versions have one (1.19.0-beta.1 before
// 1.19.0-beta.2). A suffix on the same x.y.z alone is no update: the earlier releases of this fork had tags such as
// v1.19.0-<suffix>.2 for a build that installs as 1.19.0, since the app version on the TV is always a plain x.y.z
// (res/config.xml).
function checkVersionUpdate(currentVersion, latestVersion) {
  const current = parseAppVersion(currentVersion);
  const latest = parseAppVersion(latestVersion);
  // Return false if either version is missing or malformed, so that the app never announces an update it can't prove
  if (!current || !latest) {
    return false;
  }

  // Compare the major, minor and patch numbers in turn
  for (let i = 0; i < 3; i++) {
    if (latest.parts[i] !== current.parts[i]) {
      // A higher number in the latest version is an update, a lower one is none
      return latest.parts[i] > current.parts[i];
    }
  }
  // With the same x.y.z, only a higher suffix number of the latest version is an update, and only when both have one
  if (latest.suffixNumber !== null && current.suffixNumber !== null) {
    return latest.suffixNumber > current.suffixNumber;
  }
  return false;
}

// The update dialog has no scroll bar and is 30 % of the screen wide, so it shows the release notes up to about this
// many rows of text, counting RELEASE_NOTES_ROW_CHARS characters as one row, and points to the release page for the rest
const RELEASE_NOTES_MAX_ROWS = 20;
const RELEASE_NOTES_ROW_CHARS = 45;

// Turn the inline Markdown of a release note line into plain text: images are dropped, links keep their text, and bold,
// italic and inline code lose their marks. The content of inline code and characters escaped with a backslash are set
// aside first and put back at the end, so that their marks stay as they are.
function releaseNoteMarkdownToText(text) {
  const keptTexts = [];
  const keep = (value) => {
    keptTexts.push(value);
    return '' + (keptTexts.length - 1) + '';
  };
  return text
    .replace(/`([^`]*)`/g, (match, code) => keep(code))
    .replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, (match, character) => keep(character))
    // Images, also the badges inside links
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Links keep their text, autolinks their address
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    // HTML tags, e.g. <br> or <details>
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1$2')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?=[^_\w]|$)/g, '$1$2')
    .replace(/(\d+)/g, (match, index) => keptTexts[Number(index)])
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract the "What's Changed" section of a release and turn its Markdown into plain text lines for the update dialog,
// joined with <br> and escaped as HTML. The section ends at the "**Full Changelog**" line of upstream releases, at the
// "- **Commit**:" line that the release workflows of this fork add after the notes (release-development.yml and
// release-stable.yml), or at the next heading of level 1 or 2. Returns null without a "What's Changed" section.
// - headings become a line of their own without a trailing period
// - bullets become '•', nested bullets an indented '–', numbered items keep their number
// - quotes lose their marks, and GitHub alert markers ('> [!NOTE]') and rules ('---') are dropped
// - other lines get a trailing period if they end without punctuation
// - notes longer than RELEASE_NOTES_MAX_ROWS rows end with a pointer to the release page
function extractReleaseNotes(releaseNotes) {
  const lines = String(releaseNotes || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+What's Changed:?\s*$/i.test(line.trim()));
  // Return null if release notes section is not found or does not match expected format
  if (start < 0) {
    return null;
  }

  const output = [];
  let rows = 0;
  let truncated = false;
  for (let i = start + 1; i < lines.length; i++) {
    const rawLine = lines[i].replace(/\t/g, '    ');
    let line = rawLine.trim();
    if (/^\*\*Full Changelog\*\*/i.test(line) || /^[-*+]\s+\*\*Commit\*\*:/i.test(line) || /^#{1,2}\s/.test(line)) {
      break;
    }
    // Quotes and GitHub alerts keep their text without the marks
    line = line.replace(/^(>\s?)+/, '').trim();
    if (line === '' || /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i.test(line) || /^([-*_])(\s*\1){2,}$/.test(line)) {
      continue;
    }
    // Remove contributor attribution and PR references
    line = line.replace(/\s+by\s+@[^]+$/i, '');

    let prefix = '';
    let isHeading = false;
    let match;
    const indent = rawLine.length - rawLine.replace(/^\s+/, '').length;
    const nestingPrefix = indent >= 2 ? '    ' : '';
    if ((match = /^#{3,6}\s+(.*?)\s*#*$/.exec(line))) {
      isHeading = true;
      line = match[1];
    } else if ((match = /^[-*+]\s+(.*)$/.exec(line))) {
      prefix = nestingPrefix + (nestingPrefix ? '– ' : '• ');
      line = match[1];
    } else if ((match = /^(\d+)[.)]\s+(.*)$/.exec(line))) {
      prefix = nestingPrefix + match[1] + '. ';
      line = match[2];
    }

    let text = releaseNoteMarkdownToText(line);
    if (text === '') {
      continue;
    }
    // Add trailing period if missing
    if (!isHeading && !/[.:!?]$/.test(text)) {
      text += '.';
    }
    text = prefix + text;

    // Keep the dialog on the screen: stop before the line that would exceed the rows, but show at least one line
    const lineRows = Math.max(1, Math.ceil(text.length / RELEASE_NOTES_ROW_CHARS));
    if (output.length > 0 && rows + lineRows > RELEASE_NOTES_MAX_ROWS) {
      truncated = true;
      break;
    }
    rows += lineRows;
    output.push(escapeHTML(text));
  }

  if (output.length === 0) {
    return null;
  }
  if (truncated) {
    output.push(escapeHTML(t('… More changes are listed on the release page on GitHub.')));
  }
  return output.join('<br>');
}

// Format the update timestamp into a readable string as "dd/mm/yyyy hh:mm"
function formatUpdateTimestamp(ms) {
  var date = new Date(ms);
  var day = date.getDate().toString().padStart(2, '0');
  var month = (date.getMonth() + 1).toString().padStart(2, '0');
  var year = date.getFullYear();
  var hour = date.getHours().toString().padStart(2, '0');
  var minute = date.getMinutes().toString().padStart(2, '0');
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

// Show the Update App button when a new update is found
function updateAppButton(latestVersion) {
  // Prevent adding duplicate buttons if one already exists
  if ($('#updateAppBtn').length > 0) {
    console.log('%c[index.js, updateAppButton]', 'color: green;', 'Update App button already exists. Skipping duplicate creation!');
    return;
  }

  // Create the button dynamically
  var updateAppBtn = $('<button>', {
    type: 'button',
    id: 'updateAppBtn',
    class: 'mdl-button mdl-js-button mdl-button--raised mdl-button--colored mdl-js-ripple-effect',
    'aria-label': 'Update App'
  });
  // Create the badge icon dynamically
  var updateAppBtnBadge = $('<div>', {
    class: 'navigation-button-icons mdl-badge mdl-badge--overlap',
    'data-badge': '1',
    html: '<svg class="icon" aria-hidden="true"><use xlink:href="#i-download"/></svg>'
  });
  // Create the button text dynamically
  var updateAppBtnText = $('<span>', {
    id: 'updateAppBtnText',
    'data-i18n': 'New update v%1$s',
    'data-param': latestVersion,
    text: t('New update v%1$s', latestVersion)
  });
  // Create the button tooltip dynamically
  var updateAppBtnTooltip = $('<div>', {
    id: 'updateAppBtnTooltip',
    class: 'mdl-tooltip',
    'for': 'updateAppBtn',
    'data-i18n': 'Check what\'s new',
    text: t('Check what\'s new')
  });
  // Create the layout spacer dynamically
  var extraLayoutSpacer = $('<div>', {
    class: 'mdl-layout-spacer'
  });
  // Append elements inside the button
  updateAppBtn.append(updateAppBtnBadge, updateAppBtnText);
  // Insert elements after the existing layout spacer
  $('.mdl-layout-spacer').after(updateAppBtn, updateAppBtnTooltip, extraLayoutSpacer);
  // Upgrade newly added elements for MDL styling
  componentHandler.upgradeElement(updateAppBtn[0]);
  componentHandler.upgradeElement(updateAppBtnTooltip[0]);
  componentHandler.upgradeDom();
  // Smoothly fade-in the button after inserting
  setTimeout(() => {
    updateAppBtn.css({
      opacity: 1,
      transform: 'translateY(0)'
    });
  }, 1200);
  // Attach the click event listener to the Update App button
  updateAppBtn.off('click');
  updateAppBtn.on('click', function() {
    console.log('%c[index.js, updateAppButton]', 'color: green;', 'Checking for new update release notes...');
    // Fetch the latest release data from the GitHub API
    fetchLatestRelease().then(({ latestVersion, releaseNotes }) => {
      setTimeout(() => {
        // Check if a new version update is available
        if (checkVersionUpdate(appInfo.version, latestVersion)) {
          // Show the Update Moonlight dialog with new version and release notes to inform user to update the app
          updateAppDialog(latestVersion, releaseNotes);
        }
      }, 500);
    }).catch(error => {
      console.error('%c[index.js, updateAppButton]', 'color: green;', 'Error: Failed to fetch the release data!', error);
      snackbarLogLong('Unable to check update release notes at this time. Please try again later!');
    });
  });
}

// Show the Update Moonlight dialog
function updateAppDialog(latestVersion, releaseNotes) {
  // Find the existing overlay and dialog elements
  var updateAppDialogOverlay = $('#updateAppDialogOverlay');
  var updateAppDialog = $('#updateAppDialog');

  // Update the dialog text dynamically
  $('#updateAppDialogText').html(
	t('Version %1$s is now available! Update manually to enjoy new features and improvements.<br><br>', latestVersion) + 
	t('<strong>What\'s Changed:</strong><br>%1$s', releaseNotes)
  );

  // Set up the Close button
  $('#closeUpdateApp').off('click').on('click', function() {
    console.log('%c[index.js, updateAppDialog]', 'color: green;', 'Closing app dialog and returning.');
    updateAppDialogOverlay.css('display', 'none');
    updateAppDialog[0].close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
  });

  // Check if the dialog element does not support the showModal method
  if (!updateAppDialog[0].showModal) {
    // Register the dialog with dialogPolyfill to enable modal functionality for older browsers
    dialogPolyfill.registerDialog(updateAppDialog[0]);
  }

  // Show the dialog and push the view
  updateAppDialogOverlay.css('display', 'flex');
  updateAppDialog[0].showModal();
  isDialogOpen = true;
  Navigation.push(Views.UpdateMoonlightDialog);
}

// Check for updates when the Check for Updates button is pressed
function checkForAppUpdates() {
  console.log('%c[index.js, checkForAppUpdates]', 'color: green;', 'Checking for new application updates...');
  snackbarLog('Checking for available Moonlight updates...');
  // Fetch the latest release data from the GitHub API
  fetchLatestRelease().then(({ latestVersion, releaseNotes }) => {
    setTimeout(() => {
      // Check if a new version update is available
      if (checkVersionUpdate(appInfo.version, latestVersion)) {
        // Show the Update Moonlight dialog with new version and release notes to inform user to update the app
        updateAppDialog(latestVersion, releaseNotes);
        // Create and display the Update App button so they can access it later if they close the dialog
        updateAppButton(latestVersion);
      } else {
        // Otherwise, show a snackbar message to inform the user that the app is already up to date
        snackbarLogLong('Your app is already up to date! You\'re on the latest version.');
      }
    }, 1500);
  }).catch(error => {
    console.error('%c[index.js, checkForAppUpdates]', 'color: green;', 'Error: Failed to fetch the release data!', error);
    snackbarLogLong('Unable to check for updates right now. Please try again later!');
  });
}

// Automatically perform a scheduled app update check at startup if the interval condition is met and notify the user
function checkForAppUpdatesAtStartup() {
  // Fetch the current timestamp and stored version info
  getData(UPDATE_TIMESTAMP, function(tResult) {
    var lastChecked = tResult[UPDATE_TIMESTAMP];
    var currentTime = Date.now();
    // Log the last auto-check timestamp if it exists
    if (lastChecked) {
      console.log('%c[index.js, checkForAppUpdatesAtStartup]', 'color: green;', `Last auto-check performed: ${formatUpdateTimestamp(lastChecked)}`);
    }
    // Check if enough time has passed since the last update check
    if (!lastChecked || currentTime - lastChecked > UPDATE_INTERVAL) {
      console.log('%c[index.js, checkForAppUpdatesAtStartup]', 'color: green;', 'Performing auto-check for new application updates...');
      // Fetch the latest release data from the GitHub API
      fetchLatestRelease().then(({ latestVersion }) => {
        setTimeout(() => {
          // Check if a new version update is available
          if (checkVersionUpdate(appInfo.version, latestVersion)) {
            // Show snackbar message with new version to inform user to update the app
            snackbarLogLong('Version %1$s is now available! Check out the latest features & improvements.', latestVersion);
            // Create and display the Update App button with tooltip and additional layout spacer
            updateAppButton(latestVersion);
          }
        }, 100);
        // Save the fetched version as the last known update version
        storeData(UPDATE_VERSION, latestVersion);
      }).catch(error => {
        console.error('%c[index.js, checkForAppUpdatesAtStartup]', 'color: green;', 'Error: Failed to fetch the release data!', error);
        snackbarLogLong('Cannot automatically check for updates at this time!');
      });
      // Save the current time as the last update check timestamp
      storeData(UPDATE_TIMESTAMP, currentTime);
      console.log('%c[index.js, checkForAppUpdatesAtStartup]', 'color: green;', `New auto-check timestamp stored: ${formatUpdateTimestamp(currentTime)}`);
    } else {
      var timeLeft = UPDATE_INTERVAL - (currentTime - lastChecked);
      var hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
      var minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
      console.log(
        '%c[index.js, checkForAppUpdatesAtStartup]', 'color: green;', 
        'Auto-update check skipped as the last one was within the past 24 hours. ' + 
        `Next auto-check will occur in ${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''} and ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.`
      );
      // Still show the Update App button if a newer version was previously cached
      getData(UPDATE_VERSION, function(vResult) {
        var cachedVersion = vResult[UPDATE_VERSION];
        // Check if the cached version is newer than the current app version
        if (cachedVersion !== undefined && checkVersionUpdate(appInfo.version, cachedVersion)) {
          setTimeout(() => {
            // Show snackbar message with cached version to inform user to update the app
            snackbarLogLong('Version %1$s is now available! Check out the latest features & improvements.', cachedVersion);
            // Create and display the cached Update App button with tooltip and additional layout spacer
            updateAppButton(cachedVersion);
          }, 100);
        }
      });
    }
  });
}

// Show a confirmation with the Restore Defaults dialog before restoring the default settings
function restoreDefaultsDialog() {
  // Find the existing overlay and dialog elements
  var restoreDefaultsDialogOverlay = document.querySelector('#restoreDefaultsDialogOverlay');
  var restoreDefaultsDialog = document.querySelector('#restoreDefaultsDialog');

  // Show the dialog and push the view
  restoreDefaultsDialogOverlay.style.display = 'flex';
  restoreDefaultsDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.RestoreDefaultsDialog);

  // Cancel the operation if the Cancel button is pressed
  $('#cancelRestoreDefaults').off('click');
  $('#cancelRestoreDefaults').on('click', function() {
    console.log('%c[index.js, restoreDefaultsDialog]', 'color: green;', 'Closing app dialog and returning.');
    restoreDefaultsDialogOverlay.style.display = 'none';
    restoreDefaultsDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
  });

  // Restore all default settings if the Continue button is pressed
  $('#continueRestoreDefaults').off('click');
  $('#continueRestoreDefaults').on('click', function() {
    console.log('%c[index.js, restoreDefaultsDialog]', 'color: green;', 'Restoring default settings, closing app dialog, and returning.');
    // Reset any settings to their default state and save the updated values
    restoreDefaultsSettingsValues();
    // If the settings have been reset to default, show snackbar message
    snackbarLog('Settings have been restored to their default values.');
    restoreDefaultsDialogOverlay.style.display = 'none';
    restoreDefaultsDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
    // Show the required Restart Moonlight dialog and push the view
    setTimeout(() => requiredRestartAppDialog(), 2000);
  });
}

// Show the Warning dialog
function warningDialog(title, message) {
  // Find the existing overlay and dialog elements
  var warningDialogOverlay = document.querySelector('#warningDialogOverlay');
  var warningDialog = document.querySelector('#warningDialog');

  // Change the dialog title and text element with a custom warning message, without the optimal settings tiles
  document.getElementById('warningDialogTitle').innerHTML = t(title);
  document.getElementById('warningDialogText').innerHTML = t(message);
  warningDialog.classList.remove('is-optimal');

  // Show the dialog and push the view
  warningDialogOverlay.style.display = 'flex';
  warningDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.WarningDialog);

  // Ensure the continueWarning button is hidden for standard warnings
  $('#continueWarning').hide();
  // Add single-button class for CSS styling when only Close button is visible
  warningDialog.classList.add('single-button');

  // Cancel the operation if the Close button is pressed
  $('#closeWarning').off('click');
  $('#closeWarning').on('click', function() {
    console.log('%c[index.js, warningDialog]', 'color: green;', 'Closing app dialog and returning.');
    warningDialogOverlay.style.display = 'none';
    warningDialog.close();
    isDialogOpen = false;
    warningDialog.classList.remove('single-button');
    Navigation.pop();
    Navigation.switch();
  });
}

// Show a WoL warning dialog for randomized (locally administered) MAC addresses
function wakeOnLanWarningDialog(host) {
  var warningDialogOverlay = document.querySelector('#warningDialogOverlay');
  var warningDialog = document.querySelector('#warningDialog');

  // Set the title and message, without the value tiles of the optimal settings
  warningDialog.classList.remove('is-optimal');
  document.getElementById('warningDialogTitle').innerHTML = t('Wake-on-LAN Warning');
  document.getElementById('warningDialogText').innerHTML = t(
    'The MAC address of %1$s (%2$s) appears to be randomly generated.', escapeHTML(host.hostname), escapeHTML(host.macAddress)) + '<br><br>' +
    t('The Operating System may be using a random MAC address instead of the physical network card address.') + ' ' +
    t('Wake-on-LAN may be unable to wake up the machine since the MAC address does not match the one from the network card.');

  // Show the dialog and push the view
  warningDialogOverlay.style.display = 'flex';
  warningDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.WarningDialog);

  // Dynamically swap buttons: show "Continue" and change "Close" to act as Cancel
  $('#continueWarning').show();
  // Remove single-button class since both buttons are now visible
  warningDialog.classList.remove('single-button');

  // Cancel — close dialog without sending WoL (using Close button)
  $('#closeWarning').off('click');
  $('#closeWarning').on('click', function() {
    console.log('%c[index.js, wakeOnLanWarningDialog]', 'color: green;', 'Closing WoL warning dialog and returning.');
    warningDialogOverlay.style.display = 'none';
    warningDialog.close();
    isDialogOpen = false;
    // Restore the default state for future non-WoL warnings
    $('#continueWarning').hide();
    Navigation.pop();
    Navigation.switch();
  });

  // Continue — send WoL despite randomized MAC
  $('#continueWarning').off('click');
  $('#continueWarning').on('click', function() {
    console.log('%c[index.js, wakeOnLanWarningDialog]', 'color: green;', 'User accepted WoL warning. Sending WoL to ' + host.hostname);
    warningDialogOverlay.style.display = 'none';
    warningDialog.close();
    isDialogOpen = false;
    // Restore the default state for future non-WoL warnings
    $('#continueWarning').hide();
    Navigation.pop();
    Navigation.switch();
    // Proceed with sending the WoL packet
    setTimeout(() => autoWolDialog(host, function() {}, function() {}), 100);
  });
}

// Handle an abort of the WASM module or a crash of one of its threads (see common.js), which otherwise leaves the
// stream frozen without any message. The module can't be trusted afterwards, since a dead thread may still hold a
// lock, so nothing here calls into it: the stream view is torn down on the JS side only, and Moonlight restarts once
// the dialog is closed. Only the first failure is handled, because a crash can cascade into more.
var isNativeModuleFailed = false;
function onNativeModuleFailure(details) {
  if (isNativeModuleFailed) {
    return;
  }
  isNativeModuleFailed = true;
  console.error('%c[index.js, onNativeModuleFailure]', 'color: green;', 'Error: The streaming engine failed: ' + details);

  try {
    if (isInGame) {
      isInGame = false;
      wasmSessionStarted = false;
      streamLaunchId++;
      Rumble.stopAll();
      setTvScreenSaver(true);
      stopAudioScheduler();
      $('#connection-warnings, #performance-stats').css('display', 'none');
      $('#listener').removeClass('fullscreen');
      $('#loadingSpinner').css('display', 'none');
      $('body').css('backgroundColor', '');
      $('#wasm_module').css('display', 'none');
      // Let the remote and gamepads operate the dialog, which the stream view had paused
      Navigation.start();
      Controller.startWatching();
    }
  } catch (error) {
    console.error('%c[index.js, onNativeModuleFailure]', 'color: green;', 'Error: Failed to leave the stream view: ' + error);
  }

  warningDialog('Streaming engine error', 'A part of the streaming engine stopped unexpectedly. Moonlight will restart now; you can resume the game afterwards.');
  // Restart once the dialog is closed, after its own close handler
  $('#closeWarning').on('click', function() {
    restartApplication();
  });
}

// Restart the application
function restartApplication() {
  var restartApplication = window.location;
  restartApplication.reload(true);
}

// Show the Restart Moonlight dialog
function restartAppDialog() {
  // Find the existing overlay and dialog elements
  var restartAppDialogOverlay = document.querySelector('#restartAppDialogOverlay');
  var restartAppDialog = document.querySelector('#restartAppDialog');

  // Change the dialog text element to confirm whether the user wants to restart the application
  document.getElementById('restartAppDialogText').innerHTML = t('Are you sure you want to restart Moonlight?');

  // Show the dialog and push the view
  restartAppDialogOverlay.style.display = 'flex';
  restartAppDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.RestartMoonlightDialog);

  // Cancel the operation if the Cancel button is pressed
  $('#cancelRestartApp').off('click');
  $('#cancelRestartApp').on('click', function() {
    console.log('%c[index.js, restartAppDialog]', 'color: green;', 'Closing app dialog and returning.');
    restartAppDialogOverlay.style.display = 'none';
    restartAppDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
  });

  // Restart the application if the Restart button is pressed
  $('#continueRestartApp').off('click');
  $('#continueRestartApp').on('click', function() {
    console.log('%c[index.js, restartAppDialog]', 'color: green;', 'Closing app dialog, restarting application, and returning.');
    restartAppDialogOverlay.style.display = 'none';
    restartAppDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    restartApplication();
  });
}

// Show the required Restart Moonlight dialog
function requiredRestartAppDialog() {
  // Find the existing overlay and dialog elements
  var restartAppDialogOverlay = document.querySelector('#restartAppDialogOverlay');
  var restartAppDialog = document.querySelector('#restartAppDialog');

  // Change the dialog text element to inform the user that a restart is required
  document.getElementById('restartAppDialogText').innerHTML = t('In order for your changes to take effect, a restart of the application is required.<br><br>Would you like to proceed with the restart?');

  // Show the dialog and push the view
  restartAppDialogOverlay.style.display = 'flex';
  restartAppDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.RestartMoonlightDialog);

  // Cancel the operation if the Cancel button is pressed
  $('#cancelRestartApp').off('click');
  $('#cancelRestartApp').on('click', function() {
    console.log('%c[index.js, restartAppDialog]', 'color: green;', 'Closing app dialog and returning.');
    restartAppDialogOverlay.style.display = 'none';
    restartAppDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.switch();
  });

  // Restart the application if the Restart button is pressed
  $('#continueRestartApp').off('click');
  $('#continueRestartApp').on('click', function() {
    console.log('%c[index.js, restartAppDialog]', 'color: green;', 'Closing app dialog, restarting application, and returning.');
    restartAppDialogOverlay.style.display = 'none';
    restartAppDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    restartApplication();
  });
}

// Exit the application
function exitApplication() {
  var exitApplication = tizen.application.getCurrentApplication();
  exitApplication.exit();
}

// Show the Exit Moonlight dialog
function exitAppDialog() {
  // Find the existing overlay and dialog elements
  var exitAppOverlay = document.querySelector('#exitAppDialogOverlay');
  var exitAppDialog = document.querySelector('#exitAppDialog');

  // Show the dialog and push the view
  exitAppOverlay.style.display = 'flex';
  exitAppDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.ExitMoonlightDialog);

  // Cancel the operation if the Cancel button is pressed
  $('#cancelExitApp').off('click');
  $('#cancelExitApp').on('click', function() {
    console.log('%c[index.js, exitAppDialog]', 'color: green;', 'Closing app dialog and returning');
    exitAppOverlay.style.display = 'none';
    exitAppDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    Navigation.change(Views.Hosts);
  });

  // Exit the application if the Exit button is pressed
  $('#continueExitApp').off('click');
  $('#continueExitApp').on('click', function() {
    console.log('%c[index.js, exitAppDialog]', 'color: green;', 'Closing app dialog, exiting application, and returning to Smart Hub.');
    exitAppOverlay.style.display = 'none';
    exitAppDialog.close();
    isDialogOpen = false;
    Navigation.pop();
    exitApplication();
  });
}

// Puts the CSS style for current app on the app that's currently running
// and puts the CSS style for non-current app on the apps that aren't running
// this requires a hot-off-the-host `api`, and the appId we're going to stylize
// the function was made like this so that we can remove duplicated code, but
// not do N*N stylization of the box art, or make the code not flow very well
function stylizeBoxArts(freshApi, appsList) {
  // Check each app in the list and apply CSS styling based on whether it's currently running or not
  appsList.forEach(function(app) {
    var appBox = document.querySelector('#game-container-' + app.id);
    if (!appBox) {
      console.warn('%c[index.js, stylizeBoxArts]', 'color: green;', 'Warning: No box art found for appId: ' + app.id);
      return;
    }
    // If the game is currently running, then apply CSS stylization and the Running badge (menus.js)
    if (freshApi.currentGame === app.id) {
      setAppTileBadge(appBox, 'running', true);
      appBox.title = app.title + t(' (Running)');
    } else {
      setAppTileBadge(appBox, 'running', false);
      appBox.title = app.title;
    }
  });
}

// Sort the app titles
function sortTitles(list, sortOrder) {
  return list.sort((a, b) => {
    // Ascending order (A - Z)
    if (sortOrder === 'ASC') {
      return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
    }

    // Descending order (Z - A)
    if (sortOrder === 'DESC') {
      return b.title.localeCompare(a.title, undefined, { numeric: true, sensitivity: 'base' });
    }

    return 0;
  });
}

// Handle layout elements when displaying the Apps view
function showAppsMode() {
  if (typeof setUiView === 'function') {
    setUiView('apps');
  }
  console.log('%c[index.js, showAppsMode]', 'color: green;', 'Entering "Show Apps" mode.');
  // Make sure the screensaver works again in the menus, even if the stream ended in an unusual way
  setTvScreenSaver(true);
  $('#header-title').attr('data-i18n', 'Apps').html(t('Apps'));
  $('#header-logo').show();
  $('#main-header').show();
  $('#goBackBtn').show();
  $('#quitRunningAppBtn').show();
  // Tell how to open the menu of an app (menus.js)
  $('#appMenuHint').show();
  $('#main-content').children().not('#listener, #loadingSpinner, #wasmSpinner').show();
  $('#host-grid').hide();
  $('#settings-list').hide();
  $('.nav-menu-parent').hide();
  $('#updateAppBtn').hide();
  $('#rescanNetworkBtn').hide();
  $('#settingsBtn').hide();
  $('#supportBtn').hide();
  $('#restoreDefaultsBtn').hide();
  $('#connection-warnings').css('display', 'none');
  $('#performance-stats').css('display', 'none');
  $('#main-content').removeClass('fullscreen');
  $('#listener').removeClass('fullscreen');
  $('#loadingSpinner').css('display', 'none');
  $('body').css('backgroundColor', '');
  $('#wasm_module').css('display', 'none');

  isInGame = false;
  // We want to eventually poll on the app screen, but we can't now because
  // it slows down box art loading and we don't update the UI live anyway.
  stopPollingHosts();
  Navigation.start();
  // Resume the gamepad polling of the UI that was paused during the streaming session
  Controller.startWatching();
}

// Show the Apps grid
function showApps(host) {
  return new Promise((resolve, reject) => {
    // Safety checking should happen before attempting to show the app list
    if (!host || !host.paired) {
      console.error('%c[index.js, showApps]', 'color: green;', 'Error: Unable to initialize the host properly! Host object: ', host);
      reject('Unable to initialize the host properly');
      return;
    } else {
      console.log('%c[index.js, showApps]', 'color: green;', 'Current host object: \n', host, '\n' + host.toString()); // Logging both object (for console) and toString-ed object (for text logs)
    }

    // Stop navigation before showing the loading screen
    Navigation.stop();
    if (typeof window.abortSubnetScan === 'function') window.abortSubnetScan();

    // Hide the main header before showing a loading screen
    $('#main-header').children().hide();
    $('#main-header').css({'backgroundColor': 'transparent', 'boxShadow': 'none'});
    $('#host-grid, #settings-list').hide();

    // Show a spinner while the app list loads
    if (typeof setUiView === 'function') {
      setUiView('loading');
    }
    $('#wasmSpinner').css('display', 'inline-block');
    $('#wasmSpinnerLogo').hide();
    $('#wasmSpinnerMessage').text(t('Loading Apps...'));

    // Remove all game container elements from the game grid and from any other div elements
    $('#game-grid').empty();
    $('div.game-container').remove();

    setTimeout(() => {
      host.getAppList().then(function(appList) {
        // Hide the spinner after the host has successfully retrieved the app list
        $('#wasmSpinner').hide();

        // Show the main header after the loading screen is complete
        $('#main-header').children().show();
        $('#main-header').css({'backgroundColor': '', 'boxShadow': ''});

        // Show the game grid section
        $('#game-grid').show();

        if (appList.length == 0) {
          console.warn('%c[index.js, showApps]', 'Warning: Your app list is empty. Please add some apps to your list!');
          var emptyAppListImg = new Image();
          emptyAppListImg.src = 'static/res/applist_empty.svg';
          $('#game-grid').html(emptyAppListImg);
          snackbarLogLong('Your list is currently empty. Please add your favorite apps to the list.');
          // Navigate to the Apps view
          showAppsMode();
          resolve();
          return;
        }

        // Find the existing switch element
        const sortAppsListSwitch = document.getElementById('sortAppsListSwitch');
        // Defines the sort order based on the state of the switch
        const sortOrder = sortAppsListSwitch.checked ? 'DESC' : 'ASC';
        // If game grid is populated, sort the app list
        const sortedAppList = sortTitles(appList, sortOrder);

        if (_isSmartHubSupported) {
          var oldApps = (_previewApps[host.serverUid] && _previewApps[host.serverUid].apps) || [];

          _previewApps[host.serverUid] = {
            hostname: host.hostname,
            address: host.address,
            apps: sortedAppList.map(function(app) {
              var oldApp = oldApps.find(function(a) {
                return a.id === app.id;
              });
              var newApp = {
                id: app.id, title: app.title
              };
              if (oldApp) {
                if (oldApp.imageUri) {
                  newApp.imageUri = oldApp.imageUri;
                }
                if (oldApp.txtPath) {
                  newApp.txtPath = oldApp.txtPath;
                }
              }
              return newApp;
            })
          };
        }

        // Pause background polling during box art downloads to prevent
        // the polling /serverinfo request from being queued behind 40+
        // concurrent image downloads, which would cause a 5-second timeout
        // and trigger cancelRequest, killing all in-flight downloads.
        endBackgroundPollingOfHost(host);

        var boxArtPromises = [];
        
        // Reset preview promises for this showApps invocation
        window.previewPromises = [];

        // Leave out the apps that the user hid with the app menu, unless they show after 'Show hidden apps' (menus.js)
        var hiddenApps = loadHiddenApps(host.serverUid);
        var gridApps = selectGridApps(sortedAppList, hiddenApps, showHiddenAppsHost === host.serverUid, host.currentGame);
        appGridHiddenCount = sortedAppList.filter(function(app) {
          return isAppHidden(hiddenApps, app);
        }).length;

        gridApps.forEach(function(gridApp) {
          var app = gridApp.app;
          // Double clicking the button will cause multiple box arts to appear.
          // To mitigate this, we ensure that we don't add a duplicate box art.
          // This isn't perfect: there's lots of RTTs before the logic prevents anything.
          if ($('#game-container-' + app.id).length === 0) {
            // Create the game container with the appropriate attributes for the game card
            var gameContainer = $('<div>', {
              id: 'game-container-' + app.id,
              class: 'game-container mdl-card mdl-shadow--4dp',
              role: 'link',
              tabindex: 0,
              'aria-label': app.title,
              'data-app-id': app.id
            });
            // Dim a hidden app that shows after 'Show hidden apps'
            if (gridApp.hidden) {
              setAppTileBadge(gameContainer[0], 'hidden', true);
            }

            // Create the game cell to serve as a holder for the game box
            var gameCell = $('<div>', {
              id: 'game-' + app.id,
              class: 'mdl-card__title mdl-card--expand'
            });

            // Create the game title wrapper to hold the game title text
            var gameTitle = $('<div>', {
              class: 'game-title mdl-card__title-text'
            });

            // Create the game text placeholder that will contain the game name
            var gameText = $('<span>', {
              class: 'game-text',
              text: app.title
            });

            // Append the game text to the game title wrapper
            gameTitle.append(gameText);

            // Handle animation state based on game title text length
            if (app.title.length <= 20) {
              // For game title text of 20 characters or less, disable scrolling text animation
              gameText.addClass('disable-animation');
            } else {
              // For game title text longer than 20 characters, enable scrolling text animation
              gameText.removeClass('disable-animation');
            }

            // Append the game title to the game cell
            gameCell.append(gameTitle);

            // Append the game cell to the game container
            gameContainer.append(gameCell);

            // Attach the click event listener to the game container
            gameContainer.off('click');
            gameContainer.on('click', function() {
              // Prevent further clicks
              if (isClickPrevented) {
                return;
              }
              // Block subsequent clicks immediately
              isClickPrevented = true;
              // Start the game when the Click key is pressed
              startGame(host, app.id);
              // Reset the click flag after 2 second delay
              setTimeout(() => isClickPrevented = false, 2000);
            });

            // Append the game container to the game grid
            $('#game-grid').append(gameContainer);
          }
          // Load box art
          var boxArtPlaceholderImg = new Image();
          var appEntry = (_isSmartHubSupported && _previewApps[host.serverUid]) ? _previewApps[host.serverUid].apps.find(function(a) {
            return a.id === app.id; 
          }) : null;
          var boxArtPromise = new Promise(function(resolveBoxArt) {
            host.getBoxArt(app.id, _isSmartHubSupported).then(function(resolvedPromise) {
              boxArtPlaceholderImg.src = resolvedPromise;
              // The resolvedPromise is now the absolute file URI (or data URL if it failed to save).
              if (_isSmartHubSupported && _previewApps[host.serverUid] && appEntry) {
                // Resolve real TV IP because Smart Hub might block 127.0.0.1
                var tvIp = '127.0.0.1';
                try {
                  if (typeof webapis !== 'undefined' && webapis.network) {
                    tvIp = webapis.network.getIp();
                  }
                } catch(e) {
                  console.log('%c[index.js, showApps]', 'color: green;', 'Failed to get TV IP: ', e);
                }

                // Use deterministic filename so the local HTTP server route stays stable
                var filename = SMART_HUB_PREVIEW_FILE_PREFIX + app.id + '.jpg';
                var cacheBuster = '?v=' + Date.now();

                // Determine local path from resolvedPromise if it's a file URI
                if (resolvedPromise.startsWith('file://')) {
                  var localPngPath = resolvedPromise.replace('file://', '');
                  appEntry.txtPath = localPngPath;
                  appEntry.imageUri = 'http://' + tvIp + ':' + SMART_HUB_PREVIEW_PORT + '/' + filename + cacheBuster;
                  resolveBoxArt();
                } else {
                  try {
                    var documentsPath = tizen.filesystem.toURI('documents').replace('file://', '');
                    appEntry.txtPath = documentsPath + '/' + filename;
                    appEntry.imageUri = 'http://' + tvIp + ':' + SMART_HUB_PREVIEW_PORT + '/' + filename + cacheBuster;
                  } catch(err) {
                    appEntry.txtPath = '/opt/usr/home/owner/content/Documents/' + filename;
                    appEntry.imageUri = 'http://' + tvIp + ':' + SMART_HUB_PREVIEW_PORT + '/' + filename + cacheBuster;
                  }
                  resolveBoxArt();
                }

                // Early return to prevent the fallback synchronous resolveBoxArt from firing
                return;
              }
              resolveBoxArt();
            }, function(failedPromise) {
              console.error('%c[index.js, showApps]', 'color: green;', 'Error: Failed to retrieve box art for app ID: ' + app.id + '. Returned value was: ' + failedPromise + '. Host object: ', host, '\n' + host.toString()); // Logging both object (for console) and toString-ed object (for text logs)
              boxArtPlaceholderImg.src = 'static/res/placeholder_error.svg';
              resolveBoxArt();
            });
          });

          boxArtPlaceholderImg.onload = e => boxArtPlaceholderImg.classList.add('fade-in');
          $(gameContainer).append(boxArtPlaceholderImg);
          boxArtPromises.push(boxArtPromise);
        });

        // Check all game containers for the current running app and apply CSS styling accordingly
        stylizeBoxArts(host, gridApps.map(function(gridApp) {
          return gridApp.app;
        }));

        var settledPromises = boxArtPromises.map(function(p) {
          return p.catch(function(e) {
            console.error('%c[index.js, showApps]', 'color: green;', 'Error: Box art promise rejected with error: ', e);
            return e;
          });
        });

        var appToSelect = (host.currentGame != 0) ? host.currentGame : localStorage.getItem('lastOpenedApp_' + host.serverUid);
        if (appToSelect && window.Views && Views.Apps && Views.Apps.view) {
          var children = Views.Apps.view.func();
          for (var i = 0; i < children.length; i++) {
            if (children[i].id === 'game-container-' + appToSelect) {
              Views.Apps.view.index = i;
              break;
            }
          }
        }
        // Keep the selection on a tile, e.g. when the app that was selected is hidden now
        if (window.Views && Views.Apps && Views.Apps.view && Views.Apps.view.index >= Views.Apps.view.func().length) {
          Views.Apps.view.index = Math.max(0, Views.Apps.view.func().length - 1);
        }

        // Navigate to the Apps view
        showAppsMode();
        resolve();

        Promise.all(settledPromises).then(function() {
          // Resume background polling now that all box art downloads are complete
          beginBackgroundPollingOfHost(host);

          // Wait for all Smart Hub Preview JPEGs to finish encoding and saving to disk
          // before sending the updated data to the background service.
          var previewsDone = window.previewPromises || [];
          Promise.all(previewsDone).then(function() {
            savePreviewApps();
            updatePreviewData();
          });
        });
      }, function(failedAppList) {
        // Hide the spinner if the host has failed to retrieve the app list
        $('#wasmSpinner').hide();

        // Show the main header after the loading screen is complete
        $('#main-header').children().show();
        $('#main-header').css({'backgroundColor': '', 'boxShadow': ''});

        console.error('%c[index.js, showApps]', 'color: green;', 'Error: Failed to get app list from ' + host.hostname + '. Host object: ', host, '\n' + host.toString()); // Logging both object (for console) and toString-ed object (for text logs)
        var errorAppListImg = new Image();
        errorAppListImg.src = 'static/res/applist_error.svg';
        $('#game-grid').html(errorAppListImg);
        snackbarLogLong('Unable to retrieve your list of apps at this time. Please refresh the list of apps or try again later!');

        // Navigate to the Apps view
        showAppsMode();
        reject(failedAppList);
      });
    }, 500);
  });
}

// Show a confirmation with the Quit App dialog before stopping the running app
function quitAppDialog() {
  if (api.currentGame === 0) {
    // If no app is running, show snackbar message
    snackbarLog('No app is currently running.');
    return;
  } else {
    api.getAppById(api.currentGame).then(function(currentGame) {
      // Find the existing overlay and dialog elements
      var quitAppOverlay = document.querySelector('#quitAppDialogOverlay');
      var quitAppDialog = document.querySelector('#quitAppDialog');

      // Change the dialog text element to include the game title
      document.getElementById('quitAppDialogText').innerHTML = t('Are you sure you want to quit %1$s? All unsaved data will be lost.', escapeHTML(currentGame.title));
      
      // Show the dialog and push the view
      quitAppOverlay.style.display = 'flex';
      quitAppDialog.showModal();
      isDialogOpen = true;
      Navigation.push(Views.QuitAppDialog);

      // Cancel the operation if the Cancel button is pressed
      $('#cancelQuitApp').off('click');
      $('#cancelQuitApp').on('click', function() {
        console.log('%c[index.js, quitAppDialog]', 'color: green;', 'Closing app dialog and returning.');
        quitAppOverlay.style.display = 'none';
        quitAppDialog.close();
        isDialogOpen = false;
        Navigation.pop();
        Navigation.switch();
      });

      // Quit the running app if the Continue button is pressed
      $('#continueQuitApp').off('click');
      $('#continueQuitApp').on('click', function() {
        console.log('%c[index.js, quitAppDialog]', 'color: green;', 'Quitting game, closing app dialog, and returning.');
        quitAppOverlay.style.display = 'none';
        quitAppDialog.close();
        isDialogOpen = false;
        Navigation.pop();
        stopGame(api, function() {
          // After stopping the game, set focus back to the 'Quit Running App' button
          setTimeout(() => Navigation.switch(), 3000);
        });
      });
    });
  }
}

// Handle layout elements when displaying the Stream view
function showStreamMode() {
  if (typeof setUiView === 'function') {
    setUiView('stream');
  }
  console.log('%c[index.js, showStreamMode]', 'color: green;', 'Entering "Show Stream" mode.');
  $('#main-header').hide();
  $('#main-content').children().not('#listener, #loadingSpinner').hide();
  $('#main-content').addClass('fullscreen');
  $('#listener').addClass('fullscreen');
  $('#loadingSpinner').css('display', 'inline-block');

  isInGame = true;
  fullscreenWasmModule();
  handleOnScreenOverlays();
  Navigation.stop();
  // The Wasm module polls the gamepads on its own input thread while streaming, so pause the
  // UI polling to keep the main thread free for the audio scheduler and the video player
  Controller.stopWatching();
  // Cancel a held D-Pad or stick repeat, since its release can no longer be detected, and forget the stick directions,
  // since the menus take a fresh snapshot of the gamepads when they resume
  stopRepeatAction();
  gamepadAxisDirections = {};
}

// Maximize the size of the Wasm module by scaling and resizing appropriately
function fullscreenWasmModule() {
  var streamWidth = $('#selectResolution').data('value').split(':')[0];
  var streamHeight = $('#selectResolution').data('value').split(':')[1];
  var screenWidth = window.innerWidth;
  var screenHeight = window.innerHeight;

  var xRatio = screenWidth / streamWidth;
  var yRatio = screenHeight / streamHeight;

  var zoom = Math.min(xRatio, yRatio);

  var module = $('#wasm_module')[0];
  module.width = zoom * streamWidth;
  module.height = zoom * streamHeight;
  module.style.marginTop = ((screenHeight - module.height) / 2) + 'px';
}

// Handle on-screen overlays when the streaming session starts
function handleOnScreenOverlays() {
  // Find the existing toggle switch elements
  const disableWarningsSwitch = document.getElementById('disableWarningsSwitch');
  const performanceStatsSwitch = document.getElementById('performanceStatsSwitch');

  // Check if the disable warnings switch is checked, then hide or show the connection warning messages
  disableWarningsSwitch.checked ? $('#connection-warnings').css('display', 'none') : $('#connection-warnings').css('display', 'inline-block');

  // Check if the performance stats switch is checked, then show or hide the performance statistics information
  performanceStatsSwitch.checked ? $('#performance-stats').css('display', 'inline-block') : $('#performance-stats').css('display', 'none');
}

// Start the given appID. If another app is running, offer to quit it. Otherwise, if the given app is already running, just resume it.
function startGame(host, appID) {
  if (!host || !host.paired) {
    console.error('%c[index.js, startGame]', 'color: green;', 'Error: Attempted to start a game, but the host was not initialized properly! Host object: ', host);
    return;
  }
  // Don't start a stream while the app is in the background (e.g. the delayed start after quitting another app, or a
  // deep link that arrives while hidden), see the visibilitychange listener
  if (document.visibilityState === 'hidden') {
    console.warn('%c[index.js, startGame]', 'color: green;', 'Warning: Not starting app ' + appID + ' while Moonlight is in the background.');
    return;
  }
  // Ignore a second start (e.g. from a Smart Hub deep link) while a stream is starting or running
  if (isInGame) {
    console.warn('%c[index.js, startGame]', 'color: green;', 'Warning: Ignoring the start of app ' + appID + ' while a stream is active.');
    return;
  }
  localStorage.setItem('lastOpenedApp_' + host.serverUid, appID);

  // Number this launch, so that the replies of the host are ignored once the launch was cancelled or a newer one
  // started (see cancelStreamLaunch)
  var launchId = ++streamLaunchId;
  streamLaunchHost = host;
  streamLaunchAppTitle = '';
  wasmSessionStarted = false;
  isStreamConnected = false;
  // The Stream Menu state of an earlier stream doesn't belong to this one (menus.js)
  streamMouseEmulationActive = false;
  quitAppAfterStream = false;
  isStreamVideoTrackClosed = false;
  streamVideoTrackCloseReason = -1;
  streamHiddenCount = 0;
  streamVideoTrackCloseCount = 0;

  // Start the audio scheduler of the Web Audio backend while we are still running inside the
  // handler of the key press that started the stream, because the audio context of a device
  // with an autoplay policy can only be created from a user gesture
  if (isWebAudioBackendSelected()) {
    // Publish the clock sync setting to the audio scheduler in platform/audio.js
    window._mlAudioClockSync = $('#audioClockSyncSwitch').parent().hasClass('is-checked');
    startAudioScheduler();
  }

  // Refresh the server info, because the user might have quit the game
  host.refreshServerInfo().then(function(ret) {
    host.getAppById(appID).then(function(appToStart) {
      if (launchId !== streamLaunchId) {
        return;
      }
      if (host.currentGame != 0 && host.currentGame != appID) {
        host.getAppById(host.currentGame).then(function(currentApp) {
          // Find the existing overlay and dialog elements
          var quitAppOverlay = document.querySelector('#quitAppDialogOverlay');
          var quitAppDialog = document.querySelector('#quitAppDialog');

          // Change the dialog text element to include the game title
          document.getElementById('quitAppDialogText').innerHTML = t('%1$s is already running. Would you like to quit it and start %2$s?', escapeHTML(currentApp.title), escapeHTML(appToStart.title));

          // Show the dialog and push the view
          quitAppOverlay.style.display = 'flex';
          quitAppDialog.showModal();
          isDialogOpen = true;
          Navigation.push(Views.QuitAppDialog);

          // Cancel the operation if the Cancel button is pressed
          $('#cancelQuitApp').off('click');
          $('#cancelQuitApp').on('click', function() {
            console.log('%c[index.js, startGame]', 'color: green;', 'Closing app dialog and returning.');
            quitAppOverlay.style.display = 'none';
            quitAppDialog.close();
            isDialogOpen = false;
            Navigation.pop();
          });

          // Quit the running app if the Continue button is pressed
          $('#continueQuitApp').off('click');
          $('#continueQuitApp').on('click', function() {
            console.log('%c[index.js, startGame]', 'color: green;', 'Quitting game, closing app dialog, and returning.');
            stopGame(host, function(quitSucceeded) {
              setTimeout(() => {
                // Scroll to the current game row
                Navigation.switch();
                // Switch to Apps view
                Navigation.change(Views.Apps);
              }, 1500);
              // Start the new app only once the host quit the running one, which would otherwise ask again
              if (quitSucceeded) {
                // Please, don't infinite loop with recursion
                setTimeout(() => startGame(host, appID), 3000);
              }
            });
            quitAppOverlay.style.display = 'none';
            quitAppDialog.close();
            isDialogOpen = false;
            Navigation.pop();
          });

          return;
        }, function(failedCurrentApp) {
          console.error('%c[index.js, startGame]', 'color: green;', 'Error: Failed to get the current running app from ' + host.hostname + '\n Returned error was: ' + failedCurrentApp + '!', '\n Host object: ' + '\n', host, '\n' + host.toString()); // Logging both object (for console) and toString-ed object (for text logs)
          return;
        });
        return;
      }

      // Retrieve all stream configuration options from the Settings view
      var streamWidth = $('#selectResolution').data('value').split(':')[0];
      var streamHeight = $('#selectResolution').data('value').split(':')[1];
      var frameRate = $('#selectFramerate').data('value').toString();
      var bitrate = parseFloat($('#bitrateSlider').val()) * 1000;
      var rikey = generateRemoteInputKey();
      var rikeyid = generateRemoteInputKeyId();
      var gamepadMask = getConnectedGamepadMask();
      const framePacing = $('#framePacingSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const optimizeGames = $('#optimizeGamesSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const rumbleFeedback = $('#rumbleFeedbackSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const mouseEmulation = $('#mouseEmulationSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const flipABfaceButtons = $('#flipABfaceButtonsSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const flipXYfaceButtons = $('#flipXYfaceButtonsSwitch').parent().hasClass('is-checked') ? 1 : 0;
      var controllerType = $('#selectControllerType').data('value').toString();
      var audioBackend = $('#selectAudioBackend').data('value').toString();
      var audioConfig = $('#selectAudio').data('value').toString();
      const audioSync = $('#audioSyncSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const audioJitter = parseInt($('#jitterSlider').val());
      const playHostAudio = $('#playHostAudioSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const decryptHostAudio = $('#decryptHostAudioSwitch').parent().hasClass('is-checked') ? 1 : 0;
      var videoCodec = $('#selectCodec').data('value').toString();
      const hdrMode = $('#hdrModeSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const fullRange = $('#fullRangeSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const gameMode = $('#gameModeSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const disableWarnings = $('#disableWarningsSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const performanceStats = $('#performanceStatsSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const refFrameInvalidation = $('#refFrameInvalidationSwitch').parent().hasClass('is-checked') ? 1 : 0;
      const hdrMetadata = $('#hdrMetadataSwitch').parent().hasClass('is-checked') ? 1 : 0;

      // Update the network connection summary for the performance statistics
      updateStreamNetworkInfo();

      console.log('%c[index.js, startGame]', 'color: green;', 'startRequest:' + 
      '\n Host address: ' + host.address + ':' + host.httpPort + 
      '\n Video resolution: ' + streamWidth + 'x' + streamHeight + 
      '\n Video frame rate: ' + frameRate + ' FPS' + 
      '\n Video bitrate: ' + bitrate + ' Kbps' + 
      '\n Video frame pacing: ' + framePacing + 
      '\n Optimize game settings: ' + optimizeGames + 
      '\n Rumble feedback: ' + rumbleFeedback + 
      '\n Mouse emulation: ' + mouseEmulation + 
      '\n Flip A/B face buttons: ' + flipABfaceButtons + 
      '\n Flip X/Y face buttons: ' + flipXYfaceButtons + 
      '\n Audio backend: ' + audioBackend + 
      '\n Audio configuration: ' + audioConfig + 
      '\n Audio synchronization: ' + audioSync + 
      '\n Audio jitter buffer: ' + audioJitter + ' ms' +
      '\n Play host audio: ' + playHostAudio + 
      '\n Decrypt host audio: ' + decryptHostAudio + 
      '\n Video codec: ' + videoCodec + 
      '\n Video HDR mode: ' + hdrMode + 
      '\n Full color range: ' + fullRange + 
      '\n Game Mode: ' + gameMode + 
      '\n Disable connection warnings: ' + disableWarnings + 
      '\n Performance statistics: ' + performanceStats + 
      '\n Reference frame invalidation: ' + refFrameInvalidation +
      '\n HDR static metadata: ' + hdrMetadata +
      '\n Controller type sent to the PC: ' + controllerType);

      // Hide on-screen overlays until the streaming session begins
      $('#connection-warnings, #performance-stats').css('background', 'transparent').text('');

      // Shows a loading message to launch the application and start stream mode
      $('#loadingSpinnerMessage').text(t('Starting %1$s...', appToStart.title));
      streamLaunchAppTitle = appToStart.title;
      // Show the app and its box art on the launch screen (launcher.js)
      if (typeof Launcher !== 'undefined') {
        Launcher.prepareStart(host, appID, appToStart.title);
      }
      showStreamMode();

      // Check if user wants to resume the already-running app
      if (host.currentGame == appID) {
        // If the app is already running, we can just resume it
        return host.resumeApp(
          streamWidth + 'x' + streamHeight + 'x' + frameRate, // Resolution and frame rate
          optimizeGames, // Optimize game settings (SOPS)
          rikey, rikeyid, // Remote input key and key ID
          hdrMode, // Auto HDR video streaming
          playHostAudio, // Play audio on host and client device
          0x030002, // Surround channel mask << 16 | Surround channel count
          gamepadMask // Connect gamepad mask
        ).then(function(launchResult) {
          if (launchId !== streamLaunchId) {
            console.log('%c[index.js, startGame]', 'color: green;', 'Ignoring the reply to a cancelled resume request.');
            return;
          }
          $xml = $($.parseXML(launchResult.toString()));
          $root = $xml.find('root');
          var status_code = $root.attr('status_code');
          var status_message = $root.attr('status_message');
          if (status_code != 200) {
            $('#loadingSpinnerMessage').text('');
            snackbarLogLong('Error %1$s: %2$s', status_code, status_message);
            showApps(host).then(() => {
              // Scroll to the current game row
              Navigation.switch();
              // Switch to Apps view
              Navigation.change(Views.Apps);
            });
            return;
          }
          // Read the session URL now, because refreshing the server info replaces the global $root
          var sessionUrl = $root.find('sessionUrl0').text().trim();
          // Start stream request with the codec modes from the encoder probe of this resume request
          refreshCodecModesBeforeStream(host).then(function(codecModes) {
            if (launchId !== streamLaunchId) {
              console.log('%c[index.js, startGame]', 'color: green;', 'Not starting the stream of a cancelled resume request.');
              return;
            }
            wasmSessionStarted = true;
            // A video format that the TV rejected and the ports named for the termination of an earlier stream don't
            // belong to this one (messages.js)
            terminationBlockedPorts = '';
            rejectedVideoTrack = null;
            sendMessage('startRequest', [
              host.address, host.httpPort, streamWidth, streamHeight, frameRate, bitrate.toString(), rikey, rikeyid.toString(),
              host.appVersion, host.gfeVersion, sessionUrl, codecModes,
              framePacing, optimizeGames, rumbleFeedback, mouseEmulation, flipABfaceButtons, flipXYfaceButtons,
              audioBackend, audioConfig, audioSync, audioJitter, playHostAudio, decryptHostAudio, videoCodec, hdrMode, fullRange,
              gameMode, disableWarnings, performanceStats, refFrameInvalidation, hdrMetadata, controllerType
            ]);
          });
        }, function(failedResumeApp) {
          if (launchId !== streamLaunchId) {
            return;
          }
          console.error('%c[index.js, startGame]', 'color: green;', 'Error: Failed to resume app with id: ' + appID + '\n Returned error was: ' + failedResumeApp + '!');
          snackbarLog('Failed to resume %1$s', appToStart.title);
          showApps(host).then(() => {
            // Scroll to the current game row
            Navigation.switch();
            // Switch to Apps view
            Navigation.change(Views.Apps);
          });
          return;
        });
      }

      // If the user wants to launch the app, then we start launching it
      host.launchApp(
        appID, // App ID
        streamWidth + 'x' + streamHeight + 'x' + frameRate, // Resolution and frame rate
        optimizeGames, // Optimize game settings (SOPS)
        rikey, rikeyid, // Remote input key and key ID
        hdrMode, // Auto HDR video streaming
        playHostAudio, // Play audio on host and client device
        0x030002, // Surround channel mask << 16 | Surround channel count
        gamepadMask // Connect gamepad mask
      ).then(function(launchResult) {
        if (launchId !== streamLaunchId) {
          console.log('%c[index.js, startGame]', 'color: green;', 'Ignoring the reply to a cancelled launch request.');
          return;
        }
        $xml = $($.parseXML(launchResult.toString()));
        $root = $xml.find('root');
        var status_code = $root.attr('status_code');
        var status_message = $root.attr('status_message');
        if (status_code != 200) {
          if (status_code == 4294967295 && status_message == 'Invalid') {
            // Special case handling an audio capture error which GFE doesn't provide any useful status message
            status_code = 418;
            status_message = t('Audio capture device is missing. Please reinstall the audio drivers.');
          }
          $('#loadingSpinnerMessage').text('');
          snackbarLogLong('Error %1$s: %2$s', status_code, status_message);
          showApps(host).then(() => {
            // Scroll to the current game row
            Navigation.switch();
            // Switch to Apps view
            Navigation.change(Views.Apps);
          });
          return;
        }
        // Read the session URL now, because refreshing the server info replaces the global $root
        var sessionUrl = $root.find('sessionUrl0').text().trim();
        // Start stream request with the codec modes from the encoder probe of this launch request
        refreshCodecModesBeforeStream(host).then(function(codecModes) {
          if (launchId !== streamLaunchId) {
            console.log('%c[index.js, startGame]', 'color: green;', 'Not starting the stream of a cancelled launch request.');
            return;
          }
          wasmSessionStarted = true;
          // A video format that the TV rejected and the ports named for the termination of an earlier stream don't
          // belong to this one (messages.js)
          terminationBlockedPorts = '';
          rejectedVideoTrack = null;
          sendMessage('startRequest', [
            host.address, host.httpPort, streamWidth, streamHeight, frameRate, bitrate.toString(), rikey, rikeyid.toString(),
            host.appVersion, host.gfeVersion, sessionUrl, codecModes,
            framePacing, optimizeGames, rumbleFeedback, mouseEmulation, flipABfaceButtons, flipXYfaceButtons,
            audioBackend, audioConfig, audioSync, audioJitter, playHostAudio, decryptHostAudio, videoCodec, hdrMode, fullRange,
            gameMode, disableWarnings, performanceStats, refFrameInvalidation, hdrMetadata, controllerType
          ]);
        });
      }, function(failedLaunchApp) {
        if (launchId !== streamLaunchId) {
          return;
        }
        console.error('%c[index.js, startGame]', 'color: green;', 'Error: Failed to launch app with id: ' + appID + '\n Returned error was: ' + failedLaunchApp + '!');
        snackbarLog('Failed to launch %1$s', appToStart.title);
        showApps(host).then(() => {
          // Scroll to the current game row
          Navigation.switch();
          // Switch to Apps view
          Navigation.change(Views.Apps);
        });
        return;
      });
    });
  }, function(failedRefreshInfo) {
    console.error('%c[index.js, startGame]', 'color: green;', 'Error: Failed to refresh server info! Returned error was: ' + failedRefreshInfo + ' and failed server was: ' + '\n', host, '\n' + host.toString()); // Logging both object (for console) and toString-ed object (for text logs)
  });
}

// Cancel a stream that is still starting, i.e. whose start request hasn't reached the WASM module yet, and return to
// the app list. The launch or resume request that is in flight can't be aborted: the host may still start the app,
// which the app list then shows as running, and the reply is ignored (see startGame).
function cancelStreamLaunch() {
  console.log('%c[index.js, cancelStreamLaunch]', 'color: green;', 'Cancelling the start of the stream.');
  streamLaunchId++;
  isInGame = false;
  wasmSessionStarted = false;
  leaveStreamView(streamLaunchHost || api);
}

// Read the codec modes of the host again once it accepted the launch or resume request. Sunshine probes its encoders
// while it handles that request, so the modes from the earlier server info can be stale, e.g. when no display was
// attached at the earlier probe and the host reported no 10-bit modes. The refresh is bounded, so that a slow host
// can't hold up the stream start, and the earlier modes are used if it fails or takes too long.
function refreshCodecModesBeforeStream(host) {
  var previousModes = host.serverCodecModeSupport;
  var timeout = new Promise(function(resolve) {
    setTimeout(function() { resolve(false); }, CODEC_MODES_REFRESH_TIMEOUT_MS);
  });
  var refresh = host.refreshServerInfo().then(function() {
    return true;
  }, function(failedRefreshInfo) {
    console.warn('%c[index.js, refreshCodecModesBeforeStream]', 'color: green;', 'Warning: Failed to refresh the server info before the stream! Returned error was: ' + failedRefreshInfo);
    return false;
  });
  return Promise.race([refresh, timeout]).then(function(refreshed) {
    if (!refreshed) {
      console.warn('%c[index.js, refreshCodecModesBeforeStream]', 'color: green;', 'Warning: Using the earlier codec modes of the host: ' + previousModes);
      return previousModes;
    }
    console.log('%c[index.js, refreshCodecModesBeforeStream]', 'color: green;', 'Codec modes of the host for this stream: ' + host.serverCodecModeSupport);
    return host.serverCodecModeSupport;
  });
}

// Stop the running app title, refresh the server info, and then return to Apps grid. The callback gets whether the
// host quit the app
function stopGame(host, callbackFunction) {
  isInGame = false;

  if (!host.paired) {
    return;
  }

  // Show the app list once the quit is over, also when it couldn't start (the quit after a stream that the Stream Menu
  // ended waits for it on the loading screen), and pass to the callback whether the app is quit
  var showAppsAfterQuit = function(quitSucceeded) {
    showApps(host).finally(() => {
      if (typeof(callbackFunction) === "function") callbackFunction(quitSucceeded);
    });
  };

  host.refreshServerInfo().then(function(ret) {
    host.getAppById(host.currentGame).then(function(runningApp) {
      if (!runningApp) {
        snackbarLog('No app is currently running.');
        showAppsAfterQuit(true);
        return;
      }
      var appTitle = runningApp.title;
      snackbarLog('Quitting %1$s...', appTitle);
      // quitApp() refreshes the server info once the host answered and fails while the host still runs the app
      host.quitApp().then(function(ret2) {
        snackbarLog('Successfully quit %1$s', appTitle);
        // Refresh to show no app is currently running
        showAppsAfterQuit(true);
      }, function(failedQuitApp) {
        console.error('%c[index.js, stopGame]', 'color: green;', 'Error: Failed to quit app! Returned error was: ' + failedQuitApp + '!');
        if (failedQuitApp === QUIT_APP_STILL_RUNNING_ERROR) {
          snackbarLogLong('%1$s is still running on %2$s, probably because another device started it. Quit it on that device or on the PC.', appTitle, host.hostname);
        } else {
          snackbarLogLong('Unable to quit %1$s. Check the connection to %2$s and try again.', appTitle, host.hostname);
        }
        // Refresh to show the app that still runs
        showAppsAfterQuit(false);
      });
    }, function(failedGetApp) {
      console.error('%c[index.js, stopGame]', 'color: green;', 'Error: Failed to get app ID! Returned error was: ' + failedGetApp + '!');
      snackbarLogLong('Unable to quit the app. Check the connection to %1$s and try again.', host.hostname);
      showAppsAfterQuit(false);
    });
  }, function(failedRefreshInfo) {
    console.error('%c[index.js, stopGame]', 'color: green;', 'Error: Failed to refresh server info! Returned error was: ' + failedRefreshInfo + '!');
    snackbarLogLong('Unable to quit the app. Check the connection to %1$s and try again.', host.hostname);
    showAppsAfterQuit(false);
  });
}

// Send the Escape key using the keyboard event to the host
function sendEscapeKeyToHost() {
  Module.sendKeyboardEvent(0x80 << 8 | 0x1B, 0x03, 0); // Key down
  Module.sendKeyboardEvent(0x80 << 8 | 0x1B, 0x04, 0); // Key up
}

let indexedDB = null;
const dbVersion = 1.0;
let db = null;
const dbName = 'GameStreamingDB';
const storeName = 'GameStreamingStore';

// Based on example from https://hacks.mozilla.org/2012/02/storing-images-and-files-in-indexeddb/
function createObjectStore(dataBase) {
  if (!dataBase.objectStoreNames.contains(storeName)) {
    dataBase.createObjectStore(storeName);
  }
}

function openIndexDB(callback) {
  if (db) {
    // Database already opened
    callback();
    return;
  }

  console.log('%c[index.js, openIndexDB]', 'color: green;', 'Opening IndexedDB...');
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then(persistent => {
      if (persistent) {
        console.log('%c[index.js, openIndexDB]', 'color: green;', 'Storage will not be cleared except by explicit user action.');
      } else {
        console.log('%c[index.js, openIndexDB]', 'color: green;', 'Storage may be cleared by the UA under storage pressure.');
      }
    });
  } else {
    console.warn('%c[index.js, openIndexDB]', 'color: green;', 'Warning: Persistent storage is not available!');
  }

  if (!indexedDB) {
    indexedDB = self.indexedDB || self.webkitIndexedDB || self.mozIndexedDB || self.OIndexedDB || self.msIndexedDB;
  }

  // Create/open database
  const request = indexedDB.open(dbName, dbVersion);

  request.onerror = function(e) {
    console.error('%c[index.js, openIndexDB]', 'color: green;', 'Error: Cannot create or access the IndexedDB database: ', e);
  };

  request.onsuccess = function(e) {
    console.log('%c[index.js, openIndexDB]', 'color: green;', 'Successfully created or accessed the IndexedDB database: ', e);
    db = request.result;

    db.onerror = function(e) {
      console.error('%c[index.js, openIndexDB]', 'color: green;', 'Error: Failed to create or access the IndexedDB database: ', e);
    };

    // Interim solution to create an objectStore
    if (db.setVersion && db.version != dbVersion) {
      const setVersion = db.setVersion(dbVersion);
      setVersion.onsuccess = function() {
        createObjectStore(db);
        callback();
      };
    } else {
      callback();
    }
  };

  request.onupgradeneeded = function(e) {
    createObjectStore(e.target.result);
  };
}

function callCb(key, value, callbackFunction, isReadFailed) {
  let obj = {};
  obj[key] = value;
  callbackFunction(obj, isReadFailed);
}

// Read the data at the key and pass it to the callback function as an object with the key, e.g. { bitrate: '80' }, with
// null for a key that isn't stored. A key that can't be read is passed as null too, with true as the second argument of
// the callback function, so that a caller which stores something in place of a missing value can leave the stored
// value as it is instead.
function getData(key, callbackFunction) {
  let isFinished = false;
  // Call the callback function only once, since a failed transaction reports both an error and an abort, and an
  // exception thrown by the callback function in the success handler also aborts the transaction
  const finish = function(value, isReadFailed) {
    if (!isFinished) {
      isFinished = true;
      callCb(key, value, callbackFunction, isReadFailed);
    }
  };
  let cb = function() {
    try {
      // Open a transaction to the database
      const transaction = db.transaction(storeName, 'readonly');
      const readRequest = transaction.objectStore(storeName).get(key);

      // Retrieve the data that was stored
      readRequest.onsuccess = function(e) {
        console.log('%c[index.js, getData]', 'color: green;', 'Reading data from DB key: ' + key + ' with value: ' + readRequest.result);
        let value = null;
        if (readRequest.result) {
          try {
            value = JSON.parse(readRequest.result);
          } catch (err) {
            console.error('%c[index.js, getData]', 'color: green;', 'Error: Unable to parse the data at the key: ' + key + ' from IndexedDB: ' + err);
            finish(null, true);
            return;
          }
        }
        finish(value, false);
      };

      transaction.onerror = function(e) {
        console.error('%c[index.js, getData]', 'color: green;', 'Error: Unable to read data at the key: ' + key + ' from IndexedDB: ' + e);
        finish(null, true);
      };

      transaction.onabort = function(e) {
        console.error('%c[index.js, getData]', 'color: green;', 'Error: Reading data at the key: ' + key + ' from IndexedDB was aborted: ' + e);
        finish(null, true);
      };
    } catch (err) {
      console.error('%c[index.js, getData]', 'color: green;', 'Error: Something went wrong while reading data at the key: ' + key + ' from IndexedDB: ' + err);
      // Call back asynchronously like IndexedDB does, since the callers expect it: e.g. the settings start to load during
      // the window load event, before the switches of the settings screen are set up
      setTimeout(function() {
        finish(null, true);
      }, 0);
    }
  };

  if (db) {
    cb();
  } else {
    openIndexDB(cb);
  }
}

function storeData(key, data, callbackFunction) {
  let cb = function() {
    try {
      // Open a transaction to the database
      const transaction = db.transaction(storeName, 'readwrite');
      // Put the text into the database
      const put = transaction.objectStore(storeName).put(JSON.stringify(data), key);

      transaction.oncomplete = function(e) {
        console.log('%c[index.js, storeData]', 'color: green;', 'Storing data at key: ' + key + ' with data: ' + JSON.stringify(data));
        if (callbackFunction) {
          callbackFunction();
        }
      };

      transaction.onerror = function(e) {
        console.error('%c[index.js, storeData]', 'color: green;', 'Error: Unable to store data in IndexedDB: ' + e);
      };
    } catch (err) {
      console.error('%c[index.js, storeData]', 'color: green;', 'Error: Something went wrong while storing data at the key: ' + key + ' from IndexedDB: ' + err);
    }
  };

  if (db) {
    cb();
  } else {
    openIndexDB(cb);
  }
}

// Remove the data at the key, so that the setting gets its default again, like a setting that was never stored
function removeData(key, callbackFunction) {
  let cb = function() {
    try {
      // Open a transaction to the database
      const transaction = db.transaction(storeName, 'readwrite');
      // Delete the key from the database (nothing happens if it isn't stored)
      transaction.objectStore(storeName).delete(key);

      transaction.oncomplete = function(e) {
        console.log('%c[index.js, removeData]', 'color: green;', 'Removed data at key: ' + key);
        if (callbackFunction) {
          callbackFunction();
        }
      };

      transaction.onerror = function(e) {
        console.error('%c[index.js, removeData]', 'color: green;', 'Error: Unable to remove data from IndexedDB: ' + e);
      };
    } catch (err) {
      console.error('%c[index.js, removeData]', 'color: green;', 'Error: Something went wrong while removing data at the key: ' + key + ' from IndexedDB: ' + err);
    }
  };

  if (db) {
    cb();
  } else {
    openIndexDB(cb);
  }
}

// Read several keys in one transaction, so that their values are consistent with each other, and pass them to the
// callback function as an object with null for every key that isn't stored, or null if they can't be read
function getMultipleData(keys, callbackFunction) {
  let isFinished = false;
  // Call the callback function only once, since a failed transaction reports both an error and an abort
  const finish = function(values) {
    if (!isFinished) {
      isFinished = true;
      callbackFunction(values);
    }
  };
  let cb = function() {
    try {
      // Open a transaction to the database
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const values = {};
      let isReadable = true;
      keys.forEach(function(key) {
        const readRequest = store.get(key);
        readRequest.onsuccess = function() {
          try {
            values[key] = readRequest.result ? JSON.parse(readRequest.result) : null;
          } catch (err) {
            console.error('%c[index.js, getMultipleData]', 'color: green;', 'Error: Unable to parse the data at the key: ' + key + ' from IndexedDB: ' + err);
            isReadable = false;
          }
        };
      });

      // Pass the values on once every key was read
      transaction.oncomplete = function() {
        console.log('%c[index.js, getMultipleData]', 'color: green;', 'Reading data from DB keys: ' + keys.join(', ') + ' with values: ' + JSON.stringify(values));
        finish(isReadable ? values : null);
      };

      transaction.onerror = function(e) {
        console.error('%c[index.js, getMultipleData]', 'color: green;', 'Error: Unable to read the keys: ' + keys.join(', ') + ' from IndexedDB: ' + e);
        finish(null);
      };

      transaction.onabort = function(e) {
        console.error('%c[index.js, getMultipleData]', 'color: green;', 'Error: Reading the keys: ' + keys.join(', ') + ' from IndexedDB was aborted: ' + e);
        finish(null);
      };
    } catch (err) {
      console.error('%c[index.js, getMultipleData]', 'color: green;', 'Error: Something went wrong while reading the keys: ' + keys.join(', ') + ' from IndexedDB: ' + err);
      finish(null);
    }
  };

  if (db) {
    cb();
  } else {
    openIndexDB(cb);
  }
}

// Store several keys in one transaction, so that either all of them are stored or none, and call the callback function
// once they are stored
function storeMultipleData(entries, callbackFunction) {
  let cb = function() {
    try {
      // Open a transaction to the database
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      // Put the text of every entry into the database
      Object.keys(entries).forEach(function(key) {
        store.put(JSON.stringify(entries[key]), key);
      });

      transaction.oncomplete = function(e) {
        console.log('%c[index.js, storeMultipleData]', 'color: green;', 'Storing data at keys: ' + Object.keys(entries).join(', ') + ' with data: ' + JSON.stringify(entries));
        if (callbackFunction) {
          callbackFunction();
        }
      };

      transaction.onerror = function(e) {
        console.error('%c[index.js, storeMultipleData]', 'color: green;', 'Error: Unable to store data in IndexedDB: ' + e);
      };
    } catch (err) {
      console.error('%c[index.js, storeMultipleData]', 'color: green;', 'Error: Something went wrong while storing data at the keys: ' + Object.keys(entries).join(', ') + ' in IndexedDB: ' + err);
    }
  };

  if (db) {
    cb();
  } else {
    openIndexDB(cb);
  }
}

// Storing data takes the data as an object, and shoves it into JSON to store.
// Unfortunately, objects with function instances (classes) are stripped of their function instances
// when converted to a raw object, so we cannot forget to revive the object after we load it.
function saveHosts() {
  storeData('hosts', hosts, null);
}

function savePreviewApps() {
  if (!_isSmartHubSupported) {
    return;
  }
  console.log('%c[index.js, savePreviewApps]', 'color: green;', 'Saving preview apps data: ' + JSON.stringify(_previewApps));
  storeData('previewApps', _previewApps, null);
}

function saveResolution() {
  var chosenResolution = $(this).data('value');
  // Re-selecting the current resolution changes nothing, so it must not reset the bitrate either
  if (String(chosenResolution) === String($('#selectResolution').data('value'))) {
    return;
  }
  $('#selectResolution').text($(this).text()).attr('data-value', chosenResolution).data('value', chosenResolution);
  console.log('%c[index.js, saveResolution]', 'color: green;', 'Saving resolution value: ' + chosenResolution);
  storeData('resolution', chosenResolution, null);

  // Update the bitrate value based on the selected resolution, unless it was picked by hand
  applyBitratePresets();
  // Trigger warning check after changing video resolution
  warnResolutionFramerate();
  warnH264Resolution();
}

function saveFramerate() {
  var chosenFramerate = $(this).data('value');
  // Re-selecting the current frame rate changes nothing, so it must not reset the bitrate either
  if (String(chosenFramerate) === String($('#selectFramerate').data('value'))) {
    return;
  }
  $('#selectFramerate').text($(this).text()).attr('data-value', chosenFramerate).data('value', chosenFramerate);
  console.log('%c[index.js, saveFramerate]', 'color: green;', 'Saving framerate value: ' + chosenFramerate);
  storeData('frameRate', chosenFramerate, null);

  // Update the bitrate value based on the selected frame rate, unless it was picked by hand
  applyBitratePresets();
  // Trigger warning check after changing video frame rate
  warnResolutionFramerate();
}

// Show the text of a message key of the warning rules in tv_profile.js (VIDEO_WARNINGS). The texts are written out here,
// one per key, so that i18n-sync.js finds them for the locale files.
function showVideoWarning(messageKey) {
  switch (messageKey) {
    case VIDEO_WARNINGS.FPS_ABOVE_60_HZ:
      snackbarLogLong('Warning: Many Samsung TVs have 60 Hz panels, and Tizen apps often show only about 60 FPS, so frame rates above 60 FPS may not look smoother and cost more bitrate!');
      break;
    case VIDEO_WARNINGS.NEEDS_LEVEL_52:
      snackbarLogLong('Warning: This resolution and frame rate need a video decoder with HEVC or AV1 Level 5.2, which most Samsung TVs with a 120 Hz panel have. On other TVs the stream may fail to start!');
      break;
    case VIDEO_WARNINGS.EXCEEDS_LEVEL_52:
      snackbarLogLong('Warning: This resolution and frame rate exceed HEVC and AV1 Level 5.2, the highest decoder level that the app asks the TV for, so the stream may stutter or fail to start!');
      break;
    case VIDEO_WARNINGS.EXCEEDS_TESTED_DECODER:
      // The decoder of a tested model with a 120 Hz panel handled 4K at up to 120 FPS in the tests
      snackbarLogLong('Warning: The video decoder of the TV supports 4K up to 120 FPS, so higher frame rates at 4K may stutter or fail to start!');
      break;
    case VIDEO_WARNINGS.HIGH_RESOLUTION_FPS:
      snackbarLogLong('Warning: This resolution and frame rate may not perform well on lower-end devices or slower connections!');
      break;
    case VIDEO_WARNINGS.FPS_90_CADENCE:
      snackbarLogLong('Warning: 90 FPS does not divide a 60 or 120 Hz output evenly, so motion may be less smooth than at 60 or 120 FPS!');
      break;
    case VIDEO_WARNINGS.HDR_NOT_REPORTED:
      snackbarLogLong('Warning: This TV does not report HDR support, so an HDR stream may show washed-out colors or fail to start!');
      break;
    case VIDEO_WARNINGS.ETHERNET_BITRATE:
      snackbarLogLong('Warning: Samsung TVs usually have a 100 Mbps Ethernet port, so bitrates above %1$s Mbps can cause packet loss. Use 5 GHz Wi-Fi for higher bitrates!', ETHERNET_MAX_BITRATE);
      break;
    case VIDEO_WARNINGS.BITRATE_ABOVE_CAP:
      snackbarLogLong('Warning: Bitrates above %1$s Mbps exceed what is recommended for the video decoder of this TV and may cause playback interruptions and performance issues, please try with caution!', getDecoderCapMbps(tvCapabilities));
      break;
    case VIDEO_WARNINGS.H264_RESOLUTION:
      snackbarLogLong('Warning: Samsung TVs generally decode H.264 only up to 1080p, so use HEVC or AV1 for higher resolutions!');
      break;
    default:
      console.warn('%c[index.js, showVideoWarning]', 'color: green;', 'Warning: No text for the message key: ' + messageKey);
      break;
  }
}

function warnResolutionFramerate() {
  var chosenResolution = String($('#selectResolution').data('value'));
  var chosenFramerate = parseInt($('#selectFramerate').data('value'), 10);

  // Video resolution and frame rate warning for what the TV can decode and show (resolutionFramerateWarningKey() in
  // tv_profile.js). It shows once per message, so a change to a selection with another message (e.g. from 4K at 120 FPS
  // to 4K at 144 FPS) shows that one, and again after a selection without a warning.
  const warningKey = resolutionFramerateWarningKey(chosenResolution, chosenFramerate, tvCapabilities);
  if (warningKey && warningKey !== resFpsWarning) {
    showVideoWarning(warningKey);
  }
  // Remember the message key, or reset it once the selection needs no warning
  resFpsWarning = warningKey || false;

  // 90 FPS cadence hint, which has its own flag so that it also shows after a switch from 120 to 90 FPS
  const cadenceKey = framerateCadenceWarningKey(chosenFramerate);
  if (!fps90Warning && cadenceKey) {
    // The TV presents at 60 or 120 Hz, neither of which 90 FPS divides evenly
    showVideoWarning(cadenceKey);
    // Set flag for the 90 FPS cadence hint
    fps90Warning = true;
  } else if (fps90Warning && !cadenceKey) {
    // Reset the flag for the 90 FPS cadence hint once another frame rate is selected
    fps90Warning = false;
  }
}

function warnH264Resolution() {
  var chosenResolution = String($('#selectResolution').data('value'));
  var chosenVideoCodec = $('#selectCodec').data('value');

  // H.264 resolution warning, for H.264 above 1080p, which Samsung TVs generally can't decode (h264ResolutionWarningKey()
  // in tv_profile.js)
  const warningKey = h264ResolutionWarningKey(chosenVideoCodec, chosenResolution);
  if (!h264ResolutionWarning && warningKey) {
    showVideoWarning(warningKey);
    // Set flag for H.264 resolution warning
    h264ResolutionWarning = true;
  } else if (h264ResolutionWarning && !warningKey) {
    // Reset the flag for H.264 resolution warning if the condition goes back to normal (HEVC, AV1 or 1080p)
    h264ResolutionWarning = false;
  }
}

// Warn when HDR is switched on for a TV that doesn't report HDR support (hdrWarningKey() in tv_profile.js). It runs on
// every toggle of HDR with HEVC or AV1 and warns only while HDR is on, so it shows each time HDR is switched on.
function warnHdrMode() {
  const chosenHdrMode = $('#hdrModeSwitch').parent().hasClass('is-checked');
  const warningKey = hdrWarningKey(chosenHdrMode, tvCapabilities);
  if (warningKey) {
    showVideoWarning(warningKey);
  }
}

function saveBitrate() {
  var chosenBitrate = $('#bitrateSlider').val();
  $('#selectBitrate').html(chosenBitrate + ' Mbps');
  console.log('%c[index.js, saveBitrate]', 'color: green;', 'Saving bitrate value: ' + chosenBitrate);
  storeData('bitrate', chosenBitrate, null);

  // Trigger warning check after changing video bitrate
  warnBitrate();
}

// Store whether the bitrate presets follow the video settings, only when it changes, since every step of the
// bitrate slider would otherwise write to the database
function setAutoAdjustBitrate(enabled) {
  if (autoAdjustBitrate === enabled) {
    return;
  }
  autoAdjustBitrate = enabled;
  console.log('%c[index.js, setAutoAdjustBitrate]', 'color: green;', 'Saving auto adjust bitrate state: ' + enabled);
  storeData('autoAdjustBitrate', enabled, null);
}

// Apply the bitrate presets after the resolution, frame rate, codec or HDR changed. A bitrate that was picked by hand,
// or set by the optimal streaming settings for the network connection, is kept instead, like moonlight-qt does, so
// that e.g. a trip to 120 FPS and back doesn't leave 4K at 60 FPS with the lower preset of 80 Mbps unnoticed.
function applyBitratePresets() {
  if (!autoAdjustBitrate) {
    console.log('%c[index.js, applyBitratePresets]', 'color: green;', 'Keeping the bitrate of ' + $('#bitrateSlider').val() + ' Mbps');
    // Explain once how to get the presets back, since nothing else changes on screen, with the bitrates that the
    // presets set for the selected video settings on this TV (presetBitrates() in tv_profile.js)
    if (!keptBitrateNotice) {
      const presets = presetBitrates(String($('#selectResolution').data('value')), $('#selectFramerate').data('value').toString(),
        $('#selectCodec').data('value').toString(), $('#hdrModeSwitch').parent().hasClass('is-checked'), getActiveConnectionType(), tvCapabilities);
      snackbarLogLong('Keeping your bitrate of %1$s Mbps. For the selected video settings, turning \'Optimize bitrate presets\' on applies %2$s Mbps, turning it off applies the standard preset of %3$s Mbps.',
        $('#bitrateSlider').val(), presets.optimized, presets.standard !== null ? presets.standard : $('#bitrateSlider').val());
      keptBitrateNotice = true;
    }
    // Re-check the bitrate warnings, e.g. for the Ethernet port of the TV
    warnBitrate();
    return;
  }
  $('#optimizeBitrateSwitch').prop('checked') ? optimizeBitratePresets() : standardBitratePresets();
}

function warnBitrate() {
  var chosenBitrate = $('#bitrateSlider').val();
  // Which bitrate limit is exceeded, if any: the 100 Mbps Ethernet port that Samsung TVs usually have, or otherwise the
  // decoder cap of the TV (bitrateWarningKey() in tv_profile.js)
  const warningKey = bitrateWarningKey(chosenBitrate, getActiveConnectionType(), tvCapabilities);

  // Video bitrate warning for the 100 Mbps Ethernet port of the TV
  if (warningKey === VIDEO_WARNINGS.ETHERNET_BITRATE) {
    if (!ethernetBitrateWarning) {
      // Warn only if the TV is connected via Ethernet and the video bitrate exceeds what its port can carry
      showVideoWarning(warningKey);
      // Set flag for Ethernet bitrate warning
      ethernetBitrateWarning = true;
    }
    return;
  } else if (ethernetBitrateWarning) {
    // Reset the flag for Ethernet bitrate warning if the condition goes back to normal (80 Mbps or Wi-Fi)
    ethernetBitrateWarning = false;
  }

  // Video bitrate warning for the decoder cap of the TV (e.g. 100 Mbps for a tested model, 80 Mbps for other 4K TVs)
  if (!bitrateWarning && warningKey === VIDEO_WARNINGS.BITRATE_ABOVE_CAP) {
    showVideoWarning(warningKey);
    // Set flag for video bitrate warning
    bitrateWarning = true;
  } else if (bitrateWarning && warningKey !== VIDEO_WARNINGS.BITRATE_ABOVE_CAP) {
    // Reset the flag for video bitrate warning if the condition goes back to normal (at or below the decoder cap)
    bitrateWarning = false;
  }
}

// Apply the standard bitrate preset of the selected resolution and frame rate (STANDARD_BITRATE_PRESETS and
// getStandardPresetBitrate() are in tv_profile.js)
function standardBitratePresets() {
  console.log('%c[index.js, standardBitratePresets]', 'color: green;', 'Applying standard bitrate presets...');
  var res = $('#selectResolution').data('value');
  var frameRate = $('#selectFramerate').data('value').toString();

  // Set the bitrate based on the selected resolution and frame rate
  var preset = getStandardPresetBitrate(res, frameRate);
  if (preset !== null) {
    $('#bitrateSlider')[0].MaterialSlider.change(String(preset));
  }

  // Keep the bitrate within what the network connection and the video decoder of the TV can carry
  limitPresetBitrate();

  // Update the bitrate value
  saveBitrate();
}

// Limit the bitrate of a preset to what the network connection and the video decoder of the TV can carry
// (presetBitrateLimit() in tv_profile.js). A preset above the recommended bitrate for the 100 Mbps Ethernet port that
// Samsung TVs usually have (e.g. 120 Mbps for 4K at 120 FPS) would cause packet loss and frame drops, and on a TV
// without a tested profile a preset stays within the highest bitrate that the app recommends for it.
function limitPresetBitrate() {
  var presetBitrate = parseFloat($('#bitrateSlider').val());
  const limit = presetBitrateLimit(getActiveConnectionType(), tvCapabilities);
  if (!limit || !(presetBitrate > limit.mbps)) {
    return;
  }
  console.log('%c[index.js, limitPresetBitrate]', 'color: green;', 'Limiting the preset bitrate from ' + presetBitrate + ' to ' + limit.mbps + ' Mbps (' + limit.reason + ')');
  $('#bitrateSlider')[0].MaterialSlider.change(String(limit.mbps));
  // Explain the limit only once, since the presets are applied on every resolution and frame rate change
  if (limit.reason === 'ethernet') {
    if (!ethernetPresetNotice) {
      snackbarLogLong('The bitrate has been limited to %1$s Mbps, because Samsung TVs usually have a 100 Mbps Ethernet port.', limit.mbps);
      ethernetPresetNotice = true;
    }
  } else if (!recommendedPresetNotice) {
    snackbarLogLong('The bitrate has been limited to %1$s Mbps, the highest bitrate that the app recommends for this TV and network connection. You can still raise it with the bitrate slider.', limit.mbps);
    recommendedPresetNotice = true;
  }
}

// Apply the optimized bitrate preset of the selected resolution, frame rate, codec and HDR mode
// (getOptimizedPresetBitrate() is in tv_profile.js)
function optimizeBitratePresets() {
  console.log('%c[index.js, optimizeBitratePresets]', 'color: green;', 'Applying optimize bitrate presets...');
  var res = $('#selectResolution').data('value');
  var frameRate = $('#selectFramerate').data('value').toString();
  var videoCodec = $('#selectCodec').data('value').toString();
  var hdrMode = $('#hdrModeSwitch').parent().hasClass('is-checked');

  // Set the bitrate slider value based on the calculated optimized bitrate
  $('#bitrateSlider')[0].MaterialSlider.change(getOptimizedPresetBitrate(res, frameRate, videoCodec, hdrMode));

  // Keep the bitrate within what the network connection and the video decoder of the TV can carry
  limitPresetBitrate();

  // Update the bitrate value
  saveBitrate();
}

function saveFramePacing() {
  setTimeout(() => {
    const chosenFramePacing = $('#framePacingSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveFramePacing]', 'color: green;', 'Saving frame pacing state: ' + chosenFramePacing);
    storeData('framePacing', chosenFramePacing, null);
  }, 100);
}

function saveLanguagePreference() {
  var chosenLanguage = $(this).data('value') || 'auto';
  $('#selectLanguage').text($(this).text()).attr('data-value', chosenLanguage).data('value', chosenLanguage);
  console.log('%c[index.js, saveLanguagePreference]', 'color: green;', 'Saving language preference value: ' + chosenLanguage);
  if (window.i18n && typeof window.i18n.applyLanguagePreference === 'function') {
    window.i18n.applyLanguagePreference(chosenLanguage).catch((error) => {
      console.warn('%c[index.js, saveLanguagePreference]', 'color: green;', 'Warning: failed to apply language: ' + error);
    });
  }
}

function saveIpAddressFieldMode() {
  setTimeout(() => {
    const chosenIpAddressFieldMode = $('#ipAddressFieldModeSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveIpAddressFieldMode]', 'color: green;', 'Saving IP address field mode state: ' + chosenIpAddressFieldMode);
    storeData('ipAddressFieldMode', chosenIpAddressFieldMode, null);
  }, 100);
}

function saveSortAppsList() {
  setTimeout(() => {
    const chosenSortAppsList = $('#sortAppsListSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveSortAppsList]', 'color: green;', 'Saving sort apps list state: ' + chosenSortAppsList);
    storeData('sortAppsList', chosenSortAppsList, null);
    
    // Instantly update the Smart Hub Preview to reflect the new sort order
    const sortOrder = chosenSortAppsList ? 'DESC' : 'ASC';
    let updated = false;
    Object.keys(_previewApps).forEach(function(serverUid) {
      if (_previewApps[serverUid] && _previewApps[serverUid].apps) {
        _previewApps[serverUid].apps = sortTitles(_previewApps[serverUid].apps, sortOrder);
        updated = true;
      }
    });
    if (updated) {
      savePreviewApps();
      updatePreviewData();
    }
  }, 100);
}

function saveOptimizeGames() {
  setTimeout(() => {
    const chosenOptimizeGames = $('#optimizeGamesSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveOptimizeGames]', 'color: green;', 'Saving optimize games state: ' + chosenOptimizeGames);
    storeData('optimizeGames', chosenOptimizeGames, null);
  }, 100);
}

function saveRumbleFeedback() {
  setTimeout(() => {
    const chosenRumbleFeedback = $('#rumbleFeedbackSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveRumbleFeedback]', 'color: green;', 'Saving rumble feedback state: ' + chosenRumbleFeedback);
    storeData('rumbleFeedback', chosenRumbleFeedback, null);
  }, 100);
}

function saveMouseEmulation() {
  setTimeout(() => {
    const chosenMouseEmulation = $('#mouseEmulationSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveMouseEmulation]', 'color: green;', 'Saving mouse emulation state: ' + chosenMouseEmulation);
    storeData('mouseEmulation', chosenMouseEmulation, null);
  }, 100);
}

function saveFlipABfaceButtons() {
  setTimeout(() => {
    const chosenFlipABfaceButtons = $('#flipABfaceButtonsSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveFlipABfaceButtons]', 'color: green;', 'Saving flip A/B face buttons state: ' + chosenFlipABfaceButtons);
    storeData('flipABfaceButtons', chosenFlipABfaceButtons, null);
  }, 100);
}

function saveFlipXYfaceButtons() {
  setTimeout(() => {
    const chosenFlipXYfaceButtons = $('#flipXYfaceButtonsSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveFlipXYfaceButtons]', 'color: green;', 'Saving flip X/Y face buttons state: ' + chosenFlipXYfaceButtons);
    storeData('flipXYfaceButtons', chosenFlipXYfaceButtons, null);
  }, 100);
}

// Save the controller type that the stream announces to the PC for every gamepad: Auto (detected from the id of each
// gamepad, see controller_type.hpp), Xbox, PlayStation or Nintendo
function saveControllerType() {
  var chosenControllerType = $(this).data('value');
  $('#selectControllerType').text($(this).text()).attr('data-value', chosenControllerType).data('value', chosenControllerType);
  console.log('%c[index.js, saveControllerType]', 'color: green;', 'Saving controllerType value: ' + chosenControllerType);
  storeData('controllerType', chosenControllerType, null);
}

function saveAudioBackend() {
  var chosenAudioBackend = $(this).data('value');
  $('#selectAudioBackend').text($(this).text()).attr('data-value', chosenAudioBackend).data('value', chosenAudioBackend);
  console.log('%c[index.js, saveAudioBackend]', 'color: green;', 'Saving audioBackend value: ' + chosenAudioBackend);
  storeData('audioBackend', chosenAudioBackend, null);

  // Show only the settings that apply to the selected audio backend
  updateAudioBackendSettings();
}

// The audio backends do not share their tuning settings, so only show the
// settings that the selected backend actually uses while streaming
function updateAudioBackendSettings() {
  // Check if the audio output is disabled in the audio backend setting
  if (isAudioOutputDisabled()) {
    // Neither setting applies when the audio stream is discarded
    $('#audioConfigOption').hide();
    $('#audioSyncOption').hide();
    $('#audioJitterOption').hide();
    $('#audioClockSyncOption').hide();
    $('#decryptHostAudioOption').hide();
  } else {
    // These two settings apply to all active backends, so show them normally
    $('#audioConfigOption').show();
    $('#decryptHostAudioOption').show();
    // Check which backend is selected and show the appropriate setting for that backend
    if (isWebAudioBackendSelected()) {
      // The Web Audio backend schedules the audio itself using the jitter buffer
      $('#audioSyncOption').hide();
      $('#audioJitterOption').show();
      $('#audioClockSyncOption').show();
    } else {
      // The EMSS backend drops audio packets to stay in sync instead of buffering them
      $('#audioJitterOption').hide();
      $('#audioClockSyncOption').hide();
      $('#audioSyncOption').show();
    }
  }
}

// Check whether the Web Audio backend is the currently selected audio backend
function isWebAudioBackendSelected() {
  return $('#selectAudioBackend').data('value') === 'WebAudio';
}

// Check whether the audio output is disabled in the audio backend setting
function isAudioOutputDisabled() {
  return $('#selectAudioBackend').data('value') === 'Disabled';
}

function saveAudioConfiguration() {
  var chosenAudioConfig = $(this).data('value');
  $('#selectAudio').text($(this).text()).attr('data-value', chosenAudioConfig).data('value', chosenAudioConfig);
  console.log('%c[index.js, saveAudioConfiguration]', 'color: green;', 'Saving audioConfig value: ' + chosenAudioConfig);
  storeData('audioConfig', chosenAudioConfig, null);

  // Trigger warning check after changing audio configuration
  warnAudioConfiguration();
}

function warnAudioConfiguration() {
  var chosenAudioConfig = $('#selectAudio').data('value');

  // Audio configuration warning
  if (!audioWarning && (chosenAudioConfig === '71Surround' || chosenAudioConfig === '51Surround')) {
    // Warn only if audio configuration is selected to 5.1 or 7.1 Surround
    snackbarLogLong('Warning: Surround Sound (5.1/7.1) may not be supported by your TV and is not guaranteed to work due to platform limitations!');
    // Set flag for audio configuration warning
    audioWarning = true;
  } else if (audioWarning && (chosenAudioConfig === 'Stereo')) {
    // Reset the flag for audio configuration warning if the condition goes back to normal (Stereo)
    audioWarning = false;
  }
}

function saveAudioSync() {
  setTimeout(() => {
    const chosenAudioSync = $('#audioSyncSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveAudioSync]', 'color: green;', 'Saving audio sync state: ' + chosenAudioSync);
    storeData('audioSync', chosenAudioSync, null);
  }, 100);
}

function saveAudioClockSync() {
  setTimeout(() => {
    const chosenAudioClockSync = $('#audioClockSyncSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveAudioClockSync]', 'color: green;', 'Saving audio clock sync state: ' + chosenAudioClockSync);
    storeData('audioClockSync', chosenAudioClockSync, null);
  }, 100);
}

function saveAudioJitter() {
  var chosenAudioJitter = $('#jitterSlider').val();
  $('#selectAudioJitter').html(chosenAudioJitter + ' ms');
  console.log('%c[index.js, saveAudioJitter]', 'color: green;', 'Saving audio jitter buffer: ' + chosenAudioJitter);
  storeData('audioJitter', chosenAudioJitter, null);
}

function savePlayHostAudio() {
  setTimeout(() => {
    const chosenPlayHostAudio = $('#playHostAudioSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, savePlayHostAudio]', 'color: green;', 'Saving play host audio state: ' + chosenPlayHostAudio);
    storeData('playHostAudio', chosenPlayHostAudio, null);
  }, 100);
}

function saveDecryptHostAudio() {
  setTimeout(() => {
    const chosenDecryptHostAudio = $('#decryptHostAudioSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveDecryptHostAudio]', 'color: green;', 'Saving decrypt host audio state: ' + chosenDecryptHostAudio);
    storeData('decryptHostAudio', chosenDecryptHostAudio, null);

    // Warning when enabling decrypt host audio for non-Wolf/Punktfunk-style hosts
    if (chosenDecryptHostAudio) {
      // Show a warning message when enabling decrypt host audio
      snackbarLogLong('Warning: Enable this only for Wolf or Punktfunk-style hosts, and leave it disabled for Sunshine or GameStream hosts to avoid audio streaming issues!');
    }
  }, 100);
}

function saveVideoCodec() {
  var chosenVideoCodec = $(this).data('value');
  const selectedH264Codec = $('#h264').data('value');
  const enabledHdrMode = $('#hdrModeSwitch').parent().hasClass('is-checked');

  // Check if HDR mode is enabled and prevent any incompatible HDR codec from being selected
  if (enabledHdrMode && chosenVideoCodec === selectedH264Codec) { // Selecting H.264 while HDR mode is enabled
    // H.264 does not support HDR profile, so stay on H.264 codec
    updateVideoCodec('#h264', selectedH264Codec);
    snackbarLog('HDR has been disabled due to unsupported H.264 codec.');
    // Turn off the HDR mode switch and save the state
    document.querySelector('#hdrModeBtn').MaterialSwitch.off();
    updateHdrMode();
  } else { // Selecting other video codecs while HDR mode is disabled
    // Continue to select the SDR profile of other video codecs
    updateVideoCodec(this, chosenVideoCodec);
  }
}

function updateVideoCodec(chosenCodecId, chosenCodecValue) {
  // Show the name of the codec without the note that the menu entry may have (labelVideoCodecSupport())
  $('#selectCodec').text(getMenuItemLabel(chosenCodecId)).attr('data-value', chosenCodecValue).data('value', chosenCodecValue);
  console.log('%c[index.js, updateVideoCodec]', 'color: green;', 'Saving video codec value: ' + chosenCodecValue);
  storeData('videoCodec', chosenCodecValue, null);

  // Update the bitrate value based on the selected codec, unless it was picked by hand
  if ($('#optimizeBitrateSwitch').prop('checked')) {
    applyBitratePresets();
  }
  // Trigger warning check after changing video codec
  warnVideoCodec();
  warnH264Resolution();
}

function warnVideoCodec() {
  var chosenVideoCodec = $('#selectCodec').data('value');

  // Video codec warning
  if (!codecWarning && (chosenVideoCodec === 'AV1')) {
    // Warn only if video codec is selected to AV1
    snackbarLogLong('Warning: AV1 needs a host GPU with an AV1 encoder and a TV with an AV1 decoder. If the host PC can\'t encode AV1, the stream uses HEVC instead.');
    // Set flag for video codec warning
    codecWarning = true;
  } else if (codecWarning && (chosenVideoCodec === 'HEVC' || chosenVideoCodec === 'H264')) {
    // Reset the flag for video codec warning if the condition goes back to normal (HEVC or H.264)
    codecWarning = false;
  }
}

function saveHdrMode() {
  setTimeout(() => {
    var selectedVideoCodec = $('#selectCodec').data('value');
    const chosenH264Codec = $('#h264').data('value');
    const chosenHevcCodec = $('#hevc').data('value');
    const chosenAv1Codec = $('#av1').data('value');

    // Handle HDR mode switch based on the selected codec
    if (selectedVideoCodec === chosenH264Codec) { // H.264
      // H.264 does not support HDR profile, so stay on H.264 codec
      snackbarLog('H.264 codec does not support the HDR profile.');
      // Turn off the HDR mode switch and save the state
      document.querySelector('#hdrModeBtn').MaterialSwitch.off();
      updateHdrMode();
    } else if (selectedVideoCodec === chosenHevcCodec) { // HEVC
      // Select the HDR profile of the HEVC codec (HEVC Main10)
      // Toggle the HDR mode switch and save the state
      updateHdrMode();
      // Warn when HDR was switched on for a TV that doesn't report HDR support
      warnHdrMode();
    } else if (selectedVideoCodec === chosenAv1Codec) { // AV1
      // Select the HDR profile of the AV1 codec (AV1 Main10)
      // Toggle the HDR mode switch and save the state
      updateHdrMode();
      // Warn when HDR was switched on for a TV that doesn't report HDR support
      warnHdrMode();
    } else { // Undefined
      // Unknown codec format does not support HDR profile
      snackbarLog('Selected codec does not support the HDR profile.');
      // Turn off the HDR mode switch and save the state
      document.querySelector('#hdrModeBtn').MaterialSwitch.off();
      updateHdrMode();
    }
  }, 100);
}

function updateHdrMode() {
  setTimeout(() => {
    const chosenHdrMode = $('#hdrModeSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, updateHdrMode]', 'color: green;', 'Saving HDR mode state: ' + chosenHdrMode);
    storeData('hdrMode', chosenHdrMode, null);

    // Update the bitrate value based on the selected HDR state, unless it was picked by hand
    if ($('#optimizeBitrateSwitch').prop('checked')) {
      applyBitratePresets();
    }
  }, 100);
}

function saveFullRange() {
  setTimeout(() => {
    const chosenFullRange = $('#fullRangeSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveFullRange]', 'color: green;', 'Saving full range state: ' + chosenFullRange);
    storeData('fullRange', chosenFullRange, null);
  }, 100);
}

function saveGameMode() {
  setTimeout(() => {
    const chosenGameMode = $('#gameModeSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveGameMode]', 'color: green;', 'Saving game mode state: ' + chosenGameMode);
    storeData('gameMode', chosenGameMode, null);

    // Check if the Tizen version is 9.0 or higher and the Game Mode is turned on
    if (parseFloat(platformVer) >= 9.0 && chosenGameMode) {
      // Show a warning dialog when turning on Game Mode on Tizen 9.0 or higher
      setTimeout(() => {
        warningDialog(t('Compatibility Warning'),
          t('Game Mode (Ultra Low Latency) is not compatible with Tizen %1$s due to platform changes introduced by Samsung.', platformVer) + 
          t('Enabling this option may result in video freezing on the first rendered frame, black screen, unstable performance, and other streaming issues.<br><br>') + 
          t('For more information about this incompatibility and the ForceGM variant, see <b>ForceGM variant and game mode</b> in the guide of Moonlight Plus, which the Support button at the top of the screen links to.')
        );
      }, 250);
    } else if (parseFloat(platformVer) < 9.0 && !chosenGameMode) { // Check if the Tizen version is lower than 9.0 and the Game Mode is turned off
      // Show a warning message when turning off Game Mode on compatible Tizen versions
      snackbarLogLong('Warning: Disabling game mode may increase latency and affect your game streaming performance!');
    }
  }, 100);
}

function saveUnlockAllFps() {
  setTimeout(() => {
    const chosenUnlockAllFps = $('#unlockAllFpsSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveUnlockAllFps]', 'color: green;', 'Saving unlock all FPS state: ' + chosenUnlockAllFps);
    storeData('unlockAllFps', chosenUnlockAllFps, null);

    // Warning when enabling higher FPS options
    if (chosenUnlockAllFps) {
      // Show a warning message when enabling higher FPS options
      snackbarLogLong('Warning: Higher frame rates may not be fully supported by your TV and do not guarantee a smoother experience. Performance issues may occur due to platform limitations!');
    }
  }, 100);
}

function handleUnlockAllFps() {
  var currentFps = $('#selectFramerate').data('value');
  const addFramerate = $('.videoFramerateMenu').find('li[data-value="60"]');

  // Check if the Unlock all FPS switch is checked
  if ($('#unlockAllFpsSwitch').prop('checked')) {
    console.log('%c[index.js, handleUnlockAllFps]', 'color: green;', 'Adding higher framerate options: 90, 120, 144 FPS');
    // Check if any of the higher FPS options are absent to avoid duplicates
    if (!$('.videoFramerateMenu').find('li[data-value="90"], li[data-value="120"], li[data-value="144"]').length) {
      // Insert all higher FPS options in correct order (90, 120, 144)
      addFramerate.after(`
        <li class="mdl-menu__item" data-value="90" data-i18n="90 FPS">90 FPS</li>
        <li class="mdl-menu__item" data-value="120" data-i18n="120 FPS">120 FPS</li>
        <li class="mdl-menu__item" data-value="144" data-i18n="144 FPS">144 FPS</li>
      `);
      // Attach click listeners only to the newly added FPS options
      $('.videoFramerateMenu li[data-value="90"], li[data-value="120"], li[data-value="144"]').on('click', saveFramerate);
    }
  } else {
    console.log('%c[index.js, handleUnlockAllFps]', 'color: green;', 'Removing higher framerate options: 90, 120, 144 FPS');
    // If unchecked, remove the higher FPS options from the selection menu
    $('.videoFramerateMenu li[data-value="90"], li[data-value="120"], li[data-value="144"]').remove();
    // After removal, if a higher FPS option remains selected, then reset it to the default option
    if (['90', '120', '144'].includes(String(currentFps))) {
      $('#selectFramerate').text('60 FPS').attr('data-value', '60').data('value', '60');
      console.log('%c[index.js, handleUnlockAllFps]', 'color: green;', 'Resetting framerate value to 60 FPS');
      storeData('frameRate', '60', null);
      // Update the bitrate value based on the selected frame rate, unless it was picked by hand
      applyBitratePresets();
      // Reset the resolution and frame rate warning, so that it shows again after the next switch to a higher frame rate
      warnResolutionFramerate();
    }
  }
}

function saveOptimizeBitrate() {
  setTimeout(() => {
    const chosenOptimizeBitrate = $('#optimizeBitrateSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveOptimizeBitrate]', 'color: green;', 'Saving optimize bitrate state: ' + chosenOptimizeBitrate);
    storeData('optimizeBitrate', chosenOptimizeBitrate, null);

    // Toggling the presets asks for them explicitly, so they follow the video settings again from now on
    setAutoAdjustBitrate(true);
    // Update the bitrate value based on the selected preset mode
    chosenOptimizeBitrate ? optimizeBitratePresets() : standardBitratePresets();
  }, 100);
}

function saveDisableWarnings() {
  setTimeout(() => {
    const chosenDisableWarnings = $('#disableWarningsSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveDisableWarnings]', 'color: green;', 'Saving disable warnings state: ' + chosenDisableWarnings);
    storeData('disableWarnings', chosenDisableWarnings, null);
  }, 100);
}

function savePerformanceStats() {
  setTimeout(() => {
    const chosenPerformanceStats = $('#performanceStatsSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, savePerformanceStats]', 'color: green;', 'Saving performance stats state: ' + chosenPerformanceStats);
    storeData('performanceStats', chosenPerformanceStats, null);
  }, 100);
}

function saveRefFrameInvalidation() {
  setTimeout(() => {
    const chosenRefFrameInvalidation = $('#refFrameInvalidationSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveRefFrameInvalidation]', 'color: green;', 'Saving reference frame invalidation state: ' + chosenRefFrameInvalidation);
    storeData('refFrameInvalidation', chosenRefFrameInvalidation, null);

    // Warning when enabling the experimental reference frame invalidation
    if (chosenRefFrameInvalidation) {
      // Show a warning message, because the hardware decoder of the TV may not handle it correctly
      snackbarLogLong('Warning: Reference frame invalidation is experimental. If artifacts remain after a frame drop, disable it again!');
    }
  }, 100);
}

function saveHdrMetadata() {
  setTimeout(() => {
    const chosenHdrMetadata = $('#hdrMetadataSwitch').parent().hasClass('is-checked');
    console.log('%c[index.js, saveHdrMetadata]', 'color: green;', 'Saving HDR static metadata state: ' + chosenHdrMetadata);
    storeData('hdrMetadata', chosenHdrMetadata, null);

    // Warning when enabling the experimental HDR static metadata
    if (chosenHdrMetadata) {
      // Show a warning message, because the hardware decoder of the TV may not accept the added metadata
      snackbarLogLong('Warning: HDR static metadata is experimental. If HDR streams fail to start or look wrong, disable it again!');
    }
  }, 100);
}

// Apply the optimal streaming settings for this TV and its network connection (deriveOptimalSettings() in tv_profile.js),
// which are also the defaults of the video settings: the highest resolution of the panel up to 4K at 60 FPS with HEVC,
// HDR when the TV supports it and a bitrate for the network connection, with all frame rates unlocked only for a tested
// model with a high refresh rate panel (VERIFIED_PROFILES).
// With followPresets, the bitrate follows later changes of the resolution and frame rate (Restore Defaults). Without it,
// the recommended bitrate is kept until the user picks another one (the optimal streaming settings button).
function applyOptimalStreamingSettings(connectionType, followPresets) {
  console.log('%c[index.js, applyOptimalStreamingSettings]', 'color: green;', 'Applying the optimal streaming settings for the network connection: ' + connectionType);
  const optimalSettings = deriveOptimalSettings(tvCapabilities, connectionType);

  const optimalResolution = optimalSettings.resolution;
  const optimalResolutionItem = $('.videoResolutionMenu li[data-value="' + optimalResolution + '"]');
  $('#selectResolution').text(optimalResolutionItem.text()).attr('data-value', optimalResolution).data('value', optimalResolution);
  storeData('resolution', optimalResolution, null);

  // Select the frame rate before the higher frame rates may be locked below, which would otherwise reset a selected
  // higher frame rate on its own and apply the bitrate presets on the way
  const optimalFramerate = optimalSettings.frameRate;
  $('#selectFramerate').text(optimalFramerate + ' FPS').attr('data-value', optimalFramerate).data('value', optimalFramerate);
  storeData('frameRate', optimalFramerate, null);

  // Unlock the higher frame rates only for a tested model whose panel shows them (e.g. a tested model with a 144 Hz panel)
  if (optimalSettings.unlockAllFps) {
    document.querySelector('#unlockAllFpsBtn').MaterialSwitch.on();
  } else {
    document.querySelector('#unlockAllFpsBtn').MaterialSwitch.off();
  }
  storeData('unlockAllFps', optimalSettings.unlockAllFps, null);
  handleUnlockAllFps();

  // HEVC is the most efficient codec that every host GPU with HDR support can encode
  $('#selectCodec').text($('#hevc').text()).attr('data-value', optimalSettings.videoCodec).data('value', optimalSettings.videoCodec);
  storeData('videoCodec', optimalSettings.videoCodec, null);

  // Enable HDR on HDR-capable TVs, which streams HDR10 when HDR is enabled on the host and 10-bit SDR otherwise
  if (optimalSettings.hdrMode) {
    document.querySelector('#hdrModeBtn').MaterialSwitch.on();
  } else {
    document.querySelector('#hdrModeBtn').MaterialSwitch.off();
  }
  storeData('hdrMode', optimalSettings.hdrMode, null);

  // Keep the limited color range, which is the standard for video and preserves the detail in dark and bright areas
  document.querySelector('#fullRangeBtn').MaterialSwitch.off();
  storeData('fullRange', optimalSettings.fullRange, null);

  document.querySelector('#framePacingBtn').MaterialSwitch.on();
  storeData('framePacing', optimalSettings.framePacing, null);

  // Use the bitrate for the network connection instead of the optimized presets, which aim for a lower bitrate
  document.querySelector('#optimizeBitrateBtn').MaterialSwitch.off();
  storeData('optimizeBitrate', optimalSettings.optimizeBitrate, null);

  // Set the game mode based on the Tizen platform version and the WASM player (see getGameModeDefault() in tv_profile.js)
  if (optimalSettings.gameMode === false) {
    // Turn off for Tizen 9.0 and newer to avoid compatibility issues, where the ForceGM variant enables the game mode
    // instead, and for Tizen 5.5 with a WASM player that offers the mode
    document.querySelector('#gameModeBtn').MaterialSwitch.off();
    storeData('gameMode', false, null);
  } else if (optimalSettings.gameMode === true) {
    // Turn on for compatible Tizen versions (e.g., 6.0, 6.5, 7.0, 8.0)
    document.querySelector('#gameModeBtn').MaterialSwitch.on();
    storeData('gameMode', true, null);
  } else {
    // Turn off and disable for Tizen 5.5 due to lack of support, or for a WASM player that says that it doesn't offer
    // the mode, like on a fresh install, and remove a stored value, since any stored value enables the switch again at
    // the next start on Tizen 5.5
    document.querySelector('#gameModeBtn').MaterialSwitch.off();
    document.querySelector('#gameModeBtn').MaterialSwitch.disable();
    removeData('gameMode', null);
  }

  $('#bitrateSlider')[0].MaterialSlider.change(String(optimalSettings.bitrate));
  saveBitrate();
  // Either let the bitrate presets follow later changes of the resolution and frame rate, or keep the recommended
  // bitrate for the network connection when they change
  autoAdjustBitrate = !!followPresets;
  storeData('autoAdjustBitrate', autoAdjustBitrate, null);

  // Re-run the one-shot warning checks so their flags match the applied resolution, frame rate and codec
  warnResolutionFramerate();
  warnH264Resolution();
  warnVideoCodec();
}

// Describe what the app detected about the TV for the optimal settings dialog, e.g. '4K panel, HDR, Tizen 9.0, Wi-Fi',
// which also tells a screenshot of the dialog what the settings are based on (see detectTvCapabilities() in
// tv_profile.js). A product API that failed counts as a Full HD panel without HDR, like everywhere else in the app.
function describeDetectedTv(connectionType) {
  const parts = [];
  if (is8kPanel) {
    parts.push(t('8K panel'));
  } else if (is4kPanel) {
    parts.push(t('4K panel'));
  } else {
    parts.push(t('Full HD panel'));
  }
  parts.push(isHdrCapable ? t('HDR') : t('no HDR'));
  parts.push(platformVer ? t('Tizen %1$s', escapeHTML(platformVer)) : t('unknown Tizen version'));
  if (connectionType === 'ethernet') {
    parts.push(t('Ethernet'));
  } else if (connectionType === 'wifi') {
    parts.push(t('Wi-Fi'));
  } else {
    parts.push(t('unknown connection'));
  }
  return parts.join(', ');
}

// Show the optimal streaming settings for this TV along with what was detected and advice for the network connection,
// and apply them once the user confirms, because they replace the stored video settings. The listed values come from
// the same function that applies them (deriveOptimalSettings() in tv_profile.js), so the text always matches what is
// applied.
function optimalSettingsDialog() {
  const connectionType = getActiveConnectionType();
  const optimalSettings = deriveOptimalSettings(tvCapabilities, connectionType);
  const optimalResolutionText = $('.videoResolutionMenu li[data-value="' + optimalSettings.resolution + '"]').text().trim();

  // Start with what the settings are based on, and whether they were tested on this model (VERIFIED_PROFILES)
  let message = t('Detected: %1$s', describeDetectedTv(connectionType)) + '<br>';
  if (tvCapabilities.profile) {
    message += t('Tested model: these settings were tested on this TV model.') + '<br>';
  }
  message += '<br>';

  message += t('The following streaming settings will be applied:') + '<br>' +
    '&#8226; ' + t('Video resolution') + ': ' + escapeHTML(optimalResolutionText) + ', ' + optimalSettings.frameRate + ' FPS<br>' +
    '&#8226; ' + t('Video codec') + ': ' + (optimalSettings.hdrMode ? t('HEVC Main10 with HDR') : t('HEVC')) + '<br>' +
    '&#8226; ' + t('Video bitrate') + ': ' + optimalSettings.bitrate + ' Mbps<br>' +
    '&#8226; ' + (optimalSettings.unlockAllFps
      ? t('Video frame pacing on, limited color range, unlock all frame rates on, optimize bitrate presets off')
      : t('Video frame pacing on, limited color range, unlock all frame rates off, optimize bitrate presets off')) + '<br>';
  // Name the game mode state, which depends on the Tizen version (the note below covers Tizen 9.0 and newer) and on
  // whether the WASM player offers the Ultra Low Latency mode
  if (optimalSettings.gameMode === true) {
    message += '&#8226; ' + t('Game mode on') + '<br>';
  } else if (isGameModeUnavailable(tvCapabilities)) {
    message += '&#8226; ' + t('Game mode off, because the video player of this TV doesn\'t offer the Ultra Low Latency mode') + '<br>';
  } else if (optimalSettings.gameMode === false && !(parseFloat(platformVer) >= 9.0)) {
    // Below Tizen 9.0, off means Tizen 5.5 with a WASM player that offers the mode, where the switch can be turned on,
    // so say that Continue turns it off
    message += '&#8226; ' + t('Game mode off') + '<br>';
  }
  message += '<br>';

  // Point the owners of a 4K or 8K TV with a 120 Hz panel to the higher frame rates, which stay locked without a tested
  // profile, because the refresh rate of the panel can't be detected and many TVs show 60 Hz (plan decision D7)
  if (!optimalSettings.unlockAllFps && (is4kPanel || is8kPanel)) {
    message += t('If this TV has a 120 Hz panel, you can turn on \'Unlock all frame rates\' in the Advanced Settings to stream at up to 120 FPS.') + '<br><br>';
  }

  // Explain the bitrate limits of the network connection and how to stream without frame drops
  if (connectionType === 'ethernet') {
    message += t('The TV is connected via Ethernet. Samsung TVs usually have a 100 Mbps Ethernet port, so to avoid packet loss from the traffic bursts of the much faster host PC, set its network adapter to 100 Mbps Full Duplex or enable flow control on your switch. Use 5 GHz Wi-Fi for higher bitrates.');
  } else if (connectionType === 'wifi') {
    message += t('The TV is connected via Wi-Fi. Use a 5 GHz network with a strong signal and connect the host PC by cable.') + ' ';
    // Suggest how far the bitrate can go for this resolution, up to the decoder cap of the TV (bitrateRaiseLimit() in
    // tv_profile.js), where the bitrate warning starts
    const raiseLimit = bitrateRaiseLimit(optimalSettings.resolution, optimalSettings.frameRate, tvCapabilities);
    if (raiseLimit > optimalSettings.bitrate) {
      message += t('If the performance statistics show no dropped frames, you can raise the bitrate up to %1$s Mbps.', raiseLimit);
    } else {
      message += t('This is the highest bitrate recommended for the video decoder of this TV, so raise it only if the performance statistics show no dropped frames.');
    }
  } else {
    message += t('The network connection type of the TV could not be detected, so a moderate bitrate will be applied.');
  }

  // Point to the ForceGM variant, because the game mode setting stays disabled on Tizen 9.0 and newer, unless it's
  // already installed
  if (parseFloat(platformVer) >= 9.0) {
    if (checkForceGMVariant()) {
      message += '<br><br>' + t('ForceGM variant detected: the app asks the TV for its Game Mode, so the Game mode setting stays off here and the decoder uses the Low Latency mode.');
    } else {
      message += '<br><br>' + t('Game mode stays disabled on Tizen %1$s, so install the ForceGM variant for the lowest latency.', platformVer);
    }
  }

  var warningDialogOverlay = document.querySelector('#warningDialogOverlay');
  var warningDialog = document.querySelector('#warningDialog');

  // Set the title, which names the model when the TV reports it, and the message
  document.getElementById('warningDialogTitle').innerHTML = modelName
    ? t('Optimal settings for this TV (%1$s)', escapeHTML(modelName))
    : t('Optimal settings for this TV');
  document.getElementById('warningDialogText').innerHTML = message;
  // Show its main values as tiles above the text, filled from the same settings (launcher.js)
  warningDialog.classList.add('is-optimal');
  if (typeof Launcher !== 'undefined') {
    Launcher.fillValueTiles(document.getElementById('warningDialogValues'), optimalSettings);
  }

  // Show the dialog and push the view
  warningDialogOverlay.style.display = 'flex';
  warningDialog.showModal();
  isDialogOpen = true;
  Navigation.push(Views.WarningDialog);

  // Show the Continue button next to the Close button, which acts as Cancel
  $('#continueWarning').show();
  // Remove single-button class since both buttons are now visible
  warningDialog.classList.remove('single-button');

  // Cancel — close the dialog and keep the current settings
  $('#closeWarning').off('click');
  $('#closeWarning').on('click', function() {
    console.log('%c[index.js, optimalSettingsDialog]', 'color: green;', 'Closing the optimal settings dialog without applying the settings.');
    warningDialogOverlay.style.display = 'none';
    warningDialog.close();
    isDialogOpen = false;
    // Restore the default state for future standard warnings
    $('#continueWarning').hide();
    Navigation.pop();
    Navigation.switch();
  });

  // Continue — apply the settings
  $('#continueWarning').off('click');
  $('#continueWarning').on('click', function() {
    console.log('%c[index.js, optimalSettingsDialog]', 'color: green;', 'User confirmed the optimal settings. Applying the settings for the network connection: ' + connectionType);
    warningDialogOverlay.style.display = 'none';
    warningDialog.close();
    isDialogOpen = false;
    // Restore the default state for future standard warnings
    $('#continueWarning').hide();
    Navigation.pop();
    // Keep the recommended bitrate when the resolution or frame rate changes later, as the dialog applied it on purpose
    applyOptimalStreamingSettings(connectionType, false);
    Navigation.switch();
    snackbarLog('The optimal streaming settings for this TV have been applied.');
  });
}

// Reset all settings to their default state and save the value data
function restoreDefaultsSettingsValues() {
  // Restore the video settings to the optimal streaming settings for this TV and its network connection, like a fresh
  // install, whose bitrate follows the resolution and frame rate until the user picks one by hand
  applyOptimalStreamingSettings(getActiveConnectionType(), true);

  const defaultIpAddressFieldMode = true;
  document.querySelector('#ipAddressFieldModeBtn').MaterialSwitch.on();
  storeData('ipAddressFieldMode', defaultIpAddressFieldMode, null);
  // Show the IP address fields of the restored mode
  handleIpAddressFieldMode();

  const defaultSortAppsList = false;
  document.querySelector('#sortAppsListBtn').MaterialSwitch.off();
  storeData('sortAppsList', defaultSortAppsList, null);

  const defaultOptimizeGames = false;
  document.querySelector('#optimizeGamesBtn').MaterialSwitch.off();
  storeData('optimizeGames', defaultOptimizeGames, null);

  const defaultRumbleFeedback = false;
  document.querySelector('#rumbleFeedbackBtn').MaterialSwitch.off();
  storeData('rumbleFeedback', defaultRumbleFeedback, null);

  const defaultMouseEmulation = false;
  document.querySelector('#mouseEmulationBtn').MaterialSwitch.off();
  storeData('mouseEmulation', defaultMouseEmulation, null);

  const defaultFlipABfaceButtons = false;
  document.querySelector('#flipABfaceButtonsBtn').MaterialSwitch.off();
  storeData('flipABfaceButtons', defaultFlipABfaceButtons, null);

  const defaultFlipXYfaceButtons = false;
  document.querySelector('#flipXYfaceButtonsBtn').MaterialSwitch.off();
  storeData('flipXYfaceButtons', defaultFlipXYfaceButtons, null);

  const defaultControllerType = 'Auto';
  $('#selectControllerType').text(t('Auto')).attr('data-value', defaultControllerType).data('value', defaultControllerType);
  storeData('controllerType', defaultControllerType, null);

  const defaultAudioBackend = 'EMSS';
  $('#selectAudioBackend').text('EMSS').attr('data-value', defaultAudioBackend).data('value', defaultAudioBackend);
  storeData('audioBackend', defaultAudioBackend, null);
  // Show the settings of the restored audio backend
  updateAudioBackendSettings();

  const defaultAudioConfig = 'Stereo';
  $('#selectAudio').text('Stereo').attr('data-value', defaultAudioConfig).data('value', defaultAudioConfig);
  storeData('audioConfig', defaultAudioConfig, null);

  const defaultAudioSync = false;
  document.querySelector('#audioSyncBtn').MaterialSwitch.off();
  storeData('audioSync', defaultAudioSync, null);

  const defaultAudioJitter = '100';
  $('#selectAudioJitter').html(defaultAudioJitter + ' ms');
  $('#jitterSlider')[0].MaterialSlider.change(defaultAudioJitter);
  storeData('audioJitter', defaultAudioJitter, null);

  const defaultAudioClockSync = false;
  document.querySelector('#audioClockSyncBtn').MaterialSwitch.off();
  storeData('audioClockSync', defaultAudioClockSync, null);

  const defaultPlayHostAudio = false;
  document.querySelector('#playHostAudioBtn').MaterialSwitch.off();
  storeData('playHostAudio', defaultPlayHostAudio, null);

  const defaultDecryptHostAudio = false;
  document.querySelector('#decryptHostAudioBtn').MaterialSwitch.off();
  storeData('decryptHostAudio', defaultDecryptHostAudio, null);

  const defaultRefFrameInvalidation = false;
  document.querySelector('#refFrameInvalidationBtn').MaterialSwitch.off();
  storeData('refFrameInvalidation', defaultRefFrameInvalidation, null);

  const defaultHdrMetadata = false;
  document.querySelector('#hdrMetadataBtn').MaterialSwitch.off();
  storeData('hdrMetadata', defaultHdrMetadata, null);

  const defaultDisableWarnings = false;
  document.querySelector('#disableWarningsBtn').MaterialSwitch.off();
  storeData('disableWarnings', defaultDisableWarnings, null);

  const defaultPerformanceStats = false;
  document.querySelector('#performanceStatsBtn').MaterialSwitch.off();
  storeData('performanceStats', defaultPerformanceStats, null);
}

function initSamsungKeys() {
  console.log('%c[index.js, initSamsungKeys]', 'color: green;', 'Initializing TV keys...');

  // For explanation on ordering, see: https://developer.samsung.com/smarttv/develop/guides/user-interaction/keyboardime.html
  var handler = {
    initRemoteController: true,
    buttonsToRegister: [
      'ColorF0Red',      // F1
      'ColorF1Green',    // F2
      'ColorF2Yellow',   // F3
      'ColorF3Blue',     // F4
      //'SmartHub',      // F5
      'Source',          // F6
      'ChannelList',     // F7
      //'VolumeMute',    // F8
      //'VolumeDown',    // F9
      //'VolumeUp',      // F10
      'ChannelDown',     // F11
      'ChannelUp',       // F12
    ],
    onKeydownListener: remoteControllerHandler
  };

  console.log('%c[index.js, initSamsungKeys]', 'color: green;', 'Initializing TV platform...');
  platformOnLoad(handler);

  // Register the media keys one by one: Play/Pause (or Play and Pause) opens the Stream Menu during a stream and the menu
  // of a host or app otherwise (remote_controller.js). A TV that refuses one of them, e.g. for a remote without it, must
  // not stop the others, so RED, YELLOW and the gamepad combo stay the fallback.
  ['MediaPlayPause', 'MediaPlay', 'MediaPause'].forEach(function(keyName) {
    try {
      tizen.tvinputdevice.registerKey(keyName);
    } catch (error) {
      console.warn('%c[index.js, initSamsungKeys]', 'color: green;', 'Warning: Failed to register the key ' + keyName + ': ' + error);
    }
  });
}

function initSpecialKeys() {
  console.log('%c[index.js, initSpecialKeys]', 'color: green;', 'Initializing special TV input keys...');

  // Find the video element that displays the streaming session
  var videoElement = document.getElementById('wasm_module');

  // During a stream, keep the keys that open the Stream Menu, and every key while it is open, away from the PC: this
  // listener runs before the keyboard handler of the stream on the video element, which sends the keys to the PC while
  // the pointer is locked. The key handler of the remote gets them instead (menus.js, remote_controller.js). The last
  // key that went to the menu stays away from the PC until it is released, also once it closed the menu, e.g. RETURN
  // or OK on Resume: the auto-repeat of a held key would press it on the PC (OK as Enter, RETURN as Esc through the
  // handler below), and the PC wouldn't get its release, which would leave Enter held there.
  var streamMenuKeyCode = null;
  ['keydown', 'keyup'].forEach(function(eventType) {
    window.addEventListener(eventType, function(e) {
      if (isInGame !== true) {
        streamMenuKeyCode = null;
        return;
      }
      var isMenuKey = isStreamMenuOpen || isMenuKeyEvent(e);
      var isHeldMenuKey = streamMenuKeyCode !== null && e.keyCode === streamMenuKeyCode;
      if (!(isMenuKey || isHeldMenuKey)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keyup') {
        if (isHeldMenuKey) {
          streamMenuKeyCode = null;
        }
      } else if (isMenuKey) {
        streamMenuKeyCode = e.keyCode;
        remoteControllerHandler(e);
      }
    }, true);
  });
  // A key whose release went elsewhere, e.g. while another app had the focus, isn't held any more
  window.addEventListener('blur', function() {
    streamMenuKeyCode = null;
  });

  // Listen for keydown events on the video element
  videoElement.addEventListener('keydown', function(e) {
    // Check if the 'Back' key has been pressed and the streaming is currently active
    if (e.key === 'XF86Back' && isInGame === true) {
      // Send the Escape key (ESC) to the host while streaming
      sendEscapeKeyToHost();
      // Simulate mouse to move focus back to the streaming session. Only while the pointer isn't locked yet,
      // because the stream sends a mouse button press without a release for a click on the locked pointer,
      // which would leave the left mouse button of the host held down.
      if (!document.pointerLockElement) {
        videoElement.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, view: window, clientX: 0, clientY: 0
        }));
      }
    }
  });
}

// Translate an answer of the checks of tv_profile.js ('yes', 'no' or 'unknown') for System information
function describeCheckAnswer(answer) {
  if (answer === 'yes') {
    return t('Yes');
  }
  return answer === 'no' ? t('No') : t('Unknown');
}

// Describe the answers of the decoder check (probeVideoDecoders() in tv_profile.js) as the lines of System information:
// the codecs at the level that streams up to 4K at 60 FPS use, e.g. 'H.264: Yes, HEVC: Yes, HEVC Main10: Yes, AV1: No,
// AV1 Main10: No', and the codecs at level 5.2, which faster 4K streams use. Answers that don't count give one line.
function describeVideoDecoderProbe() {
  if (!videoDecoderProbe.reliable) {
    return [t('Video decoders (MediaSource check): %1$s', videoDecoderProbe.reason === 'unavailable'
      ? t('Unknown (not available)')
      : t('Unknown (the answers of the TV are not reliable)'))];
  }
  const describe = (probes) => probes.map((probe) => probe.codec + ': ' + describeCheckAnswer(videoDecoderProbe.results[probe.mimeType])).join(', ');
  return [
    t('Video decoders (MediaSource check): %1$s', describe(VIDEO_DECODER_PROBES.filter((probe) => probe.level !== '5.2'))),
    t('Video decoders at level 5.2 (4K above 60 FPS): %1$s', describe(VIDEO_DECODER_PROBES.filter((probe) => probe.level === '5.2'))),
  ];
}

// Describe the controller type that the stream announces to the PC for a gamepad (describeGamepad() in gamepad.js), as
// System information shows it: the type that Auto detects from the id of the gamepad, unless the 'Controller type sent
// to the PC' setting overrides it, which then names the detected type as well, like the stream log does (gamepad.cpp),
// e.g. 'PlayStation (setting, detected: Xbox)'
function describeGamepadType(info, controllerTypeSetting) {
  const detectedType = info.type === 'Unknown' ? t('Unknown') : info.type;
  if (controllerTypeSetting && controllerTypeSetting !== 'Auto' && controllerTypeSetting !== info.type) {
    return t('%1$s (setting, detected: %2$s)', controllerTypeSetting, detectedType);
  }
  return detectedType;
}

function loadSystemInfo() {
  console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'Loading system information...');
  const systemInfoPlaceholder = document.getElementById('systemInfoBtn');
  const isForceGMVariant = checkForceGMVariant(); // Check if the currently installed app is the ForceGM variant
  const buildVer = getBuildVersion(appInfo.version);
  // What the app detected about the TV (detectTvCapabilities() in tv_profile.js), which the optimal streaming settings
  // are based on, and the current network connection type
  const connectionType = getActiveConnectionType();
  const panelText = is8kPanel ? '8K' : (is4kPanel ? '4K' : 'Full HD');
  const connectionText = connectionType === 'ethernet' ? 'Ethernet' : (connectionType === 'wifi' ? 'Wi-Fi' : '');
  const testedProfile = tvCapabilities.profile ? tvCapabilities.profile.id : '';
  const modelYearHint = tvCapabilities.modelYearHint;
  // Whether the WASM player offers the Ultra Low Latency mode of the game mode, and what the browser answered about
  // the video codecs of the WASM player (detectWasmPlayerFeatures() and probeVideoDecoders() in tv_profile.js), so a
  // screenshot shows what the TV reports next to what it accepted
  const ultraLowLatencyText = describeCheckAnswer(wasmPlayerFeatures.ultraLowLatency);
  const apiLevelsText = wasmPlayerFeatures.apiLevels && wasmPlayerFeatures.apiLevels.length > 0 ? wasmPlayerFeatures.apiLevels.join(', ') : '';
  const videoDecoderLines = describeVideoDecoderProbe();
  // The connected gamepads (Controller in gamepad.js), so a user can see whether the TV found a controller, whether it
  // has the standard layout that the menus and the stream expect, and which controller type the stream announces
  // (describeGamepadType())
  const connectedGamepads = Controller.getConnectedGamepads();

  // Get the system information from the TV
  if (systemInfoPlaceholder) {
    const controllerTypeSetting = String($('#selectControllerType').data('value') || 'Auto');
    const gamepadsText = connectedGamepads.length === 0 ? t('Gamepads: %1$s', t('None')) : connectedGamepads.map((info) =>
      t('Gamepad %1$s: %2$s (%3$s, %4$s buttons, %5$s axes, rumble: %6$s, type: %7$s)', info.index, info.name ? info.name : t('Unknown'),
        info.mapping === 'standard' ? t('standard layout') : t('non-standard layout'), info.buttons, info.axes,
        info.rumble ? t('Yes') : t('No'), describeGamepadType(info, controllerTypeSetting))
    ).join('\n');
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'App Version: ' + appInfo.name + (isForceGMVariant ? '-ForceGM' : '') + ' v' + buildVer);
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'Platform Version: Tizen ' + (platformVer ? platformVer : 'Unknown'));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'TV Model Series: ' + (modelSeries ? modelSeries : 'Unknown'));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'TV Model Name: ' + (modelName ? modelName : 'Unknown'));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'TV Model Group: ' + (modelGroup ? modelGroup : 'Unknown'));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'Model Year (from the model group): ' + (modelYearHint ? modelYearHint : 'Unknown'));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'Panel: ' + panelText);
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'HDR Support: ' + (isHdrCapable ? 'Yes' : 'No'));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'Network Connection Type: ' + (connectionText ? connectionText : 'Unknown'));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'Tested Profile: ' + (testedProfile ? testedProfile : 'None'));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'WASM Player: ' + JSON.stringify(wasmPlayerFeatures));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'Video Decoders (MediaSource check): ' + videoDecoderProbe.reason + ', answers ' + JSON.stringify(videoDecoderProbe.answers));
    console.log('%c[index.js, loadSystemInfo]', 'color: green;', 'Gamepads: ' + (connectedGamepads.length === 0 ? 'None' : connectedGamepads.map((info) => info.index + ' (' + Controller.formatGamepadInfo(info) + ')').join(', ')) +
      ' (controller type setting: ' + controllerTypeSetting + ')');
    // Insert the system information into the placeholder. The model year is only a hint from the model group, since
    // Samsung sells the models of one year for longer, so it never decides a setting.
    systemInfoPlaceholder.innerText =
      t('App Version: %1$s v%2$s', appInfo.name + (isForceGMVariant ? '-ForceGM' : ''), buildVer) + '\n' +
      t('Platform Version: Tizen %1$s', platformVer ? platformVer : t('Unknown')) + '\n' +
      t('TV Model Series: %1$s', modelSeries ? modelSeries : t('Unknown')) + '\n' +
      t('TV Model Name: %1$s', modelName ? modelName : t('Unknown')) + '\n' +
      t('TV Model Group: %1$s', modelGroup ? modelGroup : t('Unknown')) + '\n' +
      t('Model Year (from the model group): %1$s', modelYearHint ? modelYearHint : t('Unknown')) + '\n' +
      t('Panel: %1$s', panelText) + '\n' +
      t('HDR Support: %1$s', isHdrCapable ? t('Yes') : t('No')) + '\n' +
      t('Network Connection Type: %1$s', connectionText ? connectionText : t('Unknown')) + '\n' +
      t('Tested Profile: %1$s', testedProfile ? testedProfile : t('None')) + '\n' +
      t('Ultra Low Latency mode (Game mode): %1$s', ultraLowLatencyText) + '\n' +
      t('WASM player API levels: %1$s', apiLevelsText ? apiLevelsText : t('Unknown')) + '\n' +
      videoDecoderLines.map((line) => line + '\n').join('') +
      gamepadsText;
  } else {
    // Without its element there is nowhere to show the system information, so only log it
    console.error('%c[index.js, loadSystemInfo]', 'color: green;', 'Error: Failed to load system information, since its element is missing!');
  }
}

function loadUserData() {
  console.log('%c[index.js, loadUserData]', 'color: green;', 'Loading stored user data...');
  openIndexDB(loadUserDataCb);
}

function loadUserDataCb() {
  // Take the one-time settings snapshot of an existing install before any stored setting is loaded
  migrateSettingsSchema(loadStoredSettings);
}

// Bring the stored settings to the current settings schema (SETTINGS_SCHEMA_VERSION in tv_profile.js), then call the
// callback function. Up to settings schema 1, the default of a video setting was worked out again at every start and
// never stored, so a new default in a later build would also change every existing install where the user never
// touched that setting. So an existing install, which created its unique ID at an earlier start, stores the defaults of
// settings schema 1 once for every video setting that is still unset (legacySettingsSnapshot() in tv_profile.js), and
// shows exactly what it showed before. A fresh install only stores the schema version and gets the defaults derived
// for its TV. The unique ID of a fresh install is stored together with the schema version (loadHTTPCertsCb()), and both
// are read here in one transaction, so a fresh install is never mistaken for an existing one, whichever runs first.
function migrateSettingsSchema(callbackFunction) {
  getMultipleData(['uniqueid', SETTINGS_SCHEMA_KEY].concat(LEGACY_SNAPSHOT_KEYS), function(storedValues) {
    if (storedValues === null) {
      // Leave everything as it is when the settings can't be read, and try again at the next start
      console.warn('%c[index.js, migrateSettingsSchema]', 'color: green;', 'Warning: Failed to read the stored settings, so the settings schema stays as it is.');
      callbackFunction();
      return;
    }
    if (storedValues[SETTINGS_SCHEMA_KEY] != null) {
      console.log('%c[index.js, migrateSettingsSchema]', 'color: green;', 'Settings schema: ' + storedValues[SETTINGS_SCHEMA_KEY]);
      callbackFunction();
      return;
    }

    let migratedValues = {};
    if (storedValues.uniqueid != null) {
      migratedValues = legacySettingsSnapshot(storedValues, tvCapabilities, getActiveConnectionType());
      console.log('%c[index.js, migrateSettingsSchema]', 'color: green;', 'Existing install without a settings schema, storing the previous defaults of the unset video settings: ' + JSON.stringify(migratedValues));
    } else {
      console.log('%c[index.js, migrateSettingsSchema]', 'color: green;', 'Fresh install, using the optimal streaming settings for this TV as the defaults.');
    }
    migratedValues[SETTINGS_SCHEMA_KEY] = SETTINGS_SCHEMA_VERSION;
    storeMultipleData(migratedValues, null);
    // Load the settings right away: IndexedDB runs the reading transactions of the loaders only after the writing
    // transaction above, which was created before them on the same store, has finished, so they see the stored values
    callbackFunction();
  });
}

// Load the stored settings into the settings screen. A setting that isn't stored gets its default, which for the video
// settings are the optimal streaming settings for this TV and its network connection (deriveOptimalSettings() in
// tv_profile.js). The settings are requested in this order, and IndexedDB answers in the same order, which some of the
// defaults below rely on (e.g. the codec is loaded before HDR, and the resolution and frame rate before the bitrate).
function loadStoredSettings() {
  const optimalSettings = deriveOptimalSettings(tvCapabilities, getActiveConnectionType());

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored resolution preferences.');
  getData('resolution', function(previousValue) {
    if (previousValue.resolution != null) {
      var resWidth = parseInt(previousValue.resolution.split(':')[0], 10);
      if (resWidth > maxSupportedWidth) {
        previousValue.resolution = maxSupportedWidth >= 3840 ? '3840:2160' : '1920:1080';
        storeData('resolution', previousValue.resolution, null);
      }
      $('.videoResolutionMenu li').each(function() {
        if ($(this).data('value') === previousValue.resolution) {
          // Update the video resolution field based on the given value
          $('#selectResolution').text($(this).text()).attr('data-value', previousValue.resolution).data('value', previousValue.resolution);
        }
      });
    } else {
      // Set the default state to the highest resolution of the panel, up to 4K
      const optimalResolution = optimalSettings.resolution;
      const optimalResolutionItem = $('.videoResolutionMenu li[data-value="' + optimalResolution + '"]');
      $('#selectResolution').text(optimalResolutionItem.text()).attr('data-value', optimalResolution).data('value', optimalResolution);
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored unlockAllFps preferences.');
  getData('unlockAllFps', function(previousValue) {
    if (previousValue.unlockAllFps == null) {
      // Set the default state, which unlocks the higher frame rates only for a tested model whose panel shows them
      if (optimalSettings.unlockAllFps) {
        document.querySelector('#unlockAllFpsBtn').MaterialSwitch.on();
      } else {
        document.querySelector('#unlockAllFpsBtn').MaterialSwitch.off();
      }
    } else if (previousValue.unlockAllFps == false) {
      document.querySelector('#unlockAllFpsBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#unlockAllFpsBtn').MaterialSwitch.on();
    }
    // Handle the Unlocked FPS visibility based on switch state
    handleUnlockAllFps();
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored frameRate preferences.');
  getData('frameRate', function(previousValue) {
    // Set the default state to the optimal frame rate (60 FPS), which every frame rate menu offers
    const frameRate = previousValue.frameRate != null ? previousValue.frameRate : optimalSettings.frameRate;
    $('.videoFramerateMenu li').each(function() {
      if ($(this).data('value') === frameRate) {
        // Update the video frame rate field based on the given value
        $('#selectFramerate').text($(this).text()).attr('data-value', frameRate).data('value', frameRate);
      }
    });
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored bitrate preferences.');
  getData('bitrate', function(previousValue) {
    // Set the default state to the recommended bitrate for the resolution and frame rate loaded above and the network
    // connection of the TV, which is the optimal bitrate on a fresh install
    const defaultBitrate = recommendedBitrate(String($('#selectResolution').data('value')), $('#selectFramerate').data('value'), getActiveConnectionType(), tvCapabilities);
    $('#bitrateSlider')[0].MaterialSlider.change(previousValue.bitrate != null ? previousValue.bitrate : String(defaultBitrate));
    // Update the video bitrate field based on the given value
    $('#selectBitrate').html($('#bitrateSlider').val() + ' Mbps');
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored framePacing preferences.');
  getData('framePacing', function(previousValue) {
    if (previousValue.framePacing == null) {
      // Set the default state, which is on
      optimalSettings.framePacing ? document.querySelector('#framePacingBtn').MaterialSwitch.on() : document.querySelector('#framePacingBtn').MaterialSwitch.off();
    } else if (previousValue.framePacing == false) {
      document.querySelector('#framePacingBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#framePacingBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored ipAddressFieldMode preferences.');
  getData('ipAddressFieldMode', function(previousValue) {
    if (previousValue.ipAddressFieldMode == null) {
      document.querySelector('#ipAddressFieldModeBtn').MaterialSwitch.on(); // Set the default state
    } else if (previousValue.ipAddressFieldMode == false) {
      document.querySelector('#ipAddressFieldModeBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#ipAddressFieldModeBtn').MaterialSwitch.on();
    }
    // Handle the IP address field visibility based on switch state
    handleIpAddressFieldMode();
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored sortAppsList preferences.');
  getData('sortAppsList', function(previousValue) {
    if (previousValue.sortAppsList == null) {
      document.querySelector('#sortAppsListBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.sortAppsList == false) {
      document.querySelector('#sortAppsListBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#sortAppsListBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored optimizeGames preferences.');
  getData('optimizeGames', function(previousValue) {
    if (previousValue.optimizeGames == null) {
      document.querySelector('#optimizeGamesBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.optimizeGames == false) {
      document.querySelector('#optimizeGamesBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#optimizeGamesBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored rumbleFeedback preferences.');
  getData('rumbleFeedback', function(previousValue) {
    if (previousValue.rumbleFeedback == null) {
      document.querySelector('#rumbleFeedbackBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.rumbleFeedback == false) {
      document.querySelector('#rumbleFeedbackBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#rumbleFeedbackBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored mouseEmulation preferences.');
  getData('mouseEmulation', function(previousValue) {
    if (previousValue.mouseEmulation == null) {
      document.querySelector('#mouseEmulationBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.mouseEmulation == false) {
      document.querySelector('#mouseEmulationBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#mouseEmulationBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored flipABfaceButtons preferences.');
  getData('flipABfaceButtons', function(previousValue) {
    if (previousValue.flipABfaceButtons == null) {
      document.querySelector('#flipABfaceButtonsBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.flipABfaceButtons == false) {
      document.querySelector('#flipABfaceButtonsBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#flipABfaceButtonsBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored flipXYfaceButtons preferences.');
  getData('flipXYfaceButtons', function(previousValue) {
    if (previousValue.flipXYfaceButtons == null) {
      document.querySelector('#flipXYfaceButtonsBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.flipXYfaceButtons == false) {
      document.querySelector('#flipXYfaceButtonsBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#flipXYfaceButtonsBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored controllerType preferences.');
  getData('controllerType', function(previousValue) {
    // Without a stored value (also one that can't be read), the menu keeps Auto
    if (previousValue.controllerType != null) {
      $('.controllerTypeMenu li').each(function() {
        if ($(this).data('value') === previousValue.controllerType) {
          // Update the controller type field based on the given value
          $('#selectControllerType').text($(this).text()).attr('data-value', previousValue.controllerType).data('value', previousValue.controllerType);
        }
      });
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored audioBackend preferences.');
  getData('audioBackend', function(previousValue) {
    if (previousValue.audioBackend != null) {
      $('.audioBackendMenu li').each(function() {
        if ($(this).data('value') === previousValue.audioBackend) {
          // Update the audio backend field based on the given value
          $('#selectAudioBackend').text($(this).text()).attr('data-value', previousValue.audioBackend).data('value', previousValue.audioBackend);
        }
      });
    }
    // Show the settings of the stored audio backend
    updateAudioBackendSettings();
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored audioConfig preferences.');
  getData('audioConfig', function(previousValue) {
    if (previousValue.audioConfig != null) {
      $('.audioConfigMenu li').each(function() {
        if ($(this).data('value') === previousValue.audioConfig) {
          // Update the audio configuration field based on the given value
          $('#selectAudio').text($(this).text()).attr('data-value', previousValue.audioConfig).data('value', previousValue.audioConfig);
        }
      });
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored audioSync preferences.');
  getData('audioSync', function(previousValue) {
    if (previousValue.audioSync == null) {
      document.querySelector('#audioSyncBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.audioSync == false) {
      document.querySelector('#audioSyncBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#audioSyncBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored audioJitter preferences.');
  getData('audioJitter', function(previousValue) {
    $('#jitterSlider')[0].MaterialSlider.change(previousValue.audioJitter != null ? previousValue.audioJitter : '100');
    // Update the audio jitter buffer field based on the given value
    $('#selectAudioJitter').html($('#jitterSlider').val() + ' ms');
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored audioClockSync preferences.');
  getData('audioClockSync', function(previousValue) {
    if (previousValue.audioClockSync == null) {
      document.querySelector('#audioClockSyncBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.audioClockSync == false) {
      document.querySelector('#audioClockSyncBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#audioClockSyncBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored playHostAudio preferences.');
  getData('playHostAudio', function(previousValue) {
    if (previousValue.playHostAudio == null) {
      document.querySelector('#playHostAudioBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.playHostAudio == false) {
      document.querySelector('#playHostAudioBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#playHostAudioBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored decryptHostAudio preferences.');
  getData('decryptHostAudio', function(previousValue) {
    if (previousValue.decryptHostAudio == null) {
      document.querySelector('#decryptHostAudioBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.decryptHostAudio == false) {
      document.querySelector('#decryptHostAudioBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#decryptHostAudioBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored videoCodec preferences.');
  getData('videoCodec', function(previousValue) {
    if (previousValue.videoCodec != null) {
      $('.videoCodecMenu li').each(function() {
        if ($(this).data('value') === previousValue.videoCodec) {
          // Update the video codec field based on the given value, without the note that the menu entry may have
          $('#selectCodec').text(getMenuItemLabel(this)).attr('data-value', previousValue.videoCodec).data('value', previousValue.videoCodec);
        }
      });
    } else {
      // Set the default state to HEVC, because Samsung TVs generally decode H.264 only up to 1080p
      $('#selectCodec').text($('#hevc').text()).attr('data-value', optimalSettings.videoCodec).data('value', optimalSettings.videoCodec);
    }
    // Warn when a previously stored H.264 codec meets the 4K default of the resolution, which is restored before the codec
    warnH264Resolution();
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored hdrMode preferences.');
  getData('hdrMode', function(previousValue) {
    if (previousValue.hdrMode == null) {
      // Set the default state to HDR on HDR-capable TVs, matching the optimal streaming settings, unless the stored
      // codec is H.264, which has no HDR profile (the codec is restored before this, see the request order above)
      if (optimalSettings.hdrMode && $('#selectCodec').data('value') !== 'H264') {
        document.querySelector('#hdrModeBtn').MaterialSwitch.on();
      } else {
        document.querySelector('#hdrModeBtn').MaterialSwitch.off();
      }
    } else if (previousValue.hdrMode == false) {
      document.querySelector('#hdrModeBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#hdrModeBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored fullRange preferences.');
  getData('fullRange', function(previousValue) {
    if (previousValue.fullRange == null) {
      // Set the default state, which is the limited color range
      optimalSettings.fullRange ? document.querySelector('#fullRangeBtn').MaterialSwitch.on() : document.querySelector('#fullRangeBtn').MaterialSwitch.off();
    } else if (previousValue.fullRange == false) {
      document.querySelector('#fullRangeBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#fullRangeBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored gameMode preferences.');
  getData('gameMode', function(previousValue) {
    if (isGameModeUnavailable(tvCapabilities)) {
      // The WASM player says that it doesn't offer the Ultra Low Latency mode, so the stream uses the Low Latency mode
      // anyway: keep the switch off and disabled whatever is stored, and keep the stored value (see
      // detectWasmPlayerFeatures() in tv_profile.js)
      document.querySelector('#gameModeBtn').MaterialSwitch.off();
      document.querySelector('#gameModeBtn').MaterialSwitch.disable();
    } else if (previousValue.gameMode == null) {
      // Set the default state based on the Tizen platform version and the WASM player (see getGameModeDefault() in
      // tv_profile.js)
      if (optimalSettings.gameMode === false) {
        document.querySelector('#gameModeBtn').MaterialSwitch.off(); // Turn off for Tizen 9.0 and newer to avoid compatibility issues, and for Tizen 5.5 with a WASM player that offers the mode
      } else if (optimalSettings.gameMode === null) {
        document.querySelector('#gameModeBtn').MaterialSwitch.off(); // Turn off for Tizen 5.5 due to lack of support
        document.querySelector('#gameModeBtn').MaterialSwitch.disable(); // Disable the switch to prevent user interaction
      } else {
        document.querySelector('#gameModeBtn').MaterialSwitch.on(); // Turn on for compatible Tizen versions (e.g., 6.0, 6.5, 7.0, 8.0)
      }
    } else if (previousValue.gameMode == false) {
      document.querySelector('#gameModeBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#gameModeBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored refFrameInvalidation preferences.');
  getData('refFrameInvalidation', function(previousValue) {
    if (previousValue.refFrameInvalidation == null) {
      document.querySelector('#refFrameInvalidationBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.refFrameInvalidation == false) {
      document.querySelector('#refFrameInvalidationBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#refFrameInvalidationBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored hdrMetadata preferences.');
  getData('hdrMetadata', function(previousValue) {
    if (previousValue.hdrMetadata == null) {
      document.querySelector('#hdrMetadataBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.hdrMetadata == false) {
      document.querySelector('#hdrMetadataBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#hdrMetadataBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored optimizeBitrate preferences.');
  getData('optimizeBitrate', function(previousValue) {
    if (previousValue.optimizeBitrate == null) {
      // Set the default state, which uses the standard bitrate presets
      optimalSettings.optimizeBitrate ? document.querySelector('#optimizeBitrateBtn').MaterialSwitch.on() : document.querySelector('#optimizeBitrateBtn').MaterialSwitch.off();
    } else if (previousValue.optimizeBitrate == false) {
      document.querySelector('#optimizeBitrateBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#optimizeBitrateBtn').MaterialSwitch.on();
    }
    const storedOptimizeBitrate = previousValue.optimizeBitrate == true;
    // Load whether the bitrate presets follow the video settings
    getData('autoAdjustBitrate', function(storedValue, isPresetStateReadFailed) {
      if (storedValue.autoAdjustBitrate != null) {
        autoAdjustBitrate = storedValue.autoAdjustBitrate == true;
        console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Auto adjust bitrate state: ' + autoAdjustBitrate);
        return;
      }
      // Without a stored value, decide once whether the bitrate presets follow the video settings. A fresh install has
      // no stored bitrate, so its recommended bitrate follows the resolution and frame rate until the user picks one by
      // hand. Otherwise (an update from a version without this setting, whose settings snapshot already stores the
      // decision, so this only remains as a fallback) the presets keep following the settings if the stored bitrate
      // came from them (followsBitratePresets() in tv_profile.js), and a bitrate that was picked by hand or set by the
      // optimal streaming settings is kept.
      getData('bitrate', function(storedBitrate, isBitrateReadFailed) {
        getData('resolution', function(storedResolution, isResolutionReadFailed) {
          getData('frameRate', function(storedFramerate, isFramerateReadFailed) {
            // When one of the values can't be read, keep the bitrate for this start and decide again at the next one,
            // instead of storing a decision that a read error made, which could replace a stored preset state
            if (isPresetStateReadFailed || isBitrateReadFailed || isResolutionReadFailed || isFramerateReadFailed) {
              autoAdjustBitrate = false;
              console.warn('%c[index.js, loadUserDataCb]', 'color: green;', 'Warning: Auto adjust bitrate state not decided, since a stored value could not be read: ' + autoAdjustBitrate);
              return;
            }
            var followsPresets = storedBitrate.bitrate == null || followsBitratePresets({
              bitrate: storedBitrate.bitrate,
              resolution: storedResolution.resolution,
              frameRate: storedFramerate.frameRate,
              optimizeBitrate: storedOptimizeBitrate,
            }, getActiveConnectionType());
            autoAdjustBitrate = followsPresets;
            storeData('autoAdjustBitrate', autoAdjustBitrate, null);
            console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Auto adjust bitrate state (first decision): ' + autoAdjustBitrate);
          });
        });
      });
    });
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored disableWarnings preferences.');
  getData('disableWarnings', function(previousValue) {
    if (previousValue.disableWarnings == null) {
      document.querySelector('#disableWarningsBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.disableWarnings == false) {
      document.querySelector('#disableWarningsBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#disableWarningsBtn').MaterialSwitch.on();
    }
  });

  console.log('%c[index.js, loadUserDataCb]', 'color: green;', 'Load stored performanceStats preferences.');
  getData('performanceStats', function(previousValue) {
    if (previousValue.performanceStats == null) {
      document.querySelector('#performanceStatsBtn').MaterialSwitch.off(); // Set the default state
    } else if (previousValue.performanceStats == false) {
      document.querySelector('#performanceStatsBtn').MaterialSwitch.off();
    } else {
      document.querySelector('#performanceStatsBtn').MaterialSwitch.on();
    }
  });
}

function loadHTTPCerts() {
  console.log('%c[index.js, loadHTTPCerts]', 'color: green;', 'Loading stored HTTP certificates...');
  openIndexDB(loadHTTPCertsCb);
}

function loadHTTPCertsCb() {
  console.log('%c[index.js, loadHTTPCertsCb]', 'color: green;', 'Load the HTTP certificate and unique ID if they are already available.');
  getData('cert', function(savedCert, isCertReadFailed) {
    if (savedCert.cert != null) { // We have a saved cert
      pairingCert = savedCert.cert;
    }

    getData('uniqueid', function(savedUniqueid, isUniqueidReadFailed) {
      // A certificate or unique ID that can't be read may still be stored, so it must not be replaced: a new certificate
      // would end the pairing with every host, and a new unique ID would make an existing install look like a fresh one
      // to the settings snapshot. So leave both as they are, stay on the loading screen, and read them again at the next
      // start.
      if (isCertReadFailed || isUniqueidReadFailed) {
        console.error('%c[index.js, loadHTTPCertsCb]', 'color: green;', 'Error: Failed to read the stored ' + (isCertReadFailed ? 'certificate' : 'unique ID') + ', so nothing is replaced and the app has to be restarted!');
        $('#wasmSpinnerMessage').text(t('Unable to read the stored pairing data. Please restart Moonlight.'));
        return;
      }

      if (savedUniqueid && savedUniqueid.uniqueid != null) { // We have a saved uniqueid
        myUniqueid = savedUniqueid.uniqueid;
      } else {
        myUniqueid = uniqueid();
        // A new unique ID marks a fresh install, so store the current settings schema in the same transaction. The
        // settings snapshot (migrateSettingsSchema()) reads both together, so it never takes this install for an
        // existing one, even if this runs before it.
        const freshInstallData = { uniqueid: myUniqueid };
        freshInstallData[SETTINGS_SCHEMA_KEY] = SETTINGS_SCHEMA_VERSION;
        storeMultipleData(freshInstallData, null);
      }

      if (!pairingCert) { // We couldn't load a cert. Let's attempt to generate a new one.
        console.warn('%c[index.js, loadHTTPCertsCb]', 'color: green;', 'Warning: Local certificate not found! Generating a new one...');
        sendMessage('makeCert', []).then(function(cert) {
          storeData('cert', cert, null);
          pairingCert = cert;
          console.info('%c[index.js, loadHTTPCertsCb]', 'color: green;', 'Generated new certificate: ', cert);
        }, function(failedCert) {
          console.error('%c[index.js, loadHTTPCertsCb]', 'color: green;', 'Error: Failed to generate a new certificate! Returned error was: \n', failedCert + '!');
        }).then(function(ret) {
          sendMessage('httpInit', [pairingCert.cert, pairingCert.privateKey, myUniqueid]).then(function(ret) {
            restoreUiAfterWasmLoad();
          }, function(failedInit) {
            console.error('%c[index.js, loadHTTPCertsCb]', 'color: green;', 'Error: Failed HTTP initialization! Returned error was: ', failedInit + '!');
          });
        });
      } else {
        sendMessage('httpInit', [pairingCert.cert, pairingCert.privateKey, myUniqueid]).then(function(ret) {
          restoreUiAfterWasmLoad();
        }, function(failedInit) {
          console.error('%c[index.js, loadHTTPCertsCb]', 'color: green;', 'Error: Failed HTTP initialization! Returned error was: ', failedInit + '!');
        });
      }

      // load previously connected hosts, which have been killed into an object, and revive them back into a class
      getData('hosts', function(previousValue) {
        hosts = previousValue.hosts != null ? previousValue.hosts : {};
        for (var hostUID in hosts) { // Programmatically add each new host
          var revivedHost = new NvHTTP(hosts[hostUID].address, myUniqueid, hosts[hostUID].userEnteredAddress, hosts[hostUID].macAddress);
          Object.assign(revivedHost, hosts[hostUID]);
          revivedHost._memCachedApplist = null; // Prevent using the app list cache from a previous session
          revivedHost.httpPort = hosts[hostUID].httpPort || ((hosts[hostUID].httpsPort || 47984) + 5);
          revivedHost.httpsPort = hosts[hostUID].httpsPort || (revivedHost.httpPort - 5);
          revivedHost.externalPort = hosts[hostUID].externalPort || revivedHost.httpPort;
          revivedHost.serverUid = hosts[hostUID].serverUid;
          revivedHost.externalIP = hosts[hostUID].externalIP;
          revivedHost.hostname = hosts[hostUID].hostname;
          revivedHost.ppkstr = hosts[hostUID].ppkstr;
          revivedHost.autoWolEnabled = hosts[hostUID].autoWolEnabled || false;
          hosts[hostUID] = revivedHost;
          addHostToGrid(revivedHost);
        }
        isHostsLoaded = true;
        // Load stored preview app lists and update Smart Hub Preview tiles.
        // Using the persisted list avoids requiring live host connections at startup.
        getData('previewApps', function(storedPreview) {
          _previewApps = (storedPreview.previewApps != null) ? storedPreview.previewApps : {};
          normalizePreviewImageUris(_previewApps);
          updatePreviewData();
        });
        console.log('%c[index.js, loadHTTPCertsCb]', 'color: green;', 'Loading previously connected hosts...');
        discoverHostsAtStartup();
      });
    });
  });
}

// Poll the known hosts and then scan the local network for new ones, once the stored hosts are loaded at startup.
// Returns a promise that resolves once the scan is done and the polling resumed.
function discoverHostsAtStartup() {
  // Immediately start polling known hosts so they are ready for Smart Hub or instant clicks.
  // We wait for all known hosts to finish their initial ping before launching the subnet scanner
  // to guarantee that the 254 scanner requests don't choke the network stack and cause known hosts to timeout.
  return startPollingHosts().then(() => {
    if (typeof startSubnetScanner === 'function') {
      snackbarLog('Scanning the local network to discover new hosts...');
      // Stop background polling while sweeping the subnet to prevent network exhaustion
      stopPollingHosts();
      return startSubnetScanner().then(() => {
        isSubnetScanFinished = true;
        startPollingHosts();
      }).catch(() => {
        isSubnetScanFinished = true;
        startPollingHosts();
      });
    } else {
      isSubnetScanFinished = true;
    }
  });
}

// Point the stored Smart Hub tiles at the box art server of this build, since tiles saved by an earlier build still
// use the port of the regular Moonlight app (8888), whose server then answers for them or nothing does
function normalizePreviewImageUris(previewApps) {
  Object.keys(previewApps).forEach(function(serverUid) {
    var entry = previewApps[serverUid];
    (entry && entry.apps || []).forEach(function(app) {
      if (typeof app.imageUri === 'string') {
        app.imageUri = app.imageUri.replace(/:\d+\/preview-/, ':' + SMART_HUB_PREVIEW_PORT + '/preview-');
      }
    });
  });
}

// Navigates to a specific host once it has been loaded and becomes available.
// Polls the hosts object at 1-second intervals for up to 30 seconds.
function waitForHostAndNavigate(serverUid) {
  var attempts = 0;
  var interval = setInterval(function() {
    attempts++;
    var host = hosts[serverUid];
    
    if (host && (host.online || isSubnetScanFinished)) {
      clearInterval(interval);
      console.log('%c[index.js, waitForHostAndNavigate]', 'color: green;', 'Host found for deep link, navigating: ' + serverUid);
      hostChosen(host);
    } else if (!host && isHostsLoaded) {
      clearInterval(interval);
      console.warn('%c[index.js, waitForHostAndNavigate]', 'color: orange;', 'Host ' + serverUid + ' no longer exists in Moonlight.');
      snackbarLogLong('The selected host is no longer available on Moonlight.');
      if (typeof updatePreviewData === 'function') updatePreviewData();
    } else if (attempts > 30) {
      clearInterval(interval);
      console.warn('%c[index.js, waitForHostAndNavigate]', 'color: orange;', 'Warning: Timed out waiting for host ' + serverUid + ' to load.');
      if (host) hostChosen(host); // Fallback to trigger offline error or Auto WOL
    }
  }, 1000);
}

// Navigates to a specific app on a host from a Smart Hub Preview deep link.
// Waits for the host to load, then checks availability and whether the app still exists.
// - If the host is offline: removes it from preview and returns to the Moonlight home screen.
// - If the app no longer exists on the server: connects to the host and shows the current app list.
// - If the app exists: connects to the host and navigates directly to the app list.
function waitForHostAndNavigateToApp(serverUid, appId) {
  var attempts = 0;
  var interval = setInterval(function() {
    attempts++;
    var host = hosts[serverUid];

    if (host && (host.online || isSubnetScanFinished)) {
      clearInterval(interval);
      console.log('%c[index.js, waitForHostAndNavigateToApp]', 'color: green;', 'Host found for deep link, checking availability: ' + serverUid);

      // Check whether the host is online before trying to connect
      if (!host.online) {
        hostChosen(host, function() {
          // Success callback: The host is now online. Retry the deep link navigation.
          waitForHostAndNavigateToApp(serverUid, appId);
        });
        return;
      }

      // Host is online: check whether the requested app still exists
      host.getAppListWithCacheFlush().then(function(appList) {
        // Find the existing switch element
        const sortAppsListSwitch = document.getElementById('sortAppsListSwitch');
        // Defines the sort order based on the state of the switch
        const sortOrder = sortAppsListSwitch.checked ? 'DESC' : 'ASC';
        // If game grid is populated, sort the app list
        const sortedAppList = sortTitles(appList, sortOrder);

        if (_isSmartHubSupported) {
          // Preserve existing image paths from the previous preview cache
          var oldApps = (_previewApps[serverUid] && _previewApps[serverUid].apps) || [];

          // Update the preview with the latest app list from this successful connection
          _previewApps[serverUid] = {
            hostname: host.hostname,
            address: host.address,
            apps: sortedAppList.map(function(app) {
              var oldApp = oldApps.find(function(a) {
                return a.id === app.id; 
              });
              var newApp = {
                id: app.id, title: app.title
              };
              if (oldApp) {
                if (oldApp.imageUri) {
                  newApp.imageUri = oldApp.imageUri;
                }
                if (oldApp.txtPath) {
                  newApp.txtPath = oldApp.txtPath;
                }
              }
              return newApp;
            })
          };
          savePreviewApps();
          updatePreviewData();
        }

        var appExists = appList.some(function(app) {
          return app.id === appId;
        });
        if (appExists) {
          // App still exists: connect, show the app list, and auto-launch the app
          console.log('%c[index.js, waitForHostAndNavigateToApp]', 'color: green;', 'App ' + appId + ' found, launching app from deep link.');
          hostChosen(host);
          // Wait for the app list to render, then scroll to the app and launch it automatically.
          // This ensures the app list is in the navigation stack so Back returns correctly:
          // streaming session → app list → Moonlight home screen.
          var gameStartAttempts = 0;
          var gameStartInterval = setInterval(function() {
            gameStartAttempts++;
            var gameContainer = document.getElementById('game-container-' + appId);
            if (isInGame) {
              // A stream started in the meantime
              clearInterval(gameStartInterval);
            } else if (gameContainer) {
              clearInterval(gameStartInterval);
              gameContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
              startGame(host, appId);
            } else if (gameStartAttempts > 30) {
              clearInterval(gameStartInterval);
              console.warn('%c[index.js, waitForHostAndNavigateToApp]', 'color: orange;', 'Warning: Timed out waiting for game container for app ' + appId + ' to appear.');
            }
          }, 200);
        } else {
          // App no longer exists: connect to host and show the current app list
          console.warn('%c[index.js, waitForHostAndNavigateToApp]', 'color: orange;', 'App ' + appId + ' not found on host, showing current app list.');
          snackbarLogLong('The selected app is no longer available on this host. Showing the current app list.');
          hostChosen(host);
        }
      }, function() {
        // Could not fetch app list (host may have gone offline during the check)
        hostChosen(host);
      });
    } else if (!host && isHostsLoaded) {
      clearInterval(interval);
      console.warn('%c[index.js, waitForHostAndNavigateToApp]', 'color: orange;', 'Host ' + serverUid + ' no longer exists in Moonlight.');
      snackbarLogLong('The selected host is no longer available on Moonlight.');
      if (typeof updatePreviewData === 'function') updatePreviewData();
    } else if (attempts > 30) { // 30s timeout
      clearInterval(interval);
      console.warn('%c[index.js, waitForHostAndNavigateToApp]', 'color: orange;', 'Warning: Timed out waiting for host ' + serverUid + ' to load.');
      if (host) hostChosen(host); // Fallback to trigger offline error or Auto WOL
    }
  }, 1000);
}

// Handles deep link navigation when the app is launched from a Smart Hub Preview tile.
// Reads the PAYLOAD from AppControl data and navigates to the appropriate host and app.
function handleDeepLink() {
  if (!_isSmartHubSupported) {
    return;
  }
  try {
    var reqAppControl = tizen.application.getCurrentApplication().getRequestedAppControl();
    if (!reqAppControl) {
      console.warn('%c[index.js, handleDeepLink]', 'color: green;', 'Warning: No requested app control found, skipping deep link handling!');
      return;
    }

    var appControlData = reqAppControl.appControl.data;
    console.log('%c[index.js, handleDeepLink]', 'color: green;', 'App control data: ' + JSON.stringify(appControlData));

    for (var i = 0; i < appControlData.length; i++) {
      if (appControlData[i].key === 'PAYLOAD') {
        var payload = JSON.parse(appControlData[i].value[0]);
        var actionData = JSON.parse(payload.values);
        console.log('%c[index.js, handleDeepLink]', 'color: green;', 'Deep link action data: ', actionData);

        // Ignore the deep link while a stream is starting or running, which would otherwise start a second session
        // on top of it. Only a tile of a different app gets a hint, since the running one is already on screen.
        if (isInGame) {
          console.warn('%c[index.js, handleDeepLink]', 'color: green;', 'Warning: Ignoring the deep link while a stream is active.');
          var streamServerUid = streamLaunchHost ? streamLaunchHost.serverUid : null;
          var isOtherApp = actionData.serverUid !== streamServerUid ||
            (actionData.appId !== null && actionData.appId !== undefined && String(actionData.appId) !== String(localStorage.getItem('lastOpenedApp_' + streamServerUid)));
          if (isOtherApp) {
            snackbarLogLong('Stop the current stream first (RED button).');
          }
          break;
        }

        if (actionData.serverUid && actionData.appId !== null && actionData.appId !== undefined) {
          // App-level deep link from a preview tile: navigate to the specific host and app
          waitForHostAndNavigateToApp(actionData.serverUid, actionData.appId);
        } else if (actionData.serverUid) {
          // Host-level deep link: navigate to the host's app list
          waitForHostAndNavigate(actionData.serverUid);
        }
        break;
      }
    }
  } catch (e) {
    console.error('%c[index.js, handleDeepLink]', 'color: green;', 'Error: No deep link or error processing it: ' + e.message);
  }
}

// Builds Smart Hub Preview tiles from the cached per-host app lists and sends the
// preview data to the background service, which calls webapis.preview.setPreviewData().
// The webapis.preview API is only accessible from within a Tizen background service.
// The preview is populated only from successfully connected hosts (stored in _previewApps).
function updatePreviewData() {
  try {
    var packageId = tizen.application.getCurrentApplication().appInfo.packageId;
    if (!_isSmartHubSupported) {
      console.log('%c[index.js, updatePreviewData]', 'color: green;', 'Smart Hub Preview is not supported on this device. Skipping!');
      return;
    }

    // Build one section per host that has a cached app list
    // Smart Hub supports a maximum of 40 tiles across all sections
    var sections = [];
    var totalTiles = 0;
    var SMART_HUB_MAX_TILES = 40;
    Object.keys(_previewApps).forEach(function(serverUid) {
      var entry = _previewApps[serverUid];
      if (!entry || !entry.apps || entry.apps.length === 0) {
        console.error('%c[index.js, updatePreviewData]', 'color: green;', 'Error: No apps found for host ' + serverUid);
        return;
      }

      // Stop adding sections once the Smart Hub tile limit is reached
      if (totalTiles >= SMART_HUB_MAX_TILES) {
        return;
      }

      // Only include as many apps as can fit within the remaining tile limit, without the apps that the user hid (menus.js)
      var remainingTiles = SMART_HUB_MAX_TILES - totalTiles;
      var hiddenApps = loadHiddenApps(serverUid);
      var apps = entry.apps.filter(function(app) {
        return !isAppHidden(hiddenApps, app);
      }).slice(0, remainingTiles);

      // Create a tile for each app in the host's app list, including the title, subtitle, and action data
      var tiles = apps.map(function(app, index) {
        // Each tile object accepts a `position` attribute. By explicitly setting
        // the global position, we override the native behavior and enforce our
        // custom sorting (A-Z or Z-A).
        var tile = {
          title: app.title,
          subtitle: entry.hostname,
          action_data: JSON.stringify({
            serverUid: serverUid, address: entry.address, appId: app.id
          }),
          is_playable: true,
          position: totalTiles + index
        };
        if (app.imageUri) {
          tile.image_url = app.imageUri;
        }
        if (app.txtPath) {
          tile.txtPath = app.txtPath;
        }
        return tile;
      });

      // Update the total tile count after adding this host's tiles
      totalTiles += tiles.length;

      // Only add the section if it contains tiles
      if (tiles.length > 0) {
        sections.push({
          title: entry.hostname, tiles: tiles
        });
      }
    });

    if (sections.length === 0) {
      console.log('%c[index.js, updatePreviewData]', 'color: green;', 'No preview app data found, clearing Smart Hub Preview.');
    }

    var previewData = {
      sections: sections
    };
    var serviceId = packageId + '.service';

    console.log('%c[index.js, updatePreviewData]', 'color: green;', 'Launching Smart Hub service with preview data: ', previewData);

    // Set up local message port to receive responses from the service
    if (_smartHubLocalMessagePort && _smartHubMessagePortListener !== null) {
      try {
        _smartHubLocalMessagePort.removeMessagePortListener(_smartHubMessagePortListener);
      } catch (e) {
        // Ignore listener removal errors
        console.error('%c[index.js, updatePreviewData]', 'color: green;', 'Error removing previous Smart Hub message port listener: ' + e.message);
      }
    }
    _smartHubLocalMessagePort = tizen.messageport.requestLocalMessagePort(packageId);
    _smartHubMessagePortListener = _smartHubLocalMessagePort.addMessagePortListener(function(uiData) {
      console.log('%c[index.js, updatePreviewData]', 'color: green;', 'Received from Smart Hub service: ' + uiData[0].value);
      if (uiData[0].value === 'Service stopping...' || uiData[0].value === 'Service exiting...') {
        try {
          _smartHubLocalMessagePort.removeMessagePortListener(_smartHubMessagePortListener);
          _smartHubMessagePortListener = null;
        } catch (e) {
          // Ignore listener removal errors
          console.error('%c[index.js, updatePreviewData]', 'color: green;', 'Error removing Smart Hub message port listener: ' + e.message);
        }
      }
    });

    // Launch the background service with the preview data via AppControl
    tizen.application.launchAppControl(
      new tizen.ApplicationControl(
        'http://tizen.org/appcontrol/operation/pick', null, 'image/jpeg', null,
        [new tizen.ApplicationControlData('Preview', [JSON.stringify(previewData)])]
      ),
      serviceId, function() {
        console.log('%c[index.js, updatePreviewData]', 'color: green;', 'Preview data sent to service: ' + serviceId);
      }, function(err) {
        console.error('%c[index.js, updatePreviewData]', 'color: green;', 'Failed to launch Smart Hub service: ' + err.message);
      }
    );
  } catch (e) {
    console.error('%c[index.js, updatePreviewData]', 'color: green;', 'Error while updating Smart Hub preview data: ' + e.message);
  }
}

function probeSmartHubSupport() {
  return new Promise(function(resolve) {
    // Check localStorage cache first
    var cached = localStorage.getItem('smartHubSupported');
    if (cached !== null) {
      _isSmartHubSupported = cached === 'true';
      console.log('%c[index.js, probeSmartHubSupport]', 'color: green;', 'Smart Hub support (cached): ' + _isSmartHubSupported);
      resolve();
      return;
    }

    // First launch: probe the service
    var packageId = tizen.application.getCurrentApplication().appInfo.packageId;
    var serviceId = packageId + '.service';
    
    try {
      var probePort = tizen.messageport.requestLocalMessagePort(packageId);
      var probeListener = probePort.addMessagePortListener(function(data) {
        var key = data[0].key;
        if (key !== 'PROBE') {
          return;
        }
        
        var value = data[0].value;
        _isSmartHubSupported = (value === 'SMART_HUB_SUPPORTED');
        localStorage.setItem('smartHubSupported', String(_isSmartHubSupported));
        console.log('%c[index.js, probeSmartHubSupport]', 'color: green;', 'Smart Hub support (probed): ' + _isSmartHubSupported);
        try {
          probePort.removeMessagePortListener(probeListener);
        } catch(e) {
          console.error('%c[index.js, probeSmartHubSupport]', 'color: green;', 'Error removing Smart Hub probe listener: ' + e.message);
        }
        resolve();
      });

      // Launch service with Probe request
      tizen.application.launchAppControl(
        new tizen.ApplicationControl(
          'http://tizen.org/appcontrol/operation/pick', null, null, null,
          [new tizen.ApplicationControlData('Probe', ['check'])]
        ),
        serviceId, function() {
          console.log('%c[index.js, probeSmartHubSupport]', 'color: green;', 'Probe sent to service.');
        }, function(err) {
          // Service launch failed — assume not supported
          console.warn('%c[index.js, probeSmartHubSupport]', 'color: green;', 'Probe failed: ' + err.message);
          _isSmartHubSupported = false;
          localStorage.setItem('smartHubSupported', 'false');
          resolve();
        }
      );
    } catch (e) {
      console.warn('%c[index.js, probeSmartHubSupport]', 'color: green;', 'Error probing Smart Hub support: ' + e.message);
      _isSmartHubSupported = false;
      localStorage.setItem('smartHubSupported', 'false');
      resolve();
    }
  });
}

function onWindowLoad() {
  console.log('%c[index.js, onWindowLoad]', 'color: green;', 'Moonlight\'s main window loaded.');

  initSamsungKeys();
  initSpecialKeys();
  loadUserData();

  probeSmartHubSupport().then(function() {
    // Handle deep links from Smart Hub Preview tile clicks (initial launch)
    handleDeepLink();
    // Also handle deep links when the app is brought to the foreground via Smart Hub
    window.addEventListener('appcontrol', handleDeepLink);
  });
}

window.onload = onWindowLoad;

// Log when the app is hidden and shown again (Home key, another app, input switch), with the stream state and how long
// it was hidden, and end a stream that keeps running in the background. Such a stream keeps the network busy (the host
// keeps sending 100+ Mbps), and the TV can hang when another app then starts its own video. Whether overlays of the TV
// such as the quick settings hide the app isn't known, so a hidden app alone doesn't end the stream at once:
// - a stream that is still connecting ends at once, since it has nothing to show yet,
// - a stream whose video track the TV closed for a reason other than a suspension (which only says that the app is
//   hidden) ends at once, since the TV took the video away from it,
// - any other stream ends once the app stayed hidden for BACKGROUND_STREAM_STOP_DELAY_MS.
// The game keeps running on the host, so selecting it again resumes it. The overlay counts how often the app was hidden
// during the stream and how often the TV closed its video, so a test can show what the quick settings do.
var BACKGROUND_STREAM_STOP_DELAY_MS = 60000;
var EMSS_CLOSE_REASON_SOURCE_SUSPENDED = 3;
var pageHiddenSince = 0;
var isStreamStoppedInBackground = false;
var isStreamConnected = false; // Whether the connection of the stream is established, see messages.js
var isStreamVideoTrackClosed = false; // Whether the TV closed the video track of the running stream, see messages.js
var streamVideoTrackCloseReason = -1;
var streamHiddenCount = 0;
var streamVideoTrackCloseCount = 0;
var backgroundStreamStopTimer = null;

// End the stream if it's still running while the app is hidden
function endStreamInBackground(reason) {
  clearTimeout(backgroundStreamStopTimer);
  backgroundStreamStopTimer = null;
  if (isInGame !== true || document.visibilityState !== 'hidden') {
    return;
  }
  console.log('%c[index.js, endStreamInBackground]', 'color: green;', 'Ending the stream, since Moonlight is in the background (' + reason + ').');
  isStreamStoppedInBackground = true;
  try {
    if (wasmSessionStarted) {
      Module.stopStream();
    } else {
      cancelStreamLaunch();
    }
  } catch (error) {
    console.error('%c[index.js, endStreamInBackground]', 'color: green;', 'Error: Failed to end the stream: ' + error);
  }
}

// Called by messages.js when the TV closes or reopens the video track of the running stream
function onStreamVideoTrackStateChanged(closed, reason) {
  isStreamVideoTrackClosed = closed;
  if (!closed) {
    return;
  }
  streamVideoTrackCloseCount++;
  streamVideoTrackCloseReason = reason;
  if (reason !== EMSS_CLOSE_REASON_SOURCE_SUSPENDED) {
    // Act after the media callback of the WASM module that reported it has returned
    setTimeout(function() {
      endStreamInBackground('the TV closed the video of the stream, reason ' + reason);
    }, 0);
  }
}

// Return the overlay line about the stream in the background, once the app was hidden or the TV closed the video
function getBackgroundStatsLine() {
  if (isInGame !== true || (streamHiddenCount === 0 && streamVideoTrackCloseCount === 0)) {
    return '';
  }
  return t('Moonlight hidden during the stream: %1$s times, video closed by the TV: %2$s times (last reason %3$s)',
    String(streamHiddenCount), String(streamVideoTrackCloseCount), String(streamVideoTrackCloseReason));
}

document.addEventListener('visibilitychange', function() {
  var details = 'The page is now ' + document.visibilityState + ' (stream active: ' + isInGame + ')';
  if (document.visibilityState === 'hidden') {
    pageHiddenSince = Date.now();
  } else if (pageHiddenSince !== 0) {
    details += ' after being hidden for ' + (Date.now() - pageHiddenSince) + ' ms';
    pageHiddenSince = 0;
  }
  console.log('%c[index.js, visibilitychange]', 'color: green;', details + '.');

  if (document.visibilityState === 'hidden' && isInGame !== true) {
    // A start can still be on its way to the stream view (the server info refresh of startGame, the delayed start
    // after quitting another app, a deep link). Invalidate it, so that it can't start a stream in the background.
    streamLaunchId++;
    try {
      stopAudioScheduler();
    } catch (error) {
      console.error('%c[index.js, visibilitychange]', 'color: green;', 'Error: Failed to stop the audio scheduler: ' + error);
    }
  } else if (document.visibilityState === 'hidden') {
    streamHiddenCount++;
    if (!wasmSessionStarted || !isStreamConnected) {
      endStreamInBackground('the stream was still starting');
    } else if (isStreamVideoTrackClosed && streamVideoTrackCloseReason !== EMSS_CLOSE_REASON_SOURCE_SUSPENDED) {
      endStreamInBackground('the TV closed the video of the stream, reason ' + streamVideoTrackCloseReason);
    } else {
      clearTimeout(backgroundStreamStopTimer);
      backgroundStreamStopTimer = setTimeout(function() {
        endStreamInBackground('hidden for ' + (BACKGROUND_STREAM_STOP_DELAY_MS / 1000) + ' s');
      }, BACKGROUND_STREAM_STOP_DELAY_MS);
    }
  } else if (document.visibilityState === 'visible') {
    clearTimeout(backgroundStreamStopTimer);
    backgroundStreamStopTimer = null;
    if (isStreamStoppedInBackground) {
      isStreamStoppedInBackground = false;
      snackbarLogLong('The stream was ended because Moonlight went to the background. Select the game to resume it.');
    }
  }
});

// Tell the user once per controller (by its id) after the app started when a gamepad reports no standard layout. The
// browser then exposes the raw layout of the controller driver, and the menus and the stream, which expect the standard
// layout, may map its buttons and sticks wrongly: e.g. an 8BitDo controller in D-input mode, or a newer controller on a
// TV whose browser engine predates the mapping of that controller.
function showNonStandardGamepadNotice(gamepadInfo) {
  if (gamepadInfo.mapping === 'standard' || nonStandardGamepadNotices.has(gamepadInfo.id)) {
    return;
  }
  nonStandardGamepadNotices.add(gamepadInfo.id);
  console.warn('%c[index.js, showNonStandardGamepadNotice]', 'color: green;', 'Warning: Gamepad ' + gamepadInfo.index + ' reports a non-standard layout (mapping="' + gamepadInfo.mapping + '"), so its buttons may be mapped wrongly.');
  snackbarLogLong('Gamepad %1$s (%2$s) has a non-standard button layout, so some buttons may be wrong. Try its XInput or Xbox mode, or another connection.',
    gamepadInfo.index, gamepadInfo.name ? gamepadInfo.name : t('Unknown'));
}

// Gamepad connected events
window.addEventListener('gamepadconnected', function(e) {
  const connectedGamepad = e.gamepad;
  const gamepadIndex = connectedGamepad.index;
  const gamepadInfo = Controller.describeGamepad(connectedGamepad);
  const rumbleFeedbackSwitch = document.getElementById('rumbleFeedbackSwitch');
  // Log what the gamepad reports as separate fields, so a support log shows which controller it is, how the browser maps
  // it and which controller type Auto detects for it (the 'Controller type sent to the PC' setting can override what the
  // stream announces, which the log of the stream names)
  console.log('%c[index.js, gamepadconnected]', 'color: green;', 'Gamepad ' + gamepadIndex + ' connected: ' + Controller.formatGamepadInfo(gamepadInfo), connectedGamepad);
  snackbarLog('Gamepad %1$s has been connected.', gamepadIndex);
  showNonStandardGamepadNotice(gamepadInfo);
  // Check if the rumble feedback switch is checked
  if (rumbleFeedbackSwitch && rumbleFeedbackSwitch.checked) {
    // Play a short rumble on the connected gamepad, or tell once that it can't rumble
    console.log('%c[index.js, gamepadconnected]', 'color: green;', 'Playing rumble on the connected gamepad ' + gamepadIndex + '...');
    Rumble.test(connectedGamepad);
  }
  // List the gamepad in System information. While streaming it is hidden, and the About settings refresh it when they open.
  if (!isInGame) {
    loadSystemInfo();
  }
});

// Gamepad disconnected events
window.addEventListener('gamepaddisconnected', function(e) {
  const disconnectedGamepad = e.gamepad;
  const gamepadIndex = disconnectedGamepad.index;
  console.log('%c[index.js, gamepaddisconnected]', 'color: green;', 'Gamepad ' + gamepadIndex + ' disconnected: ' + Controller.formatGamepadInfo(Controller.describeGamepad(disconnectedGamepad)), disconnectedGamepad);
  snackbarLog('Gamepad %1$s has been disconnected.', gamepadIndex);
  console.warn('%c[index.js, gamepaddisconnected]', 'color: green;', 'Warning: Lost connection to gamepad ' + gamepadIndex + '. Please reconnect your gamepad!');
  // Stop replaying a rumble for the slot, so that the next gamepad in it doesn't start rumbling
  Rumble.stop(gamepadIndex);
  // Remove the gamepad from System information
  if (!isInGame) {
    loadSystemInfo();
  }
});
