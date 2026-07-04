import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  ConfirmationRequiredError,
  formatDuration,
  formatSize,
  type Job,
  type MediaAsset,
  type Project,
  type Transcript,
} from '../api/client'
import { ImportMediaModal } from './ImportMediaModal'
import { AiChat } from './AiChat'
import { PreviewCanvas } from '../editor/PreviewCanvas'
import { TimelineView } from '../editor/TimelineView'
import { Inspector } from '../editor/Inspector'
import { EditorToolbar } from '../editor/EditorToolbar'
import { useEditor } from '../editor/useEditor'
import {
  addClip,
  addTrack,
  makeAudioClip,
  makeTextClip,
  makeVideoClip,
} from '../editor/timeline'

interface Props {
  projectId: string
  onBack: () => void
  onChanged: () => void
}

export function ProjectDetail({ projectId, onBack, onChanged }: Props) {
  const [project, setProject] = useState<Project | null>(null)
  const [media, setMedia] = useState<MediaAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [showAssets, setShowAssets] = useState(false)

  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [txError, setTxError] = useState<string | null>(null)
  const [needConfirmLong, setNeedConfirmLong] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const [renderJob, setRenderJob] = useState<Job | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [exportsList, setExportsList] = useState<MediaAsset[]>([])
  const renderPollRef = useRef<number | null>(null)

  const editor = useEditor(projectId)
  const populatedText = useRef(false)

  // Resizable / dockable panel geometry.
  const [inspectorW, setInspectorW] = useState(264)
  const [chatW, setChatW] = useState(340)
  const [timelineH, setTimelineH] = useState(320)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [chatDetached, setChatDetached] = useState(false)
  const [chatPos, setChatPos] = useState({ x: 120, y: 120 })

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

  // Generic pointer drag: calls back with the cumulative delta from the start.
  const startDrag = (
    e: React.PointerEvent,
    onDelta: (dx: number, dy: number) => void,
  ) => {
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent) => onDelta(ev.clientX - sx, ev.clientY - sy)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        api.getProject(projectId),
        api.listMedia(projectId),
      ])
      setProject(p)
      setMedia(m)
      setError(null)
      try {
        setTranscript(await api.getTranscript(projectId))
      } catch {
        setTranscript(null)
      }
      try {
        setExportsList(await api.getExports(projectId))
      } catch {
        setExportsList([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
      if (renderPollRef.current) window.clearInterval(renderPollRef.current)
    }
  }, [])

  const mediaById = useMemo(
    () => new Map(media.map((m) => [m.id, m])),
    [media],
  )
  const video = media.find((m) => m.type === 'video')

  // Auto-populate the timeline with the imported video (+ its audio).
  useEffect(() => {
    if (!editor.data || !video) return
    const videoTracks = editor.data.tracks.filter((t) => t.kind === 'video')
    const vt = videoTracks[videoTracks.length - 1]
    const at = editor.data.tracks.find((t) => t.kind === 'audio')
    if (!vt) return
    // Already placed on any video track? (avoids duplicating on multi-track edits)
    const hasClip = videoTracks.some((t) =>
      t.elements.some((e) => e.media_id === video.id),
    )
    if (hasClip) return
    const dur = video.duration_seconds ?? 0
    editor.commit((d) => {
      let nd = addClip(d, vt.id, makeVideoClip(video.id, dur, 0))
      if (at) nd = addClip(nd, at.id, makeAudioClip(video.id, dur, 0))
      return nd
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.data, video])

  // Populate the text track from the transcript once.
  useEffect(() => {
    if (!editor.data || !transcript || populatedText.current) return
    const tt = editor.data.tracks.find((t) => t.kind === 'text')
    if (!tt || tt.elements.length > 0 || transcript.segments.length === 0) return
    populatedText.current = true
    editor.commit((d) => {
      let nd = d
      for (const s of transcript.segments) {
        const clip = makeTextClip(s.text, s.start_seconds)
        clip.timeline_end = s.end_seconds
        nd = addClip(nd, tt.id, clip)
      }
      return nd
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.data, transcript])

  const busy = job?.status === 'queued' || job?.status === 'running'
  const renderBusy =
    renderJob?.status === 'queued' || renderJob?.status === 'running'

  const pollJob = (jobId: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    pollRef.current = window.setInterval(async () => {
      try {
        const j = await api.getJob(jobId)
        setJob(j)
        if (j.status === 'done' || j.status === 'error') {
          if (pollRef.current) window.clearInterval(pollRef.current)
          pollRef.current = null
          if (j.status === 'error') setTxError(j.error_message ?? 'Job failed')
          await load()
          onChanged()
        }
      } catch {
        if (pollRef.current) window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }, 1000)
  }

  const startTranscribe = async (confirmLong = false) => {
    setTxError(null)
    setNeedConfirmLong(null)
    try {
      const j = await api.transcribe(projectId, confirmLong)
      setJob(j)
      pollJob(j.id)
    } catch (e) {
      if (e instanceof ConfirmationRequiredError) setNeedConfirmLong(e.message)
      else setTxError(e instanceof Error ? e.message : 'Failed to transcribe')
    }
  }

  const pollRenderJob = (jobId: string) => {
    if (renderPollRef.current) window.clearInterval(renderPollRef.current)
    renderPollRef.current = window.setInterval(async () => {
      try {
        const j = await api.getJob(jobId)
        setRenderJob(j)
        if (j.status === 'done' || j.status === 'error') {
          if (renderPollRef.current) window.clearInterval(renderPollRef.current)
          renderPollRef.current = null
          if (j.status === 'error')
            setRenderError(j.error_message ?? 'Render failed')
          await load()
          onChanged()
        }
      } catch {
        if (renderPollRef.current) window.clearInterval(renderPollRef.current)
        renderPollRef.current = null
      }
    }, 1000)
  }

  const startRender = async () => {
    setRenderError(null)
    try {
      const j = await api.render(projectId)
      setRenderJob(j)
      pollRenderJob(j.id)
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : 'Failed to render')
    }
  }

  const handleImported = async () => {
    setShowImport(false)
    await load()
    onChanged()
  }

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      const mod = e.metaKey || e.ctrlKey
      if (e.key === ' ') {
        e.preventDefault()
        editor.setPlaying(!editor.playing)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selectedIds.length) {
        e.preventDefault()
        editor.run({
          type: e.shiftKey ? 'rippleDelete' : 'delete',
          clipIds: editor.selectedIds,
        })
        editor.setSelectedIds([])
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) editor.redo()
        else editor.undo()
      } else if (mod && e.key.toLowerCase() === 'd' && editor.selectedIds.length) {
        e.preventDefault()
        editor.run({ type: 'duplicate', clipIds: editor.selectedIds })
      } else if (!mod) {
        // Mode hotkeys (single letters, when not typing / no modifier).
        const map: Record<string, typeof editor.mode> = {
          v: 'select',
          w: 'transform',
          c: 'crop',
          b: 'blade',
          x: 'text',
        }
        const m = map[e.key.toLowerCase()]
        if (m) {
          e.preventDefault()
          editor.setMode(m)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor])

  // Selected clips, primary (last-selected) first so the inspector shows it.
  const allClips = editor.data?.tracks.flatMap((t) => t.elements) ?? []
  const clipById = new Map(allClips.map((c) => [c.id, c]))
  const selectedClips = [...editor.selectedIds]
    .reverse()
    .map((id) => clipById.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))

  const assets = media.filter((m) => m.type !== 'export')

  // Drop a clip for an imported asset onto a compatible track at the playhead.
  const placeAsset = (m: MediaAsset) => {
    const kind: 'video' | 'audio' = m.type === 'audio' ? 'audio' : 'video'
    editor.commit((d) => {
      let data = d
      const sel = data.tracks.find((t) => t.id === editor.selectedTrackId)
      let track = sel && sel.kind === kind ? sel : undefined
      if (!track) {
        const ofKind = data.tracks.filter((t) => t.kind === kind)
        track = ofKind[ofKind.length - 1]
      }
      if (!track) {
        data = addTrack(data, kind, 0)
        track = data.tracks[0]
      }
      const dur = m.duration_seconds ?? 5
      const el =
        kind === 'video'
          ? makeVideoClip(m.id, dur, editor.playhead)
          : makeAudioClip(m.id, dur, editor.playhead)
      return addClip(data, track.id, el)
    })
    setShowAssets(false)
  }

  if (loading) return <div className="editor-loading">Loading…</div>
  if (!project)
    return <div className="editor-loading error">{error ?? 'Not found'}</div>

  const duration = editor.data?.duration ?? 0

  return (
    <div className="editor-root">
      {/* Top bar */}
      <div className="editor-topbar">
        <button className="btn small" onClick={onBack}>
          ← Projects
        </button>
        <div className="editor-title">
          <strong>{project.name}</strong>
          <span className="editor-meta">
            {video
              ? `${formatDuration(video.duration_seconds)} · ${video.width}×${video.height} · ${formatSize(video.size_bytes)}`
              : 'No video imported'}
          </span>
        </div>
        <div className="topbar-actions">
          <button className="btn small" onClick={() => setShowImport(true)}>
            + Import
          </button>
          <button
            className="btn small"
            onClick={() => setShowAssets((s) => !s)}
            disabled={assets.length === 0}
            title="Place an imported clip on a track"
          >
            🎬 Assets ({assets.length})
          </button>
          <button
            className="btn small"
            onClick={() => startTranscribe(false)}
            disabled={!video || busy}
          >
            {busy ? `Transcribing ${Math.round((job?.progress ?? 0) * 100)}%` : '🎙 Transcribe'}
          </button>
          <button
            className="btn small primary"
            onClick={startRender}
            disabled={renderBusy || !editor.data}
          >
            {renderBusy
              ? `Rendering ${Math.round((renderJob?.progress ?? 0) * 100)}%`
              : '🎬 Render'}
          </button>
          {exportsList.map((ex) => (
            <a
              key={ex.id}
              className="export-link"
              href={api.mediaFileUrl(ex.id)}
              download={ex.original_filename}
              title="Download export"
            >
              ↓ {ex.original_filename}
            </a>
          ))}
        </div>
      </div>

      {showAssets && (
        <div className="assets-pop">
          <div className="assets-head">
            Assets — click to add at playhead
            {editor.selectedTrackId && <span className="assets-hint"> → selected track</span>}
          </div>
          <div className="assets-list">
            {assets.map((m) => (
              <button key={m.id} className="asset-item" onClick={() => placeAsset(m)}>
                <span className="asset-kind">{m.type === 'audio' ? '🔊' : '🎞'}</span>
                <span className="asset-name">{m.original_filename}</span>
                <span className="asset-dur">{formatDuration(m.duration_seconds)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(txError || renderError || needConfirmLong) && (
        <div className="editor-alerts">
          {txError && <span className="alert err">{txError}</span>}
          {renderError && <span className="alert err">{renderError}</span>}
          {needConfirmLong && (
            <span className="alert warn">
              {needConfirmLong}{' '}
              <button className="btn small" onClick={() => startTranscribe(true)}>
                Transcribe anyway
              </button>
            </span>
          )}
        </div>
      )}

      {/* Mode / tool strip (extends the top bar) */}
      <EditorToolbar editor={editor} />

      {/* Middle: inspector (orange) | preview (purple) | AI chat (red) */}
      <div className="editor-mid">
        {inspectorOpen && (
          <div className="dock dock-inspector" style={{ width: inspectorW }}>
            <div className="dock-head">
              <span>Properties</span>
              <button className="dock-x" title="Hide" onClick={() => setInspectorOpen(false)}>
                ⟨
              </button>
            </div>
            <div className="dock-body">
              {selectedClips.length ? (
                <Inspector clips={selectedClips} editor={editor} playhead={editor.playhead} />
              ) : (
                <div className="dock-empty">Select clip(s) to edit properties</div>
              )}
            </div>
            <div
              className="resize-handle right"
              onPointerDown={(e) => {
                const base = inspectorW
                startDrag(e, (dx) => setInspectorW(clamp(base + dx, 200, 460)))
              }}
            />
          </div>
        )}
        {!inspectorOpen && (
          <button className="dock-reopen" title="Show properties" onClick={() => setInspectorOpen(true)}>
            ⟩
          </button>
        )}

        <div className="stage">
          {editor.data ? (
            <PreviewCanvas
              data={editor.data}
              playhead={editor.playhead}
              playing={editor.playing}
              duration={duration}
              mode={editor.mode}
              selectedId={editor.selectedId}
              setPlayhead={editor.setPlayhead}
              setPlaying={editor.setPlaying}
              livePlayhead={editor.livePlayhead}
              subscribePlayhead={editor.subscribePlayhead}
              onSelectClip={editor.setSelectedId}
              onTransform={(id, transform) =>
                editor.run({ type: 'setProps', clipIds: [id], patch: { transform } })
              }
              onCrop={(id, crop) =>
                editor.run({ type: 'setProps', clipIds: [id], patch: { crop } })
              }
              onAddText={(at, x, y) => editor.run({ type: 'addText', at, x, y })}
            />
          ) : (
            <div className="editor-loading">Loading timeline…</div>
          )}
        </div>

        {!chatDetached && (
          <aside className="dock side" style={{ width: chatW }}>
            <div
              className="resize-handle left"
              onPointerDown={(e) => {
                const base = chatW
                startDrag(e, (dx) => setChatW(clamp(base - dx, 260, 560)))
              }}
            />
            <div className="dock-head">
              <span>AI Assistant</span>
              <button className="dock-x" title="Detach into a floating window" onClick={() => setChatDetached(true)}>
                ⧉
              </button>
            </div>
            <div className="dock-body no-pad">
              <AiChat
                projectId={projectId}
                hasTranscript={Boolean(transcript)}
                onApplied={async () => {
                  await editor.reload()
                  await load()
                  onChanged()
                }}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Bottom: timeline (green) */}
      <div className="editor-bottom" style={{ height: timelineH }}>
        <div
          className="resize-handle top"
          onPointerDown={(e) => {
            const base = timelineH
            startDrag(e, (_dx, dy) => setTimelineH(clamp(base - dy, 160, 640)))
          }}
        />
        <TimelineView editor={editor} mediaById={mediaById} duration={duration} />
      </div>

      {chatDetached && (
        <div
          className="floating-chat"
          style={{ left: chatPos.x, top: chatPos.y, width: chatW }}
        >
          <div
            className="floating-chat-head"
            onPointerDown={(e) => {
              const base = { ...chatPos }
              startDrag(e, (dx, dy) =>
                setChatPos({ x: Math.max(0, base.x + dx), y: Math.max(0, base.y + dy) }),
              )
            }}
          >
            <span>AI Assistant</span>
            <button className="dock-x" title="Dock back" onClick={() => setChatDetached(false)}>
              ⤓
            </button>
          </div>
          <div className="floating-chat-body">
            <AiChat
              projectId={projectId}
              hasTranscript={Boolean(transcript)}
              onApplied={async () => {
                await editor.reload()
                await load()
                onChanged()
              }}
            />
          </div>
        </div>
      )}

      {showImport && (
        <ImportMediaModal
          project={project}
          onCancel={() => setShowImport(false)}
          onImported={handleImported}
        />
      )}
    </div>
  )
}
