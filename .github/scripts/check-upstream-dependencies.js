#!/usr/bin/env node
'use strict';

// Compares the upstream projects that Moonlight Plus builds on with the reviewed state recorded in
// .github/dependency-baselines.json, and keeps one issue up to date with what is newer:
// - "branch": the commits on a branch after reviewed_through (optionally only those that touch a path)
// - "submodule": the commit that another repository pins as a submodule (ENet in moonlight-common-c)
// - "tags": release tags that match tag_pattern and are newer than reviewed_through (Opus)
// - "releases": GitHub releases published after reviewed_through (Sunshine)
// - "pull": a pull request whose head commit or state changed (open, closed, merged)
// New commits that already have a decision in the file are left out of the list. The issue carries a marker, so a
// later run updates it instead of opening another one, and closes it once nothing is left to review. It only reads the
// upstream projects and never changes code: porting a change and recording the decision stay manual.
// The idea of such a watch with one issue comes from fidoboy's fork moonlight-tizen-ac3 (GPL-3.0: its
// check-upstream-dependencies.yml and dependency-baselines.json); this one also records a decision for every upstream
// change, so that only the changes without one come up again.
//
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo of the issue), GITHUB_API_URL (default
// https://api.github.com), GITHUB_SERVER_URL (default https://github.com), BASELINES (default
// .github/dependency-baselines.json), DRY_RUN=true to print the issue text without touching the issue, and
// GITHUB_STEP_SUMMARY, GITHUB_RUN_ID for the summary and the link of a workflow run.
// Usage: node .github/scripts/check-upstream-dependencies.js

const fs = require('fs');

const MARKER = '<!-- upstream-dependency-watch -->';
const ISSUE_TITLE = 'Upstream changes to review';
const TRACKS = ['branch', 'submodule', 'tags', 'releases', 'pull'];
const DECISIONS = ['taken', 'skipped'];
const PULL_STATES = ['open', 'closed', 'merged'];
// Commits or releases listed per project; the compare link has the rest
const MAX_LISTED = 15;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{7,40}$/;
const VERSION = /^\d+\.\d+\.\d+/;

// Return the problems of the baseline file, an empty list when it is valid
function validateBaselines(data) {
  const problems = [];
  if (!data || data.schema_version !== 1) {
    problems.push('schema_version must be 1');
  }
  const dependencies = data && Array.isArray(data.dependencies) ? data.dependencies : null;
  if (!dependencies || dependencies.length === 0) {
    problems.push('dependencies must be a list with at least one entry');
    return problems;
  }
  const ids = new Set();
  dependencies.forEach((dep, index) => {
    const where = `dependencies[${index}]${dep && dep.id ? ` (${dep.id})` : ''}`;
    const fail = (text) => problems.push(`${where}: ${text}`);
    if (!dep || typeof dep !== 'object') {
      fail('must be an object');
      return;
    }
    if (typeof dep.id !== 'string' || !/^[a-z0-9-]+$/.test(dep.id)) {
      fail('id must be lowercase letters, digits and dashes');
    } else if (ids.has(dep.id)) {
      fail('the id is used twice');
    }
    ids.add(dep.id);
    ['name', 'vendored'].forEach((key) => {
      if (typeof dep[key] !== 'string' || dep[key].trim() === '') {
        fail(`${key} must be a text`);
      }
    });
    if (typeof dep.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(dep.repo)) {
      fail('repo must be owner/name');
    }
    if (TRACKS.indexOf(dep.track) < 0) {
      fail(`track must be one of ${TRACKS.join(', ')}`);
    }
    const reviewed = dep.reviewed_through;
    if (dep.track === 'branch') {
      if (reviewed !== null && !FULL_SHA.test(String(reviewed))) {
        fail('reviewed_through must be a full commit SHA, or null while nothing is reviewed');
      }
      if (dep.path !== undefined && (typeof dep.path !== 'string' || dep.path === '')) {
        fail('path must be a folder of the repository');
      }
    } else if (dep.track === 'submodule') {
      if (!FULL_SHA.test(String(reviewed))) {
        fail('reviewed_through must be a full commit SHA');
      }
      const pin = dep.pinned_in;
      if (!pin || typeof pin.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(pin.repo) || typeof pin.path !== 'string' || pin.path === '') {
        fail('pinned_in must name the repo and the path of the submodule');
      }
    } else if (dep.track === 'tags') {
      let pattern = null;
      try {
        pattern = new RegExp(dep.tag_pattern);
      } catch (error) {
        fail('tag_pattern must be a regular expression');
      }
      if (typeof dep.tag_pattern !== 'string' || (pattern && !pattern.test(String(reviewed)))) {
        fail('reviewed_through must be a tag that matches tag_pattern');
      }
    } else if (dep.track === 'releases') {
      if (typeof reviewed !== 'string' || reviewed === '') {
        fail('reviewed_through must be the tag of a release');
      }
    } else if (dep.track === 'pull') {
      if (!Number.isInteger(dep.pull) || dep.pull <= 0) {
        fail('pull must be the number of the pull request');
      }
      if (!FULL_SHA.test(String(reviewed))) {
        fail('reviewed_through must be the full SHA of the head commit');
      }
      if (PULL_STATES.indexOf(dep.reviewed_state) < 0) {
        fail(`reviewed_state must be one of ${PULL_STATES.join(', ')}`);
      }
    }
    if (!Array.isArray(dep.decisions)) {
      fail('decisions must be a list');
      return;
    }
    const seen = new Set();
    dep.decisions.forEach((decision, decisionIndex) => {
      const at = `decisions[${decisionIndex}]`;
      if (!decision || DECISIONS.indexOf(decision.decision) < 0) {
        fail(`${at}: decision must be one of ${DECISIONS.join(', ')}`);
        return;
      }
      if (typeof decision.why !== 'string' || decision.why.trim() === '') {
        fail(`${at}: why must say what the change does and why it was ${decision.decision}`);
      }
      if (decision.decision === 'taken' && !VERSION.test(String(decision.in))) {
        fail(`${at}: in must be the version of Moonlight Plus that has the change`);
      }
      const kinds = ['commits', 'tags', 'range'].filter((key) => decision[key] !== undefined);
      if (kinds.length !== 1) {
        fail(`${at}: name the change with exactly one of commits, tags or range`);
      } else if (kinds[0] === 'range') {
        if (typeof decision.range !== 'string' || !/^\S+\.\.\S+$/.test(decision.range)) {
          fail(`${at}: range must be <from>..<to>`);
        }
      } else if (!Array.isArray(decision[kinds[0]]) || decision[kinds[0]].length === 0) {
        fail(`${at}: ${kinds[0]} must be a list with at least one entry`);
      } else {
        decision[kinds[0]].forEach((ref) => {
          if (kinds[0] === 'commits' && !SHORT_SHA.test(String(ref))) {
            fail(`${at}: ${ref} is not a commit SHA (7 to 40 lowercase hex digits)`);
          }
          if (seen.has(ref)) {
            fail(`${at}: ${ref} has more than one decision`);
          }
          seen.add(ref);
        });
      }
    });
  });
  return problems;
}

// Text from upstream (commit titles) and from the baseline file, safe for the issue: no mention of a GitHub user, no
// reference to an issue of this repository, no HTML, on one line
function plain(text) {
  return String(text).split('\n')[0].trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b')
    .replace(/#(?=\d)/g, '#\u200b');
}

// Compare two version tags by their numbers, e.g. v1.6.1 < v1.10
function compareVersions(a, b) {
  const left = (String(a).match(/\d+/g) || []).map(Number);
  const right = (String(b).match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

// A client of the REST API of GitHub with fetch
function createClient(options) {
  const apiUrl = options.apiUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch || fetch;
  async function request(method, urlPath, body) {
    const url = /^https?:\/\//.test(urlPath) ? urlPath : apiUrl + urlPath;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'moonlight-plus-upstream-check',
    };
    if (options.token) {
      headers.Authorization = 'Bearer ' + options.token;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      throw new Error(`${method} ${urlPath} failed: ${(error.cause && (error.cause.code || error.cause.message)) || error.message}`);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = null;
    }
    if (!response.ok) {
      const message = data && data.message ? `: ${data.message}` : '';
      const error = new Error(`${method} ${urlPath} answered HTTP ${response.status}${message}`);
      error.status = response.status;
      throw error;
    }
    return { data, link: response.headers.get('link') || '' };
  }
  return {
    request,
    get: async (urlPath) => (await request('GET', urlPath)).data,
    // Follow the "next" links of a list, up to a number of pages
    paginate: async (urlPath, maxPages) => {
      let next = urlPath;
      const items = [];
      for (let page = 0; next && page < (maxPages || 10); page++) {
        const result = await request('GET', next);
        items.push(...(Array.isArray(result.data) ? result.data : []));
        const match = /<([^>]+)>;\s*rel="next"/.exec(result.link);
        next = match ? match[1] : null;
      }
      return items;
    },
  };
}

const enc = encodeURIComponent;
const short = (sha) => String(sha).slice(0, 7);

// Whether a decision of the project already names the commit
function isRecorded(dep, sha) {
  return dep.decisions.some((decision) => (decision.commits || []).some((commit) => sha.indexOf(commit) === 0));
}

// The lines of a list of commits, newest first: those without a decision, at most MAX_LISTED
function commitLines(server, dep, commits) {
  const open = commits.filter((commit) => !isRecorded(dep, commit.sha));
  const lines = open.slice(0, MAX_LISTED).map((commit) => {
    const date = commit.commit && commit.commit.committer && commit.commit.committer.date ? ` (${commit.commit.committer.date.slice(0, 10)})` : '';
    const title = commit.commit && commit.commit.message ? plain(commit.commit.message) : '';
    return `  - [\`${short(commit.sha)}\`](${server}/${dep.repo}/commit/${commit.sha}) ${title}${date}`;
  });
  if (open.length > MAX_LISTED) {
    lines.push(`  - … and ${open.length - MAX_LISTED} more`);
  }
  const recorded = commits.length - open.length;
  if (recorded > 0) {
    lines.push(`  - ${recorded} of them already ${recorded === 1 ? 'has a decision' : 'have a decision'} in the baseline file`);
  }
  return { lines, open: open.length };
}

// The commits from reviewed_through to head through the compare API, newest first, or a problem with the history
async function compareCommits(client, server, dep, base, head) {
  const comparison = await client.get(`/repos/${dep.repo}/compare/${base}...${head}`);
  const link = `${server}/${dep.repo}/compare/${base}...${head}`;
  if (comparison.status !== 'ahead') {
    return {
      lines: [`- The reviewed commit \`${short(base)}\` is not an ancestor of \`${short(head)}\` (${plain(comparison.status)}), e.g. after a force push: check the [history](${link}).`],
      open: 1,
    };
  }
  const commits = (comparison.commits || []).slice().reverse();
  const count = comparison.ahead_by || commits.length;
  const list = commitLines(server, dep, commits);
  return {
    lines: [`- ${count} new ${count === 1 ? 'commit' : 'commits'} since \`${short(base)}\`: [compare](${link})`].concat(list.lines),
    open: list.open + Math.max(0, count - commits.length),
  };
}

const CHECKS = {
  async branch(client, server, dep) {
    const branch = dep.branch || (await client.get(`/repos/${dep.repo}`)).default_branch;
    const reviewed = dep.reviewed_through;
    if (dep.path) {
      const commits = await client.get(`/repos/${dep.repo}/commits?sha=${enc(branch)}&path=${enc(dep.path)}&per_page=100`);
      if (!Array.isArray(commits) || commits.length === 0) {
        throw new Error(`no commit on ${branch} touches ${dep.path}`);
      }
      const history = `${server}/${dep.repo}/commits/${enc(branch)}/${dep.path}`;
      if (reviewed === null) {
        const list = commitLines(server, dep, commits.slice(0, 5));
        return {
          pending: true,
          lines: [`- Not reviewed yet. The newest commits that touch \`${dep.path}\` on ${plain(branch)} ([history](${history})); record the newest reviewed one as reviewed_through:`].concat(list.lines),
        };
      }
      const index = commits.findIndex((commit) => commit.sha === reviewed);
      if (index === 0) {
        return { pending: false, latest: commits[0].sha };
      }
      const newer = index < 0 ? commits : commits.slice(0, index);
      const list = commitLines(server, dep, newer);
      const count = index < 0 ? `More than ${commits.length}` : String(newer.length);
      return {
        pending: true,
        lines: [`- ${count} new ${newer.length === 1 ? 'commit touches' : 'commits touch'} \`${dep.path}\` since \`${short(reviewed)}\`: [compare](${server}/${dep.repo}/compare/${reviewed}...${commits[0].sha}), [history](${history})`].concat(list.lines),
      };
    }
    const head = await client.get(`/repos/${dep.repo}/commits/${enc(branch)}`);
    if (head.sha === reviewed) {
      return { pending: false, latest: head.sha };
    }
    const result = await compareCommits(client, server, dep, reviewed, head.sha);
    return { pending: true, lines: [`- Branch ${plain(branch)} is at \`${short(head.sha)}\`.`].concat(result.lines) };
  },

  async submodule(client, server, dep) {
    const content = await client.get(`/repos/${dep.pinned_in.repo}/contents/${dep.pinned_in.path}`);
    if (!content || content.type !== 'submodule' || !content.sha) {
      throw new Error(`${dep.pinned_in.repo}/${dep.pinned_in.path} is not a submodule`);
    }
    if (content.sha === dep.reviewed_through) {
      return { pending: false, latest: content.sha };
    }
    const result = await compareCommits(client, server, dep, dep.reviewed_through, content.sha);
    return {
      pending: true,
      lines: [`- ${plain(dep.pinned_in.repo)} now pins \`${short(content.sha)}\` in \`${dep.pinned_in.path}\`.`].concat(result.lines),
    };
  },

  async tags(client, server, dep) {
    const pattern = new RegExp(dep.tag_pattern);
    const tags = (await client.paginate(`/repos/${dep.repo}/tags?per_page=100`, 3)).map((tag) => tag.name).filter((name) => pattern.test(name));
    const newer = tags.filter((name) => compareVersions(name, dep.reviewed_through) > 0).sort(compareVersions).reverse();
    if (newer.length === 0) {
      return { pending: false, latest: dep.reviewed_through };
    }
    const lines = [`- ${newer.length} new release ${newer.length === 1 ? 'tag' : 'tags'} since ${plain(dep.reviewed_through)}: [compare](${server}/${dep.repo}/compare/${enc(dep.reviewed_through)}...${enc(newer[0])})`];
    newer.slice(0, MAX_LISTED).forEach((name) => {
      lines.push(`  - [${plain(name)}](${server}/${dep.repo}/releases/tag/${enc(name)})`);
    });
    return { pending: true, lines };
  },

  async releases(client, server, dep) {
    const releases = (await client.get(`/repos/${dep.repo}/releases?per_page=30`)).filter((release) => !release.draft);
    const index = releases.findIndex((release) => release.tag_name === dep.reviewed_through);
    if (index === 0) {
      return { pending: false, latest: releases[0].tag_name };
    }
    if (releases.length === 0) {
      throw new Error('no releases found');
    }
    const newer = index < 0 ? releases : releases.slice(0, index);
    const recorded = (tag) => dep.decisions.some((decision) => (decision.tags || []).indexOf(tag) >= 0);
    const open = newer.filter((release) => !recorded(release.tag_name));
    const lines = [index < 0
      ? `- The reviewed release ${plain(dep.reviewed_through)} is not among the ${releases.length} newest releases. The newest:`
      : `- ${newer.length} new ${newer.length === 1 ? 'release' : 'releases'} since ${plain(dep.reviewed_through)}: [compare](${server}/${dep.repo}/compare/${enc(dep.reviewed_through)}...${enc(newer[0].tag_name)})`];
    open.slice(0, MAX_LISTED).forEach((release) => {
      const date = release.published_at ? ` (${release.published_at.slice(0, 10)})` : '';
      lines.push(`  - [${plain(release.tag_name)}](${server}/${dep.repo}/releases/tag/${enc(release.tag_name)})${release.prerelease ? ' pre-release' : ''}${date}`);
    });
    if (open.length > MAX_LISTED) {
      lines.push(`  - … and ${open.length - MAX_LISTED} more`);
    }
    return { pending: true, lines };
  },

  async pull(client, server, dep) {
    const pull = await client.get(`/repos/${dep.repo}/pulls/${dep.pull}`);
    const state = pull.merged ? 'merged' : pull.state;
    const head = pull.head && pull.head.sha;
    if (head === dep.reviewed_through && state === dep.reviewed_state) {
      return { pending: false, latest: head };
    }
    const lines = [];
    if (state !== dep.reviewed_state) {
      const when = pull.merged_at || pull.closed_at;
      lines.push(`- State: ${dep.reviewed_state} → **${state}**${when ? ` (${when.slice(0, 10)})` : ''}`);
    }
    if (head !== dep.reviewed_through) {
      lines.push(`- New head commit [\`${short(head)}\`](${server}/${dep.repo}/commit/${head}) since \`${short(dep.reviewed_through)}\`: [compare](${server}/${dep.repo}/compare/${dep.reviewed_through}...${head})`);
    }
    return { pending: true, lines };
  },
};

// Check one project; an error of the API becomes a result of its own, so the other projects are still checked
async function checkDependency(client, server, dep) {
  try {
    const result = await CHECKS[dep.track](client, server, dep);
    return Object.assign({ dep, error: null }, result);
  } catch (error) {
    return { dep, pending: false, error: error.message };
  }
}

// The text of the issue
function buildIssueBody(results, context) {
  const baselines = `${context.server}/${context.repository}/blob/HEAD/.github/dependency-baselines.json`;
  const pending = results.filter((result) => result.pending);
  const failed = results.filter((result) => result.error);
  const current = results.filter((result) => !result.pending && !result.error);
  const lines = [
    MARKER,
    `These upstream changes are newer than the reviewed state in [dependency-baselines.json](${baselines}). Review each one, port what fits by hand (one commit at a time, keeping the changes of this fork), then record it there as taken or skipped with the reason, and move reviewed_through forward. Nothing is merged or built automatically.`,
    '',
  ];
  pending.forEach((result) => {
    lines.push(`### ${plain(result.dep.name)} (${plain(result.dep.repo)})`, '');
    lines.push(`Moonlight Plus has: ${plain(result.dep.vendored)}.`);
    if (result.dep.note) {
      lines.push(`Note: ${plain(result.dep.note)}`);
    }
    lines.push('', ...result.lines, '');
  });
  if (failed.length > 0) {
    lines.push('### Could not check', '');
    failed.forEach((result) => lines.push(`- ${plain(result.dep.name)} (${plain(result.dep.repo)}): ${plain(result.error)}`));
    lines.push('');
  }
  if (current.length > 0) {
    lines.push('### Up to date', '');
    current.forEach((result) => {
      const reviewed = result.dep.reviewed_through === null ? 'not reviewed' : short(result.dep.reviewed_through);
      lines.push(`- ${plain(result.dep.name)} (${plain(result.dep.repo)}): reviewed through ${plain(reviewed)}`);
    });
    lines.push('');
  }
  const run = context.runUrl ? ` in [this run](${context.runUrl})` : '';
  lines.push(`_Checked on ${context.date}${run}. The workflow updates this issue instead of opening another one._`);
  return lines.join('\n');
}

// Find the open issue of an earlier run by its marker
async function findIssue(client, repository) {
  const issues = await client.paginate(`/repos/${repository}/issues?state=open&per_page=100`, 10);
  return issues.find((issue) => !issue.pull_request && typeof issue.body === 'string' && issue.body.indexOf(MARKER) >= 0) || null;
}

// Run the check; returns the exit code
async function run(env, io) {
  const log = (io && io.log) || console.log;
  const warn = (io && io.warn) || console.error;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(env.BASELINES || '.github/dependency-baselines.json', 'utf8'));
  } catch (error) {
    warn(`::error::Can't read the baseline file: ${error.message}`);
    return 1;
  }
  const problems = validateBaselines(data);
  if (problems.length > 0) {
    problems.forEach((problem) => warn(`::error::dependency-baselines.json: ${problem}`));
    return 1;
  }
  const dryRun = env.DRY_RUN === 'true';
  if (!dryRun && (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN)) {
    warn('::error::GITHUB_REPOSITORY and GITHUB_TOKEN are needed to update the issue (or set DRY_RUN=true)');
    return 1;
  }
  const client = createClient({ apiUrl: env.GITHUB_API_URL || 'https://api.github.com', token: env.GITHUB_TOKEN, fetch: io && io.fetch });
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const results = [];
  for (const dep of data.dependencies) {
    const result = await checkDependency(client, server, dep);
    if (result.error) {
      warn(`::warning title=${dep.id}::${result.error}`);
    }
    log(`${dep.id}: ${result.error ? 'could not check' : result.pending ? 'to review' : 'up to date'}`);
    results.push(result);
  }
  const context = {
    server,
    repository: env.GITHUB_REPOSITORY || 'owner/repo',
    date: (env.CHECK_DATE || new Date().toISOString()).slice(0, 10),
    runUrl: env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '',
  };
  const pending = results.some((result) => result.pending);
  const body = buildIssueBody(results, context);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, body.replace(MARKER + '\n', '') + '\n');
  }
  if (results.every((result) => result.error)) {
    warn('::error::No project could be checked');
    return 1;
  }
  if (dryRun) {
    log(body);
    return 0;
  }
  try {
    const issue = await findIssue(client, env.GITHUB_REPOSITORY);
    if (pending) {
      if (issue) {
        await client.request('PATCH', `/repos/${env.GITHUB_REPOSITORY}/issues/${issue.number}`, { title: ISSUE_TITLE, body });
        log(`Updated issue #${issue.number}`);
      } else {
        const created = (await client.request('POST', `/repos/${env.GITHUB_REPOSITORY}/issues`, { title: ISSUE_TITLE, body })).data;
        log(`Opened issue #${created.number}`);
      }
    } else if (issue && !results.some((result) => result.error)) {
      // Everything is reviewed: close the issue. While a project couldn't be checked, the issue stays as it is.
      await client.request('PATCH', `/repos/${env.GITHUB_REPOSITORY}/issues/${issue.number}`, {
        body: `${MARKER}\nEverything upstream is reviewed (checked on ${context.date}). A later run opens a new issue when something changes.`,
        state: 'closed',
        state_reason: 'completed',
      });
      log(`Closed issue #${issue.number}`);
    } else {
      log('Nothing to review');
    }
  } catch (error) {
    warn(`::error::Can't update the issue: ${error.message}`);
    return 1;
  }
  return 0;
}

module.exports = { MARKER, ISSUE_TITLE, validateBaselines, plain, compareVersions, createClient, checkDependency, buildIssueBody, run };

if (require.main === module) {
  run(process.env).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(`::error::${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
