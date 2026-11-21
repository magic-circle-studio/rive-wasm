// Packs js/npm/webgl2_advanced, installs the tarball into a temporary project,
// and drives each binary through the package's shared JavaScript loader in
// headless Chrome on real WebGL2, so a file missing from the package or a
// regression in an API Magic Garden calls fails the check. RIVE_TEST_WASM picks
// one binary.
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, parseShaderMacros } from "./webgl2_test_support.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const packageDirectory = join(repositoryRoot, "js/npm/webgl2_advanced");
const shaderMacros = parseShaderMacros(await readFile(join(repositoryRoot,
  "wasm/build/webgl2_advanced/bin/release/include/generated/shaders/glsl.glsl.exports.h"), "utf8"));
const resultMarker = "RIVE_PACKAGE_TEST_RESULT";
const wasmFilenames = process.env.RIVE_TEST_WASM
  ? [process.env.RIVE_TEST_WASM]
  : ["rive.wasm", "rive_fallback.wasm"];

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

/** Runs a child process and returns its captured output. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

/** Serves the temporary packed-package fixture over HTTP. */
async function startServer(rootDirectory) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/next-frame") {
        // Yield real time to the driver even when Chrome advances virtual time.
        setTimeout(() => response.writeHead(204).end(), 16);
        return;
      }
      const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const path = resolve(rootDirectory, relativePath);
      if (path !== rootDirectory && !path.startsWith(`${rootDirectory}/`)) {
        response.writeHead(403).end();
        return;
      }
      const contents = await readFile(path);
      response.writeHead(200, {
        "Content-Type": mimeTypes.get(extname(path)) ?? "application/octet-stream",
      });
      response.end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The package test HTTP server did not bind a TCP port.");
  }
  return {
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
    url: `http://127.0.0.1:${address.port}`,
  };
}

/** Exercises the binary named by ?wasm= through the shared JavaScript loader. */
const testPage = String.raw`<!doctype html>
<html>
  <body>
    <pre id="result">pending</pre>
    <script type="module">
      import { pathFixture } from "/webgl2_test_support.mjs";
      const result = document.querySelector("#result");
      const browserMessages = [];
      for (const method of ["error", "warn"]) {
        const original = console[method];
        console[method] = (...values) => {
          browserMessages.push(values.map(String).join(" "));
          original.apply(console, values);
        };
      }
      function finish(payload) {
        result.textContent = ${JSON.stringify(resultMarker)} + JSON.stringify(payload);
      }

      function assert(condition, message) {
        if (!condition) throw new Error(message);
      }

      function makeTexture(gl, width, height) {
        const texture = gl.createTexture();
        assert(texture, "Unable to create a WebGL texture.");
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return texture;
      }

      function readTexturePixels(gl, texture, width, height) {
        const framebuffer = gl.createFramebuffer();
        assert(framebuffer, "Unable to create a readback framebuffer.");
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          texture,
          0,
        );
        assert(
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
          "The external texture framebuffer is incomplete.",
        );
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        return pixels;
      }

      function countOpaquePixels(pixels) {
        let opaquePixels = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] !== 0) opaquePixels++;
        }
        return opaquePixels;
      }

      function countDifferentPixels(left, right) {
        assert(left.length === right.length, "Pixel buffers have different sizes.");
        let differentPixels = 0;
        for (let index = 0; index < left.length; index += 4) {
          if (
            Math.abs(left[index] - right[index]) > 2 ||
            Math.abs(left[index + 1] - right[index + 1]) > 2 ||
            Math.abs(left[index + 2] - right[index + 2]) > 2 ||
            Math.abs(left[index + 3] - right[index + 3]) > 2
          ) {
            differentPixels++;
          }
        }
        return differentPixels;
      }

      // decodeImage() answers only once the browser has decoded pixels, keeps
      // the ImageBitmap on the runtime's image entry until upload or deletion
      // closes it, and revokes every Blob URL it creates.
      async function testDecode(rive, png) {
        const originalCreateImageBitmap = globalThis.createImageBitmap;
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        const imageUrls = [];
        const revokedUrls = new Set();
        URL.createObjectURL = function(blob) {
          const url = originalCreateObjectURL.call(URL, blob);
          imageUrls.push(url);
          return url;
        };
        URL.revokeObjectURL = function(url) {
          revokedUrls.add(url);
          originalRevokeObjectURL.call(URL, url);
        };
        try {
          const gate = Promise.withResolvers();
          globalThis.createImageBitmap = async (...args) => {
            await gate.promise;
            return originalCreateImageBitmap(...args);
          };
          let callbackRan = false;
          const delayedImage = new Promise((resolve) => rive.decodeImage(png, (image) => {
            callbackRan = true;
            resolve(image);
          }));
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert(!callbackRan, "decodeImage completed before bitmap decoding.");
          gate.resolve();
          (await delayedImage).unref();

          for (const mode of ["bitmap", "unavailable", "rejected"]) {
            globalThis.createImageBitmap = mode === "bitmap"
              ? originalCreateImageBitmap
              : mode === "unavailable"
                ? undefined
                : () => Promise.reject(new Error("Test bitmap decode failure"));
            const previous = new Set(rive.images.values());
            const decoded = await new Promise((resolve) => rive.decodeImage(png, resolve));
            assert(decoded, "decodeImage failed: " + mode);
            const added = Array.from(rive.images.values()).filter((image) => !previous.has(image));
            assert(added.length === 1, "Expected one new runtime image: " + mode);
            const bitmap = added[0].bitmap;
            assert(mode === "bitmap" ? bitmap?.width === 32 : !bitmap,
              "Unexpected pending bitmap: " + mode);
            decoded.unref();
            assert(!Array.from(rive.images.values()).includes(added[0]),
              "Deleted image retained its runtime entry.");
            assert(!bitmap || bitmap.width === 0, "Deleting an unused image leaked its bitmap.");
          }
          globalThis.createImageBitmap = originalCreateImageBitmap;
          const imageCount = rive.images.size;
          const invalidImage = await new Promise((resolve) =>
            rive.decodeImage(new Uint8Array([0, 1, 2, 3]), resolve),
          );
          assert(invalidImage === null, "Invalid image decode did not report failure.");
          assert(rive.images.size === imageCount, "Invalid image leaked its native decode ref.");
          assert(imageUrls.length > 0 && imageUrls.every((url) => revokedUrls.has(url)),
            "Image decode leaked a Blob URL.");
        } finally {
          globalThis.createImageBitmap = originalCreateImageBitmap;
          URL.createObjectURL = originalCreateObjectURL;
          URL.revokeObjectURL = originalRevokeObjectURL;
        }
      }

      // Draws synthetic fixtures (see pathFixture) into texture targets as the
      // game draws atlas slots: under a clip rect, one plain flush() per frame.
      async function testDrawing(rive, png) {
        const macros = ${JSON.stringify(shaderMacros)};
        const hasDefine = (source, name) => source.includes("#define " + macros[name] + " true\n");
        const report = { passed: [], browserParallelCompile: false, pipelineWarmups: {} };
        // dump-dom's virtual clock can withhold rAF on an idle page. Keep a
        // timer watchdog so frame-paced checks also complete in CI.
        const nextFrame = async () => {
          await fetch("/next-frame");
          return new Promise((resolve) => {
            const frame = requestAnimationFrame(() => {
              clearTimeout(timer); resolve();
            });
            const timer = setTimeout(() => {
              cancelAnimationFrame(frame); resolve();
            }, 25);
          });
        };
        const files = [];
        const boards = [];
        const targets = [];
        async function boardFor(options) {
          const file = await rive.load(pathFixture(options));
          assert(file, "Synthetic fixture failed to load.");
          // In-band images decode after import; make them drawable first.
          await Promise.all(Array.from(rive.images?.values() ?? [], (image) => image.decodePromise));
          const board = file.defaultArtboard();
          assert(board, "Synthetic fixture has no artboard.");
          board.advance(0);
          files.push(file); boards.push(board);
          return board;
        }
        const normal = await boardFor();
        // Artboard stencil clips otherwise prevent merging on hosts without clip planes.
        const batchPaths = await boardFor({ clip: false });
        const screen = await boardFor({ screen: true });
        const mesh = await boardFor({ meshPNG: png });
        const imageQuad = await boardFor({ imagePNG: png });
        const halfImageQuad = await boardFor({ imagePNG: png, opacity: 0.5 });
        const halfPaintedQuad = await boardFor({ imagePNG: png, pathReference: true, opacity: 0.5 });
        const decodedBitmaps = Array.from(rive.images.values(), (image) => image.bitmap).filter(Boolean);
        const mixed = (renderer) => {
          screen.draw(renderer);
          renderer.save(); renderer.align(rive.Fit.fill, rive.Alignment.center,
            { minX: 80, minY: 0, maxX: 336, maxY: 256 }, normal.bounds);
          normal.draw(renderer); renderer.restore();
          mesh.draw(renderer);
        };
        const mixedMaterials = (renderer) => {
          batchPaths.draw(renderer);
          renderer.save();
          const offset = new rive.Mat2D();
          offset.tx = 80;
          renderer.transform(offset); offset.delete();
          renderer.setSurfaceMaterial(1, 0, 0, 256, 256, -1);
          batchPaths.draw(renderer);
          renderer.restore();
        };

        // Headless SwiftShader may not expose KHR_parallel_shader_compile, so a
        // parallel target stands in for it where needed. Either way its links
        // report incomplete until completeLinks(), as slow background links
        // would. A synchronous target hides the extension.
        function makeTarget({ parallel }) {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 256;
          const gl = canvas.getContext("webgl2", {
            alpha: true, depth: true, stencil: true, antialias: true,
            premultipliedAlpha: true, preserveDrawingBuffer: true,
          });
          assert(gl, "Drawing test has no WebGL2 context.");
          const parallelCompile = gl.getExtension("KHR_parallel_shader_compile");
          report.browserParallelCompile ||= !!parallelCompile;
          const COMPLETION_STATUS_KHR = 0x91b1;
          let linksComplete = false;
          const sources = new Map();
          const attached = new Map();
          const linked = new Map();
          const usedPrograms = [];
          const blitRects = [];
          let activeProgram = null;
          function wrap(name, fn) {
            const original = gl[name].bind(gl);
            gl[name] = (...args) => fn(original, ...args);
          }
          wrap("getExtension", (original, name) => name !== "KHR_parallel_shader_compile"
            ? original(name) : parallel ? parallelCompile ?? { COMPLETION_STATUS_KHR } : null);
          wrap("getProgramParameter", (original, program, name) => name !== COMPLETION_STATUS_KHR
            ? original(program, name) : linksComplete && (!parallelCompile || original(program, name)));
          wrap("shaderSource", (original, shader, source) => {
            sources.set(shader, source); return original(shader, source);
          });
          wrap("attachShader", (original, program, shader) => {
            attached.set(program, [...attached.get(program) ?? [], shader]);
            return original(program, shader);
          });
          wrap("linkProgram", (original, program) => {
            linked.set(program, attached.get(program).map((shader) => sources.get(shader)).join("\n"));
            return original(program);
          });
          wrap("useProgram", (original, program) => {
            activeProgram = linked.get(program); return original(program);
          });
          for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
            wrap(name, (original, ...args) => {
              if (activeProgram) usedPrograms.push(activeProgram);
              return original(...args);
            });
          }
          wrap("blitFramebuffer", (original, ...args) => {
            blitRects.push(args.slice(0, 4)); return original(...args);
          });
          const renderer = rive.makeRenderer(canvas);
          assert(renderer, "Drawing test renderer creation failed.");
          assert(linked.size === 2, "Expected only the color ramp and tessellation programs at creation.");
          const target = makeTexture(gl, 256, 256);
          renderer.setTargetTexture(target, 256, 256);
          const handle = {
            renderer, usedPrograms, blitRects,
            get links() { return linked.size; },
            completeLinks() { linksComplete = true; },
            seed() {
              renderer.bindContext(); renderer.unbindGLInternalResources();
              const fb = gl.createFramebuffer();
              gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
              gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
              gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);
              gl.clearColor(0.1, 0.4, 0.7, 1); gl.clear(gl.COLOR_BUFFER_BIT);
              gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
            },
            pixels() {
              renderer.bindContext(); renderer.unbindGLInternalResources();
              assert(gl.getError() === gl.NO_ERROR, "Rive left a WebGL error.");
              return readTexturePixels(gl, target, 256, 256);
            },
            // Draws under one clip rect, as the game draws an atlas slot: the
            // whole target, or a box the scene is fit into.
            draw(scene, { material = 0, timeSeconds = -1, overlay = false, box = null, clipRect = true } = {}) {
              renderer.bindContext(); renderer.invalidateGLState();
              overlay ? renderer.beginOverlayFrame() : renderer.clear();
              renderer.setSurfaceMaterial(material, 0, 0, 256, 256, timeSeconds);
              renderer.save();
              if (box) {
                renderer.saveClipRect(...box);
                renderer.align(rive.Fit.fill, rive.Alignment.center,
                  { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3] }, scene.bounds);
              } else if (clipRect) renderer.saveClipRect(0, 0, 256, 256);
              typeof scene === "function" ? scene(renderer) : scene.draw(renderer);
              if (box || clipRect) renderer.restoreClipRect();
              renderer.restore();
              usedPrograms.length = 0; renderer.flush();
            },
            drawPipelineWarmup() {
              renderer.bindContext(); renderer.invalidateGLState();
              return renderer.drawPipelineWarmup();
            },
            destroy() {
              renderer.delete(); gl.deleteTexture(target);
              gl.getExtension("WEBGL_lose_context")?.loseContext();
            },
          };
          targets.push(handle);
          return handle;
        }

        // linkDrawPrograms() only starts links. drawPipelineWarmup() then draws
        // one linked warm-up per call and skips, untouched, one still linking;
        // without KHR_parallel_shader_compile every link is already done.
        // A skipped call returns every warm-up (kPipelineWarmups in
        // wasm/src/bindings_webgl2.cpp), so the first, still-linking call
        // gives the count each target must then draw one by one.
        let pipelineWarmupCount = null;
        let probe = null;
        for (const parallel of [true, false]) {
          const warm = makeTarget({ parallel });
          warm.seed();
          const seeded = warm.pixels();
          const creationLinks = warm.links;
          warm.renderer.bindContext(); warm.renderer.linkDrawPrograms();
          const prelinks = warm.links;
          assert(prelinks > creationLinks, "linkDrawPrograms() linked no draw programs.");
          assert(countDifferentPixels(seeded, warm.pixels()) === 0, "linkDrawPrograms() changed the target.");
          let remaining = pipelineWarmupCount;
          let frames = 0;
          let pendingCalls = 0;
          while (remaining !== 0) {
            assert(++frames <= 180, "Warm-ups did not finish within 180 animation frames.");
            await nextFrame();
            // Parallel links finish after two frames.
            if (frames > 2) warm.completeLinks();
            warm.seed();
            const left = warm.drawPipelineWarmup();
            const changedPixels = countDifferentPixels(seeded, warm.pixels());
            if (remaining === null) {
              assert(Number.isInteger(left) && left > 0, "drawPipelineWarmup() returned " + left + ".");
              pipelineWarmupCount = remaining = left;
            }
            if (left === remaining) {
              assert(parallel, "A warm-up waited without KHR_parallel_shader_compile.");
              assert(changedPixels === 0, "A pending warm-up changed the target.");
              ++pendingCalls;
            } else {
              assert(!parallel || frames > 2, "A warm-up drew while its programs were linking.");
              assert(left === remaining - 1,
                "drawPipelineWarmup() returned " + left + " after " + remaining + ".");
              assert(changedPixels > 0, "Warm-up " + (pipelineWarmupCount - remaining) + " drew nothing.");
            }
            remaining = left;
          }
          for (let call = 0; call < 2; call++) {
            warm.seed();
            assert(warm.drawPipelineWarmup() === 0, "A finished warm-up sequence did not return 0.");
            assert(countDifferentPixels(seeded, warm.pixels()) === 0, "A finished warm-up sequence drew.");
          }
          assert(warm.links === prelinks, "A warm-up linked a program linkDrawPrograms() had not.");
          report.pipelineWarmups[parallel ? "parallel" : "synchronous"] =
            { count: pipelineWarmupCount, prelinkedPrograms: prelinks - creationLinks, frames, pendingCalls };
          if (!probe) probe = warm;
        }
        report.passed.push("draw-pipeline warm-ups");

        // The warm-ups cover the programs these draws need.
        const warmedLinks = probe.links;
        const hasMaterial = (source) => hasDefine(source, "ENABLE_HSL_BLEND_MODES");
        const usedPaths = () => probe.usedPrograms.filter((source) => hasDefine(source, "DRAW_PATH"));
        probe.draw(mixed);
        probe.draw(mixed, { material: 1 });
        probe.draw(normal);
        const plainPixels = probe.pixels();
        assert(usedPaths().length > 0 && !usedPaths().some(hasMaterial), "A plain path used the material program.");
        const [goldPixels, rainbowPixels] = [1, 2].map((material) => {
          probe.draw(normal, { material });
          const pixels = probe.pixels();
          assert(usedPaths().some(hasMaterial) && countDifferentPixels(plainPixels, pixels) > 0,
            "Material " + material + " did not draw its path with the material program.");
          return pixels;
        });
        assert(countDifferentPixels(goldPixels, rainbowPixels) > 0, "Gold and Rainbow drew the same pixels.");
        // Gold's sweep crosses the surface in the first 1.5 s of each 3 s
        // cycle. A negative time draws the static Gold of baked thumbnails,
        // even in the same phase. Rainbow ignores time.
        let swept = false;
        for (let timeSeconds = 0; timeSeconds < 1.5; timeSeconds += 0.25) {
          probe.draw(normal, { material: 1, timeSeconds });
          swept ||= countDifferentPixels(goldPixels, probe.pixels()) > 0;
          probe.draw(normal, { material: 1, timeSeconds: timeSeconds - 3 });
          assert(countDifferentPixels(goldPixels, probe.pixels()) === 0,
            "Gold changed at negative time " + (timeSeconds - 3) + ".");
        }
        assert(swept, "Gold's sweep never crossed the path.");

        // Depth-stencil drawImage draws an image mesh over only its bounds.
        // Materials skip raster images, so these match their plain pixels.
        probe.draw(imageQuad);
        const quadPixels = probe.pixels();
        assert(countOpaquePixels(quadPixels) > 0, "The image quad drew nothing.");
        for (const material of [0, 1, 2]) {
          for (const board of [imageQuad, mesh]) {
            probe.draw(board, { material });
            assert(countDifferentPixels(quadPixels, probe.pixels()) === 0,
              "An image drew differently from the plain image quad under material " + material + ".");
          }
        }
        probe.draw(halfImageQuad);
        const halfPixels = probe.pixels();
        probe.draw(halfPaintedQuad);
        assert(countOpaquePixels(halfPixels) > 0 && countDifferentPixels(quadPixels, halfPixels) > 0 &&
          countDifferentPixels(halfPixels, probe.pixels()) === 0,
          "A translucent image quad differs from its path reference.");
        // beginOverlayFrame() keeps the previous frame and draws over it, so two
        // frames match one frame that draws both, and only the box updates.
        probe.draw((renderer) => {
          renderer.saveClipRect(0, 0, 256, 256);
          normal.draw(renderer); renderer.restoreClipRect();
          renderer.saveClipRect(0, 0, 64, 64);
          renderer.align(rive.Fit.fill, rive.Alignment.center,
            { minX: 0, minY: 0, maxX: 64, maxY: 64 }, imageQuad.bounds);
          imageQuad.draw(renderer); renderer.restoreClipRect();
        }, { clipRect: false });
        const compositePixels = probe.pixels();
        probe.draw(normal);
        probe.blitRects.length = 0;
        probe.draw(imageQuad, { overlay: true, box: [0, 0, 64, 64] });
        assert(countDifferentPixels(compositePixels, probe.pixels()) === 0,
          "An overlay frame did not draw over the previous frame.");
        assert(probe.blitRects.length > 0 &&
          probe.blitRects.every(([x0, y0, x1, y1]) => x1 - x0 <= 64 && y1 - y0 <= 64),
          "An overlay image quad updated beyond its clip: " + JSON.stringify(probe.blitRects));
        assert(decodedBitmaps.length > 0 && decodedBitmaps.every((bitmap) => bitmap.width === 0) &&
          Array.from(rive.images.values()).every((image) => !image.bitmap),
          "Uploading an image did not close its decoded bitmap.");
        report.passed.push("plain image meshes, image opacity, overlay frames, and bitmap upload");
        assert(probe.links === warmedLinks, "Drawing after the warm-ups linked another program.");
        report.passed.push("warm-ups cover plain, Gold, Rainbow, screen, image, and overlay draws");

        // A clip rect without clip planes is a stencil clip, which splits
        // batches, so this draws without one.
        probe.draw(mixedMaterials, { clipRect: false });
        // Compatible plain/material paths share a batch whose features are ORed.
        assert(usedPaths().length > 0 && usedPaths().every(hasMaterial),
          "Compatible plain and material paths did not share the material program.");
        probe.draw(normal);
        assert(!usedPaths().some(hasMaterial) && countDifferentPixels(plainPixels, probe.pixels()) === 0,
          "A plain path retained the material program.");
        report.passed.push("opt-in material programs and mixed-path batching");

        // File images keep textures from their last draw context, so release
        // the fixtures before deleting the contexts.
        for (const board of boards) board.delete();
        for (const file of files) file.unref();
        for (const target of targets) target.destroy();
        return report;
      }

      // A texture-backed image owns its texture, and teardown drops the
      // loader's references to external textures so they can be collected.
      async function testTextureTeardown(rive) {
        const textures = (() => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 4;
          const renderer = rive.makeRenderer(canvas);
          const gl = canvas.getContext("webgl2");
          const cleared = makeTexture(gl, 4, 4);
          const target = makeTexture(gl, 4, 4);
          const source = makeTexture(gl, 2, 2);
          renderer.setTargetTexture(cleared, 4, 4);
          renderer.clearTargetTexture();
          renderer.setTargetTexture(target, 4, 4);
          renderer.clear();
          renderer.flush();
          const image = renderer.makeImageFromGLTexture(source, 2, 2);
          assert(image, "makeImageFromGLTexture() returned no image.");
          image.unref();
          assert(!gl.isTexture(source), "Releasing a texture-backed image kept its texture.");
          renderer.delete();
          return [cleared, target, source].map((texture) => new WeakRef(texture));
        })();
        await new Promise((resolve) => setTimeout(resolve, 0));
        gc();
        assert(textures.every((texture) => !texture.deref()), "Renderer teardown retained an external texture.");
      }

      async function main() {
        const packageRoot = "/node_modules/@magiccircle/rive-webgl2-advanced/";
        const { surfaceMaterialShaderSource } = await import(packageRoot + "surface_material_shader.mjs");
        assert(["apply_gold_material", "apply_rainbow_material"].every((name) =>
          surfaceMaterialShaderSource.includes(name)), "The packaged material shader lacks Gold or Rainbow.");
        const { default: createRive } = await import(packageRoot + "webgl2_advanced.mjs");
        const rive = await createRive({
          locateFile: () => packageRoot + new URLSearchParams(location.search).get("wasm"),
        });
        const sourceCanvas = new OffscreenCanvas(32, 32);
        const sourceContext = sourceCanvas.getContext("2d");
        sourceContext.fillStyle = "#e0308080";
        sourceContext.fillRect(0, 0, 32, 32);
        const png = new Uint8Array(await (await sourceCanvas.convertToBlob()).arrayBuffer());
        await testDecode(rive, png);
        const report = await testDrawing(rive, png);
        await testTextureTeardown(rive);
        report.passed.unshift("image decoding");
        report.passed.push("texture-backed images and teardown");
        rive.cleanup?.();
        finish({ ok: true, ...report });
      }

      addEventListener("error", (event) =>
        finish({ ok: false, error: event.message, browserMessages }),
      );
      addEventListener("unhandledrejection", (event) =>
        finish({
          ok: false,
          error: String(event.reason?.stack ?? event.reason),
          browserMessages,
        }),
      );
      main().catch((error) =>
        finish({
          ok: false,
          error: String(error?.stack ?? error),
          browserMessages,
        }),
      );
    </script>
  </body>
</html>`;

/** Installs the packed artifact so omitted package files fail the check. */
async function installPackage(directory) {
  const packResult = await run(
    "npm",
    ["pack", packageDirectory, "--json", "--pack-destination", directory],
    { cwd: repositoryRoot },
  );
  if (packResult.status !== 0) {
    throw new Error(`npm pack failed:\n${packResult.stderr}`);
  }
  const packMetadata = JSON.parse(packResult.stdout);
  const tarballPath = join(directory, packMetadata[0].filename);
  await stat(tarballPath);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const installResult = await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarballPath,
    ],
    { cwd: directory },
  );
  if (installResult.status !== 0) {
    throw new Error(`Installing the packed artifact failed:\n${installResult.stderr}`);
  }
  await copyFile(join(scriptDirectory, "webgl2_test_support.mjs"), join(directory, "webgl2_test_support.mjs"));
  await writeFile(join(directory, "index.html"), testPage);
}

/** Loads the test page for one binary and returns its result. */
async function runPage(browser, serverUrl, wasmFilename) {
  const browserResult = await run(browser, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-webgl",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    // Without --use-gl=angle, headless Chrome 155 on Linux loses every WebGL
    // context shortly after load, even on SwiftShader.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    // A failed Vulkan compositor surface restarts the GPU process, losing
    // every WebGL context the page created before it.
    "--disable-features=Vulkan",
    // The teardown check collects garbage to prove textures were released.
    "--js-flags=--expose-gc",
    "--virtual-time-budget=30000",
    "--dump-dom",
    `${serverUrl}/?wasm=${encodeURIComponent(wasmFilename)}`,
  ]);
  const markerIndex = browserResult.stdout.indexOf('<pre id="result">' + resultMarker);
  const resultMarkerOffset = '<pre id="result">'.length;
  if (browserResult.status !== 0 || markerIndex < 0) {
    throw new Error(
      `Chrome did not complete the package test.\n${browserResult.stderr}\n${browserResult.stdout}`,
    );
  }
  const resultStart = markerIndex + resultMarkerOffset + resultMarker.length;
  const resultEnd = browserResult.stdout.indexOf("</pre>", resultStart);
  const result = JSON.parse(browserResult.stdout.slice(resultStart, resultEnd));
  if (!result.ok) {
    throw new Error(
      `Packed browser test failed (${wasmFilename}): ${result.error}\n` +
        `${result.browserMessages?.join("\n") ?? ""}\n${browserResult.stderr}`,
    );
  }
  return result;
}

const browser = await findChrome();
const temporaryDirectory = await mkdtemp(join(tmpdir(), "rive-webgl2-package-"));
try {
  await installPackage(temporaryDirectory);
  const server = await startServer(temporaryDirectory);
  try {
    for (const wasmFilename of wasmFilenames) {
      const result = await runPage(browser, server.url, wasmFilename);
      console.log("Packed WebGL2 browser test passed:", wasmFilename);
      console.dir(result, { depth: null });
    }
  } finally {
    await server.close();
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
