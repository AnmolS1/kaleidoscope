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

    // MARK: - accessibility3 screenshot walk

    /// Captures every no-auth screen at the largest Dynamic Type size
    /// (`AccessibilityExtraLarge` = .accessibility3) so a human can eyeball for
    /// clipped/overlapping text. Screenshots are attached (kept always) and later
    /// extracted from the .xcresult. Network-backed screens (Gallery cards,
    /// Artwork, Shuffle) are captured only if the production backend responds;
    /// otherwise they're skipped (attachment simply absent) — never faked.
    func testAccessibility3Screens() {
        let app = XCUIApplication()
        // Force .accessibility3 for this launch only (no global sim setting).
        app.launchArguments += ["-UIPreferredContentSizeCategoryName",
                                "UICTContentSizeCategoryAccessibilityExtraLarge"]
        app.launchEnvironment["KALEIDO_DEMO"] = "1" // give the studio content
        app.launch()

        // 1) Studio as launched (demo drawing present → toolbar enabled).
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 15))
        snap(app, "01-studio-default")

        // 2) Studio with toggles on + a swatch selected (stresses the toolbar).
        for label in ["Glow brush", "Symmetry guides", "Mirror symmetry"] {
            let t = app.buttons[label]
            if t.exists { t.tap() }
        }
        if app.buttons["teal"].exists { app.buttons["teal"].tap() }
        snap(app, "02-studio-active")

        // 3) Gallery grid.
        app.tabBars.buttons["Gallery"].tap()
        _ = app.buttons["Shuffle"].waitForExistence(timeout: 15)
        // Give the network grid a moment to populate.
        let firstCard = app.scrollViews.firstMatch.buttons.firstMatch
        _ = firstCard.waitForExistence(timeout: 8)
        snap(app, "03-gallery")

        // 4) Artwork detail (only if a public card loaded).
        if firstCard.exists {
            firstCard.tap()
            // Artwork shows a title nav bar + Like/Remix/Share once loaded.
            if app.buttons["Remix"].waitForExistence(timeout: 12) || app.buttons["Share"].waitForExistence(timeout: 3) {
                snap(app, "04-artwork-detail")
            }
            if app.navigationBars.buttons.firstMatch.exists {
                app.navigationBars.buttons.firstMatch.tap() // back to Gallery
            }
        }

        // 5) Shuffle viewer (full-screen sheet; network-backed).
        if app.buttons["Shuffle"].waitForExistence(timeout: 5) {
            app.buttons["Shuffle"].tap()
            if app.buttons["Draw your own"].waitForExistence(timeout: 12) {
                snap(app, "05-shuffle-viewer")
            }
            if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        }

        // 6) You tab, signed out.
        app.tabBars.buttons["You"].tap()
        _ = app.buttons["Sign in"].waitForExistence(timeout: 10)
        snap(app, "06-you-signed-out")

        // 7) Add-widget walkthrough (all text, scales heavily).
        if app.buttons["Add the widget"].exists {
            app.buttons["Add the widget"].tap()
            _ = app.navigationBars["Add the Widget"].waitForExistence(timeout: 5)
            snap(app, "07-add-widget-help")
            if app.navigationBars.buttons.firstMatch.exists { app.navigationBars.buttons.firstMatch.tap() }
        }

        // 8) About screen.
        if app.buttons["About Kaleidoscope"].exists {
            app.buttons["About Kaleidoscope"].tap()
            _ = app.navigationBars["About"].waitForExistence(timeout: 5)
            snap(app, "08-about")
            if app.navigationBars.buttons.firstMatch.exists { app.navigationBars.buttons.firstMatch.tap() }
        }

        // 9) Auth sheet (Apple + Google), triggered from You.
        _ = app.buttons["Sign in"].waitForExistence(timeout: 5)
        if app.buttons["Sign in"].exists {
            app.buttons["Sign in"].tap()
            if app.buttons["Sign in with Apple"].waitForExistence(timeout: 8) {
                snap(app, "09-auth-sheet")
            }
        }
    }

    /// Attach a full-screen screenshot, kept regardless of test outcome.
    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let att = XCTAttachment(screenshot: shot)
        att.name = name
        att.lifetime = .keepAlways
        add(att)
    }
}
