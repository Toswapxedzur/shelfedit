import type { EditorMode, EditorState } from './useEditor'
import { clipDuration, findClip } from './timeline'

interface Props {
  editor: EditorState
}

interface ModeDef {
  id: EditorMode
  icon: string
  label: string
  hint: string
}

// The mode icons. Clicking one switches what the main editor (preview) panel
// does — the panel renders overlays/handles that match the active mode.
// Canvas modes: these change what a click/drag on the PREVIEW does. The
// cursor modes that act on the timeline (select / blade) live in the timeline
// strip next to zoom instead.
const MODES: ModeDef[] = [
  { id: 'transform', icon: '✥', label: 'Transform', hint: 'Move / scale / rotate on canvas (W)' },
  { id: 'crop', icon: '⛶', label: 'Crop', hint: 'Crop the frame on canvas (C)' },
  { id: 'text', icon: 'T', label: 'Text', hint: 'Click the canvas to add text (X)' },
]

export function EditorToolbar({ editor }: Props) {
  const { data, selectedIds, playhead, mode } = editor
  const primaryId = editor.selectedId
  const primary =
    primaryId && data ? findClip(data, primaryId)?.el ?? null : null

  const canSplit =
    !!primary &&
    playhead > primary.timeline_start + 0.1 &&
    playhead < primary.timeline_start + clipDuration(primary) - 0.1

  const hasSel = selectedIds.length > 0

  const doSplit = () => {
    if (primaryId) editor.run({ type: 'split', clipId: primaryId, at: playhead })
  }

  return (
    <div className="etool">
      <div className="etool-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`etool-mode ${mode === m.id ? 'active' : ''}`}
            title={m.hint}
            onClick={() => editor.setMode(m.id)}
          >
            <span className="etool-ico">{m.icon}</span>
            <span className="etool-lbl">{m.label}</span>
          </button>
        ))}
      </div>

      <div className="etool-sep" />

      <div className="etool-actions">
        <button className="etool-act" onClick={doSplit} disabled={!canSplit} title="Split at playhead (S)">
          ✂
        </button>
        <button
          className="etool-act"
          onClick={() => editor.run({ type: 'duplicate', clipIds: selectedIds })}
          disabled={!hasSel}
          title="Duplicate clip(s) (⌘D)"
        >
          ⧉
        </button>
        <button
          className="etool-act"
          onClick={() => {
            editor.run({ type: 'rippleDelete', clipIds: selectedIds })
            editor.setSelectedIds([])
          }}
          disabled={!hasSel}
          title="Ripple delete — remove & close the gap (⇧⌫)"
        >
          ⟠
        </button>
        <button
          className="etool-act"
          onClick={() => editor.run({ type: 'flipH', clipIds: selectedIds })}
          disabled={!hasSel}
          title="Flip horizontal"
        >
          ⇋
        </button>
        <button
          className="etool-act"
          onClick={() => editor.run({ type: 'flipV', clipIds: selectedIds })}
          disabled={!hasSel}
          title="Flip vertical"
        >
          ⤯
        </button>
        <button
          className="etool-act"
          onClick={() => editor.run({ type: 'rotateBy', clipIds: selectedIds, degrees: 90 })}
          disabled={!hasSel}
          title="Rotate 90°"
        >
          ⟳
        </button>
        <button
          className="etool-act"
          onClick={() => editor.run({ type: 'resetTransform', clipIds: selectedIds })}
          disabled={!hasSel}
          title="Reset transform (scale / position / rotation)"
        >
          ⊘
        </button>
        <div className="etool-sep" />
        <button
          className="etool-act"
          onClick={() => editor.run({ type: 'link', clipIds: selectedIds })}
          disabled={selectedIds.length < 2}
          title="Link clips — move together (magnet)"
        >
          🔗
        </button>
        <button
          className="etool-act"
          onClick={() => editor.run({ type: 'unlink', clipIds: selectedIds })}
          disabled={!hasSel}
          title="Unlink clips"
        >
          ⛓️‍💥
        </button>
        <button
          className={`etool-act ${editor.snapping ? 'on' : ''}`}
          onClick={() => editor.setSnapping(!editor.snapping)}
          title="Snapping to clip edges & playhead"
        >
          🧲
        </button>
        <div className="etool-sep" />
        <button className="etool-act" onClick={editor.undo} disabled={!editor.canUndo} title="Undo (⌘Z)">
          ↶
        </button>
        <button className="etool-act" onClick={editor.redo} disabled={!editor.canRedo} title="Redo (⌘⇧Z)">
          ↷
        </button>
      </div>
    </div>
  )
}
