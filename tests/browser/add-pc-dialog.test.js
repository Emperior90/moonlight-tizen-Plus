'use strict';

// Checks the Add PC dialog with the keys of the remote (addHostDialog(), getDefaultIpAddressNumbers() and
// resetIpAddressFields() in wasm/platform/index.js; Views.AddHostDialog in wasm/platform/navigation.js):
// - with the number fields, UP and DOWN on Continue and Cancel do nothing: they used to move the selection to the first
//   or second number while the button stayed highlighted, and after closing and opening two controls were highlighted
// - the numbers start from the network of the TV, e.g. 192.168.178.0 on a TV at 192.168.178.20, not from 192.168.0.0
// - Continue is disabled only while the request to the address is on its way: after a failed attempt it is enabled and
//   has the focus at once and stays so, and the address stays as it was entered. It used to turn disabled 2 seconds
//   after the press for 12 seconds, and the numbers went back to 192.168.0.0.
// - RETURN during a request closes the dialog, and the answer that comes later changes nothing
// - with the text field, DOWN goes from the address to Continue and UP from a button back to the address, and the
//   highlight moves with the selection

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./harness');
const { key, keys, menuState, openMenus, takeSnackbars } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// A TV in a network that is not 192.168.0.x, with the number fields (true) or the text field (false) for the address
const TV = { tv: 's90c', conn: 'wifi', ip: '192.168.178.20' };

const numbers = (page) => page.evaluate(() => [1, 2, 3, 4].map((n) => $('#ipAddressField' + n).val()).join('.'));
const isContinueDisabled = (page) => page.evaluate(() => $('#continueAddHost').prop('disabled') || $('#continueAddHost').hasClass('mdl-button--disabled'));
// The selection of the dialog: the item of the view, the highlighted controls and the focused one
const selection = async (page) => {
  const state = await menuState(page);
  return [state.view, state.current, state.marked, state.focused];
};

// Let every request to a PC fail after delayMs, like an address that nothing answers at, and count the requests
const failRequestsAfter = (page, delayMs) => page.evaluate((delay) => {
  window.__requests = 0;
  Module.openUrl = function(id) {
    window.__requests++;
    setTimeout(() => handlePromiseMessage(id, 'reject', -1), delay);
  };
}, delayMs);

test('number fields: they start from the network of the TV, and UP and DOWN on Continue and Cancel leave the selection there', async () => {
  const app = await openMenus(harness, { tv: TV, stored: { ipAddressFieldMode: true } });
  const { page } = app;
  try {
    await key(page, 'ok', 500);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'ipAddressField1', ['ipAddressField1'], '']);
    assert.equal(await numbers(page), '192.168.178.0');
    // RIGHT over the four numbers to Continue: DOWN and UP stay there, with the highlight, and change no number
    await keys(page, ['right', 'right', 'right', 'right'], 100);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'continueAddHost', ['continueAddHost'], 'continueAddHost']);
    await key(page, 'down', 150);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'continueAddHost', ['continueAddHost'], 'continueAddHost']);
    await key(page, 'up', 150);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'continueAddHost', ['continueAddHost'], 'continueAddHost']);
    await key(page, 'right', 150);
    await key(page, 'up', 150);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'cancelAddHost', ['cancelAddHost'], 'cancelAddHost']);
    await key(page, 'down', 150);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'cancelAddHost', ['cancelAddHost'], 'cancelAddHost']);
    assert.equal(await numbers(page), '192.168.178.0');
    // On a number, UP and DOWN change it: LEFT twice to the last number, UP three times
    await keys(page, ['left', 'left', 'up', 'up', 'up'], 100);
    assert.deepEqual((await selection(page)).slice(0, 3), ['AddHostDialog', 'ipAddressField4', ['ipAddressField4']]);
    assert.equal(await numbers(page), '192.168.178.3');
    // RETURN closes the dialog, which opens again on its first number, the only highlighted control, with the start numbers
    await key(page, 'back', 400);
    assert.equal((await menuState(page)).view, 'Hosts');
    await key(page, 'ok', 500);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'ipAddressField1', ['ipAddressField1'], '']);
    assert.equal(await numbers(page), '192.168.178.0');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('Continue is disabled only while the request is on its way, and a failed attempt keeps the address and the focus on Continue', async () => {
  const app = await openMenus(harness, { tv: TV, stored: { ipAddressFieldMode: true } });
  const { page } = app;
  try {
    await failRequestsAfter(page, 500);
    await key(page, 'ok', 500);
    // The last number to 3, then Continue
    await keys(page, ['right', 'right', 'right', 'up', 'up', 'up', 'right'], 100);
    assert.equal(await numbers(page), '192.168.178.3');
    assert.equal(await isContinueDisabled(page), false);
    await takeSnackbars(page);
    const pressedAt = Date.now();
    await key(page, 'ok', 150);
    // The request is on its way: Continue is disabled, and another OK asks nothing
    assert.equal(await isContinueDisabled(page), true);
    await key(page, 'ok', 100);
    assert.equal(await page.evaluate(() => window.__requests), 1);
    // The failure: its message, Continue enabled with the focus and the highlight, the address as it was entered
    await page.waitForFunction(() => !$('#continueAddHost').prop('disabled'), null, { timeout: 5000 });
    await page.waitForTimeout(100);
    assert.deepEqual(await takeSnackbars(page), ['Failed to connect to 192.168.178.3. Make sure that Sunshine (or another GameStream host) is running on the PC.']);
    assert.equal(await isContinueDisabled(page), false);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'continueAddHost', ['continueAddHost'], 'continueAddHost']);
    assert.equal(await numbers(page), '192.168.178.3');
    // It stays enabled: 2 seconds after the press it used to turn disabled for 12 seconds
    await page.waitForTimeout(Math.max(0, 2600 - (Date.now() - pressedAt)));
    assert.equal(await isContinueDisabled(page), false);
    // The number corrected with LEFT and UP, RIGHT back to Continue, and OK asks the corrected address
    await keys(page, ['left', 'up', 'right'], 100);
    assert.equal(await numbers(page), '192.168.178.4');
    await key(page, 'ok', 150);
    assert.equal(await page.evaluate(() => window.__requests), 2);
    assert.equal(await isContinueDisabled(page), true);
    await page.waitForFunction(() => !$('#continueAddHost').prop('disabled'), null, { timeout: 5000 });
    await page.waitForTimeout(100);
    assert.deepEqual(await takeSnackbars(page), ['Failed to connect to 192.168.178.4. Make sure that Sunshine (or another GameStream host) is running on the PC.']);
    assert.equal(await numbers(page), '192.168.178.4');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('RETURN during a request closes the dialog, and the answer that comes later changes nothing', async () => {
  // The PC of mocks/sunshine-host.js at 10.0.0.2, which is not in the PC list yet and answers after 700 ms
  const app = await openMenus(harness, { tv: TV, stored: { ipAddressFieldMode: false }, moduleScripts: ['sunshine-host.js'] });
  const { page } = app;
  try {
    await page.evaluate(() => {
      window.__sunshine.delayMs = 700;
    });
    await key(page, 'ok', 500);
    await page.evaluate(() => {
      $('#ipAddressTextInput').val('10.0.0.2');
      updateIpAddressInputValidationState();
    });
    await key(page, 'down', 150);
    await takeSnackbars(page);
    await key(page, 'ok', 150);
    assert.equal(await isContinueDisabled(page), true);
    assert.deepEqual(await page.evaluate(() => window.__sunshine.http), ['/serverinfo']);
    // RETURN: the dialog closes and the keys are on the PC list
    await key(page, 'back', 300);
    let state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs, state.current], ['Hosts', [], 'addHostContainer']);
    // The answer of the PC comes: no pairing dialog, no message, no PC in the list, and the keys stay on the PC list
    await page.waitForTimeout(1200);
    state = await menuState(page);
    assert.deepEqual([state.view, state.openDialogs, state.dialogs, state.current, state.marked], ['Hosts', [], [], 'addHostContainer', ['addHostContainer']]);
    assert.deepEqual(await takeSnackbars(page), []);
    assert.deepEqual(await page.evaluate(() => Object.keys(hosts)), []);
    // The dialog opens again with Continue enabled and an empty address
    await key(page, 'ok', 500);
    assert.equal((await menuState(page)).view, 'AddHostDialog');
    assert.equal(await isContinueDisabled(page), false);
    assert.equal(await page.evaluate(() => $('#ipAddressTextInput').val()), '');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('text field: DOWN goes to Continue and UP back to the address, with the highlight, and a failed attempt keeps the address', async () => {
  const app = await openMenus(harness, { tv: TV, stored: { ipAddressFieldMode: false } });
  const { page } = app;
  try {
    await failRequestsAfter(page, 300);
    await key(page, 'ok', 500);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'ipAddressTextInput', ['ipAddressTextInput'], 'ipAddressTextInput']);
    await key(page, 'down', 150);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'continueAddHost', ['continueAddHost'], 'continueAddHost']);
    // DOWN on a button stays there; RIGHT to Cancel, UP back to the address
    await key(page, 'down', 150);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'continueAddHost', ['continueAddHost'], 'continueAddHost']);
    await key(page, 'right', 150);
    await key(page, 'up', 150);
    assert.deepEqual(await selection(page), ['AddHostDialog', 'ipAddressTextInput', ['ipAddressTextInput'], 'ipAddressTextInput']);
    // An address that nothing answers at, as the keyboard of the TV enters it
    await page.evaluate(() => {
      $('#ipAddressTextInput').val('10.0.0.99');
      updateIpAddressInputValidationState();
    });
    await key(page, 'down', 150);
    await takeSnackbars(page);
    await key(page, 'ok', 100);
    await page.waitForFunction(() => window.__requests === 1 && !$('#continueAddHost').prop('disabled'), null, { timeout: 5000 });
    await page.waitForTimeout(100);
    assert.deepEqual(await takeSnackbars(page), ['Failed to connect to 10.0.0.99. Make sure that Sunshine (or another GameStream host) is running on the PC.']);
    assert.equal(await page.evaluate(() => $('#ipAddressTextInput').val()), '10.0.0.99');
    assert.deepEqual(await selection(page), ['AddHostDialog', 'continueAddHost', ['continueAddHost'], 'continueAddHost']);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
