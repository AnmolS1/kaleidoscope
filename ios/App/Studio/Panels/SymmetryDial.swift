import SwiftUI
import KaleidoEngine

// The protractor symmetry dial (DESIGN.md §3) and the popover it lives in.
//
// Geometry is the design's, exactly: a 220pt square, ring radius 80, ticks for
// 3…24 over a 300° sweep starting at −240° so the gap sits at the bottom with 3
// bottom-left and 24 bottom-right. Major ticks (and labels) every 3, labels at
// ring + 17. Ticks at or below the current value are crease; the rest are bold
// hairline. A 30pt centre disc carries the mirror toggle. The handle is an 18pt
// inset-filled circle with a 2pt crane ring.

/// The dial's shared maths. Pulled out of the view so the handle, the ticks and
/// the drag all read the same mapping — three separate `atan2` conversions is how
/// a handle ends up one step off the tick it is sitting on.
enum DialGeometry {
    static let sweep: Double = 300
    static let start: Double = -240
    static let size: CGFloat = 220
    static var ringRadius: CGFloat { size / 2 - 30 }
    static let centerRadius: CGFloat = 30
    static let labelOffset: CGFloat = 17

    /// Segment count → angle in radians, in the SVG convention the design uses
    /// (0° at 3 o'clock, y down).
    static func angle(for segments: Int) -> Double {
        let t = Double(segments - MIN_SEGMENTS) / Double(MAX_SEGMENTS - MIN_SEGMENTS)
        return (t * sweep + start) * .pi / 180
    }

    static func point(for segments: Int, radius: CGFloat) -> CGPoint {
        let a = angle(for: segments)
        return CGPoint(x: cos(a) * radius, y: sin(a) * radius)
    }

    /// The inverse: a touch offset from the centre → the segment count it means.
    ///
    /// The sweep leaves a 60° dead zone at the bottom. A touch inside it is
    /// clamped to whichever end is nearer rather than ignored, so dragging past
    /// 24 parks on 24 instead of snapping back through the gap to 3.
    static func segments(atOffset offset: CGSize) -> Int {
        var deg = atan2(Double(offset.height), Double(offset.width)) * 180 / .pi
        // Rebase onto the sweep's own 0…360 frame starting at `start`.
        var t = deg - start
        while t < 0 { t += 360 }
        while t >= 360 { t -= 360 }
        if t > sweep {
            // In the gap: 330° is the midpoint between the two ends.
            t = t > (sweep + 360) / 2 ? 0 : sweep
        }
        deg = t
        let raw = deg / sweep * Double(MAX_SEGMENTS - MIN_SEGMENTS) + Double(MIN_SEGMENTS)
        return clampSegments(Int(raw.rounded()))
    }
}

/// The dial itself. Owns no state: it reports a segment count and a mirror
/// toggle, and the caller decides which layer they apply to.
struct SymmetryDial: View {
    let sym: Symmetry
    /// `(value, coalesce)`. A ring DRAG passes `true` so the whole sweep is one
    /// undo entry; a VoiceOver adjustment passes `false` so each swipe stays its
    /// own step — a rotor user stepping 3 → 8 expects eight undos back, not one.
    let onSegments: (Int, Bool) -> Void
    /// Called when a drag ends, to seal the coalesced entry.
    let onEndGesture: () -> Void
    let onToggleMirror: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @State private var dragging = false

    private let feedback = UISelectionFeedbackGenerator()

    var body: some View {
        ZStack {
            ring
            guides
            ticks
            centerDisc
            handle
        }
        .frame(width: DialGeometry.size, height: DialGeometry.size)
        .contentShape(Circle())
        .gesture(dragGesture)
        // One adjustable element for the whole dial. The mirror toggle inside it
        // stays its own button, so VoiceOver gets "swipe to change segments" and
        // a separate "Mirror symmetry" control rather than one opaque blob.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Symmetry segments")
        .accessibilityValue(Readout.spokenSym(sym))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: onSegments(clampSegments(sym.segments + 1), false)
            case .decrement: onSegments(clampSegments(sym.segments - 1), false)
            @unknown default: break
            }
        }
    }

    // MARK: Parts

    private var ring: some View {
        Circle()
            .stroke(Blueprint.creaseLine, lineWidth: 1)
            .frame(width: DialGeometry.ringRadius * 2, height: DialGeometry.ringRadius * 2)
    }

    /// The live preview: one faint spoke per segment, inside the ring.
    private var guides: some View {
        Canvas { ctx, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let r = DialGeometry.ringRadius - 34
            var path = Path()
            for i in 0..<sym.segments {
                let a = Double(i) / Double(sym.segments) * 2 * .pi - .pi / 2
                path.move(to: c)
                path.addLine(to: CGPoint(x: c.x + cos(a) * r, y: c.y + sin(a) * r))
            }
            ctx.stroke(path, with: .color(Blueprint.creaseLineBold), lineWidth: 1)
        }
        .allowsHitTesting(false)
        // Reduced motion: the preview snaps rather than sweeping.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: sym.segments)
    }

    private var ticks: some View {
        Canvas { ctx, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let ring = DialGeometry.ringRadius
            for n in MIN_SEGMENTS...MAX_SEGMENTS {
                let major = n % 3 == 0
                let a = DialGeometry.angle(for: n)
                let inner = ring - (major ? 10 : 6)
                var path = Path()
                path.move(to: CGPoint(x: c.x + cos(a) * inner, y: c.y + sin(a) * inner))
                path.addLine(to: CGPoint(x: c.x + cos(a) * ring, y: c.y + sin(a) * ring))
                ctx.stroke(path,
                           with: .color(n <= sym.segments ? Blueprint.crease : Blueprint.creaseLineBold),
                           lineWidth: major ? 1.5 : 1)
                if major {
                    let lr = ring + DialGeometry.labelOffset
                    let p = CGPoint(x: c.x + cos(a) * lr, y: c.y + sin(a) * lr)
                    var text = ctx.resolve(Text("\(n)")
                        .font(Blueprint.mono(.caption2))
                        .foregroundStyle(Blueprint.graphite.opacity(0.7)))
                    text.shading = .color(Blueprint.graphite.opacity(0.7))
                    ctx.draw(text, at: p, anchor: .center)
                }
            }
        }
        .allowsHitTesting(false)
    }

    /// The centre disc is the mirror toggle. Its glyph changes shape as well as
    /// colour, so the state survives Differentiate Without Color.
    private var centerDisc: some View {
        Button(action: onToggleMirror) {
            ZStack {
                Circle().fill(Blueprint.inset)
                    .overlay(Circle().stroke(Blueprint.creaseLineBold, lineWidth: 1))
                Image(systemName: sym.mirror ? "arrow.left.and.right.righttriangle.left.righttriangle.right"
                                             : "arrow.triangle.2.circlepath")
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(sym.mirror ? Blueprint.craneStrong
                                                : Blueprint.graphite.opacity(0.4))
            }
            .frame(width: DialGeometry.centerRadius * 2, height: DialGeometry.centerRadius * 2)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Mirror symmetry")
        .accessibilityValue(sym.mirror ? "On" : "Off")
        .accessibilityHint(sym.mirror ? "On: reflected wedges" : "Off: rotation only")
        .accessibilityAddTraits(sym.mirror ? [.isButton, .isSelected] : .isButton)
    }

    private var handle: some View {
        let p = DialGeometry.point(for: sym.segments, radius: DialGeometry.ringRadius)
        return Circle()
            .fill(Blueprint.inset)
            .overlay(Circle().stroke(Blueprint.crane, lineWidth: 2))
            .frame(width: 18, height: 18)
            .offset(x: p.x, y: p.y)
            .allowsHitTesting(false)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: sym.segments)
    }

    // MARK: Drag

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let center = CGPoint(x: DialGeometry.size / 2, y: DialGeometry.size / 2)
                let offset = CGSize(width: value.location.x - center.x,
                                    height: value.location.y - center.y)
                // Ignore touches on the centre disc — that is the mirror button.
                guard hypot(offset.width, offset.height) > DialGeometry.centerRadius else { return }
                let next = DialGeometry.segments(atOffset: offset)
                guard next != sym.segments else { return }
                if !dragging { feedback.prepare(); dragging = true }
                feedback.selectionChanged() // a tick per step
                onSegments(next, true)
            }
            .onEnded { _ in
                // Seal even if the drag never moved far enough to change the
                // count: `dragging` guards the haptics, not the undo stack, and
                // an unsealed key would let the NEXT change merge into a
                // gesture the user has already finished.
                dragging = false
                onEndGesture()
            }
    }
}

// MARK: - Popover

/// The symmetry popover (DESIGN.md §3). The chip in the title row ALWAYS names
/// the layer being edited, because symmetry is per-layer and a dial with no
/// scope is a dial you cannot trust.
struct SymmetryPopover: View {
    @ObservedObject var model: StudioModel
    /// The layer this popover edits — the active one, or a specific one when the
    /// user opened it from a layers row.
    let layerId: String
    var onClose: () -> Void

    private var layer: LayerSummary? {
        model.layers.first { $0.id == layerId }
    }

    var body: some View {
        let sym = layer?.sym ?? model.symmetry
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Symmetry").font(Blueprint.display(.subheadline))
                Spacer()
                Chip { Text(layer?.name ?? "").lineLimit(1) }
                    .accessibilityLabel("Editing layer \(layer?.name ?? "")")
            }
            SymmetryDial(sym: sym) { segments, coalesce in
                model.setLayerSym(layerId, Symmetry(segments: segments, mirror: sym.mirror),
                                  coalesce: coalesce)
            } onEndGesture: {
                model.endSymGesture()
            } onToggleMirror: {
                model.setLayerSym(layerId, Symmetry(segments: sym.segments, mirror: !sym.mirror))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)

            Text(Readout.dialCaption(sym))
                .font(Blueprint.mono(.caption))
                .foregroundStyle(Blueprint.graphite.opacity(0.72))
                .accessibilityHidden(true) // the dial already announces this

            Hairline().padding(.vertical, 10)

            Button {
                model.setAllSym(sym)
                onClose()
            } label: {
                Chip { Text("Apply to all layers").frame(maxWidth: .infinity) }
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Apply to all layers")
            .accessibilityHint("Gives every layer \(Readout.spokenSym(sym))")
        }
        .padding(12)
        .frame(width: 260)
    }
}
