import { useEffect, useRef, useState } from 'react'
import { api, type TimelineElement, type TimelineTrack } from '../api/client'
import { MIN_CLIP, clipDuration, moveClip, trimEnd, trimStart } from './timeline'
import { formatClipDuration } from './format'
import type { EditorState } from './useEditor'

interface Props {
  el: TimelineElement
  track: TimelineTrack
  pxPerSec: number
  selected: boolean
  sourceMax?: number
  label: string
  editor: EditorState
}

type DragMode = 'move' | 'trim-start' | 'trim-end'

export function ClipView({
  el,
  track,
  pxPerSec,
  selected,
  sourceMax,
  label,
  editor,
}: Props) {
  const left = el.timeline_start * pxPerSec
  const width = Math.max(8, clipDuration(el) * pxPerSec)

  // The clip's own DOM node, so a drag can move it live via CSS without writing
  // to React state (which would deep-clone the whole timeline, re-render every
  // clip, and re-seek the preview video on every mouse tick). The timeline data
  // is only committed once, on pointer-up.
  const rootRef = useRef<HTMLDivElement>(null)

  const drag = useRef<{
    mode: DragMode
    startX: number
    baseStart: number
    baseDur: number
    baseEnd: number
    lastStart: number
    lastEnd: number
  } | null>(null)

  const applyGeometry = (startS: number, endS: number) => {
    const node = rootRef.current
    if (!node) return
    node.style.left = `${startS * pxPerSec}px`
    node.style.width = `${Math.max(8, (endS - startS) * pxPerSec)}px`
  }

  const beginDrag = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    editor.setSelectedId(el.id)
    const baseStart = el.timeline_start
    const baseDur = clipDuration(el)
    drag.current = {
      mode,
      startX: e.clientX,
      baseStart,
      baseDur,
      baseEnd: baseStart + baseDur,
      lastStart: baseStart,
      lastEnd: baseStart + baseDur,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) / pxPerSec
    if (d.mode === 'move') {
      const s = Math.max(0, d.baseStart + dx)
      d.lastStart = s
      d.lastEnd = s + d.baseDur
    } else if (d.mode === 'trim-start') {
      const s = Math.min(Math.max(0, d.baseStart + dx), d.baseEnd - MIN_CLIP)
      d.lastStart = s
      d.lastEnd = d.baseEnd
    } else {
      d.lastStart = d.baseStart
      d.lastEnd = Math.max(d.baseStart + MIN_CLIP, d.baseEnd + dx)
    }
    applyGeometry(d.lastStart, d.lastEnd)
  }

  const onUp = () => {
    const d = drag.current
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    drag.current = null
    if (!d) return
    // Commit once. React re-renders with the new left/width from props, which
    // supersedes the inline styles set during the drag.
    if (d.mode === 'move' && d.lastStart !== d.baseStart) {
      editor.commit((data) => moveClip(data, el.id, d.lastStart))
    } else if (d.mode === 'trim-start' && d.lastStart !== d.baseStart) {
      editor.commit((data) => trimStart(data, el.id, d.lastStart))
    } else if (d.mode === 'trim-end' && d.lastEnd !== d.baseEnd) {
      editor.commit((data) => trimEnd(data, el.id, d.lastEnd, sourceMax))
    }
  }

  const editText = () => {
    if (track.kind !== 'text') return
    const next = window.prompt('Text', el.text ?? '')
    if (next != null) editor.commit((data) => {
      const clone = JSON.parse(JSON.stringify(data))
      for (const t of clone.tracks) {
        const found = t.elements.find((x: TimelineElement) => x.id === el.id)
        if (found) found.text = next
      }
      return clone
    })
  }

  const bg =
    track.kind === 'video' && el.media_id
      ? { backgroundImage: `url(${api.mediaFilmstripUrl(el.media_id)})` }
      : undefined

  return (
    <div
      ref={rootRef}
      className={`clip kind-${track.kind} ${selected ? 'selected' : ''}`}
      style={{ left, width }}
      onPointerDown={beginDrag('move')}
      onDoubleClick={editText}
      title={label}
    >
      {bg && <div className="clip-film" style={bg} />}
      {track.kind === 'audio' && el.media_id && (
        <Waveform mediaId={el.media_id} width={width} />
      )}
      <div className="clip-overlay">
        <span className="clip-label">
          {track.kind === 'text' ? el.text || 'Text' : label}
        </span>
        <span className="clip-dur">{formatClipDuration(clipDuration(el))}</span>
      </div>
      <div className="handle left" onPointerDown={beginDrag('trim-start')} />
      <div className="handle right" onPointerDown={beginDrag('trim-end')} />
    </div>
  )
}

// Audio waveform drawn from backend peaks.
function Waveform({ mediaId, width }: { mediaId: string; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getWaveform(mediaId)
      .then((r) => {
        if (!cancelled) setPeaks(r.peaks)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mediaId])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks || peaks.length === 0) return
    const w = Math.max(1, Math.floor(width))
    const h = canvas.height
    canvas.width = w
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    const mid = h / 2
    for (let x = 0; x < w; x++) {
      const p = peaks[Math.floor((x / w) * peaks.length)] ?? 0
      const bar = Math.max(1, p * (h - 2))
      ctx.fillRect(x, mid - bar / 2, 1, bar)
    }
  }, [peaks, width])

  return <canvas ref={canvasRef} className="clip-wave" height={48} />
}
