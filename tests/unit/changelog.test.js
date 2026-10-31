'use strict';

// Checks the layout of CHANGELOG.md, which lists every change of Moonlight Plus by the version that first had it:
// - a section "## <version> (<date>)" for every released version of the patch notes (docs/PATCH_NOTES.md), with the
//   same date, and "## <version> (unreleased)" for the version of res/config.xml while its patch notes call it a
//   pre-release; newest first. A version that was only a pre-release (2.0.0) has no section of its own: its changes
//   are part of the next release, whose section says so
// - each version holds the small headings Added, Changed, Removed and Fixed, in this order, with at least one entry,
//   and no entry is listed twice
// - the changelog of Moonlight Tizen 1.19.0 and earlier, the base version, is linked instead of copied

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const CHANGELOG = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const PATCH_NOTES = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'PATCH_NOTES.md'), 'utf8').replace(/\r\n/g, '\n');
const APP_VERSION = /<widget[^>]*\sversion="([^"]+)"/.exec(fs.readFileSync(path.join(REPO_ROOT, 'res', 'config.xml'), 'utf8'))[1];
const SUBSECTIONS = ['Added', 'Changed', 'Removed', 'Fixed'];

// The sections of level 2 of a document: { heading, lines }
function sections(text) {
  const result = [];
  text.split('\n').forEach((line) => {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      result.push({ heading: match[1].trim(), lines: [] });
    } else if (result.length > 0) {
      result[result.length - 1].lines.push(line);
    }
  });
  return result;
}

// The versions of the patch notes with the first line of their section: { version, date | null, preRelease }
function patchNoteVersions() {
  return sections(PATCH_NOTES).filter((section) => /^\d+\.\d+\.\d+/.test(section.heading)).map((section) => {
    const first = section.lines.find((line) => line.trim() !== '') || '';
    const date = /^\*(\d{4}-\d{2}-\d{2})\b/.exec(first);
    return { version: section.heading, date: date ? date[1] : null, preRelease: /^\*Pre-release/.test(first) };
  });
}

const versionSections = () => sections(CHANGELOG).filter((section) => /^\d+\.\d+\.\d+/.test(section.heading));

test('the changelog has a section for every release of the patch notes with its date, and one for the version in testing', () => {
  const headings = versionSections().map((section) => section.heading);
  const expected = [];
  patchNoteVersions().forEach((entry) => {
    if (entry.date) {
      expected.push(entry.version + ' (' + entry.date + ')');
    } else if (entry.version === APP_VERSION) {
      expected.push(entry.version + ' (unreleased)');
    }
  });
  // In the order of the patch notes, which is newest first
  assert.deepEqual(headings, expected);
  assert.equal(headings[0].split(' ')[0], APP_VERSION, 'the version of res/config.xml comes first');
  // The pre-release 2.0.0 had no release of its own: its changes are listed under 2.1.0
  assert.ok(patchNoteVersions().some((entry) => entry.version === '2.0.0' && entry.date === null));
  const release210 = versionSections().find((section) => section.heading.indexOf('2.1.0 ') === 0);
  assert.match(release210.lines.join('\n'), /Includes the pre-release 2\.0\.0/);
});

test('each version of the changelog lists its entries under Added, Changed, Removed and Fixed, and no entry twice', () => {
  const seen = new Map();
  versionSections().forEach((section) => {
    const headings = section.lines.filter((line) => /^#{3,} /.test(line)).map((line) => line.replace(/^### /, ''));
    assert.ok(headings.length > 0, section.heading + ': no entries');
    assert.deepEqual(headings, SUBSECTIONS.filter((name) => headings.indexOf(name) >= 0), section.heading + ': ' + headings.join(', '));
    // Every small heading has entries
    section.lines.join('\n').split(/^### /m).slice(1).forEach((block) => {
      assert.match(block, /\n- \S/, section.heading + ': ' + block.split('\n')[0] + ' without an entry');
    });
    section.lines.filter((line) => /^- /.test(line)).forEach((entry) => {
      assert.ok(!seen.has(entry), `listed in ${seen.get(entry)} and ${section.heading}: ${entry.slice(0, 120)}`);
      seen.set(entry, section.heading);
    });
  });
});

test('the changelog links the changelog of Moonlight Tizen 1.19.0 and earlier instead of copying it', () => {
  const last = sections(CHANGELOG).pop();
  assert.equal(last.heading, 'Moonlight Tizen 1.19.0 and earlier');
  assert.ok(last.lines.join('\n').indexOf('](https://github.com/brightcraft/moonlight-tizen/blob/v1.19.0/CHANGELOG.md)') >= 0);
  // The copied history had a section for each upstream version, from v1.19.0 back to v1.0.0
  assert.doesNotMatch(CHANGELOG, /^## v\d/m);
});
