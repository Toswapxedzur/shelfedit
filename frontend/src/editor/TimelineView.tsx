import { useRef } from 'react'
import type { MediaAsset } from '../api/client'
import { ClipView } from './ClipView'
import { TimelineToolbar } from './TimelineToolbar'
import { formatTimecode } from './format'
import {
  addClip,
  clipDuration,
  deleteClip,
  makeTextClip,
  setTrackMuted,
  splitClip,
} from './timeline'
import type { EditorState } from './useEditor'

const LEFT_COL = 132
const MIN_VIEW_SECONDS = 20

interface Props {
  editor: EditorState
  mediaById: Map<string, MediaAsset>
  duration: number
}

function niceInterval(targetSeconds: number): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  for (const s of steps) if (s >= targetSeconds) return s
  return 600
}

export function TimelineView({ editor, mediaById, duration }: Props) {
  const { data, pxPerSec, playhead, selectedId } = editor
  const rulerRef = useRef<HTMLDivElement>(null)
  const scrubbing = useRef(false)

  if (!data) return null

  const viewSeconds = Math.max(duration + 3, MIN_VIEW_SECONDS)
  const laneWidth = viewSeconds * pxPerSec

  const seekFromEvent = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect()
    if (!rect) return
    const t = Math.max(0, (clientX - rect.left) / pxPerSec)
    editor.setPlaying(false)
    editor.setPlayhead(Math.min(t, viewSeconds))
  }

  const onRulerDown = (e: React.PointerEvent) => {
    scrubbing.current = true
    seekFromEvent(e.clientX)
    const move = (ev: PointerEvent) => scrubbing.current && seekFromEvent(ev.clientX)
    const up = () => {
      scrubbing.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const selected = selectedId
    ? data.tracks.flatMap((t) => t.elements).find((e) => e.id === selectedId)
    : undefined
  const canSplit =
    !!selected &&
    playhead > selected.timeline_start + 0.1 &&
    playhead < selected.timeline_start + clipDuration(selected) - 0.1

  const doSplit = () => {
    if (selectedId) editor.commit((d) => splitClip(d, selectedId, playhead))
  }
  const doDelete = () => {
    if (selectedId) {
      editor.commit((d) => deleteClip(d, selectedId))
      editor.setSelectedId(null)
    }
  }
  const doAddText = () => {
    const textTrack = data.tracks.find((t) => t.kind === 'text')
    if (!textTrack) return
    editor.commit((d) => addClip(d, textTrack.id, makeTextClip('New text', playhead)))
  }

  // Ruler ticks.
  const interval = niceInterval(80 / pxPerSec)
  const ticks: number[] = []
  for (let t = 0; t <= viewSeconds; t += interval) ticks.push(t)

  return (
    <div className="tl">
      <TimelineToolbar
        editor={editor}
        onSplit={doSplit}
        onDelete={doDelete}
        onAddText={doAddText}
        canSplit={canSplit}
        canDelete={!!selectedId}
      />

      <div className="tl-scroll">
        <div
          className="tl-inner"
          style={{ width: LEFT_COL + laneWidth }}
          onPointerDown={() => editor.setSelectedId(null)}
        >
          {/* Ruler */}
          <div className="tl-ruler-row">
            <div className="tl-corner" />
            <div
              className="tl-ruler"
              ref={rulerRef}
              style={{ width: laneWidth }}
              onPointerDown={(e) => {
                e.stopPropagation()
                onRulerDown(e)
              }}
            >
              {ticks.map((t) => (
                <div className="tl-tick" key={t} style={{ left: t * pxPerSec }}>
                  <span>{formatTimecode(t)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Tracks */}
          {data.tracks.map((track) => (
            <div className={`tl-track-row kind-${track.kind}`} key={track.id}>
              <div className="tl-ctrl">
                <span className={`track-kind ${track.kind}`}>
                  {track.kind === 'video'
                    ? '🎞'
                    : track.kind === 'audio'
                      ? '🔊'
                      : 'T'}
                </span>
                <span className="track-name">{track.name}</span>
                <button
                  className={`mute-btn ${track.muted ? 'on' : ''}`}
                  title={track.muted ? 'Unmute' : 'Mute'}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() =>
                    editor.commit((d) => setTrackMuted(d, track.id, !track.muted))
                  }
                >
                  {track.muted ? '🔇' : '🔈'}
                </button>
              </div>
              <div className="tl-lane" style={{ width: laneWidth }}>
                {track.elements.map((el) => {
                  const media = el.media_id ? mediaById.get(el.media_id) : undefined
                  return (
                    <ClipView
                      key={el.id}
                      el={el}
                      track={track}
                      pxPerSec={pxPerSec}
                      selected={el.id === selectedId}
                      sourceMax={media?.duration_seconds ?? undefined}
                      label={media?.original_filename ?? 'clip'}
                      editor={editor}
                    />
                  )
                })}
              </div>
            </div>
          ))}

          {/* Playhead spanning ruler + tracks */}
          <div
            className="tl-playhead"
            style={{ left: LEFT_COL + playhead * pxPerSec }}
          >
            <div className="tl-playhead-knob" />
          </div>
        </div>
      </div>
    </div>
  )
}
