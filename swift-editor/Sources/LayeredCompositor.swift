@preconcurrency import AVFoundation
import CoreImage

/// One drawable layer inside a segment, in the timeline's z-order. Video layers
/// pull a source track frame; image layers (text) carry a pre-rendered picture.
enum LayerSpec {
    case video(trackID: CMPersistentTrackID, transform: CGAffineTransform, opacity: CGFloat)
    case image(CIImage, opacity: CGFloat)
}

/// A time segment plus its layers, bottom-to-top. Text and video share this one
/// list, so a text layer can sit between two video layers.
final class LayeredInstruction: NSObject, AVVideoCompositionInstructionProtocol, @unchecked Sendable {
    let timeRange: CMTimeRange
    let enablePostProcessing = false
    let containsTweening = false
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID = kCMPersistentTrackID_Invalid
    let layers: [LayerSpec]

    init(timeRange: CMTimeRange, layers: [LayerSpec]) {
        self.timeRange = timeRange
        self.layers = layers
        let ids = layers.compactMap { layer -> NSNumber? in
            if case let .video(trackID, _, _) = layer { return NSNumber(value: trackID) }
            return nil
        }
        requiredSourceTrackIDs = ids.isEmpty ? nil : ids
        super.init()
    }
}

/// Composites each segment's layers in order with Core Image. Video frames come
/// from the requested source tracks; text comes in as ready-made images. This is
/// what makes true interleaving possible — video over text over video.
final class LayeredCompositor: NSObject, AVVideoCompositing, @unchecked Sendable {
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let queue = DispatchQueue(label: "shelfedit.compositor")

    var sourcePixelBufferAttributes: [String: any Sendable]? = [
        kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_32BGRA],
    ]
    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = [
        kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_32BGRA],
    ]

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        queue.async {
            guard let instruction = request.videoCompositionInstruction as? LayeredInstruction,
                  let destination = request.renderContext.newPixelBuffer() else {
                request.finishCancelledRequest()
                return
            }
            let size = request.renderContext.size
            let frame = CGRect(origin: .zero, size: size)

            // Start on black, then lay each layer over the last, bottom-to-top.
            var composite = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: frame)
            for layer in instruction.layers {
                switch layer {
                case let .video(trackID, transform, opacity):
                    guard let source = request.sourceFrame(byTrackID: trackID) else { continue }
                    let image = Self.applyOpacity(
                        CIImage(cvPixelBuffer: source).transformed(by: transform),
                        opacity
                    )
                    composite = image.cropped(to: frame).composited(over: composite)
                case let .image(image, opacity):
                    composite = Self.applyOpacity(image, opacity).cropped(to: frame).composited(over: composite)
                }
            }

            self.ciContext.render(
                composite,
                to: destination,
                bounds: frame,
                colorSpace: CGColorSpaceCreateDeviceRGB()
            )
            request.finish(withComposedVideoFrame: destination)
        }
    }

    private static func applyOpacity(_ image: CIImage, _ opacity: CGFloat) -> CIImage {
        guard opacity < 0.999 else { return image }
        return image.applyingFilter("CIColorMatrix", parameters: [
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: max(0, opacity)),
        ])
    }
}
