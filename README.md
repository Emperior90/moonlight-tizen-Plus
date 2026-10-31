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

![The Hosts screen of Moonlight Plus: the focused PC "GAMING-PC" with the chips Running, Online and Paired, the hints "OK Open" and "Options", a drawing of a PC that runs a game, and a row of PC cards that show their state (running, offline, unpaired, online) next to the Add Host card](docs/images/hosts.jpg)

![The app list of Moonlight Plus: the running game "Neon Drift" with its box art at the top right and a Running chip, and below it a grid of box art tiles, the focused one with a white ring and a mint Running badge](docs/images/apps.jpg)

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
- [S90C documents of the first release](https://github.com/Emperior90/moonlight-tizen-Plus/tree/v1.19.0-s90c.1/docs): the German tuning plan and quick guide of the Samsung S90C, the model this fork was first tuned on, kept at the tag v1.19.0-s90c.1

---

## Support

Open an issue on the [issue tracker of this fork](https://github.com/Emperior90/moonlight-tizen-Plus/issues/new/choose). Please add a photo of Settings → About → *System information*, your host GPU and the controller you use. The [troubleshooting section](docs/GUIDE.md#troubleshooting) of the guide explains the common messages.

---

## Development

- Build: the [Development Guide of Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen/wiki/Development-Guide) applies. A release or development build of the `Dockerfile` needs `--build-arg REPO_OWNER=<owner> --build-arg REPO_NAME=<repo>`, the repository whose releases the in-app update check reads.
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

## License

Moonlight Plus is licensed under the `GNU General Public License v3.0`, like Moonlight Tizen. See the [LICENSE](LICENSE) file for more information. Each release links the commit it was built from, which is its source code.

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
