# Magic Circle WebGL2 fork

This branch builds `@magiccircle/rive-webgl2-advanced`. It starts from
`rive-wasm` master at `06e5d34c` (the `2.54.0` tag plus two commits) and the
`rive-runtime` commit that master pins, `5b2e10d0`. Both repositories carry
the Magic Circle changes as one commit per area on these bases; the runtime
submodule points to the Magic Circle mirror. The previous fork, `2.42.2-mc.8`,
defines the API and behavior this one keeps.

The fork adds only what Magic Garden calls:

- **A WebGL context shared with PixiJS:** `bindContext`, `invalidateGLState`,
  `unbindGLInternalResources`, and `beginOverlayFrame`, which draws over the
  target's existing pixels. `makeRenderer` skips upstream's offscreen-context
  probe unless an offscreen renderer is requested: the probe only chooses
  antialiasing for a canvas that has no context yet, and costs an extra
  context and its program links.
- **Caller-owned textures:** `setTargetTexture` / `clearTargetTexture` render
  into a WebGL texture, and `makeImageFromGLTexture` wraps one as a Rive
  image. A texture target never inkbleeds; it draws with pixel local storage
  where available and with 4x MSAA otherwise.
- **Gold and Rainbow surface materials** on vector paths, selected with the
  renderer's `setSurfaceMaterial`. Each path keeps the mapping it had when
  first drawn, so the material follows animated parts. Raster images draw
  plain. Materials reuse the HSL blend-mode shader feature on WebGL, and each
  path record carries two more uint32x4s for the material's matrix, mode and
  time. `surface_material_shader.mjs` exports the same shader source for the
  game's own renderer.
- **Image decoding:** images decode into a premultiplied `ImageBitmap` before
  their first upload, and the bitmap is closed after upload or deletion. An
  `HTMLImageElement` remains for other contexts and decode fallbacks.
  `decodeImage` calls back only once the browser has decoded the pixels, or
  with `null` on failure.
- **A lean renderer:** ubershaders only. Rive draws with pixel local storage
  where the context exposes `WEBGL_shader_pixel_local_storage` (Chrome turns
  it on by default from M158), and in depth-stencil (MSAA) mode elsewhere.
  Depth-stencil programs leave clip rects, modulated images, HSL blend modes
  (and so materials) and angular gradients out unless a draw requests them,
  and images draw as cached image quads, sharing the image-mesh programs.
- **Pipeline warm-ups:** `linkDrawPrograms()` starts linking every program
  the warm-ups draw, in the background with `KHR_parallel_shader_compile`.
  `drawPipelineWarmup()` draws the next warm-up into the target, alone in its
  own frame, and returns how many are left. Each warm-up is one paint the art
  uses (opaque, translucent, screen blend, gradient or image mesh), plain or
  Gold, under a clip rect, plus clip paths and a clip reset, a fill large
  enough to draw its interior as triangles, a clockwise fill, and strokes
  (opaque, Gold and translucent), which depth-stencil frames now draw with
  their own programs. On Safari a
  program's first draw in each GPU state builds a pipeline, so drawing these
  before the art builds them all. A warm-up whose programs are still linking
  draws nothing and stays next. The runtime supports this with
  `RenderContext::flush(resources, PendingPrograms)`, and the blit-as-draw
  program that overlay frames use links in the background like the others.
  Upstream's own `tryStartAsyncUbershaderCreation` queues every permutation
  and is left unused. The game's `pipelineWarmup.webgl.test.ts` checks
  shipped art against the warm-ups.

Upstream defaults stay as upstream ships them: deferred decoding and inkbleed
(with its new shrinkbleed inset) are off unless a caller asks.

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

The output is staged in `js/npm/webgl2_advanced`.

The WebGL2 target builds both SIMD and scalar fallback binaries, and
`verify_fallback_abi.py` checks that they share one JavaScript loader. Like
mc.8, the WebGL2 flavors build the Luau scripting VM only: upstream's `-w`
(wasm script modules) is left out.

## Validate the publishable artifact

From the repository root, run:

```sh
npm --prefix js run test:webgl2-package
```

The test packs the package, installs that tarball into a temporary project and
drives WebGL2 in headless Chrome, with both WASM variants behind the same JS
loader. It covers the APIs above. Chrome runs on SwiftShader through ANGLE
with Vulkan disabled, and the test stands in for
`KHR_parallel_shader_compile`, which that configuration lacks. Set
`CHROME_BIN` if Chrome is not on PATH.

## Publish

Push the runtime mirror commit first and the parent `rive-wasm` commit second.
Publish the package by hand with `npm publish --tag mc`. Don't use
`js/package.json`'s release scripts: they bump the version themselves.
