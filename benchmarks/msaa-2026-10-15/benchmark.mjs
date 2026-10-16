import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpus, platform, release } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

const [appArg, baselineArg, optimizedArg, outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error('Usage: benchmark_msaa.mjs APP_ROOT BASELINE OPTIMIZED OUTPUT_JSON');
const appRoot = resolve(appArg);
const packages = { baseline: resolve(baselineArg), optimized: resolve(optimizedArg), control: resolve(optimizedArg) };
const fixtures = {
  'decor.riv': join(appRoot, 'client/raw-assets/rive/decor{m}.riv'),
  'avatar.riv': join(appRoot, 'client/raw-assets/rive/avatar.riv'),
};
const sprites = [
  { file: 'decor.riv', artboard: 'StoneBirdBath', w: 49, h: 99 },
  { file: 'decor.riv', artboard: 'StoneTorch', w: 74, h: 152 },
  { file: 'decor.riv', artboard: 'Cauldron', w: 96, h: 110 },
  { file: 'avatar.riv', artboard: 'AvatarElements', w: 165, h: 165 },
  { file: 'decor.riv', artboard: 'MarbleFountain', w: 102, h: 149 },
  { file: 'decor.riv', artboard: 'WoodWindmill', w: 117, h: 126 },
  { file: 'decor.riv', artboard: 'WindSpinner', w: 97, h: 138 },
  { file: 'decor.riv', artboard: 'StoneFirepit', w: 77, h: 97 },
];
const pilot = process.env.BENCH_PILOT === '1';
const negativeControl = process.env.BENCH_NEGATIVE_CONTROL === '1';
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Rive MSAA CPU benchmark</title>');
      return;
    }
    const [, kind, variant, ...parts] = url.pathname.split('/');
    if (kind === 'assets' && fixtures[variant]) {
      response.end(await readFile(fixtures[variant]));
      return;
    }
    const root = kind === 'builds' && packages[variant];
    if (!root) throw new Error('Unknown resource');
    const path = resolve(root, parts.join('/'));
    if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    response.setHeader('Content-Type', extname(path) === '.wasm' ? 'application/wasm' : 'text/javascript');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});

/** Replays full and partial atlas handoffs with paired, deterministic frames. */
async function runBenchmark(config) {
  if (!crossOriginIsolated) throw new Error('High-resolution isolated timers are required');
  const raf = () => new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');

  class Atlas {
    constructor(name, rive) {
      this.name = name;
      this.rive = rive;
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.canvas.height = 64;
      document.body.appendChild(this.canvas);
      this.gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, stencil: true, depth: true, powerPreference: 'high-performance' });
      if (!this.gl) throw new Error('WebGL2 unavailable');
      const debug = this.gl.getExtension('WEBGL_debug_renderer_info');
      this.identity = debug && this.gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
      if (!this.identity || /swiftshader|llvmpipe|softpipe|lavapipe|software/i.test(this.identity)) {
        throw new Error('A physical GPU is required: ' + this.identity);
      }
      this.renderer = rive.makeRenderer(this.canvas);
      this.maxUnits = this.gl.getParameter(this.gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
      this.items = [];
      this.files = new Map();
    }

    async init() {
      const { gl, rive } = this;
      let x = 0, y = 0, rowHeight = 0, width = 0;
      for (const sprite of config.sprites) {
        if (x + sprite.w > 370) { x = 0; y += rowHeight; rowHeight = 0; }
        const rect = { x, y, w: sprite.w, h: sprite.h };
        x += sprite.w; rowHeight = Math.max(rowHeight, sprite.h); width = Math.max(width, x);
        let file = this.files.get(sprite.file);
        if (!file) {
          const bytes = new Uint8Array(await (await fetch('/assets/' + sprite.file)).arrayBuffer());
          file = await rive.load(bytes, undefined, false);
          if (!file) throw new Error('Fixture import failed');
          this.files.set(sprite.file, file);
        }
        const artboard = file.artboardByName(sprite.artboard);
        if (!artboard) throw new Error('Artboard missing: ' + sprite.artboard);
        const machine = artboard.stateMachineCount() > 0 ? new rive.StateMachineInstance(artboard.stateMachineByIndex(0), artboard) : null;
        this.items.push({ artboard, machine, rect });
      }
      this.width = width; this.height = y + rowHeight;
      this.active = config.activeIndexes.map(index => this.items[index]);
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.width, this.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.framebuffer = gl.createFramebuffer();
      this.renderer.bindContext();
      this.renderer.setTargetTexture(this.texture, this.width, this.height);
      for (let frame = 0; frame < 3; frame++) { this.advance(this.items); this.flush(true); }
      this.check();
    }

    unbindAll() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (let unit = 0; unit < this.maxUnits; unit++) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, null); gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, null); gl.bindTexture(gl.TEXTURE_3D, null);
      }
      gl.activeTexture(gl.TEXTURE0);
    }

    advance(items = this.active) {
      for (const item of items) { item.machine?.advance(1 / 60); item.artboard.advance(1 / 60); }
    }

    flush(forceFull = false) {
      const { gl, renderer, rive } = this;
      const items = forceFull ? this.items : this.active;
      const partial = items.length < this.items.length;
      this.unbindAll();
      if (partial) {
        // Match RiveBatchRenderer's regional clear before an overlay frame.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
        gl.colorMask(true, true, true, true); gl.clearColor(0, 0, 0, 0); gl.enable(gl.SCISSOR_TEST);
        for (const { rect } of items) { gl.scissor(rect.x, rect.y, rect.w, rect.h); gl.clear(gl.COLOR_BUFFER_BIT); }
        gl.disable(gl.SCISSOR_TEST);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      renderer.bindContext(); renderer.invalidateGLState();
      if (partial) renderer.beginOverlayFrame(); else renderer.clear();
      for (const { artboard, rect } of items) {
        const mirroredY = this.height - rect.y - rect.h;
        renderer.saveClipRect(rect.x, mirroredY, rect.x + rect.w, mirroredY + rect.h);
        renderer.align(rive.Fit.contain, rive.Alignment.center, { minX: rect.x, minY: mirroredY, maxX: rect.x + rect.w, maxY: mirroredY + rect.h }, artboard.bounds);
        artboard.draw(renderer); renderer.restoreClipRect();
      }
      renderer.flush(); rive.resolveAnimationFrame();
      renderer.bindContext(); renderer.unbindGLInternalResources(); this.unbindAll();
    }

    pixels() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete atlas framebuffer');
      const pixels = new Uint8Array(this.width * this.height * 4);
      gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return pixels;
    }

    check() {
      const error = this.gl.getError();
      if (error !== this.gl.NO_ERROR || this.gl.isContextLost()) throw new Error('WebGL failure: ' + error);
    }
  }

  let timerResolutionMs = Infinity, previousMs = performance.now();
  for (let index = 0; index < 10000; index++) { const nowMs = performance.now(); if (nowMs > previousMs) timerResolutionMs = Math.min(timerResolutionMs, nowMs - previousMs); previousMs = nowMs; }
  const atlases = [];
  for (const name of config.builds) {
    const base = '/builds/' + name + '/';
    const { default: Rive } = await import(base + 'webgl2_advanced.mjs');
    const wasmBinary = await (await fetch(base + 'rive.wasm')).arrayBuffer();
    const rive = await Rive({ wasmBinary, locateFile: () => base + 'rive.wasm' });
    const atlas = new Atlas(name, rive); await atlas.init(); atlases.push(atlas);
  }
  const parity = [];
  /** Pixel readback is outside timing and compares every byte. */
  async function comparePixels(phase) {
    const pixels = atlases.map(atlas => atlas.pixels());
    if (config.negativeControl) pixels[1][0] ^= 1;
    let changedBytes = 0;
    for (let index = 0; index < pixels[0].length; index++) if (pixels[0][index] !== pixels[1][index]) changedBytes++;
    if (changedBytes) throw new Error('Pixel parity failed: ' + changedBytes + ' bytes at ' + phase);
    if (!pixels[0].some(value => value !== 0)) throw new Error('Empty atlas');
    for (const atlas of atlases) atlas.check();
    parity.push({ phase, sha256: await sha256(pixels[0]), comparedBytes: pixels[0].length, changedBytes });
  }
  await comparePixels('initial');
  for (let frame = 0; frame < config.warmupFrames; frame++) {
    await raf();
    for (const atlas of frame % 2 ? [...atlases].reverse() : atlases) { atlas.advance(); atlas.flush(); }
  }
  await comparePixels('warmup');
  // Instrument separately so JS wrappers do not affect CPU timing.
  const glCalls = {};
  for (const atlas of atlases) {
    const originals = new Map(), counts = {};
    for (const name in atlas.gl) {
      if (typeof atlas.gl[name] !== 'function') continue;
      originals.set(name, atlas.gl[name]);
      atlas.gl[name] = function (...args) { counts[name] = (counts[name] ?? 0) + 1; return originals.get(name).apply(this, args); };
    }
    try { atlas.flush(); } finally { for (const [name, original] of originals) atlas.gl[name] = original; }
    glCalls[atlas.name] = { total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
  }
  // Restore hot call sites after the separate GL-call instrumentation.
  for (let frame = 0; frame < 60; frame++) {
    await raf();
    for (const atlas of frame % 2 ? [...atlases].reverse() : atlases) { atlas.advance(); atlas.flush(); }
  }
  const blocks = [];
  for (let block = 0; block < config.blocks; block++) {
    const samples = Object.fromEntries(config.builds.map(name => [name, { advanceMs: [], flushMs: [], totalMs: [] }]));
    for (let frame = 0; frame < config.framesPerBlock; frame++) {
      await raf();
      for (const atlas of (block + frame) % 2 ? [...atlases].reverse() : atlases) {
        const startMs = performance.now(); atlas.advance();
        const advancedMs = performance.now(); atlas.flush();
        const endMs = performance.now();
        samples[atlas.name].advanceMs.push(advancedMs - startMs);
        samples[atlas.name].flushMs.push(endMs - advancedMs);
        samples[atlas.name].totalMs.push(endMs - startMs);
      }
    }
    for (const atlas of atlases) atlas.check();
    blocks.push({ block, samples, means: Object.fromEntries(Object.entries(samples).map(([name, metrics]) => [name, Object.fromEntries(Object.entries(metrics).map(([metric, values]) => [metric, mean(values)]))])) });
  }
  await comparePixels('end');
  return { scenario: config.scenario, builds: config.builds, activeIndexes: config.activeIndexes, atlas: [atlases[0].width, atlases[0].height], renderer: atlases[0].identity, extensions: atlases[0].gl.getSupportedExtensions(), contextAttributes: atlases[0].gl.getContextAttributes(), timerResolutionMs, crossOriginIsolated, parity, glCalls, blocks };
}

await new Promise(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
const require = createRequire(join(appRoot, 'package.json'));
const { chromium } = require('playwright');
const chromeArgs = ['--enable-gpu', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling'];
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: chromeArgs });
const errors = [];
const runs = [];
try {
  const scenarios = [
    { scenario: 'full-atlas-8', activeIndexes: [0, 1, 2, 3, 4, 5, 6, 7] },
    { scenario: 'partial-atlas-3', activeIndexes: [3, 5, 6] },
    { scenario: 'avatar-only-1', activeIndexes: [3] },
  ];
  const cases = pilot || negativeControl
    ? [{ ...scenarios[0], builds: ['baseline', 'optimized'] }]
    : [
        { ...scenarios[0], scenario: 'aa-control-8', builds: ['control', 'optimized'] },
        ...scenarios.map(scenario => ({ ...scenario, builds: ['baseline', 'optimized'] })),
        ...[...scenarios].reverse().map(scenario => ({ ...scenario, builds: ['optimized', 'baseline'] })),
      ];
  for (const item of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await page.goto('http://127.0.0.1:' + address.port);
      const config = { ...item, sprites, negativeControl, warmupFrames: pilot ? 30 : 120, blocks: pilot ? 2 : 12, framesPerBlock: pilot ? 30 : 120 };
      const result = await page.evaluate(runBenchmark, config);
      if (errors.length) throw new Error(errors.join('\n'));
      runs.push(result);
      console.log(JSON.stringify({ scenario: item.scenario, builds: item.builds, renderer: result.renderer, parity: result.parity, flushMs: Object.fromEntries(item.builds.map(name => [name, result.blocks.reduce((sum, block) => sum + block.means[name].flushMs, 0) / result.blocks.length])) }));
    } finally { await context.close(); }
  }
  const hashes = {};
  for (const [name, root] of Object.entries(packages)) {
    hashes[name] = {};
    for (const file of ['rive.wasm', 'webgl2_advanced.mjs']) hashes[name][file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
  }
  const fixtureHashes = {};
  for (const [name, path] of Object.entries(fixtures)) fixtureHashes[name] = createHash('sha256').update(await readFile(path)).digest('hex');
  await writeFile(outputArg, JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), chromeArgs, cpu: cpus()[0].model, platform: `${platform()} ${release()}`, method: 'Two contexts on one page; equal deterministic 1/60 advances; 120-frame paired blocks; alternating execution order every frame; reversed context creation order in second A/B run; 120 warmup frames plus 60 after GL-call counting; no gl.finish or GL wrappers inside timing; exact initial/warmup/end pixel parity. Partial scenarios freeze other artboards and reproduce regional clear plus beginOverlayFrame. Measures CPU atlas advance/render handoff, not whole-game frame time or GPU duration.', hashes, fixtureHashes, sprites, runs }, null, 2) + '\n');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
