'use strict';

// Checks the files of the repository around the app (the process and contact documents, the issue forms and the
// automation) against what runs and applies in this fork:
// - no workflow, bot or dependency update of upstream Moonlight Tizen that never runs here, no sponsor button of
//   upstream, and no build notes of 2020 that nothing links
// - security reports go privately to this fork through GitHub, conduct reports privately to its maintainer, never to
//   upstream or the public issue tracker, and no document names an e-mail address
// - the bug form asks for what the app has (a photo of the diagnostic log, which stays in the memory of the TV) and not
//   twice for what the required photo of System information shows
// - CONTRIBUTING.md leaves translating to docs/TRANSLATING.md and names the test command
// - the German S90C archive of v1.19.0-s90c.1 lives at its tag, not on the branch

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(REPO_ROOT, file));
const FORK = 'https://github.com/Emperior90/moonlight-tizen-Plus';

test('no workflow, bot or dependency update of upstream that never runs in this fork is left', () => {
  const workflows = fs.readdirSync(path.join(REPO_ROOT, '.github', 'workflows')).sort();
  assert.deepEqual(workflows, ['check-upstream-dependencies.yml', 'release-development.yml', 'tests.yml']);
  workflows.forEach((name) => {
    assert.doesNotMatch(read('.github/workflows/' + name), /github\.repository == 'brightcraft\/moonlight-tizen'/, name);
  });
  // The npm entry pointed at a folder without package.json; the test tools stay pinned on purpose
  const dependabot = read('.github/dependabot.yml');
  assert.deepEqual(dependabot.match(/package-ecosystem: "[^"]+"/g), ['package-ecosystem: "github-actions"']);
  // A sponsor button that paid upstream, and the Samsung build notes of 2020
  assert.ok(!exists('.github/FUNDING.yml'));
  assert.ok(!exists('README.Samsung.md'));
});

test('security reports go privately to this fork, and conduct reports privately to its maintainer', () => {
  const security = read('SECURITY.md');
  assert.ok(security.indexOf(FORK + '/security/advisories/new') >= 0, 'the private vulnerability reporting of this fork');
  assert.match(security, /\*\*Security\*\* tab[\s\S]*\*\*Report a vulnerability\*\*/);
  assert.doesNotMatch(security, /brightcraft\/moonlight-tizen\/security/);

  const conduct = read('CODE_OF_CONDUCT.md');
  const enforcement = conduct.slice(conduct.indexOf('## Enforcement'), conduct.indexOf('## Attribution'));
  assert.match(enforcement, /privately to the maintainer of Moonlight Plus, the GitHub user \[Emperior90\]\(https:\/\/github\.com\/Emperior90\), through GitHub/);
  assert.match(enforcement, /don't report such behavior on the public issue tracker/);
  assert.doesNotMatch(conduct, /moonlight-stream\.org/);

  // No document gives an e-mail address
  ['SECURITY.md', 'CODE_OF_CONDUCT.md', '.github/CONTRIBUTING.md', 'README.md', '.github/ISSUE_TEMPLATE/bug.yml'].forEach((file) => {
    assert.doesNotMatch(read(file), /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, file);
  });
});

// Return the fields of an issue form: { label, required, text } in their order
function formFields(form) {
  return form.split(/\n  - type: /).slice(1).map((block) => ({
    label: (/\n\s+label: (.+)/.exec(block) || [null, null])[1],
    required: /\n\s+required: true/.test(block),
    text: block,
  })).filter((field) => field.label);
}

test('the bug form asks for a photo of the diagnostic log, and not twice for what the photo of System information shows', () => {
  const fields = formFields(read('.github/ISSUE_TEMPLATE/bug.yml'));
  const labels = fields.map((field) => field.label);
  // The app has no log files: its diagnostic log stays in the memory of the TV
  assert.ok(labels.indexOf('Log files') < 0, labels.join(', '));
  const log = fields.find((field) => field.label === 'Diagnostic log and Sunshine log');
  assert.ok(log, labels.join(', '));
  assert.match(log.text, /photo of the end of Settings → About → Diagnostic log/);
  // The App Version line names the variant (Moonlight Plus-ForceGM), and System information shows the Tizen version
  assert.ok(labels.indexOf('App file') < 0, labels.join(', '));
  assert.equal(fields.find((field) => field.label === 'Tizen version').required, false);
  assert.equal(fields.find((field) => field.label === 'System information').required, true);
  const version = fields.find((field) => field.label === 'App version');
  assert.match(version.text, /placeholder: "Example: App Version: Moonlight Plus-ForceGM v2\.x\.y \(pre-1a2b3c4\)"/);
  assert.ok(fields.filter((field) => field.required).length <= 9, 'required fields: ' + fields.filter((field) => field.required).length);
});

test('CONTRIBUTING.md leaves translating to docs/TRANSLATING.md and names the test command', () => {
  const contributing = read('.github/CONTRIBUTING.md');
  const localization = contributing.slice(contributing.indexOf('## Localization'), contributing.indexOf('## Third-Party Dependencies'));
  assert.ok(localization.indexOf('[docs/TRANSLATING.md](../docs/TRANSLATING.md)') >= 0, localization);
  // The steps of upstream named a LOCALE_LABELS list that i18n.js doesn't have, and copying en-US.json by hand
  assert.doesNotMatch(contributing, /LOCALE_LABELS|Copy the contents of `en-US\.json`/);
  assert.ok(contributing.indexOf('`npm test --prefix tests`') >= 0);
  assert.doesNotMatch(contributing, /the Moonlight project!/);
});

test('one release notes file serves the pre-release and the promotion, and the S90C archive lives at its tag', () => {
  // The two files repeated the same points, and the one of the pre-releases still named an older version
  assert.ok(exists('docs/RELEASE_NOTES.md'));
  assert.ok(!exists('docs/RELEASE_NOTES_DEV.md') && !exists('docs/RELEASE_NOTES_STABLE.md'));
  // The German plan, quick guide and notes of v1.19.0-s90c.1 describe the interface of that release
  assert.ok(!exists('docs/profiles'));
});
