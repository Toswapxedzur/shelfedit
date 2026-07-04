// Editor action layer.
//
// A single, typed vocabulary of edit operations. Both the toolbar/mode UI and
// (later) the AI agent describe an edit as an `EditorCommand`; `applyCommand`
// turns it into a new TimelineData using the pure ops in timeline.ts. Keeping
// every mutation funnelled through here means the agent and the buttons share
// exactly one code path, and each command is trivially undoable (it's just a
// producer passed to `editor.commit`).

import type { TimelineData, TimelineElement } from '../api/client'
import {
  addClip,
  addTrack,
  deleteClip,
  duplicateClips,
  findClip,
  makeTextClip,
  rippleDelete,
  splitClip,
  updateClip,
} from './timeline'
import { NEUTRAL_TRANSFORM } from './effects'

export type EditorCommand =
  | { type: 'split'; clipId: string; at: number }
  | { type: 'delete'; clipIds: string[] }
  | { type: 'rippleDelete'; clipIds: string[] }
  | { type: 'duplicate'; clipIds: string[] }
  | { type: 'setProps'; clipIds: string[]; patch: Partial<TimelineElement> }
  | { type: 'flipH'; clipIds: string[] }
  | { type: 'flipV'; clipIds: string[] }
  | { type: 'addText'; at: number; trackId?: string; text?: string; x?: number; y?: number }
  | { type: 'addTrack'; kind: 'video' | 'audio' | 'text' }

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
    case 'setProps':
      return `Update ${cmd.clipIds.length} clip(s)`
    case 'flipH':
      return `Flip horizontal`
    case 'flipV':
      return `Flip vertical`
    case 'addText':
      return `Add text`
    case 'addTrack':
      return `Add ${cmd.kind} track`
  }
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

    case 'setProps': {
      let d = data
      for (const id of cmd.clipIds) d = updateClip(d, id, cmd.patch)
      return d
    }

    case 'flipH': {
      let d = data
      for (const id of cmd.clipIds) {
        const found = findClip(d, id)
        if (found) d = updateClip(d, id, { flipH: !found.el.flipH })
      }
      return d
    }

    case 'flipV': {
      let d = data
      for (const id of cmd.clipIds) {
        const found = findClip(d, id)
        if (found) d = updateClip(d, id, { flipV: !found.el.flipV })
      }
      return d
    }

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
  }
}
