# Patch notes

What changed in each version of Moonlight Plus, in short, newest first.

- [2.2.0](#220): pre-release, a tidier app with fixes and a smaller download
- [2.1.0](#210): 2026-10-30, five languages and new tools in the Stream Menu
- [2.0.0](#200): pre-release only, its changes come with 2.1.0
- [1.19.101](#119101): 2026-10-29, a new look and two new menus
- [1.19.100](#119100): 2026-10-26, the first release as Moonlight Plus
- [1.19.0-s90c.1](#1190-s90c1): 2026-10-23, released as Moonlight S90C
- [Base version and details](#base-version-and-details)

**Which file?** `Moonlight-ForceGM.wgt` on Tizen 9 and newer, `Moonlight.wgt` on Tizen 5.5 to 8.

**TV refuses an update?** If the author certificate doesn't match, uninstall the old app first; this loses its settings and pairing.

## 2.2.0

*Pre-release, in testing.* A tidier app: settings in the order of use, fixes for the Stream Menu and the start, and a smaller download.

> **Install:** by hand over 2.1.0 or earlier, which normally keeps settings and pairing, or next to the regular Moonlight app (pair the PC once).
>
> **Tested:** with simulated TVs, hosts and controllers only; the shorter waits and the new defaults still need a test on a TV.

### Changed

- Settings in 7 sections in the order of use, with short help texts and names that say what ON does
- The bitrate presets are the recommended bitrates, and *Optimal settings* lets the bitrate follow them again
- Screens open without the half-second wait, and controller buttons act after 50 ms in the menus
- Rumble is on for new installs; questions that quit an app or delete a PC start on *No*
- The PC menu lists only what works, and the hosts screen shows one state chip
- *Restore Defaults* keeps the button mapping and the stick calibration
- About 240 KB smaller download: unused files, styles and code are gone

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

Every technical detail of every version is in the [changelog](../CHANGELOG.md), and the German release notes, tuning plan and quick guide of 1.19.0-s90c.1 stay with the files of its [tag](https://github.com/Emperior90/moonlight-tizen-Plus/tree/v1.19.0-s90c.1/docs).
