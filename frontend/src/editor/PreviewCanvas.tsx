import { useCallback, useEffect, useRef } from 'react'
import {
  type MaskRect,
  type TimelineData,
  type TimelineElement,
  type Transform,
} from '../api/client'
import { clipDuration, clipEnd } from './timeline'
import { applyChromaKey, resolveProps } from './effects'
import { ChromaKeyer } from './chromaGL'
import { formatTimecode } from './format'
import { PreviewEngine, type FrameCanvas } from './previewEngine'
import type { EditorMode } from './useEditor'

interface Props {
  data: TimelineData
  playhead: number
  playing: boolean
  duration: number
  mode: EditorMode
  selectedId: string | null
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
  livePlayhead: (t: number) => void
  subscribePlayhead: (cb: (t: number) => void) => () => void
  onSelectClip: (id: string | null) => void
  onTransform: (clipId: string, transform: Transform) => void
  onCrop: (clipId: string, crop: MaskRect | null) => void
  onAddText: (at: number, x: number, y: number) => void
}

const CANVAS_W = 1280
const CANVAS_H = 720
const HANDLE = 16 // half-size of a transform/crop handle, in canvas-internal px

// Displayed rectangle of a (possibly cropped) frame, in canvas-internal coords.
function displayedRect(
  fw: number,
  fh: number,
  scale: number,
  x: number,
  y: number,
  crop: MaskRect | null,
) {
  const cw = crop ? crop.w * fw : fw
  const ch = crop ? crop.h * fh : fh
  const sx = crop ? crop.x * fw : 0
  const sy = crop ? crop.y * fh : 0
  const fit = Math.min(CANVAS_W / cw, CANVAS_H / ch)
  const w = cw * fit * scale
  const h = ch * fit * scale
  const cx = CANVAS_W / 2 + x * CANVAS_W
  const cy = CANVAS_H / 2 + y * CANVAS_H
  return { cx, cy, w, h, cw, ch, sx, sy }
}

// Rotate a point into a rectangle's local (unrotated) frame.
function toLocal(px: number, py: number, cx: number, cy: number, rotDeg: number) {
  const a = (-rotDeg * Math.PI) / 180
  const dx = px - cx
  const dy = py - cy
  return { lx: dx * Math.cos(a) - dy * Math.sin(a), ly: dx * Math.sin(a) + dy * Math.cos(a) }
}

function drawHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color = '#4f8cff',
) {
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE)
  ctx.strokeRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE)
}

// Live pointer gesture on the canvas (transform or crop). `live` holds the
// in-progress value the compositor reads each frame; committed on pointer-up.
type Gesture =
  | {
      kind: 'move' | 'scale' | 'rotate'
      clipId: string
      cx: number
      cy: number
      startX: number
      startY: number
      startDist: number
      startAngle: number
      base: Transform
      live: { transform: Transform }
    }
  | {
      kind: 'crop'
      clipId: string
      edges: { l: boolean; r: boolean; t: boolean; b: boolean }
      move: boolean
      startFx: number
      startFy: number
      base: MaskRect
      live: { crop: MaskRect }
    }

/**
 * Real-time compositor. Frames come from the playback engine (WebCodecs decode
 * with a single Web Audio master clock — see previewEngine.ts), and this file
 * composites them onto the canvas: color grade, transform, opacity/fades,
 * green-screen key, mask, then text overlays. Black where no video is active.
 */
export function PreviewCanvas({
  data,
  playhead,
  playing,
  duration,
  mode,
  selectedId,
  setPlayhead,
  setPlaying,
  livePlayhead,
  subscribePlayhead,
  onSelectClip,
  onTransform,
  onCrop,
  onAddText,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const keyerRef = useRef<ChromaKeyer | null>(null)
  const keyerFailedRef = useRef(false)
  const timecodeRef = useRef<HTMLSpanElement>(null)
  const hudRef = useRef<HTMLDivElement>(null)

  // Live mode/selection + active pointer gesture, read by the draw loop.
  const modeRef = useRef(mode)
  const selectedIdRef = useRef(selectedId)
  const gestureRef = useRef<Gesture | null>(null)
  modeRef.current = mode
  selectedIdRef.current = selectedId

  // Live values the rAF loop / subscribers read without re-rendering.
  const dataRef = useRef(data)
  const playheadRef = useRef(playhead)
  const playingRef = useRef(playing)
  const durationRef = useRef(duration)
  dataRef.current = data
  playingRef.current = playing
  durationRef.current = duration
  // NB: playheadRef is intentionally not mirrored from the prop (see useEditor):
  // the live time lives here during playback/scrub; the prop only commits on
  // discrete events and would otherwise clobber it.

  const drawFrameRef = useRef<() => void>(() => {})
  const scrubRafRef = useRef<number | null>(null)
  const scrubTargetRef = useRef<number | null>(null)

  // ---- playback engine (created once) ------------------------------------
  const engineRef = useRef<PreviewEngine | null>(null)
  const onEndedRef = useRef<() => void>(() => {})
  onEndedRef.current = () => {
    setPlaying(false)
    setPlayhead(durationRef.current)
  }
  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new PreviewEngine(() => onEndedRef.current())
      engineRef.current.setTimeline(dataRef.current, durationRef.current)
    }
    return engineRef.current
  }, [])

  const getOffscreen = () => {
    if (!offscreenRef.current) offscreenRef.current = document.createElement('canvas')
    return offscreenRef.current
  }

  const getKeyer = (): ChromaKeyer | null => {
    if (keyerFailedRef.current) return null
    if (!keyerRef.current) {
      const k = new ChromaKeyer()
      if (!k.ok) {
        keyerFailedRef.current = true
        return null
      }
      keyerRef.current = k
    }
    return keyerRef.current
  }

  // Active clips at a time, across tracks (bottom track first for compositing).
  const activeAt = useCallback((t: number) => {
    const d = dataRef.current
    const videos: TimelineElement[] = []
    const texts: TimelineElement[] = []
    for (const track of [...d.tracks].reverse()) {
      for (const el of track.elements) {
        if (t >= el.timeline_start && t < clipEnd(el)) {
          if (track.kind === 'video') videos.push(el)
          else if (track.kind === 'text') texts.push(el)
        }
      }
    }
    return { videos, texts }
  }, [])

  const colorFilterOf = (el: TimelineElement) =>
    el.color
      ? `brightness(${el.color.brightness}) contrast(${el.color.contrast}) saturate(${el.color.saturation})`
      : 'none'

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const engine = getEngine()

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

    const t = playheadRef.current
    const curMode = modeRef.current
    const selId = selectedIdRef.current
    const gesture = gestureRef.current
    const { videos, texts } = activeAt(t)

    for (const el of videos) {
      const frame: FrameCanvas | null = engine.frameFor(el)
      if (!frame || !frame.width || !frame.height) continue
      const dur = clipDuration(el)
      const lt = t - el.timeline_start
      const p = resolveProps(el, lt, dur)
      if (p.opacity <= 0.001) continue

      // Live gesture override for the clip currently being edited on-canvas.
      const g = gesture && gesture.clipId === el.id ? gesture : null
      const gt = g && g.kind !== 'crop' ? g.live.transform : null
      const scale = gt ? gt.scale : p.scale
      const x = gt ? gt.x : p.x
      const y = gt ? gt.y : p.y
      const rotation = gt ? gt.rotation : p.rotation
      const gcrop = g && g.kind === 'crop' ? g.live.crop : el.crop ?? null
      // While cropping the selected clip, show the whole frame so the user can
      // drag the crop box against the full picture.
      const cropForDraw = curMode === 'crop' && el.id === selId ? null : gcrop

      const r = displayedRect(frame.width, frame.height, scale, x, y, cropForDraw)

      ctx.save()
      if (el.mask) {
        ctx.beginPath()
        ctx.rect(
          el.mask.x * CANVAS_W,
          el.mask.y * CANVAS_H,
          el.mask.w * CANVAS_W,
          el.mask.h * CANVAS_H,
        )
        ctx.clip()
      }
      ctx.globalAlpha = p.opacity
      ctx.translate(r.cx, r.cy)
      if (rotation) ctx.rotate((rotation * Math.PI) / 180)
      if (el.flipH || el.flipV) ctx.scale(el.flipH ? -1 : 1, el.flipV ? -1 : 1)

      if (el.chroma?.enabled) {
        const c = el.color
        const keyed = getKeyer()?.render(frame, frame.width, frame.height, {
          color: el.chroma.color,
          similarity: el.chroma.similarity,
          smoothness: el.chroma.smoothness,
          brightness: c?.brightness ?? 1,
          contrast: c?.contrast ?? 1,
          saturation: c?.saturation ?? 1,
        })
        if (keyed) {
          ctx.drawImage(keyed, -r.w / 2, -r.h / 2, r.w, r.h)
        } else {
          // CPU fallback (no WebGL): read back pixels and key on the main thread.
          const off = getOffscreen()
          const dw = Math.max(1, Math.round(Math.min(frame.width, 960)))
          const dh = Math.max(1, Math.round((dw * frame.height) / frame.width))
          off.width = dw
          off.height = dh
          const octx = off.getContext('2d', { willReadFrequently: true })
          if (octx) {
            octx.clearRect(0, 0, dw, dh)
            octx.filter = colorFilterOf(el)
            octx.drawImage(frame, 0, 0, dw, dh)
            octx.filter = 'none'
            try {
              const img = octx.getImageData(0, 0, dw, dh)
              applyChromaKey(img, el.chroma.color, el.chroma.similarity, el.chroma.smoothness)
              octx.putImageData(img, 0, 0)
            } catch {
              /* not ready */
            }
            ctx.drawImage(off, -r.w / 2, -r.h / 2, r.w, r.h)
          }
        }
      } else {
        ctx.filter = colorFilterOf(el)
        ctx.drawImage(frame, r.sx, r.sy, r.cw, r.ch, -r.w / 2, -r.h / 2, r.w, r.h)
        ctx.filter = 'none'
      }
      ctx.restore()
    }

    // Text overlays.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    for (const el of texts) {
      if (!el.text) continue
      const dur = clipDuration(el)
      const lt = t - el.timeline_start
      const p = resolveProps(el, lt, dur)
      if (p.opacity <= 0.001) continue

      ctx.save()
      ctx.globalAlpha = p.opacity
      const cx = CANVAS_W / 2 + p.x * CANVAS_W
      const cy = CANVAS_H - 70 + p.y * CANVAS_H
      ctx.translate(cx, cy)
      if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180)
      const fontSize = Math.max(8, Math.round(52 * p.scale))
      ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.lineWidth = 6
      ctx.strokeStyle = 'rgba(0,0,0,0.75)'
      ctx.fillStyle = '#fff'
      ctx.strokeText(el.text, 0, 0)
      ctx.fillText(el.text, 0, 0)
      ctx.restore()
    }

    // ---- Mode-reflected selection overlay (transform / crop handles) ----
    if ((curMode === 'transform' || curMode === 'crop') && selId) {
      const el = videos.find((v) => v.id === selId)
      const frame = el ? engine.frameFor(el) : null
      if (el && frame && frame.width && frame.height) {
        const dur = clipDuration(el)
        const lt = t - el.timeline_start
        const p = resolveProps(el, lt, dur)
        const g = gesture && gesture.clipId === el.id ? gesture : null
        const gt = g && g.kind !== 'crop' ? g.live.transform : null
        const scale = gt ? gt.scale : p.scale
        const x = gt ? gt.x : p.x
        const y = gt ? gt.y : p.y
        const rotation = gt ? gt.rotation : p.rotation

        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalAlpha = 1
        ctx.filter = 'none'

        if (curMode === 'transform') {
          const rr = displayedRect(frame.width, frame.height, scale, x, y, el.crop ?? null)
          ctx.save()
          ctx.translate(rr.cx, rr.cy)
          ctx.rotate((rotation * Math.PI) / 180)
          ctx.strokeStyle = '#4f8cff'
          ctx.lineWidth = 2
          ctx.strokeRect(-rr.w / 2, -rr.h / 2, rr.w, rr.h)
          ctx.beginPath()
          ctx.moveTo(0, -rr.h / 2)
          ctx.lineTo(0, -rr.h / 2 - 40)
          ctx.stroke()
          drawHandle(ctx, 0, -rr.h / 2 - 40)
          const corners: [number, number][] = [
            [-rr.w / 2, -rr.h / 2],
            [rr.w / 2, -rr.h / 2],
            [rr.w / 2, rr.h / 2],
            [-rr.w / 2, rr.h / 2],
          ]
          for (const [hx, hy] of corners) drawHandle(ctx, hx, hy)
          ctx.restore()
        } else {
          const gcrop = g && g.kind === 'crop' ? g.live.crop : el.crop ?? { x: 0, y: 0, w: 1, h: 1 }
          const full = displayedRect(frame.width, frame.height, scale, x, y, null)
          const left = full.cx - full.w / 2
          const top = full.cy - full.h / 2
          const rx = left + gcrop.x * full.w
          const ry = top + gcrop.y * full.h
          const rw = gcrop.w * full.w
          const rh = gcrop.h * full.h
          ctx.save()
          ctx.fillStyle = 'rgba(0,0,0,0.5)'
          ctx.fillRect(left, top, full.w, ry - top)
          ctx.fillRect(left, ry + rh, full.w, top + full.h - (ry + rh))
          ctx.fillRect(left, ry, rx - left, rh)
          ctx.fillRect(rx + rw, ry, left + full.w - (rx + rw), rh)
          ctx.strokeStyle = '#ffd24a'
          ctx.lineWidth = 2
          ctx.strokeRect(rx, ry, rw, rh)
          const pts: [number, number][] = [
            [rx, ry],
            [rx + rw / 2, ry],
            [rx + rw, ry],
            [rx + rw, ry + rh / 2],
            [rx + rw, ry + rh],
            [rx + rw / 2, ry + rh],
            [rx, ry + rh],
            [rx, ry + rh / 2],
          ]
          for (const [hx, hy] of pts) drawHandle(ctx, hx, hy, '#ffd24a')
          ctx.restore()
        }
      }
    }
  }, [activeAt, getEngine])

  drawFrameRef.current = drawFrame

  // ---- On-canvas interactions (mode-dependent) ---------------------------
  const canvasToInternal = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    return {
      ix: (clientX - rect.left) * (CANVAS_W / rect.width),
      iy: (clientY - rect.top) * (CANVAS_H / rect.height),
    }
  }

  // Top-most active video clip whose displayed rect contains the point.
  const hitTopVideo = (ix: number, iy: number): TimelineElement | null => {
    const engine = getEngine()
    const t = playheadRef.current
    const { videos } = activeAt(t)
    for (let i = videos.length - 1; i >= 0; i--) {
      const el = videos[i]
      const frame = engine.frameFor(el)
      if (!frame || !frame.width) continue
      const p = resolveProps(el, t - el.timeline_start, clipDuration(el))
      const rr = displayedRect(frame.width, frame.height, p.scale, p.x, p.y, el.crop ?? null)
      const loc = toLocal(ix, iy, rr.cx, rr.cy, p.rotation)
      if (Math.abs(loc.lx) <= rr.w / 2 && Math.abs(loc.ly) <= rr.h / 2) return el
    }
    return null
  }

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    const pt = canvasToInternal(e.clientX, e.clientY)
    if (!pt) return
    const { ix, iy } = pt
    const m = modeRef.current
    const t = playheadRef.current
    const engine = getEngine()

    if (m === 'text') {
      onAddText(t, (ix - CANVAS_W / 2) / CANVAS_W, (iy - (CANVAS_H - 70)) / CANVAS_H)
      return
    }
    if (m === 'select') {
      const el = hitTopVideo(ix, iy)
      onSelectClip(el ? el.id : null)
      return
    }
    if (m !== 'transform' && m !== 'crop') return

    const selId = selectedIdRef.current
    if (!selId) return
    const active = activeAt(t).videos.find((v) => v.id === selId)
    if (!active) return
    const frame = engine.frameFor(active)
    if (!frame || !frame.width) return
    const p = resolveProps(active, t - active.timeline_start, clipDuration(active))
    const baseT: Transform = { scale: p.scale, x: p.x, y: p.y, rotation: p.rotation }

    if (m === 'transform') {
      const rr = displayedRect(frame.width, frame.height, baseT.scale, baseT.x, baseT.y, active.crop ?? null)
      const loc = toLocal(ix, iy, rr.cx, rr.cy, baseT.rotation)
      const onCorner =
        Math.abs(Math.abs(loc.lx) - rr.w / 2) <= HANDLE &&
        Math.abs(Math.abs(loc.ly) - rr.h / 2) <= HANDLE
      const onRotate = Math.hypot(loc.lx, loc.ly - (-rr.h / 2 - 40)) <= HANDLE
      const inside = Math.abs(loc.lx) <= rr.w / 2 && Math.abs(loc.ly) <= rr.h / 2
      const kind: 'move' | 'scale' | 'rotate' = onRotate
        ? 'rotate'
        : onCorner
          ? 'scale'
          : inside
            ? 'move'
            : 'move'
      if (!onRotate && !onCorner && !inside) return
      gestureRef.current = {
        kind,
        clipId: selId,
        cx: rr.cx,
        cy: rr.cy,
        startX: ix,
        startY: iy,
        startDist: Math.hypot(ix - rr.cx, iy - rr.cy),
        startAngle: Math.atan2(iy - rr.cy, ix - rr.cx),
        base: baseT,
        live: { transform: { ...baseT } },
      }
    } else {
      const full = displayedRect(frame.width, frame.height, baseT.scale, baseT.x, baseT.y, null)
      const baseCrop: MaskRect = active.crop ?? { x: 0, y: 0, w: 1, h: 1 }
      const left = full.cx - full.w / 2
      const top = full.cy - full.h / 2
      const fx = (ix - left) / full.w
      const fy = (iy - top) / full.h
      const thrX = HANDLE / full.w
      const thrY = HANDLE / full.h
      const edges = {
        l: Math.abs(fx - baseCrop.x) <= thrX,
        r: Math.abs(fx - (baseCrop.x + baseCrop.w)) <= thrX,
        t: Math.abs(fy - baseCrop.y) <= thrY,
        b: Math.abs(fy - (baseCrop.y + baseCrop.h)) <= thrY,
      }
      const inside =
        fx > baseCrop.x && fx < baseCrop.x + baseCrop.w && fy > baseCrop.y && fy < baseCrop.y + baseCrop.h
      const anyEdge = edges.l || edges.r || edges.t || edges.b
      if (!anyEdge && !inside) return
      gestureRef.current = {
        kind: 'crop',
        clipId: selId,
        edges,
        move: !anyEdge && inside,
        startFx: fx,
        startFy: fy,
        base: baseCrop,
        live: { crop: { ...baseCrop } },
      }
    }

    const move = (ev: PointerEvent) => {
      const g = gestureRef.current
      if (!g) return
      const q = canvasToInternal(ev.clientX, ev.clientY)
      if (!q) return
      if (g.kind === 'move') {
        g.live.transform = {
          ...g.base,
          x: g.base.x + (q.ix - g.startX) / CANVAS_W,
          y: g.base.y + (q.iy - g.startY) / CANVAS_H,
        }
      } else if (g.kind === 'scale') {
        const d = Math.hypot(q.ix - g.cx, q.iy - g.cy)
        const factor = g.startDist > 1 ? d / g.startDist : 1
        g.live.transform = {
          ...g.base,
          scale: Math.max(0.05, Math.min(8, g.base.scale * factor)),
        }
      } else if (g.kind === 'rotate') {
        const ang = Math.atan2(q.iy - g.cy, q.ix - g.cx)
        const deg = ((ang - g.startAngle) * 180) / Math.PI
        g.live.transform = { ...g.base, rotation: Math.round(g.base.rotation + deg) }
      } else if (g.kind === 'crop') {
        const engine2 = getEngine()
        const active2 = activeAt(playheadRef.current).videos.find((v) => v.id === g.clipId)
        const frame2 = active2 ? engine2.frameFor(active2) : null
        if (!active2 || !frame2 || !frame2.width) return
        const pp = resolveProps(active2, playheadRef.current - active2.timeline_start, clipDuration(active2))
        const full = displayedRect(frame2.width, frame2.height, pp.scale, pp.x, pp.y, null)
        const left = full.cx - full.w / 2
        const top = full.cy - full.h / 2
        const fx = Math.max(0, Math.min(1, (q.ix - left) / full.w))
        const fy = Math.max(0, Math.min(1, (q.iy - top) / full.h))
        let x0 = g.base.x
        let y0 = g.base.y
        let x1 = g.base.x + g.base.w
        let y1 = g.base.y + g.base.h
        if (g.move) {
          const dx = fx - g.startFx
          const dy = fy - g.startFy
          x0 = Math.max(0, Math.min(1 - g.base.w, g.base.x + dx))
          y0 = Math.max(0, Math.min(1 - g.base.h, g.base.y + dy))
          x1 = x0 + g.base.w
          y1 = y0 + g.base.h
        } else {
          if (g.edges.l) x0 = Math.min(fx, x1 - 0.05)
          if (g.edges.r) x1 = Math.max(fx, x0 + 0.05)
          if (g.edges.t) y0 = Math.min(fy, y1 - 0.05)
          if (g.edges.b) y1 = Math.max(fy, y0 + 0.05)
          x0 = Math.max(0, x0)
          y0 = Math.max(0, y0)
          x1 = Math.min(1, x1)
          y1 = Math.min(1, y1)
        }
        g.live.crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      }
      drawFrameRef.current()
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const g = gestureRef.current
      gestureRef.current = null
      if (g) {
        if (g.kind === 'crop') {
          const c = g.live.crop
          const full = c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999
          onCrop(g.clipId, full ? null : c)
        } else {
          onTransform(g.clipId, g.live.transform)
        }
      }
      drawFrameRef.current()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    drawFrameRef.current()
  }

  // Keep the engine's timeline in sync; redraw the current frame when the
  // timeline (an edit) changes while paused.
  useEffect(() => {
    const engine = getEngine()
    engine.setTimeline(data, duration)
    // Warm all sources so playback doesn't stall on cold (uncached) media.
    engine.prepareAll()
    if (!playingRef.current) {
      void engine.seekTo(playheadRef.current).then(() => drawFrameRef.current())
    }
  }, [data, duration, getEngine])

  // Scrub channel: while paused, point the engine at the latest target and
  // redraw. Coalesced to one seek+draw per animation frame.
  useEffect(() => {
    const write = (t: number) => {
      playheadRef.current = t
      if (timecodeRef.current) {
        timecodeRef.current.textContent = `${formatTimecode(t)} / ${formatTimecode(durationRef.current)}`
      }
      if (playingRef.current) return
      scrubTargetRef.current = t
      if (scrubRafRef.current == null) {
        scrubRafRef.current = requestAnimationFrame(() => {
          scrubRafRef.current = null
          const tt = scrubTargetRef.current
          if (tt != null && !playingRef.current) {
            void getEngine()
              .seekTo(tt)
              .then(() => drawFrameRef.current())
          }
        })
      }
    }
    return subscribePlayhead(write)
  }, [subscribePlayhead, getEngine])

  // Playback: start the master clock + a rAF that reads it and composites.
  useEffect(() => {
    const engine = getEngine()
    if (!playing) {
      engine.pause()
      setPlayhead(engine.currentTime())
      return
    }
    engine.play(playheadRef.current)
    let raf = 0
    const step = () => {
      if (!playingRef.current) return
      const t = engine.currentTime()
      playheadRef.current = t
      livePlayhead(t)
      drawFrameRef.current()
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  // Redraw when the mode or selection changes so the overlay handles
  // appear/disappear immediately while paused.
  useEffect(() => {
    if (!playingRef.current) drawFrameRef.current()
  }, [mode, selectedId])

  // Diagnostics HUD (~4x/sec) sourced from the engine — no React render.
  useEffect(() => {
    const id = window.setInterval(() => {
      const el = hudRef.current
      if (!el || !engineRef.current) return
      el.textContent = engineRef.current.stats().join('\n')
    }, 250)
    return () => window.clearInterval(id)
  }, [])

  // Prime the engine + first frame on mount.
  useEffect(() => {
    const engine = getEngine()
    engine.setTimeline(dataRef.current, durationRef.current)
    void engine.seekTo(playheadRef.current).then(() => drawFrameRef.current())
    return () => {
      if (scrubRafRef.current != null) cancelAnimationFrame(scrubRafRef.current)
      engine.dispose()
      engineRef.current = null
    }
  }, [getEngine])

  const togglePlay = () => {
    if (playhead >= duration - 0.02) setPlayhead(0)
    setPlaying(!playing)
  }

  return (
    <div className="preview-compositor">
      <div className="canvas-wrap">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className={`stage-canvas mode-${mode}`}
          onPointerDown={onCanvasPointerDown}
        />
        <div ref={hudRef} className="preview-hud" />
      </div>
      <div className="transport">
        <button className="btn small" onClick={togglePlay}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn small" onClick={() => { setPlaying(false); setPlayhead(0) }}>
          ⏮ Start
        </button>
        <span className="timecode" ref={timecodeRef}>
          {formatTimecode(playhead)} / {formatTimecode(duration)}
        </span>
      </div>
    </div>
  )
}
