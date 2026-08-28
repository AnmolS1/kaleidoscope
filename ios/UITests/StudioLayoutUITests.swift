import XCTest

// The size-class layout switch (DESIGN.md §2), asserted on GEOMETRY.
//
// Existence assertions cannot test this. `app.buttons["Glow brush"].exists` is
// true in the rail, in the dock and in the Brush popover — an assertion that
// passes in every layout is asserting nothing. So these tests assert where the
// controls actually ARE:
//
//   rail  the tools hug the leading edge and stack DOWNWARD
//   dock  the tools hug the bottom edge and run ACROSS
//
// The two claims are mutually exclusive by construction, which is what makes
// them discriminating — and it is why they are two CLASSES rather than one.
// Each class asserts its layout unconditionally, so running it against the wrong
// device is a real red. That cross-run is the proof, and both directions are
// recorded in the T12 report:
//
//   StudioRailLayoutUITests → iPad: green   |  iPhone: red
//   StudioDockLayoutUITests → iPhone: green |  iPad:   red
//
// A version that branched on the device at runtime would be green everywhere and
// would therefore be testing nothing.

/// Identifier lookup that does not care what element TYPE SwiftUI chose.
///
/// `accessibilityIdentifier` lands on whatever node SwiftUI produces, and that
/// is not stable across containers: `studio-rail` is an `Other`, `studio-strip`
/// is a `ScrollView`, and `layers-panel` is published on several nodes at once.
/// `app.node("studio-strip")` therefore matched nothing and the test
/// spent ten seconds waiting for an element that was on screen the whole time.
extension XCUIApplication {
    func node(_ identifier: String) -> XCUIElement {
        descendants(matching: .any).matching(identifier: identifier).firstMatch
    }
}

// MARK: - Regular width (iPad): the left rail

final class StudioRailLayoutUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        return app
    }

    func testToolsAreInALeadingRailNotABottomDock() {
        let app = launch()
        let screen = app.frame

        XCTAssertTrue(app.node("studio-rail").waitForExistence(timeout: 10),
                      "regular width must present the rail")
        XCTAssertFalse(app.node("studio-dock").exists,
                       "the dock is a compact-width affordance")

        let brush = app.buttons["Solid brush"]
        let glow = app.buttons["Glow brush"]
        XCTAssertTrue(brush.exists && glow.exists)

        // Against the leading edge: 16pt inset + a 56pt rail, so well inside 80.
        XCTAssertLessThan(brush.frame.minX, 80,
                          "rail tools hug the leading edge; got minX \(brush.frame.minX)")
        // One column, stacking downward.
        XCTAssertGreaterThan(glow.frame.minY, brush.frame.minY, "the rail stacks downward")
        XCTAssertEqual(glow.frame.minX, brush.frame.minX, accuracy: 1, "the rail is one column")
        // And emphatically not a dock.
        XCTAssertLessThan(brush.frame.maxY, screen.height * 0.8,
                          "rail tools must not sit in the dock's band")
    }

    func testEdgeSlidersAreVerticalAndInsetFromTheRightEdge() {
        let app = launch()
        let screen = app.frame

        let size = app.otherElements["Brush size"].firstMatch
        let opacity = app.otherElements["Opacity"].firstMatch
        XCTAssertTrue(size.waitForExistence(timeout: 10), "regular width shows the edge sliders")
        XCTAssertTrue(opacity.exists)

        XCTAssertGreaterThan(size.frame.minX, screen.width * 0.8,
                             "edge sliders live on the right edge")
        XCTAssertGreaterThan(size.frame.height, size.frame.width,
                             "the edge slider is vertical, not a rotated horizontal one")
        // Opacity is the outer of the two columns, so it is the one that carries
        // the 24pt system-gesture inset. (Asserting this against SIZE was the
        // first version of this test and it failed at 90pt — correctly: SIZE sits
        // one 44pt column plus a 22pt gap further in.)
        XCTAssertLessThan(screen.maxX - opacity.frame.maxX, 44,
                          "inset from the right edge, not floating mid-canvas")
        XCTAssertGreaterThan(screen.maxX - opacity.frame.maxX, 8,
                             "but clear of the iPad system-gesture edge")
    }

    func testLayersPanelDocksTrailingAndNeverCoversTheCentre() {
        let app = launch()
        let screen = app.frame

        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.node("layers-panel").waitForExistence(timeout: 5))

        // Measured on the panel's own contents rather than on the container:
        // SwiftUI publishes the identifier on more than one node, so the
        // container query is ambiguous and `.frame` on it throws.
        let addButton = app.buttons["Add layer"]
        let topRow = app.staticTexts["Gold"]
        XCTAssertTrue(addButton.exists && topRow.exists)

        XCTAssertGreaterThan(topRow.frame.minX, screen.midX,
                             "the layers panel docks to the trailing side")
        XCTAssertGreaterThan(addButton.frame.minX, screen.midX)
        // The rule the whole layout obeys: the drawing's centre stays clear.
        let panelBounds = topRow.frame.union(addButton.frame)
        XCTAssertFalse(panelBounds.contains(CGPoint(x: screen.midX, y: screen.midY)),
                       "no panel may cover the drawing's centre (DESIGN.md §2)")
    }

    /// The demo fixture's three layers, read off the panel rather than the canvas
    /// — this is what would catch the panel dropping a row or listing the array
    /// bottom-first.
    func testLayersPanelListsEveryDemoLayerTopFirst() {
        let app = launch()
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.node("layers-panel").waitForExistence(timeout: 5))

        let gold = app.staticTexts["Gold"]
        let ink = app.staticTexts["Ink"]
        let glow = app.staticTexts["Glow"]
        XCTAssertTrue(gold.exists && ink.exists && glow.exists,
                      "all three demo layers should be listed")
        // A stack is read from the top down: Gold is the demo's top layer.
        XCTAssertLessThan(gold.frame.minY, ink.frame.minY)
        XCTAssertLessThan(ink.frame.minY, glow.frame.minY)
    }

    /// The dial is the signature control. What is worth pinning is that it drives
    /// the DOCUMENT: both assertions read the canvas's own spoken value, which is
    /// produced from the model rather than from the dial's view state.
    func testSymmetryDialDrivesTheActiveLayer() {
        let app = launch()
        let canvas = app.otherElements["Drawing canvas"]
        XCTAssertEqual(canvas.value as? String,
                       "9-fold mirror symmetry, 3 strokes, layer Gold of 3",
                       "demo starts on Gold at 9-fold mirrored")

        app.buttons["Symmetry"].firstMatch.tap()
        let dial = app.otherElements["Symmetry segments"].firstMatch
        XCTAssertTrue(dial.waitForExistence(timeout: 5))
        XCTAssertEqual(dial.value as? String, "9 segments, mirrored",
                       "the dial reports the aria-valuetext form from DESIGN.md §3")

        // The centre disc toggles mirror.
        app.buttons["Mirror symmetry"].firstMatch.tap()
        XCTAssertEqual(canvas.value as? String,
                       "9-fold rotational symmetry, 3 strokes, layer Gold of 3",
                       "the centre disc must flip the active layer's mirror flag")

        // Drag the ring from its left extreme to the top. The sweep runs 300°
        // from −240°, so the top of the ring is its midpoint: 3 + 0.5·21 = 13.5,
        // which rounds to 14. Anything but 14 means DialGeometry's forward and
        // inverse mappings disagree.
        dial.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.5))
            .press(forDuration: 0.1,
                   thenDragTo: dial.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.06)))
        XCTAssertEqual(canvas.value as? String,
                       "14-fold rotational symmetry, 3 strokes, layer Gold of 3",
                       "dragging to the top of the ring is the midpoint of the 3…24 sweep")
    }
}

// MARK: - Compact width (iPhone portrait): the bottom dock

final class StudioDockLayoutUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["KALEIDO_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.otherElements["Drawing canvas"].waitForExistence(timeout: 20))
        return app
    }

    func testToolsAreInABottomDockNotALeadingRail() {
        let app = launch()
        let screen = app.frame

        XCTAssertTrue(app.node("studio-dock").waitForExistence(timeout: 10),
                      "compact width must present the dock")
        XCTAssertFalse(app.node("studio-rail").exists,
                       "the rail is a regular-width / compact-height affordance")

        let brush = app.buttons["Solid brush"]
        let glow = app.buttons["Glow brush"]
        XCTAssertTrue(brush.exists && glow.exists)

        XCTAssertGreaterThan(brush.frame.maxY, screen.height * 0.8,
                             "dock tools sit at the bottom; got maxY \(brush.frame.maxY)")
        XCTAssertGreaterThan(glow.frame.minX, brush.frame.minX, "the dock runs horizontally")
        XCTAssertEqual(glow.frame.minY, brush.frame.minY, accuracy: 1, "the dock is one row")
        XCTAssertFalse(app.otherElements["Brush size"].exists,
                       "the phone reaches size through the strip's chip, not an edge slider")
    }

    /// The strip is the phone's settings surface: swatches inline, values as chips
    /// that open a sheet.
    func testStripShowsPaletteInlineAndOpensBrushSettings() {
        let app = launch()
        XCTAssertTrue(app.node("studio-strip").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["teal"].exists,
                      "the phone strip shows the palette inline, with its spoken colour names")
        XCTAssertTrue(app.buttons["crane orange"].exists)

        // The strip scrolls, and the value chips sit past the palette on a
        // 430pt-wide phone — so scroll before tapping rather than asking XCUITest
        // to hit an element that is genuinely off screen.
        app.node("studio-strip").swipeLeft()
        app.buttons["Brush size"].firstMatch.tap()
        XCTAssertTrue(app.node("brush-popover").waitForExistence(timeout: 5),
                      "the size chip opens brush settings")
    }

    /// Layers on a phone arrive as a sheet, not a docked card — but they still
    /// list every layer.
    func testLayersSheetListsEveryDemoLayer() {
        let app = launch()
        app.buttons["Layers"].firstMatch.tap()
        XCTAssertTrue(app.node("layers-panel").waitForExistence(timeout: 5))
        for name in ["Gold", "Ink", "Glow"] {
            XCTAssertTrue(app.staticTexts[name].exists, "layers sheet should list \(name)")
        }
    }
}
