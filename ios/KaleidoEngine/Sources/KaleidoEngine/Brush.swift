// Brush math — the pure, renderer-agnostic parts of src/client/engine/brush.ts.
// The actual painting (Core Graphics) lives in the app; these helpers keep the
// color/width math identical to the web so spectrum strokes and pressure scaling
// look the same on both platforms.

import Foundation

/// Pressure 0…1 → width multiplier, floored so strokes never vanish.
public func widthFactor(_ pressure: Double) -> Double {
    0.35 + 0.65 * max(0, min(1, pressure))
}

/// Spectrum hue (degrees, 0…360) for a normalized point — hue follows the angle
/// around the center, so a radial scribble rainbows automatically.
public func spectrumHue(nx: Double, ny: Double) -> Double {
    let a = atan2(ny, nx) // -π…π
    return ((a / (Double.pi * 2)) * 360 + 360).truncatingRemainder(dividingBy: 360)
}

/// Linear RGB-ish components in 0…1 (sRGB channel values, as CSS hsl() yields).
public struct RGB: Equatable, Sendable {
    public var r: Double
    public var g: Double
    public var b: Double
    public init(r: Double, g: Double, b: Double) {
        self.r = r
        self.g = g
        self.b = b
    }
}

/// HSL → RGB using the same algorithm as brush.ts `hslToHex` (h in degrees,
/// s and l in 0…100), so spectrum colors match the web exactly.
public func hslToRGB(h: Double, s: Double, l: Double) -> RGB {
    let sN = s / 100
    let lN = l / 100
    let a = sN * min(lN, 1 - lN)
    func f(_ n: Double) -> Double {
        let k = (n + h / 30).truncatingRemainder(dividingBy: 12)
        return lN - a * max(-1, min(k - 3, min(9 - k, 1)))
    }
    return RGB(r: f(0), g: f(8), b: f(4))
}

/// The spectrum color for a normalized point: fixed saturation 85%, lightness
/// 60%, matching the web's `hsla(hue, 85%, 60%)`.
public func spectrumRGB(nx: Double, ny: Double) -> RGB {
    hslToRGB(h: spectrumHue(nx: nx, ny: ny), s: 85, l: 60)
}

/// The single representative hue for a spectrum stroke (average point position),
/// used where a stroke needs one flat color. Mirrors `representativeColor`.
public func representativeSpectrumRGB(points: [StrokePoint]) -> RGB {
    guard !points.isEmpty else { return RGB(r: 0.53, g: 0.53, b: 0.53) } // #888888
    var sx = 0.0
    var sy = 0.0
    for p in points {
        sx += p.x
        sy += p.y
    }
    return hslToRGB(h: spectrumHue(nx: sx / Double(points.count), ny: sy / Double(points.count)), s: 85, l: 60)
}

/// Canvas background colors (hex), matching export.ts / scene.ts THEME.
public extension Background {
    var hex: String {
        switch self {
        case .light: return "#EEF0EC"
        case .dark: return "#13202A"
        }
    }
}

// ---- v2: pressure-scaled alpha -------------------------------------------

/// Alpha for a stroke carrying the `po` flag, at a given pressure.
///
/// The 0.25 floor is deliberate: a stroke whose lightest touch went fully
/// transparent would break up into disconnected blobs, which reads as a rendering
/// fault rather than as pressure. Strokes WITHOUT `po` never call this — they use
/// `opacity` flat, which is v1 behavior and is what keeps every existing gallery
/// piece pixel-identical.
public func pressureAlpha(opacity: Double, pressure: Double) -> Double {
    opacity * (0.25 + 0.75 * max(0, min(1, pressure)))
}

// ---- v2: stroke smoothing (mirrors src/shared/smooth.ts) -----------------

// Centripetal Catmull-Rom (α = 0.5) converted to cubic Béziers.
//
// Why centripetal rather than uniform (α = 0) or chordal (α = 1): pointer
// sampling is uneven — a fast flick leaves points far apart, a slow curl leaves
// them bunched. Uniform Catmull-Rom reacts to that unevenness by overshooting
// and, where two points nearly coincide, forming a visible cusp or a
// self-intersecting loop. Centripetal parameterization is the variant proven to
// produce neither for any input spacing, which is what makes it safe to apply to
// strokes we did not sample ourselves.
//
// The output is deliberately per-segment: one cubic from pts[i] to pts[i+1],
// tagged with i. Width and spectrum hue already vary per segment in the polyline
// renderer and must keep varying identically, so the smoothed path preserves the
// same segment boundaries rather than collapsing the stroke into one long path.

/// A cubic Bézier from source point `i` to source point `i + 1`.
public struct Cubic: Equatable, Sendable {
    /// Index of the source point this segment starts at.
    public let i: Int
    /// First control point.
    public let c1x: Double
    public let c1y: Double
    /// Second control point.
    public let c2x: Double
    public let c2y: Double
    /// End point — equals the source point at `i + 1`.
    public let x: Double
    public let y: Double

    public init(i: Int, c1x: Double, c1y: Double, c2x: Double, c2y: Double, x: Double, y: Double) {
        self.i = i
        self.c1x = c1x
        self.c1y = c1y
        self.c2x = c2x
        self.c2y = c2y
        self.x = x
        self.y = y
    }
}

/// Centripetal exponent. α = 0.5 is the whole point; see above.
public let SMOOTH_ALPHA: Double = 0.5

// Knot spans below this are treated as a coincident point. Coordinates are
// normalized to ~[-1, 1] and capture already drops moves under ~1.1px, so this
// only fires on hand-authored or pathological input — where its only job is to
// keep the arithmetic finite instead of producing NaN, which renders as nothing
// at all.
private let SMOOTH_EPS = 1e-9

/// Centripetal knot span between two points: |P1 - P0|^α, with α = 0.5.
private func knotSpan(_ ax: Double, _ ay: Double, _ bx: Double, _ by: Double) -> Double {
    let d = sqrt(hypot(bx - ax, by - ay))
    return d < SMOOTH_EPS ? SMOOTH_EPS : d
}

/// Build the smoothed path for a stroke's points.
///
/// Returns one cubic per source segment, in order. Fewer than 3 points has no
/// interior to smooth, so it returns nil and the caller draws the polyline it
/// would have drawn anyway — matching the rule that v1 strokes, which never carry
/// `sm`, keep rendering as polylines forever.
///
/// Tangents are computed once per POINT, as the knot-weighted average of the two
/// adjoining chord velocities, then scaled into each segment by that segment's
/// own knot span. Neighbouring segments therefore share a tangent direction while
/// having their own magnitude: the curve is G1 (visually smooth at every join)
/// rather than C1. Asserting C1 here would be asserting something false.
///
/// The first and last points have only one neighbour, so they take the one-sided
/// chord velocity. NOTE: PLAN §2.2 specified "endpoints duplicated" instead.
/// Duplicating a point makes its knot span zero, which turns the interior tangent
/// formula into 0/0; clamping that with an epsilon yields a tangent of
/// approximately-but-not-exactly zero, so the first control point lands on
/// -0.6199999998797687 where it should be -0.62. That residue is both a flat
/// start to every stroke and a cross-platform parity hazard — precisely the kind
/// of near-miss this port exists to rule out. The web took the one-sided chord
/// (T01, flagged for M1) and this follows it, because the two implementations
/// agreeing is the requirement.
public func smoothStroke(_ pts: [StrokePoint]) -> [Cubic]? {
    let n = pts.count
    if n < 3 { return nil }

    // Knot span for each segment k → k+1.
    var span = [Double](repeating: 0, count: n - 1)
    for k in 0..<(n - 1) {
        span[k] = knotSpan(pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y)
    }

    // Velocity (tangent per unit knot) at each point.
    var vx = [Double](repeating: 0, count: n)
    var vy = [Double](repeating: 0, count: n)

    vx[0] = (pts[1].x - pts[0].x) / span[0]
    vy[0] = (pts[1].y - pts[0].y) / span[0]
    vx[n - 1] = (pts[n - 1].x - pts[n - 2].x) / span[n - 2]
    vy[n - 1] = (pts[n - 1].y - pts[n - 2].y) / span[n - 2]

    for k in 1..<(n - 1) {
        let dPrev = span[k - 1]
        let dNext = span[k]
        // Chord velocities either side of the point.
        let inX = (pts[k].x - pts[k - 1].x) / dPrev
        let inY = (pts[k].y - pts[k - 1].y) / dPrev
        let outX = (pts[k + 1].x - pts[k].x) / dNext
        let outY = (pts[k + 1].y - pts[k].y) / dNext
        // Weighted toward the SHORTER side, which is what keeps a tight corner
        // from being smoothed into a bulge that leaves the points' bounding box.
        let total = dPrev + dNext
        vx[k] = (inX * dNext + outX * dPrev) / total
        vy[k] = (inY * dNext + outY * dPrev) / total
    }

    var out: [Cubic] = []
    out.reserveCapacity(n - 1)
    for k in 0..<(n - 1) {
        let d = span[k] / 3
        out.append(Cubic(
            i: k,
            c1x: pts[k].x + vx[k] * d,
            c1y: pts[k].y + vy[k] * d,
            c2x: pts[k + 1].x - vx[k + 1] * d,
            c2y: pts[k + 1].y - vy[k + 1] * d,
            x: pts[k + 1].x,
            y: pts[k + 1].y
        ))
    }
    return out
}
