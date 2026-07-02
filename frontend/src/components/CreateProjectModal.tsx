import { useState } from 'react'

interface Props {
  onCancel: () => void
  onCreate: (name: string) => Promise<void>
}

export function CreateProjectModal({ onCancel, onCreate }: Props) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Start a new project</h2>
        <p>
          Name your project. You'll import a video and choose how to store it in
          the next steps.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <label htmlFor="project-name">Project name</label>
        <input
          id="project-name"
          autoFocus
          value={name}
          placeholder="e.g. Create Tutorial 11"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}
