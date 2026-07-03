import { useCallback, useEffect, useRef } from 'react'
import { api, type TimelineData, type TimelineElement } from '../api/client'
import { clipDuration, clipEnd } from './timeline'
import { applyChromaKey, resolveAudioGain, resolveProps } from './effects'
import { ChromaKeyer } from './chromaGL'
import { formatTimecode } from './format'

interface Props {
  data: TimelineData
  playhead: number
  playing: boolean
  duration: number
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
  livePlayhead: (t: number) => void
  subscribePlayhead: (cb: (t: number) => void) => () => void
}

const CANVAS_W = 1280
const CANVAS_H = 720

// requestVideoFrameCallback fires exactly when the decoder presents a new frame
// (the web-standard way to keep a canvas in sync with a <video>). We use it to
// refresh each source's frame buffer; where it's unavailable the compositor
// falls back to blitting whenever the element is ready.
const RVFC_SUPPORTED =
  typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype

/**
 * Real-time compositor. Instead of playing a single file, it computes the frame
 * for the current playhead time from the timeline: it seeks the active video
 * clip's source, draws it (with color grade), then paints active text overlays
 * on top. Black when no video clip is active.
 */
export function PreviewCanvas({
  data,
  playhead,
  playing,
  duration,
  setPlayhead,
  setPlaying,
  livePlayhead,
  subscribePlayhead,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Media elements are keyed by `${kind}:${mediaId}` so the same source file can
  // back BOTH a silent video-frame element (video track) and an independent
  // audible element (audio track). Video and audio are strictly split: video
  // track elements are always muted; sound comes only from the audio track.
  const mediaRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const poolRef = useRef<HTMLDivElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const keyerRef = useRef<ChromaKeyer | null>(null)
  const keyerFailedRef = useRef(false)
  const timecodeRef = useRef<HTMLSpanElement>(null)
  // Stable handle to the latest drawFrame (used by video-load/seek listeners).
  const drawFrameRef = useRef<() => void>(() => {})
  // Scrub coalescing: at most one seek+draw per animation frame no matter how
  // fast pointer events arrive.
  const scrubRafRef = useRef<number | null>(null)
  const scrubTargetRef = useRef<number | null>(null)
  // Per-source frame buffers (double buffering). Each video source blits its
  // most recently *presented* frame into its own canvas here; the compositor
  // always draws FROM these buffers. So when a decoder momentarily has no frame
  // ready, we redraw the previous one instead of flashing black — the standard
  // flicker-free pattern for canvas video compositing.
  const frameBufRef = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const bufPaintedRef = useRef<Set<string>>(new Set())
  const rvfcHandleRef = useRef<Map<string, number>>(new Map())

  const getOffscreen = () => {
    if (!offscreenRef.current) offscreenRef.current = document.createElement('canvas')
    return offscreenRef.current
  }

  // GPU keyer, created lazily. If WebGL isn't available we fall back to the CPU
  // pixel loop below so green screen still works, just slower.
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

  // Refs mirror props so the rAF loop always sees fresh values.
  const dataRef = useRef(data)
  const playheadRef = useRef(playhead)
  const playingRef = useRef(playing)
  const durationRef = useRef(duration)
  dataRef.current = data
  playingRef.current = playing
  durationRef.current = duration
  // NB: playheadRef is deliberately NOT mirrored from the prop here. During
  // playback / scrubbing the live time lives in this ref (updated by the step
  // loop and the playhead subscription); the `playhead` prop is only committed
  // on discrete events and lags on purpose. Mirroring it every render would
  // clobber the live value with the stale prop — e.g. pausing would snap the
  // playhead back to wherever the last commit was (0).

  const elKey = (mediaId: string, kind: 'video' | 'audio') => `${kind}:${mediaId}`

  // Copy a video element's current frame into its retained buffer (native res).
  // Returns the buffer, or null if the element has no frame yet.
  const blitToBuf = useCallback((key: string, v: HTMLVideoElement): HTMLCanvasElement | null => {
    const w = v.videoWidth
    const h = v.videoHeight
    if (!w || !h) return null
    let b = frameBufRef.current.get(key)
    if (!b) {
      b = document.createElement('canvas')
      frameBufRef.current.set(key, b)
    }
    if (b.width !== w || b.height !== h) {
      b.width = w
      b.height = h
    }
    const c = b.getContext('2d')
    if (!c) return null
    c.drawImage(v, 0, 0, w, h)
    bufPaintedRef.current.add(key)
    return b
  }, [])

  // The frame to composite for a source: its retained buffer. Kept fresh from
  // requestVideoFrameCallback during playback; here we also blit on demand when
  // paused/seeking (or when rVFC is unavailable). Returns null only when the
  // source has never produced a frame (initial load) — the one time black is ok.
  const frameSource = useCallback(
    (key: string, v: HTMLVideoElement | undefined): HTMLCanvasElement | null => {
      const canBlit = !!v && v.readyState >= 2 && !!v.videoWidth
      if (canBlit && (!RVFC_SUPPORTED || !playingRef.current)) blitToBuf(key, v!)
      const b = frameBufRef.current.get(key)
      if (b && bufPaintedRef.current.has(key)) return b
      if (canBlit) return blitToBuf(key, v!)
      return null
    },
    [blitToBuf],
  )

  const getEl = useCallback(
    (mediaId: string, kind: 'video' | 'audio'): HTMLVideoElement => {
      const key = elKey(mediaId, kind)
      let v = mediaRef.current.get(key)
      if (!v) {
        v = document.createElement('video')
        v.src = api.mediaFileUrl(mediaId)
        v.preload = 'auto'
        v.crossOrigin = 'anonymous'
        v.muted = true // audio-kind elements are unmuted during playback
        v.playsInline = true
        // When a seek lands (during scrubbing) redraw the accurate frame. Cheap,
        // and it means seekAndDraw doesn't have to attach/remove listeners per call.
        v.addEventListener('seeked', () => {
          if (!playingRef.current) drawFrameRef.current()
        })
        v.addEventListener('loadeddata', () => {
          if (!playingRef.current) drawFrameRef.current()
        })
        poolRef.current?.appendChild(v)
        mediaRef.current.set(key, v)
        // Frame-accurate buffer refresh: only video-kind elements provide frames.
        if (kind === 'video' && RVFC_SUPPORTED) {
          const vid = v
          const paint = () => {
            blitToBuf(key, vid)
            rvfcHandleRef.current.set(key, vid.requestVideoFrameCallback(paint))
          }
          rvfcHandleRef.current.set(key, vid.requestVideoFrameCallback(paint))
        }
      }
      return v
    },
    [blitToBuf],
  )

  // The active clips at a given time, across tracks (bottom→top). Video track
  // clips provide frames; audio track clips provide sound; text clips overlay.
  const activeAt = useCallback((t: number) => {
    const d = dataRef.current
    const videos: { track: (typeof d.tracks)[number]; el: TimelineElement }[] = []
    const audios: { track: (typeof d.tracks)[number]; el: TimelineElement }[] = []
    const texts: TimelineElement[] = []
    // tracks are ordered top→bottom in the array; draw video bottom-first.
    for (const track of [...d.tracks].reverse()) {
      for (const el of track.elements) {
        if (t >= el.timeline_start && t < clipEnd(el)) {
          if (track.kind === 'video') videos.push({ track, el })
          else if (track.kind === 'audio') audios.push({ track, el })
          else if (track.kind === 'text') texts.push(el)
        }
      }
    }
    return { videos, audios, texts }
  }, [])

  const sourceTime = (el: TimelineElement, t: number) =>
    (el.source_start ?? 0) + (t - el.timeline_start)

  const colorFilterOf = (el: TimelineElement) =>
    el.color
      ? `brightness(${el.color.brightness}) contrast(${el.color.contrast}) saturate(${el.color.saturation})`
      : 'none'

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

    const t = playheadRef.current
    const { videos, texts } = activeAt(t)

    // Video layers, bottom track first so upper (e.g. keyed) clips composite over.
    // We draw each layer from its retained frame buffer, never straight from the
    // <video>: if a decoder momentarily has no frame ready the buffer still holds
    // the previous frame, so the layer never flashes black.
    for (const { el } of videos) {
      const key = elKey(el.media_id as string, 'video')
      const src = frameSource(key, mediaRef.current.get(key))
      if (!src) continue
      const sw = src.width
      const sh = src.height
      if (!sw || !sh) continue
      const dur = clipDuration(el)
      const lt = t - el.timeline_start
      const p = resolveProps(el, lt, dur)
      if (p.opacity <= 0.001) continue

      const fit = Math.min(CANVAS_W / sw, CANVAS_H / sh)
      const w = sw * fit * p.scale
      const h = sh * fit * p.scale
      const cx = CANVAS_W / 2 + p.x * CANVAS_W
      const cy = CANVAS_H / 2 + p.y * CANVAS_H

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
      ctx.translate(cx, cy)
      if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180)

      if (el.chroma?.enabled) {
        // Key on the GPU, then composite so the layer below shows through.
        const c = el.color
        const keyed = getKeyer()?.render(src, {
          color: el.chroma.color,
          similarity: el.chroma.similarity,
          smoothness: el.chroma.smoothness,
          brightness: c?.brightness ?? 1,
          contrast: c?.contrast ?? 1,
          saturation: c?.saturation ?? 1,
        })
        if (keyed) {
          ctx.drawImage(keyed, -w / 2, -h / 2, w, h)
        } else {
          // CPU fallback (no WebGL): read back pixels and key on the main thread.
          const off = getOffscreen()
          const dw = Math.max(1, Math.round(Math.min(sw, 960)))
          const dh = Math.max(1, Math.round((dw * sh) / sw))
          off.width = dw
          off.height = dh
          const octx = off.getContext('2d', { willReadFrequently: true })
          if (octx) {
            octx.clearRect(0, 0, dw, dh)
            octx.filter = colorFilterOf(el)
            octx.drawImage(src, 0, 0, dw, dh)
            octx.filter = 'none'
            try {
              const img = octx.getImageData(0, 0, dw, dh)
              applyChromaKey(
                img,
                el.chroma.color,
                el.chroma.similarity,
                el.chroma.smoothness,
              )
              octx.putImageData(img, 0, 0)
            } catch {
              /* cross-origin or not ready */
            }
            ctx.drawImage(off, -w / 2, -h / 2, w, h)
          }
        }
      } else {
        ctx.filter = colorFilterOf(el)
        ctx.drawImage(src, -w / 2, -h / 2, w, h)
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
  }, [activeAt, frameSource])

  drawFrameRef.current = drawFrame

  // Paused scrubbing: point active videos at the frame and draw immediately.
  // Requesting the seek is enough — the persistent 'seeked' listener redraws
  // the accurate frame when it lands, and the browser coalesces rapid
  // currentTime writes into a single pending seek, so this can't pile up.
  const seekAndDraw = useCallback(
    (t: number) => {
      const { videos } = activeAt(t)
      // While paused/scrubbing, only the active video-frame elements matter;
      // pause everything else (including all audio elements — no sound on scrub).
      const activeKeys = new Set(videos.map((x) => elKey(x.el.media_id as string, 'video')))
      for (const [key, v] of mediaRef.current) {
        if (!activeKeys.has(key) && !v.paused) v.pause()
      }
      for (const { el } of videos) {
        const v = getEl(el.media_id as string, 'video')
        if (!v.paused) v.pause()
        v.muted = true
        const st = sourceTime(el, t)
        if (Math.abs(v.currentTime - st) > 0.04) {
          try {
            v.currentTime = st
          } catch {
            /* not ready yet */
          }
        }
      }
      drawFrame()
    },
    [activeAt, drawFrame, getEl],
  )

  // Live playhead channel: keep the timecode + (when paused) the frame in sync
  // without any React re-render. The compositor draws from `playheadRef`, so we
  // set it here too before drawing.
  useEffect(() => {
    const write = (t: number) => {
      playheadRef.current = t
      if (timecodeRef.current) {
        timecodeRef.current.textContent = `${formatTimecode(t)} / ${formatTimecode(durationRef.current)}`
      }
      if (playingRef.current) return
      // Coalesce: many pointer events per frame collapse into a single seek+draw
      // on the next frame, aimed at the latest position.
      scrubTargetRef.current = t
      if (scrubRafRef.current == null) {
        scrubRafRef.current = requestAnimationFrame(() => {
          scrubRafRef.current = null
          const tt = scrubTargetRef.current
          if (tt != null && !playingRef.current) seekAndDraw(tt)
        })
      }
    }
    return subscribePlayhead(write)
  }, [subscribePlayhead, seekAndDraw])

  // Playback loop.
  useEffect(() => {
    if (!playing) {
      for (const v of mediaRef.current.values()) if (!v.paused) v.pause()
      // Commit the live time so discrete UI (split / inspector) stays correct.
      setPlayhead(playheadRef.current)
      return
    }
    let raf = 0
    let last: number | null = null
    let lastPrimaryId: string | null = null

    // Drive playback: video-frame elements play muted (frames only); audio-track
    // elements carry the sound (independently mute/volume-controllable). Returns
    // the element whose clock drives the playhead ("primary") — the first active
    // audio element if any (audio-led sync), else the first active video. Any
    // element is seeked only when it's (re)activating, never continuously, so it
    // can't get stuck chasing a moving target.
    const syncForPlayback = (t: number): { el: TimelineElement; v: HTMLVideoElement } | null => {
      const { videos, audios } = activeAt(t)
      const activeKeys = new Set<string>([
        ...videos.map((x) => elKey(x.el.media_id as string, 'video')),
        ...audios.map((x) => elKey(x.el.media_id as string, 'audio')),
      ])
      for (const [key, v] of mediaRef.current) {
        if (!activeKeys.has(key) && !v.paused) v.pause()
      }

      const activate = (v: HTMLVideoElement, st: number) => {
        if (v.paused) {
          if (Math.abs(v.currentTime - st) > 0.15) {
            try {
              v.currentTime = st
            } catch {
              /* not ready yet */
            }
          }
          v.play().catch(() => {})
        }
      }

      // Video track: frames only, always silent.
      for (const { el } of videos) {
        const v = getEl(el.media_id as string, 'video')
        v.muted = true
        const st = sourceTime(el, t)
        activate(v, st)
        // Gentle frame realignment to the (audio-led) timeline; rare, and it
        // seeks a muted element so there's never an audible glitch.
        if (!v.paused && !v.seeking && Math.abs(v.currentTime - st) > 0.35) {
          try {
            v.currentTime = st
          } catch {
            /* ignore */
          }
        }
      }

      // Audio track: the actual sound. Respects per-track mute + per-clip volume.
      let primary: { el: TimelineElement; v: HTMLVideoElement } | null = null
      for (const { track, el } of audios) {
        const v = getEl(el.media_id as string, 'audio')
        const st = sourceTime(el, t)
        const dur = clipDuration(el)
        const lt = t - el.timeline_start
        v.muted = !!track.muted
        v.volume = resolveAudioGain(el, lt, dur) * (track.volume ?? 1)
        activate(v, st)
        if (!primary) primary = { el, v }
      }
      // No audio active? Slave the clock to the first active (muted) video.
      if (!primary && videos.length) {
        const { el } = videos[0]
        primary = { el, v: getEl(el.media_id as string, 'video') }
      }
      return primary
    }

    const step = (ts: number) => {
      if (!playingRef.current) return
      if (last == null) last = ts
      let dt = (ts - last) / 1000
      last = ts
      // Cap dt so a throttled frame (window blurred, GC, etc.) can't teleport
      // the playhead; any real catch-up is handled by the resync below.
      if (dt > 0.25) dt = 0.25

      const prev = playheadRef.current
      const primary = syncForPlayback(prev)

      // Genlock: advance the playhead by wall-clock time each frame so it moves
      // smoothly at the full redraw rate, then gently ease it toward the primary
      // video's real time so the frame, audio and playhead stay locked without
      // the visible stepping you'd get by snapping straight to currentTime
      // (which the browser only updates a few times per second). Big gaps (a
      // stall recovering, or a fresh clip taking over) are snapped instead of
      // eased. Wall-clock alone is used only across black gaps (no video).
      let t = prev + dt
      const ready = primary && primary.v.readyState >= 2 && !primary.v.seeking
      if (primary && ready) {
        const vt =
          primary.el.timeline_start +
          (primary.v.currentTime - (primary.el.source_start ?? 0))
        if (isFinite(vt)) {
          if (primary.el.media_id !== lastPrimaryId || Math.abs(t - vt) > 0.4) {
            t = vt
          } else {
            t += (vt - t) * 0.15
          }
        }
      } else if (primary) {
        // Activating / buffering: hold so we don't drift ahead of a stalled
        // video (whose audio is stalled too, keeping everything in sync).
        t = prev
      }
      lastPrimaryId = primary ? (primary.el.media_id as string) : null

      if (t >= durationRef.current) {
        t = durationRef.current
        playheadRef.current = t
        setPlaying(false)
        setPlayhead(t)
        for (const v of mediaRef.current.values()) v.pause()
        drawFrame()
        return
      }
      playheadRef.current = t
      // Live update: moves the playhead line + timecode with no React render.
      livePlayhead(t)
      drawFrame()
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  // Redraw the current frame when the timeline changes while paused (edits).
  useEffect(() => {
    if (!playingRef.current) seekAndDraw(playheadRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Clean up video elements on unmount.
  useEffect(() => {
    const els = mediaRef.current
    const handles = rvfcHandleRef.current
    const bufs = frameBufRef.current
    const painted = bufPaintedRef.current
    return () => {
      if (scrubRafRef.current != null) cancelAnimationFrame(scrubRafRef.current)
      for (const [key, v] of els) {
        const h = handles.get(key)
        if (h != null && typeof v.cancelVideoFrameCallback === 'function') {
          try {
            v.cancelVideoFrameCallback(h)
          } catch {
            /* ignore */
          }
        }
        v.pause()
        v.src = ''
      }
      els.clear()
      handles.clear()
      bufs.clear()
      painted.clear()
    }
  }, [])

  const togglePlay = () => {
    if (playhead >= duration - 0.02) setPlayhead(0)
    setPlaying(!playing)
  }

  return (
    <div className="preview-compositor">
      <div className="canvas-wrap">
        <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} />
      </div>
      <div ref={poolRef} className="video-pool" />
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
