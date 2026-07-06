import AppKit

@MainActor
final class HomeView: NSView {
    var onOpenProject: ((String) -> Void)?

    private let stack = NSStackView()
    private let projectList = NSStackView()
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
        projectList.arrangedSubviews.forEach { view in
            projectList.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        emptyLabel.isHidden = !projects.isEmpty
        for project in projects {
            let card = ProjectCardView(project: project)
            card.onOpen = { [weak self] id in self?.onOpenProject?(id) }
            projectList.addArrangedSubview(card)
        }
    }

    private func build() {
        let hero = GlassPanelView()
        hero.translatesAutoresizingMaskIntoConstraints = false
        hero.fillColor = ShelfStyle.panelStrong

        let eyebrow = pillLabel("NATIVE EDITOR", background: ShelfStyle.indigoSoft, foreground: ShelfStyle.navy2)
        let title = label("ShelfEdit", size: 40, weight: .heavy, color: ShelfStyle.heading)
        let subtitle = label(
            "Open a project, scrub heavy media through Apple’s native video path, and keep your existing ShelfEdit timeline data intact.",
            size: 14,
            weight: .regular,
            color: ShelfStyle.body
        )
        subtitle.maximumNumberOfLines = 2

        let heroText = NSStackView(views: [eyebrow, title, subtitle])
        heroText.orientation = .vertical
        heroText.alignment = .leading
        heroText.spacing = 10
        heroText.translatesAutoresizingMaskIntoConstraints = false
        hero.addSubview(heroText)

        let stats = NSStackView(views: [
            statBlock("AVFoundation", "Playback"),
            statBlock("Metal", "Preview"),
            statBlock("SQLite", "Projects"),
        ])
        stats.orientation = .horizontal
        stats.spacing = 12
        stats.distribution = .fillEqually
        stats.translatesAutoresizingMaskIntoConstraints = false
        hero.addSubview(stats)

        NSLayoutConstraint.activate([
            heroText.leadingAnchor.constraint(equalTo: hero.leadingAnchor, constant: 22),
            heroText.topAnchor.constraint(equalTo: hero.topAnchor, constant: 22),
            heroText.trailingAnchor.constraint(equalTo: hero.trailingAnchor, constant: -22),

            stats.leadingAnchor.constraint(equalTo: hero.leadingAnchor, constant: 22),
            stats.trailingAnchor.constraint(equalTo: hero.trailingAnchor, constant: -22),
            stats.topAnchor.constraint(equalTo: heroText.bottomAnchor, constant: 24),
            stats.bottomAnchor.constraint(equalTo: hero.bottomAnchor, constant: -22),
            hero.heightAnchor.constraint(greaterThanOrEqualToConstant: 220),
        ])

        let recentTitle = label("Recent Projects", size: 18, weight: .bold, color: ShelfStyle.heading)
        let recentHelp = label("Choose a project to enter the editor workspace.", size: 12, weight: .regular, color: ShelfStyle.muted)
        let recentHeader = NSStackView(views: [recentTitle, recentHelp])
        recentHeader.orientation = .vertical
        recentHeader.alignment = .leading
        recentHeader.spacing = 4

        projectList.orientation = .vertical
        projectList.alignment = .leading
        projectList.spacing = 12

        emptyLabel.font = ShelfStyle.font(size: 13)
        emptyLabel.textColor = ShelfStyle.muted

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(hero)
        stack.addArrangedSubview(recentHeader)
        stack.addArrangedSubview(emptyLabel)
        stack.addArrangedSubview(projectList)
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 28),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -28),
            hero.leadingAnchor.constraint(equalTo: stack.leadingAnchor),
            hero.trailingAnchor.constraint(equalTo: stack.trailingAnchor),
            projectList.leadingAnchor.constraint(equalTo: stack.leadingAnchor),
            projectList.trailingAnchor.constraint(equalTo: stack.trailingAnchor),
        ])
    }

    private func statBlock(_ value: String, _ title: String) -> NSView {
        let panel = AccentPanelView()
        panel.accentColor = ShelfStyle.navy2
        panel.translatesAutoresizingMaskIntoConstraints = false

        let valueLabel = label(value, size: 16, weight: .bold, color: ShelfStyle.heading)
        let titleLabel = label(title, size: 11, weight: .regular, color: ShelfStyle.muted)
        let content = NSStackView(views: [valueLabel, titleLabel])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 4
        content.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(content)

        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 16),
            content.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -12),
            content.topAnchor.constraint(equalTo: panel.topAnchor, constant: 12),
            content.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -12),
            panel.heightAnchor.constraint(equalToConstant: 62),
        ])
        return panel
    }
}

@MainActor
private final class ProjectCardView: NSView {
    var onOpen: ((String) -> Void)?
    private let project: ProjectSummary

    init(project: ProjectSummary) {
        self.project = project
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.backgroundColor = ShelfStyle.panel.cgColor
        layer?.borderColor = NSColor(hex: 0x334155, alpha: 0.65).cgColor
        layer?.borderWidth = 1
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func build() {
        let name = label(project.name, size: 16, weight: .bold, color: ShelfStyle.heading)
        let meta = label("\(project.mediaCount) media assets  •  updated \(project.updatedAt)", size: 12, weight: .regular, color: ShelfStyle.muted)
        let textStack = NSStackView(views: [name, meta])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 5

        let open = StyledButton(title: "Open", variant: .primary, target: self, action: #selector(openProject))
        let row = NSStackView(views: [textStack, open])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 18
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 620),
        ])
    }

    @objc private func openProject() {
        onOpen?(project.id)
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
    let field = label(text, size: 10, weight: .bold, color: foreground)
    field.wantsLayer = true
    field.layer?.backgroundColor = background.withAlphaComponent(0.9).cgColor
    field.layer?.cornerRadius = 9
    field.alignment = .center
    field.setContentHuggingPriority(.required, for: .horizontal)
    return field
}
