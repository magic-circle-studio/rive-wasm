#!/usr/bin/env bash
# Builds @magiccircle/rive-webgpu-advanced (release) into js/npm/webgpu_advanced.
#   wasm/build_webgpu.sh [build_all_wasm.sh flags]
# Without -r it builds only webgpu. build_all_wasm.sh empties every staged
# package first, so restage webgl2 alongside with -r webgl2,webgpu.
#
# The WebGPU shaders are compiled into the wasm at build time (GLSL ->
# glslangValidator -> spirv-opt -> naga -> WGSL), so this script pins those
# tools to one nixpkgs revision. Expected store paths:
#   glslang 16.6.0              /nix/store/h8qbmv3y1c1rp603gkcsh10141328wbk-glslang-16.6.0-bin
#   spirv-tools 1.4.363.0       /nix/store/z5hs3p3inrq3w8cv71jycz7l4y3ny5xk-spirv-tools-1.4.363.0
#   (SPIRV-Tools v2026.4)
#   naga 29.0.1 (wgpu-utils)    /nix/store/52zy7lkia433yhjd57x9c045h34s3h51-wgpu-utils-29.0.1
#   gnumake 4.4.1, python3 3.14.8
# emsdk 4.0.23 and Premake 5.0.0-beta7 come from get_emcc.sh / build_wasm.sh.
set -euo pipefail

NIXPKGS='https://releases.nixos.org/nixpkgs/nixpkgs-26.11pre1100667.674a2028661e/nixexprs.tar.zst?narHash=sha256-GNxqGToDYDZH2M4YeIj5nLPEyljtn3hEdIFY1/JNm0M%3D'
NIX=${NIX:-nix}

targets=(-r webgpu)
for arg in "$@"; do
    if [ "$arg" = "-r" ]; then
        targets=()
    fi
done

cd "$(dirname "$0")"
# A host CC/CXX/AR/LD would override emsdk's compilers.
exec env -u CC -u CXX -u AR -u LD \
    "$NIX" shell "$NIXPKGS#glslang" "$NIXPKGS#spirv-tools" \
    "$NIXPKGS#wgpu-utils" "$NIXPKGS#gnumake" "$NIXPKGS#python3" \
    -c bash -c 'naga --version && spirv-opt --version | head -n 1 &&
        glslangValidator --version | head -n 1 &&
        exec ./build_all_wasm.sh "$@"' build_webgpu "$@" "${targets[@]}"
