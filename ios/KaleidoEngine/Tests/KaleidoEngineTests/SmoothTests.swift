import XCTest
@testable import KaleidoEngine

/// The smoothing port must produce the same control points as
/// `src/shared/smooth.ts`, because both feed the same picture: a stroke drawn on
/// iOS and the same stroke replayed on the web have to trace the same curve.
///
/// Compared with a tolerance rather than for equality. The two implementations do
/// the same operations in the same order on the same Doubles, but `Math.hypot`
/// and C `hypot` are each allowed their own last-ulp behavior, so demanding exact
/// bits would be asserting something neither language promises. 1e-12 on
/// coordinates normalized to ~[-1, 1] is far below a pixel at any resolution
/// either platform renders at, and still tight enough to catch a wrong formula —
/// the "endpoints duplicated" variant this deliberately does not implement
/// differs in the third decimal place, not the twelfth.
final class SmoothTests: XCTestCase {
    private let tolerance = 1e-12

    private func points(_ raw: [[Double]]) -> [StrokePoint] {
        raw.map { StrokePoint(x: $0[0], y: $0[1], pressure: $0[2]) }
    }

    func testMatchesTheSharedGoldenControlPoints() throws {
        let golden = try loadGolden().smooth
        XCTAssertEqual(golden.alpha, 0.5, "the fixture must be the centripetal variant")
        XCTAssertEqual(golden.alpha, SMOOTH_ALPHA)

        let cubics = try XCTUnwrap(smoothStroke(points(golden.points)),
                                   "the golden stroke has enough points to smooth")
        XCTAssertEqual(cubics.count, golden.cubics.count)
        for (got, want) in zip(cubics, golden.cubics) {
            XCTAssertEqual(got.i, want.i)
            XCTAssertEqual(got.c1x, want.c1x, accuracy: tolerance, "segment \(want.i) c1x")
            XCTAssertEqual(got.c1y, want.c1y, accuracy: tolerance, "segment \(want.i) c1y")
            XCTAssertEqual(got.c2x, want.c2x, accuracy: tolerance, "segment \(want.i) c2x")
            XCTAssertEqual(got.c2y, want.c2y, accuracy: tolerance, "segment \(want.i) c2y")
            XCTAssertEqual(got.x, want.x, accuracy: tolerance, "segment \(want.i) x")
            XCTAssertEqual(got.y, want.y, accuracy: tolerance, "segment \(want.i) y")
        }
    }

    /// One cubic per source segment, ending exactly on the source point — width
    /// and spectrum hue already vary per segment in the polyline renderer and must
    /// keep varying identically, which they only can if the segment boundaries
    /// survive smoothing.
    func testOneCubicPerSegmentEndingOnTheSourcePoints() throws {
        let pts = points([[-0.62, 0.18, 0.2], [-0.4, -0.12, 0.55], [-0.34, -0.2, 0.8], [0.25, -0.05, 1]])
        let cubics = try XCTUnwrap(smoothStroke(pts))
        XCTAssertEqual(cubics.count, pts.count - 1)
        for (k, c) in cubics.enumerated() {
            XCTAssertEqual(c.i, k)
            XCTAssertEqual(c.x, pts[k + 1].x, "a smoothed segment must still end on its source point")
            XCTAssertEqual(c.y, pts[k + 1].y)
        }
    }

    /// Fewer than 3 points has no interior to smooth, so the caller draws the
    /// polyline it would have drawn anyway — the same rule that keeps every v1
    /// stroke (which never carries `sm`) rendering as a polyline forever.
    func testTooFewPointsReturnsNil() {
        XCTAssertNil(smoothStroke([]))
        XCTAssertNil(smoothStroke(points([[0, 0, 1]])))
        XCTAssertNil(smoothStroke(points([[0, 0, 1], [1, 1, 1]])))
    }

    /// G1, not C1: neighbouring segments share a tangent DIRECTION at each join
    /// while each keeps its own magnitude, because each is reparameterized to
    /// [0,1] and scaled by its own knot span. Direction continuity is what makes a
    /// join look smooth; asserting C1 would be asserting something false.
    func testJoinsAreDirectionContinuous() throws {
        let pts = points([[-0.62, 0.18, 0.2], [-0.4, -0.12, 0.55], [-0.34, -0.2, 0.8],
                          [0.25, -0.05, 1], [0.58, 0.42, 0.45]])
        let cubics = try XCTUnwrap(smoothStroke(pts))
        for k in 0..<(cubics.count - 1) {
            // Incoming tangent at the join: P3 - C2. Outgoing: C1 - P0.
            let inX = cubics[k].x - cubics[k].c2x
            let inY = cubics[k].y - cubics[k].c2y
            let outX = cubics[k + 1].c1x - pts[k + 1].x
            let outY = cubics[k + 1].c1y - pts[k + 1].y
            // Cross product zero ⇒ parallel; dot product positive ⇒ same way, not
            // reversed (a cusp would also have a zero cross product).
            let cross = inX * outY - inY * outX
            let dot = inX * outX + inY * outY
            XCTAssertEqual(cross, 0, accuracy: 1e-12, "join \(k + 1) is not direction-continuous")
            XCTAssertGreaterThan(dot, 0, "join \(k + 1) reverses direction (a cusp)")
        }
    }

    /// Coincident points make a centripetal knot span zero. The epsilon clamp is
    /// there only to keep the arithmetic finite — NaN control points render as
    /// nothing at all, which is worse than a slightly wrong curve.
    func testCoincidentPointsStayFinite() throws {
        let cubics = try XCTUnwrap(smoothStroke(points([[0.2, 0.2, 1], [0.2, 0.2, 1], [0.5, 0.4, 1]])))
        for c in cubics {
            XCTAssertTrue(c.c1x.isFinite && c.c1y.isFinite && c.c2x.isFinite && c.c2y.isFinite,
                          "segment \(c.i) produced a non-finite control point")
        }
    }
}
