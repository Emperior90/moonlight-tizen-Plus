# Tests

The tests run on a normal Linux or macOS machine without a TV and without the Tizen or Emscripten toolchains. The CI workflow `.github/workflows/tests.yml` runs all of them on every push and pull request.

| Folder | What it checks | Runs with |
|---|---|---|
| `tools/` | The sources and documents as files: the scripts that run on the TV stay within ES2018 (Chromium 69 of Tizen 5.5), no EM_ASM block has a comma that Emscripten 1.39 can't handle, the locale files are in sync and translated (`i18n-check.js`, with the texts that may stay English in `i18n-same-as-english/`), and every local link and heading of the documents and the issue forms exists (`check-markdown-links.js`). | Node |
| `unit/` | The platform scripts of `wasm/platform/` as Node modules or in a `vm` context with a simulated TV, the tools and Dockerfile steps, the release workflow run with bash against a simulated GitHub API, the package and the native build files, and the documents against the code (the bitrate table and statements of the guide, the patch notes, the changelog and the release notes). Each file says at its top what it checks. | `node:test` |
| `native/` | The native code, built with g++ and gcc with the address and undefined behaviour sanitizers: the controllers, statistics, messages and stream fixes of `wasm/`, files of moonlight-common-c and libgamestream, and the Opus decoder from the file list of `CMakeLists.txt`; `run.sh` also compiles every source file of the WebAssembly module without linking, against stub headers. | `bash native/run.sh` |
| `fixtures/` | Data that a native and a unit test share, so that the C++ code that writes a message and the JavaScript that reads it agree (controller types, video track rejections, statistics lines, session reports, button mappings, an excerpt of the generated Embind code). | read by the tests |
| `browser/` | The real UI of `wasm/` in Chromium, served with a simulated TV and a stub of the WebAssembly module (`browser/mocks/`): the settings and their dialogs, the screens, the Stream Menu and the app menu, controllers, the languages with their layouts, and the start, stop and resume of a stream. | Playwright |
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

RUNTIMES_PLACEHOLDER

## Looking at the UI in a browser

```sh
node tests/browser/server.js         # serves http://127.0.0.1:8765
```

The server assembles the widget the way `CMakeLists.txt` installs it, so the files that it leaves out (e.g. `static/locales/en-US.json`) answer 404 like a missing file on the TV. Then open e.g. `http://127.0.0.1:8765/index.html?tv=fhd&conn=wifi`. The simulated TV (`browser/mocks/tv-mock.js`) takes these query parameters, which a test can also set with an init script (`openApp(harness, { mockConfig: {...} })`):

| Parameter | Values |
|---|---|
| `tv` | `s90c` (QE55S90CAT, 4K, HDR, Tizen 9.0, default), `uhd` (4K, HDR, Tizen 6.5), `fhd` (Full HD, no HDR, Tizen 5.5), `8k` |
| `model`, `series`, `modelCode` | what `getRealModel()`, `getModel()` and `getModelCode()` return |
| `panel` | `fhd`, `4k`, `8k` |
| `hdr` | `1` or `0` |
| `tizen` | the platform version, e.g. `6.5` |
| `conn` | `ethernet`, `wifi`, `unknown`, or `error` for a failing network API |
| `ip`, `subnetMask` | what `webapis.network.getIp()` and `getSubnetMask()` return (default `192.168.0.50` and `255.255.255.0`) |
| `wifiSignal` | 0 to 1, or `nan` |
| `forceGM` | `1` for the ForceGM variant |
| `failApis` | comma-separated API paths that fail, e.g. `webapis.avinfo.isHdrTvSupport,tizen.systeminfo.getCapability`: a function throws, an object (e.g. `webapis.avinfo`) is removed |
| `wasmStartMs` | how long the stub of the WebAssembly module takes to start, in milliseconds (default 50) |
| `wasmPlayer` | the `tizentvwasm` object of the WASM player: `none` (default, as in a desktop browser), `ull` (offers the Ultra Low Latency mode), `noUll`, `apiLevels` (API levels without `isApiFeatureSupported()`), `legacy` (no `availableApis`), `disagree` (the feature list and `isApiFeatureSupported()` disagree), `throws` |
| `locale` | the language of the TV that `tizen.systeminfo` reports as `LOCALE`, e.g. `de_AT` (default: none, the app then reads the languages of the browser) |
| `codecs` | what `MediaSource.isTypeSupported()` answers for the codecs of the WASM player: `all` (default), `noAv1`, `noAv1Main10`, `noLevel52`, `acceptsBogus` (also a codec that doesn't exist), `noH264`, `throws`, `none` (no `MediaSource`) |

Settings of an existing install go into IndexedDB before the app starts with `openApp(harness, { stored: { resolution: '1920:1080', ... } })`. `openApp` waits until the app logged the ready signals of a complete start (`READY_SIGNALS` in `browser/harness.js`); for a start that stops early on purpose, or one that should not wait for the translation, pass the log texts to wait for as `readySignals`.

### Text that is wider elsewhere

Text isn't equally wide on every machine: the headless Chromium that Playwright starts in CI hints the glyphs and draws a line about 4 % wider than a browser started with `--font-render-hinting=none`, and the TV has a renderer of its own. So the layout tests of the languages (the tooltips of the header, the Stream Menu, the settings rows, badges and section tiles, the chips, the hint of the app menu, the compact statistics line and the long dialogs) run their checks a second time with every text about 10 % wider, through `forEachTextWidth(page, run)` of `browser/text-stress.js`. A new layout check of the languages should run through it as well.

## What the expectations mean

The first tests pinned the behaviour of the app on the S90C, the model it was first tuned on, before it learned other Samsung TVs. These S90C values must stay exactly as they are. Since the TV profile (`wasm/platform/tv_profile.js`), the other simulated TVs get the values derived from their capabilities, and existing installs keep the values they showed before through the one-time settings snapshot (`browser/existing-install.test.js`). The warnings of the video settings come from rules in the same file: on the S90C every resolution, frame rate and bitrate keeps the warning it had, which `unit/video-warnings.test.js` checks against a copy of the earlier rules, while the texts may be more general. When a later change alters a default on purpose, update the expectations in the same change and say why; when it alters a default of a stored setting, also raise the settings schema and freeze the previous defaults, so that existing installs keep them.
