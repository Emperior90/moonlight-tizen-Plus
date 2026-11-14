# Building Moonlight Plus

The files of a release (`Moonlight.wgt` and `Moonlight-ForceGM.wgt`) are built with the `Dockerfile` of the repository. The commit that a release links holds the app and the libraries that the repository carries (moonlight-common-c with ENet and the Reed-Solomon code, libgamestream and Opus). This page lists everything else that the build downloads, with its source, so that the source code of every part of a release can be found. The licences of the parts that go into the app are in [THIRD-PARTY-NOTICES.txt](../wasm/static/licenses/THIRD-PARTY-NOTICES.txt).

## Commands

The workflow *Release* (`.github/workflows/release-development.yml`) builds the target `wgt` of the `Dockerfile` for each variant and writes the widget file to a folder of the runner; it publishes no Docker image. The same with Docker and BuildKit:

```sh
docker buildx build --target wgt --output type=local,dest=out/standard \
  --build-arg BUILD_TYPE=development --build-arg REPO_OWNER=Emperior90 --build-arg REPO_NAME=moonlight-tizen-Plus \
  --build-arg FORCE_GAME_MODE=false .
docker buildx build --target wgt --output type=local,dest=out/forcegm \
  --build-arg BUILD_TYPE=development --build-arg REPO_OWNER=Emperior90 --build-arg REPO_NAME=moonlight-tizen-Plus \
  --build-arg FORCE_GAME_MODE=true .
```

They write `out/standard/Moonlight.wgt` and `out/forcegm/Moonlight-ForceGM.wgt`. `REPO_OWNER` and `REPO_NAME` name the repository whose releases the in-app update check reads; a build of your own fork names your fork. Without `--target wgt`, `docker build` makes the full image of the build, with the Tizen Studio CLI, for your own use. The build signs the package with a certificate that it makes itself; the install methods of the [guide](GUIDE.md#installation) sign it again for your TV.

## What the build downloads

The tools of the build:

- **Ubuntu 22.04**, the Docker image `ubuntu:22.04`, pinned by its digest (see [What the build checks](#what-the-build-checks)), with the packages `cmake`, `ccache`, `expect`, `git`, `ninja-build`, `python2`, `unzip` and `aria2` of its archive. None of them goes into the app.
- **Tizen Studio 6.1**, the web CLI that packages and signs the widget: https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_ubuntu-64.bin. None of it goes into the app.
- **Samsung Emscripten SDK 1.39.4.7**, the WebAssembly toolchain of Samsung for Tizen TVs, saved as `emscripten-1.39.4.7-linux64.zip`: https://developer.samsung.com/smarttv/file/a5013a65-af11-4b59-844f-2d34f14d19a9. Its runtime, musl, libc++, libc++abi, compiler-rt and the TizenTV extensions are compiled into the app. The source of this fork of Emscripten is https://github.com/SamsungDForum/emscripten (branch `samsung_fork`, version 1.39.4).

The libraries that the ports of the Samsung Emscripten SDK download and compile into the app the first time the build links them (`-s USE_CRYPTO=1 -s USE_SSL=1 -s USE_CURL=1` in `CMakeLists.txt`). Each port checks the archive against the SHA-512 checksum below and stops the build when it differs:

- **OpenSSL 1.1.1d** (`tools/ports/tizen/crypto.py` and `ssl.py` of the SDK): https://github.com/openssl/openssl/releases/download/OpenSSL_1_1_1d/openssl-1.1.1d.tar.gz. The ports name `https://www.openssl.org/source/old/1.1.1/openssl-1.1.1d.tar.gz`, which no longer works, so the `Dockerfile` points them at the release of OpenSSL on GitHub. SHA-512:
  `2bc9f528c27fe644308eb7603c992bac8740e9f0c3601a130af30c9ffebbf7e0f5c28b76a00bbb478bad40fbe89b4223a58d604001e1713da71ff4b7fe6a08a7`
- **curl 7.68.0** (`tools/ports/tizen/curl.py`): https://curl.haxx.se/download/curl-7.68.0.tar.bz2, which curl now serves as https://curl.se/download/curl-7.68.0.tar.bz2. SHA-512:
  `ad7390fd700cb74db356a39e842dab011823b87d4047687f2a8c2e0f2920a4f8c6c193ba56391489a75939cc5c39a4dccec4e4ceeac516eb7394f03e0fb7aeae`
- **zlib 1.2.8**, which the port of curl pulls in (`tools/ports/zlib.py`, version `version_1` of emscripten-ports/zlib): https://github.com/emscripten-ports/zlib/archive/version_1.zip. SHA-512:
  `77f7d8f18fe11bb66a57e358325b7422d721f7b506bd63293cfde74079f958864db66ead5a36c311a76dd8c2b089b7659641a5522de650de0f9e6865782a60dd`

Copies of these three archives, checked against the checksums above, are kept in the release [build-inputs](https://github.com/Emperior90/moonlight-tizen-Plus/releases/tag/build-inputs) of this repository (with `SHA512SUMS.txt`), in case their servers drop them. The workflow *Licence and source assets* (`.github/workflows/licence-assets.yml`, task *build-inputs*) makes them.

The OpenSSL/SSLeay licence of OpenSSL 1.1.1d is considered incompatible with the GPL by the FSF; see *Known licence issue* in the [README](../README.md#license).

## What the build checks

A download that was replaced or damaged should stop the build instead of going into a release. This is how far the build checks what it downloads:

| Download | Check |
| --- | --- |
| Ubuntu 22.04 image | Pinned by its digest in both `FROM` lines of the `Dockerfile`: `sha256:74b12b11ffa550fba1929ad4d8d16533c34f6612728469671afba1b03b66881c`, the image index of `ubuntu:22.04` (all platforms) that Docker Hub served on 13 November 2026. Docker pulls the image by this digest, so a build can't get another image under the same tag. |
| Ubuntu packages | `apt` checks them against the signed package lists of the Ubuntu archive. Their versions are not pinned: a build installs the versions of its day. |
| Tizen Studio 6.1 installer | **Not checked yet.** Its SHA-256 is not recorded. The build prints the SHA-256 of the file it downloaded into its log. |
| Samsung Emscripten SDK 1.39.4.7 | **Not checked yet.** Its SHA-256 is not recorded. The build prints the SHA-256 of the file it downloaded into its log. |
| OpenSSL 1.1.1d, curl 7.68.0, zlib 1.2.8 | The ports of the SDK check them against the SHA-512 checksums above. |

To add the check of one of the two SDK downloads, download the file from its address above and run `sha256sum` on it. Compare the value with the one that a release build printed for this file in its log. In the `Dockerfile`, the `RUN` instruction of the download ends with `sha256sum <file>`, which prints the value. Replace that command with the check:

```sh
echo "<SHA-256>  <file>" | sha256sum -c -
```

There are two spaces between the value and the file name. A file with another checksum then stops the build. State the value in the table above and remove the download from the list `UNCHECKED` of `tests/unit/dockerfile-downloads.test.js`: that test checks that every download of the `Dockerfile` is checked or stands on that list, and that this page states the checksums that the `Dockerfile` uses.

To take a newer image of Ubuntu, replace the digest in both `FROM` lines of the `Dockerfile` and in the table with the one that `docker buildx imagetools inspect ubuntu:22.04` prints.

The same downloads do not make two builds of a commit identical bit for bit: every build makes a new certificate to sign the package with, and installs the Ubuntu packages of its day.
