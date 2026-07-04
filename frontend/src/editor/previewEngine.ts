// Preview playback engine — native HTMLVideoElement model.
//
// Why this shape: browser-native <video> playback is what web/desktop editors
// rely on for smooth, full-resolution playback. The browser owns hardware
// decoding, buffering, variable-frame-rate handling and audio/video sync — the
// exact things a hand-rolled WebCodecs pipeline kept getting wrong (underruns,
// slow-motion, silent audio). So we stop fighting it and let it do the work:
//
//   • keep ONE <video> element per source file,
//   • play the element(s) active at the playhead,
//   • composite the element onto the canvas each frame (the compositor draws it),
//   • take audio straight from the element (native, always in sync).
//
// The timeline clock is genlocked to the primary active video's own currentTime,
// so the playhead can never run faster/slower than the picture or the sound (and
// pausing lands on the exact frame). A wall clock bridges gaps / audio-only
// regions where there is no video to lock to.
//
// This mirrors how BBC VideoContext and browser-native NLEs drive playback.

import { api, type TimelineData, type TimelineElement, type TimelineTrack } from '../api/client'
import { clipDuration, clipEnd } from './timeline'
import { resolveAudioGain } from './effects'

// What the compositor draws: a drawable source plus its intrinsic pixel size.
// For this engine the drawable is the live <video> element itself (a valid
// source for both ctx.drawImage and WebGL texImage2D).
export interface FrameCanvas {
  img: HTMLVideoElement
  width: number
  height: number
}

const EMPTY_DATA: TimelineData = { tracks: [], duration: 0 } as unknown as TimelineData

// Engine housekeeping tick: re-pick the primary clip, resync drifting sources,
// update volumes for fades, detect end of timeline.
const PUMP_MS = 30
// A non-primary source is nudged back into sync only when it drifts past this;
// small enough to stay tight, large enough that we almost never seek mid-play
// (a seek would hitch audio). The primary is never corrected — it *is* the clock.
const SYNC_TOLERANCE = 0.25

const perfNow = () => performance.now() / 1000

function sourceTimeOf(el: TimelineElement, t: number): number {
  return (el.source_start ?? 0) + (t - el.timeline_start)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// Everything we track for one physical media file (one media_id): a single
// <video> element the browser decodes/plays for us.
interface SourceEntry {
  mediaId: string
  el: HTMLVideoElement
  ready: Promise<void>
  loaded: boolean
}

export class PreviewEngine {
  private sources = new Map<string, SourceEntry>()
  private data: TimelineData = EMPTY_DATA
  private duration = 0
  private playing = false
  private pausedAt = 0

  // Genlock target: the video whose currentTime defines the timeline clock.
  private primaryMediaId: string | null = null
  private primaryClip: TimelineElement | null = null

  // Wall-clock fallback (used across gaps / audio-only regions).
  private wallPerf = 0
  private wallTL = 0

  private pumpTimer: number | null = null
  private readonly onEnded: () => void
  // Redraw hook: fired when a seek settles while paused, so the compositor can
  // repaint the just-decoded frame even if the seek landed after seekTo resolved
  // (large backward seeks on a big source can take longer than the safety wait).
  onSeekSettled: (() => void) | null = null

  // Scrub serialization: only one seek in flight, always converging to the
  // latest requested target so a fast scrub can't leave the frame behind.
  private seekTarget: number | null = null
  private seeking = false
  private seekPromise: Promise<void> | null = null

  constructor(onEnded: () => void) {
    this.onEnded = onEnded
  }

  // ---- public API --------------------------------------------------------

  setTimeline(data: TimelineData, duration: number): void {
    this.data = data
    this.duration = duration
  }

  isPlaying(): boolean {
    return this.playing
  }

  // Timeline time (seconds) right now. Genlocked to the primary video's own
  // clock while it is active, otherwise the wall clock. Never runs ahead of the
  // picture/sound, so pause always shows the exact displayed frame.
  currentTime(): number {
    if (!this.playing) return this.pausedAt
    const p = this.primaryClip
    if (p && this.primaryMediaId) {
      const entry = this.sources.get(this.primaryMediaId)
      if (entry && entry.loaded) {
        const tl = p.timeline_start + (entry.el.currentTime - (p.source_start ?? 0))
        if (tl >= p.timeline_start - 0.05 && tl < clipEnd(p) + 0.05) {
          return clamp(tl, 0, this.duration)
        }
      }
    }
    return clamp(this.wallTL + (perfNow() - this.wallPerf), 0, this.duration)
  }

  // The drawable for this clip right now (the live <video>), or null until its
  // dimensions are known. The element retains its last displayed frame, so the
  // compositor keeps showing the right picture even across brief seeks.
  frameFor(el: TimelineElement): FrameCanvas | null {
    const entry = this.sources.get(el.media_id as string)
    if (!entry) return null
    const v = entry.el
    if (!v.videoWidth || !v.videoHeight) return null
    return { img: v, width: v.videoWidth, height: v.videoHeight }
  }

  play(fromTimeline: number): void {
    this.pausedAt = clamp(fromTimeline, 0, this.duration)
    this.wallTL = this.pausedAt
    this.wallPerf = perfNow()
    this.playing = true
    this.pickPrimary(this.pausedAt)
    this.syncActive(this.pausedAt, true)
    if (this.pumpTimer == null) {
      this.pumpTimer = window.setInterval(() => this.pump(), PUMP_MS)
    }
  }

  pause(): void {
    if (this.playing) this.pausedAt = this.currentTime()
    this.playing = false
    if (this.pumpTimer != null) {
      window.clearInterval(this.pumpTimer)
      this.pumpTimer = null
    }
    for (const entry of this.sources.values()) {
      try {
        entry.el.pause()
      } catch {
        /* ignore */
      }
    }
  }

  // Point the preview at an exact time while paused (scrubbing). Resolves once
  // the frame for the final settled target is on screen so the caller redraws.
  async seekTo(t: number): Promise<void> {
    this.pausedAt = clamp(t, 0, this.duration)
    this.seekTarget = this.pausedAt
    if (this.seeking && this.seekPromise) return this.seekPromise
    this.seeking = true
    this.seekPromise = (async () => {
      try {
        while (this.seekTarget != null) {
          const target = this.seekTarget
          this.seekTarget = null
          await this.seekFrame(target)
        }
      } finally {
        this.seeking = false
        this.seekPromise = null
      }
    })()
    return this.seekPromise
  }

  private async seekFrame(t: number): Promise<void> {
    const { videos } = this.activeClips(t)
    await Promise.all(
      videos.map(async ({ el }) => {
        const entry = this.ensureSource(el.media_id as string)
        await entry.ready
        const v = entry.el
        try {
          v.pause()
        } catch {
          /* ignore */
        }
        const st = Math.max(0, sourceTimeOf(el, t))
        if (Math.abs(v.currentTime - st) < 1e-3 && v.readyState >= 2) return
        await new Promise<void>((resolve) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            v.removeEventListener('seeked', finish)
            resolve()
          }
          v.addEventListener('seeked', finish, { once: true })
          try {
            v.currentTime = st
          } catch {
            finish()
          }
          // Safety: never hang the scrub if 'seeked' doesn't fire. Generous so a
          // large backward seek on a big source resolves on the real 'seeked'
          // (the persistent listener also repaints if it lands even later).
          window.setTimeout(finish, 3000)
        })
      }),
    )
  }

  // Warm a source so its first frame is ready before playback / scrub.
  prepare(mediaId: string): void {
    this.ensureSource(mediaId)
  }

  // Proxies are not used by this engine: the browser decodes the original
  // directly (that is the whole point — no re-encode, full resolution). Kept for
  // interface compatibility; there is nothing to reopen when a proxy appears.
  dropSource(_mediaId: string): void {
    /* no-op */
  }

  // Warm every media file referenced by the timeline (metadata + first frames)
  // so cuts and the first play don't stall on cold demux.
  prepareAll(): void {
    const seen = new Set<string>()
    for (const track of this.data.tracks) {
      for (const el of track.elements) {
        const mediaId = el.media_id
        if (mediaId && !seen.has(mediaId)) {
          seen.add(mediaId)
          this.ensureSource(mediaId)
        }
      }
    }
  }

  stats(): string[] {
    const t = this.currentTime()
    const lines = [
      `clock=${t.toFixed(2)} play=${this.playing ? 'Y' : 'N'} prim=${
        this.primaryMediaId ? this.primaryMediaId.slice(0, 6) : '—'
      }`,
    ]
    const { videos, audios } = this.activeClips(t)
    for (const { el } of videos) {
      const v = this.sources.get(el.media_id as string)?.el
      const cur = v ? v.currentTime.toFixed(2) : '—'
      const want = sourceTimeOf(el, t).toFixed(2)
      lines.push(`vid rs${v?.readyState ?? 0} cur${cur} want${want}`)
    }
    for (const { el } of audios) {
      const v = this.sources.get(el.media_id as string)?.el
      lines.push(`aud vol${v ? v.volume.toFixed(2) : '—'}${v?.muted ? ' M' : ''}`)
    }
    return lines
  }

  dispose(): void {
    this.pause()
    for (const entry of this.sources.values()) {
      try {
        entry.el.pause()
        entry.el.removeAttribute('src')
        entry.el.load()
        entry.el.remove()
      } catch {
        /* ignore */
      }
    }
    this.sources.clear()
  }

  // ---- internals ---------------------------------------------------------

  private ensureSource(mediaId: string): SourceEntry {
    let entry = this.sources.get(mediaId)
    if (entry) return entry
    const el = document.createElement('video')
    // Decode the ORIGINAL file directly — the browser hardware-decodes it at
    // full resolution, which is what every desktop editor does.
    el.src = new URL(api.mediaFileUrl(mediaId), location.origin).href
    el.preload = 'auto'
    el.crossOrigin = 'anonymous' // keep the canvas untainted for chroma readback
    el.playsInline = true
    el.muted = true // unmuted per-clip when it becomes the active audio source
    el.disablePictureInPicture = true
    // Keep the element in the DOM but off-screen. A detached <video> gets its
    // decoding deprioritized by the browser (paused seeks can stall at
    // HAVE_METADATA and never produce a frame); an attached-but-off-screen one
    // decodes/seeks promptly. This is the standard hidden-<video> technique.
    el.style.cssText =
      'position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;'
    document.body.appendChild(el)
    entry = { mediaId, el, ready: Promise.resolve(), loaded: false }
    const e = entry
    // When a seek finishes while paused, repaint so the correct frame shows even
    // if it landed after our seek promise already resolved.
    el.addEventListener('seeked', () => {
      if (!this.playing) this.onSeekSettled?.()
    })
    e.ready = new Promise<void>((resolve) => {
      if (el.readyState >= 1) {
        e.loaded = true
        resolve()
        return
      }
      el.addEventListener(
        'loadedmetadata',
        () => {
          e.loaded = true
          resolve()
        },
        { once: true },
      )
      el.addEventListener('error', () => resolve(), { once: true })
    })
    el.load()
    this.sources.set(mediaId, entry)
    return entry
  }

  private activeClips(t: number): {
    videos: { track: TimelineTrack; el: TimelineElement }[]
    audios: { track: TimelineTrack; el: TimelineElement }[]
  } {
    const videos: { track: TimelineTrack; el: TimelineElement }[] = []
    const audios: { track: TimelineTrack; el: TimelineElement }[] = []
    for (const track of this.data.tracks) {
      if (track.kind !== 'video' && track.kind !== 'audio') continue
      // A hidden track shows/plays nothing (mirrors the export).
      if (track.hidden) continue
      for (const el of track.elements) {
        if (!el.media_id) continue
        if (t >= el.timeline_start && t < clipEnd(el)) {
          if (track.kind === 'video') videos.push({ track, el })
          else audios.push({ track, el })
        }
      }
    }
    return { videos, audios }
  }

  // Choose the video whose clock defines the timeline: the top-most active video
  // clip (last one drawn). None during a gap → the wall clock takes over.
  private pickPrimary(t: number): void {
    const { videos } = this.activeClips(t)
    const chosen = videos.length ? videos[videos.length - 1].el : null
    this.primaryClip = chosen
    this.primaryMediaId = chosen ? (chosen.media_id as string) : null
    if (!chosen) {
      this.wallTL = t
      this.wallPerf = perfNow()
    }
  }

  private pump(): void {
    if (!this.playing) return
    const t = this.currentTime()
    if (t >= this.duration - 1e-3) {
      this.onEnded()
      return
    }
    const p = this.primaryClip
    if (!p || t < p.timeline_start || t >= clipEnd(p)) {
      // The primary clip ended (or we were in a gap): keep the wall clock
      // continuous across the switch, then re-pick and hard-seek the new actives.
      this.wallTL = t
      this.wallPerf = perfNow()
      this.pickPrimary(t)
      this.syncActive(t, true)
    } else {
      this.syncActive(t, false)
    }
  }

  // Make the world match time `t`: play + sync every active source, set volumes
  // (so fades/mutes apply), and pause everything no longer active. `hardSeek`
  // forces the primary onto its exact source time (used at play/cut boundaries).
  private syncActive(t: number, hardSeek: boolean): void {
    const { videos, audios } = this.activeClips(t)
    const active = new Set<string>()

    for (const { el } of videos) {
      const mediaId = el.media_id as string
      active.add(mediaId)
      const entry = this.ensureSource(mediaId)
      const v = entry.el
      const want = Math.max(0, sourceTimeOf(el, t))
      const isPrimary = mediaId === this.primaryMediaId
      // The primary is the clock, so only reposition it on an explicit hardSeek.
      // Others are nudged only when they drift past the tolerance.
      if ((hardSeek && isPrimary) || Math.abs(v.currentTime - want) > SYNC_TOLERANCE) {
        try {
          v.currentTime = want
        } catch {
          /* ignore */
        }
      }
      if (this.playing && v.paused) void v.play().catch(() => {})
    }

    // Sources that only supply audio here (their video isn't active) still need
    // to be playing and seeked so the sound comes out.
    for (const { el } of audios) {
      const mediaId = el.media_id as string
      if (active.has(mediaId)) continue
      active.add(mediaId)
      const entry = this.ensureSource(mediaId)
      const v = entry.el
      const want = Math.max(0, sourceTimeOf(el, t))
      if (Math.abs(v.currentTime - want) > SYNC_TOLERANCE) {
        try {
          v.currentTime = want
        } catch {
          /* ignore */
        }
      }
      if (this.playing && v.paused) void v.play().catch(() => {})
    }

    // Volume / mute is owned by the audio-kind clip on each source (the companion
    // audio track). A source with no active audio clip is muted — its sound, if
    // any, belongs to an audio track that isn't playing here.
    for (const mediaId of active) {
      const entry = this.sources.get(mediaId)
      if (!entry) continue
      const hit = this.audioClipForSource(mediaId, t)
      if (hit) {
        const { track, el } = hit
        const localT = t - el.timeline_start
        const gain = resolveAudioGain(el, localT, clipDuration(el)) * (track.volume ?? 1)
        entry.el.muted = !!track.muted
        entry.el.volume = clamp(gain, 0, 1)
      } else {
        entry.el.muted = true
      }
    }

    for (const [mediaId, entry] of this.sources) {
      if (!active.has(mediaId)) {
        try {
          entry.el.pause()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // The audio-kind clip (and its track) on this source covering timeline time t.
  private audioClipForSource(
    mediaId: string,
    t: number,
  ): { track: TimelineTrack; el: TimelineElement } | null {
    for (const track of this.data.tracks) {
      if (track.kind !== 'audio' || track.hidden) continue
      for (const el of track.elements) {
        if (el.media_id === mediaId && t >= el.timeline_start && t < clipEnd(el)) {
          return { track, el }
        }
      }
    }
    return null
  }
}
