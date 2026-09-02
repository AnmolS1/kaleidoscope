import Foundation

// Which of the save dialog's states is on screen — resolved as one pure
// function, deliberately away from the view.
//
// This is a port of the web's `src/client/ui/saveState.ts`, kept structurally
// identical on purpose: the two platforms show the same eleven states from the
// same server, and a divergence in the precedence order is the kind of thing
// that is only ever noticed by a user.
//
// DESIGN.md §4 is "one dialog, eleven states". Eleven overlapping conditions
// decided inline in a `body` is how two of them end up unreachable and nobody
// notices — a state that never renders looks exactly like a state that renders
// correctly and was never opened. Here the whole outcome map is one switch over
// plain data, so it is table-testable without a simulator, and a state that
// cannot be reached fails a test rather than shipping.
//
// Two things are NOT decided here, because they compose rather than exclude:
// the title error message and the cap note. Both hang off individual fields, so
// the sheet renders them whenever their condition holds regardless of `kind` —
// an at-cap sheet with an empty title has to show both.

enum SaveStateKind: String, Equatable, CaseIterable {
    /// Pre-flight still in flight. Not one of the eleven — a placeholder.
    case checking
    case signedOut
    case nothingVisible
    case selfUnchanged
    case otherUnchanged
    case duplicateOther
    case duplicateOtherPrivate
    case error
    case atCap
    case titleError
    case selfChanged
    case first
}

/// What came back from `POST /api/artworks`, once it has been attempted.
enum PostOutcome: Equatable {
    /// 409 WITH `of`: a viewable twin, which can be named and linked.
    case duplicateOther(of: String)
    /// 409 WITHOUT `of`: someone else's PRIVATE twin. Nothing to link to.
    case duplicateOtherPrivate
    /// 201 `capReached`: the piece IS saved, unlisted, because the wall was full.
    case capReached(id: String, cap: Int?, count: Int?)
    /// 200 `deduped`: the user ALREADY had this exact picture, so the server
    /// handed back the existing piece and wrote nothing.
    ///
    /// Reachable whenever the pre-flight did not see the match — it failed, it
    /// was rate-limited, or the drawing became identical after it ran. The field
    /// was decoded and discarded (REVIEW.md minor mI8), so this reported an
    /// ordinary save: the sheet dismissed, and the title and visibility the user
    /// had just chosen were silently not applied, because a dedupe never mutates
    /// the piece it matches.
    case deduped(id: String)
    /// Network or any other refusal.
    case failed
}

/// The pre-flight has THREE outcomes, not two.
///
/// `pending` must not render the form (it would flash and swap under the user's
/// hands) and `failed` must — the lookup is rate-limited, and a 429 there
/// cannot be allowed to wedge the dialog shut on a save that would have worked.
enum Preflight: Equatable {
    case pending
    case failed
    case done(HashLookup)
}

struct SaveStateInput: Equatable {
    var signedIn: Bool
    /// Strokes on VISIBLE layers. Never the total — hidden ink saves blank.
    var visibleStrokes: Int
    var preflight: Preflight
    var post: PostOutcome?
    /// Empty, whitespace, or "untitled" in any compatibility spelling.
    var titleInvalid: Bool
    /// `plus.enabled && publicCap != nil && publicCount >= publicCap`.
    var capReached: Bool
    /// Remixing the user's OWN piece, and the drawing has since changed.
    var remixOfOwnChanged: Bool

    init(
        signedIn: Bool = true,
        visibleStrokes: Int = 1,
        preflight: Preflight = .done(HashLookup(mine: nil, other: nil)),
        post: PostOutcome? = nil,
        titleInvalid: Bool = false,
        capReached: Bool = false,
        remixOfOwnChanged: Bool = false
    ) {
        self.signedIn = signedIn
        self.visibleStrokes = visibleStrokes
        self.preflight = preflight
        self.post = post
        self.titleInvalid = titleInvalid
        self.capReached = capReached
        self.remixOfOwnChanged = remixOfOwnChanged
    }
}

/// Precedence, highest first, and each rung is a fact that makes the ones below
/// it moot:
///
///  1. no session          — nothing else can be asked; the pre-flight needs auth
///  2. nothing visible     — there is no picture to talk about at all
///  3. the POST's verdict  — newer information than the pre-flight, which ran
///                           before the user typed anything
///  4. the pre-flight      — a known twin, mine or someone else's
///  5. the cap             — changes what the save DOES, so it outranks garnish
///  6. a bad title         — blocks the save but only decorates one field
///  7. an unchanged remix  — a hint, not a gate
func resolveSaveState(_ i: SaveStateInput) -> SaveStateKind {
    if !i.signedIn { return .signedOut }
    if i.visibleStrokes == 0 { return .nothingVisible }

    if let post = i.post {
        switch post {
        case .duplicateOther: return .duplicateOther
        case .duplicateOtherPrivate: return .duplicateOtherPrivate
        case .failed: return .error
        case .capReached: return .atCap
        // The state that already says the right thing: "you have this picture
        // already", with Open it and Edit title & visibility. Edit is the only
        // route to the rename the save just failed to make.
        case .deduped: return .selfUnchanged
        }
    }

    switch i.preflight {
    case .pending:
        return .checking
    case .failed:
        // A pre-flight that could not run has learned nothing, so it falls
        // through to the ordinary form; the POST still refuses a real duplicate.
        break
    case let .done(lookup):
        if lookup.mine != nil { return .selfUnchanged }
        if lookup.other != nil { return .otherUnchanged }
    }

    if i.capReached { return .atCap }
    if i.titleInvalid { return .titleError }
    if i.remixOfOwnChanged { return .selfChanged }
    return .first
}

/// States where the piece cannot be saved as it stands.
func saveBlocked(_ kind: SaveStateKind, titleInvalid: Bool) -> Bool {
    titleInvalid
        || kind == .duplicateOther
        || kind == .duplicateOtherPrivate
        || kind == .otherUnchanged
}

/// The primary button's label.
///
/// Order matters and is not cosmetic: at the cap the button genuinely does
/// something else (it posts unlisted), so that claim outranks the remix hint.
func primaryLabel(_ kind: SaveStateKind, capReached: Bool, remixOfOwnChanged: Bool) -> String {
    if kind == .error { return "Try again" }
    if capReached || kind == .atCap { return "Save unlisted" }
    if remixOfOwnChanged { return "Save as new" }
    return "Save piece"
}

/// Is this title one the Worker will refuse?
///
/// Mirrors `validateTitle` in the Worker, NFKC included: the fullwidth and
/// ligature spellings of "untitled" walk straight past a naive comparison, and
/// a client that let them through would turn a designed dialog state into an
/// unexplained 400.
func titleIsInvalid(_ raw: String) -> Bool {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return true }
    return trimmed.precomposedStringWithCompatibilityMapping
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased() == "untitled"
}

/// Map a failed `POST /api/artworks` onto the outcome the dialog renders.
///
/// The `of`-vs-no-`of` split on a 409 is the whole reason error bodies are
/// decoded at all: both are "someone else already has this picture", but only
/// one of them may be named, and they are two different designed states.
func postOutcome(from error: Error) -> PostOutcome {
    guard let api = error as? AuthError, let status = api.status else { return .failed }
    if status == 409, api.code == "duplicate_of_other" {
        if let of = api.body?.of { return .duplicateOther(of: of) }
        return .duplicateOtherPrivate
    }
    return .failed
}

/// Copy for a refusal that is NOT one of the designed states.
///
/// "Never a generic 'Couldn't save' for a known code" (DESIGN.md §4) — so every
/// code the Worker can return on this route is named here, and only a genuinely
/// unknown failure falls back.
func saveErrorText(_ error: Error) -> String {
    guard let api = error as? AuthError else {
        return "Couldn't reach the gallery. Your drawing is safe here — try again in a moment."
    }
    switch api.code {
    case "title_required":
        return "Give your piece a real name — \u{201C}Untitled\u{201D} doesn't count."
    case "rate_limited":
        return api.body?.message ?? "Whoa — slow down a little. Try again shortly."
    case "render_too_large", "bad_render_type", "missing_render":
        return "Couldn't prepare the image for upload. Try again in a moment."
    case "vector_too_large", "too_many_strokes", "too_many_points":
        return "This piece is too big to save. Remove a few strokes and try again."
    case "too_many_layers":
        return "This piece has more layers than the gallery accepts. Merge a couple and try again."
    case "server_misconfigured":
        return "The gallery is having a moment. Your drawing is safe here — try again shortly."
    default:
        if api.status == 401 { return "Your session expired. Sign in again to save." }
        return "Couldn't reach the gallery. Your drawing is safe here — try again in a moment."
    }
}

/// The cap note (DESIGN.md §4 `SaveAtCap`).
///
/// Written as four whole sentences rather than a shared tail concatenated onto
/// two different heads: the tail reads correctly after one head and produces
/// `now, — then` / `. — then` after the other, and nothing in a build catches a
/// garbled string. `capNoteReadsCleanly` is the check that does.
///
/// Every cap string offers BOTH exits, because the cap is a current count —
/// unpublishing an older piece frees a slot. The Plus half is dropped while
/// `plus.enabled` is false, where it would name something the user cannot buy.
func capNote(count: Int, cap: Int, plusEnabled: Bool, alreadySaved: Bool) -> String {
    let plusExit = plusEnabled ? ", or get Kaleidoscope Plus for unlimited." : "."
    if alreadySaved {
        return "Saved unlisted — your public wall is full (\(count) of \(cap)). "
            + "Make an older piece private to free a slot\(plusExit)"
    }
    return "Your public wall is full (\(count) of \(cap)). "
        + "Post this unlisted now — then make an older piece private to free a slot\(plusExit)"
}

/// No sentence has run into its neighbour. A punctuation seam is exactly what a
/// concatenated tail gets wrong, and exactly what no compiler notices.
func capNoteReadsCleanly(_ s: String) -> Bool {
    for bad in [", —", ". —", "  ", " .", " ,", "..", ",."] where s.contains(bad) { return false }
    return s.hasSuffix(".")
}
