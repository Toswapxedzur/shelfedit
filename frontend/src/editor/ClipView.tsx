import { useEffect, useRef, useState } from 'react'
import { api, type TimelineElement, type TimelineTrack } from '../api/client'
import { clipDuration, moveClip, trimEnd, trimStart } from './timeline'
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

  const drag = useRef<{
    mode: DragMode
    base: import('../api/client').TimelineData
    startX: number
    baseStart: number
    baseEnd: number
  } | null>(null)

  const beginDrag = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    editor.setSelectedId(el.id)
    const base = editor.snapshot()
    if (!base) return
    drag.current = {
      mode,
      base,
      startX: e.clientX,
      baseStart: el.timeline_start,
      baseEnd: el.timeline_start + clipDuration(el),
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) / pxPerSec
    if (d.mode === 'move') {
      editor.preview(moveClip(d.base, el.id, d.baseStart + dx))
    } else if (d.mode === 'trim-start') {
      editor.preview(trimStart(d.base, el.id, d.baseStart + dx))
    } else {
      editor.preview(trimEnd(d.base, el.id, d.baseEnd + dx, sourceMax))
    }
  }

  const onUp = () => {
    const d = drag.current
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (d) editor.finalizeDrag(d.base)
    drag.current = null
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
