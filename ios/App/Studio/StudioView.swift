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
                sliderRow(title: "Size", value: $model.size, range: 2...60)
                sliderRow(title: "Opacity", value: $model.opacity, range: 0.1...1)
                segmentsRow
                togglesRow
                actionRow
            }
            .padding(16)
        }
        .background(.ultraThinMaterial)
    }

    private var colorRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                label("Color")
                Spacer()
                Toggle("Spectrum", isOn: $model.useSpectrum)
                    .toggleStyle(.button)
                    .font(.caption)
                    .tint(Blueprint.crane)
            }
            HStack(spacing: 10) {
                ForEach(palette, id: \.self) { hex in
                    Circle()
                        .fill(Color(hex: hex))
                        .frame(width: 30, height: 30)
                        .overlay(Circle().stroke(Blueprint.graphite.opacity(0.25), lineWidth: 1))
                        .overlay(selectionRing(for: hex))
                        .onTapGesture {
                            model.color = hex
                            model.useSpectrum = false
                        }
                }
                ColorPicker("", selection: $customColor, supportsOpacity: false)
                    .labelsHidden()
                    .onChange(of: customColor) { _, newValue in
                        model.color = newValue.hexRGB
                        model.useSpectrum = false
                    }
            }
            .opacity(model.useSpectrum ? 0.45 : 1)
        }
    }

    @ViewBuilder
    private func selectionRing(for hex: String) -> some View {
        if !model.useSpectrum && model.color.caseInsensitiveCompare(hex) == .orderedSame {
            Circle().stroke(Blueprint.crane, lineWidth: 3).padding(-3)
        }
    }

    private func sliderRow(title: String, value: Binding<Double>, range: ClosedRange<Double>) -> some View {
        HStack {
            label(title).frame(width: 70, alignment: .leading)
            Slider(value: value, in: range).tint(Blueprint.crease)
        }
    }

    private var segmentsRow: some View {
        HStack {
            label("Segments").frame(width: 70, alignment: .leading)
            Slider(
                value: Binding(get: { Double(model.segments) }, set: { model.segments = Int($0.rounded()) }),
                in: Double(MIN_SEGMENTS)...Double(MAX_SEGMENTS),
                step: 1
            )
            .tint(Blueprint.crease)
            Text("\(model.segments)")
                .font(.caption.monospacedDigit())
                .frame(width: 24)
                .foregroundStyle(Blueprint.graphite)
        }
    }

    private var togglesRow: some View {
        HStack(spacing: 12) {
            Toggle("Glow", isOn: Binding(
                get: { model.tool == .glow },
                set: { model.tool = $0 ? .glow : .solid }
            ))
            .toggleStyle(.button)
            .tint(Blueprint.sax)
            Toggle("Mirror", isOn: $model.mirror).toggleStyle(.button).tint(Blueprint.crease)
            Toggle("Guides", isOn: $model.showGuides).toggleStyle(.button).tint(Blueprint.crease)
            Toggle("Dark", isOn: Binding(
                get: { model.background == .dark },
                set: { model.background = $0 ? .dark : .light }
            ))
            .toggleStyle(.button)
            .tint(Blueprint.graphite)
            Spacer()
        }
        .font(.caption)
    }

    private var actionRow: some View {
        HStack(spacing: 14) {
            iconButton("arrow.uturn.backward", enabled: model.canUndo) { model.undo() }
            iconButton("arrow.uturn.forward", enabled: model.canRedo) { model.redo() }
            iconButton("trash", enabled: !model.isEmpty) { model.clear() }
            Spacer()
            Button {
                download()
            } label: {
                Label("PNG", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.bordered)
            .tint(Blueprint.crease)
            .disabled(model.isEmpty)

            Button {
                onSave()
            } label: {
                Label("Save", systemImage: "sparkles")
            }
            .buttonStyle(.borderedProminent)
            .tint(Blueprint.crane)
            .disabled(model.isEmpty)
        }
    }

    private func iconButton(_ system: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system).font(.title3)
        }
        .buttonStyle(.bordered)
        .tint(Blueprint.graphite)
        .disabled(!enabled)
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
