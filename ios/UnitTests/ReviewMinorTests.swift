import XCTest
import KaleidoEngine
@testable import Kaleidoscope

/// REVIEW.md minor list, iOS half. Each case is a defect that was reachable and
/// is now not, with the control that says the fix did not overshoot.
final class ReviewMinorTests: XCTestCase {

    // MARK: mI1 — the document refuses a stroke on a hidden layer

    /// The refusal used to live only in `StudioModel.commit`, the one caller
    /// that happened to check. The web puts it in the document, because it is
    /// the document's invariant: a stroke nobody could see being drawn and
    /// nobody would find afterwards.
    func testCommitStrokeRefusesAHiddenActiveLayer() {
        var doc = DrawingDoc()
        let id = doc.activeLayerId
        let stroke = Stroke(tool: .solid, color: "#E84A27", size: 6, opacity: 1,
                            pts: [StrokePoint(x: 0, y: 0, pressure: 1)])

        XCTAssertTrue(doc.commitStroke(stroke), "CONTROL: a visible layer accepts")
        XCTAssertEqual(doc.drawing.layers[0].strokes.count, 1)

        doc.setLayerVisible(id, false)
        XCTAssertFalse(doc.commitStroke(stroke), "hidden: refused")
        // And refused means REFUSED — not "committed and hidden".
        XCTAssertEqual(doc.drawing.layers[0].strokes.count, 1)

        doc.setLayerVisible(id, true)
        XCTAssertTrue(doc.commitStroke(stroke), "CONTROL: showing it again accepts")
        XCTAssertEqual(doc.drawing.layers[0].strokes.count, 2)
    }

    // MARK: mI5 — the Manage menu stops offering a choice the server refuses

    func testManageVisibilitiesDropsPublicAtTheCap() {
        XCTAssertEqual(manageVisibilities(current: "private", capReached: false), Visibility.allCases)
        XCTAssertFalse(manageVisibilities(current: "private", capReached: true).contains(.public))
        XCTAssertFalse(manageVisibilities(current: "unlisted", capReached: true).contains(.public))
        // THE EXCEPTION: a piece that is already public must still show that it
        // is, or the control displaying its state omits its state.
        XCTAssertTrue(manageVisibilities(current: "public", capReached: true).contains(.public))
    }

    // MARK: mI8 — a deduped save is not an ordinary save

    /// 200 `deduped` means the server handed back an existing piece and wrote
    /// nothing, so the title and visibility just chosen were NOT applied. The
    /// flag was decoded and discarded, and the sheet dismissed reporting a save.
    func testADedupedPostLandsInSelfUnchangedRatherThanDismissing() {
        let input = SaveStateInput(
            signedIn: true,
            visibleStrokes: 3,
            preflight: .done(HashLookup(mine: nil, other: nil)),
            post: .deduped(id: "abc"),
            titleInvalid: false,
            capReached: false,
            remixOfOwnChanged: false
        )
        // The state that offers "Open it" and "Edit title & visibility" — the
        // second being the only route to the rename the save did not make.
        XCTAssertEqual(resolveSaveState(input), .selfUnchanged)
    }

    func testControlAnOrdinarySaveIsNotSelfUnchanged() {
        let input = SaveStateInput(
            signedIn: true,
            visibleStrokes: 3,
            preflight: .done(HashLookup(mine: nil, other: nil)),
            post: nil,
            titleInvalid: false,
            capReached: false,
            remixOfOwnChanged: false
        )
        XCTAssertEqual(resolveSaveState(input), .first)
    }

    // MARK: mI2 — one cap string, and it prints the COUNT

    /// ArtworkView carried its own copy that read the CAP into both halves of
    /// "N of M", so a user 9 pieces into a limit of 10 was told "10 of 10".
    func testPatchCapNotePrintsTheCountNotTheCapTwice() {
        let note = patchCapNote(count: 9, cap: 10, plusEnabled: false)
        XCTAssertTrue(note.contains("9 of 10"), note)
        XCTAssertFalse(note.contains("10 of 10"), note)
        XCTAssertFalse(note.contains("Plus"), "no offer while the surface is dark")

        XCTAssertTrue(patchCapNote(count: 10, cap: 10, plusEnabled: true).contains("Plus"))
    }
}
