// Editor action layer.
//
// A single, typed vocabulary of edit operations. Both the toolbar/mode UI and
// the AI agent describe an edit as an `EditorCommand`; `applyCommand` turns it
// into a new TimelineData using the pure ops in timeline.ts. Keeping every
// mutation funnelled through here means the agent and the buttons share exactly
// one code path, and each command is trivially undoable (it's just a producer
// passed to `editor.commit`).
//
// `COMMAND_REGISTRY` is the machine-readable catalogue of everything the editor
// can do — its `params` schema is what an AI is handed so it can call any
// operation, including ones that have no button yet ("AI-only"). UI buttons/
// inspectors are just convenient front-ends over the same commands.

import type {
  ColorGrade,
  MaskRect,
  TimelineData,
  TimelineElement,
  Transform,
} from '../api/client'
import {
  addClip,
  addTrack,
  deleteClip,
  duplicateClips,
  findClip,
  linkClips,
  makeTextClip,
  moveClipGroup,
  moveTrack,
  removeTrack,
  rippleDelete,
  setTrackFlags,
  splitClip,
  trimEnd,
  trimStart,
  unlinkClips,
  updateClip,
} from './timeline'
import { NEUTRAL_TRANSFORM } from './effects'

export type EditorCommand =
  // ---- Timeline structure ----
  | { type: 'split'; clipId: string; at: number }
  | { type: 'delete'; clipIds: string[] }
  | { type: 'rippleDelete'; clipIds: string[] }
  | { type: 'duplicate'; clipIds: string[] }
  | { type: 'moveClip'; clipId: string; start: number; trackId?: string }
  | { type: 'trimStart'; clipId: string; at: number }
  | { type: 'trimEnd'; clipId: string; at: number; sourceMax?: number }
  // ---- Generic props ----
  | { type: 'setProps'; clipIds: string[]; patch: Partial<TimelineElement> }
  // ---- Audio ----
  | { type: 'setVolume'; clipIds: string[]; volume: number }
  | { type: 'setAudioFade'; clipIds: string[]; audioFadeIn?: number; audioFadeOut?: number }
  // ---- Opacity / fades ----
  | { type: 'setOpacity'; clipIds: string[]; opacity: number }
  | { type: 'setFade'; clipIds: string[]; fadeIn?: number; fadeOut?: number }
  // ---- Speed ----
  | { type: 'setSpeed'; clipIds: string[]; speed: number }
  // ---- Color ----
  | { type: 'setColor'; clipIds: string[]; color: Partial<ColorGrade> }
  // ---- Transform ----
  | { type: 'setScale'; clipIds: string[]; scale: number }
  | { type: 'setRotation'; clipIds: string[]; degrees: number }
  | { type: 'rotateBy'; clipIds: string[]; degrees: number }
  | { type: 'nudge'; clipIds: string[]; dx: number; dy: number }
  | { type: 'resetTransform'; clipIds: string[] }
  | { type: 'flipH'; clipIds: string[] }
  | { type: 'flipV'; clipIds: string[] }
  // ---- Crop (mask) ----
  | { type: 'setCrop'; clipIds: string[]; crop: MaskRect | null }
  // ---- Linking (magnet) ----
  | { type: 'link'; clipIds: string[] }
  | { type: 'unlink'; clipIds: string[] }
  // ---- Text ----
  | { type: 'addText'; at: number; trackId?: string; text?: string; x?: number; y?: number }
  // ---- Tracks ----
  | { type: 'addTrack'; kind: 'video' | 'audio' | 'text' }
  | { type: 'removeTrack'; trackId: string }
  | { type: 'moveTrack'; trackId: string; dir: -1 | 1 }
  | { type: 'setTrackHidden'; trackId: string; hidden: boolean }
  | { type: 'setTrackLocked'; trackId: string; locked: boolean }

// Merge a partial transform onto a clip's current transform.
function mergeTransform(el: TimelineElement, patch: Partial<Transform>): Transform {
  return { ...NEUTRAL_TRANSFORM, ...(el.transform ?? {}), ...patch }
}

// Human-readable label for a command (used by the agent transcript / history).
export function describeCommand(cmd: EditorCommand): string {
  switch (cmd.type) {
    case 'split':
      return `Split clip at ${cmd.at.toFixed(2)}s`
    case 'delete':
      return `Delete ${cmd.clipIds.length} clip(s)`
    case 'rippleDelete':
      return `Ripple-delete ${cmd.clipIds.length} clip(s)`
    case 'duplicate':
      return `Duplicate ${cmd.clipIds.length} clip(s)`
    case 'moveClip':
      return `Move clip to ${cmd.start.toFixed(2)}s`
    case 'trimStart':
      return `Trim clip start to ${cmd.at.toFixed(2)}s`
    case 'trimEnd':
      return `Trim clip end to ${cmd.at.toFixed(2)}s`
    case 'setProps':
      return `Update ${cmd.clipIds.length} clip(s)`
    case 'setVolume':
      return `Set volume ${Math.round(cmd.volume * 100)}%`
    case 'setAudioFade':
      return `Set audio fade`
    case 'setOpacity':
      return `Set opacity ${Math.round(cmd.opacity * 100)}%`
    case 'setFade':
      return `Set fade`
    case 'setSpeed':
      return `Set speed ${cmd.speed}×`
    case 'setColor':
      return `Color grade`
    case 'setScale':
      return `Scale ${cmd.scale.toFixed(2)}×`
    case 'setRotation':
      return `Rotate to ${cmd.degrees}°`
    case 'rotateBy':
      return `Rotate ${cmd.degrees > 0 ? '+' : ''}${cmd.degrees}°`
    case 'nudge':
      return `Nudge clip`
    case 'resetTransform':
      return `Reset transform`
    case 'flipH':
      return `Flip horizontal`
    case 'flipV':
      return `Flip vertical`
    case 'setCrop':
      return cmd.crop ? `Crop` : `Clear crop`
    case 'link':
      return `Link ${cmd.clipIds.length} clip(s)`
    case 'unlink':
      return `Unlink clip(s)`
    case 'addText':
      return `Add text`
    case 'addTrack':
      return `Add ${cmd.kind} track`
    case 'removeTrack':
      return `Remove track`
    case 'moveTrack':
      return `Move track ${cmd.dir < 0 ? 'up' : 'down'}`
    case 'setTrackHidden':
      return cmd.hidden ? `Hide track` : `Show track`
    case 'setTrackLocked':
      return cmd.locked ? `Lock track` : `Unlock track`
  }
}

function updateEach(
  data: TimelineData,
  clipIds: string[],
  patch: (el: TimelineElement) => Partial<TimelineElement>,
): TimelineData {
  let d = data
  for (const id of clipIds) {
    const found = findClip(d, id)
    if (found) d = updateClip(d, id, patch(found.el))
  }
  return d
}

export function applyCommand(data: TimelineData, cmd: EditorCommand): TimelineData {
  switch (cmd.type) {
    case 'split':
      return splitClip(data, cmd.clipId, cmd.at)

    case 'delete': {
      let d = data
      for (const id of cmd.clipIds) d = deleteClip(d, id)
      return d
    }

    case 'rippleDelete':
      return rippleDelete(data, cmd.clipIds)

    case 'duplicate':
      return duplicateClips(data, cmd.clipIds)

    case 'moveClip':
      return moveClipGroup(data, cmd.clipId, cmd.start, cmd.trackId)

    case 'trimStart':
      return trimStart(data, cmd.clipId, cmd.at)

    case 'trimEnd':
      return trimEnd(data, cmd.clipId, cmd.at, cmd.sourceMax)

    case 'setProps': {
      let d = data
      for (const id of cmd.clipIds) d = updateClip(d, id, cmd.patch)
      return d
    }

    case 'setVolume':
      return updateEach(data, cmd.clipIds, () => ({ volume: clamp01(cmd.volume) }))

    case 'setAudioFade':
      return updateEach(data, cmd.clipIds, () => ({
        ...(cmd.audioFadeIn != null ? { audioFadeIn: Math.max(0, cmd.audioFadeIn) } : {}),
        ...(cmd.audioFadeOut != null ? { audioFadeOut: Math.max(0, cmd.audioFadeOut) } : {}),
      }))

    case 'setOpacity':
      return updateEach(data, cmd.clipIds, () => ({ opacity: clamp01(cmd.opacity) }))

    case 'setFade':
      return updateEach(data, cmd.clipIds, () => ({
        ...(cmd.fadeIn != null ? { fadeIn: Math.max(0, cmd.fadeIn) } : {}),
        ...(cmd.fadeOut != null ? { fadeOut: Math.max(0, cmd.fadeOut) } : {}),
      }))

    case 'setSpeed':
      return updateEach(data, cmd.clipIds, () => ({ speed: Math.max(0.1, cmd.speed) }))

    case 'setColor':
      return updateEach(data, cmd.clipIds, (el) => ({
        color: {
          brightness: cmd.color.brightness ?? el.color?.brightness ?? 1,
          contrast: cmd.color.contrast ?? el.color?.contrast ?? 1,
          saturation: cmd.color.saturation ?? el.color?.saturation ?? 1,
        },
      }))

    case 'setScale':
      return updateEach(data, cmd.clipIds, (el) => ({
        transform: mergeTransform(el, { scale: Math.max(0.05, cmd.scale) }),
      }))

    case 'setRotation':
      return updateEach(data, cmd.clipIds, (el) => ({
        transform: mergeTransform(el, { rotation: cmd.degrees }),
      }))

    case 'rotateBy':
      return updateEach(data, cmd.clipIds, (el) => ({
        transform: mergeTransform(el, {
          rotation: (el.transform?.rotation ?? 0) + cmd.degrees,
        }),
      }))

    case 'nudge':
      return updateEach(data, cmd.clipIds, (el) => ({
        transform: mergeTransform(el, {
          x: (el.transform?.x ?? 0) + cmd.dx,
          y: (el.transform?.y ?? 0) + cmd.dy,
        }),
      }))

    case 'resetTransform':
      return updateEach(data, cmd.clipIds, () => ({ transform: { ...NEUTRAL_TRANSFORM } }))

    case 'flipH':
      return updateEach(data, cmd.clipIds, (el) => ({ flipH: !el.flipH }))

    case 'flipV':
      return updateEach(data, cmd.clipIds, (el) => ({ flipV: !el.flipV }))

    case 'setCrop':
      return updateEach(data, cmd.clipIds, () => ({ crop: cmd.crop }))

    case 'link':
      return linkClips(data, cmd.clipIds)

    case 'unlink':
      return unlinkClips(data, cmd.clipIds)

    case 'addText': {
      const trackId = cmd.trackId ?? data.tracks.find((t) => t.kind === 'text')?.id
      if (!trackId) return data
      const clip = makeTextClip(cmd.text ?? 'New text', cmd.at)
      if (cmd.x != null || cmd.y != null) {
        clip.transform = { ...NEUTRAL_TRANSFORM, x: cmd.x ?? 0, y: cmd.y ?? 0 }
      }
      return addClip(data, trackId, clip)
    }

    case 'addTrack':
      return addTrack(data, cmd.kind, 0)

    case 'removeTrack':
      return removeTrack(data, cmd.trackId)

    case 'moveTrack':
      return moveTrack(data, cmd.trackId, cmd.dir)

    case 'setTrackHidden':
      return setTrackFlags(data, cmd.trackId, { hidden: cmd.hidden })

    case 'setTrackLocked':
      return setTrackFlags(data, cmd.trackId, { locked: cmd.locked })
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

// ---- Machine-readable command catalogue (for AI tool-calling) --------------

export interface CommandParam {
  name: string
  type: 'number' | 'string' | 'boolean' | 'clipIds' | 'trackId' | 'rect'
  optional?: boolean
  desc: string
}

export interface CommandSpec {
  id: EditorCommand['type']
  label: string
  desc: string
  params: CommandParam[]
  // Whether the editor exposes a dedicated button/control for it. AI-only
  // commands (false) are fully functional but simply have no UI yet.
  hasUI: boolean
}

const CLIP_IDS: CommandParam = {
  name: 'clipIds',
  type: 'clipIds',
  desc: 'Ids of the clips to act on',
}

export const COMMAND_REGISTRY: CommandSpec[] = [
  { id: 'split', label: 'Split', desc: 'Cut a clip in two at a time', hasUI: true, params: [{ name: 'clipId', type: 'string', desc: 'Clip id' }, { name: 'at', type: 'number', desc: 'Timeline seconds' }] },
  { id: 'delete', label: 'Delete', desc: 'Remove clips', hasUI: true, params: [CLIP_IDS] },
  { id: 'rippleDelete', label: 'Ripple delete', desc: 'Remove clips and close the gap', hasUI: true, params: [CLIP_IDS] },
  { id: 'duplicate', label: 'Duplicate', desc: 'Copy clips', hasUI: true, params: [CLIP_IDS] },
  { id: 'moveClip', label: 'Move', desc: 'Move a clip (and its link group) to a start time, optionally to another track', hasUI: true, params: [{ name: 'clipId', type: 'string', desc: 'Clip id' }, { name: 'start', type: 'number', desc: 'New start (s)' }, { name: 'trackId', type: 'trackId', optional: true, desc: 'Target track' }] },
  { id: 'trimStart', label: 'Trim start', desc: 'Set a clip in-point', hasUI: true, params: [{ name: 'clipId', type: 'string', desc: 'Clip id' }, { name: 'at', type: 'number', desc: 'New start (s)' }] },
  { id: 'trimEnd', label: 'Trim end', desc: 'Set a clip out-point', hasUI: true, params: [{ name: 'clipId', type: 'string', desc: 'Clip id' }, { name: 'at', type: 'number', desc: 'New end (s)' }] },
  { id: 'setProps', label: 'Set properties', desc: 'Patch arbitrary clip fields', hasUI: false, params: [CLIP_IDS, { name: 'patch', type: 'string', desc: 'Object of fields to set' }] },
  { id: 'setVolume', label: 'Volume', desc: 'Set clip volume (0..1)', hasUI: true, params: [CLIP_IDS, { name: 'volume', type: 'number', desc: '0..1' }] },
  { id: 'setAudioFade', label: 'Audio fade', desc: 'Set audio fade in/out (s)', hasUI: true, params: [CLIP_IDS, { name: 'audioFadeIn', type: 'number', optional: true, desc: 'Seconds' }, { name: 'audioFadeOut', type: 'number', optional: true, desc: 'Seconds' }] },
  { id: 'setOpacity', label: 'Opacity', desc: 'Set clip opacity (0..1)', hasUI: true, params: [CLIP_IDS, { name: 'opacity', type: 'number', desc: '0..1' }] },
  { id: 'setFade', label: 'Fade', desc: 'Set visual fade in/out (s)', hasUI: true, params: [CLIP_IDS, { name: 'fadeIn', type: 'number', optional: true, desc: 'Seconds' }, { name: 'fadeOut', type: 'number', optional: true, desc: 'Seconds' }] },
  { id: 'setSpeed', label: 'Speed', desc: 'Set playback speed multiplier', hasUI: true, params: [CLIP_IDS, { name: 'speed', type: 'number', desc: 'e.g. 0.5, 2' }] },
  { id: 'setColor', label: 'Color grade', desc: 'Set brightness/contrast/saturation', hasUI: true, params: [CLIP_IDS, { name: 'brightness', type: 'number', optional: true, desc: '1 = normal' }, { name: 'contrast', type: 'number', optional: true, desc: '1 = normal' }, { name: 'saturation', type: 'number', optional: true, desc: '1 = normal' }] },
  { id: 'setScale', label: 'Scale', desc: 'Set clip scale', hasUI: true, params: [CLIP_IDS, { name: 'scale', type: 'number', desc: '1 = fit' }] },
  { id: 'setRotation', label: 'Rotate to', desc: 'Set absolute rotation (deg)', hasUI: true, params: [CLIP_IDS, { name: 'degrees', type: 'number', desc: 'Degrees' }] },
  { id: 'rotateBy', label: 'Rotate by', desc: 'Rotate by a delta (deg)', hasUI: true, params: [CLIP_IDS, { name: 'degrees', type: 'number', desc: 'Delta degrees' }] },
  { id: 'nudge', label: 'Nudge', desc: 'Offset clip position (fractions of canvas)', hasUI: false, params: [CLIP_IDS, { name: 'dx', type: 'number', desc: '-1..1' }, { name: 'dy', type: 'number', desc: '-1..1' }] },
  { id: 'resetTransform', label: 'Reset transform', desc: 'Clear scale/position/rotation', hasUI: true, params: [CLIP_IDS] },
  { id: 'flipH', label: 'Flip horizontal', desc: 'Mirror left-right', hasUI: true, params: [CLIP_IDS] },
  { id: 'flipV', label: 'Flip vertical', desc: 'Mirror top-bottom', hasUI: true, params: [CLIP_IDS] },
  { id: 'setCrop', label: 'Crop', desc: 'Reveal only a sub-rectangle (mask). Null clears it.', hasUI: true, params: [CLIP_IDS, { name: 'crop', type: 'rect', optional: true, desc: '{x,y,w,h} 0..1 or null' }] },
  { id: 'link', label: 'Link', desc: 'Group clips so they move together', hasUI: true, params: [CLIP_IDS] },
  { id: 'unlink', label: 'Unlink', desc: 'Break a link group', hasUI: true, params: [CLIP_IDS] },
  { id: 'addText', label: 'Add text', desc: 'Add a text clip', hasUI: true, params: [{ name: 'at', type: 'number', desc: 'Timeline seconds' }, { name: 'text', type: 'string', optional: true, desc: 'Text content' }, { name: 'trackId', type: 'trackId', optional: true, desc: 'Text track' }] },
  { id: 'addTrack', label: 'Add track', desc: 'Add a video/audio/text track', hasUI: true, params: [{ name: 'kind', type: 'string', desc: 'video|audio|text' }] },
  { id: 'removeTrack', label: 'Remove track', desc: 'Delete a track and its clips', hasUI: true, params: [{ name: 'trackId', type: 'trackId', desc: 'Track id' }] },
  { id: 'moveTrack', label: 'Move track', desc: 'Reorder a track up/down', hasUI: true, params: [{ name: 'trackId', type: 'trackId', desc: 'Track id' }, { name: 'dir', type: 'number', desc: '-1 up, 1 down' }] },
  { id: 'setTrackHidden', label: 'Show/hide track', desc: 'Toggle a track visible/audible', hasUI: true, params: [{ name: 'trackId', type: 'trackId', desc: 'Track id' }, { name: 'hidden', type: 'boolean', desc: 'true = hidden' }] },
  { id: 'setTrackLocked', label: 'Lock track', desc: 'Toggle a track locked', hasUI: true, params: [{ name: 'trackId', type: 'trackId', desc: 'Track id' }, { name: 'locked', type: 'boolean', desc: 'true = locked' }] },
]

// Compact JSON schema string to hand to an AI as its tool catalogue.
export function commandSchemaJSON(): string {
  return JSON.stringify(
    COMMAND_REGISTRY.map((c) => ({
      type: c.id,
      description: c.desc,
      params: c.params.map((p) => ({ name: p.name, type: p.type, optional: !!p.optional, desc: p.desc })),
    })),
    null,
    2,
  )
}
