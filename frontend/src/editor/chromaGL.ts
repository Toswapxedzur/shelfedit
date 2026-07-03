// GPU green-screen (chroma key) keyer.
//
// The old path copied every pixel of the frame from the GPU to JS, ran a
// per-pixel distance test on the CPU, then wrote it back — which stalled the
// main thread ~60x/sec during playback and made the whole editor lag. This
// does the exact same keying + color grade in a fragment shader on the GPU
// and hands back a canvas the 2D compositor can draw directly.
//
// The key math and color-grade order match the CPU version (see
// `applyChromaKey` + `colorFilterOf`) so results look identical.

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) / 2.0;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_key;       // key color, normalized 0..1
uniform float u_sim;      // similarity 0..1
uniform float u_smooth;   // smoothness 0..1
uniform float u_bright;
uniform float u_contrast;
uniform float u_sat;

void main() {
  vec4 c = texture2D(u_tex, v_uv);
  vec3 rgb = c.rgb;

  // Color grade, same order as the CSS filter: brightness, contrast, saturate.
  rgb *= u_bright;
  rgb = (rgb - 0.5) * u_contrast + 0.5;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(luma), rgb, u_sat);

  // Chroma key: euclidean distance in normalized space, maxDist = sqrt(3).
  float dist = distance(clamp(rgb, 0.0, 1.0), u_key);
  float s = u_sim * 1.7320508;
  float feather = max(1.0 / 255.0, u_smooth * 1.7320508);
  float alpha = clamp((dist - s) / feather, 0.0, 1.0);

  gl_FragColor = vec4(rgb, c.a * alpha);
}
`

export interface ChromaOpts {
  color: string
  similarity: number
  smoothness: number
  brightness: number
  contrast: number
  saturation: number
}

const MAX_DIM = 1280

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  const n = parseInt(full, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

export class ChromaKeyer {
  readonly ok: boolean = false
  private canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext | null = null
  private tex: WebGLTexture | null = null
  private loc: Record<string, WebGLUniformLocation | null> = {}

  constructor() {
    this.canvas = document.createElement('canvas')
    const gl = (this.canvas.getContext('webgl', {
      premultipliedAlpha: false,
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    }) ||
      this.canvas.getContext('experimental-webgl', {
        premultipliedAlpha: false,
        alpha: true,
      })) as WebGLRenderingContext | null
    if (!gl) return
    this.gl = gl

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return
    const prog = gl.createProgram()
    if (!prog) return
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
    gl.useProgram(prog)

    // Full-screen quad.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const aPos = gl.getAttribLocation(prog, 'a_pos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    for (const name of ['u_key', 'u_sim', 'u_smooth', 'u_bright', 'u_contrast', 'u_sat']) {
      this.loc[name] = gl.getUniformLocation(prog, name)
    }

    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    gl.disable(gl.BLEND)
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;(this as { ok: boolean }).ok = true
  }

  // Render the keyed frame; returns a canvas the caller can drawImage(). Null if
  // WebGL is unavailable or the source isn't ready.
  render(video: HTMLVideoElement, opts: ChromaOpts): HTMLCanvasElement | null {
    const gl = this.gl
    if (!gl || !this.ok) return null
    let w = video.videoWidth
    let h = video.videoHeight
    if (!w || !h) return null
    if (Math.max(w, h) > MAX_DIM) {
      const s = MAX_DIM / Math.max(w, h)
      w = Math.round(w * s)
      h = Math.round(h * s)
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      gl.viewport(0, 0, w, h)
    }

    try {
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    } catch {
      return null
    }

    const [kr, kg, kb] = hexToRgb01(opts.color)
    gl.uniform3f(this.loc.u_key, kr, kg, kb)
    gl.uniform1f(this.loc.u_sim, opts.similarity)
    gl.uniform1f(this.loc.u_smooth, opts.smoothness)
    gl.uniform1f(this.loc.u_bright, opts.brightness)
    gl.uniform1f(this.loc.u_contrast, opts.contrast)
    gl.uniform1f(this.loc.u_sat, opts.saturation)

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    return this.canvas
  }
}
