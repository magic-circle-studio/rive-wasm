#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const [, , sourcePath, modulePath, typesPath] = process.argv;

if (!sourcePath || !modulePath || !typesPath) {
  throw new Error("expected source, module, and declaration paths");
}

const shader = `${readFileSync(sourcePath, "utf8").trim()}\n`;
if (!shader.includes("INLINE half3 apply_gold_material(")) {
  throw new Error("shared Gold shader entry point is missing");
}
if (!shader.includes("INLINE half3 apply_rainbow_material(")) {
  throw new Error("shared Rainbow shader entry point is missing");
}
writeFileSync(
  modulePath,
  `// Generated from rive-runtime surface_material.glsl.\n` +
    `export const surfaceMaterialShaderSource = ${JSON.stringify(shader)};\n`,
);
writeFileSync(
  typesPath,
  "/**\n" +
    " * Portable Gold and Rainbow shader library. Consumers provide the Rive\n" +
    " * aliases `INLINE`, `half`, `half3`, `float2`, `make_half`, and\n" +
    " * `make_half3` before inserting this source into a fragment shader.\n" +
    " */\n" +
    "export declare const surfaceMaterialShaderSource: string;\n",
);
