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

    /// Captures every no-auth screen at .accessibility3 (accessibilityExtraLarge)
    /// so a human can eyeball for clipped/overlapping text. Screenshots are
    /// attached (kept always) and later extracted from the .xcresult. Network-
    /// backed screens (Gallery cards, Artwork, Shuffle) are captured only if the
    /// production backend responds; otherwise skipped — never faked.
    ///
    /// The category string MUST be the short form `…AccessibilityXL`. The long
    /// form `…AccessibilityExtraLarge` is NOT a valid UIContentSizeCategory raw
    /// value and UIKit silently falls back to the default size (verified: it
    /// renders byte-identical to no-arg, and `…AccessibilityXL` renders identical
    /// to the OS global `accessibility-extra-large` setting).
    func testAccessibility3Screens() {
        let app = XCUIApplication()
        // Force .accessibility3 for this launch only (no global sim setting).
        app.launchArguments += ["-UIPreferredContentSizeCategoryName",
                                "UICTContentSizeCategoryAccessibilityXL"]
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

        // 8) About screen. At large text the Explore rows sit below the fold —
        // scroll to realize the row before tapping.
        var aboutTries = 0
        while !app.buttons["About Kaleidoscope"].exists && aboutTries < 6 {
            app.swipeUp(); aboutTries += 1
        }
        if app.buttons["About Kaleidoscope"].waitForExistence(timeout: 8) {
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

    /// Re-captures ONLY the artwork detail, opening the owner's own piece
    /// "frendalist" (shows "by Anmol Saxena" — the owner's own name, fine to
    /// display) rather than an arbitrary other-user piece. Same .accessibility3
    /// launch arg. Used to replace 04-artwork-detail with a privacy-safe shot.
    /// Focused .accessibility3 capture of the Studio (default + a swatch selected)
    /// — used to refresh 01/02 after the controls-panel reflow without disturbing
    /// the network-backed screens.
    func testAccessibility3StudioReflow() {
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName",
                                "UICTContentSizeCategoryAccessibilityXL"]
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 15))
        snap(app, "01-studio-default")
        if app.buttons["teal"].exists { app.buttons["teal"].tap() }
        snap(app, "02-studio-active")
    }

    /// Focused .accessibility3 capture of the About screen (text-heavy), separate
    /// so a flaky navigation in the main walk can't drop it.
    func testAccessibility3About() {
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName",
                                "UICTContentSizeCategoryAccessibilityXL"]
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        app.tabBars.buttons["You"].tap()
        // At .accessibility3 the Explore rows sit below the fold — scroll to
        // realize the "About Kaleidoscope" row before tapping it.
        let about = app.buttons["About Kaleidoscope"]
        var tries = 0
        while !about.exists && tries < 6 {
            app.swipeUp()
            tries += 1
        }
        XCTAssertTrue(about.waitForExistence(timeout: 5))
        about.tap()
        XCTAssertTrue(app.navigationBars["About"].waitForExistence(timeout: 8))
        snap(app, "08-about")
    }

    func testAccessibility3FrendalistArtwork() {
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName",
                                "UICTContentSizeCategoryAccessibilityXL"]
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()

        app.tabBars.buttons["Gallery"].tap()
        XCTAssertTrue(app.buttons["Shuffle"].waitForExistence(timeout: 15))

        // The gallery cards are combined elements whose label contains the title;
        // scroll until the "frendalist" card is realized, then open it.
        let frendalist = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "frendalist")).firstMatch
        var tries = 0
        while !frendalist.exists && tries < 10 {
            app.swipeUp()
            tries += 1
        }
        XCTAssertTrue(frendalist.waitForExistence(timeout: 5),
                      "frendalist card should be reachable in the gallery")
        frendalist.tap()

        XCTAssertTrue(app.buttons["Remix"].waitForExistence(timeout: 12),
                      "artwork detail should load")
        // Confirm we're on the frendalist detail before capturing.
        XCTAssertTrue(app.navigationBars["frendalist"].waitForExistence(timeout: 5)
                      || app.staticTexts["frendalist"].exists,
                      "detail should be the frendalist piece")
        snap(app, "04-artwork-detail")
    }

    // MARK: - Dynamic Type string verification

    /// Launches the Studio at a given content-size category (or none) and snaps
    /// it, so we can compare the correct `…AccessibilityXL` string against the
    /// (suspect) `…AccessibilityExtraLarge` string and the no-arg default, and
    /// tell whether the committed set is truly .accessibility3.
    private func captureStudio(category: String?, name: String) {
        let app = XCUIApplication()
        if let category {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", category]
        }
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 15))
        snap(app, name)
    }

    func testVerifyStudioXL() {
        captureStudio(category: "UICTContentSizeCategoryAccessibilityXL", name: "verify-studio-XL")
    }

    func testVerifyStudioOldString() {
        captureStudio(category: "UICTContentSizeCategoryAccessibilityExtraLarge", name: "verify-studio-OLD")
    }

    func testVerifyStudioDefault() {
        captureStudio(category: nil, name: "verify-studio-DEFAULT")
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
