// The vector stroke model — the native mirror of src/shared/vector.ts, which is
// the definition. That file is compiled by both the web client and the Worker;
// this one is the third implementation and conforms to it byte-for-byte.
//
// Coordinates are normalized to the canvas's shorter HALF-axis with the origin
// at center, so the same data renders crisp at any resolution. Stroke sizes are
// px at REFERENCE_HALF; renderers scale by (actualHalf / REFERENCE_HALF).
//
// v2 adds layers. A v1 drawing is one set of strokes under one symmetry; a v2
// drawing is up to 8 layers each with its own symmetry, name, visibility and
// opacity, plus the two opt-in per-stroke flags `sm` and `po`. Both flags are
// absent on every v1 stroke, which is what keeps existing gallery pieces
// pixel-stable: a v1 piece upgrades to a single layer at opacity 1 with neither
// flag, so it renders through exactly the path it always did.
//
// `Drawing` (v1) and its `serialize`/`deserialize`/`paletteOf` stay as they were
// so the app target keeps compiling while T11 migrates it; the v2 model lives
// alongside under distinct names.

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
    /// v2 `po`: pressure also scales alpha (`opacity * (0.25 + 0.75 * p)`).
    /// False is v1 behavior (width only) and is what every v1 stroke carries.
    /// Serializes as `"po":1` when true and is omitted when false, which is the
    /// mechanism that keeps a v1 stroke's bytes unchanged under the v2 writer.
    public var po: Bool
    /// v2 `sm`: render with the §2.2 smoothing rather than as a polyline.
    /// Same absent-means-v1 rule as `po`. Never retrofitted onto a v1 stroke.
    public var sm: Bool
    public var pts: [StrokePoint]

    /// `po` and `sm` default to false so every existing v1 call site — in the app
    /// target, which this package must not break — keeps compiling unchanged.
    public init(tool: BrushTool, color: String, size: Double, opacity: Double,
                po: Bool = false, sm: Bool = false, pts: [StrokePoint]) {
        self.tool = tool
        self.color = color
        self.size = size
        self.opacity = opacity
        self.po = po
        self.sm = sm
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

// ---- v2: layers ----------------------------------------------------------

public let MAX_LAYERS = 8
/// Layer names are capped in UTF-16 CODE UNITS, not characters — the web checks
/// `name.length`, which counts code units, so an astral-plane emoji costs 2.
public let MAX_LAYER_NAME = 40
public let MAX_STROKES_TOTAL = 5000
public let MAX_POINTS_TOTAL = 200_000

/// Numeric bounds enforced on PARSE — the exact mirror of `src/shared/vector.ts`.
///
/// The format is written by one platform and read by the other, so these are
/// not cosmetic. `Int(_:)` on a large Double is an uncatchable TRAP, so a
/// drawing carrying `1e30` — which the web parser used to accept and the worker
/// stored verbatim — crash-looped every iOS client that opened it.
///
/// `MIN_SIZE` is the rounding grid rather than an aesthetic floor: size
/// serializes to two decimals, so anything smaller writes back as `0`, which
/// the parser then rejects — the drawing destroys itself on the first re-save.
public let MIN_SIZE = 0.01
public let MAX_SIZE = 1_000.0
public let MAX_COORD = 1_000.0
public let VECTOR_HARD_CAP_BYTES = 256 * 1024

public struct Layer: Equatable, Sendable {
    /// Positional and stable within a document: "l1"…"l8". Never random — that
    /// is what lets the hash projection drop ids without changing meaning.
    public var id: String
    public var name: String
    public var visible: Bool
    /// 0…1, applied to the whole layer when compositing.
    public var opacity: Double
    public var sym: Symmetry
    public var strokes: [Stroke]

    public init(id: String, name: String, visible: Bool = true, opacity: Double = 1,
                sym: Symmetry, strokes: [Stroke] = []) {
        self.id = id
        self.name = name
        self.visible = visible
        self.opacity = opacity
        self.sym = sym
        self.strokes = strokes
    }
}

/// Layers are ordered bottom → top.
public struct DrawingV2: Equatable, Sendable {
    /// Schema version — always 2.
    public let v = 2
    public var bg: Background
    public var layers: [Layer]

    public init(bg: Background, layers: [Layer]) {
        self.bg = bg
        self.layers = layers
    }
}

/// A fresh single-layer drawing — the starting state on every platform, and the
/// exact shape a v1 drawing upgrades into.
public func emptyDrawingV2(bg: Background, sym: Symmetry) -> DrawingV2 {
    DrawingV2(bg: bg, layers: [
        Layer(id: "l1", name: "Layer 1", visible: true, opacity: 1, sym: sym, strokes: [])
    ])
}

// ---- layer names ---------------------------------------------------------

/// Validate and normalize a layer name, or return nil if it is not storable.
///
/// NFC first, then the length check — normalization can change the code-unit
/// count, so checking before it would let a 41-unit name through or reject a
/// legal 40-unit one.
///
/// Rejected: C0 controls, DEL, C1 controls.
///
/// The web's fourth clause — reject lone surrogates — has no counterpart HERE,
/// but the outcome still matches, one layer earlier: `JSONSerialization` THROWS
/// on `"\uD800"` ("expected low-surrogate code point but did not find one"),
/// where JS `JSON.parse` accepts it and leaves the unpaired unit for this
/// function to catch. Both platforms therefore reject the same document; only the
/// error message differs. Verified both directions — see
/// `testLoneSurrogateIsRejectedAtTheJSONLayer`.
///
/// The empty string is ALLOWED — vacuously "printable scalars only", and
/// refusing it would fail a whole save over something the UI can render blank.
public func normalizeLayerName(_ raw: String) -> String? {
    let name = raw.precomposedStringWithCanonicalMapping   // NFC
    if name.utf16.count > MAX_LAYER_NAME { return nil }
    for ch in name.unicodeScalars {
        let cp = ch.value
        if cp < 0x20 || cp == 0x7f || (cp >= 0x80 && cp <= 0x9f) { return nil }
    }
    return name
}

/// The lowest unused id in "l1"…"l8". Positional rather than random so two
/// clients that add a layer to the same drawing produce the same id.
public func nextLayerId(_ layers: [Layer]) throws -> String {
    let used = Set(layers.map(\.id))
    for i in 1...MAX_LAYERS where !used.contains("l\(i)") { return "l\(i)" }
    throw DrawingParseError("no free layer id")
}

// ---- derived metadata (v2) -----------------------------------------------

/// Union of non-"spectrum" colors across VISIBLE layers, in first-seen order.
public func paletteOf(_ drawing: DrawingV2) -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    for layer in drawing.layers where layer.visible {
        for s in layer.strokes where s.color != "spectrum" {
            if seen.insert(s.color).inserted { out.append(s.color) }
        }
    }
    return out
}

/// The symmetry to describe the whole piece by: the top-most visible layer's, or
/// nil when visible layers disagree.
///
/// Nil is what makes a piece "layered" in gallery copy and alt text — every
/// consumer of the stored `segments` column has to render that case rather than
/// printing "0-fold symmetry".
public func topSym(_ drawing: DrawingV2) -> Symmetry? {
    let visible = drawing.layers.filter(\.visible)
    guard let top = visible.last?.sym else { return nil }
    for layer in visible where layer.sym != top { return nil }
    return top
}

/// Total stroke count across all layers, visible or not.
public func strokeCount(_ drawing: DrawingV2) -> Int {
    drawing.layers.reduce(0) { $0 + $1.strokes.count }
}

// ---- capture-time pressure ------------------------------------------------

/// Pressure presets, applied at CAPTURE time and stored as the adjusted value.
/// Nothing downstream knows which preset was used, so a drawing does not change
/// appearance when the setting later changes.
public enum PressurePreset: String, Sendable, CaseIterable {
    case light, normal, firm

    public var gamma: Double {
        switch self {
        case .light: return 0.6
        case .normal: return 1
        case .firm: return 1.6
        }
    }
}

/// `p' = clamp(p)^γ`. γ == 1 short-circuits so the common case is exact rather
/// than `pow(p, 1)`, matching the web (which also branches on γ === 1).
public func applyPressureGamma(_ p: Double, preset: PressurePreset) -> Double {
    let clamped = max(0, min(1, p))
    return preset == .normal ? clamped : pow(clamped, preset.gamma)
}

/// Should a new point be kept? Drops near-duplicates to keep payloads small.
/// `minDistNorm` is the minimum move in normalized units.
public func shouldKeepPoint(prev: StrokePoint?, next: StrokePoint, minDistNorm: Double) -> Bool {
    guard let prev else { return true }
    return hypot(next.x - prev.x, next.y - prev.y) >= minDistNorm
}

/// A duplicate's name, truncated to whatever the shared validator accepts, so a
/// 40-unit name duplicated repeatedly can never produce an unsaveable drawing.
///
/// Drops whole `Character`s — extended grapheme clusters.
///
/// 🔴 The previous note here claimed this was PROVABLY the same string the web
/// produced, on the argument that every cut the web rejects is a mid-surrogate-
/// pair cut. That argument only covers surrogate pairs. A cluster made of
/// several scalars — an emoji ZWJ family, a pair of regional indicators, a
/// Devanagari conjunct — has interior boundaries the web's UTF-16 slice would
/// happily cut at and `normalizeLayerName` would happily accept, and there the
/// two answers differed: of seven boundary cases, three (REVIEW.md minor mI7).
///
/// The web now drops clusters too, via `Intl.Segmenter`, because this is the
/// better answer: `👨‍👩` and a lone regional indicator are not names anyone
/// meant. Both sides implement UAX #29, and the boundary cases are pinned in
/// `golden.json` so that agreement is CHECKED rather than argued.
public func copyName(_ name: String) -> String {
    var candidate = "\(name) copy"
    while !candidate.isEmpty {
        if let n = normalizeLayerName(candidate) { return n }
        candidate = String(candidate.dropLast())
    }
    return ""
}
