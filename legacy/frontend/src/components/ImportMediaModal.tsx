import { useState } from 'react'
import {
  api,
  desktop,
  LargeFileError,
  type Project,
} from '../api/client'

interface Props {
  project: Project
  onCancel: () => void
  onImported: () => void
}

export function ImportMediaModal({ project, onCancel, onImported }: Props) {
  const [path, setPath] = useState('')
  const [copy, setCopy] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmLarge, setConfirmLarge] = useState(false)
  const nativePicker = desktop.isAvailable()

  const choose = async () => {
    setError(null)
    const picked = await desktop.pickVideoFile()
    if (picked) {
      setPath(picked)
      setConfirmLarge(false)
    }
  }

  const doImport = async (withConfirm: boolean) => {
    const src = path.trim()
    if (!src) return
    setBusy(true)
    setError(null)
    try {
      await api.importMedia(project.id, {
        sourcePath: src,
        copy,
        confirmLarge: withConfirm,
      })
      onImported()
    } catch (e) {
      if (e instanceof LargeFileError) {
        setConfirmLarge(true)
        setError(e.message)
      } else {
        setError(e instanceof Error ? e.message : 'Import failed')
      }
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Import a video</h2>
        <p>
          Import into <strong>{project.name}</strong>. Your original file is
          never modified.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <label>Video file</label>
        <div className="file-row">
          <input
            value={path}
            placeholder={
              nativePicker
                ? 'Click Choose… to pick a video'
                : '/absolute/path/to/video.mp4'
            }
            onChange={(e) => {
              setPath(e.target.value)
              setConfirmLarge(false)
            }}
          />
          {nativePicker && (
            <button className="btn" onClick={choose} disabled={busy}>
              Choose…
            </button>
          )}
        </div>
        {!nativePicker && (
          <div className="hint">
            Tip: in the packaged desktop app you get a native file picker. In the
            browser, paste the file's absolute path.
          </div>
        )}

        <label style={{ marginTop: 16 }}>How to store it</label>
        <div className="choice-group">
          <button
            className={`choice ${copy ? 'selected' : ''}`}
            onClick={() => setCopy(true)}
            disabled={busy}
          >
            <div className="choice-title">Copy into project</div>
            <div className="choice-sub">
              Self-contained. Uses more disk, safe if you move the original.
            </div>
          </button>
          <button
            className={`choice ${!copy ? 'selected' : ''}`}
            onClick={() => setCopy(false)}
            disabled={busy}
          >
            <div className="choice-title">Reference in place</div>
            <div className="choice-sub">
              No duplicate. Saves disk, but the original must stay put.
            </div>
          </button>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => doImport(confirmLarge)}
            disabled={busy || !path.trim()}
          >
            {busy
              ? 'Importing…'
              : confirmLarge
                ? 'Import anyway'
                : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
