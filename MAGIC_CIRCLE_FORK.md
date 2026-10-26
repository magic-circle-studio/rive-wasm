# Magic Circle Rive fork

This branch builds `@magiccircle/rive-webgl2-advanced` and
`@magiccircle/rive-webgpu-advanced`. It starts from the
official `rive-wasm` `2.44.2` tag (`85009a8b`) and its matching
`rive-runtime` submodule commit (`2a043c31`). The package version is
`2.44.2-mc.3` for both packages. Both repositories replay the Magic Circle
changes on these upstream bases; the runtime submodule points to the Magic
Circle mirror.

The fork adds:

- explicit WebGL context handoff APIs for sharing a canvas with PixiJS;
- rendering into a caller-owned immutable WebGL texture;
- wrapping a WebGL texture as a Rive image;
- deformation-aware animated/static Gold and static Rainbow materials;
- per-image material overrides and worker-safe OffscreenCanvas creation;
- a generated JavaScript export of the same material shader source; and
- asynchronous ImageBitmap decoding before the first image upload, with
  premultiplied alpha, bitmap cleanup, and an HTMLImageElement fallback for
  later contexts or browsers that cannot decode a bitmap; and
- a WebGPU flavour that renders into caller-owned `GPUTexture`s on the host's
  `GPUDevice` (see [WebGPU package](#webgpu-package)).

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

`2.44.2-mc.2` preserves additive paints' authored colors when a material is active.
Their RGB is premultiplied by the original paint opacity, but upstream reduces
only their blend alpha. Applying a material using that reduced alpha would erase
fully additive paints and distort partially additive ones.

`2.44.2-mc.3` rounds interpolated material modes before comparison, fixing
pixels that could miss their Gold or Rainbow tint. It also adds the WebGPU
advanced package; both backends share the version and runtime commit.

The original ~21% flush-CPU improvement was measured against 2.42.2-mc.3 on
one desktop GPU, before the game adopted partial atlas redraws. The 2.44.2
comparison below measures the remaining benefit against the same release.

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
The additive fixture covers solid and gradient paints at 0%, 50%, and 100%
additiveness; active materials preserve additive pixels exactly while ordinary
paints still receive their tint.
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

## MSAA flush benchmark (2026-10-15)

On this machine (Ryzen 9 5900X, RTX 2060 SUPER, NVIDIA 595.104.02), Chromium
143.0.7499.4 used the physical GPU through ANGLE/OpenGL ES 3.2. Both builds use
the same 2.44.2 fork, release flags, and byte-identical JavaScript loader. The
baseline reverses only optimization commits `f9dbba34` and `355d5907`.

| Atlas workload | Baseline CPU/flush | Optimized CPU/flush | Reduction (95% interval) |
| --- | ---: | ---: | ---: |
| All eight artboards | 1.962 ms | 1.708 ms | 12.9% (12.3–13.5%) |
| Three of eight redrawn | 0.968 ms | 0.850 ms | 12.2% (11.7–12.6%) |
| Avatar only | 0.168 ms | 0.166 ms | 1.3% (0.7–1.9%) |

Each workload has 24 paired blocks of 120 measured frames, with alternating
execution order every frame and reversed context creation order in the second
run. Intervals bootstrap paired block means rather than individual frames.
The same-build A/A control averaged +0.26% (95% interval −2.16% to +3.24%).
The avatar-only difference is about two microseconds and has little practical
value; the busy-atlas saving remains useful after rebasing.

The replay uses the original eight artboards and recorded dimensions, with
current asset bytes in a 291×455 atlas. Partial redraws freeze the other
artboards and reproduce regional clearing plus `beginOverlayFrame`. The
three-artboard subset is AvatarElements, WoodWindmill, and WindSpinner.
These are CPU timings for the atlas render handoff, including both sampler
unbind loops. They do not measure whole-game FPS or performance on phones.

All 21 initial/warmup/end bytewise atlas comparisons matched exactly, and
both builds issued the same draw calls. Full-atlas GL calls fell from 17,090
to 11,439 (33.1%). A negative control that changed one pixel byte correctly
failed the parity check. GL counting and pixel readback run outside timing.

`benchmarks/msaa-2026-10-15/` retains the exact benchmark harness, compressed
per-frame samples, package/asset hashes, baseline source diff, summary, and
hardware/negative-control evidence. From a Magic Circle Nix development shell:

```sh
node /path/to/rive-wasm/benchmarks/msaa-2026-10-15/benchmark.mjs \
  /path/to/magiccircle.gg /path/to/baseline /path/to/optimized /tmp/msaa.json
python3 /path/to/rive-wasm/benchmarks/msaa-2026-10-15/summarize.py \
  /tmp/msaa.json /tmp/msaa-summary.json
```

The recorded samples can also be re-summarized directly from `samples.json.gz`.

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

## WebGPU package

`@magiccircle/rive-webgpu-advanced` is the same runtime on Rive's WebGPU
backend, compiled with Emscripten's emdawnwebgpu port. The host (Pixi) owns
the `GPUAdapter`, `GPUDevice` and every target texture; Rive imports them and
never destroys them. Files, artboards, state machines, view models, images
and surface materials behave as in the WebGL2 package, including image
materials in atomics mode and the 2.44.2 MSAA fill/stroke and feather-atlas
shaders. Compatibility devices without vertex storage buffers use MSAA.
`load()` waits for embedded images to decode and attach before resolving with the file.

### Build

```sh
wasm/build_webgpu.sh                        # webgpu only
wasm/build_webgpu.sh -i -r webgl2,webgpu    # incremental, keeps webgl2 staged
```

The `webgpu` target builds only when `-r` names it, so the default
`build_all_wasm.sh` run is unchanged. `build_all_wasm.sh` empties every staged
package first; name `webgl2` too when both packages should stay staged. The
output is staged in `js/npm/webgpu_advanced`: `webgpu_advanced.mjs`,
`rive.wasm` (SIMD only; every browser with WebGPU has wasm SIMD), the type
declarations and `surface_material_shader.mjs`.

WebGPU shaders are generated at build time (GLSL → glslangValidator →
spirv-opt → naga → WGSL → C++ headers), so the tools decide the binary.
`build_webgpu.sh` takes the tools from one locked nixpkgs revision,
`https://releases.nixos.org/nixpkgs/nixpkgs-26.11pre1100667.674a2028661e/nixexprs.tar.zst`
(rev `674a2028661e550a97400c1cc992b9cca9a668a1`, narHash
`sha256-GNxqGToDYDZH2M4YeIj5nLPEyljtn3hEdIFY1/JNm0M=`):

| Tool | Version | Store path |
| --- | --- | --- |
| glslang | 16.6.0 | `/nix/store/h8qbmv3y1c1rp603gkcsh10141328wbk-glslang-16.6.0-bin` |
| spirv-tools | 1.4.363.0 (SPIRV-Tools v2026.4) | `/nix/store/z5hs3p3inrq3w8cv71jycz7l4y3ny5xk-spirv-tools-1.4.363.0` |
| naga (wgpu-utils) | 29.0.1 | `/nix/store/52zy7lkia433yhjd57x9c045h34s3h51-wgpu-utils-29.0.1` |
| gnumake | 4.4.1 | `/nix/store/vs2sa1msvkjxbb70h47819zq8a9srj21-gnumake-4.4.1` |
| python3 | 3.14.8 | `/nix/store/xahxrjs30p3mw0a42bqg9ikgkikskw8m-python3-3.14.8` |

The script prints the naga, spirv-opt and glslang versions before building.
`build_all_wasm.sh` sets `PYTHONHASHSEED=0` for this target:
`wgsl_to_header.py` renames identifiers in set order, and the fixed seed keeps
rebuilt shaders, and so the wasm, byte-identical. Emscripten `4.0.23` (from
`get_emcc.sh`) pins the emdawnwebgpu port (`v20251002.162335`).

### Validate

```sh
npm --prefix js run test:webgpu-package
```

Like the WebGL2 test, this packs the package, installs the tarball (with its
`@webgpu/types` dependency, so it needs the npm registry) and drives real
WebGPU on SwiftShader in headless Chrome; set `CHROME_BIN` if needed. It
checks the public API, normal/Gold/Rainbow in atomics and MSAA, inherited
and explicit image materials in both modes, overlay preservation, clip rects,
eight back-to-back flushes against one flush,
texture-backed and browser-decoded images, and re-init after device loss
with identical pixels. Any WebGPU validation error fails it.
Set `RIVE_TEST_GPU=host` to use the physical GPU through ANGLE/Vulkan, retry adapter discovery briefly, and reject fallback/software adapters.
`RIVE_TEST_FIXTURE` and `RIVE_TEST_ARTBOARD` work as in the WebGL2 test.

### Differences from the WebGL2 package

Everything Magic Circle's client uses from the WebGL2 package exists here,
except the GL handoff members, which have no WebGPU meaning:

| WebGL2 package | WebGPU package |
| --- | --- |
| `makeRenderer(canvas, offscreen?)` | `initWebGPU(adapter, device, { compatibilityMode? })` once, then `makeRenderer()` |
| `renderer.setTargetTexture(glTexture, width, height)` | `renderer.setTargetTexture(gpuTexture)` |
| `renderer.clear()`, `beginOverlayFrame()` | same, plus optional `clearColor` and `msaaSampleCount` |
| `renderer.flush()`, then `rive.resolveAnimationFrame()` | `flush()` submits its own command buffer; `resolveAnimationFrame()` is a no-op |
| `bindContext()`, `invalidateGLState()`, `unbindGLInternalResources()` | not present: Rive shares no GL state with the host |
| `renderer.makeImageFromGLTexture(texture, w, h)` | `rive.makeImageFromWebGPUTexture(gpuTexture)`; Rive does not destroy the texture |
| `decodeImage(bytes, cb)` | same; the browser decodes, and `cb` gets the image after upload or `null` |
| `load(bytes, loader, enableRiveAssetCDN = true)` | same, but the CDN loader defaults off and there are no deferred sessions |
| `saveClipRect`, `restoreClipRect`, `setSurfaceMaterial`, `align` | same; WebGPU targets are top-down, so clip rects need no Y flip |
| `rive.wasm` and `rive_fallback.wasm` | `rive.wasm` only |

Offscreen renderer pooling, `requestAnimationFrame`, deferred sessions and
the canvas renderer are not built. `locateFile` defaults to `rive.wasm`
relative to the page; bundled hosts pass their own, as with the WebGL2 package.

Types: `webgpu_advanced.mjs.d.ts` (from `js/src/rive_webgpu_advanced.mjs.d.ts`)
re-exports the shared `rive_advanced.mjs.d.ts`, which ships unchanged beside
it, and redeclares only `RiveOptions`, `RiveCanvas`, `Renderer`,
`ImageCallback` and `DecodeImage`. `Artboard.draw()` takes `RendererBase`,
the members every flavour's renderer shares. Like Pixi, the package depends on
`@webgpu/types` and references it; TypeScript 7's DOM library declares WebGPU
too, so consumers need `skipLibCheck`, as Pixi already requires.

### Flush contract

Rive uploads each flush's data with `queue.writeBuffer()` into rings three
buffers deep. Commands recorded into a host encoder and submitted later would
read buffers that later flushes have already overwritten: a fourth flush
before the host submits corrupts the first. `flush()` therefore always
encodes into its own command buffer and submits it before returning, so any
number of flushes per host frame is safe, and queue order makes host commands
submitted afterwards sample the finished texture. There is no host-encoder
variant.

### Device-loss contract

When `device.lost` resolves, request a new adapter and device and call
`initWebGPU()` again; it returns false, keeping the previous device, if Rive
cannot use the new one. A successful call releases the previous context's GPU
resources and makes everything created on the previous device stale:

- stale renderers throw from `setTargetTexture()`, `clear()`,
  `beginOverlayFrame()` and `flush()`; `delete()` them and call
  `makeRenderer()`;
- stale files, artboards, state machines, view-model instances and images
  stay memory-safe to advance and release but must not be drawn; release
  them, then `load()` and decode again.

The emptied context object stays alive for the module's lifetime, because
stale files keep raw factory pointers into it. A voluntary switch to another
device follows the same rules.

### Current release state

This branch builds both packages as `2.44.2-mc.3`, following the WebGL2
`2.44.2-mc.2` fork. It includes that line's bitmap decoding, MSAA CPU
optimizations, outside-stroke material coordinates, and luminance-mask and
additive-paint exclusions. The shared runtime adds material-mode rounding,
WebGPU material shaders and atomics image-rect payloads. Both packages use
that runtime commit; `Artboard.draw()` accepts their common `RendererBase`.
