'use strict';

// Checks the probe of the Smart Hub service (probeSmartHubSupport() in wasm/platform/index.js), which decides whether
// the app shows Preview tiles in Smart Hub (Tizen 5.5 to 6.5) and keeps the answer in localStorage: only a real answer
// of the service is kept. A launch of the service that fails or throws can be passing (e.g. right after the install),
// so it must not turn the tiles off for good; the next start asks again.

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SCRIPTS, loadPlatformScripts } = require('./helpers/platform-loader');

// Load index.js with a message port and a launch of the service that do what the test says: launch is 'answer' (the
// service starts and answers the probe with `answer`), 'error' (the launch fails) or 'throw' (the API throws)
function loadProbe(launch, answer) {
  const platform = loadPlatformScripts(INDEX_SCRIPTS);
  const calls = { launches: 0, removed: [] };
  let listener = null;
  platform.context.tizen.messageport = {
    requestLocalMessagePort: () => {
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
    listener([{ key: 'PROBE', value: answer }]);
  };
  return { platform, calls, stored: () => platform.context.localStorage.getItem('smartHubSupported') };
}

test('a failed launch of the service stores nothing, so the next start asks again', async () => {
  const probe = loadProbe('error');
  await probe.platform.get('probeSmartHubSupport')();
  assert.equal(probe.stored(), null);
  assert.equal(probe.platform.get('_isSmartHubSupported'), false);
  assert.deepEqual(probe.calls, { launches: 1, removed: [7] }, 'the listener of the probe is removed again');
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
  }
});
