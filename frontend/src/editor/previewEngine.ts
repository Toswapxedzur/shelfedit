// Professional-style preview playback engine.
//
// This replaces the old approach of driving playback with hidden <video>
// elements (which forced us to fight the browser's own playback clock, seek to
// re-sync, and stall on buffering). Instead it works the way real NLEs / video
// editors do:
//
//   • ONE master clock (the Web Audio clock) that never stops. The timeline
//     playhead is derived from it, so it can't freeze or "chase" anything.
//   • Each source file is demuxed and decoded with WebCodecs (via mediabunny).
//     Video frames are decoded *ahead* of the clock into a small ring buffer.
//     The compositor draws the frame whose timestamp matches the clock; if the
//     next frame isn't ready yet it simply keeps showing the last one (a
//     dropped/repeated frame) — the clock and audio never wait.
//   • Audio is decoded to AudioBuffers and *scheduled* on the Web Audio graph
//     ahead of time, giving glitch-free, sample-accurate sound that defines the
//     master clock. No seeking, ever, during playback.
//
// The engine is timeline-aware: it maps timeline time <-> each clip's source
// time, applies per-clip / per-track gain (volume, mute, fades), and handles
// multiple video/audio tracks.

import {
  Input,
  UrlSource,
  ALL_FORMATS,
  CanvasSink,
  AudioBufferSink,
  type InputVideoTrack,
  type InputAudioTrack,
  type WrappedAudioBuffer,
} from 'mediabunny'
import { api, type TimelineData, type TimelineElement, type TimelineTrack } from '../api/client'
import { clipDuration, clipEnd } from './timeline'
import { resolveAudioGain } from './effects'

// The compositor draws an ImageBitmap: it's a GPU-friendly, independently-owned
// copy of a decoded frame (works with drawImage and WebGL texImage2D). We own
// its lifetime and close() it when it leaves the queue.
export type FrameCanvas = ImageBitmap

// One decoded frame we own: an ImageBitmap copied out of the decoder's pool,
// plus its presentation timestamp (seconds, in source time).
interface Frame {
  image: ImageBitmap
  timestamp: number
}

// How far ahead of the clock to decode. Bigger = more resilient to hiccups but
// more memory / CPU spent ahead of time. These match typical editor pre-roll.
const FRAME_LEAD = 0.3 // seconds of video frames buffered ahead
const AUDIO_LEAD = 1.0 // seconds of audio scheduled ahead
const MAX_FRAME_DIM = 1280 // cap decode resolution to the compositor size
const PUMP_MS = 40 // engine housekeeping tick
// Reuse decoded-frame canvases in a ring instead of allocating one per frame
// (avoids GC hitches at 30-60fps). Must comfortably exceed the number of frames
// held at once (queue within FRAME_LEAD + the one on screen), or the ring would
// overwrite a frame we still need. 48 covers 0.3s even at 120fps.
// Pool size for the mediabunny CanvasSink. Because we IMMEDIATELY copy every
// decoded frame out of the pool into an ImageBitmap we own (see the producer),
// the sink only ever needs a couple of live canvases at a time. Copying out is
// what real WebCodecs editors do so the pooled/hardware output never starves
// and a frame we're still displaying is never recycled underneath us.
const FRAME_POOL = 6

const EMPTY_DATA: TimelineData = { tracks: [], duration: 0 } as unknown as TimelineData

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))

// timeline time -> source time for a media clip.
function sourceTimeOf(el: TimelineElement, t: number): number {
  return (el.source_start ?? 0) + (t - el.timeline_start)
}

interface CancelToken {
  cancelled: boolean
}

interface VideoProducer {
  clipId: string
  token: CancelToken
}

interface AudioProducer {
  token: CancelToken
}

// Everything we track for one physical media file (one media_id).
interface SourceEntry {
  mediaId: string
  input: Input
  ready: Promise<void>
  videoTrack: InputVideoTrack | null
  audioTrack: InputAudioTrack | null
  canvasSink: CanvasSink | null
  audioSink: AudioBufferSink | null
  // Video decode-ahead: frames we own (copied out of the decoder pool).
  frameQueue: Frame[]
  current: Frame | null
  videoProducer: VideoProducer | null
  // Audio scheduling
  gainNode: GainNode | null
  audioProducer: AudioProducer | null
  scheduled: Set<AudioBufferSourceNode>
}

export class PreviewEngine {
  private ctx: AudioContext | null = null
  private sources = new Map<string, SourceEntry>()
  private data: TimelineData = EMPTY_DATA
  private duration = 0
  private playing = false
  // Master clock anchors: at ctx time `anchorCtx`, the timeline is at `anchorTL`.
  private anchorCtx = 0
  private anchorTL = 0
  private pausedAt = 0
  private pumpTimer: number | null = null
  private readonly onEnded: () => void

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

  // Timeline time (seconds) right now, from the master clock. Never stalls.
  currentTime(): number {
    if (!this.playing || !this.ctx) return this.pausedAt
    const t = this.anchorTL + (this.ctx.currentTime - this.anchorCtx)
    return Math.min(this.duration, Math.max(0, t))
  }

  // The decoded frame to show for this clip right now (or null while filling).
  frameFor(el: TimelineElement): FrameCanvas | null {
    const entry = this.sources.get(el.media_id as string)
    if (!entry) return null
    const srcClock = sourceTimeOf(el, this.currentTime())
    const q = entry.frameQueue
    // Advance to the newest frame at/behind the clock; keep it as `current`.
    // Every frame we step past (including the previous `current`) is ours, so
    // close it to release its GPU memory.
    while (q.length && q[0].timestamp <= srcClock + 1e-3) {
      const prev = entry.current
      entry.current = q.shift()!
      prev?.image.close()
    }
    return entry.current ? entry.current.image : null
  }

  // Release and empty a source's decode-ahead queue (frames we own).
  private clearQueue(entry: SourceEntry): void {
    for (const f of entry.frameQueue) f.image.close()
    entry.frameQueue = []
  }

  // Begin (or resume) playback from the current committed position.
  play(fromTimeline: number): void {
    const ctx = this.ensureCtx()
    void ctx.resume()
    this.pausedAt = clamp(fromTimeline, 0, this.duration)
    this.anchorCtx = ctx.currentTime
    this.anchorTL = this.pausedAt
    this.playing = true
    this.reconcile()
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
      this.cancelVideoProducer(entry)
      this.cancelAudioProducer(entry)
      this.stopScheduled(entry)
      this.clearQueue(entry)
    }
  }

  // Point the preview at an exact time while paused (scrubbing). Decodes the
  // precise frame for each active video clip. Returns once frames are ready so
  // the caller can redraw.
  async seekTo(t: number): Promise<void> {
    this.pausedAt = clamp(t, 0, this.duration)
    const { videos } = this.activeClips(this.pausedAt)
    await Promise.all(
      videos.map(async ({ el }) => {
        const entry = this.ensureSource(el.media_id as string)
        await entry.ready
        if (!entry.canvasSink) return
        const st = Math.max(0, sourceTimeOf(el, this.pausedAt))
        try {
          const wc = await entry.canvasSink.getCanvas(st)
          if (wc) {
            const image = await createImageBitmap(wc.canvas)
            const prev = entry.current
            entry.current = { image, timestamp: wc.timestamp }
            prev?.image.close()
            this.clearQueue(entry)
          }
        } catch {
          /* not ready */
        }
      }),
    )
  }

  // Warm a source so its first frame is ready before playback / scrub.
  prepare(mediaId: string): void {
    this.ensureSource(mediaId)
  }

  // Start demuxing every media file referenced by the timeline, ahead of play.
  // This hides the cold-start latency (HTTP range fetch + demux + decoder init)
  // that otherwise freezes the first second of playback on a freshly imported
  // project whose bytes aren't in the browser cache yet.
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
    const lines = [`clock=${t.toFixed(2)} play=${this.playing ? 'Y' : 'N'} ctx=${this.ctx?.state ?? '-'}`]
    const { videos, audios } = this.activeClips(t)
    for (const { el } of videos) {
      const e = this.sources.get(el.media_id as string)
      const cur = e?.current ? e.current.timestamp.toFixed(2) : '—'
      lines.push(`vid q${e?.frameQueue.length ?? 0} cur${cur} src${sourceTimeOf(el, t).toFixed(2)}`)
    }
    for (const { el } of audios) {
      const e = this.sources.get(el.media_id as string)
      lines.push(`aud sched${e?.scheduled.size ?? 0}`)
    }
    return lines
  }

  dispose(): void {
    this.pause()
    for (const entry of this.sources.values()) {
      entry.current?.image.close()
      entry.current = null
      try {
        ;(entry.input as unknown as { dispose?: () => void }).dispose?.()
      } catch {
        /* ignore */
      }
    }
    this.sources.clear()
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
    }
  }

  // ---- internals ---------------------------------------------------------

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    return this.ctx
  }

  private ensureSource(mediaId: string): SourceEntry {
    let entry = this.sources.get(mediaId)
    if (entry) return entry
    const url = new URL(api.mediaFileUrl(mediaId), location.origin).href
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
    entry = {
      mediaId,
      input,
      ready: Promise.resolve(),
      videoTrack: null,
      audioTrack: null,
      canvasSink: null,
      audioSink: null,
      frameQueue: [],
      current: null,
      videoProducer: null,
      gainNode: null,
      audioProducer: null,
      scheduled: new Set(),
    }
    entry.ready = (async () => {
      const [vt, at] = await Promise.all([
        input.getPrimaryVideoTrack().catch(() => null),
        input.getPrimaryAudioTrack().catch(() => null),
      ])
      entry!.videoTrack = vt
      entry!.audioTrack = at
      if (vt && (await vt.canDecode().catch(() => false))) {
        const width = Math.min(vt.displayWidth || MAX_FRAME_DIM, MAX_FRAME_DIM)
        entry!.canvasSink = new CanvasSink(vt, { width, poolSize: FRAME_POOL })
      }
      if (at && (await at.canDecode().catch(() => false))) {
        entry!.audioSink = new AudioBufferSink(at)
      }
    })()
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

  // Housekeeping tick while playing: start/stop producers for the clips that
  // are (no longer) active, and detect end of timeline.
  private pump(): void {
    if (!this.playing) return
    const t = this.currentTime()
    if (t >= this.duration - 1e-3) {
      this.onEnded()
      return
    }
    this.reconcile()
  }

  private reconcile(): void {
    const t = this.currentTime()
    const { videos, audios } = this.activeClips(t)

    const activeVideoSrc = new Set<string>()
    for (const { el } of videos) {
      const mediaId = el.media_id as string
      activeVideoSrc.add(mediaId)
      const entry = this.ensureSource(mediaId)
      const p = entry.videoProducer
      if (!p || p.clipId !== el.id) {
        this.cancelVideoProducer(entry)
        this.startVideoProducer(entry, el)
      }
    }

    const activeAudioSrc = new Set<string>()
    for (const { el } of audios) {
      const mediaId = el.media_id as string
      activeAudioSrc.add(mediaId)
      const entry = this.ensureSource(mediaId)
      if (!entry.audioProducer) this.startAudioProducer(entry, t)
    }

    for (const [mediaId, entry] of this.sources) {
      if (entry.videoProducer && !activeVideoSrc.has(mediaId)) this.cancelVideoProducer(entry)
      if (entry.audioProducer && !activeAudioSrc.has(mediaId)) {
        this.cancelAudioProducer(entry)
        this.stopScheduled(entry)
      }
    }
  }

  // ---- video decode-ahead ------------------------------------------------

  private startVideoProducer(entry: SourceEntry, clip: TimelineElement): void {
    const token: CancelToken = { cancelled: false }
    entry.videoProducer = { clipId: clip.id, token }
    void (async () => {
      await entry.ready
      if (token.cancelled || !entry.canvasSink) return
      this.clearQueue(entry)
      const start = Math.max(0, sourceTimeOf(clip, this.currentTime()))
      const gen = entry.canvasSink.canvases(start)
      try {
        for await (const wc of gen) {
          if (token.cancelled) break
          // Copy the frame OUT of mediabunny's pooled canvas into an ImageBitmap
          // we own. The pool reuses its canvases in a ring, so a queued pooled
          // canvas would be overwritten underneath us; the copy is what every
          // real WebCodecs editor does to keep displayed frames stable.
          const image = await createImageBitmap(wc.canvas)
          if (token.cancelled) {
            image.close()
            break
          }
          entry.frameQueue.push({ image, timestamp: wc.timestamp })
          // Pace: don't run more than FRAME_LEAD ahead of the clock. The async
          // generator is lazy, so pausing here also pauses decoding (which also
          // bounds how much memory the decode-ahead queue can use).
          for (;;) {
            if (token.cancelled) break
            const srcClock = sourceTimeOf(clip, this.currentTime())
            const ahead = wc.timestamp - srcClock
            if (ahead <= FRAME_LEAD) break
            await sleep(Math.min(100, (ahead - FRAME_LEAD) * 1000))
          }
        }
      } catch {
        /* decode ended / cancelled */
      } finally {
        try {
          await gen.return()
        } catch {
          /* ignore */
        }
      }
    })()
  }

  private cancelVideoProducer(entry: SourceEntry): void {
    if (entry.videoProducer) {
      entry.videoProducer.token.cancelled = true
      entry.videoProducer = null
    }
  }

  // ---- audio scheduling --------------------------------------------------

  private startAudioProducer(entry: SourceEntry, t: number): void {
    const token: CancelToken = { cancelled: false }
    entry.audioProducer = { token }
    void (async () => {
      await entry.ready
      const ctx = this.ctx
      if (token.cancelled || !entry.audioSink || !ctx) return
      const clip0 = this.audioClipForSource(entry.mediaId, t)
      if (!clip0) return
      if (!entry.gainNode) {
        entry.gainNode = ctx.createGain()
        entry.gainNode.connect(ctx.destination)
      }
      const start = Math.max(0, sourceTimeOf(clip0, this.currentTime()))
      const gen = entry.audioSink.buffers(start)
      try {
        for await (const wb of gen) {
          if (token.cancelled) break
          this.scheduleAudio(entry, wb)
          for (;;) {
            if (token.cancelled) break
            const tt = this.timelineTimeForSource(entry.mediaId, wb.timestamp)
            const ahead = (tt ?? this.currentTime()) - this.currentTime()
            if (ahead <= AUDIO_LEAD) break
            await sleep(Math.min(150, (ahead - AUDIO_LEAD) * 1000))
          }
        }
      } catch {
        /* decode ended / cancelled */
      } finally {
        try {
          await gen.return()
        } catch {
          /* ignore */
        }
      }
    })()
  }

  private scheduleAudio(entry: SourceEntry, wb: WrappedAudioBuffer): void {
    const ctx = this.ctx
    if (!ctx || !entry.gainNode) return
    // Which audio clip (and track) does this decoded chunk belong to?
    const hit = this.audioClipAtSourceTime(entry.mediaId, wb.timestamp)
    if (!hit) return
    const { track, el } = hit
    const tt = el.timeline_start + (wb.timestamp - (el.source_start ?? 0))
    const ctxTime = this.anchorCtx + (tt - this.anchorTL)
    if (ctxTime + wb.duration <= ctx.currentTime) return // already in the past

    const localT = tt - el.timeline_start
    const gain =
      resolveAudioGain(el, localT, clipDuration(el)) * (track.volume ?? 1) * (track.muted ? 0 : 1)

    const node = ctx.createBufferSource()
    node.buffer = wb.buffer
    const g = ctx.createGain()
    g.gain.value = gain
    node.connect(g).connect(entry.gainNode)

    let when = ctxTime
    let offset = 0
    if (ctxTime < ctx.currentTime) {
      offset = ctx.currentTime - ctxTime
      when = ctx.currentTime
    }
    try {
      node.start(when, Math.max(0, offset))
    } catch {
      return
    }
    entry.scheduled.add(node)
    node.onended = () => entry.scheduled.delete(node)
  }

  private cancelAudioProducer(entry: SourceEntry): void {
    if (entry.audioProducer) {
      entry.audioProducer.token.cancelled = true
      entry.audioProducer = null
    }
  }

  private stopScheduled(entry: SourceEntry): void {
    for (const node of entry.scheduled) {
      try {
        node.onended = null
        node.stop()
      } catch {
        /* already stopped */
      }
    }
    entry.scheduled.clear()
  }

  // The audio clip on this source covering timeline time `t` (or null).
  private audioClipForSource(mediaId: string, t: number): TimelineElement | null {
    for (const track of this.data.tracks) {
      if (track.kind !== 'audio') continue
      for (const el of track.elements) {
        if (el.media_id === mediaId && t >= el.timeline_start && t < clipEnd(el)) return el
      }
    }
    return null
  }

  // The audio clip + track whose source range contains source time `st`.
  private audioClipAtSourceTime(
    mediaId: string,
    st: number,
  ): { track: TimelineTrack; el: TimelineElement } | null {
    for (const track of this.data.tracks) {
      if (track.kind !== 'audio') continue
      for (const el of track.elements) {
        if (el.media_id !== mediaId) continue
        const s0 = el.source_start ?? 0
        const s1 = el.source_end ?? Infinity
        if (st >= s0 - 1e-3 && st < s1) return { track, el }
      }
    }
    return null
  }

  private timelineTimeForSource(mediaId: string, st: number): number | null {
    const hit = this.audioClipAtSourceTime(mediaId, st)
    if (!hit) return null
    return hit.el.timeline_start + (st - (hit.el.source_start ?? 0))
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
