# Patch notes

What changed in each version of Moonlight Plus, in short, newest first.

- [1.19.101](#119101): pre-release, in testing
- [1.19.100](#119100): 2026-10-26, the first release as Moonlight Plus
- [1.19.0-s90c.1](#1190-s90c1): 2026-10-23, released as Moonlight S90C
- [Base version and details](#base-version-and-details)

**Which file?** `Moonlight-ForceGM.wgt` on Tizen 9 and newer, `Moonlight.wgt` on Tizen 5.5 to 8.

**TV refuses an update?** If the author certificate doesn't match, uninstall the old app first; this loses its settings and pairing.

## 1.19.101

*Pre-release, in testing.* A new look, a Stream Menu and an app menu, and fixes for security and stability.

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

Every technical detail of every version is in the [changelog](../CHANGELOG.md), and the German release notes of 1.19.0-s90c.1 are [archived](profiles/S90C/RELEASE_NOTES_v1.19.0-s90c.1.md).
