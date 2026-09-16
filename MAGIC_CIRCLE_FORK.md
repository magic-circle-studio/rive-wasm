# Magic Circle WebGL2 fork

This branch builds `@magiccircle/rive-webgl2-advanced`. It starts from the
official `rive-wasm` `2.42.2` tag (`dc4d3a12`) and the matching
`rive-runtime` `runtime-v0.1.411` tag (`30742b4c`). The package version is
`2.42.2-mc.1`. Both repositories replay the Magic Circle changes on these
upstream bases; the runtime submodule points to the Magic Circle mirror.

The fork adds:

- explicit WebGL context handoff APIs for sharing a canvas with PixiJS;
- rendering into a caller-owned immutable WebGL texture;
- wrapping a WebGL texture as a Rive image;
- deformation-aware animated/static Gold and static Rainbow materials;
- per-image material overrides and worker-safe OffscreenCanvas creation; and
- a generated JavaScript export of the same material shader source.

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
texture-backed images, and teardown. Set `CHROME_BIN` if Chrome is not on PATH.
Set `RIVE_TEST_FIXTURE` and `RIVE_TEST_ARTBOARD` to check a particular asset;
`RIVE_TEST_WASM` optionally restricts the binary under test.

## Pet loading benchmark

See [the September 16 results](benchmarks/pets-2026-09-16.md) for methodology,
raw measurements, validation, and the local build artifact. To repeat, unpack
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
