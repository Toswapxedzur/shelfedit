@preconcurrency import AVFoundation
import AppKit

/// Async, cached video-frame thumbnails for the timeline filmstrip.
///
/// Sampling is driven by the clip's own cell grid, so a given source time stays
/// stable while scrolling and only moves when the scale changes. Extraction is
/// lazy — only cells that actually get drawn ask for a frame — and while an
/// exact frame is pending the nearest already-decoded frame stands in, so a cell
/// never flashes empty after a zoom.
@MainActor
final class ThumbnailCache {
    var onReady: (() -> Void)?

    private var images: [String: [Double: NSImage]] = [:]
    /// Sorted bucket times per media, for the nearest-frame lookup.
    private var buckets: [String: [Double]] = [:]
    private var inFlight: Set<String> = []
    private var generators: [String: AVAssetImageGenerator] = [:]

    /// Sample times snap to one 30fps frame so repeated draws reuse a single
    /// extraction, without collapsing distinct cells when zoomed right in.
    private let quantum = 1.0 / 30.0

    /// The frame for `sourceTime` if we hold it; otherwise starts a lazy
    /// extraction and returns the nearest frame we already have.
    func image(forMedia mediaId: String, path: String, sourceTime: Double) -> NSImage? {
        let bucket = (max(0, sourceTime) / quantum).rounded() * quantum
        if let exact = images[mediaId]?[bucket] { return exact }
        request(mediaId: mediaId, path: path, bucket: bucket)
        return nearest(mediaId: mediaId, to: bucket)
    }

    /// Closest decoded frame by source time — the stand-in a freshly-resampled
    /// cell inherits until its own frame arrives.
    private func nearest(mediaId: String, to bucket: Double) -> NSImage? {
        guard let sorted = buckets[mediaId], !sorted.isEmpty else { return nil }
        var low = 0
        var high = sorted.count - 1
        while low < high {
            let mid = (low + high) / 2
            if sorted[mid] < bucket { low = mid + 1 } else { high = mid }
        }
        var best = sorted[low]
        if low > 0, abs(sorted[low - 1] - bucket) < abs(best - bucket) {
            best = sorted[low - 1]
        }
        return images[mediaId]?[best]
    }

    private func request(mediaId: String, path: String, bucket: Double) {
        let key = "\(mediaId)@\(bucket)"
        guard !inFlight.contains(key) else { return }
        inFlight.insert(key)

        let generator = generator(forMedia: mediaId, path: path)
        let time = CMTime(seconds: bucket, preferredTimescale: 600)
        Task { [weak self] in
            let frame = await Self.copyFrame(generator, at: time)
            guard let self else { return }
            self.inFlight.remove(key)
            guard let frame else { return }
            let image = NSImage(cgImage: frame, size: NSSize(width: frame.width, height: frame.height))
            self.store(mediaId: mediaId, bucket: bucket, image: image)
            self.onReady?()
        }
    }

    private func store(mediaId: String, bucket: Double, image: NSImage) {
        images[mediaId, default: [:]][bucket] = image
        var sorted = buckets[mediaId] ?? []
        let index = sorted.firstIndex { $0 >= bucket } ?? sorted.count
        if index == sorted.count || sorted[index] != bucket {
            sorted.insert(bucket, at: index)
        }
        buckets[mediaId] = sorted
    }

    private func generator(forMedia mediaId: String, path: String) -> AVAssetImageGenerator {
        if let existing = generators[mediaId] { return existing }
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 240, height: 160)
        // Loose tolerance — a filmstrip wants speed, not frame-exact seeks.
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.4, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.4, preferredTimescale: 600)
        generators[mediaId] = generator
        return generator
    }

    /// Nonisolated so the blocking frame copy runs off the main actor; the fresh
    /// CGImage is a disconnected value, safe to hand back.
    private nonisolated static func copyFrame(_ generator: AVAssetImageGenerator, at time: CMTime) async -> CGImage? {
        var actual = CMTime.zero
        return try? generator.copyCGImage(at: time, actualTime: &actual)
    }
}

/// Audio loudness, decoded once at fine resolution.
///
/// The decode produces a mean-magnitude value per small block of samples. Any
/// vertical slice the timeline wants is then just the average of the blocks it
/// spans — cheap enough to recompute every draw, so changing zoom never
/// re-decodes anything.
@MainActor
final class WaveformCache {
    var onReady: (() -> Void)?

    private var envelopes: [String: [Float]] = [:]
    private var inFlight: Set<String> = []

    /// The fine-grained envelope for a media, or nil while it decodes.
    func envelope(forMedia mediaId: String, path: String) -> [Float]? {
        if let cached = envelopes[mediaId] { return cached }
        guard !inFlight.contains(mediaId) else { return nil }
        inFlight.insert(mediaId)
        Task { [weak self] in
            let result = await Self.computeEnvelope(path: path)
            guard let self else { return }
            self.inFlight.remove(mediaId)
            guard let result else { return }
            self.envelopes[mediaId] = result
            self.onReady?()
        }
        return nil
    }

    /// Mean loudness across a source-time range — the value for one vertical
    /// slice. Averaging cached blocks is trivial, so this is effectively free.
    nonisolated func averageAmplitude(
        _ envelope: [Float],
        from start: Double,
        to end: Double,
        mediaDuration: Double
    ) -> Float {
        guard mediaDuration > 0, !envelope.isEmpty else { return 0 }
        let count = Double(envelope.count)
        let lowFraction = clamped(min(start, end) / mediaDuration, 0, 1)
        let highFraction = clamped(max(start, end) / mediaDuration, 0, 1)
        let first = min(Int(lowFraction * count), envelope.count - 1)
        let last = min(max(Int(highFraction * count), first + 1), envelope.count)
        var sum: Float = 0
        for index in first..<last { sum += envelope[index] }
        return sum / Float(last - first)
    }

    /// Streams the audio track as 16-bit PCM, reducing it to a mean-magnitude
    /// value per `blockSize` samples. Nonisolated so the decode runs off the main
    /// actor; `[Float]` is Sendable so the result crosses back cleanly.
    private nonisolated static func computeEnvelope(path: String) async -> [Float]? {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        guard let track = try? await asset.loadTracks(withMediaType: .audio).first else { return nil }
        guard let reader = try? AVAssetReader(asset: asset) else { return nil }

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return nil }
        reader.add(output)
        guard reader.startReading() else { return nil }

        // Fine enough that any zoom can be produced by averaging blocks.
        let blockSize = 512
        var blocks: [Float] = []
        var runningSum: Float = 0
        var counter = 0

        while reader.status == .reading {
            guard let sampleBuffer = output.copyNextSampleBuffer(),
                  let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { break }
            let length = CMBlockBufferGetDataLength(blockBuffer)
            var samples = [Int16](repeating: 0, count: length / MemoryLayout<Int16>.size)
            samples.withUnsafeMutableBytes { raw in
                _ = CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
            }
            for sample in samples {
                runningSum += Float(abs(Int32(sample))) / 32768.0
                counter += 1
                if counter >= blockSize {
                    blocks.append(runningSum / Float(blockSize))
                    runningSum = 0
                    counter = 0
                }
            }
            CMSampleBufferInvalidate(sampleBuffer)
        }
        if counter > 0 { blocks.append(runningSum / Float(counter)) }
        guard !blocks.isEmpty else { return nil }

        // Normalize to the loudest block so quiet material still reads clearly.
        let loudest = blocks.max() ?? 1
        if loudest > 0 {
            for index in blocks.indices { blocks[index] = min(1, blocks[index] / loudest) }
        }
        return blocks
    }
}
