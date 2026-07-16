// Byte-exact serialization matching src/client/engine/strokes.ts `serialize`.
//
// CRITICAL: a piece serialized here must be byte-identical to the web output for
// the same Drawing, so it interoperates on the shared gallery. We must NOT use
// Swift's `Double` → `String` (it prints "12.0" where JS prints "12" and can
// diverge at exponential thresholds). Instead we:
//   1. round like JS `Math.round`  =  floor(n * 10^d + 0.5)   (half toward +∞),
//   2. format from the resulting scaled INTEGER by hand,
// so "0.5" never becomes "0.50", "12" never "12.0", and "-0" never appears.
// Because both platforms compute the same IEEE product from the same Double,
// floating-point wobble cancels and byte-parity holds. Verified by golden tests.

import Foundation

enum VectorFormat {
    /// Decimal precision, matching strokes.ts.
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

/// JSON-escape a string the way JSON.stringify does (colors are validated hex /
/// "spectrum" so this is defensive, but keeps us honest about the format).
private func jsonString(_ s: String) -> String {
    var out = "\""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
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

/// Serialize a Drawing to the canonical, compact JSON string. Key order is fixed
/// (`v, bg, sym{segments, mirror}, strokes[{tool, color, size, opacity, pts}]`),
/// no whitespace, booleans for `mirror` — matching `JSON.stringify` output.
public func serialize(_ drawing: Drawing) -> String {
    var s = "{\"v\":1,\"bg\":\(jsonString(drawing.bg.rawValue))"
    s += ",\"sym\":{\"segments\":\(drawing.sym.segments),\"mirror\":\(drawing.sym.mirror ? "true" : "false")}"
    s += ",\"strokes\":["
    for (i, stroke) in drawing.strokes.enumerated() {
        if i > 0 { s += "," }
        s += "{\"tool\":\(jsonString(stroke.tool.rawValue))"
        s += ",\"color\":\(jsonString(stroke.color))"
        s += ",\"size\":\(VectorFormat.format(stroke.size, VectorFormat.sizeDecimals))"
        s += ",\"opacity\":\(VectorFormat.format(stroke.opacity, VectorFormat.opacityDecimals))"
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
    s += "]}"
    return s
}

// ---- deserialization (mirror strokes.ts `deserialize`) --------------------

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

/// Parse + structurally validate a serialized drawing. Throws DrawingParseError
/// on anything malformed. Mirrors the client-side validator in strokes.ts (the
/// worker applies the stricter byte-capped validator on save).
public func deserialize(_ json: String) throws -> Drawing {
    guard let data = json.data(using: .utf8) else { throw DrawingParseError("invalid JSON") }
    let rawAny: Any
    do {
        rawAny = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw DrawingParseError("invalid JSON")
    }
    guard let raw = rawAny as? [String: Any] else { throw DrawingParseError("not an object") }

    // v === 1  (must be the number 1, not "1")
    guard let v = raw["v"] as? NSNumber, !isBool(v), v.intValue == 1, v.doubleValue == 1 else {
        throw DrawingParseError("unsupported version")
    }

    guard let bgStr = raw["bg"] as? String, let bg = Background(rawValue: bgStr) else {
        throw DrawingParseError("bad bg")
    }

    guard let sym = raw["sym"] as? [String: Any],
          let segNum = sym["segments"] as? NSNumber, !isBool(segNum),
          let mirrorNum = sym["mirror"] as? NSNumber, isBool(mirrorNum)
    else {
        throw DrawingParseError("bad sym")
    }
    let segments = segNum.intValue
    let mirror = mirrorNum.boolValue

    guard let strokesRaw = raw["strokes"] as? [Any] else { throw DrawingParseError("bad strokes") }
    var strokes: [Stroke] = []
    strokes.reserveCapacity(strokesRaw.count)
    for (i, sv) in strokesRaw.enumerated() {
        guard let s = sv as? [String: Any] else { throw DrawingParseError("stroke \(i): bad") }

        guard let toolStr = s["tool"] as? String, let tool = BrushTool(rawValue: toolStr) else {
            throw DrawingParseError("stroke \(i): bad tool")
        }
        guard let color = s["color"] as? String, color == "spectrum" || isHexColor(color) else {
            throw DrawingParseError("stroke \(i): bad color")
        }
        guard let sizeNum = s["size"] as? NSNumber, !isBool(sizeNum),
              sizeNum.doubleValue.isFinite, sizeNum.doubleValue > 0 else {
            throw DrawingParseError("stroke \(i): bad size")
        }
        guard let opacityNum = s["opacity"] as? NSNumber, !isBool(opacityNum),
              opacityNum.doubleValue >= 0, opacityNum.doubleValue <= 1 else {
            throw DrawingParseError("stroke \(i): bad opacity")
        }
        guard let ptsRaw = s["pts"] as? [Any] else { throw DrawingParseError("stroke \(i): bad pts") }
        var pts: [StrokePoint] = []
        pts.reserveCapacity(ptsRaw.count)
        for pv in ptsRaw {
            guard let arr = pv as? [Any], arr.count == 3 else {
                throw DrawingParseError("stroke \(i): bad pts")
            }
            var nums: [Double] = []
            for c in arr {
                guard let num = c as? NSNumber, !isBool(num), num.doubleValue.isFinite else {
                    throw DrawingParseError("stroke \(i): bad pts")
                }
                nums.append(num.doubleValue)
            }
            pts.append(StrokePoint(x: nums[0], y: nums[1], pressure: nums[2]))
        }

        strokes.append(Stroke(tool: tool, color: color, size: sizeNum.doubleValue,
                              opacity: opacityNum.doubleValue, pts: pts))
    }

    return Drawing(bg: bg, sym: Symmetry(segments: segments, mirror: mirror), strokes: strokes)
}

/// JSONSerialization represents both booleans and numbers as NSNumber; this
/// distinguishes a real JSON boolean (so `mirror` must be true/false, and
/// numeric fields must NOT be booleans), matching TS `typeof` checks.
private func isBool(_ n: NSNumber) -> Bool {
    CFGetTypeID(n) == CFBooleanGetTypeID()
}
