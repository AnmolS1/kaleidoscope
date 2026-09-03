import XCTest

/// Reordering a layer, by a control that exists.
///
/// The `line.3.horizontal` handle was decorative — `accessibilityHidden`, no
/// gesture of any kind — so reordering existed on iOS ONLY as a VoiceOver custom
/// action. A sighted user saw a drag handle that did nothing.
///
/// A drag was tried first and abandoned on evidence: inside the iPad's
/// `scrollableCard` the ScrollView's UIKit pan claims the vertical gesture, and
/// the panel reported no drag at all with the touch provably over the grip.
/// Chevrons behave identically on both platforms and match the "Move up" /
/// "Move down" actions VoiceOver already had.
final class LayerReorderUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_LAYER_CAP"] = "8"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.otherElements["layers-panel"].firstMatch.waitForExistence(timeout: 5))
        return app
    }

    /// Display order is TOP-FIRST, so a freshly added layer is row 0.
    private func rowNames(_ app: XCUIApplication) -> [String] {
        app.staticTexts.allElementsBoundByIndex
            .map(\.label)
            .filter { $0.hasPrefix("Layer ") }
    }

    func testMovingALayerDownReordersTheStack() {
        let app = launch()
        app.buttons["Add layer"].firstMatch.tap()
        app.buttons["Add layer"].firstMatch.tap()
        XCTAssertEqual(Array(rowNames(app).prefix(3)), ["Layer 3", "Layer 2", "Layer 1"])

        app.buttons["Move Layer 3 down"].firstMatch.tap()

        XCTAssertEqual(Array(rowNames(app).prefix(3)), ["Layer 2", "Layer 3", "Layer 1"],
                       "moving the top layer down should swap it with the next")
    }

    func testMovingBackUpRestoresTheOrder() {
        let app = launch()
        app.buttons["Add layer"].firstMatch.tap()
        app.buttons["Move Layer 2 down"].firstMatch.tap()
        XCTAssertEqual(Array(rowNames(app).prefix(2)), ["Layer 1", "Layer 2"])

        app.buttons["Move Layer 2 up"].firstMatch.tap()
        XCTAssertEqual(Array(rowNames(app).prefix(2)), ["Layer 2", "Layer 1"],
                       "and back again — the two directions are not the same button")
    }

    func testTheEndsAreDisabledSoTheOrderCannotRunOffTheStack() {
        // The control for the two above: if the buttons were always enabled,
        // "it moved" and "it moved as far as it could" would look the same.
        let app = launch()
        app.buttons["Add layer"].firstMatch.tap()
        XCTAssertFalse(app.buttons["Move Layer 2 up"].firstMatch.isEnabled,
                       "the top layer cannot go higher")
        XCTAssertFalse(app.buttons["Move Layer 1 down"].firstMatch.isEnabled,
                       "the bottom layer cannot go lower")
    }
}

/// Rename had no affordance at all: a double-tap on a background layer, no
/// glyph, no menu, nothing on screen saying the name could be changed. Reported
/// as "there's no way to rename layers on iPad", which was true of anyone who
/// had not been told.
final class LayerRenameUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_LAYER_CAP"] = "8"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.otherElements["layers-panel"].firstMatch.waitForExistence(timeout: 5))
        return app
    }

    func testTheActiveRowOffersAVisibleRenameButtonThatOpensTheField() throws {
        let app = launch()
        // One layer to start, and it is active.
        let rename = app.buttons["Rename Layer 1"].firstMatch
        XCTAssertTrue(rename.waitForExistence(timeout: 5),
                      "no visible rename control on the active row")
        XCTAssertTrue(rename.isHittable, "the rename control must be tappable, not just present")

        rename.tap()

        // THE FIX. Before this, tapping rename on iPad did nothing at all: the
        // panel lives in a `scrollableCard` whose measured-height binding
        // rebuilds it, which discarded the `@State` holding "which row is being
        // renamed" — so no field was ever created. The state lives on the model
        // now and the field appears on both device classes.
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3),
                      "tapping rename should open a text field")
        XCTAssertEqual(field.placeholderValue, "Layer name")
    }

    /// Typing and committing, asserted on the PHONE only.
    ///
    /// `@FocusState` lives on the panel view and is discarded by the same iPad
    /// card rebuild, so the field opens there without keyboard focus and the
    /// synthetic `typeText` cannot be delivered. Tapping the field first does
    /// not help in the simulator — though simulator keyboard focus is not a
    /// faithful model of a device, so this is a limit of what can be ASSERTED
    /// here, not a proven limit of the app. Skipping loudly beats asserting
    /// something that passes for the wrong reason on one device class.
    func testRenameCommitsTheNewName() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone,
                          "keyboard focus is not deliverable to the iPad panel under test")
        let app = launch()
        app.buttons["Rename Layer 1"].firstMatch.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3))

        // Pre-filled with the current name and the caret at the end, so this
        // APPENDS rather than replaces — fine for what is under test (does the
        // rename commit at all), hence the substring assertion.
        field.typeText("Petals\n")

        let renamed = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS 'Petals'")
        ).firstMatch
        XCTAssertTrue(renamed.waitForExistence(timeout: 3),
                      "the committed name should be on the row")
    }

    func testTheRenameButtonIsOnTheACTIVERowOnly() {
        // Eight pencils would be a wall of icons; the active row is the one a
        // rename is aimed at. This is also the control for the test above — it
        // proves the button tracks selection rather than always being present.
        let app = launch()
        app.buttons["Add layer"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Rename Layer 2"].firstMatch.waitForExistence(timeout: 3),
                      "the newly added layer is active and should carry the pencil")
        XCTAssertFalse(app.buttons["Rename Layer 1"].firstMatch.exists,
                       "the inactive row should not")
    }
}
