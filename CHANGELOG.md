# Changelog

All notable changes to this project will be documented in this file.

## Unreleased (Samsung S90C optimizations)

### Added
- Added a 'Samsung S90C optimization' button that shows the optimal streaming settings for the S90C with a bitrate matching the network connection of the TV, and applies them on confirmation
- Introduced a new experimental 'Reference frame invalidation' setting to recover from packet loss without a full keyframe (HEVC and AV1)
- Added session totals of network frame drops and recovery keyframes (excluding the keyframes the app requests itself when the video track opens or the HDR metadata changes) to the performance stats, along with the network connection of the TV
- Added detection of the Ethernet or Wi-Fi connection of the TV with a warning above 80 Mbps over the 100 Mbps Ethernet port
- Added warnings when selecting H.264 above 1080p (also at startup when a stored H.264 codec meets the new 4K default) or 4K above 120 FPS, which exceed the video decoder of the TV
- Added an optimization plan for the S90C covering the network, host, TV settings and test procedure (`docs/S90C-Optimierungsplan.md`)
- Added an experimental 'HDR static metadata' setting that inserts the HDR10 metadata of the host display (mastering display colour volume, content light level) into the HEVC keyframes, which Sunshine only sends over the control channel and the TV never received
- Added the frame receive time, the frame wait time before the video thread and the pending frame count to the performance stats, and renamed the pacer time to 'Average frame pacing delay'; the former 'Average decoding time' mixed the queue wait with the pacing
- Added the 3200 x 1800 (1800p) resolution with bitrate presets as a step between 1440p and 4K
- Added an experimental 'Audio clock sync' setting for the Web Audio backend that keeps the audio delay at the jitter buffer by playing up to 500 ppm (0.05 %) faster or slower, instead of skipping 5 ms frames or leaving a gap the size of the jitter buffer when the clocks of the host and the TV drift apart; the resampler now interpolates with a four point cubic kernel
- Added a hint that 90 FPS does not divide the 60 or 120 Hz output of the TV evenly
- Logged the UDP receive buffer size granted by the TV and the receive timeout mode at stream start
- Added a notice when the host can only provide a fallback for the selected codec or HDR mode (another codec, or SDR instead of HDR)
- Documented in the optimization plan how to check in the Sunshine log what was negotiated (HDR, bit depth, color range, encoder options) and what bitrate the encoder gets
- Added the configured bitrate and the host frame rate, measured over 30 seconds from the capture timestamps of the host, to the performance stats, which reveals a host display running at 59.94 instead of 60 Hz
- Added 5 Mbps steps to the bitrate menu with UP and DOWN, while LEFT and RIGHT keep the 0.5 Mbps steps
- Documented an AV1 versus HEVC test procedure and the refresh rate of the host display in the optimization plan
- Added the frames the TV dropped itself (decode unit queue overflow or a frame rejected by the player) as a separate session total, instead of counting them as network drops, and the highest pending frame count per second
- Added the FEC recoveries of the session, the longest recovery, the worst block and the requested and reported UDP receive buffer to the performance stats
- Added audio lines to the performance stats for the Web Audio backend: jitter buffer, schedule lead, browser latency, underruns, skipped and lost frames, clock sync correction and a suggested buffer size
- Turned the screensaver of the TV off while streaming, and on again afterwards
- Documented a camera-based latency test, a 1-pixel sharpness test and the automatic power-off of the TV in the optimization plan
- Added a 'TV player rejections' line to the performance stats that counts the frames the video player of the TV rejected by reason (buffer full, keyframe required, track not ready, other), and logged each rejection reason by name
- Added a 'WASM heap top' line to the performance stats, and the same value to the log at the end of each stream, so that a memory leak over long sessions shows up before an allocation aborts the module
- Added a message and an automatic restart when the WebAssembly module aborts or one of its threads crashes, instead of a silent freeze
- Logged why the TV closed a media track, a reopening of the video track during the stream and the frames discarded meanwhile, and when the app is hidden and shown again
- Documented a lifecycle test (Home key, TV menus, input switch, RED during the start) in the optimization plan
- Added a one-page quick guide for setting up and testing the S90C (`docs/S90C-Kurzanleitung.md`)

### Changed
- Renamed the app to 'Moonlight S90C' with its own package ID (MLightS90C) and an 'S90C' badge on the icon, so that it can be installed next to the regular Moonlight app; it keeps its own settings and pairing
- Reduced the busy wait of the frame pacer from 1 ms to 0.2 ms, as usleep already waits on a futex in worker threads
- Reworked the video frame pacing to follow the usual arrival time of the frames, so that a single late frame no longer holds back every following frame by up to tens of milliseconds, and to follow a later arrival time only once two consecutive windows confirm it, so that the burst of frames after a network stall cannot hold back the next second of frames
- Paused the gamepad polling of the UI while streaming, which kept the main thread busy every 5 ms even though the streaming session polls the gamepads on its own
- Read all gamepads with a single call to the main thread per poll instead of one call per gamepad slot plus two, leaving more room for the Web Audio scheduler
- Sent the controller state to the host only when it changes (with a refresh every 100 ms) instead of 200 times per second, reducing the Wi-Fi uplink traffic of the TV
- Posted the performance stats without blocking the video decoder thread until the main thread handles them
- Compiled the Wasm module with `-O2` instead of `-Os` to favor speed over size
- Requested one encoder slice per frame instead of four, which improves the compression at the same bitrate since the hardware decoder of the TV gets whole frames anyway
- Bounded the audio delay of the Web Audio backend to 1.5 times the jitter buffer instead of 2 times when the host and TV clocks drift apart, and allowed a jitter buffer of 25 ms
- Enabled HDR by default on HDR-capable TVs on a fresh install, as the optimal streaming settings and 'Restore Defaults' already did
- Refreshed the Wi-Fi signal strength in the performance stats every 5 seconds instead of showing the value from the start of the stream
- Requested a keyframe when the HDR metadata of the host arrives or changes during the stream, so the 'HDR static metadata' setting takes effect
- Posted the connection warnings and the controller rumble to the UI without blocking the video receive thread
- Described what 'Optimize game settings' does on Sunshine (resolution only, the refresh rate follows the frame rate anyway, only offered modes)
- Requested the Rec. 709 colorspace instead of Rec. 601 for SDR streams, which is the standard for HD and 4K video
- Declared HEVC and AV1 level 5.2 for streams above 4K at 60 FPS, with a fallback to level 5.1 for TVs that reject it
- Limited the bitrate presets to 75 Mbps when the TV is connected over its 100 Mbps Ethernet port
- Changed the default video settings to the optimal streaming settings for the S90C (4K, 60 FPS, HEVC, HDR, and a bitrate for the network connection)
- Retried a frame that met a full video player buffer for up to one frame duration, and ended the stream with a message when the player keeps rejecting its format for 3 seconds, instead of requesting keyframes forever on a black screen
- Ended the stream with a message when the media source of the TV fails during the stream, instead of leaving a frozen picture
- Trimmed the backlog of audio frames that arrives after an underrun of the Web Audio backend to the jitter buffer plus two frames, so that the audio delay no longer stays at 1.5 times the jitter buffer for minutes after each underrun, and counted these frames apart from the skipped ones
- Stopped counting the keyframes that follow a reset of the video pipeline of the TV as recovery keyframes, since the video pipeline reset count already shows them
- Stopped counting the frames that arrive while the video track of the TV is closed (e.g. while the app is hidden) as network drops
- Queued the development and stable release workflows, which share the ForceGM image tag, so that a release can't get the ForceGM package of another commit
- Filled the description of development pre-releases from `docs/RELEASE_NOTES_DEV.md`, with links to the commit, the changelog and the optimization plan
- Added the promotion of a tested pre-release to a full release to the development release workflow (inputs `promote_tag` and `release_tag`), which keeps its files, moves it to a tag that the in-app update check doesn't read as a newer version, and takes the notes from `docs/RELEASE_NOTES_STABLE.md`
- Unified the bitrate ladder of the optimization plan (100, 120, 135 and 150 Mbps over Wi-Fi, with one set of pass criteria and a rule for the final value), made its FEC recommendation consistent with the 5 % setup, extended the long-run test to 2.5 hours and explained the remaining performance stats lines
- Described the real correction range of 'Audio clock sync' and what happens without it, and pointed the jitter buffer help to the suggested buffer size in the performance stats
- Used the codec modes reported by the host for the codec negotiation, read again after the launch or resume request because Sunshine probes its encoders then, and offered HEVC with the same bit depth as a fallback when AV1 is selected. A host without AV1 now gets HEVC instead of a 4K H.264 stream without HDR, and a host without 10-bit AV1 gets HEVC Main10 with HDR instead of an AV1 stream that it can only encode in 8-bit (or not at all on older Sunshine versions)
- Reworded the AV1 warning to say what AV1 needs and that the stream falls back to HEVC
- Kept the bitrate when the resolution, frame rate, codec or HDR mode changes, instead of resetting it to the preset. This applies to a bitrate picked by hand and to the recommended bitrate of the S90C settings, 'Restore Defaults' and a fresh install. The presets follow these settings again after toggling 'Optimize bitrate presets', until the bitrate is changed by hand, which is how moonlight-qt keeps a hand-picked bitrate. On an update, the presets keep following the settings if the stored bitrate was the preset for the stored resolution and frame rate, or if the optimized presets were on. Selecting the current resolution or frame rate again no longer resets the bitrate

### Fixed
- Fixed a stream starting anyway after RED was pressed during 'Starting...', without audio and with RED and YELLOW not working, by cancelling the start and ignoring the late reply of the host
- Fixed a repeated stop (a double RED press, the gamepad combo or a termination by the host at the same time) starting a second teardown thread and a second return to the app list, and a stop during a termination by the host tearing the connection down twice at the same time
- Fixed a Smart Hub deep link starting a second stream on top of a running one
- Fixed the performance stats showing 'signal strength: NaN percent' on TVs that report no Wi-Fi signal strength
- Fixed a stream left running in the background when the app was hidden (Home key, another app), which kept the network busy and could make the TV hang when another app started its video. The stream now ends after one minute in the background, or at once when the TV takes the video away from the hidden app (closes its video track for a reason other than a suspension) or the connection is still being set up, so that overlays such as the quick settings can leave it running. A notice says how to resume, and an overlay line counts how often the app was hidden and the video closed during the stream
- Fixed the Smart Hub preview server of this build and the regular Moonlight app competing for the same port (this build uses 8889, and tiles saved earlier are moved to it) and for the same preview image files (this build uses its own file prefix)
- Fixed a start that was still on its way (e.g. the delayed start after quitting another app) starting the stream after the app went to the background
- Fixed every FEC recovery blocking the video receive thread for up to 15 ms or more on a desktop CPU by removing a needless matrix multiply from the Reed-Solomon setup (the output is unchanged)
- Fixed a freeze of up to 120 frames (2 s at 60 FPS) after a wrongly predicted frame loss without reference frame invalidation, as in upstream moonlight-common-c, and a partially received IDR frame leading to a reference frame invalidation request
- Fixed each lost audio packet adding 5 ms to the audio delay of the Web Audio backend by concealing it with one negotiated frame instead of 10 ms
- Fixed the Back key pressing the left mouse button of the host without releasing it once the pointer was locked, and stopped requesting a keyframe on pointer lock
- Fixed the S90C dialog asking to install the ForceGM variant when it is already installed, and the help texts of 'Game mode', 'Optimize bitrate presets' and HDR
- Fixed 'Restore Defaults' turning off the 'Video frame pacing' and 'Host address field mode' settings even though they are enabled by default
- Fixed the resolution and frame rate warning comparing the values as text instead of numbers

## v1.19.0

### Added
- Added gamepad identification reporting for use with automatic profile selection in Sunshine

### Changed
- Enabled 'Video frame pacing' and 'Host address field mode' settings as the default
- Improved gamepad handling when connecting, disconnecting, or replacing a gamepad while streaming

### Removed
- Removed the obsolete USB release workflow, which was no longer functional and usable

### Fixed
- Fixed pairing failures caused by concurrent HTTP requests interrupting the pairing process
- Fixed a bug where release checking could fail if repository placeholders were not configured
- Fixed host polling during pairing, including pairing failures and host selection after cancellation
- Fixed commit SHA injection in development builds by ensuring correct directory ownership in Docker
- Fixed freezes and connection failures when the TV cannot start the video stream with the selected settings

## v1.18.0

### Added
- Added automatic selection of the last opened host and app when navigating between views
- Introduced a new 'Decrypt host audio' setting intended for Wolf and Punktfunk-style hosts
- Added a 'Disabled' option to the 'Audio backend' setting to disable audio output from the TV

### Changed
- Improved video frame pacing efficiency by reducing CPU usage when frame pacing is enabled

### Removed
- Removed the always-zero network jitter frame drop statistic from the performance stats

### Fixed
- Fixed dialogs stretching to the full screen height instead of sizing to their content
- Fixed incorrect bitrate calculations in the performance stats when enabled mid-stream
- Fixed Docker image tagging in release workflows for forks with uppercase repository names
- Fixed a startup crash when checking for cached app updates with an invalid or missing version

## v1.17.2

### Added
- Added ForceGM variant detection to the System Info panel for easier identification

### Changed
- Improved build metadata injection in the Dockerfile for development and release builds
- Prevented paired hosts from falling back to unauthenticated HTTP when refreshing server metadata

### Fixed
- Fixed a security vulnerability that allowed untrusted host metadata to be executed within the application

## v1.17.1

### Added
- Reintroduced i18n workflow to synchronize locale files from the source of truth

### Changed
- Extended the Game Mode restrictions to newer platform versions (Tizen 9.0+)
- Refactored the 'Update Moonlight' dialog to use static HTML for cleaner code structure

### Fixed
- Fixed EMSS pipeline cleanup when connections terminate unexpectedly
- Fixed last frame number not resetting on new streams to prevent stats underflow
- Fixed decoding time statistic displaying incorrect values due to integer underflow
- Fixed the 'Update App' button notification not being restored after restarting the app
- Fixed the 'Update App' button not being displayed after manually checking for updates
- Fixed an issue where rapid or multiple clicks on a host could trigger concurrent executions

## v1.17.0

### Added
- Added an intermediate hamburger menu highlight when navigating up from a host card
- Added automatic Wake-on-LAN support to wake offline hosts with a per-host toggle
- Added host availability polling to the wake-up process to detect when a host becomes reachable
- Added a warning when Wake-on-LAN is used with hosts configured with randomized MAC addresses

### Changed
- Improved the manual Wake PC action with an interactive wake-up dialog and visual feedback
- Handled enabling/disabling of 'Wake PC' and 'Refresh Apps' options based on the host's online status

### Fixed
- Fixed default Sunshine box art remaining cached after custom app box art was added
- Fixed localhost addresses being used as connection candidates causing failed connections
- Fixed zero MAC addresses being stored for unpaired hosts causing invalid Wake-on-LAN requests
- Fixed Wake-on-LAN failing to send magic packets in some cases due to a socket initialization error

## v1.16.1

### Changed
- Improved host polling and subnet scanning reliability and performance
- Improved Smart Hub deep link handling during host discovery at app startup
- Improved translation extraction and synchronization for more reliable string handling
- Prevented i18n initialization from delaying the initial loading screen at app launch

### Fixed
- Fixed an unnecessary database write for the language preference on startup
- Fixed corrupted PNG box art affecting the Apps list and Smart Hub Previews
- Fixed experimental badges disappearing from settings labels after translation
- Fixed UI freezes and hosts incorrectly appearing offline due to network timeouts
- Fixed system info translation when Auto is set and prevented duplicate language initialization
- Fixed toast messages being translated twice and translated strings appearing in browser console

## v1.16.0

### Added
- Introduced a new 'Audio backend' setting for switching between EMSS and Web Audio
- Added Web Audio as an alternative audio backend alongside the existing EMSS implementation
- Introduced a new 'Audio jitter buffer' setting for tuning Web Audio playback buffering
- Retained the existing 'Audio synchronization' setting for the default EMSS backend
- Handled backend-specific audio settings dynamically based on the selected audio backend

### Fixed
- Fixed selection menu settings not being preserved after restoring defaults
- Fixed a race condition causing missing Smart Hub Preview box art for newly added apps
- Fixed an issue causing toggle switches to revert to their previous state after being selected
- Fixed background polling failures caused by stale host addresses and missing local IP fallback

## v1.15.0

### Added
- Added Smart Hub Preview support with app tiles, box art, and native tile ordering (Tizen 5.5–6.0)
- Added Deep Link support for launching apps directly from the Smart Hub Preview home screen
- Added offline persistence to preserve Smart Hub Preview apps when hosts are unavailable
- Handled unsupported Tizen versions to prevent Smart Hub Preview background service processes

### Changed
- Improved sorting of the app list for titles containing numbers for a more natural ordering

### Fixed
- Fixed selection menu settings not being preserved after application restart
- Fixed an issue causing the memory-cached app list to persist across application restarts
- Fixed an issue causing system info to be loaded multiple times during application startup
- Fixed a race condition causing some box arts to fail when retrieving multiple apps at once
- Fixed polling failures after the subnet scanner detects a known host with a changed IP address

## v1.14.1

### Added
- Added a warning message when unlocking higher frame rate options
- Added the ForceGM variant release packaging for release workflows
- Reintroduced translation synchronization tooling for maintaining locale files

### Changed
- Moved the 'Host address field mode' setting to the 'UI Settings' category
- Improved the warning message when selecting 5.1 or 7.1 surround sound options
- Optimized Docker build caching to reduce build times by reusing the Tizen SDK layer

## v1.14.0

### Added
- Added a new 'UI Settings' category for interface customization options
- Introduced a new 'Language' setting to manually change the application language
- Added support for automatic language detection based on the TV system language
- Added translations for the application interface and backend-generated messages
- Added the ability to change the application language without restarting the app
- Added Portuguese Brazilian (pt-BR) language support to the language selector
- Preserved English (en-US) as the base and fallback language for untranslated strings

### Changed
- Moved the 'Language' setting into the new 'UI Settings' category
- Configured workflow for automated comments on issues and pull requests when opened or closed

## v1.13.1

### Fixed
- Fixed an issue where hosts could fail to recover correctly after coming back online
- Fixed an issue where offline hosts could incorrectly appear as online after becoming unreachable
- Fixed an issue where cached app lists could remain accessible after the host was disconnected
- Fixed an issue where streaming sessions could fail to reconnect after disconnecting in some cases
- Fixed an issue where automatic host discovery could occasionally fail to find new hosts
- Fixed an issue where gamepad shortcuts did not work when multiple gamepads were connected
- Fixed an issue where certain gamepads could unexpectedly stop responding during streaming
- Fixed an issue where gamepad action buttons would trigger rapidly when held down during UI navigation

## v1.13.0

### Added
- Added automatic local network host discovery using a HTTP subnet scanner
- Added support for IPv6 addresses and DNS hostname when connecting to hosts
- Added Wake-on-LAN (WoL) support for hosts connected via IPv6 networks
- Added centered status icons to indicate whether hosts are offline or unpaired

### Changed
- Optimized dependency downloads to significantly reduce Docker image build times

### Fixed
- Fixed an issue where automatic host discovery could occasionally restore outdated IP addresses
- Fixed a race condition where the first app was selected before the app list had fully loaded
- Fixed pairing deadlocks causing pairing requests to remain stuck after canceling
- Fixed network hangs that could leave the app stuck on the 'Loading Apps' screen

## v1.12.1

### Changed
- Optimized the Docker build process with persistent cache mounts for faster builds
- Prevented selection of resolutions unsupported by the TV's hardware capabilities
- Excluded hidden files and directories to prevent unnecessary Docker cache busting
- Updated the Tizen certificate keystore password to meet minimum password requirements

### Fixed
- Fixed pairing failures with Sunshine using a randomly generated unique client ID
- Fixed an issue where canceling the pairing dialog would cause subsequent pairing attempts
- Fixed logging in the NvHTTP constructor to prevent undefined values from being printed
- Fixed a deserialization bug where newly revived hosts failed to inherit their properties correctly

## v1.12.0

### Added
- Introduced a new 'Optimize bitrate presets' setting to calculate optimal bitrate values
- Implemented handling of standard and optimized bitrate presets based on toggle state

### Changed
- Improved release notes extraction and formatting for better readability
- Updated 'System info' placeholder and reduced redundant API calls across the codebase
- Updated versioning logic to inject build metadata for identifying pre-releases
- Disabled 'Game mode' setting for Tizen 5.5 due to lack of support from WASM player
- Updated bot-stale workflow to restrict exempted issue labels
- Configured workflow to close issues if the author does not respond to a request for more information

### Fixed
- Fixed broken OpenSSL download URL in Emscripten SDK ports
- Fixed an issue where multiple elements could remain focused during navigation

## v1.11.1

### Added
- Added helper functions to resolve DOM elements from various target types
- Added helpers for resolving element ID and safely handling focus and blur
- Added helper for safely clicking elements with disabled state checks

### Changed
- Refactored mark and unmark to use resolve element function and removed duplication
- Applying DOM helper utilities across views and improve navigation behavior
- Enhanced MDL dropdown menu handling for selection and closing
- Improved navigation and UI behavior in 'Add Host' dialog and applied style fixes
- Unifying gamepad and remote control selection logic using a single view handler

### Fixed
- Fixed toggle switch behavior and ensured consistent handling across Tizen versions

## v1.11.0

### Added
- Added support for custom ports when connecting and pairing with a host
- Added HTTP port sanitization and fallback to default on invalid values
- Added input validation for IP address and optional port in the text field

### Changed
- Fallback to default port when entering an IP address using numeric fields

### Fixed
- Fixed host polling execution in background after deletion
- Fixed navigation index out of bounds upon host deletion
- Fixed navigation input being active during loading screens
- Fixed a bug in the pairing process that was causing random pairing failures

## v1.10.3

### Added
- Added the Patreon platform for project support

### Changed
- Refactored Dockerfile to remove unused dependencies and steps
- Disabled monthly USB package release schedule and enabled manual trigger
- Replaced the snackbar with a proper dialog in DialogMsg and ignored .DS_Store
- Optimized Dockerfile to cache backend build layers during frontend changes
- Improved issue templates and included 'Discussions' link for quick interaction

## v1.10.2

### Changed
- Updated QR code in the 'Support' dialog that redirects to the correct Wiki page

### Fixed
- Fixed issue where SDB and other Tizen Studio tools were removed during Docker image cleanup

## v1.10.1

### Changed
- Configured workflow to mark inactive issues as stale and close them after a certain period of time
- Updated 'Compatibility Warning' dialog to simplify message for affected Tizen platform
- Updated 'h264bitstream' library to fix a potential memory leak and improving stability
- Improved Dockerfile by refining multi-stage build and cleanup to reduce image size
- Disabled USB package creation due to the USB Demo packaging tool being discontinued by Samsung

### Removed
- Eliminated the need to restart Moonlight after selecting a video codec or audio configuration

## v1.10.0

### Added
- Introduced a new 'Game mode' setting that allows changing the game mode state
- Added a new 'Warning' dialog and corresponding view to display warning messages
- Implemented functionality for the game mode switch with proper handling across Tizen versions
- Handled video latency modes based on toggle switch state during stream start request

### Changed
- Refactored media source pipelines and reinitialized video decoding configuration at stream startup
- Renamed 'UI Settings' category to 'Advanced Settings' and adjusted its order
- Reorganized settings by relocating options into better structured categories
- Reordered Tizen privileges, settings, and metadata entries in the app configuration

## v1.9.2

### Added
- Added workflow for building and publishing development releases with associated files

### Changed
- Reverted HEVC and AV1 codec profiles to previous level to allow higher stream settings

### Fixed
- Fixed issue where the 'Add Host' container wasn't focused after splash screen loaded
- Fixed issue with 'Quit Running App' button not focused properly after stopping the game
- Fixed issue where cancelling 'Exit Moonlight' dialog added double focus to host containers
- Fixed issue with the running game card not correctly reflecting the active game session

## v1.9.1

### Added
- Added badges to settings options to indicate new, preview, or experimental features

### Changed
- Refined multiple settings descriptions to provide clearer context and usability
- Updated the workflow file for stable releases and changed to manual trigger for the master branch
- Improved the workflow process for USB releases, updated the release notes, and made minor fixes

## v1.9.0

### Added
- Added a new 'UI Settings' category for interface customization options
- Introduced a new 'Unlock all frame rates' setting to enable higher FPS options
- Implemented handling for unlocking all FPS options based on toggle switch state
- Expanded the 'Unlock all frame rates' setting with a new '144 FPS' option

### Changed
- Rearranged settings by moving options into more appropriate categories
- Adjusted high-resolution scroll event scaling factor for smoother wheel input

## v1.8.1

### Added
- Added extra buffer space for IDR frames to accommodate potential SPS fixup

### Changed
- Expanded initial decode buffer size from 128 KB to 1 MB to improve playback stability
- Reduced the level profiles of all video formats to ensure better device compatibility
- Refined on-screen overlays for better alignment to screen edges and improved readability

### Fixed
- Fixed an issue where server polling continued in the background during an active stream session

## v1.8.0

### Added
- Introduced a new 'Performance statistics' setting that displays performance information while streaming
- Implemented functionality to toggle the performance stats switch and save changes
- Added on-screen overlay for performance statistics shown only during streaming sessions
- Added functionality to aggregate metrics and present detailed statistics in a formatted output
- Added accurate tracking, calculation, and measurement logic for video performance statistics
- Handled performance stats updates and displayed metrics derived from stream performance
- Implemented shortcut functionality to toggle performance stats via remote control, keyboard, and gamepad

## v1.7.1

### Added
- Added loading screens to 'Hosts', 'Apps', and 'Settings' views for smoother transitions
- Added functionality to support posting messages asynchronously to the main thread
- Defined MIN and MAX macros for cleaner value comparisons across the codebase

### Changed
- Improved handling of stream termination to prevent video display from remaining stuck

### Fixed
- Minor bug fixes, code refactoring and general improvements

## v1.7.0

### Added
- Introduced a new 'Connection warnings' setting that disables warning messages while streaming
- Implemented functionality to toggle the connection warnings switch and save the changes
- Added on-screen overlay for connection warnings shown only during streaming sessions
- Handled connection status changes and provided warnings based on connection quality

### Changed
- Extended host object with additional server info and applied validation checks
- Updated 'Host Details' dialog to display additional server info with fallback validation

## v1.6.1

### Added
- Added encryption flag to stream configurations that disables encryption support

### Changed
- Updated 'Restart Moonlight' dialog to display appropriate message based on the restart request

### Fixed
- Fixed image tag setup in scheduled workflow to use the correct Docker image tag
- Fixed navigation view issues caused by pressing the RED key outside stream session
- Fixed mouse wheel scroll direction issue caused by previously disabled floating menu

## v1.6.0

### Added
- Introduced a new 'Audio configuration' setting that allows selection of audio channels
- Added a navigation view to interact with the new 'Audio configuration' setting
- Implemented functionality to save value and initiate the stream with preferred audio config
- Added a warning message when selecting 5.1 or 7.1 surround sound options
- Handling of audio channels based on the selected audio configuration option

### Changed
- Enhanced audio decoding logic to support 5.1 and 7.1 surround audio channels

## v1.5.1

### Added
- Added issue templates for bug report and feature request with selection options
- Added workflow for scheduled release USB method with associated file

### Changed
- Improved pull request template with structured sections and helpful instructions
- Improved workflow for automated release publishing with associated file

### Removed
- Removed the 'Buy Me a Coffee' funding platform due to regional restrictions

### Fixed
- Minor bug fixes, code refactoring and general improvements

## v1.5.0

### Added
- Introduced a new 'Color range' setting that enables full color range while streaming
- Implemented full color range handling based on toggle switch state
- Added hardware decoding mode flag for audio and video playback configurations

### Changed
- Increased the maximum bitrate slider for the bitrate menu from '120 Mbps' to '150 Mbps'

### Fixed
- Fixed focus issue on 'Continue' button after toggling its disabled state in the 'Add Host' dialog
- Fixed an issue with the running game card style not being applied when navigating to the 'Apps' view

## v1.4.1

### Added
- Implemented auto-checking for new Moonlight updates at application startup
- Notify and add a new 'Update Moonlight' button to view update release notes

### Changed
- Preventing API requests by limiting the interval when performing update checks at startup
- Ensured that server information is refreshed before background polling of the host begins
- Renamed 'Advanced Settings' category to 'Video Settings' to better align with the relevant settings

### Dependencies
- Updated 'tizen-studio' tool from v5.6 to v6.1

## v1.4.0

### Added
- Added a new 'Audio Settings' category which will contain audio settings
- Added 'HDR mode' parameter to launch and resume requests to auto-toggle HDR on host PC

### Changed
- Reorganized settings by moving options across different categories for better grouping
- Improved handling of video codec selection and HDR mode state for better value determination
- Enhanced server codec mode support for proper value handling based on the selected video format

### Fixed
- Fixed validation of non-pinned TLS trusted certificates

## v1.3.1

### Changed
- Improved manual release update checking and eliminated redundant code
- Renamed 'Decoder Settings' category to 'Advanced Settings' for better understanding
- Improved settings view handling, navigation control, and reduced repetitive code
- Refined setting labels and option names for improved clarity and usability
- Improved Java configuration for Emscripten and bypassed Java check for Tizen Studio

### Fixed
- Fixed incorrect conditions causing toggle switches to misinterpret their default state

## v1.3.0

### Added
- Added a new 'System Update' icon for the 'Check for Updates' button
- Introduced a new 'Check for Updates' button to check for new Moonlight updates
- Implemented version comparison and release notes extraction for new updates
- Introduced a new 'Update Moonlight' dialog and its corresponding view
- Implemented version info and release notes in the 'Update Moonlight' dialog

### Fixed
- Minor improvements, code refactoring, and rearrangement across the application

## v1.2.20

### Added
- Added warning messages for resolution, frame rate, bitrate, and codec selection

### Changed
- Simplified setting descriptions to improve readability and reduce unnecessary details
- Updated '480p' video resolution setting for better standardization and compatibility
- Rearranged elements for better code structure, organization, and readability

### Fixed
- Fixed an issue where the bitrate slider was ignoring decimal values due to incorrect parsing

## v1.2.19

### Added
- Added more system details and improved structure in the 'System Info' placeholder

### Changed
- Changed the default video resolution setting from '1080p' to '720p'
- Increased the minimum bitrate slider for the bitrate menu from '0 Mbps' to '0.5 Mbps'
- Changed the default video bitrate setting from '20 Mbps' to '10 Mbps'
- Improved Dockerfile with the 'wgt-to-usb' tool for generating a USB installer

### Fixed
- Minor bug fixes, code refactoring and general improvements

## v1.2.18

### Added
- Added a new 'Tizen' metadata: 'Floating Navigation' to disable the floating menu in the app
- Added 'Optimize Games Settings' and 'Play Audio on PC' settings to the stream start request

### Changed
- Improved handling of layout elements for displaying the stream view

### Fixed
- Fixed an issue where stream settings and parameters did not apply when resuming an app
- Fixed an issue where repeated clicks on host and game containers caused multiple instances of streaming sessions

## v1.2.17

### Added
- Added new snackbar messages for additional cases of unexpected streaming termination

### Changed
- Partially reverted audio sync and video player changes to their original implementation
- Enhanced comments, console logs, and snackbar messages for improved debugging and clarity

### Dependencies
- Updated 'opus' module from v1.4 `c854997` to v1.5.2 `ddbe483`

## v1.2.16

### Added
- Implemented scrolling navigation to the previous or next card in the 'Hosts' and 'Apps' views
- Implemented scrolling navigation to the current card row in the 'Hosts' and 'Apps' views

### Fixed
- Fixed an issue where the game card was not focused when entering or returning to the 'Apps' view
- Fixed an issue where the focused card row did not scroll when entering or returning to the 'Hosts' and 'Apps' views
- Fixed an issue where the app list was not refreshed after selecting the host container
- Fixed an issue where the 'Quit App' dialog would appear even if no app or game was running

## v1.2.15

### Added
- Added a scrolling text animation for host and game titles when focusing on the card

### Changed
- Improved the structure of the host and game containers by refining all their elements
- Enhanced styling and visibility in the 'Hosts' and 'Apps' views for rows, cards, and titles
- Improved navigation in the 'Hosts' and 'Apps' views while reducing repetitive code

### Fixed
- Fixed a scrolling issue with host and game cards due to navigation delay
- Fixed minor navigation issues across different views to improve stability

## v1.2.14

### Changed
- Enhanced styling and visibility for the header, navigation bar, and buttons
- Improved size and styling of snackbar logs, tooltips, and dialogs for better readability
- Enhanced button styling across the app and refined dialog text appearance
- Improved styling in the 'Add Host' dialog for both IP address field modes to ensure clarity
- Updated the content and style of the 'Navigation Guide' dialog for better readability
- Enhanced visibility and styling in the 'Settings' view for categories, options, menus, and icons

## v1.2.13

### Added
- Added the application logo with animation to the splash screen

### Changed
- Increased the spinner size with rounded corners and enhanced text visibility
- Adjusted the size of the 'Add Host' and 'Host Container' icons for better visibility
- Moved the 'icons' folder to the 'static' directory for better organization of assets
- Replaced the function to stop the streaming session with the correct one for keyboard input

### Removed
- Removed unused styling properties and incompatible event listeners

### Fixed
- Fixed a performance issue when navigating game cards in the 'Apps' view

## v1.2.12

### Added
- Added the 'Tizen' profile: 'TV Samsung' to determine the type of device used in the application

### Changed
- Disabled the 'ChromeOS' network service discovery feature, which is not compatible with Tizen OS

### Removed
- Removed the 'Exit app' button from 'Settings' that was used to immediately terminate the app
- Removed the 'Game Mode' metadata to prevent app crash issue when starting streaming on newer Tizen OS

### Fixed
- Fixed an issue with the application icon file path causing a configuration error
- Fixed an issue during address polling when the host status is online or offline
- Fixed a focus issue on the 'Settings' button when returning to the 'Hosts' navigation bar

## v1.2.11

### Added
- Introduced a new 'HDR mode' setting that allows HDR streaming on HDR-capable devices
- Implemented logic to load the stored HDR value and start the stream in HDR mode
- Implemented functionality to update and save the video codec value and the HDR state

### Changed
- Handled switching between standard and Main10 codec profiles based on selected codec and HDR state
- Improved the 'Video codec' setting to better handle codec switching during HDR state changes
- Updated the QR code in the 'Support' dialog that redirects to the new guide

## v1.2.10

### Added
- Introduced a new 'Wake On LAN' feature for waking up the host PC
- Implemented functionality to update and store the valid MAC address for the host PC
- Added a new 'Wake PC' option to the 'Host Menu' dialog to allow waking the host PC
- Introduced a new 'Host Details' dialog and its corresponding view
- Added a new 'View details' option to the 'Host Menu' dialog to view host details

### Fixed
- Minor bug fixes, code refactoring and general improvements

## v1.2.9

### Added
- Added a new 'Menu' icon for the 'Host Menu' button
- Introduced a 'Host Menu' button to show host button options
- Introduced a new 'Host Menu' dialog and its corresponding view
- Implemented functionality to clear box arts from internal storage
- Added a new 'Refresh apps' option to the 'Host Menu' dialog to refresh apps and games
- Added a new 'Delete PC' option to the 'Host Menu' dialog to allow removing the host PC

## v1.2.8

### Added
- Introduced a new 'Flip A/B face buttons' setting that swaps the 'A' and 'B' button mapping for the gamepad
- Introduced a new 'Flip X/Y face buttons' setting that swaps the 'X' and 'Y' button mapping for the gamepad
- Implemented logic to handle different layouts of gamepad face buttons based on toggle state

### Changed
- Optimized functionality to save and load box arts to internal storage for better performance

## v1.2.7

### Added
- Added a new 'Input Settings' category which will be used to hold input settings
- Introduced a new 'Rumble feedback' setting that allows changing the state of the rumble feature for the gamepad
- Introduced a new 'Mouse emulation' setting that allows changing the state of the mouse feature for the gamepad

### Fixed
- Minor bug fixes, improved visual styling and general improvements

### Dependencies
- Updated 'material-icons' library to the latest version

## v1.2.6

### Added
- Introduced a new 'Sort apps and games' setting to change the sorting order of apps and games
- Implemented functionality to change the sort order for the list of apps and games

### Fixed
- Fixed a warning issue where casing did not match for 'as' and 'FROM' keywords

### Dependencies
- Updated 'moonlight-common-c' module from `48d7f1a` to `8599b60`

## v1.2.5

### Added
- Implemented functionality to handle repeat actions and navigation delay for gamepad while in-app
- Implemented a workaround to send the escape key to the host by pressing the ESC key twice on the keyboard

### Removed
- Removed global navigation delay from remote control while in-app

### Fixed
- Minor bug fixes and refactored code for improved readability

### Dependencies
- Updated 'tizen-studio' tool from v5.5 to v5.6

## v1.2.4

### Added
- Added a new 'Navigation' icon for the 'Navigation Guide' button
- Introduced a new 'Navigation Guide' button to learn about navigation controls
- Introduced a new 'Navigation Guide' dialog and its corresponding view
- Implemented functionality for handling the 'Navigation Guide' dialog

### Changed
- Minor enhancements in visual stylization and general improvements

## v1.2.3

### Added
- Added a new 'Tizen' metadata: 'Game Mode' which enables the app to use game mode
- Added the 'Buy Me a Coffee' platform for developer support

### Changed
- Show the 'Restart Moonlight' dialog after restoring default settings instead of the snackbar
- Quick switching to the alternate IP address field can now be done by pressing 'Channel Up/P+' or 'Select/Back' button

### Fixed
- Fixed an issue with the server codec mode support value not displaying correctly

## v1.2.2

### Added
- Added a new 'Tizen' privilege: 'Media Storage' that gives access to the TV's internal storage
- Added additional detailed logging for debugging purposes

### Changed
- Improved existing logs for better debugging and understanding

### Fixed
- Refactored code for improved readability and maintainability

## v1.2.1

### Added
- Introduced a new 'Mouse Emulation' feature for gamepad input
- Added snackbar notifications for mouse emulation state changes
- Implemented logic to handle mouse movements with the Left Stick
- Implemented logic to handle mouse scrolls with the Right Stick
- Implemented logic to handle mouse buttons with the Face Buttons

## v1.2.0

### Added
- Introduced 'AV1' as a new video codec option in the 'Video codec' settings
- Implemented logic to handle server codec mode support checks
- Added the High Level 5.1 profiles for AV1 and AV1 Main10 codecs

### Fixed
- Fixed navigation issues when switching between views

## v1.1.20

### Added
- Added a new 'Tizen' metadata: 'Voice Guide' which disables the voice guide in the app
- Implemented navigation to go to the previous or next row in 'Hosts' view
- Added a navigation delay for the bitrate slider when adjusting the value
- Implemented navigation to go to the previous or next option in 'Settings' view

### Fixed
- Refactored code for improved structure and readability

## v1.1.19

### Added
- Added a new 'Tizen' privilege: 'Fullscreen' which allows the application to use the full screen view
- Disabled the 'Continue' button to prevent multiple connection requests when adding a host
- Re-enabled the 'Continue' button upon successful, failed or cancel processing when adding a host

### Changed
- Enhanced visual styling across multiple elements in the application

### Fixed
- Fixed a navigation issue to ensure proper bound checking for previous/next row

## v1.1.18

### Added
- Added a FUNDING file to enable project funding based on supported model platforms
- Implemented logic to handle focus for the active element based on the IP address switch state

### Changed
- Enhanced navigation controls for the 'Add Host' dialog view
- Updated implementation logic to initialize IP address fields with predefined values

### Fixed
- Fixed navigation issue after removing a host, preventing focus from shifting out of view

## v1.1.17

### Added
- Introduced a new 'IP address field mode' setting to change the field mode when entering the IP address
- Implemented functionality to toggle and save the preferred mode for the IP address field

### Changed
- Enhanced the 'Add Host' dialog to provide two different IP address fields
- Improved navigation for the 'Add Host' dialog view to support both IP address fields

## v1.1.16

### Added
- Added additional navigation controls for special cases
- Added the ability to remove a host by pressing 'Channel Up/P+' (remote) or 'Select/Back' (gamepad) while hovering over the host
- Implemented a rumble vibration effect when the gamepad is connected

### Fixed
- Minor bug fixes and general improvements

## v1.1.15

### Added
- Added a new 'Restart' icon for the 'Restart App' button
- Introduced a 'Restart App' button for instant application restart
- Added additional query parameters for launch and resume requests

### Fixed
- Refactored code for improved structure and readability

## v1.1.14

### Added
- Added a new 'Drop Down' icon for multi-select buttons

### Changed
- Adjusted the size of the 'Add Host' and 'Host Container' icons for better visibility
- Changed the color of the 'Power Off' icon to white as the default
- Enhanced the visual stylization application-wide

## v1.1.13

### Added
- Expanded settings: Reintroduced '90 FPS' frame rate option
- Added bitrate presets for '90 FPS' frame rate option

### Changed
- Improved visibility and readability of tooltips
- Improved snackbar design for enhanced user experience

## v1.1.12

### Added
- Introduced a new 'Video codec' setting that allows selection of video codec
- Implemented functionality to select, save, and initiate the stream with the preferred video codec
- Introduced a new 'Restart Moonlight' dialog and its corresponding view
- Implemented functionality for handling the 'Restart Moonlight' with confirmation dialog
- Added a navigation view for interacting with the new 'Video codec' setting

## v1.1.11

### Added
- Added snackbar notification to warn user to restart app after restoring default settings

### Changed
- Updated the icon of the 'Quit Running App' button for improved appearance
- Improved the snackbar notifications when quitting the running app to provide better clarity
- Upgraded H.264 codec from High Level 4.2 to High Level 5.1 profile

### Removed
- Removed audio encryption flags from stream configurations

### Fixed
- Minor bug fixes and general improvements

## v1.1.10

### Added
- Added bitrate presets for '120 FPS' frame rate option
- Added workflow for automated Docker image publishing

### Changed
- Optimized Dockerfile using multi-stage build to reduce Docker image size

### Fixed
- Fixed gamepad button mapping issue with 'X' and 'Y' buttons

## v1.1.9

### Added
- Added a new 'Power Off' icon for the 'Exit App' button
- Introduced a 'Exit App' button for immediate application termination

### Changed
- Enhanced the visual stylization of the 'Settings' container

### Fixed
- Fixed control navigation issues in multiple views

## v1.1.8

### Added
- Introduced a new 'Restore Defaults' button in the 'Settings' navigation bar
- Introduced a new 'Restore Defaults' dialog and its corresponding view
- Implemented a function to reset all settings to their default values
- Implemented functionality for handling the 'Restore Defaults' with confirmation dialog

## v1.1.7

### Added
- Added a new 'About' category that contains a 'System Info' button as a placeholder
- Added three new 'Tizen' privileges that grant access to app and system information
- Implemented functionality to load system information in the 'System Info' button
- Implemented all navigation views for full interaction within the 'Settings' container
- Implemented navigation to go to the previous or next category in 'Settings' view
- Implemented functionality to handle category clicks and show the settings options in the right pane

## v1.1.6

### Added
- Introduced a new 'Settings' button and created a 'Settings' container
- Implemented functionality for managing the 'Settings' container
- Grouped all settings categories and added them to the left pane of the container
- Expanded settings: Reintroduced '120 FPS' frame rate option

### Changed
- Increased the maximum bitrate slider for the bitrate menu from '100 Mbps' to '120 Mbps'
- Grouped and migrated existing settings options to the right pane of the container
- Converted all settings using 'Material Icon Toggle' to the 'Material Switch' for improved appearance

## v1.1.5

### Added
- Introduced a new way to stop the streaming session using the RED key on the remote control
- Implemented a reusable function for terminating the application

### Changed
- Improved host deletion functionality

### Fixed
- Minor bug fixes and general improvements
- Refactored code for improved structure and readability

### Dependencies
- Updated 'moonlight-common-c' module from `3ed3ba6` to `48d7f1a`

## v1.1.4

### Added
- Added gamepad timestamp for accurate detection of valid gamepads

### Changed
- Rearranged elements for improved structure
- Minor enhancements in visual stylization application-wide

### Fixed
- Fixed header display issues during the loading of host and game views
- Refactored code for improved structure and readability

## v1.1.3

### Changed
- Improved the header style for better appearance
- Updated the navigation logo and title to dynamically change based on the current view
- Enhanced the visual presentation of the host and game grids
- Enhanced the appearance of buttons in the navigation bar

### Removed
- Removed unnecessary media queries from the styling

## v1.1.2

### Changed
- Changed the root directory name for the build package
- Updated directory paths for certain core files

### Removed
- Removed all unnecessary core files of the 'ChromeOS' version
- Removed all unnecessary code components of the 'ChromeOS' version

### Fixed
- Fixed spelling errors in the code

## v1.1.1

### Changed
- Decreased the maximum bitrate slider for the bitrate menu from '150 Mbps' to '100 Mbps'
- Improved text readability of the 'Pairing' and 'Support' dialogs
- Improved the stream settings structure for better clarity

### Dependencies
- Updated 'tizen-studio' tool from v5.1 to v5.5

## v1.1.0

### Changed
- Updated stream configurations to align with the latest versions of modules

### Dependencies
- Updated 'moonlight-common-c' module from `50c0a51` to `3ed3ba6`
- Updated 'opus' module from v1.4 `82ac57d` to v1.4 `c854997`

## v1.0.20

### Changed
- Improved audio synchronization for a better streaming experience
- Reverted the order of combination keys for keyboard to the previous configuration for stopping streaming sessions
- Adjusted the bitrate presets for each resolution and frame rate options
- Improved the structure of the 'Wasm Player' and added comments to improve code clarity and understanding

### Removed
- Temporarily removed the '90 FPS' and '120 FPS' frame rate options due to functionality issues causing screen freezes

## v1.0.19

### Added
- Added additional TV key buttons and associated key codes
- Added and included a favicon created for the homepage
- Added snackbar notifications for gamepad connection and disconnection events

### Changed
- Improved navigation functionality for both remote control and gamepad input methods

### Removed
- Removed the sound effects to resolve a black screen issue occurring during stream startup

## v1.0.18

### Added
- Added a validation for 'IP Address' input field which allows only a maximum of 15 numerical characters
- Implemented the action of clearing the 'IP Address' input field after successful processing

### Changed
- Minor enhancements in visual stylization

### Fixed
- Fixed the gamepad disconnection issue
- Fixed the 'Volume UI' issue where it would not appear when changing the volume on the TV
- Refactored code for improved structure and readability

## v1.0.17

### Added
- Added a new 'Tizen' privilege: 'IME' which allows entering characters and symbols into text field
- Implemented navigation to go to the previous or next row in 'Apps' view

### Changed
- Improved error handling for missing audio capture device

### Fixed
- Fixed navigation blockage caused by bitrate slider sticking issue in 'Hosts' navigation bar

## v1.0.16

### Added
- Added additional app icon sizes
- Introduced sound effects to enhance the app experience

### Changed
- Minor enhancements in visual stylization

### Fixed
- Refactored code for improved structure and readability

## v1.0.15

### Added
- Added a snackbar notification for offline hosts
- Implemented logic to handle the Left Stick axis for in-app navigation
- Implemented a delay for smoother in-app navigation

### Changed
- Changed bitrate to custom presets for more options
- Updated tooltip text for all 'Settings' options

### Fixed
- Fixed spelling errors in the code

## v1.0.14

### Added
- Expanded settings: Introduced '90 FPS' and '120 FPS' frame rate options

### Changed
- Increased the maximum bitrate slider for the bitrate menu from '100 Mbps' to '150 Mbps'
- Updated server codec and video format

### Fixed
- Fixed focus navigation issue for settings items
- Fixed bitrate presets for '90 FPS' and '120 FPS' frame rate options
- Fixed the order of combination keys for both keyboard and gamepad buttons to stop streaming sessions

## v1.0.13

### Changed
- Updated all core implementation files for 'Tizen'

### Dependencies
- Updated 'opus' module from v1.1.3 `f6f8487` to v1.4 `82ac57d`

## v1.0.12

### Added
- Introduced a new 'Rumble Feedback' feature for gamepad input

### Changed
- Updated video codecs to a newer version
- Updated all core implementation files for 'ChromeOS'

### Removed
- Removed the 'SLOW_AUDIO_DECODER' condition to resolve a garbled audio playback issue occurring at the beginning of the stream

## v1.0.11

### Added
- Introduced a new 'Support' button and a new 'Support' dialog
- Added the QR code to 'Support' dialog which redirects to a guide
- Implemented functionality for handling the 'Support' dialog

### Changed
- Minor enhancements in visual stylization application-wide

## v1.0.10

### Added
- Introduced a new button: 'Remove All Hosts' in the navigation bar
- Implemented functionality for handling the 'Remove All Hosts' with confirmation

### Fixed
- Fixed control navigation issues in multiple views
- Refactored code for improved structure and readability

## v1.0.9

### Added
- Introduced a new 'Pointing Device' feature for mouse input
- Added tooltip for 'Back' icon button
- Enhancement the UI: Added 'Overlay' for all dialogs

### Changed
- Enhanced overall visual stylization application-wide

## v1.0.8

### Added
- Disabled text selection highlighting application-wide

### Changed
- Reverted a change and added comments for improved code clarity
- Optimized control navigation application-wide

### Fixed
- Refactored code for improved structure and readability

## v1.0.7

### Added
- Enhanced card hover styles for better appearance

### Changed
- Aligned 'Add Host' and 'Hosts PC' text to the center
- Increased the font size application-wide for better readability
- Changed the text content in the 'Pairing' dialog for better clarity
- Improved the readability of dialog texts and snack bar logs

## v1.0.6

### Added
- Enhanced button focus styles for better appearance

### Changed
- Adjusted the width of dialogs application-wide
- Adjusted padding for title and content text in dialogs
- Increased the width of the input field in the 'Add Host' dialog
- Adjusted dialog buttons to increase their size

## v1.0.5

### Added
- Introduced a new 'Exit Moonlight' dialog
- Implemented dynamic handling for 'Exit Moonlight' dialog
- Show 'Exit Moonlight' dialog via 'Back' button on 'Hosts' view

## v1.0.4

### Added
- Added comments to improve code clarity and understanding

### Changed
- Updated '480p' resolution setting
- Updated default bitrate setting from '10 Mbps' to '20 Mbps'
- Reordered 'STOP_STREAM_BUTTONS_FLAGS' buttons

## v1.0.3

### Added
- Expanded settings: Introduced '480p' resolution option
- Added bitrate presets for '480p' resolution option

### Changed
- Changed default bitrate presets and resolution settings from '720p' to '1080p'

## v1.0.2

### Changed
- Updated the 'Frame Pacing' icon for better appearance in the Settings menu
- Enhanced dialog and error messages application-wide

### Removed
- Removed extra white spaces and code formatting

### Fixed
- Fixed spelling errors in the code

## v1.0.1

### Changed
- Dockerfile has been updated for the build process
- Updated widget name and description
- Improved app logo icons for enhanced appearance in the Smart Hub

## v1.0.0

### Added
- Expanded settings: Introduced '1440p' resolution option
- Added bitrate presets for '1440p' resolution option
- Added a new 'Tizen' privilege: 'TV Audio' which allows to change the volume in the application
- Expanded TV key functionality to allow changing the volume from the remote control
- Implemented 'STOP_STREAM_BUTTONS_FLAGS' condition to specify a combination of buttons on the gamepad for stopping streaming sessions
