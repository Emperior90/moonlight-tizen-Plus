'use strict';

// Measures how fast the selection follows a key, in the app list of a PC (a grid of 60 apps, whose steps also fill the
// hero and scroll the rows) and in a list of the settings (the rows of the Advanced Settings), for the arrow keys of
// the remote (remoteControllerHandler() in wasm/platform/remote_controller.js) and for the D-pad of a gamepad that the
// real polling of wasm/platform/gamepad.js reads (handleGamepadMenuInput() in wasm/platform/index.js):
// - a single press moves the selection by one step, at once
// - two presses 150 ms apart both move it
// - a held key or D-pad repeats: every repeat of the remote moves, the D-pad repeats after 350 ms every 100 ms, and the
//   selection stops with the release
// - two presses of the D-pad, 150 ms and 250 ms apart, both move it when the page was busy while the D-pad was released
//   (a TV that takes that long to draw the step of the first press): the page reads the gamepads late then, and used to
//   take the second press for a bounce of the first one (DPAD_BOUNCE_GUARD in index.js, lateBy of gamepad.js)
// The times are taken in the page, from the key event (or from the change of the gamepad state that the next poll
// reads) to the moved highlight, and to the first frame after it. The limits are fixed (see below): the typical step
// (the median) must be fast and no step may take long, so a navigation that waits before a step, drops a press or runs
// on after the release fails here, while one late frame of a busy machine does not. This is the speed of the app on a
// desktop machine; how fast the TV draws a step is not measured.

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { SUNSHINE_HOSTS, startHarness } = require('./harness');
const { PAD, key, menuState, openMenus, openSettingsSection, selectItem } = require('./menu-driver');

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  if (harness) {
    await harness.close();
  }
});

// The limits, in ms. Measured on a desktop machine: 1 to 17 ms from a key of the remote to the frame, 10 to 31 ms from
// a D-pad press, a first repeat of the D-pad after 361 to 368 ms and the next ones every 102 to 117 ms (up to 107 ms
// for a single step of the remote and 143 ms between two repeats while three other test files ran). The limits of the
// typical step are below what a wait before a step would add (the stick waits 150 ms).
const LIMITS = {
  // The typical step: from a key of the remote to the moved highlight (the handler runs in the key event) and to the
  // first frame after it; from a D-pad press, which the next read of the gamepads sees (every 16 ms) and moves right away
  keyToMark: 30,
  keyToFrame: 50,
  padToMark: 60,
  padToFrame: 80,
  // Any single step
  slowestStep: 250,
  // The D-pad repeats 350 ms after the press, every 100 ms (the repeat runs in animation frames, so up to a frame
  // later): the first repeat, the typical time between two repeats, and the steps of a D-pad held for 2 seconds
  padFirstRepeat: [330, 500],
  padRepeatGap: [95, 130],
  padStepsIn2s: [14, 18],
};

const KEYS = { up: [38, 'ArrowUp'], down: [40, 'ArrowDown'], left: [37, 'ArrowLeft'], right: [39, 'ArrowRight'] };

// Runs in the page: record every move of the highlight (an element that gets the class 'hovered') with its time and
// the time of the first frame after it, and offer the key and gamepad sequences, timed in the page
function installProbe() {
  const probe = window.__speed = { inputs: [], moves: [], reads: [] };
  // What the menus got from the gamepads, for the message of a failed check: the time, the buttons that changed and by
  // how much the read came late
  window.addEventListener('gamepadinputchanged', (event) => {
    probe.isPadUnread = false;
    probe.reads.push(Math.round(performance.now()) + ' ms: ' + event.detail.changes.map((change) => (change.pressed ? 'pressed' : 'released')).join(', ') +
      (event.detail.lateBy ? ', read ' + Math.round(event.detail.lateBy) + ' ms late' : ''));
  });
  new MutationObserver((records) => {
    const at = performance.now();
    records.forEach((record) => {
      const wasMarked = (' ' + (record.oldValue || '') + ' ').indexOf(' hovered ') >= 0;
      if (!wasMarked && record.target.classList.contains('hovered')) {
        const move = { id: record.target.id, at, shownAt: null };
        probe.moves.push(move);
        requestAnimationFrame(() => {
          move.shownAt = performance.now();
        });
      }
    });
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });

  const keyEvent = (type, code, name, repeat) => {
    const event = new KeyboardEvent(type, { key: name, repeat: !!repeat, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: code });
    Object.defineProperty(event, 'which', { value: code });
    if (type === 'keydown') {
      probe.inputs.push({ at: performance.now(), repeat: !!repeat });
    }
    (document.activeElement || document.body).dispatchEvent(event);
  };
  const padButton = (button, pressed) => {
    probe.padChangedAt = performance.now();
    probe.isPadUnread = true;
    if (pressed) {
      probe.inputs.push({ at: probe.padChangedAt, repeat: false });
    }
    window.__padButton(button, pressed);
  };
  // Run the steps [time in ms, action] at their times after now, then wait settleMs and resolve with what was recorded
  // and the time of the last step (the release). The page of a busy machine can stand still for longer than a button
  // is held, and the app would be measured with a press that it could not see. So a step that ran late moves the ones
  // after it (each keeps its distance to the step before it), and a change of the gamepad waits until the menus read
  // the one before it (they read every 16 ms; given up after a second): every press and release reaches the app.
  const run = (steps, settleMs) => new Promise((resolve) => {
    probe.inputs = [];
    probe.moves = [];
    probe.reads = [];
    const start = performance.now();
    let index = 0;
    let ranAt = 0;
    let releasedAt = 0;
    const next = () => {
      if (index === steps.length) {
        setTimeout(() => resolve({ inputs: probe.inputs, moves: probe.moves, reads: probe.reads, releasedAt }), settleMs);
        return;
      }
      const due = index === 0 ? start + steps[0][0] : Math.max(start + steps[index][0], ranAt + steps[index][0] - steps[index - 1][0]);
      const wait = due - performance.now();
      if (wait > 0.5) {
        setTimeout(next, wait);
        return;
      }
      if (probe.isPadUnread && performance.now() - probe.padChangedAt < 1000) {
        setTimeout(next, 2);
        return;
      }
      ranAt = performance.now();
      steps[index][1]();
      releasedAt = performance.now();
      index++;
      next();
    };
    next();
  });

  // Presses of a key of the remote at the given times, each released 40 ms later
  probe.pressKey = (code, name, times) => run([].concat.apply([], times.map((time) => [
    [time, () => keyEvent('keydown', code, name, false)], [time + 40, () => keyEvent('keyup', code, name, false)]])), 300);
  // A key of the remote held for holdMs: the remote repeats it after firstRepeatMs every repeatMs
  probe.holdKey = (code, name, holdMs, firstRepeatMs, repeatMs) => {
    const steps = [[0, () => keyEvent('keydown', code, name, false)]];
    for (let time = firstRepeatMs; time < holdMs; time += repeatMs) {
      steps.push([time, () => keyEvent('keydown', code, name, true)]);
    }
    steps.push([holdMs, () => keyEvent('keyup', code, name, false)]);
    return run(steps, 400);
  };
  // Presses of a gamepad button at the given times, each held for holdMs
  probe.pressPad = (button, times, holdMs) => run([].concat.apply([], times.map((time) => [
    [time, () => padButton(button, true)], [time + holdMs, () => padButton(button, false)]])), holdMs >= 1000 ? 400 : 300);
  // Two presses of a gamepad button, gapMs from press to press, the first one held for 60 ms, with a page that is busy
  // from 30 ms after the first press until 10 ms before the second one: the button is released while the page can't
  // read the gamepads, as on a TV that needs that long to draw the step of the first press. The second press comes
  // once the page has read the release, which is 16 ms or 32 ms before it reads that press.
  probe.pressPadWhileBusy = (button, gapMs) => run([
    [0, () => padButton(button, true)],
    [30, () => {
      const busyFor = (ms) => {
        const end = performance.now() + ms;
        while (performance.now() < end) { /* The page is busy */ }
      };
      busyFor(30);
      padButton(button, false);
      busyFor(gapMs - 70);
    }],
    [gapMs, () => padButton(button, true)], [gapMs + 60, () => padButton(button, false)]], 300);
}

// The times of the moves of a run, each from the last input before it
function latencies(result) {
  return result.moves.map((move) => {
    const input = result.inputs.filter((entry) => entry.at <= move.at).pop();
    return {
      toMark: input ? move.at - input.at : Infinity,
      toFrame: input && move.shownAt !== null ? move.shownAt - input.at : Infinity,
    };
  });
}

const rounded = (values) => values.map((value) => Math.round(value));
// The typical value: the median, the lower one of the two middle values
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];

// The checks that every list gets, with the key of the remote and the button of the D-pad that move its selection on
async function checkList(t, page, label, remoteKey, padButton) {
  const moved = (result) => result.moves.map((move) => move.id);
  // Each step selects another item than the step before it (the rows of the settings go around the end of their list)
  const isMovingOn = (result) => moved(result).every((id, i, ids) => id !== '' && id !== ids[i - 1]);
  // Every press moved the selection once (all but `dropped` of them at most), the typical step within its limits and no
  // step slower than the slowest allowed
  const assertWithin = (result, markLimit, frameLimit, what, dropped) => {
    const times = latencies(result);
    const toMark = times.map((time) => time.toMark);
    const toFrame = times.map((time) => time.toFrame);
    assert.ok(result.moves.length <= result.inputs.length && result.moves.length >= result.inputs.length - (dropped || 0), label + ', ' + what +
      ': ' + result.inputs.length + ' presses moved the selection ' + result.moves.length + ' times');
    assert.ok(isMovingOn(result), label + ', ' + what + ': every step selects another item, ' + moved(result).join(', '));
    assert.ok(median(toMark) <= markLimit, label + ', ' + what + ': the highlight typically moved after ' + Math.round(median(toMark)) +
      ' ms (limit ' + markLimit + ' ms), all: ' + rounded(toMark).join(', '));
    assert.ok(median(toFrame) <= frameLimit, label + ', ' + what + ': a step was typically on the screen after ' + Math.round(median(toFrame)) +
      ' ms (limit ' + frameLimit + ' ms), all: ' + rounded(toFrame).join(', '));
    assert.ok(Math.max.apply(null, toFrame) <= LIMITS.slowestStep, label + ', ' + what + ': the slowest step was on the screen after ' +
      Math.round(Math.max.apply(null, toFrame)) + ' ms (limit ' + LIMITS.slowestStep + ' ms), all: ' + rounded(toFrame).join(', '));
    return times;
  };
  const report = {};

  // The remote: five single presses 250 ms apart
  let result = await page.evaluate(([code, name]) => window.__speed.pressKey(code, name, [0, 250, 500, 750, 1000]), KEYS[remoteKey]);
  report.remoteSingle = rounded(assertWithin(result, LIMITS.keyToMark, LIMITS.keyToFrame, 'single presses of the remote').map((time) => time.toFrame));
  // Two presses 150 ms apart
  result = await page.evaluate(([code, name]) => window.__speed.pressKey(code, name, [0, 150]), KEYS[remoteKey]);
  report.remoteDouble = rounded(assertWithin(result, LIMITS.keyToMark, LIMITS.keyToFrame, 'two presses of the remote 150 ms apart').map((time) => time.toFrame));
  // Held for 2 seconds: the remote repeats after 400 ms every 100 ms, 17 key events in all. The app drops a repeat that
  // came before the step before it was on the screen (remote_controller.js), which a late frame of a busy machine can
  // cause once or twice; a navigation that can't keep up drops many.
  result = await page.evaluate(([code, name]) => window.__speed.holdKey(code, name, 2000, 400, 100), KEYS[remoteKey]);
  assert.equal(result.inputs.length, 17);
  report.remoteHold = rounded(assertWithin(result, LIMITS.keyToMark, LIMITS.keyToFrame, 'a held key of the remote', 2).map((time) => time.toFrame));
  assert.equal(result.moves.filter((move) => move.at > result.releasedAt).length, 0, label + ': the selection stops with the release of the key');

  // The D-pad of the gamepad: five single presses of 60 ms, 250 ms apart
  result = await page.evaluate(([button]) => window.__speed.pressPad(button, [0, 250, 500, 750, 1000], 60), [PAD[padButton]]);
  report.padSingle = rounded(assertWithin(result, LIMITS.padToMark, LIMITS.padToFrame, 'single presses of the D-pad').map((time) => time.toFrame));
  // Two presses 150 ms apart
  result = await page.evaluate(([button]) => window.__speed.pressPad(button, [0, 150], 60), [PAD[padButton]]);
  report.padDouble = rounded(assertWithin(result, LIMITS.padToMark, LIMITS.padToFrame, 'two presses of the D-pad 150 ms apart').map((time) => time.toFrame));
  // Two presses 150 ms and 250 ms apart with a page that is busy in between, where the D-pad is released: both move.
  // The release that the page sees late, just before the second press, used to make that press a bounce of the first.
  for (const gapMs of [150, 250]) {
    result = await page.evaluate(([button, gap]) => window.__speed.pressPadWhileBusy(button, gap), [PAD[padButton], gapMs]);
    assert.equal(result.moves.length, 2, label + ', two presses of the D-pad ' + gapMs + ' ms apart with a busy page in between: 2 presses moved the selection ' +
      result.moves.length + ' times. Pressed at ' + rounded(result.inputs.map((input) => input.at)).join(' and ') + ' ms, moved at ' +
      rounded(result.moves.map((move) => move.at)).join(', ') + ' ms, the menus got: ' + result.reads.join('; '));
    assert.ok(isMovingOn(result), label + ': every step selects another item, ' + moved(result).join(', '));
    // The second press, which the page was free for, moves as fast as any other
    const second = latencies(result)[1];
    assert.ok(second.toMark <= LIMITS.slowestStep, label + ': the press after the busy page moved the highlight after ' + Math.round(second.toMark) + ' ms');
    report['padBusy' + gapMs] = Math.round(second.toFrame);
  }
  // Held for 2 seconds: the first step at once, the repeats after 350 ms every 100 ms
  result = await page.evaluate(([button]) => window.__speed.pressPad(button, [0], 2000), [PAD[padButton]]);
  const pressedAt = result.inputs[0].at;
  const steps = result.moves.map((move) => move.at - pressedAt);
  const gaps = steps.slice(2).map((step, i) => step - steps[i + 1]);
  report.padHold = { steps: steps.length, firstRepeat: Math.round(steps[1]), gaps: rounded(gaps) };
  assert.ok(steps[0] <= LIMITS.slowestStep, label + ': the held D-pad moved the highlight after ' + Math.round(steps[0]) + ' ms');
  assert.ok(steps[1] >= LIMITS.padFirstRepeat[0] && steps[1] <= LIMITS.padFirstRepeat[1],
    label + ': the held D-pad repeated first after ' + Math.round(steps[1]) + ' ms (limits ' + LIMITS.padFirstRepeat.join(' to ') + ' ms)');
  assert.ok(median(gaps) >= LIMITS.padRepeatGap[0] && median(gaps) <= LIMITS.padRepeatGap[1], label + ': the held D-pad typically repeated every ' +
    Math.round(median(gaps)) + ' ms (limits ' + LIMITS.padRepeatGap.join(' to ') + ' ms), all: ' + rounded(gaps).join(', '));
  assert.ok(Math.max.apply(null, gaps) <= LIMITS.slowestStep, label + ': the longest time between two repeats of the held D-pad was ' +
    Math.round(Math.max.apply(null, gaps)) + ' ms (limit ' + LIMITS.slowestStep + ' ms)');
  assert.ok(steps.length >= LIMITS.padStepsIn2s[0] && steps.length <= LIMITS.padStepsIn2s[1], label + ': the D-pad held for 2 s made ' +
    steps.length + ' steps (limits ' + LIMITS.padStepsIn2s.join(' to ') + ')');
  assert.ok(isMovingOn(result), label + ': every step of the held D-pad selects another item, ' + moved(result).join(', '));
  // A repeat may still run until the next read of the gamepads sees the release
  assert.equal(result.moves.filter((move) => move.at > result.releasedAt + LIMITS.padToMark).length, 0,
    label + ': the selection stops with the release of the D-pad');
  // Kept in the test output: the times to the frame of each step, in ms
  t.diagnostic(label + ': ' + JSON.stringify(report));
}

test('app list: the selection follows the remote and the D-pad at once, for single presses, two presses 150 ms apart and a held key', async (t) => {
  // 60 apps in rows of six, on the PC of mocks/sunshine-host.js
  const apps = Array.from({ length: 60 }, (unused, i) => ({ id: 200 + i, title: 'Game ' + String(i + 1).padStart(2, '0') }));
  const app = await openMenus(harness, {
    moduleScripts: ['sunshine-host.js'], stored: { hosts: SUNSHINE_HOSTS, sortAppsList: 'host' }, pad: true,
    initScripts: ['window.__sunshineConfig = { apps: ' + JSON.stringify(apps) + ' };'],
  });
  const { page } = app;
  try {
    await page.waitForFunction(() => typeof hosts !== 'undefined' && hosts.HOST1 && hosts.HOST1.online === true, null, { timeout: 10000 });
    await selectItem(page, 'Hosts', 'host-container-HOST1', 'left', 'right');
    await key(page, 'ok', 0);
    await page.waitForFunction(() => document.body.getAttribute('data-view') === 'apps' && $('#game-grid .game-container').length === 60 &&
      !$('#wasmSpinner').is(':visible'), null, { timeout: 5000 });
    await page.waitForTimeout(600);
    const state = await menuState(page);
    assert.deepEqual([state.view, state.marked.length], ['Apps', 1]);
    await page.evaluate(installProbe);
    // RIGHT through the grid, over the ends of its rows: 24 steps with the remote, then up to 25 with the D-pad
    await checkList(t, page, 'app list', 'right', 'RIGHT');
    assert.equal((await menuState(page)).view, 'Apps');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});

test('settings: the selection follows the remote and the D-pad at once, for single presses, two presses 150 ms apart and a held key', async (t) => {
  const app = await openMenus(harness, { pad: true });
  const { page } = app;
  try {
    await openSettingsSection(page, 'advancedSettings');
    const state = await menuState(page);
    assert.deepEqual([state.view, state.marked.length], ['AdvancedSettings', 1]);
    await page.evaluate(installProbe);
    // DOWN through the eight rows, around the end of the list, with the remote and then with the D-pad
    await checkList(t, page, 'settings', 'down', 'DOWN');
    assert.equal((await menuState(page)).view, 'AdvancedSettings');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.context.close();
  }
});
