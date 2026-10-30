'use strict';

// Pins the stored button mapping of wasm/platform/button_mapping.js: the earlier switches 'Flip A/B face buttons' and
// 'Flip X/Y face buttons' as the mapping for every controller (the text that tests/native/gamepad_harness.h gives the
// native tests for them), the id of a controller as the stream sees it (63 bytes of UTF-8), a stored value that can't be
// read, a change of a button for every controller or for one, the targets that LEFT and RIGHT step through, a reset, the
// calibration of the sticks from what they reported at rest and at their edge, and the text for the stream, which
// tests/native/controller_mapping_test.cpp reads back from tests/fixtures/button-mappings.txt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../lib/dev-modules');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

function loadMapping() {
  return loadPlatformScripts(['wasm/platform/button_mapping.js'], { globals: { t: (text) => text } });
}

const IDENTITY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const PAD_ID = '8BitDo SN30 Pro (Vendor: 2dc8 Product: 6101)';

test('the earlier face button swaps become the mapping for every controller', () => {
  const app = loadMapping();
  const migrate = app.get('migrateFaceButtonSwaps');
  const serialize = app.get('serializeButtonMappings');
  assert.deepEqual(plain(migrate(false, false)), { version: 1, controllers: {} });
  assert.equal(serialize(migrate(false, false)), '');
  assert.deepEqual(plain(migrate(true, false)).controllers['*'].buttons, [1, 0].concat(IDENTITY.slice(2)));
  assert.deepEqual(plain(migrate(false, true)).controllers['*'].buttons, [0, 1, 3, 2].concat(IDENTITY.slice(4)));
  // The same text as FaceButtonSwapMapping() of tests/native/gamepad_harness.h, with which the native tests of the swaps
  // still run
  assert.equal(serialize(migrate(true, true)), '1,0,3,2,4,5,6,7,8,9,10,11,12,13,14,15;;*');
});

test('the id of a controller as the stream sees it: 63 bytes of UTF-8, cut before a character that doesn\'t fit', () => {
  const id = loadMapping().get('streamControllerId');
  assert.equal(id(XBOX_ID), 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product');
  assert.equal(id(PAD_ID), PAD_ID);
  assert.equal(id(''), '');
  assert.equal(id(null), '');
  // 61 ASCII bytes and a 3-byte character don't fit into 63 bytes; with 60 they do
  assert.equal(id('a'.repeat(61) + '€x'), 'a'.repeat(61));
  assert.equal(id('a'.repeat(60) + '€x'), 'a'.repeat(60) + '€');
  // A character outside the BMP is 4 bytes and 2 UTF-16 units
  assert.equal(id('a'.repeat(59) + '😀b'), 'a'.repeat(59) + '😀');
  assert.equal(id('a'.repeat(60) + '😀b'), 'a'.repeat(60));
});

test('a stored value keeps only what can be read', () => {
  const normalize = loadMapping().get('normalizeButtonMappings');
  for (const broken of [null, undefined, 'text', 42, {}, { controllers: null }, { controllers: 'x' }]) {
    assert.deepEqual(plain(normalize(broken)), { version: 1, controllers: {} }, JSON.stringify(broken));
  }
  const stick = { centreX: 0, centreY: 0.1, minX: -0.7, maxX: 0.7, minY: -0.6, maxY: 0.8 };
  const stored = {
    version: 1,
    controllers: {
      '*': { buttons: [1, 0].concat(IDENTITY.slice(2)), sticks: [stick, stick] },
      'too short': { buttons: [0, 1, 2] },
      'out of range': { buttons: [16].concat(IDENTITY.slice(1)) },
      'a fraction': { buttons: [0.5].concat(IDENTITY.slice(1)) },
      'a line\nbreak': { buttons: IDENTITY },
      'bad sticks': { sticks: [{ centreX: 0, centreY: 0, minX: -0.1, maxX: 0.1, minY: -1, maxY: 1 }, null] },
      [PAD_ID]: { name: '8BitDo SN30 Pro', buttons: [-1].concat(IDENTITY.slice(1)), sticks: [null, stick] },
    },
  };
  assert.deepEqual(plain(normalize(stored)), {
    version: 1,
    controllers: {
      // The mapping for every controller has no calibration: the sticks of each controller differ
      '*': { name: '', buttons: [1, 0].concat(IDENTITY.slice(2)) },
      [PAD_ID]: { name: '8BitDo SN30 Pro', buttons: [-1].concat(IDENTITY.slice(1)), sticks: [null, stick] },
    },
  });
});

test('a button of every controller or of one presses another one, and a reset forgets it', () => {
  const app = loadMapping();
  const set = app.get('setMappedButton');
  const get = app.get('getMappingButtons');
  const reset = app.get('resetControllerMapping');
  const empty = app.get('emptyButtonMappings')();
  // A for every controller presses B
  const all = set(empty, '*', '', 0, 1);
  assert.deepEqual(plain(get(all, XBOX_ID)), [1].concat(IDENTITY.slice(1)));
  // A controller starts from the buttons of every controller, and keeps its name
  const own = set(all, PAD_ID, '8BitDo SN30 Pro', 3, -1);
  assert.deepEqual(plain(own.controllers[PAD_ID]), { name: '8BitDo SN30 Pro', buttons: [1, 1, 2, -1].concat(IDENTITY.slice(4)) });
  assert.deepEqual(plain(get(own, XBOX_ID)), [1].concat(IDENTITY.slice(1)));
  // The mapping for every controller goes once each button presses itself again
  assert.deepEqual(plain(set(all, '*', '', 0, 0)).controllers, {});
  // A reset forgets the buttons and the calibration of a controller
  const calibrated = app.get('setStickCalibration')(own, PAD_ID, '8BitDo SN30 Pro',
    [{ centreX: 0, centreY: 0, minX: -0.8, maxX: 0.8, minY: -0.8, maxY: 0.8 }, null]);
  assert.ok(calibrated.controllers[PAD_ID].sticks);
  assert.deepEqual(plain(reset(calibrated, PAD_ID)).controllers, { '*': { name: '', buttons: [1].concat(IDENTITY.slice(1)) } });
  assert.deepEqual(plain(reset(all, '*')).controllers, {});
  // The changes return copies and leave the mapping they started from as it was
  assert.deepEqual(plain(empty), { version: 1, controllers: {} });
});

test('LEFT and RIGHT step through the 16 buttons of the standard layout and None', () => {
  const step = loadMapping().get('stepMappedButton');
  assert.equal(step(0, 1), 1);
  assert.equal(step(15, 1), -1);
  assert.equal(step(-1, 1), 0);
  assert.equal(step(0, -1), -1);
  assert.equal(step(-1, -1), 15);
  let target = 0;
  const seen = [];
  for (let i = 0; i < 17; i++) {
    seen.push(target);
    target = step(target, 1);
  }
  assert.deepEqual(seen, IDENTITY.concat([-1]));
  assert.equal(target, 0);
});

test('the calibration of the sticks: the centre at rest and the ends they reached, or none for too little range', () => {
  const compute = loadMapping().get('computeStickCalibration');
  const rest = [[0.04, -0.02, 0.0, 0.1], [0.06, -0.04, 0.0, 0.1]];
  const move = [[-0.9, 0, -0.1, 0.1], [0.92, 0, 0.1, 0.1], [0, -0.88, 0.1, 0.0], [0, 0.95, 0, 0.2]];
  const sticks = plain(compute(rest, move));
  assert.deepEqual(sticks[0], { centreX: 0.05, centreY: -0.03, minX: -0.9, maxX: 0.92, minY: -0.88, maxY: 0.95 });
  // The right stick barely moved, so it gets no calibration
  assert.equal(sticks[1], null);
  // A centre far off makes none either, and neither do missing readings
  assert.deepEqual(plain(compute([[0.6, 0, 0, 0]], [[-1, -1, -1, -1], [1, 1, 1, 1]])), [null, { centreX: 0, centreY: 0, minX: -1, maxX: 1, minY: -1, maxY: 1 }]);
  assert.deepEqual(plain(compute([], move)), [null, null]);
  assert.deepEqual(plain(compute(rest, [])), [null, null]);
});

test('the moves of a calibration are kept as their range, so a calibration left open for long neither grows nor fails', () => {
  const app = loadMapping();
  const add = app.get('addStickRangeReading');
  const compute = app.get('computeStickCalibration');
  const rest = [[0.04, -0.02, 0.0, 0.1], [0.06, -0.04, 0.0, 0.1]];
  const edge = [[-0.9, 0, -0.95, 0.1], [0.92, 0, 0.95, 0.1], [0, -0.88, 0, -0.9], [0, 0.95, 0, 0.9]];
  // 300,000 readings, about 100 minutes of polls every 20 ms: the range stays four numbers per axis
  let range = app.get('newStickRange')();
  for (let i = 0; i < 300000; i++) {
    range = add(range, edge[i % 4]);
  }
  assert.deepEqual(plain(range), { count: 300000, min: [-0.9, -0.88, -0.95, -0.9], max: [0.92, 0.95, 0.95, 0.9], last: [0, 0.95, 0, 0.9] });
  const expected = [{ centreX: 0.05, centreY: -0.03, minX: -0.9, maxX: 0.92, minY: -0.88, maxY: 0.95 },
    { centreX: 0, centreY: 0.1, minX: -0.95, maxX: 0.95, minY: -0.9, maxY: 0.9 }];
  assert.deepEqual(plain(compute(rest, range)), expected);
  // A list of as many readings gives the same, without the RangeError of Math.min.apply() over a long list
  const many = Array.from({ length: 300000 }, (value, i) => edge[i % 4]);
  assert.deepEqual(plain(compute(rest, many)), expected);
  // An empty range is no calibration, and a value that isn't a number counts as 0
  assert.deepEqual(plain(compute(rest, app.get('newStickRange')())), [null, null]);
  assert.deepEqual(plain(add(app.get('newStickRange')(), ['x', null, 0.5, undefined])), { count: 1, min: [0, 0, 0.5, 0], max: [0, 0, 0.5, 0], last: [0, 0, 0.5, 0] });
});

test('the text for the stream is the one of the fixture that the native side reads', () => {
  const app = loadMapping();
  const stored = {
    version: 1,
    controllers: {
      '*': { name: '', buttons: [1, 0].concat(IDENTITY.slice(2)) },
      'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product': {
        name: 'Xbox Wireless Controller',
        buttons: IDENTITY.slice(0, 14).concat([15, 14]),
        sticks: [{ centreX: 0.05, centreY: -0.02, minX: -0.9, maxX: 0.88, minY: -0.92, maxY: 0.95 }, null],
      },
      [PAD_ID]: { name: '8BitDo SN30 Pro', sticks: [null, { centreX: 0, centreY: 0.1, minX: -0.7, maxX: 0.7, minY: -0.6, maxY: 0.8 }] },
    },
  };
  const fixture = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/button-mappings.txt'), 'utf8')
    .split('\n').filter((line) => line && line[0] !== '#').join('\n');
  assert.equal(app.get('serializeButtonMappings')(stored), fixture);
  // Without a change there is no text, so the stream maps nothing
  assert.equal(app.get('serializeButtonMappings')(app.get('emptyButtonMappings')()), '');
});
