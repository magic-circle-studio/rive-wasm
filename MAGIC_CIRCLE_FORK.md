# Magic Circle WebGL2 fork

This branch builds `@magiccircle/rive-webgl2-advanced`. It starts from the
official `rive-wasm` `2.44.2` tag (`85009a8b`) and its matching
`rive-runtime` submodule commit (`2a043c31`). The package version is
`2.44.2-mc.1`. Both repositories replay the Magic Circle changes on these
upstream bases; the runtime submodule points to the Magic Circle mirror.

The fork adds:

- explicit WebGL context handoff APIs for sharing a canvas with PixiJS;
- rendering into a caller-owned immutable WebGL texture;
- wrapping a WebGL texture as a Rive image;
- deformation-aware animated/static Gold and static Rainbow materials;
- per-image material overrides and worker-safe OffscreenCanvas creation;
- a generated JavaScript export of the same material shader source; and
- asynchronous ImageBitmap decoding before the first image upload, with
  premultiplied alpha, bitmap cleanup, and an HTMLImageElement fallback for
  later contexts or browsers that cannot decode a bitmap.

`2.42.2-mc.2` introduced bitmap uploads. `2.42.2-mc.3` waits for browser
decoding before invoking `decodeImage`'s callback, reports invalid images as
`null`, and releases Blob URLs and native decode references on failure.
The image-element fallback preserves the upstream runtime's multi-context
contract; Magic Circle's current renderer sessions do not share images
across contexts.

`2.44.2-mc.1` retains the per-flush CPU optimizations developed for the
unpublished `2.42.2-mc.4` build. On the WebGL2 MSAA (depthStencil) path, the
GL state cache skips redundant stencil and base-instance calls, dynamic
batches set pipeline state only for their actual passes, and consecutive
batches reuse matching program lookups. Scale/translation-only draws map
cached path bounds; rotated, skewed and empty paths keep point-wise mapping.
Upstream 2.44.2 already avoids measuring bounds for paints without images.
The rebase carries material rendering into upstream's new MSAA fill/stroke
shader, preserves coordinates on generated outside-stroke paths, and excludes
luminance masks from material tinting.

The original ~21% flush-CPU improvement was measured against 2.42.2-mc.3 on
one desktop GPU, before the game adopted partial atlas redraws. It is not a
performance claim for this upstream rebase.

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
  nix shell nixpkgs#python3 nixpkgs#gnumake nixpkgs#nodejs \
  -c bash ./build_all_wasm.sh -r webgl2
```

The output is staged in `js/npm/webgl2_advanced`. Build artifacts are ignored;
the C++ runtime, bindings, type declarations, and shader exporter are the
sources of truth.

The WebGL2 target builds both SIMD and scalar fallback binaries in separate
directories. The release linker includes Emscripten's `exports.js` library to
keep import/export names stable across these binaries while retaining the
upstream release optimizations. The upstream build also verifies their ABI.
Without stable names, Emscripten 4.0.23 can assign incompatible minified
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
cleanup, matching image uploads across two GL contexts, stencil-state
restoration after external GL changes, shader exports, and teardown.
Set `CHROME_BIN` if Chrome is not on PATH.
Set `RIVE_TEST_FIXTURE` and `RIVE_TEST_ARTBOARD` to check a particular asset;
`RIVE_TEST_WASM` optionally restricts the binary under test.

The runtime's `[RiveRenderer]` native tests cover cached path bounds,
material coordinates across outside-stroke poses, and luminance masks:

```sh
cd wasm/submodules/rive-runtime/tests/unit_tests
./test.sh --match '[RiveRenderer]'
```

The full upstream native test build also expects its sibling native-tool
sources, including `texture_compressor`, which this standalone checkout
does not contain.

Local validation of `2.44.2-mc.1` passed both packed WASM variants, all 20
renderer tests linked separately from the full native suite, and Magic
Circle's 21 Rive WebGL tests plus its client typecheck. The game's containment
test allows one RGB level of rounding only within the redrawn neighboring
sprite; the same three pixel differences reproduced with these optimizations
removed. Alpha and pixels outside both atlas slots remain exact.

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
