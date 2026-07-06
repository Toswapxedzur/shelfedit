import Foundation

func formatTime(_ seconds: Double) -> String {
    guard seconds.isFinite && seconds >= 0 else { return "00:00.00" }
    let total = Int(seconds)
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let secs = total % 60
    let centis = Int(((seconds - Double(total)) * 100.0).rounded(.down))
    if hours > 0 {
        return String(format: "%d:%02d:%02d.%02d", hours, minutes, secs, centis)
    }
    return String(format: "%02d:%02d.%02d", minutes, secs, centis)
}

func clamped<T: Comparable>(_ value: T, _ lower: T, _ upper: T) -> T {
    min(max(value, lower), upper)
}

func snapped(_ seconds: Double, fps: Double) -> Double {
    guard fps.isFinite && fps > 0 else { return seconds }
    return (seconds * fps).rounded() / fps
}

extension String {
    var shortStableId: String {
        String(prefix(8))
    }
}
