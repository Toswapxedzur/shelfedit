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

  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [txError, setTxError] = useState<string | null>(null)
  const [needConfirmLong, setNeedConfirmLong] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        api.getProject(projectId),
        api.listMedia(projectId),
      ])
      setProject(p)
      setMedia(m)
      setError(null)
      if (p.status === 'transcribed') {
        try {
          setTranscript(await api.getTranscript(projectId))
        } catch {
          /* transcript may be absent; ignore */
        }
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

  // Clean up any polling timer on unmount.
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [])

  const video = media.find((m) => m.type === 'video')
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

  if (loading) return <div className="empty-hint">Loading…</div>
  if (!project) return <div className="error-banner">{error ?? 'Not found'}</div>

  const canTranscribe = Boolean(video) && !busy

  return (
    <div className="detail">
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

      <div className="detail-body">
        <div className="detail-main">
          <div className="preview">
            {video ? (
              <video
                className="preview-video"
                controls
                poster={api.mediaThumbnailUrl(video.id)}
                src={api.mediaFileUrl(video.id)}
              />
            ) : (
              <div className="preview-empty">
                <div className="preview-empty-title">No video yet</div>
                <div className="preview-empty-sub">
                  Import a video to start editing this project.
                </div>
                <button
                  className="btn primary"
                  onClick={() => setShowImport(true)}
                >
                  + Import video
                </button>
              </div>
            )}
          </div>

          {/* Transcript panel */}
          {video && (
            <div className="transcript-panel">
              <div className="transcript-head">
                <h3>Transcript</h3>
                {transcript?.language && (
                  <span className="tag">{transcript.language}</span>
                )}
                {transcript?.provider === 'offline' && (
                  <span className="tag warn">offline sample</span>
                )}
              </div>

              {txError && <div className="error-banner">{txError}</div>}

              {needConfirmLong && (
                <div className="confirm-box">
                  <div>{needConfirmLong}</div>
                  <div className="confirm-actions">
                    <button
                      className="btn"
                      onClick={() => setNeedConfirmLong(null)}
                    >
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

              {busy ? (
                <div className="tx-progress">
                  <div className="tx-bar">
                    <div
                      className="tx-fill"
                      style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                  <div className="tx-msg">{job?.message ?? 'Working…'}</div>
                </div>
              ) : transcript ? (
                <div className="segments">
                  {transcript.segments.length > 0 ? (
                    transcript.segments.map((s) => (
                      <div className="segment" key={s.idx}>
                        <span className="seg-time">
                          {formatDuration(s.start_seconds)}
                        </span>
                        <span className="seg-text">{s.text}</span>
                      </div>
                    ))
                  ) : (
                    <p className="seg-text">{transcript.plain_text}</p>
                  )}
                </div>
              ) : (
                <div className="empty-hint">
                  No transcript yet. Run “Transcribe” to generate one.
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="workflow">
          <h3>Workflow</h3>
          <WorkflowStep n={1} title="Import video" done={Boolean(video)} active={!video}>
            {video ? (
              <button className="btn small" onClick={() => setShowImport(true)}>
                Replace / add
              </button>
            ) : (
              <button
                className="btn primary small"
                onClick={() => setShowImport(true)}
              >
                Import
              </button>
            )}
          </WorkflowStep>

          <WorkflowStep
            n={2}
            title="Transcribe"
            done={Boolean(transcript)}
            active={Boolean(video) && !transcript}
            disabled={!video}
          >
            {video && (
              <button
                className="btn primary small"
                onClick={() => startTranscribe(false)}
                disabled={!canTranscribe}
              >
                {busy
                  ? 'Transcribing…'
                  : transcript
                    ? 'Re-transcribe'
                    : 'Transcribe'}
              </button>
            )}
          </WorkflowStep>

          <WorkflowStep n={3} title="AI cut plan" soon />
          <WorkflowStep n={4} title="Review & render" soon />
        </aside>
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

function WorkflowStep({
  n,
  title,
  done,
  active,
  soon,
  disabled,
  children,
}: {
  n: number
  title: string
  done?: boolean
  active?: boolean
  soon?: boolean
  disabled?: boolean
  children?: React.ReactNode
}) {
  return (
    <div
      className={`wf-step ${active ? 'active' : ''} ${soon || disabled ? 'soon' : ''}`}
    >
      <span className="wf-num">{done ? '✓' : n}</span>
      <div className="wf-main">
        <div className="wf-title">
          {title}
          {soon && <span className="badge">soon</span>}
        </div>
        {children && <div className="wf-actions">{children}</div>}
      </div>
    </div>
  )
}
