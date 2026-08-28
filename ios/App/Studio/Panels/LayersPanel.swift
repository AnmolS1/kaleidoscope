import SwiftUI
import KaleidoEngine

// The layers panel (DESIGN.md §3, frames IPadLayers / LayersStates / IPadDark).
//
// 264pt wide. Rows are listed top layer FIRST, which is the reverse of the
// document's bottom→top array — a stack is read from the top down, and getting
// this backwards silently inverts every drag.

struct LayersPanel: View {
    @ObservedObject var model: StudioModel
    /// Opens the symmetry popover scoped to a specific layer (tapping its sym line).
    var onEditSymmetry: (String) -> Void
    /// Fired when a nudge should be shown (e.g. a new layer inheriting symmetry).
    var onNudge: (StudioNudge) -> Void

    @State private var renaming: String?
    @State private var draftName = ""
    @FocusState private var nameFieldFocused: Bool

    /// Top layer first.
    private var rows: [LayerSummary] { model.layers.reversed() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            VStack(spacing: 2) {
                ForEach(rows) { row in
                    LayerRow(
                        layer: row,
                        isActive: row.id == model.activeLayerId,
                        isRenaming: renaming == row.id,
                        draftName: $draftName,
                        nameFieldFocused: $nameFieldFocused,
                        onSelect: { model.setActiveLayer(row.id) },
                        onToggleVisible: { model.setLayerVisible(row.id, !row.visible) },
                        onEditSymmetry: { onEditSymmetry(row.id) },
                        onBeginRename: { renaming = row.id; draftName = row.name; nameFieldFocused = true },
                        onCommitRename: {
                            model.setLayerName(row.id, draftName)
                            renaming = nil
                        },
                        onMove: { delta in move(row, by: delta) },
                        canMoveUp: model.layers.last?.id != row.id,
                        canMoveDown: model.layers.first?.id != row.id
                    )
                }
            }
            Hairline().padding(.vertical, 8)
            footer
            if let note = capNote {
                Text(note)
                    .font(Blueprint.mono(.caption2))
                    .textCase(nil)
                    .foregroundStyle(Blueprint.graphite.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)
            }
        }
        .padding(10)
        .frame(width: 264)
        .accessibilityIdentifier("layers-panel")
    }

    // MARK: Header / footer

    private var header: some View {
        HStack {
            Text("Layers").font(Blueprint.display(.subheadline))
            Spacer()
            Text("\(model.layers.count) of \(model.layerCap)")
                .font(Blueprint.mono(.caption2))
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Layers, \(model.layers.count) of \(model.layerCap)")
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Button {
                let before = model.activeLayer.sym
                if model.addLayer() != nil {
                    onNudge(.newLayerSymmetry(Readout.spokenSym(before)))
                }
            } label: {
                Chip(isEnabled: model.canAddLayer) {
                    Label("Add", systemImage: model.canAddLayer ? "plus" : "lock")
                }
            }
            .buttonStyle(.plain)
            .disabled(!model.canAddLayer)
            .accessibilityLabel(model.canAddLayer ? "Add layer" : "Add layer, locked at the layer limit")

            Button { model.duplicateLayer() } label: {
                Chip(isEnabled: model.canAddLayer) { Image(systemName: "plus.square.on.square") }
            }
            .buttonStyle(.plain)
            .disabled(!model.canAddLayer)
            .accessibilityLabel("Duplicate layer")

            Button { model.removeLayer() } label: {
                Chip(isEnabled: model.layers.count > 1) { Image(systemName: "trash") }
            }
            .buttonStyle(.plain)
            .disabled(model.layers.count <= 1)
            .accessibilityLabel("Delete layer")
        }
    }

    /// DESIGN.md §3: the cap is a state, not a punishment — the free string names
    /// the way out, and the Plus string just says the stack is full.
    private var capNote: String? {
        guard !model.canAddLayer else { return nil }
        if model.layerCap < MAX_LAYERS {
            return "Layers: \(model.layers.count) of \(model.layerCap) · Kaleidoscope Plus unlocks \(MAX_LAYERS)"
        }
        return "All \(MAX_LAYERS) layers in use"
    }

    /// Reorder by one place. A drag would be the frame's gesture, but a
    /// keyboard/VoiceOver user needs an equivalent, and one implementation that
    /// both the custom actions and the grip buttons call is one set of index
    /// arithmetic to get wrong instead of two.
    private func move(_ row: LayerSummary, by delta: Int) {
        guard let from = model.layers.firstIndex(where: { $0.id == row.id }) else { return }
        model.moveLayer(row.id, toIndex: from + delta)
    }
}

// MARK: - Row

private struct LayerRow: View {
    let layer: LayerSummary
    let isActive: Bool
    let isRenaming: Bool
    @Binding var draftName: String
    var nameFieldFocused: FocusState<Bool>.Binding
    let onSelect: () -> Void
    let onToggleVisible: () -> Void
    let onEditSymmetry: () -> Void
    let onBeginRename: () -> Void
    let onCommitRename: () -> Void
    let onMove: (Int) -> Void
    let canMoveUp: Bool
    let canMoveDown: Bool

    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "line.3.horizontal")
                .font(.caption)
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
                .accessibilityHidden(true)

            LayerThumbnail(layer: layer)

            VStack(alignment: .leading, spacing: 2) {
                if isRenaming {
                    TextField("Layer name", text: $draftName)
                        .font(.footnote.weight(.medium))
                        .textFieldStyle(.plain)
                        .focused(nameFieldFocused)
                        .submitLabel(.done)
                        .onSubmit(onCommitRename)
                } else {
                    Text(layer.name)
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Button(action: onEditSymmetry) {
                    Text(Readout.layerLine(layer.sym, opacity: layer.opacity))
                        .font(Blueprint.mono(.caption2))
                        .foregroundStyle(Blueprint.graphite.opacity(0.7))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Symmetry for \(layer.name)")
                .accessibilityValue(Readout.spokenSym(layer.sym))
                .accessibilityHint("Opens the symmetry dial for this layer")
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onToggleVisible) {
                Image(systemName: layer.visible ? "eye" : "eye.slash")
                    .foregroundStyle(Blueprint.graphite.opacity(0.72))
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(layer.visible ? "Hide \(layer.name)" : "Show \(layer.name)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            let shape = RoundedRectangle(cornerRadius: Blueprint.rSm, style: .continuous)
            if isActive {
                shape.fill(Blueprint.crane.opacity(0.10))
                    .overlay(shape.stroke(Blueprint.crane.opacity(0.35), lineWidth: 1))
            }
        }
        // A hidden layer reads at 55%. Under Differentiate Without Color the
        // eye-off glyph is already a non-colour signal, so nothing extra is
        // needed here — but the opacity must not be the ONLY signal, which is
        // why the glyph swaps rather than just dimming.
        .opacity(layer.visible ? 1 : 0.55)
        // Select/rename live on a background layer, NOT on the row itself. A
        // `.onTapGesture` on the row wins over the buttons nested inside it, so
        // the sym line and the eye silently stopped working — the symmetry
        // popover simply never opened. Beneath the content they compete for the
        // gaps instead of for the controls.
        .background(
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture(count: 2, perform: onBeginRename)
                .onTapGesture(perform: onSelect)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(rowLabel)
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
        .modifier(ReorderActions(canMoveUp: canMoveUp, canMoveDown: canMoveDown,
                                 onMove: onMove, onRename: onBeginRename))
    }

    private var rowLabel: String {
        var parts = ["Layer \(layer.name)", Readout.spokenSym(layer.sym),
                     "\(Readout.percent(layer.opacity)) opacity"]
        if !layer.visible { parts.append("hidden") }
        if isActive { parts.append("active") }
        return parts.joined(separator: ", ")
    }

}

/// A 34pt well showing that layer alone, in its own symmetry — the design's
/// per-layer thumbnail. Strokes are not scaled down into it; the renderer draws
/// the layer at the well's size, which is what makes a 24-fold layer read as
/// dense and a 3-fold one as sparse at a glance.
private struct LayerThumbnail: View {
    let layer: LayerSummary

    var body: some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(Blueprint.inset)
            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous)
                .stroke(Blueprint.creaseLine, lineWidth: 1))
            .overlay {
                // Spokes standing in for the layer's symmetry. Rendering the real
                // ink at 34pt costs a full offscreen composite per row per frame
                // and reads as a smudge at that size; the spoke count is the
                // information a user is actually reading off the thumbnail.
                Canvas { ctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let r = min(size.width, size.height) / 2 - 3
                    var path = Path()
                    for i in 0..<layer.sym.segments {
                        let a = Double(i) / Double(layer.sym.segments) * 2 * .pi - .pi / 2
                        path.move(to: c)
                        path.addLine(to: CGPoint(x: c.x + cos(a) * r, y: c.y + sin(a) * r))
                    }
                    ctx.stroke(path, with: .color(Blueprint.crane.opacity(
                        layer.strokeCount > 0 ? 0.55 : 0.18)), lineWidth: 1)
                }
                .padding(2)
            }
            .frame(width: 34, height: 34)
            .accessibilityHidden(true)
    }
}

/// Reordering is a drag in the frames; these are the same operations offered as
/// VoiceOver rotor actions, because a drag is not an interaction a screen-reader
/// user has. Guarded so the top layer is never offered "Move up".
private struct ReorderActions: ViewModifier {
    let canMoveUp: Bool
    let canMoveDown: Bool
    let onMove: (Int) -> Void
    let onRename: () -> Void

    func body(content: Content) -> some View {
        content
            .accessibilityAction(named: Text("Move up")) { if canMoveUp { onMove(1) } }
            .accessibilityAction(named: Text("Move down")) { if canMoveDown { onMove(-1) } }
            .accessibilityAction(named: Text("Rename"), onRename)
    }
}
