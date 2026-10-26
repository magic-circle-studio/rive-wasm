// Run after the machine-free gate, using the same host-GPU flags as the package
// test. APP_ROOT supplies decor{m}.riv and the existing Playwright dependency.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpus, platform, release } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const [appArg, baselineArg, optimizedArg, outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error('Usage: benchmark.mjs APP_ROOT BASELINE OPTIMIZED OUTPUT_JSON');
const appRoot = resolve(appArg);
const packages = { baseline: resolve(baselineArg), optimized: resolve(optimizedArg) };
const fixture = join(appRoot, 'client/raw-assets/rive/decor{m}.riv');
const sprites = [
  'StoneBirdBath', 'StoneTorch', 'Cauldron', 'MarbleFountain',
  'WoodWindmill', 'WindSpinner', 'StoneFirepit',
];
const chromeArgs = [
  '--enable-unsafe-webgpu', '--enable-gpu', '--use-gl=angle',
  '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE',
  '--disable-vulkan-surface', '--collect-dawn-info-eagerly',
];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Rive WebGPU bind groups</title>');
      return;
    }
    if (url.pathname === '/fixture.riv') {
      response.end(await readFile(fixture));
      return;
    }
    const [, variant, ...parts] = url.pathname.split('/');
    const root = packages[variant];
    if (!root) throw new Error('Unknown build');
    const path = resolve(root, parts.join('/'));
    if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    response.setHeader('Content-Type', extname(path) === '.wasm' ? 'application/wasm' : 'text/javascript');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});

async function benchmark({ sprites, order }) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  assert(crossOriginIsolated, 'High-resolution timers required');
  let adapter;
  for (let attempt = 0; attempt < 20; attempt++) {
    adapter = await navigator.gpu?.requestAdapter();
    if (adapter) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert(adapter && adapter.info.isFallbackAdapter === false, 'Physical GPU required');
  const adapterInfo = Object.fromEntries(
    ['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter']
      .map(key => [key, adapter.info[key]]));
  assert(!/swiftshader|llvmpipe|lavapipe|software/i.test(JSON.stringify(adapterInfo)), 'Software GPU rejected');
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const size = 512;
  const bytes = new Uint8Array(await (await fetch('/fixture.riv')).arrayBuffer());
  const atlases = {};
  for (const name of order) {
    const { default: createRive } = await import('/' + name + '/webgpu_advanced.mjs');
    const rive = await createRive({ locateFile: () => '/' + name + '/rive.wasm' });
    assert(rive.initWebGPU(adapter, device), 'Device rejected by ' + name);
    const renderer = rive.makeRenderer();
    const file = await rive.load(bytes, undefined, false);
    const items = sprites.map(name => {
      const artboard = file.artboardByName(name);
      assert(artboard, 'Missing artboard: ' + name);
      const machine = artboard.stateMachineCount() > 0
        ? new rive.StateMachineInstance(artboard.stateMachineByIndex(0), artboard) : null;
      return { artboard, machine };
    });
    const target = device.createTexture({
      size: [size, size], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    renderer.setTargetTexture(target);
    atlases[name] = { rive, renderer, file, items, target };
  }
  function advance(atlas) {
    for (const { artboard, machine } of atlas.items) {
      machine?.advance(1 / 60);
      artboard.advance(1 / 60);
    }
  }
  function draw(atlas, samples = 0, overlay = false) {
    const { renderer, rive } = atlas;
    if (overlay) renderer.beginOverlayFrame(samples);
    else renderer.clear(0, samples);
    atlas.items.forEach(({ artboard }, index) => {
      const x = index % 4 * 128, y = Math.floor(index / 4) * 256;
      renderer.save();
      renderer.align(rive.Fit.contain, rive.Alignment.center,
        { minX: x, minY: y, maxX: x + 128, maxY: y + 256 }, artboard.bounds);
      artboard.draw(renderer);
      renderer.restore();
    });
  }
  async function pixels(atlas) {
    const buffer = device.createBuffer({ size: size * size * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: atlas.target }, { buffer, bytesPerRow: size * 4 }, [size, size]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const result = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    buffer.destroy();
    return result;
  }
  const parity = [];
  async function compare(label) {
    const left = await pixels(atlases.baseline), right = await pixels(atlases.optimized);
    let differences = 0;
    for (let i = 0; i < left.length; i++) differences += left[i] !== right[i];
    assert(left.some(byte => byte !== 0), 'Empty atlas');
    assert(differences === 0, label + ': ' + differences + ' changed bytes');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', left))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    parity.push({ label, differences, hash });
  }
  for (let frame = 0; frame < 60; frame++) {
    for (const atlas of Object.values(atlases)) {
      advance(atlas); draw(atlas); atlas.renderer.flush();
    }
    await device.queue.onSubmittedWorkDone();
  }
  await compare('warmup-atomics');

  // Count outside timing. Full descriptors include layout, binding numbers,
  // buffer identity/range, texture view and sampler identity.
  const counts = {};
  const ids = new WeakMap();
  let nextId = 0;
  const id = resource => {
    if (!resource) return null;
    if (!ids.has(resource)) ids.set(resource, ++nextId);
    return ids.get(resource);
  };
  const originalGroup = GPUDevice.prototype.createBindGroup;
  const originalPass = GPUCommandEncoder.prototype.beginRenderPass;
  let active;
  GPUDevice.prototype.createBindGroup = function(desc) {
    if (active) {
      active.bindGroups++;
      const key = JSON.stringify({
        layout: id(desc.layout),
        entries: [...desc.entries].map(({ binding, resource }) => ({
          binding, buffer: id(resource.buffer), offset: resource.offset ?? 0,
          size: resource.size ?? 'whole',
          view: resource instanceof GPUTextureView ? id(resource) : null,
          sampler: resource instanceof GPUSampler ? id(resource) : null,
        })).sort((a, b) => a.binding - b.binding),
      });
      active.descriptors[key] = (active.descriptors[key] ?? 0) + 1;
    }
    return originalGroup.call(this, desc);
  };
  GPUCommandEncoder.prototype.beginRenderPass = function(...args) {
    if (active) active.renderPasses++;
    return originalPass.apply(this, args);
  };
  try {
    for (const [name, atlas] of Object.entries(atlases)) {
      counts[name] = [];
      for (let frame = 0; frame < 6; frame++) {
        const metrics = { bindGroups: 0, renderPasses: 0, descriptors: {} };
        draw(atlas);
        active = metrics;
        atlas.renderer.flush();
        active = null;
        counts[name].push(metrics);
        await device.queue.onSubmittedWorkDone();
      }
    }
  } finally {
    active = null;
    GPUDevice.prototype.createBindGroup = originalGroup;
    GPUCommandEncoder.prototype.beginRenderPass = originalPass;
  }
  for (let frame = 0; frame < counts.baseline.length; frame++) {
    assert(counts.baseline[frame].renderPasses === counts.optimized[frame].renderPasses,
      'Caching changed render pass count');
    assert(counts.optimized[frame].bindGroups < counts.baseline[frame].bindGroups,
      'Bind group count did not fall');
    assert(Math.max(...Object.values(counts.optimized[frame].descriptors)) === 1,
      'Optimized flush recreated an identical descriptor');
  }
  await compare('counted-atomics');
  const blocks = [];
  for (let block = 0; block < 12; block++) {
    const samples = { baseline: [], optimized: [] };
    for (let frame = 0; frame < 60; frame++) {
      const names = (block + frame) % 2 ? [...order].reverse() : order;
      for (const name of names) {
        const atlas = atlases[name];
        advance(atlas); draw(atlas);
        const start = performance.now();
        atlas.renderer.flush();
        samples[name].push(performance.now() - start);
      }
      await device.queue.onSubmittedWorkDone();
    }
    blocks.push(samples);
  }
  await compare('end-atomics');
  // Exercise a load from the target and then switch to MSAA on the same renderer.
  for (const atlas of Object.values(atlases)) {
    draw(atlas, 0, true); atlas.renderer.flush();
  }
  await compare('overlay-atomics');
  for (const atlas of Object.values(atlases)) {
    draw(atlas, 4); atlas.renderer.flush();
  }
  await compare('msaa4');
  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0, errors.join('\n'));
  for (const atlas of Object.values(atlases)) {
    atlas.renderer.delete();
    for (const { artboard, machine } of atlas.items) { machine?.delete(); artboard.delete(); }
    atlas.file.unref(); atlas.target.destroy();
  }
  device.destroy();
  return { order, adapterInfo, counts, blocks, parity, errors };
}

await new Promise(done => server.listen(0, '127.0.0.1', done));
const { chromium } = createRequire(join(appRoot, 'package.json'))('playwright');
const executablePath = process.env.CHROME_BIN ?? spawnSync('which', ['google-chrome'], { encoding: 'utf8' }).stdout.trim();
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true, args: chromeArgs });
  const runs = [];
  for (const order of [['baseline', 'optimized'], ['optimized', 'baseline']]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(240_000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('http://127.0.0.1:' + server.address().port);
    const result = await page.evaluate(benchmark, { sprites, order });
    if (errors.length) throw new Error(errors.join('\n'));
    runs.push(result);
    await context.close();
  }
  const hash = path => readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'));
  const hashes = {};
  for (const [name, root] of Object.entries(packages)) {
    hashes[name] = {};
    for (const file of ['rive.wasm', 'webgpu_advanced.mjs']) hashes[name][file] = await hash(join(root, file));
  }
  const mean = samples => samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const means = Object.fromEntries(Object.keys(packages).map(name =>
    [name, mean(runs.flatMap(run => run.blocks.flatMap(block => block[name])))]));
  const summary = { flushCpuMs: means, reductionPercent: (1 - means.optimized / means.baseline) * 100,
    bindGroupsPerFlush: Object.fromEntries(Object.keys(packages).map(name =>
      [name, runs.flatMap(run => run.counts[name].map(count => count.bindGroups))])) };
  await writeFile(outputArg, JSON.stringify({
    date: new Date().toISOString(), browser: browser.version(), chromeArgs,
    cpu: cpus()[0].model, platform: `${platform()} ${release()}`,
    method: 'Seven animated decor artboards in a 512x512 atlas. Atomics; paired alternating flush-only CPU timings; 60 warmup frames, 12 blocks of 60 paired frames, reversed module creation order in the second run. Queue completion outside timing after each pair. API wrappers only during separate counting. Byte-exact atomics, overlay and MSAA comparisons.',
    sprites, hashes, fixtureSha256: await hash(fixture), summary, runs,
  }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
