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

    /// Runs on BOTH device classes. It used to skip on iPad, where the pencil
    /// drew, reported hittable, and never ran its action in the old row layout
    /// (verified with an in-action log: no call at all, while the eye and the
    /// symmetry chip in the same row fired). That layout is gone — every control
    /// is a 44pt target with no Spacer between them — and the pencil fires on
    /// iPad now. Why the old arrangement swallowed it was not pinned down.
    func testTheActiveRowOffersAVisibleRenameButtonThatOpensTheField() throws {
        let app = launch()
        // One layer to start, and it is active.
        let rename = app.buttons["Rename Layer 1"].firstMatch
        XCTAssertTrue(rename.waitForExistence(timeout: 5),
                      "no visible rename control on the active row")
        XCTAssertTrue(rename.isHittable, "the rename control must be tappable, not just present")

        rename.tap()

        // "Which row is being renamed" lives on the model, not in the panel's
        // `@State`, so the field survives anything that recreates the panel.
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3),
                      "tapping rename should open a text field")
        XCTAssertEqual(field.placeholderValue, "Layer name")
    }

    /// Typing and committing, on BOTH device classes.
    ///
    /// This skipped on iPad because focus never stayed in the field there. It
    /// did land — then the software keyboard shrank `StudioView`'s geometry
    /// until `height > width` flipped, the card moved to its landscape branch,
    /// and the panel (and its `@FocusState`) was recreated. Measured with an
    /// instrumented build: focus=true, then two panel recreations ~90ms later.
    /// `StudioView` ignores the keyboard safe area now.
    func testRenameCommitsTheNewName() throws {
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

/// The context-menu rename path, which is the one that works on both.
extension LayerRenameUITests {
    /// ONE tap on the pencil must leave the caret in the field, on both device
    /// classes — no second tap on the field. Typing without touching the field
    /// is the assertion: `typeText` fails outright when nothing has focus.
    func testOneTapOnThePencilFocusesTheField() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_LAYER_CAP"] = "8"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.otherElements["layers-panel"].firstMatch.waitForExistence(timeout: 5))

        let pencil = app.buttons["Rename Layer 1"].firstMatch
        XCTAssertTrue(pencil.waitForExistence(timeout: 5))
        pencil.tap()

        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3), "the pencil should open the field")
        let focused = NSPredicate(format: "hasKeyboardFocus == true")
        XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: focused, evaluatedWith: field)],
                                      timeout: 3), .completed,
                       "one tap on the pencil must put keyboard focus in the field")
        field.typeText("Petals\n")
        XCTAssertTrue(app.buttons["Select Layer 1Petals"].firstMatch.waitForExistence(timeout: 3),
                      "the typed name should commit to the row")
    }

    func testLongPressOffersRenameAndOpensTheField() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_LAYER_CAP"] = "8"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.otherElements["layers-panel"].firstMatch.waitForExistence(timeout: 5))

        app.buttons["Select Layer 1"].firstMatch.press(forDuration: 1.0)
        let item = app.buttons["Rename"].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5), "long press should offer Rename")
        item.tap()

        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 3),
                      "the context menu's Rename should open the field")
    }
}

/// "Tapping on layers to switch is difficult. I have to tap exactly in the
/// empty space between the layer name and the visibility toggle... these
/// locations are both too small and not clear to the user."
///
/// The select button wrapped only the thumbnail and the name; the flexible
/// space between the name and the trailing controls sat OUTSIDE it, so the
/// widest part of the row was dead. These tests tap that space and measure the
/// controls on whichever device class they run on — the phone's sheet picks
/// the one-line row and the iPad's 264pt card the two-line one, so both
/// arrangements are covered only by running on both.
final class LayerRowHitTargetUITests: XCTestCase {
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

    /// Waits for `el`'s frame to stop moving. The phone's sheet is still
    /// settling (scaled, mid-detent) right after a layer is added, and a frame
    /// read then is not where the pixels end up: an early version of this test
    /// computed the gap from a ~6%-scaled frame and its tap landed on the
    /// symmetry chip instead.
    private func settledFrame(_ el: XCUIElement) -> CGRect {
        var last = el.frame
        for _ in 0..<20 {
            Thread.sleep(forTimeInterval: 0.25)
            let now = el.frame
            if now == last { return now }
            last = now
        }
        return last
    }

    /// The leftmost trailing control on the same line as the layer's name.
    private func firstTrailingControl(nameMidY: CGFloat, in app: XCUIApplication,
                                      layer: String) -> XCUIElement {
        let candidates = ["Rename \(layer)", "Symmetry for \(layer)", "Opacity for \(layer)",
                          "Hide \(layer)", "Show \(layer)"]
            .map { app.buttons[$0].firstMatch }
            .filter { $0.exists && abs($0.frame.midY - nameMidY) < 12 }
        let first = candidates.min { $0.frame.minX < $1.frame.minX }
        XCTAssertNotNil(first, "no trailing control on the name line of \(layer)")
        return first!
    }

    func testTappingTheGapBetweenTheNameAndTheControlsSelectsTheLayer() {
        let app = launch()
        app.buttons["Add layer"].firstMatch.tap()
        // Layer 2 is now active and carries the pencil; Layer 1 does not.
        XCTAssertTrue(app.buttons["Rename Layer 2"].firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Rename Layer 1"].firstMatch.exists)

        // The name is folded into the select button's label, so the button's
        // own frame is the reference: its vertical centre is the name line.
        let select = app.buttons["Select Layer 1"].firstMatch
        XCTAssertTrue(select.exists)
        let y = settledFrame(select).midY
        let trailing = firstTrailingControl(nameMidY: y, in: app, layer: "Layer 1")

        // The gap: just short of the first trailing control, well past a name
        // as short as "Layer 1" — exactly where the complaint says a finger
        // lands and nothing happens. Before the fix the select button ended at
        // the name, so this point was a Spacer with no target at all.
        let selectFrame = settledFrame(select), trailingFrame = settledFrame(trailing)
        let gapX = trailingFrame.minX - 16
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: gapX, dy: y)).tap()

        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "after-gap-tap"
        shot.lifetime = .keepAlways
        add(shot)
        XCTAssertTrue(app.buttons["Rename Layer 1"].firstMatch.waitForExistence(timeout: 3),
                      "a tap between the name and the controls must select the layer "
                      + "(select=\(selectFrame), trailing=\(trailingFrame), x=\(gapX))")
        XCTAssertFalse(app.buttons["Rename Layer 2"].firstMatch.exists,
                       "and Layer 2 must no longer be the active row")
    }

    /// Eight layers at the new row height still reach the bottom row and the
    /// footer. 44pt targets make a wrapped row ~92pt, so a full stack is taller
    /// than a phone's sheet — it must SCROLL, and a sheet clips by default.
    func testAFullStackScrollsToItsBottomRowAndFooter() {
        let app = launch()
        for _ in 0..<7 { app.buttons["Add layer"].firstMatch.tap() }
        let locked = app.buttons["Add layer, locked at the layer limit"].firstMatch
        XCTAssertTrue(locked.waitForExistence(timeout: 3), "eight layers should lock Add")

        let bottom = app.buttons["Select Layer 1"].firstMatch
        let panel = app.otherElements["layers-panel"].firstMatch
        var tries = 0
        while !(bottom.isHittable && locked.isHittable) && tries < 6 {
            panel.swipeUp()
            tries += 1
        }
        XCTAssertTrue(locked.isHittable, "the footer must be reachable with a full stack")
        XCTAssertTrue(bottom.isHittable, "the bottom row must be reachable with a full stack")
        bottom.tap()
        XCTAssertTrue(app.buttons["Rename Layer 1"].firstMatch.waitForExistence(timeout: 3),
                      "and tapping it must select it")
    }

    /// DESIGN.md §2's 44pt, per control, as XCUITest reports the frames.
    func testEveryRowControlIsAtLeast44ptSquare() {
        let app = launch()
        app.buttons["Add layer"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Rename Layer 2"].firstMatch.waitForExistence(timeout: 3))

        // 🔴 ON THE PHONE, MEASURE AT `.large`. At its resting detent iOS 26
        // draws the sheet inset and SCALED (~0.96), so a 44pt layout reports
        // ~42pt there. That is the system's transform, not this layout — at
        // `.large` the scale is 1 and the frames are the layout's own points.
        if UIDevice.current.userInterfaceIdiom == .phone {
            let grabber = app.buttons["Sheet Grabber"].firstMatch
            XCTAssertTrue(grabber.waitForExistence(timeout: 3), "no sheet grabber to expand with")
            grabber.tap()
        }

        // Layer 2 is the top, active row; Layer 1 the bottom. Between them every
        // kind of row control is on screen.
        let names = ["Move Layer 2 up", "Move Layer 2 down", "Move Layer 1 up",
                     "Move Layer 1 down", "Rename Layer 2", "Hide Layer 2", "Hide Layer 1",
                     "Symmetry for Layer 2", "Opacity for Layer 2",
                     "Symmetry for Layer 1", "Opacity for Layer 1",
                     "Select Layer 1", "Select Layer 2"]
        var small: [String] = []
        for name in names {
            let el = app.buttons[name].firstMatch
            XCTAssertTrue(el.exists, "\(name) is missing")
            let f = settledFrame(el)
            if f.width < 44 || f.height < 44 { small.append("\(name) \(Int(f.width))x\(Int(f.height))") }
        }
        XCTAssertTrue(small.isEmpty, "row controls under 44x44pt: \(small.joined(separator: "; "))")
    }
}
