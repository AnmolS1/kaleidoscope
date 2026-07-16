import SwiftUI
import KaleidoEngine

/// A single piece: image, author, like, share, remix, and owner controls.
struct ArtworkView: View {
    let id: String

    @EnvironmentObject var auth: AuthModel
    @EnvironmentObject var studio: StudioModel
    @EnvironmentObject var router: AppRouter
    @Environment(\.dismiss) private var dismiss

    @State private var detail: ArtworkDetail?
    @State private var likes = 0
    @State private var busy = false
    @State private var shareItem: ShareURL?
    @State private var showAuth = false
    @State private var errorText: String?

    private let client = AuthClient()

    var body: some View {
        ScrollView {
            if let detail {
                content(detail)
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .background(Blueprint.graph.ignoresSafeArea())
        .navigationTitle(detail?.title ?? "Piece")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $shareItem) { item in ShareSheet(items: [item.url]) }
        .sheet(isPresented: $showAuth) { AuthSheet(reason: "Sign in to like and remix.").environmentObject(auth) }
    }

    @ViewBuilder
    private func content(_ d: ArtworkDetail) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            AsyncImage(url: client.mediaURL(d.urls.image)) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                Rectangle().fill(Blueprint.crease.opacity(0.12)).aspectRatio(1, contentMode: .fit)
            }
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .accessibilityLabel(accessibleAltText(d.altText, title: d.title))

            VStack(alignment: .leading, spacing: 4) {
                Text(d.title).font(.title2.bold()).foregroundStyle(Blueprint.graphite)
                if let name = d.author.name {
                    Text("by \(name)").font(.subheadline).foregroundStyle(.secondary)
                }
            }

            actionRow(d)

            if d.isOwner { ownerControls(d) }
            if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
        }
        .padding()
    }

    private func actionRow(_ d: ArtworkDetail) -> some View {
        HStack(spacing: 12) {
            Button { Task { await like() } } label: {
                Label("\(likes)", systemImage: "heart")
            }
            .buttonStyle(.bordered)
            .tint(Blueprint.craneText) // crane-as-text token: 4.5:1+ label in both themes
            .disabled(busy)
            .accessibilityLabel("Like")
            .accessibilityValue(likes == 1 ? "1 like" : "\(likes) likes")

            Button { Task { await remix() } } label: {
                Label("Remix", systemImage: "arrow.triangle.branch")
                    .foregroundStyle(.white) // pin white so the label isn't system-picked
                    .lineLimit(1)
                    .minimumScaleFactor(0.6) // scale down at large text instead of wrapping mid-word
            }
            .buttonStyle(.borderedProminent)
            .tint(Blueprint.creaseButton)
            // Claim label width before the row's Spacer absorbs it, so the label
            // reads "Remix" (not "Re…") at large text instead of compressing.
            .layoutPriority(1)
            .disabled(busy)
            .accessibilityHint("Loads this piece into the studio to edit")

            Button { Task { await share(d) } } label: {
                Image(systemName: "square.and.arrow.up")
            }
            .buttonStyle(.bordered)
            .tint(Blueprint.graphite)
            .accessibilityLabel("Share")
            Spacer()
        }
    }

    @ViewBuilder
    private func ownerControls(_ d: ArtworkDetail) -> some View {
        Divider()
        VStack(alignment: .leading, spacing: 10) {
            Text("Manage").font(.headline).foregroundStyle(Blueprint.graphite)
            Menu {
                ForEach(Visibility.allCases) { v in
                    Button(v.label) { Task { await setVisibility(v.rawValue) } }
                }
            } label: {
                Label("Visibility: \(d.visibility.capitalized)", systemImage: "eye")
            }
            .tint(Blueprint.crease)
            .accessibilityLabel("Visibility")
            .accessibilityValue(d.visibility.capitalized)
            .accessibilityHint("Changes who can see this piece")

            Button(role: .destructive) { Task { await deletePiece() } } label: {
                Label("Delete piece", systemImage: "trash")
            }
            .disabled(busy)
            .accessibilityHint("Permanently removes this piece")
        }
    }

    // MARK: Actions

    private func load() async {
        do {
            let d = try await client.artwork(id: id, token: auth.session?.token)
            detail = d
            likes = d.likes
        } catch {
            errorText = "Couldn't load this piece."
        }
    }

    private func like() async {
        guard let session = auth.session else { showAuth = true; return }
        busy = true; defer { busy = false }
        do { likes = try await client.like(id: id, token: session.token, csrf: session.csrf) }
        catch { errorText = "Couldn't like right now." }
    }

    private func remix() async {
        // Remix is free — anyone can load a public piece into the studio.
        busy = true; defer { busy = false }
        do {
            let json = try await client.vector(id: id, token: auth.session?.token)
            let drawing = try deserialize(json)
            router.remix(drawing, sourceId: id, into: studio)
            dismiss()
        } catch {
            errorText = "Couldn't load this piece to remix."
        }
    }

    private func share(_ d: ArtworkDetail) async {
        busy = true; defer { busy = false }
        do {
            let (data, _) = try await URLSession.shared.data(from: client.mediaURL(d.urls.image))
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(id).webp")
            try data.write(to: url)
            shareItem = ShareURL(url: url)
        } catch {
            errorText = "Couldn't prepare the image."
        }
    }

    private func setVisibility(_ v: String) async {
        guard let session = auth.session else { return }
        busy = true; defer { busy = false }
        do {
            try await client.updateArtwork(id: id, title: nil, visibility: v, token: session.token, csrf: session.csrf)
            await load()
        } catch { errorText = "Couldn't update visibility." }
    }

    private func deletePiece() async {
        guard let session = auth.session else { return }
        busy = true; defer { busy = false }
        do {
            try await client.deleteArtwork(id: id, token: session.token, csrf: session.csrf)
            dismiss()
        } catch { errorText = "Couldn't delete." }
    }
}

/// Identifiable wrapper so a URL can drive `.sheet(item:)`.
struct ShareURL: Identifiable {
    let id = UUID()
    let url: URL
}
