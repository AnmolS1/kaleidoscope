import WidgetKit
import SwiftUI
import AppIntents

struct RandomWidget: Widget {
    static let kind = "RandomWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: ConfigIntent.self, provider: Provider()) { entry in
            RandomWidgetView(entry: entry)
        }
        .configurationDisplayName("Random Piece")
        .description("A random public Kaleidoscope mandala, refreshed on your schedule.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct RandomWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PieceEntry

    var body: some View {
        content
            .containerBackground(for: .widget) { background }
    }

    @ViewBuilder private var background: some View {
        if let image = entry.image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            Blueprint.graph
        }
    }

    @ViewBuilder private var content: some View {
        if let message = entry.message {
            VStack(spacing: 8) {
                RosetteMark(lineWidth: 2).frame(width: 40, height: 40)
                Text(message)
                    .font(.caption)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Blueprint.graphite)
            }
            .padding()
        } else {
            ZStack {
                // Subtle blueprint frame over the art.
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Blueprint.crease.opacity(0.35), lineWidth: 1)
                if family != .systemSmall, let item = entry.item {
                    VStack {
                        Spacer()
                        caption(item)
                    }
                }
            }
            .widgetURL(deepLink)
        }
    }

    private func caption(_ item: GalleryItem) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.headline)
                    .lineLimit(1)
                    .foregroundStyle(.white)
                if let author = item.author {
                    Text("by \(author)")
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            Spacer(minLength: 4)
            if family == .systemLarge {
                RosetteMark(lineWidth: 2).frame(width: 26, height: 26)
            }
            Button(intent: ShuffleIntent()) {
                Image(systemName: "shuffle").font(.system(size: 14, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .padding(8)
            .background(.ultraThinMaterial, in: Circle())
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [.black.opacity(0.65), .clear], startPoint: .bottom, endPoint: .top)
        )
    }

    private var deepLink: URL? {
        guard let id = entry.item?.id else { return nil }
        return URL(string: "\(Config.urlScheme)://p/\(id)")
    }
}
