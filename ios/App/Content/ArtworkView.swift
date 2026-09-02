import SwiftUI
import KaleidoEngine

/// A single piece: image, author, like, share, remix, and owner controls.
struct ArtworkView: View {
    let id: String

    @EnvironmentObject var auth: AuthModel
    @EnvironmentObject var studio: StudioModel
    @EnvironmentObject var router: AppRouter
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
                metaRow(d)
            }

            actionRow(d)

            if d.isOwner { ownerControls(d) }
            if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
        }
        .padding()
    }

    /// Symmetry chips. `segments == 0` is the stored signal that the visible
    /// layers disagree — it means LAYERED, and printing "0-fold" there is the
    /// bug this row exists to avoid. Server-side already says "layered"; this is
    /// the client catching up (DESIGN.md, "Layered copy").
    @ViewBuilder
    private func metaRow(_ d: ArtworkDetail) -> some View {
        HStack(spacing: 8) {
            chip(d.segments == 0 ? "Layered" : "\(d.segments)-fold",
                 systemImage: d.segments == 0 ? "square.3.layers.3d" : "circle.hexagongrid")
            if d.segments != 0 {
                chip(d.mirror ? "mirrored" : "rotational", systemImage: "arrow.left.and.right")
            }
            if let layers = ArtworkMeta.layerChip(d.layers) {
                chip(layers, systemImage: "square.on.square")
            }
        }
        .font(.caption)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ArtworkMeta.headline(author: d.author.name,
                                                 segments: d.segments,
                                                 mirror: d.mirror,
                                                 layers: d.layers))
    }

    private func chip(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Blueprint.crease.opacity(0.10), in: Capsule())
    }

    @ViewBuilder
    private func actionRow(_ d: ArtworkDetail) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            // Accessibility sizes: stack full-width so the like count, Remix, and
            // Share all stay fully visible (the horizontal row squeezes them).
            VStack(spacing: 12) {
                likeButton.frame(maxWidth: .infinity)
                remixButton.frame(maxWidth: .infinity)
                shareButton(d).frame(maxWidth: .infinity)
            }
        } else {
            HStack(spacing: 12) {
                likeButton
                remixButton
                shareButton(d)
                Spacer()
            }
        }
    }

    private var likeButton: some View {
        Button { Task { await like() } } label: {
            Label("\(likes)", systemImage: "heart")
        }
        .buttonStyle(.bordered)
        .tint(Blueprint.craneText) // crane-as-text token: 4.5:1+ label in both themes
        .disabled(busy)
        .accessibilityLabel("Like")
        .accessibilityValue(likes == 1 ? "1 like" : "\(likes) likes")
    }

    private var remixButton: some View {
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
    }

    private func shareButton(_ d: ArtworkDetail) -> some View {
        Button { Task { await share(d) } } label: {
            Image(systemName: "square.and.arrow.up")
        }
        .buttonStyle(.bordered)
        .tint(Blueprint.graphite)
        .accessibilityLabel("Share")
    }

    @ViewBuilder
    private func ownerControls(_ d: ArtworkDetail) -> some View {
        Divider()
        VStack(alignment: .leading, spacing: 10) {
            Text("Manage").font(.headline).foregroundStyle(Blueprint.graphite)
            Menu {
                // Public disappears at the cap, the way the save sheet already
                // removes it (REVIEW.md minor mI5). Offering it here meant the
                // menu invited a choice the server was guaranteed to refuse, and
                // the user learned the cap existed by being told no. The piece's
                // CURRENT visibility is always offered, so a public piece can
                // still be seen as public and moved off.
                ForEach(manageVisibilities(current: d.visibility, capReached: auth.plus?.capReached ?? false)) { v in
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

    /// Parse a `?v=2` vector body into the drawing the studio loads.
    ///
    /// `deserializeV2`, not `deserialize`: the request asks for `?v=2`, and
    /// `deserialize` routes through `flattenToV1`, which THROWS on a body whose
    /// visible layers disagree — exactly the bodies `?v=2` exists to fetch. The
    /// two changes only work together, so this is a named function rather than
    /// an inline call: a test can hold the call site to the v2 parser.
    static func parseRemix(_ json: String) throws -> DrawingV2 {
        try deserializeV2(json)
    }

    private func remix() async {
        // Remix is free — anyone can load a public piece into the studio.
        busy = true; defer { busy = false }
        do {
            let json = try await client.vector(id: id, token: auth.session?.token)
            let drawing = try Self.parseRemix(json)
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
            await auth.refreshPlus()
            await load()
        } catch let error as AuthError where error.code == "cap_reached" {
            // 402 on a PATCH to public. One copy of this string, in SaveSheet
            // (REVIEW.md minor mI2) — this file had its own, and that copy read
            // the CAP into both halves of "N of M", so a user 9 pieces into a
            // limit of 10 was told "10 of 10". The count is what the body
            // carries for exactly this reason.
            errorText = patchCapNote(count: error.body?.count ?? auth.plus?.publicCount,
                                     cap: error.body?.cap ?? auth.plus?.publicCap,
                                     plusEnabled: auth.plus?.enabled ?? false)
        } catch {
            errorText = "Couldn't update visibility."
        }
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

/// Visibility options the Manage menu offers for a piece currently at `current`.
///
/// A free function so the rule is table-testable, which is the point: it has
/// three inputs and one of them (the piece's own state) is the exception that
/// makes the other two safe.
///
/// At the cap, Public is dropped — the save sheet already does this, and
/// offering it here meant the menu invited a choice the server was guaranteed to
/// refuse, so a user learned the cap existed by being told no (REVIEW.md minor
/// mI5). Unless the piece is ALREADY public: removing it then would hide the
/// piece's own state from the control that displays it, and leave no way to see
/// what you are moving away from.
func manageVisibilities(current: String, capReached: Bool) -> [Visibility] {
    guard capReached, current != Visibility.public.rawValue else { return Visibility.allCases }
    return Visibility.allCases.filter { $0 != .public }
}
