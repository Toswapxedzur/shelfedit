import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type TimelineData } from '../api/client'
import { applyCommand, type EditorCommand } from './commands'

// Which interaction mode the main editor panel is in. The icon tool-strip
// switches this; the preview panel changes its behaviour/overlays to match.
export type EditorMode = 'select' | 'transform' | 'crop' | 'blade' | 'text'

/**
 * Central editor state: the timeline document, undo/redo history, debounced
 * autosave to the backend, and transport state (playhead / playing / zoom).
 *
 * Mutations go through `commit(producer)`, where `producer` returns a new
 * TimelineData (see editor/timeline.ts for the pure operations), or through
 * `run(command)` for the shared toolbar/agent action vocabulary.
 */
export function useEditor(projectId: string) {
  const [data, setData] = useState<TimelineData | null>(null)
  // Multi-selection is the source of truth; `selectedId` is the primary (last)
  // selected clip, kept for the many call sites that operate on one clip.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [mode, setMode] = useState<EditorMode>('select')
  const [snapping, setSnapping] = useState(true)
  const [playhead, setPlayheadState] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pxPerSec, setPxPerSec] = useState(90)

  const selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null

  // Replace the selection with a single clip (or clear it).
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIds(id ? [id] : [])
  }, [])

  // Add/remove a clip from the selection (Shift/Cmd-click on the timeline).
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }, [])

  // --- Playhead channel -----------------------------------------------------
  // The playhead moves ~60x/sec during playback and scrubbing. Writing that to
  // React state each frame would re-render the whole editor. Instead the live
  // time lives in a ref and is pushed to a set of subscribers (the moving
  // playhead line, the timecode readout, the compositor) that update the DOM /
  // canvas directly. React state (`playhead`) is only *committed* on discrete
  // events (seek release, pause, stop) so the rest of the UI stays correct
  // without per-frame renders.
  const playheadRef = useRef(0)
  const subsRef = useRef<Set<(t: number) => void>>(new Set())

  const subscribePlayhead = useCallback((cb: (t: number) => void) => {
    subsRef.current.add(cb)
    return () => {
      subsRef.current.delete(cb)
    }
  }, [])

  const notifyPlayhead = useCallback((t: number) => {
    for (const cb of subsRef.current) cb(t)
  }, [])

  // Live update: ref + subscribers only, no React render.
  const livePlayhead = useCallback(
    (t: number) => {
      playheadRef.current = t
      notifyPlayhead(t)
    },
    [notifyPlayhead],
  )

  // Commit: also writes React state (discrete seeks / pause / stop).
  const setPlayhead = useCallback(
    (t: number) => {
      playheadRef.current = t
      notifyPlayhead(t)
      setPlayheadState(t)
    },
    [notifyPlayhead],
  )

  const past = useRef<TimelineData[]>([])
  const future = useRef<TimelineData[]>([])
  const [, forceTick] = useState(0)
  const bump = () => forceTick((t) => t + 1)

  const saveTimer = useRef<number | null>(null)

  // Latest data available synchronously (for drag snapshots).
  const dataRef = useRef<TimelineData | null>(data)
  dataRef.current = data

  const load = useCallback(async () => {
    const tl = await api.getTimeline(projectId)
    setData(tl.data)
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [])

  const scheduleSave = useCallback(
    (d: TimelineData) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        api.saveTimeline(projectId, d).catch(() => {})
      }, 500)
    },
    [projectId],
  )

  const commit = useCallback(
    (producer: (d: TimelineData) => TimelineData) => {
      setData((prev) => {
        if (!prev) return prev
        const next = producer(prev)
        if (next === prev) return prev
        past.current.push(prev)
        if (past.current.length > 100) past.current.shift()
        future.current = []
        bump()
        scheduleSave(next)
        return next
      })
    },
    [scheduleSave],
  )

  // Apply a command from the shared action vocabulary (toolbar + agent).
  const run = useCallback(
    (cmd: EditorCommand) => {
      commit((d) => applyCommand(d, cmd))
    },
    [commit],
  )

  const undo = useCallback(() => {
    setData((prev) => {
      if (!prev || past.current.length === 0) return prev
      const restored = past.current.pop() as TimelineData
      future.current.push(prev)
      bump()
      scheduleSave(restored)
      return restored
    })
  }, [scheduleSave])

  const redo = useCallback(() => {
    setData((prev) => {
      if (!prev || future.current.length === 0) return prev
      const restored = future.current.pop() as TimelineData
      past.current.push(prev)
      bump()
      scheduleSave(restored)
      return restored
    })
  }, [scheduleSave])

  // A deep clone of the current data, used as the base for a drag gesture.
  const snapshot = useCallback((): TimelineData | null => {
    return dataRef.current ? JSON.parse(JSON.stringify(dataRef.current)) : null
  }, [])

  // Live update during a drag (no history entry).
  const preview = useCallback((next: TimelineData) => {
    setData(next)
  }, [])

  // Commit a completed drag: push the pre-drag snapshot to history and save.
  const finalizeDrag = useCallback(
    (original: TimelineData) => {
      past.current.push(original)
      if (past.current.length > 100) past.current.shift()
      future.current = []
      bump()
      if (dataRef.current) scheduleSave(dataRef.current)
    },
    [scheduleSave],
  )

  return {
    data,
    setData,
    selectedIds,
    setSelectedIds,
    selectedId,
    setSelectedId,
    toggleSelected,
    selectedTrackId,
    setSelectedTrackId,
    mode,
    setMode,
    snapping,
    setSnapping,
    run,
    playhead,
    setPlayhead,
    playheadRef,
    livePlayhead,
    subscribePlayhead,
    playing,
    setPlaying,
    pxPerSec,
    setPxPerSec,
    commit,
    snapshot,
    preview,
    finalizeDrag,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    reload: load,
  }
}

export type EditorState = ReturnType<typeof useEditor>
