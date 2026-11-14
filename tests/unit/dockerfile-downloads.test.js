'use strict';

// Checks what the Docker build downloads and how far it checks it (docs/BUILD.md, "What the build checks"):
// - the two stages that start from Ubuntu use one image, pinned by the digest that docs/BUILD.md states, so that a tag
//   that moved can't change the image of a build;
// - every download of a RUN or ADD instruction is checked against a SHA-256 checksum in a way that stops the build, or
//   stands on the short list UNCHECKED below with its reason. A file that is downloaded without a check prints its
//   SHA-256 into the log of the build, so that the value can be recorded and the check added;
// - docs/BUILD.md states the SHA-256 values that the Dockerfile uses, and no other.
// The test doesn't see what a tool downloads by itself while it runs: the ports of the Samsung Emscripten SDK fetch
// OpenSSL, curl and zlib during `cmake --build` and check them against the SHA-512 checksums of docs/BUILD.md.
//
// The Docker build doesn't run in the tests. The instructions that download are run with `sh`, as Docker runs them, in
// an empty folder with a stand-in for aria2c that writes a known file. This needs sha256sum, as in the Ubuntu image.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { readDockerfile, dockerInstructions } = require('./helpers/dockerfile');

const BUILD = fs.readFileSync(path.join(REPO_ROOT, 'docs/BUILD.md'), 'utf8').replace(/\r\n/g, '\n');

// What the Dockerfile downloads without a check against a checksum, and why: `id` is the address of the download, or
// 'apt-get install' for the packages of Ubuntu, and `docs` is what docs/BUILD.md says about it. Keep this list short:
// a new download gets a check (docs/BUILD.md says how), not an entry here.
const UNCHECKED = [
  {
    id: 'apt-get install',
    why: 'The packages of the Ubuntu archive. apt checks them against the signed package lists of the archive, their ' +
      'versions are not pinned, and none of them goes into the app.',
    docs: /\n\| Ubuntu packages \| `apt` checks them against the signed package lists of the Ubuntu archive\. [^\n]*not pinned/,
  },
  {
    id: 'https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_ubuntu-64.bin',
    why: 'Open: the SHA-256 of the installer of Tizen Studio 6.1 is not recorded yet. The build prints it instead.',
    docs: /\n\| Tizen Studio 6\.1 installer \| \*\*Not checked yet\.\*\* [^\n]*prints/,
  },
  {
    id: 'https://developer.samsung.com/smarttv/file/a5013a65-af11-4b59-844f-2d34f14d19a9',
    why: 'Open: the SHA-256 of the Samsung Emscripten SDK 1.39.4.7 is not recorded yet. The build prints it instead.',
    docs: /\n\| Samsung Emscripten SDK 1\.39\.4\.7 \| \*\*Not checked yet\.\*\* [^\n]*prints/,
  },
];
const UNCHECKED_IDS = UNCHECKED.map((entry) => entry.id);

const SHA256 = '[0-9a-f]{64}';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unique = (list) => list.filter((item, index) => list.indexOf(item) === index);
const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

// The images that the stages of a Dockerfile start from, as { image, digest, line }, without `scratch` and the stages
// that start from an earlier stage. The digest is 'sha256:...', or null for an image that is named by its tag only.
function baseImages(text) {
  const stages = [];
  const images = [];
  dockerInstructions(text).filter((instruction) => instruction.name === 'FROM').forEach((instruction) => {
    const words = instruction.args.trim().split(/\s+/).filter((word) => word.indexOf('--') !== 0);
    const reference = words[0];
    if (reference !== 'scratch' && stages.indexOf(reference.toLowerCase()) < 0) {
      const at = reference.indexOf('@');
      images.push({ image: at < 0 ? reference : reference.slice(0, at), digest: at < 0 ? null : reference.slice(at + 1), line: instruction.line });
    }
    if (words.length === 3 && /^as$/i.test(words[1])) {
      stages.push(words[2].toLowerCase());
    }
  });
  return images;
}

// A command at the start of a shell command line or after an operator: a tool that downloads a file, and the
// installation of packages
const DOWNLOAD_TOOL = /(?:^|&&|\|\||[;|(])\s*(aria2c|curl|wget)\s/g;
const PACKAGE_INSTALL = /(?:^|&&|\|\||[;|(])\s*apt(?:-get)?\s+(?:-\S+\s+)*install\s/;
const ADDRESS = /https?:\/\/[^\s'"|<>)]+/g;

// Find the check of `file` against a SHA-256 checksum in a shell command: the option --checksum=sha-256=... of aria2c,
// or `echo "<checksum>  <file>" | sha256sum -c -` (the line format of sha256sum, with two spaces), joined to the
// commands around it with && only, so that a file that differs stops the build. Returns { checksum }, { problem } for
// a check that names the file in another form, or null.
function findChecksumCheck(command, file) {
  const option = new RegExp('--checksum=sha-256=(' + SHA256 + ')(?=\\s|$)').exec(command);
  if (option) {
    return { checksum: option[1] };
  }
  const check = new RegExp('echo "(' + SHA256 + ') {2}' + escapeRegExp(file) + '" \\| sha256sum -c -').exec(command);
  if (!check) {
    const other = new RegExp('echo[^|;&]*' + escapeRegExp(file) + '[^|;&]*\\|\\s*sha256sum\\s+(?:-c|--check)').test(command);
    return other ? { problem: 'the check of ' + file + ' is not in the form `echo "<SHA-256>  ' + file + '" | sha256sum -c -` (two spaces)' } : null;
  }
  const before = command.slice(0, check.index).trim();
  const after = command.slice(check.index + check[0].length).trim();
  if ((before !== '' && !/&&$/.test(before)) || (after !== '' && !/^&&/.test(after))) {
    return { problem: 'the check of ' + file + ' is not joined to the other commands with && only, so a file that differs may not stop the build' };
  }
  return { checksum: check[1] };
}

// Go through the downloads of a Dockerfile. Returns { sites, problems }: a site is { id, line, checksum } with the
// address (or 'apt-get install') as id and the checksum it is checked against, or null; a site of a tool that
// downloads a file also holds { file, command }, the shell command with the download and its check. A problem is a
// download without a check that is no exception, a check that would not stop the build, an exception that matches
// nothing any more, or an exception that doesn't print the SHA-256 of its file.
function checkDownloads(text, exceptions) {
  const instructions = dockerInstructions(text);
  const sites = [];
  const problems = [];
  instructions.forEach((instruction, index) => {
    const at = 'line ' + instruction.line + ': ';
    if (instruction.name === 'ADD') {
      const checksum = new RegExp('--checksum=sha256:(' + SHA256 + ')(?=\\s)').exec(instruction.args);
      (instruction.args.match(ADDRESS) || []).forEach((address) => sites.push({ id: address, line: instruction.line, checksum: checksum ? checksum[1] : null }));
      return;
    }
    if (instruction.name !== 'RUN') {
      return;
    }
    // The text that sed replaces is no address that the build fetches (the old address of OpenSSL in the ports of the
    // SDK, the metadata keys of config.xml)
    const command = instruction.args.replace(/(^|[\s;&|(])sed\s+(?:-\S+\s+)*'[^']*'/g, '$1sed');
    const tools = command.match(DOWNLOAD_TOOL) || [];
    const addresses = unique(command.match(ADDRESS) || []);
    if (PACKAGE_INSTALL.test(command)) {
      sites.push({ id: 'apt-get install', line: instruction.line, checksum: null });
    }
    if (tools.length === 0) {
      addresses.forEach((address) => sites.push({ id: address, line: instruction.line, checksum: null }));
      return;
    }
    if (tools.length > 1 || addresses.length !== 1) {
      problems.push(at + 'a RUN instruction that downloads holds one download from one address, so that its check can be told');
      return;
    }
    const output = /\s(?:-o\s+|-O\s+|--out=|--output=|--output-document=)(\S+)/.exec(command);
    const file = output ? output[1].replace(/^(["'])(.*)\1$/, '$2') : null;
    if (!file) {
      problems.push(at + 'the download of ' + addresses[0] + ' names no output file (-o), so no check can name it');
      return;
    }
    // The check stands in the instruction of the download or in the next one, before anything uses the file
    const next = instructions[index + 1];
    const own = findChecksumCheck(command, file);
    const later = !own && next && next.name === 'RUN' ? findChecksumCheck(next.args, file) : null;
    const check = own || later;
    if (check && check.problem) {
      problems.push(at + check.problem);
    }
    sites.push({
      id: addresses[0],
      line: instruction.line,
      checksum: check && check.checksum ? check.checksum : null,
      file,
      command: later ? instruction.args + ' && ' + next.args : instruction.args,
    });
  });
  sites.filter((site) => !site.checksum).forEach((site) => {
    if (exceptions.indexOf(site.id) < 0) {
      problems.push('line ' + site.line + ': ' + site.id + ' is downloaded without a check against a SHA-256 checksum');
    } else if (site.file && !new RegExp('&&\\s*sha256sum ' + escapeRegExp(site.file) + '\\s*$').test(site.command)) {
      problems.push('line ' + site.line + ': the download of ' + site.file + ' is not checked and does not end with `&& sha256sum ' + site.file + '`, which prints its SHA-256');
    }
  });
  exceptions.forEach((id) => {
    if (!sites.some((site) => site.id === id && !site.checksum)) {
      problems.push('the exception ' + id + ' matches no download without a check any more: remove it from the list');
    }
  });
  return { sites, problems };
}

// Run a shell command of a RUN instruction with `sh`, as Docker does, in an empty folder. aria2c is a stand-in that
// writes `content` to the file named by -o; with `fails` it writes a part of it and fails, like a download that broke off.
function runDownload(command, content, fails) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-download-'));
  try {
    const bin = path.join(workDir, 'bin');
    const home = path.join(workDir, 'home');
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(bin, 'aria2c'), [
      '#!/bin/sh',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then printf \'%s\' "$STAND_IN_CONTENT" > "$2"; fi',
      '  shift',
      'done',
      'exit "$STAND_IN_STATUS"',
      '',
    ].join('\n'), { mode: 0o755 });
    const env = {
      PATH: bin + path.delimiter + process.env.PATH,
      STAND_IN_CONTENT: fails ? content.slice(0, 3) : content,
      STAND_IN_STATUS: fails ? '1' : '0',
    };
    const result = childProcess.spawnSync('sh', ['-c', command], { cwd: home, env, encoding: 'utf8' });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const hasSha256sum = childProcess.spawnSync('sha256sum', ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = hasSha256sum ? false : 'needs sha256sum, as in the Ubuntu image of the Dockerfile';

test('the stages on Ubuntu start from one image, pinned by the digest that docs/BUILD.md states', () => {
  const images = baseImages(readDockerfile());
  assert.deepEqual(images.map((image) => image.image), ['ubuntu:22.04', 'ubuntu:22.04']);
  images.forEach((image) => assert.match(String(image.digest), new RegExp('^sha256:' + SHA256 + '$'), 'line ' + image.line + ' names the image by its tag only'));
  assert.equal(images[1].digest, images[0].digest, 'the last stage starts from another image than the first one');
  assert.ok(BUILD.indexOf('`' + images[0].digest + '`') >= 0, 'docs/BUILD.md does not state ' + images[0].digest);
  // The command that prints the digest of a newer image
  assert.match(BUILD, /`docker buildx imagetools inspect ubuntu:22\.04`/);
});

test('the check of the images knows a tag without a digest, another stage and scratch', () => {
  const digest = 'sha256:' + sha256('an image');
  const images = baseImages([
    '# A comment',
    'FROM ubuntu:22.04@' + digest + ' AS sdk',
    'FROM sdk AS base',
    'FROM scratch AS wgt',
    'FROM --platform=linux/amd64 ubuntu:22.04',
    'FROM BASE',
  ].join('\n'));
  assert.deepEqual(images, [{ image: 'ubuntu:22.04', digest, line: 2 }, { image: 'ubuntu:22.04', digest: null, line: 5 }]);
});

test('every download of the Dockerfile is checked against a SHA-256 checksum or is a listed exception', () => {
  const result = checkDownloads(readDockerfile(), UNCHECKED_IDS);
  assert.deepEqual(result.problems, []);
  // The tools that the build downloads as files, and the packages of Ubuntu
  assert.deepEqual(result.sites.map((site) => site.file || site.id),
    ['apt-get install', 'web-cli_Tizen_Studio_6.1_ubuntu-64.bin', 'emscripten-1.39.4.7-linux64.zip']);
  // Every exception has its reason here and its line in docs/BUILD.md
  UNCHECKED.forEach((entry) => {
    assert.ok(entry.why.length > 40, entry.id);
    assert.match(BUILD, entry.docs, entry.id);
  });
  // The address that the Dockerfile writes into the ports of OpenSSL, which sed hides from the check above, is the one
  // that docs/BUILD.md lists with its SHA-512 checksum
  const openssl = 'https://github.com/openssl/openssl/releases/download/OpenSSL_1_1_1d/openssl-';
  assert.equal(readDockerfile().split('|' + openssl + "|g'").length, 3, 'ssl.py and crypto.py');
  assert.ok(BUILD.indexOf(openssl + '1.1.1d.tar.gz') >= 0);
});

test('docs/BUILD.md states the SHA-256 values that the Dockerfile uses, and no other', () => {
  const used = baseImages(readDockerfile()).map((image) => String(image.digest).replace('sha256:', ''))
    .concat(checkDownloads(readDockerfile(), UNCHECKED_IDS).sites.map((site) => site.checksum).filter((checksum) => checksum));
  const stated = BUILD.match(new RegExp('(?<![0-9a-f])' + SHA256 + '(?![0-9a-f])', 'g')) || [];
  assert.deepEqual(unique(stated).sort(), unique(used).sort());
});

test('a download prints its SHA-256 or is checked against it, and a download that broke off stops the build', { skip: SKIP }, () => {
  const downloads = checkDownloads(readDockerfile(), UNCHECKED_IDS).sites.filter((site) => site.file);
  assert.equal(downloads.length, 2);
  downloads.forEach((site) => {
    // The stand-in takes the place of aria2c only: no other tool may reach the network from a test
    assert.match(site.command, /^aria2c /, site.file);
    const content = 'stand-in for ' + site.file;
    const result = runDownload(site.command, content, false);
    if (site.checksum) {
      // The stand-in is not the file of the checksum: the check stops the build
      assert.notEqual(result.status, 0, site.file);
      assert.match(result.output, new RegExp(escapeRegExp(site.file) + ': FAILED'));
    } else {
      // The line that sha256sum prints, which is also the line that `sha256sum -c` reads
      assert.equal(result.status, 0, result.output);
      assert.equal(result.output, sha256(content) + '  ' + site.file + '\n');
    }
    const broken = runDownload(site.command, content, true);
    assert.notEqual(broken.status, 0, site.file);
    assert.doesNotMatch(broken.output, new RegExp(SHA256 + '|: OK'), site.file);
  });
});

test('a checked download passes with the file of the checksum and stops the build with another file', { skip: SKIP }, () => {
  const checksum = sha256('the right file');
  const download = "aria2c -x 5 -s 5 -o tool.bin 'https://example.invalid/tool.bin'";
  const check = 'echo "' + checksum + '  tool.bin" | sha256sum -c -';
  // The check in the instruction of the download, in the next instruction, and as the option of aria2c
  const forms = [
    'RUN ' + download + ' && \\\n\t' + check + '\nRUN chmod a+x tool.bin',
    'RUN ' + download + '\nRUN ' + check + ' && chmod a+x tool.bin',
  ];
  forms.forEach((form) => {
    const result = checkDownloads('FROM scratch\n' + form + '\n', []);
    assert.deepEqual(result.problems, [], form);
    assert.equal(result.sites.length, 1);
    assert.equal(result.sites[0].checksum, checksum);
    const right = runDownload(result.sites[0].command + ' && echo used', 'the right file', false);
    assert.equal(right.status, 0, right.output);
    assert.match(right.output, /^tool\.bin: OK\nused\n$/);
    const wrong = runDownload(result.sites[0].command + ' && echo used', 'another file', false);
    assert.notEqual(wrong.status, 0, form);
    assert.match(wrong.output, /tool\.bin: FAILED/);
    assert.doesNotMatch(wrong.output, /used/);
  });
  const option = checkDownloads("FROM scratch\nRUN aria2c --checksum=sha-256=" + checksum + " -o tool.bin 'https://example.invalid/tool.bin'\n", []);
  assert.deepEqual(option.problems, []);
  assert.equal(option.sites[0].checksum, checksum);
});

test('the check notices a download without a check, a check that would not stop the build and an outdated exception', () => {
  const checksum = sha256('the right file');
  const address = 'https://example.invalid/tool.bin';
  const download = "aria2c -o tool.bin '" + address + "'";
  const check = 'echo "' + checksum + '  tool.bin" | sha256sum -c -';
  const problems = (lines, exceptions) => checkDownloads(['FROM scratch'].concat(lines).join('\n') + '\n', exceptions || []).problems;
  const unchecked = /^line 2: https:\/\/example\.invalid\/tool\.bin is downloaded without a check against a SHA-256 checksum$/;

  // No check, a check of another file, and a check after the file was used
  [[`RUN ${download}`], [`RUN ${download} && sha256sum tool.bin`], [`RUN ${download} && ${check.replace('tool.bin', 'other.bin')}`],
    [`RUN ${download}`, 'RUN chmod a+x tool.bin', `RUN ${check}`]].forEach((lines) => {
    const found = problems(lines);
    assert.equal(found.length, 1, lines.join(' / '));
    assert.match(found[0], unchecked);
  });
  // One space instead of the two of the line format, and a checksum that is too short
  assert.match(problems([`RUN ${download} && ${check.replace('  tool.bin', ' tool.bin')}`])[0], /^line 2: the check of tool\.bin is not in the form/);
  assert.match(problems([`RUN ${download} && ${check.replace(checksum, checksum.slice(1))}`])[0], /^line 2: the check of tool\.bin is not in the form/);
  // A check whose result is lost, or that only runs after a failed download
  [`RUN ${download} && ${check}; chmod a+x tool.bin`, `RUN ${download} && ${check} || true`, `RUN ${download} || ${check}`,
    `RUN ${download}; ${check}`].forEach((line) => {
    assert.match(problems([line])[0], /^line 2: the check of tool\.bin is not joined to the other commands with && only/, line);
  });
  // Two downloads in one instruction, and a download that is piped into a shell
  assert.match(problems([`RUN ${download} && ${check} && ${download.replace(/tool/g, 'more')}`])[0], /^line 2: a RUN instruction that downloads holds one download/);
  assert.match(problems([`RUN curl -fsSL ${address} | sh`])[0], /^line 2: the download of https:\/\/example\.invalid\/tool\.bin names no output file/);
  // Other ways to fetch something: packages, a repository, an ADD instruction with an address
  assert.match(problems(['RUN apt-get update && apt-get install -y unzip'])[0], /^line 2: apt-get install is downloaded without a check/);
  assert.match(problems(['RUN git clone https://example.invalid/repo.git'])[0], /^line 2: https:\/\/example\.invalid\/repo\.git is downloaded without a check/);
  assert.match(problems([`ADD ${address} /opt/`])[0], unchecked);
  assert.deepEqual(problems([`ADD --checksum=sha256:${checksum} ${address} /opt/`]), []);
  // No download: an address that sed replaces, and a comment
  assert.deepEqual(problems([`RUN sed -i 's|https://example.invalid/old-|https://example.invalid/new-|g' ports.py`, `# ${download}`]), []);

  // A listed exception passes when it prints its SHA-256, and only then; apt-get install has no file to print
  assert.deepEqual(problems([`RUN ${download} && \\`, '\tsha256sum tool.bin', 'RUN apt-get install -y unzip'], [address, 'apt-get install']), []);
  assert.match(problems([`RUN ${download}`], [address])[0], /^line 2: the download of tool\.bin is not checked and does not end with `&& sha256sum tool\.bin`/);
  assert.match(problems([`RUN ${download}; sha256sum tool.bin`], [address])[0], /does not end with `&& sha256sum tool\.bin`/);
  // An exception whose download is gone or is checked by now
  assert.match(problems(['RUN echo done'], [address])[0], /^the exception https:\/\/example\.invalid\/tool\.bin matches no download without a check any more/);
  assert.match(problems([`RUN ${download} && ${check}`], [address])[0], /matches no download without a check any more/);
});
