import XCTest
@testable import KaleidoEngine

final class SymmetryTests: XCTestCase {
    func testImageCount() {
        XCTAssertEqual(imageCount(segments: 6, mirror: false), 6)  // cyclic C_6
        XCTAssertEqual(imageCount(segments: 6, mirror: true), 12)  // dihedral D_6
        XCTAssertEqual(imageCount(segments: 3, mirror: false), 3)
        XCTAssertEqual(imageCount(segments: 24, mirror: true), 48)
    }

    func testImageOrderCyclic() {
        let imgs = symmetryImages(segments: 3, mirror: false)
        XCTAssertEqual(imgs.count, 3)
        XCTAssertEqual(imgs.map(\.index), [0, 1, 2])
        XCTAssertTrue(imgs.allSatisfy { !$0.mirror })
        let step = (Double.pi * 2) / 3
        for (i, img) in imgs.enumerated() {
            XCTAssertEqual(img.angle, Double(i) * step, accuracy: 1e-12)
        }
    }

    func testImageOrderDihedral_rotationsThenReflections() {
        let imgs = symmetryImages(segments: 4, mirror: true)
        XCTAssertEqual(imgs.count, 8)
        XCTAssertEqual(imgs.map(\.index), [0, 1, 2, 3, 4, 5, 6, 7])
        // First n are pure rotations, then n reflected — order is load-bearing.
        XCTAssertEqual(imgs.prefix(4).map(\.mirror), [false, false, false, false])
        XCTAssertEqual(imgs.suffix(4).map(\.mirror), [true, true, true, true])
        let step = (Double.pi * 2) / 4
        // Both halves sweep the same angle sequence.
        for i in 0..<4 {
            XCTAssertEqual(imgs[i].angle, Double(i) * step, accuracy: 1e-12)
            XCTAssertEqual(imgs[i + 4].angle, Double(i) * step, accuracy: 1e-12)
        }
    }

    func testClampSegments() {
        XCTAssertEqual(clampSegments(2), 3)
        XCTAssertEqual(clampSegments(30), 24)
        XCTAssertEqual(clampSegments(12), 12)
        XCTAssertEqual(clampSegments(2.4), 3)   // rounds to 2, clamps up to 3
        XCTAssertEqual(clampSegments(6.6), 7)
        XCTAssertEqual(clampSegments(Double.nan), 3)
    }

    func testTransformPointReflectsThenRotates() {
        // No transform: identity.
        let a = transformPoint(x: 1, y: 0, angle: 0, mirror: false)
        XCTAssertEqual(a.x, 1, accuracy: 1e-12)
        XCTAssertEqual(a.y, 0, accuracy: 1e-12)

        // Rotate (1,0) by 90°: → (0, 1).
        let b = transformPoint(x: 1, y: 0, angle: .pi / 2, mirror: false)
        XCTAssertEqual(b.x, 0, accuracy: 1e-12)
        XCTAssertEqual(b.y, 1, accuracy: 1e-12)

        // Mirror (1,1) at angle 0: y-negate → (1, -1).
        let c = transformPoint(x: 1, y: 1, angle: 0, mirror: true)
        XCTAssertEqual(c.x, 1, accuracy: 1e-12)
        XCTAssertEqual(c.y, -1, accuracy: 1e-12)
    }
}

final class DeserializeValidationTests: XCTestCase {
    private func assertRejects(_ json: String, _ label: String) {
        XCTAssertThrowsError(try deserialize(json), label) { error in
            XCTAssertTrue(error is DrawingParseError, "\(label): wrong error type \(error)")
        }
    }

    func testAcceptsMinimalValid() throws {
        let d = try deserialize(##"{"v":1,"bg":"light","sym":{"segments":6,"mirror":true},"strokes":[]}"##)
        XCTAssertEqual(d.bg, .light)
        XCTAssertEqual(d.sym.segments, 6)
        XCTAssertTrue(d.sym.mirror)
        XCTAssertTrue(d.strokes.isEmpty)
    }

    func testRejectsMalformed() {
        assertRejects("not json", "invalid JSON")
        assertRejects(##"{"v":2,"bg":"light","sym":{"segments":6,"mirror":true},"strokes":[]}"##, "bad version")
        assertRejects(##"{"v":1,"bg":"blue","sym":{"segments":6,"mirror":true},"strokes":[]}"##, "bad bg")
        // mirror must be a boolean, not a number.
        assertRejects(##"{"v":1,"bg":"light","sym":{"segments":6,"mirror":1},"strokes":[]}"##, "mirror not bool")
        // bad color
        assertRejects(##"{"v":1,"bg":"light","sym":{"segments":6,"mirror":true},"strokes":[{"tool":"solid","color":"red","size":1,"opacity":1,"pts":[]}]}"##, "bad color")
        // bad tool
        assertRejects(##"{"v":1,"bg":"light","sym":{"segments":6,"mirror":true},"strokes":[{"tool":"pencil","color":"#ffffff","size":1,"opacity":1,"pts":[]}]}"##, "bad tool")
        // size must be > 0
        assertRejects(##"{"v":1,"bg":"light","sym":{"segments":6,"mirror":true},"strokes":[{"tool":"solid","color":"#ffffff","size":0,"opacity":1,"pts":[]}]}"##, "bad size")
        // opacity out of range
        assertRejects(##"{"v":1,"bg":"light","sym":{"segments":6,"mirror":true},"strokes":[{"tool":"solid","color":"#ffffff","size":1,"opacity":2,"pts":[]}]}"##, "bad opacity")
        // point must have exactly 3 numbers
        assertRejects(##"{"v":1,"bg":"light","sym":{"segments":6,"mirror":true},"strokes":[{"tool":"solid","color":"#ffffff","size":1,"opacity":1,"pts":[[0,0]]}]}"##, "bad pts")
    }

    func testAcceptsSpectrumColor() throws {
        let d = try deserialize(##"{"v":1,"bg":"dark","sym":{"segments":8,"mirror":false},"strokes":[{"tool":"glow","color":"spectrum","size":5,"opacity":0.7,"pts":[[0,0,0.5]]}]}"##)
        XCTAssertEqual(d.strokes.first?.color, "spectrum")
        XCTAssertEqual(d.strokes.first?.tool, .glow)
    }
}
