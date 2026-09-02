import XCTest

/// REVIEW S18 on iOS — a signed-out person must be able to find Restore.
///
/// `cc48257` delivered the worker half and the web half and titled itself as
/// though it had done the job. iOS never fetched `/api/me` without a session:
/// every path to it opened with `guard let stored = session`, so `plus` stayed
/// nil when signed out, `surfaceVisible(nil)` read false, and the You tab
/// rendered no Plus section at all. Somebody who reinstalls and has not signed
/// back in — the exact case S18 was filed about, and the one Apple expects
/// Restore to survive — found nothing.
///
/// This is deliberately a UI test against the real `/api/me`, with the surface
/// forced on, because the defect was entirely in WHETHER THE CALL HAPPENS. A
/// unit test on `surfaceVisible` passes either way.
final class SignedOutRestoreUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    /// 🔴 RUN THIS ON A FRESHLY ERASED SIMULATOR. `AuthModel.restore()` reads the
    /// Keychain, and a session left by any earlier run puts the app on the
    /// signed-IN path — which populates `plus` and makes this test pass with the
    /// fix entirely reverted. That is not hypothetical: it is what happened
    /// three times before `simctl erase` was added to the loop.
    func testSignedOutUserCanReachRestore() {
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_PLUS_SURFACE"] = "1"
        app.launchEnvironment["KALEIDO_TAB"] = "you"
        app.launch()

        // EXACT anchors. The first version of this test matched
        // `label CONTAINS 'Plus'` and fell back to a "Sign in" static text that
        // the signed-out You tab renders anyway — so it passed with the whole
        // fix reverted. A test of a missing row has to name the row.
        let restoreRow = app.buttons["Restore purchase"]  // PlusCopy.restore, inlined: a UI test target cannot link the app
        XCTAssertTrue(restoreRow.waitForExistence(timeout: 25),
                      "no Restore row while signed out — /api/me was never asked anonymously, "
                      + "so `plus` is nil and the section does not render")

        XCTAssertTrue(app.buttons["Get Kaleidoscope Plus"].exists,
                      "the Plus row should be beside it")

        restoreRow.tap()

        // The sheet's own identifier, which encodes the state it resolved to.
        // An anonymous visitor gets `signIn`, and that state is what offers the
        // way back to a purchase they already own.
        XCTAssertTrue(app.otherElements["plus-sheet-signIn"].waitForExistence(timeout: 10),
                      "the Plus sheet did not open in its signed-out state")
    }
}
