/// <reference types="@webgpu/types" />

// Types for @magiccircle/rive-webgpu-advanced, shipped as
// webgpu_advanced.mjs.d.ts.
//
// The WebGPU module shares its files, artboards, state machines, view models,
// paths and paints with the other advanced flavours, so those types come from
// rive_advanced.mjs.d.ts, which ships unchanged beside this file. This entry
// replaces only what differs: the module object (device setup, renderer
// creation, image decoding) and the renderer, which draws into a GPUTexture
// instead of a canvas or WebGL texture. Its declarations shadow the shared
// ones of the same name (RiveOptions, RiveCanvas, Renderer, ImageCallback and
// DecodeImage).

import type {
  RiveCanvas as SharedRiveCanvas,
  RendererBase,
  File,
  FileAssetLoader,
  ImageInternal,
  SurfaceMaterial,
} from "./rive_advanced.mjs";

export * from "./rive_advanced.mjs";

export interface RiveOptions {
  /**
   * Maps the binary the module requests to its URL. The package ships it as
   * `rive.wasm`. The default requests `rive.wasm` relative to the page (the
   * glue has no import.meta, as in the other flavours), so bundled hosts pass
   * their own, e.g. `() => wasmUrl` with
   * `import wasmUrl from "@magiccircle/rive-webgpu-advanced/rive.wasm?url"`.
   */
  locateFile?(file: string, scriptDirectory: string): string;
  wasmBinary?: ArrayBuffer;
}

declare function Rive(options?: RiveOptions): Promise<RiveCanvas>;
export default Rive;

export interface WebGPUInitOptions {
  /**
   * The device came from a compatibility-mode adapter
   * (`requestAdapter({ featureLevel: "compatibility" })`). Rive then works
   * within compatibility limits, which rules out atomics mode, so frames use
   * MSAA. Leave unset for core devices such as Pixi's.
   */
  compatibilityMode?: boolean;
}

/** Called with the decoded image, or null if the bytes could not decode. */
export interface ImageCallback {
  (image: ImageInternal | null): void;
}
export interface DecodeImage {
  (bytes: Uint8Array, callback: ImageCallback): void;
}

/**
 * Shared module members this flavour leaves out (canvas- or WebGL-only, or
 * not built) or redeclares below with WebGPU signatures.
 */
type OmittedSharedMembers =
  | "CanvasRenderer"
  | "renderFactory"
  | "makeDeferredSession"
  | "load"
  | "makeRenderer"
  | "decodeImage"
  | "resolveAnimationFrame"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
  | "enableFPSCounter"
  | "disableFPSCounter"
  | "cleanup";

/**
 * The WebGPU module. Call `initWebGPU()` with the host's adapter and device
 * before anything that touches the GPU: until it succeeds, `makeRenderer()`,
 * `decodeImage()` and `makeImageFromWebGPUTexture()` throw and `load()`
 * rejects.
 */
export interface RiveCanvas
  extends Omit<SharedRiveCanvas, OmittedSharedMembers> {
  /**
   * Creates Rive's render context on a device the caller owns. Rive never
   * destroys the device or its textures.
   *
   * Device loss: when `device.lost` resolves, request a new adapter and
   * device and call `initWebGPU()` again. Everything made on the previous
   * device is stale from then on:
   * - renderers throw from `setTargetTexture()`, `clear()`,
   *   `beginOverlayFrame()` and `flush()`; `delete()` them and call
   *   `makeRenderer()`;
   * - files, artboards, state machines, view-model instances and images
   *   stay memory-safe to inspect, advance and release, but must not be
   *   drawn: `unref()`/`delete()` them, then `load()` and `decodeImage()`
   *   again.
   * The previous context's GPU buffers and textures are released by the
   * call. The same applies to a voluntary switch to another device.
   *
   * @returns false if Rive cannot use the device; the previous device, if
   * any, stays current.
   */
  initWebGPU(
    adapter: GPUAdapter,
    device: GPUDevice,
    options?: WebGPUInitOptions,
  ): boolean;

  /** Creates a renderer on the current device. */
  makeRenderer(): Renderer;

  /**
   * Imports a .riv on the current device. In-band images decode in the
   * browser and attach once their pixels are on the GPU.
   *
   * @param enableRiveAssetCDN - Loads out-of-band assets from Rive's CDN.
   * Off by default (unlike the WebGL2 flavour): this build has no native
   * image decoders.
   */
  load(
    buffer: Uint8Array,
    assetLoader?: FileAssetLoader,
    enableRiveAssetCDN?: boolean,
  ): Promise<File>;

  /**
   * Decodes encoded image bytes with the browser and uploads them,
   * premultiplied, to a new texture on the current device. The callback
   * runs once the upload is queued, or with null if decoding fails.
   */
  decodeImage: DecodeImage;

  /**
   * Wraps a premultiplied GPUTexture with TEXTURE_BINDING usage, created on
   * the current device, as a Rive image (e.g. for
   * `ViewModelInstanceAssetImage.value()`). Rive does not destroy the
   * texture; keep it alive until the image is released with `unref()`.
   */
  makeImageFromWebGPUTexture(texture: GPUTexture): ImageInternal;

  /**
   * Does nothing: every `flush()` has already submitted its work. Kept so a
   * render loop written for the WebGL2 flavour runs unchanged.
   */
  resolveAnimationFrame(): void;
}

/**
 * Renderer returned by `makeRenderer()`. It draws into a GPUTexture the
 * caller owns; frames are `clear()` or `beginOverlayFrame()`, then draws,
 * then `flush()`.
 */
export declare class Renderer extends RendererBase {
  /**
   * Renders into `texture` from the next frame on. It needs
   * RENDER_ATTACHMENT usage; add TEXTURE_BINDING and COPY_SRC for blend modes
   * that read the destination. Only its first mip level and layer are drawn.
   * Rive keeps a reference until `clearTargetTexture()`, `delete()` or the
   * next call, and reuses its internal attachments while the size and format
   * stay the same.
   */
  setTargetTexture(texture: GPUTexture): void;
  /** Releases the target texture and the attachments sized for it. */
  clearTargetTexture(): void;
  /**
   * Starts a frame that clears the target to `clearColor` (0xAARRGGBB).
   * `msaaSampleCount` 0 lets Rive pick (atomics when the device supports
   * it); 4 forces MSAA.
   */
  clear(clearColor?: number, msaaSampleCount?: number): void;
  /** Starts a frame that draws over the target's current contents. */
  beginOverlayFrame(msaaSampleCount?: number): void;
  /**
   * Encodes the frame into its own command buffer and submits it to the
   * device queue before returning.
   *
   * Rive uploads per-frame data with `queue.writeBuffer()` into rings three
   * buffers deep, so a frame's commands must reach the queue before a later
   * flush overwrites its data. Submitting on every flush makes any number of
   * flushes per host frame safe, and queue order means host commands
   * submitted afterwards sample the finished texture.
   */
  flush(): void;
  /**
   * Saves the renderer state and clips to a rectangle in target pixels,
   * measured from the top-left corner (WebGPU textures are top-down, so no
   * Y flip). Pair with `restoreClipRect()`.
   */
  saveClipRect(left: number, top: number, right: number, bottom: number): void;
  /** Restores the state saved by `saveClipRect()`, including its transform. */
  restoreClipRect(): void;
  /**
   * Selects the material for subsequent artboard draws in this save scope.
   * Bounds are the material's extent in target pixels, matching the
   * `align()` frame; a negative `timeSeconds` selects static Gold.
   */
  setSurfaceMaterial(
    material: SurfaceMaterial,
    left: number,
    top: number,
    right: number,
    bottom: number,
    timeSeconds: number,
  ): void;
}
