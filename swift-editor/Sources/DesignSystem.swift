import AppKit

enum ShelfStyle {
    static let radiusControl: CGFloat = 10
    static let radiusCard: CGFloat = 14
    static let radiusPanel: CGFloat = 16
    static let radiusPill: CGFloat = 999
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 16
    static let controlHeight: CGFloat = 32
    static let mainControlHeight: CGFloat = 36
    static let chipHeight: CGFloat = 24

    // ---- Dark shell (matches the web editor) ----
    static let canvas = NSColor(hex: 0x15171b)
    static let secondaryCanvas = NSColor(hex: 0x1c2027)
    static let panel = NSColor(hex: 0x20232a)        // big floating panels (now dark)
    static let panel2 = NSColor(hex: 0x252932)       // dark input fields / dropdowns
    static let panelStrong = NSColor(hex: 0x20232a)
    static let toolbar = NSColor(hex: 0x1c1f26)      // tool strips / ruler
    static let timelineSurface = NSColor(hex: 0x16181d)
    static let darkMedia = NSColor.black

    // ---- Text on dark panels ----
    static let onDark = NSColor(hex: 0xeceff5)
    static let onDarkMuted = NSColor(hex: 0x9299aa)

    // ---- Text on light cards / clips ----
    static let heading = NSColor(hex: 0x1f2937)
    static let text = NSColor(hex: 0x1f2937)
    static let body = NSColor(hex: 0x475569)
    static let muted = NSColor(hex: 0x94a3b8)
    static let buttonText = NSColor(hex: 0x1f2937)

    static let childPanel = NSColor(hex: 0xf6f8fe)   // neutral light card base

    // ---- Palette (light + heavy) — AdamanciaVault finalized; blue app-derived.
    //      video=blue, audio=cyan, text=pink, export=gold, danger=red. ----
    static let videoLight = NSColor(hex: 0xe9eefc)
    static let videoHeavy = NSColor(hex: 0x1e3a8a)
    static let audioLight = NSColor(hex: 0xcffafe)
    static let audioHeavy = NSColor(hex: 0x0e7490)
    static let textLight = NSColor(hex: 0xfce7f3)
    static let textHeavy = NSColor(hex: 0xbe185d)
    static let exportLight = NSColor(hex: 0xfef3c7)
    static let exportHeavy = NSColor(hex: 0xca8a04)
    static let assetLight = NSColor(hex: 0xe9eefc)   // assets read blue like the web
    static let assetHeavy = NSColor(hex: 0x1e3a8a)
    static let dangerLight = NSColor(hex: 0xfee2e2)
    static let dangerHeavy = NSColor(hex: 0xb91c1c)
    static let genericLight = NSColor(hex: 0xeef1f6)
    static let genericHeavy = NSColor(hex: 0x64748b)

    // ---- Neon glow accents (shadow color only) ----
    static let blueGlow = NSColor(hex: 0x2563eb)
    static let cyanGlow = NSColor(hex: 0x06b6d4)
    static let pinkGlow = NSColor(hex: 0xec4899)
    static let goldGlow = NSColor(hex: 0xf0b429)
    static let redGlow = NSColor(hex: 0xef4444)

    static let navy = videoHeavy
    static let navy2 = assetHeavy
    static let slateButton = genericLight
    static let indigoSoft = videoLight
    static let cyanSoft = audioLight
    static let amberSoft = exportLight
    static let pinkSoft = textLight
    static let aiLight = NSColor.white
    static let aiFallbackLight = exportLight
    static let aiFallbackHeavy = exportHeavy

    /// Matches the web spec's `-apple-system, BlinkMacSystemFont, "Segoe UI"…`
    /// stack — i.e. the platform system font (San Francisco on macOS), not Arial.
    static func font(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        .systemFont(ofSize: size, weight: weight)
    }

    static func bold(size: CGFloat) -> NSFont {
        font(size: size, weight: .bold)
    }

    /// Colored neon glow for light buttons / cards / clips floating on the dark UI.
    static func applyNeonGlow(to layer: CALayer?, color: NSColor, opacity: Float = 0.5, radius: CGFloat = 14) {
        layer?.shadowColor = color.cgColor
        layer?.shadowOpacity = opacity
        layer?.shadowRadius = radius
        layer?.shadowOffset = .zero
    }

    /// Neon glow tone for a track element type.
    static func glow(forType raw: String) -> NSColor {
        switch raw {
        case "video": return blueGlow
        case "audio": return cyanGlow
        case "text": return pinkGlow
        default: return blueGlow
        }
    }

    /// Soft near-black shadow for the big dark floating panels.
    static func applyFloatingShadow(to layer: CALayer?) {
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.45
        layer?.shadowRadius = 20
        layer?.shadowOffset = CGSize(width: 0, height: -8)
    }

    static func applyCardShadow(to layer: CALayer?) {
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.32
        layer?.shadowRadius = 12
        layer?.shadowOffset = CGSize(width: 0, height: -5)
    }

    static func applyTinyShadow(to layer: CALayer?) {
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.30
        layer?.shadowRadius = 7
        layer?.shadowOffset = CGSize(width: 0, height: -2)
    }
}

extension NSColor {
    convenience init(hex: Int, alpha: CGFloat = 1) {
        self.init(
            calibratedRed: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: alpha
        )
    }
}

final class AppBackgroundView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let gradient = NSGradient(colors: [ShelfStyle.canvas, ShelfStyle.secondaryCanvas])
        gradient?.draw(in: bounds, angle: -90)
        drawDotGrid()
    }

    private func drawDotGrid() {
        NSColor(hex: 0xffffff, alpha: 0.05).setFill()
        let spacing: CGFloat = 22
        var y: CGFloat = 10
        while y < bounds.height {
            var x: CGFloat = 12
            while x < bounds.width {
                NSBezierPath(ovalIn: NSRect(x: x, y: y, width: 1.4, height: 1.4)).fill()
                x += spacing
            }
            y += spacing
        }
    }
}

class GlassPanelView: NSView {
    var cornerRadius: CGFloat = ShelfStyle.radiusPanel
    var fillColor: NSColor = ShelfStyle.panel {
        didSet { needsDisplay = true }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = cornerRadius
        layer?.masksToBounds = false
        ShelfStyle.applyFloatingShadow(to: layer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        layer?.cornerRadius = cornerRadius
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        fillColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: cornerRadius, yRadius: cornerRadius).fill()
    }
}

/// The 5-color palette from docs/adamancia-style.md — light/mid/dark tiers,
/// each with a fill, an ink (text) color, and a neon glow accent.
enum AdamanciaColor {
    case red, gold, pink, cyan, blue
}

enum AdamanciaTier {
    case light, mid, dark
}

extension ShelfStyle {
    /// Exact port of `.a-btn.<color>.<tier>` from docs/adamancia-style-example.html.
    static func palette(_ color: AdamanciaColor, _ tier: AdamanciaTier) -> (fill: NSColor, ink: NSColor, glow: NSColor) {
        switch color {
        case .red:
            switch tier {
            case .light: return (NSColor(hex: 0xfee2e2), NSColor(hex: 0x991b1b), redGlow)
            case .mid:   return (NSColor(hex: 0xfecaca), NSColor(hex: 0x991b1b), redGlow)
            case .dark:  return (NSColor(hex: 0xb91c1c), .white, redGlow)
            }
        case .gold:
            switch tier {
            case .light: return (NSColor(hex: 0xfef3c7), NSColor(hex: 0xa16207), goldGlow)
            case .mid:   return (NSColor(hex: 0xfde68a), NSColor(hex: 0xa16207), goldGlow)
            case .dark:  return (NSColor(hex: 0xca8a04), .white, goldGlow)
            }
        case .pink:
            switch tier {
            case .light: return (NSColor(hex: 0xfce7f3), NSColor(hex: 0x9d174d), pinkGlow)
            case .mid:   return (NSColor(hex: 0xfbcfe8), NSColor(hex: 0x9d174d), pinkGlow)
            case .dark:  return (NSColor(hex: 0xbe185d), .white, pinkGlow)
            }
        case .cyan:
            switch tier {
            case .light: return (NSColor(hex: 0xcffafe), NSColor(hex: 0x155e75), cyanGlow)
            case .mid:   return (NSColor(hex: 0xa5f3fc), NSColor(hex: 0x155e75), cyanGlow)
            case .dark:  return (NSColor(hex: 0x0e7490), .white, cyanGlow)
            }
        case .blue:
            switch tier {
            case .light: return (NSColor(hex: 0xe9eefc), NSColor(hex: 0x1e3a8a), blueGlow)
            case .mid:   return (NSColor(hex: 0xc7d2fe), NSColor(hex: 0x1e3a8a), blueGlow)
            case .dark:  return (NSColor(hex: 0x1e3a8a), .white, blueGlow)
            }
        }
    }
}

/// Direct migration of `.a-btn` from docs/adamancia-style-example.html:
/// light palette fill + ink, neon glow shadow, lift + brighten on hover,
/// settle on press. System font, 700 weight, 13pt — matches the CSS spec
/// (`font-weight:700; font-size:13px`), not the app's old Arial.
final class AdamanciaButton: NSButton {
    private var color: AdamanciaColor
    private var tier: AdamanciaTier
    private var trackingArea: NSTrackingArea?
    private var isHovering = false {
        didSet { refreshStyle() }
    }
    private var isPressed = false {
        didSet { refreshStyle() }
    }

    init(title: String, color: AdamanciaColor = .blue, tier: AdamanciaTier = .light, target: AnyObject?, action: Selector?) {
        self.color = color
        self.tier = tier
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        isBordered = false
        bezelStyle = .regularSquare
        font = ShelfStyle.bold(size: 13)
        wantsLayer = true
        setButtonType(.momentaryPushIn)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: ShelfStyle.controlHeight).isActive = true
        refreshStyle()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setPalette(color: AdamanciaColor, tier: AdamanciaTier) {
        self.color = color
        self.tier = tier
        refreshStyle()
    }

    override var isEnabled: Bool {
        didSet { refreshStyle() }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHovering = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovering = false
        isPressed = false
    }

    override func mouseDown(with event: NSEvent) {
        isPressed = true
        super.mouseDown(with: event)
        isPressed = false
    }

    private func refreshStyle() {
        layer?.cornerRadius = ShelfStyle.radiusControl
        layer?.masksToBounds = false
        let p = ShelfStyle.palette(color, tier)
        let alpha: CGFloat = isEnabled ? 1 : 0.5

        // `.a-btn:hover { filter: brightness(1.03) }`
        let fill = isHovering && isEnabled ? p.fill.blended(withFraction: 0.06, of: .white) ?? p.fill : p.fill
        layer?.backgroundColor = fill.withAlphaComponent(alpha).cgColor
        contentTintColor = p.ink.withAlphaComponent(alpha)

        guard isEnabled else {
            ShelfStyle.applyNeonGlow(to: layer, color: p.glow, opacity: 0, radius: 8)
            return
        }
        if isPressed {
            ShelfStyle.applyNeonGlow(to: layer, color: p.glow, opacity: 0.55, radius: 8)
        } else if isHovering {
            ShelfStyle.applyNeonGlow(to: layer, color: p.glow, opacity: 0.7, radius: 14)
        } else {
            ShelfStyle.applyNeonGlow(to: layer, color: p.glow, opacity: 0.55, radius: 10)
        }
    }
}

/// Dropdowns / selects stay DARK inputs (docs/adamancia-style.md §5/§6 —
/// `.project-select`, `.tbar-select`), not part of the light button palette.
final class AdamanciaPopupButton: NSPopUpButton {
    init() {
        super.init(frame: .zero, pullsDown: false)
        isBordered = false
        font = ShelfStyle.font(size: 12, weight: .semibold)
        contentTintColor = ShelfStyle.onDark
        wantsLayer = true
        layer?.backgroundColor = ShelfStyle.panel2.cgColor
        layer?.cornerRadius = ShelfStyle.radiusControl
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.white.withAlphaComponent(0.08).cgColor
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: ShelfStyle.controlHeight).isActive = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// Thin draggable seam between the first-level (biggest) panels — the gap
/// itself doubles as the resize handle, matching the web editor's
/// `.layout-resizer` (a hairline that brightens on hover/drag).
final class ResizerView: NSView {
    enum Axis {
        case horizontal   // vertical seam; drag left/right
        case vertical     // horizontal seam; drag up/down
    }

    let axis: Axis
    /// The pointer's current location in window coordinates during a drag. The
    /// caller maps it straight to an ABSOLUTE panel size, so the seam tracks the
    /// mouse position itself — nothing accumulates, so no dead zone is possible.
    var onDrag: ((NSPoint) -> Void)?
    /// Pointer location (window coordinates) at mouse-down, so the caller can
    /// capture a grab offset and keep the seam under the pointer without a jump.
    var onDragBegan: ((NSPoint) -> Void)?
    var onDragEnded: (() -> Void)?

    private let lineLayer = CALayer()
    private var trackingArea: NSTrackingArea?
    private var isHovering = false {
        didSet { updateLineColor() }
    }
    private var isDragging = false {
        didSet { updateLineColor() }
    }

    static let thickness: CGFloat = 8

    init(axis: Axis) {
        self.axis = axis
        super.init(frame: .zero)
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        layer?.addSublayer(lineLayer)
        updateLineColor()
        if axis == .horizontal {
            widthAnchor.constraint(equalToConstant: Self.thickness).isActive = true
        } else {
            heightAnchor.constraint(equalToConstant: Self.thickness).isActive = true
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        if axis == .horizontal {
            lineLayer.frame = NSRect(x: bounds.width / 2 - 0.5, y: 6, width: 1, height: max(0, bounds.height - 12))
        } else {
            lineLayer.frame = NSRect(x: 6, y: bounds.height / 2 - 0.5, width: max(0, bounds.width - 12), height: 1)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: axis == .horizontal ? .resizeLeftRight : .resizeUpDown)
    }

    override func mouseEntered(with event: NSEvent) {
        isHovering = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovering = false
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        isDragging = true
        onDragBegan?(event.locationInWindow)
        // Drive the whole drag from one modal event-tracking loop. The seam
        // slides out from under the pointer as it resizes the panels, and with
        // separate mouseDragged/mouseUp callbacks AppKit stops delivering to a
        // view once the cursor leaves it — dropping drag events (the seam lags
        // the cursor) and the final mouseUp (isDragging never clears, so it
        // stays lit blue). trackEvents captures every event on the window until
        // the button is released, no matter where the pointer is.
        window.trackEvents(
            matching: [.leftMouseDragged, .leftMouseUp],
            timeout: NSEvent.foreverDuration,
            mode: .eventTracking
        ) { [weak self] event, stop in
            guard let self, let event else { return }
            switch event.type {
            case .leftMouseUp:
                self.isDragging = false
                self.onDragEnded?()
                self.refreshHover()
                stop.pointee = true
            default: // .leftMouseDragged — report the absolute pointer position
                self.onDrag?(event.locationInWindow)
            }
        }
    }

    /// After a drag the seam has usually slid off the pointer, and no
    /// mouseExited fires during the modal loop — so recompute hover explicitly
    /// or the seam stays lit.
    private func refreshHover() {
        guard let window else { isHovering = false; return }
        let local = convert(window.mouseLocationOutsideOfEventStream, from: nil)
        isHovering = bounds.contains(local)
    }

    private func updateLineColor() {
        let color: NSColor = isDragging || isHovering ? ShelfStyle.blueGlow : NSColor.white.withAlphaComponent(0.12)
        lineLayer.backgroundColor = color.cgColor
        if isDragging || isHovering {
            ShelfStyle.applyNeonGlow(to: layer, color: ShelfStyle.blueGlow, opacity: 0.5, radius: 6)
        } else {
            layer?.shadowOpacity = 0
        }
    }
}

/// Top-down document view for scroll containers (AppKit scrolls up-from-bottom
/// by default; flipping makes content start and scroll from the top).
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// Wraps a tall panel body in a transparent, vertically-scrolling container so
/// its content scrolls instead of forcing the whole window taller. The content
/// is pinned inside with `inset` padding and its width tracks the visible area,
/// so there's no horizontal scrolling.
@MainActor
func verticalScrollContainer(_ content: NSView, inset: CGFloat = 14) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = false
    scroll.autohidesScrollers = true
    scroll.scrollerStyle = .overlay
    let doc = FlippedView()
    doc.translatesAutoresizingMaskIntoConstraints = false
    scroll.documentView = doc
    content.translatesAutoresizingMaskIntoConstraints = false
    doc.addSubview(content)
    NSLayoutConstraint.activate([
        // Match the clip view's width so content wraps to the panel instead of
        // scrolling sideways; the document's height grows with the content.
        doc.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        content.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: inset),
        content.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -inset),
        content.topAnchor.constraint(equalTo: doc.topAnchor, constant: inset),
        content.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -inset),
    ])
    return scroll
}

/// Light colored card with a colored left stripe and a neon glow in its accent color.
final class AccentPanelView: NSView {
    var accentColor = ShelfStyle.navy {
        didSet {
            ShelfStyle.applyNeonGlow(to: layer, color: accentColor, opacity: 0.4, radius: 12)
            needsDisplay = true
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = ShelfStyle.radiusCard
        layer?.backgroundColor = ShelfStyle.childPanel.cgColor
        ShelfStyle.applyNeonGlow(to: layer, color: accentColor, opacity: 0.4, radius: 12)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        accentColor.setFill()
        let stripe = NSRect(x: 0, y: 0, width: 4, height: bounds.height)
        NSBezierPath(
            roundedRect: stripe,
            xRadius: 2,
            yRadius: 2
        ).fill()
    }
}
