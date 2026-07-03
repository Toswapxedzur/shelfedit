import type {
  ChromaKey,
  ColorGrade,
  TimelineElement,
  Transform,
} from '../api/client'
import { addKeyframe, clipDuration, removeKeyframe, updateClip } from './timeline'
import { NEUTRAL_TRANSFORM, resolveProps } from './effects'
import type { EditorState } from './useEditor'

const NEUTRAL_COLOR: ColorGrade = { brightness: 1, contrast: 1, saturation: 1 }
const DEFAULT_CHROMA: ChromaKey = {
  enabled: true,
  color: '#00ff00',
  similarity: 0.4,
  smoothness: 0.12,
}

interface Props {
  clip: TimelineElement
  editor: EditorState
  playhead: number
}

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="insp-field">
      <span className="insp-field-label">
        {label}
        <span className="insp-field-val">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  )
}

export function Inspector({ clip, editor, playhead }: Props) {
  const dur = clipDuration(clip)
  const lt = Math.max(0, Math.min(playhead - clip.timeline_start, dur))
  const isVideo = clip.type === 'video'
  const isText = clip.type === 'text'
  const hasAudio = clip.type === 'video' || clip.type === 'audio'

  const patch = (p: Partial<TimelineElement>) =>
    editor.commit((d) => updateClip(d, clip.id, p))

  const tf: Transform = { ...NEUTRAL_TRANSFORM, ...clip.transform }
  const setTf = (p: Partial<Transform>) => patch({ transform: { ...tf, ...p } })

  const color: ColorGrade = { ...NEUTRAL_COLOR, ...clip.color }
  const setColor = (p: Partial<ColorGrade>) => patch({ color: { ...color, ...p } })

  const chroma = clip.chroma
  const keyframes = clip.keyframes ?? []

  const addKf = () => {
    const p = resolveProps(clip, lt, dur)
    editor.commit((d) =>
      addKeyframe(d, clip.id, {
        t: lt,
        opacity: p.opacity,
        scale: p.scale,
        x: p.x,
        y: p.y,
        rotation: p.rotation,
      }),
    )
  }

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-kind">{clip.type}</span>
        <span className="insp-name">
          {isText ? clip.text || 'Text' : clip.media_id ? 'clip' : ''}
        </span>
      </div>

      <section>
        <div className="insp-title">Layer</div>
        <Range
          label="Opacity"
          value={clip.opacity ?? 1}
          min={0}
          max={1}
          step={0.02}
          onChange={(v) => patch({ opacity: v })}
        />
        <Range label="Scale" value={tf.scale} min={0.1} max={3} step={0.02} onChange={(v) => setTf({ scale: v })} />
        <Range label="X" value={tf.x} min={-1} max={1} step={0.01} onChange={(v) => setTf({ x: v })} />
        <Range label="Y" value={tf.y} min={-1} max={1} step={0.01} onChange={(v) => setTf({ y: v })} />
        <Range label="Rotate" value={tf.rotation} min={-180} max={180} step={1} onChange={(v) => setTf({ rotation: v })} />
      </section>

      <section>
        <div className="insp-title">Transitions</div>
        <label className="insp-field">
          <span className="insp-field-label">Fade in (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={clip.fadeIn ?? 0}
            onChange={(e) => patch({ fadeIn: +e.target.value })}
          />
        </label>
        <label className="insp-field">
          <span className="insp-field-label">Fade out (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={clip.fadeOut ?? 0}
            onChange={(e) => patch({ fadeOut: +e.target.value })}
          />
        </label>
      </section>

      <section>
        <div className="insp-title">
          Keyframes
          <button className="mini-btn" onClick={addKf} title="Add keyframe at playhead">
            + @ {lt.toFixed(1)}s
          </button>
        </div>
        {keyframes.length === 0 ? (
          <div className="insp-empty">No keyframes. Move the playhead, set values, then add.</div>
        ) : (
          <div className="kf-list">
            {keyframes.map((k) => (
              <div className="kf-row" key={k.t}>
                <span>{k.t.toFixed(2)}s</span>
                <button
                  className="mini-btn"
                  onClick={() => editor.commit((d) => removeKeyframe(d, clip.id, k.t))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {isVideo && (
        <section>
          <div className="insp-title">Color</div>
          <Range label="Brightness" value={color.brightness} min={0.2} max={2} step={0.05} onChange={(v) => setColor({ brightness: v })} />
          <Range label="Contrast" value={color.contrast} min={0.2} max={2} step={0.05} onChange={(v) => setColor({ contrast: v })} />
          <Range label="Saturation" value={color.saturation} min={0} max={2} step={0.05} onChange={(v) => setColor({ saturation: v })} />
        </section>
      )}

      {isVideo && (
        <section>
          <div className="insp-title">
            Green screen
            <label className="insp-toggle">
              <input
                type="checkbox"
                checked={!!chroma?.enabled}
                onChange={(e) =>
                  patch({
                    chroma: { ...DEFAULT_CHROMA, ...chroma, enabled: e.target.checked },
                  })
                }
              />
              on
            </label>
          </div>
          {chroma?.enabled && (
            <>
              <label className="insp-field">
                <span className="insp-field-label">Key color</span>
                <input
                  type="color"
                  value={chroma.color}
                  onChange={(e) => patch({ chroma: { ...chroma, color: e.target.value } })}
                />
              </label>
              <Range label="Similarity" value={chroma.similarity} min={0} max={1} step={0.02} onChange={(v) => patch({ chroma: { ...chroma, similarity: v } })} />
              <Range label="Smoothness" value={chroma.smoothness} min={0} max={0.5} step={0.01} onChange={(v) => patch({ chroma: { ...chroma, smoothness: v } })} />
            </>
          )}
        </section>
      )}

      {isVideo && (
        <section>
          <div className="insp-title">
            Mask
            <label className="insp-toggle">
              <input
                type="checkbox"
                checked={!!clip.mask}
                onChange={(e) =>
                  patch({ mask: e.target.checked ? { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } : null })
                }
              />
              on
            </label>
          </div>
          {clip.mask && (
            <>
              <Range label="X" value={clip.mask.x} min={0} max={1} step={0.01} onChange={(v) => patch({ mask: { ...clip.mask!, x: v } })} />
              <Range label="Y" value={clip.mask.y} min={0} max={1} step={0.01} onChange={(v) => patch({ mask: { ...clip.mask!, y: v } })} />
              <Range label="Width" value={clip.mask.w} min={0.05} max={1} step={0.01} onChange={(v) => patch({ mask: { ...clip.mask!, w: v } })} />
              <Range label="Height" value={clip.mask.h} min={0.05} max={1} step={0.01} onChange={(v) => patch({ mask: { ...clip.mask!, h: v } })} />
            </>
          )}
        </section>
      )}

      {hasAudio && (
        <section>
          <div className="insp-title">Audio</div>
          <Range label="Volume" value={clip.volume ?? 1} min={0} max={1} step={0.02} onChange={(v) => patch({ volume: v })} />
          <label className="insp-field">
            <span className="insp-field-label">Audio fade in (s)</span>
            <input type="number" min={0} step={0.1} value={clip.audioFadeIn ?? 0} onChange={(e) => patch({ audioFadeIn: +e.target.value })} />
          </label>
          <label className="insp-field">
            <span className="insp-field-label">Audio fade out (s)</span>
            <input type="number" min={0} step={0.1} value={clip.audioFadeOut ?? 0} onChange={(e) => patch({ audioFadeOut: +e.target.value })} />
          </label>
        </section>
      )}
    </div>
  )
}
