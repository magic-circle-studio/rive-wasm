# WebGPU image bind-group cache

The per-draw image bind-group creation in `RenderContextWebGPUImpl::flush`
followed the render encoder's bound-image state. Atomic PLS barriers restart
that encoder and reset the state, so even a null-image draw created another
identical texture/sampler group. PLS buffer bindings and the color-ramp,
tessellation, feather-atlas and main per-flush bindings already survive pass
restarts within a flush.

The cache covers the two fixed image bindings. Its complete resource key is
bind-group layout, texture-view handle and sampler handle; this descriptor
contains no buffer bindings or dynamic offsets. It owns at most 32 groups,
evicts round-robin when full, and releases everything at the end of each
flush. No cache survives buffer-ring rotation, growth, target changes or device
replacement. The remaining buffer groups continue to use the current buffer
handles and ranges on every flush.

To repeat, preserve the old staged package before rebuilding, then run:

```sh
RIVE_TEST_GPU=host RIVE_TEST_RESULT=/tmp/baseline-package.json \
  RIVE_TEST_PACKAGE_DIR=/path/to/baseline \
  npm --prefix js run test:webgpu-package
wasm/build_webgpu.sh -i -r webgl2,webgpu
RIVE_TEST_GPU=host RIVE_TEST_RESULT=/tmp/optimized-package.json \
  npm --prefix js run test:webgpu-package
node benchmarks/webgpu-bind-groups-2026-10-26/benchmark.mjs \
  /path/to/magiccircle.gg /path/to/baseline \
  js/npm/webgpu_advanced /tmp/bind-groups.json
```

Set `CHROME_BIN` if needed. The benchmark uses the app checkout's existing
Playwright dependency and `client/raw-assets/rive/decor{m}.riv`. Both browser
harnesses require a non-fallback physical adapter in host mode.

The benchmark draws seven animated decor artboards into a 512×512 atlas. It
warms both builds for 60 frames, counts full bind-group descriptors and render
passes for six separate flushes, then alternates the two builds for 12 blocks
of 60 paired frames. A second run reverses module creation order. Only
`renderer.flush()` is timed; drawing, animation advancement, API counting,
pixel readback and queue completion happen outside the timing interval.
Every pair waits for the queue, keeping the backlog bounded.

Atomics, overlay and MSAA atlas comparisons require byte-exact equality.
Package results retain hashes for all normal/Gold/Rainbow cases, image material
cases, clip and atlas cases, and a 40-image cache eviction regression in both
atomics and MSAA. The latter revisits evicted views and compares a single flush
with separate overlay flushes, exercising upload-ring rotation as well.

These are desktop Chrome CPU submission timings for this replay, not Safari
measurements or whole-game frame times.

## Recorded result

On the RTX 2060 SUPER (NVIDIA 595.104.02), Ryzen 9 5900X and Chrome
154.0.8037.57, the 1,440 measured flushes per build averaged:

| Metric | Baseline | Cached |
| --- | ---: | ---: |
| Bind groups per atomics flush | 107 | 5 |
| Creations of the dominant null-image descriptor | 103 | 1 |
| Render passes per flush | 105 | 105 |
| Mean CPU time per flush | 0.9076 ms | 0.7574 ms |

Bind-group creations fell 95.3%. Mean flush CPU fell 16.6% (paired block
bootstrap 95% interval: 15.9–17.2%; 20,000 resamples, seed 42666). The two
module creation orders individually measured 0.9119 → 0.7661 ms and
0.9033 → 0.7486 ms. All ten atlas comparisons changed zero bytes. Every
optimized counted flush created each complete descriptor exactly once.
No WebGPU validation errors occurred.

`package-baseline.json` and `package-optimized.json` are byte-identical,
including normal/Gold/Rainbow, image material, 40-view eviction, clip and
atlas hashes, in atomics and 4× MSAA. Existing material hashes also match the
previous build's recorded host results. The WebGL2 SIMD, fallback and loader
SHA-256 values are unchanged, so its package test was not rerun.

`summary.json` records commits, build/asset/package hashes and hardware.
`samples.json.gz` retains the full descriptors, per-flush counters, raw CPU
samples, pixel hashes and browser launch flags from both runs. Package
version remains `2.44.2-mc.3`; the replacement tarball is in `dist/`.
