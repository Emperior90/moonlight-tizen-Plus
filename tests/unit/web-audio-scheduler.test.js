'use strict';

// Checks the scheduler of the Web Audio backend (wasm/platform/audio.js, 2.3.5), which plays the frames that the module
// decodes: _audReceiveFrame() schedules each frame right after the one before it at a lead of the jitter buffer target
// over the clock of the audio context, _audBuildBuffer() copies it out of the heap of the module and resamples it when
// the context runs at another rate, and _audSteerClock() (Audio clock sync) steers the ratio so that the lead stays at
// the target while the clocks of the PC and the TV drift apart. It runs here on a simulated AudioContext whose clock the
// test moves: frames of 240 samples (5 ms at 48 kHz, a stride of 256 in the heap) arrive at the rate of the host, from
// 1 s on (a real context is past 0 when the stream starts).
// - back to back at 48 kHz and at 44.1 kHz, the first frame at the target, without underruns and drops
// - at the plain ratio the samples pass unchanged, and the resampler keeps a sine a sine across the frames
// - a stall of the main thread is an underrun with a new schedule at the target; a long gap of the host audio isn't
// - the clock sync follows a drift of 200 ppm within its limit of 500 ppm and keeps the lead at the target; a drift of
//   1000 ppm holds it at exactly that limit, and the lead then moves by the rest of the drift; without it, a fast host
//   makes the scheduler drop frames, which keeps the lead bounded
// - the end of the scheduler, a suspended context and frames that never reached the scheduler

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlatformScripts } = require('./helpers/platform-loader');

const SAMPLES = 240;
const STRIDE = 256;
const HOST_RATE = 48000;
const TARGET = 0.1;

// A simulated audio context and the scheduler loaded against it. options: clockSync, state ('running' or 'suspended')
function setup(contextRate, options) {
  const opts = options || {};
  const env = { now: 1.0, state: opts.state || 'running', starts: [], closed: 0, resumed: 0, sequence: 0 };
  class FakeAudioContext {
    constructor() {
      this.sampleRate = contextRate;
      this.baseLatency = 0.01;
      this.outputLatency = 0;
      this.destination = { maxChannelCount: 2 };
    }
    get state() {
      return env.state;
    }
    get currentTime() {
      return env.now;
    }
    createBuffer(channels, length, rate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: (channel) => data[channel] };
    }
    createBufferSource() {
      const source = {
        buffer: null,
        connect() {},
        start(when) {
          env.starts.push({ when, now: env.now, buffer: source.buffer });
        },
      };
      return source;
    }
    resume() {
      env.resumed++;
    }
    close() {
      env.closed++;
    }
  }
  // Date.now() decides when a line of statistics is logged and its counters start over: it stands still here, so that
  // the counters cover the whole simulation however long it takes
  class FrozenDate extends Date {
    static now() {
      return 0;
    }
  }
  env.heap = new Float32Array(4 * STRIDE);
  env.app = loadPlatformScripts(['wasm/platform/audio.js'], {
    globals: { AudioContext: FakeAudioContext, Module: { HEAPF32: env.heap }, performance: { now: () => env.now * 1000 }, Date: FrozenDate },
  });
  env.app.context._mlAudioClockSync = !!opts.clockSync;
  env.app.get('startAudioScheduler')();
  env.receive = env.app.get('_audReceiveFrame');
  env.stats = () => env.app.get('_audStats');
  env.session = () => env.app.get('_audSession');
  return env;
}

// Frames for `seconds` of the host's clock, `ppm` faster than the TV's (negative: slower), from the time of the context
// on. fill(sampleIndex, channel) gives the samples; onFrame() runs after each frame.
function feed(env, seconds, ppm, fill, onFrame) {
  const period = SAMPLES / HOST_RATE / (1 + (ppm || 0) * 1e-6);
  const start = env.now;
  const count = Math.round(seconds / period);
  for (let i = 0; i < count; i++) {
    env.now = start + i * period;
    frame(env, fill ? (s, c) => fill(i * SAMPLES + s, c) : null, i === 0 ? 0 : period * 1000);
    if (onFrame) {
      onFrame(i);
    }
  }
  env.now = start + count * period;
  return count;
}

// One frame at the current time of the context, with the given gap since the previous packet on the audio thread
function frame(env, fill, arrivalGapMs) {
  for (let channel = 0; channel < 2; channel++) {
    for (let s = 0; s < SAMPLES; s++) {
      env.heap[channel * STRIDE + s] = fill ? fill(s, channel) : 0.25;
    }
  }
  env.receive(0, SAMPLES, 2, HOST_RATE, STRIDE, env.sequence++, arrivalGapMs);
}

// The output of one channel, all scheduled frames after each other
const output = (env, channel) => {
  const out = [];
  env.starts.forEach((start) => out.push(...start.buffer.getChannelData(channel)));
  return out;
};

test('the frames play back to back from the jitter buffer target on, at 48 kHz and resampled to 44.1 kHz', () => {
  for (const rate of [48000, 44100]) {
    const env = setup(rate);
    const frames = feed(env, 2, 0, (i) => Math.sin(i / 10));
    assert.equal(env.starts.length, frames, rate + ': every frame scheduled');
    assert.ok(Math.abs(env.starts[0].when - (1.0 + TARGET)) < 1e-12, rate + ': the first at the target: ' + env.starts[0].when);
    env.starts.slice(1).forEach((start, k) => {
      const previous = env.starts[k];
      assert.ok(Math.abs(start.when - (previous.when + previous.buffer.duration)) < 1e-9, `${rate}: frame ${k + 1} starts where frame ${k} ends`);
      assert.equal(start.buffer.sampleRate, rate);
    });
    const stats = env.stats();
    assert.deepEqual([stats.resyncs, stats.underruns, stats.droppedFull, stats.droppedEmpty, stats.droppedCatchUp, stats.decoderGaps],
      [1, 0, 0, 0, 0, 0], rate + ': ' + JSON.stringify(stats));
    // 2 s of sound at the rate of the context, less the two samples that the resampler holds back
    const total = env.starts.reduce((sum, start) => sum + start.buffer.length, 0);
    assert.ok(Math.abs(total - 2 * rate) <= 3, rate + ': ' + total + ' samples');
  }
});

test('at the plain ratio the samples pass through unchanged', () => {
  const env = setup(48000);
  const value = (i, channel) => Math.fround(Math.sin(i * 0.37) * 0.8 + channel * 0.1);
  feed(env, 0.5, 0, value);
  for (let channel = 0; channel < 2; channel++) {
    const out = output(env, channel);
    assert.equal(out.length, 0.5 * 48000);
    out.forEach((sample, i) => assert.equal(sample, value(i, channel), `channel ${channel}, sample ${i}`));
  }
});

test('the resampler keeps a sine a sine across the frame boundaries', () => {
  const env = setup(44100);
  const frequency = 1000;
  feed(env, 1, 0, (i) => Math.sin(2 * Math.PI * frequency * i / HOST_RATE));
  const out = output(env, 0);
  const ratio = HOST_RATE / 44100;
  let worst = 0;
  // From the fifth output sample on: the first ones read the silence before the stream
  for (let j = 4; j < out.length; j++) {
    worst = Math.max(worst, Math.abs(out[j] - Math.sin(2 * Math.PI * frequency * j * ratio / HOST_RATE)));
  }
  assert.ok(worst < 1e-3, 'worst error ' + worst);
});

test('a stall of the main thread is an underrun, and the next frame starts a new schedule at the target', () => {
  const env = setup(48000);
  feed(env, 1, 0);
  assert.deepEqual([env.stats().underruns, env.stats().resyncs], [0, 1]);
  // The main thread stood still for 300 ms while the packets kept arriving on the audio thread every 5 ms
  env.now += 0.3;
  const scheduled = env.starts.length;
  frame(env, null, 5);
  assert.deepEqual([env.stats().underruns, env.stats().resyncs, env.session().underruns], [1, 2, 1]);
  assert.equal(env.starts.length, scheduled + 1);
  assert.ok(Math.abs(env.starts[scheduled].when - (env.now + TARGET)) < 1e-12);
});

test('Audio clock sync follows a drift of 200 ppm within 500 ppm and keeps the lead at the target', () => {
  for (const ppm of [200, -200]) {
    const env = setup(48000, { clockSync: true });
    let worstCorrection = 0;
    feed(env, 60, ppm, null, () => {
      worstCorrection = Math.max(worstCorrection, Math.abs(env.app.get('_audCorrection')));
    });
    assert.ok(worstCorrection <= 500e-6 + 1e-12, ppm + ': correction ' + worstCorrection);
    const correction = env.app.get('_audCorrection') * 1e6;
    assert.ok(Math.abs(correction - ppm) <= 0.1 * Math.abs(ppm), ppm + ': the correction ends at ' + correction.toFixed(1) + ' ppm');
    // The lead of each frame before it is scheduled
    env.starts.forEach((start, k) => {
      assert.ok(Math.abs(start.when - start.now - TARGET) <= 0.003, `${ppm}: frame ${k} at a lead of ${((start.when - start.now) * 1000).toFixed(2)} ms`);
    });
    const stats = env.stats();
    assert.deepEqual([stats.droppedFull, stats.droppedEmpty, stats.underruns, stats.resyncs], [0, 0, 0, 1], ppm + ': ' + JSON.stringify(stats));
  }
});

test('Audio clock sync stops at its limit of 500 ppm against a drift of 1000 ppm, and the lead moves by the rest', () => {
  for (const ppm of [1000, -1000]) {
    const env = setup(48000, { clockSync: true });
    const limit = Math.sign(ppm) * 500e-6;
    const period = SAMPLES / HOST_RATE / (1 + ppm * 1e-6);
    let worstCorrection = 0;
    let unlimitedAfter10s = 0;
    let leadAt10s = null;
    feed(env, 30, ppm, null, (i) => {
      const correction = env.app.get('_audCorrection');
      worstCorrection = Math.max(worstCorrection, Math.abs(correction));
      // The correction reaches the limit within about 7 s, and stays there while the drift is larger
      if (i * period >= 10) {
        if (correction !== limit) {
          unlimitedAfter10s++;
        }
        if (leadAt10s === null) {
          const last = env.starts[env.starts.length - 1];
          leadAt10s = last.when - last.now;
        }
      }
    });
    assert.equal(worstCorrection, 500e-6, ppm + ': the largest correction');
    assert.equal(env.app.get('_audCorrection'), limit, ppm + ': the correction at the end');
    assert.equal(unlimitedAfter10s, 0, ppm + ': frames after 10 s without the correction at its limit');
    // The 500 ppm that the correction can't take move the lead by 0.5 ms per second, 10 ms from 10 s to 30 s
    const last = env.starts[env.starts.length - 1];
    const moved = (last.when - last.now - leadAt10s) * 1000;
    assert.ok(Math.abs(moved - Math.sign(ppm) * 10) <= 1, ppm + ': the lead moved by ' + moved.toFixed(2) + ' ms from 10 s on');
    const stats = env.stats();
    assert.deepEqual([stats.droppedFull, stats.droppedEmpty, stats.underruns, stats.resyncs], [0, 0, 0, 1], ppm + ': ' + JSON.stringify(stats));
  }
});

test('without the clock sync, a fast host makes the scheduler drop frames, which keeps the lead bounded', () => {
  const env = setup(48000, { clockSync: false });
  feed(env, 60, 2000);
  const stats = env.stats();
  assert.ok(stats.droppedFull > 0, JSON.stringify(stats));
  assert.equal(stats.underruns, 0);
  const frameSeconds = SAMPLES / HOST_RATE;
  env.starts.forEach((start, k) => {
    assert.ok(start.when - start.now <= 1.5 * TARGET + frameSeconds + 1e-9, `frame ${k} at a lead of ${((start.when - start.now) * 1000).toFixed(2)} ms`);
  });
  assert.equal(env.app.get('_audCorrection'), 0, 'no correction without the clock sync');
});

test('the end of the scheduler closes the context once, and later frames schedule nothing', () => {
  const env = setup(48000);
  feed(env, 0.1, 0);
  const scheduled = env.starts.length;
  env.app.get('stopAudioScheduler')();
  assert.equal(env.closed, 1);
  frame(env, null, 5);
  frame(env, null, 5);
  assert.equal(env.starts.length, scheduled);
  env.app.get('stopAudioScheduler')();
  assert.equal(env.closed, 1, 'a second stop has nothing to close');
});

test('a suspended context is resumed, schedules nothing, and the first frame once it runs starts the schedule', () => {
  const env = setup(48000, { state: 'suspended' });
  frame(env, null, 0);
  env.now += 0.005;
  frame(env, null, 5);
  assert.deepEqual([env.stats().notRunning, env.session().notRunning, env.resumed, env.starts.length], [2, 2, 2, 0]);
  env.state = 'running';
  env.now += 0.005;
  frame(env, null, 5);
  assert.equal(env.starts.length, 1);
  assert.ok(Math.abs(env.starts[0].when - (env.now + TARGET)) < 1e-12);
  assert.deepEqual([env.stats().resyncs, env.stats().underruns], [1, 0]);
});

test('frames that never reached the scheduler count as gaps, and a long pause of the host audio is no underrun', () => {
  const env = setup(48000);
  env.sequence = 10;
  frame(env, null, 0);
  env.sequence = 13;
  env.now += 0.005;
  frame(env, null, 5);
  assert.deepEqual([env.stats().decoderGaps, env.session().decoderGaps], [2, 2]);
  // The host sent nothing for longer than twice the target and 250 ms: the schedule ran dry without sound missing
  env.now += 0.3;
  frame(env, null, 300);
  assert.deepEqual([env.stats().underruns, env.stats().resyncs], [0, 2]);
  // A shorter gap of the host audio still is one
  env.now += 0.3;
  frame(env, null, 240);
  assert.deepEqual([env.stats().underruns, env.stats().resyncs], [1, 3]);
});
