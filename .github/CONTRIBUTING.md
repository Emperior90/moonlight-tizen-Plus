# Contributing

Thanks for contributing to Moonlight Plus! Whether you're opening an issue or proposing a pull request, your help is greatly appreciated.

## General Guidelines

- Use proper English. It doesn't have to be complicated, just make it simple and understandable for everyone.
- Search existing issues before creating a new one to avoid duplicates.
- Clearly explain your feature request or the problem you're facing.
- Include steps to reproduce the issue whenever possible.
- Include screenshots or video demonstrations when they help explain the issue.
- When posting an issue, include a photo of the end of the diagnostic log (Settings → About → *Diagnostic log*) and the Sunshine log if you have it (**please remove or mask your private IP**).

## Reporting Issues

If you want to report a bug or request a feature, please use the appropriate issue template:

- **Bug Report** — use this if you found an issue or unexpected behavior.
- **Feature Request** — use this if you want to propose a new feature or improvement.

Please provide as much information as possible. The templates will guide you through the necessary details to help us diagnose and resolve issues faster. Incomplete reports may take longer to investigate.

## Before You Start

Before making changes, consider the following:

- For larger features, significant refactors, or behavior changes, **open an issue or discussion first** to review the proposed approach.
- Check existing issues, discussions, and pull requests to avoid duplicating ongoing work.
- Make sure you understand the purpose of the change and how it fits with the project's current direction.
- Keep changes focused and avoid introducing unrelated improvements in the same contribution.

This helps make reviews easier and ensures contributions align with the project's goals.

## Development Setup

Before opening a pull request, make sure you can build and test your changes successfully:

- Please follow the [development guide](https://github.com/brightcraft/moonlight-tizen/wiki/Development-Guide) in the Wiki of Moonlight Tizen. It explains how to build the app locally and run it on your device.
- **Run the tests** with `npm test --prefix tests` (after `npm ci --prefix tests` and `npx --prefix tests playwright install chromium` once). They need no build of the WebAssembly module, and they run on every push as well; [tests/README.md](../tests/README.md) explains them.
- **Test your changes** on the target Tizen device whenever possible to ensure they work correctly in the real environment.
- When making changes to platform-specific functionality, ensure that your changes do not introduce **regressions or affect existing Tizen behavior**.

Following these steps helps ensure changes are stable, easier to review, and compatible with the Tizen platform.

## Pull Requests

If you want to contribute code, please follow these guidelines:

- Clearly describe what the PR does and why it is needed.
- Reference related issues when applicable (for example, `Fixes #123`).
- Keep pull requests focused on a single feature, fix, or improvement.
- Avoid combining multiple unrelated changes in the same PR.
- Make sure the project builds successfully before submitting.
- Test your changes as much as possible before submitting.
- Include screenshots or videos when changing the user interface.
- Update the documentation if your change affects user-facing behavior.
- Keep commit history reasonably clean before requesting a review.

Large PRs can be harder to review and may require more time. Smaller and focused contributions are easier to review and can usually be processed faster.

## Code Style

- Follow the existing project structure and coding style.
- Avoid unrelated refactoring in feature PRs.
- Do not introduce unrelated formatting changes in the same PR.
- Keep changes minimal and directly related to the improvement or fix.
- Prefer consistency with the existing codebase over introducing new coding patterns.

## Localization

Translations are welcome. [docs/TRANSLATING.md](../docs/TRANSLATING.md) explains how the languages work, how to add or change a text with `node wasm/static/js/i18n-sync.js`, the rules and glossaries of each language and how to add a language. `npm test --prefix tests` checks the locale files and the layouts in every language.

## Third-Party Dependencies

This repository includes several third-party dependencies required for application functionality. The following rules apply to each dependency:

- `libgamestream` — modifications are allowed when required for project functionality or new features.
- `moonlight-common-c` — updates should generally come from the official [upstream repository](https://github.com/moonlight-stream/moonlight-common-c). However, some project-specific changes may be required to maintain Tizen compatibility. Any upstream updates and project-specific changes should only be performed by the maintainer.

  The following files currently require manual updates to preserve Tizen-specific functionality:
  - `moonlight-common-c/.gitmodules`
  - `moonlight-common-c/src/Platform.h`
  - `moonlight-common-c/src/PlatformSockets.c`

- `enet` (submodule of `moonlight-common-c`) — updates should generally come from the official [upstream repository](https://github.com/cgutman/enet). The same update policy and Tizen-specific exceptions described for `moonlight-common-c` also apply here.

  The following file currently requires manual updates to preserve Tizen-specific functionality:
  - `moonlight-common-c/enet/unix.c`
- `opus` — **manual modifications are not allowed**; updates should only come from the official [upstream repository](https://github.com/xiph/opus) and be performed by the maintainer. The app only decodes, so `CMakeLists.txt` builds only the files that the decoder links; after an update of Opus, `npm test --prefix tests` (`tests/native/run.sh`) builds that list and decodes with it.
- `ports` — **manual modifications are not allowed**; there is no dedicated upstream repository. Updates, if ever required, should only be performed by the maintainer.

### Dependency Guidelines

- Avoid modifying third-party libraries manually unless the change is required and follows the rules above.
- Updates should come from the official upstream repositories whenever possible.
- If changes to these libraries are needed, please discuss them with the maintainer first.

Pull requests that include **unauthorized manual modifications** to third-party libraries may be asked to revert those changes.

## Communication

Please keep discussions respectful and constructive. Different opinions are welcome as long as they remain focused on improving the project.

## Final Notes

Contributions are always appreciated. Clear, focused pull requests and well-described issues help keep the project healthy and easier to maintain for everyone.

Every contribution, whether it's code, documentation, bug reports, or translations, helps improve the project.
