# Magic Circle WebGL2 fork

This branch builds `@magiccircle/rive-webgl2-advanced`. It starts from the
official `rive-wasm` `2.42.2` tag (`dc4d3a12`) and the matching
`rive-runtime` `runtime-v0.1.411` tag (`30742b4c`). The package version is
`2.42.2-mc.6`. Both repositories replay the Magic Circle changes on these
upstream bases; the runtime submodule points to the Magic Circle mirror.

The fork adds:

- explicit WebGL context handoff APIs for sharing a canvas with PixiJS;
- rendering into a caller-owned immutable WebGL texture;
- wrapping a WebGL texture as a Rive image;
- deformation-aware animated/static Gold and static Rainbow materials;
- per-image material overrides and worker-safe OffscreenCanvas creation;
- a generated JavaScript export of the same material shader source;
- asynchronous ImageBitmap decoding before the first image upload, with
  premultiplied alpha, bitmap cleanup, and an HTMLImageElement fallback for
  later contexts or browsers that cannot decode a bitmap;
- `tryFlush()` consumes a recorded frame and draws only when every required
  shader is linked; a pending frame leaves its target untouched. Overlay
  `clearRect()` clears recorded atlas regions only when the frame draws.
  `flush()` remains blocking and honors the same rectangles; and
- an ubershader-only WebGL2 renderer, cached image quads in depth-stencil mode,
  and per-draw opt-in path material/HSL and image-paint features. Plain and
  material paths use separate batches. Image meshes switch materials through
  fragment uniforms without adding vertex data; plain meshes upload no material
  uniforms except a mode reset after a materialized mesh.

`2.42.2-mc.2` introduced bitmap uploads. `2.42.2-mc.3` waits for browser
decoding before invoking `decodeImage`'s callback, reports invalid images as
`null`, and releases Blob URLs and native decode references on failure.
`2.42.2-mc.4–mc.6` add deferred shader-ready flushes, atomic overlay clears,
image-mesh materials and lean ubershaders.
The image-element fallback preserves the upstream runtime's multi-context
contract; Magic Circle's current renderer sessions do not share images
across contexts.

## Build

Initialize the source tree, then build only the package Magic Circle ships:

```sh
git submodule update --init --recursive
cd wasm
./build_all_wasm.sh -r webgl2
```

`get_emcc.sh` installs the pinned Emscripten `4.0.23` toolchain when needed,
and `build_wasm.sh` downloads the pinned Premake `5.0.0-beta7` executable.
On Nix systems whose shell exports host compiler variables, use:

```sh
env -u CC -u CXX -u AR -u LD \
  nix shell nixpkgs#python3 nixpkgs#gnumake \
  -c bash ./build_all_wasm.sh -r webgl2
```

The output is staged in `js/npm/webgl2_advanced`. Build artifacts are ignored;
the C++ runtime, bindings, type declarations, and shader exporter are the
sources of truth.

The WebGL2 target builds both SIMD and scalar fallback binaries in separate
directories. The release linker includes Emscripten's `exports.js` library to
keep import/export names stable across these binaries while retaining `-Os`
optimization. Without it, Emscripten 4.0.23 can assign incompatible minified
names to the two binaries, breaking the shared JavaScript loader.

## Validate the publishable artifact

From the repository root, run:

```sh
npm --prefix js run test:webgl2-package
```

The test creates an npm tarball, installs that exact tarball into a temporary
project, starts a local server, and drives real WebGL2 in headless Chrome. It
checks both WASM variants with the same JS loader: public fork APIs,
normal/Gold/Rainbow rendering, external render targets, overlay preservation,
texture-backed images, decode readiness and failures, Blob URL and bitmap
cleanup, matching image uploads across two GL contexts, and teardown. It also
checks pending-frame preservation, completion-only polling, mixed shader
families, lazy feather programs, overlay clear orientation, extension fallback,
material program selection, mesh uniform resets, and modulated image opacity.
Set `CHROME_BIN` if Chrome is not on PATH.
Set `RIVE_TEST_FIXTURE` and `RIVE_TEST_ARTBOARD` to check a particular asset;
`RIVE_TEST_WASM` optionally restricts the binary under test.

`wasm/scripts/compare_webgl2_pixels.mjs` compares two staged packages with
ubershader rendering, using host-GPU ANGLE GL. It samples all 32 pets
with hats and ties in plain, Gold, and Rainbow, splash files, avatar cosmetics,
and Gold/Rainbow pets at frames 0, 30, 60, and 90. The output includes per-case
pixel differences, asset/package hashes, and every linked draw program's defines.
Save the baseline's generated `glsl.glsl.exports.h` beside its package before
rebuilding (from `wasm/build/webgl2_advanced/bin/release/include/generated/shaders/`).
Set `PLAYWRIGHT_MODULE` to an installed Playwright module and `CHROME_BIN`
to a host Chrome if needed, then run:

```sh
node wasm/scripts/compare_webgl2_pixels.mjs \
  /path/to/baseline-package js/npm/webgl2_advanced /path/to/magiccircle.gg /path/to/results
```

Synthetic authored meshes use the same mesh in both builds; an mc.4 baseline
uses its equivalent image-painted path because it does not materialize meshes.
The mc.5 results are retained in `benchmarks/lean-ubershaders-pixels.json`, and
the mc.6 comparison against mc.5 is in `benchmarks/optin-material-pixels.json`.

## Pet loading benchmark

Raw measurements and asset/package hashes are retained in `benchmarks/`;
the upgrade PR records the findings and validation limits. To repeat, unpack
the published baseline package into a directory, then run this command from a
Magic Circle Nix development shell (which supplies Playwright's browser):

```sh
node /path/to/rive-wasm/wasm/scripts/benchmark_pets.mjs \
  /path/to/magiccircle.gg /path/to/unpacked-baseline \
  /path/to/rive-wasm/js/npm/webgl2_advanced /path/to/results.json
```

This compares CPU import and repeated pet instantiation with prefetched bytes;
it does not measure network loading, rendering throughput, or mobile devices.

Before publishing, push the runtime mirror commit first and the parent
`rive-wasm` commit second. Publish the package manually with the `mc` npm tag;
do not use the upstream release workflow.
