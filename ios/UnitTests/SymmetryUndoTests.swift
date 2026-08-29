import XCTest
import KaleidoEngine
@testable import Kaleidoscope

/// Undo granularity for the symmetry dial.
///
/// The ring crosses the whole 3...24 span in one motion, so before coalescing a
/// single sweep left up to 22 undo entries — enough that Undo stopped meaning
/// "take back what I just did" and became "step back through a gesture I
/// experienced as one movement".
///
/// Every test here asserts the VALUE undo lands on, never just the depth.
/// Depth alone passes on a build where the first step of a sweep opened its own
/// entry and the rest merged behind it, which leaves a stray step the user has
/// to undo twice to escape.
final class SymmetryUndoTests: XCTestCase {
    private func sym(_ n: Int, mirror: Bool = true) -> Symmetry {
        Symmetry(segments: n, mirror: mirror)
    }

    func testASweepIsOneUndoStepAndLandsOnTheCountItStartedAt() {
        let doc = DrawingDoc()
        let id = doc.activeLayerId
        let before = doc.activeLayer.sym.segments

        // Every integer the ring crosses on the way from 12 to 24 — the shape
        // that produced 22 entries before coalescing.
        for v in 13...24 { _ = doc.setLayerSym(id, sym(v), coalesce: true) }
        doc.endSymGesture()

        XCTAssertEqual(doc.activeLayer.sym.segments, 24)
        XCTAssertTrue(doc.undo())
        XCTAssertEqual(doc.activeLayer.sym.segments, before,
                       "undo must land on the count the gesture started at, not its second step")
        XCTAssertFalse(doc.canUndo, "a sweep must leave exactly one entry")
    }

    func testTwoSweepsAreTwoUndoSteps() {
        let doc = DrawingDoc()
        let id = doc.activeLayerId

        // Read the starting count rather than naming it: iOS opens a new drawing
        // at a DIFFERENT fold count from web (8 vs 12), and a test that pinned
        // the literal would be asserting a constant it does not own.
        let before = doc.activeLayer.sym.segments

        for v in [13, 14, 15] { _ = doc.setLayerSym(id, sym(v), coalesce: true) }
        doc.endSymGesture()
        for v in [16, 17] { _ = doc.setLayerSym(id, sym(v), coalesce: true) }
        doc.endSymGesture()

        XCTAssertEqual(doc.activeLayer.sym.segments, 17)
        XCTAssertTrue(doc.undo())
        XCTAssertEqual(doc.activeLayer.sym.segments, 15, "the seal must separate the two sweeps")
        XCTAssertTrue(doc.undo())
        XCTAssertEqual(doc.activeLayer.sym.segments, before)
    }

    func testDiscreteAdjustmentsStaySeparateSteps() {
        // The VoiceOver path, and the control for the sweep above: if
        // coalescing leaked into the uncoalesced call, these three would
        // collapse and the first undo would jump straight back to 12.
        let doc = DrawingDoc()
        let id = doc.activeLayerId
        for v in [13, 14, 15] { _ = doc.setLayerSym(id, sym(v)) }

        XCTAssertTrue(doc.undo())
        XCTAssertEqual(doc.activeLayer.sym.segments, 14)
        XCTAssertTrue(doc.undo())
        XCTAssertEqual(doc.activeLayer.sym.segments, 13)
    }

    func testASweepOnOneLayerNeverMergesIntoASweepOnAnother() {
        let doc = DrawingDoc(nil, layerCap: 8)
        let first = doc.activeLayerId
        guard let second = doc.addLayer() else { return XCTFail("could not add a second layer") }
        XCTAssertNotEqual(second, first)
        let secondBefore = doc.layers.first { $0.id == second }?.sym.segments

        // No seal between them: only the per-layer key separates these.
        _ = doc.setLayerSym(first, sym(20), coalesce: true)
        _ = doc.setLayerSym(second, sym(6), coalesce: true)

        XCTAssertTrue(doc.undo())
        XCTAssertEqual(doc.layers.first { $0.id == second }?.sym.segments, secondBefore,
                       "the second layer's change must be its own entry")
        XCTAssertEqual(doc.layers.first { $0.id == first }?.sym.segments, 20,
                       "and undoing it must not take the first layer's change with it")
    }

    func testTogglingMirrorSealsAnOpenSweep() {
        // The mirror button commits with no key, which resets the coalesce key.
        // That is what stops a sweep, a mirror toggle and a second sweep from
        // collapsing into one entry.
        let doc = DrawingDoc()
        let id = doc.activeLayerId

        _ = doc.setLayerSym(id, sym(18), coalesce: true)
        _ = doc.setLayerSym(id, sym(18, mirror: false))       // the toggle
        _ = doc.setLayerSym(id, sym(20), coalesce: true)

        XCTAssertTrue(doc.undo())
        XCTAssertEqual(doc.activeLayer.sym.segments, 18)
        XCTAssertFalse(doc.activeLayer.sym.mirror)
        XCTAssertTrue(doc.undo())
        XCTAssertTrue(doc.activeLayer.sym.mirror, "the toggle is its own entry")
        XCTAssertEqual(doc.activeLayer.sym.segments, 18)
    }
}
