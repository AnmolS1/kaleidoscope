// Kaleidoscope symmetry groups — the native mirror of src/client/engine/symmetry.ts.
//
// Cyclic C_n = n rotations. Dihedral D_n = n rotations + a reflected copy. The
// reflection is scale(1, -1) applied AFTER the rotation (group element r^i · s).
// The enumeration order is load-bearing: it fixes stroke draw order, which the
// additive "glow" blend depends on — all n pure rotations first, then (if
// dihedral) all n reflected rotations.

import Foundation

public let MIN_SEGMENTS = 3
public let MAX_SEGMENTS = 24

/// Round + clamp a segment count into [3, 24]; a non-finite value collapses to 3.
public func clampSegments(_ n: Double) -> Int {
    guard n.isFinite else { return MIN_SEGMENTS }
    let r = Int(n.rounded())
    return min(MAX_SEGMENTS, max(MIN_SEGMENTS, r))
}

public func clampSegments(_ n: Int) -> Int {
    min(MAX_SEGMENTS, max(MIN_SEGMENTS, n))
}

/// One image of the symmetry group: its draw index, rotation angle (radians),
/// and whether it is the reflected copy.
public struct SymmetryImage: Equatable, Sendable {
    public let index: Int
    public let angle: Double
    public let mirror: Bool
}

/// Number of rendered copies: n (cyclic) or 2n (dihedral).
public func imageCount(segments: Int, mirror: Bool) -> Int {
    mirror ? segments * 2 : segments
}

/// The images of the group, in canonical draw order (all rotations, then all
/// reflected rotations). Mirrors `forEachImage`.
public func symmetryImages(segments: Int, mirror: Bool) -> [SymmetryImage] {
    let step = (Double.pi * 2) / Double(segments)
    var images: [SymmetryImage] = []
    images.reserveCapacity(imageCount(segments: segments, mirror: mirror))
    var index = 0
    for i in 0..<segments {
        images.append(SymmetryImage(index: index, angle: Double(i) * step, mirror: false))
        index += 1
    }
    if mirror {
        for i in 0..<segments {
            images.append(SymmetryImage(index: index, angle: Double(i) * step, mirror: true))
            index += 1
        }
    }
    return images
}

/// Apply one symmetry image's transform to a normalized point. Matches
/// `transformPoint`: reflect (y-negate) first, then rotate — the algebraic
/// equivalent of the renderer's `rotate(angle); scale(1, -1)`.
public func transformPoint(x: Double, y: Double, angle: Double, mirror: Bool) -> (x: Double, y: Double) {
    let ry = mirror ? -y : y
    let cos = Foundation.cos(angle)
    let sin = Foundation.sin(angle)
    return (x * cos - ry * sin, x * sin + ry * cos)
}
