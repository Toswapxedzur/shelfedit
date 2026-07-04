import { useMemo, useState } from 'react'
import type { CanvasSpec } from '../api/client'

interface Props {
  onCancel: () => void
  onCreate: (name: string, canvas: CanvasSpec) => Promise<void>
}

const ASPECTS = [
  { id: '16:9', label: 'Landscape', hint: '16:9', w: 16, h: 9 },
  { id: '9:16', label: 'Vertical', hint: '9:16', w: 9, h: 16 },
  { id: '1:1', label: 'Square', hint: '1:1', w: 1, h: 1 },
] as const

const RES_TIERS = [
  { id: 720, label: '720p' },
  { id: 1080, label: '1080p' },
  { id: 1440, label: '1440p' },
] as const

const FPS_OPTIONS = [24, 30, 60] as const

// Even dimensions (H.264 requires them), derived from aspect + the shorter side.
function computeCanvas(aspectId: string, shorter: number, fps: number): CanvasSpec {
  const a = ASPECTS.find((x) => x.id === aspectId) ?? ASPECTS[0]
  const even = (n: number) => Math.round(n / 2) * 2
  const long = even((shorter * Math.max(a.w, a.h)) / Math.min(a.w, a.h))
  const short = even(shorter)
  const [width, height] = a.h > a.w ? [short, long] : [long, short]
  return { width, height, fps }
}

export function CreateProjectModal({ onCancel, onCreate }: Props) {
  const [name, setName] = useState('')
  const [aspect, setAspect] = useState<string>('16:9')
  const [tier, setTier] = useState<number>(1080)
  const [fps, setFps] = useState<number>(30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canvas = useMemo(() => computeCanvas(aspect, tier, fps), [aspect, tier, fps])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed, canvas)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Start a new project</h2>
        <p>Name your project and choose its canvas. You'll import a video next.</p>
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

        <label>Aspect ratio</label>
        <div className="chip-row">
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`chip ${aspect === a.id ? 'active' : ''}`}
              onClick={() => setAspect(a.id)}
            >
              <span
                className="aspect-swatch"
                style={{ aspectRatio: `${a.w} / ${a.h}` }}
              />
              {a.label}
              <span className="chip-hint">{a.hint}</span>
            </button>
          ))}
        </div>

        <div className="field-row">
          <div className="field">
            <label>Resolution</label>
            <select value={tier} onChange={(e) => setTier(Number(e.target.value))}>
              {RES_TIERS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Frame rate</label>
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="canvas-summary">
          Canvas: {canvas.width} × {canvas.height} · {canvas.fps} fps
        </div>

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
