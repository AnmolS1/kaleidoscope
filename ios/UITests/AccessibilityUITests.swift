import XCTest

/// Smoke-level accessibility assertions: the key VoiceOver labels added in the
/// a11y pass must be present on each screen. Launches with KALEIDO_DEMO=1 so the
/// studio has content (which enables the toolbar buttons) without any network.
///
/// Gallery-card and save-chip labels depend on a live/seeded backend, so those
/// screens are only asserted for their network-independent controls here.
final class AccessibilityUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        return app
    }

    func testStudioAccessibilityLabels() {
        let app = launch()

        // Canvas is exposed as a single labeled accessibility element.
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 15),
                      "Canvas should expose a 'Drawing canvas' accessibility element")

        // Toolbar controls (the demo drawing makes them enabled/queryable).
        XCTAssertTrue(app.buttons["Clear canvas"].exists, "Clear button needs a label")
        XCTAssertTrue(app.buttons["Download PNG"].exists, "Download button needs a label")
        XCTAssertTrue(app.buttons["Save"].exists, "Save button should be present")

        // Palette swatches announce named colors, never a bare hex string.
        XCTAssertTrue(app.buttons["teal"].exists, "Swatch should read as its color name")
        XCTAssertTrue(app.buttons["crane orange"].exists, "Swatch should read as its color name")
    }

    func testGalleryToolbarAccessibility() {
        let app = launch()
        app.tabBars.buttons["Gallery"].tap()
        XCTAssertTrue(app.buttons["Shuffle"].waitForExistence(timeout: 15),
                      "Gallery should expose a labeled Shuffle button")
    }
}
