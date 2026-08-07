import Foundation

func ensurePlayableTimeline(_ timeline: inout TimelineData, media: [String: MediaAsset]) {
    timeline.recomputeDuration()
    guard timeline.tracks.flatMap(\.elements).isEmpty else { return }
    guard let asset = media.values.first(where: { $0.type != "export" }) else { return }
    let end = max(0.1, asset.duration)
    timeline = TimelineData(
        duration: end,
        canvas: CanvasSpec(width: max(1280, asset.width), height: max(720, asset.height), fps: 30),
        tracks: [
            TimelineTrack(id: "trk_text_1", kind: .text, name: "Text", order: 0, elements: []),
            // The video and its audio are independent peers on their own tracks,
            // tied together by a shared groupId so edits propagate across both.
            TimelineTrack(id: "trk_video_1", kind: .video, name: "Video", order: 1, elements: [
                TimelineElement(id: "clip_v0", type: .video, mediaId: asset.id, sourceStart: 0, sourceEnd: end, timelineStart: 0, groupId: "grp_\(asset.id)"),
            ]),
            TimelineTrack(id: "trk_audio_1", kind: .audio, name: "Audio", order: 2, elements: [
                TimelineElement(id: "clip_a0", type: .audio, mediaId: asset.id, sourceStart: 0, sourceEnd: end, timelineStart: 0, groupId: "grp_\(asset.id)"),
            ]),
        ]
    )
}
