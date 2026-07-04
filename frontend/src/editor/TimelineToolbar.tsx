import type { TrackKind } from '../api/client'
import type { EditorState } from './useEditor'

interface Props {
  editor: EditorState
  onSplit: () => void
  onDelete: () => void
  onAddText: () => void
  onAddTrack: (kind: TrackKind) => void
  onMoveTrack: (dir: -1 | 1) => void
  onRemoveTrack: () => void
  canSplit: boolean
  canDelete: boolean
  hasSelectedTrack: boolean
}

export function TimelineToolbar({
  editor,
  onSplit,
  onDelete,
  onAddText,
  onAddTrack,
  onMoveTrack,
  onRemoveTrack,
  canSplit,
  canDelete,
  hasSelectedTrack,
}: Props) {
  const zoom = (factor: number) =>
    editor.setPxPerSec((p) => Math.min(600, Math.max(20, p * factor)))

  return (
    <div className="tl-toolbar">
      <button className="tbtn" onClick={onSplit} disabled={!canSplit} title="Split at playhead (S)">
        ✂ Split
      </button>
      <button className="tbtn" onClick={onDelete} disabled={!canDelete} title="Delete clip (Del)">
        🗑 Delete
      </button>
      <div className="tbar-sep" />
      <button className="tbtn" onClick={editor.undo} disabled={!editor.canUndo} title="Undo (⌘Z)">
        ↶ Undo
      </button>
      <button className="tbtn" onClick={editor.redo} disabled={!editor.canRedo} title="Redo (⌘⇧Z)">
        ↷ Redo
      </button>
      <div className="tbar-sep" />
      <button className="tbtn" onClick={onAddText} title="Add a text clip at the playhead">
        + Text
      </button>
      <select
        className="tbtn tbar-select"
        value=""
        title="Add a new track"
        onChange={(e) => {
          if (e.target.value) {
            onAddTrack(e.target.value as TrackKind)
            e.target.value = ''
          }
        }}
      >
        <option value="">+ Track…</option>
        <option value="video">Video track</option>
        <option value="audio">Audio track</option>
        <option value="text">Text track</option>
      </select>
      <button className="tbtn" onClick={() => onMoveTrack(-1)} disabled={!hasSelectedTrack} title="Move track up (composites on top)">
        ↑
      </button>
      <button className="tbtn" onClick={() => onMoveTrack(1)} disabled={!hasSelectedTrack} title="Move track down">
        ↓
      </button>
      <button className="tbtn" onClick={onRemoveTrack} disabled={!hasSelectedTrack} title="Remove selected track">
        ⌫ Track
      </button>
      <div className="tbar-spacer" />
      {/* Cursor modes live with the zoom strip — they change what a click on a
          clip does (select/move vs. cut). */}
      <div className="tbar-cursor">
        <button
          className={`tbtn ${editor.mode === 'select' ? 'active' : ''}`}
          onClick={() => editor.setMode('select')}
          title="Select cursor — move & trim clips (V)"
        >
          ⤢ Select
        </button>
        <button
          className={`tbtn ${editor.mode === 'blade' ? 'active' : ''}`}
          onClick={() => editor.setMode('blade')}
          title="Blade cursor — click a clip to cut it (B)"
        >
          🔪 Blade
        </button>
      </div>
      <div className="tbar-sep" />
      <span className="tbar-label">Zoom</span>
      <button className="tbtn" onClick={() => zoom(1 / 1.4)} title="Zoom out">
        −
      </button>
      <button className="tbtn" onClick={() => zoom(1.4)} title="Zoom in">
        +
      </button>
    </div>
  )
}
