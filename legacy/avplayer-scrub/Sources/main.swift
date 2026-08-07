import AppKit
import AVFoundation
import CoreMedia
import QuartzCore

private func formatTime(_ seconds: Double) -> String {
    guard seconds.isFinite && seconds >= 0 else { return "00:00.00" }
    let total = Int(seconds)
    let minutes = total / 60
    let secs = total % 60
    let centis = Int((seconds - Double(total)) * 100.0)
    return String(format: "%02d:%02d.%02d", minutes, secs, centis)
}

private func defaultVideoURL() -> URL? {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let candidates = [
        cwd.appendingPathComponent("Raw 23.mov"),
        cwd.deletingLastPathComponent().appendingPathComponent("Raw 23.mov"),
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Raw 23.mov"),
    ]
    return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
}

final class PlayerSurface: NSView {
    let playerLayer = AVPlayerLayer()

    init(player: AVPlayer) {
        super.init(frame: .zero)
        wantsLayer = true
        layer = CALayer()
        layer?.backgroundColor = NSColor.black.cgColor
        playerLayer.player = player
        playerLayer.videoGravity = .resizeAspect
        layer?.addSublayer(playerLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playerLayer.frame = bounds
        CATransaction.commit()
    }
}

final class ScrubBar: NSView {
    var duration: Double = 0 {
        didSet {
            visibleDuration = min(max(0.5, visibleDuration), max(0.5, duration))
            visibleStart = min(max(0, visibleStart), max(0, duration - visibleDuration))
            needsDisplay = true
        }
    }

    var currentTime: Double = 0 {
        didSet { needsDisplay = true }
    }

    var visibleStart: Double = 0 {
        didSet { needsDisplay = true }
    }

    var visibleDuration: Double = 30 {
        didSet { needsDisplay = true }
    }

    var onScrub: ((Double, Bool) -> Void)?
    var onViewportChanged: (() -> Void)?
    private var isDragging = false

    override var acceptsFirstResponder: Bool { true }

    var secondsPerPixel: Double {
        let inset: CGFloat = 18
        let usable = max(1, bounds.width - inset * 2)
        return visibleDuration / Double(usable)
    }

    func setViewport(start: Double, duration requestedDuration: Double) {
        guard self.duration > 0 else { return }
        let minWindow = min(self.duration, 0.25)
        let maxWindow = max(minWindow, self.duration)
        let nextDuration = min(max(minWindow, requestedDuration), maxWindow)
        let nextStart = min(max(0, start), max(0, self.duration - nextDuration))
        visibleDuration = nextDuration
        visibleStart = nextStart
        onViewportChanged?()
    }

    func centerOnCurrentTime() {
        setViewport(start: currentTime - visibleDuration / 2, duration: visibleDuration)
    }

    func setCurrentTime(_ seconds: Double, follow: Bool) {
        currentTime = min(max(0, seconds), max(0, duration))
        if follow {
            if currentTime < visibleStart {
                setViewport(start: currentTime - visibleDuration * 0.15, duration: visibleDuration)
            } else if currentTime > visibleStart + visibleDuration {
                setViewport(start: currentTime - visibleDuration * 0.85, duration: visibleDuration)
            }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let inset: CGFloat = 18
        let overview = NSRect(x: inset, y: bounds.height - 13, width: max(1, bounds.width - inset * 2), height: 4)
        let midY = bounds.midY - 4
        let track = NSRect(x: inset, y: midY - 3, width: max(1, bounds.width - inset * 2), height: 6)

        NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
        overview.fill()
        if duration > 0 {
            let viewX = overview.minX + overview.width * CGFloat(visibleStart / duration)
            let viewW = overview.width * CGFloat(visibleDuration / duration)
            NSColor.systemBlue.withAlphaComponent(0.35).setFill()
            NSRect(x: viewX, y: overview.minY, width: max(2, viewW), height: overview.height).fill()
        }

        NSColor(calibratedWhite: 0.18, alpha: 1).setFill()
        track.fill()

        let progress = visibleDuration > 0 ? min(1, max(0, (currentTime - visibleStart) / visibleDuration)) : 0
        let filled = NSRect(x: track.minX, y: track.minY, width: track.width * progress, height: track.height)
        NSColor.systemBlue.setFill()
        filled.fill()

        let x = track.minX + track.width * progress
        let line = NSBezierPath()
        line.move(to: NSPoint(x: x, y: 8))
        line.line(to: NSPoint(x: x, y: bounds.height - 8))
        line.lineWidth = isDragging ? 3 : 2
        NSColor.white.setStroke()
        line.stroke()

        let knob = NSRect(x: x - 7, y: midY - 7, width: 14, height: 14)
        NSColor.systemBlue.setFill()
        NSBezierPath(ovalIn: knob).fill()

        drawTicks(in: track)
        drawViewportLabel(inset: inset)
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        isDragging = true
        scrub(event, final: false)
    }

    override func mouseDragged(with event: NSEvent) {
        scrub(event, final: false)
    }

    override func mouseUp(with event: NSEvent) {
        scrub(event, final: true)
        isDragging = false
        needsDisplay = true
    }

    override func scrollWheel(with event: NSEvent) {
        let delta = abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY)
            ? event.scrollingDeltaX
            : event.scrollingDeltaY
        setViewport(start: visibleStart + Double(delta) * secondsPerPixel * 10, duration: visibleDuration)
    }

    private func scrub(_ event: NSEvent, final: Bool) {
        let p = convert(event.locationInWindow, from: nil)
        let inset: CGFloat = 18
        let usable = max(1, bounds.width - inset * 2)
        let frac = min(1, max(0, (p.x - inset) / usable))
        let t = visibleStart + visibleDuration * Double(frac)
        setCurrentTime(t, follow: false)
        onScrub?(t, final)
    }

    private func drawTicks(in track: NSRect) {
        guard visibleDuration > 0 else { return }
        let targetPx: Double = 90
        let raw = visibleDuration / max(1, Double(track.width) / targetPx)
        let steps = [0.033333, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60]
        let step = steps.first { $0 >= raw } ?? 60
        let startTick = floor(visibleStart / step) * step
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        var t = startTick
        while t <= visibleStart + visibleDuration + step {
            if t >= visibleStart {
                let frac = (t - visibleStart) / visibleDuration
                let x = track.minX + track.width * CGFloat(frac)
                let path = NSBezierPath()
                path.move(to: NSPoint(x: x, y: track.minY - 4))
                path.line(to: NSPoint(x: x, y: track.maxY + 4))
                path.lineWidth = 1
                NSColor(calibratedWhite: 0.35, alpha: 1).setStroke()
                path.stroke()
                let label = formatTime(t) as NSString
                label.draw(at: NSPoint(x: x + 4, y: track.minY - 20), withAttributes: attrs)
            }
            t += step
        }
    }

    private func drawViewportLabel(inset: CGFloat) {
        let text = String(
            format: "view %@ - %@   %.3fs/px",
            formatTime(visibleStart),
            formatTime(min(duration, visibleStart + visibleDuration)),
            secondsPerPixel
        ) as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        text.draw(at: NSPoint(x: inset, y: 4), withAttributes: attrs)
    }
}

@MainActor
final class AppController: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var player: AVPlayer!
    private var playerItem: AVPlayerItem!
    private var playerSurface: PlayerSurface!
    private var scrubBar: ScrubBar!
    private var playButton: NSButton!
    private var openButton: NSButton!
    private var zoomInButton: NSButton!
    private var zoomOutButton: NSButton!
    private var fitButton: NSButton!
    private var centerButton: NSButton!
    private var timeLabel: NSTextField!
    private var statusLabel: NSTextField!
    private var timeObserver: Any?

    private var duration: Double = 0
    private var seekInFlight = false
    private var pendingSeek: (seconds: Double, final: Bool)?
    private var lastSeekIssuedAt = CACurrentMediaTime()
    private var seekLatencyMsEMA: Double = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()

        let arg = CommandLine.arguments.dropFirst().first
        if let arg, !arg.isEmpty {
            open(URL(fileURLWithPath: arg))
        } else if let url = defaultVideoURL() {
            open(url)
        } else {
            chooseFile()
        }

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func buildWindow() {
        player = AVPlayer()
        player.automaticallyWaitsToMinimizeStalling = false

        playerSurface = PlayerSurface(player: player)
        scrubBar = ScrubBar(frame: NSRect(x: 0, y: 0, width: 100, height: 48))
        scrubBar.onScrub = { [weak self] seconds, final in
            self?.requestSeek(seconds: seconds, final: final)
        }
        scrubBar.onViewportChanged = { [weak self] in
            self?.updateStatusForViewport()
        }

        playButton = NSButton(title: "Play", target: self, action: #selector(togglePlay))
        playButton.bezelStyle = .rounded

        openButton = NSButton(title: "Open...", target: self, action: #selector(chooseFileAction))
        openButton.bezelStyle = .rounded

        zoomOutButton = NSButton(title: "Zoom -", target: self, action: #selector(zoomOut))
        zoomOutButton.bezelStyle = .rounded

        zoomInButton = NSButton(title: "Zoom +", target: self, action: #selector(zoomIn))
        zoomInButton.bezelStyle = .rounded

        fitButton = NSButton(title: "Fit", target: self, action: #selector(fitTimeline))
        fitButton.bezelStyle = .rounded

        centerButton = NSButton(title: "Center", target: self, action: #selector(centerTimeline))
        centerButton.bezelStyle = .rounded

        timeLabel = NSTextField(labelWithString: "00:00.00 / 00:00.00")
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        timeLabel.textColor = .secondaryLabelColor

        statusLabel = NSTextField(labelWithString: "AVPlayerLayer scrub test")
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail

        let controls = NSStackView(views: [
            openButton,
            playButton,
            zoomOutButton,
            zoomInButton,
            fitButton,
            centerButton,
            timeLabel,
            statusLabel,
        ])
        controls.orientation = .horizontal
        controls.alignment = .centerY
        controls.spacing = 12
        controls.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)

        let root = NSStackView(views: [playerSurface, controls, scrubBar])
        root.orientation = .vertical
        root.spacing = 0
        root.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.black.cgColor
        content.addSubview(root)

        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            root.topAnchor.constraint(equalTo: content.topAnchor),
            root.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            playerSurface.heightAnchor.constraint(greaterThanOrEqualToConstant: 360),
            scrubBar.heightAnchor.constraint(equalToConstant: 68),
        ])

        window = NSWindow(
            contentRect: NSRect(x: 120, y: 120, width: 1200, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AVPlayer Scrub Test"
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func chooseFileAction() {
        chooseFile()
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.title = "Choose a video"
        panel.allowedContentTypes = [.movie, .mpeg4Movie, .quickTimeMovie, .video]
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            open(url)
        }
    }

    private func open(_ url: URL) {
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }

        let asset = AVURLAsset(url: url)
        playerItem = AVPlayerItem(asset: asset)
        playerItem.preferredForwardBufferDuration = 0
        player.replaceCurrentItem(with: playerItem)

        window.title = "AVPlayer Scrub Test - \(url.lastPathComponent)"
        statusLabel.stringValue = "Loading duration..."

        Task { @MainActor in
            do {
                let loadedDuration = try await asset.load(.duration)
                duration = loadedDuration.seconds.isFinite ? loadedDuration.seconds : 0
                scrubBar.duration = duration
                scrubBar.setViewport(start: 0, duration: min(max(0.25, duration), 30))
                updateLabels(seconds: 0)
                updateStatusForViewport(prefix: "Drag the zoomed playhead.")
            } catch {
                statusLabel.stringValue = "Could not load duration: \(error.localizedDescription)"
            }
        }

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 60),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                guard let self else { return }
                let seconds = time.seconds
                if !self.seekInFlight {
                    self.scrubBar.setCurrentTime(seconds, follow: true)
                }
                self.updateLabels(seconds: seconds)
            }
        }
    }

    @objc private func togglePlay() {
        if player.timeControlStatus == .playing {
            player.pause()
            playButton.title = "Play"
        } else {
            player.play()
            playButton.title = "Pause"
        }
    }

    @objc private func zoomIn() {
        zoom(by: 0.5)
    }

    @objc private func zoomOut() {
        zoom(by: 2.0)
    }

    @objc private func fitTimeline() {
        scrubBar.setViewport(start: 0, duration: max(0.25, duration))
    }

    @objc private func centerTimeline() {
        scrubBar.centerOnCurrentTime()
    }

    private func zoom(by factor: Double) {
        guard duration > 0 else { return }
        let center = scrubBar.currentTime
        let nextDuration = scrubBar.visibleDuration * factor
        scrubBar.setViewport(start: center - nextDuration / 2, duration: nextDuration)
    }

    private func updateLabels(seconds: Double) {
        timeLabel.stringValue = "\(formatTime(seconds)) / \(formatTime(duration))"
    }

    private func requestSeek(seconds: Double, final: Bool) {
        player.pause()
        playButton.title = "Play"
        scrubBar.setCurrentTime(seconds, follow: false)
        updateLabels(seconds: seconds)

        if seekInFlight {
            pendingSeek = (seconds, final)
            return
        }
        issueSeek(seconds: seconds, final: final)
    }

    private func issueSeek(seconds: Double, final: Bool) {
        seekInFlight = true
        lastSeekIssuedAt = CACurrentMediaTime()

        let target = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        let dynamicToleranceSeconds = max(1.0 / 120.0, min(1.0 / 24.0, scrubBar.secondsPerPixel * 0.75))
        let tolerance = final ? CMTime.zero : CMTime(seconds: dynamicToleranceSeconds, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: tolerance, toleranceAfter: tolerance) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let ms = (CACurrentMediaTime() - self.lastSeekIssuedAt) * 1000
                self.seekLatencyMsEMA = self.seekLatencyMsEMA == 0 ? ms : self.seekLatencyMsEMA * 0.75 + ms * 0.25
                self.statusLabel.stringValue = String(
                    format: "%@ seek %.0f ms avg %.0f ms   %.3fs/px",
                    final ? "exact" : "smooth",
                    ms,
                    self.seekLatencyMsEMA,
                    self.scrubBar.secondsPerPixel
                )
                self.seekInFlight = false
                if let pending = self.pendingSeek {
                    self.pendingSeek = nil
                    self.issueSeek(seconds: pending.seconds, final: pending.final)
                }
            }
        }
    }

    private func updateStatusForViewport(prefix: String? = nil) {
        let base = prefix ?? "Viewport"
        statusLabel.stringValue = String(
            format: "%@ %.1fs wide, %.3fs/px. Wheel scrolls; release parks exact.",
            base,
            scrubBar.visibleDuration,
            scrubBar.secondsPerPixel
        )
    }
}

let app = NSApplication.shared
let delegate = AppController()
app.delegate = delegate
app.run()
