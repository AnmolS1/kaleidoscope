// Byte-exact serialization matching src/shared/vector.ts — the definition this
// file conforms to. Two forms are emitted: the canonical v2 storage form and the
// v1 projection still handed to clients that cannot read v2.
//
// CRITICAL: a piece serialized here must be byte-identical to the web output for
// the same drawing, so it interoperates on the shared gallery. We must NOT use
// Swift's `Double` → `String` (it prints "12.0" where JS prints "12" and can
// diverge at exponential thresholds). Instead we:
//   1. round like JS `Math.round`  =  floor(n * 10^d + 0.5)   (half toward +∞),
//   2. format from the resulting scaled INTEGER by hand,
// so "0.5" never becomes "0.50", "12" never "12.0", and "-0" never appears.
// Because both platforms compute the same IEEE product from the same Double,
// floating-point wobble cancels and byte-parity holds. Verified by golden tests
// generated from the web serializer itself (ios/tools/gen-engine-fixtures.ts).

import CryptoKit
import Foundation

enum VectorFormat {
    /// Decimal precision, matching src/shared/vector.ts.
    static let coordDecimals = 3
    static let pressureDecimals = 2
    static let sizeDecimals = 2
    static let opacityDecimals = 3

    /// JS `Math.round(n * 10^d) / 10^d`, returned as the scaled integer
    /// `Math.round(n * 10^d)`. `floor(x + 0.5)` reproduces Math.round for both
    /// signs (e.g. round(-123.5) = -123, round(123.5) = 124).
    static func scaledRound(_ n: Double, _ decimals: Int) -> Int {
        let f = pow(10.0, Double(decimals))
        return Int((n * f + 0.5).rounded(.down))
    }

    /// Render a fixed-decimal number the way JS `Number.prototype.toString` would
    /// for `scaled / 10^decimals`: shortest form, no trailing zeros, no "-0".
    static func format(_ n: Double, _ decimals: Int) -> String {
        formatScaled(scaledRound(n, decimals), decimals)
    }

    static func formatScaled(_ scaled: Int, _ decimals: Int) -> String {
        if decimals == 0 { return String(scaled) }
        let negative = scaled < 0
        var digits = String(scaled.magnitude)
        if digits.count <= decimals {
            digits = String(repeating: "0", count: decimals - digits.count + 1) + digits
        }
        let splitIndex = digits.index(digits.endIndex, offsetBy: -decimals)
        let intPart = String(digits[..<splitIndex])
        var fracPart = String(digits[splitIndex...])
        while fracPart.last == "0" { fracPart.removeLast() }
        let body = fracPart.isEmpty ? intPart : intPart + "." + fracPart
        // `scaled == 0` is never negative (Int has no -0), so a "-0" can't form.
        return negative ? "-" + body : body
    }
}

/// JSON-escape a string exactly as `JSON.stringify` does.
///
/// In v1 this was only ever fed validated hex colors and the literal "spectrum",
/// so it was purely defensive. In v2 LAYER NAMES ARE USER TEXT, so it is now on
/// the byte-parity path and the short escapes have to be complete: `JSON.stringify`
/// emits 0x08 as the two-character escape backslash-b and 0x0C as backslash-f,
/// NOT as the six-character \u0008 / \u000c this function used to fall back to.
/// Getting that wrong produces a different byte string for the same name and
/// therefore a different content hash.
///
/// Everything at or above U+0020 other than `"` and `\` is emitted RAW, including
/// non-ASCII — `JSON.stringify` does not escape U+2028/U+2029 or astral scalars,
/// so neither may we. (ES2019 well-formed stringify escapes lone surrogates, but
/// a Swift `String` cannot hold one.)
private func jsonString(_ s: String) -> String {
    var out = "\""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{0c}": out += "\\f"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 {
                out += String(format: "\\u%04x", ch.value)
            } else {
                out.unicodeScalars.append(ch)
            }
        }
    }
    out += "\""
    return out
}

// ---- serialization --------------------------------------------------------

/// One stroke in canonical form: `tool, color, size, opacity, [po], [sm], pts`.
/// `po`/`sm` are emitted only when set, which is exactly what makes a v1 stroke's
/// bytes unchanged under the v2 writer. Shared by both forms and both versions —
/// the web's `compactStroke` is likewise used by `serialize`, `serializeForHash`
/// and `serializeV1`, so any divergence here would break all three at once.
private func appendStroke(_ stroke: Stroke, to s: inout String) {
    s += "{\"tool\":\(jsonString(stroke.tool.rawValue))"
    s += ",\"color\":\(jsonString(stroke.color))"
    s += ",\"size\":\(VectorFormat.format(stroke.size, VectorFormat.sizeDecimals))"
    s += ",\"opacity\":\(VectorFormat.format(stroke.opacity, VectorFormat.opacityDecimals))"
    if stroke.po { s += ",\"po\":1" }
    if stroke.sm { s += ",\"sm\":1" }
    s += ",\"pts\":["
    for (j, p) in stroke.pts.enumerated() {
        if j > 0 { s += "," }
        let x = VectorFormat.format(p.x, VectorFormat.coordDecimals)
        let y = VectorFormat.format(p.y, VectorFormat.coordDecimals)
        let pr = VectorFormat.format(p.pressure, VectorFormat.pressureDecimals)
        s += "[\(x),\(y),\(pr)]"
    }
    s += "]}"
}

private func appendSym(_ sym: Symmetry, to s: inout String) {
    s += "{\"segments\":\(sym.segments),\"mirror\":\(sym.mirror ? "true" : "false")}"
}

/// Serialize a v1 drawing in the v1 canonical form (mirrors `serializeV1`).
/// Key order `v, bg, sym{segments, mirror}, strokes[…]`, no whitespace.
public func serialize(_ drawing: Drawing) -> String {
    var s = "{\"v\":1,\"bg\":\(jsonString(drawing.bg.rawValue)),\"sym\":"
    appendSym(drawing.sym, to: &s)
    s += ",\"strokes\":["
    for (i, stroke) in drawing.strokes.enumerated() {
        if i > 0 { s += "," }
        appendStroke(stroke, to: &s)
    }
    s += "]}"
    return s
}

/// Canonical v2 storage form. Key order
/// `v, bg, layers[{id, name, visible, opacity, sym, strokes}]`.
public func serialize(_ drawing: DrawingV2) -> String {
    var s = "{\"v\":2,\"bg\":\(jsonString(drawing.bg.rawValue)),\"layers\":["
    for (i, layer) in drawing.layers.enumerated() {
        if i > 0 { s += "," }
        s += "{\"id\":\(jsonString(layer.id))"
        s += ",\"name\":\(jsonString(layer.name))"
        s += ",\"visible\":\(layer.visible ? "true" : "false")"
        s += ",\"opacity\":\(VectorFormat.format(layer.opacity, VectorFormat.opacityDecimals))"
        s += ",\"sym\":"
        appendSym(layer.sym, to: &s)
        s += ",\"strokes\":["
        for (j, stroke) in layer.strokes.enumerated() {
            if j > 0 { s += "," }
            appendStroke(stroke, to: &s)
        }
        s += "]}"
    }
    s += "]}"
    return s
}

/// The render-equivalent projection used for content hashing.
///
/// Drops everything that does not change the picture: layer ids, layer names, the
/// `visible` flag, and hidden layers entirely. Two drawings that LOOK identical
/// therefore hash identically, which is what makes "this exact drawing is already
/// in the gallery" true rather than approximately true — renaming a layer or
/// toggling a hidden one is not a new piece.
///
/// Layer ORDER, per-layer opacity and per-layer symmetry are all kept, because
/// all three change the render.
public func serializeForHash(_ drawing: DrawingV2) -> String {
    var s = "{\"v\":2,\"bg\":\(jsonString(drawing.bg.rawValue)),\"layers\":["
    var first = true
    for layer in drawing.layers where layer.visible {
        if !first { s += "," }
        first = false
        s += "{\"opacity\":\(VectorFormat.format(layer.opacity, VectorFormat.opacityDecimals))"
        s += ",\"sym\":"
        appendSym(layer.sym, to: &s)
        s += ",\"strokes\":["
        for (j, stroke) in layer.strokes.enumerated() {
            if j > 0 { s += "," }
            appendStroke(stroke, to: &s)
        }
        s += "]}"
    }
    s += "]}"
    return s
}

/// SHA-256 of the render-equivalent projection, as lowercase hex.
///
/// Takes the STORED JSON rather than a parsed drawing, so both sides of a
/// comparison necessarily go through the same parse + projection — the web
/// signature is the same for the same reason.
public func contentHash(_ json: String) throws -> String {
    let projected = serializeForHash(try deserializeV2(json))
    return sha256Hex(projected)
}

/// Lowercase hex SHA-256 of a string's UTF-8 bytes.
public func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

// ---- deserialization ------------------------------------------------------

public struct DrawingParseError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

private let hexColor = try! NSRegularExpression(pattern: "^#[0-9a-fA-F]{6}$")

private func isHexColor(_ s: String) -> Bool {
    let range = NSRange(s.startIndex..<s.endIndex, in: s)
    return hexColor.firstMatch(in: s, range: range) != nil
}

/// JSONSerialization represents both booleans and numbers as NSNumber; this
/// distinguishes a real JSON boolean (so `mirror` must be true/false, and numeric
/// fields must NOT be booleans), matching TS `typeof` checks.
private func isBool(_ n: NSNumber) -> Bool {
    CFGetTypeID(n) == CFBooleanGetTypeID()
}

/// Running totals so the caps apply across the whole drawing, not per layer.
private struct Budget {
    var strokes = 0
    var points = 0
}

private func parseSym(_ raw: Any?, _ where_: String) throws -> Symmetry {
    guard let sym = raw as? [String: Any],
          let segNum = sym["segments"] as? NSNumber, !isBool(segNum),
          let mirrorNum = sym["mirror"] as? NSNumber, isBool(mirrorNum)
    else {
        throw DrawingParseError("\(where_): bad sym")
    }
    let segments = segNum.doubleValue
    guard segments == segments.rounded(.towardZero), segments.isFinite,
          segments >= Double(MIN_SEGMENTS), segments <= Double(MAX_SEGMENTS) else {
        throw DrawingParseError("\(where_): bad segments")
    }
    return Symmetry(segments: segNum.intValue, mirror: mirrorNum.boolValue)
}

private func parseStroke(_ sv: Any, _ where_: String, _ budget: inout Budget) throws -> Stroke {
    guard let s = sv as? [String: Any] else { throw DrawingParseError("\(where_): bad stroke") }

    guard let toolStr = s["tool"] as? String, let tool = BrushTool(rawValue: toolStr) else {
        throw DrawingParseError("\(where_): bad tool")
    }
    guard let color = s["color"] as? String, color == "spectrum" || isHexColor(color) else {
        throw DrawingParseError("\(where_): bad color")
    }
    guard let sizeNum = s["size"] as? NSNumber, !isBool(sizeNum),
          sizeNum.doubleValue.isFinite, sizeNum.doubleValue > 0 else {
        throw DrawingParseError("\(where_): bad size")
    }
    guard let opacityNum = s["opacity"] as? NSNumber, !isBool(opacityNum),
          opacityNum.doubleValue.isFinite,
          opacityNum.doubleValue >= 0, opacityNum.doubleValue <= 1 else {
        throw DrawingParseError("\(where_): bad opacity")
    }

    // The flags are strictly the literal 1 when present. Accepting `true` or 0
    // would let two byte-different drawings render alike but hash differently,
    // which breaks dedupe.
    let po = try parseFlag(s["po"], "\(where_): bad po")
    let sm = try parseFlag(s["sm"], "\(where_): bad sm")

    guard let ptsRaw = s["pts"] as? [Any] else { throw DrawingParseError("\(where_): bad pts") }
    budget.points += ptsRaw.count
    if budget.points > MAX_POINTS_TOTAL { throw DrawingParseError("too many points") }

    var pts: [StrokePoint] = []
    pts.reserveCapacity(ptsRaw.count)
    for pv in ptsRaw {
        // A future revision may add tilt as a 5-tuple; a v2 reader must refuse it
        // rather than silently drop the extra channels.
        guard let arr = pv as? [Any], arr.count == 3 else {
            throw DrawingParseError("\(where_): bad pts")
        }
        var nums: [Double] = []
        for c in arr {
            guard let num = c as? NSNumber, !isBool(num), num.doubleValue.isFinite else {
                throw DrawingParseError("\(where_): bad pts")
            }
            nums.append(num.doubleValue)
        }
        pts.append(StrokePoint(x: nums[0], y: nums[1], pressure: nums[2]))
    }

    return Stroke(tool: tool, color: color, size: sizeNum.doubleValue,
                  opacity: opacityNum.doubleValue, po: po, sm: sm, pts: pts)
}

private func parseFlag(_ raw: Any?, _ message: String) throws -> Bool {
    guard let raw else { return false }
    guard let n = raw as? NSNumber, !isBool(n), n.doubleValue == 1 else {
        throw DrawingParseError(message)
    }
    return true
}

/// Parse and structurally validate stored vector JSON, accepting v1 AND v2 and
/// always returning v2. A v1 drawing becomes exactly one layer — visible, opacity
/// 1, id "l1", name "Layer 1" — the same shape a fresh drawing starts as on every
/// platform.
///
/// One clause of the web validator has no Swift equivalent: it rejects lone
/// surrogates in layer names. `JSONSerialization` decodes `"\uD800"` to U+FFFD
/// rather than surfacing the unpaired unit, and a Swift `String` cannot represent
/// one at all, so there is nothing here to reject. A payload carrying one is
/// refused by the Worker (which runs the TS validator) before it is ever stored.
public func deserializeV2(_ json: String) throws -> DrawingV2 {
    // Byte length, not character count: layer names are user text and may be
    // multi-byte, and the cap is a storage cap.
    if json.utf8.count > VECTOR_HARD_CAP_BYTES { throw DrawingParseError("vector too large") }

    guard let data = json.data(using: .utf8) else { throw DrawingParseError("invalid JSON") }
    let rawAny: Any
    do {
        rawAny = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw DrawingParseError("invalid JSON")
    }
    guard let raw = rawAny as? [String: Any] else { throw DrawingParseError("not an object") }

    guard let bgStr = raw["bg"] as? String, let bg = Background(rawValue: bgStr) else {
        throw DrawingParseError("bad bg")
    }
    guard let vNum = raw["v"] as? NSNumber, !isBool(vNum) else {
        throw DrawingParseError("unsupported version")
    }
    var budget = Budget()

    if vNum.doubleValue == 1 {
        let sym = try parseSym(raw["sym"], "drawing")
        guard let strokesRaw = raw["strokes"] as? [Any] else { throw DrawingParseError("bad strokes") }
        budget.strokes = strokesRaw.count
        if budget.strokes > MAX_STROKES_TOTAL { throw DrawingParseError("too many strokes") }
        var strokes: [Stroke] = []
        strokes.reserveCapacity(strokesRaw.count)
        for (i, sv) in strokesRaw.enumerated() {
            strokes.append(try parseStroke(sv, "stroke \(i)", &budget))
        }
        return DrawingV2(bg: bg, layers: [
            Layer(id: "l1", name: "Layer 1", visible: true, opacity: 1, sym: sym, strokes: strokes)
        ])
    }

    guard vNum.doubleValue == 2 else { throw DrawingParseError("unsupported version") }

    guard let layersRaw = raw["layers"] as? [Any] else { throw DrawingParseError("bad layers") }
    if layersRaw.isEmpty { throw DrawingParseError("no layers") }
    if layersRaw.count > MAX_LAYERS { throw DrawingParseError("too many layers") }

    var seenIds = Set<String>()
    var layers: [Layer] = []
    layers.reserveCapacity(layersRaw.count)
    for (i, lv) in layersRaw.enumerated() {
        guard let l = lv as? [String: Any] else { throw DrawingParseError("layer \(i): bad layer") }

        guard let id = l["id"] as? String, isLayerId(id) else {
            throw DrawingParseError("layer \(i): bad id")
        }
        guard seenIds.insert(id).inserted else { throw DrawingParseError("layer \(i): duplicate id") }

        guard let rawName = l["name"] as? String, let name = normalizeLayerName(rawName) else {
            throw DrawingParseError("layer \(i): bad name")
        }
        guard let visibleNum = l["visible"] as? NSNumber, isBool(visibleNum) else {
            throw DrawingParseError("layer \(i): bad visible")
        }
        guard let opacityNum = l["opacity"] as? NSNumber, !isBool(opacityNum),
              opacityNum.doubleValue.isFinite,
              opacityNum.doubleValue >= 0, opacityNum.doubleValue <= 1 else {
            throw DrawingParseError("layer \(i): bad opacity")
        }
        let sym = try parseSym(l["sym"], "layer \(i)")

        guard let strokesRaw = l["strokes"] as? [Any] else {
            throw DrawingParseError("layer \(i): bad strokes")
        }
        budget.strokes += strokesRaw.count
        if budget.strokes > MAX_STROKES_TOTAL { throw DrawingParseError("too many strokes") }
        var strokes: [Stroke] = []
        strokes.reserveCapacity(strokesRaw.count)
        for (j, sv) in strokesRaw.enumerated() {
            strokes.append(try parseStroke(sv, "layer \(i) stroke \(j)", &budget))
        }

        layers.append(Layer(id: id, name: name, visible: visibleNum.boolValue,
                            opacity: opacityNum.doubleValue, sym: sym, strokes: strokes))
    }

    return DrawingV2(bg: bg, layers: layers)
}

/// "l1"…"l8". Written out rather than regex'd because it is on the parse path for
/// every layer of every load.
///
/// Matched over UTF-8 bytes, not Characters. `Character.wholeNumberValue` reads
/// Unicode numeric properties, so it answers 3 for U+0663 ARABIC-INDIC DIGIT
/// THREE and for U+00B3 SUPERSCRIPT THREE — both of which the web's `/^l[1-8]$/`
/// rejects. Accepting one here would let Swift store an id the Worker refuses.
private func isLayerId(_ s: String) -> Bool {
    var bytes = s.utf8.makeIterator()
    guard bytes.next() == UInt8(ascii: "l"), let digit = bytes.next(), bytes.next() == nil else {
        return false
    }
    return digit >= UInt8(ascii: "1") && digit <= UInt8(ascii: "0") + UInt8(MAX_LAYERS)
}

// ---- v1 interop -----------------------------------------------------------

/// Project a v2 drawing back to v1, or nil when that would change the picture.
///
/// Only faithful when every VISIBLE layer shares one symmetry, sits at opacity 1,
/// and carries no `po` or `sm` stroke. Anything else has no v1 representation:
///
///  - Mixed symmetry: v1 has one `sym` for the whole drawing.
///  - Layer opacity < 1: folding it into each stroke's opacity is NOT the same
///    picture. Per-layer compositing flattens the layer once and then blends it;
///    per-stroke opacity blends every stroke separately, so overlapping strokes
///    within the layer darken where they should not.
///  - `po` / `sm`: an old parser requires 3-tuples and knows neither flag, so it
///    would render the stroke as an unsmoothed, uniform-alpha polyline.
///
/// Hidden layers are dropped rather than blocking the flatten — they contribute
/// nothing to the picture, the same reason the hash ignores them.
public func flattenToV1(_ drawing: DrawingV2) -> Drawing? {
    let visible = drawing.layers.filter(\.visible)
    guard let first = visible.first?.sym else {
        return Drawing(bg: drawing.bg, sym: drawing.layers[0].sym, strokes: [])
    }
    for layer in visible {
        if layer.sym != first { return nil }
        if layer.opacity != 1 { return nil }
        for s in layer.strokes where s.po || s.sm { return nil }
    }
    return Drawing(bg: drawing.bg, sym: first, strokes: visible.flatMap(\.strokes))
}

/// v1-facing read: parse (v1 or v2) and project down to v1.
///
/// The mirror of the `src/client/engine/strokes.ts` shim on the web — one parser,
/// two faces — so the app target keeps its v1 API while T11 migrates it. Throws
/// when the drawing has no faithful v1 form, which is the honest answer: silently
/// dropping layers or flattening opacity would hand the caller a different
/// picture than the one on disk.
public func deserialize(_ json: String) throws -> Drawing {
    guard let v1 = flattenToV1(try deserializeV2(json)) else {
        throw DrawingParseError("not representable as v1")
    }
    return v1
}
