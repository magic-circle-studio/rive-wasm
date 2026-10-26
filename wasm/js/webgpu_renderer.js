// JS side of bindings_webgpu.cpp. The caller owns every GPU object: it creates
// the GPUAdapter/GPUDevice and the target GPUTextures, and this glue only
// imports them into emdawnwebgpu's handle table (WebGPU.importJs*).

// The package ships its binary as rive.wasm, the name the webgl2 package
// uses, so the default locateFile asks for that file. Like the other
// flavours, the glue has no import.meta: the default resolves against the
// page, not this module, so bundled hosts pass their own locateFile.
if (!Module["locateFile"]) {
  Module["locateFile"] = function (path, scriptDirectory) {
    return scriptDirectory + (path.endsWith(".wasm") ? "rive.wasm" : path);
  };
}

const webgpuOnRuntimeInitialized = Module["onRuntimeInitialized"];

Module["onRuntimeInitialized"] = function () {
  // If an initialize function is already configured, execute that first.
  webgpuOnRuntimeInitialized && webgpuOnRuntimeInitialized();

  let gpuDevice = null;
  // Each successful initWebGPU() starts a generation. Renderers belong to the
  // generation they were made in; a later initWebGPU() (e.g. after device
  // loss) makes them stale.
  let generation = 0;

  const cppInitWebGPU = Module["_initWebGPU"];
  /**
   * Creates Rive's render context on a caller-owned adapter and device.
   * Call it again with a new device after device loss: renderers, files and
   * images from the previous device become stale (see the d.ts).
   * Returns false, leaving any previous device in place, if Rive rejects it.
   */
  Module["initWebGPU"] = function (adapter, device, options = {}) {
    const adapterHandle = WebGPU.importJsAdapter(adapter);
    const deviceHandle = WebGPU.importJsDevice(device, adapterHandle);
    const nextGeneration = cppInitWebGPU(
      adapterHandle,
      deviceHandle,
      Boolean(options["compatibilityMode"])
    );
    if (nextGeneration === 0) {
      return false;
    }
    generation = nextGeneration;
    gpuDevice = device;
    return true;
  };

  function requireDevice(api) {
    if (generation === 0) {
      throw new Error("Rive: call initWebGPU() before " + api + "()");
    }
  }

  const cppMakeRenderer = Module["_makeWebGPURenderer"];
  /** Creates a renderer on the current device; it draws into a GPUTexture. */
  Module["makeRenderer"] = function () {
    requireDevice("makeRenderer");
    return cppMakeRenderer();
  };

  const rendererProto = Module["WebGPURenderer"]["prototype"];
  const cppGeneration = rendererProto["_generation"];
  const cppSetTargetTexture = rendererProto["_setTargetTexture"];
  const cppHasTargetTexture = rendererProto["_hasTargetTexture"];
  const cppBeginFrame = rendererProto["_beginFrame"];
  const cppFlush = rendererProto["_flush"];

  function requireCurrentRenderer(renderer) {
    if (cppGeneration.call(renderer) !== generation) {
      throw new Error(
        "Rive: this renderer belongs to a device replaced by initWebGPU(); " +
          "delete() it and call makeRenderer()"
      );
    }
  }

  /**
   * Renders into a caller-owned GPUTexture (RENDER_ATTACHMENT, plus
   * TEXTURE_BINDING | COPY_SRC for destination-reading blend modes).
   */
  rendererProto["setTargetTexture"] = function (gpuTexture) {
    requireCurrentRenderer(this);
    cppSetTargetTexture.call(this, WebGPU.importJsTexture(gpuTexture));
  };

  function beginFrame(renderer, clear, clearColor, msaaSampleCount) {
    requireCurrentRenderer(renderer);
    if (!cppHasTargetTexture.call(renderer)) {
      throw new Error("Rive: call setTargetTexture() before starting a frame");
    }
    cppBeginFrame.call(renderer, clear, clearColor >>> 0, msaaSampleCount);
  }

  /** Clears the target to clearColor (0xAARRGGBB) and starts a frame. */
  rendererProto["clear"] = function (clearColor = 0, msaaSampleCount = 0) {
    beginFrame(this, true, clearColor, msaaSampleCount);
  };

  /** Starts a frame that draws over the target's current contents. */
  rendererProto["beginOverlayFrame"] = function (msaaSampleCount = 0) {
    beginFrame(this, false, 0, msaaSampleCount);
  };

  /** Encodes the frame and submits it in its own command buffer. */
  rendererProto["flush"] = function () {
    requireCurrentRenderer(this);
    cppFlush.call(this);
  };

  // Every flush() already submitted its work, so there is nothing to
  // resolve; kept for parity with the WebGL2 package's render loop.
  Module["resolveAnimationFrame"] = function () {};

  const cppMakeImage = Module["_makeImageFromWebGPUTexture"];
  /** Wraps a premultiplied, TEXTURE_BINDING GPUTexture as a Rive image. */
  Module["makeImageFromWebGPUTexture"] = function (gpuTexture) {
    requireDevice("makeImageFromWebGPUTexture");
    return cppMakeImage(WebGPU.importJsTexture(gpuTexture));
  };

  /**
   * Decodes encoded image bytes with the browser and uploads them,
   * premultiplied, into a new texture on the current device.
   */
  async function decodeToTexture(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes]), {
      "premultiplyAlpha": "none",
      "colorSpaceConversion": "none",
    });
    const texture = gpuDevice["createTexture"]({
      "size": [bitmap.width, bitmap.height],
      "format": "rgba8unorm",
      "usage":
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    gpuDevice["queue"]["copyExternalImageToTexture"](
      { "source": bitmap },
      { "texture": texture, "premultipliedAlpha": true },
      [bitmap.width, bitmap.height]
    );
    bitmap.close();
    return texture;
  }

  /**
   * Calls onComplete with the decoded image once its pixels are on the GPU,
   * or with null if the browser cannot decode the bytes.
   */
  Module["decodeImage"] = function (bytes, onComplete) {
    requireDevice("decodeImage");
    decodeToTexture(bytes).then(
      (texture) => onComplete(Module["makeImageFromWebGPUTexture"](texture)),
      () => onComplete(null)
    );
  };

  // Without rive_decoders the native factory cannot decode in-band images,
  // so they decode in the browser and attach once ready.
  const InBandImageLoader = Module["FileAssetLoader"]["extend"](
    "WebGPUInBandImageLoader",
    {
      "__construct": function (state) {
        this["__parent"]["__construct"].call(this);
        this._state = state;
      },
      "loadContents": function (assetAddress, bytes) {
        const asset = Module["ptrToAsset"](assetAddress);
        if (!asset["isImage"] || bytes["byteLength"] === 0) {
          return false;
        }
        // The view aliases wasm memory, which import may grow or reuse.
        const ownedBytes = new Uint8Array(bytes);
        const state = this._state;
        state.decodes.push(new Promise((resolve) => {
          Module["decodeImage"](ownedBytes, (image) => {
            try {
              if (image && !state.abandoned) {
                asset["setRenderImage"](image);
              }
            } finally {
              if (image) image["unref"]();
              resolve();
            }
          });
        }));
        return true;
      },
    }
  );

  const cppLoad = Module["load"];
  /**
   * Imports a .riv on the current device. The Rive CDN loader is off by
   * default: CDN images would need native decoders this build omits.
   * Embedded images finish decoding before the file is returned.
   */
  Module["load"] = async function (bytes, fileAssetLoader, enableRiveAssetCDN = false) {
    requireDevice("load");
    const state = { decodes: [], abandoned: false };
    const loader = new Module["FallbackFileAssetLoader"]();
    if (fileAssetLoader !== undefined && fileAssetLoader !== null) {
      loader["addLoader"](fileAssetLoader);
    }
    loader["addLoader"](new InBandImageLoader(state));
    if (enableRiveAssetCDN) {
      loader["addLoader"](new Module["CDNFileAssetLoader"](null));
    }
    let file;
    try {
      // Native import calls loadContents synchronously. Keep its file reference
      // private until every callback that can touch an asset has finished.
      file = cppLoad(bytes, loader, null);
    } catch (error) {
      state.abandoned = true;
      throw error;
    }
    if (!file) {
      // Import already freed the assets; late callbacks may only release images.
      state.abandoned = true;
      return null;
    }
    await Promise.allSettled(state.decodes);
    return file;
  };

  const align = Module["Renderer"]["prototype"]["align"];
  Module["Renderer"]["prototype"]["align"] = function (
    fit,
    alignment,
    frame,
    content,
    scaleFactor = 1.0
  ) {
    align.call(this, fit, alignment, frame, content, scaleFactor);
  };
};
