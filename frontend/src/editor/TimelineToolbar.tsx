import type { EditorState } from './useEditor'

interface Props {
  editor: EditorState
  onSplit: () => void
  onDelete: () => void
  onAddText: () => void
  canSplit: boolean
  canDelete: boolean
}

export function TimelineToolbar({
  editor,
  onSplit,
  onDelete,
  onAddText,
  canSplit,
  canDelete,
}: Props) {
  const zoom = (factor: number) =>
    editor.setPxPerSec((p) => Math.min(600, Math.max(20, p * factor)))

  return (
    <div className="tl-toolbar">
      <button className="tbtn" onClick={onSplit} disabled={!canSplit} title="Split at playhead (S)">
        ✂ Split
      </button>
      <button className="tbtn" onClick={onDelete} disabled={!canDelete} title="Delete (Del)">
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
      <div className="tbar-spacer" />
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
