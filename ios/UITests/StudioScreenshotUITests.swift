import XCTest

/// Studio captures for the T15 App Store pass and for eyeballing the rewrite
/// against the design frames.
///
/// Driven from a UI test rather than `simctl io screenshot` for one reason that
/// costs an hour if you learn it the hard way: `simctl` cannot rotate a device,
/// and `simctl launch` does not forward a bare `KEY=value` as an environment
/// variable (it needs `SIMCTL_CHILD_`), so a naive shell capture silently
/// produces a portrait screenshot of an EMPTY canvas and looks like it worked.
/// `XCUIDevice.orientation` and `launchEnvironment` both do what they say.
///
/// Attachments are kept always and extracted from the .xcresult afterwards.
final class StudioScreenshotUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch(_ orientation: UIDeviceOrientation) -> XCUIApplication {
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        // Marketing shots run at the PLUS cap. At the free cap the same panel
        // reads `3 of 3` with a locked Add and a Plus footnote, which is correct
        // behaviour and the wrong thing to lead a product page with. The locked
        // state is covered by `LayerCapUITests` instead of by a screenshot.
        app.launchEnvironment["KALEIDO_LAYER_CAP"] = "8"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        return app
    }

    private func snap(_ name: String) {
        let att = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        att.name = name
        att.lifetime = .keepAlways
        add(att)
    }

    /// iPad landscape: the four states the design frames cover.
    func testCaptureRegularLandscape() {
        let app = launch(.landscapeLeft)
        snap("ipad-landscape-01-main")

        app.buttons["Layers"].firstMatch.tap()
        snap("ipad-landscape-02-layers")

        app.buttons["Symmetry for Ink"].firstMatch.tap()
        snap("ipad-landscape-03-layers-and-dial")

        app.buttons["Layers"].firstMatch.tap()   // close the panel
        app.buttons["Solid brush"].firstMatch.tap()
        app.buttons["Color"].firstMatch.tap()
        snap("ipad-landscape-04-color")

        app.buttons["Color"].firstMatch.tap()
        app.buttons["Remove stroke"].firstMatch.tap()
        snap("ipad-landscape-05-remove-armed")
    }

    /// Remove-stroke with an actual HIT. Arming the tool renders none of the
    /// chrome that makes this state — the confirm capsule, the `Switched to …`
    /// toast and the readout's `REMOVE STROKE` branch all need a stroke under the
    /// tap. Captured separately so those three are things a human has seen.
    func testCaptureRemoveStrokeHit() {
        let app = launch(.landscapeLeft)
        app.buttons["Remove stroke"].firstMatch.tap()

        // The demo's ink sits in a ring roughly 0.25–0.45 of the way out from the
        // centre. Probe a few points on that ring rather than guessing one: which
        // pixel a given stroke image lands on depends on the screen's aspect.
        let canvas = app.otherElements["Drawing canvas"].firstMatch
        let probes: [(CGFloat, CGFloat)] = [
            (0.50, 0.30), (0.62, 0.34), (0.38, 0.34), (0.50, 0.70),
            (0.62, 0.66), (0.38, 0.66), (0.30, 0.50), (0.70, 0.50)
        ]
        var hit = false
        for (dx, dy) in probes {
            canvas.coordinate(withNormalizedOffset: CGVector(dx: dx, dy: dy)).tap()
            if app.node("remove-stroke-bar").waitForExistence(timeout: 2) { hit = true; break }
        }
        XCTAssertTrue(hit, "remove-stroke should find a stroke somewhere on the demo drawing")
        snap("ipad-landscape-07-remove-hit")
    }

    /// Dark canvas — the design's `IPadDark` frame, which is what proves the
    /// token swap carries the panels.
    func testCaptureRegularLandscapeDark() {
        let app = launch(.landscapeLeft)
        app.buttons["More"].firstMatch.tap()
        app.buttons["Dark canvas"].firstMatch.tap()
        app.buttons["Layers"].firstMatch.tap()
        app.buttons["Symmetry for Ink"].firstMatch.tap()
        snap("ipad-landscape-06-dark")
    }

    func testCaptureRegularPortrait() {
        let app = launch(.portrait)
        snap("ipad-portrait-01-main")
        app.buttons["Layers"].firstMatch.tap()
        snap("ipad-portrait-02-layers")
    }

    func testCaptureCompactPortrait() {
        let app = launch(.portrait)
        snap("iphone-portrait-01-main")

        // The value chips sit past the palette in the scrolling strip, so on a
        // 430pt phone they start off screen.
        app.descendants(matching: .any).matching(identifier: "studio-strip")
            .firstMatch.swipeLeft()
        app.buttons["Brush size"].firstMatch.tap()
        snap("iphone-portrait-02-brush-sheet")
        app.swipeDown() // dismiss the sheet

        app.buttons["Layers"].firstMatch.tap()
        snap("iphone-portrait-03-layers-sheet")
    }

    func testCaptureCompactLandscape() {
        let app = launch(.landscapeLeft)
        snap("iphone-landscape-01-main")
        app.buttons["Layers"].firstMatch.tap()
        snap("iphone-landscape-02-layers")
    }

    /// The accessibility-size studio, which is the branch `isAccessibilitySize`
    /// exists for: the rail grows and the edge sliders give way to the Brush
    /// popover's own Size/Opacity rows.
    func testCaptureAccessibilitySize() {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName",
                                "UICTContentSizeCategoryAccessibilityXL"]
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launchEnvironment["KALEIDO_LAYER_CAP"] = "8"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        snap("a11y3-01-studio")
        app.buttons["Solid brush"].firstMatch.tap()
        app.buttons["Color"].firstMatch.tap()
        snap("a11y3-02-color")
    }
}
