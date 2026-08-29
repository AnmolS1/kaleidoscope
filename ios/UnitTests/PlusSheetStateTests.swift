import XCTest
@testable import Kaleidoscope

/// DESIGN.md §5 is "one sheet, six states"; this build ships eight. Eight states
/// means eight tests: "the sheet appeared" is true in all eight, so it
/// discriminates nothing. Each case below names the state it reaches AND is
/// written so that deleting that state's rung from `resolvePlusSheet` makes it
/// fail.
final class PlusSheetStateTests: XCTestCase {

    // MARK: reachability — every state, driven off the type itself

    /// One row per `PlusSheetKind`. Driven off `allCases` rather than a
    /// hand-written list, so a ninth state added to the enum without a row here
    /// is a red test rather than a silence.
    private static let table: [PlusSheetKind: PlusSheetInput] = [
        .before: PlusSheetInput(),
        .purchasing: PlusSheetInput(busy: true),
        .purchased: PlusSheetInput(owned: true),
        .signIn: PlusSheetInput(signedIn: false),
        .restoreNone: PlusSheetInput(outcome: .restoreNone),
        .boundElsewhere: PlusSheetInput(outcome: .boundElsewhere),
        .error: PlusSheetInput(outcome: .error("boom")),
        .unavailable: PlusSheetInput(loadFailed: true),
    ]

    func testEveryStateIsReachable() {
        for kind in PlusSheetKind.allCases {
            guard let input = Self.table[kind] else {
                XCTFail("\(kind.rawValue) has no reachability proof — add a row to `table`")
                continue
            }
            XCTAssertEqual(resolvePlusSheet(input), kind, "\(kind.rawValue) is unreachable")
        }
        XCTAssertEqual(Self.table.count, PlusSheetKind.allCases.count)
    }

    // MARK: precedence — the order, not just the rungs

    func testAnOutcomeOutranksBusy() {
        // Otherwise the answer to what the user just asked is hidden behind a
        // spinner that will never resolve again.
        XCTAssertEqual(
            resolvePlusSheet(PlusSheetInput(busy: true, outcome: .purchased)), .purchased)
    }

    func testASignedOutUserIsAskedToSignInEvenMidFlight() {
        XCTAssertEqual(
            resolvePlusSheet(PlusSheetInput(signedIn: false, owned: true)), .signIn)
    }

    func testAnOwnerNeverSeesTheStoreBeingDown() {
        // `unavailable` sits BELOW `owned` on purpose: an account that already
        // holds Plus has no business being told the App Store is unreachable,
        // and on a cold launch the product load and `/api/me` race.
        XCTAssertEqual(
            resolvePlusSheet(PlusSheetInput(owned: true, loadFailed: true)),
            .purchased)
    }

    func testAStillLoadingProductIsNotAnOutage() {
        // The load is in the air, so there is no price yet — and the sheet must
        // NOT accuse the App Store of being down for the moment before it
        // answers. It shows the pitch with a disabled button instead
        // (`PlusSheet.unlockButton` reads the price directly). Only a load that
        // FINISHED empty reaches `.unavailable`, which is the row above.
        XCTAssertEqual(resolvePlusSheet(PlusSheetInput(loadFailed: false)), .before)
    }

    // MARK: 🔴 the entitlement source

    func testOwnershipComesFromTheServerBlockAndNothingElse() {
        // Nil is "we have not been told", not "yes". It fails closed.
        XCTAssertFalse(PlusSheetInput.owned(from: nil))
        XCTAssertFalse(PlusSheetInput.owned(from: plusState(active: false)))
        XCTAssertTrue(PlusSheetInput.owned(from: plusState(active: true)))
    }

    func testEnabledFalseDoesNotByItselfRevokeAnEntitlement() {
        // The `enabled` flag hides the SURFACE (see `YouView.plusSection`); it is
        // not a claim about what the user owns. Conflating the two would strip
        // Plus from a paying user the moment the flag was flipped for a rollout.
        XCTAssertTrue(PlusSheetInput.owned(from: plusState(active: true, enabled: false)))
    }

    // MARK: reportVerdict — the outcome AND whether the transaction may be finished

    func testTheVerdictTableIsExactlyWhatTheWorkerCanAnswer() {
        let rows: [(String, AuthError?, PlusOutcome?, Bool)] = [
            ("200 granted", nil, nil, true),
            ("401 session died", .api(status: 401, body: nil), .signIn, false),
            ("409 bound_elsewhere",
             .api(status: 409, body: APIErrorBody(error: "bound_elsewhere", message: nil, of: nil, cap: nil, count: nil)),
             .boundElsewhere, true),
            // The status alone must not trigger `bound_elsewhere`, or every
            // future 409 silently tells a user their purchase belongs to a
            // stranger.
            ("409 something else",
             .api(status: 409, body: APIErrorBody(error: "duplicate", message: nil, of: nil, cap: nil, count: nil)),
             .error(PlusCopy.notAccepted), true),
            ("429 rate limited", .api(status: 429, body: nil), .error(PlusCopy.rateLimited), false),
            // 🔴 The gate that stands between a TestFlight build and free Plus:
            // a Sandbox transaction from a non-admin comes back 400
            // `wrong_environment`, and it can never come out differently.
            ("400 wrong_environment",
             .api(status: 400, body: APIErrorBody(error: "wrong_environment", message: nil, of: nil, cap: nil, count: nil)),
             .error(PlusCopy.notAccepted), true),
            ("400 wrong_account",
             .api(status: 400, body: APIErrorBody(error: "wrong_account", message: nil, of: nil, cap: nil, count: nil)),
             .error(PlusCopy.notAccepted), true),
            ("503 not_configured", .api(status: 503, body: nil), .error(PlusCopy.grantPending), false),
            ("offline", .network, .error(PlusCopy.grantPending), false),
            ("undecodable body", .decoding, .error(PlusCopy.grantPending), false),
        ]
        for (name, error, outcome, mayFinish) in rows {
            let verdict = reportVerdict(for: error)
            XCTAssertEqual(verdict.outcome, outcome, name)
            XCTAssertEqual(verdict.mayFinish, mayFinish, "\(name): mayFinish")
        }
    }

    func testFinishingIsDecidedInBOTHDirections() {
        // A mutation that always finishes and one that never finishes each break
        // something, and each breaks something different — so neither can pass by
        // agreeing with a one-sided assertion.
        //
        // Always-finish: a network blip finishes the transaction, `Transaction.updates`
        // never re-delivers it, and a paid user is left to find "Restore" by hand.
        XCTAssertFalse(reportVerdict(for: .network).mayFinish)
        // Never-finish: a purchase the server has permanently refused arrives
        // again on every single launch, forever.
        XCTAssertTrue(reportVerdict(for: .api(
            status: 409,
            body: APIErrorBody(error: "bound_elsewhere", message: nil, of: nil, cap: nil, count: nil)
        )).mayFinish)
    }

    func testThePaidAndUnpaidFailuresDoNotShareCopy() {
        // The web's one generic error says "Nothing was charged" and can, because
        // a failed redirect never charges. On iOS that sentence is true only
        // before `purchase()` returns `.success` — after it, Apple has the money.
        // Three distinct messages, and a test that they stay distinct.
        XCTAssertTrue(PlusCopy.purchaseFailed.contains("Nothing was charged"))
        XCTAssertFalse(PlusCopy.grantPending.contains("Nothing was charged"))
        XCTAssertFalse(PlusCopy.notAccepted.contains("Nothing was charged"))
        // Retryable says it will sort itself out; permanent must NOT.
        XCTAssertTrue(PlusCopy.grantPending.contains("automatically"))
        XCTAssertFalse(PlusCopy.notAccepted.contains("automatically"))
        XCTAssertEqual(Set([PlusCopy.purchaseFailed, PlusCopy.grantPending, PlusCopy.notAccepted]).count, 3)
    }

    // MARK: copy — 3.1.1, and the price

    /// Every string the sheet can put on screen. Kept as one list so the two
    /// scans below are a review of the whole surface rather than of whatever
    /// happened to be remembered.
    private var visibleCopy: [String] {
        [
            PlusCopy.title, PlusCopy.purchased, PlusCopy.purchasedTitle, PlusCopy.backToCanvas,
            PlusCopy.restoreNone, PlusCopy.boundElsewhere, PlusCopy.switchAccount,
            PlusCopy.signIn, PlusCopy.signInCTA, PlusCopy.restore, PlusCopy.unlocking,
            PlusCopy.unlockNoPrice, PlusCopy.rateLimited, PlusCopy.purchaseFailed,
            PlusCopy.grantPending, PlusCopy.notAccepted, PlusCopy.pending, PlusCopy.unavailable,
            PlusCopy.accountUnusable, PlusCopy.terms, PlusCopy.privacy,
            PlusCopy.priceFootnote("<price>"), PlusCopy.unlockLabel("<price>"),
            PlusCopy.publicPostsLine(count: 7, cap: 10), PlusCopy.meterReadout(count: 9, cap: 10),
        ] + PlusCopy.features.flatMap { [$0.0, $0.1] }
    }

    func testNoCopyOnThisSheetPointsAtTheWeb() {
        // App Review 3.1.1: an iOS build must not steer a buyer at another
        // purchasing mechanism. DESIGN.md §5's frames say "on web and iOS" in
        // three places and those mentions are deliberately dropped — this is what
        // stops one being typed back in.
        let banned = ["web", "browser", "online", "ponderance.dev", "kaleidoscope.ponderance"]
        for text in visibleCopy {
            let lowered = text.lowercased()
            for word in banned {
                XCTAssertFalse(lowered.contains(word), "\"\(text)\" mentions \"\(word)\"")
            }
        }
        // The control: the scan can actually see the strings it is scanning.
        XCTAssertGreaterThan(visibleCopy.count, 25)
        XCTAssertTrue(visibleCopy.contains { $0.lowercased().contains("apple id") })
    }

    func testNoPriceIsEverTypedOut() {
        // The price comes from `product.displayPrice`. `test/unit/plus-state.test.ts`
        // globs `ios/**` and enforces the same rule over the whole tree; this is
        // the same assertion where a Swift reader will meet it.
        //
        // ⚠️ Every price-shaped string below is assembled from `\u{24}` rather
        // than typed. That web guard reads these files as RAW TEXT — a realistic
        // example in a test or even in a comment is a hit, and the guard cannot
        // tell an example from a leak.
        let priceShaped = try! NSRegularExpression(pattern: #"[$£€]\s?\d+[.,]\d{2}"#)
        for text in visibleCopy {
            let range = NSRange(text.startIndex..., in: text)
            XCTAssertNil(priceShaped.firstMatch(in: text, range: range), "price literal in \"\(text)\"")
        }
        // Control: the regex does match a price, so a clean scan means something.
        let sample = "One-time purchase of \u{24}4.99."
        XCTAssertNotNil(priceShaped.firstMatch(in: sample, range: NSRange(sample.startIndex..., in: sample)))
    }

    func testPriceCopyIsInterpolatedAndNotTypedTwice() {
        // Passing a price that is NOT the real one is the point: asserting the
        // real price passes just as well when the label has it baked in.
        let price = "\u{24}9.99"
        XCTAssertEqual(PlusCopy.unlockLabel(price), "Unlock for \(price)")
        XCTAssertEqual(PlusCopy.priceFootnote(price), "One-time purchase of \(price).")
        XCTAssertEqual(PlusCopy.publicPostsLine(count: 7, cap: 10), "7 of 10 public posts")
        XCTAssertFalse(PlusCopy.unlockNoPrice.contains("\u{24}"))
    }

    // MARK: helper

    private func plusState(active: Bool, enabled: Bool = true) -> PlusState {
        PlusState(active: active, sources: active ? ["apple"] : [],
                  publicCount: 3, publicCap: 10, layerCap: active ? 8 : 3, enabled: enabled)
    }
}
