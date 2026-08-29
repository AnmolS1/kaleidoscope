import SwiftUI
import KaleidoEngine

// The Brush popover (DESIGN.md §3, frame IPadBrush).
//
// Tool trio · PRESSURE AFFECTS chips · pressure preset segmented control with a
// live preview · Draw with finger · Smooth strokes. Size and Opacity live here
// too: the edge sliders are the fast path on a big screen, but they are the ONLY
// path nowhere — at accessibility Dynamic Type sizes the sliders are suppressed
// (their 10pt labels and 22pt thumbs cannot grow), so these rows have to be able
// to carry the setting on their own.
//
// The pressure block is hidden until a pen has been seen. Both settings it
// governs are pen-only: `pressurePreset` shapes a pen's force curve and `po` is
// refused for finger touches in `KaleidoCanvasView.touchesBegan`. Showing a
// control that provably cannot affect a finger-only user's drawing is worse than
// showing nothing.

struct BrushPopover: View {
    @ObservedObject var model: StudioModel
    /// True once a Pencil has touched the canvas — the gate on the pressure block.
    let pencilSeen: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            toolTrio
            Hairline()
            sizeAndOpacity
            if pencilSeen {
                Hairline()
                pressureAffects
                pressurePreset
            }
            Hairline()
            toggles
        }
        .padding(14)
        .frame(width: 280)
        .accessibilityIdentifier("brush-popover")
    }

    private var header: some View {
        HStack {
            Text("Brush").font(Blueprint.display(.subheadline))
            Spacer()
            Text(pencilSeen ? "APPLE PENCIL" : "TOUCH")
                .font(Blueprint.mono(.caption2))
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(pencilSeen ? "Brush settings, Apple Pencil detected" : "Brush settings")
    }

    private var toolTrio: some View {
        HStack(spacing: 4) {
            IconButton(systemImage: "paintbrush.pointed", label: "Solid brush",
                       isActive: model.tool == .solid && !model.removeStrokeMode, size: 40) {
                model.tool = .solid
                model.removeStrokeMode = false
            }
            IconButton(systemImage: "sparkle", label: "Glow brush",
                       hint: "Draws with a soft luminous halo",
                       isActive: model.tool == .glow && !model.removeStrokeMode, size: 40) {
                model.tool = .glow
                model.removeStrokeMode = false
            }
            IconButton(systemImage: "scissors", label: "Remove stroke",
                       hint: "Tap a stroke to highlight it, tap again to delete",
                       isActive: model.removeStrokeMode, size: 40) {
                model.removeStrokeMode.toggle()
                model.pendingHit = nil
            }
        }
    }

    private var sizeAndOpacity: some View {
        VStack(alignment: .leading, spacing: 8) {
            labelledSlider("Size", accessibilityLabel: "Brush size",
                           value: $model.size, range: 2...60) {
                "\(Int($0.rounded())) points"
            } readout: {
                "\(Int(model.size.rounded())) PX"
            }
            labelledSlider("Opacity", accessibilityLabel: "Opacity",
                           value: $model.opacity, range: 0.1...1) {
                "\(Int(($0 * 100).rounded())) percent"
            } readout: {
                Readout.percent(model.opacity)
            }
        }
    }

    private func labelledSlider(_ title: String, accessibilityLabel: String,
                                value: Binding<Double>, range: ClosedRange<Double>,
                                spoken: @escaping (Double) -> String,
                                readout: () -> String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title.uppercased())
                    .font(Blueprint.mono(.caption2))
                    .foregroundStyle(Blueprint.graphite.opacity(0.7))
                Spacer()
                Text(readout())
                    .font(Blueprint.mono(.caption2))
                    .foregroundStyle(Blueprint.graphite.opacity(0.72))
            }
            .accessibilityHidden(true)
            Slider(value: value, in: range)
                .tint(Blueprint.crease)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityValue(spoken(value.wrappedValue))
        }
    }

    private var pressureAffects: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PRESSURE AFFECTS")
                .font(Blueprint.mono(.caption2))
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
                .accessibilityHidden(true)
            HStack(spacing: 6) {
                // Width is always pressure-driven for a pen; the chip states that
                // rather than offering a switch that does nothing.
                Chip(isActive: true) { Label("Size", systemImage: "checkmark") }
                    .accessibilityElement()
                    .accessibilityLabel("Pressure affects size")
                    .accessibilityValue("Always on")
                Button { model.pressureOpacity.toggle() } label: {
                    Chip(isActive: model.pressureOpacity) { Text("Opacity") }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Pressure affects opacity")
                .accessibilityValue(model.pressureOpacity ? "On" : "Off")
                .accessibilityAddTraits(model.pressureOpacity ? [.isButton, .isSelected] : .isButton)
            }
        }
    }

    private var pressurePreset: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PRESSURE · APPLIES TO NEW STROKES")
                .font(Blueprint.mono(.caption2))
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true)
            Picker("Pressure", selection: $model.pressurePreset) {
                Text("Light").tag(PressurePreset.light)
                Text("Normal").tag(PressurePreset.normal)
                Text("Firm").tag(PressurePreset.firm)
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Pressure response")
            .accessibilityHint("Applies to new strokes")
            PressurePreview(preset: model.pressurePreset, color: model.effectiveColor)
        }
    }

    private var toggles: some View {
        VStack(alignment: .leading, spacing: 10) {
            toggleRow("Draw with finger",
                      hint: model.drawWithFinger ? nil : "off · fingers pan",
                      isOn: $model.drawWithFinger,
                      accessibilityHint: "When off, fingers pan and zoom and only Apple Pencil draws")
            toggleRow("Smooth strokes", hint: nil, isOn: $model.smoothStrokes,
                      accessibilityHint: "Applies to new strokes; existing strokes are never changed")
        }
    }

    private func toggleRow(_ title: String, hint: String?, isOn: Binding<Bool>,
                           accessibilityHint: String) -> some View {
        Toggle(isOn: isOn) {
            HStack(spacing: 8) {
                Text(title).font(.footnote)
                if let hint {
                    Text(hint)
                        .font(Blueprint.mono(.caption2))
                        .foregroundStyle(Blueprint.graphite.opacity(0.7))
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .tint(Blueprint.creaseButton)
        .accessibilityLabel(title)
        .accessibilityHint(accessibilityHint)
    }
}

/// The live scribble under the preset control: one stroke drawn through the
/// preset's own pressure curve, so "Firm" is something a user can see rather than
/// guess. It runs the engine's real capture chain — `applyPressureGamma` then
/// `widthFactor` — not a lookalike, because a preview that disagrees with the
/// brush is worse than no preview.
private struct PressurePreview: View {
    let preset: PressurePreset
    let color: String

    var body: some View {
        Canvas { ctx, size in
            let baseline = size.height / 2
            let steps = 48
            for i in 0..<steps {
                let t0 = Double(i) / Double(steps)
                let t1 = Double(i + 1) / Double(steps)
                // A gentle rise and fall, the shape of a real pen stroke.
                let p = 0.15 + 0.85 * sin(t0 * .pi)
                let w = 6 * widthFactor(applyPressureGamma(p, preset: preset))
                var path = Path()
                path.move(to: CGPoint(x: size.width * t0, y: baseline + sin(t0 * 6) * 3))
                path.addLine(to: CGPoint(x: size.width * t1, y: baseline + sin(t1 * 6) * 3))
                ctx.stroke(path, with: .color(strokeColor),
                           style: StrokeStyle(lineWidth: w, lineCap: .round))
            }
        }
        .frame(height: 24)
        .accessibilityHidden(true)
    }

    private var strokeColor: Color {
        color == "spectrum" ? Blueprint.crane : Color(hex: color)
    }
}
