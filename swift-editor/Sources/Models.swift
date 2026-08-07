import Foundation

enum TrackKind: String, Codable {
    case video
    case audio
    case text

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? "video"
        self = TrackKind(rawValue: raw) ?? .video
    }
}

struct ProjectSummary {
    let id: String
    let name: String
    let updatedAt: String
    let mediaCount: Int
    let thumbnailPath: String?
    let duration: Double
}

struct MediaAsset {
    let id: String
    let projectId: String
    let type: String
    let originalFilename: String
    let localPath: String
    let duration: Double
    let width: Int
    let height: Int
    let thumbnailPath: String?
}

struct CanvasSpec: Codable {
    var width: Int = 1280
    var height: Int = 720
    var fps: Double = 30
}

struct Transform: Codable {
    var scale: Double = 1
    var x: Double = 0
    var y: Double = 0
    var rotation: Double = 0
}

struct ColorGrade: Codable {
    var brightness: Double = 1
    var contrast: Double = 1
    var saturation: Double = 1
}

struct MaskRect: Codable {
    var x: Double = 0
    var y: Double = 0
    var w: Double = 1
    var h: Double = 1
}

struct ChromaKey: Codable {
    var enabled: Bool = false
    var color: String = "#00ff00"
    var similarity: Double = 0.4
    var smoothness: Double = 0.12
}

/// How a text clip is drawn. Any installed font can be named; nil means the
/// system font. Sizes are in canvas points, so they scale with the render size.
struct TextStyle: Codable {
    var fontName: String?
    var fontSize: Double
    var bold: Bool
    var italic: Bool
    var colorHex: String
    var alignment: String   // "left" | "center" | "right"

    init(
        fontName: String? = nil,
        fontSize: Double = 48,
        bold: Bool = true,
        italic: Bool = false,
        colorHex: String = "#ffffff",
        alignment: String = "center"
    ) {
        self.fontName = fontName
        self.fontSize = fontSize
        self.bold = bold
        self.italic = italic
        self.colorHex = colorHex
        self.alignment = alignment
    }

    init(from decoder: Decoder) throws {
        let v = try decoder.container(keyedBy: CodingKeys.self)
        fontName = try v.decodeIfPresent(String.self, forKey: .fontName)
        fontSize = try v.decodeIfPresent(Double.self, forKey: .fontSize) ?? 48
        bold = try v.decodeIfPresent(Bool.self, forKey: .bold) ?? true
        italic = try v.decodeIfPresent(Bool.self, forKey: .italic) ?? false
        colorHex = try v.decodeIfPresent(String.self, forKey: .colorHex) ?? "#ffffff"
        alignment = try v.decodeIfPresent(String.self, forKey: .alignment) ?? "center"
    }
}

struct Keyframe: Codable {
    var t: Double
    var opacity: Double?
    var scale: Double?
    var x: Double?
    var y: Double?
    var rotation: Double?
}

struct TimelineElement: Codable, Identifiable {
    var id: String
    var type: TrackKind
    var mediaId: String?
    var sourceStart: Double?
    var sourceEnd: Double?
    var timelineStart: Double
    var timelineEnd: Double?
    var text: String?
    var color: ColorGrade?
    var opacity: Double?
    var transform: Transform?
    var fadeIn: Double?
    var fadeOut: Double?
    var chroma: ChromaKey?
    var mask: MaskRect?
    var crop: MaskRect?
    var flipH: Bool?
    var flipV: Bool?
    var speed: Double?
    var keyframes: [Keyframe]?
    var volume: Double?
    var audioFadeIn: Double?
    var audioFadeOut: Double?
    var groupId: String?
    /// Typography for `.text` clips.
    var style: TextStyle?

    enum CodingKeys: String, CodingKey {
        case id
        case type
        case mediaId = "media_id"
        case sourceStart = "source_start"
        case sourceEnd = "source_end"
        case timelineStart = "timeline_start"
        case timelineEnd = "timeline_end"
        case text
        case color
        case opacity
        case transform
        case fadeIn
        case fadeOut
        case chroma
        case mask
        case crop
        case flipH
        case flipV
        case speed
        case keyframes
        case volume
        case audioFadeIn
        case audioFadeOut
        case groupId
        case style
    }

    init(
        id: String,
        type: TrackKind,
        mediaId: String? = nil,
        sourceStart: Double? = nil,
        sourceEnd: Double? = nil,
        timelineStart: Double,
        timelineEnd: Double? = nil,
        text: String? = nil,
        color: ColorGrade? = nil,
        opacity: Double? = nil,
        transform: Transform? = nil,
        fadeIn: Double? = nil,
        fadeOut: Double? = nil,
        chroma: ChromaKey? = nil,
        mask: MaskRect? = nil,
        crop: MaskRect? = nil,
        flipH: Bool? = nil,
        flipV: Bool? = nil,
        speed: Double? = nil,
        keyframes: [Keyframe]? = nil,
        volume: Double? = nil,
        audioFadeIn: Double? = nil,
        audioFadeOut: Double? = nil,
        groupId: String? = nil,
        style: TextStyle? = nil
    ) {
        self.id = id
        self.type = type
        self.mediaId = mediaId
        self.sourceStart = sourceStart
        self.sourceEnd = sourceEnd
        self.timelineStart = timelineStart
        self.timelineEnd = timelineEnd
        self.text = text
        self.color = color
        self.opacity = opacity
        self.transform = transform
        self.fadeIn = fadeIn
        self.fadeOut = fadeOut
        self.chroma = chroma
        self.mask = mask
        self.crop = crop
        self.flipH = flipH
        self.flipV = flipV
        self.speed = speed
        self.keyframes = keyframes
        self.volume = volume
        self.audioFadeIn = audioFadeIn
        self.audioFadeOut = audioFadeOut
        self.groupId = groupId
        self.style = style
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? "clip_\(UUID().uuidString)"
        type = try values.decodeIfPresent(TrackKind.self, forKey: .type) ?? .video
        mediaId = try values.decodeIfPresent(String.self, forKey: .mediaId)
        sourceStart = try values.decodeIfPresent(Double.self, forKey: .sourceStart)
        sourceEnd = try values.decodeIfPresent(Double.self, forKey: .sourceEnd)
        timelineStart = try values.decodeIfPresent(Double.self, forKey: .timelineStart) ?? 0
        timelineEnd = try values.decodeIfPresent(Double.self, forKey: .timelineEnd)
        text = try values.decodeIfPresent(String.self, forKey: .text)
        color = try values.decodeIfPresent(ColorGrade.self, forKey: .color)
        opacity = try values.decodeIfPresent(Double.self, forKey: .opacity)
        transform = try values.decodeIfPresent(Transform.self, forKey: .transform)
        fadeIn = try values.decodeIfPresent(Double.self, forKey: .fadeIn)
        fadeOut = try values.decodeIfPresent(Double.self, forKey: .fadeOut)
        chroma = try values.decodeIfPresent(ChromaKey.self, forKey: .chroma)
        mask = try values.decodeIfPresent(MaskRect.self, forKey: .mask)
        crop = try values.decodeIfPresent(MaskRect.self, forKey: .crop)
        flipH = try values.decodeIfPresent(Bool.self, forKey: .flipH)
        flipV = try values.decodeIfPresent(Bool.self, forKey: .flipV)
        speed = try values.decodeIfPresent(Double.self, forKey: .speed)
        keyframes = try values.decodeIfPresent([Keyframe].self, forKey: .keyframes)
        volume = try values.decodeIfPresent(Double.self, forKey: .volume)
        audioFadeIn = try values.decodeIfPresent(Double.self, forKey: .audioFadeIn)
        audioFadeOut = try values.decodeIfPresent(Double.self, forKey: .audioFadeOut)
        groupId = try values.decodeIfPresent(String.self, forKey: .groupId)
        style = try values.decodeIfPresent(TextStyle.self, forKey: .style)
    }

    var duration: Double {
        if type == .text {
            return max(0.1, (timelineEnd ?? timelineStart + 3) - timelineStart)
        }
        return max(0.1, (sourceEnd ?? 0) - (sourceStart ?? 0))
    }

    var timelineDuration: Double {
        duration / max(0.1, speed ?? 1)
    }

    var end: Double {
        timelineStart + timelineDuration
    }
}

struct TimelineTrack: Codable, Identifiable {
    var id: String
    var kind: TrackKind
    var name: String
    var order: Int
    var elements: [TimelineElement]
    var muted: Bool?
    var volume: Double?
    var hidden: Bool?
    var locked: Bool?
    /// Collapsed lanes shrink to a sliver, keeping the row addressable.
    var collapsed: Bool?

    init(
        id: String,
        kind: TrackKind,
        name: String,
        order: Int,
        elements: [TimelineElement],
        muted: Bool? = nil,
        volume: Double? = nil,
        hidden: Bool? = nil,
        locked: Bool? = nil,
        collapsed: Bool? = nil
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.order = order
        self.elements = elements
        self.muted = muted
        self.volume = volume
        self.hidden = hidden
        self.locked = locked
        self.collapsed = collapsed
    }

    enum CodingKeys: String, CodingKey {
        case id
        case kind
        case name
        case order
        case elements
        case muted
        case volume
        case hidden
        case locked
        case collapsed
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? "trk_\(UUID().uuidString)"
        kind = try values.decodeIfPresent(TrackKind.self, forKey: .kind) ?? .video
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? kind.rawValue.capitalized
        order = try values.decodeIfPresent(Int.self, forKey: .order) ?? 0
        elements = try values.decodeIfPresent([TimelineElement].self, forKey: .elements) ?? []
        muted = try values.decodeIfPresent(Bool.self, forKey: .muted)
        volume = try values.decodeIfPresent(Double.self, forKey: .volume)
        hidden = try values.decodeIfPresent(Bool.self, forKey: .hidden)
        locked = try values.decodeIfPresent(Bool.self, forKey: .locked)
        collapsed = try values.decodeIfPresent(Bool.self, forKey: .collapsed)
    }
}

struct TimelineData: Codable {
    var duration: Double
    var canvas: CanvasSpec?
    var tracks: [TimelineTrack]

    init(duration: Double, canvas: CanvasSpec?, tracks: [TimelineTrack]) {
        self.duration = duration
        self.canvas = canvas
        self.tracks = tracks
    }

    enum CodingKeys: String, CodingKey {
        case duration
        case canvas
        case tracks
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        duration = try values.decodeIfPresent(Double.self, forKey: .duration) ?? 0
        canvas = try values.decodeIfPresent(CanvasSpec.self, forKey: .canvas)
        tracks = try values.decodeIfPresent([TimelineTrack].self, forKey: .tracks) ?? []
        recomputeDuration()
    }

    mutating func recomputeDuration() {
        duration = tracks.flatMap(\.elements).map(\.end).max() ?? 0
        for index in tracks.indices {
            tracks[index].order = index
            tracks[index].elements.sort { $0.timelineStart < $1.timelineStart }
        }
    }

    func element(withId id: String) -> TimelineElement? {
        tracks.lazy.flatMap(\.elements).first { $0.id == id }
    }

    mutating func updateElement(withId id: String, _ edit: (inout TimelineElement) -> Void) -> Bool {
        for trackIndex in tracks.indices {
            guard let elementIndex = tracks[trackIndex].elements.firstIndex(where: { $0.id == id }) else {
                continue
            }
            edit(&tracks[trackIndex].elements[elementIndex])
            recomputeDuration()
            return true
        }
        return false
    }

    mutating func removeElement(withId id: String) -> TimelineElement? {
        for trackIndex in tracks.indices {
            guard let elementIndex = tracks[trackIndex].elements.firstIndex(where: { $0.id == id }) else {
                continue
            }
            let removed = tracks[trackIndex].elements.remove(at: elementIndex)
            recomputeDuration()
            return removed
        }
        return nil
    }

    mutating func appendElement(_ element: TimelineElement, toKind kind: TrackKind) {
        if let index = tracks.firstIndex(where: { $0.kind == kind && !($0.locked ?? false) }) {
            tracks[index].elements.append(element)
        } else {
            tracks.append(TimelineTrack(
                id: "trk_\(kind.rawValue)_\(UUID().uuidString.prefix(8))",
                kind: kind,
                name: kind.rawValue.capitalized,
                order: tracks.count,
                elements: [element]
            ))
        }
        recomputeDuration()
    }

    /// After `recomputeDuration()` every track's `order` equals its array index,
    /// so a track's array index is also its display row (0 = topmost).
    func trackIndex(ofElementId id: String) -> Int? {
        tracks.firstIndex { track in track.elements.contains { $0.id == id } }
    }

    /// Per-track overlap test: does anything on `trackIndex` occupy any part of
    /// `[start, end)` (ignoring the element being moved)?
    func hasOverlap(trackIndex: Int, start: Double, end: Double, excluding id: String) -> Bool {
        guard tracks.indices.contains(trackIndex) else { return false }
        return tracks[trackIndex].elements.contains { element in
            element.id != id && start < element.end && element.timelineStart < end
        }
    }

    /// Move an element to another track (or a brand-new track past the end) at a
    /// new start time. Caller is responsible for validating type/overlap first.
    mutating func moveElement(id: String, toTrackIndex targetIndex: Int, newStart: Double) {
        guard var clip = element(withId: id) else { return }
        _ = removeElement(withId: id)
        clip.timelineStart = max(0, newStart)
        if targetIndex >= tracks.count {
            tracks.append(TimelineTrack(
                id: "trk_\(clip.type.rawValue)_\(UUID().uuidString.prefix(8))",
                kind: clip.type,
                name: "\(clip.type.rawValue.capitalized) \(tracks.filter { $0.kind == clip.type }.count + 1)",
                order: tracks.count,
                elements: [clip]
            ))
        } else {
            tracks[targetIndex].elements.append(clip)
        }
        recomputeDuration()
    }

    /// Every element linked to `id`, including it. A video clip and the audio
    /// clip imported alongside it are peers on their own tracks sharing a
    /// `groupId`; linked elements move, trim, split and delete together.
    func linkedElementIds(of id: String) -> [String] {
        guard let element = element(withId: id), let group = element.groupId else { return [id] }
        let linked = tracks.flatMap(\.elements).filter { $0.groupId == group }.map(\.id)
        return linked.isEmpty ? [id] : linked
    }

    mutating func updateTrack(id: String, _ edit: (inout TimelineTrack) -> Void) {
        guard let index = tracks.firstIndex(where: { $0.id == id }) else { return }
        edit(&tracks[index])
    }

    mutating func removeTrack(id: String) {
        tracks.removeAll { $0.id == id }
        recomputeDuration()
    }

    /// Reorder a track by a signed number of display rows (-1 = up, +1 = down),
    /// clamped to the ends. Display order == array index after `recomputeDuration`.
    mutating func moveTrack(id: String, by delta: Int) {
        guard let index = tracks.firstIndex(where: { $0.id == id }) else { return }
        let target = clamped(index + delta, 0, tracks.count - 1)
        guard target != index else { return }
        let track = tracks.remove(at: index)
        tracks.insert(track, at: target)
        recomputeDuration()
    }

    /// Timeline ranges where a non-hidden video clip is visible — used to blank
    /// the preview surface in gaps (tracks govern what's shown).
    func visibleVideoRanges() -> [Range<Double>] {
        tracks
            .filter { !($0.hidden ?? false) }
            .flatMap(\.elements)
            .filter { $0.type == .video }
            .map { $0.timelineStart..<max($0.timelineStart + 0.0001, $0.end) }
    }
}

struct LoadedProject {
    let summary: ProjectSummary
    var media: [String: MediaAsset]
    var timeline: TimelineData
}

extension TimelineData {
    static func empty() -> TimelineData {
        TimelineData(
            duration: 0,
            canvas: CanvasSpec(width: 1280, height: 720, fps: 30),
            tracks: [
                TimelineTrack(id: "trk_text_1", kind: .text, name: "Text", order: 0, elements: []),
                TimelineTrack(id: "trk_video_1", kind: .video, name: "Video", order: 1, elements: []),
                TimelineTrack(id: "trk_audio_1", kind: .audio, name: "Audio", order: 2, elements: []),
            ]
        )
    }
}
