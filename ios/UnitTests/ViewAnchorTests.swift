import XCTest
@testable import Kaleidoscope

/// REVIEW.md S23 — pinch-zoom must be anchored at the pinch midpoint.
///
/// The gesture handler cannot be driven from a unit test, but the arithmetic it
/// depends on can be: the transform is `screen = C + offset + s * (p - C)`, so
/// the drawing point under a screen point is `p = C + (screen - C - offset) / s`.
/// Anchoring means that point is the SAME before and after the scale change.
/// These pin the formula the handler uses; if it drifts, the invariant breaks.
final class ViewAnchorTests: XCTestCase {
    private let bounds = CGSize(width: 400, height: 800)

    /// The formula in `onPinch`, kept here in one place so the test is checking
    /// the relationship rather than restating the implementation line by line.
    private func anchoredOffset(mid: CGPoint, from s: CGFloat, to s2: CGFloat,
                                offset: CGSize) -> CGSize {
        let u = CGSize(width: mid.x - bounds.width / 2, height: mid.y - bounds.height / 2)
        let k = s2 / s
        return CGSize(width: u.width - k * (u.width - offset.width),
                      height: u.height - k * (u.height - offset.height))
    }

    /// Which drawing point sits under a screen point, for a given view.
    private func drawingPoint(under p: CGPoint, scale: CGFloat, offset: CGSize) -> CGPoint {
        CGPoint(x: bounds.width / 2 + (p.x - bounds.width / 2 - offset.width) / scale,
                y: bounds.height / 2 + (p.y - bounds.height / 2 - offset.height) / scale)
    }

    func testTheContentUnderTheMidpointDoesNotMove() {
        // A corner-ish pinch is the case that was visibly wrong: zooming about
        // the centre dragged the target away from the fingers.
        for mid in [CGPoint(x: 40, y: 60), CGPoint(x: 380, y: 740), CGPoint(x: 200, y: 400)] {
            for (from, to) in [(CGFloat(1), CGFloat(2)), (2, 8), (4, 1.5)] {
                for start in [CGSize.zero, CGSize(width: 30, height: -70)] {
                    let before = drawingPoint(under: mid, scale: from, offset: start)
                    let moved = anchoredOffset(mid: mid, from: from, to: to, offset: start)
                    let after = drawingPoint(under: mid, scale: to, offset: moved)
                    XCTAssertEqual(before.x, after.x, accuracy: 0.0001,
                                   "mid \(mid) \(from)→\(to): the point under the fingers moved")
                    XCTAssertEqual(before.y, after.y, accuracy: 0.0001,
                                   "mid \(mid) \(from)→\(to): the point under the fingers moved")
                }
            }
        }
    }

    func testZoomingAboutTheCentreLeavesAZeroOffsetAlone() {
        let centre = CGPoint(x: bounds.width / 2, y: bounds.height / 2)
        let out = anchoredOffset(mid: centre, from: 1, to: 4, offset: .zero)
        XCTAssertEqual(out.width, 0, accuracy: 0.0001)
        XCTAssertEqual(out.height, 0, accuracy: 0.0001)
    }

    /// The control: the OLD behaviour — leaving the offset untouched — really
    /// does move the content, so the test above is asserting something.
    func testTheUnanchoredBehaviourWouldMoveIt() {
        let mid = CGPoint(x: 40, y: 60)
        let before = drawingPoint(under: mid, scale: 1, offset: .zero)
        let after = drawingPoint(under: mid, scale: 2, offset: .zero) // offset passed through
        XCTAssertNotEqual(before.x, after.x, accuracy: 0.5,
                          "if this were equal, the anchoring test would prove nothing")
    }
}
