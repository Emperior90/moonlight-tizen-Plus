# Tests

The tests run on a normal Linux or macOS machine without a TV and without the Tizen or Emscripten toolchains. The CI workflow `.github/workflows/tests.yml` runs all of them on every push and pull request.

| Folder | What it checks | Runs with |
|---|---|---|
| `tools/` | The sources and documents as files: the scripts that run on the TV stay within ES2018 (Chromium 69 of Tizen 5.5), no EM_ASM block has a comma that Emscripten 1.39 can't handle, the locale files are in sync and translated (`i18n-check.js`, with the texts that may stay English in `i18n-same-as-english/`), and every local link and heading of the documents and the issue forms exists (`check-markdown-links.js`). | Node |
| `unit/` | The platform scripts of `wasm/platform/` as Node modules or in a `vm` context with a simulated TV, the tools and Dockerfile steps, the views of `navigation.js` on a stand-in for the page, the answers of a PC (server info, app list, the scan) with a stand-in for the XML parser of the page (`unit/helpers/xml-stand-in.js`), the release workflow run with bash against a simulated GitHub API, the package with its licence notices, the native build files and the downloads of the `Dockerfile` (`unit/helpers/dockerfile.js`), and the documents against the code (the bitrate table and statements of the guide, the patch notes, the changelog and the release notes). Each file says at its top what it checks. | `node:test` |
| `native/` | The native code, built with g++ and gcc with the address and undefined behaviour sanitizers: the controllers, statistics, messages, frame pacer, audio decoder (with a stand-in for Opus, and with the real Opus library in `native/opus_decoder/`), the overload rule of the sound, the threads of a stream start and stop, the limit of the diagnostic log and the stream fixes of `wasm/`, files of moonlight-common-c, built with the definitions that `CMakeLists.txt` gives it (`run.sh` reads them from there), and of libgamestream (also the log macro, the start of the audio stream, the channel layouts of Sunshine, the SDP negotiation with the audio capabilities of the app and with reference frame invalidation, and the RTSP handshake against a stand-in for the RTSP server of Sunshine with the local error code for an answer with the key of another start), and the Opus decoder from the file list of `CMakeLists.txt`; `run.sh` also checks the condition of the local patch of Opus with the preprocessor and compiles every source file of the WebAssembly module without linking, against stub headers. A test that needs more compiler options or another source file names them in a line `// Build with: …`; the tests are built from the root of the repository, so a source file is named from there. | `bash native/run.sh` |
| `fixtures/` | Data that a native and a unit test share, so that the C++ code that writes a message and the JavaScript that reads it agree, or the C++ and JavaScript copies of a rule (controller types, the input that makes a gamepad slot count as a controller, video track rejections, statistics lines, session reports, button mappings, an excerpt of the generated Embind code). | read by the tests |
| `browser/` | The real UI of `wasm/` in Chromium, served with a simulated TV and a stub of the WebAssembly module (`browser/mocks/`): the settings and their dialogs, the screens, the Stream Menu and the app menu, controllers, the languages with their layouts, the menus driven like a user with the remote and a simulated controller that the real polling reads (`browser/menu-driver.js`), the speed of the navigation, devices on the local network that answer with hostile values (`browser/mocks/lan-devices.js`), and the start, stop and resume of a stream (also against a simulated Sunshine that holds one start at a time), and a TV that a firmware update moved to a newer Tizen version. | Playwright |
| `lib/` | Helpers of the tests: where the test tools are (`dev-modules.js`) and which files `CMakeLists.txt` puts into the widget (`widget-files.js`). | |

## Setup

You need Node.js 22, g++ and gcc. The native tests of libgamestream and the syntax check of `wasm/http.cpp` also need the headers of OpenSSL and curl (e.g. `sudo apt-get install libssl-dev libcurl4-openssl-dev`) and are skipped without them. Install the pinned test tools (Playwright and acorn) and Chromium once:

```sh
npm ci --prefix tests
npx --prefix tests playwright install chromium
```

Without access to the npm registry, the tests use `playwright` and `acorn` from `NODE_PATH` or the global npm folder instead. The ES2018 check falls back to the copy of acorn that Node bundles.

## Running

From the repository root:

```sh
npm test --prefix tests              # everything, see the run times below
npm run test:tools --prefix tests    # ES2018, EM_ASM, locale and documentation link checks
npm run test:unit --prefix tests
npm run test:native --prefix tests   # builds into tests/native/build
npm run test:browser --prefix tests
node --test tests/browser/video-defaults.test.js   # a single file
```

Measured run times for 2.3.1 on a machine with 4 CPUs: the tools about 1 second, the unit tests about 30 seconds (818 tests), the native tests about 2.5 minutes (mostly compiling) and the browser tests about 9 minutes (489 tests, two files at a time), so `npm test` takes about 12 minutes. In CI the whole run of 2.1.0 took about 5 minutes. A single test file is the faster way while you work on one part.

## Test files added in 2.3.1

| File | What it checks |
|---|---|
| `native/limelog_test.c` | The log macro of moonlight-common-c, built with the definitions of `CMakeLists.txt`: a line reaches the listener of the app unchanged |
| `native/opus_channel_layout_test.c` | The channel layouts that Sunshine announces, through the real `parseOpusConfigurations()`, and the correction of its 7.1 layout |
| `native/opus_decoder/app_decoder_test.cpp` | `wasm/auddec.cpp` with the real Opus library under the leak check: every output channel carries the channel of the host it has to |
| `native/audio_stream_start_test.c` | The start and the end of the audio stream of moonlight-common-c when its threads can't be created |
| `native/audio_load_test.cpp` | The rule of the warning when the sound overloads the TV |
| `native/stream_threads_test.cpp` | The threads of a stream start and stop with real threads, and the late answer of the media source to its close |
| `native/sdp_reference_frames_test.c` | The SDP for a host with and without reference frame invalidation |
| `native/hex_text_test.cpp` | The hex text of the client certificate, also with bytes of 0x80 and more |
| `unit/library-log-lines.test.js` | The stage messages of moonlight-common-c that the listener knows, and the one place of `LC_LOG` |
| `unit/dockerfile-downloads.test.js` | The pinned base image and that every download of the `Dockerfile` is checked or a listed exception |
| `unit/navigation-views.test.js` | The views of `navigation.js` on a stand-in for the page: drop-downs, views on top, dialogs |
| `unit/menu-texts.test.js` | The start numbers of the Add PC dialog, the button names for the Voice Guide and two statistics fragments in every language |
| `unit/host-uid.test.js` | The unique ID of a host, with real and hostile IDs |
| `unit/host-rfi.test.js` | The local patches of moonlight-common-c for reference frame invalidation |
| `unit/frequent-messages.test.js` | No console line for the statistics and rumble messages, and the line about the app in the full statistics |
| `unit/bitrate-texts.test.js` | The texts about the bitrate in every language |
| `unit/scan-known-host.test.js`, `unit/server-info-fields.test.js`, `unit/box-art-dir.test.js`, `unit/app-list-entries.test.js` | What the app keeps of the answers of a PC: the scan of a paired PC, the fields of the server info, the box art directory, the entries of the app list |
| `browser/settings-menus.test.js`, `browser/pc-list-menus.test.js`, `browser/add-pc-dialog.test.js` | The menus driven like a user: drop-downs, double presses, dialogs, the PC list and the Add PC dialog |
| `browser/navigation-speed.test.js` | How fast the selection follows the remote and the D-pad, with fixed limits; the speed of the app on a desktop machine, not of a TV |
| `browser/web-audio-stereo.test.js`, `browser/surround-quality-default.test.js`, `browser/audio-overload.test.js` | Stereo with Web Audio, the default of *Surround audio quality* with its notice, and the overload message |
| `browser/start-request-failure.test.js` | A start request that fails, also in the silent retry and the reconnect of the Stream Menu, and the uncaught errors in the diagnostic log |
| `browser/hostile-host-id.test.js`, `browser/hostile-server-info.test.js` | Devices on the local network that answer with a hostile unique ID or hostile fields |
| `browser/stats-overlay.test.js` | The box of the full statistics in every language and corner |

## Looking at the UI in a browser

```sh
node tests/browser/server.js         # serves http://127.0.0.1:8765
```

The server assembles the widget the way `CMakeLists.txt` installs it, so the files that it leaves out (e.g. `static/locales/en-US.json`) answer 404 like a missing file on the TV. Then open e.g. `http://127.0.0.1:8765/index.html?tv=fhd&conn=wifi`. The simulated TV (`browser/mocks/tv-mock.js`) takes these query parameters, which a test can also set with an init script (`openApp(harness, { mockConfig: {...} })`):

| Parameter | Values |
|---|---|
| `tv` | `s90c` (QE55S90CAT, 4K, HDR, Tizen 9.0, default), `uhd` (4K, HDR, Tizen 6.5), `fhd` (Full HD, no HDR, Tizen 5.5), `8k` |
| `model`, `series`, `modelCode` | what `getRealModel()`, `getModel()` and `getModelCode()` return |
| `firmware`, `buildString` | what `webapis.productinfo.getFirmware()` returns (set by the `tv` preset) and the build string that `tizen.systeminfo.getCapability()` reports (default `tizen-build-1.0`) |
| `panel` | `fhd`, `4k`, `8k` |
| `hdr` | `1` or `0` |
| `tizen` | the platform version, e.g. `6.5` or `10.0` |
| `conn` | `ethernet`, `wifi`, `unknown`, or `error` for a failing network API |
| `ip`, `subnetMask` | what `webapis.network.getIp()` and `getSubnetMask()` return (default `192.168.0.50` and `255.255.255.0`) |
| `wifiSignal` | 0 to 1, or `nan` |
| `forceGM` | `1` for the ForceGM variant |
| `failApis` | comma-separated API paths that fail, e.g. `webapis.avinfo.isHdrTvSupport,tizen.systeminfo.getCapability`: a function throws, an object (e.g. `webapis.avinfo`) is removed |
| `wasmStartMs` | how long the stub of the WebAssembly module takes to start, in milliseconds (default 50) |
| `wasmPlayer` | the `tizentvwasm` object of the WASM player: `none` (default, as in a desktop browser), `ull` (offers the Ultra Low Latency mode), `noUll`, `noFeatures` (an empty feature list), `apiLevels` (API levels without `isApiFeatureSupported()`), `legacy` (no `availableApis`), `disagree` (the feature list and `isApiFeatureSupported()` disagree), `throws` |
| `locale` | the language of the TV that `tizen.systeminfo` reports as `LOCALE`, e.g. `de_AT` (default: none, the app then reads the languages of the browser) |
| `codecs` | what `MediaSource.isTypeSupported()` answers for the codecs of the WASM player: `all` (default), `noAv1`, `noAv1Main10`, `noLevel52`, `noH264Level51` (H.264 only at level 4.2), `acceptsBogus` (also a codec that doesn't exist), `noH264`, `throws`, `none` (no `MediaSource`) |

Settings of an existing install go into IndexedDB before the app starts with `openApp(harness, { stored: { resolution: '1920:1080', ... } })`. A PC that answers like Sunshine comes with `moduleScripts: ['sunshine-host.js']` (`browser/mocks/sunshine-host.js`, appended to the stub of the module) and `stored: { hosts: SUNSHINE_HOSTS }`, its entry in the hosts list of an existing install; the tests then drive the app list and streams with the keys of the remote. `openApp` waits until the app logged the ready signals of a complete start (`READY_SIGNALS` in `browser/harness.js`); for a start that stops early on purpose, or one that should not wait for the translation, pass the log texts to wait for as `readySignals`. `restartAppOn(harness, app, tvOptions)` starts the app again with what it stored, on a TV with other options, e.g. the same TV after an update to a newer Tizen version.

The menus: `browser/menu-driver.js` opens the app with a simulated controller that the real polling of `gamepad.js` reads, and drives the menus with the keys of the remote and that controller (`openMenus`, `key`, `doubleKey`, `padButton`, `doublePadButton`, `timed`, `menuState`, `takeSnackbars`, `THREE_HOSTS` and more). A timed sequence of the controller goes to a schedule that `navigator.getGamepads()` applies by the clock, not by timers, so a read sees what a real controller would report at that moment also when the page stood still; a press on purpose is held until the menus read it. Since 2.3.1 a drop-down of the settings, the Wake PC dialog and the PC details ignore OK for 300 ms after they opened, unless a key moved the selection meanwhile, so a test that opens one by key and answers with OK right away waits `DROPDOWN_OK_WAIT_MS` of `browser/harness.js` before OK. A local network with several devices comes with `moduleScripts: ['lan-devices.js']` (`browser/mocks/lan-devices.js`): answers per address, scheme and path, and HTTPS only for the right pinned key. `window.__sunshineConfig.apps` gives the simulated Sunshine another app list.

### Text that is wider elsewhere

Text isn't equally wide on every machine: the headless Chromium that Playwright starts in CI hints the glyphs and draws a line about 4 % wider than a browser started with `--font-render-hinting=none`, and the TV has a renderer of its own. So the layout tests of the languages (the tooltips of the header, the Stream Menu, the settings rows, badges and section tiles, the chips, the hint of the app menu, the compact statistics line and the long dialogs) run their checks a second time with every text about 10 % wider, through `forEachTextWidth(page, run)` of `browser/text-stress.js`. A new layout check of the languages should run through it as well.

## What the expectations mean

The first tests pinned the behaviour of the app on the S90C, the model it was first tuned on, before it learned other Samsung TVs. These S90C values must stay exactly as they are. Since the TV profile (`wasm/platform/tv_profile.js`), the other simulated TVs get the values derived from their capabilities, and existing installs keep the values they showed before through the one-time settings snapshot (`browser/existing-install.test.js`). The warnings of the video settings come from rules in the same file: on the S90C every resolution, frame rate and bitrate keeps the warning it had, which `unit/video-warnings.test.js` checks against a copy of the earlier rules, while the texts may be more general. The changes on purpose: since 2.2.0 the S90C warns above 150 Mbps instead of 100 Mbps, the bitrate it streams over 5 GHz Wi-Fi, while its presets and optimal settings stay at 100 Mbps over Wi-Fi; and since 2.2.1 the frame rates end at 120 FPS on every TV, because the video player of Samsung TVs never starts a stream at the 144 FPS that earlier versions offered (as upstream 7d8ab56 removed it). A stored 144 FPS becomes 120 FPS, or 60 FPS where the menu offers no 120 FPS, once and without a notice (`browser/existing-install.test.js`, `unit/tv-profile.test.js`), while the decision whether a bitrate stored next to 144 FPS came from the presets stays as it was. Since 2.3.0 (settings schema 4) *Optimize game settings* is on for a fresh install, after Restore Defaults and after the optimal settings button, as in moonlight-qt and moonlight-android, so the start request of a fresh S90C install sends it on, while an existing install keeps it off (`browser/game-optimizations.test.js`, `browser/existing-install.test.js`); and the H.264 warning above 1080p shows only where the decoder check rejects H.264 at level 5.1 or the stream is above level 5.1, since the app offers level 5.1 to the TV (4K at 60 FPS, the default of the S90C, still warns), with a new warning for H.264 above 60 FPS (`unit/video-warnings.test.js`). Since 2.3.1 the version lists of the tests of the TV profile go up to Tizen 11.0, since Tizen 10 (with two digits before the dot) must follow the rules of Tizen 9.0 (`unit/tizen10.test.js`, `browser/tizen10.test.js`), and an *Ultra low latency mode* switch stored on before an update of the TV to Tizen 9.0 or newer shows its compatibility warning once at the start (`browser/tizen10.test.js`), so a test that stores the switch on for a TV on Tizen 9.0 or newer stores the Tizen version with it (`gameModePlatformVer`), unless it means to see that warning. Also since 2.3.1 (settings schema 5) *Surround audio quality* is *Efficient* by default and after Restore Defaults and the optimal settings button, while a stored quality stays (`browser/surround-quality-default.test.js`); a stream with the Web Audio backend asks for stereo whatever audio configuration is stored (`browser/web-audio-stereo.test.js`); a drop-down of the settings opens with the stored value highlighted (the language menu with a stored language starts on it); and the full statistics come every 2 seconds, the compact line every second (`native/stats_overlay_test.cpp`, `browser/stats-graph-position.test.js`). When a later change alters a default on purpose, update the expectations in the same change and say why; when it alters a default of a stored setting, also raise the settings schema and freeze the previous defaults, so that existing installs keep them.
