import XCTest

/// A hidden active layer refuses ink (PLAN §4, DESIGN.md §3) — and says so.
///
/// The assertions read the CANVAS's own spoken value, which is built from
/// `model.strokeCount` (every layer, hidden included). That is the number the
/// defect moved: before the guard, a stroke drawn onto a hidden layer entered the
/// document, counted here, and shipped in the saved vector, while
/// `KaleidoCanvasView` correctly declined to draw it. So the user saw nothing
/// appear and the ink was there anyway.
///
/// Asserting on `strokeCount` rather than on `isEmpty` matters: `isEmpty` counts
/// only VISIBLE strokes, so it would read the same either way and could not tell
/// a refused stroke from a committed-but-invisible one. A test that cannot
/// distinguish the two hypotheses discriminates nothing.
final class HiddenLayerUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        return app
    }

    /// Hide the active layer, then draw across the canvas.
    private func hideActiveLayerAndDraw(_ app: XCUIApplication) {
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Hide Gold"].waitForExistence(timeout: 5),
                      "Gold is the demo's active layer and starts visible")
        app.buttons["Hide Gold"].tap()
        XCTAssertTrue(app.buttons["Show Gold"].waitForExistence(timeout: 5),
                      "the eye must flip, and hiding must not reseat the active layer")
        app.buttons["Layers"].firstMatch.tap() // close the panel

        let canvas = app.otherElements["Drawing canvas"].firstMatch
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.35))
            .press(forDuration: 0.1,
                   thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.62)))
    }

    func testDrawingOnAHiddenLayerIsRefusedAndSaysSo() {
        let app = launch()
        let canvas = app.otherElements["Drawing canvas"]
        XCTAssertEqual(canvas.value as? String,
                       "9-fold mirror symmetry, 3 strokes, layer Gold of 3")

        hideActiveLayerAndDraw(app)

        // The stroke was dropped. `strokeCount` counts hidden layers, so a
        // committed-but-invisible stroke would read as 4 here.
        XCTAssertEqual(canvas.value as? String,
                       "9-fold mirror symmetry, 3 strokes, layer Gold of 3",
                       "a hidden active layer must refuse the stroke entirely")

        // And it is not auto-unhidden.
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Show Gold"].waitForExistence(timeout: 5),
                      "the layer stays hidden — the refusal never unhides it")
    }

    /// The nudge, with DESIGN.md §3's copy verbatim including its curly quotes.
    func testRefusalRaisesTheNudgeWithItsShowLayerAction() {
        let app = launch()
        hideActiveLayerAndDraw(app)

        let message = "\u{201C}Gold\u{201D} is hidden, so nothing was drawn."
        let toast = app.staticTexts[message]
        XCTAssertTrue(toast.waitForExistence(timeout: 5),
                      "the refusal must say which layer refused, by name")
        XCTAssertTrue(app.buttons["Show layer"].firstMatch.exists,
                      "the nudge carries the way out")

        app.buttons["Show layer"].firstMatch.tap()
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Hide Gold"].waitForExistence(timeout: 5),
                      "Show layer unhides it — on the user's say-so, not automatically")
    }

    /// A refused stroke leaves no undo step. A history entry holding no change is
    /// worse than no entry: undo stops doing anything visible.
    func testARefusedStrokeIsNotAnUndoStep() {
        let app = launch()
        // The demo loads with a cleared history, so Undo starts disabled and any
        // history entry at all would enable it.
        XCTAssertFalse(app.buttons["Undo"].firstMatch.isEnabled,
                       "the demo starts with no history")
        hideActiveLayerAndDraw(app)
        XCTAssertFalse(app.buttons["Undo"].firstMatch.isEnabled,
                       "a refused stroke must not push an undo step")
    }

    /// A single TAP is a dot, not an empty stroke — so it is refused, and it does
    /// nudge.
    ///
    /// This is written as a paired control because the first version of it
    /// asserted the opposite and failed, and the test was wrong rather than the
    /// code: `touchesBegan` appends a point, so the shortest possible touch
    /// yields a one-point stroke. The demo's own Gold layer is exactly that — a
    /// single `StrokePoint`. Refusing it on a hidden layer is correct.
    ///
    /// The pair is what makes it evidence: the same tap on a VISIBLE layer must
    /// add a stroke. Without that half, "3 strokes after a tap" is equally
    /// consistent with taps simply not drawing anything.
    ///
    /// The zero-point case the `!stroke.pts.isEmpty` guard exists for is not
    /// reachable from the UI at all — every touch sequence produces at least one
    /// point — so its ORDER before the visibility check is asserted by reading,
    /// not by this suite. Recorded rather than papered over.
    func testATapIsADotAndIsRefusedOnAHiddenLayerButDrawsOnAVisibleOne() {
        let message = "\u{201C}Gold\u{201D} is hidden, so nothing was drawn."

        // Control: the same tap on the visible demo commits a dot.
        let visible = launch()
        visible.otherElements["Drawing canvas"].firstMatch
            .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(visible.otherElements["Drawing canvas"].value as? String,
                       "9-fold mirror symmetry, 4 strokes, layer Gold of 3",
                       "a tap is a one-point dot stroke, not a no-op")
        XCTAssertFalse(visible.staticTexts[message].exists)

        // And on a hidden layer that same dot is refused, with the nudge.
        let hidden = launch()
        hidden.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(hidden.buttons["Hide Gold"].waitForExistence(timeout: 5))
        hidden.buttons["Hide Gold"].tap()
        hidden.buttons["Layers"].firstMatch.tap()
        hidden.otherElements["Drawing canvas"].firstMatch
            .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        XCTAssertEqual(hidden.otherElements["Drawing canvas"].value as? String,
                       "9-fold mirror symmetry, 3 strokes, layer Gold of 3",
                       "the dot is dropped")
        XCTAssertTrue(hidden.staticTexts[message].waitForExistence(timeout: 5),
                      "and the user is told why")
    }

    /// A VISIBLE active layer still accepts ink. Without this the suite above
    /// would pass on a `commit` that refused everything.
    func testAVisibleLayerStillAcceptsInk() {
        let app = launch()
        let canvas = app.otherElements["Drawing canvas"].firstMatch
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.35))
            .press(forDuration: 0.1,
                   thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.62)))
        XCTAssertEqual(app.otherElements["Drawing canvas"].value as? String,
                       "9-fold mirror symmetry, 4 strokes, layer Gold of 3",
                       "the guard must only refuse HIDDEN layers")
        XCTAssertTrue(app.buttons["Undo"].firstMatch.isEnabled,
                      "and a real stroke IS an undo step")
    }
}
