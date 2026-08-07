@preconcurrency import AVFoundation
import CryptoKit
import Foundation

/// Background render cache for the expensive case: time ranges where two or more
/// video layers stack. The live path must decode every layer at once there; this
/// flattens such a segment to a single cached file in the background, so the
/// preview can later play it back as one stream.
///
/// It is strictly additive. Single-video stretches — the already-smooth common
/// case — never consult it and never change, so average performance carries no
/// risk. Only a ≥2-video segment *with a finished render* takes the fast path;
/// until then it falls back to the untouched live compositing.
@MainActor
final class RenderCache {
    /// Called on the main actor when a segment finishes rendering, so the caller
    /// can rebuild the preview and pick up the flattened file.
    var onReady: (() -> Void)?

    private var files: [String: URL] = [:]
    private var inFlight: Set<String> = []
    private let directory: URL

    init() {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("shelfedit-rendercache", isDirectory: true)
        // Fresh each launch: keys embed clip content, but the render format or
        // this code can change between sessions, so don't resurrect old files.
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// The flattened file for a segment key, if it has finished rendering.
    func cachedURL(for key: String) -> URL? { files[key] }

    /// Flattens one overlap segment in the background, at most once per key. The
    /// key embeds the segment's clips and geometry, so any edit yields a new key
    /// (a miss) and the stale file is simply never referenced again.
    func requestRender(key: String, timeline: TimelineData, media: [String: MediaAsset], range: CMTimeRange, canvas: CGSize) {
        guard files[key] == nil, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        let output = directory.appendingPathComponent(Self.fileName(for: key) + ".mov")
        Task { [weak self] in
            let ok = await Self.export(timeline: timeline, media: media, range: range, to: output)
            guard let self else { return }
            self.inFlight.remove(key)
            if ok {
                self.files[key] = output
                self.onReady?()
            }
        }
    }

    /// Renders `range` of a *live* composition (cache: nil, so no substitution and
    /// no recursion) out to a single flattened file.
    private static func export(timeline: TimelineData, media: [String: MediaAsset], range: CMTimeRange, to output: URL) async -> Bool {
        let result = await CompositionBuilder.build(timeline: timeline, media: media, cache: nil)
        guard let composition = result.item.asset as? AVComposition,
              let videoComposition = result.item.videoComposition,
              let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            return false
        }
        export.videoComposition = videoComposition
        export.timeRange = range
        export.outputURL = output
        export.outputFileType = .mov
        try? FileManager.default.removeItem(at: output)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            export.exportAsynchronously { continuation.resume() }
        }
        return export.status == .completed
    }

    private static func fileName(for key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
