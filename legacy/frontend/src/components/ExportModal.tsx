import { useMemo, useState } from 'react'
import {
  api,
  desktop,
  type CanvasSpec,
  type Job,
  type RenderOptions,
} from '../api/client'

interface Props {
  projectId: string
  projectName: string
  canvas?: CanvasSpec
  onCancel: () => void
  onStarted: (job: Job) => void
}

const FORMATS = [
  { id: 'mp4', label: 'MP4 · H.264' },
  { id: 'mov', label: 'MOV · H.264' },
  { id: 'webm', label: 'WebM · VP9' },
] as const

const QUALITIES = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
] as const

// Even dimensions scaled to a target shorter-side, preserving the canvas aspect.
function scaledTo(canvas: CanvasSpec, shorter: number): { width: number; height: number } {
  const even = (n: number) => Math.round(n / 2) * 2
  const isPortrait = canvas.height > canvas.width
  const ratio = isPortrait ? canvas.height / canvas.width : canvas.width / canvas.height
  const long = even(shorter * ratio)
  const short = even(shorter)
  return isPortrait ? { width: short, height: long } : { width: long, height: short }
}

function sanitize(name: string): string {
  const keep = name.replace(/[^\w .-]/g, '_').trim()
  return keep || 'export'
}

export function ExportModal({ projectId, projectName, canvas, onCancel, onStarted }: Props) {
  const cv = useMemo<CanvasSpec>(
    () => canvas ?? { width: 1280, height: 720, fps: 30 },
    [canvas],
  )

  const [format, setFormat] = useState<RenderOptions['container']>('mp4')
  const [quality, setQuality] = useState<RenderOptions['quality']>('high')
  const [resId, setResId] = useState<string>('source')
  const [fpsId, setFpsId] = useState<string>('source')
  const [filename, setFilename] = useState<string>(sanitize(projectName))
  const [savePath, setSavePath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canPickPath = desktop.canPickSavePath()

  // Resolution options: the project canvas, plus any smaller standard tiers.
  const resOptions = useMemo(() => {
    const shorterOfCanvas = Math.min(cv.width, cv.height)
    const tiers = [2160, 1440, 1080, 720, 480].filter((t) => t < shorterOfCanvas)
    return [
      { id: 'source', label: `Project (${cv.width}×${cv.height})`, dims: null as null | { width: number; height: number } },
      ...tiers.map((t) => {
        const d = scaledTo(cv, t)
        return { id: String(t), label: `${t}p (${d.width}×${d.height})`, dims: d }
      }),
    ]
  }, [cv])

  const chosenDims = resOptions.find((r) => r.id === resId)?.dims ?? null
  const chosenFps = fpsId === 'source' ? cv.fps : Number(fpsId)

  const chooseLocation = async () => {
    const suggested = `${sanitize(filename)}.${format}`
    const p = await desktop.pickSavePath(suggested)
    if (p) setSavePath(p)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    const options: RenderOptions = {
      container: format,
      quality,
      width: chosenDims?.width ?? null,
      height: chosenDims?.height ?? null,
      fps: chosenFps,
      filename: sanitize(filename),
      output_path: savePath,
    }
    try {
      const job = await api.render(projectId, options)
      onStarted(job)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start export')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export video</h2>
        <p>Choose the output format and where to save it.</p>
        {error && <div className="error-banner">{error}</div>}

        <label>Format</label>
        <div className="chip-row">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip ${format === f.id ? 'active' : ''}`}
              onClick={() => setFormat(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="field-row">
          <div className="field">
            <label>Resolution</label>
            <select value={resId} onChange={(e) => setResId(e.target.value)}>
              {resOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Frame rate</label>
            <select value={fpsId} onChange={(e) => setFpsId(e.target.value)}>
              <option value="source">Project ({cv.fps} fps)</option>
              <option value="24">24 fps</option>
              <option value="30">30 fps</option>
              <option value="60">60 fps</option>
            </select>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Quality</label>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as RenderOptions['quality'])}
            >
              {QUALITIES.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>File name</label>
            <input
              value={filename}
              onChange={(e) => {
                setFilename(e.target.value)
                setSavePath(null) // a typed name overrides a previously picked path
              }}
              placeholder="export"
            />
          </div>
        </div>

        {canPickPath && (
          <div className="save-location">
            <label>Save to</label>
            <div className="save-location-row">
              <span className="save-path" title={savePath ?? undefined}>
                {savePath ?? 'Project folder (default)'}
              </span>
              <button type="button" className="btn small" onClick={chooseLocation}>
                Choose location…
              </button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Starting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  )
}
