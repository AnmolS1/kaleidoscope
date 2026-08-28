import XCTest
@testable import KaleidoEngine

/// Validator and model rules for v2, mirroring `src/shared/vector.ts`.
///
/// These are Swift-behavior assertions rather than byte-parity ones: a rejection
/// cannot be generated into golden.json (the generator would throw), so the rules
/// are restated here and kept honest by reading the shared module. Anything that
/// CAN be generated lives in golden.json instead.
final class VectorV2Tests: XCTestCase {

    // ---- layer names -------------------------------------------------------

    /// The web checks `name.length`, which counts UTF-16 CODE UNITS. An astral
    /// emoji costs 2, so 20 of them sit exactly on the limit and 21 do not.
    /// `name.count` (graphemes) would accept both; `unicodeScalars.count` would
    /// accept 40 emoji. Both would then produce names the Worker rejects.
    func testLayerNameLimitCountsUTF16CodeUnits() {
        XCTAssertEqual(normalizeLayerName(String(repeating: "😀", count: 20)),
                       String(repeating: "😀", count: 20), "40 code units is legal")
        XCTAssertNil(normalizeLayerName(String(repeating: "😀", count: 21)), "42 code units is not")
        XCTAssertEqual(normalizeLayerName(String(repeating: "a", count: 40))?.count, 40)
        XCTAssertNil(normalizeLayerName(String(repeating: "a", count: 41)))
    }

    /// NFC runs BEFORE the length check, because normalization changes the count.
    /// 40 decomposed "é" is 80 code units and would be rejected if measured first;
    /// composed it is 40 and legal.
    func testLayerNameNormalizesToNFCBeforeMeasuring() throws {
        let decomposed = String(repeating: "e\u{0301}", count: 40)
        XCTAssertEqual(decomposed.utf16.count, 80)
        let normalized = try XCTUnwrap(normalizeLayerName(decomposed), "80 decomposed units, 40 composed")
        XCTAssertEqual(normalized.utf16.count, 40)
        XCTAssertEqual(normalized, String(repeating: "\u{00e9}", count: 40))
    }

    func testLayerNameRejectsControlCharacters() {
        for scalar: Unicode.Scalar in ["\u{00}", "\u{01}", "\u{08}", "\u{09}", "\u{0a}", "\u{0d}",
                                       "\u{0c}", "\u{1f}", "\u{7f}", "\u{80}", "\u{85}", "\u{9f}"] {
            XCTAssertNil(normalizeLayerName("a\(Character(scalar))b"),
                         "U+\(String(format: "%04X", scalar.value)) must not be storable in a name")
        }
    }

    /// Vacuously "printable scalars only", and refusing it would fail a whole save
    /// over something the UI can simply render blank. Matches the web.
    func testEmptyLayerNameIsAllowed() {
        XCTAssertEqual(normalizeLayerName(""), "")
    }

    /// U+2028 and U+2029 are separators, not controls: legal in a name, and
    /// emitted raw by both serializers.
    func testLayerNameAllowsLineAndParagraphSeparators() {
        XCTAssertEqual(normalizeLayerName("a\u{2028}b"), "a\u{2028}b")
        XCTAssertEqual(normalizeLayerName("a\u{2029}b"), "a\u{2029}b")
    }

    // ---- layer ids ---------------------------------------------------------

    func testNextLayerIdTakesTheLowestUnused() throws {
        let sym = Symmetry(segments: 6, mirror: false)
        func layers(_ ids: [String]) -> [Layer] { ids.map { Layer(id: $0, name: "", sym: sym) } }
        XCTAssertEqual(try nextLayerId([]), "l1")
        XCTAssertEqual(try nextLayerId(layers(["l1", "l2"])), "l3")
        // The lowest UNUSED, not the next after the highest — so deleting a layer
        // and adding one gives the same document the same id on every platform.
        XCTAssertEqual(try nextLayerId(layers(["l1", "l3"])), "l2")
        XCTAssertThrowsError(try nextLayerId(layers((1...8).map { "l\($0)" })))
    }

    // ---- deserialization rejections ---------------------------------------

    private func v2(layers: String, bg: String = "light") -> String {
        "{\"v\":2,\"bg\":\"\(bg)\",\"layers\":[\(layers)]}"
    }

    private let okLayer =
        "{\"id\":\"l1\",\"name\":\"A\",\"visible\":true,\"opacity\":1," +
        "\"sym\":{\"segments\":6,\"mirror\":false},\"strokes\":[]}"

    private func layer(id: String, sym: Int = 6) -> String {
        "{\"id\":\"\(id)\",\"name\":\"A\",\"visible\":true,\"opacity\":1," +
        "\"sym\":{\"segments\":\(sym),\"mirror\":false},\"strokes\":[]}"
    }

    private func assertRejects(_ json: String, _ what: String,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try deserializeV2(json), what, file: file, line: line)
    }

    func testAcceptsAWellFormedV2Document() throws {
        let d = try deserializeV2(v2(layers: okLayer))
        XCTAssertEqual(d.layers.count, 1)
        XCTAssertEqual(d.bg, .light)
    }

    func testRejectsBadLayerIdsAndDuplicates() {
        assertRejects(v2(layers: layer(id: "l0")), "l0 is out of range")
        assertRejects(v2(layers: layer(id: "l9")), "l9 is out of range")
        assertRejects(v2(layers: layer(id: "layer1")), "ids are positional, not free text")
        // The web matches /^l[1-8]$/, which is ASCII. A digit-shaped scalar from
        // another script satisfies Swift's `wholeNumberValue` but not that regex,
        // so accepting one here would let Swift store an id the Worker rejects.
        assertRejects(v2(layers: layer(id: "l\u{0663}")), "Arabic-Indic three is not a layer id")
        assertRejects(v2(layers: layer(id: "l\u{00b3}")), "superscript three is not a layer id")
        assertRejects(v2(layers: "\(layer(id: "l1")),\(layer(id: "l1"))"),
                      "duplicate ids would make the hash projection ambiguous")
    }

    func testRejectsLayerCountOutOfRange() {
        assertRejects("{\"v\":2,\"bg\":\"light\",\"layers\":[]}", "a drawing needs a layer")
        let nine = (1...9).map { layer(id: "l\($0)") }.joined(separator: ",")
        assertRejects(v2(layers: nine), "9 layers exceeds the cap")
    }

    func testRejectsSegmentsOutsideThreeToTwentyFour() {
        assertRejects(v2(layers: layer(id: "l1", sym: 2)), "2 segments")
        assertRejects(v2(layers: layer(id: "l1", sym: 25)), "25 segments")
        assertRejects(v2(layers: "{\"id\":\"l1\",\"name\":\"A\",\"visible\":true,\"opacity\":1," +
                                 "\"sym\":{\"segments\":6.5,\"mirror\":false},\"strokes\":[]}"),
                      "a fractional segment count")
    }

    func testRejectsBadNamesVisibilityAndOpacity() {
        assertRejects(v2(layers: "{\"id\":\"l1\",\"name\":\"a\\u0001b\",\"visible\":true,\"opacity\":1," +
                                 "\"sym\":{\"segments\":6,\"mirror\":false},\"strokes\":[]}"),
                      "control character in a name")
        assertRejects(v2(layers: "{\"id\":\"l1\",\"name\":\"A\",\"visible\":1,\"opacity\":1," +
                                 "\"sym\":{\"segments\":6,\"mirror\":false},\"strokes\":[]}"),
                      "visible must be a real boolean, not 1")
        assertRejects(v2(layers: "{\"id\":\"l1\",\"name\":\"A\",\"visible\":true,\"opacity\":1.5," +
                                 "\"sym\":{\"segments\":6,\"mirror\":false},\"strokes\":[]}"),
                      "opacity above 1")
    }

    /// `po`/`sm` are strictly the literal 1. Accepting `true` or `0` would let two
    /// byte-different drawings render alike but hash differently, which is exactly
    /// the failure dedupe exists to prevent.
    func testPoAndSmMustBeTheLiteralOne() throws {
        func withFlag(_ literal: String) -> String {
            v2(layers: "{\"id\":\"l1\",\"name\":\"A\",\"visible\":true,\"opacity\":1," +
                       "\"sym\":{\"segments\":6,\"mirror\":false},\"strokes\":[" +
                       "{\"tool\":\"solid\",\"color\":\"#123456\",\"size\":1,\"opacity\":1," +
                       "\"po\":\(literal),\"pts\":[[0,0,0]]}]}")
        }
        let ok = try deserializeV2(withFlag("1"))
        XCTAssertTrue(ok.layers[0].strokes[0].po)
        assertRejects(withFlag("true"), "po: true")
        assertRejects(withFlag("0"), "po: 0")
        assertRejects(withFlag("2"), "po: 2")
    }

    /// v2 points are 3-tuples only. A future revision may add tilt as a 5-tuple; a
    /// v2 reader must refuse it rather than silently drop the extra channels.
    func testRejectsPointsThatAreNotThreeTuples() {
        func withPoint(_ literal: String) -> String {
            v2(layers: "{\"id\":\"l1\",\"name\":\"A\",\"visible\":true,\"opacity\":1," +
                       "\"sym\":{\"segments\":6,\"mirror\":false},\"strokes\":[" +
                       "{\"tool\":\"solid\",\"color\":\"#123456\",\"size\":1,\"opacity\":1," +
                       "\"pts\":[\(literal)]}]}")
        }
        assertRejects(withPoint("[0,0]"), "2-tuple")
        assertRejects(withPoint("[0,0,0,0,0]"), "5-tuple")
        assertRejects(withPoint("[0,0,\"1\"]"), "a string channel")
    }

    func testRejectsUnsupportedVersionsAndBackgrounds() {
        assertRejects("{\"v\":3,\"bg\":\"light\",\"layers\":[\(okLayer)]}", "v3")
        assertRejects(v2(layers: okLayer, bg: "sepia"), "an unknown background")
    }

    /// The 256KB cap is measured in BYTES, and is checked before any parsing —
    /// parsing an unbounded payload is the denial-of-service, not storing it.
    func testRejectsPayloadsOverTheByteCap() throws {
        let point = "[0.123,-0.456,0.78],"
        var pts = String(repeating: point, count: VECTOR_HARD_CAP_BYTES / point.count + 64)
        pts.removeLast() // trailing comma
        let big = v2(layers: "{\"id\":\"l1\",\"name\":\"A\",\"visible\":true,\"opacity\":1," +
                             "\"sym\":{\"segments\":6,\"mirror\":false},\"strokes\":[" +
                             "{\"tool\":\"solid\",\"color\":\"#123456\",\"size\":1,\"opacity\":1," +
                             "\"pts\":[\(pts)]}]}")
        XCTAssertGreaterThan(big.utf8.count, VECTOR_HARD_CAP_BYTES)
        assertRejects(big, "over the byte cap")
        // Control: the same shape under the cap parses, so the rejection above is
        // the cap firing and not a malformed payload.
        XCTAssertNoThrow(try deserializeV2(
            v2(layers: "{\"id\":\"l1\",\"name\":\"A\",\"visible\":true,\"opacity\":1," +
                       "\"sym\":{\"segments\":6,\"mirror\":false},\"strokes\":[" +
                       "{\"tool\":\"solid\",\"color\":\"#123456\",\"size\":1,\"opacity\":1," +
                       "\"pts\":[[0.123,-0.456,0.78]]}]}")))
    }

    // ---- v1 interop --------------------------------------------------------

    /// The v1-facing `deserialize` must refuse rather than approximate: silently
    /// dropping a layer or folding opacity would hand the caller a different
    /// picture than the one on disk.
    func testV1FaceThrowsWhenThereIsNoFaithfulV1Form() {
        let mixed = v2(layers: "\(layer(id: "l1", sym: 6)),\(layer(id: "l2", sym: 12))")
        XCTAssertNoThrow(try deserializeV2(mixed))
        XCTAssertThrowsError(try deserialize(mixed), "mixed symmetry has no v1 form")
    }

    /// The v1-facing `deserialize` now accepts v2 input and projects it down —
    /// the mirror of the `strokes.ts` shim on the web. It used to reject `v: 2`
    /// outright.
    func testV1FaceAcceptsV2AndFlattensIt() throws {
        let flat = try deserialize(v2(layers: okLayer))
        XCTAssertEqual(flat.sym, Symmetry(segments: 6, mirror: false))
        XCTAssertEqual(flat.strokes.count, 0)
    }

    func testFlattenToV1RefusesEachNonFaithfulCase() throws {
        let sym = Symmetry(segments: 6, mirror: false)
        let ink = [Stroke(tool: .solid, color: "#123456", size: 1, opacity: 1,
                          pts: [StrokePoint(x: 0, y: 0, pressure: 1)])]

        let base = DrawingV2(bg: .light, layers: [Layer(id: "l1", name: "A", sym: sym, strokes: ink)])
        XCTAssertNotNil(flattenToV1(base), "the plain case must flatten")

        var mixed = base
        mixed.layers.append(Layer(id: "l2", name: "B", sym: Symmetry(segments: 12, mirror: false)))
        XCTAssertNil(flattenToV1(mixed), "mixed symmetry")

        var dimmed = base
        dimmed.layers[0].opacity = 0.5
        XCTAssertNil(flattenToV1(dimmed), "layer opacity < 1")

        var pressured = base
        pressured.layers[0].strokes[0].po = true
        XCTAssertNil(flattenToV1(pressured), "a po stroke")

        var smoothed = base
        smoothed.layers[0].strokes[0].sm = true
        XCTAssertNil(flattenToV1(smoothed), "an sm stroke")

        // A hidden layer never blocks a flatten — it contributes nothing to the
        // picture, the same reason the hash ignores it.
        var hidden = base
        hidden.layers.append(Layer(id: "l2", name: "B", visible: false, opacity: 0.5,
                                   sym: Symmetry(segments: 24, mirror: true), strokes: ink))
        XCTAssertEqual(flattenToV1(hidden).map(serialize), flattenToV1(base).map(serialize))
    }

    // ---- derived metadata --------------------------------------------------

    func testTopSymAndPaletteIgnoreHiddenLayers() {
        let a = Symmetry(segments: 6, mirror: false)
        let b = Symmetry(segments: 12, mirror: true)
        func ink(_ color: String) -> [Stroke] {
            [Stroke(tool: .solid, color: color, size: 1, opacity: 1,
                    pts: [StrokePoint(x: 0, y: 0, pressure: 1)])]
        }
        let d = DrawingV2(bg: .light, layers: [
            Layer(id: "l1", name: "A", sym: a, strokes: ink("#111111")),
            Layer(id: "l2", name: "B", visible: false, opacity: 1, sym: b, strokes: ink("#222222")),
            Layer(id: "l3", name: "C", sym: a, strokes: ink("spectrum") + ink("#111111")),
        ])
        // The hidden layer's disagreeing symmetry must not make the piece
        // "layered", and its color must not reach the palette.
        XCTAssertEqual(topSym(d), a)
        XCTAssertEqual(paletteOf(d), ["#111111"])
        XCTAssertEqual(strokeCount(d), 4, "strokeCount counts hidden layers too")

        var allHidden = d
        for i in allHidden.layers.indices { allHidden.layers[i].visible = false }
        XCTAssertNil(topSym(allHidden), "nothing visible has no symmetry to report")
        XCTAssertEqual(paletteOf(allHidden), [])
    }

    func testEmptyDrawingIsTheV1UpgradeShape() {
        let sym = Symmetry(segments: 9, mirror: true)
        let d = emptyDrawingV2(bg: .dark, sym: sym)
        XCTAssertEqual(serialize(d),
                       "{\"v\":2,\"bg\":\"dark\",\"layers\":[{\"id\":\"l1\",\"name\":\"Layer 1\"," +
                       "\"visible\":true,\"opacity\":1,\"sym\":{\"segments\":9,\"mirror\":true}," +
                       "\"strokes\":[]}]}")
    }

    // ---- pressure ----------------------------------------------------------

    /// The 0.25 floor keeps a light touch visible; without it a stroke would break
    /// into disconnected blobs at low pressure and read as a rendering fault.
    func testPressureAlpha() {
        XCTAssertEqual(pressureAlpha(opacity: 1, pressure: 0), 0.25, accuracy: 1e-12)
        XCTAssertEqual(pressureAlpha(opacity: 1, pressure: 1), 1, accuracy: 1e-12)
        XCTAssertEqual(pressureAlpha(opacity: 0.8, pressure: 0.5), 0.8 * 0.625, accuracy: 1e-12)
        XCTAssertEqual(pressureAlpha(opacity: 1, pressure: -3), 0.25, accuracy: 1e-12)
        XCTAssertEqual(pressureAlpha(opacity: 1, pressure: 9), 1, accuracy: 1e-12)
    }

    func testApplyPressureGamma() {
        XCTAssertEqual(applyPressureGamma(0.5, preset: .normal), 0.5, accuracy: 1e-15)
        XCTAssertEqual(applyPressureGamma(0.5, preset: .light), pow(0.5, 0.6), accuracy: 1e-15)
        XCTAssertEqual(applyPressureGamma(0.5, preset: .firm), pow(0.5, 1.6), accuracy: 1e-15)
        // Clamped first, so an out-of-range reading cannot produce NaN via pow.
        XCTAssertEqual(applyPressureGamma(-1, preset: .light), 0, accuracy: 1e-15)
        XCTAssertEqual(applyPressureGamma(2, preset: .firm), 1, accuracy: 1e-15)
    }
}
