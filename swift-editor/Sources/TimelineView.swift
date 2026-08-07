import AppKit

enum TimelineDragKind {
    case body
    case trimStart
    case trimEnd
    case scrub
}

enum TimelineTool {
    case select
    case blade
}

final class TimelineView: NSView {
    var timeline = TimelineData.empty() {
        didSet {
            duration = max(duration, timeline.duration)
            clampTrackScroll()   // removing tracks can shrink the scrollable range
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
    var activeTool: TimelineTool = .select {
        didSet { needsDisplay = true }
    }
    var visibleStart: Double = 0 {
        didSet { needsDisplay = true }
    }
    var visibleDuration: Double = 30 {
        didSet { needsDisplay = true }
    }

    /// Media keyed by id, so a clip can resolve its source file for the
    /// filmstrip / waveform it draws.
    var media: [String: MediaAsset] = [:] {
        didSet { needsDisplay = true }
    }

    var onScrub: ((Double, Bool) -> Void)?
    var onSelect: ((String?) -> Void)?
    var onBlade: ((String, Double) -> Void)?
    var onClipDrag: ((String, TimelineDragKind, Double, Bool) -> Void)?
    /// Body move committed on release: (id, targetTrackIndex, newStart). A
    /// targetTrackIndex == track count means "create a new track for this clip".
    var onClipMoved: ((String, Int, Double) -> Void)?
    var onViewportChanged: (() -> Void)?

    // ---- Per-track header controls ----
    var onTrackToggleCollapsed: ((String) -> Void)?
    var onTrackToggleHidden: ((String) -> Void)?
    var onTrackToggleMuted: ((String) -> Void)?
    var onTrackToggleLocked: ((String) -> Void)?
    /// Reorder a track by a signed step: -1 = move up (earlier row), +1 = down.
    var onTrackReorder: ((String, Int) -> Void)?
    var onTrackDelete: ((String) -> Void)?
    var onTrackRename: ((String, String) -> Void)?

    private let leftGutter: CGFloat = 148
    private let rightInset: CGFloat = 14
    private let rulerHeight: CGFloat = 30
    private let collapsedRowHeight: CGFloat = 22
    private let clipInset: CGFloat = 8

    /// Lanes are sized to their content — video needs room for a filmstrip,
    /// audio less, text is a thin strip — and collapse to a sliver on demand.
    private func height(for track: TimelineTrack) -> CGFloat {
        track.collapsed == true ? collapsedRowHeight : height(forKind: track.kind)
    }

    private func height(forKind kind: TrackKind) -> CGFloat {
        switch kind {
        case .video: return 72
        case .audio: return 52
        case .text: return 38
        }
    }

    private var orderedTracks: [TimelineTrack] {
        timeline.tracks.sorted { $0.order < $1.order }
    }

    /// Vertical scroll position of the track stack, in points (0 = topmost track
    /// flush under the ruler). The timeline is a 2D canvas: track height is fixed
    /// and whatever falls outside the viewport — above, below, left or right — is
    /// simply hidden until you scroll to it.
    var trackScroll: CGFloat = 0 {
        didSet { needsDisplay = true }
    }

    private var tracksContentHeight: CGFloat {
        timeline.tracks.reduce(0) { $0 + height(for: $1) }
    }

    /// Furthest the stack can scroll before the last track rests on the bottom
    /// edge. Zero when every track already fits.
    private var maxTrackScroll: CGFloat {
        max(0, tracksContentHeight - (bounds.height - rulerHeight))
    }

    private var dragState: DragState?
    private var bodyDrag: BodyDrag?
    /// Anchor time the dragged clip is currently snapped to, for the guide line.
    private var snapIndicator: Double?
    private var renameEditor: NSTextField?
    private var renamingTrackId: String?
    private var symbolCache: [String: NSImage] = [:]

    private lazy var thumbnails: ThumbnailCache = {
        let cache = ThumbnailCache()
        cache.onReady = { [weak self] in self?.needsDisplay = true }
        return cache
    }()

    private lazy var waveforms: WaveformCache = {
        let cache = WaveformCache()
        cache.onReady = { [weak self] in self?.needsDisplay = true }
        return cache
    }()

    private struct DragState {
        let kind: TimelineDragKind
        let elementId: String?
        let startTime: Double
    }

    /// A 2D clip move in progress. The clip follows the cursor freely; the
    /// landing track is decided by the clip's vertical center (its central
    /// horizontal line), and `valid` is false when the spot overlaps or the
    /// target track is the wrong type.
    private struct BodyDrag {
        let elementId: String
        let originalTrackIndex: Int
        let originalStart: Double
        let clipDuration: Double
        let clipType: TrackKind
        let pointerStart: NSPoint
        let originalCenterY: CGFloat
        var proposedStart: Double
        /// Where the clip's center line currently sits, following the cursor
        /// freely — the ghost is drawn here rather than snapped to a row.
        var proposedCenterY: CGFloat
        var targetTrackIndex: Int
        var valid: Bool
    }

    private var tracksTopY: CGFloat { bounds.height - rulerHeight }

    /// Pulls a dragged clip onto meaningful anchors — other clips' edges, the
    /// playhead, the timeline start — once it comes within a few *pixels*, so it
    /// feels identical at every zoom. This is edge magnetism, not a fixed grid:
    /// away from an anchor the clip stays completely free.
    private func snappedStart(
        for proposed: Double,
        duration: Double,
        excluding ids: Set<String>
    ) -> (start: Double, anchor: Double?) {
        let threshold = 8 * secondsPerPixel
        var anchors: [Double] = [0, currentTime]
        for track in timeline.tracks {
            for clip in track.elements where !ids.contains(clip.id) {
                anchors.append(clip.timelineStart)
                anchors.append(clip.end)
            }
        }

        var best: (shift: Double, anchor: Double)?
        for anchor in anchors {
            // Try both edges, so a clip can butt its tail against a neighbour's
            // head just as easily as aligning its head.
            for shift in [anchor - proposed, anchor - (proposed + duration)] {
                guard abs(shift) <= threshold else { continue }
                if abs(shift) < abs(best?.shift ?? .infinity) {
                    best = (shift, anchor)
                }
            }
        }
        guard let best else { return (proposed, nil) }
        return (max(0, proposed + best.shift), best.anchor)
    }

    /// Guide line showing which anchor the dragged clip has locked onto.
    private func drawSnapIndicator() {
        guard bodyDrag != nil, let time = snapIndicator else { return }
        let lineX = x(forTime: time)
        guard lineX >= timelineRect.minX, lineX <= timelineRect.maxX else { return }
        ShelfStyle.goldGlow.withAlphaComponent(0.9).setStroke()
        let path = NSBezierPath()
        path.move(to: NSPoint(x: lineX, y: 0))
        path.line(to: NSPoint(x: lineX, y: tracksTopY))
        path.lineWidth = 2
        path.stroke()
    }

    /// Row index whose band contains vertical center `y`. May return a value
    /// >= track count, meaning the clip's center is below every existing track
    /// (a request to spill into a new track).
    private func trackIndex(atCenterY y: CGFloat) -> Int {
        let tracks = orderedTracks
        var top = tracksTopY + trackScroll
        for (index, track) in tracks.enumerated() {
            let rowH = height(for: track)
            if y >= top - rowH { return index }
            top -= rowH
        }
        return tracks.count
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

    /// The canvas scrolls, so it never demands room for every track — just a sane
    /// minimum. Tracks past the viewport are reached by scrolling, not shrinking.
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 180)
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        clampTrackScroll()   // a taller viewport can reveal tracks we were scrolled past
        needsDisplay = true
    }

    /// Keeps the vertical scroll inside its legal range after the track list or
    /// the viewport size changes.
    func clampTrackScroll() {
        let clamped = min(max(0, trackScroll), maxTrackScroll)
        if clamped != trackScroll { trackScroll = clamped }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.clear.setFill()
        bounds.fill()
        drawPanelBase()
        drawRuler()
        // The track canvas scrolls vertically, so rows can slide up past the
        // ruler line. Clip it to the track region so it scrolls *under* the
        // ruler instead of painting over it.
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: bounds.width, height: tracksTopY)).addClip()
        drawTracks()
        NSGraphicsContext.restoreGraphicsState()

        // The dragged ghost is confined to the timeline viewport, so whatever
        // leaves it — over the header gutter, past the right edge, up into the
        // ruler — simply isn't drawn.
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: NSRect(
            x: timelineRect.minX,
            y: 0,
            width: timelineRect.width,
            height: tracksTopY
        )).addClip()
        drawBodyDragGhost()
        drawSnapIndicator()
        NSGraphicsContext.restoreGraphicsState()

        drawPlayhead()
        drawViewportText()
    }

    override func mouseDown(with event: NSEvent) {
        commitRename()
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)

        // Clicks in the left gutter drive the per-track header controls, never
        // the scrubber. Icons first; a double-click on the name renames it.
        if point.x < leftGutter {
            if let (trackId, action) = headerHit(at: point) {
                performHeaderAction(action, trackId: trackId)
            } else if event.clickCount >= 2, let trackId = trackId(atNameArea: point) {
                beginRename(trackId: trackId, at: point)
            }
            return
        }

        let time = time(atX: point.x)

        if let hit = hitTestClip(at: point) {
            selectedElementId = hit.element.id
            onSelect?(hit.element.id)
            if activeTool == .blade {
                setCurrentTime(time, follow: false)
                onScrub?(time, false)
                onBlade?(hit.element.id, time)
                dragState = nil
                return
            }
            if hit.kind == .body {
                let trackIdx = timeline.trackIndex(ofElementId: hit.element.id) ?? 0
                bodyDrag = BodyDrag(
                    elementId: hit.element.id,
                    originalTrackIndex: trackIdx,
                    originalStart: hit.element.timelineStart,
                    clipDuration: hit.element.timelineDuration,
                    clipType: hit.element.type,
                    pointerStart: point,
                    originalCenterY: rowRect(displayIndex: trackIdx).midY,
                    proposedStart: hit.element.timelineStart,
                    proposedCenterY: rowRect(displayIndex: trackIdx).midY,
                    targetTrackIndex: trackIdx,
                    valid: true
                )
                needsDisplay = true
                return
            }
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
        let point = convert(event.locationInWindow, from: nil)

        if var bd = bodyDrag {
            // Free 2D move: no grid snap, so the clip tracks the cursor exactly.
            // (The landing track is still resolved from the clip's vertical
            // center — a clip always belongs to some track.)
            let dxTime = Double(point.x - bd.pointerStart.x) * secondsPerPixel
            let raw = max(0, bd.originalStart + dxTime)
            let snap = snappedStart(
                for: raw,
                duration: bd.clipDuration,
                excluding: Set(timeline.linkedElementIds(of: bd.elementId))
            )
            bd.proposedStart = snap.start
            snapIndicator = snap.anchor
            let centerY = bd.originalCenterY + (point.y - bd.pointerStart.y)
            bd.proposedCenterY = centerY
            let targetIdx = trackIndex(atCenterY: centerY)
            let end = bd.proposedStart + bd.clipDuration
            if targetIdx >= timeline.tracks.count {
                bd.targetTrackIndex = timeline.tracks.count   // new track — always valid
                bd.valid = true
            } else {
                let track = timeline.tracks[targetIdx]
                let typeOK = track.kind == bd.clipType && !(track.locked ?? false)
                let overlapOK = !timeline.hasOverlap(trackIndex: targetIdx, start: bd.proposedStart, end: end, excluding: bd.elementId)
                bd.targetTrackIndex = targetIdx
                bd.valid = typeOK && overlapOK
            }
            bodyDrag = bd
            needsDisplay = true
            return
        }

        guard let dragState else { return }
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
        if let bd = bodyDrag {
            bodyDrag = nil
            snapIndicator = nil
            needsDisplay = true
            let moved = bd.targetTrackIndex != bd.originalTrackIndex || abs(bd.proposedStart - bd.originalStart) > 1e-6
            if bd.valid && moved {
                onClipMoved?(bd.elementId, bd.targetTrackIndex, bd.proposedStart)
            }
            return
        }

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
        // 2D canvas: horizontal scroll pans time, vertical scroll walks the track
        // stack. Both axes are applied independently so diagonal scrolling works
        // and neither one blocks the other.
        let dx = Double(event.scrollingDeltaX)
        let dy = event.scrollingDeltaY
        if dx != 0 {
            setViewport(start: visibleStart - dx * secondsPerPixel * 3, duration: visibleDuration)
        }
        if dy != 0 {
            trackScroll = min(max(0, trackScroll - dy * 2), maxTrackScroll)
        }
    }

    private func drawRuler() {
        let rect = NSRect(x: 0, y: bounds.height - rulerHeight, width: bounds.width, height: rulerHeight)
        ShelfStyle.toolbar.setFill()
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
                NSColor(hex: 0x94a3b8, alpha: 0.14).setStroke()
                path.stroke()
                (formatTime(t) as NSString).draw(at: NSPoint(x: x + 4, y: rect.minY + 8), withAttributes: attrs)
            }
            t += step
        }

        NSColor(hex: 0x94a3b8, alpha: 0.12).setStroke()
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
                ? NSColor(hex: 0x1b1e24)
                : NSColor(hex: 0x21252d)
            background.setFill()
            row.fill()

            for clip in track.elements where clip.id != bodyDrag?.elementId {
                drawClip(clip, in: row, trackHidden: track.hidden ?? false)
            }

            drawTrackHeader(track, row: row, displayIndex: displayIndex, count: sortedTracks.count)

            NSColor(hex: 0x94a3b8, alpha: 0.10).setStroke()
            let line = NSBezierPath()
            line.move(to: NSPoint(x: 0, y: row.minY))
            line.line(to: NSPoint(x: bounds.width, y: row.minY))
            line.stroke()
        }

        // Divider so the header column reads as separate from the tracks.
        NSColor(hex: 0x94a3b8, alpha: 0.12).setStroke()
        let divider = NSBezierPath()
        divider.move(to: NSPoint(x: leftGutter, y: 0))
        divider.line(to: NSPoint(x: leftGutter, y: bounds.height - rulerHeight))
        divider.stroke()
    }

    private enum TrackHeaderAction: CaseIterable {
        case toggleCollapsed, toggleHidden, toggleMuted, toggleLocked, moveUp, moveDown, delete
    }

    private func headerButtons(for track: TimelineTrack, compact: Bool) -> [TrackHeaderAction] {
        // A thin or collapsed lane only has room for the expand toggle.
        if compact { return [.toggleCollapsed] }
        var actions: [TrackHeaderAction] = [.toggleCollapsed, .toggleHidden]
        if track.kind == .audio { actions.append(.toggleMuted) }
        actions.append(contentsOf: [.toggleLocked, .moveUp, .moveDown, .delete])
        return actions
    }

    private func nameRect(in row: NSRect) -> NSRect {
        let twoLine = row.height >= 56
        return NSRect(x: 12, y: twoLine ? row.maxY - 24 : row.midY - 9, width: leftGutter - 46, height: 18)
    }

    private func headerIconRects(row: NSRect, track: TimelineTrack) -> [(TrackHeaderAction, NSRect)] {
        let compact = row.height < 56
        let size: CGFloat = 14
        let gap: CGFloat = 3
        let y = compact ? row.midY - size / 2 : row.maxY - 44
        var x: CGFloat = compact ? leftGutter - size - 12 : 12
        var result: [(TrackHeaderAction, NSRect)] = []
        for action in headerButtons(for: track, compact: compact) {
            result.append((action, NSRect(x: x, y: y, width: size, height: size)))
            x += size + gap
        }
        return result
    }

    private func drawTrackHeader(_ track: TimelineTrack, row: NSRect, displayIndex: Int, count: Int) {
        let dimmed = track.hidden ?? false
        let nameAttrs: [NSAttributedString.Key: Any] = [
            .font: ShelfStyle.bold(size: 11),
            .foregroundColor: dimmed ? ShelfStyle.onDarkMuted : ShelfStyle.onDark,
        ]
        if renamingTrackId != track.id {
            (track.name as NSString).draw(in: nameRect(in: row), withAttributes: nameAttrs)
        }
        for (action, rect) in headerIconRects(row: row, track: track) {
            drawHeaderIcon(action, in: rect, track: track)
        }
    }

    private func drawHeaderIcon(_ action: TrackHeaderAction, in rect: NSRect, track: TimelineTrack) {
        let (name, active) = headerIconSymbol(action, track: track)
        guard let image = symbol(name, active: active) else { return }
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    }

    private func headerIconSymbol(_ action: TrackHeaderAction, track: TimelineTrack) -> (String, Bool) {
        switch action {
        case .toggleCollapsed: return ((track.collapsed ?? false) ? "chevron.right" : "chevron.down", track.collapsed ?? false)
        case .toggleHidden: return ((track.hidden ?? false) ? "eye.slash" : "eye", track.hidden ?? false)
        case .toggleMuted:  return ((track.muted ?? false) ? "speaker.slash" : "speaker.wave.2", track.muted ?? false)
        case .toggleLocked: return ((track.locked ?? false) ? "lock" : "lock.open", track.locked ?? false)
        case .moveUp:       return ("chevron.up", false)
        case .moveDown:     return ("chevron.down", false)
        case .delete:       return ("trash", false)
        }
    }

    /// SF Symbol pre-tinted onto a transparent bitmap (so the glyph — not the
    /// whole cell — carries the color) and cached by name + state.
    private func symbol(_ name: String, active: Bool) -> NSImage? {
        let key = "\(name)#\(active)"
        if let cached = symbolCache[key] { return cached }
        guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
        let configured = base.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold)) ?? base
        let color: NSColor = active ? ShelfStyle.blueGlow : ShelfStyle.onDarkMuted
        let size = configured.size
        let tinted = NSImage(size: size)
        tinted.lockFocus()
        configured.draw(in: NSRect(origin: .zero, size: size))
        color.set()
        NSRect(origin: .zero, size: size).fill(using: .sourceAtop)
        tinted.unlockFocus()
        symbolCache[key] = tinted
        return tinted
    }

    private func drawClip(_ clip: TimelineElement, in row: NSRect, trackHidden: Bool) {
        let startX = x(forTime: clip.timelineStart)
        let endX = x(forTime: clip.end)
        let visibleMin = max(timelineRect.minX, min(startX, endX))
        let visibleMax = min(timelineRect.maxX, max(startX, endX))
        guard visibleMax > visibleMin else { return }

        let rect = NSRect(
            x: visibleMin,
            y: row.minY + clipInset,
            width: visibleMax - visibleMin,
            height: max(18, row.height - clipInset * 2)
        )

        // Head-less edges: only ends that fall inside the viewport get a rounded
        // cap; an end running off-screen is squared so it reads as "continues".
        let radius: CGFloat = 12
        let roundLeft = startX >= timelineRect.minX - 0.5
        let roundRight = endX <= timelineRect.maxX + 0.5
        let path = roundedRectPath(
            rect,
            topLeft: roundLeft ? radius : 0,
            bottomLeft: roundLeft ? radius : 0,
            topRight: roundRight ? radius : 0,
            bottomRight: roundRight ? radius : 0
        )

        let selected = clip.id == selectedElementId
        drawClipSurface(clip, in: rect, path: path, hidden: trackHidden, selected: selected, invalid: false)

        // Trim handles only on ends that are actually on-screen.
        let edgeColor = ShelfStyle.navy.withAlphaComponent(selected ? 0.7 : 0.32)
        edgeColor.setFill()
        if roundLeft {
            NSBezierPath(roundedRect: NSRect(x: rect.minX + 6, y: rect.minY + 7, width: 3, height: rect.height - 14), xRadius: 1.5, yRadius: 1.5).fill()
        }
        if roundRight {
            NSBezierPath(roundedRect: NSRect(x: rect.maxX - 9, y: rect.minY + 7, width: 3, height: rect.height - 14), xRadius: 1.5, yRadius: 1.5).fill()
        }

        drawClipLabel(clip, in: rect)
    }

    /// Glow, fill, content and type border for one clip shape. Shared by clips
    /// resting on a track and by the ghost being dragged, so the two can never
    /// drift apart — a dragged clip shows exactly the content it always shows.
    private func drawClipSurface(
        _ clip: TimelineElement,
        in rect: NSRect,
        path: NSBezierPath,
        hidden: Bool,
        selected: Bool,
        invalid: Bool
    ) {
        // Neon glow in the clip's family color — red when the drop is blocked —
        // then the light fill.
        NSGraphicsContext.saveGraphicsState()
        let glow = NSShadow()
        glow.shadowColor = (invalid ? ShelfStyle.redGlow : ShelfStyle.glow(forType: clip.type.rawValue))
            .withAlphaComponent(hidden ? 0.22 : 0.62)
        glow.shadowBlurRadius = 14
        glow.shadowOffset = .zero
        glow.set()
        (invalid ? ShelfStyle.dangerLight : fillColor(for: clip, hidden: hidden)).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()

        // Content (frames / waveform / text), clipped to the clip shape.
        NSGraphicsContext.saveGraphicsState()
        path.addClip()
        drawClipContent(clip, in: rect, hidden: hidden)
        NSGraphicsContext.restoreGraphicsState()

        (invalid ? ShelfStyle.dangerHeavy : borderColor(forType: clip.type))
            .withAlphaComponent(hidden ? 0.45 : 1)
            .setStroke()
        path.lineWidth = selected ? 3 : 1.5
        path.stroke()
    }

    private func drawClipContent(_ clip: TimelineElement, in rect: NSRect, hidden: Bool) {
        switch clip.type {
        case .video: drawFilmstrip(clip, in: rect, hidden: hidden)
        case .audio: drawWaveform(clip, in: rect, hidden: hidden)
        case .text:  drawTextContent(clip, in: rect, hidden: hidden)
        }
    }

    /// A row of source frames across the clip. Each cell's source time is mapped
    /// through the current viewport so it stays correct at any zoom / trim.
    private func drawFilmstrip(_ clip: TimelineElement, in rect: NSRect, hidden: Bool) {
        guard let mediaId = clip.mediaId, let asset = media[mediaId],
              FileManager.default.fileExists(atPath: asset.localPath) else { return }
        let speed = max(0.1, clip.speed ?? 1)
        let sourceStart = clip.sourceStart ?? 0
        let aspect = (asset.width > 0 && asset.height > 0) ? CGFloat(asset.width) / CGFloat(asset.height) : 16.0 / 9.0
        let cellWidth = max(30, rect.height * aspect)

        // The grid anchors to the clip, never the viewport: cell k owns a fixed
        // slice of the clip, so its source time is a function of the clip and the
        // scale alone. Scrolling therefore reuses the very same frames — only a
        // zoom change moves the sample times, and that resampling is lazy.
        let clipStartX = x(forTime: clip.timelineStart)
        var index = max(0, Int(floor((rect.minX - clipStartX) / cellWidth)))

        while true {
            let cellX = clipStartX + CGFloat(index) * cellWidth
            if cellX >= rect.maxX { break }
            let cell = NSRect(x: cellX, y: rect.minY, width: cellWidth, height: rect.height)
            let visible = cell.intersection(rect)
            if visible.width > 0.5 {
                let sourceTime = sourceStart
                    + Double((CGFloat(index) + 0.5) * cellWidth) * secondsPerPixel * speed
                if let image = thumbnails.image(forMedia: asset.id, path: asset.localPath, sourceTime: sourceTime) {
                    // A clip edge (or a split) can land mid-cell — draw the frame
                    // cut through rather than skipping or squeezing it.
                    NSGraphicsContext.saveGraphicsState()
                    NSBezierPath(rect: visible).addClip()
                    drawAspectFill(image, in: cell, alpha: hidden ? 0.4 : 1)
                    NSGraphicsContext.restoreGraphicsState()
                }
                if cellX >= rect.minX {
                    NSColor.black.withAlphaComponent(0.16).setFill()
                    NSRect(x: cellX, y: rect.minY, width: 1, height: rect.height).fill()
                }
            }
            index += 1
        }
    }

    private func drawAspectFill(_ image: NSImage, in rect: NSRect, alpha: CGFloat) {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return }
        let scale = max(rect.width / size.width, rect.height / size.height)
        let cropW = rect.width / scale
        let cropH = rect.height / scale
        let from = NSRect(x: (size.width - cropW) / 2, y: (size.height - cropH) / 2, width: cropW, height: cropH)
        image.draw(in: rect, from: from, operation: .sourceOver, fraction: alpha)
    }

    /// Disconnected vertical loudness bars centered on the clip's midline.
    private func drawWaveform(_ clip: TimelineElement, in rect: NSRect, hidden: Bool) {
        guard let mediaId = clip.mediaId, let asset = media[mediaId],
              FileManager.default.fileExists(atPath: asset.localPath) else { return }
        guard let envelope = waveforms.envelope(forMedia: asset.id, path: asset.localPath) else { return }
        let speed = max(0.1, clip.speed ?? 1)
        let sourceStart = clip.sourceStart ?? 0
        ShelfStyle.audioHeavy.withAlphaComponent(hidden ? 0.4 : 0.85).setFill()
        let barWidth: CGFloat = 2
        let step = barWidth + 1
        let maxHeight = rect.height - 10

        // Bars anchor to the clip as well, so they don't crawl while scrolling.
        let clipStartX = x(forTime: clip.timelineStart)
        var index = max(0, Int(floor((rect.minX - clipStartX) / step)))

        while true {
            let barX = clipStartX + CGFloat(index) * step
            if barX >= rect.maxX { break }
            if barX + barWidth > rect.minX {
                // Each bar is the mean loudness over the slice it covers, taken
                // from the cached fine-grained envelope — no re-decode on zoom.
                let start = sourceStart + Double(CGFloat(index) * step) * secondsPerPixel * speed
                let end = sourceStart + Double(CGFloat(index) * step + barWidth) * secondsPerPixel * speed
                let amp = CGFloat(waveforms.averageAmplitude(envelope, from: start, to: end, mediaDuration: asset.duration))
                let barHeight = max(2, amp * maxHeight)
                let bar = NSRect(x: barX, y: rect.midY - barHeight / 2, width: barWidth, height: barHeight)
                NSBezierPath(roundedRect: bar, xRadius: 1, yRadius: 1).fill()
            }
            index += 1
        }
    }

    private func drawTextContent(_ clip: TimelineElement, in rect: NSRect, hidden: Bool) {
        let text = (clip.text?.isEmpty == false ? clip.text! : "Text") as NSString
        // Preview the clip in its own typeface, sized down to the lane.
        let size = min(14, max(9, rect.height - 20))
        let attrs: [NSAttributedString.Key: Any] = [
            .font: TextRenderer.font(for: clip.style ?? TextStyle(), size: size),
            .foregroundColor: ShelfStyle.textHeavy.withAlphaComponent(hidden ? 0.5 : 1),
        ]
        text.draw(in: rect.insetBy(dx: 10, dy: max(2, (rect.height - size - 8) / 2)), withAttributes: attrs)
    }

    /// A small dark name chip so the clip stays identifiable over its content.
    private func drawClipLabel(_ clip: TimelineElement, in rect: NSRect) {
        guard clip.type != .text else { return }   // text clips render their own text
        let title = clip.mediaId.flatMap { media[$0]?.originalFilename } ?? clip.text ?? clip.id.shortStableId
        let label = "\(clip.type.rawValue)  \(title)" as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: ShelfStyle.bold(size: 10),
            .foregroundColor: NSColor.white,
        ]
        let textSize = label.size(withAttributes: attrs)
        let chipWidth = min(rect.width - 8, textSize.width + 14)
        guard chipWidth > 20 else { return }
        let chip = NSRect(x: rect.minX + 4, y: rect.maxY - 19, width: chipWidth, height: 15)
        NSColor.black.withAlphaComponent(0.5).setFill()
        NSBezierPath(roundedRect: chip, xRadius: 4, yRadius: 4).fill()
        label.draw(in: chip.insetBy(dx: 7, dy: 1), withAttributes: attrs)
    }

    /// Rounded rect with independent corner radii (0 = square) so a clip can be
    /// squared on whichever end runs off-screen.
    private func roundedRectPath(_ rect: NSRect, topLeft: CGFloat, bottomLeft: CGFloat, topRight: CGFloat, bottomRight: CGFloat) -> NSBezierPath {
        let path = NSBezierPath()
        let minX = rect.minX, maxX = rect.maxX, minY = rect.minY, maxY = rect.maxY
        path.move(to: NSPoint(x: minX + topLeft, y: maxY))
        path.line(to: NSPoint(x: maxX - topRight, y: maxY))
        if topRight > 0 { path.appendArc(from: NSPoint(x: maxX, y: maxY), to: NSPoint(x: maxX, y: maxY - topRight), radius: topRight) }
        path.line(to: NSPoint(x: maxX, y: minY + bottomRight))
        if bottomRight > 0 { path.appendArc(from: NSPoint(x: maxX, y: minY), to: NSPoint(x: maxX - bottomRight, y: minY), radius: bottomRight) }
        path.line(to: NSPoint(x: minX + bottomLeft, y: minY))
        if bottomLeft > 0 { path.appendArc(from: NSPoint(x: minX, y: minY), to: NSPoint(x: minX, y: minY + bottomLeft), radius: bottomLeft) }
        path.line(to: NSPoint(x: minX, y: maxY - topLeft))
        if topLeft > 0 { path.appendArc(from: NSPoint(x: minX, y: maxY), to: NSPoint(x: minX + topLeft, y: maxY), radius: topLeft) }
        path.close()
        return path
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
        // Backing pill so the readout stays legible now that a track fills the
        // bottom edge behind it.
        let origin = NSPoint(x: leftGutter + 6, y: 7)
        let size = text.size(withAttributes: attrs)
        let pill = NSRect(x: origin.x - 6, y: origin.y - 3, width: size.width + 12, height: size.height + 6)
        NSColor.black.withAlphaComponent(0.5).setFill()
        NSBezierPath(roundedRect: pill, xRadius: 5, yRadius: 5).fill()
        text.draw(at: origin, withAttributes: attrs)
    }

    private func fillColor(for clip: TimelineElement, hidden: Bool) -> NSColor {
        fillColor(forType: clip.type).withAlphaComponent(hidden ? 0.35 : 0.92)
    }

    private func fillColor(forType type: TrackKind) -> NSColor {
        switch type {
        case .video: return ShelfStyle.videoLight
        case .audio: return ShelfStyle.audioLight
        case .text: return ShelfStyle.textLight
        }
    }

    /// Every clip carries an outline in its own type's color — video white,
    /// audio cyan, text pink. Selection keeps the color and just thickens it.
    private func borderColor(forType type: TrackKind) -> NSColor {
        switch type {
        case .video: return .white
        case .audio: return ShelfStyle.cyanGlow
        case .text: return ShelfStyle.pinkGlow
        }
    }

    /// The clip being body-dragged, rendered at its proposed 2D landing spot.
    /// Red when the spot is unavailable (overlap or wrong-type track).
    private func drawBodyDragGhost() {
        guard let bd = bodyDrag, let original = timeline.element(withId: bd.elementId) else { return }
        // Free 2D float: the ghost sits wherever the cursor has taken it, on both
        // axes. Which track it lands on is decided separately, from the center
        // line — it is never snapped into a row while the drag is in flight.
        let ghostHeight = max(18, height(forKind: bd.clipType) - clipInset * 2)
        let startX = x(forTime: bd.proposedStart)
        let endX = x(forTime: bd.proposedStart + bd.clipDuration)
        let rect = NSRect(
            x: startX,
            y: bd.proposedCenterY - ghostHeight / 2,
            width: max(6, endX - startX),
            height: ghostHeight
        )
        let path = NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12)

        // Re-home the clip onto the ghost's position so its content anchors to
        // where it's being dragged rather than where it came from. Everything
        // else — frames, waveform, text, border — comes from the shared renderer.
        var ghost = original
        let shift = bd.proposedStart - original.timelineStart
        ghost.timelineStart = bd.proposedStart
        if let end = original.timelineEnd { ghost.timelineEnd = end + shift }

        drawClipSurface(ghost, in: rect, path: path, hidden: false, selected: true, invalid: !bd.valid)

        if bd.valid {
            drawClipLabel(ghost, in: rect)
        } else {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: ShelfStyle.bold(size: 11),
                .foregroundColor: ShelfStyle.dangerHeavy,
            ]
            ("unavailable" as NSString).draw(at: NSPoint(x: rect.minX + 10, y: rect.midY - 7), withAttributes: attrs)
        }
    }

    private func drawPanelBase() {
        let path = NSBezierPath(roundedRect: bounds, xRadius: 12, yRadius: 12)
        ShelfStyle.timelineSurface.setFill()
        path.fill()
        ShelfStyle.navy.withAlphaComponent(0.80).setFill()
        NSBezierPath(
            roundedRect: NSRect(x: 0, y: 0, width: 4, height: bounds.height),
            xRadius: 2,
            yRadius: 2
        ).fill()
    }

    private func rowRect(displayIndex: Int) -> NSRect {
        let tracks = orderedTracks
        var offset: CGFloat = 0
        for index in 0..<min(displayIndex, tracks.count) { offset += height(for: tracks[index]) }
        let rowH = displayIndex < tracks.count ? height(for: tracks[displayIndex]) : height(forKind: .video)
        let y = bounds.height - rulerHeight - offset - rowH + trackScroll
        return NSRect(x: 0, y: y, width: bounds.width, height: rowH)
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
                    height: max(18, rowRect(displayIndex: displayIndex).height - clipInset * 2)
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

    // MARK: - Track header interaction

    private func headerHit(at point: NSPoint) -> (String, TrackHeaderAction)? {
        let sortedTracks = timeline.tracks.sorted { $0.order < $1.order }
        for (displayIndex, track) in sortedTracks.enumerated() {
            let row = rowRect(displayIndex: displayIndex)
            guard row.contains(point) else { continue }
            for (action, rect) in headerIconRects(row: row, track: track) where rect.insetBy(dx: -3, dy: -3).contains(point) {
                return (track.id, action)
            }
            return nil
        }
        return nil
    }

    private func performHeaderAction(_ action: TrackHeaderAction, trackId: String) {
        switch action {
        case .toggleCollapsed: onTrackToggleCollapsed?(trackId)
        case .toggleHidden: onTrackToggleHidden?(trackId)
        case .toggleMuted:  onTrackToggleMuted?(trackId)
        case .toggleLocked: onTrackToggleLocked?(trackId)
        case .moveUp:       onTrackReorder?(trackId, -1)
        case .moveDown:     onTrackReorder?(trackId, 1)
        case .delete:       onTrackDelete?(trackId)
        }
    }

    private func trackId(atNameArea point: NSPoint) -> String? {
        let sortedTracks = timeline.tracks.sorted { $0.order < $1.order }
        for (displayIndex, track) in sortedTracks.enumerated() where nameRect(in: rowRect(displayIndex: displayIndex)).contains(point) {
            return track.id
        }
        return nil
    }

    private func beginRename(trackId: String, at point: NSPoint) {
        let sortedTracks = timeline.tracks.sorted { $0.order < $1.order }
        guard let displayIndex = sortedTracks.firstIndex(where: { $0.id == trackId }) else { return }
        let track = sortedTracks[displayIndex]
        let field = NSTextField(frame: nameRect(in: rowRect(displayIndex: displayIndex)))
        field.stringValue = track.name
        field.font = ShelfStyle.bold(size: 11)
        field.isBordered = true
        field.bezelStyle = .roundedBezel
        field.focusRingType = .none
        field.delegate = self
        field.target = self
        field.action = #selector(renameCommitted)
        addSubview(field)
        window?.makeFirstResponder(field)
        renameEditor = field
        renamingTrackId = trackId
        needsDisplay = true
    }

    @objc private func renameCommitted() {
        commitRename()
    }

    private func commitRename() {
        guard let field = renameEditor, let trackId = renamingTrackId else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        renameEditor = nil
        renamingTrackId = nil
        field.removeFromSuperview()
        needsDisplay = true
        if !name.isEmpty { onTrackRename?(trackId, name) }
    }
}

extension TimelineView: NSTextFieldDelegate {
    func controlTextDidEndEditing(_ obj: Notification) {
        commitRename()
    }
}
