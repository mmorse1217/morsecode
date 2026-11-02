/* Analytic flow contours rendered as ASCII glyphs on a canvas. */
(() => {
  'use strict';

  // Visual tuning. Flow coordinates are normalized to the shorter canvas edge.
  const DEFAULTS = { density: 1, speed: 0.9, contrast: 1.1, cellSize: 8 };
  const FLOW = {
    current: 0.25,
    waves: [
      { amplitude: 0.07, x: 3.2, y: 0, warp: 1.15, warpFrequency: 1.75, speed: -0.18 },
      { amplitude: 0.05, x: -1.2, y: 3.45, speed: 0.12 }
    ],
    // [center x, center y, radius, strength]; positive y points down.
    vortices: [
      [-1.12, 0.34, 1.10, 0.78], [0.88, -0.38, 1.15, -0.93],
      [1.23, 0.66, 0.32, 0.35], [-0.3, -0.92, 0.35, -0.30],
      [0.10, 0.42, 0.28, 0.28]
    ],
    vortexDrift: { x: 0.045, y: 0.037, xSpeed: 0.12, ySpeed: 0.14, xPhase: 2.3, yPhase: 1.8 },
    bands: { frequency: 30.5, sharpness: 3.3, speed: 0.3 }
  };
  const STYLE = {
    background: '#0a0b0d', glyphColor: '218,224,227', alphaSteps: 255,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    minFontSize: 9, fontScale: 0.92, cellAspect: 1.28, maxPixelRatio: 2,
    coordinateScale: 0.62, gridPadding: 1,
    broadX: 2.8, broadY: -2.1, broadSpeed: 0.13, grainX: 12, grainY: 8.4,
    densityBase: 0.12, densityBands: 0.67, densityGrain: 0.2, maxDensity: 0.99,
    sparseGlyphThreshold: 0.15, lightGlyphThreshold: 0.88,
    luminanceBase: 0.17, luminanceBands: 0.56, luminanceBroad: 0.12,
    grainAlphaBase: 0.65, grainAlphaWeight: 0.35, minAlpha: 0.045, maxAlpha: 0.9
  };
  const ANIMATION = { framesPerSecond: 24, maxDeltaSeconds: 0.08 };
  const ALPHA_COLORS = Array.from({ length: STYLE.alphaSteps + 1 }, (_, alpha) =>
    `rgba(${STYLE.glyphColor},${alpha / STYLE.alphaSteps})`);

  // Stable cell noise: the integer constants are the hash algorithm's mixing constants.
  function hash(x, y) {
    let v = Math.imul(x + 17, 374761393) + Math.imul(y + 29, 668265263);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  }

  // Compute the canvas size and return its dimensions. A hidden canvas has no grid.
  function initializeCanvas(canvas, ctx, pixelRatio, style) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width), height = Math.round(rect.height);
    if (!width || !height) return null;
    const dpr = Math.min(pixelRatio || 1, style.maxPixelRatio);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
  }

  // Initialize immutable per-cell geometry and noise for this size and flow.
  function initializeFlowArrays(size, cellSize, flow, style) {
    const cellW = cellSize, cellH = cellSize * style.cellAspect;
    const cols = Math.ceil(size.width / cellW) + style.gridPadding;
    const rows = Math.ceil(size.height / cellH) + style.gridPadding;
    const scale = Math.min(size.width, size.height) * style.coordinateScale;
    const x = new Float64Array(cols), y = new Float64Array(rows);
    const noise = new Float64Array(cols * rows);
    const broad = new Float64Array(cols * rows), grain = new Float64Array(cols * rows);
    const phases = flow.waves.map(() => new Float64Array(cols * rows));
    const yDerivatives = flow.waves.map(() => new Float64Array(rows));
    for (let ix = 0; ix < cols; ix++) x[ix] = (ix * cellW + cellW * 0.5 - size.width * 0.5) / scale;
    for (let iy = 0; iy < rows; iy++) {
      y[iy] = (iy * cellH + cellH * 0.5 - size.height * 0.5) / scale;
      for (let w = 0; w < flow.waves.length; w++) {
        const wave = flow.waves[w], warp = wave.warp ?? 0, frequency = wave.warpFrequency ?? 0;
        const yPhase = wave.y * y[iy] + warp * Math.sin(frequency * y[iy]);
        yDerivatives[w][iy] = wave.y + warp * frequency * Math.cos(frequency * y[iy]);
        for (let ix = 0; ix < cols; ix++) phases[w][iy * cols + ix] = wave.x * x[ix] + yPhase;
      }
      for (let ix = 0; ix < cols; ix++) {
        const index = iy * cols + ix;
        noise[index] = hash(ix, iy);
        broad[index] = x[ix] * style.broadX + y[iy] * style.broadY;
        grain[index] = 0.5 + 0.5 * Math.sin(x[ix] * style.grainX + y[iy] * style.grainY);
      }
    }
    return { ...size, cellW, cellH, cols, rows, x, y, noise, broad, grain, phases, yDerivatives };
  }

  // Frame-local vortex positions; no state is shared between frame calculations.
  function positionVortices(flow, time) {
    const drift = flow.vortexDrift;
    return flow.vortices.map(([x, y, radius, strength], i) => ({
      x: x + drift.x * Math.sin(time * drift.xSpeed + i * drift.xPhase),
      y: y + drift.y * Math.cos(time * drift.ySpeed + i * drift.yPhase),
      radiusSquared: radius * radius, strength
    }));
  }

  // Calculate the value and gradient together, without a call-order dependency.
  function sampleFlow(grid, flow, vortices, ix, iy, time) {
    const index = iy * grid.cols + ix, x = grid.x[ix], y = grid.y[iy];
    let psi = flow.current * y, dx = 0, dy = flow.current;
    for (let i = 0; i < flow.waves.length; i++) {
      const wave = flow.waves[i], phase = grid.phases[i][index] + time * wave.speed;
      psi += wave.amplitude * Math.sin(phase);
      const derivative = wave.amplitude * Math.cos(phase);
      dx += wave.x * derivative;
      dy += grid.yDerivatives[i][iy] * derivative;
    }
    for (const vortex of vortices) {
      const vx = x - vortex.x, vy = y - vortex.y;
      const contribution = vortex.strength * Math.exp(-(vx * vx + vy * vy) / vortex.radiusSquared);
      psi += contribution;
      const factor = -2 * contribution / vortex.radiusSquared;
      dx += factor * vx;
      dy += factor * vy;
    }
    return { psi, dx, dy };
  }

  function directionGlyph(dx, dy) {
    let angle = Math.atan2(-dx, dy);
    if (angle < 0) angle += Math.PI;
    return angle < Math.PI / 8 || angle > 7 * Math.PI / 8 ? '⠤'
      : angle < 3 * Math.PI / 8 ? '⠱' : angle < 5 * Math.PI / 8 ? '⠇' : '⠎';
  }

  // Pass 3: draw one frame from explicit inputs. Only the canvas is mutated.
  function drawFrame(ctx, grid, flow, style, params, time) {
    if (!grid) return;
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, grid.width, grid.height);
    ctx.font = `${Math.max(style.minFontSize, params.cellSize * style.fontScale)}px ${style.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const vortices = positionVortices(flow, time);
    const drift = time * flow.bands.speed;
    for (let iy = 0; iy < grid.rows; iy++) {
      for (let ix = 0; ix < grid.cols; ix++) {
        const index = iy * grid.cols + ix, noise = grid.noise[index];
        const sample = sampleFlow(grid, flow, vortices, ix, iy, time);
        const bands = Math.pow(0.5 + 0.5 * Math.cos(sample.psi * flow.bands.frequency + drift), flow.bands.sharpness);
        const broad = 0.5 + 0.5 * Math.sin(grid.broad[index] + time * style.broadSpeed);
        const grain = grid.grain[index];
        const envelope = style.densityBase + style.densityBands * bands + style.densityGrain * broad * grain;
        if (noise > Math.min(style.maxDensity, params.density * envelope)) continue;
        const glyph = noise < style.sparseGlyphThreshold ? '⠁'
          : noise > style.lightGlyphThreshold ? '⠂' : directionGlyph(sample.dx, sample.dy);
        const lum = (style.luminanceBase + style.luminanceBands * bands + style.luminanceBroad * broad) * params.contrast;
        const alpha = Math.max(style.minAlpha, Math.min(style.maxAlpha, lum * (style.grainAlphaBase + style.grainAlphaWeight * grain)));
        ctx.fillStyle = ALPHA_COLORS[Math.round(alpha * style.alphaSteps)];
        ctx.fillText(glyph, ix * grid.cellW + grid.cellW * 0.5, iy * grid.cellH + grid.cellH * 0.5);
      }
    }
  }

  // Browser integration owns the mutable lifecycle; the passes above do not.
  function startBackground(canvas, ctx) {
    const params = { ...DEFAULTS };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let grid = null, running = false, frame = 0, lastTime = 0, elapsed = 0;
    function draw() { drawFrame(ctx, grid, FLOW, STYLE, params, elapsed); }
    function rebuild() {
      const size = initializeCanvas(canvas, ctx, window.devicePixelRatio, STYLE);
      grid = size ? initializeFlowArrays(size, params.cellSize, FLOW, STYLE) : null;
      draw();
    }
    function tick(now) {
      if (!running) return;
      frame = requestAnimationFrame(tick);
      if (now - lastTime < 1000 / ANIMATION.framesPerSecond) return;
      const dt = lastTime ? Math.min((now - lastTime) / 1000, ANIMATION.maxDeltaSeconds) : 0;
      lastTime = now;
      elapsed += dt * params.speed;
      draw();
    }
    function syncAnimation() {
      if (reducedMotion.matches || document.hidden || params.speed === 0) {
        running = false;
        cancelAnimationFrame(frame);
        frame = 0;
        draw();
      } else if (!running) {
        running = true;
        lastTime = 0;
        frame = requestAnimationFrame(tick);
      }
    }
    if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', syncAnimation);
    else reducedMotion.addListener(syncAnimation);
    document.addEventListener('visibilitychange', syncAnimation);
    new ResizeObserver(rebuild).observe(canvas);
    setupSettings(params, () => { draw(); syncAnimation(); }, () => { rebuild(); syncAnimation(); });
    rebuild();
    syncAnimation();
  }

  function setupSettings(params, redraw, rebuild) {
    const toggle = document.getElementById('settings-toggle');
    const settings = document.getElementById('flow-settings');
    const close = document.getElementById('settings-close');
    if (!toggle || !settings || !close) return;
    const controls = [['density', 'density'], ['speed', 'speed'], ['contrast', 'contrast'], ['cell-size', 'cellSize']]
      .map(([id, key]) => [document.getElementById(id), key]);
    const reset = document.getElementById('settings-reset');
    function showSettings(open) {
      settings.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    }
    toggle.addEventListener('click', () => showSettings(settings.hidden));
    close.addEventListener('click', () => showSettings(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') showSettings(false); });
    for (const [control, key] of controls) {
      if (!control) continue;
      control.addEventListener('input', e => {
        params[key] = Number(e.target.value);
        if (key === 'cellSize') rebuild();
        else redraw();
      });
    }
    if (reset) reset.addEventListener('click', () => {
      Object.assign(params, DEFAULTS);
      for (const [control, key] of controls) if (control) control.value = DEFAULTS[key];
      rebuild();
    });
  }

  const canvas = document.getElementById('ascii-flow');
  const ctx = canvas && canvas.getContext('2d', { alpha: false });
  if (ctx) startBackground(canvas, ctx);
})();
