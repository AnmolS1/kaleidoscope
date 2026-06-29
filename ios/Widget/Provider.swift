import WidgetKit
import SwiftUI

struct PieceEntry: TimelineEntry {
    let date: Date
    let item: GalleryItem?
    let image: UIImage?
    let message: String?
}

// Batch size per network reload. Kept modest: each entry carries a downsampled UIImage and
// widget extensions have a tight memory budget, so we don't attach dozens of full images.
private let batchCount = 12

private func placeholderEntry() -> PieceEntry {
    PieceEntry(date: Date(), item: nil, image: UIImage(named: "SampleArt"), message: nil)
}

private func maxPixel(for context: TimelineProviderContext) -> CGFloat {
    let longest = max(context.displaySize.width, context.displaySize.height)
    // ~2x for retina crispness, capped so memory stays bounded across the batch.
    return min(longest * 2, 600)
}

private func buildTimeline(interval: TimeInterval, context: TimelineProviderContext) async -> Timeline<PieceEntry> {
    let pixel = maxPixel(for: context)
    let items = (try? await APIClient().randomItems(count: batchCount)) ?? []

    guard !items.isEmpty else {
        // Empty gallery or no network: one friendly entry, retry after one interval.
        let entry = PieceEntry(date: Date(), item: nil, image: nil,
                               message: "No public pieces yet — go draw one.")
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(interval)))
    }

    // Pre-bake one entry per piece, spaced at the chosen interval. The displayed image
    // changes at that cadence with no further network hits until the last entry, then reload.
    let start = Date()
    var entries: [PieceEntry] = []
    for (i, item) in items.enumerated() {
        let date = start.addingTimeInterval(interval * Double(i))
        let image = await ImageLoader.load(from: item.imageUrl, maxPixel: pixel)
        entries.append(PieceEntry(date: date, item: item, image: image, message: nil))
    }
    let lastDate = entries.last?.date ?? start
    return Timeline(entries: entries, policy: .after(lastDate))
}

struct Provider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> PieceEntry { placeholderEntry() }

    func snapshot(for configuration: ConfigIntent, in context: Context) async -> PieceEntry {
        placeholderEntry()
    }

    func timeline(for configuration: ConfigIntent, in context: Context) async -> Timeline<PieceEntry> {
        await buildTimeline(interval: configuration.interval.seconds, context: context)
    }
}
