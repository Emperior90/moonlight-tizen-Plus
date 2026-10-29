'use strict';

// Checks how the connection error dialog shows the message of a connection stage that failed (the 'DialogMsg: ' of
// ClStageFailed() in wasm/connectionlistener.cpp, handleMessage() in wasm/platform/messages.js) in the real page: the
// port hint after the blank line of the message is a paragraph of its own, below the error, and not joined to it with
// a space, which the dialog did when it got the line breaks as they are (its text is HTML, where a line break is white
// space), and no line ends between a protocol and its port. tests/unit/connection-ports.test.js checks the texts and
// their translation.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, startHarness } = require('./harness');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

const ERROR_LINE = 'RTSP handshake failed (error 110)';
const PORT_HINT = 'Check that the firewall of the host PC and your router don\'t block these ports: TCP 48010, UDP 48000, UDP 48010';
// The hint as the dialog shows it: each protocol joined to its port with a no-break space
const SHOWN_HINT = PORT_HINT.replace(/(TCP|UDP) /g, '$1\u00a0');

// What the dialog shows: its title, its text as the TV renders it (innerText), and where each text node of the text
// starts and ends on the screen
const dialogState = (page) => page.evaluate(() => {
  const text = document.getElementById('warningDialogText');
  const nodes = Array.prototype.filter.call(text.childNodes, (node) => node.nodeType === Node.TEXT_NODE).map((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return { text: node.textContent, top: rect.top, bottom: rect.bottom };
  });
  return {
    open: document.getElementById('warningDialog').open,
    title: document.getElementById('warningDialogTitle').textContent,
    lines: text.innerText.split('\n'),
    nodes,
    lineHeight: parseFloat(getComputedStyle(text).fontSize),
    // The number of lines that each protocol and its port take, e.g. 'TCP 48010'
    ports: (text.textContent.match(/(TCP|UDP)\u00a0\d+/g) || []).map((port) => {
      const node = Array.prototype.find.call(text.childNodes, (child) => child.nodeType === Node.TEXT_NODE && child.textContent.indexOf(port) >= 0);
      const range = document.createRange();
      range.setStart(node, node.textContent.indexOf(port));
      range.setEnd(node, node.textContent.indexOf(port) + port.length);
      return new Set(Array.prototype.map.call(range.getClientRects(), (rect) => Math.round(rect.top))).size;
    }),
  };
});

test('the port hint of a failed stage shows as a paragraph of its own below the error', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate((message) => handleMessage(message), 'DialogMsg: ' + ERROR_LINE + '\n\n' + PORT_HINT);
    const state = await dialogState(app.page);
    assert.equal(state.open, true);
    assert.equal(state.title, 'Connection Error');
    // The error, a blank line and the hint, not one line with both
    assert.deepEqual(state.lines, [ERROR_LINE, '', SHOWN_HINT]);
    assert.deepEqual(state.nodes.map((node) => node.text), [ERROR_LINE, SHOWN_HINT]);
    // The hint starts below the error, with the height of the blank line in between
    const [error, hint] = state.nodes;
    assert.ok(hint.top - error.bottom >= state.lineHeight * 0.8, JSON.stringify(state.nodes));
    // The hint takes two lines, and each protocol stays on the line of its port
    assert.ok(hint.bottom - hint.top > state.lineHeight * 1.5, JSON.stringify(state.nodes));
    assert.deepEqual(state.ports, [1, 1, 1]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('a dialog message shows its characters as text, and a message without ports as one paragraph', async () => {
  const app = await openApp(harness, { tv: { tv: 's90c', conn: 'wifi' } });
  try {
    await app.page.evaluate(() => handleMessage('DialogMsg: video stream establishment failed (error -1)'));
    let state = await dialogState(app.page);
    assert.deepEqual(state.lines, ['video stream establishment failed (error -1)']);
    await app.page.evaluate(() => $('#closeWarning').click());

    // A message of the module that contains markup characters shows them, instead of the page reading them as HTML
    await app.page.evaluate(() => handleMessage('DialogMsg: Host error <b>5</b> & more'));
    state = await dialogState(app.page);
    assert.deepEqual(state.lines, ['Host error <b>5</b> & more']);
    assert.equal(await app.page.evaluate(() => document.querySelector('#warningDialogText b')), null);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
