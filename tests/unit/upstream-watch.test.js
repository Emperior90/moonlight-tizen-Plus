'use strict';

// Checks the watch of the upstream projects (.github/workflows/check-upstream-dependencies.yml, its script
// .github/scripts/check-upstream-dependencies.js and the baseline file .github/dependency-baselines.json):
// - the baseline file is valid, names every project the owner asked for (Moonlight Tizen, moonlight-common-c, ENet,
//   Opus, libgamestream, the Sunshine releases and Sunshine pull request 5917), matches the vendored versions of
//   submodulesVer.txt, and records as taken every upstream commit that the changelog says was ported; the review of
//   16 November 2026 moved Moonlight Tizen to 8b3049a, moonlight-common-c to 94c65fd and ENet to 98dbb89 with a
//   decision for every commit in between, and keeps Sunshine (now SunshineStream/Sunshine) at its stable release
// - the checker of the file finds a commit with two decisions, a decision without its reason or version, and states
//   that the script can't compare
// - the script against a simulated GitHub API: new commits on a branch, commits that touch a folder, a moved submodule,
//   new release tags and releases, a project that deletes the tags of its pre-releases and stays at a stable release
//   (and a recorded pre-release that becomes its stable release), a changed pull request, a rewritten history and a project that can't be read; one issue that a later run updates,
//   that is closed once nothing is left to review, and that never mentions a GitHub user or an issue of this repository
// - the workflow runs only when started by hand, with no more access than reading the repository and writing issues

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');

const SCRIPT = path.join(REPO_ROOT, '.github', 'scripts', 'check-upstream-dependencies.js');
const BASELINES = path.join(REPO_ROOT, '.github', 'dependency-baselines.json');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'check-upstream-dependencies.yml');
const watch = require(SCRIPT);

const API = 'https://api.github.test';
const REPOSITORY = 'owner/plus';
const readBaselines = () => JSON.parse(fs.readFileSync(BASELINES, 'utf8'));
const sha = (digit) => String(digit).repeat(40);

// A simulated GitHub API for fetch: answers from the routes ('METHOD /path?query' -> { status, body, link }) and records
// every request
function fakeGithub(routes) {
  const requests = [];
  const fetch = async (url, init) => {
    const route = url.replace(API, '');
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method: init.method, route, body, auth: init.headers.Authorization });
    let answer = routes[`${init.method} ${route}`];
    if (!answer && init.method === 'POST') {
      answer = { status: 201, body: { number: 7 } };
    } else if (!answer && init.method === 'PATCH') {
      answer = { status: 200, body: {} };
    }
    answer = answer || { status: 404, body: { message: 'Not Found' } };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => JSON.stringify(answer.body),
      headers: { get: (name) => (name.toLowerCase() === 'link' ? answer.link || null : null) },
    };
  };
  return { fetch, requests, writes: () => requests.filter((request) => request.method !== 'GET') };
}

const commit = (id, message, date) => ({ sha: id, commit: { message, committer: { date: date || '2026-11-02T10:00:00Z' } } });
const ok = (body, link) => ({ status: 200, body, link });

// Write a baseline file with the given projects to a temporary folder and run the script on it
async function runWatch(dependencies, routes, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-upstream-'));
  const file = path.join(dir, 'baselines.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, dependencies }));
  const github = fakeGithub(routes);
  const logs = [];
  const warnings = [];
  try {
    const code = await watch.run(Object.assign({
      BASELINES: file,
      GITHUB_TOKEN: 'secret-token',
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_API_URL: API,
      GITHUB_SERVER_URL: 'https://github.test',
      CHECK_DATE: '2026-11-03T08:00:00Z',
    }, env), { fetch: github.fetch, log: (line) => logs.push(line), warn: (line) => warnings.push(line) });
    return { code, github, logs, warnings };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The body of the issue that the run opened or updated
function issueBody(result) {
  const write = result.github.writes().find((request) => request.body && request.body.body);
  assert.ok(write, 'the run wrote the issue');
  return write.body.body;
}

const BRANCH_DEP = {
  id: 'common-c', name: 'moonlight-common-c', repo: 'up/common-c', track: 'branch', branch: 'master',
  vendored: '8599b60 with fixes', reviewed_through: sha('a'),
  decisions: [{ commits: ['cccccc1'], decision: 'skipped', why: 'Not for Tizen.' }],
};
const NO_ISSUES = { [`GET /repos/${REPOSITORY}/issues?state=open&per_page=100`]: ok([]) };

test('the baseline file is valid and names every project the owner asked for', () => {
  const data = readBaselines();
  assert.deepEqual(watch.validateBaselines(data), []);
  const byId = Object.fromEntries(data.dependencies.map((dep) => [dep.id, dep]));
  assert.deepEqual(Object.keys(byId).sort(), ['enet', 'libgamestream', 'moonlight-common-c', 'moonlight-tizen', 'opus', 'sunshine', 'sunshine-pr-5917']);
  assert.equal(byId['moonlight-tizen'].repo, 'brightcraft/moonlight-tizen');
  assert.equal(byId['moonlight-common-c'].repo, 'moonlight-stream/moonlight-common-c');
  assert.deepEqual([byId.enet.track, byId.enet.pinned_in], ['submodule', { repo: 'moonlight-stream/moonlight-common-c', path: 'enet' }]);
  assert.deepEqual([byId.opus.repo, byId.opus.track], ['xiph/opus', 'tags']);
  assert.deepEqual([byId.libgamestream.repo, byId.libgamestream.path], ['moonlight-stream/moonlight-embedded', 'libgamestream']);
  // Sunshine moved from LizardByte/Sunshine to SunshineStream/Sunshine (the old name redirects)
  assert.deepEqual([byId.sunshine.repo, byId.sunshine.track], ['SunshineStream/Sunshine', 'releases']);
  assert.deepEqual([byId['sunshine-pr-5917'].repo, byId['sunshine-pr-5917'].track, byId['sunshine-pr-5917'].pull], ['SunshineStream/Sunshine', 'pull', 5917]);
  // Every decision says why, and every taken change names the version of Moonlight Plus that has it
  data.dependencies.forEach((dep) => dep.decisions.forEach((decision) => {
    assert.ok(decision.why.length >= 20, `${dep.id}: a reason of its own`);
    if (decision.decision === 'taken') {
      assert.match(decision.in, /^(1\.19\.\d+|1\.19\.0-s90c\.1|2\.\d+\.\d+)$/, `${dep.id}: the version of Moonlight Plus`);
    }
  }));
});

test('the baseline file starts from the vendored versions of submodulesVer.txt', () => {
  const versions = fs.readFileSync(path.join(REPO_ROOT, 'submodulesVer.txt'), 'utf8');
  const byId = Object.fromEntries(readBaselines().dependencies.map((dep) => [dep.id, dep]));
  const pin = (name) => new RegExp(`^${name} @ (\\w+)`, 'm').exec(versions)[1];
  assert.ok(byId['moonlight-common-c'].vendored.indexOf(pin('moonlight-common-c')) === 0);
  assert.ok(byId.enet.vendored.indexOf(pin('enet')) === 0);
  assert.ok(byId.enet.decisions[0].range.indexOf(pin('enet')) === 0, 'the first ENet range starts at the vendored version');
  assert.ok(byId.opus.vendored.indexOf(pin('opus')) >= 0 && byId.opus.vendored.indexOf(/\| (v[\d.]+)/.exec(versions)[1]) === 0);
  assert.ok(byId.opus.decisions[0].range.indexOf('v1.5.2..') === 0);
});

// The upstream commits that the review of 16 November 2026 read, oldest first (git log of each project): Moonlight Tizen
// after ce18df8 up to 8b3049a, moonlight-common-c after 5d3c0ec up to 94c65fd
const TIZEN_COMMITS_TO_8B3049A = ['973a61b', 'a2d0009', '72caff4', '6da5b7f', '0ef676b', '087df40', '90b4a04', '99aada9', '8b3049a'];
const COMMON_C_COMMITS_TO_94C65FD = [
  'c7dff22', '4853e70', '7d61e2d', 'f050b13', '41d6c1d', 'f462147', '134eee4', '7bf16de', '2e18599', 'ee160c9', 'e80a786',
  '3387805', 'a84a69a', 'bf71226', '348d5d1', '4aa7ea4', '3b6ee9d', 'b0deb0a', '7fd0f25', '7d884fa', 'c3360b7', 'edb4e9e',
  'e44e429', 'eac4c46', '274ec03', '74a61b9', '08ebedb', '541e396', 'd5b38a3', 'a0262e7', 'e64327c', 'ae6633e', '0b4a44d',
  'dc09c9f', 'f0df33c', 'a1aa0a1', '2b45ee9', '18922a1', '2804982', 'e6b1aaf', 'cf68e15', '98210be', 'a879f89', '30b928f',
  '67996ec', '0d92c94', '94c65fd',
];

test('the review of November 2026 moved each project to the upstream state it read, with a decision for every change in between', () => {
  const byId = Object.fromEntries(readBaselines().dependencies.map((dep) => [dep.id, dep]));
  const decisionsOf = (dep, hash) => dep.decisions.filter((decision) => (decision.commits || []).indexOf(hash) >= 0);
  const expectOneDecision = (id, hashes) => hashes.forEach((hash) => assert.equal(decisionsOf(byId[id], hash).length, 1, `${id} ${hash}`));
  assert.equal(byId['moonlight-tizen'].reviewed_through, '8b3049a9e1731c12a7ab150a1cb01aba449abded');
  expectOneDecision('moonlight-tizen', TIZEN_COMMITS_TO_8B3049A);
  assert.equal(byId['moonlight-common-c'].reviewed_through, '94c65fd364d17b223f00a8763c9a5d94a66cb8dd');
  assert.equal(COMMON_C_COMMITS_TO_94C65FD.length, 47);
  expectOneDecision('moonlight-common-c', COMMON_C_COMMITS_TO_94C65FD);
  // The commits ported in 2.3.1 are taken, the C11 atomics and the protocol extensions skipped
  ['bf71226', '348d5d1', 'e64327c', 'ae6633e', '0b4a44d', '74a61b9', '18922a1', 'a84a69a', 'dc09c9f', '134eee4', '7bf16de', '2e18599', 'ee160c9', '4aa7ea4']
    .forEach((hash) => assert.deepEqual([decisionsOf(byId['moonlight-common-c'], hash)[0].decision, decisionsOf(byId['moonlight-common-c'], hash)[0].in], ['taken', '2.3.1'], hash));
  ['b0deb0a', 'c7dff22', '4853e70', '0d92c94'].forEach((hash) => assert.equal(decisionsOf(byId['moonlight-common-c'], hash)[0].decision, 'skipped', hash));
  // The skipped microsecond series carries the warning about its audio queue, and no decision says any more that the
  // commits after 5d3c0ec wait for a review
  assert.match(decisionsOf(byId['moonlight-common-c'], '82ee2d6')[0].why, /handleMissingPackets\(\) in RtpAudioQueue\.c compares an age in microseconds/);
  // 2.3.2 took its microsecond clock and the microsecond times of a video frame: the decision says what was taken and
  // stays skipped for the rest, and the note lists it with the local patches
  const microseconds = decisionsOf(byId['moonlight-common-c'], '82ee2d6')[0];
  assert.equal(microseconds.decision, 'skipped');
  assert.match(microseconds.why, /^Microsecond timestamps and RTP audio and video statistics\. Partly ported by hand in 2\.3\.2, only what the times of a video frame need: PltGetMicroseconds\(\) and the public LiGetMicroseconds\(\)/);
  assert.match(microseconds.why, /receiveTimeUs and enqueueTimeUs in DECODE_UNIT/);
  assert.match(microseconds.why, /receiveTimeMs and enqueueTimeMs of DECODE_UNIT stay/);
  assert.match(microseconds.why, /Skipped, so the decision stays: the RTP statistics \(LiGetRTPAudioStats\(\), LiGetRTPVideoStats\(\)\)/);
  assert.match(byId['moonlight-common-c'].note, /since 2\.3\.2 the microsecond clock and the microsecond times of a video frame from 82ee2d6, see its decision/);
  // The other two local patches of 2.3.2, which a port of an upstream change of the same files must keep: the arrival
  // figures of a frame and the QoS line of each socket, with their functions and their tests, which exist
  const note = byId['moonlight-common-c'].note;
  assert.match(note, /since 2\.3\.2 also the arrival figures of a frame for the rate at which frames arrive, addFecBlockArrival\(\) and its call with the clock read before reconstructFrame\(\) in RtpvAddPacket\(\) of RtpVideoQueue\.c/);
  assert.match(note, /since 2\.3\.2 also the QoS line of each socket in the diagnostic log, logSocketQos\(\) and the result of setSocketQos\(\) in PlatformSockets\.c and PlatformSockets\.h, called from bindUdpSocket\(\) and from startControlStream\(\) in ControlStream\.c/);
  ['tests/native/frame_arrival_test.c', 'tests/native/socket_qos_test.c'].forEach((file) => {
    assert.ok(note.indexOf(file) > 0, file);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), file);
  });
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'moonlight-common-c/src/RtpVideoQueue.c'), 'utf8'), /static void addFecBlockArrival\(/);
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'moonlight-common-c/src/ControlStream.c'), 'utf8'), /logSocketQos\(client->socket/);
  // The local patch of 2.3.4: the video receive lines and the socket of the video that never waits, with their
  // functions and their tests, which exist
  assert.match(note, /since 2\.3\.4 also the video receive lines of the diagnostic log and the back-to-back reads of a socket that never waits/);
  assert.match(note, /bindUdpSocketNoWait\(\), recvUdpSocketNoWait\(\) and wakeUdpSocketReader\(\) in PlatformSockets\.c and PlatformSockets\.h \(bindUdpSocket\(\) now calls the shared bindUdpSocketOfType\(\)\), nextVideoReceiveSampleGap\(\) and wakeVideoReceiveThread\(\) before each join of the receive thread in VideoStream\.c/);
  assert.match(note, /in VideoReceiveThreadProc\(\) and the replaced socket in startVideoStream\(\) of VideoStream\.c/);
  ['tests/native/video_receive_test.c', 'tests/native/udp_no_wait_test.c'].forEach((file) => {
    assert.ok(note.indexOf(file) > 0, file);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), file);
  });
  const sockets = fs.readFileSync(path.join(REPO_ROOT, 'moonlight-common-c/src/PlatformSockets.c'), 'utf8');
  ['SOCKET bindUdpSocketNoWait(', 'int recvUdpSocketNoWait(', 'int wakeUdpSocketReader(', 'static SOCKET bindUdpSocketOfType('].forEach((name) => assert.ok(sockets.indexOf(name) > 0, name));
  const video = fs.readFileSync(path.join(REPO_ROOT, 'moonlight-common-c/src/VideoStream.c'), 'utf8');
  ['static uint32_t nextVideoReceiveSampleGap(', 'static void wakeVideoReceiveThread('].forEach((name) => assert.ok(video.indexOf(name) > 0, name));
  byId['moonlight-common-c'].decisions.forEach((decision) => assert.doesNotMatch(decision.why, /not reviewed yet/));
  // The termination change of the Nightjar client is listed with the local patches
  assert.match(byId['moonlight-common-c'].note, /from host-termination\.patch of the Nightjar client \(GPL-3\.0\), tests\/native\/connection_termination_test\.c/);
  // ENet up to the version that moonlight-common-c 94c65fd pins, the last range ending there
  const enetRanges = byId.enet.decisions.map((decision) => decision.range);
  assert.equal(byId.enet.reviewed_through, '98dbb897ac4a7208038e0782cddedf89dcf0723a');
  assert.equal(enetRanges[enetRanges.length - 1], '44c85e16279553d9c052e572bcbfcd745fb74abf..98dbb897ac4a7208038e0782cddedf89dcf0723a');
  // Sunshine deletes the tags of its pre-releases, so it stays at its stable release, with the pre-releases it read
  // recorded by their tags; pull request 5917 only merged master since bf9ce40
  assert.equal(byId.sunshine.reviewed_through, 'v2026.914.233613');
  assert.match(byId.sunshine.note, /deletes the tags of its pre-releases/);
  assert.match(byId.sunshine.note, /a newer full release is reported even when its tag has a decision/);
  assert.deepEqual(byId.sunshine.decisions.map((decision) => decision.tags[0]), ['v2026.516.143833', 'v2026.1115.211404', 'v2026.1116.25010']);
  assert.deepEqual([byId['sunshine-pr-5917'].reviewed_through, byId['sunshine-pr-5917'].reviewed_state], ['31044d8af7f8fdb0795c6bc2e460eed8ccb07782', 'open']);
  // libgamestream of moonlight-embedded, reviewed once for 2.3.3 through 33142e5: the length of the signature of the host
  // (000d9da) and pairing while the PC is busy (f021439) taken, the rest skipped, each commit once
  const libgamestream = byId.libgamestream;
  assert.equal(libgamestream.reviewed_through, '33142e58ebd576085a076f4ce24881d20b3c4ef5');
  ['000d9da', 'f021439'].forEach((hash) => assert.deepEqual([decisionsOf(libgamestream, hash).length, decisionsOf(libgamestream, hash)[0].decision,
    decisionsOf(libgamestream, hash)[0].in], [1, 'taken', '2.3.3'], hash));
  ['5f7f0ec', 'f32e415', '274d3db', '28c3aad', 'ab9999c', '040e389'].forEach((hash) => assert.deepEqual([decisionsOf(libgamestream, hash).length,
    decisionsOf(libgamestream, hash)[0].decision], [1, 'skipped'], hash));
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'libgamestream/pairing.c'), 'utf8'), /#define PAIRING_SIGNATURE_MAX_BYTES 512/);
});

test('every upstream commit that the changelog says was ported is recorded as taken', () => {
  const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const byId = Object.fromEntries(readBaselines().dependencies.map((dep) => [dep.id, dep]));
  const decisionOf = (dep, hash) => dep.decisions.find((decision) => (decision.commits || []).indexOf(hash) >= 0);
  const found = { 'moonlight-common-c': new Set(), 'moonlight-tizen': new Set() };
  changelog.split('\n').forEach((line) => {
    // "as in upstream moonlight-common-c e2722dc", "Updated the vendored moonlight-common-c with ... (aeba988, ...)"
    if (/upstream moonlight-common-c [0-9a-f]{7}\b|^- Updated the vendored moonlight-common-c with/.test(line)) {
      (line.match(/\b[0-9a-f]{7}\b/g) || []).forEach((hash) => found['moonlight-common-c'].add(hash));
    }
    // "as upstream 0a35dfd" (Moonlight Tizen)
    (line.match(/\bas upstream (?:does since )?([0-9a-f]{7})\b/g) || []).forEach((match) => found['moonlight-tizen'].add(match.slice(-7)));
  });
  assert.ok(found['moonlight-common-c'].size >= 13, 'the changelog names the ported commits: ' + [...found['moonlight-common-c']]);
  assert.ok(found['moonlight-tizen'].has('0a35dfd'));
  Object.keys(found).forEach((id) => found[id].forEach((hash) => {
    const decision = decisionOf(byId[id], hash);
    assert.ok(decision, `${id} ${hash} has a decision`);
    assert.equal(decision.decision, 'taken', `${id} ${hash} is taken`);
  }));
  // The commits that must never come alone are recorded as skipped together (research: e59a5f5 carries a
  // use-after-free that 970b072 fixes)
  const batching = decisionOf(byId['moonlight-common-c'], 'e59a5f5');
  assert.equal(batching.decision, 'skipped');
  assert.ok(batching.commits.indexOf('970b072') >= 0);
});

test('the checker of the baseline file finds what the script can\'t use', () => {
  const valid = () => JSON.parse(JSON.stringify({ schema_version: 1, dependencies: [BRANCH_DEP] }));
  const cases = [
    [(data) => { data.dependencies[0].decisions.push({ commits: ['cccccc1'], decision: 'taken', in: '2.1.0', why: 'Twice.' }); }, /cccccc1 has more than one decision/],
    [(data) => { data.dependencies[0].decisions[0].why = ' '; }, /why must say/],
    [(data) => { Object.assign(data.dependencies[0].decisions[0], { decision: 'taken' }); }, /in must be the version/],
    [(data) => { data.dependencies[0].decisions[0].decision = 'later'; }, /decision must be one of taken, skipped/],
    [(data) => { data.dependencies[0].decisions[0].range = 'a..b'; }, /exactly one of commits, tags or range/],
    [(data) => { data.dependencies[0].decisions[0].commits = ['xyz']; }, /xyz is not a commit SHA/],
    [(data) => { data.dependencies[0].reviewed_through = 'aaaaaaa'; }, /full commit SHA/],
    [(data) => { data.dependencies[0].track = 'weekly'; }, /track must be one of/],
    [(data) => { data.dependencies[0].repo = 'common-c'; }, /repo must be owner\/name/],
    [(data) => { data.dependencies.push(Object.assign({}, data.dependencies[0])); }, /the id is used twice/],
    [(data) => { Object.assign(data.dependencies[0], { track: 'tags', tag_pattern: '^v\\d+$', reviewed_through: 'v1.6.1' }); }, /a tag that matches tag_pattern/],
    [(data) => { Object.assign(data.dependencies[0], { track: 'pull', pull: 5917 }); }, /reviewed_state must be one of/],
    [(data) => { Object.assign(data.dependencies[0], { track: 'submodule' }); }, /pinned_in must name/],
    [(data) => { data.schema_version = 2; }, /schema_version must be 1/],
  ];
  assert.deepEqual(watch.validateBaselines(valid()), []);
  cases.forEach(([change, expected]) => {
    const data = valid();
    change(data);
    const problems = watch.validateBaselines(data);
    assert.ok(problems.some((problem) => expected.test(problem)), `${expected}: ${problems.join(' | ')}`);
  });
});

test('new commits on a branch go into a new issue with a compare link, without those that already have a decision', async () => {
  const result = await runWatch([BRANCH_DEP], Object.assign({
    'GET /repos/up/common-c/commits/master': ok(commit(sha('d'), 'Newest')),
    [`GET /repos/up/common-c/compare/${sha('a')}...${sha('d')}`]: ok({
      status: 'ahead', ahead_by: 3,
      commits: [commit(sha('b'), 'Fix the RTSP parser\n\nLong text', '2026-10-31T09:00:00Z'), commit('cccccc1' + 'c'.repeat(33), 'Vita port'), commit(sha('d'), 'Newest')],
    }),
  }, NO_ISSUES));
  assert.equal(result.code, 0);
  const writes = result.github.writes();
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].route], ['POST', `/repos/${REPOSITORY}/issues`]);
  assert.equal(writes[0].body.title, watch.ISSUE_TITLE);
  const body = writes[0].body.body;
  assert.ok(body.indexOf(watch.MARKER) === 0, 'the marker that finds the issue again');
  assert.ok(body.indexOf(`3 new commits since \`aaaaaaa\`: [compare](https://github.test/up/common-c/compare/${sha('a')}...${sha('d')})`) >= 0, body);
  // Newest first, with the first line of the message and the date
  assert.ok(body.indexOf(`[\`ddddddd\`](https://github.test/up/common-c/commit/${sha('d')}) Newest`) < body.indexOf('[`bbbbbbb`]'));
  assert.ok(body.indexOf('Fix the RTSP parser (2026-10-31)') >= 0);
  assert.ok(body.indexOf('Long text') < 0 && body.indexOf('Vita port') < 0, 'only the first line, and no commit with a decision');
  assert.ok(body.indexOf('1 of them already has a decision in the baseline file') >= 0);
  assert.ok(body.indexOf('Moonlight Plus has: 8599b60 with fixes.') >= 0);
  assert.ok(body.indexOf('https://github.test/owner/plus/blob/HEAD/.github/dependency-baselines.json') >= 0);
  // The token goes to the API
  assert.ok(result.github.requests.every((request) => request.auth === 'Bearer secret-token'));
});

test('a later run updates the issue of the earlier run instead of opening a second one', async () => {
  const issues = [
    { number: 3, title: 'Another issue', body: 'Upstream changes to review, by hand' },
    { number: 4, title: watch.ISSUE_TITLE, body: watch.MARKER + '\nold', pull_request: {} },
    { number: 5, title: 'Renamed by the owner', body: watch.MARKER + '\nold list' },
  ];
  const result = await runWatch([BRANCH_DEP], {
    'GET /repos/up/common-c/commits/master': ok(commit(sha('d'), 'Newest')),
    [`GET /repos/up/common-c/compare/${sha('a')}...${sha('d')}`]: ok({ status: 'ahead', ahead_by: 1, commits: [commit(sha('d'), 'Newest')] }),
    [`GET /repos/${REPOSITORY}/issues?state=open&per_page=100`]: ok(issues.slice(0, 2), `<${API}/repos/${REPOSITORY}/issues?state=open&per_page=100&page=2>; rel="next"`),
    [`GET /repos/${REPOSITORY}/issues?state=open&per_page=100&page=2`]: ok(issues.slice(2)),
  });
  assert.equal(result.code, 0);
  const writes = result.github.writes();
  assert.deepEqual(writes.map((write) => [write.method, write.route]), [['PATCH', `/repos/${REPOSITORY}/issues/5`]]);
  assert.ok(writes[0].body.body.indexOf('1 new commit since') >= 0);
});

test('with everything reviewed, no issue is opened and the issue of an earlier run is closed', async () => {
  const quiet = await runWatch([BRANCH_DEP], Object.assign({ 'GET /repos/up/common-c/commits/master': ok(commit(sha('a'), 'Reviewed')) }, NO_ISSUES));
  assert.equal(quiet.code, 0);
  assert.deepEqual(quiet.github.writes(), []);
  const closing = await runWatch([BRANCH_DEP], {
    'GET /repos/up/common-c/commits/master': ok(commit(sha('a'), 'Reviewed')),
    [`GET /repos/${REPOSITORY}/issues?state=open&per_page=100`]: ok([{ number: 9, title: watch.ISSUE_TITLE, body: watch.MARKER + '\nlist' }]),
  });
  const writes = closing.github.writes();
  assert.deepEqual(writes.map((write) => [write.method, write.route, write.body.state, write.body.state_reason]), [['PATCH', `/repos/${REPOSITORY}/issues/9`, 'closed', 'completed']]);
  assert.ok(writes[0].body.body.indexOf(watch.MARKER) === 0);
});

test('a project that can\'t be read is listed as such, the others are still checked, and the issue stays open', async () => {
  const broken = Object.assign({}, BRANCH_DEP, { id: 'broken', name: 'Broken', repo: 'up/gone' });
  const reviewed = await runWatch([broken, BRANCH_DEP], {
    'GET /repos/up/gone/commits/master': { status: 403, body: { message: 'API rate limit exceeded' } },
    'GET /repos/up/common-c/commits/master': ok(commit(sha('a'), 'Reviewed')),
    [`GET /repos/${REPOSITORY}/issues?state=open&per_page=100`]: ok([{ number: 9, title: watch.ISSUE_TITLE, body: watch.MARKER }]),
  });
  assert.equal(reviewed.code, 0);
  assert.deepEqual(reviewed.github.writes(), [], 'the issue isn\'t closed while a project couldn\'t be checked');
  assert.ok(reviewed.warnings.some((line) => /^::warning title=broken::GET \/repos\/up\/gone\/commits\/master answered HTTP 403: API rate limit exceeded$/.test(line)), reviewed.warnings.join('\n'));
  // With something to review, the issue lists the project under "Could not check"
  const pending = await runWatch([broken, BRANCH_DEP], Object.assign({
    'GET /repos/up/gone/commits/master': { status: 500, body: {} },
    'GET /repos/up/common-c/commits/master': ok(commit(sha('d'), 'Newest')),
    [`GET /repos/up/common-c/compare/${sha('a')}...${sha('d')}`]: ok({ status: 'ahead', ahead_by: 1, commits: [commit(sha('d'), 'Newest')] }),
  }, NO_ISSUES));
  assert.match(issueBody(pending), /### Could not check\n\n- Broken \(up\/gone\): GET \/repos\/up\/gone\/commits\/master answered HTTP 500/);
  // Nothing readable at all fails the run
  const none = await runWatch([broken], Object.assign({}, NO_ISSUES));
  assert.equal(none.code, 1);
  assert.deepEqual(none.github.writes(), []);
  assert.ok(none.warnings.indexOf('::error::No project could be checked') >= 0, none.warnings.join('\n'));
});

test('a rewritten history upstream is reported instead of a list of commits', async () => {
  const result = await runWatch([BRANCH_DEP], Object.assign({
    'GET /repos/up/common-c/commits/master': ok(commit(sha('e'), 'Rewritten')),
    [`GET /repos/up/common-c/compare/${sha('a')}...${sha('e')}`]: ok({ status: 'diverged', ahead_by: 2, behind_by: 1, commits: [] }),
  }, NO_ISSUES));
  assert.match(issueBody(result), /The reviewed commit `aaaaaaa` is not an ancestor of `eeeeeee` \(diverged\)/);
});

test('a project watched by a folder asks for a first review, then lists the new commits that touch the folder', async () => {
  const dep = {
    id: 'libgamestream', name: 'libgamestream', repo: 'up/embedded', track: 'branch', path: 'libgamestream',
    vendored: 'a subset', reviewed_through: null, decisions: [],
  };
  const commits = [commit(sha('3'), 'Third'), commit(sha('2'), 'Second'), commit(sha('1'), 'First')];
  const routes = Object.assign({
    'GET /repos/up/embedded': ok({ default_branch: 'main' }),
    'GET /repos/up/embedded/commits?sha=main&path=libgamestream&per_page=100': ok(commits),
  }, NO_ISSUES);
  const first = issueBody(await runWatch([dep], routes));
  assert.ok(first.indexOf('Not reviewed yet. The newest commits that touch `libgamestream` on main ([history](https://github.test/up/embedded/commits/main/libgamestream))') >= 0, first);
  assert.ok(first.indexOf('Third') >= 0 && first.indexOf('First') >= 0);
  const later = issueBody(await runWatch([Object.assign({}, dep, { reviewed_through: sha('1') })], routes));
  assert.ok(later.indexOf(`2 new commits touch \`libgamestream\` since \`1111111\`: [compare](https://github.test/up/embedded/compare/${sha('1')}...${sha('3')})`) >= 0, later);
  assert.ok(later.indexOf('First') < 0);
  const current = await runWatch([Object.assign({}, dep, { reviewed_through: sha('3') })], routes);
  assert.deepEqual(current.github.writes(), []);
});

test('a submodule that upstream moved is compared in the repository of the submodule', async () => {
  const dep = {
    id: 'enet', name: 'ENet', repo: 'up/enet', track: 'submodule', pinned_in: { repo: 'up/common-c', path: 'enet' },
    vendored: 'bbf7185', reviewed_through: sha('4'), decisions: [],
  };
  const body = issueBody(await runWatch([dep], Object.assign({
    'GET /repos/up/common-c/contents/enet': ok({ type: 'submodule', sha: sha('5') }),
    [`GET /repos/up/enet/compare/${sha('4')}...${sha('5')}`]: ok({ status: 'ahead', ahead_by: 1, commits: [commit(sha('5'), 'FreeBSD support')] }),
  }, NO_ISSUES)));
  assert.ok(body.indexOf('up/common-c now pins `5555555` in `enet`.') >= 0, body);
  assert.ok(body.indexOf(`[compare](https://github.test/up/enet/compare/${sha('4')}...${sha('5')})`) >= 0);
  const current = await runWatch([dep], Object.assign({ 'GET /repos/up/common-c/contents/enet': ok({ type: 'submodule', sha: sha('4') }) }, NO_ISSUES));
  assert.deepEqual(current.github.writes(), []);
});

test('new release tags are listed newest first, without release candidates', async () => {
  const dep = {
    id: 'opus', name: 'Opus', repo: 'up/opus', track: 'tags', tag_pattern: '^v\\d+\\.\\d+(\\.\\d+)?$',
    vendored: 'v1.5.2', reviewed_through: 'v1.6.1', decisions: [],
  };
  const tags = (names) => names.map((name) => ({ name }));
  const body = issueBody(await runWatch([dep], Object.assign({
    'GET /repos/up/opus/tags?per_page=100': ok(tags(['v1.7-rc1', 'v1.6.2', 'v1.10', 'v1.6.1', 'v1.6', 'v1.5.2']), `<${API}/repos/up/opus/tags?per_page=100&page=2>; rel="next"`),
    'GET /repos/up/opus/tags?per_page=100&page=2': ok(tags(['v1.7'])),
  }, NO_ISSUES)));
  assert.ok(body.indexOf('3 new release tags since v1.6.1: [compare](https://github.test/up/opus/compare/v1.6.1...v1.10)') >= 0, body);
  assert.ok(body.indexOf('[v1.10]') < body.indexOf('[v1.7]') && body.indexOf('[v1.7]') < body.indexOf('[v1.6.2]'));
  assert.ok(body.indexOf('rc1') < 0);
  const current = await runWatch([dep], Object.assign({ 'GET /repos/up/opus/tags?per_page=100': ok(tags(['v1.7-rc1', 'v1.6.1'])) }, NO_ISSUES));
  assert.deepEqual(current.github.writes(), []);
});

test('new releases are listed with pre-releases marked, and a pre-release with a decision is left out', async () => {
  const dep = {
    id: 'sunshine', name: 'Sunshine releases', repo: 'up/sunshine', track: 'releases', vendored: 'nothing',
    reviewed_through: 'v2026.1028.122642', decisions: [{ tags: ['v2026.1101.1'], decision: 'skipped', why: 'Only a Linux fix.' }],
  };
  const release = (tag, extra) => Object.assign({ tag_name: tag, published_at: '2026-11-02T10:00:00Z', prerelease: false, draft: false }, extra);
  const body = issueBody(await runWatch([dep], Object.assign({
    'GET /repos/up/sunshine/releases?per_page=30': ok([
      release('v2026.1105.1', { draft: true }), release('v2026.1103.1', { prerelease: true }), release('v2026.1101.1', { prerelease: true }), release('v2026.1028.122642'),
    ]),
  }, NO_ISSUES)));
  assert.ok(body.indexOf('2 new releases since v2026.1028.122642: [compare](https://github.test/up/sunshine/compare/v2026.1028.122642...v2026.1103.1)') >= 0, body);
  assert.ok(body.indexOf('[v2026.1103.1](https://github.test/up/sunshine/releases/tag/v2026.1103.1) pre-release (2026-11-02)') >= 0);
  assert.ok(body.indexOf('v2026.1105.1') < 0 && body.indexOf('[v2026.1101.1]') < 0, 'no draft and no pre-release with a decision');
});

test('a project that deletes the tags of its pre-releases stays at a stable release and is up to date once every newer release has a decision', async () => {
  // As Sunshine: reviewed_through is its stable release, and the two pre-releases after it were read
  const dep = {
    id: 'sunshine', name: 'Sunshine releases', repo: 'up/sunshine', track: 'releases', vendored: 'nothing',
    reviewed_through: 'v2026.914.233613',
    decisions: [
      { tags: ['v2026.1115.211404'], decision: 'taken', in: '2.3.1', why: 'The guide names its fixes.' },
      { tags: ['v2026.1116.25010'], decision: 'skipped', why: 'Nothing for a client.' },
    ],
  };
  const release = (tag, extra) => Object.assign({ tag_name: tag, published_at: '2026-11-16T10:00:00Z', prerelease: false, draft: false }, extra);
  const route = 'GET /repos/up/sunshine/releases?per_page=30';
  const read = [release('v2026.1116.25010', { prerelease: true }), release('v2026.1115.211404', { prerelease: true }), release('v2026.914.233613'), release('v2026.906.222525')];
  // Every newer release has a decision: nothing to review, and the stable tag is named in full, not cut like a commit
  const quiet = await runWatch([dep], { [route]: ok(read) }, { DRY_RUN: 'true', GITHUB_TOKEN: '' });
  assert.equal(quiet.code, 0);
  assert.ok(quiet.logs.indexOf('sunshine: up to date') >= 0, quiet.logs.join('\n'));
  assert.ok(quiet.logs.some((line) => line.indexOf('### Up to date\n\n- Sunshine releases (up/sunshine): reviewed through v2026.914.233613\n') >= 0), quiet.logs.join('\n'));
  // The issue of an earlier run is closed
  const closing = await runWatch([dep], {
    [route]: ok(read),
    [`GET /repos/${REPOSITORY}/issues?state=open&per_page=100`]: ok([{ number: 9, title: watch.ISSUE_TITLE, body: watch.MARKER + '\nlist' }]),
  });
  assert.deepEqual(closing.github.writes().map((write) => [write.method, write.route, write.body.state]), [['PATCH', `/repos/${REPOSITORY}/issues/9`, 'closed']]);
  // Later both pre-release tags are gone and a new pre-release came: only that one comes up
  const pruned = issueBody(await runWatch([dep], Object.assign({ [route]: ok([release('v2026.1201.1', { prerelease: true }), release('v2026.914.233613'), release('v2026.906.222525')]) }, NO_ISSUES)));
  assert.ok(pruned.indexOf('1 new release since v2026.914.233613: [compare](https://github.test/up/sunshine/compare/v2026.914.233613...v2026.1201.1)') >= 0, pruned);
  assert.ok(pruned.indexOf('[v2026.1201.1](https://github.test/up/sunshine/releases/tag/v2026.1201.1) pre-release (2026-11-16)') >= 0, pruned);
  // Sunshine publishes a stable release by turning a pre-release into a full release under the same tag: a recorded
  // pre-release that became the stable release is reported again, so the guide's "only in the pre-release" lines and
  // reviewed_through get moved
  const promotedRead = [release('v2026.1116.25010'), release('v2026.1115.211404', { prerelease: true }), release('v2026.914.233613'), release('v2026.906.222525')];
  const promoted = issueBody(await runWatch([dep], Object.assign({ [route]: ok(promotedRead) }, NO_ISSUES)));
  assert.ok(promoted.indexOf('2 new releases since v2026.914.233613') >= 0, promoted);
  assert.ok(promoted.indexOf('[v2026.1116.25010](https://github.test/up/sunshine/releases/tag/v2026.1116.25010) (2026-11-16): a full release now, and it has a decision: move reviewed_through to it') >= 0, promoted);
  assert.ok(promoted.indexOf('[v2026.1115.211404]') < 0, 'the recorded pre-release stays left out');
  // A reviewed release that is gone itself is still reported, with the newest releases
  const lost = issueBody(await runWatch([Object.assign({}, dep, { reviewed_through: 'v2026.1028.122642' })], Object.assign({ [route]: ok(read) }, NO_ISSUES)));
  assert.ok(lost.indexOf('The reviewed release v2026.1028.122642 is not among the 4 newest releases. The newest:') >= 0, lost);
  // Commits are still shortened in the list of projects that are up to date
  const commits = await runWatch([BRANCH_DEP], { 'GET /repos/up/common-c/commits/master': ok(commit(sha('a'), 'Reviewed')) }, { DRY_RUN: 'true', GITHUB_TOKEN: '' });
  assert.ok(commits.logs.some((line) => line.indexOf('reviewed through aaaaaaa\n') >= 0), commits.logs.join('\n'));
});

test('a pull request with a new head commit or a new state is listed', async () => {
  const dep = {
    id: 'pr', name: 'Sunshine pull request #5917', repo: 'up/sunshine', track: 'pull', pull: 5917, vendored: 'nothing',
    reviewed_through: sha('6'), reviewed_state: 'open', decisions: [],
  };
  const body = issueBody(await runWatch([dep], Object.assign({
    'GET /repos/up/sunshine/pulls/5917': ok({ state: 'closed', merged: true, merged_at: '2026-11-02T12:00:00Z', head: { sha: sha('7') } }),
  }, NO_ISSUES)));
  assert.ok(body.indexOf('- State: open → **merged** (2026-11-02)') >= 0, body);
  assert.ok(body.indexOf(`New head commit [\`7777777\`](https://github.test/up/sunshine/commit/${sha('7')}) since \`6666666\`: [compare](https://github.test/up/sunshine/compare/${sha('6')}...${sha('7')})`) >= 0);
  assert.ok(body.indexOf('#5917') < 0, 'the number of an upstream pull request never links an issue of this repository');
  // A pull request that was closed without new commits, and one that only got new commits
  const closed = issueBody(await runWatch([dep], Object.assign({
    'GET /repos/up/sunshine/pulls/5917': ok({ state: 'closed', merged: false, closed_at: '2026-11-04T08:00:00Z', head: { sha: sha('6') } }),
  }, NO_ISSUES)));
  assert.ok(closed.indexOf('- State: open → **closed** (2026-11-04)') >= 0 && closed.indexOf('New head commit') < 0, closed);
  const pushed = issueBody(await runWatch([dep], Object.assign({
    'GET /repos/up/sunshine/pulls/5917': ok({ state: 'open', merged: false, head: { sha: sha('8') } }),
  }, NO_ISSUES)));
  assert.ok(pushed.indexOf('State:') < 0 && pushed.indexOf('New head commit [`8888888`]') >= 0, pushed);
  const current = await runWatch([dep], Object.assign({ 'GET /repos/up/sunshine/pulls/5917': ok({ state: 'open', merged: false, head: { sha: sha('6') } }) }, NO_ISSUES));
  assert.deepEqual(current.github.writes(), []);
});

test('upstream text never mentions a GitHub user, references an issue of this repository or adds HTML', async () => {
  const result = await runWatch([BRANCH_DEP], Object.assign({
    'GET /repos/up/common-c/commits/master': ok(commit(sha('d'), 'Thanks @someone, fixes #162 <script>x</script>')),
    [`GET /repos/up/common-c/compare/${sha('a')}...${sha('d')}`]: ok({ status: 'ahead', ahead_by: 1, commits: [commit(sha('d'), 'Thanks @someone, fixes #162 <script>x</script>')] }),
  }, NO_ISSUES));
  const body = issueBody(result);
  assert.doesNotMatch(body, /@someone|#162|<script/);
  assert.ok(body.indexOf('Thanks @\u200bsomeone, fixes #\u200b162 &lt;script&gt;x&lt;/script&gt;') >= 0);
  assert.equal(watch.plain('a\nb'), 'a');
});

test('a dry run prints the issue without reading or writing issues, and an invalid file stops the run before any request', async () => {
  const dry = await runWatch([BRANCH_DEP], { 'GET /repos/up/common-c/commits/master': ok(commit(sha('a'), 'Reviewed')) }, { DRY_RUN: 'true', GITHUB_TOKEN: '' });
  assert.equal(dry.code, 0);
  assert.ok(dry.github.requests.every((request) => request.route.indexOf('/issues') < 0));
  assert.ok(dry.logs.some((line) => line.indexOf('### Up to date\n\n- moonlight-common-c (up/common-c): reviewed through aaaaaaa') >= 0), dry.logs.join('\n'));
  const invalid = await runWatch([Object.assign({}, BRANCH_DEP, { reviewed_through: 'abc' })], {});
  assert.equal(invalid.code, 1);
  assert.deepEqual(invalid.github.requests, []);
  assert.ok(invalid.warnings.some((line) => /^::error::dependency-baselines\.json: dependencies\[0\] \(common-c\): reviewed_through must be a full commit SHA/.test(line)));
  const noToken = await runWatch([BRANCH_DEP], {}, { GITHUB_TOKEN: '' });
  assert.equal(noToken.code, 1);
  assert.deepEqual(noToken.github.requests, []);
});

test('the script runs as the workflow runs it, against a GitHub API on this machine, and writes the summary of the run', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, body: data ? JSON.parse(data) : null });
      const routes = {
        'GET /repos/up/common-c/commits/master': commit(sha('d'), 'Newest'),
        [`GET /repos/up/common-c/compare/${sha('a')}...${sha('d')}`]: { status: 'ahead', ahead_by: 1, commits: [commit(sha('d'), 'Newest')] },
        [`GET /repos/${REPOSITORY}/issues?state=open&per_page=100`]: [],
        [`POST /repos/${REPOSITORY}/issues`]: { number: 12 },
      };
      const answer = routes[`${request.method} ${request.url}`];
      response.writeHead(answer ? (request.method === 'POST' ? 201 : 200) : 404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer || { message: 'Not Found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-upstream-'));
  try {
    const baselines = path.join(dir, 'baselines.json');
    const summary = path.join(dir, 'summary.md');
    fs.writeFileSync(baselines, JSON.stringify({ schema_version: 1, dependencies: [BRANCH_DEP] }));
    const output = await new Promise((resolve, reject) => {
      childProcess.execFile(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        env: Object.assign({}, process.env, {
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_TOKEN: 'run-token', GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_RUN_ID: '42', BASELINES: baselines, GITHUB_STEP_SUMMARY: summary, DRY_RUN: 'false',
        }),
      }, (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    });
    assert.match(output, /common-c: to review\nOpened issue #12/);
    const created = requests.find((request) => request.method === 'POST');
    assert.equal(created.auth, 'Bearer run-token');
    assert.ok(created.body.body.indexOf('in [this run](https://github.com/owner/plus/actions/runs/42)') >= 0);
    const written = fs.readFileSync(summary, 'utf8');
    assert.ok(written.indexOf('1 new commit since `aaaaaaa`') >= 0 && written.indexOf(watch.MARKER) < 0);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow runs only when started by hand, reads the repository, writes only issues and runs the script', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const lines = workflow.split('\n').filter((line) => !/^\s*#/.test(line));
  const block = (key) => {
    const start = lines.findIndex((line) => line === `${key}:`);
    assert.ok(start >= 0, `a top-level ${key}`);
    const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim() !== '');
  };
  const triggers = block('on').filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim());
  assert.deepEqual(triggers, ['workflow_dispatch:'], 'no schedule: the owner adds one when he wants it');
  assert.deepEqual(block('permissions').map((line) => line.trim()), ['contents: read', 'issues: write']);
  assert.match(workflow, /\n {8}run: node \.github\/scripts\/check-upstream-dependencies\.js\n/);
  assert.match(workflow, /\n {10}GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n/);
  assert.match(workflow, /\n {10}DRY_RUN: \$\{\{ inputs\.dry_run \}\}\n/);
  // The script needs no npm packages, only the fetch of Node.js 22
  assert.match(workflow, /node-version: "22"/);
  assert.doesNotMatch(fs.readFileSync(SCRIPT, 'utf8'), /require\('(?!fs')[^']+'\)/);
});
