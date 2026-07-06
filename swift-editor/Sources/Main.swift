import AppKit
import AVFoundation
import CoreMedia
import Darwin
import QuartzCore

@MainActor
final class AppController: NSObject, NSApplicationDelegate {
    private let database = ShelfDatabase()

    private var window: NSWindow!
    private var player = AVPlayer()
    private var homeView: HomeView!
    private var playerSurface: MetalVideoSurface!
    private var timelineView: TimelineView!
    private var editorPanels: [NSView] = []
    private var projectPopup: NSPopUpButton!
    private var playButton: NSButton!
    private var speedPopup: NSPopUpButton!
    private var undoButton: NSButton!
    private var redoButton: NSButton!
    private var timeLabel: NSTextField!
    private var statusLabel: NSTextField!

    private var projects: [ProjectSummary] = []
    private var loadedProject: LoadedProject?
    private var selectedElementId: String?
    private var duration: Double = 0
    private var previewRate: Float = 1
    private var timeObserver: Any?

    private var undoStack: [TimelineData] = []
    private var redoStack: [TimelineData] = []
    private var interactiveBaseTimeline: TimelineData?

    private var seekInFlight = false
    private var pendingSeek: (seconds: Double, final: Bool)?
    private var lastSeekIssuedAt = CACurrentMediaTime()
    private var seekLatencyMsEMA: Double = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        player.automaticallyWaitsToMinimizeStalling = false
        buildWindow()
        installTimeObserver()
        loadProjects()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func buildWindow() {
        playerSurface = MetalVideoSurface(player: player)
        homeView = HomeView()
        homeView.onOpenProject = { [weak self] id in
            self?.loadProject(id: id)
        }
        timelineView = TimelineView()
        timelineView.onScrub = { [weak self] seconds, final in
            self?.requestSeek(seconds: seconds, final: final)
        }
        timelineView.onSelect = { [weak self] id in
            self?.selectedElementId = id
            self?.updateEditButtons()
        }
        timelineView.onClipDrag = { [weak self] id, kind, delta, final in
            self?.applyInteractiveDrag(elementId: id, kind: kind, delta: delta, final: final)
        }
        timelineView.onViewportChanged = { [weak self] in
            self?.updateViewportStatus()
        }

        projectPopup = StyledPopupButton()
        projectPopup.target = self
        projectPopup.action = #selector(projectChanged)
        projectPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true

        playButton = makeButton("Play", #selector(togglePlay), variant: .primary)
        speedPopup = StyledPopupButton()
        for (label, rate) in [("0.25x", 25), ("0.5x", 50), ("1x", 100), ("1.5x", 150), ("2x", 200)] {
            speedPopup.addItem(withTitle: label)
            speedPopup.lastItem?.tag = rate
        }
        speedPopup.selectItem(withTitle: "1x")
        speedPopup.target = self
        speedPopup.action = #selector(speedChanged)

        let zoomOutButton = makeButton("Zoom -", #selector(zoomOut), variant: .pill)
        let zoomInButton = makeButton("Zoom +", #selector(zoomIn), variant: .pill)
        let fitButton = makeButton("Fit", #selector(fitTimeline))
        let centerButton = makeButton("Center", #selector(centerTimeline))
        let splitButton = makeButton("Split", #selector(splitSelected))
        let deleteButton = makeButton("Delete", #selector(deleteSelected))
        let duplicateButton = makeButton("Duplicate", #selector(duplicateSelected))
        let rippleButton = makeButton("Ripple", #selector(rippleDeleteSelected))
        undoButton = makeButton("Undo", #selector(undo))
        redoButton = makeButton("Redo", #selector(redo))

        timeLabel = NSTextField(labelWithString: "00:00.00 / 00:00.00")
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        timeLabel.textColor = ShelfStyle.body
        timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        statusLabel = NSTextField(labelWithString: "Loading ShelfEdit projects...")
        statusLabel.font = ShelfStyle.font(size: 12)
        statusLabel.textColor = ShelfStyle.body
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.maximumNumberOfLines = 1

        let brandLabel = NSTextField(labelWithString: "ShelfEdit")
        brandLabel.font = ShelfStyle.bold(size: 18)
        brandLabel.textColor = ShelfStyle.heading
        brandLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        let homeButton = makeButton("Home", #selector(showHome), variant: .pill)

        let toolbar = NSStackView(views: [
            brandLabel,
            homeButton,
            projectPopup,
            playButton,
            speedPopup,
            zoomOutButton,
            zoomInButton,
            fitButton,
            centerButton,
            splitButton,
            deleteButton,
            duplicateButton,
            rippleButton,
            undoButton,
            redoButton,
            timeLabel,
            statusLabel,
        ])
        toolbar.orientation = .horizontal
        toolbar.alignment = .centerY
        toolbar.spacing = 8
        toolbar.edgeInsets = NSEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
        toolbar.translatesAutoresizingMaskIntoConstraints = false

        let topBar = FrostedTopBarView()
        topBar.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(toolbar)

        let previewPanel = GlassPanelView()
        previewPanel.translatesAutoresizingMaskIntoConstraints = false
        playerSurface.translatesAutoresizingMaskIntoConstraints = false
        previewPanel.addSubview(playerSurface)

        let timelinePanel = GlassPanelView()
        timelinePanel.translatesAutoresizingMaskIntoConstraints = false
        timelinePanel.fillColor = ShelfStyle.panelStrong
        timelineView.translatesAutoresizingMaskIntoConstraints = false
        timelinePanel.addSubview(timelineView)

        let content = AppBackgroundView()
        homeView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(topBar)
        content.addSubview(homeView)
        content.addSubview(previewPanel)
        content.addSubview(timelinePanel)
        editorPanels = [previewPanel, timelinePanel]
        setEditorVisible(false)

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: content.topAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 52),

            toolbar.leadingAnchor.constraint(equalTo: topBar.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: topBar.trailingAnchor),
            toolbar.topAnchor.constraint(equalTo: topBar.topAnchor),
            toolbar.bottomAnchor.constraint(equalTo: topBar.bottomAnchor),

            homeView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            homeView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            homeView.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            homeView.bottomAnchor.constraint(equalTo: content.bottomAnchor),

            previewPanel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            previewPanel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            previewPanel.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 14),

            playerSurface.leadingAnchor.constraint(equalTo: previewPanel.leadingAnchor, constant: 14),
            playerSurface.trailingAnchor.constraint(equalTo: previewPanel.trailingAnchor, constant: -14),
            playerSurface.topAnchor.constraint(equalTo: previewPanel.topAnchor, constant: 14),
            playerSurface.bottomAnchor.constraint(equalTo: previewPanel.bottomAnchor, constant: -14),
            playerSurface.heightAnchor.constraint(greaterThanOrEqualToConstant: 360),

            timelinePanel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            timelinePanel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            timelinePanel.topAnchor.constraint(equalTo: previewPanel.bottomAnchor, constant: 14),
            timelinePanel.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            timelinePanel.heightAnchor.constraint(greaterThanOrEqualToConstant: 230),

            timelineView.leadingAnchor.constraint(equalTo: timelinePanel.leadingAnchor, constant: 12),
            timelineView.trailingAnchor.constraint(equalTo: timelinePanel.trailingAnchor, constant: -12),
            timelineView.topAnchor.constraint(equalTo: timelinePanel.topAnchor, constant: 12),
            timelineView.bottomAnchor.constraint(equalTo: timelinePanel.bottomAnchor, constant: -12),
        ])

        window = NSWindow(
            contentRect: NSRect(x: 110, y: 90, width: 1320, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "ShelfEdit Swift Native"
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        updateEditButtons()
    }

    private func makeButton(_ title: String, _ action: Selector, variant: StyledButton.Variant = .secondary) -> NSButton {
        StyledButton(title: title, variant: variant, target: self, action: action)
    }

    private func loadProjects() {
        do {
            projects = try database.listProjects()
            homeView.update(projects: projects)
            projectPopup.removeAllItems()
            for project in projects {
                projectPopup.addItem(withTitle: "\(project.name)  (\(project.mediaCount))")
                projectPopup.lastItem?.representedObject = project.id
            }
            guard !projects.isEmpty else {
                statusLabel.stringValue = "No ShelfEdit projects found in ~/.local_ai_video_editor/shelfedit.db"
                return
            }
            statusLabel.stringValue = "Choose a project from Home."
        } catch {
            statusLabel.stringValue = error.localizedDescription
        }
    }

    @objc private func showHome() {
        player.pause()
        playButton.title = "Play"
        setEditorVisible(false)
        window.title = "ShelfEdit"
        statusLabel.stringValue = "Choose a project from Home."
    }

    @objc private func projectChanged() {
        guard
            let item = projectPopup.selectedItem,
            let id = item.representedObject as? String
        else { return }
        loadProject(id: id)
    }

    private func loadProject(id: String) {
        do {
            var project = try database.loadProject(id: id)
            normalizeTimeline(&project.timeline, media: project.media)
            loadedProject = project
            if let item = projectPopup.itemArray.first(where: { ($0.representedObject as? String) == id }) {
                projectPopup.select(item)
            }
            selectedElementId = nil
            timelineView.selectedElementId = nil
            undoStack.removeAll()
            redoStack.removeAll()
            applyTimelineToView()
            setEditorVisible(true)
            window.title = "ShelfEdit Swift Native - \(project.summary.name)"
            statusLabel.stringValue = "Loaded \(project.summary.name)"
            Task { await rebuildPlayer(keepTime: 0, preservePlayback: false) }
        } catch {
            statusLabel.stringValue = error.localizedDescription
        }
    }

    private func normalizeTimeline(_ timeline: inout TimelineData, media: [String: MediaAsset]) {
        ensurePlayableTimeline(&timeline, media: media)
    }

    private func setEditorVisible(_ visible: Bool) {
        homeView?.isHidden = visible
        editorPanels.forEach { $0.isHidden = !visible }
    }

    private func applyTimelineToView() {
        guard let loadedProject else { return }
        duration = max(0.1, loadedProject.timeline.duration)
        timelineView.timeline = loadedProject.timeline
        timelineView.duration = duration
        timelineView.setViewport(start: timelineView.visibleStart, duration: min(max(0.25, timelineView.visibleDuration), max(0.25, duration)))
        updateLabels(seconds: player.currentTime().seconds)
        updateEditButtons()
    }

    private func installTimeObserver() {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 60),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                guard let self else { return }
                let seconds = time.seconds
                if !self.seekInFlight {
                    self.timelineView.setCurrentTime(seconds, follow: true)
                }
                self.updateLabels(seconds: seconds)
            }
        }
    }

    private func rebuildPlayer(keepTime requestedTime: Double? = nil, preservePlayback: Bool = true) async {
        guard let loadedProject else { return }
        let wasPlaying = preservePlayback && player.timeControlStatus == .playing
        let targetTime = requestedTime ?? player.currentTime().seconds
        let result = await CompositionBuilder.build(timeline: loadedProject.timeline, media: loadedProject.media)
        playerSurface.attach(item: result.item)
        player.replaceCurrentItem(with: result.item)
        duration = max(0.1, result.duration)
        timelineView.duration = duration
        timelineView.timeline = loadedProject.timeline
        timelineView.setCurrentTime(min(targetTime, duration), follow: true)
        requestSeek(seconds: min(targetTime, duration), final: true)
        if wasPlaying {
            player.rate = previewRate
            playButton.title = "Pause"
        }
        let warningText = result.warnings.isEmpty ? "" : "  \(result.warnings.prefix(2).joined(separator: "; "))"
        statusLabel.stringValue = "Native AVFoundation timeline ready.\(warningText)"
        updateLabels(seconds: min(targetTime, duration))
    }

    @objc private func togglePlay() {
        if player.timeControlStatus == .playing {
            player.pause()
            playButton.title = "Play"
        } else {
            player.rate = previewRate
            playButton.title = "Pause"
        }
    }

    @objc private func speedChanged() {
        guard let item = speedPopup.selectedItem else { return }
        previewRate = Float(item.tag) / 100.0
        if player.timeControlStatus == .playing {
            player.rate = previewRate
        }
    }

    @objc private func zoomIn() {
        zoom(by: 0.5)
    }

    @objc private func zoomOut() {
        zoom(by: 2.0)
    }

    @objc private func fitTimeline() {
        timelineView.setViewport(start: 0, duration: max(0.25, duration))
    }

    @objc private func centerTimeline() {
        timelineView.centerOnCurrentTime()
    }

    private func zoom(by factor: Double) {
        guard duration > 0 else { return }
        let center = timelineView.currentTime
        let nextDuration = timelineView.visibleDuration * factor
        timelineView.setViewport(start: center - nextDuration / 2, duration: nextDuration)
    }

    private func requestSeek(seconds: Double, final: Bool) {
        player.pause()
        playButton.title = "Play"
        let targetSeconds = clamped(seconds, 0, max(0, duration))
        timelineView.setCurrentTime(targetSeconds, follow: false)
        updateLabels(seconds: targetSeconds)

        if seekInFlight {
            pendingSeek = (targetSeconds, final)
            return
        }
        issueSeek(seconds: targetSeconds, final: final)
    }

    private func issueSeek(seconds: Double, final: Bool) {
        seekInFlight = true
        lastSeekIssuedAt = CACurrentMediaTime()
        let target = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        let dynamicToleranceSeconds = max(1.0 / 120.0, min(1.0 / 24.0, timelineView.secondsPerPixel * 0.75))
        let tolerance = final ? CMTime.zero : CMTime(seconds: dynamicToleranceSeconds, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: tolerance, toleranceAfter: tolerance) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let ms = (CACurrentMediaTime() - self.lastSeekIssuedAt) * 1000
                self.seekLatencyMsEMA = self.seekLatencyMsEMA == 0 ? ms : self.seekLatencyMsEMA * 0.75 + ms * 0.25
                self.statusLabel.stringValue = String(
                    format: "%@ seek %.0f ms avg %.0f ms   %.4fs/px",
                    final ? "exact" : "smooth",
                    ms,
                    self.seekLatencyMsEMA,
                    self.timelineView.secondsPerPixel
                )
                self.seekInFlight = false
                if let pending = self.pendingSeek {
                    self.pendingSeek = nil
                    self.issueSeek(seconds: pending.seconds, final: pending.final)
                }
            }
        }
    }

    private func pushUndoSnapshot() {
        guard let loadedProject else { return }
        undoStack.append(loadedProject.timeline)
        if undoStack.count > 100 {
            undoStack.removeFirst()
        }
        redoStack.removeAll()
        updateEditButtons()
    }

    @objc private func undo() {
        guard var project = loadedProject, let previous = undoStack.popLast() else { return }
        redoStack.append(project.timeline)
        project.timeline = previous
        loadedProject = project
        afterTimelineMutation(save: true, rebuild: true)
    }

    @objc private func redo() {
        guard var project = loadedProject, let next = redoStack.popLast() else { return }
        undoStack.append(project.timeline)
        project.timeline = next
        loadedProject = project
        afterTimelineMutation(save: true, rebuild: true)
    }

    @objc private func splitSelected() {
        guard var project = loadedProject, let selectedElementId else { return }
        let playhead = timelineView.currentTime
        guard let clip = project.timeline.element(withId: selectedElementId), playhead > clip.timelineStart, playhead < clip.end else {
            statusLabel.stringValue = "Move playhead inside the selected clip to split."
            return
        }
        pushUndoSnapshot()
        let fps = project.timeline.canvas?.fps ?? 30
        let splitAt = snapped(playhead, fps: fps)
        _ = project.timeline.updateElement(withId: selectedElementId) { first in
            if first.type == .text {
                first.timelineEnd = splitAt
            } else {
                let sourceOffset = (splitAt - first.timelineStart) * max(0.1, first.speed ?? 1)
                first.sourceEnd = (first.sourceStart ?? 0) + sourceOffset
            }
        }
        var second = clip
        second.id = "clip_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12))"
        if second.type == .text {
            second.timelineStart = splitAt
            second.timelineEnd = clip.timelineEnd ?? clip.end
        } else {
            let sourceOffset = (splitAt - clip.timelineStart) * max(0.1, clip.speed ?? 1)
            second.sourceStart = (clip.sourceStart ?? 0) + sourceOffset
            second.timelineStart = splitAt
        }
        project.timeline.appendElement(second, toKind: second.type)
        loadedProject = project
        self.selectedElementId = second.id
        timelineView.selectedElementId = second.id
        afterTimelineMutation(save: true, rebuild: true)
    }

    @objc private func deleteSelected() {
        guard var project = loadedProject, let selectedElementId else { return }
        pushUndoSnapshot()
        _ = project.timeline.removeElement(withId: selectedElementId)
        loadedProject = project
        self.selectedElementId = nil
        timelineView.selectedElementId = nil
        afterTimelineMutation(save: true, rebuild: true)
    }

    @objc private func duplicateSelected() {
        guard var project = loadedProject, let selectedElementId, var clip = project.timeline.element(withId: selectedElementId) else { return }
        pushUndoSnapshot()
        clip.id = "clip_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12))"
        clip.timelineStart = clip.end + 0.1
        project.timeline.appendElement(clip, toKind: clip.type)
        loadedProject = project
        self.selectedElementId = clip.id
        timelineView.selectedElementId = clip.id
        afterTimelineMutation(save: true, rebuild: true)
    }

    @objc private func rippleDeleteSelected() {
        guard var project = loadedProject, let selectedElementId, let clip = project.timeline.element(withId: selectedElementId) else { return }
        pushUndoSnapshot()
        _ = project.timeline.removeElement(withId: selectedElementId)
        let rippleStart = clip.end
        let gap = clip.timelineDuration
        for trackIndex in project.timeline.tracks.indices {
            for elementIndex in project.timeline.tracks[trackIndex].elements.indices {
                if project.timeline.tracks[trackIndex].elements[elementIndex].timelineStart >= rippleStart {
                    project.timeline.tracks[trackIndex].elements[elementIndex].timelineStart = max(
                        0,
                        project.timeline.tracks[trackIndex].elements[elementIndex].timelineStart - gap
                    )
                }
            }
        }
        project.timeline.recomputeDuration()
        loadedProject = project
        self.selectedElementId = nil
        timelineView.selectedElementId = nil
        afterTimelineMutation(save: true, rebuild: true)
    }

    private func applyInteractiveDrag(elementId: String, kind: TimelineDragKind, delta: Double, final: Bool) {
        guard var project = loadedProject else { return }
        if interactiveBaseTimeline == nil {
            guard abs(delta) > 0.0001 || !final else { return }
            pushUndoSnapshot()
            interactiveBaseTimeline = project.timeline
        }
        guard var base = interactiveBaseTimeline, let baseClip = base.element(withId: elementId) else { return }
        let fps = base.canvas?.fps ?? 30
        let mediaDuration = baseClip.mediaId.flatMap { project.media[$0]?.duration } ?? max(baseClip.sourceEnd ?? 0, baseClip.duration)
        let frame = 1.0 / max(1, fps)
        let adjustedDelta = snapped(delta, fps: fps)

        _ = base.updateElement(withId: elementId) { clip in
            switch kind {
            case .body:
                clip.timelineStart = max(0, baseClip.timelineStart + adjustedDelta)
            case .trimStart:
                if clip.type == .text {
                    let end = baseClip.timelineEnd ?? baseClip.end
                    clip.timelineStart = clamped(baseClip.timelineStart + adjustedDelta, 0, end - frame)
                    clip.timelineEnd = end
                } else {
                    let speed = max(0.1, baseClip.speed ?? 1)
                    let sourceStart = baseClip.sourceStart ?? 0
                    let sourceEnd = baseClip.sourceEnd ?? sourceStart + baseClip.duration
                    let minDelta = max(-baseClip.timelineStart, -sourceStart / speed)
                    let maxDelta = max(minDelta, (sourceEnd - sourceStart) / speed - frame)
                    let d = clamped(adjustedDelta, minDelta, maxDelta)
                    clip.timelineStart = baseClip.timelineStart + d
                    clip.sourceStart = sourceStart + d * speed
                }
            case .trimEnd:
                if clip.type == .text {
                    clip.timelineEnd = max(baseClip.timelineStart + frame, (baseClip.timelineEnd ?? baseClip.end) + adjustedDelta)
                } else {
                    let speed = max(0.1, baseClip.speed ?? 1)
                    let sourceStart = baseClip.sourceStart ?? 0
                    let sourceEnd = baseClip.sourceEnd ?? sourceStart + baseClip.duration
                    let minDelta = -((sourceEnd - sourceStart) / speed) + frame
                    let maxDelta = max(minDelta, (mediaDuration - sourceEnd) / speed)
                    let d = clamped(adjustedDelta, minDelta, maxDelta)
                    clip.sourceEnd = sourceEnd + d * speed
                }
            case .scrub:
                break
            }
        }

        project.timeline = base
        loadedProject = project
        applyTimelineToView()

        if final {
            interactiveBaseTimeline = nil
            afterTimelineMutation(save: true, rebuild: true)
        } else {
            statusLabel.stringValue = "Editing \(elementId.shortStableId); release to rebuild native composition."
        }
    }

    private func afterTimelineMutation(save: Bool, rebuild: Bool) {
        guard let loadedProject else { return }
        applyTimelineToView()
        if save {
            do {
                try database.saveTimeline(projectId: loadedProject.summary.id, timeline: loadedProject.timeline)
                statusLabel.stringValue = "Saved timeline."
            } catch {
                statusLabel.stringValue = "Save failed: \(error.localizedDescription)"
            }
        }
        if rebuild {
            Task { await rebuildPlayer(preservePlayback: false) }
        }
    }

    private func updateLabels(seconds: Double) {
        timeLabel.stringValue = "\(formatTime(max(0, seconds))) / \(formatTime(duration))"
    }

    private func updateViewportStatus() {
        statusLabel.stringValue = String(
            format: "Viewport %.2fs wide, %.4fs/px. Wheel scrolls; release parks exact.",
            timelineView.visibleDuration,
            timelineView.secondsPerPixel
        )
    }

    private func updateEditButtons() {
        let hasSelection = selectedElementId != nil
        undoButton?.isEnabled = !undoStack.isEmpty
        redoButton?.isEnabled = !redoStack.isEmpty
        for view in undoButton?.superview?.subviews ?? [] {
            guard let button = view as? NSButton else { continue }
            if ["Split", "Delete", "Duplicate", "Ripple"].contains(button.title) {
                button.isEnabled = hasSelection
            }
        }
    }
}

@main
struct ShelfEditSwiftApp {
    @MainActor
    static func main() async {
        if CommandLine.arguments.contains("--self-test") {
            let code = await runSelfTest()
            Darwin.exit(code)
        }
        let app = NSApplication.shared
        let delegate = AppController()
        app.delegate = delegate
        app.run()
    }

    @MainActor
    private static func runSelfTest() async -> Int32 {
        do {
            let database = ShelfDatabase()
            let projects = try database.listProjects()
            let requestedName = requestedSelfTestProjectName()
            let selected = requestedName.flatMap { name in
                projects.first { $0.name.localizedCaseInsensitiveContains(name) }
            } ?? projects.first
            guard let first = selected else {
                print("No projects found")
                return 1
            }
            var loaded = try database.loadProject(id: first.id)
            ensurePlayableTimeline(&loaded.timeline, media: loaded.media)
            let result = await CompositionBuilder.build(timeline: loaded.timeline, media: loaded.media)
            print("Project: \(loaded.summary.name)")
            print("Tracks: \(loaded.timeline.tracks.count)")
            print("Clips: \(loaded.timeline.tracks.flatMap(\.elements).count)")
            print(String(format: "Duration: %.2fs", result.duration))
            if !result.warnings.isEmpty {
                print("Warnings: \(result.warnings.joined(separator: "; "))")
            }
            return result.duration > 0 ? 0 : 1
        } catch {
            print("Self-test failed: \(error.localizedDescription)")
            return 1
        }
    }

    private static func requestedSelfTestProjectName() -> String? {
        guard let index = CommandLine.arguments.firstIndex(of: "--self-test") else { return nil }
        let next = CommandLine.arguments.index(after: index)
        guard next < CommandLine.arguments.endIndex else { return nil }
        let value = CommandLine.arguments[next]
        return value.hasPrefix("--") ? nil : value
    }
}
