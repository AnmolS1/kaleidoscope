import XCTest

/// Per-layer opacity, driven from the panel (DESIGN.md §3, T16).
///
/// `setLayerOpacity` shipped in the engine with nothing calling it: every layer
/// sat at 1 forever while the row printed a percentage that could only ever read
/// 100%. These tests are about the control that closes that gap, and they are
/// written against the two mistakes that leave it LOOKING finished:
///
///  * "the value changed after a drag" passes with coalescing deleted, with the
///    gesture never sealed, and with a drag that emitted one event. So the undo
///    test drags TWICE and pins the depth from both ends — one undo must land on
///    the FIRST drag's value (that is the seal) and the second must exhaust the
///    stack (that is the coalescing). A live precedent for the failure exists in
///    this app: a dial drag from 3 to 24 leaves 22 undo entries.
///  * "some row reads 40%" is satisfied by a control wired to the active layer
///    rather than to its own row, so the demo's OTHER layers are asserted
///    unchanged — and the demo hands us a real discriminator, since Ink starts
///    at 75% while Gold and Glow start at 100%.
final class LayerOpacityUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launchWithPanel() -> XCUIApplication {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Opacity for Gold"].waitForExistence(timeout: 5),
                      "the panel's rows carry an opacity control")
        return app
    }

    /// The percentage a row is showing, read off the disclosure button.
    private func percent(_ app: XCUIApplication, _ layer: String) -> String {
        app.buttons["Opacity for \(layer)"].firstMatch.value as? String ?? "<none>"
    }

    /// Drag the open slider's thumb across the track.
    ///
    /// A press-drag with a slow velocity, NOT `adjust(toNormalizedSliderPosition:)`:
    /// the coalescing claim is about a stream of values, and a gesture that
    /// delivers a single value is one undo entry whether the code coalesces or
    /// not — the test would then pass with the hard part deleted.
    private func dragSlider(_ app: XCUIApplication, from: CGFloat, to: CGFloat) {
        let slider = app.sliders["Opacity for Gold"].firstMatch
        XCTAssertTrue(slider.exists, "the slider must be disclosed before dragging it")
        slider.coordinate(withNormalizedOffset: CGVector(dx: from, dy: 0.5))
            .press(forDuration: 0.2,
                   thenDragTo: slider.coordinate(withNormalizedOffset: CGVector(dx: to, dy: 0.5)),
                   withVelocity: .slow,
                   thenHoldForDuration: 0.2)
    }

    func testTheRowsPercentageDisclosesASliderForThatLayer() {
        let app = launchWithPanel()

        // Each row reads its OWN layer: the demo's Ink sits at 75% while Gold and
        // Glow are at 100%, so a control bound to the active layer — or to a
        // global — cannot produce this.
        XCTAssertEqual(percent(app, "Gold"), "100%")
        XCTAssertEqual(percent(app, "Ink"), "75%")
        XCTAssertEqual(percent(app, "Glow"), "100%")
        XCTAssertEqual(app.sliders.count, 0, "nothing is disclosed until it is asked for")

        app.buttons["Opacity for Gold"].firstMatch.tap()
        XCTAssertTrue(app.sliders["Opacity for Gold"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.sliders.count, 1, "one slider, for the row that asked for it")

        // And it closes again, rather than being a one-way door.
        app.buttons["Opacity for Gold"].firstMatch.tap()
        XCTAssertFalse(app.sliders["Opacity for Gold"].waitForExistence(timeout: 2))
    }

    func testAWholeDragIsOneUndoEntryAndUndoRestoresTheValueItStartedAt() {
        let app = launchWithPanel()
        let undo = app.buttons["Undo"].firstMatch
        // The baseline is VERIFIED, not assumed: the demo loads with its history
        // cleared, so every claim below is a delta from an empty stack.
        XCTAssertFalse(undo.isEnabled, "the demo starts with no history")

        app.buttons["Opacity for Gold"].firstMatch.tap()
        XCTAssertTrue(app.sliders["Opacity for Gold"].waitForExistence(timeout: 5))

        dragSlider(app, from: 0.97, to: 0.6)
        let afterFirst = percent(app, "Gold")
        XCTAssertNotEqual(afterFirst, "100%", "the drag must move the value")

        dragSlider(app, from: 0.6, to: 0.2)
        let afterSecond = percent(app, "Gold")
        XCTAssertNotEqual(afterSecond, afterFirst, "the second drag must land somewhere else")

        // Two drags, two entries — pinned from both ends.
        XCTAssertTrue(undo.isEnabled)
        undo.tap()
        // NOT 100%: if the gesture were never sealed, both drags would have
        // collapsed into a single entry and this would already be back at the
        // original value.
        XCTAssertEqual(percent(app, "Gold"), afterFirst,
                       "one undo must land on the value the second drag started from")
        XCTAssertTrue(undo.isEnabled)

        undo.tap()
        XCTAssertEqual(percent(app, "Gold"), "100%")
        // And nothing else: without coalescing a slow drag leaves a couple of
        // dozen entries here, and this is the assertion that sees them.
        XCTAssertFalse(undo.isEnabled, "a drag is ONE undo entry, not one per step")
    }

    func testTheSliderMovesOnlyItsOwnLayer() {
        let app = launchWithPanel()
        app.buttons["Opacity for Gold"].firstMatch.tap()
        XCTAssertTrue(app.sliders["Opacity for Gold"].waitForExistence(timeout: 5))

        dragSlider(app, from: 0.97, to: 0.35)
        XCTAssertNotEqual(percent(app, "Gold"), "100%")
        // THE CONTROL. A control wired to the active layer would pass every
        // assertion in the test above and still fail this one — and Ink's 75%
        // means "unchanged" here is a specific number, not a default.
        XCTAssertEqual(percent(app, "Ink"), "75%")
        XCTAssertEqual(percent(app, "Glow"), "100%")
    }

    /// The row's spoken label carries the value, so VoiceOver reports the change
    /// without the slider having to be open.
    func testTheRowSpeaksItsOpacity() {
        let app = launchWithPanel()
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Layer Ink")).firstMatch
        XCTAssertTrue(row.exists)
        XCTAssertTrue(row.label.contains("75% opacity"),
                      "the row label must carry the value, not just the slider: \(row.label)")
    }
}
