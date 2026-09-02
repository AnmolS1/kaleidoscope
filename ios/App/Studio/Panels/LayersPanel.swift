import SwiftUI
import KaleidoEngine

// The layers panel (DESIGN.md §3, frames IPadLayers / LayersStates / IPadDark).
//
// 264pt wide. Rows are listed top layer FIRST, which is the reverse of the
// document's bottom→top array — a stack is read from the top down, and getting
// this backwards silently inverts every drag.

struct LayersPanel: View {
    @ObservedObject var model: StudioModel
    @EnvironmentObject private var auth: AuthModel
    @EnvironmentObject private var router: AppRouter
    /// Opens the symmetry popover scoped to a specific layer (tapping its sym line).
    var onEditSymmetry: (String) -> Void
    /// Fired when a nudge should be shown (e.g. a new layer inheriting symmetry).
    var onNudge: (StudioNudge) -> Void

    @State private var renaming: String?
    @State private var draftName = ""
    /// Which row has its opacity slider disclosed, if any. One at a time: the
    /// slider is a second line inside the row, and eight open at once would push
    /// the footer and the cap footnote off the panel.
    @State private var opacityFor: String?
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
                        isOpacityOpen: opacityFor == row.id,
                        draftName: $draftName,
                        nameFieldFocused: $nameFieldFocused,
                        onSelect: { model.setActiveLayer(row.id) },
                        onToggleVisible: { model.setLayerVisible(row.id, !row.visible) },
                        onEditSymmetry: { onEditSymmetry(row.id) },
                        onToggleOpacity: {
                            if opacityFor == row.id {
                                // Closing seals the gesture. A VoiceOver
                                // adjustment ends no drag, so without this the
                                // coalesce key stays live and the NEXT change to
                                // this layer merges into the same undo entry —
                                // minutes later, invisibly.
                                model.endLayerOpacityGesture()
                                opacityFor = nil
                            } else {
                                opacityFor = row.id
                            }
                        },
                        onSetOpacity: { value, coalesce in
                            model.setLayerOpacity(row.id, value, coalesce: coalesce)
                        },
                        onEndOpacityGesture: { model.endLayerOpacityGesture() },
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
                Group {
                    switch note {
                    case .full:
                        Text("All \(MAX_LAYERS) layers in use")
                    case let .capped(count, cap, offersPlus):
                        if offersPlus {
                            // The mention is the TAP TARGET (REVIEW.md minor
                            // mI9). It read as a link on the web and as inert
                            // prose here, so the one place a user meets the
                            // layer cap named the way out and did not offer it.
                            (Text("Layers: \(count) of \(cap) · ")
                                + Text("Kaleidoscope Plus").foregroundColor(Blueprint.craneText)
                                + Text(" unlocks \(MAX_LAYERS)"))
                                .onTapGesture { router.openPlus() }
                                .accessibilityAddTraits(.isButton)
                                .accessibilityHint("Opens Kaleidoscope Plus")
                        } else {
                            Text("Layers: \(count) of \(cap)")
                        }
                    }
                }
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
    ///
    /// 🔴 GATED ON THE SURFACE, exactly as the web is (S14). The mention only
    /// becomes a BUTTON when `PlusSheet` would actually render — an ungated one
    /// is a control that visibly does nothing, which is precisely what a user at
    /// the cap would tap. That state is reachable: `/api/me` degrades to a plus
    /// block with the surface off, and the free layer cap still applies. With
    /// the surface off the user gets the count and no offer.
    private var capNote: LayerCapNote? {
        guard !model.canAddLayer else { return nil }
        guard model.layerCap < MAX_LAYERS else { return .full }
        return PlusSheetInput.surfaceVisible(auth.plus)
            ? .capped(count: model.layers.count, cap: model.layerCap, offersPlus: true)
            : .capped(count: model.layers.count, cap: model.layerCap, offersPlus: false)
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
    let isOpacityOpen: Bool
    @Binding var draftName: String
    var nameFieldFocused: FocusState<Bool>.Binding
    let onSelect: () -> Void
    let onToggleVisible: () -> Void
    let onEditSymmetry: () -> Void
    let onToggleOpacity: () -> Void
    /// `(value, coalesce)` — coalesce is true only while a DRAG is in flight.
    let onSetOpacity: (Double, Bool) -> Void
    let onEndOpacityGesture: () -> Void
    let onBeginRename: () -> Void
    let onCommitRename: () -> Void
    let onMove: (Int) -> Void
    let canMoveUp: Bool
    let canMoveDown: Bool

    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    /// True between the slider's editing-began and editing-ended. It is the only
    /// thing that turns coalescing on.
    @State private var draggingOpacity = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            firstLine
            // The slider is a second line INSIDE the row, not a popover: the
            // panel is 264pt wide with nothing beside a row, and keeping it
            // in the row keeps it inside the row's accessibility container,
            // next to the number it edits.
            if isOpacityOpen { opacitySlider }
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

    private var firstLine: some View {
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
                // `12 · D · 70%` is still one line, but it is now TWO controls
                // with the separator between them: the sym half opens the dial
                // (as it always did — its label and value are what
                // LayerCapUITests and the screenshot suite reach for), the
                // percentage half discloses the slider below.
                HStack(spacing: 4) {
                    Button(action: onEditSymmetry) {
                        Text(Readout.sym(layer.sym))
                            .font(Blueprint.mono(.caption2))
                            .foregroundStyle(Blueprint.graphite.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Symmetry for \(layer.name)")
                    .accessibilityValue(Readout.spokenSym(layer.sym))
                    .accessibilityHint("Opens the symmetry dial for this layer")

                    Text("·")
                        .font(Blueprint.mono(.caption2))
                        .foregroundStyle(Blueprint.graphite.opacity(0.7))
                        .accessibilityHidden(true)

                    Button(action: onToggleOpacity) {
                        Text(Readout.percent(layer.opacity))
                            .font(Blueprint.mono(.caption2))
                            .foregroundStyle(Blueprint.graphite.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Opacity for \(layer.name)")
                    .accessibilityValue(Readout.percent(layer.opacity))
                    .accessibilityHint(isOpacityOpen
                                       ? "Hides this layer's opacity slider"
                                       : "Shows this layer's opacity slider")
                }
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
    }

    /// The disclosed opacity slider.
    ///
    /// **`coalesce` is the point.** A drag emits a continuous stream of values;
    /// committing each one is how a single gesture becomes forty undo entries.
    /// So every value set DURING a drag is coalesced into one entry, and the
    /// gesture is sealed when the drag ends. `draggingOpacity` is what separates
    /// a drag from a VoiceOver adjustment, which begins and ends no drag and
    /// must therefore be its own step rather than merging into the last one.
    private var opacitySlider: some View {
        HStack(spacing: 8) {
            Slider(
                value: Binding(
                    get: { layer.opacity },
                    // 0...1 IS THE ENGINE'S SCALE. It clamps, so a whole percent
                    // handed over raw would pin every layer at 1 and read as a
                    // slider that does nothing.
                    set: { onSetOpacity($0, draggingOpacity) }
                ),
                in: 0...1,
                onEditingChanged: { editing in
                    draggingOpacity = editing
                    if !editing { onEndOpacityGesture() }
                }
            )
            .tint(Blueprint.crane)
            // DESIGN.md §2's 44pt, spent on the TARGET: a Slider's own intrinsic
            // height is under it, and a control that only misses the rule inside
            // a panel is still a control that misses it.
            .frame(minHeight: 44)
            .accessibilityLabel("Opacity for \(layer.name)")
            .accessibilityValue(Readout.percent(layer.opacity))

            Text(Readout.percent(layer.opacity))
                .font(Blueprint.mono(.caption2))
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
                .frame(width: 40, alignment: .trailing)
                .accessibilityHidden(true)
        }
        .padding(.top, 2)
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

/// What the layers panel's cap footnote says.
///
/// A type rather than a String so the "and here is the way out" half can be a
/// control, and so the surface gate is a value the panel carries rather than a
/// condition re-derived at the point of rendering.
enum LayerCapNote: Equatable {
    case full
    case capped(count: Int, cap: Int, offersPlus: Bool)
}
