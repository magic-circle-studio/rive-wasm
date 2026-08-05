# Magic Circle WebGL2 fork

This branch builds `@magiccircle/rive-webgl2-advanced`. It starts from the
official `rive-wasm` `2.39.2` tag (`68dbf3a7`) and the matching
`rive-runtime` `runtime-v0.1.247` tag (`77804e86`). The runtime submodule uses
the Magic Circle mirror so the fork's pinned runtime commit remains fetchable.

The fork adds:

- explicit WebGL context handoff APIs for sharing a canvas with PixiJS;
- rendering into a caller-owned immutable WebGL texture;
- wrapping a WebGL texture as a Rive image;
- deformation-aware Gold and Rainbow vector materials; and
- a generated JavaScript export of the same material shader source.

## Build

Initialize the source tree, then build only the package Magic Circle ships:

```sh
git submodule update --init --recursive
cd wasm
./build_all_wasm.sh -r webgl2
```

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

## Validate the publishable artifact

From the repository root, run:

```sh
npm --prefix js run test:webgl2-package
```

The test creates an npm tarball, installs that exact tarball into a temporary
project, starts a local server, and drives real WebGL2 in headless Chrome. It
checks the public fork APIs, normal/Gold/Rainbow rendering, external render
targets, overlay preservation, texture-backed images, and teardown.

Before publishing, push the runtime mirror commit first and the parent
`rive-wasm` commit second. Publish the package manually with the `mc` npm tag;
do not use the upstream release workflow.
