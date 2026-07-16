import SwiftUI

/// The signed-in user's own pieces (all visibilities). Tapping opens the artwork
/// screen, where the owner can change visibility or delete.
struct MyPiecesView: View {
    @EnvironmentObject var auth: AuthModel

    @State private var items: [MyArtwork] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var loadedOnce = false

    private let client = AuthClient()
    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(items) { piece in pieceLink(piece) }
            }
            .padding(12)
            if loading { ProgressView().padding() }
            if loadedOnce && items.isEmpty && !loading {
                ContentUnavailableView("Nothing saved yet", systemImage: "square.on.square",
                                       description: Text("Draw a piece and tap Save."))
                    .padding(.top, 60)
            }
        }
        .background(Blueprint.graph.ignoresSafeArea())
        .navigationTitle("My pieces")
        .refreshable { await load(reset: true) }
        .task { if !loadedOnce { await load(reset: false) } }
    }

    @ViewBuilder
    private func pieceLink(_ piece: MyArtwork) -> some View {
        NavigationLink { ArtworkView(id: piece.id) } label: {
            VStack(alignment: .leading, spacing: 6) {
                AsyncImage(url: client.mediaURL(piece.thumb)) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Rectangle().fill(Blueprint.crease.opacity(0.12))
                }
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                HStack(spacing: 6) {
                    Text(piece.title).font(.subheadline.weight(.medium)).lineLimit(1)
                        .foregroundStyle(Blueprint.graphite)
                    Spacer()
                    visibilityBadge(piece.visibility)
                }
            }
        }
        .buttonStyle(.plain)
        .onAppear { if piece.id == items.last?.id { Task { await loadMore() } } }
    }

    @ViewBuilder
    private func visibilityBadge(_ v: String) -> some View {
        if v != "public" {
            Image(systemName: v == "private" ? "lock.fill" : "link")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func load(reset: Bool) async {
        guard let token = auth.session?.token else { loadedOnce = true; return }
        if reset { nextCursor = nil }
        loading = true
        defer { loading = false; loadedOnce = true }
        do {
            let page = try await client.myArtworks(cursor: nil, token: token)
            items = page.items
            nextCursor = page.nextCursor
        } catch {}
    }

    private func loadMore() async {
        guard let token = auth.session?.token, let cursor = nextCursor, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.myArtworks(cursor: cursor, token: token)
            items.append(contentsOf: page.items)
            nextCursor = page.nextCursor
        } catch {}
    }
}
