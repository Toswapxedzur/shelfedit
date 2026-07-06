import AppKit

@MainActor
final class HomeView: NSView {
    var onOpenProject: ((String) -> Void)?

    private let leftRail = NSStackView()
    private var rightPanel: HomeRightPanel!
    private let emptyLabel = NSTextField(labelWithString: "No projects found in the ShelfEdit database.")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(projects: [ProjectSummary]) {
        let nextGrid = makeProjectGrid(projects)
        nextGrid.translatesAutoresizingMaskIntoConstraints = false
        emptyLabel.isHidden = !projects.isEmpty
        rightPanel.replaceGrid(with: nextGrid)
    }

    private func build() {
        let container = NSStackView()
        container.orientation = .horizontal
        container.alignment = .top
        container.spacing = 16
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)

        let left = GlassPanelView()
        left.fillColor = NSColor.white
        left.translatesAutoresizingMaskIntoConstraints = false
        buildLeftRail(into: left)

        rightPanel = HomeRightPanel()
        rightPanel.translatesAutoresizingMaskIntoConstraints = false
        rightPanel.replaceGrid(with: makeProjectGrid([]))

        container.addArrangedSubview(left)
        container.addArrangedSubview(rightPanel)

        NSLayoutConstraint.activate([
            container.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            container.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            container.topAnchor.constraint(equalTo: topAnchor, constant: 18),
            container.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -18),
            left.widthAnchor.constraint(equalToConstant: 276),
            rightPanel.widthAnchor.constraint(greaterThanOrEqualToConstant: 720),
        ])
    }

    private func buildLeftRail(into panel: NSView) {
        leftRail.orientation = .vertical
        leftRail.alignment = .leading
        leftRail.spacing = 12
        leftRail.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(leftRail)

        leftRail.addArrangedSubview(accountCard())
        leftRail.addArrangedSubview(navButton("Home", color: ShelfStyle.videoHeavy, fill: ShelfStyle.videoLight))
        leftRail.addArrangedSubview(navButton("Projects", color: ShelfStyle.assetHeavy, fill: ShelfStyle.assetLight))
        leftRail.addArrangedSubview(navButton("Settings", color: ShelfStyle.genericHeavy, fill: ShelfStyle.genericLight))
        leftRail.addArrangedSubview(navButton("Exports", color: ShelfStyle.exportHeavy, fill: ShelfStyle.exportLight))
        leftRail.addArrangedSubview(navButton("Danger Zone", color: ShelfStyle.dangerHeavy, fill: ShelfStyle.dangerLight))
        leftRail.addArrangedSubview(NSView())
        leftRail.addArrangedSubview(infoCard())

        NSLayoutConstraint.activate([
            leftRail.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 14),
            leftRail.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -14),
            leftRail.topAnchor.constraint(equalTo: panel.topAnchor, constant: 14),
            leftRail.bottomAnchor.constraint(lessThanOrEqualTo: panel.bottomAnchor, constant: -14),
        ])
    }

    private func accountCard() -> NSView {
        let panel = GlassPanelView()
        panel.fillColor = ShelfStyle.videoLight
        panel.translatesAutoresizingMaskIntoConstraints = false

        let title = label("ShelfEdit", size: 18, weight: .heavy, color: ShelfStyle.heading)
        let subtitle = label("Native video workspace", size: 12, weight: .regular, color: ShelfStyle.body)
        let button = StyledButton(title: "Open Settings", variant: .primary, target: nil, action: nil)
        let stack = NSStackView(views: [title, subtitle, button])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -16),
            panel.widthAnchor.constraint(greaterThanOrEqualToConstant: 240),
        ])
        return panel
    }

    private func navButton(_ title: String, color: NSColor, fill: NSColor) -> NSView {
        let panel = GlassPanelView()
        panel.fillColor = fill
        panel.cornerRadius = 14
        panel.translatesAutoresizingMaskIntoConstraints = false
        let strip = NSView()
        strip.wantsLayer = true
        strip.layer?.backgroundColor = color.cgColor
        strip.layer?.cornerRadius = 4
        strip.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(strip)

        let titleLabel = label(title, size: 14, weight: .bold, color: ShelfStyle.heading)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(titleLabel)

        NSLayoutConstraint.activate([
            panel.heightAnchor.constraint(equalToConstant: 48),
            panel.widthAnchor.constraint(greaterThanOrEqualToConstant: 240),
            strip.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 12),
            strip.centerYAnchor.constraint(equalTo: panel.centerYAnchor),
            strip.widthAnchor.constraint(equalToConstant: 6),
            strip.heightAnchor.constraint(equalToConstant: 24),
            titleLabel.leadingAnchor.constraint(equalTo: strip.trailingAnchor, constant: 12),
            titleLabel.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -12),
            titleLabel.centerYAnchor.constraint(equalTo: panel.centerYAnchor),
        ])
        return panel
    }

    private func infoCard() -> NSView {
        let panel = GlassPanelView()
        panel.fillColor = ShelfStyle.assetLight
        panel.translatesAutoresizingMaskIntoConstraints = false
        let title = label("Playback pipeline", size: 13, weight: .bold, color: ShelfStyle.heading)
        let body = label("AVFoundation -> CoreVideo -> Metal", size: 11, weight: .regular, color: ShelfStyle.body)
        let stack = NSStackView(views: [title, body])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -14),
            panel.widthAnchor.constraint(greaterThanOrEqualToConstant: 240),
        ])
        return panel
    }

    private func makeProjectGrid(_ projects: [ProjectSummary]) -> NSGridView {
        let grid = NSGridView()
        grid.rowSpacing = 14
        grid.columnSpacing = 14
        let cards: [NSView] = projects.map { ProjectTileView(project: $0) as NSView } + [CreateProjectTileView()]
        for card in cards {
            if let projectTile = card as? ProjectTileView {
                projectTile.onOpen = { [weak self] id in self?.onOpenProject?(id) }
            }
        }
        for index in stride(from: 0, to: cards.count, by: 3) {
            let row = (0..<3).map { offset -> NSView in
                let cardIndex = index + offset
                return cardIndex < cards.count ? cards[cardIndex] : NSView()
            }
            grid.addRow(with: row)
        }
        return grid
    }
}

@MainActor
private final class HomeRightPanel: GlassPanelView {
    private let content = NSStackView()
    private var gridContainer = NSView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        fillColor = .white
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func replaceGrid(with grid: NSGridView) {
        gridContainer.subviews.forEach { $0.removeFromSuperview() }
        grid.translatesAutoresizingMaskIntoConstraints = false
        gridContainer.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            grid.topAnchor.constraint(equalTo: gridContainer.topAnchor),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: gridContainer.trailingAnchor),
            grid.bottomAnchor.constraint(lessThanOrEqualTo: gridContainer.bottomAnchor),
        ])
    }

    private func build() {
        let title = label("Projects", size: 28, weight: .heavy, color: ShelfStyle.heading)
        let help = label("Open an existing video workspace or create a new one.", size: 13, weight: .regular, color: ShelfStyle.body)
        let header = NSStackView(views: [title, help])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 5

        let filters = NSStackView(views: [
            chip("Recent", color: ShelfStyle.videoHeavy),
            chip("Native ready", color: ShelfStyle.assetHeavy),
            chip("Exports", color: ShelfStyle.exportHeavy),
        ])
        filters.orientation = .horizontal
        filters.spacing = 8

        gridContainer.translatesAutoresizingMaskIntoConstraints = false
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 14
        content.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(header)
        content.addArrangedSubview(filters)
        content.addArrangedSubview(gridContainer)
        addSubview(content)

        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            content.topAnchor.constraint(equalTo: topAnchor, constant: 18),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -18),
            gridContainer.widthAnchor.constraint(greaterThanOrEqualToConstant: 700),
            gridContainer.heightAnchor.constraint(greaterThanOrEqualToConstant: 460),
        ])
    }

    private func chip(_ text: String, color: NSColor) -> NSTextField {
        let field = label(text, size: 11, weight: .bold, color: color)
        field.wantsLayer = true
        field.layer?.backgroundColor = ShelfStyle.genericLight.cgColor
        field.layer?.cornerRadius = ShelfStyle.chipHeight / 2
        field.alignment = .center
        field.translatesAutoresizingMaskIntoConstraints = false
        field.heightAnchor.constraint(equalToConstant: ShelfStyle.chipHeight).isActive = true
        field.widthAnchor.constraint(greaterThanOrEqualToConstant: 76).isActive = true
        return field
    }
}

@MainActor
private final class ProjectTileView: GlassPanelView {
    var onOpen: ((String) -> Void)?
    private let project: ProjectSummary

    init(project: ProjectSummary) {
        self.project = project
        super.init(frame: .zero)
        fillColor = ShelfStyle.childPanel
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func build() {
        let thumbnail = ThumbnailView(path: project.thumbnailPath, title: project.name)
        thumbnail.translatesAutoresizingMaskIntoConstraints = false
        let title = label(project.name, size: 14, weight: .bold, color: ShelfStyle.heading)
        let meta = label("\(project.mediaCount) assets | \(formatTime(project.duration))", size: 11, weight: .regular, color: ShelfStyle.body)
        let open = StyledButton(title: "Open", variant: .primary, target: self, action: #selector(openProject))
        let stack = NSStackView(views: [thumbnail, title, meta, open])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            thumbnail.widthAnchor.constraint(equalToConstant: 186),
            thumbnail.heightAnchor.constraint(equalToConstant: 108),
            widthAnchor.constraint(equalToConstant: 210),
        ])
    }

    @objc private func openProject() {
        onOpen?(project.id)
    }
}

@MainActor
private final class CreateProjectTileView: GlassPanelView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        fillColor = ShelfStyle.videoLight
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func build() {
        let plus = label("+", size: 44, weight: .heavy, color: ShelfStyle.videoHeavy)
        plus.alignment = .center
        let title = label("Create Project", size: 14, weight: .bold, color: ShelfStyle.heading)
        let meta = label("Add media and start editing", size: 11, weight: .regular, color: ShelfStyle.body)
        let stack = NSStackView(views: [plus, title, meta])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthAnchor.constraint(equalToConstant: 210),
            heightAnchor.constraint(equalToConstant: 202),
        ])
    }
}

@MainActor
private final class ThumbnailView: NSView {
    private let image: NSImage?
    private let title: String

    init(path: String?, title: String) {
        self.title = title
        if let path, FileManager.default.fileExists(atPath: path) {
            image = NSImage(contentsOfFile: path)
        } else {
            image = nil
        }
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 14
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if let image {
            image.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
        } else {
            let gradient = NSGradient(colors: [ShelfStyle.videoLight, ShelfStyle.assetLight])
            gradient?.draw(in: bounds, angle: -35)
            let text = String(title.prefix(2)).uppercased() as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: ShelfStyle.bold(size: 28),
                .foregroundColor: ShelfStyle.videoHeavy,
            ]
            let size = text.size(withAttributes: attrs)
            text.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2), withAttributes: attrs)
        }
    }
}

@MainActor
func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = ShelfStyle.font(size: size, weight: weight)
    field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    return field
}

@MainActor
func pillLabel(_ text: String, background: NSColor, foreground: NSColor) -> NSTextField {
    let field = label(text, size: 11, weight: .bold, color: foreground)
    field.wantsLayer = true
    field.layer?.backgroundColor = background.withAlphaComponent(0.9).cgColor
    field.layer?.cornerRadius = ShelfStyle.chipHeight / 2
    field.alignment = .center
    field.translatesAutoresizingMaskIntoConstraints = false
    field.heightAnchor.constraint(equalToConstant: ShelfStyle.chipHeight).isActive = true
    field.setContentHuggingPriority(.required, for: .horizontal)
    return field
}
