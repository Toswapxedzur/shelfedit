import AppKit
import AVFoundation
import CoreMedia
import Darwin
import QuartzCore
import UniformTypeIdentifiers

@MainActor
final class AppController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let database = ShelfDatabase()
    private let renderCache = RenderCache()

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

    // Draggable first-level panel sizes — adjusted live by the ResizerView seams.
    private var shelfWidthConstraint: NSLayoutConstraint!
    private var inspectorWidthConstraint: NSLayoutConstraint!
    private var timelineHeightConstraint: NSLayoutConstraint!
    private var editorLayoutConstraints: [NSLayoutConstraint] = []
    private let shelfWidthRange: ClosedRange<CGFloat> = 220...420
    private let inspectorWidthRange: ClosedRange<CGFloat> = 260...460
    private let timelineHeightRange: ClosedRange<CGFloat> = 220...640
    // Gap between the pointer and the seam captured at mouse-down, so the seam
    // stays exactly under the grab point rather than snapping to the cursor.
    private var seamGrabOffset: CGFloat = 0

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
        renderCache.onReady = { [weak self] in
            // A flattened overlap segment is ready — rebuild so the preview swaps
            // to the single-stream fast path. No-op if nothing is playing/loaded.
            guard let self, self.loadedProject != nil else { return }
            Task { await self.rebuildPlayer(preservePlayback: true) }
        }
        installTimeObserver()
        loadProjects()
        // Keep the window on-screen when the screen environment changes
        // (resolution/dock/menu-bar changes, displays added or removed) without
        // overriding the size the user has chosen.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.keepWindowOnScreen() }
        }
        NSApp.activate(ignoringOtherApps: true)
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
        timelineView.onClipMoved = { [weak self] id, targetTrackIndex, newStart in
            self?.commitClipMove(id, targetTrackIndex: targetTrackIndex, newStart: newStart)
        }
        timelineView.onViewportChanged = { [weak self] in
            self?.updateViewportStatus()
        }
        timelineView.onTrackToggleCollapsed = { [weak self] id in self?.toggleTrackCollapsed(id) }
        timelineView.onTrackToggleHidden = { [weak self] id in self?.toggleTrackHidden(id) }
        timelineView.onTrackToggleMuted = { [weak self] id in self?.toggleTrackMuted(id) }
        timelineView.onTrackToggleLocked = { [weak self] id in self?.toggleTrackLocked(id) }
        timelineView.onTrackReorder = { [weak self] id, delta in self?.reorderTrack(id, by: delta) }
        timelineView.onTrackDelete = { [weak self] id in self?.deleteTrack(id) }
        timelineView.onTrackRename = { [weak self] id, name in self?.renameTrack(id, to: name) }

        projectPopup = AdamanciaPopupButton()
        projectPopup.target = self
        projectPopup.action = #selector(projectChanged)
        projectPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true

        // Play is the single high-emphasis action: blue/dark tier (solid navy, white ink).
        playButton = makeButton("Play", #selector(togglePlay), color: .blue, tier: .dark)
        speedPopup = AdamanciaPopupButton()
        for (label, rate) in [("0.25x", 25), ("0.5x", 50), ("1x", 100), ("1.5x", 150), ("2x", 200)] {
            speedPopup.addItem(withTitle: label)
            speedPopup.lastItem?.tag = rate
        }
        speedPopup.selectItem(withTitle: "1x")
        speedPopup.target = self
        speedPopup.action = #selector(speedChanged)

        // Everything else shares the same blue/light tier by default —
        // Delete reads danger (red/light). Active tool state is applied below.
        selectToolButton = makeButton("Select", #selector(selectTimelineTool))
        bladeToolButton = makeButton("Blade", #selector(bladeTimelineTool))
        let zoomOutButton = makeButton("Zoom -", #selector(zoomOut))
        let zoomInButton = makeButton("Zoom +", #selector(zoomIn))
        let fitButton = makeButton("Fit", #selector(fitTimeline))
        let centerButton = makeButton("Center", #selector(centerTimeline))
        let splitButton = makeButton("Split", #selector(splitSelected))
        let deleteButton = makeButton("Delete", #selector(deleteSelected), color: .red)
        let duplicateButton = makeButton("Duplicate", #selector(duplicateSelected))
        let rippleButton = makeButton("Ripple", #selector(rippleDeleteSelected))
        undoButton = makeButton("Undo", #selector(undo))
        redoButton = makeButton("Redo", #selector(redo))

        timeLabel = NSTextField(labelWithString: "00:00.00 / 00:00.00")
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        timeLabel.textColor = ShelfStyle.onDark
        timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        statusLabel = NSTextField(labelWithString: "Loading ShelfEdit projects...")
        statusLabel.font = ShelfStyle.font(size: 12)
        statusLabel.textColor = ShelfStyle.onDarkMuted
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
        let previewPanel = GlassPanelView()
        previewPanel.translatesAutoresizingMaskIntoConstraints = false
        previewPanel.fillColor = ShelfStyle.panel
        playerSurface.translatesAutoresizingMaskIntoConstraints = false
        previewPanel.addSubview(playerSurface)

        let timelinePanel = GlassPanelView()
        timelinePanel.translatesAutoresizingMaskIntoConstraints = false
        timelinePanel.fillColor = ShelfStyle.panelStrong
        timelineView.translatesAutoresizingMaskIntoConstraints = false
        // The track view's intrinsic height must NOT fight the timeline's height
        // constraint. Both defaulted to 750, an ambiguous tie the solver could
        // resolve either way and flip between layout passes — so the timeline
        // seam would snap back up (and get stuck above its true minimum) when
        // any relayout happened, e.g. adjusting another seam in fullscreen.
        // Dropping compression resistance below the constraint's .defaultHigh
        // lets the seam win deterministically; the tracks just clip when small.
        timelineView.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        timelineToolStrip.translatesAutoresizingMaskIntoConstraints = false
        timelinePanel.addSubview(timelineToolStrip)
        timelinePanel.addSubview(timelineView)

        // Draggable seams between the first-level panels — the seam itself IS
        // the (now-halved) gap, with a hairline the user can grab to resize.
        let shelfPreviewResizer = ResizerView(axis: .horizontal)
        let previewInspectorResizer = ResizerView(axis: .horizontal)
        let previewTimelineResizer = ResizerView(axis: .vertical)

        let content = AppBackgroundView()
        homeView.translatesAutoresizingMaskIntoConstraints = false
        toolShelfView.translatesAutoresizingMaskIntoConstraints = false
        inspectorPanelView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(homeView)
        content.addSubview(toolShelfView)
        content.addSubview(previewPanel)
        content.addSubview(inspectorPanelView)
        content.addSubview(timelinePanel)
        content.addSubview(shelfPreviewResizer)
        content.addSubview(previewInspectorResizer)
        content.addSubview(previewTimelineResizer)
        editorPanels = [toolShelfView, previewPanel, inspectorPanelView, timelinePanel]

        // Preferred (not required) sizes for the side panels and timeline. At
        // .defaultHigh they hold whenever there's room, but yield to the
        // required preview minimums below when the window is dragged small —
        // that's what lets the window resize freely without breaking layout.
        shelfWidthConstraint = toolShelfView.widthAnchor.constraint(equalToConstant: 330)
        shelfWidthConstraint.priority = .defaultHigh
        inspectorWidthConstraint = inspectorPanelView.widthAnchor.constraint(equalToConstant: 360)
        inspectorWidthConstraint.priority = .defaultHigh
        timelineHeightConstraint = timelinePanel.heightAnchor.constraint(equalToConstant: 300)
        timelineHeightConstraint.priority = .defaultHigh

        NSLayoutConstraint.activate([
            homeView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            homeView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            homeView.topAnchor.constraint(equalTo: content.topAnchor),
            homeView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])

        // `.isHidden` alone does NOT remove a plain NSView's constraints from
        // Auto Layout (that auto-exclusion only happens for NSStackView
        // arranged subviews). Without deactivating these too, the editor
        // panels' large internal content (e.g. the tool shelf's asset list)
        // kept forcing the window to grow to fit them even while hidden on
        // the Home screen — which is why the window didn't fit the screen.
        // These are only activated/deactivated via setEditorVisible below.
        editorLayoutConstraints = [
            toolShelfView.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            toolShelfView.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            toolShelfView.bottomAnchor.constraint(equalTo: previewTimelineResizer.topAnchor),
            shelfWidthConstraint,
            toolShelfView.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),

            inspectorPanelView.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            inspectorPanelView.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            inspectorPanelView.bottomAnchor.constraint(equalTo: previewTimelineResizer.topAnchor),
            inspectorWidthConstraint,
            inspectorPanelView.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),

            previewPanel.leadingAnchor.constraint(equalTo: shelfPreviewResizer.trailingAnchor),
            previewPanel.trailingAnchor.constraint(equalTo: previewInspectorResizer.leadingAnchor),
            previewPanel.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            previewPanel.bottomAnchor.constraint(equalTo: previewTimelineResizer.topAnchor),
            // Required floor so the preview never collapses to nothing — the
            // side panels give up their preferred width to preserve this.
            previewPanel.widthAnchor.constraint(greaterThanOrEqualToConstant: 260),

            shelfPreviewResizer.leadingAnchor.constraint(equalTo: toolShelfView.trailingAnchor),
            shelfPreviewResizer.topAnchor.constraint(equalTo: previewPanel.topAnchor),
            shelfPreviewResizer.bottomAnchor.constraint(equalTo: previewPanel.bottomAnchor),

            previewInspectorResizer.leadingAnchor.constraint(equalTo: previewPanel.trailingAnchor),
            previewInspectorResizer.trailingAnchor.constraint(equalTo: inspectorPanelView.leadingAnchor),
            previewInspectorResizer.topAnchor.constraint(equalTo: previewPanel.topAnchor),
            previewInspectorResizer.bottomAnchor.constraint(equalTo: previewPanel.bottomAnchor),

            previewTimelineResizer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            previewTimelineResizer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            previewTimelineResizer.bottomAnchor.constraint(equalTo: timelinePanel.topAnchor),

            playerSurface.leadingAnchor.constraint(equalTo: previewPanel.leadingAnchor, constant: 14),
            playerSurface.trailingAnchor.constraint(equalTo: previewPanel.trailingAnchor, constant: -14),
            playerSurface.topAnchor.constraint(equalTo: previewPanel.topAnchor, constant: 14),
            playerSurface.bottomAnchor.constraint(equalTo: previewPanel.bottomAnchor, constant: -14),
            playerSurface.heightAnchor.constraint(greaterThanOrEqualToConstant: 180),

            timelinePanel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            timelinePanel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            // Flush with the window's bottom edge — combined with the full-height
            // window this puts the timeline at the bottom of the screen.
            timelinePanel.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            timelinePanel.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
            timelineHeightConstraint,

            timelineToolStrip.leadingAnchor.constraint(equalTo: timelinePanel.leadingAnchor, constant: 12),
            timelineToolStrip.trailingAnchor.constraint(equalTo: timelinePanel.trailingAnchor, constant: -12),
            timelineToolStrip.topAnchor.constraint(equalTo: timelinePanel.topAnchor, constant: 12),
            timelineToolStrip.heightAnchor.constraint(equalToConstant: 40),

            timelineView.leadingAnchor.constraint(equalTo: timelinePanel.leadingAnchor, constant: 12),
            timelineView.trailingAnchor.constraint(equalTo: timelinePanel.trailingAnchor, constant: -12),
            timelineView.topAnchor.constraint(equalTo: timelineToolStrip.bottomAnchor, constant: 8),
            timelineView.bottomAnchor.constraint(equalTo: timelinePanel.bottomAnchor, constant: -12),
        ]
        setEditorVisible(false)

        // Seams map the ABSOLUTE pointer position to a panel size: each panel's
        // size is a pure function of where the cursor is in the content view, so
        // there's nothing to accumulate and a dead zone is impossible — when the
        // pointer is somewhere the seam can't reach (a size beyond the range or
        // that the layout won't honor) the seam simply rests at its limit and
        // snaps back under the cursor the instant it returns to a reachable spot.
        // The panels sit inside 16pt margins; the tool shelf's left edge and the
        // inspector's right edge are fixed, so a panel's size is the distance
        // from that fixed edge to the pointer. `onDragBegan` captures the small
        // grab offset so the seam doesn't jump to the cursor on mouse-down.
        shelfPreviewResizer.onDragBegan = { [weak self] p in
            guard let self, let content = self.window.contentView else { return }
            self.seamGrabOffset = self.toolShelfView.frame.width - (content.convert(p, from: nil).x - 16)
        }
        shelfPreviewResizer.onDrag = { [weak self] p in
            guard let self, let content = self.window.contentView else { return }
            let x = content.convert(p, from: nil).x
            self.shelfWidthConstraint.constant = self.shelfWidthRange.clamped(x - 16 + self.seamGrabOffset)
        }
        previewInspectorResizer.onDragBegan = { [weak self] p in
            guard let self, let content = self.window.contentView else { return }
            let fromRight = content.bounds.width - 16 - content.convert(p, from: nil).x
            self.seamGrabOffset = self.inspectorPanelView.frame.width - fromRight
        }
        previewInspectorResizer.onDrag = { [weak self] p in
            guard let self, let content = self.window.contentView else { return }
            let fromRight = content.bounds.width - 16 - content.convert(p, from: nil).x
            self.inspectorWidthConstraint.constant = self.inspectorWidthRange.clamped(fromRight + self.seamGrabOffset)
        }
        previewTimelineResizer.onDragBegan = { [weak self, weak timelinePanel] p in
            guard let self, let timelinePanel, let content = self.window.contentView else { return }
            self.seamGrabOffset = timelinePanel.frame.height - (content.convert(p, from: nil).y - 16)
        }
        previewTimelineResizer.onDrag = { [weak self] p in
            guard let self, let content = self.window.contentView else { return }
            let y = content.convert(p, from: nil).y
            self.timelineHeightConstraint.constant = self.timelineHeightRange.clamped(y - 16 + self.seamGrabOffset)
        }

        let screenFrame = currentVisibleScreenFrame()
        let startFrame = defaultWindowFrame(in: screenFrame)
        window = NSWindow(
            // `contentRect` excludes the title bar, so pass only the content
            // size here; the full window frame (with origin) is set below once
            // the content view is installed.
            contentRect: NSRect(origin: .zero, size: startFrame.size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        // Only a minimum is enforced — no maximum — so the window can be freely
        // resized (and zoomed/maximized) by the user instead of being pinned to
        // the screen. `keepWindowOnScreen()` just nudges it back if a screen
        // change ever leaves it hanging off an edge.
        window.minSize = minimumWindowSize(for: screenFrame)
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self
        window.title = "ShelfEdit Swift Native"
        window.contentView = content
        window.setFrame(startFrame, display: false)
        scaleEditorLayout(to: screenFrame)
        window.makeKeyAndOrderFront(nil)
        setTimelineTool(.select)
        updateEditButtons()
    }

    private func makeButton(_ title: String, _ action: Selector, color: AdamanciaColor = .blue, tier: AdamanciaTier = .light) -> NSButton {
        AdamanciaButton(title: title, color: color, tier: tier, target: self, action: action)
    }

    private func currentVisibleScreenFrame() -> NSRect {
        window?.screen?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }

    private func fittedWindowFrame(in visibleFrame: NSRect) -> NSRect {
        // No vertical inset — full usable height is allowed so the window can sit
        // flush against the bottom of the screen.
        visibleFrame.insetBy(dx: 8, dy: 0)
    }

    /// Full usable height so the timeline's bottom edge lands on the bottom of the
    /// screen (above the Dock / below the menu bar) instead of floating over a
    /// desktop gap. Width stays inset so it still reads as a resizable window.
    private func defaultWindowFrame(in visibleFrame: NSRect) -> NSRect {
        let minSize = minimumWindowSize(for: visibleFrame)
        let maxFrame = fittedWindowFrame(in: visibleFrame)
        let width = clamped(visibleFrame.width * 0.9, minSize.width, maxFrame.width)
        return NSRect(
            x: visibleFrame.midX - width / 2,
            y: visibleFrame.minY,
            width: width,
            height: visibleFrame.height
        )
    }

    /// The window never demands more than the screen offers: min size is the
    /// smaller of a comfortable working size and what actually fits.
    private func minimumWindowSize(for visibleFrame: NSRect) -> NSSize {
        // Width floor matches the three columns' real minimum (their cards
        // have required min widths); dropping below it would break layout.
        // Height floor is low because the side panels now scroll, so a short
        // window just scrolls their contents.
        NSSize(
            width: min(1080, max(320, visibleFrame.width - 16)),
            height: min(480, max(300, visibleFrame.height - 16))
        )
    }

    /// Preserve the user's chosen window size, only intervening when a screen
    /// change (resolution/dock/menu-bar change, or moving to a smaller display)
    /// would leave the window bigger than the screen or hanging off an edge.
    /// Skipped while the user is dragging (mouse down) so it never yanks the
    /// window out from under the cursor mid-drag.
    private func keepWindowOnScreen() {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        if NSEvent.pressedMouseButtons & 1 != 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.keepWindowOnScreen()
            }
            return
        }
        let visibleFrame = currentVisibleScreenFrame()
        window.minSize = minimumWindowSize(for: visibleFrame)
        let maxSize = fittedWindowFrame(in: visibleFrame).size
        var frame = window.frame
        // Shrink only if the window is now larger than the screen can show.
        frame.size.width = min(frame.width, maxSize.width)
        frame.size.height = min(frame.height, maxSize.height)
        // Nudge back inside the visible area if it now hangs off an edge.
        if frame.maxX > visibleFrame.maxX { frame.origin.x = visibleFrame.maxX - frame.width }
        if frame.minX < visibleFrame.minX { frame.origin.x = visibleFrame.minX }
        if frame.maxY > visibleFrame.maxY { frame.origin.y = visibleFrame.maxY - frame.height }
        if frame.minY < visibleFrame.minY { frame.origin.y = visibleFrame.minY }
        if frame != window.frame {
            window.setFrame(frame, display: true, animate: true)
        }
    }

    /// Scale the editor's first-level panels to the screen so the layout keeps
    /// the same proportions at any size — side panels ~20% of width each, the
    /// timeline ~30% of height — instead of the old fixed 330 / 360 / 300 pt
    /// that left the timeline a sliver on large displays. Clamped to the same
    /// ranges the drag handles use.
    private func scaleEditorLayout(to visibleFrame: NSRect) {
        guard shelfWidthConstraint != nil else { return }
        shelfWidthConstraint.constant = shelfWidthRange.clamped(visibleFrame.width * 0.19)
        inspectorWidthConstraint.constant = inspectorWidthRange.clamped(visibleFrame.width * 0.21)
        timelineHeightConstraint.constant = timelineHeightRange.clamped(visibleFrame.height * 0.32)
    }

    private func resizeWindowForHome() {
        keepWindowOnScreen()
    }

    private func resizeWindowForEditor() {
        keepWindowOnScreen()
    }

    private func makeTimelineToolStrip(views: [NSView]) -> NSView {
        let strip = GlassPanelView()
        strip.cornerRadius = ShelfStyle.radiusCard
        strip.fillColor = ShelfStyle.toolbar
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
        resizeWindowForHome()
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
            resizeWindowForEditor()
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
        // isHidden alone doesn't stop these views' constraints from
        // participating in Auto Layout, so explicitly (de)activate them too.
        if visible {
            NSLayoutConstraint.activate(editorLayoutConstraints)
        } else {
            NSLayoutConstraint.deactivate(editorLayoutConstraints)
        }
    }

    private func applyTimelineToView() {
        guard let loadedProject else { return }
        duration = max(0.1, loadedProject.timeline.duration)
        timelineView.media = loadedProject.media
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
            // A video arrives as two independent peers — picture on a video
            // track, sound on an audio track — tied by a shared groupId so they
            // move, trim, split and delete together until explicitly unlinked.
            let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10)
            let group = "grp_\(suffix)"
            project.timeline.appendElement(
                TimelineElement(
                    id: "clip_v_\(suffix)",
                    type: .video,
                    mediaId: asset.id,
                    sourceStart: 0,
                    sourceEnd: max(0.1, asset.duration),
                    timelineStart: start,
                    speed: 1,
                    groupId: group
                ),
                toKind: .video
            )
            project.timeline.appendElement(
                TimelineElement(
                    id: "clip_a_\(suffix)",
                    type: .audio,
                    mediaId: asset.id,
                    sourceStart: 0,
                    sourceEnd: max(0.1, asset.duration),
                    timelineStart: start,
                    volume: 1,
                    groupId: group
                ),
                toKind: .audio
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
            transform: Transform(scale: 1, x: 0, y: 0, rotation: 0),
            style: TextStyle()
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
                // Only let real playback drive the playhead + auto-follow. While
                // paused (scrubbing/seeking) `requestSeek` already parks the
                // playhead exactly where the user dropped it; if this observer
                // also fired it would yank the playhead to the player's
                // tolerance-approximated time and, at t=0, snap the viewport via
                // `follow` — the start-of-timeline glitch.
                if !self.seekInFlight, self.player.timeControlStatus == .playing {
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
        let result = await CompositionBuilder.build(timeline: loadedProject.timeline, media: loadedProject.media, cache: renderCache)
        playerSurface.attach(item: result.item)
        player.replaceCurrentItem(with: result.item)
        duration = max(0.1, result.duration)
        timelineView.media = loadedProject.media
        timelineView.duration = duration
        timelineView.timeline = loadedProject.timeline
        timelineView.setCurrentTime(min(targetTime, duration), follow: true)
        requestSeek(seconds: min(targetTime, duration), final: true)
        if wasPlaying {
            beginPlayback()
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
            beginPlayback()
        }
    }

    /// Audio is only ever heard during real playback — it stays muted while
    /// scrubbing/seeking (see `requestSeek`), so dragging the playhead is silent.
    private func beginPlayback() {
        player.isMuted = false
        player.rate = previewRate
        playButton.title = "Pause"
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
        player.isMuted = true   // scrubbing/seeking is silent; only playback unmutes
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

        // Linked peers split at the same instant so picture and sound stay in
        // step. The trailing halves get their own group, so each half's video
        // stays linked to its own audio rather than all four being one group.
        let trailingGroup = "grp_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10))"
        var newSelection = elementId

        for id in project.timeline.linkedElementIds(of: elementId) {
            guard let original = project.timeline.element(withId: id),
                  splitAt > original.timelineStart, splitAt < original.end else { continue }
            _ = project.timeline.updateElement(withId: id) { first in
                if first.type == .text {
                    first.timelineEnd = splitAt
                } else {
                    let sourceOffset = (splitAt - first.timelineStart) * max(0.1, first.speed ?? 1)
                    first.sourceEnd = (first.sourceStart ?? 0) + sourceOffset
                }
            }
            var second = original
            second.id = "clip_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12))"
            if second.groupId != nil { second.groupId = trailingGroup }
            if second.type == .text {
                second.timelineStart = splitAt
                second.timelineEnd = original.timelineEnd ?? original.end
            } else {
                let sourceOffset = (splitAt - original.timelineStart) * max(0.1, original.speed ?? 1)
                second.sourceStart = (original.sourceStart ?? 0) + sourceOffset
                second.timelineStart = splitAt
            }
            project.timeline.appendElement(second, toKind: second.type)
            if id == elementId { newSelection = second.id }
        }

        loadedProject = project
        self.selectedElementId = newSelection
        timelineView.selectedElementId = newSelection
        afterTimelineMutation(save: true, rebuild: true)
        return true
    }

    @objc private func deleteSelected() {
        guard var project = loadedProject, let selectedElementId else { return }
        pushUndoSnapshot()
        // Linked peers — a video and its audio — delete together.
        for id in project.timeline.linkedElementIds(of: selectedElementId) {
            _ = project.timeline.removeElement(withId: id)
        }
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

    private func commitClipMove(_ id: String, targetTrackIndex: Int, newStart: Double) {
        guard var project = loadedProject, let clip = project.timeline.element(withId: id) else { return }
        let end = newStart + clip.timelineDuration
        // Re-validate defensively (the view already checked, but the model is
        // the source of truth): landing on an existing track must match type,
        // be unlocked, and not overlap. A new track (index past the end) is
        // always fine because it starts empty and is created with the clip's type.
        if targetTrackIndex < project.timeline.tracks.count {
            let track = project.timeline.tracks[targetTrackIndex]
            let invalid = track.kind != clip.type
                || (track.locked ?? false)
                || project.timeline.hasOverlap(trackIndex: targetTrackIndex, start: newStart, end: end, excluding: id)
            if invalid {
                statusLabel.stringValue = "Can't drop there — overlap or wrong track type."
                return
            }
        }
        pushUndoSnapshot()
        let delta = newStart - clip.timelineStart
        project.timeline.moveElement(id: id, toTrackIndex: targetTrackIndex, newStart: newStart)
        // Linked peers shift by the same amount but stay on their own tracks —
        // the audio is an independent clip, not a passenger of the video.
        for peerId in project.timeline.linkedElementIds(of: id) where peerId != id {
            _ = project.timeline.updateElement(withId: peerId) { peer in
                peer.timelineStart = max(0, peer.timelineStart + delta)
                if let end = peer.timelineEnd { peer.timelineEnd = end + delta }
            }
        }
        loadedProject = project
        selectedElementId = id
        timelineView.selectedElementId = id
        afterTimelineMutation(save: true, rebuild: true)
        statusLabel.stringValue = "Moved clip to \(formatTime(newStart))."
    }

    // MARK: - Per-track operations

    private func mutateTrack(_ id: String, rebuild: Bool, _ edit: (inout TimelineTrack) -> Void) {
        guard var project = loadedProject else { return }
        pushUndoSnapshot()
        project.timeline.updateTrack(id: id, edit)
        loadedProject = project
        afterTimelineMutation(save: true, rebuild: rebuild)
    }

    private func toggleTrackCollapsed(_ id: String) {
        // Purely a view affordance — it changes no rendered output.
        mutateTrack(id, rebuild: false) { $0.collapsed = !($0.collapsed ?? false) }
    }

    private func toggleTrackHidden(_ id: String) {
        mutateTrack(id, rebuild: true) { $0.hidden = !($0.hidden ?? false) }
    }

    private func toggleTrackMuted(_ id: String) {
        mutateTrack(id, rebuild: true) { $0.muted = !($0.muted ?? false) }
    }

    private func toggleTrackLocked(_ id: String) {
        // Lock is an edit guard only — it doesn't change the rendered output.
        mutateTrack(id, rebuild: false) { $0.locked = !($0.locked ?? false) }
    }

    private func renameTrack(_ id: String, to name: String) {
        mutateTrack(id, rebuild: false) { $0.name = name }
    }

    private func reorderTrack(_ id: String, by delta: Int) {
        guard var project = loadedProject,
              let index = project.timeline.tracks.firstIndex(where: { $0.id == id }) else { return }
        // No-op at the ends — don't snapshot/rebuild for a move that can't happen.
        guard index + delta >= 0, index + delta < project.timeline.tracks.count else { return }
        pushUndoSnapshot()
        // Video compositing is topmost-track-wins, so row order affects output.
        project.timeline.moveTrack(id: id, by: delta)
        loadedProject = project
        afterTimelineMutation(save: true, rebuild: true)
    }

    private func deleteTrack(_ id: String) {
        guard var project = loadedProject,
              let track = project.timeline.tracks.first(where: { $0.id == id }) else { return }
        let removedIds = Set(track.elements.map(\.id))
        pushUndoSnapshot()
        project.timeline.removeTrack(id: id)
        loadedProject = project
        if let selection = selectedElementId, removedIds.contains(selection) {
            selectedElementId = nil
            timelineView.selectedElementId = nil
        }
        afterTimelineMutation(save: true, rebuild: true)
        statusLabel.stringValue = "Deleted track \(track.name)."
    }

    private func applyInteractiveDrag(elementId: String, kind: TimelineDragKind, delta: Double, final: Bool) {
        guard var project = loadedProject else { return }
        if interactiveBaseTimeline == nil {
            guard abs(delta) > 0.0001 || !final else { return }
            pushUndoSnapshot()
            interactiveBaseTimeline = project.timeline
        }
        guard var base = interactiveBaseTimeline, base.element(withId: elementId) != nil else { return }
        let fps = base.canvas?.fps ?? 30
        let frame = 1.0 / max(1, fps)
        let adjustedDelta = snapped(delta, fps: fps)

        // Trimming a video trims its linked audio by the same amount, so the two
        // peers never drift apart. Each is clamped against its own source range.
        for linkedId in base.linkedElementIds(of: elementId) {
        guard let baseClip = base.element(withId: linkedId) else { continue }
        let mediaDuration = baseClip.mediaId.flatMap { project.media[$0]?.duration } ?? max(baseClip.sourceEnd ?? 0, baseClip.duration)
        _ = base.updateElement(withId: linkedId) { clip in
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
        }

        // No-overlap invariant applies to trims too: if this step pushed the
        // clip's edge into a same-track neighbor, reject it (the edge stops at
        // the neighbor instead of overlapping).
        if kind != .scrub,
           let idx = base.trackIndex(ofElementId: elementId),
           let moved = base.element(withId: elementId),
           base.hasOverlap(trackIndex: idx, start: moved.timelineStart, end: moved.end, excluding: elementId),
           let snapshot = interactiveBaseTimeline {
            base = snapshot
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
        // Active tool switches to its dark tier (solid fill, white ink) to stand
        // out against the shared blue/light default of the rest of the toolbar.
        (selectToolButton as? AdamanciaButton)?.setPalette(
            color: .blue, tier: activeTimelineTool == .select ? .dark : .light
        )
        (bladeToolButton as? AdamanciaButton)?.setPalette(
            color: .pink, tier: activeTimelineTool == .blade ? .dark : .light
        )
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
