import XCTest

/// The layers panel at both caps (DESIGN.md §3, frames `LayersStates` 1 and 2).
///
/// Runs on any device, and green on both: iPhone 17e 4/4, iPad Pro 11-inch 4/4.
///
/// This suite was misdiagnosed three times, so the settled account lives here.
/// THREE separate things were tangled together, and each explanation was
/// applied to the wrong one:
///
/// - **The two `KALEIDO_LAYER_CAP=8` failures were a real product bug.** The
///   override was read only in `init`, and `RootView` pushes `/api/me.plus`'s
///   cap through a `.task` shortly after launch, overwriting it before anything
///   could read it. It is consulted in `setLayerCap` now — at the setter every
///   writer passes through, not at the earliest point in the lifecycle.
/// - **`testAddAtTheFreeCapDoesNotAddALayer` was a real TEST bug, and it IS a
///   tap falling through to the canvas** — an explanation that was proposed
///   early, then wrongly retracted when a speculative `.contentShape` fix
///   changed nothing. The fix was wrong; the mechanism was not. See the comment
///   in that test for the measured frames. It never explained the two failures
///   above, which is what made the over-correction easy.
/// - **The evidence was scrambled by shared-simulator contention.** Several
///   agents resolved `-destination` from `simctl list devices available` and
///   landed on one device, so concurrent runs gave a different failure set each
///   time — 1 of 4, then 4 of 4, then 2 of 4, in suites nobody had touched.
///
/// Two rules earned the hard way. Run iOS suites on a private simulator
/// (`xcrun simctl create`) before believing ANY result, red or green. And when
/// a fix changes nothing, that is evidence the diagnosis is wrong, not that it
/// is merely incomplete.
///
final class LayerCapUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch(cap: Int?) -> XCUIApplication {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        if let cap { app.launchEnvironment["KALEIDO_LAYER_CAP"] = "\(cap)" }
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Gold"].waitForExistence(timeout: 5))
        return app
    }

    private let footnote = "Layers: 3 of 3 · Kaleidoscope Plus unlocks 8"

    /// Default: 3 layers into a cap of 3. Add is locked and the panel says how to
    /// unlock it — `LayersStates` panel 1.
    func testFreeCapLocksAddAndOffersTheWayOut() {
        let app = launch(cap: nil)

        XCTAssertTrue(app.staticTexts["Layers, 3 of 3"].exists,
                      "the header counts against the CAP, not against MAX_LAYERS")
        XCTAssertTrue(app.staticTexts[footnote].exists,
                      "at the free cap the panel names both exits")

        // The locked Add keeps a label that says WHY, not just that it is off.
        let locked = app.buttons["Add layer, locked at the layer limit"]
        XCTAssertTrue(locked.exists, "Add is labelled with its reason at the cap")
        XCTAssertFalse(locked.isEnabled)
        XCTAssertFalse(app.buttons["Add layer"].exists,
                       "the unlocked label must not be present at the cap")

        // Duplicate is capped by the same rule; Delete is not.
        XCTAssertFalse(app.buttons["Duplicate layer"].isEnabled)
        XCTAssertTrue(app.buttons["Delete layer"].isEnabled)
    }

    /// `KALEIDO_LAYER_CAP=8`: the same three layers, unlocked — `IPadLayers`.
    func testPlusCapUnlocksAddAndDropsTheFootnote() {
        let app = launch(cap: 8)

        XCTAssertTrue(app.staticTexts["Layers, 3 of 8"].exists,
                      "the header must follow the override")
        XCTAssertFalse(app.staticTexts[footnote].exists,
                       "below the cap there is nothing to unlock")

        let add = app.buttons["Add layer"]
        XCTAssertTrue(add.exists, "Add carries its plain label when it is available")
        XCTAssertTrue(add.isEnabled)
        XCTAssertFalse(app.buttons["Add layer, locked at the layer limit"].exists)
        XCTAssertTrue(app.buttons["Duplicate layer"].isEnabled)
    }

    /// Adding a layer inherits the active layer's symmetry and says so — the
    /// third of DESIGN.md §3's first-run nudges, and the only one reachable
    /// without a Pencil.
    func testAddingALayerInheritsSymmetryAndNudges() {
        let app = launch(cap: 8)
        // Gold, the active layer, is 9-fold mirrored. Each row's sym line is a
        // button whose VALUE is the spoken symmetry, so inheritance is readable
        // directly rather than inferred from a count of matching labels.
        XCTAssertEqual(app.buttons["Symmetry for Gold"].value as? String, "9 segments, mirrored")

        app.buttons["Add layer"].tap()

        XCTAssertTrue(app.staticTexts["Layers, 4 of 8"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts["New layer inherits this layer's symmetry. Tap the badge to change it."]
                .waitForExistence(timeout: 5),
            "the nudge explains where the new layer's symmetry came from")

        // The claim is INHERITANCE, so assert the new layer's own symmetry — not
        // that some row somewhere still reads 9-fold. A default would be 8 · D
        // (`emptyDrawingV2`), which this would catch.
        let newRow = app.buttons["Symmetry for Layer 4"]
        XCTAssertTrue(newRow.waitForExistence(timeout: 5), "the new layer is named Layer 4")
        XCTAssertEqual(newRow.value as? String, "9 segments, mirrored",
                       "the new layer must carry Gold's symmetry, not a default")
    }

    /// At the free cap, Add does nothing — the locked chip is not a soft gate.
    func testAddAtTheFreeCapDoesNotAddALayer() {
        let app = launch(cap: nil)
        // A disabled element cannot be tapped by XCUITest, so tap where it sits
        // instead: that exercises the model's own cap rather than the label's.
        //
        // But a coordinate tap goes to a POINT, not to the element — so the
        // point has to actually be on the card. On a short screen the panel is
        // height-capped (`maxLayersHeight`) and the action row sits below the
        // fold: on a 390pt-tall landscape phone the card measured
        // (453, 64, 264, 200) while this button reported (462, 270) — six
        // points past the bottom edge, over bare canvas. The tap then DREW,
        // and the test blamed the extra stroke on the cap it was checking.
        // Scroll it into the card first, and assert that it got there, so the
        // failure mode is "could not reach the control" rather than a silent
        // stroke.
        let card = app.scrollViews.firstMatch
        let locked = app.buttons["Add layer, locked at the layer limit"]
        var attempts = 0
        while !card.frame.contains(CGPoint(x: locked.frame.midX, y: locked.frame.midY)),
              attempts < 5 {
            card.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(card.frame.contains(CGPoint(x: locked.frame.midX, y: locked.frame.midY)),
                      "the locked Add must be inside the card before a coordinate tap; "
                      + "card \(card.frame), button \(locked.frame)")
        locked.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.staticTexts["Layers, 3 of 3"].exists,
                      "the cap is enforced by the model, not only by the label")
        XCTAssertEqual(app.otherElements["Drawing canvas"].value as? String,
                       "9-fold mirror symmetry, 3 strokes, layer Gold of 3")
    }
}
