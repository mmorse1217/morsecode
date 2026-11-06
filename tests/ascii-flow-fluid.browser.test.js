'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

// Browser checks are optional; the numerical tests need only Node.
const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find(file => file && fs.existsSync(file));

test('fluid background honors controls, screen limits, and sustained motion', {
  skip: !chrome || typeof WebSocket === 'undefined' ? 'Chrome and Node with WebSocket are required' : false,
  timeout: 60000
}, async t => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-flow-test-'));
  const base = pathToFileURL(root + path.sep).href;
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('<head>', `<head><base href="${base}">`);
  const preview = path.join(temp, 'preview.html');
  const previewWithoutSettings = path.join(temp, 'without-settings.html');
  fs.writeFileSync(preview, html);
  fs.writeFileSync(previewWithoutSettings, html.replace(/<aside class="settings"[\s\S]*?<\/aside>/, ''));

  const profile = path.join(temp, 'chrome');
  const browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1000,700',
    'about:blank'
  ], { stdio: 'ignore' });
  let socket;
  t.after(async () => {
    if (socket) socket.close();
    browser.kill();
    if (browser.exitCode === null && browser.signalCode === null) {
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), sleep(2000)]);
    }
    // Chrome's child processes can still be closing profile files after the
    // browser process exits; retry transient ENOTEMPTY/EBUSY during cleanup.
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });

  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await sleep(50);
  assert.ok(fs.existsSync(portFile), 'Chrome did not start');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let id = 0;
  const pending = new Map(), errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const nextId = ++id;
    pending.set(nextId, { resolve, reject });
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  const setControl = (id, value) => evaluate(`(() => {
    const control = document.getElementById(${JSON.stringify(id)});
    control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const count = () => evaluate('window.__draws');
  const hash = () => evaluate(`(() => {
    const canvas = document.getElementById('ascii-flow');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 16) hash = Math.imul(hash ^ data[i], 16777619);
    return hash;
  })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com/*', '*fonts.gstatic.com/*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 700, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__draws = 0;
    window.__captureContour = true;
    window.__expectedModes = [1, 1, 2, 1];
    window.__captureBatch = true;
    const originalFillRect = CanvasRenderingContext2D.prototype.fillRect;
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    const originalFillStyle = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'fillStyle');
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'fillStyle', { ...originalFillStyle, set(value) {
      if (window.__captureBatch && this.canvas.id === 'ascii-flow') window.__styleWrites++;
      originalFillStyle.set.call(this, value);
    } });
    CanvasRenderingContext2D.prototype.fillRect = function(...args) {
      if (this.canvas.id === 'ascii-flow') {
        window.__draws++;
        if (window.__captureBatch) {
          window.__styleWrites = 0; window.__batchCalls = []; window.__batchBackground = this.fillStyle;
        }
        window.__tiles = Array.from({ length: 9 }, () => ({ total: 0, directional: 0 }));
        if (window.__captureContour) window.__contourStats = { high: 0, highN: 0, low: 0, lowN: 0 };
      }
      return originalFillRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      if (window.__captureBatch && this.canvas.id === 'ascii-flow') window.__batchCalls.push([text, x, y, this.fillStyle]);
      const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
      if (this.canvas.id === 'ascii-flow' && x >= 0 && x < width && y >= 0 && y < height) {
        const index = Math.floor(y * 3 / height) * 3 + Math.floor(x * 3 / width);
        const tile = window.__tiles[index];
        tile.total++;
        if (text !== '⠁' && text !== '⠂') tile.directional++;
        if (window.__captureContour) {
          // Independent analytical streamfunction used only for the initial
          // seeded state; later frames are checked separately for motion.
          const px = x / width, py = y / height, tau = 2 * Math.PI;
          const [mx, my, sx, sy] = window.__expectedModes;
          const psi = 0.015 * Math.sin(tau * mx * px) * Math.sin(tau * my * py) +
            0.006 * Math.sin(tau * (sx * px + sy * py));
          const strength = (0.5 + 0.5 * Math.cos(tau * psi / 0.005)) ** 3;
          const color = this.fillStyle, alpha = Number(color.slice(color.lastIndexOf(',') + 1, -1));
          if (strength > 0.72) { window.__contourStats.high += alpha; window.__contourStats.highN++; }
          else if (strength < 0.08) { window.__contourStats.low += alpha; window.__contourStats.lowN++; }
        }
      }
      return originalFillText.call(this, text, x, y, ...args);
    };
  ` });
  await send('Page.navigate', { url: pathToFileURL(preview).href });
  for (let i = 0; i < 100 && !(await evaluate('window.__draws > 0')); i++) await sleep(50);
  await sleep(300); // Let the initial ResizeObserver notification settle.
  const reduced = await count();
  assert.ok(reduced > 0, 'reduced motion still needs an initial frame');
  const buttonBackdrop = await evaluate(`(() => {
    const style = getComputedStyle(document.getElementById('settings-toggle'), '::before');
    const center = getComputedStyle(document.querySelector('.hero-shade')).backgroundImage;
    const stops = background => (background.match(/rgba\\([^)]*\\)\\s+\\d+%/g) || []).slice(0, 4);
    return { background: style.backgroundImage, pointerEvents: style.pointerEvents,
      buttonStops: stops(style.backgroundImage), centerStops: stops(center) };
  })()`);
  assert.match(buttonBackdrop.background, /^radial-gradient\(/, 'settings button should have a soft backdrop');
  assert.equal(buttonBackdrop.buttonStops.length, 4);
  assert.deepEqual(buttonBackdrop.buttonStops, buttonBackdrop.centerStops, 'button and center should use the same shade');
  assert.equal(buttonBackdrop.pointerEvents, 'none', 'the backdrop must not intercept input');
  // Deliberately overlap an opaque specialty marker and the button backdrop.
  // Inspect a rendered pixel, not just z-index values, to catch stacking-context regressions.
  await evaluate(`(() => {
    const fixture = document.createElement('div');
    fixture.id = 'backdrop-layer-test'; fixture.className = 'hero-bottom';
    fixture.setAttribute('aria-hidden', 'true');
    fixture.style.cssText = 'position:fixed;z-index:9999;top:0;left:0;width:160px;height:100px;min-height:0;padding:0;margin:0;background:white';
    fixture.innerHTML = '<span class="hero-bottom-text" style="position:absolute;top:45px;left:75px;width:10px;height:10px;background:red"></span>' +
      '<button class="settings-toggle" style="top:25px;left:40px;right:auto;bottom:auto;width:80px;height:50px;padding:0"></button>';
    document.body.append(fixture);
  })()`);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 60, y: 50, width: 21, height: 1, scale: 1 } });
  const backdropPixels = await evaluate(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify('data:image/png;base64,')} + ${JSON.stringify(screenshot.data)};
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 21; canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, 21, 1).data;
    return { shade: Array.from(pixels.slice(0, 4)), marker: Array.from(pixels.slice(80, 84)) };
  })()`);
  await evaluate("document.getElementById('backdrop-layer-test').remove()");
  assert.ok(backdropPixels.shade.slice(0, 3).every(value => value < 100), 'the backdrop must still darken its background');
  assert.deepEqual(backdropPixels.marker, [255, 0, 0, 255], 'the backdrop must be behind the specialties');
  assert.deepEqual(await evaluate("Array.from(document.scripts, s => s.getAttribute('src')).filter(s => s && s.includes('ascii-flow'))"),
    ['assets/ascii-flow-fluid.js'], 'the actual landing page must select only the reviewed fluid renderer');
  assert.deepEqual(await evaluate(`(() => {
    const speed = document.getElementById('speed');
    return { value: speed.value, defaultValue: speed.defaultValue, min: speed.min, step: speed.step };
  })()`), { value: '0.4', defaultValue: '0.4', min: '0', step: '0.1' },
  'default to a model-time speed of 0.4');
  assert.deepEqual(await evaluate(`(() => {
    const viscosity = document.getElementById('viscosity');
    return { value: viscosity.value, min: viscosity.min, max: viscosity.max, step: viscosity.step };
  })()`), { value: '0.003', min: '0.0005', max: '0.01', step: '0.0005' });
  assert.equal(await evaluate("document.getElementById('viscosity-setting').hidden"), false);
  assert.equal(await evaluate("document.getElementById('viscosity-setting').textContent.trim()"), 'Viscosity');
  const batching = await evaluate(`(() => {
    window.__captureBatch = false;
    const canvas = document.getElementById('ascii-flow'), ctx = canvas.getContext('2d');
    const reference = document.createElement('canvas');
    reference.width = canvas.width; reference.height = canvas.height;
    const ref = reference.getContext('2d', { alpha: false });
    ref.setTransform(ctx.getTransform()); ref.font = ctx.font;
    ref.textAlign = ctx.textAlign; ref.textBaseline = ctx.textBaseline;
    ref.fillStyle = window.__batchBackground;
    const size = canvas.getBoundingClientRect(); ref.fillRect(0, 0, size.width, size.height);
    // Repaint the real emitted commands in the original row-major order. This
    // checks that reordering colors did not change antialiasing/compositing.
    const commands = window.__batchCalls.slice().sort((a,b) => a[2]-b[2] || a[1]-b[1]);
    for (const [glyph, x, y, color] of commands) { ref.fillStyle = color; ref.fillText(glyph, x, y); }
    const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const expected = ref.getImageData(0, 0, canvas.width, canvas.height).data;
    let different = 0;
    for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) different++;
    return { glyphs: commands.length, colors: new Set(commands.map(x => x[3])).size,
      colorWrites: window.__styleWrites, different };
  })()`);
  assert.ok(batching.glyphs > 256, 'the rendering test needs enough glyphs to exercise grouping');
  assert.equal(batching.colorWrites, batching.colors, 'each used brightness should need only one color assignment');
  assert.ok(batching.colors <= 256, 'retain the existing 256-level palette');
  assert.equal(batching.different, 0, 'brightness grouping must preserve the row-major reference image');
  const contours = await evaluate('window.__captureContour = false; window.__contourStats');
  assert.ok(contours.highN > 20 && contours.lowN > 20, 'need visible samples both on and between streamlines');
  assert.ok(contours.high / contours.highN > 1.5 * contours.low / contours.lowN,
    `glyph intensity should reveal the initial velocity streamlines: ${JSON.stringify(contours)}`);
  await sleep(300);
  assert.equal(await count(), reduced, 'reduced motion must not animate');

  // A real CSS resize starts a new solver with aspect-aware periodic inputs.
  // Compare the rendered still to independently specified initial modes.
  for (const [width, height, modes] of [[360, 1080, [1, 3, 2, 2]], [1080, 360, [3, 1, 5, 1]]]) {
    await evaluate(`window.__expectedModes = ${JSON.stringify(modes)}; window.__captureContour = true;`);
    const previous = await count();
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 100 && await count() === previous; i++) await sleep(50);
    await sleep(100);
    const stats = await evaluate('window.__captureContour = false; window.__contourStats');
    assert.ok(await count() > previous, 'a geometry change should redraw the still');
    assert.ok(stats.highN > 20 && stats.lowN > 20 && stats.high / stats.highN > 1.5 * stats.low / stats.lowN,
      `rendered streamlines should reflect the ${width}×${height} initial domain: ${JSON.stringify(stats)}`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  const paused = await count();
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await sleep(400);
  assert.ok(await count() > paused, 'animation should resume');
  await evaluate("document.getElementById('settings-toggle').click()");
  assert.equal(await evaluate("document.getElementById('settings-toggle').getAttribute('aria-expanded')"), 'true');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert.equal(await evaluate("document.getElementById('flow-settings').hidden"), true);
  await setControl('speed', '0');
  await sleep(100);
  const stopped = await count(), before = await hash();
  await sleep(300);
  assert.equal(await count(), stopped, 'zero speed must stop animation');
  for (const viscosity of ['0.0005', '0.01']) {
    await setControl('viscosity', viscosity);
    assert.equal(await evaluate("document.getElementById('viscosity').value"), viscosity);
    assert.equal(await hash(), before, 'changing viscosity must not reset or advance the simulation');
  }
  await setControl('contrast', '1.8');
  await setControl('contrast', '1.1');
  await setControl('cell-size', '11');
  await setControl('cell-size', '8');
  assert.equal(await hash(), before, 'redraws and glyph size changes must not reset or advance the simulation');
  await setControl('density', '0.5');
  const resetSpeed = await evaluate(`(() => {
    document.getElementById('settings-reset').click();
    const speed = document.getElementById('speed'), restored = speed.value;
    speed.value = '0'; speed.dispatchEvent(new Event('input', { bubbles: true }));
    return restored;
  })()`);
  assert.equal(resetSpeed, '0.4', 'Reset defaults must restore the default model-time speed');
  assert.equal(await evaluate("document.getElementById('density').value"), '1');
  assert.equal(await evaluate("document.getElementById('viscosity').value"), '0.003');
  assert.equal(await hash(), before, 'reset restores settings without reseeding the simulation');
  await evaluate("window.dispatchEvent(new Event('resize'))");
  await sleep(100);
  assert.equal(await hash(), before, 'a no-op resize must not reseed the simulation');
  const viewport = await evaluate('({ width: window.innerWidth, height: window.innerHeight })');
  await evaluate('window.__captureBatch = true');
  await setControl('contrast', '1.1'); // Capture the actual current-state glyph commands.
  const beforeDpr = await evaluate(`(() => {
    const canvas = document.getElementById('ascii-flow'), size = canvas.getBoundingClientRect();
    return { glyphs: JSON.stringify(window.__batchCalls), cssWidth: size.width, cssHeight: size.height,
      font: canvas.getContext('2d').font };
  })()`);
  for (const dpr of [0.75, 1.25, 1.5, 2, 3]) {
    await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: dpr, mobile: false });
    await evaluate("window.dispatchEvent(new Event('resize'))");
    await sleep(100);
    const backing = await evaluate(`(() => {
      const canvas = document.getElementById('ascii-flow'), ctx = canvas.getContext('2d');
      const size = canvas.getBoundingClientRect();
      return { width: canvas.width, height: canvas.height, font: ctx.font,
        cssWidth: size.width, cssHeight: size.height,
        xScale: ctx.getTransform().a, yScale: ctx.getTransform().d,
        glyphs: JSON.stringify(window.__batchCalls) };
    })()`);
    const scale = Math.min(dpr, 2);
    assert.equal(backing.cssWidth, beforeDpr.cssWidth);
    assert.equal(backing.cssHeight, beforeDpr.cssHeight);
    assert.equal(backing.width, Math.floor(backing.cssWidth * scale), 'cap backing scale without changing CSS geometry');
    assert.equal(backing.height, Math.floor(backing.cssHeight * scale));
    // Chrome may store the current transform at Float32 precision.
    assert.ok(Math.abs(backing.xScale - backing.width / backing.cssWidth) < 1e-6);
    assert.ok(Math.abs(backing.yScale - backing.height / backing.cssHeight) < 1e-6);
    assert.equal(backing.font, beforeDpr.font, 'the font size in CSS units must not change');
    assert.equal(backing.glyphs, beforeDpr.glyphs, 'backing resolution must not change glyphs, positions, colors or model state');
  }
  await evaluate('window.__captureBatch = false');
  await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
  await evaluate("window.dispatchEvent(new Event('resize'))");
  await sleep(100);
  assert.equal(await hash(), before, 'DPR-only changes must not reseed the simulation');

  await setControl('speed', '0.9');
  await evaluate(`window.__hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    document.dispatchEvent(new Event('visibilitychange'));`);
  await sleep(100);
  const hidden = await count();
  await sleep(300);
  assert.equal(await count(), hidden, 'hidden documents must stop animation');
  await evaluate(`window.__hidden = false; document.dispatchEvent(new Event('visibilitychange'));`);
  await sleep(400);
  assert.ok(await count() > hidden, 'animation should resume after the tab becomes visible');

  await send('Emulation.setDeviceMetricsOverride', { width: 3840, height: 2160, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  const large = await evaluate(`({
    pixels: document.querySelector('canvas').width * document.querySelector('canvas').height,
    spacingNote: document.getElementById('flow-settings').textContent.includes('Spacing increased to')
  })`);
  assert.ok(large.pixels <= 6000000, 'backing-store size should stay within the configured cap');
  assert.equal(large.spacingNote, false, 'spacing adjustment should not appear in settings');

  await setControl('speed', '0');
  await send('Emulation.setDeviceMetricsOverride', { width: 520, height: 978, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  const coverage = await evaluate(`(() => {
    const canvas = document.querySelector('canvas'), width = canvas.width, height = canvas.height;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const bright = Array(9).fill(0), area = Array(9).fill(0);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = Math.floor(y * 3 / height) * 3 + Math.floor(x * 3 / width);
      area[index]++;
      if (pixels[(y * width + x) * 4] > 25) bright[index]++;
    }
    return { ratios: bright.map((value, index) => value / area[index]), tiles: window.__tiles };
  })()`);
  assert.ok(Math.min(...coverage.ratios) > 0.004, 'no large region should become nearly black');
  assert.ok(Math.max(...coverage.ratios) / Math.min(...coverage.ratios) < 5,
    'large regions should not be overwhelmingly bright or empty');
  for (const tile of coverage.tiles) {
    assert.ok(tile.total > 0 && tile.directional / tile.total > 0.45,
      'sparse regions should contain directional glyphs, not just dots');
  }

  // Drive the actual canvas animation with a controlled browser clock, so we
  // can check steady-state motion without waiting two minutes in real time.
  await send('Emulation.setDeviceMetricsOverride', { width: 260, height: 490, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const pending = new Map();
      let id = 0, now = 1000;
      // Control only this test's work clock; separately measure the real budget.
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
      window.requestAnimationFrame = callback => { const next = ++id; pending.set(next, callback); return next; };
      window.cancelAnimationFrame = handle => pending.delete(handle);
      window.__pendingFrames = () => pending.size;
      window.__advanceFrames = (frames, delta = 50) => {
        for (let i = 0; i < frames; i++) {
          now += delta;
          const callbacks = [...pending.values()];
          pending.clear();
          for (const callback of callbacks) callback(now);
        }
      };
    })();
  ` });
  await send('Page.navigate', { url: pathToFileURL(preview).href });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = await evaluate("typeof window.__advanceFrames === 'function' && window.__draws > 0"); }
    catch { /* The navigation may have replaced the execution context. */ }
    if (!ready) await sleep(50);
  }
  assert.ok(ready, 'controlled-clock preview did not start');
  await evaluate('window.__captureContour = false; window.__captureBatch = false');
  // Run from the same seed with each viscosity. A resize/reseed between
  // choosing viscosity and advancing must preserve the selected coefficient.
  const viscosityRuns = await evaluate(`(() => {
    const canvas = document.getElementById('ascii-flow');
    function setInput(id, value) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function run(viscosity, resize) {
      window.AsciiFluid.mount(canvas)();
      window.AsciiFluid.mount(canvas);
      setInput('speed', '0');
      setInput('viscosity', viscosity);
      if (resize) {
        canvas.style.width = '200px'; window.dispatchEvent(new Event('resize'));
        canvas.style.width = ''; window.dispatchEvent(new Event('resize'));
      }
      setInput('speed', '0.4');
      window.__advanceFrames(100);
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let i = 0; i < data.length; i += 16) hash = Math.imul(hash ^ data[i], 16777619);
      return hash;
    }
    const result = { high: run('0.01', false), highResized: run('0.01', true), low: run('0.0005', true) };
    window.AsciiFluid.mount(canvas)();
    window.AsciiFluid.mount(canvas);
    return result;
  })()`);
  assert.equal(viscosityRuns.highResized, viscosityRuns.high, 'resize must retain the selected viscosity');
  assert.notEqual(viscosityRuns.low, viscosityRuns.high, 'viscosity should affect the evolving flow');
  await sleep(200);
  const motion = await evaluate(`(() => {
    const canvas = document.getElementById('ascii-flow'), ctx = canvas.getContext('2d');
    function difference(frames) {
      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      window.__advanceFrames(frames);
      const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let total = 0, changed = 0;
      for (let i = 0; i < before.length; i += 4) {
        const delta = Math.abs(before[i] - after[i]);
        total += delta;
        if (delta > 10) changed++;
      }
      return { mean: total / (before.length / 4), fraction: changed / (before.length / 4) };
    }
    window.__advanceFrames(400); // 20 seconds; allow initial dye to circulate.
    const early = difference(60);
    window.__advanceFrames(740); // Advance to 60 seconds.
    const middle = difference(60);
    window.__advanceFrames(1140); // Advance to two minutes.
    const late = difference(60);
    return { early, middle, late };
  })()`);
  for (const sample of Object.values(motion)) {
    assert.ok(sample.fraction > 0.015, 'the visible canvas should keep changing');
  }
  assert.ok(motion.late.mean > motion.early.mean * 0.8,
    `motion after two minutes should not settle compared with the early steady state: ${JSON.stringify(motion)}`);
  assert.equal(await evaluate('window.__pendingFrames()'), 1, 'only one animation loop should own the canvas');
  await setControl('speed', '2.5');
  await evaluate('window.__advanceFrames(15, 400)');
  const speedLimited = await evaluate(`(() => {
    const note = document.querySelector('[data-flow-speed-note]');
    return note && !note.hidden && note.textContent.includes('limited');
  })()`);
  assert.ok(speedLimited, 'slow foreground frames should report the loss of model-time speed');
  await setControl('speed', '0');
  assert.equal(await evaluate("document.querySelector('[data-flow-speed-note]').hidden"), true);
  assert.equal(await evaluate('window.__pendingFrames()'), 0, 'speed zero should cancel the animation loop');

  await setControl('speed', '0.9');
  await evaluate('window.__advanceFrames(25)');
  const beforeHiddenJump = await hash();
  await evaluate(`window.__hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    document.dispatchEvent(new Event('visibilitychange')); window.__advanceFrames(600);
    window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); window.__advanceFrames(1);`);
  assert.equal(await hash(), beforeHiddenJump, 'resuming after a hidden interval must not fast-forward the model');

  await evaluate("document.getElementById('ascii-flow').style.display = 'none'");
  await sleep(100);
  const zeroSizeDraws = await count();
  await evaluate('window.__advanceFrames(10)');
  assert.equal(await count(), zeroSizeDraws, 'zero-size canvas must stop its loop');
  await evaluate("document.getElementById('ascii-flow').style.display = ''");
  await sleep(100);
  await evaluate('window.__advanceFrames(10)');
  assert.ok(await count() > zeroSizeDraws, 'revealed canvas must recover');

  await evaluate(`(() => {
    const warn = console.warn; window.__fluidWarnings = 0;
    console.warn = function(...args) { window.__fluidWarnings++; return warn.apply(this, args); };
    const originalSin = Math.sin; Math.sin = () => NaN;
    window.__advanceFrames(10);
    Math.sin = originalSin;
  })()`);
  const afterFailure = await count();
  await evaluate('window.__advanceFrames(20)');
  assert.equal(await count(), afterFailure, 'a failed solver must stop instead of continuing with invalid state');
  assert.equal(await evaluate('window.__fluidWarnings'), 1, 'a failure should be reported only once');
  await evaluate("document.getElementById('settings-toggle').click()");
  assert.equal(await evaluate("document.getElementById('settings-toggle').getAttribute('aria-expanded')"), 'true',
    'settings remain usable after a solver failure');

  await send('Page.navigate', { url: pathToFileURL(previewWithoutSettings).href });
  let withoutSettingsReady = false;
  for (let i = 0; i < 100 && !withoutSettingsReady; i++) {
    try { withoutSettingsReady = await evaluate("typeof window.__advanceFrames === 'function' && window.__draws > 0"); }
    catch { /* Context may still be navigating. */ }
    if (!withoutSettingsReady) await sleep(50);
  }
  assert.ok(withoutSettingsReady, 'background should still draw without optional settings');
  const noSettingsDraws = await count();
  await evaluate('window.__advanceFrames(10)');
  assert.ok(await count() > noSettingsDraws, 'background should run without optional settings');
  assert.equal(await evaluate(`(() => {
    const canvas = document.getElementById('ascii-flow');
    const dispose = window.AsciiFluid.mount(canvas);
    const same = dispose === window.AsciiFluid.mount(canvas);
    dispose(); dispose();
    return same && window.__pendingFrames() === 0;
  })()`), true, 'mount is idempotent and disposal cancels playback');
  const unmountedDraws = await count();
  await evaluate('window.__advanceFrames(10)');
  assert.equal(await count(), unmountedDraws, 'disposed background does not draw');
  await evaluate("window.AsciiFluid.mount(document.getElementById('ascii-flow')); window.__advanceFrames(10)");
  assert.ok(await count() > unmountedDraws, 'a disposed canvas can be remounted');
  assert.equal(await evaluate('window.__pendingFrames()'), 1, 'remount starts exactly one loop');

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/ascii-fluid-preview.html') {
      response.setHeader('Content-Type', 'text/html');
      response.end(fs.readFileSync(path.join(root, 'ascii-fluid-preview.html'), 'utf8'));
      return;
    }
    if (pathname === '/' || pathname === '/index.html' || pathname === '/original' || pathname === '/dye') {
      response.setHeader('Content-Type', 'text/html');
      let page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      if (pathname === '/original' || pathname === '/dye') {
        const entry = pathname === '/original' ? 'assets/ascii-flow.js' : 'assets/ascii-flow-dye.js';
        page = page.replace(/assets\/ascii-flow(?:-fluid|-dye)?\.js/, entry)
          .replace(/(<input id="speed"[^>]*\bvalue=")[^"]+/, (_, prefix) => `${prefix}0.9`);
      }
      response.end(page);
      return;
    }
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(path.join(root, 'assets') + path.sep)) { response.writeHead(404).end(); return; }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(404).end(); return; }
      const extension = path.extname(file);
      response.setHeader('Content-Type', extension === '.js' ? 'application/javascript' :
        extension === '.css' ? 'text/css' : extension === '.jpg' ? 'image/jpeg' : 'application/octet-stream');
      response.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  let servedReady = false;
  for (let i = 0; i < 100 && !servedReady; i++) {
    try { servedReady = await evaluate("typeof window.__advanceFrames === 'function' && window.__draws > 0"); }
    catch { /* Context may still be navigating. */ }
    if (!servedReady) await sleep(50);
  }
  assert.ok(servedReady, 'locally served page should work with external fonts blocked');
  const servedDraws = await count();
  await evaluate('window.__advanceFrames(10)');
  assert.ok(await count() > servedDraws);
  for (const [previewUrl, destination] of [
    [pathToFileURL(path.join(root, 'ascii-fluid-preview.html')).href, pathToFileURL(path.join(root, 'index.html')).href],
    [`http://127.0.0.1:${server.address().port}/ascii-fluid-preview.html`, `http://127.0.0.1:${server.address().port}/index.html`]
  ]) {
    await send('Page.navigate', { url: previewUrl });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = await evaluate("typeof window.__advanceFrames === 'function' && window.__draws > 0"); }
      catch { /* The preview redirects to the actual landing page. */ }
      if (!ready) await sleep(50);
    }
    assert.ok(ready, `the repository preview should work at ${previewUrl}`);
    assert.equal(await evaluate('location.href'), destination, 'keep a single maintained landing page');
    assert.deepEqual(await evaluate("Array.from(document.scripts, s => s.getAttribute('src')).filter(s => s && s.includes('ascii-flow'))"),
      ['assets/ascii-flow-fluid.js'], 'the saved preview must select only the reviewed fluid renderer');
    assert.equal(await evaluate("document.getElementById('speed').value"), '0.4');
    const start = await count();
    await evaluate('window.__advanceFrames(10)');
    assert.ok(await count() > start, 'the saved preview must animate');
    assert.equal(await evaluate('window.__pendingFrames()'), 1, 'the preview must not add a second animation loop');
  }
  for (const [route, script] of [['original', 'ascii-flow.js'], ['dye', 'ascii-flow-dye.js']]) {
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${route}` });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = await evaluate("typeof window.__advanceFrames === 'function' && window.__draws > 0"); }
      catch { /* Context may still be navigating. */ }
      if (!ready) await sleep(50);
    }
    assert.ok(ready, `${route} fallback should still render`);
    assert.deepEqual(await evaluate("Array.from(document.scripts, s => s.getAttribute('src')).filter(s => s && s.includes('ascii-flow'))"),
      [`assets/${script}`], 'each preview must select exactly one background script');
    assert.equal(await evaluate("document.getElementById('viscosity-setting').hidden"), true,
      'backgrounds without a viscosity control must not show it');
    const start = await count();
    await evaluate('window.__advanceFrames(10)');
    assert.ok(await count() > start, `${route} fallback should animate`);
  }
  assert.deepEqual(errors, []);
});
