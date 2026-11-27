# Patch notes

What changed in each version of Moonlight Plus, in short, newest first.

- [2.3.6](#236): pre-release, a sound decoder in floating point to test, fewer clock readings and rumble summed up in the log
- [2.3.5](#235): 2026-11-26, keys that reach the PC without RETURN, pairing a PC that dropped the TV again, and sound that catches up after a stall
- [2.3.4](#234): pre-release only, its changes did not come with 2.3.5
- [2.3.3](#233): pre-release only, its changes come with 2.3.5
- [2.3.2](#232): 2026-11-20, a tidier Stream Menu with F keys and PC shutdown, finer frame times, how fast frames arrive, more facts in the log and a fix for recovery keyframes
- [2.3.1](#231): 2026-11-18, lighter sound and statistics, fewer double presses, a switch for sound on Wi-Fi, and fixes from a review and from other Moonlight clients
- [2.3.0](#230): 2026-11-08, smoother motion, a picture refresh in the Stream Menu and a longer guide
- [2.2.1](#221): 2026-11-05, no more 144 FPS, and controllers that work on 2020 TVs
- [2.2.0](#220): 2026-11-03, a tidier app with fixes and a smaller download
- [2.1.0](#210): 2026-10-30, five languages and new tools in the Stream Menu
- [2.0.0](#200): pre-release only, its changes come with 2.1.0
- [1.19.101](#119101): 2026-10-29, a new look and two new menus
- [1.19.100](#119100): 2026-10-26, the first release as Moonlight Plus
- [1.19.0-s90c.1](#1190-s90c1): 2026-10-23, released as Moonlight S90C
- [Base version and details](#base-version-and-details)

**Which file?** `Moonlight-ForceGM.wgt` on Tizen 9 and newer, `Moonlight.wgt` on Tizen 5.5 to 8.

**TV refuses an update?** If the author certificate doesn't match, uninstall the old app first; this loses its settings and pairing.

## 2.3.6

*Pre-release, in testing.* A sound decoder in floating point to test on a TV, fewer clock readings per frame, and a diagnostic log that sums up rumble.

> **Install:** by hand over 2.3.5 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs and hosts only; whether the sound decoder is lighter shows on a TV in *Audio CPU* of the statistics.

### New

- At the start, the diagnostic log tells whether the TV's browser is a 32- or 64-bit one, with cores and version
- At the end of each stream, the diagnostic log tells how many frames the video element of the TV's browser counted

### Changed

- The sound is decoded in floating point, as a test, with a faster rounding: *Audio CPU* shows if it is lighter
- The picture and the sound read the clock fewer times per frame and per packet, which saves the TV some work
- While a game rumbles a controller often, the diagnostic log sums it up once a minute, not two lines per rumble

## 2.3.5

*2026-11-26.* Keys reach the PC without RETURN, a PC that dropped the TV pairs again, and the sound catches up after a stall.

> **Install:** by hand over 2.3.4, 2.3.3, 2.3.2 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs and hosts only; high bitrates, keys and dialogs, controllers while hidden, sound after a stall, the start scan and *Wake PC* need a TV.

### New

- B of a controller cancels a stream that is starting; a USB mouse also scrolls sideways (untested on a TV)
- At a stream's end the diagnostic log gives its average frame receive time and how fast its frames arrived

### Changed

- In a stream the first arrow, OK or keyboard key gives the stream the keys (not Esc, Shift, Ctrl or Alt)
- A PC that dropped the TV (e.g. after *Unpair All*) shows *Unpaired*; OK pairs it again, also while it runs a game
- The engine is built with stronger optimizations; the picture is read from the network as in 2.3.2
- After a Wi-Fi stall the sound catches up on its own: at most 100 ms behind, 300 ms if stalls come again
- *Quit app on the PC* in the Stream Menu asks first, and Exit and Restart open on *Cancel*
- Mouse emulation moves the pointer slowly just past the center, and at shallow angles
- Long messages stay 5 to 15 seconds by their length and make room for the statistics
- No network scan at the start if every PC answers and one is paired; *Wake PC* scans less and says what to check
- Settings buttons line up, the PC details read as a table, and Brazilian Portuguese uses one word for each thing

### Fixed

- CH+, CH-, Source and the color keys no longer press keys on the PC; Ctrl + Alt + Shift + S keeps the keyboard on
- Controllers no longer act on the PC while Moonlight is hidden; Esc works as RETURN, a held RETURN goes back once
- OK and *Quit app on the PC* work while the PC runs an app the TV's list lacks; an empty or failed list says why
- A failed update check no longer waits a day, a stuck loading screen says why, and *Delete PC* deletes its box art

## 2.3.4

*Pre-release only; its changes did not come with 2.3.5, except one log line.* The log tells whether the app or the Wi-Fi limits how fast a frame arrives.

> **Install:** by hand over 2.3.3, 2.3.2 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs and hosts only; the reading of the picture and its log lines need a test on a TV, as do the keys, mouse and pairing of 2.3.3.

### New

- The diagnostic log shows how the app reads the picture and how fast it could, every minute and at a stream's end
- It also gives the average frame receive time of the stream and how fast its frames arrived (kept in 2.3.5)

### Changed

- On a TV whose sockets take no receive timeout, waiting packets are read one after the other, without a check each
- Where they take one, each packet still takes one call, the least there is; about every 64th gets a quick check

### Also in this version

- Everything of the pre-release 2.3.3 below: keys and mouse in a stream, pairing, the app list and messages

## 2.3.3

*Pre-release only; its changes come with 2.3.5.* Arrows and OK reach the PC without RETURN, a PC that dropped the TV pairs again, and the app list gets fixes.

> **Install:** by hand over 2.3.2 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs and hosts only; the keys and mouse of a stream, pairing again after *Unpair All* and the message times still need a test on a TV.

### New

- A USB mouse also scrolls sideways (tilt wheel or touchpad, untested on a TV)

### Changed

- In a stream the first arrow, OK or keyboard key gives the stream the keys (not Esc, Shift, Ctrl or Alt)
- A PC that no longer accepts the TV (e.g. after *Unpair All* in Sunshine) shows *Unpaired*, and OK pairs it again
- Pairing also works while the PC runs a game
- A PC that answers with a different key than at its pairing gets its own message instead of *Offline* advice
- After a stream the box art of the same PC shows at once, and *Refresh apps* says how many apps the PC lists
- Long messages stay 5 to 15 seconds by their length (not 5); they and the Stream Menu make room for the statistics

### Fixed

- CH+, CH-, Source and the color keys no longer press keys on the PC (CH- could type M in games)
- Ctrl + Alt + Shift + S no longer turns the keyboard off, and it or YELLOW held steps the statistics only once
- A mouse click no longer reaches the PC before the movement right before it
- A pairing the PC didn't confirm no longer says it worked, and a PC with a 4096-bit RSA certificate pairs
- A check of a PC that hangs is no longer sent twice, so starts and box art wait less behind it
- OK and *Quit app on the PC* work while the PC runs an app the TV's list lacks; an empty or failed list says why
- RETURN while the PC still quits a game keeps the PC list, and the other app no longer starts
- Messages aren't dimmed by dialogs, the connection warning reads better, and no statistics line is half English

## 2.3.2

*2026-11-20.* A tidier Stream Menu with F keys and PC shutdown, finer frame times, how fast frames arrive, more log facts and fixes.

> **Install:** by hand over 2.3.1 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs and hosts only; the new figures, the log lines and the fixes still need a test on a TV, and the PC commands on a Windows PC.

### New

- A tidier Stream Menu: *Shortcuts…* groups the keys for the PC, and *Function keys…* sends F1 to F12
- *Shut down or restart the PC…* in the Stream Menu and in a PC's menu, for a Windows PC, asks first
- *Full* statistics and *Last session* show how fast frames arrive, e.g. *Frames arrive at: 275 Mbps*
- It is how fast the TV receives a frame, not the bitrate; a TV's Wi-Fi usually stays well below its link rate
- They also show the longest time a single frame took at each step on the TV
- The diagnostic log names what the TV supports of WebAssembly and if its sockets take the network priority
- The start screen names the keys that cancel a start: RETURN or RED (RETURN did nothing there before)

### Changed

- The times of each step of a frame are finer than whole milliseconds (about 0.1 ms where the TV's browser allows)
- Spanish: shorter labels for four lines of the statistics, so they still fit the screen

### Fixed

- A start that the PC doesn't answer, or answers with something unreadable, no longer hangs on *Starting…*
- The TV waits at most 120 seconds for that answer (as Moonlight for PC), then a message says what to check
- An unreadable answer, e.g. from Sunshine after an error, ends the start at once with a message
- RED during *Starting…* returns to the app list within seconds, also while the PC holds the start
- *Session recovery keyframes* no longer counts restarts of the PC's encoder as recoveries (a compiler defect)
- *Average frame pacing delay* no longer rises a little with every frame that the TV's player rejects

## 2.3.1

*2026-11-18.* Lighter surround sound and statistics, fewer double presses, a Wi-Fi sound switch, a sturdier streaming engine and fixes from a review.

> **Install:** by hand over 2.3.0 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs, hosts and controllers only; Tizen 10, sound, controller guards, PC state, pairing and the engine still need a test on a TV.

### New

- *Prioritize sound on Wi-Fi* in the Audio Settings: turn it off if only the sound crackles or drops out over Wi-Fi
- One warning on Tizen 9 or newer if *Ultra low latency mode* is on from before a TV update or from 2.3.0 or older
- After a long session, the last-session report shows if the sound drifted ahead, with a tip when it grows fast

### Sound

- *Surround audio quality* is now *Efficient* unless you chose one; a notice tells you if your stream changes
- With Web Audio the app always asks for stereo: 7.1 no longer loses its dialogue, and 5.1 no longer distorts
- 7.1 at *Efficient* plays every channel from its own speaker; a message when 5.1 or 7.1 keeps the TV too busy

### Changed

- Lighter statistics every 2 s with a 2-minute graph, the app version, frame arrival time and lowest PC frame rate
- The bitrate texts name the latency that more bitrate costs instead of saying to raise it until frames drop
- While a keyframe is on its way, the app no longer asks the PC for another one after every lost frame
- When pairing, the PC sees the TV as *Moonlight Plus (model of the TV)* instead of "roth"
- The guide covers Sunshine of November 2026 and Tizen 10 (untested); Smart Hub service only on Tizen 5.5 and 6.0

### Fixed

- A double OK or A no longer changes a setting; dialogs no longer open twice, trap the keys or lose their selection
- A PC shows its real state at start, not ONLINE from last time; failed starts and silent PCs now give a message
- Streaming engine fixes: quicker recovery after a player hiccup, IPv6 home PCs, the PC's reason when it ends
- Fuller diagnostic log, fewer misleading hints; safer against devices that pose as a PC or send odd details

## 2.3.0

*2026-11-08.* Smoother motion after packet loss, a way to refresh a broken picture, lighter 5.1 and 7.1 sound, and a guide for the best picture.

> **Install:** by hand over 2.2.1 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs, hosts and controllers only; the new frame pacing, the AV1 HDR metadata and *Efficient* surround still need a test on a TV.

### New

- *Refresh picture* in the Stream Menu clears a broken picture with one new keyframe, without ending the stream
- System information shows the TV firmware and player version; the last-session report adds PC figures with hints
- *HDR static metadata* (experimental) now works with AV1 too, and HDR streams always use the limited color range
- *Surround audio quality* (5.1, 7.1): *Efficient* about halved the decoding work on a PC; also in the Stream Menu

### Changed

- *Optimize game settings* is on for new installs, so games can render at the stream resolution
- H.264 above 1080p at 60 FPS asks the TV for level 5.1 first; the app warns before H.264 above 60 FPS
- The sound decoder needs less work (5–12 % for 5.1 on a PC), and the full statistics show its time
- The guide covers TV picture settings, HDR calibration, the network, error correction (FEC) and encoder settings

### Fixed

- Smoother motion after packet loss, in games below the stream rate and with a PC display at 59.94 Hz
- After a network delay at 120 FPS, the picture no longer freezes briefly while it catches up
- When the PC ends a stream, its reason (e.g. an encoder error) is kept more often
- At 90 and 120 FPS, a short stall of the TV player no longer costs a keyframe
- On Tizen 5.5 (2020), the first D-pad press of a controller that is already connected no longer skips a menu entry
- A start right after a cancelled one waits for the PC, with a countdown, instead of failing with a port hint
- Restarts of the PC's video encoder (e.g. after a display or HDR change) no longer count as recovery keyframes

## 2.2.1

*2026-11-05.* Ends the 144 FPS that no Samsung TV could start, and fixes controllers on TVs from 2020.

> **Install:** by hand over 2.2.0 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs, hosts and controllers only; the controllers on Tizen 5.5 still need a test on such a TV.

### Changed

- A 144 FPS set before becomes 120 FPS, or 60 FPS with *Unlock all frame rates* off; a preset bitrate follows
- The README credits Moonlight Tizen, its maintainer and its contributors, as its README asks

### Removed

- 144 FPS, which the video player of Samsung TVs never starts: the stream stopped after 5 s or stayed black

### Fixed

- Some controllers on Tizen 5.5 TVs (2020) did nothing in a game; now they work after one press or stick move
- Such controllers were also missing in System information, the input test and the button mapping

## 2.2.0

*2026-11-03.* A tidier app: settings in the order of use, fixes for the Stream Menu and the start, and a smaller download.

> **Install:** by hand over 2.1.0 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs, hosts and controllers only; the shorter waits, the new defaults and bitrates above 150 Mbps still need a test on a TV.

### Changed

- Settings in 7 sections in the order of use, with short help texts and names that say what ON does
- The bitrate presets are the recommended bitrates, and *Optimal settings* lets the bitrate follow them again
- The bitrate goes up to 250 Mbps in the settings and the Stream Menu, for a strong 5 or 6 GHz Wi-Fi link
- Screens open without the half-second wait, and controller buttons act after 50 ms in the menus
- Rumble is on for new installs; questions that quit an app or delete a PC start on *No*
- The S90C warns above 150 Mbps (its presets stay at 100); the optimal settings dialog opens on *Cancel*
- The PC menu lists only what works, and the PC list shows one state chip
- *Restore Defaults* keeps the button mapping and the stick calibration
- About 210 KB smaller download: unused files, styles and code are gone
- Licence notices and a privacy section; the diagnostic log also hides the public IP and MAC addresses

### Removed

- The switches *Optimize bitrate presets* and *Continuous audio from the host*, whose audio is now always on

### Fixed

- One UP from *Resume* in the Stream Menu selected *Quit app on the PC*
- The start of a stream told the PC stereo even with 5.1 or 7.1
- The network scan at startup ran on other screens, and the update notice showed at every start, even in a game
- One failed start of the Smart Hub service turned the Preview tiles off for good

## 2.1.0

*2026-10-30.* Five languages, the bitrate changed during a game, text typed on the PC, favorites, and tools to test controllers and find problems.

> **Install:** by hand over 2.0.0, 1.19.101 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs, hosts and controllers only; the keyboard of the TV, real controllers and Apollo are untested.

### New

- German, Spanish and French, chosen by the language of the TV; the menu names each one in its own language
- Stream Menu: change the bitrate in a game (the stream reconnects) and type text on the PC with the TV keyboard
- Statistics: a graph of the last minute, in the corner of the screen you choose
- App list: favorites first with a star, and the order of the recently played or of the host
- A report of the last stream with hints in System information, and a diagnostic log that stays on the TV
- Input test for the remote and controllers, and a button mapping per controller with stick calibration

### Improved

- Box art never holds up the start, resume or quit of a game, also with large libraries
- Apollo and Vibepollo: clear hints for missing permissions and for their control tiles
- Eight updates of the Moonlight streaming library, e.g. a stricter reading of the connection setup

### Fixed

- Very fast scrolling with a mouse wheel is no longer cut off
- Some texts stayed English in a translated app, e.g. in the pairing dialog and the navigation guide
- Brazilian Portuguese names the keys as the remote and the controller print them (RETURN, Play/Pause, SELECT)

## 2.0.0

*Pre-release only; its changes come with 2.1.0.* A one-line statistics view, safer pairing, a Wake PC dialog that no longer hangs, and fixes for stability.

> **Install:** by hand over 1.19.101 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs, hosts and controllers only, not yet on a TV or with a real Sunshine host.

### New

- Performance statistics in three levels: Off, Compact (one line at the top left) and Full, stepped with YELLOW
- The full statistics show how evenly the frames leave the PC and reach the TV
- Stream Menu: *Alt + Enter* switches a game between fullscreen and a window
- *Continuous audio from the host* (on by default) asks Sunshine to keep sending sound during silence
- Guide: surround sound with a soundbar, and how to check each channel

### Improved

- A stream that starts without any picture is started once more by itself before the error shows
- Wake PC sends its request several times, to more addresses, and again while the dialog waits

### Fixed

- The Wake PC dialog no longer hangs after a failed request or after the PC woke up
- An error in the interface during a stream no longer freezes the whole app
- No more lost mouse movements, and a stop during "Starting…" ends the connection setup sooner

### Security

- Pairing checks that the PC really knows the PIN and reports a wrong PIN as such
- Answers of the PC are checked for size, and the PIN and stream keys no longer appear in the log

## 1.19.101

*2026-10-29.* A new look, a Stream Menu and an app menu, and fixes for security and stability.

> **Install:** by hand over 1.19.100 or Moonlight S90C, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** the menus and the Select + Start combo with simulated controllers only; some remotes may not pass Play/Pause.

### New

- A new look: the selected PC or game fills the top of the screen, with its state and the keys to press
- Uncropped box art at the top and when a game starts, a *Running* badge, and settings in colored sections
- Stream Menu during a stream: Play/Pause on the remote, or hold Select + Start on a controller for 1 second
- App menu on the game tiles (CH+, Play/Pause or Select): resume, start, quit, hide and show apps
- *Rescan network* button, for a PC that came online later or got a new address

### Improved

- The app is about 0.8 MB smaller
- Connection errors name the ports to open on the PC
- Performance statistics show the audio format and lost audio packets, also with the default audio backend
- Brazilian Portuguese: all texts are translated

### Fixed

- The arrow keys no longer scroll the settings by themselves or hide the selected row
- *Quit Running App* no longer reports success when the PC keeps the game running
- A memory error that could freeze the app is gone

### Security

- Through the Smart Hub preview server (Tizen 5.5 to 6.0), other devices can reach only the preview images
- The pairing PIN and the IDs of the app come from a secure random generator
- Moonlight streaming library fixes, e.g. a disconnect packet from another device no longer ends the stream

## 1.19.100

*2026-10-26.* Moonlight S90C becomes Moonlight Plus, with settings that adapt to each Samsung TV with Tizen 5.5 or newer and fixes for controllers.

> **Install:** by hand over Moonlight S90C (v1.19.0-s90c.1), which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** the changes for other TVs and for controllers with simulated TVs and controllers only.

### New

- New name **Moonlight Plus**, with a PLUS badge on the icon
- *Optimal settings for this TV*: one button sets resolution, HDR and bitrate from what your TV reports
- Setting *Controller type sent to the PC*, e.g. for PlayStation button prompts in games
- The touchpad click of PlayStation controllers reaches the PC
- An English guide for every kind of Samsung TV, and a page about controllers

### Improved

- Defaults and warnings match your TV (60 Hz panels, decoder limits, bitrate cap, HDR), not only the S90C
- Existing installs keep their settings: new defaults never change them silently
- System information shows what the app detected: panel, HDR, connection, video codecs and controllers
- A clear message when the TV rejects a video format, and a disabled *Game mode* switch where the TV can't use it
- The update check reads the releases of this fork and shows the notes as plain text

### Fixed

- Select and Start of a controller work in the menus, and holding the D-pad repeats steadily
- Mouse emulation works with several controllers and no longer stays on into the next stream
- Rumble lasts as long as the game wants (before: 5 seconds) and stops when the stream ends

## 1.19.0-s90c.1

*2026-10-23, released as Moonlight S90C.* The first release, tuned on a Samsung S90C: smoother video, faster recovery from packet loss and many fixes.

> **Install:** next to the regular Moonlight app, with its own settings and pairing. An update it announces is the regular Moonlight Tizen app, not this fork.

### New

- Own app *Moonlight S90C* next to the regular Moonlight app
- Button *Samsung S90C optimization*: the tested S90C settings (4K, HEVC, HDR, a bitrate for the connection)
- Experimental settings *Reference frame invalidation*, *HDR static metadata* and *Audio clock sync*
- Resolution 1800p, and 5 Mbps steps in the bitrate menu with UP and DOWN
- Performance statistics that show whether the network or the TV drops frames, and the connection of the TV

### Improved

- Smoother frame pacing and a faster repair of lost packets
- The codec follows what the PC can encode, with a notice when it has to fall back
- The bitrate stays when you change the resolution, frame rate, codec or HDR
- A stream in the background ends after 1 minute, and the screensaver stays off while streaming
- Less load on the TV while streaming, and a steadier audio delay with the Web Audio backend

### Fixed

- The picture no longer freezes for up to 2 seconds after a wrongly assumed frame loss
- Pressing RED during "Starting…", a double stop or a second stream from a Smart Hub tile no longer breaks the app
- *Restore Defaults* no longer turns off frame pacing and the host address field mode
- With a locked mouse pointer, the Back key no longer leaves the left mouse button pressed on the PC

## Base version and details

Moonlight Plus is based on Moonlight Tizen 1.19.0 by brightcraft, whose versions are on the [releases page of Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen/releases).

Every technical detail of every version is in the [changelog](../CHANGELOG.md).
