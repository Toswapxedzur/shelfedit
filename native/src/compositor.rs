//! GPU preview compositor. Runs a custom `wgpu` render pass *inside* the egui
//! frame (via an `egui_wgpu` paint callback) so the preview shows the real
//! composited result: per-clip transform, crop, flip, opacity, color grade,
//! green-screen (chroma key) and rectangular mask — and multiple video layers
//! stacked in track order.
//!
//! The heavy pixel work lives in `preview.wgsl`. Each layer is one draw call
//! with its own texture + a small uniform describing its quad + effects.

use std::sync::Arc;

use eframe::egui::PaintCallbackInfo;
use eframe::egui_wgpu::{self, CallbackTrait};
use eframe::wgpu;

/// One layer to draw, as handed over from the UI thread (owned / 'static).
pub struct LayerInput {
    pub rgba: Arc<Vec<u8>>,
    pub w: u32,
    pub h: u32,
    /// Quad corners in egui *points* (TL, TR, BR, BL).
    pub corners: [[f32; 2]; 4],
    /// Texture uv per corner (already crop- and flip-mapped).
    pub uv: [[f32; 2]; 4],
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub opacity: f32,
    pub chroma_enabled: bool,
    pub chroma_rgb: [f32; 3],
    pub similarity: f32,
    pub smoothness: f32,
    pub mask_enabled: bool,
    pub mask: [f32; 4], // x, y, w, h in quad-local 0..1
}

#[repr(C)]
#[derive(Clone, Copy)]
struct LayerUniform {
    pos01: [f32; 4],
    pos23: [f32; 4],
    uv01: [f32; 4],
    uv23: [f32; 4],
    grade: [f32; 4], // brightness, contrast, saturation, opacity
    key: [f32; 4],   // r, g, b, chroma_enabled
    keyp: [f32; 4],  // similarity, smoothness, mask_enabled, _
    mask: [f32; 4],  // x, y, w, h
}

struct Slot {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    size: (u32, u32),
    ubuf: wgpu::Buffer,
    bind: wgpu::BindGroup,
}

/// Long-lived GPU resources; stored in egui's `callback_resources`.
pub struct CompositorGpu {
    pipeline: wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    slots: Vec<Slot>,
    active: usize,
}

impl CompositorGpu {
    pub fn new(device: &wgpu::Device, target_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("preview.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("preview.wgsl").into()),
        });

        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("preview-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("preview-pl"),
            bind_group_layouts: &[&bind_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("preview-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs",
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs",
                targets: &[Some(wgpu::ColorTargetState {
                    format: target_format,
                    // Premultiplied alpha (matches egui's own blend).
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("preview-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self {
            pipeline,
            bind_layout,
            sampler,
            slots: Vec::new(),
            active: 0,
        }
    }

    fn ensure_slot(&mut self, device: &wgpu::Device, i: usize, w: u32, h: u32) {
        let needs_tex = match self.slots.get(i) {
            Some(s) => s.size != (w, h),
            None => true,
        };
        if needs_tex {
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("preview-layer"),
                size: wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            let ubuf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("preview-ubuf"),
                size: std::mem::size_of::<LayerUniform>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("preview-bind"),
                layout: &self.bind_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: ubuf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                ],
            });
            let slot = Slot {
                tex,
                view,
                size: (w, h),
                ubuf,
                bind,
            };
            if i < self.slots.len() {
                self.slots[i] = slot;
            } else {
                self.slots.push(slot);
            }
        }
    }
}

/// The per-frame callback: owns the layer inputs to render.
pub struct PreviewCallback {
    pub layers: Vec<LayerInput>,
}

impl CallbackTrait for PreviewCallback {
    fn prepare(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        screen: &egui_wgpu::ScreenDescriptor,
        _encoder: &mut wgpu::CommandEncoder,
        resources: &mut egui_wgpu::CallbackResources,
    ) -> Vec<wgpu::CommandBuffer> {
        let Some(gpu) = resources.get_mut::<CompositorGpu>() else {
            return Vec::new();
        };
        let ppp = screen.pixels_per_point;
        let sw = screen.size_in_pixels[0] as f32;
        let sh = screen.size_in_pixels[1] as f32;
        let to_ndc = |p: [f32; 2]| -> [f32; 2] {
            [2.0 * (p[0] * ppp) / sw - 1.0, 1.0 - 2.0 * (p[1] * ppp) / sh]
        };

        gpu.active = self.layers.len();
        for (i, layer) in self.layers.iter().enumerate() {
            gpu.ensure_slot(device, i, layer.w, layer.h);
            let slot = &gpu.slots[i];

            // Upload pixels.
            queue.write_texture(
                wgpu::ImageCopyTexture {
                    texture: &slot.tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &layer.rgba,
                wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(layer.w * 4),
                    rows_per_image: Some(layer.h),
                },
                wgpu::Extent3d {
                    width: layer.w,
                    height: layer.h,
                    depth_or_array_layers: 1,
                },
            );

            let c = layer.corners;
            let uv = layer.uv;
            let n0 = to_ndc(c[0]);
            let n1 = to_ndc(c[1]);
            let n2 = to_ndc(c[2]);
            let n3 = to_ndc(c[3]);
            let u = LayerUniform {
                pos01: [n0[0], n0[1], n1[0], n1[1]],
                pos23: [n2[0], n2[1], n3[0], n3[1]],
                uv01: [uv[0][0], uv[0][1], uv[1][0], uv[1][1]],
                uv23: [uv[2][0], uv[2][1], uv[3][0], uv[3][1]],
                grade: [layer.brightness, layer.contrast, layer.saturation, layer.opacity],
                key: [
                    layer.chroma_rgb[0],
                    layer.chroma_rgb[1],
                    layer.chroma_rgb[2],
                    if layer.chroma_enabled { 1.0 } else { 0.0 },
                ],
                keyp: [
                    layer.similarity,
                    layer.smoothness,
                    if layer.mask_enabled { 1.0 } else { 0.0 },
                    0.0,
                ],
                mask: layer.mask,
            };
            queue.write_buffer(&slot.ubuf, 0, cast_uniform(&u));
        }
        Vec::new()
    }

    fn paint(
        &self,
        _info: PaintCallbackInfo,
        render_pass: &mut wgpu::RenderPass<'static>,
        resources: &egui_wgpu::CallbackResources,
    ) {
        let Some(gpu) = resources.get::<CompositorGpu>() else {
            return;
        };
        render_pass.set_pipeline(&gpu.pipeline);
        for i in 0..self.layers.len().min(gpu.slots.len()).min(gpu.active) {
            render_pass.set_bind_group(0, &gpu.slots[i].bind, &[]);
            render_pass.draw(0..6, 0..1);
        }
    }
}

fn cast_uniform(u: &LayerUniform) -> &[u8] {
    // Safe: LayerUniform is #[repr(C)] and made entirely of f32 (no padding,
    // no pointers), so its bytes are a valid, initialized POD blob.
    unsafe {
        std::slice::from_raw_parts(
            (u as *const LayerUniform) as *const u8,
            std::mem::size_of::<LayerUniform>(),
        )
    }
}
