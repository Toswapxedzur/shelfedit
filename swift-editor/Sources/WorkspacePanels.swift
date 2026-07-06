import AppKit

@MainActor
final class ToolShelfView: GlassPanelView {
    private let content = NSStackView()
    private let projectMedia = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        fillColor = .white
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(media: [MediaAsset]) {
        projectMedia.arrangedSubviews.forEach { view in
            projectMedia.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for item in media.sorted(by: { $0.originalFilename < $1.originalFilename }).prefix(8) {
            projectMedia.addArrangedSubview(assetRow(item))
        }
    }

    private func build() {
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 9
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)

        content.addArrangedSubview(panelTitle("Tools"))
        content.addArrangedSubview(toolGrid([
            ("Asset", "Pool"),
            ("Text", "Add"),
            ("Voice", "Recognize"),
            ("Transition", "Video"),
            ("Effects", "Video"),
            ("Templates", "Local"),
        ]))
        content.addArrangedSubview(section("Asset", accent: ShelfStyle.navy2, rows: [
            "Asset pool",
            "Import from local",
            "Import from URL",
            "Import from other project",
            "Use final video without render",
        ]))
        content.addArrangedSubview(section("Text", accent: ShelfStyle.textHeavy, rows: [
            "Add text",
            "Caption track",
            "Style preset",
        ]))
        content.addArrangedSubview(section("Voice Recognition", accent: ShelfStyle.audioHeavy, rows: [
            "Audio selection -> text",
            "Target caption track",
            "Transcript language",
        ]))
        content.addArrangedSubview(panelTitle("Project Assets"))
        projectMedia.orientation = .vertical
        projectMedia.alignment = .leading
        projectMedia.spacing = 8
        content.addArrangedSubview(projectMedia)

        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            content.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            content.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -14),
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
        button.accentColor = ShelfStyle.navy2
        button.translatesAutoresizingMaskIntoConstraints = false
        button.layer?.backgroundColor = ShelfStyle.whiteButton.cgColor

        let titleLabel = label(title, size: 12, weight: .bold, color: ShelfStyle.buttonText)
        let subLabel = label(subtitle, size: 10, weight: .regular, color: NSColor(hex: 0x475569))
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

    private func section(_ title: String, accent: NSColor, rows: [String]) -> NSView {
        let panel = AccentPanelView()
        panel.accentColor = accent
        panel.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 7
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(label(title, size: 13, weight: .bold, color: ShelfStyle.heading))
        for row in rows {
            stack.addArrangedSubview(label(row, size: 11, weight: .regular, color: ShelfStyle.body))
        }
        panel.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -12),
            panel.widthAnchor.constraint(greaterThanOrEqualToConstant: 280),
        ])
        return panel
    }

    private func assetRow(_ asset: MediaAsset) -> NSView {
        let row = AccentPanelView()
        row.accentColor = NSColor(hex: 0x14b8a6)
        row.translatesAutoresizingMaskIntoConstraints = false
        let name = label(asset.originalFilename, size: 11, weight: .bold, color: ShelfStyle.heading)
        let meta = label("\(asset.type)  \(formatTime(asset.duration))", size: 10, weight: .regular, color: ShelfStyle.muted)
        let stack = NSStackView(views: [name, meta])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 3
        stack.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: row.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -8),
            row.widthAnchor.constraint(greaterThanOrEqualToConstant: 280),
        ])
        return row
    }

    private func panelTitle(_ text: String) -> NSTextField {
        label(text, size: 15, weight: .bold, color: ShelfStyle.heading)
    }
}

@MainActor
final class InspectorPanelView: GlassPanelView {
    private let stack = NSStackView()
    private let elementStack = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        fillColor = .white
        build()
        update(selection: nil, media: [:])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(selection: TimelineElement?, media: [String: MediaAsset]) {
        elementStack.arrangedSubviews.forEach { view in
            elementStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        guard let selection else {
            elementStack.addArrangedSubview(label("No selected element", size: 12, weight: .regular, color: ShelfStyle.muted))
            for name in ["Speed", "Amplification", "Size", "Stretch", "Crop", "Border", "Pitch"] {
                elementStack.addArrangedSubview(propertyRow(name, value: "--"))
            }
            return
        }

        let source = selection.mediaId.flatMap { media[$0]?.originalFilename } ?? "Generated / text"
        elementStack.addArrangedSubview(propertyRow("Element", value: selection.id.shortStableId))
        elementStack.addArrangedSubview(propertyRow("Type", value: selection.type.rawValue))
        elementStack.addArrangedSubview(propertyRow("Source", value: source))
        elementStack.addArrangedSubview(propertyRow("Timeline", value: "\(formatTime(selection.timelineStart)) - \(formatTime(selection.end))"))
        elementStack.addArrangedSubview(propertyRow("Speed", value: String(format: "%.2fx", selection.speed ?? 1)))
        elementStack.addArrangedSubview(propertyRow("Amplification", value: String(format: "%.0f%%", (selection.volume ?? 1) * 100)))
        elementStack.addArrangedSubview(propertyRow("Size", value: String(format: "%.0f%%", (selection.transform?.scale ?? 1) * 100)))
        elementStack.addArrangedSubview(propertyRow("Stretch", value: "100%"))
        elementStack.addArrangedSubview(propertyRow("Crop", value: selection.crop == nil ? "None" : "Enabled"))
        elementStack.addArrangedSubview(propertyRow("Border", value: "0 px"))
        elementStack.addArrangedSubview(propertyRow("Pitch", value: "0 st"))
    }

    private func build() {
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        stack.addArrangedSubview(label("Inspector", size: 15, weight: .bold, color: ShelfStyle.heading))
        stack.addArrangedSubview(inspectorSection())
        stack.addArrangedSubview(aiSection())

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -14),
        ])
    }

    private func inspectorSection() -> NSView {
        let panel = AccentPanelView()
        panel.accentColor = ShelfStyle.navy2
        panel.translatesAutoresizingMaskIntoConstraints = false
        let title = label("Current Element Data", size: 13, weight: .bold, color: ShelfStyle.heading)
        let tabs = capsuleRow(["Basic", "Transform", "Audio", "Mask", "Color"])

        elementStack.orientation = .vertical
        elementStack.alignment = .leading
        elementStack.spacing = 8

        let content = NSStackView(views: [title, tabs, elementStack])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 10
        content.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(content)

        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -12),
            content.topAnchor.constraint(equalTo: panel.topAnchor, constant: 12),
            content.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -12),
            panel.widthAnchor.constraint(greaterThanOrEqualToConstant: 310),
        ])
        return panel
    }

    private func aiSection() -> NSView {
        let panel = AccentPanelView()
        panel.accentColor = ShelfStyle.exportHeavy
        panel.translatesAutoresizingMaskIntoConstraints = false
        let title = label("AI Assist", size: 13, weight: .bold, color: ShelfStyle.heading)
        let prompt = whiteChip("Ask for cuts, captions, fixes...")
        let chips = capsuleRow(["Selected", "Visible range", "Transcript"])
        let proposals = NSStackView(views: [
            proposal("Silence cleanup", "Propose ripple deletes from transcript gaps"),
            proposal("Caption pass", "Add text to designated track from audio"),
            proposal("Jump cut", "Split and tighten selected clip"),
        ])
        proposals.orientation = .vertical
        proposals.alignment = .leading
        proposals.spacing = 8

        let content = NSStackView(views: [title, prompt, chips, proposals])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 10
        content.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(content)

        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -12),
            content.topAnchor.constraint(equalTo: panel.topAnchor, constant: 12),
            content.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -12),
            panel.widthAnchor.constraint(greaterThanOrEqualToConstant: 310),
        ])
        return panel
    }

    private func propertyRow(_ name: String, value: String) -> NSView {
        let left = label(name, size: 11, weight: .bold, color: ShelfStyle.body)
        let right = whiteChip(value)
        let row = NSStackView(views: [left, right])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.distribution = .fill
        right.setContentHuggingPriority(.required, for: .horizontal)
        return row
    }

    private func capsuleRow(_ values: [String]) -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 6
        for value in values {
            row.addArrangedSubview(whiteChip(value))
        }
        return row
    }

    private func whiteChip(_ text: String) -> NSTextField {
        let chip = label(text, size: 10, weight: .bold, color: ShelfStyle.buttonText)
        chip.wantsLayer = true
        chip.layer?.backgroundColor = ShelfStyle.whiteButton.cgColor
        chip.layer?.cornerRadius = 9
        chip.alignment = .center
        return chip
    }

    private func proposal(_ title: String, _ body: String) -> NSView {
        let panel = AccentPanelView()
        panel.accentColor = ShelfStyle.exportHeavy
        panel.layer?.backgroundColor = ShelfStyle.aiLight.cgColor
        let titleLabel = label(title, size: 11, weight: .bold, color: ShelfStyle.heading)
        let bodyLabel = label(body, size: 10, weight: .regular, color: ShelfStyle.muted)
        let stack = NSStackView(views: [titleLabel, bodyLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -8),
            panel.widthAnchor.constraint(greaterThanOrEqualToConstant: 280),
        ])
        return panel
    }
}
