// Compare staged packages with exact programs disabled on a host GPU.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [baselineArg, candidateArg, assetsArg, outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error("Usage: compare_webgl2_pixels.mjs baseline-package candidate-package game-root output-directory");
const baseline = resolve(baselineArg), candidate = resolve(candidateArg);
const assets = resolve(assetsArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packages = [];
for (const directory of [baseline, candidate]) {
  const header = await readFile(join(directory === baseline ? directory : join(root,
    "wasm/build/webgl2_advanced/bin/release/include/generated/shaders"), "glsl.glsl.exports.h"), "utf8");
  packages.push({ version: JSON.parse(await readFile(join(directory, "package.json"))).version,
    wasmSha256: hash(await readFile(join(directory, "rive.wasm"))),
    macros: Object.fromEntries(Array.from(header.matchAll(/^#define GLSL_(\w+) "([^"]+)"$/gm),
      ([, name, value]) => [value, name])) });
}
const petsPath = "client/raw-assets/rive/pets{m}";
const pets = (await readdir(join(assets, petsPath))).filter((name) => name.endsWith(".riv")).sort();
if (pets.length !== 32) throw new Error("Expected the 32 shipped pet files.");
const materials = [["Plain", 0], ["Gold", 1], ["Rainbow", 2]];
const cases = pets.flatMap((name) => ["hatImage", "tieImage"].flatMap((slot) =>
  materials.map(([label, material]) => ({
    name: name.slice(0, -4) + ":" + slot + ":" + label,
    group: slot + ":" + label, path: petsPath + "/" + name,
    artboard: name.slice(0, -4),
    slots: { [slot]: slot === "hatImage" ? "pet" : "tie" }, material,
  }))));
for (const [label, material] of materials) {
  cases.push({ name: "mesh-reference:" + label, group: "meshReference",
    synthetic: true, slots: {}, material });
}
for (const name of (await readdir(join(assets, "client/src/boot/splashscreen"))).filter((name) => name.endsWith(".riv")).sort()) {
  cases.push({ name, group: "splash", path: "client/src/boot/splashscreen/" + name,
    artboard: "MC_MainLoader_Horz", slots: {}, material: 0 });
}
for (const [name, slots] of Object.entries({ bottom: { bottom: "bottom" }, mid: { mid: "mid" },
  top: { top: "top" }, portrait: { discordAvatar: "top" },
  all: { bottom: "bottom", mid: "mid", top: "top", discordAvatar: "top", topBasketWithItem: "pet" } })) {
  cases.push({ name: "avatar:" + name, group: "avatar", path: "client/raw-assets/rive/avatar.riv",
    artboard: "AvatarElements", slots, material: 0 });
}
for (const pet of ["Snail", "FireHorse"]) for (const [name, material] of [["Gold", 1], ["Rainbow", 2]]) {
  cases.push({ name: pet + ":" + name, group: "material", path: petsPath + "/" + pet + ".riv",
    artboard: pet, slots: {}, material });
}
const images = {
  pet: "client/raw-assets/atlases/sprite/pet-cosmetic/Fez.png",
  tie: "client/raw-assets/atlases/sprite/pet-cosmetic/BowTie.png",
  bottom: "client/raw-assets/cosmetic{m}{nc}/Bottom_DefaultGray.png",
  mid: "client/raw-assets/cosmetic{m}{nc}/Mid_Dino.png",
  top: "client/raw-assets/cosmetic{m}{nc}/Top_DiscordPopsicle.png",
};
const manifest = [];
for (const path of new Set([...cases.map((item) => item.path).filter(Boolean), ...Object.values(images)])) {
  manifest.push({ path, sha256: hash(await readFile(join(assets, path))) });
}
const mime = { ".mjs": "text/javascript", ".wasm": "application/wasm", ".png": "image/png" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (path === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><body></body>"); return; }
    const directory = path.startsWith("/baseline/") ? baseline : path.startsWith("/candidate/") ? candidate : assets;
    const relative = path.replace(/^\/(baseline|candidate|assets)\//, "");
    const file = resolve(directory, relative);
    if (!file.startsWith(directory + "/")) throw new Error("Invalid path");
    response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/etc/profiles/per-user/aroman/bin/google-chrome",
  headless: true, downloadsPath: output,
  env: { ...process.env, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "wayland-1" },
  args: ["--use-gl=angle", "--use-angle=gl", "--ozone-platform=wayland", "--disable-features=Vulkan",
    "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage();
  page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({ packages, cases, images }) => {
    const sides = [];
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const imageCanvas = new OffscreenCanvas(32, 32);
    const imageContext = imageCanvas.getContext("2d");
    imageContext.fillStyle = "#e0308080";
    imageContext.fillRect(0, 0, 32, 32);
    const png = new Uint8Array(await (await imageCanvas.convertToBlob()).arrayBuffer());
    // mc.4 needs an image-path reference; newer baselines use authored meshes.
    function imageFixture(mesh) {
      const bytes = [...new TextEncoder().encode("RIVE"), 7, 0, 0, 0];
      const uint = (value) => {
        do {
          const byte = value & 127; value >>>= 7;
          bytes.push(byte | (value ? 128 : 0));
        } while (value);
      };
      const prop = (key, value, type = "uint") => {
        uint(key);
        if (type === "uint") uint(value);
        else if (type === "bytes") { uint(value.length); bytes.push(...value); }
        else {
          const buffer = new ArrayBuffer(4);
          new DataView(buffer).setFloat32(0, value, true);
          bytes.push(...new Uint8Array(buffer));
        }
      };
      uint(23); uint(0);
      uint(105); prop(204, 0); prop(208, 32, "float"); prop(207, 32, "float"); uint(0);
      uint(106); prop(212, png, "bytes"); uint(0);
      uint(1); prop(7, 256, "float"); prop(8, 256, "float"); uint(0);
      uint(100); prop(5, 0); prop(206, 0);
      prop(13, 176, "float"); prop(14, 176, "float");
      prop(380, 0, "float"); prop(381, 0, "float"); uint(0);
      if (mesh) {
        uint(109); prop(5, 1); prop(223, [0, 1, 2, 0, 2, 3], "bytes"); uint(0);
        for (const [x, y, u, v] of [[0, 0, 0, 0], [32, 0, 1, 0], [32, 32, 1, 1], [0, 32, 0, 1]]) {
          uint(108); prop(5, 2); prop(24, x, "float"); prop(25, y, "float");
          prop(215, u, "float"); prop(216, v, "float"); uint(0);
        }
      }
      return new Uint8Array(bytes);
    }
    const features = /^ENABLE_(CLIPPING|CLIP_RECT|ADVANCED_BLEND|FEATHER|EVEN_ODD|NESTED_CLIPPING|HSL_BLEND_MODES|DITHER|MODULATED_IMAGE)$/;
    for (const [index, prefix] of ["baseline", "candidate"].entries()) {
      const { default: init } = await import("/" + prefix + "/webgl2_advanced.mjs");
      const rive = await init({ locateFile: () => "/" + prefix + "/rive.wasm" });
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
      const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false,
        premultipliedAlpha: true, preserveDrawingBuffer: true });
      const gpu = gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
      assert(!/swiftshader|llvmpipe|software/i.test(gpu), "Host GPU required: " + gpu);
      const sources = new Map(), attached = new Map(), programs = [], records = new Map();
      const meshDraws = {};
      let current = null, active = null;
      const originalSource = gl.shaderSource.bind(gl), originalAttach = gl.attachShader.bind(gl), originalLink = gl.linkProgram.bind(gl);
      gl.shaderSource = (shader, source) => { sources.set(shader, source); originalSource(shader, source); };
      gl.attachShader = (program, shader) => {
        if (!attached.has(program)) attached.set(program, []);
        attached.get(program).push(shader); originalAttach(program, shader);
      };
      gl.linkProgram = (program) => {
        const defines = [...new Set((attached.get(program) ?? []).flatMap((shader) => {
          const source = sources.get(shader);
          const glslMarker = source.match(/#define (\w+)\n#ifndef/)?.[1];
          return Array.from(source.split("#ifndef")[0].matchAll(/^#define\s+(\w+)/gm),
            ([, name]) => packages[index].macros[name] ?? (name === glslMarker ? "GLSL" : name));
        }))].sort();
        const type = defines.includes("DRAW_IMAGE_MESH") ? "imageMesh" : defines.includes("DRAW_PATH") ? "path"
          : defines.includes("DRAW_INTERIOR_TRIANGLES") ? "interiorTriangles" : defines.includes("FEATHER_ATLAS_BLIT") ? "featherAtlasBlit" : "aux";
        const record = { type, defines, features: defines.filter((name) => features.test(name)), firstCase: current, usedCases: {} };
        programs.push(record); records.set(program, record);
        originalLink(program);
      };
      const originalUse = gl.useProgram.bind(gl);
      gl.useProgram = (program) => { active = records.get(program); originalUse(program); };
      for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
        const original = gl[name].bind(gl);
        gl[name] = (...args) => {
          if (current && active) active.usedCases[current] = (active.usedCases[current] ?? 0) + 1;
          if (current && active?.type === "imageMesh") meshDraws[current] = (meshDraws[current] ?? 0) + 1;
          return original(...args);
        };
      }
      const renderer = rive.makeRenderer(canvas); renderer.setExactProgramsEnabled(false);
      renderer.bindContext();
      const target = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 512, 512);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      renderer.setTargetTexture(target, 512, 512);
      const framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      const bindings = {};
      for (const [name, path] of Object.entries(images)) {
        const bitmap = await createImageBitmap(await (await fetch("/assets/" + path)).blob(), { premultiplyAlpha: "premultiply" });
        renderer.bindContext();
        const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1 + Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))), gl.RGBA8, bitmap.width, bitmap.height);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        bindings[name] = renderer.makeImageFromGLTexture(texture, bitmap.width, bitmap.height);
        bitmap.close();
      }
      sides.push({ rive, renderer, gl, gpu, programs, bindings, framebuffer, meshDraws, setCurrent: (name) => { current = name; } });
    }
    const digest = async (pixels) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    const rows = [];
    for (const spec of cases) {
      const bytes = spec.synthetic ? null
        : new Uint8Array(await (await fetch("/assets/" + spec.path)).arrayBuffer());
      const states = [];
      for (const side of sides) {
        side.renderer.bindContext(); side.setCurrent(spec.name);
        const file = await side.rive.load(bytes ?? imageFixture(
          side === sides[1] || packages[0].version !== "2.42.2-mc.4"));
        await Promise.all(Array.from(side.rive.images?.values() ?? [], (image) => image.decodePromise));
        const art = spec.synthetic ? file.defaultArtboard()
          : file.artboardByName(spec.artboard);
        assert(art, "Missing artboard " + spec.artboard);
        const vm = spec.group === "splash" || spec.synthetic ? null
          : file.defaultArtboardViewModel(art)?.instance();
        if (vm) {
          for (const property of vm.getProperties()) {
            if (property.type === "image") vm.image(property.name).value(null);
          }
          for (const [slot, image] of Object.entries(spec.slots)) {
            assert(vm.image(slot), "Missing image slot " + slot); vm.image(slot).value(side.bindings[image]);
          }
          art.bindViewModelInstance(vm);
        }
        const sm = art.stateMachineCount() ? new side.rive.StateMachineInstance(art.stateMachineByIndex(0), art) : null;
        if (vm && sm) sm.bindViewModelInstance(vm);
        const anim = !sm && art.animationCount() ? new side.rive.LinearAnimationInstance(art.animationByIndex(0), art) : null;
        states.push({ file, art, vm, sm, anim });
      }
      for (let frame = 0; frame <= 90; frame++) {
        const pixels = [];
        for (let index = 0; index < 2; index++) {
          const side = sides[index], state = states[index], dt = frame ? 1 / 60 : 0;
          if (frame === 60 && state.sm) {
            for (let i = 0; i < state.sm.inputCount(); i++) {
              const input = state.sm.input(i);
              if (input.name === "animation") input.asNumber().value = 1;
            }
          }
          state.sm?.advance(dt); state.anim?.advance(dt); state.anim?.apply(1); state.art.advance(dt);
          if (![0, 30, 60, 90].includes(frame)) continue;
          side.renderer.bindContext(); side.renderer.invalidateGLState(); side.renderer.clear();
          side.renderer.saveClipRect(4, 4, 508, 508);
          side.renderer.align(side.rive.Fit.contain, side.rive.Alignment.center,
            { minX: 0, minY: 0, maxX: 512, maxY: 512 }, state.art.bounds);
          side.renderer.setSurfaceMaterial(spec.material, 0, 0, 512, 512, frame / 60);
          state.art.draw(side.renderer); side.renderer.restoreClipRect(); side.renderer.flush();
          side.renderer.unbindGLInternalResources(); side.renderer.bindContext();
          side.gl.bindFramebuffer(side.gl.FRAMEBUFFER, side.framebuffer);
          const buffer = new Uint8Array(512 * 512 * 4);
          side.gl.readPixels(0, 0, 512, 512, side.gl.RGBA, side.gl.UNSIGNED_BYTE, buffer);
          assert(side.gl.getError() === side.gl.NO_ERROR && !side.gl.isContextLost(), "GL error in " + spec.name);
          pixels.push(buffer);
        }
        if (!pixels.length) continue;
        let changedPixels = 0, overTolerance = 0, nonAAPixels = 0, maxDelta = 0, visible = 0;
        const edge = (buffer, offset) => {
          const x = (offset / 4) % 512, y = Math.floor(offset / (512 * 4));
          let min = 255, max = 0;
          for (let yy = Math.max(0, y - 1); yy <= Math.min(511, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(511, x + 1); xx++) {
            const alpha = buffer[(yy * 512 + xx) * 4 + 3]; min = Math.min(min, alpha); max = Math.max(max, alpha);
          }
          return max - min > 8;
        };
        for (let i = 0; i < pixels[0].length; i += 4) {
          let delta = 0;
          for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(pixels[0][i + channel] - pixels[1][i + channel]));
          maxDelta = Math.max(maxDelta, delta);
          if (pixels[0][i + 3]) visible++;
          if (delta) changedPixels++;
          if (delta > 2) { overTolerance++; if (!edge(pixels[0], i) && !edge(pixels[1], i)) nonAAPixels++; }
        }
        rows.push({ case: spec.name, group: spec.group, frame, changedPixels, maxDelta, overTolerance, nonAAPixels, visible,
          baselineSha256: await digest(pixels[0]), candidateSha256: await digest(pixels[1]) });
      }
      for (let index = 0; index < 2; index++) {
        sides[index].renderer.bindContext(); const state = states[index];
        state.sm?.delete(); state.anim?.delete(); state.art.delete(); state.vm?.delete(); state.file.unref();
      }
    }
    for (const spec of cases) {
      assert(rows.some((row) => row.case === spec.name && row.visible > 0), "Invisible case " + spec.name);
      if (spec.group.startsWith("hatImage:") ||
        spec.group.startsWith("tieImage:") || spec.synthetic) {
        assert(sides[1].meshDraws[spec.name] > 0, "Cosmetic did not draw as a mesh: " + spec.name);
      }
    }
    const pathPrograms = sides[1].programs.filter((program) =>
      ["path", "interiorTriangles", "featherAtlasBlit"].includes(program.type));
    const materialPrograms = pathPrograms.filter((program) =>
      program.features.includes("ENABLE_HSL_BLEND_MODES"));
    assert(materialPrograms.some((program) => Object.keys(program.usedCases).length > 0),
      "No material path program was used.");
    for (const program of materialPrograms) for (const name of Object.keys(program.usedCases)) {
      assert(cases.find((spec) => spec.name === name).material !== 0,
        "A plain scene used a material path program: " + name);
    }
    const programs = sides.map((side) => ({ gpu: side.gpu, meshDraws: side.meshDraws, programs: side.programs.filter((program) => program.type !== "aux") }));
    for (const side of sides) { side.renderer.bindContext(); for (const image of Object.values(side.bindings)) image.unref(); side.renderer.delete(); }
    return { rows, programs, materialPathProgramsOnlyUsedWithMaterials: true };
  }, { packages, cases, images });
  result.packages = packages.map(({ macros, ...metadata }) => metadata);
  result.manifest = manifest;
  result.caseCount = cases.length;
  result.samples = result.rows.length;
  result.summary = Object.fromEntries([...new Set(cases.map((item) => item.group))].map((group) => {
    const rows = result.rows.filter((row) => row.group === group);
    return [group, { cases: cases.filter((item) => item.group === group).length, samples: rows.length,
      changedPixels: rows.reduce((sum, row) => sum + row.changedPixels, 0), maxDelta: Math.max(...rows.map((row) => row.maxDelta)),
      overTolerance: rows.reduce((sum, row) => sum + row.overTolerance, 0), nonAAPixels: rows.reduce((sum, row) => sum + row.nonAAPixels, 0) }];
  }));
  result.programsWithoutM = result.programs[1].programs.every((program) => !program.features.includes("ENABLE_MODULATED_IMAGE"));
  await writeFile(join(output, "pixel-comparison.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ summary: result.summary, programsWithoutM: result.programsWithoutM }, null, 2));
  if (!result.programsWithoutM || result.rows.some((row) => row.nonAAPixels)) process.exitCode = 1;
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
