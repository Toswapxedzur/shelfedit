import { useCallback, useEffect, useState } from 'react'
import {
  api,
  formatDuration,
  formatSize,
  type MediaAsset,
  type Project,
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

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        api.getProject(projectId),
        api.listMedia(projectId),
      ])
      setProject(p)
      setMedia(m)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const video = media.find((m) => m.type === 'video')

  const handleImported = async () => {
    setShowImport(false)
    await load()
    onChanged()
  }

  if (loading) return <div className="empty-hint">Loading…</div>
  if (!project) return <div className="error-banner">{error ?? 'Not found'}</div>

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

        <aside className="workflow">
          <h3>Workflow</h3>
          <WorkflowStep
            n={1}
            title="Import video"
            done={Boolean(video)}
            active={!video}
          >
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
          <WorkflowStep n={2} title="Transcribe" soon />
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
  children,
}: {
  n: number
  title: string
  done?: boolean
  active?: boolean
  soon?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className={`wf-step ${active ? 'active' : ''} ${soon ? 'soon' : ''}`}>
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
