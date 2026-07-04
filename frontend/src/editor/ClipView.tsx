import { useEffect, useRef, useState } from 'react'
import { api, type TimelineElement, type TimelineTrack } from '../api/client'
import {
  MIN_CLIP,
  clipDuration,
  kindCompatible,
  linkedIds,
  moveClipGroup,
  rangeOverlaps,
  trimEnd,
  trimStart,
} from './timeline'
import { formatClipDuration } from './format'
import type { EditorState } from './useEditor'

interface Props {
  el: TimelineElement
  track: TimelineTrack
  pxPerSec: number
  selected: boolean
  linked: boolean
  sourceMax?: number
  label: string
  editor: EditorState
  // Which track lane sits under a screen-Y coordinate (for 2D cross-track drag).
  resolveTrackAt: (clientY: number) => TimelineTrack | null
}

type DragMode = 'move' | 'trim-start' | 'trim-end'

export function ClipView({
  el,
  track,
  pxPerSec,
  selected,
  linked,
  sourceMax,
  label,
  editor,
  resolveTrackAt,
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
    startY: number
    baseStart: number
    baseDur: number
    baseEnd: number
    lastStart: number
    lastEnd: number
    dropTrackId: string
    valid: boolean
  } | null>(null)

  const applyGeometry = (startS: number, endS: number) => {
    const node = rootRef.current
    if (!node) return
    node.style.left = `${startS * pxPerSec}px`
    node.style.width = `${Math.max(8, (endS - startS) * pxPerSec)}px`
  }

  // Times to snap to: 0, the playhead, and every other clip edge on this track.
  const snapCandidates = (): number[] => {
    const cands = [0, editor.playheadRef.current]
    for (const other of track.elements) {
      if (other.id === el.id) continue
      cands.push(other.timeline_start, other.timeline_start + clipDuration(other))
    }
    return cands
  }

  const beginDrag = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // A locked track's clips can't be moved, trimmed, or split.
    if (track.locked) {
      editor.setSelectedId(el.id)
      return
    }

    // Blade mode: clicking the clip body splits it at the pointer.
    if (mode === 'move' && editor.mode === 'blade') {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect) {
        const at = el.timeline_start + (e.clientX - rect.left) / pxPerSec
        editor.run({ type: 'split', clipId: el.id, at })
      }
      return
    }

    // Shift/Cmd click toggles multi-selection (no drag).
    if (mode === 'move' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      editor.toggleSelected(el.id)
      return
    }

    editor.setSelectedId(el.id)
    const baseStart = el.timeline_start
    const baseDur = clipDuration(el)
    drag.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      baseStart,
      baseDur,
      baseEnd: baseStart + baseDur,
      lastStart: baseStart,
      lastEnd: baseStart + baseDur,
      dropTrackId: track.id,
      valid: true,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) / pxPerSec
    const thr = 8 / pxPerSec
    const snapping = editor.snapping
    if (d.mode === 'move') {
      let s = Math.max(0, d.baseStart + dx)
      if (snapping) {
        const end = s + d.baseDur
        let adj = 0
        let bestD = thr
        for (const c of snapCandidates()) {
          const ds = c - s
          if (Math.abs(ds) < bestD) {
            bestD = Math.abs(ds)
            adj = ds
          }
          const de = c - end
          if (Math.abs(de) < bestD) {
            bestD = Math.abs(de)
            adj = de
          }
        }
        s = Math.max(0, s + adj)
      }
      d.lastStart = s
      d.lastEnd = s + d.baseDur

      // 2D: follow the cursor vertically and resolve the target track under it.
      const node = rootRef.current
      const target = resolveTrackAt(e.clientY)
      d.dropTrackId = target ? target.id : track.id
      const exclude = new Set(editor.data ? linkedIds(editor.data, el.id) : [el.id])
      const compatible = target ? kindCompatible(el.type, target.kind) : false
      const clashes =
        target &&
        rangeOverlaps(target, d.lastStart, d.lastStart + d.baseDur, exclude)
      d.valid = !!target && compatible && !clashes && !target.locked
      if (node) {
        node.style.transform = `translateY(${e.clientY - d.startY}px)`
        node.classList.add('dragging')
        node.classList.toggle('invalid', !d.valid)
      }
    } else if (d.mode === 'trim-start') {
      let s = Math.min(Math.max(0, d.baseStart + dx), d.baseEnd - MIN_CLIP)
      if (snapping) {
        for (const c of snapCandidates()) {
          if (Math.abs(c - s) < thr && c < d.baseEnd - MIN_CLIP) {
            s = Math.max(0, c)
            break
          }
        }
      }
      d.lastStart = s
      d.lastEnd = d.baseEnd
    } else {
      let end = Math.max(d.baseStart + MIN_CLIP, d.baseEnd + dx)
      if (snapping) {
        for (const c of snapCandidates()) {
          if (Math.abs(c - end) < thr && c > d.baseStart + MIN_CLIP) {
            end = c
            break
          }
        }
      }
      d.lastStart = d.baseStart
      d.lastEnd = end
    }
    applyGeometry(d.lastStart, d.lastEnd)
  }

  const onUp = () => {
    const d = drag.current
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    drag.current = null
    if (!d) return
    const node = rootRef.current
    if (node) {
      node.style.transform = ''
      node.classList.remove('dragging', 'invalid')
    }
    // Commit once. React re-renders with the new left/width from props, which
    // supersedes the inline styles set during the drag.
    if (d.mode === 'move') {
      const changedTrack = d.valid && d.dropTrackId !== track.id
      const changedTime = d.lastStart !== d.baseStart
      if (d.valid && (changedTrack || changedTime)) {
        editor.commit((data) =>
          moveClipGroup(data, el.id, d.lastStart, changedTrack ? d.dropTrackId : undefined),
        )
      } else {
        // Invalid drop / no change → snap back by restoring geometry from props.
        applyGeometry(d.baseStart, d.baseEnd)
      }
    } else if (d.mode === 'trim-start' && d.lastStart !== d.baseStart) {
      editor.commit((data) => trimStart(data, el.id, d.lastStart))
    } else if (d.mode === 'trim-end' && d.lastEnd !== d.baseEnd) {
      editor.commit((data) => trimEnd(data, el.id, d.lastEnd, sourceMax))
    }
  }

  const editText = () => {
    if (track.kind !== 'text' || track.locked) return
    const next = window.prompt('Text', el.text ?? '')
    if (next != null)
      editor.commit((data) => {
        const clone = JSON.parse(JSON.stringify(data))
        for (const t of clone.tracks) {
          const found = t.elements.find((x: TimelineElement) => x.id === el.id)
          if (found) found.text = next
        }
        return clone
      })
  }

  // Video filmstrip: pin frames to real source time so trimming/stretching the
  // clip never stretches the picture — the whole source maps to a fixed
  // pixels-per-second, and we show the [source_start, source_end] window of it.
  const srcStart = el.source_start ?? 0
  const srcTotal = sourceMax ?? el.source_end ?? clipDuration(el)
  const filmStyle =
    track.kind === 'video' && el.media_id
      ? {
          backgroundImage: `url(${api.mediaFilmstripUrl(el.media_id)})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${Math.max(1, srcTotal * pxPerSec)}px 100%`,
          backgroundPositionX: `-${srcStart * pxPerSec}px`,
        }
      : undefined

  return (
    <div
      ref={rootRef}
      className={`clip kind-${track.kind} ${selected ? 'selected' : ''} ${linked ? 'linked' : ''} ${track.locked ? 'locked' : ''} ${editor.mode === 'blade' ? 'blade' : ''}`}
      style={{ left, width }}
      onPointerDown={beginDrag('move')}
      onDoubleClick={editText}
      title={label}
    >
      {filmStyle && <div className="clip-film" style={filmStyle} />}
      {track.kind === 'audio' && el.media_id && (
        <Waveform
          mediaId={el.media_id}
          clipWidth={width}
          pxPerSec={pxPerSec}
          sourceStart={srcStart}
          sourceDuration={srcTotal}
        />
      )}
      <div className="clip-overlay">
        <span className="clip-label">
          {track.kind === 'text' ? el.text || 'Text' : label}
        </span>
        <span className="clip-dur">{formatClipDuration(clipDuration(el))}</span>
      </div>
      {!track.locked && (
        <>
          <div className="handle left" onPointerDown={beginDrag('trim-start')} />
          <div className="handle right" onPointerDown={beginDrag('trim-end')} />
        </>
      )}
    </div>
  )
}

// Audio waveform: discrete vertical strips whose horizontal density is fixed in
// real time (bars per second), so stretching a clip never stretches the bars.
function Waveform({
  mediaId,
  clipWidth,
  pxPerSec,
  sourceStart,
  sourceDuration,
}: {
  mediaId: string
  clipWidth: number
  pxPerSec: number
  sourceStart: number
  sourceDuration: number
}) {
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
    if (!canvas || !peaks || peaks.length === 0 || sourceDuration <= 0) return
    const w = Math.max(1, Math.floor(clipWidth))
    const h = canvas.height
    canvas.width = w
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    const mid = h / 2
    const STEP = 3 // px between bars — a constant on-screen density
    const barW = 2
    for (let x = 0; x < w; x += STEP) {
      // Map this pixel to a real source time, then to a peak bucket. Because
      // the mapping uses pxPerSec (not the clip width), the bars stay put.
      const srcT = sourceStart + x / pxPerSec
      const idx = Math.floor((srcT / sourceDuration) * peaks.length)
      const p = peaks[idx] ?? 0
      const bar = Math.max(1, p * (h - 2))
      ctx.fillRect(x, mid - bar / 2, barW, bar)
    }
  }, [peaks, clipWidth, pxPerSec, sourceStart, sourceDuration])

  return <canvas ref={canvasRef} className="clip-wave" height={48} />
}
