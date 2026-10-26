#include "rive/rive_types.hpp"

#ifdef RIVE_WEBGPU_RENDERER

// WebGPU flavour of the advanced runtime. JavaScript owns the GPUAdapter,
// GPUDevice and every target GPUTexture (as Pixi does), imports them with
// emdawnwebgpu's WebGPU.importJs* helpers, and passes the resulting handles
// here. See js/webgpu_renderer.js for the JS side of the contract.

#include "rive/renderer/render_context.hpp"
#include "rive/renderer/rive_render_image.hpp"
#include "rive/renderer/rive_renderer.hpp"
#include "rive/renderer/webgpu/render_context_webgpu_impl.hpp"
#include "js_alignment.hpp"

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <webgpu/webgpu_cpp.h>

#include <memory>
#include <stdint.h>
#include <vector>

using namespace emscripten;
using namespace rive;
using namespace rive::gpu;

namespace
{
// The render context for the device most recently passed to initWebGPU(). It
// is also the factory every file is imported through.
std::shared_ptr<RenderContext> s_renderContext;
uint32_t s_generation = 0;

// Contexts replaced by a later initWebGPU(). Files and artboards imported
// through one keep raw Factory pointers into it (text layout still makes
// paths from it), so the emptied object lives as long as the module.
std::vector<std::shared_ptr<RenderContext>> s_retiredContexts;

RenderContextWebGPUImpl* webgpuImpl(RenderContext* context)
{
    return context->static_impl_cast<RenderContextWebGPUImpl>();
}

// Each WebGPU.importJs* call returns a handle holding one reference, which the
// C++ wrapper adopts.
template <typename Wrapper, typename Handle> Wrapper adoptHandle(uintptr_t handle)
{
    return Wrapper::Acquire(reinterpret_cast<Handle>(handle));
}
} // namespace

// Creates the render context for a JS-owned device and returns its generation
// (never 0), or 0 if Rive rejects the device. Calling it again, e.g. after
// device loss, retires the previous context and everything made from it.
uint32_t initWebGPU(uintptr_t adapterHandle, uintptr_t deviceHandle, bool compatibilityMode)
{
    auto adapter = adoptHandle<wgpu::Adapter, WGPUAdapter>(adapterHandle);
    auto device = adoptHandle<wgpu::Device, WGPUDevice>(deviceHandle);
    RenderContextWebGPUImpl::ContextOptions options;
    options.compatibilityMode = compatibilityMode;
    std::unique_ptr<RenderContext> context =
        RenderContextWebGPUImpl::MakeContext(adapter, device, device.GetQueue(), options);
    if (context == nullptr)
    {
        return 0;
    }
    if (s_renderContext != nullptr)
    {
        // Frees the old device's buffers, textures and CPU arenas now; only
        // the empty object stays behind.
        s_renderContext->releaseResources();
        s_retiredContexts.push_back(std::move(s_renderContext));
    }
    s_renderContext = std::move(context);
    return ++s_generation;
}

// JS Hooks required by bindings.cpp.
Factory* jsFactory()
{
    assert(s_renderContext && "initWebGPU() must run before loading files");
    return s_renderContext.get();
}

Factory* jsSessionFactory(const emscripten::val&) { return jsFactory(); }

class RenderImageWrapper : public wrapper<RenderImage>
{
public:
    EMSCRIPTEN_WRAPPER(RenderImageWrapper);
    void unref() { RenderImage::unref(); }
};

class WebGPURenderer : public RiveRenderer
{
public:
    WebGPURenderer(std::shared_ptr<RenderContext> context, uint32_t generation) :
        RiveRenderer(context.get()), m_context(std::move(context)), m_generation(generation)
    {}

    // The initWebGPU() call this renderer belongs to; JS refuses to start
    // frames on a renderer from a retired generation.
    uint32_t generation() const { return m_generation; }

    // Targets a JS GPUTexture imported with WebGPU.importJsTexture. It needs
    // RENDER_ATTACHMENT usage; blend modes that read the destination also
    // copy from it, so callers should add COPY_SRC and TEXTURE_BINDING.
    void setTargetTexture(uintptr_t textureHandle)
    {
        auto texture = adoptHandle<wgpu::Texture, WGPUTexture>(textureHandle);
        const uint32_t width = texture.GetWidth();
        const uint32_t height = texture.GetHeight();
        const wgpu::TextureFormat format = texture.GetFormat();
        // Reusing the target keeps its lazily created coverage, clip and MSAA
        // attachments across frames.
        if (!m_renderTarget || m_renderTarget->width() != width ||
            m_renderTarget->height() != height || m_renderTarget->framebufferFormat() != format)
        {
            m_renderTarget = webgpuImpl(m_context.get())->makeRenderTarget(format, width, height);
        }
        // Render attachments must be single-level views; host textures (e.g.
        // Pixi's with autoGenerateMipmaps) may carry a mip chain.
        wgpu::TextureViewDescriptor viewDesc = {
            .format = format,
            .dimension = wgpu::TextureViewDimension::e2D,
            .baseMipLevel = 0,
            .mipLevelCount = 1,
            .baseArrayLayer = 0,
            .arrayLayerCount = 1,
        };
        m_renderTarget->setTargetTextureView(texture.CreateView(&viewDesc), texture);
    }

    // Releases the target texture and the attachments sized for it.
    void clearTargetTexture() { m_renderTarget = nullptr; }

    bool hasTargetTexture() const { return m_renderTarget != nullptr; }

    // Starts a frame. A zero msaaSampleCount lets Rive pick its interlock mode
    // (atomics on WebGPU when the device has the storage buffers for it).
    void beginFrame(bool clear, uint32_t clearColor, uint32_t msaaSampleCount)
    {
        RenderContext::FrameDescriptor frameDescriptor = {
            .renderTargetWidth = m_renderTarget->width(),
            .renderTargetHeight = m_renderTarget->height(),
            .loadAction = clear ? gpu::LoadAction::clear : gpu::LoadAction::preserveRenderTarget,
            .clearColor = clearColor,
            .msaaSampleCount = msaaSampleCount,
        };
        m_context->beginFrame(std::move(frameDescriptor));
    }

    // Encodes the frame into its own command buffer and submits it. Rive
    // uploads flush data with queue.writeBuffer() into 3-deep rings, so a
    // frame must reach the queue before a later one can overwrite its data;
    // submitting every flush guarantees that, and queue order guarantees a
    // host samples the finished texture.
    void flush()
    {
        RenderContextWebGPUImpl* impl = webgpuImpl(m_context.get());
        wgpu::CommandEncoder encoder = impl->device().CreateCommandEncoder();
        m_context->flush({
            .renderTarget = m_renderTarget.get(),
            .externalCommandBuffer = encoder.Get(),
        });
        wgpu::CommandBuffer commands = encoder.Finish();
        impl->queue().Submit(1, &commands);
    }

    // Saves the renderer state and clips to a rectangle in render-target
    // pixels (top-down), as the WebGL2 renderer does for atlas slots.
    void saveClipRect(float l, float t, float r, float b)
    {
        save();
        rcp<RenderPath> rect(m_context->makeEmptyRenderPath());
        rect->moveTo(l, t);
        rect->lineTo(r, t);
        rect->lineTo(r, b);
        rect->lineTo(l, b);
        rect->close();
        clipPath(rect.get());
    }

    void restoreClipRect() { restore(); }

    // Selects the material for subsequent artboard draws in this save scope.
    // Bounds are the material's extent in render-target pixels, matching the
    // align() frame; negative timeSeconds selects the static Gold variant.
    void setSurfaceMaterial(uint32_t value, float l, float t, float r, float b, float timeSeconds)
    {
        RiveRenderer::setSurfaceMaterial(surfaceMaterialFromValue(value),
                                         AABB(l, t, r, b),
                                         timeSeconds);
    }

private:
    std::shared_ptr<RenderContext> m_context;
    const uint32_t m_generation;
    rcp<RenderTargetWebGPU> m_renderTarget;
};

WebGPURenderer* makeWebGPURenderer()
{
    assert(s_renderContext && "initWebGPU() must run before makeRenderer()");
    return new WebGPURenderer(s_renderContext, s_generation);
}

// Wraps a JS GPUTexture (TEXTURE_BINDING usage, premultiplied, imported with
// WebGPU.importJsTexture) as a Rive image.
RenderImageWrapper* makeImageFromWebGPUTexture(uintptr_t textureHandle)
{
    auto texture = adoptHandle<wgpu::Texture, WGPUTexture>(textureHandle);
    const uint32_t width = texture.GetWidth();
    const uint32_t height = texture.GetHeight();
    auto image =
        make_rcp<RiveRenderImage>(make_rcp<TextureWebGPUImpl>(width, height, std::move(texture)));
    // JS owns this reference and releases it with unref().
    image->ref();
    return static_cast<RenderImageWrapper*>(static_cast<RenderImage*>(image.get()));
}

EMSCRIPTEN_BINDINGS(RiveWASM_WebGPU)
{
    class_<Renderer>("Renderer")
        .function("save", &Renderer::save)
        .function("restore", &Renderer::restore)
        .function("transform", &Renderer::transform, allow_raw_pointers())
        .function("modulateOpacity", &Renderer::modulateOpacity)
        .function("drawPath", &Renderer::drawPath, allow_raw_pointers())
        .function("clipPath", &Renderer::clipPath, allow_raw_pointers())
        .function("align",
                  optional_override([](Renderer& self,
                                       Fit fit,
                                       JsAlignment alignment,
                                       const AABB& frame,
                                       const AABB& content,
                                       const float scaleFactor = 1.0f) {
                      self.align(fit, convertAlignment(alignment), frame, content, scaleFactor);
                  }));
    class_<WebGPURenderer, base<Renderer>>("WebGPURenderer")
        .function("_generation", &WebGPURenderer::generation)
        .function("_setTargetTexture", &WebGPURenderer::setTargetTexture)
        .function("clearTargetTexture", &WebGPURenderer::clearTargetTexture)
        .function("_hasTargetTexture", &WebGPURenderer::hasTargetTexture)
        .function("_beginFrame", &WebGPURenderer::beginFrame)
        .function("_flush", &WebGPURenderer::flush)
        .function("saveClipRect", &WebGPURenderer::saveClipRect)
        .function("restoreClipRect", &WebGPURenderer::restoreClipRect)
        .function("setSurfaceMaterial", &WebGPURenderer::setSurfaceMaterial);
    class_<RenderImage>("RenderImage")
        .function("unref", &RenderImageWrapper::unref)
        .allow_subclass<RenderImageWrapper>("RenderImageWrapper");

    function("_initWebGPU", &initWebGPU);
    function("_makeWebGPURenderer", &makeWebGPURenderer, allow_raw_pointers());
    function("_makeImageFromWebGPUTexture", &makeImageFromWebGPUTexture, allow_raw_pointers());
}

#endif // RIVE_WEBGPU_RENDERER
