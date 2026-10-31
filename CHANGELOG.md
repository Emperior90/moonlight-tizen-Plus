# Changelog

All notable changes to this project will be documented in this file.

## Unreleased (Moonlight Plus)

### Added
- Added a 'Samsung S90C optimization' button that shows the optimal streaming settings for the S90C with a bitrate matching the network connection of the TV, and applies them on confirmation
- Introduced a new experimental 'Reference frame invalidation' setting to recover from packet loss without a full keyframe (HEVC and AV1)
- Added session totals of network frame drops and recovery keyframes (excluding the keyframes the app requests itself when the video track opens or the HDR metadata changes) to the performance stats, along with the network connection of the TV
- Added detection of the Ethernet or Wi-Fi connection of the TV with a warning above 80 Mbps over the 100 Mbps Ethernet port
- Added warnings when selecting H.264 above 1080p (also at startup when a stored H.264 codec meets the new 4K default) or 4K above 120 FPS, which exceed the video decoder of the TV
- Added an optimization plan for the S90C covering the network, host, TV settings and test procedure (now archived as `docs/profiles/S90C/S90C-Optimierungsplan.md`)
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
- Added a one-page quick guide for setting up and testing the S90C (now archived as `docs/profiles/S90C/S90C-Kurzanleitung.md`)
- Added German release notes for the first full release (now archived as `docs/profiles/S90C/RELEASE_NOTES_v1.19.0-s90c.1.md`), which list every change since Moonlight Tizen 1.19.0 and which parts are specific to the S90C
- Added automated tests (`tests/`) that pin the current behaviour before the app is generalized for other Samsung TVs: Node unit tests of the platform scripts, Playwright tests of the UI in Chromium with a simulated Samsung TV (model, panel, HDR, Tizen version, network connection, stored settings) and a stub of the WebAssembly module, and native gamepad tests built with g++ and the address and undefined behaviour sanitizers; the S90C settings are golden values, and known bugs (gamepad Select and Start in the menus, menu gamepad polling, mouse emulation, rumble longer than 5 seconds, the update check for tags with a suffix) are marked as todo tests
- Added a CI workflow (`tests.yml`) that runs the tests on every push and pull request, together with checks that the scripts running on the TV stay within ES2018 (Chromium M69 on Tizen 5.5), that no EM_ASM block has a comma outside parentheses, which Emscripten 1.39 can't handle, and that the locale files are in sync with the UI and translated to Brazilian Portuguese
- Added a version of the stored settings (`settingsSchema`) with a one-time snapshot: on its first start with this version, an existing install stores the value it showed so far for every video setting it never changed (the panel resolution up to 4K, 60 FPS, HEVC, HDR on HDR-capable TVs, 75 / 100 / 80 Mbps over Ethernet / Wi-Fi / an unknown connection, all frame rates unlocked), so that the new defaults never change an existing install silently. On Tizen 5.5 the game mode stays unstored, so that its switch stays disabled unless the WASM player offers the Ultra Low Latency mode
- Added tests for the TV profile and the settings snapshot: unit tests over Full HD, 4K and 8K panels with and without HDR, Tizen 5.5 to 9.0 and every connection type, golden tests of the S90C values, a check that no recommendation for a Full HD TV exceeds 50 Mbps, and browser tests of existing installs (snapshot taken once, identical second start, a stored 120 FPS kept), of a fresh install whose unique ID is created before or after the settings load, and of a TV whose product APIs fail
- Added what the app detected about the TV to System information: the panel (Full HD, 4K or 8K), HDR support, the current network connection type, the tested profile that matches the model, and the model year that the model group suggests (only shown, never used for a decision)
- Added a warning when HDR is switched on for a TV that doesn't report HDR support
- Added tests for read errors of the stored settings, for the dialogs and the resolution menu during a translation pass, and for the game mode on Tizen 5.5 after 'Restore Defaults' and the optimization button; the test of the '[Unsupported]' label is no longer a todo test
- Added tests for the generic optimization button and the warnings: unit tests of the warning rules (frame rates above 60 FPS, HEVC and AV1 level 5.1 and 5.2, HDR, the decoder cap, the Ethernet port, H.264), which also check that the S90C keeps the warning of every resolution, frame rate and bitrate, browser tests that the dialog lists exactly what it applies on every simulated TV and connection and that the remote keys reach the button, and a check that the app mentions the S90C only in its internal IDs, its tested profile and its display name
- Added the connected gamepads to System information (name, standard or non-standard layout, number of buttons and axes, rumble support and the controller type that the stream announces to the PC, which names the detected type as well when the 'Controller type sent to the PC' setting overrides it, e.g. 'PlayStation (setting, detected: Xbox)'), and logged the same fields when a gamepad connects or disconnects (with the detected type) and when the stream announces it to the host, instead of an empty '{}'
- Added a notice, once per controller after the app started, when a gamepad reports a non-standard button layout, which the TV uses for a controller it has no mapping for (e.g. an 8BitDo controller in D-input mode, or a newer controller on an older TV), so that some of its buttons may be wrong
- Added tests for the gamepad in the menus: Select and Start, the repeat of a held D-pad and stick counted with a simulated clock (16 moves in 2 seconds, also with jittering sticks), the menu gamepad polling, the controller type of the menus and the stream checked against one list of ids, the log line of a controller announced at stream start, and browser tests with simulated standard and non-standard controllers; the gamepad tests of the menus are no longer todo tests
- Added a 'Controller type sent to the PC' setting to the input settings (Auto, Xbox, PlayStation or Nintendo, Auto by default), which tells the host which controller to emulate for every gamepad, e.g. a DualShock 4 with PlayStation button prompts in games on Sunshine, for a controller whose type the app doesn't detect
- Sent the touchpad click of PlayStation controllers (button 17) to the host as the touchpad button, and the Share or Capture button of other controllers as the misc button, and announced it for controllers that report 18 buttons or more
- Added a notice, once per controller, when a gamepad can't rumble on the TV (it has no vibration actuator, or the TV refuses the effect)
- Added tests for the gamepad during a stream: native tests of the mouse emulation on a simulated clock (the toggle, the controller state it leaves on the host, the mouse buttons of two controllers, scrolling, the reset for a new stream), of button 17, of the controller type setting and of the type detection on its own (`wasm/controller_type.hpp`), unit tests of the rumble on a simulated actuator and clock (a 12 second rumble played 3 times, reset when the host stops it, at the end of the stream and on disconnect, one notice for an actuator that refuses), and browser tests of the new setting and of the rumble with simulated controllers; the gamepad tests of the stream are no longer todo tests
- Added tests for the branding and the release tooling: the version comparison of the update check (also with the tags of earlier releases of this fork and malformed versions), the display name, description, version and icon format of `res/config.xml` and the header, the S90C check of the app extended to `res/`, and the metadata step of the Dockerfile run on a copy of the app, including the repository that the built app checks for updates
- Added a check whether the WASM player of the TV offers the Ultra Low Latency mode that 'Game mode' asks for, read from `tizentvwasm.availableApis` and `isApiFeatureSupported()` the way the glue code of Samsung's Emscripten SDK decides it; an older WASM player without `availableApis` counts as not offering it, with the API level 0 or 1 that the glue code derives from its classes, since the glue code never uses the mode there. When the TV says clearly that it doesn't, the 'Game mode' switch stays off and disabled whatever is stored (the stream used the Low Latency mode anyway), the remote explains why and the dialog of 'Optimal settings for this TV' says so; when it doesn't say clearly, the rules by Tizen version stay, including Tizen 9.0 and the ForceGM hint. On Tizen 5.5 a WASM player that offers the mode lets the switch be turned on, which still starts off, and the dialog of 'Optimal settings for this TV' then lists 'Game mode off', which Continue applies. System information shows the answer and the API levels of the WASM player
- Added a check of the video decoders through `MediaSource.isTypeSupported()` with the codec strings of the video track (H.264, HEVC and HEVC Main10, AV1 and AV1 Main10 at levels 5.1 and 5.2), whose answers only count when a made-up codec is rejected and H.264 is accepted. System information shows them as Yes, No or Unknown, and a counting No for AV1 in 8 and 10 bits labels the AV1 entry of the codec menu 'may not be supported by this TV'; it stays selectable
- Added tests for the runtime checks: unit tests with simulated `tizentvwasm` and `MediaSource` objects (each shape that the glue code distinguishes, answers that fail or disagree, the S90C values with each answer), a check that the probed codec strings are exactly those of `wasmplayer.cpp`, native and unit tests of the message about a rejected video track against a shared fixture, and browser tests of the game mode switch, System information, the AV1 label and the message
- Added English documentation for other users: a README for Moonlight Plus (what it is, its main improvements, the requirements, which file to install and how, that it installs next to the regular Moonlight app, and support through the issues of this fork), a guide for every TV class (`docs/GUIDE.md`: installation, the 'Optimal settings for this TV' button with a table of its recommended bitrates, finding the bitrate, System information, the performance statistics, Sunshine settings for NVENC, AMF and Quick Sync, the ForceGM variant and the game mode, HDR, audio, the background stop, known limits, troubleshooting, and the manual update from v1.19.0-s90c.1) and a page about controllers (`docs/CONTROLLERS.md`: supported controllers and modes, the buttons in the menus and the stream, the controller type, rumble and mouse emulation). The README credits Moonlight Tizen and attributes its history and thanks to it, without the badges, the announcement and the donation links of its maintainer
- Added English release notes for the pre-releases (`docs/RELEASE_NOTES_DEV.md`) and for the full release 1.19.100 (`docs/RELEASE_NOTES_STABLE.md`), which list every change since Moonlight Tizen 1.19.0 by area, say which parts are specific to the tested S90C profile, and tell installs of v1.19.0-s90c.1 to install 1.19.100 once by hand
- Added a bug report form for this fork (`.github/ISSUE_TEMPLATE/bug.yml`, replacing `bug-report.yml`) that asks for the app version and file, the TV model, the Tizen version, a photo of System information, the network connection, the host GPU and encoder, the controller and the steps, and pointed the contact links of the issue forms to the guide of this fork and to Moonlight Tizen for the regular app
- Added tests for the documentation: the table of recommended bitrates in the guide is checked against the TV profile, every local link and anchor of the README and the documents must exist, the release notes have no level 1 or 2 headings and no relative links, which the release description and the update dialog can't use, and the release descriptions that the workflows build are read back by the update dialog, also for upstream releases
- Added a 'Rescan network' button to the Hosts header that scans the local network for hosts again, e.g. for a PC that came online after the app started or got a new IP address. The remote reaches it with UP from the host grid and OK, a gamepad with the D-pad and A. As at startup, the background polling of the known hosts pauses while the scan runs and resumes afterwards while the hosts are shown, and a second press during a scan starts no second one; a press during the scan at startup joins that scan, and the polling resumes with one poll loop per host. The idea comes from the fork of fidoboy (moonlight-tizen-ac3); the code is new
- Added audio lines to the performance stats, also for the default EMSS backend: the codec, channel layout and packet duration that the host negotiated (e.g. 'Opus 5.1 surround (6 channels), 5 ms packets'), which shows whether a 5.1 or 7.1 stream really arrives, the data rate of the audio packets, the session total of audio packets that the network lost and the audio FEC couldn't repair, and the errors of the Opus decoder and the audio player of the TV once there are any. The vendored moonlight-common-c doesn't expose its audio FEC counters (upstream added them later in a larger rework of its statistics), so the lost packets are counted where they reach the decoder
- Named the ports of the host PC in the message of a connection stage that failed, e.g. 'RTSP handshake failed (error 10060)' followed, in a paragraph of its own, by 'Check that the firewall of the host PC and your router don't block these ports: TCP 48010, UDP 48000, UDP 48010', and in the message of a stream that received no video (UDP 47998 and UDP 48000), with the port lists of `LiGetPortFlagsFromStage()`, `LiGetPortFlagsFromTerminationErrorCode()` and `LiStringifyPortFlags()` of moonlight-common-c. These lists name the default ports, so for a host with another port setting they are moved like the RTSP port in the session URL of the host, which the stream connects to (e.g. TCP 50021, UDP 50011 and UDP 50021 for the RTSP handshake of Sunshine with the port 50000); a list that would leave the valid port range gives the message without ports. The message of a failed stage is now translated as a whole
- Added tests for the changes of 1.19.101: the routes of the box art server of the Smart Hub preview service with traversal attempts (`..`, percent-encoded dots and slashes, backslashes, absolute paths, other extensions), the crypto source and format of the pairing PIN and the random IDs, the Embind patch run on an excerpt of the generated JavaScript of a release build (also showing the heap write of the original code), native C tests of moonlight-common-c (the RTSP option list, the loss reports of the RTP video queue for multi-block frames, the port lists) with a small C test runner in `tests/native`, native tests of the audio lines and the port message, the quit of a running app in the UI, the Roboto files read from their WOFF2 character maps, the translation of the new overlay lines and messages, and the Rescan network button with the remote and a gamepad
- Added a Stream Menu, opened during a stream with the Play/Pause key of the remote (also Play and Pause, registered one by one so that a TV without one of them keeps the others) or by holding Select + Start on a controller for 1 second: Resume, Performance statistics on or off, Mouse emulation on or off (with a controller connected, also with the setting off), the Windows key, Alt + Tab, Alt + F4 and Esc for the PC (each key pressed and released again in reverse order with its modifier flags, so that no modifier stays held), Disconnect, and Disconnect and quit the app on the PC, which quits the app once the stream ended. It sits on the right of the picture inside the safe area, and the stream keeps playing. While it is open, the remote and the controllers move through it like through the other menus, and the PC gets nothing from them: the keys stay in the UI, the pointer is released, the keyboard keys and mouse buttons that the PC still held are released there, and the WebAssembly module sends every controller released and no mouse buttons (`setStreamMenuOpen()`); buttons still held when it closes reach the game only after they were released, and so does the key that closed it (e.g. OK held on Resume), whose auto-repeat would otherwise press Enter on the PC without releasing it, or send Esc for RETURN. When the Mouse emulation entry goes while it is selected (the mouse emulation turned off with no controller connected any more), the entry before it is selected, not the Windows key. RETURN, Play/Pause and B close it, and RED and YELLOW keep working. The idea of a Stream Menu on Play/Pause and the order of the key presses come from the fork of fidoboy (moonlight-tizen-ac3), which took the menu from Diogo8500 (brightcraft/moonlight-tizen PR #177); the menu, the controller combo and the input handling are new
- Added a menu for the tiles of the app list, opened with CH+ or Play/Pause on the remote and Select on a controller, which the header of the app list names: Resume and Quit app for the running app, Start for the others, Hide app or Show app again, and Show hidden apps. Hidden apps are stored on the TV per host, matched by ID or title so that an app stays hidden when Sunshine gives it a new ID, and left out of the Smart Hub tiles; Show hidden apps shows them dimmed with a Hidden badge, the running app always shows, and a host whose apps are all hidden shows all of them. Deleting a host forgets its hidden apps. The running app has a visible Running badge. Opening another app list closes the menu, e.g. a Smart Hub tile picked while it was open, so that it stays over neither the new app list nor the stream of the tile
- Added tests for the Stream Menu and the app menu: native tests of the controller combo (opened once per hold and never seen by the game, the replay of a Select, a Start or a Select + Start that isn't the combo, a Select or Start pressed with another button, the stop and statistics combos and the mouse emulation hold next to it), of the controllers while the menu is open and of the buttons held when it closes, native tests of the keyboard keys and mouse buttons released on the host when the pointer lock ends, unit tests of the key combinations, the hidden apps and the entries of the app menu and of the media keys of the remote, and browser tests of both menus with the remote and simulated controllers (also the auto-repeat of a held key that closed the Stream Menu, the selection when its Mouse emulation entry goes, and a Smart Hub tile picked while the app menu is open), of the connection error dialog with the port hint as its own paragraph, and of Rescan network during the scan and the first polls at startup
- Added the Manrope font as the font of the interface (SIL Open Font License 1.1, its licence ships as `wasm/static/fonts/Manrope-OFL.txt`): a 17 KB variable subset with the weights 500 to 800, the letters of Latin-1, the punctuation of the UI, kerning, tabular figures and the f-ligatures. Roboto stays the fallback, also for the rare symbols left out of the subset (e.g. £, ½ and ×)
- Added tests for the new interface: the stylesheet within the CSS of Chromium 69 and animating only transform and opacity, every icon a used symbol of the sprite referenced with `xlink:href`, no Material icon left, the Manrope face against the character map of its font file and every character of the UI texts, and on the rendered page the hero (also with the focus in the header, a dialog or a menu, and with a real mouse pointer resting on the page), the hints of the host cards, the box art in the tiles, the hero and on the start screen, the ambient light, the focus ring on light box art, the Running and Hidden badges, the settings rows in English and Brazilian Portuguese, the section colors, the value tiles of the optimal settings dialog, the stream profile chip, long dialogs on 4K TVs in Brazilian Portuguese, the host menu, the Add Host fields, the pairing PIN, the update button, the Stream Menu and the app menu; some of them read the colors of the rendered pixels
- Added patch notes (`docs/PATCH_NOTES.md`) that list every version of this fork, newest first, with a one-sentence summary, what an installer must know, how it was tested and a few short bullets per version, linked from the README and from the line of links of every release description; a test keeps a section for every release and for the version in `res/config.xml`, newest first, with a date for every release, at most 4 headings and 15 bullets of one line (115 characters) each and summary and install lines of at most 160 characters, and the promotion of a pre-release stops while the section of its version still says Pre-release
- Added a silent second start of a stream that ended without any video right at its start (error -100, 'No video received from host'), which happens when the host is too slow for the first start, e.g. while it switches its display to 4K HDR or to a virtual display: the launch screen stays, and after 1.5 s the app is resumed and the stream started once more without a message. Only once per launch, never while Moonlight is in the background and never after a stream that the user ended; RED cancels it as any start, and the message with the ports of the host PC shows if the second start ends without video as well or can't reach the host. A rumble that the host turned on during the first start stops before the second one, as at the end of a stream, since the host sends no 0 for it to the new session. An idea of StreamLight (FoggyBytes/StreamLight, `StreamSegue.qml`), which retries the same way
- Added the setting 'Continuous audio from the host' to the Audio Settings, on by default, which asks the host in the launch and resume requests to keep sending audio during silence (`continuousAudio=1`, Sunshine from v2026.516.143833 on with fbcf2116; older hosts and other host software ignore it), so that the audio player of the TV and the link to a soundbar don't run dry and the audio statistics count only real losses. moonlight-tv sends the same parameter (1cd208b). Switched off, the request is exactly the one of earlier versions, for an A/B test; Restore Defaults turns it on again
- Added 'Alt + Enter' to the keys of the Stream Menu, which switches most Windows games and emulators between fullscreen and a window, pressed and released again in reverse order with the Alt flag like the other key entries (the stream menu of Diogo8500, brightcraft/moonlight-tizen PR #177, offers F11 for this)
- Added tests for these changes: the Wake PC dialog after a failed request with OK and with RETURN, its poll during the end of the scan at startup, the background polling that reaches the PC first, the repeated request, a poll callback that throws, the retry after no video (once per launch, not in the background, cancelled with RED, failing without the host or with another app running, the order of the audio scheduler of Web Audio, the rumble of the first start stopped before the second one and not replayed during it), the setting and request parameter of continuous audio, the Alt + Enter entry, and handlers of the native messages that throw
- Added a compact level to the performance statistics: the setting 'Performance statistics' in the Advanced Settings is now Off, Compact or Full (a stored 'on' of the earlier switch shows as Full), and during a stream the YELLOW key, the entry of the Stream Menu, the controller combo Select + LB + RB + X and Ctrl + Alt + Shift + S step Off, Compact, Full, Off; the Stream Menu shows the level, and the setting keeps the last one for the next stream. Compact shows one line at the top left, where the full statistics are, e.g. '4K60 HEVC HDR · 59.9 fps · 74 Mb/s · RTT 3 ms · Net drops 0.1% · Wait+pacing 6.3 ms': the stream, the frames handed to the video player per second, the bitrate that arrives, the round-trip time, the frames lost on the network in the last two seconds, and the frame wait time plus the frame pacing delay of the full statistics. The module sends the figures of the line as a small JSON object instead of the text (`wasm/compact_stats.hpp`), so the line never parses the translated text, and the overlay shows only the figures of its level. Both levels now sit on the dark surface of the theme with an outline, which keeps the white text readable over bright video, without a blur, and the overlay stays hidden until the first figures arrive instead of showing an empty box. Figures that the module still sends after the end of a stream are ignored, so the overlay doesn't show over the app list, and YELLOW during 'Starting...' steps the setting, which the start request then hands to the module, so both always show the same level. A compact line was asked for in upstream issue #67 and is shown by Artemis, StreamLight and moonlight-tv (f4b1a4a); figures sent next to the text come from the fork of fidoboy (moonlight-tizen-ac3, 262477c)
- Added the regularity of the frame intervals to the full performance statistics (`wasm/frame_intervals.hpp`): 'Host frame intervals' from the capture times of the host, per frame number so that frames lost on the network don't count, and 'TV player frame intervals' at which the frames reach the video player of the TV, each with the standard deviation, the 95th percentile and the share of intervals more than a quarter of a frame off the frame time, over the last two seconds. An even host line with an uneven player line points to the network or the TV, an uneven host line to the PC. The video decoder thread records one number per frame into a fixed array, without a lock, and sums them up once per second while the full statistics show. The idea and the two measuring points come from the fork of samirmartins (moonlight-tizen, ad7f60e and 0ab499b)
- Added tests for the statistics: native tests of the levels (each press one level, also when two threads press at once), of the message of the compact line against a shared fixture (`tests/fixtures/compact-stats.tsv`), of the frame intervals (standard deviation, 95th percentile, the share off the cadence, the restarts after a pause or a step back, the two windows) and of the decoder path of `wasmplayer.cpp` on a simulated stream (nothing while Off, only the figures while Compact, the text with the interval lines while Full), unit tests of the compact line, its translation and the stored levels, and browser tests of the setting, the three levels through YELLOW, the Stream Menu and a level that the module reports on its own, the figures that arrive after the end of a stream, YELLOW during 'Starting...', and the place and look of the compact line in English and Brazilian Portuguese
- Added tests for the fixes of the native code: the pairing of `libgamestream/pairing.c` against a simulated Sunshine host with real OpenSSL keys and certificates (`tests/native/pairing_test.c`: the right PIN with SHA-256 and SHA-1, a wrong PIN reported without sending the signed secret of the client, a pairing right after a wrong PIN on a host that keeps its pairing session like Sunshine v2025.924, a host that doesn't know the PIN, a pairing secret signed with another key, oversized and short hex fields, the freed signature through the leak check), the requests of `libgamestream/http.c` with a simulated curl (the answer limits and the log line without the query), the Wake-on-LAN packet with its targets and rounds (`wasm/wake_on_lan.hpp`) and every answer of the native request, mouse movements and wheel ticks added while the input thread sends them (which lost movements in 5 of 5 runs before the fix), the interrupt of a connection setup that a stop ends, an RTSP message cut off inside a header under the address sanitizer, and the EM_ASM blocks that run on the main thread for a native thread, each run with handlers that throw. A native C test can name the options and libraries it needs in a comment line `// Build with: -lcrypto`, and a test that includes OpenSSL or curl is skipped with a notice where their headers are missing
- Added a section on surround sound with a soundbar to the guide (`docs/GUIDE.md`, section 11): what HDMI eARC carries (multichannel PCM up to 5.1 on Samsung TVs from 2021 on, according to Samsung's support page on eARC) and what HDMI ARC and optical carry (stereo PCM only), the settings of the app (5.1 with the EMSS backend, since Web Audio mixes 5.1 down to the two channels of the browser output), of the TV (HDMI-eARC Mode and Digital Output Audio Format on Auto) and of the soundbar (the Standard sound mode, not Surround or Adaptive Sound), a check of each channel with the 5.1 speaker test of Windows on the Steam Streaming Speakers of Sunshine, and why the app has no Dolby passthrough yet (no Dolby encoder in Sunshine, at least 27 ms more delay, untested on the media player of the TV). The order Stereo first, then 5.1, follows the guide of the fork of fidoboy (moonlight-tizen-ac3, `docs/Troubleshooting-Guide.md`), which adds Dolby with a test build of Sunshine. A test checks the statements of the section about the app against its code. The guide also explains the new message about a wrong pairing PIN
- Added `sendText()` to the WebAssembly module (`Module.sendText(text)` in JavaScript), which sends a text typed on the TV to the host as Unicode text during a stream with `LiSendUtf8TextEvent()` of moonlight-common-c, whatever the keyboard layout of the PC (the native part of typing on the PC with the on-screen keyboard of the TV, as in Artemis and StreamLight). A text goes whole or not at all: up to 1024 bytes of well-formed UTF-8 without control characters (`wasm/text_input.hpp`); the result tells why a text wasn't sent (no stream, empty, too long, invalid, input queue full). The text is never logged, since it can be a password
- Added tests for the update of moonlight-common-c and the text input: native tests of the RTSP parser of upstream aeba988 (header names in any case, whitespace around a value, a bare LF as line end, a status line without a reason phrase, strict status codes and CSeq numbers, header lines without a colon, a middle option inserted again, the terminating null of a serialized message, and every message parsed from a buffer of its exact size under the address sanitizer), of the input send thread of moonlight-common-c run on the test thread (`tests/native/input_stream_test.c`: a text on the keyboard channel in order with the key presses, 32 bytes per packet for Sunshine without splitting a code point or pausing, one code point per packet after the pause for GameStream, and key presses that a moving mouse no longer holds back), of `sendText()` with valid, empty, too long, malformed and control texts, and checks of the code of the commits that need a network connection
- Added a German interface (de-DE), which a TV set to German (also de-AT, de-CH and de-LU) shows on its own and which Settings → UI Settings → *Language* offers as *Deutsch*. It addresses the user with the informal *du* and uses the words of the German UI of Samsung TVs (*Fernbedienung*, *Einstellungen*, *Controller*, *koppeln*, *WLAN*); the key names stay as printed on the remote and the gamepad (OK, RETURN, Play/Pause, CH+, SELECT). About 280 of its texts are based on the German translation of fidoboy's fork moonlight-tizen-ac3 (`wasm/static/locales/de-DE.json`, GPL-3.0), rewritten from *Sie* to *du* and to the terms of this app; the others are translated for Moonlight Plus. The glossary of the German terms, the rules for every language and the steps to add a text or a language are in the new `docs/TRANSLATING.md`
- Added a Spanish (es-ES) and a French (fr-FR) interface, which a TV set to Spanish (also es-MX, es-US, es-AR and the other Spanish of the Americas) or French (also fr-CA, fr-BE and fr-CH) shows on its own and which Settings → UI Settings → *Language* offers as *Español* and *Français*. The Spanish texts address the user with the informal *tú* in a neutral European Spanish that Latin American users understand (*equipo* or *PC* for the host, *mando* for a controller, *mando a distancia* for the remote, *Ajustes*, *vincular*, ¿ and ¡ before a question or an exclamation); the French texts use *vous*, as French TV menus do (*PC*, *manette*, *télécommande*, *Paramètres*, *associer*), with a no-break space before : ; ? ! and inside « ». In both, the key names stay as printed on the remote and the gamepad (OK, RETURN, Play/Pause, CH+, SELECT, START) and the arrows and the colour keys get the words of the language. About 340 Spanish texts are based on the Spanish translation of Moonlight Tizen (brightcraft, 6191a93, `wasm/static/locales/es-ES.json`) and about 340 French texts on the French translation of fidoboy's fork moonlight-tizen-ac3 (`wasm/static/locales/fr-FR.json`, GPL-3.0), both adapted to the terms of this app (e.g. *transmisión* instead of *retransmisión*, a typographic ellipsis); the others, among them every text of this version, are translated for Moonlight Plus. The Manrope subset of the app gained the four characters that the two languages add (¿, ¡, « and », 396 bytes), and `docs/TRANSLATING.md` has the glossaries of both languages
- Added tests for the Spanish and French texts (`tests/unit/spanish-french-texts.test.js`): the *tú* and the *vous*, the punctuation of each language, the terms of the glossaries, the key names, and the names of the settings and menu entries that a text refers to; in the browser, the language of a Spanish, Mexican, French and Canadian TV, *Français* chosen with the remote and *Español* with a gamepad, every `data-i18n` text of the page translated in every language, and System information in Spanish and French (`tests/browser/language.test.js`)
- Added tests for the languages: the list of languages (only English and the chosen languages, each named in its own language and with its locale file), the language that a language tag of the TV or the browser gets (`tests/unit/i18n-locales.test.js`), the German texts (the informal *du*, the terms of the glossary, the key names, the names of the settings that a text refers to; `tests/unit/german-texts.test.js`), the checks of `i18n-check.js` themselves, and in the browser the language of a German, Austrian, Swiss, Portuguese, Italian and British TV, the language menu with the remote and a gamepad, a stored language against the language of the TV, every `data-i18n` text of the page as a key of the locale files, the pairing dialog and System information in German, and the tooltips of the header buttons inside the screen in every language (`tests/browser/language.test.js`). The layout tests of the settings rows, the badges, the compact statistics line and the font now run in every language of the app; the simulated TV of the tests takes the language of the TV (`locale`, e.g. `de_AT`)
- Added a *Bitrate* entry to the Stream Menu: it shows the bitrate of the stream, LEFT and RIGHT (or the D-pad) change it in steps of 5 Mbps from 5 Mbps up to the decoder cap of the TV (`getDecoderCapMbps()`: 100 Mbps for the tested S90C profile, 80 Mbps for other 4K and 8K TVs, 50 Mbps for Full HD TVs), and OK reconnects with the new bitrate: the stream ends without quitting the app on the PC, the start screen shows *Reconnecting with … Mbps*, and the app is resumed with the new bitrate a moment later. Since the bitrate goes to the host with the start of a stream, this works with every host. The new bitrate becomes the bitrate setting, as if chosen with the slider; OK on an unchanged bitrate only explains how to change it, RED cancels the reconnect, and an app that no longer runs on the PC (closed or crashed there meanwhile, or another app runs) ends it with a message instead of being launched anew. The idea of reconnecting for a changed setting comes from StreamLight (`app/gui/StreamSegue.qml`)
- Added *Type text…* to the Stream Menu, which opens a text field with the keyboard of the TV (as the field of the Add Host dialog does) and types its text on the PC with `sendText()` of the module when the *Done* key of the keyboard, Enter of a USB keyboard or *Send to the PC* is pressed, e.g. for a login or a search without a USB keyboard on the PC. RETURN, the *Cancel* key of the keyboard and B return to the Stream Menu without sending anything. While the field takes the text, every key goes to the field and none to the PC (the Stream Menu stays open, so the controllers stay away from the PC as well), and a held key that closes it stays away from the PC until it is released. A text that can't be sent (empty, more than 1024 bytes of UTF-8, a lone surrogate or a control character, or an answer of the module that it wasn't sent) keeps the field open with the reason. The text is never logged or kept: only the answer of the module is logged, and the field is emptied whenever it closes, also at the end of the stream. The keyboard of the game menu of Artemis and of StreamLight 8.0.0 suggested it
- Added a slim graph above the full performance statistics: one bar per second for the round-trip time over the last 60 seconds, in the colour steps of fidoboy's graph for a local network (below 5 ms, 5 to 9 ms, 10 to 19 ms, 20 ms or more; moonlight-tizen-ac3, GPL-3.0, 441d5c0) on a scale that grows with the highest value, a red mark for every second with frames lost on the network, and gaps for the seconds without figures. It is drawn on a small canvas once per second when the text of the full statistics arrives; its figures come with that text (the round-trip time and the frames lost in the stats window that just ended, on the first line of the `StatMsg: ` message, `FormatFullStatsMessage()` in `wasm/compact_stats.hpp`), instead of a message of its own every second as in the graph of fidoboy's fork (262477c, 5bc0c57). The graph starts again with a new level of the statistics and with every stream
- Added the setting *Statistics position* to the Advanced Settings (top left, top right, bottom left or bottom right; top left by default), which places the compact line and the full statistics in that corner of the screen, inside the safe area. At the top right the connection warnings move to the top left. *Restore Defaults* resets it. The four corners come from the fork of fidoboy (moonlight-tizen-ac3, 5bc0c57)
- Added tests for the new entries of the Stream Menu, the graph and the corner of the statistics: unit tests of the steps of the bitrate entry and its limit on each TV class, of the check of a text for the PC against the answers and the limit of `wasm/text_input.hpp` (UTF-8 bytes, lone surrogates, control characters), of the keys that the text field leaves to the field and of its log line (`tests/unit/stream-menu-entries.test.js`), and of the point of the graph read from the messages of a fixture shared with the native test (`tests/fixtures/stats-graph-points.tsv`), its colour steps in the colours of the theme, its 60 slots with gaps and its scale (`tests/unit/stats-graph.test.js`); native tests of the message of the full statistics with the point of the graph and of the frames lost in one window; and browser tests of the bitrate entry with the remote and a gamepad on three TV classes, the reconnect with the new bitrate, its cancel and its failures, the text field with typed keys (none reaching the stream), the Done and Cancel keys of the keyboard of the TV, its errors and the end of the stream (`tests/browser/stream-menu-entries.test.js`), the graph read back from the pixels of its canvas, and the four corners with the remote, after a restart, in German and Brazilian Portuguese and after Restore Defaults (`tests/browser/stats-graph-position.test.js`). The test of the Stream Menu now also checks that every entry and the hint show without scrolling
- Added favorites to the app menu: *Add to favorites* puts an app first in the app list and the Smart Hub tiles of its host, with an amber star in the top right corner of its tile and a *Favorite* chip at the top of the screen, and *Remove from favorites* takes it back. The favorites are stored per host and matched by their title (by the ID only for an entry without a title), so an app stays a favorite when Sunshine gives it a new ID, while an app that got the old ID of a favorite, or a second app with the same title, is never taken for it; deleting the host forgets them. The idea of the favorites and the recently played apps comes from the library of the fork of samirmartins (moonlight-tizen, GPL-3.0, `console-library.js` of 97bfe5c)
- Added hints for the hosts Apollo and Vibepollo: their *Terminate* tile, known by its UUID, starts without the question to quit the running app first, and its answer 410 'App terminated.' shows as information ('… ended the running app.') instead of 'Error 410: App terminated.'; a 410 that asks to launch again within 60 seconds to confirm (Vibepollo) shows the words of the host. When the host answers a start with 'Permission denied', or the app list is the single tile *Permission Denied* (ID 114514) that a device without the permission to list apps gets, the app starts nothing and explains to allow *List Apps*, *Launch Apps* and the input permissions for this TV in the web UI of Apollo or Vibepollo (Apollo `src/nvhttp.cpp`, Vibepollo `src/nvhttp.cpp` and `src/remote_session.cpp`; StreamLight also treats 410 as a message, `app/streaming/session.cpp`). The guide has a section on both hosts (`docs/GUIDE.md`, section 8)
- Added tests for the library of the app list and the box art: unit tests of the order of the apps (the favorites first in each of the four orders, Recently played, equal titles in the order of the host also with a sort that mixes up equal elements, as that of Chromium 69 does), of the favorites and the recently played apps per host and of the true of the earlier switch (`tests/unit/app-library.test.js`), of the queue of the HTTP thread with a stub of the module (box art behind every other request, at most two box art downloads, the box art of a list that was left, the drop when a stream starts, timeouts, a canceled pairing, a request that fails to start; `tests/unit/box-art-queue.test.js`) and of the answers of Apollo and Vibepollo (`tests/unit/apollo-hosts.test.js`); browser tests of the favorites and the setting with the remote and a gamepad, the Smart Hub tiles, Recently played after starts of streams and the names in German and pt-BR (`tests/browser/app-library.test.js`), of the box art with a real NvHTTP host (`tests/browser/box-art-queue.test.js`) and of the Terminate tile, a 410 that asks to confirm, a 403 'Permission denied' and the Permission Denied tile with the XML of Apollo (`tests/browser/apollo-hosts.test.js`). The tests of the app menu and of Restore Defaults include the new entries and the new setting
- Added a report of each stream to System information (*Last session*): how long it ran, the codec, resolution, frame rate and bitrate, the frames lost on the network and dropped by the TV, the recovery keyframes, the FEC repairs and the WASM heap at the end, with up to three hints in plain language on what to try (e.g. a lower bitrate or a cable for frames lost on the network, a lower bitrate, resolution or frame rate for frames the TV dropped, *Reference frame invalidation* for many recovery keyframes with HEVC or AV1). The module sends the report from the thread that ends the stream, so the main thread never waits for it. With the report and several controllers System information can be taller than the screen: it then keeps to the height of the screen, and UP and DOWN scroll its lines while it is selected before they move to the next row. The idea comes from the fork of samirmartins (moonlight-tizen, GPL-3.0, 1d8f2e3 and bcdcda5, diagnostics.js); the report and its hints are new
- Added a diagnostic log (Settings → About → *Diagnostic log*) with the lines of the current and the previous session: those of the app and those of the module, which the module keeps in a ring of fixed size (`wasm/diagnostic_log.hpp`) that a line enters with `try_lock` only, so that the video decoder, audio and receive threads never wait for it; a line that finds the ring busy is counted instead, and a line repeated within a second is counted instead of kept again. The log stays in memory and on the screen, with the pairing PIN, the remote input keys, the unique ID of the TV (in a request, in the lines about a host such as `client UID:` and in its stored value, and wherever it appears once the app has read it), the private key of the pairing certificate and the RTSP address hidden, and nothing of it leaves the TV. UP and DOWN scroll it, OK and RETURN close it. The ring, the repeat filter and the hiding follow the fork of mmadej20 (moonlight-tizen-modern, GPL-3.0, diagnostic_log.cpp, log_repeat_filter.hpp and diagnostic_logs.js)
- Added a heartbeat of a stream (a small record in localStorage every 5 seconds, without any key or address), which tells once at the next start that Moonlight ended during the last stream (e.g. after a crash or when the TV was switched off) and for how long the stream had run. It runs from the start of a stream until its end, and also ends when the host refuses the launch or resume (e.g. the Terminate tile of Apollo) or the request fails, so the menus never count as a stream. The idea comes from the fork of mmadej20 (moonlight-tizen-modern, GPL-3.0, c8e446d, stream_watchdog.js)
- Added an *Input test* to the Input Settings: every key of the remote or a keyboard with its name, key code and how long it was held, every connected controller live as a drawing in the style of the icons (buttons, triggers and sticks) with its values, and the media keys of the TV that Moonlight registered and those it leaves to the TV (`tizen.tvinputdevice.getSupportedKeys()`). It reads the controllers only while it is open and registers no keys of its own; RETURN leaves it after showing the key, and on a controller a hold of B for 2 seconds. The idea comes from the forks of Diogo8500 (moonlight-tizen, GPL-3.0, b338488, initKeyDiagnostics) and samirmartins (moonlight-tizen, 5c9d247 and 5cd467d); the code is new
- Added a *Button mapping* to the Input Settings, for every controller or for each connected one, stored by the id of the controller: each of the 16 buttons of the standard layout can press another one or none, and LEFT and RIGHT step through them, with a reset. A connected controller can also calibrate the centre and range of its sticks (no dead zone, which a game applies itself); while the sticks move, the calibration keeps the lowest, highest and last value of each axis instead of every reading, so it can stay open as long as needed. The module maps the buttons and calibrates the sticks after reading them (`wasm/controller_mapping.hpp`), and runs the combos of the Stream Menu, the stop and the statistics on the physical buttons before, so that a mapping can never take them away; the menus of the app always see the physical buttons. The mapping per controller follows the fork of samirmartins (moonlight-tizen, GPL-3.0, 6a7ca6d, controller-mapping.js), the calibration the branch joystick-calibration of the fork of waresz (874e257 and 9940da6) without its dead zone of 8 %
- Added tests for the diagnostics and the input: native tests of the ring of the log (busy lines, repeats, the overwritten lines, line breaks and a UTF-8 character cut at the end of a slot, and the lines of the module that go into it), of the session report and its message against a shared fixture (`tests/fixtures/session-reports.tsv`), of the report at the end of a stream, and of the mapping and calibration against the text that the app stores (`tests/fixtures/button-mappings.txt`), also with the Stream Menu combo and the stop combo on mapped buttons; unit tests of the hiding of keys, PIN and RTSP addresses, the log of two sessions, the hints, the heartbeat, the stored mapping and its migration; and browser tests of System information, the log dialog, the notice after a crash, the input test with the remote and simulated controllers and the button mapping with its calibration
- Added a watch of the upstream projects that Moonlight Plus builds on: the workflow *Check upstream dependencies* (`.github/workflows/check-upstream-dependencies.yml`, started by hand from the Actions tab, with a dry run that only fills the summary of the run; a weekly schedule can be added in the workflow) compares Moonlight Tizen, moonlight-common-c, ENet (the version that upstream moonlight-common-c pins), the release tags of Opus, the commits of moonlight-embedded that touch libgamestream, the Sunshine releases and Sunshine pull request 5917 (Dolby AC-3 and E-AC-3 audio) with the reviewed state in `.github/dependency-baselines.json`, and keeps one issue, *Upstream changes to review*, with compare links and the new commits that have no decision yet. A later run updates that issue instead of opening another one and closes it once everything is reviewed; it keeps the issue open while a project can't be read, and writes no mention of a GitHub user or reference to an issue of this repository from upstream commit titles. The script (`.github/scripts/check-upstream-dependencies.js`) needs no npm packages and only reads the upstream projects; the workflow may only read the repository and write issues. The baseline file records for each project what this fork contains, the upstream state up to which every change has a decision, and each change as taken (with the version of Moonlight Plus that has it) or skipped with the reason, as reviewed on 2026-10-30: all 75 commits of moonlight-common-c from 8599b60 to 5d3c0ec, the 10 commits of Moonlight Tizen after v1.19.0, Opus up to v1.6.1, Sunshine up to v2026.1028.122642 and the head of pull request 5917. The ENet updates after 44c85e1 and libgamestream aren't reviewed yet, so the first run lists them. The idea comes from fidoboy's fork moonlight-tizen-ac3 (GPL-3.0; its check-upstream-dependencies.yml and dependency-baselines.json, 0932daa and 3dbb829), which keeps one reference commit per project without the decisions
- Added tests for the watch of the upstream projects (`tests/unit/upstream-watch.test.js`): the baseline file against the vendored versions of `submodulesVer.txt` and against the upstream commits that the changelog names as ported, the checks of the file (a change with two decisions, a decision without its reason or version, a state that the script can't compare), the script against a simulated GitHub API (new commits on a branch and in a folder, a submodule that upstream moved, new release tags without release candidates, new releases and pre-releases, a merged pull request with a new head, a rewritten history, a project that can't be read, one issue that a later run updates and that is closed once nothing is left, mentions and issue references from upstream text) and as the workflow runs it, against an API on the machine; the workflow runs only when started by hand and may only read the repository and write issues
- Added the sections *Language* (which language the app shows, how to choose another one in Settings → UI Settings, and where to report a wrong text) and *Input test and button mapping* to the guide (`docs/GUIDE.md`, sections 18 and 19)
- Added a stress pass to the layout tests of the languages (`tests/browser/text-stress.js`): the tooltips of the header buttons (also *Quit Running App* and the button of a new update), the Stream Menu, the settings rows, the badges and the button of the optimal settings, the section tiles, the chips of the host cards and the hero, the hint of the app menu, the compact statistics line and the long dialogs are checked once more with every text about 10 % wider (letter spacing on top of the stylesheet), so that a layout that fits by a few pixels fails on the test machine instead of in CI or on a TV. Text metrics differ between machines: the headless shell of Chromium in CI hints the glyphs of Manrope fully (about 4 % wider text than with `--font-render-hinting=none`, which the preinstalled browser of some environments passes), and the TV draws text with its own renderer. The chips and the dialogs are now checked in every language instead of only in Brazilian Portuguese, the tooltips also take one line inside the safe area of the screen, and the title of a settings row stays inside its column

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
- Checked the app sources of the commit of the run against those of the pre-release before the release tag in the promotion, and read the version that the tag must match from `res/config.xml` of the pre-release, so that a version raised after the pre-release is named as a changed app source instead of suggesting a tag that can't work either; changes under `tests/`, which the Dockerfile doesn't copy, no longer block a promotion
- Made the release workflows warn while Issues are turned off or the default branch lacks the issue forms and the guide, which the README, the guide, the release notes and the Support dialog send users to (`.github/scripts/check-support-path.sh`); the warning doesn't stop a release
- Unified the bitrate ladder of the optimization plan (100, 120, 135 and 150 Mbps over Wi-Fi, with one set of pass criteria and a rule for the final value), made its FEC recommendation consistent with the 5 % setup, extended the long-run test to 2.5 hours and explained the remaining performance stats lines
- Described the real correction range of 'Audio clock sync' and what happens without it, and pointed the jitter buffer help to the suggested buffer size in the performance stats
- Used the codec modes reported by the host for the codec negotiation, read again after the launch or resume request because Sunshine probes its encoders then, and offered HEVC with the same bit depth as a fallback when AV1 is selected. A host without AV1 now gets HEVC instead of a 4K H.264 stream without HDR, and a host without 10-bit AV1 gets HEVC Main10 with HDR instead of an AV1 stream that it can only encode in 8-bit (or not at all on older Sunshine versions)
- Reworded the AV1 warning to say what AV1 needs and that the stream falls back to HEVC
- Kept the bitrate when the resolution, frame rate, codec or HDR mode changes, instead of resetting it to the preset. This applies to a bitrate picked by hand and to the recommended bitrate of the optimization button (a fresh install and 'Restore Defaults' follow the presets, see below). The presets follow these settings again after toggling 'Optimize bitrate presets', until the bitrate is changed by hand, which is how moonlight-qt keeps a hand-picked bitrate. On an update, the presets keep following the settings if the stored bitrate was the preset for the stored resolution and frame rate, or if the optimized presets were on. Selecting the current resolution or frame rate again no longer resets the bitrate
- Derived the default video settings, 'Restore Defaults' and the settings of the optimization button and its dialog from one profile of the TV (`wasm/platform/tv_profile.js`): the highest resolution of the panel up to 4K at 60 FPS, HEVC, HDR when the TV reports it, the game mode by Tizen version, and a bitrate for the resolution, frame rate and connection (25 % above the standard preset over Ethernet and Wi-Fi, at most 75 Mbps over Ethernet and 80 Mbps for an unknown connection, and at most 100 Mbps on the tested S90C, 80 Mbps on other 4K and 8K TVs and 50 Mbps on Full HD TVs). 'Unlock all frame rates' is only on by default for a tested model with a high refresh rate panel. The S90C keeps exactly its settings (4K, 60 FPS, HEVC, HDR, 75 / 100 / 80 Mbps, all frame rates unlocked), while e.g. a Full HD TV now starts at 25 Mbps instead of 75 to 100 Mbps
- Let the bitrate of a fresh install and of 'Restore Defaults' follow the resolution and frame rate until it is picked by hand, so that lowering the resolution also lowers the bitrate; the optimization button still keeps its recommended bitrate
- Renamed the 'Samsung S90C optimization' button to 'Optimal settings for this TV'. Its dialog names the model of the TV, says what the settings are based on (e.g. 'Detected: 4K panel, HDR, Tizen 9.0, Wi-Fi') and whether the model was tested, and no longer tells other TVs that they are not an S90C. Over Wi-Fi it suggests raising the bitrate up to twice the standard preset of the resolution, at most to the decoder cap of the TV, instead of a fixed 150 Mbps, and says so when the applied bitrate already reaches the cap; owners of a 4K or 8K TV are told how to unlock the higher frame rates for a 120 Hz panel
- Matched the resolution and frame rate warnings to the TV: on a TV without a tested 120 Hz profile, a stream above HEVC and AV1 level 5.1 (e.g. 4K at 90 or 120 FPS) is told that it needs a level 5.2 decoder, and other streams above 60 FPS (e.g. 1080p or 1440p) that many Samsung TVs have 60 Hz panels; an 8K TV, whose decoder goes beyond level 5.2, gets the 60 Hz panel warning instead of the level 5.2 warning; 4K at 144 FPS is told on every TV that it exceeds level 5.2, the highest level that the app asks the TV for. The S90C keeps its warnings. A selection with another warning now shows it right away, and a warning shows again after the higher frame rates were locked and unlocked
- Started the bitrate warning at the decoder cap of the TV, which it names (100 Mbps on the tested S90C as before, 80 Mbps on other 4K and 8K TVs, 50 Mbps on Full HD TVs), instead of a fixed 100 Mbps
- Limited the bitrate presets on TVs without a tested profile to the highest bitrate that the app recommends for the TV (its decoder cap, and 80 Mbps when the connection type is unknown), with a notice, so that e.g. 4K at 90 or 120 FPS on a 4K TV over Wi-Fi no longer sets 100 or 120 Mbps and then warns about it; the S90C keeps its presets, and the slider still goes up to 150 Mbps
- Named the bitrates that the standard and the optimized presets set for the selected video settings on this TV in the notice about a kept bitrate, instead of the examples for 4K at 60 FPS, which didn't apply on Full HD TVs or over Ethernet
- Reworded the Ethernet texts (warning, preset limit, dialog and performance stats) to say that Samsung TVs usually have a 100 Mbps Ethernet port, with the same limits as before
- Labeled the gamepad of the Navigation Guide 'Gamepad (Xbox layout: A = bottom button)', since the menus and the stream use the button positions of an Xbox controller
- Checked the gamepad combos (end the stream, performance statistics) on the physical buttons before the A/B and X/Y swaps, so they are the same with every swap setting, e.g. the statistics combo takes X, the left button, also with 'Flip X/Y face buttons' on
- Detected the controller type from the vendor of the gamepad first and from its name only after that, and announced 8BitDo controllers and the Xbox-compatible controllers of other vendors ('X-Box' in their name) to the host as Xbox controllers instead of an unknown type, which Sunshine emulates as an Xbox controller as well
- Scrolled with the right stick of the mouse emulation at a speed that follows its deflection (nothing within a rest zone, up to 15 notches per second at full deflection) with high-resolution scroll events, instead of not at all below full deflection and 200 notches per second at full deflection
- Renamed the app to 'Moonlight Plus', described as an unofficial fork of Moonlight Game Streaming for Samsung Tizen TVs, with a 'PLUS' badge on the icon instead of 'S90C'. The package, app and service IDs, the Smart Hub preview port and the preview files stay the same, so it still installs over the current build with its settings and pairing kept
- Numbered the app 1.19.100, the first version of this fork above Moonlight Tizen 1.19.0, with the release tag v1.19.100; each further release raises the version in `res/config.xml`
- Titled the development pre-releases and the promoted releases 'Moonlight Plus' with their tag (e.g. 'Moonlight Plus v1.19.100'), linked the guide (`docs/GUIDE.md`) in their description instead of the installation pages of upstream Moonlight Tizen once it exists, and linked the changelog only when it exists. The promotion now fails with a message unless the new tag is 'v' and the version in `res/config.xml`, which the in-app update check compares with the installed version
- Made a release or development build of the Dockerfile fail with a message when the repository owner or name is missing or has characters other than letters, digits, dots, dashes and underscores, instead of building an app that checks the upstream repository for updates
- Named the codec, resolution and frame rate when the TV rejects the video track of a stream (error -200), with advice for that codec, e.g. 'The TV rejected AV1 Main10 at 3840x2160@60 FPS. Choose HEVC as the video codec.', instead of the generic message, which stays for the other causes of error -200. For H.264 the advice is HEVC or a resolution up to 1080p above 1080p, and HEVC or a lower frame rate within 1080p (e.g. 1080p at 120 FPS)
- Moved the German S90C documents (the optimization plan with its screenshots, the quick guide and the release notes of v1.19.0-s90c.1) into `docs/profiles/S90C/` as the archive of the tested S90C profile, each with an English note at the top (for the release notes of v1.19.0-s90c.1 with a correction: its update check reads the releases of Moonlight Tizen, not those of this fork, as the notes said), and linked them at their new paths in the description of the pre-releases and the promoted releases, together with the controller page
- Showed the release notes in the update dialog as plain text: headings, bullets, numbered items, quotes, bold, italics, links and inline code lose their Markdown marks, images, rules and alert markers are dropped, the text is escaped as HTML, the notes end before the links that the release workflows add, and notes longer than about 20 rows of the dialog, which can't scroll, end with a pointer to the release page
- Titled the releases of the stable workflow 'Moonlight Plus' with their version and built their description like the promotion does, from `docs/RELEASE_NOTES_STABLE.md` with links to the guide and the documents, instead of the requirements, installation pages and donation links of upstream Moonlight Tizen
- Pointed the Support dialog to Moonlight Plus: its title and text name Moonlight Plus and ask to report problems on its issue tracker on GitHub, not to Moonlight Tizen, and its QR code leads to the guide of this fork (`docs/GUIDE.md`) instead of the wiki of Moonlight Tizen; the warning when the game mode is turned on on Tizen 9.0 and newer refers to the section about the ForceGM variant and the game mode in that guide instead of the wiki
- Made Brazilian Portuguese keep the key names as printed on the remote and the gamepad, as the other languages do: RETURN, Play/Pause, PLAY/PAUSE, SELECT and START instead of *RETORNAR*, *Reproduzir/Pausar*, *REPRODUZIR/PAUSAR*, *SELETO* and *INICIAR*, in the navigation guide and in the hints, so that RETURN has one name in every text. A test checks the key names in every language
- Made the progress line of the start screen one translated sentence in each language (*Starting the RTSP handshake...*, a template of its own) instead of a word for 'Starting' put in front of the name of the stage, so French reads *Démarrage : négociation RTSP…* instead of *Démarrage négociation RTSP...* and German *RTSP-Handshake wird gestartet …*; the overline of the start screen keeps its own word, *Wird gestartet* in German instead of *Starte*. The lines of System information and the input test without an entry (*Gamepads: None*, *Tested Profile: None*, *Buttons: None*, *Registered by Moonlight: None*, *Left to the TV: None*) are texts of their own as well, so Spanish and French agree the word with its noun (*ninguna*, *aucune*) and German writes *keine* in lower case
- Translated the texts that stayed English next to translated ones in Brazilian Portuguese: the lines of the 'Optimal settings for this TV' dialog (HDR codec, the settings with unlocked frame rates, game mode on, the Tizen 9.0 note, an unknown connection), the Wi-Fi lines and the frame lines of the performance statistics, the warnings for 90 FPS, H.264 above 1080p and 4K above 120 FPS on a tested 120 Hz profile, the 'New' badge, and the 'Reference frame invalidation' and 'HDR static metadata' settings with their help texts and warnings
- Numbered the app 1.19.101
- Delayed a press of Select or Start alone by 0.1 seconds before it reaches the game, and kept Select + Start from the game while both are held, so that the combo of the Stream Menu doesn't press anything in the game; a shorter press, or a Select + Start that is released before the menu opened, reaches the game afterwards for as long as it was held. A press together with another button, which rules out the combo, reaches the game at once with that button, so that a hotkey with Select as its modifier (e.g. Select + R1 to save a state in RetroArch) still reaches the game in its order, also as a quick tap
- Made Play/Pause of the remote work like CH+ in the menus (the menu of a host or an app), and added it and the Stream Menu combo to the Navigation guide
- Redesigned the interface, which looked like upstream Moonlight Tizen until now ('Spotlight', with the settings rows, value tiles, start screen and icons of a second design, 'Prism'):
  - **Hosts and app list:** the top of the screen shows the selected PC or app in large type, with its state as chips, one sentence on what OK does and the keys to press (OK, UP to the options in the first row of cards, the options key ⋯ in the others). A drawing of a PC changes with the state of the host, and the box art of an app shows uncropped as a poster (or as a banner for landscape art) with an ambient light of three colors of the art, which changes only once the selection rests on the app. Without a selected card the top keeps the last PC or app, or shows a summary of the PCs ('Your gaming PCs', '3 ONLINE', '1 OFFLINE'), and 'Find your gaming PC' only while no PC is saved
  - **Cards and tiles:** host cards with a colored state tile, a status badge and one chip; app tiles that keep the top of 600 x 900 covers, a white focus ring with a dark gap that also shows on light box art, the running app in mint (also on the Hosts screen) with a Running badge, and hidden apps dimmed with a Hidden badge
  - **Header:** a stream profile chip (e.g. '4K · 60 FPS · HEVC HDR') and the network chip of the TV on dark fills that stay readable over bright box art, round icon buttons, the name of the open settings section in its color, the keys of the app menu in the app list, and the count of the update button on its corner
  - **Settings:** colored section tiles with a line on what each holds, rows with the title and control on top and the help text across the row (the label of a switch only where an option has no help text), the section color on the selected row and the switches, opaque rows, and a fade where rows scroll out at the top
  - **Dialogs and menus:** gradient icon badges, pill buttons with red ones for destructive actions, value tiles (resolution, frame rate, bitrate, codec) in the dialog of 'Optimal settings for this TV', a large pairing PIN, Add Host fields with the chevron and the white focus of the theme, a host menu in the look of the app menu with icons and 'Delete PC' in red, and only the text of a long dialog scrolls, so that its title and buttons stay in view. The Stream Menu is an opaque panel on the live video without a blur
  - **Start of a stream:** the box art with the title, the PC and the progress beside it, centred together on the screen for portrait and landscape art and long titles
  - **Platform limits:** no CSS that Chromium 69 (Tizen 5.5) lacks, only transform and opacity move, no blur and no endless animation apart from the loading bar and the icon of a network scan, and nothing painted behind the video of a stream
- Shortened the descriptions of pre-releases and releases to the essentials: `docs/RELEASE_NOTES_DEV.md` and `docs/RELEASE_NOTES_STABLE.md` now give in a few lines which file to install, how to install it (over the earlier build, or next to the regular Moonlight app), what is new since the last release and how it was tested, without a link of their own to the patch notes, and the workflows add only the title, one line of links (commit, patch notes, guide) and, for a pre-release, a one-line warning, instead of the full list of changes, the links to the changelog, the controller page and the German S90C documents and a four-line warning; tests keep both notes within 15 lines, the stable notes within the update dialog, and the descriptions in this form. The stable notes list what is new since the last full release (1.19.101 for 2.1.0, with the changes of the pre-release 2.0.0, which a promotion of 2.1.0 skips), and a test checks them against the dates of the patch notes
- Numbered the app 2.0.0 (Moonlight Plus 2.0), the start of its own version line above the 1.19.x of Moonlight Tizen, with its section in the patch notes and new release notes for the pre-release and the release
- Pointed the links of the README, the guide, the controller page and the issue forms, and the QR code of the Support dialog, to the renamed repository Emperior90/moonlight-tizen-Plus (the old address still redirects)
- Updated the vendored moonlight-common-c with eight commits of upstream moonlight-common-c, keeping the local patches of this fork: a new RTSP parser that reads line by line and checks every read against the end of the buffer (aeba988, which replaces the local fix of an over-read of 1.19.102; a last line that ends at the end of an answer now counts as its end, like the missing CRLF of RTSP over ENet), a DESCRIBE answer without content ending the handshake (0fa805d), an Opus channel count above the maximum refused before the channel mapping is filled (dff1690), the RTT read without the ENet mutex (20c05ed), control messages encrypted in place instead of in a stack buffer of 256 bytes without a size check in release builds (342b106), mouse movements taken in one step before they are sent, so that a mouse that keeps moving can't hold back the input behind it (448b2c6), and text sent on the keyboard channel, in order with the key presses (4a95eb3), with up to 32 bytes per packet for Sunshine instead of one packet per character after a pause of 50 ms (0405384)
- Made the languages of the app one list (`LOCALES` in `wasm/platform/i18n.js`), which the detection, the language menu and the checks use: the language menu names each language in its own language (*English*, *Deutsch*, *Español*, *Français*, *Português (Brasil)* instead of *English (United States)*) after *Auto*, which is translated and shows in the language of the app, and the menu entries carry their `lang` attribute. A language tag of the TV is matched without regard to case, then by its language (de-AT gets German, es-MX Spanish, fr-CA French, pt-PT Brazilian Portuguese), and without an answer of the TV the first browser language that the app has counts, not only the first one. A stored language that the app doesn't have follows the TV like *Auto* instead of showing English
- Made the entries of the Stream Menu a little tighter, so that all of them and the hint fit the safe area of the screen with the two new entries, also with the mouse emulation entry of a controller
- Generalized the silent start once more of a stream after no video (`startGame()` with a kind of restart), so that the reconnect with a new bitrate uses the same path: the launch screen stays, only the app that ran a moment ago is resumed, and the Web Audio scheduler starts after the start request
- Made `tests/tools/i18n-check.js` check every language instead of only Brazilian Portuguese: the locale files must be the languages of `LOCALES`, each language needs its list of texts that stay English (`tests/tools/i18n-same-as-english/<locale>.json`; the list of pt-BR moved there from `tests/tools/i18n-ptbr-same-as-english.json`), and a translation must keep the placeholders, the HTML tags, the line breaks, the leading dash of a help text and the spaces at its start and end, and must not write a character as a reference such as `&amp;`
- Made the setting *Sort the list of apps* (Settings → Host Settings) a menu of four orders instead of a switch for Z to A: *A to Z* (the default), *Z to A*, *Recently played* (the last 20 apps started on the host first, the latest first, then the others from A to Z; kept per host from the starts of streams that the host accepted, never the Terminate tile of Apollo or Vibepollo, starting with the app that earlier versions remembered as the last one opened) and *As on the host* (the order in which the host lists the apps, e.g. after reordering them in Apollo). The favorites come first in each order, and the Smart Hub tiles follow it. An install whose switch sorted Z to A keeps that order. Equal titles now keep the order of the host, since the sort of the browser of Tizen 5.5 doesn't
- Replaced the switches *Flip A/B face buttons* and *Flip X/Y face buttons* of the Input Settings with the *Button mapping*: a switch that was on becomes the same swap for every controller, once, and the start request of a stream carries the mapping (`startStream()` takes a text of the mapped controllers instead of the two switches)
- Numbered the app 2.1.0 (Moonlight Plus 2.1), with its section in the patch notes and new release notes for the pre-release and the release, which list what is new since 2.0.0
- Made the startup scan of the local network quiet: it only logs that it runs (the *Rescan network* button keeps its notices), and it runs and resumes the polling of the known hosts only while the host list shows and no stream starts. Before, it polled the hosts again on the app list, in the settings or during the start of a stream, and could start there itself when the hosts were left before their first polls ended
- Showed the notice of a new version only on the first start that finds it and never during a stream, where it covered the game after a start from a Smart Hub tile; a notice that a stream left out shows at a later start. A failed automatic update check is only logged; *Check for updates* keeps its messages
- Opened the views of the hosts and the settings at once, and the app list as soon as the list of the host arrives, without the fixed wait of 500 ms that each change of view had (inherited from upstream). The auto-repeat of a held OK is ignored, so a press held a little long can't also start the app selected in the next view; right after it stopped a running scan of the network, the app list still waits 300 ms
- Made the host menu list only the entries that can run (*Refresh apps* for a PC that is online, *Wake PC* for one that is offline) instead of disabled ones that took the focus, in the order *Refresh apps* or *Wake PC*, *View Details*, *Delete PC*, *Close*, and open it on its first entry
- Opened the dialogs that confirm quitting the running app, deleting a host or all hosts and Restore Defaults on *No*, so that an OK pressed by mistake doesn't confirm them
- Turned *Rumble feedback* on for a new install and after Restore Defaults. An existing install keeps what it showed: the settings snapshot of settings schema 3 stores the earlier default (off) once when the setting was never switched
- Kept the button mapping and the stick calibration of the controllers on Restore Defaults, like the hosts and the language; *Reset this controller* of the button mapping resets them
- Made A, B, Select and Start of a controller act 50 ms after the press in the menus instead of 150 ms; a move of the left stick keeps the delay of 150 ms against double steps
- Read the controllers in the menus every 16 ms instead of every 5 ms; the repeat of a held D-pad or stick is timed and doesn't change
- Left out the notice of the mouse emulation while the Stream Menu is open, whose entry already shows *On* or *Off*; holding Start keeps the notice
- Merged the lines *TV Model Group* and *Model Year (from the model group)* of System information into one, e.g. *TV Model Group: 23_PONTUSM (model year 2023)*
- Removed the class of the MDL ripple effect from 78 elements, whose ripples the stylesheet always hid, and the rule that hid them; the grey focus circle of the switches stays hidden
- Removed the unused list `buttonsNames` and the sample usage of Samsung from `res/platform.js`, keeping its copyright line
- Made the bitrate presets the recommended bitrates (`presetBitrate()` in `tv_profile.js`): a change of the resolution or frame rate now sets the bitrate that the optimal settings give for it, with the headroom of a known network connection, so that a trip to 1440p and back leaves 4K at 100 Mbps over Wi-Fi on the S90C instead of 80 Mbps, and 1440p and 1080p get 25 % more than the standard presets on every TV with a known connection. The presets stay within 75 Mbps over Ethernet, 80 Mbps for an unknown connection and the decoder cap of the TV, so on the S90C 4K at 90, 120 and 144 FPS gets 100 Mbps over Wi-Fi (before: 100, 120 and 140 Mbps, above the cap where the bitrate warning starts) and 80 Mbps without a detected connection. The two notices that a preset was limited are gone, since no preset goes past these limits any more, and the codec and HDR no longer change the bitrate
- Let the bitrate follow the resolution and frame rate again after *Apply the optimal streaming settings for this TV*, like after a fresh install or Restore Defaults (moonlight-qt keeps a bitrate picked by hand instead). The notice about a kept bitrate names the recommended bitrate and the button
- Ordered the settings by how often they are used, in 7 sections instead of 8: *Basic Settings* (the optimal settings, resolution, frame rate, *Unlock all frame rates* right below the frame rate, which it extends, and bitrate), *Video Settings* (codec, HDR, frame pacing, ultra low latency mode), *Audio Settings*, *Input Settings*, *General* (language, order of the app list, numeric PC address input, removing all PCs; it replaces the *UI Settings* and *Host Settings*), *Advanced Settings* (optimize game settings, full color range, connection warnings, the performance statistics and their position, and at the end a block *Experimental* with *Reference frame invalidation*, *HDR static metadata* and *Decrypt host audio*, whose rows have no badge of their own) and *About*. The internal ids of the sections stay, and no stored setting changes; the hint of the session report for *Reference frame invalidation* names the Advanced Settings
- Renamed settings so that the name says what ON does: *Game mode* is *Ultra low latency mode* (the stored key stays `gameMode`, and the Game Mode of the TV keeps its name), *Audio synchronization* is *Limit audio delay*, *Color range* is *Full color range*, *Host address field mode* is *Numeric PC address input*, *Connection warnings* is *Hide connection warnings*, and the audio backends are *TV media player (EMSS)* and *Browser (Web Audio)*; Restore Defaults shows the translated name of the backend
- Shortened the help texts to about one sentence each, read from 3 m away (e.g. *Audio clock sync* 75 → 30 words, *Optimize game settings* 66 → 21, the ultra low latency mode 59 → 24, *Video HDR* 51 → 32), keeping the one trap of each: HDR must also be on for the display of the PC, and the ultra low latency mode can freeze the picture on Tizen 9 and newer. The codec text no longer speaks of increasing a codec, and the details are in the guide
- Removed the labels of the 12 switches with a help text, which the stylesheet always hid but every locale translated (about 8.5 KB of the locale files), after the meaning of the two that carried one moved into the title and the help text, and the label of *Hide connection warnings*, which its new help text hides now. The three switches without a help text keep their visible label, and the *New* badge of the optimal settings (since v1.19.0-s90c.1) is gone
- Gave quitting the app on the PC one name everywhere: *Quit app on the PC* in the Stream Menu (before *Disconnect and quit the app on the PC*), in the app menu (before *Quit app*), on the button in the header of the app list and in its dialog (before *Quit Running App*). The button in the header only shows while an app runs on the PC, instead of answering *No app is currently running.*, and the header row of the app list leaves it out of the navigation then
- Showed the state of a PC at the top of the hosts screen with the one chip of its card (*Running*, *Online*, *Unpaired* or *Offline*) instead of *Running · Online · Paired*, and the hint of an app that doesn't run says *Start* like its menu, not *Play*
- Shortened the dialog of the optimal settings from 11 to 7 lines: the value tiles show the resolution, frame rate, bitrate and codec, so the text lists the other settings only, and *Tested model* is the end of the line *Detected*. Screen readers read the tiles now, and the buttons are *Apply* and *Cancel* in this dialog (the other warnings keep *Close* and *Continue*)
- Rewrote the navigation guide: the OK key of the remote is called OK (it shared the locale key of the Select button of a controller), the RETURN line says that RETURN sends Esc to the PC during a stream, the Stream Menu line no longer lists outdated entries, RED says that it disconnects while the app keeps running on the PC and cancels a starting stream, one line describes the mouse emulation instead of six *in emulation* clauses, and the lines of CH- (*set the focus on the current item*) and of the TV volume (which the app doesn't handle) are gone. The keys *Navigation guide* and *Navigation Guide*, and *Running* and *RUNNING*, are one key each
- Named things the same everywhere in English and Brazilian Portuguese: *controller* instead of *gamepad* and *PC* instead of *host* (e.g. *Add PC*, *Delete PC* also as the title of its dialog, *PC Details*, *Remove all PCs*), and *mouse emulation* instead of *mouse mode* in every language and in `docs/CONTROLLERS.md`. The notice of a controller that connects or disconnects names it, e.g. *Controller 0 (Xbox Wireless Controller) has been connected.*, and System information lists *Controller N* lines. The French *Basic Settings* are *Paramètres de base*, since *Général* is the new section
- Replaced texts that sent NVIDIA users to GameStream in GeForce Experience, which NVIDIA removed in 2023: a failed connection says *Make sure that Sunshine (or another GameStream host) is running on the PC*, the empty hosts screen names Sunshine, and the pairing dialog no longer has a paragraph for GeForce Experience
- Merged the three texts for H.264 without HDR into one (*H.264 has no HDR, so HDR is off.*) and removed the branch for another codec, which the codec menu can't select; a connection that ends with an unknown error says *The connection to the PC was lost (error N).* instead of *Connection terminated*, so a report names the code; the note of the diagnostic log says that the encryption keys of the stream are hidden, not *the input keys*; and the note after switching *Decrypt host audio* on says that Sunshine works with it but doesn't need it, instead of warning of audio problems
- Trimmed `material.min.css` (Material Design Lite 1.3.0) from 140 KB to 57 KB: `tools/trim-mdl-css.js` removed the rules and selectors that no element of the app can match (colour palettes, grid, footers, typography and the components the app doesn't use), and the file keeps the Apache-2.0 header of MDL with a note of the change. All 75 screenshot scenes were compared pixel by pixel before and after; the only differences were the phase of animations (none with animations off), the generated box art and the random pairing PIN, which also differ between two runs of the same file
- Stopped loading `en-US.json` at every start (twice on an English TV): English is the language of the source texts, so the app needs no dictionary for it. The file stays in the repository for the tools and the translators, and the build leaves it out of the widget like the Node tool `i18n-sync.js`
- Merged the lines *Incoming bitrate from network* and *Configured bitrate* of the full performance statistics into one, e.g. *Bitrate: 61.40 Mbps received, 100.0 Mbps configured*, and removed the line *UDP receive buffer*, which stays the same for the whole stream and is in the log of the stream start. *Worst FEC block* and *WASM heap top* stay
- Built only the decoder of Opus: the 63 files that only its encoder uses (the decoder links none of them) are no longer compiled. `tests/native/run.sh` builds the list of `CMakeLists.txt` and decodes stereo, 5.1 and 7.1 with it

### Removed
- Removed unused files from the widget (about 300 KB installed, 200 KB of the download): the CA bundle `static/curl/ca-bundle.crt` (221 KB; curl looked for it in a file system where it never was, and every HTTPS request pins the key of the host, so the `CURLOPT_CAINFO` line went too), the 8 icons of the Chrome app in `static/icons`, the favicon, the mDNS packet code `mdns-browser/dns.js` that the subnet scan never used, and the commented-out mDNS code of moonlight-chrome in `mdns-browser/main.js` and `index.js`
- Removed dead native code: h264bitstream (only an unused `#include` was left of it), `wasm/profiling.cpp` and its declarations, the NaCl entry point `Init()`, the display message callbacks that moonlight-common-c no longer calls (with the *TransientMsg* branch of `messages.js`), nine members of `MoonlightInstance` that were written but never read, a duplicate `HAS_SOCKLEN_T` and `wasm/CPPLINT.cfg`. The Docker build context leaves out `opus/dnn` (18 MB), which nothing compiles
- Removed the four Material icon fonts (911,828 bytes), their stylesheet and the icon files of `wasm/static/res`; the icons are now 37 stroke icons of one SVG sprite in `index.html`. With the new font and theme, the files that the app installs from `wasm/` shrink from 2,318,085 to 1,542,937 bytes (from 1.39 MB to 0.53 MB in the zip of the package)
- Removed the switch *Continuous audio from the host* of the Audio Settings: every launch and resume request asks the host for audio during silence. The snapshot of settings schema 3 drops its stored value once and logs what it was
- Removed the setting *Optimize bitrate presets* of the Advanced Settings, whose formula aimed below the recommended bitrate (about 45 Mbps for 4K at 60 FPS in HEVC HDR) and which the optimal settings, Restore Defaults and a fresh install turned off anyway, together with `presetBitrateLimit()`, `presetBitrates()` and `getOptimizedPresetBitrate()`. The migration to settings schema 3 drops its stored value once, after logging it, and an install that had it on without a stored state of the bitrate presets keeps the bitrate following the video settings (`schema3Replacements()`); the stored bitrate stays

### Fixed
- Fixed a stream starting anyway after RED was pressed during 'Starting...', without audio and with RED and YELLOW not working, by cancelling the start and ignoring the late reply of the host
- Fixed a repeated stop (a double RED press, the gamepad combo or a termination by the host at the same time) starting a second teardown thread and a second return to the app list, and a stop during a termination by the host tearing the connection down twice at the same time
- Fixed a Smart Hub deep link starting a second stream on top of a running one
- Fixed the performance stats showing 'signal strength: NaN percent' on TVs that report no Wi-Fi signal strength
- Fixed a stream left running in the background when the app was hidden (Home key, another app), which kept the network busy and could make the TV hang when another app started its video. The stream now ends after one minute in the background, or at once when the TV takes the video away from the hidden app (closes its video track for a reason other than a suspension) or the connection is still being set up, so that overlays such as the quick settings can leave it running. A notice says how to resume, and an overlay line counts how often the app was hidden and the video closed during the stream
- Fixed the Smart Hub preview server of this build and the regular Moonlight app competing for the same port (this build uses 8889, and tiles saved earlier are moved to it) and for the same preview image files (this build uses its own file prefix)
- Fixed a blank app at startup when a Tizen or Samsung product API fails or is missing (e.g. a missing privilege or an unusual firmware): every call now falls back to what the app assumed before it could ask, a Full HD panel without HDR and unknown model strings, and logs a warning
- Fixed a start that was still on its way (e.g. the delayed start after quitting another app) starting the stream after the app went to the background
- Fixed every FEC recovery blocking the video receive thread for up to 15 ms or more on a desktop CPU by removing a needless matrix multiply from the Reed-Solomon setup (the output is unchanged)
- Fixed a freeze of up to 120 frames (2 s at 60 FPS) after a wrongly predicted frame loss without reference frame invalidation, as in upstream moonlight-common-c, and a partially received IDR frame leading to a reference frame invalidation request
- Fixed each lost audio packet adding 5 ms to the audio delay of the Web Audio backend by concealing it with one negotiated frame instead of 10 ms
- Fixed the Back key pressing the left mouse button of the host without releasing it once the pointer was locked, and stopped requesting a keyframe on pointer lock
- Fixed the S90C dialog asking to install the ForceGM variant when it is already installed, and the help texts of 'Game mode', 'Optimize bitrate presets' and HDR
- Fixed 'Restore Defaults' turning off the 'Video frame pacing' and 'Host address field mode' settings even though they are enabled by default
- Fixed the resolution and frame rate warning comparing the values as text instead of numbers
- Fixed the warning for 4K above 120 FPS telling every TV that its video decoder supports 4K up to 120 FPS, which only TVs with a 120 Hz panel do; 4K at 90 or 120 FPS on other TVs showed only a general hint
- Fixed a stored setting that the TV can't read stopping the settings after it from loading, and a pairing certificate or unique ID that can't be read leaving the app on its loading screen without a message. A setting that can't be read now shows its default for that start and keeps its stored value, and the loading screen asks for a restart instead of replacing the certificate, which would end the pairing with every host, or the unique ID
- Fixed the '[Unsupported]' label of the resolutions above the panel disappearing at startup, and translated it
- Fixed 'Restore Defaults' and the 'Optimal settings for this TV' button leaving a stored game mode on Tizen 5.5, which doesn't support it: they now turn it off, keep its switch disabled and remove the stored value, like on a fresh install
- Fixed a dialog that opens while the app starts, before its texts are translated, losing its title and text to the placeholders ('Warning')
- Fixed the gamepad Select button throwing an error in the menus and the Start button doing nothing: like CH+ and CH- of the remote, Select now switches the host address field mode and opens the host menu, and Start sets the focus on the current item, as the Navigation Guide says
- Fixed holding the D-pad in the menus moving only once when a resting stick jitters or another button is released: only the input that started a repeat stops it, small stick movements are ignored (a rest zone of 0.15 and changes below 0.05), and a stick held past half deflection repeats steadily even when it wobbles
- Fixed a gamepad that stopped working in the menus after its number of buttons or axes changed (e.g. a controller switched to another mode), which also logged an error 200 times per second, a gamepad that never fired a connection event being ignored by the menus, and the press that wakes a controller being lost
- Fixed the mouse emulation with two or more controllers, where an idle controller released the mouse button that another one held and every controller sent its mouse buttons 200 times per second: the controllers now share one mouse, and a mouse button is sent only when it changes
- Fixed the mouse emulation leaving Start and the sticks held in the game while it is on, staying on into the next stream, and switching back after every further second of holding Start. It now toggles once per hold, the game gets the controller released when it starts and doesn't get the Start of the hold that ends it, and a hold of Start together with Back, LB or RB, which belong to the button combos, never toggles it
- Fixed rumble stopping after 5 seconds while the host keeps it on, since the TV ends every effect after 5 seconds; it is now played again every 4 seconds until the host stops it. Rumble also stops at the end of the stream, when the menus take over again and when the gamepad disconnects, a rumble that the connection still delivers after the end of the stream is ignored instead of vibrating in the menus until the controller disconnects, and a gamepad that can't rumble no longer leaves unhandled errors in the log
- Fixed the in-app update check never announcing a release whose tag has a suffix (e.g. 'v1.19.1-s90c.1'): it now compares the numeric x.y.z version first and then the number at the end of the suffixes when both versions have one, and treats a missing or malformed version as no update. A suffix on the installed x.y.z alone, such as the earlier release 'v1.19.0-s90c.2' for an installed 1.19.0, is no update
- Fixed every Docker build checking the upstream repository for updates instead of the repository it was built from: the build also replaced the placeholder in the check for a missing repository, so that check always found the repository missing and fell back to upstream Moonlight Tizen
- Fixed a file read over the network through the box art server of the Smart Hub preview service, which listens on port 8889 of every network interface of TVs with the preview API (Tizen 5.5 to 6.0): it served any route that started with '/preview-' and ended with '.jpg', also one with '..' segments, from the documents folder. It now answers only a plain preview file name (`^/(preview-[A-Za-z0-9_-]+\.jpg)$`, the pattern of the fork of fidoboy), maps only such routes for the tiles, builds the file path from the checked name alone and answers everything else with 404
- Fixed the pairing PIN, the unique ID of a new install and the UUID of each request to the host coming from `Math.random()`, whose output can be predicted; they come from the cryptographic random generator now (`cryptoRand()`). A unique ID that an install already stored stays as it is
- Fixed a possible heap corruption with a freeze of the app: the JavaScript that Embind generates to read a `std::string` from C++ wrote a zero into the byte after the string and put the old byte back later, which can be the head of the next heap chunk that another of the 20 threads changes meanwhile. The Docker build now patches the generated `moonlight-wasm.js` so that it reads the string by its length without writing (`tools/patch-embind-string.js`, ported from the fork of fidoboy, based on a patch by mmadej20), and fails if it doesn't find the code it replaces exactly once
- Fixed the periodic ping to the host sending 2 bytes of uninitialized stack memory, as in upstream moonlight-common-c e2722dc
- Fixed a stream ending after any ENet disconnect datagram of the right size from any address: only a disconnect addressed to the peer of the session and coming from the host is intercepted now, as in upstream moonlight-common-c 41cedb8
- Fixed reference frame invalidation after a frame lost a whole FEC block: the loss report named the frame the queue expected instead of the lost one and kept the loss of the next frame from being reported, as in upstream moonlight-common-c d85371c
- Hardened the RTSP handshake against a malformed Session header, whose missing token went to `strdup()`, and limited RTSP responses to 1 MB, as in upstream moonlight-common-c 7b026e7, and fixed a memory leak when an RTSP message carries an option twice, as in upstream moonlight-common-c 5ec8397
- Fixed 'Quit Running App' and the quit before starting another app reporting success while the host kept the app running, e.g. one that another device started: the server info is now refreshed once the host answered the quit request (before, the refresh started at the same time and its result was ignored), the quit fails with a message that the app is still running while the host reports it, a failed quit request is reported as well, and the start of the other app no longer follows a failed quit
- Fixed the Roboto font of the UI never loading for Latin text: the latin and latin-ext faces of `roboto.css` pointed at each other's file, so the TV drew the UI in a fallback font wherever Roboto isn't installed
- Fixed a data race on the switch of the performance stats, which the remote, the gamepad combo and the video decoder thread use at the same time: the flag is atomic and flips in one step, and the text of the overlay is guarded while it is formatted and read
- Fixed OK in the Hosts header pressing another button than the focused Settings button right after returning from the settings when a button comes before it (the update button, and now Rescan network)
- Fixed a quit of the running app that couldn't start (the host didn't answer the server info, or no app ran any more) leaving the app list as it was without a message: the app list is refreshed and the failure is reported, and the start of another app that waited for the quit follows when no app runs any more
- Fixed the background polling of a host running twice, with two server info requests every 5 seconds and a timer that could no longer be stopped, after the polling started again while the first request of the previous start was still running (e.g. a quick return to the host list, or Rescan network during the scan at startup): each start is numbered, and only the poll loop of the latest one runs
- Fixed keyboard keys and mouse buttons that were held when the pointer lock of the stream ended staying held on the PC, which repeated a held key until it was pressed again: without the lock their releases don't reach the PC, so they are released there when it ends, e.g. when the Stream Menu opens or Ctrl + Alt + Shift unlocks the pointer
- Fixed the arrow keys scrolling the settings by themselves (40 px per press) on top of moving the selection, which made the list drift and could leave the selected row half hidden at the top after DOWN wrapped from the last row to the first: the arrow keys now only move the selection, which scrolls the selected row fully into view, and keep their own action only in a text field (the address of Add Host) and during a stream
- Fixed the pairing trusting any device that answered at the address of the host, without proof that it knows the PIN: the client now checks the hash in the answer of the host to its challenge (SHA-256, or SHA-1 below server major version 7, over its challenge, the signature of the host's certificate and the secret of the host), never sends its own signed secret when the hash doesn't match, only a secret of random bytes that makes the host end its pairing session (Sunshine up to v2025.924 keeps the session of a client until then and has no /unpair, so the next attempt would fail with 'Out of order call to getservercert'), and the pairing dialog reports 'The PIN entered on ... was wrong' instead of a general failure, as moonlight-qt and moonlight-tv do
- Fixed an answer of the host with a longer challenge response or pairing secret than expected writing past their buffers on the stack while pairing: both are read only with their exact length (48 and 272 bytes) and hex digits, like the certificate of the host, as in the fork of mmadej20 (moonlight-tizen-modern); the signature of the client is freed after the pairing, the hash of a host below version 7 is padded with zeros instead of stack memory, and a value of an XML answer is read after its start tag
- Limited the answers of the host to 4 MiB, and the box art to 16 MiB, instead of letting a broken or hostile answer grow the memory of the WebAssembly module without a limit (an idea of mmadej20 with more generous limits); a larger answer fails with error -8
- Stopped logging the pairing PIN, the remote input key of a stream and the query of every request to the host, which held the remote input key of a launch and the secrets of the pairing (an idea of samirmartins)
- Fixed the Wake PC dialog waiting forever for a host whose MAC address is unknown (00:00:00:00:00:00): the request is rejected at once with 'The PC hasn't reported its MAC address'. The magic packet now goes out 3 times 75 ms apart to the ports 9 and 7 of 255.255.255.255, of the broadcast address of the subnet of the TV (from its address and mask) and of ff02::1, instead of once to port 9, which a network card that sleeps deeply or a switch that only just woke up can miss. The rounds and the subnet broadcast come from the fork of samirmartins (moonlight-tizen), the targets follow moonlight-qt
- Fixed mouse movements and wheel ticks getting lost when they arrived while the input thread was sending the ones before: the two threads now share them through atomic exchanges (an idea of samirmartins), and a movement beyond the 16 bits of a packet goes out in several packets instead of wrapping around
- Fixed a stop during 'Starting...' letting the connection setup run on in the background until the host had set up the whole stream: the stop now interrupts it (`LiInterruptConnection()`, an idea of mmadej20), also when it came before the setup cleared its interrupt flag, so the host stops sooner and a quick restart waits less. A TCP connect or an RTSP receive that is already running can still take up to 15 s
- Fixed the RTSP parser reading 1 to 2 bytes past its buffer when an answer of the host is cut off inside a header (an idea of samirmartins)
- Fixed a JavaScript error in a handler that a native thread calls (a message of the stream, the answer of a request, an audio frame, the gamepads) freezing the whole app during a stream, with a frozen picture, no sound and no input: Emscripten never told the waiting thread that the call ended and stopped running such calls on the main thread at all. Every such call now catches and logs the error, the read of the gamepads every 5 ms only the first and every 1000th time (an idea of mmadej20)
- Fixed the Wake PC dialog staying open after a failed request (e.g. 'Failed to create socket', which some TVs always report, upstream issue #31): OK and RETURN threw a ReferenceError, because the error text existed only inside the handler of the failure, so only a restart of the app closed the dialog. The text now also points to waking the PC with another device, e.g. a Wake-on-LAN app on a phone. After a failed request the button is also selected, so that OK on the remote closes the dialog instead of switching Auto-WOL, which kept the selection before
- Fixed the Wake PC dialog staying open after the PC woke up while its card already showed it online (upstream issue #147): when the dialog polled the PC while the scan of the network at startup ended, the background polling that the end of the scan started emptied the queue of poll callbacks of the host and threw away the one of the dialog. The queue is no longer emptied; each callback is called on its own instead, so that one that throws neither keeps the others from the result nor blocks later polls, which the emptying had worked around. The dialog also closes as soon as the background polling reaches the PC, sends the request again every 10 seconds while it waits, and closes before it stops its tasks (as upstream 0a35dfd)
- Fixed an error in a JavaScript handler of the end of a stream (closing the Stream Menu, stopping the rumble, the screensaver or the audio scheduler) leaving the app in the stream view without a message: each step now runs on its own and logs its error, every message of the native code is handled inside a try/catch, and an answer to a request that no longer waits is only logged (the JavaScript side of the fix above, an idea of mmadej20)
- Fixed the line of CH- / F12 / START in the navigation guide staying English in every language: its `data-i18n` attribute holds `&amp;`, which the browser reads as `&`, while `i18n-sync.js` stored the key with `&amp;`. The sync now decodes the character references of `data-i18n` and `data-i18n-placeholder` attributes, and the Brazilian Portuguese text of that line no longer shows a literal `&amp;`
- Fixed scrolling of more than 6553 wheel ticks between two reports of the input thread (e.g. after the thread was held up) being cut off at the 16 bits of a packet: like a large mouse movement, it now goes out in several packets. The test of the mouse movement between the threads met this on a busy machine and failed now and then
- Fixed texts that stayed English in a translated UI: the buttons Cancel and Close of the pairing dialog (also after a change of the language while the dialog is open), the network connection in System information (*Wi-Fi*, *Ethernet*), and the name of an unknown host in the message 'Failed to connect to the host...'
- Fixed starting, resuming or quitting an app waiting behind the box art downloads of a host whose box art isn't cached yet (a new install, a new host or new apps, worst with large Playnite or Steam libraries): every request runs on the one HTTP thread of the module, and the box art of each app was queued in front of the request that starts the stream. A box art download now waits behind every other request, at most two box art downloads are on their way at once, the box art of an app list that was left or built again is dropped before it reaches the network, and starting a stream drops every box art download, also the one that runs. The box art loads when the app list shows again. Ported from the fork of mmadej20 (moonlight-tizen-modern, GPL-3.0, f4eff8e: the limit of two and the drop); the priority in the queue is new
- Fixed layouts that only fitted by a few pixels in Spanish and French and broke with slightly wider text (as in the CI run): the tooltip of a header button is now measured at its own width (at the middle of a button near the right edge it was squeezed, measured too narrow and then grew past the safe area, e.g. *Cerrar la aplicación en ejecución*) and then placed under its button, flush with the button's right edge near the right side of the screen, so that it stays inside the safe area whatever its length (e.g. *Restablecer ajustes*), and it may be 480 instead of 260 pixels wide, so that every tooltip takes one line; the Stream Menu is 680 instead of 600 pixels wide, and the note of its bitrate entry has a line of its own under the label and the value, so that each label and note takes one line in every language with room to spare; the title of the optimal settings row wraps once it is wider than 668 pixels, with its badge next to it, instead of pushing the button out of the row; the title of a controller in the input test is 19 instead of 21 pixels high, so that a name like *Xbox Wireless Controller* fits without an ellipsis in every language, also with four controllers on the screen; the section tiles of the settings have 12 pixels more for their text and a 1 pixel smaller name; the dialog of the optimal settings is 1400 instead of 1200 pixels wide and the navigation guide as wide as the safe area, so that their text doesn't scroll in any language; and a few texts are shorter: the French button of the optimal settings (*Appliquer les paramètres optimaux pour ce téléviseur*), the French last entry of the Stream Menu (*Déconnecter et quitter l’application du PC*), the hint of the app menu in French (*Options : CH+ ou Play/Pause (télécommande), Select (manette)*), Spanish (*Opciones: CH+ o Play/Pause (mando a distancia), Select (mando)*) and Brazilian Portuguese (*Opções: CH+ ou Play/Pause no controle remoto, Select no gamepad*), the button of the navigation guide in Spanish (*Ver los controles de todos los dispositivos de entrada*), French (*Voir les commandes de tous les périphériques d’entrée*) and Brazilian Portuguese (*Veja os controles de todos os dispositivos de entrada*), the title of the empty hosts screen in German (*Finde deinen PC*) and Brazilian Portuguese (*Encontre seu PC gamer*), the German hint of the button mapping (*LINKS und RECHTS ändern eine Taste. Gilt ab dem nächsten Stream.*), the subtitles *Résolution, FPS et débit* and *Applications et PC enregistrés* in French, *Aplicaciones y equipos guardados* and *Datos del sistema y actualizaciones* in Spanish, and *Resolução, FPS e taxa de bits*, *FPS, avisos e estatísticas* and *Dados do sistema e atualizações* in Brazilian Portuguese
- Fixed one UP from *Resume* in the Stream Menu selecting its last entry, *Disconnect and quit the app on the PC*, which quits the game on the PC without a question: UP and DOWN now stop at the first and the last entry of the Stream Menu
- Fixed the launch and resume requests telling the host stereo whatever the audio configuration (`surroundAudioInfo` was always 0x030002): they now send 0x3F0006 for 5.1 and 0x63F0008 for 7.1, as moonlight-qt does, so Sunshine gives the prep commands of an app the right `SUNSHINE_CLIENT_AUDIO_CONFIGURATION`; the audio itself was already negotiated over RTSP
- Fixed a single failed launch of the Smart Hub service (e.g. right after the install) turning the Preview tiles off for good: only a real answer of the service is stored, and the next start asks again
- Fixed the navigation guide saying that CH+ / Play/Pause / F11 / Select switches the mode of the IP address field, which it never did (inherited from upstream); the line now says that it opens the menu of a host PC or an app, also in `docs/CONTROLLERS.md`

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
