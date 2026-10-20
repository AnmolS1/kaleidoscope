import XCTest
@testable import KaleidoEngine

/// iOS SVG export must be the web's SVG export, byte for byte.
///
/// Every expectation here is the output of the REAL web `exportSVG`
/// (src/client/engine/export.ts) captured by ios/tools/gen-engine-fixtures.ts —
/// never typed by hand. CI regenerates golden.json and fails on any diff, so a
/// change to the web exporter that is not mirrored here fails one gate or the
/// other.
///
/// Compared as UTF-8 BYTES, not with `String ==`: Swift string equality is
/// canonical equivalence, so "é" and "e\u{301}" compare equal while being
/// different files.
final class SVGExportGoldenTests: XCTestCase {

    private func assertSameBytes(_ got: String, _ want: String, _ label: String,
                                 file: StaticString = #filePath, line: UInt = #line) {
        let g = Array(got.utf8)
        let w = Array(want.utf8)
        guard g != w else { return }
        let i = zip(g, w).enumerated().first(where: { $0.element.0 != $0.element.1 })?.offset
            ?? min(g.count, w.count)
        func around(_ b: [UInt8]) -> String {
            let lo = max(0, i - 60)
            let hi = min(b.count, i + 60)
            return String(decoding: b[lo..<hi], as: UTF8.self)
        }
        XCTFail("\(label): SVG differs from web at byte \(i) (got \(g.count) bytes, want \(w.count))\n"
                + "  got:  …\(around(g))…\n  want: …\(around(w))…", file: file, line: line)
    }

    func testV1FixturesExportTheWebSVG() throws {
        let golden = try loadGolden()
        XCTAssertGreaterThan(golden.v1.count, 0, "no v1 fixtures — this test compared nothing")
        var compared = 0
        for f in golden.v1 {
            // The upgraded bytes, exactly as the generator fed the web exporter.
            let drawing = try deserializeV2(f.upgraded)
            assertSameBytes(exportSVG(drawing), f.svg, "v1 \(f.name)")
            compared += 1
        }
        XCTAssertEqual(compared, golden.v1.count)
    }

    func testV2FixturesExportTheWebSVG() throws {
        let golden = try loadGolden()
        XCTAssertGreaterThan(golden.v2.count, 0, "no v2 fixtures — this test compared nothing")
        var compared = 0
        for f in golden.v2 {
            assertSameBytes(exportSVG(try makeDrawing(f.drawing)), f.svg, "v2 \(f.name)")
            compared += 1
        }
        XCTAssertEqual(compared, golden.v2.count)
    }

    func testSVGOnlyCasesExportTheWebSVG() throws {
        let golden = try loadGolden()
        XCTAssertGreaterThanOrEqual(golden.svgCases.count, 2, "svgCases missing — regenerate golden.json")
        for c in golden.svgCases {
            let drawing = try makeDrawing(c.drawing)
            let got = c.half.map { exportSVG(drawing, half: $0) } ?? exportSVG(drawing)
            assertSameBytes(got, c.expected, "svgCase \(c.name)")
        }
        // The hazards fixture is only worth having if it reaches the branches it
        // was written for. Checked on the WEB output, so a regenerated fixture
        // that quietly lost one fails here rather than passing vacuously.
        let hazards = try XCTUnwrap(golden.svgCases.first { $0.name == "svg-hazards" })
        // A cubic command straight after a coordinate: the smoothed `C` branch.
        // (A bare "C" would also match the pass-through colour #ABCDEF.)
        XCTAssertNotNil(hazards.expected.range(of: #"\dC-?\d"#, options: .regularExpression),
                        "svg-hazards no longer reaches the smoothed (C) branch")
        for needle in ["&amp;", "&lt;", "&quot;", "&apos;", "id=\"l1s2\"", "stroke-width=\"1.13\"",
                       "-15.63", "-0.00", "stroke-opacity=\"1e-7\"", "stroke-opacity=\"0.30000000000000004\"",
                       "isolation:isolate", "mix-blend-mode:screen"] {
            XCTAssertTrue(hazards.expected.contains(needle), "svg-hazards no longer exercises \(needle)")
        }
        XCTAssertFalse(hazards.expected.contains("l1s1"), "the empty stroke must not be emitted")
    }

    // MARK: Formatters, pinned on their own

    func testToFixedMatchesJS() throws {
        let numbers = try loadGolden().svgNumbers
        XCTAssertGreaterThan(numbers.count, 100)
        var ties = 0
        for n in numbers {
            XCTAssertEqual(SVGExport.jsToFixed(n.x, 2), n.fixed2, "toFixed(2) of \(n.x)")
            XCTAssertEqual(SVGExport.jsToFixed(n.x, 4), n.fixed4, "toFixed(4) of \(n.x)")
            if String(format: "%.2f", abs(n.x)) != n.fixed2.trimmingCharacters(in: ["-"]) { ties += 1 }
        }
        // The fixture must contain values where libc and JS actually disagree,
        // or this test cannot tell the custom formatter from printf.
        XCTAssertGreaterThan(ties, 10, "svgNumbers has too few printf/JS disagreements to discriminate")
    }

    func testSvgNumberAndToStringMatchJS() throws {
        for n in try loadGolden().svgNumbers {
            XCTAssertEqual(SVGExport.svgNumber(n.x), n.svg, "svgNumber of \(n.x)")
            XCTAssertEqual(SVGExport.jsNumberString(n.x), n.str, "String(\(n.x))")
        }
    }

    /// -0 cannot ride through JSON (`JSON.stringify(-0)` is "0"), so these are
    /// the values a `node -e` probe printed, pinned directly:
    /// `(-0).toFixed(2)` → "0.00", `String(-0)` → "0".
    func testNegativeZero() {
        XCTAssertEqual(SVGExport.jsToFixed(-0.0, 2), "0.00")
        XCTAssertEqual(SVGExport.jsNumberString(-0.0), "0")
        XCTAssertEqual(SVGExport.svgNumber(-0.0), "0")
    }
}
