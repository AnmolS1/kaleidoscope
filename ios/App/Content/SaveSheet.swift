import SwiftUI
import KaleidoEngine

/// The save flow: DESIGN.md §4 — one sheet, eleven states.
///
/// The sheet is presented unconditionally, signed in or not: `signedOut` is one
/// of the eleven, not a different sheet. That is what makes "sign in, then save
/// with the draft intact" structural rather than a race between two `.sheet`
/// presentations — the sheet never dismisses, so there is no draft to lose.
///
/// Which state is on screen is decided by `resolveSaveState`, a pure function
/// with its own table test. This view only renders.
struct SaveSheet: View {
    /// The **v2** drawing. Not `Drawing`: a v1 projection flattens the piece to
    /// a single layer under the top layer's symmetry and drops per-layer
    /// opacity and smoothing, and the resulting save looks fine in the image.
    let drawing: DrawingV2
    var remixOf: String?
    var onSaved: (String) -> Void

    @EnvironmentObject var auth: AuthModel
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var titleSeeded = false
    @State private var didFocusTitle = false
    @State private var visibility: Visibility = .public
    @State private var visibilityTouched = false
    @State private var suggestions: [String] = []
    @State private var saving = false
    @State private var preflight: Preflight = .pending
    @State private var post: PostOutcome?
    @State private var hash: String?
    @State private var twin: ArtworkDetail?
    @State private var errorText: String?
    @State private var savedId: String?
    /// The piece this drawing was remixed from, fetched from `remixOf`. The
    /// studio only carries the id, so ownership and the source's stored hash —
    /// the two facts `SaveSelfChanged` turns on — are looked up here.
    @State private var remixSourceMeta: RemixSource?
    @AccessibilityFocusState private var titleFocused: Bool

    private let client = AuthClient()

    /// Details of the piece this drawing was loaded from.
    struct RemixSource: Equatable {
        var id: String
        var title: String
        var isOwner: Bool
        /// The content hash the source was stored with, when known. Nil means
        /// "unknown" (a legacy row before the backfill) — never "unchanged".
        var contentHash: String?
    }

    // MARK: State resolution

    /// Strokes on VISIBLE layers. Computed from the drawing rather than read off
    /// the studio: a drawing whose only ink is on a hidden layer is not blank on
    /// the canvas but WOULD save a blank image, and the total stroke count
    /// cannot tell those apart.
    private var visibleStrokes: Int {
        drawing.layers.filter(\.visible).reduce(0) { $0 + $1.strokes.count }
    }

    private var capReached: Bool { auth.plus?.capReached ?? false }

    /// Public disappears at the cap. Kept as a computed list so the Picker's
    /// selection can never name a tag that is not in its content — SwiftUI
    /// renders that as no selection at all.
    private var availableVisibilities: [Visibility] {
        capReached ? Visibility.allCases.filter { $0 != .public } : Visibility.allCases
    }

    /// The user is remixing their own piece and has since changed it.
    ///
    /// An unknown source hash falls to `false`: "we cannot tell" must not
    /// present itself as "you changed it", because that seeds the title from
    /// the source and relabels the button.
    private var remixOfOwnChanged: Bool {
        guard let source = remixSourceMeta, source.isOwner,
              let sourceHash = source.contentHash, let hash else { return false }
        return sourceHash != hash
    }

    private var titleInvalid: Bool { titleIsInvalid(title) }

    private var state: SaveStateKind {
        resolveSaveState(SaveStateInput(
            signedIn: auth.isSignedIn,
            visibleStrokes: visibleStrokes,
            preflight: preflight,
            post: post,
            titleInvalid: titleInvalid,
            capReached: capReached,
            remixOfOwnChanged: remixOfOwnChanged
        ))
    }

    /// States that show the title + visibility form at all.
    private var showsForm: Bool {
        switch state {
        case .first, .titleError, .selfChanged, .atCap: return true
        case .duplicateOther, .duplicateOtherPrivate: return true // editable, so a change can be made
        default: return false
        }
    }

    // MARK: Body

    var body: some View {
        NavigationStack {
            Form {
                switch state {
                case .checking:
                    Section { HStack { ProgressView(); Text("Checking…").foregroundStyle(.secondary) } }
                case .signedOut:
                    signedOutSection
                case .nothingVisible:
                    nothingVisibleSection
                case .selfUnchanged:
                    selfUnchangedSection
                case .otherUnchanged:
                    otherUnchangedSection
                default:
                    if state == .duplicateOther || state == .duplicateOtherPrivate { duplicateSection }
                    if state == .error { errorSection }
                    if showsForm { formSections }
                }
            }
            .navigationTitle("Save to gallery")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .overlay { if saving { savingOverlay } }
            .task(id: auth.isSignedIn) { await bootstrap() }
            // Focus when the form first APPEARS, not when the sheet does: on
            // open the pre-flight is still `.pending`, so `state` is `.checking`
            // and there is no field to focus yet. `.onAppear` fired into
            // nothing, silently — VoiceOver just landed on the title bar.
            .onChange(of: showsForm) { _, visible in
                if visible && !didFocusTitle { didFocusTitle = true; titleFocused = true }
            }
            // The Public segment is removed at the cap, so a selection still
            // pointing at it would leave the control showing NOTHING selected.
            .onChange(of: capReached) { _, atCap in
                if atCap && visibility == .public { visibility = .unlisted }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(secondaryLabel) { dismiss() }.disabled(saving)
        }
        if let savedId {
            // The at-cap 201 already stored the piece. Offering "Save unlisted"
            // again here would post a second copy of a drawing the user has.
            ToolbarItem(placement: .confirmationAction) {
                Button("Open it") { onSaved(savedId); dismiss() }.fontWeight(.semibold)
            }
        } else if showsForm {
            ToolbarItem(placement: .confirmationAction) {
                Button(primaryLabel(state, capReached: capReached, remixOfOwnChanged: remixOfOwnChanged)) {
                    Task { await save() }
                }
                .disabled(saving || saveBlocked(state, titleInvalid: titleInvalid))
                .fontWeight(.semibold)
            }
        }
    }

    /// The escape hatch is worded for the state it escapes from.
    private var secondaryLabel: String {
        switch state {
        case .nothingVisible, .otherUnchanged, .duplicateOther, .duplicateOtherPrivate:
            return "Back to canvas"
        default:
            return "Cancel"
        }
    }

    private var savingOverlay: some View {
        ProgressView("Saving…")
            .padding()
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: The eleven states

    private var signedOutSection: some View {
        Section {
            Text("Sign in to save your piece to the gallery.")
                .foregroundStyle(Blueprint.graphite)
            Button {
                Task { await auth.signInWithApple() }
            } label: {
                Label("Continue with Apple", systemImage: "apple.logo").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Blueprint.creaseButton)
            .disabled(auth.isBusy)
            Button {
                Task { await auth.signInWithGoogle() }
            } label: {
                Label("Continue with Google", systemImage: "globe").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(Blueprint.craneText)
            .disabled(auth.isBusy)
            if let message = auth.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.red)
            }
        } footer: {
            Text("Your drawing stays on the canvas while you sign in.")
        }
    }

    private var nothingVisibleSection: some View {
        Section {
            Label {
                Text("Nothing to save yet.").fontWeight(.semibold)
            } icon: {
                Image(systemName: "eye.slash")
            }
            .foregroundStyle(Blueprint.graphite)
            // "Show layers" cannot be offered from here: the layers panel is
            // private `@State` inside `StudioView`, so a button with that label
            // would dismiss the sheet and do nothing else. The copy names the
            // panel instead of pretending to open it.
            Text("Everything you drew is on a hidden layer. Show a layer in the Layers panel, or draw something new.")
                .foregroundStyle(.secondary)
        }
    }

    private var selfUnchangedSection: some View {
        Section {
            Text("This is exactly the piece you already saved.")
                .fontWeight(.semibold)
                .foregroundStyle(Blueprint.graphite)
            if let twin { pieceCard(twin, byLine: ownerByLine(twin)) }
            if case let .done(lookup) = preflight, let id = lookup.mine {
                Button("Open it") { onSaved(id); dismiss() }
                    .tint(Blueprint.craneText)
            }
        } footer: {
            Text("Make a change to save a new version.")
        }
    }

    private var otherUnchangedSection: some View {
        Section {
            Text("This exact drawing is already in the gallery.")
                .fontWeight(.semibold)
                .foregroundStyle(Blueprint.graphite)
            if case let .done(lookup) = preflight, let other = lookup.other {
                pieceCardStub(title: other.title, byLine: "by \(other.author ?? "someone")")
            }
        } footer: {
            Text("Make a change to save your version — anything counts.")
        }
    }

    @ViewBuilder
    private var duplicateSection: some View {
        Section {
            if case let .duplicateOther(of) = post {
                Label {
                    // The Worker names the twin only when it is viewable, so
                    // this branch is the only one that may show a title at all.
                    Text("This exact drawing is already in the gallery. Make a change to save your version.")
                } icon: {
                    Image(systemName: "square.grid.2x2")
                }
                .foregroundStyle(Blueprint.graphite)
                Link("Open the piece it matches", destination: Config.webURL.appendingPathComponent("p/\(of)"))
                    .tint(Blueprint.craneText)
            } else {
                Label {
                    Text("Someone already has this exact drawing in their private collection, so it can't be posted as is. Make a change to save your version.")
                } icon: {
                    Image(systemName: "lock")
                }
                .foregroundStyle(Blueprint.graphite)
            }
        }
    }

    private var errorSection: some View {
        Section {
            Label {
                Text(errorText ?? "Couldn't reach the gallery. Your drawing is safe here — try again in a moment.")
            } icon: {
                Image(systemName: "xmark.circle")
            }
            .foregroundStyle(Blueprint.graphite)
        }
    }

    @ViewBuilder
    private var formSections: some View {
        Section("Title") {
            TextField("Give it a name", text: $title)
                .accessibilityLabel("Title")
                .accessibilityFocused($titleFocused)
            // The title error decorates a field rather than replacing the
            // dialog, so it renders whenever the title is bad — including on an
            // at-cap sheet, which has to show both.
            if titleInvalid && !title.isEmpty {
                Text("Give your piece a real name — \u{201C}Untitled\u{201D} doesn't count.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if !suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(suggestions, id: \.self) { name in
                            Button { title = name } label: {
                                Text(name).font(.caption).lineLimit(1)
                            }
                            .buttonStyle(.bordered)
                            .tint(Blueprint.saxText)
                            .accessibilityLabel("Suggested name: \(name)")
                            .accessibilityHint("Uses this as the title")
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
                .accessibilityLabel("Suggested names")
            }
            if remixOfOwnChanged, let source = remixSourceMeta {
                Text("Remix of your \(source.title)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }

        Section("Visibility") {
            // The segment is REMOVED at the cap, not dimmed: a UIKit-backed
            // segmented control ignores `.disabled` on an individual item view,
            // so a dimmed-looking Public segment would still be tappable and
            // would post a piece the cap forbids. DESIGN.md asks for 45%
            // opacity; an unavailable control that is actually unavailable is
            // the deviation worth taking.
            Picker("Visibility", selection: $visibility) {
                ForEach(availableVisibilities) { v in Text(v.label).tag(v) }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Visibility")
            .onChange(of: visibility) { _, _ in visibilityTouched = true }
            Text(visibility.caption).font(.caption).foregroundStyle(.secondary)
            if let note = capNoteText { Text(note).font(.footnote).foregroundStyle(Blueprint.craneText) }
            if let counter = publicCounter { Text(counter).font(.caption).foregroundStyle(.secondary) }
        }

        if let errorText, state != .error {
            Section { Text(errorText).font(.footnote).foregroundStyle(.red) }
        }
    }

    private var capNoteText: String? {
        guard capReached || state == .atCap, let plus = auth.plus, let cap = plus.publicCap else { return nil }
        let saved = post.map { if case .capReached = $0 { return true } else { return false } } ?? false
        return capNote(count: saved ? cap : plus.publicCount, cap: cap,
                       plusEnabled: plus.enabled, alreadySaved: saved)
    }

    private var publicCounter: String? {
        guard let plus = auth.plus, plus.enabled, let cap = plus.publicCap, !capReached else { return nil }
        return "\(plus.publicCount) of \(cap) public posts used"
    }

    // MARK: Piece cards

    private func ownerByLine(_ d: ArtworkDetail) -> String {
        "You · \(d.visibility) · \(d.likes == 1 ? "1 like" : "\(d.likes) likes")"
    }

    private func pieceCard(_ d: ArtworkDetail, byLine: String) -> some View {
        HStack(spacing: 12) {
            AsyncImage(url: client.mediaURL(d.urls.thumb)) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Rectangle().fill(Blueprint.crease.opacity(0.12))
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(d.title).fontWeight(.semibold).foregroundStyle(Blueprint.graphite)
                Text(byLine).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func pieceCardStub(title: String, byLine: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).fontWeight(.semibold).foregroundStyle(Blueprint.graphite)
            Text(byLine).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Work

    /// Everything that must happen before the sheet can show one of the eleven:
    /// hash the drawing, ask the pre-flight, read the cap. Re-runs when the user
    /// signs in — `.task(id:)` on `isSignedIn` — which is what turns the
    /// signed-out state into a real form without the sheet ever dismissing.
    private func bootstrap() async {
        guard auth.isSignedIn else { preflight = .pending; return }
        await auth.refreshPlus()
        if capReached && !visibilityTouched { visibility = .unlisted }
        await loadRemixSource()
        await runPreflight()
        // Seeded AFTER the pre-flight, because `remixOfOwnChanged` needs this
        // drawing's hash to know the piece has actually changed.
        if remixOfOwnChanged, let source = remixSourceMeta, !titleSeeded {
            title = source.title
            titleSeeded = true
        }
        await loadSuggestions()
    }

    /// Ownership and the source's stored hash. A source that cannot be read
    /// (deleted, or now private) simply leaves this nil, which reads as "not a
    /// changed remix of my own piece" — the safe fallback, since the alternative
    /// is relabelling the button on a guess.
    private func loadRemixSource() async {
        guard let id = remixOf, remixSourceMeta == nil else { return }
        guard let d = try? await client.artwork(id: id, token: auth.session?.token) else { return }
        remixSourceMeta = RemixSource(id: d.id, title: d.title, isOwner: d.isOwner, contentHash: d.contentHash)
    }

    private func runPreflight() async {
        guard let token = auth.session?.token else { preflight = .failed; return }
        // Hash the STORED bytes, so both sides of the comparison go through the
        // same parse + projection the Worker uses.
        let json = serialize(drawing)
        guard let sha = try? contentHash(json) else { preflight = .failed; return }
        hash = sha
        do {
            let lookup = try await client.hashLookup(sha: sha, token: token)
            preflight = .done(lookup)
            if let mine = lookup.mine {
                twin = try? await client.artwork(id: mine, token: token)
            }
        } catch {
            // A 429 here must not wedge the sheet shut on a save that would
            // have worked: `failed` falls through to the ordinary form.
            preflight = .failed
        }
    }

    private func loadSuggestions() async {
        guard let token = auth.session?.token, showsForm else { return }
        guard let thumb = StudioExport.renderSquare(drawing, size: StudioExport.thumbSize).pngData() else { return }
        let sym = topSym(drawing) ?? Symmetry(segments: 12, mirror: true)
        let names = try? await client.suggestNames(
            thumbPNG: thumb,
            segments: sym.segments,
            mirror: sym.mirror,
            palette: paletteOf(drawing),
            token: token
        )
        suggestions = names ?? []
    }

    private func save() async {
        guard let session = auth.session else { errorText = "Please sign in again."; return }
        guard let renders = StudioExport.exportSet(drawing) else {
            errorText = "Couldn't render the image."
            return
        }
        saving = true
        defer { saving = false }
        post = nil
        errorText = nil
        let payload = AuthClient.payload(
            drawing: drawing,
            renders: renders,
            title: title,
            visibility: visibility.rawValue,
            size: Int(StudioExport.imageSize),
            remixOf: remixOf
        )
        do {
            let result = try await client.saveArtwork(payload, token: session.token, csrf: session.csrf)
            if result.capReached == true {
                // 201: the piece IS saved, unlisted. Staying on the sheet in the
                // at-cap state is the point — dismissing here would report a
                // public post the user never got.
                post = .capReached(id: result.id, cap: result.cap, count: result.count)
                savedId = result.id
                await auth.refreshPlus()
                return
            }
            await auth.refreshPlus()
            onSaved(result.id)
            dismiss()
        } catch {
            let outcome = postOutcome(from: error)
            post = outcome
            if outcome == .failed { errorText = saveErrorText(error) }
        }
    }
}
