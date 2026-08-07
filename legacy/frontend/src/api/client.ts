// Thin API layer between the UI and the local backend engine.
// In dev, Vite proxies these paths to the backend; in the packaged desktop app
// the backend serves this UI, so relative paths resolve to the same origin.

export type ProjectStatus =
  | 'empty'
  | 'imported'
  | 'transcribing'
  | 'transcribed'
  | 'ai_cut_ready'
  | 'rendering'
  | 'rendered'
  | 'error'

export type StorageMode =
  | 'local_only'
  | 'final_uploaded'
  | 'original_backed_up'
  | 'original_missing_local'

export interface Project {
  id: string
  name: string
  created_at: string
  updated_at: string
  thumbnail_path: string | null
  status: ProjectStatus
  storage_mode: StorageMode
  media_count: number
  duration_seconds: number | null
  size_bytes: number | null
  has_thumbnail: boolean
}

export interface MediaAsset {
  id: string
  project_id: string
  type: string
  storage_kind: 'copied' | 'referenced'
  original_filename: string
  relative_path: string | null
  duration_seconds: number | null
  width: number | null
  height: number | null
  size_bytes: number | null
  description: string | null
  category: string | null
  tags: string[]
  proxy_ready: boolean
  created_at: string
}

export interface ImportOptions {
  sourcePath: string
  copy: boolean
  confirmLarge?: boolean
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface Job {
  id: string
  project_id: string
  kind: string
  status: JobStatus
  progress: number
  message: string | null
  error_message: string | null
}

export interface TranscriptSegment {
  idx: number
  start_seconds: number
  end_seconds: number
  text: string
}

export interface Transcript {
  id: string
  language: string | null
  provider: string
  model: string
  plain_text: string
  segments: TranscriptSegment[]
}

export interface CutKeep {
  start: number
  end: number
  label?: string
  reason?: string
}

export interface AiChange {
  type: string
  keep?: CutKeep[]
  remove?: { start: number; end: number; reason?: string }[]
  // For type === 'commands': structured editor commands from the action layer.
  // Typed as unknown[] here to avoid an import cycle with editor/commands.ts;
  // the AI chat narrows them to EditorCommand[] when dispatching.
  commands?: unknown[]
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  change: AiChange | null
  change_status: 'proposed' | 'applied' | 'rejected' | null
  created_at: string
}

export interface ColorGrade {
  brightness: number // 1 = normal
  contrast: number // 1 = normal
  saturation: number // 1 = normal
}

// Spatial transform applied when compositing a clip onto the frame.
export interface Transform {
  scale: number // 1 = fit
  x: number // horizontal offset, fraction of frame width (-1..1)
  y: number // vertical offset, fraction of frame height (-1..1)
  rotation: number // degrees
}

// Green-screen / chroma key.
export interface ChromaKey {
  enabled: boolean
  color: string // "#rrggbb" key color
  similarity: number // 0..1 how close a pixel must be to be keyed
  smoothness: number // 0..1 feather at the edge
}

// Rectangular reveal mask (fractions of the frame, 0..1).
export interface MaskRect {
  x: number
  y: number
  w: number
  h: number
}

// One animation keyframe at clip-local time `t` (seconds). Any subset of the
// animatable properties may be present.
export interface Keyframe {
  t: number
  opacity?: number
  scale?: number
  x?: number
  y?: number
  rotation?: number
}

export interface TimelineElement {
  id: string
  type: 'video' | 'audio' | 'text'
  media_id?: string
  // Source in/out for media clips (seconds within the source file).
  source_start?: number
  source_end?: number
  // Placement on the timeline (seconds).
  timeline_start: number
  timeline_end?: number
  // Text clip payload.
  text?: string
  // ---- Per-clip effects ----
  color?: ColorGrade
  opacity?: number // 0..1, default 1
  transform?: Transform
  fadeIn?: number // seconds, dissolve from black / fade opacity in
  fadeOut?: number // seconds
  chroma?: ChromaKey
  mask?: MaskRect | null
  // Source sub-rectangle to show (fractions 0..1). Absent = whole frame.
  crop?: MaskRect | null
  // Mirror the clip when compositing.
  flipH?: boolean
  flipV?: boolean
  // Playback speed multiplier (1 = normal). Currently editorial metadata.
  speed?: number
  keyframes?: Keyframe[]
  // Audio mixing (video + audio clips).
  volume?: number // 0..1, default 1
  audioFadeIn?: number // seconds
  audioFadeOut?: number // seconds
  // Link ("magnet") group: clips that share a groupId move together and are
  // highlighted when any one of them is selected (e.g. a video and the audio
  // split from it, or text pinned over a shot).
  groupId?: string
}

export type TrackKind = 'video' | 'audio' | 'text'

export interface TimelineTrack {
  id: string
  kind: TrackKind
  name: string
  order: number
  elements: TimelineElement[]
  muted?: boolean
  volume?: number // 0..1, audio/video tracks
  // Show/play toggle: when true the track's content is not shown (video/text)
  // and not played (audio) — in the preview AND the export.
  hidden?: boolean
  // Lock: the track's clips can't be moved, trimmed, or edited on the timeline.
  locked?: boolean
}

// Project output canvas: compositing resolution + frame rate. Chosen in the
// create panel; the preview and renderer both use it.
export interface CanvasSpec {
  width: number
  height: number
  fps: number
}

export interface TimelineData {
  duration: number
  canvas?: CanvasSpec
  tracks: TimelineTrack[]
}

// Export options chosen in the export panel.
export interface RenderOptions {
  container: 'mp4' | 'mov' | 'webm'
  quality: 'high' | 'medium' | 'low'
  width?: number | null
  height?: number | null
  fps?: number | null
  filename?: string | null
  // Absolute path from the native save dialog (desktop only).
  output_path?: string | null
}

export interface Timeline {
  id: string
  version: number
  data: TimelineData
  created_at: string
}

// Thrown when a request needs explicit confirmation (HTTP 409).
export class ConfirmationRequiredError extends Error {}
// Back-compat alias for the import flow.
export const LargeFileError = ConfirmationRequiredError

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!resp.ok) {
    let detail = resp.statusText
    try {
      const body = await resp.json()
      detail = body.detail ?? detail
    } catch {
      // ignore non-JSON error bodies
    }
    if (resp.status === 409) throw new ConfirmationRequiredError(detail)
    throw new Error(detail)
  }
  return resp.json() as Promise<T>
}

// The desktop shell injects this bridge; it is absent in a plain browser.
interface PyWebviewBridge {
  api?: {
    pick_video_file?: () => Promise<string | null>
    // Native "Save as…" dialog for choosing an export location.
    pick_save_path?: (suggestedName: string) => Promise<string | null>
    // Detachable AI agent window (see editor/agentBridge.ts).
    open_agent_window?: (projectId: string) => Promise<void>
    close_agent_window?: () => Promise<void>
    dispatch_to_editor?: (json: string) => Promise<void>
  }
}
declare global {
  interface Window {
    pywebview?: PyWebviewBridge
    // Globals the desktop shell calls to relay agent-window messages into the
    // main editor window (set/cleared by editor/agentBridge.ts).
    __agentDispatch?: (json: string) => void
    __agentClosed?: () => void
  }
}

export const desktop = {
  isAvailable: () => Boolean(window.pywebview?.api?.pick_video_file),
  pickVideoFile: async (): Promise<string | null> => {
    if (!window.pywebview?.api?.pick_video_file) return null
    return window.pywebview.api.pick_video_file()
  },
  // True when the native "Save as…" dialog is available (desktop shell).
  canPickSavePath: () => Boolean(window.pywebview?.api?.pick_save_path),
  pickSavePath: async (suggestedName: string): Promise<string | null> => {
    if (!window.pywebview?.api?.pick_save_path) return null
    return window.pywebview.api.pick_save_path(suggestedName)
  },
}

export const api = {
  health: () => request<{ status: string; app: string }>('/health'),
  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (name: string, canvas?: CanvasSpec) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(canvas ? { name, canvas } : { name }),
    }),
  deleteProject: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/api/projects/${id}`, {
      method: 'DELETE',
    }),
  importMedia: (projectId: string, opts: ImportOptions) =>
    request<MediaAsset>(`/api/projects/${projectId}/media/import`, {
      method: 'POST',
      body: JSON.stringify({
        source_path: opts.sourcePath,
        copy: opts.copy,
        confirm_large: opts.confirmLarge ?? false,
      }),
    }),
  listMedia: (projectId: string) =>
    request<MediaAsset[]>(`/api/projects/${projectId}/media`),
  updateMedia: (
    mediaId: string,
    patch: { category?: string | null; tags?: string[]; description?: string | null },
  ) =>
    request<MediaAsset>(`/api/media/${mediaId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  // Cache-busted so a new thumbnail shows after re-import.
  projectThumbnailUrl: (project: Project) =>
    `/api/projects/${project.id}/thumbnail?v=${encodeURIComponent(project.updated_at)}`,
  mediaFileUrl: (mediaId: string) => `/api/media/${mediaId}/file`,
  // The preview decodes this: an optimized proxy when ready, else the original.
  mediaPreviewUrl: (mediaId: string) => `/api/media/${mediaId}/preview`,
  getProxyStatus: (mediaId: string) =>
    request<{ ready: boolean }>(`/api/media/${mediaId}/proxy`),
  mediaThumbnailUrl: (mediaId: string) => `/api/media/${mediaId}/thumbnail`,
  transcribe: (projectId: string, confirmLong = false) =>
    request<Job>(`/api/projects/${projectId}/transcribe`, {
      method: 'POST',
      body: JSON.stringify({ confirm_long: confirmLong }),
    }),
  getJob: (jobId: string) => request<Job>(`/api/jobs/${jobId}`),
  getTranscript: (projectId: string) =>
    request<Transcript>(`/api/projects/${projectId}/transcript`),
  getMessages: (projectId: string) =>
    request<AiMessage[]>(`/api/projects/${projectId}/ai/messages`),
  sendMessage: (projectId: string, content: string) =>
    request<AiMessage[]>(`/api/projects/${projectId}/ai/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  applyChange: (projectId: string, messageId: string) =>
    request<Timeline>(
      `/api/projects/${projectId}/ai/messages/${messageId}/apply`,
      { method: 'POST' },
    ),
  getTimeline: (projectId: string) =>
    request<Timeline>(`/api/projects/${projectId}/timeline`),
  saveTimeline: (projectId: string, data: TimelineData) =>
    request<Timeline>(`/api/projects/${projectId}/timeline`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),
  getWaveform: (mediaId: string) =>
    request<{ peaks: number[] }>(`/api/media/${mediaId}/waveform`),
  render: (projectId: string, options?: RenderOptions) =>
    request<Job>(`/api/projects/${projectId}/render`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),
  getExports: (projectId: string) =>
    request<MediaAsset[]>(`/api/projects/${projectId}/exports`),
  mediaFilmstripUrl: (mediaId: string) => `/api/media/${mediaId}/filmstrip`,
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—:—'
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return '—'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
