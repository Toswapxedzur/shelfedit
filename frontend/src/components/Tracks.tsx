import { formatDuration, type TranscriptSegment } from '../api/client'

interface Props {
  duration: number
  videoName: string
  hasAudio: boolean
  segments: TranscriptSegment[]
  onSeek: (t: number) => void
}

export function Tracks({
  duration,
  videoName,
  hasAudio,
  segments,
  onSeek,
}: Props) {
  const total = Math.max(duration, 0.001)
  const pct = (t: number) => `${(t / total) * 100}%`

  // A handful of ruler ticks.
  const tickCount = 6
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) =>
    (total * i) / tickCount,
  )

  return (
    <div className="tracks">
      <div className="ruler">
        {ticks.map((t, i) => (
          <span className="tick" key={i} style={{ left: pct(t) }}>
            {formatDuration(t)}
          </span>
        ))}
      </div>

      <TrackRow label="Video" kind="video">
        <div
          className="clip video"
          style={{ left: 0, width: '100%' }}
          title={videoName}
        >
          {videoName}
        </div>
      </TrackRow>

      <TrackRow label="Audio" kind="audio">
        {hasAudio && (
          <div
            className="clip audio bonded"
            style={{ left: 0, width: '100%' }}
            title="Audio (bonded to video)"
          >
            Audio · bonded
          </div>
        )}
      </TrackRow>

      <TrackRow label="Text" kind="text">
        {segments.length === 0 ? (
          <div className="lane-hint">Transcribe to add bonded captions</div>
        ) : (
          segments.map((s) => (
            <div
              key={s.idx}
              className="clip text bonded"
              style={{
                left: pct(s.start_seconds),
                width: pct(Math.max(s.end_seconds - s.start_seconds, 0.2)),
              }}
              title={s.text}
              onClick={() => onSeek(s.start_seconds)}
            >
              {s.text}
            </div>
          ))
        )}
      </TrackRow>
    </div>
  )
}

function TrackRow({
  label,
  kind,
  children,
}: {
  label: string
  kind: string
  children: React.ReactNode
}) {
  return (
    <div className="track-row">
      <div className={`track-label ${kind}`}>{label}</div>
      <div className="lane">{children}</div>
    </div>
  )
}
