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
  join(repositoryRoot, "js/npm/webgl2_advanced");
const fixturePath =
  process.env.RIVE_TEST_FIXTURE ??
  join(repositoryRoot, "js/test/assets/fallback_fonts_test.riv");
const resultMarker = "RIVE_PACKAGE_TEST_RESULT";
const legacyComparison = process.env.RIVE_TEST_LEGACY === "1";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".riv", "application/octet-stream"],
  [".wasm", "application/wasm"],
]);

/** Finds a Chrome-compatible browser for the real-WebGL package test. */
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

/** Serves the temporary packed-package fixture over HTTP. */
async function startServer(rootDirectory) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
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

const testPage = String.raw`<!doctype html>
<html>
  <body>
    <pre id="result">pending</pre>
    <canvas id="canvas" width="256" height="256"></canvas>
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
      const apiNames = [
        "beginOverlayFrame",
        "invalidateGLState",
        "unbindGLInternalResources",
        "setTargetTexture",
        "clearTargetTexture",
        "makeImageFromGLTexture",
        "setSurfaceMaterial",
      ];
      if (!${JSON.stringify(legacyComparison)}) apiNames.push("bindContext");

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

      async function main() {
        const packageRoot = "/node_modules/@magiccircle/rive-webgl2-advanced/";
        const { default: createRive } = await import(packageRoot + "webgl2_advanced.mjs");
        const rive = await createRive({
          locateFile: () => packageRoot + "rive.wasm",
        });
        const canvas = document.querySelector("#canvas");
        const renderer = rive.makeRenderer(canvas);
        assert(renderer, "makeRenderer() returned no renderer.");
        const bindRendererContext = () => renderer.bindContext?.();
        for (const name of apiNames) {
          assert(typeof renderer[name] === "function", "Missing renderer API: " + name);
        }
        const enumValue = (value) => value?.value ?? value;
        assert(enumValue(rive.SurfaceMaterial.gold) === 1, "Gold enum value changed.");
        assert(enumValue(rive.SurfaceMaterial.rainbow) === 2, "Rainbow enum value changed.");

        const gl = canvas.getContext("webgl2");
        assert(gl, "WebGL2 is unavailable in the test browser.");
        const fixtureBytes = new Uint8Array(await (await fetch("/fixture.riv")).arrayBuffer());
        const file = await rive.load(fixtureBytes);
        const artboard = file.defaultArtboard();
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

        artboard.delete();
        file.unref();
        renderer.delete();
        rive.cleanup?.();
        finish({
          ok: true,
          defaultOpaquePixels,
          opaquePixels,
          materialDifferences,
          staticMaterialDifferences,
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

async function main() {
  const browser = findBrowser();
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
    await writeFile(join(temporaryDirectory, "index.html"), testPage);

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
      const markerIndex = browserResult.stdout.indexOf(resultMarker);
      if (browserResult.status !== 0 || markerIndex < 0) {
        throw new Error(
          `Chrome did not complete the package test.\n${browserResult.stderr}\n${browserResult.stdout}`,
        );
      }
      const resultStart = markerIndex + resultMarker.length;
      const resultEnd = browserResult.stdout.indexOf("</pre>", resultStart);
      const result = JSON.parse(browserResult.stdout.slice(resultStart, resultEnd));
      if (!result.ok) {
        throw new Error(
          `Packed browser test failed: ${result.error}\n` +
            `${result.browserMessages?.join("\n") ?? ""}\n${browserResult.stderr}`,
        );
      }
      console.log("Packed WebGL2 browser test passed.", result);
    } finally {
      await server.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
