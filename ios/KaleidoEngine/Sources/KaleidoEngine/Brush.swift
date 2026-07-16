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
