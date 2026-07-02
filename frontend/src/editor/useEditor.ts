import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type TimelineData } from '../api/client'

/**
 * Central editor state: the timeline document, undo/redo history, debounced
 * autosave to the backend, and transport state (playhead / playing / zoom).
 *
 * Mutations go through `commit(producer)`, where `producer` returns a new
 * TimelineData (see editor/timeline.ts for the pure operations).
 */
export function useEditor(projectId: string) {
  const [data, setData] = useState<TimelineData | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pxPerSec, setPxPerSec] = useState(90)

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
    selectedId,
    setSelectedId,
    playhead,
    setPlayhead,
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
