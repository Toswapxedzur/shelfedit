@preconcurrency import AppKit
@preconcurrency import AVFoundation
import CoreImage
import Metal
import MetalKit

@MainActor
final class MetalVideoSurface: NSView {
    private let mtkView: MTKView
    private let renderer: MetalVideoRenderer

    init(player: AVPlayer) {
        guard let device = MTLCreateSystemDefaultDevice() else {
            fatalError("Metal is not available on this Mac")
        }
        mtkView = MTKView(frame: .zero, device: device)
        renderer = MetalVideoRenderer(player: player, device: device)
        super.init(frame: .zero)

        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.black.cgColor

        mtkView.translatesAutoresizingMaskIntoConstraints = false
        mtkView.delegate = renderer
        mtkView.framebufferOnly = false
        mtkView.enableSetNeedsDisplay = false
        mtkView.isPaused = false
        mtkView.preferredFramesPerSecond = 60
        mtkView.clearColor = MTLClearColor(red: 0.01, green: 0.014, blue: 0.025, alpha: 1)
        addSubview(mtkView)

        NSLayoutConstraint.activate([
            mtkView.leadingAnchor.constraint(equalTo: leadingAnchor),
            mtkView.trailingAnchor.constraint(equalTo: trailingAnchor),
            mtkView.topAnchor.constraint(equalTo: topAnchor),
            mtkView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func attach(item: AVPlayerItem) {
        renderer.attach(item: item)
    }
}

@MainActor
private final class MetalVideoRenderer: NSObject, MTKViewDelegate {
    private let player: AVPlayer
    private let commandQueue: MTLCommandQueue
    private let ciContext: CIContext
    private var output: AVPlayerItemVideoOutput?
    private var lastImage: CIImage?

    init(player: AVPlayer, device: MTLDevice) {
        self.player = player
        commandQueue = device.makeCommandQueue()!
        ciContext = CIContext(mtlDevice: device)
        super.init()
    }

    func attach(item: AVPlayerItem) {
        let attributes: [String: NSObject] = [
            kCVPixelBufferPixelFormatTypeKey as String: NSNumber(value: kCVPixelFormatType_32BGRA),
            kCVPixelBufferMetalCompatibilityKey as String: NSNumber(value: true),
        ]
        let nextOutput = AVPlayerItemVideoOutput(pixelBufferAttributes: attributes)
        nextOutput.suppressesPlayerRendering = true
        item.add(nextOutput)
        output = nextOutput
        lastImage = nil
    }

    nonisolated func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    nonisolated func draw(in view: MTKView) {
        Task { @MainActor in
            self.drawOnMain(in: view)
        }
    }

    private func drawOnMain(in view: MTKView) {
        guard
            let drawable = view.currentDrawable,
            let commandBuffer = commandQueue.makeCommandBuffer()
        else { return }

        if let image = currentFrameImage() {
            lastImage = image
        }

        guard let image = lastImage else {
            commandBuffer.present(drawable)
            commandBuffer.commit()
            return
        }

        let destination = CGRect(
            x: 0,
            y: 0,
            width: drawable.texture.width,
            height: drawable.texture.height
        )
        let fitted = aspectFit(image, in: destination)
        ciContext.render(
            fitted,
            to: drawable.texture,
            commandBuffer: commandBuffer,
            bounds: destination,
            colorSpace: CGColorSpaceCreateDeviceRGB()
        )
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    private func currentFrameImage() -> CIImage? {
        guard let output else { return nil }
        let hostTime = CACurrentMediaTime()
        let itemTime = output.itemTime(forHostTime: hostTime)
        if output.hasNewPixelBuffer(forItemTime: itemTime),
           let buffer = output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil) {
            return CIImage(cvPixelBuffer: buffer)
        }
        let currentTime = player.currentTime()
        if let buffer = output.copyPixelBuffer(forItemTime: currentTime, itemTimeForDisplay: nil) {
            return CIImage(cvPixelBuffer: buffer)
        }
        return nil
    }

    private func aspectFit(_ image: CIImage, in destination: CGRect) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0, destination.width > 0, destination.height > 0 else {
            return image
        }
        let scale = min(destination.width / extent.width, destination.height / extent.height)
        let width = extent.width * scale
        let height = extent.height * scale
        let tx = (destination.width - width) / 2
        let ty = (destination.height - height) / 2

        let transformed = image.transformed(
            by: CGAffineTransform(scaleX: scale, y: scale)
                .translatedBy(x: tx / scale, y: ty / scale)
        )
        let background = CIImage(color: CIColor(red: 0.01, green: 0.014, blue: 0.025))
            .cropped(to: destination)
        return transformed.composited(over: background)
    }
}
