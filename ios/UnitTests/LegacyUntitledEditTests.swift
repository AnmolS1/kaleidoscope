import XCTest
@testable import Kaleidoscope

/// A legacy "Untitled" piece must still be re-editable.
///
/// The Worker validates `title` ONLY when the body carries one — deliberately,
/// so a visibility-only edit on one of the old rows keeps working (PLAN §2.3).
/// The client defeated that by always sending the title: the edit form seeds
/// from the stored title, so a piece literally named "Untitled" opened already
/// invalid, with Save disabled and no route to its visibility at all.
///
/// Latent today, because legacy rows carry a null `content_hash` and never come
/// back as `mine` — the T02c backfill is what makes it reachable.
final class LegacyUntitledEditTests: XCTestCase {
    private let legacy = "Untitled"

    func testAnUnchangedRefusedTitleIsOmittedRatherThanRefused() {
        let patch = titlePatch(id: "a1", title: legacy, visibility: .private, storedTitle: legacy)
        XCTAssertNotNil(patch, "a visibility-only edit must still go out")
        XCTAssertNil(patch?.title, "an unchanged title is omitted, so the Worker never judges it")
        XCTAssertEqual(patch?.visibility, "private")
    }

    /// Control: the omission is keyed on being UNCHANGED, not on the title being
    /// "Untitled". Typing that name afresh is still refused.
    func testTypingUntitledOverADifferentNameIsStillRefused() {
        XCTAssertNil(titlePatch(id: "a1", title: legacy, visibility: .public,
                                storedTitle: "Dawn Bloom"),
                     "changing a good title TO a refused one must still be refused")
    }

    /// Control: a real edit still carries the title.
    func testAChangedTitleIsStillSent() {
        let patch = titlePatch(id: "a1", title: "Ember Lattice", visibility: .public,
                               storedTitle: legacy)
        XCTAssertEqual(patch?.title, "Ember Lattice")
    }

    /// Whitespace is not a change — otherwise a stray space would resurrect the
    /// dead end by making the title look edited.
    func testWhitespaceOnlyDifferenceCountsAsUnchanged() {
        let patch = titlePatch(id: "a1", title: "  \(legacy) ", visibility: .unlisted,
                               storedTitle: legacy)
        XCTAssertNil(patch?.title)
    }
}
