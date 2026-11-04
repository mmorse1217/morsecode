'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fft1D, createPeriodicPoissonSolver, createFluidSolver, createDefaultFluid, createStreamlineField } = require('../assets/ascii-flow-fluid.js');

function near(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test('FFT transforms a known real signal and reconstructs it', () => {
  const real = Float64Array.from([1, 2, 3, 4]);
  const imag = new Float64Array(4);
  fft1D(real, imag, false);
  [10, -2, -2, -2].forEach((value, i) => near(real[i], value));
  [0, 2, 0, -2].forEach((value, i) => near(imag[i], value));
  fft1D(real, imag, true);
  [1, 2, 3, 4].forEach((value, i) => { near(real[i], value); near(imag[i], 0); });
});

test('FFT agrees with an independent direct transform of complex signals', () => {
  for (const n of [4, 8]) {
    const originalReal = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.3) + i / 7);
    const originalImag = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.7));
    const real = originalReal.slice(), imag = originalImag.slice();
    fft1D(real, imag, false);
    for (let k = 0; k < n; k++) {
      let expectedReal = 0, expectedImag = 0;
      for (let j = 0; j < n; j++) {
        const angle = -2 * Math.PI * k * j / n;
        expectedReal += originalReal[j] * Math.cos(angle) - originalImag[j] * Math.sin(angle);
        expectedImag += originalReal[j] * Math.sin(angle) + originalImag[j] * Math.cos(angle);
      }
      near(real[k], expectedReal); near(imag[k], expectedImag);
    }
    fft1D(real, imag, true);
    for (let i = 0; i < n; i++) { near(real[i], originalReal[i]); near(imag[i], originalImag[i]); }
  }
});

test('periodic Poisson solve recovers a rectangular Fourier mode and zero gauge', () => {
  const nx = 32, ny = 16, dx = 2 / nx, dy = 1 / ny;
  const rhs = new Float64Array(nx * ny), pressure = new Float64Array(rhs.length);
  const eigenvalue = -4 * (Math.sin(Math.PI / nx) ** 2 / dx ** 2 + Math.sin(2 * Math.PI / ny) ** 2 / dy ** 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    rhs[j * nx + i] = Math.sin(2 * Math.PI * i / nx) * Math.cos(4 * Math.PI * j / ny);
  }
  const original = rhs.slice(), solver = createPeriodicPoissonSolver(nx, ny, dx, dy);
  solver.solve(rhs, pressure);
  let mean = 0;
  for (let i = 0; i < rhs.length; i++) { near(pressure[i], rhs[i] / eigenvalue); mean += pressure[i]; }
  near(mean / rhs.length, 0);
  assert.deepEqual(rhs, original, 'RHS is not mutated');
  rhs.fill(0); solver.solve(rhs, pressure);
  assert.ok(pressure.every(value => value === 0));
  rhs.fill(1);
  assert.throws(() => solver.solve(rhs, pressure), /mean|compatib/i);
});

test('periodic Poisson solve handles a Nyquist mode and its discrete residual', () => {
  const nx = 16, ny = 32, dx = 1 / nx, dy = 2 / ny;
  const rhs = Float64Array.from({ length: nx * ny }, (_, k) => ((k % nx + Math.floor(k / nx)) % 2 ? -1 : 1));
  const output = new Float64Array(rhs.length), solver = createPeriodicPoissonSolver(nx, ny, dx, dy);
  solver.solve(rhs, output);
  const eigenvalue = -4 * (1 / dx ** 2 + 1 / dy ** 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, at = (x, y) => output[((y + ny) % ny) * nx + ((x + nx) % nx)];
    near(output[k], rhs[k] / eigenvalue);
    const residual = (at(i + 1, j) - 2 * output[k] + at(i - 1, j)) / dx ** 2 +
      (at(i, j + 1) - 2 * output[k] + at(i, j - 1)) / dy ** 2 - rhs[k];
    near(residual, 0, 1e-9);
  }
});

test('Poisson solve rejects overlapping input/output buffers', () => {
  const backing = new Float64Array(257), rhs = backing.subarray(0, 256), out = backing.subarray(1, 257);
  const solver = createPeriodicPoissonSolver(16, 16, 1 / 16, 1 / 16);
  assert.throws(() => solver.solve(rhs, out), /buffers/i);
});

test('numerical grids reject finite but unrepresentable spacing', () => {
  for (const spacing of [Number.MIN_VALUE, 1e-200, 1e200, Number.MAX_VALUE]) {
    assert.throws(() => createPeriodicPoissonSolver(16, 16, spacing, 1), RangeError);
    assert.throws(() => createFluidSolver({ nx: 16, ny: 16, Lx: spacing, Ly: 1 }), RangeError);
  }
});

test('Poisson solver rejects grids beyond the documented resource limits', () => {
  assert.throws(() => createPeriodicPoissonSolver(256, 16, 1, 1), /grid/i);
  assert.throws(() => createPeriodicPoissonSolver(128, 128, 1, 1), /grid/i);
});

test('fluid samples constant velocity and tracer across periodic boundaries', () => {
  const fluid = createFluidSolver({ nx: 16, ny: 16, Lx: 2, Ly: 1,
    initialVelocity: { u: 1.25, v: -0.5 }, initialTracers: [0.2, 0.3] });
  const out = { tracers: new Float64Array(2) };
  for (const [x, y] of [[0.1, 0.2], [-1.9, -0.8], [2.1, 1.2]]) {
    fluid.sample(x, y, out);
    near(out.u, 1.25); near(out.v, -0.5); near(out.tracers[0], 0.2); near(out.tracers[1], 0.3);
  }
  assert.equal(fluid.view().time, 0);
});

test('sampling honors staggered face offsets and wraps Fourier fields', () => {
  const n = 16, dx = 1 / n;
  const fluid = createFluidSolver({ nx: n, ny: n, Lx: 1, Ly: 1,
    initialVelocity: { u: (x, y) => Math.sin(2 * Math.PI * y), v: (x, y) => Math.cos(2 * Math.PI * x) },
    initialTracers: [(x, y) => 1 + 0.2 * Math.sin(2 * Math.PI * x) * Math.cos(2 * Math.PI * y)] });
  const out = { tracers: new Float64Array(1) }, i = 5, j = 4;
  fluid.sample(i * dx, (j + 0.5) * dx, out);
  near(out.u, Math.sin(2 * Math.PI * (j + 0.5) * dx));
  fluid.sample((i + 0.5) * dx, j * dx, out);
  near(out.v, Math.cos(2 * Math.PI * (i + 0.5) * dx));
  const x = (i + 0.5) * dx, y = (j + 0.5) * dx;
  fluid.sample(x, y, out);
  const value = out.tracers[0];
  near(value, 1 + 0.2 * Math.sin(2 * Math.PI * x) * Math.cos(2 * Math.PI * y));
  fluid.sample(x - 1, y + 1, out);
  near(out.tracers[0], value);
});

test('renderer can sample tracer and velocity separately without changing state', () => {
  const fluid = createDefaultFluid(320, 720), whole = { tracers: new Float64Array(2) };
  const split = { tracers: new Float64Array(2) };
  fluid.sample(0.23, 0.72, whole);
  fluid.sampleTracers(0.23, 0.72, split);
  fluid.sampleVelocity(0.23, 0.72, split);
  near(split.u, whole.u); near(split.v, whole.v);
  near(split.tracers[0], whole.tracers[0]); near(split.tracers[1], whole.tracers[1]);
  assert.equal(fluid.view().time, 0);
});

test('fixed-grid velocity and tracer samples equal direct samples across buffer swaps', () => {
  for (const [width, height] of [[800, 450], [450, 800], [600, 600]]) {
    const fluid = createDefaultFluid(width, height), initial = fluid.view();
    const xs = [-initial.Lx - 0.1, 0, initial.dx / 2, 0.27, initial.Lx, 2 * initial.Lx + 0.13];
    const ys = [-initial.Ly - 0.2, 0, initial.dy / 2, 0.38, initial.Ly, 2 * initial.Ly + 0.17];
    const cached = fluid.prepareSamplingGrid(xs, ys);
    const expected = { tracers: new Float64Array(2) }, actual = { tracers: new Float64Array(2) };
    for (let step = 0; step < 4; step++) {
      for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) {
        fluid.sample(xs[i], ys[j], expected);
        cached.sampleVelocity(i, j, actual);
        cached.sampleTracers(i, j, actual);
        assert.deepEqual(actual, expected);
      }
      fluid.step(fluid.stableStepLimit());
    }
  }
});

test('streamline field reconstructs the simulated velocity including mean flow', () => {
  const nx = 32, ny = 16, Lx = 2, Ly = 1, dx = Lx / nx, dy = Ly / ny;
  const stream = (i, j) => 0.02 * Math.sin(2 * Math.PI * i / nx) * Math.sin(2 * Math.PI * j / ny);
  const u = new Float64Array(nx * ny), v = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    u[j * nx + i] = 0.17 + (stream(i, j + 1) - stream(i, j)) / dy;
    v[j * nx + i] = -0.08 - (stream(i + 1, j) - stream(i, j)) / dx;
  }
  const fluid = createFluidSolver({ nx, ny, Lx, Ly, initialVelocity: { u, v }, initialTracers: [0] });
  const state = fluid.view(), lines = createStreamlineField(state);
  lines.update(state);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = i * dx, y = j * dy, value = lines.sample(x, y);
    near(value, stream(i, j) + 0.17 * y + 0.08 * x, 1e-10);
    near((lines.sample(x, y + dy) - value) / dy, state.u[j * nx + i], 1e-9);
    near(-(lines.sample(x + dx, y) - value) / dx, state.v[j * nx + i], 1e-9);
  }
  assert.equal(fluid.view().time, 0, 'deriving streamlines must not advance the solver');
});

test('fixed-grid streamline samples equal direct samples including mean flow and updates', () => {
  const fluid = createFluidSolver({ nx: 16, ny: 32, Lx: 1, Ly: 2,
    initialVelocity: { u: (x, y) => 0.07 + 0.02 * Math.sin(Math.PI * y), v: -0.03 },
    forcing(time, fx, fy) { fx.fill(0.01); fy.fill(-0.02); } });
  const lines = createStreamlineField(fluid.view());
  const xs = [-1.2, 0, 0.41, 1, 2.3], ys = [-2.4, 0, 0.37, 2, 4.6];
  const cached = lines.prepareSamplingGrid(xs, ys);
  for (let step = 0; step < 4; step++) {
    lines.update(fluid.view());
    for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) {
      assert.equal(cached.sample(i, j), lines.sample(xs[i], ys[j]));
    }
    fluid.step(0.02);
  }
});

test('fixed-grid caches own their coordinates and reject invalid coordinate lists', () => {
  const fluid = createDefaultFluid(800, 450), lines = createStreamlineField(fluid.view());
  lines.update(fluid.view());
  const xs = [0.23], ys = [0.37], expected = { tracers: new Float64Array(2) };
  fluid.sample(xs[0], ys[0], expected);
  const expectedStreamline = lines.sample(xs[0], ys[0]);
  const cached = fluid.prepareSamplingGrid(xs, ys), cachedLines = lines.prepareSamplingGrid(xs, ys);
  xs[0] = NaN; ys[0] = NaN;
  const actual = { tracers: new Float64Array(2) };
  cached.sampleVelocity(0, 0, actual); cached.sampleTracers(0, 0, actual);
  assert.deepEqual(actual, expected);
  assert.equal(cachedLines.sample(0, 0), expectedStreamline);
  assert.throws(() => fluid.prepareSamplingGrid([], [0]), /sampling/i);
  assert.throws(() => fluid.prepareSamplingGrid([0], [NaN]), /sampling/i);
  assert.throws(() => lines.prepareSamplingGrid([Infinity], [0]), /sampling/i);
});

test('streamlines change with velocity, not merely time or tracer injection', () => {
  const options = { nx: 16, ny: 16, Lx: 1, Ly: 1, initialTracers: [0],
    tracerSources(time, fields) { fields[0].fill(0.1); } };
  const still = createFluidSolver(options), stillLines = createStreamlineField(still.view());
  stillLines.update(still.view());
  const initial = stillLines.sample(0.23, 0.31);
  for (let i = 0; i < 10; i++) still.step(0.02);
  stillLines.update(still.view());
  near(stillLines.sample(0.23, 0.31), initial);
  assert.ok(still.view().tracers[0][0] > 0, 'tracer actually changed');

  const moving = createFluidSolver({ ...options, forcing(time, fx) {
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
      fx[j * 16 + i] = Math.sin(2 * Math.PI * (j + 0.5) / 16);
    }
  } });
  const movingLines = createStreamlineField(moving.view());
  movingLines.update(moving.view());
  const before = movingLines.sample(0.23, 0.31);
  moving.step(0.02);
  movingLines.update(moving.view());
  assert.ok(Math.abs(movingLines.sample(0.23, 0.31) - before) > 1e-4,
    'a changing velocity field must change the derived streamline geometry');
});

test('pressure projection removes a discrete gradient force on wide and tall grids', () => {
  for (const [nx, ny] of [[32, 32], [64, 32], [32, 64]]) {
    const dx = 2 / nx, dy = 1 / ny;
    const p = (i, j) => Math.sin(2 * Math.PI * (i + 0.5) / nx) * Math.cos(2 * Math.PI * (j + 0.5) / ny);
    const fluid = createFluidSolver({ nx, ny, Lx: 2, Ly: 1, initialTracers: [0],
      forcing(time, fx, fy) {
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          fx[j * nx + i] = (p(i, j) - p(i - 1, j)) / dx;
          fy[j * nx + i] = (p(i, j) - p(i, j - 1)) / dy;
        }
      }
    });
    fluid.step(0.02);
    const state = fluid.view();
    assert.equal(state.time, 0.02);
    for (let k = 0; k < nx * ny; k++) { near(state.u[k], 0, 1e-9); near(state.v[k], 0, 1e-9); }
  }
});

test('projection preserves a divergence-free force while removing its gradient component', () => {
  const nx = 32, ny = 16, dx = 2 / nx, dy = 1 / ny, h = 0.02;
  const pressure = (i, j) => Math.cos(2 * Math.PI * (i + 0.5) / nx) * Math.sin(2 * Math.PI * (j + 0.5) / ny);
  const stream = (i, j) => Math.sin(2 * Math.PI * i / nx) * Math.sin(2 * Math.PI * j / ny);
  const rotationalU = (i, j) => (stream(i, j + 1) - stream(i, j)) / dy;
  const rotationalV = (i, j) => -(stream(i + 1, j) - stream(i, j)) / dx;
  const fluid = createFluidSolver({ nx, ny, Lx: 2, Ly: 1, initialTracers: [0], forcing(time, fx, fy) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      fx[j * nx + i] = rotationalU(i, j) + (pressure(i, j) - pressure(i - 1, j)) / dx;
      fy[j * nx + i] = rotationalV(i, j) + (pressure(i, j) - pressure(i, j - 1)) / dy;
    }
  } });
  fluid.step(h);
  const state = fluid.view();
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    near(state.u[j * nx + i], h * rotationalU(i, j), 1e-9);
    near(state.v[j * nx + i], h * rotationalV(i, j), 1e-9);
  }
});

test('viscous Taylor–Green flow converges toward the analytical solution', () => {
  function error(n) {
    const L = 2 * Math.PI, viscosity = 0.1;
    const fluid = createFluidSolver({ nx: n, ny: n, Lx: L, Ly: L, viscosity, initialTracers: [0],
      initialVelocity: { u: (x, y) => Math.sin(x) * Math.cos(y), v: (x, y) => -Math.cos(x) * Math.sin(y) } });
    let previousEnergy = Infinity;
    while (fluid.view().time < 1 - 1e-12) {
      fluid.step(Math.min(fluid.stableStepLimit(), 1 - fluid.view().time));
      const state = fluid.view();
      let energy = 0;
      for (let k = 0; k < n * n; k++) energy += state.u[k] ** 2 + state.v[k] ** 2;
      assert.ok(energy <= previousEnergy + 1e-8, 'viscous vortex energy should decrease');
      previousEnergy = energy;
    }
    const { u, v, dx, dy } = fluid.view(), amplitude = Math.exp(-2 * viscosity);
    let squaredError = 0, squaredReference = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const exactU = amplitude * Math.sin(i * dx) * Math.cos((j + 0.5) * dy);
      const exactV = -amplitude * Math.cos((i + 0.5) * dx) * Math.sin(j * dy);
      squaredError += (u[j * n + i] - exactU) ** 2 + (v[j * n + i] - exactV) ** 2;
      squaredReference += exactU ** 2 + exactV ** 2;
    }
    return Math.sqrt(squaredError / squaredReference);
  }
  const coarse = error(32), fine = error(64);
  assert.ok(fine < 0.1, `64² error ${fine} must be below 10%`);
  assert.ok(fine < 0.8 * coarse, `refinement should improve: ${coarse} -> ${fine}`);
});

test('upwind tracer moves conservatively through a periodic face', () => {
  const n = 16, tracer = new Float64Array(n * n);
  for (let j = 0; j < n; j++) tracer[j * n + n - 1] = 1;
  const fluid = createFluidSolver({ nx: n, ny: n, Lx: 1, Ly: 1,
    initialVelocity: { u: 1, v: 0 }, initialTracers: [tracer] });
  fluid.step(0.025); // 0.4 cell widths at u=1
  const result = fluid.view().tracers[0];
  for (let j = 0; j < n; j++) {
    near(result[j * n + n - 1], 0.6);
    near(result[j * n], 0.4);
  }
  near(result.reduce((sum, value) => sum + value, 0), n);
});

test('constant source and decay match the analytical reaction solution', () => {
  const source = 0.1, decay = 0.2, initial = 0.3;
  const fluid = createFluidSolver({ nx: 16, ny: 16, Lx: 1, Ly: 1, tracerDecay: decay,
    initialTracers: [initial], tracerSources(time, fields) { fields[0].fill(source); } });
  for (let i = 0; i < 10; i++) fluid.step(0.02);
  const expected = initial * Math.exp(-decay * 0.2) + source / decay * (1 - Math.exp(-decay * 0.2));
  for (const value of fluid.view().tracers[0]) near(value, expected);
});

test('periodic tracer diffusion follows a sinusoidal analytical decay', () => {
  const n = 32, kappa = 0.01, end = 0.25;
  const fluid = createFluidSolver({ nx: n, ny: n, Lx: 1, Ly: 1, tracerDiffusivity: kappa,
    initialTracers: [(x) => 0.5 + 0.25 * Math.sin(2 * Math.PI * x)] });
  while (fluid.view().time < end - 1e-12) fluid.step(Math.min(fluid.stableStepLimit(), end - fluid.view().time));
  const state = fluid.view(), amplitude = 0.25 * Math.exp(-kappa * 4 * Math.PI ** 2 * end);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    near(state.tracers[0][j * n + i], 0.5 + amplitude * Math.sin(2 * Math.PI * (i + 0.5) / n), 0.001);
  }
});

test('an invalid source or unsafe step cannot publish a partial state', () => {
  let invalid = true;
  const fluid = createFluidSolver({ nx: 16, ny: 16, Lx: 1, Ly: 1, initialTracers: [0.4],
    forcing(time, fx) { fx.fill(0.1); },
    tracerSources(time, fields) { fields[0].fill(invalid ? NaN : 0.1); } });
  const before = fluid.view(), beforeU = before.u.slice(), beforeTracer = before.tracers[0].slice();
  assert.throws(() => fluid.step(0.02), /source/i);
  assert.throws(() => fluid.step(1), /unsafe/i);
  assert.equal(fluid.view().time, 0);
  assert.deepEqual(fluid.view().u, beforeU);
  assert.deepEqual(fluid.view().tracers[0], beforeTracer);
  invalid = false;
  fluid.step(0.02);
  assert.equal(fluid.view().time, 0.02);
  assert.ok(fluid.view().tracers[0][0] > 0.4);
});

test('invalid solver inputs are rejected and caller-owned initial arrays are copied', () => {
  const base = { nx: 16, ny: 16, Lx: 1, Ly: 1 };
  assert.throws(() => createFluidSolver({ ...base, nx: 20 }), /grid|domain/i);
  assert.throws(() => createFluidSolver({ ...base, ny: 128, nx: 128 }), /grid|domain/i);
  assert.throws(() => createFluidSolver({ ...base, viscosity: -1 }), /nonnegative/i);
  assert.throws(() => createFluidSolver({ ...base, tracerDecay: NaN }), /nonnegative/i);
  const tracer = new Float64Array(256).fill(0.3), u = new Float64Array(256).fill(0.1);
  const fluid = createFluidSolver({ ...base, initialVelocity: { u, v: 0 }, initialTracers: [tracer] });
  tracer.fill(0.9); u.fill(0.9);
  near(fluid.view().tracers[0][0], 0.3); near(fluid.view().u[0], 0.1);
  assert.throws(() => fluid.sample(NaN, 0, { tracers: [0] }), /sample/i);
  assert.throws(() => fluid.step(0), /unsafe/i);
});

test('initial flow retains comparable physical scales in tall and wide domains', () => {
  for (const [width, height] of [[300, 900], [900, 300], [390, 844], [844, 390]]) {
    const state = createDefaultFluid(width, height).view();
    let horizontal = 0, vertical = 0;
    for (let k = 0; k < state.u.length; k++) {
      horizontal += state.u[k] ** 2;
      vertical += state.v[k] ** 2;
    }
    const ratio = Math.sqrt(horizontal / vertical);
    assert.ok(ratio > 0.5 && ratio < 2,
      `initial velocity should not be compressed into one axis at ${width}×${height}: ratio=${ratio}`);
  }
});

test('periodic forcing has comparable physical scales in tall and wide domains', () => {
  for (const [width, height] of [[300, 900], [900, 300], [390, 844], [844, 390]]) {
    const forced = createDefaultFluid(width, height), initial = forced.view();
    const unforced = createFluidSolver({ nx: initial.nx, ny: initial.ny, Lx: initial.Lx, Ly: initial.Ly,
      viscosity: 0.003, initialVelocity: { u: initial.u, v: initial.v }, initialTracers: [0] });
    forced.step(0.001); unforced.step(0.001);
    const a = forced.view(), b = unforced.view();
    let horizontal = 0, vertical = 0;
    for (let k = 0; k < a.u.length; k++) {
      horizontal += (a.u[k] - b.u[k]) ** 2;
      vertical += (a.v[k] - b.v[k]) ** 2;
    }
    const ratio = Math.sqrt(horizontal / vertical);
    assert.ok(ratio > 0.5 && ratio < 2,
      `forcing should not be compressed into one axis at ${width}×${height}: ratio=${ratio}`);
  }
});

test('viewport size changes without an aspect change produce the same nondimensional flow', () => {
  const a = createDefaultFluid(300, 900), b = createDefaultFluid(600, 1800);
  for (let step = 0; step < 5; step++) { a.step(0.02); b.step(0.02); }
  const left = a.view(), right = b.view();
  assert.deepEqual([left.nx, left.ny, left.Lx, left.Ly], [right.nx, right.ny, right.Lx, right.Ly]);
  assert.deepEqual(left.u, right.u);
  assert.deepEqual(left.v, right.v);
  assert.deepEqual(left.tracers, right.tracers);
});

test('aspect-aware modes do not simply tile identical flow along the longer axis', () => {
  for (const [width, height] of [[320, 640], [640, 320]]) {
    const fluid = createDefaultFluid(width, height), state = fluid.view();
    const shiftX = width > height ? state.nx / 2 : 0;
    const shiftY = height > width ? state.ny / 2 : 0;
    let difference = 0, energy = 0;
    for (let j = 0; j < state.ny; j++) for (let i = 0; i < state.nx; i++) {
      const k = j * state.nx + i;
      const other = ((j + shiftY) % state.ny) * state.nx + (i + shiftX) % state.nx;
      difference += (state.u[k] - state.u[other]) ** 2 + (state.v[k] - state.v[other]) ** 2;
      energy += state.u[k] ** 2 + state.v[k] ** 2;
    }
    assert.ok(Math.sqrt(difference / energy) > 0.3, `flow should not repeat as identical tiles at ${width}×${height}`);
  }
});

test('extreme aspect ratios remain finite and periodic within grid limits', () => {
  for (const [width, height] of [[80, 1600], [1600, 80]]) {
    const fluid = createDefaultFluid(width, height), initial = fluid.view();
    assert.ok(initial.nx <= 128 && initial.ny <= 128 && initial.nx * initial.ny <= 8192);
    for (let step = 0; step < 30; step++) fluid.step(fluid.stableStepLimit());
    const state = fluid.view(), original = { tracers: new Float64Array(2) }, wrapped = { tracers: new Float64Array(2) };
    fluid.sample(0.23, 0.37, original);
    fluid.sample(0.23 + state.Lx, 0.37 - state.Ly, wrapped);
    for (const key of ['u', 'v']) { assert.ok(Number.isFinite(original[key])); near(original[key], wrapped[key]); }
    for (let k = 0; k < 2; k++) near(original.tracers[k], wrapped.tracers[k]);
    assert.ok(state.u.every(Number.isFinite) && state.v.every(Number.isFinite));
  }
});

test('default forced flow evolves velocity and tracer on a viewport-shaped grid', () => {
  const fluid = createDefaultFluid(800, 450), state = fluid.view();
  assert.deepEqual([state.nx, state.ny], [64, 32]);
  const initialU = state.u.slice(), initialTracer = state.tracers[0].slice();
  for (let i = 0; i < 20; i++) fluid.step(fluid.stableStepLimit());
  const later = fluid.view();
  assert.ok(later.u.some((value, i) => Math.abs(value - initialU[i]) > 1e-4));
  assert.ok(later.tracers[0].some((value, i) => Math.abs(value - initialTracer[i]) > 1e-4));
});

test('periodic tracer translation converges and preserves mass over 1000 steps', () => {
  function run(n, end, longRun) {
    const fluid = createFluidSolver({ nx: n, ny: n, Lx: 1, Ly: 1,
      initialVelocity: { u: 1, v: 0 }, initialTracers: [(x) => 0.5 + 0.25 * Math.sin(2 * Math.PI * x)] });
    const originalMass = fluid.view().tracers[0].reduce((a, b) => a + b, 0);
    while (fluid.view().time < end - 1e-12) fluid.step(Math.min(fluid.stableStepLimit(), end - fluid.view().time));
    const state = fluid.view();
    let error = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const expected = 0.5 + 0.25 * Math.sin(2 * Math.PI * ((i + 0.5) / n - end));
      error += (state.tracers[0][j * n + i] - expected) ** 2;
    }
    if (longRun) {
      for (let i = 0; i < 1000; i++) fluid.step(fluid.stableStepLimit());
      const values = fluid.view().tracers[0], mass = values.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(mass / originalMass - 1) < 1e-8, 'source-free mass must be conserved');
      assert.ok(values.every(value => value >= -1e-12 && Number.isFinite(value)));
    }
    return Math.sqrt(error / (n * n)) / 0.25;
  }
  const coarse = run(32, 0.25, true), fine = run(64, 0.25, false);
  assert.ok(fine < 0.1 && fine < coarse, `tracer error did not refine: ${coarse}, ${fine}`);
});

test('default flow remains changing and incompressible through 120 model-time units', { timeout: 60000 }, () => {
  for (const [width, height] of [[800, 450], [300, 900], [900, 300]]) {
    const fluid = createDefaultFluid(width, height), checkpoints = [17, 20, 57, 60, 117, 120];
    let previous;
    for (const target of checkpoints) {
      while (fluid.view().time < target - 1e-10) {
        fluid.step(Math.min(fluid.stableStepLimit(), target - fluid.view().time));
      }
      const state = fluid.view();
      if (target % 20 !== 0) {
        previous = { u: state.u.slice(), v: state.v.slice(), tracer: state.tracers[0].slice() };
        continue;
      }
      let du = 0, velocity = 0, dc = 0, tracer = 0, div2 = 0;
      for (let j = 0; j < state.ny; j++) for (let i = 0; i < state.nx; i++) {
        const k = j * state.nx + i, right = j * state.nx + (i + 1) % state.nx;
        const down = ((j + 1) % state.ny) * state.nx + i;
        du += (state.u[k] - previous.u[k]) ** 2 + (state.v[k] - previous.v[k]) ** 2;
        velocity += previous.u[k] ** 2 + previous.v[k] ** 2;
        dc += (state.tracers[0][k] - previous.tracer[k]) ** 2;
        tracer += previous.tracer[k] ** 2;
        const divergence = (state.u[right] - state.u[k]) / state.dx + (state.v[down] - state.v[k]) / state.dy;
        div2 += divergence ** 2;
      }
      assert.ok(Math.sqrt(du / velocity) > 0.02, `velocity change too small at ${width}×${height}, t=${target}`);
      assert.ok(Math.sqrt(dc / tracer) > 0.01, `tracer change too small at ${width}×${height}, t=${target}`);
      assert.ok(Math.sqrt(div2 / Math.max(velocity, 1e-12)) * Math.min(state.Lx, state.Ly) < 1e-3,
        `velocity divergence too large at ${width}×${height}, t=${target}`);
    }
  }
});
