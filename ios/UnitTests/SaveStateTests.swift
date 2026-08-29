import XCTest
@testable import Kaleidoscope

/// DESIGN.md §4 is "one dialog, eleven states". Eleven states means eleven
/// tests: "the sheet appeared" is true in all eleven, so it discriminates
/// nothing. Each case below names the state it reaches AND is written so that
/// deleting that state's rung from `resolveSaveState` makes it fail.
final class SaveStateTests: XCTestCase {
    // MARK: the eleven, one at a time

    func testSignedOutOutranksEverything() {
        // Also the reachability proof for the rung's PRECEDENCE: every other
        // trigger is switched on at once, and signed-out still wins. Deleting
        // the rung yields `.nothingVisible`, not `.signedOut`.
        let s = resolveSaveState(SaveStateInput(
            signedIn: false, visibleStrokes: 0,
            preflight: .done(HashLookup(mine: "a", other: nil)),
            post: .failed, titleInvalid: true, capReached: true, remixOfOwnChanged: true))
        XCTAssertEqual(s, .signedOut)
    }

    func testNothingVisibleWhenAllInkIsHidden() {
        // The discriminator: the drawing is NOT empty by total stroke count —
        // this input is what a canvas full of ink on a hidden layer produces.
        let s = resolveSaveState(SaveStateInput(visibleStrokes: 0, post: .failed, capReached: true))
        XCTAssertEqual(s, .nothingVisible)
    }

    func testFirstIsTheOrdinaryForm() {
        XCTAssertEqual(resolveSaveState(SaveStateInput()), .first)
    }

    func testTitleErrorWhenTheTitleIsRefused() {
        XCTAssertEqual(resolveSaveState(SaveStateInput(titleInvalid: true)), .titleError)
    }

    func testSelfChangedWhenRemixingOwnPiece() {
        XCTAssertEqual(resolveSaveState(SaveStateInput(remixOfOwnChanged: true)), .selfChanged)
    }

    func testAtCapOutranksTitleAndRemix() {
        // Not just "at cap reaches at-cap": at the cap the primary button does
        // something ELSE (posts unlisted), so it must outrank both garnish
        // rungs. Swapping the cap rung below `titleInvalid` fails here.
        XCTAssertEqual(
            resolveSaveState(SaveStateInput(titleInvalid: true, capReached: true, remixOfOwnChanged: true)),
            .atCap)
    }

    func testSelfUnchangedFromPreflight() {
        let s = resolveSaveState(SaveStateInput(preflight: .done(HashLookup(mine: "abc", other: nil))))
        XCTAssertEqual(s, .selfUnchanged)
    }

    func testOtherUnchangedFromPreflight() {
        let other = HashOther(id: "z", title: "Dawn Bloom", author: "Priya")
        let s = resolveSaveState(SaveStateInput(preflight: .done(HashLookup(mine: nil, other: other))))
        XCTAssertEqual(s, .otherUnchanged)
    }

    func testDuplicateOtherFromPost() {
        XCTAssertEqual(resolveSaveState(SaveStateInput(post: .duplicateOther(of: "z"))), .duplicateOther)
    }

    func testDuplicateOtherPrivateFromPost() {
        // The distinguishing test for the pair: identical inputs apart from
        // `of`. A resolver that collapsed the two 409 shapes passes the case
        // above and fails this one.
        XCTAssertEqual(resolveSaveState(SaveStateInput(post: .duplicateOtherPrivate)), .duplicateOtherPrivate)
        XCTAssertNotEqual(resolveSaveState(SaveStateInput(post: .duplicateOtherPrivate)), .duplicateOther)
    }

    func testErrorFromPost() {
        XCTAssertEqual(resolveSaveState(SaveStateInput(post: .failed)), .error)
    }

    func testAtCapFromA201CapReached() {
        // The eleventh state has TWO entrances (DESIGN.md §4: "A 201 capReached
        // after the fact lands in this same state with the piece saved"), and
        // this is the one that only exists because the 201 body is decoded.
        let s = resolveSaveState(SaveStateInput(post: .capReached(id: "new", cap: 10, count: 10),
                                                capReached: false))
        XCTAssertEqual(s, .atCap)
    }

    // MARK: precedence facts that are easy to get backwards

    func testPostOutranksPreflight() {
        // The pre-flight ran before the user typed; the POST is newer. A
        // resolver that checked the pre-flight first would say `selfUnchanged`.
        let s = resolveSaveState(SaveStateInput(
            preflight: .done(HashLookup(mine: "mine", other: nil)),
            post: .duplicateOther(of: "z")))
        XCTAssertEqual(s, .duplicateOther)
    }

    func testPendingPreflightNeverRendersTheForm() {
        XCTAssertEqual(resolveSaveState(SaveStateInput(preflight: .pending)), .checking)
    }

    func testFailedPreflightFallsThroughToTheForm() {
        // A rate-limited lookup must not wedge the sheet shut on a save that
        // would have worked. `failed` is a THIRD value for this reason; folding
        // it into `pending` leaves the user staring at a spinner.
        XCTAssertEqual(resolveSaveState(SaveStateInput(preflight: .failed)), .first)
        XCTAssertEqual(resolveSaveState(SaveStateInput(preflight: .failed, titleInvalid: true)), .titleError)
    }

    func testEveryStateIsReachable() {
        // The whole point of resolving this away from the view: a state nobody
        // can reach looks exactly like a state that renders correctly and was
        // never opened. This asserts the outcome map is onto.
        let inputs: [SaveStateInput] = [
            SaveStateInput(preflight: .pending),
            SaveStateInput(signedIn: false),
            SaveStateInput(visibleStrokes: 0),
            SaveStateInput(preflight: .done(HashLookup(mine: "a", other: nil))),
            SaveStateInput(preflight: .done(HashLookup(mine: nil, other: HashOther(id: "b", title: "t", author: "p")))),
            SaveStateInput(post: .duplicateOther(of: "b")),
            SaveStateInput(post: .duplicateOtherPrivate),
            SaveStateInput(post: .failed),
            SaveStateInput(capReached: true),
            SaveStateInput(titleInvalid: true),
            SaveStateInput(remixOfOwnChanged: true),
            SaveStateInput(),
        ]
        XCTAssertEqual(Set(inputs.map(resolveSaveState)), Set(SaveStateKind.allCases))
    }

    // MARK: blocking + labels

    func testSaveBlockedExactlyWhereTheDialogSaysSo() {
        let table: [(SaveStateKind, Bool, Bool)] = [
            (.first, false, false),
            (.selfChanged, false, false),
            (.atCap, false, false),          // at the cap the save still HAPPENS, unlisted
            (.selfUnchanged, false, false),
            (.error, false, false),          // "Try again" must stay live
            (.otherUnchanged, false, true),
            (.duplicateOther, false, true),
            (.duplicateOtherPrivate, false, true),
            (.first, true, true),            // a bad title blocks from any state
        ]
        for (kind, titleInvalid, expected) in table {
            XCTAssertEqual(saveBlocked(kind, titleInvalid: titleInvalid), expected, "\(kind) titleInvalid=\(titleInvalid)")
        }
    }

    func testPrimaryLabelOrderIsNotCosmetic() {
        XCTAssertEqual(primaryLabel(.first, capReached: false, remixOfOwnChanged: false), "Save piece")
        XCTAssertEqual(primaryLabel(.selfChanged, capReached: false, remixOfOwnChanged: true), "Save as new")
        // At the cap the button genuinely posts unlisted, so that claim outranks
        // the remix hint. Reversing the two lines makes this fail.
        XCTAssertEqual(primaryLabel(.atCap, capReached: true, remixOfOwnChanged: true), "Save unlisted")
        XCTAssertEqual(primaryLabel(.error, capReached: true, remixOfOwnChanged: true), "Try again")
    }

    // MARK: title rule parity with the Worker

    func testTitleRuleMatchesValidateTitle() {
        XCTAssertTrue(titleIsInvalid(""))
        XCTAssertTrue(titleIsInvalid("   "))
        XCTAssertTrue(titleIsInvalid("Untitled"))
        XCTAssertTrue(titleIsInvalid("  untitled  "))
        // NFKC, not NFC. These are the compatibility lookalikes that walk past
        // a naive lowercase comparison and turn a designed dialog state into an
        // unexplained 400 from the Worker. Both were checked against the web's
        // `String.prototype.normalize("NFKC")` — the JS and ICU foldings agree.
        XCTAssertTrue(titleIsInvalid("\u{FF55}\u{FF4E}\u{FF54}\u{FF49}\u{FF54}\u{FF4C}\u{FF45}\u{FF44}"), "fullwidth ｕｎｔｉｔｌｅｄ")
        XCTAssertTrue(titleIsInvalid("unt\u{2170}tled"), "U+2170 SMALL ROMAN NUMERAL ONE for i")
        // The control: NFC would NOT fold either of the two above, so a title
        // rule written with `precomposedStringWithCanonicalMapping` passes the
        // plain cases and fails here. (The ﬁ ligature, which the web's comment
        // names, is not actually a spelling of "untitled" — it folds to
        // "unfitled" in both runtimes, so it is a valid title, asserted below.)
        XCTAssertFalse(titleIsInvalid("un\u{FB01}tled"), "ﬁ folds to `unfitled`, which is a real name")
        XCTAssertFalse(titleIsInvalid("Untitled Symphony"))
        XCTAssertFalse(titleIsInvalid("Dawn Bloom"))
    }

    // MARK: the cap note — a string nothing in a build can check

    func testCapNoteReadsAsSentencesInAllFourShapes() {
        // The bug this exists to catch: composing one shared tail onto two
        // different heads produced "Post this unlisted now, — then …" and
        // "(10 of 10). — then …". Both compile, both render, and both are
        // garbled — so the assertion has to be on the punctuation seams.
        for saved in [false, true] {
            for enabled in [false, true] {
                let note = capNote(count: 10, cap: 10, plusEnabled: enabled, alreadySaved: saved)
                XCTAssertTrue(capNoteReadsCleanly(note), "saved=\(saved) enabled=\(enabled): \(note)")
                // Every cap string offers the "make one private" exit, because
                // the cap is a CURRENT count and unpublishing frees a slot.
                XCTAssertTrue(note.contains("make an older piece private") || note.contains("Make an older piece private"),
                              "saved=\(saved) enabled=\(enabled) lost the unpublish exit")
                XCTAssertEqual(note.contains("Kaleidoscope Plus"), enabled,
                               "Plus must be named exactly when plus.enabled")
            }
        }
    }

    func testCapNoteMatchesTheDesignedString() {
        XCTAssertEqual(
            capNote(count: 10, cap: 10, plusEnabled: true, alreadySaved: false),
            "Your public wall is full (10 of 10). Post this unlisted now — then make an older piece private to free a slot, or get Kaleidoscope Plus for unlimited.")
    }

    func testTheSeamCheckerActuallyRejects() {
        // The control for the two tests above: a checker that returned true for
        // everything would pass them both.
        XCTAssertFalse(capNoteReadsCleanly("Post this unlisted now, — then make it private."))
        XCTAssertFalse(capNoteReadsCleanly("Full (10 of 10). — then make it private."))
        XCTAssertFalse(capNoteReadsCleanly("No trailing period"))
        XCTAssertTrue(capNoteReadsCleanly("A clean sentence — with a dash."))
    }

    // MARK: error-body decoding — the 409 split

    func testPostOutcomeSplitsTheTwo409Shapes() {
        let withOf = AuthError.api(status: 409, body: AuthClient.errorBody(
            #"{"error":"duplicate_of_other","of":"abc123"}"#.data(using: .utf8)!))
        XCTAssertEqual(postOutcome(from: withOf), .duplicateOther(of: "abc123"))

        // Same status, same code, no `of` — someone else's PRIVATE twin. If the
        // body were discarded (as `badResponse(409)` did), these two would be
        // indistinguishable and one of the eleven states unreachable.
        let withoutOf = AuthError.api(status: 409, body: AuthClient.errorBody(
            #"{"error":"duplicate_of_other"}"#.data(using: .utf8)!))
        XCTAssertEqual(postOutcome(from: withoutOf), .duplicateOtherPrivate)
    }

    func testKnownCodesNeverShowTheGenericMessage() {
        let generic = "Couldn't reach the gallery. Your drawing is safe here — try again in a moment."
        let known = ["title_required", "rate_limited", "render_too_large", "vector_too_large",
                     "too_many_strokes", "too_many_points", "too_many_layers", "server_misconfigured"]
        for code in known {
            let err = AuthError.api(status: 400, body: AuthClient.errorBody(
                "{\"error\":\"\(code)\"}".data(using: .utf8)!))
            XCTAssertNotEqual(saveErrorText(err), generic, "\(code) fell back to the generic message")
        }
        // The control: a code nobody has named DOES fall back, so the assertion
        // above is testing the mapping and not the string comparison.
        let unknown = AuthError.api(status: 418, body: AuthClient.errorBody(
            #"{"error":"teapot"}"#.data(using: .utf8)!))
        XCTAssertEqual(saveErrorText(unknown), generic)
    }

    func testRateLimitPrefersTheServersOwnCopy() {
        let err = AuthError.api(status: 429, body: AuthClient.errorBody(
            #"{"error":"rate_limited","message":"Whoa — slow down a little."}"#.data(using: .utf8)!))
        XCTAssertEqual(saveErrorText(err), "Whoa — slow down a little.")
    }

    func testAnUnparseableBodyKeepsTheStatus() {
        // An edge HTML error page must not be lost to a decoding failure.
        let err = AuthError.api(status: 502, body: AuthClient.errorBody(Data("<html>bad gateway</html>".utf8)))
        XCTAssertEqual(err.status, 502)
        XCTAssertNil(err.code)
        XCTAssertEqual(postOutcome(from: err), .failed)
    }
}
