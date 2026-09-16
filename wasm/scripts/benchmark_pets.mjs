import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, platform, release } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const [appRootArg, baselineArg, candidateArg, outputArg] =
  process.argv.slice(2);
if (!appRootArg || !baselineArg || !candidateArg || !outputArg) {
  throw new Error(
    "Usage: benchmark_pets.mjs APP_ROOT BASELINE_DIR CANDIDATE_DIR OUTPUT_JSON",
  );
}
const appRoot = resolve(appRootArg);
const packages = {
  baseline: resolve(baselineArg),
  candidate: resolve(candidateArg),
};
const fixture = await readFile(
  join(appRoot, "client/raw-assets/rive/pets.riv"),
);
const require = createRequire(join(appRoot, "package.json"));
const { chromium } = require("playwright");
const rounds = 20;
const warmupRounds = 4;
const petCount = 32;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.end("<!doctype html><title>Rive pet CPU benchmark</title>");
      return;
    }
    if (url.pathname === "/pets.riv") {
      response.end(fixture);
      return;
    }
    const [, variant, ...parts] = url.pathname.split("/");
    const root = packages[variant];
    if (!root) throw new Error("Unknown package");
    const path = resolve(root, parts.join("/"));
    if (!path.startsWith(root + sep)) throw new Error("Invalid path");
    response.setHeader(
      "Content-Type",
      extname(path) === ".wasm" ? "application/wasm" : "text/javascript",
    );
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
  ],
});
const samples = [];
try {
  for (let round = -warmupRounds; round < rounds; round++) {
    const order =
      round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const variant of order) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(url);
        const sample = await page.evaluate(
          async ({ variant, petCount }) => {
            const { default: Rive } = await import(
              `/${variant}/webgl2_advanced.mjs`
            );
            const [wasmBinary, bytes] = await Promise.all([
              fetch(`/${variant}/rive.wasm`).then((r) => r.arrayBuffer()),
              fetch("/pets.riv")
                .then((r) => r.arrayBuffer())
                .then((b) => new Uint8Array(b)),
            ]);
            const rive = await Rive({
              wasmBinary,
              locateFile: () => `/${variant}/rive.wasm`,
            });
            const startMs = performance.now();
            const file = await rive.load(bytes, undefined, false);
            const importMs = performance.now() - startMs;
            if (!file) throw new Error("Pet file failed to load");
            // Discover pet artboards outside the hydration timer. Discovery also
            // warms their source recipes, matching repeated in-game instancing.
            const names = [];
            for (let i = 0; i < file.artboardCount(); i++) {
              const artboard = file.artboardByIndex(i);
              if (artboard.stateMachineByName("Pet State Machine"))
                names.push(artboard.name);
              artboard.delete();
            }
            if (names.length < 4)
              throw new Error("Expected multiple pet artboards");
            const instances = [];
            const hydrationStartMs = performance.now();
            for (let i = 0; i < petCount; i++) {
              const artboard = file.artboardByName(names[i % names.length]);
              const viewModel = file.defaultArtboardViewModel(artboard);
              if (!viewModel)
                throw new Error(`No pet view model: ${artboard.name}`);
              const instance = viewModel.instance();
              artboard.bindViewModelInstance(instance);
              const machine = new rive.StateMachineInstance(
                artboard.stateMachineByName("Pet State Machine"),
                artboard,
              );
              machine.bindViewModelInstance(instance);
              machine.advance(0);
              artboard.advance(0);
              instances.push({ artboard, instance, machine });
            }
            const hydrationMs = performance.now() - hydrationStartMs;
            // Keep the entire batch alive until the timer stops, as in a scene.
            for (const { artboard, instance, machine } of instances) {
              machine.delete();
              artboard.delete();
              instance.delete();
            }
            file.unref();
            return { importMs, hydrationMs, petCount, names };
          },
          { variant, petCount },
        );
        if (round >= 0) samples.push({ round, variant, ...sample });
        console.log(
          JSON.stringify({
            round,
            variant,
            importMs: sample.importMs,
            hydrationMs: sample.hydrationMs,
          }),
        );
      } finally {
        await context.close();
      }
    }
  }
  const metadata = {};
  for (const [variant, directory] of Object.entries(packages)) {
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const wasm = await readFile(join(directory, "rive.wasm"));
    metadata[variant] = {
      version: manifest.version,
      wasmSha256: createHash("sha256").update(wasm).digest("hex"),
    };
  }
  const summary = {};
  for (const variant of Object.keys(packages)) {
    summary[variant] = {};
    for (const metric of ["importMs", "hydrationMs"]) {
      const sorted = samples
        .filter((s) => s.variant === variant)
        .map((s) => s[metric])
        .sort((a, b) => a - b);
      summary[variant][metric] = {
        median: (sorted[9] + sorted[10]) / 2,
        p95: sorted[18],
        min: sorted[0],
        max: sorted.at(-1),
      };
    }
  }
  const result = {
    date: new Date().toISOString(),
    browser: browser.version(),
    cpu: cpus()[0].model,
    platform: `${platform()} ${release()}`,
    rounds,
    warmupRounds,
    petCount,
    method:
      "Fresh browser contexts; alternating order; prefetched bytes; CPU-only import and warm-source hydration including view-model/state-machine binding and advance(0); no rendering or network timings.",
    fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
    packages: metadata,
    summary,
    samples,
  };
  await writeFile(resolve(outputArg), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
