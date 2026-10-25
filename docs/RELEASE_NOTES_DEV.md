**Test build of Moonlight Plus**, an unofficial fork of [Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen) 1.19.0 for Samsung TVs with Tizen 5.5 or newer. This build makes the app work well on every Samsung TV, not only on the Samsung S90C it was first tuned on.

### Which file to install?

- **Tizen 9.0 and newer: `Moonlight-ForceGM.wgt`.** It asks the TV for its Game Mode. Keep the *Game mode* switch of the app off.
- **Tizen 5.5 to 8.0: `Moonlight.wgt`.**
- The app is called **Moonlight Plus** on the TV. It installs next to the regular Moonlight app, with its own settings and pairing, so pair your PC once on the first start.
- It has the same package ID as the earlier builds of this fork (*Moonlight S90C*), so it installs over them and normally keeps their settings and pairing. The release v1.19.0-s90c.1 doesn't offer this build in its update check, which reads the releases of Moonlight Tizen (an update that it announces is the regular Moonlight Tizen app, a separate app): install this build by hand.
- Pre-releases are test builds, and the next test build of the same branch replaces them. For everyday use, take the release marked *Latest*.

### New in this build

**Settings for every Samsung TV**

- The defaults, *Restore Defaults* and the new button **Optimal settings for this TV** (Settings → Basic Settings) are derived from what the TV reports: the highest resolution of the panel up to 4K, HEVC, HDR when the TV supports it, and a bitrate for the resolution and the network connection. A Full HD TV starts at 20 to 25 Mbps, a 4K or 8K TV at 75 to 80 Mbps.
- The dialog of the button shows what the app detected (e.g. "Detected: 4K panel, HDR, Tizen 6.5, Wi-Fi") and exactly what it applies.
- The S90C keeps its tested values (75 / 100 / 80 Mbps over Ethernet / Wi-Fi / an unknown connection, all frame rates unlocked).
- An existing install keeps the values it showed so far: on its first start, it stores them for every video setting you never changed. Press the button to get the values for your TV.
- The warnings match the TV: 60 Hz panels, Level 5.2 decoders for 4K above 60 FPS, the bitrate cap of the TV class, the 100 Mbps Ethernet port, and HDR on a TV that doesn't report it.
- *System information* shows the detected panel, HDR, connection, tested profile and model year, whether the video player offers the Ultra Low Latency mode, what the browser answers for each video codec, and the connected controllers.

**Checks on the TV**

- *Game mode*: when the video player of the TV says clearly that it doesn't offer the Ultra Low Latency mode, or is an older player without a list of its features, the switch stays off and disabled.
- Video codecs: the app asks the browser which codecs it can decode. When the answer counts and is No for AV1, the codec menu labels AV1 "may not be supported by this TV", but it stays selectable.
- When the TV rejects the video track, the message names the codec, resolution and frame rate, e.g. "The TV rejected AV1 Main10 at 3840x2160@60 FPS. Choose HEVC as the video codec."

**Controllers**

- Select and Start work in the menus (like CH+ and CH- of the remote), and holding the D-pad repeats steadily.
- Mouse emulation works with several controllers, switches once per hold of Start, and no longer stays on into the next stream. The right stick scrolls at a speed that follows the stick.
- Rumble lasts as long as the game wants, instead of stopping after 5 seconds.
- New setting *Controller type sent to the PC* (Settings → Input Settings), e.g. for PlayStation button prompts in games.
- The touchpad click of PlayStation controllers reaches the PC.
- Notices for controllers with a non-standard layout and for controllers that can't rumble.

**App and documentation**

- New name **Moonlight Plus** with a "PLUS" badge, version 1.19.100. The update check reads the releases of this fork.
- The update dialog shows the release notes as plain text.
- New English guide and controller page. The German S90C documents are archived under `docs/profiles/S90C/`.

The full list is in the changelog (link below).

### How to test

1. Install the build and open Settings → About → *System information*. Take a photo: it shows what the app detected.
2. Press Settings → Basic Settings → *Optimal settings for this TV*. Check that the dialog describes your TV correctly, then press *Continue*.
3. Turn on Settings → Advanced Settings → *Performance statistics* and start a stream. The YELLOW key shows and hides them.
4. Play for 15 to 20 minutes. *Session frames dropped by network*, *Session frames dropped by the TV* and *Session recovery keyframes* should stay at 0.
5. With a controller: try Select and Start in the menus, rumble in a game (with *Rumble feedback* on), and the stop combo Select + Start + LB + RB.
6. Report what you see, with the photo of System information and the TV model, on the issue tracker of this fork.

The guide (link below) explains every line of System information and the performance statistics, and how to find the best bitrate.

### Known limits

- The changes of this build were tested with simulated TVs and controllers, not on real TVs or controllers. Especially unverified: the check of the Ultra Low Latency mode, the codec check, the warnings and defaults for TVs other than the S90C, the controller type setting, the touchpad click and the rumble longer than 5 seconds.
- The bitrate caps of 80 Mbps for 4K and 8K TVs and 50 Mbps for Full HD TVs are careful starting points from summaries of Samsung's specifications.
- If the TV refuses the update because the author certificate doesn't match, uninstall the earlier build first, which loses its settings and pairing.
