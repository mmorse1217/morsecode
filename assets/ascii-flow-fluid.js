/*
 * Forced, periodic 2D incompressible flow, rendered as ASCII.
 *
 * One classic script, organized into private factory-based modules:
 * numerical solver → default model → playback → renderer → browser wiring.
 * Only the browser bootstrap touches the page at load time. CommonJS callers
 * can use the numerical and playback interfaces without a DOM or build step.
 */
(() => {
  'use strict';

  /**
   * @typedef {Object} FluidView
   * @property {number} nx Number of cells along x.
   * @property {number} ny Number of cells along y.
   * @property {number} Lx Periodic domain width, in nondimensional model units.
   * @property {number} Ly Periodic domain height, in nondimensional model units.
   * @property {number} dx Cell width in model units.
   * @property {number} dy Cell height in model units.
   * @property {number} time Model time, not active wall-clock seconds.
   * @property {Float64Array} u Borrowed x-face velocities; never mutate.
   * @property {Float64Array} v Borrowed y-face velocities; never mutate.
   * @property {Float64Array[]} tracers Borrowed cell-centered fields; never mutate.
   *
   * @typedef {{density: number, speed: number, contrast: number, cellSize: number}} FlowSettings
   * Speed is model-time units per active wall-clock second; cellSize is CSS px.
   *
   * @typedef {{width: number, height: number, dpr: number}} Viewport
   * Width and height are CSS px. DPR affects only the backing bitmap.
   *
   * @typedef {{tracers: Float64Array, u?: number, v?: number}} FieldSample
   * Caller-owned output reused across samples; sampling does not allocate it.
   *
   * @typedef {ReturnType<typeof createFluidSolver>} FluidSolver
   */

  // Appearance tuning. Values are nondimensional unless marked as CSS pixels.
  // Stability limits and resource caps are intentionally kept separate below.
  const APPEARANCE = Object.freeze({
    viscosity: 0.003, tracerDiffusivity: 0.0002, tracerDecay: 0.035,
    sourceStrength: 0.10, forceStrengths: [0.0025, 0.0018, 0.0012],
    contourInterval: 0.005, glyphAspectRatio: 1.28,
    backgroundColor: '#0a0b0d', glyphColor: '218,224,227',
    font: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    defaults: Object.freeze({ density: 1, speed: 0.2, contrast: 1.1, cellSize: 8 })
  });

  // Numerical core -----------------------------------------------------------

  // In-place radix-2 transform: forward unnormalized, inverse divided by N.
  function fft1D(real, imag, inverse = false) {
    const n = real.length;
    if (n !== imag.length || n < 1 || (n & (n - 1)) !== 0) throw new RangeError('FFT size must be a power of two');
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        let value = real[i]; real[i] = real[j]; real[j] = value;
        value = imag[i]; imag[i] = imag[j]; imag[j] = value;
      }
    }
    for (let length = 2; length <= n; length *= 2) {
      const angle = (inverse ? 2 : -2) * Math.PI / length;
      const baseR = Math.cos(angle), baseI = Math.sin(angle), half = length / 2;
      for (let start = 0; start < n; start += length) {
        let wr = 1, wi = 0;
        for (let k = 0; k < half; k++) {
          const a = start + k, b = a + half;
          const tr = wr * real[b] - wi * imag[b], ti = wr * imag[b] + wi * real[b];
          real[b] = real[a] - tr; imag[b] = imag[a] - ti;
          real[a] += tr; imag[a] += ti;
          const nextR = wr * baseR - wi * baseI;
          wi = wr * baseI + wi * baseR; wr = nextR;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n; }
  }

  // Eigenvalues of the discrete periodic Laplacian, inverted in Fourier space.
  // The zero mode is excluded to choose a zero-mean pressure.
  function createInverseLaplacian(nx, ny, invDx2, invDy2) {
    const inverseEigenvalues = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const eigenvalue = -4 * (Math.sin(Math.PI * i / nx) ** 2 * invDx2 +
        Math.sin(Math.PI * j / ny) ** 2 * invDy2);
      const inverse = i || j ? 1 / eigenvalue : 0;
      if (!Number.isFinite(eigenvalue) || !Number.isFinite(inverse)) throw new RangeError('Unrepresentable Poisson eigenvalue');
      inverseEigenvalues[j * nx + i] = inverse;
    }
    return inverseEigenvalues;
  }

  // Solves the *discrete* periodic MAC-grid Laplacian, with zero pressure mean.
  // Input is not changed; output and all FFT work buffers are caller/module owned.
  function createPeriodicPoissonSolver(nx, ny, dx, dy) {
    if (![nx, ny].every(n => Number.isInteger(n) && n >= 2 && n <= 128 && (n & (n - 1)) === 0) ||
        nx * ny > 8192 || !Number.isFinite(dx) || !Number.isFinite(dy) || dx <= 0 || dy <= 0) {
      throw new RangeError('Invalid periodic Poisson grid');
    }
    // Finite inputs can still produce unusable squared spacings or eigenvalues.
    const invDx2 = 1 / dx / dx, invDy2 = 1 / dy / dy;
    if (![invDx2, invDy2, invDx2 + invDy2].every(Number.isFinite) ||
        invDx2 === 0 || invDy2 === 0) throw new RangeError('Unrepresentable Poisson grid spacing');
    const size = nx * ny, real = new Float64Array(size), imag = new Float64Array(size);
    const rowReal = new Float64Array(nx), rowImag = new Float64Array(nx);
    const columnReal = new Float64Array(ny), columnImag = new Float64Array(ny);
    const inverseEigenvalues = createInverseLaplacian(nx, ny, invDx2, invDy2);

    function transform(inverse) {
      for (let j = 0; j < ny; j++) {
        const base = j * nx;
        for (let i = 0; i < nx; i++) { rowReal[i] = real[base + i]; rowImag[i] = imag[base + i]; }
        fft1D(rowReal, rowImag, inverse);
        for (let i = 0; i < nx; i++) { real[base + i] = rowReal[i]; imag[base + i] = rowImag[i]; }
      }
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) { columnReal[j] = real[j * nx + i]; columnImag[j] = imag[j * nx + i]; }
        fft1D(columnReal, columnImag, inverse);
        for (let j = 0; j < ny; j++) { real[j * nx + i] = columnReal[j]; imag[j * nx + i] = columnImag[j]; }
      }
    }
    return {
      solve(rhs, output) {
        const overlap = ArrayBuffer.isView(rhs) && ArrayBuffer.isView(output) && rhs.buffer === output.buffer &&
          rhs.byteOffset < output.byteOffset + output.byteLength && output.byteOffset < rhs.byteOffset + rhs.byteLength;
        if (rhs.length !== size || output.length !== size || rhs === output || overlap) throw new RangeError('Invalid Poisson buffers');
        let mean = 0, square = 0;
        for (let k = 0; k < size; k++) {
          const value = rhs[k];
          if (!Number.isFinite(value)) throw new RangeError('Non-finite Poisson RHS');
          mean += value; square += value * value;
        }
        mean /= size;
        if (Math.abs(mean) > Math.max(1e-12, 1e-10 * Math.sqrt(square / size))) {
          throw new RangeError('Periodic Poisson RHS must have zero mean');
        }
        for (let k = 0; k < size; k++) { real[k] = rhs[k] - mean; imag[k] = 0; }
        transform(false);
        for (let k = 0; k < size; k++) { real[k] *= inverseEigenvalues[k]; imag[k] *= inverseEigenvalues[k]; }
        transform(true);
        for (let k = 0; k < size; k++) {
          if (!Number.isFinite(real[k]) || Math.abs(imag[k]) > 1e-9 * Math.max(1, Math.abs(real[k]))) {
            throw new Error('Invalid periodic pressure solution');
          }
          output[k] = real[k];
        }
      }
    };
  }

  // Bilinear sampling at a specified MAC offset; indices wrap in both directions.
  function samplePeriodic(field, nx, ny, dx, dy, x, y, ox, oy) {
    const Lx = nx * dx, Ly = ny * dy;
    x = ((x % Lx) + Lx) % Lx; y = ((y % Ly) + Ly) % Ly;
    const gx = x / dx - ox, gy = y / dy - oy;
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    const x0 = i & (nx - 1), x1 = (i + 1) & (nx - 1);
    const y0 = (j & (ny - 1)) * nx, y1 = ((j + 1) & (ny - 1)) * nx;
    return (field[y0 + x0] * (1 - fx) + field[y0 + x1] * fx) * (1 - fy) +
      (field[y1 + x0] * (1 - fx) + field[y1 + x1] * fx) * fy;
  }

  // Prepare the indices and interpolation fractions for one periodic axis.
  // Coordinates are copied so callers can reuse or modify their input arrays.
  function preparePeriodicAxis(coordinates, count, spacing, offset, stride) {
    if (!coordinates || !Number.isInteger(coordinates.length) || coordinates.length < 1) {
      throw new RangeError('Invalid fixed sampling coordinates');
    }
    const values = new Float64Array(coordinates.length);
    const low = new Uint32Array(coordinates.length), high = new Uint32Array(coordinates.length);
    const fraction = new Float64Array(coordinates.length), length = count * spacing;
    for (let k = 0; k < values.length; k++) {
      const value = coordinates[k];
      if (!Number.isFinite(value)) throw new RangeError('Invalid fixed sampling coordinate');
      values[k] = value;
      const wrapped = ((value % length) + length) % length, grid = wrapped / spacing - offset;
      const base = Math.floor(grid);
      low[k] = (base & (count - 1)) * stride;
      high[k] = ((base + 1) & (count - 1)) * stride;
      fraction[k] = grid - base;
    }
    return { values, low, high, fraction };
  }

  // Cache separable axis stencils, not field values. Keep Float64 fractions
  // and the direct sampler's arithmetic order to preserve interpolated values.
  function preparePeriodicGrid(nx, ny, dx, dy, xs, ys, ox, oy) {
    const x = preparePeriodicAxis(xs, nx, dx, ox, 1);
    const y = preparePeriodicAxis(ys, ny, dy, oy, nx);
    return {
      x: x.values, y: y.values,
      sample(field, i, j) {
        const x0 = x.low[i], x1 = x.high[i], y0 = y.low[j], y1 = y.high[j];
        const fx = x.fraction[i], fy = y.fraction[j];
        return (field[y0 + x0] * (1 - fx) + field[y0 + x1] * fx) * (1 - fy) +
          (field[y1 + x0] * (1 - fx) + field[y1 + x1] * fx) * fy;
      }
    };
  }

  // A visualization-only streamfunction reconstructed from the projected MAC
  // velocities. Periodic velocity can have a constant mean: its streamfunction
  // contains a linear, unwrapped term. Contours approximate instantaneous
  // streamlines, not particle trajectories or an independently animated overlay.
  function createStreamlineField(initialState) {
    const { nx, ny, dx, dy } = initialState;
    const size = nx * ny, stream = new Float64Array(size);
    let meanU = 0, meanV = 0, lastTime = NaN, lastU = null, lastV = null;
    return {
      update(state) {
        if (state.nx !== nx || state.ny !== ny || state.dx !== dx || state.dy !== dy ||
            state.u.length !== size || state.v.length !== size) throw new RangeError('Streamline grid mismatch');
        if (state.time === lastTime && state.u === lastU && state.v === lastV) return;
        meanU = 0; meanV = 0;
        for (let k = 0; k < size; k++) { meanU += state.u[k]; meanV += state.v[k]; }
        meanU /= size; meanV /= size;
        stream[0] = 0;
        for (let i = 1; i < nx; i++) stream[i] = stream[i - 1] - dx * (state.v[i - 1] - meanV);
        for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          stream[k] = stream[k - nx] + dy * (state.u[k - nx] - meanU);
        }
        lastTime = state.time; lastU = state.u; lastV = state.v;
      },
      sample(x, y) {
        return samplePeriodic(stream, nx, ny, dx, dy, x, y, 0, 0) + meanU * y - meanV * x;
      },
      prepareSamplingGrid(xs, ys) {
        const grid = preparePeriodicGrid(nx, ny, dx, dy, xs, ys, 0, 0);
        return {
          sample(i, j) { return grid.sample(stream, i, j) + meanU * grid.y[j] - meanV * grid.x[i]; }
        };
      }
    };
  }

  // Materialize a caller-supplied constant, array, or function on a MAC grid.
  // The returned buffer is always owned by the solver.
  function createInitialField(input, nx, ny, dx, dy, offsetX, offsetY, nonnegative) {
    if (input == null) throw new RangeError('Missing initial field');
    const isArray = Array.isArray(input) || ArrayBuffer.isView(input);
    if (isArray && input.length !== nx * ny) throw new RangeError('Invalid initial field length');
    const field = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const index = j * nx + i;
      const value = isArray ? input[index] : typeof input === 'function' ?
        input((i + offsetX) * dx, (j + offsetY) * dy) : input;
      if (!Number.isFinite(value) || (nonnegative && value < 0)) throw new RangeError('Invalid initial field value');
      field[index] = value;
    }
    return field;
  }

  // createFluidSolver({nx, ny, Lx, Ly, viscosity, tracerDiffusivity,
  // tracerDecay, initialVelocity: {u,v}, initialTracers, forcing, tracerSources})
  // Coordinates are nondimensional model units. MAC fields are row-major:
  // u at (i,j+½), v at (i+½,j), tracers at (i+½,j+½), in cell coordinates.
  // Initial fields may be constants, arrays, or (x,y) callbacks; arrays are
  // copied. Forcing(t, fx, fy) and tracerSources(t, fields) fill solver-owned
  // scratch arrays only during the call and must not retain them. view() fields
  // are read-only by contract: reacquire after step() swaps buffers. A step
  // publishes all new fields and its exact time increment only after validation.
  function createFluidSolver(options) {
    const { nx, ny, Lx, Ly } = options;
    if (![nx, ny].every(n => Number.isInteger(n) && n >= 16 && n <= 128 && (n & (n - 1)) === 0) ||
        nx * ny > 8192 || !Number.isFinite(Lx) || !Number.isFinite(Ly) || Lx <= 0 || Ly <= 0) {
      throw new RangeError('Invalid fluid grid or domain');
    }
    const viscosity = options.viscosity ?? 0, diffusivity = options.tracerDiffusivity ?? 0;
    const decay = options.tracerDecay ?? 0;
    if (![viscosity, diffusivity, decay].every(n => Number.isFinite(n) && n >= 0)) {
      throw new RangeError('Diffusion and decay must be finite and nonnegative');
    }
    const size = nx * ny, dx = Lx / nx, dy = Ly / ny;
    if (!(dx > 0 && dy > 0) || !Number.isFinite(1 / dx) || !Number.isFinite(1 / dy)) {
      throw new RangeError('Unrepresentable fluid grid spacing');
    }
    const initialVelocity = options.initialVelocity ?? { u: 0, v: 0 };
    const initialTracers = options.initialTracers ?? [0, 0];
    if (!Array.isArray(initialTracers) || initialTracers.length < 1 || initialTracers.length > 2) {
      throw new RangeError('Supply one or two initial tracer fields');
    }
    let u = createInitialField(initialVelocity.u, nx, ny, dx, dy, 0, 0.5, false);
    let v = createInitialField(initialVelocity.v, nx, ny, dx, dy, 0.5, 0, false);
    const tracers = initialTracers.map(input => createInitialField(input, nx, ny, dx, dy, 0.5, 0.5, true));
    const forcing = options.forcing ?? null, tracerSources = options.tracerSources ?? null;
    if ((forcing !== null && typeof forcing !== 'function') || (tracerSources !== null && typeof tracerSources !== 'function')) {
      throw new TypeError('Invalid force or tracer source callback');
    }
    // u, v, and tracers are published state. Candidate and scratch buffers
    // remain private until the entire step has succeeded.
    let nextU = new Float64Array(size), nextV = new Float64Array(size);
    const nextTracers = tracers.map(() => new Float64Array(size));
    // These buffers first hold advected velocity, then projected velocity.
    const velocityWorkU = new Float64Array(size), velocityWorkV = new Float64Array(size);
    const forceU = new Float64Array(size), forceV = new Float64Array(size);
    const sources = tracers.map(() => new Float64Array(size));
    const fluxX = new Float64Array(size), fluxY = new Float64Array(size);
    const rhs = new Float64Array(size), pressure = new Float64Array(size);
    const poisson = createPeriodicPoissonSolver(nx, ny, dx, dy);
    const invDx = 1 / dx, invDy = 1 / dy, invDx2 = invDx * invDx, invDy2 = invDy * invDy;
    const maskX = nx - 1, maskY = ny - 1;
    let time = 0;

    function index(i, j) { return (j & maskY) * nx + (i & maskX); }
    function sample(field, x, y, ox, oy) { return samplePeriodic(field, nx, ny, dx, dy, x, y, ox, oy); }
    function divergence(fieldU, fieldV, i, j) {
      const k = index(i, j);
      return (fieldU[index(i + 1, j)] - fieldU[k]) * invDx + (fieldV[index(i, j + 1)] - fieldV[k]) * invDy;
    }
    function project(fieldU, fieldV, targetU, targetV, h) {
      let preSquare = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = index(i, j), d = divergence(fieldU, fieldV, i, j);
        if (!Number.isFinite(d)) throw new Error('Non-finite tentative velocity');
        rhs[k] = d / h; preSquare += d * d;
      }
      poisson.solve(rhs, pressure);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = index(i, j);
        targetU[k] = fieldU[k] - h * (pressure[k] - pressure[index(i - 1, j)]) * invDx;
        targetV[k] = fieldV[k] - h * (pressure[k] - pressure[index(i, j - 1)]) * invDy;
      }
      let postSquare = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const d = divergence(targetU, targetV, i, j); postSquare += d * d;
      }
      if (!Number.isFinite(postSquare) || Math.sqrt(postSquare / size) > Math.max(1e-10, 1e-6 * Math.sqrt(preSquare / size))) {
        throw new Error('Fluid projection residual exceeded tolerance');
      }
    }
    function initializeVelocity() {
      // Project arbitrary supplied initial fields once; never retain caller arrays.
      project(u, v, nextU, nextV, 1);
      const originalU = u, originalV = v;
      u = nextU; nextU = originalU;
      v = nextV; nextV = originalV;
    }

    function stableStepLimit(maxRequestedStep = 1 / 30) {
      if (!Number.isFinite(maxRequestedStep) || maxRequestedStep <= 0) throw new RangeError('Invalid maximum step');
      let maxU = 0, maxV = 0;
      for (let k = 0; k < size; k++) {
        maxU = Math.max(maxU, Math.abs(u[k])); maxV = Math.max(maxV, Math.abs(v[k]));
      }
      const sum = invDx2 + invDy2;
      const tracerDenominator = maxU * invDx + maxV * invDy + 2 * diffusivity * sum;
      const limit = Math.min(1 / 30, maxRequestedStep,
        tracerDenominator ? 0.45 / tracerDenominator : Infinity,
        viscosity ? 0.9 / (2 * viscosity * sum) : Infinity);
      if (!Number.isFinite(limit) || limit <= 0) throw new Error('Invalid fluid stability limit');
      return limit;
    }
    function advectVelocityField(currentField, output, offsetX, offsetY, stepSize) {
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = index(i, j), x = (i + offsetX) * dx, y = (j + offsetY) * dy;
        const velocityX = sample(u, x, y, 0, 0.5), velocityY = sample(v, x, y, 0.5, 0);
        const midpointX = x - 0.5 * stepSize * velocityX, midpointY = y - 0.5 * stepSize * velocityY;
        const sourceX = x - stepSize * sample(u, midpointX, midpointY, 0, 0.5);
        const sourceY = y - stepSize * sample(v, midpointX, midpointY, 0.5, 0);
        output[k] = sample(currentField, sourceX, sourceY, offsetX, offsetY);
      }
    }
    function laplacian(field, i, j) {
      const k = index(i, j);
      return (field[index(i + 1, j)] - 2 * field[k] + field[index(i - 1, j)]) * invDx2 +
        (field[index(i, j + 1)] - 2 * field[k] + field[index(i, j - 1)]) * invDy2;
    }
    function transportTracers(stepSize) {
      if (tracerSources) {
        for (let tracerIndex = 0; tracerIndex < sources.length; tracerIndex++) sources[tracerIndex].fill(0);
        tracerSources(time + stepSize / 2, sources);
      }
      const reaction = -Math.expm1(-decay * stepSize), retention = 1 - reaction;
      const sourceFactor = decay ? reaction / decay : stepSize;
      for (let tracerIndex = 0; tracerIndex < tracers.length; tracerIndex++) {
        const currentTracer = tracers[tracerIndex];
        const nextTracer = nextTracers[tracerIndex];
        const source = sources[tracerIndex];
        // Upwind flux at each face, based on the current velocity and tracer.
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const k = index(i, j), velocityX = u[k], velocityY = v[k];
          fluxX[k] = Math.max(velocityX, 0) * currentTracer[index(i - 1, j)] + Math.min(velocityX, 0) * currentTracer[k];
          fluxY[k] = Math.max(velocityY, 0) * currentTracer[index(i, j - 1)] + Math.min(velocityY, 0) * currentTracer[k];
        }
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const k = index(i, j), sourceValue = source[k];
          if (!Number.isFinite(sourceValue) || sourceValue < 0) throw new Error('Invalid tracer source');
          const transported = currentTracer[k] - stepSize * ((fluxX[index(i + 1, j)] - fluxX[k]) * invDx +
            (fluxY[index(i, j + 1)] - fluxY[k]) * invDy) + stepSize * diffusivity * laplacian(currentTracer, i, j);
          const value = transported * retention + sourceValue * sourceFactor;
          if (!Number.isFinite(value) || value < -1e-12) throw new Error('Invalid transported tracer');
          nextTracer[k] = value;
        }
      }
    }
    // Build the candidate velocity without modifying the published fields.
    function prepareVelocityStep(stepSize) {
      advectVelocityField(u, velocityWorkU, 0, 0.5, stepSize);
      advectVelocityField(v, velocityWorkV, 0.5, 0, stepSize);
      forceU.fill(0); forceV.fill(0);
      if (forcing) forcing(time + stepSize / 2, forceU, forceV);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = index(i, j);
        nextU[k] = velocityWorkU[k] + stepSize * (viscosity * laplacian(velocityWorkU, i, j) + forceU[k]);
        nextV[k] = velocityWorkV[k] + stepSize * (viscosity * laplacian(velocityWorkV, i, j) + forceV[k]);
      }
      // Reuse the advection buffers for the projected velocity.
      project(nextU, nextV, velocityWorkU, velocityWorkV, stepSize);
    }

    // Publish only after both velocity and tracer calculations validate.
    function commitStep(stepSize) {
      for (let k = 0; k < size; k++) {
        nextU[k] = velocityWorkU[k];
        nextV[k] = velocityWorkV[k];
      }
      const oldU = u, oldV = v;
      u = nextU; nextU = oldU;
      v = nextV; nextV = oldV;
      for (let a = 0; a < tracers.length; a++) {
        const oldTracer = tracers[a];
        tracers[a] = nextTracers[a];
        nextTracers[a] = oldTracer;
      }
      time += stepSize;
    }

    initializeVelocity();

    return {
      stableStepLimit,
      step(stepSize) {
        const limit = stableStepLimit();
        if (limit < 1e-5) throw new Error('Fluid stability step is too small');
        if (!Number.isFinite(stepSize) || stepSize <= 0 || stepSize > limit * (1 + 1e-12)) {
          throw new RangeError('Unsafe fluid step');
        }
        prepareVelocityStep(stepSize);
        transportTracers(stepSize); // Uses the unmodified old velocity and tracers.
        commitStep(stepSize);
      },
      sample(x, y, out) {
        this.sampleTracers(x, y, out);
        this.sampleVelocity(x, y, out);
      },
      sampleVelocity(x, y, out) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !out) throw new RangeError('Invalid velocity sample');
        out.u = samplePeriodic(u, nx, ny, dx, dy, x, y, 0, 0.5);
        out.v = samplePeriodic(v, nx, ny, dx, dy, x, y, 0.5, 0);
      },
      sampleTracers(x, y, out) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !out || !out.tracers || out.tracers.length < tracers.length) {
          throw new RangeError('Invalid tracer sample');
        }
        for (let a = 0; a < tracers.length; a++) {
          out.tracers[a] = samplePeriodic(tracers[a], nx, ny, dx, dy, x, y, 0.5, 0.5);
        }
      },
      // Coordinates are copied once. Callers use valid integer column/row
      // indices and a reusable output; the closures read the *current* buffers.
      prepareSamplingGrid(xs, ys) {
        const velocityX = preparePeriodicGrid(nx, ny, dx, dy, xs, ys, 0, 0.5);
        const velocityY = preparePeriodicGrid(nx, ny, dx, dy, xs, ys, 0.5, 0);
        const tracer = preparePeriodicGrid(nx, ny, dx, dy, xs, ys, 0.5, 0.5);
        return {
          sampleVelocity(i, j, out) {
            out.u = velocityX.sample(u, i, j); out.v = velocityY.sample(v, i, j);
          },
          sampleTracers(i, j, out) {
            for (let a = 0; a < tracers.length; a++) out.tracers[a] = tracer.sample(tracers[a], i, j);
          }
        };
      },
      /**
       * @returns {FluidView} A borrowed view, NOT an owned snapshot. Reacquire
       * after every step: buffers swap and old buffers become scratch space.
       * The tracer array is itself live. Copy fields explicitly if retaining them.
       */
      view() { return { nx, ny, Lx, Ly, dx, dy, time, u, v, tracers }; }
    };
  }

  // Default model -----------------------------------------------------------

  // The model's documented nondimensional inputs. Only the force and sources
  // are prescribed after initialization; velocity and tracer remain solver state.
  function createDefaultFluid(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new RangeError('Invalid viewport size');
    }
    const shortSide = Math.min(width, height);
    const Lx = width / shortSide, Ly = height / shortSide;
    const minorGridCells = Math.max(16, Math.min(64, 2 ** Math.round(Math.log2(64 * shortSide / Math.max(width, height)))));
    const nx = width >= height ? 64 : minorGridCells, ny = height >= width ? 64 : minorGridCells;
    const dx = Lx / nx, dy = Ly / ny, size = nx * ny, fullTurn = 2 * Math.PI;
    // Integer periodic modes approximate one cycle per unit of physical length.
    // Limit harmonics to at least four grid cells per wavelength; on extremely
    // elongated domains the finite grid prevents perfectly equal feature scales.
    const modeX = Math.max(1, Math.min(Math.floor(nx / 8), Math.round(Lx)));
    const modeY = Math.max(1, Math.min(Math.floor(ny / 8), Math.round(Ly)));
    const secondX = 2 * modeX - (modeX > 1 ? 1 : 0);
    const secondY = modeY > 1 ? modeY - 1 : modeY;
    const thirdX = modeX > 1 ? modeX - 1 : modeX;
    const thirdY = 2 * modeY - (modeY > 1 ? 1 : 0);
    const maskX = nx - 1, maskY = ny - 1;
    const index = (i, j) => (j & maskY) * nx + (i & maskX);
    const initialStream = new Float64Array(size), initialU = new Float64Array(size), initialV = new Float64Array(size);
    const forceSin = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];
    const forceCos = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];
    const cornerForce = new Float64Array(size);
    const sourceShapes = [new Float64Array(size), new Float64Array(size), new Float64Array(size), new Float64Array(size)];
    const sourceCenters = [[0.20, 0.30], [0.70, 0.70], [0.70, 0.25], [0.25, 0.75]];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = index(i, j), x = i / nx, y = j / ny;
      initialStream[k] = 0.015 * Math.sin(fullTurn * modeX * x) * Math.sin(fullTurn * modeY * y) +
        0.006 * Math.sin(fullTurn * (secondX * x + secondY * y));
      // Nearby integer harmonics break exact tiling while preserving periodicity.
      const phase0 = fullTurn * (modeX * x + modeY * y);
      const phase1 = fullTurn * (secondX * x - secondY * y) + 1.1;
      const phase2 = fullTurn * (-thirdX * x + thirdY * y) + 2.4;
      forceSin[0][k] = Math.sin(phase0); forceCos[0][k] = Math.cos(phase0);
      forceSin[1][k] = Math.sin(phase1); forceCos[1][k] = Math.cos(phase1);
      forceSin[2][k] = Math.sin(phase2); forceCos[2][k] = Math.cos(phase2);
      const cellX = (i + 0.5) / nx, cellY = (j + 0.5) / ny;
      for (let sourceIndex = 0; sourceIndex < sourceCenters.length; sourceIndex++) {
        const distanceX = Lx / Math.PI * Math.sin(Math.PI * (cellX - sourceCenters[sourceIndex][0]));
        const distanceY = Ly / Math.PI * Math.sin(Math.PI * (cellY - sourceCenters[sourceIndex][1]));
        sourceShapes[sourceIndex][k] = Math.exp(-(distanceX * distanceX + distanceY * distanceY) / (2 * 0.12 ** 2));
      }
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = index(i, j);
      initialU[k] = (initialStream[index(i, j + 1)] - initialStream[k]) / dy;
      initialV[k] = -(initialStream[index(i + 1, j)] - initialStream[k]) / dx;
    }
    return createFluidSolver({
      nx, ny, Lx, Ly, viscosity: APPEARANCE.viscosity,
      tracerDiffusivity: APPEARANCE.tracerDiffusivity, tracerDecay: APPEARANCE.tracerDecay,
      initialVelocity: { u: initialU, v: initialV },
      initialTracers: [
        (x, y) => 0.25 + 0.15 * Math.sin(fullTurn * (2 * x / Lx + y / Ly)),
        (x, y) => 0.25 + 0.15 * Math.cos(fullTurn * (x / Lx - 2 * y / Ly))
      ],
      forcing(t, fx, fy) {
        const s0 = Math.sin(0.31 * t), c0 = Math.cos(0.31 * t);
        const s1 = Math.sin(-0.23 * t), c1 = Math.cos(-0.23 * t);
        const s2 = Math.sin(0.17 * t), c2 = Math.cos(0.17 * t);
        for (let k = 0; k < size; k++) {
          cornerForce[k] = APPEARANCE.forceStrengths[0] * (forceSin[0][k] * c0 + forceCos[0][k] * s0) +
            APPEARANCE.forceStrengths[1] * (forceSin[1][k] * c1 + forceCos[1][k] * s1) +
            APPEARANCE.forceStrengths[2] * (forceSin[2][k] * c2 + forceCos[2][k] * s2);
        }
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const k = index(i, j);
          fx[k] = (cornerForce[index(i, j + 1)] - cornerForce[k]) / dy;
          fy[k] = -(cornerForce[index(i + 1, j)] - cornerForce[k]) / dx;
        }
      },
      tracerSources(t, fields) {
        const strength0 = 1 + 0.5 * Math.sin(0.19 * t), strength1 = 1 + 0.5 * Math.sin(0.23 * t + 1.3);
        const strength2 = 1 + 0.5 * Math.sin(0.17 * t + 2.1), strength3 = 1 + 0.5 * Math.sin(0.29 * t + 0.7);
        for (let k = 0; k < size; k++) {
          fields[0][k] = APPEARANCE.sourceStrength * (strength0 * sourceShapes[0][k] + strength1 * sourceShapes[1][k]);
          fields[1][k] = APPEARANCE.sourceStrength * (strength2 * sourceShapes[2][k] + strength3 * sourceShapes[3][k]);
        }
      }
    });
  }

  // Playback ----------------------------------------------------------------

  // Private rolling accounting: include ALL active wall time, even time the
  // work cap discards. Otherwise overloaded playback could falsely report full speed.
  function createSpeedMonitor(report) {
    // At the 24 Hz target this holds well over the three-second window,
    // including higher rates caused by refresh-interval quantization.
    const CAPACITY = 512;
    const WINDOW_SECONDS = 3;
    const MIN_SPEED_RATIO = 0.8;
    const wallSamples = new Float64Array(CAPACITY);
    const requestedSamples = new Float64Array(CAPACITY);
    const actualSamples = new Float64Array(CAPACITY);
    let start = 0, count = 0;
    let wallTotal = 0, requestedTotal = 0, actualTotal = 0;

    function discardOldest() {
      wallTotal -= wallSamples[start];
      requestedTotal -= requestedSamples[start];
      actualTotal -= actualSamples[start];
      start = (start + 1) % CAPACITY;
      count--;
    }

    return {
      reset() {
        start = 0;
        count = 0;
        wallTotal = 0;
        requestedTotal = 0;
        actualTotal = 0;
        report(false);
      },
      record(wallSeconds, requestedModelTime, actualModelTime) {
        if (!(wallSeconds > 0 && requestedModelTime > 0)) return;
        if (count === CAPACITY) discardOldest();
        const index = (start + count) % CAPACITY;
        wallSamples[index] = wallSeconds;
        requestedSamples[index] = requestedModelTime;
        actualSamples[index] = actualModelTime;
        wallTotal += wallSeconds;
        requestedTotal += requestedModelTime;
        actualTotal += actualModelTime;
        count++;
        while (count > 1 && wallTotal - wallSamples[start] >= WINDOW_SECONDS) discardOldest();
        if (wallTotal >= WINDOW_SECONDS) report(actualTotal / requestedTotal < MIN_SPEED_RATIO);
      }
    };
  }

  /**
   * @typedef {Object} PlaybackClock
   * @property {function(): number} now Monotonic work-budget clock, milliseconds.
   * @property {function(function(number): void): number} requestFrame One-shot scheduler.
   * @property {function(number): void} cancelFrame Cancel a scheduled frame.
   */

  /**
   * Owns one animation loop, model-time backlog and speed reporting; no DOM.
   * Configure supplies the current solver, finite nonnegative speed and external
   * pause state. Invalid speeds throw before changing a live configuration.
   * Pauses and model replacements discard backlog. Speed changes only clear
   * the rate estimate. destroy() is terminal and cancels pending work.
   *
   * @param {{clock: PlaybackClock, draw: function(): void,
   *   onError: function(Error): void, reportSpeedLimit: function(boolean): void}} options
   */
  function createPlaybackDriver({ clock, draw, onError, reportSpeedLimit }) {
    const FRAME_INTERVAL_MS = 1000 / 24;
    const MAX_WALL_DELTA_SECONDS = 0.08;
    const MAX_SUBSTEPS = 8;
    const SIMULATION_BUDGET_MS = 6;
    const MIN_MODEL_STEP = 1e-5;
    const speedMonitor = createSpeedMonitor(reportSpeedLimit);
    let fluid = null, speed = 0, paused = true;
    let frame = 0, running = false, destroyed = false;
    let lastTime = null, accumulated = 0;

    function syncAnimation() {
      const shouldRun = !destroyed && fluid && !paused && speed > 0;
      if (!shouldRun) {
        if (running) {
          running = false;
          clock.cancelFrame(frame);
          frame = 0;
        }
        lastTime = null;
        accumulated = 0;
        speedMonitor.reset();
      } else if (!running) {
        running = true;
        lastTime = null;
        frame = clock.requestFrame(tick);
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      syncAnimation();
    }

    // Advance only whole stable steps, discarding excess backlog when the
    // per-frame work limit is reached. Return the model time actually advanced.
    function advanceBacklog() {
      const workStart = clock.now();
      let steps = 0, advanced = 0;
      while (fluid) {
        const stepSize = fluid.stableStepLimit();
        if (stepSize < MIN_MODEL_STEP) throw new Error('Fluid stability step is too small');
        if (accumulated + 1e-12 < stepSize) break;
        // Always allow a first safe step, even when the work budget is tight.
        if (steps >= MAX_SUBSTEPS || (steps > 0 && clock.now() - workStart >= SIMULATION_BUDGET_MS)) {
          accumulated %= stepSize;
          break;
        }
        fluid.step(stepSize);
        accumulated = Math.max(0, accumulated - stepSize);
        advanced += stepSize;
        steps++;
      }
      return advanced;
    }

    function tick(now) {
      if (!running) return;
      frame = clock.requestFrame(tick);
      if (lastTime !== null && now - lastTime < FRAME_INTERVAL_MS) return;
      try {
        const wallSeconds = lastTime === null ? 0 : Math.max(0, (now - lastTime) / 1000);
        lastTime = now;
        const requested = wallSeconds * speed;
        accumulated += Math.min(wallSeconds, MAX_WALL_DELTA_SECONDS) * speed;
        const advanced = advanceBacklog();
        speedMonitor.record(wallSeconds, requested, advanced);
        draw();
      } catch (error) {
        destroy();
        onError(error);
      }
    }

    return {
      /** @param {{fluid: FluidSolver|null, speed: number, paused: boolean}} state */
      configure({ fluid: nextFluid, speed: nextSpeed, paused: nextPaused }) {
        if (destroyed) return;
        if (!Number.isFinite(nextSpeed) || nextSpeed < 0) throw new RangeError('Invalid playback speed');
        if (nextFluid !== fluid) {
          lastTime = null;
          accumulated = 0;
        }
        if (nextFluid !== fluid || nextSpeed !== speed) speedMonitor.reset();
        fluid = nextFluid;
        speed = nextSpeed;
        paused = nextPaused;
        syncAnimation();
      },
      resetRate() { speedMonitor.reset(); },
      destroy
    };
  }

  // ASCII renderer ----------------------------------------------------------

  // Display resource limits are independent of the solver's grid caps.
  const MAX_GLYPH_CANDIDATES = 20000;
  const MAX_BACKING_PIXELS = 6000000;
  const MAX_BACKING_AXIS = 8192;
  const MAX_BACKING_SCALE = 2;
  const GLYPH_ASPECT_RATIO = APPEARANCE.glyphAspectRatio;
  const CONTOUR_INTERVAL = APPEARANCE.contourInterval;
  const BACKGROUND_COLOR = APPEARANCE.backgroundColor;
  const COLORS = Array.from({ length: 256 }, (_, i) => `rgba(${APPEARANCE.glyphColor},${i / 255})`);
  const FONT = APPEARANCE.font;

  function hash(x, y) {
    let v = Math.imul(x + 17, 374761393) + Math.imul(y + 29, 668265263);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  }

  function directionGlyph(u, v) {
    if (u * u + v * v < 1e-12) return '⠂';
    let angle = Math.atan2(v, u);
    if (angle < 0) angle += Math.PI;
    return angle < Math.PI / 8 || angle > 7 * Math.PI / 8 ? '⠤' :
      angle < 3 * Math.PI / 8 ? '⠱' : angle < 5 * Math.PI / 8 ? '⠇' : '⠎';
  }

  // Backing pixels and CSS geometry are separate. Resizing the bitmap resets
  // Canvas state, so restore its transform even when the model is unchanged.
  function configureCanvas(canvas, ctx, { width, height, dpr }) {
    const scale = Math.min(dpr, MAX_BACKING_SCALE, Math.sqrt(MAX_BACKING_PIXELS / (width * height)),
      MAX_BACKING_AXIS / width, MAX_BACKING_AXIS / height);
    let pixelWidth = Math.max(1, Math.floor(width * scale));
    let pixelHeight = Math.max(1, Math.floor(height * scale));
    pixelWidth = Math.min(MAX_BACKING_AXIS, pixelWidth);
    pixelHeight = Math.min(MAX_BACKING_AXIS, pixelHeight);
    if (pixelWidth * pixelHeight > MAX_BACKING_PIXELS) {
      pixelHeight = Math.max(1, Math.floor(MAX_BACKING_PIXELS / pixelWidth));
    }
    const changed = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
    if (changed) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    return changed;
  }

  // Private display geometry, not the solver grid. Samples retain only fixed
  // interpolation stencils; their closures read the solver's current buffers.
  function createGlyphGrid(viewport, requested, fluid, streamlines) {
    // Begin at the area-based lower bound so very large viewports do not
    // overflow the candidate count before the resource cap can take effect.
    let cellW = Math.max(requested, Math.sqrt(viewport.width) * Math.sqrt(viewport.height) /
      Math.sqrt(MAX_GLYPH_CANDIDATES * GLYPH_ASPECT_RATIO)), cols, rows, cellH;
    do {
      cellH = cellW * GLYPH_ASPECT_RATIO;
      cols = Math.ceil(viewport.width / cellW) + 1;
      rows = Math.ceil(viewport.height / cellH) + 1;
      if (cols * rows <= MAX_GLYPH_CANDIDATES) break;
      cellW *= Math.sqrt(cols * rows / MAX_GLYPH_CANDIDATES) * 1.001;
    } while (true);
    const count = cols * rows;
    const short = Math.min(viewport.width, viewport.height), scale = 0.62 * short;
    const x = new Float64Array(cols), y = new Float64Array(rows);
    const noise = new Float32Array(count), glyphNoise = new Float32Array(count);
    const broad = new Float32Array(count), grain = new Float32Array(count);
    for (let i = 0; i < cols; i++) x[i] = (i + 0.5) * cellW / short;
    for (let j = 0; j < rows; j++) {
      y[j] = (j + 0.5) * cellH / short;
      const Y = ((j + 0.5) * cellH - viewport.height / 2) / scale;
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i, X = ((i + 0.5) * cellW - viewport.width / 2) / scale;
        noise[k] = hash(i, j);
        glyphNoise[k] = hash(i + 53, j + 97);
        broad[k] = 0.5 + 0.5 * Math.sin(2.8 * X - 2.1 * Y);
        grain[k] = 0.5 + 0.5 * Math.sin(12 * X + 8.4 * Y);
      }
    }
    const fieldSamples = fluid.prepareSamplingGrid(x, y);
    const streamSamples = streamlines.prepareSamplingGrid(x, y);
    const batch = {
      heads: new Int32Array(256), tails: new Int32Array(256), next: new Int32Array(count),
      glyphs: new Array(count), x: new Float64Array(count), y: new Float64Array(count)
    };
    return {
      width: viewport.width, height: viewport.height, cellW, cellH, cols, rows,
      noise, glyphNoise, broad, grain, fieldSamples, streamSamples, batch
    };
  }

  /**
   * Owns all display caches and draw buffers; never advances the solver.
   * resize(viewport, fluid, cellSize) returns redraw/spacing information, or null
   * when hidden. The caller replaces the model on CSS-size changes, not DPR.
   * Call resize after viewport/model/spacing changes. draw reads only density
   * and contrast, uses current borrowed fields and reuses per-glyph storage.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {CanvasRenderingContext2D} ctx
   */
  function createAsciiRenderer(canvas, ctx) {
    /** @type {FieldSample} */
    const sample = { tracers: new Float64Array(2) };
    let viewport = null, fluid = null, streamlines = null, glyphGrid = null;
    let requestedCellSize = null;

    return {
      /**
       * @param {Viewport|null} nextViewport
       * @param {FluidSolver|null} nextFluid
       * @param {number} cellSize Requested CSS-pixel spacing, before resource caps.
       * @returns {{changed: boolean, effectiveCellSize: number}|null}
       */
      resize(nextViewport, nextFluid, cellSize) {
        if (!nextViewport || !nextFluid) {
          viewport = null;
          fluid = null;
          streamlines = null;
          glyphGrid = null;
          return null;
        }
        if (![nextViewport.width, nextViewport.height, nextViewport.dpr, cellSize].every(Number.isFinite) ||
            nextViewport.width <= 0 || nextViewport.height <= 0 || nextViewport.dpr <= 0 || cellSize <= 0) {
          throw new RangeError('Invalid renderer viewport or cell size');
        }
        const pixelsChanged = configureCanvas(canvas, ctx, nextViewport);
        const modelChanged = nextFluid !== fluid;
        const layoutChanged = modelChanged || !viewport ||
          viewport.width !== nextViewport.width || viewport.height !== nextViewport.height ||
          requestedCellSize !== cellSize;
        if (modelChanged) streamlines = createStreamlineField(nextFluid.view());
        if (layoutChanged) glyphGrid = createGlyphGrid(nextViewport, cellSize, nextFluid, streamlines);
        viewport = nextViewport;
        fluid = nextFluid;
        requestedCellSize = cellSize;
        return { changed: layoutChanged || pixelsChanged, effectiveCellSize: glyphGrid.cellW };
      },
      /** @param {{density: number, contrast: number}} settings */
      draw(settings) { drawFrame(ctx, glyphGrid, fluid, streamlines, settings, sample); }
    };
  }

  function drawFrame(ctx, glyphGrid, fluid, streamlines, settings, sample) {
    if (!glyphGrid || !fluid || !streamlines) return;
    streamlines.update(fluid.view());
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, glyphGrid.width, glyphGrid.height);
    ctx.font = `${Math.max(9, glyphGrid.cellW * 0.92)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const batch = glyphGrid.batch;
    batch.heads.fill(-1);
    for (let j = 0; j < glyphGrid.rows; j++) for (let i = 0; i < glyphGrid.cols; i++) {
      const k = j * glyphGrid.cols + i;
      // Level sets of the simulated streamfunction, not moving screen-space bands.
      const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * glyphGrid.streamSamples.sample(i, j) / CONTOUR_INTERVAL);
      const band = wave * wave * wave, broad = glyphGrid.broad[k], grain = glyphGrid.grain[k];
      const probability = Math.min(0.9, settings.density * (0.19 + 0.62 * band + 0.05 * broad * grain));
      if (glyphGrid.noise[k] >= probability) continue;
      glyphGrid.fieldSamples.sampleTracers(i, j, sample);
      const intensity = 1 - Math.exp(-1.5 * Math.max(0, sample.tracers[0] + sample.tracers[1]));
      const choice = glyphGrid.glyphNoise[k];
      let glyph;
      if (choice < 0.15) glyph = '⠁';
      else if (choice > 0.88) glyph = '⠂';
      else {
        glyphGrid.fieldSamples.sampleVelocity(i, j, sample);
        glyph = directionGlyph(sample.u, sample.v);
      }
      const alpha = Math.max(0.045, Math.min(0.9,
        settings.contrast * (0.17 + 0.54 * band + 0.18 * intensity + 0.06 * broad) * (0.68 + 0.32 * grain)));
      const level = Math.round(alpha * 255);
      batch.glyphs[k] = glyph;
      batch.x[k] = (i + 0.5) * glyphGrid.cellW;
      batch.y[k] = (j + 0.5) * glyphGrid.cellH;
      batch.next[k] = -1;
      if (batch.heads[level] < 0) batch.heads[level] = k;
      else batch.next[batch.tails[level]] = k;
      batch.tails[level] = k;
    }
    // Preserve row order within each brightness bucket and reuse its buffers.
    for (let level = 0; level < 256; level++) {
      let k = batch.heads[level];
      if (k < 0) continue;
      ctx.fillStyle = COLORS[level];
      do {
        ctx.fillText(batch.glyphs[k], batch.x[k], batch.y[k]);
        k = batch.next[k];
      } while (k >= 0);
    }
  }

  // Browser integration -----------------------------------------------------

  /** @type {Readonly<FlowSettings>} Canonical defaults; HTML values are a fallback. */
  const DEFAULT_SETTINGS = APPEARANCE.defaults;

  // DOM adapter: emits patches/reset requests, never mutates controller state.
  // Missing settings are optional; their absence must not disable the background.
  function bindFlowSettings(doc, onChange, onReset) {
    const toggle = doc.getElementById('settings-toggle');
    const panel = doc.getElementById('flow-settings');
    const close = doc.getElementById('settings-close');
    if (!toggle || !panel || !close) return { showSpeedLimit() {}, destroy() {} };
    const controls = [['density', 'density'], ['speed', 'speed'], ['contrast', 'contrast'], ['cell-size', 'cellSize']]
      .map(([id, key]) => [doc.getElementById(id), key]);
    const reset = doc.getElementById('settings-reset');
    const speedNote = doc.createElement('p');
    speedNote.className = 'flow-quality-note';
    speedNote.hidden = true;
    speedNote.setAttribute('aria-live', 'polite');
    speedNote.dataset.flowSpeedNote = '';
    const cellControl = doc.getElementById('cell-size');
    if (cellControl && cellControl.parentElement) cellControl.parentElement.after(speedNote);
    else panel.append(speedNote);

    function show(open) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    }
    function restoreControls() {
      for (const [control, key] of controls) if (control) control.value = DEFAULT_SETTINGS[key];
    }
    restoreControls();
    const listeners = [];
    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }
    listen(toggle, 'click', () => show(panel.hidden));
    listen(close, 'click', () => show(false));
    listen(doc, 'keydown', event => { if (event.key === 'Escape') show(false); });
    for (const [control, key] of controls) if (control) listen(control, 'input', event => {
      const value = Number(event.target.value);
      if (Number.isFinite(value)) onChange({ [key]: value });
    });
    if (reset) listen(reset, 'click', () => {
      restoreControls();
      onReset();
    });
    return {
      destroy() {
        for (const remove of listeners.splice(0)) remove();
        speedNote.remove();
      },
      showSpeedLimit(limited) {
        const text = limited ? 'Speed limited to keep the page responsive.' : '';
        if (speedNote.textContent !== text) speedNote.textContent = text;
        speedNote.hidden = !limited;
      }
    };
  }

  // Composition root: owns settings/model selection and translates browser
  // events into renderer/playback calls. Neither module reads DOM globals.
  function startBackground(canvas, ctx) {
    const settings = { ...DEFAULT_SETTINGS };
    const renderer = createAsciiRenderer(canvas, ctx);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let viewport = null;
    let fluid = null;
    let failed = false;
    let destroyed = false;
    let resizeObserver = null;
    const ui = bindFlowSettings(document, applySettings, resetSettings);
    const playback = createPlaybackDriver({
      clock: {
        now: () => performance.now(),
        requestFrame: callback => requestAnimationFrame(callback),
        cancelFrame: handle => cancelAnimationFrame(handle)
      },
      draw: () => renderer.draw(settings),
      onError: stopWithError,
      reportSpeedLimit: ui.showSpeedLimit
    });

    function stopWithError(error) {
      if (failed) return;
      failed = true;
      destroy(true);
      console.warn('ASCII fluid stopped safely:', error && error.message ? error.message : error);
    }
    function syncPlayback() {
      playback.configure({ fluid, speed: settings.speed, paused: failed || reducedMotion.matches || document.hidden });
    }
    function rebuildForViewport() {
      try {
        const { width, height } = canvas.getBoundingClientRect();
        const nextViewport = width > 0 && height > 0 ? { width, height, dpr: window.devicePixelRatio || 1 } : null;
        // Only a genuine CSS-size change selects a fresh model. DPR and glyph
        // spacing belong to the renderer and must never reseed the simulation.
        if (!nextViewport) fluid = null;
        else if (!viewport || width !== viewport.width || height !== viewport.height) {
          fluid = createDefaultFluid(width, height);
        }
        viewport = nextViewport;
        const result = renderer.resize(viewport, fluid, settings.cellSize);
        if (result && result.changed) renderer.draw(settings);
        syncPlayback();
      } catch (error) { stopWithError(error); }
    }
    /** @param {Partial<FlowSettings>} patch */
    function applySettings(patch) {
      const nextSettings = { ...settings, ...patch };
      if (![nextSettings.density, nextSettings.speed, nextSettings.contrast, nextSettings.cellSize].every(Number.isFinite) ||
          nextSettings.density < 0 || nextSettings.speed < 0 || nextSettings.contrast < 0 || nextSettings.cellSize < 1) return;
      Object.assign(settings, patch);
      try {
        if (Object.hasOwn(patch, 'cellSize')) renderer.resize(viewport, fluid, settings.cellSize);
        if (Object.hasOwn(patch, 'cellSize') || Object.hasOwn(patch, 'speed')) playback.resetRate();
        renderer.draw(settings);
        syncPlayback();
      } catch (error) { stopWithError(error); }
    }
    function resetSettings() {
      applySettings(DEFAULT_SETTINGS);
    }

    function destroy(keepSettings = false) {
      if (!keepSettings) ui.destroy();
      if (destroyed) return;
      destroyed = true;
      playback.destroy();
      if (resizeObserver) resizeObserver.disconnect();
      if (reducedMotion.removeEventListener) reducedMotion.removeEventListener('change', syncPlayback);
      else if (reducedMotion.removeListener) reducedMotion.removeListener(syncPlayback);
      document.removeEventListener('visibilitychange', syncPlayback);
      window.removeEventListener('resize', rebuildForViewport);
    }

    if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', syncPlayback);
    else if (reducedMotion.addListener) reducedMotion.addListener(syncPlayback);
    document.addEventListener('visibilitychange', syncPlayback);
    window.addEventListener('resize', rebuildForViewport);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(rebuildForViewport);
      resizeObserver.observe(canvas);
    }
    rebuildForViewport();
    return destroy;
  }

  // One owner per canvas. The disposer is safe to call more than once, and a
  // subsequent mount gets fresh listeners, observer, playback, and settings.
  const mounted = new WeakMap();
  function mountBackground(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('Invalid fluid canvas');
    if (mounted.has(canvas)) return mounted.get(canvas);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    const stop = startBackground(canvas, ctx);
    let disposed = false;
    function dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      mounted.delete(canvas);
    }
    mounted.set(canvas, dispose);
    return dispose;
  }

  // Standalone entry points: definitions above have no DOM/startup side effects.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      fft1D, createPeriodicPoissonSolver, createFluidSolver,
      createDefaultFluid, createStreamlineField, createPlaybackDriver, mountBackground
    };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.AsciiFluid = Object.freeze({ mount: mountBackground });
  try {
    const canvas = document.getElementById('ascii-flow');
    if (canvas) mountBackground(canvas);
  } catch (error) {
    console.warn('ASCII fluid could not start:', error && error.message ? error.message : error);
  }
})();
