/* ASCII flow background — canvas 2D, no dependencies.
   Each character is rendered as a monospace glyph.
   The flow follows level sets of an analytic stream function: u = dψ/dy, v = -dψ/dx.
   Color/density is modulated along those streamlines to produce the ridged, fluid appearance.
*/
(() => {
  'use strict';
  const canvas = document.getElementById('ascii-flow');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  const defaults = { density: 1, speed: 0.9, contrast: 1.1, cellSize: 8 };
  const params = { ...defaults };
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let cssW = 0, cssH = 0, dpr = 1, cols = 0, rows = 0, cellW = 0, cellH = 0;
  let running = false, frame = 0, lastTime = 0, elapsed = 0;
  let charCache = [];
  let xCoords, yCoords, wavePhases, waveYDerivatives, broadPhase, grains;
  const alphaColors = Array.from({ length: 256 }, (_, alpha) => `rgba(218,224,227,${alpha / 255})`);

  function hash(x, y) {
    // Deterministic pseudo-random noise per character cell.
    let v = Math.imul(x + 17, 374761393) + Math.imul(y + 29, 668265263);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  }

  // Tune these values to reshape the flow. Vortices are [x, y, radius, strength].
  // Geometry is cached during measure(), so reload after changing these values.
  const flow = {
    current: 0.25,
    // x/y control spatial frequency; optional warp bends the wave along y.
    waves: [
      { amplitude: 0.07, x: 3.2, y: 0, warp: 1.15, warpFrequency: 1.75, speed: -0.18 },
      { amplitude: 0.05, x: -1.2, y: 3.45, speed: 0.12 },
      // { amplitude: 0.03, x: 2.8, y: 3.8, speed: 0.075 },
    ],
    vortexDrift: { x: 0.045, y: 0.037, xSpeed: 0.12, ySpeed: 0.14, xPhase: 2.3, yPhase: 1.8 },
    bands: { frequency: 30.5, sharpness: 3.3, speed: 0.3 }
  };
  // Each vortex is [x, y, radius, strength]: x/y locate its center in normalized
  // flow coordinates (positive y is down); radius controls its spread, and the
  // sign and magnitude of strength control its direction and intensity.
  const vortices = [
    // Two broad, low-frequency swirls.
    [-1.12, 0.34, 1.10, 0.78],
    [0.88, -0.38, 1.15, -0.93],
    // Three smaller, high-frequency swirls.
    [1.23, 0.66, 0.32, 0.35],
    [-0.3, -0.92, 0.35, -0.30],
    [0.10, 0.42, 0.28, 0.28]
  ];

  const vortexRadiusSquared = vortices.map(([, , radius]) => radius * radius);
  // Updated once per draw; shared by the stream and gradient calculations.
  const vortexX = new Float64Array(vortices.length);
  const vortexY = new Float64Array(vortices.length);
  // Reused immediately for the current cell's gradient, when needed.
  const vortexContributions = new Float64Array(vortices.length);

  function stream(x, y, t, index) {
    let psi = flow.current * y;
    for (let i = 0; i < flow.waves.length; i++) {
      const wave = flow.waves[i];
      psi += wave.amplitude * Math.sin(wavePhases[i][index] + t * wave.speed);
    }
    for (let i = 0; i < vortices.length; i++) {
      const amp = vortices[i][3];
      const dx = x - vortexX[i];
      const dy = y - vortexY[i];
      const contribution = amp * Math.exp(-(dx * dx + dy * dy) / vortexRadiusSquared[i]);
      vortexContributions[i] = contribution;
      psi += contribution;
    }
    return psi;
  }

  function streamGradient(x, y, t, index, row) {
    let dxPsi = 0;
    let dyPsi = flow.current;
    for (let i = 0; i < flow.waves.length; i++) {
      const wave = flow.waves[i];
      const derivative = wave.amplitude * Math.cos(wavePhases[i][index] + t * wave.speed);
      dxPsi += wave.x * derivative;
      dyPsi += waveYDerivatives[i][row] * derivative;
    }
    for (let i = 0; i < vortices.length; i++) {
      const dx = x - vortexX[i];
      const dy = y - vortexY[i];
      const factor = -2 * vortexContributions[i] / vortexRadiusSquared[i];
      dxPsi += factor * dx;
      dyPsi += factor * dy;
    }
    return [dxPsi, dyPsi];
  }

  function measure() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.round(rect.width);
    cssH = Math.round(rect.height);
    if (!cssW || !cssH) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cellW = params.cellSize;
    cellH = params.cellSize * 1.28;
    cols = Math.ceil(cssW / cellW) + 1;
    rows = Math.ceil(cssH / cellH) + 1;
    ctx.font = `${Math.max(9, params.cellSize * 0.92)}px "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    charCache = Array.from({length: cols * rows}, (_, i) => hash(i % cols, Math.floor(i / cols)));
    const scale = Math.min(cssW, cssH) * 0.62;
    xCoords = new Float64Array(cols);
    yCoords = new Float64Array(rows);
    wavePhases = flow.waves.map(() => new Float64Array(cols * rows));
    waveYDerivatives = flow.waves.map(() => new Float64Array(rows));
    broadPhase = new Float64Array(cols * rows);
    grains = new Float64Array(cols * rows);
    for (let ix = 0; ix < cols; ix++) {
      xCoords[ix] = (ix * cellW + cellW * 0.5 - cssW * 0.5) / scale;
    }
    for (let iy = 0; iy < rows; iy++) {
      const y = (iy * cellH + cellH * 0.5 - cssH * 0.5) / scale;
      yCoords[iy] = y;
      for (let i = 0; i < flow.waves.length; i++) {
        const wave = flow.waves[i];
        const warp = wave.warp ?? 0;
        const frequency = wave.warpFrequency ?? 0;
        const yPhase = wave.y * y + warp * Math.sin(frequency * y);
        waveYDerivatives[i][iy] = wave.y + warp * frequency * Math.cos(frequency * y);
        for (let ix = 0; ix < cols; ix++) {
          wavePhases[i][iy * cols + ix] = wave.x * xCoords[ix] + yPhase;
        }
      }
      for (let ix = 0; ix < cols; ix++) {
        const index = iy * cols + ix;
        const x = xCoords[ix];
        broadPhase[index] = x * 2.8 - y * 2.1;
        grains[index] = 0.5 + 0.5 * Math.sin(x * 12 + y * 8.4);
      }
    }
    draw(elapsed);
  }

  function draw(t) {
    if (!cols) return;
    ctx.fillStyle = '#0a0b0d';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.font = `${Math.max(9, params.cellSize * 0.92)}px "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const vd = flow.vortexDrift;
    for (let i = 0; i < vortices.length; i++) {
      vortexX[i] = vortices[i][0] + vd.x * Math.sin(t * vd.xSpeed + i * vd.xPhase);
      vortexY[i] = vortices[i][1] + vd.y * Math.cos(t * vd.ySpeed + i * vd.yPhase);
    }
    const drift = t * flow.bands.speed;
    for (let iy = 0; iy < rows; iy++) {
      const py = iy * cellH + cellH * 0.5;
      const y = yCoords[iy];
      for (let ix = 0; ix < cols; ix++) {
        const px = ix * cellW + cellW * 0.5;
        const x = xCoords[ix];
        const index = iy * cols + ix;
        const noise = charCache[index];
        // Coherent curves: this structure is constant along the streamlines.
        const psi = stream(x, y, t, index);
        const bands = Math.pow(0.5 + 0.5 * Math.cos(psi * flow.bands.frequency + drift), flow.bands.sharpness);
        const broad = 0.5 + 0.5 * Math.sin(broadPhase[index] + t * 0.13);
        const grain = grains[index];
        const envelope = 0.12 + 0.67 * bands + 0.2 * broad * grain;
        if (noise > Math.min(0.99, params.density * envelope)) continue;

        let variants;
        if (noise < 0.15) variants = '⠁';
        else if (noise > 0.88) variants = '⠂';
        else {
          // Perpendicular to ∇ψ, tangent to the contour lines.
          const [dxPsi, dyPsi] = streamGradient(x, y, t, index, iy);
          let angle = Math.atan2(-dxPsi, dyPsi);
          if (angle < 0) angle += Math.PI;
          variants = angle < Math.PI / 8 || angle > 7 * Math.PI / 8 ? '⠤'
            : angle < 3 * Math.PI / 8 ? '⠱'
            : angle < 5 * Math.PI / 8 ? '⠇'
            : '⠎';
        }
        const lum = (0.17 + 0.56 * bands + 0.12 * broad) * params.contrast;
        const alpha = Math.max(0.045, Math.min(0.9, lum * (0.65 + 0.35 * grain)));
        ctx.fillStyle = alphaColors[Math.round(alpha * 255)];
        ctx.fillText(variants, px, py);
      }
    }
  }

  function tick(now) {
    if (!running) return;
    frame = requestAnimationFrame(tick);
    if (now - lastTime < 1000 / 24) return;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.08) : 0;
    lastTime = now;
    elapsed += dt * params.speed;
    draw(elapsed);
  }
  function stop() { running = false; cancelAnimationFrame(frame); frame = 0; }
  function start() {
    if (running) return;
    running = true; lastTime = 0;
    frame = requestAnimationFrame(tick);
  }
  function syncAnimation() {
    if (prefersReducedMotion.matches || document.hidden || params.speed === 0) {
      stop(); draw(elapsed);
    } else start();
  }
  if (prefersReducedMotion.addEventListener) prefersReducedMotion.addEventListener('change', syncAnimation);
  else prefersReducedMotion.addListener(syncAnimation);
  document.addEventListener('visibilitychange', syncAnimation);
  const resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(canvas);

  const toggle = document.getElementById('settings-toggle');
  const settings = document.getElementById('flow-settings');
  const close = document.getElementById('settings-close');
  function showSettings(open) {
    settings.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => showSettings(settings.hidden));
  close.addEventListener('click', () => showSettings(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') showSettings(false); });
  for (const [id, key] of [['density','density'],['speed','speed'],['contrast','contrast'],['cell-size','cellSize']]) {
    document.getElementById(id).addEventListener('input', e => {
      params[key] = Number(e.target.value);
      if (key === 'cellSize') measure();
      else { draw(elapsed); syncAnimation(); }
    });
  }
  document.getElementById('settings-reset').addEventListener('click', () => {
    Object.assign(params, defaults);
    for (const [id, key] of [['density','density'],['speed','speed'],['contrast','contrast'],['cell-size','cellSize']]) document.getElementById(id).value = defaults[key];
    measure(); syncAnimation();
  });
  measure();
  syncAnimation();
})();
