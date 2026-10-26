// Packs @magiccircle/rive-webgpu-advanced, installs the tarball into a
// temporary project and drives it with WebGPU in headless Chrome.
// Mirrors test_webgl2_package.mjs. Set RIVE_TEST_GPU=host for the physical GPU.
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const packageDirectory =
  process.env.RIVE_TEST_PACKAGE_DIR ??
  join(repositoryRoot, "js/npm/webgpu_advanced");
const fixturePath =
  process.env.RIVE_TEST_FIXTURE ??
  join(repositoryRoot, "js/test/assets/fallback_fonts_test.riv");
const imageBindingFixturePath = join(
  repositoryRoot,
  "wasm/submodules/rive-runtime/tests/unit_tests/assets/data_binding_images_test.riv",
);
const embeddedImageFixturePath = join(
  repositoryRoot,
  "wasm/submodules/rive-runtime/tests/unit_tests/assets/walle.riv",
);
const browserTimeoutMilliseconds = 120_000;
const hostGPU = process.env.RIVE_TEST_GPU === "host";
const artboardName = process.env.RIVE_TEST_ARTBOARD ?? null;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".riv", "application/octet-stream"],
  [".wasm", "application/wasm"],
]);

/** Finds a Chrome-compatible browser for the real-WebGPU package test. */
function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  }
  throw new Error("Chrome was not found. Set CHROME_BIN to its executable.");
}

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

/**
 * Serves the temporary packed-package fixture over HTTP and resolves `result`
 * with the page's POST to /result. WebGPU readbacks finish after the load
 * event, so the page reports back instead of relying on --dump-dom.
 */
async function startServer(rootDirectory) {
  let resolveResult;
  const result = new Promise((resolvePromise) => {
    resolveResult = resolvePromise;
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && url.pathname === "/result") {
        let body = "";
        request.setEncoding("utf8");
        for await (const chunk of request) body += chunk;
        response.writeHead(204).end();
        resolveResult(JSON.parse(body));
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
    result,
    url: `http://127.0.0.1:${address.port}`,
  };
}

/** Exercises the package's public API against real WebGPU devices. */
const testPage = String.raw`<!doctype html>
<html>
  <body>
    <pre id="result">pending</pre>
    <script type="module">
      const result = document.querySelector("#result");
      const browserMessages = [];
      for (const method of ["error", "warn"]) {
        const original = console[method];
        console[method] = (...values) => {
          browserMessages.push(values.map(String).join(" "));
          original.apply(console, values);
        };
      }
      const moduleApiNames = [
        "initWebGPU",
        "makeRenderer",
        "makeImageFromWebGPUTexture",
        "decodeImage",
        "load",
        "resolveAnimationFrame",
      ];
      const rendererApiNames = [
        "setTargetTexture",
        "clearTargetTexture",
        "clear",
        "beginOverlayFrame",
        "flush",
        "saveClipRect",
        "restoreClipRect",
        "setSurfaceMaterial",
        "align",
      ];
      const size = 256;
      const gpuErrors = [];

      let finished = false;
      function finish(payload) {
        if (finished) return;
        finished = true;
        result.textContent = JSON.stringify(payload);
        fetch("/result", { method: "POST", body: JSON.stringify(payload) });
      }

      function assert(condition, message) {
        if (!condition) throw new Error(message);
      }

      function throws(fn) {
        try {
          fn();
        } catch {
          return true;
        }
        return false;
      }

      async function requestDevice() {
        let adapter;
        // Vulkan initialization can briefly leave the host adapter unavailable.
        for (let attempt = 0; attempt < 20; attempt++) {
          adapter = await navigator.gpu?.requestAdapter();
          if (adapter) break;
          await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
        }
        assert(adapter, "WebGPU is unavailable in the test browser.");
        if (${JSON.stringify(hostGPU)}) {
          assert(adapter.info.isFallbackAdapter === false,
            "Host GPU mode requires a non-fallback adapter.");
          assert(!/swiftshader|llvmpipe|lavapipe|software/i.test(
            [adapter.info.vendor, adapter.info.architecture,
              adapter.info.device, adapter.info.description].join(" ")),
            "Host GPU mode rejected a software adapter.");
        }
        const device = await adapter.requestDevice();
        device.addEventListener("uncapturederror", (event) => {
          gpuErrors.push(event.error.message);
        });
        return { adapter, device };
      }

      function makeTarget(device) {
        return device.createTexture({
          size: [size, size],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        });
      }

      async function readPixels(device, texture) {
        const bytesPerRow = size * 4;
        const buffer = device.createBuffer({
          size: bytesPerRow * size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [size, size]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const pixels = new Uint8Array(buffer.getMappedRange()).slice();
        buffer.destroy();
        return pixels;
      }

      function countOpaquePixels(pixels, outside) {
        let opaquePixels = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          const pixel = (index - 3) / 4;
          const x = pixel % size;
          const y = Math.floor(pixel / size);
          if (outside && x >= outside[0] && x < outside[2] &&
              y >= outside[1] && y < outside[3]) {
            continue;
          }
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

      async function sha256(pixels) {
        const digest = await crypto.subtle.digest("SHA-256", pixels);
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      }

      async function main() {
        const packageRoot = "/node_modules/@magiccircle/rive-webgpu-advanced/";
        const { default: createRive } = await import(packageRoot + "webgpu_advanced.mjs");
        const rive = await createRive({
          locateFile: () => packageRoot + "rive.wasm",
        });
        for (const name of moduleApiNames) {
          assert(typeof rive[name] === "function", "Missing module API: " + name);
        }
        const enumValue = (value) => value?.value ?? value;
        assert(enumValue(rive.SurfaceMaterial.None) === 0, "None enum value changed.");
        assert(enumValue(rive.SurfaceMaterial.Inherit) === 3, "Inherit enum value changed.");
        assert(enumValue(rive.SurfaceMaterial.Rainbow) === 2, "Rainbow enum value changed.");
        assert(enumValue(rive.SurfaceMaterial.Gold) === 1, "Gold enum value changed.");
        assert(throws(() => rive.makeRenderer()), "makeRenderer() ran before initWebGPU().");

        let { adapter, device } = await requestDevice();
        const adapterInfo = Object.fromEntries(
          ["vendor", "architecture", "device", "description", "isFallbackAdapter"]
            .map((key) => [key, adapter.info[key]]),
        );
        assert(rive.initWebGPU(adapter, device), "initWebGPU() rejected the device.");
        let renderer = rive.makeRenderer();
        for (const name of rendererApiNames) {
          assert(typeof renderer[name] === "function", "Missing renderer API: " + name);
        }
        assert(throws(() => renderer.clear()), "clear() ran without a target texture.");

        // Hold real browser decodes until explicitly completed. walle.riv has
        // two embedded images; each pipeline must draw them on its first frame.
        const embeddedBytes = new Uint8Array(
          await (await fetch("/embedded-images.riv")).arrayBuffer(),
        );
        const originalDecodeImage = rive.decodeImage;
        const originalPtrToAsset = rive.ptrToAsset;
        const pendingDecodes = [];
        let attachments = 0;
        let releases = 0;
        rive.decodeImage = (bytes, complete) => pendingDecodes.push({ bytes, complete });
        rive.ptrToAsset = (address) => {
          const asset = originalPtrToAsset(address);
          if (asset.isImage) {
            const setRenderImage = asset.setRenderImage;
            asset.setRenderImage = function (image) {
              attachments++;
              setRenderImage.call(this, image);
            };
          }
          return asset;
        };
        async function completeDecode({ bytes, complete }, invalid = false) {
          const image = await new Promise((resolveDecode) =>
            originalDecodeImage(invalid ? new Uint8Array([1, 2, 3]) : bytes, resolveDecode));
          assert(Boolean(image) === !invalid, "Unexpected embedded decode result.");
          let imageReleases = 0;
          if (image) {
            const unref = image.unref;
            image.unref = function () {
              imageReleases++;
              releases++;
              unref.call(this);
            };
          }
          complete(image);
          assert(imageReleases === (image ? 1 : 0),
            "An embedded decode did not release its image exactly once.");
        }
        const embeddedTarget = makeTarget(device);
        const embeddedImageResults = {};
        function drawEmbedded(file, samples) {
          const artboard = file.defaultArtboard();
          artboard.advance(0);
          renderer.setTargetTexture(embeddedTarget);
          renderer.clear(0, samples);
          renderer.save();
          renderer.align(rive.Fit.contain, rive.Alignment.center,
            { minX: 0, minY: 0, maxX: size, maxY: size }, artboard.bounds);
          artboard.draw(renderer);
          renderer.restore();
          renderer.flush();
          artboard.delete();
          file.unref();
        }
        try {
          for (const samples of [0, 4]) {
            let resolved = false;
            const loading = rive.load(embeddedBytes).then((file) => {
              resolved = true;
              return file;
            });
            const decodes = pendingDecodes.splice(0);
            assert(decodes.length === 2, "Expected two embedded image decodes.");
            await Promise.resolve();
            assert(!resolved, "load() resolved before embedded images decoded.");

            if (samples === 0) {
              // An incomplete final varint fails import after image loading
              // started. It must return null without waiting or touching freed
              // assets, and must not abandon the concurrent successful load.
              const malformed = new Uint8Array([...embeddedBytes, 0x80]);
              let timer;
              const failed = await Promise.race([
                rive.load(malformed),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error(
                    "Null import waited for embedded decodes.")), 1000);
                }),
              ]).finally(() => clearTimeout(timer));
              assert(failed === null, "Malformed embedded import did not return null.");
              const abandoned = pendingDecodes.splice(0);
              assert(abandoned.length > 0, "Null import started no image decodes.");
              for (const decode of abandoned) await completeDecode(decode);
              assert(attachments === 0, "A late decode touched a freed asset.");
              assert(!resolved, "A concurrent load stopped waiting for its images.");
              embeddedImageResults.abandonedDecodes = abandoned.length;
            }

            await completeDecode(decodes[0]);
            await Promise.resolve();
            assert(!resolved, "load() did not wait for every embedded image.");
            await completeDecode(decodes[1]);
            // No extra advance, settling draw or browser task after load().
            drawEmbedded(await loading, samples);
            const firstFrame = await readPixels(device, embeddedTarget);

            // Failed browser decodes still resolve the file. Its image-free
            // pixels are a negative control for the first-frame image check.
            const withoutImages = rive.load(embeddedBytes);
            for (const decode of pendingDecodes.splice(0)) await completeDecode(decode, true);
            drawEmbedded(await withoutImages, samples);
            const missing = await readPixels(device, embeddedTarget);
            const imagePixels = countDifferentPixels(firstFrame, missing);
            assert(imagePixels > 100, "Embedded images were absent on the first frame.");
            embeddedImageResults[samples === 0 ? "atomics" : "msaa4"] = {
              imagePixels, firstFrameHash: await sha256(firstFrame),
            };
          }
          embeddedImageResults.attachments = attachments;
          embeddedImageResults.releases = releases;
        } finally {
          rive.decodeImage = originalDecodeImage;
          rive.ptrToAsset = originalPtrToAsset;
          renderer.clearTargetTexture();
          embeddedTarget.destroy();
        }

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
        imageBinding.setSurfaceMaterial(rive.SurfaceMaterial.None);
        imageBinding.setSurfaceMaterial(rive.SurfaceMaterial.Rainbow);
        imageBinding.setSurfaceMaterial(rive.SurfaceMaterial.Inherit);

        // A texture-backed image, and browser decoding of good and bad bytes.
        const imageTexture = device.createTexture({
          size: [2, 2],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const textureImage = rive.makeImageFromWebGPUTexture(imageTexture);
        assert(textureImage, "makeImageFromWebGPUTexture() returned no image.");
        imageBinding.value(textureImage);
        textureImage.unref();
        const pngCanvas = new OffscreenCanvas(size, size);
        const pngContext = pngCanvas.getContext("2d");
        pngContext.fillStyle = "#f80";
        pngContext.fillRect(0, 0, size, size);
        const pngBytes = new Uint8Array(
          await (await pngCanvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
        );
        const decode = (bytes) =>
          new Promise((resolveDecode) => rive.decodeImage(bytes, resolveDecode));
        const decoded = await decode(pngBytes);
        assert(decoded, "decodeImage() could not decode a PNG.");
        imageBinding.value(decoded);
        decoded.unref();
        assert((await decode(new Uint8Array([1, 2, 3]))) === null,
          "decodeImage() did not report undecodable bytes with null.");
        // Draw the bound image in both pipelines, including inherited and
        // explicit material overrides. Atomic image rects use instance data;
        // MSAA images use the path paint buffer instead.
        imageBindingArtboard.bindViewModelInstance(imageBindingInstance);
        imageBindingArtboard.advance(0);
        const imageTarget = makeTarget(device);
        renderer.setTargetTexture(imageTarget);
        const imageMaterialDifferences = {};
        const imagePixelHashes = {};
        for (const samples of [0, 4]) {
          const images = {};
          for (const [name, globalMaterial, imageMaterial] of [
            ["normal", 0, rive.SurfaceMaterial.Inherit],
            ["inheritedGold", 1, rive.SurfaceMaterial.Inherit],
            ["explicitNone", 1, rive.SurfaceMaterial.None],
            ["explicitGold", 1, rive.SurfaceMaterial.Gold],
            ["explicitRainbow", 0, rive.SurfaceMaterial.Rainbow],
          ]) {
            imageBinding.setSurfaceMaterial(enumValue(imageMaterial));
            imageBindingArtboard.advance(0);
            renderer.clear(0, samples);
            renderer.save();
            renderer.align(rive.Fit.contain, rive.Alignment.center,
              { minX: 0, minY: 0, maxX: size, maxY: size }, imageBindingArtboard.bounds);
            renderer.setSurfaceMaterial(globalMaterial, 0, 0, size, size, -1);
            imageBindingArtboard.draw(renderer);
            renderer.restore();
            renderer.flush();
            images[name] = await readPixels(device, imageTarget);
            assert(countOpaquePixels(images[name]) > 0, name + " image drew nothing.");
          }
          const differences = {
            inheritedGold: countDifferentPixels(images.normal, images.inheritedGold),
            explicitNoneFromGold: countDifferentPixels(images.inheritedGold, images.explicitNone),
            explicitGoldFromInherited: countDifferentPixels(images.inheritedGold, images.explicitGold),
            explicitRainbow: countDifferentPixels(images.normal, images.explicitRainbow),
          };
          assert(differences.inheritedGold > 16, "Inherited image Gold was missing.");
          assert(differences.explicitNoneFromGold > 16, "Explicit None did not remove image Gold: " + JSON.stringify(differences));
          assert(differences.explicitGoldFromInherited === 0, "Explicit Gold differs from inherited Gold.");
          assert(differences.explicitRainbow > 16, "Explicit image Rainbow was missing.");
          const mode = samples === 0 ? "atomics" : "msaa4";
          imageMaterialDifferences[mode] = differences;
          imagePixelHashes[mode] = {};
          for (const [name, pixels] of Object.entries(images)) {
            imagePixelHashes[mode][name] = await sha256(pixels);
          }
        }
        // More than 32 image views exercise cache eviction. Revisit old views
        // after eviction and compare one flush with separate overlay flushes.
        const distinctImages = Array.from({ length: 40 }, (_, index) => {
          const texture = device.createTexture({
            size: [1, 1], format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          device.queue.writeTexture({ texture },
            new Uint8Array([index * 6, 255 - index * 5, index * 3, 255]),
            { bytesPerRow: 4 }, [1, 1]);
          return { texture, image: rive.makeImageFromWebGPUTexture(texture) };
        });
        const imageSequence = [...distinctImages.keys(), 0, 39, 1];
        const evictionPixelHashes = {};
        imageBinding.setSurfaceMaterial(rive.SurfaceMaterial.None);
        function drawImageCell(imageIndex, cellIndex) {
          imageBinding.value(distinctImages[imageIndex].image);
          imageBindingArtboard.advance(0);
          const x = cellIndex % 8 * 32;
          const y = Math.floor(cellIndex / 8) * 32;
          renderer.save();
          renderer.align(rive.Fit.contain, rive.Alignment.center,
            { minX: x, minY: y, maxX: x + 32, maxY: y + 32 },
            imageBindingArtboard.bounds);
          imageBindingArtboard.draw(renderer);
          renderer.restore();
        }
        for (const samples of [0, 4]) {
          renderer.clear(0, samples);
          imageSequence.forEach(drawImageCell);
          renderer.flush();
          const combined = await readPixels(device, imageTarget);
          imageSequence.forEach((imageIndex, cellIndex) => {
            if (cellIndex === 0) renderer.clear(0, samples);
            else renderer.beginOverlayFrame(samples);
            drawImageCell(imageIndex, cellIndex);
            renderer.flush();
          });
          assert(countOpaquePixels(combined) > 0, "Image eviction atlas is empty.");
          assert(countDifferentPixels(combined, await readPixels(device, imageTarget)) === 0,
            "Image cache eviction changed pixels.");
          evictionPixelHashes[samples === 0 ? "atomics" : "msaa4"] = await sha256(combined);
        }
        for (const { texture, image } of distinctImages) {
          image.unref();
          texture.destroy();
        }
        renderer.clearTargetTexture();
        imageTarget.destroy();
        imageBindingInstance.delete();
        imageBindingArtboard.delete();
        imageBindingFile.unref();

        const fixtureBytes = new Uint8Array(await (await fetch("/fixture.riv")).arrayBuffer());
        let file = await rive.load(fixtureBytes);
        const pickArtboard = (riveFile) =>
          ${JSON.stringify(artboardName)}
            ? riveFile.artboardByName(${JSON.stringify(artboardName)})
            : riveFile.defaultArtboard();
        let artboard = pickArtboard(file);
        artboard.advance(0);
        let target = makeTarget(device);
        renderer.setTargetTexture(target);

        const fullFrame = { minX: 0, minY: 0, maxX: size, maxY: size };
        function drawInto(frame, clipRect) {
          if (clipRect) renderer.saveClipRect(...clipRect);
          else renderer.save();
          renderer.align(rive.Fit.contain, rive.Alignment.center, frame, artboard.bounds);
          artboard.draw(renderer);
          if (clipRect) renderer.restoreClipRect();
          else renderer.restore();
        }

        const opaquePixels = {};
        const materialPixels = {};
        for (const [name, material, timeSeconds, msaaSampleCount] of [
          ["normal", 0, 1.25, 0],
          ["normalMsaa4", 0, 1.25, 4],
          ["goldMsaa4", 1, 1.25, 4],
          ["rainbowMsaa4", 2, 1.25, 4],
          ["gold", 1, 1.25, 0],
          ["goldStaticA", 1, -1, 0],
          ["goldStaticB", 1, -2, 0],
          ["rainbow", 2, 1.25, 0],
          ["rainbowStaticA", 2, -1, 0],
          ["rainbowStaticB", 2, -2, 0],
        ]) {
          renderer.clear(0, msaaSampleCount);
          renderer.save();
          renderer.align(rive.Fit.contain, rive.Alignment.center, fullFrame, artboard.bounds);
          renderer.setSurfaceMaterial(material, 0, 0, size, size, timeSeconds);
          artboard.draw(renderer);
          renderer.restore();
          renderer.flush();
          rive.resolveAnimationFrame();
          materialPixels[name] = await readPixels(device, target);
          opaquePixels[name] = countOpaquePixels(materialPixels[name]);
          assert(opaquePixels[name] > 0, name + " rendered no visible pixels.");
        }

        const minimumChangedPixels = Math.max(16, Math.floor(opaquePixels.normal * 0.01));
        const materialDifferences = {
          goldMsaa4FromNormal: countDifferentPixels(materialPixels.goldMsaa4, materialPixels.normalMsaa4),
          rainbowMsaa4FromNormal: countDifferentPixels(materialPixels.rainbowMsaa4, materialPixels.normalMsaa4),
          goldFromNormal: countDifferentPixels(materialPixels.gold, materialPixels.normal),
          rainbowFromNormal: countDifferentPixels(materialPixels.rainbow, materialPixels.normal),
          goldFromRainbow: countDifferentPixels(materialPixels.gold, materialPixels.rainbow),
        };
        for (const [comparison, changedPixels] of Object.entries(materialDifferences)) {
          assert(
            changedPixels >= minimumChangedPixels,
            comparison + " changed only " + changedPixels + " pixels.",
          );
        }
        const staticMaterialDifferences = {
          gold: countDifferentPixels(materialPixels.goldStaticA, materialPixels.goldStaticB),
          rainbow: countDifferentPixels(
            materialPixels.rainbowStaticA,
            materialPixels.rainbowStaticB,
          ),
        };
        for (const [material, changedPixels] of Object.entries(staticMaterialDifferences)) {
          assert(changedPixels === 0, material + " static rendering changed with negative time.");
        }

        renderer.beginOverlayFrame();
        renderer.flush();
        assert(
          countDifferentPixels(await readPixels(device, target),
            materialPixels.rainbowStaticB) === 0,
          "beginOverlayFrame() did not preserve the target.",
        );

        // A clip rect cutting through the artwork keeps every pixel inside it.
        const clipRect = [64, 64, 192, 192];
        renderer.clear();
        drawInto(fullFrame, clipRect);
        renderer.flush();
        const clipped = await readPixels(device, target);
        const clipPixels = {
          inside: countOpaquePixels(clipped) - countOpaquePixels(clipped, clipRect),
          outside: countOpaquePixels(clipped, clipRect),
        };
        assert(clipPixels.inside > 0, "saveClipRect() drew nothing inside the clip.");
        assert(clipPixels.outside === 0, "saveClipRect() drew outside the clip.");

        // Eight frames flushed back to back (deeper than Rive's 3-deep upload
        // rings) must match the same cells drawn in a single frame.
        const cellSize = size / 4;
        const cells = Array.from({ length: 8 }, (_, index) => ({
          minX: (index % 4) * cellSize,
          minY: Math.floor(index / 4) * cellSize,
          maxX: (index % 4) * cellSize + cellSize,
          maxY: Math.floor(index / 4) * cellSize + cellSize,
        }));
        renderer.clear();
        cells.forEach((cell) => drawInto(cell));
        renderer.flush();
        const oneFlush = await readPixels(device, target);
        cells.forEach((cell, index) => {
          if (index === 0) renderer.clear();
          else renderer.beginOverlayFrame();
          drawInto(cell);
          renderer.flush();
        });
        const eightFlushes = await readPixels(device, target);
        const flushDifferences = countDifferentPixels(oneFlush, eightFlushes);
        assert(countOpaquePixels(oneFlush) > 0, "The atlas rendered no visible pixels.");
        assert(flushDifferences === 0,
          "Back-to-back flushes changed " + flushDifferences + " pixels.");

        // Device loss: re-init on a new device, reload, render identically.
        const normalHash = await sha256(materialPixels.normal);
        const lost = device.lost;
        device.destroy();
        assert((await lost).reason === "destroyed", "device.lost did not resolve.");
        ({ adapter, device } = await requestDevice());
        assert(rive.initWebGPU(adapter, device), "initWebGPU() rejected the new device.");
        target = makeTarget(device);
        assert(throws(() => renderer.setTargetTexture(target)),
          "A renderer from the lost device accepted a new target.");
        assert(throws(() => renderer.flush()),
          "A renderer from the lost device flushed.");
        renderer.delete();
        artboard.delete();
        file.unref();
        file = await rive.load(fixtureBytes);
        artboard = pickArtboard(file);
        artboard.advance(0);
        renderer = rive.makeRenderer();
        renderer.setTargetTexture(target);
        renderer.clear();
        renderer.save();
        renderer.align(rive.Fit.contain, rive.Alignment.center, fullFrame, artboard.bounds);
        renderer.setSurfaceMaterial(0, 0, 0, size, size, 1.25);
        artboard.draw(renderer);
        renderer.restore();
        renderer.flush();
        const reinitHash = await sha256(await readPixels(device, target));
        assert(reinitHash === normalHash, "Rendering changed after re-init.");

        const pixelHashes = {};
        for (const [name, pixels] of Object.entries(materialPixels)) {
          pixelHashes[name] = await sha256(pixels);
        }

        renderer.clearTargetTexture();
        renderer.delete();
        artboard.delete();
        file.unref();
        await device.queue.onSubmittedWorkDone();
        assert(gpuErrors.length === 0, "WebGPU errors: " + gpuErrors.join("; "));
        finish({
          ok: true,
          adapterInfo,
          embeddedImageResults,
          imageMaterialDifferences,
          imagePixelHashes,
          evictionPixelHashes,
          atlasHash: await sha256(oneFlush),
          clipHash: await sha256(clipped),
          opaquePixels,
          materialDifferences,
          staticMaterialDifferences,
          clipPixels,
          flushDifferences,
          reinitMatches: reinitHash === normalHash,
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
async function main() {
  const browser = findBrowser();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "rive-webgpu-package-"));
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
    await copyFile(embeddedImageFixturePath, join(temporaryDirectory, "embedded-images.riv"));
    await writeFile(join(temporaryDirectory, "index.html"), testPage);

    const server = await startServer(temporaryDirectory);
    const chrome = spawn(
      browser,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-unsafe-webgpu",
        ...(hostGPU ? [
          "--enable-gpu",
          "--use-gl=angle",
          "--use-angle=vulkan",
          "--enable-features=Vulkan,VulkanFromANGLE",
          "--disable-vulkan-surface",
          "--collect-dawn-info-eagerly",
        ] : [
          "--enable-features=Vulkan",
          "--use-vulkan=swiftshader",
          "--use-webgpu-adapter=swiftshader",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ]),
        `--user-data-dir=${join(temporaryDirectory, "chrome-profile")}`,
        server.url,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let chromeStderr = "";
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (chunk) => {
      chromeStderr += chunk;
    });
    const chromeExited = new Promise((resolvePromise) => {
      chrome.on("close", resolvePromise);
    });
    let timer;
    try {
      const result = await Promise.race([
        server.result,
        chromeExited.then((status) => {
          throw new Error(`Chrome exited (${status}) before reporting.\n${chromeStderr}`);
        }),
        new Promise((_, rejectPromise) => {
          timer = setTimeout(
            () => rejectPromise(new Error(`Chrome did not report.\n${chromeStderr}`)),
            browserTimeoutMilliseconds,
          );
        }),
      ]);
      if (!result.ok) {
        throw new Error(
          `Packed browser test failed: ${result.error}\n` +
            `${result.browserMessages?.join("\n") ?? ""}`,
        );
      }
      if (process.env.RIVE_TEST_RESULT) {
        await writeFile(process.env.RIVE_TEST_RESULT, JSON.stringify(result, null, 2) + "\n");
      }
      console.log("Packed WebGPU browser test passed:", result);
    } finally {
      clearTimeout(timer);
      chrome.kill();
      await chromeExited;
      await server.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
