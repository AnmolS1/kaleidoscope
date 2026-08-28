import XCTest

/// The PNG download must export the LAYERED document, not a v1 flatten.
///
/// The obvious test — "the exported image is not blank" — is worthless here: a
/// v1 projection of a layered drawing is also full of ink, so it passes on the
/// exact defect it is supposed to catch. These tests therefore read the
/// launch-gated `export-probe` element (see `Studio/Panels/ExportProbe.swift`),
/// which fingerprints three renders through one code path, and assert
/// relationships between them:
///
/// - `emptyink == 0` is the live control. It proves a blank render reads as
///   blank, which is what makes `v2ink > 0` an assertion rather than a
///   tautology about the probe.
/// - `v2hash != v1hash` is the mutation guard. Point `StudioView.exportImage()`
///   back at the deprecated `currentDrawing()` and the two collapse.
final class ExportUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launchWithProbe() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"          // 3 mixed-symmetry layers
        app.launchEnvironment["KALEIDO_EXPORT_PROBE"] = "1"  // mounts the probe
        app.launch()
        return app
    }

    /// `v2ink=… v2hash=… v1ink=… v1hash=… emptyink=… emptyhash=…` → dictionary.
    private func readProbe(_ app: XCUIApplication) throws -> [String: UInt64] {
        let probe = app.staticTexts["export-probe"]
        XCTAssertTrue(probe.waitForExistence(timeout: 20),
                      "export probe should be mounted under KALEIDO_EXPORT_PROBE=1")
        var out: [String: UInt64] = [:]
        for pair in probe.label.split(separator: " ") {
            let kv = pair.split(separator: "=")
            guard kv.count == 2, let v = UInt64(kv[1]) else { continue }
            out[String(kv[0])] = v
        }
        XCTAssertEqual(out.count, 6, "probe should report 6 fields, got: \(probe.label)")
        return out
    }

    func testExportIsTheLayeredDocumentAndNotAV1Flatten() throws {
        let app = launchWithProbe()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        let p = try readProbe(app)

        // Control: an empty document through the same renderer must read blank.
        // Without this, "v2ink > 0" only says the probe returns a number.
        XCTAssertEqual(p["emptyink"], 0,
                       "an empty drawing must render with zero non-background pixels")

        // Non-blank.
        XCTAssertGreaterThan(p["v2ink"] ?? 0, 0, "the exported PNG must contain ink")

        // The v1 path is itself non-blank — so the hash difference below is a
        // difference between two real pictures, not "one of them rendered
        // nothing". Asserting this is what stops the mutation guard from
        // passing for the wrong reason.
        XCTAssertGreaterThan(p["v1ink"] ?? 0, 0,
                             "the v1 projection is also non-blank; that is the whole problem")

        // The fix is load-bearing: the demo's 6 / 12-at-0.75 / 9-fold layers
        // cannot survive a flatten, so the two renders must differ.
        XCTAssertNotEqual(p["v2hash"], p["v1hash"],
                          "download exported a v1 flatten — StudioView.exportImage() must use currentDrawingV2()")
    }

    /// The demo fixture the whole suite leans on: three layers, mixed symmetry,
    /// with the top one active. Asserted through the canvas's spoken value so a
    /// change to the seed or to the active-layer rule shows up here.
    func testDemoSeedsThreeLayers() {
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        let canvas = app.otherElements["Drawing canvas"]
        XCTAssertTrue(canvas.waitForExistence(timeout: 20))
        let spoken = canvas.value as? String ?? ""
        XCTAssertEqual(spoken, "9-fold mirror symmetry, 3 strokes, layer Gold of 3",
                       "demo should seed 3 mixed-symmetry layers with Gold active")
    }
}
