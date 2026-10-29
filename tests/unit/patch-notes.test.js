'use strict';

// Checks the patch notes (docs/PATCH_NOTES.md), which list every version of this fork in short, newest first:
// - a section "## <version>" for every release of this fork (the releases below, and the release tags of the local
//   clone when it has them) and for the version in res/config.xml, which the next pre-release builds, newest first,
//   each listed in the table of contents at the top
// - each section starts with its date (a release, also every release tag of the local clone) or "Pre-release", a
//   one-sentence summary, what an installer must know and, for Moonlight Plus, how it was tested, and stays short, as
//   the owner asked: a summary and install lines of at most 160 visible characters, at most 4 small headings and 15
//   bullets of one line on GitHub (115 characters) in plain language, without the internal names of the code (inline
//   code, function names, commit hashes)
// - the base version (Moonlight Tizen 1.19.0) and the changelog, which has every technical detail, are linked
// The local links and heading anchors are checked by tests/tools/check-markdown-links.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const PATCH_NOTES = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'PATCH_NOTES.md'), 'utf8').replace(/\r\n/g, '\n');
const APP_VERSION = /<widget[^>]*\sversion="([^"]+)"/.exec(fs.readFileSync(path.join(REPO_ROOT, 'res', 'config.xml'), 'utf8'))[1];

// The full releases of this fork with the day they were published on GitHub. A new release adds its tag here, when its
// section gets the date (the promotion in release-development.yml stops while the section still says Pre-release).
const RELEASES = {
  'v1.19.0-s90c.1': '2026-10-23',
  'v1.19.100': '2026-10-26',
};

const MAX_HEADINGS = 4;
const MAX_BULLETS = 15;
const MAX_BULLET_CHARS = 115;
const MAX_NOTE_CHARS = 160;

// The release tags of this fork in the local clone (a checkout in CI has none): x.y.z tags in the history of HEAD above
// the base version 1.19.0, and the -s90c.N tags of the first release; upstream tags and pre-release tags don't count
function localReleaseTags() {
  let tags;
  try {
    tags = childProcess.execFileSync('git', ['tag', '--list', '--merged', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    return [];
  }
  return tags.split('\n').map((tag) => tag.trim()).filter((tag) => {
    const match = /^v(\d+)\.(\d+)\.(\d+)(-s90c\.\d+)?$/.exec(tag);
    return match !== null && (match[4] !== undefined || compareVersions(tag.slice(1), '1.19.0') > 0);
  });
}

// Compare two versions x.y.z with an optional suffix ending in a number, as the update check of the app does
function compareVersions(a, b) {
  const parse = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.]*?(\d+))?$/.exec(version);
    assert.ok(match, 'version ' + version);
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? -1 : Number(match[4])];
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

// The sections of the patch notes: { heading, lines }, for each heading of level 2
function sections() {
  const result = [];
  PATCH_NOTES.split('\n').forEach((line) => {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      result.push({ heading: match[1].trim(), lines: [] });
    } else if (result.length > 0) {
      result[result.length - 1].lines.push(line);
    }
  });
  return result;
}

const versionSections = () => sections().filter((section) => /^\d+\.\d+\.\d+/.test(section.heading));

// The text of a line as GitHub shows it: without the quote mark, emphasis and the targets of links
const visibleText = (line) => line.replace(/^>\s?/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*/g, '');

test('the patch notes have a section for every release of this fork and for the version of res/config.xml, newest first', () => {
  const versions = versionSections().map((section) => section.heading);
  const expected = new Set([APP_VERSION].concat(Object.keys(RELEASES), localReleaseTags()).map((tag) => tag.replace(/^v/, '')));
  expected.forEach((version) => {
    assert.ok(versions.indexOf(version) >= 0, `no section "## ${version}"`);
  });
  assert.equal(versions[0], [...expected].sort(compareVersions).pop(), 'the newest version comes first');
  versions.slice(1).forEach((version, index) => {
    assert.ok(compareVersions(versions[index], version) > 0, `${versions[index]} comes before ${version}`);
  });
  // The table of contents at the top lists every version with a link to its section
  const top = PATCH_NOTES.slice(0, PATCH_NOTES.indexOf('\n## '));
  versions.forEach((version) => {
    assert.ok(top.indexOf(`- [${version}](#${version.replace(/\./g, '')})`) >= 0, `the table of contents links ${version}`);
  });
});

test('each version of the patch notes has its date or "Pre-release", a summary, what an installer must know and how it was tested', () => {
  const tags = localReleaseTags();
  versionSections().forEach((section) => {
    const paragraphs = section.lines.join('\n').split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
    const release = RELEASES['v' + section.heading];
    if (release) {
      assert.ok(paragraphs[0].indexOf('*' + release) === 0, `${section.heading}: starts with its release date ${release}: ${paragraphs[0]}`);
    } else if (tags.indexOf('v' + section.heading) >= 0) {
      // Released (the clone has its tag), but not yet in RELEASES: the section has a date, not "Pre-release"
      assert.match(paragraphs[0], /^\*\d{4}-\d{2}-\d{2}\b/, `${section.heading}: released as v${section.heading}, so it starts with its date (and v${section.heading} belongs in RELEASES)`);
    } else {
      assert.match(paragraphs[0], /^\*(Pre-release|\d{4}-\d{2}-\d{2})\b/, `${section.heading}: starts with its date or "Pre-release"`);
    }
    // One sentence after the date
    const summary = paragraphs[0].replace(/^\*[^*]+\*\s*/, '');
    assert.match(summary, /^[A-Z][^\n]*\.$/, `${section.heading}: a summary`);
    assert.equal(summary.split(/\.\s/).length, 1, `${section.heading}: the summary is one sentence: ${summary}`);
    assert.match(paragraphs[1], /^> \*\*Install:\*\* /, `${section.heading}: what an installer must know`);
    // Moonlight Plus says how a version was tested, e.g. with simulated TVs and controllers only
    if (!/-s90c\./.test(section.heading)) {
      assert.match(paragraphs[1], /^> \*\*Tested:\*\* \S/m, `${section.heading}: how it was tested`);
    }
    // Short enough for one or two lines on GitHub
    [paragraphs[0]].concat(paragraphs[1].split('\n')).forEach((line) => {
      const shown = visibleText(line);
      assert.ok(shown.length <= MAX_NOTE_CHARS, `${section.heading}: a summary or install line of ${shown.length} characters, at most ${MAX_NOTE_CHARS}: ${shown}`);
    });
  });
  // The version of res/config.xml is in testing until it is released (its tag is added to RELEASES above)
  if (!RELEASES['v' + APP_VERSION] && localReleaseTags().indexOf('v' + APP_VERSION) < 0) {
    const section = versionSections().find((entry) => entry.heading === APP_VERSION);
    assert.match(section.lines.join('\n'), /^\*Pre-release, in testing\.\*/m, `${APP_VERSION} is marked as a pre-release in testing`);
  }
});

test('each version of the patch notes stays short and in plain language', () => {
  versionSections().forEach((section) => {
    const headings = section.lines.filter((line) => /^#{3,}\s/.test(line));
    const bullets = section.lines.filter((line) => /^\s*[-*+]\s/.test(line));
    assert.ok(headings.length >= 1 && headings.length <= MAX_HEADINGS, `${section.heading}: ${headings.length} headings, 1 to ${MAX_HEADINGS}`);
    headings.forEach((heading) => assert.match(heading, /^### \S/, `${section.heading}: small headings of level 3: ${heading}`));
    assert.ok(bullets.length >= 3 && bullets.length <= MAX_BULLETS, `${section.heading}: ${bullets.length} bullets, 3 to ${MAX_BULLETS}`);
    section.lines.forEach((line, index) => {
      const next = section.lines[index + 1];
      if (/^\s*[-*+]\s/.test(line)) {
        assert.match(line, /^- \S/, `${section.heading}: no nested bullets: ${line}`);
        assert.ok(line.length <= MAX_BULLET_CHARS, `${section.heading}: a bullet of ${line.length} characters, at most ${MAX_BULLET_CHARS}: ${line}`);
        assert.ok(next === undefined || next === '' || /^- /.test(next), `${section.heading}: one line per bullet: ${line}`);
      }
      assert.doesNotMatch(line, /`/, `${section.heading}: no inline code: ${line}`);
      assert.doesNotMatch(line, /\b[A-Za-z_]\w*\(\)/, `${section.heading}: no function names: ${line}`);
      assert.doesNotMatch(line, /\b[0-9a-f]{7,40}\b/, `${section.heading}: no commit hashes: ${line}`);
    });
  });
});

test('the patch notes link the base version and the changelog', () => {
  const base = sections().find((section) => !/^\d/.test(section.heading));
  assert.ok(base, 'a section after the versions');
  const text = base.lines.join('\n');
  assert.match(text, /Moonlight Tizen 1\.19\.0/);
  assert.ok(text.indexOf('](https://github.com/brightcraft/moonlight-tizen/releases)') >= 0, 'the releases of Moonlight Tizen');
  assert.ok(text.indexOf('](../CHANGELOG.md)') >= 0, 'the changelog');
});
