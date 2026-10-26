#!/usr/bin/env bash
set -e

# -p          Build with profiling config (--profiling-funcs) instead of release.
#             Produces named WASM function symbols visible in Chrome DevTools.
# -i          Incremental build. Skips cleaning the build directory so only
#             changed C++ files are recompiled.
# -r <targets> For local dev. Comma-separated list of targets to build.
#             Builds specified targets; webgl2 includes its fallback WASM.
#             Available: canvas, canvas-lite, canvas-single, webgl2, webgpu
#             (webgpu builds only when named.)
WASM_CONFIG=release
TARGETS=""
INCREMENTAL=0
while getopts "pir:" flag; do
    case "${flag}" in
    p) WASM_CONFIG=profiling ;;
    i) INCREMENTAL=1 ;;
    r) TARGETS="${OPTARG}" ;;
    *) echo "Unknown flag: $flag" ;;
    esac
done

# Returns 0 (true) if the given target is requested, or if no -r list was given (build all).
target_enabled() {
    [ -z "$TARGETS" ] && return 0
    echo ",$TARGETS," | grep -q ",${1},"
}

# Both wasm binaries share one JS glue, so they must expose the same import and
# export names and signatures. Selective WebGL2 builds include the fallback;
# other selective builds do not. The base and advanced packages share bytes.
verify_fallback() {
    if [ -n "$TARGETS" ] && [ "$1" != "webgl2" ]; then
        return 0
    fi
    local pkg="../js/npm/$1"
    if [ ! -f "$pkg/rive_fallback.wasm" ]; then
        echo "ERROR: $1: rive_fallback.wasm was not staged by this build." >&2
        echo "       Publishing now would ship a package whose fallback URL 404s." >&2
        return 1
    fi
    if cmp -s "$pkg/rive.wasm" "$pkg/rive_fallback.wasm"; then
        echo "ERROR: $1: rive.wasm is the same binary as its fallback." >&2
        echo "       Every browser would get the build without SIMD." >&2
        return 1
    fi
    python3 ./verify_fallback_abi.py "$pkg/rive.wasm" "$pkg/rive_fallback.wasm"
}

source ./get_emcc.sh

rm -f ../js/npm/canvas_advanced/*.mjs
rm -f ../js/npm/canvas_advanced/*.wasm

rm -f ../js/npm/canvas_advanced_lite/*.mjs
rm -f ../js/npm/canvas_advanced_lite/*.wasm

rm -f ../js/npm/canvas_advanced_single/*.mjs

rm -f ../js/npm/canvas/*.mjs
rm -f ../js/npm/canvas/*.wasm

rm -f ../js/npm/canvas_lite/*.mjs
rm -f ../js/npm/canvas_lite/*.wasm

rm -f ../js/npm/canvas_single/*.mjs

rm -f ../js/npm/webgl2_advanced/*.mjs*
rm -f ../js/npm/webgl2_advanced/*.wasm

rm -f ../js/npm/webgl2/*.mjs
rm -f ../js/npm/webgl2/*.wasm

rm -f ../js/npm/webgpu_advanced/*.mjs*
rm -f ../js/npm/webgpu_advanced/*.wasm

mkdir -p ../js/npm/canvas
mkdir -p ../js/npm/canvas_lite
mkdir -p ../js/npm/canvas_single
mkdir -p ../js/npm/canvas_advanced
mkdir -p ../js/npm/canvas_advanced_lite
mkdir -p ../js/npm/canvas_advanced_single
mkdir -p ../js/npm/webgl2
mkdir -p ../js/npm/webgl2_advanced
mkdir -p ../js/npm/webgpu_advanced

if [ "$INCREMENTAL" -eq 0 ]; then
    echo
    echo "::::: cleaning all projects"
    echo
    rm -fR ./build
fi

if [ -z "$TARGETS" ]; then
    echo
    echo "::::: building @rive-app/canvas_advanced fallback"
    echo
    OUT_DIR=build/canvas_advanced_fallback/bin/${WASM_CONFIG} ./build_wasm.sh -w -c ${WASM_CONFIG}
    cp build/canvas_advanced_fallback/bin/${WASM_CONFIG}/canvas_advanced.wasm ../js/npm/canvas_advanced/rive_fallback.wasm
    cp build/canvas_advanced_fallback/bin/${WASM_CONFIG}/canvas_advanced.wasm ../js/npm/canvas/rive_fallback.wasm
fi

if target_enabled "canvas"; then
    echo
    echo "::::: building @rive-app/canvas_advanced"
    echo
    OUT_DIR=build/canvas_advanced/bin/${WASM_CONFIG} ./build_wasm.sh -w ${WASM_CONFIG}
    cp build/canvas_advanced/bin/${WASM_CONFIG}/canvas_advanced.mjs ../js/npm/canvas_advanced/canvas_advanced.mjs
    cp build/canvas_advanced/bin/${WASM_CONFIG}/canvas_advanced.wasm ../js/npm/canvas_advanced/rive.wasm
    cp build/canvas_advanced/bin/${WASM_CONFIG}/canvas_advanced.wasm ../js/npm/canvas/rive.wasm
    cp ../js/src/rive_advanced.mjs.d.ts ../js/npm/canvas_advanced/rive_advanced.mjs.d.ts
    verify_fallback canvas
fi

if [ -z "$TARGETS" ]; then
    echo
    echo "::::: building @rive-app/canvas_advanced_lite fallback"
    echo
    OUT_DIR=build/canvas_advanced_lite_fallback/bin/${WASM_CONFIG} ./build_wasm.sh -c -l -r c2d_only ${WASM_CONFIG}
    cp build/canvas_advanced_lite_fallback/bin/${WASM_CONFIG}/canvas_advanced_c2d_only.wasm ../js/npm/canvas_advanced_lite/rive_fallback.wasm
    cp build/canvas_advanced_lite_fallback/bin/${WASM_CONFIG}/canvas_advanced_c2d_only.wasm ../js/npm/canvas_lite/rive_fallback.wasm
fi

if target_enabled "canvas-lite"; then
    echo
    echo "::::: building @rive-app/canvas_advanced_lite"
    echo
    OUT_DIR=build/canvas_advanced_lite/bin/${WASM_CONFIG} ./build_wasm.sh -l -r c2d_only ${WASM_CONFIG}
    cp build/canvas_advanced_lite/bin/${WASM_CONFIG}/canvas_advanced_c2d_only.mjs ../js/npm/canvas_advanced_lite/canvas_advanced.mjs
    cp build/canvas_advanced_lite/bin/${WASM_CONFIG}/canvas_advanced_c2d_only.wasm ../js/npm/canvas_advanced_lite/rive.wasm
    cp build/canvas_advanced_lite/bin/${WASM_CONFIG}/canvas_advanced_c2d_only.wasm ../js/npm/canvas_lite/rive.wasm
    cp ../js/src/rive_advanced.mjs.d.ts ../js/npm/canvas_advanced_lite/rive_advanced.mjs.d.ts
    verify_fallback canvas_lite
fi

if target_enabled "canvas-single"; then
    echo
    echo "::::: building @rive-app/canvas_advanced_single"
    echo
    OUT_DIR=build/canvas_advanced_single/bin/${WASM_CONFIG} ./build_wasm.sh -w -c -s ${WASM_CONFIG}
    cp build/canvas_advanced_single/bin/${WASM_CONFIG}/canvas_advanced_single.mjs ../js/npm/canvas_advanced_single/canvas_advanced_single.mjs
    cp ../js/src/rive_advanced.mjs.d.ts ../js/npm/canvas_advanced_single/rive_advanced.mjs.d.ts
fi

if target_enabled "webgl2"; then
    echo
    echo "::::: building @rive-app/webgl2_advanced fallback"
    echo
    OUT_DIR=build/webgl2_advanced_fallback/bin/${WASM_CONFIG} ./build_wasm.sh -w -c -r webgl2 ${WASM_CONFIG}
    cp build/webgl2_advanced_fallback/bin/${WASM_CONFIG}/webgl2_advanced.wasm ../js/npm/webgl2_advanced/rive_fallback.wasm
    cp build/webgl2_advanced_fallback/bin/${WASM_CONFIG}/webgl2_advanced.wasm ../js/npm/webgl2/rive_fallback.wasm
fi

if target_enabled "webgl2"; then
    echo
    echo "::::: building @rive-app/webgl2_advanced"
    echo
    OUT_DIR=build/webgl2_advanced/bin/${WASM_CONFIG} ./build_wasm.sh -w -r webgl2 ${WASM_CONFIG}
    cp build/webgl2_advanced/bin/${WASM_CONFIG}/webgl2_advanced.mjs ../js/npm/webgl2_advanced/webgl2_advanced.mjs
    cp build/webgl2_advanced/bin/${WASM_CONFIG}/webgl2_advanced.wasm ../js/npm/webgl2_advanced/rive.wasm
    cp build/webgl2_advanced/bin/${WASM_CONFIG}/webgl2_advanced.wasm ../js/npm/webgl2/rive.wasm
    cp ../js/src/rive_advanced.mjs.d.ts ../js/npm/webgl2_advanced/rive_advanced.mjs.d.ts
    verify_fallback webgl2
    node scripts/export_surface_material_shader.mjs \
        submodules/rive-runtime/renderer/src/shaders/surface_material.glsl \
        ../js/npm/webgl2_advanced/surface_material_shader.mjs \
        ../js/npm/webgl2_advanced/surface_material_shader.mjs.d.ts
fi

# Opt-in only: an empty -r list builds every published target, not this one.
# SIMD only: every browser with WebGPU also has wasm SIMD.
if [ -n "$TARGETS" ] && target_enabled "webgpu"; then
    echo
    echo "::::: building @magiccircle/rive-webgpu-advanced"
    echo
    # wgsl_to_header.py renames identifiers in set order; a fixed hash seed
    # keeps rebuilt shaders, and so the wasm, byte-identical.
    PYTHONHASHSEED=0 OUT_DIR=build/webgpu_advanced/bin/${WASM_CONFIG} ./build_wasm.sh -r webgpu ${WASM_CONFIG}
    cp build/webgpu_advanced/bin/${WASM_CONFIG}/webgpu_advanced.mjs ../js/npm/webgpu_advanced/webgpu_advanced.mjs
    cp build/webgpu_advanced/bin/${WASM_CONFIG}/webgpu_advanced.wasm ../js/npm/webgpu_advanced/rive.wasm
    cp ../js/src/rive_advanced.mjs.d.ts ../js/npm/webgpu_advanced/rive_advanced.mjs.d.ts
    cp ../js/src/rive_webgpu_advanced.mjs.d.ts ../js/npm/webgpu_advanced/webgpu_advanced.mjs.d.ts
    node scripts/export_surface_material_shader.mjs \
        submodules/rive-runtime/renderer/src/shaders/surface_material.glsl \
        ../js/npm/webgpu_advanced/surface_material_shader.mjs \
        ../js/npm/webgpu_advanced/surface_material_shader.mjs.d.ts
fi
