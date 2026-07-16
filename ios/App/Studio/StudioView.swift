import SwiftUI
import KaleidoEngine

/// The drawing studio — canvas + controls. Draw + download are free (no account);
/// Save (wired in the save-flow phase) is provided via `onSave`.
struct StudioView: View {
    @ObservedObject var model: StudioModel
    /// Invoked by the Save button. Defaults to a "coming soon" notice so the
    /// button exists in the studio before the save flow is wired.
    var onSave: () -> Void = {}

    @State private var shareItem: ShareItem?
    @State private var showColorPicker = false
    @State private var customColor = Color(hex: "#E84A27")

    // Accessibility system settings.
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Swatch diameter, scaled with Dynamic Type so the palette grows with text.
    @ScaledMetric(relativeTo: .body) private var swatchSize: CGFloat = 30

    private let palette = ["#E84A27", "#2E5E8C", "#D9A521", "#1B2A33", "#3FA34D", "#8E44AD", "#EAEAEA"]

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                canvas
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                controls
                    .frame(height: min(340, geo.size.height * 0.42))
            }
        }
        .background(Blueprint.graph.ignoresSafeArea())
        .sheet(item: $shareItem) { item in ShareSheet(items: [item.url]) }
    }

    // MARK: Canvas

    private var canvas: some View {
        DrawingCanvas(model: model)
            .aspectRatio(1, contentMode: .fit)
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Controls

    private var controls: some View {
        ScrollView {
            VStack(spacing: 16) {
                colorRow
                sliderRow(title: "Size", accessibilityLabel: "Brush size",
                          value: $model.size, range: 2...60) { "\(Int($0.rounded())) points" }
                sliderRow(title: "Opacity", accessibilityLabel: "Opacity",
                          value: $model.opacity, range: 0.1...1) { "\(Int(($0 * 100).rounded())) percent" }
                segmentsRow
                togglesRow
                actionRow
            }
            .padding(16)
        }
        // Reduce Transparency: swap the blur for a solid graph-card surface so
        // the controls stay legible without translucency.
        .background(controlsBackground)
    }

    @ViewBuilder
    private var controlsBackground: some View {
        if reduceTransparency {
            Blueprint.card
        } else {
            Color.clear.background(.ultraThinMaterial)
        }
    }

    private var colorRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Default: label + toggle on one line. At accessibility Dynamic Type
            // sizes the toggle would clip off the right edge, so stack them.
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    label("Color")
                    spectrumToggle
                }
            } else {
                HStack {
                    label("Color")
                    Spacer()
                    spectrumToggle
                }
            }
            // Horizontal scroll so the 44pt-hit-target swatches + ColorPicker
            // never clip — at default width or at large Dynamic Type sizes.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(palette, id: \.self) { hex in swatch(hex) }
                    ColorPicker("", selection: $customColor, supportsOpacity: false)
                        .labelsHidden()
                        .onChange(of: customColor) { _, newValue in
                            model.color = newValue.hexRGB
                            model.useSpectrum = false
                        }
                        .accessibilityLabel("Custom color picker")
                }
                .padding(.vertical, 2)
                .opacity(model.useSpectrum ? 0.45 : 1)
            }
        }
    }

    private var spectrumToggle: some View {
        Toggle("Spectrum", isOn: $model.useSpectrum)
            .toggleStyle(ContrastToggleStyle(onFill: Blueprint.craneButton, onLabel: .white))
            .font(.caption)
            .accessibilityLabel("Rainbow spectrum brush")
            .accessibilityHint("Cycles through colors as you draw")
    }

    private func swatch(_ hex: String) -> some View {
        let isSelected = !model.useSpectrum && model.color.caseInsensitiveCompare(hex) == .orderedSame
        return Circle()
            .fill(Color(hex: hex))
            .frame(width: swatchSize, height: swatchSize)
            .overlay(Circle().stroke(Blueprint.graphite.opacity(0.25), lineWidth: 1))
            .overlay(selectionRing(isSelected: isSelected))
            // Keep the 30pt visual but give at least a 44pt tappable/focusable area.
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Circle())
            .onTapGesture {
                model.color = hex
                model.useSpectrum = false
            }
            .accessibilityElement()
            .accessibilityLabel(Blueprint.colorName(forHex: hex))
            .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
            .accessibilityHint("Sets the brush color")
    }

    @ViewBuilder
    private func selectionRing(isSelected: Bool) -> some View {
        if isSelected {
            ZStack {
                Circle().stroke(Blueprint.crane, lineWidth: 3).padding(-3)
                // Differentiate Without Color: a checkmark so selection reads
                // without relying on the crane-colored glow.
                if differentiateWithoutColor {
                    Image(systemName: "checkmark")
                        .font(.system(size: swatchSize * 0.45, weight: .bold))
                        .foregroundStyle(.white)
                        .shadow(radius: 1)
                }
            }
        }
    }

    private func sliderRow(title: String, accessibilityLabel: String, value: Binding<Double>,
                           range: ClosedRange<Double>, spoken: @escaping (Double) -> String) -> some View {
        HStack {
            label(title).frame(width: 70, alignment: .leading).accessibilityHidden(true)
            Slider(value: value, in: range)
                .tint(Blueprint.crease)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityValue(spoken(value.wrappedValue))
        }
    }

    private var segmentsRow: some View {
        HStack {
            label("Segments").frame(width: 70, alignment: .leading).accessibilityHidden(true)
            Slider(
                value: Binding(get: { Double(model.segments) }, set: { model.segments = Int($0.rounded()) }),
                in: Double(MIN_SEGMENTS)...Double(MAX_SEGMENTS),
                step: 1
            )
            .tint(Blueprint.crease)
            .accessibilityLabel("Symmetry segments")
            .accessibilityValue("\(model.segments)")
            Text("\(model.segments)")
                .font(.caption.monospacedDigit())
                .frame(width: 24)
                .foregroundStyle(Blueprint.graphite)
                .accessibilityHidden(true)
        }
    }

    private var togglesRow: some View {
        HStack(spacing: 12) {
            Toggle("Glow", isOn: Binding(
                get: { model.tool == .glow },
                set: { model.tool = $0 ? .glow : .solid }
            ))
            .toggleStyle(ContrastToggleStyle(onFill: Blueprint.sax, onLabel: Blueprint.onSax))
            .accessibilityLabel("Glow brush")
            .accessibilityHint("Draws with a soft luminous halo")

            // Mirror on = dihedral (reflection); off = rotation only. Under
            // Differentiate Without Color, an icon conveys the mode by shape,
            // not just the selected tint.
            Toggle(isOn: $model.mirror) {
                if differentiateWithoutColor {
                    Label("Mirror", systemImage: model.mirror ? "circle.lefthalf.filled" : "arrow.triangle.2.circlepath")
                } else {
                    Text("Mirror")
                }
            }
            .toggleStyle(ContrastToggleStyle(onFill: Blueprint.creaseButton, onLabel: .white))
            .accessibilityLabel("Mirror symmetry")
            .accessibilityHint(model.mirror ? "On: reflected wedges" : "Off: rotation only")

            Toggle("Guides", isOn: $model.showGuides)
                .toggleStyle(ContrastToggleStyle(onFill: Blueprint.creaseButton, onLabel: .white))
                .accessibilityLabel("Symmetry guides")
                .accessibilityHint("Shows faint wedge guide lines")
            Toggle("Dark", isOn: Binding(
                get: { model.background == .dark },
                set: { model.background = $0 ? .dark : .light }
            ))
            // Fill = graphite ink, label = graph paper: both flip with the theme
            // together, so the label stays ~13:1 in light and dark.
            .toggleStyle(ContrastToggleStyle(onFill: Blueprint.graphite, onLabel: Blueprint.graph))
            .accessibilityLabel("Dark canvas")
            .accessibilityHint("Switches the canvas background between light and dark")
            Spacer()
        }
        .font(.caption)
    }

    private var actionRow: some View {
        HStack(spacing: 14) {
            iconButton("arrow.uturn.backward", label: "Undo", enabled: model.canUndo) { model.undo() }
            iconButton("arrow.uturn.forward", label: "Redo", enabled: model.canRedo) { model.redo() }
            iconButton("trash", label: "Clear canvas", enabled: !model.isEmpty) { model.clear() }
            Spacer()
            Button {
                download()
            } label: {
                Label("PNG", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.bordered)
            .tint(Blueprint.crease)
            .disabled(model.isEmpty)
            .accessibilityLabel("Download PNG")
            .accessibilityHint("Exports the drawing as an image to share or save")

            Button {
                onSave()
            } label: {
                Label("Save", systemImage: "sparkles")
                    .foregroundStyle(.white) // pin white so the label isn't system-picked
            }
            .buttonStyle(.borderedProminent)
            .tint(Blueprint.craneButton)
            .disabled(model.isEmpty)
            .accessibilityHint("Saves the piece to the gallery")
        }
    }

    private func iconButton(_ system: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system).font(.title3)
        }
        .buttonStyle(.bordered)
        .tint(Blueprint.graphite)
        .disabled(!enabled)
        .accessibilityLabel(label)
    }

    private func label(_ text: String) -> some View {
        Text(text).font(.subheadline.weight(.medium)).foregroundStyle(Blueprint.graphite)
    }

    // MARK: Download

    private func download() {
        let drawing = model.currentDrawing()
        guard let png = StudioExport.renderSquare(drawing, size: StudioExport.imageSize).pngData() else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("kaleidoscope.png")
        do {
            try png.write(to: url)
            shareItem = ShareItem(url: url)
        } catch {
            // Non-fatal: sharing simply won't open.
        }
    }
}

private struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

/// UIActivityViewController bridge for sharing/saving the exported PNG.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// A button-style toggle whose **selected** state uses an explicit, WCAG-tuned
/// fill + a pinned label color, so the label clears 4.5:1 against the fill in
/// both themes. `.toggleStyle(.button)` instead fills the selected state with the
/// raw tint and lets the *system* pick the label color, which is not statically
/// verifiable and drops below 4.5:1 on light tints (white on gold `sax` ~1.6:1;
/// white on `graphite` in dark mode). The **off** state renders the label in
/// neutral `graphite` on a faint fill — also deterministic, and it fixes the old
/// tinted-off labels (gold `sax` off-label was 1.96:1). See
/// ios/ACCESSIBILITY_CONTRAST.md.
struct ContrastToggleStyle: ToggleStyle {
    /// Fill behind the label when selected (a dark-enough `*Button` token, or a
    /// gold/graphite fill paired with a dark/flipping `onLabel`).
    var onFill: Color
    /// Label color when selected — pinned so it is never system-chosen.
    var onLabel: Color

    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            configuration.label
                .foregroundStyle(configuration.isOn ? onLabel : Blueprint.graphite)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background {
                    let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
                    if configuration.isOn {
                        shape.fill(onFill)
                    } else {
                        // Faint neutral fill echoes the unselected bordered look.
                        shape.fill(Blueprint.graphite.opacity(0.10))
                    }
                }
                .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        // Preserve the "selected" trait the system button-toggle exposes when on.
        .accessibilityAddTraits(configuration.isOn ? .isSelected : [])
    }
}
