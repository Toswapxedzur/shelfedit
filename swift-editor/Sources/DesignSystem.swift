import AppKit

enum ShelfStyle {
    static let fontName = "Arial"
    static let heading = NSColor(hex: 0x0f172a)
    static let text = NSColor(hex: 0x1f2937)
    static let body = NSColor(hex: 0x475569)
    static let muted = NSColor(hex: 0x94a3b8)
    static let navy = NSColor(hex: 0x1e3a8a)
    static let navy2 = NSColor(hex: 0x1c5ca8)
    static let slateButton = NSColor(hex: 0xe2e8f0)
    static let panel = NSColor.white.withAlphaComponent(0.92)
    static let indigoSoft = NSColor(hex: 0xeef2ff)
    static let cyanSoft = NSColor(hex: 0xecfeff)
    static let amberSoft = NSColor(hex: 0xfffbeb)
    static let pinkSoft = NSColor(hex: 0xfdf2f8)

    static func font(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont(name: fontName, size: size) ?? .systemFont(ofSize: size, weight: weight)
    }

    static func bold(size: CGFloat) -> NSFont {
        font(size: size, weight: .bold)
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
        let gradient = NSGradient(colors: [NSColor(hex: 0xf8fafc), ShelfStyle.indigoSoft])
        gradient?.draw(in: bounds, angle: -90)
        drawDotGrid()
    }

    private func drawDotGrid() {
        NSColor(hex: 0x94a3b8, alpha: 0.35).setFill()
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

final class GlassPanelView: NSView {
    var cornerRadius: CGFloat = 16
    var fillColor: NSColor = ShelfStyle.panel

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = cornerRadius
        layer?.masksToBounds = false
        layer?.shadowColor = NSColor(hex: 0x0f172a).cgColor
        layer?.shadowOpacity = 0.08
        layer?.shadowRadius = 17
        layer?.shadowOffset = CGSize(width: 0, height: -6)
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

final class FrostedTopBarView: NSVisualEffectView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        material = .popover
        blendingMode = .withinWindow
        state = .active
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.withAlphaComponent(0.88).cgColor
        layer?.borderColor = NSColor(hex: 0x94a3b8, alpha: 0.25).cgColor
        layer?.borderWidth = 1
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

final class StyledButton: NSButton {
    enum Variant {
        case primary
        case secondary
        case pill
    }

    private let variant: Variant

    init(title: String, variant: Variant = .secondary, target: AnyObject?, action: Selector?) {
        self.variant = variant
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        isBordered = false
        bezelStyle = .regularSquare
        font = ShelfStyle.bold(size: 10)
        contentTintColor = variant == .secondary ? ShelfStyle.heading : .white
        wantsLayer = true
        setButtonType(.momentaryPushIn)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 28).isActive = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func updateLayer() {
        super.updateLayer()
        let disabledAlpha: CGFloat = isEnabled ? 1 : 0.45
        layer?.cornerRadius = variant == .pill ? 14 : 10
        layer?.masksToBounds = false
        switch variant {
        case .primary:
            layer?.backgroundColor = ShelfStyle.navy.withAlphaComponent(disabledAlpha).cgColor
            contentTintColor = .white
        case .secondary:
            layer?.backgroundColor = ShelfStyle.slateButton.withAlphaComponent(disabledAlpha).cgColor
            contentTintColor = ShelfStyle.heading.withAlphaComponent(disabledAlpha)
        case .pill:
            layer?.backgroundColor = ShelfStyle.navy2.withAlphaComponent(disabledAlpha).cgColor
            layer?.shadowColor = NSColor(hex: 0x03101f).cgColor
            layer?.shadowOpacity = isEnabled ? 0.18 : 0
            layer?.shadowRadius = 2
            layer?.shadowOffset = CGSize(width: 0, height: -1)
            contentTintColor = .white
        }
    }

    override var isEnabled: Bool {
        didSet { needsDisplay = true }
    }
}

final class StyledPopupButton: NSPopUpButton {
    init() {
        super.init(frame: .zero, pullsDown: false)
        isBordered = false
        font = ShelfStyle.bold(size: 10)
        contentTintColor = ShelfStyle.heading
        wantsLayer = true
        layer?.backgroundColor = ShelfStyle.slateButton.cgColor
        layer?.cornerRadius = 10
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 28).isActive = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

final class AccentPanelView: NSView {
    var accentColor = ShelfStyle.navy

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.backgroundColor = NSColor.white.withAlphaComponent(0.62).cgColor
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
