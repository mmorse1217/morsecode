'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFluidSolver, createPlaybackDriver } = require('../assets/ascii-flow-fluid.js');

// Substitute only the system clock/frame scheduler, not the numerical solver.
function createManualClock(workPerRead = 0) {
  let timestamp = 1000, workTime = 0, nextId = 0;
  const pending = new Map();
  return {
    now() { workTime += workPerRead; return workTime; },
    requestFrame(callback) {
      const id = ++nextId;
      pending.set(id, callback);
      return id;
    },
    cancelFrame(id) { pending.delete(id); },
    advance(milliseconds) {
      timestamp += milliseconds;
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(timestamp);
    },
    pendingFrames() { return pending.size; }
  };
}

function createStillFluid() {
  return createFluidSolver({ nx: 16, ny: 16, Lx: 1, Ly: 1, initialTracers: [0] });
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should equal ${expected}`);
}

test('playback advances real solver state at the requested model-time speed', () => {
  const clock = createManualClock(), fluid = createStillFluid();
  const errors = [];
  let draws = 0;
  const playback = createPlaybackDriver({
    clock,
    draw() { draws++; },
    onError(error) { errors.push(error); },
    reportSpeedLimit() {}
  });
  playback.configure({ fluid, speed: 0.2, paused: false });
  clock.advance(0); // The first frame establishes a timestamp; it never steps.
  for (let i = 0; i < 20; i++) clock.advance(50);
  near(fluid.view().time, 0.2);
  assert.equal(draws, 21);
  assert.equal(clock.pendingFrames(), 1, 'only one loop should own playback');
  assert.deepEqual(errors, []);
  playback.destroy();
  assert.equal(clock.pendingFrames(), 0);
});

test('overload is reported at common display refresh rates', () => {
  for (const hz of [60, 120, 144]) {
    const clock = createManualClock(10), reports = [];
    const playback = createPlaybackDriver({
      clock, draw() {}, onError: assert.fail, reportSpeedLimit(value) { reports.push(value); }
    });
    playback.configure({ fluid: createStillFluid(), speed: 2.5, paused: false });
    clock.advance(0);
    for (let i = 0; i < hz * 5; i++) clock.advance(1000 / hz);
    assert.ok(reports.includes(true), `expected overload report at ${hz} Hz`);
    playback.destroy();
  }
});

test('invalid speeds cannot replace a valid running playback configuration', () => {
  const clock = createManualClock(), fluid = createStillFluid();
  const playback = createPlaybackDriver({ clock, draw() {}, onError: assert.fail, reportSpeedLimit() {} });
  playback.configure({ fluid, speed: 0.2, paused: false });
  clock.advance(0);
  for (const speed of [NaN, Infinity, -0.1]) {
    assert.throws(() => playback.configure({ fluid, speed, paused: false }), /speed/i);
  }
  for (let i = 0; i < 20; i++) clock.advance(50);
  near(fluid.view().time, 0.2);
  assert.equal(clock.pendingFrames(), 1);
  playback.destroy();
});

test('pauses and zero speed discard inactive time without starting extra loops', () => {
  const clock = createManualClock(), fluid = createStillFluid();
  const playback = createPlaybackDriver({ clock, draw() {}, onError: assert.fail, reportSpeedLimit() {} });
  const state = { fluid, speed: 0.9, paused: false };
  playback.configure(state);
  playback.configure(state);
  assert.equal(clock.pendingFrames(), 1);
  clock.advance(0);
  clock.advance(50);
  near(fluid.view().time, 1 / 30);
  playback.configure({ ...state, paused: true });
  assert.equal(clock.pendingFrames(), 0);
  clock.advance(600000);
  playback.configure(state);
  clock.advance(0);
  near(fluid.view().time, 1 / 30);
  clock.advance(50);
  near(fluid.view().time, 2 / 30);
  playback.configure({ ...state, speed: 0 });
  clock.advance(600000);
  near(fluid.view().time, 2 / 30);
  assert.equal(clock.pendingFrames(), 0);
  playback.destroy();
});

test('a new model or zero-size removal never inherits another model’s backlog', () => {
  const clock = createManualClock(), first = createStillFluid(), second = createStillFluid();
  const playback = createPlaybackDriver({ clock, draw() {}, onError: assert.fail, reportSpeedLimit() {} });
  playback.configure({ fluid: first, speed: 0.9, paused: false });
  clock.advance(0);
  clock.advance(50);
  playback.configure({ fluid: second, speed: 0.9, paused: false });
  clock.advance(400);
  near(second.view().time, 0);
  clock.advance(50);
  near(second.view().time, 1 / 30);
  near(first.view().time, 1 / 30);
  playback.configure({ fluid: null, speed: 0.9, paused: false });
  assert.equal(clock.pendingFrames(), 0);
  playback.destroy();
});

test('playback caps drawn frames while continuing to accumulate active wall time', () => {
  const clock = createManualClock(), fluid = createStillFluid();
  let draws = 0;
  const playback = createPlaybackDriver({ clock, draw() { draws++; }, onError: assert.fail, reportSpeedLimit() {} });
  playback.configure({ fluid, speed: 1, paused: false });
  clock.advance(0);
  clock.advance(20);
  clock.advance(20);
  assert.equal(draws, 1, 'callbacks before the frame interval should not draw');
  clock.advance(10);
  assert.equal(draws, 2);
  near(fluid.view().time, 1 / 30);
  playback.destroy();
});

test('a tight work budget still allows one safe step and discards whole-step backlog', () => {
  const clock = createManualClock(7), fluid = createStillFluid();
  const playback = createPlaybackDriver({ clock, draw() {}, onError: assert.fail, reportSpeedLimit() {} });
  playback.configure({ fluid, speed: 2.5, paused: false });
  clock.advance(0);
  clock.advance(400);
  near(fluid.view().time, 1 / 30);
  clock.advance(50);
  near(fluid.view().time, 2 / 30);
  playback.destroy();
});

test('the eight-substep cap applies even when the work clock has budget left', () => {
  const clock = createManualClock();
  // At u=4 on a 16² unit domain the tracer CFL limit is 0.00703125.
  // Eight stable steps advance 0.05625 model-time units, not the full backlog.
  const fluid = createFluidSolver({ nx: 16, ny: 16, Lx: 1, Ly: 1,
    initialVelocity: { u: 4, v: 0 }, initialTracers: [0] });
  const playback = createPlaybackDriver({ clock, draw() {}, onError: assert.fail, reportSpeedLimit() {} });
  playback.configure({ fluid, speed: 2.5, paused: false });
  clock.advance(0);
  clock.advance(100);
  near(fluid.view().time, 0.05625);
  clock.advance(100);
  near(fluid.view().time, 0.1125);
  playback.destroy();
});

test('speed reporting includes discarded foreground time and resets without stepping', () => {
  const clock = createManualClock(), fluid = createStillFluid(), reports = [];
  const playback = createPlaybackDriver({
    clock, draw() {}, onError: assert.fail,
    reportSpeedLimit(limited) { reports.push(limited); }
  });
  playback.configure({ fluid, speed: 2.5, paused: false });
  clock.advance(0);
  for (let i = 0; i < 7; i++) clock.advance(400);
  assert.equal(reports.at(-1), false, 'wait for a full reporting window');
  clock.advance(400);
  assert.equal(reports.at(-1), true, 'compare actual model time to all requested active time');
  near(fluid.view().time, 1.6);
  playback.resetRate();
  assert.equal(reports.at(-1), false);
  near(fluid.view().time, 1.6);
  playback.configure({ fluid, speed: 0.2, paused: false });
  assert.equal(reports.at(-1), false);
  playback.destroy();
});

test('solver failures stop playback once without publishing state or allowing restart', () => {
  const clock = createManualClock(), errors = [];
  let invalid = false;
  const fluid = createFluidSolver({ nx: 16, ny: 16, Lx: 1, Ly: 1,
    forcing(time, fx) { if (invalid) fx[0] = NaN; }, initialTracers: [0] });
  const playback = createPlaybackDriver({ clock, draw() {},
    onError(error) { errors.push(error); }, reportSpeedLimit() {} });
  const state = { fluid, speed: 0.9, paused: false };
  playback.configure(state);
  clock.advance(0);
  clock.advance(50);
  const before = fluid.view().time;
  invalid = true;
  clock.advance(50);
  assert.equal(errors.length, 1);
  assert.equal(clock.pendingFrames(), 0);
  near(fluid.view().time, before);
  playback.configure(state);
  clock.advance(600000);
  assert.equal(errors.length, 1);
  assert.equal(clock.pendingFrames(), 0);
  near(fluid.view().time, before);
});
