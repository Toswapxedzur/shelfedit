import { useCallback, useEffect, useRef } from 'react'
import { api, type TimelineData, type TimelineElement } from '../api/client'
import { clipEnd } from './timeline'
import { formatTimecode } from './format'

interface Props {
  data: TimelineData
  playhead: number
  playing: boolean
  duration: number
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
}

const CANVAS_W = 1280
const CANVAS_H = 720

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
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videosRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const poolRef = useRef<HTMLDivElement>(null)

  // Refs mirror props so the rAF loop always sees fresh values.
  const dataRef = useRef(data)
  const playheadRef = useRef(playhead)
  const playingRef = useRef(playing)
  const durationRef = useRef(duration)
  dataRef.current = data
  playheadRef.current = playhead
  playingRef.current = playing
  durationRef.current = duration

  const getVideo = useCallback((mediaId: string): HTMLVideoElement => {
    let v = videosRef.current.get(mediaId)
    if (!v) {
      v = document.createElement('video')
      v.src = api.mediaFileUrl(mediaId)
      v.preload = 'auto'
      v.crossOrigin = 'anonymous'
      v.muted = true
      v.playsInline = true
      poolRef.current?.appendChild(v)
      videosRef.current.set(mediaId, v)
    }
    return v
  }, [])

  // The active video / text clips at a given time, across tracks (bottom→top).
  const activeAt = useCallback((t: number) => {
    const d = dataRef.current
    const videos: { track: (typeof d.tracks)[number]; el: TimelineElement }[] = []
    const texts: TimelineElement[] = []
    // tracks are ordered top→bottom in the array; draw video bottom-first.
    for (const track of [...d.tracks].reverse()) {
      for (const el of track.elements) {
        if (t >= el.timeline_start && t < clipEnd(el)) {
          if (track.kind === 'video') videos.push({ track, el })
          else if (track.kind === 'text') texts.push(el)
        }
      }
    }
    return { videos, texts }
  }, [])

  const sourceTime = (el: TimelineElement, t: number) =>
    (el.source_start ?? 0) + (t - el.timeline_start)

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.filter = 'none'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

    const { videos, texts } = activeAt(playheadRef.current)

    for (const { el } of videos) {
      const v = videosRef.current.get(el.media_id as string)
      if (!v || v.readyState < 2 || !v.videoWidth) continue
      const c = el.color
      ctx.filter = c
        ? `brightness(${c.brightness}) contrast(${c.contrast}) saturate(${c.saturation})`
        : 'none'
      // contain (letterbox) into the canvas.
      const scale = Math.min(CANVAS_W / v.videoWidth, CANVAS_H / v.videoHeight)
      const w = v.videoWidth * scale
      const h = v.videoHeight * scale
      ctx.drawImage(v, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h)
      ctx.filter = 'none'
    }

    for (const el of texts) {
      if (!el.text) continue
      ctx.font = '600 52px Inter, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.lineWidth = 6
      ctx.strokeStyle = 'rgba(0,0,0,0.75)'
      ctx.fillStyle = '#fff'
      const x = CANVAS_W / 2
      const y = CANVAS_H - 70
      ctx.strokeText(el.text, x, y)
      ctx.fillText(el.text, x, y)
    }
  }, [activeAt])

  // Paused scrubbing: seek active videos to the frame and redraw when ready.
  const seekAndDraw = useCallback(
    (t: number) => {
      const { videos } = activeAt(t)
      const activeIds = new Set(videos.map((x) => x.el.media_id))
      for (const [id, v] of videosRef.current) {
        if (!activeIds.has(id)) {
          if (!v.paused) v.pause()
        }
      }
      for (const { el } of videos) {
        const v = getVideo(el.media_id as string)
        v.pause()
        v.muted = true
        const st = sourceTime(el, t)
        if (Math.abs(v.currentTime - st) > 0.05) {
          const onSeeked = () => {
            v.removeEventListener('seeked', onSeeked)
            if (!playingRef.current) drawFrame()
          }
          v.addEventListener('seeked', onSeeked)
          try {
            v.currentTime = st
          } catch {
            /* not ready yet */
          }
        }
      }
      drawFrame()
    },
    [activeAt, drawFrame, getVideo],
  )

  // Playback loop.
  useEffect(() => {
    if (!playing) {
      for (const v of videosRef.current.values()) if (!v.paused) v.pause()
      return
    }
    let raf = 0
    let last: number | null = null

    const syncForPlayback = (t: number) => {
      const { videos } = activeAt(t)
      const activeIds = new Set(videos.map((x) => x.el.media_id))
      for (const [id, v] of videosRef.current) {
        if (!activeIds.has(id) && !v.paused) v.pause()
      }
      let audioAssigned = false
      for (const { track, el } of videos) {
        const v = getVideo(el.media_id as string)
        const st = sourceTime(el, t)
        if (Math.abs(v.currentTime - st) > 0.3) {
          try {
            v.currentTime = st
          } catch {
            /* ignore */
          }
        }
        // First active video track with sound provides audio.
        const wantAudio = !audioAssigned && !track.muted
        v.muted = !wantAudio
        if (wantAudio) audioAssigned = true
        if (v.paused) v.play().catch(() => {})
      }
    }

    const step = (ts: number) => {
      if (!playingRef.current) return
      if (last == null) last = ts
      const dt = (ts - last) / 1000
      last = ts
      let t = playheadRef.current + dt
      if (t >= durationRef.current) {
        t = durationRef.current
        playheadRef.current = t
        setPlayhead(t)
        setPlaying(false)
        for (const v of videosRef.current.values()) v.pause()
        drawFrame()
        return
      }
      playheadRef.current = t
      setPlayhead(t)
      syncForPlayback(t)
      drawFrame()
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  // Redraw when paused and the playhead or timeline changes.
  useEffect(() => {
    if (!playing) seekAndDraw(playhead)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, playing, data])

  // Clean up video elements on unmount.
  useEffect(() => {
    const videos = videosRef.current
    return () => {
      for (const v of videos.values()) {
        v.pause()
        v.src = ''
      }
      videos.clear()
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
        <span className="timecode">
          {formatTimecode(playhead)} / {formatTimecode(duration)}
        </span>
      </div>
    </div>
  )
}
