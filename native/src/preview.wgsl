// Preview compositor shader. One draw call per layer; a small uniform carries
// the quad (in NDC), texture uvs (crop/flip already applied), and the effect
// parameters. Output is premultiplied alpha to match egui's blend state.

struct Layer {
    pos01: vec4<f32>, // corner0.xy, corner1.xy   (NDC)
    pos23: vec4<f32>, // corner2.xy, corner3.xy
    uv01:  vec4<f32>, // corner0.uv, corner1.uv
    uv23:  vec4<f32>, // corner2.uv, corner3.uv
    grade: vec4<f32>, // brightness, contrast, saturation, opacity
    key:   vec4<f32>, // key r, g, b, chroma_enabled
    keyp:  vec4<f32>, // similarity, smoothness, mask_enabled, _
    mask:  vec4<f32>, // x, y, w, h  (quad-local 0..1)
};

@group(0) @binding(0) var<uniform> L: Layer;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) local: vec2<f32>, // 0..1 across the quad, for masking
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
    var idx = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
    let i = idx[vi];
    var corner: vec2<f32>;
    var uv: vec2<f32>;
    var local: vec2<f32>;
    if (i == 0u) { corner = L.pos01.xy; uv = L.uv01.xy; local = vec2<f32>(0.0, 0.0); }
    else if (i == 1u) { corner = L.pos01.zw; uv = L.uv01.zw; local = vec2<f32>(1.0, 0.0); }
    else if (i == 2u) { corner = L.pos23.xy; uv = L.uv23.xy; local = vec2<f32>(1.0, 1.0); }
    else { corner = L.pos23.zw; uv = L.uv23.zw; local = vec2<f32>(0.0, 1.0); }
    var o: VOut;
    o.pos = vec4<f32>(corner, 0.0, 1.0);
    o.uv = uv;
    o.local = local;
    return o;
}

fn luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
    var col = textureSample(tex, samp, in.uv);
    var rgb = col.rgb;
    var a = col.a;

    // Chroma key (green screen): drop alpha near the key colour.
    if (L.key.w > 0.5) {
        let d = distance(rgb, L.key.xyz);
        let s = L.keyp.x * 1.7320508;
        let f = max(L.keyp.y * 1.7320508, 0.001);
        if (d < s) {
            a = 0.0;
        } else if (d < s + f) {
            a = a * ((d - s) / f);
        }
    }

    // Colour grade: brightness, contrast, saturation.
    rgb = rgb * L.grade.x;
    rgb = (rgb - vec3<f32>(0.5)) * L.grade.y + vec3<f32>(0.5);
    let l = luma(rgb);
    rgb = mix(vec3<f32>(l), rgb, L.grade.z);
    rgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));

    // Rectangular reveal mask (quad-local space).
    if (L.keyp.z > 0.5) {
        let m = L.mask;
        if (in.local.x < m.x || in.local.x > m.x + m.z ||
            in.local.y < m.y || in.local.y > m.y + m.w) {
            a = 0.0;
        }
    }

    a = a * L.grade.w; // opacity + fades
    return vec4<f32>(rgb * a, a);
}
