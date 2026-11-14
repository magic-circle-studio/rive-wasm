import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, parseShaderMacros } from "./webgl2_test_support.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const packageDirectory =
  process.env.RIVE_TEST_PACKAGE_DIR ??
  join(repositoryRoot, "js/npm/webgl2_advanced");
const fixturePath =
  process.env.RIVE_TEST_FIXTURE ??
  join(repositoryRoot, "js/test/assets/fallback_fonts_test.riv");
const imageBindingFixturePath = join(
  repositoryRoot,
  "wasm/submodules/rive-runtime/tests/unit_tests/assets/data_binding_images_test.riv",
);
const shaderExports = await readFile(join(repositoryRoot,
  "wasm/build/webgl2_advanced/bin/release/include/generated/shaders/glsl.glsl.exports.h"), "utf8");
const shaderMacros = parseShaderMacros(shaderExports);
const resultMarker = "RIVE_PACKAGE_TEST_RESULT";
const legacyComparison = process.env.RIVE_TEST_LEGACY === "1";
const artboardName = process.env.RIVE_TEST_ARTBOARD ?? null;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".riv", "application/octet-stream"],
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

/** Exercises one binary through the package's shared JavaScript loader. */
const testPage = (wasmFilename) => String.raw`<!doctype html>
<html>
  <body>
    <pre id="result">pending</pre>
    <canvas id="canvas" width="256" height="256"></canvas>
    <script type="module">
      import { pathFixture } from "/webgl2_test_support.mjs";
      if (${JSON.stringify(process.env.RIVE_TEST_HIDE_PARALLEL === "1")}) {
        const getExtension = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function(name) {
          return name === "KHR_parallel_shader_compile" ? null : getExtension.call(this, name);
        };
      }
      const result = document.querySelector("#result");
      const browserMessages = [];
      for (const method of ["error", "warn"]) {
        const original = console[method];
        console[method] = (...values) => {
          browserMessages.push(values.map(String).join(" "));
          original.apply(console, values);
        };
      }
      const apiNames = [
        "beginOverlayFrame",
        "invalidateGLState",
        "unbindGLInternalResources",
        "setTargetTexture",
        "clearTargetTexture",
        "makeImageFromGLTexture",
        "setSurfaceMaterial",
      ];
      if (!${JSON.stringify(legacyComparison)}) {
        apiNames.push("bindContext", "tryFlush", "clearRect", "linkDrawPrograms");
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

      function readCanvasPixels(gl, width, height) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
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

      // Write tiny, deterministic RIVE v7 fixtures using generated core keys.
      // This keeps normal, screen, and feather paths independent of art assets.
      async function testDeferredFlush(rive, png) {
        const macros = ${JSON.stringify(shaderMacros)};
        const report = { passed: [], parallel: false };
        // dump-dom's virtual clock can withhold rAF on an idle page. Keep a
        // timer watchdog so the same retry checks also complete in CI.
        report.animationFrames = 0;
        report.timerRetries = 0;
        const nextFrame = async () => {
          await fetch("/next-frame");
          return new Promise((resolve) => {
            const frame = requestAnimationFrame(() => {
              clearTimeout(timer); ++report.animationFrames; resolve();
            });
            const timer = setTimeout(() => {
              cancelAnimationFrame(frame); ++report.timerRetries; resolve();
            }, 25);
          });
        };
        const files = [];
        const boards = [];
        const cleanups = [];
        async function boardFor(bytes) {
          const file = await rive.load(bytes);
          assert(file, "Deferred fixture failed to load.");
          // In-band images decode after import; make the mesh drawable before
          // measuring its first shader link.
          await Promise.all(Array.from(rive.images?.values() ?? [], (image) => image.decodePromise));
          const board = file.defaultArtboard();
          assert(board, "Deferred fixture has no artboard.");
          board.advance(0);
          files.push(file); boards.push(board);
          return board;
        }
        const normal = await boardFor(pathFixture());
        // Artboard stencil clips otherwise prevent merging on hosts without clip planes.
        const batchPaths = await boardFor(pathFixture({ clip: false }));
        const screen = await boardFor(pathFixture({ screen: true }));
        const feather = await boardFor(pathFixture({ feather: true }));
        const mesh = await boardFor(pathFixture({ meshPNG: png }));
        const imageQuad = await boardFor(pathFixture({ imagePNG: png }));
        const imageMeshQuad = await boardFor(pathFixture({ meshPNG: png, unitMesh: true }));
        const paintedQuad = await boardFor(pathFixture({ imagePNG: png, pathReference: true }));

        function hasDefine(source, name) {
          return source.includes("#define " + macros[name] + " true\n");
        }
        function makeTarget({ hideParallel = false } = {}) {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 256;
          const gl = canvas.getContext("webgl2", {
            alpha: true, depth: true, stencil: true, antialias: true,
            premultipliedAlpha: true, preserveDrawingBuffer: true,
          });
          assert(gl, "Deferred test has no WebGL2 context.");
          const extension = gl.getExtension("KHR_parallel_shader_compile");
          const parallel = !!extension && !hideParallel;
          report.parallel ||= parallel;
          const programs = [];
          const sources = new Map();
          const attached = new Map();
          const violations = [];
          let call = 0;
          let phase = "constructor";
          let issued = false;
          let gate = false;
          let activeProgram = null;
          const usedPrograms = [];
          const blitRects = [];
          const imageMaterialLocations = new Set();
          let imageMaterialWrites = 0;
          const blockedFamilies = new Set();
          const methods = {};
          function wrap(name, fn) {
            methods[name] = gl[name];
            gl[name] = function(...args) { return fn(methods[name].bind(this), ...args); };
          }
          wrap("getExtension", (original, name) =>
            hideParallel && name === "KHR_parallel_shader_compile" ? null : original(name));
          wrap("shaderSource", (original, shader, source) => {
            sources.set(shader, source); return original(shader, source);
          });
          wrap("attachShader", (original, program, shader) => {
            if (!attached.has(program)) attached.set(program, []);
            attached.get(program).push(shader); return original(program, shader);
          });
          for (const name of ["clear", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "blitFramebuffer"]) {
            wrap(name, (original, ...args) => {
              if (name.startsWith("draw") && activeProgram?.draw) usedPrograms.push(activeProgram);
              if (name === "blitFramebuffer") blitRects.push(args.slice(0, 4));
              issued = true; return original(...args);
            });
          }
          wrap("linkProgram", (original, program) => {
            assert(!parallel || phase !== "try" || !issued,
              "Issue pass submitted a program link.");
            const shaders = attached.get(program).map((shader) => sources.get(shader));
            const source = shaders.join("\n");
            const fragment = shaders.find((source) =>
              source.includes("#define " + macros.FRAGMENT + "\n")) ?? "";
            const draw = programs.length >= 3;
            const atlas = hasDefine(source, "ATLAS_FEATHERED_FILL") || hasDefine(source, "ATLAS_FEATHERED_STROKE");
            const family = programs.length === 2 ? "blit" : atlas ? (hasDefine(source, "ATLAS_FEATHERED_STROKE") ? "featherStroke" : "feather") : hasDefine(source, "DRAW_IMAGE_MESH") ? "image"
              : hasDefine(fragment, "ENABLE_ADVANCED_BLEND") || hasDefine(fragment, "ENABLE_KHR_BLEND") ? "screen" : "normal";
            programs.push({ program, source, family, draw: draw && !atlas, atlas,
              excluded: programs.length < 2, complete: false, polls: new Map(), statusReads: [], phase });
            return original(program);
          });
          const info = (program) => programs.find((item) => item.program === program);
          function blocking(name, program) {
            const item = info(program);
            if (parallel && phase !== "blocking" && item && !item.excluded && !item.complete) {
              violations.push(name + " before completion: " + item.family);
            }
          }
          wrap("getProgramParameter", (original, program, parameter) => {
            assert(!parallel || phase !== "try" || !issued, "Issue pass queried a program.");
            const item = info(program);
            if (parameter === gl.LINK_STATUS || parameter === extension?.COMPLETION_STATUS_KHR) {
              item?.statusReads.push({ parameter, phase });
            }
            if (parameter === extension?.COMPLETION_STATUS_KHR) {
              const polls = (item.polls.get(call) ?? 0) + 1;
              item.polls.set(call, polls);
              assert(phase !== "try" || polls <= 1, "Program polled more than once in one tryFlush().");
              const ready = original(program, parameter);
              if (!gate || blockedFamilies.has(item.family)) return false;
              item.complete ||= ready;
              return ready;
            }
            blocking("getProgramParameter(" + parameter + ")", program);
            const value = original(program, parameter);
            if (parameter === gl.LINK_STATUS && phase === "blocking" && item) item.complete ||= value;
            return value;
          });
          for (const name of ["useProgram", "getUniformLocation", "getUniformBlockIndex"]) {
            wrap(name, (original, program, ...args) => {
              assert(!parallel || name === "useProgram" || phase !== "try" || !issued,
                "Issue pass queried a uniform.");
              blocking(name, program);
              const result = original(program, ...args);
              if (name === "useProgram") activeProgram = info(program);
              if (name === "getUniformLocation" &&
                [macros.imageSurfaceMaterialMatrix, macros.imageSurfaceMaterialTranslate].includes(args[0])) {
                imageMaterialLocations.add(result);
              }
              return result;
            });
          }
          for (const name of ["uniform4f", "uniform4fv"]) {
            wrap(name, (original, location, ...args) => {
              if (imageMaterialLocations.has(location)) imageMaterialWrites++;
              return original(location, ...args);
            });
          }
          const renderer = rive.makeRenderer(canvas);
          assert(renderer, "Deferred renderer creation failed.");
          assert(programs.length === 3, "Expected color ramp, tessellation, and prelinked blit at creation.");
          renderer.bindContext();
          const target = makeTexture(gl, 256, 256);
          renderer.setTargetTexture(target, 256, 256);
          const pixels = () => {
            renderer.bindContext(); renderer.unbindGLInternalResources();
            return readTexturePixels(gl, target, 256, 256);
          };
          function seed() {
            phase = "seed"; issued = false;
            renderer.bindContext(); renderer.unbindGLInternalResources();
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
            gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);
            gl.clearColor(0.1, 0.4, 0.7, 1); gl.clear(gl.COLOR_BUFFER_BIT);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
          }
          function record({ mix = false, overlay = false, feathered = false, clear = true, quad = false, meshQuad = false, paintQuad = false, material = 0, mixedMaterials = false, modulatedOpacity = 1, box = null, clipRect = false, empty = false } = {}) {
            renderer.bindContext(); renderer.invalidateGLState();
            overlay ? renderer.beginOverlayFrame() : renderer.clear();
            if (empty) return;
            renderer.setSurfaceMaterial(material, 0, 0, 256, 256, -1);
            renderer.save(); renderer.modulateOpacity(modulatedOpacity);
            if (clipRect) renderer.saveClipRect(0, 0, 256, 256);
            usedPrograms.length = 0;
            if (overlay && clear) renderer.clearRect(12, 36, 92, 100);
            if (mix) {
              screen.draw(renderer);
              renderer.save(); renderer.align(rive.Fit.fill, rive.Alignment.center,
                { minX: 80, minY: 0, maxX: 336, maxY: 256 }, normal.bounds);
              normal.draw(renderer); renderer.restore();
              mesh.draw(renderer);
            } else if (feathered) {
              renderer.save();
              renderer.align(rive.Fit.contain, rive.Alignment.center,
                { minX: 0, minY: 0, maxX: 256, maxY: 256 }, feather.bounds);
              feather.draw(renderer); renderer.restore();
            } else {
              const board = mixedMaterials ? batchPaths : quad ? imageQuad : meshQuad ? imageMeshQuad : paintQuad ? paintedQuad : normal;
              if (box) {
                renderer.saveClipRect(...box);
                renderer.align(rive.Fit.fill, rive.Alignment.center,
                  { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3] }, board.bounds);
              }
              board.draw(renderer);
              if (box) renderer.restoreClipRect();
              if (mixedMaterials) {
                renderer.save();
                const offset = new rive.Mat2D();
                offset.tx = 80;
                renderer.transform(offset); offset.delete();
                renderer.setSurfaceMaterial(1, 0, 0, 256, 256, -1);
                batchPaths.draw(renderer);
                renderer.restore();
              }
            }
            if (clipRect) renderer.restoreClipRect();
            renderer.restore();
          }
          function attempt(options) {
            phase = "try"; issued = false; ++call; record(options);
            const pending = renderer.tryFlush();
            assert(violations.length === 0, "Blocking link queries: " + violations.join(", "));
            return pending;
          }
          async function untilDrawn(options) {
            document.body.dataset.deferredStep += ".retry";
            for (let frame = 0; frame < 180; frame++) {
              await nextFrame();
              if (attempt(options) === 0) return;
            }
            throw new Error("tryFlush() did not finish linking within 180 animation frames.");
          }
          return { renderer, gl, programs, parallel, violations, blockedFamilies, seed, pixels, usedPrograms, blitRects,
            get imageMaterialWrites() { return imageMaterialWrites; },
            attempt, untilDrawn, setGate: (open) => { gate = open; },
            linkPrograms() {
              phase = parallel ? "submit" : "blocking"; ++call;
              renderer.linkDrawPrograms();
            },
            block(options) {
              phase = "blocking"; issued = false;
              ++call; record(options); renderer.flush();
            },
            destroy() {
              // File images retain textures from their last draw context.
              // Release the fixtures before deleting those contexts.
              cleanups.push(() => {
                renderer.bindContext(); renderer.delete();
                gl.deleteTexture(target);
                for (const [name, method] of Object.entries(methods)) gl[name] = method;
                gl.getExtension("WEBGL_lose_context")?.loseContext();
              });
            },
          };
        }

        document.body.dataset.deferredStep = "deferred";
        const deferred = makeTarget();
        deferred.seed();
        const before = deferred.pixels();
        const first = deferred.attempt();
        assert(deferred.parallel ? first > 0 : first === 0,
          "Fresh tryFlush() did not report pending or the documented fallback.");
        if (deferred.parallel) {
          assert(countDifferentPixels(before, deferred.pixels()) === 0, "Pending path frame changed the target.");
          deferred.setGate(true); await deferred.untilDrawn();
        }
        const drawn = deferred.pixels();
        assert(countOpaquePixels(drawn) > 0, "Deferred path drew no pixels.");
        document.body.dataset.deferredStep = "blocking";
        const blocking = makeTarget();
        blocking.block();
        assert(countDifferentPixels(drawn, blocking.pixels()) === 0, "Deferred pixels differ from blocking flush().");
        report.passed.push("path retry and pixels", "completion gates and once-per-call polls");
        blocking.destroy(); deferred.destroy();

        const pendingBlock = makeTarget();
        const blocked = pendingBlock.attempt();
        const queuedPrograms = pendingBlock.programs.filter((program) => program.draw).length;
        if (pendingBlock.parallel) assert(blocked > 0, "Pending blocking-reuse fixture drew too soon.");
        pendingBlock.block();
        assert(pendingBlock.programs.filter((program) => program.draw).length === queuedPrograms,
          "Blocking flush created a duplicate pending program.");
        assert(countDifferentPixels(drawn, pendingBlock.pixels()) === 0,
          "Blocking flush did not finish the already-pending program.");
        pendingBlock.destroy(); report.passed.push("blocking reuse of pending ubershader");

        document.body.dataset.deferredStep = "mixed";
        const mixed = makeTarget();
        mixed.seed(); const mixedBefore = mixed.pixels();
        const mixedOptions = { mix: true };
        const mixedPending = mixed.attempt(mixedOptions);
        if (mixed.parallel) {
          assert(mixedPending >= 3, "Mixed frame did not report all three shader families pending.");
          for (const family of ["normal", "screen", "image"]) {
            assert(mixed.programs.some((program) => program.draw && program.family === family),
              "Mixed frame did not link the " + family + " ubershader: " + JSON.stringify(mixed.programs.map(({family, draw, atlas}) => ({family, draw, atlas}))));
            mixed.blockedFamilies.add(family);
          }
          mixed.setGate(true);
          for (const family of ["normal", "screen", "image"]) {
            await nextFrame();
            assert(mixed.attempt(mixedOptions) > 0, "Mixed frame drew with a family still pending.");
            assert(countDifferentPixels(mixedBefore, mixed.pixels()) === 0, "Pending mixed frame changed pixels.");
            mixed.blockedFamilies.delete(family);
          }
          await mixed.untilDrawn(mixedOptions);
        } else assert(mixedPending === 0, "Mixed fallback did not draw immediately.");
        report.passed.push("mixed families and pending gates");
        mixed.destroy();

        document.body.dataset.deferredStep = "overlay";
        const overlay = makeTarget();
        overlay.seed(); const overlayBefore = overlay.pixels();
        const overlayOptions = { overlay: true };
        const overlayPending = overlay.attempt(overlayOptions);
        if (overlay.parallel) {
          assert(overlayPending >= 2, "Cold overlay did not count both path and blit programs.");
          assert(countDifferentPixels(overlayBefore, overlay.pixels()) === 0, "Pending overlay cleared the target.");
          overlay.blockedFamilies.add("blit"); overlay.setGate(true);
          let onlyBlitPending = false;
          for (let frame = 0; frame < 180; frame++) {
            await nextFrame();
            const pending = overlay.attempt(overlayOptions);
            assert(pending > 0, "Overlay drew before its blit finished.");
            assert(countDifferentPixels(overlayBefore, overlay.pixels()) === 0, "Pending blit changed overlay pixels.");
            if (overlay.programs.filter((program) => program.draw).every((program) => program.complete)) {
              assert(pending === 1, "Ready paths should wait on exactly the blit program.");
              onlyBlitPending = true; break;
            }
          }
          assert(onlyBlitPending, "Overlay path programs did not become ready.");
          overlay.blockedFamilies.delete("blit");
          await overlay.untilDrawn(overlayOptions);
        } else assert(overlayPending === 0, "Overlay fallback was not immediate.");
        const overlayPixels = overlay.pixels();
        const pixel = (pixels, x, y) => Array.from(pixels.slice(((255 - y) * 256 + x) * 4, ((255 - y) * 256 + x) * 4 + 4));
        assert(pixel(overlayPixels, 16, 40)[3] === 0, "Overlay clear rectangle has the wrong position/orientation.");
        assert(pixel(overlayPixels, 48, 64)[3] > 0, "Overlay did not redraw the path.");
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
          if (x >= 12 && x < 92 && y >= 36 && y < 100) continue;
          assert(pixel(overlayPixels, x, y).every((value, channel) =>
            value === pixel(overlayBefore, x, y)[channel]), "Overlay changed pixels outside clearRect.");
        }
        assert(overlay.programs.filter((program) => !program.draw && !program.atlas).length === 3,
          "Overlay linked an auxiliary blit program at draw time.");
        overlay.seed();
        overlay.block({ overlay: true, clear: false });
        assert(pixel(overlay.pixels(), 16, 40)[3] === 255, "clearRect leaked into the next frame.");
        overlay.block(overlayOptions);
        assert(countDifferentPixels(overlayPixels, overlay.pixels()) === 0,
          "Blocking flush did not honor clearRect.");
        report.passed.push("overlay atomic clear, preservation, and orientation");
        overlay.destroy();

        const discarded = makeTarget();
        discarded.seed();
        const discardPending = discarded.attempt({ overlay: true });
        if (discarded.parallel) {
          assert(discardPending > 0, "Discard fixture drew too soon.");
          discarded.setGate(true);
          await discarded.untilDrawn({ overlay: true, clear: false });
          assert(pixel(discarded.pixels(), 16, 40)[3] === 255,
            "A skipped frame's clearRect leaked into the retry.");
        } else assert(discardPending === 0, "Discard fixture fallback did not draw.");
        discarded.destroy(); report.passed.push("skipped-frame rectangle consumption");

        document.body.dataset.deferredStep = "noParallel";
        const noParallel = makeTarget({ hideParallel: true });
        noParallel.seed(); const noParallelBefore = noParallel.pixels();
        assert(noParallel.attempt() === 0, "Missing-extension fallback did not return 0.");
        const noParallelPixels = noParallel.pixels();
        assert(countDifferentPixels(noParallelBefore, noParallelPixels) > 0,
          "Missing-extension fallback left the seeded target unchanged.");
        assert(countDifferentPixels(drawn, noParallelPixels) === 0,
          "Missing-extension fallback differs from blocking flush().");
        noParallel.destroy(); report.passed.push("hidden-extension fallback");

        const noParallelBlocking = makeTarget({ hideParallel: true });
        noParallelBlocking.block();
        const noParallelDraws = noParallelBlocking.programs.filter((program) => program.draw);
        assert(noParallelDraws.length === 1,
          "Blocking flush without KHR must submit one draw-program link.");
        assert(countDifferentPixels(drawn, noParallelBlocking.pixels()) === 0,
          "Blocking path without KHR produced different pixels.");
        noParallelBlocking.destroy(); report.passed.push("blocking link count without KHR");

        const eagerReference = makeTarget();
        for (const hideParallel of [false, true]) {
          const eager = makeTarget({ hideParallel });
          eager.linkPrograms();
          const drawPrograms = eager.programs.filter((program) => program.draw);
          const clipped = drawPrograms.some((program) => hasDefine(program.source, "ENABLE_CLIP_RECT"));
          assert(drawPrograms.length === (clipped ? 8 : 7), "linkDrawPrograms submitted the wrong set.");
          const links = eager.programs.length;
          eager.linkPrograms();
          if (eager.parallel) {
            assert(eager.programs.every((program) =>
              !program.statusReads.some((read) => read.phase === "submit")),
              "Background submission read LINK_STATUS or COMPLETION_STATUS_KHR.");
            assert(eager.violations.length === 0, "Background submission queried a pending program.");
            assert(eager.attempt({ empty: true }) === 0, "Empty frame reported pending programs.");
            assert(eager.programs.every((program) =>
              !program.statusReads.some((read) => read.phase === "try")),
              "Empty frame polled an unused program.");
            // Without clip planes an outer clip also needs stencil clip reset.
            const oneProgramFrame = { clipRect: clipped };
            assert(eager.attempt(oneProgramFrame) > 0, "Closed completion gate did not defer the needed program.");
            const needed = drawPrograms.filter((program) => program.polls.size > 0);
            assert(needed.length === 1, "A one-program frame polled unused draw programs.");
            eager.setGate(true);
            await eager.untilDrawn(oneProgramFrame);
            assert(drawPrograms.filter((program) => program !== needed[0]).every((program) =>
              program.statusReads.length === 0), "Retry polled programs reserved for later frames.");
          } else {
            assert(drawPrograms.every((program) => program.complete),
              "linkDrawPrograms did not finish synchronously without KHR.");
          }
          for (const options of [{ mix: true, clipRect: true }, { material: 1, mixedMaterials: true, clipRect: true },
            { quad: true, material: 1, box: [0, 0, 128, 128], clipRect: true }]) {
            eagerReference.block(options);
            if (eager.parallel) await eager.untilDrawn(options);
            else assert(eager.attempt(options) === 0, "Synchronous prelink left a pending draw program.");
            assert(countDifferentPixels(eagerReference.pixels(), eager.pixels()) === 0,
              "Prelinked rendering differs from lazy blocking rendering.");
          }
          assert(eager.programs.length === links, "Prelinked draws or a repeated call submitted another link.");
          eager.destroy();
        }
        eagerReference.destroy(); report.passed.push("known-program submission, frame-only polling, and synchronous fallback");

        document.body.dataset.deferredStep = "feather";
        const feathered = makeTarget();
        feathered.seed(); const featherBefore = feathered.pixels();
        const featherOptions = { feathered: true };
        const featherPending = feathered.attempt(featherOptions);
        assert(feathered.programs.filter((program) => program.atlas).length >= 2,
          "Feather fixture did not start feather atlas programs.");
        if (feathered.parallel) {
          assert(featherPending > 0, "Feather frame was not pending.");
          assert(countDifferentPixels(featherBefore, feathered.pixels()) === 0, "Pending feather frame changed the target.");
          // The fixture only fills, so a pending stroke program must not block it.
          feathered.blockedFamilies.add("featherStroke");
          feathered.setGate(true); await feathered.untilDrawn(featherOptions);
        } else assert(featherPending === 0, "Feather fallback was not immediate.");
        const featherPixels = feathered.pixels();
        assert(countOpaquePixels(featherPixels) > 0 && countDifferentPixels(featherBefore, featherPixels) > 0,
          "Feather frame did not draw visible pixels over the seeded target.");
        feathered.block(featherOptions);
        assert(countDifferentPixels(featherPixels, feathered.pixels()) === 0,
          "Feather tryFlush() differs from blocking flush().");
        feathered.destroy(); report.passed.push("lazy feather completion gates");

        const imageProbe = makeTarget();
        imageProbe.block({ quad: true });
        const quadPixels = imageProbe.pixels();
        assert(countOpaquePixels(quadPixels) > 0, "The non-mesh Image fixture drew nothing.");
        assert(imageProbe.programs.some((program) => program.draw && program.family === "image"),
          "Depth-stencil drawImage did not use an image-mesh program.");
        assert(!imageProbe.programs.some((program) => hasDefine(program.source, "ENABLE_MODULATED_IMAGE")),
          "A plain image draw linked M.");
        imageProbe.block({ paintQuad: true });
        assert(countDifferentPixels(quadPixels, imageProbe.pixels()) === 0,
          "The image-mesh route differs from the equivalent path reference.");
        assert(imageProbe.imageMaterialWrites === 0,
          "Plain images uploaded material uniforms.");
        const meshHasH = imageProbe.programs.some((program) => program.family === "image" && hasDefine(program.source, "ENABLE_HSL_BLEND_MODES"));
        const imageProgramsBeforeMaterial = imageProbe.programs.filter((program) => program.family === "image").length;
        report.passed.push("DS image quad uses mesh and matches path reference");
        imageProbe.blitRects.length = 0;
        imageProbe.block({ quad: true, overlay: true, clear: false, box: [0, 0, 64, 64] });
        assert(imageProbe.blitRects.length > 0 &&
          imageProbe.blitRects.every(([x0, y0, x1, y1]) => x1 - x0 <= 64 && y1 - y0 <= 64),
          "An overlay image quad updated beyond its clip: " + JSON.stringify(imageProbe.blitRects));
        report.passed.push("overlay image quad updates only its bounds");
        imageProbe.block({ quad: true, modulatedOpacity: 0.5 });
        const halfOpacityPixels = imageProbe.pixels();
        imageProbe.block({ paintQuad: true, modulatedOpacity: 0.5 });
        assert(countOpaquePixels(halfOpacityPixels) > 0 &&
          countDifferentPixels(halfOpacityPixels, imageProbe.pixels()) === 0 &&
          countDifferentPixels(quadPixels, halfOpacityPixels) > 0,
          "Image opacity differs from the path reference under modulateOpacity.");
        report.passed.push("image modulated opacity applied once");


        for (const material of [1, 2]) {
          imageProbe.block({ meshQuad: true, material });
          const materialPixels = imageProbe.pixels();
          assert(countDifferentPixels(quadPixels, materialPixels) > 0,
            "An authored image mesh lost its surface material.");
          imageProbe.block({ quad: true, material });
          assert(countDifferentPixels(materialPixels, imageProbe.pixels()) === 0,
            "Materialized drawImage differs from an authored image mesh.");
          imageProbe.block({ paintQuad: true, material });
          assert(countDifferentPixels(materialPixels, imageProbe.pixels()) === 0,
            "Material image mesh differs from its path reference.");
        }
        assert(imageProbe.imageMaterialWrites > 0 &&
          imageProbe.programs.filter((program) => program.family === "image").length === imageProgramsBeforeMaterial + (meshHasH ? 0 : 1) &&
          !imageProbe.programs.some((program) => hasDefine(program.source, "ENABLE_MODULATED_IMAGE")),
          "Material image meshes failed to reuse their lean program.");
        imageProbe.block({ quad: true });
        const writesAfterReset = imageProbe.imageMaterialWrites;
        imageProbe.block({ quad: true });
        assert(imageProbe.imageMaterialWrites === writesAfterReset &&
          countDifferentPixels(quadPixels, imageProbe.pixels()) === 0,
          "Plain image meshes retained material state or uploaded uniforms.");
        assert(imageProbe.violations.length === 0, imageProbe.violations.join("; "));
        report.passed.push("material image meshes and plain uniform reset");

        imageProbe.block(); const plainPixels = imageProbe.pixels();
        const hasH = (program) => hasDefine(program.source, "ENABLE_HSL_BLEND_MODES");
        const usedPaths = () => imageProbe.usedPrograms.filter((program) => hasDefine(program.source, "DRAW_PATH"));
        assert(usedPaths().length > 0 && usedPaths().every((program) => !hasH(program)),
          "A plain path used the material program.");
        imageProbe.block({ material: 1 });
        assert(usedPaths().some(hasH) && countDifferentPixels(plainPixels, imageProbe.pixels()) > 0,
          "Gold path did not use its material program.");
        imageProbe.block({ material: 2 });
        assert(usedPaths().some(hasH) && countDifferentPixels(plainPixels, imageProbe.pixels()) > 0,
          "Rainbow path did not use its material program.");
        imageProbe.block({ mixedMaterials: true });
        // Compatible plain/material paths share a batch whose features are ORed.
        assert(usedPaths().length > 0 && usedPaths().every(hasH),
          "Compatible plain and material paths did not share the material program.");
        imageProbe.block();
        assert(usedPaths().every((program) => !hasH(program)) &&
          countDifferentPixels(plainPixels, imageProbe.pixels()) === 0,
          "A plain path retained the material program.");
        imageProbe.destroy(); report.passed.push("opt-in material programs and mixed-path batching");

        for (const board of boards) board.delete();
        for (const file of files) file.unref();
        for (const cleanup of cleanups) cleanup();
        return report;
      }

      async function main() {
        const packageRoot = "/node_modules/@magiccircle/rive-webgl2-advanced/";
        const { default: createRive } = await import(packageRoot + "webgl2_advanced.mjs");
        const rive = await createRive({
          locateFile: () => packageRoot + ${JSON.stringify(wasmFilename)},
        });
        const canvas = document.querySelector("#canvas");
        const renderer = rive.makeRenderer(canvas);
        assert(renderer, "makeRenderer() returned no renderer.");
        const bindRendererContext = () => renderer.bindContext?.();
        for (const name of apiNames) {
          assert(typeof renderer[name] === "function", "Missing renderer API: " + name);
        }
        const enumValue = (value) => value?.value ?? value;
        assert(enumValue(rive.SurfaceMaterial.None) === 0, "None enum value changed.");
        assert(enumValue(rive.SurfaceMaterial.Inherit) === 3, "Inherit enum value changed.");
        assert(enumValue(rive.SurfaceMaterial.Rainbow) === 2, "Rainbow enum value changed.");
        assert(enumValue(rive.SurfaceMaterial.Gold) === 1, "Gold enum value changed.");

        const imageBindingFixtureBytes = new Uint8Array(
          await (await fetch("/image-binding-fixture.riv")).arrayBuffer(),
        );
        const imageBindingFile = await rive.load(imageBindingFixtureBytes);
        const imageBindingArtboard = imageBindingFile.artboardByName("main");
        const imageBindingViewModel =
          imageBindingFile.defaultArtboardViewModel(imageBindingArtboard);
        const imageBindingInstance = imageBindingViewModel.defaultInstance();
        const imageBinding = imageBindingInstance.image("main_im");
        assert(imageBinding, "The image binding fixture has no main_im property.");
        assert(
          typeof imageBinding.setSurfaceMaterial === "function",
          "Image bindings do not expose setSurfaceMaterial().",
        );
        imageBinding.setSurfaceMaterial(rive.SurfaceMaterial.None);
        imageBinding.setSurfaceMaterial(rive.SurfaceMaterial.Rainbow);
        imageBinding.setSurfaceMaterial(rive.SurfaceMaterial.Inherit);

        const gl = canvas.getContext("webgl2");
        assert(gl, "WebGL2 is unavailable in the test browser.");

        // Exercise decode fallbacks and deletion before any texture upload.
        const sourceCanvas = new OffscreenCanvas(32, 32);
        const sourceContext = sourceCanvas.getContext("2d");
        sourceContext.fillStyle = "#e0308080";
        sourceContext.fillRect(0, 0, 32, 32);
        const png = new Uint8Array(await (await sourceCanvas.convertToBlob()).arrayBuffer());
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
            const previous = new Set(rive.imageBitmaps?.values());
            const decoded = await new Promise((resolve) => rive.decodeImage(png, resolve));
            const pending = Array.from(rive.imageBitmaps?.values() ?? [])
              .filter((bitmap) => !previous.has(bitmap));
            assert(
              pending.length === (mode === "bitmap" ? 1 : 0),
              "Unexpected pending bitmap count: " + mode,
            );
            assert(pending.every((bitmap) => bitmap.width === 32), "Bitmap closed before use.");
            decoded.unref();
            assert(pending.every((bitmap) => bitmap.width === 0), "Deleting an unused image leaked its bitmap.");
            assert(
              pending.every((bitmap) => !Array.from(rive.imageBitmaps.values()).includes(bitmap)),
              "Deleted image retained its bitmap in the runtime.",
            );
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

        // The fork preserves upstream cross-context use even though Magic
        // Circle keeps its image lifetimes within one renderer generation.
        const previousBitmaps = new Set(rive.imageBitmaps.values());
        const previousElements = new Set(rive.images.values());
        const sharedImage = await new Promise((resolve) => rive.decodeImage(png, resolve));
        const sharedBitmap = Array.from(rive.imageBitmaps.values()).find((bitmap) => !previousBitmaps.has(bitmap));
        const sharedElement = Array.from(rive.images.values()).find((image) => !previousElements.has(image));
        assert(sharedBitmap && sharedElement, "Shared image did not retain both upload sources.");
        imageBinding.value(sharedImage);
        imageBindingArtboard.bindViewModelInstance(imageBindingInstance);
        imageBindingArtboard.advance(0);
        /** Captures an image and the actual upload sources in one context. */
        function drawBoundImage(targetRenderer, targetCanvas) {
          const targetGl = targetCanvas.getContext("webgl2");
          const uploadSources = [];
          const texImage2D = targetGl.texImage2D;
          targetGl.texImage2D = function(...args) {
            uploadSources.push(args.at(-1));
            return texImage2D.apply(this, args);
          };
          try {
            targetRenderer.bindContext();
            targetRenderer.clear();
            targetRenderer.save();
            targetRenderer.align(rive.Fit.contain, rive.Alignment.center,
              { minX: 0, minY: 0, maxX: targetCanvas.width, maxY: targetCanvas.height },
              imageBindingArtboard.bounds);
            imageBindingArtboard.draw(targetRenderer);
            targetRenderer.restore();
            targetRenderer.flush();
            return { uploadSources, pixels: readCanvasPixels(targetGl, targetCanvas.width, targetCanvas.height) };
          } finally {
            targetGl.texImage2D = texImage2D;
          }
        }
        const firstContext = drawBoundImage(renderer, canvas);
        const secondCanvas = document.createElement("canvas");
        secondCanvas.width = canvas.width;
        secondCanvas.height = canvas.height;
        const secondRenderer = rive.makeRenderer(secondCanvas);
        const secondContext = drawBoundImage(secondRenderer, secondCanvas);
        assert(firstContext.uploadSources.includes(sharedBitmap) && sharedBitmap.width === 0,
          "First context did not upload a bitmap.");
        assert(secondContext.uploadSources.includes(sharedElement),
          "Second context did not use the retained image element.");
        assert(countOpaquePixels(firstContext.pixels) > 0 &&
          countDifferentPixels(firstContext.pixels, secondContext.pixels) === 0,
          "Image pixels changed across GL contexts.");
        const deferredFlush = ${JSON.stringify(legacyComparison)} ? null : await testDeferredFlush(rive, png);
        sharedImage.unref();
        imageBindingInstance.delete();
        imageBindingArtboard.delete();
        imageBindingFile.unref();
        secondRenderer.delete();

        const fixtureBytes = new Uint8Array(await (await fetch("/fixture.riv")).arrayBuffer());
        const file = await rive.load(fixtureBytes);
        const artboard = ${JSON.stringify(artboardName)}
          ? file.artboardByName(${JSON.stringify(artboardName)})
          : file.defaultArtboard();
        artboard.advance(0);

        bindRendererContext();
        renderer.clear();
        renderer.save();
        renderer.align(
          rive.Fit.contain,
          rive.Alignment.center,
          { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height },
          artboard.bounds,
        );
        artboard.draw(renderer);
        renderer.restore();
        renderer.flush();
        const defaultOpaquePixels = countOpaquePixels(
          readCanvasPixels(gl, canvas.width, canvas.height),
        );
        assert(defaultOpaquePixels > 0, "The fixture rendered no visible canvas pixels.");

        const targetTexture = makeTexture(gl, canvas.width, canvas.height);
        renderer.setTargetTexture(targetTexture, canvas.width, canvas.height);

        const opaquePixels = {};
        const materialPixels = {};
        for (const [name, material, timeSeconds] of [
          ["normal", 0, 1.25],
          ["gold", 1, 1.25],
          ["goldStaticA", 1, -1],
          ["goldStaticB", 1, -2],
          ["rainbow", 2, 1.25],
          ["rainbowStaticA", 2, -1],
          ["rainbowStaticB", 2, -2],
        ]) {
          bindRendererContext();
          renderer.invalidateGLState();
          renderer.clear();
          renderer.save();
          renderer.align(
            rive.Fit.contain,
            rive.Alignment.center,
            { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height },
            artboard.bounds,
          );
          renderer.setSurfaceMaterial(
            material,
            0,
            0,
            canvas.width,
            canvas.height,
            timeSeconds,
          );
          artboard.draw(renderer);
          renderer.restore();
          renderer.flush();
          rive.resolveAnimationFrame();
          renderer.unbindGLInternalResources();
          bindRendererContext();
          materialPixels[name] = readTexturePixels(
            gl,
            targetTexture,
            canvas.width,
            canvas.height,
          );
          opaquePixels[name] = countOpaquePixels(materialPixels[name]);
          const glError = gl.getError();
          assert(
            opaquePixels[name] > 0,
            name + " rendered no visible pixels (WebGL error " + glError + ").",
          );
          assert(glError === gl.NO_ERROR, name + " left a WebGL error.");
        }

        const minimumChangedPixels = Math.max(
          16,
          Math.floor(opaquePixels.normal * 0.01),
        );
        const materialDifferences = {
          goldFromNormal: countDifferentPixels(
            materialPixels.gold,
            materialPixels.normal,
          ),
          rainbowFromNormal: countDifferentPixels(
            materialPixels.rainbow,
            materialPixels.normal,
          ),
          goldFromRainbow: countDifferentPixels(
            materialPixels.gold,
            materialPixels.rainbow,
          ),
        };
        for (const [comparison, changedPixels] of Object.entries(
          materialDifferences,
        )) {
          assert(
            changedPixels >= minimumChangedPixels,
            comparison + " changed only " + changedPixels + " pixels.",
          );
        }
        const staticMaterialDifferences = {
          gold: countDifferentPixels(
            materialPixels.goldStaticA,
            materialPixels.goldStaticB,
          ),
          rainbow: countDifferentPixels(
            materialPixels.rainbowStaticA,
            materialPixels.rainbowStaticB,
          ),
        };
        for (const [material, changedPixels] of Object.entries(
          staticMaterialDifferences,
        )) {
          assert(
            changedPixels === 0,
            material + " static rendering changed with negative time.",
          );
        }

        bindRendererContext();
        renderer.beginOverlayFrame();
        renderer.flush();
        renderer.unbindGLInternalResources();
        bindRendererContext();
        const preservedPixels = readTexturePixels(
          gl,
          targetTexture,
          canvas.width,
          canvas.height,
        );
        assert(
          countDifferentPixels(
            preservedPixels,
            materialPixels.rainbowStaticB,
          ) === 0,
          "beginOverlayFrame() did not preserve the external target.",
        );
        renderer.clearTargetTexture();

        const imageTexture = makeTexture(gl, 2, 2);
        const image = renderer.makeImageFromGLTexture(imageTexture, 2, 2);
        assert(image, "makeImageFromGLTexture() returned no image.");
        image.unref();

        const pixelHashes = {};
        for (const [name, pixels] of Object.entries(materialPixels)) {
          const digest = await crypto.subtle.digest("SHA-256", pixels);
          pixelHashes[name] = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        }

        artboard.delete();
        file.unref();
        renderer.delete();
        rive.cleanup?.();
        finish({
          ok: true,
          deferredFlush,
          defaultOpaquePixels,
          opaquePixels,
          materialDifferences,
          staticMaterialDifferences,
          pixelHashes,
        });
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
async function main(wasmFilename) {
  const browser = await findChrome();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "rive-webgl2-package-"));
  try {
    const packResult = await run(
      "npm",
      ["pack", packageDirectory, "--json", "--pack-destination", temporaryDirectory],
      { cwd: repositoryRoot },
    );
    if (packResult.status !== 0) {
      throw new Error(`npm pack failed:\n${packResult.stderr}`);
    }
    const packMetadata = JSON.parse(packResult.stdout);
    const tarballPath = join(temporaryDirectory, packMetadata[0].filename);
    await stat(tarballPath);
    await writeFile(
      join(temporaryDirectory, "package.json"),
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
      { cwd: temporaryDirectory },
    );
    if (installResult.status !== 0) {
      throw new Error(`Installing the packed artifact failed:\n${installResult.stderr}`);
    }
    await copyFile(fixturePath, join(temporaryDirectory, "fixture.riv"));
    await copyFile(
      imageBindingFixturePath,
      join(temporaryDirectory, "image-binding-fixture.riv"),
    );
    await copyFile(join(scriptDirectory, "webgl2_test_support.mjs"), join(temporaryDirectory, "webgl2_test_support.mjs"));
    await writeFile(join(temporaryDirectory, "index.html"), testPage(wasmFilename));

    const server = await startServer(temporaryDirectory);
    try {
      const browserResult = await run(browser, [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-webgl",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--use-angle=swiftshader",
        "--virtual-time-budget=30000",
        "--dump-dom",
        server.url,
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
          `Packed browser test failed: ${result.error}\n` +
            `${result.browserMessages?.join("\n") ?? ""}\n${browserResult.stderr}`,
        );
      }
      console.log("Packed WebGL2 browser test passed:", wasmFilename, result);
    } finally {
      await server.close();
    }
    if (process.env.RIVE_TEST_GAME_ROOT) {
      const installedPackage = join(temporaryDirectory, "node_modules/@magiccircle/rive-webgl2-advanced");
      await writeFile(join(installedPackage, "glsl.glsl.exports.h"), shaderExports);
      const contentResult = await run(process.execPath, [
        join(scriptDirectory, "compare_webgl2_pixels.mjs"), installedPackage, installedPackage,
        process.env.RIVE_TEST_GAME_ROOT, join(temporaryDirectory, "content-check"),
      ], { env: { ...process.env, RIVE_TEST_LINK_PROGRAMS: "1", RIVE_TEST_WASM: wasmFilename } });
      if (contentResult.status !== 0) {
        throw new Error(`Magic Garden eager-link check failed:\n${contentResult.stderr}\n${contentResult.stdout}`);
      }
      const content = JSON.parse(await readFile(join(temporaryDirectory, "content-check/pixel-comparison.json"), "utf8"));
      console.log("Magic Garden first-try program check passed:", wasmFilename,
        content.caseCount, "cases; KHR exposed:", content.programs.map((side) => side.parallel),
        "; no further draw-program links.");
    } else {
      console.log("Magic Garden eager-link check skipped: set RIVE_TEST_GAME_ROOT and PLAYWRIGHT_MODULE.");
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

for (const wasmFilename of process.env.RIVE_TEST_WASM
  ? [process.env.RIVE_TEST_WASM]
  : ["rive.wasm", "rive_fallback.wasm"]) {
  await main(wasmFilename);
}
