import {
  api,
  formatDuration,
  formatSize,
  type Project,
  type ProjectStatus,
} from '../api/client'

interface Props {
  project: Project
  onDelete: (project: Project) => void
  onOpen: (project: Project) => void
}

const STATUS_LABEL: Record<ProjectStatus, { text: string; tone: string }> = {
  empty: { text: 'No media yet', tone: '' },
  imported: { text: 'Imported', tone: '' },
  transcribing: { text: 'Transcribing…', tone: 'warn' },
  transcribed: { text: 'Transcript ready', tone: 'good' },
  ai_cut_ready: { text: 'Cuts ready', tone: 'good' },
  rendering: { text: 'Rendering…', tone: 'warn' },
  rendered: { text: 'Rendered', tone: 'good' },
  error: { text: 'Error', tone: 'warn' },
}

const STORAGE_LABEL: Record<string, string> = {
  local_only: 'Local only',
  final_uploaded: 'Final uploaded',
  original_backed_up: 'Backed up',
  original_missing_local: 'Original missing',
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const secs = Math.max(0, (Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`
  return `${Math.floor(secs / 86400)} d ago`
}

export function ProjectCard({ project, onDelete, onOpen }: Props) {
  const status = STATUS_LABEL[project.status]
  const hasMedia = project.media_count > 0

  return (
    <div
      className="card clickable"
      onClick={() => onOpen(project)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen(project)
      }}
    >
      <button
        className="card-delete"
        title="Delete project"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(project)
        }}
      >
        ×
      </button>
      <div className="thumb">
        {project.has_thumbnail ? (
          <img
            className="thumb-img"
            src={api.projectThumbnailUrl(project)}
            alt={project.name}
          />
        ) : (
          <span>No media yet</span>
        )}
      </div>
      <div className="card-body">
        <h3 className="card-title">{project.name}</h3>
        <div className="card-meta">
          <div className="row">
            {hasMedia
              ? `${formatSize(project.size_bytes)} | ${formatDuration(project.duration_seconds)}`
              : 'No media'}
          </div>
          <div className="row">
            <span className={`tag ${status.tone}`}>{status.text}</span>
            <span className="tag">
              {STORAGE_LABEL[project.storage_mode] ?? project.storage_mode}
            </span>
          </div>
          <div className="row" style={{ color: 'var(--text-faint)' }}>
            Edited {relativeTime(project.updated_at)}
          </div>
        </div>
      </div>
    </div>
  )
}
