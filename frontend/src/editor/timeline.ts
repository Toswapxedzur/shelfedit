// Pure timeline helpers + immutable edit operations.
// Every operation returns a new TimelineData with the duration recomputed.

import type {
  ColorGrade,
  TimelineData,
  TimelineElement,
  TimelineTrack,
  TrackKind,
} from '../api/client'

export const MIN_CLIP = 0.1 // seconds
export const DEFAULT_TEXT_DUR = 3

export const NEUTRAL_COLOR: ColorGrade = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
}

export function clipDuration(el: TimelineElement): number {
  if (el.type === 'text') {
    const end = el.timeline_end ?? el.timeline_start + DEFAULT_TEXT_DUR
    return Math.max(MIN_CLIP, end - el.timeline_start)
  }
  return Math.max(MIN_CLIP, (el.source_end ?? 0) - (el.source_start ?? 0))
}

export function clipEnd(el: TimelineElement): number {
  return el.timeline_start + clipDuration(el)
}

export function computeDuration(data: TimelineData): number {
  let max = 0
  for (const t of data.tracks) {
    for (const el of t.elements) max = Math.max(max, clipEnd(el))
  }
  return max
}

function clone(data: TimelineData): TimelineData {
  return JSON.parse(JSON.stringify(data))
}

function withDuration(data: TimelineData): TimelineData {
  data.duration = computeDuration(data)
  return data
}

export function findClip(
  data: TimelineData,
  clipId: string,
): { track: TimelineTrack; el: TimelineElement } | null {
  for (const track of data.tracks) {
    const el = track.elements.find((e) => e.id === clipId)
    if (el) return { track, el }
  }
  return null
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

// The clip currently under `time` on a given track (or null).
export function clipAt(track: TimelineTrack, time: number): TimelineElement | null {
  for (const el of track.elements) {
    if (time >= el.timeline_start && time < clipEnd(el)) return el
  }
  return null
}

export function moveClip(
  data: TimelineData,
  clipId: string,
  newStart: number,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data
  const start = Math.max(0, newStart)
  const delta = start - found.el.timeline_start
  found.el.timeline_start = start
  if (found.el.type === 'text' && found.el.timeline_end != null) {
    found.el.timeline_end += delta
  }
  return withDuration(next)
}

// Is a clip of `elType` allowed to live on a track of `trackKind`?
// Video clips → video tracks, audio → audio, text → text.
export function kindCompatible(elType: TimelineElement['type'], trackKind: TrackKind): boolean {
  return elType === trackKind
}

// All clip ids linked to `clipId` (its whole magnet group), including itself.
export function linkedIds(data: TimelineData, clipId: string): string[] {
  const found = findClip(data, clipId)
  if (!found || !found.el.groupId) return found ? [clipId] : []
  const gid = found.el.groupId
  const ids: string[] = []
  for (const t of data.tracks) for (const e of t.elements) if (e.groupId === gid) ids.push(e.id)
  return ids
}

// Does [start,end) overlap any clip already on `track` (ignoring `excludeIds`)?
export function rangeOverlaps(
  track: TimelineTrack,
  start: number,
  end: number,
  excludeIds: Set<string>,
): boolean {
  for (const el of track.elements) {
    if (excludeIds.has(el.id)) continue
    if (start < clipEnd(el) - 1e-6 && end > el.timeline_start + 1e-6) return true
  }
  return false
}

// Move a clip (and its magnet group) by placing the primary at `newStart`, and
// optionally onto `targetTrackId`. Linked members keep their own tracks and all
// shift by the same clamped delta so the group stays locked together.
export function moveClipGroup(
  data: TimelineData,
  clipId: string,
  newStart: number,
  targetTrackId?: string,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data

  const gid = found.el.groupId
  const members = gid
    ? next.tracks.flatMap((t) => t.elements.filter((e) => e.groupId === gid))
    : [found.el]

  // Clamp the shared delta so no member crosses 0.
  const rawDelta = Math.max(0, newStart) - found.el.timeline_start
  const minStart = Math.min(...members.map((m) => m.timeline_start))
  const delta = Math.max(rawDelta, -minStart)

  for (const m of members) {
    m.timeline_start = Math.max(0, m.timeline_start + delta)
    if (m.type === 'text' && m.timeline_end != null) m.timeline_end += delta
  }

  // Re-home the primary onto another (compatible) track if requested.
  if (targetTrackId && targetTrackId !== found.track.id) {
    const target = next.tracks.find((t) => t.id === targetTrackId)
    if (target && kindCompatible(found.el.type, target.kind)) {
      found.track.elements = found.track.elements.filter((e) => e.id !== clipId)
      target.elements.push(found.el)
      target.elements.sort((a, b) => a.timeline_start - b.timeline_start)
    }
  }
  return withDuration(next)
}

export function trimStart(
  data: TimelineData,
  clipId: string,
  newStart: number,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data
  const el = found.el
  const start = Math.max(0, newStart)

  if (el.type === 'text') {
    const end = el.timeline_end ?? el.timeline_start + DEFAULT_TEXT_DUR
    el.timeline_start = Math.min(start, end - MIN_CLIP)
    return withDuration(next)
  }

  const delta = start - el.timeline_start
  const srcStart = (el.source_start ?? 0) + delta
  const clampedSrcStart = Math.max(
    0,
    Math.min(srcStart, (el.source_end ?? 0) - MIN_CLIP),
  )
  const actualDelta = clampedSrcStart - (el.source_start ?? 0)
  el.source_start = clampedSrcStart
  el.timeline_start = el.timeline_start + actualDelta
  return withDuration(next)
}

export function trimEnd(
  data: TimelineData,
  clipId: string,
  newEnd: number,
  sourceMax?: number,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data
  const el = found.el

  if (el.type === 'text') {
    el.timeline_end = Math.max(el.timeline_start + MIN_CLIP, newEnd)
    return withDuration(next)
  }

  const desiredDur = Math.max(MIN_CLIP, newEnd - el.timeline_start)
  let srcEnd = (el.source_start ?? 0) + desiredDur
  if (sourceMax != null) srcEnd = Math.min(srcEnd, sourceMax)
  el.source_end = Math.max((el.source_start ?? 0) + MIN_CLIP, srcEnd)
  return withDuration(next)
}

export function splitClip(
  data: TimelineData,
  clipId: string,
  atTime: number,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data
  const { track, el } = found
  const offset = atTime - el.timeline_start
  if (offset <= MIN_CLIP || offset >= clipDuration(el) - MIN_CLIP) return data

  // `right` is a copy of the original clip (keeps its original end).
  const right: TimelineElement = JSON.parse(JSON.stringify(el))
  right.id = newId('clip')
  right.timeline_start = atTime

  if (el.type === 'text') {
    // Left half now ends at the split; right half keeps the original end.
    el.timeline_end = atTime
  } else {
    const splitSrc = (el.source_start ?? 0) + offset
    right.source_start = splitSrc
    el.source_end = splitSrc
  }

  const idx = track.elements.findIndex((e) => e.id === clipId)
  track.elements.splice(idx + 1, 0, right)
  return withDuration(next)
}

export function deleteClip(data: TimelineData, clipId: string): TimelineData {
  const next = clone(data)
  for (const track of next.tracks) {
    track.elements = track.elements.filter((e) => e.id !== clipId)
  }
  return withDuration(next)
}

// Delete clips AND close the gaps they leave on their own track: every later
// clip on the same track slides left by the total removed duration in front of
// it (the standard "ripple delete" in NLEs).
export function rippleDelete(data: TimelineData, clipIds: string[]): TimelineData {
  const set = new Set(clipIds)
  if (set.size === 0) return data
  const next = clone(data)
  for (const track of next.tracks) {
    const removed = track.elements.filter((e) => set.has(e.id))
    if (removed.length === 0) continue
    const remaining = track.elements.filter((e) => !set.has(e.id))
    for (const el of remaining) {
      let shift = 0
      for (const r of removed) {
        if (clipEnd(r) <= el.timeline_start + 1e-6) shift += clipDuration(r)
      }
      if (shift > 0) {
        el.timeline_start = Math.max(0, el.timeline_start - shift)
        if (el.type === 'text' && el.timeline_end != null) el.timeline_end -= shift
      }
    }
    remaining.sort((a, b) => a.timeline_start - b.timeline_start)
    track.elements = remaining
  }
  return withDuration(next)
}

// Duplicate each clip, dropping the copy immediately after the original on the
// same track.
export function duplicateClips(data: TimelineData, clipIds: string[]): TimelineData {
  const set = new Set(clipIds)
  if (set.size === 0) return data
  const next = clone(data)
  for (const track of next.tracks) {
    const originals = track.elements.filter((e) => set.has(e.id))
    for (const el of originals) {
      const copy: TimelineElement = JSON.parse(JSON.stringify(el))
      copy.id = newId('clip')
      const dur = clipDuration(el)
      copy.timeline_start = clipEnd(el)
      if (copy.type === 'text' && copy.timeline_end != null) {
        copy.timeline_end = copy.timeline_start + dur
      }
      track.elements.push(copy)
    }
    track.elements.sort((a, b) => a.timeline_start - b.timeline_start)
  }
  return withDuration(next)
}

export function addClip(
  data: TimelineData,
  trackId: string,
  el: TimelineElement,
): TimelineData {
  const next = clone(data)
  const track = next.tracks.find((t) => t.id === trackId)
  if (!track) return data
  track.elements.push(el)
  track.elements.sort((a, b) => a.timeline_start - b.timeline_start)
  return withDuration(next)
}

export function setClipColor(
  data: TimelineData,
  clipId: string,
  color: ColorGrade,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data
  found.el.color = color
  return next
}

// Generic merge of effect fields into a clip (nested objects are replaced
// wholesale, which is what the inspector sends).
export function updateClip(
  data: TimelineData,
  clipId: string,
  patch: Partial<TimelineElement>,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data
  Object.assign(found.el, patch)
  return next
}

// Add (or replace) a keyframe at clip-local time `t` capturing the given props.
export function addKeyframe(
  data: TimelineData,
  clipId: string,
  kf: import('../api/client').Keyframe,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data
  const keys = found.el.keyframes ? [...found.el.keyframes] : []
  const idx = keys.findIndex((k) => Math.abs(k.t - kf.t) < 0.01)
  if (idx >= 0) keys[idx] = kf
  else keys.push(kf)
  keys.sort((a, b) => a.t - b.t)
  found.el.keyframes = keys
  return next
}

export function removeKeyframe(
  data: TimelineData,
  clipId: string,
  t: number,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found || !found.el.keyframes) return data
  found.el.keyframes = found.el.keyframes.filter(
    (k) => Math.abs(k.t - t) >= 0.01,
  )
  if (found.el.keyframes.length === 0) delete found.el.keyframes
  return next
}

export function setClipText(
  data: TimelineData,
  clipId: string,
  text: string,
): TimelineData {
  const next = clone(data)
  const found = findClip(next, clipId)
  if (!found) return data
  found.el.text = text
  return next
}

export function setTrackMuted(
  data: TimelineData,
  trackId: string,
  muted: boolean,
): TimelineData {
  const next = clone(data)
  const track = next.tracks.find((t) => t.id === trackId)
  if (track) track.muted = muted
  return next
}

// Show/play toggle + lock, per track (item 3). `hidden` hides video/text and
// silences audio, in the preview and the export; `locked` freezes its clips.
export function setTrackFlags(
  data: TimelineData,
  trackId: string,
  patch: { hidden?: boolean; locked?: boolean },
): TimelineData {
  const next = clone(data)
  const track = next.tracks.find((t) => t.id === trackId)
  if (track) Object.assign(track, patch)
  return next
}

// Link clips into one magnet group (or merge existing groups). A single clip
// can't be linked to itself, so we need at least two.
export function linkClips(data: TimelineData, clipIds: string[]): TimelineData {
  if (clipIds.length < 2) return data
  const next = clone(data)
  const gid = newId('grp')
  const set = new Set(clipIds)
  for (const t of next.tracks) for (const e of t.elements) if (set.has(e.id)) e.groupId = gid
  return next
}

// Break the magnet group(s) that the given clips belong to.
export function unlinkClips(data: TimelineData, clipIds: string[]): TimelineData {
  const next = clone(data)
  const set = new Set(clipIds)
  const groups = new Set<string>()
  for (const t of next.tracks)
    for (const e of t.elements) if (set.has(e.id) && e.groupId) groups.add(e.groupId)
  for (const t of next.tracks)
    for (const e of t.elements) if (e.groupId && groups.has(e.groupId)) delete e.groupId
  return next
}

// Give a set of clips a fresh shared group id (used when auto-linking A/V on
// import, or pinning text over a shot). Exposed so callers can build the pair.
export function makeGroupId(): string {
  return newId('grp')
}

// ---- Track operations ----

export function addTrack(
  data: TimelineData,
  kind: TimelineTrack['kind'],
  atIndex = 0,
): TimelineData {
  const next = clone(data)
  const count = next.tracks.filter((t) => t.kind === kind).length + 1
  const name =
    kind === 'video' ? `Video ${count}` : kind === 'audio' ? `Audio ${count}` : `Text ${count}`
  const track: TimelineTrack = {
    id: newId('trk'),
    kind,
    name,
    order: 0,
    elements: [],
  }
  const i = Math.max(0, Math.min(atIndex, next.tracks.length))
  next.tracks.splice(i, 0, track)
  next.tracks.forEach((t, idx) => (t.order = idx))
  return next
}

export function removeTrack(data: TimelineData, trackId: string): TimelineData {
  const next = clone(data)
  next.tracks = next.tracks.filter((t) => t.id !== trackId)
  next.tracks.forEach((t, idx) => (t.order = idx))
  return withDuration(next)
}

// Move a track up (-1) or down (+1) in the stack. Order = compositing layer:
// tracks earlier in the array are drawn on top.
export function moveTrack(
  data: TimelineData,
  trackId: string,
  dir: -1 | 1,
): TimelineData {
  const next = clone(data)
  const i = next.tracks.findIndex((t) => t.id === trackId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= next.tracks.length) return data
  const tmp = next.tracks[i]
  next.tracks[i] = next.tracks[j]
  next.tracks[j] = tmp
  next.tracks.forEach((t, idx) => (t.order = idx))
  return next
}

export function makeVideoClip(
  mediaId: string,
  duration: number,
  timelineStart = 0,
): TimelineElement {
  return {
    id: newId('clip'),
    type: 'video',
    media_id: mediaId,
    source_start: 0,
    source_end: duration,
    timeline_start: timelineStart,
    color: { ...NEUTRAL_COLOR },
  }
}

export function makeAudioClip(
  mediaId: string,
  duration: number,
  timelineStart = 0,
): TimelineElement {
  return {
    id: newId('clip'),
    type: 'audio',
    media_id: mediaId,
    source_start: 0,
    source_end: duration,
    timeline_start: timelineStart,
  }
}

export function makeTextClip(text: string, timelineStart: number): TimelineElement {
  return {
    id: newId('clip'),
    type: 'text',
    text,
    timeline_start: timelineStart,
    timeline_end: timelineStart + DEFAULT_TEXT_DUR,
  }
}
