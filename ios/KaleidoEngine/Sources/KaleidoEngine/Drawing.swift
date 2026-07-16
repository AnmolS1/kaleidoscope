// The vector stroke model — the native mirror of src/client/engine/strokes.ts.
// Coordinates are normalized to the canvas's shorter HALF-axis with the origin
// at center, so the same data renders crisp at any resolution. Stroke sizes are
// px at REFERENCE_HALF; renderers scale by (actualHalf / REFERENCE_HALF).

import Foundation

/// Reference half-axis (px). A stroke size of N renders N px when the canvas's
/// shorter half-axis equals this.
public let REFERENCE_HALF: Double = 1000

public enum Background: String, Sendable {
    case light
    case dark
}

public enum BrushTool: String, Sendable {
    case solid
    case glow
}

/// A single sampled point: normalized x, y (~[-1, 1] on the shorter half-axis)
/// and pressure (0…1). Serializes as the 3-tuple `[x, y, pressure]`.
public struct StrokePoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var pressure: Double

    public init(x: Double, y: Double, pressure: Double) {
        self.x = x
        self.y = y
        self.pressure = pressure
    }
}

public struct Stroke: Equatable, Sendable {
    public var tool: BrushTool
    /// "#RRGGBB" or the literal "spectrum".
    public var color: String
    /// px at REFERENCE_HALF resolution.
    public var size: Double
    /// 0…1
    public var opacity: Double
    public var pts: [StrokePoint]

    public init(tool: BrushTool, color: String, size: Double, opacity: Double, pts: [StrokePoint]) {
        self.tool = tool
        self.color = color
        self.size = size
        self.opacity = opacity
        self.pts = pts
    }
}

public struct Symmetry: Equatable, Sendable {
    public var segments: Int
    public var mirror: Bool

    public init(segments: Int, mirror: Bool) {
        self.segments = segments
        self.mirror = mirror
    }
}

public struct Drawing: Equatable, Sendable {
    /// Schema version — always 1.
    public let v = 1
    public var bg: Background
    public var sym: Symmetry
    public var strokes: [Stroke]

    public init(bg: Background, sym: Symmetry, strokes: [Stroke] = []) {
        self.bg = bg
        self.sym = sym
        self.strokes = strokes
    }
}

public func emptyDrawing(bg: Background, sym: Symmetry) -> Drawing {
    Drawing(bg: bg, sym: sym, strokes: [])
}

// ---- coordinate transforms (mirror strokes.ts) ----------------------------

/// Shorter half-axis in pixels for a canvas of the given size.
public func halfAxis(width: Double, height: Double) -> Double {
    min(width, height) / 2
}

/// Canvas pixel (relative to top-left) → normalized, center origin.
public func toNormalized(px: Double, py: Double, width: Double, height: Double) -> (x: Double, y: Double) {
    let half = halfAxis(width: width, height: height)
    return ((px - width / 2) / half, (py - height / 2) / half)
}

/// Normalized, center origin → canvas pixel (relative to top-left).
public func toPixel(nx: Double, ny: Double, width: Double, height: Double) -> (x: Double, y: Double) {
    let half = halfAxis(width: width, height: height)
    return (width / 2 + nx * half, height / 2 + ny * half)
}

/// Distinct non-"spectrum" colors used, in first-seen order.
public func paletteOf(_ drawing: Drawing) -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    for s in drawing.strokes where s.color != "spectrum" {
        if seen.insert(s.color).inserted { out.append(s.color) }
    }
    return out
}
