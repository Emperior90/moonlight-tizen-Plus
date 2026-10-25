'use strict';

// Checks the release notes on their way into the update dialog of the app:
// - extractReleaseNotes() in wasm/platform/index.js reads the "What's Changed" section of a release and turns its
//   Markdown into plain text lines (headings, bullets, bold, italics, links, inline code), escaped as HTML, and ends
//   long notes with a pointer to the release page, since the dialog can't scroll
// - docs/RELEASE_NOTES_DEV.md and docs/RELEASE_NOTES_STABLE.md fit the release descriptions that the workflows build
//   around them: no heading of level 1 or 2, which would end the section in the dialog, and no relative links, which
//   don't work in a release description
// - the release descriptions that release-development.yml (pre-release and promotion) and release-stable.yml build are
//   run with bash on the documents of the repository and read back by extractReleaseNotes()

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

const MORE_CHANGES = '… More changes are listed on the release page on GitHub.';

// Load index.js with escapeHTML() of messages.js and a translation function that returns the source texts
const platform = loadPlatformScripts(['wasm/platform/messages.js'].concat(INDEX_SCRIPTS), {
  globals: {
    t: (text, ...values) => text.replace(/%(\d+)\$s/g, (match, index) => String(values[Number(index) - 1])),
  },
});
const extractReleaseNotes = platform.get('extractReleaseNotes');
const MAX_ROWS = platform.get('RELEASE_NOTES_MAX_ROWS');
const ROW_CHARS = platform.get('RELEASE_NOTES_ROW_CHARS');

// Wrap notes the way the workflows do, and return the lines that the dialog shows
function dialogLines(notes) {
  const result = extractReleaseNotes('# Moonlight Plus v1.19.101\n\n## What\'s Changed:\n\n' + notes);
  return result === null ? null : result.split('<br>');
}

// Rows that a line fills in the dialog, counted like extractReleaseNotes() does
function rowsOf(line) {
  return Math.max(1, Math.ceil(line.length / ROW_CHARS));
}

test('bullets, nested bullets, numbered items and headings become plain text lines', () => {
  assert.deepEqual(dialogLines([
    '### Which file to install?',
    '',
    '- **Tizen 9.0 and newer: `Moonlight-ForceGM.wgt`.** It asks the TV for its Game Mode',
    '  - nested item',
    '* star bullet',
    '+ plus bullet',
    '1. First step',
    '2) Second step:',
    '#### Picture and video',
    'A paragraph without a period',
    'Already ends with a question?',
  ].join('\n')), [
    'Which file to install?',
    '• Tizen 9.0 and newer: Moonlight-ForceGM.wgt. It asks the TV for its Game Mode.',
    '    – nested item.',
    '• star bullet.',
    '• plus bullet.',
    '1. First step.',
    '2. Second step:',
    'Picture and video',
    'A paragraph without a period.',
    'Already ends with a question?',
  ]);
});

test('links, images, bold, italics and inline code lose their Markdown marks', () => {
  assert.deepEqual(dialogLines([
    '- See the [guide](https://example.com/docs/GUIDE.md) and [`docs/CONTROLLERS.md`](https://example.com/c)',
    '- Badge [![Patreon](https://img.shields.io/x)](https://example.com) gone',
    '- *Game mode* and _Audio clock sync_ and __bold__ and ***both***',
    '- Keep snake_case_names, 2 * 3 * 4 and `*.wgt` and `fec_percentage` as they are',
    '- An autolink <https://example.com/path> stays readable',
    '- Escaped \\*stars\\* stay',
  ].join('\n')), [
    '• See the guide and docs/CONTROLLERS.md.',
    '• Badge gone.',
    '• Game mode and Audio clock sync and bold and both.',
    '• Keep snake_case_names, 2 * 3 * 4 and *.wgt and fec_percentage as they are.',
    '• An autolink https://example.com/path stays readable.',
    '• Escaped *stars* stay.',
  ]);
});

test('the text is escaped as HTML and HTML tags are dropped', () => {
  const lines = dialogLines('- Bitrate < 80 & > 50 "Mbps"\n- <b>bold</b> <script>alert(1)</script> <br> done');
  assert.deepEqual(lines, [
    '• Bitrate &lt; 80 &amp; &gt; 50 &quot;Mbps&quot;.',
    '• bold alert(1) done.',
  ]);
});

test('quotes lose their marks, and alert markers, rules and empty lines are dropped', () => {
  assert.deepEqual(dialogLines([
    '> [!IMPORTANT]',
    '>',
    '> Install 1.19.100 once by hand.',
    '',
    '---',
    '***',
    'Next paragraph',
  ].join('\n')), ['Install 1.19.100 once by hand.', 'Next paragraph.']);
});

test('contributor attributions of upstream releases are removed', () => {
  assert.deepEqual(dialogLines('- Fixed pairing failures by @someone in https://github.com/x/y/pull/1'), ['• Fixed pairing failures.']);
});

test('the section ends at the links of the workflows, at Full Changelog and at the next heading of level 1 or 2', () => {
  assert.deepEqual(dialogLines('- First\n\n- **Commit**: [`abc1234`](https://example.com)\n- **Guide**: [docs/GUIDE.md](https://example.com)'), ['• First.']);
  assert.deepEqual(dialogLines('- First\n\n**Full Changelog**: https://example.com/compare/v1...v2\n\n## Support the Project:\n\nDonate'), ['• First.']);
  assert.deepEqual(dialogLines('- First\n## Support the Project:\n- Donate'), ['• First.']);
  assert.deepEqual(dialogLines('- First\n# Another title\n- Second'), ['• First.']);
});

test('an upstream release description and Windows line endings are read', () => {
  const body = [
    '# Moonlight Tizen v1.19.0',
    '',
    '- Ensure your setup meets the necessary [requirements](https://example.com).',
    '',
    '## What\'s Changed:',
    '',
    '- Added gamepad identification reporting',
    '- Fixed pairing failures caused by concurrent HTTP requests',
    '',
    '**Full Changelog**: https://github.com/brightcraft/moonlight-tizen/compare/v1.18.0...v1.19.0',
  ].join('\r\n');
  assert.equal(extractReleaseNotes(body), '• Added gamepad identification reporting.<br>• Fixed pairing failures caused by concurrent HTTP requests.');
});

test('notes without a What\'s Changed section, or with an empty one, give null', () => {
  assert.equal(extractReleaseNotes('# Moonlight Plus v1.19.101\n\n- Nothing here'), null);
  assert.equal(extractReleaseNotes('## What\'s Changed:\n\n\n**Full Changelog**: https://example.com'), null);
  assert.equal(extractReleaseNotes(''), null);
  assert.equal(extractReleaseNotes(null), null);
});

test('long notes end with a pointer to the release page, within the rows of the dialog', () => {
  const notes = [];
  for (let i = 1; i <= 60; i++) {
    notes.push('- Change number ' + i + ' with a text that is long enough to fill about two rows of the dialog');
  }
  const lines = dialogLines(notes.join('\n'));
  assert.equal(lines[lines.length - 1], MORE_CHANGES);
  const shown = lines.slice(0, -1);
  assert.ok(shown.length > 1 && shown.length < 60, 'shown lines: ' + shown.length);
  assert.ok(shown.reduce((sum, line) => sum + rowsOf(line), 0) <= MAX_ROWS);
  // Notes that fit are shown in full, without the pointer
  assert.deepEqual(dialogLines(notes.slice(0, 3).join('\n')).length, 3);
});

test('a single line longer than the dialog is still shown', () => {
  const longLine = '- ' + 'word '.repeat(300);
  const lines = dialogLines(longLine + '\n- Second');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length > MAX_ROWS * ROW_CHARS);
  assert.equal(lines[1], MORE_CHANGES);
});

for (const name of ['RELEASE_NOTES_DEV.md', 'RELEASE_NOTES_STABLE.md']) {
  test(`docs/${name} has no level 1 or 2 heading and no relative link`, () => {
    const notes = fs.readFileSync(path.join(REPO_ROOT, 'docs', name), 'utf8');
    assert.ok(notes.trim().length > 0, 'the release notes are empty');
    notes.split(/\r?\n/).forEach((line, index) => {
      assert.doesNotMatch(line, /^#{1,2}\s/, `line ${index + 1}: the workflows add the title and "## What's Changed:" themselves`);
      const links = line.match(/\]\(([^)]*)\)/g) || [];
      links.forEach((link) => {
        assert.match(link, /^\]\(https?:\/\//, `line ${index + 1}: ${link} is a relative link, which doesn't work in a release description`);
      });
    });
  });
}

test('the stable release notes name both files and the manual update of v1.19.0-s90c.1', () => {
  const notes = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'RELEASE_NOTES_STABLE.md'), 'utf8');
  assert.ok(notes.indexOf('`Moonlight-ForceGM.wgt`') >= 0 && notes.indexOf('`Moonlight.wgt`') >= 0);
  assert.ok(notes.indexOf('v1.19.0-s90c.1') >= 0 && notes.indexOf('by hand') >= 0);
  // What the dialog shows first: the introduction and the manual update
  const lines = dialogLines(notes);
  assert.match(lines[0], /^Moonlight Plus 1\.19\.100 is the first full release of Moonlight Plus/);
  assert.ok(lines.some((line) => line.indexOf('v1.19.0-s90c.1') >= 0), 'the dialog shows the note about v1.19.0-s90c.1');
});

// Return the shell blocks of a workflow that write release_notes.md ('{' ... '} > release_notes.md'), without the
// redirection, so that they print the description instead of writing into the repository
function releaseNoteBlocks(workflowFile) {
  const lines = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', workflowFile), 'utf8').split('\n');
  const blocks = [];
  let start = -1;
  lines.forEach((line, index) => {
    if (/^\s*\{\s*$/.test(line)) {
      start = index;
    } else if (/^\s*\} > release_notes\.md\s*$/.test(line) && start >= 0) {
      const indent = lines[start].match(/^\s*/)[0].length;
      blocks.push(lines.slice(start, index + 1).map((blockLine) => blockLine.slice(Math.min(indent, blockLine.match(/^\s*/)[0].length)))
        .join('\n').replace(/\} > release_notes\.md\s*$/, '}'));
      start = -1;
    }
  });
  return blocks;
}

// Run a block with bash in the repository, with the variables that the workflow step sets
function runBlock(block) {
  return childProcess.execFileSync('bash', ['-c', 'set -eu\n' + block], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      TIMESTAMP: '2026.1025.1200',
      VERSION: '1.19.100',
      RELEASE_TAG: 'v1.19.100',
      REPO_URL: 'https://github.com/owner/repo',
      GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
      sha: 'fedcba9876543210fedcba9876543210fedcba98',
    }),
  });
}

const WORKFLOW_DESCRIPTIONS = [
  { workflow: 'release-development.yml', index: 0, title: '# Moonlight Plus v2026.1025.1200', notes: 'RELEASE_NOTES_DEV.md' },
  { workflow: 'release-development.yml', index: 1, title: '# Moonlight Plus v1.19.100', notes: 'RELEASE_NOTES_STABLE.md' },
  { workflow: 'release-stable.yml', index: 0, title: '# Moonlight Plus v1.19.100', notes: 'RELEASE_NOTES_STABLE.md' },
];

test('the workflows build their release descriptions in the expected places', () => {
  assert.equal(releaseNoteBlocks('release-development.yml').length, 2, 'pre-release and promotion');
  assert.equal(releaseNoteBlocks('release-stable.yml').length, 1, 'stable release');
});

for (const entry of WORKFLOW_DESCRIPTIONS) {
  test(`the update dialog reads the release description of ${entry.workflow} (block ${entry.index + 1}) from docs/${entry.notes}`, () => {
    const description = runBlock(releaseNoteBlocks(entry.workflow)[entry.index]);
    assert.equal(description.split('\n')[0], entry.title);
    assert.ok(description.indexOf('\n## What\'s Changed:\n\n') > 0, 'the heading that the dialog looks for');
    assert.ok(description.indexOf('- **Commit**: [`') > 0, 'the commit link after the notes');
    // The links to the documents only name files that exist
    const documentLinks = description.match(/\]\(https:\/\/github\.com\/owner\/repo\/blob\/[0-9a-f]+\/([^)]+)\)/g) || [];
    assert.ok(documentLinks.length > 0);
    documentLinks.forEach((link) => {
      const file = /\/blob\/[0-9a-f]+\/([^)]+)\)$/.exec(link)[1];
      assert.ok(fs.existsSync(path.join(REPO_ROOT, file.split('#')[0])), link);
    });

    const lines = extractReleaseNotes(description).split('<br>');
    const firstNoteLine = dialogLines(fs.readFileSync(path.join(REPO_ROOT, 'docs', entry.notes), 'utf8'))[0];
    assert.equal(lines[0], firstNoteLine, 'the dialog starts with the notes');
    lines.forEach((line) => {
      assert.doesNotMatch(line, /\*\*|\]\(|`|^#/, 'no Markdown marks left: ' + line);
      assert.doesNotMatch(line, /^• Commit|^• Full Changelog|^• Guide|This is a pre-release build/, 'no workflow links: ' + line);
      assert.doesNotMatch(line.replace(/<br>/g, ''), /<[a-z]/i, 'no HTML tags: ' + line);
    });
    assert.ok(lines.reduce((sum, line) => sum + rowsOf(line), 0) <= MAX_ROWS + rowsOf(MORE_CHANGES), 'the dialog stays on the screen');
  });
}
