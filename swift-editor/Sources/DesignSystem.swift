import AppKit

enum ShelfStyle {
    static let fontName = "Arial"
    static let radiusControl: CGFloat = 10
    static let radiusCard: CGFloat = 14
    static let radiusPanel: CGFloat = 16
    static let radiusPill: CGFloat = 999
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 16
    static let controlHeight: CGFloat = 32
    static let mainControlHeight: CGFloat = 36
    static let toolbarHeight: CGFloat = 52
    static let chipHeight: CGFloat = 24
    static let heading = NSColor(hex: 0x111827)
    static let text = NSColor(hex: 0x1f2937)
    static let body = NSColor(hex: 0x475569)
    static let muted = NSColor(hex: 0x94a3b8)
    static let canvas = NSColor(hex: 0x202020)
    static let secondaryCanvas = NSColor(hex: 0x2b2b2b)
    static let childPanel = NSColor(hex: 0xf8fafc)
    static let panel = NSColor.white
    static let panelStrong = NSColor.white
    static let darkMedia = NSColor(hex: 0x111827)

    static let assetLight = NSColor(hex: 0xe0f2fe)
    static let assetHeavy = NSColor(hex: 0x0284c7)
    static let videoLight = NSColor(hex: 0xdbeafe)
    static let videoHeavy = NSColor(hex: 0x1d4ed8)
    static let audioLight = NSColor(hex: 0xfce7f3)
    static let audioHeavy = NSColor(hex: 0xbe185d)
    static let textLight = NSColor(hex: 0xecfeff)
    static let textHeavy = NSColor(hex: 0x0891b2)
    static let exportLight = NSColor(hex: 0xfef3c7)
    static let exportHeavy = NSColor(hex: 0xb45309)
    static let aiLight = NSColor.white
    static let aiFallbackLight = exportLight
    static let aiFallbackHeavy = exportHeavy
    static let genericLight = NSColor(hex: 0xf1f5f9)
    static let genericHeavy = NSColor(hex: 0x64748b)
    static let dangerLight = NSColor(hex: 0xfee2e2)
    static let dangerHeavy = NSColor(hex: 0xb91c1c)

    static let navy = videoHeavy
    static let navy2 = assetHeavy
    static let slateButton = genericLight
    static let indigoSoft = videoLight
    static let cyanSoft = assetLight
    static let amberSoft = exportLight
    static let pinkSoft = audioLight
    static let buttonText = NSColor(hex: 0x111827)
    static let whiteButton = NSColor.white.withAlphaComponent(0.96)

    static func font(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont(name: fontName, size: size) ?? .systemFont(ofSize: size, weight: weight)
    }

    static func bold(size: CGFloat) -> NSFont {
        font(size: size, weight: .bold)
    }

    static func applyCardShadow(to layer: CALayer?) {
        layer?.shadowColor = NSColor(hex: 0x0f172a).cgColor
        layer?.shadowOpacity = 0.08
        layer?.shadowRadius = 12
        layer?.shadowOffset = CGSize(width: 0, height: -6)
    }

    static func applyFloatingShadow(to layer: CALayer?) {
        layer?.shadowColor = NSColor(hex: 0x0f172a).cgColor
        layer?.shadowOpacity = 0.22
        layer?.shadowRadius = 22
        layer?.shadowOffset = CGSize(width: 0, height: -10)
    }

    static func applyTinyShadow(to layer: CALayer?) {
        layer?.shadowColor = NSColor(hex: 0x0f172a).cgColor
        layer?.shadowOpacity = 0.06
        layer?.shadowRadius = 6
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
        NSColor(hex: 0x94a3b8, alpha: 0.10).setFill()
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
    var fillColor: NSColor = ShelfStyle.panel

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

final class FrostedTopBarView: NSVisualEffectView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        material = .popover
        blendingMode = .withinWindow
        state = .active
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.withAlphaComponent(0.88).cgColor
        ShelfStyle.applyCardShadow(to: layer)
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
        font = ShelfStyle.bold(size: 12)
        contentTintColor = ShelfStyle.buttonText
        wantsLayer = true
        setButtonType(.momentaryPushIn)
        translatesAutoresizingMaskIntoConstraints = false
        let height = variant == .primary ? ShelfStyle.mainControlHeight : (variant == .pill ? 30 : ShelfStyle.controlHeight)
        heightAnchor.constraint(equalToConstant: height).isActive = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func updateLayer() {
        super.updateLayer()
        let disabledAlpha: CGFloat = isEnabled ? 1 : 0.45
        layer?.cornerRadius = variant == .pill ? 15 : ShelfStyle.radiusControl
        layer?.masksToBounds = false
        switch variant {
        case .primary:
            layer?.backgroundColor = ShelfStyle.whiteButton.withAlphaComponent(disabledAlpha).cgColor
            contentTintColor = ShelfStyle.navy.withAlphaComponent(disabledAlpha)
            layer?.shadowColor = ShelfStyle.navy.cgColor
            layer?.shadowOpacity = 0.16
            layer?.shadowRadius = 10
            layer?.shadowOffset = CGSize(width: 0, height: -4)
        case .secondary:
            layer?.backgroundColor = ShelfStyle.whiteButton.withAlphaComponent(disabledAlpha).cgColor
            contentTintColor = ShelfStyle.buttonText.withAlphaComponent(disabledAlpha)
            ShelfStyle.applyTinyShadow(to: layer)
        case .pill:
            layer?.backgroundColor = ShelfStyle.whiteButton.withAlphaComponent(disabledAlpha).cgColor
            layer?.shadowColor = ShelfStyle.navy2.cgColor
            layer?.shadowOpacity = isEnabled ? 0.12 : 0
            layer?.shadowRadius = 8
            layer?.shadowOffset = CGSize(width: 0, height: -3)
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
        font = ShelfStyle.bold(size: 12)
        contentTintColor = ShelfStyle.buttonText
        wantsLayer = true
        layer?.backgroundColor = ShelfStyle.whiteButton.cgColor
        layer?.cornerRadius = ShelfStyle.radiusControl
        ShelfStyle.applyTinyShadow(to: layer)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: ShelfStyle.controlHeight).isActive = true
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
        layer?.cornerRadius = ShelfStyle.radiusCard
        layer?.backgroundColor = ShelfStyle.childPanel.cgColor
        ShelfStyle.applyCardShadow(to: layer)
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
