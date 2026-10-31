# Moonlight Plus

Moonlight Plus is an unofficial fork of [Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen) by brightcraft. Like Moonlight Tizen, it streams games, programs or the whole desktop from your PC to a Samsung Smart TV, with [Sunshine](https://github.com/LizardByte/Sunshine) on the PC. It is based on Moonlight Tizen 1.19.0 and adds settings that adapt to your TV, clearer messages and many fixes.

> [!NOTE]
>
> Moonlight Plus is not made or supported by the Moonlight Tizen project, the Moonlight project or Samsung. Please report problems with Moonlight Plus on the [issue tracker of this fork](https://github.com/Emperior90/moonlight-tizen-Plus/issues), not to Moonlight Tizen.

---

## Main improvements

- **A new interface for the TV:** large type, the state of each PC at a glance, box art that lights up the screen and favorites first ([screens](docs/GUIDE.md#the-screens-of-the-app)).
- **Optimal settings for this TV** in one button, and warnings that match its panel, decoder and network ([optimal settings](docs/GUIDE.md#optimal-settings-for-this-tv)).
- **Smoother video:** reworked frame pacing, faster error correction and fixes for freezes after packet loss.
- **Clear messages** instead of frozen or black pictures, e.g. which video format the TV rejected ([troubleshooting](docs/GUIDE.md#troubleshooting)).
- **Stream Menu** on Play/Pause or Select + Start: change the bitrate in a game, type text on the PC, send Alt + Tab ([Stream Menu](docs/GUIDE.md#stream-menu-and-app-menu)).
- **Statistics and diagnostics** that show whether the host, the network or the TV causes a problem ([statistics](docs/GUIDE.md#performance-statistics)).
- **Controllers:** Select and Start in the menus, rumble, mouse emulation, a button mapping and an input test ([controllers](docs/CONTROLLERS.md)).
- **Audio and languages:** 5.1 through a soundbar, and English, German, Spanish, French or Brazilian Portuguese ([audio](docs/GUIDE.md#audio), [languages](docs/GUIDE.md#language)).

What changed in each version, in short: [patch notes](docs/PATCH_NOTES.md). Every detail: [changelog](CHANGELOG.md).

![The PC list of Moonlight Plus, titled PCs: the focused PC "GAMING-PC" with one Running chip, the hints "OK Open" and "Options", a drawing of a PC that runs a game, and a row of PC cards that show their state (running, offline, unpaired, online) next to the Add PC card](docs/images/hosts.jpg)

![The app list of Moonlight Plus: the running game "Neon Drift" with its box art at the top right, a Running chip and the hint "OK Resume", the keys of the app menu and the button that quits the app on the PC in the header, and below a grid of box art tiles, the focused one with a white ring and a mint Running badge](docs/images/apps.jpg)

*Screenshots of a simulated TV with made-up PCs and generated box art.*

---

## Requirements

- **TV:** a Samsung Smart TV with Tizen 5.5 or newer (model year 2020 or later).
- **Host:** a PC with [Sunshine](https://github.com/LizardByte/Sunshine) and a GPU with a hardware video encoder.
- **Network:** the host PC on a cable, the TV on 5 GHz Wi-Fi or Ethernet. Most Samsung TVs have a 100 Mbps Ethernet port, so Wi-Fi allows higher bitrates.
- **Controller (optional):** see [Controllers](docs/CONTROLLERS.md).

---

## Installation

Download the file from the [releases page of this fork](https://github.com/Emperior90/moonlight-tizen-Plus/releases). Take the release marked *Latest*. Pre-releases are test builds. The [patch notes](docs/PATCH_NOTES.md) say what each version changed.

| Your TV | File |
|---|---|
| Tizen 9.0 or newer | `Moonlight-ForceGM.wgt` |
| Tizen 5.5 to 8.0 | `Moonlight.wgt` |

The ForceGM variant asks the TV for its Game Mode. Keep the *Ultra low latency mode* switch of the app off with it.

Install the file with a method that works for Moonlight Tizen, e.g. **Apps2Samsung** (*Custom WGT File*) or **Tizen Studio**, as described in the [Installation Guide of Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen/wiki/Installation-Guide). Its Docker method installs the regular Moonlight app from the image of Moonlight Tizen, not Moonlight Plus. The [guide](docs/GUIDE.md#installation) has the steps.

Moonlight Plus installs **next to** the regular Moonlight app, with its own settings and its own pairing. Pair your PC once on the first start, even if the regular Moonlight app is already paired.

The earlier release v1.19.0-s90c.1 (*Moonlight S90C*) never offers Moonlight Plus: an update that it announces is the regular Moonlight Tizen app. Install Moonlight Plus once by hand, which installs over it ([updates](docs/GUIDE.md#updates)).

---

## Documentation

- [Guide](docs/GUIDE.md): installation, the screens, the optimal settings, the Stream Menu, finding your bitrate, host settings, HDR, audio, performance statistics, System information, known limits and troubleshooting
- [Controllers](docs/CONTROLLERS.md): supported controllers, modes, buttons, controller type, rumble and mouse emulation
- [Patch notes](docs/PATCH_NOTES.md): what changed in each version, in short, with every detail in the [changelog](CHANGELOG.md)
- [Translating](docs/TRANSLATING.md): the languages of the app, the rules and the German, Spanish and French glossaries for translators, and how to add a text or a language
- [Building](docs/BUILD.md): the build commands of the releases and everything that the build downloads, with its source
- [S90C documents of the first release](https://github.com/Emperior90/moonlight-tizen-Plus/tree/v1.19.0-s90c.1/docs): the German tuning plan and quick guide of the Samsung S90C, the model this fork was first tuned on, kept at the tag v1.19.0-s90c.1

---

## Support

Open an issue on the [issue tracker of this fork](https://github.com/Emperior90/moonlight-tizen-Plus/issues/new/choose). Please add a photo of Settings → About → *System information*, your host GPU and the controller you use. The [troubleshooting section](docs/GUIDE.md#troubleshooting) of the guide explains the common messages.

---

## Development

- Build: [docs/BUILD.md](docs/BUILD.md) gives the commands of the releases and lists the SDKs and library sources that the build downloads; the [Development Guide of Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen/wiki/Development-Guide) explains the setup. A release or development build of the `Dockerfile` needs `--build-arg REPO_OWNER=<owner> --build-arg REPO_NAME=<repo>`, the repository whose releases the in-app update check reads.
- Tests: `npm test --prefix tests` runs the tests without a TV (see [tests/README.md](tests/README.md)).
- Upstream: the workflow *Check upstream dependencies* (run it from the Actions tab) lists the changes of Moonlight Tizen, moonlight-common-c, ENet, Opus, libgamestream and Sunshine that are newer than the reviewed state in [dependency-baselines.json](.github/dependency-baselines.json), in one issue with compare links. That file records each upstream change as taken or skipped, with the reason.
- Contributing: see [CONTRIBUTING](.github/CONTRIBUTING.md).

---

## About Moonlight Tizen

Moonlight Tizen is a port of [Moonlight ChromeOS](https://github.com/moonlight-stream/moonlight-chrome), an open-source client for NVIDIA GameStream and Sunshine. Its history, as told in the README of Moonlight Tizen:

- It started as a WebAssembly port for Tizen TVs by the [Samsung Developers Forum](https://github.com/SamsungDForum/moonlight-chrome), which replaced the Native Client module with WebAssembly and used the Tizen WASM Player for hardware-accelerated video and audio (see their [article](https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/game-streaming-on-tizen-tv-with-wasm.html)).
- [KyroFrCode](https://github.com/KyroFrCode/moonlight-chrome-tizen) turned it into an installable Tizen application.
- In September 2023, brightcraft started a fork, which became the standalone repository [brightcraft/moonlight-tizen](https://github.com/brightcraft/moonlight-tizen), with a new logo, refactored code, updated libraries and many new features.

To support the developer of Moonlight Tizen or to get help with the regular Moonlight app, see the [README of Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen#readme).

---

## Privacy

Moonlight Plus has no analytics, telemetry, ads or accounts, and sends nothing to its developer. On its own it connects only to:

- **The PCs you add or that the scan finds**, for pairing and streaming: at their address, their name with `.local`, their local address and, if none of these answers, the public address of their network.
- **Your local network**, at startup while the PC list shows and when you choose *Rescan network*: one HTTP request to port 47989 of every address of the /24 network of the TV (e.g. 192.168.1.1 to 192.168.1.254), to find PCs with Sunshine.
- **api.github.com (GitHub)**, at startup at most once a day and when you choose *Check for updates*, to read the latest release of this fork. GitHub sees the IP address of your network and the usual headers of the browser of the TV, such as its user agent, and no identifier of the app or of you.
- **stun.moonlight-stream.org (the Moonlight project), UDP port 3478**, when the scan finds a new PC or a new address of a known PC, to learn the public IP address of your network (inherited from Moonlight).
- **Wake-on-LAN broadcasts** on your local network, only when you choose *Wake PC*.

The background service of the Smart Hub tiles also serves the cached box art on port 8889 of the TV for the Smart Hub, which other devices on your network can reach as well. Settings, paired PCs, the pairing certificate and the box art stay in the storage of the app on the TV. The [diagnostic log](docs/GUIDE.md#diagnostic-log) and the report of the last session are kept in memory and shown on the screen; they leave the TV only if you photograph or share them. The log hides the keys, the public IP address and the MAC addresses. The privacy statement of GitHub applies to what GitHub receives.

---

## License

Moonlight Plus is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3 of the License, which Moonlight Tizen uses as well. Moonlight Plus is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for the full text.

- Moonlight Tizen: Copyright (C) brightcraft and the contributors of Moonlight Tizen
- Moonlight (moonlight-chrome, moonlight-common-c): Copyright (C) the Moonlight Game Streaming Project
- libgamestream of Moonlight Embedded: Copyright (C) 2015 Iwan Timmer
- The Tizen WebAssembly port of moonlight-chrome: Copyright (c) 2015 Samsung Electronics
- `wasm/platform/common.js`: Copyright (c) 2012 The Chromium Authors
- Moonlight Plus changes: Copyright (C) 2026 Emperior90, made with AI assistance

The third-party components and their licences, with the full licence texts, are listed in [wasm/static/licenses/THIRD-PARTY-NOTICES.txt](wasm/static/licenses/THIRD-PARTY-NOTICES.txt). This file and LICENSE are also inside the app package.

**Code from other projects:** Moonlight Plus contains code ported from the GPL-3.0 forks of Moonlight Tizen by [fidoboy](https://github.com/fidoboy/moonlight-tizen-ac3) (moonlight-tizen-ac3), [mmadej20](https://github.com/mmadej20/moonlight-tizen-modern) (moonlight-tizen-modern), [samirmartins](https://github.com/samirmartins/moonlight-tizen), [Diogo8500](https://github.com/Diogo8500/moonlight-tizen) and [waresz](https://github.com/waresz/moonlight-tizen) (each moonlight-tizen). The source files and the notices name what comes from where.

**Source code:** each release links the commit it was built from, which is its source code. [docs/BUILD.md](docs/BUILD.md) lists the SDKs and the sources of the libraries that the build downloads.

**Known licence issue:** the build statically links OpenSSL 1.1.1d (OpenSSL/SSLeay licence) through the Samsung Emscripten ports, as Moonlight Tizen and the other Moonlight Tizen forks do. The FSF considers that licence incompatible with the GPL. Moving to a TLS library that is compatible with GPL-3.0 (OpenSSL 3 or mbedTLS) is planned.

---

## Credits

Moonlight Plus builds on the work of everyone who made Moonlight Tizen possible. The [contributors of Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen/graphs/contributors?all=1):

<a href="https://github.com/brightcraft/moonlight-tizen/graphs/contributors?all=1">
  <img src="https://contrib.rocks/image?repo=brightcraft/moonlight-tizen"/>
</a>

The special thanks of the README of Moonlight Tizen:

- [Moonlight Game Streaming Project](https://github.com/moonlight-stream) — for creating the core Moonlight implementation, adapting the NVIDIA GameStream protocol, and developing the Moonlight Chrome OS client. The project's open-source work made it possible to bring Moonlight streaming support to additional platforms and serves as the foundation for the entire Tizen port.
- [Samsung Developers Forum](https://github.com/SamsungDForum/moonlight-chrome) — for creating the first Tizen OS (WASM) adaptation based on the Moonlight Chrome OS client. Their work made Moonlight available on Samsung Smart TVs by integrating the client with Tizen's WASM environment, including video and audio playback through Tizen WASM Player, platform-specific adjustments, and the initial groundwork required for running Moonlight on Tizen devices.
- [KyroFrCode](https://github.com/KyroFrCode/moonlight-chrome-tizen) — for further developing the Tizen implementation by introducing improvements such as a dedicated application build method, 1440p resolution support, a shortcut combo to stop the streaming session, and audio volume control using the remote. This codebase served as the starting point of Moonlight Tizen, which brightcraft later continued as a standalone repository.
- [OneLiberty](https://github.com/OneLiberty/moonlight-chrome-tizen) — for expanding the Tizen implementation in their fork with features such as video codec selection, mouse emulation using the gamepad, Wake-on-LAN (WoL), a new IP address input mode, and other improvements. These changes served as a foundation that was later adapted, improved, and integrated into Moonlight Tizen.
- [toypoodlegaming](https://github.com/toypoodlegaming/moonlight-chrome-tizen) — for further expanding the functionality in their fork with features such as 5.1 and 7.1 surround sound configuration, performance statistics, and enhanced bitrate calculation. These changes served as a foundation that was later adapted, improved, and integrated into Moonlight Tizen.
- [eduardomozart](https://github.com/eduardomozart) — for contributing to the project with localization support featuring Tizen-first locale detection, HTTP subnet scanning, IPv6 and DNS hostname support, custom port support, Smart Hub Preview support, and build optimizations, along with numerous fixes and improvements that were further refined and integrated into the application.
- [fophillips](https://github.com/fophillips) — for contributing to the project by integrating the Web Audio backend implementation from [ruanformigoni](https://github.com/ruanformigoni) alongside the existing EMSS backend, with an Audio Backend selection setting for switching between the two renderers.

Translations of Moonlight Plus:

- German: translated for Moonlight Plus; about half of the texts are based on the German translation of [fidoboy's fork moonlight-tizen-ac3](https://github.com/fidoboy/moonlight-tizen-ac3) (GPL-3.0), rewritten in the informal *du*.
- Spanish: about 340 texts are based on the Spanish translation of [Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen) by brightcraft (`wasm/static/locales/es-ES.json`, GPL-3.0), adapted to the terms of this app; the others are translated for Moonlight Plus.
- French: about 340 texts are based on the French translation of [fidoboy's fork moonlight-tizen-ac3](https://github.com/fidoboy/moonlight-tizen-ac3) (GPL-3.0), adapted to the terms of this app; the others are translated for Moonlight Plus.
- Brazilian Portuguese: from Moonlight Tizen (brightcraft and its contributors), completed for Moonlight Plus.
