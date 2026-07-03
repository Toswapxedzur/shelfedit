// Pure effect resolution: turn a clip's static props + keyframes + fades into
// the concrete values used when compositing a single frame.

import type { Keyframe, TimelineElement, Transform } from '../api/client'

export const NEUTRAL_TRANSFORM: Transform = {
  scale: 1,
  x: 0,
  y: 0,
  rotation: 0,
}

export interface ResolvedProps {
  opacity: number
  scale: number
  x: number
  y: number
  rotation: number
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

// Linear interpolation of a single keyframed property at clip-local time `lt`.
// Keyframes that don't define the property are ignored; if none define it the
// static fallback is used.
function sampleKeyframed(
  keys: Keyframe[],
  prop: keyof Omit<Keyframe, 't'>,
  lt: number,
  fallback: number,
): number {
  const defined = keys
    .filter((k) => k[prop] != null)
    .sort((a, b) => a.t - b.t)
  if (defined.length === 0) return fallback
  if (lt <= defined[0].t) return defined[0][prop] as number
  const last = defined[defined.length - 1]
  if (lt >= last.t) return last[prop] as number
  for (let i = 0; i < defined.length - 1; i++) {
    const a = defined[i]
    const b = defined[i + 1]
    if (lt >= a.t && lt <= b.t) {
      const span = b.t - a.t || 1
      const f = (lt - a.t) / span
      const av = a[prop] as number
      const bv = b[prop] as number
      return av + (bv - av) * f
    }
  }
  return fallback
}

// Fade multiplier (0..1) from fadeIn / fadeOut at clip-local time.
function fadeMultiplier(
  lt: number,
  duration: number,
  fadeIn?: number,
  fadeOut?: number,
): number {
  let m = 1
  if (fadeIn && fadeIn > 0 && lt < fadeIn) m *= lt / fadeIn
  if (fadeOut && fadeOut > 0 && lt > duration - fadeOut) {
    m *= Math.max(0, (duration - lt) / fadeOut)
  }
  return clamp01(m)
}

export function resolveProps(
  el: TimelineElement,
  localTime: number,
  duration: number,
): ResolvedProps {
  const t = el.transform ?? NEUTRAL_TRANSFORM
  const baseOpacity = el.opacity ?? 1
  const keys = el.keyframes ?? []

  const opacity = sampleKeyframed(keys, 'opacity', localTime, baseOpacity)
  const scale = sampleKeyframed(keys, 'scale', localTime, t.scale)
  const x = sampleKeyframed(keys, 'x', localTime, t.x)
  const y = sampleKeyframed(keys, 'y', localTime, t.y)
  const rotation = sampleKeyframed(keys, 'rotation', localTime, t.rotation)

  const fade = fadeMultiplier(localTime, duration, el.fadeIn, el.fadeOut)

  return {
    opacity: clamp01(opacity * fade),
    scale,
    x,
    y,
    rotation,
  }
}

// Audio gain (0..1) from per-clip volume + audio fades.
export function resolveAudioGain(
  el: TimelineElement,
  localTime: number,
  duration: number,
): number {
  const base = el.volume ?? 1
  const fade = fadeMultiplier(localTime, duration, el.audioFadeIn, el.audioFadeOut)
  return clamp01(base * fade)
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  )
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Zero out the alpha of pixels close to the key color (in place).
export function applyChromaKey(
  img: ImageData,
  color: string,
  similarity: number,
  smoothness: number,
): void {
  const [kr, kg, kb] = hexToRgb(color)
  const data = img.data
  const maxDist = 441.6729559300637 // sqrt(255^2 * 3)
  const s = similarity * maxDist
  const feather = Math.max(1, smoothness * maxDist)
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - kr
    const dg = data[i + 1] - kg
    const db = data[i + 2] - kb
    const dist = Math.sqrt(dr * dr + dg * dg + db * db)
    if (dist < s) {
      data[i + 3] = 0
    } else if (dist < s + feather) {
      data[i + 3] = Math.round(data[i + 3] * ((dist - s) / feather))
    }
  }
}
