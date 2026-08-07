import AppKit

enum ToolShelfAction {
    case importLocal
    case importURL
    case importProjectRender
    case addText
    case recognizeSelectedAudio
}

enum InspectorProperty {
    case speed
    case amplification
    case size
}

@MainActor
final class ToolShelfView: GlassPanelView {
    var onAction: ((ToolShelfAction) -> Void)?

    private let content = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        fillColor = ShelfStyle.panel
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The project-asset listing was stripped while we focus on the timeline
    /// track. Kept as a no-op so the caller's wiring stays intact — re-fill when
    /// the panel's content is rebuilt.
    func update(media: [MediaAsset]) {}

    private func build() {
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 9
        content.translatesAutoresizingMaskIntoConstraints = false

        content.addArrangedSubview(panelTitle("Tools"))
        content.addArrangedSubview(toolGrid([
            ("Asset", "Pool"),
            ("Text", "Add"),
            ("Voice", "Recognize"),
            ("Transition", "Video"),
            ("Effects", "Video"),
            ("Templates", "Local"),
        ]))

        // Scroll so a future, taller tool list never forces the window taller.
        let scroll = verticalScrollContainer(content)
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private func toolGrid(_ tools: [(String, String)]) -> NSView {
        let grid = NSGridView()
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.rowSpacing = 8
        grid.columnSpacing = 8
        for pair in stride(from: 0, to: tools.count, by: 2) {
            let left = toolButton(tools[pair].0, tools[pair].1)
            let right = pair + 1 < tools.count ? toolButton(tools[pair + 1].0, tools[pair + 1].1) : NSView()
            grid.addRow(with: [left, right])
        }
        return grid
    }

    private func toolButton(_ title: String, _ subtitle: String) -> NSView {
        let button = AccentPanelView()
        let colors = toolColors(for: title)
        button.accentColor = colors.heavy
        button.translatesAutoresizingMaskIntoConstraints = false
        button.layer?.backgroundColor = colors.light.cgColor

        let titleLabel = label(title, size: 13, weight: .bold, color: ShelfStyle.buttonText)
        let subLabel = label(subtitle, size: 11, weight: .regular, color: NSColor(hex: 0x475569))
        let stack = NSStackView(views: [titleLabel, subLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: button.leadingAnchor, constant: 13),
            stack.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: button.topAnchor, constant: 9),
            stack.bottomAnchor.constraint(equalTo: button.bottomAnchor, constant: -9),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 130),
            button.heightAnchor.constraint(equalToConstant: 54),
        ])
        return button
    }

    private func toolColors(for title: String) -> (light: NSColor, heavy: NSColor) {
        switch title {
        case "Asset":
            return (ShelfStyle.assetLight, ShelfStyle.assetHeavy)
        case "Text":
            return (ShelfStyle.textLight, ShelfStyle.textHeavy)
        case "Voice":
            return (ShelfStyle.audioLight, ShelfStyle.audioHeavy)
        case "Transition", "Effects":
            return (ShelfStyle.videoLight, ShelfStyle.videoHeavy)
        default:
            return (ShelfStyle.genericLight, ShelfStyle.genericHeavy)
        }
    }

    private func panelTitle(_ text: String) -> NSTextField {
        label(text, size: 16, weight: .bold, color: ShelfStyle.onDark)
    }
}

@MainActor
final class InspectorPanelView: GlassPanelView {
    var onPropertyEdit: ((InspectorProperty, Double) -> Void)?

    private let stack = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        fillColor = ShelfStyle.panel
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The element-data + AI panels were stripped while we focus on the timeline
    /// track. Kept as a no-op so the caller's wiring stays intact — re-fill when
    /// the inspector's content is rebuilt.
    func update(selection: TimelineElement?, media: [String: MediaAsset]) {}

    private func build() {
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9
        stack.translatesAutoresizingMaskIntoConstraints = false

        stack.addArrangedSubview(label("Inspector", size: 16, weight: .bold, color: ShelfStyle.onDark))
        stack.addArrangedSubview(label("Select a clip on the timeline", size: 12, weight: .regular, color: ShelfStyle.onDarkMuted))

        // Scroll so future inspector content never forces the window taller.
        let scroll = verticalScrollContainer(stack)
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
}
