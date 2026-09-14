# Magic Circle WebGL2 fork

This branch builds `@magiccircle/rive-webgl2-advanced`. It starts from the
official `rive-wasm` `2.39.2` tag (`68dbf3a7`) and the matching
`rive-runtime` `runtime-v0.1.247` tag (`77804e86`). The runtime submodule uses
the Magic Circle mirror so the fork's pinned runtime commit remains fetchable.

The fork adds:

- explicit WebGL context handoff APIs for sharing a canvas with PixiJS;
- rendering into a caller-owned immutable WebGL texture;
- wrapping a WebGL texture as a Rive image;
- deformation-aware animated Gold and static Rainbow vector materials; and
- a generated JavaScript export of the same material shader source.

## Build

Initialize the source tree, then build only the package Magic Circle ships:

```sh
git submodule update --init --recursive
cd wasm
./build_all_wasm.sh -r webgl2
```

This builds both `rive.wasm` (SIMD) and `rive_fallback.wasm` (without WASM
SIMD). The fallback uses upstream's `build_wasm.sh -c` compatibility option.
Keep its object directory separate from the SIMD build: make does not notice
compiler-flag changes, so reusing objects can silently mix the two variants.
`-r webgl2` includes both builds in this fork; upstream's single-target mode
skips fallbacks. `-i -r webgl2` rebuilds both incrementally.

`get_emcc.sh` installs the pinned Emscripten `3.1.61` toolchain when needed,
and `build_wasm.sh` downloads the pinned Premake `5.0.0-beta7` executable.
On Nix systems whose shell exports host compiler variables, use:

```sh
env -u CC -u CXX -u AR -u LD \
  nix shell nixpkgs#python3 -c bash ./build_all_wasm.sh -r webgl2
```

The output is staged in `js/npm/webgl2_advanced`. Build artifacts are ignored;
the C++ runtime, bindings, type declarations, and shader exporter are the
sources of truth.

## Runtime selection

The package's low-level factory does not use upstream's high-level
`RuntimeLoader`, so it does not automatically fetch a fallback. Consumers
must choose a binary before initializing the factory. Probe support with
`WebAssembly.validate` on a small SIMD module, then fetch `rive.wasm` when
supported or `rive_fallback.wasm` otherwise. Use the same selection for any
preload hint so the browser downloads only the selected file.

Both binaries use `webgl2_advanced.mjs` and expose the same fork APIs. Build
and ship them together from the same source and version; an upstream binary
cannot supply this fork's context-sharing or material extensions. An
application can also use the compatibility binary on every device, at the
cost of the SIMD optimization.

## Validate the publishable artifact

From the repository root, run:

```sh
npm --prefix js run test:webgl2-package
```

Run this test with an x86-64 Chrome/Chromium (`CHROME_BIN` can select it).
The test creates an npm tarball, installs that exact tarball into a temporary
project, starts a local server, and drives real WebGL2 in headless Chrome. It
checks the public fork APIs, normal/Gold/Rainbow rendering, external render
targets, overlay preservation, texture-backed images, and teardown for both
binaries through the same JavaScript factory. The compatibility run disables
SSE4.1 in V8 and requires the SIMD binary to fail validation while the
compatibility binary validates and renders. This catches missing packaged
fallbacks and accidental reuse of SIMD objects. SwiftShader checks correctness;
it does not measure performance on an affected player's GPU or CPU.

## Publishing

Increment the package's `2.39.2-mc.<n>` version before building a release.
After the package test passes, create the archive that will be published:

```sh
mkdir -p dist
npm pack ./js/npm/webgl2_advanced --pack-destination ./dist
RIVE_TEST_PACKAGE_TARBALL="$PWD/dist/magiccircle-rive-webgl2-advanced-<version>.tgz" \
  npm --prefix js run test:webgl2-package
```

The operator publishes that exact tested archive with
`npm publish ./dist/magiccircle-rive-webgl2-advanced-<version>.tgz --tag mc`.
Publishing an archive preserves the integrity used by consumers preparing
their lockfile before publication. Always include both WASM files.

Before publishing, push the runtime mirror commit first and the parent
`rive-wasm` commit second. Publish the package manually with the `mc` npm tag;
do not use the upstream release workflow.
