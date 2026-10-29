# Moonlight Plus guide

This guide covers installing Moonlight Plus, setting it up for your Samsung TV and finding the best settings for it. It applies to every TV the app installs on, which means Samsung TVs with Tizen 5.5 or newer.

How to read it:

- **Untested** means that the guide describes what the code does, but nobody has checked it on that kind of TV, host or controller yet.
- Values that were tested on one model only say so. The only tested model so far is the Samsung S90C (55-inch OLED, 2023, Tizen 9.0). Its archived German tuning guide is in [profiles/S90C](profiles/S90C/S90C-Optimierungsplan.md).
- Controllers have their own page: [CONTROLLERS.md](CONTROLLERS.md).

## Contents

1. [Requirements](#1-requirements)
2. [TV classes](#2-tv-classes)
3. [Installation](#3-installation)
4. [Optimal settings for this TV](#4-optimal-settings-for-this-tv)
5. [Finding your bitrate](#5-finding-your-bitrate)
6. [System information](#6-system-information)
7. [Performance statistics](#7-performance-statistics)
8. [Host settings (Sunshine)](#8-host-settings-sunshine)
9. [ForceGM variant and game mode](#9-forcegm-variant-and-game-mode)
10. [HDR](#10-hdr)
11. [Audio](#11-audio), with [surround sound with a soundbar](#surround-sound-with-a-soundbar)
12. [When Moonlight goes to the background](#12-when-moonlight-goes-to-the-background)
13. [Known limits](#13-known-limits)
14. [Troubleshooting](#14-troubleshooting)
15. [Updating from the earlier release v1.19.0-s90c.1](#15-updating-from-the-earlier-release-v1190-s90c1)
16. [Stream Menu and app menu](#16-stream-menu-and-app-menu)
17. [The screens of the app](#17-the-screens-of-the-app)

## 1. Requirements

- **TV:** a Samsung Smart TV with Tizen 5.5 or newer, which means model year 2020 or later. The package requires Tizen 5.5, so older TVs can't install it.
- **Host:** a PC with [Sunshine](https://github.com/LizardByte/Sunshine) and a GPU with a hardware video encoder that Sunshine supports (NVIDIA NVENC, AMD AMF or Intel Quick Sync). HDR needs a GPU that can encode HEVC Main10 or AV1 Main10.
- **Network:** connect the host PC by cable. The TV can use Ethernet or 5 GHz Wi-Fi. Most Samsung TVs have a 100 Mbps Ethernet port, so Wi-Fi can be the faster choice (see [Known limits](#13-known-limits)).
- **Controller (optional):** see [CONTROLLERS.md](CONTROLLERS.md). The remote control works for the menus, and the color keys control the stream.

## 2. TV classes

The app asks the TV for its panel resolution (Full HD, 4K or 8K), HDR support, Tizen version, model name and network connection. It can't ask for the refresh rate of the panel, so a 4K TV with a 60 Hz panel and one with a 120 Hz panel get the same defaults. Panel refresh rates differ by screen size and region even within one model series, so check the specifications of your exact model.

| TV class | What the app does |
|---|---|
| Full HD | Streams 1080p at 60 FPS by default. The resolution menu marks the resolutions above the panel as unsupported. |
| 4K, 60 Hz panel | Streams 4K at 60 FPS by default. Frame rates above 60 FPS stay locked. If you unlock them, the app can't tell a 60 Hz panel from a 120 Hz one, so it shows the warnings of the next row: at 4K, 90 and 120 FPS need a Level 5.2 decoder and 144 FPS exceeds Level 5.2. The warning that many Samsung TVs have 60 Hz panels appears at lower resolutions above 60 FPS (up to 1440p, or 1800p at 90 FPS). |
| 4K, 120 Hz panel | Same defaults as a 60 Hz panel. You can unlock 90, 120 and 144 FPS yourself (Settings → Advanced Settings → *Unlock all frame rates*). 4K above 60 FPS needs an HEVC or AV1 Level 5.2 decoder, which most Samsung TVs with a 120 Hz panel have, and the app warns about that. 4K at 144 FPS exceeds Level 5.2, the highest level that the app asks the TV for, and gets its own warning. Untested on any 120 Hz TV except the S90C. |
| 8K | The highest stream resolution is 4K, so an 8K TV gets the same defaults and bitrates as a 4K TV. Its decoder handles 8K at 60 FPS, beyond Level 5.2, so 4K at 90 or 120 FPS gets the warning that many Samsung TVs have 60 Hz panels instead of the Level 5.2 warning. 4K at 144 FPS still gets the warning that it exceeds Level 5.2. Untested. |
| Tested profile (Samsung S90C) | The 4K values with a higher bitrate over Wi-Fi (100 Mbps), and the higher frame rates unlocked from the start, because they were tested on this model. |

## 3. Installation

### Which file?

Every release has two files. They are the same app with the same package ID, so the TV keeps only one of them.

| Your TV | File |
|---|---|
| Tizen 9.0 or newer | `Moonlight-ForceGM.wgt` |
| Tizen 5.5 to 8.0 | `Moonlight.wgt` |

The ForceGM variant asks the TV for its Game Mode, because the *Game mode* switch of the app can freeze the picture on Tizen 9.0 and newer (see [section 9](#9-forcegm-variant-and-game-mode)). The upstream Moonlight Tizen project calls the ForceGM variant experimental, and results vary by TV model and firmware.

Not sure which Tizen version your TV has? Install `Moonlight.wgt`, then look at Settings → About → *System information* → *Platform Version*. On Tizen 9.0 or newer, install `Moonlight-ForceGM.wgt` instead.

### Install the file

1. Download the file from the [releases page of this fork](https://github.com/Emperior90/moonlight-tizen-S90c/releases). Take the release marked *Latest*. Pre-releases are test builds, and the next test build of the same branch replaces them.
2. Turn on the developer mode of the TV. In short: open Apps → App Settings, press 1 2 3 4 5 on the remote (or the on-screen number pad), switch *Developer mode* on, enter the local IP address of the PC you install from, and restart the TV by holding the power button for at least 5 seconds.
3. Install the file with one of the methods that work for Moonlight Tizen:
   - **Apps2Samsung:** choose *Custom WGT File* in the release field and select the downloaded file.
   - **Tizen Studio:** import the file as a project (File → Import → Tizen Project) and run it as a Tizen web application on the TV.
   - Apps2Samsung asks for a Samsung account on Tizen 7.0 and newer. Tizen Studio always needs one, to create the Samsung certificate with the DUID of the TV.

The [Installation Guide of Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen/wiki/Installation-Guide) explains these steps in detail. Its Docker method installs the file from the image of upstream Moonlight Tizen, which is the regular Moonlight app, not Moonlight Plus. These steps come from the upstream guide and were not tested again with this fork.

### Next to the regular Moonlight app

Moonlight Plus has its own package ID. It installs next to the regular Moonlight Tizen app, with its own settings and its own pairing:

- On the first start, pair the PC once: select it in Moonlight Plus and enter the PIN that the app shows in the web interface of Sunshine. This is needed even if the regular Moonlight app is already paired.
- Settings you changed in the regular Moonlight app don't carry over.
- If the TV still has a build of this fork from before it was renamed (shown as *Moonlight S90C*), Moonlight Plus installs over it, because it uses the same package ID.

### Updates

Settings → About → *Check for updates* looks for a newer release of this fork. The app also checks once a day at startup and then shows a *New update* button in the header. Both show what changed, but they can't install the update: download the new file and install it the same way as before. A build of the same package installs over the current one and normally keeps the settings and the pairing. If the TV refuses the update because the author certificate doesn't match, uninstall the old app first, which loses its settings and pairing.

## 4. Optimal settings for this TV

Settings → Basic Settings → *Optimal settings for this TV* → *Apply the optimal streaming settings for this TV* opens a dialog with:

- what the app detected, e.g. "Detected: 4K panel, HDR, Tizen 9.0, Wi-Fi", and whether the model has a tested profile
- the settings it will apply
- advice for the network connection: over Wi-Fi how far you can raise the bitrate, over Ethernet how to avoid packet loss on the 100 Mbps port of the TV
- on Tizen 9.0 and newer, a pointer to the ForceGM variant, or a note that it is installed

*Continue* applies the settings, *Close* keeps your current ones. The same values are the defaults of a fresh install and of *Restore Defaults* (the round arrow at the top right of the settings, see [the screens](#17-the-screens-of-the-app)).

What the button applies:

- **Resolution:** the highest resolution of the panel up to 4K: 3840 x 2160 on 4K and 8K TVs, 1920 x 1080 on Full HD TVs.
- **Frame rate:** 60 FPS, because Tizen apps commonly show about 60 FPS.
- **Codec:** HEVC, the most efficient codec that every host GPU with HDR support can encode.
- **HDR:** on when the TV reports HDR support. The stream is then HEVC Main10.
- **Bitrate:** a value for the resolution, frame rate and network connection, see the table below.
- **Unlock all frame rates:** off, except for a tested profile with a high refresh rate panel.
- **Game mode:** on for Tizen 6.0 to 8.0 and off on Tizen 9.0 and newer. On Tizen 5.5 it is off and disabled, unless the video player of the TV says that it offers the Ultra Low Latency mode: then it is off, but you can turn it on, and the dialog lists *Game mode off*. On any version it is off and disabled when the video player doesn't offer the mode (see [section 9](#9-forcegm-variant-and-game-mode)).
- **Video frame pacing** on, **Color range** limited, **Optimize bitrate presets** off.

After the button, the bitrate stays as it is when you change the resolution or frame rate, and a notice names the bitrates that the presets would set instead. After a fresh install or *Restore Defaults*, it follows the standard preset of the resolution and frame rate until you move the bitrate slider yourself. The presets are limited to 75 Mbps over Ethernet. On a TV without a tested profile they are also limited to the highest bitrate that the app recommends for it, which is the decoder cap of the TV class, or 80 Mbps when the connection isn't detected. A notice tells you when a preset was limited, and you can still raise the bitrate with the slider.

### Recommended bitrates

The bitrate starts from the standard preset of the resolution and frame rate (20 Mbps for 1080p and 80 Mbps for 4K at 60 FPS):

- **Ethernet:** 25 % above the preset, but at most 75 Mbps, because of the 100 Mbps port.
- **Wi-Fi:** 25 % above the preset.
- **Connection not detected:** the preset, but at most 80 Mbps.
- None of them goes above the decoder cap of the TV class, where the bitrate warning starts.

This table shows what the button applies. A test checks it against the code of the app (`wasm/platform/tv_profile.js`).

<!-- recommended-bitrates:start -->
| TV class | Resolution and frame rate | Ethernet | Wi-Fi | Connection not detected | Wi-Fi ladder ends at | Bitrate warning above |
|---|---|---|---|---|---|---|
| Full HD | 1920 x 1080, 60 FPS | 25 Mbps | 25 Mbps | 20 Mbps | 40 Mbps | 50 Mbps |
| 4K, 60 Hz panel | 3840 x 2160, 60 FPS | 75 Mbps | 80 Mbps | 80 Mbps | 80 Mbps | 80 Mbps |
| 4K, 120 Hz panel | 3840 x 2160, 60 FPS | 75 Mbps | 80 Mbps | 80 Mbps | 80 Mbps | 80 Mbps |
| 8K | 3840 x 2160, 60 FPS | 75 Mbps | 80 Mbps | 80 Mbps | 80 Mbps | 80 Mbps |
| Samsung S90C (tested profile) | 3840 x 2160, 60 FPS | 75 Mbps | 100 Mbps | 80 Mbps | 100 Mbps | 100 Mbps |
<!-- recommended-bitrates:end -->

- **Wi-Fi ladder ends at** is the highest bitrate the dialog suggests over Wi-Fi: twice the standard preset, but at most the decoder cap. When the recommended bitrate already reaches it, the dialog says so instead.
- **Bitrate warning above** is the decoder cap of the TV class. Over Ethernet, a warning also appears above 80 Mbps, because of the 100 Mbps port.
- Where the caps come from: 100 Mbps is what the S90C handled in its tests. The 80 Mbps for 4K and 8K TVs and the 50 Mbps for Full HD TVs follow summaries of Samsung's TV video specifications (HEVC at 60 FPS), which could not be checked against the specification pages themselves. Treat them as careful starting points, not as hard limits of your TV. The slider still goes up to 150 Mbps.

## 5. Finding your bitrate

A higher bitrate gives a sharper picture in fast motion until the network or the decoder of the TV can't keep up. Find the highest bitrate that stays clean:

1. Set Settings → Advanced Settings → *Performance statistics* to *Full*. During the stream, the YELLOW key steps through *Off*, *Compact* and *Full*.
2. Start at the recommendation of the button.
3. Play the same demanding scene (fast camera turns, foliage, particles) for 15 to 20 minutes.
4. The step passes when, for the whole time:
   - *Session frames dropped by network* and *Session frames dropped by the TV* stay at 0
   - *Session recovery keyframes* stays at 0
   - *Rendering frame rate* stays at the chosen frame rate
   - the sound has no dropouts (with Web Audio: the *underruns* of the *Audio session* line stay at 0)
5. If it passes, end the stream and raise the bitrate by about 15 to 20 %. In the bitrate menu, UP and DOWN change it in 5 Mbps steps, LEFT and RIGHT in 0.5 Mbps steps. Start a new stream for every step, since the bitrate only changes when a stream starts.
6. Stop at the end of the ladder of your TV class (see the table), or at the first step that fails.
7. Use the highest step that passed, or one step below it to keep some headroom.

Examples:

- **Full HD TV over Wi-Fi:** 25 → 30 → 35 → 40 Mbps.
- **4K TV over Wi-Fi without a tested profile:** the recommendation of 80 Mbps already is the cap. Higher bitrates are untested on these TVs, and the app warns above 80 Mbps. If you still try, use the same steps (80 → 95 → 110 Mbps) and go back as soon as *Session frames dropped by the TV* or *TV player rejections* appear.
- **Over Ethernet:** the recommendation of 75 Mbps is close to what the 100 Mbps port of the TV can carry, and the app warns above 80 Mbps. Use 5 GHz Wi-Fi for higher bitrates.
- **Samsung S90C over Wi-Fi:** starts at its cap of 100 Mbps. Its archived tuning guide describes a ladder of 100 → 120 → 135 → 150 Mbps for that model.

If a long session stutters after a while, note the time and the lines above: they show whether the host, the network or the TV is the cause (see [section 7](#7-performance-statistics)).

## 6. System information

Settings → About → *System information* shows what the app detected. A photo of this screen is the most useful part of a bug report.

| Line | Meaning |
|---|---|
| App Version | Name and version of the app. *Moonlight Plus-ForceGM* is the ForceGM variant. A pre-release adds *(pre-&lt;commit&gt;)*, the commit it was built from. So does a full release that was promoted from a tested pre-release, because it keeps the files of the pre-release, e.g. *Moonlight Plus v1.19.100 (pre-1a2b3c4)*. |
| Platform Version | Tizen version of the TV |
| TV Model Series, TV Model Name, TV Model Group | Model strings that the TV reports |
| Model Year (from the model group) | The year that the model group suggests. Only a hint: it never decides a setting. |
| Panel | Full HD, 4K or 8K |
| HDR Support | Whether the TV reports HDR support |
| Network Connection Type | Ethernet, Wi-Fi, or Unknown |
| Tested Profile | The tested model profile that matches the TV (S90C), or None |
| Ultra Low Latency mode (Game mode) | Whether the video player of the TV offers the mode that the *Game mode* switch asks for: Yes, No or Unknown |
| WASM player API levels | API levels of the video player of the TV. For an older video player without a list of its features, the level (0 or 1) that the video player code in the app derives from it. |
| Video decoders (MediaSource check) | What the browser of the TV answers for H.264, HEVC, HEVC Main10, AV1 and AV1 Main10. The answers only count when the browser also rejects a made-up codec and accepts H.264; otherwise the line says Unknown. |
| Video decoders at level 5.2 (4K above 60 FPS) | The same check at level 5.2, which 4K streams above 60 FPS use |
| Gamepad N | Each connected controller: name, standard or non-standard layout, buttons, axes, rumble support and the controller type sent to the PC. When the setting *Controller type sent to the PC* overrides the detection, the detected type follows, e.g. *PlayStation (setting, detected: Xbox)* (see [CONTROLLERS.md](CONTROLLERS.md)). |

When the decoder check counts and says No for AV1, the codec menu labels AV1 "may not be supported by this TV". It stays selectable, because the check was only tested in simulations, not on real TVs.

## 7. Performance statistics

Choose the level in Settings → Advanced Settings → *Performance statistics*: *Off*, *Compact* or *Full*. In the stream, the YELLOW key steps *Off* → *Compact* → *Full* → *Off*, and so do the controller combo Select + LB + RB + X, Ctrl + Alt + Shift + S on a keyboard and *Performance statistics* in the [Stream Menu](#16-stream-menu-and-app-menu). The setting keeps the last level for the next stream.

**Compact** shows one line at the top left of the picture, e.g.:

`4K60 HEVC HDR · 59.9 fps · 74 Mb/s · RTT 3 ms · Net drops 0.1% · Wait+pacing 6.3 ms`

That is the stream as set up, the frames handed to the video player of the TV per second, the bitrate that arrives, the round-trip time to the host, the share of frames lost on the network in the last two seconds, and the *Average frame wait time* plus the *Average frame pacing delay* of the full statistics. A figure that isn't known yet is left out.

**Full** shows every line below. Some lines only appear when they have something to say.

**Stream and host**

| Line | Meaning |
|---|---|
| Video stream | Resolution, frame rate and codec. *10-bit SDR* means that HDR is off on the host display. |
| Incoming frame rate from network, Decoding frame rate, Rendering frame rate | Frames per second at each stage on the TV. They should all match the chosen frame rate. |
| Incoming bitrate from network, Configured bitrate | The bitrate that arrives, and the one set in the app |
| Host frame rate (30 s) | Frame rate of the host, measured over 30 seconds. 59.94 instead of 60 means that the host display runs at 59.94 Hz; set it to 60 Hz. |
| Host processing latency min/max/average | Time the host needs to capture and encode a frame |

**Network and TV, per second**

| Line | Meaning |
|---|---|
| Frames dropped by your network connection | Share of frames lost on the network |
| Average network latency | Round-trip time to the host, with its variance |
| Average frame receive time | Time until all packets of a frame have arrived |
| Average frame wait time | Time a frame waits for the video thread of the app |
| Average frame pacing delay | Time the frame pacing holds a frame back (*Video frame pacing*) |
| Average rendering time | Time to hand a frame to the video player of the TV |
| Pending frames | Frames waiting on the TV, with the highest count of the last second |
| Host frame intervals | How evenly the host sends new frames, from its capture times over the last two seconds: the standard deviation and the 95th percentile (p95) of the time between two frames, and the share of intervals more than a quarter of a frame off the frame time (*off cadence*). Frames lost on the network don't count here. The capture times come in whole milliseconds, so a perfect 60 FPS host shows a deviation of about 0.47 ms and a p95 of 17.0 ms. |
| TV player frame intervals | The same for the moments the frames reach the video player of the TV. Every frame that didn't arrive counts as a long interval. If the host line is even and this line isn't, the stutter comes from the network or the TV; if both are uneven, from the PC. Compare it with *Video frame pacing* on and off. |

**Session totals since the stream started**

| Line | Rises when … | Then |
|---|---|---|
| Session frames dropped by network | the network lost frames | Check the Wi-Fi signal and channel, or lower the bitrate by one step. |
| Session frames dropped by the TV | the TV dropped frames itself (full queue, rejected by the player); also counts the resets of the video pipeline | Lower the bitrate, resolution or frame rate. |
| Session recovery keyframes | the stream needed a full keyframe to recover | If the two lines above stay at 0, look at the Sunshine log at that time. |
| TV player rejections | the video player of the TV rejected frames, counted by reason | Lower the bitrate, resolution or frame rate. |
| Session FEC recoveries | lost packets were repaired by the error correction, without a visible effect | Nothing, unless *Worst FEC block* comes close to its limit. |
| Worst FEC block | the worst block came close to losing a frame (X of Y parity packets used) | If X often comes close to Y, raise `fec_percentage` in Sunshine. |

**Other lines**

| Line | Meaning |
|---|---|
| UDP receive buffer | The receive buffer that the app asked for, and the one that the TV reports |
| WASM heap top | Memory of the streaming engine against its fixed size. A steady climb over hours points to a memory leak; please report it. |
| Network connection | Ethernet (with the reminder of the 100 Mbps port), or Wi-Fi with the signal strength in percent when the TV reports it, refreshed every 5 seconds |
| Audio stream | The audio that the host sends: codec, channel layout and packet duration as negotiated (e.g. *Opus 5.1 surround (6 channels), 5 ms packets*) and its data rate. If you chose 5.1 or 7.1 and it shows *Stereo*, the host only offers stereo. For 5.1 on a soundbar, see [section 11](#surround-sound-with-a-soundbar). |
| Session audio packets lost by network | Audio packets that the network lost and the error correction couldn't repair, which the TV covers up with concealed sound. A steady rise means packet loss on the network. Errors of the audio decoder and rejections of the audio player of the TV show in a further line once there are any. |
| Audio buffer, Audio session | Only with the Web Audio backend: jitter buffer, schedule lead, browser latency, underruns, skipped and lost audio frames, the correction of *Audio clock sync* and a suggested buffer size (see [section 11](#11-audio)). While the audio output of the browser isn't running, a single line *Audio (Web Audio)* shows its state instead. |
| Moonlight hidden during the stream | How often the app was hidden during the stream and how often the TV closed its video (see [section 12](#12-when-moonlight-goes-to-the-background)) |

The warning "Slow connection to PC. Reduce your bitrate!" only appears for frames lost on the network, not for frames that the TV dropped itself.

## 8. Host settings (Sunshine)

The values below are the defaults from the [Sunshine configuration documentation](https://github.com/LizardByte/Sunshine/blob/master/docs/configuration.md). Only an NVIDIA GPU (NVENC) was used with the tested S90C profile. The AMD and Intel notes are untested with this app.

**All encoders**

- `fec_percentage` (default 20): the share of error correction data. Keep the default. Raise it if *Session frames dropped by network* rises or *Worst FEC block* often comes close to its limit. A lower value leaves more of the bitrate to the encoder, but only try it on a network that loses no packets.
- `max_bitrate` (default 0): 0 uses the bitrate that the app requests.
- `hevc_mode` and `av1_mode` (default 0): Sunshine offers HEVC and AV1 when its encoder supports them. When the host can't encode the selected codec or 10-bit video, the app falls back (HEVC instead of AV1, SDR instead of HDR) and shows a notice.
- Set the host display to exactly 60 Hz (or 120 Hz for 120 FPS streams), not 59.94 Hz. *Host frame rate (30 s)* shows what the host delivers.
- *Optimize game settings* (Settings → Host Settings) lets Sunshine switch the host display to the stream resolution when its display device configuration is on. With the default refresh rate option of Sunshine, the host refresh rate follows the selected frame rate anyway, and only modes that the host display offers can be applied.

**NVIDIA (NVENC)**

- `nvenc_preset` (default 1, the fastest): higher presets compress better at the cost of encoding time. The Sunshine documentation suggests changing it only when the network or the decoder limits the bitrate, which is the case with the decoder caps of a TV and its 100 Mbps Ethernet port. Try 4 and watch *Host processing latency*.
- `nvenc_twopass` (default `quarter_res`), `nvenc_spatial_aq` (default off), `nvenc_vbv_increase` (default 0): keep them. A higher VBV increase allows larger single frames, which the Sunshine documentation says can cause packet loss. Keep it at 0 over Ethernet.
- `nvenc_split_encode` (default `driver_decides`): splits each frame over several NVENC units, which the Sunshine documentation says "significantly reduces encoding latency with a marginal compression efficiency penalty". It needs a GPU with more than one NVENC unit.

**AMD (AMF), untested**

- Defaults: `amd_usage` = `ultralowlatency`, `amd_rc` = `vbr_latency`, `amd_quality` = `balanced`, `amd_preanalysis` off (it can raise quality but adds latency), `amd_vbaq` on.
- `amd_quality` = `quality` trades encoding speed for quality, in the same way as a higher NVENC preset.

**Intel (Quick Sync), untested**

- Defaults: `qsv_preset` = `medium` (from `veryfast` to `veryslow`), `qsv_slow_hevc` off.
- A slower preset trades encoding time for quality.

## 9. ForceGM variant and game mode

Two different things are called game mode:

- **The Game Mode of the TV** turns off picture processing that adds latency. The ForceGM variant (`Moonlight-ForceGM.wgt`) asks the TV for it through its app metadata.
- **The *Game mode* switch of the app** (Settings → Video Settings) only selects the latency mode of the video player of the TV: Ultra Low Latency when on, Low Latency when off.

Recommendations:

- **Tizen 9.0 and newer:** install the ForceGM variant and keep the *Game mode* switch off. The switch can freeze the picture on these versions.
- **Tizen 6.0 to 8.0:** `Moonlight.wgt` with the *Game mode* switch on, which is the default.
- **Tizen 5.5:** the switch is off and disabled, since the video player of Tizen 5.5 didn't offer the mode, unless the player says that it does.
- **Any version:** when the video player of the TV says clearly that it doesn't offer the Ultra Low Latency mode, the switch stays off and disabled, and System information shows *Ultra Low Latency mode (Game mode): No*. The same applies to an older video player that has no list of its features: the video player code in the app never uses the mode there and falls back to the Low Latency mode, so System information shows *No* with the API level (0 or 1) that this code derives. This check was tested in simulations only, not on real TVs.

## 10. HDR

- HDR is on by default when the TV reports HDR support. The stream is then HEVC Main10 (or AV1 Main10).
- HDR must also be on for the host display (e.g. a virtual display), in Windows or through the display device settings of Sunshine. Otherwise the stream is 10-bit SDR, which the *Video stream* line shows.
- The game must support HDR and have it enabled.
- H.264 has no HDR. If the host can't encode 10-bit video with the selected codec, the stream runs without HDR and the app shows a notice.
- If you switch HDR on for a TV that doesn't report HDR support, the app warns that the picture may look washed out or the stream may fail to start.
- *Color range*: keep it limited, the standard for video. Full range loses detail in dark and bright areas on a TV that doesn't show full range video properly.
- *HDR static metadata* (experimental, off by default) passes the HDR metadata of the host display to the TV with every HEVC keyframe, so that the tone mapping of the TV matches the host. Turn it off again if HDR streams fail to start or look wrong.

## 11. Audio

Settings → Audio Settings → *Audio backend*:

- **EMSS** (default) plays the sound through the media player of the TV. Its *Audio synchronization* switch is off by default.
- **Web Audio** is the alternative if you hear crackling or stuttering with EMSS. Its *Audio jitter buffer* (25 to 500 ms, 100 ms by default) absorbs network jitter, at the cost of a bit more audio delay.
  - **Audio clock sync** (experimental, off by default) plays the sound up to 0.05 % faster or slower, which is inaudible, so that the audio delay stays at the jitter buffer. Without it, the clocks of the host and the TV drift apart: the delay grows to 1.5 times the buffer, then 5 ms of sound are skipped every few minutes, or there is a gap as long as the buffer when it runs empty.
  - With *Audio clock sync* on, the *Audio session* line of the performance statistics suggests a buffer size after 10 minutes. Use it as the jitter buffer.
  - If the sound drops out (*underruns* rise), raise the jitter buffer by 25 ms.
- **Disabled** turns the sound of the TV off.

*Audio configuration* offers Stereo, 5.1 and 7.1 surround (experimental). For 5.1 through a soundbar, see [Surround sound with a soundbar](#surround-sound-with-a-soundbar).

*Continuous audio from the host* (on by default) asks the host to keep sending audio during silence. Without it, Sunshine on Windows sends no audio at all while the PC is silent, and the audio player of the TV and the link to a soundbar run dry. It needs Sunshine v2026.516.143833 or newer; older hosts and other host software ignore it. If the first sound after a long silence is cut off, or sound and picture drift apart over a long session, compare a session with it off.

### Surround sound with a soundbar

Moonlight Plus can play the 5.1 sound of the PC through a soundbar or an AV receiver. Whether all six channels arrive one by one depends on the connection and on the settings of the TV and the soundbar. Untested: nobody has confirmed discrete 5.1 from the app on a TV yet, also not on the S90C. The check below tells you what your setup gets.

**What the connection carries**

| Connection to the soundbar | What it carries |
|---|---|
| HDMI eARC | Multichannel PCM up to 5.1 channels, on Samsung TVs from 2021 on (AU7000 and higher), according to [Samsung's support page on eARC](https://www.samsung.com/sg/support/tv-audio-video/what-is-earc-and-how-to-set-on-samsung-smart-tv/). 7.1 PCM is not supported. Samsung asks for an HDMI cable that supports HEAC or HEC. |
| HDMI ARC, optical | Stereo PCM only. 5.1 over these needs a Dolby bitstream, which the app can't send (see [below](#why-there-is-no-dolby-passthrough-yet)). Choose Stereo. |

The PC sends the sound as Opus. With 5.1, the app decodes it to 6-channel PCM for the media player of the TV, and the TV passes it on to the soundbar.

**Settings**

1. **Moonlight Plus:** Settings → Audio Settings → *Audio configuration*: *5.1 Surround Sound*, and *Audio backend*: *EMSS* (the default). Web Audio plays through the output of the browser, which the app leaves at two channels, so it mixes 5.1 down to stereo. Don't choose 7.1, since Samsung TVs pass at most 5.1 channels of PCM over eARC.
2. **TV:** Settings → All Settings → Sound → *Sound Output*: the soundbar over HDMI eARC. Then Sound → *Expert Settings*: *HDMI-eARC Mode* on *Auto* and *Digital Output Audio Format* on *Auto*, so that the TV picks a format that the soundbar supports. The menu names come from Samsung's support pages and differ by model and year; they were not checked on a TV.
3. **Soundbar:** the sound mode *Standard*, not *Surround* or *Adaptive Sound*. Those modes spread stereo over all speakers, so you can't hear whether the channels arrive on their own.
4. **PC:** Sunshine plays the sound of the PC into the virtual *Steam Streaming Speakers* and sets them to the channel layout that the stream asks for. Its setting `install_steam_audio_drivers` (on by default) installs them when Steam is installed (see the [Sunshine configuration documentation](https://github.com/LizardByte/Sunshine/blob/master/docs/configuration.md)).

**Check each channel**

1. Start a stream. The *Audio stream* line of the full [performance statistics](#7-performance-statistics) should say *Opus 5.1 surround (6 channels)*. If it says *Stereo*, the host only offers stereo.
2. On the PC, open the sound control panel (Windows 11: Settings → System → Sound → *More sound settings*), select *Steam Streaming Speakers* on the *Playback* tab, then *Configure* → *5.1 Surround* → *Test*. Windows plays a sound from each speaker in turn; a click on a speaker in the picture plays only that one.
3. Listen at the soundbar:
   - Each sound comes from its own speaker (front left, center, front right, the two rear speakers, the subwoofer): discrete 5.1 works.
   - The rear sounds come from the front, or each sound comes from everywhere: the TV mixes the sound down to stereo, and the soundbar spreads it again. Check the settings above.
   - The display of the soundbar often shows only *PCM*, which doesn't tell stereo from 5.1. Trust your ears.

#### Why there is no Dolby passthrough yet

Over ARC or optical, 5.1 needs a compressed Dolby Digital (AC-3) or Dolby Digital Plus (E-AC-3) stream that the TV passes on to the soundbar. The app doesn't offer it yet:

- The host would have to encode it. Sunshine doesn't; the pull request for it ([LizardByte/Sunshine #5917](https://github.com/LizardByte/Sunshine/pull/5917)) was still open in October 2026. Some other host programs encode it, mostly in test builds and with two protocols that don't fit each other.
- A Dolby packet carries 32 ms of sound instead of the 5 ms of Opus, so the sound arrives at least 27 ms later, and a lost packet leaves a gap that isn't covered up.
- Whether the media player of a Samsung TV takes a Dolby track during a stream, also with the *Game mode* switch on, is untested.
- Over eARC, 5.1 PCM already gives discrete channels without the extra delay.

The fork [moonlight-tizen-ac3](https://github.com/fidoboy/moonlight-tizen-ac3) by fidoboy is a separate app that adds Dolby together with a test build of Sunshine. Its [troubleshooting guide](https://github.com/fidoboy/moonlight-tizen-ac3/blob/master/docs/Troubleshooting-Guide.md) gives the same order: Stereo first, then 5.1 once the TV and the soundbar or receiver support it, and no 7.1 for Dolby.

## 12. When Moonlight goes to the background

- If Moonlight stays in the background for more than 1 minute (home screen, another app), the stream ends. It ends at once when the TV takes the video away from the app, or when the connection is still being set up.
- Overlays of the TV such as the quick settings and the volume should leave the stream running. The line *Moonlight hidden during the stream* of the performance statistics counts how often the app was hidden.
- The game keeps running on the PC. Open Moonlight Plus and select the game again to resume it. A notice says so.
- The screensaver of the TV stays off while you stream.
- The RED key ends the stream. During "Starting…", it cancels the start. On a remote without color keys, the 123 key usually shows them on screen (as on the remote of the S90C). The [Stream Menu](#16-stream-menu-and-app-menu) (Play/Pause) ends the stream as well, with *Disconnect*.

## 13. Known limits

- **Ethernet port:** most Samsung TVs have a 100 Mbps Ethernet port. The bitrate presets stop at 75 Mbps over Ethernet, and the app warns above 80 Mbps. To avoid packet loss from the traffic bursts of the much faster host PC, set the network adapter of the host to 100 Mbps full duplex or enable flow control on your switch. For higher bitrates, use 5 GHz Wi-Fi.
- **60 Hz panels:** many Samsung TVs have 60 Hz panels, and Tizen apps often show only about 60 FPS. Frame rates above 60 FPS then cost bitrate without looking smoother. 90 FPS divides neither a 60 Hz nor a 120 Hz output evenly.
- **Decoder levels:** 4K above 60 FPS needs an HEVC or AV1 Level 5.2 decoder, which most 4K TVs with a 120 Hz panel have. 4K at 144 FPS exceeds Level 5.2, the highest level that the app asks the TV for, so it may stutter or fail even on a TV whose decoder goes further, such as an 8K TV.
- **H.264:** Samsung TVs generally decode H.264 only up to 1080p. Use HEVC or AV1 for higher resolutions.
- **AV1:** support on older TVs is uncertain. Samsung announced AV1 for its 2020 and 2021 4K and 8K TVs ([Samsung Poland](https://news.samsung.com/pl/telewizory-samsung-z-kodekiem-av1-pelna-lista-modeli)), while streaming services list only some of these models ([9to5Google on Netflix](https://9to5google.com/2021/11/10/netflix-av1-tv-support/)). The decoder check in System information shows what the browser of the TV answers, but it was not verified on real TVs. If the TV rejects AV1, the app names the format and recommends HEVC.
- **8K:** the highest stream resolution is 4K.
- **Controllers:** no touchpad surface, motion sensors, battery level or lights; see [CONTROLLERS.md](CONTROLLERS.md).
- **Verification:** the checks of the game mode and of the video decoders, the controller type setting and the warnings for other TV classes were tested with simulated TVs and controllers only. Reports from real TVs are welcome.

## 14. Troubleshooting

The app ends a failed stream with a message instead of a frozen or black picture.

| Message | Cause and what to do |
|---|---|
| "No video received from host." (-100) | Moonlight Plus first starts the stream once more by itself, without a message, since a host that switches its display (e.g. to 4K HDR or a virtual display) can be too slow for the first start. If the message shows, the second start failed as well: check the firewall of the host PC and the port forwarding of your router. The message names the ports the video and audio need (UDP 47998 and UDP 48000, or the ports of the host's port setting, e.g. UDP 50009 and UDP 50011 for Sunshine with the port 50000). |
| "RTSP handshake failed (error …)" and other "… failed (error …)" messages of the connection | The connection to the host failed at this step. When the step needs certain ports, the message names them (e.g. TCP 48010, UDP 48000 and UDP 48010 for the RTSP handshake, UDP 47999 for the control stream; a host with another port setting gets its own ports, e.g. TCP 50021, UDP 50011 and UDP 50021 for Sunshine with the port 50000); check that the firewall of the host PC and your router let them through. |
| "… is still running on …, probably because another device started it." | *Quit Running App* didn't quit the app, usually because another device started it. Quit it on that device or on the PC. |
| "Your network connection isn't performing well." (-101) | Lower the bitrate, or use a faster connection. |
| "Something went wrong on your host PC when starting the stream." (-102) | Restart the host PC and try again. |
| "… Make sure you don't have any DRM-protected content open on your host PC." (-103) | Close the protected content on the host. |
| "The host PC reported a fatal video encoding error." (-104) | Turn off HDR, change the stream resolution, or change the resolution of the host display. |
| "The TV rejected AV1 Main10 at 3840x2160@60 FPS. Choose HEVC as the video codec." (-200) | The TV refused this video format when the stream started. The message names the codec, resolution and frame rate, and the advice depends on them: HEVC instead of AV1, HEVC or at most 1080p instead of H.264 above 1080p, HEVC or a lower frame rate instead of H.264 within 1080p, HDR off or a lower resolution or frame rate for a 10-bit stream. |
| "The TV was unable to start the streaming with the selected video settings." (-200) | The same error without a rejected format, or the video player kept rejecting the stream for 3 seconds before the first frame. Lower the resolution or frame rate, or change the codec. |
| "The video player of the TV stopped with an error during the stream." (-201) | The video player of the TV failed, or kept rejecting the stream for 3 seconds, during the stream. Start the stream again. If it keeps happening, lower the bitrate, resolution or frame rate. |
| "A part of the streaming engine stopped unexpectedly." | The streaming engine crashed. Moonlight restarts after you close the message, and you can resume the game. Please report it with System information. |
| "The stream was ended because Moonlight went to the background." | See [section 12](#12-when-moonlight-goes-to-the-background). Select the game to resume it. |
| "Stop the current stream first (RED button)." | A Smart Hub tile was opened during a stream. |
| "The host PC can't encode the selected codec, so the stream uses HEVC instead." | The host has no encoder for the selected codec (e.g. AV1). |
| "… has a non-standard button layout …" | See [CONTROLLERS.md](CONTROLLERS.md). |
| "Error: The PIN entered on … was wrong." | The PC answered the pairing without proof that it knows the PIN, so Moonlight Plus stopped before it trusts the PC. Usually the PIN was mistyped in the web interface of Sunshine. Pair again and enter the new PIN. |
| "Failed to send Wake-on-LAN request to …!" | Some TVs can't send the request at all (e.g. "Failed to create socket"). Wake the PC with another device instead, e.g. a Wake-on-LAN app on a phone. "The PC hasn't reported its MAC address" means the app never got it: the PC reports it only to a paired TV, so pair it and let the app reach it once while the PC is on. While the *Wake PC* dialog waits, it sends the request again every 10 seconds and closes once the PC answers. |

Other problems:

- **Play/Pause doesn't open the Stream Menu:** some TVs may not pass the key to apps (untested). Hold Select + Start on a controller for 1 second instead; RED and YELLOW keep working.
- **An app is missing from the app list:** it may be hidden. Open the menu of any app (CH+ or Play/Pause) and choose *Show hidden apps* (see [section 16](#16-stream-menu-and-app-menu)).
- **The PC isn't in the list, or it got a new IP address:** press UP in the host list and select *Rescan network* (the circular arrow, the first round button of the header) to search the local network again. The app searches for hosts on its own at startup.
- **The picture freezes on Tizen 9.0 or newer:** turn the *Game mode* switch off, and use the ForceGM variant for the Game Mode of the TV.
- **Colors look washed out:** HDR is on in the app but off on the host display, or the TV doesn't support HDR (see [section 10](#10-hdr)).
- **Only stereo from a soundbar or receiver:** see [Surround sound with a soundbar](#surround-sound-with-a-soundbar).
- **Crackling sound with EMSS:** lower the bitrate by one step, or switch to Web Audio.
- **Stutter after some time:** look at the session totals of the performance statistics at that moment (see [section 7](#7-performance-statistics)).

Still stuck? Open an issue on the [issue tracker of this fork](https://github.com/Emperior90/moonlight-tizen-S90c/issues) with a photo of System information. Please don't report problems with Moonlight Plus to the upstream Moonlight Tizen project.

## 15. Updating from the earlier release v1.19.0-s90c.1

The earlier release of this fork, v1.19.0-s90c.1 (shown on the TV as *Moonlight S90C*), checked the releases of upstream Moonlight Tizen for updates, not those of this fork. It will never offer Moonlight Plus. An update that it announces later is a release of the regular Moonlight Tizen app, which installs as a separate app next to it, so don't install that to get Moonlight Plus. Install the latest Moonlight Plus once by hand, as described in [Installation](#3-installation). It has the same package ID, so it installs over the earlier release and normally keeps its settings and pairing. From 1.19.100 on, *Check for updates* looks at the releases of this fork.

## 16. Stream Menu and app menu

**Stream Menu.** During a stream, press **Play/Pause** on the remote, or hold **Select + Start** on a controller for 1 second, to open the Stream Menu on the right of the picture, inside the safe area of the screen. The stream keeps playing behind it, but the PC gets nothing from the remote, the keyboard or the controllers while it is open: they move through the menu (UP and DOWN or the D-pad, OK or A), and RETURN, Play/Pause or B close it and return to the game.

| Entry | What it does |
|---|---|
| Resume | Returns to the game |
| Performance statistics | Steps the [statistics](#7-performance-statistics) through *Off*, *Compact* and *Full*, like YELLOW. The menu stays open and shows the level. |
| Mouse emulation | Only shows with a controller connected. Switches the [mouse mode](CONTROLLERS.md#7-mouse-emulation) of the controllers on or off, also when the setting *Mouse emulation* is off (the setting only allows the hold of Start). |
| Windows key, Alt + Tab, Alt + F4, Esc, Alt + Enter | Presses the keys on the PC and releases them again in reverse order, so that no key stays held, and returns to the game. Alt + Enter switches most Windows games and emulators between fullscreen and a window. |
| Disconnect | Ends the stream, like RED. The game keeps running on the PC. |
| Disconnect and quit the app on the PC | Ends the stream and then quits the app on the PC, like *Quit Running App*. Unsaved progress in the game is lost. |

- The menu opens once the picture shows, not during "Starting…". RED and YELLOW keep working while it is open.
- The buttons that are still held when the menu closes (e.g. A on *Resume*) reach the game only after you release them, and so does the key of the remote or keyboard that closed it (e.g. OK on *Resume*). Keyboard keys and mouse buttons that are held when the menu opens are released on the PC. [CONTROLLERS.md](CONTROLLERS.md#4-buttons-during-a-stream) describes the controller combo.
- Untested on real TVs: whether every remote and firmware passes Play/Pause to the app. The combo and the color keys work without it.

**App menu.** In the app list, press **CH+** or **Play/Pause** on the remote, or **Select** on a controller, to open the menu of the selected app. The header of the app list names these keys, and the app that runs on the PC has a mint ring and a mint *Running* badge.

| Entry | What it does |
|---|---|
| Resume or Start | *Resume* for the running app, *Start* for the others: the same as OK on the tile |
| Quit app | Only for the running app: quits it on the PC after a confirmation, like *Quit Running App* |
| Hide app, Show app again | Leaves the app out of the app list and the Smart Hub tiles of this host, or brings it back |
| Show hidden apps (N), Hide hidden apps | Shows the hidden apps of the host dimmed, with a *Hidden* badge, until you choose *Hide hidden apps* or restart Moonlight |

- The TV stores the hidden apps of each host, by ID and title, so an app stays hidden when Sunshine gives it a new ID. Deleting the host forgets them.
- The running app always shows, also when it is hidden, so you can resume or quit it. When every app of a host is hidden, all of them show.

## 17. The screens of the app

**Header.** On the left: the Back button (in the app list and the settings), the logo and the name of the screen; in the settings also the name of the open section, in its color, and in the app list the keys of the app menu. On the right: the stream profile of the settings (e.g. *4K · 60 FPS · HEVC HDR*), the network connection of the TV (Wi-Fi or Ethernet) and round buttons, which UP reaches from the top row:

| Icon | Button | Where |
|---|---|---|
| Circular arrow | Rescan network: searches the local network for PCs again, the arrow turns while it searches | Hosts |
| Gear | Settings | Hosts |
| Question mark | Support: the guide as a QR code, and where to report problems | Hosts |
| Round arrow with a clock | Restore Defaults | Settings |
| Circle with a cross | Quit Running App | App list |

A *New update* button with a download arrow appears in the header when a newer release exists (see [Updates](#updates)).

**Hosts.** The top of the screen shows the selected PC in large type: its address, its state as chips (*Running*, *Online*, *Paired*, *Unpaired*, *Offline*), one sentence on what OK does and the keys to press, next to a drawing of a PC that changes with the state. Below, each PC has a card with a colored tile (mint while a game runs, amber when not paired, gray when offline) and its most important state. The ⋯ button of a card opens its menu (*Refresh apps*, *Wake PC*, *Delete PC*, *View Details*): UP reaches it from the first row of cards, and CH+ or Play/Pause opens the menu from any row, as the hint *↑ Options* or *⋯ Options* says. When the focus is in the header or a menu, the top shows the last PC without the keys, or a summary of all PCs.

**App list.** The top shows the selected app with its box art, and the colors of the box art light up the screen once the selection rests on the app. A white ring marks the selected tile. The app that runs on the PC has a mint ring and a *Running* badge, and hidden apps, when shown, are dimmed with a *Hidden* badge (see [section 16](#16-stream-menu-and-app-menu)). An app without box art shows its title on its tile.

**Settings.** The sections are colored tiles on the left, with a line on what each holds. Each option is a row with its title and control at the top and its help text below. The color of the open section marks its tile, the selected row and the switches that are on.

**Start of a stream.** The box art of the app, and next to it its title, the PC and the progress of the connection, centred on the screen.
