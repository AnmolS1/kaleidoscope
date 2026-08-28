import SwiftUI
import KaleidoEngine

// The studio's layout system (DESIGN.md §2) and the string formatters its
// readouts share.
//
// Three layouts, keyed on size class — NOT on device idiom and NOT on a measured
// width. Idiom is wrong because an iPad in a narrow Split View is a compact-width
// environment and must get the phone chrome; a measured width is wrong because it
// re-implements a decision UIKit already made and then disagrees with it during a
// rotation animation.
//
// Deliberately NOT `ViewThatFits`. Its candidates are measured against the
// proposed size, and every candidate here contains a flexible `Spacer`, so the
// first one always reports as fitting and the fallback is dead code. Dynamic Type
// branches read `dynamicTypeSize.isAccessibilitySize` instead, which is a fact
// about the user's setting rather than about a layout pass.

enum StudioLayout: Equatable {
    /// Regular width (iPad, and iPad-sized Split View): 56pt left rail, floating
    /// popovers anchored to it, edge sliders on the right.
    case rail
    /// Compact width with regular height (phone portrait): 64pt bottom dock and a
    /// scrolling strip above it; settings arrive as bottom sheets.
    case dock
    /// Compact height (phone landscape): a 48pt rail with 40pt buttons, and the
    /// controls hug the safe area so nothing sits under the notch.
    case compactRail

    init(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) {
        // Height is tested first on purpose: a landscape phone is compact in
        // BOTH axes on most devices but regular-width on a Max, and both of them
        // want the short rail rather than a dock eating the little height left.
        if vertical == .compact {
            self = .compactRail
        } else if horizontal == .regular {
            self = .rail
        } else {
            self = .dock
        }
    }

    /// Whether tools live in a vertical rail (rail / compactRail) or a dock.
    var usesRail: Bool { self != .dock }

    /// Whether settings open as floating popovers (true) or bottom sheets.
    var usesPopovers: Bool { self != .dock }

    /// Whether the layers panel docks as its own card. On `dock` it is a sheet.
    var showsEdgeSliders: Bool { self == .rail }

    var metrics: StudioMetrics {
        switch self {
        case .rail: return .regular
        case .dock: return .phonePortrait
        case .compactRail: return .phoneLandscape
        }
    }
}

/// The numbers from DESIGN.md §2, in one place so a frame can be checked against
/// a constant instead of against a literal buried in a view.
struct StudioMetrics {
    /// Rail width (56 regular / 48 compact height).
    var railWidth: CGFloat
    /// Tap target inside the rail. Never below 44 — see the ≥44pt rule in §2.
    var railButton: CGFloat
    /// Rail inset from the screen edges.
    var railInset: CGFloat
    /// Bottom dock height + inset (phone portrait only).
    var dockHeight: CGFloat
    var dockInset: CGFloat
    /// Edge sliders sit 24pt in from the right edge so the drag is not stolen by
    /// the iPad system-gesture edge.
    var edgeInset: CGFloat
    /// Top-left readout capsule height.
    var readoutHeight: CGFloat
    /// Height of the top-right action buttons.
    var actionHeight: CGFloat

    /// Where a rail-anchored popover's leading edge sits: past the rail plus one
    /// more inset (16 + 56 + 16 = 88 in the frames).
    var popoverAnchor: CGFloat { railInset * 2 + railWidth }

    static let regular = StudioMetrics(
        railWidth: 56, railButton: 44, railInset: 16,
        dockHeight: 0, dockInset: 0, edgeInset: 24,
        readoutHeight: 36, actionHeight: 36)

    static let phonePortrait = StudioMetrics(
        railWidth: 0, railButton: 44, railInset: 12,
        dockHeight: 64, dockInset: 12, edgeInset: 16,
        readoutHeight: 32, actionHeight: 32)

    static let phoneLandscape = StudioMetrics(
        railWidth: 48, railButton: 40, railInset: 12,
        dockHeight: 0, dockInset: 0, edgeInset: 16,
        readoutHeight: 26, actionHeight: 32)
}

// MARK: - Readout formatting
//
// One implementation, because the same symmetry shorthand appears in the top
// readout, on the rail's symmetry button, on every layers row and in the
// remove-stroke capsule — and four copies of "12 · D" is four chances for one of
// them to disagree with the document.
//
// These live here rather than in `Shared/Theme.swift` because they are
// engine-typed and `RandomWidget` compiles `Shared` WITHOUT KaleidoEngine: one
// engine-typed symbol in that folder breaks the widget build.

enum Readout {
    /// `12 · D` — segments, then D(ihedral)/C(yclic) for mirrored/rotational.
    static func sym(_ sym: Symmetry) -> String {
        "\(sym.segments) · \(sym.mirror ? "D" : "C")"
    }

    /// `12 · D · 70%` — a layers row's second line.
    static func layerLine(_ sym: Symmetry, opacity: Double) -> String {
        "\(self.sym(sym)) · \(percent(opacity))"
    }

    /// The spoken form, verbatim from DESIGN.md §3: "12 segments, mirrored".
    static func spokenSym(_ sym: Symmetry) -> String {
        "\(sym.segments) segments, \(sym.mirror ? "mirrored" : "rotational")"
    }

    /// The prose form under the dial: "6 segments · rotational".
    static func dialCaption(_ sym: Symmetry) -> String {
        "\(sym.segments) segments · \(sym.mirror ? "mirrored" : "rotational")"
    }

    static func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }

    /// `L2` — the active layer's position counting from the BOTTOM of the stack,
    /// which is how the layers panel numbers them.
    static func layerTag(index: Int) -> String { "L\(index + 1)" }

    /// The top-left capsule.
    ///
    /// `L2 · 12 · D · 6 PX · 100%` on regular width; the shorter forms drop the
    /// trailing fields rather than abbreviating them, so every field that IS
    /// shown means the same thing in every layout. While remove-stroke is armed
    /// the tail is replaced by `REMOVE STROKE`, which is the mode the user most
    /// needs to be reminded of.
    static func capsule(layerIndex: Int, sym: Symmetry, brushSize: Double,
                        zoom: CGFloat, removeMode: Bool, layout: StudioLayout) -> String {
        let head = "\(layerTag(index: layerIndex)) · \(self.sym(sym))"
        if removeMode { return "\(head) · REMOVE STROKE" }
        switch layout {
        case .rail:
            return "\(head) · \(Int(brushSize.rounded())) PX · \(percent(Double(zoom)))"
        case .dock:
            return head
        case .compactRail:
            return "\(self.sym(sym)) · \(Int(brushSize.rounded())) PX"
        }
    }

    /// The spoken version of the capsule — VoiceOver should hear words, not
    /// `L2 · 12 · D`.
    static func spokenCapsule(layerName: String, sym: Symmetry, brushSize: Double,
                              zoom: CGFloat, removeMode: Bool) -> String {
        var parts = ["Layer \(layerName)", spokenSym(sym),
                     "brush \(Int(brushSize.rounded())) points",
                     "zoom \(percent(Double(zoom)))"]
        if removeMode { parts.append("remove stroke armed") }
        return parts.joined(separator: ", ")
    }
}
