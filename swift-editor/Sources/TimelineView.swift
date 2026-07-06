import AppKit

enum TimelineDragKind {
    case body
    case trimStart
    case trimEnd
    case scrub
}

final class TimelineView: NSView {
    var timeline = TimelineData.empty() {
        didSet {
            duration = max(duration, timeline.duration)
            needsDisplay = true
        }
    }
    var duration: Double = 0 {
        didSet {
            visibleDuration = min(max(0.25, visibleDuration), max(0.25, duration))
            visibleStart = clamped(visibleStart, 0, max(0, duration - visibleDuration))
            needsDisplay = true
        }
    }
    var currentTime: Double = 0 {
        didSet { needsDisplay = true }
    }
    var selectedElementId: String? {
        didSet { needsDisplay = true }
    }
    var visibleStart: Double = 0 {
        didSet { needsDisplay = true }
    }
    var visibleDuration: Double = 30 {
        didSet { needsDisplay = true }
    }

    var onScrub: ((Double, Bool) -> Void)?
    var onSelect: ((String?) -> Void)?
    var onClipDrag: ((String, TimelineDragKind, Double, Bool) -> Void)?
    var onViewportChanged: (() -> Void)?

    private let leftGutter: CGFloat = 92
    private let rightInset: CGFloat = 14
    private let rulerHeight: CGFloat = 30
    private let rowHeight: CGFloat = 58
    private let clipInset: CGFloat = 8
    private var dragState: DragState?

    private struct DragState {
        let kind: TimelineDragKind
        let elementId: String?
        let startTime: Double
    }

    override var acceptsFirstResponder: Bool { true }

    var secondsPerPixel: Double {
        visibleDuration / Double(max(1, timelineRect.width))
    }

    private var timelineRect: NSRect {
        NSRect(
            x: leftGutter,
            y: 0,
            width: max(1, bounds.width - leftGutter - rightInset),
            height: bounds.height
        )
    }

    func setViewport(start: Double, duration requestedDuration: Double) {
        let minWindow = min(max(0.1, duration), 1.0 / 30.0)
        let maxWindow = max(minWindow, max(0.25, duration))
        let nextDuration = clamped(requestedDuration, minWindow, maxWindow)
        visibleDuration = nextDuration
        visibleStart = clamped(start, 0, max(0, maxWindow - nextDuration))
        onViewportChanged?()
    }

    func setCurrentTime(_ seconds: Double, follow: Bool) {
        currentTime = clamped(seconds, 0, max(0, duration))
        guard follow else { return }
        if currentTime < visibleStart {
            setViewport(start: currentTime - visibleDuration * 0.15, duration: visibleDuration)
        } else if currentTime > visibleStart + visibleDuration {
            setViewport(start: currentTime - visibleDuration * 0.85, duration: visibleDuration)
        }
    }

    func centerOnCurrentTime() {
        setViewport(start: currentTime - visibleDuration / 2, duration: visibleDuration)
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: max(180, rulerHeight + CGFloat(timeline.tracks.count) * rowHeight))
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.clear.setFill()
        bounds.fill()
        drawPanelBase()
        drawRuler()
        drawTracks()
        drawPlayhead()
        drawViewportText()
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        let time = time(atX: point.x)

        if let hit = hitTestClip(at: point) {
            selectedElementId = hit.element.id
            onSelect?(hit.element.id)
            dragState = DragState(kind: hit.kind, elementId: hit.element.id, startTime: time)
        } else {
            selectedElementId = nil
            onSelect?(nil)
            dragState = DragState(kind: .scrub, elementId: nil, startTime: time)
            setCurrentTime(time, follow: false)
            onScrub?(time, false)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let dragState else { return }
        let point = convert(event.locationInWindow, from: nil)
        let time = time(atX: point.x)
        let delta = time - dragState.startTime
        if dragState.kind == .scrub {
            setCurrentTime(time, follow: false)
            onScrub?(time, false)
        } else if let id = dragState.elementId {
            onClipDrag?(id, dragState.kind, delta, false)
        }
    }

    override func mouseUp(with event: NSEvent) {
        guard let dragState else { return }
        let point = convert(event.locationInWindow, from: nil)
        let time = time(atX: point.x)
        let delta = time - dragState.startTime
        if dragState.kind == .scrub {
            setCurrentTime(time, follow: false)
            onScrub?(time, true)
        } else if let id = dragState.elementId {
            onClipDrag?(id, dragState.kind, delta, true)
        }
        self.dragState = nil
    }

    override func scrollWheel(with event: NSEvent) {
        let delta = abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY)
            ? event.scrollingDeltaX
            : event.scrollingDeltaY
        setViewport(start: visibleStart + Double(delta) * secondsPerPixel * 10, duration: visibleDuration)
    }

    private func drawRuler() {
        let rect = NSRect(x: 0, y: bounds.height - rulerHeight, width: bounds.width, height: rulerHeight)
        NSColor.white.withAlphaComponent(0.90).setFill()
        rect.fill()

        let attrs: [NSAttributedString.Key: Any] = [
            .font: ShelfStyle.font(size: 10, weight: .semibold),
            .foregroundColor: ShelfStyle.muted,
        ]
        ("ShelfEdit Native" as NSString).draw(at: NSPoint(x: 12, y: rect.minY + 8), withAttributes: attrs)

        let targetPx: Double = 92
        let raw = visibleDuration / max(1, Double(timelineRect.width) / targetPx)
        let steps = [1.0 / 30.0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
        let step = steps.first { $0 >= raw } ?? 300
        var t = floor(visibleStart / step) * step
        while t <= visibleStart + visibleDuration + step {
            if t >= visibleStart {
                let x = x(forTime: t)
                let path = NSBezierPath()
                path.move(to: NSPoint(x: x, y: rect.minY))
                path.line(to: NSPoint(x: x, y: rect.maxY))
                path.lineWidth = 1
                NSColor(hex: 0x94a3b8, alpha: 0.24).setStroke()
                path.stroke()
                (formatTime(t) as NSString).draw(at: NSPoint(x: x + 4, y: rect.minY + 8), withAttributes: attrs)
            }
            t += step
        }

        NSColor(hex: 0x94a3b8, alpha: 0.25).setStroke()
        let bottom = NSBezierPath()
        bottom.move(to: NSPoint(x: 0, y: rect.minY))
        bottom.line(to: NSPoint(x: bounds.width, y: rect.minY))
        bottom.stroke()
    }

    private func drawTracks() {
        let sortedTracks = timeline.tracks.sorted { $0.order < $1.order }
        for (displayIndex, track) in sortedTracks.enumerated() {
            let row = rowRect(displayIndex: displayIndex)
            let background = displayIndex.isMultiple(of: 2)
                ? ShelfStyle.genericLight.withAlphaComponent(0.70)
                : ShelfStyle.videoLight.withAlphaComponent(0.55)
            background.setFill()
            row.fill()

            let labelAttrs: [NSAttributedString.Key: Any] = [
                .font: ShelfStyle.bold(size: 11),
                .foregroundColor: track.hidden == true ? ShelfStyle.muted : ShelfStyle.body,
            ]
            (track.name as NSString).draw(
                in: NSRect(x: 12, y: row.midY - 8, width: leftGutter - 20, height: 18),
                withAttributes: labelAttrs
            )

            for clip in track.elements {
                drawClip(clip, in: row, trackHidden: track.hidden ?? false)
            }

            NSColor(hex: 0x94a3b8, alpha: 0.18).setStroke()
            let line = NSBezierPath()
            line.move(to: NSPoint(x: 0, y: row.minY))
            line.line(to: NSPoint(x: bounds.width, y: row.minY))
            line.stroke()
        }
    }

    private func drawClip(_ clip: TimelineElement, in row: NSRect, trackHidden: Bool) {
        let start = x(forTime: clip.timelineStart)
        let end = x(forTime: clip.end)
        let visibleMin = max(timelineRect.minX, min(start, end))
        let visibleMax = min(timelineRect.maxX, max(start, end))
        guard visibleMax > visibleMin else { return }

        let rect = NSRect(
            x: visibleMin,
            y: row.minY + clipInset,
            width: visibleMax - visibleMin,
            height: max(18, row.height - clipInset * 2)
        )
        let path = NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12)
        fillColor(for: clip, hidden: trackHidden).setFill()
        path.fill()

        let selected = clip.id == selectedElementId
        (selected ? ShelfStyle.navy2 : NSColor(hex: 0x334155, alpha: 0.85)).setStroke()
        path.lineWidth = selected ? 2.5 : 1
        path.stroke()

        let edgeColor = ShelfStyle.navy.withAlphaComponent(selected ? 0.65 : 0.25)
        edgeColor.setFill()
        NSBezierPath(roundedRect: NSRect(x: rect.minX + 6, y: rect.minY + 7, width: 3, height: rect.height - 14), xRadius: 1.5, yRadius: 1.5).fill()
        NSBezierPath(roundedRect: NSRect(x: rect.maxX - 9, y: rect.minY + 7, width: 3, height: rect.height - 14), xRadius: 1.5, yRadius: 1.5).fill()

        let title = clip.text ?? clip.mediaId?.shortStableId ?? clip.id.shortStableId
        let label = "\(clip.type.rawValue)  \(title)" as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: ShelfStyle.bold(size: 11),
            .foregroundColor: ShelfStyle.text,
        ]
        label.draw(
            in: rect.insetBy(dx: 10, dy: max(4, (rect.height - 16) / 2)),
            withAttributes: attrs
        )
    }

    private func drawPlayhead() {
        let x = x(forTime: currentTime)
        guard x >= timelineRect.minX - 1 && x <= timelineRect.maxX + 1 else { return }
        let path = NSBezierPath()
        path.move(to: NSPoint(x: x, y: 0))
        path.line(to: NSPoint(x: x, y: bounds.height))
        path.lineWidth = dragState?.kind == .scrub ? 3 : 2
        ShelfStyle.navy2.setStroke()
        path.stroke()

        ShelfStyle.navy2.setFill()
        NSBezierPath(ovalIn: NSRect(x: x - 5, y: bounds.height - rulerHeight - 5, width: 10, height: 10)).fill()
    }

    private func drawViewportText() {
        let text = String(
            format: "%@ - %@   %.4fs/px",
            formatTime(visibleStart),
            formatTime(min(duration, visibleStart + visibleDuration)),
            secondsPerPixel
        ) as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular),
            .foregroundColor: ShelfStyle.muted,
        ]
        text.draw(at: NSPoint(x: leftGutter, y: 8), withAttributes: attrs)
    }

    private func fillColor(for clip: TimelineElement, hidden: Bool) -> NSColor {
        let alpha: CGFloat = hidden ? 0.35 : 0.92
        switch clip.type {
        case .video:
            return ShelfStyle.videoLight.withAlphaComponent(alpha)
        case .audio:
            return ShelfStyle.audioLight.withAlphaComponent(alpha)
        case .text:
            return ShelfStyle.textLight.withAlphaComponent(alpha)
        }
    }

    private func drawPanelBase() {
        let path = NSBezierPath(roundedRect: bounds, xRadius: 12, yRadius: 12)
        NSColor.white.withAlphaComponent(0.82).setFill()
        path.fill()
        ShelfStyle.navy.withAlphaComponent(0.80).setFill()
        NSBezierPath(
            roundedRect: NSRect(x: 0, y: 0, width: 4, height: bounds.height),
            xRadius: 2,
            yRadius: 2
        ).fill()
    }

    private func rowRect(displayIndex: Int) -> NSRect {
        let y = bounds.height - rulerHeight - CGFloat(displayIndex + 1) * rowHeight
        return NSRect(x: 0, y: y, width: bounds.width, height: rowHeight)
    }

    private func x(forTime time: Double) -> CGFloat {
        let fraction = (time - visibleStart) / max(0.001, visibleDuration)
        return timelineRect.minX + timelineRect.width * CGFloat(fraction)
    }

    private func time(atX x: CGFloat) -> Double {
        let fraction = Double(clamped((x - timelineRect.minX) / timelineRect.width, 0, 1))
        return visibleStart + visibleDuration * fraction
    }

    private func hitTestClip(at point: NSPoint) -> (element: TimelineElement, kind: TimelineDragKind)? {
        let sortedTracks = timeline.tracks.sorted { $0.order < $1.order }
        for (displayIndex, track) in sortedTracks.enumerated() {
            guard rowRect(displayIndex: displayIndex).contains(point), !(track.locked ?? false) else { continue }
            for clip in track.elements.reversed() {
                let start = x(forTime: clip.timelineStart)
                let end = x(forTime: clip.end)
                let rect = NSRect(
                    x: max(timelineRect.minX, min(start, end)),
                    y: rowRect(displayIndex: displayIndex).minY + clipInset,
                    width: max(1, min(timelineRect.maxX, max(start, end)) - max(timelineRect.minX, min(start, end))),
                    height: max(18, rowHeight - clipInset * 2)
                )
                guard rect.contains(point) else { continue }
                if abs(point.x - rect.minX) <= 8 {
                    return (clip, .trimStart)
                }
                if abs(point.x - rect.maxX) <= 8 {
                    return (clip, .trimEnd)
                }
                return (clip, .body)
            }
        }
        return nil
    }
}
