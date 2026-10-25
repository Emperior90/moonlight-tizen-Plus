# Tests

The tests run on a normal Linux or macOS machine without a TV and without the Tizen or Emscripten toolchains. The CI workflow `.github/workflows/tests.yml` runs all of them on every push and pull request.

| Folder | What it checks | Runs with |
|---|---|---|
| `tools/` | The scripts that run on the TV stay within ES2018 (Chromium M69 on Tizen 5.5), the EM_ASM blocks have no comma that Emscripten 1.39 can't handle, the locale files are in sync and every pt-BR text is translated | Node |
| `unit/` | Pure functions of the platform scripts (the TV profile of `tv_profile.js` with its optimal settings, warning rules and settings snapshot, version check of the in-app update check, app IDs and branding (display name, description, version and icon of `res/config.xml`, the header title), key mapping, menu gamepad polling and controller descriptions, the gamepad mapping of the menus with its auto-repeat on a simulated clock, the rumble of a stream on a simulated vibration actuator and clock, reading the stored settings with a simulated IndexedDB), loaded as a Node module or into a Node `vm` context with a simulated TV, the checkers of `tools/`, the step of the `Dockerfile` that injects the build metadata (run with `sh` and GNU sed on a copy of `index.js`, with the repository the built app checks for updates), that `wasm/` and `res/` mention the S90C only where the allow-list of `unit/model-mentions.test.js` keeps it (the internal IDs, the preview file prefix and the tested profile), and that no dialog title or text that the scripts set has a `data-i18n` attribute, which the translation pass would reset | `node:test` |
| `native/` | `wasm/gamepad.cpp` (the controllers during a stream: arrival, buttons, combos, the mouse emulation on a simulated clock) and `wasm/controller_type.hpp` built for the host with stubs of the Emscripten and Samsung headers, with the address and undefined behaviour sanitizers | g++ |
| `fixtures/` | Data shared by tests: `controller-types.tsv` lists gamepad ids with the controller type that `wasm/controller_type.hpp` and `wasm/platform/gamepad.js` must both detect | read by the native and unit tests |
| `browser/` | The real UI of `wasm/` in Chromium, served with a simulated TV and a stub of the WebAssembly module: default video settings, the 'Optimal settings for this TV' button and its dialog (also reached with the remote keys), the warnings of the video settings, System information, Restore Defaults, the settings snapshot of existing installs, stored settings and stored values that can't be read, dialogs and the resolution menu during a translation pass, gamepad menus with simulated standard and non-standard controllers (their log, the notice about a non-standard layout, System information), the controller type setting and the rumble of a stream with simulated controllers, stream start and end | Playwright and `node:test` |

## Setup

You need Node.js 22 and g++. Install the pinned test tools (Playwright and acorn) and Chromium once:

```sh
npm ci --prefix tests
npx --prefix tests playwright install chromium
```

Without access to the npm registry, the tests use `playwright` and `acorn` from `NODE_PATH` or the global npm folder instead. The ES2018 check falls back to the copy of acorn that Node bundles.

## Running

From the repository root:

```sh
npm test --prefix tests              # everything, about a minute
npm run test:tools --prefix tests    # ES2018, EM_ASM and locale checks
npm run test:unit --prefix tests
npm run test:native --prefix tests   # builds into tests/native/build
npm run test:browser --prefix tests
node --test tests/browser/video-defaults.test.js   # a single file
```

Known bugs are `todo` tests (in C++ `RunTodoTest`): they are reported as `# TODO` and don't fail the run. Each one names the finding or work package of the generalization plan that fixes it. Once the bug is fixed, the test passes; then drop the `todo` so that it guards the fix.

## Looking at the UI in a browser

```sh
node tests/browser/server.js         # serves http://127.0.0.1:8765
```

Then open e.g. `http://127.0.0.1:8765/index.html?tv=fhd&conn=wifi`. The simulated TV (`browser/mocks/tv-mock.js`) takes these query parameters, which a test can also set with an init script (`openApp(harness, { mockConfig: {...} })`):

| Parameter | Values |
|---|---|
| `tv` | `s90c` (QE55S90CAT, 4K, HDR, Tizen 9.0, default), `uhd` (4K, HDR, Tizen 6.5), `fhd` (Full HD, no HDR, Tizen 5.5), `8k` |
| `model`, `series`, `modelCode` | what `getRealModel()`, `getModel()` and `getModelCode()` return |
| `panel` | `fhd`, `4k`, `8k` |
| `hdr` | `1` or `0` |
| `tizen` | the platform version, e.g. `6.5` |
| `conn` | `ethernet`, `wifi`, `unknown`, or `error` for a failing network API |
| `wifiSignal` | 0 to 1, or `nan` |
| `forceGM` | `1` for the ForceGM variant |
| `failApis` | comma-separated API paths that fail, e.g. `webapis.avinfo.isHdrTvSupport,tizen.systeminfo.getCapability`: a function throws, an object (e.g. `webapis.avinfo`) is removed |
| `wasmStartMs` | how long the stub of the WebAssembly module takes to start, in milliseconds (default 50) |

Settings of an existing install go into IndexedDB before the app starts with `openApp(harness, { stored: { resolution: '1920:1080', ... } })`. `openApp` waits until the app logged the ready signals of a complete start (`READY_SIGNALS` in `browser/harness.js`); for a start that stops early on purpose, or one that should not wait for the translation, pass the log texts to wait for as `readySignals`.

## What the expectations mean

The first tests pinned the behaviour of the app before the generalization for all Samsung TVs. The S90C values (plan section 3) must stay exactly as they are. Since the TV profile (`wasm/platform/tv_profile.js`), the other simulated TVs get the values derived from their capabilities, and existing installs keep the values they showed before through the one-time settings snapshot (`browser/existing-install.test.js`). The warnings of the video settings come from rules in the same file (plan WP4): on the S90C every resolution, frame rate and bitrate keeps the warning it had, which `unit/video-warnings.test.js` checks against a copy of the earlier rules, while the texts may be more general (plan section 3). When a later change alters a default on purpose, update the expectations in the same change and say why; when it alters a default of a stored setting, also raise the settings schema and freeze the previous defaults, so that existing installs keep them.
