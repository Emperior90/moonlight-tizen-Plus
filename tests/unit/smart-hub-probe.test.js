'use strict';

// Checks the probe of the Smart Hub service (probeSmartHubSupport() in wasm/platform/index.js), which decides whether
// the app shows Preview tiles in Smart Hub and keeps the answer in localStorage: only a real answer of the service is
// kept. A launch of the service that fails or throws can be passing (e.g. right after the install), so it must not turn
// the tiles off for good; the next start asks again. 2.1.0 and earlier stored 'false' under the key smartHubSupported
// after a single failed launch, so that key is dropped and the service asked once more.
// Since 2.3.1 the service isn't started at all where it can't show tiles (smartHubServiceSkipReason()): above Tizen 6.0,
// since Samsung lists the TVs of 2016 to 2021 for the Preview tiles (Tizen 5.5 and 6.0 among those that the app installs
// on), and on a TV that reports no web services (http://tizen.org/feature/web.service). And the probe gives up after
// 5 seconds, so that the start goes on (the deep links of the tiles wait for it) when the service never answers, as
// reports say of background web services on Tizen 9 and 10; a late answer is kept for the next start only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

// Timers of the test, so that the 5 seconds of the probe pass at once: run() calls the callbacks of the timers that are
// due after the given time
function createTimers() {
  const timers = [];
  let nextId = 1;
  return {
    timers,
    setTimeout(callback, delay) {
      const timer = { id: nextId++, callback, delay: delay || 0, cleared: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      timers.filter((timer) => timer.id === id).forEach((timer) => {
        timer.cleared = true;
      });
    },
    run(elapsedMs) {
      timers.filter((timer) => !timer.cleared && !timer.ran && timer.delay <= elapsedMs).forEach((timer) => {
        timer.ran = true;
        timer.callback();
      });
    },
  };
}

// Load index.js on a TV of Tizen 5.5 (or the given TV) with a message port and a launch of the service that do what the
// test says: launch is 'answer' (the service starts and answers the probe with `answer`), 'error' (the launch fails),
// 'throw' (the API throws) or 'silent' (the service starts and never answers, until the test calls answerLate())
function loadProbe(launch, answer, storedBefore, tv) {
  const timers = createTimers();
  const platform = loadPlatformScripts(INDEX_SCRIPTS, {
    tv: tv || { tv: 'fhd' },
    globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  Object.keys(storedBefore || {}).forEach((key) => platform.context.localStorage.setItem(key, storedBefore[key]));
  const calls = { launches: 0, ports: 0, removed: [] };
  let listener = null;
  platform.context.tizen.messageport = {
    requestLocalMessagePort: () => {
      calls.ports++;
      if (launch === 'throw') {
        throw new Error('No message port');
      }
      return {
        addMessagePortListener: (callback) => {
          listener = callback;
          return 7;
        },
        removeMessagePortListener: (id) => calls.removed.push(id),
      };
    },
  };
  platform.context.tizen.application.launchAppControl = (appControl, serviceId, onSuccess, onError) => {
    calls.launches++;
    if (launch === 'error') {
      onError({ name: 'NotFoundError', message: 'The service is not running yet' });
      return;
    }
    onSuccess();
    if (launch !== 'silent') {
      listener([{ key: 'PROBE', value: answer }]);
    }
  };
  return {
    platform,
    calls,
    timers,
    answerLate: (value) => listener([{ key: 'PROBE', value }]),
    stored: () => platform.context.localStorage.getItem('smartHubSupported2'),
    legacy: () => platform.context.localStorage.getItem('smartHubSupported'),
    logs: () => platform.consoleMessages.map((message) => message.text).join('\n'),
  };
}

// Whether the promise has settled, without waiting for it
async function isSettled(promise) {
  let settled = false;
  promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

test('a failed launch of the service stores nothing, so the next start asks again', async () => {
  const probe = loadProbe('error');
  await probe.platform.get('probeSmartHubSupport')();
  assert.equal(probe.stored(), null);
  assert.equal(probe.platform.get('_isSmartHubSupported'), false);
  assert.deepEqual(probe.calls, { launches: 1, ports: 1, removed: [7] }, 'the listener of the probe is removed again');
  // The next start launches the service again
  await probe.platform.get('probeSmartHubSupport')();
  assert.equal(probe.calls.launches, 2);
});

test('a probe that throws stores nothing either', async () => {
  const probe = loadProbe('throw');
  await probe.platform.get('probeSmartHubSupport')();
  assert.equal(probe.stored(), null);
  assert.equal(probe.platform.get('_isSmartHubSupported'), false);
});

test('the answer of the service is stored and used at the next start without a probe', async () => {
  for (const [answer, expected] of [['SMART_HUB_SUPPORTED', 'true'], ['SMART_HUB_NOT_SUPPORTED', 'false']]) {
    const probe = loadProbe('answer', answer);
    await probe.platform.get('probeSmartHubSupport')();
    assert.equal(probe.stored(), expected, answer);
    assert.equal(probe.platform.get('_isSmartHubSupported'), expected === 'true', answer);
    await probe.platform.get('probeSmartHubSupport')();
    assert.equal(probe.calls.launches, 1, 'the stored answer is used');
    // The answer ended the wait, so the timeout of the probe never fires
    assert.ok(probe.timers.timers.filter((timer) => timer.delay === 5000).every((timer) => timer.cleared), answer);
  }
});

test('an answer stored by 2.1.0 or earlier is dropped, and the service is asked exactly once more', async () => {
  // 2.1.0 stored 'false' after a single failed launch, which turned the tiles off for good
  for (const [answer, expected] of [['SMART_HUB_SUPPORTED', 'true'], ['SMART_HUB_NOT_SUPPORTED', 'false']]) {
    const probe = loadProbe('answer', answer, { smartHubSupported: 'false' });
    await probe.platform.get('probeSmartHubSupport')();
    assert.equal(probe.calls.launches, 1, answer + ': the old answer is not trusted');
    assert.equal(probe.legacy(), null, answer + ': the old key is removed');
    assert.equal(probe.stored(), expected, answer);
    assert.equal(probe.platform.get('_isSmartHubSupported'), expected === 'true', answer);
    // The next start uses the new answer, also a real 'not supported'
    await probe.platform.get('probeSmartHubSupport')();
    assert.equal(probe.calls.launches, 1, answer + ': the new answer is used');
  }
});

test('Tizen 5.5 and 6.0 ask the service, later versions never start it, whatever an earlier start stored', async () => {
  for (const tizen of ['5.5', '6.0']) {
    const probe = loadProbe('answer', 'SMART_HUB_SUPPORTED', {}, { tv: 'fhd', tizen });
    await probe.platform.get('probeSmartHubSupport')();
    assert.equal(probe.calls.launches, 1, tizen);
    assert.equal(probe.platform.get('_isSmartHubSupported'), true, tizen);
  }
  for (const tv of [{ tv: 'uhd' }, { tv: '8k' }, { tv: 's90c' }, { tv: 'uhd', tizen: '7.0' }, { tv: 'uhd', tizen: '8.0' }, { tv: 'uhd', tizen: '10.0' },
    { tv: 'uhd', tizen: '10' }]) {
    // Also an answer of the service that an earlier start stored, e.g. before an update of the TV
    const probe = loadProbe('answer', 'SMART_HUB_SUPPORTED', { smartHubSupported2: 'true' }, tv);
    await probe.platform.get('probeSmartHubSupport')();
    const version = probe.platform.get('platformVer');
    assert.deepEqual(probe.calls, { launches: 0, ports: 0, removed: [] }, version + ': no message port and no launch');
    assert.equal(probe.platform.get('_isSmartHubSupported'), false, version);
    assert.ok(probe.logs().indexOf('Not starting the Smart Hub service, so no Preview tiles: Tizen ' + version +
      ' has no Preview tiles, which exist up to Tizen 6.0.') >= 0, probe.logs());
  }
});

test('a TV that reports no web services never starts the service, and one that can\'t say asks it as before', async () => {
  const noService = loadProbe('answer', 'SMART_HUB_SUPPORTED');
  noService.platform.context.tizen.systeminfo.getCapability = (key) => (key === 'http://tizen.org/feature/web.service' ? false : '5.5');
  await noService.platform.get('probeSmartHubSupport')();
  assert.equal(noService.calls.launches, 0);
  assert.equal(noService.platform.get('_isSmartHubSupported'), false);
  assert.ok(noService.logs().indexOf('Not starting the Smart Hub service, so no Preview tiles: the TV reports no web services (http://tizen.org/feature/web.service).') >= 0);

  // The feature unknown to the TV (the API throws), an answer of true, and an unreadable platform version leave the
  // decision to the service
  const unknownFeature = loadProbe('answer', 'SMART_HUB_SUPPORTED');
  unknownFeature.platform.context.tizen.systeminfo.getCapability = (key) => {
    if (key === 'http://tizen.org/feature/web.service') {
      throw new Error('NotSupportedError');
    }
    return '5.5';
  };
  await unknownFeature.platform.get('probeSmartHubSupport')();
  assert.equal(unknownFeature.calls.launches, 1);
  assert.equal(unknownFeature.platform.get('_isSmartHubSupported'), true);
  const withService = loadProbe('answer', 'SMART_HUB_SUPPORTED');
  withService.platform.context.tizen.systeminfo.getCapability = (key) => (key === 'http://tizen.org/feature/web.service' ? true : '5.5');
  await withService.platform.get('probeSmartHubSupport')();
  assert.equal(withService.calls.launches, 1);
  const unknownVersion = loadProbe('answer', 'SMART_HUB_SUPPORTED', {}, { tv: 'fhd', failApis: 'tizen.systeminfo.getCapability' });
  assert.equal(unknownVersion.platform.get('platformVer'), null);
  await unknownVersion.platform.get('probeSmartHubSupport')();
  assert.equal(unknownVersion.calls.launches, 1);
});

test('a service that never answers ends the probe after 5 seconds, and a late answer counts from the next start', async () => {
  const probe = loadProbe('silent');
  const probing = probe.platform.get('probeSmartHubSupport')();
  assert.equal(await isSettled(probing), false, 'the probe waits for the answer');
  probe.timers.run(4999);
  assert.equal(await isSettled(probing), false, 'still waiting before the 5 seconds');
  probe.timers.run(5000);
  assert.equal(await isSettled(probing), true, 'the start goes on after 5 seconds');
  assert.equal(probe.platform.get('_isSmartHubSupported'), false);
  assert.equal(probe.stored(), null, 'nothing is stored, so the next start asks again');
  assert.deepEqual(probe.calls.removed, [], 'the listener waits for a late answer');
  assert.ok(probe.logs().indexOf('The Smart Hub service did not answer the probe within 5 s, so this start has no Preview tiles and the next start asks again.') >= 0);
  // A late answer is stored for the next start, but this start keeps going without tiles
  probe.answerLate('SMART_HUB_SUPPORTED');
  assert.equal(probe.stored(), 'true');
  assert.equal(probe.platform.get('_isSmartHubSupported'), false);
  assert.deepEqual(probe.calls.removed, [7]);
  assert.ok(probe.logs().indexOf('Smart Hub support (probed after the timeout, used from the next start): true') >= 0);
  assert.equal(probe.platform.get('SMART_HUB_PROBE_TIMEOUT_MS'), 5000);
});

test('the deep links of the tiles and their appcontrol listener follow the probe, which always ends', () => {
  // handleDeepLink() runs once the probe ended and only where the tiles are supported (index.js), so a probe that never
  // ended used to leave the appcontrol listener unregistered
  const index = fs.readFileSync(path.join(REPO_ROOT, 'wasm', 'platform', 'index.js'), 'utf8');
  assert.match(index, /probeSmartHubSupport\(\)\.then\(function\(\) \{\s+\/\/ [^\n]*\n\s+handleDeepLink\(\);\s+\/\/ [^\n]*\n\s+window\.addEventListener\('appcontrol', handleDeepLink\);/);
  assert.match(index, /function handleDeepLink\(\) \{\s+if \(!_isSmartHubSupported\) \{\s+return;/);
  // The service is still declared in config.xml: the version and the feature only decide whether the app starts it
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'res', 'config.xml'), 'utf8'), /<tizen:service id="MLightS90C\.service" on-boot="true" auto-restart="true">/);
});
