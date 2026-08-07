import AVFoundation
import CoreImage
import Foundation

struct CompositionBuildResult {
    let item: AVPlayerItem
    let duration: Double
    let warnings: [String]
}

enum CompositionBuilder {
    /// A clip placed into the z-stack: `order` is its track's order (0 = top), and
    /// `spec` is the ready-to-composite layer (a video track slice or a text image).
    private struct LayerPlacement {
        let order: Int
        let range: CMTimeRange
        let spec: LayerSpec
        /// Content fingerprint used to key the render cache; changes whenever the
        /// clip's identity, timing, geometry, or (for text) text/style changes.
        let fingerprint: String
    }

    @MainActor
    static func build(timeline: TimelineData, media: [String: MediaAsset], cache: RenderCache? = nil) async -> CompositionBuildResult {
        let composition = AVMutableComposition()
        var warnings: [String] = []
        var duration = max(0, timeline.duration)
        let scale: CMTimeScale = 600
        let spec = timeline.canvas ?? CanvasSpec()
        let renderSize = CGSize(width: max(16, spec.width), height: max(16, spec.height))
        var assetCache: [String: AVURLAsset] = [:]
        var trackCache: [String: [AVAssetTrack]] = [:]

        func resolveSourceTrack(for clip: TimelineElement, mediaType: AVMediaType) async -> (AVAssetTrack, MediaAsset)? {
            guard let mediaId = clip.mediaId, let assetInfo = media[mediaId] else {
                warnings.append("Missing media for \(clip.id.shortStableId)")
                return nil
            }
            guard FileManager.default.fileExists(atPath: assetInfo.localPath) else {
                warnings.append("Missing file \(assetInfo.originalFilename)")
                return nil
            }
            let asset: AVURLAsset
            if let cached = assetCache[assetInfo.id] {
                asset = cached
            } else {
                let created = AVURLAsset(url: URL(fileURLWithPath: assetInfo.localPath))
                assetCache[assetInfo.id] = created
                asset = created
            }
            let key = "\(assetInfo.id):\(mediaType.rawValue)"
            let sourceTracks: [AVAssetTrack]
            if let cached = trackCache[key] {
                sourceTracks = cached
            } else {
                do {
                    let loaded = try await asset.loadTracks(withMediaType: mediaType)
                    trackCache[key] = loaded
                    sourceTracks = loaded
                } catch {
                    warnings.append("\(clip.id.shortStableId): \(error.localizedDescription)")
                    return nil
                }
            }
            guard let first = sourceTracks.first else {
                if mediaType == .video {
                    warnings.append("No video track in \(assetInfo.originalFilename)")
                }
                return nil
            }
            return (first, assetInfo)
        }

        func insertSegment(
            into destination: AVMutableCompositionTrack,
            sourceTrack: AVAssetTrack,
            sourceStart: Double,
            sourceDuration: Double,
            timelineStart: Double,
            targetDuration: Double
        ) {
            let insertAt = CMTime(seconds: max(0, timelineStart), preferredTimescale: scale)
            let sourceRange = CMTimeRange(
                start: CMTime(seconds: max(0, sourceStart), preferredTimescale: scale),
                duration: CMTime(seconds: max(0.001, sourceDuration), preferredTimescale: scale)
            )
            do {
                try destination.insertTimeRange(sourceRange, of: sourceTrack, at: insertAt)
                if abs(sourceDuration - targetDuration) > 0.0001 {
                    destination.scaleTimeRange(
                        CMTimeRange(start: insertAt, duration: sourceRange.duration),
                        toDuration: CMTime(seconds: max(0.001, targetDuration), preferredTimescale: scale)
                    )
                }
            } catch {
                warnings.append("\(destination.mediaType.rawValue) insert failed: \(error.localizedDescription)")
            }
        }

        let orderedTracks = timeline.tracks.sorted(by: { $0.order < $1.order })

        // ===== VIDEO + TEXT: one z-ordered stack =====
        // Video clips go onto composition tracks (one per timeline track). Text is
        // pre-rendered to an image. Both become `LayerPlacement`s tagged with their
        // track order, so the custom compositor can interleave them — a text layer
        // can sit between two video layers.
        var placements: [LayerPlacement] = []
        var hasVideoTrack = false

        for track in orderedTracks where !(track.hidden ?? false) {
            let videoClips = track.elements.filter { $0.type == .video }.sorted { $0.timelineStart < $1.timelineStart }
            guard !videoClips.isEmpty else { continue }
            guard let compTrack = composition.addMutableTrack(
                withMediaType: .video,
                preferredTrackID: kCMPersistentTrackID_Invalid
            ) else { continue }
            hasVideoTrack = true

            for clip in videoClips {
                guard let (sourceTrack, _) = await resolveSourceTrack(for: clip, mediaType: .video) else { continue }
                let speed = max(0.1, clip.speed ?? 1)
                let targetDuration = clip.timelineDuration
                insertSegment(
                    into: compTrack,
                    sourceTrack: sourceTrack,
                    sourceStart: clip.sourceStart ?? 0,
                    sourceDuration: targetDuration * speed,
                    timelineStart: clip.timelineStart,
                    targetDuration: targetDuration
                )
                let natural = (try? await sourceTrack.load(.naturalSize)) ?? renderSize
                let preferred = (try? await sourceTrack.load(.preferredTransform)) ?? .identity
                let range = CMTimeRange(
                    start: CMTime(seconds: max(0, clip.timelineStart), preferredTimescale: scale),
                    duration: CMTime(seconds: max(0.001, targetDuration), preferredTimescale: scale)
                )
                let fingerprint = "v:\(clip.id):\(clip.sourceStart ?? 0):\(clip.sourceEnd ?? 0):\(clip.timelineStart):\(speed):\(clip.transform?.scale ?? 1),\(clip.transform?.x ?? 0),\(clip.transform?.y ?? 0):\(clip.opacity ?? 1):\(track.order)"
                placements.append(LayerPlacement(
                    order: track.order,
                    range: range,
                    spec: .video(
                        trackID: compTrack.trackID,
                        transform: videoTransform(natural: natural, preferred: preferred, clip: clip, renderSize: renderSize),
                        opacity: clamped(clip.opacity ?? 1, 0, 1)
                    ),
                    fingerprint: fingerprint
                ))
                duration = max(duration, clip.timelineStart + targetDuration)
            }
        }

        for track in orderedTracks where !(track.hidden ?? false) {
            for clip in track.elements where clip.type == .text {
                guard let text = clip.text, !text.isEmpty,
                      let image = TextRenderer.image(
                          text: text,
                          style: clip.style ?? TextStyle(),
                          transform: clip.transform,
                          canvas: renderSize
                      ) else { continue }
                let range = CMTimeRange(
                    start: CMTime(seconds: max(0, clip.timelineStart), preferredTimescale: scale),
                    end: CMTime(seconds: max(clip.timelineStart + 0.001, clip.end), preferredTimescale: scale)
                )
                let style = clip.style ?? TextStyle()
                let fingerprint = "t:\(clip.id):\(text):\(style.fontName ?? "sys"),\(style.fontSize),\(style.bold),\(style.italic),\(style.colorHex),\(style.alignment):\(clip.timelineStart):\(clip.end):\(clip.opacity ?? 1):\(track.order)"
                placements.append(LayerPlacement(
                    order: track.order,
                    range: range,
                    spec: .image(image, opacity: clamped(clip.opacity ?? 1, 0, 1)),
                    fingerprint: fingerprint
                ))
                duration = max(duration, clip.end)
            }
        }

        // ===== AUDIO: one composition track per audible timeline track (mixes) =====
        var audioMixParameters: [AVMutableAudioMixInputParameters] = []
        for track in orderedTracks where !(track.hidden ?? false) && !(track.muted ?? false) {
            let audioClips = track.elements.filter { $0.type == .audio }.sorted { $0.timelineStart < $1.timelineStart }
            guard !audioClips.isEmpty else { continue }
            guard let audioTrack = composition.addMutableTrack(
                withMediaType: .audio,
                preferredTrackID: kCMPersistentTrackID_Invalid
            ) else { continue }
            let parameters = AVMutableAudioMixInputParameters(track: audioTrack)
            let trackVolume = track.volume ?? 1
            for clip in audioClips {
                guard let (sourceTrack, assetInfo) = await resolveSourceTrack(for: clip, mediaType: .audio) else { continue }
                let sourceStart = max(0, clip.sourceStart ?? 0)
                let fallbackEnd = assetInfo.duration > 0 ? assetInfo.duration : sourceStart + clip.duration
                let sourceEnd = max(sourceStart + 0.001, clip.sourceEnd ?? fallbackEnd)
                let sourceDuration = max(0.001, sourceEnd - sourceStart)
                let speed = max(0.1, clip.speed ?? 1)
                let targetDuration = sourceDuration / speed
                insertSegment(
                    into: audioTrack,
                    sourceTrack: sourceTrack,
                    sourceStart: sourceStart,
                    sourceDuration: sourceDuration,
                    timelineStart: clip.timelineStart,
                    targetDuration: targetDuration
                )
                duration = max(duration, clip.timelineStart + targetDuration)
                parameters.setVolume(
                    Float(clamped((clip.volume ?? 1) * trackVolume, 0, 4)),
                    at: CMTime(seconds: max(0, clip.timelineStart), preferredTimescale: scale)
                )
            }
            audioMixParameters.append(parameters)
        }

        if duration <= 0, let firstVideo = media.values.first(where: { $0.type == "video" || $0.type == "movie" }) {
            let item = AVPlayerItem(url: URL(fileURLWithPath: firstVideo.localPath))
            item.preferredForwardBufferDuration = 0
            return CompositionBuildResult(item: item, duration: firstVideo.duration, warnings: warnings)
        }

        let item = AVPlayerItem(asset: composition)
        item.preferredForwardBufferDuration = 0
        if !audioMixParameters.isEmpty {
            let mix = AVMutableAudioMix()
            mix.inputParameters = audioMixParameters
            item.audioMix = mix
        }
        if let videoComposition = await makeVideoComposition(
            composition: composition,
            placements: placements,
            hasVideoTrack: hasVideoTrack,
            duration: duration,
            renderSize: renderSize,
            fps: spec.fps,
            scale: scale,
            cache: cache,
            timeline: timeline,
            media: media
        ) {
            item.videoComposition = videoComposition
        }
        return CompositionBuildResult(item: item, duration: duration, warnings: warnings)
    }

    /// Splits the timeline at every clip boundary and, per segment, stacks the
    /// active layers bottom-to-top for the custom compositor. A pipeline needs at
    /// least one composition video track, so text-only timelines can't render yet.
    @MainActor
    private static func makeVideoComposition(
        composition: AVMutableComposition,
        placements: [LayerPlacement],
        hasVideoTrack: Bool,
        duration: Double,
        renderSize: CGSize,
        fps: Double,
        scale: CMTimeScale,
        cache: RenderCache?,
        timeline: TimelineData,
        media: [String: MediaAsset]
    ) async -> AVMutableVideoComposition? {
        guard hasVideoTrack, !placements.isEmpty, duration > 0 else { return nil }

        var raw: [Double] = [0, duration]
        for placement in placements {
            raw.append(placement.range.start.seconds)
            raw.append(placement.range.end.seconds)
        }
        var boundaries: [Double] = []
        for value in raw.filter({ $0.isFinite && $0 >= 0 && $0 <= duration }).sorted() {
            if let last = boundaries.last, value - last < 0.001 { continue }
            boundaries.append(value)
        }
        guard boundaries.count >= 2 else { return nil }

        var instructions: [AVVideoCompositionInstructionProtocol] = []
        for index in 0..<(boundaries.count - 1) {
            let start = boundaries[index]
            let end = boundaries[index + 1]
            let mid = (start + end) / 2
            let range = CMTimeRange(
                start: CMTime(seconds: start, preferredTimescale: scale),
                end: CMTime(seconds: end, preferredTimescale: scale)
            )
            // Bottom-to-top: highest track order (bottom) first, order 0 (top) last.
            let active = placements
                .filter { $0.range.start.seconds <= mid && mid < $0.range.end.seconds }
                .sorted { $0.order > $1.order }
            let videoCount = active.reduce(0) { count, placement in
                if case .video = placement.spec { return count + 1 }
                return count
            }

            var layers = active.map(\.spec)
            // Fast path — ONLY for the expensive case (≥2 video layers). A finished
            // background render replaces those layers with one flattened stream;
            // otherwise fall back to the untouched live layers and kick a render.
            // Single-video segments never enter this branch.
            if videoCount >= 2, let cache {
                let key = segmentKey(canvas: renderSize, start: start, end: end, active: active)
                if let url = cache.cachedURL(for: key),
                   let flattened = await insertCachedTrack(url: url, into: composition, at: start, length: end - start, renderSize: renderSize, scale: scale) {
                    layers = [flattened]
                } else {
                    cache.requestRender(key: key, timeline: timeline, media: media, range: range, canvas: renderSize)
                }
            }
            instructions.append(LayeredInstruction(timeRange: range, layers: layers))
        }

        let videoComposition = AVMutableVideoComposition()
        videoComposition.customVideoCompositorClass = LayeredCompositor.self
        videoComposition.renderSize = renderSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, fps.rounded())))
        videoComposition.instructions = instructions
        return videoComposition
    }

    private static func segmentKey(canvas: CGSize, start: Double, end: Double, active: [LayerPlacement]) -> String {
        let layers = active.map(\.fingerprint).sorted().joined(separator: "|")
        return "\(Int(canvas.width))x\(Int(canvas.height))@\(Int((start * 1000).rounded()))-\(Int((end * 1000).rounded()))#\(layers)"
    }

    /// Inserts a pre-rendered (flattened) segment file as one composition track and
    /// returns a single video layer that fits it back onto the canvas.
    @MainActor
    private static func insertCachedTrack(url: URL, into composition: AVMutableComposition, at start: Double, length: Double, renderSize: CGSize, scale: CMTimeScale) async -> LayerSpec? {
        let asset = AVURLAsset(url: url)
        guard let sourceTrack = try? await asset.loadTracks(withMediaType: .video).first,
              let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            return nil
        }
        do {
            try track.insertTimeRange(
                CMTimeRange(start: .zero, duration: CMTime(seconds: max(0.001, length), preferredTimescale: scale)),
                of: sourceTrack,
                at: CMTime(seconds: max(0, start), preferredTimescale: scale)
            )
        } catch {
            return nil
        }
        let natural = (try? await sourceTrack.load(.naturalSize)) ?? renderSize
        let preferred = (try? await sourceTrack.load(.preferredTransform)) ?? .identity
        // The file already holds the full composite at canvas size; an identity
        // clip transform fits it straight back onto the canvas.
        let identity = TimelineElement(id: "cache", type: .video, timelineStart: 0)
        return .video(
            trackID: track.trackID,
            transform: videoTransform(natural: natural, preferred: preferred, clip: identity, renderSize: renderSize),
            opacity: 1
        )
    }

    /// Maps a source frame into the render canvas: source orientation, then an
    /// aspect-fill so it covers the frame, then the clip's own scale (< 1 makes a
    /// picture-in-picture) and center offset.
    private static func videoTransform(natural: CGSize, preferred: CGAffineTransform, clip: TimelineElement, renderSize: CGSize) -> CGAffineTransform {
        let displayed = CGRect(origin: .zero, size: natural).applying(preferred)
        let displayW = abs(displayed.width)
        let displayH = abs(displayed.height)
        guard displayW > 0, displayH > 0 else { return preferred }

        let clipScale = CGFloat(max(0.01, clip.transform?.scale ?? 1))
        let fill = max(renderSize.width / displayW, renderSize.height / displayH) * clipScale

        var t = preferred
        t = t.concatenating(CGAffineTransform(translationX: -displayed.minX, y: -displayed.minY))
        t = t.concatenating(CGAffineTransform(scaleX: fill, y: fill))
        let width = displayW * fill
        let height = displayH * fill
        let offsetX = CGFloat(clip.transform?.x ?? 0) * renderSize.width / 2
        let offsetY = CGFloat(clip.transform?.y ?? 0) * renderSize.height / 2
        t = t.concatenating(CGAffineTransform(
            translationX: (renderSize.width - width) / 2 + offsetX,
            y: (renderSize.height - height) / 2 + offsetY
        ))
        return t
    }
}
