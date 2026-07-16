import XCTest
@testable import KaleidoEngine

final class BrushTests: XCTestCase {
    func testWidthFactorFlooredAndClamped() {
        XCTAssertEqual(widthFactor(0), 0.35, accuracy: 1e-12)   // floor so strokes never vanish
        XCTAssertEqual(widthFactor(1), 1.0, accuracy: 1e-12)
        XCTAssertEqual(widthFactor(0.5), 0.675, accuracy: 1e-12)
        XCTAssertEqual(widthFactor(-5), 0.35, accuracy: 1e-12)  // clamped
        XCTAssertEqual(widthFactor(5), 1.0, accuracy: 1e-12)
    }

    func testSpectrumHueFollowsAngle() {
        XCTAssertEqual(spectrumHue(nx: 1, ny: 0), 0, accuracy: 1e-9)
        XCTAssertEqual(spectrumHue(nx: 0, ny: 1), 90, accuracy: 1e-9)
        XCTAssertEqual(spectrumHue(nx: -1, ny: 0), 180, accuracy: 1e-9)
        XCTAssertEqual(spectrumHue(nx: 0, ny: -1), 270, accuracy: 1e-9)
    }

    func testHslToRGBMatchesWebAlgorithm() {
        // hsl(0,85%,60%) → #f04242 in brush.ts hslToHex (240,66,66)/255.
        let red = hslToRGB(h: 0, s: 85, l: 60)
        XCTAssertEqual(red.r, 0.941, accuracy: 0.002)
        XCTAssertEqual(red.g, 0.259, accuracy: 0.002)
        XCTAssertEqual(red.b, 0.259, accuracy: 0.002)

        // Mid-gray sanity: hsl(0,0%,50%) → 0.5,0.5,0.5.
        let gray = hslToRGB(h: 210, s: 0, l: 50)
        XCTAssertEqual(gray.r, 0.5, accuracy: 1e-9)
        XCTAssertEqual(gray.g, 0.5, accuracy: 1e-9)
        XCTAssertEqual(gray.b, 0.5, accuracy: 1e-9)
    }

    func testBackgroundHex() {
        XCTAssertEqual(Background.light.hex, "#EEF0EC")
        XCTAssertEqual(Background.dark.hex, "#13202A")
    }

    func testRepresentativeSpectrumEmptyIsGray() {
        let c = representativeSpectrumRGB(points: [])
        XCTAssertEqual(c.r, 0.53, accuracy: 1e-9)
    }
}
