import { useEffect, useRef } from 'react'
import type { MediaAsset, TimelineElement, TimelineTrack } from '../api/client'
import { ClipView } from './ClipView'
import { TimelineToolbar } from './TimelineToolbar'
import { formatTimecode } from './format'
import {
  addClip,
  addTrack,
  clipDuration,
  clipEnd,
  deleteClip,
  findClip,
  makeGroupId,
  makeTextClip,
  moveTrack,
  removeTrack,
  setTrackFlags,
  splitClip,
} from './timeline'
import type { TrackKind } from '../api/client'
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
  const { data, pxPerSec, playhead, selectedId, selectedIds, subscribePlayhead } = editor
  const rulerRef = useRef<HTMLDivElement>(null)
  const playheadElRef = useRef<HTMLDivElement>(null)
  const scrubbing = useRef(false)
  const scrubT = useRef(0)
  // Live map of trackId -> its lane DOM node, so a clip drag can resolve which
  // track lane the cursor is over (2D cross-track dragging).
  const laneRefs = useRef(new Map<string, HTMLDivElement>())

  // Editing is frame-based: snap the playhead to the project's frame grid so
  // scrubbing at extreme zoom lands on discrete frames (what real NLEs do)
  // instead of jittering between sub-frame positions.
  const fps = data?.canvas?.fps ?? 30
  const quantize = (t: number) => Math.round(t * fps) / fps

  const viewSeconds = Math.max(duration + 3, MIN_VIEW_SECONDS)

  // The track lane sitting under a screen-Y coordinate (used while dragging a
  // clip to decide which track it would drop onto — "the track its center line
  // lands on").
  const resolveTrackAt = (clientY: number): TimelineTrack | null => {
    if (!data) return null
    for (const track of data.tracks) {
      const node = laneRefs.current.get(track.id)
      if (!node) continue
      const r = node.getBoundingClientRect()
      if (clientY >= r.top && clientY <= r.bottom) return track
    }
    return null
  }

  // Clips linked (magnet group) to the current selection — highlighted yellow.
  const selectedGroupIds = new Set<string>()
  if (data) {
    for (const id of selectedIds) {
      const f = findClip(data, id)
      if (f?.el.groupId) selectedGroupIds.add(f.el.groupId)
    }
  }
  const isLinkedToSelection = (el: TimelineElement): boolean =>
    !!el.groupId && selectedGroupIds.has(el.groupId) && !selectedIds.includes(el.id)

  // Move the playhead line via the live channel (no re-render during playback
  // or scrubbing). Re-subscribes when the zoom (pxPerSec) changes.
  useEffect(() => {
    const move = (t: number) => {
      if (playheadElRef.current) {
        playheadElRef.current.style.left = `${LEFT_COL + t * pxPerSec}px`
      }
    }
    return subscribePlayhead(move)
  }, [subscribePlayhead, pxPerSec])

  if (!data) return null

  const laneWidth = viewSeconds * pxPerSec

  const seekLive = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect()
    if (!rect) return
    const raw = Math.min(Math.max(0, (clientX - rect.left) / pxPerSec), viewSeconds)
    const t = quantize(raw)
    scrubT.current = t
    editor.livePlayhead(t)
  }

  const onRulerDown = (e: React.PointerEvent) => {
    scrubbing.current = true
    editor.setPlaying(false)
    seekLive(e.clientX)
    const move = (ev: PointerEvent) => scrubbing.current && seekLive(ev.clientX)
    const up = () => {
      scrubbing.current = false
      editor.setPlayhead(scrubT.current) // commit once at the end of the drag
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
    const sel = data.tracks.find((t) => t.id === editor.selectedTrackId)
    const textTrack = sel && sel.kind === 'text' ? sel : data.tracks.find((t) => t.kind === 'text')
    if (!textTrack) return
    // If a video clip is selected and the new text lands over it, pin the text
    // to that shot by linking them (they'll move together as a magnet group).
    const overVideo = selectedIds
      .map((id) => findClip(data, id)?.el)
      .find(
        (e): e is TimelineElement =>
          !!e && e.type === 'video' && playhead >= e.timeline_start && playhead < clipEnd(e),
      )
    editor.commit((d) => {
      const text = makeTextClip('New text', playhead)
      if (overVideo) {
        const gid = overVideo.groupId ?? makeGroupId()
        text.groupId = gid
        // Stamp the group id onto the video too (if it wasn't already grouped).
        for (const t of d.tracks)
          for (const e of t.elements) if (e.id === overVideo.id) e.groupId = gid
      }
      return addClip(d, textTrack.id, text)
    })
  }

  const doAddTrack = (kind: TrackKind) => {
    editor.commit((d) => addTrack(d, kind, 0))
  }
  const doMoveTrack = (dir: -1 | 1) => {
    if (editor.selectedTrackId)
      editor.commit((d) => moveTrack(d, editor.selectedTrackId as string, dir))
  }
  const doRemoveTrack = () => {
    if (!editor.selectedTrackId) return
    const tr = data.tracks.find((t) => t.id === editor.selectedTrackId)
    if (tr && tr.elements.length > 0) {
      if (!window.confirm(`Remove track "${tr.name}" and its ${tr.elements.length} clip(s)?`))
        return
    }
    editor.commit((d) => removeTrack(d, editor.selectedTrackId as string))
    editor.setSelectedTrackId(null)
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
        onAddTrack={doAddTrack}
        onMoveTrack={doMoveTrack}
        onRemoveTrack={doRemoveTrack}
        canSplit={canSplit}
        canDelete={!!selectedId}
        hasSelectedTrack={!!editor.selectedTrackId}
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
            <div
              className={`tl-track-row kind-${track.kind} ${track.id === editor.selectedTrackId ? 'sel' : ''}`}
              key={track.id}
            >
              <div
                className="tl-ctrl"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  editor.setSelectedTrackId(track.id)
                }}
              >
                <span className={`track-kind ${track.kind}`}>
                  {track.kind === 'video'
                    ? '🎞'
                    : track.kind === 'audio'
                      ? '🔊'
                      : 'T'}
                </span>
                <span className="track-name">{track.name}</span>
                <button
                  className={`track-flag ${track.hidden ? '' : 'on'}`}
                  title={
                    track.hidden
                      ? track.kind === 'audio'
                        ? 'Muted — click to play'
                        : 'Hidden — click to show'
                      : track.kind === 'audio'
                        ? 'Audible — click to mute'
                        : 'Visible — click to hide'
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() =>
                    editor.commit((d) => setTrackFlags(d, track.id, { hidden: !track.hidden }))
                  }
                >
                  {track.hidden ? (track.kind === 'audio' ? '🔇' : '⦸') : track.kind === 'audio' ? '🔈' : '👁'}
                </button>
                <button
                  className={`track-flag ${track.locked ? 'on' : ''}`}
                  title={track.locked ? 'Locked — click to unlock' : 'Unlocked — click to lock'}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() =>
                    editor.commit((d) => setTrackFlags(d, track.id, { locked: !track.locked }))
                  }
                >
                  {track.locked ? '🔒' : '🔓'}
                </button>
              </div>
              <div
                className={`tl-lane ${track.locked ? 'locked' : ''}`}
                style={{ width: laneWidth }}
                ref={(node) => {
                  if (node) laneRefs.current.set(track.id, node)
                  else laneRefs.current.delete(track.id)
                }}
              >
                {track.elements.map((el) => {
                  const media = el.media_id ? mediaById.get(el.media_id) : undefined
                  return (
                    <ClipView
                      key={el.id}
                      el={el}
                      track={track}
                      pxPerSec={pxPerSec}
                      selected={selectedIds.includes(el.id)}
                      linked={isLinkedToSelection(el)}
                      sourceMax={media?.duration_seconds ?? undefined}
                      label={media?.original_filename ?? 'clip'}
                      editor={editor}
                      resolveTrackAt={resolveTrackAt}
                    />
                  )
                })}
              </div>
            </div>
          ))}

          {/* Playhead spanning ruler + tracks */}
          <div
            className="tl-playhead"
            ref={playheadElRef}
            style={{ left: LEFT_COL + playhead * pxPerSec }}
          >
            <div className="tl-playhead-knob" />
          </div>
        </div>
      </div>
    </div>
  )
}
