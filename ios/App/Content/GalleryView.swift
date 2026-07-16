import SwiftUI

/// The public gallery: a paginated grid of recent pieces, plus the random
/// shuffle. Tapping a piece opens its artwork screen.
struct GalleryView: View {
    @EnvironmentObject var auth: AuthModel
    @EnvironmentObject var router: AppRouter
    @Binding var focusId: String?

    @State private var items: [GalleryCard] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var loadedOnce = false
    @State private var showShuffle = false

    private let client = AuthClient()
    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(items) { card in cardLink(card) }
                }
                .padding(12)
                if loading { ProgressView().padding() }
                if loadedOnce && items.isEmpty && !loading {
                    ContentUnavailableView("No pieces yet", systemImage: "sparkles",
                                           description: Text("Be the first — draw one and save it."))
                        .padding(.top, 60)
                }
            }
            .background(Blueprint.graph.ignoresSafeArea())
            .navigationTitle("Gallery")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showShuffle = true } label: { Image(systemName: "shuffle") }
                        .accessibilityLabel("Shuffle")
                        .accessibilityHint("Browse random pieces full screen")
                }
            }
            .refreshable { await loadFirst(reset: true) }
            .navigationDestination(item: $focusId) { id in ArtworkView(id: id) }
            .sheet(isPresented: $showShuffle) {
                NavigationStack {
                    ShuffleViewer(focusId: .constant(nil))
                        .navigationTitle("Shuffle")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { showShuffle = false } } }
                }
            }
        }
        // Loads on first appearance, and reloads whenever a piece is saved
        // (gallerySaveToken changes) so a new public piece shows without relaunch.
        .task(id: router.gallerySaveToken) { await loadFirst(reset: true) }
    }

    @ViewBuilder
    private func cardLink(_ card: GalleryCard) -> some View {
        NavigationLink { ArtworkView(id: card.id) } label: {
            GalleryThumb(card: card, url: client.mediaURL(card.thumb))
        }
        .buttonStyle(.plain)
        .onAppear { if card.id == items.last?.id { Task { await loadMore() } } }
    }

    private func loadFirst(reset: Bool) async {
        if reset { nextCursor = nil }
        loading = true
        defer { loading = false; loadedOnce = true }
        do {
            let page = try await client.gallery(cursor: nil, token: auth.session?.token)
            items = page.items
            nextCursor = page.nextCursor
        } catch {
            // leave existing items; pull-to-refresh can retry
        }
    }

    private func loadMore() async {
        guard let cursor = nextCursor, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.gallery(cursor: cursor, token: auth.session?.token)
            items.append(contentsOf: page.items)
            nextCursor = page.nextCursor
        } catch {}
    }
}

/// A single gallery thumbnail card.
struct GalleryThumb: View {
    let card: GalleryCard
    let url: URL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Rectangle().fill(Blueprint.crease.opacity(0.12))
            }
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .accessibilityLabel(accessibleAltText(card.altText, title: card.title))
            Text(card.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Blueprint.graphite)
                .lineLimit(1)
            if let name = card.author?.name {
                Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        // One VoiceOver element per card: alt text, then title, then author.
        .accessibilityElement(children: .combine)
    }
}
