import XCTest

/// App Store listing captures for 1.2 — the shots that go in the ASC screenshot
/// slots, as opposed to `StudioScreenshotUITests`, which exists to eyeball the
/// rewrite against the design frames.
///
/// Two device classes, two slots, and the sizes are NOT interchangeable:
///
/// - `APP_IPHONE_67`         — iPhone 15 Pro Max, 1290 x 2796, portrait
/// - `APP_IPAD_PRO_3GEN_129` — iPad Pro 12.9" (6th gen), 2048 x 2732, landscape
///
/// Those two enum values are the LARGEST ASC currently accepts; there is no
/// `APP_IPHONE_69` and no `APP_IPAD_13` (read off the API's own error listing
/// the valid values, not off Apple's marketing pages). The runner asserts every
/// exported PNG's dimensions against its slot before upload, because a
/// wrong-orientation capture is a perfectly valid PNG of the wrong size and
/// reads as a success everywhere except the upload.
///
/// Gallery and artwork shots need the LIVE api. They assert that a card
/// actually loaded rather than snapping whatever is on screen — an empty grid
/// is a plausible-looking screenshot and a terrible listing.
final class MarketingShotsUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch(_ orientation: UIDeviceOrientation) -> XCUIApplication {
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        // Marketing runs at the Plus cap: the free cap's locked Add and Plus
        // footnote are correct behaviour and the wrong thing to lead with.
        app.launchEnvironment["KALEIDO_LAYER_CAP"] = "8"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 25),
                      "studio never came up")
        return app
    }

    private func snap(_ name: String) {
        let att = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        att.name = name
        att.lifetime = .keepAlways
        add(att)
    }

    /// iPad renders the TabView as the floating top bar, which XCUITest does not
    /// surface under `tabBars` — that is why an iPad run of the accessibility
    /// suite fails with "No matches found for ... TabBar". Try the tab bar, then
    /// fall back to a plain button, and ASSERT rather than silently skipping.
    private func go(_ tab: String, _ app: XCUIApplication) {
        let viaTabBar = app.tabBars.buttons[tab]
        if viaTabBar.waitForExistence(timeout: 3) { viaTabBar.tap(); return }
        let viaButton = app.buttons[tab].firstMatch
        XCTAssertTrue(viaButton.waitForExistence(timeout: 8), "no way to reach the \(tab) tab")
        viaButton.tap()
    }

    /// The first public card in the gallery grid, once the network has answered.
    @discardableResult
    private func firstGalleryCard(_ app: XCUIApplication) -> XCUIElement {
        let card = app.scrollViews.firstMatch.buttons.firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 25),
                      "no public artwork loaded — the simulator could not reach the gallery API, "
                      + "and an empty grid must not be shipped as a screenshot")
        return card
    }

    /// Open a card and WAIT FOR THE DETAIL SCREEN.
    ///
    /// The obvious assertion — "an image exists" — is a tautology here: the
    /// gallery cards are themselves images, so it is already true before the tap
    /// and passes on precisely the failure it is meant to catch. It did: the
    /// gallery and artwork captures came back byte-identical, same SHA-256,
    /// because the tap had not navigated and nothing waited. `Like` and `Share`
    /// exist only on the detail screen, so they can tell the two apart.
    private func openArtwork(_ card: XCUIElement, _ app: XCUIApplication) {
        card.tap()
        let like = app.buttons["Like"].firstMatch
        let share = app.buttons["Share"].firstMatch
        XCTAssertTrue(like.waitForExistence(timeout: 25) || share.waitForExistence(timeout: 5),
                      "tapping a card did not reach the artwork detail screen")
        // The picture itself renders after the chrome; give it the moment it
        // needs so the shot is not of a placeholder.
        XCTAssertTrue(app.images.firstMatch.waitForExistence(timeout: 15))
    }


    /// Emit every author-name frame for the screen about to be captured.
    ///
    /// Printed in the SAME run as the shot, deliberately: the gallery is live
    /// data, so frames dumped by a second run can describe a different ordering
    /// and the blur then lands on the wrong pixels. Author lines are ~17.3pt
    /// tall and titles are 21pt, which separates them without matching on the
    /// names themselves.
    private func emitAuthorFrames(_ app: XCUIApplication, _ shot: String) {
        for t in app.staticTexts.allElementsBoundByIndex {
            let f = t.frame
            guard f.height > 16, f.height < 19 else { continue }
            print("AUTHORFRAME|\(shot)|\(f.origin.x)|\(f.origin.y)|\(f.width)|\(f.height)")
        }
    }

    // MARK: iPad — landscape, 2048 x 2732

    func testIPadShots() {
        let app = launch(.landscapeLeft)

        // 1. The money shot: mid-drawing with the layer stack showing.
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Ink"].waitForExistence(timeout: 5), "layers panel did not open")
        snap("ipad-01-studio-layers")

        // 2. Per-layer symmetry — the thing the whole v2 format exists for.
        app.buttons["Symmetry for Ink"].firstMatch.tap()
        XCTAssertTrue(app.otherElements["Symmetry segments"].waitForExistence(timeout: 5)
                      || app.buttons["Symmetry segments"].waitForExistence(timeout: 2),
                      "the dial did not appear")
        snap("ipad-02-symmetry-dial")

        // 3. Brush: the Pencil pressure presets.
        app.buttons["Layers"].firstMatch.tap()          // close the panel
        app.buttons["Solid brush"].firstMatch.tap()
        snap("ipad-03-brush")

        // 4. Gallery.
        go("Gallery", app)
        let card = firstGalleryCard(app)
        emitAuthorFrames(app, "ipad-04-gallery")
        snap("ipad-04-gallery")

        // 5. One piece, opened.
        // No artwork-detail shot: it features ONE named person's work large, and
        // Anmol is recapturing that slot with his own pieces. `openArtwork` is
        // kept because it holds the hard-won note about the tautological assertion.
        _ = card
    }

    // MARK: iPhone — portrait, 1290 x 2796

    func testIPhoneShots() {
        let app = launch(.portrait)
        snap("iphone-01-studio")

        // Gallery and artwork BEFORE the layers sheet, deliberately.
        //
        // The obvious order — studio, layers, then the gallery — needs the
        // layers sheet dismissed first, and `swipeDown()` does not reliably
        // leave a clean state: the sheet stayed up, the tab tap went to it
        // instead of the tab bar, and the card tap then never reached a detail
        // screen. Capturing the network screens first removes the dismissal
        // from the path entirely rather than trying to make it robust.
        go("Gallery", app)
        let card = firstGalleryCard(app)
        emitAuthorFrames(app, "iphone-03-gallery")
        snap("iphone-03-gallery")

        _ = card

        // Back to the studio for the sheet shot; nothing depends on this
        // dismissing cleanly, because it is the last thing captured.
        go("Draw", app)
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 15))
        // Dark canvas BEFORE the layers sheet. The More menu is a menu, not a
        // sheet, so it closes itself on selection — no dismissal to get wrong.
        // Sheets go last for exactly that reason: the earlier version put a
        // `swipeDown()` in the middle of the run and the next tap landed on the
        // still-open sheet.
        app.buttons["More"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Dark canvas"].waitForExistence(timeout: 8), "More menu did not open")
        app.buttons["Dark canvas"].tap()
        snap("iphone-04-dark")

        // The layers sheet last: nothing after it depends on it dismissing.
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Ink"].waitForExistence(timeout: 8), "layers sheet did not open")
        snap("iphone-02-layers")
    }
}
