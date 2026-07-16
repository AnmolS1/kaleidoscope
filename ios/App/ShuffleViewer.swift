import SwiftUI

@MainActor
final class ShuffleModel: ObservableObject {
    @Published var items: [GalleryItem] = []
    @Published var index = 0
    @Published var loading = false
    @Published var message: String?

    var current: GalleryItem? { items.indices.contains(index) ? items[index] : nil }

    func load() async {
        loading = true
        message = nil
        do {
            let fetched = try await APIClient().randomItems(count: 24)
            items = fetched
            index = 0
            if fetched.isEmpty { message = "No public pieces yet — go draw one." }
        } catch {
            if items.isEmpty { message = "Couldn't reach the gallery. Tap to retry." }
        }
        loading = false
    }

    func next() {
        guard !items.isEmpty else {
            Task { await load() }
            return
        }
        index = (index + 1) % items.count
        if index == 0 { Task { await load() } } // refill once we loop back around
    }

    /// Focus a specific piece named by a deep link, fetching a stand-in if we don't have it.
    func focus(on id: String) {
        if let i = items.firstIndex(where: { $0.id == id }) {
            index = i
        } else {
            items.insert(.fromId(id), at: 0)
            index = 0
        }
    }
}

struct ShuffleViewer: View {
    @Binding var focusId: String?
    @StateObject private var model = ShuffleModel()
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Advance to the next piece, animating only when Reduce Motion is off.
    private func advance() {
        if reduceMotion {
            model.next()
        } else {
            withAnimation { model.next() }
        }
    }

    var body: some View {
        ZStack {
            Blueprint.graph.ignoresSafeArea()
            if let item = model.current {
                piece(item)
            } else if model.loading {
                ProgressView().tint(Blueprint.crane)
            } else {
                emptyState
            }
        }
        .task { if model.items.isEmpty { await model.load() } }
        .onChange(of: focusId) { _, newValue in applyFocus(newValue) }
        .onChange(of: model.items.count) { _, _ in applyFocus(focusId) }
    }

    private func applyFocus(_ id: String?) {
        guard let id, !id.isEmpty else { return }
        model.focus(on: id)
        focusId = nil
    }

    private func piece(_ item: GalleryItem) -> some View {
        VStack(spacing: 12) {
            AsyncImage(url: URL(string: item.imageUrl)) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .failure:
                    Image(systemName: "photo")
                        .font(.largeTitle)
                        .foregroundStyle(Blueprint.crease)
                        .frame(maxWidth: .infinity, minHeight: 240)
                default:
                    ProgressView().tint(Blueprint.crane).frame(maxWidth: .infinity, minHeight: 240)
                }
            }
            .background(Blueprint.graph)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Blueprint.crease.opacity(0.4)))
            .onTapGesture { advance() }
            .accessibilityElement()
            .accessibilityLabel(accessibleAltText(item.altText, title: item.title))
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Shows the next piece")

            VStack(spacing: 2) {
                Text(item.title).font(.headline).foregroundStyle(Blueprint.graphite)
                if let author = item.author {
                    Text("by \(author)").font(.subheadline).foregroundStyle(Blueprint.graphite.opacity(0.7))
                }
            }

            HStack(spacing: 12) {
                Button { advance() } label: {
                    Label("Shuffle", systemImage: "shuffle")
                        .foregroundStyle(.white) // pin white so the label isn't system-picked
                        .lineLimit(1)
                        .minimumScaleFactor(0.6) // scale down at large text instead of wrapping mid-word
                }
                .buttonStyle(.borderedProminent)
                .tint(Blueprint.craneButton)
                .accessibilityHint("Shows the next piece")

                if let url = URL(string: item.permalink) {
                    Button { openURL(url) } label: {
                        Label("Open on the web", systemImage: "safari")
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                    }
                    .buttonStyle(.bordered)
                    .tint(Blueprint.crease)
                }
            }

            Button("Draw your own") { openURL(Config.webURL) }
                .font(.footnote)
                .foregroundStyle(Blueprint.crease)
        }
        .padding()
        .gesture(DragGesture(minimumDistance: 30).onEnded { _ in advance() })
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            RosetteMark(lineWidth: 3).frame(width: 64, height: 64)
            Text(model.message ?? "Tap to load a piece.")
                .multilineTextAlignment(.center)
                .foregroundStyle(Blueprint.graphite)
            Button { Task { await model.load() } } label: {
                Text("Try again")
                    .foregroundStyle(.white) // pin white so the label isn't system-picked
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            .buttonStyle(.borderedProminent)
            .tint(Blueprint.craneButton)
        }
        .padding()
    }
}
