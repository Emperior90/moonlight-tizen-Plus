Moonlight Plus 1.19.100 is the first full release of Moonlight Plus, an unofficial fork of [Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen) 1.19.0 by brightcraft for Samsung TVs with Tizen 5.5 or newer. It installs next to the regular Moonlight app, with its own settings and pairing.

- **Coming from v1.19.0-s90c.1 (Moonlight S90C)?** Its update check looks at the releases of Moonlight Tizen, so it never offers this release, and an update that it announces is the regular Moonlight Tizen app, which installs as a separate app. Install 1.19.100 once by hand. It has the same package ID and installs over the earlier release.
- **New install?** Pair your PC once on the first start, even if the regular Moonlight app is already paired.

### Which file to install?

- **Tizen 9.0 and newer: `Moonlight-ForceGM.wgt`.** It asks the TV for its Game Mode. Keep the *Game mode* switch of the app off.
- **Tizen 5.5 to 8.0: `Moonlight.wgt`.**
- Settings → About → *System information* shows the Tizen version (*Platform Version*).
- Install the file with Apps2Samsung (*Custom WGT File*) or Tizen Studio, as described in the guide.

### Highlights

- *Optimal settings for this TV*: one button applies settings derived from the panel, HDR support, Tizen version and network connection of your TV.
- Warnings, System information and messages that match your TV.
- Smoother video, faster error correction, and clear messages instead of frozen or black pictures.
- Fixes for controllers in the menus and during the stream, rumble and mouse emulation.
- An update check that reads the releases of this fork.

### What is specific to a tested model

Moonlight Plus was first tuned on a Samsung S90C (55-inch OLED, 2023, Tizen 9.0). The app now derives its settings from what your TV reports. Only these parts apply to the S90C alone, through its tested profile, which the app selects when the model name or series contains "S90C":

- 100 Mbps over Wi-Fi as the recommended bitrate and as the decoder cap, where the bitrate warning starts (other 4K and 8K TVs: 80 Mbps)
- *Unlock all frame rates* on from the start (other TVs: off)
- the warnings above 60 FPS: the S90C gets neither the 60 Hz panel warning nor the Level 5.2 warning, only a general hint above 1080p at more than 60 FPS, and a warning at 4K with 144 FPS, which exceeds the 4K at 120 FPS that its decoder handled in the tests
- the archived German tuning guide (`docs/profiles/S90C/`)

Everything else applies to every Samsung TV with Tizen 5.5 or newer, unless an item names a condition such as "only with the Web Audio backend". **Tested profile** marks the items above, and **Experimental** marks new settings that are off by default.

### All changes since Moonlight Tizen 1.19.0

#### App and installation

- The app is called **Moonlight Plus**, with a "PLUS" badge on its icon, and is described as an unofficial fork of Moonlight Game Streaming for Samsung Tizen TVs.
- It has its own package ID, widget ID and service ID, so it installs next to the regular Moonlight app, with its own settings and its own pairing. Builds of this fork from before the rename (*Moonlight S90C*) have the same package ID, so Moonlight Plus installs over them.
- The version is 1.19.100, the first version of this fork above Moonlight Tizen 1.19.0.
- The Smart Hub preview of this app and that of the regular Moonlight app no longer get in each other's way:
  - Moonlight Plus uses its own port (8889 instead of 8888) and its own preview images.
  - Clearing the box art cache leaves the images of the regular Moonlight app alone.
  - Tiles that earlier pre-releases of this app saved are moved to the new port.

#### Settings for your TV

- The defaults of a fresh install, *Restore Defaults* and the new button *Optimal settings for this TV* all come from one profile of the TV:
  - the highest resolution of the panel up to 4K, at 60 FPS, with HEVC
  - HDR when the TV reports HDR support
  - a bitrate for the resolution, frame rate and network connection: 25 % above the standard preset over Ethernet and Wi-Fi, at most 75 Mbps over Ethernet and 80 Mbps when the connection isn't detected, and never above the decoder cap of the TV class (100 Mbps on the tested S90C, 80 Mbps on other 4K and 8K TVs, 50 Mbps on Full HD TVs). A Full HD TV starts at 20 to 25 Mbps, a 4K TV at 75 to 80 Mbps.
  - *Game mode* by Tizen version (on for 6.0 to 8.0, off on 9.0 and newer, off and disabled on 5.5 unless the video player of the TV offers the Ultra Low Latency mode) and by what the video player of the TV offers
  - *Unlock all frame rates* only for a tested model with a high refresh rate panel (**Tested profile**)
- New button **Optimal settings for this TV** (Settings → Basic Settings):
  - Its dialog names the model, says what the settings are based on (e.g. "Detected: 4K panel, HDR, Tizen 9.0, Wi-Fi") and whether the model was tested, and lists exactly what it applies.
  - It gives advice for the connection: over Wi-Fi how far to raise the bitrate (up to twice the standard preset, at most the decoder cap), over Ethernet how to avoid packet loss on the 100 Mbps port.
  - Owners of a 4K or 8K TV are told how to unlock the higher frame rates for a 120 Hz panel.
  - On Tizen 9.0 and newer, it points to the ForceGM variant, or says that it is installed.
  - The settings are only applied after you confirm.
- Existing installs keep their settings: on its first start, an install of an earlier build of this fork stores the value it showed so far for every video setting you never changed, so the new defaults never change it silently. Press *Optimal settings for this TV* to get the values for your TV. On Tizen 5.5 the game mode stays unstored, so its switch stays disabled, unless the video player of the TV offers the Ultra Low Latency mode.
- The bitrate is kept when you change the resolution, frame rate, codec or HDR:
  - This applies to a bitrate you picked and to the one of the button. After a fresh install or *Restore Defaults*, the bitrate follows the standard presets until you pick one yourself.
  - Before, it jumped to the preset on every change of the resolution or frame rate, even when selecting the current value again.
  - After switching *Optimize bitrate presets*, the presets apply again until you change the bitrate yourself, as in moonlight-qt.
  - The first time, a notice explains how to get the presets back, with the bitrates they would set for the selected video settings.
- On a TV without a tested profile, the bitrate presets stay within the highest bitrate that the app recommends for the TV: its decoder cap, and 80 Mbps when the connection isn't detected. For example, 4K at 120 FPS gets 80 instead of 120 Mbps on a 4K TV over Wi-Fi, with a notice. The S90C keeps its presets (**Tested profile**), and the slider still goes up to 150 Mbps.
- *System information* shows what the app detected: the panel (Full HD, 4K or 8K), HDR support, the network connection, the tested profile that matches the model, and the model year that the model group suggests (only shown, never used for a decision).
- If a Tizen or Samsung product API fails or is missing (e.g. a missing privilege or an unusual firmware), the app starts anyway and assumes a Full HD panel without HDR, instead of showing a blank screen.
- A stored setting that the TV can't read shows its default for that start and keeps its stored value, instead of stopping the settings after it from loading. When the pairing certificate or the unique ID can't be read, the loading screen asks for a restart instead of hanging without a message.

#### Picture and video

- *Video frame pacing* (on by default) follows the usual arrival time of the frames. Before, only the one frame that ended a measuring window (1 second) counted, and it could be late by chance.
  - A single late frame no longer holds back the following frames by up to tens of milliseconds.
  - Pacing follows a later arrival time only once two windows in a row confirm it, so the burst of frames after a short network stall doesn't delay the next second.
  - At the end of each wait, the pacing busy-waits for only 0.2 instead of 1 ms, which saves processor time.
- The host encodes each frame as one slice instead of four. That compresses better at the same bitrate, and the decoder of the TV gets whole frames anyway.
- SDR streams use the Rec. 709 color space, the standard for HD and 4K video, instead of Rec. 601 (SD video). HDR streams use Rec. 2020 as before.
- The codec choice follows the codecs that the host can really encode. Sunshine checks its encoders again when a game starts, so the app reads the list again then.
  - If the host can't encode HEVC in 10 bits, the stream runs in 8-bit HEVC without HDR, instead of failing at the encoder.
  - If AV1 is selected and the host can't encode AV1, the stream uses HEVC instead of 4K H.264 without HDR.
  - If HDR is on and the host can encode AV1 only in 8 bits but HEVC in 10 bits, the stream uses HEVC Main10 with HDR instead of AV1 without HDR.
  - When the host has to fall back to another codec or to SDR, the app shows a notice.
  - If the host reports neither HEVC nor AV1, e.g. because its encoder check failed, the app doesn't rely on that list.
  - The AV1 warning says what AV1 needs: an AV1 encoder in the host and an AV1 decoder in the TV.
- For streams with more pixels per second than 4K at 60 FPS (e.g. 4K at 90, 120 or 144 FPS, or 1800p at 120 FPS), the app declares HEVC or AV1 Level 5.2 to the TV, so that it sets up its decoder accordingly. If the TV rejects that, Level 5.1 is used as before.
- New resolution *3200 x 1800 (1800p)* between 1440p and 4K, with bitrate presets. It can only be selected on 4K and 8K TVs.
- The app asks the browser of the TV which video codecs it can decode (H.264, HEVC and HEVC Main10, AV1 and AV1 Main10, at Levels 5.1 and 5.2). The answers only count when the browser also rejects a made-up codec and accepts H.264. System information shows them as Yes, No or Unknown, and a counting No for AV1 labels the AV1 entry of the codec menu "may not be supported by this TV". It stays selectable.
- **Experimental:** new setting *HDR static metadata* (Video Settings).
  - It passes the HDR10 metadata of the host display to the TV with each HEVC keyframe: the color volume and brightness of the mastering display and, if the host sends them, the content light levels (MaxCLL/MaxFALL).
  - The TV can then match its HDR tone mapping to it.
  - Sunshine (at least with an NVIDIA encoder) doesn't write these data into the video stream but sends them over the control channel only, where the app dropped them before.
  - When the metadata arrive or change, the app requests a keyframe so that they take effect at once.
  - It only applies to HDR streams with HEVC. If an HDR stream doesn't start or looks wrong with it, turn it off again.
- The screensaver of the TV is turned off during the stream and on again afterwards.

#### Audio

These items only apply to the *Web Audio* backend (Settings → Audio Settings → *Audio backend*). EMSS stays the default. Web Audio is the alternative, e.g. when the sound crackles with EMSS.

- **Experimental:** new setting *Audio clock sync*.
  - The clocks of the host and the TV never run at exactly the same speed. Without a correction, the audio delay grows to 1.5 times the jitter buffer. Then 5 ms of sound are skipped every few minutes, or a gap as long as the buffer appears when it runs empty.
  - With *Audio clock sync*, the app plays the sound up to 0.05 % faster or slower, which is inaudible, and keeps the delay at the jitter buffer.
  - The help texts of *Audio clock sync* and *Audio jitter buffer* explain this, and point to the buffer size that the performance statistics suggest with *Audio clock sync* after 10 minutes.
- When the sample rate has to be converted, the app uses a cubic instead of a linear interpolation, which keeps the treble better. It converts when the audio output of the TV doesn't run at 48 kHz or *Audio clock sync* is on.
- When the clocks drift apart, the audio delay grows only to 1.5 times the jitter buffer instead of twice. *Audio jitter buffer* now goes down to 25 ms (before: 50 ms).
- After a dropout, the app trims the audio that piled up to the jitter buffer plus two packets. Before, the delay stayed raised for minutes after each dropout. The performance statistics count these trimmed packets apart from the skipped ones.
- Fixed: each lost audio packet added 5 ms to the audio delay. The gap is now filled with exactly one packet instead of 10 ms.
- When the host is silent and Sunshine sends no sound, the statistics and the log no longer count that as a dropout. The sound itself doesn't change.

#### Connection and stability

- Fixed: every repair of the error correction (FEC), which rebuilds lost packets from extra data, held up the receiving of the video data, for about 15 ms on large blocks already on a PC processor, and longer on the TV. A needless calculation is gone; the result is the same, but the repair is faster.
- **Experimental:** new setting *Reference frame invalidation* (Video Settings, HEVC and AV1 only). After packet loss, the picture can recover without the host sending a full keyframe, which avoids traffic spikes and blurry frames. If errors remain in the picture after a frame drop, turn it off again.
- Fixed: when the app wrongly assumed a frame loss, the picture could stop for up to 2 seconds (120 frames at 60 FPS).
  - This affected the default setting without *Reference frame invalidation*.
  - This prediction now only runs with *Reference frame invalidation*, as in the official streaming library moonlight-common-c.
  - With *Reference frame invalidation* on, a keyframe that arrives only in part now leads to a new keyframe request there as well, instead of a repair by reference frame invalidation.
- The app detects whether the TV is connected by Ethernet or Wi-Fi. Samsung TVs usually have a 100 Mbps Ethernet port, so the bitrate presets stop at 75 Mbps over Ethernet, and a warning appears above 80 Mbps.
- The warning "Slow connection to PC. Reduce your bitrate!" only appears for real network losses. When the TV drops frames itself (full queue, after a decoder reset), it stays away.
- Fixed: when Moonlight went to the background (Home key, another app), the stream kept running without limit. That loaded the network and could make the TV hang when another app started its video.
  - The stream now ends after 1 minute in the background.
  - It ends at once when the TV takes the video away from the app, or when the connection is still being set up.
  - A TV menu that is open for a short time, such as the quick settings, therefore doesn't end it at once. If it hides the app for more than a minute, the stream ends as well.
  - A notice explains how to resume: the game keeps running on the host, and selecting it again resumes it.
  - A start that was still on its way (e.g. the delayed start after quitting another game on the host) no longer starts a stream when the app is in the background by then.
- When the buffer of the video player of the TV is full for a moment, the app retries the frame for up to one frame duration. When the player keeps rejecting the video format for 3 seconds, the stream ends with a message. Before, the app requested keyframes forever on a black screen.
- When the media playback of the TV fails during the stream or while the connection is set up, the stream ends with a message. Before, a frozen or black picture remained.
- When the TV rejects the video track of a stream (error -200), the message names the codec, resolution and frame rate, with advice for that codec, e.g. "The TV rejected AV1 Main10 at 3840x2160@60 FPS. Choose HEVC as the video codec." The generic message stays for the other causes of error -200.
- When the streaming engine crashes (the WebAssembly module or one of its threads), a message appears, and Moonlight restarts after it is closed, instead of freezing without a word.
- Fixed: several stops at the same time tore down the connection twice, in the worst case up to a crash of the streaming engine. Causes were e.g. a double press of the RED key, the controller combo and a termination by the host at the same time. Now the app tears down the connection once and returns to the app list once.
- The app checks whether the video player of the TV offers the Ultra Low Latency mode that *Game mode* asks for, the way the code of Samsung's Emscripten SDK decides it. When the TV says clearly that it doesn't, the *Game mode* switch stays off and disabled whatever is stored, a dialog explains why when you select it, and the dialog of *Optimal settings for this TV* says so. An older video player without a list of its features counts as not offering the mode, since the video player code in the app never uses it there. When the TV doesn't say clearly, the rules by Tizen version stay. On Tizen 5.5, a video player that offers the mode lets the switch be turned on, and the dialog of *Optimal settings for this TV* then lists that it turns the game mode off. System information shows the answer and the API levels of the video player.
- The app writes more to the log for troubleshooting, without changing the picture:
  - the size of the UDP receive buffer that the TV grants at stream start
  - whether the TV supports a receive timeout
  - why the TV closed an audio or video track
  - when the video track was reopened during the stream and how many frames were dropped meanwhile
  - when the app is hidden and shown again
  - the rejection reasons of the video player of the TV by name
  - the memory of the streaming engine at the end of each stream

#### Controllers

- Fixed: the Select button of a controller threw an error in the menus, and Start did nothing. Like CH+ and CH- of the remote, Select now switches the host address field mode and opens the host menu, and Start sets the focus on the current item, as the Navigation Guide says.
- Fixed: holding the D-pad in the menus moved only once when a resting stick jittered or another button was released. Only the input that started a repeat stops it, small stick movements are ignored, and a stick held past half deflection repeats steadily.
- Fixed: a controller stopped working in the menus after its number of buttons or axes changed (e.g. a controller switched to another mode), which also logged an error 200 times per second. A controller that never fired a connection event is no longer ignored by the menus, and the press that wakes a controller is no longer lost.
- Fixed: the mouse emulation with two or more controllers, where an idle controller released the mouse button that another one held. The controllers now share one mouse, and a mouse button is only sent when it changes.
- Fixed: the mouse emulation left Start and the sticks held in the game while it was on, stayed on into the next stream, and switched back after every further second of holding Start. It now switches once per hold, the game gets the controller released, and a hold of Start together with Select, LB or RB, which belong to the button combos, never switches it.
- The right stick of the mouse emulation scrolls at a speed that follows its deflection (nothing within a rest zone, up to 15 notches per second at full deflection), instead of not at all below full deflection and 200 notches per second at full deflection.
- Fixed: rumble stopped after 5 seconds while the host kept it on, since the TV ends every effect after 5 seconds. It is now played again every 4 seconds until the host stops it. Rumble also stops at the end of the stream and when the controller disconnects, and a controller that can't rumble no longer leaves errors in the log.
- A notice appears once per controller when it can't rumble on the TV.
- New setting **Controller type sent to the PC** (Settings → Input Settings: Auto, Xbox, PlayStation or Nintendo; Auto by default). It tells the host which controller to emulate for every controller, e.g. a DualShock 4 with PlayStation button prompts in games on Sunshine, for a controller whose type the app doesn't detect.
- The controller type is detected from the vendor of the controller first and from its name after that. 8BitDo controllers and the Xbox-compatible controllers of other vendors ("X-Box" in their name) are announced to the host as Xbox controllers instead of an unknown type.
- The touchpad click of PlayStation controllers (button 17) is sent to the host as the touchpad button, and the Share or Capture button of other controllers as the misc button. It is announced for controllers that report 18 buttons or more.
- The button combos (end the stream, performance statistics) use the physical buttons before the A/B and X/Y swaps, so they are the same with every swap setting.
- A notice appears once per controller when it reports a non-standard button layout, which the TV uses for a controller it has no mapping for (e.g. an 8BitDo controller in D-input mode, or a newer controller on an older TV).
- System information lists the connected controllers (name, layout, buttons, axes, rumble support and the controller type sent to the PC, with the detected type when the setting overrides it), and the log shows the same fields when a controller connects or disconnects and when the stream announces it to the host, instead of an empty "{}".
- The Navigation Guide labels the controller "Gamepad (Xbox layout: A = bottom button)".
- Controller buttons that are still held when a stream ends (e.g. the stop combo) no longer trigger anything in the menus, and a held D-pad doesn't keep scrolling when the stream starts.

#### Menus and messages

- In the bitrate menu, UP and DOWN change the bitrate in 5 Mbps steps, LEFT and RIGHT still in 0.5 Mbps steps.
- New and reworded warnings, which match the TV:
  - On a TV without a tested 120 Hz profile, a stream above HEVC and AV1 Level 5.1 (e.g. 4K at 90 or 120 FPS) needs a Level 5.2 decoder, which most Samsung TVs with a 120 Hz panel have.
  - Other streams above 60 FPS on such a TV (e.g. 1080p or 1440p) are told that many Samsung TVs have 60 Hz panels. An 8K TV, whose decoder goes beyond Level 5.2, gets this warning at 4K too, instead of the Level 5.2 warning.
  - 4K at 144 FPS exceeds Level 5.2, the highest level that the app asks the TV for, on every TV. On the S90C, the warning names the 4K at 120 FPS that its decoder handled (**Tested profile**).
  - 90 FPS doesn't divide the 60 or 120 Hz output of the TV evenly.
  - H.264 above 1080p, which Samsung TVs generally can't decode. It also appears at startup when H.264 is stored with a higher resolution.
  - HDR switched on for a TV that doesn't report HDR support.
  - The bitrate warning starts at the decoder cap of the TV, which it names (100 Mbps on the tested S90C, 80 Mbps on other 4K and 8K TVs, 50 Mbps on Full HD TVs), and over Ethernet above 80 Mbps.
  - A selection with another warning shows it right away, and a warning shows again after the higher frame rates were locked and unlocked.
- Fixed: the resolution and frame rate warning compared the values as text instead of numbers, and appeared in the wrong cases.
- Fixed: *Restore Defaults* turned off *Video frame pacing* and *Host address field mode*, although both are on by default.
- Fixed: *Restore Defaults* and *Optimal settings for this TV* left a stored game mode on Tizen 5.5, which doesn't support it.
- Fixed: the "[Unsupported]" label of the resolutions above the panel disappeared at startup. It is also translated now.
- Fixed: a dialog that opened while the app started, before its texts were translated, lost its title and text.
- Fixed: pressing the RED key during "Starting…" could still start the stream, which then ran without sound, with the RED and YELLOW keys not working. Now the start is cancelled cleanly. A held RED key triggers only one stop or cancellation.
- Fixed: a Smart Hub tile could start a second stream on top of a running one. Now the notice "Stop the current stream first (RED button)." appears.
- Fixed: with a locked mouse pointer, the Back key pressed the left mouse button of the host without releasing it. Locking the pointer no longer requests a keyframe either.
- After a stream ends, the app shows "Loading Apps..." until the app list has loaded.
- The *Support* dialog names Moonlight Plus, asks to report problems on its issue tracker, and its QR code leads to the guide of Moonlight Plus instead of the wiki of Moonlight Tizen. The warning when the game mode is turned on on Tizen 9.0 and newer points to the same guide.
- Reworded help texts:
  - *Optimize game settings* says what the option does with Sunshine: with the display device configuration on, Sunshine switches the host display to the resolution of the stream. With the default setting of Sunshine, the refresh rate follows the selected frame rate anyway, and only modes that the host display offers can be applied.
  - *Game mode* advises keeping the switch off on Tizen 9.0 and newer with both variants.
  - *Optimize bitrate presets* says that it calculates a low bitrate (about 45 Mbps for 4K at 60 FPS in HEVC with HDR), and to keep it off and set the bitrate by hand for the best picture.
  - *Video HDR* says that HDR must also be on for the host display, otherwise the stream is 10-bit SDR.
  - Samsung TVs "usually" have a 100 Mbps Ethernet port, in every text that mentions it.

#### Performance statistics

The performance statistics appear in the stream when *Performance statistics* is on (Settings → Advanced Settings, off by default). The YELLOW key shows and hides them during the stream.

- *Configured bitrate* shows the bitrate set in the app.
- *Host frame rate (30 s)* shows the frame rate of the host measured over 30 seconds, which reveals a host display running at 59.94 instead of 60 Hz.
- Three lines show separately what happens to the frames on the TV: *Average frame receive time*, *Average frame wait time*, and *Pending frames* with the highest count per second.
- The misleading line *Average decoding time* is gone, and the pacing line is called *Average frame pacing delay*.
- New totals over the whole session:
  - *Session frames dropped by network* counts frames lost on the network.
  - *Session frames dropped by the TV* counts the frames that the TV dropped itself (full queue or rejected by the player), with the number of resets of the video playback.
  - *Session recovery keyframes* counts only real recovery keyframes, not those the app requests itself when the video track opens or the HDR metadata change, nor those after a reset of the video playback.
  - Frames that arrive while the video playback of the TV is closed (e.g. while the app is hidden) don't count as network losses.
- A line shows whether the TV is connected by Ethernet or Wi-Fi, over Wi-Fi with the signal strength, refreshed every 5 seconds. If the TV reports no value, the signal strength is left out instead of showing "NaN".
- *Session FEC recoveries*, *Worst FEC block* and *UDP receive buffer* show the repairs of the error correction, how close the worst block came to losing a frame, and the requested and reported UDP receive buffer.
- *TV player rejections* appears once the video player of the TV rejected frames, counted by reason.
- *WASM heap top* shows the memory of the streaming engine, so that a memory leak in long sessions shows up before the app crashes.
- *Moonlight hidden during the stream* counts how often the app was hidden during the stream and how often the TV closed the video.
- With the *Web Audio* backend, new lines show the jitter buffer, schedule lead and browser latency, dropouts and skipped and lost audio packets, and the correction of *Audio clock sync* with a suggested buffer size.

#### Less load on the TV

- The streaming engine is built for speed instead of small size (compiler option -O2 instead of -Os).
- During the stream, the menus no longer poll the controllers every 5 ms themselves, since the stream does that anyway. That relieves the main thread.
- All controllers are read with a single call per poll instead of one call per controller slot, which leaves the main thread more room, e.g. for the sound of Web Audio.
- The controller state is sent to the host only when it changes, plus every 100 ms, instead of 200 times per second. That reduces the traffic from the TV to the host, above all over Wi-Fi.
- With the performance statistics on, the video decoder no longer waits until the menus have processed them.
- Connection warnings no longer hold up the receiving of the video data, and the controller rumble is passed to the menus without waiting.

#### Documentation

- New English documentation: the README, a guide for every TV class (`docs/GUIDE.md`: installation, the optimal settings, finding your bitrate, System information, performance statistics, host settings, HDR, audio, known limits and troubleshooting) and a page about controllers (`docs/CONTROLLERS.md`).
- The German tuning guide, the quick guide and the release notes of v1.19.0-s90c.1 of the S90C are kept as an archive of the tested S90C profile in `docs/profiles/S90C/` (**Tested profile**).
- The bug report form of the fork asks for the TV model, the Tizen version, a photo of System information, the host GPU and encoder, and the controller.

#### Build and release

- The download files are still called `Moonlight.wgt` and `Moonlight-ForceGM.wgt`.
- A release or development build of the Dockerfile fails with a message when the repository owner or name is missing. Before, every Docker build checked the repository of Moonlight Tizen for updates instead of the one it was built from.
- The in-app update check compares the numeric x.y.z version first, so that a release of this fork such as 1.19.100 is announced. A missing or malformed version is never an update.
- The update dialog shows the release notes as plain text, without Markdown marks, and points to the release page when they are longer than the dialog.
- The release workflows run one after the other, so that a release can't get the ForceGM file of another commit.
- Pre-releases and releases are titled "Moonlight Plus" with their tag, and their description comes from the release notes, with links to the commit, the changelog, the guide and the controller page.
- A tested pre-release can be promoted to a full release with its files unchanged. The new tag must be "v" plus the version in `res/config.xml` of the pre-release.
- The release workflows warn while the issue tracker of the fork is turned off or its default branch lacks the issue forms and the guide.
- Automated tests run on every push without a TV: Node unit tests, browser tests of the menus with a simulated TV and simulated controllers, native tests of the controller code, and checks that the scripts stay within the JavaScript of Tizen 5.5 and that the translations are complete.

### New defaults

Moonlight Plus has its own settings, so a fresh install starts with these values, also if you used the regular Moonlight app before. *Restore Defaults* resets to them, and *Optimal settings for this TV* sets the video values in the same way.

- *Video resolution*: 1280 x 720 → the highest resolution of the panel up to 4K
- *Video bitrate*: 10 Mbps → the recommended bitrate for the TV class and connection (see the table in the guide), which follows the resolution and frame rate until you pick one yourself
- *Video codec*: H.264 → HEVC
- *Video HDR*: off → on, on TVs that report HDR support
- *Unlock all frame rates*: off, as before, except on the tested S90C (**Tested profile**)
- *Controller type sent to the PC*: Auto
- New settings *Reference frame invalidation*, *HDR static metadata* and *Audio clock sync*: off
- *Restore Defaults* turns *Video frame pacing* and *Host address field mode* on (before, it wrongly turned both off).
- Unchanged: *Video frame rate* (60 FPS), *Optimize bitrate presets* (off), *Color range* (limited), *Audio backend* (EMSS), *Audio jitter buffer* (100 ms), and *Game mode* by Tizen version.

### Notes and known limits

- The S90C-era changes ran on the S90C of the author. The changes for other TVs and controllers since then (the TV profile, the warnings, the checks of the game mode and the video decoders, the controller fixes and the controller type) were tested with simulated TVs and controllers only, not on real TVs. Reports are welcome on the issue tracker of this fork.
- The Ethernet limits (75 Mbps for the presets, a warning above 80 Mbps) assume the 100 Mbps Ethernet port that most Samsung TVs have.
- The caps of 80 Mbps for 4K and 8K TVs and 50 Mbps for Full HD TVs follow summaries of Samsung's TV video specifications and are careful starting points. The slider still goes up to 150 Mbps.
- If the TV refuses to install the update because the author certificate doesn't match, uninstall the earlier build first, which loses its settings and pairing.
- A release promoted from a tested pre-release keeps its files, so System information shows its version with the commit of the pre-release, e.g. *Moonlight Plus v1.19.100 (pre-1a2b3c4)*. It is the full release all the same.
- The package ID (MLightS90C) still contains the name of the tested model, since changing it would make the TV install a second app and lose the settings and pairing.
- Some pre-releases of this fork from before its first rename replaced the regular Moonlight app and still show as "Moonlight" on the TV. Uninstall them or install the regular Moonlight app over them. Moonlight Plus installs next to them.
- Brazilian Portuguese (pt-BR) is only partly translated, so some texts of this fork appear in English.
