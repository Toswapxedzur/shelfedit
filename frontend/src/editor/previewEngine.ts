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
  AudioBufferSink,
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
// plus its display interval [timestamp, timestamp + duration) in source-time
// seconds. The duration lets us tell when a scrub actually lands on a DIFFERENT
// frame (so we only decode when the picture would change).
interface Frame {
  image: ImageBitmap
  timestamp: number
  duration: number
}

// How far ahead of the clock to decode. Bigger = more resilient to hiccups but
// more memory / CPU spent ahead of time. These match typical editor pre-roll.
const FRAME_LEAD = 0.3 // seconds of video frames buffered ahead
// If a decoded frame is more than this far BEHIND the clock, the decoder can't
// sustain realtime from here, so we abandon the backlog and re-seek forward to
// "live" (drop-to-live). This is what keeps a heavy source from accumulating
// unbounded lag — it drops frames instead of playing in slow motion.
const CATCHUP_LAG = 0.35
const AUDIO_LEAD = 1.0 // seconds of audio scheduled ahead
const PUMP_MS = 40 // engine housekeeping tick

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

// A frame delivered by the decode worker (bitmap ownership transferred to us).
interface WorkerFrame {
  timestamp: number
  duration: number
  bitmap: ImageBitmap
}

// Everything we track for one physical media file (one media_id). Video is
// decoded in the worker; audio stays on the main thread (it defines the clock).
interface SourceEntry {
  mediaId: string
  input: Input
  ready: Promise<void>
  audioTrack: InputAudioTrack | null
  audioSink: AudioBufferSink | null
  // True once the worker has opened this source and can decode video.
  hasVideo: boolean
  videoReady: Promise<void>
  // Video decode-ahead: frames we own (bitmaps transferred from the worker).
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
  // Scrub seek serialization: only ever one decode in flight, always converging
  // to the latest requested target. Overlapping seeks on the same mediabunny
  // decoder race and can leave the frame stuck behind the playhead.
  private seeking = false
  private pendingSeek: number | null = null
  private seekingPromise: Promise<void> | null = null
  private readonly onEnded: () => void

  // Decode worker: runs demux + WebCodecs + copy-out off the main thread.
  private worker: Worker
  private reqSeq = 0
  private pending = new Map<number, (f: WorkerFrame | null) => void>()
  private videoOpen = new Map<string, (ok: boolean) => void>()

  constructor(onEnded: () => void) {
    this.onEnded = onEnded
    this.worker = new Worker(new URL('./decodeWorker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e.data)
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

  // Point the preview at an exact time while paused (scrubbing).
  //
  // Sequential seek queue: we only ever run ONE decode at a time and always
  // converge to the LATEST requested target. Firing overlapping decodes on the
  // same mediabunny decoder races them and can leave the frame frozen behind the
  // playhead (the classic scrub freeze). Every caller's promise resolves once
  // the frame for the final settled target is on screen, so the caller can
  // redraw and see the right frame.
  async seekTo(t: number): Promise<void> {
    this.pausedAt = clamp(t, 0, this.duration)
    this.pendingSeek = this.pausedAt
    if (this.seeking && this.seekingPromise) return this.seekingPromise
    this.seeking = true
    this.seekingPromise = (async () => {
      try {
        while (this.pendingSeek != null) {
          const target = this.pendingSeek
          this.pendingSeek = null
          await this.decodeSeekFrame(target)
        }
      } finally {
        this.seeking = false
        this.seekingPromise = null
      }
    })()
    return this.seekingPromise
  }

  // Decode + show the exact frame for each active video clip at time `t`.
  //
  // Frame-change gate: if the frame already on screen for a source covers the
  // requested source time (its display interval contains it), the picture would
  // not change, so we skip the decode entirely. This is what NLEs do while
  // scrubbing — decode on frame change, not on every playhead position — and it
  // keeps fast/oscillating scrubs from flooding the decoder with no-op work.
  private async decodeSeekFrame(t: number): Promise<void> {
    const { videos } = this.activeClips(t)
    await Promise.all(
      videos.map(async ({ el }) => {
        const entry = this.ensureSource(el.media_id as string)
        await entry.videoReady
        if (!entry.hasVideo) return
        const st = Math.max(0, sourceTimeOf(el, t))
        const cur = entry.current
        if (
          cur &&
          cur.duration > 0 &&
          st >= cur.timestamp - 1e-4 &&
          st < cur.timestamp + cur.duration - 1e-4
        ) {
          return // same frame already shown — no decode needed
        }
        const f = await this.workerSeek(entry.mediaId, st)
        if (f) {
          const prev = entry.current
          entry.current = { image: f.bitmap, timestamp: f.timestamp, duration: f.duration }
          prev?.image.close()
          this.clearQueue(entry)
        }
      }),
    )
  }

  // Warm a source so its first frame is ready before playback / scrub.
  prepare(mediaId: string): void {
    this.ensureSource(mediaId)
  }

  // Forget a source so it is re-opened fresh next time. Used when its optimized
  // proxy becomes ready: the reopened source fetches the proxy URL instead of
  // the (heavy) original that was being decoded until now.
  dropSource(mediaId: string): void {
    const entry = this.sources.get(mediaId)
    if (!entry) return
    this.cancelVideoProducer(entry)
    this.cancelAudioProducer(entry)
    this.stopScheduled(entry)
    this.clearQueue(entry)
    entry.current?.image.close()
    entry.current = null
    try {
      ;(entry.input as unknown as { dispose?: () => void }).dispose?.()
    } catch {
      /* ignore */
    }
    this.worker.postMessage({ t: 'drop', mediaId })
    this.sources.delete(mediaId)
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
    // Reject any in-flight worker requests and tear the worker down.
    for (const resolve of this.pending.values()) resolve(null)
    this.pending.clear()
    this.videoOpen.clear()
    this.worker.terminate()
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

  private onWorkerMessage(msg: {
    t: string
    mediaId?: string
    ok?: boolean
    reqId?: number
    timestamp?: number
    duration?: number
    bitmap?: ImageBitmap
  }): void {
    if (msg.t === 'opened') {
      const resolve = this.videoOpen.get(msg.mediaId as string)
      if (resolve) {
        this.videoOpen.delete(msg.mediaId as string)
        resolve(!!msg.ok)
      }
      return
    }
    if (msg.t === 'frame') {
      const resolve = this.pending.get(msg.reqId as number)
      if (!resolve) {
        // Late/cancelled reply — free the transferred bitmap so it doesn't leak.
        msg.bitmap?.close()
        return
      }
      this.pending.delete(msg.reqId as number)
      resolve(
        msg.ok && msg.bitmap
          ? { timestamp: msg.timestamp ?? 0, duration: msg.duration ?? 0, bitmap: msg.bitmap }
          : null,
      )
    }
  }

  private openWorkerVideo(mediaId: string, url: string): Promise<void> {
    return new Promise((resolve) => {
      this.videoOpen.set(mediaId, (ok) => {
        const entry = this.sources.get(mediaId)
        if (entry) entry.hasVideo = ok
        resolve()
      })
      this.worker.postMessage({ t: 'open', mediaId, url })
    })
  }

  // Pull the next decode-ahead frame from the worker's running generator.
  private workerNext(mediaId: string): Promise<WorkerFrame | null> {
    const reqId = ++this.reqSeq
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve)
      this.worker.postMessage({ t: 'next', mediaId, reqId })
    })
  }

  // Ask the worker for the single exact frame at a source time (scrubbing).
  private workerSeek(mediaId: string, srcTime: number): Promise<WorkerFrame | null> {
    const reqId = ++this.reqSeq
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve)
      this.worker.postMessage({ t: 'seek', mediaId, srcTime, reqId })
    })
  }

  private ensureSource(mediaId: string): SourceEntry {
    let entry = this.sources.get(mediaId)
    if (entry) return entry
    // Decode the optimized proxy when the backend has it ready; it transparently
    // falls back to the original file until then. This is what keeps heavy / VFR
    // sources smooth (they're normalized to ≤1280 CFR H.264 like a CapCut export).
    const url = new URL(api.mediaPreviewUrl(mediaId), location.origin).href
    // Audio is decoded here (it drives the master clock); video is decoded in
    // the worker, which opens its own handle to the same URL.
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
    entry = {
      mediaId,
      input,
      ready: Promise.resolve(),
      audioTrack: null,
      audioSink: null,
      hasVideo: false,
      videoReady: Promise.resolve(),
      frameQueue: [],
      current: null,
      videoProducer: null,
      gainNode: null,
      audioProducer: null,
      scheduled: new Set(),
    }
    entry.ready = (async () => {
      const at = await input.getPrimaryAudioTrack().catch(() => null)
      entry!.audioTrack = at
      if (at && (await at.canDecode().catch(() => false))) {
        entry!.audioSink = new AudioBufferSink(at)
      }
    })()
    entry.videoReady = this.openWorkerVideo(mediaId, url)
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
      await entry.videoReady
      if (token.cancelled || !entry.hasVideo) return
      this.clearQueue(entry)
      // Outer loop: (re)start the worker's decode generator at the current clock.
      // If a delivered frame is already far behind the clock, break with `reseek`
      // and restart at the new (later) clock — dropping the frames in between.
      // This is the drop-to-live behavior native editors use so lag can't build.
      while (!token.cancelled && entry.hasVideo) {
        const start = Math.max(0, sourceTimeOf(clip, this.currentTime()))
        this.worker.postMessage({ t: 'startGen', mediaId: entry.mediaId, from: start })
        let reseek = false
        for (;;) {
          if (token.cancelled) break
          const f = await this.workerNext(entry.mediaId)
          if (token.cancelled) {
            f?.bitmap.close()
            break
          }
          if (!f) break // generator finished this clip's source
          // Drop-to-live: this frame is already well behind the clock, so the
          // decoder isn't keeping up. Abandon the backlog and re-seek forward.
          if (sourceTimeOf(clip, this.currentTime()) - f.timestamp > CATCHUP_LAG) {
            f.bitmap.close()
            reseek = true
            break
          }
          entry.frameQueue.push({ image: f.bitmap, timestamp: f.timestamp, duration: f.duration })
          // Pace: don't buffer more than FRAME_LEAD ahead of the clock (also
          // bounds decode-ahead memory). We simply stop pulling frames.
          for (;;) {
            if (token.cancelled) break
            const srcClock = sourceTimeOf(clip, this.currentTime())
            const ahead = f.timestamp - srcClock
            if (ahead <= FRAME_LEAD) break
            await sleep(Math.min(100, (ahead - FRAME_LEAD) * 1000))
          }
        }
        if (token.cancelled || !reseek) break
        // Drop the now-stale backlog and yield before reopening at the new clock.
        this.clearQueue(entry)
        await sleep(16)
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
      if (track.kind !== 'audio' || track.hidden) continue
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
      if (track.kind !== 'audio' || track.hidden) continue
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
