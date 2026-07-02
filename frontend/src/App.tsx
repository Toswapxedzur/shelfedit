import { useEffect, useState } from 'react'
import './styles/app.css'
import { api, type Project } from './api/client'
import { Sidebar, type View } from './components/Sidebar'
import { ProjectCard } from './components/ProjectCard'
import { CreateProjectModal } from './components/CreateProjectModal'
import { ImportMediaModal } from './components/ImportMediaModal'

export default function App() {
  const [view, setView] = useState<View>('home')
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [online, setOnline] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [importTarget, setImportTarget] = useState<Project | null>(null)

  const refresh = async () => {
    try {
      await api.health()
      setOnline(true)
      const list = await api.listProjects()
      setProjects(list)
      setError(null)
    } catch (e) {
      setOnline(false)
      setError(
        e instanceof Error
          ? `Cannot reach the local backend: ${e.message}`
          : 'Cannot reach the local backend',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const handleCreate = async (name: string) => {
    const created = await api.createProject(name)
    setShowCreate(false)
    await refresh()
    // Flow straight into importing a video for the new project.
    setImportTarget(created)
  }

  const handleImported = async () => {
    setImportTarget(null)
    await refresh()
  }

  const handleDelete = async (project: Project) => {
    const ok = window.confirm(
      `Remove "${project.name}"?\n\nThis hides the project. Your original video files are never deleted.`,
    )
    if (!ok) return
    try {
      await api.deleteProject(project.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete project')
    }
  }

  return (
    <div className="app">
      <Sidebar active={view} onSelect={setView} />

      <main className="main">
        <div className="main-header">
          <div>
            <h1>
              {view === 'home'
                ? 'Your Projects'
                : view === 'cloud'
                  ? 'Cloud Storage'
                  : 'Settings'}
            </h1>
            <div className="subtitle">
              {view === 'home'
                ? 'Local-first AI video editing. Nothing leaves your machine.'
                : view === 'cloud'
                  ? 'Deferred for now — everything stays local.'
                  : 'Configuration lives in backend/.env for this version.'}
            </div>
          </div>
          <div className="status-pill">
            <span
              className={`dot ${online === null ? '' : online ? 'ok' : 'bad'}`}
            />
            {online === null
              ? 'Connecting…'
              : online
                ? 'Backend connected'
                : 'Backend offline'}
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {view === 'home' && (
          <>
            {loading ? (
              <div className="empty-hint">Loading projects…</div>
            ) : (
              <div className="grid">
                {projects.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    onDelete={handleDelete}
                    onImport={setImportTarget}
                  />
                ))}
                <button
                  className="card create-card"
                  onClick={() => setShowCreate(true)}
                >
                  <span className="plus">+</span>
                  Start Creation
                </button>
              </div>
            )}
            {!loading && projects.length === 0 && (
              <div className="empty-hint">
                No projects yet. Click “Start Creation” to make your first one.
              </div>
            )}
          </>
        )}

        {view === 'cloud' && (
          <div className="empty-hint">
            Cloud storage is intentionally deferred. This app is local-first.
          </div>
        )}

        {view === 'settings' && (
          <div className="empty-hint">
            Settings (OpenAI key, storage folder, import limits) are read from{' '}
            <code>backend/.env</code> in this version. A visual settings page
            comes later.
          </div>
        )}
      </main>

      {showCreate && (
        <CreateProjectModal
          onCancel={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}

      {importTarget && (
        <ImportMediaModal
          project={importTarget}
          onCancel={() => setImportTarget(null)}
          onImported={handleImported}
        />
      )}
    </div>
  )
}
