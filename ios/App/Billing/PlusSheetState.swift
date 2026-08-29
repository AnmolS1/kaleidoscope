import Foundation

// Which of the Plus sheet's states is on screen, and every string it can show.
//
// A port of the web's `src/client/ui/plusState.ts`, kept structurally identical
// for the same reason `SaveState.swift` mirrors `saveState.ts`: both platforms
// show the same sheet driven by the same server, and a divergence in the
// precedence order is the kind of thing only a user ever notices.
//
// DESIGN.md §5 is "one sheet, six states". A state whose condition can never
// hold renders nothing, breaks nothing, and looks exactly like a state nobody
// happened to open — so the whole map is one switch over plain data and
// `PlusSheetStateTests` table-tests reachability with no simulator UI at all.
//
// 🔴 Copy rule, App Review 3.1.1: nothing here may name the web price or the web
// checkout. The price is never a literal — it arrives as `product.displayPrice`
// — and `test/unit/plus-state.test.ts` scans `ios/**` to prove the only
// price-shaped string in either tree is the web's own constant. The frames in
// DESIGN.md §5 say "on web and iOS" in three places; those mentions are dropped
// here on purpose (see PlusCopy).

/// The eight states. Six are DESIGN.md's; `error` and `unavailable` are added
/// because a 429, a dead network and an App Store that does not answer have to
/// land somewhere, and landing on the buy button ("nothing happened") is worse
/// than saying so.
enum PlusSheetKind: String, CaseIterable, Equatable {
    /// `PlusBefore` — the pitch, the meter, and the buy button.
    case before
    /// `PlusPurchasing` — a purchase or restore is in flight; button disabled.
    case purchasing
    /// `PlusPurchased` — `/api/me` says this account holds the entitlement.
    case purchased
    /// `PlusRestoreNone` — restore ran and this account owns nothing.
    case restoreNone
    /// `PlusBoundElsewhere` — the purchase is bound to a different account.
    case boundElsewhere
    /// `PlusSignIn` — no session, so a purchase would have nothing to bind to.
    case signIn
    /// Beyond DESIGN.md: something went wrong and the message says what.
    case error
    /// Beyond DESIGN.md: StoreKit never handed us the product, so there is no
    /// `displayPrice` and therefore nothing legitimate to put on the button.
    case unavailable
}

/// What the last purchase or restore turned into.
enum PlusOutcome: Equatable {
    case purchased
    case restoreNone
    case boundElsewhere
    case signIn
    case error(String)

    var kind: PlusSheetKind {
        switch self {
        case .purchased: return .purchased
        case .restoreNone: return .restoreNone
        case .boundElsewhere: return .boundElsewhere
        case .signIn: return .signIn
        case .error: return .error
        }
    }
}

struct PlusSheetInput: Equatable {
    /// A session exists. Without one there is no account to bind a purchase to.
    var signedIn: Bool
    /// 🔴 `plus.active` from `/api/me`, and NOTHING else.
    ///
    /// Never `Transaction.currentEntitlements`. That set is empty until StoreKit
    /// syncs, momentarily empty right after a sandbox purchase, and permanently
    /// empty for someone who bought Plus on the other platform — so gating the UI
    /// on it hides the feature from genuine subscribers on a cold launch. The
    /// server owns the entitlement; StoreKit only reports purchases to it.
    var owned: Bool
    /// A purchase or restore is in flight.
    var busy: Bool
    /// The last attempt's result, or nil before anything has been attempted.
    var outcome: PlusOutcome?
    /// The product load FINISHED and produced nothing.
    ///
    /// Deliberately not "there is no price yet": while the load is still in the
    /// air the sheet shows the pitch with a disabled button, because accusing
    /// the App Store of being down for the 200ms before it answers is worse than
    /// a button that is briefly not pressable.
    var loadFailed: Bool

    init(
        signedIn: Bool = true,
        owned: Bool = false,
        busy: Bool = false,
        outcome: PlusOutcome? = nil,
        loadFailed: Bool = false
    ) {
        self.signedIn = signedIn
        self.owned = owned
        self.busy = busy
        self.outcome = outcome
        self.loadFailed = loadFailed
    }

    /// 🔴 The one admissible source of the `owned` bit.
    ///
    /// Deliberately takes `PlusState?` and nothing else: there is no StoreKit
    /// parameter here, so gating the UI on `Transaction.currentEntitlements`
    /// cannot be done without changing this signature. Nil (no `/api/me` yet,
    /// or signed out) is NOT ownership — it fails closed.
    static func owned(from plus: PlusState?) -> Bool { plus?.active ?? false }
}

/// Precedence, highest first. Identical to the web's, plus one rung.
func resolvePlusSheet(_ i: PlusSheetInput) -> PlusSheetKind {
    // An outcome outranks everything: it is the answer to the question the user
    // just asked, and it is cleared the moment they ask another one.
    if let outcome = i.outcome { return outcome.kind }
    if i.busy { return .purchasing }
    if !i.signedIn { return .signIn }
    if i.owned { return .purchased }
    // Below `owned` on purpose — an account that already holds Plus has no
    // business being told the store is unreachable.
    if i.loadFailed { return .unavailable }
    return .before
}

// ---- copy -----------------------------------------------------------------

/// Every user-visible string on the sheet, in one place so the 3.1.1 review of
/// it is a review of one file.
enum PlusCopy {
    static let title = "Kaleidoscope Plus"

    /// DESIGN.md §5's three feature lines.
    ///
    /// The third sub-line reads "No subscription. Yours on web and iOS." in the
    /// frame. The web half is dropped here: an iOS build that advertises the
    /// same product being for sale somewhere else is App Review 3.1.1, and the
    /// sentence loses nothing a buyer needs.
    static let features: [(String, String)] = [
        ("Unlimited public posts", "Free accounts show 10 pieces on the public wall at a time"),
        ("Eight layers", "Free accounts get three"),
        ("One-time purchase", "No subscription. Buy it once, keep it."),
    ]

    static let purchased = "Eight layers and unlimited public posts."
    static let purchasedTitle = "You’re in."
    static let backToCanvas = "Back to canvas"

    /// Frame copy: "…If you bought Plus on the web, sign in with that account
    /// instead." Reworded to name the account rather than the other platform —
    /// it points a web buyer at the same fix without naming the web store.
    static let restoreNone =
        "No purchase found for this Apple ID. If you bought Plus with a different "
        + "Kaleidoscope account, sign in with that account instead."

    static let boundElsewhere =
        "This purchase is linked to another Kaleidoscope account. Sign in with that "
        + "account to use it here."
    static let switchAccount = "Switch account"

    /// Frame copy: "…so the purchase follows your account across web and iOS."
    /// Same trim, same reason. It still answers the question the sheet has to
    /// answer — why a purchase needs a sign-in at all.
    static let signIn = "Sign in first so the purchase stays with your Kaleidoscope account."
    static let signInCTA = "Sign in to continue"

    static let restore = "Restore purchase"
    static let unlocking = "Unlocking…"
    /// The label with no price in it. Only ever shown DISABLED, while the
    /// product is still loading — a live "Unlock" button with no price is a
    /// button whose cost the user cannot see.
    static let unlockNoPrice = "Unlock"

    static let rateLimited = "Too many attempts just now. Give it a few minutes and try again."

    /// 🔴 Phase one only — StoreKit refused BEFORE taking money.
    ///
    /// The web's generic error says "Nothing was charged" and can, because a
    /// failed redirect never charges anything. On iOS that sentence is a lie
    /// half the time: once `product.purchase()` returns `.success`, Apple has
    /// taken the money and only our own report can still fail. Those two live in
    /// `grantPending` and `notAccepted` below, and the split is the point.
    static let purchaseFailed = "Couldn’t reach the App Store. Nothing was charged — try again in a moment."

    /// Phase two, retryable: Apple charged, our server did not answer. The
    /// transaction is deliberately NOT finished, so `Transaction.updates`
    /// re-delivers it at the next launch — which is what "automatically" means.
    static let grantPending =
        "Your purchase went through, but Kaleidoscope couldn’t record it just now. "
        + "It will unlock automatically — or tap Restore purchase to try again."

    /// Phase two, permanent: the server verified the signature and refused the
    /// transaction anyway (wrong environment, revoked, wrong account). Retrying
    /// will never change the answer, so the copy must not promise it will.
    static let notAccepted =
        "This purchase couldn’t be verified for this account. If you were charged, "
        + "contact support and we’ll sort it out."

    /// Ask to Buy, or any other deferred approval.
    static let pending = "Waiting for approval. Plus unlocks as soon as the purchase is approved."

    static let unavailable = "The App Store isn’t available right now. Nothing was charged — try again in a moment."

    /// `appAccountToken` is a `UUID` and a server user id is a `crypto.randomUUID()`.
    /// If one ever is not, the purchase must NOT go ahead: without the token the
    /// server cannot bind the receipt and answers `wrong_account`, which is the
    /// paid-and-not-granted direction.
    static let accountUnusable =
        "This account can’t be linked to a purchase. Sign out and back in, then try again."

    static let terms = "Terms"
    static let privacy = "Privacy"
    static let termsURL = URL(string: "https://ponderance.dev/terms")!
    static let privacyURL = URL(string: "https://ponderance.dev/privacy")!

    /// "One-time purchase of <displayPrice>." — interpolated, never typed out,
    /// so a unit test can prove the label carries the price it was handed rather
    /// than a baked-in copy of it. (No example price appears even in this
    /// comment: `test/unit/plus-state.test.ts` scans every `ios/**/*.swift` as
    /// raw text and does not exempt comments.)
    static func priceFootnote(_ price: String) -> String { "One-time purchase of \(price)." }
    static func unlockLabel(_ price: String) -> String { "Unlock for \(price)" }
    /// The account row's mono counter, e.g. "7 of 10 public posts".
    static func publicPostsLine(count: Int, cap: Int) -> String { "\(count) of \(cap) public posts" }
    /// The meter's right-hand readout, e.g. "9 of 10".
    static func meterReadout(count: Int, cap: Int) -> String { "\(count) of \(cap)" }
}

// ---- what the Worker's answer means ---------------------------------------

/// How `POST /api/billing/apple` answering maps onto the sheet, and — the half
/// that costs money if it is wrong — whether the StoreKit transaction may be
/// finished.
///
/// A finished transaction stops arriving on `Transaction.updates`. For a
/// non-consumable it stays in `currentEntitlements` forever, so Restore can
/// always recover it by hand; but the AUTOMATIC recovery is the updates stream,
/// and finishing a transaction whose report failed on a network blip throws that
/// away silently. So: finish only when the answer cannot change.
struct ReportVerdict: Equatable {
    /// Nil means the server granted the entitlement.
    let outcome: PlusOutcome?
    let mayFinish: Bool
}

func reportVerdict(for error: AuthError?) -> ReportVerdict {
    guard let error else { return ReportVerdict(outcome: nil, mayFinish: true) }

    switch error.status {
    // The session died mid-flight. Signing back in and relaunching re-delivers
    // the transaction, so keep it unfinished.
    case 401:
        return ReportVerdict(outcome: .signIn, mayFinish: false)

    // `bound_elsewhere` is the one 409 with its own state and its own action.
    // The status alone must not trigger it, or a future 409 silently tells a
    // user their purchase belongs to a stranger.
    case 409 where error.code == "bound_elsewhere":
        return ReportVerdict(outcome: .boundElsewhere, mayFinish: true)

    case 429:
        return ReportVerdict(outcome: .error(PlusCopy.rateLimited), mayFinish: false)

    // A 400 is `checkTransaction` refusing: wrong_environment (a Sandbox
    // transaction from a non-admin — the gate that stands between TestFlight and
    // free Plus), wrong_bundle, wrong_product, revoked, not_purchased,
    // wrong_account. None of them can come out differently on a retry.
    case .some(let s) where (400..<500).contains(s):
        return ReportVerdict(outcome: .error(PlusCopy.notAccepted), mayFinish: true)

    // 5xx, `not_configured`, or no status at all (offline, DNS, a TLS refusal).
    // All transient by assumption, all left unfinished so the next launch tries
    // again on its own.
    default:
        return ReportVerdict(outcome: .error(PlusCopy.grantPending), mayFinish: false)
    }
}
