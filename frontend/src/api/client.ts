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
}

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
    throw new Error(detail)
  }
  return resp.json() as Promise<T>
}

export const api = {
  health: () => request<{ status: string; app: string }>('/health'),
  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (name: string) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  deleteProject: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/api/projects/${id}`, {
      method: 'DELETE',
    }),
}
