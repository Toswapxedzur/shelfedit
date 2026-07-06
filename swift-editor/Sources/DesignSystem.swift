import AppKit

enum ShelfStyle {
    static let fontName = "Arial"
    static let heading = NSColor(hex: 0xf8fafc)
    static let text = NSColor(hex: 0xe5e7eb)
    static let body = NSColor(hex: 0xcbd5e1)
    static let muted = NSColor(hex: 0x94a3b8)
    static let navy = NSColor(hex: 0x3b82f6)
    static let navy2 = NSColor(hex: 0x60a5fa)
    static let slateButton = NSColor(hex: 0x1e293b)
    static let panel = NSColor(hex: 0x0f172a, alpha: 0.88)
    static let panelStrong = NSColor(hex: 0x111827, alpha: 0.96)
    static let indigoSoft = NSColor(hex: 0x1e1b4b)
    static let cyanSoft = NSColor(hex: 0x083344)
    static let amberSoft = NSColor(hex: 0x451a03)
    static let pinkSoft = NSColor(hex: 0x4a044e)
    static let buttonText = NSColor(hex: 0x111827)
    static let whiteButton = NSColor.white.withAlphaComponent(0.96)

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
        let gradient = NSGradient(colors: [NSColor(hex: 0x020617), NSColor(hex: 0x0f172a), NSColor(hex: 0x1e1b4b)])
        gradient?.draw(in: bounds, angle: -90)
        drawDotGrid()
    }

    private func drawDotGrid() {
        NSColor(hex: 0x94a3b8, alpha: 0.18).setFill()
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
    var cornerRadius: CGFloat = 16
    var fillColor: NSColor = ShelfStyle.panel

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = cornerRadius
        layer?.masksToBounds = false
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.28
        layer?.shadowRadius = 22
        layer?.shadowOffset = CGSize(width: 0, height: -10)
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
        layer?.backgroundColor = NSColor(hex: 0x020617, alpha: 0.86).cgColor
        layer?.borderColor = NSColor(hex: 0x94a3b8, alpha: 0.18).cgColor
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
        contentTintColor = ShelfStyle.buttonText
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
            layer?.backgroundColor = ShelfStyle.whiteButton.withAlphaComponent(disabledAlpha).cgColor
            layer?.borderColor = ShelfStyle.navy.withAlphaComponent(disabledAlpha).cgColor
            layer?.borderWidth = 1.5
            contentTintColor = ShelfStyle.navy.withAlphaComponent(disabledAlpha)
        case .secondary:
            layer?.backgroundColor = ShelfStyle.whiteButton.withAlphaComponent(disabledAlpha).cgColor
            layer?.borderColor = NSColor(hex: 0xcbd5e1, alpha: disabledAlpha).cgColor
            layer?.borderWidth = 1
            contentTintColor = ShelfStyle.buttonText.withAlphaComponent(disabledAlpha)
        case .pill:
            layer?.backgroundColor = ShelfStyle.whiteButton.withAlphaComponent(disabledAlpha).cgColor
            layer?.borderColor = ShelfStyle.navy2.withAlphaComponent(disabledAlpha).cgColor
            layer?.borderWidth = 1.5
            layer?.shadowColor = NSColor.black.cgColor
            layer?.shadowOpacity = isEnabled ? 0.18 : 0
            layer?.shadowRadius = 2
            layer?.shadowOffset = CGSize(width: 0, height: -1)
            contentTintColor = ShelfStyle.navy2.withAlphaComponent(disabledAlpha)
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
        contentTintColor = ShelfStyle.buttonText
        wantsLayer = true
        layer?.backgroundColor = ShelfStyle.whiteButton.cgColor
        layer?.borderColor = NSColor(hex: 0xcbd5e1, alpha: 0.9).cgColor
        layer?.borderWidth = 1
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
        layer?.backgroundColor = NSColor(hex: 0x0f172a, alpha: 0.72).cgColor
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
