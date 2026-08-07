// Timecode helpers for the editor (mm:ss.cs).

export function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds)
  const mm = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.floor((s * 100) % 100)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(
    cs,
  ).padStart(2, '0')}`
}

export function formatClipDuration(seconds: number): string {
  const s = Math.max(0, seconds)
  const mm = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  if (mm > 0) return `${mm}:${String(ss).padStart(2, '0')}`
  return `${s.toFixed(1)}s`
}
