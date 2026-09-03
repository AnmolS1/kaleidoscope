import XCTest

/// Captures the phone's symmetry sheet so its resting height can be LOOKED at.
///
/// One resting detent (0.34) was used for every card. It was sized for the
/// brush; the symmetry card is a ~260pt dial plus a title row, a readout and a
/// full-width button, so it opened cramped with its header crowding the drag
/// indicator — "the symmetry popup is a little too short, it should nicely show
/// the title".
///
/// 🔴 THERE IS NO ASSERTION HERE ON PURPOSE. Three attempts at one all passed
/// against a deliberately-reverted detent: `exists` cannot see crowding,
/// `isHittable` stayed true either way, and the sheet's bounds are not in the
/// accessibility tree to measure a frame against — the one query that looked
/// like it worked was matching a "Symmetry" label from the rail instead. A test
/// that cannot fail is worse than none, so this captures the frame and the
/// judgement stays with a human.
final class PanelSheetUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testCaptureTheSymmetrySheetAtRest() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))

        // The phone route: Layers, then the row's symmetry line. There is no
        // rail at this size class.
        app.buttons["Layers"].firstMatch.tap()
        let symLine = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Symmetry for '")
        ).firstMatch
        XCTAssertTrue(symLine.waitForExistence(timeout: 5), "no per-layer symmetry control")
        symLine.tap()

        // The sheet's own controls, so the capture is of a sheet that opened.
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Apply to all layers'"))
                .firstMatch.waitForExistence(timeout: 5),
            "the symmetry sheet did not open")

        let att = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        att.name = "symmetry-sheet-at-rest"
        att.lifetime = .keepAlways
        add(att)
    }
}
