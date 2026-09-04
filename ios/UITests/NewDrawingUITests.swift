import XCTest

/// "New drawing" is the only way out of a remix.
///
/// `clear()` removes strokes and keeps everything else — layers, names,
/// symmetry, and the remix link. Nothing cleared the link, so after tapping
/// Remix the save sheet said "Remix of your ___" forever: "there doesn't seem to
/// be a way other than quitting the app fully and reopening".
final class NewDrawingUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testNewDrawingResetsTheCanvasAndTheLayerStack() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launchEnvironment["KALEIDO_LAYER_CAP"] = "8"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))

        // The demo seeds three layers and strokes. That the run STARTS at three
        // is the other test's job — opening and closing the sheet here just to
        // re-assert it made this one about sheet dismissal timing instead of
        // about New drawing.
        app.buttons["More"].firstMatch.tap()
        // A Menu's items land in their own presentation, so wait rather than
        // assume they are in the tree the instant the button is tapped.
        let menuItem = app.buttons["New drawing"].firstMatch
        XCTAssertTrue(menuItem.waitForExistence(timeout: 5), "no New drawing item in the More menu")
        menuItem.tap()
        // Destructive, so it asks first — the dialog's own button confirms.
        let confirm = app.buttons["New drawing"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no confirmation dialog")
        confirm.tap()

        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Layers, 1 of 8"].waitForExistence(timeout: 5),
                      "a new drawing is one layer")
        XCTAssertTrue(app.staticTexts["Layer 1"].waitForExistence(timeout: 3))

        // And the canvas is empty — the value carries the stroke count.
        app.buttons["Layers"].firstMatch.tap()
        let canvas = app.otherElements["Drawing canvas"].firstMatch
        XCTAssertTrue((canvas.value as? String ?? "").contains("0 strokes"),
                      "expected an empty canvas, got \(canvas.value ?? "nil")")
    }

    func testCancelLeavesEverythingAlone() {
        // The control: a destructive action that cannot be backed out of is a
        // different bug from the one being fixed.
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))

        app.buttons["More"].firstMatch.tap()
        let menuItem = app.buttons["New drawing"].firstMatch
        XCTAssertTrue(menuItem.waitForExistence(timeout: 5))
        menuItem.tap()
        let cancel = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "no Cancel in the dialog")
        cancel.tap()

        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Layers, 3 of 8"].waitForExistence(timeout: 5),
                      "cancelling must not touch the stack")
    }
}
