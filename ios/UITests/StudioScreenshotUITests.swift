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
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        snap("a11y3-01-studio")
        app.buttons["Solid brush"].firstMatch.tap()
        app.buttons["Color"].firstMatch.tap()
        snap("a11y3-02-color")
    }
}
