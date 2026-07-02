import { useCallback, useEffect, useRef, useState } from 'react'
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
import { Tracks } from './Tracks'

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
  const [selected, setSelected] = useState<'video' | null>(null)

  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [txError, setTxError] = useState<string | null>(null)
  const [needConfirmLong, setNeedConfirmLong] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

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
    }
  }, [])

  const video = media.find((m) => m.type === 'video')

  // Auto-select the video segment once it exists.
  useEffect(() => {
    if (video && selected === null) setSelected('video')
  }, [video, selected])

  const busy = job?.status === 'queued' || job?.status === 'running'

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
      if (e instanceof ConfirmationRequiredError) {
        setNeedConfirmLong(e.message)
      } else {
        setTxError(e instanceof Error ? e.message : 'Failed to start transcription')
      }
    }
  }

  const handleImported = async () => {
    setShowImport(false)
    await load()
    onChanged()
  }

  const seek = (t: number) => {
    const el = videoRef.current
    if (el) {
      el.currentTime = t
      void el.play().catch(() => {})
    }
  }

  if (loading) return <div className="empty-hint">Loading…</div>
  if (!project) return <div className="error-banner">{error ?? 'Not found'}</div>

  const canTranscribe = Boolean(video) && !busy

  return (
    <div className="detail editor-detail">
      <div className="detail-topbar">
        <button className="btn back-btn" onClick={onBack}>
          ← Projects
        </button>
        <div className="detail-title">
          <h1>{project.name}</h1>
          <span className="subtitle">
            {video
              ? `${formatSize(video.size_bytes)} · ${formatDuration(video.duration_seconds)} · ${video.width}×${video.height} · ${
                  video.storage_kind === 'copied' ? 'Copied' : 'Referenced'
                }`
              : 'No video imported yet'}
          </span>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="editor">
        {/* Left: tools panel — contextual actions on the selected element */}
        <div className="tools">
          <button
            className="tool-btn"
            title="Import video"
            onClick={() => setShowImport(true)}
          >
            <span className="tool-ico">＋</span>
            <span className="tool-label">Import</span>
          </button>

          <div className="tool-divider" />

          {selected === 'video' && video ? (
            <div className="tool-section">
              <div className="tool-section-title">Video segment</div>
              <button
                className="tool-btn"
                title="Transcribe this segment"
                onClick={() => startTranscribe(false)}
                disabled={!canTranscribe}
              >
                <span className="tool-ico">🎙</span>
                <span className="tool-label">
                  {busy ? 'Working…' : transcript ? 'Re-transcribe' : 'Transcribe'}
                </span>
              </button>
            </div>
          ) : (
            <div className="tool-hint">Select a segment</div>
          )}
        </div>

        {/* Center: preview */}
        <div className="preview-pane">
          {video ? (
            <>
              <video
                ref={videoRef}
                className="preview-video"
                controls
                poster={api.mediaThumbnailUrl(video.id)}
                src={api.mediaFileUrl(video.id)}
              />
              {txError && <div className="error-banner">{txError}</div>}
              {needConfirmLong && (
                <div className="confirm-box">
                  <div>{needConfirmLong}</div>
                  <div className="confirm-actions">
                    <button className="btn" onClick={() => setNeedConfirmLong(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn primary"
                      onClick={() => startTranscribe(true)}
                    >
                      Transcribe anyway
                    </button>
                  </div>
                </div>
              )}
              {busy && (
                <div className="tx-progress">
                  <div className="tx-bar">
                    <div
                      className="tx-fill"
                      style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                  <div className="tx-msg">{job?.message ?? 'Working…'}</div>
                </div>
              )}
            </>
          ) : (
            <div className="preview-empty">
              <div className="preview-empty-title">No video yet</div>
              <div className="preview-empty-sub">
                Import a video to start editing this project.
              </div>
              <button className="btn primary" onClick={() => setShowImport(true)}>
                + Import video
              </button>
            </div>
          )}
        </div>

        {/* Right: AI edit chat */}
        <div className="chat-pane">
          <AiChat
            projectId={projectId}
            hasTranscript={Boolean(transcript)}
            onApplied={async () => {
              await load()
              onChanged()
            }}
          />
        </div>

        {/* Bottom: tracks strip */}
        <div className="tracks-pane">
          <Tracks
            duration={video?.duration_seconds ?? 0}
            videoName={video?.original_filename ?? 'No video'}
            hasAudio={Boolean(video)}
            segments={transcript?.segments ?? []}
            onSeek={seek}
          />
        </div>
      </div>

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
