// SVG export — the native mirror of `exportSVG` in src/client/engine/export.ts.
//
// The web and iOS must produce the SAME document for the same drawing, byte for
// byte: a piece exported on either platform should be the same file. That is
// pinned by golden tests generated from the web exporter itself
// (ios/tools/gen-engine-fixtures.ts → Fixtures/golden.json, `svg` on every
// fixture plus `svgCases` and `svgNumbers`).
//
// The structure, and every deliberate approximation, is documented on the web
// side and is not repeated here — read the header of `exportSVG`. In short: one
// `<g>` of per-segment `<path>`s per stroke in `<defs>`, one `<g>` per visible
// layer (isolated unless it is the single-visible-layer-at-opacity-1 bypass),
// one `<g transform>` of `<use>`s per symmetry image, glow as
// `mix-blend-mode:screen`, spectrum collapsed to one representative hex.
//
// What IS specific to this file is number formatting. The web builds the
// document with four different JS number→string conversions, and Swift has a
// native equivalent of none of them:
//
//   - `n.toFixed(d)`      coordinates and widths   → `jsToFixed`
//   - `String(Number(n.toFixed(4)))`  opacities    → `svgNumber`
//   - `String(n)` / `${n}`  raw stroke opacity, viewBox → `jsNumberString`
//   - `Math.round(n*1000)/1000` then `${}`  rotation  → `VectorFormat` (exact)
//
// `String(format: "%.2f")` is NOT `toFixed(2)`: libc rounds an exact tie
// half-to-even (1.125 → "1.12") where JS rounds it up ("1.13"), and libc prints
// "-0.00" for -0 where JS prints "0.00". `Double.description` is NOT
// `Number#toString`: "1.0" vs "1", "1e-05" vs "0.00001".

import Foundation

public enum SVGExport {
    /// Half the output edge, matching `exportSVG`'s default `S = 500`.
    public static let defaultHalf = 500

    /// The SVG document for a drawing. Mirrors `exportSVG(drawing, S)`.
    public static func svg(_ drawing: DrawingV2, half S: Int = defaultHalf) -> String {
        let s = Double(S)
        let vb = "\(-S) \(-S) \(2 * S) \(2 * S)"
        let scale = s / REFERENCE_HALF
        var defs = ""
        var groups = ""
        // The same predicate the renderer uses for its direct-paint bypass.
        let visibleLayers = drawing.layers.filter { $0.visible }
        let bypass = visibleLayers.count == 1 && visibleLayers[0].opacity == 1

        for layer in drawing.layers where layer.visible {
            var ids: [String] = []
            // `i` is the stroke's index in the layer, NOT a count of emitted
            // strokes: an empty stroke is skipped but still consumes its index.
            for (i, stroke) in layer.strokes.enumerated() {
                if stroke.pts.isEmpty { continue }
                let id = "\(layer.id)s\(i)"
                ids.append(id)
                let color = representativeColor(stroke)
                let blend = stroke.tool == .glow ? " style=\"mix-blend-mode:screen\"" : ""
                defs += "<g id=\"\(id)\" fill=\"none\" stroke=\"\(color)\" stroke-linecap=\"round\" "
                    + "stroke-linejoin=\"round\" stroke-opacity=\"\(strokeOpacity(stroke))\"\(blend)>"
                    + "\(segmentPaths(stroke, s, scale))</g>"
            }
            if ids.isEmpty { continue }

            var images = ""
            let uses = ids.map { "<use href=\"#\($0)\"/>" }.joined()
            for image in symmetryImages(segments: layer.sym.segments, mirror: layer.sym.mirror) {
                images += "<g transform=\"\(imageTransformSvg(image))\">\(uses)</g>"
            }

            let style = bypass ? "" : " style=\"isolation:isolate\""
            groups += "<g opacity=\"\(svgNumber(layer.opacity))\"\(style)>"
                + "<title>\(xmlEscape(layer.name))</title>\(images)</g>"
        }

        return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"\(vb)\" width=\"\(2 * S)\" height=\"\(2 * S)\">"
            + "<rect x=\"\(-S)\" y=\"\(-S)\" width=\"\(2 * S)\" height=\"\(2 * S)\" fill=\"\(drawing.bg.hex)\"/>"
            + "<defs>\(defs)</defs>"
            + groups
            + "</svg>"
    }

    // MARK: Pieces (each mirrors the same-named web function)

    /// Escapes `& < > " '`, `&` first. Everything else — control characters,
    /// U+2028, astral emoji — passes through raw, exactly as the web's chained
    /// `String#replace` leaves it. Walks scalars rather than using
    /// `replacingOccurrences`, whose matching is not guaranteed literal.
    static func xmlEscape(_ s: String) -> String {
        var out = ""
        out.unicodeScalars.reserveCapacity(s.unicodeScalars.count)
        for ch in s.unicodeScalars {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&apos;"
            default: out.unicodeScalars.append(ch)
            }
        }
        return out
    }

    /// `baseAlpha` in brush.ts: glow's ×0.7 folded in.
    static func baseAlpha(_ stroke: Stroke) -> Double {
        stroke.tool == .glow ? stroke.opacity * 0.7 : stroke.opacity
    }

    /// `meanPressure` in brush.ts — summed in order, then divided.
    static func meanPressure(_ pts: [StrokePoint]) -> Double {
        if pts.isEmpty { return 1 }
        var sum = 0.0
        for p in pts { sum += p.pressure }
        return sum / Double(pts.count)
    }

    /// `strokeOpacity` in export.ts. A plain stroke keeps its stored digits via
    /// `String(stroke.opacity)`; glow and `po` go through `svgNumber`.
    static func strokeOpacity(_ stroke: Stroke) -> String {
        let base = baseAlpha(stroke)
        if !stroke.po {
            return stroke.tool == .glow ? svgNumber(base) : jsNumberString(stroke.opacity)
        }
        return svgNumber(pressureAlpha(opacity: base, pressure: meanPressure(stroke.pts)))
    }

    /// `representativeColor` in brush.ts: a non-spectrum colour is passed through
    /// VERBATIM (case included); spectrum becomes `hslToHex` of the mean point.
    static func representativeColor(_ stroke: Stroke) -> String {
        if stroke.color != "spectrum" { return stroke.color }
        let pts = stroke.pts
        if pts.isEmpty { return "#888888" }
        var sx = 0.0
        var sy = 0.0
        for p in pts {
            sx += p.x
            sy += p.y
        }
        let h = spectrumHue(nx: sx / Double(pts.count), ny: sy / Double(pts.count))
        let rgb = hslToRGB(h: h, s: 85, l: 60)
        return "#" + hexByte(rgb.r) + hexByte(rgb.g) + hexByte(rgb.b)
    }

    /// `Math.round(255 * c).toString(16).padStart(2, "0")`.
    private static func hexByte(_ c: Double) -> String {
        let v = jsRound(255 * c)
        let hex = String(v, radix: 16)
        return hex.count < 2 ? "0" + hex : hex
    }

    /// `imageTransformSvg` in symmetry.ts. Degrees computed in the web's
    /// operation order, rounded with JS `Math.round` semantics to 3dp.
    static func imageTransformSvg(_ image: SymmetryImage) -> String {
        let deg = (image.angle * 180) / Double.pi
        let rot = "rotate(\(VectorFormat.format(deg, 3)))"
        return image.mirror ? "\(rot) scale(1,-1)" : rot
    }

    /// `strokeSegments` in brush.ts: smoothed cubics when the stroke asks and has
    /// an interior, else straight segments copied from the points verbatim.
    static func strokeSegments(_ stroke: Stroke) -> [Cubic?] {
        let pts = stroke.pts
        if pts.count < 2 { return [] }
        if stroke.sm, let cubics = smoothStroke(pts) { return cubics }
        return (0..<(pts.count - 1)).map { _ in nil }
    }

    /// `segmentPaths` in export.ts: one `<path>` per segment, each with its own
    /// pressure-derived width.
    static func segmentPaths(_ stroke: Stroke, _ S: Double, _ scale: Double) -> String {
        let pts = stroke.pts
        func f(_ n: Double) -> String { jsToFixed(n * S, 2) }
        func w(_ p: Double) -> String { jsToFixed(stroke.size * scale * widthFactor(p), 2) }

        if pts.count == 1 {
            let x = f(pts[0].x)
            let y = f(pts[0].y)
            return "<path d=\"M\(x) \(y) L\(x) \(y)\" stroke-width=\"\(w(pts[0].pressure))\"/>"
        }

        var out = ""
        for (k, seg) in strokeSegments(stroke).enumerated() {
            let a = pts[k]
            let b = pts[k + 1]
            var d = "M\(f(a.x)) \(f(a.y))"
            if let c = seg {
                d += "C\(f(c.c1x)) \(f(c.c1y)) \(f(c.c2x)) \(f(c.c2y)) \(f(c.x)) \(f(c.y))"
            } else {
                d += "L\(f(b.x)) \(f(b.y))"
            }
            out += "<path d=\"\(d)\" stroke-width=\"\(w((a.pressure + b.pressure) / 2))\"/>"
        }
        return out
    }

    // MARK: JS number formatting

    /// JS `Math.round` for a non-huge value: nearest integer, ties toward +∞.
    /// `x - floor(x)` is exact, so there is no intermediate rounding (unlike
    /// `floor(x + 0.5)`).
    static func jsRound(_ x: Double) -> Int {
        let lower = x.rounded(.down)
        return Int(x - lower >= 0.5 ? lower + 1 : lower)
    }

    /// JS `Number.prototype.toFixed(d)`.
    ///
    /// The spec picks the integer n minimising |n/10^d − x| over the EXACT value
    /// of x, taking the larger n on a tie (applied to |x|, with the sign put back
    /// afterwards). Darwin's printf also rounds the exact value correctly — the
    /// one disagreement is an exact tie, which it sends to even. An exact tie at
    /// d decimals means |x|·2^(d+1) is an odd integer (the tie is
    /// (2k+1)/(2·10^d), dyadic only when 5^d divides the odd numerator); that
    /// product is exact, so the tie is detected exactly and nudged one ulp up,
    /// which printf then rounds the way JS does. Other differences handled:
    /// -0 prints "0.00" (JS's `x < 0` is false for -0), while a tiny negative
    /// that rounds to zero keeps its sign ("-0.00"), as in JS.
    public static func jsToFixed(_ x: Double, _ d: Int) -> String {
        precondition((0...20).contains(d))
        if !x.isFinite || abs(x) >= 1e21 { return jsNumberString(x) }
        let negative = x < 0
        var a = abs(x)
        let m = a * pow(2.0, Double(d + 1))
        if m == m.rounded(.down), m.truncatingRemainder(dividingBy: 2) == 1 {
            a = a.nextUp
        }
        let body = String(format: "%.\(d)f", a)
        return negative ? "-" + body : body
    }

    /// The web's `svgNumber`: `String(Number(n.toFixed(4)))` — at most 4
    /// decimals, no trailing zeros, no "-0". Taken from the `toFixed` string
    /// rather than re-parsed: a ≤4-decimal literal of this magnitude is its own
    /// shortest round-trip form, so stripping is the same answer without a
    /// second float→string conversion to get wrong.
    public static func svgNumber(_ n: Double) -> String {
        if !n.isFinite { return jsNumberString(n) }
        var s = jsToFixed(n, 4)
        if s.contains("e") { return jsNumberString(Double(s) ?? n) }
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        if s == "-0" { return "0" }
        return s
    }

    /// JS `Number#toString()` (ECMA-262 Number::toString, radix 10).
    ///
    /// Both runtimes pick the shortest digit string that round-trips; they
    /// differ only in how it is laid out. So the digits are taken from Swift's
    /// `description` and re-laid-out by the spec's rules: plain notation for
    /// decimal exponents in (-7, 21], exponent notation ("1e-7", "1.5e+21")
    /// outside, no ".0" on integers, "0" for -0.
    public static func jsNumberString(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        if x.isInfinite { return x < 0 ? "-Infinity" : "Infinity" }
        if x == 0 { return "0" }
        let sign = x < 0 ? "-" : ""
        let desc = abs(x).description // e.g. "0.30000000000000004", "1e-05", "1.5e+16"
        var mantissa = Substring(desc)
        var exp10 = 0
        if let e = desc.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = desc[..<e]
            exp10 = Int(desc[desc.index(after: e)...]) ?? 0
        }
        // digits with the decimal point removed, and where the point was.
        var digits = ""
        var pointPos = mantissa.count
        if let dot = mantissa.firstIndex(of: ".") {
            pointPos = mantissa.distance(from: mantissa.startIndex, to: dot)
            digits = String(mantissa[..<dot]) + String(mantissa[mantissa.index(after: dot)...])
        } else {
            digits = String(mantissa)
        }
        // value = 0.digits × 10^n
        var n = pointPos + exp10
        while digits.hasPrefix("0") {
            digits.removeFirst()
            n -= 1
        }
        while digits.hasSuffix("0") { digits.removeLast() }
        let k = digits.count

        let body: String
        if k <= n && n <= 21 {
            body = digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let idx = digits.index(digits.startIndex, offsetBy: n)
            body = String(digits[..<idx]) + "." + String(digits[idx...])
        } else if -6 < n && n <= 0 {
            body = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let es = e < 0 ? "-\(-e)" : "+\(e)"
            if k == 1 {
                body = digits + "e" + es
            } else {
                body = String(digits.prefix(1)) + "." + String(digits.dropFirst()) + "e" + es
            }
        }
        return sign + body
    }
}

/// The SVG document for a drawing — see `SVGExport.svg`.
public func exportSVG(_ drawing: DrawingV2, half: Int = SVGExport.defaultHalf) -> String {
    SVGExport.svg(drawing, half: half)
}
