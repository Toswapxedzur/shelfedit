// Video decode worker.
//
// Runs the mediabunny demux + WebCodecs decode + frame copy-out OFF the main
// thread, so heavy sources never block the UI / compositor / audio clock. It's
// deliberately "dumb": the main-thread engine keeps ALL the timeline logic
// (which clip is active, the master clock, pacing, drop-to-live, the queue).
// This worker just answers two requests for a given source:
//
//   • next  — advance a sequential decode generator and return the next frame
//   • seek  — decode the single exact frame at a source time (scrubbing)
//
// Every frame is returned as an ImageBitmap that is TRANSFERRED (zero-copy) to
// the main thread. mediabunny's CanvasSink uses an OffscreenCanvas automatically
// when there's no DOM (i.e. here), so it works unchanged in a worker.

/// <reference lib="webworker" />
import {
  Input,
  UrlSource,
  ALL_FORMATS,
  CanvasSink,
  type InputVideoTrack,
} from 'mediabunny'

const MAX_FRAME_DIM = 1280
const FRAME_POOL = 6

interface Src {
  input: Input
  ready: Promise<void>
  canvasSink: CanvasSink | null
  gen: ReturnType<CanvasSink['canvases']> | null
}

const sources = new Map<string, Src>()

function ensure(mediaId: string, url: string): Src {
  let s = sources.get(mediaId)
  if (s) return s
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  s = { input, ready: Promise.resolve(), canvasSink: null, gen: null }
  s.ready = (async () => {
    const vt = await input.getPrimaryVideoTrack().catch(() => null)
    if (vt && (await vt.canDecode().catch(() => false))) {
      const width = Math.min((vt as InputVideoTrack).displayWidth || MAX_FRAME_DIM, MAX_FRAME_DIM)
      s!.canvasSink = new CanvasSink(vt, { width, poolSize: FRAME_POOL })
    }
  })()
  sources.set(mediaId, s)
  return s
}

async function closeGen(s: Src): Promise<void> {
  const g = s.gen
  s.gen = null
  if (g) {
    try {
      await g.return()
    } catch {
      /* ignore */
    }
  }
}

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer)

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as Record<string, unknown>
  const mediaId = m.mediaId as string
  switch (m.t) {
    case 'open': {
      const s = ensure(mediaId, m.url as string)
      await s.ready
      post({ t: 'opened', mediaId, ok: !!s.canvasSink })
      break
    }
    // Start (or restart) the sequential decode generator at a source time.
    case 'startGen': {
      const s = sources.get(mediaId)
      if (!s) break
      await s.ready
      await closeGen(s)
      if (s.canvasSink) {
        s.gen = s.canvasSink.canvases(Math.max(0, m.from as number))
      }
      break
    }
    // Pull the next frame from the running generator.
    case 'next': {
      const reqId = m.reqId as number
      const s = sources.get(mediaId)
      if (!s || !s.gen) {
        post({ t: 'frame', reqId, ok: false })
        break
      }
      try {
        const r = await s.gen.next()
        if (r.done || !r.value) {
          post({ t: 'frame', reqId, ok: false, done: true })
          break
        }
        const bitmap = await createImageBitmap(r.value.canvas)
        post(
          {
            t: 'frame',
            reqId,
            ok: true,
            timestamp: r.value.timestamp,
            duration: r.value.duration,
            bitmap,
          },
          [bitmap],
        )
      } catch {
        post({ t: 'frame', reqId, ok: false })
      }
      break
    }
    // Decode the single exact frame at a source time (scrub / paused seek).
    case 'seek': {
      const reqId = m.reqId as number
      const s = sources.get(mediaId)
      if (!s) {
        post({ t: 'frame', reqId, ok: false })
        break
      }
      await s.ready
      if (!s.canvasSink) {
        post({ t: 'frame', reqId, ok: false })
        break
      }
      try {
        const wc = await s.canvasSink.getCanvas(Math.max(0, m.srcTime as number))
        if (!wc) {
          post({ t: 'frame', reqId, ok: false })
          break
        }
        const bitmap = await createImageBitmap(wc.canvas)
        post(
          { t: 'frame', reqId, ok: true, timestamp: wc.timestamp, duration: wc.duration, bitmap },
          [bitmap],
        )
      } catch {
        post({ t: 'frame', reqId, ok: false })
      }
      break
    }
    case 'drop': {
      const s = sources.get(mediaId)
      if (s) {
        await closeGen(s)
        try {
          ;(s.input as unknown as { dispose?: () => void }).dispose?.()
        } catch {
          /* ignore */
        }
        sources.delete(mediaId)
      }
      break
    }
  }
}
