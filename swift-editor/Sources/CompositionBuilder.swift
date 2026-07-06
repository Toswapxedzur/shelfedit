import AVFoundation
import Foundation

struct CompositionBuildResult {
    let item: AVPlayerItem
    let duration: Double
    let warnings: [String]
}

enum CompositionBuilder {
    @MainActor
    static func build(timeline: TimelineData, media: [String: MediaAsset]) async -> CompositionBuildResult {
        let composition = AVMutableComposition()
        var warnings: [String] = []
        var duration = max(0, timeline.duration)
        let scale: CMTimeScale = 600
        var assetCache: [String: AVURLAsset] = [:]
        var trackCache: [String: [AVAssetTrack]] = [:]

        guard let videoTrack = composition.addMutableTrack(
            withMediaType: .video,
            preferredTrackID: kCMPersistentTrackID_Invalid
        ) else {
            return CompositionBuildResult(item: AVPlayerItem(asset: composition), duration: duration, warnings: ["Could not create video track"])
        }
        let audioTrack = composition.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid
        )

        for track in timeline.tracks.sorted(by: { $0.order < $1.order }) where !(track.hidden ?? false) {
            for clip in track.elements.sorted(by: { $0.timelineStart < $1.timelineStart }) {
                guard clip.type == .video || clip.type == .audio else { continue }
                guard let mediaId = clip.mediaId, let assetInfo = media[mediaId] else {
                    warnings.append("Missing media for \(clip.id.shortStableId)")
                    continue
                }
                guard FileManager.default.fileExists(atPath: assetInfo.localPath) else {
                    warnings.append("Missing file \(assetInfo.originalFilename)")
                    continue
                }

                let asset: AVURLAsset
                if let cached = assetCache[assetInfo.id] {
                    asset = cached
                } else {
                    let created = AVURLAsset(url: URL(fileURLWithPath: assetInfo.localPath))
                    assetCache[assetInfo.id] = created
                    asset = created
                }
                let mediaType: AVMediaType = clip.type == .video ? .video : .audio
                let destination = clip.type == .video ? videoTrack : audioTrack
                guard let destination else { continue }

                do {
                    let trackKey = "\(assetInfo.id):\(mediaType.rawValue)"
                    let sourceTracks: [AVAssetTrack]
                    if let cached = trackCache[trackKey] {
                        sourceTracks = cached
                    } else {
                        let loaded = try await asset.loadTracks(withMediaType: mediaType)
                        trackCache[trackKey] = loaded
                        sourceTracks = loaded
                    }
                    guard let sourceTrack = sourceTracks.first else {
                        if clip.type == .video {
                            warnings.append("No video track in \(assetInfo.originalFilename)")
                        }
                        continue
                    }

                    let sourceStart = max(0, clip.sourceStart ?? 0)
                    let fallbackEnd = assetInfo.duration > 0 ? assetInfo.duration : sourceStart + clip.duration
                    let sourceEnd = max(sourceStart + 0.001, clip.sourceEnd ?? fallbackEnd)
                    let sourceDuration = max(0.001, sourceEnd - sourceStart)
                    let speed = max(0.1, clip.speed ?? 1)
                    let targetDuration = sourceDuration / speed
                    let insertAt = CMTime(seconds: max(0, clip.timelineStart), preferredTimescale: scale)
                    let sourceRange = CMTimeRange(
                        start: CMTime(seconds: sourceStart, preferredTimescale: scale),
                        duration: CMTime(seconds: sourceDuration, preferredTimescale: scale)
                    )

                    try destination.insertTimeRange(sourceRange, of: sourceTrack, at: insertAt)
                    if abs(speed - 1) > 0.0001 {
                        destination.scaleTimeRange(
                            CMTimeRange(start: insertAt, duration: sourceRange.duration),
                            toDuration: CMTime(seconds: targetDuration, preferredTimescale: scale)
                        )
                    }
                    duration = max(duration, clip.timelineStart + targetDuration)
                } catch {
                    warnings.append("\(clip.id.shortStableId): \(error.localizedDescription)")
                }
            }
        }

        if duration <= 0, let firstVideo = media.values.first(where: { $0.type == "video" || $0.type == "movie" }) {
            let item = AVPlayerItem(url: URL(fileURLWithPath: firstVideo.localPath))
            item.preferredForwardBufferDuration = 0
            return CompositionBuildResult(item: item, duration: firstVideo.duration, warnings: warnings)
        }

        let item = AVPlayerItem(asset: composition)
        item.preferredForwardBufferDuration = 0
        return CompositionBuildResult(item: item, duration: duration, warnings: warnings)
    }
}
