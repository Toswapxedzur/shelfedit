import AppKit
import CoreImage

/// Turns a text clip into an image in canvas space, honouring its typography.
///
/// Any installed font can be named; an unknown name falls back to the system
/// font rather than failing, so a project authored elsewhere still renders.
enum TextRenderer {
    /// Every font family installed on this machine, for the style picker.
    static var availableFamilies: [String] {
        NSFontManager.shared.availableFontFamilies.sorted()
    }

    /// Resolves a style to a concrete font at `size`, applying bold/italic as
    /// traits so families that ship separate faces still work.
    static func font(for style: TextStyle, size: CGFloat) -> NSFont {
        let named = style.fontName.flatMap { $0.isEmpty ? nil : NSFont(name: $0, size: size) }
            ?? style.fontName.flatMap { NSFontManager.shared.font(withFamily: $0, traits: [], weight: 5, size: size) }
        let base = named ?? NSFont.systemFont(ofSize: size, weight: style.bold ? .bold : .regular)

        var traits: NSFontTraitMask = []
        if style.bold { traits.insert(.boldFontMask) }
        if style.italic { traits.insert(.italicFontMask) }
        guard !traits.isEmpty else { return base }
        return NSFontManager.shared.convert(base, toHaveTrait: traits)
    }

    static func color(for style: TextStyle) -> NSColor {
        NSColor(hexString: style.colorHex) ?? .white
    }

    private static func paragraphStyle(for style: TextStyle) -> NSParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        switch style.alignment {
        case "left": paragraph.alignment = .left
        case "right": paragraph.alignment = .right
        default: paragraph.alignment = .center
        }
        paragraph.lineBreakMode = .byWordWrapping
        return paragraph
    }

    /// Renders the text into a transparent, canvas-sized image. `transform`
    /// scales the type and offsets it from center in -1…1 canvas units, matching
    /// how the rest of the app treats element transforms.
    static func image(
        text: String,
        style: TextStyle,
        transform: Transform?,
        canvas: CGSize
    ) -> CIImage? {
        guard !text.isEmpty, canvas.width > 1, canvas.height > 1 else { return nil }

        let scale = CGFloat(max(0.01, transform?.scale ?? 1))
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font(for: style, size: CGFloat(max(1, style.fontSize)) * scale),
            .foregroundColor: color(for: style),
            .paragraphStyle: paragraphStyle(for: style),
        ]
        let string = NSAttributedString(string: text, attributes: attributes)

        // Wrap inside a 90% safe area, then center the measured block and shift
        // it by the transform's offset.
        let boxWidth = canvas.width * 0.9
        let measured = string.boundingRect(
            with: NSSize(width: boxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        let dx = CGFloat(transform?.x ?? 0) * canvas.width / 2
        let dy = CGFloat(transform?.y ?? 0) * canvas.height / 2
        let box = NSRect(
            x: (canvas.width - boxWidth) / 2 + dx,
            y: (canvas.height - measured.height) / 2 + dy,
            width: boxWidth,
            height: measured.height
        )

        let image = NSImage(size: canvas)
        image.lockFocus()
        NSColor.clear.set()
        NSRect(origin: .zero, size: canvas).fill(using: .copy)
        string.draw(with: box, options: [.usesLineFragmentOrigin, .usesFontLeading])
        image.unlockFocus()

        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let cgImage = bitmap.cgImage else { return nil }
        return CIImage(cgImage: cgImage)
    }
}

extension NSColor {
    /// Parses "#rrggbb" / "rrggbb" (and the 8-digit alpha form).
    convenience init?(hexString: String) {
        var hex = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6 || hex.count == 8, let value = UInt32(hex, radix: 16) else { return nil }
        let hasAlpha = hex.count == 8
        let r = CGFloat((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let g = CGFloat((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let b = CGFloat((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let a = hasAlpha ? CGFloat(value & 0xff) / 255 : 1
        self.init(calibratedRed: r, green: g, blue: b, alpha: a)
    }
}
