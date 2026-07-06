import AppKit
import AVFoundation
import CoreMedia
import Darwin
import QuartzCore
import UniformTypeIdentifiers

@MainActor
final class AppController: NSObject, NSApplicationDelegate {
    private let database = ShelfDatabase()

    private var window: NSWindow!
    private var player = AVPlayer()
    private var homeView: HomeView!
    private var toolShelfView: ToolShelfView!
    private var playerSurface: MetalVideoSurface!
    private var inspectorPanelView: InspectorPanelView!
    private var timelineView: TimelineView!
    private var editorPanels: [NSView] = []
    private var projectPopup: NSPopUpButton!
    private var playButton: NSButton!
    private var speedPopup: NSPopUpButton!
    private var undoButton: NSButton!
    private var redoButton: NSButton!
    private var selectToolButton: NSButton!
    private var bladeToolButton: NSButton!
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
    private var activeTimelineTool: TimelineTool = .select

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
        toolShelfView = ToolShelfView()
        toolShelfView.onAction = { [weak self] action in
            self?.handleToolAction(action)
        }
        inspectorPanelView = InspectorPanelView()
        inspectorPanelView.onPropertyEdit = { [weak self] property, value in
            self?.applyInspectorEdit(property: property, value: value)
        }
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
            self?.refreshInspector()
            self?.updateEditButtons()
        }
        timelineView.onBlade = { [weak self] id, seconds in
            self?.bladeSplit(elementId: id, at: seconds)
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

        selectToolButton = makeButton("Select", #selector(selectTimelineTool), variant: .pill)
        bladeToolButton = makeButton("Blade", #selector(bladeTimelineTool), variant: .pill)
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

        let timelineToolStrip = makeTimelineToolStrip(views: [
            playButton,
            speedPopup,
            selectToolButton,
            bladeToolButton,
            splitButton,
            deleteButton,
            duplicateButton,
            rippleButton,
            undoButton,
            redoButton,
            zoomOutButton,
            zoomInButton,
            fitButton,
            centerButton,
            timeLabel,
            statusLabel,
        ])
        if let select = selectToolButton as? StyledButton {
            select.activeFillColor = ShelfStyle.videoLight
            select.activeTintColor = ShelfStyle.videoHeavy
        }
        if let blade = bladeToolButton as? StyledButton {
            blade.activeFillColor = ShelfStyle.textLight
            blade.activeTintColor = ShelfStyle.textHeavy
        }

        let previewPanel = GlassPanelView()
        previewPanel.translatesAutoresizingMaskIntoConstraints = false
        previewPanel.fillColor = .white
        playerSurface.translatesAutoresizingMaskIntoConstraints = false
        previewPanel.addSubview(playerSurface)

        let timelinePanel = GlassPanelView()
        timelinePanel.translatesAutoresizingMaskIntoConstraints = false
        timelinePanel.fillColor = ShelfStyle.panelStrong
        timelineView.translatesAutoresizingMaskIntoConstraints = false
        timelineToolStrip.translatesAutoresizingMaskIntoConstraints = false
        timelinePanel.addSubview(timelineToolStrip)
        timelinePanel.addSubview(timelineView)

        let content = AppBackgroundView()
        homeView.translatesAutoresizingMaskIntoConstraints = false
        toolShelfView.translatesAutoresizingMaskIntoConstraints = false
        inspectorPanelView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(homeView)
        content.addSubview(toolShelfView)
        content.addSubview(previewPanel)
        content.addSubview(inspectorPanelView)
        content.addSubview(timelinePanel)
        editorPanels = [toolShelfView, previewPanel, inspectorPanelView, timelinePanel]
        setEditorVisible(false)

        NSLayoutConstraint.activate([
            homeView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            homeView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            homeView.topAnchor.constraint(equalTo: content.topAnchor),
            homeView.bottomAnchor.constraint(equalTo: content.bottomAnchor),

            toolShelfView.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            toolShelfView.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            toolShelfView.bottomAnchor.constraint(equalTo: timelinePanel.topAnchor, constant: -14),
            toolShelfView.widthAnchor.constraint(equalToConstant: 330),

            inspectorPanelView.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            inspectorPanelView.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            inspectorPanelView.bottomAnchor.constraint(equalTo: timelinePanel.topAnchor, constant: -14),
            inspectorPanelView.widthAnchor.constraint(equalToConstant: 360),

            previewPanel.leadingAnchor.constraint(equalTo: toolShelfView.trailingAnchor, constant: 14),
            previewPanel.trailingAnchor.constraint(equalTo: inspectorPanelView.leadingAnchor, constant: -14),
            previewPanel.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            previewPanel.bottomAnchor.constraint(equalTo: timelinePanel.topAnchor, constant: -14),

            playerSurface.leadingAnchor.constraint(equalTo: previewPanel.leadingAnchor, constant: 14),
            playerSurface.trailingAnchor.constraint(equalTo: previewPanel.trailingAnchor, constant: -14),
            playerSurface.topAnchor.constraint(equalTo: previewPanel.topAnchor, constant: 14),
            playerSurface.bottomAnchor.constraint(equalTo: previewPanel.bottomAnchor, constant: -14),
            playerSurface.heightAnchor.constraint(greaterThanOrEqualToConstant: 360),

            timelinePanel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            timelinePanel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            timelinePanel.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            timelinePanel.heightAnchor.constraint(greaterThanOrEqualToConstant: 270),
            timelinePanel.heightAnchor.constraint(equalTo: content.heightAnchor, multiplier: 0.34),

            timelineToolStrip.leadingAnchor.constraint(equalTo: timelinePanel.leadingAnchor, constant: 12),
            timelineToolStrip.trailingAnchor.constraint(equalTo: timelinePanel.trailingAnchor, constant: -12),
            timelineToolStrip.topAnchor.constraint(equalTo: timelinePanel.topAnchor, constant: 12),
            timelineToolStrip.heightAnchor.constraint(equalToConstant: 40),

            timelineView.leadingAnchor.constraint(equalTo: timelinePanel.leadingAnchor, constant: 12),
            timelineView.trailingAnchor.constraint(equalTo: timelinePanel.trailingAnchor, constant: -12),
            timelineView.topAnchor.constraint(equalTo: timelineToolStrip.bottomAnchor, constant: 8),
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
        setTimelineTool(.select)
        updateEditButtons()
    }

    private func makeButton(_ title: String, _ action: Selector, variant: StyledButton.Variant = .secondary) -> NSButton {
        StyledButton(title: title, variant: variant, target: self, action: action)
    }

    private func makeTimelineToolStrip(views: [NSView]) -> NSView {
        let strip = GlassPanelView()
        strip.cornerRadius = ShelfStyle.radiusCard
        strip.fillColor = ShelfStyle.childPanel
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        strip.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: strip.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: strip.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: strip.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: strip.bottomAnchor, constant: -4),
        ])
        return strip
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
            toolShelfView.update(media: Array(project.media.values))
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
        refreshInspector()
        updateLabels(seconds: player.currentTime().seconds)
        updateEditButtons()
    }

    private func refreshInspector() {
        guard let loadedProject else {
            inspectorPanelView?.update(selection: nil, media: [:])
            return
        }
        inspectorPanelView.update(
            selection: selectedElementId.flatMap { loadedProject.timeline.element(withId: $0) },
            media: loadedProject.media
        )
    }

    private func handleToolAction(_ action: ToolShelfAction) {
        switch action {
        case .importLocal:
            importLocalMedia()
        case .importURL:
            statusLabel.stringValue = "URL import is queued for the downloader slice."
        case .importProjectRender:
            statusLabel.stringValue = "Other-project import will reuse exported/final project media in the next data slice."
        case .addText:
            addTextClip(text: "New text", duration: 3)
        case .recognizeSelectedAudio:
            addVoiceRecognitionPlaceholder()
        }
    }

    private func importLocalMedia() {
        guard let loadedProject else {
            statusLabel.stringValue = "Open a project before importing media."
            return
        }
        let panel = NSOpenPanel()
        panel.title = "Import media"
        panel.allowedContentTypes = [.movie, .video, .audio, .mpeg4Movie, .quickTimeMovie]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }

        Task { @MainActor in
            var imported = 0
            for url in panel.urls {
                do {
                    let asset = try await mediaAsset(from: url, projectId: loadedProject.summary.id)
                    let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize.map(Int64.init)
                    try database.insertMediaAsset(asset, sizeBytes: size ?? nil)
                    appendImportedAsset(asset)
                    imported += 1
                } catch {
                    statusLabel.stringValue = "Import failed: \(error.localizedDescription)"
                }
            }
            if imported > 0 {
                statusLabel.stringValue = "Imported \(imported) media asset\(imported == 1 ? "" : "s")."
            }
        }
    }

    private func mediaAsset(from url: URL, projectId: String) async throws -> MediaAsset {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        let kind = videoTracks.isEmpty && !audioTracks.isEmpty ? "audio" : "video"
        let size = try await videoTracks.first?.load(.naturalSize) ?? .zero
        return MediaAsset(
            id: "med_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16))",
            projectId: projectId,
            type: kind,
            originalFilename: url.lastPathComponent,
            localPath: url.path,
            duration: duration.isFinite ? duration : 0,
            width: max(0, Int(abs(size.width))),
            height: max(0, Int(abs(size.height))),
            thumbnailPath: nil
        )
    }

    private func appendImportedAsset(_ asset: MediaAsset) {
        guard var project = loadedProject else { return }
        project.media[asset.id] = asset
        pushUndoSnapshot()
        let start = max(project.timeline.duration, timelineView.currentTime)
        if asset.type == "audio" {
            project.timeline.appendElement(
                TimelineElement(
                    id: "clip_a_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10))",
                    type: .audio,
                    mediaId: asset.id,
                    sourceStart: 0,
                    sourceEnd: max(0.1, asset.duration),
                    timelineStart: start,
                    volume: 1
                ),
                toKind: .audio
            )
        } else {
            project.timeline.appendElement(
                TimelineElement(
                    id: "clip_v_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10))",
                    type: .video,
                    mediaId: asset.id,
                    sourceStart: 0,
                    sourceEnd: max(0.1, asset.duration),
                    timelineStart: start,
                    speed: 1
                ),
                toKind: .video
            )
        }
        loadedProject = project
        toolShelfView.update(media: Array(project.media.values))
        afterTimelineMutation(save: true, rebuild: true)
    }

    private func addTextClip(text: String, duration: Double) {
        guard var project = loadedProject else {
            statusLabel.stringValue = "Open a project before adding text."
            return
        }
        pushUndoSnapshot()
        let start = timelineView.currentTime
        let clip = TimelineElement(
            id: "clip_t_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10))",
            type: .text,
            timelineStart: start,
            timelineEnd: start + max(0.5, duration),
            text: text,
            transform: Transform(scale: 1, x: 0, y: 0, rotation: 0)
        )
        project.timeline.appendElement(clip, toKind: .text)
        loadedProject = project
        selectedElementId = clip.id
        timelineView.selectedElementId = clip.id
        afterTimelineMutation(save: true, rebuild: true)
        statusLabel.stringValue = "Added text clip."
    }

    private func addVoiceRecognitionPlaceholder() {
        guard var project = loadedProject else {
            statusLabel.stringValue = "Open a project before voice recognition."
            return
        }
        guard let id = selectedElementId, let selected = project.timeline.element(withId: id), selected.type == .audio else {
            statusLabel.stringValue = "Select an audio clip before voice recognition."
            return
        }
        pushUndoSnapshot()
        let clip = TimelineElement(
            id: "clip_t_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10))",
            type: .text,
            timelineStart: selected.timelineStart,
            timelineEnd: selected.end,
            text: "Recognized speech placeholder",
            transform: Transform(scale: 1, x: 0, y: 0, rotation: 0)
        )
        project.timeline.appendElement(clip, toKind: .text)
        loadedProject = project
        selectedElementId = clip.id
        timelineView.selectedElementId = clip.id
        afterTimelineMutation(save: true, rebuild: true)
        statusLabel.stringValue = "Added placeholder caption from selected audio."
    }

    private func applyInspectorEdit(property: InspectorProperty, value: Double) {
        guard var project = loadedProject, let selectedElementId else { return }
        pushUndoSnapshot()
        let changed = project.timeline.updateElement(withId: selectedElementId) { clip in
            switch property {
            case .speed:
                clip.speed = clamped(value, 0.1, 16)
            case .amplification:
                clip.volume = clamped(value / 100, 0, 4)
            case .size:
                var transform = clip.transform ?? Transform()
                transform.scale = clamped(value / 100, 0.01, 20)
                clip.transform = transform
            }
        }
        guard changed else { return }
        loadedProject = project
        afterTimelineMutation(save: true, rebuild: true)
        statusLabel.stringValue = "Updated \(selectedElementId.shortStableId)."
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

    @objc private func selectTimelineTool() {
        setTimelineTool(.select)
    }

    @objc private func bladeTimelineTool() {
        setTimelineTool(.blade)
    }

    private func setTimelineTool(_ tool: TimelineTool) {
        activeTimelineTool = tool
        timelineView.activeTool = tool
        updateTimelineToolButtons()
        statusLabel.stringValue = tool == .blade
            ? "Blade mode: click a clip to split it at that frame."
            : "Select mode: click, drag, and trim clips."
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
        guard let selectedElementId else { return }
        if !splitElement(withId: selectedElementId, at: timelineView.currentTime) {
            statusLabel.stringValue = "Move playhead inside the selected clip to split."
        }
    }

    private func bladeSplit(elementId: String, at seconds: Double) {
        if splitElement(withId: elementId, at: seconds) {
            statusLabel.stringValue = "Blade split at \(formatTime(seconds))."
        } else {
            statusLabel.stringValue = "Blade needs a point inside the clip."
        }
    }

    @discardableResult
    private func splitElement(withId elementId: String, at seconds: Double) -> Bool {
        guard var project = loadedProject, let clip = project.timeline.element(withId: elementId) else { return false }
        let fps = project.timeline.canvas?.fps ?? 30
        let splitAt = snapped(seconds, fps: fps)
        guard splitAt > clip.timelineStart, splitAt < clip.end else {
            return false
        }
        pushUndoSnapshot()
        _ = project.timeline.updateElement(withId: elementId) { first in
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
        return true
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
        updateTimelineToolButtons()
    }

    private func updateTimelineToolButtons() {
        (selectToolButton as? StyledButton)?.isActiveStyle = activeTimelineTool == .select
        (bladeToolButton as? StyledButton)?.isActiveStyle = activeTimelineTool == .blade
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
