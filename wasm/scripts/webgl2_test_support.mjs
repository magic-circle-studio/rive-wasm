export function parseShaderMacros(source) {
  return Object.fromEntries(Array.from(
    source.matchAll(/^#define GLSL_(\w+) "([^"]+)"$/gm),
    ([, name, alias]) => [name, alias],
  ));
}

export async function findChrome() {
  const { spawnSync } = await import("node:child_process");
  for (const candidate of [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser"].filter(Boolean)) {
    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  }
  throw new Error("Chrome was not found. Set CHROME_BIN to its executable.");
}

export function pathFixture({ screen = false, feather = false, meshPNG = null, imagePNG = null, pathReference = false, unitMesh = false } = {}) {
  const bytes = [...new TextEncoder().encode("RIVE"), 7, 0, 0, 0];
  const uint = (value) => {
    do {
      const byte = value & 127;
      value >>>= 7;
      bytes.push(byte | (value ? 128 : 0));
    } while (value);
  };
  const prop = (key, value, type = "uint") => {
    uint(key);
    if (type === "uint") uint(value);
    else if (type === "bytes") { uint(value.length); bytes.push(...value); }
    else {
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      if (type === "color") view.setUint32(0, value, true);
      else view.setFloat32(0, value, true);
      bytes.push(...new Uint8Array(buffer));
    }
  };
  uint(23); uint(0); // Backboard.
  const imageBytes = pathReference ? null : meshPNG ?? imagePNG;
  if (imageBytes) {
    uint(105); prop(204, 0); prop(208, 32, "float"); prop(207, 32, "float"); uint(0);
    uint(106); prop(212, imageBytes, "bytes"); uint(0);
  }
  uint(1); prop(7, 256, "float"); prop(8, 256, "float"); uint(0);
  if (imagePNG && pathReference) {
    uint(3); prop(5, 0); prop(13, 176, "float"); prop(14, 176, "float"); uint(0);
    uint(7); prop(5, 1); prop(20, 32, "float"); prop(21, 32, "float");
    prop(123, 0, "float"); prop(124, 0, "float"); uint(0);
    uint(20); prop(5, 1); uint(0);
    // The flat PNG is equivalent to this solid-color path.
    uint(18); prop(5, 3); prop(37, 0x80e03080, "color"); uint(0);
    return new Uint8Array(bytes);
  }
  if (imageBytes) {
    uint(100); prop(5, 0); prop(206, 0); prop(13, 176, "float"); prop(14, 176, "float"); prop(380, 0, "float"); prop(381, 0, "float"); uint(0);
    if (imagePNG) return new Uint8Array(bytes);
    uint(109); prop(5, 1); prop(223, [0, 1, 2, 0, 2, 3], "bytes"); uint(0);
    const vertices = unitMesh
      ? [[0, 0, 0, 0], [32, 0, 1, 0], [32, 32, 1, 1], [0, 32, 0, 1]]
      : [[-32, -32, 0, 0], [32, -32, 1, 0], [32, 32, 1, 1], [-32, 32, 0, 1]];
    for (const [x, y, u, v] of vertices) {
      uint(108); prop(5, 2); prop(24, x, "float"); prop(25, y, "float");
      prop(215, u, "float"); prop(216, v, "float"); uint(0);
    }
    return new Uint8Array(bytes);
  }
  uint(3); prop(5, 0); prop(13, 48, "float"); prop(14, 64, "float"); uint(0);
  uint(7); prop(5, 1); prop(20, 48, "float"); prop(21, 32, "float"); uint(0);
  uint(20); prop(5, 1);
  if (feather) prop(40, 2); // FillRule::clockwise is required for feather fills.
  if (screen) prop(747, 14); // BlendMode::screen.
  uint(0);
  uint(18); prop(5, 3); prop(37, 0xffe04080, "color"); uint(0);
  if (feather) {
    uint(533); prop(5, 3); prop(749, 8, "float"); uint(0);
  }
  return new Uint8Array(bytes);
}
